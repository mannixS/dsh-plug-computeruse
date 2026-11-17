/**
 * Control scope and approval policy.
 *
 * Scope decides *which* desktop surfaces a call may touch and is enforced
 * before any driver work starts:
 *   - `window`   — only the windows of one pinned app; screenshots come from
 *                  `get_window_state` and whole-desktop capture is refused.
 *   - `desktop`  — the whole display, as Cua Driver normally behaves.
 *
 * Approval decides *whether* a state-changing call may proceed. Read-only
 * calls never prompt; mutating calls do when the policy asks for it.
 *
 * @module @local/dsh-cua/scope
 */

/** Tools that only observe; they never change app or desktop state. */
export const READ_ONLY_TOOLS = new Set([
  'list_apps',
  'list_windows',
  'get_window_state',
  'get_desktop_state',
  'get_screen_size',
  'get_cursor_position',
  'get_session',
  'list_sessions',
  'verify_state',
  'clipboard_read',
  'parse_visual_regions',
  'get_agent_cursor_state',
  'get_config',
  'check_permissions',
  'get_guide',
  'health_report',
  'list_tools',
  'describe',
  'zoom',
])

/** Tools that capture the whole display. */
export const DESKTOP_SCOPE_TOOLS = new Set(['get_desktop_state', 'get_screen_size'])

/** Tools that take `pid` + `window_id` instead of a `target` object. */
export const WINDOW_ID_TOOLS = new Set(['get_window_state'])

/**
 * Bind a window identity onto call arguments in the shape that tool expects.
 * `get_window_state` takes flat `pid`/`window_id`; action tools take `target`.
 * @param name - tool name.
 * @param args - original arguments.
 * @param window - `{ pid, windowId }`.
 */
export function bindWindow(name, args, window) {
  const bound = { ...args, pid: window.pid, window_id: window.windowId }
  delete bound.windowId
  if (WINDOW_ID_TOOLS.has(name)) {
    // This tool rejects a per-call target, so the flat ids must replace it.
    delete bound.target
  } else {
    bound.target = { kind: 'window', pid: window.pid, window_id: window.windowId }
  }
  return bound
}

/** Whether one tool changes desktop or application state. */
export function isMutating(name) {
  return !READ_ONLY_TOOLS.has(name)
}

/**
 * Normalize the requested scope.
 * @param value - `desktop` or `window`.
 * @returns the scope, or throws for an unknown value.
 */
export function parseScope(value) {
  if (value === undefined) return 'desktop'
  if (value === 'desktop' || value === 'window') return value
  throw new Error(`dsh-cua: scope must be "desktop" or "window", received ${JSON.stringify(value)}`)
}

/** Normalize the approval mode. */
export function parseApproval(value) {
  if (value === undefined) return 'mutations'
  if (value === 'mutations' || value === 'all' || value === 'none') return value
  throw new Error(`dsh-cua: approval must be "mutations", "all" or "none", received ${JSON.stringify(value)}`)
}

/** Extract the target window identity from a call's arguments. */
export function targetOf(args) {
  const target = args?.target
  if (target !== undefined && target !== null && typeof target === 'object') {
    if (target.kind === 'window') {
      return { kind: 'window', pid: target.pid, windowId: target.window_id ?? target.windowId }
    }
    if (target.kind === 'desktop') return { kind: 'desktop' }
  }
  return undefined
}

/**
 * Build the window predicate for a pinned app.
 *
 * Matching prefers the resolved pid, and falls back to the configured app name
 * so a restarted app (new pid, same executable) stays in scope. An empty pin
 * matches nothing rather than everything.
 * @param app - pinned app `{ pid?, name?, label? }`.
 * @returns predicate over `{ pid, appName, title }`.
 */
export function windowMatcher(app) {
  const pid = app?.pid
  const name = app?.name ?? (app?.label !== undefined && !/^\d+$/.test(app.label) ? app.label : undefined)
  const wantedName = typeof name === 'string' ? name.trim().toLowerCase() : undefined
  return window => {
    if (pid !== undefined && window.pid === pid) return true
    if (wantedName === undefined || wantedName === '') return false
    const actual = String(window.appName ?? '').trim().toLowerCase()
    if (actual === wantedName) return true
    // Tolerate a configured name without the executable suffix, and back.
    const stripExtension = value => value.replace(/\.exe$/, '')
    return stripExtension(actual) === stripExtension(wantedName)
  }
}

/**
 * Build the scope gate for one plugin instance.
 * @param scope - `window` or `desktop`.
 * @param app - pinned app `{ pid?, name?, label? }` when scope is `window`.
 * @param isAllowedWindow - async predicate over `{ pid, windowId, appName, title }`.
 */
export function createScopeGate(scope, app, isAllowedWindow) {
  const matchesPinnedApp = windowMatcher(app)
  const pinLabel = app?.label ?? app?.name ?? app?.pid
  /**
   * @param name - tool name being called.
   * @param args - its arguments.
   * @param describeWindow - async lookup of window facts by `{ pid, windowId }`.
   * @returns normalized call arguments, with an injected `target` when needed.
   */
  return async function enforce(name, args, describeWindow) {
    if (scope !== 'window') return args

    if (DESKTOP_SCOPE_TOOLS.has(name)) {
      throw new Error(
        `dsh-cua: scope is "window", so ${name} is not available. `
        + 'Use get_window_state on the pinned app instead, or set scope to "desktop" in the plugin configuration.',
      )
    }

    const target = targetOf(args)
    if (target?.kind === 'desktop') {
      throw new Error(
        'dsh-cua: scope is "window", so a desktop target is not available. '
        + 'Pass a window target ({kind:"window",pid,window_id}) for the pinned app.',
      )
    }

    let effective = args
    if (target === undefined) {
      // Flat pid/window_id that point outside the pin are a mistake worth
      // reporting: silently rewriting them would show the model a different
      // window than the one it asked for.
      if (args.pid !== undefined || args.window_id !== undefined || args.windowId !== undefined) {
        const named = await describeWindow({ pid: args.pid, windowId: args.window_id ?? args.windowId })
        if (named !== undefined && !matchesPinnedApp(named)) {
          throw new Error(
            `dsh-cua: scope is "window" is pinned to "${pinLabel}", `
            + `so ${named.appName ?? 'that window'} (pid ${named.pid}) is out of scope. `
            + 'Omit pid/window_id to use the pinned app, or set scope to "desktop".',
          )
        }
      }
      // Window-scoped calls must name a window; pin the configured app when the
      // caller did not, so the model cannot silently drift to another app.
      const resolved = await describeWindow({
        pid: app?.pid ?? args.pid,
        windowId: args.window_id ?? args.windowId,
        match: matchesPinnedApp,
      })
      if (resolved === undefined) {
        throw new Error(
          `dsh-cua: scope is "window" but no window of the pinned app "${pinLabel}" could be resolved for ${name}. `
          + 'Pass an explicit window target, or widen the scope.',
        )
      }
      effective = bindWindow(name, args, resolved)
    } else if (WINDOW_ID_TOOLS.has(name)) {
      // The caller used a target object on a tool that wants flat ids.
      effective = bindWindow(name, args, target)
    }

    const windowTarget = targetOf(effective) ?? { kind: 'window', pid: effective.pid, windowId: effective.window_id }
    const window = await describeWindow({ pid: windowTarget.pid, windowId: windowTarget.windowId })
    if (window === undefined) {
      throw new Error(`dsh-cua: scope is "window" but window ${windowTarget.windowId} of pid ${windowTarget.pid} no longer exists.`)
    }
    if (!matchesPinnedApp(window)) {
      throw new Error(
        `dsh-cua: scope is "window" is pinned to "${pinLabel}", `
        + `so ${window.appName ?? 'that window'} (pid ${window.pid}) is out of scope. `
        + 'Switch the pinned app in the plugin configuration, or set scope to "desktop".',
      )
    }
    return effective
  }
}

/**
 * Decide whether a call needs the user's approval under the configured mode.
 * @param mode - `mutations`, `all` or `none`.
 * @param name - tool name.
 */
export function needsApproval(mode, name) {
  if (mode === 'none') return false
  if (mode === 'all') return true
  return isMutating(name)
}

/** Human-readable summary of what a call would do, for the approval prompt. */
export function describeMutation(name, args) {
  const target = targetOf(args)
  const where = target?.kind === 'window' ? `window ${target.windowId} of pid ${target.pid}` : 'the desktop'
  const detail = []
  if (typeof args?.text === 'string') detail.push(`text ${JSON.stringify(args.text.slice(0, 80))}`)
  if (typeof args?.key === 'string') detail.push(`key ${args.key}`)
  if (Array.isArray(args?.keys)) detail.push(`keys ${args.keys.join('+')}`)
  if (typeof args?.x === 'number' && typeof args?.y === 'number') detail.push(`at (${args.x}, ${args.y})`)
  if (typeof args?.app_name === 'string') detail.push(`app ${args.app_name}`)
  if (typeof args?.app === 'string') detail.push(`app ${args.app}`)
  return `${name} on ${where}${detail.length > 0 ? ` (${detail.join(', ')})` : ''}`
}
