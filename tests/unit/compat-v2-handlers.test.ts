import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createV2Handler, META_KEYS, v2Capabilities } from '../../server/utils/compat/v2/handlers'
import { CompatError, V2HttpError } from '../../server/utils/compat/v2/types'
import type { LegacyRequest, MetaStore, V2Client, V2RequestOptions } from '../../server/utils/compat/v2/types'

// real captures from opencode 1.18.34 (see tests/fixtures/opencode-v2)
const raw = (name: string) =>
  JSON.parse(readFileSync(new URL(`../fixtures/opencode-v2/${name}`, import.meta.url), 'utf8'))
const fx = (name: string) => raw(name).body

const DIR = 'C:\\work'
const SID = 'ses_efb6b4642ffedDM7FFyDoLBC2c'
const finalMessages = fx('session-messages-final.json').data as any[]

type Reply = unknown | ((opts: V2RequestOptions, calls: Call[]) => unknown)
interface Call { path: string; opts: V2RequestOptions }

/** V2Client double: answers `"<METHOD> <path>"` from a table and records every call. */
function fakeClient(table: Record<string, Reply>) {
  const calls: Call[] = []
  const client: V2Client = {
    async request(path, opts = {}) {
      calls.push({ path, opts })
      const key = `${opts.method || 'GET'} ${path}`
      if (!(key in table)) throw new V2HttpError(404, { _tag: 'NotFound', message: `no fake for ${key}` })
      const entry = table[key]
      const value = typeof entry === 'function' ? await (entry as any)(opts, calls) : entry
      return value === undefined ? undefined : structuredClone(value)
    },
    async stream() {
      throw new Error('not used')
    }
  }
  return { client, calls }
}

function memoryMeta(initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial))
  const store: MetaStore = {
    async get<T>(key: string) {
      return (data.has(key) ? structuredClone(data.get(key)) : null) as T | null
    },
    async set(key: string, value: unknown) {
      data.set(key, structuredClone(value))
    }
  }
  return { store, data }
}

function setup(table: Record<string, Reply>, opts: { meta?: Record<string, unknown>; now?: () => number } = {}) {
  const { client, calls } = fakeClient(table)
  const meta = memoryMeta(opts.meta)
  const handle = createV2Handler({ client, meta: meta.store, now: opts.now })
  const req = (method: string, path: string, extra: Partial<LegacyRequest> = {}) =>
    handle({ method, path, query: {}, ...extra })
  const paths = () => calls.map((c) => `${c.opts.method || 'GET'} ${c.path}`)
  return { req, calls, paths, meta: meta.data }
}

const location = fx('location-query.json')
const sessionRes = { data: fx('session-get.json').data }
const noMessages = { data: [], cursor: {} }

async function rejects(promise: Promise<unknown>, status: number, message?: RegExp) {
  const error = await promise.then(() => undefined, (e) => e)
  expect(error).toBeInstanceOf(CompatError)
  expect(error.status).toBe(status)
  if (message) expect(error.message).toMatch(message)
}

describe('capabilities and routing', () => {
  it('advertises what v2 can do', () => {
    expect(v2Capabilities()).toEqual({
      protocol: 'v2',
      mcp: false,
      config: false,
      sessionRename: true,
      sessionDelete: true,
      fork: false,
      share: false,
      diff: false,
      shell: false,
      compact: true,
      revert: true,
      questions: true,
      permissions: true,
      todos: true,
      cost: false
    })
  })

  it('answers 501 for features v2 lacks and 404 for unknown routes', async () => {
    const { req, calls } = setup({})
    await rejects(req('POST', 'session/ses_1/shell', { body: { command: 'ls' } }), 501, /Not supported by opencode v2: shell/)
    await rejects(req('POST', 'session/ses_1/fork'), 501)
    await rejects(req('POST', 'session/ses_1/share'), 501)
    await rejects(req('POST', 'session/ses_1/diff'), 501)
    await rejects(req('PATCH', 'config', { body: {} }), 501, /config editing/)
    await rejects(req('PATCH', 'global/config', { body: {} }), 501)
    await rejects(req('POST', 'mcp', { body: {} }), 501, /MCP/)
    await rejects(req('POST', 'mcp/hotel/connect'), 501)
    await rejects(req('GET', 'experimental/tool/ids'), 404, /Unknown opencode route/)
    expect(await req('GET', 'mcp')).toEqual({})
    expect(await req('GET', 'global/config')).toEqual({})
    expect(calls).toHaveLength(0)
  })

  it('checks health via /api/health and passes the request signal through', async () => {
    const { req, calls } = setup({ 'GET /api/health': { healthy: true } })
    const signal = new AbortController().signal
    expect(await req('GET', 'app', { signal })).toEqual({ healthy: true })
    expect(calls[0]).toEqual({ path: '/api/health', opts: { signal } })
  })
})

describe('discovery', () => {
  it('GET /path -> /api/location', async () => {
    const { req, calls } = setup({ 'GET /api/location': location })
    expect(await req('GET', 'path', { query: { directory: DIR } })).toEqual({ directory: DIR, worktree: DIR })
    expect(calls).toEqual([{ path: '/api/location', opts: { directory: DIR } }])
  })

  it('GET /file lists relative to the directory', async () => {
    const { req, calls } = setup({
      'GET /api/fs/list': (opts: V2RequestOptions) => (opts.query?.path === 'src' ? fx('fs-list-sub.json') : fx('fs-list.json'))
    })
    const top = await req('GET', 'file', { query: { directory: DIR, path: '.' } }) as any[]
    expect(top.map((e) => [e.name, e.type, e.absolute])).toEqual([
      ['.git', 'directory', 'C:\\work\\.git'],
      ['src', 'directory', 'C:\\work\\src'],
      ['README.md', 'file', 'C:\\work\\README.md']
    ])
    await req('GET', 'file', { query: { directory: DIR, path: 'src' } })
    await req('GET', 'file', { query: { directory: DIR, path: 'C:\\work\\src' } })
    expect(calls.map((c) => c.opts)).toEqual([
      { directory: DIR },
      { directory: DIR, query: { path: 'src' } },
      { directory: DIR, query: { path: 'src' } }
    ])
    await rejects(req('GET', 'file', { query: { directory: DIR, path: 'D:\\elsewhere' } }), 400)
  })

  it('GET /config/providers: no secrets, default from the last model used here', async () => {
    const table = {
      'GET /api/provider': fx('provider.json'),
      'GET /api/model': fx('model.json'),
      'GET /api/agent': fx('agent.json')
    }
    const fresh = setup(table)
    const first = await fresh.req('GET', 'config/providers', { query: { directory: DIR } }) as any
    expect(JSON.stringify(first)).not.toMatch(/sk-mock|apiKey/)
    // no meta yet, build agent has no model: first model of the first provider
    expect(first.default).toEqual({ opencode: 'fledge-alpha-free' })
    expect(fresh.calls).toEqual([
      { path: '/api/provider', opts: { directory: DIR } },
      { path: '/api/model', opts: { directory: DIR } },
      { path: '/api/agent', opts: { directory: DIR } }
    ])

    const used = setup(table, { meta: { [META_KEYS.lastModel]: { 'c:/work': { providerID: 'mock', modelID: 'mock-model' } } } })
    expect((await used.req('GET', 'config/providers', { query: { directory: DIR } }) as any).default).toEqual({ mock: 'mock-model' })
    expect(used.paths()).toEqual(['GET /api/provider', 'GET /api/model'])
    expect(await used.req('GET', 'config', { query: { directory: 'c:/work/' } })).toEqual({ model: 'mock/mock-model' })
    expect(await used.req('GET', 'config', { query: { directory: '/elsewhere' } })).toEqual({})
  })

  it('GET /agent and GET /command', async () => {
    const { req, calls } = setup({
      'GET /api/agent': fx('agent.json'),
      'GET /api/command': fx('command.json'),
      'GET /api/skill': fx('skill.json')
    })
    const agents = await req('GET', 'agent', { query: { directory: DIR } }) as any[]
    expect(agents.map((a) => a.name)).toContain('plan')
    const commands = await req('GET', 'command', { query: { directory: DIR } }) as any[]
    expect(commands.map((c) => c.name)).toEqual(['init', 'review', 'customize-opencode'])
    // cached per directory
    await req('GET', 'command', { query: { directory: DIR } })
    expect(calls.map((c) => c.path)).toEqual(['/api/agent', '/api/command', '/api/skill'])
  })

  it('PUT /auth/:provider connects the integration with a key', async () => {
    const { req, calls } = setup({
      'GET /api/provider/mock': { data: { id: 'mock', integrationID: 'mock-int' } },
      'POST /api/integration/mock-int/connect/key': undefined,
      'POST /api/integration/anthropic/connect/key': undefined
    })
    expect(await req('PUT', 'auth/mock', { query: { directory: DIR }, body: { type: 'api', key: 'sk-1' } })).toBe(true)
    // unknown provider (404): the integration id is the provider id
    expect(await req('PUT', 'auth/anthropic', { body: { type: 'api', key: 'sk-2' } })).toBe(true)
    expect(calls.map((c) => [c.path, c.opts])).toEqual([
      ['/api/provider/mock', { directory: DIR }],
      ['/api/integration/mock-int/connect/key', { method: 'POST', directory: DIR, body: { key: 'sk-1' } }],
      ['/api/provider/anthropic', {}],
      ['/api/integration/anthropic/connect/key', { method: 'POST', body: { key: 'sk-2' } }]
    ])
    await rejects(req('PUT', 'auth/x', { body: { type: 'oauth' } }), 501)
  })

  it('GET /project derives projects from sessions and locations', async () => {
    const other = { ...fx('session-get.json').data, id: 'ses_other', location: { directory: 'C:\\work\\sub' }, time: { created: 5, updated: 5 } }
    const { req, calls } = setup({
      'GET /api/session': { data: [fx('session-get.json').data, other], cursor: {} },
      'GET /api/location': (opts: V2RequestOptions) => opts.directory === '/known'
        ? { directory: '/known', project: { id: 'global', directory: '/' } }
        : { ...location, directory: opts.directory ?? DIR }
    }, { meta: { [META_KEYS.directories]: ['/known'] } })
    const projects = await req('GET', 'project') as any[]
    expect(projects).toEqual([
      { id: '3bcca03b01b621f067a74daf1e82cafb99a60546', worktree: DIR, time: { created: 5, updated: 1791078218402 } },
      { id: 'global', worktree: '/', time: {} }
    ])
    expect(calls[0]).toEqual({ path: '/api/session', opts: { query: { limit: 200 } } })
  })
})

describe('sessions', () => {
  it('lists sessions of a directory with paging, meta titles and hidden sessions', async () => {
    const base = fx('session-get.json').data
    const page1 = Array.from({ length: 200 }, (_, i) => ({ ...base, id: `ses_${String(i).padStart(3, '0')}` }))
    const { req, calls } = setup({
      'GET /api/location': location,
      'GET /api/session': (opts: V2RequestOptions) => opts.query?.cursor
        ? { data: [{ ...base, id: 'ses_last' }], cursor: { next: 'c2' } }
        : { data: page1, cursor: { next: 'c1' } }
    }, {
      meta: { [META_KEYS.sessions]: { ses_000: { hidden: true }, ses_001: { title: 'Renamed', lastActivity: 1791078999999 } } }
    })
    const list = await req('GET', 'session', { query: { directory: DIR } }) as any[]
    expect(list).toHaveLength(200)
    expect(list[0]).toMatchObject({ id: 'ses_001', title: 'Renamed', time: { updated: 1791078999999 }, directory: DIR, version: 'v2' })
    expect(list.at(-1).id).toBe('ses_last')
    expect(calls.map((c) => [c.path, c.opts])).toEqual([
      ['/api/location', { directory: DIR }],
      ['/api/session', { query: { directory: DIR, limit: 200 } }],
      ['/api/session', { query: { cursor: 'c1', limit: 200 } }]
    ])
  })

  it('creates sessions in the directory and keeps the title in meta', async () => {
    const { req, calls, meta } = setup({ 'POST /api/session': fx('session-create.json') })
    const created = await req('POST', 'session', { query: { directory: DIR }, body: { title: 'Planning' } }) as any
    expect(created).toMatchObject({ id: SID, title: 'Planning', directory: DIR, version: 'v2' })
    expect(calls).toEqual([{ path: '/api/session', opts: { method: 'POST', body: { location: { directory: DIR } } } }])
    expect(meta.get(META_KEYS.sessions)).toEqual({ [SID]: { title: 'Planning' } })
    expect(meta.get(META_KEYS.directories)).toEqual([DIR])
  })

  it('renames and soft-deletes through meta', async () => {
    const { req, meta, paths } = setup({ [`GET /api/session/${SID}`]: sessionRes, 'GET /api/session': { data: [sessionRes.data], cursor: {} } })
    expect(await req('PATCH', `session/${SID}`, { body: { title: '  New name ' } })).toMatchObject({ id: SID, title: 'New name' })
    expect(await req('GET', `session/${SID}`)).toMatchObject({ title: 'New name' })
    expect(await req('DELETE', `session/${SID}`)).toBe(true)
    expect(meta.get(META_KEYS.sessions)).toEqual({ [SID]: { title: 'New name', hidden: true } })
    await rejects(req('GET', `session/${SID}`), 404)
    expect(await req('GET', 'session')).toEqual([])
    expect(paths()).toEqual([
      `GET /api/session/${SID}`,
      `GET /api/session/${SID}`,
      `GET /api/session/${SID}`,
      `GET /api/session/${SID}`,
      'GET /api/session'
    ])
  })

  it('lets v2 errors through for unknown sessions', async () => {
    const { req } = setup({})
    const error = await req('GET', 'session/ses_doesnotexist').catch((e) => e)
    expect(error).toBeInstanceOf(V2HttpError)
    expect(error.status).toBe(404)
  })

  it('aborts via interrupt and reports busy sessions', async () => {
    const { req, calls } = setup({
      [`POST /api/session/${SID}/interrupt`]: undefined,
      'GET /api/session/active': fx('session-active-busy.json')
    })
    expect(await req('POST', `session/${SID}/abort`)).toBe(true)
    expect(await req('GET', 'session/status')).toEqual({ [SID]: { type: 'busy' } })
    expect(calls[0]).toEqual({ path: `/api/session/${SID}/interrupt`, opts: { method: 'POST' } })
  })
})

describe('messages and todos', () => {
  const table = {
    [`GET /api/session/${SID}`]: sessionRes,
    'GET /api/session/active': fx('session-active-empty.json'),
    'GET /api/location': location,
    [`GET /api/session/${SID}/message`]: (opts: V2RequestOptions) =>
      opts.query?.order === 'desc'
        ? { data: [...finalMessages].reverse().slice(0, Number(opts.query.limit)), cursor: { next: 'x' } }
        : { data: finalMessages, cursor: { next: 'n1' } }
  }

  it('GET /session/:id/message pages ascending and maps to legacy', async () => {
    const { req, calls } = setup(table)
    const list = await req('GET', `session/${SID}/message`, { query: { directory: DIR } }) as any[]
    expect(list).toHaveLength(10)
    expect(list[1].info).toMatchObject({ role: 'assistant', parentID: list[0].info.id, path: { cwd: DIR, root: DIR } })
    expect(calls.map((c) => [c.path, c.opts])).toEqual([
      [`/api/session/${SID}`, {}],
      ['/api/session/active', {}],
      [`/api/session/${SID}/message`, { query: { order: 'asc', limit: 200 } }],
      ['/api/location', { directory: DIR }]
    ])
  })

  it('GET /session/:id/message?limit=N reads the newest N', async () => {
    const { req, calls } = setup(table)
    const list = await req('GET', `session/${SID}/message`, { query: { limit: '2' } }) as any[]
    expect(list.map((m) => m.info.role)).toEqual(['user', 'assistant'])
    expect(list[0].info.id).toBe('msg_10494c855001JLoejBBaKA7B0l')
    expect(calls[2]).toEqual({ path: `/api/session/${SID}/message`, opts: { query: { order: 'desc', limit: 2 } } })
  })

  it('GET /session/:id/message/:mid finds one message', async () => {
    const { req } = setup(table)
    expect(await req('GET', `session/${SID}/message/msg_10494c296001E2uxlSAEkrO7nb`)).toMatchObject({ info: { parentID: 'msg_10494c0080012jkK2IKinYPc6x' } })
    await rejects(req('GET', `session/${SID}/message/msg_nope`), 404)
  })

  it('GET /session/:id/todo derives todos from the last todowrite', async () => {
    const { req, calls } = setup({ 'GET /api/session/ses_t/message': { data: [...fx('p2-messages.json').data].reverse(), cursor: { next: 'x' } } })
    expect(await req('GET', 'session/ses_t/todo')).toEqual([{ content: 'Write spec', status: 'in_progress', priority: 'high' }])
    expect(calls).toEqual([{ path: '/api/session/ses_t/message', opts: { query: { order: 'desc', limit: 200 } } }])
    const empty = setup({ 'GET /api/session/ses_t/message': noMessages })
    expect(await empty.req('GET', 'session/ses_t/todo')).toEqual([])
  })
})

describe('prompts', () => {
  const reverted = { data: fx('session-get-reverted.json').data }

  it('commits a staged revert, switches model and agent, then prompts (async)', async () => {
    const { req, calls, meta } = setup({
      [`GET /api/session/${SID}`]: reverted,
      [`POST /api/session/${SID}/revert/commit`]: undefined,
      [`POST /api/session/${SID}/model`]: undefined,
      [`POST /api/session/${SID}/agent`]: undefined,
      [`POST /api/session/${SID}/prompt`]: fx('session-prompt-text.json')
    }, { now: () => 1791078300000 })
    const out = await req('POST', `session/${SID}/message`, {
      query: { directory: DIR },
      wait: false,
      body: {
        parts: [{ type: 'text', text: 'hello there\nmore' }],
        model: { providerID: 'mock', modelID: 'mock-model' },
        agent: 'build',
        tools: { hotel_search: false }
      }
    })
    expect(out).toEqual({})
    expect(calls.map((c) => [c.path, c.opts])).toEqual([
      [`/api/session/${SID}`, {}],
      [`/api/session/${SID}/revert/commit`, { method: 'POST' }],
      // session has variant "high", the prompt none: switch
      [`/api/session/${SID}/model`, { method: 'POST', body: { model: { id: 'mock-model', providerID: 'mock' } } }],
      [`/api/session/${SID}/agent`, { method: 'POST', body: { agent: 'build' } }],
      [`/api/session/${SID}/prompt`, { method: 'POST', body: { prompt: { text: 'hello there\nmore' }, delivery: 'steer' } }]
    ])
    expect(meta.get(META_KEYS.sessions)).toEqual({ [SID]: { title: 'hello there', titleDerived: true, lastActivity: 1791078300000 } })
    expect(meta.get(META_KEYS.lastModel)).toEqual({ 'c:/work': { providerID: 'mock', modelID: 'mock-model' } })
  })

  it('skips switches that would not change anything and keeps renamed titles', async () => {
    const session = { ...reverted.data, revert: undefined, agent: 'plan', model: { id: 'mock-model', providerID: 'mock', variant: 'high' } }
    const { req, paths, meta } = setup({
      [`GET /api/session/${SID}`]: { data: session },
      [`POST /api/session/${SID}/prompt`]: fx('session-prompt-text.json')
    }, { meta: { [META_KEYS.sessions]: { [SID]: { title: 'Mine' } } }, now: () => 7 })
    await req('POST', `session/${SID}/message`, {
      wait: false,
      body: { parts: [{ type: 'text', text: 'again' }], model: { providerID: 'mock', modelID: 'mock-model' }, variant: 'high', agent: 'plan' }
    })
    expect(paths()).toEqual([`GET /api/session/${SID}`, `POST /api/session/${SID}/prompt`])
    expect(meta.get(META_KEYS.sessions)).toEqual({ [SID]: { title: 'Mine', lastActivity: 7 } })
  })

  it('treats the stored "default" variant as no variant', async () => {
    // after a switch without variant the server reports variant "default"
    const session = { ...reverted.data, revert: undefined, agent: 'build', model: { id: 'dead-model', providerID: 'dead', variant: 'default' } }
    const { req, paths } = setup({
      [`GET /api/session/${SID}`]: { data: session },
      [`POST /api/session/${SID}/prompt`]: fx('session-prompt-text.json')
    })
    await req('POST', `session/${SID}/message`, {
      wait: false,
      body: { parts: [{ type: 'text', text: 'x' }], model: { providerID: 'dead', modelID: 'dead-model' }, agent: 'build' }
    })
    expect(paths()).toEqual([`GET /api/session/${SID}`, `POST /api/session/${SID}/prompt`])
  })

  it('inlines text attachments and keeps images as files', async () => {
    const { req, calls } = setup({
      [`GET /api/session/${SID}`]: sessionRes,
      [`POST /api/session/${SID}/prompt`]: fx('session-prompt-todo.json')
    })
    await req('POST', `session/${SID}/prompt_async`, {
      body: {
        parts: [
          { type: 'file', mime: 'text/plain', filename: 'note.txt', url: 'data:text/plain;base64,YXR0YWNoZWQh' },
          { type: 'file', mime: 'image/png', filename: 'a.png', url: 'data:image/png;base64,AA==' },
          { type: 'text', text: 'make a todo' }
        ]
      }
    })
    expect(calls[1]!.opts.body).toEqual({
      prompt: { text: 'make a todo\n\nnote.txt:\n```\nattached!\n```', files: [{ uri: 'data:image/png;base64,AA==', name: 'a.png' }] },
      delivery: 'steer'
    })
  })

  it('waits for the reply in sync mode and returns the last assistant message', async () => {
    let polls = 0
    const desc = [...finalMessages.slice(0, 5)].reverse()
    const { req, paths } = setup({
      [`GET /api/session/${SID}`]: sessionRes,
      [`POST /api/session/${SID}/prompt`]: fx('session-prompt-bash.json'),
      'GET /api/location': location,
      'GET /api/session/active': () => (++polls < 3 ? fx('session-active-busy.json') : fx('session-active-empty.json')),
      [`GET /api/session/${SID}/message`]: { data: desc, cursor: {} }
    })
    const reply = await req('POST', `session/${SID}/message`, { body: { parts: [{ type: 'text', text: 'please run bash' }] } }) as any
    expect(reply.info).toMatchObject({ id: 'msg_10494c296001E2uxlSAEkrO7nb', role: 'assistant', parentID: 'msg_10494c0080012jkK2IKinYPc6x', finish: 'stop' })
    expect(reply.parts.filter((p: any) => p.type === 'text').map((p: any) => p.text)).toEqual(['Tool finished OK.'])
    expect(paths().filter((p) => p === 'GET /api/session/active')).toHaveLength(3)
    expect(paths().at(-1)).toBe(`GET /api/session/${SID}/message`)
  })

  it('returns a reply that finished before the first poll', async () => {
    const { req, calls } = setup({
      [`GET /api/session/${SID}`]: sessionRes,
      [`POST /api/session/${SID}/prompt`]: fx('session-prompt-text.json'),
      'GET /api/location': location,
      'GET /api/session/active': fx('session-active-empty.json'),
      [`GET /api/session/${SID}/message`]: { data: [...finalMessages.slice(0, 2)].reverse(), cursor: {} }
    })
    const reply = await req('POST', `session/${SID}/message`, { body: { parts: [{ type: 'text', text: 'hello there' }] } }) as any
    expect(reply.info.id).toBe('msg_10494bd63001w10jbw8MSjAtsS')
    expect(calls.at(-1)).toEqual({ path: `/api/session/${SID}/message`, opts: { query: { order: 'desc', limit: 50 } } })
  })

  it('answers 502 when nothing starts within 15 s', async () => {
    let clock = 0
    const { req } = setup({
      [`GET /api/session/${SID}`]: sessionRes,
      [`POST /api/session/${SID}/prompt`]: fx('session-prompt-text.json'),
      'GET /api/location': location,
      'GET /api/session/active': fx('session-active-empty.json'),
      [`GET /api/session/${SID}/message`]: { data: [finalMessages[0]], cursor: {} }
    }, { now: () => (clock += 4000) })
    await rejects(req('POST', `session/${SID}/message`, { body: { parts: [{ type: 'text', text: 'hello there' }] } }), 502, /did not start/)
  })

  it('stops waiting when the caller aborts', async () => {
    const controller = new AbortController()
    const { req } = setup({
      [`GET /api/session/${SID}`]: sessionRes,
      [`POST /api/session/${SID}/prompt`]: fx('session-prompt-text.json'),
      'GET /api/location': location,
      'GET /api/session/active': () => {
        controller.abort(new DOMException('timed out', 'TimeoutError'))
        return fx('session-active-busy.json')
      }
    })
    await rejects(req('POST', `session/${SID}/message`, { signal: controller.signal, body: { parts: [{ type: 'text', text: 'x' }] } }), 504)
  })

  it('runs slash commands by expanding their template', async () => {
    const { req, calls } = setup({
      [`GET /api/session/${SID}`]: sessionRes,
      'GET /api/command': { ...fx('command.json'), data: [{ name: 'greet', template: 'Say hi to $1, then $2', agent: 'plan', model: { id: 'mock-model', providerID: 'mock' } }] },
      'GET /api/skill': fx('skill.json'),
      [`POST /api/session/${SID}/model`]: undefined,
      [`POST /api/session/${SID}/agent`]: undefined,
      [`POST /api/session/${SID}/prompt`]: fx('session-prompt-text.json')
    })
    expect(await req('POST', `session/${SID}/command`, { wait: false, body: { command: 'greet', arguments: 'Ann and Bob' } })).toEqual({})
    expect(calls.map((c) => [c.path, c.opts])).toEqual([
      [`/api/session/${SID}`, {}],
      ['/api/command', { directory: DIR }],
      ['/api/skill', { directory: DIR }],
      [`/api/session/${SID}/model`, { method: 'POST', body: { model: { id: 'mock-model', providerID: 'mock' } } }],
      [`/api/session/${SID}/agent`, { method: 'POST', body: { agent: 'plan' } }],
      [`/api/session/${SID}/prompt`, { method: 'POST', body: { prompt: { text: 'Say hi to Ann, then and Bob' }, delivery: 'steer' } }]
    ])
    await rejects(req('POST', `session/${SID}/command`, { body: { command: 'nope' } }), 404, /Unknown command/)
    // skills run as commands too
    await req('POST', `session/${SID}/command`, { wait: false, body: { command: 'customize-opencode', arguments: '' } })
    expect((calls.at(-1)!.opts.body as any).prompt.text).toMatch(/^---|opencode/)
  })
})

describe('compact and revert', () => {
  it('maps the 503 of compact to a readable error', async () => {
    const compact = raw('session-compact.json')
    const { req } = setup({
      [`POST /api/session/${SID}/compact`]: () => { throw new V2HttpError(compact.status, compact.body) }
    })
    await rejects(req('POST', `session/${SID}/summarize`, { body: {} }), 503, /^Session compact is not available yet$/)
    const ok = setup({ [`POST /api/session/${SID}/compact`]: undefined })
    expect(await ok.req('POST', `session/${SID}/summarize`)).toBe(true)
  })

  it('stages the boundary before the last prompt (legacy undo) and clears it on redo', async () => {
    const { req, calls } = setup({
      [`GET /api/session/${SID}`]: sessionRes,
      [`GET /api/session/${SID}/message`]: { data: finalMessages, cursor: {} },
      [`POST /api/session/${SID}/revert/stage`]: fx('session-revert-stage.json'),
      [`POST /api/session/${SID}/revert/clear`]: undefined
    })
    expect(await req('POST', `session/${SID}/revert`, { body: {} })).toBe(true)
    expect(calls.at(-1)).toEqual({
      path: `/api/session/${SID}/revert/stage`,
      opts: { method: 'POST', body: { messageID: 'msg_10494c5e6001lO2AoxTYg5LCCo', files: true } }
    })
    // explicit legacy messageID = first message to drop
    await req('POST', `session/${SID}/revert`, { body: { messageID: 'msg_10494c0080012jkK2IKinYPc6x' } })
    expect((calls.at(-1)!.opts.body as any).messageID).toBe('msg_10494bd63001w10jbw8MSjAtsS')
    await rejects(req('POST', `session/${SID}/revert`, { body: { messageID: 'msg_10494bcd2001MeJ5OtI3voIbvz' } }), 409)
    await rejects(req('POST', `session/${SID}/revert`, { body: { messageID: 'msg_unknown' } }), 404)
    expect(await req('POST', `session/${SID}/unrevert`)).toBe(true)
    expect(calls.at(-1)).toEqual({ path: `/api/session/${SID}/revert/clear`, opts: { method: 'POST' } })
  })

  it('walks back from an already staged boundary', async () => {
    const { req, calls } = setup({
      [`GET /api/session/${SID}`]: { data: { ...sessionRes.data, revert: { messageID: 'msg_10494c5e6001lO2AoxTYg5LCCo' } } },
      [`GET /api/session/${SID}/message`]: { data: finalMessages, cursor: {} },
      [`POST /api/session/${SID}/revert/stage`]: fx('session-revert-stage.json')
    })
    await req('POST', `session/${SID}/revert`, { body: {} })
    expect((calls.at(-1)!.opts.body as any).messageID).toBe('msg_10494c296001E2uxlSAEkrO7nb')
  })
})

describe('questions and permissions', () => {
  const questions = fx('question-request-pending.json')
  const permissions = fx('permission-request-pending.json')
  const QID = 'que_10494c4940018MjCGebkhiFKZY'
  const PID = 'per_10494c0f1001xyOhKTBH54c57b'

  it('lists questions as-is and replies with the cached session', async () => {
    const { req, calls } = setup({
      'GET /api/question/request': questions,
      [`POST /api/session/${SID}/question/${QID}/reply`]: undefined
    })
    expect(await req('GET', 'question', { query: { directory: DIR } })).toEqual(questions.data)
    expect(await req('POST', `question/${QID}/reply`, { query: { directory: DIR }, body: { answers: [['A']] } })).toBe(true)
    expect(calls.map((c) => [c.path, c.opts])).toEqual([
      ['/api/question/request', { directory: DIR }],
      [`/api/session/${SID}/question/${QID}/reply`, { method: 'POST', body: { answers: [['A']] } }]
    ])
  })

  it('refetches the pending list when the question is not cached', async () => {
    const { req, paths } = setup({
      'GET /api/question/request': questions,
      [`POST /api/session/${SID}/question/${QID}/reject`]: undefined
    })
    expect(await req('POST', `question/${QID}/reject`, { query: { directory: DIR }, body: {} })).toBe(true)
    expect(paths()).toEqual(['GET /api/question/request', `POST /api/session/${SID}/question/${QID}/reject`])
    await rejects(req('POST', 'question/que_gone/reject', { query: { directory: DIR } }), 404)
    await rejects(req('POST', `question/${QID}/reply`, { body: { answers: 'A' } }), 400)
  })

  it('lists permissions in legacy shape and replies on both legacy routes', async () => {
    const { req, calls } = setup({
      'GET /api/permission/request': permissions,
      [`POST /api/session/${SID}/permission/${PID}/reply`]: undefined
    })
    const list = await req('GET', 'permission', { query: { directory: DIR } }) as any[]
    expect(list[0]).toMatchObject({ id: PID, sessionID: SID, title: 'Run: echo hello-from-bash', permission: 'bash' })
    expect(await req('POST', `session/${SID}/permissions/${PID}`, { body: { response: 'once' } })).toBe(true)
    expect(await req('POST', `permission/${PID}/reply`, { query: { directory: DIR }, body: { reply: 'reject', message: 'no' } })).toBe(true)
    expect(calls.map((c) => [c.path, c.opts])).toEqual([
      ['/api/permission/request', { directory: DIR }],
      [`/api/session/${SID}/permission/${PID}/reply`, { method: 'POST', body: { reply: 'once' } }],
      // the first reply dropped the cache entry: looked up again
      ['/api/permission/request', { directory: DIR }],
      [`/api/session/${SID}/permission/${PID}/reply`, { method: 'POST', body: { reply: 'reject', message: 'no' } }]
    ])
    await rejects(req('POST', `session/${SID}/permissions/${PID}`, { body: { response: 'sometimes' } }), 400)
  })
})
