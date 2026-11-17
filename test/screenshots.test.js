import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createScreenshotJanitor, pruneScreenshots, saveScreenshot, screenshotDirectory } from '../src/screenshots.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64')
const image = { data: PNG.toString('base64'), mimeType: 'image/png' }

/** Unique temp directory per test. */
async function workspace(t) {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cua-shots-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test('writes screenshots into the session workspace', async t => {
  const base = await workspace(t)
  const file = await saveScreenshot(base, image)
  const files = await readdir(screenshotDirectory(base))
  assert.equal(files.length, 1)
  assert.match(file, /screenshot-\d+-\d+\.png$/)
})

test('prunes old screenshots but keeps new ones', async t => {
  const base = await workspace(t)
  const directory = screenshotDirectory(base)
  await mkdir(directory, { recursive: true })
  // An ancient file that must go, and a fresh one that must stay.
  const old = join(directory, 'screenshot-1-0.png')
  await writeFile(old, PNG)
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
  await utimes(old, twoHoursAgo, twoHoursAgo)
  await saveScreenshot(base, image)

  const removed = await pruneScreenshots(base, { maxAgeMs: 60 * 60 * 1000 })
  const remaining = await readdir(directory)
  assert.equal(removed, 1)
  assert.equal(remaining.length, 1)
  assert.doesNotMatch(remaining[0], /^screenshot-1-0\.png$/)
})

test('keeps the newest files even when everything is old', async t => {
  const base = await workspace(t)
  const directory = screenshotDirectory(base)
  await mkdir(directory, { recursive: true })
  for (let index = 0; index < 3; index++) {
    await writeFile(join(directory, `screenshot-${index}-0.png`), PNG)
  }
  const removed = await pruneScreenshots(base, { maxAgeMs: 0, keepNewest: 1 })
  assert.equal(removed, 2)
  assert.equal((await readdir(directory)).length, 1)
})

test('ignores unrelated files and a missing directory', async t => {
  const base = await workspace(t)
  const directory = screenshotDirectory(base)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'notes.txt'), 'keep me')
  await writeFile(join(directory, 'screenshot.png'), PNG)
  assert.equal(await pruneScreenshots(base, { maxAgeMs: 0 }), 0)
  assert.equal((await readdir(directory)).length, 2)
  assert.equal(await pruneScreenshots(join(base, 'absent'), { maxAgeMs: 0 }), 0)
})

test('janitor clears a session directory completely', async t => {
  const base = await workspace(t)
  await saveScreenshot(base, image)
  const janitor = createScreenshotJanitor({ defaultBase: base, retentionMs: 1000 })
  assert.equal(janitor.tracked().includes(base), true)
  await janitor.clear(base)
  await assert.rejects(readdir(screenshotDirectory(base)))
})

test('janitor start is inert when retention is disabled and disposes cleanly', async t => {
  const base = await workspace(t)
  await saveScreenshot(base, image)
  const disabled = createScreenshotJanitor({ defaultBase: base, retentionMs: 0 })
  const dispose = disabled.start()
  assert.equal(typeof dispose, 'function')
  dispose()
  // Nothing swept, so the file is still there.
  assert.equal((await readdir(screenshotDirectory(base))).length, 1)

  const active = createScreenshotJanitor({ defaultBase: base, retentionMs: 1, intervalMs: 60000 })
  const stop = active.start()
  stop()
  const second = active.start()
  second()
  assert.deepEqual(active.tracked(), [base])
})

test('janitor tracks directories added later', async t => {
  const base = await workspace(t)
  const janitor = createScreenshotJanitor({ retentionMs: 1000 })
  await saveScreenshot(base, image)
  // A fresh file is inside the retention window, so only an explicit
  // immediate threshold removes it.
  assert.equal(await janitor.prune(base, { maxAgeMs: 0 }), 1)
  assert.equal((await readdir(screenshotDirectory(base))).length, 0)
  assert.equal(janitor.tracked().includes(base), true)
})

test('removal is best effort when a file disappears concurrently', async t => {
  const base = await workspace(t)
  const directory = screenshotDirectory(base)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'screenshot-1-0.png'), PNG)
  await rm(join(directory, 'screenshot-1-0.png'))
  assert.equal(await pruneScreenshots(base, { maxAgeMs: 0 }), 0)
})
