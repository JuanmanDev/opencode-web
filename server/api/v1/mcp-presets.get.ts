export default defineEventHandler(async (event) => {
  requireApiToken(event)
  const { key } = getQuery(event) as { key?: string }
  if (!key) return []
  const safe = encodeURIComponent(key).slice(0, 150)
  return (await useStorage('data').getItem(`mcp-presets/${safe}.json`)) || []
})
