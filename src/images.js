import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
let counter = 0

/** Whether the routed model declares image input, matching the MCP bridge's proof. */
async function modelAcceptsImages(ctx, exec) {
  const llm = ctx.get('llm')
  if (llm === undefined) return false
  const routed = exec.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? exec.agent?.options.provider
  const model = routed?.model ?? exec.agent?.options.model
  if (provider === undefined || model === undefined) return false
  try {
    const info = await llm.resolveModelInfo(provider, model, exec.signal)
    return info.inputModalities?.includes('image') === true
  } catch {
    return false
  }
}

/** Persist one screenshot under the session directory so file tools can read it later. */
async function saveFallbackFile(base, image) {
  const directory = join(base, '.dsh-cua')
  await mkdir(directory, { recursive: true })
  const extension = EXTENSIONS[image.mimeType] ?? 'png'
  const file = join(directory, `screenshot-${Date.now()}-${counter++}.${extension}`)
  await writeFile(file, Buffer.from(image.data, 'base64'))
  return file
}

/**
 * Turn raw Cua images into DSH content blocks.
 * Durable attachments are used when the model accepts images and a store is
 * mounted; otherwise the bytes land under `base` and the model gets a path.
 * @param ctx - plugin context.
 * @param exec - the exact tool execution, for the agent, route, and signal.
 * @param images - decoded `{ data, mimeType }` images in result order.
 * @param base - absolute directory for fallback files; the caller always knows
 *   the session directory, so there is deliberately no `process.cwd()` default
 *   that could drop screenshots into an unrelated working tree.
 * @returns content blocks in order.
 */
export async function projectImages(ctx, exec, images, base) {
  if (typeof base !== 'string' || base === '') {
    throw new Error('projectImages: an explicit base directory is required')
  }
  const blocks = []
  const attachments = ctx.get('attachments')
  if (attachments !== undefined && await modelAcceptsImages(ctx, exec)) {
    try {
      const refs = await attachments.saveImages(images.map(image => ({
        data: Buffer.from(image.data, 'base64'), mediaType: image.mimeType,
      })))
      for (const ref of refs) blocks.push({ type: 'image', attachment: ref })
      return blocks
    } catch (error) {
      blocks.push({ type: 'text', text: `[screenshot could not be attached: ${error instanceof Error ? error.message : String(error)}]` })
    }
  }
  for (const image of images) {
    try {
      const file = await saveFallbackFile(base, image)
      blocks.push({ type: 'text', text: `[screenshot saved to ${file}; read it with the file or image tool]` })
    } catch (error) {
      blocks.push({ type: 'text', text: `[screenshot unavailable: ${error instanceof Error ? error.message : String(error)}]` })
    }
  }
  return blocks
}
