<script setup lang="ts">
import type { ProvidersResponse } from '#shared/types/opencode'

const props = defineProps<{
  providers: ProvidersResponse | null
  directory: string
  loading?: boolean
}>()

const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ saved: [] }>()

const api = useOpencodeApi(() => props.directory)
const toast = useToast()

const providerId = ref('')
const apiKey = ref('')
const saving = ref(false)
const customIds = ref<string[]>([])

const configured = computed(() =>
  (props.providers?.providers || []).map((p) => ({
    id: p.id,
    name: String(p.name || p.id),
    models: Object.keys(p.models || {}).length
  }))
)

const KNOWN = [
  'anthropic', 'openai', 'google', 'openrouter', 'groq', 'mistral',
  'deepseek', 'xai', 'togetherai', 'fireworks', 'cerebras', 'litellm',
  'ollama', 'opencode'
]

const providerItems = computed(() => {
  const seen = new Set<string>()
  const items: Array<{ label: string; value: string; icon: string }> = []
  const push = (id: string, label?: string) => {
    if (seen.has(id)) return
    seen.add(id)
    items.push({ label: label || id, value: id, icon: 'i-lucide-plug' })
  }
  for (const p of configured.value) push(p.id, `${p.name} (configured)`)
  for (const id of KNOWN) push(id)
  for (const id of customIds.value) push(id)
  return items
})

function onCreate(item: unknown) {
  const id = String(typeof item === 'string' ? item : (item as { label?: string })?.label || '')
    .trim().toLowerCase()
  if (!id) return
  customIds.value.push(id)
  providerId.value = id
}

async function save() {
  const id = providerId.value.trim().toLowerCase()
  const key = apiKey.value.trim()
  if (!id || !key) return
  saving.value = true
  try {
    await api.setAuth(id, key)
    toast.add({
      title: `API key saved for ${id}`,
      description: 'Model list refreshed. New sessions pick it up immediately.',
      color: 'success'
    })
    providerId.value = ''
    apiKey.value = ''
    emit('saved')
    open.value = false
  } catch (e) {
    toast.add({ title: 'Failed to save key', description: String(e), color: 'error' })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    title="Providers"
    description="Manage model providers and their API keys."
  >
    <template #body>
      <div class="space-y-5">
        <section>
          <h3 class="text-xs font-medium text-muted mb-2">Configured</h3>
          <div v-if="loading" class="space-y-2">
            <USkeleton v-for="i in 3" :key="i" class="h-9 w-full" />
          </div>
          <div v-else class="bg-muted rounded-sm divide-y divide-default max-h-44 overflow-y-auto">
            <div
              v-for="p in configured"
              :key="p.id"
              class="flex items-center gap-2.5 px-3 py-2 text-sm"
            >
              <UIcon name="i-lucide-plug" class="size-3.5 text-muted shrink-0" />
              <div class="min-w-0 flex-1">
                <span class="font-medium">{{ p.name }}</span>
                <span class="ml-2 font-mono text-xs text-dimmed">{{ p.id }}</span>
              </div>
              <UBadge variant="subtle" color="neutral" size="sm">{{ p.models }} models</UBadge>
            </div>
            <div v-if="!configured.length" class="px-3 py-4 text-sm text-dimmed">
              No providers configured yet — add a key below.
            </div>
          </div>
        </section>

        <USeparator />

        <section class="space-y-3">
          <h3 class="text-xs font-medium text-muted">Add or update an API key</h3>
          <UFormField
            label="Provider"
            size="sm"
            description="Pick one, or type any provider id and press Enter to add it."
          >
            <USelectMenu
              v-model="providerId"
              :items="providerItems"
              value-key="value"
              :loading="loading"
              create-item
              :search-input="{ placeholder: 'Search or type a provider id…' }"
              placeholder="Select provider"
              icon="i-lucide-plug"
              class="w-full"
              @create="onCreate"
            />
          </UFormField>
          <UFormField
            label="API key"
            size="sm"
            description="Stored by the opencode server, shared across all projects."
          >
            <UInput
              v-model="apiKey"
              type="password"
              placeholder="sk-…"
              icon="i-lucide-key-round"
              class="w-full font-mono"
              @keydown.enter="save"
            />
          </UFormField>
          <UAlert
            color="neutral"
            variant="subtle"
            icon="i-lucide-info"
            description="OAuth providers (e.g. Anthropic Pro/Max) can't use an API key — run `opencode auth login` on the server instead."
          />
        </section>
      </div>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton variant="ghost" color="neutral" label="Close" @click="open = false" />
        <UButton
          color="primary"
          label="Save key"
          :loading="saving"
          :disabled="!providerId.trim() || !apiKey.trim()"
          @click="save"
        />
      </div>
    </template>
  </UModal>
</template>
