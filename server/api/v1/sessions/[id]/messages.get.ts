export default defineEventHandler(async (event) => {
  requireApiToken(event)
  const id = getRouterParam(event, 'id')!
  const { directory, limit } = getQuery(event) as { directory?: string; limit?: string }
  return opencodeFetch(`/session/${id}/message`, { query: { directory, limit } })
})
