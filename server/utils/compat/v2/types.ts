// Contract shared by the opencode v2 adapter modules. Everything under
// server/utils/compat/v2 is plain TypeScript without Nitro auto-imports, so it
// can be unit tested: the Nitro glue injects a V2Client and a MetaStore.
//
// Protocol reference: docs/compat/opencode-v2.md (legacy route -> /api/* route,
// legacy event <- session.next.* event, message/part model mapping).

/** Options for one JSON call to the v2 API. */
export interface V2RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  /** plain query parameters (`directory=` on GET /api/session is one) */
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  /** project directory, sent as `location[directory]` (location-scoped routes) */
  directory?: string
  timeoutMs?: number
  signal?: AbortSignal
}

/** Thin authenticated client for `/api/*` of an opencode server. */
export interface V2Client {
  /**
   * JSON request; resolves with the parsed body (`undefined` for 204).
   * Rejects with V2HttpError for non-2xx answers.
   */
  request<T = any>(path: string, opts?: V2RequestOptions): Promise<T>
  /** Opens an SSE stream (GET), e.g. `/api/event`; caller owns the signal. */
  stream(path: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>>
}

/** Non-2xx answer from the v2 API: `{_tag, message, ...}` body. */
export class V2HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: { _tag?: string; message?: string; [key: string]: unknown } | undefined
  ) {
    super(body?.message || `opencode v2 HTTP ${status}`)
    this.name = 'V2HttpError'
  }
}

/**
 * A request in legacy shape, as the UI and server routes issue it:
 * `path` has no leading slash (`session/ses_1/message`), `query.directory`
 * scopes it to a project.
 */
export interface LegacyRequest {
  method: string
  path: string
  query: Record<string, string | undefined>
  body?: unknown
  /**
   * Legacy POST /session/{id}/message (and /command) blocks until the reply
   * is complete; the browser ignores that body, server routes need it.
   * false: answer right after the prompt is admitted.
   */
  wait?: boolean
  signal?: AbortSignal
}

/** Legacy-shaped failure the proxy turns into an HTTP response. */
export class CompatError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'CompatError'
  }
}

/**
 * opencode-web's own storage for what v2 cannot hold (session titles, hidden
 * sessions, last model per project). Backed by Nitro storage in production.
 */
export interface MetaStore {
  get<T>(key: string): Promise<T | null>
  set(key: string, value: unknown): Promise<void>
}

/** What the connected server can do; drives UI gating (GET /api/v1/capabilities). */
export interface Capabilities {
  protocol: 'legacy' | 'v2'
  /** server version when known (`/global/health`); v2-only servers report none */
  version?: string
  mcp: boolean
  config: boolean
  sessionRename: boolean
  sessionDelete: boolean
  fork: boolean
  share: boolean
  diff: boolean
  shell: boolean
  compact: boolean
  revert: boolean
  questions: boolean
  permissions: boolean
  todos: boolean
  cost: boolean
}
