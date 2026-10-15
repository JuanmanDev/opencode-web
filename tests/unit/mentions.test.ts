import { describe, expect, it } from 'vitest'
import { agentMatches, applyMention, mentionAt, mentionParts, toFileUrl } from '../../app/composables/useMentions'
import { findToLegacy } from '../../server/utils/compat/v2/mappers'

describe('@ mentions', () => {
  it('finds the @token under the caret only at a word start', () => {
    expect(mentionAt('look at @src/ga', 15)).toEqual({ start: 8, end: 15, query: 'src/ga' })
    expect(mentionAt('@', 1)).toEqual({ start: 0, end: 1, query: '' })
    expect(mentionAt('mail me@example.com', 19)).toBeNull()
    expect(mentionAt('plain words', 5)).toBeNull()
    // caret in the middle of a token: the query is what precedes it
    expect(mentionAt('@readme now', 3)).toEqual({ start: 0, end: 7, query: 're' })
  })

  it('replaces the token and puts the caret after it', () => {
    expect(applyMention('fix @lo please', { start: 4, end: 7, query: 'lo' }, 'src/game/loop.ts'))
      .toEqual({ text: 'fix @src/game/loop.ts please', caret: 22 })
    expect(applyMention('@ge', { start: 0, end: 3, query: 'ge' }, 'general')).toEqual({ text: '@general ', caret: 9 })
  })

  it('builds file:// URLs from POSIX and Windows project folders', () => {
    expect(toFileUrl('/projects/app', 'src/a b.ts')).toBe('file:///projects/app/src/a%20b.ts')
    expect(toFileUrl('C:\\work\\app\\', 'src\\x.ts')).toBe('file:///C:/work/app/src/x.ts')
    expect(toFileUrl('/p', 'weird#name?.md')).toBe('file:///p/weird%23name%3F.md')
  })

  it('lists subagents (not primary agents), prefix matches first', () => {
    const agents = [
      { name: 'build', mode: 'primary' },
      { name: 'general', mode: 'subagent', description: 'General purpose' },
      { name: 'explore', mode: 'subagent' },
      { name: 'reviewer', mode: 'all' }
    ]
    expect(agentMatches(agents, '').map((a) => a.value)).toEqual(['explore', 'general', 'reviewer'])
    expect(agentMatches(agents, 'e').map((a) => a.value)).toEqual(['explore', 'general', 'reviewer'])
    expect(agentMatches(agents, 'gen')).toEqual([{ kind: 'agent', value: 'general', label: 'general', detail: 'General purpose' }])
  })

  it('turns the mentions still in the text into opencode parts', () => {
    const text = 'compare @src/game/loop.ts with @src/ and ask @general'
    const parts = mentionParts(text, [
      { kind: 'file', value: 'src/game/loop.ts' },
      { kind: 'folder', value: 'src/' },
      { kind: 'agent', value: 'general' },
      { kind: 'file', value: 'gone.ts' }
    ], '/projects/app')
    expect(parts).toEqual([
      {
        type: 'file',
        mime: 'text/plain',
        filename: 'loop.ts',
        url: 'file:///projects/app/src/game/loop.ts',
        source: { type: 'file', path: 'src/game/loop.ts', text: { value: '@src/game/loop.ts', start: 8, end: 25 } }
      },
      {
        type: 'file',
        mime: 'application/x-directory',
        filename: 'src',
        url: 'file:///projects/app/src',
        source: { type: 'file', path: 'src', text: { value: '@src/', start: 31, end: 36 } }
      },
      { type: 'agent', name: 'general', source: { value: '@general', start: 45, end: 53 } }
    ])
  })

  it('maps the v2 fs/find answer to 1.x /find/file paths', () => {
    expect(findToLegacy([{ path: 'src', type: 'directory' }, { path: 'src\\a.ts', type: 'file' }, { type: 'file' }]))
      .toEqual(['src/', 'src/a.ts'])
  })
})
