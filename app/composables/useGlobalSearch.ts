/** Open/close state for the global search modal (Ctrl+K). */
export function useGlobalSearch() {
  const open = useState('global-search-open', () => false)
  return { open }
}
