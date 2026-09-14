import { normalize } from '@/lib/text'

/**
 * The one reasoning-effort vocabulary this client knows.
 *
 * It mirrors the backend's canonical ladder — `hermes_constants.py`
 * `VALID_REASONING_EFFORTS`, which `agent/reasoning_effort.py` `EFFORT_LADDER`
 * and `gateway/platforms/api_server.py` `_REASONING_EFFORTS` both agree with
 * (`none` + these seven). Everything above `high` is real: the API server was
 * widened to accept `max`/`ultra` precisely so browser and desktop clients
 * stopped being second-class citizens of the ladder.
 *
 * A model that cannot take the level asked for is the SERVER's problem, not the
 * picker's: `clamp_effort` takes the nearest weaker level each provider wire
 * actually supports. The catalog's own `supported_efforts` is deliberately not
 * forwarded to clients (`hermes_cli/inventory.py`) because it under-reports —
 * filtering the picker by it would hide levels that demonstrably work. So the
 * picker offers the whole ladder and lets the clamp do its job.
 *
 * It lives here rather than beside one of the three surfaces that need it
 * (the model submenu, the Model settings page, the delegation config row)
 * because that is exactly how it drifted: the delegation row's copy stopped at
 * `xhigh`, so a subagent could never be asked for `max` from the UI even though
 * the gateway accepts it. Desktop keeps the same module at the same path.
 *
 * `none` is not a level — it is thinking disabled, owned by the Thinking
 * toggle rather than the scale.
 */
export const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

/** The scale plus the off state — the full set a config value may hold. */
export const REASONING_EFFORT_VALUES = ['none', ...REASONING_EFFORTS] as const

/** Hermes' built-in level when neither the surface nor the profile config
 *  specifies one (mirrors the backend's own fallback). */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'medium'

export const isReasoningEffort = (value: string): value is ReasoningEffort =>
  REASONING_EFFORTS.includes(normalize(value) as ReasoningEffort)

/** Thinking is on unless a level explicitly says otherwise; an empty value
 *  means "inherit", so it resolves through `fallback` first. */
export const isThinkingEnabled = (effort: string, fallback: string = DEFAULT_REASONING_EFFORT): boolean =>
  normalize(effort || fallback) !== 'none'

/** The level a scale control should show. Empty inherits `fallback`; `none`
 *  (thinking off) selects nothing; anything unrecognized clamps to the default. */
export function resolveReasoningEffort(effort: string, fallback: string = DEFAULT_REASONING_EFFORT): string {
  const value = normalize(effort || fallback)

  if (value === 'none') {
    return ''
  }

  return isReasoningEffort(value) ? value : DEFAULT_REASONING_EFFORT
}
