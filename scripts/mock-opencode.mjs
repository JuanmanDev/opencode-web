// Tiny mock of the opencode server HTTP API.
// Used by e2e tests and the automatic screenshot job so CI needs no real
// opencode install, API keys, or network.
import { createServer } from 'node:http'

const PORT = Number(process.env.MOCK_PORT || 4517)

const now = Date.now()

const projects = [
  { id: 'p1', worktree: '/projects/space-invaders', vcs: 'git', time: { created: now - 86400000, updated: now } },
  { id: 'p2', worktree: '/projects/home-dashboard', vcs: 'git', time: { created: now - 172800000, updated: now - 3600000 } }
]

const sessions = [
  {
    id: 'ses_mock1',
    title: 'Add power-ups to the game loop',
    directory: '/projects/space-invaders',
    time: { created: now - 7200000, updated: now - 60000 },
    version: 'mock'
  },
  {
    id: 'ses_mock2',
    title: 'Fix collision detection edge case',
    directory: '/projects/space-invaders',
    time: { created: now - 86400000, updated: now - 43200000 },
    version: 'mock'
  }
]

const messages = [
  {
    info: { id: 'msg_u1', sessionID: 'ses_mock1', role: 'user', time: { created: now - 600000 } },
    parts: [
      { id: 'prt_u1', messageID: 'msg_u1', sessionID: 'ses_mock1', type: 'text', text: 'Add a shield power-up that lasts 5 seconds and blinks before expiring.' }
    ]
  },
  {
    info: {
      id: 'msg_a1', sessionID: 'ses_mock1', role: 'assistant',
      time: { created: now - 590000, completed: now - 540000 },
      modelID: 'claude-sonnet-5', providerID: 'anthropic', variant: 'high',
      cost: 0.0231, tokens: { input: 5400, output: 820, reasoning: 350 }
    },
    parts: [
      { id: 'prt_r1', messageID: 'msg_a1', sessionID: 'ses_mock1', type: 'reasoning', text: 'The game loop ticks at 60fps, so a 5 second shield is 300 frames. Blinking should start at 80% elapsed.', time: { start: now - 590000, end: now - 585000 } },
      { id: 'prt_t1', messageID: 'msg_a1', sessionID: 'ses_mock1', type: 'tool', callID: 'c1', tool: 'read',
        state: { status: 'completed', title: 'src/game/loop.ts', input: { filePath: 'src/game/loop.ts' }, output: 'export function tick(state: GameState) { /* … */ }', time: { start: now - 584000, end: now - 583000 }, metadata: {} } },
      { id: 'prt_t2', messageID: 'msg_a1', sessionID: 'ses_mock1', type: 'tool', callID: 'c2', tool: 'edit',
        state: { status: 'completed', title: 'src/game/powerups.ts', input: { filePath: 'src/game/powerups.ts' }, output: 'Added ShieldPowerUp with 300-frame duration and blink threshold at 240 frames.', time: { start: now - 582000, end: now - 580000 }, metadata: {} } },
      { id: 'prt_x1', messageID: 'msg_a1', sessionID: 'ses_mock1', type: 'text', text: 'Added the **shield power-up**:\n\n- `ShieldPowerUp` lasts 300 frames (5s at 60fps)\n- Blinks during the final second using the existing `blink()` helper\n- Spawns with a 4% chance per destroyed enemy\n\n```ts\nif (state.shield.active) {\n  state.shield.frames -= 1\n  if (state.shield.frames < 60) blink(state.shield)\n}\n```\n\nAll 24 tests pass.' },
      { id: 'prt_s1', messageID: 'msg_a1', sessionID: 'ses_mock1', type: 'step-finish', cost: 0.0231, tokens: { input: 5400, output: 820 } }
    ]
  }
]

const providers = {
  default: { anthropic: 'claude-sonnet-5' },
  providers: [
    {
      id: 'anthropic', name: 'Anthropic',
      models: {
        'claude-sonnet-5': { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', reasoning: true, cost: { input: 3, output: 15 }, limit: { context: 200000 } },
        'claude-haiku-4-5': { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', reasoning: false, cost: { input: 1, output: 5 }, limit: { context: 200000 } }
      }
    },
    {
      id: 'opencode', name: 'OpenCode Zen',
      models: {
        'big-pickle': { id: 'big-pickle', name: 'Big Pickle', reasoning: true, cost: { input: 0, output: 0 }, limit: { context: 128000 } }
      }
    }
  ]
}

const agents = [
  { name: 'build', description: 'Default agent', mode: 'primary', builtIn: true },
  { name: 'plan', description: 'Read-only planning', mode: 'primary', builtIn: true }
]

const mcp = {
  context7: { status: 'connected' },
  playwright: { status: 'connected' },
  'home-assistant': { status: 'disabled' }
}

const files = [
  { name: 'space-invaders', path: 'space-invaders/', absolute: '/projects/space-invaders', type: 'directory', ignored: false },
  { name: 'home-dashboard', path: 'home-dashboard/', absolute: '/projects/home-dashboard', type: 'directory', ignored: false }
]

function json(res, data, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(data))
}

createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const p = url.pathname

  if (p === '/event') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.write(`data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`)
    const iv = setInterval(() => res.write(': keepalive\n\n'), 15000)
    req.on('close', () => clearInterval(iv))
    return
  }

  if (p === '/project') return json(res, projects)
  if (p === '/config/providers') return json(res, providers)
  if (p === '/config') return json(res, { mcp: { context7: { type: 'remote', url: 'https://mcp.context7.com/mcp' }, playwright: { type: 'local', command: ['npx', '@playwright/mcp'] }, 'home-assistant': { type: 'remote', url: 'http://ha:8086/mcp', enabled: false } } })
  if (p === '/agent') return json(res, agents)
  if (p === '/mcp') return json(res, mcp)
  if (p === '/file') return json(res, files)

  if (p === '/session' && req.method === 'GET') return json(res, sessions)
  if (p === '/session' && req.method === 'POST') {
    const s = { id: `ses_new${Date.now()}`, title: 'New session', time: { created: Date.now(), updated: Date.now() } }
    sessions.unshift(s)
    return json(res, s)
  }

  const msgMatch = p.match(/^\/session\/([^/]+)\/message$/)
  if (msgMatch && req.method === 'GET') return json(res, msgMatch[1] === 'ses_mock1' ? messages : [])
  if (msgMatch && req.method === 'POST') return json(res, { info: {}, parts: [] })

  const sesMatch = p.match(/^\/session\/([^/]+)$/)
  if (sesMatch) {
    const found = sessions.find((s) => s.id === sesMatch[1])
    return json(res, found || sessions[0])
  }

  json(res, {})
}).listen(PORT, () => console.log(`mock opencode listening on :${PORT}`))
