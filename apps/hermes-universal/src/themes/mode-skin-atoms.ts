/**
 * Cross-WebView appearance atoms. Desktop's ThemeProvider uses profile prefs;
 * universal peers still announce via `$mode` / `$skin` (appearance-sync).
 */
import { Codecs, persistentAtom } from '@/lib/persisted'

export const $skin = persistentAtom<string>('hermes.skin', 'default', Codecs.text)
export const $mode = persistentAtom<string>('hermes.mode', 'system', Codecs.text)
