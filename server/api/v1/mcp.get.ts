export default defineEventHandler(async (event) => {
  requireApiToken(event)
  const { directory } = getQuery(event) as { directory?: string }
  // see the proxy: opencode connects every server before answering
  return opencodeFetch('/mcp', { query: { directory }, timeoutMs: 120000 })
})
