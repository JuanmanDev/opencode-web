// Tool discovery for **local (stdio) MCP servers**.
//
// opencode does not expose MCP tool ids anywhere in its API (`/experimental/tool`
// and `/experimental/tool/ids` only list built-in and plugin tools), so the tool
// list of every server has to be discovered by this app itself. Remote servers
// are queried over HTTP (see mcp-tools.get.ts); local ones are spawned here and
// spoken to over stdio with newline-delimited JSON-RPC, exactly like opencode
// does internally.

import { spawn } from 'node:child_process'
import process from 'node:process'
import { toToolInfo, type McpToolInfo } from './mcp-client'

export type StdioTool = McpToolInfo

const IS_WINDOWS = process.platform === 'win32'

/** shell:true is required on Windows for `npx`/`.cmd` shims — quote accordingly. */
function quote(arg: string) {
  return IS_WINDOWS && /\s/.test(arg) ? `"${arg}"` : arg
}

/** Kill the whole process tree: `npx` spawns the real server as a child. */
function killTree(pid: number | undefined) {
  if (!pid) return
  if (IS_WINDOWS) {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      return
    } catch { /* fall through to plain kill */ }
  }
  try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
}

/**
 * Spawn a local MCP server, run initialize + tools/list, then kill it.
 * Resolves with the tool list or throws with a short reason.
 */
export function fetchToolsStdio(
  command: string[],
  environment?: Record<string, string>,
  timeoutMs = 25000
): Promise<StdioTool[]> {
  const [bin, ...args] = command
  if (!bin) return Promise.reject(new Error('empty command'))

  return new Promise<StdioTool[]>((resolve, reject) => {
    // Windows needs a shell for `npx`/`.cmd` shims; passing one pre-quoted
    // command line (instead of argv) keeps node from warning about DEP0190
    const child = IS_WINDOWS
      ? spawn([bin, ...args].map(quote).join(' '), {
          shell: true,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ...(environment || {}) }
        })
      : spawn(bin, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ...(environment || {}) }
        })

    let settled = false
    let stdout = ''
    let stderr = ''
    const pending = new Map<number, (msg: any) => void>()

    const done = (error: Error | null, tools?: StdioTool[]) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      killTree(child.pid)
      if (error) reject(error)
      else resolve(tools || [])
    }

    const timer = setTimeout(
      () => done(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`)),
      timeoutMs
    )

    const send = (msg: Record<string, unknown>) => {
      try { child.stdin.write(`${JSON.stringify(msg)}\n`) } catch { /* dead pipe */ }
    }

    const call = (id: number, method: string, params: Record<string, unknown>) =>
      new Promise<any>((ok) => {
        pending.set(id, ok)
        send({ jsonrpc: '2.0', id, method, params })
      })

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      // newline-delimited JSON-RPC: keep the trailing partial line buffered
      let idx: number
      while ((idx = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, idx).trim()
        stdout = stdout.slice(idx + 1)
        if (!line.startsWith('{')) continue // servers often log plain text to stdout
        try {
          const msg = JSON.parse(line)
          const resolvePending = msg?.id != null ? pending.get(msg.id) : undefined
          if (resolvePending) {
            pending.delete(msg.id)
            resolvePending(msg)
          }
        } catch { /* not a JSON-RPC frame */ }
      }
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-500) })

    child.on('error', (error) =>
      done(new Error(`spawn failed: ${error instanceof Error ? error.message : error}`))
    )
    child.on('exit', (code) =>
      done(new Error(`exited (${code})${stderr.trim() ? `: ${stderr.trim().split('\n').pop()}` : ''}`))
    )

    ;(async () => {
      try {
        const init = await call(1, 'initialize', {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'opencode-web', version: '1' }
        })
        if (init?.error) throw new Error(init.error.message || 'initialize failed')
        send({ jsonrpc: '2.0', method: 'notifications/initialized' })

        const list = await call(2, 'tools/list', {})
        if (list?.error) throw new Error(list.error.message || 'tools/list failed')
        const tools = Array.isArray(list?.result?.tools) ? list.result.tools : []
        done(null, tools.map(toToolInfo).filter((t: StdioTool) => t.name))
      } catch (error) {
        done(error instanceof Error ? error : new Error(String(error)))
      }
    })()
  })
}
