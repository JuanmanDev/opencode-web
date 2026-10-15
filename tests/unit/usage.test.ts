import { describe, expect, it } from 'vitest'
import { UsageRowCache, estimateCost, mapLimit, priceTable, usageRowsFromMessages } from '../../server/utils/usage'

describe('usageRowsFromMessages', () => {
  it('keeps assistant replies with their model, agent, cost and tokens', () => {
    const rows = usageRowsFromMessages({ id: 'ses_child', title: 'Explore', parentID: 'ses_1' }, [
      { info: { id: 'm1', role: 'user', time: { created: 1 } }, parts: [] },
      {
        info: {
          id: 'm2', role: 'assistant', time: { created: 2, completed: 5 }, providerID: 'anthropic', modelID: 'claude-x',
          mode: 'build', cost: 0.25, tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 1000, write: 50 } }
        },
        parts: [{ type: 'step-finish', cost: 9, tokens: { input: 9 } }]
      }
    ])
    expect(rows).toEqual([{
      sessionID: 'ses_child', parentID: 'ses_1', title: 'Explore', time: 2, completed: 5,
      providerID: 'anthropic', modelID: 'claude-x', agent: 'build', cost: 0.25,
      tokens: { input: 100, output: 20, reasoning: 5, cacheRead: 1000, cacheWrite: 50 }
    }])
  })

  it('sums step-finish parts when the message has no tokens or cost (older servers)', () => {
    const [row] = usageRowsFromMessages({ id: 's' }, [{
      info: { id: 'm', role: 'assistant', time: { created: 3 }, providerID: 'p', modelID: 'm', agent: 'plan' },
      parts: [
        { type: 'step-start' },
        { type: 'step-finish', cost: 0.1, tokens: { input: 10, output: 2, cache: { read: 4 } } },
        { type: 'step-finish', cost: 0.2, tokens: { input: 5, output: 1, reasoning: 3 } }
      ]
    }])
    expect(row!.cost).toBeCloseTo(0.3)
    expect(row!.tokens).toEqual({ input: 15, output: 3, reasoning: 3, cacheRead: 4, cacheWrite: 0 })
    expect(row!.agent).toBe('plan')
    expect(row!.parentID).toBeUndefined()
  })

  it('tolerates junk', () => {
    expect(usageRowsFromMessages({ id: 's' }, null)).toEqual([])
    expect(usageRowsFromMessages({ id: 's' }, [null, {}, { info: { role: 'assistant' } }])).toHaveLength(1)
  })
})

describe('priceTable', () => {
  it('reads both cost shapes and skips models without a price', () => {
    const table = priceTable({
      providers: [
        { id: 'anthropic', models: { a: { id: 'a', cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } } } } },
        { id: 'old', models: { b: { cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1.25 } }, c: { name: 'no price' } } },
        { id: 'free', models: { z: { id: 'z', cost: { input: 0, output: 0 } } } }
      ]
    })
    expect(table).toEqual({
      'anthropic/a': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      'old/b': { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
      'free/z': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    })
    expect(priceTable(null)).toEqual({})
  })
})

describe('estimateCost', () => {
  it('prices per million tokens, reasoning at the output rate', () => {
    const cost = estimateCost(
      { input: 1_000_000, output: 100_000, reasoning: 100_000, cacheRead: 2_000_000, cacheWrite: 0 },
      { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
    )
    expect(cost).toBeCloseTo(3 + 3 + 0.6)
  })
})

describe('mapLimit', () => {
  it('keeps order and never runs more than the limit at once', async () => {
    let running = 0
    let peak = 0
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 5 * (8 - n)))
      running--
      return n * 2
    })
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14])
    expect(peak).toBe(3)
  })
})

describe('UsageRowCache', () => {
  it('hits only while updated matches and evicts the least recently used', () => {
    const cache = new UsageRowCache(2)
    cache.set('a', 1, [])
    cache.set('b', 1, [])
    expect(cache.get('a', 2)).toBeUndefined()
    expect(cache.get('a', 1)).toEqual([])
    cache.set('c', 1, [])
    expect(cache.size).toBe(2)
    expect(cache.get('b', 1)).toBeUndefined()
    expect(cache.get('a', 1)).toEqual([])
  })
})
