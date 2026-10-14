import { describe, expect, it } from 'vitest'
import { cronError, describeCron, nextCronRun, parseCron } from '#shared/utils/cron'

// local time on purpose: the scheduler evaluates cron in the server's zone
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()

describe('cron', () => {
  it('parses fields, ranges, steps, lists and names', () => {
    const spec = parseCron('*/15 9-17 * jan,jun mon-fri')
    expect([...spec.minute]).toEqual([0, 15, 30, 45])
    expect([...spec.hour]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17])
    expect([...spec.month]).toEqual([1, 6])
    expect([...spec.weekday]).toEqual([1, 2, 3, 4, 5])
    expect([...parseCron('0 0 * * 7').weekday]).toEqual([0])
  })

  it('rejects malformed expressions with a reason', () => {
    expect(cronError('* * *')).toMatch(/5 fields/)
    expect(cronError('61 * * * *')).toMatch(/range/)
    expect(cronError('*/0 * * * *')).toMatch(/step/)
    expect(cronError('x * * * *')).toMatch(/invalid/)
    expect(cronError('@daily')).toBeUndefined()
  })

  it('finds the next run strictly after a time', () => {
    expect(nextCronRun('0 9 * * *', at(2026, 10, 14, 8, 30))?.getTime()).toBe(at(2026, 10, 14, 9, 0))
    expect(nextCronRun('0 9 * * *', at(2026, 10, 14, 9, 0))?.getTime()).toBe(at(2026, 10, 15, 9, 0))
    expect(nextCronRun('*/20 * * * *', at(2026, 10, 14, 9, 41))?.getTime()).toBe(at(2026, 10, 14, 10, 0))
    // 2026-10-17 is a Saturday: weekdays skip to Monday the 19th
    expect(nextCronRun('30 8 * * 1-5', at(2026, 10, 16, 9, 0))?.getTime()).toBe(at(2026, 10, 19, 8, 30))
    expect(nextCronRun('@monthly', at(2026, 10, 14))?.getTime()).toBe(at(2026, 11, 1, 0, 0))
    expect(nextCronRun('0 0 29 2 *', at(2026, 3, 1))?.getTime()).toBe(at(2028, 2, 29, 0, 0))
  })

  it('day-of-month and weekday restrictions combine with OR, like cron', () => {
    // the 1st of the month or any Sunday
    const next = nextCronRun('0 12 1 * 0', at(2026, 10, 14))!
    expect(next.getTime()).toBe(at(2026, 10, 18, 12, 0))
  })

  it('describes common shapes', () => {
    expect(describeCron('*/5 * * * *')).toBe('every 5 minutes')
    expect(describeCron('0 9 * * 1-5')).toBe('weekdays at 09:00')
    expect(describeCron('@daily')).toBe('daily at 00:00')
    expect(describeCron('15 8 * * 1,3')).toBe('Mon, Wed at 08:15')
    expect(describeCron('7 3 2-4 * *')).toBe('7 3 2-4 * *')
  })
})
