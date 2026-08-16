interface PromptBody {
  directory?: string
  text: string
  model?: { providerID: string; modelID: string }
  agent?: string
  variant?: string
  tools?: Record<string, boolean>
}

interface AssistantReply {
  info?: Record<string, unknown>
  parts?: Array<{ type: string; text?: string }>
}

// Sends a prompt and waits for the full assistant reply (may take minutes).
export default defineEventHandler(async (event) => {
  requireApiToken(event)
  const id = getRouterParam(event, 'id')!
  const body = await readBody<PromptBody>(event)
  if (!body?.text) {
    throw createError({ statusCode: 400, message: 'text is required' })
  }

  const reply = await opencodeFetch<AssistantReply>(`/session/${id}/message`, {
    method: 'POST',
    query: { directory: body.directory },
    timeoutMs: 1000 * 60 * 30,
    body: {
      model: body.model,
      agent: body.agent,
      variant: body.variant,
      tools: body.tools,
      parts: [{ type: 'text', text: body.text }]
    }
  })

  const text = (reply.parts || [])
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => p.text)
    .join('\n\n')

  return { sessionID: id, text, message: reply }
})
