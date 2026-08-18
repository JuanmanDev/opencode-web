<script setup lang="ts">
const route = useRoute()
const directory = computed(() => decodeDir(route.params.dir as string))
const dirParam = computed(() => route.params.dir as string)

const api = useOpencodeApi(directory)
const projectMeta = useProjectMeta()
const creating = ref(false)

interface Summary {
  sessions: {
    total: number
    totalCost: number
    recent: Array<{ id: string; title?: string; time?: { updated?: number; created?: number }; cost?: number }>
  }
  mcp: Array<{ name: string; status: string }>
  agents: string[]
  models: { count: number; default?: string }
}

const summary = ref<Summary | null>(null)
const loading = ref(true)

onMounted(async () => {
  projectMeta.load()
  // instant paint from the local session cache while the summary loads
  const cached = readSessionsCache(directory.value)
  if (cached.length) {
    summary.value = {
      sessions: {
        total: cached.length,
        totalCost: 0,
        recent: cached.slice(0, 8).map((s) => ({ id: s.id, title: s.title, time: s.time }))
      },
      mcp: [],
      agents: [],
      models: { count: 0 }
    }
  }
  try {
    summary.value = await $fetch<Summary>('/api/v1/project-summary', {
      query: { directory: directory.value },
      timeout: 25000
    })
  } finally {
    loading.value = false
  }
})

async function newSession() {
  creating.value = true
  try {
    const session = await api.createSession()
    navigateTo(`/p/${dirParam.value}/session/${session.id}`)
  } finally {
    creating.value = false
  }
}

function fmtTime(ts?: number) {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 3600_000) return `${Math.max(1, Math.round(diff / 60000))}m ago`
  if (diff < 86400_000) return `${Math.round(diff / 3600_000)}h ago`
  return `${Math.round(diff / 86400_000)}d ago`
}

function statusColor(status: string) {
  if (['connected', 'running', 'ok'].includes(status)) return 'success' as const
  if (['failed', 'error'].includes(status)) return 'error' as const
  if (status === 'disabled') return 'neutral' as const
  return 'warning' as const
}

useHead(() => ({ title: `${dirName(directory.value)} · opencode web` }))
</script>

<template>
  <div class="flex-1 overflow-y-auto">
    <div class="max-w-4xl mx-auto px-4 py-6 space-y-6">
      <!-- header + quick actions -->
      <div>
        <div class="flex flex-wrap items-center gap-3">
          <div class="min-w-0 flex-1">
            <h1 class="text-lg font-semibold truncate">{{ dirName(directory) }}</h1>
            <p class="text-xs text-dimmed font-mono truncate">{{ directory }}</p>
            <p v-if="projectMeta.of(directory).description" class="text-sm text-muted mt-1">
              {{ projectMeta.of(directory).description }}
            </p>
          </div>
          <div class="flex gap-2">
            <UButton color="primary" icon="i-lucide-plus" label="New chat" :loading="creating" @click="newSession" />
            <UButton variant="soft" color="neutral" icon="i-lucide-server-cog" label="MCP" :to="`/p/${dirParam}/mcp`" />
            <UButton variant="soft" color="neutral" icon="i-lucide-chart-column" label="Usage" :to="`/p/${dirParam}/stats`" />
          </div>
        </div>
      </div>

      <!-- summary tiles -->
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <template v-if="loading && !summary">
          <USkeleton v-for="i in 4" :key="i" class="h-16 w-full" />
        </template>
        <template v-else-if="summary">
          <div class="bg-muted rounded-sm p-3 oc-appear">
            <div class="text-[10px] uppercase tracking-widest text-dimmed">Conversations</div>
            <div class="text-lg font-semibold font-mono">{{ summary.sessions.total }}</div>
          </div>
          <div class="bg-muted rounded-sm p-3 oc-appear">
            <div class="text-[10px] uppercase tracking-widest text-dimmed">Total cost</div>
            <div class="text-lg font-semibold font-mono">${{ summary.sessions.totalCost.toFixed(2) }}</div>
          </div>
          <div class="bg-muted rounded-sm p-3 oc-appear">
            <div class="text-[10px] uppercase tracking-widest text-dimmed">Models</div>
            <div class="text-lg font-semibold font-mono">{{ summary.models.count }}</div>
            <div v-if="summary.models.default" class="text-[10px] text-dimmed font-mono truncate">
              {{ summary.models.default }}
            </div>
          </div>
          <div class="bg-muted rounded-sm p-3 oc-appear">
            <div class="text-[10px] uppercase tracking-widest text-dimmed">Agents</div>
            <div class="text-lg font-semibold font-mono">{{ summary.agents.length }}</div>
            <div class="text-[10px] text-dimmed font-mono truncate">{{ summary.agents.join(', ') }}</div>
          </div>
        </template>
      </div>

      <div class="grid sm:grid-cols-5 gap-4">
        <!-- last conversations -->
        <section class="sm:col-span-3">
          <h2 class="text-xs uppercase tracking-widest text-dimmed mb-2">Last conversations</h2>
          <div class="bg-muted rounded-sm divide-y divide-default">
            <NuxtLink
              v-for="s in summary?.sessions.recent || []"
              :key="s.id"
              :to="`/p/${dirParam}/session/${s.id}`"
              class="oc-row flex items-center gap-2.5 px-3 py-2.5 hover:bg-elevated"
            >
              <UIcon
                :name="projectMeta.isFavorite(directory, s.id) ? 'i-lucide-star' : 'i-lucide-message-square'"
                class="size-3.5 shrink-0"
                :class="projectMeta.isFavorite(directory, s.id) ? 'text-primary' : 'text-dimmed'"
              />
              <span class="text-sm truncate flex-1">{{ s.title || 'Untitled session' }}</span>
              <span class="text-[10px] text-dimmed font-mono shrink-0">{{ fmtTime(s.time?.updated || s.time?.created) }}</span>
            </NuxtLink>
            <div v-if="loading && !summary?.sessions.recent.length" class="p-3 space-y-2">
              <USkeleton v-for="i in 4" :key="i" class="h-6 w-full" />
            </div>
            <div v-else-if="!summary?.sessions.recent.length" class="px-3 py-6 text-sm text-dimmed text-center">
              No conversations yet — start the first one.
            </div>
          </div>
        </section>

        <!-- mcp overview -->
        <section class="sm:col-span-2">
          <h2 class="text-xs uppercase tracking-widest text-dimmed mb-2">MCP servers</h2>
          <div class="bg-muted rounded-sm divide-y divide-default">
            <NuxtLink
              v-for="server in (summary?.mcp || []).slice(0, 8)"
              :key="server.name"
              :to="`/p/${dirParam}/mcp`"
              class="oc-row flex items-center gap-2 px-3 py-2 hover:bg-elevated"
            >
              <UIcon name="i-lucide-server" class="size-3.5 text-dimmed shrink-0" />
              <span class="text-xs font-mono truncate flex-1">{{ server.name }}</span>
              <UBadge :color="statusColor(server.status)" variant="subtle" size="sm">{{ server.status }}</UBadge>
            </NuxtLink>
            <div v-if="loading && !summary?.mcp.length" class="p-3 space-y-2">
              <USkeleton v-for="i in 3" :key="i" class="h-5 w-full" />
            </div>
            <div v-else-if="!summary?.mcp.length" class="px-3 py-4 text-xs text-dimmed text-center">
              No MCP servers configured.
            </div>
            <NuxtLink
              v-if="(summary?.mcp.length || 0) > 8"
              :to="`/p/${dirParam}/mcp`"
              class="block px-3 py-2 text-xs text-muted hover:bg-elevated"
            >
              +{{ summary!.mcp.length - 8 }} more…
            </NuxtLink>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
