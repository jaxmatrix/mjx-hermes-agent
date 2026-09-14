import { useRef } from 'react'

import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import { openExternalLink, shortHostLabel } from '@/lib/external-link'
import { createTap } from '@/lib/touch'
import { useStore } from '@/store/atom'
import { $browserState, browserReload, closeInAppBrowser } from '@/store/browser'

/**
 * The phone's browser chrome, and deliberately the WHOLE of it.
 *
 * v1 is an overlay that says which page you are on and offers the two verbs
 * that matter when the answer is "not this one": reload, and hand it to the
 * system browser — which on a phone has the user's logins and password manager,
 * so it is the honest escape hatch rather than a fallback.
 *
 * There is no address bar. A 44 pt always-visible field costs ~12 % of a phone
 * viewport, and on this surface the URL is nearly always one the AGENT opened
 * or one the user tapped, not one they typed.
 *
 * Anchored above `--keyboard-inset`: a fixed/portalled surface sits BEHIND the
 * soft keyboard otherwise, and this bar is at the bottom precisely so it is in
 * thumb reach.
 *
 * Every control is a `createTap`, not an `onClick`. On Android a click is a
 * gesture VERDICT the WebView routinely rules against for a quick jab, so a
 * short tap on a small target silently does nothing.
 */
export function MobileBrowserOverlay() {
  const { t } = useI18n()
  const page = useStore($browserState)

  return (
    <div
      className="pointer-events-none absolute inset-x-0 z-10 flex justify-center px-3"
      style={{ bottom: 'calc(var(--keyboard-inset, 0px) + 0.75rem)' }}
    >
      <div className="pointer-events-auto flex max-w-full items-center gap-1 rounded-full border border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated)/95 py-1 ps-3 pe-1 shadow-lg backdrop-blur">
        <span className="min-w-0 truncate text-xs" title={page.url}>
          {page.title || shortHostLabel(page.url) || page.url}
        </span>

        <TapButton label={t.browser.reload} name="refresh" onTap={() => void browserReload()} />
        <TapButton
          label={t.browser.openExternally}
          name="link-external"
          onTap={() => void openExternalLink(page.url)}
        />
        <TapButton label={t.preview.closePane} name="close" onTap={closeInAppBrowser} />
      </div>
    </div>
  )
}

/** 44 px of target under a 13 px glyph — the platform minimum, not the icon's size. */
function TapButton({ label, name, onTap }: { label: string; name: string; onTap: () => void }) {
  const tapRef = useRef<null | ReturnType<typeof createTap>>(null)

  if (!tapRef.current) {
    tapRef.current = createTap({ onTap })
  }

  const tap = tapRef.current

  return (
    <button
      aria-label={label}
      className="flex size-11 shrink-0 items-center justify-center rounded-full active:bg-(--ui-control-active-background)"
      onClick={onTap}
      onClickCapture={event => {
        // The tap already resolved this gesture; a synthetic click behind it
        // would run the verb twice.
        if (tap.fired()) {
          event.stopPropagation()
        }
      }}
      onPointerCancel={tap.cancel}
      onPointerDown={tap.down}
      onPointerMove={tap.move}
      onPointerUp={tap.up}
      type="button"
    >
      <Codicon name={name} size="0.9375rem" />
    </button>
  )
}
