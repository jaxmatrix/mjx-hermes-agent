import { useEffect, useRef, useState } from 'react'

import { CONTEXT_MENU_SKIP_ATTR } from '@/app/context-menu/markers'
import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import { resolveHermesOpenPath } from '@/lib/hermes-open-target'
import { openExternalLink } from '@/lib/external-link'
import { writeClipboardText } from '@/lib/clipboard'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import {
  $browserCapabilities,
  $browserConsoleOpen,
  $browserState,
  browserBack,
  browserForward,
  browserReload,
  browserStop,
  submitBrowserAddress
} from '@/store/browser'
import { navigateDeepLinkPath } from '@/store/deep-link'
import { openGuestDevtools } from '@/lib/browser/host'

/**
 * back · forward · reload/stop · address · copy · open externally · console ·
 * DevTools — in that order, because it is the order every browser uses and a
 * different one costs the user a moment of hunting on a surface they already
 * know.
 */
export function BrowserBar() {
  const { t } = useI18n()
  const page = useStore($browserState)
  const caps = useStore($browserCapabilities)
  const consoleOpen = useStore($browserConsoleOpen)
  const [draft, setDraft] = useState<null | string>(null)
  const [invalid, setInvalid] = useState(false)
  const input = useRef<HTMLInputElement | null>(null)

  // The field TRACKS the page while idle (`draft === null`) and holds the
  // user's typing while it isn't — so a page that navigates itself never
  // clobbers a half-typed address, and a half-typed address never survives
  // being abandoned.
  useEffect(() => {
    if (draft === null) {
      setInvalid(false)
    }
  }, [draft, page.url])

  const value = draft ?? page.url

  const commit = async () => {
    const typed = (draft ?? '').trim()

    if (!typed) {
      setDraft(null)

      return
    }

    // `hermes://…` navigates the APP, not the guest. Checked BEFORE
    // normalising, which also removes the footgun of it reading as an unknown
    // protocol and silently doing nothing.
    const deepLink = resolveHermesOpenPath(typed)

    if (deepLink) {
      navigateDeepLinkPath(deepLink)
      setDraft(null)
      input.current?.blur()

      return
    }

    const ok = await submitBrowserAddress(typed)

    if (!ok) {
      setInvalid(true)

      return
    }

    setDraft(null)
    input.current?.blur()
  }

  return (
    <div className="flex items-center gap-1 border-b border-subtle px-1 py-1" data-browser-bar="">
      <BarButton
        disabled={!page.canBack}
        icon="arrow-left"
        label={t.browser.back}
        onSelect={() => void browserBack()}
      />
      <BarButton
        disabled={!page.canForward}
        icon="arrow-right"
        label={t.browser.forward}
        onSelect={() => void browserForward()}
      />
      <BarButton
        icon={page.loading ? 'close' : 'refresh'}
        label={page.loading ? t.browser.stop : t.browser.reload}
        onSelect={() => void (page.loading ? browserStop() : browserReload())}
      />

      <div className="relative min-w-0 flex-1">
        <input
          // The address field gets the NATIVE editable menu, not the app
          // coordinator's — copy/paste/select-all in a text field is the one
          // place the platform's own menu is better than ours.
          {...{ [CONTEXT_MENU_SKIP_ATTR]: '' }}
          aria-invalid={invalid || undefined}
          aria-label={t.browser.addressLabel}
          className={cn(
            'w-full rounded-md bg-layer-2 px-2 py-1 pr-7 font-mono text-xs outline-none',
            invalid && 'ring-1 ring-red-500'
          )}
          onBlur={() => setDraft(null)}
          onChange={event => {
            setDraft(event.target.value)
            setInvalid(false)
          }}
          onFocus={event => {
            setDraft(page.url)
            event.target.select()
          }}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void commit()
            }

            if (event.key === 'Escape') {
              event.preventDefault()
              setDraft(null)
              input.current?.blur()
            }
          }}
          placeholder={t.browser.addressPlaceholder}
          ref={input}
          spellCheck={false}
          value={value}
        />
        <button
          aria-label={t.browser.copyUrl}
          className="absolute inset-y-0 right-1 flex items-center opacity-60 hover:opacity-100"
          onClick={() => void writeClipboardText(page.url)}
          type="button"
        >
          <Codicon name="copy" size="0.75rem" />
        </button>
      </div>

      <BarButton
        icon="link-external"
        label={t.browser.openExternally}
        onSelect={() => void openExternalLink(page.url)}
      />
      <BarButton
        active={consoleOpen}
        icon="terminal"
        label={consoleOpen ? t.preview.web.hideConsole : t.preview.web.showConsole}
        onSelect={() => $browserConsoleOpen.set(!consoleOpen)}
      />
      {caps?.devtools ? (
        <BarButton
          icon="debug"
          label={t.preview.web.openDevTools}
          onSelect={() => void openGuestDevtools().catch(() => undefined)}
        />
      ) : null}
    </div>
  )
}

function BarButton({
  active,
  disabled,
  icon,
  label,
  onSelect
}: {
  active?: boolean
  disabled?: boolean
  icon: string
  label: string
  onSelect: () => void
}) {
  return (
    <button
      aria-label={label}
      className={cn(
        'flex h-6 w-6 shrink-0 items-center justify-center rounded-md hover:bg-layer-2',
        active && 'bg-layer-2',
        disabled && 'pointer-events-none opacity-35'
      )}
      disabled={disabled}
      onClick={onSelect}
      title={label}
      type="button"
    >
      <Codicon name={icon} size="0.8125rem" />
    </button>
  )
}
