// Test an MCP server end to end without saving anything: the stored entry
// (by name) or an edited config, whose "***" secrets resolve to stored values.
import type { McpScope, McpServerConfig } from '../../utils/mcp-admin'

export default defineEventHandler(async (event) => {
  requireApiToken(event)
  assertBodySize(event, 64 * 1024)
  const body = await readBody<{ name?: string; scope?: McpScope; directory?: string; config?: McpServerConfig }>(event)
  if (!body?.name && !body?.config) throw createError({ statusCode: 400, message: 'name or config is required' })

  let stored: McpServerConfig | undefined
  if (body.name) {
    const scope = body.scope || await mcpDefinedIn(body.name, body.directory)
    if (scope) stored = (await rawMcpConfig(scope, body.directory).catch(() => ({} as Record<string, McpServerConfig>)))[body.name]
  }
  const config = body.config ? normalizeServerConfig(restoreSecrets(body.config, stored)) : stored
  if (!config) throw createError({ statusCode: 404, message: `No MCP server named ${body.name}` })
  return inspectMcpServer(config, loopbackOrigin(event.node.req.socket) ?? getRequestURL(event).origin)
})
