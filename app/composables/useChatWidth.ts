// Width of the conversation column, chosen in the chat header and kept in a
// cookie (SSR renders the same width, no jump on load):
//   comfortable - readable line length (the default)
//   wide        - more room for code, tables and apps
//   full        - the whole window
// MCP apps and data tables can break out of a narrower column and use the
// width that is available (`wideApps`).
export type ChatWidth = 'comfortable' | 'wide' | 'full'

const MAX: Record<ChatWidth, string> = {
  comfortable: '56rem',
  wide: '80rem',
  full: '100%'
}

export function useChatWidth() {
  const width = useCookie<ChatWidth>('oc-chat-width', { default: () => 'comfortable', maxAge: 60 * 60 * 24 * 365 })
  const wideApps = useCookie<boolean>('oc-wide-apps', { default: () => true, maxAge: 60 * 60 * 24 * 365 })
  const maxWidth = computed(() => MAX[width.value] || MAX.comfortable)

  const menu = computed(() => [
    [{ type: 'label' as const, label: 'Chat width' }],
    ([
      ['comfortable', 'Comfortable', 'i-lucide-align-center'],
      ['wide', 'Wide', 'i-lucide-move-horizontal'],
      ['full', 'Full width', 'i-lucide-maximize-2']
    ] as const).map(([value, label, icon]) => ({
      label,
      icon,
      type: 'checkbox' as const,
      checked: width.value === value,
      onUpdateChecked: () => { width.value = value },
      onSelect: (e: Event) => e.preventDefault()
    })),
    [{
      label: 'Apps & tables use all the width',
      icon: 'i-lucide-app-window',
      type: 'checkbox' as const,
      checked: wideApps.value,
      onUpdateChecked: (on: boolean) => { wideApps.value = on },
      onSelect: (e: Event) => e.preventDefault()
    }]
  ])

  return { width, wideApps, maxWidth, menu }
}
