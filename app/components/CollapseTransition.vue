<script setup lang="ts">
// True auto-height collapse: measures content and animates height so panels
// of any size open/close smoothly (max-height hacks jump on tall content).
const DURATION = 260

function animate(el: HTMLElement, from: string, to: string, done: () => void) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    done()
    return
  }
  el.style.overflow = 'hidden'
  el.style.height = from
  el.style.opacity = from === '0px' ? '0' : '1'
  // force reflow so the starting values apply before transitioning
  void el.offsetHeight
  el.style.transition = `height ${DURATION}ms ease, opacity ${DURATION - 60}ms ease`
  el.style.height = to
  el.style.opacity = to === '0px' ? '0' : '1'
  let finished = false
  const end = () => {
    if (finished) return
    finished = true
    el.style.height = ''
    el.style.opacity = ''
    el.style.transition = ''
    el.style.overflow = ''
    done()
  }
  el.addEventListener('transitionend', end, { once: true })
  setTimeout(end, DURATION + 60)
}

function onEnter(el: Element, done: () => void) {
  const target = el as HTMLElement
  animate(target, '0px', `${target.scrollHeight}px`, done)
}

function onLeave(el: Element, done: () => void) {
  const target = el as HTMLElement
  animate(target, `${target.scrollHeight}px`, '0px', done)
}
</script>

<template>
  <Transition :css="false" @enter="onEnter" @leave="onLeave">
    <slot />
  </Transition>
</template>
