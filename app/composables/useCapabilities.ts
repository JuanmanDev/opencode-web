// What the connected opencode server can do (GET /api/v1/capabilities).
// Every 1.x server supports everything; v2-only servers (opencode 2.x) have no
// MCP, config, fork, share, diff or shell yet, so those affordances hide.
export interface Capabilities {
  protocol: 'legacy' | 'v2'
  version?: string
  mcp: boolean
  config: boolean
  sessionRename: boolean
  sessionDelete: boolean
  fork: boolean
  share: boolean
  diff: boolean
  shell: boolean
  compact: boolean
  revert: boolean
  questions: boolean
  permissions: boolean
  todos: boolean
  cost: boolean
}

const ALL: Capabilities = {
  protocol: 'legacy',
  mcp: true,
  config: true,
  sessionRename: true,
  sessionDelete: true,
  fork: true,
  share: true,
  diff: true,
  shell: true,
  compact: true,
  revert: true,
  questions: true,
  permissions: true,
  todos: true,
  cost: true
}

export function useCapabilities() {
  const caps = useState<Capabilities>('oc-capabilities', () => ALL)
  const loaded = useState('oc-capabilities-loaded', () => false)
  if (import.meta.client && !loaded.value) {
    loaded.value = true
    $fetch<Capabilities>('/api/v1/capabilities', { timeout: 10000 })
      .then((c) => { caps.value = { ...ALL, ...c } })
      // unknown: keep everything visible, try again on the next page
      .catch(() => { loaded.value = false })
  }
  return caps
}
