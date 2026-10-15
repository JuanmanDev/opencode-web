export default defineNuxtConfig(withDemo({
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
      // interactive-widget makes the on-screen keyboard resize the layout
      // instead of covering it (Chrome/Android)
      viewport: 'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content',
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
    // which opencode API to speak (NUXT_OPENCODE_PROTOCOL): auto (detect),
    // legacy (every 1.x server) or v2 (servers serving only /api/*)
    opencodeProtocol: 'auto',
    // optional bearer token protecting /api/v1/*, /mcp and the opencode proxy
    // (NUXT_API_TOKEN); the UI itself authenticates with a page cookie
    apiToken: '',
    // extra browser origins allowed to send state-changing requests, comma
    // separated (NUXT_ALLOWED_ORIGINS), e.g. an MCP inspector on localhost
    allowedOrigins: '',
    // Tool discovery for local (stdio) MCP servers spawns them here, in this
    // app - which is only exactly right when opencode runs on the same host.
    //   always    - always spawn (default; names match, opencode may differ)
    //   same-host - only when opencodeUrl is localhost
    //   never     - never spawn; local servers list no tools
    mcpLocalDiscovery: 'always',
    // scheduled prompts (NUXT_SCHEDULER): 'on' or 'off'
    scheduler: 'on',
    // URL at which *opencode* reaches this app (NUXT_SELF_URL), used to
    // register the control MCP server (`<selfUrl>/mcp`) with opencode.
    // Empty: the origin of NUXT_PUBLIC_DEMO_MCP_URL, else the request's own
    selfUrl: '',
    // agent control (the /mcp control server in opencode's global config) is
    // registered once by default (NUXT_AGENT_CONTROL): 'auto' or 'off'
    agentControl: 'auto',
    public: {
      // URL at which *opencode* reaches this app's demo MCP server, used when
      // adding it from the MCP page (NUXT_PUBLIC_DEMO_MCP_URL). Empty: the
      // browser's origin, right when both run on the same host.
      demoMcpUrl: ''
    }
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
}))

// ---- static web demo (DEMO=1 nuxi generate) ----
// A client-only build for GitHub Pages: no server, the UI's API calls are
// answered in the browser by demo/backend.ts with a tiny scripted "AI".
// The normal build never sees any of it.
function withDemo<T extends Record<string, any>>(config: T): T {
  if (process.env.DEMO !== '1') return config
  const base = process.env.DEMO_BASE_URL || '/opencode-web/'
  const prefix = (href: string) => (href.startsWith('/') ? base + href.slice(1) : href)
  return {
    ...config,
    ssr: false,
    // keep the regular build's .nuxt and .output untouched
    buildDir: 'node_modules/.cache/nuxt-demo',
    app: {
      ...config.app,
      baseURL: base,
      head: {
        ...config.app.head,
        title: 'opencode web — live demo',
        link: config.app.head.link.map((l: { href: string }) => ({ ...l, href: prefix(l.href) }))
      }
    },
    plugins: [...(config.plugins || []), { src: '~~/demo/plugin.client.ts', mode: 'client' }],
    // no icon endpoint on a static host: unbundled icons come from Iconify
    icon: { ...config.icon, provider: 'iconify', serverBundle: false, clientBundle: { scan: true, sizeLimitKb: 1024 } },
    nitro: {
      ...config.nitro,
      preset: 'github-pages',
      output: { dir: 'node_modules/.cache/opencode-web-demo' },
      prerender: { routes: ['/'], crawlLinks: false, failOnError: false }
    }
  }
}
