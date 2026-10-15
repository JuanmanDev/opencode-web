// Remove a skill from this app's library.
export default defineEventHandler(async (event) => {
  requireApiToken(event)
  const { name } = getQuery(event) as { name?: string }
  if (!name) throw createError({ statusCode: 400, message: 'name is required' })
  return deleteLibrarySkill(event, name)
})
