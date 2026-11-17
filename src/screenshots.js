/**
 * Filesystem hygiene for screenshots the plugin writes into the workspace.
 *
 * Cua Driver returns screenshots as base64. When DSH cannot attach them
 * durably (text-only model, no attachment store), the bytes land under
 * `<session>/.dsh-cua/`. Those files are derived artifacts: they are cleaned on
 * a timer, after each settled tool call, and when the turn ends, so a long
 * session never accumulates desktop images on disk.
 *
 * @module @local/dsh-cua/screenshots
 */
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }

/** Directory name under the session working directory. */
export const SCREENSHOT_DIRECTORY = '.dsh-cua'

let counter = 0

/** Directory that holds this plugin's screenshots for the given session. */
export function screenshotDirectory(base) {
  return resolve(base, SCREENSHOT_DIRECTORY)
}

/**
 * Write one image and return its absolute path.
 * @param base - session working directory.
 * @param image - `{ data, mimeType }` with base64 data.
 */
export async function saveScreenshot(base, image) {
  const directory = screenshotDirectory(base)
  await mkdir(directory, { recursive: true })
  const extension = EXTENSIONS[image.mimeType] ?? 'png'
  const file = join(directory, `screenshot-${Date.now()}-${counter++}.${extension}`)
  await writeFile(file, Buffer.from(image.data, 'base64'))
  return file
}

/**
 * Delete screenshots older than `maxAgeMs`. Best effort: a concurrent writer or
 * a locked file must never fail a tool call.
 * @param base - session working directory.
 * @param options - `maxAgeMs` age threshold; `keepNewest` files to spare.
 * @returns number of removed files.
 */
export async function pruneScreenshots(base, { maxAgeMs = 0, keepNewest = 0 } = {}) {
  const directory = screenshotDirectory(base)
  let entries
  try {
    entries = await readdir(directory)
  } catch {
    return 0
  }
  const candidates = []
  for (const name of entries) {
    if (!/^screenshot-\d+-\d+\.(png|jpg|webp|gif)$/.test(name)) continue
    const file = join(directory, name)
    try {
      const info = await stat(file)
      candidates.push({ file, age: Date.now() - info.mtimeMs })
    } catch {
      // Removed between readdir and stat.
    }
  }
  candidates.sort((left, right) => left.age - right.age)
  let removed = 0
  for (const [index, candidate] of candidates.entries()) {
    if (index < keepNewest) continue
    if (candidate.age < maxAgeMs) continue
    try {
      await rm(candidate.file, { force: true })
      removed++
    } catch {
      // A locked or already-removed file is not an error for this cleanup pass.
    }
  }
  return removed
}

/**
 * Remove the screenshot directory for one session entirely.
 * @param base - session working directory.
 */
export async function clearScreenshots(base) {
  const directory = screenshotDirectory(base)
  try {
    await rm(directory, { recursive: true, force: true })
  } catch {
    // Cleanup is best effort.
  }
}

/**
 * A per-session screenshot lifecycle: periodic pruning while the plugin is
 * mounted, plus explicit pruning after calls and at turn end.
 * @param options - retention window and sweep interval.
 */
export function createScreenshotJanitor({ defaultBase, retentionMs, intervalMs = 60000 }) {
  const directories = new Set()
  if (defaultBase !== undefined) directories.add(resolve(defaultBase))
  let timer

  const sweep = () => {
    for (const base of directories) {
      void pruneScreenshots(base, { maxAgeMs: retentionMs })
    }
  }

  return {
    /** Remember a session directory so the periodic sweep includes it. */
    track(base) {
      if (typeof base === 'string' && base !== '') directories.add(resolve(base))
    },
    /** Prune one directory now; called after each settled call. */
    async prune(base, options = {}) {
      this.track(base)
      // An explicit caller threshold wins over the periodic retention window.
      const maxAgeMs = options.maxAgeMs ?? retentionMs
      return pruneScreenshots(base, { ...options, maxAgeMs })
    },
    /** Remove everything this plugin wrote for a directory. */
    async clear(base) {
      directories.delete(resolve(base))
      return clearScreenshots(base)
    },
    /** Sweep every tracked directory. */
    sweep,
    /** Start the periodic sweep; returns a disposer for the plugin effect. */
    start() {
      if (retentionMs <= 0 || intervalMs <= 0 || timer !== undefined) return () => {}
      timer = setInterval(sweep, intervalMs)
      timer.unref?.()
      return () => {
        clearInterval(timer)
        timer = undefined
      }
    },
    /** Directories currently tracked, for diagnostics and tests. */
    tracked() {
      return [...directories]
    },
  }
}
