// MCP server (Streamable HTTP, stateless JSON mode) exposing opencode-web's
// capabilities as tools (utils/control-tools.ts). Point any MCP client at
// POST https://<host>/mcp, or register it with opencode itself (MCP page →
// Agent control) so the chat can manage opencode. Protected by
// NUXT_API_TOKEN (Authorization: Bearer) when set.
import { loopbackOrigin } from '../utils/mcp-client'

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: number | string | null
  method: string
  params?: Record<string, any>
}

const PROTOCOL_VERSION = '2025-06-18'

function textResult(data: unknown) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  return { content: [{ type: 'text', text }] }
}

export default defineEventHandler(async (event) => {
  requireApiToken(event)
  const message = await readBody<JsonRpcRequest>(event).catch(() => null)
  if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.method !== 'string') {
    setResponseStatus(event, 400)
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: expected one JSON-RPC object' } }
  }

  // notifications have no id and expect 202 with no body
  if (message.id === undefined || message.id === null) {
    setResponseStatus(event, 202)
    return null
  }

  const respond = (result: unknown) => ({ jsonrpc: '2.0' as const, id: message.id, result })
  const fail = (code: number, msg: string) => ({
    jsonrpc: '2.0' as const,
    id: message.id,
    error: { code, message: msg }
  })

  try {
    switch (message.method) {
      case 'initialize':
        return respond({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'opencode-web', version: '2' },
          instructions:
            'Control the opencode server behind opencode web: projects and chat sessions (list, read, prompt, abort), '
            + 'agent task lists, MCP servers (status, test, add, modes, reconnect), config reloads and scheduled prompts. '
            + 'Pass the absolute project directory where a tool takes one. Call server_info first for an overview. '
            + 'A config reload interrupts replies in that project, so reload_opencode waits until it is idle by default.'
        })
      case 'ping':
        return respond({})
      case 'tools/list':
        return respond({ tools: controlToolList() })
      case 'tools/call': {
        const { name, arguments: args } = message.params || {}
        try {
          const selfOrigin = loopbackOrigin(event.node.req.socket) ?? getRequestURL(event).origin
          return respond(textResult(await callControlTool(name, args || {}, { selfOrigin })))
        } catch (error) {
          return respond({
            content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : error}` }],
            isError: true
          })
        }
      }
      default:
        return fail(-32601, `Method not found: ${message.method}`)
    }
  } catch (error) {
    return fail(-32603, error instanceof Error ? error.message : 'Internal error')
  }
})
