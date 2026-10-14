<script setup lang="ts">
// "Subagent per MCP": one specialist subagent per MCP server and an
// orchestrator agent that knows what to send each one (server/utils/mcp-nest.ts).
// The summaries are what the orchestrator reads: generated from each
// server's tools, editable here.

interface ServerPlan {
  server: string
  agent: string
  summary: string
  generated: string
  custom: boolean
  tools: Array<{ name: string; description?: string }>
  status: string
  included: boolean
  skipped?: string
}
interface Plan {
  settings: {
    enabled: boolean
    orchestrator: string
    exclude: string[]
    summaries: Record<string, string>
    instructions?: string
    lastSync?: { at: number; agents: string[]; error?: string }
  }
  servers: ServerPlan[]
  orchestratorPrompt: string
}

const caps = useCapabilities()
const toast = useToast()
const plan = ref<Plan | null>(null)
const expanded = ref(false)
const saving = ref(false)
const showPrompt = ref(false)

// local edits, applied with "Save & apply"
const draft = reactive({
  enabled: false,
  exclude: [] as string[],
  summaries: {} as Record<string, string>,
  instructions: ''
})
const dirty = ref(false)

async function load() {
  try {
    plan.value = await $fetch<Plan>('/api/v1/mcp-nest', { timeout: 130_000 })
    draft.enabled = plan.value.settings.enabled
    draft.exclude = [...plan.value.settings.exclude]
    draft.summaries = { ...plan.value.settings.summaries }
    draft.instructions = plan.value.settings.instructions || ''
    dirty.value = false
  } catch { /* opencode down: the card stays collapsed */ }
}
onMounted(load)
defineExpose({ load })

const included = (s: ServerPlan) => !draft.exclude.includes(s.server) && (!s.skipped || s.skipped === 'left out')
const nestable = computed(() => (plan.value?.servers || []).filter((s) => !s.skipped || s.skipped === 'left out'))
const specialists = computed(() => nestable.value.filter(included))

function toggleServer(server: string, on: boolean) {
  draft.exclude = on ? draft.exclude.filter((s) => s !== server) : [...new Set([...draft.exclude, server])]
  dirty.value = true
}

function summaryOf(s: ServerPlan) {
  return draft.summaries[s.server] ?? ''
}

function setSummary(s: ServerPlan, text: string) {
  draft.summaries = { ...draft.summaries, [s.server]: text }
  dirty.value = true
}

function resetSummary(s: ServerPlan) {
  const { [s.server]: _gone, ...rest } = draft.summaries
  draft.summaries = rest
  dirty.value = true
}

async function save(enabled = draft.enabled) {
  saving.value = true
  try {
    const summaries = Object.fromEntries(Object.entries(draft.summaries).filter(([, t]) => t.trim()))
    plan.value = await $fetch<Plan>('/api/v1/mcp-nest', {
      method: 'PUT',
      body: { enabled, exclude: draft.exclude, summaries, instructions: draft.instructions },
      timeout: 150_000
    })
    draft.enabled = plan.value.settings.enabled
    dirty.value = false
    toast.add({
      title: enabled ? `Orchestrator + ${specialists.value.length} MCP subagents saved` : 'MCP subagents turned off',
      description: enabled
        ? `Pick @${plan.value.settings.orchestrator} in the chat's agent selector. opencode reloads once no session is busy.`
        : 'Their agents are disabled after the reload.',
      color: 'success'
    })
  } catch (e) {
    const data = (e as { data?: { message?: string } })?.data
    toast.add({ title: 'Could not save the MCP subagents', description: data?.message || String(e), color: 'error' })
  } finally {
    saving.value = false
  }
}

function onSwitch(on: boolean) {
  draft.enabled = on
  if (on) expanded.value = true
  save(on)
}

function fmt(ts?: number) {
  return ts ? new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''
}
</script>

<template>
  <div v-if="caps.config" class="rounded-sm bg-muted mb-4 overflow-hidden">
    <div class="flex items-center gap-2.5 px-3 py-2.5">
      <button class="flex items-center gap-2.5 flex-1 min-w-0 text-left" @click="expanded = !expanded">
        <UIcon name="i-lucide-network" class="size-4 shrink-0" :class="draft.enabled ? 'text-success' : 'text-muted'" />
        <div class="min-w-0 flex-1">
          <div class="text-sm font-medium flex items-center gap-2">
            Subagent per MCP
            <Transition name="oc-swap" mode="out-in">
              <UBadge v-if="plan?.settings.enabled" key="on" size="sm" color="success" variant="subtle">
                @{{ plan.settings.orchestrator }} + {{ plan.settings.lastSync?.agents.length ? plan.settings.lastSync.agents.length - 1 : specialists.length }}
              </UBadge>
            </Transition>
          </div>
          <p class="text-xs text-dimmed truncate">An orchestrator delegates to one specialist subagent per MCP server, keeping its own context free of MCP tools.</p>
        </div>
        <UIcon name="i-lucide-chevron-down" class="size-4 text-dimmed transition-transform duration-200" :class="expanded ? 'rotate-180' : ''" />
      </button>
      <USwitch
        :model-value="draft.enabled"
        :loading="saving"
        :disabled="!plan"
        aria-label="Subagent per MCP"
        @update:model-value="onSwitch"
      />
    </div>

    <CollapseTransition>
      <div v-if="expanded && plan" class="px-3 pb-3 space-y-3">
        <!-- the tree: orchestrator -> specialists -->
        <div class="rounded-sm bg-elevated/70 p-2.5">
          <div class="flex items-center gap-1.5 text-xs">
            <UIcon name="i-lucide-crown" class="size-3.5 text-primary" />
            <span class="font-mono font-medium">@{{ plan.settings.orchestrator }}</span>
            <span class="text-dimmed">primary agent · no MCP tools · knows what to send each specialist</span>
          </div>
          <TransitionGroup tag="ul" name="oc-list" class="relative mt-1.5 ml-1.5 border-l border-default pl-3 space-y-1">
            <li v-for="s in specialists" :key="s.server" class="text-[11px] flex items-center gap-1.5">
              <UIcon name="i-lucide-bot" class="size-3 text-muted shrink-0" />
              <span class="font-mono">@{{ s.agent }}</span>
              <span class="text-dimmed truncate">only {{ s.server }} ({{ s.tools.length }} tools)</span>
            </li>
            <li v-if="!specialists.length" key="none" class="text-[11px] text-dimmed">No MCP servers to nest yet.</li>
          </TransitionGroup>
        </div>

        <!-- per server: include + what the orchestrator reads -->
        <div class="space-y-2">
          <div v-for="s in plan.servers" :key="s.server" class="rounded-sm bg-elevated/40 px-2.5 py-2">
            <div class="flex items-center gap-2">
              <UCheckbox
                :model-value="included(s)"
                :disabled="Boolean(s.skipped && s.skipped !== 'left out')"
                :aria-label="`Give ${s.server} its own subagent`"
                @update:model-value="(v) => toggleServer(s.server, Boolean(v))"
              />
              <span class="font-mono text-xs flex-1 truncate" :class="included(s) ? '' : 'text-dimmed'">{{ s.server }}</span>
              <span class="text-[10px] text-dimmed">{{ s.tools.length }} tools</span>
              <UBadge v-if="s.skipped && s.skipped !== 'left out'" size="sm" color="neutral" variant="subtle">{{ s.skipped }}</UBadge>
            </div>
            <CollapseTransition>
              <div v-if="included(s)" class="mt-1.5 pl-6 space-y-1">
                <UTextarea
                  :model-value="summaryOf(s)"
                  :placeholder="s.generated"
                  :rows="2"
                  autoresize
                  :maxrows="6"
                  class="w-full text-xs"
                  @update:model-value="(v) => setSummary(s, String(v))"
                />
                <div class="flex items-center gap-2 text-[10px] text-dimmed">
                  <span>{{ summaryOf(s).trim() ? 'Your summary' : 'Generated from its tools: write your own to steer the orchestrator' }}</span>
                  <button v-if="summaryOf(s).trim()" type="button" class="underline hover:text-highlighted" @click="resetSummary(s)">use generated</button>
                </div>
              </div>
            </CollapseTransition>
          </div>
        </div>

        <UFormField label="Extra instructions for the orchestrator" size="sm">
          <UTextarea
            v-model="draft.instructions"
            :rows="2"
            autoresize
            :maxrows="8"
            placeholder="e.g. Always confirm with me before turning devices off."
            class="w-full text-xs"
            @update:model-value="dirty = true"
          />
        </UFormField>

        <div class="flex flex-wrap items-center gap-2">
          <UButton size="xs" color="primary" icon="i-lucide-save" :label="draft.enabled ? 'Save & apply' : 'Save'" :loading="saving" :disabled="!dirty" @click="save()" />
          <UButton size="xs" variant="soft" color="neutral" icon="i-lucide-scroll-text" :label="showPrompt ? 'Hide orchestrator prompt' : 'Orchestrator prompt'" @click="showPrompt = !showPrompt" />
          <span class="text-[10px] text-dimmed">
            <template v-if="plan.settings.lastSync?.error"><span class="text-error">Last sync failed: {{ plan.settings.lastSync.error }}</span></template>
            <template v-else-if="plan.settings.lastSync">Written {{ fmt(plan.settings.lastSync.at) }} · stays in sync when MCP servers change</template>
            <template v-else>Uses the servers of the global config; saved there too</template>
          </span>
        </div>
        <CollapseTransition>
          <pre v-if="showPrompt" class="text-[11px] font-mono bg-elevated rounded p-2 whitespace-pre-wrap max-h-72 overflow-y-auto">{{ plan.orchestratorPrompt }}</pre>
        </CollapseTransition>
      </div>
    </CollapseTransition>
  </div>
</template>
