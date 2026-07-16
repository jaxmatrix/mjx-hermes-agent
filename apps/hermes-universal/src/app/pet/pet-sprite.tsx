import { useEffect, useRef } from 'react'

import { useStore } from '@/store/atom'
import { $petInfo, type PetInfo } from '@/store/pet'

const DEFAULT_FRAME_W = 192
const DEFAULT_FRAME_H = 208
const DEFAULT_FRAMES = 6
const DEFAULT_LOOP_MS = 1100
const DEFAULT_SCALE = 0.33
const DEFAULT_ROWS = ['idle', 'running-right', 'running-left', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review']

/**
 * Pick the running row + mirror for a horizontal travel direction.
 *
 * The codex spritesheets' dedicated `running-left`/`running-right` rows are, in
 * practice, drawn facing the OPPOSITE of their name relative to travel here — so
 * moving right uses the `running-left` row (its art faces right) and vice-versa
 * (verified against the observed pet; this is the inverse of the desktop's
 * name=facing assumption). A pet without those rows falls back to the in-place
 * run row (faces left by convention), so rightward travel is mirrored; returns
 * no `row` there so the caller lets the normal run row resolve it.
 */
export function roamWalkRow(dir: -1 | 0 | 1, stateRows?: string[]): { row?: string; mirror: boolean } {
  if (dir === 0) {
    return { mirror: false }
  }

  const rows = stateRows ?? DEFAULT_ROWS
  const hasLeft = rows.includes('running-left')
  const hasRight = rows.includes('running-right')

  if (dir > 0) {
    // Moving right.
    if (hasLeft) {
      return { mirror: true, row: 'running-left' }
    }
    if (hasRight) {
      return { mirror: false, row: 'running-right' }
    }
    return { mirror: false }
  }

  // Moving left.
  if (hasRight) {
    return { mirror: true, row: 'running-right' }
  }
  if (hasLeft) {
    return { mirror: false, row: 'running-left' }
  }
  return { mirror: true }
}

// Canvas renderer for a petdex spritesheet (adapted from desktop pet-sprite.tsx).
// Draws the row for `state` (idle / run) — or a forced `rowOverride` (a concrete
// row name, e.g. `running-right`, used by the roam wander) — stepping frames
// across loopMs.
export function PetSprite({
  state = 'idle',
  zoom = 1,
  info: infoProp,
  rowOverride
}: {
  state?: 'idle' | 'run'
  zoom?: number
  info?: PetInfo
  rowOverride?: string
}) {
  const stored = useStore($petInfo)
  const info = infoProp ?? stored
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stateRef = useRef(state)
  stateRef.current = state
  const rowOverrideRef = useRef(rowOverride)
  rowOverrideRef.current = rowOverride

  const enabled = info.enabled && Boolean(info.spritesheetBase64)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !enabled || !info.spritesheetBase64) {
      return
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      return
    }

    const frameW = info.frameW ?? DEFAULT_FRAME_W
    const frameH = info.frameH ?? DEFAULT_FRAME_H
    const loopMs = info.loopMs ?? DEFAULT_LOOP_MS
    const scale = (info.scale ?? DEFAULT_SCALE) * zoom
    const rows = info.stateRows ?? DEFAULT_ROWS
    const drawW = Math.max(1, Math.round(frameW * scale))
    const drawH = Math.max(1, Math.round(frameH * scale))
    canvas.width = drawW
    canvas.height = drawH

    const rowFor = (s: 'idle' | 'run') => {
      const keys = s === 'run' ? ['running-right', 'running', 'run'] : ['idle']
      for (const k of keys) {
        const i = rows.indexOf(k)
        if (i >= 0) {
          return { index: i, key: k }
        }
      }
      return { index: 0, key: 'idle' }
    }

    const img = new Image()
    img.src = `data:${info.mime ?? 'image/webp'};base64,${info.spritesheetBase64}`

    let raf = 0
    let frame = 0
    let last = performance.now()
    let activeRow = -1

    const draw = (now: number) => {
      // A concrete roam row (running-left/right) wins over the idle/run mapping.
      const override = rowOverrideRef.current
      const ovIdx = override ? rows.indexOf(override) : -1
      const { index, key } = ovIdx >= 0 ? { index: ovIdx, key: override! } : rowFor(stateRef.current)
      const count = Math.max(1, info.framesByState?.[key] ?? info.framesPerState ?? DEFAULT_FRAMES)
      if (index !== activeRow) {
        activeRow = index
        frame = 0
        last = now
      }
      if (now - last >= loopMs / count) {
        frame = (frame + 1) % count
        last = now
      }
      ctx.clearRect(0, 0, drawW, drawH)
      if (img.complete && img.naturalWidth > 0) {
        ctx.imageSmoothingEnabled = false
        ctx.drawImage(img, frame * frameW, index * frameH, frameW, frameH, 0, 0, drawW, drawH)
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)

    return () => cancelAnimationFrame(raf)
  }, [enabled, info.spritesheetBase64, info.spritesheetRevision, info.mime, info.frameW, info.frameH, info.loopMs, info.scale, info.framesPerState, info.stateRows, info.framesByState, zoom])

  if (!enabled) {
    return null
  }
  return <canvas className="[image-rendering:pixelated]" ref={canvasRef} />
}
