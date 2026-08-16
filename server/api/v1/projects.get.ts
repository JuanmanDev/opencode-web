export default defineEventHandler(async (event) => {
  requireApiToken(event)
  return opencodeFetch('/project')
})
