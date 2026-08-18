<script setup lang="ts">
// Global search modal (Ctrl+K): projects, sessions, MCP servers & tools,
// presets and settings pages in a Nuxt UI command palette.
import type { Project } from '#shared/types/opencode'

const { open } = useGlobalSearch()
const route = useRoute()
const projectMeta = useProjectMeta()
const { recents, load: loadRecents } = useRecentProjects()

const projects = ref<Project[]>([])
const mcpItems = ref<Array<{ label: string; suffix?: string; icon: string; to: string }>>([])

const knownDirs = computed(() => {
  const seen = new Set<string>()
  const list: string[] = []
  for (const r of recents.value) if (!seen.has(r.directory)) { seen.add(r.directory); list.push(r.directory) }
  for (const p of projects.value) {
    if (p.worktree && !seen.has(p.worktree)) { seen.add(p.worktree); list.push(p.worktree) }
  }
  return list
})

const activeDir = computed(() => {
  const param = route.params.dir as string | undefined
  return param ? decodeDir(param) : knownDirs.value[0]
})

async function loadData() {
  loadRecents()
  projectMeta.load()
  useOpencodeApi().projects().then((list) => { projects.value = list }).catch(() => {})

  const dir = activeDir.value
  if (!dir) return
  const mcpPage = `/p/${encodeDir(dir)}/mcp`
  try {
    const [status, tools] = await Promise.all([
      useOpencodeApi(() => dir).mcpStatus(),
      $fetch<Record<string, { tools: Array<{ name: string; description?: string }> }>>(
        '/api/v1/mcp-tools', { query: { directory: dir }, timeout: 20000 }
      ).catch(() => ({} as Record<string, { tools: Array<{ name: string }> }>))
    ])
    const items: typeof mcpItems.value = []
    for (const name of Object.keys(status)) {
      items.push({
        label: name,
        suffix: `MCP server · ${(status as any)[name]?.status || ''}`,
        icon: 'i-lucide-server',
        to: mcpPage
      })
      for (const tool of tools[name]?.tools || []) {
        items.push({
          label: `${name} › ${tool.name}`,
          suffix: 'MCP tool',
          icon: 'i-lucide-wrench',
          to: mcpPage
        })
      }
    }
    mcpItems.value = items
  } catch { /* server down */ }
}

watch(open, (isOpen) => { if (isOpen) loadData() })

// Ctrl+K / Cmd+K
onMounted(() => {
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      open.value = !open.value
    }
  })
})

const groups = computed(() => {
  const projectItems = knownDirs.value.map((dir) => ({
    label: dirName(dir),
    suffix: projectMeta.of(dir).description || dir,
    icon: 'i-lucide-folder-git-2',
    to: `/p/${encodeDir(dir)}`
  }))

  const sessionItems = knownDirs.value.slice(0, 8).flatMap((dir) =>
    readSessionsCache(dir).slice(0, 30).map((s) => ({
      label: s.title || 'Untitled session',
      suffix: dirName(dir),
      icon: projectMeta.isFavorite(dir, s.id) ? 'i-lucide-star' : 'i-lucide-message-square',
      to: `/p/${encodeDir(dir)}/session/${s.id}`
    }))
  )

  let presetItems: Array<{ label: string; suffix: string; icon: string; to: string }> = []
  try {
    const presets = JSON.parse(localStorage.getItem('opencode-web.mcp-presets.shared') || '[]') as Array<{ name: string }>
    presetItems = presets.map((p) => ({
      label: p.name,
      suffix: 'MCP preset',
      icon: 'i-lucide-layers',
      to: activeDir.value ? `/p/${encodeDir(activeDir.value)}/mcp` : '/'
    }))
  } catch { /* ignore */ }

  const pageItems = knownDirs.value.slice(0, 6).flatMap((dir) => [
    { label: `MCP settings — ${dirName(dir)}`, icon: 'i-lucide-server-cog', to: `/p/${encodeDir(dir)}/mcp` },
    { label: `Usage & cost — ${dirName(dir)}`, icon: 'i-lucide-chart-column', to: `/p/${encodeDir(dir)}/stats` }
  ])

  return [
    { id: 'projects', label: 'Projects', items: projectItems },
    { id: 'sessions', label: 'Sessions', items: sessionItems },
    { id: 'mcp', label: 'MCP servers & tools', items: mcpItems.value },
    { id: 'presets', label: 'Presets', items: presetItems },
    { id: 'pages', label: 'Pages', items: pageItems }
  ].filter((g) => g.items.length)
})

function onSelect(item: unknown) {
  open.value = false
  const to = (item as { to?: string })?.to
  if (to) navigateTo(to)
}
</script>

<template>
  <UModal v-model:open="open" :ui="{ content: 'p-0' }" title="Search" description="Search everything">
    <template #content>
      <UCommandPalette
        :groups="groups"
        placeholder="Search projects, sessions, MCP servers, tools, presets…"
        class="h-96"
        close
        @update:model-value="onSelect"
        @update:open="(v: boolean) => { if (!v) open = false }"
      />
    </template>
  </UModal>
</template>
