import '@xterm/xterm/css/xterm.css'

import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import { useEffect, useRef, useState } from 'react'

import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { $effectiveCwd } from '@/store/workspace-events'
import { useTheme } from '@/themes/context'
import type { DesktopTheme } from '@/themes/types'
import { LocalPtySocket } from '@/transport/local-pty'

import { terminalTheme, withSurface } from './terminal-theme'

// The right-pane integrated terminal. Renders a LOCAL shell (spawned natively in
// Rust via portable-pty — see src-tauri/src/pty.rs) into xterm, mirroring the
// desktop node-pty terminal: raw keystrokes out, xterm.onResize → pty_resize,
// PTY output bytes written straight to xterm, WebGL renderer on wide hosts only.
// The remote gateway path (TerminalSocket / /api/shell-pty) is kept for later.

// SGR mouse reports (from xterm's own mouse tracking) must not be forwarded to
// the PTY — the shell would double-handle them.
// eslint-disable-next-line no-control-regex -- ESC (\x1b) is the sequence being matched; that's the point.
const SGR_MOUSE_RE = /^\x1b\[<\d+;\d+;\d+[Mm]$/

type Status = 'closed' | 'connecting' | 'open'

// Build the full xterm ITheme for the live skin: a complete, readable ANSI table
// per painted mode (VS Code defaults, overlaid with the skin's palette if it ever
// ships one), with background + block-cursor glyph bound to the live skin surface.
// `renderedMode` (luminance-derived) picks the light/dark table so a light-surface
// "dark" skin still gets the legible light palette. xterm's minimumContrastRatio
// (set on the Terminal) then clamps every glyph readable against the surface.
function buildTerminalTheme(theme: DesktopTheme, mode: 'light' | 'dark') {
  const palette = mode === 'dark' ? (theme.darkTerminal ?? theme.terminal) : theme.terminal

  return withSurface(terminalTheme(mode, palette))
}

export function TerminalView() {
  const { t } = useI18n()
  const { renderedMode, theme: appTheme } = useTheme()

  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const webglRef = useRef<WebglAddon | null>(null)
  const socketRef = useRef<LocalPtySocket | null>(null)
  const [status, setStatus] = useState<Status>('connecting')

  // Build the xterm instance once.
  useEffect(() => {
    const host = hostRef.current

    if (!host) {
      return
    }

    const term = new Terminal({
      allowProposedApi: true,
      // Opaque canvas: keeps WebGL crisp and gives the contrast clamp a real
      // background to measure against (withSurface paints the skin surface).
      allowTransparency: false,
      convertEol: true,
      cursorBlink: true,
      // Desktop's exact stack (apps/desktop/.../use-terminal-session.ts). It
      // needs no `ui-monospace` repair: every entry is a concrete family and
      // the bundled JetBrains Mono leads, so it resolves on every webview.
      fontFamily: "'JetBrains Mono', 'Cascadia Code', 'SF Mono', Menlo, Consolas, monospace",
      fontSize: 12,
      // VS Code's terminal.integrated.minimumContrastRatio (4.5). xterm defaults
      // to 1 (off), which paints the raw saturated ANSI palette — vivid green/cyan
      // on a light surface reads as candy. Clamping darkens/lightens each glyph
      // against the live surface at render time so every color stays legible.
      minimumContrastRatio: 4.5,
      scrollback: 5000,
      theme: buildTerminalTheme(appTheme, renderedMode)
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    const unicode = new Unicode11Addon()
    term.loadAddon(unicode)
    term.unicode.activeVersion = '11'
    term.loadAddon(new WebLinksAddon())
    term.open(host)

    // WebGL renders oversized cells on narrow/mobile hosts — canvas fallback there.
    if (host.clientWidth >= 768) {
      try {
        const webgl = new WebglAddon()
        webgl.onContextLoss(() => {
          webgl.dispose()
          webglRef.current = null
        })
        term.loadAddon(webgl)
        webglRef.current = webgl
      } catch {
        /* fall back to the default renderer */
      }
    }

    try {
      fit.fit()
    } catch {
      /* host not laid out yet */
    }

    termRef.current = term
    fitRef.current = fit

    // xterm measures the glyph cell ONCE, at open(). With `font-display: swap`
    // that measurement can land on the fallback face and never be redone, which
    // leaves the grid mis-sized for the rest of the session. Re-measure as soon
    // as the bundled face is actually available. (jsdom has no document.fonts.)
    let disposed = false
    void document.fonts
      ?.load('12px "JetBrains Mono"')
      .then(() => {
        if (disposed) {
          return
        }

        term.clearTextureAtlas()

        try {
          fit.fit()
        } catch {
          /* host gone or mid-transition */
        }
      })
      .catch(() => {
        /* face unavailable — the fallback measurement stands */
      })

    const onData = term.onData(data => {
      if (SGR_MOUSE_RE.test(data)) {
        return
      }

      socketRef.current?.write(data)
    })

    const onResize = term.onResize(({ cols, rows }) => socketRef.current?.resize(cols, rows))

    let raf = 0

    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        try {
          fit.fit()
        } catch {
          /* mid-transition */
        }
      })
    })

    ro.observe(host)

    return () => {
      disposed = true
      onData.dispose()
      onResize.dispose()
      cancelAnimationFrame(raf)
      ro.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      webglRef.current = null
    }
  }, [])

  // Spawn the local shell once, when this terminal mounts. A local shell exit is
  // deliberate (no reconnect), and re-spawning on a cwd change would kill a live
  // shell — so we capture the workspace cwd at spawn time rather than reacting.
  useEffect(() => {
    let disposed = false

    const term = termRef.current

    if (!term) {
      return
    }

    setStatus('connecting')

    try {
      fitRef.current?.fit()
    } catch {
      /* host not laid out yet */
    }

    socketRef.current = new LocalPtySocket(
      // Snapshot at spawn (desktop parity): a terminal keeps the directory it was
      // opened in — switching chats doesn't cd an already-running shell.
      { cols: term.cols, cwd: $effectiveCwd.get() || undefined, rows: term.rows },
      {
        onData: bytes => termRef.current?.write(bytes),
        onError: () => {},
        onExit: () => {
          if (!disposed) {
            setStatus('closed')
          }
        },
        onSpawn: () => {
          if (disposed) {
            return
          }

          setStatus('open')
          const t = termRef.current

          if (t) {
            try {
              fitRef.current?.fit()
            } catch {
              /* ignore */
            }

            socketRef.current?.resize(t.cols, t.rows)
          }
        }
      }
    )

    return () => {
      disposed = true
      socketRef.current?.close()
      socketRef.current = null
    }
  }, [])

  // Re-apply the WHOLE profile (text, bg, cursor, selection, all 16 ANSI) when
  // the skin or painted mode changes — not just the background.
  useEffect(() => {
    if (!termRef.current) {
      return
    }

    // rAF so ThemeProvider's CSS-variable repaint (a sibling effect that runs
    // after this one) has landed before resolveSurfaceColor probes the surface.
    const raf = requestAnimationFrame(() => {
      const term = termRef.current

      if (!term) {
        return
      }

      term.options.theme = buildTerminalTheme(appTheme, renderedMode)
      // WebGL caches glyph colors in a texture atlas, so a mode/skin switch
      // leaves already-drawn cells stale until the atlas is cleared (no-op on the
      // DOM fallback).
      webglRef.current?.clearTextureAtlas()
    })

    return () => cancelAnimationFrame(raf)
  }, [appTheme, renderedMode])

  const statusLabel =
    status === 'open' ? null : status === 'closed' ? t.rightSidebar.terminalClosed : t.rightSidebar.terminalConnecting

  return (
    <div className="relative h-full min-h-0 bg-(--ui-editor-surface-background) p-2 text-foreground">
      {/* The outer div paints the inset padding; the inner div is the xterm host so
          the canvas sizes to the content area (FitAddon) and the p-2 reads as
          terminal padding. Both the padding and the xterm screen/viewport are the
          same --ui-editor-surface-background var, so the inset stays seamless. */}
      <div
        className="h-full min-h-0 overflow-hidden bg-(--ui-editor-surface-background) [&_.xterm-screen]:bg-(--ui-editor-surface-background)! [&_.xterm-viewport]:bg-(--ui-editor-surface-background)!"
        ref={hostRef}
      />
      {statusLabel && (
        <div
          className={cn(
            'pointer-events-none absolute right-2 top-1 rounded px-1.5 py-0.5 text-[0.65rem]',
            status === 'closed' ? 'bg-destructive/15 text-destructive' : 'bg-black/30 text-white/80'
          )}
        >
          {statusLabel}
        </div>
      )}
    </div>
  )
}
