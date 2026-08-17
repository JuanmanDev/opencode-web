<script setup lang="ts">
// Horizontal scroller: native scrollbar kept, big arrow buttons, drag-to-scroll.
const el = ref<HTMLElement>()
const canLeft = ref(false)
const canRight = ref(false)

function update() {
  const node = el.value
  if (!node) return
  canLeft.value = node.scrollLeft > 4
  canRight.value = node.scrollLeft + node.clientWidth < node.scrollWidth - 4
}

function scrollBy(direction: 1 | -1) {
  el.value?.scrollBy({ left: direction * el.value.clientWidth * 0.8, behavior: 'smooth' })
}

// drag to scroll (mouse); clicks after a real drag are swallowed
let startX = 0
let startScroll = 0
let dragged = false

function onPointerDown(e: PointerEvent) {
  if (e.pointerType !== 'mouse' || !el.value) return
  startX = e.clientX
  startScroll = el.value.scrollLeft
  dragged = false
  const move = (ev: PointerEvent) => {
    const dx = ev.clientX - startX
    if (Math.abs(dx) > 5) dragged = true
    if (dragged && el.value) el.value.scrollLeft = startScroll - dx
  }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    if (dragged && el.value) {
      // swallow the click that follows a drag so links don't navigate
      el.value.addEventListener('click', (ce) => {
        ce.preventDefault()
        ce.stopPropagation()
      }, { capture: true, once: true })
    }
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

let observer: ResizeObserver | undefined
onMounted(() => {
  update()
  observer = new ResizeObserver(update)
  if (el.value) observer.observe(el.value)
})
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <div class="relative group/scroll">
    <div
      ref="el"
      class="flex gap-2 overflow-x-auto select-none"
      @scroll.passive="update"
      @pointerdown="onPointerDown"
    >
      <slot />
    </div>

    <UButton
      v-if="canLeft"
      icon="i-lucide-chevron-left"
      color="neutral"
      variant="solid"
      size="lg"
      class="absolute left-1 top-1/2 -translate-y-1/2 opacity-0 group-hover/scroll:opacity-90 shadow-lg z-10"
      aria-label="Scroll left"
      @click="scrollBy(-1)"
    />
    <UButton
      v-if="canRight"
      icon="i-lucide-chevron-right"
      color="neutral"
      variant="solid"
      size="lg"
      class="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover/scroll:opacity-90 shadow-lg z-10"
      aria-label="Scroll right"
      @click="scrollBy(1)"
    />
  </div>
</template>
