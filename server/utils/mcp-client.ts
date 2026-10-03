// Minimal MCP client for remote servers, shared by tool discovery and tool
// calls. Speaks Streamable HTTP and falls back to the legacy HTTP+SSE
// transport, as the spec's backwards-compatibility section describes —
// opencode itself connects either way, so the UI must too.
// Tool calls exist because opencode strips ui:// resources from tool outputs:
// UI apps are re-fetched from the source.

/** Tool as listed by an MCP server, trimmed for the UI. */
export interface McpToolInfo {
  name: string
  description?: string
  /** MCP Apps (SEP-1865): the tool declares a ui:// template -> it renders a UI */
  ui?: boolean
  /** `annotations.readOnlyHint`: safe to re-run to recover its UI */
  readOnly?: boolean
}

/** Normalize one `tools/list` entry; first description line only. */
export function toToolInfo(t: any): McpToolInfo {
  const meta = t?._meta || {}
  const resourceUri = meta?.ui?.resourceUri ?? meta?.['ui/resourceUri']
  return {
    name: String(t?.name || ''),
    description: typeof t?.description === 'string'
      ? t.description.split('\n')[0]!.slice(0, 140)
      : undefined,
    ...(typeof resourceUri === 'string' && resourceUri.startsWith('ui://') ? { ui: true } : {}),
    ...(t?.annotations?.readOnlyHint === true ? { readOnly: true } : {})
  }
}

/**
 * The built-in demo server is registered with whatever origin the browser had
 * at the time (dev port, LAN IP, the docker service name…). Always talk to
 * this very process instead: `selfOrigin` is its loopback address, which also
 * works behind a reverse proxy with forward auth in front.
 */
export function resolveDemoUrl(url: string, selfOrigin?: string) {
  if (!selfOrigin) return url
  try {
    if (new URL(url).pathname.replace(/\/$/, '') === '/mcp-demo') return `${selfOrigin}/mcp-demo`
  } catch { /* not a URL */ }
  return url
}

/** `http://<local address>:<port>` of the socket a request arrived on. */
export function loopbackOrigin(socket?: { localAddress?: string; localPort?: number }) {
  if (!socket?.localPort) return undefined
  let host = socket.localAddress || '127.0.0.1'
  if (host.startsWith('::ffff:')) host = host.slice(7)
  if (host === '::' || host === '0.0.0.0') host = '127.0.0.1'
  return `http://${host.includes(':') ? `[${host}]` : host}:${socket.localPort}`
}

/**
 * Pick the JSON-RPC payload out of a Streamable HTTP response body: plain JSON,
 * or an SSE stream where the matching response may not be the first event
 * (servers can emit progress notifications first).
 */
export function parseRpcBody(body: string, contentType: string, id: number | string) {
  if (!contentType.includes('text/event-stream')) return JSON.parse(body)
  let fallback: any
  for (const event of parseSseEvents(body)) {
    if (!event.data) continue
    try {
      const msg = JSON.parse(event.data)
      if (msg?.id === id) return msg
      fallback ??= msg
    } catch { /* keepalive or partial */ }
  }
  return fallback
}

/**
 * Split SSE text into events. Line endings may be LF or CRLF (Python servers
 * send CRLF); `data:` lines join with \n and lose one leading space.
 */
export function parseSseEvents(text: string): { event: string; data: string }[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n\n')
    .map((chunk) => {
      let event = 'message'
      const data: string[] = []
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      }
      return { event, data: data.join('\n') }
    })
    .filter((e) => e.data || e.event !== 'message')
}

export interface McpRemoteEntry {
  type?: string
  url?: string
  headers?: Record<string, string>
  enabled?: boolean
}

/** Non-2xx answer from an MCP endpoint; `status` drives the transport fallback. */
export class McpHttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`)
  }
}

/** One open MCP session, whatever the transport. */
export interface McpConnection {
  readonly transport: 'http' | 'sse'
  request(method: string, params?: Record<string, unknown>): Promise<any>
  notify(method: string, params?: Record<string, unknown>): Promise<void>
  close(): void
}

const CLIENT_INFO = { name: 'opencode-web', version: '1' }

function streamableConnection(url: string, headers: Record<string, string>, timeoutMs: number): McpConnection {
  let sessionId: string | undefined
  let nextId = 1
  const post = (payload: Record<string, unknown>, ms = timeoutMs) => fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      ...headers
    },
    body: JSON.stringify({ jsonrpc: '2.0', ...payload }),
    signal: AbortSignal.timeout(ms)
  })

  return {
    transport: 'http',
    async request(method, params = {}) {
      const id = nextId++
      const res = await post({ id, method, params })
      if (!res.ok) {
        await res.body?.cancel().catch(() => {})
        throw new McpHttpError(res.status)
      }
      sessionId = res.headers.get('mcp-session-id') || sessionId
      const payload = parseRpcBody(await res.text(), res.headers.get('content-type') || '', id)
      if (payload?.error) throw new Error(payload.error.message || 'MCP error')
      return payload?.result
    },
    async notify(method, params) {
      await post({ method, ...(params ? { params } : {}) }, Math.min(timeoutMs, 8000))
        .then((res) => res.body?.cancel())
        .catch(() => {})
    },
    close() {
      // stateful servers keep the session until told otherwise
      if (!sessionId) return
      fetch(url, {
        method: 'DELETE',
        headers: { 'mcp-session-id': sessionId, ...headers },
        signal: AbortSignal.timeout(3000)
      }).then((res) => res.body?.cancel()).catch(() => {})
    }
  }
}

// Legacy HTTP+SSE transport (pre-2025 spec): GET opens a stream that first
// announces a POST endpoint; JSON-RPC responses arrive back over the stream.
async function sseConnection(url: string, headers: Record<string, string>, timeoutMs: number): Promise<McpConnection> {
  const controller = new AbortController()
  const connectTimer = setTimeout(() => controller.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetch(url, { headers: { accept: 'text/event-stream', ...headers }, signal: controller.signal })
  } catch (error) {
    controller.abort()
    throw controller.signal.aborted ? new Error('SSE connect timeout') : error
  } finally {
    clearTimeout(connectTimer)
  }
  if (!res.ok || !res.body) {
    controller.abort()
    throw new McpHttpError(res.status)
  }

  const pending = new Map<number, { resolve: (msg: any) => void; reject: (error: Error) => void }>()
  let endpoint: string | undefined
  let closed: Error | undefined
  let onEndpoint: (() => void) | undefined

  const fail = (error: Error) => {
    closed ??= error
    for (const p of pending.values()) p.reject(closed)
    pending.clear()
    onEndpoint?.()
  }

  ;(async () => {
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        // normalize CRLF; a trailing lone \r may be the first half of one
        buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n')
        let idx: number
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const [event] = parseSseEvents(buffer.slice(0, idx + 2))
          buffer = buffer.slice(idx + 2)
          if (!event) continue
          if (event.event === 'endpoint') {
            endpoint = event.data
            onEndpoint?.()
            continue
          }
          try {
            const msg = JSON.parse(event.data)
            const waiter = msg?.id != null ? pending.get(msg.id) : undefined
            if (waiter) {
              pending.delete(msg.id)
              waiter.resolve(msg)
            }
          } catch { /* non-JSON event */ }
        }
      }
      fail(new Error('SSE stream closed'))
    } catch {
      fail(new Error('SSE stream closed'))
    }
  })()

  if (!endpoint && !closed) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SSE timeout: no endpoint event')), timeoutMs)
      onEndpoint = () => { clearTimeout(timer); resolve() }
    }).catch((error) => {
      controller.abort()
      throw error
    })
  }
  if (!endpoint) {
    controller.abort()
    throw closed || new Error('SSE stream closed')
  }
  const postUrl = new URL(endpoint, url).toString()

  const post = (payload: Record<string, unknown>) => fetch(postUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', ...payload }),
    signal: AbortSignal.timeout(timeoutMs)
  })

  let nextId = 1
  return {
    transport: 'sse',
    async request(method, params = {}) {
      if (closed) throw closed
      const id = nextId++
      const reply = new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`${method}: timeout`))
        }, timeoutMs)
        pending.set(id, {
          resolve: (msg) => { clearTimeout(timer); resolve(msg) },
          reject: (error) => { clearTimeout(timer); reject(error) }
        })
      })
      reply.catch(() => {}) // may be abandoned below when the POST itself fails
      const abandon = (error: Error) => {
        pending.get(id)?.reject(error)
        pending.delete(id)
        return error
      }
      const res = await post({ id, method, params }).catch((error) => {
        throw abandon(error instanceof Error ? error : new Error(String(error)))
      })
      await res.body?.cancel().catch(() => {})
      if (!res.ok) throw abandon(new McpHttpError(res.status))
      const msg = await reply
      if (msg?.error) throw new Error(msg.error.message || 'MCP error')
      return msg?.result
    },
    async notify(method, params) {
      await post({ method, ...(params ? { params } : {}) })
        .then((res) => res.body?.cancel())
        .catch(() => {})
    },
    close() {
      controller.abort()
    }
  }
}

export interface ConnectOptions {
  timeoutMs?: number
  protocolVersion?: string
  capabilities?: Record<string, unknown>
}

/**
 * Open an initialized session. Streamable HTTP first; a 4xx other than an
 * auth error means a legacy SSE-only server (spec back-compat). URLs ending
 * in /sse try the old transport first to save the round trip.
 */
export async function connectMcp(
  url: string,
  headers: Record<string, string> = {},
  opts: ConnectOptions = {}
): Promise<{ conn: McpConnection; init: any }> {
  const timeoutMs = opts.timeoutMs ?? 15000
  const sseFirst = /\/sse\/?$/.test(new URL(url).pathname)
  const order: ('http' | 'sse')[] = sseFirst ? ['sse', 'http'] : ['http', 'sse']
  const errors: string[] = []

  for (const transport of order) {
    let conn: McpConnection | undefined
    try {
      conn = transport === 'http'
        ? streamableConnection(url, headers, timeoutMs)
        : await sseConnection(url, headers, timeoutMs)
      const init = await conn.request('initialize', {
        protocolVersion: opts.protocolVersion ?? (transport === 'sse' ? '2024-11-05' : '2025-06-18'),
        capabilities: opts.capabilities ?? {},
        clientInfo: CLIENT_INFO
      })
      // stateful servers reject requests that arrive before this notification
      await conn.notify('notifications/initialized')
      return { conn, init }
    } catch (error) {
      conn?.close()
      const message = error instanceof Error ? error.message : String(error)
      errors.push(errors.length ? `${transport === 'sse' ? 'SSE' : 'HTTP'} fallback: ${message}` : message)
      const status = error instanceof McpHttpError ? error.status : 0
      const retry = status >= 400 && status < 500 && status !== 401 && status !== 403
      // a /sse URL that times out or closes is worth one Streamable HTTP try
      if (!retry && !(sseFirst && transport === 'sse')) break
    }
  }
  throw new Error(errors.join('; '))
}

/** Run `fn` inside an initialized session; always closes it. */
export async function withMcp<T>(
  url: string,
  headers: Record<string, string>,
  fn: (conn: McpConnection, init: any) => Promise<T>,
  opts?: ConnectOptions
): Promise<T> {
  const { conn, init } = await connectMcp(url, headers, opts)
  try {
    return await fn(conn, init)
  } finally {
    conn.close()
  }
}

/** `tools/list` of a remote server, trimmed for the UI. */
export function listRemoteTools(url: string, headers: Record<string, string> = {}, timeoutMs = 8000) {
  return withMcp(url, headers, async (conn) => {
    const list = await conn.request('tools/list', {})
    const tools = Array.isArray(list?.tools) ? list.tools : []
    return tools.map(toToolInfo).filter((t: McpToolInfo) => t.name)
  }, { timeoutMs })
}

export interface McpUiResource {
  html?: string
  url?: string
  title?: string
  /** mcp-ui remote-dom component script, rendered in a generic host shell */
  remoteDom?: boolean
  script?: string
}

export interface McpUiRecovery {
  /** whether the tool was actually executed (mode 'call') */
  called: boolean
  /** tool declares itself free of side effects (`annotations.readOnlyHint`) */
  readOnly: boolean
  text: string
  resources: McpUiResource[]
  structuredContent?: unknown
  /** MCP Apps (SEP-1865) template declared by the tool */
  app: { resourceUri: string; html: string } | null
}

/** opencode's tool ids: `sanitize(server)_sanitize(tool)`. */
export function sanitizeToolName(name: string) {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_')
}

/** Only links a browser may load in a frame or new tab: never javascript:/data: */
export function isSafeLink(link: string) {
  try {
    return ['http:', 'https:'].includes(new URL(link).protocol)
  } catch {
    return false
  }
}

/**
 * Recover what opencode strips from MCP tool outputs, in one session:
 * - mode 'template': never executes the tool, only reads its MCP Apps template
 * - mode 'call': re-runs the tool for its embedded ui:// resources and
 *   structuredContent. Callers should reserve this for read-only tools or an
 *   explicit user action: tools may have side effects.
 * `tool` may be opencode's sanitized name; it is matched against tools/list.
 */
export function recoverToolUi(
  url: string,
  headers: Record<string, string>,
  tool: string,
  args: Record<string, unknown>,
  mode: 'template' | 'call'
): Promise<McpUiRecovery> {
  return withMcp(url, headers, async (conn) => {
    const list = await conn.request('tools/list', {})
    const tools: any[] = Array.isArray(list?.tools) ? list.tools : []
    const found = tools.find((t) => t?.name === tool) ?? tools.find((t) => sanitizeToolName(String(t?.name)) === tool)
    const name = typeof found?.name === 'string' ? found.name : tool
    const readOnly = found?.annotations?.readOnlyHint === true

    const resourceUri = found?._meta?.ui?.resourceUri ?? found?._meta?.['ui/resourceUri']
    let app: McpUiRecovery['app'] = null
    if (typeof resourceUri === 'string' && resourceUri.startsWith('ui://')) {
      const read = await conn.request('resources/read', { uri: resourceUri }).catch(() => null)
      const content = (read?.contents || [])[0]
      if (typeof content?.text === 'string') app = { resourceUri, html: content.text }
    }

    if (mode === 'template') return { called: false, readOnly, text: '', resources: [], app }

    const call = await conn.request('tools/call', { name, arguments: args })
    return { called: true, readOnly, app, ...extractUiResources(call, url) }
  }, {
    protocolVersion: '2026-01-26',
    capabilities: {
      extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } }
    }
  })
}

/** Pull text, ui:// resources and structuredContent out of a tools/call result. */
export function extractUiResources(call: any, serverUrl: string) {
  const content = Array.isArray(call?.content) ? call.content : []

  // servers often return app links as http://localhost:PORT (their own host):
  // rewrite to the MCP server's hostname so browsers elsewhere can reach them
  const server = new URL(serverUrl)
  const fixUrl = (link: string) => {
    try {
      const u = new URL(link)
      if (
        ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(u.hostname) &&
        !['localhost', '127.0.0.1'].includes(server.hostname)
      ) {
        // the app lives behind the same host/proxy as the MCP server:
        // inherit its protocol and host:port, keep only path + query
        u.protocol = server.protocol
        u.hostname = server.hostname
        u.port = server.port // '' clears an explicit port
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
        const link = r.text.split('\n').find((l: string) => l.trim() && !l.startsWith('#'))?.trim()
        if (link && isSafeLink(link)) resources.push({ url: fixUrl(link), title: uri })
      } else if (typeof r.text === 'string' && uri?.startsWith('ui://') && r.text.trim().startsWith('<')) {
        resources.push({ html: r.text, title: uri })
      } else if (uri?.startsWith('ui://')) {
        resources.push({ remoteDom: true, title: uri, script: typeof r.text === 'string' ? r.text : undefined })
      }
    }
  }
  return { text: texts.join('\n\n'), resources, structuredContent: call?.structuredContent }
}

/**
 * Longest-prefix match of an opencode tool id (`server_tool`) to config
 * entries. Both sides are compared sanitized, as opencode builds the ids.
 */
export function resolveMcpTool(
  mcp: Record<string, McpRemoteEntry>,
  toolId: string
): { server: string; entry: McpRemoteEntry; tool: string } | null {
  let best: string | null = null
  for (const name of Object.keys(mcp)) {
    const prefix = `${sanitizeToolName(name)}_`
    if (toolId.startsWith(prefix) && (!best || name.length > best.length)) best = name
  }
  if (!best) return null
  return { server: best, entry: mcp[best]!, tool: toolId.slice(sanitizeToolName(best).length + 1) }
}
