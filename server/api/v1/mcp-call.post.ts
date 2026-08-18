// Re-run an MCP tool against its remote server to recover the ui:// resources
// opencode strips from tool outputs. Cached briefly so page reloads don't
// re-trigger tools.

// dynamically-registered servers (POST /mcp) never land in any config file,
// so well-known ones get a fallback URL
const KNOWN_URLS: Record<string, string> = {
  'mcp-ui-demo': 'https://remote-mcp-server-authless.idosalomon.workers.dev/mcp'
}

const cachedCall = defineCachedFunction(
  async (directory: string | undefined, toolId: string, argsJson: string, selfOrigin?: string) => {
    const [config, globalConfig] = await Promise.all([
      opencodeFetch<{ mcp?: Record<string, McpRemoteEntry> }>('/config', { query: { directory } }).catch(() => ({ mcp: {} })),
      opencodeFetch<{ mcp?: Record<string, McpRemoteEntry> }>('/global/config').catch(() => ({ mcp: {} }))
    ])
    const merged: Record<string, McpRemoteEntry> = {
      ...Object.fromEntries(Object.entries(KNOWN_URLS).map(([name, url]) => [name, { type: 'remote', url }])),
      ...(globalConfig.mcp || {}),
      ...(config.mcp || {})
    }
    const resolved = resolveMcpTool(merged, toolId)
    if (!resolved) throw createError({ statusCode: 404, message: `No MCP server matches tool ${toolId}` })
    if (resolved.entry.type !== 'remote' || !resolved.entry.url) {
      throw createError({ statusCode: 400, message: `${resolved.server} is not a remote MCP server` })
    }
    // the built-in demo server's stored URL may point at a stale origin
    // (e.g. added while dev ran on another port) — always use the current one
    let targetUrl = resolved.entry.url
    if (selfOrigin && new URL(targetUrl).pathname.replace(/\/$/, '') === '/mcp-demo') {
      targetUrl = `${selfOrigin}/mcp-demo`
    }
    return callRemoteMcpTool(
      targetUrl,
      resolved.entry.headers || {},
      resolved.tool,
      JSON.parse(argsJson)
    )
  },
  {
    name: 'mcp-call',
    maxAge: 300,
    getKey: (directory: string | undefined, toolId: string, argsJson: string, _selfOrigin?: string) =>
      encodeURIComponent(`${directory || ''}|${toolId}|${argsJson}`).slice(0, 200) +
      String(argsJson.length)
  }
)

export default defineEventHandler(async (event) => {
  requireApiToken(event)
  const body = await readBody<{ directory?: string; toolId: string; arguments?: Record<string, unknown> }>(event)
  if (!body?.toolId) throw createError({ statusCode: 400, message: 'toolId is required' })
  return cachedCall(
    body.directory,
    body.toolId,
    JSON.stringify(body.arguments || {}),
    getRequestURL(event).origin
  )
})
