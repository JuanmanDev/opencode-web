// Fetch the tool lists of a project's remote MCP servers by speaking MCP
// (Streamable HTTP JSON-RPC) to them directly — opencode itself does not
// expose MCP tool ids. Local (stdio) servers cannot be queried this way.

interface McpConfigEntry {
  type?: string
  url?: string
  headers?: Record<string, string>
  enabled?: boolean
}

interface ToolInfo {
  name: string
  description?: string
}

async function rpc(
  url: string,
  headers: Record<string, string>,
  method: string,
  params: Record<string, unknown>,
  id: number,
  sessionId?: string
): Promise<{ result?: any; sessionId?: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      ...headers
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(6000)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const newSession = res.headers.get('mcp-session-id') || sessionId
  const contentType = res.headers.get('content-type') || ''
  let payload: any
  if (contentType.includes('text/event-stream')) {
    // parse the first data: line of the SSE body
    const body = await res.text()
    const line = body.split('\n').find((l) => l.startsWith('data:'))
    payload = line ? JSON.parse(line.slice(5).trim()) : undefined
  } else {
    payload = await res.json()
  }
  if (payload?.error) throw new Error(payload.error.message || 'MCP error')
  return { result: payload?.result, sessionId: newSession }
}

async function fetchTools(url: string, headers: Record<string, string>): Promise<ToolInfo[]> {
  const init = await rpc(url, headers, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'opencode-web', version: '1' }
  }, 1)
  // fire-and-forget initialized notification (some servers require it)
  fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(init.sessionId ? { 'mcp-session-id': init.sessionId } : {}),
      ...headers
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    signal: AbortSignal.timeout(4000)
  }).catch(() => {})

  const list = await rpc(url, headers, 'tools/list', {}, 2, init.sessionId)
  const tools = Array.isArray(list.result?.tools) ? list.result.tools : []
  return tools
    .map((t: any) => ({
      name: String(t?.name || ''),
      description: typeof t?.description === 'string'
        ? t.description.split('\n')[0]!.slice(0, 140)
        : undefined
    }))
    .filter((t: ToolInfo) => t.name)
}

export default defineEventHandler(async (event) => {
  requireApiToken(event)
  const { directory } = getQuery(event) as { directory?: string }

  const config = await opencodeFetch<{ mcp?: Record<string, McpConfigEntry> }>('/config', {
    query: { directory }
  }).catch(() => ({ mcp: {} as Record<string, McpConfigEntry> }))

  const entries = Object.entries(config.mcp || {})
  const results: Record<string, { tools: ToolInfo[]; error?: string }> = {}

  await Promise.all(entries.map(async ([name, entry]) => {
    if (entry?.type !== 'remote' || !entry.url) {
      results[name] = { tools: [] }
      return
    }
    try {
      results[name] = { tools: await fetchTools(entry.url, entry.headers || {}) }
    } catch (error) {
      results[name] = {
        tools: [],
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }))

  return results
})
