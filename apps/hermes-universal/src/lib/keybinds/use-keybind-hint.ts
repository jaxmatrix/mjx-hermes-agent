// Shim for desktop's `lib/keybinds/use-keybind-hint.ts`.
//
// Desktop tooltips append the shortcut for their action ("New chat  ⌘N"), read
// from the rebindable-keybind store (`@/store/keybinds` + `keybinds/actions.ts`).
// Universal has neither — it ships `combo.ts` for formatting only, and has no
// user-rebindable keybind system to source hints from.
//
// Desktop's own hook already returns null for unknown action ids, and the
// tooltip renders the plain text label in that case. So returning null here is
// not a stub that swallows a feature: it is the same code path desktop takes
// when an action has no binding, which is every action on universal. That lets
// `components/ui/tooltip.tsx` stay a byte-identical copy of desktop's.
//
// If universal ever gains a keybind store, replace this file with desktop's
// implementation verbatim — the signature is deliberately identical.
export function useKeybindHint(_actionId: string): string | null {
  return null
}
