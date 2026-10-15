// Generate a short text with one of opencode's models (see utils/ai.ts).
import type { AiTextRequest } from '../../utils/ai'
export default defineEventHandler(async (event) => {
  requireApiToken(event)
  assertBodySize(event, 256 * 1024)
  const body = await readBody<Partial<AiTextRequest>>(event)
  if (!body?.prompt || typeof body.prompt !== 'string') {
    throw createError({ statusCode: 400, message: 'prompt is required' })
  }
  try {
    const text = await aiText({
      prompt: body.prompt,
      system: typeof body.system === 'string' ? body.system : undefined,
      model: typeof body.model === 'string' ? body.model : undefined,
      directory: typeof body.directory === 'string' ? body.directory : undefined
    })
    return { text }
  } catch (error) {
    throw createError({ statusCode: 502, message: error instanceof Error ? error.message : String(error) })
  }
})
