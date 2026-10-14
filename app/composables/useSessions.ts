import type { SessionInfo } from '#shared/types/opencode'

const CACHE_PREFIX = 'opencode-web.sessions.'

/** Cached session list for a directory (instant paint, may be stale). */
export function readSessionsCache(directory: string): SessionInfo[] {
  return readCache(directory)
}

function readCache(directory: string): SessionInfo[] {
  if (!import.meta.client) return []
  try {
    return JSON.parse(localStorage.getItem(CACHE_PREFIX + directory) || '[]')
  } catch {
    return []
  }
}

function writeCache(directory: string, sessions: SessionInfo[]) {
  if (!import.meta.client) return
  try {
    localStorage.setItem(CACHE_PREFIX + directory, JSON.stringify(sessions.slice(0, 100)))
  } catch { /* storage full — ignore */ }
}

/**
 * Shared session list per project, updated live from SSE session.updated
 * events and cached in localStorage so the list paints instantly on reload.
 */
export function useSessions(directory: MaybeRefOrGetter<string>) {
  const dir = toValue(directory)
  const sessions = useState<SessionInfo[]>(`sessions.${dir}`, () => [])
  const refreshing = useState<boolean>(`sessions-loading.${dir}`, () => false)
  // subagent sessions (task tool), keyed by the conversation that started them
  const children = useState<Record<string, SessionInfo[]>>(`sessions-children.${dir}`, () => ({}))
  const api = useOpencodeApi(directory)

  function addChild(info: SessionInfo) {
    const parent = info.parentID!
    const list = (children.value[parent] || []).filter((s) => s.id !== info.id)
    children.value = {
      ...children.value,
      [parent]: [...list, info].sort((a, b) => (a.time?.created || 0) - (b.time?.created || 0))
    }
  }

  // paint from cache after hydration (doing it during setup makes the client
  // vdom diverge from the server-rendered empty list -> hydration mismatch)
  if (import.meta.client && getCurrentInstance()) {
    onMounted(() => {
      if (sessions.value.length === 0) {
        const cached = readCache(dir)
        if (cached.length) sessions.value = cached
      }
    })
  }

  async function refresh() {
    refreshing.value = true
    try {
      const list = await api.sessions()
      const kids: Record<string, SessionInfo[]> = {}
      for (const s of list) if (s.parentID) (kids[s.parentID] ||= []).push(s)
      for (const k of Object.values(kids)) k.sort((a, b) => (a.time?.created || 0) - (b.time?.created || 0))
      children.value = kids
      sessions.value = [...list]
        .filter((s) => !s.parentID)
        .sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0))
      writeCache(dir, sessions.value)
    } catch {
      // server unreachable; keep cached list
    } finally {
      refreshing.value = false
    }
  }

  function upsert(info: SessionInfo) {
    if (info.parentID) {
      addChild(info)
      return
    }
    const idx = sessions.value.findIndex((s) => s.id === info.id)
    if (idx >= 0) sessions.value.splice(idx, 1, info)
    else sessions.value.unshift(info)
    sessions.value = [...sessions.value].sort(
      (a, b) => (b.time?.updated || 0) - (a.time?.updated || 0)
    )
    writeCache(dir, sessions.value)
  }

  function remove(id: string) {
    const kids = Object.fromEntries(Object.entries(children.value)
      .filter(([parent]) => parent !== id)
      .map(([parent, list]) => [parent, list.filter((s) => s.id !== id)]))
    children.value = kids
    sessions.value = sessions.value.filter((s) => s.id !== id)
    writeCache(dir, sessions.value)
  }

  return { sessions, children, refreshing, refresh, upsert, remove }
}
