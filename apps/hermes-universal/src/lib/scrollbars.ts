import { OverlayScrollbars, type PartialOptions } from 'overlayscrollbars'
import { useEffect } from 'react'

import { IS_DESKTOP } from './platform'

// Every vertical scroll surface in the app. Tailwind emits these class names
// verbatim, so a `[class~=...]` match finds them without touching each file;
// `.completion-drawer` scrolls via plain CSS (styles.css), so it's listed too.
const SELECTOR = '[class~="overflow-y-auto"],[class~="overflow-auto"],[class~="overflow-y-scroll"],.completion-drawer'

const OPTIONS: PartialOptions = {
  // Always-visible thin bar, matching desktop (not GTK's auto-hide overlay).
  scrollbars: { theme: 'os-theme-hermes', autoHide: 'never' }
}

/**
 * Desktop-only custom scrollbars. Tauri's WebKitGTK webview ignores
 * `::-webkit-scrollbar` (hence GTK's arrowed, chunky bar), so we draw scrollbars
 * with OverlayScrollbars instead. Initialized in "viewport is target" mode
 * (`elements: { viewport: el }`) so the element keeps its NATIVE scroll — vital
 * for the assistant-ui thread, whose autoScroll writes scrollTop directly. A
 * MutationObserver picks up overlays (sheets/dialogs/dropdowns) as they mount;
 * instances whose target detaches are destroyed so nothing leaks.
 */
export function useThemedScrollbars(): void {
  useEffect(() => {
    if (!IS_DESKTOP) {
      return
    }

    const instances = new Set<OverlayScrollbars>()

    const scan = () => {
      for (const inst of instances) {
        if (!document.contains(inst.elements().target)) {
          inst.destroy()
          instances.delete(inst)
        }
      }
      document.querySelectorAll<HTMLElement>(SELECTOR).forEach(el => {
        // Elements that own their own scroll management must NOT be wrapped:
        //  - the composer's contentEditable rich input — OverlayScrollbars injects
        //    viewport + os-scrollbar child divs and manages it as a viewport,
        //    which corrupts contentEditable editing/layout (the input collapses to
        //    ~1px so it can't be typed into);
        //  - the chat thread viewport — it's the `use-stick-to-bottom` scroller;
        //    OverlayScrollbars preserves/restores scrollTop on its resize `update`,
        //    fighting the stick-to-bottom re-anchor so the thread jumps to a stale
        //    scroll position whenever the pane/window resizes.
        // Both keep native scrolling. Destroy any instance that already attached.
        const slot = el.getAttribute('data-slot')
        if (el.isContentEditable || slot === 'composer-rich-input' || slot === 'aui_thread-viewport') {
          const existing = OverlayScrollbars(el)
          if (existing) {
            existing.destroy()
            instances.delete(existing)
          }
          return
        }
        if (OverlayScrollbars(el)) {
          return
        }
        // Skip portaled overlay boxes (dialog / sheet content): they are
        // `position: fixed` + `translate(-50%,-50%)`-centered, and initializing
        // OverlayScrollbars on that positioned box breaks its centering (the
        // dialog drops down the screen). Their inner scrollers stay static and
        // are still themed; genuine scrollers (sidebar, thread, completion
        // drawer) are static/relative/absolute, never fixed.
        if (getComputedStyle(el).position === 'fixed') {
          return
        }
        instances.add(OverlayScrollbars({ target: el, elements: { viewport: el } }, OPTIONS))
      })
    }

    scan()

    // Debounce: the thread mutates constantly while streaming; the getInstance
    // dedup keeps re-scans cheap, but coalescing avoids churn.
    let timer = 0
    const observer = new MutationObserver(() => {
      if (timer) {
        return
      }
      timer = window.setTimeout(() => {
        timer = 0
        scan()
      }, 150)
    })
    observer.observe(document.body, { childList: true, subtree: true })

    return () => {
      observer.disconnect()
      if (timer) {
        window.clearTimeout(timer)
      }
      instances.forEach(inst => inst.destroy())
      instances.clear()
    }
  }, [])
}
