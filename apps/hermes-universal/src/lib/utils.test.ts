import { describe, expect, it } from 'vitest'

import { cn } from './utils'

describe('cn', () => {
  it('drops falsy values and joins classes', () => {
    expect(cn('a', false && 'b', undefined, 'c')).toBe('a c')
  })

  it('lets later Tailwind utilities win conflicts (tailwind-merge)', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4')
    expect(cn('text-foreground', 'text-muted-foreground')).toBe('text-muted-foreground')
  })
})
