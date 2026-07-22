/**
 * Bundled-plugin discovery — the seam core uses to register its first-party
 * plugins after the contribution root boots.
 *
 * FIXME(MJX-50/plugins): the Plugin SDK + bundled/runtime plugin system is
 * MJX-53, not part of the tiles/layout-tree port. This is a no-op stub so the
 * contribution controller's `discoverBundledPlugins()` call resolves; wire it
 * up when the plugin system lands.
 */

export function discoverBundledPlugins(): void {
  // no-op until MJX-53
}
