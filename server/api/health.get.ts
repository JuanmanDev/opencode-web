// Liveness for the Docker healthcheck and the UI's "server down" states.
// `opencode` tells whether the opencode server answers, `protocol` /
// `version` which API it speaks (re-probed, not cached).
export default defineEventHandler(async () => {
  const profile = await getServerProfile(true).catch(() => null)
  return {
    ok: true,
    opencode: Boolean(profile?.reachable),
    protocol: profile?.protocol,
    version: profile?.version
  }
})
