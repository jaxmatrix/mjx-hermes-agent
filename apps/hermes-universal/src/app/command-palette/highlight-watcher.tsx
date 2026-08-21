import { useCommandState } from 'cmdk'
import { useEffect, useRef } from 'react'

/**
 * Reports which row cmdk currently has highlighted.
 *
 * `useCommandState` reads the selection out of cmdk's own store, which is the
 * only way to see it here: the palette runs `<Command>` UNCONTROLLED (it hands
 * cmdk an already-ranked list with `shouldFilter={false}` and lets it own
 * keyboard selection), and `onValueChange` on the root only fires when `value`
 * is a controlled prop. It has to be a child component for the same reason —
 * the hook only works inside `<Command>`.
 *
 * `onValue` is pinned to a ref so a parent that re-renders on every keystroke
 * (this one does) doesn't re-run the effect and re-report an unchanged
 * highlight; the effect keys on the value alone.
 */
export function HighlightWatcher({ onValue }: { onValue: (value: string) => void }): null {
  const value = useCommandState(state => state.value)
  const onValueRef = useRef(onValue)

  onValueRef.current = onValue

  useEffect(() => {
    onValueRef.current(value)
  }, [value])

  return null
}
