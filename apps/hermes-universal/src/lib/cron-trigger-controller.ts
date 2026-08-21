/**
 * VENDORED from `apps/shared/src/cron-trigger-controller.ts`, byte-for-byte in
 * shape. Universal imports nothing from `apps/shared` (it builds for Android and
 * iOS as well as desktop, and the shared package is desktop/web-only), so the
 * file is copied rather than imported — keep the two identical so a later
 * upstream sync diffs cleanly instead of merging two divergent guards.
 */

export interface CronTriggerRunResult<T> {
  started: boolean
  value: T | null
}

export interface CronTriggerController {
  isRunning(key: string): boolean
  run<T>(key: string, action: () => Promise<T>, onStarted?: () => void): Promise<CronTriggerRunResult<T>>
}

// This is an interaction guard for one mounted UI surface. Cross-window and
// cross-process exclusion remains the backend's responsibility via its durable
// cron claim; a renderer-local Set must never be treated as the execution lock.
export function createCronTriggerController(
  onRunningChange: (key: string, running: boolean) => void = () => undefined
): CronTriggerController {
  const running = new Set<string>()

  return {
    isRunning: key => running.has(key),
    async run<T>(key: string, action: () => Promise<T>, onStarted?: () => void) {
      if (running.has(key)) {
        return { started: false, value: null }
      }

      running.add(key)

      try {
        onRunningChange(key, true)

        onStarted?.()

        return { started: true, value: await action() }
      } finally {
        running.delete(key)
        onRunningChange(key, false)
      }
    }
  }
}
