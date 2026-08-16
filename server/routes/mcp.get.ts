// Streamable HTTP: this server runs in stateless JSON mode and does not offer
// a server-initiated SSE stream. Clients must POST JSON-RPC messages.
export default defineEventHandler((event) => {
  setResponseStatus(event, 405)
  setResponseHeader(event, 'allow', 'POST')
  return { error: 'Use POST with JSON-RPC messages (MCP Streamable HTTP, stateless mode).' }
})
