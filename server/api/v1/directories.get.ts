// Every folder opencode has worked in (sessions of all projects, git
// projects, folders opened from any browser), newest first.
export default defineEventHandler(async (event) => {
  requireApiToken(event)
  return knownDirectories()
})
