import { cn } from '@/lib/utils'

// Ported from apps/desktop/src/lib/selectable-card.ts. Shared surface/border for
// selectable cards (theme cards, pet cards, marketplace results) — three tiers:
// active > prominent > muted. Callers own padding/flex/width; this owns only the
// border + surface so every card grid reads as one system.
export function selectableCardClass({ active = false, prominent = false }: { active?: boolean; prominent?: boolean }) {
  return cn(
    'rounded-lg border transition-colors',
    active
      ? 'border-primary bg-primary/[0.06] ring-2 ring-primary/20'
      : prominent
        ? 'border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary) hover:bg-(--chrome-action-hover)'
        : 'border-transparent bg-transparent text-(--ui-text-tertiary) hover:border-(--ui-stroke-tertiary) hover:bg-(--ui-bg-quinary)'
  )
}
