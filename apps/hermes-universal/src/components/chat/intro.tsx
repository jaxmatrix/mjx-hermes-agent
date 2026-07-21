import { type CSSProperties, useLayoutEffect, useRef, useState } from 'react'

const WORDMARK = 'HERMES AGENT'

// The opening message is PINNED — it renders identically every time (no random
// rotation, no personality variation). Fixed to the neutral "Drop a file…" copy.
const OPENING_BODY =
  "Drop a file path, a traceback, or a rough idea. I'll investigate, suggest next steps, and keep things reversible."

// Desktop fills the wordmark to its column width with a CSS container-query +
// trig (tan/atan2) fit that the Linux WebKitGTK webview won't render large. We
// reproduce the SAME result in JS: a hidden twin measures the wordmark's natural
// width at a fixed reference size, and the visible wordmark is scaled so its
// width == the available column width. Re-fits on resize and once the Collapse
// webfont swaps in. Bounds keep it sane on very narrow / very wide columns.
const REF_PX = 100
const MIN_PX = 44
const MAX_PX = 200

const WORDMARK_METRICS = "font-['Collapse'] font-bold uppercase tracking-[0.08em]"

export function Intro() {
  const fillRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLSpanElement>(null)
  const [fontPx, setFontPx] = useState(0) // 0 = not measured yet (wordmark hidden)

  useLayoutEffect(() => {
    const fill = fillRef.current
    const measure = measureRef.current

    if (!fill || !measure) {
      return
    }

    const fit = () => {
      const avail = fill.clientWidth
      const natural = measure.getBoundingClientRect().width // width at REF_PX

      if (avail > 0 && natural > 0) {
        setFontPx(Math.max(MIN_PX, Math.min(MAX_PX, (avail / natural) * REF_PX)))
      }
    }

    fit()
    const raf = requestAnimationFrame(fit)
    const observer = new ResizeObserver(fit)
    observer.observe(fill)

    // The webfont changes the measured width; re-fit once it's ready.
    let cancelled = false

    if (typeof document !== 'undefined' && document.fonts?.ready) {
      void document.fonts.ready.then(() => {
        if (!cancelled) {
          fit()
        }
      })
    }

    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      observer.disconnect()
    }
  }, [])

  return (
    <div
      className="pointer-events-none flex w-full min-w-0 flex-col items-center justify-center px-0.5 py-6 text-center text-muted-foreground sm:px-6 lg:px-8"
      data-slot="aui_intro"
      style={{ paddingBottom: 'var(--composer-measured-height)' }}
    >
      <div className="mx-auto w-full min-w-0 max-w-[min(var(--composer-width),82vw)]">
        <div className="mx-auto mb-1 w-[calc(100%-1rem)]" ref={fillRef}>
          <p
            aria-label={WORDMARK}
            className={`m-0 text-center leading-[0.9] text-midground mix-blend-plus-lighter dark:text-foreground/90 ${WORDMARK_METRICS}`}
            style={
              {
                fontSize: `${fontPx || MIN_PX}px`,
                whiteSpace: 'nowrap',
                visibility: fontPx ? 'visible' : 'hidden'
              } as CSSProperties
            }
          >
            {WORDMARK}
          </p>
        </div>

        <p className="m-0 mx-auto max-w-[34rem] text-center text-[0.875rem] leading-[1.45] tracking-tight text-(--ui-text-tertiary)">
          {OPENING_BODY}
        </p>
      </div>

      {/* Hidden twin — same font metrics as the wordmark, at a fixed reference
          size — measured to scale the visible wordmark. Kept in layout (not
          display:none) so getBoundingClientRect() is valid. */}
      <span
        aria-hidden
        className={WORDMARK_METRICS}
        ref={measureRef}
        style={{
          fontSize: `${REF_PX}px`,
          left: '-9999px',
          pointerEvents: 'none',
          position: 'absolute',
          top: 0,
          visibility: 'hidden',
          whiteSpace: 'nowrap'
        }}
      >
        {WORDMARK}
      </span>
    </div>
  )
}
