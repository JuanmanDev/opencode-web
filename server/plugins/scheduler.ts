// Fires scheduled prompts (utils/scheduler.ts). NUXT_SCHEDULER=off disables it,
// e.g. when several replicas of the web app share one data volume.
export default defineNitroPlugin((nitro) => {
  if (String(useRuntimeConfig().scheduler) === 'off') return
  // dev reloads re-run plugins: keep exactly one ticker per process
  const flag = globalThis as { __ocwScheduler?: ReturnType<typeof setInterval> }
  if (flag.__ocwScheduler) clearInterval(flag.__ocwScheduler)
  const tick = () => tickSchedules().catch((error) => {
    console.warn(`[scheduler] ${error instanceof Error ? error.message : error}`)
  })
  flag.__ocwScheduler = setInterval(tick, 20_000)
  flag.__ocwScheduler.unref?.()
  setTimeout(tick, 3000).unref?.()
  nitro.hooks.hook('close', () => {
    clearInterval(flag.__ocwScheduler)
    flag.__ocwScheduler = undefined
  })
})
