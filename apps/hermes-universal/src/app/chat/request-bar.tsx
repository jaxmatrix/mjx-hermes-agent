import type { ReactNode } from 'react'

// Shared shell for the composer-docked request bars (approval / clarify / sudo /
// secret). Replaces the pre-port `.approval*` legacy CSS classes; the chrome is
// expressed in the same theme tokens the desktop app uses, so these bars track
// the active skin instead of the retired mobile stylesheet.
export function RequestBar({ children, title }: { children: ReactNode; title: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-(--radius) border border-(--ui-stroke-primary) bg-card p-3">
      <div className="text-[0.8125rem] font-semibold text-midground">{title}</div>
      {children}
    </div>
  )
}

/** Request body text. `mono` for machine content (a command), prose otherwise. */
export function RequestBarDescription({ children, mono = false }: { children: ReactNode; mono?: boolean }) {
  return (
    <div className={`text-[0.8125rem] break-words text-secondary-foreground${mono ? ' font-mono' : ''}`}>
      {children}
    </div>
  )
}

export function RequestBarActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-2">{children}</div>
}
