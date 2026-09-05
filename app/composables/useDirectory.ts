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
}

const RECENTS_KEY = 'opencode-web.recent-projects'

export function useRecentProjects() {
  const recents = useState<RecentProject[]>('recent-projects', () => [])

  function load() {
    if (!import.meta.client) return
    try {
      recents.value = JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]')
    } catch {
      recents.value = []
    }
  }

  function remember(directory: string) {
    if (!import.meta.client) return
    const list = recents.value.filter((r) => r.directory !== directory)
    list.unshift({ directory, lastOpened: Date.now() })
    recents.value = list.slice(0, 20)
    localStorage.setItem(RECENTS_KEY, JSON.stringify(recents.value))
  }

  function forget(directory: string) {
    if (!import.meta.client) return
    recents.value = recents.value.filter((r) => r.directory !== directory)
    localStorage.setItem(RECENTS_KEY, JSON.stringify(recents.value))
  }

  return { recents, load, remember, forget }
}

/** Short display name for a directory path (last segment). */
export function dirName(path: string): string {
  const clean = path.replace(/[\\/]+$/, '')
  const parts = clean.split(/[\\/]/)
  return parts[parts.length - 1] || clean || path
}
