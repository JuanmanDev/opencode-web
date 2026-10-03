// opencode returns raw secrets in several places: every provider's API key in
// /config/providers, provider `options.apiKey`/`headers` and MCP `headers` /
// `environment` in /config and /global/config. The UI only ever *writes* them
// (ProvidersModal -> /auth, partial PATCHes on /config), so nothing
// client-side needs to read them back: strip them before any response leaves
// the server.
const SECRET_KEY = /^(key|token|secret|password|authorization|cookie)$|api[-_]?key|access[-_]?token|auth[-_]?token|[-_]token$|[-_]secret$|[-_]password$/i

export const REDACTED = '***'

/** Deep copy of `data` with every secret-looking string value replaced. */
export function redactSecrets<T>(data: T, depth = 0): T {
  if (depth > 12 || !data || typeof data !== 'object') return data
  if (Array.isArray(data)) return data.map((v) => redactSecrets(v, depth + 1)) as T
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) && typeof v === 'string' && v
      ? REDACTED
      : redactSecrets(v, depth + 1)
  }
  return out as T
}

