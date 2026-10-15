// Tools of this app's MCP server (POST /mcp). Two audiences:
// - external MCP clients (Claude, Cursor, n8n) driving opencode remotely
// - opencode's own agent, once the server is registered with opencode
//   (MCP page → "Agent control"): the chat can then manage opencode itself —
//   MCP servers, config reloads, other sessions, task lists and schedules.
// Read-only tools carry `readOnlyHint`; the rest are registered as "ask".

import { mcpErrorHint } from '#shared/utils/mcp-hints'
import { describeCron } from '#shared/utils/cron'
import type { McpServerConfig } from './mcp-admin'

type Args = Record<string, any>

export interface ControlTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; title?: string }
  run: (args: Args, ctx: { selfOrigin?: string }) => Promise<unknown>
}

const dirProp = { type: 'string', description: 'Absolute project directory on the opencode server' }
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false
})
const read = { readOnlyHint: true }

function q(directory?: string) {
  return { directory: directory || undefined }
}

function parseModel(args: Args) {
  if (typeof args.model === 'string' && args.model.includes('/')) {
    const [providerID, ...rest] = args.model.split('/')
    return { providerID, modelID: rest.join('/') }
  }
  return args.provider_id && args.model_id ? { providerID: args.provider_id, modelID: args.model_id } : undefined
}

async function requireConfigApi(feature: string) {
  if (!(await getCapabilities()).config) {
    throw new Error(`${feature} is not available: this opencode server speaks the v2 protocol, which has no config API yet`)
  }
}

function replyText(reply: { parts?: Array<{ type: string; text?: string }> }) {
  return (reply?.parts || []).filter((p) => p.type === 'text' && p.text).map((p) => p.text).join('\n\n')
}

export const CONTROL_TOOLS: ControlTool[] = [
  // ---- overview ----
  {
    name: 'server_info',
    description: 'Overview of the opencode server behind this app: version, API protocol (1.x or v2), supported features, busy sessions, schedules and the last config reload. Start here.',
    inputSchema: obj({ directory: dirProp }),
    annotations: read,
    run: async (args) => {
      // newer 1.x servers also report git, language servers and formatters
      const optional = (path: string) => args.directory
        ? opencodeFetch(path, { query: q(args.directory), timeoutMs: 10000 }).catch(() => undefined)
        : Promise.resolve(undefined)
      const [profile, capabilities, busy, schedules, paths, vcs, lsp, formatter] = await Promise.all([
        getServerProfile(),
        getCapabilities(),
        busySessions(args.directory).catch(() => []),
        schedulerStats(),
        opencodeFetch('/path', { query: q(args.directory) }).catch(() => null),
        optional('/vcs'),
        optional('/lsp'),
        optional('/formatter')
      ])
      return {
        opencode: { version: profile.version || 'unknown', protocol: profile.protocol, reachable: profile.reachable },
        capabilities,
        paths,
        ...(vcs ? { vcs } : {}),
        ...(lsp ? { lsp } : {}),
        ...(formatter ? { formatter } : {}),
        busySessions: busy,
        schedules,
        lastReload: reloadStatus() || null,
        webTime: new Date().toString()
      }
    }
  },

  // ---- projects & sessions ----
  {
    name: 'list_projects',
    description: 'List projects known to the opencode server (id + worktree path).',
    inputSchema: obj({}),
    annotations: read,
    run: () => opencodeFetch('/project')
  },
  {
    name: 'create_project',
    description: 'Register a directory as an opencode project (creates its first session).',
    inputSchema: obj({ directory: dirProp, title: { type: 'string' } }, ['directory']),
    run: (args) => opencodeFetch('/session', { method: 'POST', body: args.title ? { title: args.title } : {}, query: q(args.directory) })
  },
  {
    name: 'list_sessions',
    description: 'List chat sessions of a project, newest first, with a busy flag. Omit directory to list the sessions of every project.',
    inputSchema: obj({ directory: dirProp, limit: { type: 'number', description: 'max sessions per project (default 30)' } }),
    annotations: read,
    run: async (args) => {
      const dirs = args.directory ? [args.directory] : (await listProjectDirs()).map((p) => p.worktree)
      const limit = Math.max(1, Math.min(Number(args.limit) || 30, 500))
      const out = await Promise.all(dirs.map(async (directory) => {
        const [sessions, { status }] = await Promise.all([
          opencodeFetch<Array<{ id: string; title?: string; parentID?: string; time?: { created?: number; updated?: number } }>>('/session', { query: q(directory) })
            .catch(() => []),
          sessionStatus(directory)
        ])
        return {
          directory,
          sessions: [...sessions].sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0)).slice(0, limit).map((s) => ({
            id: s.id,
            title: s.title,
            ...(s.parentID ? { parentID: s.parentID } : {}),
            updated: s.time?.updated ? new Date(s.time.updated).toISOString() : undefined,
            status: status[s.id]?.type || 'idle'
          }))
        }
      }))
      return args.directory ? out[0] : out
    }
  },
  {
    name: 'session_status',
    description: 'Which sessions are busy (generating a reply) right now. Omit directory to check every project.',
    inputSchema: obj({ directory: dirProp }),
    annotations: read,
    run: (args) => busySessions(args.directory)
  },
  {
    name: 'read_session',
    description: 'Read another chat: a compact transcript (user/assistant text and one line per tool call) of the last messages of a session.',
    inputSchema: obj({
      directory: dirProp,
      session_id: { type: 'string' },
      last: { type: 'number', description: 'how many messages (default 20, max 200)' }
    }, ['session_id']),
    annotations: read,
    run: (args) => sessionTranscript(args.directory, String(args.session_id), Number(args.last) || 20)
  },
  {
    name: 'get_messages',
    description: 'Raw messages (with tool calls and costs) of a session, as JSON. Prefer read_session for reading.',
    inputSchema: obj({ directory: dirProp, session_id: { type: 'string' } }, ['session_id']),
    annotations: read,
    run: (args) => opencodeFetch(`/session/${encodeURIComponent(String(args.session_id))}/message`, { query: q(args.directory) })
  },
  {
    name: 'create_session',
    description: 'Create a new chat session in a project directory.',
    inputSchema: obj({ directory: dirProp, title: { type: 'string' } }, ['directory']),
    run: (args) => opencodeFetch('/session', { method: 'POST', body: args.title ? { title: args.title } : {}, query: q(args.directory) })
  },
  {
    name: 'send_prompt',
    description: 'Send a prompt to a chat session (a new one when session_id is omitted). By default waits for the full reply, which may take minutes; wait=false returns as soon as the prompt is queued. A session cannot be prompted while it is busy, so an agent cannot prompt its own session.',
    inputSchema: obj({
      directory: dirProp,
      session_id: { type: 'string' },
      text: { type: 'string' },
      model: { type: 'string', description: '"provider/model"; omit for the default model' },
      provider_id: { type: 'string' },
      model_id: { type: 'string' },
      agent: { type: 'string' },
      variant: { type: 'string', description: 'think level: none|low|medium|high|xhigh' },
      wait: { type: 'boolean', description: 'wait for the reply (default true)' }
    }, ['directory', 'text']),
    run: async (args) => {
      let sessionID = args.session_id as string | undefined
      if (sessionID) {
        const { status } = await sessionStatus(args.directory)
        const type = status[sessionID]?.type
        if (type && type !== 'idle') {
          throw new Error(`session ${sessionID} is busy (${type}). Wait until it is idle; an agent cannot prompt the session it is running in.`)
        }
      } else {
        sessionID = (await opencodeFetch<{ id: string }>('/session', { method: 'POST', body: {}, query: q(args.directory) })).id
      }
      const body = {
        model: parseModel(args),
        agent: args.agent,
        variant: args.variant,
        parts: [{ type: 'text', text: args.text }]
      }
      const path = `/session/${encodeURIComponent(sessionID)}`
      if (args.wait === false) {
        await opencodeFetch(`${path}/prompt_async`, { method: 'POST', query: q(args.directory), body, timeoutMs: 30000 })
          .catch(() => {
            // servers without prompt_async: fire the blocking route, don't await it
            opencodeFetch(`${path}/message`, { method: 'POST', query: q(args.directory), body, timeoutMs: 1000 * 60 * 60 }).catch(() => {})
          })
        return `[session ${sessionID}] prompt queued; use session_status / read_session to follow it`
      }
      const reply = await opencodeFetch<{ parts?: Array<{ type: string; text?: string }> }>(`${path}/message`, {
        method: 'POST', query: q(args.directory), timeoutMs: 1000 * 60 * 30, body
      })
      return `[session ${sessionID}]\n${replyText(reply) || '(no text reply)'}`
    }
  },
  {
    name: 'abort_session',
    description: 'Stop the reply a session is generating.',
    inputSchema: obj({ directory: dirProp, session_id: { type: 'string' } }, ['session_id']),
    annotations: { destructiveHint: true },
    run: (args) => opencodeFetch(`/session/${encodeURIComponent(String(args.session_id))}/abort`, { method: 'POST', query: q(args.directory) })
  },
  {
    name: 'fork_session',
    description: 'Fork a chat session (optionally from a specific message id) and return the new session.',
    inputSchema: obj({ directory: dirProp, session_id: { type: 'string' }, message_id: { type: 'string' } }, ['session_id']),
    run: (args) => opencodeFetch(`/session/${encodeURIComponent(String(args.session_id))}/fork`, {
      method: 'POST', body: args.message_id ? { messageID: args.message_id } : {}, query: q(args.directory)
    })
  },
  {
    name: 'list_tasks',
    description: 'The agent task lists (todos) of a project\'s sessions: open items of busy and recent sessions, or every item of one session.',
    inputSchema: obj({
      directory: dirProp,
      session_id: { type: 'string' },
      include_done: { type: 'boolean', description: 'also list completed/cancelled items' }
    }),
    annotations: read,
    run: (args) => listTasks(args.directory, args.session_id, Boolean(args.include_done))
  },

  // ---- models, agents, commands, skills, config ----
  {
    name: 'list_models',
    description: 'List configured providers and their models (API keys redacted).',
    inputSchema: obj({ directory: dirProp }),
    annotations: read,
    run: async (args) => {
      const data = redactSecrets(await opencodeFetch<{ providers?: Array<{ id: string; name?: string; models?: Record<string, { name?: string }> }>; default?: Record<string, string> }>('/config/providers', { query: q(args.directory) }))
      return {
        default: data.default,
        providers: (data.providers || []).map((p) => ({ id: p.id, name: p.name, models: Object.keys(p.models || {}) }))
      }
    }
  },
  {
    name: 'list_agents',
    description: 'List the agents (build, plan, custom ones) available in a project.',
    inputSchema: obj({ directory: dirProp }),
    annotations: read,
    run: async (args) => (await opencodeFetch<Array<{ name: string; description?: string; mode?: string }>>('/agent', { query: q(args.directory) }))
      .map((a) => ({ name: a.name, description: a.description, mode: a.mode }))
  },
  {
    name: 'list_commands',
    description: 'List the slash commands available in a project.',
    inputSchema: obj({ directory: dirProp }),
    annotations: read,
    run: async (args) => (await opencodeFetch<Array<{ name: string; description?: string }>>('/command', { query: q(args.directory) }))
      .map((c) => ({ name: c.name, description: c.description }))
  },
  {
    name: 'list_skills',
    description: 'List the skills opencode can load in a project.',
    inputSchema: obj({ directory: dirProp }),
    annotations: read,
    run: async (args) => {
      const skills = await opencodeFetch<Array<{ name: string; description?: string; location?: string }>>('/skill', { query: q(args.directory) })
        .catch(() => { throw new Error('this opencode server has no skills API') })
      return skills.map((s) => ({ name: s.name, description: s.description, location: s.location }))
    }
  },
  {
    name: 'get_config',
    description: 'Read the opencode config of a project (merged with the global one) or the global config only. Secrets are redacted.',
    inputSchema: obj({ directory: dirProp, global: { type: 'boolean' } }),
    annotations: read,
    run: async (args) => {
      await requireConfigApi('Reading the config')
      return redactSecrets(await opencodeFetch(args.global ? '/global/config' : '/config', { query: args.global ? {} : q(args.directory) }))
    }
  },
  {
    name: 'reload_opencode',
    description: 'Make opencode re-read its config (MCP servers, agents, providers, permissions). scope "project" reloads one project, "all" every project (like restarting opencode serve). Replies running in a reloaded project are cut off, so by default (when="idle") the reload waits until no session there is busy, including your own reply: it happens right after you finish. Check the result with server_info.',
    inputSchema: obj({
      directory: dirProp,
      scope: { type: 'string', enum: ['project', 'all'], description: 'default: project when a directory is given, else all' },
      when: { type: 'string', enum: ['idle', 'now'], description: 'default idle' }
    }),
    annotations: { destructiveHint: true },
    run: async (args) => {
      await assertReloadable()
      const scope = args.scope === 'all' || (!args.scope && !args.directory) ? 'all' : 'project'
      const state = requestReload({ scope, directory: args.directory, when: args.when === 'now' ? 'now' : 'idle' })
      return `Reload of ${scope === 'all' ? 'every opencode instance' : state.directory} scheduled (${state.when === 'now' ? 'in ~2 seconds' : 'as soon as no session is busy'}). New sessions use the reloaded config.`
    }
  },

  // ---- MCP servers ----
  {
    name: 'list_mcp',
    description: 'List MCP servers with status, errors (plus how to fix them), transport and tool counts. include_tools adds each tool with its description.',
    inputSchema: obj({
      directory: dirProp,
      global: { type: 'boolean', description: 'the global config instead of the project\'s' },
      include_tools: { type: 'boolean' },
      refresh: { type: 'boolean', description: 're-probe every server instead of using the 5 minute cache' }
    }),
    annotations: read,
    run: async (args, ctx) => {
      await requireConfigApi('MCP')
      const scope = args.global ? 'global' : 'project'
      const [status, config, tools] = await Promise.all([
        opencodeFetch<Record<string, { status?: string; error?: string }>>('/mcp', { query: q(args.directory), timeoutMs: 120_000 }).catch(() => ({} as Record<string, { status?: string; error?: string }>)),
        rawMcpConfig(scope, args.directory).catch(() => ({} as Record<string, McpServerConfig>)),
        getAllTools(args.directory, scope, ctx.selfOrigin || '', Boolean(args.refresh)).catch(() => ({} as Awaited<ReturnType<typeof getAllTools>>))
      ])
      const names = [...new Set([...Object.keys(config), ...Object.keys(status)])].sort()
      return names.map((name) => {
        const entry = config[name]
        const s = status[name]
        const found = tools[name]
        const error = s?.error || found?.error
        const hint = mcpErrorHint(error, s?.status)
        return {
          name,
          status: s?.status || (entry?.enabled === false ? 'disabled' : 'unknown'),
          type: entry?.type,
          target: entry?.url || (entry?.command || []).join(' ') || undefined,
          enabled: entry ? entry.enabled !== false : undefined,
          ...(error ? { error } : {}),
          ...(hint ? { fix: `${hint.title}. ${hint.fix}` } : {}),
          toolCount: found?.tools.length ?? 0,
          ...(args.include_tools ? { tools: (found?.tools || []).map((t) => ({ id: `${name}_${t.name}`, description: t.description })) } : {})
        }
      })
    }
  },
  {
    name: 'mcp_status',
    description: 'Raw connection status of the MCP servers of a project.',
    inputSchema: obj({ directory: dirProp }),
    annotations: read,
    run: (args) => opencodeFetch('/mcp', { query: q(args.directory), timeoutMs: 120_000 })
  },
  {
    name: 'test_mcp',
    description: 'Test an MCP server end to end without saving anything: connect, initialize, list tools/resources/prompts, with a step log and a suggested fix on failure. Pass name to test a configured server, or config to test a new one.',
    inputSchema: obj({
      directory: dirProp,
      name: { type: 'string' },
      config: { type: 'object', description: '{ type: "remote", url, headers? } or { type: "local", command: [..], environment? }' }
    }),
    // an ad-hoc local config spawns a process on the web host: not read-only
    run: async (args, ctx) => {
      let config = args.config as McpServerConfig | undefined
      if (args.name) {
        const scope = await mcpDefinedIn(String(args.name), args.directory)
        const stored = scope ? (await rawMcpConfig(scope, args.directory))[String(args.name)] : undefined
        config = config ? normalizeServerConfig(restoreSecrets(config, stored)) : stored
      }
      if (!config) throw new Error(args.name ? `no MCP server named ${args.name}` : 'pass name or config')
      const result = await inspectMcpServer(normalizeServerConfig(config), ctx.selfOrigin)
      return {
        ...result,
        tools: result.tools.map((t) => ({ name: t.name, description: t.description, params: t.params.map((p) => `${p.name}${p.required ? '' : '?'}: ${p.type || 'any'}`) }))
      }
    }
  },
  {
    name: 'add_mcp',
    description: 'Add an MCP server, or replace the config of an existing one, and connect it. Saved to the project config, or the global one with global=true. Header/env values given as "***" keep their stored secret.',
    inputSchema: obj({
      directory: dirProp,
      name: { type: 'string' },
      config: {
        type: 'object',
        description: 'remote: { "type": "remote", "url": "https://…/mcp", "headers": {…}, "oauth": false }; local: { "type": "local", "command": ["npx","-y","pkg"], "environment": {…}, "timeout": 60000 }'
      },
      global: { type: 'boolean' }
    }, ['name', 'config']),
    run: async (args) => {
      await requireConfigApi('Adding MCP servers')
      const result = await saveMcpServer({
        name: String(args.name),
        scope: args.global ? 'global' : 'project',
        directory: args.directory,
        config: args.config as McpServerConfig
      })
      await forgetMcpTools()
      return result
    }
  },
  {
    name: 'connect_mcp',
    description: 'Reconnect an MCP server (e.g. after it failed or its credentials changed) without reloading opencode.',
    inputSchema: obj({ directory: dirProp, name: { type: 'string' } }, ['name']),
    run: async (args) => {
      await opencodeFetch(`/mcp/${encodeURIComponent(String(args.name))}/connect`, { method: 'POST', body: {}, query: q(args.directory), timeoutMs: 60_000 })
      const status = await mcpStatusOf(String(args.name), args.directory)
      const hint = mcpErrorHint(status?.error, status?.status)
      return { ...status, ...(hint ? { fix: `${hint.title}. ${hint.fix}` } : {}) }
    }
  },
  {
    name: 'disconnect_mcp',
    description: 'Disconnect an MCP server until the next reload, without changing the config.',
    inputSchema: obj({ directory: dirProp, name: { type: 'string' } }, ['name']),
    run: async (args) => {
      await opencodeFetch(`/mcp/${encodeURIComponent(String(args.name))}/disconnect`, { method: 'POST', body: {}, query: q(args.directory) })
      return `${args.name} disconnected`
    }
  },
  {
    name: 'set_mcp_mode',
    description: 'Set an MCP server to off, ask (permission prompt per call) or auto (no prompt). Persists in the opencode config; applies to new sessions.',
    inputSchema: obj({
      directory: dirProp,
      server: { type: 'string' },
      mode: { type: 'string', enum: ['off', 'ask', 'auto'] },
      global: { type: 'boolean', description: 'apply to the global config instead of the project' }
    }, ['server', 'mode']),
    run: async (args, ctx) => {
      await requireConfigApi('Changing MCP modes')
      const body: Record<string, unknown> = args.mode === 'off'
        ? { mcp: { [args.server]: { enabled: false } } }
        : { mcp: { [args.server]: { enabled: true } }, permission: { [`${args.server}_*`]: args.mode === 'ask' ? 'ask' : 'allow' } }
      const applied = await patchConfig(args.global ? 'global' : 'project', args.directory, body)
      await forgetMcpTools()
      autoSyncNest(ctx.selfOrigin)
      return `${args.server} set to ${args.mode} in the ${applied.scope} config${applied.fallback ? ' (this opencode ignores project config written through its API)' : ''}; applies to new sessions`
    }
  },
  {
    name: 'set_tool_mode',
    description: 'Set a single tool (id like server_tool) to off, ask, auto or inherit.',
    inputSchema: obj({
      directory: dirProp,
      tool: { type: 'string' },
      mode: { type: 'string', enum: ['off', 'ask', 'auto', 'inherit'] },
      global: { type: 'boolean' }
    }, ['tool', 'mode']),
    run: async (args) => {
      await requireConfigApi('Changing tool modes')
      const body: Record<string, unknown> = args.mode === 'off'
        ? { tools: { [args.tool]: false } }
        : args.mode === 'inherit'
          ? { tools: { [args.tool]: true } }
          : { tools: { [args.tool]: true }, permission: { [args.tool]: args.mode === 'ask' ? 'ask' : 'allow' } }
      const applied = await patchConfig(args.global ? 'global' : 'project', args.directory, body)
      return `${args.tool} set to ${args.mode} in the ${applied.scope} config`
    }
  },

  // ---- MCP subagents (one specialist per server + an orchestrator) ----
  {
    name: 'mcp_subagents',
    description: 'Show the MCP subagents setup: whether it is on, the orchestrator agent, and for each MCP server its specialist subagent and the summary the orchestrator uses to decide what to send it.',
    inputSchema: obj({}),
    annotations: read,
    run: async (_args, ctx) => {
      const plan = await planNest(ctx.selfOrigin)
      return {
        enabled: plan.settings.enabled,
        orchestrator: plan.settings.orchestrator,
        lastSync: plan.settings.lastSync || null,
        specialists: plan.servers.map((s) => ({
          server: s.server,
          agent: s.agent,
          included: s.included,
          ...(s.skipped ? { skipped: s.skipped } : {}),
          summary: s.summary,
          customSummary: s.custom,
          tools: s.tools.length
        }))
      }
    }
  },
  {
    name: 'configure_mcp_subagents',
    description: 'Turn the MCP subagents on or off, change the summary of a specialist (what the orchestrator sends it), leave servers out, or add instructions for the orchestrator. Writes the agents into the global opencode config; they apply after an automatic reload once no session is busy.',
    inputSchema: obj({
      enabled: { type: 'boolean' },
      summaries: { type: 'object', description: '{ "<server>": "when to use it and what to send" }; an empty string restores the generated summary' },
      exclude: { type: 'array', items: { type: 'string' }, description: 'servers without a specialist' },
      instructions: { type: 'string', description: 'extra instructions appended to the orchestrator prompt' }
    }),
    run: async (args, ctx) => {
      const current = await nestSettings()
      await saveNestSettings({
        ...(typeof args.enabled === 'boolean' ? { enabled: args.enabled } : {}),
        ...(args.summaries && typeof args.summaries === 'object' ? { summaries: { ...current.summaries, ...args.summaries } } : {}),
        ...(Array.isArray(args.exclude) ? { exclude: args.exclude.map(String) } : {}),
        ...(typeof args.instructions === 'string' ? { instructions: args.instructions } : {})
      })
      const result = await syncNest(ctx.selfOrigin, { force: true })
      const agents = result.plan ? Object.keys(result.plan.agents) : []
      return result.settings.enabled
        ? `MCP subagents on: ${agents.join(', ')}. They apply after the automatic reload (once no session is busy).`
        : 'MCP subagents off; their agents are disabled after the next reload.'
    }
  },

  // ---- schedules ----
  {
    name: 'list_schedules',
    description: 'List scheduled prompts (cron jobs that send a prompt to a project), with their next run and recent results.',
    inputSchema: obj({ directory: dirProp }),
    annotations: read,
    run: async (args) => (await listSchedules(args.directory)).map((s) => ({
      id: s.id,
      name: s.name,
      directory: s.directory,
      cron: s.cron,
      cadence: describeCron(s.cron),
      enabled: s.enabled,
      session: s.session,
      model: s.model,
      nextRun: s.nextRunAt ? new Date(s.nextRunAt).toString() : null,
      prompt: s.prompt.length > 300 ? `${s.prompt.slice(0, 300)}…` : s.prompt,
      lastRuns: s.runs.slice(0, 3)
    }))
  },
  {
    name: 'create_schedule',
    description: 'Schedule a prompt: at every cron match (server local time) the prompt is sent to the project in a new session, or always the same one with session="reuse". Cron has 5 fields (minute hour day month weekday) or @hourly/@daily/@weekly; e.g. "0 8 * * 1-5" = weekdays at 08:00.',
    inputSchema: obj({
      directory: dirProp,
      name: { type: 'string' },
      prompt: { type: 'string' },
      cron: { type: 'string' },
      session: { type: 'string', enum: ['new', 'reuse'] },
      model: { type: 'string', description: '"provider/model"' },
      agent: { type: 'string' },
      enabled: { type: 'boolean' }
    }, ['directory', 'name', 'prompt', 'cron']),
    run: async (args) => {
      const s = await createSchedule(args)
      return { id: s.id, cadence: describeCron(s.cron), nextRun: s.nextRunAt ? new Date(s.nextRunAt).toString() : null }
    }
  },
  {
    name: 'update_schedule',
    description: 'Change a scheduled prompt (any of name, prompt, cron, session, model, agent, enabled).',
    inputSchema: obj({
      id: { type: 'string' },
      name: { type: 'string' },
      prompt: { type: 'string' },
      cron: { type: 'string' },
      session: { type: 'string', enum: ['new', 'reuse'] },
      model: { type: 'string' },
      agent: { type: 'string' },
      enabled: { type: 'boolean' }
    }, ['id']),
    run: async ({ id, ...rest }) => {
      const s = await updateSchedule(String(id), rest)
      return { id: s.id, enabled: s.enabled, cadence: describeCron(s.cron), nextRun: s.nextRunAt ? new Date(s.nextRunAt).toString() : null }
    }
  },
  {
    name: 'delete_schedule',
    description: 'Delete a scheduled prompt.',
    inputSchema: obj({ id: { type: 'string' } }, ['id']),
    annotations: { destructiveHint: true },
    run: async (args) => {
      await deleteSchedule(String(args.id))
      return `schedule ${args.id} deleted`
    }
  },
  {
    name: 'run_schedule',
    description: 'Run a scheduled prompt right now; returns the session it was sent to.',
    inputSchema: obj({ id: { type: 'string' } }, ['id']),
    run: (args) => runSchedule(String(args.id), 'manual')
  }
]

export function controlToolList() {
  return CONTROL_TOOLS.map(({ run: _run, ...tool }) => tool)
}

export async function callControlTool(name: string, args: Args, ctx: { selfOrigin?: string }) {
  const tool = CONTROL_TOOLS.find((t) => t.name === name)
  if (!tool) throw createError({ statusCode: 400, message: `Unknown tool: ${name}` })
  return tool.run(args || {}, ctx)
}
