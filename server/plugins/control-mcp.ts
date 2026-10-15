// Agent control is on by default: register it once at startup when the app
// knows the URL opencode reaches it at (NUXT_SELF_URL); otherwise the first
// page load does it (see ensureControlMcp).
export default defineNitroPlugin(() => {
  setTimeout(() => { ensureControlMcp() }, 5000).unref?.()
})
