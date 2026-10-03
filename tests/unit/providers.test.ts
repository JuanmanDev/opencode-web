import { describe, expect, it } from 'vitest'
import { redactSecrets } from '../../server/utils/providers'

describe('redactSecrets', () => {
  it('strips provider keys, MCP headers and environment secrets at any depth', () => {
    const config = {
      model: 'litellm/opencode',
      provider: { litellm: { options: { baseURL: 'http://x/v1', apiKey: 'sk-1' }, models: { a: { name: 'A', limit: { context: 1 } } } } },
      mcp: {
        hotel: { type: 'remote', url: 'https://h/mcp', headers: { Authorization: 'Bearer t', 'x-api-key': 'k' } },
        n8n: { type: 'local', command: ['npx', 'n8n'], environment: { N8N_API_URL: 'https://n', N8N_API_KEY: 'k', GITHUB_TOKEN: 'g' } }
      },
      providers: [{ id: 'anthropic', key: 'sk-ant', name: 'Anthropic' }]
    }
    const out = redactSecrets(config)
    expect(out.provider.litellm.options).toEqual({ baseURL: 'http://x/v1', apiKey: '***' })
    expect(out.provider.litellm.models.a).toEqual({ name: 'A', limit: { context: 1 } })
    expect(out.mcp.hotel.headers).toEqual({ Authorization: '***', 'x-api-key': '***' })
    expect(out.mcp.n8n.environment).toEqual({ N8N_API_URL: 'https://n', N8N_API_KEY: '***', GITHUB_TOKEN: '***' })
    expect(out.mcp.n8n.command).toEqual(['npx', 'n8n'])
    expect(out.providers[0]).toEqual({ id: 'anthropic', key: '***', name: 'Anthropic' })
    // input untouched
    expect(config.provider.litellm.options.apiKey).toBe('sk-1')
  })
})
