import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createV2Handler, v2Capabilities } from '../../server/utils/compat/v2/handlers'
import {
  answersToForm,
  applyLegacyPatch,
  configTarget,
  configToLegacy,
  flatPromptBody,
  formToQuestion,
  mcpStatusToLegacy,
  mcpToLegacy,
  mcpToNative,
  mergeInfos,
  parseJsonc,
  permissionTo118,
  splitConfig,
  within
} from '../../server/utils/compat/v2/next'
import { V2HttpError, type LegacyRequest, type MetaStore, type V2Client, type V2RequestOptions } from '../../server/utils/compat/v2/types'

// Captured by driving the adapter against a real opencode 2.0.29 (`@opencode/cli`)
// server: `calls` lists every /api request it made with the live answer.
interface Capture { method: string; path: string; query?: Record<string, unknown>; body?: unknown; status: number; response: unknown }
const capture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../fixtures/opencode-2x/handlers/${name}.json`, import.meta.url), 'utf8')) as { result?: { r?: unknown }; calls: Capture[] }

const WORK = 'C:\\work'

/** Replays recorded answers per "METHOD path" (in order, the last one repeats); records requests. */
function replay(calls: Capture[], extra: Record<string, unknown> = {}) {
  const queues = new Map<string, Capture[]>()
  for (const call of calls) {
    const key = `${call.method} ${call.path}`
    queues.set(key, [...(queues.get(key) || []), call])
  }
  const seen: Array<{ key: string; opts: V2RequestOptions }> = []
  const client: V2Client = {
    async request(path, opts = {}) {
      const key = `${opts.method || 'GET'} ${path}`
      seen.push({ key, opts })
      if (key in extra) return structuredClone(extra[key])
      const queue = queues.get(key)
      if (!queue?.length) throw new V2HttpError(404, { message: `no capture for ${key}` })
      const hit = queue.length > 1 ? queue.shift()! : queue[0]!
      if (hit.status >= 400) throw new V2HttpError(hit.status, hit.response as never)
      return structuredClone(hit.response)
    },
    async stream() {
      throw new Error('not used')
    }
  }
  const data = new Map<string, unknown>()
  const meta: MetaStore = {
    async get<T>(key: string) { return (data.get(key) as T) ?? null },
    async set(key: string, value: unknown) { data.set(key, value) }
  }
  const handle = createV2Handler({ client, meta, dialect: () => '2' })
  const req = (method: string, path: string, more: Partial<LegacyRequest> = {}) =>
    handle({ method, path, query: { directory: WORK }, ...more })
  return { req, seen }
}

describe('capabilities', () => {
  it('opencode 2.x unlocks MCP, config and the session routes; 1.18 stays as it was', () => {
    const two = v2Capabilities('2')
    expect(two).toMatchObject({ protocol: 'v2', dialect: '2', mcp: true, config: true, fork: true, diff: true, shell: true, cost: true, share: false })
    const hybrid = v2Capabilities()
    expect(hybrid).toMatchObject({ protocol: 'v2', mcp: false, config: false, fork: false })
    expect(hybrid.dialect).toBeUndefined()
  })
})

describe('MCP entries', () => {
  it('converts between the legacy and 2.x shapes', () => {
    const legacy = { type: 'remote', url: 'https://ha/api/mcp', headers: { Authorization: 'Bearer t' }, oauth: false as const, enabled: false, timeout: 30000 }
    const native = mcpToNative(legacy)
    expect(native).toEqual({
      type: 'remote',
      url: 'https://ha/api/mcp',
      headers: { Authorization: 'Bearer t' },
      oauth: false,
      disabled: true,
      timeout: { catalog: 30000, execution: 30000 }
    })
    expect(mcpToLegacy(native)).toEqual(legacy)
    expect(mcpToNative({ command: ['npx', '-y', 'pkg'], environment: {} })).toEqual({ type: 'local', command: ['npx', '-y', 'pkg'] })
    expect(mcpToLegacy({ type: 'remote', url: 'u', oauth: { client_id: 'c', scope: 's' } })).toEqual({ type: 'remote', url: 'u', oauth: { clientId: 'c', scope: 's' } })
  })

  it('maps the status list', () => {
    const live = capture('mcp').calls[0]!.response as { data: unknown }
    const status = mcpStatusToLegacy(live.data)
    expect(status.remote1).toEqual({ status: 'disabled' })
    expect(status.probe2).toEqual({ status: 'disabled' })
    expect(Object.keys(status).sort()).toEqual(['probe', 'probe2', 'remote1'])
  })
})

describe('config', () => {
  const entries = capture('config').calls.find((c) => c.path === '/api/config')!.response as any[]

  it('splits global and project documents and picks where a patch goes', () => {
    const { global, project } = splitConfig(entries, 'C:\\work')
    expect(global.map((e) => e.type)).toEqual(['document', 'directory'])
    expect(project.map((e) => e.path)).toEqual(['C:\\work\\opencode.json'])
    expect(configTarget(global)).toBe('C:\\cfg\\opencode.json')
    expect(configTarget(project)).toBe('C:\\work\\opencode.json')
    expect(configTarget([{ type: 'directory', path: 'C:\\cfg\\opencode' }])).toBe('C:\\cfg\\opencode\\opencode.json')
    expect(configTarget([], '/projects/app')).toBe('/projects/app/opencode.json')
    expect(within('c:/WORK/opencode.json', 'C:\\work')).toBe(true)
    expect(within('C:\\workshop\\x', 'C:\\work')).toBe(false)
  })

  it('never treats an opencode.json above the project as global or as a write target', () => {
    // 2.x loads config from every folder above the project: one of them may
    // be the user's own file, which must stay untouched
    const withAncestors = [
      { type: 'document', path: 'C:\\cfg\\opencode\\opencode.json', info: { model: 'mock/mock-model' } },
      { type: 'directory', path: 'C:\\cfg\\opencode' },
      { type: 'directory', path: 'C:\\Users\\me\\.claude' },
      { type: 'document', path: 'C:\\code\\opencode.json', info: { model: 'google/other' } },
      { type: 'directory', path: 'C:\\code\\.opencode' },
      { type: 'document', path: 'C:\\code\\app\\sub\\opencode.json', info: {} }
    ]
    const { global, project, inherited } = splitConfig(withAncestors, 'C:\\code\\app\\sub')
    expect(inherited.map((e) => e.path)).toEqual(['C:\\code\\opencode.json', 'C:\\code\\.opencode'])
    expect(global.map((e) => e.path)).toEqual(['C:\\cfg\\opencode\\opencode.json', 'C:\\cfg\\opencode', 'C:\\Users\\me\\.claude'])
    expect(configTarget(global)).toBe('C:\\cfg\\opencode\\opencode.json')
    expect(configTarget(project, 'C:\\code\\app\\sub')).toBe('C:\\code\\app\\sub\\opencode.json')
    // nothing written yet: the folder itself, never ~/.claude
    expect(configTarget([], 'C:\\code\\app')).toBe('C:\\code\\app\\opencode.json')
    expect(configTarget(global.filter((e) => e.type === 'directory'))).toBe('C:\\cfg\\opencode\\opencode.json')
  })

  it('turns the normalized document back into the legacy shape', () => {
    const legacy = configToLegacy(mergeInfos(entries.filter((e) => e.type === 'document').map((e) => e.info)))
    expect(legacy.model).toBe('mock/mock-model')
    expect(legacy.mcp.probe).toEqual({ type: 'local', command: ['node', 'C:/code/opencode-juanma/scripts/mock-stdio-mcp.mjs'] })
    expect(legacy.mcp.remote1).toMatchObject({ type: 'remote', oauth: false, enabled: false })
    expect(legacy.permission).toEqual({ shell: 'ask', 'probe2_*': 'ask' })
    // the project document's toggle wins over the global entry
    expect(legacy.mcp.probe2).toMatchObject({ type: 'remote', oauth: false, headers: { Authorization: 'Bearer zzz' } })
    expect(legacy.mcp.probe2.enabled).toBeUndefined()
    expect(legacy.provider.mock.options.baseURL).toBe('http://127.0.0.1:4951/v1')
    expect(legacy.autoupdate).toBe(false)
  })

  it('permission rules: the last rule for an action wins, denials also show as tools: false', () => {
    const out = configToLegacy({
      permissions: [
        { action: 'ctx7_*', resource: '*', effect: 'allow' },
        { action: 'ctx7_*', resource: '*', effect: 'ask' },
        { action: 'webfetch', resource: '*', effect: 'deny' },
        { action: 'read', resource: '*.env', effect: 'ask' }
      ]
    })
    expect(out.permission).toEqual({ 'ctx7_*': 'ask', webfetch: 'deny', read: { '*.env': 'ask' } })
    expect(out.tools).toEqual({ webfetch: false })
  })

  it('patches a v1 document like opencode 1.x did, completing enabled-only MCP entries', () => {
    const doc = { mcp: { a: { type: 'remote', url: 'u', enabled: false } }, permission: { bash: 'ask' } }
    const out = applyLegacyPatch(doc, { mcp: { a: { enabled: true }, b: { enabled: false } }, permission: { 'a_*': 'ask' } }, {
      b: { type: 'local', command: ['x'] }
    })
    expect(out.mcp).toEqual({ a: { type: 'remote', url: 'u', enabled: true }, b: { type: 'local', command: ['x'], enabled: false } })
    expect(out.permission).toEqual({ bash: 'ask', 'a_*': 'ask' })
  })

  it('patches a native document in its own format', () => {
    const doc = { mcp: { servers: { a: { type: 'remote', url: 'u' } } }, permissions: [{ action: 'a_*', resource: '*', effect: 'allow' }] }
    const out = applyLegacyPatch(doc, { mcp: { a: { enabled: false } }, permission: { 'a_*': 'ask' } })
    expect(out.mcp.servers.a).toEqual({ type: 'remote', url: 'u', disabled: true })
    expect(out.permissions).toEqual([{ action: 'a_*', resource: '*', effect: 'ask' }])
  })

  it('stores entries with 2.x-only keys natively, since 1.x-style entries lose them', () => {
    const doc = { mcp: { old: { type: 'local', command: ['x'] } } }
    const out = applyLegacyPatch(doc, { mcp: { ctl: { type: 'remote', url: 'http://web/mcp', oauth: false, codemode: false } } })
    expect(out.mcp.old).toEqual({ type: 'local', command: ['x'] })
    expect(out.mcp.ctl).toBeUndefined()
    expect(out.mcp.servers.ctl).toEqual({ type: 'remote', url: 'http://web/mcp', oauth: false, codemode: false })
    // later toggles of the 1.x-style server move it next to the native one
    const next = applyLegacyPatch(out, { mcp: { old: { enabled: false } } })
    expect(next.mcp.old).toBeUndefined()
    expect(next.mcp.servers.old).toEqual({ type: 'local', command: ['x'], disabled: true })
  })

  it('reads opencode.jsonc', () => {
    expect(parseJsonc('{\n  // model\n  "model": "a/b", /* x */ "url": "http://x//y",\n}')).toEqual({ model: 'a/b', url: 'http://x//y' })
  })
})

describe('prompts, questions, permissions', () => {
  it('flattens the 1.18 prompt body', () => {
    expect(flatPromptBody({ prompt: { text: 'hi', files: [{ uri: 'file:///a' }] }, id: 'msg_1', delivery: 'steer' }))
      .toEqual({ id: 'msg_1', text: 'hi', files: [{ uri: 'file:///a' }], delivery: 'steer' })
  })

  it('question forms become legacy question requests and answers map back', () => {
    const form = (capture('question').calls[0]!.response as any).data[0]
    expect(formToQuestion(form)).toEqual({
      id: form.id,
      sessionID: form.sessionID,
      questions: [{ question: 'Pick one?', header: 'Pick', options: [{ label: 'A', description: 'first' }, { label: 'B', description: 'second' }] }],
      tool: { messageID: form.metadata.tool.messageID, callID: form.metadata.tool.id }
    })
    expect(answersToForm(form, [['A']])).toEqual({ q0: 'A' })
    expect(answersToForm({ fields: [{ key: 'q0', type: 'multiselect', options: [] }] }, [['x', 'y']])).toEqual({ q0: ['x', 'y'] })
    expect(formToQuestion({ id: 'frm_1', metadata: { kind: 'oauth' }, fields: [] })).toBeUndefined()
  })

  it('permission sources get the legacy callID', () => {
    expect(permissionTo118({ id: 'per_1', source: { type: 'tool', messageID: 'm', id: 'call_1' } }).source)
      .toEqual({ type: 'tool', messageID: 'm', id: 'call_1', callID: 'call_1' })
  })
})

describe('handler on opencode 2.0.29 (recorded)', () => {
  it('health comes from /api/info', async () => {
    const { req } = replay(capture('health').calls)
    expect(await req('GET', 'global/health')).toEqual({ healthy: true, version: '2.0.29' })
  })

  it('GET /config and /global/config are legacy-shaped', async () => {
    const project = replay(capture('config').calls)
    const config = await project.req('GET', 'config') as any
    expect(config.mcp.remote1.enabled).toBe(false)
    expect(config.model).toBe('mock/mock-model')
    const global = replay(capture('globalconfig').calls)
    expect((await global.req('GET', 'global/config') as any).mcp.probe.type).toBe('local')
  })

  it('PATCH /global/config writes the document and reloads', async () => {
    const { req, seen } = replay(capture('patch-global').calls)
    const body = { mcp: { probe2: { type: 'remote', url: 'http://127.0.0.1:1/mcp', enabled: false } }, permission: { 'probe2_*': 'ask' } }
    await req('PATCH', 'global/config', { body })
    const write = seen.find((s) => s.key === 'POST /api/experimental/fs/write')!
    expect(write.opts.query).toEqual({ path: 'C:\\cfg\\opencode.json' })
    expect(write.opts.raw).toBe(true)
    const written = JSON.parse(String(write.opts.body))
    expect(written.mcp.probe2).toEqual(body.mcp.probe2)
    expect(written.mcp.probe.type).toBe('local') // the rest of the file is kept
    expect(written.permission['probe2_*']).toBe('ask')
    expect(seen.map((s) => s.key)).toContain('POST /api/location/reload')
  })

  it('a project toggle of a server only the global config defines goes to the global document', async () => {
    const calls = capture('patch-global').calls
    const { req, seen } = replay(calls)
    await req('PATCH', 'config', { body: { mcp: { probe: { enabled: false } } } })
    const writes = seen.filter((s) => s.key === 'POST /api/experimental/fs/write')
    expect(writes).toHaveLength(1)
    expect(writes[0]!.opts.query).toEqual({ path: 'C:\\cfg\\opencode.json' })
    expect(JSON.parse(String(writes[0]!.opts.body)).mcp.probe).toMatchObject({ type: 'local', enabled: false })
  })

  it('MCP add/connect use the experimental runtime routes with the 2.x config shape', async () => {
    const { req, seen } = replay(capture('mcp-add').calls, { 'POST /api/experimental/mcp/x/connect': undefined })
    await req('POST', 'mcp', { body: { name: 'rt', config: { type: 'remote', url: 'http://127.0.0.1:1/mcp', enabled: false } } })
    expect(seen[0]!.opts.body).toEqual({ config: { type: 'remote', url: 'http://127.0.0.1:1/mcp', disabled: true } })
    await req('POST', 'mcp/x/connect')
    expect(seen.at(-1)!.key).toBe('POST /api/experimental/mcp/x/connect')
    await expect(req('POST', 'mcp/x/auth')).rejects.toMatchObject({ status: 501 })
  })

  it('sync prompt: flat body, waits for the reply', async () => {
    const cap = capture('prompt')
    const { req, seen } = replay(cap.calls)
    const sessionID = (cap.calls[0]!.response as any).data.id
    const reply = await req('POST', `session/${sessionID}/message`, { body: { parts: [{ type: 'text', text: 'hello adapter' }] }, wait: true }) as any
    const prompt = seen.find((s) => s.key.endsWith('/prompt'))!
    expect(prompt.opts.body).toEqual({ text: 'hello adapter', delivery: 'steer' })
    expect(reply.info.role).toBe('assistant')
    expect(reply.parts.find((p: any) => p.type === 'text').text).toBe('Hello from the mock model.')
  })

  it('rename, fork and children use the real routes', async () => {
    const rename = capture('rename')
    const r = replay(rename.calls)
    const id = rename.calls[0]!.path.split('/').pop()!
    expect((await r.req('PATCH', `session/${id}`, { body: { title: 'Renamed by adapter' } }) as any).title).toBe('Renamed by adapter')
    expect(r.seen[0]!.opts.body).toEqual({ title: 'Renamed by adapter' })

    const fork = replay(capture('fork').calls)
    expect((await fork.req('POST', `session/${id}/fork`, { body: {} }) as any).title).toMatch(/fork #1/)

    const children = replay(capture('children').calls)
    const list = await children.req('GET', `session/${id}/children`) as any[]
    expect(children.seen[0]!.opts.query).toMatchObject({ parentID: id })
    expect(list.every((s) => s.parentID === id)).toBe(true)
  })

  it('questions are answered through forms, permissions with `decision`', async () => {
    const q = replay([...capture('question').calls, ...capture('question-reply').calls])
    const [question] = await q.req('GET', 'question') as any[]
    await q.req('POST', `question/${question.id}/reply`, { body: { answers: [['A']] } })
    expect(q.seen.at(-1)!.opts.body).toEqual({ answer: { q0: 'A' } })

    const p = replay([...capture('permission').calls, ...capture('permission-reply').calls])
    const [permission] = await p.req('GET', 'permission') as any[]
    expect(permission.callID).toMatch(/^call_/)
    await p.req('POST', `permission/${permission.id}/reply`, { body: { reply: 'once' } })
    expect(p.seen.at(-1)!.opts.body).toEqual({ decision: 'once' })
  })

  it('compact sends a body, commands go to the command route', async () => {
    const compact = replay(capture('compact').calls)
    const id = capture('compact').calls[0]!.path.split('/')[3]
    expect(await compact.req('POST', `session/${id}/summarize`, { body: {} })).toBe(true)
    expect(compact.seen[0]!.opts.body).toEqual({})

    const command = replay(capture('command').calls)
    await command.req('POST', `session/${id}/command`, { body: { command: 'review', arguments: 'uncommitted' }, wait: false })
    expect(command.seen.at(-1)!.opts.body).toEqual({ name: 'review', text: 'uncommitted', delivery: 'steer' })
  })

  it('the default model comes from /api/model/default', async () => {
    const { req } = replay(capture('providers').calls, { 'GET /api/model/default': { data: { providerID: 'mock', modelID: 'mock-model', id: 'mock-model' } } })
    const out = await req('GET', 'config/providers') as any
    expect(out.default).toEqual({ mock: 'mock-model' })
  })
})
