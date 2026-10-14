// "MCP subagents": one opencode subagent per MCP server, plus an orchestrator
// agent that keeps its context free of MCP tools and knows what to delegate
// to each specialist. Everything is plain opencode config (`agent` map in the
// global config), regenerated whenever the MCP servers change.
//
//   mcp-<server>   mode subagent, tools { "*": false, "<server>_*": true },
//                  description = when to use it (what the orchestrator reads)
//   orchestrator   mode primary, tools { "<server>_*": false, … }, prompt
//                  with the summary of every specialist
//
// opencode 2.x hides MCP tools behind its `execute` code tool unless the
// server sets `codemode: false`; nested servers get it so the per-agent
// tool filter can reach them. Settings live in the web app's data volume.

import { createHash } from 'node:crypto'
import type { McpServerConfig } from './mcp-admin'

export interface NestSettings {
  enabled: boolean
  /** primary agent name */
  orchestrator: string
  /** servers left out of the nest */
  exclude: string[]
  /** hand-written summaries, by server name */
  summaries: Record<string, string>
  /** extra instructions for the orchestrator */
  instructions?: string
  lastSync?: { at: number; hash: string; agents: string[]; error?: string }
}

export interface NestServerPlan {
  server: string
  agent: string
  /** what the orchestrator reads: hand-written or generated */
  summary: string
  generated: string
  custom: boolean
  tools: Array<{ name: string; description?: string }>
  status: string
  included: boolean
  /** why it is not nested (excluded, disabled, no tools…) */
  skipped?: string
}

export interface NestPlan {
  settings: NestSettings
  servers: NestServerPlan[]
  orchestratorPrompt: string
  /** the `agent` map that would be written */
  agents: Record<string, Record<string, unknown>>
  hash: string
  /** opencode 2.x: nested servers need codemode off */
  codemodeOff: string[]
}

const KEY = 'mcp-nest.json'
const DEFAULTS: NestSettings = { enabled: false, orchestrator: 'orchestrator', exclude: [], summaries: {} }

/** Tool-id prefix opencode gives a server (same rule on 1.x and 2.x). */
export function toolNamespace(server: string) {
  return server.replace(/[^a-zA-Z0-9_-]/g, '_')
}

export function agentName(server: string) {
  return `mcp-${toolNamespace(server).toLowerCase()}`
}

export async function nestSettings(): Promise<NestSettings> {
  const stored = await useStorage('data').getItem<Partial<NestSettings>>(KEY).catch(() => null)
  return { ...DEFAULTS, ...(stored || {}), summaries: { ...(stored?.summaries || {}) }, exclude: [...(stored?.exclude || [])] }
}

export async function saveNestSettings(patch: Partial<NestSettings>) {
  const next = { ...(await nestSettings()), ...patch }
  if (!/^[a-z0-9][\w-]{0,40}$/i.test(next.orchestrator)) {
    throw createError({ statusCode: 400, message: 'orchestrator: letters, digits, "-" and "_" only' })
  }
  next.summaries = Object.fromEntries(Object.entries(next.summaries || {})
    .filter(([, text]) => typeof text === 'string' && text.trim())
    .map(([name, text]) => [name, text.trim().slice(0, 1200)]))
  await useStorage('data').setItem(KEY, next)
  return next
}

/** A summary from the tool list: what the server is for, then its tools. */
export function generatedSummary(server: string, tools: Array<{ name: string; description?: string }>) {
  if (!tools.length) return `Specialist for the ${server} MCP server.`
  const described = tools.filter((t) => t.description).slice(0, 6)
    .map((t) => `${t.name} (${t.description!.replace(/\s+/g, ' ').replace(/[.:;]+$/, '').slice(0, 70)})`)
  const listed = described.length ? described : tools.slice(0, 10).map((t) => t.name)
  const rest = tools.length - listed.length
  return `Specialist for the ${server} MCP server: send it any task that needs ${server}. `
    + `Tools: ${listed.join(described.length ? '; ' : ', ')}`
    + `${rest > 0 ? `; and ${rest} more` : ''}.`
}

function orchestratorPrompt(settings: NestSettings, servers: NestServerPlan[]) {
  const nested = servers.filter((s) => s.included)
  const lines = nested.map((s) => `- @${s.agent} (the ${s.server} MCP server): ${s.summary}`)
  return [
    'You are the orchestrator. You do not call MCP tools yourself: every MCP server has its own specialist subagent, and you delegate to it.',
    '',
    'Specialists and what to send them:',
    ...(lines.length ? lines : ['- (no MCP servers are nested yet)']),
    '',
    'How to work:',
    '- Split the request into steps; send each MCP step to the right specialist with the subagent/task tool.',
    '- Give each specialist a self-contained instruction: the goal, the exact data it needs (ids, names, values) and what to report back. Specialists do not see this conversation.',
    '- Run independent steps in parallel when you can; chain dependent ones and pass results along.',
    '- Do code and file work yourself with your own tools.',
    '- Finish with a short answer that combines the specialists\' results.',
    ...(settings.instructions?.trim() ? ['', settings.instructions.trim()] : [])
  ].join('\n')
}

function specialistPrompt(server: string, tools: Array<{ name: string }>) {
  return [
    `You are the specialist for the ${server} MCP server. You only have its tools${tools.length ? ` (${tools.map((t) => t.name).slice(0, 30).join(', ')})` : ''}.`,
    'Do exactly the task you receive with those tools, then report back concisely: what you did, the results the orchestrator asked for (ids, values, links), and anything that failed and why.',
    'If the task needs something your tools cannot do, say so instead of guessing.'
  ].join('\n')
}

/** What the nest would look like now (never writes). */
export async function planNest(selfOrigin?: string, settingsOverride?: NestSettings): Promise<NestPlan> {
  const settings = settingsOverride || await nestSettings()
  const [config, status, discovered, profile] = await Promise.all([
    rawMcpConfig('global').catch(() => ({} as Record<string, McpServerConfig>)),
    opencodeFetch<Record<string, { status?: string }>>('/mcp', { timeoutMs: 120_000 }).catch(() => ({} as Record<string, { status?: string }>)),
    getAllTools(undefined, 'global', selfOrigin || '', false).catch(() => ({} as Awaited<ReturnType<typeof getAllTools>>)),
    getServerProfile()
  ])
  const servers: NestServerPlan[] = Object.keys(config).sort().map((server) => {
    const entry = config[server]!
    const tools = (discovered[server]?.tools || []).map((t) => ({ name: t.name, description: t.description }))
    const generated = generatedSummary(server, tools)
    const custom = Boolean(settings.summaries[server])
    const state = status[server]?.status || (entry.enabled === false ? 'disabled' : 'unknown')
    const skipped = server === CONTROL_MCP_NAME
      ? 'this app\'s own control server stays with the main agents'
      : settings.exclude.includes(server)
        ? 'left out'
        : entry.enabled === false
          ? 'disabled'
          : undefined
    return {
      server,
      agent: agentName(server),
      summary: settings.summaries[server] || generated,
      generated,
      custom,
      tools,
      status: state,
      included: !skipped,
      ...(skipped ? { skipped } : {})
    }
  })

  const nested = servers.filter((s) => s.included)
  const agents: Record<string, Record<string, unknown>> = {}
  for (const s of nested) {
    agents[s.agent] = {
      mode: 'subagent',
      description: s.summary,
      prompt: specialistPrompt(s.server, s.tools),
      tools: { '*': false, [`${toolNamespace(s.server)}_*`]: true },
      disable: false
    }
  }
  const prompt = orchestratorPrompt(settings, servers)
  agents[settings.orchestrator] = {
    mode: 'primary',
    description: `Delegates MCP work to one subagent per server (${nested.length} specialist${nested.length === 1 ? '' : 's'})`,
    prompt,
    tools: Object.fromEntries(nested.map((s) => [`${toolNamespace(s.server)}_*`, false])),
    disable: false
  }
  const codemodeOff = (profile as { dialect?: string }).dialect === '2'
    ? nested.filter((s) => config[s.server]?.codemode !== false).map((s) => s.server)
    : []
  // the one-time codemode switch is not part of it: it must not re-trigger syncs
  const hash = createHash('sha1').update(JSON.stringify(agents)).digest('hex')
  return { settings, servers, orchestratorPrompt: prompt, agents, hash, codemodeOff }
}

/**
 * Write the nest into the global opencode config and reload opencode once
 * no session is busy. Agents of servers that left the nest (or the whole
 * nest, when disabled) are switched off with `disable: true`: the config
 * API cannot delete keys.
 */
export async function syncNest(selfOrigin?: string, opts: { force?: boolean } = {}) {
  const settings = await nestSettings()
  const previous = settings.lastSync?.agents || []
  let agents: Record<string, Record<string, unknown>> = {}
  let plan: NestPlan | undefined
  let codemodeOff: string[] = []
  if (settings.enabled) {
    plan = await planNest(selfOrigin, settings)
    if (!opts.force && plan.hash === settings.lastSync?.hash && !settings.lastSync?.error) {
      return { changed: false, plan, settings }
    }
    agents = plan.agents
    codemodeOff = plan.codemodeOff
  }
  for (const name of previous) {
    if (!agents[name]) agents[name] = { disable: true }
  }
  if (!Object.keys(agents).length) return { changed: false, plan, settings }

  try {
    if (!(await getCapabilities()).config) throw new Error('this opencode server has no config API')
    await opencodeFetch('/global/config', {
      method: 'PATCH',
      body: {
        agent: agents,
        ...(codemodeOff.length ? { mcp: Object.fromEntries(codemodeOff.map((s) => [s, { codemode: false }])) } : {})
      },
      timeoutMs: 60_000
    })
    const written = Object.entries(agents).filter(([, a]) => !a.disable).map(([name]) => name)
    const lastSync = { at: Date.now(), hash: plan?.hash || '', agents: written }
    await saveNestSettings({ lastSync })
    await forgetMcpTools()
    // new agents and tool filters apply after a reload; never cut running replies
    await assertReloadable().then(() => requestReload({ scope: 'all', when: 'idle' })).catch(() => {})
    return { changed: true, plan, settings: { ...settings, lastSync } }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await saveNestSettings({ lastSync: { at: Date.now(), hash: '', agents: previous, error: message } })
    throw createError({ statusCode: 502, message: `Could not write the subagents: ${message}` })
  }
}

let checking: Promise<unknown> | undefined

/** Keep the nest in step with the MCP servers (called after MCP changes and periodically). */
export function autoSyncNest(selfOrigin?: string) {
  checking ??= nestSettings()
    .then((s) => (s.enabled ? syncNest(selfOrigin) : undefined))
    .catch((error) => console.warn(`[mcp-nest] ${error instanceof Error ? error.message : error}`))
    .finally(() => { checking = undefined })
  return checking
}
