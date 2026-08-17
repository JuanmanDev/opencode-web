<script setup lang="ts">
// The agent's `question` tool: render options and collect answers.
interface QuestionOption { label: string; description?: string }
interface Question { question: string; header?: string; options?: QuestionOption[]; multiSelect?: boolean }

const props = defineProps<{
  request: { id: string; questions: Question[] }
}>()

const emit = defineEmits<{
  reply: [answers: string[][]]
  reject: []
}>()

// answers[i] = selected labels for question i
const selected = ref<string[][]>(props.request.questions.map(() => []))
const custom = ref<string[]>(props.request.questions.map(() => ''))
const sending = ref(false)

function toggle(qi: number, label: string, multi?: boolean) {
  const current = selected.value[qi]!
  if (multi) {
    selected.value[qi] = current.includes(label)
      ? current.filter((l) => l !== label)
      : [...current, label]
  } else {
    selected.value[qi] = [label]
    // single question, single choice -> answer immediately
    if (props.request.questions.length === 1 && !custom.value[0]?.trim()) submit()
  }
}

function answerFor(qi: number): string[] {
  const extra = custom.value[qi]?.trim()
  return [...selected.value[qi]!, ...(extra ? [extra] : [])]
}

const complete = computed(() =>
  props.request.questions.every((_, qi) => answerFor(qi).length > 0)
)

function submit() {
  if (!complete.value || sending.value) return
  sending.value = true
  emit('reply', props.request.questions.map((_, qi) => answerFor(qi)))
}
</script>

<template>
  <div class="oc-appear mx-3 sm:mx-4 my-2 rounded-sm bg-elevated border-l-2 border-primary/60 px-3 py-2.5 space-y-3">
    <div v-for="(q, qi) in request.questions" :key="qi" class="space-y-1.5">
      <div class="flex items-center gap-2">
        <UIcon name="i-lucide-message-circle-question" class="size-4 text-primary shrink-0" />
        <span v-if="q.header" class="text-[10px] uppercase tracking-widest text-dimmed">{{ q.header }}</span>
      </div>
      <p class="text-sm">{{ q.question }}</p>
      <div class="flex flex-col gap-1">
        <button
          v-for="opt in q.options || []"
          :key="opt.label"
          class="oc-row flex items-start gap-2 rounded-sm px-2.5 py-1.5 text-left cursor-pointer"
          :class="selected[qi]!.includes(opt.label) ? 'bg-accented text-highlighted' : 'bg-muted hover:bg-accented/60'"
          @click="toggle(qi, opt.label, q.multiSelect)"
        >
          <UIcon
            :name="q.multiSelect
              ? (selected[qi]!.includes(opt.label) ? 'i-lucide-check-square' : 'i-lucide-square')
              : (selected[qi]!.includes(opt.label) ? 'i-lucide-circle-dot' : 'i-lucide-circle')"
            class="size-3.5 shrink-0 mt-0.5"
          />
          <span class="min-w-0">
            <span class="text-sm block">{{ opt.label }}</span>
            <span v-if="opt.description" class="text-xs text-dimmed block">{{ opt.description }}</span>
          </span>
        </button>
        <UInput
          v-model="custom[qi]"
          size="sm"
          placeholder="Or type your own answer…"
          class="w-full"
          @keydown.enter="submit"
        />
      </div>
    </div>
    <div class="flex justify-end gap-2">
      <UButton size="xs" color="neutral" variant="ghost" label="Dismiss" @click="emit('reject')" />
      <UButton
        size="xs"
        color="primary"
        label="Answer"
        :loading="sending"
        :disabled="!complete"
        @click="submit"
      />
    </div>
  </div>
</template>
