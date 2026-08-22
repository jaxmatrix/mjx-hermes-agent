import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useState } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import { useIsDark } from '@/components/assistant-ui/embeds/use-is-dark'
import { PreviewAttachment } from '@/components/chat/preview-attachment'
import { artifactContentHash } from '@/lib/artifact-detect'
import { artifactFrameUrl, composeArtifactHtml } from '@/lib/artifact-frame'
import { readDesktopFileText } from '@/lib/desktop-fs'
import { IS_TAURI } from '@/lib/platform'
import { releaseStagedArtifact, stageArtifactDocument } from '@/store/artifacts'

/**
 * `::preview{file="…"}` — a workspace HTML file rendered LIVE inside the
 * assistant message.
 *
 * WHY NOT `srcdoc`, which is what desktop uses (8425f8286b). A `srcdoc` frame
 * is a local scheme, so it INHERITS the app document's CSP — and universal's
 * is `script-src 'self' blob:` with no `'unsafe-inline'`. The page's own
 * scripts would never run, nor would the measuring script below, and the only
 * way to change that is to widen the app's own `script-src` so a stranger's
 * code can execute under the policy that protects the app. Universal already
 * refused that trade once, for artifacts: `src-tauri/src/artifact.rs` serves
 * model-written HTML over `hermes-artifact://` with its OWN response CSP
 * (`default-src 'none'` — the page gets no network at all), and the app's
 * `frame-src` names that one scheme. This directive rides the same rails, so
 * it needs no change to `tauri.conf.json` and ends up MORE isolated than
 * desktop's frame, not less.
 *
 * The frame is sandboxed `allow-scripts` and deliberately NOT
 * `allow-same-origin`: granted together the two let a frame reach its own
 * document and strip the sandbox attribute, which is the same as granting
 * neither. Alone, `allow-scripts` runs the page's code in an opaque origin.
 *
 * SIZE IS CONTENT-DRIVEN. The opaque origin means the parent cannot measure
 * the document, but we own the staged string — an injected script posts the
 * content's size up via postMessage, tagged with a per-mount token. Height
 * tracks live within the clamp band; width adopts ONCE from the first report,
 * so a fixed-size widget shrink-wraps and sits left in the message flow like
 * an image, while a fluid page measures the full viewport and stays
 * column-wide. A `height="480"` attribute only sets the starting height —
 * measurement always wins.
 *
 * NATIVE BY DEFAULT. A theme prelude injects first: the app's resolved theme
 * tokens under friendly names (--foreground, --muted-foreground, --accent,
 * --border, --card), the app font, zero body margin/padding, and a transparent
 * background. The page's own styles override all of it, so a full page keeps
 * its own design.
 *
 * Non-HTML targets, an unresolvable path, and a failed read all fall back to
 * the standard preview-attachment card rather than a broken frame.
 *
 * NOT ported from desktop: `window.hermes.send` (3ead0f8dc1), which routes a
 * widget click to the agent as a HIDDEN user turn. Universal's
 * `requestComposerSubmit` has no `displayKind`, so the turn would render as a
 * visible user bubble — the opposite of that feature. It needs a hidden-turn
 * composer path first; see MJXHRM-453.
 */

const MIN_HEIGHT = 120
const MAX_HEIGHT = 1200
const DEFAULT_HEIGHT = 280
/** The transcript column cap the frame renders inside (`max-w-160` = 40rem). */
const MAX_COLUMN_WIDTH = 640
/** Ignore sub-pixel/rounding churn so a vh-sized page can't oscillate. */
const RESIZE_TOLERANCE = 4

const SIZE_MESSAGE_TYPE = 'hermes-inline-preview-size'

const HTML_FILE_RE = /\.(?:html?|xhtml)$/i

/**
 * Resolve `::preview{file="…"}` against the session's cwd, or reject it.
 *
 * THE ATTRIBUTE COMES FROM THE MODEL. Desktop's `localPreviewTarget` resolves
 * this the way it resolves a link a human clicked — absolute paths pass
 * through, `..` is joined verbatim — because on desktop the same function
 * serves both. Here the only caller is a string the model wrote, so the rule
 * is the narrow one: a path INSIDE the session's workspace, and nothing else.
 *
 * Rejected: anything absolute, any URL scheme (`file:`, `http:`, and a Windows
 * drive letter, which lexes as one), `~`, a NUL byte, and any `..` that would
 * climb above the cwd. Interior `..` that stays inside is resolved, not
 * rejected — `docs/../index.html` is `index.html` and is a legitimate thing
 * for an agent to emit.
 *
 * The gateway's `/api/fs/*` endpoints harden paths on their own side too; this
 * is the near guard, not the only one.
 */
export function workspaceFilePath(file: string, cwd: string): string | null {
  const raw = file.trim().replace(/^`|`$/g, '')
  const base = cwd.trim().replace(/[\\/]+$/, '')

  if (!raw || !base || raw.includes('\0')) {
    return null
  }

  // A leading separator, a `~`, or anything that lexes as `scheme:` names
  // somewhere other than "relative to this session's workspace".
  if (/^(?:[a-z][a-z0-9+.-]*:|[\\/]|~)/i.test(raw)) {
    return null
  }

  const segments: string[] = []

  for (const segment of raw.split(/[\\/]+/)) {
    if (!segment || segment === '.') {
      continue
    }

    if (segment === '..') {
      if (segments.length === 0) {
        return null
      }

      segments.pop()

      continue
    }

    segments.push(segment)
  }

  return segments.length > 0 ? `${base}/${segments.join('/')}` : null
}

export function directiveFrameHeight(raw: string | undefined): number | null {
  if (!raw) {
    return null
  }

  const parsed = Number(raw)

  if (!Number.isInteger(parsed)) {
    return null
  }

  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, parsed))
}

/** Semantic tokens handed into the frame, resolved to concrete values from
 *  the LIVE theme. Friendly names, not internal ones — this is the contract
 *  reference HTML / skills write against (`var(--foreground)` etc.). */
const THEME_BRIDGE_TOKENS: Record<string, string> = {
  '--foreground': '--ui-text-primary',
  '--muted-foreground': '--ui-text-tertiary',
  '--accent': '--ui-accent',
  '--border': '--ui-stroke-tertiary',
  '--card': '--ui-bg-editor'
}

/** Resolve the bridge tokens + app font against the current document. */
export function collectThemeBridge(): { vars: Record<string, string>; font: string } {
  const vars: Record<string, string> = {}

  if (typeof document !== 'undefined') {
    const root = getComputedStyle(document.documentElement)

    for (const [alias, source] of Object.entries(THEME_BRIDGE_TOKENS)) {
      const value = root.getPropertyValue(source).trim()

      if (value) {
        vars[alias] = value
      }
    }
  }

  const font = typeof document === 'undefined' ? '' : getComputedStyle(document.body).fontFamily

  return { vars, font }
}

/**
 * The style prelude that makes an inline widget read as NATIVE: the app's
 * resolved theme tokens as CSS vars, the app font, no margin, and a
 * transparent background so the widget sits directly on the chat surface.
 * Injected FIRST, so the page's own styles override every default here — a
 * full page that wants its own look keeps it.
 */
export function themePrelude(vars: Record<string, string>, font: string): string {
  const tokens = Object.entries(vars)
    .map(([name, value]) => `${name}:${value}`)
    .join(';')

  const fontRule = font ? `font-family:${font};` : ''

  return (
    `<style>:root{${tokens}}` +
    `html,body{margin:0;padding:0;background:transparent;color:var(--foreground,inherit);${fontRule}}</style>`
  )
}

/** The script injected into the staged document that reports content size to
 *  the parent. It runs in the opaque sandbox origin, so postMessage is its
 *  only door — it can say "I am N pixels" and nothing else. Height is the
 *  document scrollHeight; width is the union of the body children's boxes
 *  (intrinsic content width — the document itself always fills the viewport,
 *  so scrollWidth would just echo the frame back). */
export function measurementScript(token: string): string {
  return (
    '<script>(function(){var t=' +
    JSON.stringify(token) +
    ';var lastH=0,lastW=0;function post(){var d=document.documentElement;var b=document.body;' +
    'var h=Math.max(d?d.scrollHeight:0,b?b.scrollHeight:0);' +
    'var w=0;if(b){var kids=b.children;var L=Infinity,R=0;for(var i=0;i<kids.length;i++){' +
    'var r=kids[i].getBoundingClientRect();if(r.width===0&&r.height===0)continue;' +
    'if(r.left<L)L=r.left;if(r.right>R)R=r.right}' +
    'if(R>L)w=R-L}' +
    'w=Math.ceil(w);' +
    'if(Math.abs(h-lastH)>1||Math.abs(w-lastW)>1){lastH=h;lastW=w;parent.postMessage({type:' +
    JSON.stringify(SIZE_MESSAGE_TYPE) +
    ',token:t,height:h,width:w},"*")}}' +
    'if(typeof ResizeObserver==="function"){var ro=new ResizeObserver(post);' +
    'ro.observe(document.documentElement);if(document.body)ro.observe(document.body)}' +
    'addEventListener("load",post);post()})()</script>'
  )
}

/**
 * Assemble the document to stage: theme prelude as early as the markup allows
 * (so the page's own styles still win), then the measuring script before
 * `</body>` when present so it runs after the page's own markup.
 *
 * The prelude goes AFTER any doctype rather than flatly in front of it —
 * desktop prepends and pushes the doctype out of first position, which drops
 * the frame into quirks mode and silently changes every box in it.
 */
export function withInlineChrome(doc: string, token: string, prelude: string): string {
  const doctype = /^\s*<!doctype\s+html[^>]*>/i.exec(doc)
  const head = doctype ? doc.slice(0, doctype[0].length) : ''
  const rest = doctype ? doc.slice(doctype[0].length) : doc

  const bodyClose = /<\/body\s*>/i.exec(rest)

  const framed = bodyClose
    ? rest.slice(0, bodyClose.index) + measurementScript(token) + rest.slice(bodyClose.index)
    : rest + measurementScript(token)

  return head + prelude + framed
}

export interface FrameSizeReport {
  height: number
  /** Intrinsic content width, 0 when unmeasurable. */
  width: number
}

/** Parse a size report from the frame. Null unless it is OUR message type,
 *  carries OUR token, and holds a sane finite height — anything inside the
 *  sandbox can postMessage, so everything is validated before it moves the
 *  layout. Height clamped to the band; width sanitized but uncapped (the
 *  frame caps it against the column at render). */
export function frameSizeFromMessage(data: unknown, token: string): FrameSizeReport | null {
  if (typeof data !== 'object' || data === null) {
    return null
  }

  const message = data as { type?: unknown; token?: unknown; height?: unknown; width?: unknown }

  if (message.type !== SIZE_MESSAGE_TYPE || message.token !== token || typeof message.height !== 'number') {
    return null
  }

  if (!Number.isFinite(message.height) || message.height <= 0) {
    return null
  }

  const width =
    typeof message.width === 'number' && Number.isFinite(message.width) && message.width > 0
      ? Math.round(message.width)
      : 0

  return {
    height: Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(message.height))),
    width
  }
}

export function InlinePreviewDirective({
  attrs,
  streaming
}: {
  attrs: Readonly<Record<string, string>>
  streaming: boolean
}) {
  const file = attrs.file ?? ''

  // Not renderable inline: hand the whole leaf to the classic card. Outside
  // Tauri there is no scheme to serve the document from; non-HTML has nothing
  // to frame.
  if (!file || !IS_TAURI || !HTML_FILE_RE.test(file)) {
    return file ? <PreviewAttachment target={file} /> : null
  }

  return <InlineHtmlFrame file={file} initialHeight={directiveFrameHeight(attrs.height)} streaming={streaming} />
}

function InlineHtmlFrame({
  file,
  initialHeight,
  streaming
}: {
  file: string
  /** `height` attribute — the starting height only; measurement overrides. */
  initialHeight: number | null
  streaming: boolean
}) {
  const cwd = useStore(useSessionView().$cwd)
  const isDark = useIsDark()
  const [doc, setDoc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [staged, setStaged] = useState(false)
  const [measured, setMeasured] = useState<number | null>(null)
  const [contentWidth, setContentWidth] = useState<number | null>(null)

  // One token per mount: the message listener only trusts reports from the
  // document THIS mount injected, so two previews in one transcript (or a
  // hostile page inventing messages) can't move each other's frames.
  const token = useMemo(() => Math.random().toString(36).slice(2), [])

  // Resolve against THIS session's cwd (the file was written by its agent),
  // and refuse anything that names somewhere else.
  const path = workspaceFilePath(file, cwd)

  useEffect(() => {
    // Wait for turn settle: mid-stream the file is often mid-write, and a
    // half-written document renders as garbage that never self-corrects.
    if (!path || streaming) {
      return
    }

    let alive = true

    void readDesktopFileText(path)
      .then(result => {
        if (!alive) {
          return
        }

        if (!result || result.binary || !result.text) {
          setFailed(true)
        } else {
          setDoc(result.text)
        }
      })
      .catch(() => alive && setFailed(true))

    return () => {
      alive = false
    }
  }, [path, streaming])

  // Resolved once per document; theme switches remount the transcript anyway.
  const framedDoc = useMemo(() => {
    if (doc === null) {
      return null
    }

    const { vars, font } = collectThemeBridge()

    return withInlineChrome(composeArtifactHtml(doc), token, themePrelude(vars, font))
  }, [doc, token])

  // Keyed by content hash, so the frame's `src` is stable across re-renders —
  // a changing src would reload, and re-run, the page.
  const documentId = useMemo(() => (framedDoc === null ? null : artifactContentHash(framedDoc)), [framedDoc])

  useEffect(() => {
    if (documentId === null || framedDoc === null) {
      return
    }

    let live = true

    void stageArtifactDocument(documentId, framedDoc).then(ok => {
      if (live) {
        setStaged(ok)

        if (!ok) {
          setFailed(true)
        }
      }
    })

    return () => {
      live = false
      setStaged(false)
      void releaseStagedArtifact(documentId)
    }
  }, [documentId, framedDoc])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const next = frameSizeFromMessage(event.data, token)

      if (next === null) {
        return
      }

      // Functional updates so the comparisons read current state without a
      // shadow ref: same-value sets bail out in React, and the tolerance
      // keeps a vh-sized page (which measures what it's given) from
      // oscillating.
      setMeasured(prev =>
        Math.abs(next.height - (prev ?? initialHeight ?? DEFAULT_HEIGHT)) > RESIZE_TOLERANCE ? next.height : prev
      )

      // Width adopts ONCE, from the first report — measured at full column
      // width, so it is the content's intrinsic span. Tracking width live
      // would feedback-loop: %-width children reflow narrower every time the
      // frame shrinks, spiraling toward zero.
      if (next.width > 0) {
        setContentWidth(prev => prev ?? next.width)
      }
    }

    window.addEventListener('message', onMessage)

    return () => window.removeEventListener('message', onMessage)
  }, [initialHeight, token])

  if (!path || failed) {
    return <PreviewAttachment target={file} />
  }

  const height = measured ?? initialHeight ?? DEFAULT_HEIGHT
  // Left-aligned in the message flow, like an image: the frame is only as wide
  // as its content (capped at the column). Fluid pages measure the full
  // viewport and stay full-bleed.
  const width = contentWidth !== null ? Math.min(contentWidth, MAX_COLUMN_WIDTH) : undefined

  return (
    <span className="my-2 block w-full max-w-160">
      {staged && documentId !== null ? (
        <span
          className="relative block max-w-full transition-[height] duration-200"
          style={{ height, width: width ?? '100%' }}
        >
          <iframe
            className="absolute inset-0 size-full border-0 bg-transparent"
            loading="lazy"
            sandbox="allow-scripts"
            src={artifactFrameUrl(documentId)}
            style={{ colorScheme: isDark ? 'dark' : 'light' }}
            title={file}
          />
        </span>
      ) : (
        <span
          className="block w-full animate-pulse rounded-md bg-[color-mix(in_srgb,currentColor_4%,transparent)]"
          style={{ height }}
        />
      )}
    </span>
  )
}
