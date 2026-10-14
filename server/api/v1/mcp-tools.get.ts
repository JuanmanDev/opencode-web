// Tool lists of a scope's MCP servers, discovered from the servers themselves
// (utils/mcp-discovery.ts). `refresh=1` re-probes and updates the cache.
import { loopbackOrigin } from '../../utils/mcp-client'

export default defineEventHandler(async (event) => {
  requireApiToken(event) // auth on every request; only discovery work is cached
  const { directory, scope, refresh } = getQuery(event) as {
    directory?: string
    scope?: string
    refresh?: string
  }
  const selfOrigin = loopbackOrigin(event.node.req.socket) ?? getRequestURL(event).origin
  return getAllTools(directory, scope, selfOrigin, Boolean(refresh))
})
