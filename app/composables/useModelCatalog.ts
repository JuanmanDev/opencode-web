import type { ProvidersResponse } from '#shared/types/opencode'

export interface ModelItem {
  label: string
  /** "providerID/modelID" */
  value: string
  provider: string
  providerID: string
  reasoning: boolean
  /** context window in thousands of tokens */
  ctx: number
  /** "$in/$out" per million tokens, "free" or "" */
  cost: string
  attachment: boolean
}

/** Flat, sorted model list from opencode's /config/providers answer. */
export function modelItemsOf(providers: ProvidersResponse | null | undefined): ModelItem[] {
  if (!providers) return []
  const items: ModelItem[] = []
  for (const provider of providers.providers || []) {
    const providerName = String(provider.name || provider.id)
    for (const [id, m] of Object.entries(provider.models || {})) {
      const cin = m.cost?.input
      const cout = m.cost?.output
      items.push({
        label: `${m.name || id}`,
        value: `${provider.id}/${id}`,
        provider: providerName,
        providerID: provider.id,
        reasoning: Boolean(m.reasoning || m.capabilities?.reasoning),
        ctx: Math.round((m.limit?.context || 0) / 1000),
        cost: cin != null && cout != null && (cin > 0 || cout > 0)
          ? `$${cin}/${cout}`
          : (cin === 0 && cout === 0 ? 'free' : ''),
        attachment: Boolean(m.attachment)
      })
    }
  }
  return items.sort((a, b) => a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label))
}

/**
 * Providers and models of a project, painted from the local cache first
 * (same cache as the chat) and refreshed from the server.
 */
export function useModelCatalog(directory: MaybeRefOrGetter<string | undefined>) {
  const api = useOpencodeApi(directory)
  const providers = ref<ProvidersResponse | null>(null)
  const defaultModel = ref('')
  const loading = ref(false)
  const cacheKey = () => `opencode-web.providers.${toValue(directory) || ''}`

  async function load() {
    loading.value = true
    try {
      const cached = JSON.parse(localStorage.getItem(cacheKey()) || 'null')
      if (cached && !providers.value) providers.value = cached
    } catch { /* ignore */ }
    try {
      const [prov, cfg] = await Promise.all([
        api.providers().catch(() => null),
        api.config().catch(() => null)
      ])
      if (prov) {
        providers.value = prov
        try { localStorage.setItem(cacheKey(), JSON.stringify(prov)) } catch { /* full */ }
      }
      if (typeof cfg?.model === 'string') defaultModel.value = cfg.model
    } finally {
      loading.value = false
    }
  }

  const items = computed(() => modelItemsOf(providers.value))
  return { providers, items, defaultModel, loading, load }
}
