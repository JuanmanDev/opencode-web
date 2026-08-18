// Minimal MCP client (Streamable HTTP) used to call tools on remote servers
// directly — opencode strips ui:// resources from tool outputs, so UI apps
// are re-fetched from the source.

export interface McpRemoteEntry {
  type?: string
  url?: string
  headers?: Record<string, string>
  enabled?: boolean
}

async function mcpRpc(
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
    signal: AbortSignal.timeout(15000)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const newSession = res.headers.get('mcp-session-id') || sessionId
  const contentType = res.headers.get('content-type') || ''
  let payload: any
  if (contentType.includes('text/event-stream')) {
    const body = await res.text()
    const line = body.split('\n').find((l) => l.startsWith('data:'))
    payload = line ? JSON.parse(line.slice(5).trim()) : undefined
  } else {
    payload = await res.json()
  }
  if (payload?.error) throw new Error(payload.error.message || 'MCP error')
  return { result: payload?.result, sessionId: newSession }
}

export interface McpUiResource {
  html?: string
  url?: string
  title?: string
  /** mcp-ui remote-dom component script, rendered in a generic host shell */
  remoteDom?: boolean
  script?: string
}

export interface McpCallResult {
  text: string
  resources: McpUiResource[]
  structuredContent?: unknown
}

/**
 * MCP Apps (SEP-1865): if the tool declares _meta.ui.resourceUri, read the
 * ui:// template resource so the host can render it and stream data in.
 */
export async function fetchAppTemplate(
  url: string,
  headers: Record<string, string>,
  toolName: string
): Promise<{ resourceUri: string; html: string } | null> {
  const init = await mcpRpc(url, headers, 'initialize', {
    protocolVersion: '2026-01-26',
    capabilities: {
      extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } }
    },
    clientInfo: { name: 'opencode-web', version: '1' }
  }, 1)
  const list = await mcpRpc(url, headers, 'tools/list', {}, 2, init.sessionId)
  const tool = (Array.isArray(list.result?.tools) ? list.result.tools : [])
    .find((t: any) => t?.name === toolName)
  const resourceUri = tool?._meta?.ui?.resourceUri
  if (typeof resourceUri !== 'string' || !resourceUri.startsWith('ui://')) return null
  const read = await mcpRpc(url, headers, 'resources/read', { uri: resourceUri }, 3, init.sessionId)
  const content = (read.result?.contents || [])[0]
  if (typeof content?.text !== 'string') return null
  return { resourceUri, html: content.text }
}

/** Initialize + tools/call against a remote MCP server; extract UI resources. */
export async function callRemoteMcpTool(
  url: string,
  headers: Record<string, string>,
  tool: string,
  args: Record<string, unknown>
): Promise<McpCallResult> {
  const init = await mcpRpc(url, headers, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'opencode-web', version: '1' }
  }, 1)
  fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(init.sessionId ? { 'mcp-session-id': init.sessionId } : {}),
      ...headers
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    signal: AbortSignal.timeout(8000)
  }).catch(() => {})

  const call = await mcpRpc(url, headers, 'tools/call', { name: tool, arguments: args }, 2, init.sessionId)
  const content = Array.isArray(call.result?.content) ? call.result.content : []

  // servers often return app links as http://localhost:PORT (their own host):
  // rewrite to the MCP server's hostname so browsers elsewhere can reach them
  const serverUrl = new URL(url)
  const fixUrl = (link: string) => {
    try {
      const u = new URL(link)
      if (
        ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(u.hostname) &&
        !['localhost', '127.0.0.1'].includes(serverUrl.hostname)
      ) {
        // the app lives behind the same host/proxy as the MCP server:
        // inherit its protocol and host:port, keep only path + query
        u.protocol = serverUrl.protocol
        u.hostname = serverUrl.hostname
        u.port = serverUrl.port // '' clears an explicit port
        return u.toString()
      }
    } catch { /* not a URL */ }
    return link
  }

  const resources: McpUiResource[] = []
  const texts: string[] = []
  for (const item of content) {
    if (item?.type === 'text' && typeof item.text === 'string') {
      texts.push(item.text)
    } else if (item?.type === 'resource' && item.resource) {
      const r = item.resource
      const uri = typeof r.uri === 'string' ? r.uri : undefined
      const mime = typeof r.mimeType === 'string' ? r.mimeType : ''
      if (mime.startsWith('application/vnd.mcp-ui.remote-dom')) {
        resources.push({ remoteDom: true, title: uri, script: typeof r.text === 'string' ? r.text : undefined })
      } else if (mime === 'text/html' && typeof r.text === 'string') {
        resources.push({ html: r.text, title: uri })
      } else if (mime === 'text/uri-list' && typeof r.text === 'string') {
        const link = r.text.split('\n').find((l: string) => l.trim() && !l.startsWith('#'))
        if (link) resources.push({ url: fixUrl(link.trim()), title: uri })
      } else if (typeof r.text === 'string' && uri?.startsWith('ui://') && r.text.trim().startsWith('<')) {
        resources.push({ html: r.text, title: uri })
      } else if (uri?.startsWith('ui://')) {
        resources.push({ remoteDom: true, title: uri, script: typeof r.text === 'string' ? r.text : undefined })
      }
    }
  }
  return { text: texts.join('\n\n'), resources, structuredContent: call.result?.structuredContent }
}

/** Longest-prefix match of an opencode tool id (`server_tool`) to config entries. */
export function resolveMcpTool(
  mcp: Record<string, McpRemoteEntry>,
  toolId: string
): { server: string; entry: McpRemoteEntry; tool: string } | null {
  let best: string | null = null
  for (const name of Object.keys(mcp)) {
    if (toolId.startsWith(`${name}_`) && (!best || name.length > best.length)) best = name
  }
  if (!best) return null
  return { server: best, entry: mcp[best]!, tool: toolId.slice(best.length + 1) }
}
