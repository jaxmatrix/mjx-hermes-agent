import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { Switch } from '@/components/ui/switch'

import { ListRow } from './primitives'

describe('settings primitives', () => {
  it('renders a ListRow with title/description and its action', () => {
    render(<ListRow action={<span>ctl</span>} description="the description" title="Row title" />)
    expect(screen.getByText('Row title')).toBeInTheDocument()
    expect(screen.getByText('the description')).toBeInTheDocument()
    expect(screen.getByText('ctl')).toBeInTheDocument()
  })

  it('Switch toggles via onCheckedChange', () => {
    const onCheckedChange = vi.fn()
    render(<Switch aria-label="flag" checked={false} onCheckedChange={onCheckedChange} />)
    fireEvent.click(screen.getByRole('switch', { name: 'flag' }))
    expect(onCheckedChange).toHaveBeenCalledWith(true)
  })
})
