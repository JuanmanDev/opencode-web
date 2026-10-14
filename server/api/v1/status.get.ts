// One-call overview: opencode version/protocol, busy sessions, schedules,
// the last reload and whether the control MCP server is registered.
export default defineEventHandler(async (event) => {
  requireApiToken(event)
  const { directory } = getQuery(event) as { directory?: string }
  const [profile, capabilities, busy, control, schedules] = await Promise.all([
    getServerProfile(),
    getCapabilities(),
    busySessions(directory).catch(() => []),
    controlMcpState(event).catch(() => null),
    schedulerStats()
  ])
  return {
    opencode: { protocol: profile.protocol, version: profile.version || null, reachable: profile.reachable, hybrid: profile.hybrid },
    capabilities,
    busy,
    schedules,
    reload: reloadStatus() || null,
    control,
    // schedules run in this zone (set TZ on the web container)
    time: { zone: Intl.DateTimeFormat().resolvedOptions().timeZone, now: Date.now(), offsetMinutes: -new Date().getTimezoneOffset() }
  }
})
