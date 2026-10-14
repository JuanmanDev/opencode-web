// Scheduled prompts: "every weekday at 08:00, ask the agent in /projects/app
// to triage new issues". opencode has no scheduler of its own, so this app
// keeps the schedules (data storage) and fires them from a 20 s ticker
// (plugins/scheduler.ts) in the server's local time (set TZ on the container).
//
// A run sends the prompt to a fresh session or keeps reusing one, waits for
// the reply in the background and records the outcome. Missed runs while the
// app was down are not replayed: the next run is computed from "now".

import { randomUUID } from 'node:crypto'
import { cronError, describeCron, nextCronRun } from '#shared/utils/cron'

export interface ScheduleRun {
  id: string
  at: number
  trigger: 'schedule' | 'manual'
  status: 'running' | 'ok' | 'error' | 'skipped'
  sessionID?: string
  error?: string
  /** first characters of the reply */
  reply?: string
  durationMs?: number
}

export interface Schedule {
  id: string
  name: string
  directory: string
  prompt: string
  /** 5-field cron or @hourly/@daily/@weekly/@monthly */
  cron: string
  /** 'new': a session per run; 'reuse': keep talking in one session */
  session: 'new' | 'reuse'
  sessionID?: string
  /** "provider/model"; empty = opencode's default */
  model?: string
  agent?: string
  variant?: string
  enabled: boolean
  createdAt: number
  updatedAt: number
  nextRunAt?: number
  runs: ScheduleRun[]
}

export type ScheduleInput = Partial<Pick<Schedule,
  'name' | 'directory' | 'prompt' | 'cron' | 'session' | 'sessionID' | 'model' | 'agent' | 'variant' | 'enabled'>>

const KEY = 'schedules.json'
const MAX_RUNS = 20
const MAX_SCHEDULES = 200

let cache: Schedule[] | undefined
let writing: Promise<unknown> = Promise.resolve()
const inFlight = new Set<string>()

async function load(): Promise<Schedule[]> {
  if (!cache) {
    const stored = await useStorage('data').getItem<Schedule[]>(KEY).catch(() => null)
    cache = Array.isArray(stored) ? stored : []
    // runs that were in flight when the app stopped never finished
    for (const s of cache) {
      for (const run of s.runs || []) {
        if (run.status === 'running') {
          run.status = 'error'
          run.error = 'interrupted: the web app restarted during the run'
        }
      }
      s.runs ||= []
    }
  }
  return cache
}

function persist() {
  const snapshot = JSON.parse(JSON.stringify(cache || []))
  writing = writing.then(() => useStorage('data').setItem(KEY, snapshot)).catch((error) => {
    console.warn(`[scheduler] could not save schedules: ${error instanceof Error ? error.message : error}`)
  })
  return writing
}

/** What the API returns: the schedule plus a readable cadence. */
export function presentSchedule(s: Schedule) {
  return { ...s, description: describeCron(s.cron), running: inFlight.has(s.id) }
}

export async function listSchedules(directory?: string) {
  const all = await load()
  return all.filter((s) => !directory || s.directory === directory)
}

export async function getSchedule(id: string) {
  return (await load()).find((s) => s.id === id)
}

function validate(input: ScheduleInput, partial: boolean) {
  const need = (key: keyof ScheduleInput) => !partial || key in input
  if (need('name') && !String(input.name || '').trim()) return 'name is required'
  if (need('directory') && !String(input.directory || '').trim()) return 'directory is required'
  if (need('prompt') && !String(input.prompt || '').trim()) return 'prompt is required'
  if (need('cron')) {
    const error = cronError(String(input.cron || ''))
    if (error) return `cron: ${error}`
  }
  if (input.session && !['new', 'reuse'].includes(input.session)) return 'session must be "new" or "reuse"'
  if (input.model && !/^[^/\s]+\/\S+$/.test(input.model)) return 'model must be "provider/model"'
  return undefined
}

function badRequest(message: string) {
  return createError({ statusCode: 400, message })
}

export async function createSchedule(input: ScheduleInput) {
  const invalid = validate(input, false)
  if (invalid) throw badRequest(invalid)
  const all = await load()
  if (all.length >= MAX_SCHEDULES) throw badRequest(`at most ${MAX_SCHEDULES} schedules`)
  const now = Date.now()
  const schedule: Schedule = {
    id: `sch_${randomUUID().slice(0, 12)}`,
    name: String(input.name).trim().slice(0, 120),
    directory: String(input.directory).trim(),
    prompt: String(input.prompt).slice(0, 20000),
    cron: String(input.cron).trim(),
    session: input.session === 'reuse' ? 'reuse' : 'new',
    ...(input.sessionID ? { sessionID: input.sessionID } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.agent ? { agent: input.agent } : {}),
    ...(input.variant ? { variant: input.variant } : {}),
    enabled: input.enabled !== false,
    createdAt: now,
    updatedAt: now,
    runs: []
  }
  schedule.nextRunAt = nextCronRun(schedule.cron, now)?.getTime()
  all.push(schedule)
  await persist()
  return schedule
}

export async function updateSchedule(id: string, input: ScheduleInput) {
  const invalid = validate(input, true)
  if (invalid) throw badRequest(invalid)
  const schedule = await getSchedule(id)
  if (!schedule) throw createError({ statusCode: 404, message: `No schedule ${id}` })
  for (const key of ['name', 'directory', 'prompt', 'cron', 'session', 'model', 'agent', 'variant'] as const) {
    if (key in input) {
      const value = input[key]
      if (value === '' || value === null || value === undefined) {
        if (key === 'model' || key === 'agent' || key === 'variant') delete schedule[key]
      } else {
        (schedule as unknown as Record<string, unknown>)[key] = typeof value === 'string' ? value.trim() : value
      }
    }
  }
  if ('sessionID' in input) {
    if (input.sessionID) schedule.sessionID = input.sessionID
    else delete schedule.sessionID
  }
  if ('enabled' in input) schedule.enabled = input.enabled !== false
  schedule.updatedAt = Date.now()
  schedule.nextRunAt = nextCronRun(schedule.cron, Date.now())?.getTime()
  await persist()
  return schedule
}

export async function deleteSchedule(id: string) {
  const all = await load()
  const index = all.findIndex((s) => s.id === id)
  if (index < 0) throw createError({ statusCode: 404, message: `No schedule ${id}` })
  all.splice(index, 1)
  await persist()
  return true
}

function parseModel(model?: string) {
  if (!model) return undefined
  const [providerID, ...rest] = model.split('/')
  return providerID && rest.length ? { providerID, modelID: rest.join('/') } : undefined
}

async function sessionBusy(directory: string, sessionID: string) {
  const status = await opencodeFetch<Record<string, { type?: string }>>('/session/status', {
    query: { directory },
    timeoutMs: 10000
  }).catch(() => ({} as Record<string, { type?: string }>))
  const type = status[sessionID]?.type
  return type === 'busy' || type === 'retry'
}

function record(schedule: Schedule, run: ScheduleRun) {
  schedule.runs = [run, ...schedule.runs.filter((r) => r.id !== run.id)].slice(0, MAX_RUNS)
}

/**
 * Run a schedule now. Resolves once the prompt is admitted (session picked,
 * request sent) with the run record; the reply is awaited in the background.
 */
export async function runSchedule(id: string, trigger: ScheduleRun['trigger'] = 'manual'): Promise<ScheduleRun> {
  const schedule = await getSchedule(id)
  if (!schedule) throw createError({ statusCode: 404, message: `No schedule ${id}` })
  const run: ScheduleRun = { id: randomUUID().slice(0, 8), at: Date.now(), trigger, status: 'running' }

  if (inFlight.has(schedule.id)) {
    run.status = 'skipped'
    run.error = 'the previous run is still going'
    record(schedule, run)
    await persist()
    return run
  }

  inFlight.add(schedule.id)
  try {
    let sessionID = schedule.session === 'reuse' ? schedule.sessionID : undefined
    if (sessionID) {
      const exists = await opencodeFetch(`/session/${encodeURIComponent(sessionID)}`, {
        query: { directory: schedule.directory }, timeoutMs: 10000
      }).then(() => true, () => false)
      if (!exists) sessionID = undefined
      else if (await sessionBusy(schedule.directory, sessionID)) {
        run.status = 'skipped'
        run.error = 'the session is busy with another reply'
        run.sessionID = sessionID
        record(schedule, run)
        await persist()
        inFlight.delete(schedule.id)
        return run
      }
    }
    if (!sessionID) {
      const session = await opencodeFetch<{ id: string }>('/session', {
        method: 'POST',
        body: { title: `⏰ ${schedule.name}` },
        query: { directory: schedule.directory },
        timeoutMs: 20000
      })
      sessionID = session.id
      if (schedule.session === 'reuse') schedule.sessionID = sessionID
    }
    run.sessionID = sessionID
    record(schedule, run)
    await persist()
  } catch (error) {
    run.status = 'error'
    run.error = error instanceof Error ? error.message : String(error)
    record(schedule, run)
    inFlight.delete(schedule.id)
    await persist()
    return run
  }

  const started = Date.now()
  opencodeFetch<{ info?: { error?: { data?: { message?: string }; name?: string } }; parts?: Array<{ type: string; text?: string }> }>(
    `/session/${encodeURIComponent(run.sessionID!)}/message`,
    {
      method: 'POST',
      query: { directory: schedule.directory },
      timeoutMs: 1000 * 60 * 60,
      body: {
        model: parseModel(schedule.model),
        agent: schedule.agent,
        variant: schedule.variant,
        parts: [{ type: 'text', text: schedule.prompt }]
      }
    }
  ).then((reply) => {
    const failed = reply?.info?.error
    run.status = failed ? 'error' : 'ok'
    if (failed) run.error = failed.data?.message || failed.name || 'the agent reported an error'
    const text = (reply?.parts || []).filter((p) => p.type === 'text' && p.text).map((p) => p.text).join('\n\n')
    if (text) run.reply = text.slice(0, 600)
  }).catch((error) => {
    run.status = 'error'
    run.error = error instanceof Error ? error.message : String(error)
  }).finally(() => {
    run.durationMs = Date.now() - started
    inFlight.delete(schedule.id)
    record(schedule, run)
    persist()
  })

  return run
}

/** One scheduler pass: fire every enabled schedule whose time has come. */
export async function tickSchedules(now = Date.now()) {
  const all = await load()
  let changed = false
  for (const schedule of all) {
    if (!schedule.enabled) continue
    if (!schedule.nextRunAt) {
      schedule.nextRunAt = nextCronRun(schedule.cron, now)?.getTime()
      changed = true
      continue
    }
    if (schedule.nextRunAt > now) continue
    // a run many minutes late (app was down) is dropped, not replayed
    const late = now - schedule.nextRunAt > 5 * 60_000
    schedule.nextRunAt = nextCronRun(schedule.cron, now)?.getTime()
    changed = true
    if (!late) runSchedule(schedule.id, 'schedule').catch(() => {})
  }
  if (changed) await persist()
}

export async function schedulerStats() {
  const all = await load()
  return { total: all.length, enabled: all.filter((s) => s.enabled).length, running: inFlight.size }
}
