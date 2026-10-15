// Register (or remove) the library's catalog URL in opencode's global config.
export default defineEventHandler(async (event) => {
  requireApiToken(event)
  const body = await readBody<{ enabled?: boolean }>(event).catch(() => ({} as { enabled?: boolean }))
  return registerCatalog(event, body?.enabled !== false)
})
