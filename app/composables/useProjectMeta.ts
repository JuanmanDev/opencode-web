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
  }

  function persist() {
    localStorage.setItem(KEY, JSON.stringify(meta.value))
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
