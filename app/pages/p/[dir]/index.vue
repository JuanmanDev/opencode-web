<script setup lang="ts">
const route = useRoute()
const directory = computed(() => decodeDir(route.params.dir as string))
const dirParam = computed(() => route.params.dir as string)

const { sessions, refresh } = useSessions(directory)
const api = useOpencodeApi(directory)
const creating = ref(false)

onMounted(refresh)

async function newSession() {
  creating.value = true
  try {
    const session = await api.createSession()
    navigateTo(`/p/${dirParam.value}/session/${session.id}`)
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <div class="flex-1 flex items-center justify-center p-6">
    <div class="text-center max-w-sm">
      <UIcon name="i-lucide-messages-square" class="size-10 text-dimmed mx-auto mb-3" />
      <h2 class="text-lg font-semibold mb-1">{{ dirName(directory) }}</h2>
      <p class="text-sm text-muted mb-5">
        {{ sessions.length ? 'Pick a session from the sidebar or start a new one.' : 'Start your first chat in this project.' }}
      </p>
      <UButton
        color="primary"
        icon="i-lucide-plus"
        label="New chat"
        :loading="creating"
        @click="newSession"
      />
    </div>
  </div>
</template>
