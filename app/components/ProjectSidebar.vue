<script setup lang="ts">
const props = defineProps<{ directory: string }>()
const emit = defineEmits<{ navigate: [] }>()

const route = useRoute()
const dirParam = computed(() => encodeDir(props.directory))
const { sessions, refreshing, refresh, remove } = useSessions(() => props.directory)
const { busy: busySessions } = useBusySessions()
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
        icon="i-lucide-plus"
        label="New chat"
        @click="newSession"
      />
      <UButton
        block
        color="neutral"
        variant="ghost"
        icon="i-lucide-server-cog"
        label="MCP servers"
        :to="`/p/${dirParam}/mcp`"
        @click="emit('navigate')"
      />
    </div>

    <div class="flex items-center gap-1.5 px-3 pb-1 text-[10px] uppercase tracking-widest text-dimmed">
      Sessions
      <UIcon v-if="refreshing" name="i-lucide-loader-circle" class="size-3 animate-spin" />
    </div>
    <div class="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
      <div
        v-for="s in sessions"
        :key="s.id"
        class="group relative"
      >
        <NuxtLink
          :to="`/p/${dirParam}/session/${s.id}`"
          class="flex items-start gap-2 rounded-sm px-2.5 py-2 text-sm hover:bg-elevated"
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
            <div class="truncate pr-5">{{ s.title || 'Untitled session' }}</div>
            <div class="text-[10px] text-dimmed font-mono">
              {{ busySessions[s.id] ? 'working…' : fmtTime(s.time?.updated || s.time?.created) }}
            </div>
          </div>
        </NuxtLink>
        <UButton
          icon="i-lucide-trash-2"
          size="xs"
          color="neutral"
          variant="ghost"
          class="absolute right-1.5 top-1.5 opacity-0 group-hover:opacity-100"
          @click.stop.prevent="deleteSession(s.id)"
        />
      </div>
      <div v-if="!sessions.length && serverDegraded" class="flex items-center gap-1.5 px-2.5 py-4 text-xs text-error">
        <UIcon name="i-lucide-plug-zap" class="size-3.5 shrink-0" />
        Server not responding
      </div>
      <div v-else-if="!sessions.length" class="px-2.5 py-4 text-xs text-dimmed">No sessions yet</div>
    </div>

    <div class="p-3">
      <UButton
        block
        color="neutral"
        variant="ghost"
        icon="i-lucide-arrow-left"
        label="All projects"
        to="/"
      />
    </div>
  </div>
</template>
