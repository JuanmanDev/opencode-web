// Is this app's control MCP server registered with opencode, and at which URL?
export default defineEventHandler(async (event) => {
  requireApiToken(event)
  await ensureControlMcp(event)
  return controlMcpState(event)
})
