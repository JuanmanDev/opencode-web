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
  const isLongRun = method === 'POST' && /\/(message|prompt_async|shell|command)$/.test(path)
  // connecting/authenticating an MCP server can take up to its own 30s timeout
  const isMcpAction = method === 'POST' && /^mcp\/[^/]+\/(connect|disconnect|auth)/.test(path)
  const signal = isEvent
    ? undefined
    : AbortSignal.timeout(isLongRun ? 1000 * 60 * 30 : isMcpAction ? 1000 * 60 : 15000)

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
  const skip = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive'])
  upstream.headers.forEach((value, key) => {
    if (!skip.has(key.toLowerCase())) setResponseHeader(event, key, value)
  })

  return upstream.body
})
