import { open, save } from '@tauri-apps/plugin-dialog'
import { readFile, writeTextFile } from '@tauri-apps/plugin-fs'
import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

import { OverlayMain, OverlayNav, type OverlayNavGroup, OverlaySplitLayout } from '@/app/overlays/overlay-split-layout'
import { type OverlayVariant, OverlayView } from '@/app/overlays/overlay-view'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/tooltip'
import { getHermesConfigDefaults, getHermesConfigRecord, saveHermesConfig } from '@/hermes'
import { useI18n } from '@/i18n'
import { Download, Refresh, Upload } from '@/lib/icons'
import { confirm } from '@/store/confirm'
import { notify, notifyError } from '@/store/notifications'

import { SECTIONS } from './constants'
import { useSettingsNavGroups } from './settings-nav'
import { SectionBody } from './settings-section'
import { invalidateHermesConfig, setHermesConfigCache } from './use-config-record'

const DEFAULT_SECTION = SECTIONS[0]?.id ?? 'model'

// The nav footer: Export / Import / Reset (matches desktop). Export & import round-
// trip the whole config record through a native Tauri file dialog; reset restores
// defaults behind a confirm dialog. Exported so the Android activity's left drawer
// (which replaces the OverlayNav) can host it too.
export function SettingsFooter() {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)

  const exportConfig = async () => {
    try {
      const cfg = await getHermesConfigRecord()
      const path = await save({ defaultPath: 'hermes-config.json', filters: [{ extensions: ['json'], name: 'JSON' }] })

      if (!path) {
        return
      }

      await writeTextFile(path, JSON.stringify(cfg, null, 2))
      notify({ kind: 'success', message: t.settings.exportConfig })
    } catch (err) {
      notifyError(err, t.settings.exportFailed)
    }
  }

  const importConfig = async () => {
    const path = await open({ filters: [{ extensions: ['json'], name: 'JSON' }], multiple: false })

    if (!path || typeof path !== 'string') {
      return
    }

    try {
      const parsed = JSON.parse(new TextDecoder().decode(await readFile(path)))
      await saveHermesConfig(parsed)
      setHermesConfigCache(parsed)
      void invalidateHermesConfig()
      notify({ kind: 'success', message: t.settings.config.imported })
    } catch (err) {
      notifyError(err, t.settings.config.invalidJson)
    }
  }

  const reset = async () => {
    const ok = await confirm({
      confirmLabel: t.settings.resetToDefaults,
      destructive: true,
      title: t.settings.resetConfirm
    })

    if (!ok) {
      return
    }

    setBusy(true)

    try {
      const defaults = await getHermesConfigDefaults()
      await saveHermesConfig(defaults)
      setHermesConfigCache(defaults)
      void invalidateHermesConfig()
      notify({ kind: 'success', message: t.settings.resetToDefaults })
    } catch (err) {
      notifyError(err, t.settings.resetFailed)
    } finally {
      setBusy(false)
    }
  }

  const iconBtn = 'text-muted-foreground hover:text-foreground'

  return (
    <>
      <Tip label={t.settings.exportConfig}>
        <Button
          aria-label={t.settings.exportConfig}
          className={iconBtn}
          onClick={() => void exportConfig()}
          size="icon-sm"
          variant="ghost"
        >
          <Download className="size-4" />
        </Button>
      </Tip>
      <Tip label={t.settings.importConfig}>
        <Button
          aria-label={t.settings.importConfig}
          className={iconBtn}
          onClick={() => void importConfig()}
          size="icon-sm"
          variant="ghost"
        >
          <Upload className="size-4" />
        </Button>
      </Tip>
      {/* The confirm moved to the imperative `confirm()` front door, so this is
          a plain button again — which means it can carry a Tip. As a
          DialogTrigger it could not: Tip's own trigger cannot compose onto the
          same child, so it had to make do with a bare aria-label. */}
      <Tip label={t.settings.resetToDefaults}>
        <Button
          aria-label={t.settings.resetToDefaults}
          className="text-muted-foreground hover:text-destructive"
          disabled={busy}
          onClick={() => void reset()}
          size="icon-sm"
          variant="ghost"
        >
          <Refresh className="size-4" />
        </Button>
      </Tip>
    </>
  )
}

// The desktop-style settings portal: a full-window OverlayView card with a left
// nav rail (→ tab-dropdown on narrow) and the active section on the right. The
// active section id is the `/settings/:section` route param (default `model`);
// nav selection navigates the route, so existing deep-links keep working.
export function SettingsView({
  returnPath = '/',
  variant = 'overlay',
  onClose,
  hideNav = false
}: {
  returnPath?: string
  // Fullscreen when hosted as a native activity screen; the activity's Home
  // button supplies `onClose` (close the window) instead of routing back.
  variant?: OverlayVariant
  onClose?: () => void
  // Render only the active section body (no OverlayNav rail/dropdown) — the
  // Android activity shell owns nav in its left drawer instead.
  hideNav?: boolean
}) {
  const { t } = useI18n()
  const navigate = useNavigate()
  // Rendered as a top-level overlay (not a routed element), so the active section
  // is parsed from the path rather than route params: `/settings/:group(/:sub)`.
  // `section` keeps the full path (e.g. `providers/keys`) for sub-tab routing;
  // `topId` is the first segment, used for parent-group highlighting.
  const { pathname } = useLocation()
  const section = pathname.startsWith('/settings/') ? pathname.slice('/settings/'.length) : DEFAULT_SECTION
  const topId = section.split('/')[0]

  const groups: OverlayNavGroup[] = useSettingsNavGroups().map(group => ({
    active: group.id === topId,
    gapBefore: group.gapBefore,
    icon: group.icon,
    id: group.id,
    label: group.label,
    // `replace` so switching sections never stacks history (keeps close correct).
    onSelect: () => navigate(`/settings/${group.id}`, { replace: true }),
    children: group.children?.map(child => ({
      active: child.id === section,
      icon: child.icon,
      id: child.id,
      label: child.label,
      onSelect: () => navigate(`/settings/${child.id}`, { replace: true })
    }))
  }))

  // Close returns to the route the user was on before opening settings, not the
  // previously-viewed settings section. In a native activity the host passes
  // `onClose` (finish the activity) instead.
  const close = onClose ?? (() => navigate(returnPath))

  const main = (
    <OverlayMain className="px-0 pb-0">
      <SectionBody section={section} />
    </OverlayMain>
  )

  return (
    <OverlayView closeLabel={t.settings.closeSettings} onClose={close} variant={variant}>
      {hideNav ? (
        main
      ) : (
        <OverlaySplitLayout>
          <OverlayNav footer={<SettingsFooter />} groups={groups} />
          {main}
        </OverlaySplitLayout>
      )}
    </OverlayView>
  )
}
