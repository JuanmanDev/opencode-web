<script setup lang="ts">
import type {
  AgentInfo,
  MessageInfo,
  MessageWithParts,
  Part,
  PermissionRequest,
  ProvidersResponse,
  SessionInfo,
  TodoItem
} from '#shared/types/opencode'

const route = useRoute()
const directory = computed(() => decodeDir(route.params.dir as string))
const sessionId = computed(() => route.params.id as string)

const api = useOpencodeApi(directory)
const toast = useToast()

const session = ref<SessionInfo | null>(null)
const messages = ref<MessageWithParts[]>([])
const providers = ref<ProvidersResponse | null>(null)
const agents = ref<AgentInfo[]>([])
const commands = ref<Array<{ name: string; description?: string; source?: string }>>([])
const mcpInfo = ref<Array<{
  name: string
  status: string
  error?: string
  tools: Array<{ id: string; name: string; description?: string }>
}>>([])
const permissions = ref<PermissionRequest[]>([])
const busy = ref(false)
const loading = ref(true)

const scroller = ref<HTMLElement>()
const pinnedToBottom = ref(true)

const chime = useChime()
const projectMeta = useProjectMeta()
onMounted(projectMeta.load)

// ---- MCP app viewer (URL-addressable: ?app=<id>&view=side|full) ----
const { registry } = useAppRegistry()
const viewer = useAppViewer()
const viewerResource = computed(() =>
  viewer.appId.value ? registry.value[viewer.appId.value] : undefined
)
const isSmallScreen = ref(false)
onMounted(() => {
  const mq = window.matchMedia('(max-width: 1023px)')
  isSmallScreen.value = mq.matches
  mq.addEventListener('change', (e) => { isSmallScreen.value = e.matches })
})
// small screens have no room for a side panel: promote to fullscreen
const effectiveView = computed(() =>
  viewer.view.value === 'side' && isSmallScreen.value ? 'full' : viewer.view.value
)

// ---- agent questions ----
const questions = ref<Array<{ id: string; questions: any[] }>>([])

async function loadQuestions() {
  const all = await api.questions()
  questions.value = all
    .filter((q) => !q.sessionID || q.sessionID === sessionId.value)
    .filter((q) => q.id && Array.isArray(q.questions))
    .map((q) => ({ id: String(q.id), questions: q.questions }))
}

async function replyQuestion(requestID: string, answers: string[][]) {
  if (requestID.startsWith('local-demo')) {
    questions.value = questions.value.filter((q) => q.id !== requestID)
    note(`✅ Demo answer received: **${answers.map((a) => a.join(', ')).join(' | ')}** — with a real agent question this reply goes to opencode and the agent continues.`)
    return
  }
  try {
    await api.replyQuestion(requestID, answers)
    questions.value = questions.value.filter((q) => q.id !== requestID)
  } catch (e) {
    toast.add({ title: 'Failed to send answer', description: String(e), color: 'error' })
  }
}

async function rejectQuestion(requestID: string) {
  if (requestID.startsWith('local-demo')) {
    questions.value = questions.value.filter((q) => q.id !== requestID)
    return
  }
  try {
    await api.rejectQuestion(requestID)
  } finally {
    questions.value = questions.value.filter((q) => q.id !== requestID)
  }
}

// while the agent works, poll for questions too - not every opencode version
// emits question events over SSE
let questionPoll: ReturnType<typeof setInterval> | undefined
watch(busy, (now) => {
  clearInterval(questionPoll)
  if (now) questionPoll = setInterval(loadQuestions, 8000)
}, { immediate: true })
onBeforeUnmount(() => clearInterval(questionPoll))

// ---- local /mcp chat commands (handled by the UI, not sent to the agent) ----
const localNotes = ref<Array<{ id: string; text: string }>>([])
let noteCounter = 0

function note(text: string) {
  localNotes.value.push({ id: `note-${++noteCounter}`, text })
  scrollToBottom(true)
}

async function runMcpCommand(input: string) {
  const [, sub = 'help', ...rest] = input.trim().split(/\s+/)
  const name = rest[0]
  try {
    switch (sub) {
      case 'list': {
        const status = await api.mcpStatus()
        const rows = Object.entries(status)
          .map(([n, s]) => `| ${n} | ${(s as any)?.status || 'unknown'} |`)
          .join('\n')
        note(`**MCP servers**\n\n| server | status |\n| --- | --- |\n${rows || '| _none_ | |'}`)
        break
      }
      case 'add': {
        const target = rest.slice(1).join(' ')
        if (!name || !target) return note('Usage: `/mcp add <name> <url | command…>`')
        const config = /^https?:\/\//.test(target)
          ? { type: 'remote', url: target, enabled: true }
          : { type: 'local', command: target.split(/\s+/), enabled: true }
        await api.mcpAdd(name, config)
        note(`Added MCP server **${name}**.`)
        loadMeta()
        break
      }
      case 'enable':
      case 'disable': {
        if (!name) return note(`Usage: \`/mcp ${sub} <name>\``)
        await api.patchConfig({ mcp: { [name]: { enabled: sub === 'enable' } } })
        note(`**${name}** ${sub}d. Applies to new sessions.`)
        loadMeta()
        break
      }
      case 'remove': {
        if (!name) return note('Usage: `/mcp remove <name>`')
        try {
          await api.patchConfig({ mcp: { [name]: null } })
          note(`Removed **${name}** from the project config.`)
        } catch {
          await api.patchConfig({ mcp: { [name]: { enabled: false } } })
          note(`Could not delete **${name}** via the API — disabled it instead.`)
        }
        loadMeta()
        break
      }
      case 'test': {
        if (!name) return note('Usage: `/mcp test <name>`')
        const res = await $fetch<Record<string, { tools: Array<{ name: string }>; error?: string }>>(
          '/api/v1/mcp-tools',
          { query: { directory: directory.value }, timeout: 30000 }
        )
        const info = res[name]
        if (!info) note(`**${name}**: not found in the project config.`)
        else if (info.error) note(`**${name}**: ❌ ${info.error}`)
        else note(`**${name}**: ✅ ${info.tools.length} tools\n\n${info.tools.slice(0, 30).map((t) => `- \`${t.name}\``).join('\n')}`)
        break
      }
      default:
        note([
          '**/mcp commands**',
          '',
          '- `/mcp list` — servers and status',
          '- `/mcp add <name> <url|command…>` — register a server',
          '- `/mcp enable|disable <name>` — toggle for this project',
          '- `/mcp remove <name>` — delete from the project config',
          '- `/mcp test <name>` — connect and list its tools'
        ].join('\n'))
    }
  } catch (e) {
    note(`❌ ${e instanceof Error ? e.message : e}`)
  }
}

// ---- title rename (edit lives inside the conversation) ----
const renamingTitle = ref(false)
const titleDraft = ref('')

function startTitleRename() {
  titleDraft.value = session.value?.title || ''
  renamingTitle.value = true
  nextTick(() => (document.getElementById('session-title-input') as HTMLInputElement | null)?.focus())
}

async function commitTitleRename() {
  const title = titleDraft.value.trim()
  renamingTitle.value = false
  if (!title || title === session.value?.title) return
  try {
    await api.renameSession(sessionId.value, title)
    if (session.value) session.value = { ...session.value, title }
  } catch (e) {
    toast.add({ title: 'Rename failed', description: String(e), color: 'error' })
  }
}

// ---- todos ----
const todos = ref<TodoItem[]>([])
const todosOpen = ref(true)

async function loadTodos() {
  todos.value = await api.todos(sessionId.value)
}

function todoIcon(status: string) {
  if (status === 'completed') return 'i-lucide-check-circle-2'
  if (status === 'in_progress') return 'i-lucide-loader-circle'
  if (status === 'cancelled') return 'i-lucide-circle-off'
  return 'i-lucide-circle'
}

// ---- fork ----
async function forkSession(messageID?: string) {
  try {
    const forked = await api.fork(sessionId.value, messageID)
    toast.add({ title: 'Session forked', color: 'success' })
    navigateTo(`/p/${route.params.dir}/session/${forked.id}`)
  } catch (e) {
    toast.add({ title: 'Fork failed', description: String(e), color: 'error' })
  }
}

// ---- diff viewer ----
const diffOpen = ref(false)
const diffLoading = ref(false)
const diffFiles = ref<Array<{ file: string; text: string }>>([])

async function openDiff() {
  diffOpen.value = true
  diffLoading.value = true
  diffFiles.value = []
  try {
    const res = await api.diff(sessionId.value)
    if (typeof res === 'string') {
      diffFiles.value = [{ file: 'changes', text: res }]
    } else if (Array.isArray(res)) {
      diffFiles.value = res.map((f: any) => ({
        file: String(f.file || f.filename || f.path || 'file'),
        text: String(f.patch || f.diff || f.text || JSON.stringify(f, null, 2))
      }))
    } else if (res && typeof res === 'object') {
      diffFiles.value = Object.entries(res as Record<string, unknown>).map(([file, value]) => ({
        file,
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2)
      }))
    }
  } catch (e) {
    toast.add({ title: 'Could not load diff', description: String(e), color: 'error' })
  } finally {
    diffLoading.value = false
  }
}

function diffLineClass(line: string) {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'text-success'
  if (line.startsWith('-') && !line.startsWith('---')) return 'text-error'
  if (line.startsWith('@@')) return 'text-info'
  return 'text-muted'
}
// ring only when the agent is REALLY done: busy flickers between steps
// (message completes -> next tool/message starts), so require a quiet period
let chimeTimer: ReturnType<typeof setTimeout> | undefined
watch(busy, (now, before) => {
  clearTimeout(chimeTimer)
  if (before && !now && !loading.value) {
    chimeTimer = setTimeout(() => {
      if (!busy.value && queue.value.length === 0) chime.play()
    }, 1800)
  }
})
onBeforeUnmount(() => clearTimeout(chimeTimer))

function onScroll() {
  const el = scroller.value
  if (!el) return
  pinnedToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 80
}

function scrollToBottom(force = false) {
  if (!force && !pinnedToBottom.value) return
  nextTick(() => {
    const el = scroller.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

const loadError = ref('')

async function loadAll() {
  loading.value = true
  loadError.value = ''
  permissions.value = []
  try {
    const [s, msgs] = await Promise.all([
      api.session(sessionId.value).catch(() => null),
      api.messages(sessionId.value)
    ])
    session.value = s
    messages.value = msgs
    loadTodos()
    loadQuestions()
    const last = msgs[msgs.length - 1]
    // an incomplete assistant message older than a few hours is a zombie
    // (server restarted mid-run) - never lock the input on it
    const age = Date.now() - (last?.info.time?.created || 0)
    busy.value = Boolean(
      last && last.info.role === 'assistant' && !last.info.time?.completed &&
      !last.info.error && age < 1000 * 60 * 60 * 6
    )
  } catch (e) {
    const err = e as { statusCode?: number; data?: { message?: string } }
    loadError.value = err?.statusCode === 504 || err?.statusCode === 502
      ? 'The opencode server is not responding.'
      : String(err?.data?.message || e)
  } finally {
    loading.value = false
    scrollToBottom(true)
  }
}

watch(sessionId, loadAll, { immediate: true })

const metaLoading = ref(true)
const mcpLoading = ref(true)
const providersCacheKey = computed(() => `opencode-web.providers.${directory.value}`)

async function loadMeta() {
  metaLoading.value = true
  mcpLoading.value = true
  // stale-while-revalidate: paint the model list instantly from cache so a
  // slow or flaky connection never leaves the selector empty
  try {
    const cached = JSON.parse(localStorage.getItem(providersCacheKey.value) || 'null')
    if (cached && !providers.value) {
      providers.value = cached
      metaLoading.value = false
    }
  } catch { /* ignore */ }

  try {
    const [prov, ag, mcp, toolIds, cmds, remoteTools] = await Promise.all([
      api.providers().catch(() => null),
      api.agents().catch(() => [] as AgentInfo[]),
      api.mcpStatus().catch(() => ({} as Record<string, any>)),
      api.toolIds(),
      api.commands(),
      // opencode doesn't expose MCP tool ids, so our server asks the remote
      // MCP servers themselves for their tool lists
      $fetch<Record<string, { tools: Array<{ name: string; description?: string }>; error?: string }>>(
        '/api/v1/mcp-tools',
        { query: { directory: directory.value }, timeout: 20000 }
      ).catch(() => ({} as Record<string, { tools: Array<{ name: string; description?: string }>; error?: string }>))
    ])
    if (prov) {
      providers.value = prov
      try { localStorage.setItem(providersCacheKey.value, JSON.stringify(prov)) } catch { /* full */ }
    }
    agents.value = ag
    commands.value = cmds
    mcpInfo.value = Object.entries(mcp)
      .map(([name, s]) => {
        const remote = remoteTools[name]
        const fromRemote = (remote?.tools || []).map((t) => ({
          id: `${name}_${t.name}`,
          name: t.name,
          description: t.description
        }))
        const fromIds = toolIds
          .filter((id) => id.startsWith(`${name}_`))
          .filter((id) => !fromRemote.some((t) => t.id === id))
          .map((id) => ({ id, name: id.slice(name.length + 1) }))
        return {
          name,
          status: String((s as any)?.status || (s as any)?.state || 'unknown'),
          error: typeof (s as any)?.error === 'string' ? (s as any).error : remote?.error,
          tools: [...fromRemote, ...fromIds].sort((a, b) => a.name.localeCompare(b.name))
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
    mcpLoading.value = false
  } finally {
    metaLoading.value = false
    mcpLoading.value = false
  }
}

onMounted(loadMeta)

function upsertMessage(info: MessageInfo) {
  if (info.sessionID !== sessionId.value) return
  const idx = messages.value.findIndex((m) => m.info.id === info.id)
  if (idx >= 0) {
    messages.value[idx] = { info, parts: messages.value[idx]!.parts }
  } else {
    messages.value.push({ info, parts: [] })
  }
  if (info.role === 'assistant') {
    // completed message clears busy even when session.idle got lost in an
    // SSE reconnect gap; a following incomplete message flips it back on
    busy.value = !info.time?.completed && !info.error
  }
  scrollToBottom()
}

function upsertPart(part: Part) {
  if (part.sessionID !== sessionId.value) return
  let msg = messages.value.find((m) => m.info.id === part.messageID)
  if (!msg) {
    msg = {
      info: { id: part.messageID, sessionID: part.sessionID, role: 'assistant' },
      parts: []
    }
    messages.value.push(msg)
  }
  const idx = msg.parts.findIndex((p) => p.id === part.id)
  if (idx >= 0) msg.parts.splice(idx, 1, part)
  else msg.parts.push(part)
  scrollToBottom()
}

useOpencodeEvents(directory, (event) => {
  const props = (event.properties || {}) as Record<string, any>
  switch (event.type) {
    case 'message.updated':
      if (props.info) upsertMessage(props.info as MessageInfo)
      break
    case 'message.part.updated':
      if (props.part) upsertPart(props.part as Part)
      break
    case 'message.removed':
      if (props.sessionID === sessionId.value) {
        messages.value = messages.value.filter((m) => m.info.id !== props.messageID)
      }
      break
    case 'session.idle':
      if (props.sessionID === sessionId.value) {
        busy.value = false
        loadTodos()
      }
      break
    case 'session.error': {
      const sid = props.sessionID
      if (!sid || sid === sessionId.value) {
        busy.value = false
        const message = props.error?.data?.message || props.error?.name || 'Session error'
        toast.add({
          title: message,
          color: 'error',
          actions: [
            { label: 'Retry', icon: 'i-lucide-rotate-ccw', color: 'error', variant: 'soft', onClick: retryLast },
            { label: 'Continue', icon: 'i-lucide-play', color: 'neutral', variant: 'soft', onClick: continueRun }
          ]
        })
      }
      break
    }
    case 'permission.updated':
    case 'permission.asked': {
      const perm = props as unknown as PermissionRequest
      if (perm.sessionID === sessionId.value && perm.id) {
        if (!permissions.value.some((p) => p.id === perm.id)) permissions.value.push(perm)
      }
      break
    }
    case 'permission.replied': {
      const id = props.permissionID || props.id
      permissions.value = permissions.value.filter((p) => p.id !== id)
      break
    }
    case 'server.connected':
      // SSE (re)connected: events may have been missed while offline
      if (!loading.value) {
        api.messages(sessionId.value).then((msgs) => {
          messages.value = msgs
          const last = msgs[msgs.length - 1]
          busy.value = Boolean(
            last && last.info.role === 'assistant' && !last.info.time?.completed && !last.info.error
          )
        }).catch(() => {})
        loadQuestions()
      }
      break
    default:
      if (event.type.startsWith('question')) loadQuestions()
  }
})

type PromptPayload = {
  text: string
  model?: { providerID: string; modelID: string }
  agent?: string
  variant?: string
  tools?: Record<string, boolean>
  files?: Array<{ mime: string; filename: string; url: string }>
}

// prompts sent while the agent is busy wait in a queue and fire on idle
const queue = ref<PromptPayload[]>([])
// last dispatched settings so error-retry keeps the same model/agent/tools
const lastPayload = ref<PromptPayload | null>(null)
const promptSeed = ref<{ text: string; ts: number } | null>(null)

function retryLast() {
  const lastUser = [...messages.value].reverse().find((m) => m.info.role === 'user')
  const text = (lastUser?.parts || [])
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text?: string }).text || '')
    .join('\n')
    .trim()
  if (!text) {
    toast.add({ title: 'Nothing to retry', color: 'warning' })
    return
  }
  dispatch({ ...(lastPayload.value || {} as PromptPayload), text })
}

function continueRun() {
  dispatch({ ...(lastPayload.value || {} as PromptPayload), text: 'Continue.' })
}

function dispatch(payload: PromptPayload) {
  busy.value = true
  pinnedToBottom.value = true
  lastPayload.value = payload
  const parts: Array<Record<string, unknown>> = [
    ...(payload.files || []).map((f) => ({ type: 'file', mime: f.mime, filename: f.filename, url: f.url })),
    ...(payload.text ? [{ type: 'text', text: payload.text }] : [])
  ]
  api.prompt(sessionId.value, {
    parts: parts as never,
    model: payload.model,
    agent: payload.agent,
    variant: payload.variant,
    tools: payload.tools
  }).catch((e) => {
    busy.value = false
    toast.add({ title: 'Prompt failed', description: String(e?.data?.message || e), color: 'error' })
  })
  scrollToBottom(true)
}

// opencode built-in slash commands handled through their APIs
const BUILTIN_COMMANDS: Array<{ name: string; description: string }> = [
  { name: 'init', description: 'Analyze the project and create/update AGENTS.md' },
  { name: 'share', description: 'Share this conversation (returns a link)' },
  { name: 'compact', description: 'Summarize the conversation to free context' },
  { name: 'summarize', description: 'Alias of /compact' },
  { name: 'undo', description: 'Revert the last change' },
  { name: 'redo', description: 'Restore the reverted change' },
  { name: 'mcp', description: 'Manage MCP servers (list, add, test…)' },
  { name: 'test', description: 'UI demos, e.g. /test question' }
]

const allCommands = computed(() => [
  ...BUILTIN_COMMANDS,
  ...commands.value.map((c) => ({
    name: c.name,
    description: c.description || `${c.source || 'custom'} command`
  }))
])

async function runSlashCommand(text: string) {
  const trimmed = text.trim().replace(/^\//, '')
  const [name = '', ...rest] = trimmed.split(/\s+/)
  const args = rest.join(' ')
  try {
    switch (name) {
      case 'init':
        busy.value = true
        note('Running **/init** — analyzing the project…')
        api.runCommand(sessionId.value, 'init', args).catch(() =>
          dispatch({ text: 'Analyze this project and create or update AGENTS.md with build commands, conventions and architecture notes.' })
        )
        return
      case 'share': {
        const res = await api.share(sessionId.value)
        const url = (res as any)?.share?.url || (res as any)?.url
        note(url ? `Shared: ${url}` : 'Share requested.')
        return
      }
      case 'compact':
      case 'summarize':
        busy.value = true
        note('Summarizing the conversation…')
        api.summarize(sessionId.value).catch((e) => note(`❌ ${e?.data?.message || e}`))
        return
      case 'undo':
        await api.revert(sessionId.value)
        note('Reverted the last change.')
        loadAll()
        return
      case 'redo':
        await api.unrevert(sessionId.value)
        note('Restored the reverted change.')
        loadAll()
        return
      default: {
        if (commands.value.some((c) => c.name === name)) {
          busy.value = true
          api.runCommand(sessionId.value, name, args).catch((e) => {
            busy.value = false
            note(`❌ /${name}: ${e?.data?.message || e}`)
          })
          return
        }
        note([
          `Unknown command: \`/${name}\`. Available:`,
          '',
          ...allCommands.value.map((c) => `- \`/${c.name}\` — ${c.description}`)
        ].join('\n'))
      }
    }
  } catch (e) {
    note(`❌ /${name}: ${(e as any)?.data?.message || e}`)
  }
}

function send(payload: PromptPayload) {
  const trimmed = payload.text.trim()
  // !cmd -> run a shell command inside the session
  if (trimmed.startsWith('!')) {
    const cmd = trimmed.slice(1).trim()
    if (!cmd) return
    busy.value = true
    note(`$ ${cmd}`)
    api.shell(sessionId.value, cmd).catch((e) => {
      busy.value = false
      note(`❌ shell: ${e?.data?.message || e}`)
    })
    return
  }
  // /mcp … -> handled locally by the UI, never sent to the agent
  if (trimmed.startsWith('/mcp')) {
    runMcpCommand(payload.text)
    return
  }
  // /test question -> inject a demo question card to try the reply flow
  if (payload.text.trim().startsWith('/test')) {
    questions.value.push({
      id: `local-demo-${Date.now()}`,
      questions: [{
        header: 'Demo question',
        question: 'Which JS framework do you want?',
        options: [
          { label: 'Vue', description: 'Nuxt, composition API' },
          { label: 'Svelte', description: 'SvelteKit, runes' },
          { label: 'React', description: 'Next.js, hooks' }
        ]
      }]
    })
    note('Demo question injected — the chat input is replaced by the answer card until you reply or dismiss. Type your own answer in the text field for the "Other" case.')
    return
  }
  // any other /command -> opencode command runner
  if (trimmed.startsWith('/')) {
    runSlashCommand(trimmed)
    return
  }
  if (busy.value) {
    queue.value.push(payload)
    return
  }
  dispatch(payload)
}

watch(busy, (now, before) => {
  if (before && !now && queue.value.length) {
    const next = queue.value.shift()!
    // small delay so the finished reply settles before the next prompt
    setTimeout(() => dispatch(next), 400)
  }
})

async function abort() {
  try {
    await api.abort(sessionId.value)
    busy.value = false
  } catch {
    toast.add({ title: 'Abort failed', color: 'error' })
  }
}

// current activity while busy: last running tool, else reasoning/thinking
const activity = computed(() => {
  if (!busy.value) return ''
  const last = messages.value[messages.value.length - 1]
  if (!last || last.info.role !== 'assistant') return 'thinking…'
  for (let i = last.parts.length - 1; i >= 0; i--) {
    const part = last.parts[i] as Record<string, any>
    if (part.type === 'tool' && part.state?.status === 'running') {
      return `${part.tool}${part.state?.title ? ` · ${part.state.title}` : ''}`
    }
    if (part.type === 'reasoning' && !part.time?.end) return 'thinking…'
    if (part.type === 'text' && !part.time?.end) return 'writing…'
  }
  return 'working…'
})

async function respondPermission(perm: PermissionRequest, response: 'once' | 'always' | 'reject') {
  try {
    await api.respondPermission(perm.sessionID, perm.id, response)
    permissions.value = permissions.value.filter((p) => p.id !== perm.id)
  } catch (e) {
    toast.add({ title: 'Failed to respond', description: String(e), color: 'error' })
  }
}

useHead(() => ({ title: `${session.value?.title || 'Chat'} · opencode web` }))
</script>

<template>
  <div
    class="flex-1 flex min-h-0 transition-[margin] duration-300"
    :style="effectiveView === 'side' && !isSmallScreen ? { marginRight: 'min(42vw, 42rem)' } : {}"
  >
  <div class="flex-1 flex flex-col min-h-0 min-w-0">
    <!-- session header -->
    <div class="hidden md:flex items-center gap-2 h-12 px-4 bg-muted/50 shrink-0">
      <UInput
        v-if="renamingTitle"
        id="session-title-input"
        v-model="titleDraft"
        size="xs"
        class="w-72"
        @keydown.enter.prevent="commitTitleRename"
        @keydown.esc="renamingTitle = false"
        @blur="commitTitleRename"
      />
      <UTooltip v-else text="Click to rename">
        <button
          class="text-sm font-medium truncate cursor-pointer hover:underline decoration-dotted underline-offset-2"
          @click="startTitleRename"
        >{{ session?.title || 'Untitled session' }}</button>
      </UTooltip>
      <UBadge v-if="busy" color="warning" variant="subtle" size="sm" class="animate-pulse">working</UBadge>
      <span class="flex-1" />
      <UTooltip text="Fork this conversation">
        <UButton
          icon="i-lucide-git-branch"
          color="neutral"
          variant="ghost"
          size="xs"
          aria-label="Fork this conversation"
          @click="forkSession()"
        />
      </UTooltip>
      <UTooltip text="Show file changes">
        <UButton
          icon="i-lucide-file-diff"
          color="neutral"
          variant="ghost"
          size="xs"
          aria-label="Show file changes"
          @click="openDiff"
        />
      </UTooltip>
      <UTooltip :text="projectMeta.isFavorite(directory, sessionId) ? 'Unfavorite' : 'Favorite'">
        <UButton
          icon="i-lucide-star"
          :color="projectMeta.isFavorite(directory, sessionId) ? 'primary' : 'neutral'"
          variant="ghost"
          size="xs"
          :aria-label="projectMeta.isFavorite(directory, sessionId) ? 'Unfavorite conversation' : 'Favorite conversation'"
          @click="projectMeta.toggleFavorite(directory, sessionId)"
        />
      </UTooltip>
      <UTooltip :text="chime.enabled.value ? 'Disable reply sound' : 'Enable reply sound'">
        <UButton
          :icon="chime.enabled.value ? 'i-lucide-bell-ring' : 'i-lucide-bell-off'"
          color="neutral"
          variant="ghost"
          size="xs"
          :aria-label="chime.enabled.value ? 'Disable reply sound' : 'Enable reply sound'"
          @click="chime.toggle()"
        />
      </UTooltip>
      <span class="text-xs text-dimmed font-mono truncate max-w-64">{{ directory }}</span>
    </div>

    <!-- live todo list from the agent -->
    <CollapseTransition>
      <div v-if="todos.length" class="bg-muted/40 px-3 sm:px-4 py-1.5 shrink-0">
        <div class="max-w-4xl mx-auto">
          <button
            class="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-dimmed cursor-pointer"
            @click="todosOpen = !todosOpen"
          >
            Todos ({{ todos.filter(t => t.status === 'completed').length }}/{{ todos.length }})
            <UIcon
              name="i-lucide-chevron-down"
              class="size-3 transition-transform duration-200"
              :class="todosOpen ? 'rotate-180' : ''"
            />
          </button>
          <CollapseTransition>
            <div v-if="todosOpen" class="pt-1 space-y-0.5">
              <div
                v-for="(todo, i) in todos"
                :key="i"
                class="flex items-center gap-1.5 text-xs"
                :class="todo.status === 'completed' ? 'text-dimmed line-through' : 'text-muted'"
              >
                <UIcon
                  :name="todoIcon(todo.status)"
                  class="size-3.5 shrink-0"
                  :class="todo.status === 'in_progress' ? 'animate-spin text-highlighted' : ''"
                />
                {{ todo.content }}
              </div>
            </div>
          </CollapseTransition>
        </div>
      </div>
    </CollapseTransition>

    <div
      ref="scroller"
      class="flex-1 overflow-y-auto min-h-0 py-2"
      @scroll.passive="onScroll"
    >
      <div class="max-w-4xl mx-auto">
        <div v-if="loading" class="px-3 sm:px-4 py-4 space-y-4">
          <div class="space-y-2">
            <USkeleton class="h-9 w-2/3" />
          </div>
          <div class="space-y-2">
            <USkeleton class="h-4 w-full" />
            <USkeleton class="h-4 w-5/6" />
            <USkeleton class="h-4 w-3/4" />
          </div>
          <div class="space-y-2">
            <USkeleton class="h-8 w-1/2" />
            <USkeleton class="h-4 w-4/6" />
          </div>
        </div>
        <div v-else-if="loadError" class="px-3 sm:px-4 py-10">
          <UAlert
            color="error"
            variant="subtle"
            icon="i-lucide-plug-zap"
            title="Cannot load this session"
            :description="loadError"
          >
            <template #actions>
              <UButton size="xs" color="error" variant="soft" icon="i-lucide-refresh-cw" label="Retry" @click="loadAll" />
            </template>
          </UAlert>
        </div>
        <template v-else>
          <div v-if="!messages.length" class="text-center py-16 text-sm text-dimmed">
            Send the first message to start working.
          </div>
          <ChatMessageItem
            v-for="message in messages"
            :key="message.info.id"
            :message="message"
            @fork="forkSession(message.info.id)"
            @retry="retryLast"
            @continue="continueRun"
            @edit="(text) => { promptSeed = { text, ts: Date.now() } }"
          />
          <ChatPermissionPrompt
            v-for="perm in permissions"
            :key="perm.id"
            :permission="perm"
            @respond="(r) => respondPermission(perm, r)"
          />
          <!-- local command output (/mcp …) -->
          <div
            v-for="n in localNotes"
            :key="n.id"
            class="oc-appear mx-3 sm:mx-4 my-2 rounded-sm bg-muted px-3 py-2"
          >
            <div class="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-dimmed mb-1">
              <UIcon name="i-lucide-terminal" class="size-3" /> local
            </div>
            <Markdown :text="n.text" />
          </div>
          <ChatWorking v-if="busy" :activity="activity" />

          <!-- queued prompts -->
          <CollapseTransition>
          <div v-if="queue.length" class="px-3 sm:px-4 py-1 space-y-1">
            <div
              v-for="(item, i) in queue"
              :key="i"
              class="oc-appear flex items-center gap-2 rounded-sm bg-elevated/70 px-2.5 py-1.5 text-xs"
            >
              <UIcon name="i-lucide-clock" class="size-3.5 text-dimmed shrink-0" />
              <span class="truncate flex-1 font-mono text-muted">{{ item.text }}</span>
              <UButton
                icon="i-lucide-x"
                size="xs"
                color="neutral"
                variant="ghost"
                @click="queue.splice(i, 1)"
              />
            </div>
          </div>
          </CollapseTransition>
        </template>
      </div>
    </div>

    <!-- a pending agent question replaces the chat input (TUI-style focus) -->
    <div v-if="questions[0]" class="bg-muted px-3 sm:px-4 py-2 sm:py-3 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      <div class="max-w-4xl mx-auto">
        <ChatQuestionPrompt
          :key="questions[0].id"
          :request="questions[0]"
          class="!mx-0 !my-0"
          @reply="(answers) => replyQuestion(questions[0]!.id, answers)"
          @reject="rejectQuestion(questions[0]!.id)"
        />
        <p v-if="questions.length > 1" class="text-[10px] text-dimmed mt-1">
          +{{ questions.length - 1 }} more question(s) after this one
        </p>
      </div>
    </div>

    <ChatPromptBox
      v-else
      :providers="providers"
      :agents="agents"
      :mcp-info="mcpInfo"
      :mcp-loading="mcpLoading"
      :meta-loading="metaLoading"
      :queue-length="queue.length"
      :commands="allCommands"
      :seed="promptSeed"
      :busy="busy"
      :directory="directory"
      @send="send"
      @abort="abort"
      @refresh-providers="loadMeta"
    />

    </div>

    <!-- MCP app viewer: ONE persistent container so the iframe survives
         side <-> fullscreen moves without reloading -->
    <Teleport to="body">
      <div
        v-if="viewer.appId.value && viewer.view.value"
        class="fixed z-50 bg-default flex flex-col gap-2 shadow-2xl"
        :class="effectiveView === 'side'
          ? 'right-0 inset-y-0 w-[42%] max-w-2xl border-l border-default p-2'
          : 'inset-0 p-2 sm:p-4'"
      >
        <div class="flex items-center gap-1 shrink-0">
          <span class="text-xs text-muted truncate flex-1 px-1">
            {{ viewerResource?.title || 'MCP app' }}
          </span>
          <UTooltip v-if="effectiveView === 'side'" text="Fullscreen">
            <UButton icon="i-lucide-maximize-2" size="xs" color="neutral" variant="ghost" @click="viewer.open(viewer.appId.value, 'full')" />
          </UTooltip>
          <UTooltip v-else text="Dock to side panel">
            <UButton icon="i-lucide-panel-right" size="xs" color="neutral" variant="ghost" class="hidden lg:inline-flex" @click="viewer.open(viewer.appId.value, 'side')" />
          </UTooltip>
          <UTooltip text="Move back to the chat">
            <UButton icon="i-lucide-x" size="xs" color="neutral" variant="ghost" @click="viewer.close()" />
          </UTooltip>
        </div>

        <!-- staged loading for deep links (?app=…&view=full on a fresh load) -->
        <div
          v-if="!viewerResource"
          class="flex-1 flex flex-col items-center justify-center gap-3 text-muted"
        >
          <UIcon name="i-lucide-loader-circle" class="size-8 animate-spin" />
          <p class="text-sm oc-shimmer-text">
            {{ loading ? 'Loading session…' : 'Loading UI component…' }}
          </p>
          <p class="text-xs text-dimmed max-w-xs text-center">
            The conversation is being restored and the MCP app re-fetched from its server.
          </p>
        </div>
        <ChatMcpHtmlFrame
          v-else
          :html="viewerResource.html"
          :url="viewerResource.url"
          :script="viewerResource.script"
          :app="viewerResource.app"
          :app-data="viewerResource.appData"
          :title="viewerResource.title"
          viewer
          class="flex-1 min-h-0"
        />
      </div>
    </Teleport>

    <!-- diff slideover -->
    <USlideover v-model:open="diffOpen" title="File changes" description="Everything this session edited.">
      <template #body>
        <div v-if="diffLoading" class="space-y-2">
          <USkeleton v-for="i in 4" :key="i" class="h-5 w-full" />
        </div>
        <div v-else-if="!diffFiles.length" class="text-sm text-dimmed py-6 text-center">
          No changes recorded for this session.
        </div>
        <div v-else class="space-y-4">
          <div v-for="entry in diffFiles" :key="entry.file">
            <div class="flex items-center gap-1.5 text-xs font-mono text-highlighted mb-1">
              <UIcon name="i-lucide-file-diff" class="size-3.5" />
              {{ entry.file }}
            </div>
            <pre class="text-[11px] font-mono bg-muted rounded-sm p-2 overflow-x-auto leading-relaxed"><template v-for="(line, i) in entry.text.split('\n')" :key="i"><span :class="diffLineClass(line)">{{ line }}</span>{{ '\n' }}</template></pre>
          </div>
        </div>
      </template>
    </USlideover>
  </div>
</template>
