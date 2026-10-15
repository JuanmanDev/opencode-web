// Draft a new skill or improve one with a model (returns SKILL.md text,
// nothing is saved).
export default defineEventHandler(async (event) => {
  requireApiToken(event)
  assertBodySize(event, 512 * 1024)
  const body = await readBody<{ mode?: 'improve' | 'create'; name?: string; content?: string; brief?: string; model?: string; directory?: string }>(event)
  const mode = body?.mode === 'create' ? 'create' : 'improve'
  if (mode === 'improve' && !body?.content) throw createError({ statusCode: 400, message: 'content is required to improve a skill' })
  if (mode === 'create' && !body?.brief) throw createError({ statusCode: 400, message: 'brief is required to write a skill' })
  try {
    const content = await aiSkill({ mode, name: body.name, content: body.content, brief: body.brief, model: body.model, directory: body.directory })
    return { content, checks: lintSkill(content, body.name) }
  } catch (error) {
    throw createError({ statusCode: 502, message: error instanceof Error ? error.message : String(error) })
  }
})
