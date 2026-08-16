<template>
  <div class="h-dvh flex flex-col bg-default text-default">
    <ClientOnly>
      <ServerHealth />
    </ClientOnly>
    <slot />
  </div>
</template>
