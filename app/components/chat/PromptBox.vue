<script setup lang="ts">
import type { AgentInfo, ProvidersResponse } from '#shared/types/opencode'

export interface McpServerInfo {
  name: string
  status: string
  error?: string
  tools: Array<{ id: string; name: string; description?: string }>
}

const props = defineProps<{
  providers: ProvidersResponse | null
  agents: AgentInfo[]
  mcpInfo: McpServerInfo[]
  busy: boolean
  directory: string
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
  }]
  abort: []
  refreshProviders: []
}>()

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

watch(modelItems, (items) => {
  if (model.value && items.some((i) => i.value === model.value)) return
  const defaults = props.providers?.default || {}
  const [providerID, modelID] = Object.entries(defaults)[0] || []
  const candidate = providerID && modelID ? `${providerID}/${modelID}` : items[0]?.value
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
  emit('send', {
    text: value,
    model: providerID && modelID ? { providerID, modelID } : undefined,
    agent: agent.value !== DEFAULT ? agent.value : undefined,
    variant: variant.value !== DEFAULT && selectedModel.value?.reasoning ? variant.value : undefined,
    tools,
    files: attachments.value.length
      ? attachments.value.map(({ mime, filename, url }) => ({ mime, filename, url }))
      : undefined
  })
  text.value = ''
  attachments.value = []
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

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Tab' && slashMatches.value.length) {
    e.preventDefault()
    pickCommand(slashMatches.value[0]!.name)
    return
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    send()
  }
}
</script>

<template>
  <div class="bg-muted px-3 sm:px-4 py-2 sm:py-3 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
    <div class="max-w-4xl mx-auto space-y-2 relative">
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
          <div class="px-3 py-1 text-[10px] text-dimmed">Tab completes · `!command` runs shell</div>
        </div>
      </CollapseTransition>
      <UTextarea
        v-model="text"
        :rows="2"
        autoresize
        :maxrows="10"
        placeholder="Ask opencode… (Enter to send, Shift+Enter for newline)"
        class="w-full font-mono"
        variant="soft"
        size="lg"
        @keydown="onKeydown"
      />

      <!-- collapsible options; scrolls internally on small screens so the
           on-screen keyboard never pushes the selects out of reach -->
      <CollapseTransition>
      <div v-if="optionsOpen" class="space-y-2 max-h-[65dvh] overflow-y-auto overscroll-contain sm:max-h-none sm:overflow-visible">
        <!-- one row on wide screens: model / think / agent -->
        <div class="flex flex-col sm:flex-row gap-1.5">
          <UFormField label="Model" size="xs" class="flex-1 min-w-0">
            <div class="flex gap-1">
              <USelectMenu
                v-model="model"
                :items="modelItems"
                value-key="value"
                :filter-fields="['label', 'provider']"
                :search-input="{ placeholder: 'Search models or providers…' }"
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
                  aria-label="Configure providers"
                  @click="providersOpen = true"
                />
              </UTooltip>
            </div>
          </UFormField>
          <UFormField label="Think level" size="xs" class="sm:w-36 shrink-0">
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
          <UFormField label="Agent" size="xs" class="sm:w-40 shrink-0">
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
          <UFormField label="MCP" size="xs" class="sm:w-44 shrink-0">
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

        <!-- custom MCP selection: full-width accordion, scrollable -->
        <CollapseTransition>
        <div v-if="mcpInfo.length && mcpMode === 'custom'" class="space-y-1.5">
          <div class="flex items-center gap-1.5">
            <span class="text-[10px] uppercase tracking-widest text-dimmed flex-1">MCP servers & tools</span>
            <UButton size="xs" variant="soft" color="neutral" label="All on" @click="setAllServers(true)" />
            <UButton size="xs" variant="soft" color="neutral" label="All off" @click="setAllServers(false)" />
          </div>

          <!-- saved groups: apply with one click, save the current selection -->
          <div class="flex flex-wrap items-center gap-1">
            <template v-for="g in groups" :key="g.name">
              <div class="flex items-center rounded-sm overflow-hidden">
                <UButton
                  size="xs"
                  :variant="activeGroup === g.name ? 'solid' : 'soft'"
                  :color="activeGroup === g.name ? 'primary' : 'neutral'"
                  icon="i-lucide-layers"
                  :label="g.name"
                  class="rounded-r-none"
                  @click="applyGroup(g.name)"
                />
                <UButton
                  size="xs"
                  variant="soft"
                  color="neutral"
                  icon="i-lucide-x"
                  class="rounded-l-none"
                  :aria-label="`Delete group ${g.name}`"
                  @click="deleteGroup(g.name)"
                />
              </div>
            </template>
            <UInput
              v-model="groupName"
              size="xs"
              placeholder="Save selection as…"
              class="w-36 font-mono"
              @keydown.enter="saveGroup"
            />
            <UButton
              size="xs"
              variant="soft"
              color="neutral"
              icon="i-lucide-save"
              :disabled="!groupName.trim()"
              aria-label="Save MCP group"
              @click="saveGroup"
            />
          </div>

          <McpServerList
            :servers="mcpInfo"
            :server-mode="(n) => disabledServers.includes(n) ? 'off' : 'allow'"
            :tool-mode="toolChatMode"
            ask-disabled
            @set-server="(n, m) => toggleServer(n, m !== 'off')"
            @set-tool="setToolChatMode"
          />
        </div>
        </CollapseTransition>
      </div>
      </CollapseTransition>

      <!-- attachment chips -->
      <CollapseTransition>
      <div v-if="attachments.length" class="flex flex-wrap gap-1">
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
          <button class="ml-1 cursor-pointer hover:text-error" @click="attachments.splice(i, 1)">
            <UIcon name="i-lucide-x" class="size-3" />
          </button>
        </UBadge>
      </div>
      </CollapseTransition>

      <div class="flex items-center gap-1.5 min-w-0">
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
            aria-label="Attach files"
            @click="pickFiles"
          />
        </UTooltip>
        <UTooltip :text="optionsOpen ? 'Hide options' : 'Model, think level, agent & MCP options'">
          <UButton
            color="neutral"
            :variant="optionsOpen ? 'soft' : 'ghost'"
            size="xs"
            :icon="optionsOpen ? 'i-lucide-chevron-down' : 'i-lucide-sliders-horizontal'"
            :aria-label="optionsOpen ? 'Hide options' : 'Show model, think level, agent and MCP options'"
            @click="optionsOpen = !optionsOpen"
          />
        </UTooltip>
        <button
          class="flex items-center gap-2 min-w-0 text-[11px] font-mono text-dimmed hover:text-muted cursor-pointer"
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
