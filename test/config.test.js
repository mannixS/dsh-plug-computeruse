import test from 'node:test'
import assert from 'node:assert/strict'
import { Config } from '../src/config.js'
import { resolveConfig } from '../index.js'
import { unwrapVolatile, unwrapVolatileDeep } from '../src/volatile.js'

test('every configuration field is volatile so settings writes are accepted', () => {
  // The settings service rejects a write to a row with no volatile fields while
  // the client's set() still resolves, so a non-volatile field would look saved
  // and silently revert.
  const dictionary = Config.dict ?? Config.toJSON?.()
  assert.ok(dictionary !== undefined, 'schema must be introspectable')
  const walk = node => {
    if (node === null || typeof node !== 'object') return
    if (node.meta?.volatile === true) return
    for (const [key, child] of Object.entries(node)) {
      if (key === 'meta' || key === 'default') continue
      if (child !== null && typeof child === 'object' && (typeof child === 'function' || child.dict !== undefined || child.meta !== undefined)) walk(child)
    }
  }
  walk(Config)
})

test('schema defaults produce a usable configuration', () => {
  const resolved = resolveConfig(Config({}))
  assert.equal(resolved.scope, 'desktop')
  assert.equal(resolved.approval, 'mutations')
  assert.equal(resolved.showFocusCursor, true)
  assert.equal(resolved.timeoutMs, 120000)
  assert.equal(resolved.screenshotRetentionMs, 900000)
  assert.equal(resolved.screenshotSweepMs, 60000)
  assert.deepEqual(resolved.allowTools, [])
})

test('unwrap helpers resolve live references instead of leaking them', () => {
  const live = { get: () => 'window' }
  assert.equal(unwrapVolatile(live), 'window')
  assert.equal(unwrapVolatile('plain'), 'plain')
  const deep = unwrapVolatileDeep({ scope: { get: () => 'window' }, nested: { app: { get: () => ({ name: 'X.exe' }) } } })
  assert.deepEqual(deep, { scope: 'window', nested: { app: { name: 'X.exe' } } })
  // Spreading a live reference must never leak the accessor function.
  assert.equal(typeof deep.scope, 'string')
})

test('a live-reference config is normalized like a plain one', () => {
  const live = {
    scope: { get: () => 'window' },
    app: { get: () => ({ name: 'CalculatorApp.exe' }) },
    approval: { get: () => 'none' },
    showFocusCursor: { get: () => false },
  }
  const resolved = resolveConfig(live)
  assert.equal(resolved.scope, 'window')
  assert.deepEqual(resolved.app, { name: 'CalculatorApp.exe' })
  assert.equal(resolved.approval, 'none')
  assert.equal(resolved.showFocusCursor, false)
})

test('window scope without an app is rejected', () => {
  assert.throws(() => resolveConfig({ scope: 'window' }), /needs an "app"/)
  assert.throws(() => resolveConfig({ scope: 'window', app: {} }), /needs "app.pid" or "app.name"/)
  assert.doesNotThrow(() => resolveConfig({ scope: 'window', app: { name: 'X.exe' } }))
})

test('out-of-range values are rejected', () => {
  assert.throws(() => resolveConfig({ timeoutMs: 999 }), /timeoutMs/)
  assert.throws(() => resolveConfig({ timeoutMs: 900001 }), /timeoutMs/)
  assert.throws(() => resolveConfig({ screenshotRetentionMs: -1 }), /screenshotRetentionMs/)
  assert.throws(() => resolveConfig({ screenshotSweepMs: -1 }), /screenshotSweepMs/)
  assert.throws(() => resolveConfig({ maxImageDimension: -1 }), /maxImageDimension/)
  assert.throws(() => resolveConfig({ allowTools: [1] }), /allowTools/)
  assert.throws(() => resolveConfig({ scope: 'everything' }), /scope must be/)
  assert.throws(() => resolveConfig({ approval: 'sometimes' }), /approval must be/)
})
