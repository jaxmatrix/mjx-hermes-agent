import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { MobileChromeBar } from './mobile-chrome-bar'

describe('MobileChromeBar connection chrome', () => {
  it('exposes data-connection-chrome for the bottom-border indicator', () => {
    const { container, rerender } = render(<MobileChromeBar connectionStatus="reconnecting" />)
    const bar = container.querySelector('[data-slot="mobile-chrome-bar"]')

    expect(bar?.getAttribute('data-connection-chrome')).toBe('reconnecting')

    rerender(<MobileChromeBar connectionStatus="reconnected" />)
    expect(bar?.getAttribute('data-connection-chrome')).toBe('reconnected')

    rerender(<MobileChromeBar />)
    expect(bar?.getAttribute('data-connection-chrome')).toBe('idle')
  })
})
