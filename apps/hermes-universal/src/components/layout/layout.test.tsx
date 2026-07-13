import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Container } from './container'
import { Grid } from './grid'
import { Stack } from './stack'

describe('layout primitives (mobile-first)', () => {
  it('Container applies padding + size, no max-* walkbacks', () => {
    render(
      <Container size="prose" data-testid="c">
        x
      </Container>
    )
    const el = screen.getByTestId('c')
    expect(el).toHaveClass('mx-auto', 'w-full', 'px-4', 'sm:px-6', 'lg:px-8', 'max-w-2xl')
  })

  it('Grid starts at 1 col and adds columns at breakpoints', () => {
    render(<Grid cols={3} data-testid="g" />)
    const el = screen.getByTestId('g')
    expect(el).toHaveClass('grid', 'grid-cols-1', 'sm:grid-cols-2', 'lg:grid-cols-3')
    // base is never 3 cols — only the lg: prefixed form exists
    expect(el.className.split(/\s+/)).not.toContain('grid-cols-3')
  })

  it('Stack row stacks on mobile, becomes row from md up', () => {
    render(<Stack direction="row" gap={6} data-testid="s" />)
    const el = screen.getByTestId('s')
    expect(el).toHaveClass('flex', 'flex-col', 'md:flex-row', 'gap-6')
  })

  it('no new primitive uses a max-* walkback', () => {
    render(
      <Stack data-testid="s2">
        <Container>x</Container>
        <Grid cols={2} />
      </Stack>
    )
    expect(screen.getByTestId('s2').outerHTML).not.toMatch(/\bmax-(sm|md|lg|xl):/)
  })
})
