import { describe, expect, it } from 'vitest'
import { agentName, generatedSummary, toolNamespace } from '../../server/utils/mcp-nest'

describe('MCP subagents', () => {
  it('names agents and tool namespaces the way opencode prefixes MCP tools', () => {
    expect(toolNamespace('home-assistant')).toBe('home-assistant')
    expect(toolNamespace('my.server v2')).toBe('my_server_v2')
    expect(agentName('Home.Assistant')).toBe('mcp-home_assistant')
  })

  it('summarizes a server from its tools for the orchestrator', () => {
    const summary = generatedSummary('home-assistant', [
      { name: 'HassTurnOn', description: 'Turns on a device or entity.' },
      { name: 'HassTurnOff', description: 'Turns off a device or entity' },
      { name: 'GetLiveContext' }
    ])
    expect(summary).toBe('Specialist for the home-assistant MCP server: send it any task that needs home-assistant. '
      + 'Tools: HassTurnOn (Turns on a device or entity); HassTurnOff (Turns off a device or entity); and 1 more.')
    expect(generatedSummary('x', [])).toBe('Specialist for the x MCP server.')
    expect(generatedSummary('x', [{ name: 'a' }, { name: 'b' }])).toContain('Tools: a, b.')
  })
})
