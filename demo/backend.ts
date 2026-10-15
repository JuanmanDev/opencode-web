// In-browser stand-in for the web app's server: answers every request the UI
// makes to /api/opencode/* (opencode 1.x API) and /api/v1/*, and serves the
// live event stream, by patching window.fetch and window.EventSource. Used
// only by the static demo build (DEMO=1), never by the real app.

import { cronError, describeCron, nextCronRun } from '../shared/utils/cron'
import { mcpErrorHint } from '../shared/utils/mcp-hints'
import { runTurn, type BotHost } from './bot'
import { loadState, persist, resetState, type DemoMessage, type DemoSession, type Json } from './state'
import { UI_DEMO_TOOLS, renderWidget } from './widgets'

const VERSION = '1.19.0 (demo)'
const REDACTED = '***'

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

const state = loadState()
const save = () => persist(state)

let counter = state.counter
function id(prefix: string) {
  counter += 1
  state.counter = counter
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36).padStart(4, '0')}`
}

// ---- events ----

interface Subscriber { directory?: string; send(data: string): void }
const subscribers = new Set<Subscriber>()

function emit(directory: string, type: string, properties: Json) {
  const data = JSON.stringify({ type, properties })
  for (const sub of subscribers) {
    if (!sub.directory || sub.directory === directory) sub.send(data)
  }
}

// ---- helpers ----

const busy = new Map<string, true>()
const runs = new Map<string, { controller: AbortController; done: Promise<unknown> }>()
const permissions = new Map<string, { request: Json; directory: string; resolve(r: 'once' | 'always' | 'reject'): void }>()
const alwaysAllowed = new Set<string>()
const questions = new Map<string, { request: Json; directory: string; resolve(a: string[][] | null): void }>()
let lastReload: Json = null

function sessionOf(sid: string) {
  return state.sessions.find((s) => s.id === sid)
}

function requireSession(sid: string) {
  const s = sessionOf(sid)
  if (!s) throw new HttpError(404, `Session not found: ${sid}`)
  return s
}

function messagesOf(sid: string) {
  return (state.messages[sid] ||= [])
}

function filesOf(directory: string) {
  return (state.files[directory] ||= { 'README.md': `# ${directory.split('/').pop()}\n\nA new project folder in the demo.\n` })
}

function ensureProjectDir(directory: string) {
  filesOf(directory)
}

function deepMerge(target: Json, patch: Json): Json {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch
  const out = target && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {}
  for (const [k, v] of Object.entries(patch)) out[k] = deepMerge(out[k], v)
  return out
}

function mergedConfig(directory?: string) {
  return deepMerge(structuredClone(state.globalConfig), directory ? state.projectConfig[directory] || {} : {})
}

function redact<T>(value: T): T {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(redact) as T
  const out: Json = {}
  for (const [k, v] of Object.entries(value as Json)) {
    out[k] = /^(authorization|apikey|api_key|token|key|secret|password)$/i.test(k) && typeof v === 'string' && v ? REDACTED : redact(v)
  }
  return out
}

function touch(sid: string, title?: string) {
  const s = sessionOf(sid)
  if (!s) return
  s.time.updated = Date.now()
  if (title) s.title = title
  emit(s.directory, 'session.updated', { info: structuredClone(s) })
  save()
}

function setStatus(directory: string, sid: string, isBusy: boolean) {
  if (isBusy) busy.set(sid, true)
  else busy.delete(sid)
  emit(directory, 'session.status', { sessionID: sid, status: { type: isBusy ? 'busy' : 'idle' } })
  if (!isBusy) emit(directory, 'session.idle', { sessionID: sid })
}

function createSession(directory: string, title = '', parentID?: string, agent?: string): DemoSession {
  ensureProjectDir(directory)
  const now = Date.now()
  const s: DemoSession = {
    id: id('ses'),
    title: title || `New session - ${new Date(now).toISOString()}`,
    directory,
    version: 'demo',
    time: { created: now, updated: now },
    ...(parentID ? { parentID } : {}),
    ...(agent ? { agent } : {})
  }
  state.sessions.unshift(s)
  state.messages[s.id] = []
  if (!state.projects.some((p) => p.worktree === directory) && !parentID) {
    state.directories.recents = [{ directory, lastOpened: now }, ...state.directories.recents.filter((r) => r.directory !== directory)]
  }
  emit(directory, 'session.created', { info: structuredClone(s) })
  emit(directory, 'session.updated', { info: structuredClone(s) })
  save()
  return s
}

const host: BotHost = {
  id,
  now: () => Date.now(),
  files: filesOf,
  emit,
  messages: messagesOf,
  session: sessionOf,
  createChild: (parent, title, agent) => createSession(parent.directory, title, parent.id, agent),
  touch,
  setStatus,
  setTodos(directory, sid, todos) {
    state.todos[sid] = todos
    emit(directory, 'todo.updated', { sessionID: sid, todos })
    save()
  },
  addDiff(sid, file, before, after) {
    const removed = before.split('\n').filter((l) => !after.includes(l))
    const added = after.split('\n').filter((l) => !before.includes(l))
    const patch = `--- a/${file}\n+++ b/${file}\n@@\n${removed.map((l) => `-${l}`).join('\n')}\n${added.map((l) => `+${l}`).join('\n')}`
    const list = (state.diffs[sid] ||= []).filter((d) => d.file !== file)
    list.push({ file, patch, additions: added.length, deletions: removed.length })
    state.diffs[sid] = list
  },
  askPermission(directory, request) {
    if (alwaysAllowed.has(request.sessionID)) return Promise.resolve('always')
    return new Promise((resolve) => {
      permissions.set(request.id, { request, directory, resolve })
      emit(directory, 'permission.asked', request)
    })
  },
  askQuestion(directory, request) {
    return new Promise((resolve) => {
      questions.set(request.id, { request, directory, resolve })
      emit(directory, 'question.asked', request)
    })
  },
  save
}

async function prompt(sid: string, body: Json, wait: boolean) {
  const s = requireSession(sid)
  const text = (body?.parts || []).filter((p: Json) => p.type === 'text').map((p: Json) => p.text).join('\n').trim() || '(attachment)'
  // one run per session at a time, like opencode's own queue
  await runs.get(sid)?.done.catch(() => {})
  const userID = id('msg')
  const user: DemoMessage = {
    info: { id: userID, sessionID: sid, role: 'user', time: { created: Date.now() }, agent: body?.agent, model: body?.model },
    parts: (body?.parts || []).map((p: Json) => ({ ...p, id: id('prt'), messageID: userID, sessionID: sid }))
  }
  messagesOf(sid).push(user)
  emit(s.directory, 'message.updated', { info: user.info })
  for (const part of user.parts) emit(s.directory, 'message.part.updated', { part })
  if (s.title.startsWith('New session')) touch(sid, text.split('\n')[0]!.slice(0, 60))
  else touch(sid)
  const controller = new AbortController()
  const done = runTurn(host, { sessionID: sid, text, agent: body?.agent, model: body?.model, variant: body?.variant, signal: controller.signal }, userID)
    .finally(() => runs.delete(sid))
  runs.set(sid, { controller, done })
  if (wait) return done
  done.catch(() => {})
  return true
}

// ---- MCP catalog ----

const TOOL_CATALOG: Record<string, Array<{ name: string; description?: string; ui?: boolean; readOnly?: boolean }>> = {
  context7: [
    { name: 'query-docs', description: 'Query up-to-date documentation for a library' },
    { name: 'resolve-library-id', description: 'Find the Context7 id of a library' }
  ],
  'ui-demo': UI_DEMO_TOOLS,
  playwright: [
    { name: 'browser_navigate', description: 'Navigate to a URL' },
    { name: 'browser_click', description: 'Click an element' },
    { name: 'browser_snapshot', description: 'Accessibility snapshot of the page' },
    { name: 'browser_take_screenshot', description: 'Take a screenshot' }
  ],
  'home-assistant': [
    { name: 'HassTurnOn', description: 'Turns on a device or entity' },
    { name: 'HassTurnOff', description: 'Turns off a device or entity' },
    { name: 'GetLiveContext', description: 'Current state of the home' }
  ],
  'opencode-web': ['server_info', 'list_sessions', 'read_session', 'send_prompt', 'list_mcp', 'test_mcp', 'reload_opencode', 'list_schedules', 'create_schedule']
    .map((name) => ({ name, description: `opencode web control: ${name.replace(/_/g, ' ')}` }))
}

function mcpEntries(directory?: string): Record<string, Json> {
  return mergedConfig(directory).mcp || {}
}

function mcpState(name: string, entry: Json): { status: string; error?: string } {
  if (entry?.enabled === false) return { status: 'disabled' }
  if (name === 'home-assistant' || /homeassistant\.local/.test(entry?.url || '')) {
    const auth = entry?.headers?.Authorization || ''
    if (!auth || auth === REDACTED || /^Bearer\s*$/.test(auth) || /homeassistant\.local/.test(entry?.url || '')) {
      return { status: 'failed', error: 'SSE error: Non-200 status code (401)' }
    }
  }
  return { status: 'connected' }
}

function toolsOf(name: string) {
  return TOOL_CATALOG[name] || [{ name: 'example', description: `A tool of ${name} (demo)` }]
}

function inspect(name: string, entry: Json) {
  const st = mcpState(name, entry)
  const started = Date.now()
  if (st.status === 'failed') {
    const error = 'HTTP 401'
    return {
      ok: false, transport: 'http', capabilities: [], tools: [], resources: [], prompts: [],
      steps: [{ label: `Connect to ${entry.url || entry.command?.join(' ')}`, ok: false, detail: error, ms: 41 }],
      error, hint: mcpErrorHint(error), durationMs: 41
    }
  }
  const tools = toolsOf(name).map((t) => ({ ...t, fullDescription: t.description, params: t.ui ? [{ name: 'label', type: 'string', required: false, description: 'what to show' }] : [] }))
  return {
    ok: true,
    transport: entry.type === 'local' ? 'stdio' : 'http',
    server: { name, version: '1.0.0', protocolVersion: '2025-06-18' },
    capabilities: ['tools'],
    tools, resources: [], prompts: [],
    steps: [
      { label: entry.type === 'local' ? `Start \`${(entry.command || []).join(' ')}\`` : `Connect to ${entry.url}`, ok: true, detail: entry.type === 'local' ? 'started (simulated)' : 'Streamable HTTP transport', ms: 120 },
      { label: 'Initialize', ok: true, detail: `${name} 1.0.0 · protocol 2025-06-18` },
      { label: 'List tools', ok: true, detail: `${tools.length} tools`, ms: 35 }
    ],
    durationMs: Date.now() - started + 160
  }
}

function restoreSecrets(edited: Json, stored: Json) {
  const out = { ...edited }
  for (const field of ['headers', 'environment']) {
    if (!edited?.[field]) continue
    const map: Json = {}
    for (const [k, v] of Object.entries(edited[field] as Json)) {
      if (v === REDACTED) { if (stored?.[field]?.[k]) map[k] = stored[field][k] }
      else map[k] = v
    }
    out[field] = map
  }
  return out
}

// ---- subagent per MCP ----

function nestPlan() {
  const settings = state.nest
  const servers = Object.entries(state.globalConfig.mcp || {}).sort(([a], [b]) => a.localeCompare(b)).map(([server, entry]: [string, Json]) => {
    const tools = toolsOf(server)
    const generated = `Specialist for the ${server} MCP server: send it any task that needs ${server}. Tools: ${tools.slice(0, 6).map((t) => t.description ? `${t.name} (${t.description})` : t.name).join('; ')}.`
    const skipped = server === 'opencode-web' ? "this app's own control server stays with the main agents"
      : settings.exclude.includes(server) ? 'left out' : entry.enabled === false ? 'disabled' : undefined
    return {
      server, agent: `mcp-${server.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase()}`,
      summary: settings.summaries[server] || generated, generated, custom: Boolean(settings.summaries[server]),
      tools, status: mcpState(server, entry).status, included: !skipped, ...(skipped ? { skipped } : {})
    }
  })
  const nested = servers.filter((s) => s.included)
  const orchestratorPrompt = [
    'You are the orchestrator. You do not call MCP tools yourself: every MCP server has its own specialist subagent, and you delegate to it.',
    '', 'Specialists and what to send them:',
    ...nested.map((s) => `- @${s.agent} (the ${s.server} MCP server): ${s.summary}`),
    ...(settings.instructions ? ['', settings.instructions] : [])
  ].join('\n')
  const agents: Json = {}
  for (const s of nested) agents[s.agent] = { mode: 'subagent', description: s.summary, tools: { '*': false, [`${s.server}_*`]: true } }
  agents[settings.orchestrator] = { mode: 'primary', description: `Delegates MCP work to one subagent per server (${nested.length})`, prompt: orchestratorPrompt, tools: Object.fromEntries(nested.map((s) => [`${s.server}_*`, false])) }
  return { settings, servers, orchestratorPrompt, agents, hash: String(Object.keys(agents).length), codemodeOff: [] }
}

// ---- schedules ----

function presentSchedule(s: Json) {
  return { ...s, description: describeCron(s.cron), running: busy.has(s.sessionID || '') }
}

async function runSchedule(s: Json, trigger: 'schedule' | 'manual') {
  const run: Json = { id: id('run').slice(4, 12), at: Date.now(), trigger, status: 'running' }
  let session = s.session === 'reuse' && s.sessionID ? sessionOf(s.sessionID) : undefined
  if (!session) session = createSession(s.directory, `⏰ ${s.name}`)
  if (s.session === 'reuse') s.sessionID = session.id
  run.sessionID = session.id
  s.runs = [run, ...(s.runs || [])].slice(0, 20)
  save()
  const started = Date.now()
  prompt(session.id, { parts: [{ type: 'text', text: s.prompt }], agent: s.agent }, true)
    .then((msg: Json) => {
      run.status = msg?.info?.error ? 'error' : 'ok'
      run.reply = (msg?.parts || []).filter((p: Json) => p.type === 'text').map((p: Json) => p.text).join('\n').slice(0, 600)
    })
    .catch((e) => { run.status = 'error'; run.error = String(e?.message || e) })
    .finally(() => { run.durationMs = Date.now() - started; save() })
  return run
}

setInterval(() => {
  const now = Date.now()
  for (const s of state.schedules) {
    if (!s.enabled || !s.nextRunAt || s.nextRunAt > now) continue
    s.nextRunAt = nextCronRun(s.cron, now)?.getTime()
    runSchedule(s, 'schedule')
  }
}, 20_000)

// ---- routes ----

type Handler = (ctx: { params: Record<string, string>; query: URLSearchParams; body: Json; method: string }) => unknown | Promise<unknown>
const routes: Array<[string, RegExp, string[], Handler]> = []
function route(method: string, pattern: string, handler: Handler) {
  const keys: string[] = []
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)' })}/?$`)
  routes.push([method, re, keys, handler])
}

const dirOf = (q: URLSearchParams) => q.get('directory') || undefined

const AGENTS = [
  { name: 'build', description: 'The default agent: full tool access', mode: 'primary', builtIn: true },
  { name: 'plan', description: 'Read-only planning: no edits', mode: 'primary', builtIn: true },
  { name: 'general', description: 'General-purpose subagent for research and multi-step tasks', mode: 'subagent', builtIn: true },
  { name: 'explore', description: 'Fast read-only codebase exploration', mode: 'subagent', builtIn: true }
]

// like opencode: config entries override the built-ins field by field, disabled ones are left out
function agentList(directory?: string) {
  const config: Record<string, Json> = mergedConfig(directory).agent || {}
  const names = [...new Set([...AGENTS.map((a) => a.name), ...Object.keys(config)])]
  return names.filter((name) => !config[name]?.disable).map((name) => {
    const a: Json = config[name] || {}
    const [providerID, ...modelID] = typeof a.model === 'string' ? a.model.split('/') : []
    return {
      ...(AGENTS.find((b) => b.name === name) || { name, mode: 'all' }),
      ...(a.description ? { description: a.description } : {}),
      ...(a.mode ? { mode: a.mode } : {}),
      ...(modelID.length ? { model: { providerID, modelID: modelID.join('/') } } : {}),
      ...(typeof a.prompt === 'string' ? { prompt: a.prompt } : {}),
      ...(typeof a.temperature === 'number' ? { temperature: a.temperature } : {}),
      ...(a.tools ? { tools: a.tools } : {})
    }
  })
}

/** Stand-in for /api/v1/ai-text: canned agent descriptions and prompts. */
function demoAiText(body: Json) {
  const name = /Name: (\S+)/.exec(String(body?.prompt || ''))?.[1] || 'this agent'
  if (/system prompt/i.test(String(body?.system || ''))) {
    return `You are @${name}, a focused assistant in this project.

- Read the relevant files before changing anything.
- Keep changes small and explain them briefly.
- When the task is done, report what you did and anything left open.

(Written by the demo's scripted AI.)`
  }
  if (/description/i.test(String(body?.system || ''))) return `Use @${name} for focused tasks in this project (written by the demo's scripted AI).`
  return "A short text written by the demo's scripted AI."
}

const PROVIDERS = {
  default: { demo: 'demo-model' },
  providers: [{
    id: 'demo',
    name: 'Demo (in-browser)',
    models: {
      'demo-model': { id: 'demo-model', name: 'Demo model (in-browser)', reasoning: true, cost: { input: 0, output: 0 }, limit: { context: 128000, output: 8192 }, variants: { low: {}, high: {} } },
      'demo-fast': { id: 'demo-fast', name: 'Demo fast (no thinking)', reasoning: false, cost: { input: 0, output: 0 }, limit: { context: 32000, output: 4096 } }
    }
  }]
}

// opencode 1.x API (/api/opencode/*)
route('GET', 'global/health', () => ({ healthy: true, version: VERSION }))
route('GET', 'project', () => state.projects)
route('GET', 'path', ({ query }) => ({ home: '/home/demo', directory: dirOf(query) || '/projects', worktree: dirOf(query) || '/projects', config: '/home/demo/.config/opencode' }))
route('GET', 'file', ({ query }) => {
  const dir = dirOf(query) || '/'
  if (dir === '/') return [{ name: 'projects', path: 'projects', absolute: '/projects', type: 'directory', ignored: false }]
  if (dir === '/projects') {
    return [...new Set([...state.projects.map((p) => p.worktree), ...Object.keys(state.files)])]
      .filter((d) => d.startsWith('/projects/'))
      .map((d) => ({ name: d.split('/').pop(), path: d.split('/').pop(), absolute: d, type: 'directory', ignored: false }))
  }
  const files = state.files[dir] || {}
  const top = new Map<string, boolean>()
  for (const f of Object.keys(files)) {
    const [head, ...rest] = f.split('/')
    top.set(head!, rest.length > 0 || top.get(head!) === true)
  }
  return [...top].map(([name, isDir]) => ({ name, path: name, absolute: `${dir}/${name}`, type: isDir ? 'directory' : 'file', ignored: false }))
})
route('GET', 'find/file', ({ query }) => {
  const files = Object.keys(state.files[dirOf(query) || ''] || {})
  const q = (query.get('query') || '').toLowerCase()
  return files.filter((f) => f.toLowerCase().includes(q)).slice(0, 50)
})
route('GET', 'config', ({ query }) => redact(mergedConfig(dirOf(query))))
route('GET', 'global/config', () => redact(structuredClone(state.globalConfig)))
route('PATCH', 'config', ({ query, body }) => {
  const dir = dirOf(query)
  if (dir) state.projectConfig[dir] = deepMerge(state.projectConfig[dir] || {}, body)
  else state.globalConfig = deepMerge(state.globalConfig, body)
  save()
  return body
})
route('PATCH', 'global/config', ({ body }) => { state.globalConfig = deepMerge(state.globalConfig, body); save(); return body })
route('GET', 'config/providers', () => PROVIDERS)
route('GET', 'provider', () => ({ all: PROVIDERS.providers, default: PROVIDERS.default, connected: ['demo'] }))
route('PUT', 'auth/:id', () => true)
route('GET', 'agent', ({ query }) => agentList(dirOf(query)))
route('GET', 'command', () => [
  { name: 'review', description: 'Review the current changes', template: 'Review the current changes and point out bugs.', source: 'command' },
  { name: 'test', description: 'Run the tests and fix failures', template: 'Run the tests and fix what fails.', source: 'command' }
])
route('GET', 'skill', () => [{ name: 'release-notes', description: 'Write release notes from git history', location: '/home/demo/.config/opencode/skills/release-notes/SKILL.md', content: '' }])
route('GET', 'mcp', ({ query }) => Object.fromEntries(Object.entries(mcpEntries(dirOf(query))).map(([n, e]) => [n, mcpState(n, e)])))
route('POST', 'mcp', ({ body }) => {
  state.globalConfig.mcp = { ...(state.globalConfig.mcp || {}), [body.name]: { ...(state.globalConfig.mcp?.[body.name] || {}), ...body.config } }
  save()
  return true
})
route('POST', 'mcp/:name/connect', () => true)
route('POST', 'mcp/:name/disconnect', () => true)
route('POST', 'mcp/:name/auth', () => { throw new HttpError(400, 'This demo server has no OAuth flow') })
route('GET', 'session', ({ query }) => {
  const dir = dirOf(query)
  return state.sessions.filter((s) => !dir || s.directory === dir)
})
route('POST', 'session', ({ query, body }) => createSession(dirOf(query) || '/projects/space-invaders', body?.title))
route('GET', 'session/status', ({ query }) => {
  const dir = dirOf(query)
  return Object.fromEntries([...busy.keys()].filter((sid) => !dir || sessionOf(sid)?.directory === dir).map((sid) => [sid, { type: 'busy' }]))
})
route('GET', 'experimental/session', () => state.sessions.filter((s) => !s.parentID))
route('GET', 'session/:id', ({ params }) => requireSession(params.id!))
route('PATCH', 'session/:id', ({ params, body }) => { touch(params.id!, body?.title); return requireSession(params.id!) })
route('DELETE', 'session/:id', ({ params }) => {
  const s = requireSession(params.id!)
  state.sessions = state.sessions.filter((x) => x.id !== s.id && x.parentID !== s.id)
  delete state.messages[s.id]
  emit(s.directory, 'session.deleted', { info: s })
  save()
  return true
})
route('GET', 'session/:id/children', ({ params }) => state.sessions.filter((s) => s.parentID === params.id))
route('GET', 'session/:id/message', ({ params }) => { requireSession(params.id!); return messagesOf(params.id!) })
route('POST', 'session/:id/message', ({ params, body }) => prompt(params.id!, body, true))
route('POST', 'session/:id/prompt_async', ({ params, body }) => prompt(params.id!, body, false))
route('POST', 'session/:id/command', ({ params, body }) => prompt(params.id!, { ...body, parts: [{ type: 'text', text: `/${body?.command} ${body?.arguments || ''}`.trim() }] }, true))
route('POST', 'session/:id/shell', ({ params, body }) => prompt(params.id!, { ...body, parts: [{ type: 'text', text: `run \`${body?.command}\`` }] }, true))
route('POST', 'session/:id/abort', ({ params }) => { runs.get(params.id!)?.controller.abort(); return true })
route('GET', 'session/:id/todo', ({ params }) => state.todos[params.id!] || [])
route('GET', 'session/:id/diff', ({ params }) => state.diffs[params.id!] || [])
route('POST', 'session/:id/fork', ({ params }) => {
  const s = requireSession(params.id!)
  const copy = createSession(s.directory, `${s.title} (fork)`)
  state.messages[copy.id] = structuredClone(messagesOf(s.id)).map((m) => ({ ...m, info: { ...m.info, sessionID: copy.id }, parts: m.parts.map((p) => ({ ...p, sessionID: copy.id })) }))
  save()
  return copy
})
route('POST', 'session/:id/share', () => ({ share: { url: 'https://opencode.ai/s/demo' } }))
route('POST', 'session/:id/summarize', ({ params }) => prompt(params.id!, { parts: [{ type: 'text', text: 'make a plan' }] }, true))
route('POST', 'session/:id/revert', () => true)
route('POST', 'session/:id/unrevert', () => true)
route('POST', 'session/:id/init', () => true)
route('POST', 'session/:sid/permissions/:pid', ({ params, body }) => {
  const pending = permissions.get(params.pid!)
  if (!pending) throw new HttpError(404, 'Permission request not found')
  permissions.delete(params.pid!)
  if (body?.response === 'always') alwaysAllowed.add(params.sid!)
  emit(pending.directory, 'permission.replied', { sessionID: params.sid, permissionID: params.pid, response: body?.response })
  pending.resolve(body?.response || 'once')
  return true
})
route('GET', 'permission', () => [...permissions.values()].map((p) => p.request))
route('GET', 'question', () => [...questions.values()].map((q) => q.request))
route('POST', 'question/:id/reply', ({ params, body }) => {
  const q = questions.get(params.id!)
  if (!q) throw new HttpError(404, 'Question not found')
  questions.delete(params.id!)
  emit(q.directory, 'question.replied', { sessionID: q.request.sessionID, requestID: params.id })
  q.resolve(body?.answers || [])
  return true
})
route('POST', 'question/:id/reject', ({ params }) => {
  const q = questions.get(params.id!)
  if (!q) throw new HttpError(404, 'Question not found')
  questions.delete(params.id!)
  emit(q.directory, 'question.rejected', { sessionID: q.request.sessionID, requestID: params.id })
  q.resolve(null)
  return true
})
route('POST', 'instance/dispose', () => true)
route('POST', 'global/dispose', () => true)
route('GET', 'vcs', () => ({ branch: 'main' }))
route('GET', 'lsp', () => [])
route('GET', 'formatter', () => [])

// web app API (/api/v1/*)
// ---- skills (a library kept in memory for the session) ----
const demoLibrary: Record<string, { content: string; version: number }> = {}
const RELEASE_NOTES = `---
name: release-notes
description: Use when the user asks for release notes or a changelog entry: summarizes the git log since the last tag, grouped by feat/fix.
---

# Release notes

1. Find the last tag with \`git describe --tags --abbrev=0\`.
2. List commits since then: \`git log <tag>..HEAD --oneline\`.
3. Group them by type (feat, fix, docs) and write one line per change for users, not developers.
`
function demoSkillChecks(content: string) {
  const checks: Array<{ level: string; message: string }> = []
  if (!/^---\n[\s\S]*?description:/.test(content)) checks.push({ level: 'error', message: 'description is missing: opencode never shows the skill to the model without one.' })
  if (content.split(/\s+/).length < 40) checks.push({ level: 'warning', message: 'The body is almost empty: add the instructions, steps and examples the model should follow.' })
  return checks
}
function demoSkills() {
  const desc = (c: string) => /description:\s*(.*)/.exec(c)?.[1] || ''
  const list = [
    { name: 'release-notes', description: desc(RELEASE_NOTES), location: '/home/demo/.config/opencode/skills/release-notes/SKILL.md', source: 'global', content: RELEASE_NOTES, permission: 'allow', checks: demoSkillChecks(RELEASE_NOTES) }
  ]
  for (const [name, own] of Object.entries(demoLibrary)) {
    const entry = { name, description: desc(own.content), source: 'library', content: own.content, permission: 'allow', library: { version: own.version, updatedAt: Date.now(), loaded: true }, checks: demoSkillChecks(own.content) }
    const at = list.findIndex((x) => x.name === name)
    if (at >= 0) list.splice(at, 1, entry as never)
    else list.push(entry as never)
  }
  return list
}
const demoCatalog = () => ({ rev: Object.keys(demoLibrary).length, count: Object.keys(demoLibrary).length, url: 'http://web:3000/skills/r1/', registered: Object.keys(demoLibrary).length ? 'http://web:3000/skills/r1/' : null, upToDate: true, supported: true })

const v1: Array<[string, string, Handler]> = [
  ['GET', 'skills', () => ({ skills: demoSkills(), available: true, permissions: null, catalog: demoCatalog() })],
  ['PUT', 'skills/library', ({ body }) => {
    const name = String(body?.name || '')
    demoLibrary[name] = { content: String(body?.content || ''), version: (demoLibrary[name]?.version || 0) + 1 }
    return { skill: { name, version: demoLibrary[name].version }, catalog: demoCatalog() }
  }],
  ['DELETE', 'skills/library', ({ query }) => { delete demoLibrary[query.get('name') || '']; return { deleted: query.get('name'), catalog: demoCatalog() } }],
  ['POST', 'skills/catalog', () => demoCatalog()],
  ['POST', 'skills/check', ({ body }) => ({ checks: demoSkillChecks(String(body?.content || '')) })],
  ['POST', 'skills/ai', ({ body }) => new Promise((resolve) => setTimeout(() => {
    const name = String(body?.name || 'new-skill')
    const content = body?.mode === 'create'
      ? `---\nname: ${name}\ndescription: Use when ${String(body?.brief || 'the user asks for it').slice(0, 160)}\n---\n\n# ${name}\n\n## Steps\n\n1. Understand the request and the files involved.\n2. Follow the project conventions.\n3. Report what changed.\n`
      : String(body?.content || '').replace(/^# (.*)$/m, '# $1\n\n> Improved by the demo AI: clearer steps, sharper description.')
    resolve({ content, checks: demoSkillChecks(content) })
  }, 900))],
  ['GET', 'capabilities', () => ({
    protocol: 'legacy', version: VERSION, mcp: true, config: true, sessionRename: true, sessionDelete: true, fork: true, share: true,
    diff: true, shell: true, compact: true, revert: true, questions: true, permissions: true, todos: true, cost: true
  })],
  ['GET', 'projects', () => state.projects],
  ['GET', 'sessions', ({ query }) => state.sessions.filter((s) => !dirOf(query) || s.directory === dirOf(query))],
  ['POST', 'sessions', ({ body }) => createSession(body?.directory || '/projects/space-invaders', body?.title)],
  ['DELETE', 'sessions/:id', ({ params }) => { state.sessions = state.sessions.filter((s) => s.id !== params.id); save(); return true }],
  ['GET', 'sessions/:id/messages', ({ params }) => messagesOf(params.id!)],
  ['POST', 'sessions/:id/prompt', async ({ params, body }) => {
    const msg = await prompt(params.id!, { parts: [{ type: 'text', text: body?.text || '' }], agent: body?.agent }, true) as DemoMessage
    return { sessionID: params.id, text: msg.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n\n'), message: msg }
  }],
  ['POST', 'sessions/:id/abort', ({ params }) => { runs.get(params.id!)?.controller.abort(); return true }],
  ['GET', 'models', () => PROVIDERS],
  ['GET', 'agents', ({ query }) => agentList(dirOf(query))],
  ['GET', 'mcp', ({ query }) => Object.fromEntries(Object.entries(mcpEntries(dirOf(query))).map(([n, e]) => [n, mcpState(n, e)]))],
  ['GET', 'mcp-tools', ({ query }) => {
    const entries = query.get('scope') === 'global' ? state.globalConfig.mcp || {} : mcpEntries(dirOf(query))
    return Object.fromEntries(Object.entries(entries).map(([name, entry]: [string, Json]) => {
      if (entry.enabled === false) return [name, { tools: [], disabled: true }]
      const st = mcpState(name, entry)
      return [name, st.status === 'failed'
        ? { tools: [], transport: entry.type, error: 'HTTP 401' }
        : { tools: toolsOf(name), transport: entry.type === 'local' ? 'local' : 'remote' }]
    }))
  }],
  ['GET', 'mcp-server', ({ query }) => {
    const name = query.get('name') || ''
    const inGlobal = name in (state.globalConfig.mcp || {})
    const entry = mcpEntries(dirOf(query))[name]
    const st = entry ? mcpState(name, entry) : null
    return { name, definedIn: entry ? (inGlobal ? 'global' : 'project') : null, config: entry ? redact(entry) : null, status: st, hint: st ? mcpErrorHint(st.error, st.status) || null : null }
  }],
  ['PUT', 'mcp-server', ({ body }) => {
    const scope = body.scope === 'project' && body.directory ? 'project' : 'global'
    const store = scope === 'global' ? (state.globalConfig.mcp ||= {}) : ((state.projectConfig[body.directory] ||= {}).mcp ||= {})
    const config = restoreSecrets(body.config, store[body.name])
    store[body.name] = { ...config, enabled: config.enabled !== false }
    save()
    const st = mcpState(body.name, store[body.name])
    return { name: body.name, scope, config: redact(store[body.name]), status: st, hint: mcpErrorHint(st.error, st.status) }
  }],
  ['POST', 'mcp-test', ({ body, query }) => {
    const stored = mcpEntries(body?.directory || dirOf(query))[body?.name]
    const entry = body?.config ? restoreSecrets(body.config, stored) : stored
    if (!entry) throw new HttpError(404, `No MCP server named ${body?.name}`)
    return new Promise((resolve) => setTimeout(() => resolve(inspect(body?.name || 'custom', entry)), 500))
  }],
  ['POST', 'mcp-call', ({ body }) => {
    const tool = String(body?.toolId || '').replace(/^ui-demo_/, '')
    const widget = renderWidget(tool, body?.arguments || {})
    if (!widget) throw new HttpError(400, `${body?.toolId} renders no UI`)
    return { resources: [{ html: widget.html, title: widget.title }], called: true }
  }],
  ['POST', 'config-patch', ({ body }) => {
    if (body.scope === 'project' && body.directory) state.projectConfig[body.directory] = deepMerge(state.projectConfig[body.directory] || {}, body.patch)
    else state.globalConfig = deepMerge(state.globalConfig, body.patch)
    save()
    return { scope: body.scope === 'project' && body.directory ? 'project' : 'global' }
  }],
  ['POST', 'ai-text', ({ body }) => new Promise((resolve) => setTimeout(() => resolve({ text: demoAiText(body) }), 900))],
  ['GET', 'mcp-presets', ({ query }) => state.presets[query.get('key') || ''] || []],
  ['PUT', 'mcp-presets', ({ query, body }) => { state.presets[query.get('key') || ''] = body; save(); return true }],
  ['GET', 'mcp-nest', () => nestPlan()],
  ['PUT', 'mcp-nest', ({ body }) => {
    state.nest = { ...state.nest, ...body, summaries: { ...(body?.summaries || state.nest.summaries) } }
    const plan = nestPlan()
    const agents: Json = { ...(state.globalConfig.agent || {}) }
    for (const name of state.nest.lastSync?.agents || []) agents[name] = { ...agents[name], disable: true }
    if (state.nest.enabled) for (const [name, a] of Object.entries(plan.agents)) agents[name] = { ...(a as Json), disable: false }
    state.globalConfig.agent = agents
    state.nest.lastSync = { at: Date.now(), hash: plan.hash, agents: state.nest.enabled ? Object.keys(plan.agents) : [] }
    lastReload = { scope: 'all', when: 'idle', requestedAt: Date.now(), state: 'done', message: 'every opencode instance reloaded', doneAt: Date.now() }
    save()
    return { changed: true, ...nestPlan() }
  }],
  ['GET', 'control-mcp', () => ({ name: 'opencode-web', installed: state.control.installed, enabled: state.control.enabled, url: state.control.installed ? 'http://web:3000/mcp' : null, suggestedUrl: 'http://web:3000/mcp', tokenProtected: false })],
  ['POST', 'control-mcp', ({ body }) => {
    state.control = { installed: true, enabled: body?.enabled !== false }
    state.globalConfig.mcp = { ...(state.globalConfig.mcp || {}), 'opencode-web': { type: 'remote', url: body?.url || 'http://web:3000/mcp', enabled: body?.enabled !== false, oauth: false } }
    save()
    return { name: 'opencode-web', scope: 'global', status: { status: body?.enabled === false ? 'disabled' : 'connected' } }
  }],
  ['GET', 'meta', () => state.meta],
  ['PUT', 'meta', ({ body }) => { state.meta = body; save(); return true }],
  ['GET', 'directories', () => {
    const map = new Map<string, Json>()
    for (const s of state.sessions) {
      if (s.parentID || state.directories.hidden.includes(s.directory)) continue
      const d = map.get(s.directory) || { directory: s.directory, lastActivity: 0, sessions: 0, source: 'session' }
      d.lastActivity = Math.max(d.lastActivity, s.time.updated)
      d.sessions += 1
      map.set(s.directory, d)
    }
    for (const r of state.directories.recents) {
      if (state.directories.hidden.includes(r.directory)) continue
      const d = map.get(r.directory) || { directory: r.directory, lastActivity: 0, sessions: 0, source: 'recent' }
      d.lastActivity = Math.max(d.lastActivity, r.lastOpened)
      d.source = 'recent'
      map.set(r.directory, d)
    }
    return [...map.values()].sort((a, b) => b.lastActivity - a.lastActivity)
  }],
  ['PUT', 'directories', ({ body }) => {
    const directory = String(body?.directory || '')
    state.directories.recents = [{ directory, lastOpened: Date.now() }, ...state.directories.recents.filter((r) => r.directory !== directory)].slice(0, 50)
    state.directories.hidden = state.directories.hidden.filter((d) => d !== directory)
    ensureProjectDir(directory)
    save()
    return true
  }],
  ['DELETE', 'directories', ({ query }) => {
    const directory = query.get('directory') || ''
    state.directories.recents = state.directories.recents.filter((r) => r.directory !== directory)
    if (!state.directories.hidden.includes(directory)) state.directories.hidden.push(directory)
    save()
    return true
  }],
  ['GET', 'project-summary', ({ query }) => {
    const dir = dirOf(query)
    const top = state.sessions.filter((s) => s.directory === dir && !s.parentID).sort((a, b) => b.time.updated - a.time.updated)
    const cost = (sid: string) => messagesOf(sid).reduce((n, m) => n + (m.info.cost || 0), 0)
    return {
      generatedAt: Date.now(),
      sessions: { total: top.length, totalCost: top.reduce((n, s) => n + cost(s.id), 0), recent: top.slice(0, 8).map((s) => ({ id: s.id, title: s.title, time: s.time, cost: cost(s.id) })) },
      mcp: Object.entries(mcpEntries(dir)).map(([name, e]) => ({ name, status: mcpState(name, e).status })),
      agents: agentList(dir).filter((a) => a.mode !== 'subagent').map((a) => a.name),
      models: { count: 2, default: 'demo/demo-model' }
    }
  }],
  // same shape as server/api/v1/usage.get.ts: one row per assistant reply + list prices
  ['GET', 'usage', ({ query }) => {
    const dir = dirOf(query)
    const days = Math.min(365, Math.max(1, Math.round(Number(query.get('days')) || 30)))
    const since = Date.now() - days * 86400_000
    const titles = new Map(state.sessions.map((s) => [s.id, s.title]))
    const rows = state.sessions.filter((s) => s.directory === dir).flatMap((s) => messagesOf(s.id)
      .filter((m) => m.info.role === 'assistant' && (m.info.time?.created || 0) >= since)
      .map((m) => {
        const t = m.info.tokens || {}
        return {
          sessionID: s.id, parentID: s.parentID, title: s.title, parentTitle: s.parentID ? titles.get(s.parentID) : undefined,
          time: m.info.time.created, completed: m.info.time?.completed,
          providerID: m.info.providerID || 'demo', modelID: m.info.modelID || 'demo-model', agent: m.info.agent || m.info.mode,
          cost: m.info.cost || 0,
          tokens: { input: t.input || 0, output: t.output || 0, reasoning: t.reasoning || 0, cacheRead: t.cache?.read || 0, cacheWrite: t.cache?.write || 0 }
        }
      }))
      .sort((a, b) => a.time - b.time)
    // list prices above what the demo "charges", so the page shows a promotion saving
    const prices = {
      'demo/demo-model': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      'demo/demo-fast': { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 }
    }
    return { generatedAt: Date.now(), days, rows, prices }
  }],
  ['GET', 'status', ({ query }) => ({
    opencode: { protocol: 'legacy', version: VERSION, reachable: true, hybrid: false },
    busy: [...busy.keys()].map((sid) => ({ directory: sessionOf(sid)?.directory, sessionID: sid, status: 'busy', title: sessionOf(sid)?.title }))
      .filter((b) => !dirOf(query) || b.directory === dirOf(query)),
    schedules: { total: state.schedules.length, enabled: state.schedules.filter((s) => s.enabled).length, running: 0 },
    reload: lastReload,
    control: null,
    time: { zone: Intl.DateTimeFormat().resolvedOptions().timeZone, now: Date.now(), offsetMinutes: -new Date().getTimezoneOffset() }
  })],
  ['GET', 'reload', () => lastReload],
  ['POST', 'reload', ({ body }) => {
    lastReload = { scope: body?.scope || 'project', directory: body?.directory, when: body?.when || 'idle', requestedAt: Date.now(), state: 'done', doneAt: Date.now(), message: body?.scope === 'all' ? 'every opencode instance reloaded' : 'project instance reloaded' }
    return lastReload
  }],
  ['GET', 'schedules', ({ query }) => state.schedules.filter((s) => !dirOf(query) || s.directory === dirOf(query)).map(presentSchedule)],
  ['POST', 'schedules', ({ body }) => {
    const problem = cronError(String(body?.cron || ''))
    if (problem) throw new HttpError(400, `cron: ${problem}`)
    if (!body?.name || !body?.prompt || !body?.directory) throw new HttpError(400, 'name, prompt and directory are required')
    const s: Json = {
      id: id('sch'), name: body.name, directory: body.directory, prompt: body.prompt, cron: body.cron,
      session: body.session === 'reuse' ? 'reuse' : 'new', model: body.model || undefined, agent: body.agent || undefined,
      enabled: body.enabled !== false, createdAt: Date.now(), updatedAt: Date.now(), runs: []
    }
    s.nextRunAt = nextCronRun(s.cron, Date.now())?.getTime()
    state.schedules.push(s)
    save()
    return presentSchedule(s)
  }],
  ['PATCH', 'schedules/:id', ({ params, body }) => {
    const s = state.schedules.find((x) => x.id === params.id)
    if (!s) throw new HttpError(404, 'No such schedule')
    if (body?.cron && cronError(body.cron)) throw new HttpError(400, `cron: ${cronError(body.cron)}`)
    Object.assign(s, body, { updatedAt: Date.now() })
    s.nextRunAt = nextCronRun(s.cron, Date.now())?.getTime()
    save()
    return presentSchedule(s)
  }],
  ['DELETE', 'schedules/:id', ({ params }) => { state.schedules = state.schedules.filter((s) => s.id !== params.id); save(); return true }],
  ['POST', 'schedules/:id/run', ({ params }) => {
    const s = state.schedules.find((x) => x.id === params.id)
    if (!s) throw new HttpError(404, 'No such schedule')
    return runSchedule(s, 'manual')
  }]
]
for (const [method, path, handler] of v1) route(method, `v1/${path}`, handler)
route('GET', 'health', () => ({ ok: true, opencode: true, protocol: 'legacy', version: VERSION }))

async function handle(method: string, path: string, query: URLSearchParams, body: Json) {
  for (const [m, re, keys, handler] of routes) {
    if (m !== method) continue
    const match = re.exec(path)
    if (!match) continue
    const params = Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(match[i + 1]!)]))
    return handler({ params, query, body, method })
  }
  throw new HttpError(404, `The demo server has no ${method} /${path}`)
}

/** `/opencode-web/api/opencode/session` -> `session`; undefined when not an API call. */
function apiPath(url: URL) {
  if (url.origin !== location.origin) return undefined
  const at = url.pathname.indexOf('/api/')
  if (at < 0) return undefined
  const rest = url.pathname.slice(at + 5)
  if (rest.startsWith('_nuxt_icon')) return undefined
  return rest.startsWith('opencode/') ? rest.slice(9) : rest
}

// ---- shims ----

class DemoEventSource extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSED = 2
  readyState = 0
  readonly url: string
  readonly withCredentials = false
  onopen: ((e: Event) => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  private sub: Subscriber

  constructor(url: string) {
    super()
    this.url = url
    const parsed = new URL(url, location.href)
    const directory = parsed.searchParams.get('directory') || undefined
    this.sub = { directory, send: (data) => this.deliver(data) }
    setTimeout(() => {
      if (this.readyState === 2) return
      this.readyState = 1
      const open = new Event('open')
      this.onopen?.(open)
      this.dispatchEvent(open)
      subscribers.add(this.sub)
      this.deliver(JSON.stringify({ type: 'server.connected', properties: {} }))
    }, 30)
  }

  private deliver(data: string) {
    if (this.readyState !== 1) return
    const event = new MessageEvent('message', { data })
    // async like a real stream, and in order
    queueMicrotask(() => {
      this.onmessage?.(event)
      this.dispatchEvent(event)
    })
  }

  close() {
    this.readyState = 2
    subscribers.delete(this.sub)
  }
}

function json(data: unknown, status = 200) {
  return new Response(data === undefined ? 'null' : JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
}

export function installDemoBackend() {
  const w = window as unknown as { __ocwDemo?: boolean; EventSource: typeof EventSource }
  if (w.__ocwDemo) return
  w.__ocwDemo = true
  const original = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined
    const url = new URL(request ? request.url : String(input), location.href)
    const path = apiPath(url)
    if (path === undefined) return original(input, init)
    const method = (init?.method || request?.method || 'GET').toUpperCase()
    let body: Json
    const raw = init?.body ?? (request && method !== 'GET' ? await request.clone().text() : undefined)
    if (typeof raw === 'string' && raw) {
      try { body = JSON.parse(raw) } catch { body = raw }
    }
    try {
      const result = await handle(method, path, url.searchParams, body)
      return json(result)
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500
      return json({ message: (error as Error)?.message || String(error), statusMessage: 'Demo' }, status)
    }
  }
  const OriginalEventSource = window.EventSource
  const Patched = function (this: unknown, url: string | URL, init?: EventSourceInit) {
    const target = new URL(String(url), location.href)
    if (apiPath(target) === undefined) return new OriginalEventSource(url, init)
    return new DemoEventSource(target.toString())
  } as unknown as typeof EventSource
  Object.assign(Patched, { CONNECTING: 0, OPEN: 1, CLOSED: 2 })
  w.EventSource = Patched
}

export function resetDemo() {
  resetState()
  location.reload()
}
