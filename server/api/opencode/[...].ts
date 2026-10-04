import { Buffer } from 'node:buffer'
import { joinURL } from 'ufo'
import type { H3Event } from 'h3'
import { mirrorLegacyEvents } from '../../utils/compat/v2/events'

// Same-origin proxy to the opencode server.
// The browser only ever talks to this Nuxt app, which makes the whole UI work
// behind reverse proxies / forward-auth (Traefik + tinyauth) without CORS or
// double-auth issues. Basic auth against opencode is injected here, server-side.
//
// Implemented with a manual fetch instead of h3's proxyRequest: request bodies
// are buffered (chunked uploads break some upstreams) and responses are
// streamed back, which keeps SSE (/event) working.
//
// The UI always speaks opencode's 1.x API. A server that only speaks the v2
// protocol (`/api/*`) gets every request translated (utils/compat.ts).
export default defineEventHandler(async (event) => {
  requireApiToken(event)
  const config = useRuntimeConfig()
  const path = event.context.params?._ ?? ''
  const method = event.method

  // a browser that goes away (reload, closed tab, EventSource reconnect) must
  // release its upstream request: otherwise every /event stream leaks one
  // opencode subscriber for as long as the app runs
  const disconnect = new AbortController()
  event.node.res.once('close', () => {
    if (!event.node.res.writableFinished) disconnect.abort()
  })

  const profile = await getServerProfile()
  if (profile.protocol === 'v2') return proxyV2(event, path, disconnect.signal)

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

  // opencode >= 1.4 serves its own web UI on every unknown path, so a route
  // this version lacks "succeeds" with HTML: report it as missing instead
  if (upstream.ok && (upstream.headers.get('content-type') || '').includes('text/html')) {
    await upstream.body?.cancel().catch(() => {})
    throw createError({
      statusCode: 404,
      statusMessage: 'Not Found',
      message: `opencode${profile.version ? ` ${profile.version}` : ''} has no ${method} /${path}`
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

  if (profile.hybrid && upstream.ok) {
    // sessions run by the v2 engine (the new TUI) on a 1.18+ server: their
    // messages are empty on the legacy route and their live events arrive as
    // session.next.* - translate both so they render like any other session
    const messages = method === 'GET' && /^session\/([^/]+)\/message\/?$/.exec(path)
    if (messages) {
      const data = await upstream.json().catch(() => null)
      if (Array.isArray(data) && data.length === 0) {
        return v2MessagesFallback(messages[1]!, getQuery(event).directory as string | undefined).catch(() => data)
      }
      return data
    }
    if (isEvent && upstream.body) return mirrorLegacyEvents(upstream.body)
  }

  return upstream.body
})

/** opencode v2-only server: translate the legacy request, or stream translated events. */
async function proxyV2(event: H3Event, path: string, signal: AbortSignal) {
  const query = getQuery(event) as Record<string, string | undefined>
  if (path === 'event' || path === 'global/event') {
    setResponseHeaders(event, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no'
    })
    const encoder = new TextEncoder()
    let unsubscribe = () => {}
    return new ReadableStream<Uint8Array>({
      start(controller) {
        unsubscribe = v2Subscribe(path === 'event' ? query.directory : undefined, (frame) => {
          try { controller.enqueue(encoder.encode(frame)) } catch { unsubscribe() }
        })
        signal.addEventListener('abort', () => {
          unsubscribe()
          try { controller.close() } catch { /* already closed */ }
        }, { once: true })
      },
      cancel() { unsubscribe() }
    })
  }

  const method = event.method
  const body = method !== 'GET' && method !== 'HEAD' ? await readBody(event).catch(() => undefined) : undefined
  try {
    // the browser ignores prompt replies (they stream in as events): answer
    // as soon as the prompt is admitted
    const result = await v2Request({ method, path, query, body, wait: false, signal })
    return result === undefined ? true : redactSecrets(result)
  } catch (error) {
    throw compatToH3Error(error)
  }
}
