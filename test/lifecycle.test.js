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
