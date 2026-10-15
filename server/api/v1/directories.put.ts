// Remember a folder that was opened (shared by every browser and device).
export default defineEventHandler(async (event) => {
  requireApiToken(event)
  const body = await readBody<{ directory?: string }>(event)
  const directory = String(body?.directory || '').trim()
  if (!directory || directory.length > 1024) throw createError({ statusCode: 400, message: 'directory is required' })
  await rememberDirectory(directory)
  return true
})
