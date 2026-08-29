// Minimal local (stdio) MCP server used by the mock opencode setup, so tool
// discovery over stdio is testable offline. Speaks newline-delimited JSON-RPC.
import process from 'node:process'

const TOOLS = [
  { name: 'navigate', description: 'Open a URL in the browser' },
  { name: 'click', description: 'Click an element' },
  { name: 'screenshot', description: 'Capture the page' }
]

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let idx
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim()
    buffer = buffer.slice(idx + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.id == null) continue // notification
    const result = msg.method === 'initialize'
      ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mock-stdio', version: '1' } }
      : msg.method === 'tools/list'
        ? { tools: TOOLS }
        : {}
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`)
  }
})
