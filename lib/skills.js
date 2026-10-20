/**
 * ds-pstack — publish pstack's skills from this bundle.
 *
 * pstack ships its skills as directories of markdown. DeepSeek Harness reads
 * skills through a provider, and this package is its own provider so installing
 * ds-pstack is one step: no copying into `~/.dsh/skills`, no second package.
 *
 * Every skill here declares `disable-model-invocation: true`, which is pstack's
 * own choice. The effect in Harness is the same as in Cursor: the skill stays out
 * of the model's catalog and appears as a `/name` command, so the user decides
 * when a playbook owns the turn. `setup-pstack` omits the flag because a user
 * may want the model to reach for it.
 *
 * A skill body resolves its siblings against the directory reported as its
 * resource base, which is this package's `skills/` directory. That is what makes
 * "read `<pstack>/how/SKILL.md`" work inside a delegate.
 *
 * @module @local/ds-pstack/skills
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Provider name registered on `ctx.skills`. */
const PROVIDER_NAME = 'ds-pstack'

/**
 * Precedence rank. Higher than the local filesystem roots (100 to 500) and equal
 * to a bundled provider (600), so a project or user skill of the same name still
 * wins: pstack's skills must never shadow a project's own `verify-*` skill.
 */
const PROVIDER_RANK = 600

/** The `skills/` directory holding one directory per skill. */
const SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url))

/** Resource base every loaded body resolves relative paths against. */
const RESOURCE_BASE = { kind: 'directory', path: SKILLS_DIR }

/** The kebab-case skill-name grammar the registry enforces. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Parse the subset of YAML frontmatter these skills use: `key: value` scalars,
 * quoted strings, and `>`/`|` block scalars. A full YAML parser would be a
 * dependency for four field shapes, and a malformed skill must not break the
 * catalog, so an unparsable field is dropped rather than thrown.
 *
 * @param {string} source - the whole SKILL.md.
 * @returns {{ frontmatter: Record<string, string>, body: string }} parsed parts.
 */
export function parseFrontmatter(source) {
  const text = typeof source === 'string' ? source : ''
  if (!text.startsWith('---')) return { frontmatter: {}, body: text }
  // The closing delimiter is the first `---` on a line of its own after the
  // opening one. Matching `\n---` instead would also accept a horizontal rule or
  // a YAML block ending in dashes and cut the body in the wrong place.
  const end = text.search(/\n---[ \t]*(?:\r?\n|$)/)
  if (end < 0) return { frontmatter: {}, body: text }
  const head = text.slice(3, end)
  const closing = /\n---[ \t]*(?:\r?\n|$)/.exec(text.slice(end))
  // Drop exactly one blank line: the convention for a body that starts at a
  // heading, while a body written to begin immediately keeps its own spacing.
  const body = text.slice(end + (closing?.[0]?.length ?? 4)).replace(/^\r?\n/, '')
  const frontmatter = {}
  const lines = head.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const match = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line)
    if (match === null) continue
    const [, key, rest] = match
    // A block scalar continues on the following more-indented lines.
    if (rest === '>' || rest === '|' || rest === '>-' || rest === '|-') {
      const collected = []
      while (i + 1 < lines.length && (/^[ \t]+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
        i += 1
        collected.push(lines[i].replace(/^[ \t]+/, ''))
      }
      const folded = rest.startsWith('>')
        ? collected.join(' ').replace(/\s+/g, ' ')
        : collected.join('\n')
      frontmatter[key] = folded.trim()
      continue
    }
    frontmatter[key] = unquote(rest)
  }
  return { frontmatter, body }
}

/**
 * Strip matching surrounding quotes from a scalar.
 * @param {string} value - the raw scalar.
 * @returns {string} the unquoted value.
 */
function unquote(value) {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n')
    }
  }
  return trimmed
}

/**
 * Read a boolean-ish frontmatter value accepted by the registry's grammar.
 * @param {unknown} value - raw field value.
 * @returns {boolean | undefined} the boolean, or undefined when absent/invalid.
 */
function parseBoolean(value) {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  if (['true', 'yes', 'on', '1'].includes(normalized)) return true
  if (['false', 'no', 'off', '0'].includes(normalized)) return false
  return undefined
}

/**
 * Build the catalog entry for one skill directory.
 *
 * A skill whose `name` or `description` is missing or malformed is skipped: the
 * registry drops such a skill with a warning anyway, and dropping it here keeps
 * one bad file from failing the whole catalog observation.
 *
 * @param {string} name - the directory name.
 * @param {string} source - the SKILL.md text.
 * @param {string} path - absolute SKILL.md path.
 * @returns {object | undefined} a candidate, or undefined when unusable.
 */
export function candidateOf(name, source, path) {
  const { frontmatter } = parseFrontmatter(source)
  const declared = typeof frontmatter.name === 'string' && frontmatter.name !== '' ? frontmatter.name : name
  if (!SKILL_NAME.test(declared)) return undefined
  const description = typeof frontmatter.description === 'string' ? frontmatter.description.trim() : ''
  if (description === '') return undefined
  const whenToUse = typeof frontmatter.whenToUse === 'string' && frontmatter.whenToUse.trim() !== ''
    ? frontmatter.whenToUse.trim()
    : undefined
  // pstack marks every playbook and principle `disable-model-invocation: true`.
  // An omitted field permits both surfaces, which is the registry default.
  const modelInvocable = parseBoolean(frontmatter['disable-model-invocation']) === true ? false : true
  const userInvocable = parseBoolean(frontmatter['user-invocable']) === false ? false : true
  return {
    name: declared,
    description,
    ...whenToUse === undefined ? {} : { whenToUse },
    invocation: { modelInvocable, userInvocable },
    source: 'ds-pstack',
    provider: PROVIDER_NAME,
    resourceBase: RESOURCE_BASE,
    rank: PROVIDER_RANK,
    locator: { name: declared, path },
  }
}

/**
 * List every skill directory in this package.
 * @returns {Promise<object[]>} catalog candidates.
 */
async function listSkills() {
  let entries
  try {
    entries = await readdir(SKILLS_DIR, { withFileTypes: true })
  } catch (error) {
    // A package installed without its skills directory is a packaging defect,
    // not a runtime condition: report it rather than serving an empty catalog.
    throw new Error(`ds-pstack: cannot read skill directory ${SKILLS_DIR}: ${String(error?.message ?? error)}`)
  }
  const candidates = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const path = join(SKILLS_DIR, entry.name, 'SKILL.md')
    let source
    try {
      source = await readFile(path, 'utf8')
    } catch {
      continue
    }
    const candidate = candidateOf(entry.name, source, path)
    if (candidate !== undefined) candidates.push(candidate)
  }
  return candidates
}

/** The skill provider registered on `ctx.skills`. */
const provider = {
  name: PROVIDER_NAME,
  async list() {
    return { candidates: await listSkills(), complete: true }
  },
  async get(candidate) {
    const path = candidate?.locator?.path
    if (typeof path !== 'string') return undefined
    const source = await readFile(path, 'utf8')
    const { body } = parseFrontmatter(source)
    return {
      ...candidate,
      content: body,
    }
  },
}

/** Cordis plugin name. */
export const name = 'ds-pstack-skills'
/** The skill registry this provider registers on. */
export const inject = ['skills']

/**
 * Register the bundled provider.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 */
export function apply(ctx) {
  ctx.skills.registerProvider(() => provider)
}
