/**
 * Plugin enable/disable decisions (persisted) + the loaded-plugin record store.
 *
 * FIXME(MJX-50/plugins): the Plugin SDK + plugin manager is MJX-53, not part of
 * the tiles/layout-tree port. Only `setPluginEnabled` is referenced by the
 * layout-tree store (a plugin-pane can be toggled off from a zone menu); it's a
 * no-op stub here until the plugin system lands.
 */

export async function setPluginEnabled(_id: string, _enabled: boolean): Promise<void> {
  // no-op until MJX-53
}
