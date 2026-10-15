// Every folder opencode has worked in, for the project picker. opencode's
// own project list only knows git repositories: any other folder (/docker,
// /tmp…) is lumped into the "global" project and would only be listed by the
// browser that opened it. Folders come from the sessions themselves (all
// projects), from git projects, and from a recents list kept by this app so
// every browser and device sees the same picker.

export interface KnownDirectory {
  directory: string
  /** newest session activity or last time it was opened here */
  lastActivity: number
  sessions: number
  source: 'session' | 'project' | 'recent'
}

interface DirectoryStore {
  recents: Array<{ directory: string; lastOpened: number }>
  /** removed from the picker by the user (kept out even if sessions exist) */
  hidden: string[]
}

const KEY = 'directories.json'
const MAX_RECENTS = 50

export async function directoryStore(): Promise<DirectoryStore> {
  const stored = await useStorage('data').getItem<Partial<DirectoryStore>>(KEY).catch(() => null)
  return { recents: stored?.recents || [], hidden: stored?.hidden || [] }
}

async function saveStore(store: DirectoryStore) {
  await useStorage('data').setItem(KEY, store)
}

export async function rememberDirectory(directory: string) {
  const store = await directoryStore()
  store.recents = [{ directory, lastOpened: Date.now() }, ...store.recents.filter((r) => r.directory !== directory)].slice(0, MAX_RECENTS)
  store.hidden = store.hidden.filter((d) => d !== directory)
  await saveStore(store)
}

export async function forgetDirectory(directory: string) {
  const store = await directoryStore()
  store.recents = store.recents.filter((r) => r.directory !== directory)
  if (!store.hidden.includes(directory)) store.hidden.push(directory)
  await saveStore(store)
}

interface SessionRow { directory?: string; parentID?: string; time?: { created?: number; updated?: number } }

/** Sessions of every project: the v2 list is global; 1.x has an experimental cross-project route. */
async function allSessions(): Promise<SessionRow[]> {
  const profile = await getServerProfile()
  if (profile.protocol === 'v2') {
    return opencodeFetch<SessionRow[]>('/session', { timeoutMs: 30000 }).catch(() => [])
  }
  const rows = await opencodeFetch<SessionRow[] | { data?: SessionRow[] }>('/experimental/session', {
    query: { roots: 'true', limit: '2000' },
    timeoutMs: 30000
  }).catch(() => null)
  if (rows) return Array.isArray(rows) ? rows : rows.data || []
  // servers without the route: the sessions of the folder opencode runs in
  return opencodeFetch<SessionRow[]>('/session', { timeoutMs: 30000 }).catch(() => [])
}

export async function knownDirectories(): Promise<KnownDirectory[]> {
  const [sessions, projects, store] = await Promise.all([
    allSessions(),
    opencodeFetch<Array<{ worktree?: string; time?: { created?: number; updated?: number } }>>('/project', { timeoutMs: 20000 }).catch(() => []),
    directoryStore()
  ])
  const byDir = new Map<string, KnownDirectory>()
  const add = (directory: string | undefined, at: number, source: KnownDirectory['source'], sessionCount = 0) => {
    if (!directory || store.hidden.includes(directory)) return
    const known = byDir.get(directory)
    if (!known) {
      byDir.set(directory, { directory, lastActivity: at, sessions: sessionCount, source })
      return
    }
    known.lastActivity = Math.max(known.lastActivity, at)
    known.sessions += sessionCount
    // the strongest source wins for the label: recent > session > project
    if (source === 'recent' || (source === 'session' && known.source === 'project')) known.source = source
  }
  for (const s of sessions) {
    if (s.parentID) continue
    add(s.directory, s.time?.updated || s.time?.created || 0, 'session', 1)
  }
  // "/" is opencode's catch-all project for non-git folders, not a folder you opened
  for (const p of Array.isArray(projects) ? projects : []) {
    if (p.worktree && p.worktree !== '/') add(p.worktree, p.time?.updated || p.time?.created || 0, 'project')
  }
  for (const r of store.recents) add(r.directory, r.lastOpened, 'recent')
  return [...byDir.values()].sort((a, b) => b.lastActivity - a.lastActivity)
}
