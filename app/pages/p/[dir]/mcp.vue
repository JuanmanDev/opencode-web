<script setup lang="ts">
import type { McpStatus } from '#shared/types/opencode'

const route = useRoute()
const directory = computed(() => decodeDir(route.params.dir as string))
const api = useOpencodeApi(directory)
const toast = useToast()

interface McpEntry {
  name: string
  status: string
  error?: string
  config?: Record<string, unknown>
  enabled: boolean
}

const entries = ref<McpEntry[]>([])
const loading = ref(true)
const toggling = ref<string | null>(null)

async function refresh() {
  loading.value = true
  try {
    const [status, config] = await Promise.all([
      api.mcpStatus().catch(() => ({} as Record<string, McpStatus>)),
      api.config().catch(() => ({} as Record<string, unknown>))
    ])
    const mcpConfig = (config.mcp || {}) as Record<string, Record<string, unknown>>
    const names = new Set([...Object.keys(status), ...Object.keys(mcpConfig)])
    entries.value = [...names].sort().map((name) => {
      const s = (status[name] || {}) as Record<string, unknown>
      const cfg = mcpConfig[name]
      const statusText = String(s.status || s.state || (cfg?.enabled === false ? 'disabled' : 'unknown'))
      return {
        name,
        status: statusText,
        error: typeof s.error === 'string' ? s.error : undefined,
        config: cfg,
        enabled: cfg?.enabled !== false && statusText !== 'disabled'
      }
    })
  } finally {
    loading.value = false
  }
}

onMounted(refresh)
watch(directory, refresh)

async function toggle(entry: McpEntry, enabled: boolean) {
  toggling.value = entry.name
  try {
    await api.patchConfig({ mcp: { [entry.name]: { ...(entry.config || {}), enabled } } })
    toast.add({
      title: `${entry.name} ${enabled ? 'enabled' : 'disabled'}`,
      description: 'Applies to new sessions in this project.',
      color: 'success'
    })
    await refresh()
  } catch (e) {
    toast.add({ title: `Failed to update ${entry.name}`, description: String(e), color: 'error' })
  } finally {
    toggling.value = null
  }
}

function statusColor(status: string) {
  if (['connected', 'running', 'ok', 'success'].includes(status)) return 'success'
  if (['failed', 'error'].includes(status)) return 'error'
  if (status === 'disabled') return 'neutral'
  return 'warning'
}

// add server form
const addOpen = ref(false)
const addName = ref('')
const addType = ref<'remote' | 'local'>('remote')
const addUrl = ref('')
const addCommand = ref('')
const adding = ref(false)

async function addServer() {
  adding.value = true
  try {
    const config = addType.value === 'remote'
      ? { type: 'remote', url: addUrl.value.trim(), enabled: true }
      : { type: 'local', command: addCommand.value.trim().split(/\s+/), enabled: true }
    await api.mcpAdd(addName.value.trim(), config)
    toast.add({ title: `Added ${addName.value}`, color: 'success' })
    addOpen.value = false
    addName.value = addUrl.value = addCommand.value = ''
    await refresh()
  } catch (e) {
    toast.add({ title: 'Failed to add MCP server', description: String(e), color: 'error' })
  } finally {
    adding.value = false
  }
}

useHead(() => ({ title: `MCP · ${dirName(directory.value)} · opencode web` }))
</script>

<template>
  <div class="flex-1 overflow-y-auto">
    <div class="max-w-2xl mx-auto px-4 py-6">
      <div class="flex items-center gap-2 mb-1">
        <h1 class="text-lg font-semibold">MCP servers</h1>
        <span class="flex-1" />
        <UButton size="xs" variant="soft" icon="i-lucide-refresh-cw" :loading="loading" @click="refresh" />
        <UButton size="xs" color="primary" icon="i-lucide-plus" label="Add server" @click="addOpen = true" />
      </div>
      <p class="text-sm text-muted mb-6">
        Enabled servers for <span class="font-mono">{{ dirName(directory) }}</span>. Toggles are saved to this project's opencode config.
      </p>

      <div class="bg-muted rounded-sm divide-y divide-default">
        <div v-if="loading && !entries.length" class="p-4 space-y-3">
          <div v-for="i in 3" :key="i" class="flex items-center gap-3">
            <USkeleton class="size-4 rounded-full" />
            <div class="flex-1 space-y-1.5">
              <USkeleton class="h-3.5 w-1/4" />
              <USkeleton class="h-3 w-1/2" />
            </div>
            <USkeleton class="h-5 w-9 rounded-full" />
          </div>
        </div>
        <div
          v-for="entry in entries"
          :key="entry.name"
          class="flex items-center gap-3 px-4 py-3"
        >
          <UIcon name="i-lucide-server" class="size-4 text-muted shrink-0" />
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="text-sm font-medium font-mono truncate">{{ entry.name }}</span>
              <UBadge :color="statusColor(entry.status)" variant="subtle" size="sm">{{ entry.status }}</UBadge>
            </div>
            <div v-if="entry.error" class="text-xs text-error truncate">{{ entry.error }}</div>
            <div v-else-if="entry.config?.url" class="text-xs text-dimmed font-mono truncate">{{ entry.config.url }}</div>
            <div v-else-if="entry.config?.command" class="text-xs text-dimmed font-mono truncate">
              {{ Array.isArray(entry.config.command) ? (entry.config.command as string[]).join(' ') : entry.config.command }}
            </div>
          </div>
          <USwitch
            :model-value="entry.enabled"
            :disabled="toggling === entry.name"
            @update:model-value="(v: boolean) => toggle(entry, v)"
          />
        </div>
        <div v-if="!loading && !entries.length && serverDegraded" class="flex items-center justify-center gap-2 px-4 py-8 text-sm text-error">
          <UIcon name="i-lucide-plug-zap" class="size-4" />
          Server not responding — list unavailable.
        </div>
        <div v-else-if="!loading && !entries.length" class="px-4 py-8 text-center text-sm text-dimmed">
          No MCP servers configured for this project.
        </div>
      </div>
    </div>

    <UModal v-model:open="addOpen" title="Add MCP server" description="Registers the server for this project.">
      <template #body>
        <div class="space-y-3">
          <UFormField label="Name">
            <UInput v-model="addName" placeholder="context7" class="w-full font-mono" />
          </UFormField>
          <UFormField label="Type">
            <USelectMenu
              v-model="addType"
              :items="[{ label: 'Remote (URL)', value: 'remote' }, { label: 'Local (command)', value: 'local' }]"
              value-key="value"
              :search-input="false"
              class="w-full"
            />
          </UFormField>
          <UFormField v-if="addType === 'remote'" label="URL">
            <UInput v-model="addUrl" placeholder="https://mcp.example.com/mcp" class="w-full font-mono" />
          </UFormField>
          <UFormField v-else label="Command">
            <UInput v-model="addCommand" placeholder="npx -y @modelcontextprotocol/server-everything" class="w-full font-mono" />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton variant="ghost" color="neutral" label="Cancel" @click="addOpen = false" />
          <UButton
            color="primary"
            label="Add"
            :loading="adding"
            :disabled="!addName.trim() || (addType === 'remote' ? !addUrl.trim() : !addCommand.trim())"
            @click="addServer"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
