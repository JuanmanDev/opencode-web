import type { SessionInfo } from '#shared/types/opencode'
import { RECENT_CHATS_DEFAULTS, type RecentChatsSettings } from '~/utils/recentChats'

// Settings of the projects panel's chat lists, and which chats this browser
// has seen (a chat is unread when it changed after you last looked at it).
// Both live in localStorage: they describe this browser's reading, not the
// server's state.

const SETTINGS_KEY = 'opencode-web.recent-chats'
const SEEN_KEY = 'opencode-web.seen-sessions'

export function useRecentChatsSettings() {
  const settings = useState<RecentChatsSettings>('oc-recent-chats', () => ({ ...RECENT_CHATS_DEFAULTS }))
  const loaded = useState('oc-recent-chats-loaded', () => false)
  if (import.meta.client && !loaded.value) {
    loaded.value = true
    try {
      settings.value = { ...RECENT_CHATS_DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }
    } catch { /* defaults */ }
  }
  function save(next: Partial<RecentChatsSettings>) {
    settings.value = { ...settings.value, ...next }
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings.value)) } catch { /* full */ }
  }
  function reset() {
    save({ ...RECENT_CHATS_DEFAULTS })
  }
  return { settings, save, reset }
}

interface SeenStore {
  /** chats changed before this time count as read (first use of the feature) */
  since: number
  seen: Record<string, number>
}

export function useSeenSessions() {
  const store = useState<SeenStore>('oc-seen-sessions', () => ({ since: 0, seen: {} }))
  const loaded = useState('oc-seen-loaded', () => false)
  if (import.meta.client && !loaded.value) {
    loaded.value = true
    try {
      const saved = JSON.parse(localStorage.getItem(SEEN_KEY) || 'null') as SeenStore | null
      store.value = saved?.since ? saved : { since: Date.now(), seen: {} }
      if (!saved?.since) localStorage.setItem(SEEN_KEY, JSON.stringify(store.value))
    } catch { /* private mode: nothing is unread */ }
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  function persist() {
    clearTimeout(timer)
    timer = setTimeout(() => {
      // keep the newest 500 marks
      const entries = Object.entries(store.value.seen).sort((a, b) => b[1] - a[1]).slice(0, 500)
      store.value = { ...store.value, seen: Object.fromEntries(entries) }
      try { localStorage.setItem(SEEN_KEY, JSON.stringify(store.value)) } catch { /* full */ }
    }, 300)
  }

  function markSeen(id: string, at = Date.now()) {
    if ((store.value.seen[id] || 0) >= at) return
    store.value = { ...store.value, seen: { ...store.value.seen, [id]: at } }
    persist()
  }

  function isUnread(s: SessionInfo) {
    const updated = s.time?.updated || s.time?.created || 0
    if (!store.value.since || updated <= store.value.since) return false
    return updated > (store.value.seen[s.id] || 0) + 1000
  }

  return { markSeen, isUnread }
}
