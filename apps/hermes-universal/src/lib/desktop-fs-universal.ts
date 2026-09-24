/**
 * Universal attachment/composer helpers over desktop AUTO `lib/desktop-fs.ts`.
 */

import type { HermesConnection, HermesSelectPathsOptions } from '@/global'
import { IS_MOBILE } from '@/lib/platform'
import type { Connection } from '@/store/gateway-config'

import { isDesktopFsRemoteMode, selectDesktopPaths } from './desktop-fs'

type FsConnection = Connection | HermesConnection | null | undefined

function connectionIsRemoteLike(connection: Connection | HermesConnection): boolean {
  if (connection.mode === 'remote' || connection.mode === 'cloud') {
    return true
  }

  if ('remoteKind' in connection && (connection.remoteKind === 'ssh' || connection.remoteKind === 'cloud')) {
    return true
  }

  if ('sshScope' in connection && connection.sshScope) {
    return true
  }

  return false
}

/** True when a local folder pick resolves on the same disk the gateway uses. */
export function gatewayOwnsLocalFs(connection: FsConnection): boolean {
  if (IS_MOBILE || !connection) {
    return false
  }

  if (connectionIsRemoteLike(connection)) {
    return false
  }

  return !isDesktopFsRemoteMode()
}

/** Pick paths on the backend filesystem (remote picker or desktop bridge). */
export async function selectRemotePaths(options?: HermesSelectPathsOptions): Promise<string[]> {
  return selectDesktopPaths(options)
}
