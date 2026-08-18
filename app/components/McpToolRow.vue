<script setup lang="ts">
// Shared per-tool mode row (name + description + mode select), used by the
// MCP settings page (persisted to config) and the chat options (per-prompt).
const props = defineProps<{
  name: string
  description?: string
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
      <div class="font-mono text-xs" :class="modelValue === 'deny' ? 'text-dimmed line-through' : ''">
        {{ name }}
      </div>
      <div v-if="description" class="text-[10px] text-dimmed truncate">{{ description }}</div>
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
