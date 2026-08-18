// One round-trip project overview, cached server-side (SWR) so opening a
// project paints instantly even when the opencode server is slow.

interface SessionLite {
  id: string
  title?: string
  parentID?: string
  cost?: number
  time?: { created?: number; updated?: number }
  tokens?: { input?: number; output?: number }
}

const getSummary = defineCachedFunction(
  async (directory?: string) => {
    const [sessions, mcp, agents, providers] = await Promise.all([
      opencodeFetch<SessionLite[]>('/session', { query: { directory } }).catch(() => [] as SessionLite[]),
      opencodeFetch<Record<string, { status?: string }>>('/mcp', { query: { directory } }).catch(() => ({})),
      opencodeFetch<Array<{ name: string; mode?: string }>>('/agent', { query: { directory } }).catch(() => []),
      opencodeFetch<{ providers?: Array<{ id: string; models: Record<string, unknown> }>; default?: Record<string, string> }>(
        '/config/providers', { query: { directory } }
      ).catch(() => null)
    ])

    const topLevel = sessions
      .filter((s) => !s.parentID)
      .sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0))

    const modelCount = (providers?.providers || [])
      .reduce((acc, p) => acc + Object.keys(p.models || {}).length, 0)
    const [defaultProvider, defaultModel] = Object.entries(providers?.default || {})[0] || []

    return {
      generatedAt: Date.now(),
      sessions: {
        total: topLevel.length,
        totalCost: topLevel.reduce((acc, s) => acc + (s.cost || 0), 0),
        recent: topLevel.slice(0, 8).map((s) => ({
          id: s.id, title: s.title, time: s.time, cost: s.cost
        }))
      },
      mcp: Object.entries(mcp).map(([name, s]) => ({ name, status: s?.status || 'unknown' })),
      agents: agents.filter((a) => !a.mode || a.mode === 'primary' || a.mode === 'all').map((a) => a.name),
      models: { count: modelCount, default: defaultProvider ? `${defaultProvider}/${defaultModel}` : undefined }
    }
  },
  {
    name: 'project-summary',
    maxAge: 20,
    swr: true,
    getKey: (directory?: string) => encodeURIComponent(directory || 'root')
  }
)

export default defineEventHandler(async (event) => {
  requireApiToken(event) // auth runs on every request; only the fetch work is cached
  const { directory } = getQuery(event) as { directory?: string }
  return getSummary(directory)
})
