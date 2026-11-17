/**
 * Live integration check for scope, approval, cleanup and focus.
 *
 * Uses a Cordis-like context that throws on undeclared bare service reads, so a
 * missing `inject` entry fails here instead of in production. Only the
 * calculator and read-only driver calls are used; no chat window is touched.
 *
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & $env:DSH_NODE_EXECUTABLE test/integration-live.mjs
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../index.js'

const base = await mkdtemp(join(tmpdir(), 'dsh-cua-live-'))

/**
 * Build a context that mimics Cordis service injection: reading an undeclared
 * service as a bare property throws, `ctx.get()` returns undefined instead.
 */
function cordisContext({ workingDirectory }) {
  const services = {
    workingDirectory,
    llm: undefined,
    attachments: undefined,
  }
  const listeners = new Map()
  const effects = []
  const target = {
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    on(event, handler) { listeners.set(event, handler); return () => listeners.delete(event) },
    effect(factory) { const dispose = factory(); effects.push(dispose); return dispose },
    logger: { warn: message => console.log(`  [warn] ${message}`) },
  }
  const proxy = new Proxy(target, {
    get(object, property) {
      if (property in object) return object[property]
      if (property === 'get') return name => services[name]
      if (property in services && services[property] !== undefined) {
        if (!plugin.inject.includes(property)) {
          throw new Error(`cannot get property "${String(property)}" without inject`)
        }
        return services[property]
      }
      return undefined
    },
  })
  return { ctx: proxy, listeners, effects }
}

/** Register the plugin and return its captured tool definition. */
function register(config) {
  let tool
  const { ctx, listeners } = cordisContext({
    workingDirectory: { get: () => base },
  })
  const original = ctx.tools.register
  ctx.tools.register = definition => { tool = definition; return original(definition) }
  plugin.apply(ctx, config)
  return { tool, listeners }
}

const exec = () => ({ signal: new AbortController().signal, agent: { session: { requestHeader: () => ({ config: {} }) }, options: {} } })
const call = (tool, args) => tool.execute(args, exec())

try {
  // 1. desktop scope and status
  console.log('=== 1. desktop scope + status ===')
  const desktop = register({ timeoutMs: 120000 })
  const status = await call(desktop.tool, { action: 'status' })
  console.log(status.text)
  for (const field of ['Scope:', 'Approval:', 'Focus cursor:', 'Screenshot retention:']) {
    if (!status.text.includes(field)) throw new Error(`status missing ${field}`)
  }

  // 2. whole-desktop capture works when scope allows it
  console.log('\n=== 2. desktop capture ===')
  try {
    const deskShot = await call(desktop.tool, { action: 'call', name: 'get_desktop_state' })
    console.log('get_desktop_state imageCount =', deskShot.imageCount)
    if (deskShot.imageCount < 1) throw new Error('desktop scope should capture the screen')
  } catch (error) {
    // A locked workstation is a property of the machine, not of the plugin:
    // Windows refuses screen access on the lock screen. Report it as skipped so
    // an unattended run does not read as a code failure.
    if (/PC is locked|lock screen/i.test(String(error?.message ?? error))) {
      console.log('SKIPPED: the PC is locked, so no screen capture is possible.')
      console.log('Unlock the machine and rerun to exercise the capture paths.')
      console.log('\nOK (capture steps skipped while locked)')
      process.exit(0)
    }
    throw error
  }

  // 3. approval classification
  console.log('\n=== 3. approval ===')
  const pre = desktop.listeners.get('tools/pre-execute')
  const allow = async () => ({ kind: 'allow' })
  const cases = [
    [{ action: 'call', name: 'list_apps', arguments: {} }, 'allow'],
    [{ action: 'call', name: 'get_desktop_state', arguments: {} }, 'allow'],
    [{ action: 'describe', name: 'click', arguments: {} }, 'allow'],
    [{ action: 'status' }, 'allow'],
    [{ action: 'list_tools' }, 'allow'],
    [{ action: 'call', name: 'click', arguments: { x: 1, y: 1 } }, 'ask'],
    [{ action: 'call', name: 'type_text', arguments: { text: 'hi' } }, 'ask'],
  ]
  for (const [args, expected] of cases) {
    const decision = await pre({ name: 'cua_driver', arguments: args }, allow)
    console.log(`  ${args.action}/${args.name ?? '-'} -> ${decision.kind}`)
    if (decision.kind !== expected) throw new Error(`${args.action}/${args.name} should be ${expected}`)
  }
  const zh = (await pre({ name: 'cua_driver', arguments: { action: 'call', name: 'click', arguments: { x: 1, y: 1 } } }, allow)).displayReason.zh
  console.log('  zh prompt:', zh)

  // 4. window scope
  console.log('\n=== 4. window scope (calculator) ===')
  const pinned = register({ scope: 'window', app: { name: 'CalculatorApp.exe' } })
  const pinnedStatus = await call(pinned.tool, { action: 'status' })
  console.log(pinnedStatus.text.split('\n').find(line => line.startsWith('Scope')))

  let refusedDesktop = false
  try {
    await call(pinned.tool, { action: 'call', name: 'get_desktop_state' })
  } catch (error) {
    refusedDesktop = /scope is "window"/.test(error.message)
    console.log('  get_desktop_state refused')
  }
  if (!refusedDesktop) throw new Error('window scope must refuse whole-desktop capture')

  const scoped = await call(pinned.tool, {
    action: 'call',
    name: 'get_window_state',
    arguments: { include_accessibility_tree: false, include_screenshot: true },
  })
  console.log('  pinned get_window_state imageCount =', scoped.imageCount, '| text tail:', scoped.text.split('\n').pop())
  if (scoped.imageCount < 1) throw new Error('window scope should capture the pinned app')
  if (!scoped.text.includes('[scope: window')) throw new Error('window scope should label the result')

  let refusedOther = false
  try {
    await call(pinned.tool, { action: 'call', name: 'get_window_state', arguments: { pid: 16588, window_id: 132226 } })
  } catch (error) {
    refusedOther = /out of scope/.test(error.message)
    console.log('  other app refused')
  }
  if (!refusedOther) throw new Error('window scope must refuse another app')

  // 5. screenshots land in the session directory
  console.log('\n=== 5. screenshot cleanup ===')
  const before = await readdir(join(base, '.dsh-cua')).catch(() => [])
  console.log('  screenshots on disk:', before.length)
  if (before.length === 0) throw new Error('expected fallback screenshots in the session directory')

  // 6. turn-stopping clears them
  const turnEndpoint = desktop.listeners.get('agent/turn-stopping')
  if (turnEndpoint === undefined) throw new Error('agent/turn-stopping hook was not registered')
  turnEndpoint({ agent: { session: {} } })
  let cleared = false
  for (let attempt = 0; attempt < 60; attempt++) {
    const remaining = await readdir(join(base, '.dsh-cua')).catch(() => [])
    if (remaining.length === 0) { cleared = true; break }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  console.log('  cleared at turn end:', cleared)
  if (!cleared) throw new Error('turn-stopping did not clear screenshots')

  console.log('\nOK')
} finally {
  await rm(base, { recursive: true, force: true })
}
