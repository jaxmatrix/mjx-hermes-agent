// Vitest global setup — adds the jest-dom matchers (toBeInTheDocument,
// toHaveClass, …) to Vitest's expect.
import '@testing-library/jest-dom/vitest'

// jsdom lacks these DOM APIs that Radix primitives (dropdown/dialog/…) call
// while opening. Stub them so component tests can drive those overlays.
if (typeof Element !== 'undefined') {
  Element.prototype.hasPointerCapture ??= () => false

  Element.prototype.setPointerCapture ??= () => {}

  Element.prototype.releasePointerCapture ??= () => {}

  Element.prototype.scrollIntoView ??= () => {}
}

// jsdom has no ResizeObserver, and several chat components construct one in a
// layout effect (expandable-block, user-message clamp, tool windows). A no-op
// stub is enough: jsdom never lays anything out, so a real implementation would
// only ever report zeroes anyway.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    disconnect() {}
    observe() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver
}
