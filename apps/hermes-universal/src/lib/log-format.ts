// Shared log-line hygiene for the gateway log surfaces (the statusbar gateway-menu
// tail and the Settings → Gateway diagnostics). One place so both read identically.

// Per-connection WebSocket churn (accept/close/heartbeat) drowns out anything
// useful — strip it so the tail reads as real gateway activity at a glance.
export const LOG_NOISE_RE = /\bws (?:accepted|closed|response sent|ping|pong)\b/i

// Strip leading "YYYY-MM-DD HH:MM:SS,mmm " and "[runtime_id] " prefixes from log
// lines so they don't dominate the display. Full text is preserved on hover.
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}[,.\d]*\s+/
const RUNTIME_BRACKET_RE = /^\[[^\]]+]\s+/

export const trimLogLine = (raw: string): string =>
  raw.trim().replace(TIMESTAMP_RE, '').replace(RUNTIME_BRACKET_RE, '')
