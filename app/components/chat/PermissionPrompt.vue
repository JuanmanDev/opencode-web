<script setup lang="ts">
import type { PermissionRequest } from '#shared/types/opencode'

defineProps<{ permission: PermissionRequest }>()

const emit = defineEmits<{
  respond: [response: 'once' | 'always' | 'reject']
}>()
</script>

<template>
  <UAlert
    color="warning"
    variant="subtle"
    icon="i-lucide-shield-question"
    class="mx-3 sm:mx-4 my-2 oc-appear"
  >
    <template #title>Permission required</template>
    <template #description>
      <div class="space-y-2">
        <p class="text-sm break-words">{{ permission.title }}</p>
        <pre
          v-if="permission.metadata && Object.keys(permission.metadata).length"
          class="text-xs font-mono bg-elevated rounded p-2 overflow-x-auto max-h-40 overflow-y-auto"
        >{{ JSON.stringify(permission.metadata, null, 2) }}</pre>
        <div class="flex flex-wrap gap-2 pt-1">
          <UButton size="xs" color="success" label="Allow once" @click="emit('respond', 'once')" />
          <UButton size="xs" color="success" variant="soft" label="Always allow" @click="emit('respond', 'always')" />
          <UButton size="xs" color="error" variant="soft" label="Reject" @click="emit('respond', 'reject')" />
        </div>
      </div>
    </template>
  </UAlert>
</template>
