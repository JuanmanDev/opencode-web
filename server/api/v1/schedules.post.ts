import type { ScheduleInput } from '../../utils/scheduler'

// Create a scheduled prompt.
export default defineEventHandler(async (event) => {
  requireApiToken(event)
  assertBodySize(event, 64 * 1024)
  return presentSchedule(await createSchedule(await readBody<ScheduleInput>(event)))
})
