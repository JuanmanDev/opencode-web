// Guards that apply to every route.
//
// CSRF: browsers attach `Origin` to every cross-site POST, even `no-cors`
// ones that a page can fire at a LAN address without any login in between.
// opencode can run shell commands, so state-changing requests from a foreign
// origin are refused. Non-browser clients (curl, MCP clients, opencode itself)
// send no Origin and are unaffected; extra browser origins can be allowed
// with NUXT_ALLOWED_ORIGINS.
//
// UI cookie: with NUXT_API_TOKEN set, the API and the proxy need credentials.
// Pages sit behind the reverse proxy's auth, so loading one hands the browser
// an HttpOnly cookie derived from the token, which the UI's own fetches carry.

export default defineEventHandler((event) => {
  const method = event.method
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const origin = getHeader(event, 'origin')
    if (origin && !isAllowedOrigin(event, origin)) {
      throw createError({ statusCode: 403, statusMessage: 'Forbidden', message: `Cross-origin request from ${origin} refused` })
    }
  }

  const token = useRuntimeConfig().apiToken
  const path = event.path || ''
  if (token && method === 'GET' && !/^\/(api|mcp|_nuxt|_ipx|__nuxt)/.test(path)) {
    setCookie(event, UI_COOKIE, uiCookieValue(token), {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      secure: getRequestProtocol(event, { xForwardedProto: true }) === 'https',
      maxAge: 60 * 60 * 24 * 30
    })
  }
})

function isAllowedOrigin(event: Parameters<typeof getHeader>[0], origin: string) {
  let host: string
  try {
    host = new URL(origin).host
  } catch {
    return false // "null" (sandboxed frames, file://) and garbage
  }
  const requestHost = getRequestHost(event, { xForwardedHost: true })
  if (host === requestHost) return true
  const allowed = String(useRuntimeConfig().allowedOrigins || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean)
  return allowed.includes(origin.replace(/\/$/, '')) || allowed.includes('*')
}
