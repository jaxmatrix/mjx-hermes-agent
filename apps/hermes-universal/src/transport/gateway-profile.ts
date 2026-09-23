import { PROFILE_METHODS, UNSCOPED_METHODS } from './gateway-profile-methods.generated'

/**
 * A gateway socket's profile (MJXHRM-602).
 *
 * Every backend here is the unified server: `/api/ws` has no profile, an RPC
 * names its own, and one that names none runs as the launch profile. Desktop's
 * registry assumes the opposite — a secondary IS its profile's backend, so it
 * sends `params` as they came — and it cannot be edited. So the socket carries
 * its profile in the one thing the registry hands the client, the URL (the
 * `?profile=` Electron's `registryGatewayWsUrl` adds, which the backend
 * ignores), and `HermesGateway` names it on the way out.
 */

const PROFILE_PARAM = 'profile'

/** `wsUrl` for `profile`'s socket. */
export function withSocketProfile(wsUrl: string, profile: string): string {
  const url = new URL(wsUrl)

  url.searchParams.set(PROFILE_PARAM, profile)

  return url.toString()
}

/** The profile `wsUrl` was minted for; none is the launch profile. */
export function socketProfile(wsUrl: string): string | undefined {
  try {
    return new URL(wsUrl).searchParams.get(PROFILE_PARAM)?.trim() || undefined
  } catch {
    // `connect()` refuses the URL in its own words.
    return undefined
  }
}

/**
 * `params` as the wire contract takes them on a socket for `profile`.
 *
 * Params models are `extra="forbid"` (`tui_gateway/contracts/base.py`), so both
 * directions are decided per method, from the contract: a method that declares
 * `profile` gets the socket's when the caller named none, and a method that
 * does not loses one it was given — the registry stamps a shared route's
 * `profile` on every method, which answers `4000` on those. A method the
 * contract does not know is sent as it came.
 */
export function profileScoped(
  method: string,
  params: Record<string, unknown>,
  profile: string | undefined
): Record<string, unknown> {
  if (Object.hasOwn(params, PROFILE_PARAM)) {
    if (!UNSCOPED_METHODS.has(method)) {
      return params
    }

    const { [PROFILE_PARAM]: _dropped, ...rest } = params

    return rest
  }

  return profile && PROFILE_METHODS.has(method) ? { ...params, [PROFILE_PARAM]: profile } : params
}
