<script setup lang="ts">
import type { Project } from '#shared/types/opencode'

const api = useOpencodeApi()
const { recents, load: loadRecents, remember, forget } = useRecentProjects()

const projects = ref<Project[]>([])
const projectsLoading = ref(true)
const loadError = ref('')
const browserOpen = ref(false)
const manualPath = ref('')

onMounted(async () => {
  loadRecents()
  try {
    projects.value = (await api.projects())
      .sort((a, b) => (b.time?.initialized || b.time?.created || 0) - (a.time?.initialized || a.time?.created || 0))
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : 'Cannot reach the opencode server'
  } finally {
    projectsLoading.value = false
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
</script>

<template>
  <div class="flex-1 overflow-y-auto">
    <div class="max-w-2xl mx-auto px-4 py-10 sm:py-16">
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

      <div class="flex flex-col sm:flex-row gap-2 mb-8">
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
      <div class="bg-muted rounded-sm divide-y divide-default overflow-hidden">
        <div
          v-for="item in knownDirs"
          :key="item.directory"
          class="group flex items-center gap-3 px-3 py-2.5 hover:bg-elevated cursor-pointer"
          @click="openProject(item.directory)"
        >
          <UIcon name="i-lucide-folder-git-2" class="size-4 text-primary/70 shrink-0" />
          <div class="min-w-0 flex-1">
            <div class="text-sm font-medium truncate">{{ dirName(item.directory) }}</div>
            <div class="text-xs text-dimmed font-mono truncate">{{ item.directory }}</div>
          </div>
          <UBadge v-if="item.source === 'recent'" size="sm" variant="subtle" color="neutral">recent</UBadge>
          <UButton
            v-if="item.source === 'recent'"
            icon="i-lucide-x"
            size="xs"
            color="neutral"
            variant="ghost"
            class="opacity-0 group-hover:opacity-100"
            @click.stop="forget(item.directory)"
          />
        </div>
        <div v-if="projectsLoading && !knownDirs.length" class="p-3 space-y-2">
          <div v-for="i in 3" :key="i" class="flex items-center gap-3">
            <USkeleton class="size-4 rounded-full" />
            <div class="flex-1 space-y-1.5">
              <USkeleton class="h-3.5 w-1/3" />
              <USkeleton class="h-3 w-2/3" />
            </div>
          </div>
        </div>
        <div v-else-if="!knownDirs.length" class="px-3 py-6 text-sm text-dimmed text-center">
          No projects yet — type a folder path above or browse the server.
        </div>
      </div>
    </div>

    <DirectoryBrowser v-model:open="browserOpen" @select="openProject" />
  </div>
</template>
