// The skill library as an HTTP skill catalog for opencode (see utils/skills.ts):
//   GET /skills/[k<secret>/]r<rev>/index.json
//   GET /skills/[k<secret>/]r<rev>/<name>/<file>
// opencode fetches it without credentials, so with NUXT_API_TOKEN set the
// path carries a secret derived from the token instead.
export default defineEventHandler(async (event) => {
  const segments = (event.context.params?.path || '').split('/').filter(Boolean).map(decodeURIComponent)
  const parsed = parseCatalogPath(segments)
  if (!parsed) throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  const library = await readLibrary()
  const [first, ...file] = parsed.rest
  if (first === 'index.json' && !file.length) return catalogIndex(library)
  const skill = first ? library.skills[first] : undefined
  const text = skill?.files[file.join('/')]
  if (typeof text !== 'string') throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  setHeader(event, 'content-type', 'text/markdown; charset=utf-8')
  setHeader(event, 'cache-control', 'no-store')
  return text
})
