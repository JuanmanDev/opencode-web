/** Sessions currently generating a reply (fed by SSE events), shared app-wide. */
export function useBusySessions() {
  const busy = useState<Record<string, boolean>>('busy-sessions', () => ({}))

  function set(sessionID: string, value: boolean) {
    if (value) {
      busy.value = { ...busy.value, [sessionID]: true }
    } else if (busy.value[sessionID]) {
      const copy = { ...busy.value }
      delete copy[sessionID]
      busy.value = copy
    }
  }

  return { busy, set }
}
