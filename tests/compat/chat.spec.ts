import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

// Runs against a real opencode server (see playwright.compat.config.ts) and a
// deterministic mock model: the same user journeys must work on every
// supported opencode version and on the v2 protocol.
const WORK = path.resolve('test-results/compat/work')
const DIR = Buffer.from(WORK).toString('base64url')
const PROTOCOL = process.env.COMPAT_PROTOCOL === 'v2' ? 'v2' : 'legacy'

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
  expect(caps.mcp).toBe(PROTOCOL === 'legacy')
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
  await newChat(page)
  await send(page, 'ask me something')
  await expect(page.getByText('Pick one?').first()).toBeVisible()
  // a single single-choice question is sent as soon as an option is picked
  await page.locator('button', { hasText: 'first' }).first().click()
  await expect(page.getByText('Tool finished OK.')).toBeVisible()
})

test('a reload mid-permission still shows the prompt', async ({ page }) => {
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
