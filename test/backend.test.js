import test from 'node:test'
import assert from 'node:assert/strict'
import { bigintSafe, normalizeResult } from '../src/backend.js'

test('normalizes a text-only tool result', () => {
  const result = normalizeResult({ text: 'Main display: 1366x768', images: [], isError: false })
  assert.equal(result.text, 'Main display: 1366x768')
  assert.equal(result.images.length, 0)
  assert.equal(result.isError, false)
})

test('reads the SDK dataBase64 image field', () => {
  const result = normalizeResult({
    text: '',
    images: [{ mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=' }],
    structuredJson: '{"screenshot_width":800}',
  })
  assert.equal(result.images.length, 1)
  assert.equal(result.images[0].data, 'iVBORw0KGgo=')
  assert.equal(result.images[0].mimeType, 'image/png')
  assert.deepEqual(result.structured, { screenshot_width: 800 })
  assert.match(result.text, /800/)
})

test('image-only results still produce model text', () => {
  const result = normalizeResult({ text: '', images: [{ mimeType: 'image/png', dataBase64: 'abc' }] })
  assert.equal(result.text, 'Cua Driver returned 1 image(s).')
})

test('drops unsupported and empty image payloads', () => {
  const result = normalizeResult({
    text: 'ok',
    images: [{ mimeType: 'image/bmp', dataBase64: 'abc' }, { mimeType: 'image/png', dataBase64: '' }],
  })
  assert.equal(result.images.length, 0)
  assert.equal(result.text, 'ok')
})

test('propagates SDK errors and codes', () => {
  const result = normalizeResult({ text: 'Unknown tool: nope', images: [], isError: true })
  assert.equal(result.isError, true)
  assert.equal(result.text, 'Unknown tool: nope')
})

test('tolerates malformed structured JSON', () => {
  const result = normalizeResult({ text: 'degraded', images: [], structuredJson: '{not json' })
  assert.equal(result.text, 'degraded')
  assert.equal(result.structured, '{not json')
})

test('handles missing, string and primitive results', () => {
  assert.match(normalizeResult(undefined).text, /without returning a result/)
  assert.equal(normalizeResult('plain').text, 'plain')
  assert.equal(normalizeResult(42).text, '42')
})

test('serializes BigInt window handles', () => {
  const text = JSON.stringify({ window_id: 15404380n }, bigintSafe())
  assert.equal(text, '{"window_id":"15404380"}')
})
