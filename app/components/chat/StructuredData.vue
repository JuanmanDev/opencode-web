<script setup lang="ts">
// Readable view of structured tool data: some MCP servers return JSON meant
// for their own front-end components (e.g. `{ __componentType, message, data }`)
// instead of an HTML/ui:// app. Objects become labelled fields, lists of
// records become tables, nested parts become sub-sections.
defineOptions({ name: 'ChatStructuredData' })

const props = withDefaults(defineProps<{
  value: unknown
  /** heading shown above (e.g. the payload's `message`) */
  title?: string
  depth?: number
}>(), { depth: 0 })

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const isScalar = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v)

/** camelCase / snake_case -> "Camel case" */
function label(key: string) {
  const words = key.replace(/^_+/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

const DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/
function fmt(v: unknown) {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'string' && DATE.test(v)) {
    const d = new Date(v)
    if (!Number.isNaN(d.getTime())) {
      return v.length > 10
        ? d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
        : d.toLocaleDateString([], { dateStyle: 'medium', timeZone: 'UTC' })
    }
  }
  if (typeof v === 'number') return v.toLocaleString()
  return String(v)
}

const STATUS = /status|state/i
function badgeColor(key: string, v: unknown): 'success' | 'error' | 'warning' | 'neutral' | undefined {
  if (typeof v === 'boolean') return v ? 'success' : 'neutral'
  if (!STATUS.test(key) || typeof v !== 'string') return undefined
  if (/paid|confirm|checked.?in|active|ok|success|done|complete/i.test(v)) return 'success'
  if (/cancel|fail|error|unpaid|declin|no.?show/i.test(v)) return 'error'
  return 'warning'
}

const isLink = (v: unknown) => typeof v === 'string' && /^https?:\/\/\S+$/.test(v)

// fields: scalars first (a grid), then nested records / lists as sections
const fields = computed(() => {
  if (!isRec(props.value)) return { scalars: [] as Array<[string, unknown]>, nested: [] as Array<[string, unknown]> }
  const entries = Object.entries(props.value).filter(([k]) => !k.startsWith('__'))
  return {
    scalars: entries.filter(([, v]) => isScalar(v)),
    nested: entries.filter(([, v]) => !isScalar(v) && !(Array.isArray(v) && !v.length))
  }
})

/** a list of records: columns are their scalar keys (first 8) */
const table = computed(() => {
  const list = props.value
  if (!Array.isArray(list) || !list.length || !list.every(isRec)) return null
  const keys: string[] = []
  for (const row of list as Rec[]) {
    for (const [k, v] of Object.entries(row)) if (isScalar(v) && !k.startsWith('__') && !keys.includes(k)) keys.push(k)
  }
  return { keys: keys.slice(0, 8), rows: list as Rec[] }
})
</script>

<template>
  <div class="min-w-0" :class="depth === 0 ? 'rounded-md bg-elevated p-3 space-y-3' : 'space-y-2'">
    <div v-if="title" class="text-sm font-medium text-highlighted">{{ title }}</div>

    <!-- list of records -> table -->
    <div v-if="table" class="overflow-x-auto rounded-sm bg-default/60">
      <table class="w-full text-xs">
        <thead>
          <tr class="text-left text-[10px] uppercase tracking-wide text-dimmed">
            <th v-for="k in table.keys" :key="k" class="px-2 py-1.5 font-medium whitespace-nowrap">{{ label(k) }}</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-default">
          <tr v-for="(row, i) in table.rows" :key="i">
            <td v-for="k in table.keys" :key="k" class="px-2 py-1.5 whitespace-nowrap">
              <UBadge v-if="badgeColor(k, row[k])" size="sm" variant="subtle" :color="badgeColor(k, row[k])">{{ typeof row[k] === 'boolean' ? (row[k] ? 'yes' : 'no') : fmt(row[k]) }}</UBadge>
              <span v-else>{{ fmt(row[k]) }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- list of plain values -> chips -->
    <div v-else-if="Array.isArray(value)" class="flex flex-wrap gap-1">
      <template v-for="(item, i) in value" :key="i">
        <span v-if="isScalar(item)" class="rounded-sm bg-accented/70 px-1.5 py-0.5 text-xs">{{ fmt(item) }}</span>
        <ChatStructuredData v-else :value="item" :depth="depth + 1" class="w-full" />
      </template>
    </div>

    <!-- record -> label/value grid + sub-sections -->
    <template v-else-if="isRec(value)">
      <dl v-if="fields.scalars.length" class="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-x-4 gap-y-2">
        <!-- long text (notes, comments) gets a whole row instead of a tall narrow column -->
        <div v-for="[k, v] in fields.scalars" :key="k" class="min-w-0" :class="typeof v === 'string' && v.length > 60 ? 'col-span-full' : ''">
          <dt class="text-[10px] uppercase tracking-wide text-dimmed truncate">{{ label(k) }}</dt>
          <dd class="text-sm break-words">
            <UBadge v-if="badgeColor(k, v)" size="sm" variant="subtle" :color="badgeColor(k, v)">{{ typeof v === 'boolean' ? (v ? 'yes' : 'no') : fmt(v) }}</UBadge>
            <a v-else-if="isLink(v)" :href="String(v)" target="_blank" rel="noopener noreferrer" class="underline underline-offset-2 break-all">{{ v }}</a>
            <span v-else>{{ fmt(v) }}</span>
          </dd>
        </div>
      </dl>
      <section v-for="[k, v] in fields.nested" :key="k" class="space-y-1.5">
        <h4 class="text-[10px] uppercase tracking-widest text-muted">{{ label(k) }}</h4>
        <ChatStructuredData :value="v" :depth="depth + 1" />
      </section>
    </template>

    <span v-else class="text-sm">{{ fmt(value) }}</span>
  </div>
</template>
