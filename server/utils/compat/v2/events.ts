// Event hub for opencode v2: ONE upstream `GET /api/event` stream per hub,
// fanned out to every browser `/event` subscriber in the legacy wire format
// (`data: {"id","type","properties"}`). v2 has a single unfiltered global
// stream, a bounded per-subscriber queue upstream (slow consumers are cut
// off) and no replay, so the hub reads it promptly, filters per project
// directory, projects `session.next.*` into legacy message/part events
// (projector.ts) and synthesizes busy/idle, which v2 does not publish:
// candidates from the stream, confirmed with GET /api/session/active.

import { normDir, toLegacySession } from './mappers'
import { busyTransitions, createMirrorProjector, createProjector } from './projector'
import type { LegacyEnvelope, LegacyEvent, ProjectorOptions, V2Event } from './projector'
import type { V2Client } from './types'

export interface V2EventHubDeps {
  client: V2Client
  /** Stored message for an assistant seen mid-turn, in legacy `{info, parts}` shape. */
  seed?: (sessionID: string, messageID: string) => Promise<{ info: any; parts: any[] } | null>
  /**
   * Legacy SessionInfo for `session.updated` (apply opencode-web meta such as
   * titles here). Default: GET /api/session/{id} + toLegacySession.
   */
  session?: (sessionID: string) => Promise<any | null>
  logger?: (msg: string) => void
  /** Timing knobs (tests); defaults follow the spec. */
  timing?: Partial<HubTiming>
}

export interface HubTiming {
  /** keep the upstream open this long after the last subscriber left */
  lingerMs: number
  /** first reconnect delay, doubled up to `backoffMaxMs` */
  backoffMs: number
  backoffMaxMs: number
  /** throttle for delta-driven part updates */
  throttleMs: number
  /** idle candidate -> first /api/session/active check, then the retries */
  idleDelaysMs: number[]
  /** safety poll of /api/session/active while anything is busy */
  pollMs: number
  /** coalescing window for session.updated refreshes */
  sessionRefreshMs: number
  /** no byte from upstream for this long: assume a dead socket and reconnect */
  staleMs: number
  /** projector state of sessions idle this long is dropped */
  evictMs: number
}

const DEFAULT_TIMING: HubTiming = {
  lingerMs: 30_000,
  backoffMs: 500,
  backoffMaxMs: 15_000,
  throttleMs: 50,
  idleDelaysMs: [300, 1000, 2000, 4000],
  pollMs: 5000,
  sessionRefreshMs: 100,
  staleMs: 45_000,
  evictMs: 10 * 60_000
}

export interface V2EventHub {
  /**
   * Adds a downstream client; `send` receives complete SSE frames. Events of
   * other project directories are filtered out (`directory` empty: all).
   * Returns the unsubscribe function.
   */
  subscribe(directory: string | undefined, send: (frame: string) => void): () => void
  /** Number of downstream clients (diagnostics). */
  readonly size: number
  /** Closes the upstream now and forgets all state. */
  close(): void
}

/**
 * Incremental SSE parser: chunks may split lines anywhere, line endings may
 * be LF, CRLF or CR. `data` fires per event (multi-line data joined with \n),
 * `comment` per `:` line (`: heartbeat`).
 */
export function createSseParser(handlers: { data: (data: string) => void; comment?: (text: string) => void }) {
  let buffer = ''
  let data: string[] = []
  const eol = /\r\n|\r|\n/g

  function line(text: string) {
    if (text === '') {
      if (data.length) handlers.data(data.join('\n'))
      data = []
      return
    }
    if (text.startsWith(':')) {
      handlers.comment?.(text.slice(1))
      return
    }
    const colon = text.indexOf(':')
    const field = colon < 0 ? text : text.slice(0, colon)
    if (field !== 'data') return // event:, id:, retry: are not used by opencode
    const value = colon < 0 ? '' : text.slice(colon + 1)
    data.push(value.startsWith(' ') ? value.slice(1) : value)
  }

  return {
    push(chunk: string) {
      buffer += chunk
      let pos = 0
      eol.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = eol.exec(buffer))) {
        // a trailing CR may be the first half of a CRLF split across chunks
        if (match[0] === '\r' && match.index === buffer.length - 1) break
        line(buffer.slice(pos, match.index))
        pos = eol.lastIndex
      }
      buffer = buffer.slice(pos)
    },
    /** Drops a partial event (the stream ended mid-frame). */
    reset() {
      buffer = ''
      data = []
    }
  }
}

/** One downstream SSE frame. */
export function encodeFrame(id: string, event: { type: string; properties: Record<string, any> }) {
  return `data: ${JSON.stringify({ id, type: event.type, properties: event.properties })}\n\n`
}

interface Subscriber {
  /** normDir() form; empty: every project */
  directory: string
  send: (frame: string) => void
}

type Timer = ReturnType<typeof setTimeout>

function unref(timer: Timer) {
  (timer as { unref?: () => void }).unref?.()
  return timer
}

export function createV2EventHub(deps: V2EventHubDeps): V2EventHub {
  const timing: HubTiming = { ...DEFAULT_TIMING, ...deps.timing }
  const log = deps.logger ?? (() => {})
  const projector = createProjector({ throttleMs: timing.throttleMs })
  const lookupSession = deps.session ?? (async (sessionID: string) => {
    const res = await deps.client.request<{ data?: any }>(`/api/session/${encodeURIComponent(sessionID)}`, { timeoutMs: 10_000 })
    return res?.data ? toLegacySession(res.data) : null
  })

  const subscribers = new Set<Subscriber>()
  /** bumps on every stop: async work of an older upstream is discarded */
  let epoch = 0
  let running = false
  let connected = false
  let controller: AbortController | null = null
  let retry = 0
  let lastByte = 0
  let synthetic = 0
  let wake: (() => void) | null = null

  let lingerTimer: Timer | undefined
  let flushTimer: Timer | undefined
  let pollTimer: Timer | undefined
  let staleTimer: Timer | undefined
  let evictTimer: Timer | undefined

  /** sessions currently reported busy downstream */
  const busy = new Set<string>()
  /**
   * Busy signal / idle transition per session as [tick, ms]: an /active answer
   * requested before the latest signal is stale (same-millisecond safe).
   */
  let tick = 0
  const lastBusy = new Map<string, [number, number]>()
  const lastIdle = new Map<string, [number, number]>()
  const since = (map: Map<string, [number, number]>, sessionID: string) => map.get(sessionID)?.[0] ?? 0
  const checks = new Map<string, { timer?: Timer; gen: number }>()
  let checkGen = 0
  const refreshes = new Map<string, { timer?: Timer; fallback?: LegacyEvent }>()

  function nextId() {
    return `evt_ocw${(synthetic++).toString(36).padStart(6, '0')}`
  }

  // ---- downstream ----

  function deliver(sub: Subscriber, frame: string) {
    try {
      sub.send(frame)
    } catch {
      subscribers.delete(sub) // closed response
    }
  }

  function broadcast(event: LegacyEvent, id = nextId()) {
    if (!subscribers.size) return
    const frame = encodeFrame(id, event)
    const dir = normDir(event.directory)
    for (const sub of [...subscribers]) {
      if (!dir || !sub.directory || sub.directory === dir) deliver(sub, frame)
    }
  }

  function dispatch(events: LegacyEvent[], baseId?: string) {
    events.forEach((event, i) => {
      if (event.type === 'session.updated' && typeof event.properties.sessionID === 'string') {
        // always the server's current row (and meta titles): coalesce, fetch, emit
        refreshSession(event.properties.sessionID, event)
        return
      }
      broadcast(event, baseId ? (i === 0 ? baseId : `${baseId}.${i}`) : undefined)
    })
  }

  function directoryOf(sessionID: string) {
    return projector.directoryOf(sessionID)
  }

  function status(sessionID: string, type: 'busy' | 'idle') {
    broadcast({ type: 'session.status', properties: { sessionID, status: { type } }, directory: directoryOf(sessionID) })
  }

  // ---- session.updated ----

  function refreshSession(sessionID: string, fallback?: LegacyEvent) {
    const pending = refreshes.get(sessionID)
    if (pending) {
      if (fallback) pending.fallback = fallback
      return
    }
    const entry: { timer?: Timer; fallback?: LegacyEvent } = { fallback }
    refreshes.set(sessionID, entry)
    const at = epoch
    entry.timer = setTimeout(async () => {
      let info: any = null
      try {
        info = await lookupSession(sessionID)
      } catch (error) {
        log(`opencode v2: session ${sessionID} lookup failed: ${error instanceof Error ? error.message : error}`)
      }
      if (at !== epoch) return
      refreshes.delete(sessionID)
      const out = projector.seedSession(sessionID, info)
      if (out.length) for (const event of out) broadcast(event)
      else if (entry.fallback) broadcast(entry.fallback)
    }, timing.sessionRefreshMs)
  }

  // ---- busy / idle ----

  async function fetchActive(): Promise<Set<string> | undefined> {
    try {
      const res = await deps.client.request<{ data?: Record<string, unknown> }>('/api/session/active', { timeoutMs: 10_000 })
      return new Set(Object.keys(res?.data ?? {}))
    } catch (error) {
      log(`opencode v2: /api/session/active failed: ${error instanceof Error ? error.message : error}`)
      return undefined
    }
  }

  function markBusy(sessionID: string) {
    const check = checks.get(sessionID)
    if (check) {
      clearTimeout(check.timer)
      checks.delete(sessionID)
    }
    lastBusy.set(sessionID, [++tick, Date.now()])
    if (busy.has(sessionID)) return
    busy.add(sessionID)
    status(sessionID, 'busy')
    schedulePoll()
  }

  function markIdle(sessionID: string) {
    const check = checks.get(sessionID)
    if (check) {
      clearTimeout(check.timer)
      checks.delete(sessionID)
    }
    // a run that ended without a step event leaves its assistant open forever
    const settled = projector.settle(sessionID)
    for (const event of settled) broadcast(event)
    if (!busy.delete(sessionID)) return
    lastIdle.set(sessionID, [++tick, Date.now()])
    status(sessionID, 'idle')
    broadcast({ type: 'session.idle', properties: { sessionID }, directory: directoryOf(sessionID) })
  }

  /** Debounced /api/session/active confirmation of an idle candidate. */
  function checkIdle(sessionID: string) {
    const previous = checks.get(sessionID)
    if (previous) clearTimeout(previous.timer)
    const gen = ++checkGen
    const at = epoch
    const entry: { timer?: Timer; gen: number } = { gen }
    checks.set(sessionID, entry)
    const attempt = (i: number) => {
      entry.timer = setTimeout(async () => {
        const asked = tick
        const active = await fetchActive()
        if (at !== epoch || checks.get(sessionID)?.gen !== gen) return // superseded
        if (active && !active.has(sessionID) && since(lastBusy, sessionID) <= asked) {
          checks.delete(sessionID)
          markIdle(sessionID)
        } else if (i + 1 < timing.idleDelaysMs.length) {
          attempt(i + 1)
        } else {
          checks.delete(sessionID) // still running: the safety poll takes over
        }
      }, timing.idleDelaysMs[i])
    }
    attempt(0)
  }

  /** Aligns the busy map with /api/session/active (reconnect, safety poll). */
  async function reconcile() {
    const at = epoch
    const asked = tick
    const active = await fetchActive()
    if (!active || at !== epoch) return
    for (const sessionID of [...busy]) {
      if (active.has(sessionID) || checks.has(sessionID)) continue
      if (since(lastBusy, sessionID) > asked) continue
      markIdle(sessionID)
    }
    for (const sessionID of active) {
      if (busy.has(sessionID) || since(lastIdle, sessionID) > asked) continue
      markBusy(sessionID)
    }
  }

  function schedulePoll() {
    if (pollTimer || !running) return
    pollTimer = setTimeout(async () => {
      if (busy.size) await reconcile()
      pollTimer = undefined
      if (busy.size) schedulePoll()
    }, timing.pollMs)
  }

  // ---- upstream ----

  function onComment(text: string) {
    const frame = `:${text}\n\n`
    for (const sub of [...subscribers]) deliver(sub, frame)
  }

  function onData(raw: string) {
    let event: V2Event
    try {
      event = JSON.parse(raw)
    } catch {
      return
    }
    if (!event || typeof event.type !== 'string') return
    if (event.type === 'server.connected') {
      connected = true
      retry = 0
      broadcast({ type: 'server.connected', properties: {} }, event.id)
      void reconcile() // anything may have changed while disconnected
      return
    }
    dispatch(projector.push(event), event.id)
    for (const signal of busyTransitions(event)) {
      if (signal.status === 'busy') markBusy(signal.sessionID)
      else checkIdle(signal.sessionID)
    }
    drainRequests()
    scheduleFlush()
  }

  function drainRequests() {
    for (const req of projector.takeSeedRequests()) {
      if (!req.messageID) {
        refreshSession(req.sessionID)
        continue
      }
      const { sessionID, messageID } = req
      if (!deps.seed) {
        dispatch(projector.seed(sessionID, messageID, null))
        continue
      }
      const at = epoch
      deps.seed(sessionID, messageID).then(
        (message) => {
          if (at === epoch) dispatch(projector.seed(sessionID, messageID, message ?? null))
        },
        (error) => {
          log(`opencode v2: seeding ${messageID} failed: ${error instanceof Error ? error.message : error}`)
          if (at === epoch) dispatch(projector.seed(sessionID, messageID, null))
        }
      )
    }
  }

  function scheduleFlush() {
    if (flushTimer || !projector.hasPending()) return
    flushTimer = setTimeout(() => {
      flushTimer = undefined
      dispatch(projector.flush())
      scheduleFlush()
    }, timing.throttleMs)
  }

  async function consume(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    const parser = createSseParser({ data: onData, comment: onComment })
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        lastByte = Date.now()
        parser.push(decoder.decode(value, { stream: true }))
      }
    } finally {
      try { reader.releaseLock() } catch { /* still locked by a pending read */ }
    }
  }

  async function run(at: number) {
    while (running && at === epoch) {
      const ac = new AbortController()
      controller = ac
      try {
        lastByte = Date.now()
        const body = await deps.client.stream('/api/event', ac.signal)
        if (at !== epoch) {
          await body.cancel().catch(() => {})
          return
        }
        await consume(body)
        if (running && at === epoch) log('opencode v2: event stream ended, reconnecting')
      } catch (error) {
        if (!running || at !== epoch) return
        log(`opencode v2: event stream failed: ${error instanceof Error ? error.message : error}`)
      } finally {
        ac.abort()
      }
      connected = false
      if (!running || at !== epoch) return
      const delay = Math.min(timing.backoffMaxMs, timing.backoffMs * 2 ** retry++)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wake = null
          resolve()
        }, delay)
        wake = () => {
          clearTimeout(timer)
          wake = null
          resolve()
        }
      })
    }
  }

  function start() {
    if (running) return
    running = true
    retry = 0
    const at = epoch
    void run(at)
    staleTimer = unref(setInterval(() => {
      // heartbeats come every 15 s: silence means a half-open socket
      if (connected && Date.now() - lastByte > timing.staleMs) {
        log('opencode v2: event stream went silent, reconnecting')
        controller?.abort()
      }
    }, Math.max(1000, Math.floor(timing.staleMs / 3))))
    evictTimer = unref(setInterval(() => {
      projector.evict(timing.evictMs, (sessionID) => busy.has(sessionID) || checks.has(sessionID))
      const limit = Date.now() - timing.evictMs
      for (const map of [lastBusy, lastIdle]) {
        for (const [sessionID, [, at]] of map) if (at < limit && !busy.has(sessionID)) map.delete(sessionID)
      }
    }, 60_000))
  }

  function stop() {
    if (!running) return
    running = false
    connected = false
    epoch++
    controller?.abort()
    controller = null
    wake?.()
    clearTimeout(lingerTimer)
    clearTimeout(flushTimer)
    clearTimeout(pollTimer)
    clearInterval(staleTimer)
    clearInterval(evictTimer)
    lingerTimer = flushTimer = pollTimer = staleTimer = evictTimer = undefined
    for (const check of checks.values()) clearTimeout(check.timer)
    for (const refresh of refreshes.values()) clearTimeout(refresh.timer)
    checks.clear()
    refreshes.clear()
    busy.clear()
    lastBusy.clear()
    lastIdle.clear()
    projector.reset()
  }

  return {
    subscribe(directory, send) {
      // v2 echoes directories verbatim (Windows backslashes, any case)
      const sub: Subscriber = { directory: normDir(directory), send }
      subscribers.add(sub)
      clearTimeout(lingerTimer)
      lingerTimer = undefined
      // legacy servers greet every connection; the UI refetches on it
      if (connected) deliver(sub, encodeFrame(nextId(), { type: 'server.connected', properties: {} }))
      start()
      return () => {
        if (!subscribers.delete(sub) || subscribers.size) return
        clearTimeout(lingerTimer)
        lingerTimer = unref(setTimeout(stop, timing.lingerMs))
      }
    },
    get size() {
      return subscribers.size
    },
    close() {
      stop()
      subscribers.clear()
    }
  }
}

/**
 * Legacy transport against a 1.18 hybrid server: projects the `session.next.*`
 * events it mirrors onto `/event` (sessions run by the new v2 TUI) and passes
 * everything else through. Wrap the upstream body of the legacy `/event`
 * proxy with it.
 */
export function mirrorLegacyEvents(
  upstream: ReadableStream<Uint8Array>,
  opts: ProjectorOptions & { status?: boolean } = {}
): ReadableStream<Uint8Array> {
  const mirror = createMirrorProjector(opts)
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const throttleMs = opts.throttleMs ?? DEFAULT_TIMING.throttleMs
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let flushTimer: Timer | undefined
  let closed = false

  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      reader = upstream.getReader()
      const emit = (frame: string) => {
        if (!closed) ctrl.enqueue(encoder.encode(frame))
      }
      const write = (events: LegacyEnvelope[]) => {
        for (const event of events) {
          emit(encodeFrame(event.id ?? '', { type: event.type, properties: event.properties ?? {} }))
        }
      }
      const scheduleFlush = () => {
        if (flushTimer || !mirror.hasPending()) return
        flushTimer = setTimeout(() => {
          flushTimer = undefined
          write(mirror.flush())
          scheduleFlush()
        }, throttleMs)
      }
      const parser = createSseParser({
        data(raw) {
          let event: LegacyEnvelope
          try {
            event = JSON.parse(raw)
          } catch {
            emit(`data: ${raw}\n\n`)
            return
          }
          if (!event || typeof event.type !== 'string') {
            emit(`data: ${raw}\n\n`)
            return
          }
          // untouched legacy events keep their exact bytes
          const out = mirror.push(event)
          if (out.length === 1 && out[0] === event) emit(`data: ${raw}\n\n`)
          else write(out)
          scheduleFlush()
        },
        comment: (text) => emit(`:${text}\n\n`)
      })
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader!.read()
            if (done) break
            parser.push(decoder.decode(value, { stream: true }))
          }
          if (!closed) {
            write(mirror.flush())
            closed = true
            ctrl.close()
          }
        } catch (error) {
          if (!closed) {
            closed = true
            ctrl.error(error)
          }
        } finally {
          clearTimeout(flushTimer)
        }
      })()
    },
    cancel(reason) {
      closed = true
      clearTimeout(flushTimer)
      return reader?.cancel(reason)
    }
  })
}
