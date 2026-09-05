<script setup lang="ts">
import type { MessageWithParts, Part, TokenUsage } from '#shared/types/opencode'

const props = defineProps<{ message: MessageWithParts }>()
const emit = defineEmits<{ fork: []; retry: []; continue: []; edit: [text: string] }>()

const toast = useToast()
const speech = useSpeech()

const messageText = computed(() =>
  (props.message.parts || [])
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text?: string }).text || '')
    .join('\n\n')
    .trim()
)

async function copyMessage() {
  const ok = await copyText(messageText.value)
  toast.add({ title: ok ? 'Copied to clipboard' : 'Copy failed', color: ok ? 'success' : 'error' })
}

function readAloud() {
  if (!speech.toggle(props.message.info.id, messageText.value)) {
    toast.add({ title: 'Speech is not supported in this browser', color: 'warning' })
  }
}

const info = computed(() => props.message.info)
const isUser = computed(() => info.value.role === 'user')

// when the message was sent (server timestamp). Short label always visible,
// full date/time on hover via the native title (works on touch via long-press)
const sentAt = computed(() => info.value.time?.created || 0)
const sentIso = computed(() => (sentAt.value ? new Date(sentAt.value).toISOString() : ''))
const sentFull = computed(() =>
  sentAt.value
    ? new Date(sentAt.value).toLocaleString([], {
      weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    })
    : ''
)
const sentShort = computed(() => {
  if (!sentAt.value) return ''
  const d = new Date(sentAt.value)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (sameDay) return time
  const sameYear = d.getFullYear() === now.getFullYear()
  const day = d.toLocaleDateString([], sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' })
  return `${day} ${time}`
})

const visibleParts = computed<Part[]>(() =>
  (props.message.parts || []).filter((p) => {
    if (p.type === 'step-start' || p.type === 'snapshot') return false
    if (p.type === 'text' && !(p as { text?: string }).text) return false
    return true
  })
)

const showReasoning = ref(false)

function tokenTotal(tokens?: TokenUsage) {
  if (!tokens) return 0
  return (tokens.input || 0) + (tokens.output || 0)
}

const errorMessage = computed(() => {
  const err = info.value.error
  if (!err) return ''
  return err.data?.message || err.name || 'Unknown error'
})
</script>

<template>
  <div class="px-3 sm:px-4 oc-appear">
    <!-- user message -->
    <!-- pr-8 keeps the absolutely-positioned fork button off the text -->
    <div v-if="isUser" class="oc-send group/msg relative border-l-2 border-accented bg-elevated rounded-r-sm pl-3 pr-8 py-2 my-3">
      <UTooltip text="Fork the conversation from here">
        <UButton
          icon="i-lucide-git-branch"
          size="xs"
          color="neutral"
          variant="ghost"
          class="absolute right-1.5 top-1.5 opacity-0 group-hover/msg:opacity-100"
          aria-label="Fork from this message"
          @click="emit('fork')"
        />
      </UTooltip>
      <template v-for="part in visibleParts" :key="part.id">
        <div v-if="part.type === 'text'" class="text-sm whitespace-pre-wrap break-words">{{ (part as any).text }}</div>
        <div v-else-if="part.type === 'file'" class="flex items-center gap-1.5 text-xs text-muted mt-1">
          <UIcon name="i-lucide-paperclip" class="size-3.5" />
          {{ (part as any).filename || (part as any).url }}
        </div>
      </template>
      <!-- sent time + user message actions -->
      <div class="flex items-center gap-2 mt-1 -mb-1 min-w-0">
        <time
          v-if="sentAt"
          :datetime="sentIso"
          :title="sentFull"
          class="text-[10px] font-mono text-dimmed truncate cursor-default"
        >{{ sentShort }}</time>
        <span class="oc-hover-only ml-auto flex items-center gap-0.5 opacity-0 group-hover/msg:opacity-100 transition-opacity">
          <UTooltip text="Copy">
            <UButton icon="i-lucide-copy" size="xs" color="neutral" variant="ghost" aria-label="Copy message" @click="copyMessage" />
          </UTooltip>
          <UTooltip text="Edit and resend">
            <UButton icon="i-lucide-pencil" size="xs" color="neutral" variant="ghost" aria-label="Edit and resend" @click="emit('edit', messageText)" />
          </UTooltip>
        </span>
      </div>
    </div>

    <!-- assistant message -->
    <div v-else class="my-3 space-y-1">
      <template v-for="part in visibleParts" :key="part.id">
        <Markdown v-if="part.type === 'text'" :text="(part as any).text" />

        <div v-else-if="part.type === 'reasoning' && (part as any).text" class="my-1">
          <button
            class="flex items-center gap-1.5 text-xs text-dimmed hover:text-muted cursor-pointer"
            @click="showReasoning = !showReasoning"
          >
            <UIcon name="i-lucide-brain" class="size-3.5" />
            thinking
            <UIcon
              name="i-lucide-chevron-down"
              class="size-3 transition-transform duration-200"
              :class="showReasoning ? 'rotate-180' : ''"
            />
          </button>
          <CollapseTransition>
            <div
              v-if="showReasoning"
              class="mt-1 border-l border-default pl-3 text-xs text-muted whitespace-pre-wrap max-h-64 overflow-y-auto"
            >{{ (part as any).text }}</div>
          </CollapseTransition>
        </div>

        <ChatToolPart v-else-if="part.type === 'tool'" :part="part as any" />

        <div
          v-else-if="part.type === 'step-finish' && tokenTotal((part as any).tokens)"
          class="flex items-center gap-2 text-[11px] text-dimmed font-mono py-0.5"
        >
          <UIcon name="i-lucide-corner-down-right" class="size-3" />
          {{ tokenTotal((part as any).tokens).toLocaleString() }} tok
          <span v-if="(part as any).cost">· ${{ ((part as any).cost as number).toFixed(4) }}</span>
        </div>

        <div v-else-if="part.type === 'patch' || part.type === 'file'" class="text-xs text-muted flex items-center gap-1.5">
          <UIcon name="i-lucide-file-diff" class="size-3.5" />
          {{ (part as any).filename || part.type }}
        </div>
      </template>

      <UAlert
        v-if="errorMessage"
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :title="errorMessage"
        class="mt-2"
        :actions="[
          { label: 'Retry', icon: 'i-lucide-rotate-ccw', color: 'error', variant: 'soft', size: 'xs', onClick: () => emit('retry') },
          { label: 'Continue', icon: 'i-lucide-play', color: 'neutral', variant: 'soft', size: 'xs', onClick: () => emit('continue') }
        ]"
      />

      <div class="group/actions flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-dimmed font-mono pt-1 min-w-0">
        <time
          v-if="sentAt"
          :datetime="sentIso"
          :title="sentFull"
          class="text-[10px] shrink-0 cursor-default"
        >{{ sentShort }}</time>
        <template v-if="info.modelID">
          <span class="truncate max-w-[40vw] sm:max-w-none">{{ info.modelID }}</span>
          <span v-if="info.variant" class="text-muted">{{ info.variant }}</span>
          <span v-if="info.cost">${{ info.cost.toFixed(4) }}</span>
        </template>
        <!-- assistant message actions -->
        <span v-if="messageText" class="flex items-center gap-0.5 ml-auto">
          <UTooltip text="Copy">
            <UButton icon="i-lucide-copy" size="xs" color="neutral" variant="ghost" aria-label="Copy reply" @click="copyMessage" />
          </UTooltip>
          <UTooltip :text="speech.speakingId.value === info.id ? 'Stop reading' : 'Read aloud'">
            <UButton
              :icon="speech.speakingId.value === info.id ? 'i-lucide-square' : 'i-lucide-volume-2'"
              size="xs"
              :color="speech.speakingId.value === info.id ? 'primary' : 'neutral'"
              variant="ghost"
              aria-label="Read aloud"
              @click="readAloud"
            />
          </UTooltip>
          <UTooltip text="Fork from here">
            <UButton icon="i-lucide-git-branch" size="xs" color="neutral" variant="ghost" aria-label="Fork from here" @click="emit('fork')" />
          </UTooltip>
        </span>
      </div>
    </div>
  </div>
</template>
