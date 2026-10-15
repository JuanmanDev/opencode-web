<script setup lang="ts">
// Everything about one MCP server in one place: why it fails and how to fix
// it, its tools with full descriptions and parameters, a config editor that
// never exposes stored secrets, and an end-to-end connection test. Also used
// to add a server by hand (no `name` → create mode, optionally prefilled).
import { mcpErrorHint, type McpErrorHint } from '#shared/utils/mcp-hints'

type Tab = 'overview' | 'tools' | 'config' | 'test'

interface ServerConfig {
  type?: string
  url?: string
  headers?: Record<string, string>
  command?: string[]
  environment?: Record<string, string>
  enabled?: boolean
  timeout?: number
  oauth?: false | Record<string, unknown>
}

interface ToolParam { name: string; type?: string; required?: boolean; description?: string; enum?: string[] }
interface ToolDetail {
  name: string
  title?: string
  description?: string
  fullDescription?: string
  ui?: boolean
  readOnly?: boolean
  destructive?: boolean
  params: ToolParam[]
}
interface InspectResult {
  ok: boolean
  transport?: 'http' | 'sse' | 'stdio'
  server?: { name?: string; version?: string; protocolVersion?: string; instructions?: string }
  capabilities: string[]
  tools: ToolDetail[]
  resources: Array<{ uri: string; name?: string; description?: string; mimeType?: string }>
  prompts: Array<{ name: string; description?: string }>
  steps: Array<{ label: string; ok: boolean; detail?: string; ms?: number }>
  error?: string
  hint?: McpErrorHint
  stderr?: string
  approx?: boolean
  durationMs: number
}
interface ServerInfo {
  name: string
  definedIn: 'project' | 'global' | null
  config: ServerConfig | null
  status: { status: string; error?: string } | null
  hint: McpErrorHint | null
}

const open = defineModel<boolean>('open', { default: false })
const props = defineProps<{
  /** server to show; empty = add a new one */
  name?: string | null
  directory: string
  /** scope the page is showing: default target for new servers */
  scope: 'project' | 'global'
  initialTab?: Tab
  /** create mode: prefilled config and name */
  preset?: { name?: string; config: ServerConfig; note?: string } | null
}>()
const emit = defineEmits<{
  saved: [name: string]
  authenticate: [name: string]
}>()

const toast = useToast()
const creating = computed(() => !props.name)
const tab = ref<Tab>('overview')
const info = ref<ServerInfo | null>(null)
const loadingInfo = ref(false)
const inspect = ref<InspectResult | null>(null)
const testing = ref(false)
const saving = ref(false)
const reconnecting = ref(false)

// ---- editor model ----
interface Pair { key: string; value: string; stored: boolean; reveal: boolean }
const REDACTED = '***'

const form = reactive({
  name: '',
  type: 'remote' as 'remote' | 'local',
  url: '',
  command: '',
  headers: [] as Pair[],
  env: [] as Pair[],
  oauth: true,
  enabled: true,
  timeout: '',
  scope: 'project' as 'project' | 'global'
})
const jsonMode = ref(false)
const jsonText = ref('')
const jsonError = ref('')

function toPairs(map?: Record<string, string>): Pair[] {
  return Object.entries(map || {}).map(([key, value]) => ({
    key,
    value: value === REDACTED ? '' : value,
    stored: value === REDACTED,
    reveal: false
  }))
}

function fromPairs(pairs: Pair[]) {
  const out: Record<string, string> = {}
  for (const p of pairs) {
    const key = p.key.trim()
    if (!key) continue
    // an untouched stored secret goes back as the placeholder: the server keeps the real value
    out[key] = p.stored && !p.value ? REDACTED : p.value
  }
  return out
}

function splitCommand(line: string) {
  const out: string[] = []
  for (const m of line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  return out
}

function joinCommand(parts?: string[]) {
  return (parts || []).map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(' ')
}

function loadForm(name: string, config: ServerConfig | null | undefined, scope: 'project' | 'global') {
  const c = config || { type: 'remote' }
  form.name = name
  form.type = c.type === 'local' || (!c.type && c.command) ? 'local' : 'remote'
  form.url = c.url || ''
  form.command = joinCommand(c.command)
  form.headers = toPairs(c.headers)
  form.env = toPairs(c.environment)
  form.oauth = c.oauth !== false
  form.enabled = c.enabled !== false
  form.timeout = typeof c.timeout === 'number' ? String(c.timeout) : ''
  form.scope = scope
  jsonMode.value = false
  jsonError.value = ''
}

function buildConfig(): ServerConfig {
  const timeout = Number(form.timeout)
  const common = {
    enabled: form.enabled,
    ...(timeout > 0 ? { timeout: Math.round(timeout) } : {})
  }
  if (form.type === 'local') {
    const environment = fromPairs(form.env)
    return { type: 'local', command: splitCommand(form.command), ...(Object.keys(environment).length ? { environment } : {}), ...common }
  }
  const headers = fromPairs(form.headers)
  return {
    type: 'remote',
    url: form.url.trim(),
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(form.oauth ? {} : { oauth: false as const }),
    ...common
  }
}

watch(jsonMode, (on) => {
  if (on) {
    jsonText.value = JSON.stringify(buildConfig(), null, 2)
    jsonError.value = ''
  }
})

function applyJson() {
  try {
    const parsed = JSON.parse(jsonText.value) as ServerConfig
    if (!parsed || typeof parsed !== 'object') throw new Error('expected an object')
    loadForm(form.name, parsed, form.scope)
    return true
  } catch (error) {
    jsonError.value = error instanceof Error ? error.message : String(error)
    jsonMode.value = true
    return false
  }
}

function currentConfig(): ServerConfig | null {
  if (jsonMode.value && !applyJson()) return null
  return buildConfig()
}

const bearer = computed(() => form.headers.find((h) => h.key.toLowerCase() === 'authorization'))

/** The fix for OAuth-only failures (Home Assistant & co): a token header, OAuth off. */
function useToken() {
  tab.value = 'config'
  jsonMode.value = false
  form.type = 'remote'
  form.oauth = false
  if (!bearer.value) form.headers.push({ key: 'Authorization', value: 'Bearer ', stored: false, reveal: true })
  nextTick(() => document.querySelector<HTMLInputElement>('[data-header-value="Authorization"] input')?.focus())
}

function addPair(list: Pair[]) {
  list.push({ key: '', value: '', stored: false, reveal: true })
}

// ---- data ----
const status = computed(() => info.value?.status?.status || (form.enabled ? 'unknown' : 'disabled'))
const error = computed(() => info.value?.status?.error)
const hint = computed(() => info.value?.hint || mcpErrorHint(error.value, status.value) || null)
const OK = ['connected', 'running', 'ok', 'success']
const BROKEN = ['failed', 'error', 'needs_auth', 'needs_client_registration']
const statusColor = computed(() => OK.includes(status.value) ? 'success' as const
  : BROKEN.includes(status.value) ? 'error' as const
    : status.value === 'disabled' ? 'neutral' as const : 'warning' as const)

async function loadInfo() {
  if (!props.name) return
  loadingInfo.value = true
  try {
    info.value = await $fetch<ServerInfo>('/api/v1/mcp-server', {
      query: { name: props.name, directory: props.directory },
      timeout: 130_000
    })
    loadForm(props.name, info.value.config, info.value.definedIn || props.scope)
    // broken: our own test tells the first error, opencode only the last one
    if (BROKEN.includes(info.value.status?.status || '') && !inspect.value && !testing.value) runTest(false, false)
  } catch (e) {
    toast.add({ title: `Could not load ${props.name}`, description: errorText(e), color: 'error' })
  } finally {
    loadingInfo.value = false
  }
}

function errorText(e: unknown) {
  const data = (e as { data?: { message?: string } })?.data
  return data?.message || (e instanceof Error ? e.message : String(e))
}

async function runTest(useEdited = tab.value === 'config', show = true) {
  const config = useEdited || creating.value ? currentConfig() : null
  if ((useEdited || creating.value) && !config) return
  testing.value = true
  if (show && tab.value !== 'tools') tab.value = 'test'
  try {
    inspect.value = await $fetch<InspectResult>('/api/v1/mcp-test', {
      method: 'POST',
      body: {
        name: props.name || undefined,
        scope: props.name ? (info.value?.definedIn || undefined) : undefined,
        directory: props.directory,
        ...(config ? { config } : {})
      },
      timeout: 120_000
    })
  } catch (e) {
    toast.add({ title: 'Test failed to run', description: errorText(e), color: 'error' })
  } finally {
    testing.value = false
  }
}

async function save() {
  const config = currentConfig()
  if (!config) return
  const name = (form.name || '').trim()
  if (!name) {
    toast.add({ title: 'Give the server a name', color: 'warning' })
    return
  }
  saving.value = true
  try {
    const result = await $fetch<{ status?: { status: string; error?: string }; hint?: McpErrorHint; dropped?: string[]; blanked?: string[]; scope?: string; fallback?: boolean }>('/api/v1/mcp-server', {
      method: 'PUT',
      body: { name, scope: form.scope, directory: props.directory, config },
      timeout: 150_000
    })
    const ok = !result.status || OK.includes(result.status.status) || result.status.status === 'disabled'
    toast.add({
      title: `${name}: saved${result.status ? ` · ${result.status.status}` : ''}`,
      description: ok
        ? `Stored in the ${result.scope || form.scope} config${result.fallback ? ' (this opencode ignores project config written through its API)' : ''}.${result.dropped?.length ? ` This opencode version ignores: ${result.dropped.join(', ')}.` : ''}`
          + (result.blanked?.length ? ` Removed entries (${result.blanked.join(', ')}) are saved empty: opencode's config API cannot delete keys.` : '')
        : result.hint ? `${result.hint.title}. ${result.hint.fix}` : result.status?.error,
      color: ok ? 'success' : 'warning'
    })
    emit('saved', name)
    if (creating.value) {
      if (ok) open.value = false
    } else {
      info.value = { ...(info.value as ServerInfo), status: result.status || null, hint: result.hint || null }
      if (!ok) tab.value = 'overview'
    }
  } catch (e) {
    toast.add({ title: `Could not save ${name}`, description: errorText(e), color: 'error' })
  } finally {
    saving.value = false
  }
}

async function reconnect() {
  if (!props.name) return
  reconnecting.value = true
  try {
    await $fetch(`/api/opencode/mcp/${encodeURIComponent(props.name)}/connect`, {
      method: 'POST', body: {}, query: { directory: props.directory }, timeout: 65_000
    }).catch(() => {})
    await loadInfo()
    emit('saved', props.name)
  } finally {
    reconnecting.value = false
  }
}

watch(open, (isOpen) => {
  if (!isOpen) return
  inspect.value = null
  info.value = null
  toolFilter.value = ''
  expanded.value = []
  if (props.name) {
    loadForm(props.name, null, props.scope)
    tab.value = props.initialTab || 'overview'
    loadInfo()
    if (tab.value === 'tools') runTest(false)
  } else {
    loadForm(props.preset?.name || '', props.preset?.config || { type: 'remote', enabled: true }, props.scope)
    tab.value = 'config'
  }
}, { immediate: true })

// tools load lazily: they need a live connection
watch(tab, (t) => {
  if (t === 'tools' && !inspect.value && !testing.value && props.name) runTest(false)
})

const tabs = computed(() => [
  ...(creating.value ? [] : [{ label: 'Overview', value: 'overview', icon: 'i-lucide-activity' }]),
  ...(creating.value ? [] : [{ label: 'Tools', value: 'tools', icon: 'i-lucide-wrench', badge: inspect.value?.ok ? String(inspect.value.tools.length) : undefined }]),
  { label: creating.value ? 'Server' : 'Edit', value: 'config', icon: 'i-lucide-settings-2' },
  { label: 'Test', value: 'test', icon: 'i-lucide-flask-conical' }
])

// ---- tools tab ----
const toolFilter = ref('')
const expanded = ref<string[]>([])
const filteredTools = computed(() => {
  const q = toolFilter.value.trim().toLowerCase()
  const tools = inspect.value?.tools || []
  return q
    ? tools.filter((t) => t.name.toLowerCase().includes(q) || (t.fullDescription || '').toLowerCase().includes(q))
    : tools
})
function toggleTool(name: string) {
  expanded.value = expanded.value.includes(name) ? expanded.value.filter((n) => n !== name) : [...expanded.value, name]
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.add({ title: 'Copied', color: 'success' })
  } catch { /* insecure context */ }
}

const title = computed(() => creating.value ? 'Add MCP server' : props.name || '')
</script>

<template>
  <UModal
    v-model:open="open"
    :title="title"
    :description="creating ? (preset?.note || 'Remote URL or local command; test it before saving.') : 'Status, tools, settings and a connection test.'"
    :ui="{ content: 'sm:max-w-2xl', body: 'p-0 sm:p-0' }"
  >
    <template #body>
      <div class="flex flex-col min-h-0">
        <!-- header strip: status + where it lives -->
        <div v-if="!creating" class="flex flex-wrap items-center gap-2 px-4 pt-3 pb-2">
          <UBadge :color="statusColor" variant="subtle" class="oc-appear">
            <UIcon v-if="loadingInfo" name="i-lucide-loader-circle" class="size-3 animate-spin" />
            {{ status }}
          </UBadge>
          <UBadge v-if="info?.definedIn" color="neutral" variant="soft" :icon="info.definedIn === 'global' ? 'i-lucide-globe' : 'i-lucide-folder-git-2'">
            {{ info.definedIn }} config
          </UBadge>
          <UBadge v-if="inspect?.transport" color="neutral" variant="soft">
            {{ inspect.transport === 'sse' ? 'legacy SSE' : inspect.transport === 'stdio' ? 'stdio' : 'Streamable HTTP' }}
          </UBadge>
          <span class="flex-1" />
          <UButton
            size="xs"
            variant="soft"
            color="neutral"
            icon="i-lucide-refresh-cw"
            label="Reconnect"
            :loading="reconnecting"
            :disabled="!form.enabled"
            @click="reconnect"
          />
        </div>

        <div class="px-4">
          <UTabs v-model="tab" :items="tabs" :content="false" size="xs" variant="link" class="w-full" />
        </div>

        <div class="px-4 py-3 min-h-64">
          <Transition name="oc-fade" mode="out-in">
            <!-- ================= overview ================= -->
            <div v-if="tab === 'overview'" key="overview" class="space-y-3">
              <div v-if="loadingInfo && !info" class="space-y-2">
                <USkeleton class="h-4 w-1/2" />
                <USkeleton class="h-16 w-full" />
              </div>
              <template v-else>
                <UAlert
                  v-if="error || hint"
                  color="error"
                  variant="subtle"
                  icon="i-lucide-circle-alert"
                  :title="hint?.title || 'Connection failed'"
                  class="oc-appear"
                >
                  <template #description>
                    <p v-if="hint" class="mb-1.5">{{ hint.fix }}</p>
                    <p v-if="error" class="font-mono text-[11px] break-all opacity-80">opencode: {{ error }}</p>
                    <p v-if="testing && !inspect" class="text-[11px] mt-1 opacity-80">
                      <UIcon name="i-lucide-loader-circle" class="size-3 animate-spin align-[-2px]" /> testing the connection…
                    </p>
                    <div v-else-if="inspect && !inspect.ok" class="mt-1.5 pt-1.5 border-t border-error/20">
                      <p class="text-[11px] font-medium">Direct test: {{ inspect.hint?.title || inspect.error }}</p>
                      <p v-if="inspect.hint && inspect.hint.title !== hint?.title" class="text-[11px]">{{ inspect.hint.fix }}</p>
                      <p class="font-mono text-[11px] break-all opacity-80">{{ inspect.error }}</p>
                    </div>
                    <p v-else-if="inspect?.ok" class="text-[11px] mt-1.5">
                      The direct test from the web app works ({{ inspect.tools.length }} tools): the problem is on the opencode
                      host — its network, DNS or environment. Try Reconnect.
                    </p>
                    <div class="flex flex-wrap gap-1.5 mt-2">
                      <UButton v-if="hint?.action === 'use-token'" size="xs" color="error" variant="solid" icon="i-lucide-key-round" label="Use a token instead" @click="useToken" />
                      <UButton v-if="hint?.action === 'sign-in' && name" size="xs" color="primary" variant="solid" icon="i-lucide-log-in" label="Sign in (OAuth)" @click="emit('authenticate', name)" />
                      <UButton v-if="hint?.action === 'check-url' || hint?.action === 'check-command' || hint?.action === 'raise-timeout'" size="xs" color="neutral" variant="soft" icon="i-lucide-pencil" label="Edit settings" @click="tab = 'config'" />
                      <UButton size="xs" color="neutral" variant="soft" icon="i-lucide-flask-conical" label="Run a test" :loading="testing" @click="runTest(false)" />
                    </div>
                  </template>
                </UAlert>
                <UAlert
                  v-else-if="status === 'disabled'"
                  color="neutral"
                  variant="subtle"
                  icon="i-lucide-power-off"
                  title="Disabled"
                  description="opencode does not start this server. Test it first, then enable it from the list or the Edit tab."
                />
                <UAlert
                  v-else-if="OK.includes(status)"
                  color="success"
                  variant="subtle"
                  icon="i-lucide-circle-check"
                  title="Connected"
                  :description="`opencode is using this server${inspect?.ok ? ` · ${inspect.tools.length} tools` : ''}.`"
                />

                <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
                  <dt class="text-dimmed">type</dt>
                  <dd class="font-mono">{{ form.type }}</dd>
                  <template v-if="form.type === 'remote'">
                    <dt class="text-dimmed">url</dt>
                    <dd class="font-mono break-all flex items-start gap-1">
                      <span class="flex-1">{{ form.url || '—' }}</span>
                      <UButton v-if="form.url" size="xs" variant="ghost" color="neutral" icon="i-lucide-copy" aria-label="Copy URL" class="-my-1" @click="copy(form.url)" />
                    </dd>
                    <dt class="text-dimmed">headers</dt>
                    <dd class="font-mono">
                      <span v-if="!form.headers.length" class="text-dimmed">none</span>
                      <span v-for="h in form.headers" :key="h.key" class="block">{{ h.key }}: {{ h.stored ? '•••• (stored)' : h.value }}</span>
                    </dd>
                    <dt class="text-dimmed">oauth</dt>
                    <dd>{{ form.oauth ? 'auto-detect' : 'off (token/header auth)' }}</dd>
                  </template>
                  <template v-else>
                    <dt class="text-dimmed">command</dt>
                    <dd class="font-mono break-all">{{ form.command || '—' }}</dd>
                    <dt class="text-dimmed">environment</dt>
                    <dd class="font-mono">
                      <span v-if="!form.env.length" class="text-dimmed">none</span>
                      <span v-for="e in form.env" :key="e.key" class="block">{{ e.key }}={{ e.stored ? '••••' : e.value }}</span>
                    </dd>
                  </template>
                  <dt class="text-dimmed">timeout</dt>
                  <dd>{{ form.timeout ? `${form.timeout} ms` : 'default' }}</dd>
                </dl>

                <div v-if="inspect?.server?.instructions" class="rounded-sm bg-muted p-2.5">
                  <div class="text-[10px] uppercase tracking-widest text-dimmed mb-1">Server instructions</div>
                  <p class="text-xs whitespace-pre-line">{{ inspect.server.instructions }}</p>
                </div>
              </template>
            </div>

            <!-- ================= tools ================= -->
            <div v-else-if="tab === 'tools'" key="tools" class="space-y-2">
              <div class="flex items-center gap-1.5">
                <UInput v-model="toolFilter" size="xs" icon="i-lucide-search" placeholder="Filter tools and descriptions…" class="flex-1" />
                <UButton size="xs" variant="soft" color="neutral" icon="i-lucide-refresh-cw" :loading="testing" aria-label="Reload tools" @click="runTest(false)" />
              </div>
              <div v-if="testing && !inspect" class="space-y-2 pt-1">
                <div v-for="i in 4" :key="i" class="space-y-1">
                  <USkeleton class="h-3.5 w-1/3" />
                  <USkeleton class="h-3 w-5/6" />
                </div>
              </div>
              <UAlert
                v-else-if="inspect && !inspect.ok"
                color="error"
                variant="subtle"
                icon="i-lucide-plug-zap"
                :title="inspect.hint?.title || 'Could not list tools'"
                :description="`${inspect.hint ? inspect.hint.fix + ' ' : ''}${inspect.error || ''}`"
              />
              <p v-else-if="inspect && !inspect.tools.length" class="text-xs text-dimmed py-4 text-center">This server exposes no tools.</p>
              <TransitionGroup v-else tag="div" name="oc-list" class="divide-y divide-default rounded-sm bg-elevated/60">
                <div v-for="tool in filteredTools" :key="tool.name" class="px-2.5 py-2">
                  <button class="flex items-start gap-2 w-full text-left" @click="toggleTool(tool.name)">
                    <UIcon
                      name="i-lucide-chevron-right"
                      class="size-3.5 mt-0.5 shrink-0 text-dimmed transition-transform duration-200"
                      :class="expanded.includes(tool.name) ? 'rotate-90' : ''"
                    />
                    <div class="min-w-0 flex-1">
                      <div class="flex flex-wrap items-center gap-1.5">
                        <span class="font-mono text-xs text-highlighted">{{ tool.name }}</span>
                        <span v-if="tool.title && tool.title !== tool.name" class="text-[11px] text-muted">{{ tool.title }}</span>
                        <UBadge v-if="tool.ui" size="sm" variant="subtle" color="primary" class="text-[9px] px-1 py-0">UI</UBadge>
                        <UBadge v-if="tool.readOnly" size="sm" variant="subtle" color="success" class="text-[9px] px-1 py-0">read-only</UBadge>
                        <UBadge v-if="tool.destructive" size="sm" variant="subtle" color="error" class="text-[9px] px-1 py-0">destructive</UBadge>
                        <span v-if="tool.params.length" class="text-[10px] text-dimmed">{{ tool.params.length }} param{{ tool.params.length === 1 ? '' : 's' }}</span>
                      </div>
                      <p
                        v-if="tool.fullDescription"
                        class="text-[11px] text-muted mt-0.5 whitespace-pre-line"
                        :class="expanded.includes(tool.name) ? '' : 'line-clamp-2'"
                      >{{ tool.fullDescription }}</p>
                    </div>
                  </button>
                  <CollapseTransition>
                    <div v-if="expanded.includes(tool.name)" class="pl-5.5 pt-1.5 space-y-1">
                      <div class="flex items-center gap-1 text-[10px] text-dimmed">
                        <span class="font-mono">{{ name }}_{{ tool.name }}</span>
                        <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-copy" aria-label="Copy tool id" class="-my-1" @click="copy(`${name}_${tool.name}`)" />
                      </div>
                      <p v-if="!tool.params.length" class="text-[11px] text-dimmed">No parameters.</p>
                      <div v-for="p in tool.params" :key="p.name" class="text-[11px] leading-snug">
                        <span class="font-mono text-default">{{ p.name }}</span><span v-if="!p.required" class="text-dimmed">?</span>
                        <span class="font-mono text-dimmed"> : {{ p.type || 'any' }}</span>
                        <span v-if="p.enum" class="font-mono text-dimmed"> ({{ p.enum.join(' | ') }})</span>
                        <span v-if="p.description" class="text-muted"> — {{ p.description }}</span>
                      </div>
                    </div>
                  </CollapseTransition>
                </div>
              </TransitionGroup>
              <div v-if="inspect?.ok && (inspect.resources.length || inspect.prompts.length)" class="text-[11px] text-dimmed pt-1">
                Also offers {{ inspect.resources.length }} resource(s) and {{ inspect.prompts.length }} prompt(s).
              </div>
            </div>

            <!-- ================= config ================= -->
            <div v-else-if="tab === 'config'" key="config" class="space-y-3">
              <div class="flex flex-wrap items-end gap-2">
                <UFormField v-if="creating" label="Name" size="sm" class="flex-1 min-w-40">
                  <UInput v-model="form.name" placeholder="home-assistant" class="w-full font-mono" />
                </UFormField>
                <UFormField label="Type" size="sm">
                  <div class="flex gap-1">
                    <UButton size="xs" :variant="form.type === 'remote' ? 'solid' : 'soft'" :color="form.type === 'remote' ? 'primary' : 'neutral'" icon="i-lucide-globe" label="Remote URL" :disabled="jsonMode" @click="form.type = 'remote'" />
                    <UButton size="xs" :variant="form.type === 'local' ? 'solid' : 'soft'" :color="form.type === 'local' ? 'primary' : 'neutral'" icon="i-lucide-terminal" label="Local command" :disabled="jsonMode" @click="form.type = 'local'" />
                  </div>
                </UFormField>
                <span class="flex-1" />
                <USwitch v-model="jsonMode" size="xs" label="JSON" />
              </div>

              <div v-if="jsonMode" class="space-y-1">
                <UTextarea v-model="jsonText" :rows="10" autoresize :maxrows="18" class="w-full font-mono text-xs" />
                <p class="text-[11px]" :class="jsonError ? 'text-error' : 'text-dimmed'">
                  {{ jsonError || 'opencode MCP entry. Values shown as "***" are stored secrets and stay unchanged.' }}
                </p>
              </div>

              <template v-else>
                <template v-if="form.type === 'remote'">
                  <UFormField label="URL" size="sm" description="Streamable HTTP endpoints usually end in /mcp, legacy SSE ones in /sse.">
                    <UInput v-model="form.url" placeholder="https://example.com/mcp" class="w-full font-mono" />
                  </UFormField>

                  <div class="space-y-1.5">
                    <div class="flex items-center gap-2">
                      <span class="text-xs font-medium">Headers</span>
                      <span class="flex-1" />
                      <UButton v-if="!bearer" size="xs" variant="soft" color="neutral" icon="i-lucide-key-round" label="Bearer token" @click="useToken" />
                      <UButton size="xs" variant="soft" color="neutral" icon="i-lucide-plus" label="Header" @click="addPair(form.headers)" />
                    </div>
                    <TransitionGroup tag="div" name="oc-list" class="space-y-1">
                      <div v-for="(h, i) in form.headers" :key="i" class="flex items-center gap-1" :data-header-value="h.key">
                        <UInput v-model="h.key" size="xs" placeholder="Authorization" class="w-36 font-mono" />
                        <UInput
                          v-model="h.value"
                          size="xs"
                          :type="h.reveal ? 'text' : 'password'"
                          :placeholder="h.stored ? '•••• stored — type to replace' : 'Bearer eyJ…'"
                          class="flex-1 font-mono"
                          autocomplete="off"
                        />
                        <UButton size="xs" variant="ghost" color="neutral" :icon="h.reveal ? 'i-lucide-eye-off' : 'i-lucide-eye'" :aria-label="h.reveal ? 'Hide value' : 'Show value'" @click="h.reveal = !h.reveal" />
                        <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-x" aria-label="Remove header" @click="form.headers.splice(i, 1)" />
                      </div>
                    </TransitionGroup>
                    <p v-if="!form.headers.length" class="text-[11px] text-dimmed">No headers. Token-protected servers need an Authorization header.</p>
                  </div>

                  <div class="flex items-start gap-2 rounded-sm bg-muted px-2.5 py-2">
                    <USwitch v-model="form.oauth" size="xs" class="mt-0.5" />
                    <div class="text-xs">
                      <div class="font-medium">OAuth auto-detection</div>
                      <p class="text-dimmed text-[11px]">
                        Lets opencode sign in through the server's OAuth flow. Turn it off when you authenticate with a token
                        header: servers like Home Assistant otherwise fail with "does not support dynamic client registration".
                      </p>
                    </div>
                  </div>
                </template>

                <template v-else>
                  <UFormField label="Command" size="sm" description="Runs on the opencode host, e.g. npx -y @modelcontextprotocol/server-memory">
                    <UInput v-model="form.command" placeholder="npx -y package-name" class="w-full font-mono" />
                  </UFormField>
                  <div class="space-y-1.5">
                    <div class="flex items-center gap-2">
                      <span class="text-xs font-medium">Environment</span>
                      <span class="flex-1" />
                      <UButton size="xs" variant="soft" color="neutral" icon="i-lucide-plus" label="Variable" @click="addPair(form.env)" />
                    </div>
                    <TransitionGroup tag="div" name="oc-list" class="space-y-1">
                      <div v-for="(e, i) in form.env" :key="i" class="flex items-center gap-1">
                        <UInput v-model="e.key" size="xs" placeholder="API_KEY" class="w-36 font-mono" />
                        <UInput
                          v-model="e.value"
                          size="xs"
                          :type="e.reveal ? 'text' : 'password'"
                          :placeholder="e.stored ? '•••• stored — type to replace' : 'value'"
                          class="flex-1 font-mono"
                          autocomplete="off"
                        />
                        <UButton size="xs" variant="ghost" color="neutral" :icon="e.reveal ? 'i-lucide-eye-off' : 'i-lucide-eye'" :aria-label="e.reveal ? 'Hide value' : 'Show value'" @click="e.reveal = !e.reveal" />
                        <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-x" aria-label="Remove variable" @click="form.env.splice(i, 1)" />
                      </div>
                    </TransitionGroup>
                  </div>
                </template>

                <div class="flex flex-wrap items-end gap-3">
                  <UFormField label="Timeout (ms)" size="sm" description="Blank = opencode default">
                    <UInput v-model="form.timeout" type="number" min="0" step="1000" placeholder="5000" class="w-32 font-mono" />
                  </UFormField>
                  <USwitch v-model="form.enabled" label="Enabled" size="sm" class="mb-1" />
                </div>
              </template>

              <USeparator />
              <div class="flex flex-wrap items-center gap-2">
                <span class="text-xs text-dimmed">Save to</span>
                <UButton size="xs" :variant="form.scope === 'project' ? 'solid' : 'soft'" :color="form.scope === 'project' ? 'primary' : 'neutral'" icon="i-lucide-folder-git-2" :label="dirName(directory)" @click="form.scope = 'project'" />
                <UButton size="xs" :variant="form.scope === 'global' ? 'solid' : 'soft'" :color="form.scope === 'global' ? 'primary' : 'neutral'" icon="i-lucide-globe" label="Global" @click="form.scope = 'global'" />
                <span v-if="!creating && info?.definedIn && info.definedIn !== form.scope" class="text-[11px] text-warning">
                  defined in the {{ info.definedIn }} config: saving here adds an override
                </span>
              </div>
            </div>

            <!-- ================= test ================= -->
            <div v-else key="test" class="space-y-3">
              <div class="flex items-center gap-2">
                <p class="text-xs text-muted flex-1">
                  Connects from the web app the way opencode would and lists what the server offers. Nothing is saved.
                </p>
                <UButton size="xs" color="primary" icon="i-lucide-play" :label="inspect ? 'Run again' : 'Run test'" :loading="testing" @click="runTest(true)" />
              </div>
              <div v-if="testing && !inspect" class="space-y-2">
                <USkeleton v-for="i in 3" :key="i" class="h-4" :class="['w-2/3', 'w-1/2', 'w-3/5'][i - 1]" />
              </div>
              <template v-if="inspect">
                <ol class="space-y-1">
                  <li v-for="(s, i) in inspect.steps" :key="i" class="flex items-start gap-2 text-xs oc-appear" :style="{ animationDelay: `${i * 60}ms` }">
                    <UIcon :name="s.ok ? 'i-lucide-circle-check' : 'i-lucide-circle-x'" class="size-4 shrink-0" :class="s.ok ? 'text-success' : 'text-error'" />
                    <div class="min-w-0 flex-1">
                      <span class="font-medium">{{ s.label }}</span>
                      <span v-if="s.ms !== undefined" class="text-dimmed font-mono"> · {{ s.ms }} ms</span>
                      <p v-if="s.detail" class="text-[11px] break-all" :class="s.ok ? 'text-dimmed' : 'text-error'">{{ s.detail }}</p>
                    </div>
                  </li>
                </ol>
                <UAlert
                  v-if="inspect.ok"
                  color="success"
                  variant="subtle"
                  icon="i-lucide-circle-check"
                  :title="`Works · ${inspect.tools.length} tools in ${inspect.durationMs} ms`"
                  :description="[inspect.server?.name, inspect.server?.version].filter(Boolean).join(' ') + (inspect.capabilities.length ? ` · offers ${inspect.capabilities.join(', ')}` : '')"
                >
                  <template #actions>
                    <UButton size="xs" color="success" variant="soft" icon="i-lucide-wrench" label="See tools" @click="tab = 'tools'" />
                  </template>
                </UAlert>
                <UAlert
                  v-else
                  color="error"
                  variant="subtle"
                  icon="i-lucide-circle-x"
                  :title="inspect.hint?.title || 'The test failed'"
                >
                  <template #description>
                    <p v-if="inspect.hint" class="mb-1">{{ inspect.hint.fix }}</p>
                    <p class="font-mono text-[11px] break-all opacity-80">{{ inspect.error }}</p>
                    <UButton v-if="inspect.hint?.action === 'use-token'" size="xs" color="error" class="mt-2" icon="i-lucide-key-round" label="Use a token instead" @click="useToken" />
                  </template>
                </UAlert>
                <p v-if="inspect.approx" class="text-[11px] text-warning">
                  Spawned on the web app host: opencode runs elsewhere, so its result may differ.
                </p>
                <details v-if="inspect.stderr" class="text-[11px]">
                  <summary class="cursor-pointer text-dimmed">Server stderr</summary>
                  <pre class="mt-1 p-2 rounded-sm bg-muted font-mono whitespace-pre-wrap break-all max-h-40 overflow-auto">{{ inspect.stderr }}</pre>
                </details>
              </template>
            </div>
          </Transition>
        </div>
      </div>
    </template>

    <template #footer>
      <div class="flex flex-wrap items-center justify-end gap-2 w-full">
        <UButton variant="ghost" color="neutral" label="Close" @click="open = false" />
        <UButton
          v-if="tab === 'config'"
          variant="soft"
          color="neutral"
          icon="i-lucide-flask-conical"
          label="Test"
          :loading="testing"
          @click="runTest(true)"
        />
        <UButton
          v-if="tab === 'config'"
          color="primary"
          icon="i-lucide-save"
          :label="creating ? 'Add & connect' : 'Save & reconnect'"
          :loading="saving"
          @click="save"
        />
        <UButton
          v-else
          color="primary"
          variant="soft"
          icon="i-lucide-pencil"
          label="Edit"
          @click="tab = 'config'"
        />
      </div>
    </template>
  </UModal>
</template>
