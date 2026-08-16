export default defineEventHandler(async (event) => {
  requireApiToken(event)
  const id = getRouterParam(event, 'id')!
  const { directory } = getQuery(event) as { directory?: string }
  return opencodeFetch(`/session/${id}/abort`, { method: 'POST', query: { directory } })
})
