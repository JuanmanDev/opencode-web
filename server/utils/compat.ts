// opencode protocol compatibility: which API the connected server speaks, and
// the glue that lets the UI (always legacy-shaped) talk to any of them.
//
// - legacy: every opencode 1.x server (`/session`, `/event`, …). Default, and
//   preferred whenever available, also on 1.18 hybrids that serve both.
// - v2: servers that only speak the new `/api/*` protocol (opencode 2.x).
//   Requests are translated by compat/v2/handlers, events by compat/v2/events.
//
// Detection is cached; NUXT_OPENCODE_PROTOCOL=legacy|v2 skips it.

import { Buffer } from 'node:buffer'
import { joinURL } from 'ufo'
import { createV2EventHub } from './compat/v2/events'
import { createV2Handler, v2Capabilities } from './compat/v2/handlers'
import { toLegacyMessages } from './compat/v2/mappers'
import { CompatError, V2HttpError, type Capabilities, type LegacyRequest, type MetaStore, type V2Client, type V2RequestOptions } from './compat/v2/types'

export interface ServerProfile {
  protocol: 'legacy' | 'v2'
  /** from /global/health; v2-only servers report none */
  version?: string
  /** a legacy server that also serves the v2 `/api/*` protocol (1.18+) */
  hybrid: boolean
  /** false when the last probe could not reach the server at all */
  reachable: boolean
  checkedAt: number
}

function authHeaders(): Record<string, string> {
  const config = useRuntimeConfig()
  return config.opencodePassword
    ? { authorization: 'Basic ' + Buffer.from(`${config.opencodeUsername}:${config.opencodePassword}`).toString('base64') }
    : {}
}

/** GET a JSON document; html catch-alls (1.18 serves its web UI on unknown paths) count as missing. */
async function probeJson(path: string): Promise<{ status: number; body?: any }> {
  try {
    const res = await fetch(joinURL(useRuntimeConfig().opencodeUrl, path), {
      headers: { accept: 'application/json', ...authHeaders() },
      signal: AbortSignal.timeout(5000)
    })
    const json = (res.headers.get('content-type') || '').includes('application/json')
    const body = json ? await res.json().catch(() => undefined) : (await res.body?.cancel(), undefined)
    return { status: json || !res.ok ? res.status : 404, body }
  } catch {
    return { status: 0 }
  }
}

let profile: ServerProfile | undefined
let detecting: Promise<ServerProfile> | undefined

async function detect(): Promise<ServerProfile> {
  const forced = String(useRuntimeConfig().opencodeProtocol || 'auto')
  const now = Date.now()
  if (forced === 'v2') return { protocol: 'v2', hybrid: false, reachable: true, checkedAt: now }

  const health = await probeJson('/global/health')
  if (health.status === 200 && health.body?.healthy) {
    const api = forced === 'legacy' ? undefined : await probeJson('/api/health')
    return {
      protocol: 'legacy',
      version: typeof health.body.version === 'string' ? health.body.version : undefined,
      hybrid: api?.status === 200 && api.body?.healthy === true,
      reachable: true,
      checkedAt: now
    }
  }
  if (forced !== 'legacy') {
    const api = await probeJson('/api/health')
    if (api.status === 200 && api.body?.healthy === true) {
      return { protocol: 'v2', hybrid: false, reachable: true, checkedAt: now }
    }
  }
  // early 1.0 servers have no /global/health: any answer from a legacy route
  const legacy = await probeJson('/config')
  return {
    protocol: 'legacy',
    hybrid: false,
    reachable: legacy.status !== 0,
    checkedAt: now
  }
}

/** Cached server profile: 60 s when reachable, 5 s otherwise. */
export async function getServerProfile(force = false): Promise<ServerProfile> {
  const ttl = profile?.reachable ? 60_000 : 5_000
  if (!force && profile && Date.now() - profile.checkedAt < ttl) return profile
  detecting ??= detect().then((p) => {
    // never flip a working legacy verdict to "unreachable legacy" on a blip
    profile = p
    return p
  }).finally(() => { detecting = undefined })
  return detecting
}

// ---- v2 plumbing (lazy singletons) ----

function createRealV2Client(): V2Client {
  const base = () => useRuntimeConfig().opencodeUrl
  const url = (path: string, opts?: V2RequestOptions) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(opts?.query || {})) {
      if (value !== undefined) params.set(key, String(value))
    }
    if (opts?.directory) params.set('location[directory]', opts.directory)
    const search = params.toString()
    return joinURL(base(), path) + (search ? `?${search}` : '')
  }
  return {
    async request(path, opts = {}) {
      const res = await fetch(url(path, opts), {
        method: opts.method || 'GET',
        headers: {
          accept: 'application/json',
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...authHeaders()
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: opts.signal
          ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs ?? 30_000)])
          : AbortSignal.timeout(opts.timeoutMs ?? 30_000)
      })
      const text = await res.text()
      let body: any
      try { body = text ? JSON.parse(text) : undefined } catch { body = { message: text.slice(0, 300) } }
      if (!res.ok) throw new V2HttpError(res.status, body)
      return body
    },
    async stream(path, signal) {
      const res = await fetch(url(path), { headers: { accept: 'text/event-stream', ...authHeaders() }, signal })
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => {})
        throw new V2HttpError(res.status, undefined)
      }
      return res.body
    }
  }
}

function nitroMetaStore(): MetaStore {
  const storage = useStorage('data')
  return {
    get: <T>(key: string) => storage.getItem(`opencode-v2/${key}`) as Promise<T | null>,
    set: (key, value) => storage.setItem(`opencode-v2/${key}`, value as never)
  }
}

let v2: { client: V2Client; handle: ReturnType<typeof createV2Handler>; hub: ReturnType<typeof createV2EventHub> } | undefined

function v2Runtime() {
  if (!v2) {
    const client = createRealV2Client()
    const handle = createV2Handler({ client, meta: nitroMetaStore() })
    v2 = {
      client,
      handle,
      hub: createV2EventHub({
        client,
        // a page connected mid-turn: fetch the message the deltas belong to
        seed: async (sessionID, messageID) => {
          const res = await client.request<{ data: any }>(`/api/session/${sessionID}/message/${messageID}`).catch(() => null)
          return res?.data ? toLegacyMessages([res.data], { sessionID, active: true })[0] ?? null : null
        },
        // titles and other opencode-web meta applied, like the REST answers
        session: (sessionID) => handle({ method: 'GET', path: `session/${sessionID}`, query: {} }).catch(() => null),
        logger: (msg) => console.warn(`[opencode v2 events] ${msg}`)
      })
    }
  }
  return v2
}

/** Translate one legacy-shaped request for a v2-only server. */
export function v2Request(req: LegacyRequest) {
  return v2Runtime().handle(req)
}

/** Subscribe a browser to translated v2 events; returns the unsubscribe function. */
export function v2Subscribe(directory: string | undefined, send: (frame: string) => void) {
  return v2Runtime().hub.subscribe(directory, send)
}

/** v2-run sessions on a hybrid 1.18 server are empty on the legacy message route. */
export async function v2MessagesFallback(sessionID: string, directory?: string) {
  return v2Runtime().handle({ method: 'GET', path: `session/${sessionID}/message`, query: { directory } })
}

/** Feature map for the UI (GET /api/v1/capabilities). */
export async function getCapabilities(): Promise<Capabilities> {
  const p = await getServerProfile()
  if (p.protocol === 'v2') return v2Capabilities()
  return legacyCapabilities(p.version)
}

/** Every legacy server supports the full feature set the UI uses. */
function legacyCapabilities(version?: string): Capabilities {
  return {
    protocol: 'legacy',
    version,
    mcp: true,
    config: true,
    sessionRename: true,
    sessionDelete: true,
    fork: true,
    share: true,
    diff: true,
    shell: true,
    compact: true,
    revert: true,
    questions: true,
    permissions: true,
    todos: true,
    cost: true
  }
}

/** CompatError / V2HttpError -> h3 error with the legacy `{statusCode, message}` body. */
export function compatToH3Error(error: unknown) {
  // by name too: a second copy of the module (dev reloads) breaks instanceof
  const named = error instanceof Error && (error.name === 'CompatError' || error.name === 'V2HttpError')
  if (error instanceof CompatError || error instanceof V2HttpError || named) {
    const e = error as CompatError
    return createError({ statusCode: typeof e.status === 'number' ? e.status : 502, message: e.message })
  }
  if (error && typeof error === 'object' && 'statusCode' in error) return error as unknown as Error
  const timedOut = error instanceof Error && error.name === 'TimeoutError'
  return createError({
    statusCode: timedOut ? 504 : 502,
    message: timedOut
      ? 'opencode server did not respond in time'
      : `opencode server unreachable: ${error instanceof Error ? error.message : error}`
  })
}
