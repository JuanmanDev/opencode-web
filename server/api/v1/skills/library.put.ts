// Create or update a skill in this app's library; opencode loads it from the
// catalog after a reload.
export default defineEventHandler(async (event) => {
  requireApiToken(event)
  assertBodySize(event, 512 * 1024)
  const body = await readBody<{ name?: string; content?: string; files?: Record<string, string>; origin?: string }>(event)
  if (!body?.name || typeof body.content !== 'string') throw createError({ statusCode: 400, message: 'name and content are required' })
  return saveLibrarySkill(event, { name: body.name, content: body.content, files: body.files, origin: body.origin })
})
