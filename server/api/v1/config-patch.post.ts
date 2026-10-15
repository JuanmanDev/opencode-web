// PATCH the project or global opencode config, verifying the change took
// effect (opencode 1.19 ignores the project file its own API writes; such a
// change is applied to the global config and reported as `fallback`).
import type { McpScope } from '../../utils/mcp-admin'

export default defineEventHandler(async (event) => {
  requireApiToken(event)
  assertBodySize(event, 64 * 1024)
  const body = await readBody<{ scope?: McpScope; directory?: string; patch?: Record<string, unknown> }>(event)
  if (!body?.patch || typeof body.patch !== 'object') throw createError({ statusCode: 400, message: 'patch is required' })
  const result = await patchConfig(body.scope === 'global' ? 'global' : 'project', body.directory, body.patch)
  await forgetMcpTools()
  return result
})
