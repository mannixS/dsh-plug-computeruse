/**
 * Configuration schema for the Cua computer-control plugin.
 *
 * Every field is marked `.volatile()` so DSH's settings service can edit it:
 * without that marker the write gate rejects the change with "no volatile
 * fields" while the client's `set()` still resolves, which would look saved and
 * silently revert. Volatile fields update in place, so the plugin is not
 * restarted when a setting changes.
 *
 * `schemastery` is a real dependency of this package rather than a peer the
 * profile supplies, because a directory-installed bundle resolves its own
 * `node_modules` and cannot import the harness's packages.
 *
 * @module @local/dsh-cua/config
 */
import z from '@deepseek-ai/schemastery'

/** Configuration accepted from the profile patch and the settings page. */
export const Config = z.object({
  /** `desktop` drives the whole display; `window` pins one app. */
  scope: z.union(['desktop', 'window']).default('desktop').volatile(),
  /** Pinned app for `scope: window`. */
  app: z.object({
    name: z.string(),
    pid: z.natural(),
  }).default(undefined).volatile(),
  /** Which calls require the user's confirmation. */
  approval: z.union(['mutations', 'all', 'none']).default('mutations').volatile(),
  /** Tool allowlist; empty allows every tool. */
  allowTools: z.array(z.string()).default([]).volatile(),
  /** Default Cua session label, also identifying the focus cursor. */
  session: z.string().default('dsh-cua').volatile(),
  /** Screenshot long-edge cap in pixels; unset uses the driver default. */
  maxImageDimension: z.natural().default(undefined).volatile(),
  /** How long disk-fallback screenshots survive. */
  screenshotRetentionMs: z.natural().default(900000).volatile(),
  /** Interval between background screenshot sweeps; 0 disables the timer. */
  screenshotSweepMs: z.natural().default(60000).volatile(),
  /** Whether the per-session agent cursor is enabled. */
  showFocusCursor: z.boolean().default(true).volatile(),
  /** Upper bound for one driver call. */
  timeoutMs: z.natural().min(1000).max(900000).default(120000).volatile(),
})

export default Config
