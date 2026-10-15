import type { SessionRef } from '../../utils/control'

// Make opencode re-read its config: one project's instance or all of them.
// `when: "idle"` (default) waits until no session there is busy.
export default defineEventHandler(async (event) => {
  requireApiToken(event)
  await assertReloadable()
  type Body = { scope?: 'project' | 'all'; directory?: string; when?: 'now' | 'idle'; resume?: string[]; resumeBusy?: boolean }
  const body = await readBody<Body>(event).catch(() => ({} as Body))
  const scope = body?.scope === 'all' ? 'all' : 'project'
  // chats to continue afterwards: the given ones (in `directory`), and with
  // resumeBusy every chat that is busy right now (a "now" reload cuts them)
  const resume: SessionRef[] = (Array.isArray(body?.resume) ? body.resume : [])
    .filter((id): id is string => typeof id === 'string' && Boolean(id))
    .map((sessionID) => ({ directory: body?.directory, sessionID }))
  if (body?.resumeBusy) {
    const busy = await busySessions(scope === 'project' ? body?.directory : undefined).catch(() => [])
    for (const b of busy) if (!resume.some((r) => r.sessionID === b.sessionID)) resume.push({ directory: b.directory, sessionID: b.sessionID })
  }
  return requestReload({
    scope,
    directory: body?.directory,
    when: body?.when === 'now' ? 'now' : 'idle',
    resume
  })
})
