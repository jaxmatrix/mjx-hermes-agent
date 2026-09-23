import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Button } from './button'

describe('Button', () => {
  it('renders a button with the variant token class + data attribute', () => {
    render(<Button variant="destructive">Delete</Button>)
    const btn = screen.getByRole('button', { name: 'Delete' })
    expect(btn).toBeInTheDocument()
    expect(btn.tagName).toBe('BUTTON')
    expect(btn).toHaveAttribute('data-variant', 'destructive')
    expect(btn).toHaveClass('bg-destructive')
  })

  it('renders as a child element when asChild is set', () => {
    render(
      <Button asChild>
        <a href="/x">Link</a>
      </Button>
    )
    const link = screen.getByRole('link', { name: 'Link' })
    expect(link).toBeInTheDocument()
    expect(link).toHaveClass('bg-primary')
  })
})
