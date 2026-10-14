// Run a scheduled prompt now; answers once the prompt is sent.
export default defineEventHandler(async (event) => {
  requireApiToken(event)
  return runSchedule(getRouterParam(event, 'id')!, 'manual')
})
