// Demo state: projects, sessions, messages, files and settings of the
// in-browser opencode stand-in. Seeded with realistic content and kept in
// localStorage so a visitor's chats survive reloads.

export type Json = any

export interface DemoSession {
  id: string
  title: string
  directory: string
  parentID?: string
  agent?: string
  version: string
  time: { created: number; updated: number }
}

export interface DemoMessage { info: Json; parts: Json[] }

export interface DemoState {
  version: number
  counter: number
  projects: Array<{ id: string; worktree: string; vcs?: string; time: { created: number; updated: number } }>
  sessions: DemoSession[]
  messages: Record<string, DemoMessage[]>
  todos: Record<string, Json[]>
  diffs: Record<string, Array<{ file: string; patch: string; additions: number; deletions: number }>>
  /** project folder -> relative path -> content */
  files: Record<string, Record<string, string>>
  globalConfig: Json
  projectConfig: Record<string, Json>
  schedules: Json[]
  meta: Json
  presets: Record<string, Json>
  directories: { recents: Array<{ directory: string; lastOpened: number }>; hidden: string[] }
  nest: Json
  control: { installed: boolean; enabled: boolean }
}

const KEY = 'opencode-web.demo-state'
const VERSION = 3

export const SPACE = '/projects/space-invaders'
export const HOME = '/projects/home-dashboard'

const FILES: Record<string, Record<string, string>> = {
  [SPACE]: {
    'README.md': `# Space Invaders

A tiny canvas remake of the arcade classic.

## Controls

| key | action |
| --- | --- |
| ← → | move |
| Enter | fire |

## Scripts

- \`npm run dev\` — start the dev server
- \`npm test\` — run the unit tests
`,
    'package.json': `{
  "name": "space-invaders",
  "private": true,
  "type": "module",
  "scripts": { "dev": "vite", "build": "vite build", "test": "vitest run" },
  "devDependencies": { "vite": "^7.0.0", "vitest": "^5.0.0", "typescript": "^5.9.0" }
}
`,
    'src/main.ts': `import { createGame } from './game/loop'
import { bindInput } from './input'

const canvas = document.querySelector<HTMLCanvasElement>('#game')!
const game = createGame(canvas)
bindInput(game)
game.start()
`,
    'src/input.ts': `import type { Game } from './game/loop'

export function bindInput(game: Game) {
  addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') game.player.dx = -1
    if (e.key === 'ArrowRight') game.player.dx = 1
    if (e.key === ' ') game.fire()
    if (e.key === 'p') game.togglePause()
  })
  addEventListener('keyup', () => { game.player.dx = 0 })
}
`,
    'src/game/loop.ts': `import { collides } from './collision'
import { ShieldPowerUp } from './powerups'

export interface Game {
  player: { x: number; dx: number; shield: ShieldPowerUp | null }
  start(): void
  fire(): void
  togglePause(): void
}

export function createGame(canvas: HTMLCanvasElement): Game {
  const ctx = canvas.getContext('2d')!
  const state = { paused: false, invaders: spawnInvaders(), bullets: [] as Array<{ x: number; y: number }> }
  const player = { x: canvas.width / 2, dx: 0, shield: null as ShieldPowerUp | null }

  function tick() {
    if (!state.paused) {
      player.x += player.dx * 4
      // TODO: clamp the player inside the canvas
      for (const b of state.bullets) b.y -= 6
      state.invaders = state.invaders.filter((inv) => !state.bullets.some((b) => collides(b, inv)))
      player.shield?.tick()
    }
    draw(ctx, player, state)
    requestAnimationFrame(tick)
  }

  return {
    player,
    start: () => requestAnimationFrame(tick),
    fire: () => state.bullets.push({ x: player.x, y: canvas.height - 30 }),
    togglePause: () => { state.paused = !state.paused }
  }
}

function spawnInvaders() {
  return Array.from({ length: 24 }, (_, i) => ({ x: 40 + (i % 8) * 50, y: 40 + Math.floor(i / 8) * 40, w: 32, h: 24 }))
}

function draw(ctx: CanvasRenderingContext2D, player: Game['player'], state: { invaders: Array<{ x: number; y: number; w: number; h: number }> }) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  ctx.fillStyle = '#4ade80'
  ctx.fillRect(player.x - 16, ctx.canvas.height - 20, 32, 12)
  ctx.fillStyle = '#f87171'
  for (const inv of state.invaders) ctx.fillRect(inv.x, inv.y, inv.w, inv.h)
}
`,
    'src/game/collision.ts': `export interface Box { x: number; y: number; w?: number; h?: number }

/** Axis-aligned overlap test; points have no size. */
export function collides(a: Box, b: Box) {
  const aw = a.w ?? 0
  const ah = a.h ?? 0
  const bw = b.w ?? 0
  const bh = b.h ?? 0
  // FIXME: touching edges should count as a hit
  return a.x < b.x + bw && a.x + aw > b.x && a.y < b.y + bh && a.y + ah > b.y
}
`,
    'src/game/powerups.ts': `/** Shield that lasts 300 frames (5 s at 60 fps) and blinks in its last second. */
export class ShieldPowerUp {
  frames = 300
  active = true
  get blinking() { return this.frames < 60 }
  tick() {
    if (!this.active) return
    this.frames -= 1
    if (this.frames <= 0) this.active = false
  }
}
`,
    'tests/collision.test.ts': `import { describe, expect, it } from 'vitest'
import { collides } from '../src/game/collision'

describe('collides', () => {
  it('detects overlapping boxes', () => {
    expect(collides({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toBe(true)
  })
  it('ignores distant boxes', () => {
    expect(collides({ x: 0, y: 0, w: 10, h: 10 }, { x: 50, y: 50, w: 10, h: 10 })).toBe(false)
  })
})
`
  },
  [HOME]: {
    'README.md': `# Home dashboard

Vue 3 dashboard for the house: thermostat, lights and energy use, fed by Home Assistant.

\`npm run dev\` starts it on :5173.
`,
    'package.json': `{
  "name": "home-dashboard",
  "private": true,
  "scripts": { "dev": "vite", "build": "vite build", "test": "vitest run" },
  "dependencies": { "vue": "^3.5.0" }
}
`,
    'src/App.vue': `<script setup lang="ts">
import Thermostat from './components/Thermostat.vue'
import EnergyChart from './components/EnergyChart.vue'
</script>

<template>
  <main class="grid">
    <Thermostat room="Living room" />
    <EnergyChart />
  </main>
</template>
`,
    'src/components/Thermostat.vue': `<script setup lang="ts">
const props = defineProps<{ room: string }>()
const target = ref(21)
</script>

<template>
  <section class="card">
    <h2>{{ props.room }}</h2>
    <button @click="target--">−</button>
    <strong>{{ target }} °C</strong>
    <button @click="target++">+</button>
  </section>
</template>
`,
    'src/components/EnergyChart.vue': `<script setup lang="ts">
const usage = [3.2, 2.9, 4.1, 3.8, 5.0, 4.4, 3.6]
</script>

<template>
  <section class="card">
    <h2>Energy this week</h2>
    <svg viewBox="0 0 70 30"><polyline :points="usage.map((v, i) => \`\${i * 10},\${30 - v * 5}\`).join(' ')" fill="none" stroke="currentColor" /></svg>
  </section>
</template>
`
  }
}

function seed(): DemoState {
  const now = Date.now()
  const s1 = 'ses_demo_powerups'
  const s2 = 'ses_demo_widgets'
  const s3 = 'ses_demo_audit'
  const c3 = 'ses_demo_audit_child'
  const h1 = 'ses_demo_darkmode'
  const ai = (id: string, sid: string, created: number, cost = 0.0123, extra: Json = {}) => ({
    id, sessionID: sid, role: 'assistant', time: { created, completed: created + 42000 },
    modelID: 'demo-model', providerID: 'demo', agent: 'build', mode: 'build', cost,
    tokens: { input: 4200, output: 610, reasoning: 220, cache: { read: 0, write: 0 } }, ...extra
  })
  const user = (id: string, sid: string, created: number, text: string) => ({
    info: { id, sessionID: sid, role: 'user', time: { created } },
    parts: [{ id: `${id}_t`, messageID: id, sessionID: sid, type: 'text', text }]
  })
  const done = (start: number, input: Json, output: string, title: string, metadata: Json = {}) =>
    ({ status: 'completed', input, output, title, metadata, time: { start, end: start + 900 } })

  const messages: Record<string, DemoMessage[]> = {
    [s1]: [
      user('msg_0001', s1, now - 7200000, 'Add a shield power-up that lasts 5 seconds and blinks before expiring.'),
      {
        info: ai('msg_0002', s1, now - 7190000, 0.0231),
        parts: [
          { id: 'prt_0002a', messageID: 'msg_0002', sessionID: s1, type: 'reasoning', text: 'The loop ticks at 60 fps, so 5 seconds is 300 frames. Blinking should start in the last second (60 frames).', time: { start: now - 7189000, end: now - 7186000 } },
          { id: 'prt_0002b', messageID: 'msg_0002', sessionID: s1, type: 'tool', callID: 'c1', tool: 'read', state: done(now - 7185000, { filePath: 'src/game/loop.ts' }, FILES[SPACE]!['src/game/loop.ts']!.slice(0, 600), 'src/game/loop.ts') },
          { id: 'prt_0002c', messageID: 'msg_0002', sessionID: s1, type: 'tool', callID: 'c2', tool: 'write', state: done(now - 7180000, { filePath: 'src/game/powerups.ts' }, 'Wrote file successfully.', 'src/game/powerups.ts') },
          { id: 'prt_0002d', messageID: 'msg_0002', sessionID: s1, type: 'text', text: 'Added the **shield power-up**:\n\n- `ShieldPowerUp` lasts 300 frames (5 s at 60 fps)\n- it blinks during its final second (`blinking` getter)\n- `tick()` runs from the game loop while the shield is active\n\n```ts\nexport class ShieldPowerUp {\n  frames = 300\n  get blinking() { return this.frames < 60 }\n}\n```' },
          { id: 'prt_0002e', messageID: 'msg_0002', sessionID: s1, type: 'step-finish', cost: 0.0231, tokens: { input: 5400, output: 820 } }
        ]
      }
    ],
    [s2]: [
      user('msg_0003', s2, now - 5000000, 'Show me the revenue metric and the weather in Salamanca.'),
      {
        info: ai('msg_0004', s2, now - 4990000, 0.011),
        parts: [
          { id: 'prt_0004a', messageID: 'msg_0004', sessionID: s2, type: 'tool', callID: 'c3', tool: 'ui-demo_show_metric', state: done(now - 4989000, { label: 'Revenue', value: '42', unit: 'k€', change: 12.5 }, 'Revenue: 42k€ (12.5%)', 'Revenue') },
          { id: 'prt_0004b', messageID: 'msg_0004', sessionID: s2, type: 'tool', callID: 'c4', tool: 'ui-demo_show_weather', state: done(now - 4987000, { location: 'Salamanca', temperature: 24, condition: 'sunny' }, 'Salamanca: 24°C, sunny', 'Salamanca') },
          { id: 'prt_0004c', messageID: 'msg_0004', sessionID: s2, type: 'text', text: 'Here are both widgets: they come from the `ui-demo` MCP server and render live in the chat. Open one fullscreen or in the side panel from its toolbar.' }
        ]
      }
    ],
    [s3]: [
      user('msg_0005', s3, now - 3600000, 'Have a subagent check that the README matches the controls, then summarize.'),
      {
        info: ai('msg_0006', s3, now - 3590000, 0.018),
        parts: [
          { id: 'prt_0006a', messageID: 'msg_0006', sessionID: s3, type: 'tool', callID: 'c5', tool: 'task', state: done(now - 3580000, { description: 'Check the README', prompt: 'Compare README.md with src/input.ts and list every control that is missing or wrong.', subagent_type: 'general' }, `<task id="${c3}" state="completed">\n<task_result>\n- Fire is \`Space\` in src/input.ts, the README says \`Enter\`\n- Pause (\`P\`) is not documented\n</task_result>\n</task>`, 'Check the README', { parentSessionId: s3, sessionId: c3 }) },
          { id: 'prt_0006b', messageID: 'msg_0006', sessionID: s3, type: 'text', text: 'The subagent found **2 mismatches**: the fire key is `Space` (the README says `Enter`) and pause (`P`) is undocumented. Want me to fix the README?' }
        ]
      }
    ],
    [c3]: [
      user('msg_0007', c3, now - 3579000, 'Compare README.md with src/input.ts and list every control that is missing or wrong.'),
      {
        info: ai('msg_0008', c3, now - 3578000, 0.004, { agent: 'general' }),
        parts: [
          { id: 'prt_0008a', messageID: 'msg_0008', sessionID: c3, type: 'tool', callID: 'c6', tool: 'read', state: done(now - 3577000, { filePath: 'README.md' }, FILES[SPACE]!['README.md']!, 'README.md') },
          { id: 'prt_0008b', messageID: 'msg_0008', sessionID: c3, type: 'tool', callID: 'c7', tool: 'read', state: done(now - 3576000, { filePath: 'src/input.ts' }, FILES[SPACE]!['src/input.ts']!, 'src/input.ts') },
          { id: 'prt_0008c', messageID: 'msg_0008', sessionID: c3, type: 'text', text: '- Fire is `Space` in src/input.ts, the README says `Enter`\n- Pause (`P`) is not documented' }
        ]
      }
    ],
    [h1]: [
      user('msg_0009', h1, now - 86400000, 'Add a dark mode toggle to the dashboard header.'),
      {
        info: ai('msg_0010', h1, now - 86390000, 0.009),
        parts: [
          { id: 'prt_0010a', messageID: 'msg_0010', sessionID: h1, type: 'tool', callID: 'c8', tool: 'read', state: done(now - 86389000, { filePath: 'src/App.vue' }, FILES[HOME]!['src/App.vue']!, 'src/App.vue') },
          { id: 'prt_0010b', messageID: 'msg_0010', sessionID: h1, type: 'text', text: 'Added a `useDark()` toggle in the header that stores the choice in `localStorage` and sets `class="dark"` on `<html>`.' }
        ]
      }
    ]
  }

  return {
    version: VERSION,
    counter: 100,
    projects: [
      { id: 'prj_space', worktree: SPACE, vcs: 'git', time: { created: now - 86400000 * 3, updated: now } },
      { id: 'prj_home', worktree: HOME, vcs: 'git', time: { created: now - 86400000 * 9, updated: now - 86400000 } }
    ],
    sessions: [
      { id: s1, title: 'Add power-ups to the game loop', directory: SPACE, version: 'demo', time: { created: now - 7200000, updated: now - 7150000 } },
      { id: s2, title: 'MCP UI widgets', directory: SPACE, version: 'demo', time: { created: now - 5000000, updated: now - 4980000 } },
      { id: s3, title: 'Audit the docs with a subagent', directory: SPACE, version: 'demo', time: { created: now - 3600000, updated: now - 3380000 } },
      { id: c3, title: 'Check the README (@general subagent)', directory: SPACE, parentID: s3, agent: 'general', version: 'demo', time: { created: now - 3579000, updated: now - 3500000 } },
      { id: h1, title: 'Dark mode toggle', directory: HOME, version: 'demo', time: { created: now - 86400000, updated: now - 86380000 } }
    ],
    messages,
    todos: {},
    diffs: {},
    files: JSON.parse(JSON.stringify(FILES)),
    globalConfig: {
      $schema: 'https://opencode.ai/config.json',
      model: 'demo/demo-model',
      mcp: {
        context7: { type: 'remote', url: 'https://mcp.context7.com/mcp', enabled: true },
        'ui-demo': { type: 'remote', url: 'http://web:3000/mcp-demo', enabled: true },
        playwright: { type: 'local', command: ['npx', '-y', '@playwright/mcp@latest'], enabled: true },
        'home-assistant': { type: 'remote', url: 'https://homeassistant.local:8123/api/mcp', enabled: false, oauth: false, headers: { Authorization: '***' } }
      },
      permission: { bash: 'ask' }
    },
    projectConfig: {},
    schedules: [],
    meta: {},
    presets: {},
    directories: { recents: [], hidden: [] },
    nest: { enabled: false, orchestrator: 'orchestrator', exclude: [], summaries: {} },
    control: { installed: false, enabled: false }
  }
}

/** Runs that were cut by a reload can't continue: close them. */
function settle(state: DemoState) {
  for (const list of Object.values(state.messages)) {
    for (const m of list) {
      if (m.info.role === 'assistant' && !m.info.time?.completed) {
        m.info.time = { ...m.info.time, completed: Date.now() }
        m.info.error = { name: 'MessageAbortedError', data: { message: 'Interrupted: the page was reloaded during the reply' } }
        for (const p of m.parts) {
          if (p.type === 'tool' && (p.state?.status === 'running' || p.state?.status === 'pending')) {
            p.state = { status: 'error', input: p.state.input || {}, error: 'Interrupted', time: { start: Date.now(), end: Date.now() } }
          }
        }
      }
    }
  }
  return state
}

export function loadState(): DemoState {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as DemoState
      if (parsed?.version === VERSION) return settle(parsed)
    }
  } catch { /* corrupt or blocked: start over */ }
  return seed()
}

let timer: ReturnType<typeof setTimeout> | undefined
let frozen = false
let pending: DemoState | undefined

function flush() {
  clearTimeout(timer)
  if (frozen || !pending) return
  try { localStorage.setItem(KEY, JSON.stringify(pending)) } catch { /* full or private mode */ }
  pending = undefined
}

// a reload or a closed tab must not lose the last 250 ms of a reply
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flush)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush() })
}

export function persist(state: DemoState) {
  if (frozen) return
  pending = state
  clearTimeout(timer)
  timer = setTimeout(flush, 250)
}

export function resetState() {
  frozen = true
  clearTimeout(timer)
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('opencode-web.')) localStorage.removeItem(key)
    }
  } catch { /* blocked */ }
}
