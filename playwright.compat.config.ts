import { defineConfig } from '@playwright/test'

// End-to-end against a REAL opencode server (scripts/compat-server.mjs) and a
// deterministic mock model. CI runs it for several opencode versions:
//   OPENCODE_VERSION=1.4.11 npx playwright test -c playwright.compat.config.ts
//   COMPAT_PROTOCOL=v2 ...   # force the v2 /api protocol (1.18+ serves both)
const APP_PORT = 3320
const OPENCODE_PORT = 4810
const PASSWORD = 'compat-secret'

export default defineConfig({
  testDir: 'tests/compat',
  timeout: 180_000,
  expect: { timeout: 60_000 },
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never', outputFolder: 'playwright-report-compat' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${APP_PORT}`,
    colorScheme: 'dark',
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure'
  },
  webServer: [
    {
      command: 'node scripts/compat-server.mjs',
      port: OPENCODE_PORT,
      // first run downloads opencode itself
      timeout: 300_000,
      reuseExistingServer: false,
      env: { OPENCODE_PORT: String(OPENCODE_PORT), OPENCODE_SERVER_PASSWORD: PASSWORD }
    },
    {
      command: 'node .output/server/index.mjs',
      url: `http://127.0.0.1:${APP_PORT}/api/health`,
      reuseExistingServer: false,
      env: {
        NITRO_PORT: String(APP_PORT),
        NUXT_OPENCODE_URL: `http://127.0.0.1:${OPENCODE_PORT}`,
        NUXT_OPENCODE_PASSWORD: PASSWORD,
        NUXT_OPENCODE_PROTOCOL: process.env.COMPAT_PROTOCOL || 'auto'
      }
    }
  ]
})
