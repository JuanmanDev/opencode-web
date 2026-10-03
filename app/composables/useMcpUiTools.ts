// What discovery learned about MCP tools, keyed by opencode's tool id
// (`sanitize(server)_sanitize(tool)`): which render a UI (MCP Apps: the tool
// declares a ui:// template in `_meta.ui`) and which are read-only. ToolPart
// reads it to decide how an app may be recovered without side effects.
interface ToolTraits { ui?: true; readOnly?: true }

const sanitize = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, '_')

export function useMcpUiTools() {
  const ids = useState<Record<string, ToolTraits>>('mcp-ui-tools', () => ({}))

  /** Merge discovery results: `{ server: { tools: [{ name, ui?, readOnly? }] } }`. */
  function learn(discovered: Record<string, { tools?: Array<{ name: string; ui?: boolean; readOnly?: boolean }> }>) {
    const next = { ...ids.value }
    let changed = false
    for (const [server, info] of Object.entries(discovered || {})) {
      for (const tool of info?.tools || []) {
        if (!tool.ui && !tool.readOnly) continue
        const id = `${sanitize(server)}_${sanitize(tool.name)}`
        const traits: ToolTraits = { ...(tool.ui ? { ui: true } : {}), ...(tool.readOnly ? { readOnly: true } : {}) }
        if (next[id]?.ui !== traits.ui || next[id]?.readOnly !== traits.readOnly) {
          next[id] = traits
          changed = true
        }
      }
    }
    if (changed) ids.value = next
  }

  const has = (toolId: string) => Boolean(ids.value[toolId]?.ui)
  const isReadOnly = (toolId: string) => Boolean(ids.value[toolId]?.readOnly)
  return { ids, learn, has, isReadOnly }
}
