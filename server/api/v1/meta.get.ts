export default defineEventHandler(async (event) => {
  requireApiToken(event)
  return (await useStorage('data').getItem('project-meta.json')) || {}
})
