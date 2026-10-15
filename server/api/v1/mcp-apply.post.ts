// Apply one MCP server's config to the running opencode now (connect or
// disconnect it), so switching a server on or off needs no reload.
import { mcpErrorHint } from '#shared/utils/mcp-hints'
export default defineEventHandler(async (event) => {
  requireApiToken(event)
  const body = await readBody<{ name?: string; directory?: string; enabled?: boolean }>(event)
  if (!body?.name) throw createError({ statusCode: 400, message: 'name is required' })
  const status = await applyMcpLive(body.name, body.directory, typeof body.enabled === 'boolean' ? body.enabled : undefined)
  return { name: body.name, status, hint: mcpErrorHint(status?.error, status?.status) }
})
