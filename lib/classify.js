/**
 * Task classification for the ds-pstack subagent router.
 *
 * pstack assigns each delegated unit of work a role (`feature`, `bug-fix`,
 * `how explorer`, `interrogate reviewers`, and so on) and expects a model with
 * the right strengths for that role. Cursor hard-codes a model slug per role.
 * This port cannot: the available models are whatever the user checked in
 * Settings, so the router classifies the child's task instead, then ranks the
 * checked pool against what that kind of work needs.
 *
 * Classification is deliberately deterministic. A delegated child runs
 * immediately, so a judgement call that costs a model request would delay every
 * subagent before it starts; worse, a router that silently fails would leave the
 * child on an inherited route nobody chose. Keyword evidence over the
 * delegation prompt is cheap, inspectable, and never fails open into a wrong
 * route.
 *
 * @module @local/ds-pstack/classify
 */

/**
 * The work categories the router can route to. Each maps to a reasoning-effort
 * floor (see {@link INTENT_FLOOR}) and a capability profile (see
 * {@link INTENT_PROFILE}) that ranks candidate models.
 */
const INTENTS = Object.freeze({
  planning: 'planning',
  coding: 'coding',
  debugging: 'debugging',
  review: 'review',
  research: 'research',
  analysis: 'analysis',
  writing: 'writing',
  mechanical: 'mechanical',
})

/** Every intent id, in a stable order (used for diagnostics and validation). */
export const INTENT_IDS = Object.freeze(Object.keys(INTENTS))

/**
 * pstack role names mapped onto intents, so `/setup-pstack` can pin a role the
 * way pstack pins a model, and a skill can name the role it needs.
 */
const ROLE_INTENTS = Object.freeze({
  'feature': 'coding',
  'refactoring': 'coding',
  'bug-fix': 'debugging',
  'perf-issue': 'debugging',
  'hillclimb': 'analysis',
  'judgment and prose': 'writing',
  'hardest tasks': 'planning',
  'how explorer': 'research',
  'how explainer': 'writing',
  'why investigators': 'research',
  'why synthesizer': 'analysis',
  'reflect tooling': 'analysis',
  'reflect judgment': 'review',
  'arena runners': 'planning',
  'arena cross-judge pool': 'review',
  'swarm workers': 'coding',
  'architect runners': 'planning',
  'interrogate reviewers': 'review',
})

/**
 * Steps up or down the effort ladder that each intent applies to the budget
 * base.
 *
 * pstack's rule is that the budget sets each role's starting level, the hardest
 * work goes one step up, judgment work goes one step down, and routine work goes
 * two or more down. The offsets encode that rule rather than a per-intent
 * preference: implementation and diagnosis start at the budget, review and prose
 * start a step below it, and mechanical edits start two below.
 */
const INTENT_OFFSET = Object.freeze({
  planning: 0,
  coding: 0,
  debugging: 0,
  review: -1,
  research: 0,
  analysis: 0,
  writing: -1,
  mechanical: -2,
})

/** pstack's four budget labels and the effort each sets, before per-intent shifts. */
export const BUDGET_BASE = Object.freeze({
  unlimited: 'max',
  large: 'xhigh',
  medium: 'high',
  small: 'medium',
})

/**
 * Ordered effort ladder, shallowest first. `off` exists on some adapters and
 * sorts below `low` so "raise the effort" always means moving up this list.
 */
const EFFORT_LADDER = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/**
 * How each model class fits each intent.
 *
 * A model is classified into exactly one class (see {@link modelClass}), and
 * this table says what that class is worth for a kind of work. Scoring by class
 * rather than by summing every matching trait matters: a cheap flash model
 * matches "fast", "cheap", "balanced", and "long" at once, and a summed score
 * would let it outrank a strong model for review simply by accumulating weak
 * labels. One class, one number.
 */
const CLASS_FIT = Object.freeze({
  planning: { strong: 6, balanced: 3, fast: -1 },
  coding: { strong: 5, balanced: 3, fast: 2 },
  debugging: { strong: 6, balanced: 3, fast: 0 },
  review: { strong: 6, balanced: 3, fast: 0 },
  research: { strong: 1, balanced: 2, fast: 3 },
  analysis: { strong: 3, balanced: 3, fast: 2 },
  writing: { strong: 4, balanced: 3, fast: 2 },
  mechanical: { strong: -3, balanced: 0, fast: 6 },
})

/**
 * Secondary adjustments applied after the class score. These are tiebreakers,
 * deliberately smaller than the gaps in {@link CLASS_FIT}: they decide between
 * two models of the same class and never overturn the class comparison.
 */
const INTENT_TIEBREAK = Object.freeze({
  planning: { prose: 1, long: 1 },
  coding: { code: 2, long: 1 },
  debugging: { code: 2, long: 1 },
  review: { code: 1, prose: 1, long: 1 },
  research: { long: 2, fast: 1 },
  analysis: { long: 2 },
  writing: { prose: 2 },
  mechanical: { cheap: 2, fast: 1 },
})

/**
 * Traits inferred from a model id, display name, and description. Every pattern
 * is case-insensitive.
 *
 * These are guesses from a name, which is why a pinned role outranks them and a
 * tie falls back to the checked order. `strong` is checked before `fast` so a
 * model that advertises depth in any form is treated as the deeper option.
 */
const MODEL_TRAITS = Object.freeze([
  [/opus|terra|astra|\bsol\b|sonnet-5\.[5-9]|-pro\b|\bpro\b|thinking|reason|ultra/i, 'strong'],
  [/mini|nano|flash|lite|small|haiku|spark|fast|turbo/i, 'fast'],
  [/codex|coder|codegen|coding|-code\b/i, 'code'],
  [/flash|mini|nano|lite|economy|cheap|turbo|spark/i, 'cheap'],
  [/gpt-[5-9]|gemini-[3-9]|sonnet|glm-[5-9]|mimo|step-[5-9]|qwen|grok|deepseek/i, 'balanced'],
  [/grok|gemini|deepseek|mimo|qwen|glm|1m|128k|200k|250k|500k|600k/i, 'long'],
  [/opus|sonnet|gpt|claude|glm|qwen|deepseek|grok/i, 'prose'],
])

/** Task phrases that indicate planning or decomposition work. */
const PLANNING_HINTS = /\bplan\b|\bplanning\b|decompos|\bbreak (?:it|this|the work) down|\barchitect|sequenc|\bapproach\b|\bdesign the\b|\bproposal\b|\bstrategy\b|\bmigration plan\b|\bmulti[- ]phase\b/i

/** Task phrases that indicate diagnosis and fixing work. */
const DEBUGGING_HINTS = /\bbug\b|\bfix\b|\bfailing\b|\bfails?\b|\bfailure\b|\berror\b|\bcrash\b|\bregression\b|\breproduc|\broot cause\b|\bdiagnos|\bdebug\b|\bbroken\b|\bflaky\b|\bleak\b|\bhang\b|\bdeadlock\b|\brace condition\b|\bperf(?:ormance)? issue\b|\bslow(?:ness)?\b|\btrace\b|\bprofile\b/i

/** Task phrases that indicate review and verification work. */
const REVIEW_HINTS = /\breview\b|\bverify\b|\bverification\b|\baudit\b|\bcheck (?:the|this|that)\b|\bassess\b|\bcritique\b|\bchallenge\b|\badversarial\b|\btear (?:this|it) apart\b|\bfind (?:the )?(?:blind spots|issues|problems|bugs)\b|\bsecond opinion\b|\bcross-judge\b|\bjudge\b|\bscore\b|\bgrade\b|\bdefects?\b|\bregressions?\b|\bmissed (?:cases|edges?)\b|\bwhat(?:'s| is) wrong\b|\bproblems? (?:with|in)\b|\bissues? (?:with|in)\b|\bwrong (?:route|effort|result)\b|\bcorrectness\b/i

/** Task phrases that indicate prose production. */
/**
 * Prose production. "Report" is deliberately absent even though pstack writes
 * reports: "report the defects you find" is a review instruction, and counting
 * `report` here made an adversarial code review classify as prose writing. A
 * count noun ("a report", "the writeup") or an explicit deliverable verb carries
 * the intent; the bare verb does not.
 */
const WRITING_HINTS = /\bwrite (?:a|an|the|up|me)\b|\bdraft (?:a|an|the)\b|\b(?:write|author|update|revise|draft|edit|improve|document)\b[^.]{0,24}\b(?:readme|docs?|documentation|changelog|pr description|commit message)\b|\bpr description\b|\bcommit message\b|\bchangelog\b|\btechnical writing\b|\ba (?:short |brief )?(?:report|writeup|memo)\b|\bexplain (?:how|why|what|the)\b|\bexplanation\b|\bsummar(?:y|ize)\b|\bprose\b|\brewrite the (?:reply|text|wording|wording)\b/i

/** Task phrases that indicate mechanical, fully-specified edits. */
const MECHANICAL_HINTS = /\brename\b|\bre-?format\b|\bformat (?:the|this|files?)\b|\btypo\b|\bbump (?:the )?version\b|\bupdate the (?:version|changelog)\b|\bcopy\b|\bmove (?:the )?file\b|\bdelete (?:the )?unused\b|\bwhitespace\b|\blint\b|\bfix (?:the )?lint\b|\bfix (?:the )?imports?\b|\bsort\b|\badd (?:a |the )?index\b/i

/** Task phrases that indicate code authoring. */
const CODING_HINTS = /\bimplement\b|\badd\b|\bcreate\b|\bbuild\b|\bwire\b|\brefactor\b|\bchange\b|\bmigrate\b|\bextract\b|\binline\b|\brenam|\bport\b|\bupgrade\b|\btest\b|\btdd\b|\bfeature\b|\bendpoint\b|\bcomponent\b|\bfunction\b|\bhandler\b|\bcli\b|\bapi\b/i

/** Task phrases that indicate information gathering. */
const RESEARCH_HINTS = /\bfind out\b|\bexplore\b|\binvestigate\b|\blook into\b|\blook at\b|\bread (?:the|through|this|that)\b|\bresearch\b|\bhow does\b|\bhow do\b|\bwhere is\b|\bwhere does\b|\bwhich (?:file|package|module)\b|\bwalk me through\b|\bunderstand\b|\bmap out\b|\bonboard|\btell me how\b/i

/** Task phrases that indicate bulk analysis of material. */
const ANALYSIS_HINTS = /\banaly[sz]e\b|\bcompar(?:e|ison)\b|\bextract structural|\bsummari[sz]e (?:the|these|all)\b|\bsift\b|\bclassify\b|\bcorrelate\b|\bextract\b|\bbenchmark\b|\bmeasure\b|\bhillclimb\b|\boptimi[sz]e\b|\bcount\b|\btabulate\b/i

/** Difficulty markers that raise a task above its intent's effort floor. */
const HARD_HINTS = /\bconcurren|\brace condition\b|\bdeadlock\b|\bdistributed\b|\bdata loss\b|\bsecurity\b|\bcrypt|\bmigration across\b|\bwhole (?:\w+ )?(?:codebase|repo|system)\b|\barchitecture\b|\bcross-cutting\b|\bsubtle\b|\bgnarly\b|\btricky\b|\bperformance-critical\b|\bfrom scratch\b|\bredesign\b|\bprove\b|\bformal verification\b/i

/** Difficulty markers that lower a task below its intent's effort floor. */
const EASY_HINTS = /\bone[- ]line\b|\bsingle file\b|\btrivial\b|\bsimple\b|\bquick\b|\bjust (?:\w+ )?(?:rename|confirm|check)\b|\blookup\b|\bone command\b|\bno code\b/i

/**
 * Count non-overlapping matches of every pattern against the text.
 * @param {readonly RegExp[]} patterns - patterns to count, all global.
 * @param {string} text - haystack.
 * @returns {number} total matches.
 */
function countMatches(patterns, text) {
  let total = 0
  for (const pattern of patterns) {
    const matches = text.match(pattern)
    if (matches !== null) total += matches.length
  }
  return total
}

/** Phrase hints, ordered so that ties resolve toward the more specific intent. */
const PHRASE_HINTS = Object.freeze([
  ['debugging', DEBUGGING_HINTS],
  ['mechanical', MECHANICAL_HINTS],
  ['review', REVIEW_HINTS],
  ['planning', PLANNING_HINTS],
  ['writing', WRITING_HINTS],
  ['research', RESEARCH_HINTS],
  ['analysis', ANALYSIS_HINTS],
  ['coding', CODING_HINTS],
])

/**
 * Tie-break order, most specific intent first.
 *
 * A task that says "rename the util" scores on both `mechanical` and `coding`,
 * because "rename" is mechanical and "util" reads as code. The specific reading
 * is the better one: naming the exact transformation is stronger evidence than
 * naming the noun it applies to. `coding` is last for the mirror reason — its
 * verbs ("add", "change", "build") appear inside almost every other intent's
 * tasks, so it wins only when nothing more specific matched.
 */
const TIE_ORDER = Object.freeze(['mechanical', 'debugging', 'review', 'planning', 'writing', 'analysis', 'research', 'coding'])

/**
 * Normalize text for matching: collapse whitespace, and keep case so that
 * proper nouns and identifiers survive, since the patterns are case-insensitive.
 * @param {unknown} value - candidate text.
 * @returns {string} the normalized text, or an empty string.
 */
function normalize(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

/**
 * Classify one delegated task into the intent its work actually needs.
 *
 * A delegation prompt usually names both the goal and the action, so every hint
 * family is scored and the highest one wins. `mechanical` and `debugging`
 * outrank a bare `coding` match at equal counts because their wording is more
 * specific; a lone "implement" is weak evidence and scoring already reflects
 * that by counting phrase frequencies instead of first-match.
 *
 * @param {string} task - the child's task text (its first user message).
 * @param {{ titles?: readonly string[], description?: string }} [hints] - extra
 *   routing text from the delegation call, such as its short description.
 * @returns {{ intent: string, score: number, scores: Record<string, number>, difficulty: 'easy'|'normal'|'hard' }}
 *   the winning intent, its score, every intent's score, and the difficulty read.
 */
/**
 * How much more a hint counts when it appears in the task's opening instruction
 * than anywhere else.
 *
 * A delegation prompt is usually one imperative sentence followed by context,
 * file lists, or review criteria. The imperative is what the child is being
 * asked to do; the rest is material, and it is full of incidental trigger words
 * ("report", "error", "fix") that describe the subject rather than the work. A
 * flat count let a long context paragraph outvote the instruction, so the
 * opening sentence is worth several times a later mention.
 */
const OPENING_WEIGHT = 3

/**
 * Split a task into its opening instruction and the remaining material.
 * The opening is the first sentence, which for a terse delegation is the whole
 * prompt, and for a long one is the imperative before the context block.
 * @param {string} body - normalized task text.
 * @returns {{ opening: string, rest: string }} the two regions.
 */
function splitOpening(body) {
  // A newline is the strongest boundary (prompts are usually one line of
  // instruction then a block), and a sentence end is the next.
  const boundary = body.search(/[.!?](?:\s|$)|\n/)
  if (boundary < 0) return { opening: body, rest: '' }
  return { opening: body.slice(0, boundary + 1), rest: body.slice(boundary + 1) }
}

export function classifyTask(task, hints = {}) {
  const description = normalize(hints.description)
  const titles = Array.isArray(hints.titles) ? hints.titles.map(normalize).join(' ') : ''
  const body = normalize(task)
  const { opening, rest } = splitOpening(body)

  const scores = Object.fromEntries(INTENT_IDS.map(id => [id, 0]))
  for (const [intent, pattern] of PHRASE_HINTS) {
    const probe = new RegExp(pattern.source, 'gi')
    scores[intent] += countMatches([probe], opening) * OPENING_WEIGHT
    scores[intent] += countMatches([probe], rest)
    scores[intent] += countMatches([probe], description) + countMatches([probe], titles)
  }

  const hard = countMatches([new RegExp(HARD_HINTS.source, 'gi')], body)
  const easy = countMatches([new RegExp(EASY_HINTS.source, 'gi')], body)
  const difficulty = hard > easy ? 'hard' : easy > hard ? 'easy' : 'normal'
  // Difficulty shifts the *choice between intents* too: a hard task is more
  // likely planning or debugging work even when its verbs read as plain coding.
  if (difficulty === 'hard') {
    scores.planning += 1
    scores.debugging += 1
    scores.mechanical = 0
  }
  if (difficulty === 'easy') scores.mechanical += 1

  let intent = 'coding'
  let score = 0
  for (const id of TIE_ORDER) {
    if (scores[id] > score) {
      score = scores[id]
      intent = id
    }
  }
  return { intent, score, scores, difficulty }
}

/**
 * Map a pstack role name onto an intent.
 * @param {unknown} role - a role line name from `/setup-pstack`.
 * @returns {string | undefined} the intent id, or undefined for an unknown role.
 */
export function intentForRole(role) {
  if (typeof role !== 'string') return undefined
  const key = role.trim().toLowerCase()
  return ROLE_INTENTS[key]
}

/**
 * Resolve the reasoning effort this task should ask for, from the pstack budget
 * the user chose plus this task's intent and difficulty.
 *
 * pstack's `budget` sets a base effort for every role, then the mode skill raises
 * it a step for the hardest work and lowers it for routine work. The same shape
 * applies here: `unlimited`/`large`/`medium`/`small` name the base, the intent
 * shifts it, and difficulty shifts it once more. The result is a request, not a
 * promise; {@link chooseEffort} snaps it onto the efforts the route advertises.
 *
 * @param {string} intent - intent id.
 * @param {'easy'|'normal'|'hard'} difficulty - difficulty read.
 * @param {string} budget - one of `unlimited`, `large`, `medium`, `small`.
 * @returns {string} a ladder member.
 */
export function effortFloor(intent, difficulty, budget = 'large') {
  const base = BUDGET_BASE[budget] ?? BUDGET_BASE.large
  const baseIndex = EFFORT_LADDER.indexOf(base)
  const shift = (INTENT_OFFSET[intent] ?? 0)
    + (difficulty === 'hard' ? 1 : difficulty === 'easy' ? -1 : 0)
  // `low` is the floor for a delegated child. Going lower saves little and a
  // routing decision that lands on `off` would defeat delegating at all, so the
  // mechanical offset under the `small` budget stops here instead.
  const lowest = EFFORT_LADDER.indexOf('low')
  const clamped = Math.min(EFFORT_LADDER.length - 1, Math.max(lowest, baseIndex + shift))
  return EFFORT_LADDER[clamped]
}

/**
 * Describe one candidate model's traits from its id and display name.
 * @param {{ id?: string, model?: string, name?: string, description?: string }} model - catalogue entry.
 * @returns {Set<string>} trait labels.
 */
export function modelTraits(model) {
  const haystack = `${model?.id ?? model?.model ?? ''} ${model?.name ?? ''} ${model?.description ?? ''}`
  const traits = new Set()
  for (const [pattern, trait] of MODEL_TRAITS) {
    const probe = new RegExp(pattern.source, pattern.flags.includes('i') ? 'i' : '')
    if (probe.test(haystack)) traits.add(trait)
  }
  return traits
}

/**
 * Collapse a model's traits into exactly one class.
 *
 * Every ranking decision is made on this class, so a name that matches several
 * weak patterns cannot outrank a name that matches the one pattern that matters.
 * An unrecognized model is `balanced`, which sits between the two extremes and
 * loses no reputation it never earned.
 *
 * @param {{ id?: string, model?: string, name?: string, description?: string }} model - catalogue entry.
 * @returns {'strong'|'balanced'|'fast'} the class this model competes in.
 */
function modelClass(model) {
  const traits = modelTraits(model)
  if (traits.has('strong')) return 'strong'
  if (traits.has('fast')) return 'fast'
  return 'balanced'
}

/**
 * Score one candidate model for an intent, highest first when sorted.
 *
 * The class score dominates; the tiebreakers only separate models of the same
 * class, so a cheap model can never win review work by having many cheap-model
 * traits.
 *
 * Traits are a guess about a model from its name, which is weaker evidence than
 * a pinned role. That is why a pin always wins (see `router.js`) and why a tie
 * falls back to catalogue order, which reflects the user's own provider order.
 *
 * @param {{ id: string, name?: string, description?: string }} model - catalogue entry.
 * @param {string} intent - intent id.
 * @param {{ contextWindow?: number }} [info] - resolved per-model info, when available.
 * @returns {number} a score; only its order is meaningful.
 */
export function scoreModel(model, intent, info = {}) {
  const fit = CLASS_FIT[intent] ?? CLASS_FIT.coding
  const tiebreak = INTENT_TIEBREAK[intent] ?? INTENT_TIEBREAK.coding
  const traits = modelTraits(model)
  let score = fit[modelClass(model)] ?? 0
  for (const [trait, weight] of Object.entries(tiebreak)) {
    if (traits.has(trait)) score += weight
  }
  const window = info?.contextWindow
  // An advertised context window is the only factual capacity signal available,
  // so it counts where a large window genuinely matters.
  if (typeof window === 'number' && window >= 500_000 && intent !== 'mechanical') score += 1
  return score
}

/**
 * Pick the reasoning effort for one route out of the efforts that adapter
 * actually advertises, so an unsupported effort is never sent.
 *
 * pstack's own setup rule decides the mapping: "use the same family's detected
 * slug with the highest effort at or below the target". Sending the deepest
 * level a model happens to have would silently spend more than the budget asked
 * for, on a level the user never chose; only when a model tops out *below* the
 * target does its highest level win, because a weaker model thinking at its
 * maximum is still the best that route can offer.
 *
 * @param {readonly { id: string }[] | undefined} efforts - advertised efforts, in adapter order.
 * @param {string} floor - the effort this task asks for.
 * @param {string | undefined} defaultEffort - the adapter's own default.
 * @returns {string | undefined} a supported effort, or undefined for no preference.
 */
export function chooseEffort(efforts, floor, defaultEffort) {
  if (!Array.isArray(efforts) || efforts.length === 0) return undefined
  const ids = efforts.map(effort => effort?.id).filter(id => typeof id === 'string' && id !== 'off')
  if (ids.length === 0) return undefined
  const floorIndex = EFFORT_LADDER.indexOf(floor)
  const atOrBelow = ids
    .filter(id => EFFORT_LADDER.indexOf(id) <= floorIndex && EFFORT_LADDER.indexOf(id) >= 0)
    .sort((a, b) => EFFORT_LADDER.indexOf(b) - EFFORT_LADDER.indexOf(a))
  if (atOrBelow.length > 0) return atOrBelow[0]
  // Every advertised effort sits above the target, so the shallowest one is the
  // closest this route can come to the budget.
  const above = ids
    .map(id => EFFORT_LADDER.indexOf(id))
    .filter(index => index >= 0)
    .sort((a, b) => a - b)
  if (above.length > 0) return EFFORT_LADDER[above[0]]
  return typeof defaultEffort === 'string' ? defaultEffort : undefined
}
