<script setup lang="ts">
import type { AgentInfo, McpStatus } from '#shared/types/opencode'

const route = useRoute()
const caps = useCapabilities()
const directory = computed(() => decodeDir(route.params.dir as string))
const api = useOpencodeApi(directory)
const toast = useToast()
const catalog = useModelCatalog(directory)

type Mode = 'primary' | 'subagent' | 'all'
type McpMode = 'inherit' | 'allow' | 'block'
type Where = 'project' | 'global' | 'built-in' | 'file'

/** One entry of the `agent` map in opencode.json. */
interface AgentConfig {
  description?: string
  mode?: Mode
  model?: string
  prompt?: string
  temperature?: number
  tools?: Record<string, boolean>
  disable?: boolean
  [key: string]: unknown
}

interface AgentRow {
  name: string
  description: string
  mode: Mode
  model: string
  prompt: string
  temperature?: number
  /** effective tool rules: what opencode reports, then the config overrides */
  tools: Record<string, boolean>
  /** the tool rules written in the config itself */
  configTools: Record<string, boolean>
  builtIn: boolean
  managed: boolean
  disabled: boolean
  definedIn: Where[]
  /** written to the config but not loaded by opencode yet */
  pending: boolean
}

// opencode's own agents: editable (only overrides are written), never deletable
const BUILT_IN = ['build', 'plan', 'general', 'explore']
// internal helpers some versions list without a `hidden` flag
const INTERNAL = ['compaction', 'title', 'summary']

const BUILTIN_TOOLS = [
  { id: 'bash', label: 'Run shell commands' },
  { id: 'edit', label: 'Edit files' },
  { id: 'write', label: 'Write new files' },
  { id: 'patch', label: 'Apply patches' },
  { id: 'read', label: 'Read files' },
  { id: 'grep', label: 'Search file contents' },
  { id: 'glob', label: 'Find files by name' },
  { id: 'list', label: 'List folders' },
  { id: 'webfetch', label: 'Fetch web pages' },
  { id: 'websearch', label: 'Search the web' },
  { id: 'todowrite', label: 'Write the todo list' },
  { id: 'todoread', label: 'Read the todo list' },
  { id: 'task', label: 'Invoke subagents (task)' },
  { id: 'skill', label: 'Load skills' }
]

const MODES: Array<{ label: string; value: Mode }> = [
  { label: 'Primary: pick it in the chat', value: 'primary' },
  { label: 'Subagent: other agents delegate to it', value: 'subagent' },
  { label: 'Both', value: 'all' }
]

// ---- raw data ----
const apiAgents = ref<AgentInfo[]>([])
/** `agent` map of the project's merged config (global + project) */
const mergedAgents = ref<Record<string, AgentConfig>>({})
/** `agent` map of the global config alone */
const globalAgents = ref<Record<string, AgentConfig>>({})
const mcpServers = ref<string[]>([])
const managedNames = ref<Set<string>>(new Set())
const nestOrchestrator = ref('orchestrator')
const nestKnown = ref(false)
const loading = ref(true)
const loadError = ref('')

function errorMessage(e: unknown) {
  const data = (e as { data?: { message?: string; data?: { message?: string } } })?.data
  return data?.data?.message || data?.message || (e instanceof Error ? e.message : String(e))
}

const isMap = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

async function refresh() {
  loading.value = true
  loadError.value = ''
  try {
    const [agents, merged, global, status] = await Promise.all([
      api.agents().catch((e) => { loadError.value = errorMessage(e); return [] as AgentInfo[] }),
      api.config().catch(() => ({} as Record<string, unknown>)),
      api.globalConfig().catch(() => ({} as Record<string, unknown>)),
      caps.value.mcp ? api.mcpStatus().catch(() => ({} as Record<string, McpStatus>)) : Promise.resolve({} as Record<string, McpStatus>)
    ])
    apiAgents.value = Array.isArray(agents) ? agents.filter((a) => a && typeof a.name === 'string') : []
    mergedAgents.value = (isMap(merged.agent) ? merged.agent : {}) as Record<string, AgentConfig>
    globalAgents.value = (isMap(global.agent) ? global.agent : {}) as Record<string, AgentConfig>
    const mcpConfig = isMap(merged.mcp) ? merged.mcp : {}
    mcpServers.value = [...new Set([...Object.keys(status || {}), ...Object.keys(mcpConfig)])].sort()
    if (apiAgents.value.length || Object.keys(mergedAgents.value).length) loadError.value = ''
  } finally {
    loading.value = false
  }
}

// the "Subagent per MCP" agents are rewritten by the web app: read-only here.
// Planning the nest can be slow (tool discovery), so it never blocks the list.
interface NestPlan {
  settings?: { enabled?: boolean; orchestrator?: string; lastSync?: { agents?: string[] } }
  servers?: Array<{ agent: string; included?: boolean }>
}
function loadNest() {
  $fetch<NestPlan>('/api/v1/mcp-nest', { timeout: 130_000 })
    .then((plan) => {
      const names = new Set(plan?.settings?.lastSync?.agents || [])
      if (plan?.settings?.orchestrator) nestOrchestrator.value = plan.settings.orchestrator
      if (plan?.settings?.enabled) {
        names.add(nestOrchestrator.value)
        for (const s of plan.servers || []) if (s.included) names.add(s.agent)
      }
      managedNames.value = names
      nestKnown.value = true
    })
    .catch(() => { /* older server or opencode down */ })
}

onMounted(() => {
  refresh()
  loadNest()
  catalog.load()
  try { aiModel.value = localStorage.getItem('opencode-web.ai-model') || '' } catch { /* private mode */ }
})
watch(directory, () => { refresh(); catalog.load() })

// ---- tool rules ----

function globMatch(pattern: string, id: string) {
  const re = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${re}$`).test(id)
}

/** Like opencode's wildcard rules: the most specific (longest) matching key wins. */
function toolOn(tools: Record<string, boolean>, id: string) {
  let on = true
  const keys = Object.keys(tools).sort((a, b) => a.length - b.length || a.localeCompare(b))
  for (const key of keys) if (globMatch(key, id)) on = tools[key] !== false
  return on
}

const ns = (server: string) => server.replace(/[^a-zA-Z0-9_-]/g, '_')

/** Tool rules opencode reports for an agent: a `tools` map, or (newer) a permission ruleset. */
function apiTools(info?: AgentInfo): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  const perm = info?.permission
  if (Array.isArray(perm)) {
    for (const rule of perm as Array<Record<string, unknown>>) {
      if (typeof rule?.permission !== 'string' || (rule.pattern && rule.pattern !== '*')) continue
      out[rule.permission] = rule.action !== 'deny'
    }
  }
  if (isMap(info?.tools)) {
    for (const [k, v] of Object.entries(info!.tools as Record<string, unknown>)) {
      if (typeof v === 'boolean') out[k] = v
    }
  }
  return out
}

// ---- the list ----

const rows = computed<AgentRow[]>(() => {
  const byName = new Map(apiAgents.value.map((a) => [a.name, a]))
  const names = new Set([...byName.keys(), ...Object.keys(mergedAgents.value)])
  const out: AgentRow[] = []
  for (const name of names) {
    const info = byName.get(name)
    const cfg = mergedAgents.value[name] || {}
    const builtIn = BUILT_IN.includes(name) || info?.builtIn === true || info?.native === true
    if (info?.hidden === true || (builtIn && INTERNAL.includes(name))) continue
    const inGlobal = name in globalAgents.value
    const inProject = name in mergedAgents.value
      && (!inGlobal || JSON.stringify(mergedAgents.value[name]) !== JSON.stringify(globalAgents.value[name]))
    const definedIn: Where[] = [
      ...(inProject ? ['project' as const] : []),
      ...(inGlobal ? ['global' as const] : []),
      ...(builtIn ? ['built-in' as const] : [])
    ]
    if (!definedIn.length) definedIn.push('file')
    const apiModel = info?.model?.providerID && info.model.modelID ? `${info.model.providerID}/${info.model.modelID}` : ''
    const apiPrompt = info?.prompt
    const apiTemperature = info?.temperature
    const configTools = (isMap(cfg.tools) ? cfg.tools : {}) as Record<string, boolean>
    const nestLike = name === nestOrchestrator.value || (name.startsWith('mcp-') && configTools['*'] === false)
    const disabled = cfg.disable === true
    out.push({
      name,
      description: String(cfg.description ?? info?.description ?? ''),
      mode: (cfg.mode || info?.mode || 'all') as Mode,
      model: typeof cfg.model === 'string' ? cfg.model : apiModel,
      prompt: typeof cfg.prompt === 'string' ? cfg.prompt : (typeof apiPrompt === 'string' ? apiPrompt : ''),
      temperature: typeof cfg.temperature === 'number' ? cfg.temperature : (typeof apiTemperature === 'number' ? apiTemperature : undefined),
      tools: { ...apiTools(info), ...configTools },
      configTools,
      builtIn,
      managed: managedNames.value.has(name) || (disabled && nestLike && nestKnown.value),
      disabled,
      definedIn,
      pending: !info && !disabled
    })
  }
  return out.sort((a, b) =>
    Number(b.builtIn) - Number(a.builtIn)
    || (a.name === 'build' ? -1 : b.name === 'build' ? 1 : 0)
    || a.name.localeCompare(b.name))
})

const primaryRows = computed(() => rows.value.filter((r) => !r.disabled && r.mode !== 'subagent'))
const subagentRows = computed(() => rows.value.filter((r) => !r.disabled && r.mode === 'subagent'))
const disabledRows = computed(() => rows.value.filter((r) => r.disabled))
const showDisabled = ref(false)
const groups = computed(() => [
  { key: 'primary', title: 'Primary agents', hint: 'pick them in the chat', rows: primaryRows.value },
  { key: 'subagent', title: 'Subagents', hint: 'other agents delegate to them', rows: subagentRows.value }
])

function mcpSummary(row: AgentRow) {
  const total = mcpServers.value.length
  if (!total) return ''
  const allowed = mcpServers.value.filter((s) => toolOn(row.tools, `${ns(s)}_tool`)).length
  if (allowed === total) return 'all MCP'
  if (!allowed) return 'no MCP'
  return `${allowed} of ${total} MCP`
}

const canDelegate = (row: AgentRow) => toolOn(row.tools, 'task')

const whereLabel: Record<Where, string> = { project: 'project config', global: 'global config', 'built-in': 'built-in', file: 'agent file' }
const whereIcon: Record<Where, string> = { project: 'i-lucide-folder-git-2', global: 'i-lucide-globe', 'built-in': 'i-lucide-box', file: 'i-lucide-file-text' }

// ---- saving ----

// scope: where new and edited agents are saved
const scope = ref<'project' | 'global'>('project')

/**
 * Save to a config through the web app, which checks the change took
 * effect: opencode 1.19 writes project changes to a file it never reads,
 * so those land in the global config instead (and the user is told).
 */
async function patchScoped(body: Record<string, unknown>, target: 'project' | 'global' = scope.value) {
  const result = await $fetch<{ scope: 'project' | 'global'; fallback?: boolean }>('/api/v1/config-patch', {
    method: 'POST',
    body: { scope: target, directory: directory.value, patch: body },
    timeout: 60_000
  })
  if (result.fallback) {
    toast.add({
      title: 'Saved in the global config',
      description: 'This opencode version ignores per-project config written through its API, so the change applies to every project.',
      color: 'info'
    })
  }
  return result
}

// agents are read when opencode loads its config: remember per project that a reload is due
const { reload, reloading, menuItems, markPending, pendingFor } = useReload()
const needsReload = computed(() => pendingFor(directory.value).includes('agents'))
const reloadMenu = computed(() => menuItems(directory.value))

function reloadNow() {
  reload({ scope: 'project', directory: directory.value })
}

// any reload (this page's buttons or the menu) loads the saved agents
watch(reloading, (now, before) => {
  if (before && !now) {
    refresh()
  }
})

function savedToast(title: string, where: string) {
  markPending(directory.value, 'agents')
  toast.add({
    title,
    description: `Saved to the ${where} config. Agents change once opencode reloads its config.`,
    color: 'success',
    actions: [{ label: 'Reload now', icon: 'i-lucide-rotate-ccw', onClick: reloadNow }]
  })
}

const toggling = ref('')

/** Enable/disable: the config API cannot delete keys, so "delete" is `disable: true`. */
async function setDisabled(row: AgentRow, disable: boolean) {
  toggling.value = row.name
  try {
    // re-enabling must win over every config that disables it
    const targets = new Set<'project' | 'global'>()
    if (!disable) {
      if (globalAgents.value[row.name]?.disable === true) targets.add('global')
      if (row.definedIn.includes('project')) targets.add('project')
    }
    if (!targets.size) targets.add(scope.value)
    let where = ''
    for (const target of targets) {
      const result = await patchScoped({ agent: { [row.name]: { disable } } }, target)
      where = where ? `${where} and ${result.scope}` : result.scope
    }
    savedToast(`@${row.name} ${disable ? 'disabled' : 'enabled'}`, where)
    await refresh()
    return true
  } catch (e) {
    toast.add({ title: `Could not ${disable ? 'disable' : 'enable'} @${row.name}`, description: errorMessage(e), color: 'error' })
    return false
  } finally {
    toggling.value = ''
  }
}

// ---- editor ----

interface EditorForm {
  name: string
  description: string
  mode: Mode
  model: string
  /** text of the number input (asText() also copes with a number) */
  temperature: string
  prompt: string
  /** effective on/off of the built-in tools */
  tools: Record<string, boolean>
  mcp: Record<string, McpMode>
}

type EditorTab = 'general' | 'prompt' | 'mcp' | 'tools'
const editor = reactive({
  open: false,
  creating: false,
  tab: 'general' as EditorTab,
  row: null as AgentRow | null,
  confirmDisable: false,
  saving: false
})
const form = reactive<EditorForm>({ name: '', description: '', mode: 'all', model: '', temperature: '', prompt: '', tools: {}, mcp: {} })
const initial = shallowRef<EditorForm>(structuredClone(toRaw(form)))
const asText = (v: string | number) => String(v ?? '').trim()

const tabs = computed(() => [
  { label: 'General', value: 'general', icon: 'i-lucide-settings-2' },
  { label: 'Prompt', value: 'prompt', icon: 'i-lucide-scroll-text' },
  {
    label: 'MCP',
    value: 'mcp',
    icon: 'i-lucide-plug',
    badge: mcpServers.value.length ? String(mcpServers.value.filter((s) => mcpAllowed(s)).length) : undefined
  },
  { label: 'Tools', value: 'tools', icon: 'i-lucide-wrench' }
])

function mcpModeOf(tools: Record<string, boolean>, server: string): McpMode {
  const explicit = tools[`${ns(server)}_*`]
  return explicit === true ? 'allow' : explicit === false ? 'block' : 'inherit'
}

/** effective access to a server with the editor's current choices */
function mcpAllowed(server: string) {
  const mode = form.mcp[server]
  if (mode === 'allow') return true
  if (mode === 'block') return false
  const rules = { ...(editor.row?.tools || {}) }
  delete rules[`${ns(server)}_*`]
  return toolOn(rules, `${ns(server)}_tool`)
}

function openEditor(row: AgentRow | null) {
  editor.creating = !row
  editor.row = row
  editor.tab = 'general'
  editor.confirmDisable = false
  const tools = row?.tools || {}
  Object.assign(form, {
    name: row?.name || '',
    description: row?.description || '',
    mode: row?.mode || 'all',
    model: row?.model || '',
    temperature: row?.temperature != null ? String(row.temperature) : '',
    prompt: row?.prompt || '',
    tools: Object.fromEntries(BUILTIN_TOOLS.map((t) => [t.id, toolOn(tools, t.id)])),
    mcp: Object.fromEntries(mcpServers.value.map((s) => [s, mcpModeOf(tools, s)]))
  })
  initial.value = structuredClone(toRaw(form))
  promptUndo.value = null
  editor.open = true
  loadMcpTools()
}

// other rules from the config (globs, single MCP tools): shown, not edited
const otherRules = computed(() => {
  const known = new Set([...BUILTIN_TOOLS.map((t) => t.id), ...mcpServers.value.map((s) => `${ns(s)}_*`)])
  return Object.entries(editor.row?.tools || {}).filter(([k]) => !known.has(k))
})

const NAME_RE = /^[a-z0-9][\w-]*$/
const nameError = computed(() => {
  if (!editor.creating) return ''
  const name = form.name.trim()
  if (!name) return ''
  if (!NAME_RE.test(name)) return 'Lowercase letter or digit first, then letters, digits, "-" or "_".'
  if (name.length > 64) return 'At most 64 characters.'
  const existing = rows.value.find((r) => r.name === name)
  if (existing) return existing.disabled ? 'A disabled agent has this name: enable it instead.' : 'An agent with this name exists.'
  return ''
})

const temperatureError = computed(() => {
  const t = asText(form.temperature)
  if (!t) return ''
  const n = Number(t)
  return Number.isFinite(n) && n >= 0 && n <= 2 ? '' : 'A number from 0 to 2.'
})

// the config API merges and cannot remove keys: a cleared value stays set
const modelCleared = computed(() => !editor.creating && !form.model && Boolean(initial.value.model))
const temperatureCleared = computed(() => !editor.creating && !asText(form.temperature) && Boolean(asText(initial.value.temperature)))
const mcpResetToInherit = computed(() =>
  Object.entries(form.mcp).some(([s, m]) => m === 'inherit' && initial.value.mcp[s] && initial.value.mcp[s] !== 'inherit'))

/** Only what changed (all of it for a new agent): built-ins keep their defaults. */
function buildEntry(): AgentConfig {
  const entry: AgentConfig = {}
  const before = initial.value
  const description = form.description.trim()
  if (description !== before.description.trim()) entry.description = description
  if (editor.creating || form.mode !== before.mode) entry.mode = form.mode
  if (form.model && form.model !== before.model) entry.model = form.model
  const t = asText(form.temperature)
  if (t && t !== asText(before.temperature)) entry.temperature = Number(t)
  if (form.prompt !== before.prompt) entry.prompt = form.prompt
  const tools: Record<string, boolean> = {}
  for (const tool of BUILTIN_TOOLS) {
    if (form.tools[tool.id] !== before.tools[tool.id]) tools[tool.id] = Boolean(form.tools[tool.id])
  }
  for (const [server, mode] of Object.entries(form.mcp)) {
    if (mode === before.mcp[server]) continue
    // back to "inherit": the key cannot be removed, so it becomes the default (allowed)
    tools[`${ns(server)}_*`] = mode !== 'block'
  }
  if (Object.keys(tools).length) entry.tools = tools
  return entry
}

const canSave = computed(() =>
  caps.value.config
  && !nameError.value
  && !temperatureError.value
  && (!editor.creating || Boolean(form.name.trim())))

async function save() {
  if (!canSave.value) return
  const name = editor.creating ? form.name.trim() : editor.row!.name
  const entry = buildEntry()
  if (!Object.keys(entry).length) {
    toast.add({ title: 'Nothing changed', color: 'neutral' })
    editor.open = false
    return
  }
  editor.saving = true
  try {
    const result = await patchScoped({ agent: { [name]: entry } })
    savedToast(editor.creating ? `Created @${name}` : `Saved @${name}`, result.scope)
    editor.open = false
    await refresh()
  } catch (e) {
    toast.add({ title: `Could not save @${name}`, description: errorMessage(e), color: 'error' })
  } finally {
    editor.saving = false
  }
}

async function confirmDisable() {
  if (!editor.row) return
  if (await setDisabled(editor.row, true)) editor.open = false
}

function setAllMcp(mode: McpMode) {
  for (const server of mcpServers.value) form.mcp[server] = mode
}

const MCP_CHOICES: Array<{ value: McpMode; label: string; icon: string }> = [
  { value: 'inherit', label: 'Inherit', icon: 'i-lucide-corner-left-up' },
  { value: 'allow', label: 'Allow', icon: 'i-lucide-check' },
  { value: 'block', label: 'Block', icon: 'i-lucide-ban' }
]

// tool counts per server (optional: discovery can be slow)
const mcpTools = ref<Record<string, { tools?: unknown[] }>>({})
let mcpToolsLoaded = ''
function loadMcpTools() {
  if (!caps.value.mcp || mcpToolsLoaded === directory.value) return
  mcpToolsLoaded = directory.value
  $fetch<Record<string, { tools?: unknown[] }>>('/api/v1/mcp-tools', { query: { directory: directory.value }, timeout: 90_000 })
    .then((found) => { mcpTools.value = found || {} })
    .catch(() => { mcpToolsLoaded = '' })
}

// ---- writing with AI ----

const aiModel = ref('')
watch(aiModel, (v) => {
  try { localStorage.setItem('opencode-web.ai-model', v) } catch { /* private mode */ }
})
const generating = ref<'' | 'description' | 'prompt'>('')
const promptUndo = ref<string | null>(null)

function cleanAi(text: string) {
  return text.trim()
    .replace(/^```[\w-]*\n([\s\S]*?)\n```$/, '$1')
    .replace(/^(["'`])([\s\S]*)\1$/, '$2')
    .trim()
}

/** What the model gets to know about the agent being edited. */
function agentBrief() {
  const name = editor.creating ? form.name.trim() : editor.row?.name
  const off = BUILTIN_TOOLS.filter((t) => !form.tools[t.id]).map((t) => t.id)
  const mcp = mcpServers.value.filter((s) => mcpAllowed(s))
  return [
    `Name: ${name || '(unnamed)'}`,
    `Mode: ${form.mode} (${MODES.find((m) => m.value === form.mode)?.label})`,
    form.description.trim() ? `Description: ${form.description.trim()}` : '',
    `Built-in tools: all except ${off.length ? off.join(', ') : 'none'}`,
    `MCP servers it can use: ${mcp.length ? mcp.join(', ') : 'none'}`,
    form.prompt.trim() ? `Current system prompt:\n${form.prompt.trim().slice(0, 6000)}` : ''
  ].filter(Boolean).join('\n')
}

async function aiText(prompt: string, system: string) {
  const result = await $fetch<{ text: string }>('/api/v1/ai-text', {
    method: 'POST',
    body: { prompt, system, model: aiModel.value || undefined, directory: directory.value },
    timeout: 180_000
  })
  return cleanAi(result.text || '')
}

async function generateDescription() {
  generating.value = 'description'
  try {
    const text = await aiText(
      `Write the description of this opencode agent.\n\n${agentBrief()}`,
      'You write the description field of an opencode agent. Other agents read it to decide when to delegate to this one, and people read it in a picker. Reply with the description only: one sentence, at most 25 words, starting with what to use the agent for. No quotes, no markdown.'
    )
    if (text) form.description = text
  } catch (e) {
    toast.add({ title: 'Could not generate a description', description: errorMessage(e), color: 'error' })
  } finally {
    generating.value = ''
  }
}

async function generatePrompt() {
  generating.value = 'prompt'
  const improving = Boolean(form.prompt.trim())
  try {
    const text = await aiText(
      improving
        ? `Improve the system prompt of this opencode agent. Keep its intent and any specific rules; make it clear, specific and well structured.\n\n${agentBrief()}`
        : `Write a system prompt for this opencode agent.\n\n${agentBrief()}`,
      'You write system prompts for opencode agents (AI coding assistants with tools). Write in the second person ("You are…"), state the role, how to work, what to deliver and when to stop; mention the tools and MCP servers it has only where it helps. Reply with the system prompt only, no preamble, no code fences.'
    )
    if (text) {
      promptUndo.value = form.prompt
      form.prompt = text
    }
  } catch (e) {
    toast.add({ title: `Could not ${improving ? 'improve' : 'generate'} the prompt`, description: errorMessage(e), color: 'error' })
  } finally {
    generating.value = ''
  }
}

function undoPrompt() {
  if (promptUndo.value == null) return
  form.prompt = promptUndo.value
  promptUndo.value = null
}

const editorTitle = computed(() => editor.creating ? 'New agent' : `@${editor.row?.name}`)
const editorDescription = computed(() => {
  if (editor.creating) return 'A new agent in opencode\'s config. It is available after a reload.'
  if (editor.row?.builtIn) return 'A built-in agent: only your changes are written, the rest keeps opencode\'s defaults.'
  return `Defined in the ${editor.row?.definedIn.map((w) => whereLabel[w]).join(' and ') || 'config'}.`
})

useHead(() => ({ title: `Agents · ${dirName(directory.value)} · opencode web` }))
</script>

<template>
  <div class="flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
    <div class="max-w-2xl mx-auto px-4 py-6">
      <!-- phones: title row + a full-width action row; desktop: one row -->
      <div class="flex flex-wrap items-center gap-2 mb-1">
        <h1 class="text-lg font-semibold">Agents</h1>
        <span class="flex-1" />
        <UTooltip text="Reload the list">
          <UButton
            size="xs"
            variant="soft"
            icon="i-lucide-refresh-cw"
            class="oc-tap"
            :loading="loading"
            aria-label="Reload the list"
            @click="refresh(); loadNest()"
          />
        </UTooltip>
        <div class="basis-full sm:basis-auto grid gap-1.5 sm:flex" :class="caps.config ? 'grid-cols-2' : 'grid-cols-1'">
          <UDropdownMenu v-if="caps.config" :items="reloadMenu" :content="{ align: 'end' }">
            <UButton
              size="xs"
              variant="soft"
              color="neutral"
              icon="i-lucide-rotate-ccw"
              label="Reload opencode"
              class="oc-tap w-full sm:w-auto justify-center"
              :loading="reloading"
              aria-label="Reload opencode config"
            />
          </UDropdownMenu>
          <UButton
            size="xs"
            color="primary"
            icon="i-lucide-plus"
            label="New agent"
            class="oc-tap w-full sm:w-auto justify-center"
            :disabled="!caps.config"
            @click="openEditor(null)"
          />
        </div>
      </div>
      <p class="text-sm text-muted mb-4">
        Primary agents are picked in the chat; subagents are called by other agents. Set each one's prompt, model,
        tools and which MCP servers it may use.
      </p>

      <UAlert
        v-if="!caps.config"
        class="mb-3"
        color="warning"
        variant="subtle"
        icon="i-lucide-lock"
        title="Read-only on this server"
        description="This opencode server has no config API, so agents cannot be changed from here. Edit opencode.json and restart it."
      />

      <!-- saved but not loaded: stays until opencode reloads -->
      <UAlert
        v-if="needsReload"
        class="mb-3 oc-appear"
        color="info"
        variant="subtle"
        icon="i-lucide-info"
        title="Changes saved — reload opencode to apply"
        description="opencode reads agents when it loads its config. Reloading waits for running replies to finish."
        :actions="[{ label: 'Reload', icon: 'i-lucide-rotate-ccw', color: 'info', variant: 'solid', size: 'xs', loading: reloading, onClick: reloadNow }]"
      />

      <!-- scope: where new and edited agents are saved -->
      <div class="text-xs text-muted mb-1.5">Save changes to</div>
      <div class="grid grid-cols-2 gap-0.5 p-0.5 mb-4 rounded-sm bg-muted" role="tablist" aria-label="Where changes are saved">
        <UButton
          size="xs"
          :variant="scope === 'project' ? 'solid' : 'ghost'"
          :color="scope === 'project' ? 'primary' : 'neutral'"
          icon="i-lucide-folder-git-2"
          :label="dirName(directory)"
          class="oc-tap w-full justify-center transition-colors"
          role="tab"
          :aria-selected="scope === 'project'"
          @click="scope = 'project'"
        />
        <UButton
          size="xs"
          :variant="scope === 'global' ? 'solid' : 'ghost'"
          :color="scope === 'global' ? 'primary' : 'neutral'"
          icon="i-lucide-globe"
          label="Global"
          class="oc-tap w-full justify-center transition-colors"
          role="tab"
          :aria-selected="scope === 'global'"
          @click="scope = 'global'"
        />
      </div>

      <div v-if="loading && !rows.length" class="bg-muted rounded-sm p-4 space-y-3">
        <div v-for="i in 4" :key="i" class="flex items-center gap-3">
          <USkeleton class="size-4 rounded-full" />
          <div class="flex-1 space-y-1.5">
            <USkeleton class="h-3.5 w-1/4" />
            <USkeleton class="h-3 w-2/3" />
          </div>
          <USkeleton class="h-6 w-14 rounded-sm" />
        </div>
      </div>
      <UAlert
        v-else-if="loadError && !rows.length"
        color="error"
        variant="subtle"
        icon="i-lucide-plug-zap"
        title="Could not load the agents"
        :description="loadError"
        :actions="[{ label: 'Retry', icon: 'i-lucide-refresh-cw', color: 'error', variant: 'soft', size: 'xs', onClick: () => refresh() }]"
      />
      <div v-else-if="!rows.length" class="flex flex-col items-center gap-2 rounded-sm bg-muted px-4 py-8 text-sm text-muted">
        <UIcon name="i-lucide-bot" class="size-5" />
        No agents reported by this server.
        <UButton v-if="caps.config" size="xs" variant="soft" icon="i-lucide-plus" label="New agent" class="oc-tap" @click="openEditor(null)" />
      </div>

      <template v-else>
        <section v-for="group in groups" :key="group.key" class="mb-5">
          <h2 class="flex items-baseline gap-2 text-xs font-medium text-muted mb-2">
            {{ group.title }}
            <span class="text-dimmed font-normal">{{ group.hint }} · {{ group.rows.length }}</span>
          </h2>
          <p v-if="!group.rows.length" class="rounded-sm bg-muted px-3 py-3 text-xs text-dimmed">None.</p>
          <div class="space-y-1.5">
            <div
              v-for="row in group.rows"
              :key="row.name"
              class="oc-row flex items-start gap-3 rounded-sm bg-muted px-3 py-2.5"
            >
              <UIcon
                :name="row.managed ? 'i-lucide-network' : row.builtIn ? 'i-lucide-box' : 'i-lucide-bot'"
                class="size-4 text-muted shrink-0 mt-0.5"
              />
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-1.5">
                  <span class="text-sm font-medium font-mono">{{ row.name }}</span>
                  <UBadge v-if="row.mode === 'all'" size="sm" variant="subtle" color="neutral">also subagent</UBadge>
                  <UBadge v-if="row.builtIn" size="sm" variant="subtle" color="neutral">built-in</UBadge>
                  <UBadge v-if="row.managed" size="sm" variant="subtle" color="primary">managed · Subagent per MCP</UBadge>
                  <UTooltip v-if="row.pending" text="Saved in the config; opencode loads it on the next reload">
                    <UBadge size="sm" variant="subtle" color="info">not loaded yet</UBadge>
                  </UTooltip>
                </div>
                <p class="text-xs text-dimmed truncate" :title="row.description">{{ row.description || 'No description' }}</p>
                <div class="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1 text-[11px] text-muted">
                  <span v-if="row.model" class="inline-flex items-center gap-1 min-w-0 max-w-full">
                    <UIcon name="i-lucide-cpu" class="size-3 shrink-0" />
                    <span class="font-mono truncate">{{ row.model }}</span>
                  </span>
                  <span v-if="mcpSummary(row)" class="inline-flex items-center gap-1">
                    <UIcon name="i-lucide-plug" class="size-3" />{{ mcpSummary(row) }}
                  </span>
                  <UTooltip v-if="canDelegate(row)" text="Can delegate: invokes subagents (task)">
                    <span class="inline-flex items-center gap-1">
                      <UIcon name="i-lucide-git-fork" class="size-3" />delegates
                    </span>
                  </UTooltip>
                  <span v-for="w in row.definedIn" :key="w" class="inline-flex items-center gap-1 text-dimmed">
                    <UIcon :name="whereIcon[w]" class="size-3" />{{ whereLabel[w] }}
                  </span>
                </div>
              </div>
              <UTooltip v-if="row.managed" text="Written by Subagent per MCP: change it on the MCP page">
                <UButton
                  size="xs"
                  variant="soft"
                  color="neutral"
                  icon="i-lucide-external-link"
                  label="MCP page"
                  class="oc-tap shrink-0"
                  :to="`/p/${route.params.dir}/mcp`"
                />
              </UTooltip>
              <UButton
                v-else
                size="xs"
                variant="soft"
                color="neutral"
                icon="i-lucide-pencil"
                label="Edit"
                class="oc-tap shrink-0"
                :disabled="!caps.config"
                :aria-label="`Edit ${row.name}`"
                @click="openEditor(row)"
              />
            </div>
          </div>
        </section>

        <!-- disabled agents: "deleting" is disable: true, so they can come back -->
        <section v-if="disabledRows.length" class="mb-5">
          <UButton
            size="xs"
            variant="ghost"
            color="neutral"
            :icon="showDisabled ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
            :label="`Disabled · ${disabledRows.length}`"
            class="oc-tap -ml-2 mb-1"
            :aria-expanded="showDisabled"
            @click="showDisabled = !showDisabled"
          />
          <div v-if="showDisabled" class="space-y-1.5 oc-appear">
            <div
              v-for="row in disabledRows"
              :key="row.name"
              class="flex items-center gap-3 rounded-sm bg-muted px-3 py-2 opacity-80"
            >
              <UIcon name="i-lucide-circle-off" class="size-4 text-dimmed shrink-0" />
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-1.5">
                  <span class="text-sm font-mono text-muted">{{ row.name }}</span>
                  <UBadge size="sm" variant="subtle" color="neutral">disabled</UBadge>
                  <UBadge v-if="row.builtIn" size="sm" variant="subtle" color="neutral">built-in</UBadge>
                  <UBadge v-if="row.managed" size="sm" variant="subtle" color="primary">managed · Subagent per MCP</UBadge>
                </div>
                <p v-if="row.description" class="text-xs text-dimmed truncate">{{ row.description }}</p>
              </div>
              <UButton
                v-if="row.managed"
                size="xs"
                variant="soft"
                color="neutral"
                icon="i-lucide-external-link"
                label="MCP page"
                class="oc-tap shrink-0"
                :to="`/p/${route.params.dir}/mcp`"
              />
              <UButton
                v-else
                size="xs"
                variant="soft"
                color="primary"
                icon="i-lucide-power"
                label="Enable"
                class="oc-tap shrink-0"
                :loading="toggling === row.name"
                :disabled="!caps.config"
                @click="setDisabled(row, false)"
              />
            </div>
          </div>
        </section>
      </template>
    </div>

    <UModal
      v-model:open="editor.open"
      :title="editorTitle"
      :description="editorDescription"
      :ui="{ content: 'sm:max-w-2xl', body: 'p-0 sm:p-0' }"
    >
      <template #body>
        <div class="flex flex-col min-h-0">
          <div class="px-4 pt-2">
            <UTabs v-model="editor.tab" :items="tabs" :content="false" size="xs" variant="link" class="w-full" />
          </div>

          <div class="px-4 py-3 min-h-72 space-y-4">
            <UAlert
              v-if="editor.confirmDisable && editor.row"
              :color="editor.row.name === 'build' ? 'error' : 'warning'"
              variant="subtle"
              icon="i-lucide-triangle-alert"
              :title="`Disable @${editor.row.name}?`"
              :description="editor.row.name === 'build'
                ? 'build is opencode\'s default agent: new chats need another primary agent picked. The config API cannot delete agents; it can be enabled again from the Disabled list.'
                : 'The config API cannot delete agents: it is disabled and can be enabled again from the Disabled list.'"
              :actions="[
                { label: 'Cancel', color: 'neutral', variant: 'ghost', size: 'xs', onClick: () => { editor.confirmDisable = false } },
                { label: 'Disable', icon: 'i-lucide-power-off', color: 'error', variant: 'solid', size: 'xs', loading: toggling === editor.row.name, onClick: confirmDisable }
              ]"
            />

            <!-- ================= general ================= -->
            <div v-if="editor.tab === 'general'" class="space-y-4">
              <UFormField
                v-if="editor.creating"
                label="Name"
                size="sm"
                required
                :error="nameError || undefined"
                description="Used as @name in the chat. Lowercase letters, digits, - and _."
              >
                <UInput v-model="form.name" placeholder="reviewer" class="w-full font-mono" autofocus />
              </UFormField>

              <UFormField label="Description" size="sm" description="Other agents read it to decide when to delegate here.">
                <template #hint>
                  <UButton
                    size="xs"
                    variant="ghost"
                    icon="i-lucide-sparkles"
                    label="Generate"
                    class="oc-tap"
                    :loading="generating === 'description'"
                    :disabled="Boolean(generating) || (editor.creating && !form.name.trim())"
                    @click="generateDescription"
                  />
                </template>
                <UTextarea
                  v-model="form.description"
                  :rows="2"
                  autoresize
                  :maxrows="5"
                  placeholder="Reviews code changes for bugs and risky patterns"
                  class="w-full"
                />
              </UFormField>

              <UFormField label="AI model for generating" size="xs" description="Used by the ✨ buttons; remembered on this device.">
                <ModelSelect v-model="aiModel" :items="catalog.items.value" :loading="catalog.loading.value" size="xs" empty-label="opencode's default model" />
              </UFormField>

              <div class="grid gap-4 sm:grid-cols-2">
                <UFormField label="Mode" size="sm">
                  <USelect v-model="form.mode" :items="MODES" class="w-full" />
                </UFormField>
                <UFormField
                  label="Temperature"
                  size="sm"
                  :error="temperatureError || undefined"
                  :help="temperatureCleared ? 'The config API cannot remove a value: the old one stays. Edit opencode.json to clear it.' : undefined"
                >
                  <UInput v-model="form.temperature" type="number" inputmode="decimal" step="0.1" min="0" max="2" placeholder="model default" class="w-full" />
                </UFormField>
              </div>

              <UFormField
                label="Model"
                size="sm"
                :help="modelCleared ? 'The config API cannot remove a value: the model stays set. Edit opencode.json to inherit again.' : undefined"
              >
                <ModelSelect v-model="form.model" :items="catalog.items.value" :loading="catalog.loading.value" empty-label="Inherit (session's model)" />
              </UFormField>
            </div>

            <!-- ================= prompt ================= -->
            <div v-else-if="editor.tab === 'prompt'" class="space-y-3">
              <UFormField label="System prompt" size="sm" description="How the agent works. Empty: opencode's default prompt for the model.">
                <template #hint>
                  <div class="flex items-center gap-1">
                    <UButton
                      v-if="promptUndo !== null"
                      size="xs"
                      variant="ghost"
                      color="neutral"
                      icon="i-lucide-undo-2"
                      label="Undo"
                      class="oc-tap"
                      @click="undoPrompt"
                    />
                    <UButton
                      size="xs"
                      variant="ghost"
                      icon="i-lucide-sparkles"
                      :label="form.prompt.trim() ? 'Improve' : 'Generate'"
                      class="oc-tap"
                      :loading="generating === 'prompt'"
                      :disabled="Boolean(generating) || (editor.creating && !form.name.trim())"
                      @click="generatePrompt"
                    />
                  </div>
                </template>
                <UTextarea
                  v-model="form.prompt"
                  :rows="10"
                  autoresize
                  :maxrows="22"
                  placeholder="You are a careful code reviewer…"
                  class="w-full font-mono text-xs"
                />
              </UFormField>
              <UFormField label="AI model for generating" size="xs">
                <ModelSelect v-model="aiModel" :items="catalog.items.value" :loading="catalog.loading.value" size="xs" empty-label="opencode's default model" />
              </UFormField>
              <p v-if="generating === 'prompt'" class="text-xs text-muted">
                <UIcon name="i-lucide-loader-circle" class="size-3 animate-spin align-[-2px]" /> Writing… this can take up to a minute.
              </p>
            </div>

            <!-- ================= MCP servers ================= -->
            <div v-else-if="editor.tab === 'mcp'" class="space-y-3">
              <div v-if="!mcpServers.length" class="flex flex-col items-center gap-2 rounded-sm bg-muted px-4 py-6 text-sm text-muted">
                <UIcon name="i-lucide-plug" class="size-5" />
                No MCP servers configured.
                <UButton size="xs" variant="soft" icon="i-lucide-plus" label="Add one on the MCP page" class="oc-tap" :to="`/p/${route.params.dir}/mcp`" />
              </div>
              <template v-else>
                <div class="flex flex-wrap items-center gap-1.5">
                  <p class="text-xs text-muted flex-1 min-w-48">
                    Inherit follows the agent's other rules and the global tool settings.
                  </p>
                  <UButton size="xs" variant="soft" color="neutral" icon="i-lucide-check-check" label="Allow all" class="oc-tap" @click="setAllMcp('allow')" />
                  <UButton size="xs" variant="soft" color="neutral" icon="i-lucide-ban" label="Block all" class="oc-tap" @click="setAllMcp('block')" />
                </div>
                <div class="space-y-1.5">
                  <div
                    v-for="server in mcpServers"
                    :key="server"
                    class="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-sm bg-muted px-3 py-2"
                  >
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center gap-1.5">
                        <UIcon
                          :name="mcpAllowed(server) ? 'i-lucide-plug' : 'i-lucide-unplug'"
                          class="size-3.5 shrink-0"
                          :class="mcpAllowed(server) ? 'text-primary' : 'text-dimmed'"
                        />
                        <span class="text-sm font-mono truncate">{{ server }}</span>
                      </div>
                      <p class="text-[11px] text-dimmed">
                        <template v-if="mcpTools[server]?.tools">{{ mcpTools[server]!.tools!.length }} tools · </template>
                        {{ mcpAllowed(server) ? 'allowed' : 'blocked' }}<template v-if="form.mcp[server] === 'inherit'"> (inherited)</template>
                      </p>
                    </div>
                    <div class="grid grid-cols-3 gap-0.5 p-0.5 rounded-sm bg-elevated w-full sm:w-auto" role="radiogroup" :aria-label="`${server} access`">
                      <UButton
                        v-for="choice in MCP_CHOICES"
                        :key="choice.value"
                        size="xs"
                        :variant="form.mcp[server] === choice.value ? 'solid' : 'ghost'"
                        :color="form.mcp[server] === choice.value ? (choice.value === 'block' ? 'error' : choice.value === 'allow' ? 'primary' : 'neutral') : 'neutral'"
                        :icon="choice.icon"
                        :label="choice.label"
                        class="oc-tap justify-center"
                        role="radio"
                        :aria-checked="form.mcp[server] === choice.value"
                        @click="form.mcp[server] = choice.value"
                      />
                    </div>
                  </div>
                </div>
                <p v-if="mcpResetToInherit" class="text-xs text-warning">
                  The config API cannot remove a rule: a server set back to Inherit is saved as Allow.
                </p>
              </template>
            </div>

            <!-- ================= built-in tools ================= -->
            <div v-else-if="editor.tab === 'tools'" class="space-y-3">
              <p class="text-xs text-muted">
                Off = the agent cannot use the tool. Untouched tools keep opencode's defaults and permissions; a tool you
                switch back on is saved as <code class="font-mono">true</code>, since the config API cannot remove a rule.
              </p>
              <div class="rounded-sm bg-muted divide-y divide-default/40">
                <label
                  v-for="tool in BUILTIN_TOOLS"
                  :key="tool.id"
                  class="flex items-center gap-3 px-3 py-2 cursor-pointer"
                >
                  <div class="min-w-0 flex-1">
                    <div class="text-sm" :class="tool.id === 'task' ? 'font-medium' : ''">{{ tool.label }}</div>
                    <div class="text-[11px] text-dimmed font-mono">
                      {{ tool.id }}
                      <span v-if="form.tools[tool.id] !== initial.tools[tool.id]" class="text-primary font-sans"> · changed</span>
                      <span v-else-if="editor.row?.configTools[tool.id] !== undefined" class="font-sans"> · set in config</span>
                    </div>
                  </div>
                  <USwitch v-model="form.tools[tool.id]" size="sm" :aria-label="tool.label" />
                </label>
              </div>
              <div v-if="otherRules.length" class="text-xs text-muted">
                Other rules (edit in opencode.json):
                <span v-for="[key, on] in otherRules" :key="key" class="inline-block font-mono text-[11px] bg-muted rounded-sm px-1.5 py-0.5 mr-1 mt-1">
                  {{ key }}: {{ on }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </template>

      <template #footer>
        <div class="oc-actions">
          <UButton
            v-if="!editor.creating && editor.row"
            variant="ghost"
            color="error"
            icon="i-lucide-power-off"
            label="Disable agent"
            :disabled="!caps.config || editor.confirmDisable"
            @click="editor.confirmDisable = true"
          />
          <span class="flex-1 oc-spacer" />
          <UButton variant="ghost" color="neutral" label="Cancel" @click="editor.open = false" />
          <UButton
            color="primary"
            icon="i-lucide-save"
            :label="editor.creating ? 'Create agent' : 'Save'"
            :loading="editor.saving"
            :disabled="!canSave"
            @click="save"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
