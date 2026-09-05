import { describe, expect, it } from 'vitest'
import { decodeDir, dirName, encodeDir } from '~/composables/useDirectory'

describe('encodeDir / decodeDir', () => {
  const cases = [
    '/',
    '/projects/my-app',
    '/docker/facturador',
    'C:\\code\\opencode-juanma',
    'C:\\Users\\Juan Manuel\\proyectos españoles',
    '/path/with spaces/and+plus/and_underscore',
    '/emoji/🚀/folder'
  ]

  for (const path of cases) {
    it(`roundtrips ${JSON.stringify(path)}`, () => {
      const encoded = encodeDir(path)
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/) // URL-safe, no padding
      expect(decodeDir(encoded)).toBe(path)
    })
  }

  it('returns "" instead of throwing on malformed params', () => {
    expect(decodeDir('')).toBe('')
    expect(decodeDir('C%3Acodeopencode-juanma')).toBe('')
    expect(decodeDir('not base64!')).toBe('')
    expect(decodeDir('%%%')).toBe('')
    expect(decodeDir(undefined as unknown as string)).toBe('')
  })
})

describe('dirName', () => {
  it('returns the last segment of a unix path', () => {
    expect(dirName('/projects/my-app')).toBe('my-app')
  })
  it('returns the last segment of a windows path', () => {
    expect(dirName('C:\\code\\opencode-juanma')).toBe('opencode-juanma')
  })
  it('ignores trailing slashes', () => {
    expect(dirName('/projects/my-app/')).toBe('my-app')
  })
  it('handles the root path', () => {
    expect(dirName('/')).toBe('/')
  })
})
