import { useEffect, useMemo, useRef, useState } from 'react'

import { ProfilesView } from '@/app/profiles'
import { RightSidebarPane } from '@/app/right-pane'
import { PreviewRail } from '@/app/right-pane/preview/preview-rail'
import { ReviewPane } from '@/app/right-pane/review'
import { TerminalPaneChrome } from '@/app/right-pane/terminal/chrome'
import { SECTIONS } from '@/app/settings/constants'
import { useSettingsNav } from '@/app/settings/settings-nav'
import { SectionBody } from '@/app/settings/settings-section'
import { SettingsFooter } from '@/app/settings/settings-view'
import { MobileStatusList } from '@/app/shell/mobile-status-list'
import {
  type WorkspacePrimaryTab,
  type WorkspaceToolTab,
  WorkspaceWindow
} from '@/app/shell/workspace-window'
import { ESCAPE_PRIORITY, isTopEscapeLayer, pushEscapeLayer } from '@/lib/escape-layers'
import { persistentAtom } from '@/lib/persisted'
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
  const primary = useStore($workspacePrimary)
  const tool = useStore($workspaceTool)
  const settingsSection = useStore($workspaceSettingsSection)
  const settingsNav = useSettingsNav()

  const settingsSections = useMemo(
    () => settingsNav.map(entry => ({ id: entry.id, label: entry.label })),
    [settingsNav]
  )

  const resolvedSettingsSection = useMemo(() => {
    if (settingsSections.some(section => section.id === settingsSection)) {
      return settingsSection
    }

    return settingsSections[0]?.id ?? DEFAULT_SETTINGS_SECTION
  }, [settingsSection, settingsSections])

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

  const toolBodies = {
    editor: visitedTools.has('editor') ? (
      <div className="flex h-full min-h-0 flex-col">
        <PreviewRail />
      </div>
    ) : null,
    files: visitedTools.has('files') ? (
      <div className="h-full overflow-hidden">
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
      <div className="flex h-full min-h-0 flex-col">
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
          onSelectSettingsSection={id => $workspaceSettingsSection.set(id)}
          onSelectTool={showTool}
          primaryTab={primary}
          profilesBody={<ProfilesView embedded onClose={onClose} />}
          settingsBody={
            <div className="flex h-full min-h-0 flex-col">
              <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
                <SectionBody section={resolvedSettingsSection} />
              </div>
              <div className="flex shrink-0 items-center justify-end gap-1 border-t border-border/40 px-2 py-1.5">
                <SettingsFooter />
              </div>
            </div>
          }
          settingsSection={resolvedSettingsSection}
          settingsSections={settingsSections}
          toolBodies={toolBodies}
          toolTab={tool}
        />
      </div>
    </div>
  )
}
