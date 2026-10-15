<script setup lang="ts">
import type { AgentInfo, ProvidersResponse } from '#shared/types/opencode'
import type { MentionItem, PickedMention } from '~/composables/useMentions'

export interface McpServerInfo {
  name: string
  status: string
  error?: string
  approx?: boolean
  skipped?: boolean
  tools: Array<{ id: string; name: string; description?: string }>
}

const props = defineProps<{
  providers: ProvidersResponse | null
  agents: AgentInfo[]
  mcpInfo: McpServerInfo[]
  busy: boolean
  directory: string
  /** opencode's own default ("providerID/modelID" from config.model) */
  defaultModel?: string
  metaLoading?: boolean
  mcpLoading?: boolean
  queueLength?: number
  commands?: Array<{ name: string; description?: string }>
  /** put text into the input (edit-and-resend) */
  seed?: { text: string; ts: number } | null
}>()

const emit = defineEmits<{
  send: [payload: {
    text: string
    model?: { providerID: string; modelID: string }
    agent?: string
    variant?: string
    tools?: Record<string, boolean>
    files?: Array<{ mime: string; filename: string; url: string }>
    /** `@` mentions: file/agent parts sent after the text, like opencode does */
    parts?: Array<Record<string, unknown>>
  }]
  abort: []
  refreshProviders: []
}>()
const toast = useToast()
const caps = useCapabilities()

// NOTE: Reka UI <SelectItem> forbids empty-string values, so "default"
// sentinels are used instead of '' everywhere below.
const DEFAULT = 'default'

const text = ref('')
const model = ref<string>('')     // "providerID/modelID"
const agent = ref<string>(DEFAULT)
const variant = ref<string>(DEFAULT)
const mcpMode = ref<string>(DEFAULT)
const disabledServers = ref<string[]>([])
const disabledTools = ref<string[]>([])
const forcedTools = ref<string[]>([])
const optionsOpen = ref(false)
const providersOpen = ref(false)

const modelItems = computed(() => modelItemsOf(props.providers))

const primaryAgents = computed(() => props.agents
  .filter((a) => (!a.mode || a.mode === 'primary' || a.mode === 'all') && a.name !== DEFAULT && !(a as { hidden?: boolean }).hidden))
const agentItems = computed(() => [
  { label: 'default agent', value: DEFAULT, icon: 'i-lucide-bot', description: 'the server default (usually build)' },
  ...primaryAgents.value.map((a) => ({ label: a.name, value: a.name, icon: 'i-lucide-bot', description: a.description }))
])
// long agent lists (MCP subagents, custom agents) get a roomy picker too
const agentPickerOpen = ref(false)
const agentPickerItems = computed(() => [
  ...agentItems.value.map((a) => ({
    value: a.value,
    label: a.label,
    group: a.value === DEFAULT ? 'Default' : 'Primary agents',
    detail: a.description,
    icon: 'i-lucide-bot'
  })),
  // subagents can't run a chat but can be mentioned: picking one inserts @name
  ...props.agents.filter((a) => a.mode === 'subagent').map((a) => ({
    value: `@${a.name}`,
    label: `@${a.name}`,
    group: 'Subagents (inserted as an @mention)',
    detail: a.description,
    icon: 'i-lucide-bot-message-square'
  }))
])
const agentModel = computed({
  get: () => agent.value,
  set: (value: string) => {
    if (!value.startsWith('@')) {
      agent.value = value
      return
    }
    const name = value.slice(1)
    text.value = `${text.value.replace(/\s*$/, '')}${text.value.trim() ? ' ' : ''}@${name} `
    if (!picked.value.some((m) => m.kind === 'agent' && m.value === name)) {
      picked.value = [...picked.value, { kind: 'agent', value: name }]
    }
    nextTick(() => textareaEl()?.focus())
  }
})

const selectedModel = computed(() => modelItems.value.find((m) => m.value === model.value))

const variantItems = [
  { label: 'default', value: DEFAULT, icon: 'i-lucide-brain' },
  { label: 'none', value: 'none', icon: 'i-lucide-circle-off' },
  { label: 'low', value: 'low', icon: 'i-lucide-signal-low' },
  { label: 'medium', value: 'medium', icon: 'i-lucide-signal-medium' },
  { label: 'high', value: 'high', icon: 'i-lucide-signal-high' },
  { label: 'max', value: 'xhigh', icon: 'i-lucide-zap' }
]

const mcpModeItems = [
  { label: 'project default', value: DEFAULT, icon: 'i-lucide-server' },
  { label: 'all enabled', value: 'all', icon: 'i-lucide-server' },
  { label: 'all disabled', value: 'none', icon: 'i-lucide-server-off' },
  { label: 'custom…', value: 'custom', icon: 'i-lucide-list-checks' }
]

const mcpSummary = computed(() => {
  switch (mcpMode.value) {
    case 'all': return 'all'
    case 'none': return 'off'
    case 'custom': return `${enabledCount.value}/${props.mcpInfo.length}`
    default: return ''
  }
})

const variantLabel = computed(
  () => variantItems.find((v) => v.value === variant.value)?.label || DEFAULT
)

const enabledCount = computed(
  () => props.mcpInfo.filter((s) => !disabledServers.value.includes(s.name)).length
)

// remember last used settings per project
const prefsKey = computed(() => `opencode-web.prefs.${props.directory}`)

onMounted(() => {
  try {
    const saved = JSON.parse(localStorage.getItem(prefsKey.value) || '{}')
    if (saved.model) model.value = saved.model
    if (saved.agent) agent.value = saved.agent || DEFAULT
    if (saved.variant) variant.value = saved.variant || DEFAULT
    if (saved.mcpMode) mcpMode.value = saved.mcpMode
    if (Array.isArray(saved.disabledServers)) disabledServers.value = saved.disabledServers
    if (Array.isArray(saved.disabledTools)) disabledTools.value = saved.disabledTools
    if (Array.isArray(saved.forcedTools)) forcedTools.value = saved.forcedTools
  } catch { /* ignore */ }
})

// Pick the model opencode itself would use when none is sent (config.model);
// `providers.default` only lists each provider's own default, and its first
// entry is *not* the server default - showing it here while the server ran
// another model was misleading.
watch([modelItems, () => props.defaultModel], ([items, serverDefault]) => {
  if (model.value && items.some((i) => i.value === model.value)) return
  const defaults = props.providers?.default || {}
  const [providerID, modelID] = Object.entries(defaults)[0] || []
  const candidate =
    (serverDefault && items.some((i) => i.value === serverDefault) ? serverDefault : undefined)
    || (providerID && modelID ? `${providerID}/${modelID}` : undefined)
    || items[0]?.value
  if (candidate) model.value = candidate
}, { immediate: true })

watch([model, agent, variant, mcpMode, disabledServers, disabledTools, forcedTools], () => {
  localStorage.setItem(prefsKey.value, JSON.stringify({
    model: model.value,
    agent: agent.value,
    variant: variant.value,
    mcpMode: mcpMode.value,
    disabledServers: disabledServers.value,
    disabledTools: disabledTools.value,
    forcedTools: forcedTools.value
  }))
}, { deep: true })

function toggleServer(name: string, enabled: boolean) {
  disabledServers.value = enabled
    ? disabledServers.value.filter((s) => s !== name)
    : [...new Set([...disabledServers.value, name])]
}

function setAllServers(enabled: boolean) {
  disabledServers.value = enabled ? [] : props.mcpInfo.map((s) => s.name)
}

// per-prompt tool mode: inherit (project default) / deny / allow
function toolChatMode(id: string): 'inherit' | 'deny' | 'ask' | 'allow' {
  if (disabledTools.value.includes(id)) return 'deny'
  if (forcedTools.value.includes(id)) return 'allow'
  return 'inherit'
}

function setToolChatMode(id: string, mode: 'inherit' | 'deny' | 'ask' | 'allow') {
  disabledTools.value = disabledTools.value.filter((t) => t !== id)
  forcedTools.value = forcedTools.value.filter((t) => t !== id)
  if (mode === 'deny') disabledTools.value = [...disabledTools.value, id]
  else if (mode === 'allow') forcedTools.value = [...forcedTools.value, id]
}

function toggleTool(id: string, enabled: boolean) {
  disabledTools.value = enabled
    ? disabledTools.value.filter((t) => t !== id)
    : [...new Set([...disabledTools.value, id])]
}

// ---- saved MCP groups: named sets of the current enable/disable selection ----
interface McpGroup { name: string; disabledServers: string[]; disabledTools: string[] }
const groupsKey = computed(() => `opencode-web.mcp-groups.${props.directory}`)
const groups = ref<McpGroup[]>([])
const groupName = ref('')
const activeGroup = ref('')

onMounted(() => {
  try {
    groups.value = JSON.parse(localStorage.getItem(groupsKey.value) || '[]')
  } catch { groups.value = [] }
})

function persistGroups() {
  localStorage.setItem(groupsKey.value, JSON.stringify(groups.value))
}

function saveGroup() {
  const name = groupName.value.trim()
  if (!name) return
  const group: McpGroup = {
    name,
    disabledServers: [...disabledServers.value],
    disabledTools: [...disabledTools.value]
  }
  const idx = groups.value.findIndex((g) => g.name === name)
  if (idx >= 0) groups.value.splice(idx, 1, group)
  else groups.value.push(group)
  persistGroups()
  activeGroup.value = name
  groupName.value = ''
}

function applyGroup(name: string) {
  const group = groups.value.find((g) => g.name === name)
  if (!group) return
  disabledServers.value = [...group.disabledServers]
  disabledTools.value = [...group.disabledTools]
  activeGroup.value = name
}

function deleteGroup(name: string) {
  groups.value = groups.value.filter((g) => g.name !== name)
  if (activeGroup.value === name) activeGroup.value = ''
  persistGroups()
}

// manual changes deviate from the applied group
watch([disabledServers, disabledTools], () => {
  const group = groups.value.find((g) => g.name === activeGroup.value)
  if (!group) return
  const same =
    JSON.stringify([...group.disabledServers].sort()) === JSON.stringify([...disabledServers.value].sort()) &&
    JSON.stringify([...group.disabledTools].sort()) === JSON.stringify([...disabledTools.value].sort())
  if (!same) activeGroup.value = ''
}, { deep: true })

function send() {
  const value = text.value.trim()
  if (!value && !attachments.value.length) return

  // MCP mode → per-prompt tool filter
  let tools: Record<string, boolean> | undefined
  if (mcpMode.value !== DEFAULT && props.mcpInfo.length) {
    tools = {}
    for (const server of props.mcpInfo) {
      const serverOff =
        mcpMode.value === 'none' ||
        (mcpMode.value === 'custom' && disabledServers.value.includes(server.name))
      if (serverOff) {
        tools[`${server.name}*`] = false
        tools[`${server.name}_*`] = false
      } else if (mcpMode.value === 'all') {
        tools[`${server.name}*`] = true
        tools[`${server.name}_*`] = true
      } else {
        for (const tool of server.tools) {
          if (disabledTools.value.includes(tool.id)) tools[tool.id] = false
          else if (forcedTools.value.includes(tool.id)) tools[tool.id] = true
        }
      }
    }
    if (Object.keys(tools).length === 0) tools = undefined
  }

  const [providerID, ...rest] = model.value.split('/')
  const modelID = rest.join('/')
  // shell and slash commands carry no mentions
  const mentioned = /^[!/]/.test(value) ? [] : mentionParts(value, picked.value, props.directory)
  rememberHistory(value)
  emit('send', {
    text: value,
    model: providerID && modelID ? { providerID, modelID } : undefined,
    agent: agent.value !== DEFAULT ? agent.value : undefined,
    variant: variant.value !== DEFAULT && selectedModel.value?.reasoning ? variant.value : undefined,
    tools,
    files: attachments.value.length
      ? attachments.value.map(({ mime, filename, url }) => ({ mime, filename, url }))
      : undefined,
    parts: mentioned.length ? mentioned : undefined
  })
  text.value = ''
  attachments.value = []
  picked.value = []
}

// ---- attachments (sent as opencode file parts, data URLs) ----
// from the paperclip, pasted (screenshots, copied files) or dropped on the chat
const attachments = ref<Array<{ mime: string; filename: string; url: string; size: number }>>([])
const fileInput = ref<HTMLInputElement>()
const MAX_FILE = 10 * 1024 * 1024

function pickFiles() {
  fileInput.value?.click()
}

function fmtSize(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** Read files into attachments; pasted screenshots get a readable name. */
function addFiles(files: Iterable<File>) {
  const tooBig: string[] = []
  for (const file of files) {
    if (file.size > MAX_FILE) {
      tooBig.push(file.name)
      continue
    }
    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '-')
    const filename = file.name && file.name !== 'image.png'
      ? file.name
      : `pasted ${stamp}.${(file.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`
    const reader = new FileReader()
    reader.onload = () => {
      attachments.value.push({ mime: file.type || 'application/octet-stream', filename, url: String(reader.result), size: file.size })
    }
    reader.readAsDataURL(file)
  }
  if (tooBig.length) {
    toast.add({ title: `Too large to attach (max ${fmtSize(MAX_FILE)})`, description: tooBig.join(', '), color: 'warning' })
  }
}

function onFiles(e: Event) {
  const input = e.target as HTMLInputElement
  addFiles(Array.from(input.files || []))
  input.value = ''
}

// a pasted screenshot or copied file becomes an attachment; pasted text
// still lands in the input as usual
function onPaste(e: ClipboardEvent) {
  const files = Array.from(e.clipboardData?.files || [])
  if (!files.length) return
  if (!e.clipboardData?.getData('text/plain')) e.preventDefault()
  addFiles(files)
}

const isImage = (mime: string) => mime.startsWith('image/')
const preview = ref<{ url: string; filename: string } | null>(null)

defineExpose({ addFiles })

// ---- slash-command autocomplete ----
const slashMatches = computed(() => {
  const value = text.value
  if (!value.startsWith('/') || value.includes('\n')) return []
  const firstToken = value.slice(1).split(' ')[0] || ''
  if (value.includes(' ')) return [] // command chosen, user is typing arguments
  return (props.commands || [])
    .filter((c) => c.name.toLowerCase().startsWith(firstToken.toLowerCase()))
    .slice(0, 8)
})

function pickCommand(name: string) {
  text.value = `/${name} `
  ;(document.activeElement as HTMLElement)?.blur?.()
}

watch(() => props.seed, (seed) => {
  if (seed?.text) {
    text.value = seed.text
    nextTick(() => (document.querySelector('textarea') as HTMLTextAreaElement | null)?.focus())
  }
})

// ---- `@` mentions: files, folders and agents (like opencode's TUI) ----
const inputRef = ref<{ $el?: HTMLElement } | null>(null)
const caret = ref(0)
const picked = ref<PickedMention[]>([])
const dismissedAt = ref<number | null>(null)
const activeMention = ref(0)
const { files: fileHits, loading: filesLoading, search: searchFiles } = useMentionSearch(() => props.directory)

function textareaEl() {
  return inputRef.value?.$el?.querySelector('textarea') as HTMLTextAreaElement | null
}
function syncCaret() {
  caret.value = textareaEl()?.selectionStart ?? text.value.length
}
watch(text, () => nextTick(syncCaret))

const mentionToken = computed(() => {
  if (slashMatches.value.length || text.value.startsWith('!')) return null
  const token = mentionAt(text.value, caret.value)
  return token && dismissedAt.value !== token.start ? token : null
})
watch(() => mentionToken.value?.query ?? null, (query) => searchFiles(query))

const mentionItems = computed<MentionItem[]>(() => {
  const token = mentionToken.value
  if (!token) return []
  return [...agentMatches(props.agents, token.query), ...fileHits.value].slice(0, 12)
})
const mentionOpen = computed(() => Boolean(mentionToken.value) && (mentionItems.value.length > 0 || filesLoading.value))
watch(mentionItems, () => { activeMention.value = 0 })

function pickMention(item: MentionItem) {
  const token = mentionToken.value
  if (!token) return
  const next = applyMention(text.value, token, item.value)
  text.value = next.text
  if (!picked.value.some((m) => m.kind === item.kind && m.value === item.value)) {
    picked.value = [...picked.value, { kind: item.kind, value: item.value }]
  }
  nextTick(() => {
    const el = textareaEl()
    el?.focus()
    el?.setSelectionRange(next.caret, next.caret)
    caret.value = next.caret
  })
}

const mentionIcon = (kind: MentionItem['kind']) =>
  kind === 'agent' ? 'i-lucide-bot' : kind === 'folder' ? 'i-lucide-folder' : 'i-lucide-file'

// `!` at the start: shell mode, like opencode
const shellMode = computed(() => text.value.startsWith('!'))

// ---- phones: the on-screen keyboard is up while the input has focus ----
// the model/think/agent row and the options panel step aside so the
// conversation keeps its room; they come back once the keyboard closes
const coarsePointer = ref(false)
const inputFocused = ref(false)
let blurTimer: ReturnType<typeof setTimeout> | undefined
onMounted(() => {
  const mq = window.matchMedia('(pointer: coarse)')
  coarsePointer.value = mq.matches
  mq.addEventListener?.('change', (e) => { coarsePointer.value = e.matches })
})
function onFocus() {
  clearTimeout(blurTimer)
  inputFocused.value = true
}
// delayed: a tap on Send blurs the input first, and the row reappearing at
// once would move the button away from the finger
function onBlur() {
  clearTimeout(blurTimer)
  blurTimer = setTimeout(() => { inputFocused.value = false }, 250)
}
onBeforeUnmount(() => clearTimeout(blurTimer))
const keyboardOpen = computed(() => coarsePointer.value && inputFocused.value)

// ---- terminal-like keys ----
// Tab / Shift+Tab cycle the primary agents (like opencode's TUI), up/down walk
// through earlier prompts, Esc twice stops a running reply
const agentFlash = ref(0)
function cycleAgent(step: 1 | -1) {
  const values = agentItems.value.map((a) => a.value)
  if (values.length < 2) return
  const i = Math.max(0, values.indexOf(agent.value))
  agent.value = values[(i + step + values.length) % values.length]!
  agentFlash.value++
}

const historyKey = computed(() => `opencode-web.history.${props.directory}`)
const history = ref<string[]>([])
const historyIndex = ref(-1)
let historyDraft = ''
onMounted(() => {
  try { history.value = JSON.parse(localStorage.getItem(historyKey.value) || '[]') } catch { history.value = [] }
})
function rememberHistory(value: string) {
  history.value = [value, ...history.value.filter((h) => h !== value)].slice(0, 100)
  historyIndex.value = -1
  try { localStorage.setItem(historyKey.value, JSON.stringify(history.value)) } catch { /* full */ }
}
function walkHistory(step: 1 | -1) {
  const next = historyIndex.value + step
  if (next < -1 || next >= history.value.length) return false
  if (historyIndex.value === -1) historyDraft = text.value
  historyIndex.value = next
  text.value = next === -1 ? historyDraft : history.value[next]!
  nextTick(() => textareaEl()?.setSelectionRange(text.value.length, text.value.length))
  return true
}
watch(text, (value) => {
  if (historyIndex.value >= 0 && value !== history.value[historyIndex.value]) historyIndex.value = -1
})

const stopArmed = ref(false)
let stopTimer: ReturnType<typeof setTimeout> | undefined
onBeforeUnmount(() => clearTimeout(stopTimer))

const projectBase = computed(() => `/p/${encodeDir(props.directory)}`)
const help = computed(() => ({
  model: {
    title: 'Model',
    text: [
      'The AI model that writes the reply. Every message can use a different one; the choice is remembered per project.',
      '',
      '- **ctx**: how much text (in thousands of tokens) the model can keep in mind at once.',
      '- **$in/$out**: list price per million input / output tokens. `free` models cost nothing.',
      '- The brain icon marks models that can *think* before answering (see Think level).',
      '',
      'Models come from the providers configured in opencode. Add a provider (API key) to get more.'
    ].join('\n'),
    actions: [
      { label: 'Configure providers', icon: 'i-lucide-plug', onClick: () => { providersOpen.value = true } },
      { label: 'Usage & cost', icon: 'i-lucide-chart-column', to: `${projectBase.value}/stats` }
    ]
  },
  think: {
    title: 'Think level',
    text: [
      'How much the model reasons before it answers (only for models with thinking support).',
      '',
      '- **default**: what the model or opencode config uses.',
      '- **none / low**: fast and cheap, good for small edits and questions.',
      '- **medium / high**: better plans and fewer mistakes on harder tasks.',
      '- **max**: the most reasoning the model allows: slowest and most expensive.',
      '',
      'Thinking tokens are billed as output tokens.'
    ].join('\n'),
    actions: [{ label: 'Usage & cost', icon: 'i-lucide-chart-column', to: `${projectBase.value}/stats` }]
  },
  agent: {
    title: 'Agent',
    text: [
      'The agent decides how the model works: its instructions, which tools it may use and which MCP servers it sees.',
      '',
      '- **build**: the default, can edit files and run commands.',
      '- **plan**: read-only, for exploring and planning.',
      '- **orchestrator** (Subagent per MCP): delegates MCP work to one specialist subagent per server.',
      '',
      'Press **Tab** in the input to switch agents. Subagents can be called with **@name**.',
      '',
      'Agents can also load **skills**: instructions for specific tasks, used when their description matches (`/skills` lists them).'
    ].join('\n'),
    actions: [
      { label: 'Skills', icon: 'i-lucide-graduation-cap', to: `${projectBase.value}/skills` },
      { label: 'Edit agents', icon: 'i-lucide-bot', to: `${projectBase.value}/agents` }
    ]
  },
  mcp: {
    title: 'MCP for this chat',
    text: [
      'MCP servers give the agent extra tools (Home Assistant, browsers, docs...). Here you choose which ones this chat may use, without changing the project settings:',
      '',
      '- **project default**: what the MCP page configured.',
      '- **all enabled / all disabled**: every server on or off for these messages.',
      '- **custom**: pick servers and single tools; save the selection as a preset.',
      '',
      'Adding servers, fixing broken ones and the default modes live on the MCP page.'
    ].join('\n'),
    actions: [{ label: 'MCP servers', icon: 'i-lucide-server-cog', to: `${projectBase.value}/mcp` }]
  }
}))

const keysHelp = [
  '| Key | Does |',
  '| --- | --- |',
  '| `Enter` | send (queued while the agent works) |',
  '| `Shift+Enter` | new line |',
  '| `Tab` / `Shift+Tab` | next / previous agent (when no list is open) |',
  '| `Up` / `Down` | earlier prompts (at the start / end of the input) |',
  '| `Esc` `Esc` | stop the running reply |',
  '| `/` | commands: `/reload`, `/mcp`, `/compact`, `/undo`... |',
  '| `@` | mention files, folders and agents |',
  '| `!` | run a shell command in the project |',
  '| `Ctrl+K` | search everything |',
  '',
  'Paste a screenshot, or drop files anywhere on the chat, to attach them.'
].join('\n')

function onKeydown(e: KeyboardEvent) {
  if (mentionOpen.value && mentionItems.value.length) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const n = mentionItems.value.length
      activeMention.value = (activeMention.value + (e.key === 'ArrowDown' ? 1 : n - 1)) % n
      return
    }
    if ((e.key === 'Enter' && !e.shiftKey && !e.isComposing) || e.key === 'Tab') {
      e.preventDefault()
      pickMention(mentionItems.value[activeMention.value]!)
      return
    }
  }
  if (e.key === 'Escape' && mentionToken.value) {
    e.preventDefault()
    dismissedAt.value = mentionToken.value.start
    return
  }
  if (e.key === 'Tab' && slashMatches.value.length) {
    e.preventDefault()
    pickCommand(slashMatches.value[0]!.name)
    return
  }
  if (e.key === 'Tab' && !e.altKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault()
    cycleAgent(e.shiftKey ? -1 : 1)
    return
  }
  if (e.key === 'Escape' && props.busy) {
    e.preventDefault()
    clearTimeout(stopTimer)
    if (stopArmed.value) {
      stopArmed.value = false
      emit('abort')
    } else {
      stopArmed.value = true
      stopTimer = setTimeout(() => { stopArmed.value = false }, 2000)
    }
    return
  }
  const el = e.target as HTMLTextAreaElement
  if (e.key === 'ArrowUp' && !e.shiftKey && el.selectionStart === 0 && el.selectionEnd === 0 && walkHistory(1)) {
    e.preventDefault()
    return
  }
  if (e.key === 'ArrowDown' && !e.shiftKey && historyIndex.value >= 0 && el.selectionStart === text.value.length && walkHistory(-1)) {
    e.preventDefault()
    return
  }
  // `repeat`: a held Enter fires keydown again and again - one send is enough
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !e.repeat) {
    e.preventDefault()
    send()
  }
}
</script>

<template>
  <!-- flex column that may shrink (min-h-0): when the keyboard leaves little
       room only the options panel gives way and scrolls, so the input and
       the Send row always stay on screen -->
  <div class="bg-muted px-3 sm:px-4 py-2 sm:py-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] flex flex-col min-h-0">
    <div class="max-w-(--oc-chat-max,56rem) w-full mx-auto space-y-2 relative flex flex-col min-h-0">
      <!-- slash command autocomplete -->
      <CollapseTransition>
        <div
          v-if="slashMatches.length"
          class="absolute bottom-full left-0 right-0 mb-1 rounded-sm bg-elevated shadow-lg divide-y divide-default max-h-64 overflow-y-auto z-20"
        >
          <button
            v-for="cmd in slashMatches"
            :key="cmd.name"
            class="oc-row flex w-full items-baseline gap-2 px-3 py-1.5 text-left hover:bg-accented cursor-pointer"
            @mousedown.prevent="pickCommand(cmd.name)"
          >
            <span class="font-mono text-sm text-highlighted">/{{ cmd.name }}</span>
            <span class="text-xs text-dimmed truncate">{{ cmd.description }}</span>
          </button>
          <div class="px-3 py-1 text-[10px] text-dimmed">Tab completes · `!command` runs shell · `@` mentions files and agents</div>
        </div>
      </CollapseTransition>
      <!-- @ mentions: agents, files and folders -->
      <CollapseTransition>
        <div
          v-if="mentionOpen"
          role="listbox"
          aria-label="Mention a file, folder or agent"
          class="absolute bottom-full left-0 right-0 mb-1 rounded-sm bg-elevated shadow-lg divide-y divide-default max-h-72 overflow-y-auto z-20"
        >
          <button
            v-for="(item, i) in mentionItems"
            :key="`${item.kind}:${item.value}`"
            role="option"
            :aria-selected="i === activeMention"
            class="oc-row flex w-full items-center gap-2 px-3 py-1.5 pointer-coarse:py-2.5 text-left cursor-pointer"
            :class="i === activeMention ? 'bg-accented' : 'hover:bg-accented'"
            @mousedown.prevent="pickMention(item)"
            @mouseenter="activeMention = i"
          >
            <UIcon :name="mentionIcon(item.kind)" class="size-3.5 shrink-0" :class="item.kind === 'agent' ? 'text-primary' : 'text-dimmed'" />
            <span class="font-mono text-sm text-highlighted shrink-0">@{{ item.kind === 'agent' ? item.value : item.label }}</span>
            <span class="text-xs text-dimmed truncate">{{ item.kind === 'agent' ? (item.detail || 'subagent') : item.detail }}</span>
          </button>
          <div v-if="filesLoading && !fileHits.length" class="flex items-center gap-2 px-3 py-1.5 text-xs text-dimmed">
            <UIcon name="i-lucide-loader-circle" class="size-3.5 animate-spin" /> Searching files…
          </div>
          <div class="px-3 py-1 text-[10px] text-dimmed">↑↓ choose · Enter/Tab insert · Esc close · files are read into the context, agents get the task</div>
        </div>
      </CollapseTransition>
      <!-- ! shell mode -->
      <CollapseTransition>
        <div
          v-if="shellMode"
          class="absolute bottom-full left-0 mb-1 flex items-center gap-1.5 rounded-sm bg-elevated shadow px-2.5 py-1 text-[11px] z-10"
          :class="caps.shell ? 'text-muted' : 'text-error'"
        >
          <UIcon name="i-lucide-square-terminal" class="size-3.5" />
          {{ caps.shell ? 'Shell mode: runs the command in the project folder' : 'Shell commands are not available on this server' }}
        </div>
      </CollapseTransition>
      <UTextarea
        ref="inputRef"
        v-model="text"
        :rows="2"
        autoresize
        :maxrows="10"
        placeholder="Ask opencode… (Enter to send, Shift+Enter for newline, @ to mention)"
        class="w-full font-mono shrink-0"
        variant="soft"
        size="lg"
        @keydown="onKeydown"
        @keyup="syncCaret"
        @click="syncCaret"
        @focus="onFocus"
        @blur="onBlur"
        @paste="onPaste"
      />

      <!-- collapsible options; the only part of the box that shrinks and
           scrolls, so the on-screen keyboard never pushes Send off-screen -->
      <CollapseTransition>
      <div v-if="optionsOpen && !keyboardOpen" class="space-y-2 min-h-0 max-h-[65dvh] overflow-y-auto overscroll-contain sm:max-h-none">
        <!-- one row on wide screens: model / think / agent -->
        <!-- phones pair think level + agent so the panel stays short -->
        <div class="grid grid-cols-2 sm:flex sm:flex-row gap-1.5">
          <UFormField size="xs" class="col-span-2 flex-1 min-w-0">
            <template #label>
              <span class="inline-flex items-center gap-1">Model <HelpTip v-bind="help.model" /></span>
            </template>
            <div class="flex gap-1">
              <ModelSelect v-model="model" :items="modelItems" :loading="metaLoading">
                <template #bottom>
                  <button
                    class="flex items-center gap-2 px-2.5 py-2 text-sm text-highlighted bg-elevated hover:bg-accented cursor-pointer"
                    :class="modelItems.length > 10 ? 'border-l border-default' : 'flex-1'"
                    @mousedown.prevent="providersOpen = true"
                  >
                    <UIcon name="i-lucide-settings-2" class="size-4 shrink-0" />
                    Configure providers…
                  </button>
                </template>
              </ModelSelect>
              <UTooltip text="Configure providers">
                <UButton
                  color="neutral"
                  variant="soft"
                  size="sm"
                  icon="i-lucide-plug"
                  class="oc-tap"
                  aria-label="Configure providers"
                  @click="providersOpen = true"
                />
              </UTooltip>
            </div>
          </UFormField>
          <UFormField size="xs" class="min-w-0 sm:w-36 shrink-0">
            <template #label>
              <span class="inline-flex items-center gap-1">Think level <HelpTip v-bind="help.think" /></span>
            </template>
            <UTooltip
              :text="selectedModel && !selectedModel.reasoning ? 'This model has no thinking support' : undefined"
              :disabled="!selectedModel || selectedModel.reasoning"
            >
              <USelect
                v-model="variant"
                :items="variantItems"
                value-key="value"
                :disabled="Boolean(selectedModel && !selectedModel.reasoning)"
                size="sm"
                class="w-full"
                icon="i-lucide-brain"
              />
            </UTooltip>
          </UFormField>
          <UFormField size="xs" class="min-w-0 sm:w-40 shrink-0">
            <template #label>
              <span class="inline-flex items-center gap-1">Agent <HelpTip v-bind="help.agent" /></span>
            </template>
            <USelectMenu
              v-model="agentModel"
              :items="agentItems"
              value-key="value"
              :search-input="agentItems.length > 10 ? { placeholder: 'Search agents…' } : false"
              :loading="metaLoading"
              size="sm"
              class="w-full"
              icon="i-lucide-bot"
              :ui="{ content: 'max-h-[min(24rem,60dvh)] min-w-56' }"
            >
              <template #item-label="{ item }">
                <span class="block truncate">{{ item.label }}</span>
                <span v-if="item.description" class="block text-[10px] text-dimmed truncate">{{ item.description }}</span>
              </template>
              <template v-if="agentPickerItems.length > 10" #content-bottom>
                <button
                  class="flex w-full items-center gap-2 px-2.5 py-2 text-sm text-highlighted bg-elevated hover:bg-accented cursor-pointer"
                  @mousedown.prevent="agentPickerOpen = true"
                >
                  <UIcon name="i-lucide-layout-grid" class="size-4 shrink-0" />
                  Show all {{ agentPickerItems.length }} agents…
                </button>
              </template>
            </USelectMenu>
          </UFormField>

          <!-- MCP shares the same row -->
          <UFormField v-if="caps.mcp" size="xs" class="col-span-2 sm:w-44 shrink-0">
            <template #label>
              <span class="inline-flex items-center gap-1">MCP <HelpTip v-bind="help.mcp" /></span>
            </template>
            <USelect
              v-if="mcpLoading"
              disabled
              loading
              :items="[]"
              placeholder="Loading…"
              size="sm"
              class="w-full"
              icon="i-lucide-server"
            />
            <UButton
              v-else-if="!mcpInfo.length"
              size="sm"
              block
              variant="soft"
              color="neutral"
              icon="i-lucide-server-cog"
              label="Configure MCP"
              :to="`/p/${encodeDir(directory)}/mcp`"
            />
            <USelect
              v-else
              v-model="mcpMode"
              :items="mcpModeItems"
              value-key="value"
              size="sm"
              class="w-full"
              icon="i-lucide-server"
            />
          </UFormField>
        </div>

        <!-- custom MCP selection: one compact header row (filter + presets),
             then the table-like server list -->
        <CollapseTransition>
        <div v-if="caps.mcp && (mcpInfo.length || mcpLoading) && mcpMode === 'custom'">
          <McpServerList
            :servers="mcpInfo"
            :loading="mcpLoading"
            header-class="justify-end"
            :server-mode="(n) => disabledServers.includes(n) ? 'off' : 'allow'"
            :tool-mode="toolChatMode"
            :settings-to="`/p/${encodeDir(directory)}/mcp`"
            ask-disabled
            @set-server="(n, m) => toggleServer(n, m !== 'off')"
            @set-tool="setToolChatMode"
          >
            <template #actions>
              <UTooltip text="Enable every server">
                <UButton
                  size="xs"
                  variant="soft"
                  color="neutral"
                  icon="i-lucide-circle-check"
                  class="oc-tap"
                  aria-label="Enable every server"
                  @click="setAllServers(true)"
                />
              </UTooltip>
              <UTooltip text="Disable every server">
                <UButton
                  size="xs"
                  variant="soft"
                  color="neutral"
                  icon="i-lucide-circle-slash"
                  class="oc-tap"
                  aria-label="Disable every server"
                  @click="setAllServers(false)"
                />
              </UTooltip>
              <!-- saved presets: apply with one click, save the current selection -->
              <div v-for="g in groups" :key="g.name" class="flex items-center rounded-sm overflow-hidden">
                <UButton
                  size="xs"
                  :variant="activeGroup === g.name ? 'solid' : 'soft'"
                  :color="activeGroup === g.name ? 'primary' : 'neutral'"
                  icon="i-lucide-layers"
                  :label="g.name"
                  class="oc-tap rounded-r-none"
                  @click="applyGroup(g.name)"
                />
                <UButton
                  size="xs"
                  variant="soft"
                  color="neutral"
                  icon="i-lucide-x"
                  class="oc-tap rounded-l-none"
                  :aria-label="`Delete preset ${g.name}`"
                  @click="deleteGroup(g.name)"
                />
              </div>
              <UInput
                v-model="groupName"
                size="xs"
                placeholder="Save as…"
                class="w-24 font-mono"
                @keydown.enter="saveGroup"
              />
              <UButton
                size="xs"
                variant="soft"
                color="neutral"
                icon="i-lucide-save"
                class="oc-tap"
                :disabled="!groupName.trim()"
                aria-label="Save preset"
                @click="saveGroup"
              />
            </template>
          </McpServerList>
        </div>
        </CollapseTransition>
      </div>
      </CollapseTransition>

      <!-- attachment chips -->
      <CollapseTransition>
      <div v-if="attachments.length" class="flex flex-wrap items-end gap-1.5 shrink-0">
        <div
          v-for="(file, i) in attachments"
          :key="`${file.filename}-${i}`"
          class="oc-appear group/att relative flex items-center gap-1.5 rounded-sm bg-elevated max-w-56"
          :class="isImage(file.mime) ? 'p-0.5' : 'pl-2 pr-1 py-1'"
          :title="`${file.filename} · ${fmtSize(file.size)}`"
        >
          <button
            v-if="isImage(file.mime)"
            type="button"
            class="block cursor-zoom-in"
            :aria-label="`Preview ${file.filename}`"
            @click="preview = { url: file.url, filename: file.filename }"
          >
            <img :src="file.url" :alt="file.filename" class="h-14 w-auto max-w-40 rounded-sm object-cover">
          </button>
          <template v-else>
            <UIcon :name="file.mime === 'application/pdf' ? 'i-lucide-file-text' : 'i-lucide-paperclip'" class="size-3.5 shrink-0 text-dimmed" />
            <span class="text-[11px] font-mono truncate">{{ file.filename }}</span>
            <span class="text-[10px] text-dimmed shrink-0">{{ fmtSize(file.size) }}</span>
          </template>
          <button
            class="cursor-pointer hover:text-error"
            :class="isImage(file.mime) ? 'absolute -top-1.5 -right-1.5 size-5 rounded-full bg-accented flex items-center justify-center shadow oc-tap-zone' : 'relative oc-tap-zone'"
            :aria-label="`Remove ${file.filename}`"
            @click="attachments.splice(i, 1)"
          >
            <UIcon name="i-lucide-x" class="size-3" />
          </button>
        </div>
      </div>
      </CollapseTransition>

      <div class="flex items-center gap-1.5 min-w-0 shrink-0">
        <input
          ref="fileInput"
          type="file"
          multiple
          accept="image/*,application/pdf,text/*,.md,.json,.csv,.log,.yaml,.yml,.xml,.html,.ts,.js,.py"
          class="hidden"
          @change="onFiles"
        >
        <UTooltip text="Attach files (or paste / drop them)">
          <UButton
            color="neutral"
            variant="ghost"
            size="xs"
            icon="i-lucide-paperclip"
            class="oc-tap"
            aria-label="Attach files"
            @click="pickFiles"
          />
        </UTooltip>
        <Transition name="oc-fade">
        <div v-show="!keyboardOpen" data-testid="prompt-config" class="flex items-center gap-1.5 min-w-0">
        <UTooltip :text="optionsOpen ? 'Hide options' : 'Model, think level, agent & MCP options'">
          <UButton
            color="neutral"
            :variant="optionsOpen ? 'soft' : 'ghost'"
            size="xs"
            :icon="optionsOpen ? 'i-lucide-chevron-down' : 'i-lucide-sliders-horizontal'"
            class="oc-tap"
            :aria-label="optionsOpen ? 'Hide options' : 'Show model, think level, agent and MCP options'"
            @click="optionsOpen = !optionsOpen"
          />
        </UTooltip>
        <button
          class="flex items-center gap-2 min-w-0 text-[11px] font-mono text-dimmed hover:text-muted cursor-pointer pointer-coarse:min-h-10"
          @click="optionsOpen = !optionsOpen"
        >
          <span class="flex items-center gap-1 min-w-0">
            <UIcon name="i-lucide-cpu" class="size-3 shrink-0" />
            <span class="truncate max-w-28 sm:max-w-64">
              {{ selectedModel?.label || 'model' }}<template v-if="selectedModel?.provider"> · {{ selectedModel.provider }}</template>
            </span>
          </span>
          <span v-if="selectedModel?.reasoning" class="flex items-center gap-1 shrink-0">
            <UIcon name="i-lucide-brain" class="size-3" />
            {{ variantLabel }}
          </span>
          <span
            :key="agentFlash"
            class="flex items-center gap-1 shrink-0 rounded-sm px-1"
            :class="[agent !== DEFAULT ? 'text-muted bg-elevated' : 'hidden sm:flex', agentFlash ? 'oc-flash' : '']"
            title="Tab switches the agent"
          >
            <UIcon name="i-lucide-bot" class="size-3" />
            {{ agent === DEFAULT ? 'default' : agent }}
          </span>
          <span v-if="mcpLoading" class="hidden sm:flex items-center gap-1 shrink-0">
            <UIcon name="i-lucide-loader-circle" class="size-3 animate-spin" />
            mcp
          </span>
          <span
            v-else-if="mcpSummary && mcpInfo.length"
            class="hidden sm:flex items-center gap-1 shrink-0"
          >
            <UIcon name="i-lucide-server" class="size-3" />
            {{ mcpSummary }} mcp
          </span>
        </button>
        </div>
        </Transition>
        <span class="flex-1" />
        <Transition name="oc-fade">
          <span v-if="stopArmed" class="text-[11px] text-warning shrink-0">Esc again to stop</span>
        </Transition>
        <span class="hidden pointer-fine:inline-flex shrink-0">
          <HelpTip title="Keyboard & input" :text="keysHelp" />
        </span>
        <UBadge v-if="queueLength" color="neutral" variant="subtle" size="sm">
          {{ queueLength }} queued
        </UBadge>
        <Transition name="oc-swap">
          <UButton
            v-if="busy"
            color="error"
            variant="soft"
            size="xs"
            icon="i-lucide-square"
            label="Stop"
            class="oc-tap shrink-0"
            @click="emit('abort')"
          />
        </Transition>
        <Transition name="oc-swap" mode="out-in">
          <UButton
            :key="busy ? 'queue' : 'send'"
            :color="busy ? 'neutral' : 'primary'"
            :variant="busy ? 'soft' : 'solid'"
            size="xs"
            :icon="busy ? 'i-lucide-list-plus' : 'i-lucide-send'"
            :label="busy ? 'Queue' : 'Send'"
            class="oc-tap shrink-0 pointer-coarse:px-3"
            :disabled="!text.trim() && !attachments.length"
            @click="send"
          />
        </Transition>
      </div>
    </div>

    <PickerModal
      v-model:open="agentPickerOpen"
      v-model="agentModel"
      :items="agentPickerItems"
      title="Choose an agent"
      description="Primary agents run the chat; subagents are inserted as an @mention."
      placeholder="Search agents…"
    />
    <UModal :open="Boolean(preview)" :title="preview?.filename" :ui="{ content: 'sm:max-w-4xl' }" @update:open="(v: boolean) => { if (!v) preview = null }">
      <template #body>
        <img v-if="preview" :src="preview.url" :alt="preview.filename" class="max-h-[70dvh] mx-auto rounded-sm">
      </template>
    </UModal>
    <ProvidersModal
      v-model:open="providersOpen"
      :providers="providers"
      :directory="directory"
      :loading="metaLoading"
      @saved="emit('refreshProviders')"
    />
  </div>
</template>
