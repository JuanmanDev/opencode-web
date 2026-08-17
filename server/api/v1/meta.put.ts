export default defineEventHandler(async (event) => {
  requireApiToken(event)
  const body = await readBody<Record<string, unknown>>(event)
  if (!body || typeof body !== 'object') {
    throw createError({ statusCode: 400, message: 'Expected a JSON object' })
  }
  await useStorage('data').setItem('project-meta.json', body)
  return { ok: true }
})
