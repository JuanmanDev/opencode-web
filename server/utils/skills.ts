// Skills: what opencode loads (built-in, global, project, .claude/.agents
// compat folders), plus a **skill library** kept by this app. opencode and
// the web app usually run in different containers, so the library is not
// written into opencode's folders: the app serves it as an HTTP skill catalog
// (`<self>/skills/r<rev>/index.json`, files at `<base>/<name>/<file>`) and
// registers that URL in the global config (`skills.urls` on 1.x, the
// `skills` array on 2.x). opencode downloads the files once per URL and
// version, so every change bumps the revision in the URL and the skill's
// version; a reload then loads the new copy. Same-name library skills win
// over the others (remote sources are read last).
//
// Permissions (`permission.skill`: allow / ask / deny per name or pattern)
// and per-agent access (`tools.skill`) are plain opencode config.

import { createHmac } from 'node:crypto'
import type { H3Event } from 'h3'

export interface LibrarySkill {
  name: string
  description: string
  /** relative path -> text; SKILL.md is the entry file */
  files: Record<string, string>
  version: number
  updatedAt: number
  /** where it was copied from, when it started as a copy */
  origin?: string
}

interface Library {
  rev: number
  skills: Record<string, LibrarySkill>
}

const KEY = 'skill-library.json'
export const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/

export async function readLibrary(): Promise<Library> {
  const stored = await useStorage('data').getItem<Library>(KEY).catch(() => null)
  return { rev: stored?.rev || 0, skills: { ...(stored?.skills || {}) } }
}

async function writeLibrary(library: Library) {
  await useStorage('data').setItem(KEY, library)
}

// ---- SKILL.md ----

export interface ParsedSkill {
  name?: string
  description?: string
  /** other frontmatter keys, as written */
  meta: Record<string, string>
  body: string
  hasFrontmatter: boolean
}

/** Minimal YAML frontmatter reader: top-level `key: value` lines (quotes and folded `>` / `|` blocks). */
export function parseSkillMd(text: string): ParsedSkill {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text || '')
  if (!match) return { meta: {}, body: text || '', hasFrontmatter: false }
  const meta: Record<string, string> = {}
  const lines = match[1]!.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]!)
    if (!kv) continue
    let value = kv[2]!.trim()
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const block: string[] = []
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1]!)) block.push(lines[++i]!.trim())
      value = block.join(value.startsWith('>') ? ' ' : '\n')
    }
    meta[kv[1]!] = value.replace(/^(['"])([\s\S]*)\1$/, '$2')
  }
  const { name, description, ...rest } = meta
  return { name, description, meta: rest, body: match[2] || '', hasFrontmatter: true }
}

function yamlValue(value: string) {
  return /^[\w .,()/-]*$/.test(value) && !/^\s|\s$/.test(value) ? value : JSON.stringify(value)
}

export function buildSkillMd(name: string, description: string, body: string, meta: Record<string, string> = {}) {
  const extra = Object.entries(meta).filter(([k, v]) => k && v).map(([k, v]) => `${k}: ${yamlValue(v)}`)
  return ['---', `name: ${name}`, `description: ${yamlValue(description.replace(/\s+/g, ' ').trim())}`, ...extra, '---', '', body.trim(), ''].join('\n')
}

export interface SkillCheck { level: 'error' | 'warning' | 'tip'; message: string }

/** opencode's own rules for skills, plus advice that makes them trigger well. */
export function lintSkill(content: string, folderName?: string): SkillCheck[] {
  const out: SkillCheck[] = []
  const parsed = parseSkillMd(content)
  if (!parsed.hasFrontmatter) out.push({ level: 'error', message: 'No frontmatter: start with --- / name / description / ---.' })
  if (!parsed.name) out.push({ level: 'error', message: 'name is required.' })
  else {
    if (!SKILL_NAME.test(parsed.name) || parsed.name.length > 64) out.push({ level: 'error', message: 'name: lowercase letters, digits and single hyphens, up to 64 characters.' })
    if (folderName && parsed.name !== folderName) out.push({ level: 'error', message: `name "${parsed.name}" must match its folder "${folderName}".` })
  }
  const description = parsed.description || ''
  if (!description) out.push({ level: 'error', message: 'description is missing: opencode never shows the skill to the model without one.' })
  else {
    if (description.length < 40) out.push({ level: 'warning', message: 'description is very short: say what the skill does AND when to use it.' })
    if (description.length > 1024) out.push({ level: 'warning', message: 'description is over 1024 characters: it is in every prompt, keep it tight.' })
    if (/^(I |I'm|We )/i.test(description)) out.push({ level: 'tip', message: 'Write the description in third person ("Use when…", not "I help with…").' })
    if (!/\b(use|when|whenever|trigger)\b/i.test(description)) out.push({ level: 'tip', message: 'Say when to use it ("Use when the user asks for…") so the model picks it at the right time.' })
  }
  const words = parsed.body.split(/\s+/).filter(Boolean).length
  if (words < 30) out.push({ level: 'warning', message: 'The body is almost empty: add the instructions, steps and examples the model should follow.' })
  if (words > 5000) out.push({ level: 'tip', message: `The body has ${words} words: move details into extra files the skill references, so loading it stays cheap.` })
  if (!/^#{1,3} /m.test(parsed.body) && words > 150) out.push({ level: 'tip', message: 'Use headings to structure longer instructions.' })
  return out
}

// ---- the catalog opencode downloads ----

function catalogSecret() {
  const token = String(useRuntimeConfig().apiToken || '')
  // with an API token, the catalog URL carries a derived secret instead
  return token ? createHmac('sha256', token).update('opencode-web-skills-v1').digest('base64url').slice(0, 32) : ''
}

/** `/skills/[k<secret>/]r<rev>/` -> rev, or undefined when the path is not ours. */
export function parseCatalogPath(segments: string[]) {
  const secret = catalogSecret()
  let rest = segments
  if (secret) {
    if (rest[0] !== `k${secret}`) return undefined
    rest = rest.slice(1)
  }
  const rev = /^r(\d+)$/.exec(rest[0] || '')
  return rev ? { rev: Number(rev[1]), rest: rest.slice(1) } : undefined
}

export function catalogUrl(base: string, rev: number) {
  const secret = catalogSecret()
  return `${base.replace(/\/+$/, '')}/skills/${secret ? `k${secret}/` : ''}r${rev}/`
}

export function catalogIndex(library: Library) {
  return {
    skills: Object.values(library.skills)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => ({ name: s.name, description: s.description, version: String(s.version), files: Object.keys(s.files) }))
  }
}

const isOurCatalog = (url: unknown) => typeof url === 'string' && /\/skills\/(k[\w-]+\/)?r\d+\/?$/.test(url)

/** The catalog URLs currently in the global config (1.x object or 2.x array form). */
async function configuredSkillSources() {
  const global = await opencodeFetch<{ skills?: unknown }>('/global/config', { timeoutMs: 20_000 })
  const skills = global?.skills
  const dialect2 = ((await getServerProfile()) as { dialect?: string }).dialect === '2'
  const urls = Array.isArray(skills)
    ? skills.filter((s): s is string => typeof s === 'string')
    : Array.isArray((skills as { urls?: unknown })?.urls) ? ((skills as { urls: unknown[] }).urls.filter((s): s is string => typeof s === 'string')) : []
  return { urls, dialect2, raw: skills }
}

export async function catalogState(event?: H3Event) {
  const library = await readLibrary()
  const base = selfBaseUrl(event)
  let registered: string | undefined
  let supported = true
  try {
    registered = (await configuredSkillSources()).urls.find(isOurCatalog)
  } catch {
    supported = false
  }
  const current = base ? catalogUrl(base, library.rev) : undefined
  return {
    rev: library.rev,
    count: Object.keys(library.skills).length,
    url: current || null,
    registered: registered || null,
    upToDate: Boolean(registered && current && registered === current),
    supported
  }
}

/**
 * Point opencode at the current catalog revision (or remove it). Other skill
 * sources in the config are kept. Applies after a reload.
 */
export async function registerCatalog(event: H3Event | undefined, enabled = true) {
  const base = selfBaseUrl(event)
  if (enabled && !base) throw createError({ statusCode: 400, message: 'Set NUXT_SELF_URL: the URL at which opencode reaches this app' })
  if (!(await getCapabilities()).config) throw createError({ statusCode: 501, message: 'This opencode server has no config API' })
  const library = await readLibrary()
  const { urls, dialect2, raw } = await configuredSkillSources()
  const others = urls.filter((u) => !isOurCatalog(u))
  const next = enabled ? [...others, catalogUrl(base!, library.rev)] : others
  // 2.x: one `skills` array of folders and URLs; 1.x: `skills: { paths, urls }`
  const kept = Array.isArray(raw) ? raw.filter((s) => !isOurCatalog(s)) : []
  const body = dialect2
    ? { skills: enabled ? [...kept, catalogUrl(base!, library.rev)] : kept }
    : { skills: { ...(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}), urls: next } }
  try {
    await opencodeFetch('/global/config', { method: 'PATCH', body, timeoutMs: 30_000 })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw createError({ statusCode: 502, message: `This opencode version did not accept a skill catalog (${message}). Skill URLs need opencode 1.14 or later.` })
  }
  return catalogState(event)
}

// ---- library changes ----

export async function saveLibrarySkill(event: H3Event | undefined, input: { name: string; content: string; files?: Record<string, string>; origin?: string }) {
  const name = String(input.name || '').trim()
  if (!SKILL_NAME.test(name) || name.length > 64) {
    throw createError({ statusCode: 400, message: 'name: lowercase letters, digits and single hyphens, up to 64 characters' })
  }
  const parsed = parseSkillMd(input.content || '')
  // the folder name is the skill's name: keep the frontmatter in step
  const content = parsed.hasFrontmatter && parsed.name === name
    ? input.content
    : buildSkillMd(name, parsed.description || '', parsed.body, parsed.meta)
  const errors = lintSkill(content, name).filter((c) => c.level === 'error')
  if (errors.length) throw createError({ statusCode: 400, message: errors.map((e) => e.message).join(' ') })
  const extra = Object.fromEntries(Object.entries(input.files || {})
    .filter(([path, text]) => path !== 'SKILL.md' && typeof text === 'string' && /^[\w.-]+(\/[\w.-]+)*$/.test(path) && !path.split('/').includes('..')))
  const library = await readLibrary()
  const previous = library.skills[name]
  library.rev++
  library.skills[name] = {
    name,
    description: parseSkillMd(content).description || '',
    files: { 'SKILL.md': content, ...(input.files ? extra : Object.fromEntries(Object.entries(previous?.files || {}).filter(([p]) => p !== 'SKILL.md'))) },
    version: (previous?.version || 0) + 1,
    updatedAt: Date.now(),
    origin: input.origin ?? previous?.origin
  }
  await writeLibrary(library)
  const catalog = await registerCatalog(event, true).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }))
  return { skill: library.skills[name], catalog }
}

export async function deleteLibrarySkill(event: H3Event | undefined, name: string) {
  const library = await readLibrary()
  if (!library.skills[name]) throw createError({ statusCode: 404, message: `No library skill named ${name}` })
  delete library.skills[name]
  library.rev++
  await writeLibrary(library)
  const empty = !Object.keys(library.skills).length
  const catalog = await registerCatalog(event, !empty).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }))
  return { deleted: name, catalog }
}

// ---- what opencode sees ----

export type SkillSource = 'built-in' | 'library' | 'project' | 'global' | 'remote'

export interface SkillView {
  name: string
  description?: string
  location?: string
  source: SkillSource
  content?: string
  /** permission.skill rule that applies (exact name or matching pattern) */
  permission: 'allow' | 'ask' | 'deny'
  permissionRule?: string
  library?: { version: number; updatedAt: number; loaded: boolean; origin?: string }
  checks: SkillCheck[]
}

function sourceOf(location: string | undefined, home?: string): SkillSource {
  if (!location || location === '<built-in>') return 'built-in'
  const l = location.replace(/\\/g, '/')
  // downloaded from a skill URL (this app's library is told apart by name)
  if (/\/\.cache\/opencode\/skills\//.test(l)) return 'remote'
  if ((home && l.startsWith(home.replace(/\\/g, '/'))) || /\/\.config\/opencode\//.test(l)) return 'global'
  return 'project'
}

const wildcard = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)

/** opencode's rule: the most specific (longest) matching pattern wins; default allow. */
export function skillPermission(rules: unknown, name: string): { mode: 'allow' | 'ask' | 'deny'; rule?: string } {
  if (typeof rules === 'string' && ['allow', 'ask', 'deny'].includes(rules)) return { mode: rules as 'allow', rule: '*' }
  if (!rules || typeof rules !== 'object') return { mode: 'allow' }
  const hits = Object.entries(rules as Record<string, unknown>)
    .filter(([pattern, mode]) => typeof mode === 'string' && wildcard(pattern).test(name))
    .sort((a, b) => b[0].replace(/\*/g, '').length - a[0].replace(/\*/g, '').length)
  return hits.length ? { mode: hits[0]![1] as 'allow', rule: hits[0]![0] } : { mode: 'allow' }
}

export async function listSkillViews(directory?: string): Promise<{ skills: SkillView[]; library: Library; permissions: unknown; available: boolean }> {
  const query = { directory: directory || undefined }
  const [loaded, config, library, paths] = await Promise.all([
    opencodeFetch<Array<{ name: string; description?: string; location?: string; content?: string }>>('/skill', { query, timeoutMs: 20_000 }).then((r) => ({ ok: true, list: Array.isArray(r) ? r : [] })).catch(() => ({ ok: false, list: [] as Array<{ name: string; description?: string; location?: string; content?: string }> })),
    opencodeFetch<{ permission?: Record<string, unknown> }>('/config', { query, timeoutMs: 20_000 }).catch(() => ({} as { permission?: Record<string, unknown> })),
    readLibrary(),
    opencodeFetch<{ home?: string }>('/path', { query, timeoutMs: 10_000 }).catch(() => ({} as { home?: string }))
  ])
  const permissions = (config.permission as Record<string, unknown> | undefined)?.skill
  const views: SkillView[] = []
  for (const s of loaded.list) {
    if (!s?.name) continue
    const source = sourceOf(s.location, paths.home)
    const own = library.skills[s.name]
    let content = typeof s.content === 'string' ? s.content : undefined
    // older servers return no content: project skills can be read through the file API
    if (content === undefined && source === 'project' && s.location && directory) {
      const relative = s.location.replace(/\\/g, '/').replace(`${directory.replace(/\\/g, '/').replace(/\/+$/, '')}/`, '')
      content = await opencodeFetch<{ content?: string }>('/file/content', { query: { directory, path: relative }, timeoutMs: 10_000 })
        .then((r) => (typeof r?.content === 'string' ? r.content : undefined)).catch(() => undefined)
    }
    // the body opencode returns lacks the frontmatter: show it whole again
    if (content !== undefined && !/^---\r?\n/.test(content)) content = buildSkillMd(s.name, s.description || '', content)
    const perm = skillPermission(permissions, s.name)
    views.push({
      name: s.name,
      description: s.description,
      location: s.location,
      source: own && source === 'remote' ? 'library' : source,
      content,
      permission: perm.mode,
      permissionRule: perm.rule,
      ...(own ? { library: { version: own.version, updatedAt: own.updatedAt, loaded: true, origin: own.origin } } : {}),
      checks: content ? lintSkill(content, s.name) : []
    })
  }
  // library skills opencode has not loaded yet (saved, waiting for a reload)
  for (const own of Object.values(library.skills)) {
    if (views.some((v) => v.name === own.name)) continue
    const perm = skillPermission(permissions, own.name)
    views.push({
      name: own.name,
      description: own.description,
      source: 'library',
      content: own.files['SKILL.md'],
      permission: perm.mode,
      permissionRule: perm.rule,
      library: { version: own.version, updatedAt: own.updatedAt, loaded: false, origin: own.origin },
      checks: lintSkill(own.files['SKILL.md'] || '', own.name)
    })
  }
  // a library copy shows the library's current text (opencode may hold an older one)
  for (const view of views) {
    const own = library.skills[view.name]
    if (own) {
      view.content = own.files['SKILL.md']
      view.checks = lintSkill(view.content || '', view.name)
    }
  }
  views.sort((a, b) => a.name.localeCompare(b.name))
  return { skills: views, library, permissions, available: loaded.ok }
}

// ---- writing and improving with a model ----

const SKILL_GUIDE = [
  'You write opencode skills: a SKILL.md with YAML frontmatter and a markdown body the agent loads on demand.',
  'Rules: frontmatter has `name` (lowercase-hyphen, max 64 chars) and `description`.',
  'The description is always visible to the model, the body only when loaded: the description says WHAT the skill does AND WHEN to use it,',
  'in third person ("Use when…"), front-loading the keywords and file names a user would say; add "Use ONLY when…" if it must stay quiet on nearby topics.',
  'The body gives concrete, ordered instructions, conventions, commands and short examples; no filler, no marketing.',
  'Reply with the complete SKILL.md only, starting with ---, no code fences around it, no commentary.'
].join('\n')

function stripFences(text: string) {
  return text.trim().replace(/^```(?:markdown|md)?\s*\n/i, '').replace(/\n```\s*$/, '').trim() + '\n'
}

export async function aiSkill(opts: { mode: 'improve' | 'create'; name?: string; content?: string; brief?: string; model?: string; directory?: string }) {
  const prompt = opts.mode === 'improve'
    ? [
        `Improve this skill${opts.name ? ` (${opts.name})` : ''}. Keep its name, purpose and every concrete fact; fix the frontmatter, sharpen the description so it triggers at the right time, and make the instructions clearer and better structured.`,
        opts.brief ? `What the user wants changed: ${opts.brief}` : '',
        '',
        opts.content || ''
      ].join('\n')
    : [
        `Write a new skill${opts.name ? ` named "${opts.name}"` : ''}.`,
        `What it is for: ${opts.brief || '(not given)'}`
      ].join('\n')
  return stripFences(await aiText({ model: opts.model, directory: opts.directory, system: SKILL_GUIDE, prompt }))
}
