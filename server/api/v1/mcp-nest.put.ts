// Change the MCP subagents settings (on/off, summaries, left-out servers)
// and write the result into opencode's global config.
import type { NestSettings } from '../../utils/mcp-nest'
import { loopbackOrigin } from '../../utils/mcp-client'

export default defineEventHandler(async (event) => {
  requireApiToken(event)
  assertBodySize(event, 64 * 1024)
  const body = await readBody<Partial<NestSettings>>(event)
  const patch: Partial<NestSettings> = {}
  if (typeof body?.enabled === 'boolean') patch.enabled = body.enabled
  if (typeof body?.orchestrator === 'string') patch.orchestrator = body.orchestrator.trim()
  if (Array.isArray(body?.exclude)) patch.exclude = body.exclude.map(String)
  if (body?.summaries && typeof body.summaries === 'object') patch.summaries = body.summaries
  if (typeof body?.instructions === 'string') patch.instructions = body.instructions.slice(0, 4000)
  await saveNestSettings(patch)
  const selfOrigin = loopbackOrigin(event.node.req.socket) ?? getRequestURL(event).origin
  const result = await syncNest(selfOrigin, { force: true })
  return { changed: result.changed, ...(await planNest(selfOrigin)) }
})
