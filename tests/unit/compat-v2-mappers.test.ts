import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  assistantInfo,
  deriveTitle,
  expandCommand,
  isDefaultTitle,
  mapContent,
  mapError,
  mapToolState,
  normDir,
  occurrenceKey,
  partId,
  promptBody,
  revertBoundary,
  todosFromMessages,
  toLegacyAgents,
  toLegacyCommands,
  toLegacyFiles,
  toLegacyMessages,
  toLegacyPermission,
  toLegacyProviders,
  toLegacySession,
  toolTitle,
  userMessage
} from '../../server/utils/compat/v2/mappers'

// real captures from opencode 1.18.34 (see tests/fixtures/opencode-v2)
const raw = (name: string) =>
  JSON.parse(readFileSync(new URL(`../fixtures/opencode-v2/${name}`, import.meta.url), 'utf8'))
const fx = (name: string) => raw(name).body

const SID = 'ses_efb6b4642ffedDM7FFyDoLBC2c'
const finalMessages = fx('session-messages-final.json').data as any[]
const session = fx('session-get.json').data

describe('ids and errors', () => {
  it('mints deterministic part ids and suffixes repeated content keys', () => {
    expect(partId('msg_1', 'text-0')).toBe('prt_msg_1_text-0')
    const counts = new Map<string, number>()
    expect(['text-0', 'text-0', 'reasoning-0', 'text-0'].map((k) => occurrenceKey(counts, k)))
      .toEqual(['text-0', 'text-0_2', 'reasoning-0', 'text-0_3'])
  })

  it('names interrupts MessageAbortedError and everything else UnknownError', () => {
    expect(mapError(undefined)).toBeUndefined()
    expect(mapError({ message: 'Provider turn interrupted' })).toEqual({ name: 'MessageAbortedError', data: { message: 'Provider turn interrupted' } })
    expect(mapError({ message: 'Tool execution interrupted' })?.name).toBe('MessageAbortedError')
    expect(mapError({ message: 'HTTP transport failed' })).toEqual({ name: 'UnknownError', data: { message: 'HTTP transport failed' } })
  })

  it('titles tools like legacy opencode', () => {
    expect(toolTitle('bash', { command: 'ls -la' })).toBe('ls -la')
    expect(toolTitle('read', { filePath: 'README.md' })).toBe('README.md')
    expect(toolTitle('edit', { path: 'a.ts' })).toBe('a.ts')
    expect(toolTitle('grep', { pattern: 'foo' })).toBe('foo')
    expect(toolTitle('webfetch', { url: 'https://x' })).toBe('https://x')
    expect(toolTitle('websearch', { query: 'q' })).toBe('q')
    expect(toolTitle('todowrite', { todos: [{}, {}] })).toBe('2 todos')
    expect(toolTitle('question', { questions: [{}] })).toBe('Asked 1 question')
    expect(toolTitle('question', { questions: [{}, {}] })).toBe('Asked 2 questions')
    expect(toolTitle('skill', { description: 'Load a skill' })).toBe('Load a skill')
    expect(toolTitle('mystery', 'not an object')).toBe('mystery')
  })
})

describe('mapToolState', () => {
  const bash = finalMessages[3].content[0]
  const ids = { sessionID: SID, messageID: finalMessages[3].id }

  it('maps a completed bash call (captured) to the legacy shape', () => {
    expect(mapToolState(bash.name, bash.state, bash.time, ids)).toEqual({
      status: 'completed',
      input: { command: 'echo hello-from-bash', description: 'Echo test' },
      output: 'hello-from-bash\r\n\nCommand exited with code 0.',
      title: 'echo hello-from-bash',
      metadata: { exit: 0, truncated: false },
      time: { start: 1791078219969, end: 1791078220210 }
    })
  })

  it('maps pending, running and error states', () => {
    expect(mapToolState('bash', { status: 'pending', input: '{"comm' })).toEqual({ status: 'pending', input: {}, raw: '{"comm' })
    expect(mapToolState('bash', { status: 'running', input: { command: 'ls' }, structured: { pid: 1 }, content: [] }, { created: 5 }))
      .toEqual({ status: 'running', input: { command: 'ls' }, title: 'ls', metadata: { pid: 1 }, time: { start: 5 } })
    const read = fx('p2-messages.json').data[4].content[0]
    expect(mapToolState(read.name, read.state, read.time)).toEqual({
      status: 'error',
      input: { filePath: 'README.md' },
      error: 'Invalid tool input: Missing key\n  at ["path"]',
      metadata: {},
      time: { start: 1791078317498, end: 1791078317500 }
    })
  })

  it('keeps outputPaths/result in metadata and turns file content into attachments', () => {
    const state = mapToolState('webfetch', {
      status: 'completed',
      input: { url: 'https://x' },
      content: [{ type: 'text', text: 'ok' }, { type: 'file', uri: 'data:image/png;base64,AA==', mime: 'image/png', name: 'shot.png' }],
      structured: { a: 1 },
      outputPaths: ['/tmp/out'],
      result: { type: 'json', value: 1 }
    }, { created: 1, completed: 2 }, { sessionID: 's', messageID: 'm' }) as any
    expect(state.output).toBe('ok')
    expect(state.metadata).toEqual({ a: 1, outputPaths: ['/tmp/out'], result: { type: 'json', value: 1 } })
    expect(state.attachments).toHaveLength(1)
    expect(state.attachments[0]).toMatchObject({ sessionID: 's', messageID: 'm', type: 'file', mime: 'image/png', url: 'data:image/png;base64,AA==', filename: 'shot.png' })
    expect(state.attachments[0].id).toMatch(/^prt_m_att_/)
  })
})

describe('mapContent', () => {
  it('maps text, reasoning and tool items with ids', () => {
    const [reasoning, text] = finalMessages[1].content
    const ctx = { sessionID: SID, messageID: finalMessages[1].id }
    expect(mapContent(text, ctx)).toEqual({ id: `prt_${ctx.messageID}_text-0`, sessionID: SID, messageID: ctx.messageID, type: 'text', text: 'Hello from the mock model.' })
    expect(mapContent(reasoning, ctx)).toEqual({
      id: `prt_${ctx.messageID}_reasoning-0`,
      sessionID: SID,
      messageID: ctx.messageID,
      type: 'reasoning',
      text: 'Thinking about it.',
      time: { start: 1791078219110, end: 1791078219449 }
    })
    const tool = mapContent(finalMessages[3].content[0], { sessionID: SID, messageID: finalMessages[3].id, key: 'custom' }) as any
    expect(tool).toMatchObject({ id: `prt_${finalMessages[3].id}_custom`, type: 'tool', callID: 'call_1791078219959', tool: 'bash' })
    expect(tool.state.status).toBe('completed')
  })
})

describe('toLegacyMessages', () => {
  const legacy = fx('legacy-messages.json') as any[]
  const out = toLegacyMessages(finalMessages, { sessionID: SID, session, active: false, root: 'C:\\work' })

  it('mirrors the legacy runner structure for the same conversation', () => {
    // legacy capture: user, assistant(text), user, assistant(tool-calls), assistant(stop)
    const shape = (list: any[]) => list.map((m) => [m.info.role, m.parts.map((p: any) => p.type).join(',')])
    expect(shape(out.slice(0, 5))).toEqual(shape(legacy))
    expect(out.map((m) => m.info.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'assistant', 'user', 'assistant', 'assistant', 'user', 'assistant'])
  })

  it('links assistants to their prompt and fills legacy info fields', () => {
    const [user, assistant] = out
    expect(user!.info).toEqual({
      id: 'msg_10494bcd2001MeJ5OtI3voIbvz',
      sessionID: SID,
      role: 'user',
      time: { created: 1791078218963 },
      agent: 'build',
      model: { providerID: 'mock', modelID: 'mock-model' }
    })
    expect(user!.parts).toEqual([{ id: 'prt_msg_10494bcd2001MeJ5OtI3voIbvz_text', sessionID: SID, messageID: user!.info.id, type: 'text', text: 'hello there' }])
    // the same keys the legacy runner sends
    expect(Object.keys(assistant!.info).sort()).toEqual(
      Object.keys(legacy[1].info).filter((k) => k !== 'summary').sort()
    )
    expect(assistant!.info).toMatchObject({
      parentID: user!.info.id,
      modelID: 'mock-model',
      providerID: 'mock',
      agent: 'build',
      mode: 'build',
      path: { cwd: 'C:\\work', root: 'C:\\work' },
      finish: 'stop',
      tokens: { total: 132, input: 120, output: 12 }
    })
    // both assistants of the tool turn answer the same prompt
    expect(out[3]!.info.parentID).toBe(out[2]!.info.id)
    expect(out[4]!.info.parentID).toBe(out[2]!.info.id)
  })

  it('gives finished text parts the message bounds (no endless "writing…")', () => {
    const text = out[1]!.parts.find((p: any) => p.type === 'text')
    expect(text.time).toEqual({ start: 1791078219107, end: 1791078219687 })
    const finish = out[1]!.parts.at(-1)
    expect(finish).toMatchObject({ type: 'step-finish', reason: 'stop', cost: 0, id: `prt_${out[1]!.info.id}_finish` })
  })

  it('maps tool turns with the legacy tool state', () => {
    const tool = out[3]!.parts[1]
    expect(tool).toMatchObject({ type: 'tool', tool: 'bash', callID: 'call_1791078219959' })
    expect(Object.keys(tool.state).sort()).toEqual(Object.keys(legacy[3].parts[1].state).sort())
  })

  it('maps provider errors and file attachments', () => {
    const user = out[8]!
    expect(user.parts[1]).toEqual({
      id: `prt_${user.info.id}_file_0`,
      sessionID: SID,
      messageID: user.info.id,
      type: 'file',
      mime: 'text/plain',
      filename: 'note.txt',
      url: 'data:text/plain;base64,YXR0YWNoZWQh'
    })
    const failed = out[9]!
    expect(failed.info.error).toEqual({ name: 'UnknownError', data: { message: 'OpenAI Chat does not support media type text/plain' } })
    expect(failed.info.finish).toBe('error')
    expect(failed.parts.map((p: any) => p.type)).toEqual(['step-start'])
  })

  it('marks interrupts as aborted', () => {
    const list = toLegacyMessages(fx('session-messages-interrupted.json').data, { sessionID: 'ses_c', active: false })
    expect(list[1]!.info.error).toEqual({ name: 'MessageAbortedError', data: { message: 'Provider turn interrupted' } })
    expect(list[1]!.parts.find((p: any) => p.type === 'text').text).toBe('w0 w1 w2 w3 w4 w5 w6 w7 ')
  })

  it('completes zombie assistants once the session is idle (question reject)', () => {
    const messages = raw('p4-reject.json').messages.data
    const idle = toLegacyMessages(messages, { sessionID: 'ses_r', active: false })
    const zombie = idle.at(-1)!
    expect(zombie.info.time).toEqual({ created: 1791078636395, completed: 1791078636600 })
    expect(zombie.info.error).toEqual({ name: 'MessageAbortedError', data: { message: 'Interrupted' } })
    // still running: left alone so the UI shows the turn as busy
    const busy = toLegacyMessages(messages, { sessionID: 'ses_r', active: true })
    expect(busy.at(-1)!.info.time.completed).toBeUndefined()
    expect(busy.at(-1)!.info.error).toBeUndefined()
  })

  it('handles synthetic, shell, compaction, switches and repeated text ids', () => {
    const list = toLegacyMessages([
      { id: 'msg_01', type: 'user', text: 'hi', time: { created: 1 } },
      { id: 'msg_02', type: 'agent-switched', agent: 'plan', time: { created: 2 } },
      { id: 'msg_03', type: 'model-switched', model: { id: 'm2', providerID: 'p2', variant: 'high' }, time: { created: 3 } },
      { id: 'msg_04', type: 'system', text: 'hidden context', time: { created: 4 } },
      { id: 'msg_05', type: 'synthetic', sessionID: 's', text: 'continue', time: { created: 5 } },
      {
        id: 'msg_06',
        type: 'assistant',
        agent: 'plan',
        model: { id: 'm2', providerID: 'p2' },
        time: { created: 6, completed: 9 },
        finish: 'stop',
        content: [
          { type: 'text', id: 'text-0', text: 'a' },
          { type: 'tool', id: 'call_1', name: 'bash', state: { status: 'completed', input: { command: 'x' }, content: [], structured: {} }, time: { created: 7, completed: 8 } },
          { type: 'text', id: 'text-0', text: 'b' }
        ]
      },
      { id: 'msg_07', type: 'shell', callID: 'sh_1', command: 'ls', output: 'a\n', time: { created: 10, completed: 11 } },
      { id: 'msg_08', type: 'compaction', reason: 'auto', summary: 'the summary', recent: '', time: { created: 12 } }
    ], { sessionID: 's', active: false, session: { agent: 'build', location: { directory: '/work' } } })

    expect(list.map((m) => m.info.id)).toEqual(['msg_01', 'msg_05', 'msg_06', 'msg_07', 'msg_08'])
    // first prompt: agent/model of the assistant that answered it
    expect(list[0]!.info).toMatchObject({ agent: 'plan', model: { providerID: 'p2', modelID: 'm2' } })
    // after the switches
    expect(list[1]!.info).toMatchObject({ role: 'user', agent: 'plan', model: { providerID: 'p2', modelID: 'm2', variant: 'high' } })
    expect(list[1]!.parts[0]).toMatchObject({ type: 'text', text: 'continue', synthetic: true })
    expect(list[2]!.info.parentID).toBe('msg_05')
    expect(list[2]!.parts.map((p: any) => p.id)).toEqual(['prt_msg_06_start', 'prt_msg_06_text-0', 'prt_msg_06_call_1', 'prt_msg_06_text-0_2', 'prt_msg_06_finish'])
    expect(list[3]!.info).toMatchObject({ role: 'assistant', agent: 'plan', time: { created: 10, completed: 11 }, finish: 'stop' })
    expect(list[3]!.parts[0]).toMatchObject({
      type: 'tool',
      tool: 'bash',
      callID: 'sh_1',
      state: { status: 'completed', input: { command: 'ls' }, output: 'a\n', title: 'ls' }
    })
    expect(list[4]!.info).toMatchObject({ role: 'assistant', summary: true, agent: 'compaction' })
    expect(list[4]!.parts[0]).toMatchObject({ type: 'text', text: 'the summary' })
  })

  it('hides messages after a staged revert boundary', () => {
    const reverted = fx('session-get-reverted.json').data
    const list = toLegacyMessages(finalMessages, { sessionID: SID, session: reverted, active: false })
    expect(list.at(-1)!.info.id).toBe(reverted.revert.messageID)
    expect(list).toHaveLength(9)
  })

  it('keeps a running tool of an interrupted zombie from spinning forever', () => {
    const list = toLegacyMessages([
      { id: 'msg_1', type: 'user', text: 'x', time: { created: 1 } },
      { id: 'msg_2', type: 'assistant', agent: 'build', model: { id: 'm', providerID: 'p' }, time: { created: 2 }, content: [{ type: 'tool', id: 'c', name: 'bash', state: { status: 'running', input: { command: 'sleep' }, structured: {}, content: [] }, time: { created: 3, ran: 4 } }] }
    ], { sessionID: 's', active: false })
    expect(list[1]!.parts[1].state).toMatchObject({ status: 'error', error: 'Interrupted' })
  })
})

describe('derived data', () => {
  it('reads todos from the last completed todowrite', () => {
    expect(todosFromMessages(fx('p2-messages.json').data)).toEqual([{ content: 'Write spec', status: 'in_progress', priority: 'high' }])
    expect(todosFromMessages(finalMessages)).toBeUndefined()
  })

  it('computes undo boundaries (v2 keeps the boundary message)', () => {
    // undo the last turn: keep everything before the last prompt
    expect(revertBoundary(finalMessages)).toBe('msg_10494c5e6001lO2AoxTYg5LCCo')
    // undo again from a staged boundary: walk back one more prompt
    expect(revertBoundary(finalMessages, { current: 'msg_10494c5e6001lO2AoxTYg5LCCo' })).toBe('msg_10494c296001E2uxlSAEkrO7nb')
    // legacy messageID = first message to drop
    expect(revertBoundary(finalMessages, { firstDropped: 'msg_10494c0080012jkK2IKinYPc6x' })).toBe('msg_10494bd63001w10jbw8MSjAtsS')
    // the first turn cannot be undone
    expect(revertBoundary(finalMessages, { firstDropped: 'msg_10494bcd2001MeJ5OtI3voIbvz' })).toBeUndefined()
    expect(revertBoundary(finalMessages.slice(0, 2))).toBeUndefined()
  })

  it('derives titles and recognizes placeholder titles', () => {
    expect(deriveTitle('\n  fix the   login bug\nsecond line')).toBe('fix the login bug')
    expect(deriveTitle('x'.repeat(80))).toHaveLength(60)
    expect(deriveTitle('   ')).toBeUndefined()
    expect(isDefaultTitle('New session - 2026-10-04T01:43:38.402Z')).toBe(true)
    expect(isDefaultTitle('Hello')).toBe(false)
  })

  it('normalizes directories for comparison', () => {
    expect(normDir('C:\\Work\\')).toBe('c:/work')
    expect(normDir('C:\\')).toBe('c:/')
    expect(normDir('/srv/App/')).toBe('/srv/App')
    expect(normDir('/')).toBe('/')
  })
})

describe('sessions, permissions, catalog', () => {
  it('maps a session with meta overrides', () => {
    expect(toLegacySession(session, { title: 'My chat', lastActivity: 1791078230000 })).toEqual({
      id: SID,
      projectID: '3bcca03b01b621f067a74daf1e82cafb99a60546',
      directory: 'C:\\work',
      path: '',
      title: 'My chat',
      version: 'v2',
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1791078218402, updated: 1791078230000 }
    })
    const reverted = toLegacySession(fx('session-get-reverted.json').data)
    expect(reverted).toMatchObject({ title: 'New session - 2026-10-04T01:43:38.402Z', agent: 'plan', model: { id: 'mock-model', providerID: 'mock', variant: 'high' } })
    expect(reverted.revert.messageID).toBe('msg_10494c855001JLoejBBaKA7B0l')
  })

  it('maps permission requests to the legacy shape plus the UI fields', () => {
    const [request] = fx('permission-request-pending.json').data
    const legacyKeys = Object.keys(fx('legacy-permission-list.json')[0])
    const out = toLegacyPermission(request)
    for (const key of legacyKeys) expect(out).toHaveProperty(key)
    expect(out).toEqual({
      id: 'per_10494c0f1001xyOhKTBH54c57b',
      sessionID: SID,
      permission: 'bash',
      patterns: ['echo hello-from-bash'],
      always: ['echo hello-from-bash'],
      metadata: {},
      tool: { messageID: 'msg_10494c0b9001fUpVyXoD5KT9I9', callID: 'call_1791078219959' },
      title: 'Run: echo hello-from-bash',
      type: 'bash',
      pattern: ['echo hello-from-bash'],
      messageID: 'msg_10494c0b9001fUpVyXoD5KT9I9',
      callID: 'call_1791078219959'
    })
    expect(toLegacyPermission({ id: 'per_2', sessionID: 's', action: 'edit', resources: ['a.ts', 'b.ts'] }).title).toBe('edit: a.ts, b.ts')
  })

  it('maps providers and models without leaking credentials', () => {
    const out = toLegacyProviders(fx('provider.json').data, fx('model.json').data)
    const json = JSON.stringify(out)
    for (const secret of ['sk-mock', 'sk-dead', 'apiKey', '"api"', '"request"', 'public']) expect(json).not.toContain(secret)
    expect(out.default).toEqual({})
    expect(out.providers.map((p) => p.id)).toEqual(['opencode', 'mock', 'dead'])
    const mock = out.providers[1]
    expect(mock).toMatchObject({ id: 'mock', name: 'Mock', source: 'v2', env: [] })
    expect(mock.models['mock-model']).toMatchObject({
      id: 'mock-model',
      providerID: 'mock',
      capabilities: { toolcall: true, reasoning: false },
      reasoning: false,
      limit: { context: 100000, output: 4096 },
      variants: {}
    })
    expect(out.providers[0].models['fledge-alpha-free']).toMatchObject({
      release_date: '2026-10-01',
      attachment: true,
      capabilities: { attachment: true, input: { text: true, image: true, pdf: false } },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }
    })
  })

  it('keeps variant options but drops variant headers and secrets; filters disabled entries', () => {
    const out = toLegacyProviders(
      [{ id: 'p', name: 'P', api: { settings: { apiKey: 'x' } } }, { id: 'off', name: 'Off', disabled: true }],
      [
        { id: 'm', providerID: 'p', name: 'M', capabilities: { tools: false, input: ['text'], output: ['text'] }, variants: [{ id: 'high', headers: { authorization: 'Bearer s' }, body: { reasoningEffort: 'high', apiKey: 's' } }], cost: [{ tier: 'big', input: 9, output: 9 }, { input: 1, output: 2, cache: { read: 0.1, write: 0.2 } }], enabled: true, time: {}, limit: { context: 1, output: 1 } },
        { id: 'hidden', providerID: 'p', name: 'H', capabilities: { input: [] }, variants: [], enabled: false }
      ]
    )
    expect(out.providers).toHaveLength(1)
    expect(Object.keys(out.providers[0].models)).toEqual(['m'])
    expect(out.providers[0].models.m).toMatchObject({ reasoning: true, variants: { high: { reasoningEffort: 'high' } }, cost: { input: 1, output: 2, cache: { read: 0.1, write: 0.2 } } })
    expect(JSON.stringify(out)).not.toMatch(/Bearer|apiKey/)
  })

  it('maps agents', () => {
    const agents = toLegacyAgents(fx('agent.json').data)
    expect(agents.map((a) => [a.name, a.mode, a.hidden])).toEqual([
      ['build', 'primary', false],
      ['plan', 'primary', false],
      ['general', 'subagent', false],
      ['explore', 'subagent', false],
      ['compaction', 'primary', true],
      ['title', 'primary', true],
      ['summary', 'primary', true]
    ])
    expect(agents[0].permission[0]).toEqual({ permission: '*', pattern: '*', action: 'allow' })
    expect(agents[0].prompt).toMatch(/AI coding agent/)
    expect(toLegacyAgents([{ id: 'x', model: { id: 'm', providerID: 'p', variant: 'high' } }])[0]).toMatchObject({ model: { providerID: 'p', modelID: 'm' }, variant: 'high' })
  })

  it('lists commands and slash skills', () => {
    const list = toLegacyCommands(fx('command.json').data, [...fx('skill.json').data, { name: 'quiet', content: 'x', slash: false }])
    expect(list.map((c) => [c.name, c.source])).toEqual([['init', 'command'], ['review', 'command'], ['customize-opencode', 'skill']])
    expect(list[0]).toMatchObject({ description: 'guided AGENTS.md setup' })
    expect(list[0].template).toContain('$ARGUMENTS')
    expect(list[1].subtask).toBe(true)
    expect(toLegacyCommands([{ name: 'c', template: 't', model: { id: 'm', providerID: 'p' } }])[0].model).toBe('p/m')
  })

  it('maps directory listings (native separators, trailing slash = directory)', () => {
    expect(toLegacyFiles(fx('fs-list.json').data, 'C:\\work')).toEqual([
      { name: '.git', path: '.git', absolute: 'C:\\work\\.git', type: 'directory', ignored: false },
      { name: 'src', path: 'src', absolute: 'C:\\work\\src', type: 'directory', ignored: false },
      { name: 'README.md', path: 'README.md', absolute: 'C:\\work\\README.md', type: 'file', ignored: false }
    ])
    expect(toLegacyFiles(fx('fs-list-sub.json').data, 'C:\\work\\')[0]).toEqual(
      { name: 'index.ts', path: 'src/index.ts', absolute: 'C:\\work\\src\\index.ts', type: 'file', ignored: false }
    )
    expect(toLegacyFiles([{ path: 'app/', type: 'directory' }], '/srv')[0]).toMatchObject({ name: 'app', absolute: '/srv/app' })
    expect(toLegacyFiles([{ path: 'srv/', type: 'directory' }], '/')[0]).toMatchObject({ absolute: '/srv' })
  })
})

describe('prompts and commands', () => {
  it('expands command templates like legacy opencode', () => {
    expect(expandCommand('Focus: $ARGUMENTS', 'the api')).toBe('Focus: the api')
    expect(expandCommand('from $1 to $2', 'a b c')).toBe('from a to b c')
    expect(expandCommand('one $1 two $2', '"quoted arg" x')).toBe('one quoted arg two x')
    expect(expandCommand('$1 and $3', 'a')).toBe('a and')
    expect(expandCommand('Do it.', 'extra words')).toBe('Do it.\n\nextra words')
    expect(expandCommand('Do it.', '')).toBe('Do it.')
  })

  it('builds the v2 prompt body and inlines text attachments', () => {
    const body = promptBody({
      parts: [
        { type: 'file', mime: 'text/plain', filename: 'note.txt', url: 'data:text/plain;base64,YXR0YWNoZWQh' },
        { type: 'file', mime: 'application/json', filename: 'a.json', url: 'data:application/json,%7B%22a%22%3A1%7D' },
        { type: 'file', mime: 'image/png', filename: 'shot.png', url: 'data:image/png;base64,iVBORw0KGgo=' },
        { type: 'text', text: 'make a todo' },
        { type: 'agent', name: 'explore' }
      ],
      model: { providerID: 'mock', modelID: 'mock-model' },
      tools: { foo: false },
      messageID: 'msg_custom'
    })
    expect(body).toEqual({
      id: 'msg_custom',
      delivery: 'steer',
      prompt: {
        text: 'make a todo\n\nnote.txt:\n```\nattached!\n```\n\na.json:\n```\n{"a":1}\n```',
        files: [{ uri: 'data:image/png;base64,iVBORw0KGgo=', name: 'shot.png' }],
        agents: [{ name: 'explore' }]
      }
    })
  })

  it('handles noReply, foreign ids and backticks in attachments', () => {
    const body = promptBody({
      parts: [{ type: 'file', filename: 'x.md', url: `data:text/markdown,${encodeURIComponent('```js\nx\n```')}` }],
      messageID: 'not-a-msg-id',
      noReply: true
    })
    expect(body.id).toBeUndefined()
    expect(body.resume).toBe(false)
    expect(body.prompt.text).toBe('x.md:\n````\n```js\nx\n```\n````')
  })

  it('maps an admitted prompt back to a user message', () => {
    const admitted = fx('session-prompt-todo.json').data
    const msg = userMessage({ id: admitted.id, time: { created: admitted.timeCreated }, ...admitted.prompt }, { sessionID: SID })
    expect(msg.info).toEqual({ id: admitted.id, sessionID: SID, role: 'user', time: { created: 1791078221909 }, agent: 'build' })
    expect(msg.parts.map((p) => p.type)).toEqual(['text', 'file'])
  })

  it('builds assistant info for a message without tokens', () => {
    const info = assistantInfo({ id: 'msg_x', time: { created: 1 }, agent: 'build', model: { id: 'm', providerID: 'p', variant: 'high' } }, { sessionID: 's', directory: '/w' })
    expect(info).toEqual({
      id: 'msg_x',
      sessionID: 's',
      role: 'assistant',
      time: { created: 1 },
      modelID: 'm',
      providerID: 'p',
      variant: 'high',
      agent: 'build',
      mode: 'build',
      path: { cwd: '/w', root: '/w' },
      cost: 0,
      tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    })
  })
})
