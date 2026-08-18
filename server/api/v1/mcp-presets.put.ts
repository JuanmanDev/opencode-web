export default defineEventHandler(async (event) => {
  requireApiToken(event)
  const { key } = getQuery(event) as { key?: string }
  if (!key) throw createError({ statusCode: 400, message: 'key is required' })
  const body = await readBody<unknown[]>(event)
  if (!Array.isArray(body)) throw createError({ statusCode: 400, message: 'Expected an array' })
  const safe = encodeURIComponent(key).slice(0, 150)
  await useStorage('data').setItem(`mcp-presets/${safe}.json`, body)
  return { ok: true }
})
