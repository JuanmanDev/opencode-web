<script setup lang="ts">
// Scheduled prompts of this project: cron-timed prompts the web app sends to
// opencode (utils/scheduler.ts), with run history and links to the sessions.
import { cronError, describeCron, nextCronRun } from '#shared/utils/cron'

interface Run {
  id: string
  at: number
  trigger: 'schedule' | 'manual'
  status: 'running' | 'ok' | 'error' | 'skipped'
  sessionID?: string
  error?: string
  reply?: string
  durationMs?: number
}
interface Schedule {
  id: string
  name: string
  directory: string
  prompt: string
  cron: string
  session: 'new' | 'reuse'
  sessionID?: string
  model?: string
  agent?: string
  enabled: boolean
  nextRunAt?: number
  runs: Run[]
  description: string
  running: boolean
}

const route = useRoute()
const directory = computed(() => decodeDir(route.params.dir as string))
const dirParam = computed(() => route.params.dir as string)
const api = useOpencodeApi(directory)
const toast = useToast()

const schedules = ref<Schedule[]>([])
const loading = ref(true)
const serverZone = ref('')
const browserZone = import.meta.client ? Intl.DateTimeFormat().resolvedOptions().timeZone : ''

async function load() {
  try {
    schedules.value = await $fetch<Schedule[]>('/api/v1/schedules', { query: { directory: directory.value }, timeout: 15000 })
  } catch (e) {
    toast.add({ title: 'Could not load schedules', description: errorText(e), color: 'error' })
  } finally {
    loading.value = false
  }
}

let poll: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  load()
  $fetch<{ time?: { zone?: string } }>('/api/v1/status', { query: { directory: directory.value }, timeout: 20000 })
    .then((s) => { serverZone.value = s.time?.zone || '' })
    .catch(() => {})
  // follow running jobs and the clock ("in 4 min")
  poll = setInterval(() => {
    now.value = Date.now()
    if (schedules.value.some((s) => s.running || s.runs[0]?.status === 'running')) load()
  }, 5000)
})
onBeforeUnmount(() => clearInterval(poll))
watch(directory, load)

const now = ref(Date.now())

function errorText(e: unknown) {
  const data = (e as { data?: { message?: string } })?.data
  return data?.message || (e instanceof Error ? e.message : String(e))
}

function relative(ts?: number) {
  if (!ts) return '—'
  const diff = ts - now.value
  const abs = Math.abs(diff)
  const unit = abs < 3600_000 ? [Math.round(abs / 60_000), 'min'] : abs < 86400_000 ? [Math.round(abs / 3600_000), 'h'] : [Math.round(abs / 86400_000), 'd']
  const text = `${unit[0]} ${unit[1]}`
  return diff >= 0 ? `in ${text}` : `${text} ago`
}

function fmt(ts?: number) {
  return ts ? new Date(ts).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''
}

const statusColor = (s: Run['status']) =>
  s === 'ok' ? 'success' as const : s === 'error' ? 'error' as const : s === 'running' ? 'info' as const : 'neutral' as const

// ---- actions ----
const busy = ref<string | null>(null)

async function toggle(s: Schedule, enabled: boolean) {
  busy.value = s.id
  try {
    const updated = await $fetch<Schedule>(`/api/v1/schedules/${s.id}`, { method: 'PATCH', body: { enabled } })
    Object.assign(s, updated)
  } catch (e) {
    toast.add({ title: `Could not update ${s.name}`, description: errorText(e), color: 'error' })
  } finally {
    busy.value = null
  }
}

async function runNow(s: Schedule) {
  busy.value = s.id
  try {
    const run = await $fetch<Run>(`/api/v1/schedules/${s.id}/run`, { method: 'POST', timeout: 60_000 })
    toast.add({
      title: run.status === 'running' ? `${s.name}: sent` : `${s.name}: ${run.status}`,
      description: run.error || (run.sessionID ? 'The reply streams into its session.' : undefined),
      color: run.status === 'running' ? 'success' : run.status === 'skipped' ? 'warning' : 'error',
      ...(run.sessionID
        ? { actions: [{ label: 'Open', icon: 'i-lucide-message-square', onClick: () => { navigateTo(`/p/${dirParam.value}/session/${run.sessionID}`) } }] }
        : {})
    })
    await load()
  } catch (e) {
    toast.add({ title: `Could not run ${s.name}`, description: errorText(e), color: 'error' })
  } finally {
    busy.value = null
  }
}

const confirmDelete = ref<string | null>(null)
let confirmTimer: ReturnType<typeof setTimeout> | undefined
async function remove(s: Schedule) {
  clearTimeout(confirmTimer)
  if (confirmDelete.value !== s.id) {
    confirmDelete.value = s.id
    confirmTimer = setTimeout(() => { confirmDelete.value = null }, 3500)
    return
  }
  confirmDelete.value = null
  try {
    await $fetch(`/api/v1/schedules/${s.id}`, { method: 'DELETE' })
    schedules.value = schedules.value.filter((x) => x.id !== s.id)
  } catch (e) {
    toast.add({ title: `Could not delete ${s.name}`, description: errorText(e), color: 'error' })
  }
}

const openRuns = ref<string[]>([])
function toggleRuns(id: string) {
  openRuns.value = openRuns.value.includes(id) ? openRuns.value.filter((x) => x !== id) : [...openRuns.value, id]
}

// ---- editor ----
type Cadence = 'minutes' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'custom'
const editorOpen = ref(false)
const editingId = ref<string | null>(null)
const saving = ref(false)
const form = reactive({
  name: '',
  prompt: '',
  cadence: 'daily' as Cadence,
  every: 30,
  minute: 0,
  time: '09:00',
  days: [1] as number[],
  cron: '0 9 * * *',
  session: 'new' as 'new' | 'reuse',
  model: '',
  agent: '',
  enabled: true
})

const CADENCES = [
  { label: 'Every N minutes', value: 'minutes' },
  { label: 'Every hour', value: 'hourly' },
  { label: 'Every day', value: 'daily' },
  { label: 'Weekdays (Mon–Fri)', value: 'weekdays' },
  { label: 'Weekly', value: 'weekly' },
  { label: 'Custom cron', value: 'custom' }
]
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const cron = computed(() => {
  const [h, m] = form.time.split(':').map((x) => Number(x) || 0)
  switch (form.cadence) {
    case 'minutes': return `*/${Math.min(Math.max(Math.round(form.every) || 1, 1), 59)} * * * *`
    case 'hourly': return `${Math.min(Math.max(Math.round(form.minute) || 0, 0), 59)} * * * *`
    case 'daily': return `${m} ${h} * * *`
    case 'weekdays': return `${m} ${h} * * 1-5`
    case 'weekly': return `${m} ${h} * * ${(form.days.length ? [...form.days].sort() : [1]).join(',')}`
    default: return form.cron.trim()
  }
})
const cronProblem = computed(() => cronError(cron.value))
const preview = computed(() => {
  if (cronProblem.value) return []
  const out: number[] = []
  let at = Date.now()
  for (let i = 0; i < 3; i++) {
    const next = nextCronRun(cron.value, at)
    if (!next) break
    out.push(next.getTime())
    at = next.getTime()
  }
  return out
})

/** Read a cron back into the friendly controls when it has a known shape. */
function loadCadence(expr: string) {
  form.cron = expr
  const f = expr.trim().split(/\s+/)
  const [m, h, dom, mon, dow] = f
  const pad = (n: string) => n.padStart(2, '0')
  if (f.length === 5 && dom === '*' && mon === '*') {
    if (/^\*\/\d+$/.test(m!) && h === '*' && dow === '*') { form.cadence = 'minutes'; form.every = Number(m!.slice(2)); return }
    if (/^\d+$/.test(m!) && h === '*' && dow === '*') { form.cadence = 'hourly'; form.minute = Number(m); return }
    if (/^\d+$/.test(m!) && /^\d+$/.test(h!)) {
      form.time = `${pad(h!)}:${pad(m!)}`
      if (dow === '*') { form.cadence = 'daily'; return }
      if (dow === '1-5') { form.cadence = 'weekdays'; return }
      if (/^[0-6](,[0-6])*$/.test(dow!)) { form.cadence = 'weekly'; form.days = dow!.split(',').map(Number); return }
    }
  }
  form.cadence = 'custom'
}

function openEditor(s?: Schedule) {
  editingId.value = s?.id || null
  form.name = s?.name || ''
  form.prompt = s?.prompt || ''
  form.session = s?.session || 'new'
  form.model = s?.model || ''
  form.agent = s?.agent || ''
  form.enabled = s?.enabled ?? true
  form.every = 30
  form.minute = 0
  form.time = '09:00'
  form.days = [1]
  loadCadence(s?.cron || '0 9 * * 1-5')
  editorOpen.value = true
  loadChoices()
}

function toggleDay(d: number) {
  form.days = form.days.includes(d) ? form.days.filter((x) => x !== d) : [...form.days, d]
}

// models & agents for the selects
const modelItems = ref<Array<{ label: string; value: string }>>([{ label: 'Default model', value: '' }])
const agentItems = ref<Array<{ label: string; value: string }>>([{ label: 'Default agent', value: '' }])
let choicesLoaded = false
function loadChoices() {
  if (choicesLoaded) return
  choicesLoaded = true
  api.providers().then((p) => {
    modelItems.value = [{ label: 'Default model', value: '' }, ...(p.providers || []).flatMap((prov) =>
      Object.values(prov.models || {}).map((m) => ({ label: `${prov.name || prov.id} · ${m.name || m.id}`, value: `${prov.id}/${m.id}` })))]
  }).catch(() => { choicesLoaded = false })
  api.agents().then((list) => {
    agentItems.value = [{ label: 'Default agent', value: '' }, ...list
      .filter((a) => (a as { mode?: string }).mode !== 'subagent')
      .map((a) => ({ label: a.name, value: a.name }))]
  }).catch(() => {})
}

async function save() {
  if (cronProblem.value) return
  saving.value = true
  const body = {
    name: form.name.trim(),
    prompt: form.prompt,
    cron: cron.value,
    session: form.session,
    model: form.model,
    agent: form.agent,
    enabled: form.enabled,
    directory: directory.value
  }
  try {
    if (editingId.value) {
      await $fetch(`/api/v1/schedules/${editingId.value}`, { method: 'PATCH', body })
    } else {
      await $fetch('/api/v1/schedules', { method: 'POST', body })
    }
    editorOpen.value = false
    toast.add({ title: `Saved "${body.name}"`, description: describeCron(body.cron), color: 'success' })
    await load()
  } catch (e) {
    toast.add({ title: 'Could not save the schedule', description: errorText(e), color: 'error' })
  } finally {
    saving.value = false
  }
}

const EXAMPLES = [
  { name: 'Morning triage', cron: '0 8 * * 1-5', prompt: 'Look at the open TODOs and failing tests in this project and summarize what needs attention today.' },
  { name: 'Dependency check', cron: '0 9 * * 1', prompt: 'Check for outdated or vulnerable dependencies and list what should be updated, without changing anything.' },
  { name: 'Hourly health', cron: '0 * * * *', prompt: 'Run the test suite and report only if something fails.' }
]

function useExample(ex: typeof EXAMPLES[number]) {
  openEditor()
  form.name = ex.name
  form.prompt = ex.prompt
  loadCadence(ex.cron)
}

useHead(() => ({ title: `Schedules · ${dirName(directory.value)} · opencode web` }))
</script>

<template>
  <div class="flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
    <div class="max-w-2xl mx-auto px-4 py-6">
      <div class="flex flex-wrap items-center gap-2 mb-1">
        <h1 class="text-lg font-semibold">Scheduled prompts</h1>
        <span class="flex-1" />
        <UButton size="xs" color="primary" icon="i-lucide-plus" label="New schedule" class="oc-tap order-last sm:order-none w-full sm:w-auto justify-center" @click="openEditor()" />
      </div>
      <p class="text-sm text-muted mb-4">
        Prompts the web app sends to {{ dirName(directory) }} on a timetable.
        <span v-if="serverZone" class="text-dimmed">Times follow the server clock ({{ serverZone }}).</span>
      </p>

      <div v-if="loading" class="space-y-2">
        <div v-for="i in 2" :key="i" class="rounded-sm bg-muted p-3 space-y-2">
          <USkeleton class="h-4 w-1/3" />
          <USkeleton class="h-3 w-2/3" />
        </div>
      </div>

      <div v-else-if="!schedules.length" class="rounded-sm bg-muted p-5 text-center space-y-3 oc-appear">
        <UIcon name="i-lucide-alarm-clock" class="size-8 text-dimmed" />
        <p class="text-sm text-muted">No schedules yet. Start from an example or write your own.</p>
        <div class="flex flex-wrap justify-center gap-1.5">
          <UButton v-for="ex in EXAMPLES" :key="ex.name" size="xs" variant="soft" color="neutral" :label="ex.name" :title="describeCron(ex.cron)" @click="useExample(ex)" />
        </div>
        <p class="text-[11px] text-dimmed">The agent can manage these too, once Agent control is enabled on the MCP page.</p>
      </div>

      <TransitionGroup v-else tag="div" name="oc-list" class="relative space-y-2">
        <div v-for="s in schedules" :key="s.id" class="rounded-sm bg-muted">
          <div class="flex items-start gap-3 px-3 pt-2.5 pb-2">
            <USwitch
              :model-value="s.enabled"
              size="sm"
              class="mt-0.5"
              :loading="busy === s.id"
              :aria-label="s.enabled ? `Pause ${s.name}` : `Enable ${s.name}`"
              @update:model-value="(v: boolean) => toggle(s, v)"
            />
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span class="text-sm font-medium" :class="s.enabled ? '' : 'text-muted'">{{ s.name }}</span>
                <UBadge size="sm" variant="soft" color="neutral" class="font-mono">{{ s.description }}</UBadge>
                <UBadge v-if="s.session === 'reuse'" size="sm" variant="soft" color="neutral" icon="i-lucide-repeat">same session</UBadge>
              </div>
              <p class="text-xs text-dimmed line-clamp-2 mt-0.5">{{ s.prompt }}</p>
              <div class="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-[11px]">
                <span v-if="s.enabled && s.nextRunAt" class="inline-flex items-center gap-1 text-muted" :title="fmt(s.nextRunAt)">
                  <UIcon name="i-lucide-clock" class="size-3" /> next {{ relative(s.nextRunAt) }}
                </span>
                <span v-else class="text-dimmed">paused</span>
                <button v-if="s.runs.length" class="flex items-center gap-1 hover:text-highlighted text-muted" @click="toggleRuns(s.id)">
                  <UBadge :color="statusColor(s.runs[0]!.status)" variant="subtle" size="sm">
                    <UIcon v-if="s.runs[0]!.status === 'running'" name="i-lucide-loader-circle" class="size-3 animate-spin" />
                    {{ s.runs[0]!.status }}
                  </UBadge>
                  last {{ relative(s.runs[0]!.at) }} · {{ s.runs.length }} run{{ s.runs.length === 1 ? '' : 's' }}
                  <UIcon name="i-lucide-chevron-down" class="size-3 transition-transform duration-200" :class="openRuns.includes(s.id) ? 'rotate-180' : ''" />
                </button>
                <span v-if="s.model" class="font-mono text-dimmed">{{ s.model }}</span>
              </div>
            </div>
            <div class="flex items-center gap-0.5 shrink-0">
              <UTooltip text="Run now">
                <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-play" class="oc-tap" :loading="busy === s.id || s.running" aria-label="Run now" @click="runNow(s)" />
              </UTooltip>
              <UTooltip text="Edit">
                <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-pencil" class="oc-tap" aria-label="Edit schedule" @click="openEditor(s)" />
              </UTooltip>
              <Transition name="oc-swap" mode="out-in">
                <UButton v-if="confirmDelete === s.id" key="confirm" size="xs" color="error" icon="i-lucide-trash-2" label="Delete?" class="oc-tap" @click="remove(s)" />
                <UButton v-else key="delete" size="xs" variant="ghost" color="neutral" icon="i-lucide-trash-2" class="oc-tap" aria-label="Delete schedule" @click="remove(s)" />
              </Transition>
            </div>
          </div>
          <CollapseTransition>
            <div v-if="openRuns.includes(s.id)" class="px-3 pb-2.5 pl-14 space-y-1.5">
              <div v-for="run in s.runs" :key="run.id" class="text-[11px] flex items-start gap-2">
                <UBadge :color="statusColor(run.status)" variant="subtle" size="sm" class="shrink-0 w-16 justify-center">{{ run.status }}</UBadge>
                <div class="min-w-0 flex-1">
                  <div class="text-muted">
                    {{ fmt(run.at) }}
                    <span class="text-dimmed">· {{ run.trigger }}</span>
                    <span v-if="run.durationMs" class="text-dimmed"> · {{ Math.round(run.durationMs / 1000) }} s</span>
                    <NuxtLink v-if="run.sessionID" :to="`/p/${dirParam}/session/${run.sessionID}`" class="underline underline-offset-2 hover:text-highlighted ml-1">open chat</NuxtLink>
                  </div>
                  <p v-if="run.error" class="text-error break-all">{{ run.error }}</p>
                  <p v-else-if="run.reply" class="text-dimmed line-clamp-2">{{ run.reply }}</p>
                </div>
              </div>
            </div>
          </CollapseTransition>
        </div>
      </TransitionGroup>
    </div>

    <UModal
      v-model:open="editorOpen"
      :title="editingId ? 'Edit schedule' : 'New schedule'"
      description="The prompt is sent to this project at every matching time."
    >
      <template #body>
        <div class="space-y-3">
          <UFormField label="Name" size="sm">
            <UInput v-model="form.name" placeholder="Morning triage" class="w-full" />
          </UFormField>
          <UFormField label="Prompt" size="sm">
            <UTextarea v-model="form.prompt" :rows="4" autoresize :maxrows="12" placeholder="What should the agent do?" class="w-full" />
          </UFormField>

          <div class="space-y-2">
            <div class="flex flex-wrap items-end gap-2">
              <UFormField label="When" size="sm" class="w-full sm:w-auto">
                <USelect v-model="form.cadence" :items="CADENCES" value-key="value" class="w-full sm:w-48" />
              </UFormField>
              <UFormField v-if="form.cadence === 'minutes'" label="Every" size="sm">
                <UInput v-model.number="form.every" type="number" min="1" max="59" class="w-20" />
              </UFormField>
              <UFormField v-else-if="form.cadence === 'hourly'" label="At minute" size="sm">
                <UInput v-model.number="form.minute" type="number" min="0" max="59" class="w-20" />
              </UFormField>
              <UFormField v-else-if="form.cadence !== 'custom'" label="At" size="sm">
                <UInput v-model="form.time" type="time" class="w-28" />
              </UFormField>
              <UFormField v-else label="Cron (min hour day month weekday)" size="sm" class="flex-1 min-w-48">
                <UInput v-model="form.cron" placeholder="0 9 * * 1-5" class="w-full font-mono" />
              </UFormField>
            </div>
            <div v-if="form.cadence === 'weekly'" class="flex flex-wrap gap-1">
              <UButton
                v-for="(d, i) in DAYS"
                :key="d"
                size="xs"
                :variant="form.days.includes(i) ? 'solid' : 'soft'"
                :color="form.days.includes(i) ? 'primary' : 'neutral'"
                :label="d"
                @click="toggleDay(i)"
              />
            </div>
            <div class="rounded-sm bg-muted px-2.5 py-2 text-[11px]">
              <template v-if="cronProblem">
                <span class="text-error">{{ cronProblem }}</span>
              </template>
              <template v-else>
                <span class="font-mono text-muted">{{ cron }}</span>
                <span class="text-dimmed"> · {{ describeCron(cron) }}</span>
                <div class="text-dimmed mt-0.5">
                  Next: {{ preview.map(fmt).join(' · ') }}
                  <span v-if="serverZone && browserZone && serverZone !== browserZone" class="text-warning block">
                    Shown in your time zone ({{ browserZone }}); the server runs it in {{ serverZone }}.
                  </span>
                </div>
              </template>
            </div>
          </div>

          <div class="grid sm:grid-cols-2 gap-3">
            <UFormField label="Model" size="sm">
              <USelect v-model="form.model" :items="modelItems" value-key="value" class="w-full" />
            </UFormField>
            <UFormField label="Agent" size="sm">
              <USelect v-model="form.agent" :items="agentItems" value-key="value" class="w-full" />
            </UFormField>
          </div>

          <UFormField label="Session" size="sm">
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-1">
              <UButton size="xs" class="justify-center" :variant="form.session === 'new' ? 'solid' : 'soft'" :color="form.session === 'new' ? 'primary' : 'neutral'" icon="i-lucide-plus" label="New session each run" @click="form.session = 'new'" />
              <UButton size="xs" class="justify-center" :variant="form.session === 'reuse' ? 'solid' : 'soft'" :color="form.session === 'reuse' ? 'primary' : 'neutral'" icon="i-lucide-repeat" label="Always the same session" @click="form.session = 'reuse'" />
            </div>
          </UFormField>
          <USwitch v-model="form.enabled" label="Enabled" size="sm" />
        </div>
      </template>
      <template #footer>
        <div class="oc-actions">
          <UButton variant="ghost" color="neutral" label="Cancel" @click="editorOpen = false" />
          <UButton
            color="primary"
            icon="i-lucide-save"
            :label="editingId ? 'Save' : 'Create'"
            :loading="saving"
            :disabled="!form.name.trim() || !form.prompt.trim() || Boolean(cronProblem)"
            @click="save"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
