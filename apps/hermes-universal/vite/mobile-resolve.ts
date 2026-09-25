import fs from 'node:fs'
import path from 'node:path'

import type { Plugin } from 'vite'

const CODE_EXT = /\.(tsx?|jsx?|mts|cts)$/
const EXPLICIT_EXT = /\.(tsx?|jsx?|mts|cts)(\?|$)/
const MOBILE_SUFFIX = /\.mobile\.(tsx?|jsx?|mts|cts)(\?|$)/

/**
 * Prefer `Foo.mobile.tsx` over `Foo.tsx` when mobile resolve is on.
 *
 * Adapters are sparse layout hosts. Leaves without a `.mobile` twin keep the
 * desktop module — that is the sync-safe point of this plugin.
 *
 * Never rewrite:
 * - imports that already name a full filename + extension (escape hatch / leaf)
 * - imports that already resolve to a `*.mobile.*` file (no self-loop)
 * - bare package / virtual ids
 */
export function shouldEnableMobileResolve(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.HERMES_MOBILE_RESOLVE === '1' || env.HERMES_MOBILE_RESOLVE === 'true') {
    return true
  }

  const platform = (env.TAURI_ENV_PLATFORM || env.TAURI_PLATFORM || '').toLowerCase()

  return platform === 'android' || platform === 'ios'
}

/** Pure: given an absolute path Vite would load, return the mobile twin if it exists. */
export function resolveMobileTwin(resolvedPath: string, exists: (p: string) => boolean = fs.existsSync): string | null {
  const queryIndex = resolvedPath.indexOf('?')
  const filePath = queryIndex >= 0 ? resolvedPath.slice(0, queryIndex) : resolvedPath
  const query = queryIndex >= 0 ? resolvedPath.slice(queryIndex) : ''

  if (!CODE_EXT.test(filePath) || MOBILE_SUFFIX.test(filePath)) {
    return null
  }

  const dir = path.dirname(filePath)
  const base = path.basename(filePath)
  const ext = path.extname(base)
  const stem = base.slice(0, -ext.length)

  if (stem.endsWith('.mobile')) {
    return null
  }

  const twin = path.join(dir, `${stem}.mobile${ext}`)

  if (!exists(twin)) {
    return null
  }

  return twin + query
}

export function mobileResolvePlugin(options?: { enabled?: boolean }): Plugin {
  const enabled = options?.enabled ?? shouldEnableMobileResolve()

  return {
    name: 'hermes-mobile-resolve',
    enforce: 'pre',
    async resolveId(source, importer, opts) {
      if (!enabled) {
        return null
      }

      // Already an explicit file with extension — callers use this to force the
      // desktop module from a mobile adapter without looping.
      if (EXPLICIT_EXT.test(source) || MOBILE_SUFFIX.test(source)) {
        return null
      }

      // Skip bare package names and Vite virtual modules.
      if (!source.startsWith('.') && !source.startsWith('/') && !source.startsWith('\0') && !path.isAbsolute(source)) {
        // `@/` and other aliases still need a first-pass resolve; only skip
        // plain package imports (no slash after the scope).
        if (!source.startsWith('@/') && !source.includes('/')) {
          return null
        }

        if (source.startsWith('@') && !source.startsWith('@/') && !source.slice(1).includes('/')) {
          return null
        }
      }

      const resolved = await this.resolve(source, importer, { ...opts, skipSelf: true })

      if (!resolved?.id || resolved.id.startsWith('\0')) {
        return null
      }

      // Strip query for twin lookup; keep Vite's resolved meta.
      const idWithoutQuery = resolved.id.replace(/\?.*$/, '')

      if (MOBILE_SUFFIX.test(idWithoutQuery) || EXPLICIT_EXT.test(source)) {
        return null
      }

      const twin = resolveMobileTwin(resolved.id)

      if (!twin) {
        return null
      }

      return { ...resolved, id: twin }
    }
  }
}
