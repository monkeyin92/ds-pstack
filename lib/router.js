/**
 * ds-pstack — give every delegated child the model its work needs, out of the
 * models the user checked for subagents.
 *
 * pstack assigns each unit of work a role and a model slug. DeepSeek Harness has
 * no fixed roster to name: the user checks a set of exact provider/model routes
 * in Settings (Subagent model selection), and that set is the pool this router
 * must choose from. Saying nothing would run every child on the route it
 * inherited, which is the behaviour pstack exists to improve on.
 *
 * Two plugin-level decisions keep the guess safe:
 *
 * 1. A delegating agent that names `provider`/`model`/`reasoning_effort` wins.
 *    An explicit request is a decision the router has no evidence to override.
 *    This covers both a model-aware parent and any skill that pins one route.
 * 2. The chosen route comes only from the checked pool, and the effort only
 *    from the efforts that route's adapter advertises. A route outside the pool
 *    is never sent, so the router cannot widen the user's authorization.
 *
 * The decision is cached per child session: one subagent, one route, for every
 * request it makes.
 *
 * @module @local/ds-pstack/router
 */

import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  BUDGET_BASE,
  chooseEffort,
  isBudgetLabel,
  classifyTask,
  effortFloor,
  intentForRole,
  INTENT_IDS,
  scoreModel,
} from './classify.js'

/** Plugin version, recorded in the decision journal when the plugin activates. */
const VERSION = '0.1.0'

/** Configuration defaults; the Loader row overrides individual keys. */
const DEFAULTS = Object.freeze({
  /** Route every delegated child. `off` leaves routing as a pure observation. */
  enabled: true,
  /**
   * Which agents to route. `children` covers delegated subagents and teammates;
   * `all` also covers the top-level session, which pstack never does because the
   * user picked that model themselves.
   */
  scope: 'children',
  /** pstack budget label: `unlimited`, `large`, `medium`, or `small`. */
  budget: 'large',
  /** Role pins written by `/setup-pstack`. Empty uses classification alone. */
  rolesPath: '~/.dsh/ds-pstack-roles.json',
  /** Decision journal. Set to an empty string to disable. */
  logPath: '~/.dsh/ds-pstack-router.jsonl',
  /** Record the first 300 characters of each child's task in the journal. */
  logTasks: true,
  /** How long the resolved catalogue is reused before it is rebuilt. */
  catalogTtlMs: 300_000,
  /** Skip a route that failed at request time for this long. */
  quarantineMs: 600_000,
  /** Retries onto the next candidate after a routed request failed, per step. */
  maxRouteRetries: 2,
  /** Fall back to the parent's route when nothing in the pool is usable. */
  fallbackToParent: true,
  /**
   * Route a forked child. Off by default: a fork exists to reuse the inherited
   * conversation prefix, and a different route throws that reuse away. Turn it
   * on when route quality matters more to you than prefix reuse.
   */
  routeForkedChildren: false,
  /** Cap on the task text classified, in characters. */
  maxTaskChars: 4_000,
  /** Pin a specific intent regardless of the task text. Empty disables. */
  forceIntent: '',
})

/** Keep this much of a log file before it restarts, so the journal stays bounded. */
const MAX_LOG_BYTES = 4 * 1024 * 1024

/** pstack role names, exported so `/setup-pstack` and the journal agree. */
export { INTENT_IDS }

/**
 * Expand a leading `~` against the current user's home directory.
 * @param {unknown} path - configuration path, possibly starting with `~/`.
 * @returns {string} an absolute path, or an empty string for a non-string.
 */
function expandHome(path) {
  if (typeof path !== 'string' || path === '') return ''
  if (path === '~') return homedir()
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

/** Accept only a non-negative safe integer, else the documented default. */
function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

/**
 * Merge the Loader row's configuration over the documented defaults.
 * @param {Record<string, unknown> | undefined} input - the row's `config`.
 * @returns {typeof DEFAULTS} a complete, type-checked configuration.
 */
export function normalizeConfig(input) {
  const raw = input !== null && typeof input === 'object' ? input : {}
  return {
    enabled: raw.enabled !== false,
    scope: raw.scope === 'all' ? 'all' : 'children',
    budget: isBudgetLabel(raw.budget) ? raw.budget : DEFAULTS.budget,
    rolesPath: typeof raw.rolesPath === 'string' ? raw.rolesPath : DEFAULTS.rolesPath,
    logPath: typeof raw.logPath === 'string' ? raw.logPath : DEFAULTS.logPath,
    logTasks: raw.logTasks !== false,
    catalogTtlMs: positiveInteger(raw.catalogTtlMs, DEFAULTS.catalogTtlMs) || DEFAULTS.catalogTtlMs,
    quarantineMs: positiveInteger(raw.quarantineMs, DEFAULTS.quarantineMs),
    maxRouteRetries: positiveInteger(raw.maxRouteRetries, DEFAULTS.maxRouteRetries),
    fallbackToParent: raw.fallbackToParent !== false,
    routeForkedChildren: raw.routeForkedChildren === true,
    maxTaskChars: positiveInteger(raw.maxTaskChars, DEFAULTS.maxTaskChars) || DEFAULTS.maxTaskChars,
    forceIntent: typeof raw.forceIntent === 'string' && raw.forceIntent in Object.fromEntries(INTENT_IDS.map(id => [id, true]))
      ? raw.forceIntent
      : '',
  }
}

/**
 * Read the role pins `/setup-pstack` wrote, tolerating a missing or malformed
 * file. A broken pin file must never stop delegation.
 *
 * A pin is stored as the full `provider/model` route, exactly as the settings
 * card displays it. It is deliberately not split here: a provider id or a model
 * id may itself contain a `/` (this profile's `magpie` provider advertises
 * `group/deepseek-v4-1-flash`), so only the checked pool can say where the
 * boundary is. {@link apply} resolves each pin against that pool.
 *
 * @param {string} path - absolute path to the roles JSON.
 * @returns {{ budget: string | undefined, pins: Map<string, { route: string, effort: string | undefined }> }}
 */
export function readRoles(path) {
  const empty = { budget: undefined, pins: new Map() }
  if (path === '') return empty
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return empty
  }
  if (parsed === null || typeof parsed !== 'object') return empty
  const pins = new Map()
  const intents = parsed.intents
  if (intents !== null && typeof intents === 'object' && !Array.isArray(intents)) {
    for (const [role, value] of Object.entries(intents)) {
      // A role line (`feature`) maps through its intent; an intent id is itself.
      const intent = intentForRole(role) ?? (INTENT_IDS.includes(role) ? role : undefined)
      if (intent === undefined || typeof value !== 'string') continue
      const [route, effort] = value.split('@').map(part => part.trim())
      if (route === undefined || route === '' || !route.includes('/')) continue
      pins.set(intent, { route, effort: effort === '' || effort === undefined ? undefined : effort })
    }
  }
  return {
    budget: isBudgetLabel(parsed.budget) ? parsed.budget : undefined,
    pins,
  }
}

/**
 * Extract the plain text of one chat message.
 * @param {unknown} message - a message from the step batch.
 * @returns {string} its text blocks joined by newlines, or an empty string.
 */
function textOfMessage(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
}

/**
 * The task text a delegated child was given: its user messages in the first
 * step, which for a fresh child is the delegation prompt.
 * @param {readonly unknown[]} messages - messages entering the step.
 * @returns {string} trimmed task text, possibly empty.
 */
export function taskOfMessages(messages) {
  if (!Array.isArray(messages)) return ''
  const parts = []
  for (const message of messages) {
    if (message === null || typeof message !== 'object' || message.role !== 'user') continue
    const text = textOfMessage(message).trim()
    if (text !== '') parts.push(text)
  }
  return parts.join('\n').trim()
}

/**
 * Describe one agent's position in the delegation tree from durable header
 * fields, so the answer survives a restart or a resume.
 * @param {unknown} agent - the live agent.
 * @returns {{ child: boolean, depth: number, parentId: string | undefined, forked: boolean }}
 */
function lineageOf(agent) {
  const header = agent?.session?.header
  const depth = typeof header?.delegationDepth === 'number' ? header.delegationDepth : 0
  const parentId = typeof header?.parentSession === 'string' ? header.parentSession : undefined
  // A teammate has a parent session without a delegation depth; a subagent has
  // both. Either one means a delegating agent made this choice, not the user.
  return {
    child: parentId !== undefined || depth > 0 || header?.origin === 'subagent',
    depth,
    parentId,
    // A fork child's conversation is seeded from its parent's completed turns.
    // Changing its route would discard the KV-cache reuse that is the entire
    // reason to fork instead of spawn, so the default policy leaves it alone.
    forked: header?.isSeeded === true,
  }
}

/** Stable identity for one exact route, for logs and equality. */
function routeKey(provider, model, effort) {
  const route = `${provider}/${model}`
  return effort === undefined || effort === '' ? route : `${route} @ ${effort}`
}

/**
 * Install the router.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {Record<string, unknown>} [config] - the Loader row's configuration.
 * @returns {(() => void) | void} disposer for the plugin's own state.
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  if (!settings.enabled) {
    ctx.logger.info('ds-pstack: routing disabled by configuration')
    return
  }

  const rolesPath = expandHome(settings.rolesPath)
  const logPath = expandHome(settings.logPath)
  /** child session id -> { route, intent, difficulty } */
  const decisions = new Map()
  /** child session id -> classified task text */
  const tasks = new Map()
  /** child session id -> retries spent this step */
  const retries = new Map()
  /** route key -> epoch ms until which the route is skipped */
  const quarantined = new Map()
  /** cached catalogue: routes, resolved efforts, and when it was built */
  const catalog = { at: 0, routes: null, signature: '', logBytes: undefined }

  /**
   * Append one JSONL record to the journal. Journaling never affects routing.
   * @param {Record<string, unknown>} record - decision or skip record.
   */
  function journal(record) {
    if (logPath === '') return
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`
    try {
      if (catalog.logBytes === undefined) {
        try {
          catalog.logBytes = statSync(logPath).size
        } catch {
          catalog.logBytes = 0
        }
      }
      // A journal that outgrew the cap starts over instead of growing forever.
      if (catalog.logBytes > MAX_LOG_BYTES) {
        writeFileSync(logPath, line, { encoding: 'utf8', mode: 0o600 })
        catalog.logBytes = Buffer.byteLength(line, 'utf8')
        return
      }
      appendFileSync(logPath, line, { encoding: 'utf8', mode: 0o600 })
      catalog.logBytes += Buffer.byteLength(line, 'utf8')
    } catch { /* a missing or unwritable journal must not affect routing */ }
  }

  /**
   * The checked model pool: exact routes the user authorized for subagents.
   * This is the only set the router may choose from.
   * @returns {{ provider: string, model: string }[] | undefined} the pool, or
   *   undefined when the setting is off, empty, or unreadable.
   */
  function checkedPool() {
    let current
    try {
      current = ctx.get('subagentModelSelection')?.current()
    } catch {
      return undefined
    }
    const allowed = current?.allowedModels
    if (!Array.isArray(allowed) || allowed.length === 0) return undefined
    const routes = []
    const seen = new Set()
    for (const route of allowed) {
      if (route === null || typeof route !== 'object') continue
      if (typeof route.provider !== 'string' || typeof route.model !== 'string') continue
      if (route.provider === '' || route.model === '') continue
      const key = `${route.provider}\0${route.model}`
      if (seen.has(key)) continue
      seen.add(key)
      routes.push({ provider: route.provider, model: route.model })
    }
    return routes.length === 0 ? undefined : routes
  }

  /**
   * Resolve each pool route's advertised efforts and display name, so the
   * router never sends an unsupported effort. A route whose adapter fails to
   * resolve stays eligible but competes on its id alone.
   * @param {readonly { provider: string, model: string }[]} pool - checked routes.
   * @param {AbortSignal | undefined} signal - turn cancellation.
   * @returns {Promise<{provider: string, model: string, name: string, efforts: readonly {id: string}[], defaultEffort: string|undefined, contextWindow: number|undefined}[]>}
   */
  async function resolvePool(pool, signal) {
    const llm = ctx.get('llm')
    const adapterCache = new Map()
    const resolved = []
    for (const route of pool) {
      let info
      try {
        if (llm !== undefined) info = await llm.resolveModelInfo(route.provider, route.model, signal)
      } catch (error) {
        // An adapter that honours the signal aborts mid-resolve. Treating that
        // as "no metadata" would cache a catalogue with no advertised efforts
        // and silently drop every routed effort for catalogTtlMs.
        if (signal?.aborted === true) throw error
        info = undefined
      }
      let advertised
      if (info === undefined && llm !== undefined) {
        // resolveModelInfo can fail for a route an adapter only lists; the
        // catalogue entry still carries enough to rank it.
        if (!adapterCache.has(route.provider)) {
          try {
            adapterCache.set(route.provider, await llm.listModels(route.provider))
          } catch {
            adapterCache.set(route.provider, [])
          }
        }
        advertised = adapterCache.get(route.provider)?.find(model => model?.id === route.model)
      }
      resolved.push({
        provider: route.provider,
        model: route.model,
        name: typeof info?.name === 'string' ? info.name : (typeof advertised?.name === 'string' ? advertised.name : route.model),
        description: typeof info?.description === 'string' ? info.description : advertised?.description,
        efforts: Array.isArray(info?.reasoning?.efforts) ? info.reasoning.efforts : [],
        defaultEffort: info?.reasoning?.defaultEffort,
        contextWindow: info?.context?.contextWindow,
      })
    }
    return resolved
  }

  /**
   * The cached, resolved pool, rebuilt when it expires or when the checked set
   * changed.
   *
   * The pool identity is compared on every call rather than only when the TTL
   * lapses. `checkedPool()` is a cheap synchronous read of the settings, and
   * without this a model the user unchecked stayed selectable for up to
   * `catalogTtlMs`; the checked set is the authorization boundary, so it is read
   * every time.
   *
   * @param {number} now - current epoch milliseconds.
   * @param {AbortSignal | undefined} signal - turn cancellation.
   * @returns {Promise<object[] | undefined>} the resolved pool, or undefined.
   */
  async function currentCatalogue(now, signal) {
    const pool = checkedPool()
    if (pool === undefined) {
      catalog.routes = null
      catalog.signature = ''
      return undefined
    }
    const signature = pool.map(route => `${route.provider}/${route.model}`).join('\n')
    if (catalog.routes !== null && catalog.signature === signature && now - catalog.at < settings.catalogTtlMs) {
      return catalog.routes
    }
    const resolved = await resolvePool(pool, signal)
    catalog.routes = resolved
    catalog.signature = signature
    catalog.at = now
    // Quarantine entries for routes that left the pool can never be revisited
    // through the scoring loop, so they would sit in the map for the life of the
    // process. Drop them when the pool they belonged to is rebuilt.
    const live = new Set(pool.map(route => routeKey(route.provider, route.model)))
    for (const key of quarantined.keys()) {
      if (!live.has(key)) quarantined.delete(key)
    }
    return resolved
  }

  /**
   * Whether a route is currently known to be failing.
   * @param {string} key - route key.
   * @returns {boolean} whether the route is quarantined right now.
   */
  function isQuarantined(key) {
    const until = quarantined.get(key)
    if (until === undefined) return false
    if (until <= Date.now()) {
      quarantined.delete(key)
      return false
    }
    return true
  }

  /**
   * Choose one route for a classified task out of the resolved pool.
   *
   * A role pin wins outright, because `/setup-pstack` recorded a human decision.
   * Otherwise the pool is ranked by how well each model's traits fit the intent;
   * ties keep the checked order, so the user's own ordering breaks them.
   *
   * @param {object[]} routes - resolved pool.
   * @param {string} intent - intent id.
   * @param {string} difficulty - difficulty read.
   * @param {string} budget - budget label.
   * @param {Map<string, { route: string, effort: string | undefined }>} pins - role pins by intent.
   * @returns {{ provider: string, model: string, effort: string|undefined, score: number, pinned: boolean, floor: string } | undefined}
   */
  function chooseRoute(routes, intent, difficulty, budget, pins) {
    const floor = effortFloor(intent, difficulty, budget)
    const pin = pins.get(intent)
    if (pin !== undefined) {
      // A pin is a full `provider/model` string; only the pool knows where the
      // provider ends, because either side may contain a `/`.
      const match = routes.find(route => `${route.provider}/${route.model}` === pin.route
        // A quarantined route must not win through a pin either, or a retry
        // re-selects the route that just failed until the budget is spent.
        && !isQuarantined(routeKey(route.provider, route.model)))
      // A pin that is no longer checked is stale, not authorization: fall
      // through to classification rather than leaving the pool.
      if (match !== undefined) {
        // A pinned effort is a human decision, but `llm.prepareCall` throws
        // UNSUPPORTED_REASONING_EFFORT outside this waterfall when the route
        // does not advertise it, which would kill the child's turn. Fall back
        // to the advertised ladder instead of sending it.
        const pinnedSupported = pin.effort !== undefined && pin.effort !== ''
          && match.efforts.some(effort => effort?.id === pin.effort)
        return {
          provider: match.provider,
          model: match.model,
          effort: pinnedSupported ? pin.effort : chooseEffort(match.efforts, floor, match.defaultEffort),
          effortDropped: pin.effort !== undefined && pin.effort !== '' && !pinnedSupported,
          score: Number.POSITIVE_INFINITY,
          pinned: true,
          floor,
        }
      }
    }
    let best
    let bestScore = Number.NEGATIVE_INFINITY
    for (const route of routes) {
      if (isQuarantined(routeKey(route.provider, route.model))) continue
      const score = scoreModel({ id: route.model, name: route.name, description: route.description }, intent, {
        contextWindow: route.contextWindow,
      })
      if (score > bestScore) {
        bestScore = score
        best = route
      }
    }
    if (best === undefined) return undefined
    return {
      provider: best.provider,
      model: best.model,
      effort: chooseEffort(best.efforts, floor, best.defaultEffort),
      score: bestScore,
      pinned: false,
      floor,
    }
  }

  /**
   * Replace a proposed call configuration with the chosen route. An inherited
   * effort belongs to the inherited model, so it is dropped rather than carried
   * onto a different one, which `llm.prepareCall` would reject.
   * @param {object} base - the configuration the loop proposed.
   * @param {{ provider: string, model: string, effort: string|undefined }} route - chosen route.
   * @returns {object} the replacement configuration.
   */
  function applyRoute(base, route) {
    const next = { ...base, provider: route.provider, model: route.model }
    if (route.effort === undefined || route.effort === '') delete next.reasoningEffort
    else next.reasoningEffort = route.effort
    return next
  }

  /**
   * Whether the delegating agent explicitly chose this child's LLM route.
   *
   * The comparison baseline must be the parent's *effective* route, not its
   * creation options: the harness stamps a child's options from the parent's
   * last logged request header (`parentAgentOptionsForDelegation`), and after
   * routing that header is the route this router chose. Comparing creation
   * options would therefore read the router's own earlier decision as an
   * explicit request, so a grandchild — or any child of a parent whose model
   * the user switched — would never be routed.
   *
   * `requestHeader()?.config` is that effective route; creation options are the
   * fallback before the parent has made a request. Only a difference from *that*
   * is a delegation call that named its own route.
   *
   * A reasoning effort on its own is also an explicit decision: an adapter can
   * change effort without changing the model, so an effort that differs from the
   * parent's effective effort is honored and the router keeps its hands off.
   *
   * When the parent cannot be resolved, the child's own creation options are the
   * only evidence left. A child that named a route is then treated as explicit,
   * because overriding a deliberate choice on a guess is worse than leaving it
   * alone: the router's job is to fill a gap, not to win an argument. This case
   * is reachable for a restored or orphaned child whose parent left the registry.
   *
   * @param {unknown} agent - the child agent.
   * @param {string | undefined} parentId - its parent session id.
   * @returns {boolean} whether an explicit request should win.
   */
  function respectsExplicit(agent, parentId) {
    const childOptions = agent?.options
    // No parent id at all means no inherited route to preserve. This is the
    // top-level session, which only reaches here under `scope: 'all'`; treating
    // it as explicit would make that documented scope a no-op.
    if (parentId === undefined) return false
    if (childOptions?.provider === undefined || childOptions?.model === undefined) return false
    const parent = ctx.get('agents')?.get(parentId)
    const effective = parent?.session?.requestHeader?.()?.config ?? parent?.options
    // The parent is not resolvable, so there is no inherited route to compare
    // against and no authority to overrule the child's own choice.
    if (effective?.provider === undefined || effective?.model === undefined) return true
    if (childOptions.provider !== effective.provider || childOptions.model !== effective.model) return true
    // Same route: an effort the delegation named, and the parent does not
    // already run at, is still a deliberate choice.
    return childOptions.reasoningEffort !== undefined
      && childOptions.reasoningEffort !== effective.reasoningEffort
  }

  // Capture the child's task before its first request. This listener observes
  // and never rewrites the step: the classification needs the prompt text, and
  // the brief the parent wrote is the only evidence available before the child
  // has produced anything of its own.
  const onPreStep = ctx.on('agent/pre-step', (payload, next) => {
    try {
      const { agent, messages } = payload ?? {}
      if (agent !== undefined && !tasks.has(agent.id) && inScope(agent)) {
        const task = taskOfMessages(messages)
        if (task !== '') tasks.set(agent.id, task.slice(0, settings.maxTaskChars))
      }
      // The retry budget is per step, so it resets here rather than per session.
      if (agent !== undefined) retries.delete(agent.id)
    } catch { /* observation only */ }
    return next()
  })

  /**
   * Whether this plugin should decide the route for one agent.
   * @param {unknown} agent - the live agent.
   * @returns {boolean} whether the agent is in the configured scope.
   */
  function inScope(agent) {
    if (settings.scope === 'all') return true
    return lineageOf(agent).child
  }

  const onRequest = ctx.on('agent/request', async (payload, next) => {
    const base = await next()
    try {
      const { agent, signal } = payload ?? {}
      if (!settings.enabled || agent === undefined || base === undefined) return base
      if (!inScope(agent)) return base
      const lineage = lineageOf(agent)
      if (lineage.forked && !settings.routeForkedChildren) {
        journal({ event: 'skip', reason: 'forked-child', agent: agent.id })
        return base
      }
      if (respectsExplicit(agent, lineage.parentId)) {
        journal({ event: 'skip', reason: 'explicit-request', agent: agent.id, route: routeKey(base.provider, base.model, base.reasoningEffort) })
        return base
      }

      const cached = decisions.get(agent.id)
      if (cached !== undefined) {
        if (cached.route === undefined) return base
        // The checked pool is the authorization boundary, so a cached decision
        // is re-validated against the live setting. Without this, unchecking a
        // model left every running child still sending it.
        const live = checkedPool()
        const stillChecked = live?.some(route => route.provider === cached.route.provider && route.model === cached.route.model) === true
        if (stillChecked) return applyRoute(base, cached.route)
        journal({ event: 'skip', reason: 'route-unchecked', agent: agent.id, route: routeKey(cached.route.provider, cached.route.model) })
        decisions.delete(agent.id)
      }

      const task = tasks.get(agent.id) ?? (lineage.parentId === undefined ? '' : tasks.get(lineage.parentId) ?? '')
      const context = { agent: agent.id, parent: lineage.parentId, depth: lineage.depth, base: routeKey(base.provider, base.model) }
      if (task === '') {
        journal({ event: 'skip', reason: 'no-task', ...context })
        // Not cached: a later step may carry the prompt, and a cached negative
        // would pin this child to its inherited route for its whole lifetime.
        return base
      }

      let routes
      try {
        routes = await currentCatalogue(Date.now(), signal)
      } catch (error) {
        journal({ event: 'skip', reason: 'catalogue-error', detail: String(error?.message ?? error), ...context })
        return base
      }
      if (routes === undefined || routes.length === 0) {
        journal({ event: 'skip', reason: 'no-pool', detail: 'no models are checked for subagents', ...context })
        // Not cached: the user can check a model at any time.
        return base
      }

      const roles = readRoles(rolesPath)
      const budget = roles.budget ?? settings.budget
      // The delegation prompt is the only evidence available before the child
      // has produced anything. The call's short `description` is a display
      // label the runtime does not pass to the child, so it is not reachable
      // here and classification never depends on it.
      const classification = classifyTask(task)
      const intent = settings.forceIntent !== '' ? settings.forceIntent : classification.intent
      const route = chooseRoute(routes, intent, classification.difficulty, budget, roles.pins)
      if (route === undefined) {
        journal({ event: 'skip', reason: 'no-route', intent, ...context })
        // Not cached: every candidate may be quarantined right now, and a
        // quarantine expires.
        return base
      }

      decisions.set(agent.id, { route, intent })
      journal({
        event: 'decision',
        ...context,
        intent,
        difficulty: classification.difficulty,
        scores: classification.scores,
        pinned: route.pinned,
        ...route.effortDropped === true ? { pinEffortDropped: true } : {},
        floor: route.floor,
        route: routeKey(route.provider, route.model, route.effort),
        candidates: routes.length,
        budget,
        task: settings.logTasks ? task.slice(0, 300) : undefined,
      })
      ctx.logger.info(
        `ds-pstack: child ${agent.id} -> ${routeKey(route.provider, route.model, route.effort)} (intent ${intent}${route.pinned ? ', pinned' : ''})`,
      )
      return applyRoute(base, route)
    } catch (error) {
      journal({ event: 'skip', reason: 'router-error', detail: String(error?.message ?? error) })
      return base
    }
  })

  const onDisposed = ctx.on('agent/disposed', ({ agent }) => {
    if (agent === undefined) return
    decisions.delete(agent.id)
    tasks.delete(agent.id)
    retries.delete(agent.id)
  })

  // A route the catalogue advertises can still be refused at request time: an
  // upstream provider is disabled, a key was revoked, a model was withdrawn.
  // Quarantine it, forget the child's decision, and let the loop re-ask so the
  // next candidate wins; the child's inherited route is the last resort.
  const onRequestError = ctx.on('agent/request-error', async (payload, next) => {
    const downstream = await next()
    try {
      const { agent, provider, failure, signal } = payload ?? {}
      // `agent/request-error` also fires for a stream the caller aborted. A
      // cancellation says nothing about the route, so quarantining it would
      // poison a healthy model for every other child.
      if (signal?.aborted === true) return downstream
      if (downstream?.kind === 'retry' || agent === undefined) return downstream
      const cached = decisions.get(agent.id)
      if (cached?.route === undefined || cached.route.provider !== provider) return downstream

      const key = routeKey(cached.route.provider, cached.route.model)
      const now = Date.now()
      // Prune on write so a long-lived host cannot accumulate entries for
      // routes nothing visits any more.
      for (const [entry, until] of quarantined) {
        if (until <= now) quarantined.delete(entry)
      }
      quarantined.set(key, now + settings.quarantineMs)
      decisions.delete(agent.id)
      const spent = retries.get(agent.id) ?? 0
      journal({
        event: 'route-failed',
        agent: agent.id,
        route: key,
        intent: cached.intent,
        code: failure?.code,
        detail: String(failure?.message ?? failure?.code ?? 'request failed').slice(0, 200),
        retry: spent + 1,
        quarantinedFor: settings.quarantineMs,
      })
      if (spent >= settings.maxRouteRetries) {
        journal({ event: 'skip', reason: 'route-retries-exhausted', agent: agent.id, route: key })
        return downstream
      }
      retries.set(agent.id, spent + 1)
      return { kind: 'retry' }
    } catch (error) {
      journal({ event: 'skip', reason: 'recovery-error', detail: String(error?.message ?? error) })
      return downstream
    }
  })

  journal({
    event: 'active',
    version: VERSION,
    scope: settings.scope,
    budget: settings.budget,
    rolesPath: rolesPath,
    logPath: logPath,
    pool: (checkedPool() ?? []).map(route => `${route.provider}/${route.model}`),
  })
  ctx.logger.info(
    `ds-pstack: routing active — v${VERSION}, scope ${settings.scope}, budget ${settings.budget}, ` +
    `${(checkedPool() ?? []).length} checked subagent model(s), journal ${logPath}`,
  )

  return () => {
    onPreStep?.()
    onRequest?.()
    onRequestError?.()
    onDisposed?.()
    decisions.clear()
    tasks.clear()
    retries.clear()
    quarantined.clear()
    catalog.routes = null
    catalog.signature = ''
  }
}

/** Cordis plugin name. */
export const name = 'ds-pstack-router'
/** Services read by this plugin; `llm` and the model-selection setting stay optional. */
export const inject = ['agents']
