/**
 * Approval and session-end hooks for the Cua tool.
 *
 * The plugin registers a `tools/pre-execute` listener that returns
 * `{ kind: 'ask' }` for state-changing Cua calls, which makes DSH run its
 * approval flow and deny the call unless the user allows it once. Read-only
 * calls pass straight through. The listener is scoped to this plugin's own
 * tool so it never affects other tools in the profile.
 *
 * Cleanup is driven by observable events rather than timers alone: screenshots
 * are pruned after every settled call and removed when a turn ends.
 * `agent/turn-stopping` is the turn-end event dsh-agent actually exposes;
 * `turn-start` is also handled so a new turn never inherits the previous
 * turn's images.
 *
 * @module @local/dsh-cua/hooks
 */
import { describeMutation, needsApproval } from './scope.js'

/** Tool name this plugin owns. */
export const TOOL_NAME = 'cua_driver'

/**
 * Resolve a session working directory from the payloads of the events this
 * module subscribes to. Each event shape is tried in turn, so an unknown
 * payload is simply skipped rather than throwing.
 */
export function directoryFrom(payload, resolveDirectory) {
  if (typeof resolveDirectory !== 'function') return undefined
  const candidates = [
    payload?.agent?.session,
    payload?.session,
    payload?.exec?.agent?.session,
    payload?.agent,
  ]
  for (const session of candidates) {
    if (session === undefined || session === null) continue
    try {
      const directory = resolveDirectory(session)
      if (typeof directory === 'string' && directory !== '') return directory
    } catch {
      // Try the next shape.
    }
  }
  return undefined
}

/**
 * Install the approval hook and the turn-end cleanup hooks.
 * @param ctx - plugin context.
 * @param deps - configuration and helpers owned by the plugin.
 * @returns a disposer, already bound to this plugin's effect.
 */
export function installHooks(ctx, deps) {
  const { approvalOf, janitor, logger, resolveDirectory } = deps
  const disposers = []
  const track = disposable => {
    if (typeof disposable === 'function') disposers.push(disposable)
  }

  // Approval gate: consulted before the tool body runs, so a denied call never
  // reaches the desktop.
  const onPreExecute = async (exec, next) => {
    // A sibling policy failed; do not mask its failure with our own.
    const decision = await next()
    if (exec?.name !== TOOL_NAME) return decision
    // A sibling policy already decided; only an explicit allow may be raised to ask.
    if (decision?.kind !== 'allow') return decision
    // Only `call` can change the desktop. `status`, `describe` and `list_tools`
    // read documentation or runtime facts and must never prompt, whatever tool
    // name they mention.
    if (exec?.arguments?.action !== undefined && exec.arguments.action !== 'call') return decision
    const name = exec?.arguments?.name
    if (typeof name !== 'string') return decision
    // The approval mode is volatile, so read it per call.
    const mode = typeof approvalOf === 'function' ? approvalOf() : approvalOf
    if (!needsApproval(mode, name)) return decision
    let summary
    try {
      summary = describeMutation(name, exec.arguments?.arguments ?? {})
    } catch {
      summary = `${name} on the desktop`
    }
    return {
      kind: 'ask',
      reason: 'Automation requests desktop control. Allow once to proceed.',
      displayReason: {
        en: `Allow Cua Driver to run ${summary}?`,
        zh: `允许 Cua Driver 执行 ${summary} 吗？`,
      },
    }
  }

  /** Remove this session's screenshots; best effort so cleanup never fails a turn. */
  const clean = (payload, reason) => {
    const base = directoryFrom(payload, resolveDirectory)
    if (typeof base !== 'string') return
    void janitor.clear(base).catch(error => {
      logger?.warn?.(`dsh-cua: screenshot cleanup (${reason}) failed for ${base}: ${String(error)}`)
    })
  }

  if (typeof ctx.on === 'function') {
    try {
      track(ctx.on('tools/pre-execute', onPreExecute))
    } catch (error) {
      logger?.warn?.(`dsh-cua: approval hook unavailable: ${String(error)}`)
    }
    // A finished turn must not leave its screenshots behind.
    try {
      track(ctx.on('agent/turn-stopping', payload => clean(payload, 'turn-stopping')))
    } catch (error) {
      logger?.warn?.(`dsh-cua: turn cleanup hook unavailable: ${String(error)}`)
    }
    // A new turn starts from a clean slate even if the previous one never
    // reached a turn-stopping notification (for example, a crashed step).
    try {
      track(ctx.on('turn/start', payload => clean(payload, 'turn-start')))
    } catch (error) {
      logger?.warn?.(`dsh-cua: turn-start cleanup hook unavailable: ${String(error)}`)
    }
  }

  return () => {
    for (const dispose of disposers) {
      try {
        dispose?.()
      } catch {
        // The owning fiber may already be torn down.
      }
    }
  }
}
