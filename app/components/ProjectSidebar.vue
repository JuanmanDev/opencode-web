<script setup lang="ts">
const props = defineProps<{ directory: string }>()
const emit = defineEmits<{ navigate: [] }>()

const route = useRoute()
const dirParam = computed(() => encodeDir(props.directory))
const { sessions, refreshing, refresh, remove } = useSessions(() => props.directory)
const { busy: busySessions } = useBusySessions()
const projectMeta = useProjectMeta()
const globalSearch = useGlobalSearch()

onMounted(projectMeta.load)

// favorites pinned on top; optional title filter
const sessionFilter = ref('')
const sortedSessions = computed(() => {
  const favs = projectMeta.of(props.directory).favorites
  const q = sessionFilter.value.trim().toLowerCase()
  return [...sessions.value]
    .filter((s) => !q || (s.title || '').toLowerCase().includes(q))
    .sort((a, b) => {
      const favDiff = Number(favs.includes(b.id)) - Number(favs.includes(a.id))
      return favDiff || (b.time?.updated || 0) - (a.time?.updated || 0)
    })
})
const api = useOpencodeApi(() => props.directory)
const toast = useToast()

onMounted(refresh)

async function newSession() {
  try {
    const session = await api.createSession()
    await refresh()
    emit('navigate')
    navigateTo(`/p/${dirParam.value}/session/${session.id}`)
  } catch {
    toast.add({ title: 'Could not create session', color: 'error' })
  }
}

async function deleteSession(id: string) {
  try {
    await api.deleteSession(id)
    remove(id)
    if (route.params.id === id) navigateTo(`/p/${dirParam.value}`)
  } catch {
    toast.add({ title: 'Could not delete session', color: 'error' })
  }
}

function fmtTime(ts?: number) {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}
</script>

<template>
  <div class="flex flex-col h-full">
    <div class="p-3 space-y-2">
      <UButton
        block
        color="primary"
        variant="soft"
        class="justify-start"
        :ui="{ leadingIcon: 'size-4' }"
        icon="i-lucide-plus"
        label="New chat"
        @click="newSession"
      />
      <UButton
        block
        color="neutral"
        variant="ghost"
        class="justify-start"
        :ui="{ leadingIcon: 'size-4' }"
        icon="i-lucide-server-cog"
        label="MCP servers"
        :to="`/p/${dirParam}/mcp`"
        @click="emit('navigate')"
      />
      <UButton
        block
        color="neutral"
        variant="ghost"
        class="justify-start"
        :ui="{ leadingIcon: 'size-4' }"
        icon="i-lucide-chart-column"
        label="Usage & cost"
        :to="`/p/${dirParam}/stats`"
        @click="emit('navigate')"
      />
      <UButton
        block
        color="neutral"
        variant="ghost"
        class="justify-start"
        :ui="{ leadingIcon: 'size-4' }"
        icon="i-lucide-search"
        label="Search everything"
        @click="globalSearch.open.value = true; emit('navigate')"
      />
    </div>

    <div class="flex items-center gap-1.5 px-3 pb-1 text-[10px] uppercase tracking-widest text-dimmed">
      Sessions
      <UIcon v-if="refreshing" name="i-lucide-loader-circle" class="size-3 animate-spin" />
    </div>
    <div class="px-2 pb-1.5">
      <UInput
        v-model="sessionFilter"
        size="xs"
        icon="i-lucide-search"
        placeholder="Search sessions…"
        class="w-full"
        :ui="{ trailing: 'pe-1' }"
      >
        <template v-if="sessionFilter" #trailing>
          <UButton icon="i-lucide-x" size="xs" color="neutral" variant="ghost" @click="sessionFilter = ''" />
        </template>
      </UInput>
    </div>
    <div class="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
      <!-- first load (e.g. opening the mobile menu): skeleton rows -->
      <div v-if="refreshing && !sessions.length" class="px-1 pt-1 space-y-2.5">
        <div v-for="i in 6" :key="i" class="flex items-start gap-2">
          <USkeleton class="size-3.5 rounded-full mt-0.5" />
          <div class="flex-1 space-y-1.5">
            <USkeleton class="h-3.5" :class="['w-3/4', 'w-1/2', 'w-2/3'][i % 3]" />
            <USkeleton class="h-2.5 w-16" />
          </div>
        </div>
      </div>
      <div
        v-for="s in sortedSessions"
        :key="s.id"
        class="group relative"
      >
        <NuxtLink
          :to="`/p/${dirParam}/session/${s.id}`"
          class="oc-row flex items-start gap-2 rounded-sm px-2.5 py-2 text-sm hover:bg-elevated"
          :class="route.params.id === s.id ? 'bg-elevated text-highlighted' : 'text-muted'"
          @click="emit('navigate')"
        >
          <!-- progress icon: spinner while that session is generating -->
          <UIcon
            :name="busySessions[s.id] ? 'i-lucide-loader-circle' : 'i-lucide-message-square'"
            class="size-3.5 shrink-0 mt-0.5"
            :class="busySessions[s.id] ? 'animate-spin text-highlighted' : 'text-dimmed'"
          />
          <div class="min-w-0 flex-1">
            <div class="truncate pr-11">{{ s.title || 'Untitled session' }}</div>
            <div class="text-[10px] text-dimmed font-mono">
              {{ busySessions[s.id] ? 'working…' : fmtTime(s.time?.updated || s.time?.created) }}
            </div>
          </div>
        </NuxtLink>
        <UButton
          icon="i-lucide-star"
          size="xs"
          :color="projectMeta.isFavorite(directory, s.id) ? 'primary' : 'neutral'"
          variant="ghost"
          class="absolute right-7 top-1.5"
          :class="projectMeta.isFavorite(directory, s.id) ? '' : 'opacity-0 group-hover:opacity-100'"
          :aria-label="projectMeta.isFavorite(directory, s.id) ? 'Unfavorite' : 'Favorite'"
          @click.stop.prevent="projectMeta.toggleFavorite(directory, s.id)"
        />
        <UButton
          icon="i-lucide-trash-2"
          size="xs"
          color="neutral"
          variant="ghost"
          class="absolute right-1.5 top-1.5 opacity-0 group-hover:opacity-100"
          @click.stop.prevent="deleteSession(s.id)"
        />
      </div>
      <div v-if="!sessions.length && !refreshing && serverDegraded" class="flex items-center gap-1.5 px-2.5 py-4 text-xs text-error">
        <UIcon name="i-lucide-plug-zap" class="size-3.5 shrink-0" />
        Server not responding
      </div>
      <div v-else-if="!sessions.length && !refreshing" class="px-2.5 py-4 text-xs text-dimmed">No sessions yet</div>
    </div>

    <div class="p-3">
      <UButton
        block
        color="neutral"
        variant="ghost"
        class="justify-start"
        :ui="{ leadingIcon: 'size-4' }"
        icon="i-lucide-arrow-left"
        label="All projects"
        to="/"
      />
    </div>
  </div>
</template>
