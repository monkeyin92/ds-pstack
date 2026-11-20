import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { appendPluginRecord, sessionLog, sessionModel } from './session-fixture.js'

const router = await import(process.env.PSTACK_ROUTER_TEST_PATH
  ? pathToFileURL(process.env.PSTACK_ROUTER_TEST_PATH).href
  : '../lib/router.js')

function runtime(initialPool = [{ provider: 'local', model: 'worker' }]) {
  const listeners = new Map()
  const original = { provider: 'local', model: 'inherited' }
  let allowed = initialPool
  const parent = { options: original }
  const session = sessionLog({ origin: 'subagent', parentSession: 'parent', delegationDepth: 1 })
  const agent = {
    id: 'child', options: original,
    session, model: sessionModel(session, original),
  }
  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) {
      return {
        agents: new Map([['parent', parent], [agent.id, agent]]),
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
  const loopRequests = new WeakSet()
  const mount = () => (router.mountRouter ?? router.apply)(
    ctx, { budget: 'medium', rolesPath: '', logPath: '' }, appendPluginRecord, request => loopRequests.has(request),
  )
  let dispose = mount()
  return {
    agent, dispose() { dispose() }, remount() { dispose(); dispose = mount() },
    async create() { for (const callback of listeners.get('agent/created') ?? []) await callback({ agent }) },
    claim(message = { role: 'user', content: [{ type: 'text', text: 'Implement a new endpoint' }] }) {
      for (const callback of listeners.get('agent/inbox/claimed') ?? []) callback({ agent, message })
    },
    toolResult() { for (const callback of listeners.get('tools/result') ?? []) callback({ agent }, {}) },
    async step(text = 'Implement a new endpoint', afterPrepare = () => {}, beforeDispatch = () => {}, duringAssembly = () => {}) {
      const messages = text === null ? [] : [{ role: 'user', content: [{ type: 'text', text }] }]
      for (const message of messages) this.claim(message)
      const prepared = agent.model.current()
      duringAssembly()
      await waterfall('agent/pre-step', { agent, messages, modelSelection: prepared }, { kind: 'enter', messages })
      afterPrepare()
      const proposed = await waterfall('agent/request', { agent }, prepared)
      assert.deepEqual(proposed, prepared, 'request hook must not change the prepared model selection')
      beforeDispatch()
      const request = { ...proposed, sessionId: agent.id }
      loopRequests.add(request)
      return waterfall('llm/stream', request, proposed)
    },
    async error(failure, signal) { return await waterfall('agent/request-error', { agent, provider: 'local', failure, signal }, undefined) },
    uncheck() { allowed = [] },
    directStream(config) { return waterfall('llm/stream', { ...config, sessionId: agent.id }, config) },
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

test('refuses a routed request revoked after preparation rather than changing its frozen selection', async () => {
  const r = runtime()
  await r.create()
  await assert.rejects(r.step('Implement a new endpoint', r.uncheck), /unchecked/i)
  assert.deepEqual(await r.step(), r.agent.options)
  r.dispose()
})

test('a manual switch for the next step does not authorize a revoked prepared request', async () => {
  const r = runtime()
  await r.create()
  const manual = { provider: 'local', model: 'manual' }
  await assert.rejects(r.step('Implement a new endpoint', () => {
    r.uncheck()
    r.agent.model.select(manual)
  }), /unchecked/i)
  assert.deepEqual(await r.step(), manual)
  r.dispose()
})

test('a revocation during adapter preparation prevents the adapter stream from starting', async () => {
  const r = runtime()
  await r.create()
  await assert.rejects(r.step('Implement a new endpoint', undefined, r.uncheck), /unchecked/i)
  const direct = { provider: 'local', model: 'worker' }
  assert.deepEqual(await r.directStream(direct), direct)
  assert.deepEqual(await r.step(), r.agent.options)
  r.dispose()
})

test('a remount restores the inherited selection when the routed model is unchecked', async () => {
  const r = runtime()
  await r.create()
  assert.equal((await r.step()).model, 'worker')
  r.remount()
  r.uncheck()
  assert.deepEqual(await r.step(), r.agent.options)
  r.dispose()
})

test('a remount during tools keeps a still-checked selection on an empty-inbox continuation', async () => {
  const r = runtime()
  await r.create()
  const selected = await r.step()
  r.remount()
  r.toolResult()
  assert.deepEqual(await r.step(null), selected)
  r.uncheck()
  r.toolResult()
  assert.deepEqual(await r.step(null), r.agent.options)
  r.dispose()
})

test('multiple manual switches during tool assembly cannot authorize the frozen routed request', async () => {
  const r = runtime()
  await r.create()
  const manual = { provider: 'local', model: 'manual' }
  await assert.rejects(r.step('Implement a new endpoint', undefined, undefined, () => {
    r.uncheck()
    r.agent.model.select(r.agent.options)
    r.agent.model.select(manual)
  }), /unchecked/i)
  assert.deepEqual(await r.step(), manual)
  r.dispose()
})

test('a remount preserves a user selection instead of reclaiming it for the checked pool', async () => {
  const r = runtime()
  await r.create()
  assert.equal((await r.step()).model, 'worker')
  r.remount()
  const manual = { provider: 'other', model: 'explicit', reasoningEffort: 'low' }
  r.agent.model.select(manual)
  await r.refresh()
  assert.deepEqual(await r.step(), manual)
  r.uncheck()
  assert.deepEqual(await r.step(), manual)
  r.dispose()
})

test('manual changes away and back to the same model supersede the router ownership on replay', async () => {
  const r = runtime()
  await r.create()
  const chosen = await r.step()
  r.agent.model.select(r.agent.options)
  r.agent.model.select(chosen)
  r.remount()
  r.uncheck()
  assert.deepEqual(await r.step(), chosen)
  r.dispose()
})

test('the first claim uses a model checked after an empty creation preload', async () => {
  const r = runtime([])
  await r.create()
  r.check('newly-checked')
  assert.deepEqual(await r.step(), { provider: 'local', model: 'newly-checked' })
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
