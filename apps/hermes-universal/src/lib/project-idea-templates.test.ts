import { describe, expect, it } from 'vitest'

import { PROJECT_IDEA_TEMPLATES, randomIdeaTemplates } from './project-idea-templates'

describe('randomIdeaTemplates', () => {
  it('returns the requested count of distinct templates from the pool', () => {
    const picked = randomIdeaTemplates(6)
    expect(picked).toHaveLength(6)
    expect(new Set(picked.map(t => t.label)).size).toBe(6)

    for (const t of picked) {
      expect(PROJECT_IDEA_TEMPLATES).toContainEqual(t)
    }
  })

  it('caps at the pool size when asked for more', () => {
    expect(randomIdeaTemplates(999)).toHaveLength(PROJECT_IDEA_TEMPLATES.length)
  })

  it('defaults to 6', () => {
    expect(randomIdeaTemplates()).toHaveLength(6)
  })
})
