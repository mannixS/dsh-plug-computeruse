/**
 * Cua Driver computer-use plugin.
 *
 * The plugin carries the Cua Driver core itself: it loads the official
 * `@trycua/cua-driver` package inside the DSH process and drives the desktop
 * through its in-process runtime, so no separate `cua-driver` install is
 * required.
 *
 * Four policies wrap the driver:
 *   - scope:   `window` pins every call to one app and refuses whole-desktop
 *              capture, so screenshots only ever show that app;
 *   - approval: state-changing calls can require the user's confirmation
 *              through DSH's own approval flow;
 *   - screenshots: captured images are returned to the model and pruned on a
 *              timer and at turn end;
 *   - focus:   the driver's per-session agent cursor marks where the model is
 *              working.
 *
 * All configuration fields are `.volatile()`, so the settings page writes them
 * in place and every call reads the current values rather than the ones
 * captured at activation.
 *
 * @module dsh-plug-computeruse
 */
import { createBackend, IN_PROCESS_TOOLS, loadSdk, normalizeResult } from './src/backend.js'
import { Config } from './src/config.js'
import { installHooks } from './src/hooks.js'
import { projectImages } from './src/images.js'
import { checkInstallation } from './src/preflight.js'
import { createScreenshotJanitor } from './src/screenshots.js'
import { createScopeGate, needsApproval, parseApproval, parseScope } from './src/scope.js'
import { unwrapVolatile, unwrapVolatileDeep } from './src/volatile.js'

export const name = 'dsh-cua'

/** Services this plugin needs; it stays inactive without them. */
export const inject = ['tools', 'systemPrompt']

/** Configuration schema, so the Loader validates rows and the page can edit. */
export { Config }

const ACTIONS = ['call', 'describe', 'status', 'list_tools']

const DESCRIPTION = `Operate a Windows, macOS or Linux desktop through the Cua Driver components bundled with this plugin: read UI state, take screenshots, find apps and windows, and perform pointer, keyboard and accessibility actions. No separate driver installation is needed. Prefer get_window_state for one app and get_desktop_state for the whole display. Actions change apps and user data, so confirm destructive or externally consequential steps with the user first. A returned action does not prove the UI changed: read a fresh snapshot or verify_state afterward. After a timeout or cancellation, check state before retrying and never blindly repeat an uncertain action. Use describe when the exact arguments are unknown. Operating-system permissions (macOS Accessibility and Screen Recording, Windows interactive session, Linux display access) still have to be granted by the user.`

const PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ACTIONS,
      description: 'call: run a Cua Driver tool; describe: fetch its argument schema; status: report the bundled runtime, scope and approval policy; list_tools: list every available tool name.',
    },
    name: {
      type: 'string',
      description: 'Cua Driver tool name, such as list_apps, list_windows, get_window_state, get_desktop_state, click, type_text, press_key, hotkey, scroll, drag, verify_state. Required for call and describe.',
    },
    arguments: {
      type: 'object',
      additionalProperties: true,
      description: 'Arguments matching that Cua Driver tool, using its documented snake_case keys (pid, window_id, element_token, include_accessibility_tree, include_screenshot, delivery_mode, target, session). get_desktop_state always includes a screenshot and accepts only max_image_dimension and screenshot_out_file; get_window_state controls its screenshot with include_screenshot. Window x/y are pixels of the latest screenshot of that window. Repeat one session label throughout a task; re-snapshot before acting again and never reuse element tokens after another snapshot. Keep delivery_mode "background" unless a verified failure requires "foreground". Use describe when unsure.',
    },
    session: {
      type: 'string',
      description: 'Cua session label applied to this call when arguments omit one. Reuse the same value across a task; it also identifies the visible agent cursor.',
    },
  },
  required: ['action'],
}

/**
 * Normalize a raw row config into the values this plugin uses.
 *
 * The settings page and the patch both deliver ordinary values, so validation
 * happens here rather than relying on schema coercion alone; an unusable value
 * becomes a clear activation error instead of a runtime surprise.
 */
export function resolveConfig(rawConfig = {}) {
  const source = unwrapVolatileDeep(rawConfig) ?? {}
  const resolved = {
    timeoutMs: source.timeoutMs ?? 120000,
    allowTools: source.allowTools ?? [],
    session: source.session ?? 'dsh-cua',
    maxImageDimension: source.maxImageDimension,
    scope: parseScope(source.scope),
    approval: parseApproval(source.approval),
    app: source.app,
    screenshotRetentionMs: source.screenshotRetentionMs ?? 15 * 60 * 1000,
    screenshotSweepMs: source.screenshotSweepMs ?? 60000,
    showFocusCursor: source.showFocusCursor ?? true,
  }
  if (!Number.isFinite(resolved.timeoutMs) || resolved.timeoutMs < 1000 || resolved.timeoutMs > 900000) {
    throw new Error('dsh-cua: timeoutMs must be a number between 1000 and 900000')
  }
  if (!Array.isArray(resolved.allowTools) || resolved.allowTools.some(entry => typeof entry !== 'string')) {
    throw new Error('dsh-cua: allowTools must be an array of tool names')
  }
  if (resolved.maxImageDimension !== undefined
    && (!Number.isInteger(resolved.maxImageDimension) || resolved.maxImageDimension < 0)) {
    throw new Error('dsh-cua: maxImageDimension must be a non-negative integer')
  }
  if (!Number.isFinite(resolved.screenshotRetentionMs) || resolved.screenshotRetentionMs < 0) {
    throw new Error('dsh-cua: screenshotRetentionMs must be zero or a positive number')
  }
  if (!Number.isFinite(resolved.screenshotSweepMs) || resolved.screenshotSweepMs < 0) {
    throw new Error('dsh-cua: screenshotSweepMs must be zero or a positive number')
  }
  if (resolved.scope === 'window') {
    if (typeof resolved.app !== 'object' || resolved.app === null) {
      throw new Error('dsh-cua: scope "window" needs an "app" object, for example {name: "WXWork.exe"}.')
    }
    if (resolved.app.pid === undefined && typeof resolved.app.name !== 'string' && typeof resolved.app.title !== 'string') {
      throw new Error('dsh-cua: scope "window" needs "app.pid" or "app.name".')
    }
  }
  return resolved
}

/** Validate model arguments before any desktop work starts. */
function validateArgs(args) {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error('invalid arguments: expected an object')
  }
  if (!ACTIONS.includes(args.action)) {
    throw new Error(`invalid arguments: action must be one of ${ACTIONS.join(', ')}`)
  }
  if (args.name !== undefined && typeof args.name !== 'string') {
    throw new Error('invalid arguments: name must be a string')
  }
  if (args.arguments !== undefined && (typeof args.arguments !== 'object' || args.arguments === null || Array.isArray(args.arguments))) {
    throw new Error('invalid arguments: arguments must be an object')
  }
  if (args.session !== undefined && (typeof args.session !== 'string' || args.session.trim() === '')) {
    throw new Error('invalid arguments: session must be a non-empty string')
  }
}

export function apply(ctx, rawConfig = {}) {
  // Fail loudly at activation on an unusable configured row.
  resolveConfig(rawConfig)

  /**
   * Check that the bundled dependencies resolve, and explain a broken install
   * in terms the user can act on.
   *
   * A stale nested `node_modules` makes Node fail with a bare EPERM naming a
   * long path; this turns that into the folder to delete. The check is
   * deliberately non-fatal: `apply` returns, the tool still registers, and the
   * first call reports the same message, so a repair never requires guessing.
   */
  let installFailure
  void checkInstallation()
    .then(result => {
      if (!result.ok) {
        installFailure = result.message
        ctx.logger?.error?.(result.message)
      }
    })
    .catch(() => {
      // A failed check must not break activation.
    })

  const requireHealthyInstall = () => {
    if (installFailure !== undefined) throw new Error(installFailure)
  }

  /**
   * The settings namespace the Host actually serves this row under.
   *
   * `SettingsForms.describe()` keys every namespace by the Loader entry id,
   * which a profile patch may mount as `include:dsh-cua`, not by the plugin
   * name. Reading it from the owning fiber is what makes the page address the
   * right row instead of falling back to default values.
   */
  const settingsNamespace = (() => {
    const id = ctx?.fiber?.entry?.options?.id
    return typeof id === 'string' && id !== '' ? id : 'dsh-cua'
  })()

  /**
   * Read the configuration that applies right now.
   *
   * Volatile fields stay live, so a settings write is picked up by the next
   * call without restarting the plugin. `Config` itself is not re-run here
   * because the Loader has already coerced the stored row.
   */
  const live = () => {
    const source = typeof rawConfig === 'object' && rawConfig !== null ? rawConfig : {}
    const snapshot = {}
    for (const key of Object.keys(source)) snapshot[key] = unwrapVolatile(source[key])
    return resolveConfig(snapshot)
  }
  /** The raw row config for cleanup policies that are not live. */
  const initial = resolveConfig(rawConfig)
  /** Execution-prepared rich content, applied only when the canonical result survives policy. */
  const pendingContent = new WeakMap()

  const backend = createBackend(async () => {
    const loaded = await loadSdk()
    if (loaded.error !== undefined) throw loaded.error
    return loaded.module
  })

  const janitor = createScreenshotJanitor({
    defaultBase: process.cwd(),
    retentionMs: initial.screenshotRetentionMs,
    intervalMs: initial.screenshotSweepMs,
  })

  /** Resolve window facts through the driver, used by the scope gate. */
  const describeWindow = async ({ pid, windowId, match } = {}) => {
    try {
      const result = await backend.call('list_windows', pid === undefined ? {} : { pid })
      const data = normalizeResult(result, 'list_windows').structured
      const windows = Array.isArray(data?.windows) ? data.windows : []
      const normalized = windows.map(window => ({
        pid: window.pid,
        windowId: window.window_id ?? window.windowId,
        appName: window.app_name ?? window.appName,
        title: window.title,
        minimized: window.minimized,
        onScreen: window.is_on_screen ?? window.isOnScreen,
      }))
      if (match !== undefined) return normalized.find(match)
      return normalized.find(window => window.pid === pid && (windowId === undefined || window.windowId === windowId))
    } catch {
      return undefined
    }
  }

  /** Track the agent cursor for a session so the model's focus is visible. */
  const sessionsWithCursor = new Set()
  const ensureCursor = async (config, session) => {
    if (!config.showFocusCursor || sessionsWithCursor.has(session)) return
    sessionsWithCursor.add(session)
    try {
      await backend.call('set_agent_cursor_enabled', { session, enabled: true })
    } catch {
      // A platform without overlay support must not fail the desktop call.
      sessionsWithCursor.delete(session)
    }
  }

  const definition = {
    name: 'cua_driver',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          imageCount: { type: 'integer' },
        },
        required: ['text', 'imageCount'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.imageCount > 0 ? `${value.text}\n\n[${value.imageCount} screenshot(s) attached]` : value.text,
      }],
    },
    presentCall(args) {
      const title = args?.action === 'call' && typeof args.name === 'string'
        ? `Cua Driver · ${args.name}`
        : `Cua Driver · ${args?.action ?? 'call'}`
      return { card: 'generic', title, kind: 'execute', rawInput: JSON.stringify(args ?? {}, null, 2) }
    },
    projectContent(exec, result) {
      const content = pendingContent.get(exec)
      if (content === undefined || result.isError) return undefined
      pendingContent.delete(exec)
      return content
    },
    async execute(args, exec) {
      validateArgs(args)
      // Every call reads the current configuration, so a settings write applies
      // to the next call without restarting the plugin.
      const config = live()

      if (args.action === 'status') {
        const runtime = await backend.describe()
        const metadata = runtime.metadata ?? {}
        const lines = [
          `Bundled Cua Driver: ${metadata.driverVersion ?? 'unknown'}`,
          `Contract: ${metadata.contractVersion ?? 'unknown'}`,
          `Runtime: in-process (${metadata.embedded === true ? 'embedded' : 'external'})`,
          `Platform: ${process.platform} ${process.arch}`,
          `Scope: ${config.scope}${config.scope === 'window' ? ` (pinned to ${config.app?.name ?? config.app?.pid})` : ' (whole desktop)'}`,
          `Approval: ${config.approval}`,
          `Focus cursor: ${config.showFocusCursor ? 'on' : 'off'}`,
          `Screenshot retention: ${config.screenshotRetentionMs === 0 ? 'until turn end' : `${Math.round(config.screenshotRetentionMs / 1000)}s`}`,
        ]
        if (installFailure !== undefined) {
          lines.push('', 'Installation problem:', installFailure)
        } else {
          lines.push('Installation: dependencies resolve')
        }
        return { text: lines.join('\n'), imageCount: 0 }
      }
      if (args.action === 'list_tools') {
        requireHealthyInstall()
        const runtimeTools = await backend.listRuntimeTools()
        const names = runtimeTools !== undefined && runtimeTools.length > 0 ? runtimeTools : IN_PROCESS_TOOLS
        return {
          text: `Cua Driver tools available in process:\n${names.join('\n')}\n\nUse describe to read one tool's exact argument schema.`,
          imageCount: 0,
        }
      }

      if (typeof args.name !== 'string' || args.name.trim() === '') {
        throw new Error(`The "name" parameter is required for ${args.action}.`)
      }
      if (config.allowTools.length > 0 && !config.allowTools.includes(args.name)) {
        throw new Error(`Cua Driver tool "${args.name}" is not in this plugin's allowTools configuration.`)
      }

      if (args.action === 'describe') {
        const described = await backend.describeTool(args.name)
        const scopeNote = config.scope === 'window'
          ? `\n\nScope: this instance is pinned to ${config.app?.name ?? config.app?.pid}; whole-desktop capture is refused and every call targets that app's window.`
          : '\n\nScope: this instance may drive the whole desktop.'
        return { text: `${described}${scopeNote}`, imageCount: 0 }
      }

      // A broken install must not reach the driver: the failure would surface as
      // an unexplained EPERM instead of the repair instructions.
      requireHealthyInstall()

      const session = args.session ?? config.session
      let callArguments = { ...(args.arguments ?? {}) }
      if (session !== undefined && callArguments.session === undefined) callArguments.session = session
      if (config.maxImageDimension !== undefined && callArguments.max_image_dimension === undefined) {
        callArguments.max_image_dimension = config.maxImageDimension
      }

      // Scope enforcement runs before any driver work, and is rebuilt per call
      // so a changed `scope`/`app` takes effect immediately.
      const scopeGate = createScopeGate(config.scope, config.app, describeWindow)
      callArguments = await scopeGate(args.name, callArguments, describeWindow)
      // Window-scoped calls carry the pinned identity; a per-call session must
      // survive the enforcement rewrite.
      if (callArguments.session === undefined && session !== undefined) callArguments.session = session

      await ensureCursor(config, callArguments.session ?? config.session)

      const result = await backend.call(args.name, callArguments, { signal: exec.signal, timeoutMs: config.timeoutMs })
      const normalized = normalizeResult(result, args.name)
      if (normalized.isError) {
        throw new Error(normalized.text || `Cua Driver tool "${args.name}" failed.`)
      }

      let text = normalized.text
      if (args.name === 'get_window_state' && callArguments.session === undefined) {
        text += '\n\nFor follow-up window coordinates or element tokens, repeat this call with a session label and reuse that session for later actions.'
      }
      if (config.scope === 'window') {
        text += `\n\n[scope: window "${config.app?.name ?? config.app?.pid}" — whole-desktop capture is disabled for this instance]`
      }

      const content = [{ type: 'text', text }]
      const base = sessionDirectory(ctx, exec)
      janitor.track(base)
      if (normalized.images.length > 0) {
        content.push(...await projectImages(ctx, exec, normalized.images, base))
      }
      pendingContent.set(exec, content)
      // Old screenshots never outlive the call that produced them.
      void janitor.prune(base).catch(() => {})
      return { text, imageCount: normalized.images.length }
    },
  }

  ctx.tools.register(definition)

  // Approval gate and turn cleanup. Both read the live approval mode, so
  // changing it in settings applies to the next call.
  installHooks(ctx, {
    approvalOf: () => live().approval,
    needsApproval,
    janitor,
    logger: ctx.logger,
    resolveDirectory: session => workingDirectoryOf(ctx, session),
  })

  ctx.effect(() => {
    const stopSweep = janitor.start()
    return () => {
      stopSweep()
      void backend.shutdown().catch(() => {})
    }
  })

  // Publish the namespace the Host serves this row under, so the settings page
  // in the browser addresses the right entry instead of guessing a name. A
  // profile may mount the row as `include:dsh-cua`, and the settings service
  // keys its namespaces by that exact Loader entry id.
  ctx.effect(() => {
    const onInject = table => {
      table.push({ kind: 'global', name: '__DSH_CUA_SETTINGS_NS__', value: settingsNamespace })
    }
    try {
      return ctx.on('webserver/index-inject', onInject)
    } catch {
      // A profile without the Web server simply never renders an index.
      return () => {}
    }
  })

  ctx.systemPrompt.section({
    name: 'tool:cua-driver',
    order: 1100,
    interpolate: false,
    text: 'Use cua_driver for desktop computer-use tasks; the driver is bundled and needs no separate install. Discover the app and window, read a fresh state, act, then verify with a new read. Never reuse element tokens from an earlier snapshot or assume a returned action changed the UI. Respect target-desktop permissions and confirm destructive or externally consequential actions with the user.',
  })
}

/**
 * Read the session working directory without depending on Cordis injection.
 *
 * `ctx.workingDirectory` throws `cannot get property "workingDirectory" without
 * inject` when the service is not listed in this plugin's `inject`. The desktop
 * call has already happened by the time cleanup runs, so a throw here would
 * report a completed action as failed. Reading through `ctx.get()` keeps the
 * service optional and never fails a call.
 * @param ctx - plugin context.
 * @param session - session whose directory is wanted.
 * @returns the directory, or undefined when unavailable.
 */
function workingDirectoryOf(ctx, session) {
  if (session === undefined || session === null) return undefined
  try {
    const directory = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
    if (directory === undefined || typeof directory.get !== 'function') return undefined
    const value = directory.get(session)
    return typeof value === 'string' && value !== '' ? value : undefined
  } catch {
    return undefined
  }
}

/** Session working directory for screenshot placement, or the process directory. */
function sessionDirectory(ctx, exec) {
  return workingDirectoryOf(ctx, exec?.agent?.session) ?? process.cwd()
}