/**
 * Product naming — the single switch for the Allr white-label.
 *
 * Every user-visible sentence that names the product reads from here, so the
 * experiment can be reversed by editing this file rather than by walking a few
 * hundred string literals again.
 *
 * What deliberately does NOT read from here, and must not be changed with it:
 *
 *   • persisted keys — `hermes.*` / `hermes:*` / `hermes-*` in localStorage
 *   • module paths and type names — `@/hermes`, `HermesGateway`, …
 *   • the wire contract with the backend — `X-Hermes-Session-Token`, the
 *     `HERMES_BACKEND_READY port=` handshake, `HERMES_*` env vars, `~/.hermes`
 *   • the Tauri bundle identifier (it is the Android applicationId AND the
 *     keyring service name — renaming it orphans stored credentials)
 *
 * Those are contracts with an unchanged backend and with existing user state.
 * Renaming them does not rebrand anything; it just breaks things quietly.
 */

/** Capitalised — prose, titles, metadata, anywhere the name is a noun. */
export const BRAND = 'Allr'

/** Lowercase — the wordmark lockup. Never `ALLR`; the brand book forbids it. */
export const BRAND_LOWER = 'allr'

/** The hosted backend, as users refer to it. */
export const BRAND_CLOUD = `${BRAND} Cloud`

/** Hero eyebrow from the brand book — used on the connect/first-run screens. */
export const BRAND_TAGLINE = 'One workspace. Finished work.'
