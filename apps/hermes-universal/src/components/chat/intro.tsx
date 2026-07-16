import { useLayoutEffect, useRef, useState } from 'react'

const WORDMARK = 'HERMES AGENT'

// The opening message is PINNED — it renders identically every time (no random
// rotation, no personality variation). Fixed to the neutral "Drop a file…" copy.
const OPENING_BODY =
  "Drop a file path, a traceback, or a rough idea. I'll investigate, suggest next steps, and keep things reversible."

// Wordmark fills its column width like desktop. Desktop does this with a CSS
// container-query + trig (`tan`/`atan2`) fit that the Linux WebKitGTK webview
// doesn't render large, so it's measured in JS instead: same visual result
// (scale the font so the wordmark's natural width == the available width),
// robust on every platform. Bounds keep it sane on very narrow / very wide.
const MIN_PX = 44
const MAX_PX = 160

export function Intro() {
  const wrapRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLSpanElement>(null)
  const [fontPx, setFontPx] = useState(MIN_PX)

  useLayoutEffect(() => {
    const wrap = wrapRef.current
    const text = textRef.current
    if (!wrap || !text) return

    const fit = () => {
      const avail = wrap.clientWidth
      const natural = text.scrollWidth
      if (!avail || !natural) return
      const current = parseFloat(getComputedStyle(text).fontSize) || MIN_PX
      // Text width scales linearly with font-size, so one measurement fits it.
      const target = Math.max(MIN_PX, Math.min(MAX_PX, (avail / natural) * current))
      setFontPx(prev => (Math.abs(prev - target) > 0.5 ? target : prev))
    }

    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(wrap)

    return () => observer.disconnect()
  }, [])

  return (
    <div
      className="pointer-events-none flex w-full min-w-0 flex-col items-center justify-center px-0.5 py-6 text-center text-muted-foreground sm:px-6 lg:px-8"
      data-slot="aui_intro"
    >
      <div className="w-full min-w-0">
        <div className="mx-auto mb-1 w-[calc(100%-1rem)]" ref={wrapRef}>
          <p
            aria-label={WORDMARK}
            className="m-0 text-center font-['Collapse'] font-bold uppercase leading-[0.9] tracking-[0.08em] text-midground mix-blend-plus-lighter dark:text-foreground/90"
            style={{ fontSize: `${fontPx}px`, whiteSpace: 'nowrap' }}
          >
            <span ref={textRef}>{WORDMARK}</span>
          </p>
        </div>

        <p className="m-0 text-center leading-normal tracking-tight">{OPENING_BODY}</p>
      </div>
    </div>
  )
}
