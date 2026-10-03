<script setup lang="ts">
// iOS Safari ignores `interactive-widget=resizes-content`: the on-screen
// keyboard covers the page instead of shrinking it, hiding the prompt box's
// Send button. While the keyboard is up, size the shell to the visual
// viewport (--oc-vvh) so everything at the bottom stays above the keyboard.
function syncVisualViewport() {
  const vv = window.visualViewport
  if (!vv) return
  const root = document.documentElement
  // pinch-zoom also shrinks the visual viewport - only react at scale 1;
  // Chrome/Android already resizes the layout (clientHeight shrinks with it)
  const keyboard = vv.scale < 1.01 && root.clientHeight - vv.height > 80
  if (keyboard) {
    root.style.setProperty('--oc-vvh', `${Math.round(vv.height)}px`)
    // iOS pans the page to reveal the input; the shell now fits, undo that
    window.scrollTo(0, 0)
  } else {
    root.style.removeProperty('--oc-vvh')
  }
}

onMounted(() => {
  window.visualViewport?.addEventListener('resize', syncVisualViewport)
  syncVisualViewport()
})
onBeforeUnmount(() => window.visualViewport?.removeEventListener('resize', syncVisualViewport))
</script>

<template>
  <div
    class="h-[var(--oc-vvh,100dvh)] flex flex-col bg-default text-default pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
  >
    <ClientOnly>
      <ServerHealth />
      <GlobalSearch />
    </ClientOnly>
    <slot />
  </div>
</template>
