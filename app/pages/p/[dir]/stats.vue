<script setup lang="ts">
import type { SessionInfo } from '#shared/types/opencode'

const route = useRoute()
const directory = computed(() => decodeDir(route.params.dir as string))
const api = useOpencodeApi(directory)

interface SessionStats extends SessionInfo {
  cost?: number
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
}

const sessions = ref<SessionStats[]>([])
const loading = ref(true)

onMounted(async () => {
  try {
    sessions.value = (await api.sessions() as SessionStats[])
      .filter((s) => !s.parentID)
      .sort((a, b) => (b.cost || 0) - (a.cost || 0))
  } finally {
    loading.value = false
  }
})

const totals = computed(() => sessions.value.reduce(
  (acc, s) => {
    acc.cost += s.cost || 0
    acc.input += s.tokens?.input || 0
    acc.output += s.tokens?.output || 0
    acc.reasoning += s.tokens?.reasoning || 0
    acc.cacheRead += s.tokens?.cache?.read || 0
    return acc
  },
  { cost: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0 }
))

function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function fmtDate(ts?: number) {
  return ts ? new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' }) : ''
}

const maxCost = computed(() => Math.max(...sessions.value.map((s) => s.cost || 0), 0.0001))

useHead(() => ({ title: `Stats · ${dirName(directory.value)} · opencode web` }))
</script>

<template>
  <div class="flex-1 overflow-y-auto">
    <div class="max-w-3xl mx-auto px-4 py-6">
      <h1 class="text-lg font-semibold mb-1">Usage & cost</h1>
      <p class="text-sm text-muted mb-6">
        Totals for <span class="font-mono">{{ dirName(directory) }}</span> across all sessions.
      </p>

      <div v-if="loading" class="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-6">
        <USkeleton v-for="i in 4" :key="i" class="h-20 w-full" />
      </div>
      <div v-else class="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-6">
        <div class="bg-muted rounded-sm p-3">
          <div class="text-[10px] uppercase tracking-widest text-dimmed">Total cost</div>
          <div class="text-xl font-semibold font-mono mt-1">${{ totals.cost.toFixed(2) }}</div>
        </div>
        <div class="bg-muted rounded-sm p-3">
          <div class="text-[10px] uppercase tracking-widest text-dimmed">Sessions</div>
          <div class="text-xl font-semibold font-mono mt-1">{{ sessions.length }}</div>
        </div>
        <div class="bg-muted rounded-sm p-3">
          <div class="text-[10px] uppercase tracking-widest text-dimmed">Tokens in / out</div>
          <div class="text-xl font-semibold font-mono mt-1">{{ fmtTokens(totals.input) }} / {{ fmtTokens(totals.output) }}</div>
        </div>
        <div class="bg-muted rounded-sm p-3">
          <div class="text-[10px] uppercase tracking-widest text-dimmed">Cache read</div>
          <div class="text-xl font-semibold font-mono mt-1">{{ fmtTokens(totals.cacheRead) }}</div>
        </div>
      </div>

      <h2 class="text-xs uppercase tracking-widest text-dimmed mb-2">By session</h2>
      <div class="bg-muted rounded-sm divide-y divide-default">
        <NuxtLink
          v-for="s in sessions"
          :key="s.id"
          :to="`/p/${route.params.dir}/session/${s.id}`"
          class="oc-row flex items-center gap-3 px-3 py-2.5 hover:bg-elevated"
        >
          <div class="min-w-0 flex-1">
            <div class="text-sm truncate">{{ s.title || 'Untitled session' }}</div>
            <div class="mt-1 h-1 rounded-full bg-accented overflow-hidden">
              <div
                class="h-full bg-primary/60"
                :style="{ width: `${Math.max(2, ((s.cost || 0) / maxCost) * 100)}%` }"
              />
            </div>
          </div>
          <div class="text-right shrink-0">
            <div class="text-sm font-mono">${{ (s.cost || 0).toFixed(3) }}</div>
            <div class="text-[10px] text-dimmed font-mono">
              {{ fmtTokens((s.tokens?.input || 0) + (s.tokens?.output || 0)) }} tok · {{ fmtDate(s.time?.updated) }}
            </div>
          </div>
        </NuxtLink>
        <div v-if="!loading && !sessions.length" class="px-3 py-6 text-sm text-dimmed text-center">
          No sessions yet.
        </div>
      </div>
    </div>
  </div>
</template>
