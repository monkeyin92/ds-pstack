/**
 * Behaviour tests for the ds-pstack router and skill provider.
 *
 * These run with plain `node --test`, so the package needs no build step and no
 * dev dependency. What they assert is what a user can observe: a delegated
 * child's call configuration changes to a checked route, nothing outside the
 * checked pool is ever sent, and an explicit request is left alone.
 *
 * @module @local/ds-pstack/test
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  chooseEffort,
  classifyTask,
  effortFloor,
  intentForRole,
  modelTraits,
  scoreModel,
} from '../lib/classify.js'
import { apply as applyRouter, normalizeConfig, readRoles, taskOfMessages } from '../lib/router.js'
import { apply as applySkills, candidateOf, parseFrontmatter } from '../lib/skills.js'

/** Build a minimal fake Cordis context that records what the plugin registered. */
function fakeContext(options = {}) {
  const listeners = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {
        const current = listeners.get(event) ?? []
        const index = current.indexOf(handler)
        if (index >= 0) current.splice(index, 1)
      }
    },
    effect(factory) {
      const dispose = factory()
      return () => { if (typeof dispose === 'function') dispose() }
    },
    get(name) {
      return options.services?.[name]
    },
    /** Fire one waterfall event, awaiting the whole chain. */
    async waterfall(event, payload, base) {
      const list = listeners.get(event) ?? []
      let index = 0
      const next = async () => {
        const handler = list[index]
        index += 1
        if (handler === undefined) return base
        return await handler(payload, next)
      }
      return await next()
    },
    /** Fire one emit event. */
    emit(event, payload) {
      for (const handler of listeners.get(event) ?? []) handler(payload)
    },
    skills: { registerProvider: factory => { ctx.providers = [...(ctx.providers ?? []), factory]; return () => {} } },
    providers: [],
  }
  return ctx
}

/** A fake agent with a durable header and creation options. */
function fakeAgent(id, header = {}, agentOptions = {}) {
  return { id, session: { header: { id, version: 1, createdAt: 0, isSeeded: false, ...header } }, options: agentOptions }
}

/** A checked-model-service stand-in matching `ctx.subagentModelSelection.current()`. */
function modelSelection(allowedModels) {
  return { current: () => ({ enabled: true, allowedModels }) }
}

/** A fake llm service with fixed catalogue and effort data. */
function fakeLlm(catalogue) {
  return {
    listProviders: () => [...new Set(catalogue.map(entry => entry.provider))].map(id => ({ id, name: id })),
    listModels: async provider => catalogue.filter(entry => entry.provider === provider).map(entry => ({ id: entry.model, name: entry.name ?? entry.model })),
    resolveModelInfo: async (provider, model) => {
      const entry = catalogue.find(candidate => candidate.provider === provider && candidate.model === model)
      if (entry === undefined) throw new Error(`unknown route ${provider}/${model}`)
      return {
        provider,
        id: model,
        name: entry.name ?? model,
        reasoning: entry.efforts === undefined ? undefined : {
          efforts: entry.efforts.map(id => ({ id, name: id })),
          defaultEffort: entry.efforts[0],
        },
      }
    },
  }
}

describe('classifyTask', () => {
  it('routes a reported defect to debugging, not to a generic implementation', () => {
    const result = classifyTask('Fix the flaky login test and reproduce it before changing anything')
    assert.equal(result.intent, 'debugging')
  })

  it('routes a new endpoint to coding', () => {
    assert.equal(classifyTask('Implement a new /api/runs endpoint that cancels every run for an org').intent, 'coding')
  })

  it('prefers the specific transformation over the noun it touches', () => {
    // "rename" is mechanical and "util file" reads as code; naming the exact
    // transformation is the stronger evidence.
    assert.equal(classifyTask('Rename the util file across all packages').intent, 'mechanical')
  })

  it('routes adversarial checking to review', () => {
    assert.equal(classifyTask('Review this diff and find blind spots in the retry handling').intent, 'review')
  })

  it('routes a read-only question to research', () => {
    assert.equal(classifyTask('How does the cancel path work? Walk me through it').intent, 'research')
  })

  it('routes prose production to writing', () => {
    assert.equal(classifyTask('Write the PR description for this change').intent, 'writing')
  })

  it('reads a race condition as hard difficulty', () => {
    const result = classifyTask('Investigate a possible race condition in the scheduler')
    assert.equal(result.difficulty, 'hard')
  })

  it('reads an explicitly trivial task as easy difficulty', () => {
    assert.equal(classifyTask('A trivial one-line rename of the constant').difficulty, 'easy')
  })

  it('falls back to coding when nothing more specific matched', () => {
    assert.equal(classifyTask('Add a test for the retry policy').intent, 'coding')
  })

  it('reads "report the defects" as review work, not as writing a report', () => {
    // Regression: `\breport\b` used to count as prose production, so an
    // adversarial code review classified as writing and lost its deep route.
    const result = classifyTask('Review this file adversarially and report concrete defects only')
    assert.equal(result.intent, 'review')
  })

  it('still reads an actual report deliverable as writing', () => {
    assert.equal(classifyTask('Write a short report on what the last commits changed').intent, 'writing')
  })

  it('separates reading docs from writing them', () => {
    // A bare `readme`/`docs` token used to mean "produce docs", so a read-only
    // question about documentation was routed as prose work.
    assert.equal(classifyTask('Read the README and reply with only the file name').intent, 'research')
    assert.equal(classifyTask('Update the README to document the new flag').intent, 'writing')
    assert.equal(classifyTask('Look at the docs and tell me how auth works').intent, 'research')
    assert.equal(classifyTask('Write the docs for this API').intent, 'writing')
  })

  it('weighs the opening instruction above a long context block', () => {
    // Regression: a review prompt states its instruction first, then a page of
    // context full of incidental triggers ("error", "fix", "report"). Flat
    // counting let that context outvote the instruction.
    const task = [
      'Review the file adversarially and report concrete defects only.',
      '',
      'File: lib/router.js',
      '',
      'Context: this plugin hooks the agent/request waterfall. It replaces the route. Errors here mean a wrong model runs. Fixed routes were sent before. Read the file. Report defects in order: crashes, security, correctness, resource leaks.',
    ].join('\n')
    assert.equal(classifyTask(task).intent, 'review')
  })
})

describe('effort mapping', () => {
  it('follows pstack budgets: deep work keeps the budget, mechanical work drops two steps', () => {
    assert.equal(effortFloor('debugging', 'normal', 'large'), 'xhigh')
    assert.equal(effortFloor('mechanical', 'normal', 'large'), 'medium')
    assert.equal(effortFloor('writing', 'normal', 'large'), 'high')
  })

  it('raises a hard task one step and lowers an easy one', () => {
    assert.equal(effortFloor('coding', 'hard', 'large'), 'max')
    assert.equal(effortFloor('coding', 'easy', 'large'), 'high')
  })

  it('never asks for less than low', () => {
    assert.equal(effortFloor('mechanical', 'easy', 'small'), 'low')
  })

  it('snaps onto the highest advertised effort at or below the target', () => {
    const efforts = [{ id: 'low' }, { id: 'medium' }, { id: 'high' }, { id: 'max' }]
    assert.equal(chooseEffort(efforts, 'xhigh'), 'high')
    assert.equal(chooseEffort(efforts, 'medium'), 'medium')
    assert.equal(chooseEffort(efforts, 'max'), 'max')
  })

  it('uses a model that tops out below the target at its own highest level', () => {
    assert.equal(chooseEffort([{ id: 'low' }, { id: 'medium' }], 'xhigh'), 'medium')
  })

  it('sends no effort when the route advertises only off', () => {
    assert.equal(chooseEffort([{ id: 'off' }], 'high'), undefined)
  })
})

describe('model ranking', () => {
  it('reads a strong model from its id and ranks it for review', () => {
    assert.ok(modelTraits({ id: 'group/claude-opus-5-5' }).has('strong'))
    assert.ok(scoreModel({ id: 'group/claude-opus-5-5' }, 'review') > scoreModel({ id: 'z-ai/glm-5.3-flash' }, 'review'))
  })

  it('ranks a cheap fast model above a strong one for mechanical work', () => {
    assert.ok(scoreModel({ id: 'group/deepseek-v4-1-flash' }, 'mechanical') > scoreModel({ id: 'group/claude-opus-5-5' }, 'mechanical'))
  })

  it('ranks a long-context model above others for research', () => {
    assert.ok(scoreModel({ id: 'x/grok-4.7' }, 'research') > scoreModel({ id: 'x/tiny-coder' }, 'research'))
  })
})

describe('role mapping', () => {
  it('maps every pstack role line onto an intent', () => {
    assert.equal(intentForRole('swarm workers'), 'coding')
    assert.equal(intentForRole('interrogate reviewers'), 'review')
    assert.equal(intentForRole('hardest tasks'), 'planning')
    assert.equal(intentForRole('how explorer'), 'research')
  })

  it('ignores an unknown role rather than guessing', () => {
    assert.equal(intentForRole('how critics'), undefined)
  })
})

describe('readRoles', () => {
  it('reads a budget and a pin, keeping the route whole until the pool resolves it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ds-pstack-roles-'))
    const path = join(dir, 'roles.json')
    writeFileSync(path, JSON.stringify({
      budget: 'medium',
      intents: { 'feature': 'magpie/group/deepseek-v4-1-flash', 'interrogate reviewers': 'magpie/group/claude-opus-5-5 @ high' },
    }))
    const roles = readRoles(path)
    assert.equal(roles.budget, 'medium')
    // The route is NOT split here, because a provider or model id may itself
    // contain a slash; only the checked pool can say where the boundary is.
    assert.deepEqual(roles.pins.get('coding'), { route: 'magpie/group/deepseek-v4-1-flash', effort: undefined })
    assert.deepEqual(roles.pins.get('review'), { route: 'magpie/group/claude-opus-5-5', effort: 'high' })
  })

  it('treats a missing or malformed file as no pins so delegation still works', () => {
    assert.equal(readRoles(join(tmpdir(), 'definitely-absent-ds-pstack-roles.json')).pins.size, 0)
    const dir = mkdtempSync(join(tmpdir(), 'ds-pstack-bad-'))
    const path = join(dir, 'roles.json')
    writeFileSync(path, '{ not json')
    assert.equal(readRoles(path).pins.size, 0)
  })
})

/** Build the pieces one routing assertion needs. */
function routed(pool, catalogue, options = {}) {
  const ctx = fakeContext({
    services: {
      subagentModelSelection: modelSelection(pool),
      llm: fakeLlm(catalogue),
      agents: { get: () => options.parent },
    },
  })
  const dir = mkdtempSync(join(tmpdir(), 'ds-pstack-router-'))
  applyRouter(ctx, {
    rolesPath: options.rolesPath ?? join(dir, 'no-roles.json'),
    logPath: join(dir, 'journal.jsonl'),
    ...options.config,
  })
  return { ctx, journalPath: join(dir, 'journal.jsonl') }
}

/** Run one full delegation: capture the task, then answer its first request. */
async function delegate(ctx, child, base, task) {
  await ctx.waterfall('agent/pre-step', { agent: child, messages: [{ role: 'user', content: [{ type: 'text', text: task }] }], turn: 1, step: 1, signal: new AbortController().signal }, undefined)
  return await ctx.waterfall('agent/request', { agent: child, turn: 1, step: 1, signal: new AbortController().signal }, base)
}

describe('router: choosing a child route', () => {
  const pool = [
    { provider: 'magpie', model: 'group/deepseek-v4-1-flash' },
    { provider: 'magpie', model: 'group/claude-opus-5-5' },
  ]
  const catalogue = [
    { provider: 'magpie', model: 'group/deepseek-v4-1-flash', efforts: ['low', 'high', 'max'] },
    { provider: 'magpie', model: 'group/claude-opus-5-5', efforts: ['low', 'medium', 'high', 'max'] },
  ]
  const base = { provider: 'magpie', model: 'group/deepseek-v4-1-flash', reasoningEffort: 'max' }

  it('routes a review task to the stronger checked model at a budget-appropriate effort', async () => {
    const { ctx } = routed(pool, catalogue)
    const child = fakeAgent('child-1', { origin: 'subagent', delegationDepth: 1, parentSession: 'root' })
    const result = await delegate(ctx, child, base, 'Review this diff and find blind spots')
    assert.equal(result.provider, 'magpie')
    assert.equal(result.model, 'group/claude-opus-5-5')
    // `large` budget, review intent (one step down), normal difficulty -> high.
    assert.equal(result.reasoningEffort, 'high')
  })

  it('keeps a mechanical task on the cheap checked model', async () => {
    const { ctx } = routed(pool, catalogue)
    const child = fakeAgent('child-2', { origin: 'subagent', delegationDepth: 1, parentSession: 'root' })
    const result = await delegate(ctx, child, base, 'Rename the constant and reformat the file')
    assert.equal(result.model, 'group/deepseek-v4-1-flash')
  })

  it('never sends a route outside the checked pool', async () => {
    // The stronger model exists in the catalogue but the user did not check it.
    const { ctx } = routed([{ provider: 'magpie', model: 'group/deepseek-v4-1-flash' }], catalogue)
    const child = fakeAgent('child-3', { origin: 'subagent', delegationDepth: 1, parentSession: 'root' })
    const result = await delegate(ctx, child, base, 'Review this diff and challenge the design')
    assert.equal(result.model, 'group/deepseek-v4-1-flash')
  })

  it('reuses one decision for every later request of the same child', async () => {
    const { ctx } = routed(pool, catalogue)
    const child = fakeAgent('child-4', { origin: 'subagent', delegationDepth: 1, parentSession: 'root' })
    const first = await delegate(ctx, child, base, 'Review this diff and find blind spots')
    const second = await ctx.waterfall('agent/request', { agent: child, turn: 1, step: 2, signal: new AbortController().signal }, first)
    assert.deepEqual(second, first)
  })

  it('leaves a child alone when the delegation explicitly named a route', async () => {
    const parent = fakeAgent('root', {}, { provider: 'magpie', model: 'group/deepseek-v4-1-flash' })
    const { ctx } = routed(pool, catalogue, { parent })
    // The child's creation options name a different route than its parent's.
    const child = fakeAgent('child-5', { origin: 'subagent', delegationDepth: 1, parentSession: 'root' }, {
      provider: 'magpie', model: 'group/claude-opus-5-5',
    })
    const result = await delegate(ctx, child, base, 'Review this diff and find blind spots')
    assert.equal(result.model, 'group/deepseek-v4-1-flash')
  })

  it('does not touch the top-level session in the default scope', async () => {
    const { ctx } = routed(pool, catalogue)
    const root = fakeAgent('root-session')
    const result = await delegate(ctx, root, base, 'Review this diff and find blind spots')
    assert.deepEqual(result, base)
  })

  it('writes one decision record naming the intent and the chosen route', async () => {
    const { ctx, journalPath } = routed(pool, catalogue)
    const child = fakeAgent('child-6', { origin: 'subagent', delegationDepth: 1, parentSession: 'root' })
    await delegate(ctx, child, base, 'Review this diff and find blind spots')
    const events = readFileSync(journalPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    const decision = events.find(event => event.event === 'decision')
    assert.ok(decision !== undefined)
    assert.equal(decision.intent, 'review')
    assert.equal(decision.route, 'magpie/group/claude-opus-5-5 @ high')
    assert.equal(decision.candidates, 2)
  })

  it('records why it skipped instead of failing the delegation', async () => {
    const { ctx, journalPath } = routed([], catalogue)
    const child = fakeAgent('child-7', { origin: 'subagent', delegationDepth: 1, parentSession: 'root' })
    const result = await delegate(ctx, child, base, 'Review this diff')
    assert.deepEqual(result, base)
    const events = readFileSync(journalPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.ok(events.some(event => event.event === 'skip' && event.reason === 'no-pool'))
  })

  it('honours a role pin written by setup-pstack', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ds-pstack-pin-'))
    const rolesPath = join(dir, 'roles.json')
    writeFileSync(rolesPath, JSON.stringify({
      budget: 'small',
      intents: { 'interrogate reviewers': 'magpie/group/deepseek-v4-1-flash @ low' },
    }))
    const { ctx } = routed(pool, catalogue, { rolesPath })
    const child = fakeAgent('child-8', { origin: 'subagent', delegationDepth: 1, parentSession: 'root' })
    const result = await delegate(ctx, child, base, 'Review this diff and challenge the design')
    assert.equal(result.model, 'group/deepseek-v4-1-flash')
    assert.equal(result.reasoningEffort, 'low')
  })

  it('ignores a pin whose route is no longer checked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ds-pstack-stale-'))
    const rolesPath = join(dir, 'roles.json')
    writeFileSync(rolesPath, JSON.stringify({ budget: 'large', intents: { review: 'magpie/group/gpt-6-astra' } }))
    const { ctx } = routed(pool, catalogue, { rolesPath })
    const child = fakeAgent('child-9', { origin: 'subagent', delegationDepth: 1, parentSession: 'root' })
    const result = await delegate(ctx, child, base, 'Review this diff and find blind spots')
    assert.equal(result.model, 'group/claude-opus-5-5')
  })

  it('quarantines a route that failed and retries onto the next candidate', async () => {
    const { ctx } = routed(pool, catalogue)
    const child = fakeAgent('child-10', { origin: 'subagent', delegationDepth: 1, parentSession: 'root' })
    const routedCall = await delegate(ctx, child, base, 'Review this diff and find blind spots')
    assert.equal(routedCall.model, 'group/claude-opus-5-5')
    const action = await ctx.waterfall('agent/request-error', {
      agent: child, turn: 1, step: 1, provider: 'magpie', failure: { code: 'provider_disabled' }, signal: new AbortController().signal,
    }, undefined)
    assert.deepEqual(action, { kind: 'retry' })
    const retried = await ctx.waterfall('agent/request', { agent: child, turn: 1, step: 1, signal: new AbortController().signal }, base)
    assert.equal(retried.model, 'group/deepseek-v4-1-flash')
  })
})

describe('normalizeConfig', () => {
  it('accepts the documented budget labels and rejects an unknown one', () => {
    assert.equal(normalizeConfig({ budget: 'unlimited' }).budget, 'unlimited')
    assert.equal(normalizeConfig({ budget: 'enormous' }).budget, 'large')
  })

  it('rejects an unknown forced intent', () => {
    assert.equal(normalizeConfig({ forceIntent: 'telepathy' }).forceIntent, '')
    assert.equal(normalizeConfig({ forceIntent: 'review' }).forceIntent, 'review')
  })
})

describe('parseFrontmatter and skill candidates', () => {
  it('reads name, description, and the disable-model-invocation flag', () => {
    const { frontmatter, body } = parseFrontmatter('---\nname: demo\ndescription: "A quoted one."\ndisable-model-invocation: true\n---\n# Demo\n')
    assert.deepEqual(frontmatter, { name: 'demo', description: 'A quoted one.', 'disable-model-invocation': 'true' })
    assert.equal(body, '# Demo\n')
  })

  it('reads a folded block description', () => {
    const { frontmatter } = parseFrontmatter('---\nname: demo\ndescription: >-\n  Folded over\n  two lines.\n---\nbody\n')
    assert.equal(frontmatter.description, 'Folded over two lines.')
  })

  it('hides a pstack skill from the model catalog but keeps it invocable', () => {
    const candidate = candidateOf('poteto-mode', '---\nname: poteto-mode\ndescription: style\ndisable-model-invocation: true\n---\nbody', '/x/SKILL.md')
    assert.deepEqual(candidate.invocation, { modelInvocable: false, userInvocable: true })
  })

  it('permits both surfaces when the flag is omitted', () => {
    const candidate = candidateOf('setup-pstack', '---\nname: setup-pstack\ndescription: configure\n---\nbody', '/x/SKILL.md')
    assert.deepEqual(candidate.invocation, { modelInvocable: true, userInvocable: true })
  })

  it('skips a skill with no description instead of failing the catalog', () => {
    assert.equal(candidateOf('nameless', '---\nname: nameless\n---\nbody', '/x/SKILL.md'), undefined)
  })

  it('publishes every shipped skill and nothing with a broken frontmatter', async () => {
    const ctx = fakeContext()
    applySkills(ctx)
    assert.equal(ctx.providers.length, 1)
    const provider = ctx.providers[0]()
    const observation = await provider.list({})
    assert.equal(observation.complete, true)
    assert.ok(observation.candidates.length >= 56, `expected the full pstack skill set, got ${observation.candidates.length}`)
    const names = observation.candidates.map(candidate => candidate.name)
    assert.ok(names.includes('poteto-mode'))
    assert.ok(names.includes('principle-prove-it-works'))
    for (const candidate of observation.candidates) {
      assert.equal(candidate.provider, 'ds-pstack')
      assert.ok(candidate.description.length > 0)
      assert.equal(candidate.resourceBase.kind, 'directory')
      assert.ok(candidate.resourceBase.path.endsWith('/skills/'))
    }
  })

  it('loads a skill body without its frontmatter', async () => {
    const ctx = fakeContext()
    applySkills(ctx)
    const provider = ctx.providers[0]()
    const { candidates } = await provider.list({})
    const candidate = candidates.find(entry => entry.name === 'poteto-mode')
    const skill = await provider.get(candidate, {})
    assert.ok(skill.content.startsWith('# Poteto mode'))
    assert.ok(!skill.content.includes('disable-model-invocation'))
  })
})

describe('taskOfMessages', () => {
  it('joins the text of every user message in the step', () => {
    const task = taskOfMessages([
      { role: 'user', content: [{ type: 'text', text: 'First line.' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ignored' }] },
      { role: 'user', content: [{ type: 'text', text: 'Second line.' }] },
    ])
    assert.equal(task, 'First line.\nSecond line.')
  })

  it('returns an empty string for a step with no user text', () => {
    assert.equal(taskOfMessages([{ role: 'assistant', content: [] }]), '')
    assert.equal(taskOfMessages(undefined), '')
  })
})

describe('router: fork children', () => {
  const pool = [{ provider: 'magpie', model: 'group/deepseek-v4-1-flash' }, { provider: 'magpie', model: 'group/claude-opus-5-5' }]
  const catalogue = [
    { provider: 'magpie', model: 'group/deepseek-v4-1-flash', efforts: ['low', 'high', 'max'] },
    { provider: 'magpie', model: 'group/claude-opus-5-5', efforts: ['low', 'medium', 'high', 'max'] },
  ]
  const base = { provider: 'magpie', model: 'group/deepseek-v4-1-flash', reasoningEffort: 'max' }

  it('leaves a forked child on its inherited route so prefix reuse survives', async () => {
    const { ctx, journalPath } = routed(pool, catalogue)
    const child = fakeAgent('fork-1', { isSeeded: true, parentSession: 'root', delegationDepth: 1 })
    const result = await delegate(ctx, child, base, 'Review this diff and find blind spots')
    assert.deepEqual(result, base)
    const events = readFileSync(journalPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.ok(events.some(event => event.event === 'skip' && event.reason === 'forked-child'))
  })

  it('routes a forked child when the operator opts in', async () => {
    const { ctx } = routed(pool, catalogue, { config: { routeForkedChildren: true } })
    const child = fakeAgent('fork-2', { isSeeded: true, parentSession: 'root', delegationDepth: 1 })
    const result = await delegate(ctx, child, base, 'Review this diff and find blind spots')
    assert.equal(result.model, 'group/claude-opus-5-5')
  })
})

describe('classifier: defects found in adversarial review', () => {
  it('does not let hard difficulty erase mechanical evidence', () => {
    // `prettier` plus a hard marker used to return debugging at max effort.
    const r = classifyTask('Format the whole repo with prettier across the whole codebase')
    assert.equal(r.intent, 'mechanical')
  })

  it('matches plural and past-tense defect words', () => {
    assert.equal(classifyTask('There are three bugs in the retry path').intent, 'debugging')
    assert.equal(classifyTask('The service crashes on startup and logs errors').intent, 'debugging')
    assert.equal(classifyTask('The nightly build failed on main').intent, 'debugging')
  })

  it('does not read the idiom "sort out" as mechanical', () => {
    assert.notEqual(classifyTask('Sort out the flaky nightly deploy').intent, 'mechanical')
  })

  it('routes caller-lookup questions to research', () => {
    assert.equal(classifyTask('Find all callers of parseConfig').intent, 'research')
    assert.equal(classifyTask('Grep for every usage of the retry helper').intent, 'research')
  })

  it('routes reviewing a bug fix to review, not debugging', () => {
    assert.equal(classifyTask('Review this bug fix').intent, 'review')
    assert.equal(classifyTask('Review the fix for the login bug').intent, 'review')
  })

  it('still routes fixing a defect to debugging', () => {
    assert.equal(classifyTask('Fix the flaky login test').intent, 'debugging')
  })

  it('routes documenting an API to writing', () => {
    assert.equal(classifyTask('Document the public API of the parser').intent, 'writing')
  })

  it('splits the opening instruction on a blank line before normalizing', () => {
    const task = 'Write the changelog for 2.0\n\nThe release fixes a bug, a crash, an error, and a regression.'
    assert.equal(classifyTask(task).intent, 'writing')
  })

  it('tolerates a missing or null hints argument', () => {
    assert.equal(classifyTask('Review this diff and find blind spots', null).intent, 'review')
    assert.equal(classifyTask('Review this diff and find blind spots', undefined).intent, 'review')
  })
})

describe('ranking: defects found in adversarial review', () => {
  it('does not read "gemini" as a mini model or "elite" as a lite one', () => {
    // Both used to land in the `fast` class, scoring below an unknown model for review.
    assert.ok(scoreModel({ id: 'google/gemini-3' }, 'review') >= scoreModel({ id: 'acme/unknown-9' }, 'review'))
    assert.ok(scoreModel({ id: 'x/elite-1' }, 'review') >= scoreModel({ id: 'acme/unknown-9' }, 'review'))
  })

  it('still reads a genuine mini/flash model as fast', () => {
    assert.ok(scoreModel({ id: 'acme/chat-mini' }, 'mechanical') > scoreModel({ id: 'acme/chat-large' }, 'mechanical'))
    assert.ok(scoreModel({ id: 'deepseek-v4-1-flash' }, 'research') > scoreModel({ id: 'acme/unknown-9' }, 'research'))
  })

  it('does not read the description word "reasoning" as a strong model', () => {
    const lite = { id: 'acme/chat-lite', description: 'Low-cost model with configurable reasoning effort' }
    assert.ok(scoreModel(lite, 'review') < scoreModel({ id: 'acme/claude-opus-5-5' }, 'review'))
  })

  it('ranks a strong model above a cheap coder for analysis', () => {
    assert.ok(scoreModel({ id: 'acme/opus-5-5' }, 'analysis') > scoreModel({ id: 'acme/flash-coder' }, 'analysis'))
  })

  it('does not let a long context window overturn the class comparison for review', () => {
    const cheapLong = scoreModel({ id: 'acme/flash' }, 'review', { contextWindow: 1_000_000 })
    const deep = scoreModel({ id: 'acme/opus-5-5' }, 'review', { contextWindow: 200_000 })
    assert.ok(deep > cheapLong, `deep ${deep} should beat cheap-long ${cheapLong}`)
  })
})

describe('config: prototype keys', () => {
  it('rejects an inherited object key as a budget label', () => {
    assert.equal(normalizeConfig({ budget: 'constructor' }).budget, 'large')
    assert.equal(normalizeConfig({ budget: 'toString' }).budget, 'large')
    assert.equal(normalizeConfig({ budget: 'large' }).budget, 'large')
  })
})

describe('router: defects found in adversarial review', () => {
  const pool = [{ provider: 'magpie', model: 'group/deepseek-v4-1-flash' }, { provider: 'magpie', model: 'group/claude-opus-5-5' }]
  const catalogue = [
    { provider: 'magpie', model: 'group/deepseek-v4-1-flash', efforts: ['low', 'high', 'max'] },
    { provider: 'magpie', model: 'group/claude-opus-5-5', efforts: ['low', 'medium', 'high', 'max'] },
  ]
  const base = { provider: 'magpie', model: 'group/deepseek-v4-1-flash', reasoningEffort: 'max' }

  it('drops a pinned effort the route does not advertise instead of failing the turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ds-pstack-pinbad-'))
    const rolesPath = join(dir, 'roles.json')
    writeFileSync(rolesPath, JSON.stringify({ budget: 'large', intents: { review: 'magpie/group/claude-opus-5-5 @ xhigh' } }))
    const { ctx, journalPath } = routed(pool, catalogue, { rolesPath })
    const child = fakeAgent('c1', { origin: 'subagent', delegationDepth: 1, parentSession: 'root' })
    const result = await delegate(ctx, child, base, 'Review this diff and find blind spots')
    assert.equal(result.model, 'group/claude-opus-5-5')
    // xhigh is not advertised, so a supported effort is used instead of xhigh.
    assert.notEqual(result.reasoningEffort, 'xhigh')
    const events = readFileSync(journalPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.ok(events.some(event => event.event === 'decision' && event.pinEffortDropped === true))
  })

  it('does not reuse a cached decision for a route the user unchecked', async () => {
    let checked = [...pool]
    const ctx = fakeContext({
      services: {
        subagentModelSelection: { current: () => ({ enabled: true, allowedModels: checked }) },
        llm: fakeLlm(catalogue),
        agents: { get: () => undefined },
      },
    })
    const dir = mkdtempSync(join(tmpdir(), 'ds-pstack-uncheck-'))
    applyRouter(ctx, { rolesPath: join(dir, 'none.json'), logPath: join(dir, 'j.jsonl') })
    const child = fakeAgent('c2', { origin: 'subagent', delegationDepth: 1, parentSession: 'root' })
    const first = await delegate(ctx, child, base, 'Review this diff and find blind spots')
    assert.equal(first.model, 'group/claude-opus-5-5')
    // The user unchecks the strong model while the child is still running.
    checked = [{ provider: 'magpie', model: 'group/deepseek-v4-1-flash' }]
    const second = await ctx.waterfall('agent/request', { agent: child, turn: 1, step: 2, signal: new AbortController().signal }, first)
    assert.equal(second.model, 'group/deepseek-v4-1-flash')
  })

  it('does not cache a negative outcome, so a later step can still be routed', async () => {
    const { ctx, journalPath } = routed(pool, catalogue)
    const child = fakeAgent('c3', { origin: 'subagent', delegationDepth: 1, parentSession: 'root' })
    // First request: no task captured yet, so nothing is routed.
    const first = await ctx.waterfall('agent/request', { agent: child, turn: 1, step: 1, signal: new AbortController().signal }, base)
    assert.deepEqual(first, base)
    // The prompt arrives on the next step; the child must still be routable.
    const second = await delegate(ctx, child, first, 'Review this diff and find blind spots')
    assert.equal(second.model, 'group/claude-opus-5-5')
    const events = readFileSync(journalPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.ok(events.some(event => event.event === 'decision'))
  })

  it('does not quarantine a route when the stream was merely aborted', async () => {
    const { ctx, journalPath } = routed(pool, catalogue)
    const child = fakeAgent('c4', { origin: 'subagent', delegationDepth: 1, parentSession: 'root' })
    await delegate(ctx, child, base, 'Review this diff and find blind spots')
    const aborted = new AbortController()
    aborted.abort()
    const action = await ctx.waterfall('agent/request-error', {
      agent: child, turn: 1, step: 1, provider: 'magpie', failure: { code: 'aborted' }, signal: aborted.signal,
    }, undefined)
    assert.equal(action, undefined)
    const events = readFileSync(journalPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.ok(!events.some(event => event.event === 'route-failed'))
    // The child keeps its route.
    const again = await ctx.waterfall('agent/request', { agent: child, turn: 1, step: 2, signal: new AbortController().signal }, base)
    assert.equal(again.model, 'group/claude-opus-5-5')
  })

  it('compares against the parent effective request header, so a grandchild is still routed', async () => {
    // The parent's logged request header is the router's own chosen route; a
    // child stamped from it must not look like an explicit request.
    const parent = {
      ...fakeAgent('root', {}, { provider: 'magpie', model: 'group/deepseek-v4-1-flash' }),
      session: {
        header: { id: 'root', version: 1, createdAt: 0, isSeeded: false },
        requestHeader: () => ({ config: { provider: 'magpie', model: 'group/claude-opus-5-5', reasoningEffort: 'high' } }),
      },
    }
    const { ctx } = routed(pool, catalogue, { parent })
    const child = fakeAgent('c5', { origin: 'subagent', delegationDepth: 1, parentSession: 'root' }, {
      provider: 'magpie', model: 'group/claude-opus-5-5', reasoningEffort: 'high',
    })
    const result = await delegate(ctx, child, base, 'Review this diff and find blind spots')
    // Routed, not skipped as explicit.
    assert.equal(result.model, 'group/claude-opus-5-5')
    assert.equal(result.reasoningEffort, 'high')
  })

  it('routes the top-level session under scope: all', async () => {
    const { ctx } = routed(pool, catalogue, { config: { scope: 'all' } })
    const root = fakeAgent('top')
    const result = await delegate(ctx, root, base, 'Review this diff and find blind spots')
    assert.equal(result.model, 'group/claude-opus-5-5')
  })

  it('does not let a quarantined route win through a pin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ds-pstack-pinq-'))
    const rolesPath = join(dir, 'roles.json')
    writeFileSync(rolesPath, JSON.stringify({ budget: 'large', intents: { review: 'magpie/group/claude-opus-5-5' } }))
    const { ctx } = routed(pool, catalogue, { rolesPath })
    const child = fakeAgent('c6', { origin: 'subagent', delegationDepth: 1, parentSession: 'root' })
    await delegate(ctx, child, base, 'Review this diff and find blind spots')
    // The pinned route fails, so the retry must move to another candidate.
    await ctx.waterfall('agent/request-error', {
      agent: child, turn: 1, step: 1, provider: 'magpie', failure: { code: 'provider_disabled' }, signal: new AbortController().signal,
    }, undefined)
    const retried = await ctx.waterfall('agent/request', { agent: child, turn: 1, step: 1, signal: new AbortController().signal }, base)
    assert.equal(retried.model, 'group/deepseek-v4-1-flash')
  })
})
