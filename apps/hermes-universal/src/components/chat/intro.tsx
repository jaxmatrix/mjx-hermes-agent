import { Wordmark } from '@/components/brand/wordmark'

// The opening message is PINNED — it renders identically every time (no random
// rotation, no personality variation).
const OPENING_BODY = "Tell me what you want. I'll make it, keep you posted, and keep every step reversible."

// This used to fit the wordmark to the column width — a hidden twin measured
// the text at a reference size and the visible copy was scaled to match, which
// is how desktop's CSS trig fit was reproduced for WebKitGTK. That machinery is
// gone: the wordmark is now a four-letter word beside a logo mark, and
// stretching it edge-to-edge reads as a bug rather than as a brand. It uses the
// brand's own hero clamp instead (see components/brand/wordmark.tsx), so there
// is nothing left to measure.
export function Intro() {
  return (
    <div
      className="pointer-events-none flex w-full min-w-0 flex-col items-center justify-center px-0.5 py-6 text-center text-muted-foreground sm:px-6 lg:px-8"
      data-slot="aui_intro"
      style={{ paddingBottom: 'var(--composer-measured-height)' }}
    >
      <div className="mx-auto flex w-full min-w-0 max-w-[min(var(--composer-width),82vw)] flex-col items-center">
        <Wordmark className="mb-3 justify-center" size="lg" />

        <p className="m-0 mx-auto max-w-[34rem] text-center text-[0.875rem] leading-[1.45] tracking-tight text-(--ui-text-tertiary)">
          {OPENING_BODY}
        </p>
      </div>
    </div>
  )
}
