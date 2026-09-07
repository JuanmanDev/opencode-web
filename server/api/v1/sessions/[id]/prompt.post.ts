interface PromptBody {
  directory?: string
  text: string
  /** `{ providerID, modelID }` or the shorter `"provider/model"` string */
  model?: { providerID: string; modelID: string } | string
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
  // opencode wants an object; "litellm/glm-5.3-free" is what people naturally type
  let model = body.model
  if (typeof model === 'string') {
    const [providerID, ...rest] = model.split('/')
    const modelID = rest.join('/')
    if (!providerID || !modelID) {
      throw createError({ statusCode: 400, message: 'model must be "provider/model" or { providerID, modelID }' })
    }
    model = { providerID, modelID }
  }

  const reply = await opencodeFetch<AssistantReply>(`/session/${id}/message`, {
    method: 'POST',
    query: { directory: body.directory },
    timeoutMs: 1000 * 60 * 30,
    body: {
      model,
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
