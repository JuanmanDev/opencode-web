// Pure translations between opencode v2 (`/api/*`) payloads and the legacy
// shapes the UI renders (shared/types/opencode.ts). No Nitro auto-imports and
// no I/O: handlers.ts (REST) and the event projector (SSE) both build on these,
// so a message looks the same whether it was fetched or streamed.
//
// v2 has no part ids: they are minted from the message id plus the content
// key (`prt_<messageID>_<key>`), which REST snapshots and live events share.

/** Legacy `{providerID, modelID}` reference (+ the v2 variant). */
export interface LegacyModelRef {
  providerID: string
  modelID: string
  variant?: string
}

type Dict = Record<string, any>

const ABORTED = new Set(['Provider turn interrupted', 'Tool execution interrupted'])

/** v2 session titles until something renames them (no title generation yet). */
const DEFAULT_TITLE = /^New session - /

const zeroTokens = () => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })

function isObject(value: unknown): value is Dict {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : []
}

/** Drop `undefined` values so JSON payloads stay as lean as the legacy ones. */
function clean<T extends Dict>(value: T): T {
  for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key]
  return value
}

/** Deterministic legacy part id (spec C.2). */
export function partId(messageID: string, key: string): string {
  return `prt_${messageID}_${key}`
}

/**
 * Content ids (`text-0`, `reasoning-0`) restart with every lifecycle, so the
 * same id can occur twice in one message. The first occurrence keeps the plain
 * key, later ones become `<key>_2`, `<key>_3`… The live projector counts
 * `*.started` events with this same helper so ids match the REST snapshot.
 */
export function occurrenceKey(counts: Map<string, number>, key: string): string {
  const n = (counts.get(key) || 0) + 1
  counts.set(key, n)
  return n === 1 ? key : `${key}_${n}`
}

/** Compare form of a directory: `/` separators, no trailing slash, case-folded on Windows. */
export function normDir(directory: string | undefined): string {
  if (!directory) return ''
  const windows = /^[a-zA-Z]:/.test(directory) || directory.includes('\\')
  let out = directory.replace(/\\/g, '/')
  if (out.length > 1) out = out.replace(/\/+$/, '')
  if (/^[a-zA-Z]:$/.test(out)) out += '/'
  return windows ? out.toLowerCase() : out
}

/** v2 runner errors are plain `{type:'unknown', message}`: only interrupts get a name. */
export function mapError(error: { message?: string } | undefined): { name: string; data: { message: string } } | undefined {
  if (!error) return undefined
  const message = String(error.message ?? 'Unknown error')
  return { name: ABORTED.has(message) ? 'MessageAbortedError' : 'UnknownError', data: { message } }
}

/** One-line summary shown next to the tool name (legacy `state.title`). */
export function toolTitle(name: string, input: unknown): string {
  const args = isObject(input) ? input : {}
  const str = (value: unknown) => (typeof value === 'string' && value ? value : undefined)
  switch (name) {
    case 'bash':
      return str(args.command) ?? name
    case 'read':
    case 'write':
    case 'edit':
      return str(args.filePath) ?? str(args.path) ?? name
    case 'glob':
    case 'grep':
      return str(args.pattern) ?? name
    case 'webfetch':
      return str(args.url) ?? name
    case 'websearch':
      return str(args.query) ?? name
    case 'todowrite':
      return `${asArray(args.todos).length} todos`
    case 'question': {
      const n = asArray(args.questions).length
      return `Asked ${n} question${n === 1 ? '' : 's'}`
    }
    default:
      return str(args.description) ?? name
  }
}

function textOf(content: unknown): string {
  return asArray(content)
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
}

/** Short stable hash (djb2): attachment ids must not depend on array position alone. */
function shortHash(text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
  return (hash >>> 0).toString(36)
}

/** Mime type of a `data:` URL, if any. */
function dataMime(url: string): string | undefined {
  const match = /^data:([^;,]+)/i.exec(url)
  return match?.[1]?.toLowerCase()
}

/**
 * Legacy tool `state` (spec C.2). The UI reads `status`, `input`, `output`
 * (string), `title`, `metadata` (scanned for MCP-UI resources) and `error`.
 */
export function mapToolState(
  name: string,
  state: any,
  time?: { created?: number; ran?: number; completed?: number },
  ids?: { sessionID: string; messageID: string }
): Record<string, unknown> {
  const input = isObject(state?.input) ? state.input : {}
  const start = time?.ran ?? time?.created
  const end = time?.completed ?? time?.ran ?? start
  switch (state?.status) {
    case 'running':
      return {
        status: 'running',
        input,
        title: toolTitle(name, input),
        metadata: isObject(state.structured) ? state.structured : {},
        time: clean({ start })
      }
    case 'completed': {
      const metadata: Dict = { ...(isObject(state.structured) ? state.structured : {}) }
      if (asArray(state.outputPaths).length) metadata.outputPaths = state.outputPaths
      if (state.result !== undefined) metadata.result = state.result
      const files = [
        ...asArray(state.content).filter((c) => c?.type === 'file'),
        ...asArray(state.attachments)
      ]
      const attachments = files.map((file, i) => clean({
        id: partId(ids?.messageID ?? '', `att_${shortHash(`${i}:${file.uri}`)}`),
        sessionID: ids?.sessionID ?? '',
        messageID: ids?.messageID ?? '',
        type: 'file',
        mime: file.mime ?? dataMime(String(file.uri ?? '')) ?? 'application/octet-stream',
        url: file.uri,
        filename: file.name
      }))
      return clean({
        status: 'completed',
        input,
        output: textOf(state.content),
        title: toolTitle(name, input),
        metadata,
        time: clean({ start, end }),
        attachments: attachments.length ? attachments : undefined
      })
    }
    case 'error':
      return {
        status: 'error',
        input,
        error: String(state.error?.message ?? 'Tool failed'),
        metadata: isObject(state.structured) ? state.structured : {},
        time: clean({ start, end })
      }
    default:
      // pending: `input` is the raw JSON text streamed so far
      return { status: 'pending', input: {}, raw: typeof state?.input === 'string' ? state.input : '' }
  }
}

/** One v2 assistant content item -> one legacy part (ids included). */
export function mapContent(
  item: any,
  ctx: { sessionID: string; messageID: string; key?: string }
): Record<string, unknown> {
  const base = {
    id: partId(ctx.messageID, ctx.key ?? String(item?.id ?? item?.type ?? 'part')),
    sessionID: ctx.sessionID,
    messageID: ctx.messageID
  }
  switch (item?.type) {
    case 'text':
      return { ...base, type: 'text', text: String(item.text ?? '') }
    case 'reasoning':
      return clean({
        ...base,
        type: 'reasoning',
        text: String(item.text ?? ''),
        metadata: item.providerMetadata,
        time: item.time ? clean({ start: item.time.created, end: item.time.completed }) : undefined
      })
    case 'tool':
      return clean({
        ...base,
        type: 'tool',
        callID: item.id,
        tool: item.name,
        state: mapToolState(item.name, item.state, item.time, ctx),
        metadata: item.provider?.metadata
      })
    default:
      return { ...(isObject(item) ? item : {}), ...base, type: String(item?.type ?? 'unknown') }
  }
}

function toLegacyModel(model: any): LegacyModelRef | undefined {
  if (!model?.id || !model?.providerID) return undefined
  return clean({ providerID: String(model.providerID), modelID: String(model.id), variant: model.variant })
}

/** v2 `user` message (or an admitted prompt) -> legacy `{info, parts}`. */
export function userMessage(
  v2: { id: string; time?: { created?: number }; text?: string; files?: any[]; agents?: any[] },
  ctx: { sessionID: string; agent?: string; model?: LegacyModelRef }
): { info: any; parts: any[] } {
  const id = v2.id
  const base = { sessionID: ctx.sessionID, messageID: id }
  const parts: any[] = []
  if (v2.text) parts.push({ id: partId(id, 'text'), ...base, type: 'text', text: v2.text })
  asArray(v2.files).forEach((file, i) => {
    parts.push(clean({
      id: partId(id, `file_${i}`),
      ...base,
      type: 'file',
      mime: file?.mime ?? dataMime(String(file?.uri ?? '')) ?? 'application/octet-stream',
      filename: file?.name,
      url: file?.uri,
      source: file?.source
    }))
  })
  asArray(v2.agents).forEach((agent, i) => {
    parts.push(clean({ id: partId(id, `agent_${i}`), ...base, type: 'agent', name: agent?.name, source: agent?.source }))
  })
  const info = clean({
    id,
    sessionID: ctx.sessionID,
    role: 'user',
    time: { created: v2.time?.created ?? 0 },
    agent: ctx.agent ?? 'build',
    model: ctx.model ? clean({ ...ctx.model }) : undefined
  })
  return { info, parts }
}

/** Legacy tokens carry a `total`. */
function legacyTokens(tokens: any) {
  const t = isObject(tokens) ? tokens : zeroTokens()
  const cache = isObject(t.cache) ? t.cache : { read: 0, write: 0 }
  const total = (t.input || 0) + (t.output || 0) + (t.reasoning || 0) + (cache.read || 0) + (cache.write || 0)
  return { total, input: t.input || 0, output: t.output || 0, reasoning: t.reasoning || 0, cache: { read: cache.read || 0, write: cache.write || 0 } }
}

/** v2 `assistant` message -> legacy assistant `info` (no parts). */
export function assistantInfo(
  v2: any,
  ctx: { sessionID: string; parentID?: string; directory?: string; root?: string }
): any {
  return clean({
    id: v2.id,
    sessionID: ctx.sessionID,
    role: 'assistant',
    parentID: ctx.parentID,
    time: clean({ created: v2.time?.created ?? 0, completed: v2.time?.completed }),
    modelID: v2.model?.id,
    providerID: v2.model?.providerID,
    variant: v2.model?.variant,
    agent: v2.agent,
    mode: v2.agent,
    path: { cwd: ctx.directory ?? '', root: ctx.root ?? ctx.directory ?? '' },
    cost: v2.cost ?? 0,
    tokens: legacyTokens(v2.tokens),
    finish: v2.finish,
    error: mapError(v2.error)
  })
}

/** Latest timestamp inside an assistant message (zombie completion time). */
function innerTime(message: any): number | undefined {
  let max: number | undefined
  const see = (value: unknown) => {
    if (typeof value === 'number' && (max === undefined || value > max)) max = value
  }
  for (const item of asArray(message.content)) {
    see(item?.time?.created)
    see(item?.time?.ran)
    see(item?.time?.completed)
  }
  return max
}

const INTERRUPTED = { name: 'MessageAbortedError', data: { message: 'Interrupted' } }

/**
 * v2 message list -> legacy `[{info, parts}]` (spec C.2).
 *
 * - one legacy assistant message per v2 assistant (= per LLM step)
 * - `synthetic` -> user message with a `synthetic` text part, `shell` ->
 *   assistant with a bash tool part, `compaction` -> summary assistant,
 *   `system` / `*-switched` are hidden (switches only update agent/model)
 * - zombie fix: an assistant that never completed while the session is idle
 *   (e.g. after a question reject) gets a completion time and an abort error,
 *   otherwise the UI keeps the input locked
 * - a staged revert hides everything after its boundary (v2 `messageID` is
 *   the last message kept), the way the TUI hides reverted turns
 */
export function toLegacyMessages(
  messages: any[],
  ctx: { sessionID: string; session?: any; active: boolean; root?: string }
): Array<{ info: any; parts: any[] }> {
  const { sessionID, session } = ctx
  const directory: string | undefined = session?.location?.directory ?? session?.directory
  const boundary: string | undefined = session?.revert?.messageID
  const sorted = asArray(messages)
    .filter((m) => m && typeof m.id === 'string')
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const list = boundary ? sorted.filter((m) => m.id <= boundary) : sorted

  // the assistant answering each user message (look-ahead for agent/model)
  const nextAssistant: Array<any> = new Array(list.length)
  let upcoming: any
  for (let i = list.length - 1; i >= 0; i--) {
    nextAssistant[i] = upcoming
    if (list[i].type === 'assistant') upcoming = list[i]
  }
  let lastRunning = -1
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].type === 'assistant' || list[i].type === 'shell') {
      lastRunning = i
      break
    }
  }

  const out: Array<{ info: any; parts: any[] }> = []
  let lastUserID: string | undefined
  let lastAgent: string | undefined
  let lastModel: LegacyModelRef | undefined

  const zombie = (message: any, index: number) =>
    !message.time?.completed && (!ctx.active || index !== lastRunning)

  list.forEach((m, index) => {
    switch (m.type) {
      case 'agent-switched':
        lastAgent = m.agent
        return
      case 'model-switched':
        lastModel = toLegacyModel(m.model) ?? lastModel
        return
      case 'user':
      case 'synthetic': {
        const next = nextAssistant[index]
        const msg = userMessage(m.type === 'user' ? m : { id: m.id, time: m.time, text: m.text }, {
          sessionID,
          agent: lastAgent ?? next?.agent ?? session?.agent ?? 'build',
          model: lastModel ?? toLegacyModel(next?.model) ?? toLegacyModel(session?.model)
        })
        if (m.type === 'synthetic') for (const part of msg.parts) part.synthetic = true
        lastUserID = m.id
        out.push(msg)
        return
      }
      case 'assistant': {
        const info = assistantInfo(m, { sessionID, parentID: lastUserID, directory, root: ctx.root })
        const dead = zombie(m, index)
        if (dead) {
          info.time.completed = innerTime(m) ?? info.time.created
          info.error ??= { ...INTERRUPTED, data: { ...INTERRUPTED.data } }
        }
        const created = info.time.created
        const completed: number | undefined = info.time.completed
        const counts = new Map<string, number>()
        const content = asArray(m.content)
        const parts: any[] = [clean({
          id: partId(m.id, 'start'),
          sessionID,
          messageID: m.id,
          type: 'step-start',
          snapshot: m.snapshot?.start
        })]
        content.forEach((item, i) => {
          const key = occurrenceKey(counts, String(item?.id ?? item?.type ?? i))
          const part: any = mapContent(item, { sessionID, messageID: m.id, key })
          // v2 text has no times: the UI shows "writing…" for a text part
          // without `time.end`, so finished ones get the message's bounds
          if (part.type === 'text' || part.type === 'reasoning') {
            const finished = completed !== undefined || i < content.length - 1
            const start = part.time?.start ?? created
            const end = part.time?.end ?? (finished ? completed ?? start : undefined)
            part.time = clean({ start, end })
          }
          if (dead && part.type === 'tool' && (part.state.status === 'pending' || part.state.status === 'running')) {
            part.state = {
              status: 'error',
              input: part.state.input ?? {},
              error: 'Interrupted',
              time: clean({ start: part.state.time?.start ?? created, end: completed })
            }
          }
          parts.push(part)
        })
        if (m.finish && m.finish !== 'error') {
          parts.push(clean({
            id: partId(m.id, 'finish'),
            sessionID,
            messageID: m.id,
            type: 'step-finish',
            reason: m.finish,
            snapshot: m.snapshot?.end,
            cost: m.cost ?? 0,
            tokens: legacyTokens(m.tokens)
          }))
        }
        lastAgent = m.agent ?? lastAgent
        lastModel = toLegacyModel(m.model) ?? lastModel
        out.push({ info, parts })
        return
      }
      case 'shell': {
        const agent = lastAgent ?? session?.agent ?? 'build'
        const created = m.time?.created ?? 0
        const dead = zombie(m, index)
        const completed: number | undefined = m.time?.completed ?? (dead ? created : undefined)
        const command = String(m.command ?? '')
        const info = clean({
          ...assistantInfo(
            { id: m.id, time: { created, completed }, agent, model: lastModel && { id: lastModel.modelID, providerID: lastModel.providerID } },
            { sessionID, parentID: lastUserID, directory, root: ctx.root }
          ),
          finish: completed !== undefined ? 'stop' : undefined,
          error: dead ? { ...INTERRUPTED, data: { ...INTERRUPTED.data } } : undefined
        })
        const state = m.time?.completed !== undefined
          ? { status: 'completed', input: { command }, output: String(m.output ?? ''), title: command, metadata: { output: String(m.output ?? '') }, time: { start: created, end: m.time.completed } }
          : dead
            ? { status: 'error', input: { command }, error: 'Interrupted', time: { start: created, end: created } }
            : { status: 'running', input: { command }, title: command, time: { start: created } }
        out.push({
          info,
          parts: [{ id: partId(m.id, String(m.callID || 'shell')), sessionID, messageID: m.id, type: 'tool', callID: m.callID, tool: 'bash', state }]
        })
        return
      }
      case 'compaction': {
        const created = m.time?.created ?? 0
        const info = assistantInfo(
          { id: m.id, time: { created, completed: created }, agent: 'compaction', model: lastModel && { id: lastModel.modelID, providerID: lastModel.providerID }, finish: 'stop' },
          { sessionID, parentID: lastUserID, directory, root: ctx.root }
        )
        info.summary = true
        out.push({
          info,
          parts: [{ id: partId(m.id, 'summary'), sessionID, messageID: m.id, type: 'text', text: String(m.summary ?? ''), time: { start: created, end: created } }]
        })
        return
      }
      default:
        // `system` (hidden context) and anything newer than this adapter
        return
    }
  })
  return out
}

/** Latest todo list from the last completed `todowrite` call (no todo endpoint in v2). */
export function todosFromMessages(messages: any[]): any[] | undefined {
  const sorted = asArray(messages)
    .filter((m) => m?.type === 'assistant')
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
  for (const message of sorted) {
    const tools = asArray(message.content).filter((c) => c?.type === 'tool' && c.name === 'todowrite' && c.state?.status === 'completed')
    const last = tools[tools.length - 1]
    if (!last) continue
    const todos = last.state.structured?.todos ?? last.state.input?.todos
    if (Array.isArray(todos)) return todos
  }
  return undefined
}

/**
 * Boundary for an undo (v2 `revert/stage` keeps everything up to and
 * including `messageID`; legacy names the first message to drop).
 * - `firstDropped` given: the message right before it
 * - otherwise: the message right before the last user prompt still visible
 *   (`current` = an already staged boundary, so repeated undos walk back)
 * Undefined when nothing precedes it (the first turn cannot be undone).
 */
export function revertBoundary(messages: any[], opts: { current?: string; firstDropped?: string } = {}): string | undefined {
  const sorted = asArray(messages)
    .filter((m) => m && typeof m.id === 'string')
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  let index: number
  if (opts.firstDropped) {
    index = sorted.findIndex((m) => m.id === opts.firstDropped)
  } else {
    index = -1
    for (let i = sorted.length - 1; i >= 0; i--) {
      const m = sorted[i]
      if (opts.current && m.id > opts.current) continue
      if (m.type === 'user') {
        index = i
        break
      }
    }
  }
  return index > 0 ? sorted[index - 1].id : undefined
}

/** First line of a prompt as a session title (v2 does not generate titles). */
export function deriveTitle(text: string | undefined): string | undefined {
  const line = String(text || '').split('\n').map((l) => l.trim()).find(Boolean)
  if (!line) return undefined
  const flat = line.replace(/\s+/g, ' ')
  return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat
}

/** True while a v2 session still carries its placeholder title. */
export function isDefaultTitle(title: string | undefined): boolean {
  return !title || DEFAULT_TITLE.test(title)
}

/** v2 `Session.Info` -> legacy session (spec C.1); `overrides` come from opencode-web meta. */
export function toLegacySession(v2: any, overrides: { title?: string; lastActivity?: number } = {}): any {
  const created = v2?.time?.created ?? 0
  const updated = Math.max(v2?.time?.updated ?? 0, overrides.lastActivity ?? 0, created)
  return clean({
    id: v2?.id,
    projectID: v2?.projectID,
    workspaceID: v2?.location?.workspaceID,
    directory: v2?.location?.directory,
    path: v2?.subpath ?? '',
    parentID: v2?.parentID,
    title: overrides.title || v2?.title,
    version: 'v2',
    agent: v2?.agent,
    model: v2?.model,
    cost: v2?.cost ?? 0,
    tokens: v2?.tokens ?? zeroTokens(),
    time: clean({ created, updated, archived: v2?.time?.archived }),
    revert: v2?.revert
  })
}

/** v2 permission request -> legacy shape plus the fields PermissionPrompt.vue reads (spec C.8). */
export function toLegacyPermission(req: any): any {
  const resources = asArray(req?.resources).map(String)
  const action = String(req?.action ?? 'permission')
  const tool = req?.source?.type === 'tool' ? { messageID: req.source.messageID, callID: req.source.callID } : undefined
  return clean({
    id: req?.id,
    sessionID: req?.sessionID,
    permission: action,
    patterns: resources,
    always: asArray(req?.save),
    metadata: isObject(req?.metadata) ? req.metadata : {},
    tool,
    title: action === 'bash' ? `Run: ${resources.join(' ')}` : `${action}: ${resources.join(', ')}`,
    type: action,
    pattern: resources,
    messageID: tool?.messageID,
    callID: tool?.callID
  })
}

const SECRET_KEY = /key|token|secret|password|authorization|credential/i

/** Variant bodies are model options (`reasoningEffort`…); never let a credential through. */
function safeOptions(body: unknown): Dict {
  if (!isObject(body)) return {}
  return Object.fromEntries(Object.entries(body).filter(([key]) => !SECRET_KEY.test(key)))
}

function legacyCost(costs: unknown) {
  const list = asArray(costs)
  const cost = list.find((c) => c && !c.tier) ?? list[0]
  if (!cost) return undefined
  return { input: cost.input ?? 0, output: cost.output ?? 0, cache: { read: cost.cache?.read ?? 0, write: cost.cache?.write ?? 0 } }
}

/**
 * `/api/provider` + `/api/model` -> legacy `/config/providers` (spec C.6).
 * Both v2 lists carry credentials in clear (`api.settings.apiKey`,
 * `request.headers/body`, variant headers): only whitelisted fields are copied.
 * `default` stays empty: v2 exposes no default model (the handler fills it).
 */
export function toLegacyProviders(providers: any[], models: any[]): { providers: any[]; default: Record<string, string> } {
  const list = asArray(providers).filter((p) => p?.id && !p.disabled)
  return {
    providers: list.map((p) => ({
      id: String(p.id),
      name: String(p.name ?? p.id),
      source: 'v2',
      env: [],
      models: Object.fromEntries(asArray(models)
        .filter((m) => m?.providerID === p.id && m.enabled !== false)
        .map((m) => {
          const input: string[] = asArray(m.capabilities?.input).map(String)
          const has = (kind: string) => input.includes(kind)
          const variants = asArray(m.variants).filter((v) => v?.id)
          const reasoning = variants.length > 0 // heuristic: v2 has no reasoning flag
          return [String(m.id), clean({
            id: String(m.id),
            providerID: String(m.providerID),
            name: String(m.name ?? m.id),
            family: m.family,
            status: m.status,
            release_date: typeof m.time?.released === 'number'
              ? new Date(m.time.released).toISOString().slice(0, 10)
              : undefined,
            capabilities: {
              toolcall: Boolean(m.capabilities?.tools),
              attachment: input.some((kind) => kind !== 'text'),
              reasoning,
              input: { text: true, image: has('image'), pdf: has('pdf'), audio: has('audio'), video: has('video') },
              output: asArray(m.capabilities?.output).map(String)
            },
            attachment: input.some((kind) => kind !== 'text'),
            reasoning,
            cost: legacyCost(m.cost),
            limit: isObject(m.limit) ? { ...m.limit } : undefined,
            variants: Object.fromEntries(variants.map((v) => [String(v.id), safeOptions(v.body)]))
          })]
        }))
    })),
    default: {}
  }
}

/** v2 `Agent.Info` -> legacy agent (spec C.7). */
export function toLegacyAgents(agents: any[]): any[] {
  return asArray(agents).filter((a) => a?.id).map((a) => clean({
    name: String(a.id),
    description: a.description,
    mode: a.mode,
    hidden: Boolean(a.hidden),
    color: a.color,
    steps: a.steps,
    model: a.model?.id && a.model?.providerID ? { providerID: a.model.providerID, modelID: a.model.id } : undefined,
    variant: a.model?.variant,
    prompt: a.system,
    permission: asArray(a.permissions).map((r) => ({ permission: r?.action, pattern: r?.resource, action: r?.effect }))
  }))
}

/** `/api/command` (+ `/api/skill` with `slash !== false`) -> legacy command list (spec C.5). */
export function toLegacyCommands(commands: any[], skills: any[] = []): any[] {
  const out: Dict[] = asArray(commands).filter((c) => c?.name).map((c) => clean({
    name: String(c.name),
    description: c.description,
    template: c.template,
    agent: c.agent,
    model: c.model?.id && c.model?.providerID ? `${c.model.providerID}/${c.model.id}` : undefined,
    subtask: c.subtask,
    source: 'command'
  }))
  const seen = new Set(out.map((c) => c.name))
  for (const skill of asArray(skills)) {
    if (!skill?.name || skill.slash === false || seen.has(skill.name)) continue
    seen.add(skill.name)
    out.push(clean({ name: String(skill.name), description: skill.description, template: skill.content, source: 'skill' }))
  }
  return out
}

/**
 * `/api/fs/list` entries -> legacy `/file` entries. v2 returns paths relative
 * to the location with native separators, directories with a trailing one
 * (`".git\\"`, `"src\\index.ts"`).
 */
export function toLegacyFiles(entries: any[], directory: string): any[] {
  const sep = directory.includes('\\') ? '\\' : '/'
  const root = directory.length > 1 ? directory.replace(/[\\/]+$/, '') : directory
  return asArray(entries).filter((e) => typeof e?.path === 'string').map((e) => {
    const trimmed = String(e.path).replace(/[\\/]+$/, '')
    const posix = trimmed.replace(/\\/g, '/')
    return {
      name: posix.split('/').pop() || posix,
      path: posix,
      absolute: root.endsWith(sep) ? root + trimmed.split(/[\\/]/).join(sep) : [root, ...trimmed.split(/[\\/]/)].join(sep),
      type: e.type,
      ignored: false
    }
  })
}

/**
 * Slash-command template expansion as legacy opencode does it: `$1..$n`
 * positional (the highest placeholder swallows the rest), `$ARGUMENTS` the
 * whole string; arguments are appended when the template has no placeholder.
 * Not supported here: `` !`shell` `` interpolation and `@file` expansion.
 */
export function expandCommand(template: string, args: string): string {
  const raw = args.match(/(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi) ?? []
  const values = raw.map((arg) => arg.replace(/^["']|["']$/g, ''))
  const placeholders = template.match(/\$(\d+)/g) ?? []
  const last = placeholders.reduce((max, p) => Math.max(max, Number(p.slice(1))), 0)
  const withArgs = template.replace(/\$(\d+)/g, (_, index: string) => {
    const position = Number(index)
    const argIndex = position - 1
    if (argIndex >= values.length) return ''
    if (position === last) return values.slice(argIndex).join(' ')
    return values[argIndex] ?? ''
  })
  const usesArguments = template.includes('$ARGUMENTS')
  let text = withArgs.split('$ARGUMENTS').join(args)
  if (placeholders.length === 0 && !usesArguments && args.trim()) text = `${text}\n\n${args}`
  return text.trim()
}

const TEXT_MIME = /^(text\/|application\/(json|xml|javascript|ecmascript|typescript|x-yaml|yaml|toml|x-toml|x-sh|x-shellscript|sql|graphql|ld\+json|x-ndjson)\b)|\+(json|xml)$/i

/** Decode a `data:` URL holding text; undefined for other URLs or binary types. */
function decodeTextDataUrl(url: string, mime?: string): string | undefined {
  const match = /^data:([^,]*),(.*)$/s.exec(url)
  if (!match) return undefined
  const meta = match[1] ?? ''
  const type = (mime || meta.split(';')[0] || 'text/plain').toLowerCase()
  if (!TEXT_MIME.test(type)) return undefined
  const payload = match[2] ?? ''
  try {
    if (/;base64/i.test(meta)) {
      const binary = atob(payload)
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
      return new TextDecoder().decode(bytes)
    }
    return decodeURIComponent(payload)
  } catch {
    return undefined
  }
}

/** Fenced block that survives content containing backticks. */
function fence(name: string, text: string): string {
  const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length))
  const ticks = '`'.repeat(longest + 1)
  return `${name}:\n${ticks}\n${text.replace(/\n$/, '')}\n${ticks}`
}

/**
 * Legacy prompt body -> v2 `POST /api/session/{id}/prompt` (spec C.3).
 * `model`/`agent`/`variant` are session state in v2 (the handler switches
 * them first); `tools` and `system` have no v2 equivalent. Text attachments
 * are inlined as fenced blocks: the OpenAI-compatible chat path rejects
 * non-image files.
 */
export function promptBody(legacyBody: any): { prompt: any; id?: string; delivery: 'steer'; resume?: boolean } {
  const parts = asArray(legacyBody?.parts)
  const texts = parts.filter((p) => p?.type === 'text' && typeof p.text === 'string' && p.text).map((p) => p.text as string)
  const files: any[] = []
  for (const part of parts.filter((p) => p?.type === 'file' && typeof p.url === 'string')) {
    const inline = decodeTextDataUrl(part.url, part.mime)
    if (inline !== undefined) texts.push(fence(part.filename || 'attachment', inline))
    else files.push(clean({ uri: part.url, name: part.filename }))
  }
  const agents = parts.filter((p) => p?.type === 'agent' && p.name).map((p) => ({ name: String(p.name) }))
  const prompt = clean({
    text: texts.join('\n\n'),
    files: files.length ? files : undefined,
    agents: agents.length ? agents : undefined
  })
  const id = typeof legacyBody?.messageID === 'string' && legacyBody.messageID.startsWith('msg_') ? legacyBody.messageID : undefined
  return clean({ prompt, id, delivery: 'steer' as const, resume: legacyBody?.noReply ? false : undefined })
}
