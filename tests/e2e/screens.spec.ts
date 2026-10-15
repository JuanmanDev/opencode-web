import { expect, test } from '@playwright/test'
import { shot } from './shot'

// Walks through the newer screens (and captures them for the README with
// SCREENSHOTS=1): MCP diagnosis and tools, subagent per MCP, schedules,
// subagents in the chat, and the settings on a phone.
const PROJECT = '/projects/space-invaders'
const DIR = Buffer.from(PROJECT).toString('base64url')

test('MCP server details: a failing server explains itself', async ({ page }) => {
  await page.goto(`/p/${DIR}/mcp`)
  await page.getByRole('button', { name: 'Details of home-assistant' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('tab', { name: 'Test' }).click()
  await dialog.getByRole('button', { name: 'Run test' }).click()
  await expect(dialog.getByText('The server could not be reached')).toBeVisible()
  await shot(page, 'mcp-diagnose')
})

test('MCP server details: tools with descriptions and parameters', async ({ page }) => {
  await page.goto(`/p/${DIR}/mcp`)
  await page.getByRole('button', { name: 'Details of context7' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('tab', { name: /Tools/ }).click()
  await dialog.getByText('query-docs').click()
  await expect(dialog.getByText('context7_query-docs')).toBeVisible()
  await shot(page, 'mcp-tools')
})

test('subagent per MCP: orchestrator and specialists', async ({ page }) => {
  await page.goto(`/p/${DIR}/mcp`)
  await page.getByText('Subagent per MCP', { exact: true }).click()
  await expect(page.getByText('@mcp-context7')).toBeVisible()
  await shot(page, 'mcp-subagents')
})

test('schedules: a scheduled prompt with its cadence', async ({ page, request }) => {
  const created = await (await request.post('/api/v1/schedules', {
    data: { name: 'Morning triage', directory: PROJECT, prompt: 'Look at the open TODOs and failing tests and summarize what needs attention today.', cron: '0 8 * * 1-5' }
  })).json()
  try {
    await page.goto(`/p/${DIR}/schedules`)
    await expect(page.getByText('weekdays at 08:00')).toBeVisible()
    await shot(page, 'schedules')
  } finally {
    await request.delete(`/api/v1/schedules/${created.id}`)
  }
})

test('subagents: card in the chat, nested in the sidebar, way back from the child', async ({ page }) => {
  await page.goto(`/p/${DIR}/session/ses_mock3`)
  await expect(page.getByText('@general').first()).toBeVisible()
  await expect(page.getByText('1 subagent')).toBeVisible()
  await shot(page, 'subagents')
  await page.getByRole('link', { name: /Open the general subagent/ }).click()
  await expect(page.getByRole('link', { name: 'Back to the parent conversation' })).toBeVisible()
})

test('settings on a phone: full-width actions', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/p/${DIR}/mcp`)
  await expect(page.getByRole('button', { name: 'Add server' })).toBeVisible()
  const add = await page.getByRole('button', { name: 'Add server' }).boundingBox()
  // a full-width action row: the button spans about half the screen or more
  expect(add!.width).toBeGreaterThan(150)
  await shot(page, 'mobile-mcp')
})
