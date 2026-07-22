/**
 * Runtime (disk) plugin discovery + lifecycle — rescans the on-disk plugin
 * directory so an agent's write→see loop reloads plugins without relaunching.
 *
 * FIXME(MJX-50/plugins): the Plugin SDK + runtime loader is MJX-53, not part of
 * the tiles/layout-tree port. These are no-op stubs so callers (the "Reload
 * plugins" palette row, boot-time discovery, hot-unload) resolve; wire them up
 * when the plugin system lands.
 */

export function discoverRuntimePlugins(): void {
  // no-op until MJX-53
}

export function watchRuntimePlugins(): void {
  // no-op until MJX-53
}

export function unloadRuntimePlugin(_id: string): void {
  // no-op until MJX-53
}
