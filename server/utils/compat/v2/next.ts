// opencode 2.x (`@opencode/cli`, v2-only) mapping helpers. 2.x speaks the same
// `/api/*` family as the 1.18/1.19 hybrids but changed several shapes: flat
// prompt bodies, `decision` on permission replies, questions as forms, a
// normalized config document (`mcp.servers`, `permissions` rules, `disabled`
// instead of `enabled`) and MCP/config/session routes the hybrids lack.
// Everything here is pure so it can be unit tested against recorded payloads.

/** Which `/api/*` dialect a v2 server speaks. */
export type V2Dialect = '1.18' | '2'

type Dict = Record<string, any>

function isObject(value: unknown): value is Dict {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function clean<T extends Dict>(value: T): T {
  for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key]
  return value
}

// ---- prompts ----

/** 1.18 `{prompt:{text, files, agents}, id, delivery, resume}` -> 2.x flat body. */
export function flatPromptBody(body: { prompt?: Dict; id?: string; delivery?: string; resume?: boolean }): Dict {
  const prompt = isObject(body.prompt) ? body.prompt : {}
  return clean({
    id: body.id,
    text: typeof prompt.text === 'string' ? prompt.text : '',
    files: Array.isArray(prompt.files) && prompt.files.length ? prompt.files : undefined,
    agents: Array.isArray(prompt.agents) && prompt.agents.length ? prompt.agents : undefined,
    delivery: body.delivery,
    resume: body.resume
  })
}

// ---- MCP ----

export interface LegacyMcp {
  type?: string
  url?: string
  headers?: Record<string, string>
  oauth?: false | Dict
  command?: string[]
  environment?: Record<string, string>
  cwd?: string
  enabled?: boolean
  timeout?: number
  /** 2.x only: false exposes the tools directly instead of through `execute` */
  codemode?: boolean
}

/** 2.x server entry (`mcp.servers.<name>`) -> legacy 1.x entry. */
export function mcpToLegacy(server: Dict): LegacyMcp {
  const timeout = isObject(server.timeout)
    ? server.timeout.execution ?? server.timeout.catalog ?? server.timeout.startup
    : typeof server.timeout === 'number' ? server.timeout : undefined
  const oauth = server.oauth === false
    ? false as const
    : isObject(server.oauth)
      ? clean({
          clientId: server.oauth.client_id,
          clientSecret: server.oauth.client_secret,
          scope: server.oauth.scope,
          callbackPort: server.oauth.callback_port,
          redirectUri: server.oauth.redirect_uri
        })
      : undefined
  if (server.type === 'local') {
    return clean({
      type: 'local',
      command: Array.isArray(server.command) ? server.command.map(String) : [],
      cwd: server.cwd,
      environment: isObject(server.environment) ? server.environment : undefined,
      enabled: server.disabled === true ? false : undefined,
      timeout,
      codemode: typeof server.codemode === 'boolean' ? server.codemode : undefined
    })
  }
  return clean({
    type: 'remote',
    url: server.url,
    headers: isObject(server.headers) ? server.headers : undefined,
    oauth,
    enabled: server.disabled === true ? false : undefined,
    timeout,
    codemode: typeof server.codemode === 'boolean' ? server.codemode : undefined
  })
}

/** Legacy 1.x entry -> 2.x server config (`PUT /api/experimental/mcp/:server`). */
export function mcpToNative(entry: LegacyMcp): Dict {
  const timeout = typeof entry.timeout === 'number' && entry.timeout > 0
    ? { catalog: Math.round(entry.timeout), execution: Math.round(entry.timeout) }
    : undefined
  const disabled = entry.enabled === undefined ? undefined : !entry.enabled
  if (entry.type === 'local' || (!entry.type && Array.isArray(entry.command))) {
    return clean({
      type: 'local',
      command: (entry.command || []).map(String),
      cwd: entry.cwd,
      environment: entry.environment && Object.keys(entry.environment).length ? entry.environment : undefined,
      disabled,
      timeout,
      codemode: entry.codemode
    })
  }
  const oauth = entry.oauth === false
    ? false as const
    : isObject(entry.oauth)
      ? clean({
          client_id: entry.oauth.clientId,
          client_secret: entry.oauth.clientSecret,
          scope: entry.oauth.scope,
          callback_port: entry.oauth.callbackPort,
          redirect_uri: entry.oauth.redirectUri
        })
      : undefined
  return clean({
    type: 'remote',
    url: String(entry.url || ''),
    headers: entry.headers && Object.keys(entry.headers).length ? entry.headers : undefined,
    oauth,
    disabled,
    timeout,
    codemode: entry.codemode
  })
}

/** `GET /api/mcp` data -> legacy `GET /mcp` map. */
export function mcpStatusToLegacy(list: unknown): Record<string, { status: string; error?: string }> {
  const out: Record<string, { status: string; error?: string }> = {}
  for (const item of Array.isArray(list) ? list : []) {
    if (!isObject(item) || typeof item.name !== 'string') continue
    const status = isObject(item.status) ? item.status : {}
    out[item.name] = clean({
      status: String(status.status || 'unknown'),
      error: typeof status.error === 'string' ? status.error : undefined
    })
  }
  return out
}

// ---- config ----

export interface ConfigEntry { type: 'document' | 'directory'; path?: string; info?: Dict }

const sep = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
const fold = (p: string) => /^[a-z]:\//i.test(p) ? p.toLowerCase() : p

/** Is `path` the directory `dir` or inside it? (case-insensitive drive paths) */
export function within(path: string | undefined, dir: string | undefined) {
  if (!path || !dir) return false
  const a = fold(sep(path))
  const b = fold(sep(dir))
  return a === b || a.startsWith(`${b}/`)
}

/**
 * Split `GET /api/config` entries (lowest priority first) into the global
 * ones and those of the project at `projectDir`.
 */
export function splitConfig(entries: unknown, projectDir?: string) {
  const list = (Array.isArray(entries) ? entries : []).filter(isObject) as ConfigEntry[]
  const project = list.filter((e) => within(e.path, projectDir))
  // 2.x also loads opencode.json from every folder above the project: those
  // belong to other projects or to the user, never to "global". They count
  // for the project's effective config but are never written to.
  const inherited = list.filter((e) => !within(e.path, projectDir) && isAncestorSource(e, projectDir))
  const global = list.filter((e) => !within(e.path, projectDir) && !isAncestorSource(e, projectDir))
  return { global, project, inherited }
}

/** Does this entry live in a folder above `projectDir` (an ancestor-walk source)? */
function isAncestorSource(entry: ConfigEntry, projectDir?: string) {
  if (!entry.path || !projectDir) return false
  const path = sep(entry.path)
  // documents and `.opencode`/`.claude`/`.agents` folders sit directly in the ancestor
  const parent = path.slice(0, path.lastIndexOf('/')) || path
  return parent !== '' && within(projectDir, parent)
}

/** Where a patch for this scope is written: its highest-priority JSON document, or a new opencode.json. */
export function configTarget(entries: ConfigEntry[], fallbackDir?: string): string | undefined {
  const docs = entries.filter((e) => e.type === 'document' && typeof e.path === 'string' && /\.jsonc?$/i.test(e.path))
  const last = docs[docs.length - 1]
  if (last?.path) return last.path
  // no document yet: the project folder itself, or the global config folder
  // (never ~/.claude or ~/.agents, which are listed as global folders too)
  const dir = fallbackDir
    ?? [...entries].reverse().find((e) => e.type === 'directory' && e.path && /[\\/]opencode[\\/]?$/i.test(e.path))?.path
  if (!dir) return undefined
  return `${dir.replace(/[\\/]+$/, '')}${dir.includes('\\') ? '\\' : '/'}opencode.json`
}

/** Deep merge of normalized documents: maps merge, permission rules accumulate. */
export function mergeInfos(infos: Dict[]): Dict {
  const merge = (a: unknown, b: unknown, key?: string): unknown => {
    if (key === 'permissions' && Array.isArray(a) && Array.isArray(b)) return [...a, ...b]
    if (isObject(a) && isObject(b)) {
      const out: Dict = { ...a }
      for (const [k, v] of Object.entries(b)) out[k] = k in out ? merge(out[k], v, k) : v
      return out
    }
    return b === undefined ? a : b
  }
  return infos.reduce<Dict>((acc, info) => merge(acc, info) as Dict, {})
}

function modelString(model: unknown) {
  if (typeof model === 'string') return model
  if (isObject(model) && model.providerID && (model.model || model.id)) return `${model.providerID}/${model.model ?? model.id}`
  return undefined
}

/**
 * Normalized 2.x config -> the legacy shape the UI reads: `model`, `mcp`
 * (name -> entry with `enabled`), `permission` (action -> effect for rules on
 * every resource) and `tools` (false for denied actions).
 */
export function configToLegacy(info: Dict): Dict {
  const out: Dict = {}
  for (const [key, value] of Object.entries(info)) {
    if (['model', 'small_model', 'mcp', 'permissions', 'providers', 'agents', 'commands', 'update'].includes(key)) continue
    out[key] = value
  }
  const model = modelString(info.model)
  if (model) out.model = model
  const small = modelString(info.small_model)
  if (small) out.small_model = small
  if (isObject(info.mcp)) {
    const servers = isObject(info.mcp.servers) ? info.mcp.servers : {}
    out.mcp = Object.fromEntries(Object.entries(servers).filter(([, s]) => isObject(s)).map(([name, s]) => [name, mcpToLegacy(s)]))
  }
  if (Array.isArray(info.permissions)) {
    const permission: Dict = {}
    const tools: Dict = {}
    for (const rule of info.permissions) {
      if (!isObject(rule) || typeof rule.action !== 'string') continue
      if (rule.resource === '*' || rule.resource === undefined) {
        permission[rule.action] = rule.effect
        if (rule.effect === 'deny') tools[rule.action] = false
        else delete tools[rule.action]
      } else {
        permission[rule.action] = { ...(isObject(permission[rule.action]) ? permission[rule.action] : {}), [rule.resource]: rule.effect }
      }
    }
    out.permission = permission
    if (Object.keys(tools).length) out.tools = tools
  }
  if (isObject(info.agents)) out.agent = info.agents
  if (isObject(info.commands)) out.command = info.commands
  if (isObject(info.providers)) {
    out.provider = Object.fromEntries(Object.entries(info.providers).filter(([, p]) => isObject(p)).map(([id, p]) => [id, clean({
      name: p.name,
      options: isObject(p.settings) ? p.settings : undefined,
      models: isObject(p.models) ? p.models : undefined
    })]))
  }
  if (info.update === 'disable') out.autoupdate = false
  return out
}

/** Comments and trailing commas out, so opencode.jsonc parses as JSON. */
export function parseJsonc(text: string): Dict {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    const next = text[i + 1]
    if (inString) {
      out += c
      if (c === '\\') { out += next ?? ''; i++ } else if (c === '"') inString = false
      continue
    }
    if (c === '"') { inString = true; out += c; continue }
    if (c === '/' && next === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue }
    if (c === '/' && next === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue }
    out += c
  }
  const parsed = JSON.parse(out.replace(/,(\s*[}\]])/g, '$1') || '{}')
  return isObject(parsed) ? parsed : {}
}

/**
 * Apply a legacy config PATCH to a raw document the way opencode 1.x merged
 * it: objects merge, everything else replaces. A partial MCP entry (e.g. only
 * `enabled`) for a server this document lacks gets the effective entry first,
 * because 2.x drops enabled-only legacy entries.
 */
export function applyLegacyPatch(doc: Dict, patch: Dict, effectiveMcp: Record<string, LegacyMcp> = {}): Dict {
  const merge = (a: unknown, b: unknown): unknown => {
    if (isObject(a) && isObject(b)) {
      const out: Dict = { ...a }
      for (const [k, v] of Object.entries(b)) out[k] = merge(out[k], v)
      return out
    }
    return b
  }
  const out = { ...doc }
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'mcp' && isObject(value)) {
      const mcp: Dict = isObject(out.mcp) ? { ...out.mcp } : {}
      // a native document keeps servers under `servers`
      const native = isObject(mcp.servers) && !('type' in mcp.servers)
      for (const [name, entry] of Object.entries(value)) {
        if (!isObject(entry)) continue
        if (native) {
          // a mixed document may still hold this server 1.x-style: move it
          const direct = name !== 'servers' && name !== 'timeout' && isObject(mcp[name]) ? mcp[name] as LegacyMcp : undefined
          if (direct) delete mcp[name]
          const current = isObject(mcp.servers[name]) ? mcpToLegacy(mcp.servers[name]) : direct ?? effectiveMcp[name]
          mcp.servers = { ...mcp.servers, [name]: mcpToNative(merge(current ?? {}, entry) as LegacyMcp) }
        } else {
          const current = isObject(mcp[name]) ? mcp[name] : (!entry.type ? effectiveMcp[name] : undefined)
          const merged = merge(current ?? {}, entry) as LegacyMcp
          if (typeof merged.codemode === 'boolean') {
            // 1.x-style entries lose 2.x-only keys (codemode) when opencode
            // normalizes them: such an entry is stored natively instead
            delete mcp[name]
            mcp.servers = { ...(isObject(mcp.servers) ? mcp.servers : {}), [name]: mcpToNative(merged) }
          } else {
            mcp[name] = merged
          }
        }
      }
      out.mcp = mcp
      continue
    }
    if (key === 'permission' && Array.isArray(out.permissions) && isObject(value)) {
      // native document: append rules (the last matching rule wins)
      const rules = Object.entries(value).filter(([, effect]) => typeof effect === 'string')
        .map(([action, effect]) => ({ action: action === 'bash' ? 'shell' : action, resource: '*', effect }))
      out.permissions = [...out.permissions.filter((r: Dict) => !rules.some((n) => n.action === r.action && r.resource === '*')), ...rules]
      continue
    }
    out[key] = merge(out[key], value)
  }
  return out
}

// ---- questions (forms in 2.x) ----

/** A question-tool form -> the legacy question request the UI renders. */
export function formToQuestion(form: Dict): Dict | undefined {
  if (!isObject(form) || form.metadata?.kind !== 'question' || !Array.isArray(form.fields)) return undefined
  const tool = isObject(form.metadata?.tool) ? form.metadata.tool : undefined
  return clean({
    id: form.id,
    sessionID: form.sessionID,
    questions: form.fields.map((field: Dict) => clean({
      question: field.description ?? field.title ?? '',
      header: field.title,
      multiple: field.type === 'multiselect' ? true : undefined,
      options: (Array.isArray(field.options) ? field.options : []).map((o: Dict) => clean({ label: o.label ?? o.value, description: o.description }))
    })),
    tool: tool ? { messageID: tool.messageID, callID: tool.id ?? tool.callID } : undefined
  })
}

/** Legacy `answers` (one string[] per question) -> 2.x form answer. */
export function answersToForm(form: Dict, answers: unknown[]): Dict {
  const answer: Dict = {}
  const fields = Array.isArray(form?.fields) ? form.fields : []
  fields.forEach((field: Dict, index: number) => {
    const raw = answers[index]
    const values = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).map(String).filter((v) => v.length)
    if (!values.length) return
    // option labels and values are the same for question forms; map labels anyway
    const options = Array.isArray(field.options) ? field.options : []
    const mapped = values.map((v) => options.find((o: Dict) => o.label === v)?.value ?? v)
    answer[field.key] = field.type === 'multiselect' ? mapped : mapped.join(', ')
  })
  return answer
}

// ---- permissions ----

/** 2.x names the tool call `id`; the legacy mapper reads `callID`. */
export function permissionTo118(req: Dict): Dict {
  if (!isObject(req?.source)) return req
  return { ...req, source: { ...req.source, callID: req.source.callID ?? req.source.id } }
}
