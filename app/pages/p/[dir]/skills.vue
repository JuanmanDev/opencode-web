<script setup lang="ts">
// Skills: every skill opencode can load in this project, where it comes from,
// whether the agent may use it (permission.skill), what it says and how good
// it is. Skills of this app's library are edited here (and written or
// improved by a model); others can be copied into the library to change them.
const route = useRoute()
const caps = useCapabilities()
const directory = computed(() => decodeDir(route.params.dir as string))
const toast = useToast()

type Source = 'built-in' | 'library' | 'project' | 'global' | 'remote'
type Mode = 'allow' | 'ask' | 'deny'
interface Check { level: 'error' | 'warning' | 'tip'; message: string }
interface Skill {
  name: string
  description?: string
  location?: string
  source: Source
  content?: string
  permission: Mode
  permissionRule?: string
  library?: { version: number; updatedAt: number; loaded: boolean; origin?: string }
  checks: Check[]
}
interface Catalog { rev: number; count: number; url: string | null; registered: string | null; upToDate: boolean; supported: boolean }

const skills = ref<Skill[]>([])
const catalog = ref<Catalog | null>(null)
const available = ref(true)
const loading = ref(true)
const loadError = ref('')

function errorMessage(e: unknown) {
  const data = (e as { data?: { message?: string } })?.data
  return data?.message || (e instanceof Error ? e.message : String(e))
}

async function refresh() {
  loading.value = true
  loadError.value = ''
  try {
    const res = await $fetch<{ skills: Skill[]; available: boolean; catalog: Catalog }>('/api/v1/skills', {
      query: { directory: directory.value },
      timeout: 60_000
    })
    skills.value = res.skills
    available.value = res.available
    catalog.value = res.catalog
  } catch (e) {
    loadError.value = errorMessage(e)
  } finally {
    loading.value = false
  }
}
onMounted(refresh)

// ---- reload: skills, permissions and the catalog are read when opencode loads ----
const { reload, reloading, menuItems, markPending, pendingFor } = useReload()
const reloadMenu = computed(() => menuItems(directory.value))
const needsReload = computed(() => pendingFor(directory.value).includes('skills'))
watch(reloading, (now, before) => { if (before && !now) refresh() })
function changed(title: string, description: string) {
  markPending(directory.value, 'skills')
  toast.add({
    title,
    description: `${description} opencode picks it up after a reload.`,
    color: 'success',
    actions: [{ label: 'Reload now', icon: 'i-lucide-rotate-ccw', onClick: () => { reload({ scope: 'all', resumeBusy: false }) } }]
  })
}

// ---- filters ----
const filter = ref('')
const sourceFilter = ref<Source | 'all'>('all')
const SOURCES: Array<{ value: Source; label: string; icon: string; tip: string }> = [
  { value: 'library', label: 'Library', icon: 'i-lucide-library', tip: 'Kept by this web app and served to opencode; editable here' },
  { value: 'project', label: 'Project', icon: 'i-lucide-folder-git-2', tip: '.opencode/skills, .claude/skills or .agents/skills in the project' },
  { value: 'global', label: 'Global', icon: 'i-lucide-globe', tip: '~/.config/opencode/skills (and ~/.claude, ~/.agents) on the opencode host' },
  { value: 'remote', label: 'Remote', icon: 'i-lucide-cloud-download', tip: 'Downloaded from a skill URL in the config' },
  { value: 'built-in', label: 'Built-in', icon: 'i-lucide-package', tip: 'Ships with opencode' }
]
const sourceOf = (s: Source) => SOURCES.find((x) => x.value === s)!
const counts = computed(() => Object.fromEntries(SOURCES.map((s) => [s.value, skills.value.filter((k) => k.source === s.value).length])))
const filtered = computed(() => {
  const q = filter.value.trim().toLowerCase()
  return skills.value.filter((s) =>
    (sourceFilter.value === 'all' || s.source === sourceFilter.value) &&
    (!q || `${s.name} ${s.description || ''}`.toLowerCase().includes(q)))
})

const problems = (s: Skill) => s.checks.filter((c) => c.level !== 'tip')
const errors = (s: Skill) => s.checks.filter((c) => c.level === 'error')

// ---- permissions (allow / ask / deny per skill, project or global config) ----
const scope = ref<'project' | 'global'>('project')
const settingPermission = ref('')
async function setPermission(skill: Skill, mode: Mode) {
  settingPermission.value = skill.name
  try {
    const result = await $fetch<{ scope: string; fallback?: boolean }>('/api/v1/config-patch', {
      method: 'POST',
      body: { scope: scope.value, directory: directory.value, patch: { permission: { skill: { [skill.name]: mode } } } },
      timeout: 60_000
    })
    skill.permission = mode
    skill.permissionRule = skill.name
    changed(`${skill.name}: ${mode}`, `Saved in the ${result.scope} config.`)
  } catch (e) {
    toast.add({ title: `Could not change ${skill.name}`, description: errorMessage(e), color: 'error' })
  } finally {
    settingPermission.value = ''
  }
}
const MODES: Array<{ value: Mode; label: string; tip: string }> = [
  { value: 'deny', label: 'off', tip: 'Hidden from the agent' },
  { value: 'ask', label: 'ask', tip: 'The chat asks before the skill is loaded' },
  { value: 'allow', label: 'auto', tip: 'Loaded whenever the agent needs it' }
]

// ---- catalog (the library as a skill URL in the opencode config) ----
const registering = ref(false)
async function registerCatalog() {
  registering.value = true
  try {
    catalog.value = await $fetch<Catalog>('/api/v1/skills/catalog', { method: 'POST', body: { enabled: true }, timeout: 60_000 })
    changed('Skill library registered', 'Its URL is in the global config.')
  } catch (e) {
    toast.add({ title: 'Could not register the skill library', description: errorMessage(e), color: 'error' })
  } finally {
    registering.value = false
  }
}

// ---- editor ----
const AI_MODEL_KEY = 'opencode-web.ai-model'
const models = useModelCatalog(directory)
const aiModel = ref('')
onMounted(() => { try { aiModel.value = localStorage.getItem(AI_MODEL_KEY) || '' } catch { /* private mode */ } })
watch(aiModel, (v) => { try { localStorage.setItem(AI_MODEL_KEY, v) } catch { /* private mode */ } })

const editor = reactive({
  open: false,
  tab: 'preview' as 'preview' | 'edit' | 'checks' | 'ai',
  skill: null as Skill | null,
  name: '',
  content: '',
  original: '',
  isNew: false,
  saving: false,
  brief: '',
  generating: false,
  proposal: '',
  proposalChecks: [] as Check[]
})
const editable = computed(() => editor.isNew || editor.skill?.source === 'library')
const dirty = computed(() => editor.content !== editor.original)

function openSkill(skill: Skill, tab: typeof editor.tab = 'preview') {
  editor.skill = skill
  editor.name = skill.name
  editor.content = skill.content || ''
  editor.original = editor.content
  editor.isNew = false
  editor.tab = tab
  editor.brief = ''
  editor.proposal = ''
  editor.open = true
  if (!models.items.value.length) models.load()
}

const TEMPLATE = (name: string) => `---
name: ${name}
description: Use when the user asks to … (say what it does AND when to use it; front-load keywords)
---

# ${name}

## When to use

## Steps

1. …

## Examples
`

const newOpen = ref(false)
const newName = ref('')
const newBrief = ref('')
function startNew() {
  newName.value = ''
  newBrief.value = ''
  newOpen.value = true
  if (!models.items.value.length) models.load()
}
const nameValid = computed(() => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(newName.value) && newName.value.length <= 64)

async function createSkill(withAi: boolean) {
  const name = newName.value.trim()
  let content = TEMPLATE(name)
  if (withAi) {
    editor.generating = true
    try {
      content = (await $fetch<{ content: string }>('/api/v1/skills/ai', {
        method: 'POST',
        body: { mode: 'create', name, brief: newBrief.value, model: aiModel.value || undefined, directory: directory.value },
        timeout: 5 * 60_000
      })).content
    } catch (e) {
      toast.add({ title: 'The model could not write it', description: errorMessage(e), color: 'error' })
      return
    } finally {
      editor.generating = false
    }
  }
  newOpen.value = false
  editor.skill = null
  editor.isNew = true
  editor.name = name
  editor.content = content
  editor.original = ''
  editor.tab = 'edit'
  editor.proposal = ''
  editor.brief = ''
  editor.open = true
}

/** Built-in, global, project and remote skills are edited as a library copy (it takes precedence). */
function copyToLibrary() {
  if (!editor.skill) return
  editor.isNew = true
  editor.original = ''
  editor.tab = 'edit'
  toast.add({
    title: 'Editing a library copy',
    description: `Saving stores ${editor.name} in the skill library, which opencode prefers over the ${editor.skill.source} one.`,
    color: 'info'
  })
}

async function save() {
  editor.saving = true
  try {
    const res = await $fetch<{ skill: { name: string; version: number }; catalog: Catalog | { error: string } }>('/api/v1/skills/library', {
      method: 'PUT',
      body: {
        name: editor.name,
        content: editor.content,
        origin: editor.skill && editor.skill.source !== 'library' ? editor.skill.source : undefined
      },
      timeout: 60_000
    })
    editor.original = editor.content
    editor.isNew = false
    if ('error' in res.catalog) {
      toast.add({ title: `${res.skill.name} saved, but opencode can't load the library yet`, description: res.catalog.error, color: 'warning' })
    } else {
      catalog.value = res.catalog
      changed(`${res.skill.name} saved (v${res.skill.version})`, 'Stored in the skill library.')
    }
    await refresh()
    editor.skill = skills.value.find((s) => s.name === res.skill.name) || editor.skill
  } catch (e) {
    toast.add({ title: 'Could not save the skill', description: errorMessage(e), color: 'error' })
  } finally {
    editor.saving = false
  }
}

const confirmDelete = ref(false)
async function removeSkill() {
  if (!editor.skill) return
  if (!confirmDelete.value) {
    confirmDelete.value = true
    setTimeout(() => { confirmDelete.value = false }, 3500)
    return
  }
  confirmDelete.value = false
  try {
    await $fetch('/api/v1/skills/library', { method: 'DELETE', query: { name: editor.skill.name }, timeout: 60_000 })
    changed(`${editor.skill.name} deleted`, 'Removed from the skill library.')
    editor.open = false
    await refresh()
  } catch (e) {
    toast.add({ title: 'Could not delete the skill', description: errorMessage(e), color: 'error' })
  }
}

async function improve() {
  editor.generating = true
  editor.proposal = ''
  try {
    const res = await $fetch<{ content: string; checks: Check[] }>('/api/v1/skills/ai', {
      method: 'POST',
      body: { mode: 'improve', name: editor.name, content: editor.content, brief: editor.brief || undefined, model: aiModel.value || undefined, directory: directory.value },
      timeout: 5 * 60_000
    })
    editor.proposal = res.content
    editor.proposalChecks = res.checks
  } catch (e) {
    toast.add({ title: 'The model could not improve it', description: errorMessage(e), color: 'error' })
  } finally {
    editor.generating = false
  }
}

function acceptProposal() {
  if (!editable.value) copyToLibrary()
  editor.content = editor.proposal
  editor.proposal = ''
  editor.tab = 'edit'
}

// live checks while editing
const liveChecks = ref<Check[]>([])
let checkTimer: ReturnType<typeof setTimeout> | undefined
watch(() => [editor.content, editor.open] as const, ([content, open]) => {
  clearTimeout(checkTimer)
  if (!open) return
  checkTimer = setTimeout(() => {
    $fetch<{ checks: Check[] }>('/api/v1/skills/check', { method: 'POST', body: { content, name: editor.name }, timeout: 10_000 })
      .then((r) => { liveChecks.value = r.checks })
      .catch(() => { liveChecks.value = editor.skill?.checks || [] })
  }, 300)
})
onBeforeUnmount(() => clearTimeout(checkTimer))

// preview: frontmatter fields + rendered body
const preview = computed(() => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(editor.content || '')
  const fields: Array<[string, string]> = []
  for (const line of (m?.[1] || '').split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (kv) fields.push([kv[1]!, kv[2]!.replace(/^(['"])([\s\S]*)\1$/, '$2')])
  }
  const body = m ? m[2]! : editor.content
  const words = body.split(/\s+/).filter(Boolean).length
  return { fields, body, words, tokens: Math.round((editor.content || '').length / 4) }
})

const checkIcon = (level: Check['level']) => level === 'error' ? 'i-lucide-circle-x' : level === 'warning' ? 'i-lucide-triangle-alert' : 'i-lucide-lightbulb'
const checkColor = (level: Check['level']) => level === 'error' ? 'text-error' : level === 'warning' ? 'text-warning' : 'text-muted'

const helpText = [
  'A **skill** is a set of instructions (a `SKILL.md`) the agent loads only when it needs it. Its **description** is always in the agent\'s context and decides *when* the skill is used; the body is read on demand, so skills add knowledge without filling every prompt.',
  '',
  '- **Where they come from**: built into opencode, `~/.config/opencode/skills` (global), `.opencode/skills` / `.claude/skills` / `.agents/skills` in the project, skill URLs, and this app\'s **library**.',
  '- **Library**: skills kept by this web app and served to opencode as a skill URL. A library skill overrides a same-name skill from elsewhere, so *Edit a copy* lets you change any skill.',
  '- **auto / ask / off**: `permission.skill` in the opencode config: load freely, ask in the chat first, or hide it.',
  '- Which agents may load skills at all is set per agent on the Agents page (tool `skill`).',
  '- Changes apply after opencode reloads its config.'
].join('\n')

useHead(() => ({ title: `Skills · ${dirName(directory.value)} · opencode web` }))
</script>

<template>
  <div class="flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
    <div class="max-w-3xl mx-auto px-4 py-6">
      <div class="flex flex-wrap items-center gap-2 mb-1">
        <h1 class="text-lg font-semibold flex items-center gap-1.5">Skills <HelpTip title="How skills work" :text="helpText" :actions="[{ label: 'Agents', icon: 'i-lucide-bot', to: `/p/${route.params.dir}/agents` }]" /></h1>
        <span class="flex-1" />
        <UTooltip text="Rescan">
          <UButton size="xs" variant="soft" icon="i-lucide-refresh-cw" class="oc-tap" :loading="loading" aria-label="Rescan skills" @click="refresh" />
        </UTooltip>
        <div class="basis-full sm:basis-auto grid gap-1.5 sm:flex" :class="caps.config ? 'grid-cols-2' : 'grid-cols-1'">
          <UDropdownMenu v-if="caps.config" :items="reloadMenu" :content="{ align: 'end' }">
            <UButton size="xs" variant="soft" color="neutral" icon="i-lucide-rotate-ccw" label="Reload opencode" class="oc-tap w-full sm:w-auto justify-center" :loading="reloading" />
          </UDropdownMenu>
          <UButton size="xs" color="primary" icon="i-lucide-plus" label="New skill" class="oc-tap w-full sm:w-auto justify-center" @click="startNew" />
        </div>
      </div>
      <p class="text-sm text-muted mb-4">Instructions the agent loads on demand. See what each one says, check its quality, choose which ones the agent may use, and write or improve skills with AI.</p>

      <CollapseTransition>
        <UAlert
          v-if="needsReload"
          class="mb-3"
          color="warning"
          variant="subtle"
          icon="i-lucide-rotate-ccw"
          title="Skill changes are saved"
          description="opencode loads skills, their permissions and the library when it reads its config."
        >
          <template #actions>
            <UButton size="xs" color="warning" icon="i-lucide-rotate-ccw" label="Reload all projects" :loading="reloading" @click="reload({ scope: 'all' })" />
          </template>
        </UAlert>
      </CollapseTransition>

      <!-- the library and its catalog URL -->
      <div class="rounded-sm bg-muted px-3 py-2.5 mb-3 flex flex-wrap items-center gap-2">
        <UIcon name="i-lucide-library" class="size-4 shrink-0" :class="catalog?.registered ? 'text-success' : 'text-muted'" />
        <div class="min-w-0 flex-1">
          <div class="text-sm font-medium">Skill library <span class="text-dimmed font-normal">· {{ catalog?.count ?? 0 }} skill{{ catalog?.count === 1 ? '' : 's' }}</span></div>
          <p class="text-[11px] text-dimmed truncate">
            <template v-if="!catalog">Loading…</template>
            <template v-else-if="!catalog.supported">This opencode server's config can't be read: the library can't be registered.</template>
            <template v-else-if="catalog.registered && catalog.upToDate">Served to opencode at <span class="font-mono">{{ catalog.registered }}</span></template>
            <template v-else-if="catalog.registered">Registered at an older revision: saving a skill or registering again updates it.</template>
            <template v-else>Not registered yet: saving the first skill does it, or register now.</template>
          </p>
        </div>
        <UButton
          v-if="catalog && catalog.count && !catalog.upToDate && catalog.supported"
          size="xs"
          variant="soft"
          icon="i-lucide-link"
          label="Register"
          class="oc-tap"
          :loading="registering"
          @click="registerCatalog"
        />
      </div>

      <!-- permissions scope -->
      <div class="flex items-center gap-2 mb-2">
        <span class="text-[11px] text-dimmed">Permissions saved to</span>
        <div class="grid grid-cols-2 gap-0.5 p-0.5 rounded-sm bg-muted flex-1 max-w-80" role="tablist" aria-label="Permission scope">
          <UButton size="xs" :variant="scope === 'project' ? 'solid' : 'ghost'" :color="scope === 'project' ? 'primary' : 'neutral'" icon="i-lucide-folder-git-2" :label="dirName(directory)" class="justify-center" role="tab" :aria-selected="scope === 'project'" @click="scope = 'project'" />
          <UButton size="xs" :variant="scope === 'global' ? 'solid' : 'ghost'" :color="scope === 'global' ? 'primary' : 'neutral'" icon="i-lucide-globe" label="Global" class="justify-center" role="tab" :aria-selected="scope === 'global'" @click="scope = 'global'" />
        </div>
      </div>

      <!-- filters -->
      <div class="flex flex-wrap items-center gap-1 mb-2">
        <UInput v-model="filter" size="xs" icon="i-lucide-search" placeholder="Filter skills…" class="w-44" />
        <UButton size="xs" :variant="sourceFilter === 'all' ? 'soft' : 'ghost'" color="neutral" :label="`All ${skills.length}`" @click="sourceFilter = 'all'" />
        <UTooltip v-for="s in SOURCES" :key="s.value" :text="s.tip">
          <UButton
            v-if="counts[s.value]"
            size="xs"
            :variant="sourceFilter === s.value ? 'soft' : 'ghost'"
            color="neutral"
            :icon="s.icon"
            :label="`${s.label} ${counts[s.value]}`"
            @click="sourceFilter = sourceFilter === s.value ? 'all' : s.value"
          />
        </UTooltip>
      </div>

      <UAlert v-if="loadError" color="error" variant="subtle" icon="i-lucide-plug-zap" title="Cannot load skills" :description="loadError" class="mb-3">
        <template #actions>
          <UButton size="xs" color="error" variant="soft" icon="i-lucide-refresh-cw" label="Retry" @click="refresh" />
        </template>
      </UAlert>
      <UAlert
        v-else-if="!available && !loading"
        color="warning"
        variant="subtle"
        icon="i-lucide-info"
        title="This opencode server lists no skills"
        description="Its API has no /skill route (older version). Library skills are still kept here and served once opencode supports skill URLs."
        class="mb-3"
      />

      <div class="rounded-sm bg-elevated/60 divide-y divide-default">
        <template v-if="loading && !skills.length">
          <div v-for="i in 4" :key="i" class="flex items-center gap-2 px-3 py-2.5">
            <USkeleton class="size-4 rounded-full" />
            <div class="flex-1 space-y-1.5">
              <USkeleton class="h-3.5 w-1/3" />
              <USkeleton class="h-3 w-3/4" />
            </div>
            <USkeleton class="h-5 w-28" />
          </div>
        </template>
        <div v-else-if="!filtered.length" class="px-3 py-8 text-sm text-dimmed text-center">
          {{ skills.length ? 'No skill matches.' : 'No skills yet: create one, or add SKILL.md files to the project.' }}
        </div>
        <TransitionGroup name="oc-list">
          <div v-for="s in filtered" :key="s.name" class="flex items-start gap-2.5 px-3 py-2.5">
            <UTooltip :text="sourceOf(s.source).tip">
              <UIcon :name="sourceOf(s.source).icon" class="size-4 mt-0.5 shrink-0 text-dimmed" />
            </UTooltip>
            <button type="button" class="min-w-0 flex-1 text-left cursor-pointer group" @click="openSkill(s)">
              <div class="flex flex-wrap items-center gap-1.5">
                <span class="text-sm font-mono group-hover:underline underline-offset-2">{{ s.name }}</span>
                <UBadge size="sm" variant="subtle" color="neutral">{{ sourceOf(s.source).label }}</UBadge>
                <UBadge v-if="s.library && !s.library.loaded" size="sm" variant="subtle" color="warning">not loaded yet</UBadge>
                <UBadge v-else-if="s.library" size="sm" variant="subtle" color="neutral">v{{ s.library.version }}</UBadge>
                <UBadge v-if="errors(s).length" size="sm" variant="subtle" color="error">{{ errors(s).length }} error{{ errors(s).length === 1 ? '' : 's' }}</UBadge>
                <UBadge v-else-if="problems(s).length" size="sm" variant="subtle" color="warning">{{ problems(s).length }} to improve</UBadge>
              </div>
              <p class="text-xs text-muted line-clamp-2 mt-0.5">{{ s.description || 'No description: opencode hides skills without one.' }}</p>
            </button>
            <!-- auto / ask / off -->
            <div class="flex shrink-0 rounded-sm bg-muted p-0.5" role="radiogroup" :aria-label="`Permission for ${s.name}`">
              <UTooltip v-for="m in MODES" :key="m.value" :text="`${m.tip}${s.permissionRule && s.permissionRule !== s.name && s.permission === m.value ? ` (from rule ${s.permissionRule})` : ''}`">
                <button
                  type="button"
                  role="radio"
                  :aria-checked="s.permission === m.value"
                  class="px-2 py-0.5 text-[11px] rounded-sm transition-colors cursor-pointer disabled:opacity-50"
                  :class="s.permission === m.value ? (m.value === 'deny' ? 'bg-accented text-highlighted' : 'bg-inverted text-inverted') : 'text-dimmed hover:text-highlighted'"
                  :disabled="settingPermission === s.name || !caps.config"
                  @click="s.permission !== m.value && setPermission(s, m.value)"
                >{{ m.label }}</button>
              </UTooltip>
            </div>
          </div>
        </TransitionGroup>
      </div>
    </div>

    <!-- new skill -->
    <UModal v-model:open="newOpen" title="New skill" description="Lowercase name with hyphens. Describe what it is for and let a model draft it, or start from a template.">
      <template #body>
        <div class="space-y-3">
          <UFormField label="Name" size="sm" :error="newName && !nameValid ? 'lowercase letters, digits and single hyphens' : undefined">
            <UInput v-model="newName" placeholder="release-notes" class="w-full font-mono" />
          </UFormField>
          <UFormField label="What is it for?" size="sm" description="Used by the AI draft: the task, conventions, commands, examples you want it to follow.">
            <UTextarea v-model="newBrief" :rows="4" autoresize :maxrows="10" placeholder="Write release notes from the git log since the last tag, grouped by feat/fix, in our CHANGELOG style…" class="w-full" />
          </UFormField>
          <UFormField label="AI model" size="sm">
            <ModelSelect v-model="aiModel" :items="models.items.value" :loading="models.loading.value" empty-label="opencode default model" />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <div class="oc-actions">
          <UButton variant="ghost" color="neutral" label="Cancel" @click="newOpen = false" />
          <span class="flex-1 oc-spacer" />
          <UButton variant="soft" color="neutral" icon="i-lucide-file-plus" label="From template" :disabled="!nameValid" @click="createSkill(false)" />
          <UButton color="primary" icon="i-lucide-sparkles" label="Write with AI" :loading="editor.generating" :disabled="!nameValid || !newBrief.trim()" @click="createSkill(true)" />
        </div>
      </template>
    </UModal>

    <!-- view / edit / check / improve -->
    <UModal v-model:open="editor.open" :title="editor.name" :ui="{ content: 'sm:max-w-4xl' }">
      <template #description>
        <span class="flex flex-wrap items-center gap-1.5 text-xs">
          <UBadge size="sm" variant="subtle" color="neutral">{{ editor.isNew ? 'Library (unsaved)' : editor.skill ? sourceOf(editor.skill.source).label : '' }}</UBadge>
          <span v-if="editor.skill?.location" class="font-mono text-dimmed truncate max-w-full">{{ editor.skill.location }}</span>
          <span class="text-dimmed">{{ preview.words }} words · ~{{ preview.tokens }} tokens when loaded</span>
        </span>
      </template>
      <template #body>
        <div class="space-y-3">
          <div class="flex gap-0.5 p-0.5 rounded-sm bg-muted" role="tablist">
            <UButton
              v-for="t in ([['preview', 'Overview', 'i-lucide-eye'], ['edit', editable ? 'Edit' : 'Source', 'i-lucide-pencil'], ['checks', `Checks${liveChecks.filter((c) => c.level !== 'tip').length ? ` (${liveChecks.filter((c) => c.level !== 'tip').length})` : ''}`, 'i-lucide-list-checks'], ['ai', 'Improve with AI', 'i-lucide-sparkles']] as const)"
              :key="t[0]"
              size="xs"
              :variant="editor.tab === t[0] ? 'solid' : 'ghost'"
              :color="editor.tab === t[0] ? 'primary' : 'neutral'"
              :icon="t[2]"
              :label="t[1]"
              class="flex-1 justify-center"
              role="tab"
              :aria-selected="editor.tab === t[0]"
              @click="editor.tab = t[0]"
            />
          </div>

          <Transition name="oc-fade" mode="out-in">
            <!-- overview: what triggers it, what it says -->
            <div v-if="editor.tab === 'preview'" key="preview" class="space-y-3">
              <div class="rounded-sm bg-muted p-3">
                <div class="text-[10px] uppercase tracking-widest text-dimmed mb-1">When the agent uses it (description, always in context)</div>
                <p class="text-sm">{{ preview.fields.find(([k]) => k === 'description')?.[1] || 'No description.' }}</p>
                <dl v-if="preview.fields.length > 2" class="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs">
                  <div v-for="[k, v] in preview.fields.filter(([k]) => k !== 'name' && k !== 'description')" :key="k">
                    <dt class="inline text-dimmed">{{ k }}:</dt> <dd class="inline font-mono">{{ v }}</dd>
                  </div>
                </dl>
              </div>
              <div class="text-[10px] uppercase tracking-widest text-dimmed">Instructions (loaded on demand)</div>
              <div class="rounded-sm bg-muted p-3 max-h-[50dvh] overflow-y-auto">
                <Markdown :text="preview.body.trim() || '_No instructions yet._'" />
              </div>
            </div>

            <div v-else-if="editor.tab === 'edit'" key="edit" class="space-y-2">
              <UAlert
                v-if="!editable"
                color="info"
                variant="subtle"
                icon="i-lucide-copy"
                :title="`This ${editor.skill?.source} skill is read-only here`"
                description="Edit a copy in the skill library: it overrides this one once opencode reloads."
              >
                <template #actions>
                  <UButton size="xs" color="info" variant="soft" icon="i-lucide-copy" label="Edit a copy" @click="copyToLibrary" />
                </template>
              </UAlert>
              <UTextarea
                v-model="editor.content"
                :rows="18"
                :maxrows="30"
                autoresize
                :readonly="!editable"
                class="w-full font-mono text-xs"
                :ui="{ base: 'text-xs leading-relaxed' }"
              />
            </div>

            <div v-else-if="editor.tab === 'checks'" key="checks" class="space-y-1.5">
              <p v-if="!liveChecks.length" class="flex items-center gap-2 text-sm text-success py-4 justify-center">
                <UIcon name="i-lucide-circle-check" class="size-4" /> Looks good: valid frontmatter, a when-to-use description and real instructions.
              </p>
              <div v-for="(c, i) in liveChecks" :key="i" class="flex items-start gap-2 rounded-sm bg-muted px-3 py-2 text-sm">
                <UIcon :name="checkIcon(c.level)" class="size-4 mt-0.5 shrink-0" :class="checkColor(c.level)" />
                <span>{{ c.message }}</span>
              </div>
              <UButton v-if="liveChecks.length" size="xs" variant="soft" icon="i-lucide-sparkles" label="Fix these with AI" @click="editor.brief = liveChecks.map((c) => c.message).join(' '); editor.tab = 'ai'" />
            </div>

            <div v-else key="ai" class="space-y-2">
              <div class="flex flex-wrap items-end gap-2">
                <UFormField label="AI model" size="xs" class="flex-1 min-w-48">
                  <ModelSelect v-model="aiModel" :items="models.items.value" :loading="models.loading.value" size="xs" empty-label="opencode default model" />
                </UFormField>
              </div>
              <UTextarea v-model="editor.brief" :rows="2" autoresize :maxrows="6" placeholder="Optional: what to change (e.g. add an example for monorepos, make it stricter about tests)…" class="w-full" />
              <UButton size="sm" color="primary" icon="i-lucide-sparkles" :label="editor.proposal ? 'Try again' : 'Improve'" :loading="editor.generating" :disabled="!editor.content" @click="improve" />
              <CollapseTransition>
                <div v-if="editor.proposal" class="space-y-2">
                  <div class="text-[10px] uppercase tracking-widest text-dimmed">Proposal</div>
                  <pre class="text-xs font-mono bg-muted rounded-sm p-2.5 whitespace-pre-wrap max-h-[40dvh] overflow-y-auto">{{ editor.proposal }}</pre>
                  <div v-if="editor.proposalChecks.length" class="text-[11px] text-dimmed">Still to check: {{ editor.proposalChecks.map((c) => c.message).join(' · ') }}</div>
                  <div class="flex gap-1.5">
                    <UButton size="xs" color="primary" icon="i-lucide-check" :label="editable ? 'Use it' : 'Use it as a library copy'" @click="acceptProposal" />
                    <UButton size="xs" variant="ghost" color="neutral" label="Discard" @click="editor.proposal = ''" />
                  </div>
                </div>
              </CollapseTransition>
            </div>
          </Transition>
        </div>
      </template>
      <template #footer>
        <div class="oc-actions">
          <UButton
            v-if="editor.skill?.source === 'library' && !editor.isNew"
            :color="confirmDelete ? 'error' : 'neutral'"
            :variant="confirmDelete ? 'solid' : 'ghost'"
            icon="i-lucide-trash-2"
            :label="confirmDelete ? 'Delete?' : 'Delete'"
            @click="removeSkill"
          />
          <span class="flex-1 oc-spacer" />
          <UButton variant="ghost" color="neutral" label="Close" @click="editor.open = false" />
          <UButton
            v-if="editable"
            color="primary"
            icon="i-lucide-save"
            :label="editor.isNew ? 'Save to library' : 'Save'"
            :loading="editor.saving"
            :disabled="!dirty || liveChecks.some((c) => c.level === 'error')"
            @click="save"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
