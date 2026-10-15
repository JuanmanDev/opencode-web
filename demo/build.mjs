// Build the static demo (no server): `npm run build:demo`, output in
// node_modules/.cache/opencode-web-demo/public. DEMO_BASE_URL sets the path it is served under
// (default /opencode-web/, the GitHub Pages project URL).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const result = spawnSync('npx', ['nuxi', 'generate'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, DEMO: '1' }
})
if (result.status) process.exit(result.status)

// GitHub Pages: deep links (/opencode-web/p/…) are answered by 404.html,
// which must boot the app too; .nojekyll keeps the _nuxt folder
const out = path.resolve('node_modules/.cache/opencode-web-demo/public')
const index = path.join(out, '200.html')
const shell = fs.existsSync(index) ? index : path.join(out, 'index.html')
fs.copyFileSync(shell, path.join(out, '404.html'))
fs.writeFileSync(path.join(out, '.nojekyll'), '')
console.log(`[demo] built ${out}`)
