// The MCP subagents ("nest"): settings plus what would be written now.
import { loopbackOrigin } from '../../utils/mcp-client'

export default defineEventHandler(async (event) => {
  requireApiToken(event)
  return planNest(loopbackOrigin(event.node.req.socket) ?? getRequestURL(event).origin)
})
