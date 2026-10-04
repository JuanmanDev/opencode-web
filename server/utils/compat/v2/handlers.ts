// The legacy opencode REST surface, answered by an opencode v2 server.
// createV2Handler() takes one request in legacy shape (`session/ses_1/message`,
// `config/providers`…) and composes the `/api/*` calls that answer it the way
// a 1.x server would (spec §C; the `/event` translator lives elsewhere).
// What v2 cannot hold — session titles, hidden ("deleted") sessions, the last
// model per project — lives in the injected MetaStore (spec §E).

import { CompatError, V2HttpError } from './types'
import type { Capabilities, LegacyRequest, MetaStore, V2Client, V2RequestOptions } from './types'
import {
  deriveTitle,
  expandCommand,
  isDefaultTitle,
  normDir,
  promptBody,
  revertBoundary,
  todosFromMessages,
  toLegacyAgents,
  toLegacyCommands,
  toLegacyFiles,
  toLegacyMessages,
  toLegacyPermission,
  toLegacyProviders,
  toLegacySession,
  userMessage,
  type LegacyModelRef
} from './mappers'

/** MetaStore keys owned by the v2 adapter. */
export const META_KEYS = {
  /** `Record<sessionID, SessionMeta>` */
  sessions: 'v2:sessions',
  /** `Record<normDir(directory), LegacyModelRef>`: v2 exposes no default model */
  lastModel: 'v2:last-model',
  /** project directories sessions were created in (`GET /project`) */
  directories: 'v2:directories'
} as const

/** Per-session data v2 cannot store. */
export interface SessionMeta {
  title?: string
  /** title derived from the first prompt: a real server title wins over it */
  titleDerived?: boolean
  /** soft delete: v2 has no session delete */
  hidden?: boolean
  /** v2 bumps `time.updated` on switches only, not on prompts */
  lastActivity?: number
}

/** What an opencode v2 server (1.18.34) supports behind this adapter. */
export function v2Capabilities(): Capabilities {
  return {
    protocol: 'v2',
    mcp: false,
    config: false,
    sessionRename: true, // opencode-web meta
    sessionDelete: true, // hidden in meta
    fork: false,
    share: false,
    diff: false,
    shell: false,
    compact: true, // the route exists; 1.18.34 answers 503
    revert: true,
    questions: true,
    permissions: true,
    todos: true,
    cost: false
  }
}

const PAGE = 200
const MAX_SESSIONS = 1000
const MAX_MESSAGES = 5000
const LOCATION_TTL_MS = 5 * 60_000
const COMMAND_TTL_MS = 60_000
/** sync prompt: no run visible after this long -> nothing will answer */
const START_TIMEOUT_MS = 15_000
/** sync prompt: hard cap when the caller passes no deadline */
const MAX_WAIT_MS = 30 * 60_000

type Dict = Record<string, any>

interface V2Location {
  directory: string
  workspaceID?: string
  project?: { id: string; directory: string }
}

interface Ctx {
  req: LegacyRequest
  params: Record<string, string>
  /** `?directory=` of the legacy request */
  dir?: string
  body: Dict
  call: <T = any>(path: string, opts?: V2RequestOptions) => Promise<T>
}

type Route = [method: string, pattern: string, handler: (ctx: Ctx) => unknown]

function isObject(value: unknown): value is Dict {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : []
}

function clean<T extends Dict>(value: T): T {
  for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key]
  return value
}

const enc = encodeURIComponent

/** `location[directory]` option, only when the legacy request named one. */
function at(dir: string | undefined): V2RequestOptions {
  return dir ? { directory: dir } : {}
}

function unsupported(feature: string) {
  return (): never => {
    throw new CompatError(501, `Not supported by opencode v2: ${feature}`)
  }
}

function parseBody(body: unknown): Dict {
  if (typeof body === 'string' && body.trim()) {
    try {
      const parsed = JSON.parse(body)
      return isObject(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }
  return isObject(body) ? body : {}
}

/** `pattern` segments: literal, `:name`, or a trailing `*` (one or more). */
function match(pattern: string, segments: string[]): Record<string, string> | undefined {
  const parts = pattern.split('/')
  const params: Record<string, string> = {}
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    if (part === '*') return segments.length > i ? params : undefined
    const segment = segments[i]
    if (segment === undefined) return undefined
    if (part.startsWith(':')) params[part.slice(1)] = segment
    else if (part !== segment) return undefined
  }
  return segments.length === parts.length ? params : undefined
}

function decode(segment: string) {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/** Legacy `{providerID, modelID}` (or `"provider/model"`) + variant -> v2 `Model.Ref`. */
function modelRef(model: unknown, variant: unknown): { id: string; providerID: string; variant?: string } | undefined {
  let providerID: string | undefined
  let modelID: string | undefined
  if (typeof model === 'string') {
    const [provider, ...rest] = model.split('/')
    providerID = provider
    modelID = rest.join('/')
  } else if (isObject(model)) {
    providerID = model.providerID
    modelID = model.modelID ?? model.id
  }
  if (!providerID || !modelID) return undefined
  return clean({ id: String(modelID), providerID: String(providerID), variant: typeof variant === 'string' && variant ? variant : undefined })
}

/** The server stores a switch without variant as `variant: "default"` (verified). */
function variantOf(model: { variant?: string } | undefined) {
  return model?.variant && model.variant !== 'default' ? model.variant : undefined
}

function sameModel(target: { id: string; providerID: string; variant?: string }, current: any) {
  return Boolean(current) &&
    target.id === current.id &&
    target.providerID === current.providerID &&
    variantOf(target) === variantOf(current)
}

/** Relative `path` for `/api/fs/list` (legacy accepted `.` and absolute paths). */
function relativePath(raw: string, dir: string | undefined): string | undefined {
  const path = raw.trim().replace(/^\.[\\/]/, '')
  if (!path || path === '.') return undefined
  if (!/^([a-zA-Z]:)?[\\/]/.test(path)) return path
  const base = normDir(dir)
  const target = normDir(path)
  if (base && target === base) return undefined
  if (base && target.startsWith(`${base}/`)) return path.slice(dir!.replace(/[\\/]+$/, '').length + 1)
  throw new CompatError(400, `path must be inside ${dir || 'the project directory'}`)
}

/** V2HttpError by shape too: a second copy of types.ts (bundling) breaks `instanceof`. */
function httpError(error: unknown): V2HttpError | undefined {
  if (error instanceof V2HttpError) return error
  const e = error as { name?: string; status?: unknown } | undefined
  return e?.name === 'V2HttpError' && typeof e.status === 'number' ? error as V2HttpError : undefined
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason
  // AbortSignal.timeout() aborts with a DOMException named TimeoutError
  if ((reason as { name?: string } | undefined)?.name === 'TimeoutError') {
    return new CompatError(504, 'Timed out waiting for the opencode reply')
  }
  return reason instanceof Error ? reason : new Error('Request aborted')
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal))
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError(signal!))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Legacy request in, legacy-shaped answer out (throws CompatError / V2HttpError). */
export function createV2Handler(deps: { client: V2Client; meta: MetaStore; now?: () => number }): (req: LegacyRequest) => Promise<unknown> {
  const { client, meta } = deps
  const now = deps.now ?? Date.now
  const locations = new Map<string, { at: number; value: Promise<V2Location> }>()
  const commandLists = new Map<string, { at: number; value: Promise<{ commands: any[]; skills: any[] }> }>()
  /** question/permission request id -> sessionID (replies are session-scoped in v2) */
  const owners = new Map<string, string>()
  let metaChain: Promise<unknown> = Promise.resolve()

  function cached<T>(map: Map<string, { at: number; value: Promise<T> }>, key: string, ttl: number, load: () => Promise<T>) {
    const hit = map.get(key)
    if (hit && now() - hit.at < ttl) return hit.value
    const value = load()
    map.set(key, { at: now(), value })
    value.catch(() => {
      if (map.get(key)?.value === value) map.delete(key)
    })
    return value
  }

  function remember(requestID: unknown, sessionID: unknown) {
    if (typeof requestID !== 'string' || typeof sessionID !== 'string') return
    owners.delete(requestID)
    owners.set(requestID, sessionID)
    if (owners.size > 1000) owners.delete(owners.keys().next().value!)
  }

  // ---- opencode-web meta ----

  /** Serialized read-modify-write; `fn` returning `current` skips the write. */
  function updateMeta<T>(key: string, fallback: T, fn: (current: T) => T): Promise<void> {
    const run = metaChain.then(async () => {
      const current = (await meta.get<T>(key)) ?? fallback
      const next = fn(current)
      if (next !== current) await meta.set(key, next)
    })
    metaChain = run.catch(() => {})
    return run
  }

  async function sessionMetas(): Promise<Record<string, SessionMeta>> {
    return (await meta.get<Record<string, SessionMeta>>(META_KEYS.sessions)) || {}
  }

  function patchSessionMeta(id: string, patch: Partial<SessionMeta>) {
    return updateMeta<Record<string, SessionMeta>>(META_KEYS.sessions, {}, (all) => ({
      ...all,
      [id]: clean({ ...all[id], ...patch })
    }))
  }

  async function lastModelFor(dir: string): Promise<LegacyModelRef | undefined> {
    const all = await meta.get<Record<string, LegacyModelRef>>(META_KEYS.lastModel)
    return all?.[normDir(dir)]
  }

  function legacySession(session: any, metas: Record<string, SessionMeta>) {
    const m = metas[session?.id]
    const title = m?.title && (!m.titleDerived || isDefaultTitle(session?.title)) ? m.title : undefined
    return toLegacySession(session, { title, lastActivity: m?.lastActivity })
  }

  // ---- v2 helpers ----

  function location(ctx: Ctx, dir?: string): Promise<V2Location> {
    return cached(locations, dir ?? '', LOCATION_TTL_MS, () => ctx.call<V2Location>('/api/location', at(dir)))
  }

  async function rootOf(ctx: Ctx, session: any): Promise<string | undefined> {
    const dir = session?.location?.directory
    if (!dir) return undefined
    return location(ctx, dir).then((l) => l?.project?.directory, () => undefined)
  }

  async function getSession(ctx: Ctx, id: string): Promise<any> {
    const res = await ctx.call(`/api/session/${enc(id)}`)
    return res?.data
  }

  async function activeSet(ctx: Ctx): Promise<Set<string>> {
    const res = await ctx.call('/api/session/active')
    return new Set(Object.keys(isObject(res?.data) ? res.data : {}))
  }

  /** Follow `cursor.next` until a short page (or `cap` items). */
  async function pageAll(ctx: Ctx, path: string, first: Dict, cap: number): Promise<any[]> {
    const limit = first.limit ?? PAGE
    const out: any[] = []
    let query: Dict = { ...first, limit }
    for (;;) {
      const res = await ctx.call(path, { query })
      const data = asArray(res?.data)
      out.push(...data)
      const next = res?.cursor?.next
      if (data.length < limit || !next || out.length >= cap) break
      // the cursor encodes order/filters; v2 rejects `order` next to it
      query = { cursor: next, limit }
    }
    return out.slice(0, cap)
  }

  /** Raw v2 messages, ascending; `limit` = the newest N. */
  async function rawMessages(ctx: Ctx, id: string, limit?: number): Promise<any[]> {
    const path = `/api/session/${enc(id)}/message`
    if (!limit) return pageAll(ctx, path, { order: 'asc', limit: PAGE }, MAX_MESSAGES)
    const newest = await pageAll(ctx, path, { order: 'desc', limit: Math.min(limit, PAGE) }, limit)
    return newest.reverse()
  }

  async function legacyMessages(ctx: Ctx, id: string, limit?: number) {
    const [session, active, raw] = await Promise.all([getSession(ctx, id), activeSet(ctx), rawMessages(ctx, id, limit)])
    const root = await rootOf(ctx, session)
    return toLegacyMessages(raw, { sessionID: id, session, active: active.has(id), root })
  }

  function commandList(ctx: Ctx, dir: string | undefined) {
    return cached(commandLists, dir ?? '', COMMAND_TTL_MS, async () => {
      const [commands, skills] = await Promise.all([
        ctx.call('/api/command', at(dir)),
        ctx.call('/api/skill', at(dir)).catch(() => undefined)
      ])
      return { commands: asArray(commands?.data), skills: asArray(skills?.data) }
    })
  }

  /** sessionID owning a pending question/permission: cache, else refetch the list. */
  async function ownerOf(ctx: Ctx, requestID: string, listPath: string): Promise<string> {
    const known = owners.get(requestID)
    if (known) return known
    const res = await ctx.call(listPath, at(ctx.dir))
    for (const item of asArray(res?.data)) remember(item?.id, item?.sessionID)
    const sessionID = owners.get(requestID)
    if (!sessionID) throw new CompatError(404, `No pending request ${requestID}`)
    return sessionID
  }

  // ---- prompts ----

  async function noteActivity(session: any, text: string | undefined) {
    await updateMeta<Record<string, SessionMeta>>(META_KEYS.sessions, {}, (all) => {
      const current = all[session.id] ?? {}
      const derived = !current.title && isDefaultTitle(session.title) ? deriveTitle(text) : undefined
      return {
        ...all,
        [session.id]: clean({
          ...current,
          ...(derived ? { title: derived, titleDerived: true } : {}),
          lastActivity: now()
        })
      }
    })
  }

  async function rememberModel(dir: string, model: { id: string; providerID: string; variant?: string }) {
    const key = normDir(dir)
    const value = clean({ providerID: model.providerID, modelID: model.id, variant: model.variant })
    await updateMeta<Record<string, LegacyModelRef>>(META_KEYS.lastModel, {}, (all) => {
      const current = all[key]
      if (current && current.providerID === value.providerID && current.modelID === value.modelID && current.variant === value.variant) return all
      return { ...all, [key]: value }
    })
  }

  /** Newest assistant reply after `admittedID`, mapped (undefined while none). */
  async function latestReply(ctx: Ctx, session: any, admittedID: string, root?: string) {
    const res = await ctx.call(`/api/session/${enc(session.id)}/message`, { query: { order: 'desc', limit: 50 } })
    const page = asArray(res?.data)
    const lastID = page
      .filter((m) => m?.type === 'assistant' && typeof m.id === 'string' && m.id > admittedID)
      .reduce<string | undefined>((max, m) => (!max || m.id > max ? m.id : max), undefined)
    if (!lastID) return undefined
    const reply = toLegacyMessages(page, { sessionID: session.id, session, active: false, root })
      .find((m) => m.info.id === lastID)
    if (reply && !reply.info.parentID) reply.info.parentID = admittedID
    return reply
  }

  /**
   * Sync prompts: v2 `/wait` answers 503 in 1.18, so poll `/session/active`
   * until the run started and ended, then return the last assistant message
   * newer than the admitted prompt (ids sort by creation time).
   */
  async function waitForReply(ctx: Ctx, session: any, admittedID: string) {
    const started = now()
    const root = await rootOf(ctx, session)
    let seenActive = false
    let delay = 100
    for (;;) {
      if (ctx.req.signal?.aborted) throw abortError(ctx.req.signal)
      const active = await activeSet(ctx)
      if (active.has(session.id)) {
        seenActive = true
      } else {
        // idle: either done (possibly before the first poll) or not started yet
        const reply = await latestReply(ctx, session, admittedID, root)
        if (reply) return reply
        if (seenActive) throw new CompatError(502, 'opencode finished the prompt without a reply')
        if (now() - started >= START_TIMEOUT_MS) {
          throw new CompatError(502, 'opencode did not start working on the prompt within 15 s (is a model configured?)')
        }
      }
      if (now() - started >= MAX_WAIT_MS) throw new CompatError(504, 'Timed out waiting for the opencode reply')
      await sleep(delay, ctx.req.signal)
      delay = Math.min(delay * 2, 1000)
    }
  }

  /**
   * Legacy prompt (spec C.3): commit a staged revert (legacy dropped reverted
   * messages on the next prompt), switch model/agent when they differ from
   * the session's (session state in v2), then admit the prompt.
   */
  async function runPrompt(ctx: Ctx, session: any, body: Dict, opts: { wait: boolean; titleHint?: string }) {
    const id = String(session.id)
    const base = `/api/session/${enc(id)}`
    if (session.revert) await ctx.call(`${base}/revert/commit`, { method: 'POST' })
    const model = modelRef(body.model, body.variant)
    if (model && !sameModel(model, session.model)) {
      await ctx.call(`${base}/model`, { method: 'POST', body: { model } })
    }
    const agent = typeof body.agent === 'string' && body.agent ? body.agent : undefined
    if (agent && agent !== session.agent) await ctx.call(`${base}/agent`, { method: 'POST', body: { agent } })

    const payload = promptBody(body)
    const res = await ctx.call(`${base}/prompt`, { method: 'POST', body: payload })
    const admitted = res?.data ?? {}

    // bookkeeping must never fail an admitted prompt
    const dir = session.location?.directory
    await Promise.all([
      model && dir ? rememberModel(dir, model).catch(() => {}) : undefined,
      noteActivity(session, opts.titleHint ?? payload.prompt.text).catch(() => {})
    ])

    if (!opts.wait) return {}
    if (payload.resume === false) {
      return userMessage(
        { id: admitted.id, time: { created: admitted.timeCreated }, ...(isObject(admitted.prompt) ? admitted.prompt : payload.prompt) },
        { sessionID: id, agent: agent ?? session.agent, model: model && clean({ providerID: model.providerID, modelID: model.id, variant: model.variant }) }
      )
    }
    if (typeof admitted.id !== 'string') throw new CompatError(502, 'opencode did not admit the prompt')
    // the revert was committed above: nothing is hidden behind a boundary anymore
    return waitForReply(ctx, { ...session, revert: undefined }, admitted.id)
  }

  /** Slash command (spec C.4): expand the template client-side, then prompt. */
  async function runCommand(ctx: Ctx, session: any, name: string, args: string, body: Dict) {
    const { commands, skills } = await commandList(ctx, session.location?.directory ?? ctx.dir)
    const command = commands.find((c) => c?.name === name)
    const skill = command ? undefined : skills.find((s) => s?.name === name && s.slash !== false)
    if (!command && !skill) throw new CompatError(404, `Unknown command: /${name}`)
    const text = expandCommand(String(command ? command.template ?? '' : skill.content ?? ''), args)
    const commandModel = command?.model?.id && command.model.providerID
      ? { providerID: command.model.providerID, modelID: command.model.id }
      : undefined
    const files = asArray(body.parts).filter((p) => p?.type === 'file')
    return runPrompt(ctx, session, {
      parts: [{ type: 'text', text }, ...files],
      model: body.model ?? commandModel,
      variant: body.variant ?? (body.model ? undefined : command?.model?.variant),
      agent: body.agent ?? command?.agent,
      messageID: body.messageID
    }, { wait: ctx.req.wait !== false, titleHint: `/${name}${args ? ` ${args}` : ''}` })
  }

  // ---- routes ----

  const health = async (ctx: Ctx) => {
    const res = await ctx.call('/api/health')
    return { healthy: res?.healthy === true }
  }

  /** Projects (spec #1): derived from sessions + locations; no project list in v2. */
  async function listProjects(ctx: Ctx) {
    const [sessions, metas, known, fallback] = await Promise.all([
      pageAll(ctx, '/api/session', { limit: PAGE }, MAX_SESSIONS),
      sessionMetas(),
      meta.get<string[]>(META_KEYS.directories).then((list) => asArray(list)),
      location(ctx).catch(() => undefined)
    ])
    const dirs = new Map<string, { directory: string; created?: number; updated?: number }>()
    const see = (directory: unknown, created?: number, updated?: number) => {
      if (typeof directory !== 'string' || !directory) return
      const key = normDir(directory)
      const entry = dirs.get(key) ?? { directory }
      if (created !== undefined) entry.created = Math.min(entry.created ?? created, created)
      if (updated !== undefined) entry.updated = Math.max(entry.updated ?? updated, updated)
      dirs.set(key, entry)
    }
    for (const s of sessions) {
      const m = metas[s?.id]
      if (m?.hidden) continue
      const created = s?.time?.created
      see(s?.location?.directory, created, Math.max(s?.time?.updated ?? 0, m?.lastActivity ?? 0, created ?? 0))
    }
    for (const dir of known) see(dir)
    if (fallback?.directory) see(fallback.directory)

    const projects = new Map<string, { id: string; worktree: string; time: { created?: number; updated?: number } }>()
    await Promise.all([...dirs.values()].map(async (entry) => {
      const loc = await location(ctx, entry.directory).catch(() => undefined)
      const id = loc?.project?.id ?? entry.directory
      const project = projects.get(id) ?? { id, worktree: loc?.project?.directory ?? entry.directory, time: {} }
      if (entry.created !== undefined) project.time.created = Math.min(project.time.created ?? entry.created, entry.created)
      if (entry.updated !== undefined) project.time.updated = Math.max(project.time.updated ?? entry.updated, entry.updated)
      projects.set(id, project)
    }))
    return [...projects.values()]
      .map((p) => ({ ...p, time: clean(p.time) }))
      .sort((a, b) => (b.time.updated ?? 0) - (a.time.updated ?? 0))
  }

  async function listSessions(ctx: Ctx) {
    let directory = ctx.dir
    // `directory=` is an exact match on the stored string: use the canonical form
    if (directory) directory = (await location(ctx, directory).catch(() => undefined))?.directory ?? directory
    const [list, metas] = await Promise.all([
      pageAll(ctx, '/api/session', directory ? { directory, limit: PAGE } : { limit: PAGE }, MAX_SESSIONS),
      sessionMetas()
    ])
    return list.filter((s) => !metas[s?.id]?.hidden).map((s) => legacySession(s, metas))
  }

  async function createSession(ctx: Ctx) {
    const title = typeof ctx.body.title === 'string' ? ctx.body.title.trim() : ''
    const res = await ctx.call('/api/session', {
      method: 'POST',
      body: ctx.dir ? { location: { directory: ctx.dir } } : {}
    })
    const session = res?.data
    if (title) await patchSessionMeta(session.id, { title, titleDerived: undefined })
    if (ctx.dir) {
      const dir = ctx.dir
      await updateMeta<string[]>(META_KEYS.directories, [], (list) =>
        list.some((d) => normDir(d) === normDir(dir)) ? list : [...list, dir].slice(-200))
    }
    return toLegacySession(session, { title: title || undefined })
  }

  async function getSessionRoute(ctx: Ctx) {
    const id = ctx.params.id!
    const [session, metas] = await Promise.all([getSession(ctx, id), sessionMetas()])
    if (metas[id]?.hidden) throw new CompatError(404, `Session not found: ${id}`)
    return legacySession(session, metas)
  }

  async function deleteSession(ctx: Ctx) {
    const id = ctx.params.id!
    await getSession(ctx, id) // unknown ids answer 404 like legacy
    await patchSessionMeta(id, { hidden: true })
    return true
  }

  async function renameSession(ctx: Ctx) {
    const id = ctx.params.id!
    const session = await getSession(ctx, id)
    if (typeof ctx.body.title === 'string') {
      await patchSessionMeta(id, { title: ctx.body.title.trim() || undefined, titleDerived: undefined })
    }
    return legacySession(session, await sessionMetas())
  }

  async function getMessage(ctx: Ctx) {
    const messageID = ctx.params.messageID!
    const message = (await legacyMessages(ctx, ctx.params.id!)).find((m) => m.info.id === messageID)
    if (!message) throw new CompatError(404, `Message not found: ${messageID}`)
    return message
  }

  async function getTodos(ctx: Ctx) {
    const path = `/api/session/${enc(ctx.params.id!)}/message`
    let query: Dict = { order: 'desc', limit: PAGE }
    for (let page = 0; page < 25; page++) {
      const res = await ctx.call(path, { query })
      const data = asArray(res?.data)
      const todos = todosFromMessages(data)
      if (todos) return todos
      const next = res?.cursor?.next
      if (data.length < PAGE || !next) break
      query = { cursor: next, limit: PAGE }
    }
    return []
  }

  async function getProviders(ctx: Ctx) {
    const [providers, models, last] = await Promise.all([
      ctx.call('/api/provider', at(ctx.dir)),
      ctx.call('/api/model', at(ctx.dir)),
      ctx.dir ? lastModelFor(ctx.dir) : undefined
    ])
    const out = toLegacyProviders(asArray(providers?.data), asArray(models?.data))
    const exists = (providerID?: string, modelID?: string) =>
      Boolean(providerID && modelID && out.providers.find((p) => p.id === providerID)?.models[modelID])
    // v2 exposes no default model: last used here -> build agent's -> first listed
    let pick: { providerID: string; modelID: string } | undefined =
      last && exists(last.providerID, last.modelID) ? last : undefined
    if (!pick) {
      const agents = await ctx.call('/api/agent', at(ctx.dir)).catch(() => undefined)
      const model = asArray(agents?.data).find((a) => a?.id === 'build')?.model
      if (exists(model?.providerID, model?.id)) pick = { providerID: model.providerID, modelID: model.id }
    }
    if (!pick) {
      const first = out.providers.find((p) => Object.keys(p.models).length)
      if (first) pick = { providerID: first.id, modelID: Object.keys(first.models)[0]! }
    }
    if (pick) out.default = { [pick.providerID]: pick.modelID }
    return out
  }

  async function getConfig(ctx: Ctx) {
    // no config in v2: only the model this project used last (PromptBox default)
    const last = ctx.dir ? await lastModelFor(ctx.dir) : undefined
    return last ? { model: `${last.providerID}/${last.modelID}` } : {}
  }

  async function setAuth(ctx: Ctx) {
    const providerID = ctx.params.providerID!
    if (ctx.body.type && ctx.body.type !== 'api') unsupported(`${ctx.body.type} provider auth`)()
    const key = ctx.body.key
    if (typeof key !== 'string' || !key) throw new CompatError(400, 'key is required')
    const provider = await ctx.call(`/api/provider/${enc(providerID)}`, at(ctx.dir)).catch((error) => {
      if (httpError(error)?.status === 404) return undefined
      throw error
    })
    const integrationID = provider?.data?.integrationID ?? providerID
    await ctx.call(`/api/integration/${enc(integrationID)}/connect/key`, { method: 'POST', ...at(ctx.dir), body: { key } })
    return true
  }

  async function compact(ctx: Ctx) {
    try {
      await ctx.call(`/api/session/${enc(ctx.params.id!)}/compact`, { method: 'POST' })
    } catch (error) {
      const http = httpError(error)
      if (http?.status === 503) throw new CompatError(503, http.body?.message || 'Session compact is not available yet')
      throw error
    }
    return true
  }

  /** Undo (spec #23): legacy names the first message dropped, v2 the last one kept. */
  async function revert(ctx: Ctx) {
    const id = ctx.params.id!
    const [session, raw] = await Promise.all([getSession(ctx, id), rawMessages(ctx, id)])
    const firstDropped = typeof ctx.body.messageID === 'string' ? ctx.body.messageID : undefined
    if (firstDropped && !raw.some((m) => m?.id === firstDropped)) {
      throw new CompatError(404, `Message not found: ${firstDropped}`)
    }
    const boundary = revertBoundary(raw, { current: session?.revert?.messageID, firstDropped })
    if (!boundary) throw new CompatError(409, 'Nothing to undo: opencode v2 cannot revert the first message of a session')
    await ctx.call(`/api/session/${enc(id)}/revert/stage`, { method: 'POST', body: { messageID: boundary, files: true } })
    return true
  }

  async function replyPermission(ctx: Ctx, sessionID: string, requestID: string, reply: unknown, message: unknown) {
    if (reply !== 'once' && reply !== 'always' && reply !== 'reject') {
      throw new CompatError(400, 'reply must be once, always or reject')
    }
    await ctx.call(`/api/session/${enc(sessionID)}/permission/${enc(requestID)}/reply`, {
      method: 'POST',
      body: clean({ reply, message: typeof message === 'string' && message ? message : undefined })
    })
    owners.delete(requestID)
    return true
  }

  async function answerQuestion(ctx: Ctx, action: 'reply' | 'reject') {
    const requestID = ctx.params.requestID!
    if (action === 'reply' && !Array.isArray(ctx.body.answers)) throw new CompatError(400, 'answers must be an array')
    const sessionID = await ownerOf(ctx, requestID, '/api/question/request')
    await ctx.call(`/api/session/${enc(sessionID)}/question/${enc(requestID)}/${action}`, {
      method: 'POST',
      ...(action === 'reply' ? { body: { answers: ctx.body.answers } } : {})
    })
    owners.delete(requestID)
    return true
  }

  const routes: Route[] = [
    // discovery / config
    ['GET', 'app', health],
    ['GET', 'global/health', health],
    ['GET', 'project', listProjects],
    ['GET', 'path', async (ctx) => {
      const loc = await location(ctx, ctx.dir)
      return { directory: loc.directory, worktree: loc.project?.directory ?? loc.directory }
    }],
    ['GET', 'file', async (ctx) => {
      const path = relativePath(String(ctx.req.query.path ?? ''), ctx.dir)
      const res = await ctx.call('/api/fs/list', { ...at(ctx.dir), ...(path ? { query: { path } } : {}) })
      return toLegacyFiles(asArray(res?.data), res?.location?.directory ?? ctx.dir ?? '')
    }],
    ['GET', 'config', getConfig],
    ['GET', 'global/config', () => ({})],
    ['PATCH', 'config', unsupported('config editing')],
    ['PATCH', 'global/config', unsupported('config editing')],
    ['GET', 'config/providers', getProviders],
    ['GET', 'agent', async (ctx) => toLegacyAgents(asArray((await ctx.call('/api/agent', at(ctx.dir)))?.data))],
    ['PUT', 'auth/:providerID', setAuth],
    ['GET', 'command', async (ctx) => {
      const { commands, skills } = await commandList(ctx, ctx.dir)
      return toLegacyCommands(commands, skills)
    }],
    // MCP: absent in v2
    ['GET', 'mcp', () => ({})],
    ['POST', 'mcp', unsupported('MCP servers')],
    ['POST', 'mcp/*', unsupported('MCP servers')],
    ['DELETE', 'mcp/*', unsupported('MCP servers')],
    // sessions
    ['GET', 'session', listSessions],
    ['POST', 'session', createSession],
    ['GET', 'session/status', async (ctx) =>
      Object.fromEntries([...await activeSet(ctx)].map((id) => [id, { type: 'busy' }]))],
    ['GET', 'session/:id', getSessionRoute],
    ['DELETE', 'session/:id', deleteSession],
    ['PATCH', 'session/:id', renameSession],
    ['GET', 'session/:id/children', () => []],
    ['POST', 'session/:id/abort', async (ctx) => {
      await ctx.call(`/api/session/${enc(ctx.params.id!)}/interrupt`, { method: 'POST' })
      return true
    }],
    ['GET', 'session/:id/message', (ctx) => {
      const limit = Math.floor(Number(ctx.req.query.limit))
      return legacyMessages(ctx, ctx.params.id!, limit > 0 ? limit : undefined)
    }],
    ['GET', 'session/:id/message/:messageID', getMessage],
    ['GET', 'session/:id/todo', getTodos],
    ['POST', 'session/:id/message', async (ctx) =>
      runPrompt(ctx, await getSession(ctx, ctx.params.id!), ctx.body, { wait: ctx.req.wait !== false })],
    ['POST', 'session/:id/prompt_async', async (ctx) =>
      runPrompt(ctx, await getSession(ctx, ctx.params.id!), ctx.body, { wait: false })],
    ['POST', 'session/:id/command', async (ctx) => {
      const name = String(ctx.body.command ?? '').replace(/^\//, '').trim()
      if (!name) throw new CompatError(400, 'command is required')
      const args = typeof ctx.body.arguments === 'string' ? ctx.body.arguments : ''
      return runCommand(ctx, await getSession(ctx, ctx.params.id!), name, args, ctx.body)
    }],
    ['POST', 'session/:id/init', async (ctx) => {
      const { providerID, modelID, messageID } = ctx.body
      return runCommand(ctx, await getSession(ctx, ctx.params.id!), 'init', '', {
        model: providerID && modelID ? { providerID, modelID } : undefined,
        messageID
      })
    }],
    ['POST', 'session/:id/shell', unsupported('shell commands')],
    ['POST', 'session/:id/summarize', compact],
    ['POST', 'session/:id/revert', revert],
    ['POST', 'session/:id/unrevert', async (ctx) => {
      await ctx.call(`/api/session/${enc(ctx.params.id!)}/revert/clear`, { method: 'POST' })
      return true
    }],
    ['POST', 'session/:id/fork', unsupported('session fork')],
    ['POST', 'session/:id/share', unsupported('session sharing')],
    ['DELETE', 'session/:id/share', unsupported('session sharing')],
    ['GET', 'session/:id/diff', unsupported('session diff')],
    ['POST', 'session/:id/diff', unsupported('session diff')],
    ['POST', 'session/:id/permissions/:permissionID', (ctx) =>
      replyPermission(ctx, ctx.params.id!, ctx.params.permissionID!, ctx.body.response ?? ctx.body.reply, ctx.body.message)],
    // pending questions / permissions
    ['GET', 'question', async (ctx) => {
      const data = asArray((await ctx.call('/api/question/request', at(ctx.dir)))?.data)
      for (const q of data) remember(q?.id, q?.sessionID)
      return data
    }],
    ['POST', 'question/:requestID/reply', (ctx) => answerQuestion(ctx, 'reply')],
    ['POST', 'question/:requestID/reject', (ctx) => answerQuestion(ctx, 'reject')],
    ['GET', 'permission', async (ctx) => {
      const data = asArray((await ctx.call('/api/permission/request', at(ctx.dir)))?.data)
      for (const p of data) remember(p?.id, p?.sessionID)
      return data.map(toLegacyPermission)
    }],
    ['POST', 'permission/:requestID/reply', async (ctx) => {
      const requestID = ctx.params.requestID!
      const sessionID = await ownerOf(ctx, requestID, '/api/permission/request')
      return replyPermission(ctx, sessionID, requestID, ctx.body.reply, ctx.body.message)
    }]
  ]

  return async function handle(req: LegacyRequest): Promise<unknown> {
    const method = req.method.toUpperCase()
    const segments = req.path.split('?')[0]!.split('/').filter(Boolean).map(decode)
    for (const [routeMethod, pattern, handler] of routes) {
      if (routeMethod !== method) continue
      const params = match(pattern, segments)
      if (!params) continue
      const ctx: Ctx = {
        req,
        params,
        dir: req.query.directory || undefined,
        body: parseBody(req.body),
        call: (path, opts = {}) =>
          client.request(path, req.signal && !opts.signal ? { ...opts, signal: req.signal } : opts)
      }
      return handler(ctx)
    }
    throw new CompatError(404, `Unknown opencode route: ${method} /${segments.join('/')}`)
  }
}
