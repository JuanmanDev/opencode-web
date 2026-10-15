// Usage & cost: turn opencode messages into compact per-reply rows and the
// providers list into a list-price table. Pure helpers (no Nitro globals) so
// they unit-test directly; the endpoint is server/api/v1/usage.get.ts.

export interface UsageTokens {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

/** One assistant reply: who/when/which model, what opencode charged, the tokens. */
export interface UsageRow {
  sessionID: string
  /** set when the reply belongs to a subagent session */
  parentID?: string
  title?: string
  parentTitle?: string
  time: number
  completed?: number
  providerID: string
  modelID: string
  agent?: string
  cost: number
  tokens: UsageTokens
}

/** List price in USD per million tokens. */
export interface ModelPrice {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface UsageSession {
  id: string
  title?: string
  parentID?: string
}

type Loose = Record<string, any>

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function tokensOf(t: Loose | undefined): UsageTokens {
  return {
    input: num(t?.input),
    output: num(t?.output),
    reasoning: num(t?.reasoning),
    cacheRead: num(t?.cache?.read),
    cacheWrite: num(t?.cache?.write)
  }
}

/**
 * Rows for every assistant message of one session. Older servers keep the
 * tokens (and sometimes the cost) only on `step-finish` parts: those are
 * summed when the message itself has none.
 */
export function usageRowsFromMessages(session: UsageSession, messages: unknown): UsageRow[] {
  if (!Array.isArray(messages)) return []
  const rows: UsageRow[] = []
  for (const m of messages as Loose[]) {
    const info = m?.info as Loose | undefined
    if (!info || info.role !== 'assistant') continue
    let tokens = info.tokens ? tokensOf(info.tokens) : undefined
    let cost = num(info.cost)
    if (!tokens || cost === 0) {
      const steps = (Array.isArray(m.parts) ? m.parts : []).filter((p: Loose) => p?.type === 'step-finish')
      if (!tokens) {
        tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
        for (const p of steps) {
          const t = tokensOf(p.tokens)
          tokens.input += t.input
          tokens.output += t.output
          tokens.reasoning += t.reasoning
          tokens.cacheRead += t.cacheRead
          tokens.cacheWrite += t.cacheWrite
        }
      }
      if (cost === 0) cost = steps.reduce((n: number, p: Loose) => n + num(p.cost), 0)
    }
    const row: UsageRow = {
      sessionID: session.id,
      title: session.title,
      time: num(info.time?.created) || num(info.time?.completed),
      providerID: String(info.providerID || 'unknown'),
      modelID: String(info.modelID || 'unknown'),
      cost,
      tokens
    }
    if (session.parentID) row.parentID = session.parentID
    if (info.time?.completed) row.completed = num(info.time.completed)
    const agent = info.agent || info.mode
    if (agent) row.agent = String(agent)
    rows.push(row)
  }
  return rows
}

/**
 * `{ "provider/model": price }` from /config/providers. Prices come from
 * models.dev as `cost: { input, output, cache: { read, write } }` (newer) or
 * `cost: { input, output, cache_read, cache_write }` (older). Models without a
 * `cost` object are left out (unknown price); all-zero prices stay (free).
 */
export function priceTable(providers: unknown): Record<string, ModelPrice> {
  const list = Array.isArray(providers)
    ? providers
    : (providers as Loose)?.providers ?? (providers as Loose)?.all ?? []
  const out: Record<string, ModelPrice> = {}
  for (const p of Array.isArray(list) ? list as Loose[] : []) {
    if (!p?.id || !p.models || typeof p.models !== 'object') continue
    for (const [key, model] of Object.entries(p.models as Record<string, Loose>)) {
      const c = model?.cost
      if (!c || typeof c !== 'object') continue
      out[`${p.id}/${model.id || key}`] = {
        input: num(c.input),
        output: num(c.output),
        cacheRead: num(c.cache?.read ?? c.cache_read),
        cacheWrite: num(c.cache?.write ?? c.cache_write)
      }
    }
  }
  return out
}

/** The same tokens at list price (reasoning billed as output, like opencode does). */
export function estimateCost(tokens: UsageTokens, price: ModelPrice) {
  return (
    tokens.input * price.input
    + (tokens.output + tokens.reasoning) * price.output
    + tokens.cacheRead * price.cacheRead
    + tokens.cacheWrite * price.cacheWrite
  ) / 1_000_000
}

/** `fn` over `items`, at most `limit` running at once; results keep the input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/** Small LRU of per-session rows, valid while the session's `time.updated` is unchanged. */
export class UsageRowCache {
  private map = new Map<string, { updated: number; rows: UsageRow[] }>()
  constructor(private max = 2000) {}

  get(key: string, updated: number) {
    const hit = this.map.get(key)
    if (!hit || hit.updated !== updated) return undefined
    this.map.delete(key) // refresh recency
    this.map.set(key, hit)
    return hit.rows
  }

  set(key: string, updated: number, rows: UsageRow[]) {
    this.map.delete(key)
    this.map.set(key, { updated, rows })
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!)
  }

  get size() {
    return this.map.size
  }
}
