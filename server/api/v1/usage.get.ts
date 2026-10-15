// Usage & cost over a time window: one compact row per assistant reply (real
// cost as opencode recorded it + tokens) and the models' list prices, so the
// page can group any way it likes and estimate the no-promotion cost.
// Messages are cached per session until its `time.updated` changes.
import type { UsageRow, UsageSession } from '../../utils/usage'
import { UsageRowCache, mapLimit, priceTable, usageRowsFromMessages } from '../../utils/usage'

interface SessionLite extends UsageSession {
  time?: { created?: number; updated?: number }
}

const cache = new UsageRowCache(2000)

export default defineEventHandler(async (event) => {
  requireApiToken(event)
  const query = getQuery(event) as { directory?: string; days?: string }
  const directory = query.directory
  if (!directory) throw createError({ statusCode: 400, statusMessage: 'directory is required' })
  const days = Math.min(365, Math.max(1, Math.round(Number(query.days) || 30)))
  const since = Date.now() - days * 86400_000

  const [sessions, providers] = await Promise.all([
    opencodeFetch<SessionLite[]>('/session', { query: { directory } }),
    opencodeFetch('/config/providers', { query: { directory } }).catch(() => null)
  ])
  const all = (Array.isArray(sessions) ? sessions : []).filter((s) => s?.id)
  const inWindow = all.filter((s) => (s.time?.updated ?? s.time?.created ?? 0) >= since)
  const titles = new Map(all.map((s) => [s.id, s.title]))

  const perSession = await mapLimit(inWindow, 6, async (s) => {
    const updated = s.time?.updated ?? 0
    const key = `${directory}\n${s.id}`
    const hit = cache.get(key, updated)
    if (hit) return hit
    try {
      const messages = await opencodeFetch(`/session/${encodeURIComponent(s.id)}/message`, {
        query: { directory },
        timeoutMs: 20000
      })
      const rows = usageRowsFromMessages(s, messages)
      cache.set(key, updated, rows)
      return rows
    } catch {
      return [] as UsageRow[] // one unreadable session shouldn't sink the page; not cached
    }
  })

  const rows: UsageRow[] = []
  for (const list of perSession) {
    for (const r of list) {
      if (!r.time || r.time < since) continue
      // titles change (auto-titling), so take them from the fresh session list
      const row = { ...r, title: titles.get(r.sessionID) ?? r.title }
      if (r.parentID) row.parentTitle = titles.get(r.parentID)
      rows.push(row)
    }
  }
  rows.sort((a, b) => a.time - b.time)

  return { generatedAt: Date.now(), days, rows, prices: providers ? priceTable(providers) : {} }
})
