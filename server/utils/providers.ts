// opencode's /config/providers returns every provider's raw API key. The UI
// only ever *writes* keys (ProvidersModal -> /auth), so nothing client-side
// needs to read them back: strip them before any response leaves the server.
const SECRET_FIELDS = ['key', 'apiKey', 'api_key', 'token', 'secret'] as const

export function redactProviderKeys<T>(data: T): T {
  if (!data || typeof data !== 'object') return data
  const out = data as Record<string, unknown>
  if (Array.isArray(out.providers)) {
    out.providers = out.providers.map((p) => {
      if (!p || typeof p !== 'object') return p
      const clean: Record<string, unknown> = { ...(p as Record<string, unknown>) }
      for (const f of SECRET_FIELDS) {
        if (f in clean && clean[f]) clean[f] = '***'
      }
      return clean
    })
  }
  return data
}
