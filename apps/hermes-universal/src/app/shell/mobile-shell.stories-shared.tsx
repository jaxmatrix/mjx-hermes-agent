import type { Decorator } from '@storybook/react-vite'
import type { ReactNode } from 'react'

import { withMobile } from '../../../.storybook/decorators'

/** Phone-sized frame for mobile shell stories (~iPhone logical size). */
export function PhoneFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-neutral-900 p-4">
      <div
        className="relative overflow-hidden rounded-[1.25rem] border border-neutral-700 bg-background shadow-2xl"
        data-slot="phone-frame"
        style={{ height: 844, width: 390 }}
      >
        <div className="flex h-full min-h-0 flex-col">{children}</div>
      </div>
    </div>
  )
}

export const withPhoneFrame: Decorator = Story => (
  <PhoneFrame>
    <Story />
  </PhoneFrame>
)

/** Mobile platform flags + phone frame. Remounts on platform via withMobile's key. */
export const mobileShellDecorators: Decorator[] = [withMobile, withPhoneFrame]
