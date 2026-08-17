<script setup lang="ts">
import type { MessageInfo, Project, SessionInfo } from '#shared/types/opencode'

const route = useRoute()
const directory = computed(() => decodeDir(route.params.dir as string))

const { upsert, remove } = useSessions(directory)
const { remember, recents, load: loadRecents } = useRecentProjects()
const busySessions = useBusySessions()
const mobileMenuOpen = ref(false)
const chime = useChime()

// persisted so SSR renders the same state (no hydration flicker)
const sidebarOpen = useCookie<boolean>('oc-sidebar', { default: () => true })
const sidebarWidth = useCookie<number>('oc-sidebar-w', { default: () => 272 })
const projectsPanel = useCookie<boolean>('oc-projects-panel', { default: () => false })

onMounted(() => {
  remember(directory.value)
  loadRecents()
})

// ---- projects panel ----
const api = useOpencodeApi()
const projects = ref<Project[]>([])
const projectsLoading = ref(false)

async function loadProjects() {
  projectsLoading.value = true
  try {
    projects.value = await api.projects()
  } catch { /* keep empty */ } finally {
    projectsLoading.value = false
  }
}

watch(projectsPanel, (open) => { if (open) loadProjects() }, { immediate: true })

const projectDirs = computed(() => {
  const seen = new Set<string>()
  const list: string[] = []
  for (const r of recents.value) {
    if (!seen.has(r.directory)) { seen.add(r.directory); list.push(r.directory) }
  }
  for (const p of projects.value) {
    if (p.worktree && p.worktree !== '/' && !seen.has(p.worktree)) {
      seen.add(p.worktree)
      list.push(p.worktree)
    }
  }
  return list
})

// ---- sidebar resize (desktop) ----
function startResize(e: PointerEvent) {
  e.preventDefault()
  const startX = e.clientX
  const startW = sidebarWidth.value
  const move = (ev: PointerEvent) => {
    sidebarWidth.value = Math.min(480, Math.max(200, startW + ev.clientX - startX))
  }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

// ---- live updates: session list + per-session progress ----
useOpencodeEvents(directory, (event) => {
  const props = (event.properties || {}) as Record<string, any>
  switch (event.type) {
    case 'session.updated': {
      const info = props.info as SessionInfo | undefined
      if (info) upsert(info)
      break
    }
    case 'session.deleted': {
      const info = props.info as SessionInfo | undefined
      const id = info?.id || (props.sessionID as string | undefined)
      if (id) { remove(id); busySessions.set(id, false) }
      break
    }
    case 'message.updated': {
      const info = props.info as MessageInfo | undefined
      if (info?.role === 'assistant') {
        busySessions.set(info.sessionID, !info.time?.completed && !info.error)
      }
      break
    }
    case 'session.idle':
      if (props.sessionID) busySessions.set(props.sessionID as string, false)
      break
    case 'session.error':
      if (props.sessionID) busySessions.set(props.sessionID as string, false)
      break
  }
})

useHead(() => ({ title: `${dirName(directory.value)} · opencode web` }))
</script>

<template>
  <div class="flex-1 flex min-h-0">
    <!-- projects panel (desktop, toggleable) -->
    <Transition name="oc-slide">
    <aside v-if="projectsPanel" class="hidden md:flex w-48 shrink-0 flex-col bg-elevated/60">
      <div class="flex items-center gap-2 px-3 h-12 text-[10px] uppercase tracking-widest text-dimmed">
        Projects
      </div>
      <div class="flex-1 overflow-y-auto px-1.5 pb-2 space-y-0.5">
        <div v-if="projectsLoading && !projectDirs.length" class="px-2 space-y-2 pt-1">
          <USkeleton v-for="i in 4" :key="i" class="h-6 w-full" />
        </div>
        <div v-else-if="!projectDirs.length && serverDegraded" class="flex items-center gap-1.5 px-2 py-3 text-xs text-error">
          <UIcon name="i-lucide-plug-zap" class="size-3.5 shrink-0" />
          Server not responding
        </div>
        <NuxtLink
          v-for="d in projectDirs"
          :key="d"
          :to="`/p/${encodeDir(d)}`"
          class="oc-row flex items-center gap-1.5 rounded-sm px-2 py-1.5 text-xs hover:bg-accented"
          :class="d === directory ? 'bg-accented text-highlighted' : 'text-muted'"
        >
          <UIcon name="i-lucide-folder-git-2" class="size-3.5 shrink-0" />
          <span class="truncate">{{ dirName(d) }}</span>
        </NuxtLink>
        <NuxtLink
          to="/"
          class="oc-row flex items-center gap-1.5 rounded-sm px-2 py-1.5 text-xs text-dimmed hover:bg-accented"
        >
          <UIcon name="i-lucide-plus" class="size-3.5 shrink-0" />
          <span>Open another…</span>
        </NuxtLink>
      </div>
    </aside>
    </Transition>

    <!-- desktop sidebar (collapsible + resizable) -->
    <Transition name="oc-slide">
    <aside
      v-if="sidebarOpen"
      class="hidden md:flex shrink-0 flex-col bg-muted"
      :style="{ width: sidebarWidth + 'px' }"
    >
      <div class="flex items-center gap-1 pl-3 pr-2 h-12">
        <UButton
          :icon="projectsPanel ? 'i-lucide-panel-left-close' : 'i-lucide-folder-tree'"
          color="neutral"
          variant="ghost"
          size="xs"
          :aria-label="projectsPanel ? 'Hide projects panel' : 'Show projects panel'"
          @click="projectsPanel = !projectsPanel"
        />
        <UIcon name="i-lucide-terminal" class="size-4 text-primary shrink-0" />
        <span class="text-sm font-semibold truncate flex-1">{{ dirName(directory) }}</span>
        <UButton
          icon="i-lucide-house"
          color="neutral"
          variant="ghost"
          size="xs"
          aria-label="All projects"
          to="/"
        />
        <UButton
          icon="i-lucide-panel-left-close"
          color="neutral"
          variant="ghost"
          size="xs"
          aria-label="Hide sidebar"
          @click="sidebarOpen = false"
        />
      </div>
      <ProjectSidebar :directory="directory" class="flex-1 min-h-0" />
    </aside>
    </Transition>

    <!-- resize handle -->
    <div
      v-if="sidebarOpen"
      class="hidden md:block w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-accented active:bg-accented transition-colors"
      title="Drag to resize"
      @pointerdown="startResize"
    />

    <!-- desktop mini rail when collapsed -->
    <aside v-if="!sidebarOpen" class="hidden md:flex w-12 shrink-0 flex-col items-center gap-1 bg-muted py-2">
      <UButton
        icon="i-lucide-panel-left-open"
        color="neutral"
        variant="ghost"
        aria-label="Show sidebar"
        @click="sidebarOpen = true"
      />
      <UButton
        icon="i-lucide-messages-square"
        color="neutral"
        variant="ghost"
        aria-label="Sessions"
        :to="`/p/${route.params.dir}`"
      />
      <UButton
        icon="i-lucide-server-cog"
        color="neutral"
        variant="ghost"
        aria-label="MCP servers"
        :to="`/p/${route.params.dir}/mcp`"
      />
      <span class="flex-1" />
      <UButton
        icon="i-lucide-house"
        color="neutral"
        variant="ghost"
        aria-label="All projects"
        to="/"
      />
    </aside>

    <!-- mobile slideover -->
    <USlideover v-model:open="mobileMenuOpen" side="left" :title="dirName(directory)">
      <template #body>
        <ProjectSidebar :directory="directory" class="-m-4 h-[calc(100%+2rem)]" @navigate="mobileMenuOpen = false" />
      </template>
    </USlideover>

    <div class="flex-1 flex flex-col min-w-0 min-h-0">
      <!-- mobile header -->
      <header class="md:hidden flex items-center gap-2 h-12 px-2 bg-muted shrink-0">
        <UButton
          icon="i-lucide-menu"
          color="neutral"
          variant="ghost"
          @click="mobileMenuOpen = true"
        />
        <UIcon name="i-lucide-terminal" class="size-4 text-primary" />
        <span class="text-sm font-semibold truncate flex-1">{{ dirName(directory) }}</span>
        <UButton
          :icon="chime.enabled.value ? 'i-lucide-bell-ring' : 'i-lucide-bell-off'"
          color="neutral"
          variant="ghost"
          size="xs"
          :aria-label="chime.enabled.value ? 'Disable reply sound' : 'Enable reply sound'"
          @click="chime.toggle()"
        />
      </header>

      <NuxtPage :directory="directory" />
    </div>
  </div>
</template>
