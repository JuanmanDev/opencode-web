export default defineEventHandler(async (event) => {
  requireApiToken(event)
  const { directory } = getQuery(event) as { directory?: string }
  return redactSecrets(await opencodeFetch('/config/providers', { query: { directory } }))
})
