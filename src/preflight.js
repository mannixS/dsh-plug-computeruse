/**
 * Installation self-check.
 *
 * A pnpm install can leave a stale nested `node_modules` inside this package —
 * for example after an earlier `link:` install was replaced by a registry
 * install, or when a directory was copied between machines. Its symlinks then
 * point at packages that the current profile root already provides, and Node
 * fails to `stat` them with a bare `EPERM: operation not permitted, realpath`,
 * which names a long path but says nothing about what to do.
 *
 * This module turns that into an actionable message. It never fails activation:
 * a healthy install pays one cheap `resolve` per dependency, and a broken one
 * reports the exact directory to delete instead of an unexplained EPERM.
 *
 * @module @local/dsh-cua/preflight
 */

/**
 * Dependencies the plugin needs at runtime, with what each one provides.
 *
 * `schemastery` is what the Config schema is built from; `@trycua/cua-driver`
 * is the driver itself. Both are declared in `package.json`.
 */
export const REQUIRED_DEPENDENCIES = [
  { name: '@trycua/cua-driver', role: 'the bundled Cua Driver SDK' },
  { name: '@deepseek-ai/schemastery', role: 'the configuration schema' },
]

/** Error codes that mean "the package is installed but unreadable", not "missing". */
export const BROKEN_INSTALL_CODES = new Set(['EPERM', 'EACCES', 'EIO', 'UNKNOWN'])

/**
 * Classify one dependency resolution failure.
 * @param error - the error thrown by the resolver.
 * @returns `missing` for a package that was never installed, `unreadable` when
 *   the files exist but the process cannot traverse them, `unknown` otherwise.
 */
export function classifyFailure(error) {
  const code = typeof error?.code === 'string' ? error.code : ''
  if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') return 'missing'
  if (BROKEN_INSTALL_CODES.has(code)) return 'unreadable'
  // A realpath failure surfaces without a code on some Node builds.
  const message = String(error?.message ?? error)
  if (/operation not permitted|realpath|EPERM|EACCES/i.test(message)) return 'unreadable'
  return 'unknown'
}

/**
 * Find a nested `node_modules` that may shadow the profile's own dependencies.
 *
 * This is what a leftover install leaves behind; it is worth naming in the
 * message even when the current failure came from somewhere else.
 * @param packageDirectory - this package's own directory.
 * @returns the nested directory path, or undefined when there is none.
 */
export function nestedNodeModules(packageDirectory) {
  if (typeof packageDirectory !== 'string' || packageDirectory === '') return undefined
  const separator = packageDirectory.includes('\\') ? '\\' : '/'
  return `${packageDirectory.replace(/[\\/]+$/, '')}${separator}node_modules`
}

/**
 * Build the repair instructions shown to the user.
 * @param packageDirectory - this package's own directory.
 * @param kind - the classified failure.
 * @returns a message naming the exact directory and the next step.
 */
export function repairAdvice(packageDirectory, kind) {
  const nested = nestedNodeModules(packageDirectory)
  const lines = []
  if (kind === 'unreadable') {
    lines.push('This plugin is installed, but Node cannot read one of its dependencies inside the profile.')
  } else if (kind === 'missing') {
    lines.push('This plugin is installed, but one of its dependencies is missing from the profile.')
  } else {
    lines.push('This plugin could not verify its dependencies.')
  }
  lines.push('')
  lines.push('A stale nested node_modules left by an earlier install is the usual cause. To repair:')
  lines.push('  1. Disable this plugin in Plugins.')
  if (nested !== undefined) lines.push(`  2. Delete this folder: ${nested}`)
  else lines.push('  2. Delete the nested node_modules folder inside the plugin directory.')
  lines.push('  3. Enable the plugin again. The profile root already provides these packages.')
  lines.push('')
  lines.push('Then start a new session.')
  return lines.join('\n')
}

/**
 * Verify the runtime dependencies resolve.
 *
 * Never throws: the caller decides how loudly to report a failure. A healthy
 * install costs one `import.meta.resolve` per dependency.
 * @param options - optional overrides for testing.
 * @returns `{ ok: true }`, or `{ ok: false, kind, message, failures }`.
 */
export async function checkInstallation(options = {}) {
  const {
    resolve = specifier => import.meta.resolve(specifier),
    packageDirectory = packageDirectoryOfThisModule(),
    dependencies = REQUIRED_DEPENDENCIES,
  } = options

  const failures = []
  for (const dependency of dependencies) {
    try {
      resolve(dependency.name)
    } catch (error) {
      failures.push({
        name: dependency.name,
        role: dependency.role,
        kind: classifyFailure(error),
        error,
      })
    }
  }
  if (failures.length === 0) return { ok: true }

  // One repair message covers every failure: the cause is shared.
  const kind = failures.some(failure => failure.kind === 'unreadable') ? 'unreadable' : failures[0].kind
  const detail = failures
    .map(failure => `  - ${failure.name} (${failure.role}): ${failure.kind === 'unreadable' ? 'unreadable' : failure.kind}`)
    .join('\n')
  const message = [
    'dsh-plug-computeruse could not load its dependencies.',
    '',
    detail,
    '',
    repairAdvice(packageDirectory, kind),
  ].join('\n')
  return { ok: false, kind, message, failures, packageDirectory }
}

/**
 * This package's directory, derived from the module URL.
 * @returns the directory path, or undefined when it cannot be derived.
 */
export function packageDirectoryOfThisModule() {
  try {
    const url = import.meta.url
    const withoutScheme = url.replace(/^file:\/\//, '')
    const decoded = decodeURIComponent(withoutScheme)
    // The module lives at <package>/src/preflight.js; drop two segments.
    const parent = decoded.replace(/[\\/][^\\/]+$/, '')
    return parent.replace(/[\\/][^\\/]+$/, '')
  } catch {
    return undefined
  }
}
