import { expect, test } from '@playwright/test'

const DIR = '/projects/space-invaders'

test('REST: openapi spec, projects, sessions, models', async ({ request }) => {
  const spec = await request.get('/api/v1/openapi.json')
  expect(spec.ok()).toBeTruthy()
  expect((await spec.json()).openapi).toBe('3.1.0')

  const projects = await request.get('/api/v1/projects')
  expect(projects.ok()).toBeTruthy()
  expect((await projects.json()).length).toBeGreaterThan(0)

  const sessions = await request.get(`/api/v1/sessions?directory=${encodeURIComponent(DIR)}`)
  expect(sessions.ok()).toBeTruthy()
  expect((await sessions.json())[0].id).toBe('ses_mock1')

  const models = await request.get('/api/v1/models')
  expect(models.ok()).toBeTruthy()
  expect((await models.json()).providers.length).toBeGreaterThan(0)
})

test('MCP: initialize, tools/list, tools/call', async ({ request }) => {
  const rpc = (method: string, params?: object, id = 1) =>
    request.post('/mcp', { data: { jsonrpc: '2.0', id, method, params } })

  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' }
  })
  expect(init.ok()).toBeTruthy()
  const initJson = await init.json()
  expect(initJson.result.serverInfo.name).toBe('opencode-web')

  // notification -> 202, no body
  const note = await request.post('/mcp', {
    data: { jsonrpc: '2.0', method: 'notifications/initialized' }
  })
  expect(note.status()).toBe(202)

  const list = await rpc('tools/list', {}, 2)
  const tools = (await list.json()).result.tools.map((t: { name: string }) => t.name)
  expect(tools).toContain('send_prompt')
  expect(tools).toContain('list_projects')

  const call = await rpc('tools/call', { name: 'list_projects', arguments: {} }, 3)
  const result = (await call.json()).result
  expect(result.isError).toBeFalsy()
  expect(result.content[0].text).toContain('space-invaders')

  const status = await rpc('tools/call', { name: 'mcp_status', arguments: { directory: DIR } }, 4)
  expect((await status.json()).result.content[0].text).toContain('context7')
})
