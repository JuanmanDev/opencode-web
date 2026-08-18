// MCP app viewer: registry of rendered app resources (per tool part) and
// URL-addressable display state (?app=<id>&view=side|full) so a link to a
// specific component can be shared and opens directly.

export interface McpAppResource {
  html?: string
  url?: string
  title?: string
  remoteDom?: boolean
  script?: string
  app?: { html: string }
  appData?: { toolInput?: unknown; toolResult?: unknown }
}

export function useAppRegistry() {
  const registry = useState<Record<string, McpAppResource>>('mcp-app-registry', () => ({}))

  function register(id: string, resource: McpAppResource) {
    if (!registry.value[id]) registry.value = { ...registry.value, [id]: resource }
  }

  return { registry, register }
}

export function useAppViewer() {
  const route = useRoute()
  const router = useRouter()

  const appId = computed(() => (route.query.app as string) || '')
  const view = computed(() => {
    const v = route.query.view as string
    return v === 'full' ? 'full' : v === 'side' ? 'side' : ''
  })

  function open(id: string, mode: 'side' | 'full') {
    router.replace({ query: { ...route.query, app: id, view: mode } })
  }

  function close() {
    const { app: _a, view: _v, ...rest } = route.query
    router.replace({ query: rest })
  }

  return { appId, view, open, close }
}
