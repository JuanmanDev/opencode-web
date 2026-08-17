// Client-side project metadata (descriptions, favorite sessions).
// opencode has no fields for these, so they live in localStorage.
interface ProjectMeta {
  description?: string
  favorites: string[]
}

const KEY = 'opencode-web.project-meta'

export function useProjectMeta() {
  const meta = useState<Record<string, ProjectMeta>>('project-meta', () => ({}))

  function load() {
    if (!import.meta.client) return
    try {
      meta.value = JSON.parse(localStorage.getItem(KEY) || '{}')
    } catch {
      meta.value = {}
    }
    // server copy wins so favorites/descriptions follow you across devices
    $fetch<Record<string, ProjectMeta>>('/api/v1/meta', { timeout: 8000 })
      .then((server) => {
        if (server && typeof server === 'object' && Object.keys(server).length) {
          meta.value = { ...meta.value, ...server }
          localStorage.setItem(KEY, JSON.stringify(meta.value))
        }
      })
      .catch(() => { /* offline: localStorage is enough */ })
  }

  function persist() {
    localStorage.setItem(KEY, JSON.stringify(meta.value))
    $fetch('/api/v1/meta', { method: 'PUT', body: meta.value, timeout: 8000 })
      .catch(() => { /* sync later */ })
  }

  function of(directory: string): ProjectMeta {
    return meta.value[directory] || { favorites: [] }
  }

  function setDescription(directory: string, description: string) {
    meta.value = {
      ...meta.value,
      [directory]: { ...of(directory), description: description.trim() || undefined }
    }
    persist()
  }

  function isFavorite(directory: string, sessionId: string) {
    return of(directory).favorites.includes(sessionId)
  }

  function toggleFavorite(directory: string, sessionId: string) {
    const current = of(directory)
    const favorites = current.favorites.includes(sessionId)
      ? current.favorites.filter((id) => id !== sessionId)
      : [...current.favorites, sessionId]
    meta.value = { ...meta.value, [directory]: { ...current, favorites } }
    persist()
  }

  return { meta, load, of, setDescription, isFavorite, toggleFavorite }
}
