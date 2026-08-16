<script setup lang="ts">
const open = defineModel<boolean>('open', { default: false })

const emit = defineEmits<{ select: [directory: string] }>()

const path = ref('/')
const entries = ref<Array<{ name: string; path: string; isDir: boolean }>>([])
const loading = ref(false)
const error = ref('')

async function load(target: string) {
  loading.value = true
  error.value = ''
  try {
    // /file lists entries relative to `directory`, so browse by moving the
    // directory anchor and always asking for its top level
    const res = await $fetch<unknown>('/api/opencode/file', {
      query: { path: '.', directory: target }
    })
    path.value = target
    const list = Array.isArray(res) ? res : []
    entries.value = list
      .map((item) => {
        if (typeof item === 'string') {
          return { name: item, path: join(target, item), isDir: item.endsWith('/') }
        }
        const obj = item as Record<string, unknown>
        const name = String(obj.name ?? obj.path ?? '')
        return {
          name,
          path: String(obj.absolute ?? obj.path ?? join(target, name)),
          isDir: obj.type === 'directory' || obj.type === 'dir' || obj.directory === true
        }
      })
      .filter((e) => e.isDir && e.name && !e.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to list directory'
    entries.value = []
  } finally {
    loading.value = false
  }
}

function join(base: string, name: string) {
  const sep = base.includes('\\') ? '\\' : '/'
  return base.replace(/[\\/]+$/, '') + sep + name.replace(/[\\/]+$/, '')
}

function up() {
  const clean = path.value.replace(/[\\/]+$/, '')
  const idx = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'))
  if (idx <= 0) return load('/')
  load(clean.slice(0, idx) || '/')
}

function choose() {
  emit('select', path.value)
  open.value = false
}

watch(open, (v) => { if (v) load(path.value) })
</script>

<template>
  <UModal v-model:open="open" title="Browse server folders" description="Pick the project folder opencode should work in.">
    <template #body>
      <div class="space-y-3">
        <div class="flex gap-2">
          <UInput
            v-model="path"
            class="flex-1 font-mono"
            size="sm"
            placeholder="/projects/my-app"
            @keydown.enter="load(path)"
          />
          <UButton size="sm" variant="soft" icon="i-lucide-arrow-right" @click="load(path)" />
        </div>

        <UAlert v-if="error" color="error" variant="subtle" :title="error" />

        <div class="bg-muted rounded-sm divide-y divide-default max-h-64 overflow-y-auto">
          <button
            class="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-elevated cursor-pointer"
            @click="up"
          >
            <UIcon name="i-lucide-corner-left-up" class="size-4 text-muted" />
            ..
          </button>
          <div v-if="loading" class="px-3 py-3 space-y-2.5">
            <div v-for="i in 4" :key="i" class="flex items-center gap-2">
              <USkeleton class="size-4 rounded-full" />
              <USkeleton class="h-3.5" :class="['w-1/3', 'w-1/2', 'w-2/5', 'w-1/4'][i - 1]" />
            </div>
          </div>
          <button
            v-for="entry in entries"
            v-else
            :key="entry.path"
            class="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-elevated cursor-pointer"
            @click="load(entry.path)"
          >
            <UIcon name="i-lucide-folder" class="size-4 text-primary/70" />
            <span class="truncate">{{ entry.name }}</span>
          </button>
          <div v-if="!loading && !entries.length" class="px-3 py-4 text-sm text-dimmed">
            No subfolders
          </div>
        </div>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full items-center justify-between gap-2">
        <span class="text-xs font-mono text-muted truncate">{{ path }}</span>
        <UButton color="primary" size="sm" label="Open this folder" @click="choose" />
      </div>
    </template>
  </UModal>
</template>
