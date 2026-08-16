import { defineConfig } from '@playwright/test'

const APP_PORT = 3311
const MOCK_PORT = 4517

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${APP_PORT}`,
    colorScheme: 'dark',
    viewport: { width: 1280, height: 800 }
  },
  webServer: [
    {
      command: `node scripts/mock-opencode.mjs`,
      url: `http://127.0.0.1:${MOCK_PORT}/project`,
      reuseExistingServer: !process.env.CI,
      env: { MOCK_PORT: String(MOCK_PORT) }
    },
    {
      command: `node .output/server/index.mjs`,
      url: `http://127.0.0.1:${APP_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      env: {
        NITRO_PORT: String(APP_PORT),
        NUXT_OPENCODE_URL: `http://127.0.0.1:${MOCK_PORT}`,
        NUXT_OPENCODE_PASSWORD: ''
      }
    }
  ]
})
