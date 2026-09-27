import { useMemo, type ReactNode } from 'react'

import { MobileNavRail, type MobileNavRailItem } from '@/app/shell/mobile-nav-rail'
import { MobileWindowChrome, type MobileWindowTab } from '@/app/shell/mobile-window-chrome'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

export type WorkspacePrimaryTab = 'control' | 'profiles' | 'settings' | 'workspace'
export type WorkspaceToolTab = 'editor' | 'files' | 'review' | 'terminal'

export interface WorkspaceSettingsSectionTab {
  id: string
  label: string
}

/**
 * Phone Workspace window: Control / Workspace / Settings / Profiles on the
 * bottom rail; Agents opens an overlay. Workspace tools and Settings sections
 * use the top tab strip. Bodies for Control / Workspace tools / Settings /
 * Profiles stay in the tree (host visibility) so state survives tab switches.
 */
export function WorkspaceWindow({
  controlBody,
  onClose,
  onOpenAgents,
  onSelectPrimary,
  onSelectSettingsSection,
  onSelectTool,
  primaryTab,
  profilesBody,
  settingsBody,
  settingsSection,
  settingsSections,
  toolBodies,
  toolTab
}: {
  controlBody: ReactNode
  onClose: () => void
  onOpenAgents: () => void
  onSelectPrimary: (tab: WorkspacePrimaryTab) => void
  onSelectSettingsSection: (id: string) => void
  onSelectTool: (tab: WorkspaceToolTab) => void
  primaryTab: WorkspacePrimaryTab
  profilesBody: ReactNode
  settingsBody: ReactNode
  settingsSection: string
  settingsSections: readonly WorkspaceSettingsSectionTab[]
  toolBodies: Record<WorkspaceToolTab, ReactNode>
  toolTab: WorkspaceToolTab
}) {
  const { t } = useI18n()
  const w = t.mobileWorkspace

  const navItems = useMemo<MobileNavRailItem[]>(
    () => [
      {
        active: primaryTab === 'control',
        icon: 'pulse',
        id: 'control',
        label: w.control,
        onSelect: () => onSelectPrimary('control')
      },
      {
        active: primaryTab === 'workspace',
        icon: 'tools',
        id: 'workspace',
        label: w.workspace,
        onSelect: () => onSelectPrimary('workspace')
      },
      {
        active: primaryTab === 'settings',
        ariaLabel: t.titlebar.openSettings,
        icon: 'settings-gear',
        id: 'settings',
        label: w.settings,
        onSelect: () => onSelectPrimary('settings')
      },
      {
        active: primaryTab === 'profiles',
        icon: 'organization',
        id: 'profiles',
        label: w.profiles,
        onSelect: () => onSelectPrimary('profiles')
      },
      {
        icon: 'robot',
        id: 'agents',
        label: w.agents,
        onSelect: onOpenAgents
      }
    ],
    [
      onOpenAgents,
      onSelectPrimary,
      primaryTab,
      t.titlebar.openSettings,
      w.agents,
      w.control,
      w.profiles,
      w.settings,
      w.workspace
    ]
  )

  const topTabs = useMemo((): readonly MobileWindowTab[] | undefined => {
    if (primaryTab === 'workspace') {
      return [
        { id: 'files', label: w.files },
        { id: 'review', label: w.review },
        { id: 'editor', label: w.editor },
        { id: 'terminal', label: w.terminal }
      ]
    }

    if (primaryTab === 'settings') {
      return settingsSections.map(section => ({ id: section.id, label: section.label }))
    }

    return undefined
  }, [primaryTab, settingsSections, w.editor, w.files, w.review, w.terminal])

  const activeTabId = primaryTab === 'workspace' ? toolTab : primaryTab === 'settings' ? settingsSection : undefined

  const onSelectTab =
    primaryTab === 'workspace'
      ? (id: string) => onSelectTool(id as WorkspaceToolTab)
      : primaryTab === 'settings'
        ? onSelectSettingsSection
        : undefined

  return (
    <MobileWindowChrome
      activeTabId={activeTabId}
      body={
        <div className="relative min-h-0 flex-1 overflow-hidden" data-slot="workspace-window-body">
          <div className={cn('absolute inset-0', primaryTab !== 'control' && 'hidden')}>{controlBody}</div>
          <div className={cn('absolute inset-0', primaryTab !== 'workspace' && 'hidden')}>
            {(Object.keys(toolBodies) as WorkspaceToolTab[]).map(id => (
              <div
                className={cn('absolute inset-0', toolTab !== id && (id === 'terminal' ? 'invisible' : 'hidden'))}
                key={id}
              >
                {toolBodies[id]}
              </div>
            ))}
          </div>
          <div className={cn('absolute inset-0', primaryTab !== 'settings' && 'hidden')}>{settingsBody}</div>
          <div className={cn('absolute inset-0', primaryTab !== 'profiles' && 'hidden')}>{profilesBody}</div>
        </div>
      }
      bottom={<MobileNavRail aria-label={w.tabsAria} items={navItems} />}
      closeSide="start"
      data-slot="workspace-window"
      onClose={onClose}
      onSelectTab={onSelectTab}
      tabs={topTabs}
      topBorder={false}
    />
  )
}
