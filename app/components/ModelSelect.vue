<script setup lang="ts">
// Model selector: a searchable dropdown, plus a roomy picker modal when the
// list is long (more than 10 models), so small screens don't scroll forever.
import type { ModelItem } from '~/composables/useModelCatalog'

const props = withDefaults(defineProps<{
  items: ModelItem[]
  loading?: boolean
  placeholder?: string
  size?: 'xs' | 'sm' | 'md'
  /** offer an empty choice with this label ("opencode default") */
  emptyLabel?: string
}>(), { size: 'sm', placeholder: 'Select model' })

const model = defineModel<string>({ default: '' })
const pickerOpen = ref(false)
const selectOpen = ref(false)
const EMPTY = '__default__'

const selectItems = computed(() => [
  ...(props.emptyLabel ? [{ label: props.emptyLabel, value: EMPTY, provider: '', providerID: '', reasoning: false, ctx: 0, cost: '', attachment: false } as ModelItem] : []),
  ...props.items
])
const value = computed({
  get: () => model.value || (props.emptyLabel ? EMPTY : ''),
  set: (v: string) => { model.value = v === EMPTY ? '' : v }
})

const pickerItems = computed(() => [
  ...(props.emptyLabel ? [{ value: EMPTY, label: props.emptyLabel, group: 'Default', icon: 'i-lucide-sparkles' }] : []),
  ...props.items.map((m) => ({
    value: m.value,
    label: m.label,
    group: m.provider,
    detail: m.value,
    icon: m.reasoning ? 'i-lucide-brain' : 'i-lucide-cpu',
    tags: [
      ...(m.ctx ? [`${m.ctx}k ctx`] : []),
      ...(m.cost ? [m.cost] : []),
      ...(m.reasoning ? ['thinking'] : []),
      ...(m.attachment ? ['files'] : [])
    ]
  }))
])

function browseAll() {
  selectOpen.value = false
  pickerOpen.value = true
}

defineExpose({ browseAll })
</script>

<template>
  <USelectMenu
    v-model="value"
    v-model:open="selectOpen"
    :items="selectItems"
    value-key="value"
    :filter-fields="['label', 'provider', 'value']"
    :search-input="{ placeholder: 'Search models or providers…' }"
    :virtualize="{ estimateSize: () => 44 }"
    :loading="loading"
    :placeholder="loading ? 'Loading models…' : placeholder"
    :size="size"
    :ui="{ content: 'max-h-[min(24rem,60dvh)]' }"
    class="w-full min-w-0"
    icon="i-lucide-cpu"
  >
    <template #item="{ item }">
      <div class="flex items-center gap-2 w-full min-w-0">
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm">{{ item.label }}</div>
          <div v-if="item.provider" class="text-[10px] text-dimmed font-mono truncate">
            {{ item.provider }}<template v-if="item.ctx"> · {{ item.ctx }}k ctx</template><template v-if="item.cost"> · {{ item.cost }}</template>
          </div>
        </div>
        <UIcon v-if="item.reasoning" name="i-lucide-brain" class="size-3.5 text-dimmed shrink-0" />
      </div>
    </template>
    <template #empty>
      <div class="flex items-center gap-2 px-2 py-3 text-sm" :class="!loading && serverDegraded ? 'text-error' : 'text-muted'">
        <UIcon v-if="loading" name="i-lucide-loader-circle" class="size-4 animate-spin" />
        <UIcon v-else-if="serverDegraded" name="i-lucide-plug-zap" class="size-4" />
        {{ loading ? 'Loading models…' : (serverDegraded ? 'Server not responding' : 'No models found') }}
      </div>
    </template>
    <!-- always visible, unaffected by the search filter -->
    <template #content-bottom>
      <div class="flex">
        <button
          v-if="items.length > 10"
          class="flex flex-1 items-center gap-2 px-2.5 py-2 text-sm text-highlighted bg-elevated hover:bg-accented cursor-pointer"
          @mousedown.prevent="browseAll"
        >
          <UIcon name="i-lucide-layout-grid" class="size-4 shrink-0" />
          Show all {{ items.length }} models…
        </button>
        <slot name="bottom" />
      </div>
    </template>
  </USelectMenu>
  <PickerModal
    v-model:open="pickerOpen"
    v-model="value"
    :items="pickerItems"
    title="Choose a model"
    :description="`${items.length} models from ${new Set(items.map((i) => i.providerID)).size} providers`"
    placeholder="Search by name, provider or id…"
  />
</template>
