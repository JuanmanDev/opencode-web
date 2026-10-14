// Scheduled prompts, optionally only those of one project.
export default defineEventHandler(async (event) => {
  requireApiToken(event)
  const { directory } = getQuery(event) as { directory?: string }
  return (await listSchedules(directory)).map(presentSchedule)
})
