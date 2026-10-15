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
 * Follows `directory` when it changes (the project shell stays mounted while
 * switching projects).
 */
export function useSessions(directory: MaybeRefOrGetter<string>) {
  const lists = useState<Record<string, SessionInfo[]>>('sessions', () => ({}))
  const loadingByDir = useState<Record<string, boolean>>('sessions-loading', () => ({}))
  // subagent sessions (task tool), keyed by the conversation that started them
  const childrenByDir = useState<Record<string, Record<string, SessionInfo[]>>>('sessions-children', () => ({}))
  const dir = () => toValue(directory)

  const sessions = computed<SessionInfo[]>({
    get: () => lists.value[dir()] || [],
    set: (list) => { lists.value = { ...lists.value, [dir()]: list } }
  })
  const refreshing = computed<boolean>({
    get: () => Boolean(loadingByDir.value[dir()]),
    set: (on) => { loadingByDir.value = { ...loadingByDir.value, [dir()]: on } }
  })
  const children = computed<Record<string, SessionInfo[]>>({
    get: () => childrenByDir.value[dir()] || {},
    set: (map) => { childrenByDir.value = { ...childrenByDir.value, [dir()]: map } }
  })

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
  function paintCache() {
    if (sessions.value.length === 0) {
      const cached = readCache(dir())
      if (cached.length) sessions.value = cached
    }
  }
  if (import.meta.client && getCurrentInstance()) {
    onMounted(() => {
      paintCache()
      watch(dir, paintCache)
    })
  }

  async function refresh() {
    const target = dir()
    loadingByDir.value = { ...loadingByDir.value, [target]: true }
    try {
      const list = await useOpencodeApi(target).sessions()
      const kids: Record<string, SessionInfo[]> = {}
      for (const s of list) if (s.parentID) (kids[s.parentID] ||= []).push(s)
      for (const k of Object.values(kids)) k.sort((a, b) => (a.time?.created || 0) - (b.time?.created || 0))
      const top = [...list]
        .filter((s) => !s.parentID)
        .sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0))
      childrenByDir.value = { ...childrenByDir.value, [target]: kids }
      lists.value = { ...lists.value, [target]: top }
      writeCache(target, top)
    } catch {
      // server unreachable; keep cached list
    } finally {
      loadingByDir.value = { ...loadingByDir.value, [target]: false }
    }
  }

  function upsert(info: SessionInfo) {
    if (info.parentID) {
      addChild(info)
      return
    }
    const next = sessions.value.filter((s) => s.id !== info.id)
    next.unshift(info)
    sessions.value = next.sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0))
    writeCache(dir(), sessions.value)
  }

  function remove(id: string) {
    children.value = Object.fromEntries(Object.entries(children.value)
      .filter(([parent]) => parent !== id)
      .map(([parent, list]) => [parent, list.filter((s) => s.id !== id)]))
    sessions.value = sessions.value.filter((s) => s.id !== id)
    writeCache(dir(), sessions.value)
  }

  return { sessions, children, refreshing, refresh, upsert, remove }
}
