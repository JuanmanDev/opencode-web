<script setup lang="ts">
// Shared MCP server list: search over servers & tools, accordion rows with
// status, tri-state mode control and per-tool mode selects. Used by the MCP
// settings page (persisted) and the chat options (per-prompt).
export interface McpListServer {
  name: string
  status: string
  error?: string
  /** secondary line (url / command) */
  detail?: string
  tools: Array<{ id: string; name: string; description?: string }>
}

const props = defineProps<{
  servers: McpListServer[]
  serverMode: (name: string) => 'off' | 'ask' | 'allow'
  toolMode: (id: string) => 'inherit' | 'deny' | 'ask' | 'allow'
  askDisabled?: boolean
  togglingName?: string | null
  /** height cap for the scrollable list */
  listClass?: string
}>()

const emit = defineEmits<{
  setServer: [name: string, mode: 'off' | 'ask' | 'allow']
  setTool: [id: string, mode: 'inherit' | 'deny' | 'ask' | 'allow']
}>()

const filter = ref('')
const open = ref<string[]>([])

function toggleOpen(name: string) {
  open.value = open.value.includes(name)
    ? open.value.filter((n) => n !== name)
    : [...open.value, name]
}

const filtered = computed(() => {
  const q = filter.value.trim().toLowerCase()
  if (!q) return props.servers
  return props.servers
    .map((server) => {
      const serverHit = server.name.toLowerCase().includes(q)
      const tools = server.tools.filter((t) => t.name.toLowerCase().includes(q))
      if (!serverHit && !tools.length) return null
      return { ...server, tools: serverHit && !tools.length ? server.tools : tools }
    })
    .filter(Boolean) as McpListServer[]
})

function statusColor(status: string) {
  if (['connected', 'running', 'ok', 'success'].includes(status)) return 'success' as const
  if (['failed', 'error'].includes(status)) return 'error' as const
  if (status === 'disabled') return 'neutral' as const
  return 'warning' as const
}
</script>

<template>
  <div class="space-y-1.5">
    <UInput
      v-model="filter"
      size="xs"
      icon="i-lucide-search"
      placeholder="Filter servers and tools…"
      class="w-full"
      :ui="{ trailing: 'pe-1' }"
    >
      <template v-if="filter" #trailing>
        <UButton icon="i-lucide-x" size="xs" color="neutral" variant="ghost" @click="filter = ''" />
      </template>
    </UInput>

    <div
      class="rounded-sm bg-elevated/60 divide-y divide-default overflow-y-auto overscroll-contain"
      :class="listClass || 'max-h-[50dvh] sm:max-h-[60vh]'"
    >
      <div v-if="!filtered.length" class="px-3 py-4 text-xs text-dimmed text-center">
        {{ filter ? `Nothing matches “${filter}”` : 'No MCP servers configured.' }}
      </div>

      <div v-for="server in filtered" :key="server.name">
        <!-- header row -->
        <div class="flex items-center gap-2 px-2.5 py-2">
          <component
            :is="server.tools.length ? 'button' : 'div'"
            class="flex items-center gap-2 flex-1 min-w-0 text-left"
            :class="server.tools.length ? 'cursor-pointer' : ''"
            @click="server.tools.length && toggleOpen(server.name)"
          >
            <UIcon
              v-if="server.tools.length"
              name="i-lucide-chevron-down"
              class="size-3.5 shrink-0 text-dimmed transition-transform duration-200"
              :class="open.includes(server.name) ? 'rotate-180' : ''"
            />
            <UIcon v-else name="i-lucide-server" class="size-3.5 shrink-0 text-dimmed" />
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="text-sm font-mono truncate">{{ server.name }}</span>
                <UBadge :color="statusColor(server.status)" variant="subtle" size="sm">
                  {{ server.status }}
                </UBadge>
                <span v-if="server.tools.length" class="text-[10px] text-dimmed shrink-0">
                  {{ server.tools.length }} tools
                </span>
              </div>
              <div v-if="server.detail" class="text-[10px] text-dimmed font-mono truncate">{{ server.detail }}</div>
            </div>
          </component>
          <McpModeControl
            :model-value="serverMode(server.name)"
            :ask-disabled="askDisabled"
            :loading="togglingName === server.name"
            @update:model-value="(m) => emit('setServer', server.name, m)"
          />
        </div>
        <p v-if="server.error" class="px-8 pb-2 text-xs text-error break-words -mt-1">
          {{ server.error }}
        </p>

        <!-- tools -->
        <CollapseTransition>
          <div
            v-if="server.tools.length && open.includes(server.name)"
            class="px-8 pb-2 space-y-1"
          >
            <McpToolRow
              v-for="tool in server.tools"
              :key="tool.id"
              :name="tool.name"
              :description="tool.description"
              :model-value="toolMode(tool.id)"
              :ask-disabled="askDisabled"
              :disabled="serverMode(server.name) === 'off' || togglingName === tool.id"
              @update:model-value="(v) => emit('setTool', tool.id, v)"
            />
          </div>
        </CollapseTransition>
      </div>
    </div>
  </div>
</template>
