import { expect, test } from '@playwright/test'

// Every MCP UI flavour the chat renders, end to end against the mock opencode
// server and this app's own /mcp-demo MCP server:
// - MCP Apps (SEP-1865): ui:// template + JSON-RPC handshake + tool-result data
// - mcp-ui remote-dom: script executed in the generic web-component host shell
// - mcp-ui rawHtml: inline ui:// text/html resource from the tool metadata
const DIR = Buffer.from('/projects/space-invaders').toString('base64url')
const SESSION = `/p/${DIR}/session/ses_mock2`

test('MCP Apps template handshakes and renders the tool result', async ({ page }) => {
  await page.goto(SESSION)
  const app = page.frameLocator('iframe[title="ui://opencode-web-demo/app-template"]')
  // rendered from structuredContent.html streamed via ui/notifications/tool-result
  await expect(app.getByText('Revenue')).toBeVisible()
  await expect(app.getByText('42')).toBeVisible()
  await expect(app.getByText('+12.5%')).toBeVisible()
  // the host acknowledged the app: loaded badge + fade-in
  await expect(page.locator('iframe[title="ui://opencode-web-demo/app-template"]')).toHaveClass(/opacity-100/)
})

test('remote-dom component renders and reacts to presses', async ({ page }) => {
  await page.goto(SESSION)
  const iframe = page.locator('iframe[title="ui://opencode-web-demo/remote-dom"]')
  const frame = iframe.contentFrame()
  await expect(frame.getByText('Deploy to production?')).toBeVisible()
  await expect(iframe).toHaveClass(/opacity-100/)
  await expect(frame.getByRole('button', { name: 'Ship it' })).toBeVisible()
  // apps above resize asynchronously (size-changed) and shift this frame while
  // a pointer click is in flight -> exercise the press wiring, not hit-testing
  await frame.getByRole('button', { name: 'Ship it' }).dispatchEvent('click')
  await expect(frame.getByText('You pressed: Ship it')).toBeVisible()
  await expect(page.getByText('remote-dom', { exact: true }).first()).toBeVisible()
})

test('inline ui:// html resource renders without contacting any server', async ({ page }) => {
  const calls: string[] = []
  page.on('request', (req) => { if (req.url().includes('/api/v1/mcp-call')) calls.push(req.postData() || '') })
  await page.goto(SESSION)
  const frame = page.frameLocator('iframe[title="ui://widgets/card"]')
  await expect(frame.getByText('api deployed to production')).toBeVisible()
  // widgets_card has no UI-looking name and no known server: never re-run
  expect(calls.some((c) => c.includes('widgets_card'))).toBe(false)
})

test('apps open fullscreen / in the side panel via URL state and come back', async ({ page }) => {
  await page.goto(SESSION)
  const frame = page.locator('iframe[title="ui://opencode-web-demo/app-template"]')
  await expect(frame).toBeVisible()

  await page.getByRole('button', { name: 'Fullscreen' }).first().click()
  await expect(page).toHaveURL(/view=full/)
  await expect(page.getByText(/Currently showing in fullscreen/)).toBeVisible()
  // the viewer copy handshakes again and renders the same data
  const viewer = page.frameLocator('iframe[title="ui://opencode-web-demo/app-template"]').last()
  await expect(viewer.getByText('Revenue')).toBeVisible()

  // dock to the side panel: same persistent iframe, different frame
  await page.getByRole('button', { name: 'Dock to side panel' }).click()
  await expect(page).toHaveURL(/view=side/)
  await expect(page.getByText(/Currently showing in the side panel/)).toBeVisible()
  await expect(viewer.getByText('Revenue')).toBeVisible()

  await page.getByRole('button', { name: 'Close app viewer' }).click()
  await expect(page).not.toHaveURL(/view=/)
  await expect(page.getByText(/Currently showing/)).toHaveCount(0)
  await expect(frame).toBeVisible()
})

test('deep link to an app opens it directly in fullscreen', async ({ page }) => {
  await page.goto(`${SESSION}?app=${encodeURIComponent('prt_ui1:f0')}&view=full`)
  const viewer = page.frameLocator('iframe[title="ui://opencode-web-demo/app-template"]')
  await expect(viewer.getByText('Revenue')).toBeVisible({ timeout: 20000 })
})

test('discovery flags MCP Apps tools and the mcp page shows the UI badge', async ({ page, request }) => {
  const res = await request.get(`/api/v1/mcp-tools?directory=${encodeURIComponent('/projects/space-invaders')}`)
  expect(res.ok()).toBeTruthy()
  const tools = (await res.json())['ui-demo']
  expect(tools.error).toBeUndefined()
  const byName = Object.fromEntries(tools.tools.map((t: { name: string; ui?: boolean }) => [t.name, t]))
  expect(byName.show_metric.ui).toBe(true)
  expect(byName.show_remote_dom.ui).toBeUndefined()

  await page.goto(`/p/${DIR}/mcp`)
  await page.getByRole('button', { name: /^ui-demo/ }).click()
  await expect(page.getByText('show_metric', { exact: true })).toBeVisible()
  await expect(page.getByText('UI', { exact: true }).first()).toBeVisible()
})

test('mcp-call recovers the app template and structured content', async ({ request }) => {
  const res = await request.post('/api/v1/mcp-call', {
    data: { directory: '/projects/space-invaders', toolId: 'ui-demo_show_weather', arguments: { location: 'Salamanca', temperature: 31, condition: 'sunny' } }
  })
  expect(res.ok()).toBeTruthy()
  const body = await res.json()
  expect(body.app.resourceUri).toBe('ui://opencode-web-demo/app-template')
  expect(body.app.html).toContain('ui/initialize')
  expect(body.structuredContent.html).toContain('Salamanca')
  expect(body.resources[0].html).toContain('31')
})
