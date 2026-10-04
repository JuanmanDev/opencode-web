import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSseParser, createV2EventHub, mirrorLegacyEvents, type V2EventHubDeps } from '../../server/utils/compat/v2/events'
import { toLegacyMessages } from '../../server/utils/compat/v2/mappers'
import { V2HttpError, type V2Client } from '../../server/utils/compat/v2/types'

const FIXTURES = new URL('../fixtures/opencode-v2/events/', import.meta.url)
const DIR = 'C:\\Users\\dev\\project'
const S1 = 'ses_efb6b4642ffedDM7FFyDoLBC2c'
const SR = 'ses_efb48db22ffeErjRIy6XI8zJN3'

function readText(name: string) {
  return readFileSync(new URL(name, FIXTURES), 'utf8')
}

interface FakeStream {
  signal: AbortSignal
  push(text: string): void
  end(): void
}

/** V2Client double: streams the test controls, scripted /api/session/active. */
function fakeClient() {
  const streams: FakeStream[] = []
  const requests: string[] = []
  const sessions = new Map<string, any>()
  let active: () => Record<string, unknown> = () => ({})
  let failNextStream = 0
  const encoder = new TextEncoder()
  const client: V2Client = {
    async request(path: string): Promise<any> {
      requests.push(path)
      if (path === '/api/session/active') return { data: active() }
      const match = /^\/api\/session\/([^/]+)$/.exec(path)
      if (match) {
        const session = sessions.get(decodeURIComponent(match[1]!))
        if (session) return { data: session }
        throw new V2HttpError(404, { _tag: 'SessionNotFoundError', message: 'Session not found' })
      }
      throw new Error(`unexpected request ${path}`)
    },
    async stream(path: string, signal: AbortSignal) {
      expect(path).toBe('/api/event')
      if (failNextStream > 0) {
        failNextStream--
        throw new Error('connect ECONNREFUSED')
      }
      let ctrl!: ReadableStreamDefaultController<Uint8Array>
      const body = new ReadableStream<Uint8Array>({ start: (c) => { ctrl = c } })
      signal.addEventListener('abort', () => {
        try { ctrl.error(new DOMException('aborted', 'AbortError')) } catch { /* closed */ }
      })
      streams.push({
        signal,
        push: (text) => ctrl.enqueue(encoder.encode(text)),
        end: () => ctrl.close()
      })
      return body
    }
  }
  return {
    client,
    streams,
    requests,
    sessions,
    setActive(fn: () => Record<string, unknown>) { active = fn },
    failStreams(n: number) { failNextStream = n },
    last: () => streams[streams.length - 1]!
  }
}

function subscriber(hub: ReturnType<typeof createV2EventHub>, directory?: string) {
  const frames: string[] = []
  const unsubscribe = hub.subscribe(directory, (frame) => frames.push(frame))
  return {
    frames,
    unsubscribe,
    events: () => frames.filter((f) => f.startsWith('data: ')).map((f) => JSON.parse(f.slice(6))),
    types: () => frames.filter((f) => f.startsWith('data: ')).map((f) => JSON.parse(f.slice(6)).type)
  }
}

const frame = (event: object) => `data: ${JSON.stringify(event)}\n\n`
const connected = frame({ id: 'evt_0', type: 'server.connected', data: {} })
const at = (type: string, data: Record<string, unknown>, id = `evt_${type}`) =>
  frame({ id, type, location: { directory: DIR }, data: { sessionID: 'ses_a', ...data } })

/** Lets the hub's stream reads and promise chains run. */
const settle = () => vi.advanceTimersByTimeAsync(0)

let hubs: Array<ReturnType<typeof createV2EventHub>> = []
function makeHub(fake: ReturnType<typeof fakeClient>, deps: Partial<V2EventHubDeps> = {}) {
  const hub = createV2EventHub({ client: fake.client, ...deps })
  hubs.push(hub)
  return hub
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  for (const hub of hubs) hub.close()
  hubs = []
  vi.useRealTimers()
})

describe('createSseParser', () => {
  it('handles CRLF split across chunks, multi-line data and comments', () => {
    const data: string[] = []
    const comments: string[] = []
    const parser = createSseParser({ data: (d) => data.push(d), comment: (c) => comments.push(c) })
    for (const chunk of ['data: {"a"', ':1}\r', '\n\r\n: heart', 'beat\r\n\r\ndata: x\ndata:y\n', '\nevent: ignored\nid: 3\ndata: z\r\r']) {
      parser.push(chunk)
    }
    // a trailing CR may be half of a CRLF: the event waits for the next byte
    expect(data).toEqual(['{"a":1}', 'x\ny'])
    parser.push('\n')
    expect(data).toEqual(['{"a":1}', 'x\ny', 'z'])
    expect(comments).toEqual([' heartbeat'])
  })
})

describe('v2 event hub', () => {
  it('shares one upstream and closes it 30 s after the last subscriber left', async () => {
    const fake = fakeClient()
    const hub = makeHub(fake)
    const a = subscriber(hub, DIR)
    const b = subscriber(hub, DIR)
    await settle()
    expect(fake.streams).toHaveLength(1)
    expect(hub.size).toBe(2)
    a.unsubscribe()
    b.unsubscribe()
    await vi.advanceTimersByTimeAsync(29_000)
    expect(fake.last().signal.aborted).toBe(false)
    // a returning tab within the window reuses the stream
    const c = subscriber(hub, DIR)
    c.unsubscribe()
    await vi.advanceTimersByTimeAsync(29_000)
    expect(fake.last().signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fake.last().signal.aborted).toBe(true)
    expect(fake.streams).toHaveLength(1)
    subscriber(hub)
    await settle()
    expect(fake.streams).toHaveLength(2)
  })

  it('greets subscribers, forwards heartbeats and reconciles on connect', async () => {
    const fake = fakeClient()
    const hub = makeHub(fake)
    const a = subscriber(hub, DIR)
    await settle()
    fake.last().push(connected.replace('\n\n', '\r\n\r\n') + ': heartbeat\n\n')
    await settle()
    expect(a.frames).toEqual([frame({ id: 'evt_0', type: 'server.connected', properties: {} }), ': heartbeat\n\n'])
    expect(fake.requests).toEqual(['/api/session/active'])
    // a late subscriber is greeted right away, like a legacy /event connection
    const late = subscriber(hub, '/elsewhere')
    expect(late.types()).toEqual(['server.connected'])
  })

  it('filters per project directory (Windows paths compare loosely)', async () => {
    const fake = fakeClient()
    const hub = makeHub(fake)
    const same = subscriber(hub, 'c:/users/DEV/project/')
    const other = subscriber(hub, 'C:\\Users\\dev\\other')
    const all = subscriber(hub)
    await settle()
    fake.last().push(connected)
    fake.last().push(at('todo.updated', { todos: [] }))
    await settle()
    expect(same.types()).toEqual(['server.connected', 'todo.updated'])
    expect(other.types()).toEqual(['server.connected'])
    expect(all.types()).toEqual(['server.connected', 'todo.updated'])
  })

  it('replays the real capture as legacy frames', async () => {
    const fake = fakeClient()
    fake.sessions.set(S1, { id: S1, title: 'New session - 2026-10-04T01:43:38.402Z', location: { directory: DIR }, time: { created: 1, updated: 1 } })
    const hub = makeHub(fake)
    const sub = subscriber(hub, DIR)
    await settle()
    const text = readText('api-event.sse.txt')
    for (let i = 0; i < text.length; i += 977) fake.last().push(text.slice(i, i + 977))
    await vi.advanceTimersByTimeAsync(200)

    const events = sub.events()
    expect(sub.frames.every((f) => f.endsWith('\n\n'))).toBe(true)
    expect(events.every((e) => typeof e.id === 'string' && e.properties && !('data' in e))).toBe(true)
    const types = new Set(events.map((e) => e.type))
    for (const noise of ['plugin.added', 'catalog.updated', 'reference.updated', 'integration.updated']) expect(types.has(noise)).toBe(false)
    for (const type of ['server.connected', 'session.created', 'session.updated', 'message.updated', 'message.part.updated', 'permission.asked', 'permission.replied', 'question.asked', 'question.replied', 'session.error', 'session.status']) {
      expect(types.has(type)).toBe(true)
    }
    // frame ids are the v2 event ids (suffixed when one event yields several)
    const user = events.find((e) => e.type === 'message.updated' && e.properties.info.role === 'user')
    expect(user.id).toBe('evt_10494bced001R1KcVJeZoMOWyG')
    expect(events[events.indexOf(user) + 1].id).toBe('evt_10494bced001R1KcVJeZoMOWyG.1')
    // session.updated comes from the server row (+ live overlays)
    const updated = events.filter((e) => e.type === 'session.updated' && e.properties.sessionID === S1)
    expect(updated.at(-1).properties.info).toMatchObject({ id: S1, version: 'v2', directory: DIR })
    expect(updated.length).toBeLessThan(events.filter((e) => e.type.startsWith('session.next')).length + 8)
    expect(events.filter((e) => e.type === 'session.status' && e.properties.sessionID === S1)[0].properties.status).toEqual({ type: 'busy' })
  })

  it('confirms idle with /api/session/active: debounce, then retries', async () => {
    const fake = fakeClient()
    const hub = makeHub(fake)
    const sub = subscriber(hub, DIR)
    await settle()
    fake.last().push(connected)
    await settle()
    fake.last().push(at('session.next.prompted', { timestamp: 1, messageID: 'msg_1', prompt: { text: 'hi' } }))
    fake.last().push(at('session.next.step.started', { timestamp: 2, assistantMessageID: 'msg_2', agent: 'build', model: { id: 'm', providerID: 'p' } }))
    await settle()
    const statuses = () => sub.events().filter((e) => e.type === 'session.status' || e.type === 'session.idle').map((e) => e.properties.status?.type ?? 'idle!')
    expect(statuses()).toEqual(['busy'])

    let running = true
    fake.setActive(() => (running ? { ses_a: { type: 'running' } } : {}))
    fake.last().push(at('session.next.step.ended', { timestamp: 3, assistantMessageID: 'msg_2', finish: 'stop', cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }))
    await vi.advanceTimersByTimeAsync(299)
    const asked = fake.requests.length
    expect(statuses()).toEqual(['busy'])
    await vi.advanceTimersByTimeAsync(1)
    expect(fake.requests.length).toBe(asked + 1)
    expect(statuses()).toEqual(['busy']) // still running: retry in 1 s
    running = false
    await vi.advanceTimersByTimeAsync(1000)
    expect(statuses()).toEqual(['busy', 'idle', 'idle!'])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(statuses()).toEqual(['busy', 'idle', 'idle!'])
  })

  it('a new step cancels a pending idle check', async () => {
    const fake = fakeClient()
    const hub = makeHub(fake)
    const sub = subscriber(hub, DIR)
    await settle()
    // /active answers "idle" throughout: only a cancelled check stays quiet
    fake.last().push(connected)
    fake.last().push(at('session.next.prompted', { timestamp: 1, messageID: 'msg_1', prompt: { text: 'hi' } }))
    fake.last().push(at('permission.v2.replied', { requestID: 'per_1', reply: 'reject' }))
    await vi.advanceTimersByTimeAsync(100)
    fake.last().push(at('session.next.step.started', { timestamp: 2, assistantMessageID: 'msg_2', agent: 'build', model: { id: 'm', providerID: 'p' } }))
    await vi.advanceTimersByTimeAsync(4_000)
    expect(sub.types().filter((t) => t === 'session.idle' || t === 'session.status')).toEqual(['session.status'])
    // the 5 s safety poll finally believes /active
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sub.types().filter((t) => t === 'session.idle')).toEqual(['session.idle'])
  })

  it('completes the question-reject zombie once idle is confirmed', async () => {
    const fake = fakeClient()
    const hub = makeHub(fake)
    const sub = subscriber(hub, DIR)
    await settle()
    fake.last().push(readText('reject.sse.txt'))
    await vi.advanceTimersByTimeAsync(400)
    const events = sub.events()
    const tail = events.slice(-3)
    expect(tail.map((e) => e.type)).toEqual(['message.updated', 'session.status', 'session.idle'])
    expect(tail[0].properties.info).toMatchObject({
      role: 'assistant',
      error: { name: 'MessageAbortedError', data: { message: 'Interrupted' } }
    })
    expect(tail[0].properties.info.time.completed).toBeGreaterThan(tail[0].properties.info.time.created)
    expect(tail[1].properties).toEqual({ sessionID: SR, status: { type: 'idle' } })

    // the UI now holds what a reload would show
    const rest = JSON.parse(readText('reject-messages.json')).body.data
    const expected = toLegacyMessages(rest, { sessionID: SR, session: { location: { directory: DIR } }, active: false })
    const last = expected.at(-1)!.info
    expect(tail[0].properties.info).toEqual(last)
  })

  it('polls /api/session/active while busy: catches runs that end silently', async () => {
    const fake = fakeClient()
    const hub = makeHub(fake)
    const sub = subscriber(hub, DIR)
    await settle()
    fake.setActive(() => ({ ses_a: { type: 'running' } }))
    fake.last().push(connected)
    await settle()
    // already running when we connected
    expect(sub.events().filter((e) => e.type === 'session.status').map((e) => e.properties)).toEqual([{ sessionID: 'ses_a', status: { type: 'busy' } }])
    fake.setActive(() => ({}))
    await vi.advanceTimersByTimeAsync(4_999)
    expect(sub.types()).not.toContain('session.idle')
    await vi.advanceTimersByTimeAsync(1)
    expect(sub.types().slice(-2)).toEqual(['session.status', 'session.idle'])
  })

  it('reconnects with backoff and greets again', async () => {
    const fake = fakeClient()
    const logs: string[] = []
    const hub = makeHub(fake, { logger: (m) => logs.push(m) })
    const sub = subscriber(hub, DIR)
    await settle()
    fake.last().push(connected)
    await settle()
    fake.failStreams(2)
    fake.last().end()
    await settle()
    expect(fake.streams).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(500) // 1st retry fails
    await vi.advanceTimersByTimeAsync(999)
    expect(fake.streams).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1) // 2nd retry (1 s) fails
    await vi.advanceTimersByTimeAsync(2000) // 3rd (2 s) connects
    expect(fake.streams).toHaveLength(2)
    fake.last().push(connected)
    await settle()
    expect(sub.types()).toEqual(['server.connected', 'server.connected'])
    expect(fake.requests.filter((r) => r === '/api/session/active')).toHaveLength(2)
    expect(logs.some((l) => l.includes('ECONNREFUSED'))).toBe(true)
    // a successful connection resets the backoff
    fake.last().end()
    await vi.advanceTimersByTimeAsync(500)
    expect(fake.streams).toHaveLength(3)
  })

  it('reconnects a stream that went silent', async () => {
    const fake = fakeClient()
    const hub = makeHub(fake)
    subscriber(hub, DIR)
    await settle()
    fake.last().push(connected)
    await settle()
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(15_000)
      fake.last().push(': heartbeat\n\n')
    }
    expect(fake.last().signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(61_000)
    expect(fake.streams[0]!.signal.aborted).toBe(true)
    expect(fake.streams.length).toBeGreaterThan(1)
  })

  it('seeds assistants that started before it connected', async () => {
    const fake = fakeClient()
    const seed = vi.fn(async (sessionID: string, messageID: string) => ({
      info: { id: messageID, sessionID, role: 'assistant', parentID: 'msg_0', agent: 'plan', modelID: 'm', providerID: 'p', time: { created: 5 } },
      parts: [{ id: `prt_${messageID}_start`, sessionID, messageID, type: 'step-start' }]
    }))
    const hub = makeHub(fake, { seed })
    const sub = subscriber(hub, DIR)
    await settle()
    fake.last().push(connected)
    fake.last().push(at('session.next.text.delta', { timestamp: 9, assistantMessageID: 'msg_5', textID: 'text-0', delta: 'partial' }))
    await settle()
    expect(seed).toHaveBeenCalledWith('ses_a', 'msg_5')
    const seeded = sub.events().filter((e) => e.type.startsWith('message.'))
    expect(seeded.map((e) => e.type)).toEqual(['message.updated', 'message.part.updated'])
    expect(seeded[0].properties.info).toMatchObject({ id: 'msg_5', agent: 'plan', parentID: 'msg_0', time: { created: 5 } })
  })

  it('resolves session.updated through the session hook, coalesced', async () => {
    const fake = fakeClient()
    const session = vi.fn(async (id: string) => ({ id, title: 'From meta', directory: DIR, agent: 'build', time: { created: 1, updated: 2 } }))
    const hub = makeHub(fake, { session })
    const sub = subscriber(hub, DIR)
    await settle()
    fake.last().push(connected)
    fake.last().push(at('session.next.agent.switched', { timestamp: 10, messageID: 'msg_1', agent: 'plan' }))
    fake.last().push(at('session.next.model.switched', { timestamp: 11, messageID: 'msg_2', model: { id: 'm', providerID: 'p' } }))
    await settle()
    expect(sub.types()).not.toContain('session.updated')
    await vi.advanceTimersByTimeAsync(100)
    expect(session).toHaveBeenCalledTimes(1)
    const updated = sub.events().filter((e) => e.type === 'session.updated')
    expect(updated).toHaveLength(1)
    expect(updated[0].properties).toEqual({ sessionID: 'ses_a', info: { id: 'ses_a', title: 'From meta', directory: DIR, agent: 'build', time: { created: 1, updated: 2 } } })
  })

  it('flushes throttled deltas', async () => {
    const fake = fakeClient()
    const hub = makeHub(fake)
    const sub = subscriber(hub, DIR)
    await settle()
    fake.last().push(connected)
    fake.last().push(at('session.next.step.started', { timestamp: 1, assistantMessageID: 'msg_2', agent: 'build', model: { id: 'm', providerID: 'p' } }))
    fake.last().push(at('session.next.text.started', { timestamp: 1, assistantMessageID: 'msg_2', textID: 't' }))
    fake.last().push(at('session.next.text.delta', { assistantMessageID: 'msg_2', textID: 't', delta: 'Hel' }))
    fake.last().push(at('session.next.text.delta', { assistantMessageID: 'msg_2', textID: 't', delta: 'lo' }))
    await settle()
    const texts = () => sub.events().filter((e) => e.properties.part?.type === 'text').map((e) => e.properties.part.text)
    // both deltas land within 50 ms of the start: held back, then one update
    expect(texts()).toEqual([''])
    await vi.advanceTimersByTimeAsync(50)
    expect(texts()).toEqual(['', 'Hello'])
  })

  it('drops subscribers whose send throws', async () => {
    const fake = fakeClient()
    const hub = makeHub(fake)
    hub.subscribe(DIR, () => { throw new Error('closed') })
    const ok = subscriber(hub, DIR)
    await settle()
    fake.last().push(connected)
    await settle()
    expect(hub.size).toBe(1)
    expect(ok.types()).toEqual(['server.connected'])
  })
})

describe('mirrorLegacyEvents (1.18 hybrid, legacy transport)', () => {
  it('projects session.next.* and keeps legacy frames byte for byte', async () => {
    vi.useRealTimers()
    const text = readText('legacy-event.sse.txt')
    const encoder = new TextEncoder()
    const source = new ReadableStream<Uint8Array>({
      start(ctrl) {
        for (let i = 0; i < text.length; i += 1500) ctrl.enqueue(encoder.encode(text.slice(i, i + 1500)))
        ctrl.close()
      }
    })
    const out = await new Response(mirrorLegacyEvents(source)).text()
    const frames = out.split('\n\n').filter(Boolean)
    const events = frames.filter((f) => f.startsWith('data: ')).map((f) => JSON.parse(f.slice(6)))
    expect(events.some((e) => e.type.startsWith('session.next.') || e.type.includes('.v2.'))).toBe(false)
    expect(frames[0]).toBe('data: {"id":"evt_10494b23a0017kTO4yrtxvLFJ4","type":"server.connected","properties":{}}')
    expect(frames).toContain('data: {"id":"evt_10494b59c001MDuFvYTg9F8AFc","type":"plugin.added","properties":{"id":"core/config-reference"}}')
    const assistants = events.filter((e) => e.type === 'message.updated' && e.properties.info.role === 'assistant' && e.properties.info.time.completed)
    expect(assistants.length).toBeGreaterThanOrEqual(8)
    expect(events.filter((e) => e.type === 'permission.asked')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'session.idle').length).toBeGreaterThan(0)
  })
})
