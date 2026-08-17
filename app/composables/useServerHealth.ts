// Global opencode-server health tracking.
// Every API call reports here; components show a banner while degraded and a
// blocking modal once errors pile up.

const WINDOW_MS = 30_000
const MODAL_THRESHOLD = 3
const timestamps: number[] = []

export const serverDegraded = ref(false)   // at least one recent error
export const serverDown = ref(false)       // many recent errors -> modal
export const serverErrorCount = ref(0)

export function reportServerError() {
  if (!import.meta.client) return
  const now = Date.now()
  timestamps.push(now)
  while (timestamps.length && now - timestamps[0]! > WINDOW_MS) timestamps.shift()
  serverErrorCount.value = timestamps.length
  serverDegraded.value = true
  if (timestamps.length >= MODAL_THRESHOLD) serverDown.value = true
}

export function reportServerOk() {
  if (!import.meta.client) return
  timestamps.length = 0
  serverErrorCount.value = 0
  serverDegraded.value = false
  serverDown.value = false
}

/** $fetch instance used for all opencode API calls: feeds the health state. */
export const ocFetch = $fetch.create({
  retry: 1,
  retryDelay: 400,
  onResponse({ response }) {
    if (response.ok) reportServerOk()
  },
  onResponseError({ response }) {
    // gateway failures = opencode unreachable; app-level 4xx are not outages
    if ([502, 504].includes(response.status)) reportServerError()
  },
  onRequestError() {
    reportServerError()
  }
})
