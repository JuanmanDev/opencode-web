// Server-side MCP administration shared by the MCP page (REST) and the
// control MCP tools: read a server's raw entry, save edits without losing the
// secrets the browser only ever sees as "***", and inspect a server end to
// end (connect, initialize, list tools/resources/prompts) with a step log.

import { mcpErrorHint, type McpErrorHint } from '#shared/utils/mcp-hints'
import { connectMcp, errorWithCause, resolveDemoUrl, toToolDetail, type McpConnection, type McpToolDetail } from './mcp-client'
import { opencodeIsLocal } from './mcp-discovery'
import { openStdio } from './mcp-stdio'
import { REDACTED, redactSecrets } from './providers'

export interface McpServerConfig {
  type?: 'remote' | 'local' | string
  url?: string
  headers?: Record<string, string>
  command?: string[]
  environment?: Record<string, string>
  enabled?: boolean
  timeout?: number
  oauth?: false | Record<string, unknown>
  /** opencode 2.x: false exposes the tools directly instead of through `execute` */
  codemode?: boolean
  [key: string]: unknown
}

export type McpScope = 'project' | 'global'

/** Raw (unredacted) MCP map of a scope: never send this to a browser. */
export async function rawMcpConfig(scope: McpScope, directory?: string) {
  const config = await opencodeFetch<{ mcp?: Record<string, McpServerConfig> }>(
    scope === 'global' ? '/global/config' : '/config',
    { query: scope === 'global' ? {} : { directory }, timeoutMs: 20000 }
  )
  return config.mcp || {}
}

/** Where a server is defined: the global config wins when it has the name. */
export async function mcpDefinedIn(name: string, directory?: string): Promise<McpScope | undefined> {
  const [global, merged] = await Promise.all([
    rawMcpConfig('global').catch(() => ({} as Record<string, McpServerConfig>)),
    rawMcpConfig('project', directory).catch(() => ({} as Record<string, McpServerConfig>))
  ])
  if (name in global) return 'global'
  if (name in merged) return 'project'
  return undefined
}

/**
 * Put back the secrets a redacted copy hides: every `"***"` value under
 * headers/environment takes the stored value of the same key, or is dropped
 * when there is none (a placeholder must never be saved as a credential).
 */
export function restoreSecrets(edited: McpServerConfig, stored?: McpServerConfig): McpServerConfig {
  const out: McpServerConfig = { ...edited }
  for (const field of ['headers', 'environment'] as const) {
    const map = edited[field]
    if (!map || typeof map !== 'object') continue
    const restored: Record<string, string> = {}
    for (const [key, value] of Object.entries(map)) {
      if (value === REDACTED) {
        const old = stored?.[field]?.[key]
        if (typeof old === 'string') restored[key] = old
      } else if (typeof value === 'string') {
        restored[key] = value
      }
    }
    out[field] = restored
  }
  return out
}

/** Keep only keys opencode's MCP schema knows, in a stable order. */
export function normalizeServerConfig(config: McpServerConfig): McpServerConfig {
  if (config.type === 'local' || (!config.type && Array.isArray(config.command))) {
    const command = (Array.isArray(config.command) ? config.command : [])
      .map(String).filter((part) => part.length)
    return {
      type: 'local',
      command,
      ...(config.environment && Object.keys(config.environment).length ? { environment: config.environment } : {}),
      enabled: config.enabled !== false,
      ...(typeof config.timeout === 'number' && config.timeout > 0 ? { timeout: Math.round(config.timeout) } : {}),
      ...(typeof config.codemode === 'boolean' ? { codemode: config.codemode } : {})
    }
  }
  return {
    type: 'remote',
    url: String(config.url || '').trim(),
    ...(config.headers && Object.keys(config.headers).length ? { headers: config.headers } : {}),
    enabled: config.enabled !== false,
    ...(config.oauth === false ? { oauth: false as const } : config.oauth && typeof config.oauth === 'object' ? { oauth: config.oauth } : {}),
    ...(typeof config.timeout === 'number' && config.timeout > 0 ? { timeout: Math.round(config.timeout) } : {}),
    ...(typeof config.codemode === 'boolean' ? { codemode: config.codemode } : {})
  }
}

export function validateServerConfig(name: string, config: McpServerConfig): string | undefined {
  if (!/^[\w.-]{1,64}$/.test(name)) return 'name: letters, digits, "-", "_" and "." only (max 64)'
  if (config.type === 'local') {
    if (!config.command?.length) return 'command is required for a local server'
    return undefined
  }
  try {
    const url = new URL(String(config.url))
    if (!/^https?:$/.test(url.protocol)) return 'url must be http(s)'
  } catch {
    return 'url is not a valid URL'
  }
  return undefined
}

export interface McpStatusInfo {
  status: string
  error?: string
}

export async function mcpStatusOf(name: string, directory?: string): Promise<McpStatusInfo | undefined> {
  const status = await opencodeFetch<Record<string, { status?: string; error?: string }>>('/mcp', {
    query: { directory },
    timeoutMs: 120_000
  }).catch(() => ({} as Record<string, { status?: string; error?: string }>))
  const entry = status[name]
  return entry ? { status: String(entry.status || 'unknown'), ...(entry.error ? { error: entry.error } : {}) } : undefined
}

export interface SaveResult {
  name: string
  scope: McpScope
  config: McpServerConfig
  status?: McpStatusInfo
  hint?: McpErrorHint
  /** server rejected a key (old opencode): saved without it */
  dropped?: string[]
  /** headers/variables removed in the editor: saved empty (the config API can't delete keys) */
  blanked?: string[]
}

/**
 * Save one server (create or update) to a scope's config, then make the
 * running opencode pick it up: connect when enabled, disconnect otherwise.
 * The entry is written whole (type, url/command, headers, env); PATCH merges
 * it into the stored one, so keys the user deleted are blanked below.
 */
export async function saveMcpServer(opts: {
  name: string
  scope: McpScope
  directory?: string
  config: McpServerConfig
}): Promise<SaveResult> {
  const { name, scope, directory } = opts
  const stored = (await rawMcpConfig(scope, directory).catch(() => ({} as Record<string, McpServerConfig>)))[name]
  let config = normalizeServerConfig(restoreSecrets(opts.config, stored))
  const invalid = validateServerConfig(name, config)
  if (invalid) throw createError({ statusCode: 400, message: invalid })

  // PATCH deep-merges and opencode's schema refuses null, so a header or
  // variable deleted in the editor cannot be removed: blank it instead
  const blanked: string[] = []
  for (const field of ['headers', 'environment'] as const) {
    const old = stored?.[field]
    if (!old || config.type !== stored?.type) continue
    for (const key of Object.keys(old)) {
      if (config[field]?.[key] === undefined) {
        config[field] = { ...(config[field] || {}), [key]: '' }
        blanked.push(key)
      }
    }
  }

  const path = scope === 'global' ? '/global/config' : '/config'
  const query = scope === 'global' ? {} : { directory }
  const dropped: string[] = []
  const patch = (entry: McpServerConfig) =>
    opencodeFetch(path, { method: 'PATCH', body: { mcp: { [name]: entry } }, query, timeoutMs: 30000 })
  try {
    await patch(config)
  } catch (error) {
    // opencode releases before `oauth`/`timeout` existed reject unknown keys
    const message = error instanceof Error ? error.message : String(error)
    const retry = { ...config }
    for (const key of ['oauth', 'timeout', 'codemode'] as const) {
      if (key in retry && new RegExp(key, 'i').test(message)) {
        delete retry[key]
        dropped.push(key)
      }
    }
    if (!dropped.length) throw error
    config = retry
    await patch(config)
  }

  // register with the running instance too: a PATCH alone is only read on
  // the next instance start on some versions
  if (config.enabled !== false) {
    await opencodeFetch('/mcp', { method: 'POST', body: { name, config }, query: { directory }, timeoutMs: 60_000 }).catch(() => {})
    await opencodeFetch(`/mcp/${encodeURIComponent(name)}/connect`, { method: 'POST', body: {}, query: { directory }, timeoutMs: 60_000 }).catch(() => {})
  } else {
    await opencodeFetch(`/mcp/${encodeURIComponent(name)}/disconnect`, { method: 'POST', body: {}, query: { directory }, timeoutMs: 30_000 }).catch(() => {})
  }
  const status = await mcpStatusOf(name, directory)
  return {
    name,
    scope,
    config: redactSecrets(config),
    status,
    hint: mcpErrorHint(status?.error, status?.status),
    ...(dropped.length ? { dropped } : {}),
    ...(blanked.length ? { blanked } : {})
  }
}

// ---- inspection ----

export interface InspectStep {
  label: string
  ok: boolean
  detail?: string
  ms?: number
}

export interface McpInspectResult {
  ok: boolean
  transport?: 'http' | 'sse' | 'stdio'
  server?: { name?: string; version?: string; protocolVersion?: string; instructions?: string }
  capabilities: string[]
  tools: McpToolDetail[]
  resources: Array<{ uri: string; name?: string; description?: string; mimeType?: string }>
  prompts: Array<{ name: string; description?: string }>
  steps: InspectStep[]
  error?: string
  hint?: McpErrorHint
  stderr?: string
  /** a local server probed on this host while opencode runs elsewhere */
  approx?: boolean
  durationMs: number
}

/**
 * Connect to a server like opencode would and report every step. Remote
 * servers are contacted from this app, local ones spawned here (exact only
 * when opencode runs on the same host). Never throws.
 */
export async function inspectMcpServer(config: McpServerConfig, selfOrigin?: string): Promise<McpInspectResult> {
  const started = Date.now()
  const steps: InspectStep[] = []
  const result: McpInspectResult = { ok: false, capabilities: [], tools: [], resources: [], prompts: [], steps, durationMs: 0 }
  const timeoutMs = Math.min(Math.max(Number(config.timeout) || 0, 15000), 90_000)
  let conn: (McpConnection & { stderr?: () => string }) | undefined
  let init: any

  const step = async <T>(label: string, fn: () => Promise<T>, detail?: (value: T) => string | undefined) => {
    const t = Date.now()
    try {
      const value = await fn()
      steps.push({ label, ok: true, detail: detail?.(value), ms: Date.now() - t })
      return value
    } catch (error) {
      const message = errorWithCause(error)
      steps.push({ label, ok: false, detail: message, ms: Date.now() - t })
      throw error
    }
  }

  try {
    if (config.type === 'local' || (!config.type && config.command)) {
      const policy = String(useRuntimeConfig().mcpLocalDiscovery || 'always')
      if (policy === 'never') throw new Error('local MCP discovery is disabled on this deployment (NUXT_MCP_LOCAL_DISCOVERY=never)')
      result.approx = !opencodeIsLocal()
      const session = await step(
        `Start \`${(config.command || []).join(' ')}\``,
        () => openStdio(config.command || [], config.environment, timeoutMs),
        () => result.approx ? 'started on the web app host; opencode runs elsewhere' : undefined
      )
      conn = session
      init = session.init
      result.transport = 'stdio'
    } else {
      if (!config.url) throw new Error('no url configured')
      const url = resolveDemoUrl(String(config.url), selfOrigin)
      const opened = await step(
        `Connect to ${String(config.url)}`,
        () => connectMcp(url, config.headers || {}, { timeoutMs }),
        (o) => `${o.conn.transport === 'sse' ? 'legacy SSE' : 'Streamable HTTP'} transport`
      )
      conn = opened.conn
      init = opened.init
      result.transport = opened.conn.transport
    }

    result.server = {
      name: init?.serverInfo?.name,
      version: init?.serverInfo?.version,
      protocolVersion: init?.protocolVersion,
      instructions: typeof init?.instructions === 'string' ? init.instructions.slice(0, 2000) : undefined
    }
    result.capabilities = Object.keys(init?.capabilities || {})
    steps.push({
      label: 'Initialize',
      ok: true,
      detail: [result.server.name, result.server.version, result.server.protocolVersion && `protocol ${result.server.protocolVersion}`]
        .filter(Boolean).join(' · ') || undefined
    })

    const tools = await step('List tools', () => conn!.request('tools/list', {}), (r) => `${Array.isArray(r?.tools) ? r.tools.length : 0} tools`)
    result.tools = (Array.isArray(tools?.tools) ? tools.tools : []).map(toToolDetail).filter((t: McpToolDetail) => t.name)
      .sort((a: McpToolDetail, b: McpToolDetail) => a.name.localeCompare(b.name))

    // optional extras: failures here never fail the test
    if (result.capabilities.includes('resources')) {
      await step('List resources', () => conn!.request('resources/list', {}), (r) => `${Array.isArray(r?.resources) ? r.resources.length : 0} resources`)
        .then((r) => {
          result.resources = (Array.isArray(r?.resources) ? r.resources : []).slice(0, 200).map((x: any) => ({
            uri: String(x?.uri || ''), name: x?.name, description: x?.description, mimeType: x?.mimeType
          }))
        })
        .catch(() => {})
    }
    if (result.capabilities.includes('prompts')) {
      await step('List prompts', () => conn!.request('prompts/list', {}), (r) => `${Array.isArray(r?.prompts) ? r.prompts.length : 0} prompts`)
        .then((r) => {
          result.prompts = (Array.isArray(r?.prompts) ? r.prompts : []).slice(0, 200).map((x: any) => ({
            name: String(x?.name || ''), description: x?.description
          }))
        })
        .catch(() => {})
    }
    result.ok = true
  } catch (error) {
    result.error = errorWithCause(error)
    result.hint = mcpErrorHint(result.error)
  } finally {
    const stderr = conn?.stderr?.()
    if (stderr) result.stderr = stderr.slice(-1500)
    conn?.close()
    result.durationMs = Date.now() - started
  }
  return result
}

/** Drop every cached tool discovery (after a server was added or edited). */
export async function forgetMcpTools() {
  const storage = useStorage('cache')
  const keys = await storage.getKeys('mcp-tools').catch(() => [] as string[])
  await Promise.all(keys.map((key) => storage.removeItem(key).catch(() => {})))
}
