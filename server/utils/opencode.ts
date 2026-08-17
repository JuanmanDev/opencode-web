import { Buffer } from 'node:buffer'
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

/**
 * Optional bearer-token guard for the public API and MCP endpoints.
 * When NUXT_API_TOKEN is unset the app is assumed to be protected by the
 * reverse proxy (tinyauth) and requests pass through.
 */
export function requireApiToken(event: H3Event) {
  const token = useRuntimeConfig().apiToken
  if (!token) return
  const header = getHeader(event, 'authorization') || ''
  const provided = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (provided !== token) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized', message: 'Invalid or missing API token' })
  }
}
