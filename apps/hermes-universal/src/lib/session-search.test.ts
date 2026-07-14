import { describe, expect, it } from 'vitest'

import type { SessionInfo } from '@/types/hermes'

import { sessionMatchesSearch } from './session-search'

const base: SessionInfo = {
  _lineage_root_id: null,
  ended_at: null,
  id: 'sess-abc',
  input_tokens: 0,
  is_active: false,
  last_active: 0,
  message_count: 3,
  model: null,
  output_tokens: 0,
  preview: 'Refactoring the auth flow',
  source: 'discord',
  started_at: 0,
  title: 'Login bug',
  tool_call_count: 0
}

describe('sessionMatchesSearch', () => {
  it('matches everything on an empty query', () => {
    expect(sessionMatchesSearch(base, '')).toBe(true)
    expect(sessionMatchesSearch(base, '   ')).toBe(true)
  })

  it('matches on title, preview, id, and source (case-insensitive)', () => {
    expect(sessionMatchesSearch(base, 'login')).toBe(true)
    expect(sessionMatchesSearch(base, 'AUTH')).toBe(true)
    expect(sessionMatchesSearch(base, 'sess-abc')).toBe(true)
    expect(sessionMatchesSearch(base, 'discord')).toBe(true)
  })

  it('does not match unrelated text', () => {
    expect(sessionMatchesSearch(base, 'kubernetes')).toBe(false)
  })
})
