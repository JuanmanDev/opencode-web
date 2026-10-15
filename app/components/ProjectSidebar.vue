<script setup lang="ts">
const props = defineProps<{ directory: string }>()
const emit = defineEmits<{ navigate: [] }>()
const caps = useCapabilities()

const route = useRoute()
const dirParam = computed(() => encodeDir(props.directory))
const { sessions, children, refreshing, refresh, remove } = useSessions(() => props.directory)

// subagent lists: open on demand, and by themselves while one works or is shown
const subagentToggles = ref<Record<string, boolean>>({})
function subagentsOpen(parentID: string) {
  const manual = subagentToggles.value[parentID]
  if (manual !== undefined) return manual
  return (children.value[parentID] || []).some((c) => c.id === route.params.id || busySessions.value[c.id])
}
function toggleSubagents(parentID: string) {
  subagentToggles.value = { ...subagentToggles.value, [parentID]: !subagentsOpen(parentID) }
}
const { busy: busySessions } = useBusySessions()
const { isUnread } = useSeenSessions()
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

// the shell stays mounted while switching projects: follow the directory
watch(() => props.directory, refresh, { immediate: true })

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

// two-step delete: the first tap arms the button ("Delete?"), a second tap
// within a few seconds deletes. On touch the button is always visible, so a
// stray tap near a row's edge must never destroy a session on its own.
const confirmingDelete = ref<string | null>(null)
let confirmTimer: ReturnType<typeof setTimeout> | undefined

function requestDelete(id: string) {
  clearTimeout(confirmTimer)
  if (confirmingDelete.value === id) {
    confirmingDelete.value = null
    deleteSession(id)
    return
  }
  confirmingDelete.value = id
  confirmTimer = setTimeout(() => { confirmingDelete.value = null }, 3500)
}
onBeforeUnmount(() => clearTimeout(confirmTimer))

async function deleteSession(id: string) {
  try {
    await api.deleteSession(id)
    remove(id)
    if (route.params.id === id) navigateTo(`/p/${dirParam.value}`)
  } catch {
    toast.add({ title: 'Could not delete session', color: 'error' })
  }
}

// ---- tool tiles ----
const { reloading, menuItems } = useReload()
const scheduleCount = ref(0)
watch(() => props.directory, (directory) => {
  if (!import.meta.client) return
  scheduleCount.value = 0
  $fetch<Array<{ enabled: boolean }>>('/api/v1/schedules', { query: { directory }, timeout: 10000 })
    .then((list) => { if (directory === props.directory) scheduleCount.value = list.filter((s) => s.enabled).length })
    .catch(() => {})
}, { immediate: true })

interface Tile {
  key: string
  label: string
  tip: string
  icon: string
  to?: string
  action?: () => void
  menu?: ReturnType<typeof menuItems>
  badge?: string | number
  spin?: boolean
}

const tiles = computed<Tile[]>(() => [
  { key: 'overview', label: 'Project', tip: 'Project overview', icon: 'i-lucide-layout-dashboard', to: `/p/${dirParam.value}` },
  ...(caps.value.mcp ? [{ key: 'mcp', label: 'MCP', tip: 'MCP servers', icon: 'i-lucide-server-cog', to: `/p/${dirParam.value}/mcp` }] : []),
  { key: 'agents', label: 'Agents', tip: 'Agents: models, prompts, MCP access', icon: 'i-lucide-bot', to: `/p/${dirParam.value}/agents` },
  { key: 'skills', label: 'Skills', tip: 'Skills: view, check, allow, write and improve', icon: 'i-lucide-graduation-cap', to: `/p/${dirParam.value}/skills` },
  {
    key: 'schedules',
    label: 'Schedules',
    tip: 'Scheduled prompts',
    icon: 'i-lucide-alarm-clock',
    to: `/p/${dirParam.value}/schedules`,
    badge: scheduleCount.value || undefined
  },
  { key: 'stats', label: 'Usage', tip: 'Usage & cost', icon: 'i-lucide-chart-column', to: `/p/${dirParam.value}/stats` },
  {
    key: 'search',
    label: 'Search',
    tip: 'Search everything (Ctrl+K)',
    icon: 'i-lucide-search',
    action: () => { globalSearch.open.value = true; emit('navigate') }
  },
  ...(caps.value.config
    ? [{
        key: 'reload',
        label: 'Reload',
        tip: 'Reload opencode config',
        icon: reloading.value ? 'i-lucide-loader-circle' : 'i-lucide-rotate-ccw',
        spin: reloading.value,
        menu: menuItems(props.directory)
      }]
    : [])
])

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
      <!-- project tools: one row of labelled tiles -->
      <nav class="grid gap-0.5" :style="{ gridTemplateColumns: `repeat(${tiles.length > 5 ? Math.ceil(tiles.length / 2) : tiles.length}, minmax(0, 1fr))` }" aria-label="Project tools">
        <template v-for="tile in tiles" :key="tile.key">
          <UDropdownMenu v-if="tile.menu" :items="tile.menu" :content="{ align: 'start' }">
            <UTooltip :text="tile.tip">
              <button
                type="button"
                class="oc-tile flex flex-col items-center gap-0.5 rounded-sm py-1.5 text-dimmed hover:bg-elevated hover:text-highlighted w-full"
                :aria-label="tile.tip"
              >
                <UIcon :name="tile.icon" class="size-4" :class="tile.spin ? 'animate-spin' : ''" />
                <span class="text-[10px] leading-none truncate max-w-full">{{ tile.label }}</span>
              </button>
            </UTooltip>
          </UDropdownMenu>
          <UTooltip v-else :text="tile.tip">
            <NuxtLink
              v-if="tile.to"
              :to="tile.to"
              class="oc-tile relative flex flex-col items-center gap-0.5 rounded-sm py-1.5 hover:bg-elevated hover:text-highlighted"
              :class="route.path === tile.to ? 'bg-elevated text-highlighted' : 'text-dimmed'"
              :aria-label="tile.tip"
              @click="emit('navigate')"
            >
              <UIcon :name="tile.icon" class="size-4" />
              <span class="text-[10px] leading-none truncate max-w-full">{{ tile.label }}</span>
              <span
                v-if="tile.badge"
                class="absolute top-0.5 right-1.5 min-w-3.5 h-3.5 px-0.5 rounded-full bg-primary text-[9px] leading-3.5 text-inverted text-center oc-appear"
              >{{ tile.badge }}</span>
            </NuxtLink>
            <button
              v-else
              type="button"
              class="oc-tile flex flex-col items-center gap-0.5 rounded-sm py-1.5 text-dimmed hover:bg-elevated hover:text-highlighted"
              :aria-label="tile.tip"
              @click="tile.action?.()"
            >
              <UIcon :name="tile.icon" class="size-4" />
              <span class="text-[10px] leading-none truncate max-w-full">{{ tile.label }}</span>
            </button>
          </UTooltip>
        </template>
      </nav>
    </div>

    <div class="flex items-center gap-1.5 px-3 pb-1 text-[10px] uppercase tracking-widest text-dimmed">
      Sessions
      <UIcon v-if="refreshing" name="i-lucide-loader-circle" class="size-3 animate-spin" />
    </div>
    <div class="flex items-center gap-1 px-2 pb-1.5">
      <UInput
        v-model="sessionFilter"
        size="xs"
        icon="i-lucide-search"
        placeholder="Search sessions…"
        class="flex-1 min-w-0"
        :ui="{ trailing: 'pe-1' }"
      >
        <template v-if="sessionFilter" #trailing>
          <UButton icon="i-lucide-x" size="xs" color="neutral" variant="ghost" class="relative oc-tap-zone" aria-label="Clear search" @click="sessionFilter = ''" />
        </template>
      </UInput>
    </div>
    <div class="relative flex-1 overflow-y-auto overflow-x-hidden px-2 pb-2 space-y-0.5">
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
      <!-- keyed by project: switching projects swaps the list at once instead
           of sliding every row out and the new ones in -->
      <TransitionGroup :key="directory" name="oc-list">
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
            <div class="truncate pr-11 pointer-coarse:pr-20" :class="isUnread(s) && route.params.id !== s.id ? 'text-highlighted font-medium' : ''">
              <span v-if="isUnread(s) && route.params.id !== s.id" class="inline-block size-1.5 rounded-full bg-primary align-middle mr-1" title="New activity since you last opened it" />{{ s.title || 'Untitled session' }}
            </div>
            <div class="text-[10px] text-dimmed font-mono">
              {{ busySessions[s.id] ? 'working…' : fmtTime(s.time?.updated || s.time?.created) }}
            </div>
          </div>
        </NuxtLink>
        <!-- hover-revealed on desktop, always visible on touch (oc-hover-only) -->
        <UButton
          v-if="confirmingDelete !== s.id"
          icon="i-lucide-star"
          size="xs"
          color="neutral"
          variant="ghost"
          class="oc-tap absolute right-7 top-1.5 pointer-coarse:right-12 pointer-coarse:top-1"
          :class="projectMeta.isFavorite(directory, s.id) ? 'text-amber-400 hover:text-amber-300' : 'oc-hover-only opacity-0 group-hover:opacity-100'"
          :ui="{ leadingIcon: projectMeta.isFavorite(directory, s.id) ? 'oc-filled' : '' }"
          :aria-label="projectMeta.isFavorite(directory, s.id) ? 'Unfavorite session' : 'Favorite session'"
          @click.stop.prevent="projectMeta.toggleFavorite(directory, s.id)"
        />
        <UButton
          v-if="confirmingDelete === s.id"
          icon="i-lucide-trash-2"
          size="xs"
          color="error"
          variant="solid"
          label="Delete?"
          class="oc-tap absolute right-1.5 top-1.5 pointer-coarse:top-1 oc-appear"
          aria-label="Confirm delete session"
          @click.stop.prevent="requestDelete(s.id)"
        />
        <UButton
          v-else
          icon="i-lucide-trash-2"
          size="xs"
          color="neutral"
          variant="ghost"
          class="oc-tap oc-hover-only absolute right-1.5 top-1.5 pointer-coarse:top-1 opacity-0 group-hover:opacity-100"
          aria-label="Delete session"
          @click.stop.prevent="requestDelete(s.id)"
        />
        <!-- subagent sessions started by this conversation (task tool) -->
        <template v-if="children[s.id]?.length">
          <button
            type="button"
            class="flex items-center gap-1 ml-7 -mt-1 mb-0.5 px-1 py-0.5 rounded-sm text-[10px] text-dimmed hover:text-highlighted transition-colors"
            :aria-expanded="subagentsOpen(s.id)"
            @click="toggleSubagents(s.id)"
          >
            <UIcon name="i-lucide-chevron-right" class="size-3 transition-transform duration-200" :class="subagentsOpen(s.id) ? 'rotate-90' : ''" />
            <UIcon name="i-lucide-bot" class="size-3" />
            {{ children[s.id]!.length }} subagent{{ children[s.id]!.length === 1 ? '' : 's' }}
            <UIcon v-if="children[s.id]!.some((c) => busySessions[c.id])" name="i-lucide-loader-circle" class="size-3 animate-spin text-highlighted" />
          </button>
          <CollapseTransition>
            <div v-if="subagentsOpen(s.id)" class="ml-6 pl-2 border-l border-default space-y-0.5 mb-1">
              <NuxtLink
                v-for="c in children[s.id]"
                :key="c.id"
                :to="`/p/${dirParam}/session/${c.id}`"
                class="oc-row flex items-center gap-1.5 rounded-sm px-2 py-1 text-xs hover:bg-elevated"
                :class="route.params.id === c.id ? 'bg-elevated text-highlighted' : 'text-muted'"
                @click="emit('navigate')"
              >
                <UIcon
                  :name="busySessions[c.id] ? 'i-lucide-loader-circle' : 'i-lucide-bot'"
                  class="size-3 shrink-0"
                  :class="busySessions[c.id] ? 'animate-spin text-highlighted' : 'text-dimmed'"
                />
                <span class="truncate">{{ (c.title || 'Subagent').replace(/\s*\(@[\w-]+ subagent\)$/, '') }}</span>
                <span v-if="c.agent" class="ml-auto shrink-0 text-[9px] font-mono text-dimmed">@{{ c.agent }}</span>
              </NuxtLink>
            </div>
          </CollapseTransition>
        </template>
      </div>
      </TransitionGroup>
      <div v-if="!sessions.length && !refreshing && serverDegraded" class="flex items-center gap-1.5 px-2.5 py-4 text-xs text-error">
        <UIcon name="i-lucide-plug-zap" class="size-3.5 shrink-0" />
        Server not responding
      </div>
      <div v-else-if="!sessions.length && !refreshing" class="px-2.5 py-4 text-xs text-dimmed">No sessions yet</div>
    </div>

    <!-- desktop has "All projects" in the header; the phone menu needs it here -->
    <div class="md:hidden p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <UButton
        block
        color="neutral"
        variant="ghost"
        class="justify-start"
        :ui="{ leadingIcon: 'size-4' }"
        icon="i-lucide-layout-grid"
        label="All projects"
        to="/"
        @click="emit('navigate')"
      />
    </div>
  </div>
</template>
