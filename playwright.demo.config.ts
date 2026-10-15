import { defineConfig } from '@playwright/test'

// The static GitHub Pages demo (DEMO=1 build, no server): built and served
// under /opencode-web/ like Pages does. `npm run test:demo`
const PORT = 3340

export default defineConfig({
  testDir: 'tests/demo',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never', outputFolder: 'playwright-report-demo' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}/opencode-web/`,
    colorScheme: 'dark',
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure'
  },
  webServer: {
    // DEMO_SKIP_BUILD=1 reuses an existing build
    command: process.env.DEMO_SKIP_BUILD ? 'node demo/serve.mjs' : 'npm run build:demo && node demo/serve.mjs',
    url: `http://127.0.0.1:${PORT}/opencode-web/`,
    timeout: 300_000,
    reuseExistingServer: !process.env.CI,
    env: { DEMO_PORT: String(PORT) }
  }
})
