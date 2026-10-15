<script setup lang="ts">
// The current project's name as a menu: jump to another recent project,
// to the list of all projects, or open a new folder. Keeps "this project"
// and "all projects" apart in the sidebar and the mobile header.
const props = defineProps<{ directory: string }>()
const emit = defineEmits<{ navigate: [] }>()
const route = useRoute()
const { recents } = useRecentProjects()

// same sub-page in the other project when it has one (MCP, usage…), else its overview
function targetFor(dir: string) {
  const sub = route.path.split('/').slice(3)
  const keep = ['mcp', 'agents', 'skills', 'schedules', 'stats'].includes(sub[0] || '') ? `/${sub[0]}` : ''
  return `/p/${encodeDir(dir)}${keep}`
}

const items = computed(() => {
  const others = recents.value
    .filter((r) => r.directory !== props.directory)
    .slice(0, 8)
    .map((r) => ({
      label: dirName(r.directory),
      description: r.directory,
      icon: 'i-lucide-folder-git-2',
      onSelect: () => { emit('navigate'); navigateTo(targetFor(r.directory)) }
    }))
  return [
    [{ type: 'label' as const, label: 'Switch project' }],
    others.length ? others : [{ label: 'No other recent projects', disabled: true }],
    [
      { label: 'All projects', icon: 'i-lucide-layout-grid', onSelect: () => { emit('navigate'); navigateTo('/') } }
    ]
  ]
})
</script>

<template>
  <UDropdownMenu :items="items" :content="{ align: 'start' }" :ui="{ content: 'w-72 max-w-[calc(100vw-2rem)]', itemDescription: 'font-mono truncate' }">
    <button
      type="button"
      class="flex items-center gap-1.5 min-w-0 rounded-sm px-1.5 py-1 -mx-1.5 text-left hover:bg-elevated transition-colors cursor-pointer"
      :aria-label="`Project ${dirName(directory)}: switch project`"
    >
      <UIcon name="i-lucide-folder-git-2" class="size-4 text-primary shrink-0" />
      <span class="text-sm font-semibold truncate">{{ dirName(directory) }}</span>
      <UIcon name="i-lucide-chevrons-up-down" class="size-3.5 text-dimmed shrink-0" />
    </button>
  </UDropdownMenu>
</template>
