/** Clipboard copy that also works on plain http (no secure context). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* fall through */ }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  } catch {
    return false
  }
}

/** Text-to-speech for chat replies (Web Speech API, works on http). */
export function useSpeech() {
  const speakingId = useState<string>('speaking-message', () => '')

  function stop() {
    window.speechSynthesis?.cancel()
    speakingId.value = ''
  }

  function toggle(id: string, text: string) {
    if (!('speechSynthesis' in window)) return false
    if (speakingId.value === id) {
      stop()
      return true
    }
    window.speechSynthesis.cancel()
    // strip the markdown noise so it reads naturally
    const plain = text
      .replace(/```[\s\S]*?```/g, ' Code block omitted. ')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/[*_#>|-]+/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
    if (!plain) return false
    const utterance = new SpeechSynthesisUtterance(plain)
    utterance.onend = () => { if (speakingId.value === id) speakingId.value = '' }
    utterance.onerror = () => { if (speakingId.value === id) speakingId.value = '' }
    speakingId.value = id
    window.speechSynthesis.speak(utterance)
    return true
  }

  return { speakingId, toggle, stop }
}
