// Create or update one MCP server in the project or global opencode config.
// Secrets left as "***" keep their stored value; the server is (re)connected.
import type { McpScope, McpServerConfig } from '../../utils/mcp-admin'
export default defineEventHandler(async (event) => {
  requireApiToken(event)
  assertBodySize(event, 64 * 1024)
  const body = await readBody<{ name?: string; scope?: McpScope; directory?: string; config?: McpServerConfig }>(event)
  if (!body?.name || !body.config || typeof body.config !== 'object') {
    throw createError({ statusCode: 400, message: 'name and config are required' })
  }
  const result = await saveMcpServer({
    name: body.name,
    scope: body.scope === 'global' ? 'global' : 'project',
    directory: body.directory,
    config: body.config
  })
  await forgetMcpTools()
  return result
})
