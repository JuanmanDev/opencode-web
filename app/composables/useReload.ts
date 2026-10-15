// Ask the web app to make opencode re-read its config (POST /api/v1/reload)
// and follow the request until it is done, with toasts along the way.

interface ReloadState {
  scope: 'project' | 'all'
  directory?: string
  when: 'now' | 'idle'
  state: 'waiting' | 'done' | 'failed' | 'gave-up'
  message?: string
  resumed?: string[]
}

export function useReload() {
  const toast = useToast()
  const caps = useCapabilities()
  const reloading = useState('oc-reloading', () => false)
  // changes saved to the config that opencode only picks up after a reload,
  // by project directory ('*' = global): pages show a "reload to apply" notice
  const pendingReload = useState<Record<string, string[]>>('oc-pending-reload', () => ({}))

  function markPending(directory: string | '*', what: string) {
    const list = pendingReload.value[directory] || []
    if (!list.includes(what)) pendingReload.value = { ...pendingReload.value, [directory]: [...list, what] }
  }

  function pendingFor(directory: string) {
    return [...new Set([...(pendingReload.value['*'] || []), ...(pendingReload.value[directory] || [])])]
  }

  /**
   * `resume`: chats (of `directory`) to continue once the reload is done;
   * `resumeBusy`: continue every chat that is busy when the reload starts.
   */
  async function reload(opts: { scope: 'project' | 'all'; directory?: string; when?: 'now' | 'idle'; resume?: string[]; resumeBusy?: boolean }) {
    if (!caps.value.config) {
      toast.add({ title: 'Not available on this server', description: 'Restart the opencode server process to reload its config.', color: 'warning' })
      return
    }
    reloading.value = true
    const label = opts.scope === 'all' ? 'all projects' : dirName(opts.directory || '')
    try {
      let state = await $fetch<ReloadState>('/api/v1/reload', { method: 'POST', body: opts, timeout: 15000 })
      const started = Date.now()
      let announced = false
      while (state?.state === 'waiting' && Date.now() - started < 16 * 60_000) {
        if (!announced && state.message?.startsWith('waiting')) {
          announced = true
          toast.add({ title: `Reload of ${label} queued`, description: `${state.message}: it runs once they finish.`, color: 'info' })
        }
        await new Promise((resolve) => setTimeout(resolve, 2000))
        state = await $fetch<ReloadState>('/api/v1/reload', { timeout: 10000 }).catch(() => state)
      }
      if (state?.state === 'done') {
        pendingReload.value = {}
        const resumed = state.resumed?.length ? ` ${state.resumed.length} chat(s) continue where they stopped.` : ''
        toast.add({ title: `Reloaded ${label}`, description: `opencode re-read its config. New messages use it.${resumed}`, color: 'success' })
      } else {
        toast.add({ title: `Reload of ${label}: ${state?.state || 'unknown'}`, description: state?.message, color: 'warning' })
      }
      return state
    } catch (e) {
      const data = (e as { data?: { message?: string } })?.data
      toast.add({ title: 'Reload failed', description: data?.message || String(e), color: 'error' })
    } finally {
      reloading.value = false
    }
  }

  function menuItems(directory: string) {
    return [[
      { label: 'Reload this project', description: 'when its sessions are idle', icon: 'i-lucide-folder-sync', onSelect: () => reload({ scope: 'project', directory }) },
      { label: 'Reload all projects', description: 'like restarting opencode serve', icon: 'i-lucide-server-cog', onSelect: () => reload({ scope: 'all' }) }
    ], [
      { label: 'Reload now & continue', description: 'interrupts running replies, then resumes them', icon: 'i-lucide-zap', color: 'warning' as const, onSelect: () => reload({ scope: 'project', directory, when: 'now', resumeBusy: true }) },
      { label: 'Reload this project now', description: 'interrupts running replies', icon: 'i-lucide-zap-off', color: 'warning' as const, onSelect: () => reload({ scope: 'project', directory, when: 'now' }) }
    ]]
  }

  return { reload, reloading, menuItems, pendingReload, markPending, pendingFor }
}
