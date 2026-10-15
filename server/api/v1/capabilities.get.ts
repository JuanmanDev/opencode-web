// What the connected opencode server supports: the UI hides the rest.
export default defineEventHandler(async (event) => {
  requireApiToken(event)
  // every page load asks: a good moment to register agent control once
  ensureControlMcp(event)
  return getCapabilities()
})
