// Write a specialist's summary with an AI model (MCP page -> Subagent per MCP).
import { loopbackOrigin } from '../../utils/mcp-client'

export default defineEventHandler(async (event) => {
  requireApiToken(event)
  const body = await readBody<{ server?: string; model?: string; directory?: string }>(event)
  if (!body?.server) throw createError({ statusCode: 400, message: 'server is required' })
  try {
    const summary = await aiSummary(body.server, {
      model: typeof body.model === 'string' ? body.model : undefined,
      directory: typeof body.directory === 'string' ? body.directory : undefined,
      selfOrigin: loopbackOrigin(event.node.req.socket) ?? getRequestURL(event).origin
    })
    return { server: body.server, summary }
  } catch (error) {
    throw createError({ statusCode: 502, message: error instanceof Error ? error.message : String(error) })
  }
})
