import { OverlayView } from '@/app/overlays/overlay-view'
import { ArtifactPreview } from '@/app/right-pane/preview/preview-artifact'
import { useI18n } from '@/i18n'
import { useStore } from '@/store/atom'
import { $rightRailActiveTabId } from '@/store/layout'
import { $previewTabs, $previewTarget, closeRightRailTab } from '@/store/preview'

export function ArtifactPreviewOverlay() {
  const { t } = useI18n()
  const target = useStore($previewTarget)
  const activeTabId = useStore($rightRailActiveTabId)

  if (!target || target.kind !== 'artifact') {
    return null
  }

  const tabId = activeTabId ?? $previewTabs.get().find(tab => tab.target.url === target.url)?.id

  return (
    <OverlayView
      closeLabel={t.preview.closeTab(target.label)}
      contentClassName="overflow-hidden pt-[calc(var(--titlebar-height)+0.1875rem)]"
      onClose={() => {
        if (tabId) {
          closeRightRailTab(tabId)
        }
      }}
    >
      <ArtifactPreview key={tabId ?? target.url} target={target} />
    </OverlayView>
  )
}
