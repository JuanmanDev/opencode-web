// Make opencode re-read its config: one project's instance or all of them.
// `when: "idle"` (default) waits until no session there is busy.
export default defineEventHandler(async (event) => {
  requireApiToken(event)
  await assertReloadable()
  const body = await readBody<{ scope?: 'project' | 'all'; directory?: string; when?: 'now' | 'idle' }>(event)
    .catch(() => ({} as { scope?: 'project' | 'all'; directory?: string; when?: 'now' | 'idle' }))
  return requestReload({
    scope: body?.scope === 'all' ? 'all' : 'project',
    directory: body?.directory,
    when: body?.when === 'now' ? 'now' : 'idle'
  })
})
