<script setup lang="ts">
import type { AgentInfo, ProvidersResponse } from '#shared/types/opencode'

const props = defineProps<{
  providers: ProvidersResponse | null
  agents: AgentInfo[]
  mcpServers: string[]
  busy: boolean
  directory: string
  metaLoading?: boolean
}>()

const emit = defineEmits<{
  send: [payload: {
    text: string
    model?: { providerID: string; modelID: string }
    agent?: string
    variant?: string
    tools?: Record<string, boolean>
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
const mcpSelected = ref<string[]>([])
const optionsOpen = ref(false)

const CONFIGURE = '__configure__'
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

// "Configure providers…" pinned as last scrollable entry
const modelSelectItems = computed(() => [
  ...modelItems.value,
  { label: 'Configure providers…', value: CONFIGURE, provider: '', reasoning: false, ctx: 0, cost: '' }
])

// intercept the configure sentinel so it never becomes the selected model
const modelProxy = computed({
  get: () => model.value,
  set: (v: string) => {
    if (v === CONFIGURE) providersOpen.value = true
    else model.value = v
  }
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
  { label: 'custom selection', value: 'custom', icon: 'i-lucide-list-checks' }
]

const variantLabel = computed(
  () => variantItems.find((v) => v.value === variant.value)?.label || DEFAULT
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
    if (Array.isArray(saved.mcpSelected)) mcpSelected.value = saved.mcpSelected
  } catch { /* ignore */ }
})

watch(modelItems, (items) => {
  if (model.value && items.some((i) => i.value === model.value)) return
  const defaults = props.providers?.default || {}
  const [providerID, modelID] = Object.entries(defaults)[0] || []
  const candidate = providerID && modelID ? `${providerID}/${modelID}` : items[0]?.value
  if (candidate) model.value = candidate
}, { immediate: true })

// when switching to custom the first time, start with everything enabled
watch(mcpMode, (mode) => {
  if (mode === 'custom' && mcpSelected.value.length === 0) {
    mcpSelected.value = [...props.mcpServers]
  }
})

watch([model, agent, variant, mcpMode, mcpSelected], () => {
  localStorage.setItem(prefsKey.value, JSON.stringify({
    model: model.value,
    agent: agent.value,
    variant: variant.value,
    mcpMode: mcpMode.value,
    mcpSelected: mcpSelected.value
  }))
}, { deep: true })

function toggleMcp(name: string) {
  const idx = mcpSelected.value.indexOf(name)
  if (idx >= 0) mcpSelected.value.splice(idx, 1)
  else mcpSelected.value.push(name)
}

function send() {
  const value = text.value.trim()
  if (!value || props.busy) return
  const [providerID, ...rest] = model.value.split('/')
  const modelID = rest.join('/')

  // custom MCP selection → disable tools of unchecked servers for this prompt
  let tools: Record<string, boolean> | undefined
  if (mcpMode.value === 'custom') {
    tools = {}
    for (const name of props.mcpServers) {
      if (!mcpSelected.value.includes(name)) {
        tools[`${name}*`] = false
        tools[`${name}_*`] = false
      }
    }
    if (Object.keys(tools).length === 0) tools = undefined
  }

  emit('send', {
    text: value,
    model: providerID && modelID ? { providerID, modelID } : undefined,
    agent: agent.value !== DEFAULT ? agent.value : undefined,
    variant: variant.value !== DEFAULT ? variant.value : undefined,
    tools
  })
  text.value = ''
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    send()
  }
}
</script>

<template>
  <div class="bg-muted px-3 sm:px-4 py-2 sm:py-3 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
    <div class="max-w-3xl mx-auto space-y-2">
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

      <!-- collapsible options: model / think level / agent / mcp -->
      <Transition name="oc-collapse">
      <div v-if="optionsOpen" class="space-y-2">
        <div class="flex flex-col sm:flex-row gap-1.5">
          <UFormField label="Model" size="xs" class="flex-1">
            <div class="flex gap-1">
              <USelectMenu
                v-model="modelProxy"
                :items="modelSelectItems"
                value-key="value"
                :filter-fields="['label', 'provider']"
                :search-input="{ placeholder: 'Search models or providers…' }"
                :loading="metaLoading"
                :placeholder="metaLoading ? 'Loading models…' : 'Select model'"
                size="sm"
                class="w-full min-w-0"
                icon="i-lucide-cpu"
              >
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
                <template #item="{ item }">
                  <div
                    v-if="item.value === CONFIGURE"
                    class="flex items-center gap-2 w-full text-highlighted"
                  >
                    <UIcon name="i-lucide-settings-2" class="size-4 shrink-0" />
                    <span class="text-sm">Configure providers…</span>
                  </div>
                  <div v-else class="flex items-center gap-2 w-full min-w-0">
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
              </USelectMenu>
              <UButton
                color="neutral"
                variant="soft"
                size="sm"
                icon="i-lucide-plug"
                aria-label="Configure providers"
                @click="providersOpen = true"
              />
            </div>
          </UFormField>
          <UFormField v-if="selectedModel?.reasoning" label="Think level" size="xs" class="sm:w-40">
            <USelect
              v-model="variant"
              :items="variantItems"
              value-key="value"
              size="sm"
              class="w-full"
              icon="i-lucide-brain"
            />
          </UFormField>
          <UFormField label="Agent" size="xs" class="sm:w-44">
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
        </div>

        <div v-if="mcpServers.length || metaLoading" class="flex flex-col sm:flex-row gap-1.5 sm:items-end">
          <UFormField label="MCP servers" size="xs" class="sm:w-48">
            <USelect
              v-model="mcpMode"
              :items="mcpModeItems"
              value-key="value"
              :loading="metaLoading"
              size="sm"
              class="w-full"
              icon="i-lucide-server"
            />
          </UFormField>
          <Transition name="oc-slide">
            <div v-if="mcpMode === 'custom'" class="flex flex-wrap gap-1 pb-0.5">
              <UButton
                v-for="name in mcpServers"
                :key="name"
                size="xs"
                :color="mcpSelected.includes(name) ? 'primary' : 'neutral'"
                :variant="mcpSelected.includes(name) ? 'soft' : 'ghost'"
                :icon="mcpSelected.includes(name) ? 'i-lucide-check' : 'i-lucide-x'"
                :label="name"
                class="font-mono transition-all duration-150"
                @click="toggleMcp(name)"
              />
            </div>
          </Transition>
        </div>
      </div>
      </Transition>

      <div class="flex items-center gap-1.5 min-w-0">
        <UButton
          color="neutral"
          :variant="optionsOpen ? 'soft' : 'ghost'"
          size="xs"
          :icon="optionsOpen ? 'i-lucide-chevron-down' : 'i-lucide-sliders-horizontal'"
          :aria-label="optionsOpen ? 'Hide options' : 'Show model, think level, agent and MCP options'"
          @click="optionsOpen = !optionsOpen"
        />
        <!-- compact summary of current settings; tap opens the panel -->
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
          <span v-if="mcpMode === 'custom'" class="hidden sm:flex items-center gap-1 shrink-0">
            <UIcon name="i-lucide-server" class="size-3" />
            {{ mcpSelected.length }}/{{ mcpServers.length }} mcp
          </span>
        </button>
        <span class="flex-1" />
        <UButton
          v-if="busy"
          color="error"
          variant="soft"
          size="xs"
          icon="i-lucide-square"
          label="Stop"
          @click="emit('abort')"
        />
        <UButton
          v-else
          color="primary"
          size="xs"
          icon="i-lucide-send"
          label="Send"
          :disabled="!text.trim()"
          @click="send"
        />
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
