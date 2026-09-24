import type { Translations } from '@/i18n'
import type { SshErrorKind, SshStep } from '@/store/ssh-backend'

// Copy maps for SSH gateway mode, kept out of the configurator so both are
// exhaustive over their unions and testable without rendering anything.
//
// Ported from desktop `src/app/settings/gateway-settings.tsx:482-495` (the
// error→copy map) and extended with the progress steps, which desktop has no
// equivalent of — it never surfaced connect progress at all.

type Gateway = Translations['settings']['gateway']

/**
 * The user-facing message for a failure kind.
 *
 * Every kind maps to something specific and actionable. A `Record` rather than a
 * switch with a default, so adding a kind to the union is a type error here
 * instead of silently degrading to "the SSH connection failed".
 */
const ERROR_COPY: Record<SshErrorKind, (g: Gateway) => string> = {
  unreachable: g => g.sshErrUnreachable,
  'auth-failed': g => g.sshErrAuth,
  'host-key-changed': g => g.sshErrHostKey,
  timeout: g => g.sshErrTimeout,
  'hermes-not-found': g => g.sshErrNotInstalled,
  'unsupported-platform': g => g.sshErrPlatform,
  'update-required': g => g.sshErrUpdateRequired,
  // A blip on a link that was working. Distinct from `unreachable`, which means
  // we never got there at all — telling the user to check their address would
  // send them after the wrong thing.
  'transient-transport-error': g => g.sshErrTimeout,
  // The lockfile pointed at a backend that turned out not to be ours. Rust has
  // already cleaned up and will respawn, so this only surfaces if that failed too.
  'authenticated-stale': g => g.sshErrUnknown,
  // A newer attempt threw away work this caller had finished — its own failure,
  // so it IS surfaced. The quiet contract is the `quiet` flag, not this kind
  // (MJXHRM-592): a caller that stays silent does so on the flag alone.
  superseded: g => g.sshErrUnknown,
  cancelled: g => g.sshErrUnknown,
  unknown: g => g.sshErrUnknown
}

/**
 * Turn a rejection into copy. Falls back to the raw message for anything that is
 * not one of our typed errors (a JS TypeError, an IPC failure), because a
 * generic "the SSH connection failed" would hide a real bug.
 */
export function sshErrorMessage(error: unknown, g: Gateway): string {
  if (isSshErrorLike(error)) {
    const copy = ERROR_COPY[error.kind]

    if (copy) {
      return copy(g)
    }

    // A kind Rust knows about and this build does not. Its raw message is far
    // more useful than "the SSH connection failed" — that would hide a genuine
    // version skew behind copy that reads like an ordinary network problem.
    if (error.message) {
      return error.message
    }
  }

  if (error instanceof Error) {
    return error.message
  }

  return typeof error === 'string' && error ? error : g.sshErrUnknown
}

/**
 * The copy for a tunnel failure (MJXHRM-592). A tunnel error's `kind` is the
 * tunnel's own, so the SSH kind it came from (`sshKind`) picks the copy first —
 * the same words the configurator shows. The tunnel kinds with no SSH kind map
 * onto existing copy; only a locked device has a string of its own. Rust's
 * English message belongs in a notification's detail, never here.
 */
export function tunnelErrorMessage(error: unknown, g: Gateway): string {
  const tunnel = (typeof error === 'object' && error !== null ? error : {}) as {
    kind?: string
    sshKind?: SshErrorKind
  }

  if (tunnel.sshKind && ERROR_COPY[tunnel.sshKind]) {
    return ERROR_COPY[tunnel.sshKind](g)
  }

  switch (tunnel.kind) {
    case 'locked':
      return g.sshErrLocked

    case 'credentials-needed':
      return g.sshErrAuth

    case 'host-key-changed':
      return g.sshErrHostKey

    case 'hermes-not-found':
      return g.sshErrNotInstalled

    case 'update-required':
      return g.sshErrUpdateRequired

    case 'unsupported-platform':
      return g.sshErrPlatform

    default:
      return g.sshErrUnknown
  }
}

function isSshErrorLike(value: unknown): value is { kind: SshErrorKind; message: string } {
  return typeof value === 'object' && value !== null && typeof (value as { kind?: unknown }).kind === 'string'
}

/** The label for a connect step. Same exhaustiveness rationale as above. */
const STEP_COPY: Record<SshStep, (g: Gateway) => string> = {
  connecting: g => g.sshStepConnecting,
  authenticating: g => g.sshStepAuthenticating,
  'probing-platform': g => g.sshStepProbingPlatform,
  'locating-hermes': g => g.sshStepLocatingHermes,
  'checking-existing': g => g.sshStepCheckingExisting,
  'uploading-token': g => g.sshStepUploadingToken,
  spawning: g => g.sshStepSpawning,
  'waiting-ready': g => g.sshStepWaitingReady,
  forwarding: g => g.sshStepForwarding,
  verifying: g => g.sshStepVerifying
}

export function sshStepLabel(step: SshStep, g: Gateway): string {
  return STEP_COPY[step]?.(g) ?? g.sshStepConnecting
}
