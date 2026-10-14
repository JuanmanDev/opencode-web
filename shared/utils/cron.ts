// Minimal 5-field cron (minute hour day-of-month month day-of-week), evaluated
// in the server's local time. Supports `*`, lists, ranges, steps (`*/15`,
// `1-5/2`), names (`mon`, `jan`) and the shorthands @hourly, @daily, @weekly,
// @monthly, @yearly. Shared by the scheduler and the schedule editor.

export interface CronSpec {
  minute: Set<number>
  hour: Set<number>
  day: Set<number>
  month: Set<number>
  weekday: Set<number>
  /** standard cron: when both day fields are restricted, either one matches */
  dayRestricted: boolean
  weekdayRestricted: boolean
}

const SHORTHANDS: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *'
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

function parseValue(raw: string, min: number, names?: string[], nameOffset = 0) {
  const lower = raw.toLowerCase()
  const named = names?.indexOf(lower) ?? -1
  if (named >= 0) return named + nameOffset
  if (!/^\d+$/.test(raw)) throw new Error(`invalid value "${raw}"`)
  const n = Number(raw)
  if (n < min) throw new Error(`value ${n} below ${min}`)
  return n
}

function parseField(field: string, min: number, max: number, names?: string[], nameOffset = 0) {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    const [range, stepRaw] = part.split('/')
    const step = stepRaw === undefined ? 1 : Number(stepRaw)
    if (!Number.isInteger(step) || step < 1) throw new Error(`invalid step in "${part}"`)
    let lo = min
    let hi = max
    if (range !== '*') {
      const [a, b] = range!.split('-')
      lo = parseValue(a!, min, names, nameOffset)
      hi = b === undefined ? (stepRaw === undefined ? lo : max) : parseValue(b, min, names, nameOffset)
    }
    if (lo > hi || hi > max) throw new Error(`out of range "${part}" (${min}-${max})`)
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out
}

/** Parse a cron expression; throws with a readable reason. */
export function parseCron(expression: string): CronSpec {
  const expr = SHORTHANDS[expression.trim().toLowerCase()] || expression.trim()
  const fields = expr.split(/\s+/)
  if (fields.length !== 5) throw new Error('expected 5 fields: minute hour day month weekday')
  const [m, h, dom, mon, dow] = fields as [string, string, string, string, string]
  const weekday = parseField(dow, 0, 7, DAYS)
  // 7 is Sunday too
  if (weekday.has(7)) { weekday.delete(7); weekday.add(0) }
  return {
    minute: parseField(m, 0, 59),
    hour: parseField(h, 0, 23),
    day: parseField(dom, 1, 31),
    month: parseField(mon, 1, 12, MONTHS, 1),
    weekday,
    dayRestricted: dom !== '*',
    weekdayRestricted: dow !== '*'
  }
}

/** Is the expression valid? Returns the error message, or undefined. */
export function cronError(expression: string): string | undefined {
  try {
    parseCron(expression)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function dayMatches(spec: CronSpec, d: Date) {
  const dom = spec.day.has(d.getDate())
  const dow = spec.weekday.has(d.getDay())
  if (spec.dayRestricted && spec.weekdayRestricted) return dom || dow
  if (spec.dayRestricted) return dom
  if (spec.weekdayRestricted) return dow
  return true
}

/** First matching minute strictly after `after` (local time), or undefined within ~5 years. */
export function nextCronRun(expression: string | CronSpec, after: Date | number = Date.now()): Date | undefined {
  const spec = typeof expression === 'string' ? parseCron(expression) : expression
  const d = new Date(typeof after === 'number' ? after : after.getTime())
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)
  const limit = d.getTime() + 5 * 366 * 24 * 3600 * 1000
  while (d.getTime() < limit) {
    if (!spec.month.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1)
      d.setHours(0, 0, 0, 0)
      continue
    }
    if (!dayMatches(spec, d)) {
      d.setDate(d.getDate() + 1)
      d.setHours(0, 0, 0, 0)
      continue
    }
    if (!spec.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0)
      continue
    }
    if (!spec.minute.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0)
      continue
    }
    return d
  }
  return undefined
}

/** Short human description for common shapes; falls back to the expression. */
export function describeCron(expression: string): string {
  const expr = SHORTHANDS[expression.trim().toLowerCase()] || expression.trim()
  const pad = (n: string) => n.padStart(2, '0')
  const f = expr.split(/\s+/)
  if (f.length !== 5) return expression
  const [m, h, dom, mon, dow] = f as [string, string, string, string, string]
  const every = /^\*\/(\d+)$/
  if (m === '*' && h === '*' && dom === '*' && mon === '*' && dow === '*') return 'every minute'
  if (every.test(m) && h === '*' && dom === '*' && mon === '*' && dow === '*') return `every ${every.exec(m)![1]} minutes`
  if (/^\d+$/.test(m) && h === '*' && dom === '*' && mon === '*' && dow === '*') return `every hour at :${pad(m)}`
  if (/^\d+$/.test(m) && every.test(h) && dom === '*' && mon === '*' && dow === '*') return `every ${every.exec(h)![1]} hours at :${pad(m)}`
  if (/^\d+$/.test(m) && /^\d+$/.test(h) && mon === '*') {
    const time = `${pad(h)}:${pad(m)}`
    if (dom === '*' && dow === '*') return `daily at ${time}`
    if (dom === '*' && dow === '1-5') return `weekdays at ${time}`
    if (dom === '*' && /^[0-7](,[0-7])*$/.test(dow)) {
      const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
      return `${dow.split(',').map((d) => names[Number(d)]).join(', ')} at ${time}`
    }
    if (/^\d+$/.test(dom) && dow === '*') return `monthly on day ${dom} at ${time}`
  }
  return expression
}
