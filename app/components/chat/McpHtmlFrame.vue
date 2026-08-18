<script setup lang="ts">
// Renders MCP UI / MCP App HTML resources (ui:// resources returned by tools)
// inside a sandboxed iframe. Scripts run isolated from the app origin.
const props = defineProps<{
  html?: string
  url?: string
  title?: string
}>()

const frame = ref<HTMLIFrameElement>()
const height = ref(240)

function onMessage(e: MessageEvent) {
  // mcp-ui iframes post {type:'ui-size-change', payload:{height}} messages
  if (e.source !== frame.value?.contentWindow) return
  const data = e.data
  if (data && typeof data === 'object') {
    const h = data.payload?.height ?? data.height
    if (typeof h === 'number' && h > 40 && h < 4000) height.value = h
  }
}

onMounted(() => window.addEventListener('message', onMessage))
onBeforeUnmount(() => window.removeEventListener('message', onMessage))
</script>

<template>
  <div class="rounded-md border border-default overflow-hidden bg-muted">
    <div class="flex items-center gap-2 px-2 py-1 border-b border-default text-xs text-muted">
      <UIcon name="i-lucide-app-window" class="size-3.5" />
      <span class="truncate">{{ title || 'MCP app' }}</span>
    </div>
    <!-- external-URL apps keep their real origin (module scripts + storage need
         it); inline srcdoc stays fully isolated -->
    <iframe
      ref="frame"
      :srcdoc="url ? undefined : html"
      :src="url"
      :sandbox="url
        ? 'allow-scripts allow-same-origin allow-forms allow-popups'
        : 'allow-scripts allow-forms'"
      class="w-full bg-white dark:bg-neutral-950"
      :style="{ height: height + 'px' }"
      :title="title || 'MCP app'"
    />
  </div>
</template>
