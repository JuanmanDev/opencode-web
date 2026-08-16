<script setup lang="ts">
import { marked } from 'marked'
import DOMPurify from 'isomorphic-dompurify'

const props = defineProps<{ text: string }>()

const html = computed(() => {
  const raw = marked.parse(props.text || '', { async: false, gfm: true, breaks: true }) as string
  return DOMPurify.sanitize(raw, {
    ADD_ATTR: ['target'],
    FORBID_TAGS: ['style', 'form', 'input']
  })
})
</script>

<template>
  <div class="oc-markdown text-sm" v-html="html" />
</template>
