import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type * as WindowsStore from '@/store/windows'

type Windows = typeof WindowsStore

// The activity screen's job here is purely which surfaces it MOUNTS: Settings ▸
// Providers launches desktop onboarding via `$desktopOnboarding`, and the overlay
// must be mounted in this window too. Stub the leaves so the test is about the
// wiring, not their internals.
vi.mock('@/app/shell/mobile-surface-shell', () => ({ MobileSurfaceShell: () => <div>settings surface</div> }))
vi.mock('@/components/onboarding', () => ({
  DesktopOnboardingOverlay: () => <div>desktop onboarding overlay</div>
}))
vi.mock('@/components/notifications', () => ({ NotificationStack: () => null }))
// Partial: `@/store/windows` is also imported transitively for persisted-state
// ownership, so only `returnHome` (a real native-window call) is replaced.
vi.mock('@/store/windows', async importOriginal => ({
  ...(await importOriginal<Windows>()),
  returnHome: vi.fn(async () => {})
}))

import { ActivityScreenRoot } from './activity-screen'

describe('ActivityScreenRoot', () => {
  it('mounts the desktop onboarding overlay over the settings surface', () => {
    render(<ActivityScreenRoot />)

    expect(screen.getByText('settings surface')).toBeInTheDocument()
    expect(screen.getByText('desktop onboarding overlay')).toBeInTheDocument()
  })
})
