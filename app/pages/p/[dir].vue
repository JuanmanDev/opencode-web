<script setup lang="ts">
import type { MessageInfo, SessionInfo } from '#shared/types/opencode'

// one shell for every project: switching projects keeps the sidebar in place
// and only the content area changes (the child pages have their own keys)
definePageMeta({ key: 'project-shell' })

const route = useRoute()
const caps = useCapabilities()
const directory = computed(() => decodeDir(route.params.dir as string))
if (!directory.value) {
  throw createError({
    statusCode: 404,
    statusMessage: 'Project not found',
    message: 'This project link is not valid. Go back to the project list and open it again.',
    fatal: true
  })
}

const { upsert, remove } = useSessions(directory)
const { remember, load: loadRecents } = useRecentProjects()
const busySessions = useBusySessions()
const mobileMenuOpen = ref(false)
const chime = useChime()
const globalSearch = useGlobalSearch()

// persisted so SSR renders the same state (no hydration flicker)
const sidebarOpen = useCookie<boolean>('oc-sidebar', { default: () => true })
const sidebarWidth = useCookie<number>('oc-sidebar-w', { default: () => 272 })
const projectsPanel = useCookie<boolean>('oc-projects-panel', { default: () => false })

onMounted(loadRecents)
watch(directory, (dir) => { if (import.meta.client && dir) remember(dir) }, { immediate: true })

// ---- sidebar resize (desktop) ----
// the width animates when the sidebar opens or closes, never while dragging
const resizing = ref(false)
function startResize(e: PointerEvent) {
  e.preventDefault()
  resizing.value = true
  const startX = e.clientX
  const startW = sidebarWidth.value
  const move = (ev: PointerEvent) => {
    sidebarWidth.value = Math.min(480, Math.max(200, startW + ev.clientX - startX))
  }
  const up = () => {
    resizing.value = false
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

const toast = useToast()
async function newChat() {
  try {
    const session = await useOpencodeApi(directory).createSession()
    navigateTo(`/p/${route.params.dir}/session/${session.id}`)
  } catch {
    toast.add({ title: 'Could not create session', color: 'error' })
  }
}

// collapsed rail: the same destinations as the sidebar tiles, icon only
const railLinks = computed(() => [
  { icon: 'i-lucide-layout-dashboard', label: 'Project overview', to: `/p/${route.params.dir}` },
  ...(caps.value.mcp ? [{ icon: 'i-lucide-server-cog', label: 'MCP servers', to: `/p/${route.params.dir}/mcp` }] : []),
  { icon: 'i-lucide-bot', label: 'Agents', to: `/p/${route.params.dir}/agents` },
  { icon: 'i-lucide-graduation-cap', label: 'Skills', to: `/p/${route.params.dir}/skills` },
  { icon: 'i-lucide-alarm-clock', label: 'Scheduled prompts', to: `/p/${route.params.dir}/schedules` },
  { icon: 'i-lucide-chart-column', label: 'Usage & cost', to: `/p/${route.params.dir}/stats` }
])

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
  <!-- md+: clear the status bar of an installed iPad app; phones handle it in
       the mobile header so its background reaches the top edge -->
  <div class="flex-1 flex min-h-0 md:pt-[env(safe-area-inset-top)]">
    <!-- projects panel (desktop, toggleable): every project with its starred,
         recent, unread and running chats. Its width animates, the content
         keeps its own width so nothing reflows while it slides -->
    <aside
      class="hidden md:block relative shrink-0 overflow-hidden bg-elevated/60 transition-[width] duration-200 ease-out motion-reduce:transition-none"
      :style="{ width: projectsPanel ? '15rem' : '0px' }"
      :inert="!projectsPanel"
      aria-label="Projects"
    >
      <Transition name="oc-xfade">
        <ProjectsPanel v-if="projectsPanel" :directory="directory" class="absolute inset-y-0 left-0 w-60" @close="projectsPanel = false" />
      </Transition>
    </aside>

    <!-- desktop sidebar: one panel whose width animates between the full
         sidebar and the icon rail; both contents keep their own width and
         cross-fade, so neither squeezes nor reflows during the move -->
    <aside
      class="hidden md:block relative shrink-0 overflow-hidden bg-muted motion-reduce:transition-none"
      :class="resizing ? '' : 'transition-[width] duration-200 ease-out'"
      :style="{ width: (sidebarOpen ? sidebarWidth : 48) + 'px' }"
    >
      <Transition name="oc-xfade">
        <div
          v-if="sidebarOpen"
          key="full"
          class="absolute inset-y-0 left-0 flex flex-col"
          :style="{ width: sidebarWidth + 'px' }"
        >
          <div class="flex items-center gap-1 pl-2 pr-2 h-12">
            <UTooltip v-if="!projectsPanel" text="Show projects panel">
              <UButton
                icon="i-lucide-folder-tree"
                color="neutral"
                variant="ghost"
                size="xs"
                aria-label="Show projects panel"
                @click="projectsPanel = true"
              />
            </UTooltip>
            <div class="min-w-0 flex-1 flex pl-1">
              <ProjectSwitcher :directory="directory" />
            </div>
            <UTooltip text="All projects">
              <UButton
                icon="i-lucide-layout-grid"
                color="neutral"
                variant="ghost"
                size="xs"
                aria-label="All projects"
                to="/"
              />
            </UTooltip>
            <UTooltip text="Collapse sidebar">
              <UButton
                icon="i-lucide-panel-left-close"
                color="neutral"
                variant="ghost"
                size="xs"
                aria-label="Collapse sidebar"
                @click="sidebarOpen = false"
              />
            </UTooltip>
          </div>
          <ProjectSidebar :directory="directory" class="flex-1 min-h-0" />
        </div>
        <nav
          v-else
          key="rail"
          class="absolute inset-y-0 left-0 w-12 flex flex-col items-center gap-1 py-2"
          aria-label="Project"
        >
          <UTooltip text="Expand sidebar" :content="{ side: 'right' }">
            <UButton
              icon="i-lucide-panel-left-open"
              color="neutral"
              variant="ghost"
              aria-label="Expand sidebar"
              @click="sidebarOpen = true"
            />
          </UTooltip>
          <UTooltip text="New chat" :content="{ side: 'right' }">
            <UButton icon="i-lucide-plus" color="primary" variant="soft" aria-label="New chat" @click="newChat" />
          </UTooltip>
          <UTooltip text="Search everything (Ctrl+K)" :content="{ side: 'right' }">
            <UButton
              icon="i-lucide-search"
              color="neutral"
              variant="ghost"
              aria-label="Search everything"
              @click="globalSearch.open.value = true"
            />
          </UTooltip>
          <span class="w-6 h-px bg-accented my-1" />
          <UTooltip v-for="link in railLinks" :key="link.to" :text="link.label" :content="{ side: 'right' }">
            <UButton
              :icon="link.icon"
              color="neutral"
              :variant="route.path === link.to ? 'soft' : 'ghost'"
              :aria-label="link.label"
              :to="link.to"
            />
          </UTooltip>
          <span class="flex-1" />
          <UTooltip text="All projects" :content="{ side: 'right' }">
            <UButton
              icon="i-lucide-layout-grid"
              color="neutral"
              variant="ghost"
              aria-label="All projects"
              to="/"
            />
          </UTooltip>
        </nav>
      </Transition>
    </aside>

    <!-- resize handle -->
    <div
      v-if="sidebarOpen"
      class="hidden md:block w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-accented active:bg-accented transition-colors"
      title="Drag to resize"
      @pointerdown="startResize"
    />

    <!-- mobile slideover (header clears the status bar / notch) -->
    <USlideover
      v-model:open="mobileMenuOpen"
      side="left"
      :title="dirName(directory)"
      :ui="{
        header: 'pt-[max(1rem,env(safe-area-inset-top))]',
        close: 'top-[max(1rem,env(safe-area-inset-top))] oc-tap-zone'
      }"
    >
      <template #title>
        <ProjectSwitcher :directory="directory" @navigate="mobileMenuOpen = false" />
      </template>
      <template #body>
        <ProjectSidebar :directory="directory" class="-m-4 h-[calc(100%+2rem)]" @navigate="mobileMenuOpen = false" />
      </template>
    </USlideover>

    <div class="flex-1 flex flex-col min-w-0 min-h-0">
      <!-- mobile header: its background extends under the status bar / notch -->
      <header class="md:hidden flex items-center gap-2 box-content h-12 pt-[env(safe-area-inset-top)] px-2 bg-muted shrink-0">
        <UButton
          icon="i-lucide-menu"
          color="neutral"
          variant="ghost"
          class="oc-tap"
          aria-label="Open menu"
          @click="mobileMenuOpen = true"
        />
        <div class="min-w-0 flex-1 flex">
          <ProjectSwitcher :directory="directory" />
        </div>
        <UButton
          icon="i-lucide-layout-grid"
          color="neutral"
          variant="ghost"
          size="xs"
          class="oc-tap"
          aria-label="All projects"
          to="/"
        />
        <UButton
          :icon="chime.enabled.value ? 'i-lucide-bell-ring' : 'i-lucide-bell-off'"
          color="neutral"
          variant="ghost"
          size="xs"
          class="oc-tap"
          :aria-label="chime.enabled.value ? 'Disable reply sound' : 'Enable reply sound'"
          @click="chime.toggle()"
        />
      </header>

      <NuxtPage :directory="directory" />
    </div>
  </div>
</template>
