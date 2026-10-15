// Touch screens have no hover, so icon-only buttons never show their tooltip.
// A long press (~0.45 s) on any button or link shows its label in a small
// bubble instead (data-tip, else aria-label, else title) and swallows the
// tap that would follow, so a long press explains without acting.

const DELAY = 450
const MOVE_TOLERANCE = 10

export default defineNuxtPlugin(() => {
  let timer: ReturnType<typeof setTimeout> | undefined
  let hideTimer: ReturnType<typeof setTimeout> | undefined
  let start: { x: number; y: number } | null = null
  let shownFor: Element | null = null
  let bubble: HTMLDivElement | null = null

  function labelOf(el: Element) {
    const text = el.getAttribute('data-tip') || el.getAttribute('aria-label') || el.getAttribute('title') || ''
    return text.trim()
  }

  function hide() {
    clearTimeout(hideTimer)
    bubble?.remove()
    bubble = null
  }

  function show(el: Element, text: string) {
    hide()
    const rect = el.getBoundingClientRect()
    bubble = document.createElement('div')
    bubble.className = 'oc-touch-tip'
    bubble.setAttribute('role', 'tooltip')
    bubble.textContent = text
    document.body.appendChild(bubble)
    const width = bubble.offsetWidth
    const height = bubble.offsetHeight
    const left = Math.min(window.innerWidth - width - 8, Math.max(8, rect.left + rect.width / 2 - width / 2))
    // above the finger's target when there is room, else below it
    const top = rect.top - height - 10 > 8 ? rect.top - height - 10 : rect.bottom + 10
    bubble.style.left = `${left}px`
    bubble.style.top = `${top}px`
    navigator.vibrate?.(8)
  }

  function cancel() {
    clearTimeout(timer)
    timer = undefined
    start = null
  }

  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return
    hide()
    shownFor = null
    const el = (e.target as Element | null)?.closest('button, a, [role="button"], [role="tab"], [data-tip]')
    if (!el) return
    const text = labelOf(el)
    if (!text) return
    start = { x: e.clientX, y: e.clientY }
    timer = setTimeout(() => {
      timer = undefined
      shownFor = el
      show(el, text)
    }, DELAY)
  }, { capture: true, passive: true })

  document.addEventListener('pointermove', (e) => {
    if (!start || e.pointerType !== 'touch') return
    if (Math.abs(e.clientX - start.x) > MOVE_TOLERANCE || Math.abs(e.clientY - start.y) > MOVE_TOLERANCE) cancel()
  }, { capture: true, passive: true })

  const release = () => {
    cancel()
    if (bubble) hideTimer = setTimeout(hide, 1400)
  }
  document.addEventListener('pointerup', release, { capture: true, passive: true })
  document.addEventListener('pointercancel', release, { capture: true, passive: true })
  window.addEventListener('scroll', () => { cancel(); hide() }, { capture: true, passive: true })

  // the tap that ends a long press must not activate the button
  document.addEventListener('click', (e) => {
    if (!shownFor) return
    const target = e.target as Node | null
    if (target && shownFor.contains(target)) {
      e.preventDefault()
      e.stopPropagation()
    }
    shownFor = null
  }, { capture: true })
  // nor open the browser's link/context menu
  document.addEventListener('contextmenu', (e) => {
    if (shownFor || timer) e.preventDefault()
  }, { capture: true })
})
