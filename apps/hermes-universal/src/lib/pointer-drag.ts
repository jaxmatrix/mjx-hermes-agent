/** Run a pointer drag until it ends, then unbind every listener.
 *
 *  Capture-phase, on `window`, so the drag keeps tracking when the pointer
 *  leaves the element it started on. Forgetting one half of the teardown leaks
 *  a live pointermove handler for the rest of the session, which is why the
 *  unbinding lives here rather than at each call site.
 *
 *  Diverges from desktop's primitive in one way, deliberately: `pointercancel`
 *  ends the drag as well. Universal runs on touch, where the platform can steal
 *  a pointer mid-gesture and deliver `pointercancel` INSTEAD of `pointerup` —
 *  a mouse-only two-event version leaks both listeners every time that happens,
 *  which on Android is a routine gesture outcome rather than an edge case.
 *
 *  The returned function is the other half of the teardown: the drag has no way
 *  to know its owner unmounted mid-drag, so a caller that can disappear should
 *  call it from an effect cleanup. Calling it after the drag already ended is a
 *  no-op. */
export function startPointerDrag(
  onMove: (event: PointerEvent) => void,
  onEnd?: (event: PointerEvent) => void
): () => void {
  function stop() {
    window.removeEventListener('pointermove', move, true)
    window.removeEventListener('pointerup', end, true)
    window.removeEventListener('pointercancel', end, true)
  }

  function move(event: PointerEvent) {
    onMove(event)
  }

  function end(event: PointerEvent) {
    stop()
    onEnd?.(event)
  }

  window.addEventListener('pointermove', move, true)
  window.addEventListener('pointerup', end, true)
  window.addEventListener('pointercancel', end, true)

  return stop
}
