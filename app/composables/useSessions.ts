import type { SessionInfo } from '#shared/types/opencode'

const CACHE_PREFIX = 'opencode-web.sessions.'

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
  const api = useOpencodeApi(directory)

  // paint from cache immediately (client only, before the network answers)
  if (import.meta.client && sessions.value.length === 0) {
    const cached = readCache(dir)
    if (cached.length) sessions.value = cached
  }

  async function refresh() {
    refreshing.value = true
    try {
      const list = await api.sessions()
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
    if (info.parentID) return
    const idx = sessions.value.findIndex((s) => s.id === info.id)
    if (idx >= 0) sessions.value.splice(idx, 1, info)
    else sessions.value.unshift(info)
    sessions.value = [...sessions.value].sort(
      (a, b) => (b.time?.updated || 0) - (a.time?.updated || 0)
    )
    writeCache(dir, sessions.value)
  }

  function remove(id: string) {
    sessions.value = sessions.value.filter((s) => s.id !== id)
    writeCache(dir, sessions.value)
  }

  return { sessions, refreshing, refresh, upsert, remove }
}
