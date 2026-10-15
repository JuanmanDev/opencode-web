<script setup lang="ts">
// Desktop projects panel: every project, and under each one the chats worth
// coming back to: starred ones, then the recent ones (used in the last hours,
// unread ones a few days longer, running ones always). "More" lists up to
// N chats; everything is configurable (gear button).
import type { Project, SessionInfo } from '#shared/types/opencode'
import { pickRecentChats, shortAge, type ChatPick, type RecentChatsSettings } from '~/utils/recentChats'

const props = defineProps<{ directory: string }>()
const emit = defineEmits<{ close: [] }>()

const route = useRoute()
const api = useOpencodeApi()
const { recents } = useRecentProjects()
const projectMeta = useProjectMeta()
const { settings, save, reset } = useRecentChatsSettings()
const { isUnread } = useSeenSessions()
const { busy: liveBusy } = useBusySessions()
// the open project's list is live (SSE); others are fetched while the panel shows
const live = useSessions(() => props.directory)

const projects = ref<Project[]>([])
const loading = ref(false)
const filter = ref('')

const projectDirs = computed(() => {
  const seen = new Set<string>()
  const list: string[] = []
  for (const r of recents.value) if (!seen.has(r.directory)) { seen.add(r.directory); list.push(r.directory) }
  for (const p of projects.value) {
    if (p.worktree && p.worktree !== '/' && !seen.has(p.worktree)) { seen.add(p.worktree); list.push(p.worktree) }
  }
  const q = filter.value.trim().toLowerCase()
  return q ? list.filter((d) => d.toLowerCase().includes(q)) : list
})

// ---- chats per project ----
const chats = ref<Record<string, SessionInfo[]>>({})
const busyByDir = ref<Record<string, Record<string, boolean>>>({})

const scanned = computed(() => projectDirs.value.slice(0, Math.max(0, settings.value.maxProjects)))

async function loadChats(dir: string) {
  if (!chats.value[dir]) {
    const cached = readSessionsCache(dir)
    if (cached.length) chats.value = { ...chats.value, [dir]: cached }
  }
  const scoped = useOpencodeApi(() => dir)
  const [list, status] = await Promise.all([
    scoped.sessions().catch(() => null),
    ocFetch<Record<string, { type?: string }>>('/api/opencode/session/status', { query: { directory: dir }, timeout: 10_000 }).catch(() => null)
  ])
  if (list) chats.value = { ...chats.value, [dir]: list }
  if (status && typeof status === 'object') {
    busyByDir.value = {
      ...busyByDir.value,
      [dir]: Object.fromEntries(Object.entries(status).filter(([, s]) => s?.type && s.type !== 'idle').map(([id]) => [id, true]))
    }
  }
}

async function loadAll() {
  loading.value = true
  try {
    projects.value = await api.projects().catch(() => projects.value)
    await Promise.all(scanned.value.filter((d) => d !== props.directory).map(loadChats))
  } finally {
    loading.value = false
  }
}

let poll: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  loadAll()
  // other projects have no live stream here: refresh them now and then
  poll = setInterval(() => { if (document.visibilityState === 'visible') loadAll() }, 60_000)
})
onBeforeUnmount(() => clearInterval(poll))
watch(() => settings.value.maxProjects, () => loadAll())

function sessionsOf(dir: string): SessionInfo[] {
  if (dir === props.directory) {
    const kids = settings.value.includeSubagents ? Object.values(live.children.value).flat() : []
    return [...live.sessions.value, ...kids]
  }
  return chats.value[dir] || []
}

const expanded = ref<Record<string, boolean>>({})
const collapsed = useCookie<string[]>('oc-projects-collapsed', { default: () => [] })
function toggleCollapsed(dir: string) {
  collapsed.value = collapsed.value.includes(dir) ? collapsed.value.filter((d) => d !== dir) : [...collapsed.value, dir]
}

function picksOf(dir: string) {
  return pickRecentChats(sessionsOf(dir), {
    settings: settings.value,
    favorites: projectMeta.of(dir).favorites,
    isUnread,
    busy: dir === props.directory ? liveBusy.value : (busyByDir.value[dir] || {})
  })
}
const picks = computed(() => Object.fromEntries(scanned.value.map((dir) => [dir, picksOf(dir)])))
const unreadCount = (dir: string) => {
  const p = picks.value[dir]
  return p ? [...p.starred, ...p.recent, ...p.more].filter((c) => c.unread).length : 0
}
function visible(dir: string): ChatPick[] {
  const p = picks.value[dir]
  if (!p) return []
  return [...p.starred, ...p.recent, ...(expanded.value[dir] ? p.more : [])]
}

const chatLink = (dir: string, id: string) => `/p/${encodeDir(dir)}/session/${id}`
const cleanTitle = (s: SessionInfo) => (s.title || 'Untitled session').replace(/\s*\(@[\w-]+ subagent\)$/, '')

// ---- settings ----
const settingsOpen = ref(false)
const draft = reactive<RecentChatsSettings>({ ...settings.value })
watch(settingsOpen, (open) => { if (open) Object.assign(draft, settings.value) })
function applySettings() {
  const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(Number(n) || 0)))
  save({
    ...draft,
    recentHours: clamp(draft.recentHours, 1, 24 * 30),
    maxRecent: clamp(draft.maxRecent, 0, 50),
    unreadDays: clamp(draft.unreadDays, 0, 90),
    expandMax: clamp(draft.expandMax, 1, 100),
    starredMax: clamp(draft.starredMax, 0, 50),
    maxProjects: clamp(draft.maxProjects, 0, 40)
  })
  settingsOpen.value = false
}
const NUMBERS: Array<{ key: keyof RecentChatsSettings; label: string; hint: string; unit: string }> = [
  { key: 'recentHours', label: 'Recent means used within', hint: 'Chats with activity in this window are listed.', unit: 'hours' },
  { key: 'maxRecent', label: 'Recent chats per project', hint: 'Running and unread ones come first.', unit: 'chats' },
  { key: 'unreadDays', label: 'Keep unread chats for', hint: 'A chat that changed since you last opened it stays listed this long. 0 = off.', unit: 'days' },
  { key: 'starredMax', label: 'Starred chats per project', hint: 'Shown above the recent ones. 0 = none.', unit: 'chats' },
  { key: 'expandMax', label: '"More" shows up to', hint: 'Total chats per project once expanded.', unit: 'chats' },
  { key: 'maxProjects', label: 'Projects with chats', hint: 'The most recent projects get their chats loaded.', unit: 'projects' }
]
const SWITCHES: Array<{ key: keyof RecentChatsSettings; label: string; hint: string }> = [
  { key: 'showBusy', label: 'Always list running chats', hint: 'A chat generating a reply shows even when it is older.' },
  { key: 'includeSubagents', label: 'Include subagent chats', hint: 'Sub-chats started by the task tool or run_subagent.' },
  { key: 'showTime', label: 'Show the time of last activity', hint: '' }
]
</script>

<template>
  <div class="h-full flex flex-col">
    <div class="flex items-center gap-1 pl-3 pr-1.5 h-12">
      <span class="text-[10px] uppercase tracking-widest text-dimmed flex-1">Projects</span>
      <UIcon v-if="loading" name="i-lucide-loader-circle" class="size-3 animate-spin text-dimmed" />
      <UTooltip text="Which chats are listed">
        <UButton icon="i-lucide-settings-2" color="neutral" variant="ghost" size="xs" aria-label="Chat list settings" @click="settingsOpen = true" />
      </UTooltip>
      <UTooltip text="Hide projects panel">
        <UButton icon="i-lucide-panel-left-close" color="neutral" variant="ghost" size="xs" aria-label="Hide projects panel" @click="emit('close')" />
      </UTooltip>
    </div>
    <div class="px-1.5 pb-1.5">
      <UInput v-model="filter" size="xs" icon="i-lucide-search" placeholder="Search projects…" class="w-full" />
    </div>

    <div class="flex-1 overflow-y-auto overflow-x-hidden px-1.5 pb-2 space-y-1">
      <div v-if="loading && !projectDirs.length" class="px-2 space-y-2 pt-1">
        <USkeleton v-for="i in 4" :key="i" class="h-6 w-full" />
      </div>
      <div v-else-if="!projectDirs.length && serverDegraded" class="flex items-center gap-1.5 px-2 py-3 text-xs text-error">
        <UIcon name="i-lucide-plug-zap" class="size-3.5 shrink-0" />
        Server not responding
      </div>

      <div v-for="d in projectDirs" :key="d">
        <!-- project row: chevron folds its chats, the name opens it -->
        <div
          class="group flex items-center rounded-sm text-xs"
          :class="d === directory ? 'bg-accented text-highlighted' : 'text-muted hover:bg-accented/60'"
        >
          <button
            v-if="picks[d] && visible(d).length + picks[d].more.length"
            type="button"
            class="p-1.5 pr-0.5 text-dimmed hover:text-highlighted cursor-pointer"
            :aria-label="collapsed.includes(d) ? `Show chats of ${dirName(d)}` : `Hide chats of ${dirName(d)}`"
            :aria-expanded="!collapsed.includes(d)"
            @click="toggleCollapsed(d)"
          >
            <UIcon name="i-lucide-chevron-right" class="size-3 transition-transform duration-200" :class="collapsed.includes(d) ? '' : 'rotate-90'" />
          </button>
          <span v-else class="w-[1.375rem] shrink-0" />
          <NuxtLink :to="`/p/${encodeDir(d)}`" class="flex items-center gap-1.5 flex-1 min-w-0 py-1.5 pr-2" :title="d">
            <UIcon name="i-lucide-folder-git-2" class="size-3.5 shrink-0" />
            <span class="truncate flex-1 font-medium">{{ dirName(d) }}</span>
            <span
              v-if="unreadCount(d) && collapsed.includes(d)"
              class="min-w-4 h-4 px-1 rounded-full bg-primary text-inverted text-[9px] leading-4 text-center"
              :title="`${unreadCount(d)} unread`"
            >{{ unreadCount(d) }}</span>
          </NuxtLink>
        </div>

        <!-- its chats -->
        <CollapseTransition>
          <div v-if="picks[d] && !collapsed.includes(d) && visible(d).length + picks[d].more.length" class="ml-3 pl-1.5 border-l border-default space-y-px py-0.5">
            <NuxtLink
              v-for="c in visible(d)"
              :key="c.session.id"
              :to="chatLink(d, c.session.id)"
              class="oc-row flex items-center gap-1.5 rounded-sm pl-1.5 pr-1.5 py-1 text-[11px] hover:bg-accented"
              :class="d === directory && route.params.id === c.session.id ? 'bg-accented text-highlighted' : (c.unread ? 'text-highlighted' : 'text-muted')"
              :title="cleanTitle(c.session)"
            >
              <UIcon
                v-if="c.busy"
                name="i-lucide-loader-circle"
                class="size-3 shrink-0 animate-spin text-highlighted"
              />
              <UIcon v-else-if="c.starred" name="i-lucide-star" class="size-3 shrink-0 text-amber-400 oc-filled" />
              <UIcon v-else-if="c.session.parentID" name="i-lucide-bot" class="size-3 shrink-0 text-dimmed" />
              <span v-else class="size-3 shrink-0 flex items-center justify-center">
                <span class="size-1.5 rounded-full" :class="c.unread ? 'bg-primary' : 'bg-accented'" />
              </span>
              <span class="truncate flex-1" :class="c.unread ? 'font-medium' : ''">{{ cleanTitle(c.session) }}</span>
              <span v-if="settings.showTime" class="shrink-0 text-[9px] font-mono text-dimmed">
                {{ c.busy ? '…' : shortAge(c.session.time?.updated || c.session.time?.created || 0) }}
              </span>
            </NuxtLink>
            <button
              v-if="picks[d].more.length"
              type="button"
              class="flex items-center gap-1 w-full rounded-sm pl-1.5 py-0.5 text-[10px] text-dimmed hover:text-highlighted cursor-pointer"
              @click="expanded = { ...expanded, [d]: !expanded[d] }"
            >
              <UIcon :name="expanded[d] ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" class="size-3" />
              {{ expanded[d] ? 'Less' : `${picks[d].more.length} more` }}
            </button>
          </div>
        </CollapseTransition>
      </div>

      <NuxtLink
        to="/"
        class="oc-row flex items-center gap-1.5 rounded-sm px-2 py-1.5 text-xs text-dimmed hover:bg-accented"
      >
        <UIcon name="i-lucide-layout-grid" class="size-3.5 shrink-0" />
        <span>All projects…</span>
      </NuxtLink>
    </div>

    <UModal v-model:open="settingsOpen" title="Chats in the projects panel" description="Which conversations are listed under each project. Saved in this browser.">
      <template #body>
        <div class="space-y-3">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <UFormField v-for="n in NUMBERS" :key="n.key" :label="n.label" :description="n.hint" size="sm">
              <UInput v-model.number="(draft[n.key] as number)" type="number" min="0" class="w-full">
                <template #trailing><span class="text-[11px] text-dimmed">{{ n.unit }}</span></template>
              </UInput>
            </UFormField>
          </div>
          <div class="space-y-2">
            <div v-for="s in SWITCHES" :key="s.key" class="flex items-start gap-2.5">
              <USwitch v-model="(draft[s.key] as boolean)" size="sm" :aria-label="s.label" />
              <div>
                <div class="text-sm">{{ s.label }}</div>
                <p v-if="s.hint" class="text-[11px] text-dimmed">{{ s.hint }}</p>
              </div>
            </div>
          </div>
          <p class="text-[11px] text-dimmed">
            Unread = the chat changed after you last opened it in this browser. Star chats in the sidebar or the chat header to keep them on top.
          </p>
        </div>
      </template>
      <template #footer>
        <div class="oc-actions">
          <UButton variant="ghost" color="neutral" icon="i-lucide-rotate-ccw" label="Defaults" @click="reset(); settingsOpen = false" />
          <span class="flex-1 oc-spacer" />
          <UButton variant="ghost" color="neutral" label="Cancel" @click="settingsOpen = false" />
          <UButton color="primary" label="Save" @click="applySettings" />
        </div>
      </template>
    </UModal>
  </div>
</template>
