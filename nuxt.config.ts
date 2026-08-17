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
  experimental: {
    // stale chunk after a redeploy/dev restart -> reload instead of erroring
    emitRouteChunkError: 'automatic'
  },
  app: {
    pageTransition: { name: 'oc-page', mode: 'out-in' },
    head: {
      title: 'opencode web',
      viewport: 'width=device-width, initial-scale=1, viewport-fit=cover',
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
        { rel: 'manifest', href: '/manifest.webmanifest' },
        { rel: 'apple-touch-icon', href: '/favicon.svg' }
      ],
      meta: [
        { name: 'theme-color', content: '#0a0a0a' },
        { name: 'mobile-web-app-capable', content: 'yes' },
        { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' }
      ],
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
    opencodePassword: '',
    // optional bearer token protecting /api/v1/* and /mcp (NUXT_API_TOKEN)
    apiToken: ''
  },
  nitro: {
    // keep proxy responses unbuffered for SSE
    routeRules: {
      '/api/opencode/event': { cache: false }
    },
    // small persistent store for project metadata (descriptions, favorites)
    storage: {
      data: { driver: 'fs', base: './.data' }
    },
    devStorage: {
      data: { driver: 'fs', base: './.data' }
    }
  }
})
