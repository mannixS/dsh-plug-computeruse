import test from 'node:test'
import assert from 'node:assert/strict'
import { directoryFrom, installHooks, TOOL_NAME } from '../src/hooks.js'
import { createScreenshotJanitor } from '../src/screenshots.js'

/** Minimal context that records installed listeners. */
function fakeContext({ failOn = [] } = {}) {
  const listeners = new Map()
  return {
    listeners,
    ctx: {
      on(event, handler) {
        if (failOn.includes(event)) throw new Error(`no ${event}`)
        listeners.set(event, handler)
        return () => listeners.delete(event)
      },
    },
  }
}

const JANITOR = () => createScreenshotJanitor({ retentionMs: 1000 })

test('registers approval and turn hooks', () => {
  const { ctx, listeners } = fakeContext()
  installHooks(ctx, { approvalOf: () => 'mutations', janitor: JANITOR() })
  assert.equal(typeof listeners.get('tools/pre-execute'), 'function')
  assert.equal(typeof listeners.get('agent/turn-stopping'), 'function')
  assert.equal(typeof listeners.get('turn/start'), 'function')
})

test('approval never prompts for non-call actions', async () => {
  const { ctx, listeners } = fakeContext()
  installHooks(ctx, { approvalOf: () => 'mutations', janitor: JANITOR() })
  const pre = listeners.get('tools/pre-execute')
  const allow = async () => ({ kind: 'allow' })
  // `describe` mentions a mutating tool name but only reads its schema.
  for (const action of ['describe', 'status', 'list_tools']) {
    const decision = await pre(
      { name: TOOL_NAME, arguments: { action, name: 'click', arguments: {} } },
      allow,
    )
    assert.equal(decision.kind, 'allow', action)
  }
  // `call` still asks.
  const call = await pre({ name: TOOL_NAME, arguments: { action: 'call', name: 'click', arguments: {} } }, allow)
  assert.equal(call.kind, 'ask')
})

test('newly classified read-only tools do not prompt', async () => {
  const { ctx, listeners } = fakeContext()
  installHooks(ctx, { approvalOf: () => 'mutations', janitor: JANITOR() })
  const pre = listeners.get('tools/pre-execute')
  for (const name of ['get_config', 'check_permissions', 'get_guide', 'health_report']) {
    const decision = await pre({ name: TOOL_NAME, arguments: { action: 'call', name } }, async () => ({ kind: 'allow' }))
    assert.equal(decision.kind, 'allow', name)
  }
})

test('approval asks only for mutating cua_driver calls', async () => {
  const { ctx, listeners } = fakeContext()
  installHooks(ctx, { approvalOf: () => 'mutations', janitor: JANITOR() })
  const pre = listeners.get('tools/pre-execute')
  const allow = async () => ({ kind: 'allow' })

  const mutating = await pre({ name: TOOL_NAME, arguments: { name: 'click', arguments: { x: 1, y: 2 } } }, allow)
  assert.equal(mutating.kind, 'ask')
  assert.match(mutating.displayReason.en, /click on the desktop/)
  assert.match(mutating.displayReason.zh, /允许/)

  const readOnly = await pre({ name: TOOL_NAME, arguments: { name: 'list_apps' } }, allow)
  assert.equal(readOnly.kind, 'allow')

  const foreign = await pre({ name: 'bash', arguments: { command: 'ls' } }, allow)
  assert.equal(foreign.kind, 'allow')
})

test('approval none never asks', async () => {
  const { ctx, listeners } = fakeContext()
  installHooks(ctx, { approvalOf: () => 'none', janitor: JANITOR() })
  const decision = await listeners.get('tools/pre-execute')(
    { name: TOOL_NAME, arguments: { name: 'type_text', arguments: { text: 'hi' } } },
    async () => ({ kind: 'allow' }),
  )
  assert.equal(decision.kind, 'allow')
})

test('approval all asks even for read-only calls', async () => {
  const { ctx, listeners } = fakeContext()
  installHooks(ctx, { approvalOf: () => 'all', janitor: JANITOR() })
  const decision = await listeners.get('tools/pre-execute')(
    { name: TOOL_NAME, arguments: { name: 'get_window_state' } },
    async () => ({ kind: 'allow' }),
  )
  assert.equal(decision.kind, 'ask')
})

test('a sibling policy denial is preserved', async () => {
  const { ctx, listeners } = fakeContext()
  installHooks(ctx, { approvalOf: () => 'mutations', janitor: JANITOR() })
  const decision = await listeners.get('tools/pre-execute')(
    { name: TOOL_NAME, arguments: { name: 'click', arguments: { x: 1, y: 1 } } },
    async () => ({ kind: 'deny', reason: 'blocked by policy' }),
  )
  assert.equal(decision.kind, 'deny')
  assert.equal(decision.reason, 'blocked by policy')
})

test('a throwing sibling policy still rejects', async () => {
  const { ctx, listeners } = fakeContext()
  installHooks(ctx, { approvalOf: () => 'mutations', janitor: JANITOR() })
  await assert.rejects(
    listeners.get('tools/pre-execute')({ name: TOOL_NAME, arguments: { name: 'click' } }, async () => { throw new Error('upstream failed') }),
    /upstream failed/,
  )
})

test('turn events clear the session screenshot directory', async t => {
  const { mkdtemp, readdir, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { saveScreenshot, screenshotDirectory } = await import('../src/screenshots.js')
  const base = await mkdtemp(join(tmpdir(), 'dsh-cua-hooks-'))
  t.after(() => rm(base, { recursive: true, force: true }))

  const { ctx, listeners } = fakeContext()
  installHooks(ctx, { approvalOf: () => 'mutations', janitor: JANITOR(), resolveDirectory: () => base })
  await saveScreenshot(base, {
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    mimeType: 'image/png',
  })
  assert.equal((await readdir(screenshotDirectory(base))).length, 1)

  listeners.get('agent/turn-stopping')({ agent: { session: {} } })
  // Cleanup is intentionally fire-and-forget.
  for (let attempt = 0; attempt < 40; attempt++) {
    const remaining = await readdir(screenshotDirectory(base)).catch(() => [])
    if (remaining.length === 0) break
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.equal((await readdir(screenshotDirectory(base)).catch(() => [])).length, 0)
})

test('unavailable events do not prevent the rest from installing', () => {
  const { ctx, listeners } = fakeContext({ failOn: ['agent/turn-stopping'] })
  const warnings = []
  installHooks(ctx, { approvalOf: () => 'mutations', janitor: JANITOR(), logger: { warn: message => warnings.push(message) } })
  assert.equal(typeof listeners.get('tools/pre-execute'), 'function')
  assert.equal(typeof listeners.get('turn/start'), 'function')
  assert.equal(listeners.get('agent/turn-stopping'), undefined)
  assert.match(warnings.join('\n'), /turn cleanup hook unavailable/)
})

test('disposer removes every installed listener', () => {
  const { ctx, listeners } = fakeContext()
  const dispose = installHooks(ctx, { approvalOf: () => 'mutations', janitor: JANITOR() })
  dispose()
  assert.equal(listeners.size, 0)
})

test('resolves a directory from the event payload shapes', () => {
  const resolveDirectory = session => (session?.id === 'known' ? '/tmp/session' : undefined)
  assert.equal(directoryFrom({ agent: { session: { id: 'known' } } }, resolveDirectory), '/tmp/session')
  assert.equal(directoryFrom({ session: { id: 'known' } }, resolveDirectory), '/tmp/session')
  assert.equal(directoryFrom({ agent: { session: { id: 'other' } } }, resolveDirectory), undefined)
  assert.equal(directoryFrom(undefined, resolveDirectory), undefined)
  assert.equal(directoryFrom({}, undefined), undefined)
})
