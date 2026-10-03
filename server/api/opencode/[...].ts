import { Buffer } from 'node:buffer'
import { joinURL } from 'ufo'

// Same-origin proxy to the opencode server.
// The browser only ever talks to this Nuxt app, which makes the whole UI work
// behind reverse proxies / forward-auth (Traefik + tinyauth) without CORS or
// double-auth issues. Basic auth against opencode is injected here, server-side.
//
// Implemented with a manual fetch instead of h3's proxyRequest: request bodies
// are buffered (chunked uploads break some upstreams) and responses are
// streamed back, which keeps SSE (/event) working.
export default defineEventHandler(async (event) => {
  requireApiToken(event)
  const config = useRuntimeConfig()
  const path = event.context.params?._ ?? ''
  const search = getRequestURL(event).search
  const target = joinURL(config.opencodeUrl, path) + search

  const headers: Record<string, string> = {}
  const contentType = getHeader(event, 'content-type')
  if (contentType) headers['content-type'] = contentType
  const accept = getHeader(event, 'accept')
  if (accept) headers.accept = accept
  if (config.opencodePassword) {
    headers.authorization =
      'Basic ' + Buffer.from(`${config.opencodeUsername}:${config.opencodePassword}`).toString('base64')
  }

  const method = event.method
  let body: Uint8Array | undefined
  if (method !== 'GET' && method !== 'HEAD') {
    const raw = await readRawBody(event, false)
    if (raw) body = new Uint8Array(Buffer.isBuffer(raw) ? raw : Buffer.from(raw))
  }

  // fail fast when the opencode server hangs, but never cut streams or prompts:
  // - /event (SSE) stays open forever
  // - prompt/shell/command POSTs may legitimately run for many minutes
  const isEvent = path === 'event' || path.endsWith('/event')
  const isLongRun = method === 'POST' && /\/(message|prompt_async|shell|command|summarize|init)$/.test(path)
  // connecting/authenticating an MCP server can take up to its own 30s timeout
  const isMcpAction = method === 'POST' && /^mcp\/[^/]+\/(connect|disconnect|auth)/.test(path)
  // GET /mcp makes opencode (re)connect every configured server first; each
  // broken local one burns its own 30s timeout, so the aggregate easily exceeds
  // a minute on a box with several stale `npx` servers
  const isMcpStatus = method === 'GET' && /^mcp\/?$/.test(path)
  // a browser that goes away (reload, closed tab, EventSource reconnect) must
  // release its upstream request: otherwise every /event stream leaks one
  // opencode subscriber for as long as the app runs
  const disconnect = new AbortController()
  event.node.res.once('close', () => {
    if (!event.node.res.writableFinished) disconnect.abort()
  })
  const signal = isEvent
    ? disconnect.signal
    : AbortSignal.any([
      disconnect.signal,
      AbortSignal.timeout(
        isLongRun ? 1000 * 60 * 30 : isMcpStatus ? 1000 * 120 : isMcpAction ? 1000 * 60 : 30000
      )
    ])

  let upstream: Response
  try {
    upstream = await fetch(target, { method, headers, body: body as BodyInit | undefined, signal })
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError'
    throw createError({
      statusCode: timedOut ? 504 : 502,
      statusMessage: timedOut ? 'Gateway Timeout' : 'Bad Gateway',
      message: timedOut
        ? 'opencode server did not respond in time'
        : `opencode server unreachable: ${error instanceof Error ? error.message : error}`
    })
  }

  setResponseStatus(event, upstream.status)
  // www-authenticate would pop the browser's basic-auth dialog whenever the
  // configured opencode password is wrong: there is nothing to type there
  const skip = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'www-authenticate'])
  upstream.headers.forEach((value, key) => {
    if (!skip.has(key.toLowerCase())) setResponseHeader(event, key, value)
  })

  // opencode returns raw API keys and MCP credentials from its config routes.
  // The UI only ever *writes* them, so never let them reach the browser.
  if (method === 'GET' && /^(global\/)?config(\/providers)?\/?$/.test(path) && upstream.ok) {
    try {
      const data = await upstream.json()
      return redactSecrets(data)
    } catch {
      throw createError({ statusCode: 502, statusMessage: 'Bad Gateway', message: 'invalid config response' })
    }
  }

  return upstream.body
})
