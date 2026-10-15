// One-shot text generation with a model the opencode server already knows:
// a throwaway session gets the prompt (no tools), the reply text comes back
// and the session is deleted. Used to write MCP summaries and agent
// descriptions with "Generate with AI".

export interface AiTextRequest {
  /** "provider/model"; omit for opencode's default model */
  model?: string
  /** project the throwaway session runs in; default: opencode's own */
  directory?: string
  /** instructions placed before the task */
  system?: string
  prompt: string
}

function parseModel(model?: string) {
  if (!model || !model.includes('/')) return undefined
  const [providerID, ...rest] = model.split('/')
  return providerID && rest.length ? { providerID, modelID: rest.join('/') } : undefined
}

export async function aiText(req: AiTextRequest): Promise<string> {
  const query = { directory: req.directory || undefined }
  const session = await opencodeFetch<{ id: string }>('/session', {
    method: 'POST',
    body: { title: 'opencode-web helper (deleted when done)' },
    query,
    timeoutMs: 20_000
  })
  try {
    const reply = await opencodeFetch<{ info?: { error?: { data?: { message?: string }; name?: string } }; parts?: Array<{ type: string; text?: string; synthetic?: boolean }> }>(
      `/session/${encodeURIComponent(session.id)}/message`,
      {
        method: 'POST',
        query,
        timeoutMs: 5 * 60_000,
        body: {
          model: parseModel(req.model),
          // a plain completion: no file edits, no MCP calls
          tools: { '*': false },
          parts: [{ type: 'text', text: [req.system?.trim(), req.prompt.trim()].filter(Boolean).join('\n\n') }]
        }
      }
    )
    const error = reply?.info?.error
    if (error) throw new Error(error.data?.message || error.name || 'the model returned an error')
    const text = (reply?.parts || [])
      .filter((p) => p.type === 'text' && p.text && !p.synthetic)
      .map((p) => p.text!.trim())
      .join('\n\n')
      .trim()
    if (!text) throw new Error('the model returned no text')
    return text
  } finally {
    opencodeFetch(`/session/${encodeURIComponent(session.id)}`, { method: 'DELETE', query }).catch(() => {})
  }
}
