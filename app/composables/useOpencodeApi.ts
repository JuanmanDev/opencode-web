import { ocFetch } from './useServerHealth'
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

    /** opencode's own paths - reveals which OS/host it runs on. */
    paths: () =>
      ocFetch<{ home?: string; directory?: string; worktree?: string; config?: string }>(
        `${BASE}/path`, { query: q() }
      ),

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
    mcpAdd: (name: string, config: Record<string, unknown>) =>
      ocFetch(`${BASE}/mcp`, { method: 'POST', body: { name, config }, query: q() }),
    /** Retry a failed server without restarting opencode. */
    mcpConnect: (name: string) =>
      ocFetch<boolean>(`${BASE}/mcp/${encodeURIComponent(name)}/connect`, {
        method: 'POST', body: {}, query: q(), timeout: 1000 * 60
      }),
    mcpDisconnect: (name: string) =>
      ocFetch<boolean>(`${BASE}/mcp/${encodeURIComponent(name)}/disconnect`, {
        method: 'POST', body: {}, query: q()
      }),
    /** Begin OAuth for a server that reports `needs_auth`; returns the consent URL. */
    mcpAuthStart: (name: string) =>
      ocFetch<{ authorizationUrl: string; oauthState: string }>(
        `${BASE}/mcp/${encodeURIComponent(name)}/auth`,
        { method: 'POST', body: {}, query: q() }
      ),
    /** Finish OAuth with the code pasted back from the consent screen. */
    mcpAuthCallback: (name: string, code: string) =>
      ocFetch<Record<string, unknown>>(`${BASE}/mcp/${encodeURIComponent(name)}/auth/callback`, {
        method: 'POST', body: { code }, query: q(), timeout: 1000 * 60
      }),

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
    fork: (id: string, messageID?: string) =>
      ocFetch<SessionInfo>(`${BASE}/session/${id}/fork`, {
        method: 'POST',
        body: messageID ? { messageID } : {},
        query: q()
      }),
    diff: (id: string) =>
      ocFetch<unknown>(`${BASE}/session/${id}/diff`, { method: 'POST', body: {}, query: q() }),

    prompt: (id: string, body: {
      parts: Array<Record<string, unknown>>
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

    // ---- global config (all projects) ----
    globalConfig: () => ocFetch<Record<string, unknown>>(`${BASE}/global/config`),
    patchGlobalConfig: (body: Record<string, unknown>) =>
      ocFetch(`${BASE}/global/config`, { method: 'PATCH', body }),

    // ---- commands & shell ----
    commands: () =>
      ocFetch<Array<{ name: string; description?: string; template?: string; source?: string }>>(
        `${BASE}/command`, { query: q() }
      ).catch(() => []),
    runCommand: (id: string, command: string, args?: string, extra?: Record<string, unknown>) =>
      ocFetch(`${BASE}/session/${id}/command`, {
        method: 'POST',
        body: { command, ...(args ? { arguments: args } : {}), ...(extra || {}) },
        query: q(),
        timeout: 1000 * 60 * 60
      }),
    shell: (id: string, command: string, extra?: Record<string, unknown>) =>
      ocFetch(`${BASE}/session/${id}/shell`, {
        method: 'POST',
        body: { command, ...(extra || {}) },
        query: q(),
        timeout: 1000 * 60 * 30
      }),
    share: (id: string) =>
      ocFetch<{ share?: { url?: string } } & Record<string, unknown>>(`${BASE}/session/${id}/share`, { method: 'POST', body: {}, query: q() }),
    summarize: (id: string) =>
      ocFetch(`${BASE}/session/${id}/summarize`, { method: 'POST', body: {}, query: q(), timeout: 1000 * 60 * 10 }),
    revert: (id: string) =>
      ocFetch(`${BASE}/session/${id}/revert`, { method: 'POST', body: {}, query: q() }),
    unrevert: (id: string) =>
      ocFetch(`${BASE}/session/${id}/unrevert`, { method: 'POST', body: {}, query: q() }),

    // ---- questions (agent asking the user) ----
    questions: () =>
      ocFetch<unknown>(`${BASE}/question`, { query: q() })
        .then((res) => (Array.isArray(res) ? res : (res as { data?: unknown[] })?.data || []) as Array<Record<string, any>>)
        .catch(() => [] as Array<Record<string, any>>),
    replyQuestion: (requestID: string, answers: string[][]) =>
      ocFetch(`${BASE}/question/${requestID}/reply`, { method: 'POST', body: { answers }, query: q() }),
    rejectQuestion: (requestID: string) =>
      ocFetch(`${BASE}/question/${requestID}/reject`, { method: 'POST', body: {}, query: q() }),

    respondPermission: (sessionID: string, permissionID: string, response: 'once' | 'always' | 'reject') =>
      ocFetch(`${BASE}/session/${sessionID}/permissions/${permissionID}`, {
        method: 'POST',
        body: { response },
        query: q()
      })
  }
}
