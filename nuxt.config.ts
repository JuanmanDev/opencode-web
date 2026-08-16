export default defineNuxtConfig({
  compatibilityDate: '2026-08-01',
  modules: ['@nuxt/ui'],
  css: ['~/assets/css/main.css'],
  colorMode: {
    preference: 'dark',
    fallback: 'dark'
  },
  devtools: { enabled: false },
  ssr: true,
  app: {
    pageTransition: { name: 'oc-page', mode: 'out-in' },
    head: {
      title: 'opencode web',
      viewport: 'width=device-width, initial-scale=1, viewport-fit=cover',
      link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
      htmlAttrs: { lang: 'en' }
    }
  },
  icon: {
    mode: 'svg',
    provider: 'server',
    serverBundle: { collections: ['lucide'] },
    clientBundle: { scan: true, sizeLimitKb: 512 }
  },
  runtimeConfig: {
    // Server-side only. Override via env: NUXT_OPENCODE_URL, NUXT_OPENCODE_USERNAME, NUXT_OPENCODE_PASSWORD
    opencodeUrl: 'http://127.0.0.1:4096',
    opencodeUsername: 'opencode',
    opencodePassword: ''
  },
  nitro: {
    // keep proxy responses unbuffered for SSE
    routeRules: {
      '/api/opencode/event': { cache: false }
    }
  }
})
