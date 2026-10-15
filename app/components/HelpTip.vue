<script setup lang="ts">
// A small "?" next to a setting: opens a short explanation with buttons to
// the place where the setting is managed (providers, agents, MCP servers…).
export interface HelpAction {
  label: string
  icon?: string
  to?: string
  onClick?: () => void
}

const props = defineProps<{
  title: string
  /** markdown */
  text: string
  actions?: HelpAction[]
}>()

const open = ref(false)

function run(action: HelpAction) {
  open.value = false
  action.onClick?.()
}
</script>

<template>
  <UButton
    icon="i-lucide-circle-help"
    size="xs"
    color="neutral"
    variant="link"
    class="p-0 align-middle text-dimmed hover:text-highlighted relative oc-tap-zone"
    :aria-label="`About: ${props.title}`"
    @click.stop.prevent="open = true"
  />
  <UModal v-model:open="open" :title="title">
    <template #body>
      <Markdown :text="text" class="text-sm" />
    </template>
    <template v-if="actions?.length" #footer>
      <div class="oc-actions">
        <UButton variant="ghost" color="neutral" label="Close" @click="open = false" />
        <span class="flex-1 oc-spacer" />
        <UButton
          v-for="action in actions"
          :key="action.label"
          color="primary"
          variant="soft"
          :icon="action.icon"
          :label="action.label"
          :to="action.to"
          @click="run(action)"
        />
      </div>
    </template>
  </UModal>
</template>
