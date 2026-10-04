import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createSseParser } from '../../server/utils/compat/v2/events'
import { toLegacyMessages } from '../../server/utils/compat/v2/mappers'
import {
  busyTransitions,
  createMirrorProjector,
  createProjector,
  isV2EventType,
  type LegacyEvent,
  type V2Event
} from '../../server/utils/compat/v2/projector'

// Real `/api/event` captures from opencode-ai@1.18.34 driven by a mock LLM
// (paths rewritten to C:\Users\dev\project).
const FIXTURES = new URL('../fixtures/opencode-v2/events/', import.meta.url)
const DIR = 'C:\\Users\\dev\\project'

function readText(name: string) {
  return readFileSync(new URL(name, FIXTURES), 'utf8')
}

function readSse(name: string): any[] {
  const events: any[] = []
  createSseParser({ data: (data) => events.push(JSON.parse(data)) }).push(readText(name))
  return events
}

function readJson(name: string) {
  return JSON.parse(readText(name))
}

// session ids in api-event.sse.txt: text/bash/question/attachment turns, dead provider, interrupt
const S1 = 'ses_efb6b4642ffedDM7FFyDoLBC2c'
const S2 = 'ses_efb6b3591ffemeYrx1VKhz409q'
const S3 = 'ses_efb6b3356ffentp4psMxEjhaXL'
// reject.sse.txt: permission reject (loop continues), then question reject (zombie)
const SR = 'ses_efb48db22ffeErjRIy6XI8zJN3'

interface Step { event: V2Event; out: LegacyEvent[] }

/** Replays events with the clock at each event's timestamp (deterministic throttling). */
function replay(events: V2Event[], opts: { throttleMs?: number } = {}) {
  let clock = 0
  const projector = createProjector({ throttleMs: opts.throttleMs ?? 50, now: () => clock })
  const steps: Step[] = []
  for (const event of events) {
    if (typeof event.data?.timestamp === 'number') clock = event.data.timestamp
    steps.push({ event, out: projector.push(event) })
  }
  return { projector, steps, all: steps.flatMap((s) => s.out), setClock: (t: number) => { clock = t } }
}

/** The session page's reducer: message.updated / message.part.updated / message.removed. */
function fold(events: LegacyEvent[], sessionID: string) {
  const messages: Array<{ info: any; parts: any[] }> = []
  for (const { type, properties: p } of events) {
    if (type === 'message.updated' && p.info.sessionID === sessionID) {
      const m = messages.find((x) => x.info.id === p.info.id)
      if (m) m.info = p.info
      else messages.push({ info: p.info, parts: [] })
    } else if (type === 'message.part.updated' && p.part.sessionID === sessionID) {
      let m = messages.find((x) => x.info.id === p.part.messageID)
      if (!m) messages.push((m = { info: { id: p.part.messageID, sessionID, role: 'assistant' }, parts: [] }))
      const i = m.parts.findIndex((x) => x.id === p.part.id)
      if (i >= 0) m.parts[i] = p.part
      else m.parts.push(p.part)
    } else if (type === 'message.removed' && p.sessionID === sessionID) {
      const i = messages.findIndex((x) => x.info.id === p.messageID)
      if (i >= 0) messages.splice(i, 1)
    }
  }
  return messages
}

/** Live text parts carry their lifecycle times, REST ones the message bounds. */
function withoutTextTimes(messages: Array<{ info: any; parts: any[] }>) {
  return messages.map((m) => ({
    info: m.info,
    parts: m.parts.map((p) => (p.type === 'text' ? { ...p, time: undefined } : p))
  }))
}

function bySession(events: V2Event[], sessionID: string) {
  return events.filter((e) => e.data?.sessionID === sessionID || e.data?.info?.id === sessionID)
}

function turn(events: V2Event[], sessionID: string, index: number) {
  // events from the index-th prompt.admitted up to the next one
  const own = bySession(events, sessionID)
  const starts = own.flatMap((e, i) => (e.type === 'session.next.prompt.admitted' ? [i] : []))
  return own.slice(starts[index], starts[index + 1])
}

const api = readSse('api-event.sse.txt')

describe('projector: real /api/event capture', () => {
  it('drops the location boot noise', () => {
    const noise = api.filter((e) => ['plugin.added', 'catalog.updated', 'reference.updated', 'integration.updated'].includes(e.type))
    expect(noise.length).toBeGreaterThan(40)
    const { all } = replay(noise)
    expect(all).toEqual([])
  })

  it('projects a text turn: user, assistant, step-start, reasoning, text, step-finish, completion', () => {
    const { steps } = replay(api)
    const first = steps.filter((s) => bySession([s.event], S1).length).slice(0, 17)
    const types = first.flatMap((s) => s.out.map((o) => o.type === 'message.part.updated' ? `part:${o.properties.part.type}` : o.type))
    expect(types).toEqual([
      'session.created', 'session.updated',
      // prompted
      'message.updated', 'part:text', 'session.updated',
      // step.started: the user message learns the run's model, assistant opens
      'message.updated', 'message.updated', 'part:step-start',
      'part:reasoning', // reasoning.started
      'part:reasoning', // second delta, 58 ms after the start: one throttled update
      'part:reasoning', // reasoning.ended
      'part:text', // text.started (all 5 deltas land within 50 ms: none emitted)
      'part:text', // text.ended
      'part:step-finish', 'message.updated'
    ])
    const out = first.flatMap((s) => s.out)
    expect(out.every((o) => o.directory === DIR || o.type === 'server.connected')).toBe(true)

    const user = out.find((o) => o.type === 'message.updated')!.properties.info
    expect(user).toEqual({ id: 'msg_10494bcd2001MeJ5OtI3voIbvz', sessionID: S1, role: 'user', time: { created: 1791078218963 }, agent: 'build' })
    const patched = out.filter((o) => o.type === 'message.updated')[1]!.properties.info
    expect(patched.model).toEqual({ providerID: 'mock', modelID: 'mock-model' })

    const session = out.filter((o) => o.type === 'session.updated')[1]!.properties.info
    expect(session.title).toBe('hello there') // derived: v2 never titles sessions
    expect(session.time.updated).toBe(1791078218963)

    const reasoning = out.filter((o) => o.properties.part?.type === 'reasoning').map((o) => o.properties.part)
    expect(reasoning.map((p) => p.text)).toEqual(['', 'Thinking about it.', 'Thinking about it.'])
    expect(reasoning[2].time).toEqual({ start: 1791078219110, end: 1791078219449 })

    const text = out.filter((o) => o.properties.part?.type === 'text' && o.properties.part.messageID.startsWith('msg_10494bd63')).map((o) => o.properties.part)
    expect(text.at(-1)).toEqual({
      id: 'prt_msg_10494bd63001w10jbw8MSjAtsS_text-0',
      sessionID: S1,
      messageID: 'msg_10494bd63001w10jbw8MSjAtsS',
      type: 'text',
      text: 'Hello from the mock model.',
      time: { start: 1791078219453, end: 1791078219553 }
    })

    const finish = out.find((o) => o.properties.part?.type === 'step-finish')!.properties.part
    expect(finish).toMatchObject({ reason: 'stop', cost: 0, tokens: { total: 132, input: 120, output: 12 } })
    const done = out.at(-1)!.properties.info
    expect(done).toMatchObject({
      id: 'msg_10494bd63001w10jbw8MSjAtsS',
      role: 'assistant',
      parentID: 'msg_10494bcd2001MeJ5OtI3voIbvz',
      time: { created: 1791078219107, completed: 1791078219687 },
      finish: 'stop',
      modelID: 'mock-model',
      providerID: 'mock',
      agent: 'build',
      path: { cwd: DIR, root: DIR }
    })
  })

  it('projects a tool turn with a permission and a second assistant message', () => {
    const { all } = replay(turn(api, S1, 1))
    const tool = all.filter((o) => o.properties.part?.type === 'tool').map((o) => o.properties.part.state)
    expect(tool.map((s) => s.status)).toEqual(['pending', 'pending', 'running', 'completed'])
    expect(tool[1].raw).toBe('{"command":"echo hello-from-bash","description":"Echo test"}')
    expect(tool[2]).toMatchObject({ input: { command: 'echo hello-from-bash' }, title: 'echo hello-from-bash', time: { start: 1791078219969 } })
    expect(tool[3]).toMatchObject({
      output: 'hello-from-bash\r\n\nCommand exited with code 0.',
      title: 'echo hello-from-bash',
      metadata: { exit: 0, truncated: false },
      time: { start: 1791078219969, end: 1791078220210 }
    })

    const asked = all.find((o) => o.type === 'permission.asked')!.properties
    expect(asked).toMatchObject({
      id: 'per_10494c0f1001xyOhKTBH54c57b',
      sessionID: S1,
      permission: 'bash',
      patterns: ['echo hello-from-bash'],
      title: 'Run: echo hello-from-bash',
      tool: { messageID: 'msg_10494c0b9001fUpVyXoD5KT9I9', callID: 'call_1791078219959' }
    })
    expect(all.find((o) => o.type === 'permission.replied')!.properties).toEqual({
      sessionID: S1,
      requestID: 'per_10494c0f1001xyOhKTBH54c57b',
      permissionID: 'per_10494c0f1001xyOhKTBH54c57b',
      reply: 'once',
      response: 'once'
    })

    const assistants = all.filter((o) => o.type === 'message.updated' && o.properties.info.role === 'assistant').map((o) => o.properties.info)
    expect([...new Set(assistants.map((a) => a.id))]).toEqual(['msg_10494c0b9001fUpVyXoD5KT9I9', 'msg_10494c296001E2uxlSAEkrO7nb'])
    // legacy splits a tool turn the same way: both answer the user message
    expect(assistants.every((a) => a.parentID === 'msg_10494c0080012jkK2IKinYPc6x')).toBe(true)
    expect(assistants.filter((a) => a.time.completed).map((a) => a.finish)).toEqual(['tool-calls', 'stop'])
  })

  it('passes questions through with their legacy names', () => {
    const { all } = replay(turn(api, S1, 2))
    const questions = all.filter((o) => o.type.startsWith('question.'))
    expect(questions.map((o) => o.type)).toEqual(['question.asked', 'question.replied'])
    expect(questions[0]!.properties).toEqual({
      id: 'que_10494c4940018MjCGebkhiFKZY',
      sessionID: S1,
      questions: [{ question: 'Pick one?', header: 'Pick', options: [{ label: 'A', description: 'first' }, { label: 'B', description: 'second' }] }],
      tool: { messageID: 'msg_10494c48b001qdohQASZm26e4j', callID: 'call_1791078220939' }
    })
    expect(questions[1]!.properties.answers).toEqual([['A']])
  })

  it('reports provider failures as errors, interrupts as aborts', () => {
    const { all } = replay(api)
    const errors = all.filter((o) => o.type === 'session.error').map((o) => o.properties)
    expect(errors).toEqual([
      { sessionID: S1, error: { name: 'UnknownError', data: { message: 'OpenAI Chat does not support media type text/plain' } } },
      { sessionID: S2, error: { name: 'UnknownError', data: { message: 'HTTP transport failed' } } }
    ])
    const interrupted = fold(all, S3).at(-1)!.info
    expect(interrupted).toMatchObject({
      finish: 'error',
      time: { completed: 1791078225195 },
      error: { name: 'MessageAbortedError', data: { message: 'Provider turn interrupted' } }
    })
  })

  it('folds into exactly what the REST snapshot maps to', () => {
    const { all } = replay(api)
    const session = { id: S1, location: { directory: DIR } }
    const rest = readJson('session-messages-final.json').body.data
    expect(withoutTextTimes(fold(all, S1).slice(0, rest.length * 2))).toEqual(
      withoutTextTimes(toLegacyMessages(rest, { sessionID: S1, session, active: false }))
    )
    const interrupted = readJson('session-messages-interrupted.json').body.data
    expect(withoutTextTimes(fold(all, S3))).toEqual(
      withoutTextTimes(toLegacyMessages(interrupted, { sessionID: S3, session: { id: S3, location: { directory: DIR } }, active: false }))
    )
  })

  it('streams slow deltas with the accumulated text, one update per throttle window', () => {
    const { steps } = replay(api)
    const deltas = steps.filter((s) => s.event.type === 'session.next.text.delta' && s.event.data.sessionID === S3)
    // 250 ms apart: every delta shows up, always as the whole text so far
    const texts = deltas.flatMap((s) => s.out.map((o) => o.properties.part.text))
    expect(texts.at(-1)).toBe('w0 w1 w2 w3 w4 w5 w6 w7 ')
    expect(texts.length).toBeGreaterThanOrEqual(7)
    for (let i = 1; i < texts.length; i++) expect(texts[i]!.startsWith(texts[i - 1]!)).toBe(true)
  })

  it('keeps busy/idle candidates per spec §D.3', () => {
    const signals = api.flatMap((e) => busyTransitions(e).map((s) => `${e.type}:${s.status}`))
    expect(signals).toContain('session.next.prompted:busy')
    expect(signals).toContain('session.next.step.failed:idle')
    // a tool step continues the run: no idle candidate
    const toolStep = api.find((e) => e.type === 'session.next.step.ended' && e.data.finish === 'tool-calls')
    expect(busyTransitions(toolStep)).toEqual([])
    // the queued follow-up of the interrupt run does not start anything
    const queued = api.find((e) => e.type === 'session.next.prompt.admitted' && e.data.delivery === 'queue')
    expect(busyTransitions(queued)).toEqual([])
    expect(replay([queued]).all).toEqual([])
  })

  it('turns agent/model switches and reverts into session.updated', () => {
    const { all } = replay(api)
    const updates = all.filter((o) => o.type === 'session.updated' && o.properties.sessionID === S1).map((o) => o.properties.info)
    const [agent, model, staged, cleared] = updates.slice(-4)
    expect(agent).toMatchObject({ agent: 'plan', title: 'hello there' })
    expect(model).toMatchObject({ agent: 'plan', model: { id: 'mock-model', providerID: 'mock', variant: 'high' } })
    expect(staged!.revert).toEqual({ messageID: 'msg_10494c855001JLoejBBaKA7B0l', diff: '', files: [] })
    expect(cleared).not.toHaveProperty('revert')
  })
})

describe('projector: todo / failed tool capture', () => {
  it('passes todo.updated through and maps a failed tool', () => {
    const { all } = replay(readSse('p2-api-event.sse.txt'))
    const todo = all.find((o) => o.type === 'todo.updated')!
    expect(todo.properties.todos).toEqual([{ content: 'Write spec', status: 'in_progress', priority: 'high' }])
    expect(todo.directory).toBe(DIR)
    const read = all.filter((o) => o.properties.part?.tool === 'read').at(-1)!.properties.part
    expect(read.state).toMatchObject({ status: 'error', input: { filePath: 'README.md' }, error: 'Invalid tool input: Missing key\n  at ["path"]' })
  })
})

describe('projector: question reject capture', () => {
  const events = readSse('reject.sse.txt')

  it('continues after a permission reject (no idle candidate), stops after a question reject', () => {
    const replied = events.find((e) => e.type === 'permission.v2.replied')
    expect(replied.data.reply).toBe('reject')
    // §D.3 lists it as a candidate: the hub confirms with /api/session/active
    expect(busyTransitions(replied)).toEqual([{ sessionID: SR, status: 'idle' }])
    const failed = events.filter((e) => e.type === 'session.next.tool.failed')
    expect(failed.map((e) => e.data.error.message)).toEqual(['Unable to execute command: echo hello-from-bash', 'Tool execution interrupted'])
    expect(busyTransitions(failed[0])).toEqual([])
    expect(busyTransitions(failed[1])).toEqual([{ sessionID: SR, status: 'idle' }])
    expect(busyTransitions(events.find((e) => e.type === 'question.v2.rejected'))).toEqual([{ sessionID: SR, status: 'idle' }])
  })

  it('leaves the zombie open until settle() completes it like the REST mapping', () => {
    const { projector, all } = replay(events)
    const zombie = fold(all, SR).at(-1)!
    expect(zombie.info.time.completed).toBeUndefined()
    expect(all.at(-1)!.properties.part.state).toMatchObject({ status: 'error', error: 'Tool execution interrupted' })

    const settled = projector.settle(SR)
    expect(settled.map((o) => o.type)).toEqual(['message.updated'])
    // completion = latest time inside the message: the interrupted tool's end
    const interrupted = events.filter((e) => e.type === 'session.next.tool.failed').at(-1)
    expect(settled[0]!.properties.info).toMatchObject({
      id: zombie.info.id,
      time: { completed: interrupted.data.timestamp },
      error: { name: 'MessageAbortedError', data: { message: 'Interrupted' } }
    })
    expect(projector.settle(SR)).toEqual([])

    const rest = readJson('reject-messages.json').body.data
    const session = { id: SR, location: { directory: DIR } }
    expect(withoutTextTimes(fold([...all, ...settled], SR))).toEqual(
      withoutTextTimes(toLegacyMessages(rest, { sessionID: SR, session, active: false }))
    )
  })

  it('a later step supersedes the zombie, as the server reducer does', () => {
    const { projector, all } = replay(events)
    const zombieID = fold(all, SR).at(-1)!.info.id
    const out = projector.push({
      type: 'session.next.step.started',
      location: { directory: DIR },
      data: { timestamp: 1791080480000, sessionID: SR, assistantMessageID: 'msg_zzzz', agent: 'build', model: { id: 'mock-model', providerID: 'mock' } }
    })
    expect(out[0]!.properties.info).toMatchObject({ id: zombieID, time: { completed: 1791080480000 } })
    expect(out[0]!.properties.info.error).toBeUndefined()
    expect(out[1]!.properties.info).toMatchObject({ id: 'msg_zzzz', parentID: 'msg_104b72c29001eo85W0oz375f1Z' })
  })
})

describe('projector: lifecycles the captures do not cover', () => {
  const sid = 'ses_x'
  const mid = 'msg_200'
  const at = (type: string, data: Record<string, unknown>): V2Event => ({ type, location: { directory: DIR }, data: { sessionID: sid, ...data } })
  const step = (t: number) => at('session.next.step.started', { timestamp: t, assistantMessageID: mid, agent: 'build', model: { id: 'm', providerID: 'p' } })

  it('numbers repeated text ids like toLegacyMessages', () => {
    const { all } = replay([
      step(1),
      at('session.next.text.started', { timestamp: 2, assistantMessageID: mid, textID: 'text-0' }),
      at('session.next.text.ended', { timestamp: 3, assistantMessageID: mid, textID: 'text-0', text: 'one' }),
      at('session.next.text.started', { timestamp: 4, assistantMessageID: mid, textID: 'text-0' }),
      at('session.next.text.delta', { timestamp: 5, assistantMessageID: mid, textID: 'text-0', delta: 'tw' }),
      at('session.next.text.ended', { timestamp: 6, assistantMessageID: mid, textID: 'text-0', text: 'two' })
    ])
    const rest = toLegacyMessages([
      { id: mid, type: 'assistant', time: { created: 1 }, agent: 'build', model: { id: 'm', providerID: 'p' }, content: [{ type: 'text', id: 'text-0', text: 'one' }, { type: 'text', id: 'text-0', text: 'two' }] }
    ], { sessionID: sid, active: true })
    const live = fold(all, sid)[0]!.parts
    expect(live.map((p) => p.id)).toEqual(rest[0]!.parts.map((p) => p.id))
    expect(live.map((p) => p.text)).toEqual([undefined, 'one', 'two'])
  })

  it('holds fast deltas back until flush()', () => {
    let clock = 0
    const projector = createProjector({ throttleMs: 100, now: () => clock })
    projector.push(step(0))
    projector.push(at('session.next.text.started', { timestamp: 0, assistantMessageID: mid, textID: 't' }))
    clock = 10
    expect(projector.push(at('session.next.text.delta', { assistantMessageID: mid, textID: 't', delta: 'a' }))).toEqual([])
    clock = 20
    expect(projector.push(at('session.next.text.delta', { assistantMessageID: mid, textID: 't', delta: 'b' }))).toEqual([])
    expect(projector.hasPending()).toBe(true)
    const flushed = projector.flush()
    expect(flushed.map((o) => o.properties.part.text)).toEqual(['ab'])
    expect(projector.hasPending()).toBe(false)
    expect(projector.flush()).toEqual([])
    clock = 200
    expect(projector.push(at('session.next.text.delta', { assistantMessageID: mid, textID: 't', delta: 'c' }))[0]!.properties.part.text).toBe('abc')
  })

  it('joins mid-turn: asks for a seed, never emits partial text, merges the seed', () => {
    let clock = 0
    const projector = createProjector({ now: () => clock })
    expect(projector.push(at('session.next.text.delta', { timestamp: 5, assistantMessageID: mid, textID: 'text-0', delta: 'lo' }))).toEqual([])
    expect(projector.takeSeedRequests()).toEqual([{ sessionID: sid, messageID: mid }])
    const ended = projector.push(at('session.next.text.ended', { timestamp: 6, assistantMessageID: mid, textID: 'text-0', text: 'hello' }))
    expect(ended.map((o) => o.properties.part.text)).toEqual(['hello'])
    // no start seen: the message start stands in, so the UI stops "writing…"
    expect(ended[0]!.properties.part.time).toEqual({ start: 5, end: 6 })
    expect(projector.takeSeedRequests()).toEqual([]) // asked once

    const stored = toLegacyMessages([
      { id: mid, type: 'assistant', time: { created: 1 }, agent: 'plan', model: { id: 'm', providerID: 'p' }, content: [{ type: 'reasoning', id: 'reasoning-0', text: 'hmm', time: { created: 2, completed: 3 } }, { type: 'text', id: 'text-0', text: 'hel' }] }
    ], { sessionID: sid, active: true })[0]!
    const seeded = projector.seed(sid, mid, stored)
    expect(seeded[0]!.properties.info).toMatchObject({ id: mid, agent: 'plan', time: { created: 1 } })
    const parts = seeded.slice(1).map((o) => o.properties.part)
    expect(parts.map((p) => p.type)).toEqual(['step-start', 'reasoning', 'text'])
    expect(parts[2].text).toBe('hello') // ours is newer than the stored row
    expect(parts[2].time).toEqual({ start: 1, end: 6 })

    const done = projector.push(at('session.next.step.ended', { timestamp: 9, assistantMessageID: mid, finish: 'stop', cost: 0, tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } }))
    expect(done.at(-1)!.properties.info).toMatchObject({ agent: 'plan', time: { created: 1, completed: 9 }, finish: 'stop', tokens: { total: 3 } })
  })

  it('asks for unknown session infos and overlays live changes on the seed', () => {
    const projector = createProjector()
    expect(projector.push(at('session.next.agent.switched', { timestamp: 50, messageID: 'msg_1', agent: 'plan' }))).toEqual([])
    expect(projector.takeSeedRequests()).toEqual([{ sessionID: sid }])
    const out = projector.seedSession(sid, { id: sid, title: 'Mine', agent: 'build', time: { created: 1, updated: 2 } })
    // a fresh row is authoritative: overlays restart from it
    expect(out[0]!.properties.info).toMatchObject({ title: 'Mine', agent: 'build', directory: DIR })
    const switched = projector.push(at('session.next.model.switched', { timestamp: 60, messageID: 'msg_2', model: { id: 'm', providerID: 'p' } }))
    expect(switched[0]!.properties.info).toMatchObject({ title: 'Mine', agent: 'build', model: { id: 'm', providerID: 'p' } })
  })

  it('removes messages after a committed revert boundary', () => {
    const { all } = replay([
      at('session.created', { info: { id: sid, title: 'New session - 2026-01-01T00:00:00.000Z', time: { created: 0, updated: 0 } } }),
      at('session.next.prompted', { timestamp: 1, messageID: 'msg_100', prompt: { text: 'one' } }),
      at('session.next.step.started', { timestamp: 2, assistantMessageID: 'msg_101', agent: 'build', model: { id: 'm', providerID: 'p' } }),
      at('session.next.prompted', { timestamp: 3, messageID: 'msg_102', prompt: { text: 'two' } }),
      at('session.next.step.started', { timestamp: 4, assistantMessageID: 'msg_103', agent: 'build', model: { id: 'm', providerID: 'p' } }),
      at('session.next.revert.staged', { timestamp: 5, revert: { messageID: 'msg_101' } }),
      at('session.next.revert.committed', { timestamp: 6, messageID: 'msg_101' })
    ])
    expect(all.filter((o) => o.type === 'message.removed').map((o) => o.properties.messageID)).toEqual(['msg_102', 'msg_103'])
    expect(fold(all, sid).map((m) => m.info.id)).toEqual(['msg_100', 'msg_101'])
    expect(all.at(-1)!.properties.info.revert).toBeUndefined()
    expect(all.at(-1)!.properties.info.title).toBe('one')
  })

  it('maps shell runs and compaction like the REST snapshot', () => {
    const { all } = replay([
      at('session.next.shell.started', { timestamp: 10, messageID: 'msg_300', callID: 'sh1', command: 'ls' }),
      at('session.next.shell.ended', { timestamp: 20, callID: 'sh1', output: 'a.txt' }),
      at('session.next.compaction.started', { timestamp: 30, messageID: 'msg_301', reason: 'manual' }),
      at('session.next.compaction.delta', { timestamp: 31, messageID: 'msg_301', text: 'Sum' }),
      at('session.next.compaction.ended', { timestamp: 40, messageID: 'msg_301', reason: 'manual', text: 'Summary.', recent: '' })
    ])
    const [shell, compaction] = fold(all, sid)
    const rest = toLegacyMessages([
      { id: 'msg_300', type: 'shell', callID: 'sh1', command: 'ls', output: 'a.txt', time: { created: 10, completed: 20 } },
      { id: 'msg_301', type: 'compaction', reason: 'manual', summary: 'Summary.', recent: '', time: { created: 30 } }
    ], { sessionID: sid, session: { location: { directory: DIR } }, active: false })
    expect(shell!.info).toEqual(rest[0]!.info)
    expect(shell!.parts[0].id).toBe(rest[0]!.parts[0].id)
    expect(shell!.parts[0].state).toMatchObject({ status: 'completed', output: 'a.txt', title: 'ls', metadata: { output: 'a.txt' }, time: { start: 10, end: 20 } })
    expect(compaction!.info).toMatchObject({ summary: true, agent: 'compaction', finish: 'stop', time: { created: 30, completed: 40 } })
    expect(compaction!.parts).toEqual([{ ...rest[1]!.parts[0], time: { start: 30, end: 40 } }])
    expect(all.some((o) => o.type === 'session.compacted')).toBe(true)
  })

  it('evicts idle sessions unless kept', () => {
    let clock = 0
    const projector = createProjector({ now: () => clock })
    projector.push(step(0))
    projector.push({ ...step(0), data: { ...step(0).data, sessionID: 'ses_y' } })
    clock = 11 * 60_000
    expect(projector.evict(10 * 60_000, (id) => id === 'ses_y')).toBe(1)
    expect(projector.directoryOf(sid)).toBeUndefined()
    expect(projector.directoryOf('ses_y')).toBe(DIR)
  })
})

describe('mirror projector: v2 events on the legacy /event bus (1.18 hybrid)', () => {
  const legacy = readSse('legacy-event.sse.txt')

  it('recognizes the v2-only vocabulary', () => {
    expect(isV2EventType('session.next.text.delta')).toBe(true)
    expect(isV2EventType('permission.v2.asked')).toBe(true)
    expect(isV2EventType('question.v2.rejected')).toBe(true)
    expect(isV2EventType('message.updated')).toBe(false)
    expect(isV2EventType('session.created')).toBe(false)
  })

  it('passes legacy events through untouched and projects the rest like /api/event', () => {
    let clock = 0
    const mirror = createMirrorProjector({ now: () => clock })
    const out = legacy.flatMap((event) => {
      if (event.properties?.timestamp) clock = Date.parse(event.properties.timestamp)
      const res = mirror.push(event)
      if (!isV2EventType(event.type) && event.type !== 'session.created') expect(res).toEqual([event])
      return res
    })
    expect(out.some((o) => isV2EventType(o.type))).toBe(false)
    const events = out.map((o) => ({ type: o.type, properties: o.properties! }))
    // ISO timestamps on this bus: same milliseconds, same messages
    expect(fold(events, S1)).toEqual(fold(replay(api).all, S1))
    expect(fold(events, S3)).toEqual(fold(replay(api).all, S3))

    const created = out.findIndex((o) => o.type === 'session.created')
    expect(out[created + 1]).toMatchObject({ type: 'session.updated', properties: { sessionID: S1 } })
  })

  it('synthesizes status from events that end a run', () => {
    const mirror = createMirrorProjector()
    const statuses = legacy
      .flatMap((event) => mirror.push(event))
      .filter((o) => (o.type === 'session.status' || o.type === 'session.idle') && o.properties!.sessionID === S1)
      .map((o) => o.type === 'session.idle' ? 'idle!' : o.properties!.status.type)
    // text turn, tool turn, question turn, failed attachment turn
    expect(statuses).toEqual(['busy', 'idle', 'idle!', 'busy', 'idle', 'idle!', 'busy', 'idle', 'idle!', 'busy', 'idle', 'idle!'])
  })
})
