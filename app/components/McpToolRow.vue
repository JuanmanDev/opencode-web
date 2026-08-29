<script setup lang="ts">
// Shared per-tool mode row (name + description + mode select), used by the
// MCP settings page (persisted to config) and the chat options (per-prompt).
const props = defineProps<{
  name: string
  description?: string
  /** MCP Apps: renders an interactive UI in the chat */
  ui?: boolean
  modelValue: 'inherit' | 'deny' | 'ask' | 'allow'
  /** per-prompt scope: opencode has no per-message ask */
  askDisabled?: boolean
  disabled?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [mode: 'inherit' | 'deny' | 'ask' | 'allow'] }>()

const items = computed(() => [
  { label: 'inherit', value: 'inherit' },
  { label: 'off', value: 'deny' },
  {
    label: 'ask',
    value: 'ask',
    disabled: props.askDisabled
  },
  { label: 'auto', value: 'allow' }
])
</script>

<template>
  <div class="flex items-center gap-2">
    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-1.5 min-w-0">
        <span
          class="font-mono text-xs leading-tight truncate"
          :class="modelValue === 'deny' ? 'text-dimmed line-through' : ''"
        >{{ name }}</span>
        <UTooltip v-if="ui" text="Renders an interactive app in the chat (MCP Apps)">
          <UBadge size="sm" variant="subtle" color="primary" class="shrink-0 text-[9px] leading-none px-1 py-0.5">UI</UBadge>
        </UTooltip>
      </div>
      <div v-if="description" class="text-[10px] text-dimmed truncate leading-tight">{{ description }}</div>
    </div>
    <USelect
      :items="items"
      value-key="value"
      :model-value="modelValue"
      :disabled="disabled"
      size="xs"
      class="w-24 shrink-0"
      @update:model-value="(v) => emit('update:modelValue', v as any)"
    />
  </div>
</template>
