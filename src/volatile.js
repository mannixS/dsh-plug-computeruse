/**
 * Volatile-reference helpers shared by the Host and the settings page.
 *
 * DSH hands `.volatile()` fields back as live `{ get(): T }` references. A live
 * reference is still `typeof === 'object'`, so a naive object check passes and
 * every lookup on it returns `undefined`; spreading one produces
 * `{ get: <function> }` rather than the value. Every read therefore unwraps
 * first.
 *
 * @module @local/dsh-cua/volatile
 */

/**
 * Peel one `{ get(): T }` live reference.
 * @param value - possibly a live reference.
 * @returns the resolved value.
 */
export function unwrapVolatile(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') return value.get()
  return value
}

/**
 * Deep copy with every live reference resolved.
 * @param value - possibly nested live references.
 * @returns a plain value.
 */
export function unwrapVolatileDeep(value) {
  if (value === null || typeof value !== 'object') return value
  if (typeof value.get === 'function') return unwrapVolatileDeep(value.get())
  if (Array.isArray(value)) return value.map(entry => unwrapVolatileDeep(entry))
  const out = {}
  for (const key of Object.keys(value)) out[key] = unwrapVolatileDeep(value[key])
  return out
}
