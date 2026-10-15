import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

// Runs against a real opencode server (see playwright.compat.config.ts) and a
// deterministic mock model: the same user journeys must work on every
// supported opencode version and on the v2 protocol.
// same folder as scripts/compat-server.mjs (outside the checkout)
const ROOT = path.resolve(process.env.COMPAT_ROOT || path.join(os.tmpdir(), 'opencode-web-compat'))
const WORK = path.join(ROOT, 'work')
/** every request the mock model got, with the tools it was offered (scripts/compat-server.mjs) */
const MOCK_LOG = path.join(ROOT, 'mock-llm.log')
const DIR = Buffer.from(WORK).toString('base64url')
// opencode 2.x (`@opencode/cli`) only speaks the v2 API, MCP included
const IS_2X = /^2(\.|-latest$)/.test(process.env.OPENCODE_VERSION || '')
const PROTOCOL = process.env.COMPAT_PROTOCOL === 'v2' || IS_2X ? 'v2' : 'legacy'
/** MCP works on every 1.x server through the legacy API, and on 2.x */
const HAS_MCP = PROTOCOL === 'legacy' || IS_2X

/** Is the server under test at least `min`? ("latest" always is.) */
function atLeast(min: string) {
  const version = process.env.OPENCODE_VERSION
  if (!version || version === 'latest' || IS_2X) return true
  const a = version.split('.').map(Number)
  const b = min.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0)
  return true
}

async function newChat(page: Page) {
  await page.goto(`/p/${DIR}`)
  await page.getByRole('button', { name: 'New chat' }).first().click()
  await expect(page).toHaveURL(/\/session\/ses_/)
}

async function send(page: Page, text: string) {
  const box = page.getByPlaceholder(/Ask opencode/)
  await box.fill(text)
  await box.press('Enter')
}

test('detects the server protocol', async ({ request }) => {
  const caps = await (await request.get('/api/v1/capabilities')).json()
  expect(caps.protocol).toBe(PROTOCOL)
  expect(caps.mcp).toBe(HAS_MCP)
})

test('streams a reply and unlocks the prompt box', async ({ page }) => {
  await newChat(page)
  await send(page, 'hello there')
  await expect(page.locator('.oc-markdown').getByText('Hello from the mock model.')).toBeVisible()
  // the server reported idle: no "working" badge, the queue would send now
  await expect(page.getByText('working', { exact: true })).toHaveCount(0)
})

test('tool call behind a permission prompt', async ({ page }) => {
  await newChat(page)
  await send(page, 'please run bash')
  await expect(page.getByText('Permission required')).toBeVisible()
  await page.getByRole('button', { name: 'Allow once' }).click()
  await expect(page.getByText('Tool finished OK.')).toBeVisible()
  await expect(page.getByText('Permission required')).toHaveCount(0)
})

test('question tool is answered from the UI', async ({ page }) => {
  test.skip(!atLeast('1.1.65'), 'opencode < 1.1.65 has no question tool')
  await newChat(page)
  await send(page, 'ask me something')
  await expect(page.getByText('Pick one?').first()).toBeVisible()
  // a single single-choice question is sent as soon as an option is picked
  await page.locator('button', { hasText: 'first' }).first().click()
  await expect(page.getByText('Tool finished OK.')).toBeVisible()
})

test('a reload mid-permission still shows the prompt', async ({ page }) => {
  // pending permissions can only be listed (GET /permission) since 1.0.224
  test.skip(!atLeast('1.0.224'), 'opencode < 1.0.224 cannot list pending permissions')
  await newChat(page)
  await send(page, 'run bash again')
  await expect(page.getByText('Permission required')).toBeVisible()
  await page.reload()
  await expect(page.getByText('Permission required')).toBeVisible()
  await page.getByRole('button', { name: 'Reject' }).click()
  await expect(page.getByText('Permission required')).toHaveCount(0)
})

test('REST prompt waits for the full reply', async ({ request }) => {
  const session = await (await request.post('/api/v1/sessions', { data: { directory: WORK } })).json()
  expect(session.id).toMatch(/^ses_/)
  const res = await request.post(`/api/v1/sessions/${session.id}/prompt`, {
    data: { directory: WORK, text: 'hello again' },
    timeout: 150_000
  })
  expect(res.ok()).toBeTruthy()
  expect((await res.json()).text).toContain('Hello from the mock model.')
})

test('MCP send_prompt answers through the same adapter', async ({ request }) => {
  const res = await request.post('/mcp', {
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_prompt', arguments: { directory: WORK, text: 'hi via mcp' } } },
    timeout: 150_000
  })
  const text = (await res.json()).result.content[0].text as string
  expect(text).toContain('Hello from the mock model.')
})

test('a scheduled prompt runs and records the reply', async ({ request }) => {
  const created = await (await request.post('/api/v1/schedules', {
    data: { name: 'compat', directory: WORK, prompt: 'hello from a schedule', cron: '@yearly', session: 'reuse' }
  })).json()
  try {
    const run = await (await request.post(`/api/v1/schedules/${created.id}/run`)).json()
    expect(run.sessionID).toMatch(/^ses_/)
    await expect.poll(async () => {
      const list = await (await request.get('/api/v1/schedules', { params: { directory: WORK } })).json()
      return list.find((s: { id: string }) => s.id === created.id)?.runs[0]?.reply || ''
    }, { timeout: 120_000 }).toContain('Hello from the mock model.')
  } finally {
    await request.delete(`/api/v1/schedules/${created.id}`)
  }
})

test('agent control: the chat calls this app\'s MCP tools', async ({ request }) => {
  test.skip(!HAS_MCP, 'the v2 API of 1.x servers has no MCP')
  const installed = await (await request.post('/api/v1/control-mcp', { data: {}, timeout: 150_000 })).json()
  expect(installed.status?.status).toBe('connected')

  const session = await (await request.post('/api/v1/sessions', { data: { directory: WORK } })).json()
  // the mock model turns "call <tool> {json}" into that tool call
  await request.post(`/api/v1/sessions/${session.id}/prompt`, {
    data: { directory: WORK, text: `call opencode-web_session_status ${JSON.stringify({ directory: WORK })}` },
    timeout: 150_000
  })
  const messages = await (await request.get(`/api/v1/sessions/${session.id}/messages`, { params: { directory: WORK } })).json()
  const call = messages.flatMap((m: { parts: Array<{ type: string; tool?: string; state?: { status?: string } }> }) => m.parts)
    .find((p: { type: string; tool?: string }) => p.type === 'tool' && p.tool === 'opencode-web_session_status')
  expect(call?.state?.status).toBe('completed')
})

test('subagents: the task runs in a child session linked from the chat', async ({ page, request }) => {
  test.skip(PROTOCOL === 'v2' && !IS_2X, 'the v2 runner of 1.x servers has no subagent tool')
  await newChat(page)
  // 1.x calls it `task`, 2.x `subagent`
  const call = IS_2X
    ? `call subagent ${JSON.stringify({ agent: 'general', description: 'probe', prompt: 'say hi' })}`
    : `call task ${JSON.stringify({ description: 'probe', prompt: 'say hi', subagent_type: 'general' })}`
  await send(page, call)
  const card = page.getByText('@general').first()
  await expect(card).toBeVisible()
  const open = page.getByRole('link', { name: /Open the general subagent/ })
  await expect(open).toBeVisible()
  await expect(page.getByText('Result', { exact: true })).toBeVisible()

  // the child is a real session with a parent, reachable and linked back
  await open.click()
  await expect(page).toHaveURL(/\/session\/ses_/)
  await expect(page.getByRole('link', { name: 'Back to the parent conversation' })).toBeVisible()
  const sessions = await (await request.get('/api/v1/sessions', { params: { directory: WORK } })).json()
  expect(sessions.some((s: { parentID?: string }) => s.parentID)).toBe(true)
})

test('MCP servers: add, test, reload opencode, still connected', async ({ request, baseURL }) => {
  if (!HAS_MCP) {
    // the v2 API of 1.x servers has no MCP and cannot reload: both say so
    expect((await request.post('/api/v1/reload', { data: { scope: 'all', when: 'now' } })).status()).toBe(501)
    return
  }
  const saved = await (await request.put('/api/v1/mcp-server', {
    data: { name: 'compat-demo', scope: 'global', directory: WORK, config: { type: 'remote', url: `${baseURL}/mcp-demo` } },
    timeout: 150_000
  })).json()
  expect(saved.status?.status).toBe('connected')

  const tested = await (await request.post('/api/v1/mcp-test', { data: { name: 'compat-demo', directory: WORK }, timeout: 120_000 })).json()
  expect(tested.ok).toBe(true)
  expect(tested.tools.length).toBeGreaterThan(0)

  await request.post('/api/v1/reload', { data: { scope: 'all', when: 'now' } })
  await expect.poll(async () => (await (await request.get('/api/v1/reload')).json())?.state, { timeout: 60_000 }).toBe('done')
  await expect.poll(async () => {
    const info = await (await request.get('/api/v1/mcp-server', { params: { name: 'compat-demo', directory: WORK } })).json()
    return info.status?.status
  }, { timeout: 60_000 }).toBe('connected')
})

test('subagent per MCP: the orchestrator delegates, the specialist only has its server', async ({ request, baseURL }) => {
  test.skip(!HAS_MCP, 'the v2 API of 1.x servers has no MCP')
  const saved = await (await request.put('/api/v1/mcp-server', {
    data: { name: 'nest-demo', scope: 'global', directory: WORK, config: { type: 'remote', url: `${baseURL}/mcp-demo` } },
    timeout: 150_000
  })).json()
  expect(saved.status?.status).toBe('connected')
  try {
    const plan = await (await request.put('/api/v1/mcp-nest', { data: { enabled: true }, timeout: 150_000 })).json()
    expect(Object.keys(plan.agents)).toEqual(expect.arrayContaining(['orchestrator', 'mcp-nest-demo']))
    await expect.poll(async () => (await (await request.get('/api/v1/reload')).json())?.state, { timeout: 60_000 }).toBe('done')
    await expect.poll(async () => {
      const agents = await (await request.get('/api/opencode/agent', { params: { directory: WORK } })).json()
      return agents.map((a: { name: string }) => a.name)
    }, { timeout: 30_000 }).toEqual(expect.arrayContaining(['orchestrator', 'mcp-nest-demo']))

    const session = await (await request.post('/api/v1/sessions', { data: { directory: WORK } })).json()
    const call = IS_2X
      ? `call subagent ${JSON.stringify({ agent: 'mcp-nest-demo', description: 'demo', prompt: 'nest probe' })}`
      : `call task ${JSON.stringify({ subagent_type: 'mcp-nest-demo', description: 'demo', prompt: 'nest probe' })}`
    await request.post(`/api/v1/sessions/${session.id}/prompt`, { data: { directory: WORK, agent: 'orchestrator', text: call }, timeout: 150_000 })

    // what the mock model was offered: the specialist only nest-demo's tools,
    // the orchestrator none of them
    const log = readFileSync(MOCK_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { userText: string; tools: string[] })
    const specialist = log.filter((l) => l.userText.includes('nest probe') && !l.userText.startsWith('call') && l.tools.length).at(-1)
    expect(specialist?.tools.length).toBeGreaterThan(0)
    expect(specialist?.tools.every((t) => t.startsWith('nest-demo_'))).toBe(true)
    const orchestrator = log.filter((l) => l.userText.startsWith('call') && l.userText.includes('nest probe') && l.tools.length).at(-1)
    expect(orchestrator?.tools.some((t) => t.startsWith('nest-demo_'))).toBe(false)
  } finally {
    await request.put('/api/v1/mcp-nest', { data: { enabled: false }, timeout: 150_000 })
  }
})

test('a project-scope MCP toggle really takes effect', async ({ request, baseURL }) => {
  test.skip(!HAS_MCP, 'the v2 API of 1.x servers has no MCP')
  // opencode 1.19 writes project PATCHes to a file it never reads: the web
  // app must notice and apply the change where opencode looks
  await request.put('/api/v1/mcp-server', {
    data: { name: 'scope-demo', scope: 'global', directory: WORK, config: { type: 'remote', url: `${baseURL}/mcp-demo`, enabled: false } },
    timeout: 150_000
  })
  const result = await (await request.post('/api/v1/config-patch', {
    data: { scope: 'project', directory: WORK, patch: { mcp: { 'scope-demo': { enabled: true } } } }
  })).json()
  expect(['project', 'global']).toContain(result.scope)
  const merged = await (await request.get('/api/opencode/config', { params: { directory: WORK } })).json()
  expect(merged.mcp['scope-demo'].enabled).not.toBe(false)
})
