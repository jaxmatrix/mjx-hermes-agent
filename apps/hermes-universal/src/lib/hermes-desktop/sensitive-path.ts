/**
 * Electron's `sensitiveFileBlockReason` (`electron/hardening.ts`), rule for rule:
 * the files a preview must not pull into the webview because a model named them.
 *
 * LEXICAL ONLY. Electron runs the same rules again on the file's REAL path, so a
 * symlink to `~/.ssh/id_ed25519` is refused there and is not here — the webview
 * cannot resolve one. The complete check belongs in `read_capped_file_base64`.
 * A guard, not a boundary: the OS is the boundary (`SECURITY.md`).
 */

const SAFE_ENV_SUFFIXES = new Set(['dist', 'example', 'sample', 'template'])
const SENSITIVE_EXTENSIONS = new Set(['.kdbx', '.p12', '.pem', '.pfx'])

export function sensitivePathBlockReason(filePath: string): null | string {
  const normalized = String(filePath || '')
    .replace(/\\/g, '/')
    .toLowerCase()

  const basename = normalized.split('/').filter(Boolean).pop() ?? ''
  const dot = basename.lastIndexOf('.')
  const ext = dot > 0 ? basename.slice(dot) : ''

  if (!basename) {
    return null
  }

  if (normalized.includes('/.ssh/')) {
    return 'SSH key/config files are blocked.'
  }

  if (normalized.includes('/.gnupg/')) {
    return 'GPG key material is blocked.'
  }

  if (normalized.endsWith('/.aws/credentials')) {
    return 'AWS credential files are blocked.'
  }

  if (basename === '.env') {
    return '.env files are blocked because they commonly contain secrets.'
  }

  if (basename.startsWith('.env.') && !SAFE_ENV_SUFFIXES.has(basename.slice('.env.'.length))) {
    return `${basename} is blocked because it appears to contain environment secrets.`
  }

  if (/^id_(rsa|dsa|ecdsa|ed25519)(?:\..+)?$/.test(basename) && !basename.endsWith('.pub')) {
    return 'SSH private key files are blocked.'
  }

  if (SENSITIVE_EXTENSIONS.has(ext)) {
    return `${ext} key/certificate files are blocked.`
  }

  if (basename === '.npmrc' || basename === '.netrc' || basename === '.pypirc') {
    return `${basename} is blocked because it may include auth credentials.`
  }

  return null
}
