export default defineEventHandler(async (event) => {
  requireApiToken(event)
  const { directory } = getQuery(event) as { directory?: string }
  return redactProviderKeys(await opencodeFetch('/config/providers', { query: { directory } }))
})
