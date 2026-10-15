// Every skill opencode sees in a project (built-in, global, project, remote
// and this app's library), with its content, permission and quality checks,
// plus the state of the library's catalog in the opencode config.
export default defineEventHandler(async (event) => {
  requireApiToken(event)
  const { directory } = getQuery(event) as { directory?: string }
  const [view, catalog] = await Promise.all([listSkillViews(directory), catalogState(event)])
  return { skills: view.skills, available: view.available, permissions: view.permissions ?? null, catalog }
})
