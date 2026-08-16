export default defineEventHandler(async (event) => {
  requireApiToken(event)
  const id = getRouterParam(event, 'id')!
  const { directory } = getQuery(event) as { directory?: string }
  return opencodeFetch(`/session/${id}`, { method: 'DELETE', query: { directory } })
})
