export default defineEventHandler(async (event) => {
  requireApiToken(event)
  assertBodySize(event, 512 * 1024)
  const body = await readBody<Record<string, unknown>>(event)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw createError({ statusCode: 400, message: 'Expected a JSON object' })
  }
  await useStorage('data').setItem('project-meta.json', body)
  return { ok: true }
})
