// What the connected opencode server supports: the UI hides the rest.
export default defineEventHandler(async (event) => {
  requireApiToken(event)
  return getCapabilities()
})
