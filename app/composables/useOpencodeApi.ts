import type {
  AgentInfo,
  FileEntry,
  McpStatus,
  MessageWithParts,
  Project,
  ProvidersResponse,
  SessionInfo,
  TodoItem
} from '#shared/types/opencode'

const BASE = '/api/opencode'

/**
 * Thin client for the opencode server, always scoped to a project directory
 * via the `?directory=` query parameter (multi-project single server).
 */
export function useOpencodeApi(directory?: MaybeRefOrGetter<string | undefined>) {
  function q(extra?: Record<string, unknown>) {
    const dir = toValue(directory)
    return { ...(dir ? { directory: dir } : {}), ...(extra || {}) }
  }

  return {
    // ---- projects / global ----
    projects: () => ocFetch<Project[]>(`${BASE}/project`),
    listFiles: (path: string) =>
      ocFetch<FileEntry[]>(`${BASE}/file`, { query: q({ path }) }),

    // ---- config / providers / agents ----
    config: () => ocFetch<Record<string, unknown>>(`${BASE}/config`, { query: q() }),
    patchConfig: (body: Record<string, unknown>) =>
      ocFetch(`${BASE}/config`, { method: 'PATCH', body, query: q() }),
    providers: () => ocFetch<ProvidersResponse>(`${BASE}/config/providers`, { query: q() }),
    agents: () => ocFetch<AgentInfo[]>(`${BASE}/agent`, { query: q() }),

    // ---- auth ----
    setAuth: (providerID: string, key: string) =>
      ocFetch(`${BASE}/auth/${providerID}`, { method: 'PUT', body: { type: 'api', key } }),

    // ---- MCP ----
    mcpStatus: () => ocFetch<Record<string, McpStatus>>(`${BASE}/mcp`, { query: q() }),
    /** All tool ids (including MCP tools, prefixed with the server name). */
    toolIds: () =>
      ocFetch<unknown>(`${BASE}/experimental/tool/ids`, { query: q() })
        .then((res) => {
          const list = Array.isArray(res) ? res : []
          return list
            .map((t) => (typeof t === 'string' ? t : (t as { id?: string })?.id || ''))
            .filter(Boolean)
        })
        .catch(() => [] as string[]),
    mcpAdd: (name: string, config: Record<string, unknown>) =>
      ocFetch(`${BASE}/mcp`, { method: 'POST', body: { name, config }, query: q() }),

    // ---- sessions ----
    sessions: () => ocFetch<SessionInfo[]>(`${BASE}/session`, { query: q() }),
    session: (id: string) => ocFetch<SessionInfo>(`${BASE}/session/${id}`, { query: q() }),
    createSession: (title?: string) =>
      ocFetch<SessionInfo>(`${BASE}/session`, { method: 'POST', body: title ? { title } : {}, query: q() }),
    deleteSession: (id: string) =>
      ocFetch(`${BASE}/session/${id}`, { method: 'DELETE', query: q() }),
    renameSession: (id: string, title: string) =>
      ocFetch(`${BASE}/session/${id}`, { method: 'PATCH', body: { title }, query: q() }),
    abort: (id: string) =>
      ocFetch(`${BASE}/session/${id}/abort`, { method: 'POST', query: q() }),
    messages: (id: string) =>
      ocFetch<MessageWithParts[]>(`${BASE}/session/${id}/message`, { query: q() }),
    todos: (id: string) =>
      ocFetch<TodoItem[]>(`${BASE}/session/${id}/todo`, { query: q() }).catch(() => [] as TodoItem[]),

    /**
     * Send a prompt. The response streams in via SSE, so we deliberately do not
     * await completion here - errors surface as session.error events too.
     */
    prompt: (id: string, body: {
      parts: Array<{ type: 'text'; text: string }>
      model?: { providerID: string; modelID: string }
      agent?: string
      variant?: string
      tools?: Record<string, boolean>
    }) =>
      ocFetch(`${BASE}/session/${id}/message`, {
        method: 'POST',
        body,
        query: q(),
        timeout: 1000 * 60 * 60
      }),

    respondPermission: (sessionID: string, permissionID: string, response: 'once' | 'always' | 'reject') =>
      ocFetch(`${BASE}/session/${sessionID}/permissions/${permissionID}`, {
        method: 'POST',
        body: { response },
        query: q()
      })
  }
}
