export default defineEventHandler((event) => {
  setResponseStatus(event, 405)
  setResponseHeader(event, 'allow', 'POST')
  return { error: 'Demo MCP server: POST JSON-RPC messages (Streamable HTTP, stateless).' }
})
