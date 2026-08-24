/**
 * A plugin identifier → the links a consent dialog must be able to show.
 *
 * PURE string work (rule 35). Nothing here clones, fetches or probes: the
 * gateway does the install, and this only answers "what am I about to trust,
 * and where can I go read it first" — which is the whole content of an informed
 * consent prompt.
 *
 * Ported from `apps/desktop/src/lib/plugin-source-urls.ts`, plus one field
 * universal needs: `insecure`. Desktop's dialog is reached from its own UI; here
 * a `hermes://plugin/install` link can put ANY identifier in front of the user,
 * including an `http://` or `file://` git URL, and a dialog that renders those
 * as ordinary sources is the one that gets someone.
 */

const GITHUB_BROWSER_SEGMENTS = new Set(['blob', 'commit', 'tree'])
const GITHUB_PREFIX = 'https://github.com/'

export interface PluginSourceLinks {
  /** What the gateway will clone. */
  gitUrl: string
  /** A human-readable page for the same source, when one can be derived. */
  browseUrl: null | string
  /** Monorepo sub-path, when the identifier named one. */
  subdir: null | string
  /**
   * The transport carries no authentication of the source: plain `http://` (a
   * network attacker chooses the code) or `file://` (a path the link author
   * chose). Not a refusal — a LAN git server over http is a real setup — but the
   * dialog must say so before the user consents.
   */
  insecure: boolean
}

function resolvePluginGitUrl(identifier: string): { gitUrl: string; subdir: null | string } {
  const trimmed = identifier.trim()

  if (!trimmed) {
    throw new Error('Plugin identifier is required.')
  }

  // Case-INSENSITIVE, unlike desktop's: a URL scheme is case-insensitive per
  // RFC 3986, and desktop's anchored lowercase test sends `HTTP://host/x.git`
  // down the `owner/repo` branch instead — turning a cleartext URL the dialog
  // would have warned about into a github.com identifier it would not.
  if (/^(file:\/\/|git@|https?:\/\/|ssh:\/\/)/i.test(trimmed)) {
    if (trimmed.toLowerCase().startsWith(GITHUB_PREFIX)) {
      const rest = (trimmed.slice(GITHUB_PREFIX.length).split(/[#?]/)[0] ?? '').replace(/\/+$/, '')
      const parts = rest.split('/').filter(Boolean)

      // `…/owner/repo/tree/<ref>/<subdir>` — the URL a user copies out of the
      // GitHub file browser, which is not a clone URL.
      if (parts.length >= 3 && parts[2] && GITHUB_BROWSER_SEGMENTS.has(parts[2])) {
        const repo = (parts[1] ?? '').replace(/\.git$/, '')

        const subdir =
          parts[2] === 'tree' && parts.length >= 5 ? parts.slice(4).join('/').replace(/\/+$/, '') || null : null

        return { gitUrl: `${GITHUB_PREFIX}${parts[0]}/${repo}.git`, subdir }
      }
    }

    if (trimmed.includes('#')) {
      const at = trimmed.indexOf('#')

      return {
        gitUrl: trimmed.slice(0, at),
        subdir: trimmed.slice(at + 1).replace(/^\/+|\/+$/g, '') || null
      }
    }

    const marker = '.git/'

    if (trimmed.includes(marker)) {
      const at = trimmed.indexOf(marker)

      return {
        gitUrl: trimmed.slice(0, at + marker.length - 1),
        subdir: trimmed.slice(at + marker.length).replace(/^\/+|\/+$/g, '') || null
      }
    }

    return { gitUrl: trimmed, subdir: null }
  }

  const parts = trimmed.split('/').filter(Boolean)

  if (parts.length >= 2) {
    const [owner, repo, ...rest] = parts

    return {
      gitUrl: `${GITHUB_PREFIX}${owner}/${repo}.git`,
      subdir: rest.join('/').replace(/\/+$/, '') || null
    }
  }

  throw new Error('Invalid plugin identifier.')
}

function githubBrowseBase(gitUrl: string): null | string {
  const ssh = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i.exec(gitUrl)

  if (ssh) {
    return `${GITHUB_PREFIX}${ssh[1]}/${(ssh[2] ?? '').replace(/\.git$/, '')}`
  }

  try {
    const url = new URL(gitUrl)

    if (url.hostname.toLowerCase() === 'github.com') {
      const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean)

      if (parts.length >= 2) {
        return `${GITHUB_PREFIX}${parts[0]}/${(parts[1] ?? '').replace(/\.git$/, '')}`
      }
    }
  } catch {
    return null
  }

  return null
}

function browseUrlFromGitUrl(gitUrl: string, subdir: null | string): null | string {
  const github = githubBrowseBase(gitUrl)

  if (github) {
    return subdir ? `${github}/tree/HEAD/${subdir}` : github
  }

  // Only an https source gets a browse link. An `http://` one would put a link
  // the app is warning about into the dialog as something to click.
  if (/^https:\/\//i.test(gitUrl)) {
    const base = gitUrl.replace(/\.git$/, '')

    return subdir ? `${base}/tree/HEAD/${subdir}` : base
  }

  return null
}

/** Resolve an identifier, or null when it is not one. */
export function resolvePluginSourceLinks(identifier: string): null | PluginSourceLinks {
  try {
    const { gitUrl, subdir } = resolvePluginGitUrl(identifier)

    return {
      browseUrl: browseUrlFromGitUrl(gitUrl, subdir),
      gitUrl,
      insecure: /^(file|http):\/\//i.test(gitUrl),
      subdir
    }
  } catch {
    return null
  }
}
