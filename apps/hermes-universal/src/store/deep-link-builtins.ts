/**
 * The core `hermes://` routes, registered through the same door a plugin uses.
 *
 * ONE side-effect import from `main.tsx` — this import IS the wiring — so the
 * built-in route table is readable in one place instead of being scattered
 * across the stores that own the surfaces. Each handler stays a two-liner: the
 * work belongs to the store it delegates to.
 *
 * Nothing here ACTS. `mcp/install` parks a pending request behind a
 * confirmation dialog and `blueprint` writes a reviewable command into the
 * composer without submitting it — a deep link is hostile input, so the last
 * step is always the user's.
 */

import { requestComposerFocus, requestComposerInsert } from '@/app/chat/composer/focus'
import { resolveDeepLinkAction } from '@/lib/deep-link-routes'

import { registerDeepLinkRoute } from './deep-link'
import { requestMcpInstallFromDeepLink } from './mcp-deeplink-install'
import { openPluginInstallRequest } from './plugin-install-request'

/** Quote a slot value only when it needs it, so the command stays readable. */
function slotArg(key: string, value: string): string {
  return `${key}=${/\s/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value}`
}

/**
 * Register the core routes. Called once at import — the side effect IS the
 * wiring — and exported so a test can rebuild the table after clearing it,
 * rather than re-importing this module into a second registry.
 */
export function registerBuiltinDeepLinkRoutes(): void {
  // `hermes://mcp/install?name=…&config=<base64>` — MJXHRM-454's dialog.
  registerDeepLinkRoute({
    handle: ({ params }) => {
      requestMcpInstallFromDeepLink(params)

      // Consumed even when the payload is rejected: the link WAS ours, and
      // `requestMcpInstallFromDeepLink` has already said why it refused.
      return true
    },
    kind: 'mcp',
    name: 'install'
  })

  // `hermes://blueprint/<name>?slot=value` — a `/blueprint` command typed into
  // the composer for the user to review. INSERTED, never submitted: a web page
  // must not be able to start a turn.
  registerDeepLinkRoute({
    handle: ({ name, params }) => {
      if (!name) {
        return false
      }

      const slots = Object.entries(params)
        .map(([key, value]) => slotArg(key, value))
        .join(' ')

      requestComposerInsert(`/blueprint ${name}${slots ? ` ${slots}` : ''}`, { mode: 'block', target: 'main' })
      requestComposerFocus('main')

      return true
    },
    kind: 'blueprint'
  })

  // `hermes://plugin/install?repo=owner/repo`, plus desktop's two historical
  // aliases. All three go through the same classifier, so the repo resolution
  // and the enable/force defaults cannot drift between them.
  for (const kind of ['plugin', 'plugin-agent', 'plugin-desktop'] as const) {
    registerDeepLinkRoute({
      handle: payload => {
        const action = resolveDeepLinkAction(payload)

        if (action.type !== 'plugin-install') {
          // A `plugin/` link that named no repository. Declining lets the
          // router say WHY rather than opening a dialog for nothing.
          return false
        }

        openPluginInstallRequest({
          enable: action.enable,
          force: action.force,
          legacyHint: action.legacyHint,
          origin: 'deep-link',
          repo: action.repo
        })

        return true
      },
      kind
    })
  }
}

registerBuiltinDeepLinkRoutes()
