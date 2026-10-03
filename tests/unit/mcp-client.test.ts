import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  isSafeLink,
  listRemoteTools,
  loopbackOrigin,
  parseRpcBody,
  parseSseEvents,
  recoverToolUi,
  resolveDemoUrl,
  resolveMcpTool
} from '../../server/utils/mcp-client'

const TOOLS = [
  { name: 'echo', description: 'Echo text back\nsecond line' },
  { name: 'chart', description: 'Chart app', _meta: { ui: { resourceUri: 'ui://demo/chart' } }, annotations: { readOnlyHint: true } },
  { name: 'odd.name', description: 'Dotted' }
]
let calls = 0

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => resolve(body ? JSON.parse(body) : {}))
  })
}

function answer(msg: any) {
  switch (msg.method) {
    case 'initialize':
      return { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 't', version: '1' } }
    case 'tools/list':
      return { tools: TOOLS }
    case 'resources/read':
      return { contents: [{ uri: msg.params.uri, mimeType: 'text/html;profile=mcp-app', text: '<p>app</p>' }] }
    case 'tools/call':
      calls++
      return {
        content: [
          { type: 'text', text: `${msg.params.name}:${msg.params.arguments.text}` },
          { type: 'resource', resource: { uri: 'ui://demo/x', mimeType: 'text/html', text: '<b>hi</b>' } },
          { type: 'resource', resource: { uri: 'ui://demo/link', mimeType: 'text/uri-list', text: 'http://localhost:9999/app?a=1' } },
          { type: 'resource', resource: { uri: 'ui://demo/evil', mimeType: 'text/uri-list', text: 'javascript:alert(1)' } }
        ],
        structuredContent: { ok: true }
      }
  }
}

let server: Server
let base = ''
const seen: string[] = []
let initializedNotified = false

beforeAll(async () => {
  const sseClients = new Map<string, ServerResponse>()
  server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://x')
    seen.push(`${req.method} ${url.pathname}`)

    // Streamable HTTP server answering in SSE framing, session id required
    if (url.pathname === '/mcp') {
      if (req.method === 'DELETE') return res.writeHead(204).end()
      const msg = await readJson(req)
      if (msg.method === 'notifications/initialized') {
        initializedNotified = req.headers['mcp-session-id'] === 'sess-1'
        return res.writeHead(202).end()
      }
      if (msg.method !== 'initialize' && req.headers['mcp-session-id'] !== 'sess-1') {
        return res.writeHead(400).end('missing session')
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-1' })
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })}\n\n`)
      return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: answer(msg) })}\n\n`)
    }

    if (url.pathname === '/auth') return res.writeHead(401).end('nope')

    // Legacy HTTP+SSE server with CRLF line endings, like Python's mcp SDK
    if (url.pathname === '/sse' || url.pathname === '/legacy') {
      if (req.method !== 'GET') return res.writeHead(405).end()
      const id = String(sseClients.size + 1)
      sseClients.set(id, res)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      // split the endpoint event across writes, CR and LF in separate chunks
      res.write('event: endpoint\r')
      setTimeout(() => res.write(`\ndata: /messages/?session_id=${id}\r\n\r`), 5)
      setTimeout(() => res.write('\n'), 10)
      return
    }
    if (url.pathname === '/messages/') {
      const client = sseClients.get(url.searchParams.get('session_id') || '')
      if (!client) return res.writeHead(404).end()
      const msg = await readJson(req)
      res.writeHead(202).end('Accepted')
      if (msg.id != null) {
        client.write(`event: message\r\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: answer(msg) })}\r\n\r\n`)
      }
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  server.closeAllConnections()
  server.close()
})

describe('parseSseEvents', () => {
  it('handles CRLF and multi-line data', () => {
    expect(parseSseEvents('event: endpoint\r\ndata: /m?x=1\r\n\r\ndata: a\r\ndata:b\r\n\r\n')).toEqual([
      { event: 'endpoint', data: '/m?x=1' },
      { event: 'message', data: 'a\nb' }
    ])
  })

  it('parseRpcBody picks the matching id after notifications', () => {
    const body = 'data: {"jsonrpc":"2.0","method":"x"}\r\n\r\ndata: {"jsonrpc":"2.0","id":7,"result":1}\r\n\r\n'
    expect(parseRpcBody(body, 'text/event-stream', 7)).toEqual({ jsonrpc: '2.0', id: 7, result: 1 })
  })
})

describe('remote MCP client', () => {
  it('lists tools over Streamable HTTP with a session id', async () => {
    const tools = await listRemoteTools(`${base}/mcp`)
    expect(tools).toEqual([
      { name: 'echo', description: 'Echo text back' },
      { name: 'chart', description: 'Chart app', ui: true, readOnly: true },
      { name: 'odd.name', description: 'Dotted' }
    ])
    expect(initializedNotified).toBe(true)
  })

  it('falls back to legacy SSE (CRLF) when POST is rejected', async () => {
    const tools = await listRemoteTools(`${base}/legacy`)
    expect(tools.map((t) => t.name)).toEqual(['echo', 'chart', 'odd.name'])
    expect(seen).toContain('POST /legacy')
  })

  it('goes straight to SSE for /sse URLs', async () => {
    seen.length = 0
    const tools = await listRemoteTools(`${base}/sse`)
    expect(tools).toHaveLength(3)
    expect(seen).not.toContain('POST /sse')
  })

  it('does not fall back on auth errors', async () => {
    await expect(listRemoteTools(`${base}/auth`)).rejects.toThrow(/^HTTP 401$/)
  })

  it('calls tools over SSE and extracts UI resources, http(s) links only', async () => {
    const result = await recoverToolUi(`${base}/sse`, {}, 'echo', { text: 'hey' }, 'call')
    expect(result.called).toBe(true)
    expect(result.readOnly).toBe(false)
    expect(result.text).toBe('echo:hey')
    expect(result.structuredContent).toEqual({ ok: true })
    expect(result.resources).toEqual([
      { html: '<b>hi</b>', title: 'ui://demo/x' },
      // localhost links are rewritten only when the MCP server is elsewhere
      { url: 'http://localhost:9999/app?a=1', title: 'ui://demo/link' }
    ])
  })

  it('template mode reads MCP Apps templates without running the tool', async () => {
    const before = calls
    const chart = await recoverToolUi(`${base}/mcp`, {}, 'chart', {}, 'template')
    expect(chart).toMatchObject({ called: false, readOnly: true, app: { resourceUri: 'ui://demo/chart', html: '<p>app</p>' } })
    expect((await recoverToolUi(`${base}/mcp`, {}, 'echo', {}, 'template')).app).toBeNull()
    expect(calls).toBe(before)
  })

  it('maps opencode-sanitized tool names back to the real ones', async () => {
    const result = await recoverToolUi(`${base}/mcp`, {}, 'odd_name', { text: 'x' }, 'call')
    expect(result.text).toBe('odd.name:x')
  })
})

describe('tool ids and links', () => {
  it('matches sanitized server names, longest prefix first', () => {
    const mcp = { 'my.server': { type: 'remote', url: 'http://a' }, my: { type: 'remote', url: 'http://b' } }
    expect(resolveMcpTool(mcp, 'my_server_do_it')).toMatchObject({ server: 'my.server', tool: 'do_it' })
    expect(resolveMcpTool(mcp, 'my_thing')).toMatchObject({ server: 'my', tool: 'thing' })
    expect(resolveMcpTool(mcp, 'other_x')).toBeNull()
  })

  it('only allows http(s) links', () => {
    expect(isSafeLink('https://example.com/app')).toBe(true)
    expect(isSafeLink('javascript:alert(1)')).toBe(false)
    expect(isSafeLink('data:text/html,<script>1</script>')).toBe(false)
  })
})

describe('demo URL resolution', () => {
  it('formats the loopback origin of the receiving socket', () => {
    expect(loopbackOrigin({ localAddress: '::ffff:172.18.0.3', localPort: 3000 })).toBe('http://172.18.0.3:3000')
    expect(loopbackOrigin({ localAddress: '::1', localPort: 3011 })).toBe('http://[::1]:3011')
    expect(loopbackOrigin({})).toBeUndefined()
  })

  it('rewrites only /mcp-demo URLs', () => {
    expect(resolveDemoUrl('http://web:3000/mcp-demo', 'http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000/mcp-demo')
    expect(resolveDemoUrl('https://mcp.context7.com/mcp', 'http://127.0.0.1:3000')).toBe('https://mcp.context7.com/mcp')
  })
})
