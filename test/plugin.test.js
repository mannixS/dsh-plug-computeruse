import test from 'node:test'
import assert from 'node:assert/strict'
import * as plugin from '../index.js'

const plugin_apply = plugin.apply

/**
 * Apply the plugin against a context that behaves like Cordis for service
 * access: an undeclared `inject` entry makes a bare property read throw.
 * This is what catches a missing inject declaration, which a plain object
 * context cannot.
 */
function cordisLikeContext({ injected, services = {}, workingDirectory }) {
  const target = { tools: { register: () => () => {} }, systemPrompt: { section: () => () => {} } }
  return new Proxy(target, {
    get(object, property) {
      if (property in object) return object[property]
      if (property === 'get') return name => services[name] ?? (name === 'workingDirectory' ? workingDirectory : undefined)
      if (property === 'on') return () => () => {}
      if (property === 'effect') return () => () => {}
      if (property === 'logger') return { warn() {} }
      if (services[property] !== undefined || property === 'workingDirectory') {
        if (!injected.includes(property)) {
          throw new Error(`cannot get property "${String(property)}" without inject`)
        }
        return property === 'workingDirectory' ? workingDirectory : services[property]
      }
      return undefined
    },
  })
}

test('declares every service it reads through a bare property', () => {
  // Only `tools` and `systemPrompt` are read as bare properties; the working
  // directory must go through ctx.get so a profile without it still works.
  assert.deepEqual([...plugin.inject].sort(), ['systemPrompt', 'tools'])
})

test('applies against a context without workingDirectory', () => {
  const ctx = cordisLikeContext({ injected: plugin.inject })
  assert.doesNotThrow(() => plugin_apply(ctx, { timeoutMs: 120000 }))
})

test('applies when the working directory service is present', () => {
  const ctx = cordisLikeContext({
    injected: plugin.inject,
    workingDirectory: { get: () => '/tmp/session' },
  })
  assert.doesNotThrow(() => plugin_apply(ctx, {}))
})

test('window scope requires an app at activation', () => {
  const ctx = cordisLikeContext({ injected: plugin.inject })
  assert.throws(() => plugin_apply(ctx, { scope: 'window' }), /scope "window" needs an "app"/)
  assert.throws(() => plugin_apply(ctx, { scope: 'window', app: {} }), /needs "app.pid" or "app.name"/)
  assert.doesNotThrow(() => plugin_apply(ctx, { scope: 'window', app: { name: 'CalculatorApp.exe' } }))
})

test('invalid policy values are rejected at activation', () => {
  const ctx = cordisLikeContext({ injected: plugin.inject })
  assert.throws(() => plugin_apply(ctx, { scope: 'everything' }), /scope must be/)
  assert.throws(() => plugin_apply(ctx, { approval: 'sometimes' }), /approval must be/)
  assert.throws(() => plugin_apply(ctx, { screenshotRetentionMs: -1 }), /screenshotRetentionMs/)
  assert.throws(() => plugin_apply(ctx, { screenshotSweepMs: -1 }), /screenshotSweepMs/)
})
