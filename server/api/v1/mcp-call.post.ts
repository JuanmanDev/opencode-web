// Recover the ui:// resources opencode strips from MCP tool outputs, straight
// from the remote server. `mode: 'template'` only reads a declared MCP Apps
// template and never executes anything; `mode: 'call'` re-runs the tool, which
// the UI reserves for read-only tools or an explicit click. Cached briefly so
// page reloads don't re-trigger tools.

import { createHash } from 'node:crypto'

// dynamically-registered servers (POST /mcp) never land in any config file,
// so well-known ones get a fallback URL
const KNOWN_URLS: Record<string, string> = {
  'mcp-ui-demo': 'https://remote-mcp-server-authless.idosalomon.workers.dev/mcp'
}

const cachedRecover = defineCachedFunction(
  async (directory: string | undefined, toolId: string, argsJson: string, mode: 'template' | 'call', selfOrigin?: string) => {
    const [config, globalConfig] = await Promise.all([
      opencodeFetch<{ mcp?: Record<string, McpRemoteEntry> }>('/config', { query: { directory } }).catch(() => ({ mcp: {} })),
      opencodeFetch<{ mcp?: Record<string, McpRemoteEntry> }>('/global/config').catch(() => ({ mcp: {} }))
    ])
    const merged: Record<string, McpRemoteEntry> = {
      ...Object.fromEntries(Object.entries(KNOWN_URLS).map(([name, url]) => [name, { type: 'remote', url }])),
      ...(globalConfig.mcp || {}),
      ...(config.mcp || {})
    }
    const resolved = resolveMcpTool(merged, toolId)
    if (!resolved) throw createError({ statusCode: 404, message: `No MCP server matches tool ${toolId}` })
    if (resolved.entry.type !== 'remote' || !resolved.entry.url) {
      throw createError({ statusCode: 400, message: `${resolved.server} is not a remote MCP server` })
    }
    return recoverToolUi(
      resolveDemoUrl(resolved.entry.url, selfOrigin),
      resolved.entry.headers || {},
      resolved.tool,
      JSON.parse(argsJson),
      mode
    )
  },
  {
    name: 'mcp-call',
    maxAge: 300,
    // hashed: long argument payloads must not collide on a shared prefix
    getKey: (directory: string | undefined, toolId: string, argsJson: string, mode: string) =>
      createHash('sha1').update(`${mode}|${directory || ''}|${toolId}|${argsJson}`).digest('hex')
  }
)

export default defineEventHandler(async (event) => {
  requireApiToken(event)
  const body = await readBody<{
    directory?: string
    toolId: string
    arguments?: Record<string, unknown>
    mode?: 'template' | 'call'
  }>(event)
  if (!body?.toolId) throw createError({ statusCode: 400, message: 'toolId is required' })
  return cachedRecover(
    body.directory,
    body.toolId,
    JSON.stringify(body.arguments || {}),
    body.mode === 'template' ? 'template' : 'call',
    loopbackOrigin(event.node.req.socket) ?? getRequestURL(event).origin
  )
})
