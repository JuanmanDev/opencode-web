export default defineEventHandler(async (event) => {
  requireApiToken(event)
  const body = await readBody<{ directory?: string; title?: string }>(event)
  return opencodeFetch('/session', {
    method: 'POST',
    body: body?.title ? { title: body.title } : {},
    query: { directory: body?.directory }
  })
})
