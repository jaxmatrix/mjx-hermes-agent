// The three DOM markers the app-wide context-menu coordinator reads.
//
// Constants only, zero imports: `components/ui/context-menu.tsx` stamps one of
// them, and the Radix primitive must not pull the coordinator (and through it
// the stores, the clipboard seam and the terminal registry) into its module
// graph. `src/entry-graph.test.ts` pins that direction.

/**
 * Stamped by `ContextMenuTrigger` AFTER `{...props}` so an `asChild` child that
 * sets its own `data-slot` cannot erase it (desktop `2d6d7c550f`). The
 * coordinator checks this FIRST and stands down for the whole gesture.
 */
export const HERMES_CONTEXT_MENU_TRIGGER_ATTR = 'data-hermes-context-menu-trigger'

/**
 * A surface that owns its PLAIN right-click (the reaction picker, the starmap's
 * hand-rolled canvas menu, the mobile review row). A link / image / editable /
 * selection inside it still gets the app menu — the coordinator consults this
 * only after classification, when the gesture turned out to own nothing.
 */
export const CONTEXT_MENU_SKIP_ATTR = 'data-context-menu-skip'

/**
 * The xterm host. Also the focus scope `lib/keybinds/composer-focus-keys.ts`
 * already looks for and never found — the attribute was never stamped anywhere
 * but a test, so that selector was dead in production until this ticket.
 */
export const TERMINAL_HOST_ATTR = 'data-terminal'

/** Every marker that means "a Radix menu owns this gesture", as one selector. */
export const RADIX_TRIGGER_SELECTOR = `[${HERMES_CONTEXT_MENU_TRIGGER_ATTR}], [data-slot="context-menu-trigger"]`
