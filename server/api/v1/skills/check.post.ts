// Quality checks for a SKILL.md text (opencode's rules + advice).
export default defineEventHandler(async (event) => {
  requireApiToken(event)
  assertBodySize(event, 512 * 1024)
  const body = await readBody<{ content?: string; name?: string }>(event)
  return { checks: lintSkill(String(body?.content || ''), body?.name), parsed: parseSkillMd(String(body?.content || '')) }
})
