<script setup lang="ts">
// Global health UI: slim banner on any recent error, blocking modal once the
// server is clearly down. Polls /api/health until it recovers.

const toast = useToast()
const suppressed = ref(false)   // "keep waiting" hides the modal, banner stays
const checking = ref(false)
const wasDown = ref(false)

const modalOpen = computed({
  get: () => serverDown.value && !suppressed.value,
  set: (v: boolean) => { if (!v) suppressed.value = true }
})

let timer: ReturnType<typeof setInterval> | undefined

async function checkNow() {
  checking.value = true
  try {
    const health = await $fetch<{ ok: boolean; opencode: boolean }>('/api/health', { timeout: 8000 })
    if (health.opencode) {
      const recovered = wasDown.value
      reportServerOk()
      wasDown.value = false
      suppressed.value = false
      if (recovered) {
        toast.add({ title: 'opencode server is back', description: 'Reloading data…', color: 'success' })
        setTimeout(() => window.location.reload(), 800)
      }
    }
  } catch { /* still down */ } finally {
    checking.value = false
  }
}

watch(serverDegraded, (degraded) => {
  if (degraded) {
    if (serverDown.value) wasDown.value = true
    if (!timer) timer = setInterval(checkNow, 8000)
  } else if (timer) {
    clearInterval(timer)
    timer = undefined
    suppressed.value = false
  }
}, { immediate: true })

watch(serverDown, (down) => { if (down) wasDown.value = true })

onBeforeUnmount(() => clearInterval(timer))
</script>

<template>
  <div>
    <!-- slim banner: any recent errors -->
    <div
      v-if="serverDegraded"
      class="flex items-center gap-2 px-3 py-1.5 text-xs bg-error/10 text-error"
    >
      <UIcon name="i-lucide-plug-zap" class="size-3.5 shrink-0" />
      <span class="truncate">opencode server is not responding — retrying automatically…</span>
      <span class="flex-1" />
      <UButton
        size="xs"
        color="error"
        variant="ghost"
        icon="i-lucide-refresh-cw"
        :loading="checking"
        label="Check now"
        @click="checkNow"
      />
    </div>

    <!-- modal: too many errors -->
    <UModal v-model:open="modalOpen" :dismissible="true" title="Server not responding">
      <template #body>
        <div class="flex flex-col items-center text-center gap-3 py-2">
          <div class="size-12 rounded-full bg-error/10 flex items-center justify-center">
            <UIcon name="i-lucide-unplug" class="size-6 text-error" />
          </div>
          <p class="text-sm text-muted">
            The opencode server has failed to answer several requests in a row.
            It may be overloaded, restarting, or offline.
          </p>
          <p class="text-xs text-dimmed font-mono">
            {{ serverErrorCount }} errors in the last 30s · auto-retrying every 8s
          </p>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-center gap-2">
          <UButton
            color="neutral"
            variant="soft"
            label="Keep waiting in background"
            @click="suppressed = true"
          />
          <UButton
            color="primary"
            icon="i-lucide-refresh-cw"
            :loading="checking"
            label="Check now"
            @click="checkNow"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
