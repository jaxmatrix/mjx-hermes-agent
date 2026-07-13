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
