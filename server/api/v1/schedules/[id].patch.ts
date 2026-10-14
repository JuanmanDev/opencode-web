import type { ScheduleInput } from '../../../utils/scheduler'

// Update a scheduled prompt (any subset of its fields).
export default defineEventHandler(async (event) => {
  requireApiToken(event)
  assertBodySize(event, 64 * 1024)
  return presentSchedule(await updateSchedule(getRouterParam(event, 'id')!, await readBody<ScheduleInput>(event)))
})
