import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectImages } from '../src/images.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64')

/** Minimal agent/context stubs: the image path only reads these. */
function fakeExec(signal = new AbortController().signal) {
  return { signal, agent: { session: { requestHeader: () => ({ config: {} }) }, options: {} } }
}

test('saves screenshots to the session workspace when no attachment store is mounted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cua-images-'))
  try {
    const ctx = { workingDirectory: { get: () => directory }, get: () => undefined }
    const blocks = await projectImages(ctx, fakeExec(), [{ data: png.toString('base64'), mimeType: 'image/png' }], directory)
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].type, 'text')
    const match = blocks[0].text.match(/\[screenshot saved to (.+?);/)
    assert.ok(match, blocks[0].text)
    const bytes = await readFile(match[1])
    assert.equal(bytes.length, png.length)
    assert.match(match[1], /\.dsh-cua/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('uses durable attachments when the routed model declares image input', async () => {
  // A temp base keeps the attachment path from writing a fixture into the repo.
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cua-images-'))
  try {
    const saved = []
    const ctx = {
      workingDirectory: { get: () => directory },
      get: name => name === 'llm'
        ? { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) }
        : { saveImages: async images => { saved.push(...images); return images.map((_, index) => ({ attachmentId: `a${index}`, mediaType: 'image/png', bytes: 1, width: 1, height: 1 })) } },
    }
    const exec = fakeExec()
    exec.agent.session.requestHeader = () => ({ config: { provider: 'p', model: 'm' } })
    const blocks = await projectImages(ctx, exec, [{ data: png.toString('base64'), mimeType: 'image/png' }], directory)
    assert.equal(saved.length, 1)
    assert.equal(blocks[0].type, 'image')
    // Nothing may be written when the attachment store accepted the image.
    assert.deepEqual(await readdir(join(directory, '.dsh-cua')).catch(() => []), [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('falls back to a workspace path when the model is text-only', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cua-images-'))
  try {
    const ctx = {
      workingDirectory: { get: () => directory },
      get: name => name === 'llm' ? { resolveModelInfo: async () => ({ inputModalities: ['text'] }) } : undefined,
    }
    const blocks = await projectImages(ctx, fakeExec(), [{ data: png.toString('base64'), mimeType: 'image/png' }], directory)
    assert.equal(blocks[0].type, 'text')
    assert.match(blocks[0].text, /screenshot saved to/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('unsupported media type still produces a usable note', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cua-images-'))
  try {
    const ctx = { workingDirectory: { get: () => directory }, get: () => undefined }
    const blocks = await projectImages(ctx, fakeExec(), [{ data: png.toString('base64'), mimeType: 'image/webp' }], directory)
    assert.equal(blocks[0].type, 'text')
    assert.match(blocks[0].text, /\.webp/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
