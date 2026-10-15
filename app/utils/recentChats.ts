// Which chats the projects panel lists under each project: starred ones, then
// "recent" ones (used within a window, unread ones a bit longer, running ones
// always), capped and expandable. Pure so it can be unit-tested.
import type { SessionInfo } from '#shared/types/opencode'

export interface RecentChatsSettings {
  /** chats used within this many hours count as recent */
  recentHours: number
  /** at most this many recent chats per project (collapsed) */
  maxRecent: number
  /** unread chats stay listed this many days */
  unreadDays: number
  /** "Show more" lists up to this many chats */
  expandMax: number
  /** starred chats shown first (0 = none) */
  starredMax: number
  /** running chats are always listed */
  showBusy: boolean
  /** subagent sessions too (normally only top-level conversations) */
  includeSubagents: boolean
  /** projects whose chats are loaded (most recent first) */
  maxProjects: number
  /** time of the last activity next to each chat */
  showTime: boolean
}

export const RECENT_CHATS_DEFAULTS: RecentChatsSettings = {
  recentHours: 24,
  maxRecent: 5,
  unreadDays: 3,
  expandMax: 20,
  starredMax: 3,
  showBusy: true,
  includeSubagents: false,
  maxProjects: 8,
  showTime: true
}

export interface ChatPick {
  session: SessionInfo
  starred: boolean
  unread: boolean
  busy: boolean
}

export interface ChatPicks {
  starred: ChatPick[]
  recent: ChatPick[]
  /** chats "Show more" would add (up to expandMax) */
  more: ChatPick[]
}

const updatedAt = (s: SessionInfo) => s.time?.updated || s.time?.created || 0

export function pickRecentChats(
  sessions: SessionInfo[],
  opts: {
    settings: RecentChatsSettings
    favorites: string[]
    isUnread: (s: SessionInfo) => boolean
    busy: Record<string, boolean>
    now?: number
  }
): ChatPicks {
  const { settings, favorites, isUnread, busy } = opts
  const now = opts.now ?? Date.now()
  const pick = (s: SessionInfo): ChatPick => ({ session: s, starred: favorites.includes(s.id), unread: isUnread(s), busy: Boolean(busy[s.id]) })
  const all = sessions
    .filter((s) => settings.includeSubagents || !s.parentID)
    .sort((a, b) => updatedAt(b) - updatedAt(a))
    .map(pick)

  const starred = all.filter((c) => c.starred).slice(0, Math.max(0, settings.starredMax))
  const taken = new Set(starred.map((c) => c.session.id))
  const recentCut = now - settings.recentHours * 3600_000
  const unreadCut = now - settings.unreadDays * 86400_000
  const candidates = all.filter((c) => !taken.has(c.session.id))
  const qualifies = (c: ChatPick) =>
    (settings.showBusy && c.busy) ||
    updatedAt(c.session) >= recentCut ||
    (c.unread && updatedAt(c.session) >= unreadCut)
  // running chats first, then unread, then by last use; capped
  const recent = candidates
    .filter(qualifies)
    .sort((a, b) => Number(b.busy) - Number(a.busy) || Number(b.unread) - Number(a.unread) || updatedAt(b.session) - updatedAt(a.session))
    .slice(0, Math.max(0, settings.maxRecent))
  recent.forEach((c) => taken.add(c.session.id))
  const room = Math.max(0, settings.expandMax - starred.length - recent.length)
  const more = candidates.filter((c) => !taken.has(c.session.id)).slice(0, room)
  return { starred, recent, more }
}

/** "5m", "3h", "2d", or a date for older ones. */
export function shortAge(ts: number, now = Date.now()) {
  if (!ts) return ''
  const diff = Math.max(0, now - ts)
  if (diff < 60_000) return 'now'
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m`
  if (diff < 86400_000) return `${Math.round(diff / 3600_000)}h`
  if (diff < 7 * 86400_000) return `${Math.round(diff / 86400_000)}d`
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' })
}
