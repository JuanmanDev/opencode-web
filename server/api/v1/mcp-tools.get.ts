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

// Legacy HTTP+SSE transport (pre-2025 spec): GET opens a stream that first
// announces a POST endpoint; JSON-RPC responses arrive back over the stream.
async function fetchToolsSse(url: string, headers: Record<string, string>): Promise<ToolInfo[]> {
  const controller = new AbortController()
  const kill = setTimeout(() => controller.abort(), 12000)
  try {
    const res = await fetch(url, {
      headers: { accept: 'text/event-stream', ...headers },
      signal: controller.signal
    })
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let endpoint: string | null = null
    const pending = new Map<number, (msg: any) => void>()

    const processBuffer = () => {
      let idx: number
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const eventName = chunk.match(/^event:\s*(.+)$/m)?.[1]?.trim() || 'message'
        const data = chunk.split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('\n')
        if (eventName === 'endpoint') {
          endpoint = data
        } else if (data) {
          try {
            const msg = JSON.parse(data)
            if (msg.id != null && pending.has(msg.id)) {
              pending.get(msg.id)!(msg)
              pending.delete(msg.id)
            }
          } catch { /* non-JSON event */ }
        }
      }
    }

    ;(async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          processBuffer()
        }
      } catch { /* aborted */ }
    })()

    const waitFor = <T>(check: () => T | null | undefined, ms: number) =>
      new Promise<T>((resolve, reject) => {
        const iv = setInterval(() => {
          const value = check()
          if (value != null) { clearInterval(iv); resolve(value) }
        }, 50)
        setTimeout(() => { clearInterval(iv); reject(new Error('SSE timeout')) }, ms)
      })

    await waitFor(() => endpoint, 6000)
    const postUrl = new URL(endpoint!, url).toString()

    const call = (id: number, method: string, params: Record<string, unknown>) => {
      const reply = new Promise<any>((resolve) => pending.set(id, resolve))
      return fetch(postUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: controller.signal
      }).then(() => Promise.race([
        reply,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('RPC timeout')), 6000))
      ]))
    }

    const init = await call(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'opencode-web', version: '1' }
    })
    if (init?.error) throw new Error(init.error.message || 'initialize failed')
    fetch(postUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      signal: controller.signal
    }).catch(() => {})

    const list = await call(2, 'tools/list', {})
    if (list?.error) throw new Error(list.error.message || 'tools/list failed')
    const tools = Array.isArray(list?.result?.tools) ? list.result.tools : []
    return tools
      .map((t: any) => ({
        name: String(t?.name || ''),
        description: typeof t?.description === 'string'
          ? t.description.split('\n')[0]!.slice(0, 140)
          : undefined
      }))
      .filter((t: ToolInfo) => t.name)
  } finally {
    clearTimeout(kill)
    controller.abort()
  }
}

// tool discovery is slow (talks to every remote MCP server) -> cached with SWR
const getAllTools = defineCachedFunction(
  async (directory?: string, scope?: string) => {
  const config = await opencodeFetch<{ mcp?: Record<string, McpConfigEntry> }>(
    scope === 'global' ? '/global/config' : '/config',
    { query: scope === 'global' ? {} : { directory } }
  ).catch(() => ({ mcp: {} as Record<string, McpConfigEntry> }))

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
      const message = error instanceof Error ? error.message : String(error)
      // 404/405 usually means a legacy SSE-only server: try the old transport
      if (/40[45]/.test(message)) {
        try {
          results[name] = { tools: await fetchToolsSse(entry.url, entry.headers || {}) }
          return
        } catch (sseError) {
          results[name] = {
            tools: [],
            error: `${message}; SSE fallback: ${sseError instanceof Error ? sseError.message : sseError}`
          }
          return
        }
      }
      results[name] = { tools: [], error: message }
    }
  }))

  return results
  },
  {
    name: 'mcp-tools',
    maxAge: 120,
    swr: true,
    getKey: (directory?: string, scope?: string) =>
      `${scope || 'project'}:${encodeURIComponent(directory || '')}`
  }
)

export default defineEventHandler(async (event) => {
  requireApiToken(event) // auth on every request; only discovery work is cached
  const { directory, scope } = getQuery(event) as { directory?: string; scope?: string }
  return getAllTools(directory, scope)
})
