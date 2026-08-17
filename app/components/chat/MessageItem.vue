<script setup lang="ts">
import type { MessageWithParts, Part, TokenUsage } from '#shared/types/opencode'

const props = defineProps<{ message: MessageWithParts }>()

const info = computed(() => props.message.info)
const isUser = computed(() => info.value.role === 'user')

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
    <div v-if="isUser" class="oc-send border-l-2 border-accented bg-elevated rounded-r-sm px-3 py-2 my-3">
      <template v-for="part in visibleParts" :key="part.id">
        <div v-if="part.type === 'text'" class="text-sm whitespace-pre-wrap break-words">{{ (part as any).text }}</div>
        <div v-else-if="part.type === 'file'" class="flex items-center gap-1.5 text-xs text-muted mt-1">
          <UIcon name="i-lucide-paperclip" class="size-3.5" />
          {{ (part as any).filename || (part as any).url }}
        </div>
      </template>
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
      />

      <div v-if="info.modelID" class="flex items-center gap-2 text-[11px] text-dimmed font-mono pt-1">
        <span>{{ info.modelID }}</span>
        <span v-if="info.variant" class="text-muted">{{ info.variant }}</span>
        <span v-if="info.cost">${{ info.cost.toFixed(4) }}</span>
      </div>
    </div>
  </div>
</template>
