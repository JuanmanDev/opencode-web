// Remove a folder from the project picker for every browser.
export default defineEventHandler(async (event) => {
  requireApiToken(event)
  const { directory } = getQuery(event) as { directory?: string }
  if (!directory) throw createError({ statusCode: 400, message: 'directory is required' })
  await forgetDirectory(directory)
  return true
})
