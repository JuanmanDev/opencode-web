import { expect, test } from '@playwright/test'

const DIR = '/projects/space-invaders'

test('cross-site POSTs are refused, same-origin and non-browser ones pass', async ({ request, baseURL }) => {
  const evil = await request.post('/api/v1/sessions', {
    headers: { origin: 'https://evil.example' },
    data: { directory: DIR }
  })
  expect(evil.status()).toBe(403)

  const proxied = await request.post('/api/opencode/session', {
    headers: { origin: 'https://evil.example', 'content-type': 'text/plain' },
    data: '{}'
  })
  expect(proxied.status()).toBe(403)

  const mcp = await request.post('/mcp', {
    headers: { origin: 'null' },
    data: { jsonrpc: '2.0', id: 1, method: 'ping' }
  })
  expect(mcp.status()).toBe(403)

  const same = await request.post('/mcp', {
    headers: { origin: baseURL! },
    data: { jsonrpc: '2.0', id: 1, method: 'ping' }
  })
  expect(same.ok()).toBeTruthy()

  // curl, MCP clients, opencode itself: no Origin at all
  const plain = await request.post('/mcp', { data: { jsonrpc: '2.0', id: 1, method: 'ping' } })
  expect(plain.ok()).toBeTruthy()
})

test('MCP list_models never returns provider keys', async ({ request }) => {
  const res = await request.post('/mcp', {
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_models', arguments: { directory: DIR } } }
  })
  const text = (await res.json()).result.content[0].text as string
  expect(text).toContain('anthropic')
  expect(text).not.toContain('sk-ant-mock-secret')
})

test('MCP endpoint rejects malformed JSON-RPC bodies', async ({ request }) => {
  for (const data of [[{ jsonrpc: '2.0', id: 1, method: 'ping' }], { jsonrpc: '2.0', id: 1 }]) {
    const res = await request.post('/mcp', { data })
    expect(res.status()).toBe(400)
    expect((await res.json()).error.code).toBe(-32600)
  }
})

test('MCP credentials in the opencode config never reach the browser', async ({ request }) => {
  const res = await request.get(`/api/opencode/config?directory=${encodeURIComponent(DIR)}`)
  expect(res.ok()).toBeTruthy()
  const config = await res.json()
  expect(JSON.stringify(config)).not.toContain('mcp-mock-secret')
  expect(config.mcp['home-assistant'].headers.Authorization).toBe('***')
  // everything else passes through untouched
  expect(config.mcp['ui-demo'].url).toBe('http://127.0.0.1:1/mcp-demo')
})

test('external images in agent output load only after a click', async ({ page }) => {
  const external: string[] = []
  await page.route('https://images.example.com/**', (route) => {
    external.push(route.request().url())
    return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>' })
  })
  await page.goto(`/p/${Buffer.from(DIR).toString('base64url')}/session/ses_mock2`)
  const gate = page.getByRole('button', { name: /Load image from images\.example\.com/ })
  await expect(gate).toBeVisible()
  expect(external).toHaveLength(0)
  await gate.click()
  await expect(page.locator('.oc-markdown img[alt="status chart"]')).toBeVisible()
  expect(external).toEqual(['https://images.example.com/chart.png?q=leak'])
})
