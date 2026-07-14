import { IS_MAC } from '@/lib/platform'

// Keyboard-combo display helpers, ported from desktop's `lib/keybinds/combo.ts`
// (the display slice only — the full keybind registry lands with Phase 10). A
// combo string like `mod+shift+f` renders to per-key caps for <KbdGroup>.

const TOKEN_LABELS: Record<string, string> = {
  enter: '↵',
  escape: 'Esc',
  backspace: '⌫',
  tab: '⇥',
  space: 'Space',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→'
}

function labelForBase(base: string): string {
  if (TOKEN_LABELS[base]) {
    return TOKEN_LABELS[base]
  }

  if (/^f\d{1,2}$/.test(base)) {
    return base.toUpperCase()
  }

  return base.length === 1 ? base.toUpperCase() : base
}

function labelForMod(mod: string): string {
  if (mod === 'mod') {
    return IS_MAC ? '⌘' : 'Ctrl'
  }

  if (mod === 'ctrl') {
    return IS_MAC ? '⌃' : 'Ctrl'
  }

  if (mod === 'alt') {
    return IS_MAC ? '⌥' : 'Alt'
  }

  if (mod === 'shift') {
    return IS_MAC ? '⇧' : 'Shift'
  }

  return mod
}

// Per-key display tokens, e.g. ["⌘", "K"] on macOS, ["Ctrl", "K"] elsewhere —
// one cap per token for <KbdGroup>.
export function comboTokens(combo: string): string[] {
  const parts = combo.split('+')
  const base = parts.pop() ?? ''

  return [...parts.map(labelForMod), labelForBase(base)]
}

// Human-readable label, e.g. "⌘⇧K" on macOS, "Ctrl+Shift+K" elsewhere.
export function formatCombo(combo: string): string {
  const tokens = comboTokens(combo)

  return IS_MAC ? tokens.join('') : tokens.join('+')
}
