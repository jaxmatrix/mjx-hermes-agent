import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'

import { MobileWindowChrome } from '@/app/shell/mobile-window-chrome'
import { mobileShellDecorators } from '@/app/shell/mobile-shell.stories-shared'
import { PaneTab, PaneTabLabel, PaneTabStrip } from '@/components/ui/pane-tab'

function PrimitivesHarness() {
  const [tab, setTab] = useState('a')
  const [closed, setClosed] = useState(false)

  if (closed) {
    return <div className="grid h-full place-items-center text-sm text-muted-foreground">Closed</div>
  }

  return (
    <MobileWindowChrome
      activeTabId={tab}
      body={
        <div className="flex min-h-0 flex-1 flex-col">
          <PaneTabStrip className="border-b border-(--ui-stroke-tertiary)">
            <PaneTab active>
              <PaneTabLabel>Nested</PaneTabLabel>
            </PaneTab>
          </PaneTabStrip>
          <div className="grid flex-1 place-items-center text-sm text-muted-foreground">Body · tab {tab}</div>
        </div>
      }
      onClose={() => setClosed(true)}
      onSelectTab={setTab}
      tabs={[
        { id: 'a', label: 'Alpha' },
        { id: 'b', label: 'Beta' }
      ]}
    />
  )
}

const meta = {
  title: 'Mobile/Window chrome',
  component: PrimitivesHarness,
  decorators: mobileShellDecorators,
  parameters: { layout: 'fullscreen' }
} satisfies Meta<typeof PrimitivesHarness>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
