// `@` mentions in the prompt box, the way opencode's own TUI and web app do
// it: `@` at the start of a word opens a picker with the project's files and
// folders (fuzzy search on the server) and the agents (subagents first).
// A picked file is sent as a file part (`file://` URL, opencode reads it into
// the context), a picked agent as an agent part (opencode hands the request
// to that subagent). The text keeps the `@name` the user saw.

export interface MentionToken {
  /** index of the `@` */
  start: number
  /** end of the token (exclusive): the caret, or the next whitespace */
  end: number
  /** what follows the `@` up to the caret */
  query: string
}

/** The `@token` the caret is in, if it starts a word. */
export function mentionAt(text: string, caret: number): MentionToken | null {
  if (caret < 1 || caret > text.length) return null
  let i = caret - 1
  while (i >= 0 && !/\s/.test(text[i]!)) {
    if (text[i] === '@') {
      // a word start only: `a@b` (e-mail) is not a mention
      if (i > 0 && !/\s/.test(text[i - 1]!)) return null
      const query = text.slice(i + 1, caret)
      if (query.includes('@')) return null
      let end = caret
      while (end < text.length && !/\s/.test(text[end]!)) end++
      return { start: i, end, query }
    }
    i--
  }
  return null
}

/** Replace the token with `@value ` and return the new text and caret. */
export function applyMention(text: string, token: MentionToken, value: string) {
  const insert = `@${value} `
  const next = text.slice(0, token.start) + insert + text.slice(token.end).replace(/^ /, '')
  return { text: next, caret: token.start + insert.length }
}

/** `file://` URL of `relative` inside `directory` (POSIX or Windows paths). */
export function toFileUrl(directory: string, relative: string) {
  const base = directory.replace(/\\/g, '/').replace(/\/+$/, '')
  const rel = relative.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
  const abs = rel ? `${base}/${rel}` : base
  const withSlash = abs.startsWith('/') ? abs : `/${abs}`
  return `file://${encodeURI(withSlash).replace(/[?#]/g, encodeURIComponent)}`
}

/** opencode reads text files and lists folders; folders get its directory mime. */
export function mentionMime(path: string) {
  return path.endsWith('/') ? 'application/x-directory' : 'text/plain'
}

export interface MentionItem {
  kind: 'agent' | 'file' | 'folder'
  /** inserted after the `@` */
  value: string
  label: string
  detail?: string
}

/** Agents for the picker: subagents first, then the rest, filtered by query. */
export function agentMatches(agents: Array<{ name: string; mode?: string; description?: string }>, query: string, limit = 5): MentionItem[] {
  const q = query.toLowerCase()
  return agents
    .filter((a) => a.name && (!q || a.name.toLowerCase().includes(q)))
    .sort((a, b) => {
      const sub = (x: { mode?: string }) => (x.mode === 'subagent' ? 0 : x.mode === 'all' ? 1 : 2)
      const prefix = (x: { name: string }) => (x.name.toLowerCase().startsWith(q) ? 0 : 1)
      return prefix(a) - prefix(b) || sub(a) - sub(b) || a.name.localeCompare(b.name)
    })
    // primary-only agents can't be handed work: they are not mentionable
    .filter((a) => a.mode !== 'primary')
    .slice(0, limit)
    .map((a) => ({ kind: 'agent' as const, value: a.name, label: a.name, detail: a.description }))
}

export interface PickedMention {
  kind: MentionItem['kind']
  value: string
}

/**
 * The parts opencode expects for the mentions still present in `text`
 * (removed ones are dropped): file/folder parts with their `@path` source
 * span, agent parts with theirs. Positions refer to `text` as sent.
 */
export function mentionParts(text: string, picked: PickedMention[], directory: string) {
  const parts: Array<Record<string, unknown>> = []
  const seen = new Set<string>()
  for (const m of picked) {
    const key = `${m.kind}:${m.value}`
    if (seen.has(key)) continue
    const token = `@${m.value}`
    let start = -1
    for (let from = 0; ; from = start + 1) {
      start = text.indexOf(token, from)
      if (start < 0) break
      const before = start === 0 ? ' ' : text[start - 1]!
      const after = text[start + token.length] ?? ' '
      if (/\s/.test(before) && /\s/.test(after)) break
    }
    if (start < 0) continue
    seen.add(key)
    const source = { value: token, start, end: start + token.length }
    if (m.kind === 'agent') {
      parts.push({ type: 'agent', name: m.value, source })
    } else {
      const path = m.value.replace(/\/+$/, '')
      parts.push({
        type: 'file',
        mime: mentionMime(m.value),
        filename: path.split('/').pop() || path,
        url: toFileUrl(directory, path),
        source: { type: 'file', path, text: source }
      })
    }
  }
  return parts
}

/** Server-side fuzzy file/folder search for the current `@` query, debounced. */
export function useMentionSearch(directory: MaybeRefOrGetter<string>) {
  const api = useOpencodeApi(directory)
  const files = ref<MentionItem[]>([])
  const loading = ref(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  let seq = 0

  function search(query: string | null, retry = true) {
    clearTimeout(timer)
    if (query === null) {
      files.value = []
      loading.value = false
      return
    }
    loading.value = true
    const id = ++seq
    timer = setTimeout(async () => {
      try {
        const paths = await api.findFiles(query)
        if (id !== seq) return
        // opencode 1.x builds its file index on the first search: an empty
        // answer right after start-up is worth one more try
        if (!paths.length && retry) {
          timer = setTimeout(() => { if (id === seq) search(query, false) }, 1200)
          return
        }
        files.value = paths.slice(0, 30).map((path) => {
          const folder = path.endsWith('/')
          const clean = path.replace(/\/+$/, '')
          return {
            kind: folder ? 'folder' as const : 'file' as const,
            value: folder ? `${clean}/` : clean,
            label: clean.split('/').pop() || clean,
            detail: clean
          }
        })
      } catch {
        if (id === seq) files.value = []
      } finally {
        if (id === seq) loading.value = false
      }
    }, 120)
  }

  onBeforeUnmount(() => clearTimeout(timer))
  return { files, loading, search }
}
