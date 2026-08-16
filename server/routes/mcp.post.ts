// MCP server (Streamable HTTP, stateless JSON mode) exposing opencode-web's
// capabilities as tools. Point any MCP client at POST https://<host>/mcp.
// Protected by NUXT_API_TOKEN (Authorization: Bearer) when set.

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: number | string | null
  method: string
  params?: Record<string, any>
}

const PROTOCOL_VERSION = '2025-06-18'

const TOOLS = [
  {
    name: 'list_projects',
    description: 'List projects known to the opencode server (id + worktree path).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'list_sessions',
    description: 'List chat sessions of a project directory.',
    inputSchema: {
      type: 'object',
      properties: { directory: { type: 'string', description: 'Absolute project directory' } },
      required: ['directory']
    }
  },
  {
    name: 'create_session',
    description: 'Create a new chat session in a project directory.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string' },
        title: { type: 'string' }
      },
      required: ['directory']
    }
  },
  {
    name: 'send_prompt',
    description:
      'Send a prompt to opencode and wait for the full reply. Creates a session when session_id is omitted. May run for minutes while the agent works.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string' },
        session_id: { type: 'string' },
        text: { type: 'string' },
        provider_id: { type: 'string' },
        model_id: { type: 'string' },
        agent: { type: 'string' },
        variant: { type: 'string', description: 'think level: none|low|medium|high|xhigh' }
      },
      required: ['directory', 'text']
    }
  },
  {
    name: 'get_messages',
    description: 'Get the messages (with tool calls and costs) of a session.',
    inputSchema: {
      type: 'object',
      properties: { directory: { type: 'string' }, session_id: { type: 'string' } },
      required: ['directory', 'session_id']
    }
  },
  {
    name: 'abort_session',
    description: 'Abort a running session.',
    inputSchema: {
      type: 'object',
      properties: { directory: { type: 'string' }, session_id: { type: 'string' } },
      required: ['directory', 'session_id']
    }
  },
  {
    name: 'list_models',
    description: 'List available providers and models.',
    inputSchema: { type: 'object', properties: { directory: { type: 'string' } } }
  },
  {
    name: 'mcp_status',
    description: 'Status of the MCP servers configured for a project.',
    inputSchema: {
      type: 'object',
      properties: { directory: { type: 'string' } },
      required: ['directory']
    }
  }
]

function textResult(data: unknown) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  return { content: [{ type: 'text', text }] }
}

async function callTool(name: string, args: Record<string, any>) {
  const dir = { directory: args.directory as string | undefined }
  switch (name) {
    case 'list_projects':
      return textResult(await opencodeFetch('/project'))
    case 'list_sessions':
      return textResult(await opencodeFetch('/session', { query: dir }))
    case 'create_session':
      return textResult(
        await opencodeFetch('/session', {
          method: 'POST',
          body: args.title ? { title: args.title } : {},
          query: dir
        })
      )
    case 'send_prompt': {
      let sessionID = args.session_id as string | undefined
      if (!sessionID) {
        const session = await opencodeFetch<{ id: string }>('/session', {
          method: 'POST',
          body: {},
          query: dir
        })
        sessionID = session.id
      }
      const reply = await opencodeFetch<{ parts?: Array<{ type: string; text?: string }> }>(
        `/session/${sessionID}/message`,
        {
          method: 'POST',
          query: dir,
          timeoutMs: 1000 * 60 * 30,
          body: {
            model: args.provider_id && args.model_id
              ? { providerID: args.provider_id, modelID: args.model_id }
              : undefined,
            agent: args.agent,
            variant: args.variant,
            parts: [{ type: 'text', text: args.text }]
          }
        }
      )
      const text = (reply.parts || [])
        .filter((p) => p.type === 'text' && p.text)
        .map((p) => p.text)
        .join('\n\n')
      return textResult(`[session ${sessionID}]\n${text || '(no text reply)'}`)
    }
    case 'get_messages':
      return textResult(await opencodeFetch(`/session/${args.session_id}/message`, { query: dir }))
    case 'abort_session':
      return textResult(await opencodeFetch(`/session/${args.session_id}/abort`, { method: 'POST', query: dir }))
    case 'list_models':
      return textResult(await opencodeFetch('/config/providers', { query: dir }))
    case 'mcp_status':
      return textResult(await opencodeFetch('/mcp', { query: dir }))
    default:
      throw createError({ statusCode: 400, message: `Unknown tool: ${name}` })
  }
}

export default defineEventHandler(async (event) => {
  requireApiToken(event)
  const message = await readBody<JsonRpcRequest>(event)

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
          serverInfo: { name: 'opencode-web', version: '1' },
          instructions:
            'Control an opencode server: list projects, manage chat sessions and send prompts. Always pass the absolute project directory.'
        })
      case 'ping':
        return respond({})
      case 'tools/list':
        return respond({ tools: TOOLS })
      case 'tools/call': {
        const { name, arguments: args } = message.params || {}
        try {
          return respond(await callTool(name, args || {}))
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
