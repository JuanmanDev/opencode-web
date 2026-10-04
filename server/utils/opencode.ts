import { Buffer } from 'node:buffer'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { joinURL } from 'ufo'
import type { H3Event } from 'h3'

/** Server-side client for the opencode API (auth injected, directory scoped). */
export function opencodeFetch<T = unknown>(
  path: string,
  opts: {
    method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
    body?: unknown
    query?: Record<string, string | undefined>
    timeoutMs?: number
  } = {}
): Promise<T> {
  const config = useRuntimeConfig()
  const headers: Record<string, string> = {}
  if (config.opencodePassword) {
    headers.authorization =
      'Basic ' + Buffer.from(`${config.opencodeUsername}:${config.opencodePassword}`).toString('base64')
  }
  // untyped alias: dynamic URLs make nitro's typed $fetch route-matching blow up
  const fetcher = $fetch as unknown as (url: string, opts: Record<string, unknown>) => Promise<T>
  return fetcher(joinURL(config.opencodeUrl, path), {
    method: opts.method || 'GET',
    body: opts.body,
    query: opts.query,
    headers,
    timeout: opts.timeoutMs ?? 15000
  })
}

/** HttpOnly cookie that authenticates the app's own pages (see middleware/security.ts). */
export const UI_COOKIE = 'ocw_ui'

export function uiCookieValue(token: string) {
  return createHmac('sha256', token).update('opencode-web-ui-v1').digest('base64url')
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * Optional guard for the public API, the MCP endpoint and the opencode proxy.
 * When NUXT_API_TOKEN is unset the app is assumed to be protected by the
 * reverse proxy (tinyauth) and requests pass through. When set, callers send
 * `Authorization: Bearer <token>`; the UI itself carries the page cookie.
 */
export function requireApiToken(event: H3Event) {
  const token = useRuntimeConfig().apiToken
  if (!token) return
  const header = getHeader(event, 'authorization') || ''
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (bearer && safeEqual(bearer, token)) return
  const cookie = getCookie(event, UI_COOKIE)
  if (cookie && safeEqual(cookie, uiCookieValue(token))) return
  throw createError({ statusCode: 401, statusMessage: 'Unauthorized', message: 'Invalid or missing API token' })
}

/** Reject request bodies above `max` bytes before reading them (413). */
export function assertBodySize(event: H3Event, max: number) {
  const length = Number(getHeader(event, 'content-length') || 0)
  if (length > max) {
    throw createError({ statusCode: 413, statusMessage: 'Payload Too Large', message: `Body exceeds ${Math.round(max / 1024)} KiB` })
  }
}
