<script setup lang="ts">
// Wrapper for MCP apps and data views in the chat: they use the width that is
// available, up to a maximum you set by dragging the handle on the right
// edge. Dragged all the way out (or double-clicked) it goes back to
// automatic: the full available width. One preference for every block.
const pref = useCookie<number | null>('oc-block-width', { default: () => null, maxAge: 60 * 60 * 24 * 365 })
const box = ref<HTMLElement>()
const dragging = ref(false)
const MIN = 320

function startDrag(e: PointerEvent) {
  const el = box.value
  const parent = el?.parentElement
  if (!el || !parent) return
  e.preventDefault()
  dragging.value = true
  const available = parent.clientWidth
  const startX = e.clientX
  const startW = el.getBoundingClientRect().width
  const move = (ev: PointerEvent) => {
    // centred block: each side moves by the pointer's distance
    const width = startW + (ev.clientX - startX) * 2
    pref.value = width >= available - 24 ? null : Math.max(MIN, Math.round(width))
  }
  const up = () => {
    dragging.value = false
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

function step(dir: 1 | -1) {
  const parent = box.value?.parentElement
  if (!parent) return
  const current = pref.value ?? parent.clientWidth
  const next = current + dir * 64
  pref.value = next >= parent.clientWidth - 24 ? null : Math.max(MIN, next)
}
</script>

<template>
  <div
    ref="box"
    class="group/width relative mx-auto"
    :class="dragging ? 'select-none' : 'transition-[max-width] duration-150'"
    :style="{ maxWidth: pref ? `${pref}px` : '100%' }"
  >
    <slot />
    <!-- right edge: drag to set the maximum width, double-click for automatic -->
    <div
      role="separator"
      aria-orientation="vertical"
      tabindex="0"
      :aria-label="pref ? `Maximum width ${pref}px: drag, arrow keys, or double-click for automatic` : 'Automatic width: drag or use the arrow keys to set a maximum'"
      :title="pref ? `Max ${pref}px · double-click: automatic` : 'Automatic width · drag to set a maximum'"
      class="absolute top-0 bottom-0 -right-2 w-3 cursor-col-resize flex items-center justify-center pointer-coarse:hidden focus-visible:outline-none"
      @pointerdown="startDrag"
      @dblclick="pref = null"
      @keydown.left.prevent="step(-1)"
      @keydown.right.prevent="step(1)"
    >
      <span
        class="h-10 w-1 rounded-full transition-opacity"
        :class="dragging ? 'bg-(--ui-border-inverted) opacity-100' : 'bg-accented opacity-0 group-hover/width:opacity-100 group-focus-within/width:opacity-100'"
      />
    </div>
  </div>
</template>
