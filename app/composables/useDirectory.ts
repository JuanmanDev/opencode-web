// Directory paths are carried in the URL as base64url so Windows paths,
// slashes and spaces survive routing.
export function encodeDir(path: string): string {
  const b64 = btoa(unescape(encodeURIComponent(path)))
  return b64.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/**
 * Inverse of encodeDir. Never throws: a malformed/tampered URL param yields ''
 * so pages can show a "project not found" instead of a 500.
 */
export function decodeDir(param: string): string {
  if (typeof param !== 'string' || !param || !/^[A-Za-z0-9_-]+$/.test(param)) return ''
  try {
    const b64 = param.replaceAll('-', '+').replaceAll('_', '/')
    const pad = b64.length % 4 === 0 ? b64 : b64 + '='.repeat(4 - (b64.length % 4))
    return decodeURIComponent(escape(atob(pad)))
  } catch {
    return ''
  }
}

export interface RecentProject {
  directory: string
  lastOpened: number
  /** recent: opened from a browser; session: opencode has sessions there; project: a git project */
  source?: 'recent' | 'session' | 'project'
  sessions?: number
}

const RECENTS_KEY = 'opencode-web.recent-projects'
const MIGRATED_KEY = 'opencode-web.recent-projects.migrated'

/**
 * Folders for the project picker. The server's list is the source of truth
 * (sessions of every project + folders opened from any browser), so every
 * browser and device shows the same folders; localStorage only paints the
 * list instantly and keeps working offline.
 */
export function useRecentProjects() {
  const recents = useState<RecentProject[]>('recent-projects', () => [])

  function save() {
    try { localStorage.setItem(RECENTS_KEY, JSON.stringify(recents.value.slice(0, 100))) } catch { /* full */ }
  }

  async function load() {
    if (!import.meta.client) return
    let local: RecentProject[] = []
    try { local = JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]') } catch { /* corrupt */ }
    if (!recents.value.length) recents.value = local
    // this browser's own history predates the shared list: hand it over once
    if (!localStorage.getItem(MIGRATED_KEY)) {
      const mine = local.filter((r) => !r.source || r.source === 'recent')
      await Promise.all(mine.map((r) => $fetch('/api/v1/directories', { method: 'PUT', body: { directory: r.directory }, timeout: 8000 }).catch(() => {})))
      localStorage.setItem(MIGRATED_KEY, '1')
    }
    try {
      const server = await $fetch<Array<{ directory: string; lastActivity: number; sessions: number; source: RecentProject['source'] }>>(
        '/api/v1/directories', { timeout: 30000 })
      recents.value = server.map((d) => ({ directory: d.directory, lastOpened: d.lastActivity, source: d.source, sessions: d.sessions }))
      save()
    } catch { /* offline: keep the local copy */ }
  }

  function remember(directory: string) {
    if (!import.meta.client) return
    const current = recents.value.find((r) => r.directory === directory)
    recents.value = [{ ...current, directory, lastOpened: Date.now(), source: 'recent' as const }, ...recents.value.filter((r) => r.directory !== directory)]
    save()
    $fetch('/api/v1/directories', { method: 'PUT', body: { directory }, timeout: 8000 }).catch(() => {})
  }

  function forget(directory: string) {
    if (!import.meta.client) return
    recents.value = recents.value.filter((r) => r.directory !== directory)
    save()
    $fetch('/api/v1/directories', { method: 'DELETE', query: { directory }, timeout: 8000 }).catch(() => {})
  }

  return { recents, load, remember, forget }
}

/** Short display name for a directory path (last segment). */
export function dirName(path: string): string {
  const clean = path.replace(/[\\/]+$/, '')
  const parts = clean.split(/[\\/]/)
  return parts[parts.length - 1] || clean || path
}
