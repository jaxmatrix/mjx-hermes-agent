import { useEffect, useMemo, useState } from 'react'

import { EmptyState, ListRow, LoadingState, Pill, SettingsContent } from '@/app/settings/primitives'
import { toolsetDisplayLabel } from '@/app/settings/helpers'
import { SidebarTrigger } from '@/app/shell/sidebar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useI18n } from '@/i18n'
import { Search } from '@/lib/icons'
import { includesQuery } from '@/lib/text'
import { useStore } from '@/store/atom'
import {
  $capsError,
  $capsLoading,
  $skills,
  $toolsets,
  refreshCapabilities,
  setSkillEnabled,
  setToolsetEnabled
} from '@/store/skills'

type Tab = 'skills' | 'toolsets'

// computer_use is a desktop macOS-permission concept — hidden on mobile. FIXME(K5).
const HIDDEN_TOOLSETS = new Set(['computer_use'])

export function SkillsScreen() {
  const { t } = useI18n()
  const s = t.skills
  const skills = useStore($skills)
  const toolsets = useStore($toolsets)
  const loading = useStore($capsLoading)
  const error = useStore($capsError)
  const [tab, setTab] = useState<Tab>('skills')
  const [query, setQuery] = useState('')

  useEffect(() => void refreshCapabilities(), [])

  const q = query.trim().toLowerCase()
  const shownSkills = useMemo(
    () => skills.filter(skill => !q || skill.name.toLowerCase().includes(q) || includesQuery(skill.description, q)),
    [skills, q]
  )
  const shownToolsets = useMemo(
    () =>
      toolsets.filter(
        ts => !HIDDEN_TOOLSETS.has(ts.name) && (!q || ts.name.toLowerCase().includes(q) || includesQuery(ts.description, q))
      ),
    [toolsets, q]
  )

  const body = () => {
    if (loading && skills.length === 0 && toolsets.length === 0) {
      return <LoadingState label={s.loading} />
    }
    if (error && skills.length === 0 && toolsets.length === 0) {
      return (
        <SettingsContent>
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <span className="text-sm text-muted-foreground">{s.skillsLoadFailed}</span>
            <Button onClick={() => void refreshCapabilities()} size="sm">
              {t.common.retry}
            </Button>
          </div>
        </SettingsContent>
      )
    }

    if (tab === 'skills') {
      return shownSkills.length === 0 ? (
        <SettingsContent>
          <EmptyState description={s.noSkillsDesc} title={s.noSkillsTitle} />
        </SettingsContent>
      ) : (
        <SettingsContent>
          <div className="pt-1">
            {shownSkills.map(skill => (
              <ListRow
                key={skill.name}
                description={skill.description || s.noDescription}
                action={<Switch checked={skill.enabled} onCheckedChange={on => void setSkillEnabled(skill.name, on)} />}
                title={
                  <span className="inline-flex items-center gap-2">
                    <span className="truncate">{skill.name}</span>
                    {skill.provenance && <Pill>{s.provenance[skill.provenance]}</Pill>}
                  </span>
                }
              />
            ))}
          </div>
        </SettingsContent>
      )
    }

    return shownToolsets.length === 0 ? (
      <SettingsContent>
        <EmptyState description={s.noToolsetsDesc} title={s.noToolsetsTitle} />
      </SettingsContent>
    ) : (
      <SettingsContent>
        <div className="pt-1">
          {shownToolsets.map(ts => (
            <ListRow
              key={ts.name}
              description={ts.description || s.noDescription}
              action={
                <Switch
                  aria-label={s.toggleToolset(toolsetDisplayLabel(ts))}
                  checked={ts.enabled}
                  onCheckedChange={on => void setToolsetEnabled(ts.name, on)}
                />
              }
              title={
                <span className="inline-flex items-center gap-2">
                  <span className="truncate">{toolsetDisplayLabel(ts)}</span>
                  {ts.tools.length > 0 && <Pill>{ts.configured ? s.configured : s.needsKeys}</Pill>}
                </span>
              }
            />
          ))}
        </div>
      </SettingsContent>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border p-3">
        <SidebarTrigger className="md:hidden" />
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold text-foreground">{t.nav.skills}</h1>
      </header>

      <div className="flex flex-col gap-2 border-b border-border px-3 py-2">
        <Tabs onValueChange={v => setTab(v as Tab)} value={tab}>
          <TabsList className="w-full">
            <TabsTrigger className="flex-1" value="skills">
              {s.tabSkills}
            </TabsTrigger>
            <TabsTrigger className="flex-1" value="toolsets">
              {s.tabToolsets}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            onChange={e => setQuery(e.target.value)}
            placeholder={tab === 'skills' ? s.searchSkills : s.searchToolsets}
            value={query}
          />
        </div>
      </div>

      {body()}
    </div>
  )
}
