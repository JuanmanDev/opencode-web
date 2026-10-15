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

interface ModelItem {
  label: string
  value: string
  provider: string
  reasoning: boolean
  ctx: number
  cost: string
}

const modelItems = computed<ModelItem[]>(() => {
  if (!props.providers) return []
  const items: ModelItem[] = []
  for (const provider of props.providers.providers || []) {
    const providerName = String(provider.name || provider.id)
    for (const [id, m] of Object.entries(provider.models || {})) {
      const ctx = Math.round((m.limit?.context || 0) / 1000)
      const cin = m.cost?.input
      const cout = m.cost?.output
      items.push({
        label: `${m.name || id}`,
        value: `${provider.id}/${id}`,
        provider: providerName,
        reasoning: Boolean(m.reasoning || m.capabilities?.reasoning),
        ctx,
        cost: cin != null && cout != null && (cin > 0 || cout > 0)
          ? `$${cin}/${cout}`
          : (cin === 0 && cout === 0 ? 'free' : '')
      })
    }
  }
  return items.sort((a, b) =>
    a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label)
  )
})

const agentItems = computed(() => [
  { label: 'default agent', value: DEFAULT, icon: 'i-lucide-bot' },
  ...props.agents
    .filter((a) => (!a.mode || a.mode === 'primary' || a.mode === 'all') && a.name !== DEFAULT)
    .map((a) => ({ label: a.name, value: a.name, icon: 'i-lucide-bot' }))
])

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
const attachments = ref<Array<{ mime: string; filename: string; url: string; size: number }>>([])
const fileInput = ref<HTMLInputElement>()
const MAX_FILE = 4 * 1024 * 1024

function pickFiles() {
  fileInput.value?.click()
}

function onFiles(e: Event) {
  const input = e.target as HTMLInputElement
  for (const file of Array.from(input.files || [])) {
    if (file.size > MAX_FILE) continue
    const reader = new FileReader()
    reader.onload = () => {
      attachments.value.push({
        mime: file.type || 'application/octet-stream',
        filename: file.name,
        url: String(reader.result),
        size: file.size
      })
    }
    reader.readAsDataURL(file)
  }
  input.value = ''
}

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
    <div class="max-w-4xl w-full mx-auto space-y-2 relative flex flex-col min-h-0">
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
      />

      <!-- collapsible options; the only part of the box that shrinks and
           scrolls, so the on-screen keyboard never pushes Send off-screen -->
      <CollapseTransition>
      <div v-if="optionsOpen && !keyboardOpen" class="space-y-2 min-h-0 max-h-[65dvh] overflow-y-auto overscroll-contain sm:max-h-none">
        <!-- one row on wide screens: model / think / agent -->
        <!-- phones pair think level + agent so the panel stays short -->
        <div class="grid grid-cols-2 sm:flex sm:flex-row gap-1.5">
          <UFormField label="Model" size="xs" class="col-span-2 flex-1 min-w-0">
            <div class="flex gap-1">
              <USelectMenu
                v-model="model"
                :items="modelItems"
                value-key="value"
                :filter-fields="['label', 'provider']"
                :search-input="{ placeholder: 'Search models or providers…' }"
                :virtualize="{ estimateSize: () => 44 }"
                :loading="metaLoading"
                :placeholder="metaLoading ? 'Loading models…' : 'Select model'"
                size="sm"
                class="w-full min-w-0"
                icon="i-lucide-cpu"
              >
                <template #item="{ item }">
                  <div class="flex items-center gap-2 w-full min-w-0">
                    <div class="min-w-0 flex-1">
                      <div class="truncate text-sm">{{ item.label }}</div>
                      <div class="text-[10px] text-dimmed font-mono truncate">
                        {{ item.provider }}<template v-if="item.ctx"> · {{ item.ctx }}k ctx</template><template v-if="item.cost"> · {{ item.cost }}</template>
                      </div>
                    </div>
                    <UIcon
                      v-if="item.reasoning"
                      name="i-lucide-brain"
                      class="size-3.5 text-dimmed shrink-0"
                    />
                  </div>
                </template>
                <template #empty>
                  <div
                    class="flex items-center gap-2 px-2 py-3 text-sm"
                    :class="!metaLoading && serverDegraded ? 'text-error' : 'text-muted'"
                  >
                    <UIcon v-if="metaLoading" name="i-lucide-loader-circle" class="size-4 animate-spin" />
                    <UIcon v-else-if="serverDegraded" name="i-lucide-plug-zap" class="size-4" />
                    {{ metaLoading ? 'Loading models…' : (serverDegraded ? 'Server not responding' : 'No models found') }}
                  </div>
                </template>
                <!-- always visible, unaffected by the search filter -->
                <template #content-bottom>
                  <button
                    class="flex w-full items-center gap-2 px-2.5 py-2 text-sm text-highlighted bg-elevated hover:bg-accented cursor-pointer"
                    @mousedown.prevent="providersOpen = true"
                  >
                    <UIcon name="i-lucide-settings-2" class="size-4 shrink-0" />
                    Configure providers…
                  </button>
                </template>
              </USelectMenu>
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
          <UFormField label="Think level" size="xs" class="min-w-0 sm:w-36 shrink-0">
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
          <UFormField label="Agent" size="xs" class="min-w-0 sm:w-40 shrink-0">
            <USelect
              v-model="agent"
              :items="agentItems"
              value-key="value"
              :loading="metaLoading"
              size="sm"
              class="w-full"
              icon="i-lucide-bot"
            />
          </UFormField>

          <!-- MCP shares the same row -->
          <UFormField v-if="caps.mcp" label="MCP" size="xs" class="col-span-2 sm:w-44 shrink-0">
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
      <div v-if="attachments.length" class="flex flex-wrap gap-1 shrink-0">
        <UBadge
          v-for="(file, i) in attachments"
          :key="i"
          color="neutral"
          variant="subtle"
          size="sm"
          class="oc-appear font-mono"
        >
          <UIcon name="i-lucide-paperclip" class="size-3 mr-1" />
          {{ file.filename }}
          <button
            class="relative oc-tap-zone ml-1 cursor-pointer hover:text-error"
            :aria-label="`Remove ${file.filename}`"
            @click="attachments.splice(i, 1)"
          >
            <UIcon name="i-lucide-x" class="size-3" />
          </button>
        </UBadge>
      </div>
      </CollapseTransition>

      <div class="flex items-center gap-1.5 min-w-0 shrink-0">
        <input
          ref="fileInput"
          type="file"
          multiple
          accept="image/*,application/pdf,text/*,.md,.json,.csv"
          class="hidden"
          @change="onFiles"
        >
        <UTooltip text="Attach files">
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
          <span v-if="agent !== DEFAULT" class="hidden sm:flex items-center gap-1 shrink-0">
            <UIcon name="i-lucide-bot" class="size-3" />
            {{ agent }}
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

    <ProvidersModal
      v-model:open="providersOpen"
      :providers="providers"
      :directory="directory"
      :loading="metaLoading"
      @saved="emit('refreshProviders')"
    />
  </div>
</template>
