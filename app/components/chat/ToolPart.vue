<script setup lang="ts">
import type { ToolPart } from '#shared/types/opencode'

const props = defineProps<{ part: ToolPart }>()

const open = ref(false)

const state = computed(() => props.part.state || { status: 'pending' })
const status = computed(() => state.value.status || 'pending')

const title = computed(() => {
  const s = state.value as unknown as Record<string, unknown>
  return (s.title as string) || props.part.tool
})

const statusUi = computed(() => {
  switch (status.value) {
    case 'completed': return { color: 'success' as const, icon: 'i-lucide-check' }
    case 'error': return { color: 'error' as const, icon: 'i-lucide-x' }
    case 'running': return { color: 'warning' as const, icon: 'i-lucide-loader-circle' }
    default: return { color: 'neutral' as const, icon: 'i-lucide-clock' }
  }
})

// the `question` tool gets a readable rendering instead of raw JSON
interface QuestionInput { question: string; header?: string; options?: Array<{ label: string; description?: string }> }
const questionData = computed<QuestionInput[]>(() => {
  if (props.part.tool !== 'question') return []
  const s = state.value as unknown as Record<string, any>
  return Array.isArray(s.input?.questions) ? s.input.questions : []
})

const input = computed(() => {
  const s = state.value as unknown as Record<string, unknown>
  if (!s.input) return ''
  try { return JSON.stringify(s.input, null, 2) } catch { return String(s.input) }
})

const output = computed(() => {
  const s = state.value as unknown as Record<string, unknown>
  if (status.value === 'error') return String(s.error || '')
  const out = s.output
  return typeof out === 'string' ? out : out ? JSON.stringify(out, null, 2) : ''
})

interface HtmlResource { html?: string; url?: string; title?: string }

// MCP UI / MCP Apps: tools can return ui:// resources (text/html or external
// URLs). Scan metadata + parseable output for them and render live.
const htmlResources = computed<HtmlResource[]>(() => {
  const found: HtmlResource[] = []
  const visit = (node: unknown, depth: number) => {
    if (!node || typeof node !== 'object' || depth > 6) return
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1)
      return
    }
    const obj = node as Record<string, unknown>
    const uri = typeof obj.uri === 'string' ? obj.uri : undefined
    const mime = typeof obj.mimeType === 'string' ? obj.mimeType : undefined
    if (uri?.startsWith('ui://') || mime === 'text/html') {
      if (typeof obj.text === 'string' && obj.text.trim()) {
        found.push({ html: obj.text, title: uri })
        return
      }
    }
    if (mime === 'text/uri-list' && typeof obj.text === 'string') {
      const url = obj.text.split('\n').find((l) => l.trim() && !l.startsWith('#'))
      if (url) { found.push({ url: url.trim(), title: uri }); return }
    }
    for (const value of Object.values(obj)) visit(value, depth + 1)
  }
  const s = state.value as unknown as Record<string, unknown>
  visit(s.metadata, 0)
  if (found.length === 0 && typeof s.output === 'string' && s.output.startsWith('{')) {
    try { visit(JSON.parse(s.output), 0) } catch { /* not JSON */ }
  }
  return found.slice(0, 3)
})
</script>

<template>
  <!-- readable card for the agent's question tool -->
  <div v-if="questionData.length" class="rounded-sm bg-muted text-sm my-1 px-3 py-2.5 space-y-2">
    <div class="flex items-center gap-2">
      <UIcon name="i-lucide-message-circle-question" class="size-4 text-primary shrink-0" />
      <span class="text-[10px] uppercase tracking-widest text-dimmed">The agent asked</span>
      <UBadge v-if="status === 'completed'" color="success" variant="subtle" size="sm">answered</UBadge>
      <UBadge v-else color="warning" variant="subtle" size="sm">waiting</UBadge>
    </div>
    <div v-for="(q, i) in questionData" :key="i" class="space-y-1">
      <p class="text-sm">{{ q.question }}</p>
      <div class="flex flex-wrap gap-1">
        <UBadge
          v-for="opt in q.options || []"
          :key="opt.label"
          color="neutral"
          variant="subtle"
          size="sm"
        >{{ opt.label }}</UBadge>
      </div>
    </div>
    <pre v-if="status === 'completed' && output" class="text-xs font-mono bg-elevated rounded p-2 whitespace-pre-wrap">{{ output }}</pre>
    <p v-else class="text-xs text-dimmed">
      Answer with the card at the bottom of the conversation. If no card is shown,
      this question expired after a server restart — just send a new message to continue.
    </p>
  </div>

  <div v-else class="rounded-sm bg-muted text-sm my-1">
    <button
      class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left cursor-pointer"
      @click="open = !open"
    >
      <UIcon
        :name="statusUi.icon"
        class="size-3.5 shrink-0"
        :class="[
          status === 'running' ? 'animate-spin text-highlighted' : '',
          status === 'completed' ? 'text-muted' : '',
          status === 'error' ? 'text-error' : 'text-dimmed'
        ]"
      />
      <span class="font-mono text-xs text-muted shrink-0">{{ part.tool }}</span>
      <span class="truncate text-xs text-dimmed">{{ title !== part.tool ? title : '' }}</span>
      <UIcon
        name="i-lucide-chevron-down"
        class="size-3.5 ml-auto shrink-0 text-dimmed transition-transform duration-200"
        :class="open ? 'rotate-180' : ''"
      />
    </button>

    <CollapseTransition>
    <div v-if="open" class="px-2.5 py-2 space-y-2">
      <div v-if="input">
        <div class="text-[10px] uppercase tracking-wide text-dimmed mb-1">Input</div>
        <pre class="text-xs font-mono bg-elevated rounded p-2 overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap">{{ input }}</pre>
      </div>
      <div v-if="output">
        <div class="text-[10px] uppercase tracking-wide text-dimmed mb-1">
          {{ status === 'error' ? 'Error' : 'Output' }}
        </div>
        <pre
          class="text-xs font-mono rounded p-2 overflow-x-auto max-h-72 overflow-y-auto whitespace-pre-wrap"
          :class="status === 'error' ? 'bg-error/10 text-error' : 'bg-elevated'"
        >{{ output.length > 20000 ? output.slice(0, 20000) + '\n… (truncated)' : output }}</pre>
      </div>
    </div>
    </CollapseTransition>

    <div v-if="htmlResources.length" class="px-2.5 pb-2 space-y-2" :class="{ 'pt-2': !open }">
      <ChatMcpHtmlFrame
        v-for="(res, i) in htmlResources"
        :key="i"
        :html="res.html"
        :url="res.url"
        :title="res.title"
      />
    </div>
  </div>
</template>
