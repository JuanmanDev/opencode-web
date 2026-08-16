import { expect, test } from '@playwright/test'

// dir param for '/projects/space-invaders' (base64url)
const DIR = Buffer.from('/projects/space-invaders').toString('base64url')

test('home page lists projects from the server', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /opencode\s*web/i })).toBeVisible()
  await expect(page.getByText('space-invaders').first()).toBeVisible()
  await expect(page.getByText('home-dashboard').first()).toBeVisible()
  await page.screenshot({ path: 'docs/screenshots/home.png' })
})

test('project view shows sessions and chat with parts', async ({ page }) => {
  await page.goto(`/p/${DIR}/session/ses_mock1`)

  // sidebar session list
  await expect(page.getByText('Add power-ups to the game loop').first()).toBeVisible()

  // chat content: user message, tool calls, markdown reply
  await expect(page.getByText('shield power-up that lasts 5 seconds').first()).toBeVisible()
  await expect(page.getByText('src/game/powerups.ts').first()).toBeVisible()
  await expect(page.locator('.oc-markdown').getByText('All 24 tests pass.')).toBeVisible()

  // prompt box with model/think/agent options
  await expect(page.getByPlaceholder(/Ask opencode/)).toBeVisible()
  await page.getByRole('button', { name: /Show model, think level/ }).click()
  await expect(page.getByText('Think level')).toBeVisible()
  await expect(page.getByText('project default')).toBeVisible()

  await page.screenshot({ path: 'docs/screenshots/chat.png' })
})

test('model selector shows providers, details and configure entry', async ({ page }) => {
  await page.goto(`/p/${DIR}/session/ses_mock1`)
  await page.getByRole('button', { name: /Show model, think level/ }).click()

  // open the model dropdown
  await page.locator('button', { hasText: 'Claude Sonnet 5' }).first().click()
  await expect(page.getByText('OpenCode Zen').first()).toBeVisible()
  await expect(page.getByText('Configure providers…')).toBeVisible()
})

test('mcp page lists servers with toggles', async ({ page }) => {
  await page.goto(`/p/${DIR}/mcp`)
  await expect(page.getByText('context7', { exact: true })).toBeVisible()
  await expect(page.getByText('home-assistant', { exact: true })).toBeVisible()
  await expect(page.getByText('disabled').first()).toBeVisible()
  await page.screenshot({ path: 'docs/screenshots/mcp.png' })
})

test('mobile viewport shows hamburger menu and prompt box', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/p/${DIR}/session/ses_mock1`)
  await expect(page.getByPlaceholder(/Ask opencode/)).toBeVisible()
  await page.screenshot({ path: 'docs/screenshots/mobile.png' })
})
