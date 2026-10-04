// Live projector for the opencode v2 event stream. v2 publishes per-step
// lifecycles with deltas (`session.next.text.delta`, `…tool.called`, …) where
// the legacy UI expects whole objects (`message.updated`,
// `message.part.updated`), and has no status events at all. The projector
// keeps a small model per in-flight message — the same reducer as upstream
// core/src/session/message-updater.ts — and re-emits complete legacy parts
// through the same mappers as the REST snapshot, so ids and shapes match.
//
// Pure and deterministic: no timers, no I/O. The owner (events.ts) drives the
// throttle clock (`flush()`), fetches what the projector cannot know
// (`takeSeedRequests()`: messages that started before we connected, session
// infos) and confirms busy/idle with GET /api/session/active
// (`busyTransitions()` only names candidates).

import {
  assistantInfo,
  deriveTitle,
  isDefaultTitle,
  mapContent,
  occurrenceKey,
  partId,
  toLegacyPermission,
  userMessage,
  type LegacyModelRef
} from './mappers'

/** One frame of `GET /api/event`. */
export interface V2Event {
  id?: string
  type: string
  data?: any
  location?: { directory?: string; workspaceID?: string } | null
  durable?: { aggregateID: string; seq: number; version?: number }
}

/** A legacy event to emit: `data: {id, type, properties}` on the wire. */
export interface LegacyEvent {
  type: string
  properties: Record<string, any>
  /** project directory for per-subscriber filtering; absent: every subscriber */
  directory?: string
}

/** Something the projector needs from REST. */
export interface SeedRequest {
  sessionID: string
  /** an assistant message seen mid-turn; absent: the session info itself */
  messageID?: string
}

export interface BusySignal {
  sessionID: string
  /** `idle` is only a candidate: confirm with GET /api/session/active */
  status: 'busy' | 'idle'
}

export interface ProjectorOptions {
  /** minimum gap between two delta-driven updates of one part (ms) */
  throttleMs?: number
  now?: () => number
}

export interface Projector {
  /** Applies one v2 event; returns the legacy events to emit now. */
  push(event: V2Event): LegacyEvent[]
  /** Parts whose delta updates the throttle held back. */
  flush(): LegacyEvent[]
  hasPending(): boolean
  /** Unknown messages / session infos met since the last call. */
  takeSeedRequests(): SeedRequest[]
  /** Answer to a message request: the stored message in legacy shape, or null. */
  seed(sessionID: string, messageID: string, message: { info: any; parts: any[] } | null): LegacyEvent[]
  /** Answer to a session request or refresh: legacy SessionInfo, or null. */
  seedSession(sessionID: string, info: any | null): LegacyEvent[]
  /** The session is idle: completes assistants left open (question-reject zombie). */
  settle(sessionID: string): LegacyEvent[]
  /** Directory a session's events came from, when seen. */
  directoryOf(sessionID: string): string | undefined
  /** Drops sessions untouched for `maxIdleMs` unless `keep` says otherwise. */
  evict(maxIdleMs?: number, keep?: (sessionID: string) => boolean): number
  reset(): void
}

interface PartState {
  msg: MessageState
  /** legacy part id */
  id: string
  key: string
  /** v2 content item (text | reasoning | tool), reduced like message-updater */
  item: any
  /** lifecycle start seen; false: joined mid-stream, accumulated deltas are partial */
  live: boolean
  done: boolean
  emitted: number
  /** v2 text content has no time of its own; the UI reads `time.end` */
  start?: number
  end?: number
}

interface MessageState {
  id: string
  session: SessionState
  kind: 'assistant' | 'compaction' | 'shell'
  /** v2 assistant row without content: assistantInfo() renders it */
  v2: any
  ctx: { parentID?: string; directory?: string; root?: string }
  /** legacy error that has no v2 form (zombie abort, seeded rows) */
  error?: any
  parts: Map<string, PartState>
  /** newest lifecycle per v2 id (textID / reasoningID / callID) */
  latest: Map<string, PartState>
  /** lifecycles per v2 id, numbered like toLegacyMessages (occurrenceKey) */
  count: Map<string, number>
  /** legacy part ids emitted so far (ours or seeded) */
  known: Set<string>
  completed: boolean
  /** created from a mid-turn event: info is a guess until seeded */
  placeholder: boolean
}

interface SessionState {
  id: string
  directory?: string
  /** legacy SessionInfo (session.created, session.updated or REST) */
  info?: any
  // live overlays on top of `info`, reset whenever a fresh info arrives
  agent?: string
  /** v2 model ref `{id, providerID, variant?}` */
  model?: any
  /** null: cleared since `info` was read */
  revert?: any
  activity?: number
  /** saw session.created: the first prompt seen is the first prompt */
  created?: boolean
  title?: string
  lastUserID?: string
  /** last user info, while its agent/model are still guesses */
  pendingUser?: { info: any; agent: boolean; model: boolean }
  messages: Map<string, MessageState>
  /** every message id seen, for revert commits (message.removed) */
  ids: string[]
  touched: number
}

const DEFAULT_THROTTLE_MS = 50
const MAX_MESSAGES = 40
const MAX_IDS = 1000
const INTERRUPTED_TOOL = 'Tool execution interrupted'
const aborted = () => ({ name: 'MessageAbortedError', data: { message: 'Interrupted' } })

// legacy-named events a future v2 server may publish natively
const PASS_THROUGH = new Set([
  'todo.updated',
  'file.edited',
  'file.watcher.updated',
  'session.status',
  'session.idle',
  'session.error',
  'session.compacted',
  'session.diff',
  'message.updated',
  'message.removed',
  'message.part.updated',
  'message.part.removed'
])

/** Event types that only exist in the v2 vocabulary. */
export function isV2EventType(type: string) {
  return type.startsWith('session.next.') || type.startsWith('permission.v2.') || type.startsWith('question.v2.')
}

/** Epoch ms from a v2 timestamp: ms on `/api/event`, ISO strings on the legacy bus. */
function toMs(value: unknown, fallback: number) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    if (!Number.isNaN(ms)) return ms
  }
  return fallback
}

function isInterrupted(error: any) {
  return error?.message === INTERRUPTED_TOOL
}

function legacyModel(model: any): LegacyModelRef | undefined {
  if (!model?.id || !model?.providerID) return undefined
  return { providerID: String(model.providerID), modelID: String(model.id), ...(model.variant ? { variant: String(model.variant) } : {}) }
}

/** v2 row back from a seeded legacy info (round-trips through assistantInfo). */
function fromLegacyInfo(info: any): any {
  return {
    id: info.id,
    type: 'assistant',
    time: { created: info.time?.created ?? 0, ...(info.time?.completed !== undefined ? { completed: info.time.completed } : {}) },
    agent: info.agent ?? info.mode,
    model: info.modelID ? { id: info.modelID, providerID: info.providerID, ...(info.variant ? { variant: info.variant } : {}) } : undefined,
    cost: info.cost,
    tokens: info.tokens,
    finish: info.finish
  }
}

/**
 * Busy/idle hints for one v2 event (spec §D.3). v2 has no status events:
 * prompts and steps mean busy; the end of a run is only a candidate, because
 * a queued prompt may start right after - the hub confirms with
 * GET /api/session/active before emitting idle.
 */
export function busyTransitions(event: V2Event): BusySignal[] {
  const d = event?.data || {}
  const sessionID = typeof d.sessionID === 'string' ? d.sessionID : undefined
  if (!sessionID) return []
  const busy = [{ sessionID, status: 'busy' as const }]
  const idle = [{ sessionID, status: 'idle' as const }]
  switch (event.type) {
    case 'session.next.prompt.admitted':
      return d.delivery === 'steer' ? busy : []
    case 'session.next.prompted':
    case 'session.next.step.started':
    case 'session.next.compaction.started':
    case 'session.next.shell.started':
      return busy
    case 'session.next.step.ended':
      return d.finish === 'tool-calls' ? [] : idle
    case 'session.next.step.failed':
    case 'session.next.compaction.ended':
    case 'session.next.shell.ended':
    case 'question.v2.rejected':
      return idle
    case 'session.next.tool.failed':
      // question reject: the run stops right here, no step event follows
      return isInterrupted(d.error) ? idle : []
    case 'permission.v2.replied':
      return d.reply === 'reject' ? idle : []
    default:
      return []
  }
}

/** Events after which a run is certainly over (no confirmation available). */
function endsRun(event: V2Event) {
  const d = event.data || {}
  switch (event.type) {
    case 'session.next.step.ended':
      return d.finish !== 'tool-calls'
    case 'session.next.step.failed':
    case 'session.next.shell.ended':
      return true
    case 'session.next.tool.failed':
      return isInterrupted(d.error)
    default:
      return false
  }
}

export function createProjector(opts: ProjectorOptions = {}): Projector {
  const throttleMs = opts.throttleMs ?? DEFAULT_THROTTLE_MS
  const now = opts.now ?? Date.now
  const sessions = new Map<string, SessionState>()
  const dirty = new Set<PartState>()
  let requests: SeedRequest[] = []

  // ---- state ----

  function session(id: string, directory?: string): SessionState {
    let s = sessions.get(id)
    if (!s) {
      s = { id, messages: new Map(), ids: [], touched: now() }
      sessions.set(id, s)
    }
    if (directory) s.directory = directory
    s.touched = now()
    return s
  }

  function remember(s: SessionState, messageID: string) {
    if (s.ids.includes(messageID)) return
    s.ids.push(messageID)
    if (s.ids.length > MAX_IDS) s.ids.splice(0, s.ids.length - MAX_IDS)
  }

  function dropMessage(msg: MessageState) {
    for (const p of msg.parts.values()) dirty.delete(p)
    msg.session.messages.delete(msg.id)
  }

  function dropSession(s: SessionState) {
    for (const msg of [...s.messages.values()]) dropMessage(msg)
    sessions.delete(s.id)
  }

  function agentOf(s: SessionState): string | undefined {
    return s.agent ?? s.info?.agent
  }

  function modelOf(s: SessionState): any {
    return s.model ?? s.info?.model
  }

  function createMessage(
    s: SessionState,
    id: string,
    kind: MessageState['kind'],
    v2: { created: number; agent?: string; model?: any; snapshot?: string },
    placeholder = false
  ): MessageState {
    const msg: MessageState = {
      id,
      session: s,
      kind,
      v2: {
        id,
        type: 'assistant',
        time: { created: v2.created },
        agent: v2.agent ?? agentOf(s) ?? 'build',
        model: v2.model ?? modelOf(s),
        ...(v2.snapshot ? { snapshot: { start: v2.snapshot } } : {})
      },
      ctx: { parentID: s.lastUserID, directory: s.directory },
      parts: new Map(),
      latest: new Map(),
      count: new Map(),
      known: new Set(),
      completed: false,
      placeholder
    }
    s.messages.set(id, msg)
    remember(s, id)
    // bounded memory: forget the oldest finished messages
    for (const old of [...s.messages.values()]) {
      if (s.messages.size <= MAX_MESSAGES) break
      if (old.completed) dropMessage(old)
    }
    return msg
  }

  /** Message an assistant-scoped event belongs to; unknown ones get seeded. */
  function assistant(s: SessionState, id: string, ts: number): MessageState {
    const msg = s.messages.get(id)
    if (msg) return msg
    // joined mid-turn: emit what we have, the hub fetches the stored message
    requests.push({ sessionID: s.id, messageID: id })
    return createMessage(s, id, 'assistant', { created: ts }, true)
  }

  function newPart(msg: MessageState, v2id: string, item: any, live: boolean): PartState {
    const key = occurrenceKey(msg.count, v2id)
    const p: PartState = { msg, id: partId(msg.id, key), key, item, live, done: false, emitted: -Infinity }
    msg.parts.set(key, p)
    msg.latest.set(v2id, p)
    return p
  }

  /** Current lifecycle of `v2id`, or a mid-stream stand-in for it. */
  function partFor(msg: MessageState, v2id: string, make: () => any): PartState {
    return msg.latest.get(v2id) ?? newPart(msg, v2id, make(), false)
  }

  function complete(msg: MessageState, patch: Record<string, unknown>, ts: number) {
    Object.assign(msg.v2, patch)
    msg.v2.time = { ...msg.v2.time, completed: ts }
    msg.completed = true
    msg.placeholder = false
  }

  // ---- output ----

  function renderInfo(msg: MessageState) {
    const info = assistantInfo(msg.v2, { sessionID: msg.session.id, ...msg.ctx })
    if (!info.error && msg.error) info.error = msg.error
    if (msg.kind === 'compaction') info.summary = true
    return info
  }

  function messageEvent(msg: MessageState): LegacyEvent {
    return {
      type: 'message.updated',
      properties: { sessionID: msg.session.id, info: renderInfo(msg) },
      directory: msg.session.directory
    }
  }

  function partEvent(s: SessionState, part: any): LegacyEvent {
    return { type: 'message.part.updated', properties: { sessionID: s.id, part }, directory: s.directory }
  }

  function render(p: PartState) {
    const part: any = mapContent(p.item, { sessionID: p.msg.session.id, messageID: p.msg.id, key: p.key })
    if (p.item.type === 'text') {
      // joined mid-lifecycle: the message start, like the REST mapping
      const start = p.start ?? (p.end !== undefined ? p.msg.v2.time?.created : undefined)
      if (start !== undefined) part.time = p.end !== undefined ? { start, end: p.end } : { start }
    }
    return part
  }

  function emitPart(out: LegacyEvent[], p: PartState) {
    dirty.delete(p)
    // a tool seen only by its result has no name yet: the seed brings it
    if (p.item.type === 'tool' && !p.item.name) return
    p.emitted = now()
    p.msg.known.add(p.id)
    out.push(partEvent(p.msg.session, render(p)))
  }

  /** Delta-driven update: at most one per throttle window, the rest in flush(). */
  function touch(out: LegacyEvent[], p: PartState) {
    if (now() - p.emitted >= throttleMs) emitPart(out, p)
    else dirty.add(p)
  }

  function flushMessage(out: LegacyEvent[], msg: MessageState) {
    for (const p of msg.parts.values()) if (dirty.has(p)) emitPart(out, p)
  }

  function composeSession(s: SessionState) {
    if (!s.info) return undefined
    const info = { ...s.info, time: { ...s.info.time } }
    if (s.agent !== undefined) info.agent = s.agent
    if (s.model !== undefined) info.model = s.model
    if (s.revert === null) delete info.revert
    else if (s.revert !== undefined) info.revert = s.revert
    // v2 bumps time.updated only on switches and reverts, not on activity
    if (s.activity !== undefined && s.activity > (info.time.updated ?? 0)) info.time.updated = s.activity
    // v2 never generates titles: show the first prompt instead of "New session - <ISO>"
    if (s.title && isDefaultTitle(info.title)) info.title = s.title
    if (s.directory && !info.directory) info.directory = s.directory
    return info
  }

  function emitSession(out: LegacyEvent[], s: SessionState) {
    const info = composeSession(s)
    if (info) out.push({ type: 'session.updated', properties: { sessionID: s.id, info }, directory: s.directory })
    else requests.push({ sessionID: s.id })
  }

  function setInfo(s: SessionState, info: any) {
    s.info = info
    s.agent = undefined
    s.model = undefined
    s.revert = undefined
    if (!s.directory && typeof info?.directory === 'string') s.directory = info.directory
  }

  // ---- events ----

  function push(event: V2Event): LegacyEvent[] {
    const out: LegacyEvent[] = []
    const type = event?.type
    if (typeof type !== 'string') return out
    const d = event.data && typeof event.data === 'object' ? event.data : {}
    const directory = event.location?.directory || undefined
    const sid: string | undefined = typeof d.sessionID === 'string' ? d.sessionID : undefined
    const s = sid ? session(sid, directory) : undefined
    const dir = directory ?? s?.directory
    const ts = toMs(d.timestamp, now())

    if (type === 'server.connected') {
      out.push({ type, properties: {} })
      return out
    }

    if (type === 'session.created' || type === 'session.updated' || type === 'session.deleted') {
      const id: string | undefined = sid ?? d.info?.id
      if (!id) return out
      const target = s ?? session(id, directory)
      if (type === 'session.deleted') {
        out.push({ type, properties: d, directory: dir ?? target.directory })
        dropSession(target)
        return out
      }
      if (d.info) setInfo(target, d.info)
      if (type === 'session.updated') {
        out.push({ type, properties: d, directory: dir ?? target.directory })
        return out
      }
      // v1-shaped info, usable as is; the sidebar only upserts on session.updated
      target.created = true
      out.push({ type, properties: { sessionID: id, info: d.info }, directory: dir ?? target.directory })
      emitSession(out, target)
      return out
    }

    if (type === 'permission.v2.asked') {
      out.push({ type: 'permission.asked', properties: toLegacyPermission(d), directory: dir })
      return out
    }
    if (type === 'permission.v2.replied') {
      out.push({
        type: 'permission.replied',
        properties: { sessionID: d.sessionID, requestID: d.requestID, permissionID: d.requestID, reply: d.reply, response: d.reply },
        directory: dir
      })
      return out
    }
    if (type === 'question.v2.asked' || type === 'question.v2.replied' || type === 'question.v2.rejected') {
      // same shapes as the legacy question events
      out.push({ type: type.replace('.v2.', '.'), properties: d, directory: dir })
      return out
    }
    if (PASS_THROUGH.has(type)) {
      out.push({ type, properties: d, directory: dir })
      return out
    }
    // plugin.added, catalog.updated, reference.updated, pty.*, … are noise here
    if (!s || !type.startsWith('session.next.')) return out

    switch (type) {
      case 'session.next.prompted':
      case 'session.next.synthetic': {
        if (typeof d.messageID !== 'string') break
        const synthetic = type === 'session.next.synthetic'
        const prompt = synthetic ? { text: d.text } : d.prompt || {}
        const agent = agentOf(s)
        const model = legacyModel(modelOf(s))
        const { info, parts } = userMessage(
          { id: d.messageID, time: { created: ts }, text: prompt.text ?? '', files: prompt.files, agents: prompt.agents },
          { sessionID: s.id, agent, model }
        )
        s.lastUserID = d.messageID
        // a session without its own agent/model resolves them per run: the step tells
        s.pendingUser = agent && model ? undefined : { info, agent: !agent, model: !model }
        remember(s, d.messageID)
        out.push({ type: 'message.updated', properties: { sessionID: s.id, info }, directory: dir })
        for (const part of parts) out.push(partEvent(s, synthetic ? { ...part, synthetic: true } : part))
        s.activity = ts
        if (!synthetic && s.created && s.title === undefined) s.title = deriveTitle(prompt.text) ?? ''
        emitSession(out, s)
        break
      }

      case 'session.next.step.started': {
        const id = d.assistantMessageID
        if (typeof id !== 'string') break
        if (d.agent) s.agent = d.agent
        if (d.model) s.model = d.model
        const user = s.pendingUser
        if (user && user.info.id === s.lastUserID) {
          // same agent/model the REST snapshot gives it (taken from its answer)
          const info = { ...user.info }
          if (user.agent && d.agent) info.agent = d.agent
          if (user.model && legacyModel(d.model)) info.model = legacyModel(d.model)
          out.push({ type: 'message.updated', properties: { sessionID: s.id, info }, directory: dir })
        }
        s.pendingUser = undefined
        // a newer step supersedes stale incomplete rows, as the server's reducer does
        for (const old of s.messages.values()) {
          if (old.id === id || old.completed || old.kind !== 'assistant') continue
          flushMessage(out, old)
          complete(old, {}, ts)
          out.push(messageEvent(old))
        }
        let msg = s.messages.get(id)
        if (!msg) msg = createMessage(s, id, 'assistant', { created: ts, agent: d.agent, model: d.model, snapshot: d.snapshot })
        msg.placeholder = false
        out.push(messageEvent(msg))
        const start = { id: partId(id, 'start'), sessionID: s.id, messageID: id, type: 'step-start', ...(d.snapshot ? { snapshot: d.snapshot } : {}) }
        msg.known.add(start.id)
        out.push(partEvent(s, start))
        s.activity = ts
        break
      }

      case 'session.next.step.ended':
      case 'session.next.step.failed': {
        if (typeof d.assistantMessageID !== 'string') break
        const msg = assistant(s, d.assistantMessageID, ts)
        flushMessage(out, msg)
        if (type === 'session.next.step.ended') {
          complete(msg, {
            finish: d.finish,
            cost: d.cost ?? 0,
            tokens: d.tokens,
            ...(d.snapshot || d.files ? { snapshot: { ...msg.v2.snapshot, end: d.snapshot, files: d.files } } : {})
          }, ts)
          const info = renderInfo(msg)
          const finish = {
            id: partId(msg.id, 'finish'),
            sessionID: s.id,
            messageID: msg.id,
            type: 'step-finish',
            reason: d.finish,
            ...(d.snapshot ? { snapshot: d.snapshot } : {}),
            cost: info.cost,
            tokens: info.tokens
          }
          msg.known.add(finish.id)
          out.push(partEvent(s, finish))
          out.push({ type: 'message.updated', properties: { sessionID: s.id, info }, directory: s.directory })
        } else {
          complete(msg, { finish: 'error', error: d.error }, ts)
          msg.error = undefined
          const info = renderInfo(msg)
          out.push({ type: 'message.updated', properties: { sessionID: s.id, info }, directory: s.directory })
          // a user stop must not raise the Retry toast
          if (info.error && info.error.name !== 'MessageAbortedError') {
            out.push({ type: 'session.error', properties: { sessionID: s.id, error: info.error }, directory: dir })
          }
        }
        s.activity = ts
        break
      }

      case 'session.next.text.started':
      case 'session.next.reasoning.started': {
        if (typeof d.assistantMessageID !== 'string') break
        const msg = assistant(s, d.assistantMessageID, ts)
        const p = type === 'session.next.text.started'
          ? newPart(msg, String(d.textID), { type: 'text', id: d.textID, text: '' }, true)
          : newPart(msg, String(d.reasoningID), {
            type: 'reasoning',
            id: d.reasoningID,
            text: '',
            ...(d.providerMetadata !== undefined ? { providerMetadata: d.providerMetadata } : {}),
            time: { created: ts }
          }, true)
        p.start = ts
        emitPart(out, p)
        break
      }

      case 'session.next.text.delta':
      case 'session.next.reasoning.delta':
      case 'session.next.text.ended':
      case 'session.next.reasoning.ended': {
        if (typeof d.assistantMessageID !== 'string') break
        const msg = assistant(s, d.assistantMessageID, ts)
        const text = type.startsWith('session.next.text.')
        const p = partFor(msg, String(text ? d.textID : d.reasoningID), () => text
          ? { type: 'text', id: d.textID, text: '' }
          : { type: 'reasoning', id: d.reasoningID, text: '', time: { created: ts } })
        if (type.endsWith('.delta')) {
          // mid-stream stand-ins wait for `ended`: partial text would overwrite what the UI loaded
          if (!p.live || p.done) break
          p.item.text += String(d.delta ?? '')
          touch(out, p)
          break
        }
        p.item.text = typeof d.text === 'string' ? d.text : p.item.text
        if (text) {
          p.end = ts
        } else {
          p.item.time = { created: p.item.time?.created ?? ts, completed: ts }
          if (d.providerMetadata !== undefined) p.item.providerMetadata = d.providerMetadata
        }
        p.done = true
        p.live = true
        emitPart(out, p)
        break
      }

      case 'session.next.tool.input.started': {
        if (typeof d.assistantMessageID !== 'string') break
        const msg = assistant(s, d.assistantMessageID, ts)
        const p = newPart(msg, String(d.callID), {
          type: 'tool',
          id: d.callID,
          name: d.name,
          time: { created: ts },
          state: { status: 'pending', input: '' }
        }, true)
        emitPart(out, p)
        break
      }

      case 'session.next.tool.input.delta':
      case 'session.next.tool.input.ended':
      case 'session.next.tool.called':
      case 'session.next.tool.progress':
      case 'session.next.tool.success':
      case 'session.next.tool.failed': {
        if (typeof d.assistantMessageID !== 'string') break
        const msg = assistant(s, d.assistantMessageID, ts)
        const p = partFor(msg, String(d.callID), () => ({
          type: 'tool',
          id: d.callID,
          name: typeof d.tool === 'string' ? d.tool : '',
          time: { created: ts },
          state: { status: 'pending', input: '' }
        }))
        const tool = p.item
        const state = tool.state
        if (type === 'session.next.tool.input.delta') {
          if (!p.live || state.status !== 'pending') break
          state.input += String(d.delta ?? '')
          touch(out, p)
        } else if (type === 'session.next.tool.input.ended') {
          if (state.status !== 'pending') break
          state.input = String(d.text ?? '')
          emitPart(out, p)
        } else if (type === 'session.next.tool.called') {
          if (!tool.name && typeof d.tool === 'string') tool.name = d.tool
          tool.provider = d.provider
          tool.time = { ...tool.time, ran: ts }
          tool.state = { status: 'running', input: d.input ?? {}, structured: {}, content: [] }
          p.live = true
          emitPart(out, p)
        } else if (type === 'session.next.tool.progress') {
          if (state.status !== 'running') break
          state.structured = d.structured ?? {}
          state.content = [...(d.content ?? [])]
          touch(out, p)
        } else {
          const input = typeof state.input === 'string' || !state.input ? {} : state.input
          const running = state.status === 'running'
          tool.provider = {
            executed: Boolean(d.provider?.executed || tool.provider?.executed),
            metadata: tool.provider?.metadata,
            resultMetadata: d.provider?.metadata
          }
          tool.time = { ...tool.time, completed: ts }
          tool.state = type === 'session.next.tool.success'
            ? {
                status: 'completed',
                input,
                structured: d.structured ?? {},
                content: [...(d.content ?? [])],
                outputPaths: d.outputPaths ? [...d.outputPaths] : [],
                ...(d.result !== undefined ? { result: d.result } : {})
              }
            : {
                status: 'error',
                error: d.error,
                input,
                structured: running ? state.structured ?? {} : {},
                content: running ? state.content ?? [] : [],
                ...(d.result !== undefined ? { result: d.result } : {})
              }
          p.done = true
          p.live = true
          emitPart(out, p)
        }
        break
      }

      case 'session.next.compaction.started':
      case 'session.next.compaction.delta':
      case 'session.next.compaction.ended': {
        if (typeof d.messageID !== 'string') break
        let msg = s.messages.get(d.messageID)
        const fresh = !msg
        if (!msg) msg = createMessage(s, d.messageID, 'compaction', { created: ts, agent: 'compaction' })
        if (type === 'session.next.compaction.started' && !msg.latest.has('summary')) {
          newPart(msg, 'summary', { type: 'text', id: 'summary', text: '' }, true).start = ts
        }
        if (fresh) out.push(messageEvent(msg))
        if (type === 'session.next.compaction.started') {
          s.activity = ts
          break
        }
        const p = partFor(msg, 'summary', () => ({ type: 'text', id: 'summary', text: '' }))
        if (type === 'session.next.compaction.delta') {
          if (!p.live || p.done) break
          p.item.text += String(d.text ?? '')
          touch(out, p)
          break
        }
        p.item.text = typeof d.text === 'string' ? d.text : p.item.text
        p.start ??= ts
        p.end = ts
        p.done = true
        p.live = true
        emitPart(out, p)
        complete(msg, { finish: 'stop' }, ts)
        out.push(messageEvent(msg))
        out.push({ type: 'session.compacted', properties: { sessionID: s.id }, directory: dir })
        s.activity = ts
        break
      }

      case 'session.next.shell.started': {
        if (typeof d.messageID !== 'string') break
        const msg = s.messages.get(d.messageID) ?? createMessage(s, d.messageID, 'shell', { created: ts })
        out.push(messageEvent(msg))
        const p = newPart(msg, String(d.callID || 'shell'), {
          type: 'tool',
          id: d.callID,
          name: 'bash',
          time: { created: ts, ran: ts },
          state: { status: 'running', input: { command: String(d.command ?? '') }, structured: {}, content: [] }
        }, true)
        emitPart(out, p)
        s.activity = ts
        break
      }

      case 'session.next.shell.ended': {
        const callID = String(d.callID || 'shell')
        const msg = [...s.messages.values()].reverse().find((m) => m.kind === 'shell' && m.latest.has(callID))
        const p = msg?.latest.get(callID)
        if (!msg || !p) break
        const output = String(d.output ?? '')
        p.item.time = { ...p.item.time, completed: ts }
        p.item.state = {
          status: 'completed',
          input: p.item.state.input,
          structured: { output },
          content: [{ type: 'text', text: output }]
        }
        p.done = true
        emitPart(out, p)
        complete(msg, { finish: 'stop' }, ts)
        out.push(messageEvent(msg))
        s.activity = ts
        break
      }

      case 'session.next.agent.switched':
      case 'session.next.model.switched': {
        if (typeof d.messageID === 'string') remember(s, d.messageID)
        if (type === 'session.next.agent.switched') s.agent = d.agent
        else s.model = d.model
        emitSession(out, s)
        break
      }

      case 'session.next.moved': {
        const moved = d.location?.directory
        if (typeof moved === 'string') {
          s.directory = moved
          if (s.info) s.info = { ...s.info, directory: moved, path: d.subdirectory ?? s.info.path }
        }
        emitSession(out, s)
        break
      }

      case 'session.next.revert.staged':
        s.revert = d.revert ?? null
        emitSession(out, s)
        break

      case 'session.next.revert.cleared':
        s.revert = null
        emitSession(out, s)
        break

      case 'session.next.revert.committed': {
        // v2 boundary = last message kept; msg_ ids sort by creation time
        const boundary: string | undefined = d.messageID ?? s.revert?.messageID ?? s.info?.revert?.messageID
        s.revert = null
        if (boundary) {
          for (const id of s.ids.filter((m) => m > boundary)) {
            out.push({ type: 'message.removed', properties: { sessionID: s.id, messageID: id }, directory: dir })
            const msg = s.messages.get(id)
            if (msg) dropMessage(msg)
          }
          s.ids = s.ids.filter((m) => m <= boundary)
          if (s.lastUserID && s.lastUserID > boundary) s.lastUserID = undefined
        }
        emitSession(out, s)
        break
      }

      case 'session.next.retried':
        out.push({
          type: 'session.status',
          properties: {
            sessionID: s.id,
            status: { type: 'retry', attempt: d.attempt, message: d.error?.message ?? 'Retrying', next: ts }
          },
          directory: dir
        })
        break

      // prompt.admitted (busy only), context.updated (hidden system context)
      default:
        break
    }
    return out
  }

  // ---- seeding ----

  function seed(sessionID: string, messageID: string, message: { info: any; parts: any[] } | null): LegacyEvent[] {
    const out: LegacyEvent[] = []
    const s = sessions.get(sessionID)
    const msg = s?.messages.get(messageID)
    if (!s || !msg) return out
    if (!message?.info) {
      // nothing stored (yet): our guess beats a nameless stub
      if (msg.placeholder) {
        msg.placeholder = false
        out.push(messageEvent(msg))
      }
      return out
    }
    // the stored row, overlaid with what live events said since (newer)
    const v2 = fromLegacyInfo(message.info)
    if (msg.completed) {
      v2.time.completed = msg.v2.time?.completed ?? v2.time.completed
      for (const key of ['finish', 'cost', 'tokens', 'error', 'snapshot']) {
        if (msg.v2[key] !== undefined) v2[key] = msg.v2[key]
      }
    }
    if (!v2.error) msg.error = message.info.error ?? msg.error
    msg.v2 = v2
    msg.ctx = {
      parentID: message.info.parentID ?? msg.ctx.parentID,
      directory: message.info.path?.cwd || msg.ctx.directory,
      root: message.info.path?.root || msg.ctx.root
    }
    msg.placeholder = false
    out.push(messageEvent(msg))
    for (const part of message.parts ?? []) {
      if (!part?.id) continue
      const p = [...msg.parts.values()].find((x) => x.id === part.id)
      if (!p) {
        if (msg.known.has(part.id)) continue
        msg.known.add(part.id)
        out.push(partEvent(s, part))
        continue
      }
      if (p.item.type === 'tool' && !p.item.name && typeof part.tool === 'string') p.item.name = part.tool
      if (p.item.type === 'text' && typeof part.time?.start === 'number') p.start ??= part.time.start
      if (!p.live && !p.done && (part.type === 'text' || part.type === 'reasoning')) {
        // joined mid-lifecycle: the stored text is the best we have until `ended`
        if (typeof part.text === 'string') p.item.text = part.text
        msg.known.add(part.id)
        out.push(partEvent(s, part))
        continue
      }
      emitPart(out, p)
    }
    // tool results held back for a name the seed did not know either
    for (const p of msg.parts.values()) {
      if (!msg.known.has(p.id) && p.done && p.item.type === 'tool') {
        p.item.name ||= 'tool'
        emitPart(out, p)
      }
    }
    return out
  }

  function seedSession(sessionID: string, info: any | null): LegacyEvent[] {
    const out: LegacyEvent[] = []
    const s = session(sessionID)
    if (info) setInfo(s, info)
    if (s.info) emitSession(out, s)
    return out
  }

  // ---- lifecycle ----

  function settle(sessionID: string): LegacyEvent[] {
    const out: LegacyEvent[] = []
    const s = sessions.get(sessionID)
    if (!s) return out
    for (const msg of s.messages.values()) {
      if (msg.completed) continue
      flushMessage(out, msg)
      let end = msg.v2.time?.created ?? 0
      for (const p of msg.parts.values()) {
        const t = p.item.time || {}
        end = Math.max(end, t.created ?? 0, t.ran ?? 0, t.completed ?? 0, p.start ?? 0, p.end ?? 0)
      }
      if (!msg.v2.error) msg.error ??= aborted()
      complete(msg, {}, end)
      out.push(messageEvent(msg))
    }
    return out
  }

  function flush(): LegacyEvent[] {
    const out: LegacyEvent[] = []
    for (const p of [...dirty]) emitPart(out, p)
    return out
  }

  function evict(maxIdleMs = 10 * 60_000, keep?: (sessionID: string) => boolean) {
    const limit = now() - maxIdleMs
    let dropped = 0
    for (const s of [...sessions.values()]) {
      if (s.touched >= limit || keep?.(s.id)) continue
      dropSession(s)
      dropped++
    }
    return dropped
  }

  return {
    push,
    flush,
    hasPending: () => dirty.size > 0,
    takeSeedRequests() {
      const taken = requests
      requests = []
      return taken
    },
    seed,
    seedSession,
    settle,
    directoryOf: (sessionID) => sessions.get(sessionID)?.directory,
    evict,
    reset() {
      sessions.clear()
      dirty.clear()
      requests = []
    }
  }
}

/** Legacy `/event` envelope. */
export interface LegacyEnvelope {
  id?: string
  type: string
  properties?: Record<string, any>
}

export interface MirrorProjector {
  /** One legacy-bus event in, the events to forward out (same envelope). */
  push(event: LegacyEnvelope): LegacyEnvelope[]
  flush(): LegacyEnvelope[]
  hasPending(): boolean
  projector: Projector
}

/**
 * opencode 1.18 is a hybrid: sessions run by the new v2 runner (the new TUI)
 * publish `session.next.*` / `*.v2.*` events, and the server mirrors them onto
 * the LEGACY `/event` bus untouched (`properties` = v2 `data`, timestamps as
 * ISO strings): the legacy UI would not render those sessions at all. This
 * wraps the projector for that bus: legacy events pass through (the same
 * object), v2 events are projected. Nothing confirms busy/idle there, so the
 * status is synthesized from events that certainly end a run
 * (`status: false` turns that off).
 */
export function createMirrorProjector(opts: ProjectorOptions & { status?: boolean } = {}): MirrorProjector {
  const projector = createProjector(opts)
  const synthesize = opts.status ?? true
  const status = new Map<string, 'busy' | 'idle'>()
  let n = 0

  function envelopes(events: LegacyEvent[], id?: string): LegacyEnvelope[] {
    return events.map((e, i) => ({
      id: id ? (i === 0 ? id : `${id}.${i}`) : `evt_mirror${(n++).toString(36)}`,
      type: e.type,
      properties: e.properties
    }))
  }

  function push(event: LegacyEnvelope): LegacyEnvelope[] {
    if (!event || typeof event.type !== 'string') return []
    const props = event.properties || {}
    if (!isV2EventType(event.type)) {
      if (event.type === 'session.created' || event.type === 'session.updated' || event.type === 'session.deleted') {
        // keeps the session cache for session.updated on v2 agent/model switches
        const extra = projector.push({ type: event.type, data: props }).filter((e) => e.type === 'session.updated')
        projector.takeSeedRequests()
        // 1.18 sends no session.updated for v2-run sessions: the sidebar needs one
        if (event.type === 'session.created' && extra.length) return [event, ...envelopes(extra, event.id ? `${event.id}.u` : undefined)]
      }
      return [event]
    }
    const v2: V2Event = { id: event.id, type: event.type, data: props }
    const out = projector.push(v2)
    if (synthesize) {
      for (const signal of busyTransitions(v2)) {
        if (signal.status !== 'busy' || status.get(signal.sessionID) === 'busy') continue
        status.set(signal.sessionID, 'busy')
        out.push({ type: 'session.status', properties: { sessionID: signal.sessionID, status: { type: 'busy' } } })
      }
      const sid = props.sessionID
      if (typeof sid === 'string' && endsRun(v2) && status.get(sid) !== 'idle') {
        status.set(sid, 'idle')
        out.push(...projector.settle(sid))
        out.push({ type: 'session.status', properties: { sessionID: sid, status: { type: 'idle' } } })
        out.push({ type: 'session.idle', properties: { sessionID: sid } })
      }
    }
    // no REST here: unknown messages keep the info we can guess
    for (const req of projector.takeSeedRequests()) {
      if (req.messageID) out.push(...projector.seed(req.sessionID, req.messageID, null))
    }
    return envelopes(out, event.id)
  }

  return {
    push,
    flush: () => envelopes(projector.flush()),
    hasPending: () => projector.hasPending(),
    projector
  }
}
