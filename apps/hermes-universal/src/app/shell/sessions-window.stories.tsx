import type { Meta, StoryObj } from '@storybook/react-vite'
import { useMemo, useState } from 'react'

import type { MobileNavRailItem } from '@/app/shell/mobile-nav-rail'
import { mobileShellDecorators } from '@/app/shell/mobile-shell.stories-shared'
import {
  SessionsWindow,
  type SessionsWindowProfile,
  type SessionsWindowTab
} from '@/app/shell/sessions-window'

const PROFILES: SessionsWindowProfile[] = [
  { color: null, id: 'default', isDefault: true, name: 'Default' },
  { color: '#5b8def', id: 'work', isDefault: false, name: 'Work' },
  { color: '#c084fc', id: 'bots', isDefault: false, name: 'Bots' }
]

function StubList({ rows, title }: { rows: string[]; title: string }) {
  return (
    <div className="flex h-full flex-col overflow-y-auto px-3 py-2">
      <div className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</div>
      <ul className="flex flex-col gap-0.5">
        {rows.map(row => (
          <li
            className="rounded-md px-2 py-2 text-sm hover:bg-[var(--ui-control-hover-background)]"
            key={row}
          >
            {row}
          </li>
        ))}
      </ul>
    </div>
  )
}

function SessionsWindowHarness() {
  const [tab, setTab] = useState<SessionsWindowTab>('sessions')
  const [profileId, setProfileId] = useState('default')
  const [closed, setClosed] = useState(false)

  const navItems = useMemo<MobileNavRailItem[]>(
    () =>
      [
        { icon: 'robot', id: 'new-session', label: 'New' },
        { icon: 'symbol-misc', id: 'capabilities', label: 'Caps' },
        { icon: 'comment', id: 'messaging', label: 'Msg' },
        { icon: 'files', id: 'artifacts', label: 'Arts' },
        { icon: 'watch', id: 'cron', label: 'Cron' }
      ].map(item => ({
        ...item,
        onSelect: () => undefined
      })),
    []
  )

  if (closed) {
    return (
      <div className="grid h-full place-items-center text-sm text-muted-foreground">
        Closed — refresh story to reopen
      </div>
    )
  }

  return (
    <SessionsWindow
      activeTab={tab}
      botsBody={<StubList rows={['Atlas', 'Courier', 'Scribe']} title="Bots" />}
      navItems={navItems}
      onClose={() => setClosed(true)}
      onSelectProfile={setProfileId}
      onSelectTab={setTab}
      profiles={PROFILES}
      selectedProfileId={profileId}
      sessionsBody={
        <StubList rows={['Morning brief', 'Fix sync', 'Ship mobile shell']} title="Sessions" />
      }
    />
  )
}

const meta = {
  title: 'Mobile/Sessions window',
  component: SessionsWindowHarness,
  decorators: mobileShellDecorators,
  parameters: { layout: 'fullscreen' }
} satisfies Meta<typeof SessionsWindowHarness>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
