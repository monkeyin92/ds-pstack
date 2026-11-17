import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const { apply } = await import(process.env.PSTACK_ROUTER_TEST_PATH
  ? pathToFileURL(process.env.PSTACK_ROUTER_TEST_PATH).href
  : '../lib/router.js')

function runtime(initialPool = [{ provider: 'local', model: 'worker' }]) {
  const listeners = new Map()
  const original = { provider: 'local', model: 'inherited' }
  let selection = { ...original }
  let allowed = initialPool
  const parent = { options: original }
  const agent = {
    id: 'child', options: original,
    session: { header: { origin: 'subagent', parentSession: 'parent', delegationDepth: 1 } },
    model: { current: () => ({ ...selection }), select: value => { selection = { ...value } } },
  }
  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) {
      return {
        agents: { get: () => parent },
        subagentModelSelection: { current: () => ({ enabled: true, allowedModels: allowed }) },
        llm: { resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'medium' }, { id: 'high' }], defaultEffort: 'medium' } }) },
      }[name]
    },
    on(event, callback) {
      const list = listeners.get(event) ?? []
      list.push(callback)
      listeners.set(event, list)
      return () => list.splice(list.indexOf(callback), 1)
    },
  }
  async function waterfall(event, payload, base) {
    const list = listeners.get(event) ?? []
    let index = 0
    const next = () => list[index++]?.(payload, next) ?? base
    return await next()
  }
  const dispose = apply(ctx, { budget: 'medium', rolesPath: '', logPath: '' })
  return {
    agent, dispose,
    async create() { for (const callback of listeners.get('agent/created') ?? []) await callback({ agent }) },
    claim(message = { role: 'user', content: [{ type: 'text', text: 'Implement a new endpoint' }] }) {
      for (const callback of listeners.get('agent/inbox/claimed') ?? []) callback({ agent, message })
    },
    async step(text = 'Implement a new endpoint') {
      const message = { role: 'user', content: [{ type: 'text', text }] }
      for (const callback of listeners.get('agent/inbox/claimed') ?? []) callback({ agent, message })
      const prepared = agent.model.current()
      await waterfall('agent/pre-step', { agent, messages: [message] }, { kind: 'enter', messages: [message] })
      const proposed = await waterfall('agent/request', { agent }, prepared)
      assert.deepEqual(proposed, prepared, 'request hook must not change the prepared model selection')
      return prepared
    },
    async error(failure, signal) { return await waterfall('agent/request-error', { agent, provider: 'local', failure, signal }, undefined) },
    uncheck() { allowed = [] },
    check(model) { allowed = [{ provider: 'local', model }] },
    async refresh() { await waterfall('agent/pre-step', { agent, messages: [] }, { kind: 'enter', messages: [] }) },
  }
}

test('claim tolerates missing or incomplete model selection without changing the inherited route', async () => {
  for (const model of [undefined, {}, { current: () => ({}) }, { current: true, select() {} }, { current() {}, select: true }]) {
    const r = runtime()
    await r.create()
    const inherited = { ...r.agent.options }
    r.agent.model = model
    assert.doesNotThrow(() => r.claim())
    assert.deepEqual(r.agent.options, inherited)
    assert.equal(r.agent.model, model)
    r.dispose()
  }
})

test('claim swallows task extraction and model selection errors', async () => {
  for (const stage of ['task', 'current', 'select']) {
    const r = runtime()
    await r.create()
    const inherited = r.agent.model.current()
    const fail = () => { throw new Error(`${stage} failed`) }
    const message = { role: 'user', get content() { return fail() } }
    if (stage !== 'task') r.agent.model[stage] = fail
    assert.doesNotThrow(() => stage === 'task' ? r.claim(message) : r.claim())
    if (stage !== 'current') assert.deepEqual(r.agent.model.current(), inherited)
    r.dispose()
  }
})

test('creation and claim swallow scope inspection errors', async () => {
  const r = runtime()
  Object.defineProperty(r.agent, 'session', { get() { throw new Error('session unavailable') } })
  await assert.doesNotReject(() => r.create())
  assert.doesNotThrow(() => r.claim())
  r.dispose()
})

test('selects high before DSH snapshots its first step and keeps it on follow-up', async () => {
  const r = runtime()
  await r.create()
  assert.deepEqual(await r.step(), { provider: 'local', model: 'worker', reasoningEffort: 'high' })
  assert.deepEqual(await r.step('Report the result'), { provider: 'local', model: 'worker', reasoningEffort: 'high' })
  r.dispose()
})

test('does not treat cancellation as a failed route', async () => {
  const r = runtime()
  await r.create()
  await r.step()
  const controller = new AbortController()
  controller.abort()
  assert.equal(await r.error({ code: 'AUTH', status: 401 }, controller.signal), undefined)
  assert.equal((await r.step()).reasoningEffort, 'high')
  r.dispose()
})

test('unchecking the pool removes the previously routed effort', async () => {
  const r = runtime()
  await r.create()
  await r.step()
  r.uncheck()
  assert.deepEqual(await r.step(), { provider: 'local', model: 'inherited' })
  r.dispose()
})

test('auth errors propagate instead of rerouting an already prepared request', async () => {
  const r = runtime()
  await r.create()
  await r.step()
  assert.equal(await r.error({ code: 'AUTH', status: 401 }), undefined)
  assert.deepEqual(await r.step(), { provider: 'local', model: 'inherited' })
  r.uncheck()
  assert.deepEqual(await r.step(), { provider: 'local', model: 'inherited' })
  r.dispose()
})

test('an existing child sees models checked after creation', async () => {
  const r = runtime([])
  await r.create()
  assert.deepEqual(await r.step(), { provider: 'local', model: 'inherited' })
  r.check('worker')
  await r.refresh()
  assert.deepEqual(await r.step(), { provider: 'local', model: 'worker', reasoningEffort: 'high' })
  r.check('replacement')
  await r.refresh()
  assert.deepEqual(await r.step(), { provider: 'local', model: 'replacement', reasoningEffort: 'high' })
  r.dispose()
})
