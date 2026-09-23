import type { ContextMenuItemContext, ContextMenuSection } from '@/app/context-menu/registry'

/**
 * `contextMenu.items` — the normal door for a plugin that wants rows in the
 * app-wide menu (Family B: consumed, not rendered).
 *
 * The sharp door beside it is `registerContextTarget`, which claims a whole new
 * target KIND. Use this one unless you own the surface the gesture lands on.
 */
export const CONTEXT_MENU_ITEMS_AREA = 'contextMenu.items'

/** Sections a contribution may not exceed, so one plugin cannot make the menu unusable. */
export const CONTEXT_MENU_MAX_SECTIONS = 8
/** Items per contributed section, same reason. */
export const CONTEXT_MENU_MAX_ITEMS = 12

export interface ContextMenuItemsContribution {
  /** Target kinds this applies to. Omit = every kind. An unknown kind is inert. */
  targets?: string[]
  /**
   * Sections appended AFTER the built-in ones, in contribution `order`. Called
   * at menu BUILD time — that is how live state reaches it without `when()`,
   * which is not reactive (rule 28). A throw drops only this contribution.
   */
  provide: (context: ContextMenuItemContext) => ContextMenuSection[]
}
