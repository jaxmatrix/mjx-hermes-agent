/**
 * The client's reasoning vocabulary, and the two config surfaces that used to
 * re-type it.
 *
 * The list existed three times — the model submenu, the Model settings page,
 * and the `delegation.reasoning_effort` enum — and one copy had drifted: it
 * stopped at `xhigh`, so a subagent could never be asked for `max` or `ultra`
 * from the UI even though `gateway/platforms/api_server.py` `_REASONING_EFFORTS`
 * accepts both. These tests fail if any of them re-grows its own copy.
 */

import { describe, expect, it } from 'vitest'

import { ENUM_OPTIONS } from '@/app/settings/constants'
import {
  DEFAULT_REASONING_EFFORT,
  isReasoningEffort,
  isThinkingEnabled,
  REASONING_EFFORT_VALUES,
  REASONING_EFFORTS,
  resolveReasoningEffort
} from '@/lib/reasoning-effort'

// hermes_constants.py VALID_REASONING_EFFORTS, in ladder order.
const BACKEND_LADDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

describe('the canonical ladder', () => {
  it('matches the backend, ordering included', () => {
    expect([...REASONING_EFFORTS]).toEqual(BACKEND_LADDER)
  })

  it('adds the off state on top of the scale, not inside it', () => {
    expect([...REASONING_EFFORT_VALUES]).toEqual(['none', ...BACKEND_LADDER])
    expect(REASONING_EFFORTS).not.toContain('none')
  })

  it('offers max and ultra to the delegation config row', () => {
    // The drifted copy. `''` heads the list because an unset delegation effort
    // inherits the agent's.
    expect(ENUM_OPTIONS['delegation.reasoning_effort']).toEqual(['', ...BACKEND_LADDER])
  })
})

describe('resolveReasoningEffort', () => {
  it('keeps a level the backend knows', () => {
    expect(resolveReasoningEffort('ultra')).toBe('ultra')
    expect(resolveReasoningEffort('MAX')).toBe('max')
  })

  it('selects nothing when thinking is off', () => {
    expect(resolveReasoningEffort('none')).toBe('')
  })

  it('inherits the fallback for an unset value, and only then', () => {
    expect(resolveReasoningEffort('', 'high')).toBe('high')
    expect(resolveReasoningEffort('low', 'high')).toBe('low')
    expect(resolveReasoningEffort('')).toBe(DEFAULT_REASONING_EFFORT)
  })

  // A level this build has never heard of must not select nothing — an empty
  // radio group reads as "no effort", which is not what the config says.
  it('clamps an unknown level to the default rather than dropping it', () => {
    expect(resolveReasoningEffort('bananas')).toBe(DEFAULT_REASONING_EFFORT)
  })
})

describe('isThinkingEnabled', () => {
  it('is on for every real level', () => {
    for (const effort of REASONING_EFFORTS) {
      expect(isThinkingEnabled(effort)).toBe(true)
    }
  })

  it('is off only for an explicit none', () => {
    expect(isThinkingEnabled('none')).toBe(false)
    expect(isThinkingEnabled('', 'none')).toBe(false)
    expect(isThinkingEnabled('')).toBe(true)
  })
})

describe('isReasoningEffort', () => {
  it('rejects the off state and unknown values', () => {
    expect(isReasoningEffort('none')).toBe(false)
    expect(isReasoningEffort('bananas')).toBe(false)
    expect(isReasoningEffort('Ultra')).toBe(true)
  })
})
