import { expect, test, type Page } from '@playwright/test'

// dir param for '/projects/space-invaders' (base64url)
const DIR = Buffer.from('/projects/space-invaders').toString('base64url')

/** The mock has primary agents only: add the subagents opencode ships. */
async function withSubagents(page: Page) {
  await page.route('**/api/opencode/agent*', (route) => route.fulfill({
    json: [
      { name: 'build', mode: 'primary', builtIn: true },
      { name: 'plan', mode: 'primary', builtIn: true },
      { name: 'general', mode: 'subagent', description: 'General-purpose agent for multi-step tasks', builtIn: true },
      { name: 'explore', mode: 'subagent', description: 'Fast codebase exploration', builtIn: true }
    ]
  }))
}

test('@ mentions files, folders and subagents, and sends them as opencode parts', async ({ page }) => {
  await withSubagents(page)
  await page.goto(`/p/${DIR}/session/ses_mock1`)
  const box = page.getByPlaceholder(/Ask opencode/)
  await box.click()

  await box.pressSequentially('fix @')
  const list = page.getByRole('listbox', { name: /Mention a file/ })
  await expect(list).toBeVisible()
  // subagents only (no primary agents), then files and folders from the server
  await expect(list.getByRole('option', { name: /@general/ })).toBeVisible()
  await expect(list.getByRole('option', { name: /@build\b/ })).toHaveCount(0)
  await expect(list.getByRole('option', { name: /@README\.md/ })).toBeVisible()

  await box.pressSequentially('loop')
  await expect(list.getByRole('option')).toHaveCount(1)
  await box.press('Enter')
  await expect(box).toHaveValue('fix @src/game/loop.ts ')
  await expect(list).toBeHidden()

  await box.pressSequentially('with @gen')
  await box.press('Tab')
  await expect(box).toHaveValue('fix @src/game/loop.ts with @general ')

  const sent = page.waitForRequest((r) => r.method() === 'POST' && /\/session\/ses_mock1\/message/.test(r.url()))
  await box.press('Enter')
  const body = (await sent).postDataJSON() as { parts: Array<Record<string, any>> }
  expect(body.parts[0]).toEqual({ type: 'text', text: 'fix @src/game/loop.ts with @general' })
  expect(body.parts).toContainEqual({
    type: 'file',
    mime: 'text/plain',
    filename: 'loop.ts',
    url: 'file:///projects/space-invaders/src/game/loop.ts',
    source: { type: 'file', path: 'src/game/loop.ts', text: { value: '@src/game/loop.ts', start: 4, end: 21 } }
  })
  expect(body.parts).toContainEqual({ type: 'agent', name: 'general', source: { value: '@general', start: 27, end: 35 } })
})

test('Escape closes the mention list; ! shows shell mode', async ({ page }) => {
  await page.goto(`/p/${DIR}/session/ses_mock1`)
  const box = page.getByPlaceholder(/Ask opencode/)
  await box.click()
  await box.pressSequentially('@READ')
  const list = page.getByRole('listbox', { name: /Mention a file/ })
  await expect(list).toBeVisible()
  await box.press('Escape')
  await expect(list).toBeHidden()
  await box.fill('!ls')
  await expect(page.getByText('Shell mode: runs the command in the project folder')).toBeVisible()
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true })

  test('the config row steps aside while the keyboard is up', async ({ page }) => {
    await page.goto(`/p/${DIR}/session/ses_mock1`)
    const config = page.getByTestId('prompt-config')
    await expect(config).toBeVisible()
    await page.getByPlaceholder(/Ask opencode/).focus()
    await expect(config).toBeHidden()
    await page.getByPlaceholder(/Ask opencode/).blur()
    await expect(config).toBeVisible()
  })
})
