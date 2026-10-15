import { expect, test, type Page } from '@playwright/test'

// The static demo: every API answer and the "AI" run in the browser.
const SPACE = Buffer.from('/projects/space-invaders').toString('base64url')

async function newChat(page: Page) {
  await page.goto(`p/${SPACE}`)
  await page.getByRole('button', { name: 'New chat' }).first().click()
  await expect(page).toHaveURL(/\/session\/ses_/)
}

async function send(page: Page, text: string) {
  const box = page.getByPlaceholder(/Ask opencode/)
  await box.fill(text)
  await box.press('Enter')
}

test.beforeEach(async ({ page }) => {
  // every test starts from the seeded demo
  await page.goto('./')
  await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('opencode-web.')) localStorage.removeItem(k) })
})

test('home lists the sample projects and the demo banner', async ({ page }) => {
  await page.goto('./')
  await expect(page.getByText('space-invaders').first()).toBeVisible()
  await expect(page.getByText('home-dashboard').first()).toBeVisible()
  await expect(page.getByText('runs in your browser, no server')).toBeVisible()
  await expect(page.getByText('opencode 1.19.0 (demo)')).toBeVisible()
})

test('a chat streams a reply with tool cards and survives a reload', async ({ page }) => {
  await newChat(page)
  await send(page, 'list the files')
  await expect(page.getByText('Demo bot').first()).toBeVisible()
  await expect(page.getByText('src/game/collision.ts').first()).toBeVisible()
  await expect(page.locator('.oc-markdown').getByText(/The project has/)).toBeVisible()
  await expect(page.getByText('working', { exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.locator('.oc-markdown').getByText(/The project has/)).toBeVisible()
})

test('shell commands ask for permission first', async ({ page }) => {
  await newChat(page)
  await send(page, 'run the tests')
  await expect(page.getByText('Permission required')).toBeVisible()
  await page.getByRole('button', { name: 'Allow once' }).click()
  await expect(page.getByText('Permission required')).toHaveCount(0)
  await expect(page.locator('.oc-markdown').getByText(/Ran npm test/)).toBeVisible()
})

test('fix the bug edits a file and shows the diff', async ({ page }) => {
  await newChat(page)
  await send(page, 'fix the bug')
  await expect(page.locator('.oc-markdown').getByText(/Fixed the collision bug/)).toBeVisible()
  await page.getByRole('button', { name: 'Show file changes' }).click()
  await expect(page.getByText('src/game/collision.ts').last()).toBeVisible()
})

test('questions and subagents work like on a real server', async ({ page }) => {
  await newChat(page)
  await send(page, 'ask me a question')
  await expect(page.getByText('Which feature should I work on next?').first()).toBeVisible()
  await page.locator('button', { hasText: 'Add tests' }).first().click()
  await expect(page.locator('.oc-markdown').getByText(/Add tests\*?\*? it is|it is/)).toBeVisible()

  await send(page, 'delegate a review to a subagent')
  await expect(page.getByText('@general').first()).toBeVisible()
  await expect(page.getByText('Result', { exact: true })).toBeVisible()
  await page.getByRole('link', { name: /Open the general subagent/ }).click()
  await expect(page.getByRole('link', { name: 'Back to the parent conversation' })).toBeVisible()
})

test('MCP UI widgets render and the MCP page lists servers', async ({ page }) => {
  await page.goto(`p/${SPACE}/session/ses_demo_widgets`)
  await expect(page.frameLocator('iframe').first().getByText('Revenue')).toBeVisible()
  await page.goto(`p/${SPACE}/mcp`)
  await expect(page.getByText('context7', { exact: true })).toBeVisible()
  await expect(page.getByText('home-assistant', { exact: true })).toBeVisible()
})

test('works on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 })
  await newChat(page)
  await send(page, 'hello')
  await expect(page.locator('.oc-markdown').getByText(/through the same API as opencode/)).toBeVisible()
  await page.getByRole('button', { name: 'Open menu' }).click()
  await expect(page.getByRole('dialog').getByText('Add power-ups to the game loop')).toBeVisible()
})
