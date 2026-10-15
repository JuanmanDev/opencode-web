import { expect, test } from '@playwright/test'

// dir params (base64url) of the mock's two projects
const DIR = Buffer.from('/projects/space-invaders').toString('base64url')
const OTHER = Buffer.from('/projects/home-dashboard').toString('base64url')

test('switching projects keeps the sidebar mounted and swaps its sessions', async ({ page }) => {
  await page.goto(`/p/${OTHER}`)
  await page.goto(`/p/${DIR}`)
  await expect(page.getByText('Add power-ups to the game loop').first()).toBeVisible()
  // mark the live sidebar element: a remount would drop the marker
  await page.locator('aside', { has: page.getByLabel('Project tools') }).evaluate((el) => { el.dataset.marker = 'kept' })

  await page.getByRole('button', { name: /switch project/ }).first().click()
  await page.getByRole('menuitem', { name: /home-dashboard/ }).click()
  await expect(page).toHaveURL(new RegExp(`/p/${OTHER}$`))
  await expect(page.locator('aside[data-marker="kept"]')).toHaveCount(1)
  await expect(page.getByRole('button', { name: /^Project home-dashboard/ }).first()).toBeVisible()
})

test('the sidebar collapses to an icon rail and back', async ({ page }) => {
  await page.goto(`/p/${DIR}`)
  await page.getByRole('button', { name: 'Collapse sidebar' }).click()
  await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Project', exact: true }).getByRole('link', { name: 'Usage & cost' })).toBeVisible()
  await page.getByRole('button', { name: 'Expand sidebar' }).click()
  await expect(page.getByLabel('Project tools')).toBeVisible()
})

test('Tab switches the agent and arrow up recalls earlier prompts', async ({ page }) => {
  await page.goto(`/p/${DIR}/session/ses_mock1`)
  const box = page.getByPlaceholder(/Ask opencode/)
  await box.click()
  await box.press('Tab')
  await expect(page.getByTestId('prompt-config').getByText('build', { exact: true })).toBeVisible()
  await box.press('Tab')
  await expect(page.getByTestId('prompt-config').getByText('plan', { exact: true })).toBeVisible()

  const sent = page.waitForRequest((r) => r.method() === 'POST' && /\/session\/ses_mock1\/message/.test(r.url()))
  await box.fill('remember this prompt')
  await box.press('Enter')
  expect((await sent).postDataJSON().agent).toBe('plan')
  await expect(box).toHaveValue('')
  await box.press('ArrowUp')
  await expect(box).toHaveValue('remember this prompt')
  await box.press('ArrowDown')
  await expect(box).toHaveValue('')
})

test('a pasted screenshot becomes an image attachment', async ({ page }) => {
  await page.goto(`/p/${DIR}/session/ses_mock1`)
  const box = page.getByPlaceholder(/Ask opencode/)
  await box.click()
  await box.evaluate((el) => {
    // 1x1 png
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
    const data = new DataTransfer()
    data.items.add(new File([bytes], 'image.png', { type: 'image/png' }))
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await expect(page.getByRole('button', { name: /Preview pasted .*\.png/ })).toBeVisible()
  const sent = page.waitForRequest((r) => r.method() === 'POST' && /\/session\/ses_mock1\/message/.test(r.url()))
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  const parts = (await sent).postDataJSON().parts as Array<{ type: string; mime?: string; url?: string }>
  expect(parts[0]).toMatchObject({ type: 'file', mime: 'image/png' })
  expect(parts[0]!.url).toMatch(/^data:image\/png;base64,/)
})

test('chat options explain themselves and link to their settings', async ({ page }) => {
  await page.goto(`/p/${DIR}/session/ses_mock1`)
  await page.getByRole('button', { name: /Show model, think level/ }).click()
  await page.getByRole('button', { name: 'About: Agent', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Agent' })
  await expect(dialog.getByText('Press Tab in the input')).toBeVisible()
  await dialog.getByRole('link', { name: 'Edit agents' }).click()
  await expect(page).toHaveURL(new RegExp(`/p/${DIR}/agents$`))
  await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible()
  await expect(page.getByText('plan', { exact: true }).first()).toBeVisible()
})

test('usage groups replies by day and model', async ({ page }) => {
  await page.goto(`/p/${DIR}/stats`)
  await expect(page.getByRole('heading', { name: 'Usage & cost' })).toBeVisible()
  await page.getByRole('button', { name: 'Model', exact: true }).click()
  await expect(page.getByText(/Estimated/).first()).toBeVisible()
})

test('projects can be starred on the home page', async ({ page }) => {
  await page.goto('/')
  const star = page.getByRole('button', { name: /Star project/ }).nth(1)
  await star.click()
  await expect(page.getByRole('button', { name: 'Unstar project' })).toHaveCount(1)
  await page.getByRole('button', { name: 'Unstar project' }).click()
  await expect(page.getByRole('button', { name: 'Unstar project' })).toHaveCount(0)
})

test('JSON for a front-end component renders as cards and tables', async ({ page }) => {
  const payload = {
    __componentType: 'reservation-details',
    message: 'Reservation EXP-1',
    data: { reservationId: 'EXP-1', status: 'Checked-in', guest: { name: 'Ada Lovelace', country: 'UK' }, rooms: [{ roomName: '303', adults: 2 }] }
  }
  await page.route('**/api/opencode/session/ses_mock1/message*', (route) => route.request().method() === 'GET'
    ? route.fulfill({
      json: [{
        info: { id: 'msg_h1', sessionID: 'ses_mock1', role: 'assistant', time: { created: Date.now(), completed: Date.now() } },
        parts: [{ id: 'prt_h1', messageID: 'msg_h1', sessionID: 'ses_mock1', type: 'tool', tool: 'hotelier-tools_get_reservation_details_ui', state: { status: 'completed', input: {}, output: JSON.stringify(payload), title: 'details' } }]
      }]
    })
    : route.fallback())
  await page.goto(`/p/${DIR}/session/ses_mock1`)
  await expect(page.getByText('Reservation EXP-1')).toBeVisible()
  await expect(page.getByText('Ada Lovelace')).toBeVisible()
  await expect(page.getByRole('cell', { name: '303' })).toBeVisible()
  // the data is all there: no "run the tool again" offer
  await expect(page.getByRole('button', { name: /Render UI/ })).toHaveCount(0)

  await page.getByRole('button', { name: 'Chat width' }).click()
  await page.getByRole('menuitemcheckbox', { name: 'Full width' }).click()
  await expect.poll(() => page.evaluate(() => document.cookie)).toContain('oc-chat-width=full')
})

test('skills: see what they say, write one into the library, delete it', async ({ page }) => {
  await page.goto(`/p/${DIR}/skills`)
  await expect(page.getByRole('heading', { name: /Skills/ })).toBeVisible()
  await page.getByRole('button', { name: /release-notes/ }).click()
  await expect(page.getByText('When the agent uses it')).toBeVisible()
  await expect(page.getByText('Write release notes').first()).toBeVisible()
  await page.getByRole('tab', { name: /Checks/ }).click()
  await expect(page.getByText(/body is almost empty/)).toBeVisible()
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'New skill' }).click()
  await page.getByPlaceholder('release-notes').fill('e2e-skill')
  await page.getByRole('button', { name: 'From template' }).click()
  const save = page.getByRole('button', { name: 'Save to library' })
  await expect(save).toBeEnabled()
  await save.click()
  await expect(page.getByText(/e2e-skill saved/).first()).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: /e2e-skill/ })).toBeVisible()

  await page.getByRole('button', { name: /e2e-skill/ }).click()
  await page.getByRole('button', { name: 'Delete' }).click()
  await page.getByRole('button', { name: 'Delete?' }).click()
  await expect(page.getByRole('button', { name: /e2e-skill/ })).toHaveCount(0)
})

test('the projects panel lists recent chats per project, configurable', async ({ page }) => {
  await page.goto(`/p/${DIR}`)
  await page.getByRole('button', { name: 'Show projects panel' }).click()
  const panel = page.getByRole('complementary', { name: 'Projects' })
  await expect(panel.getByRole('link', { name: /Add power-ups to the game loop/ }).first()).toBeVisible()

  await panel.getByRole('button', { name: 'Chat list settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Chats in the projects panel' })
  await dialog.getByRole('spinbutton').nth(1).fill('1')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(panel.getByRole('button', { name: /more$/ }).first()).toBeVisible()
  await panel.getByRole('button', { name: /more$/ }).first().click()
  await expect(panel.getByRole('button', { name: 'Less' }).first()).toBeVisible()
})
