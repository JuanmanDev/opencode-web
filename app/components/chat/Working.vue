<script setup lang="ts">
const props = defineProps<{
  activity?: string
  /** when the run actually started (server timestamp, ms). Falls back to mount time. */
  since?: number
}>()

// anchor on the server-side start so reopening a chat mid-run shows the real
// elapsed time, not how long ago this component mounted
const startedAt = computed(() => (props.since && props.since > 0 ? props.since : mountedAt))
const mountedAt = Date.now()
const tick = () => Math.max(0, Math.floor((Date.now() - startedAt.value) / 1000))
const elapsed = ref(tick())
let timer: ReturnType<typeof setInterval> | undefined

watch(startedAt, () => { elapsed.value = tick() })
onMounted(() => {
  elapsed.value = tick()
  timer = setInterval(() => { elapsed.value = tick() }, 1000)
})
onBeforeUnmount(() => clearInterval(timer))

watch(() => props.activity, () => { /* keep total elapsed, not per-activity */ })

const elapsedLabel = computed(() => {
  const s = elapsed.value
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
})
</script>

<template>
  <div class="px-3 sm:px-4 py-2 space-y-1.5 oc-appear">
    <div class="flex items-center gap-2 text-xs font-mono">
      <UIcon name="i-lucide-sparkles" class="size-3.5 text-muted" />
      <span class="oc-shimmer-text">{{ activity || 'thinking…' }}</span>
      <span class="text-dimmed ml-auto">{{ elapsedLabel }}</span>
    </div>
    <div class="oc-progress" />
  </div>
</template>
