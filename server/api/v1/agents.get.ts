export default defineEventHandler(async (event) => {
  requireApiToken(event)
  const { directory } = getQuery(event) as { directory?: string }
  return opencodeFetch('/agent', { query: { directory } })
})
