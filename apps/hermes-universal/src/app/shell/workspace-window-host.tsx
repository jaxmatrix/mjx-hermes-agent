import { useEffect, useMemo, useRef, useState } from 'react'

import { ProfilesView } from '@/app/profiles'
import { RightSidebarPane } from '@/app/right-pane'
import { PreviewRail } from '@/app/right-pane/preview/preview-rail'
import { ReviewPane } from '@/app/right-pane/review'
import { TerminalPaneChrome } from '@/app/right-pane/terminal/chrome'
import { SECTIONS } from '@/app/settings/constants'
import { defaultSectionForNavGroup, navGroupToSettingsView } from '@/app/settings/nav-group-section'
import { useSettingsNavGroups } from '@/app/settings/settings-nav'
import { SectionBody } from '@/app/settings/settings-section'
import { settingsSubpages } from '@/app/settings/subpages'
import { SettingsFooter } from '@/app/settings/settings-view'
import { MobileStatusList } from '@/app/shell/mobile-status-list'
import { SettingsSubmenuButton } from '@/app/shell/settings-submenu-button'
import {
  type WorkspacePrimaryTab,
  type WorkspaceToolTab,
  WorkspaceWindow
} from '@/app/shell/workspace-window'
import { useI18n } from '@/i18n'
import { ESCAPE_PRIORITY, isTopEscapeLayer, pushEscapeLayer } from '@/lib/escape-layers'
import { persistentAtom } from '@/lib/persisted'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { previewFile } from '@/store/preview-open'
import { openReview } from '@/store/review'
import { openAgentsScreen } from '@/store/windows'

const DEFAULT_SETTINGS_SECTION = SECTIONS[0]?.id ?? 'model'

function isPrimary(value: string): value is WorkspacePrimaryTab {
  return value === 'control' || value === 'workspace' || value === 'settings' || value === 'profiles'
}

function isTool(value: string): value is WorkspaceToolTab {
  return value === 'files' || value === 'review' || value === 'editor' || value === 'terminal'
}

/** Group id for a persisted section path (`providers/keys` → `providers`). */
function settingsGroupId(section: string): string {
  return section.split('/')[0] ?? section
}

const $workspacePrimary = persistentAtom<WorkspacePrimaryTab>('hermes.workspacePrimary', 'control', {
  decode: raw => (isPrimary(raw) ? raw : 'control'),
  encode: value => value
})

const $workspaceTool = persistentAtom<WorkspaceToolTab>('hermes.workspaceTool', 'files', {
  decode: raw => (isTool(raw) ? raw : 'files'),
  encode: value => value
})

const $workspaceSettingsSection = persistentAtom<string>(
  'hermes.workspaceSettingsSection',
  DEFAULT_SETTINGS_SECTION,
  {
    decode: raw => (typeof raw === 'string' && raw.length > 0 ? raw : DEFAULT_SETTINGS_SECTION),
    encode: value => value
  }
)

/** Live host for the phone Workspace window (Control | tools | Settings | Profiles). */
export function WorkspaceWindowHost({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  const primary = useStore($workspacePrimary)
  const tool = useStore($workspaceTool)
  const settingsSection = useStore($workspaceSettingsSection)
  const settingsGroups = useSettingsNavGroups()
  const subpageLabels = t.settings.subpages as Record<string, string>

  // Top tabs are nav GROUPS. Selecting a group with children / subpages lands
  // on the first child or first settingsSubpages entry.
  const settingsSections = useMemo(
    () => settingsGroups.map(group => ({ id: group.id, label: group.label })),
    [settingsGroups]
  )

  const allSectionIds = useMemo(() => {
    const ids = new Set<string>()

    for (const group of settingsGroups) {
      ids.add(group.id)

      for (const child of group.children ?? []) {
        ids.add(child.id)
      }

      if (!group.children?.length) {
        const view = navGroupToSettingsView(group.id)
        const pages = view ? settingsSubpages(view) : []

        if (pages.length > 1) {
          for (const page of pages) {
            ids.add(`${group.id}/${page.id}`)
          }
        }
      }
    }

    return ids
  }, [settingsGroups])

  const resolvedSettingsSection = useMemo(() => {
    if (allSectionIds.has(settingsSection)) {
      // Bare group id that owns settingsSubpages → upgrade to first subpage so
      // the drawer trigger matches an option id.
      const asGroup = settingsGroups.find(group => group.id === settingsSection)

      if (asGroup && !asGroup.children?.length) {
        return defaultSectionForNavGroup(asGroup)
      }

      return settingsSection
    }

    const first = settingsGroups[0]

    return first ? defaultSectionForNavGroup(first) : DEFAULT_SETTINGS_SECTION
  }, [allSectionIds, settingsGroups, settingsSection])

  const activeGroup = useMemo(() => {
    const groupId = settingsGroupId(resolvedSettingsSection)

    return settingsGroups.find(group => group.id === groupId)
  }, [resolvedSettingsSection, settingsGroups])

  const submenuOptions = useMemo(() => {
    if (!activeGroup) {
      return []
    }

    if (activeGroup.children?.length) {
      return activeGroup.children.map(child => ({ id: child.id, label: child.label }))
    }

    const view = navGroupToSettingsView(activeGroup.id)
    const pages = view ? settingsSubpages(view) : []

    if (pages.length <= 1) {
      return []
    }

    return pages.map(page => ({
      id: `${activeGroup.id}/${page.id}`,
      label: subpageLabels[page.labelKey] ?? page.labelKey
    }))
  }, [activeGroup, subpageLabels])

  const selectSettingsGroup = (groupId: string) => {
    const group = settingsGroups.find(entry => entry.id === groupId)

    if (!group) {
      return
    }

    $workspaceSettingsSection.set(defaultSectionForNavGroup(group))
  }

  const selectSettingsSection = (id: string) => {
    $workspaceSettingsSection.set(id)
  }

  const [visitedTools, setVisitedTools] = useState<Set<WorkspaceToolTab>>(() => new Set([tool]))
  const visitedRef = useRef(visitedTools)
  visitedRef.current = visitedTools

  const showTool = (next: WorkspaceToolTab) => {
    $workspaceTool.set(next)

    if (!visitedRef.current.has(next)) {
      setVisitedTools(prev => new Set(prev).add(next))
    }
  }

  useEffect(() => {
    openReview()
  }, [])

  useEffect(() => {
    const release = pushEscapeLayer(ESCAPE_PRIORITY.overlay)

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !isTopEscapeLayer(ESCAPE_PRIORITY.overlay)) {
        return
      }

      event.preventDefault()
      onClose()
    }

    window.addEventListener('keydown', onKeyDown)

    return () => {
      release()
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  // Files/Review asides still declare desktop `pt-(--titlebar-height)`; under
  // MobileWindowChrome the real top bar already cleared that band — zero it
  // the same way contrib `ZONE_CONTENT` does for docked tree zones.
  const zoneAside = 'h-full [&>aside]:h-full [&>aside]:w-full [&>aside]:pt-0'

  const toolBodies = {
    editor: visitedTools.has('editor') ? (
      <div className="flex h-full min-h-0 flex-col">
        <PreviewRail />
      </div>
    ) : null,
    files: visitedTools.has('files') ? (
      <div className={cn('overflow-hidden', zoneAside)}>
        <RightSidebarPane
          onActivateFile={path => {
            previewFile(path)
            showTool('editor')
          }}
          onActivateFolder={previewFile}
        />
      </div>
    ) : null,
    review: visitedTools.has('review') ? (
      <div className={cn('flex min-h-0 flex-col [&>aside]:min-h-0 [&>aside]:flex-1', zoneAside)}>
        <ReviewPane />
      </div>
    ) : null,
    terminal: visitedTools.has('terminal') ? (
      <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-(--ui-terminal-surface-background)">
        <TerminalPaneChrome />
      </div>
    ) : null
  }

  return (
    <div
      className="animate-in slide-in-from-end fixed inset-x-0 z-50 overflow-hidden bg-(--ui-bg-sidebar) duration-150"
      style={{
        height: 'var(--visual-viewport-height, 100%)',
        top: 'var(--visual-viewport-top, 0px)'
      }}
    >
      <div className="h-full min-h-0">
        <WorkspaceWindow
          controlBody={<MobileStatusList />}
          onClose={onClose}
          onOpenAgents={() => {
            void openAgentsScreen()
            onClose()
          }}
          onSelectPrimary={next => $workspacePrimary.set(next)}
          onSelectSettingsSection={selectSettingsGroup}
          onSelectTool={showTool}
          primaryTab={primary}
          profilesBody={<ProfilesView embedded onClose={onClose} />}
          settingsBody={
            <div className="flex h-full min-h-0 flex-col">
              {submenuOptions.length > 0 && activeGroup ? (
                <SettingsSubmenuButton
                  onSelect={selectSettingsSection}
                  options={submenuOptions}
                  selectedId={resolvedSettingsSection}
                  title={activeGroup.label}
                />
              ) : null}
              <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
                <SectionBody onSectionChange={selectSettingsSection} section={resolvedSettingsSection} />
              </div>
              <div className="flex shrink-0 items-center justify-end gap-1 border-t border-border/40 px-2 py-1.5">
                <SettingsFooter />
              </div>
            </div>
          }
          settingsSection={settingsGroupId(resolvedSettingsSection)}
          settingsSections={settingsSections}
          toolBodies={toolBodies}
          toolTab={tool}
        />
      </div>
    </div>
  )
}
