<script setup lang="ts">
// "Agent control": registers this app's own MCP server with opencode so the
// chat can manage opencode itself (MCP servers, reloads, other chats, tasks,
// schedules). Shows whether it is installed and at which URL.

interface ControlState {
  name: string
  installed: boolean
  enabled: boolean
  url: string | null
  suggestedUrl: string | null
  tokenProtected: boolean
}

const emit = defineEmits<{ changed: []; details: [name: string] }>()
const toast = useToast()
const state = ref<ControlState | null>(null)
const url = ref('')
const busy = ref(false)
const expanded = ref(false)

async function load() {
  state.value = await $fetch<ControlState>('/api/v1/control-mcp', { timeout: 20000 }).catch(() => null)
  url.value = state.value?.url || state.value?.suggestedUrl || ''
}
onMounted(load)

async function install(enabled = true) {
  busy.value = true
  try {
    const result = await $fetch<{ status?: { status: string; error?: string } }>('/api/v1/control-mcp', {
      method: 'POST',
      body: { url: url.value.trim(), enabled },
      timeout: 150_000
    })
    const ok = !enabled || result.status?.status === 'connected'
    toast.add({
      title: enabled ? (ok ? 'Agent control enabled' : `Agent control: ${result.status?.status || 'saved'}`) : 'Agent control disabled',
      description: enabled
        ? (ok ? 'New chats can manage opencode through the opencode-web tools. State-changing tools ask first.' : result.status?.error || 'opencode could not reach the URL: check it.')
        : undefined,
      color: ok ? 'success' : 'warning'
    })
    await load()
    emit('changed')
    if (enabled && !ok) emit('details', state.value?.name || 'opencode-web')
  } catch (e) {
    const data = (e as { data?: { message?: string } })?.data
    toast.add({ title: 'Could not register agent control', description: data?.message || String(e), color: 'error' })
  } finally {
    busy.value = false
  }
}

const TOOLS = [
  ['MCP', 'list, test, add, reconnect, set modes'],
  ['Reload', 'one project or all of opencode, after replies finish'],
  ['Chats', 'list, read and prompt other sessions, abort'],
  ['Tasks', 'todo lists of busy and recent sessions'],
  ['Schedules', 'create, run and manage scheduled prompts'],
  ['Info', 'version, models, agents, commands, skills, config']
]
</script>

<template>
  <div class="rounded-sm bg-muted mb-4 overflow-hidden">
    <button class="flex items-center gap-2.5 w-full px-3 py-2.5 text-left" @click="expanded = !expanded">
      <UIcon name="i-lucide-bot" class="size-4 shrink-0" :class="state?.installed && state.enabled ? 'text-success' : 'text-muted'" />
      <div class="min-w-0 flex-1">
        <div class="text-sm font-medium flex items-center gap-2">
          Agent control
          <Transition name="oc-swap" mode="out-in">
            <UBadge v-if="state?.installed && state.enabled" key="on" size="sm" color="success" variant="subtle">on</UBadge>
            <UBadge v-else-if="state?.installed" key="off" size="sm" color="neutral" variant="subtle">off</UBadge>
            <UBadge v-else-if="state" key="new" size="sm" color="primary" variant="subtle">new</UBadge>
          </Transition>
        </div>
        <p class="text-xs text-dimmed truncate">Let the chat manage opencode: MCP servers, reloads, other chats, tasks and schedules.</p>
      </div>
      <UIcon name="i-lucide-chevron-down" class="size-4 text-dimmed transition-transform duration-200" :class="expanded ? 'rotate-180' : ''" />
    </button>
    <CollapseTransition>
      <div v-if="expanded" class="px-3 pb-3 space-y-2.5">
        <div class="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
          <div v-for="[title, text] in TOOLS" :key="title" class="rounded-sm bg-elevated/70 px-2 py-1.5">
            <div class="text-[11px] font-medium">{{ title }}</div>
            <div class="text-[10px] text-dimmed leading-tight">{{ text }}</div>
          </div>
        </div>
        <UFormField
          label="URL opencode uses to reach this app"
          size="sm"
          :description="state?.tokenProtected ? 'The API token is sent as a header automatically.' : 'In Docker Compose: http://web:3000/mcp (set NUXT_SELF_URL to change the default).'"
        >
          <UInput v-model="url" placeholder="http://web:3000/mcp" class="w-full font-mono" />
        </UFormField>
        <div class="flex flex-wrap items-center gap-1.5">
          <UButton
            size="xs"
            color="primary"
            :icon="state?.installed ? 'i-lucide-refresh-cw' : 'i-lucide-plug'"
            :label="state?.installed ? (state.enabled ? 'Update' : 'Enable') : 'Enable agent control'"
            :loading="busy"
            :disabled="!url.trim()"
            @click="install(true)"
          />
          <UButton
            v-if="state?.installed && state.enabled"
            size="xs"
            variant="soft"
            color="neutral"
            icon="i-lucide-power-off"
            label="Disable"
            :loading="busy"
            @click="install(false)"
          />
          <UButton
            v-if="state?.installed"
            size="xs"
            variant="soft"
            color="neutral"
            icon="i-lucide-wrench"
            label="Tools"
            @click="emit('details', state.name)"
          />
          <span class="text-[10px] text-dimmed">Saved in the global config; new chats get the tools.</span>
        </div>
      </div>
    </CollapseTransition>
  </div>
</template>
