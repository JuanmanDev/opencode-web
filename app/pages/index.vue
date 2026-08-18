<script setup lang="ts">
import type { Project, SessionInfo } from '#shared/types/opencode'

const api = useOpencodeApi()
const { recents, load: loadRecents, remember, forget } = useRecentProjects()
const projectMeta = useProjectMeta()

const projects = ref<Project[]>([])
const projectsLoading = ref(true)
const loadError = ref('')
const browserOpen = ref(false)
const manualPath = ref('')

// recent conversations per project (cache-first, then refreshed)
const sessionsByDir = ref<Record<string, SessionInfo[]>>({})
const CAROUSEL_PROJECTS = 4

onMounted(async () => {
  loadRecents()
  projectMeta.load()
  // paint carousels instantly from cache
  for (const dir of knownDirs.value.slice(0, CAROUSEL_PROJECTS).map((k) => k.directory)) {
    const cached = readSessionsCache(dir)
    if (cached.length) sessionsByDir.value[dir] = cached
  }
  try {
    projects.value = (await api.projects())
      .sort((a, b) => (b.time?.initialized || b.time?.created || 0) - (a.time?.initialized || a.time?.created || 0))
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : 'Cannot reach the opencode server'
  } finally {
    projectsLoading.value = false
  }
  // refresh sessions for the top projects
  for (const dir of knownDirs.value.slice(0, CAROUSEL_PROJECTS).map((k) => k.directory)) {
    useOpencodeApi(() => dir).sessions()
      .then((list) => {
        sessionsByDir.value[dir] = list
          .filter((s) => !s.parentID)
          .sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0))
      })
      .catch(() => { /* keep cache */ })
  }
})

function openProject(directory: string) {
  remember(directory)
  navigateTo(`/p/${encodeDir(directory)}`)
}

const knownDirs = computed(() => {
  const seen = new Set<string>()
  const list: Array<{ directory: string; source: string }> = []
  for (const r of recents.value) {
    if (!seen.has(r.directory)) {
      seen.add(r.directory)
      list.push({ directory: r.directory, source: 'recent' })
    }
  }
  for (const p of projects.value) {
    if (p.worktree && !seen.has(p.worktree)) {
      seen.add(p.worktree)
      list.push({ directory: p.worktree, source: 'server' })
    }
  }
  return list
})

function carouselSessions(dir: string): SessionInfo[] {
  const list = sessionsByDir.value[dir] || []
  const favs = projectMeta.of(dir).favorites
  return [...list]
    .sort((a, b) => {
      const favDiff = Number(favs.includes(b.id)) - Number(favs.includes(a.id))
      return favDiff || (b.time?.updated || 0) - (a.time?.updated || 0)
    })
    .slice(0, 12)
}

function fmtTime(ts?: number) {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 3600_000) return `${Math.max(1, Math.round(diff / 60000))}m ago`
  if (diff < 86400_000) return `${Math.round(diff / 3600_000)}h ago`
  return `${Math.round(diff / 86400_000)}d ago`
}

const globalSearch = useGlobalSearch()

// description editing
const editOpen = ref(false)
const editDir = ref('')
const editDescription = ref('')

function openEdit(directory: string) {
  editDir.value = directory
  editDescription.value = projectMeta.of(directory).description || ''
  editOpen.value = true
}

function saveEdit() {
  projectMeta.setDescription(editDir.value, editDescription.value)
  editOpen.value = false
}
</script>

<template>
  <div class="flex-1 overflow-y-auto">
    <div class="max-w-3xl mx-auto px-4 py-8 sm:py-14">
      <div class="flex items-center gap-3 mb-1">
        <div class="size-9 rounded-sm bg-elevated flex items-center justify-center">
          <UIcon name="i-lucide-terminal" class="size-5 text-highlighted" />
        </div>
        <h1 class="text-2xl font-semibold tracking-tight">open<span class="text-primary">code</span> web</h1>
      </div>
      <p class="text-sm text-muted mb-8">Pick a project folder to start working. Sessions, models and MCP servers are scoped per project.</p>

      <UAlert
        v-if="loadError"
        color="error"
        variant="subtle"
        icon="i-lucide-plug-zap"
        title="opencode server unreachable"
        :description="loadError"
        class="mb-6"
      />

      <!-- global search (modal, Ctrl+K) -->
      <button
        class="oc-row flex items-center gap-2.5 w-full max-w-2xl mb-4 rounded-sm bg-muted hover:bg-elevated px-3 py-2.5 text-sm text-dimmed cursor-pointer"
        @click="globalSearch.open.value = true"
      >
        <UIcon name="i-lucide-search" class="size-4" />
        <span class="flex-1 text-left">Search projects, sessions, MCP servers, presets…</span>
        <UKbd size="sm">Ctrl</UKbd><UKbd size="sm">K</UKbd>
      </button>

      <div class="flex flex-col sm:flex-row gap-2 mb-8 max-w-2xl">
        <UInput
          v-model="manualPath"
          class="flex-1 font-mono"
          icon="i-lucide-folder-open"
          placeholder="/projects/my-app"
          @keydown.enter="manualPath.trim() && openProject(manualPath.trim())"
        />
        <div class="flex gap-2">
          <UButton
            color="primary"
            label="Open"
            :disabled="!manualPath.trim()"
            @click="openProject(manualPath.trim())"
          />
          <UButton variant="soft" color="neutral" label="Browse…" icon="i-lucide-folder-search" @click="browserOpen = true" />
        </div>
      </div>

      <h2 class="text-xs uppercase tracking-widest text-dimmed mb-2">Projects</h2>
      <div class="space-y-2">
        <div
          v-for="(item, index) in knownDirs"
          :key="item.directory"
        >
          <!-- project row: standard width -->
          <div
            class="oc-row group flex items-center gap-3 px-3 sm:px-4 py-2.5 bg-muted rounded-sm hover:bg-elevated cursor-pointer"
            @click="openProject(item.directory)"
          >
            <UIcon name="i-lucide-folder-git-2" class="size-4 text-primary/70 shrink-0" />
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="text-sm font-medium truncate">{{ dirName(item.directory) }}</span>
                <UBadge v-if="item.source === 'recent'" size="sm" variant="subtle" color="neutral">recent</UBadge>
              </div>
              <div class="text-xs text-dimmed font-mono truncate">{{ item.directory }}</div>
              <p v-if="projectMeta.of(item.directory).description" class="text-xs text-muted truncate mt-0.5">
                {{ projectMeta.of(item.directory).description }}
              </p>
            </div>
            <UButton
              icon="i-lucide-pencil"
              size="xs"
              color="neutral"
              variant="ghost"
              class="opacity-0 group-hover:opacity-100"
              aria-label="Edit description"
              @click.stop="openEdit(item.directory)"
            />
            <UButton
              v-if="item.source === 'recent'"
              icon="i-lucide-x"
              size="xs"
              color="neutral"
              variant="ghost"
              class="opacity-0 group-hover:opacity-100"
              aria-label="Remove from recents"
              @click.stop="forget(item.directory)"
            />
          </div>

          <!-- carousel breaks out to the full viewport width -->
          <HScroll
            v-if="index < CAROUSEL_PROJECTS && carouselSessions(item.directory).length"
            class="relative left-1/2 -translate-x-1/2 w-screen px-4 sm:px-8 lg:px-16 xl:px-24 pt-2 pb-1"
          >
            <NuxtLink
              v-for="s in carouselSessions(item.directory)"
              :key="s.id"
              :to="`/p/${encodeDir(item.directory)}/session/${s.id}`"
              class="oc-row group/card shrink-0 w-60 rounded-sm bg-elevated/70 hover:bg-accented px-2.5 py-2"
            >
              <div class="flex items-start gap-1.5">
                <UIcon
                  :name="projectMeta.isFavorite(item.directory, s.id) ? 'i-lucide-star' : 'i-lucide-message-square'"
                  class="size-3.5 shrink-0 mt-0.5"
                  :class="projectMeta.isFavorite(item.directory, s.id) ? 'text-primary' : 'text-dimmed'"
                />
                <span class="text-xs leading-snug line-clamp-2 flex-1">{{ s.title || 'Untitled session' }}</span>
              </div>
              <div class="text-[10px] text-dimmed font-mono mt-1 pl-5">
                {{ fmtTime(s.time?.updated || s.time?.created) }}
              </div>
            </NuxtLink>
          </HScroll>
        </div>

        <div v-if="projectsLoading && !knownDirs.length" class="bg-muted rounded-sm p-3 space-y-2">
          <div v-for="i in 3" :key="i" class="flex items-center gap-3">
            <USkeleton class="size-4 rounded-full" />
            <div class="flex-1 space-y-1.5">
              <USkeleton class="h-3.5 w-1/3" />
              <USkeleton class="h-3 w-2/3" />
            </div>
          </div>
        </div>
        <div v-else-if="!knownDirs.length" class="bg-muted rounded-sm px-3 py-6 text-sm text-dimmed text-center">
          No projects yet — type a folder path above or browse the server.
        </div>
      </div>
    </div>

    <DirectoryBrowser v-model:open="browserOpen" @select="openProject" />

    <UModal v-model:open="editOpen" :title="`Edit ${dirName(editDir)}`" description="Description is stored in this browser.">
      <template #body>
        <UFormField label="Description" size="sm">
          <UTextarea
            v-model="editDescription"
            :rows="3"
            autoresize
            placeholder="What is this project about?"
            class="w-full"
            @keydown.enter.meta="saveEdit"
          />
        </UFormField>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton variant="ghost" color="neutral" label="Cancel" @click="editOpen = false" />
          <UButton color="primary" label="Save" @click="saveEdit" />
        </div>
      </template>
    </UModal>
  </div>
</template>
