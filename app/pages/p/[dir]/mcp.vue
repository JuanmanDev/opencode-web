<script setup lang="ts">
import type { McpStatus } from '#shared/types/opencode'

const route = useRoute()
const directory = computed(() => decodeDir(route.params.dir as string))
const api = useOpencodeApi(directory)
const toast = useToast()

interface McpTool { id: string; name: string; description?: string; ui?: boolean }

interface McpEntry {
  name: string
  status: string
  error?: string
  config?: Record<string, unknown>
  enabled: boolean
  approx?: boolean
  skipped?: boolean
  tools: McpTool[]
}

const entries = ref<McpEntry[]>([])
// tool overrides from the opencode config (`tools` map) for the active scope
const configTools = ref<Record<string, boolean>>({})
// permission overrides ('ask' | 'allow' | 'deny') from the config `permission` map
const configPermission = ref<Record<string, string>>({})
const loading = ref(true)
const toggling = ref<string | null>(null)

// scope: this project's config, or the global opencode config (all projects)
const scope = ref<'project' | 'global'>('project')

function patchScoped(body: Record<string, unknown>) {
  return scope.value === 'global' ? api.patchGlobalConfig(body) : api.patchConfig(body)
}

interface DiscoveredTools {
  tools: Array<{ name: string; description?: string; ui?: boolean }>
  error?: string
  disabled?: boolean
  approx?: boolean
  skipped?: boolean
}

// opencode may run on another machine (docker on the LAN): a Windows project
// path then cannot exist there, and every local MCP server dies with ENOENT
const hostHome = ref('')
const isWindowsPath = (p: string) => /^[A-Za-z]:[\\/]/.test(p)
const dirMismatch = computed(() => {
  if (!hostHome.value || !directory.value) return false
  return isWindowsPath(directory.value) !== isWindowsPath(hostHome.value)
})
onMounted(() => {
  api.paths().then((p) => { hostHome.value = p?.home || '' }).catch(() => { /* older server */ })
})

async function refresh(rediscover = false) {
  loading.value = true
  try {
    const [status, config, discovered] = await Promise.all([
      api.mcpStatus().catch(() => ({} as Record<string, McpStatus>)),
      (scope.value === 'global' ? api.globalConfig() : api.config()).catch(() => ({} as Record<string, unknown>)),
      // tools come from the servers themselves (HTTP or stdio) - opencode
      // exposes no MCP tool ids at all
      $fetch<Record<string, DiscoveredTools>>('/api/v1/mcp-tools', {
        query: {
          directory: directory.value,
          scope: scope.value,
          ...(rediscover ? { refresh: '1' } : {})
        },
        timeout: 90000
      }).catch(() => ({} as Record<string, DiscoveredTools>))
    ])
    useMcpUiTools().learn(discovered)
    const mcpConfig = (config.mcp || {}) as Record<string, Record<string, unknown>>
    configTools.value = (config.tools || {}) as Record<string, boolean>
    configPermission.value = Object.fromEntries(
      Object.entries((config.permission || {}) as Record<string, unknown>)
        .filter(([, v]) => typeof v === 'string')
    ) as Record<string, string>
    const names = new Set([...Object.keys(status), ...Object.keys(mcpConfig)])
    entries.value = [...names].sort().map((name) => {
      const s = (status[name] || {}) as Record<string, unknown>
      const cfg = mcpConfig[name]
      const found = discovered[name]
      const statusText = String(s.status || s.state || (cfg?.enabled === false ? 'disabled' : 'unknown'))
      return {
        name,
        status: statusText,
        error: typeof s.error === 'string' ? s.error : found?.error,
        config: cfg,
        enabled: cfg?.enabled !== false && statusText !== 'disabled',
        approx: found?.approx,
        skipped: found?.skipped,
        tools: (found?.tools || [])
          .map((t) => ({ id: `${name}_${t.name}`, name: t.name, description: t.description, ui: t.ui }))
          .sort((a, b) => a.name.localeCompare(b.name))
      }
    })
  } finally {
    loading.value = false
  }
}

watch(scope, () => refresh())

// ---- saved presets: tri-state per server + per-tool overrides, shared
// server-side across devices (localStorage as offline fallback) ----
interface PageGroup {
  name: string
  servers?: Record<string, ServerMode>
  tools?: Record<string, Exclude<ToolMode, 'inherit'>>
  /** legacy on/off format */
  enabled?: Record<string, boolean>
}
// one shared key: presets are usable from any project, any scope, any device
const groupsKey = computed(() => 'opencode-web.mcp-presets.shared')
const groups = ref<PageGroup[]>([])
const groupName = ref('')
const applyingGroup = ref('')

function loadGroups() {
  try { groups.value = JSON.parse(localStorage.getItem(groupsKey.value) || '[]') } catch { groups.value = [] }
  // shared copy wins so presets follow you across devices
  $fetch<PageGroup[]>('/api/v1/mcp-presets', { query: { key: groupsKey.value }, timeout: 8000 })
    .then((shared) => {
      if (Array.isArray(shared) && shared.length) {
        groups.value = shared
        localStorage.setItem(groupsKey.value, JSON.stringify(shared))
      }
    })
    .catch(() => { /* offline */ })
}
onMounted(loadGroups)
watch(groupsKey, loadGroups)

function persistGroups() {
  localStorage.setItem(groupsKey.value, JSON.stringify(groups.value))
  $fetch('/api/v1/mcp-presets', {
    method: 'PUT',
    query: { key: groupsKey.value },
    body: groups.value,
    timeout: 8000
  }).catch(() => { /* offline: local copy is kept */ })
}

function saveGroup() {
  const name = groupName.value.trim()
  if (!name) return
  const tools: Record<string, Exclude<ToolMode, 'inherit'>> = {}
  for (const entry of entries.value) {
    for (const tool of entry.tools) {
      const mode = toolMode(tool.id)
      if (mode !== 'inherit') tools[tool.id] = mode
    }
  }
  const group: PageGroup = {
    name,
    servers: Object.fromEntries(entries.value.map((e) => [e.name, serverMode(e)])),
    tools
  }
  const idx = groups.value.findIndex((g) => g.name === name)
  if (idx >= 0) groups.value.splice(idx, 1, group)
  else groups.value.push(group)
  persistGroups()
  groupName.value = ''
  toast.add({ title: `Saved preset "${name}"`, description: 'Shared across your devices.', color: 'success' })
}

async function applyGroup(group: PageGroup) {
  applyingGroup.value = group.name
  try {
    const mcpPatch: Record<string, { enabled: boolean }> = {}
    const permissionPatch: Record<string, string> = {}
    const toolsPatch: Record<string, boolean> = {}

    const servers = group.servers
      || Object.fromEntries(Object.entries(group.enabled || {}).map(([n, on]) => [n, on ? 'allow' : 'off']))

    // presets are shared across projects: warn about servers this scope lacks
    const missing = Object.keys(servers).filter(
      (name) => !entries.value.some((e) => e.name === name)
    )
    if (missing.length) {
      toast.add({
        title: `Preset "${group.name}": ${missing.length} server(s) not configured here`,
        description: `Skipped: ${missing.join(', ')} — add them on this ${scope.value === 'global' ? 'global config' : 'project'} first.`,
        color: 'warning'
      })
    }

    for (const entry of entries.value) {
      const want = servers[entry.name] as ServerMode | undefined
      if (!want) continue
      mcpPatch[entry.name] = { enabled: want !== 'off' }
      if (want !== 'off') permissionPatch[`${entry.name}_*`] = want
    }
    for (const [toolId, mode] of Object.entries(group.tools || {})) {
      toolsPatch[toolId] = mode !== 'deny'
      if (mode !== 'deny') permissionPatch[toolId] = mode
    }

    await patchScoped({
      mcp: mcpPatch,
      ...(Object.keys(toolsPatch).length ? { tools: toolsPatch } : {}),
      ...(Object.keys(permissionPatch).length ? { permission: permissionPatch } : {})
    })
    toast.add({ title: `Applied "${group.name}"`, color: 'success' })
    await refresh()
  } catch (e) {
    toast.add({ title: `Failed to apply "${group.name}"`, description: String(e), color: 'error' })
  } finally {
    applyingGroup.value = ''
  }
}

function deleteGroup(name: string) {
  groups.value = groups.value.filter((g) => g.name !== name)
  persistGroups()
}

// ---- tri-state: off / ask / allow ----
type ServerMode = 'off' | 'ask' | 'allow'
type ToolMode = 'inherit' | 'deny' | 'ask' | 'allow'

function serverMode(entry: McpEntry): ServerMode {
  if (!entry.enabled) return 'off'
  const perm = configPermission.value[`${entry.name}_*`] || configPermission.value[`${entry.name}*`]
  return perm === 'ask' ? 'ask' : 'allow'
}

async function setServerMode(entry: McpEntry, mode: ServerMode) {
  toggling.value = entry.name
  try {
    if (mode === 'off') {
      await patchScoped({ mcp: { [entry.name]: { enabled: false } } })
    } else {
      await patchScoped({
        mcp: { [entry.name]: { enabled: true } },
        permission: { [`${entry.name}_*`]: mode }
      })
      configPermission.value = { ...configPermission.value, [`${entry.name}_*`]: mode }
    }
    toast.add({
      title: `${entry.name}: ${mode === 'off' ? 'disabled' : mode === 'ask' ? 'enabled (asks first)' : 'enabled (no ask)'}`,
      description: 'Applies to new sessions.',
      color: 'success'
    })
    await refresh()
  } catch (e) {
    toast.add({ title: `Failed to update ${entry.name}`, description: String(e), color: 'error' })
  } finally {
    toggling.value = null
  }
}

function toolMode(toolId: string): ToolMode {
  if (configTools.value[toolId] === false) return 'deny'
  const perm = configPermission.value[toolId]
  return perm === 'ask' || perm === 'allow' ? perm : 'inherit'
}

async function setToolMode(toolId: string, mode: ToolMode) {
  toggling.value = toolId
  try {
    if (mode === 'deny') {
      await patchScoped({ tools: { [toolId]: false } })
      configTools.value = { ...configTools.value, [toolId]: false }
    } else if (mode === 'inherit') {
      await patchScoped({ tools: { [toolId]: true } })
      configTools.value = { ...configTools.value, [toolId]: true }
      const { [toolId]: _gone, ...rest } = configPermission.value
      configPermission.value = rest
    } else {
      await patchScoped({ tools: { [toolId]: true }, permission: { [toolId]: mode } })
      configTools.value = { ...configTools.value, [toolId]: true }
      configPermission.value = { ...configPermission.value, [toolId]: mode }
    }
    toast.add({ title: `${toolId}: ${mode}`, color: 'success' })
  } catch (e) {
    toast.add({ title: `Failed to update ${toolId}`, description: String(e), color: 'error' })
  } finally {
    toggling.value = null
  }
}

// adapters for the shared McpServerList
const listServers = computed(() => entries.value.map((e) => ({
  name: e.name,
  status: e.status,
  error: e.error,
  approx: e.approx,
  skipped: e.skipped,
  detail: typeof e.config?.url === 'string'
    ? e.config.url as string
    : Array.isArray(e.config?.command) ? (e.config!.command as string[]).join(' ') : undefined,
  tools: e.tools
})))

function serverModeByName(name: string) {
  const entry = entries.value.find((e) => e.name === name)
  return entry ? serverMode(entry) : 'allow'
}

function onSetServer(name: string, mode: 'off' | 'ask' | 'allow') {
  const entry = entries.value.find((e) => e.name === name)
  if (entry) setServerMode(entry, mode)
}

// ---- repairing broken servers ----

/** Reconnect a failed server in place; no opencode restart needed. */
async function retryServer(name: string) {
  toggling.value = name
  try {
    await api.mcpConnect(name)
    await refresh(true)
    const status = entries.value.find((e) => e.name === name)?.status
    toast.add({
      title: `${name}: ${status || 'reconnected'}`,
      color: status === 'connected' ? 'success' : 'warning'
    })
  } catch (e) {
    toast.add({ title: `Could not connect ${name}`, description: String(e), color: 'error' })
  } finally {
    toggling.value = null
  }
}

// OAuth for servers reporting needs_auth: opencode hands back a consent URL,
// the user pastes the resulting code here (the browser may be on another device)
const authName = ref('')
const authUrl = ref('')
const authCode = ref('')
const authBusy = ref(false)

async function startAuth(name: string) {
  authName.value = name
  authUrl.value = ''
  authCode.value = ''
  authBusy.value = true
  try {
    const { authorizationUrl } = await api.mcpAuthStart(name)
    authUrl.value = authorizationUrl
    window.open(authorizationUrl, '_blank', 'noopener')
  } catch (e) {
    toast.add({
      title: `${name} does not support OAuth sign-in`,
      description: String(e),
      color: 'error'
    })
    authName.value = ''
  } finally {
    authBusy.value = false
  }
}

async function completeAuth() {
  const code = authCode.value.trim()
  if (!code || !authName.value) return
  authBusy.value = true
  try {
    await api.mcpAuthCallback(authName.value, code)
    toast.add({ title: `${authName.value}: signed in`, color: 'success' })
    authName.value = ''
    await refresh(true)
  } catch (e) {
    toast.add({ title: 'Sign-in failed', description: String(e), color: 'error' })
  } finally {
    authBusy.value = false
  }
}

onMounted(refresh)
watch(directory, () => refresh())


// ---- add servers ----
const addOpen = ref(false)
const addingName = ref<string | null>(null)

interface CatalogEntry {
  name: string
  title: string
  description: string
  icon: string
  badge?: string
  config: Record<string, unknown>
}

// curated suggestions; the MCP-UI demo showcases interactive UI apps in chat
const CATALOG: CatalogEntry[] = [
  {
    name: 'demo-ui-apps',
    title: 'Demo UI apps (built-in)',
    description: 'This app\'s own demo MCP server: metric card, dynamic background, forex chart, weather — rendered live in chat. The opencode server must be able to reach this web app\'s URL.',
    icon: 'i-lucide-sparkles',
    badge: 'MCP UI',
    config: { type: 'remote', url: 'SELF', enabled: true }
  },
  {
    name: 'mcp-ui-demo',
    title: 'MCP-UI demo',
    description: 'Official mcp-ui example server — tools return interactive UI apps rendered right in the chat.',
    icon: 'i-lucide-app-window',
    badge: 'MCP UI',
    config: { type: 'remote', url: 'https://remote-mcp-server-authless.idosalomon.workers.dev/mcp', enabled: true }
  },
  {
    name: 'context7',
    title: 'Context7',
    description: 'Up-to-date documentation for any library or framework.',
    icon: 'i-lucide-book-open',
    config: { type: 'remote', url: 'https://mcp.context7.com/mcp', enabled: true }
  },
  {
    name: 'deepwiki',
    title: 'DeepWiki',
    description: 'Ask questions about any public GitHub repository.',
    icon: 'i-lucide-github',
    config: { type: 'remote', url: 'https://mcp.deepwiki.com/mcp', enabled: true }
  },
  {
    name: 'huggingface',
    title: 'Hugging Face',
    description: 'Search models, datasets, papers and Spaces.',
    icon: 'i-lucide-smile',
    config: { type: 'remote', url: 'https://huggingface.co/mcp', enabled: true }
  },
  {
    name: 'playwright',
    title: 'Playwright',
    description: 'Drive a real browser: navigate, click, screenshot.',
    icon: 'i-lucide-globe',
    badge: 'local',
    config: { type: 'local', command: ['npx', '-y', '@playwright/mcp@latest'], enabled: true }
  },
  {
    name: 'memory',
    title: 'Memory',
    description: 'Persistent knowledge-graph memory across sessions.',
    icon: 'i-lucide-database',
    badge: 'local',
    config: { type: 'local', command: ['npx', '-y', '@modelcontextprotocol/server-memory'], enabled: true }
  }
]

const installed = computed(() => new Set(entries.value.map((e) => e.name)))

async function addEntry(name: string, config: Record<string, unknown>) {
  addingName.value = name
  try {
    // 'SELF' -> this web app's own demo MCP server
    if (config.url === 'SELF') {
      config = { ...config, url: `${window.location.origin}/mcp-demo` }
    }
    await api.mcpAdd(name, config)
    // POST /mcp only registers in memory; persist so it survives restarts
    await patchScoped({ mcp: { [name]: config } }).catch(() => {})
    await refresh()
    const status = entries.value.find((e) => e.name === name)?.status
    toast.add({
      title: `Added ${name}`,
      description: status ? `Status: ${status}` : undefined,
      color: status === 'failed' || status === 'error' ? 'warning' : 'success'
    })
  } catch (e) {
    toast.add({ title: `Failed to add ${name}`, description: String(e), color: 'error' })
  } finally {
    addingName.value = null
  }
}

// smart custom input: URL, command line, opencode/claude JSON — all accepted
const customName = ref('')
const customInput = ref('')

function parseCustom(): Array<{ name: string; config: Record<string, unknown> }> {
  const input = customInput.value.trim()
  if (!input) return []

  const fallbackName = (hint: string) =>
    customName.value.trim() ||
    hint.replace(/^https?:\/\//, '').split(/[/.]/)[0]?.toLowerCase() ||
    'custom'

  // JSON: single config, or a claude/opencode style map of servers
  if (input.startsWith('{')) {
    const parsed = JSON.parse(input)
    const map = parsed.mcpServers || parsed.mcp
    if (map && typeof map === 'object') {
      return Object.entries(map as Record<string, any>).map(([name, raw]) => ({
        name,
        config: normalizeConfig(raw)
      }))
    }
    return [{ name: fallbackName('custom'), config: normalizeConfig(parsed) }]
  }

  if (/^https?:\/\//.test(input)) {
    return [{ name: fallbackName(input), config: { type: 'remote', url: input, enabled: true } }]
  }

  // anything else = local command line
  return [{
    name: customName.value.trim() || input.split(/\s+/).pop()?.replace(/[^a-z0-9-]/gi, '') || 'local',
    config: { type: 'local', command: input.split(/\s+/), enabled: true }
  }]
}

function normalizeConfig(raw: Record<string, any>): Record<string, unknown> {
  if (raw.url) {
    return { type: 'remote', url: raw.url, ...(raw.headers ? { headers: raw.headers } : {}), enabled: raw.enabled !== false }
  }
  const command = Array.isArray(raw.command)
    ? raw.command
    : [raw.command, ...(Array.isArray(raw.args) ? raw.args : [])].filter(Boolean)
  return {
    type: 'local',
    command,
    ...(raw.env || raw.environment ? { environment: raw.env || raw.environment } : {}),
    enabled: raw.enabled !== false
  }
}

const addingCustom = ref(false)

async function addCustom() {
  addingCustom.value = true
  try {
    const parsed = parseCustom()
    if (!parsed.length) return
    for (const { name, config } of parsed) {
      await api.mcpAdd(name, config)
      await patchScoped({ mcp: { [name]: config } }).catch(() => {})
    }
    await refresh()
    toast.add({
      title: parsed.length === 1 ? `Added ${parsed[0]!.name}` : `Added ${parsed.length} servers`,
      color: 'success'
    })
    customName.value = customInput.value = ''
    addOpen.value = false
  } catch (e) {
    toast.add({
      title: 'Could not add server',
      description: e instanceof SyntaxError ? 'Invalid JSON.' : String(e),
      color: 'error'
    })
  } finally {
    addingCustom.value = false
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
        <UButton
          size="xs"
          variant="soft"
          icon="i-lucide-refresh-cw"
          :loading="loading"
          aria-label="Rescan servers and tools"
          @click="refresh(true)"
        />
        <UButton size="xs" color="primary" icon="i-lucide-plus" label="Add server" @click="addOpen = true" />
      </div>
      <p class="text-sm text-muted mb-4">
        {{ scope === 'global'
          ? 'Global opencode config — applies to every project.'
          : `Enabled servers for ${dirName(directory)} — saved to this project's opencode config.` }}
      </p>

      <!-- scope: project vs global -->
      <div class="flex items-center gap-1 mb-3">
        <UButton
          size="xs"
          :variant="scope === 'project' ? 'solid' : 'soft'"
          :color="scope === 'project' ? 'primary' : 'neutral'"
          icon="i-lucide-folder-git-2"
          :label="dirName(directory)"
          @click="scope = 'project'"
        />
        <UButton
          size="xs"
          :variant="scope === 'global' ? 'solid' : 'soft'"
          :color="scope === 'global' ? 'primary' : 'neutral'"
          icon="i-lucide-globe"
          label="Global"
          @click="scope = 'global'"
        />
      </div>

      <UAlert
        v-if="dirMismatch"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        class="mb-3"
        title="This project path does not exist on the opencode host"
        :description="`opencode runs with home ${hostHome}, but this project is ${directory}. `
          + 'Remote MCP servers still work; local (stdio) ones fail to spawn because their working '
          + 'directory is missing. Open a project path that exists on the opencode host.'"
      />

      <div v-if="loading && !entries.length" class="bg-muted rounded-sm p-4 space-y-3">
        <div v-for="i in 3" :key="i" class="flex items-center gap-3">
          <USkeleton class="size-4 rounded-full" />
          <div class="flex-1 space-y-1.5">
            <USkeleton class="h-3.5 w-1/4" />
            <USkeleton class="h-3 w-1/2" />
          </div>
          <USkeleton class="h-5 w-24 rounded-sm" />
        </div>
      </div>
      <div v-else-if="!entries.length && serverDegraded" class="flex items-center justify-center gap-2 rounded-sm bg-muted px-4 py-8 text-sm text-error">
        <UIcon name="i-lucide-plug-zap" class="size-4" />
        Server not responding — list unavailable.
      </div>
      <McpServerList
        v-else
        :servers="listServers"
        :server-mode="serverModeByName"
        :tool-mode="toolMode"
        :toggling-name="toggling"
        :loading="loading"
        repairable
        list-class="grow"
        @set-server="onSetServer"
        @set-tool="setToolMode"
        @retry="retryServer"
        @authenticate="startAuth"
      >
        <!-- saved presets share the filter row -->
        <template #actions>
          <div v-for="g in groups" :key="g.name" class="flex items-center rounded-sm overflow-hidden">
            <UButton
              size="xs"
              variant="soft"
              color="neutral"
              icon="i-lucide-layers"
              :label="g.name"
              :loading="applyingGroup === g.name"
              class="rounded-r-none"
              @click="applyGroup(g)"
            />
            <UButton
              size="xs"
              variant="soft"
              color="neutral"
              icon="i-lucide-x"
              class="rounded-l-none"
              :aria-label="`Delete preset ${g.name}`"
              @click="deleteGroup(g.name)"
            />
          </div>
          <UInput
            v-model="groupName"
            size="xs"
            placeholder="Save as…"
            class="w-28 font-mono"
            @keydown.enter="saveGroup"
          />
          <UTooltip text="Save the current enabled/disabled selection">
            <UButton
              size="xs"
              variant="soft"
              color="neutral"
              icon="i-lucide-save"
              :disabled="!groupName.trim()"
              aria-label="Save preset"
              @click="saveGroup"
            />
          </UTooltip>
        </template>
      </McpServerList>

      <!-- OAuth: paste back the code from the consent screen -->
      <div v-if="authName" class="mt-3 rounded-sm bg-muted p-3 space-y-2">
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-key-round" class="size-4 text-muted shrink-0" />
          <span class="text-sm font-medium flex-1">Sign in to {{ authName }}</span>
          <UButton
            size="xs"
            variant="ghost"
            color="neutral"
            icon="i-lucide-x"
            aria-label="Cancel sign-in"
            @click="authName = ''"
          />
        </div>
        <p class="text-xs text-muted">
          A consent page was opened.
          <ULink v-if="authUrl" :to="authUrl" target="_blank" class="underline">Open it again</ULink>
          — then paste the authorization code below.
        </p>
        <div class="flex gap-1.5">
          <UInput
            v-model="authCode"
            size="sm"
            placeholder="authorization code"
            class="flex-1 font-mono"
            @keydown.enter="completeAuth"
          />
          <UButton
            size="sm"
            color="primary"
            label="Finish"
            :loading="authBusy"
            :disabled="!authCode.trim()"
            @click="completeAuth"
          />
        </div>
      </div>
    </div>

    <UModal
      v-model:open="addOpen"
      title="Add MCP server"
      description="One-click suggestions, or paste anything — a URL, a command, or a JSON config."
    >
      <template #body>
        <div class="space-y-5">
          <section>
            <h3 class="text-xs font-medium text-muted mb-2">Suggested</h3>
            <div class="space-y-1.5">
              <div
                v-for="entry in CATALOG"
                :key="entry.name"
                class="oc-row flex items-center gap-3 rounded-sm bg-muted px-3 py-2.5"
              >
                <UIcon :name="entry.icon" class="size-4 text-muted shrink-0" />
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <span class="text-sm font-medium">{{ entry.title }}</span>
                    <UBadge v-if="entry.badge" size="sm" variant="subtle" :color="entry.badge === 'MCP UI' ? 'primary' : 'neutral'">
                      {{ entry.badge }}
                    </UBadge>
                  </div>
                  <p class="text-xs text-dimmed truncate">{{ entry.description }}</p>
                </div>
                <UButton
                  v-if="installed.has(entry.name)"
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  icon="i-lucide-check"
                  label="Added"
                  disabled
                />
                <UButton
                  v-else
                  size="xs"
                  color="primary"
                  variant="soft"
                  icon="i-lucide-plus"
                  label="Add"
                  :loading="addingName === entry.name"
                  @click="addEntry(entry.name, entry.config)"
                />
              </div>
            </div>
          </section>

          <USeparator label="or custom" />

          <section class="space-y-2">
            <UFormField
              label="URL, command or JSON"
              size="sm"
              description="Examples: https://mcp.example.com/mcp · npx -y @playwright/mcp · a pasted mcpServers JSON block (adds all entries)."
            >
              <UTextarea
                v-model="customInput"
                :rows="3"
                autoresize
                :maxrows="8"
                placeholder='https://mcp.example.com/mcp'
                class="w-full font-mono"
              />
            </UFormField>
            <UFormField label="Name" size="sm" description="Optional — derived from the URL/command when empty.">
              <UInput v-model="customName" placeholder="my-server" class="w-full font-mono" />
            </UFormField>
          </section>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton variant="ghost" color="neutral" label="Close" @click="addOpen = false" />
          <UButton
            color="primary"
            icon="i-lucide-plus"
            label="Add custom"
            :loading="addingCustom"
            :disabled="!customInput.trim()"
            @click="addCustom"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
