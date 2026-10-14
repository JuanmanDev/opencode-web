// Operations that let an agent (through the /mcp control server) or the UI
// manage the opencode server itself: reload its config, see which sessions
// are busy across projects, read other chats and their task lists, and
// register this app's MCP server with opencode.

import type { H3Event } from 'h3'
import { loopbackOrigin } from './mcp-client'
import type { McpServerConfig } from './mcp-admin'

type StatusMap = Record<string, { type?: string; attempt?: number; message?: string }>

export interface ProjectRef { id?: string; worktree: string }

export async function listProjectDirs(): Promise<ProjectRef[]> {
  const projects = await opencodeFetch<Array<{ id?: string; worktree?: string }>>('/project', { timeoutMs: 15000 })
    .catch(() => [] as Array<{ id?: string; worktree?: string }>)
  return (Array.isArray(projects) ? projects : [])
    .filter((p) => p.worktree && p.worktree !== '/')
    .map((p) => ({ id: p.id, worktree: p.worktree! }))
}

/**
 * Busy/idle per session of one project. `/session/status` exists on current
 * 1.x servers and is emulated for v2; very old servers lack it, so the last
 * assistant message of recent sessions stands in (unfinished = busy).
 */
export async function sessionStatus(directory?: string): Promise<{ status: StatusMap; exact: boolean }> {
  try {
    const status = await opencodeFetch<StatusMap>('/session/status', { query: { directory }, timeoutMs: 10000 })
    return { status: status && typeof status === 'object' ? status : {}, exact: true }
  } catch {
    const sessions = await opencodeFetch<Array<{ id: string; time?: { updated?: number } }>>('/session', { query: { directory }, timeoutMs: 15000 })
      .catch(() => [] as Array<{ id: string; time?: { updated?: number } }>)
    const recent = [...sessions].sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0)).slice(0, 15)
    const status: StatusMap = {}
    await Promise.all(recent.map(async (s) => {
      const messages = await opencodeFetch<Array<{ info?: { role?: string; time?: { completed?: number }; error?: unknown } }>>(
        `/session/${encodeURIComponent(s.id)}/message`, { query: { directory, limit: '2' }, timeoutMs: 10000 }
      ).catch(() => [])
      const last = [...messages].reverse().find((m) => m.info?.role === 'assistant')
      if (last && !last.info?.time?.completed && !last.info?.error) status[s.id] = { type: 'busy' }
    }))
    return { status, exact: false }
  }
}

/** Busy sessions of one project, or of every known project. */
export async function busySessions(directory?: string) {
  const dirs = directory ? [directory] : (await listProjectDirs()).map((p) => p.worktree).slice(0, 40)
  const out: Array<{ directory: string; sessionID: string; status: string; title?: string }> = []
  await Promise.all(dirs.map(async (dir) => {
    const { status } = await sessionStatus(dir)
    const busy = Object.entries(status).filter(([, s]) => s?.type && s.type !== 'idle')
    if (!busy.length) return
    const sessions = await opencodeFetch<Array<{ id: string; title?: string }>>('/session', { query: { directory: dir }, timeoutMs: 15000 })
      .catch(() => [] as Array<{ id: string; title?: string }>)
    for (const [id, s] of busy) {
      out.push({ directory: dir, sessionID: id, status: String(s.type), title: sessions.find((x) => x.id === id)?.title })
    }
  }))
  return out
}

// ---- reload ----

export interface ReloadState {
  scope: 'project' | 'all'
  directory?: string
  when: 'now' | 'idle'
  requestedAt: number
  state: 'waiting' | 'done' | 'failed' | 'gave-up'
  doneAt?: number
  message?: string
}

let lastReload: ReloadState | undefined
let reloadTimer: ReturnType<typeof setTimeout> | undefined

export function reloadStatus() {
  return lastReload
}

/**
 * The v2 API of 1.x servers has no lifecycle route: fail before anything is
 * scheduled. opencode 2.x reloads with POST /api/location/reload.
 */
export async function assertReloadable() {
  const profile = await getServerProfile() as { protocol: string; dialect?: string }
  if (profile.protocol === 'v2' && profile.dialect !== '2') {
    throw createError({ statusCode: 501, message: 'The v2 API of opencode 1.x cannot reload its config; restart the server process' })
  }
}

async function dispose(scope: 'project' | 'all', directory?: string) {
  await assertReloadable()
  if (scope === 'project') {
    await opencodeFetch('/instance/dispose', { method: 'POST', query: { directory }, timeoutMs: 60_000 })
    return 'project instance reloaded'
  }
  try {
    await opencodeFetch('/global/dispose', { method: 'POST', timeoutMs: 60_000 })
    return 'every opencode instance reloaded'
  } catch {
    // servers before /global/dispose: reload each known project
    const dirs = (await listProjectDirs()).map((p) => p.worktree)
    await Promise.all(dirs.map((dir) =>
      opencodeFetch('/instance/dispose', { method: 'POST', query: { directory: dir }, timeoutMs: 60_000 }).catch(() => {})
    ))
    return `${dirs.length} project instance(s) reloaded`
  }
}

/**
 * Make opencode re-read its config (MCP servers, agents, providers…).
 * `scope: 'project'` reloads one project's instance, `'all'` every instance
 * (the closest thing to restarting `opencode serve` the API offers).
 * Running replies in a reloaded instance are cut off, so the default waits
 * until no session there is busy, which also lets an agent ask for a reload
 * and finish its own reply first. `now` still waits ~1.5 s so the caller's
 * response gets out before the instance goes away.
 */
export function requestReload(opts: { scope: 'project' | 'all'; directory?: string; when?: 'now' | 'idle'; maxWaitMs?: number }): ReloadState {
  if (opts.scope === 'project' && !opts.directory) {
    throw createError({ statusCode: 400, message: 'directory is required to reload one project' })
  }
  clearTimeout(reloadTimer)
  const state: ReloadState = {
    scope: opts.scope,
    directory: opts.directory,
    when: opts.when === 'now' ? 'now' : 'idle',
    requestedAt: Date.now(),
    state: 'waiting'
  }
  lastReload = state
  const deadline = Date.now() + (opts.maxWaitMs ?? 15 * 60_000)

  const attempt = async () => {
    if (lastReload !== state) return // superseded
    try {
      if (state.when === 'idle') {
        const busy = await busySessions(state.scope === 'project' ? state.directory : undefined)
        if (busy.length) {
          if (Date.now() > deadline) {
            state.state = 'gave-up'
            state.message = `still busy after waiting: ${busy.map((b) => b.title || b.sessionID).join(', ')}`
            return
          }
          state.message = `waiting for ${busy.length} busy session(s)`
          reloadTimer = setTimeout(attempt, 3000)
          return
        }
      }
      state.message = await dispose(state.scope, state.directory)
      state.state = 'done'
      state.doneAt = Date.now()
      await forgetMcpTools()
    } catch (error) {
      state.state = 'failed'
      state.message = error instanceof Error ? error.message : String(error)
    }
  }
  reloadTimer = setTimeout(attempt, 1500)
  return state
}

// ---- reading other chats ----

interface Part { type: string; text?: string; tool?: string; state?: { status?: string; title?: string; input?: unknown; error?: string } }
interface Message { info?: { id?: string; role?: string; time?: { created?: number; completed?: number }; modelID?: string; error?: { data?: { message?: string } } }; parts?: Part[] }

/** A compact, readable transcript of the last `limit` messages of a session. */
export async function sessionTranscript(directory: string | undefined, sessionID: string, limit = 20, maxChars = 12000) {
  const messages = await opencodeFetch<Message[]>(`/session/${encodeURIComponent(sessionID)}/message`, {
    query: { directory }, timeoutMs: 20000
  })
  const lines: string[] = []
  for (const m of messages.slice(-Math.max(1, Math.min(limit, 200)))) {
    const role = m.info?.role === 'user' ? 'USER' : 'ASSISTANT'
    const stamp = m.info?.time?.created ? new Date(m.info.time.created).toISOString().slice(0, 16).replace('T', ' ') : ''
    lines.push(`--- ${role}${stamp ? ` (${stamp})` : ''}${m.info?.modelID ? ` [${m.info.modelID}]` : ''}`)
    for (const part of m.parts || []) {
      if (part.type === 'text' && part.text) lines.push(part.text.trim())
      else if (part.type === 'tool') {
        lines.push(`[tool ${part.tool}${part.state?.title ? `: ${part.state.title}` : ''} → ${part.state?.status || '?'}${part.state?.error ? ` (${String(part.state.error).slice(0, 200)})` : ''}]`)
      }
    }
    if (m.info?.error?.data?.message) lines.push(`[error: ${m.info.error.data.message}]`)
    if (m.info?.role === 'assistant' && !m.info.time?.completed && !m.info.error) lines.push('[still generating…]')
  }
  const text = lines.join('\n')
  return text.length > maxChars ? `…${text.slice(-maxChars)}` : text
}

// ---- tasks (agent todo lists) ----

interface Todo { id?: string; content?: string; status?: string; priority?: string }

/**
 * Todo lists the agent keeps per session. With a session id: that list;
 * otherwise the open items of the busiest/most recent sessions of a project.
 */
export async function listTasks(directory: string | undefined, sessionID?: string, includeDone = false) {
  const fetchTodos = (id: string) => opencodeFetch<Todo[]>(`/session/${encodeURIComponent(id)}/todo`, {
    query: { directory }, timeoutMs: 10000
  }).catch(() => [] as Todo[])
  const keep = (t: Todo) => includeDone || (t.status !== 'completed' && t.status !== 'cancelled')

  if (sessionID) return [{ sessionID, todos: (await fetchTodos(sessionID)).filter(keep) }]

  const [sessions, { status }] = await Promise.all([
    opencodeFetch<Array<{ id: string; title?: string; time?: { updated?: number } }>>('/session', { query: { directory }, timeoutMs: 15000 })
      .catch(() => [] as Array<{ id: string; title?: string; time?: { updated?: number } }>),
    sessionStatus(directory)
  ])
  const recent = [...sessions]
    .sort((a, b) => Number(Boolean(status[b.id]?.type && status[b.id]!.type !== 'idle')) - Number(Boolean(status[a.id]?.type && status[a.id]!.type !== 'idle'))
      || (b.time?.updated || 0) - (a.time?.updated || 0))
    .slice(0, 12)
  const lists = await Promise.all(recent.map(async (s) => ({
    sessionID: s.id,
    title: s.title,
    busy: Boolean(status[s.id]?.type && status[s.id]!.type !== 'idle'),
    todos: (await fetchTodos(s.id)).filter(keep)
  })))
  return lists.filter((l) => l.todos.length)
}

// ---- the control MCP server, registered with opencode ----

export const CONTROL_MCP_NAME = 'opencode-web'

/** Tools that change state or interrupt work: registered as "ask". */
export const CONTROL_ASK_TOOLS = [
  'reload_opencode', 'add_mcp', 'test_mcp', 'set_mcp_mode', 'set_tool_mode', 'disconnect_mcp',
  'send_prompt', 'abort_session', 'delete_schedule', 'create_schedule', 'update_schedule', 'run_schedule'
]

/** Base URL at which opencode can reach this app. */
export function selfBaseUrl(event?: H3Event) {
  const config = useRuntimeConfig()
  const explicit = String(config.selfUrl || '').trim()
  if (explicit) return explicit.replace(/\/+$/, '')
  const demo = String(config.public.demoMcpUrl || '').trim()
  if (demo) {
    try { return new URL(demo).origin } catch { /* not a URL */ }
  }
  if (!event) return undefined
  return loopbackOrigin(event.node.req.socket) ?? getRequestURL(event).origin
}

export async function controlMcpConfig(url: string): Promise<McpServerConfig> {
  const token = String(useRuntimeConfig().apiToken || '')
  // opencode 2.x hides MCP tools behind its `execute` code tool by default:
  // direct tools keep one permission prompt per state-changing call
  const profile = await getServerProfile() as { dialect?: string }
  return {
    type: 'remote',
    url,
    enabled: true,
    oauth: false,
    ...(profile.dialect === '2' ? { codemode: false } : {}),
    ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {})
  }
}

export async function controlMcpState(event?: H3Event) {
  const base = selfBaseUrl(event)
  const global = await rawMcpConfig('global').catch(() => ({} as Record<string, McpServerConfig>))
  const entry = global[CONTROL_MCP_NAME]
  return {
    name: CONTROL_MCP_NAME,
    installed: Boolean(entry),
    enabled: entry ? entry.enabled !== false : false,
    url: entry?.url || null,
    suggestedUrl: base ? `${base}/mcp` : null,
    tokenProtected: Boolean(useRuntimeConfig().apiToken)
  }
}
