// State of the last reload request (waiting / done / failed / gave-up).
export default defineEventHandler((event) => {
  requireApiToken(event)
  return reloadStatus() || null
})
