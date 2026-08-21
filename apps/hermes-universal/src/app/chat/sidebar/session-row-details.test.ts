/**
 * MJXHRM-452 — the extra lines a non-compact sidebar row shows.
 *
 * Pure and deterministic on purpose: this row re-renders constantly, so anything
 * reading a store or formatting a relative time would either churn or lie.
 * Everything below comes off the row itself.
 */

import { describe, expect, it } from 'vitest'

import type { SessionInfo } from '@/types/hermes'

import { sessionRowDetails } from './session-row-details'

const fmt = {
  messageCount: (count: number) => `${count} ${count === 1 ? 'message' : 'messages'}`,
  toolCallCount: (count: number) => `${count} ${count === 1 ? 'tool call' : 'tool calls'}`
}

const session = (patch: Partial<SessionInfo> = {}): SessionInfo =>
  ({
    git_branch: null,
    message_count: 0,
    model: null,
    preview: null,
    title: 'Titled',
    tool_call_count: 0,
    ...patch
  }) as SessionInfo

describe('sessionRowDetails metadata', () => {
  it('joins branch, model and non-zero counts in that order', () => {
    expect(
      sessionRowDetails(
        session({ git_branch: 'feature/menu', message_count: 3, model: 'anthropic/claude-x', tool_call_count: 1 }),
        fmt
      ).metadata
    ).toBe('feature/menu · claude-x · 3 messages · 1 tool call')
  })

  it('drops the provider prefix from the model', () => {
    // Every row of a profile carries the same prefix — it is pure noise on a
    // row this narrow.
    expect(sessionRowDetails(session({ model: 'openai/gpt-5-codex' }), fmt).metadata).toBe('gpt-5-codex')
  })

  it('omits zero counts rather than printing "0 messages"', () => {
    // Seeded to disagree with a naive join: both counts are present as fields.
    expect(sessionRowDetails(session({ message_count: 0, tool_call_count: 0 }), fmt).metadata).toBe('')
  })
})

describe('sessionRowDetails preview', () => {
  it('collapses whitespace so a multi-line prompt stays one line', () => {
    expect(sessionRowDetails(session({ preview: '  fix   the\n  parser  ' }), fmt).preview).toBe('fix the parser')
  })

  it('withholds the preview when the row has no title of its own', () => {
    // A titleless row ALREADY renders its preview as the title, so repeating it
    // underneath prints the same sentence twice.
    expect(sessionRowDetails(session({ preview: 'fix the parser', title: null }), fmt).preview).toBeNull()
    expect(sessionRowDetails(session({ preview: 'fix the parser', title: '   ' }), fmt).preview).toBeNull()
  })
})
