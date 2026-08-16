<script setup lang="ts">
import type {
  AgentInfo,
  MessageInfo,
  MessageWithParts,
  Part,
  PermissionRequest,
  ProvidersResponse,
  SessionInfo
} from '#shared/types/opencode'

const route = useRoute()
const directory = computed(() => decodeDir(route.params.dir as string))
const sessionId = computed(() => route.params.id as string)

const api = useOpencodeApi(directory)
const toast = useToast()

const session = ref<SessionInfo | null>(null)
const messages = ref<MessageWithParts[]>([])
const providers = ref<ProvidersResponse | null>(null)
const agents = ref<AgentInfo[]>([])
const mcpServers = ref<string[]>([])
const permissions = ref<PermissionRequest[]>([])
const busy = ref(false)
const loading = ref(true)

const scroller = ref<HTMLElement>()
const pinnedToBottom = ref(true)

const chime = useChime()
// ring when a reply finishes (busy -> idle), not on initial load
watch(busy, (now, before) => {
  if (before && !now && !loading.value) chime.play()
})

function onScroll() {
  const el = scroller.value
  if (!el) return
  pinnedToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 80
}

function scrollToBottom(force = false) {
  if (!force && !pinnedToBottom.value) return
  nextTick(() => {
    const el = scroller.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

const loadError = ref('')

async function loadAll() {
  loading.value = true
  loadError.value = ''
  permissions.value = []
  try {
    const [s, msgs] = await Promise.all([
      api.session(sessionId.value).catch(() => null),
      api.messages(sessionId.value)
    ])
    session.value = s
    messages.value = msgs
    const last = msgs[msgs.length - 1]
    busy.value = Boolean(
      last && last.info.role === 'assistant' && !last.info.time?.completed && !last.info.error
    )
  } catch (e) {
    const err = e as { statusCode?: number; data?: { message?: string } }
    loadError.value = err?.statusCode === 504 || err?.statusCode === 502
      ? 'The opencode server is not responding.'
      : String(err?.data?.message || e)
  } finally {
    loading.value = false
    scrollToBottom(true)
  }
}

watch(sessionId, loadAll, { immediate: true })

const metaLoading = ref(true)

async function loadMeta() {
  metaLoading.value = true
  try {
    const [prov, ag, mcp] = await Promise.all([
      api.providers().catch(() => null),
      api.agents().catch(() => [] as AgentInfo[]),
      api.mcpStatus().catch(() => ({}))
    ])
    providers.value = prov
    agents.value = ag
    mcpServers.value = Object.keys(mcp).sort()
  } finally {
    metaLoading.value = false
  }
}

onMounted(loadMeta)

function upsertMessage(info: MessageInfo) {
  if (info.sessionID !== sessionId.value) return
  const idx = messages.value.findIndex((m) => m.info.id === info.id)
  if (idx >= 0) {
    messages.value[idx] = { info, parts: messages.value[idx]!.parts }
  } else {
    messages.value.push({ info, parts: [] })
  }
  if (info.role === 'assistant' && !info.time?.completed && !info.error) busy.value = true
  scrollToBottom()
}

function upsertPart(part: Part) {
  if (part.sessionID !== sessionId.value) return
  let msg = messages.value.find((m) => m.info.id === part.messageID)
  if (!msg) {
    msg = {
      info: { id: part.messageID, sessionID: part.sessionID, role: 'assistant' },
      parts: []
    }
    messages.value.push(msg)
  }
  const idx = msg.parts.findIndex((p) => p.id === part.id)
  if (idx >= 0) msg.parts.splice(idx, 1, part)
  else msg.parts.push(part)
  scrollToBottom()
}

useOpencodeEvents(directory, (event) => {
  const props = (event.properties || {}) as Record<string, any>
  switch (event.type) {
    case 'message.updated':
      if (props.info) upsertMessage(props.info as MessageInfo)
      break
    case 'message.part.updated':
      if (props.part) upsertPart(props.part as Part)
      break
    case 'message.removed':
      if (props.sessionID === sessionId.value) {
        messages.value = messages.value.filter((m) => m.info.id !== props.messageID)
      }
      break
    case 'session.idle':
      if (props.sessionID === sessionId.value) busy.value = false
      break
    case 'session.error': {
      const sid = props.sessionID
      if (!sid || sid === sessionId.value) {
        busy.value = false
        const message = props.error?.data?.message || props.error?.name || 'Session error'
        toast.add({ title: message, color: 'error' })
      }
      break
    }
    case 'permission.updated':
    case 'permission.asked': {
      const perm = props as unknown as PermissionRequest
      if (perm.sessionID === sessionId.value && perm.id) {
        if (!permissions.value.some((p) => p.id === perm.id)) permissions.value.push(perm)
      }
      break
    }
    case 'permission.replied': {
      const id = props.permissionID || props.id
      permissions.value = permissions.value.filter((p) => p.id !== id)
      break
    }
  }
})

function send(payload: {
  text: string
  model?: { providerID: string; modelID: string }
  agent?: string
  variant?: string
  tools?: Record<string, boolean>
}) {
  busy.value = true
  pinnedToBottom.value = true
  api.prompt(sessionId.value, {
    parts: [{ type: 'text', text: payload.text }],
    model: payload.model,
    agent: payload.agent,
    variant: payload.variant,
    tools: payload.tools
  }).catch((e) => {
    busy.value = false
    toast.add({ title: 'Prompt failed', description: String(e?.data?.message || e), color: 'error' })
  })
  scrollToBottom(true)
}

async function abort() {
  try {
    await api.abort(sessionId.value)
    busy.value = false
  } catch {
    toast.add({ title: 'Abort failed', color: 'error' })
  }
}

// current activity while busy: last running tool, else reasoning/thinking
const activity = computed(() => {
  if (!busy.value) return ''
  const last = messages.value[messages.value.length - 1]
  if (!last || last.info.role !== 'assistant') return 'thinking…'
  for (let i = last.parts.length - 1; i >= 0; i--) {
    const part = last.parts[i] as Record<string, any>
    if (part.type === 'tool' && part.state?.status === 'running') {
      return `${part.tool}${part.state?.title ? ` · ${part.state.title}` : ''}`
    }
    if (part.type === 'reasoning' && !part.time?.end) return 'thinking…'
    if (part.type === 'text' && !part.time?.end) return 'writing…'
  }
  return 'working…'
})

async function respondPermission(perm: PermissionRequest, response: 'once' | 'always' | 'reject') {
  try {
    await api.respondPermission(perm.sessionID, perm.id, response)
    permissions.value = permissions.value.filter((p) => p.id !== perm.id)
  } catch (e) {
    toast.add({ title: 'Failed to respond', description: String(e), color: 'error' })
  }
}

useHead(() => ({ title: `${session.value?.title || 'Chat'} · opencode web` }))
</script>

<template>
  <div class="flex-1 flex flex-col min-h-0">
    <!-- session header -->
    <div class="hidden md:flex items-center gap-2 h-12 px-4 bg-muted/50 shrink-0">
      <span class="text-sm font-medium truncate">{{ session?.title || 'Untitled session' }}</span>
      <UBadge v-if="busy" color="warning" variant="subtle" size="sm" class="animate-pulse">working</UBadge>
      <span class="flex-1" />
      <UButton
        :icon="chime.enabled.value ? 'i-lucide-bell-ring' : 'i-lucide-bell-off'"
        color="neutral"
        variant="ghost"
        size="xs"
        :aria-label="chime.enabled.value ? 'Disable reply sound' : 'Enable reply sound'"
        @click="chime.toggle()"
      />
      <span class="text-xs text-dimmed font-mono truncate max-w-64">{{ directory }}</span>
    </div>

    <div
      ref="scroller"
      class="flex-1 overflow-y-auto min-h-0 py-2"
      @scroll.passive="onScroll"
    >
      <div class="max-w-3xl mx-auto">
        <div v-if="loading" class="px-3 sm:px-4 py-4 space-y-4">
          <div class="space-y-2">
            <USkeleton class="h-9 w-2/3" />
          </div>
          <div class="space-y-2">
            <USkeleton class="h-4 w-full" />
            <USkeleton class="h-4 w-5/6" />
            <USkeleton class="h-4 w-3/4" />
          </div>
          <div class="space-y-2">
            <USkeleton class="h-8 w-1/2" />
            <USkeleton class="h-4 w-4/6" />
          </div>
        </div>
        <div v-else-if="loadError" class="px-3 sm:px-4 py-10">
          <UAlert
            color="error"
            variant="subtle"
            icon="i-lucide-plug-zap"
            title="Cannot load this session"
            :description="loadError"
          >
            <template #actions>
              <UButton size="xs" color="error" variant="soft" icon="i-lucide-refresh-cw" label="Retry" @click="loadAll" />
            </template>
          </UAlert>
        </div>
        <template v-else>
          <div v-if="!messages.length" class="text-center py-16 text-sm text-dimmed">
            Send the first message to start working.
          </div>
          <ChatMessageItem
            v-for="message in messages"
            :key="message.info.id"
            :message="message"
          />
          <ChatPermissionPrompt
            v-for="perm in permissions"
            :key="perm.id"
            :permission="perm"
            @respond="(r) => respondPermission(perm, r)"
          />
          <ChatWorking v-if="busy" :activity="activity" />
        </template>
      </div>
    </div>

    <ChatPromptBox
      :providers="providers"
      :agents="agents"
      :mcp-servers="mcpServers"
      :meta-loading="metaLoading"
      :busy="busy"
      :directory="directory"
      @send="send"
      @abort="abort"
      @refresh-providers="loadMeta"
    />
  </div>
</template>
