import { Buffer } from 'node:buffer'

export default defineEventHandler(async () => {
  const config = useRuntimeConfig()
  let opencode = false
  try {
    const headers: Record<string, string> = {}
    if (config.opencodePassword) {
      headers.authorization =
        'Basic ' + Buffer.from(`${config.opencodeUsername}:${config.opencodePassword}`).toString('base64')
    }
    await $fetch(`${config.opencodeUrl}/app`, { headers, timeout: 3000 }).catch(async () => {
      // older/newer servers expose different roots; any HTTP response means reachable
      await $fetch(`${config.opencodeUrl}/config`, { headers, timeout: 3000 })
    })
    opencode = true
  } catch {
    opencode = false
  }
  return { ok: true, opencode }
})
