// Register this app's MCP server (/mcp) with opencode's global config, so the
// agent in any chat can manage opencode itself: MCP servers, reloads, other
// sessions, tasks and schedules. State-changing tools are set to "ask".
export default defineEventHandler(async (event) => {
  requireApiToken(event)
  const body = await readBody<{ url?: string; enabled?: boolean }>(event).catch(() => ({} as { url?: string; enabled?: boolean }))
  const url = String(body?.url || (await controlMcpState(event)).suggestedUrl || '').trim()
  if (!/^https?:\/\//.test(url)) {
    throw createError({ statusCode: 400, message: 'Set the URL at which opencode reaches this app (NUXT_SELF_URL), e.g. http://web:3000/mcp' })
  }
  const result = await saveMcpServer({
    name: CONTROL_MCP_NAME,
    scope: 'global',
    config: { ...await controlMcpConfig(url), enabled: body?.enabled !== false }
  })
  await opencodeFetch('/global/config', {
    method: 'PATCH',
    body: { permission: Object.fromEntries(CONTROL_ASK_TOOLS.map((tool) => [`${CONTROL_MCP_NAME}_${tool}`, 'ask'])) },
    timeoutMs: 30000
  }).catch(() => { /* older servers without per-tool permissions */ })
  await forgetMcpTools()
  return result
})
