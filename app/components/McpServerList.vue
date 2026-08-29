<script setup lang="ts">
// Shared MCP server list: search over servers & tools, accordion rows with
// status, tri-state mode control and per-tool mode selects. Used by the MCP
// settings page (persisted) and the chat options (per-prompt).
//
// Layout is deliberately table-like: name grows, tool count / status / mode
// sit in fixed-width columns so rows line up as a grid.
export interface McpListServer {
  name: string
  status: string
  error?: string
  /** secondary line (url / command) */
  detail?: string
  /** tool names probed on this host while opencode runs elsewhere */
  approx?: boolean
  /** local tool discovery is switched off for this deployment */
  skipped?: boolean
  tools: Array<{ id: string; name: string; description?: string; ui?: boolean }>
}

const props = defineProps<{
  servers: McpListServer[]
  serverMode: (name: string) => 'off' | 'ask' | 'allow'
  toolMode: (id: string) => 'inherit' | 'deny' | 'ask' | 'allow'
  askDisabled?: boolean
  togglingName?: string | null
  /** discovery still running: render skeleton rows instead of an empty list */
  loading?: boolean
  /** link to the MCP settings page, offered on broken servers */
  settingsTo?: string
  /** show inline retry / sign-in buttons (settings page owns the actions) */
  repairable?: boolean
  /** height cap for the scrollable list */
  listClass?: string
}>()

const emit = defineEmits<{
  setServer: [name: string, mode: 'off' | 'ask' | 'allow']
  setTool: [id: string, mode: 'inherit' | 'deny' | 'ask' | 'allow']
  retry: [name: string]
  authenticate: [name: string]
}>()

const filter = ref('')
const open = ref<string[]>([])

// mobile: the filter is a single icon until tapped, so the header stays one row
const searchOpen = ref(false)
const searchInput = ref<{ $el?: HTMLElement } | null>(null)

async function openSearch() {
  searchOpen.value = true
  await nextTick()
  searchInput.value?.$el?.querySelector('input')?.focus()
}

function closeSearch() {
  filter.value = ''
  searchOpen.value = false
}

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

const OK = ['connected', 'running', 'ok', 'success']
const BROKEN = ['failed', 'error', 'needs_auth', 'needs_client_registration']

function statusColor(status: string) {
  if (OK.includes(status)) return 'success' as const
  if (BROKEN.includes(status)) return 'error' as const
  if (status === 'disabled') return 'neutral' as const
  return 'warning' as const
}

/** the fixed-width status column needs short labels */
function statusLabel(status: string) {
  if (status === 'needs_auth') return 'sign in'
  if (status === 'needs_client_registration') return 'register'
  return status
}

/** narrow screens get a dot instead of the badge, so names keep their width */
function statusDot(status: string) {
  if (OK.includes(status)) return 'bg-success'
  if (BROKEN.includes(status)) return 'bg-error'
  if (status === 'disabled') return 'bg-muted'
  return 'bg-warning'
}

const isBroken = (status: string) => BROKEN.includes(status)

/** Translate the raw opencode/transport error into something actionable. */
function errorHint(error?: string) {
  const e = (error || '').toLowerCase()
  if (/enoent|no such file or directory/.test(e)) {
    return 'opencode could not spawn it — most often the project directory does not exist '
      + 'on the opencode host, or the command is not installed there'
  }
  if (/401|unauthorized/.test(e)) return 'authentication rejected — fix the token/header, or sign in'
  if (/404|405/.test(e)) return 'the URL answered but speaks no MCP — check the path (…/mcp or …/sse)'
  if (/connection closed|exited/.test(e)) return 'the process died at startup — check the command and package name'
  if (/timed out|timeout/.test(e)) return 'no answer in time — the server is slow, down, or unreachable from the host'
  return ''
}

function toolsHint(server: McpListServer) {
  if (server.skipped) return 'local server: tool listing is disabled for this deployment'
  if (!server.tools.length) return 'no tools discovered'
  if (server.approx) {
    return `${server.tools.length} tools — probed on the web app host, `
      + 'opencode runs elsewhere so its list may differ'
  }
  return `${server.tools.length} tools`
}
</script>

<template>
  <div class="space-y-1.5">
    <!-- one header row: filter (icon-only on mobile) + the page's own actions -->
    <div class="flex items-center gap-1">
      <UTooltip text="Filter servers and tools">
        <UButton
          :class="searchOpen ? 'hidden' : 'sm:hidden'"
          icon="i-lucide-search"
          size="xs"
          color="neutral"
          variant="soft"
          aria-label="Filter servers and tools"
          @click="openSearch"
        />
      </UTooltip>
      <UInput
        ref="searchInput"
        v-model="filter"
        size="xs"
        icon="i-lucide-search"
        placeholder="Filter servers & tools…"
        :class="searchOpen ? 'flex-1' : 'hidden sm:flex sm:w-44'"
        :ui="{ trailing: 'pe-1' }"
      >
        <template v-if="filter || searchOpen" #trailing>
          <UButton
            icon="i-lucide-x"
            size="xs"
            color="neutral"
            variant="ghost"
            aria-label="Clear filter"
            @click="closeSearch"
          />
        </template>
      </UInput>
      <div
        class="flex flex-wrap items-center gap-1 min-w-0"
        :class="searchOpen ? 'hidden sm:flex' : 'flex'"
      >
        <slot name="actions" />
      </div>
    </div>

    <div
      class="rounded-sm bg-elevated/60 divide-y divide-default overflow-y-auto overscroll-contain"
      :class="listClass || 'max-h-[50dvh] sm:max-h-[60vh]'"
    >
      <!-- discovery in flight: keep the height stable instead of popping in -->
      <template v-if="loading && !servers.length">
        <div v-for="i in 4" :key="`skeleton-${i}`" class="flex items-center gap-2 px-2.5 py-1.5">
          <USkeleton class="size-3.5 rounded-full shrink-0" />
          <USkeleton class="h-3 flex-1 max-w-40" />
          <USkeleton class="h-3 w-8 shrink-0" />
          <USkeleton class="h-4 w-16 rounded-sm shrink-0" />
          <USkeleton class="h-5 w-[7.5rem] rounded-sm shrink-0" />
        </div>
      </template>

      <div v-else-if="!filtered.length" class="px-3 py-4 text-xs text-dimmed text-center">
        {{ filter ? `Nothing matches “${filter}”` : 'No MCP servers configured.' }}
      </div>

      <div v-for="server in filtered" :key="server.name">
        <!-- header row -->
        <div class="flex items-center gap-2 px-2.5 py-1.5">
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
              <span class="text-sm font-mono truncate block leading-tight">{{ server.name }}</span>
              <span v-if="server.detail" class="text-[10px] text-dimmed font-mono truncate block leading-tight">
                {{ server.detail }}
              </span>
            </div>
          </component>

          <!-- tools column -->
          <UTooltip :text="toolsHint(server)">
            <span
              class="w-10 shrink-0 text-right text-[11px] font-mono tabular-nums"
              :class="server.tools.length ? 'text-muted' : 'text-dimmed'"
            >
              <span v-if="server.approx && server.tools.length" class="text-dimmed">≈</span>{{ server.tools.length || '—' }}
            </span>
          </UTooltip>

          <!-- status column: dot on phones, labelled badge from sm up -->
          <UTooltip :text="server.error || server.status">
            <span class="sm:hidden size-2 rounded-full shrink-0" :class="statusDot(server.status)" />
          </UTooltip>
          <UTooltip :text="server.error || server.status">
            <UBadge
              :color="statusColor(server.status)"
              variant="subtle"
              size="sm"
              class="hidden sm:flex w-[4.5rem] shrink-0 justify-center truncate"
            >
              {{ statusLabel(server.status) }}
            </UBadge>
          </UTooltip>

          <McpModeControl
            :model-value="serverMode(server.name)"
            :ask-disabled="askDisabled"
            :loading="togglingName === server.name"
            @update:model-value="(m) => emit('setServer', server.name, m)"
          />
        </div>

        <!-- broken server: the error plus a way to act on it -->
        <div v-if="isBroken(server.status) || server.error" class="flex flex-wrap items-center gap-1.5 px-8 pb-1.5">
          <div v-if="server.error" class="flex-1 min-w-40 space-y-0.5">
            <p class="text-[11px] text-error break-all leading-tight">{{ server.error }}</p>
            <p v-if="errorHint(server.error)" class="text-[10px] text-dimmed leading-tight">
              {{ errorHint(server.error) }}
            </p>
          </div>
          <template v-if="repairable">
            <UButton
              size="xs"
              variant="soft"
              color="neutral"
              icon="i-lucide-refresh-cw"
              label="Retry"
              :loading="togglingName === server.name"
              @click="emit('retry', server.name)"
            />
            <UButton
              v-if="server.status === 'needs_auth' || server.status === 'needs_client_registration'"
              size="xs"
              variant="soft"
              color="primary"
              icon="i-lucide-key-round"
              label="Sign in"
              @click="emit('authenticate', server.name)"
            />
          </template>
          <UButton
            v-else-if="settingsTo"
            size="xs"
            variant="soft"
            color="neutral"
            icon="i-lucide-server-cog"
            label="Fix in MCP settings"
            :to="settingsTo"
          />
        </div>

        <!-- tools -->
        <CollapseTransition>
          <div
            v-if="server.tools.length && open.includes(server.name)"
            class="px-8 pb-2 space-y-0.5"
          >
            <McpToolRow
              v-for="tool in server.tools"
              :key="tool.id"
              :name="tool.name"
              :description="tool.description"
              :ui="tool.ui"
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
