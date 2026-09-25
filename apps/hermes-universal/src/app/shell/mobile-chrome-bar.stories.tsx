import type { Meta, StoryObj } from '@storybook/react-vite'
import { useEffect, useState } from 'react'

import { MobileChromeBar } from '@/app/shell/mobile-chrome-bar'
import type { MobileConnectionChromeStatus } from '@/app/shell/mobile-connection-chrome'
import { mobileShellDecorators } from '@/app/shell/mobile-shell.stories-shared'
import { TitlebarButton } from '@/app/shell/titlebar-button'
import { Codicon } from '@/components/ui/codicon'

/**
 * Chat top-bar connection chrome: orange shimmer while reconnecting, green
 * flash for 1s when back. CSS is gated on `html.is-mobile` (withMobile).
 */

function ChromeDemo({
  connectionStatus
}: {
  connectionStatus: MobileConnectionChromeStatus
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <MobileChromeBar
        center={<span className="ps-2 text-sm font-medium">Chat</span>}
        connectionStatus={connectionStatus}
        topBorder={false}
        left={
          <TitlebarButton density="mobile" label="Sessions" onClick={() => undefined}>
            <Codicon name="history" size="1.4rem" />
          </TitlebarButton>
        }
        right={
          <TitlebarButton density="mobile" label="Workspace" onClick={() => undefined}>
            <Codicon name="layout-sidebar-right" size="1.4rem" />
          </TitlebarButton>
        }
      />
      <div className="min-h-0 flex-1 px-3 py-4 text-sm text-muted-foreground">
        <p>
          Connection status: <code>{connectionStatus}</code>
        </p>
        <p className="mt-2">Watch the top bar’s bottom edge for the indicator.</p>
      </div>
    </div>
  )
}

const meta = {
  title: 'Mobile/ChromeBar',
  component: ChromeDemo,
  decorators: mobileShellDecorators,
  parameters: { layout: 'fullscreen' },
  argTypes: {
    connectionStatus: {
      control: 'select',
      options: ['idle', 'reconnecting', 'reconnected']
    }
  },
  args: {
    connectionStatus: 'idle'
  }
} satisfies Meta<typeof ChromeDemo>

export default meta
type Story = StoryObj<typeof meta>

export const Idle: Story = {
  args: { connectionStatus: 'idle' }
}

export const Reconnecting: Story = {
  args: { connectionStatus: 'reconnecting' }
}

export const Reconnected: Story = {
  args: { connectionStatus: 'reconnected' }
}

/** Simulates drop → recover → idle (green flash lasts ~1s). */
export const ReconnectCycle: Story = {
  render: function ReconnectCycleStory() {
    const [status, setStatus] = useState<MobileConnectionChromeStatus>('idle')

    useEffect(() => {
      const t1 = window.setTimeout(() => setStatus('reconnecting'), 600)
      const t2 = window.setTimeout(() => setStatus('reconnected'), 2800)
      const t3 = window.setTimeout(() => setStatus('idle'), 3800)

      return () => {
        window.clearTimeout(t1)
        window.clearTimeout(t2)
        window.clearTimeout(t3)
      }
    }, [])

    return <ChromeDemo connectionStatus={status} />
  }
}
