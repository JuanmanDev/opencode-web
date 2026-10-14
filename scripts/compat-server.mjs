// Real opencode server for the compat e2e suite (playwright.compat.config.ts):
// starts the mock model (scripts/mock-llm.mjs) and `opencode serve` of any
// published version in an isolated home, so nothing touches your own config.
//
//   OPENCODE_VERSION=1.18.34 node scripts/compat-server.mjs
//   OPENCODE_VERSION=2.0.29 node scripts/compat-server.mjs   # opencode 2.x (v2 API only)
//   OPENCODE_VERSION=2-latest ...                            # newest 2.x
//
// 1.x ships as `opencode-ai`, 2.x as `@opencode/cli`.
// The project directory the tests open is <tmp>/opencode-web-compat/work
// (COMPAT_ROOT overrides): outside any checkout on purpose, because opencode
// 2.x loads opencode.json from every folder above the project, which must
// never pick up (or receive writes meant for) someone's real config.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const VERSION = process.env.OPENCODE_VERSION || 'latest'
const IS_2X = /^2(\.|-latest$)/.test(VERSION)
const PACKAGE = IS_2X ? `@opencode/cli@${VERSION === '2-latest' ? 'latest' : VERSION}` : `opencode-ai@${VERSION}`
const PORT = Number(process.env.OPENCODE_PORT || 4810)
const LLM_PORT = Number(process.env.MOCK_LLM_PORT || 4811)
const PASSWORD = process.env.OPENCODE_SERVER_PASSWORD || 'compat-secret'
const root = path.resolve(process.env.COMPAT_ROOT || path.join(os.tmpdir(), 'opencode-web-compat'))

fs.rmSync(root, { recursive: true, force: true })
const dirs = Object.fromEntries(
  ['config', 'data', 'state', 'cache', 'home', 'work'].map((name) => [name, path.join(root, name)])
)
for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(path.join(dirs.work, 'README.md'), '# compat\n\nProject used by the compat e2e suite.\n')
fs.mkdirSync(path.join(dirs.config, 'opencode'), { recursive: true })
fs.writeFileSync(path.join(dirs.config, 'opencode', 'opencode.json'), JSON.stringify({
  $schema: 'https://opencode.ai/config.json',
  model: 'mock/mock-model',
  small_model: 'mock/mock-model',
  autoupdate: false,
  share: 'disabled',
  provider: {
    mock: {
      npm: '@ai-sdk/openai-compatible',
      name: 'Mock',
      options: { baseURL: `http://127.0.0.1:${LLM_PORT}/v1`, apiKey: 'sk-mock' },
      models: {
        'mock-model': { name: 'Mock Model', tool_call: true, reasoning: true, limit: { context: 100000, output: 4096 } }
      }
    }
  },
  permission: { bash: 'ask' }
}, null, 2))

const env = {
  ...process.env,
  XDG_CONFIG_HOME: dirs.config,
  XDG_DATA_HOME: dirs.data,
  XDG_STATE_HOME: dirs.state,
  XDG_CACHE_HOME: dirs.cache,
  HOME: dirs.home,
  USERPROFILE: dirs.home,
  OPENCODE_SERVER_PASSWORD: PASSWORD,
  OPENCODE_DISABLE_AUTOUPDATE: '1',
  MOCK_LLM_PORT: String(LLM_PORT),
  // the tests read which tools the model was offered
  MOCK_LLM_LOG: process.env.MOCK_LLM_LOG || path.join(root, 'mock-llm.log')
}
const isWindows = process.platform === 'win32'
const children = []
function run(cmd, args, opts) {
  const child = spawn(cmd, args, { stdio: 'inherit', shell: isWindows, ...opts })
  children.push(child)
  child.on('exit', (code) => {
    console.log(`[compat] ${cmd} exited (${code})`)
    shutdown(code || 0)
  })
  return child
}

let stopping = false
function shutdown(code) {
  if (stopping) return
  stopping = true
  for (const child of children) {
    if (child.exitCode !== null) continue
    if (isWindows) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else child.kill('SIGTERM')
  }
  setTimeout(() => process.exit(code), 500)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

console.log(`[compat] ${PACKAGE} on :${PORT}, mock model on :${LLM_PORT}, project ${dirs.work}`)
run(process.execPath, [path.resolve('scripts/mock-llm.mjs')], { env, shell: false })
run('npx', ['-y', PACKAGE, 'serve', '--port', String(PORT), '--hostname', '127.0.0.1'], { env, cwd: dirs.work })
