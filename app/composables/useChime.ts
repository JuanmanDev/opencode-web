const STORAGE_KEY = 'opencode-web.chime'

let ctx: AudioContext | null = null

function note(frequency: number, start: number, duration: number, volume: number) {
  if (!ctx) return
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.value = frequency

  // soft attack + exponential decay = gentle "ping", no clicks
  const t = ctx.currentTime + start
  gain.gain.setValueAtTime(0.0001, t)
  gain.gain.exponentialRampToValueAtTime(volume, t + 0.015)
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration)

  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start(t)
  osc.stop(t + duration + 0.05)
}

/** Soft two-note completion chime, synthesized (no audio assets). */
export function useChime() {
  const enabled = useState('chime-enabled', () => true)

  onMounted(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved !== null) enabled.value = saved !== 'off'
  })

  function toggle() {
    enabled.value = !enabled.value
    localStorage.setItem(STORAGE_KEY, enabled.value ? 'on' : 'off')
    if (enabled.value) play() // preview
  }

  function play() {
    if (!enabled.value || !import.meta.client) return
    try {
      ctx ||= new AudioContext()
      if (ctx.state === 'suspended') ctx.resume()
      // E5 -> A5: soft, short, pleasant
      note(659.25, 0, 0.35, 0.12)
      note(880.0, 0.12, 0.5, 0.1)
      // faint octave shimmer under the second note
      note(1760.0, 0.12, 0.3, 0.025)
    } catch {
      // audio blocked or unsupported; stay silent
    }
  }

  return { enabled, toggle, play }
}
