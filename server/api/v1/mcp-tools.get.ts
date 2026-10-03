// Fetch the tool lists of a project's MCP servers by speaking MCP to them
// directly — opencode exposes no MCP tool ids at all (`/experimental/tool[/ids]`
// only returns built-in and plugin tools). Remote servers are queried over
// Streamable HTTP or legacy SSE (server/utils/mcp-client.ts), local ones are spawned and
// spoken to over stdio.

import { fetchToolsStdio } from '../../utils/mcp-stdio'
import { listRemoteTools, loopbackOrigin, resolveDemoUrl, type McpToolInfo } from '../../utils/mcp-client'

interface McpConfigEntry {
  type?: string
  url?: string
  headers?: Record<string, string>
  command?: string[]
  environment?: Record<string, string>
  enabled?: boolean
}

export interface McpToolsResult {
  tools: ToolInfo[]
  error?: string
  /** disabled in the config: never probed, so neither tools nor errors */
  disabled?: boolean
  transport?: 'remote' | 'local'
  /** local server spawned here while opencode runs elsewhere: names only */
  approx?: boolean
  /** local discovery is switched off for this deployment */
  skipped?: boolean
}

/** Does opencode run on this very host? Only then is a local spawn exact. */
function opencodeIsLocal() {
  try {
    const { hostname } = new URL(useRuntimeConfig().opencodeUrl)
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)
  } catch {
    return false
  }
}

type ToolInfo = McpToolInfo

/** Discover one server's tools; never throws — failures land in `error`. */
async function probe(entry: McpConfigEntry, selfOrigin?: string): Promise<McpToolsResult> {
  // disabled servers are never contacted: probing them produced phantom
  // errors in the UI (e.g. 401 from a server the user deliberately turned off)
  if (entry?.enabled === false) return { tools: [], disabled: true }

  if (entry?.type === 'remote' && entry.url) {
    try {
      return {
        tools: await listRemoteTools(resolveDemoUrl(entry.url, selfOrigin), entry.headers || {}),
        transport: 'remote'
      }
    } catch (error) {
      return { tools: [], transport: 'remote', error: error instanceof Error ? error.message : String(error) }
    }
  }

  if (entry?.type === 'local' && entry.command?.length) {
    // stdio servers can only be listed by running them: that happens here, in
    // this app, so the result is exact only when opencode is on this host
    const policy = String(useRuntimeConfig().mcpLocalDiscovery || 'always')
    const local = opencodeIsLocal()
    if (policy === 'never' || (policy === 'same-host' && !local)) {
      return { tools: [], transport: 'local', skipped: true }
    }
    try {
      return {
        tools: await fetchToolsStdio(entry.command, entry.environment),
        transport: 'local',
        ...(local ? {} : { approx: true })
      }
    } catch (error) {
      return {
        tools: [],
        transport: 'local',
        ...(local ? {} : { approx: true }),
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  // neither shape: opencode itself ignores such entries
  return {
    tools: [],
    error: entry?.type ? undefined : 'config entry has no "type" — opencode ignores it'
  }
}

// discovery is slow (every server is contacted, local ones are spawned)
// -> cached with stale-while-revalidate. Hand-rolled because the MCP page's
// refresh button must wait for a fresh probe *and* store it for every other
// page, which nitro's swr cache does not do on invalidation.
const MAX_AGE_MS = 300_000
const pending = new Map<string, Promise<Record<string, McpToolsResult>>>()

async function getAllTools(directory: string | undefined, scope: string | undefined, selfOrigin: string, refresh: boolean) {
  const key = `mcp-tools:${scope || 'project'}:${encodeURIComponent(directory || '')}`
  const storage = useStorage('cache')
  const probe = () => {
    let run = pending.get(key)
    if (!run) {
      run = discoverAll(directory, scope, selfOrigin)
        .then(async (value) => {
          await storage.setItem(key, { value, mtime: Date.now() })
          return value
        })
        .finally(() => pending.delete(key))
      pending.set(key, run)
    }
    return run
  }
  const cached = refresh
    ? null
    : await storage.getItem<{ value: Record<string, McpToolsResult>; mtime: number }>(key).catch(() => null)
  if (!cached?.value) return probe()
  if (Date.now() - cached.mtime > MAX_AGE_MS) probe().catch(() => {})
  return cached.value
}

async function discoverAll(directory?: string, scope?: string, selfOrigin?: string) {
  // no fallback here: swallowing a failed /config used to cache an empty
  // result for 5 minutes, so the MCP page stayed blank long after opencode
  // came back. Let the error propagate - the cache only stores successes.
  const config = await opencodeFetch<{ mcp?: Record<string, McpConfigEntry> }>(
    scope === 'global' ? '/global/config' : '/config',
    { query: scope === 'global' ? {} : { directory }, timeoutMs: 30000 }
  ).catch((error) => {
    throw createError({
      statusCode: 502,
      statusMessage: 'Bad Gateway',
      message: `opencode config unavailable: ${error instanceof Error ? error.message : error}`
    })
  })

  const entries = Object.entries(config.mcp || {})
  const results: Record<string, McpToolsResult> = {}
  await Promise.all(entries.map(async ([name, entry]) => {
    results[name] = await probe(entry, selfOrigin)
  }))
  return results
}

export default defineEventHandler(async (event) => {
  requireApiToken(event) // auth on every request; only discovery work is cached
  const { directory, scope, refresh } = getQuery(event) as {
    directory?: string
    scope?: string
    refresh?: string
  }
  const selfOrigin = loopbackOrigin(event.node.req.socket) ?? getRequestURL(event).origin
  return getAllTools(directory, scope, selfOrigin, Boolean(refresh))
})
