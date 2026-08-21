/**
 * `/api/status`'s `gateway_platforms` keys.
 *
 * A secondary-profile adapter reports its platform NAMESPACED —
 * `"<profile>:<platform>"` — and `hermes_cli/web_server.py` projects those keys
 * verbatim (`_status_platform_key_allowed` validates the grammar rather than
 * rewriting them). The map is `Record<string, PlatformStatus>`, so the colon
 * keys type-check and never crash a consumer; they just make every consumer
 * that treats the key as a bare platform id quietly wrong:
 *
 *  - the statusbar's `id !== 'api_server'` filter misses `"work:api_server"`,
 *    so the API server renders as a messaging platform;
 *  - `PLATFORM_ICONS["work:telegram"]` misses, so a namespaced platform loses
 *    its brand icon and falls back to a "W" monogram;
 *  - the gateway menu prints the raw key, so the row reads "Work:telegram".
 *
 * Splitting the key once, here, is what keeps those three honest.
 */

/** A `gateway_platforms` key split into its parts. `profile` is '' for a plain,
 *  un-namespaced key (the active/default profile's own platforms). */
export interface PlatformStatusKey {
  platform: string
  profile: string
}

export function splitPlatformStatusKey(key: string): PlatformStatusKey {
  const colon = key.indexOf(':')

  // Only a key with content on BOTH sides is a namespace. A leading or trailing
  // colon is not a profile — treat the whole thing as the platform id so a
  // malformed key still renders as itself rather than as an empty row.
  if (colon <= 0 || colon === key.length - 1) {
    return { platform: key, profile: '' }
  }

  return { platform: key.slice(colon + 1), profile: key.slice(0, colon) }
}

/** The bare platform id behind a status key — what `PLATFORM_ICONS` is keyed by. */
export function platformStatusId(key: string): string {
  return splitPlatformStatusKey(key).platform
}
