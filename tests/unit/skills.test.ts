import { describe, expect, it } from 'vitest'
import { buildSkillMd, catalogIndex, lintSkill, parseSkillMd, skillPermission } from '../../server/utils/skills'

const GOOD = buildSkillMd(
  'release-notes',
  'Use when the user asks for release notes or a changelog entry: summarizes the git log since the last tag.',
  ['# Release notes', '', ...Array.from({ length: 12 }, (_, i) => `${i + 1}. Step number ${i + 1} of writing good release notes for users.`)].join('\n')
)

describe('skills', () => {
  it('reads and writes SKILL.md frontmatter', () => {
    const parsed = parseSkillMd(GOOD)
    expect(parsed.name).toBe('release-notes')
    expect(parsed.description).toMatch(/^Use when/)
    expect(parsed.body).toMatch(/^\s*# Release notes/)
    const folded = parseSkillMd('---\nname: x\ndescription: >\n  first line\n  second line\nlicense: "MIT"\n---\nbody')
    expect(folded.description).toBe('first line second line')
    expect(folded.meta).toEqual({ license: 'MIT' })
    expect(parseSkillMd('no frontmatter').hasFrontmatter).toBe(false)
  })

  it('checks opencode rules and gives advice', () => {
    expect(lintSkill(GOOD, 'release-notes')).toEqual([])
    const bad = lintSkill('---\nname: Release_Notes\n---\nshort', 'release-notes')
    expect(bad.filter((c) => c.level === 'error').map((c) => c.message).join(' ')).toMatch(/lowercase.*must match.*description is missing/s)
    expect(lintSkill(buildSkillMd('x', 'I help you do things with stuff and more', 'tiny')).map((c) => c.level)).toContain('tip')
  })

  it('applies the most specific permission rule', () => {
    expect(skillPermission(undefined, 'a')).toEqual({ mode: 'allow' })
    expect(skillPermission('deny', 'a')).toEqual({ mode: 'deny', rule: '*' })
    const rules = { '*': 'ask', 'internal-*': 'deny', 'internal-docs': 'allow' }
    expect(skillPermission(rules, 'internal-docs')).toEqual({ mode: 'allow', rule: 'internal-docs' })
    expect(skillPermission(rules, 'internal-tools')).toEqual({ mode: 'deny', rule: 'internal-*' })
    expect(skillPermission(rules, 'other')).toEqual({ mode: 'ask', rule: '*' })
  })

  it('serves the library in opencode\'s catalog format', () => {
    const index = catalogIndex({
      rev: 3,
      skills: {
        b: { name: 'b', description: 'B', files: { 'SKILL.md': '…', 'ref.md': '…' }, version: 2, updatedAt: 0 },
        a: { name: 'a', description: 'A', files: { 'SKILL.md': '…' }, version: 1, updatedAt: 0 }
      }
    })
    expect(index).toEqual({
      skills: [
        { name: 'a', description: 'A', version: '1', files: ['SKILL.md'] },
        { name: 'b', description: 'B', version: '2', files: ['SKILL.md', 'ref.md'] }
      ]
    })
  })
})
