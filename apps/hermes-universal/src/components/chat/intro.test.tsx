/**
 * The intro wordmark is CSS-fitted (`.fit-text` + a twin width reference) —
 * there is no JS visibility gate anymore. Keep a smoke check that the
 * wordmark mounts with its accessible name.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/app/hooks/use-config-record', () => ({ useHermesConfigRecord: () => ({ data: {} }) }))

import { Intro } from './intro'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('the intro wordmark', () => {
  it('renders the HERMES AGENT wordmark', () => {
    render(<Intro />)

    expect(screen.getByLabelText('HERMES AGENT')).toBeTruthy()
  })
})
