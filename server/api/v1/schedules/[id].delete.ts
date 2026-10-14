// Delete a scheduled prompt.
export default defineEventHandler(async (event) => {
  requireApiToken(event)
  return deleteSchedule(getRouterParam(event, 'id')!)
})
