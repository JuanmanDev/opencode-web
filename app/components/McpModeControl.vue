<script setup lang="ts">
// Shared tri-state control for MCP servers: off / ask / auto.
// `askDisabled` is used in per-prompt scope, where opencode has no
// per-message "ask" concept (only the project config supports it).
const props = defineProps<{
  modelValue: 'off' | 'ask' | 'allow'
  askDisabled?: boolean
  loading?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [mode: 'off' | 'ask' | 'allow'] }>()

const MODES = ['off', 'ask', 'allow'] as const

function labelFor(mode: string) {
  return mode === 'allow' ? 'auto' : mode
}
</script>

<template>
  <div class="flex items-center rounded-sm overflow-hidden shrink-0">
    <template v-for="mode in MODES" :key="mode">
      <UTooltip
        :text="mode === 'ask' && askDisabled
          ? 'Per-prompt ask is not supported by opencode — set it project-wide in MCP settings'
          : undefined"
        :disabled="!(mode === 'ask' && askDisabled)"
      >
        <UButton
          size="xs"
          :label="labelFor(mode)"
          :color="props.modelValue === mode ? (mode === 'off' ? 'neutral' : 'primary') : 'neutral'"
          :variant="props.modelValue === mode ? 'solid' : 'soft'"
          :disabled="(mode === 'ask' && askDisabled) || loading"
          class="rounded-none"
          @click="emit('update:modelValue', mode)"
        />
      </UTooltip>
    </template>
  </div>
</template>
