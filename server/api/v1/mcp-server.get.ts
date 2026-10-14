// One MCP server for the detail view: its entry (secrets redacted), the
// config it lives in, and opencode's live status with an explanation.
import type { McpServerConfig } from '../../utils/mcp-admin'
import { mcpErrorHint } from '#shared/utils/mcp-hints'

export default defineEventHandler(async (event) => {
  requireApiToken(event)
  const { name, directory } = getQuery(event) as { name?: string; directory?: string }
  if (!name) throw createError({ statusCode: 400, message: 'name is required' })
  const definedIn = await mcpDefinedIn(name, directory)
  const config = definedIn
    ? (await rawMcpConfig(definedIn, directory).catch(() => ({} as Record<string, McpServerConfig>)))[name]
    : undefined
  const status = await mcpStatusOf(name, directory)
  return {
    name,
    definedIn: definedIn || null,
    config: config ? redactSecrets(config) : null,
    status: status || null,
    hint: mcpErrorHint(status?.error, status?.status) || null
  }
})
