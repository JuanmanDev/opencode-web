import type { OpencodeEvent } from '#shared/types/opencode'

type Listener = (event: OpencodeEvent) => void

interface Bus {
  source: EventSource | null
  listeners: Set<Listener>
  retry: number
}

const buses = new Map<string, Bus>()

function connect(directory: string, bus: Bus) {
  if (bus.source) return
  const url = directory
    ? `/api/opencode/event?directory=${encodeURIComponent(directory)}`
    : '/api/opencode/event'
  const source = new EventSource(url)
  bus.source = source
  source.onopen = () => reportServerOk()
  source.onmessage = (e) => {
    bus.retry = 0
    try {
      const parsed = JSON.parse(e.data) as OpencodeEvent
      for (const listener of bus.listeners) listener(parsed)
    } catch {
      // ignore non-JSON keepalives
    }
  }
  source.onerror = () => {
    reportServerError()
    source.close()
    bus.source = null
    if (bus.listeners.size === 0) return
    const delay = Math.min(15000, 500 * 2 ** bus.retry++)
    setTimeout(() => {
      if (bus.listeners.size > 0) connect(directory, bus)
    }, delay)
  }
}

/**
 * Shared SSE stream per project directory. Multiple components subscribe to a
 * single EventSource; it reconnects with backoff and closes when unused.
 */
export function useOpencodeEvents(
  directory: MaybeRefOrGetter<string | undefined>,
  handler: Listener
) {
  if (!import.meta.client) return

  let currentKey: string | null = null

  function unsubscribe() {
    if (currentKey === null) return
    const bus = buses.get(currentKey)
    if (bus) {
      bus.listeners.delete(handler)
      if (bus.listeners.size === 0) {
        bus.source?.close()
        bus.source = null
      }
    }
    currentKey = null
  }

  function subscribe(dir: string | undefined) {
    unsubscribe()
    const key = dir || ''
    let bus = buses.get(key)
    if (!bus) {
      bus = { source: null, listeners: new Set(), retry: 0 }
      buses.set(key, bus)
    }
    bus.listeners.add(handler)
    currentKey = key
    connect(key, bus)
  }

  watch(() => toValue(directory), (dir) => subscribe(dir), { immediate: true })
  onBeforeUnmount(unsubscribe)
}
