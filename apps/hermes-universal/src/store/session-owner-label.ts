/**
 * WHOSE session this is, as a name a person reads — `Radar: Bot Chat`.
 *
 * A bot is a profile, and a session a bot owns reads under the bot's name on
 * every surface that names a session: the Sessions sidebar row, the chat header,
 * the workspace tab, every tile tab and the switcher (MJXHRM-518). The label is
 * DISPLAY ONLY — rename, drag payloads, search and slash matching keep the bare
 * title, or a rename would write the prefix into the row.
 *
 * The names are CONTRIBUTED, never derived here. A bot's name is Bot Mode's own
 * (`ui_meta['hermes-bots'].title` wins over the profile's `display_name`), and
 * core does not read a plugin's record — so the plugin publishes the names its
 * own rows show, through `host.setSessionOwnerLabels`, and the two can never
 * disagree. A profile nobody named reads exactly as it always did.
 */

import { atom } from '@/store/atom'

/** Profile key → the name its sessions read under. */
export const $sessionOwnerLabels = atom<Readonly<Record<string, string>>>({})

const ownerKey = (profile: null | string | undefined): string => (profile ?? '').trim() || 'default'

/**
 * REPLACE the whole set. A profile left out reads bare again, which is how a
 * deleted or renamed bot stops lending its name to sessions.
 *
 * Writes only on a real change: every surface above re-renders — and every tab
 * re-registers — on this atom, and the roster that feeds it refreshes on a poll.
 */
export function setSessionOwnerLabels(labels: Readonly<Record<string, string>>): void {
  const next: Record<string, string> = {}

  for (const [profile, label] of Object.entries(labels)) {
    const name = typeof label === 'string' ? label.trim() : ''

    if (name) {
      next[ownerKey(profile)] = name
    }
  }

  const current = $sessionOwnerLabels.get()
  const currentKeys = Object.keys(current)

  if (currentKeys.length === Object.keys(next).length && currentKeys.every(key => current[key] === next[key])) {
    return
  }

  $sessionOwnerLabels.set(next)
}

/** The name `profile`'s sessions read under, if anyone named it. */
export function sessionOwnerLabel(
  profile: null | string | undefined,
  labels: Readonly<Record<string, string>> = $sessionOwnerLabels.get()
): string | undefined {
  return labels[ownerKey(profile)]
}

/** `title` as a surface should SHOW it: under its owner's name when one was
 *  given, bare otherwise. Pass `labels` from a subscription in a render. */
export function withSessionOwner(
  title: string,
  profile: null | string | undefined,
  labels: Readonly<Record<string, string>> = $sessionOwnerLabels.get()
): string {
  const owner = sessionOwnerLabel(profile, labels)

  return owner ? `${owner}: ${title}` : title
}
