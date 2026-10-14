import { describe, expect, it } from 'vitest'
import { mcpErrorHint } from '#shared/utils/mcp-hints'
import { normalizeServerConfig, restoreSecrets, validateServerConfig } from '../../server/utils/mcp-admin'
import { toToolDetail } from '../../server/utils/mcp-client'
import { openStdio } from '../../server/utils/mcp-stdio'

describe('mcpErrorHint', () => {
  it('turns OAuth registration failures into the token fix (Home Assistant)', () => {
    const hint = mcpErrorHint('Incompatible auth server: does not support dynamic client registration', 'failed')
    expect(hint?.action).toBe('use-token')
    expect(hint?.fix).toMatch(/Authorization: Bearer/)
  })

  it('recognizes auth, path, spawn and network failures', () => {
    expect(mcpErrorHint('HTTP 401')?.action).toBe('use-token')
    expect(mcpErrorHint('HTTP 404; SSE fallback: HTTP 404')?.action).toBe('check-url')
    expect(mcpErrorHint('spawn npx ENOENT')?.action).toBe('check-command')
    expect(mcpErrorHint('MCP error -32001: Request timed out')?.action).toBe('raise-timeout')
    expect(mcpErrorHint('fetch failed: getaddrinfo ENOTFOUND ha.local')?.action).toBe('check-url')
    expect(mcpErrorHint(undefined, 'needs_auth')?.action).toBe('sign-in')
    expect(mcpErrorHint(undefined, 'connected')).toBeUndefined()
  })
})

describe('MCP config editing', () => {
  const stored = {
    type: 'remote',
    url: 'https://ha.example/api/mcp',
    headers: { Authorization: 'Bearer real-token', 'X-Keep': 'kept' },
    environment: { KEY: 'secret' }
  }

  it('keeps stored secrets for "***" placeholders and drops orphans', () => {
    const out = restoreSecrets({
      type: 'remote',
      url: 'https://ha.example/api/mcp',
      headers: { Authorization: '***', 'X-New': 'new', Ghost: '***' }
    }, stored)
    expect(out.headers).toEqual({ Authorization: 'Bearer real-token', 'X-New': 'new' })
  })

  it('a new value replaces the stored secret', () => {
    expect(restoreSecrets({ headers: { Authorization: 'Bearer fresh' } }, stored).headers).toEqual({ Authorization: 'Bearer fresh' })
  })

  it('normalizes to the keys opencode knows', () => {
    expect(normalizeServerConfig({ type: 'remote', url: ' https://x/mcp ', oauth: false, junk: 1 } as never))
      .toEqual({ type: 'remote', url: 'https://x/mcp', enabled: true, oauth: false })
    expect(normalizeServerConfig({ command: ['npx', '', '-y', 'pkg'], environment: {}, timeout: 60000, enabled: false }))
      .toEqual({ type: 'local', command: ['npx', '-y', 'pkg'], enabled: false, timeout: 60000 })
  })

  it('validates names, urls and commands', () => {
    expect(validateServerConfig('ok-name', { type: 'remote', url: 'https://x/mcp' })).toBeUndefined()
    expect(validateServerConfig('bad name', { type: 'remote', url: 'https://x/mcp' })).toMatch(/name/)
    expect(validateServerConfig('a', { type: 'remote', url: 'ftp://x' })).toMatch(/http/)
    expect(validateServerConfig('a', { type: 'local', command: [] })).toMatch(/command/)
  })
})

describe('toToolDetail', () => {
  it('keeps the full description and flattens parameters', () => {
    const tool = toToolDetail({
      name: 'turn_on',
      description: 'Turn on a light.\nSecond line with details.',
      annotations: { destructiveHint: true, title: 'Turn on' },
      inputSchema: {
        type: 'object',
        required: ['entity'],
        properties: {
          entity: { type: 'string', description: 'entity id' },
          brightness: { type: 'integer' },
          colors: { type: 'array', items: { type: 'string' } },
          mode: { enum: ['a', 'b'], type: 'string' },
          any: { anyOf: [{ type: 'string' }, { type: 'number' }] }
        }
      }
    })
    expect(tool.description).toBe('Turn on a light.')
    expect(tool.fullDescription).toContain('Second line')
    expect(tool.destructive).toBe(true)
    expect(tool.title).toBe('Turn on')
    expect(tool.params).toEqual([
      { name: 'entity', type: 'string', required: true, description: 'entity id' },
      { name: 'brightness', type: 'integer', required: false, description: undefined },
      { name: 'colors', type: 'string[]', required: false, description: undefined },
      { name: 'mode', type: 'string', required: false, description: undefined, enum: ['a', 'b'] },
      { name: 'any', type: 'string | number', required: false, description: undefined }
    ])
  })
})

describe('openStdio', () => {
  it('initializes a local server and lists its tools', async () => {
    const session = await openStdio(['node', 'scripts/mock-stdio-mcp.mjs'], {}, 15000)
    try {
      expect(session.transport).toBe('stdio')
      const list = await session.request('tools/list', {})
      expect(Array.isArray(list.tools)).toBe(true)
      expect(list.tools.length).toBeGreaterThan(0)
    } finally {
      session.close()
    }
  })

  it('rejects with the exit reason when the command dies', async () => {
    await expect(openStdio(['node', '-e', 'process.exit(3)'], {}, 15000)).rejects.toThrow(/exited/)
  })
})
