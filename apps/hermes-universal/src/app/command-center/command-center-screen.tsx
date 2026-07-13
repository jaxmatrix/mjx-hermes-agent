import { useState } from 'react'

import { SidebarTrigger } from '@/app/shell/sidebar'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useI18n } from '@/i18n'

import { MaintenancePanel } from './maintenance-panel'
import { SystemPanel } from './system-panel'
import { UsagePanel } from './usage-panel'

type Section = 'system' | 'usage' | 'maintenance'

// Lean mobile Command Center: the System / Usage / Maintenance operational
// panels. The desktop "sessions" section is omitted — session management lives
// in the chat History sheet (Track H).
export function CommandCenterScreen() {
  const { t } = useI18n()
  const cc = t.commandCenter
  const [section, setSection] = useState<Section>('system')

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border p-3">
        <SidebarTrigger className="md:hidden" />
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold text-foreground">{cc.commandCenter}</h1>
      </header>

      <div className="border-b border-border px-3 py-2">
        <Tabs onValueChange={v => setSection(v as Section)} value={section}>
          <TabsList className="w-full">
            <TabsTrigger className="flex-1" value="system">
              {cc.sections.system}
            </TabsTrigger>
            <TabsTrigger className="flex-1" value="usage">
              {cc.sections.usage}
            </TabsTrigger>
            <TabsTrigger className="flex-1" value="maintenance">
              {cc.sections.maintenance}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {section === 'system' ? <SystemPanel /> : section === 'usage' ? <UsagePanel /> : <MaintenancePanel />}
    </div>
  )
}
