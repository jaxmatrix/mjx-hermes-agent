/**
 * Per-preview strip tools — the source / rendered / diff switch.
 *
 * These were buttons in the preview's own toolbar, a second bar under the tab
 * that named the same file. Now that a preview is a layout-tree tile they are
 * strip glyphs, contributed as `PaneStripTool` DATA — the zone strip renders
 * them with `PaneStripGlyph`, the same button the `+` is, so there is no
 * preview-owned styling to drift from the rest of the app.
 *
 * `active` is driven by the real view state (`store/preview-view`), not by a
 * click-handler assumption, and `disabled` by what the pane actually managed to
 * load — an image or a binary offers no source view, a `.ts` file no rendered
 * one. The strip reads these during ITS render, so both stores nudge it.
 *
 * FILE tabs only. An artifact tab is read from the registry and carries its own
 * rendered/source switch and version stepper, so it contributes no strip tools
 * (see preview-tile.tsx) — the same gate desktop applies when it hands console /
 * DevTools glyphs only to a `url` tab.
 *
 * The BROWSER tab gets its own set (`browserStripTools`): the console and
 * DevTools toggles, exactly the pair desktop hands a `url` tab. It is not a
 * frame — the app CSP's `frame-src` names `hermes-artifact:` and nothing else,
 * deliberately — but a native guest webview owned by Rust (MJXHRM-447).
 */

import { invalidateStripTools } from '@/components/pane-shell/tree/store'
import { Codicon } from '@/components/ui/codicon'
import type { PaneStripTool } from '@/components/ui/pane-tab'
import { translateNow } from '@/i18n'
import { openGuestDevtools } from '@/lib/browser/host'
import { $browserCapabilities, $browserConsoleOpen } from '@/store/browser'
import { $previewCaps, $previewModes, previewCaps, previewMode, setPreviewMode } from '@/store/preview-view'

// The glyphs are read during the strip's render, so a mode flip or a finished
// load has to tell it to read again. Module-level: one subscription for the
// whole app, not one per open preview.
$previewModes.listen(() => invalidateStripTools())
$previewCaps.listen(() => invalidateStripTools())
// Same reason for the browser tab: its glyphs mirror live state (is the console
// open, does this platform have DevTools at all), read during the strip's render.
$browserConsoleOpen.listen(() => invalidateStripTools())
$browserCapabilities.listen(() => invalidateStripTools())

/**
 * The browser tab's strip glyphs.
 *
 * Takes no path on purpose: there is exactly one browser tab, and passing its
 * path would imply a second could exist.
 */
export function browserStripTools(): readonly PaneStripTool[] {
  const consoleOpen = $browserConsoleOpen.get()
  const caps = $browserCapabilities.get()

  const tools: PaneStripTool[] = [
    {
      active: consoleOpen,
      icon: <Codicon name="terminal" size="0.8125rem" />,
      id: 'browser-console',
      label: translateNow(consoleOpen ? 'preview.web.hideConsole' : 'preview.web.showConsole'),
      onSelect: () => $browserConsoleOpen.set(!consoleOpen)
    }
  ]

  // Hidden, not disabled, where the platform has none: a release desktop build
  // has no inspector at all, and Android/iOS use chrome://inspect and Safari's
  // Web Inspector, both external.
  if (caps?.devtools) {
    tools.push({
      icon: <Codicon name="debug" size="0.8125rem" />,
      id: 'browser-devtools',
      label: translateNow('preview.web.openDevTools'),
      onSelect: () => void openGuestDevtools().catch(() => undefined)
    })
  }

  return tools
}

/** The view-mode switch for one preview, as strip-tool DATA. */
export function previewStripTools(path: string): readonly PaneStripTool[] {
  const caps = previewCaps(path)
  const mode = previewMode(path)

  return [
    {
      active: mode === 'source',
      disabled: !caps?.source,
      icon: <Codicon name="code" size="0.8125rem" />,
      id: 'preview-source',
      label: translateNow('preview.source'),
      onSelect: () => setPreviewMode(path, 'source')
    },
    {
      active: mode === 'rendered',
      disabled: !caps?.rendered,
      icon: <Codicon name="book" size="0.8125rem" />,
      id: 'preview-rendered',
      label: translateNow('preview.renderedPreview'),
      onSelect: () => setPreviewMode(path, 'rendered')
    },
    {
      active: mode === 'diff',
      // A diff is a git question, not a content one — it stands even for a file
      // the viewer can't render, so it needs no capability behind it.
      icon: <Codicon name="git-compare" size="0.8125rem" />,
      id: 'preview-diff',
      label: translateNow('preview.diff'),
      onSelect: () => setPreviewMode(path, 'diff')
    }
  ]
}
