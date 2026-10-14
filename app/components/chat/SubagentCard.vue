<script setup lang="ts">
// A subagent call: `task` on opencode 1.x, `subagent` on the v2 runner. It
// runs in a child session. Shows who
// is working on what, its steps live (the child's events arrive on the same
// project stream), the result, and a link into the subagent's own chat.
import type { MessageWithParts, Part, ToolPart } from '#shared/types/opencode'

const props = defineProps<{ part: ToolPart }>()

const route = useRoute()
const dirParam = computed(() => route.params.dir as string)
const directory = computed(() => decodeDir(dirParam.value))
const api = useOpencodeApi(directory)
const { busy } = useBusySessions()

const state = computed(() => (props.part.state || { status: 'pending' }) as unknown as Record<string, any>)
const status = computed(() => String(state.value.status || 'pending'))
const input = computed(() => (state.value.input || {}) as { description?: string; prompt?: string; subagent_type?: string; agent?: string })
const output = computed(() => typeof state.value.output === 'string' ? state.value.output : '')

/** the child session: live from `running` on (metadata), else from the output */
const TAGS = /<\/?(?:task|task_result|task_error|subagent|summary)[^>]*>/g
const childId = computed<string | undefined>(() =>
  state.value.metadata?.sessionId
  || state.value.metadata?.sessionID
  || /<(?:task|task_result|task_error|subagent)[^>]*(?:id|sessionID)="([^"]+)"/.exec(output.value)?.[1]
  || undefined)

const result = computed(() => {
  const tagged = /<task_result>([\s\S]*?)<\/task_result>/.exec(output.value)?.[1]
  return (tagged ?? output.value).replace(TAGS, '').trim()
})
const error = computed(() => status.value === 'error' ? String(state.value.error || '') : '')
const running = computed(() => status.value === 'running' || status.value === 'pending' || Boolean(childId.value && busy.value[childId.value]))

// ---- the child's steps, kept live ----
const parts = ref<Part[]>([])

function upsert(part: Part) {
  const i = parts.value.findIndex((p) => p.id === part.id)
  if (i >= 0) parts.value.splice(i, 1, part)
  else parts.value.push(part)
}

async function load() {
  if (!childId.value) return
  try {
    const messages = await api.messages(childId.value) as MessageWithParts[]
    parts.value = messages.filter((m) => m.info.role === 'assistant').flatMap((m) => m.parts)
  } catch { /* child gone or not readable (v2 runs) */ }
}

watch(childId, (id) => { if (id) load() }, { immediate: true })
// the final state carries the complete child: one refresh catches anything missed
watch(status, (s) => { if (s === 'completed' || s === 'error') load() })

useOpencodeEvents(directory, (event) => {
  const p = (event.properties || {}) as Record<string, any>
  if (!childId.value) return
  if (event.type === 'message.part.updated' && p.part?.sessionID === childId.value) upsert(p.part as Part)
  else if (event.type === 'message.part.delta' && p.sessionID === childId.value && typeof p.delta === 'string') {
    const field = typeof p.field === 'string' ? p.field : 'text'
    const existing = parts.value.find((x) => x.id === p.partID) as Record<string, any> | undefined
    if (existing) upsert({ ...existing, [field]: String(existing[field] || '') + p.delta } as Part)
    else upsert({ id: p.partID, messageID: p.messageID, sessionID: p.sessionID, type: 'text', [field]: p.delta } as unknown as Part)
  }
})

interface Step { id: string; icon: string; label: string; detail?: string; state: string }
const steps = computed<Step[]>(() => parts.value.flatMap((part): Step[] => {
  const x = part as Record<string, any>
  if (x.type === 'tool') {
    return [{
      id: x.id,
      icon: x.state?.status === 'running' || x.state?.status === 'pending' ? 'i-lucide-loader-circle' : x.state?.status === 'error' ? 'i-lucide-x' : 'i-lucide-check',
      label: x.tool,
      detail: x.state?.title || (x.state?.status === 'error' ? String(x.state?.error || '').split('\n')[0] : undefined),
      state: x.state?.status || 'pending'
    }]
  }
  if (x.type === 'text' && String(x.text || '').trim()) {
    return [{ id: x.id, icon: 'i-lucide-message-square-text', label: 'reply', detail: String(x.text).trim().replace(/\s+/g, ' ').slice(-160), state: 'text' }]
  }
  return []
}))
const toolCount = computed(() => steps.value.filter((s) => s.state !== 'text').length)

const showSteps = ref(false)
const showPrompt = ref(false)
const visibleSteps = computed(() => showSteps.value ? steps.value : steps.value.slice(-3))
const agentName = computed(() => input.value.subagent_type || input.value.agent || 'subagent')
</script>

<template>
  <div class="rounded-sm bg-muted text-sm my-1 overflow-hidden" :class="running ? 'ring-1 ring-primary/30' : ''">
    <div class="flex items-center gap-2 px-2.5 py-2">
      <span class="relative flex size-5 shrink-0 items-center justify-center rounded-full bg-elevated">
        <UIcon name="i-lucide-bot" class="size-3.5" :class="error ? 'text-error' : running ? 'text-highlighted' : 'text-muted'" />
        <span v-if="running" class="absolute inset-0 rounded-full ring-1 ring-primary/60 animate-ping" />
      </span>
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-1.5 min-w-0">
          <UBadge size="sm" color="primary" variant="subtle" class="font-mono shrink-0">@{{ agentName }}</UBadge>
          <span class="truncate text-xs">{{ input.description || state.title || 'Subagent task' }}</span>
        </div>
        <div class="text-[10px] text-dimmed">
          <template v-if="error">failed</template>
          <template v-else-if="running">working · {{ toolCount }} step{{ toolCount === 1 ? '' : 's' }}…</template>
          <template v-else>done · {{ toolCount }} step{{ toolCount === 1 ? '' : 's' }}</template>
        </div>
      </div>
      <UButton
        v-if="childId"
        :to="`/p/${dirParam}/session/${childId}`"
        size="xs"
        variant="soft"
        color="neutral"
        icon="i-lucide-external-link"
        label="Open"
        class="oc-tap shrink-0"
        :aria-label="`Open the ${agentName} subagent's chat`"
      />
    </div>

    <!-- live steps of the child session -->
    <div v-if="steps.length" class="px-2.5 pb-2">
      <TransitionGroup tag="ol" name="oc-list" class="relative space-y-0.5 border-l border-default ml-2 pl-3">
        <li v-for="step in visibleSteps" :key="step.id" class="flex items-start gap-1.5 text-[11px] leading-snug">
          <UIcon
            :name="step.icon"
            class="size-3 mt-0.5 shrink-0"
            :class="[step.icon === 'i-lucide-loader-circle' ? 'animate-spin text-highlighted' : '', step.state === 'error' ? 'text-error' : 'text-dimmed']"
          />
          <span class="font-mono text-muted shrink-0">{{ step.label }}</span>
          <span v-if="step.detail" class="truncate text-dimmed">{{ step.detail }}</span>
        </li>
      </TransitionGroup>
      <button
        v-if="steps.length > 3"
        type="button"
        class="ml-5 mt-0.5 text-[10px] text-dimmed hover:text-highlighted transition-colors"
        @click="showSteps = !showSteps"
      >{{ showSteps ? 'Show fewer' : `Show all ${steps.length} steps` }}</button>
    </div>

    <!-- outcome -->
    <div v-if="error" class="px-2.5 pb-2">
      <pre class="text-xs font-mono rounded p-2 whitespace-pre-wrap bg-error/10 text-error">{{ error }}</pre>
    </div>
    <div v-else-if="status === 'completed' && result" class="mx-2.5 mb-2 rounded-sm bg-elevated/70 px-3 py-2 max-h-80 overflow-y-auto oc-appear">
      <div class="text-[10px] uppercase tracking-widest text-dimmed mb-1">Result</div>
      <Markdown :text="result" class="text-xs" />
    </div>

    <div v-if="input.prompt" class="px-2.5 pb-2">
      <button type="button" class="text-[10px] text-dimmed hover:text-highlighted transition-colors" @click="showPrompt = !showPrompt">
        {{ showPrompt ? 'Hide' : 'Show' }} the instructions it got
      </button>
      <CollapseTransition>
        <pre v-if="showPrompt" class="mt-1 text-[11px] font-mono bg-elevated rounded p-2 whitespace-pre-wrap max-h-48 overflow-y-auto">{{ input.prompt }}</pre>
      </CollapseTransition>
    </div>
  </div>
</template>
