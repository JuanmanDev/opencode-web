<script setup lang="ts">
const props = defineProps<{ activity?: string }>()

const startedAt = ref(Date.now())
const elapsed = ref(0)
let timer: ReturnType<typeof setInterval> | undefined

onMounted(() => {
  timer = setInterval(() => {
    elapsed.value = Math.floor((Date.now() - startedAt.value) / 1000)
  }, 1000)
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
