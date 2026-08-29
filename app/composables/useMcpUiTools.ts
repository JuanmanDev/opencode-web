// MCP tool ids known to render a UI (MCP Apps: the tool declares a ui://
// template in `_meta.ui`). Filled by tool discovery wherever it runs, read by
// ToolPart to decide whether re-running a tool to recover its app is worth it.
export function useMcpUiTools() {
  const ids = useState<Record<string, true>>('mcp-ui-tools', () => ({}))

  /** Merge discovery results: `{ server: { tools: [{ name, ui? }] } }`. */
  function learn(discovered: Record<string, { tools?: Array<{ name: string; ui?: boolean }> }>) {
    const next = { ...ids.value }
    let changed = false
    for (const [server, info] of Object.entries(discovered || {})) {
      for (const tool of info?.tools || []) {
        if (tool.ui && !next[`${server}_${tool.name}`]) {
          next[`${server}_${tool.name}`] = true
          changed = true
        }
      }
    }
    if (changed) ids.value = next
  }

  const has = (toolId: string) => Boolean(ids.value[toolId])
  return { ids, learn, has }
}
