/**
 * In-process Cua Driver backend.
 *
 * Loads the official `@trycua/cua-driver` SDK inside the DSH process, so the
 * plugin carries the driver core and never needs a separately installed
 * `cua-driver` executable. Non-macOS platforms run the in-process Rust runtime;
 * macOS prefers its signed app daemon for permission attribution and falls back
 * to the in-process runtime.
 *
 * Dispatch goes through `callTool(name, json)`, which accepts the documented
 * snake_case tool arguments — the same surface Cua Driver publishes — so this
 * module stays a thin transport instead of re-implementing the typed SDK's
 * camelCase/BigInt translation.
 *
 * @module @local/dsh-cua/backend
 */

/** Tools this build can dispatch, in the order they are listed to the model. */
export const IN_PROCESS_TOOLS = [
  'list_apps',
  'list_windows',
  'get_window_state',
  'get_desktop_state',
  'get_screen_size',
  'get_cursor_position',
  'zoom',
  'click',
  'double_click',
  'right_click',
  'drag',
  'scroll',
  'move_cursor',
  'type_text',
  'press_key',
  'hotkey',
  'set_value',
  'invoke_menu',
  'set_window_frame',
  'verify_state',
  'clipboard_read',
  'clipboard_write',
  'launch_app',
  'kill_app',
  'bring_to_front',
  'parse_visual_regions',
  'start_session',
  'end_session',
  'get_session',
  'list_sessions',
]

/** Load the bundled SDK, reporting a precise reason when it is unavailable. */
export async function loadSdk() {
  try {
    return { module: await import('@trycua/cua-driver') }
  } catch (error) {
    return {
      error: new Error(
        'The bundled Cua Driver components could not be loaded. '
        + 'Reinstall the @local/dsh-cua bundle so its platform binary package is present '
        + `(original error: ${error instanceof Error ? error.message : String(error)}).`,
      ),
    }
  }
}

/**
 * One lazily created driver per plugin instance.
 * @param resolveModule - async loader returning the SDK module.
 */
export function createBackend(resolveModule) {
  let driver
  let pending
  let closed = false

  const driverFor = async () => {
    if (closed) throw new Error('The bundled Cua Driver runtime was shut down with this plugin instance.')
    if (driver !== undefined) return driver
    if (pending === undefined) {
      pending = (async () => {
        const sdk = await resolveModule()
        const created = sdk.CuaDriver.create()
        return created
      })()
      try {
        driver = await pending
        return driver
      } finally {
        pending = undefined
      }
    }
    return pending
  }

  /** Parse a ToolResult's structured payload without trusting malformed JSON. */
  const structuredOf = result => {
    const raw = result?.structuredJson ?? result?.structured_json
    if (typeof raw !== 'string') return undefined
    try {
      return JSON.parse(raw)
    } catch {
      return undefined
    }
  }

  return {
    /** Runtime facts for the status action. */
    async describe() {
      const runtime = await driverFor()
      let metadata
      try {
        metadata = await runtime.metadata?.()
      } catch {
        metadata = undefined
      }
      return { metadata }
    },
    /** Tool names the running runtime reports, when it can report them. */
    async listRuntimeTools() {
      const runtime = await driverFor()
      try {
        const raw = await runtime.listToolsJson?.()
        if (typeof raw === 'string') {
          const parsed = JSON.parse(raw)
          // Some builds return a capability document rather than a name list.
          if (Array.isArray(parsed)) return parsed.map(entry => entry?.name).filter(name => typeof name === 'string')
          if (Array.isArray(parsed?.tools)) return parsed.tools.map(entry => entry?.name ?? entry).filter(name => typeof name === 'string')
        }
      } catch {
        // Fall back to the static list.
      }
      return undefined
    },
    /**
     * Read one tool's argument documentation from the bundled contract.
     * @param name - tool name.
     */
    async describeTool(name) {
      const runtime = await driverFor()
      try {
        const raw = await runtime.listToolsJson?.()
        if (typeof raw === 'string') {
          const parsed = JSON.parse(raw)
          const tools = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.tools) ? parsed.tools : undefined
          const match = tools?.find(entry => (entry?.name ?? entry) === name)
          if (match !== undefined && typeof match === 'object') return JSON.stringify(match, bigintSafe(), 2)
        }
      } catch {
        // Fall through to the static hint.
      }
      if (!IN_PROCESS_TOOLS.includes(name)) {
        throw new Error(`Cua Driver tool "${name}" is not available in this build. Known tools: ${IN_PROCESS_TOOLS.join(', ')}.`)
      }
      return `Cua Driver tool "${name}" is available. Pass its documented snake_case arguments in "arguments". Use action "call" with a small read (such as list_apps) to confirm the runtime is healthy.`
    },
    /**
     * Run one tool call through the JSON dispatch surface.
     * @param name - Cua Driver tool name.
     * @param args - documented snake_case arguments.
     * @param options - cancellation signal and timeout budget.
     */
    async call(name, args, options = {}) {
      const runtime = await driverFor()
      if (options.signal?.aborted) {
        throw Object.assign(new Error('Cua Driver call was cancelled before it started.'), { name: 'AbortError' })
      }
      if (typeof runtime.callTool !== 'function') {
        throw new Error('This build of the bundled Cua Driver does not expose callTool.')
      }
      return runtime.callTool(name, JSON.stringify(args ?? {}))
    },
    async shutdown() {
      closed = true
      const runtime = driver
      driver = undefined
      pending = undefined
      if (runtime === undefined) return
      try {
        await runtime.shutdown?.()
      } finally {
        runtime.uniffiDestroy?.()
      }
    },
  }
}

/** JSON replacer that survives the SDK's BigInt window handles. */
export function bigintSafe() {
  return (_key, value) => typeof value === 'bigint' ? `${value}` : value
}

/**
 * Tools whose useful payload is structured rather than the SDK's one-line
 * summary. For these the structured JSON is preferred as model-visible text,
 * with the summary kept as a leading line.
 */
const PREFERS_STRUCTURED = new Set([
  'list_apps',
  'list_windows',
  'verify_state',
  'get_session',
  'list_sessions',
])

/**
 * Normalize an SDK `ToolResult` into text, images and structured data.
 * @param result - raw value returned by `callTool`.
 * @param toolName - tool that produced the result, used to pick the payload.
 */
export function normalizeResult(result, toolName) {
  if (result === undefined || result === null) {
    return { text: 'Cua Driver completed without returning a result.', images: [], structured: undefined, isError: false }
  }
  if (typeof result === 'string') {
    return { text: result.slice(0, 100000), images: [], structured: undefined, isError: false }
  }
  if (typeof result !== 'object') {
    return { text: String(result), images: [], structured: undefined, isError: false }
  }

  const images = []
  for (const image of Array.isArray(result.images) ? result.images : []) {
    // The SDK names the payload `dataBase64`; accept the other spellings too.
    const data = image?.dataBase64 ?? image?.data_base64 ?? image?.data
    const mimeType = image?.mimeType ?? image?.mime_type ?? 'image/png'
    if (typeof data === 'string' && data.length > 0 && /^image\/(png|jpeg|webp|gif)$/.test(mimeType)) {
      images.push({ data, mimeType })
    }
  }

  let structured
  const rawStructured = result.structuredJson ?? result.structured_json
  if (typeof rawStructured === 'string') {
    try {
      structured = JSON.parse(rawStructured)
    } catch {
      structured = rawStructured
    }
  } else if (typeof rawStructured === 'object' && rawStructured !== null) {
    structured = rawStructured
  }

  const isError = result.isError === true || result.is_error === true
  const summary = typeof result.text === 'string' ? result.text.slice(0, 100000) : ''
  const structuredText = structured !== undefined && typeof structured === 'object'
    ? JSON.stringify(structured, bigintSafe(), 2)
    : typeof structured === 'string' ? structured : ''

  let text
  if (PREFERS_STRUCTURED.has(toolName) && structuredText !== '') {
    // Keep the human summary as a header, then the full machine-readable list.
    text = summary !== '' ? `${summary}\n\n${structuredText}` : structuredText
  } else {
    text = summary !== '' ? summary : structuredText
  }
  if (text === '') {
    text = images.length > 0 ? `Cua Driver returned ${images.length} image(s).` : 'Cua Driver returned no model-visible content.'
  }

  return {
    text: text.slice(0, 200000),
    images,
    structured,
    isError,
    errorCode: result.errorCode ?? result.error_code,
    verified: result.verification,
    degraded: result.degraded,
  }
}
