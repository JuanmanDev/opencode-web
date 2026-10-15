import { describe, expect, it } from 'vitest'
import { RECENT_CHATS_DEFAULTS, pickRecentChats, shortAge } from '../../app/utils/recentChats'

const NOW = Date.UTC(2026, 9, 15, 12)
const H = 3600_000
const chat = (id: string, hoursAgo: number, extra: Record<string, unknown> = {}) =>
  ({ id, title: id, time: { created: NOW - hoursAgo * H, updated: NOW - hoursAgo * H }, ...extra })

const sessions = [
  chat('fresh1', 1), chat('fresh2', 2), chat('fresh3', 3), chat('fresh4', 5), chat('fresh5', 8), chat('fresh6', 20),
  chat('unread-2d', 48), chat('unread-5d', 120), chat('old-running', 200), chat('old', 300), chat('starred-old', 400),
  chat('sub', 1, { parentID: 'fresh1' })
]
const unread = new Set(['unread-2d', 'unread-5d'])
const pick = (settings = {}) => pickRecentChats(sessions, {
  settings: { ...RECENT_CHATS_DEFAULTS, ...settings },
  favorites: ['starred-old'],
  isUnread: (s) => unread.has(s.id),
  busy: { 'old-running': true },
  now: NOW
})
const ids = (list: Array<{ session: { id: string } }>) => list.map((c) => c.session.id)

describe('recent chats in the projects panel', () => {
  it('lists starred, then running, unread and recent chats, capped', () => {
    const p = pick()
    expect(ids(p.starred)).toEqual(['starred-old'])
    // running first, then unread within 3 days, then the newest within 24h
    expect(ids(p.recent)).toEqual(['old-running', 'unread-2d', 'fresh1', 'fresh2', 'fresh3'])
    expect(ids(p.more)).toContain('fresh4')
    expect(ids(p.more)).not.toContain('sub')
    expect(p.starred.length + p.recent.length + p.more.length).toBeLessThanOrEqual(RECENT_CHATS_DEFAULTS.expandMax)
  })

  it('follows the settings', () => {
    const p = pick({ maxRecent: 10, showBusy: false, unreadDays: 7, starredMax: 0, includeSubagents: true, expandMax: 12 })
    expect(p.starred).toEqual([])
    expect(ids(p.recent)).toEqual(['unread-2d', 'unread-5d', 'fresh1', 'sub', 'fresh2', 'fresh3', 'fresh4', 'fresh5', 'fresh6'])
    expect(p.recent.length + p.more.length).toBe(12)
  })

  it('formats short ages', () => {
    expect(shortAge(NOW - 30_000, NOW)).toBe('now')
    expect(shortAge(NOW - 5 * 60_000, NOW)).toBe('5m')
    expect(shortAge(NOW - 3 * H, NOW)).toBe('3h')
    expect(shortAge(NOW - 50 * H, NOW)).toBe('2d')
  })
})
