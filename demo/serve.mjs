// Serve the built demo like GitHub Pages does: under /opencode-web/, with
// 404.html for unknown paths. `node demo/serve.mjs` -> http://127.0.0.1:3340/opencode-web/
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const PORT = Number(process.env.DEMO_PORT || 3340)
const BASE = process.env.DEMO_BASE_URL || '/opencode-web/'
const ROOT = path.resolve('node_modules/.cache/opencode-web-demo/public')
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.woff2': 'font/woff2' }

http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost')
  if (!url.pathname.startsWith(BASE)) {
    res.writeHead(url.pathname === '/' ? 302 : 404, url.pathname === '/' ? { location: BASE } : {})
    return res.end()
  }
  let file = path.join(ROOT, decodeURIComponent(url.pathname.slice(BASE.length)))
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end() }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html')
  let status = 200
  if (!fs.existsSync(file)) { file = path.join(ROOT, '404.html'); status = 404 }
  res.writeHead(status, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
}).listen(PORT, '127.0.0.1', () => console.log(`demo on http://127.0.0.1:${PORT}${BASE}`))
