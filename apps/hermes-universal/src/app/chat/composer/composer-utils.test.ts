import { describe, expect, it } from 'vitest'

import { slashArgStage, slashCommandToken } from './composer-utils'

// Ported (subset) from apps/desktop/src/app/chat/composer/composer-utils.test.ts.
describe('slashArgStage', () => {
  it('is false for a bare command name', () => {
    expect(slashArgStage('personality')).toBe(false)
  })

  it('is true once a space follows the command', () => {
    expect(slashArgStage('personality ')).toBe(true)
    expect(slashArgStage('personality alice')).toBe(true)
  })
})

describe('slashCommandToken', () => {
  it('extracts and lowercases the /command token', () => {
    expect(slashCommandToken('Personality alice')).toBe('/personality')
    expect(slashCommandToken('help')).toBe('/help')
  })
})
