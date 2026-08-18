<template>
  <div class="h-dvh flex flex-col bg-default text-default">
    <ClientOnly>
      <ServerHealth />
      <GlobalSearch />
    </ClientOnly>
    <slot />
  </div>
</template>
