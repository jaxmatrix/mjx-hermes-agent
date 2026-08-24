import '@/app/context-menu/targets/dom'
import '@/app/context-menu/targets/terminal'

import { Fragment, useEffect, useMemo } from 'react'

import { noteComposition } from '@/app/context-menu/actions'
import type { ContextMenuItemsContribution } from '@/app/context-menu/contrib'
import { CONTEXT_MENU_ITEMS_AREA, CONTEXT_MENU_MAX_ITEMS, CONTEXT_MENU_MAX_SECTIONS } from '@/app/context-menu/contrib'
import { CONTEXT_MENU_SKIP_ATTR, RADIX_TRIGGER_SELECTOR } from '@/app/context-menu/markers'
import type {
  ContextGesture,
  ContextMenuItemContext,
  ContextMenuItemSpec,
  ContextMenuSection,
  ContextTargetMatch
} from '@/app/context-menu/registry'
import { classifyGesture, contextTargetProvider } from '@/app/context-menu/registry'
import { $contextMenu, applyClipboardProbe, closeContextMenu, openContextMenu } from '@/app/context-menu/store'
import type { ContextMenuDomTarget } from '@/app/context-menu/target'
import type { TerminalMenuHandle } from '@/app/right-pane/terminal/context-menu'
import { DROPDOWN_KIT, renderActionItem } from '@/components/ui/actions-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ContribBoundary } from '@/contrib/react/boundary'
import { useContributions } from '@/contrib/react/use-contributions'
import { useI18n } from '@/i18n'
import { readClipboardText } from '@/lib/clipboard'
import { triggerHaptic } from '@/lib/haptics'
import { createLongPress } from '@/lib/long-press'
import { readKeyboardInset } from '@/lib/safe-area'
import { isCoarsePointer, TAP_MAX_MS } from '@/lib/touch'
import { useStore } from '@/store/atom'

/**
 * The app-wide context menu: ONE capture-phase coordinator per webview.
 *
 * Desktop (Electron) shipped this by NEVER calling `preventDefault()` —
 * Chromium's main-process `context-menu` event was its spellcheck and
 * image-bytes source, and with no `Menu.popup` anywhere "default" already meant
 * "no menu". On Tauri that inverts: WebKitGTK, WKWebView, WebView2 and the
 * Android WebView all pop their OWN menu for an unprevented gesture, so
 * universal must prevent it — and therefore loses the channel desktop got its
 * late facts from. `bridge.ts` is where those come back from the embedder in v2;
 * v1 is JS-only and says so.
 *
 * Mounted in `App()` beside `ConfirmHost` rather than one level down: the HUD,
 * Quick Entry, a detached tile and the Android/iOS activity screen are each a
 * separate webview, and a root that forgot this falls back to the platform menu
 * with no other symptom.
 */

/** Keeps the menu clear of the viewport edge (and of the soft keyboard). */
const MENU_EDGE_PADDING = 8

/** One gesture, one detector — the pointerdown check that cancels ours. */
const GESTURE_STANDDOWN_SELECTOR = `${RADIX_TRIGGER_SELECTOR}, [${CONTEXT_MENU_SKIP_ATTR}]`

let listenersInstalled = false

/** Only an editable and a live PTY can paste — nothing else pays the OS round trip. */
function needsClipboard(match: ContextTargetMatch): boolean {
  if (match.kind === 'dom') {
    return (match.data as ContextMenuDomTarget).editable !== null
  }

  return match.kind === 'terminal' && (match.data as TerminalMenuHandle).paste !== null
}

/**
 * Is the press landing on live selected text?
 *
 * On Android the platform's selection ActionMode (with its drag handles) is NOT
 * suppressed by `preventDefault()` on `contextmenu`, and killing it needs a
 * Kotlin change that would also break selection in the composer and the
 * terminal. So a long press on a selection keeps the OS affordance and the
 * Hermes menu stands down — the decision the owner took for v1. Images, links,
 * the terminal and every Radix row are unaffected.
 */
function pressLandsOnSelection(element: Element | null): boolean {
  const selection = window.getSelection()

  if (!element || !selection || selection.isCollapsed || !selection.toString().trim()) {
    return false
  }

  return typeof selection.containsNode === 'function' ? selection.containsNode(element, true) : true
}

/** Classify, decide whether we own the gesture, and open. Returns whether we did. */
function openForGesture(gesture: ContextGesture): boolean {
  const failed: string[] = []
  const match = classifyGesture(gesture, kind => failed.push(kind))

  if (!match) {
    return false
  }

  if (match.kind === 'dom') {
    const data = match.data as ContextMenuDomTarget
    const owned = Boolean(data.linkUrl || data.onImage || data.editable || data.selectionText)

    // Checked AFTER classification, not before: the reaction bubble keeps its
    // PLAIN right-click, but a link or a selection inside it is still ours.
    if (!owned && gesture.element?.closest(`[${CONTEXT_MENU_SKIP_ATTR}]`)) {
      return false
    }

    if (gesture.source === 'longpress' && !data.linkUrl && !data.onImage && pressLandsOnSelection(gesture.element)) {
      return false
    }
  }

  const inset = readKeyboardInset()

  const id = openContextMenu({
    failed,
    gesture,
    match,
    source: gesture.source,
    x: gesture.x,
    // A menu anchored at the finger sits BEHIND the soft keyboard otherwise
    // (rule 32) — the composer is the surface this matters most for.
    y: inset > 0 ? Math.min(gesture.y, window.innerHeight - inset - MENU_EDGE_PADDING) : gesture.y
  })

  if (needsClipboard(match)) {
    // Never blocks the open: the plugin call is an OS round trip and the menu
    // has to be on screen in the same frame as the gesture. Paste is greyed
    // until this lands, and a probe that resolves after a NEWER menu opened is
    // dropped by the id guard.
    void readClipboardText().then(text => applyClipboardProbe(id, text.length > 0))
  }

  return true
}

function installGestureListeners(): () => void {
  // A second coordinator in the same webview would double-handle every gesture.
  if (listenersInstalled || typeof window === 'undefined') {
    return () => undefined
  }

  listenersInstalled = true

  let suppressUntil = 0

  const press = createLongPress({
    onFire: ({ x, y }) => {
      if (!isCoarsePointer()) {
        return
      }

      if (openForGesture({ element: document.elementFromPoint(x, y), source: 'longpress', x, y })) {
        // Belt and braces beside `press.fired()`: some engines emit the
        // trailing `contextmenu` only after the next pointerdown has reset it.
        suppressUntil = Date.now() + TAP_MAX_MS
        triggerHaptic('selection')
      }
    }
  })

  const onContextMenu = (event: MouseEvent) => {
    // The ⌃Tab switcher's own capture listener may run before or after this one
    // (registration order, and it is installed by a hook one level down), so
    // ordering is made irrelevant instead of assumed.
    if (event.defaultPrevented) {
      return
    }

    const element = event.target instanceof Element ? event.target : null

    // Checked FIRST among the markers: the 13 per-surface Radix menus keep their
    // whole gesture, untouched. This is why the `2d6d7c550f` marker port is not
    // optional — without it an `asChild` child that sets its own `data-slot`
    // is invisible here.
    if (element?.closest(RADIX_TRIGGER_SELECTOR)) {
      return
    }

    if (press.fired() || Date.now() < suppressUntil) {
      // CONSUME the suppression. `fired()` stays true until the next `down()`,
      // and a fine pointer never arms one — so leaving it set would swallow
      // every later right-click on a touchscreen laptop that once long-pressed.
      press.cancel()
      suppressUntil = 0
      event.preventDefault()

      return
    }

    // The ContextMenu key / Shift+F10 produces a real `contextmenu` with
    // `button: 0`, so it comes through here for free.
    const source = event.button === 0 ? 'keyboard' : 'mouse'

    if (openForGesture({ element, source, x: event.clientX, y: event.clientY })) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  const onPointerDown = (event: PointerEvent) => {
    if (!isCoarsePointer()) {
      return
    }

    const element = event.target instanceof Element ? event.target : null

    // Surfaces with their own long-press story (the profile square, the mobile
    // review row) keep it — two detectors on one finger is the failure this
    // avoids. One `closest()` per press, not per move.
    if ($contextMenu.get() || element?.closest(GESTURE_STANDDOWN_SELECTOR)) {
      press.cancel()

      return
    }

    press.down(event.clientX, event.clientY)
  }

  const onPointerMove = (event: PointerEvent) => press.move(event.clientX, event.clientY)
  const onPointerUp = () => press.up()

  const onScroll = (event: Event) => {
    // A menu with more rows than fit scrolls itself; that must not dismiss it.
    if (event.target instanceof Element && event.target.closest('[data-slot="dropdown-menu-content"]')) {
      return
    }

    // A menu pinned over a page that scrolled out from under it points at
    // nothing, so a finger that keeps moving closes it.
    press.cancel()
    closeContextMenu()
  }

  // Route changes close it too, read off the URL rather than off `useLocation`:
  // this component mounts in EVERY window root, and a satellite root that has no
  // Router around it would crash on the hook. `hashchange` is what HashRouter
  // navigations actually produce.
  const onHide = () => closeContextMenu()
  const onCompositionStart = () => noteComposition(true)
  const onCompositionEnd = () => noteComposition(false)

  window.addEventListener('contextmenu', onContextMenu, { capture: true })
  window.addEventListener('pointerdown', onPointerDown, { capture: true })
  window.addEventListener('pointermove', onPointerMove, { capture: true })
  window.addEventListener('pointerup', onPointerUp, { capture: true })
  window.addEventListener('pointercancel', onPointerUp, { capture: true })
  window.addEventListener('scroll', onScroll, { capture: true, passive: true })
  window.addEventListener('blur', onHide)
  window.addEventListener('hashchange', onHide)
  window.addEventListener('popstate', onHide)
  window.addEventListener('compositionstart', onCompositionStart, { capture: true })
  window.addEventListener('compositionend', onCompositionEnd, { capture: true })
  document.addEventListener('visibilitychange', onHide)

  return () => {
    listenersInstalled = false
    press.cancel()
    window.removeEventListener('contextmenu', onContextMenu, { capture: true })
    window.removeEventListener('pointerdown', onPointerDown, { capture: true })
    window.removeEventListener('pointermove', onPointerMove, { capture: true })
    window.removeEventListener('pointerup', onPointerUp, { capture: true })
    window.removeEventListener('pointercancel', onPointerUp, { capture: true })
    window.removeEventListener('scroll', onScroll, { capture: true })
    window.removeEventListener('blur', onHide)
    window.removeEventListener('hashchange', onHide)
    window.removeEventListener('popstate', onHide)
    window.removeEventListener('compositionstart', onCompositionStart, { capture: true })
    window.removeEventListener('compositionend', onCompositionEnd, { capture: true })
    document.removeEventListener('visibilitychange', onHide)
    closeContextMenu()
  }
}

function renderRow(spec: ContextMenuItemSpec, fallbackKey: string) {
  const { shortcut, ...rest } = spec
  const key = rest.key ?? (typeof rest.label === 'string' ? rest.label : fallbackKey)

  if (!shortcut) {
    return renderActionItem(DROPDOWN_KIT, { ...rest, key })
  }

  // Accelerators are DISPLAY ONLY — the engine already runs the chord, and
  // re-dispatching it would double the edit.
  return renderActionItem(DROPDOWN_KIT, {
    ...rest,
    key,
    label: (
      <>
        <span>{rest.label}</span>
        <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut>
      </>
    )
  })
}

export function AppContextMenu() {
  const { t } = useI18n()
  const open = useStore($contextMenu)
  const contributions = useContributions(CONTEXT_MENU_ITEMS_AREA)

  useEffect(installGestureListeners, [])

  const built = useMemo(() => {
    if (!open) {
      return { failed: [] as string[], plugin: [] as ContextMenuSection[], sections: [] as ContextMenuSection[] }
    }

    const context: ContextMenuItemContext = {
      clipboardHasText: open.clipboardHasText,
      close: closeContextMenu,
      data: open.match.data,
      gesture: open.gesture,
      native: open.native,
      t
    }

    const failed = [...open.failed]
    const provider = contextTargetProvider(open.match.kind)
    let sections: ContextMenuSection[] = []

    try {
      sections = provider?.items(context as ContextMenuItemContext<never>) ?? []
    } catch {
      failed.push(open.match.kind)
    }

    const plugin: ContextMenuSection[] = []

    for (const contribution of contributions) {
      const payload = contribution.data as ContextMenuItemsContribution | undefined

      if (typeof payload?.provide !== 'function') {
        continue
      }

      if (payload.targets && !payload.targets.includes(open.match.kind)) {
        continue
      }

      try {
        // Bounded so one plugin cannot make the menu unusable; the overflow is
        // dropped rather than rendered off-screen.
        for (const section of payload.provide(context).slice(0, CONTEXT_MENU_MAX_SECTIONS)) {
          plugin.push(section.slice(0, CONTEXT_MENU_MAX_ITEMS))
        }
      } catch {
        failed.push(contribution.id)
      }
    }

    return { failed, plugin, sections }
  }, [contributions, open, t])

  if (!open) {
    return null
  }

  const builtIn = built.sections.filter(section => section.length > 0)
  const plugin = built.plugin.filter(section => section.length > 0)

  const renderSections = (sections: ContextMenuSection[], offset: number) =>
    sections.map((section, index) => (
      <Fragment key={offset + index}>
        {offset + index > 0 && <DropdownMenuSeparator />}
        {section.map((spec, itemIndex) => renderRow(spec, `${offset + index}-${itemIndex}`))}
      </Fragment>
    ))

  return (
    <DropdownMenu modal={false} onOpenChange={next => !next && closeContextMenu()} open>
      <DropdownMenuTrigger asChild>
        <span aria-hidden className="fixed h-0 w-0" style={{ left: `${open.x}px`, top: `${open.y}px` }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        collisionPadding={MENU_EDGE_PADDING}
        onCloseAutoFocus={event => event.preventDefault()}
        side="bottom"
        sideOffset={2}
      >
        {renderSections(builtIn, 0)}
        {plugin.length > 0 && (
          // Rule 27: a contribution that throws while RENDERING (not while
          // providing) degrades to an inline error row instead of taking the
          // menu — and with it the window's whole overlay tree — down.
          <ContribBoundary id={CONTEXT_MENU_ITEMS_AREA} variant="chip">
            {renderSections(plugin, builtIn.length)}
          </ContribBoundary>
        )}
        {built.failed.length > 0 && (
          <>
            <DropdownMenuSeparator />
            {renderRow(
              {
                disabled: true,
                key: 'context-menu-failed',
                label: t.contextMenu.someItemsFailed,
                onSelect: () => undefined
              },
              'failed'
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
