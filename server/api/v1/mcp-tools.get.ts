// Fetch the tool lists of a project's MCP servers by speaking MCP to them
// directly — opencode exposes no MCP tool ids at all (`/experimental/tool[/ids]`
// only returns built-in and plugin tools). Remote servers are queried over
// Streamable HTTP (with a legacy SSE fallback), local ones are spawned and
// spoken to over stdio.

import { fetchToolsStdio } from '../../utils/mcp-stdio'
import { parseRpcBody, resolveDemoUrl, toToolInfo, type McpToolInfo } from '../../utils/mcp-client'

interface McpConfigEntry {
  type?: string
  url?: string
  headers?: Record<string, string>
  command?: string[]
  environment?: Record<string, string>
  enabled?: boolean
}

export interface McpToolsResult {
  tools: ToolInfo[]
  error?: string
  /** disabled in the config: never probed, so neither tools nor errors */
  disabled?: boolean
  transport?: 'remote' | 'local'
  /** local server spawned here while opencode runs elsewhere: names only */
  approx?: boolean
  /** local discovery is switched off for this deployment */
  skipped?: boolean
}

/** Does opencode run on this very host? Only then is a local spawn exact. */
function opencodeIsLocal() {
  try {
    const { hostname } = new URL(useRuntimeConfig().opencodeUrl)
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)
  } catch {
    return false
  }
}

type ToolInfo = McpToolInfo

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
  const payload = parseRpcBody(await res.text(), res.headers.get('content-type') || '', id)
  if (payload?.error) throw new Error(payload.error.message || 'MCP error')
  return { result: payload?.result, sessionId: newSession }
}

async function fetchTools(url: string, headers: Record<string, string>): Promise<ToolInfo[]> {
  const init = await rpc(url, headers, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'opencode-web', version: '1' }
  }, 1)
  // stateful servers reject requests that arrive before this notification
  await fetch(url, {
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
    .map(toToolInfo)
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
      .map(toToolInfo)
      .filter((t: ToolInfo) => t.name)
  } finally {
    clearTimeout(kill)
    controller.abort()
  }
}

/** Discover one server's tools; never throws — failures land in `error`. */
async function probe(entry: McpConfigEntry, selfOrigin?: string): Promise<McpToolsResult> {
  // disabled servers are never contacted: probing them produced phantom
  // errors in the UI (e.g. 401 from a server the user deliberately turned off)
  if (entry?.enabled === false) return { tools: [], disabled: true }

  if (entry?.type === 'remote' && entry.url) {
    const url = resolveDemoUrl(entry.url, selfOrigin)
    try {
      return { tools: await fetchTools(url, entry.headers || {}), transport: 'remote' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // 404/405 usually means a legacy SSE-only server: try the old transport
      if (/40[45]/.test(message)) {
        try {
          return { tools: await fetchToolsSse(url, entry.headers || {}), transport: 'remote' }
        } catch (sseError) {
          return {
            tools: [],
            transport: 'remote',
            error: `${message}; SSE fallback: ${sseError instanceof Error ? sseError.message : sseError}`
          }
        }
      }
      return { tools: [], transport: 'remote', error: message }
    }
  }

  if (entry?.type === 'local' && entry.command?.length) {
    // stdio servers can only be listed by running them: that happens here, in
    // this app, so the result is exact only when opencode is on this host
    const policy = String(useRuntimeConfig().mcpLocalDiscovery || 'always')
    const local = opencodeIsLocal()
    if (policy === 'never' || (policy === 'same-host' && !local)) {
      return { tools: [], transport: 'local', skipped: true }
    }
    try {
      return {
        tools: await fetchToolsStdio(entry.command, entry.environment),
        transport: 'local',
        ...(local ? {} : { approx: true })
      }
    } catch (error) {
      return {
        tools: [],
        transport: 'local',
        ...(local ? {} : { approx: true }),
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  // neither shape: opencode itself ignores such entries
  return {
    tools: [],
    error: entry?.type ? undefined : 'config entry has no "type" — opencode ignores it'
  }
}

// discovery is slow (every server is contacted, local ones are spawned)
// -> cached with stale-while-revalidate
const getAllTools = defineCachedFunction(discoverAll, {
  name: 'mcp-tools',
  maxAge: 300,
  swr: true,
  getKey: (directory?: string, scope?: string, _selfOrigin?: string) =>
    `${scope || 'project'}:${encodeURIComponent(directory || '')}`
})

async function discoverAll(directory?: string, scope?: string, selfOrigin?: string) {
  // no fallback here: swallowing a failed /config used to cache an empty
  // result for 5 minutes, so the MCP page stayed blank long after opencode
  // came back. Let the error propagate - the cache only stores successes.
  const config = await opencodeFetch<{ mcp?: Record<string, McpConfigEntry> }>(
    scope === 'global' ? '/global/config' : '/config',
    { query: scope === 'global' ? {} : { directory }, timeoutMs: 30000 }
  ).catch((error) => {
    throw createError({
      statusCode: 502,
      statusMessage: 'Bad Gateway',
      message: `opencode config unavailable: ${error instanceof Error ? error.message : error}`
    })
  })

  const entries = Object.entries(config.mcp || {})
  const results: Record<string, McpToolsResult> = {}
  await Promise.all(entries.map(async ([name, entry]) => {
    results[name] = await probe(entry, selfOrigin)
  }))
  return results
}

export default defineEventHandler(async (event) => {
  requireApiToken(event) // auth on every request; only discovery work is cached
  const { directory, scope, refresh } = getQuery(event) as {
    directory?: string
    scope?: string
    refresh?: string
  }
  // the MCP page's refresh button must re-probe, not replay the cache
  const selfOrigin = getRequestURL(event).origin
  return refresh ? discoverAll(directory, scope, selfOrigin) : getAllTools(directory, scope, selfOrigin)
})
