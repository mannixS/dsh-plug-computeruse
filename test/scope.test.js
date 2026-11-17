import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createScopeGate, describeMutation, isMutating, needsApproval, parseApproval, parseScope, targetOf,
} from '../src/scope.js'

const WXWORK = { pid: 75396, windowId: 16458664, appName: 'WXWork.exe', title: '企业微信' }
const NOTEPAD = { pid: 1234, windowId: 999, appName: 'notepad.exe', title: '无标题 - 记事本' }

/** Window registry stub for the gate. */
const registry = windows => async ({ pid, windowId, match }) => {
  if (match !== undefined) {
    const byName = windows.filter(match)
    if (byName.length > 0) return pid === undefined ? byName[0] : byName.find(window => window.pid === pid) ?? byName[0]
    return undefined
  }
  return windows.find(window => window.pid === pid && (windowId === undefined || window.windowId === windowId))
}

test('desktop scope passes calls through untouched', async () => {
  const gate = createScopeGate('desktop', undefined, registry([WXWORK]))
  const args = { x: 1, y: 2 }
  assert.equal(await gate('click', args, registry([WXWORK])), args)
  const desktopArgs = { max_image_dimension: 800 }
  assert.equal(await gate('get_desktop_state', desktopArgs, registry([WXWORK])), desktopArgs)
})

test('window scope refuses whole-desktop capture with guidance', async () => {
  const gate = createScopeGate('window', { pid: 75396, label: 'WXWork.exe' }, registry([WXWORK]))
  await assert.rejects(gate('get_desktop_state', {}, registry([WXWORK])), /scope is "window".*get_desktop_state/s)
  await assert.rejects(gate('get_screen_size', {}, registry([WXWORK])), /scope is "window"/)
})

test('window scope refuses an explicit desktop target', async () => {
  const gate = createScopeGate('window', { pid: 75396, label: 'WXWork.exe' }, registry([WXWORK]))
  await assert.rejects(
    gate('click', { target: { kind: 'desktop' }, x: 1, y: 1 }, registry([WXWORK])),
    /desktop target is not available/,
  )
})

test('window scope pins the configured app when no target is given', async () => {
  const gate = createScopeGate('window', { pid: 75396, label: 'WXWork.exe' }, registry([WXWORK]))
  const args = await gate('click', { x: 10, y: 20 }, registry([WXWORK]))
  assert.deepEqual(args.target, { kind: 'window', pid: 75396, window_id: 16458664 })
  assert.equal(args.window_id, 16458664)
  assert.equal(args.pid, 75396)
})

test('window scope reports flat ids that point at another app', async () => {
  const gate = createScopeGate('window', { pid: 75396, label: 'WXWork.exe' }, registry([WXWORK, NOTEPAD]))
  await assert.rejects(
    gate('get_window_state', { pid: 1234, window_id: 999, include_screenshot: true }, registry([WXWORK, NOTEPAD])),
    /out of scope/,
  )
})

test('window scope rewrites flat ids of the pinned app consistently', async () => {
  const gate = createScopeGate('window', { pid: 75396, label: 'WXWork.exe' }, registry([WXWORK, NOTEPAD]))
  const args = await gate('get_window_state', { pid: 75396, window_id: 16458664 }, registry([WXWORK, NOTEPAD]))
  assert.equal(args.pid, 75396)
  assert.equal(args.window_id, 16458664)
})

test('get_window_state is bound with flat ids, never a target', async () => {
  const gate = createScopeGate('window', { pid: 75396, label: 'WXWork.exe' }, registry([WXWORK]))
  const args = await gate('get_window_state', { include_screenshot: true }, registry([WXWORK]))
  assert.equal(args.target, undefined)
  assert.equal(args.pid, 75396)
  assert.equal(args.window_id, 16458664)
  assert.equal(args.include_screenshot, true)
})

test('a target object on get_window_state is rewritten to flat ids', async () => {
  const gate = createScopeGate('window', { pid: 75396, label: 'WXWork.exe' }, registry([WXWORK]))
  const args = await gate('get_window_state', {
    target: { kind: 'window', pid: 75396, window_id: 16458664 },
    include_screenshot: false,
  }, registry([WXWORK]))
  assert.equal(args.target, undefined)
  assert.equal(args.pid, 75396)
  assert.equal(args.window_id, 16458664)
})

test('window scope rejects a window outside the pinned app', async () => {
  const gate = createScopeGate('window', { pid: 75396, label: 'WXWork.exe' }, registry([WXWORK, NOTEPAD]))
  await assert.rejects(
    gate('click', { target: { kind: 'window', pid: 1234, window_id: 999 }, x: 1, y: 1 }, registry([WXWORK, NOTEPAD])),
    /out of scope/,
  )
})

test('window scope allows a window of the pinned app', async () => {
  const gate = createScopeGate('window', { pid: 75396, label: 'WXWork.exe' }, registry([WXWORK]))
  const args = { target: { kind: 'window', pid: 75396, window_id: 16458664 }, x: 1, y: 1 }
  assert.deepEqual(await gate('click', args, registry([WXWORK])), args)
})

test('window scope reports a vanished window', async () => {
  const gate = createScopeGate('window', { pid: 75396, label: 'WXWork.exe' }, registry([]))
  await assert.rejects(
    gate('click', { target: { kind: 'window', pid: 75396, window_id: 16458664 }, x: 1, y: 1 }, registry([])),
    /no longer exists/,
  )
})

test('window scope without a pinned app resolves nothing and explains why', async () => {
  const gate = createScopeGate('window', undefined, registry([WXWORK]))
  await assert.rejects(
    gate('click', { x: 1, y: 1 }, registry([WXWORK])),
    /no window of the pinned app .* could be resolved/,
  )
})

test('window scope matches a restarted app by executable name', async () => {
  // Configured by name only: a new pid after an app restart must stay in scope.
  const gate = createScopeGate('window', { name: 'WXWork.exe', label: 'WXWork.exe' }, registry([WXWORK]))
  const restarted = { pid: 99999, windowId: 555, appName: 'WXWork.exe', title: '企业微信' }
  const args = { target: { kind: 'window', pid: 99999, window_id: 555 }, x: 1, y: 1 }
  assert.deepEqual(await gate('click', args, registry([restarted])), args)
})

test('window scope tolerates a configured name without the .exe suffix', async () => {
  const gate = createScopeGate('window', { name: 'WXWork' }, registry([WXWORK]))
  const args = { target: { kind: 'window', pid: 75396, window_id: 16458664 }, x: 1, y: 1 }
  assert.deepEqual(await gate('click', args, registry([WXWORK])), args)
})

test('classifies read-only and mutating tools', () => {
  for (const name of ['list_apps', 'get_window_state', 'get_desktop_state', 'verify_state', 'clipboard_read']) {
    assert.equal(isMutating(name), false, name)
  }
  for (const name of ['click', 'type_text', 'press_key', 'hotkey', 'drag', 'launch_app', 'clipboard_write']) {
    assert.equal(isMutating(name), true, name)
  }
})

test('approval modes gate the right calls', () => {
  assert.equal(needsApproval('mutations', 'click'), true)
  assert.equal(needsApproval('mutations', 'list_apps'), false)
  assert.equal(needsApproval('all', 'list_apps'), true)
  assert.equal(needsApproval('none', 'click'), false)
})

test('parses scope and approval with defaults', () => {
  assert.equal(parseScope(undefined), 'desktop')
  assert.equal(parseScope('window'), 'window')
  assert.throws(() => parseScope('everything'), /scope must be/)
  assert.equal(parseApproval(undefined), 'mutations')
  assert.equal(parseApproval('none'), 'none')
  assert.throws(() => parseApproval('sometimes'), /approval must be/)
})

test('extracts a window target from either casing', () => {
  assert.deepEqual(targetOf({ target: { kind: 'window', pid: 1, window_id: 2 } }), { kind: 'window', pid: 1, windowId: 2 })
  assert.deepEqual(targetOf({ target: { kind: 'window', pid: 1, windowId: 2 } }), { kind: 'window', pid: 1, windowId: 2 })
  assert.deepEqual(targetOf({ target: { kind: 'desktop' } }), { kind: 'desktop' })
  assert.equal(targetOf({}), undefined)
})

test('describes a mutation for the approval prompt', () => {
  const text = describeMutation('type_text', {
    target: { kind: 'window', pid: 75396, window_id: 16458664 },
    text: '你好',
  })
  assert.match(text, /type_text on window 16458664 of pid 75396/)
  assert.match(text, /你好/)
  assert.match(describeMutation('click', { x: 5, y: 6 }), /the desktop.*\(at \(5, 6\)\)/)
  assert.match(describeMutation('launch_app', { app_name: 'notepad.exe' }), /app notepad\.exe/)
})
