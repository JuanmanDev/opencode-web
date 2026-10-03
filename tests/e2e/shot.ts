import { expect, type Page } from '@playwright/test'

/**
 * README screenshot (only with SCREENSHOTS=1): waits for every MCP app to
 * finish loading and freezes CSS transitions, so no frame is caught mid-fade.
 */
export async function shot(page: Page, name: string) {
  if (!process.env.SCREENSHOTS) return
  await expect(page.getByText('Loading app…')).toHaveCount(0, { timeout: 20000 })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(400)
  await page.screenshot({ path: `docs/screenshots/${name}.png`, animations: 'disabled' })
}
