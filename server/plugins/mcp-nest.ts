// Keeps the MCP subagents in step with the MCP servers: a server added,
// removed, switched off or whose tools changed regenerates the agents.
export default defineNitroPlugin((nitro) => {
  const flag = globalThis as { __ocwNest?: ReturnType<typeof setInterval> }
  if (flag.__ocwNest) clearInterval(flag.__ocwNest)
  flag.__ocwNest = setInterval(() => { autoSyncNest() }, 3 * 60_000)
  flag.__ocwNest.unref?.()
  nitro.hooks.hook('close', () => {
    clearInterval(flag.__ocwNest)
    flag.__ocwNest = undefined
  })
})
