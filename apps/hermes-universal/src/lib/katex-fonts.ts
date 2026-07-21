// KaTeX ships its 20 `@font-face` rules with `font-display: block` — the
// browser paints the glyphs INVISIBLY until the face finishes loading (a block
// period of up to ~3s), and the faces are only requested when math first
// paints. On Electron/Chromium the local woff2 resolve in milliseconds so
// nobody sees it; on WebKitGTK (what Tauri embeds) the first fetch is slow
// enough that opening a math-heavy chat showed a blank gap for over a second
// before the equations snapped in.
//
// So warm every face up front, off the boot path. Same trick — and the same
// reason — as the terminal's JetBrains Mono warm-up on desktop
// (right-sidebar/terminal/use-terminal-session.ts): `document.fonts.ready`
// only settles faces something already ASKED for, so a face nothing has
// painted yet is not covered by it.
//
// All 20 files are bundled locally and total ~250 KB, so warming the whole set
// (rather than guessing which symbols a chat will use) costs one idle moment
// and removes the tail case where an exotic glyph — Fraktur, Script — is the
// one that blanks.

// `<style> <weight> <size> <family>` shorthand, one per @font-face in
// katex.min.css. None of them declare a unicode-range, so the default probe
// text matches and each entry really does trigger its fetch.
const KATEX_FACES = [
  '400 16px KaTeX_AMS',
  '400 16px KaTeX_Caligraphic',
  '700 16px KaTeX_Caligraphic',
  '400 16px KaTeX_Fraktur',
  '700 16px KaTeX_Fraktur',
  '400 16px KaTeX_Main',
  '700 16px KaTeX_Main',
  'italic 400 16px KaTeX_Main',
  'italic 700 16px KaTeX_Main',
  'italic 400 16px KaTeX_Math',
  'italic 700 16px KaTeX_Math',
  '400 16px KaTeX_SansSerif',
  '700 16px KaTeX_SansSerif',
  'italic 400 16px KaTeX_SansSerif',
  '400 16px KaTeX_Script',
  '400 16px KaTeX_Size1',
  '400 16px KaTeX_Size2',
  '400 16px KaTeX_Size3',
  '400 16px KaTeX_Size4',
  '400 16px KaTeX_Typewriter'
] as const

function whenIdle(run: () => void): void {
  if (typeof window === 'undefined') {
    return
  }

  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(run, { timeout: 2_000 })

    return
  }

  window.setTimeout(run, 0)
}

let warmed = false

/**
 * Load every KaTeX face so the first equation paints immediately instead of
 * spending KaTeX's `font-display: block` window invisible. Idempotent,
 * best-effort, and never rejects — a face that fails to load simply keeps the
 * behavior we have today.
 */
export function warmKatexFonts(): void {
  if (warmed || typeof document === 'undefined' || typeof document.fonts?.load !== 'function') {
    return
  }

  warmed = true

  whenIdle(() => {
    // `fonts.ready` first: in dev the stylesheet is injected by Vite's client
    // AFTER this module runs, and loading a family the document doesn't declare
    // yet matches zero faces and silently no-ops.
    const ready = document.fonts.ready ?? Promise.resolve()

    void ready.then(() => Promise.allSettled(KATEX_FACES.map(face => document.fonts.load(face)))).catch(() => undefined)
  })
}
