// WebMCP (navigator.modelContext) — expose page tools to in-browser agents.
// Progressive enhancement: no-op on browsers without the API.
export default defineNuxtPlugin(() => {
  const mc =
    (document as unknown as { modelContext?: any }).modelContext ||
    (navigator as unknown as { modelContext?: any }).modelContext
  if (!mc) return

  const text = (data: unknown) => ({
    content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }]
  })

  const tools = [
    {
      name: 'opencode_list_projects',
      description: 'List projects available in this opencode web app.',
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        return text(await $fetch('/api/v1/projects'))
      }
    },
    {
      name: 'opencode_list_sessions',
      description: 'List chat sessions for a project directory.',
      inputSchema: {
        type: 'object',
        properties: { directory: { type: 'string' } },
        required: ['directory']
      },
      async execute({ directory }: { directory: string }) {
        return text(await $fetch('/api/v1/sessions', { query: { directory } }))
      }
    },
    {
      name: 'opencode_send_prompt',
      description:
        'Send a prompt to the opencode coding agent for a project directory and wait for the reply. Creates a session when session_id is omitted.',
      inputSchema: {
        type: 'object',
        properties: {
          directory: { type: 'string' },
          text: { type: 'string' },
          session_id: { type: 'string' }
        },
        required: ['directory', 'text']
      },
      async execute(args: { directory: string; text: string; session_id?: string }) {
        let sessionID = args.session_id
        if (!sessionID) {
          const session = await $fetch<{ id: string }>('/api/v1/sessions', {
            method: 'POST',
            body: { directory: args.directory }
          })
          sessionID = session.id
        }
        const reply = await $fetch<{ text: string }>(`/api/v1/sessions/${sessionID}/prompt`, {
          method: 'POST',
          body: { directory: args.directory, text: args.text },
          timeout: 1000 * 60 * 30
        })
        return text(`[session ${sessionID}]\n${reply.text}`)
      }
    },
    {
      name: 'opencode_open_project',
      description: 'Navigate this page to a project (by absolute directory path).',
      inputSchema: {
        type: 'object',
        properties: { directory: { type: 'string' } },
        required: ['directory']
      },
      async execute({ directory }: { directory: string }) {
        await navigateTo(`/p/${encodeDir(directory)}`)
        return text(`Opened ${directory}`)
      }
    }
  ]

  try {
    if (typeof mc.registerTool === 'function') {
      for (const tool of tools) mc.registerTool(tool)
    } else if (typeof mc.provideContext === 'function') {
      mc.provideContext({ tools })
    }
  } catch {
    // WebMCP API shape changed — stay silent, the app works without it
  }
})
