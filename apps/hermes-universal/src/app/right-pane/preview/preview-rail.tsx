import { BrowserPane } from '@/app/browser/browser-pane'
import { CONTEXT_KIT } from '@/components/ui/actions-menu'
import { Codicon } from '@/components/ui/codicon'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { paneTabCloseItems } from '@/components/ui/pane-tab'
import { useI18n } from '@/i18n'
import { isMetaClose, middleClickHandlers } from '@/lib/middle-click'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { useDisplayPath } from '@/store/display-home'
import { $rightRailActiveTabId, selectRightRailTab } from '@/store/layout'
import {
  $previewTabs,
  $previewTarget,
  closeRightRailTab,
  type PreviewTab,
  type PreviewTarget
} from '@/store/preview'
import { $dirtyPreviewUrls } from '@/store/preview-edit'

import { ArtifactPreview } from './preview-artifact'
import { PreviewFile } from './preview-file'

function tabLabel(target: PreviewTarget): string {
  if (target.kind === 'url') {
    return 'Browser'
  }

  if (target.kind === 'artifact') {
    return target.label || 'Preview'
  }

  const value = target.label || target.path || target.source || target.url
  const tail = value.split(/[\\/]/).filter(Boolean).at(-1)

  return tail || value || 'Preview'
}

function closeTargets(tabId: string) {
  const tabs = $previewTabs.get()
  const index = tabs.findIndex(tab => tab.id === tabId)
  const toRight = index === -1 ? 0 : Math.max(0, tabs.length - index - 1)

  return {
    all: tabs.length,
    others: Math.max(0, tabs.length - 1),
    right: toRight
  }
}

function closeOtherTabs(tabId: string) {
  for (const tab of $previewTabs.get()) {
    if (tab.id !== tabId) {
      closeRightRailTab(tab.id)
    }
  }
}

function closeTabsToRight(tabId: string) {
  const tabs = $previewTabs.get()
  const index = tabs.findIndex(tab => tab.id === tabId)

  if (index === -1) {
    return
  }

  for (const tab of tabs.slice(index + 1)) {
    closeRightRailTab(tab.id)
  }
}

export function PreviewRail() {
  const tabs = useStore($previewTabs)
  const active = useStore($previewTarget)
  const activeTabId = useStore($rightRailActiveTabId)
  const dirty = useStore($dirtyPreviewUrls)

  return (
    <div className="flex h-full min-h-0 flex-col bg-(--ui-editor-surface-background)">
      {tabs.length > 0 && (
        <div className="flex h-8 shrink-0 items-stretch overflow-x-auto border-t border-b border-(--ui-stroke-tertiary) bg-(--ui-sidebar-surface-background)">
          {tabs.map(tab => (
            <PreviewRailTab
              active={tab.id === activeTabId}
              dirty={Boolean(dirty[tab.target.url])}
              key={tab.id}
              tab={tab}
            />
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
        {active ? (
          active.kind === 'url' ? (
            <BrowserPane key={activeTabId ?? active.url} />
          ) : active.kind === 'artifact' ? (
            <ArtifactPreview key={activeTabId ?? active.url} target={active} />
          ) : (
            <PreviewFile key={activeTabId ?? active.url} target={active} />
          )
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground/60">
            <Codicon name="file-code" size="1.5rem" />
          </div>
        )}
      </div>
    </div>
  )
}

function PreviewRailTab({ active, dirty, tab }: { active: boolean; dirty: boolean; tab: PreviewTab }) {
  const { t } = useI18n()
  const p = t.preview
  const displayPath = useDisplayPath()
  const name = tabLabel(tab.target)
  const pathHint = tab.target.path || tab.target.source || tab.target.url

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            'group/tab flex min-w-0 max-w-40 shrink-0 cursor-pointer items-center gap-1.5 border-e border-(--ui-stroke-tertiary) px-2 text-xs',
            active
              ? 'bg-(--ui-editor-surface-background) text-foreground'
              : 'text-(--ui-text-tertiary) hover:text-foreground'
          )}
          {...middleClickHandlers(() => closeRightRailTab(tab.id))}
          onClick={event => {
            if (isMetaClose(event)) {
              event.preventDefault()
              closeRightRailTab(tab.id)

              return
            }

            selectRightRailTab(tab.id)
          }}
          title={displayPath(pathHint)}
        >
          <span className="min-w-0 flex-1 truncate">{name}</span>
          <button
            aria-label={`Close ${name}`}
            className="inline-flex size-4 shrink-0 items-center justify-center rounded hover:bg-(--chrome-action-hover)"
            onClick={event => {
              event.stopPropagation()
              closeRightRailTab(tab.id)
            }}
            type="button"
          >
            {dirty ? (
              <span aria-hidden className="size-1.5 rounded-full bg-(--ui-yellow) group-hover/tab:hidden coarse:hidden" />
            ) : null}
            <Codicon
              className={cn(dirty && 'hidden group-hover/tab:inline coarse:inline')}
              name="close"
              size="0.7rem"
            />
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        {paneTabCloseItems(CONTEXT_KIT, {
          counts: closeTargets(tab.id),
          onClose: () => closeRightRailTab(tab.id),
          onCloseAll: () => {
            for (const item of [...$previewTabs.get()]) {
              closeRightRailTab(item.id)
            }
          },
          onCloseOthers: () => closeOtherTabs(tab.id),
          onCloseToRight: () => closeTabsToRight(tab.id)
        })}
      </ContextMenuContent>
    </ContextMenu>
  )
}
