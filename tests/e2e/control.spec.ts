import { expect, test, type APIRequestContext } from '@playwright/test'

// dir param for '/projects/space-invaders' (base64url)
const PROJECT = '/projects/space-invaders'
const DIR = Buffer.from(PROJECT).toString('base64url')

async function rpc(request: APIRequestContext, name: string, args: Record<string, unknown> = {}) {
  const res = await request.post('/mcp', { data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } })
  expect(res.ok()).toBeTruthy()
  const body = await res.json()
  return { text: body.result.content[0].text as string, isError: Boolean(body.result.isError) }
}

test('control MCP: tools carry annotations and cover chats, tasks, MCP, reloads and schedules', async ({ request }) => {
  const res = await request.post('/mcp', { data: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })
  const tools = (await res.json()).result.tools as Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>
  const names = tools.map((t) => t.name)
  for (const name of ['server_info', 'session_status', 'read_session', 'list_tasks', 'test_mcp', 'add_mcp', 'reload_opencode', 'create_schedule', 'list_skills']) {
    expect(names).toContain(name)
  }
  expect(tools.find((t) => t.name === 'read_session')?.annotations?.readOnlyHint).toBe(true)
  expect(tools.find((t) => t.name === 'reload_opencode')?.annotations?.readOnlyHint).toBeUndefined()

  const info = JSON.parse((await rpc(request, 'server_info', { directory: PROJECT })).text)
  expect(info.opencode.protocol).toBe('legacy')
  expect(info.capabilities.mcp).toBe(true)

  const transcript = await rpc(request, 'read_session', { directory: PROJECT, session_id: 'ses_mock1' })
  expect(transcript.text).toContain('--- USER')
  expect(transcript.text).toContain('[tool edit: src/game/powerups.ts → completed]')

  const tasks = JSON.parse((await rpc(request, 'list_tasks', { directory: PROJECT })).text)
  expect(tasks[0].todos).toEqual([{ id: 't1', content: 'Add blink animation', status: 'in_progress', priority: 'high' }])

  const mcp = JSON.parse((await rpc(request, 'list_mcp', { directory: PROJECT, include_tools: true })).text)
  const context7 = mcp.find((s: { name: string }) => s.name === 'context7')
  expect(context7.tools.map((t: { id: string }) => t.id)).toContain('context7_query-docs')

  const reload = await rpc(request, 'reload_opencode', { directory: PROJECT, when: 'now' })
  expect(reload.text).toMatch(/Reload of \/projects\/space-invaders scheduled/)
  await expect.poll(async () => JSON.stringify(await (await request.get('/api/v1/reload')).json()), { timeout: 20_000 }).toContain('"state":"done"')
})

test('control MCP: test_mcp reports steps and a fix', async ({ request }) => {
  const ok = JSON.parse((await rpc(request, 'test_mcp', { directory: PROJECT, name: 'context7' })).text)
  expect(ok.ok).toBe(true)
  expect(ok.tools.map((t: { name: string }) => t.name)).toEqual(['query-docs', 'resolve-library-id'])

  const broken = JSON.parse((await rpc(request, 'test_mcp', { directory: PROJECT, config: { type: 'remote', url: 'http://127.0.0.1:1/mcp' } })).text)
  expect(broken.ok).toBe(false)
  expect(broken.steps[0].ok).toBe(false)
  expect(broken.hint.action).toBe('check-url')
})

test('schedules: REST lifecycle and a manual run', async ({ request }) => {
  const created = await request.post('/api/v1/schedules', {
    data: { name: 'e2e nightly', directory: PROJECT, prompt: 'Run the tests', cron: '0 3 * * *' }
  })
  expect(created.ok()).toBeTruthy()
  const schedule = await created.json()
  expect(schedule.description).toBe('daily at 03:00')
  expect(schedule.nextRunAt).toBeGreaterThan(Date.now())

  const bad = await request.post('/api/v1/schedules', { data: { name: 'x', directory: PROJECT, prompt: 'p', cron: '99 * * * *' } })
  expect(bad.status()).toBe(400)

  const run = await (await request.post(`/api/v1/schedules/${schedule.id}/run`)).json()
  expect(run.status).toBe('running')
  expect(run.sessionID).toMatch(/^ses_/)
  await expect.poll(async () => {
    const list = await (await request.get('/api/v1/schedules', { params: { directory: PROJECT } })).json()
    return list.find((s: { id: string }) => s.id === schedule.id)?.runs[0]?.status
  }, { timeout: 10_000 }).toBe('ok')

  const listed = JSON.parse((await rpc(request, 'list_schedules', { directory: PROJECT })).text)
  expect(listed.some((s: { id: string }) => s.id === schedule.id)).toBe(true)

  expect((await request.delete(`/api/v1/schedules/${schedule.id}`)).ok()).toBeTruthy()
})

test('mcp server modal explains failures, edits without leaking secrets and lists tools', async ({ page }) => {
  await page.goto(`/p/${DIR}/mcp`)
  await page.getByRole('button', { name: 'Details of home-assistant' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('global config').or(dialog.getByText('project config'))).toBeVisible()

  // the stored bearer token stays a placeholder
  await dialog.getByRole('tab', { name: 'Edit' }).click()
  await expect(dialog.getByPlaceholder('•••• stored — type to replace')).toBeVisible()
  await expect(page.locator('input[value*="mcp-mock-secret"]')).toHaveCount(0)

  // unreachable URL: the test explains it and suggests a fix
  await dialog.getByRole('tab', { name: 'Test' }).click()
  await dialog.getByRole('button', { name: 'Run test' }).click()
  await expect(dialog.getByText('The server could not be reached')).toBeVisible()
  await page.keyboard.press('Escape')

  // tools with descriptions
  await page.getByRole('button', { name: 'Details of context7' }).click()
  await dialog.getByRole('tab', { name: /Tools/ }).click()
  await expect(dialog.getByText('query-docs')).toBeVisible()
  await expect(dialog.getByText('Query up-to-date documentation')).toBeVisible()
})

test('home assistant is set up through a form with OAuth off', async ({ page }) => {
  await page.goto(`/p/${DIR}/mcp`)
  await page.getByRole('button', { name: 'Add server' }).click()
  await page.getByText('Home Assistant').first().waitFor()
  // already configured in the mock: offered as added; the form is still reachable
  await page.getByRole('button', { name: 'Set up with a form' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('OAuth auto-detection')).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Add & connect' })).toBeVisible()
})

test('sidebar tiles reach schedules, and a schedule is created from the UI', async ({ page, request }) => {
  await page.goto(`/p/${DIR}`)
  await page.getByRole('link', { name: 'Scheduled prompts' }).first().click()
  await expect(page.getByRole('heading', { name: 'Scheduled prompts' })).toBeVisible()

  await page.getByRole('button', { name: 'New schedule' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByPlaceholder('Morning triage').fill('UI weekday check')
  await dialog.getByPlaceholder('What should the agent do?').fill('Summarize open TODOs')
  await expect(dialog.getByText('weekdays at 09:00')).toBeVisible()
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByText('UI weekday check', { exact: true })).toBeVisible()

  // clean up: schedules persist in the app's data store
  const list = await (await request.get('/api/v1/schedules', { params: { directory: PROJECT } })).json()
  for (const s of list.filter((x: { name: string }) => x.name === 'UI weekday check')) {
    await request.delete(`/api/v1/schedules/${s.id}`)
  }
})
