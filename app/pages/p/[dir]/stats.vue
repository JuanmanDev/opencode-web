<script setup lang="ts">
// Usage & cost: every assistant reply of the period (from /api/v1/usage),
// grouped client-side by session, time or model, with the real cost opencode
// recorded next to the same tokens at the model's list price.
const route = useRoute()
const directory = computed(() => decodeDir(route.params.dir as string))

interface UsageTokens { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
interface UsageRow {
  sessionID: string
  parentID?: string
  title?: string
  parentTitle?: string
  time: number
  completed?: number
  providerID: string
  modelID: string
  agent?: string
  cost: number
  tokens: UsageTokens
}
interface ModelPrice { input: number; output: number; cacheRead: number; cacheWrite: number }
interface Usage { generatedAt: number; days: number; rows: UsageRow[]; prices: Record<string, ModelPrice> }

type GroupBy = 'session' | 'day' | 'hour' | 'weekday' | 'model' | 'provider' | 'agent'
type Metric = 'cost' | 'tokens' | 'messages'

const PERIODS = [
  { value: 7, label: '7d' },
  { value: 30, label: '30d' },
  { value: 90, label: '90d' },
  { value: 365, label: 'All' }
]
const GROUPS: Array<{ value: GroupBy; label: string }> = [
  { value: 'session', label: 'Session' },
  { value: 'day', label: 'Day' },
  { value: 'hour', label: 'Hour of day' },
  { value: 'weekday', label: 'Weekday' },
  { value: 'model', label: 'Model' },
  { value: 'provider', label: 'Provider' },
  { value: 'agent', label: 'Agent' }
]
const METRICS: Array<{ value: Metric; label: string }> = [
  { value: 'cost', label: 'Cost' },
  { value: 'tokens', label: 'Tokens' },
  { value: 'messages', label: 'Replies' }
]

const days = ref(30)
const groupBy = ref<GroupBy>('day')
const metric = ref<Metric>('cost')
const includeSubagents = ref(true)

const usage = ref<Usage | null>(null)
const loading = ref(true)
const error = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    usage.value = await $fetch<Usage>('/api/v1/usage', {
      query: { directory: directory.value, days: days.value },
      timeout: 60000
    })
  } catch (e: unknown) {
    const err = e as { data?: { message?: string }; message?: string }
    error.value = err?.data?.message || err?.message || 'Request failed'
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch([days, directory], load)

// ---- pricing ----

/** The same tokens at list price, USD (prices are per 1M tokens; reasoning billed as output). */
function listCost(t: UsageTokens, p: ModelPrice) {
  return (t.input * p.input + (t.output + t.reasoning) * p.output + t.cacheRead * p.cacheRead + t.cacheWrite * p.cacheWrite) / 1_000_000
}

interface PricedRow extends UsageRow {
  /** list-price cost, null when the model has no price */
  est: number | null
}

const rows = computed<PricedRow[]>(() => {
  const prices = usage.value?.prices || {}
  return (usage.value?.rows || [])
    .filter((r) => includeSubagents.value || !r.parentID)
    .map((r) => {
      const price = prices[`${r.providerID}/${r.modelID}`]
      return { ...r, est: price ? listCost(r.tokens, price) : null }
    })
})

const totals = computed(() => {
  const t = { real: 0, est: 0, unknown: 0, messages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sessions: 0 }
  const sessions = new Set<string>()
  for (const r of rows.value) {
    t.real += r.cost
    if (r.est === null) t.unknown++
    else t.est += r.est
    t.messages++
    t.input += r.tokens.input
    t.output += r.tokens.output + r.tokens.reasoning
    t.cacheRead += r.tokens.cacheRead
    t.cacheWrite += r.tokens.cacheWrite
    sessions.add(r.parentID && includeSubagents.value ? r.parentID : r.sessionID)
  }
  t.sessions = sessions.size
  return t
})

/** Models with no list price: their replies are left out of the estimate. */
const unknownModels = computed(() => {
  const m = new Map<string, number>()
  for (const r of rows.value) if (r.est === null) m.set(`${r.providerID}/${r.modelID}`, (m.get(`${r.providerID}/${r.modelID}`) || 0) + 1)
  return [...m].map(([model, count]) => ({ model, count })).sort((a, b) => b.count - a.count)
})

const savings = computed(() => totals.value.est - totals.value.real)

// ---- grouping ----

interface Bucket {
  key: string
  label: string
  sub?: string
  order: number
  to?: string
  real: number
  est: number
  /** replies whose model has no list price */
  unknown: number
  messages: number
  subagent: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

const isTimeGroup = computed(() => ['day', 'hour', 'weekday'].includes(groupBy.value))

const pad = (n: number) => String(n).padStart(2, '0')
function dayKey(ts: number) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
function startOfDay(ts: number) {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
// 2024-01-01 was a Monday: weekday i (0 = Mon) is Jan 1 + i
const weekdayName = (i: number, style: 'short' | 'long' = 'short') =>
  new Date(2024, 0, 1 + i).toLocaleDateString([], { weekday: style })

function newBucket(key: string, label: string, order = 0, extra: Partial<Bucket> = {}): Bucket {
  return { key, label, order, real: 0, est: 0, unknown: 0, messages: 0, subagent: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...extra }
}

const buckets = computed<Bucket[]>(() => {
  const map = new Map<string, Bucket>()
  const get = (key: string, make: () => Bucket) => {
    let b = map.get(key)
    if (!b) map.set(key, (b = make()))
    return b
  }
  const g = groupBy.value

  // time groupings show every slot, empty ones included
  if (g === 'day') {
    const first = rows.value.length ? startOfDay(rows.value[0]!.time) : Date.now()
    let start = first
    if ((usage.value?.days || days.value) <= 90) {
      start = Math.min(first, startOfDay(Date.now() - ((usage.value?.days || days.value) - 1) * 86400_000))
    }
    const end = Date.now()
    for (const d = new Date(start); d.getTime() <= end; d.setDate(d.getDate() + 1)) {
      const ts = d.getTime()
      map.set(dayKey(ts), newBucket(dayKey(ts), d.toLocaleDateString([], { month: 'short', day: 'numeric' }), ts))
    }
  } else if (g === 'hour') {
    for (let h = 0; h < 24; h++) map.set(String(h), newBucket(String(h), `${pad(h)}:00`, h))
  } else if (g === 'weekday') {
    for (let i = 0; i < 7; i++) map.set(String(i), newBucket(String(i), weekdayName(i), i))
  }

  for (const r of rows.value) {
    let b: Bucket
    if (g === 'session') {
      const key = includeSubagents.value && r.parentID ? r.parentID : r.sessionID
      const own = key === r.sessionID
      b = get(key, () => newBucket(key, (own ? r.title : r.parentTitle) || 'Untitled session', 0, {
        to: `/p/${route.params.dir}/session/${key}`
      }))
      if (own && r.title) b.label = r.title
      if (!own) b.subagent++
    } else if (g === 'day') {
      const key = dayKey(r.time)
      b = get(key, () => newBucket(key, new Date(r.time).toLocaleDateString([], { month: 'short', day: 'numeric' }), startOfDay(r.time)))
    } else if (g === 'hour') {
      b = map.get(String(new Date(r.time).getHours()))!
    } else if (g === 'weekday') {
      b = map.get(String((new Date(r.time).getDay() + 6) % 7))!
    } else if (g === 'model') {
      const key = `${r.providerID}/${r.modelID}`
      b = get(key, () => newBucket(key, r.modelID, 0, { sub: r.providerID }))
    } else if (g === 'provider') {
      b = get(r.providerID, () => newBucket(r.providerID, r.providerID))
    } else {
      const key = r.agent || '(none)'
      b = get(key, () => newBucket(key, key))
    }
    add(b, r)
  }
  return [...map.values()]
})

function add(b: Bucket, r: PricedRow) {
  b.real += r.cost
  if (r.est === null) b.unknown++
  else b.est += r.est
  b.messages++
  b.input += r.tokens.input
  b.output += r.tokens.output + r.tokens.reasoning
  b.cacheRead += r.tokens.cacheRead
  b.cacheWrite += r.tokens.cacheWrite
}

const freshTokens = (b: Bucket) => b.input + b.output
const allTokens = (b: Bucket) => b.input + b.output + b.cacheRead + b.cacheWrite

/** [front, back] bar values for the chosen metric: real vs estimated cost, in+out vs all tokens. */
function barValues(b: Bucket): [number, number] {
  if (metric.value === 'cost') return [b.real, b.est]
  if (metric.value === 'tokens') return [freshTokens(b), allTokens(b)]
  return [b.messages, 0]
}
const metricValue = (b: Bucket) => Math.max(...barValues(b))

/** Chart order: time groupings in time order, the rest ranked by the metric. */
const chartBuckets = computed(() => {
  const list = [...buckets.value]
  if (isTimeGroup.value) return list.sort((a, b) => a.order - b.order)
  return list.sort((a, b) => metricValue(b) - metricValue(a))
})
const chartMax = computed(() => Math.max(...chartBuckets.value.map(metricValue), 0) || 1)
const RANKED_LIMIT = 12

/** Table: non-empty buckets; newest day first, hours/weekdays in order, others by value. */
const tableBuckets = computed(() => {
  const list = chartBuckets.value.filter((b) => b.messages > 0)
  return groupBy.value === 'day' ? list.reverse() : list
})

const pct = (v: number) => (v > 0 ? Math.max(1.5, (v / chartMax.value) * 100) : 0)

// tap/hover readout for the vertical chart (bars are too thin for labels)
const active = ref<string | null>(null)
watch([groupBy, days], () => { active.value = null })
const activeBucket = computed(() => chartBuckets.value.find((b) => b.key === active.value) || null)

function longLabel(b: Bucket) {
  if (groupBy.value === 'day') return new Date(b.order).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
  if (groupBy.value === 'hour') return `${pad(b.order)}:00–${pad((b.order + 1) % 24)}:00`
  if (groupBy.value === 'weekday') return weekdayName(b.order, 'long')
  return b.label
}

/** ~5 evenly spaced axis labels under the vertical chart. */
const axisTicks = computed(() => {
  const n = chartBuckets.value.length
  if (!n) return []
  if (n <= 7) return chartBuckets.value.map((b, i) => ({ i, label: b.label, n }))
  const step = Math.ceil((n - 1) / 4)
  const out: Array<{ i: number; label: string; n: number }> = []
  for (let i = 0; i < n; i += step) out.push({ i, label: chartBuckets.value[i]!.label, n })
  if (out[out.length - 1]!.i !== n - 1 && n - 1 - out[out.length - 1]!.i >= step / 2) out.push({ i: n - 1, label: chartBuckets.value[n - 1]!.label, n })
  return out
})
function tickStyle(t: { i: number; n: number }) {
  const left = ((t.i + 0.5) / t.n) * 100
  const shift = t.i === 0 && t.n > 7 ? '0' : t.i === t.n - 1 && t.n > 7 ? '-100%' : '-50%'
  return { left: `${left}%`, transform: `translateX(${shift})` }
}

// ---- formatting ----

function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** Costs: 2 decimals normally; sub-cent amounts keep 4 so they don't all read "$0.00". */
function fmtCost(v: number | undefined) {
  const n = Math.abs(v || 0)
  const sign = (v || 0) < 0 ? '-' : ''
  if (n === 0) return '$0.00'
  return n < 0.01 ? `${sign}$${n.toFixed(4)}` : `${sign}$${n.toFixed(2)}`
}

/** Estimated cost of a bucket; "—" when none of its replies have a price. */
function fmtEst(b: { est: number; unknown: number; messages: number }) {
  if (b.unknown && b.unknown === b.messages) return '—'
  return fmtCost(b.est) + (b.unknown ? '*' : '')
}

function fmtMetric(b: Bucket) {
  if (metric.value === 'cost') return fmtCost(b.real)
  if (metric.value === 'tokens') return fmtTokens(allTokens(b))
  return String(b.messages)
}
function fmtMetricSub(b: Bucket) {
  if (metric.value === 'cost') return `est. ${fmtEst(b)} · ${b.messages} repl${b.messages === 1 ? 'y' : 'ies'}`
  if (metric.value === 'tokens') return `${fmtTokens(freshTokens(b))} in+out · ${b.messages} repl${b.messages === 1 ? 'y' : 'ies'}`
  return `${fmtCost(b.real)} · ${fmtTokens(allTokens(b))} tok`
}

const periodLabel = computed(() => (days.value >= 365 ? 'the last year' : `the last ${days.value} days`))
const hasRows = computed(() => rows.value.length > 0)

useHead(() => ({ title: `Stats · ${dirName(directory.value)} · opencode web` }))
</script>

<template>
  <div class="flex-1 overflow-y-auto overflow-x-hidden pb-[env(safe-area-inset-bottom)]">
    <div class="max-w-4xl mx-auto px-4 py-6">
      <div class="flex items-start gap-2 mb-1">
        <h1 class="text-lg font-semibold flex-1">Usage & cost</h1>
        <UButton
          icon="i-lucide-refresh-cw"
          color="neutral"
          variant="ghost"
          size="sm"
          :loading="loading && !!usage"
          :disabled="loading"
          aria-label="Refresh"
          @click="load"
        />
      </div>
      <p class="text-sm text-muted mb-4">
        Every assistant reply in <span class="font-mono">{{ dirName(directory) }}</span> over {{ periodLabel }}.
      </p>

      <!-- toolbar -->
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2 mb-4">
        <div class="flex items-center gap-1">
          <UButton
            v-for="p in PERIODS"
            :key="p.value"
            :label="p.label"
            size="xs"
            color="neutral"
            :variant="days === p.value ? 'soft' : 'ghost'"
            :class="days === p.value ? 'text-highlighted' : 'text-muted'"
            @click="days = p.value"
          />
        </div>
        <USwitch v-model="includeSubagents" size="xs" label="Include subagents" />
      </div>
      <div class="flex flex-wrap items-center gap-1 mb-6">
        <span class="text-[10px] uppercase tracking-widest text-dimmed mr-1">Group by</span>
        <UButton
          v-for="g in GROUPS"
          :key="g.value"
          :label="g.label"
          size="xs"
          color="neutral"
          :variant="groupBy === g.value ? 'soft' : 'ghost'"
          :class="groupBy === g.value ? 'text-highlighted' : 'text-muted'"
          @click="groupBy = g.value"
        />
      </div>

      <UAlert
        v-if="error"
        class="mb-6"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        title="Couldn't load usage"
        :description="error"
        :actions="[{ label: 'Retry', icon: 'i-lucide-rotate-ccw', color: 'error', variant: 'soft', size: 'xs', onClick: load }]"
      />

      <!-- first load -->
      <template v-if="loading && !usage">
        <div class="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-6">
          <USkeleton v-for="i in 6" :key="i" class="h-20 w-full" />
        </div>
        <USkeleton class="h-48 w-full mb-6" />
        <USkeleton class="h-32 w-full" />
      </template>

      <template v-else-if="usage">
        <!-- KPI tiles -->
        <div class="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-2">
          <div class="bg-muted rounded-sm p-3 min-w-0">
            <div class="text-[10px] uppercase tracking-widest text-dimmed">Real cost</div>
            <div class="text-xl font-semibold font-mono mt-1 truncate">{{ fmtCost(totals.real) }}</div>
            <div class="text-[11px] text-dimmed mt-0.5 truncate">as recorded by opencode</div>
          </div>
          <div class="bg-muted rounded-sm p-3 min-w-0">
            <div class="flex items-center gap-1 text-[10px] uppercase tracking-widest text-dimmed">
              Estimated
              <UTooltip text="The same tokens at the model's list price (input, output + reasoning, cache read and write, per 1M tokens): what it would cost without a promotion.">
                <UIcon name="i-lucide-info" class="size-3" />
              </UTooltip>
            </div>
            <div class="text-xl font-semibold font-mono mt-1 truncate">{{ fmtCost(totals.est) }}</div>
            <div class="text-[11px] text-dimmed mt-0.5 truncate">
              {{ totals.unknown ? `${totals.unknown} replies without a price` : 'at list price' }}
            </div>
          </div>
          <div class="bg-muted rounded-sm p-3 min-w-0">
            <div class="text-[10px] uppercase tracking-widest text-dimmed">
              {{ savings > 0.00005 ? 'Saved' : savings < -0.00005 ? 'Over list price' : 'Difference' }}
            </div>
            <div
              class="text-xl font-semibold font-mono mt-1 truncate"
              :class="savings > 0.00005 ? 'text-success' : savings < -0.00005 ? 'text-warning' : ''"
            >
              {{ fmtCost(Math.abs(savings)) }}
            </div>
            <div class="text-[11px] text-dimmed mt-0.5 truncate">
              <template v-if="savings > 0.00005 && totals.est > 0">{{ Math.round((savings / totals.est) * 100) }}% below list price</template>
              <template v-else-if="savings < -0.00005">real cost above the estimate</template>
              <template v-else>real matches list price</template>
            </div>
          </div>
          <div class="bg-muted rounded-sm p-3 min-w-0">
            <div class="text-[10px] uppercase tracking-widest text-dimmed">Replies</div>
            <div class="text-xl font-semibold font-mono mt-1 truncate">{{ totals.messages }}</div>
            <div class="text-[11px] text-dimmed mt-0.5 truncate">{{ totals.sessions }} session{{ totals.sessions === 1 ? '' : 's' }}</div>
          </div>
          <div class="bg-muted rounded-sm p-3 min-w-0">
            <div class="text-[10px] uppercase tracking-widest text-dimmed">Tokens in / out</div>
            <div class="text-xl font-semibold font-mono mt-1 truncate">{{ fmtTokens(totals.input) }} / {{ fmtTokens(totals.output) }}</div>
            <div class="text-[11px] text-dimmed mt-0.5 truncate">out includes reasoning</div>
          </div>
          <div class="bg-muted rounded-sm p-3 min-w-0">
            <div class="text-[10px] uppercase tracking-widest text-dimmed">Cache read</div>
            <div class="text-xl font-semibold font-mono mt-1 truncate">{{ fmtTokens(totals.cacheRead) }}</div>
            <div class="text-[11px] text-dimmed mt-0.5 truncate">{{ fmtTokens(totals.cacheWrite) }} written</div>
          </div>
        </div>
        <p class="flex gap-1.5 text-xs text-dimmed mb-1">
          <UIcon name="i-lucide-info" class="size-3.5 shrink-0 mt-0.5" />
          <span>
            Real = what opencode recorded (promotions, free tiers and your own pricing included).
            Estimated = the same tokens at the model's list price — what it would cost without a promotion.
          </span>
        </p>
        <p v-if="unknownModels.length" class="text-xs text-dimmed mb-1 pl-5">
          No list price for
          <template v-for="(m, i) in unknownModels" :key="m.model">
            <span class="font-mono text-muted">{{ m.model }}</span> ({{ m.count }}){{ i < unknownModels.length - 1 ? ', ' : '' }}
          </template>
          — left out of the estimate.
        </p>

        <div v-if="!hasRows" class="bg-muted rounded-sm px-3 py-10 mt-6 text-sm text-dimmed text-center">
          No assistant replies in {{ periodLabel }}{{ includeSubagents ? '' : ' (subagents hidden)' }}.
        </div>

        <template v-else>
          <!-- chart -->
          <div class="flex flex-wrap items-center gap-2 mt-6 mb-2">
            <h2 class="text-xs uppercase tracking-widest text-dimmed flex-1">
              {{ GROUPS.find((g) => g.value === groupBy)?.label }}
            </h2>
            <div class="flex items-center gap-1">
              <UButton
                v-for="m in METRICS"
                :key="m.value"
                :label="m.label"
                size="xs"
                color="neutral"
                :variant="metric === m.value ? 'soft' : 'ghost'"
                :class="metric === m.value ? 'text-highlighted' : 'text-muted'"
                @click="metric = m.value"
              />
            </div>
          </div>

          <div class="bg-muted rounded-sm p-3 mb-2">
            <!-- vertical bars over ordered time slots -->
            <template v-if="isTimeGroup">
              <div class="text-xs font-mono min-h-5 mb-2 truncate">
                <template v-if="activeBucket">
                  <span class="text-highlighted">{{ longLabel(activeBucket) }}</span>
                  <span class="text-muted">
                    · {{ fmtCost(activeBucket.real) }} real · est. {{ fmtEst(activeBucket) }}
                    · {{ fmtTokens(allTokens(activeBucket)) }} tok · {{ activeBucket.messages }} repl{{ activeBucket.messages === 1 ? 'y' : 'ies' }}
                  </span>
                </template>
                <span v-else class="text-dimmed">Hover or tap a bar for details</span>
              </div>
              <div
                class="flex items-end h-40"
                :class="chartBuckets.length > 60 ? 'gap-0' : chartBuckets.length > 31 ? 'gap-px' : 'gap-0.5 sm:gap-1'"
                @mouseleave="active = null"
              >
                <button
                  v-for="b in chartBuckets"
                  :key="b.key"
                  type="button"
                  class="relative flex-1 min-w-0 h-full rounded-t-[1px] focus:outline-none"
                  :class="active === b.key ? 'bg-white/5' : ''"
                  :aria-label="`${longLabel(b)}: ${fmtMetric(b)}`"
                  @mouseenter="active = b.key"
                  @focus="active = b.key"
                  @click="active = b.key"
                >
                  <div class="absolute bottom-0 inset-x-0 bg-primary/20" :style="{ height: `${pct(barValues(b)[1])}%` }" />
                  <div
                    class="absolute bottom-0 inset-x-0"
                    :class="active === b.key ? 'bg-primary' : 'bg-primary/65'"
                    :style="{ height: `${pct(barValues(b)[0])}%` }"
                  />
                </button>
              </div>
              <div class="relative h-4 mt-1 text-[10px] text-dimmed font-mono">
                <span
                  v-for="t in axisTicks"
                  :key="t.i"
                  class="absolute top-0 whitespace-nowrap"
                  :style="tickStyle(t)"
                >{{ t.label }}</span>
              </div>
            </template>

            <!-- ranked horizontal bars -->
            <div v-else class="space-y-2.5">
              <div v-for="b in chartBuckets.slice(0, RANKED_LIMIT)" :key="b.key" class="flex items-center gap-3 min-w-0">
                <div class="min-w-0 flex-1">
                  <div class="flex items-baseline gap-1.5 min-w-0">
                    <NuxtLink v-if="b.to" :to="b.to" class="text-sm truncate hover:underline">{{ b.label }}</NuxtLink>
                    <span v-else class="text-sm truncate" :class="b.key.startsWith('(') ? 'text-dimmed' : ''">{{ b.label }}</span>
                    <span v-if="b.sub" class="text-[10px] text-dimmed font-mono shrink-0">{{ b.sub }}</span>
                  </div>
                  <div class="relative mt-1 h-1.5 rounded-full bg-accented overflow-hidden">
                    <div class="absolute inset-y-0 left-0 bg-primary/25" :style="{ width: `${pct(barValues(b)[1])}%` }" />
                    <div class="absolute inset-y-0 left-0 bg-primary/70" :style="{ width: `${pct(barValues(b)[0])}%` }" />
                  </div>
                </div>
                <div class="text-right shrink-0">
                  <div class="text-sm font-mono">{{ fmtMetric(b) }}</div>
                  <div class="text-[10px] text-dimmed font-mono">{{ fmtMetricSub(b) }}</div>
                </div>
              </div>
              <div v-if="chartBuckets.length > RANKED_LIMIT" class="text-xs text-dimmed">
                +{{ chartBuckets.length - RANKED_LIMIT }} more in the table below
              </div>
            </div>
          </div>

          <!-- legend -->
          <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-dimmed mb-6">
            <template v-if="metric === 'cost'">
              <span class="flex items-center gap-1.5"><span class="size-2.5 rounded-[1px] bg-primary/65" />Real cost</span>
              <span class="flex items-center gap-1.5"><span class="size-2.5 rounded-[1px] bg-primary/20" />Estimated at list price</span>
            </template>
            <template v-else-if="metric === 'tokens'">
              <span class="flex items-center gap-1.5"><span class="size-2.5 rounded-[1px] bg-primary/65" />Input + output</span>
              <span class="flex items-center gap-1.5"><span class="size-2.5 rounded-[1px] bg-primary/20" />Incl. cache read/write</span>
            </template>
            <span v-else class="flex items-center gap-1.5"><span class="size-2.5 rounded-[1px] bg-primary/65" />Assistant replies</span>
            <span v-if="groupBy === 'session' && includeSubagents">Subagent replies count toward their parent session.</span>
          </div>

          <!-- detail table -->
          <h2 class="text-xs uppercase tracking-widest text-dimmed mb-2">Details</h2>
          <div class="bg-muted rounded-sm overflow-x-auto">
            <table class="w-full min-w-[640px] text-xs">
              <thead>
                <tr class="text-[10px] uppercase tracking-widest text-dimmed text-right">
                  <th class="text-left font-normal px-3 py-2">{{ GROUPS.find((g) => g.value === groupBy)?.label }}</th>
                  <th class="font-normal px-2 py-2">Replies</th>
                  <th class="font-normal px-2 py-2">In</th>
                  <th class="font-normal px-2 py-2">Out</th>
                  <th class="font-normal px-2 py-2">Cache R</th>
                  <th class="font-normal px-2 py-2">Cache W</th>
                  <th class="font-normal px-2 py-2">Real</th>
                  <th class="font-normal px-3 py-2">Est.</th>
                </tr>
              </thead>
              <tbody class="font-mono">
                <tr v-for="b in tableBuckets" :key="b.key" class="text-right hover:bg-elevated">
                  <td class="text-left font-sans px-3 py-1.5 max-w-64">
                    <NuxtLink v-if="b.to" :to="b.to" class="block truncate hover:underline">{{ b.label }}</NuxtLink>
                    <span v-else class="block truncate">{{ isTimeGroup ? longLabel(b) : b.label }}</span>
                    <span v-if="b.sub || b.subagent" class="block text-[10px] text-dimmed truncate">
                      {{ b.sub || `incl. ${b.subagent} subagent repl${b.subagent === 1 ? 'y' : 'ies'}` }}
                    </span>
                  </td>
                  <td class="px-2 py-1.5">{{ b.messages }}</td>
                  <td class="px-2 py-1.5">{{ fmtTokens(b.input) }}</td>
                  <td class="px-2 py-1.5">{{ fmtTokens(b.output) }}</td>
                  <td class="px-2 py-1.5 text-muted">{{ fmtTokens(b.cacheRead) }}</td>
                  <td class="px-2 py-1.5 text-muted">{{ fmtTokens(b.cacheWrite) }}</td>
                  <td class="px-2 py-1.5 text-highlighted">{{ fmtCost(b.real) }}</td>
                  <td class="px-3 py-1.5 text-muted" :title="b.unknown ? `${b.unknown} replies on models without a list price` : undefined">
                    {{ fmtEst(b) }}
                  </td>
                </tr>
              </tbody>
              <tfoot>
                <tr class="text-right font-mono text-highlighted">
                  <td class="text-left font-sans px-3 py-2 text-[10px] uppercase tracking-widest text-dimmed">Total</td>
                  <td class="px-2 py-2">{{ totals.messages }}</td>
                  <td class="px-2 py-2">{{ fmtTokens(totals.input) }}</td>
                  <td class="px-2 py-2">{{ fmtTokens(totals.output) }}</td>
                  <td class="px-2 py-2">{{ fmtTokens(totals.cacheRead) }}</td>
                  <td class="px-2 py-2">{{ fmtTokens(totals.cacheWrite) }}</td>
                  <td class="px-2 py-2">{{ fmtCost(totals.real) }}</td>
                  <td class="px-3 py-2">{{ fmtEst(totals) }}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p v-if="tableBuckets.some((b) => b.unknown)" class="text-[11px] text-dimmed mt-1.5">
            * part of these replies used a model without a list price.
          </p>
        </template>
      </template>
    </div>
  </div>
</template>
