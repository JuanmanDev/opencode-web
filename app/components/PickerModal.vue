<script setup lang="ts">
// Roomy chooser for long lists (models, agents): a search field and a grid of
// cards grouped by section, using the screen's width instead of a tall
// dropdown with a long scroll. Arrow keys move, Enter picks.

export interface PickerItem {
  value: string
  label: string
  /** section heading (provider, agent mode…) */
  group?: string
  /** second line */
  detail?: string
  icon?: string
  /** small tags on the right (e.g. "128k", "$3/15") */
  tags?: string[]
  /** extra text matched by the search */
  keywords?: string
}

const props = defineProps<{
  items: PickerItem[]
  title: string
  description?: string
  placeholder?: string
}>()

const open = defineModel<boolean>('open', { default: false })
const model = defineModel<string>({ default: '' })
const emit = defineEmits<{ pick: [value: string] }>()

const query = ref('')
const active = ref(0)
const searchRef = ref<{ inputRef?: HTMLInputElement } | null>(null)

const filtered = computed(() => {
  const words = query.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return props.items
  return props.items.filter((item) => {
    const hay = `${item.label} ${item.value} ${item.group || ''} ${item.detail || ''} ${item.keywords || ''}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
})

const groups = computed(() => {
  const map = new Map<string, Array<PickerItem & { index: number }>>()
  filtered.value.forEach((item, index) => {
    const key = item.group || ''
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push({ ...item, index })
  })
  return [...map.entries()].map(([name, list]) => ({ name, list }))
})

watch(open, (now) => {
  if (!now) return
  query.value = ''
  active.value = Math.max(0, props.items.findIndex((i) => i.value === model.value))
  nextTick(() => {
    searchRef.value?.inputRef?.focus()
    document.querySelector(`[data-picker-index="${active.value}"]`)?.scrollIntoView({ block: 'center' })
  })
})
watch(query, () => { active.value = 0 })

function pick(value: string) {
  model.value = value
  emit('pick', value)
  open.value = false
}

// grid navigation: left/right step, up/down jump a row of the current grid
function columns() {
  const grid = document.querySelector('[data-picker-grid]') as HTMLElement | null
  if (!grid) return 1
  return getComputedStyle(grid).gridTemplateColumns.split(' ').length || 1
}

function onKeydown(e: KeyboardEvent) {
  const n = filtered.value.length
  if (!n) return
  const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns(), ArrowUp: -columns() }[e.key]
  if (step) {
    e.preventDefault()
    active.value = Math.min(n - 1, Math.max(0, active.value + step))
    nextTick(() => document.querySelector(`[data-picker-index="${active.value}"]`)?.scrollIntoView({ block: 'nearest' }))
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const item = filtered.value[active.value]
    if (item) pick(item.value)
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="title"
    :description="description"
    :ui="{ content: 'sm:max-w-5xl', body: 'p-0 sm:p-0' }"
  >
    <template #body>
      <div class="flex flex-col max-h-[75dvh]" @keydown="onKeydown">
        <div class="p-3 sm:px-4 shrink-0">
          <UInput
            ref="searchRef"
            v-model="query"
            icon="i-lucide-search"
            :placeholder="placeholder || 'Search…'"
            class="w-full"
            autofocus
          >
            <template #trailing>
              <span class="text-[11px] text-dimmed font-mono">{{ filtered.length }}/{{ items.length }}</span>
            </template>
          </UInput>
        </div>
        <div class="flex-1 overflow-y-auto overscroll-contain px-3 sm:px-4 pb-4 space-y-4">
          <section v-for="g in groups" :key="g.name">
            <h3 v-if="g.name" class="sticky top-0 z-10 bg-default/95 backdrop-blur py-1 text-[10px] uppercase tracking-widest text-dimmed">
              {{ g.name }} <span class="normal-case tracking-normal">· {{ g.list.length }}</span>
            </h3>
            <div data-picker-grid class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5">
              <button
                v-for="item in g.list"
                :key="item.value"
                type="button"
                :data-picker-index="item.index"
                class="flex items-start gap-2 rounded-sm px-2.5 py-2 text-left transition-colors cursor-pointer min-w-0"
                :class="[
                  item.value === model ? 'bg-accented text-highlighted ring-1 ring-inset ring-(--ui-border-inverted)/40' : 'bg-muted hover:bg-elevated',
                  item.index === active ? 'outline outline-1 outline-(--ui-border-inverted)/60' : ''
                ]"
                @click="pick(item.value)"
                @mouseenter="active = item.index"
              >
                <UIcon :name="item.value === model ? 'i-lucide-circle-check' : (item.icon || 'i-lucide-circle')" class="size-4 mt-0.5 shrink-0" :class="item.value === model ? 'text-highlighted' : 'text-dimmed'" />
                <div class="min-w-0 flex-1">
                  <div class="text-sm truncate">{{ item.label }}</div>
                  <div v-if="item.detail" class="text-[11px] text-dimmed font-mono truncate">{{ item.detail }}</div>
                  <div v-if="item.tags?.length" class="flex flex-wrap gap-1 mt-1">
                    <span v-for="tag in item.tags" :key="tag" class="rounded-sm bg-elevated px-1 text-[10px] font-mono text-muted">{{ tag }}</span>
                  </div>
                </div>
              </button>
            </div>
          </section>
          <p v-if="!filtered.length" class="py-10 text-center text-sm text-dimmed">Nothing matches “{{ query }}”.</p>
        </div>
      </div>
    </template>
  </UModal>
</template>
