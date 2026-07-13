import { useEffect, useRef } from 'react'

import type { StarmapEdge, StarmapNode } from '@/types/hermes'

import { buildSimulation, categoryColor, nodeRadius, seedNodes, type SimLink, type SimNode } from './graph-sim'

// Interactive force-graph on a 2D canvas with touch pan / pinch-zoom / tap-select.
// The desktop starmap's ring/recency choreography + share-code + timeline are
// simplified away (FIXME(K8)); this is a standard force-directed memory graph.
export function StarmapCanvas({
  edges,
  nodes,
  onSelect
}: {
  edges: StarmapEdge[]
  nodes: StarmapNode[]
  onSelect: (node: StarmapNode) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect

  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) {
      return
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      return
    }

    // ── World / camera state (refs so pan/zoom never trigger React renders) ──
    const simNodes = seedNodes(nodes)
    const byId = new Map(simNodes.map(n => [n.id, n]))
    const links: SimLink[] = edges.flatMap(e => (byId.has(e.source) && byId.has(e.target) ? [{ source: e.source, target: e.target }] : []))
    const sim = buildSimulation(simNodes, links)

    let scale = 1
    let tx = 0
    let ty = 0
    let width = 0
    let height = 0
    let dpr = 1
    const selected = { id: null as string | null }

    const worldToScreen = (wx: number, wy: number) => ({ x: width / 2 + tx + wx * scale, y: height / 2 + ty + wy * scale })
    const screenToWorld = (sx: number, sy: number) => ({ x: (sx - width / 2 - tx) / scale, y: (sy - height / 2 - ty) / scale })

    // ── Render loop: tick while hot, redraw on demand, else pause (battery) ──
    let raf: number | null = null
    let needsDraw = false

    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)

      ctx.lineWidth = 1
      ctx.strokeStyle = 'rgba(140,150,170,0.18)'
      for (const link of links) {
        const s = link.source as SimNode
        const t = link.target as SimNode
        if (s.x == null || t.x == null) {
          continue
        }
        const a = worldToScreen(s.x, s.y ?? 0)
        const b = worldToScreen(t.x, t.y ?? 0)
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
      }

      const showLabels = scale > 1.4
      for (const node of simNodes) {
        if (node.x == null) {
          continue
        }
        const p = worldToScreen(node.x, node.y ?? 0)
        const r = nodeRadius(node) * Math.min(1.4, Math.max(0.7, scale))
        const isSel = selected.id === node.id
        ctx.beginPath()
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
        ctx.fillStyle = categoryColor(node.category)
        ctx.globalAlpha = node.useCount > 0 ? 1 : 0.75
        ctx.fill()
        ctx.globalAlpha = 1
        if (node.pinned || isSel) {
          ctx.lineWidth = isSel ? 2.5 : 1.5
          ctx.strokeStyle = isSel ? '#ffffff' : 'rgba(255,255,255,0.7)'
          ctx.stroke()
        }
        if (showLabels || isSel) {
          ctx.fillStyle = 'rgba(230,235,245,0.9)'
          ctx.font = '11px system-ui, sans-serif'
          ctx.textAlign = 'center'
          ctx.fillText(node.label.slice(0, 22), p.x, p.y + r + 12)
        }
      }
    }

    const frame = () => {
      const hot = sim.alpha() > 0.01
      if (hot) {
        sim.tick()
      }
      draw()
      if (hot || needsDraw) {
        needsDraw = false
        raf = requestAnimationFrame(frame)
      } else {
        raf = null
      }
    }
    const kick = () => {
      needsDraw = true
      if (raf == null) {
        raf = requestAnimationFrame(frame)
      }
    }

    // ── Sizing ──
    const resize = () => {
      const rect = container.getBoundingClientRect()
      width = rect.width
      height = rect.height
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      kick()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(container)
    resize()

    // ── Touch / pointer input ──
    const pointers = new Map<number, { x: number; y: number }>()
    let pinchDist = 0
    let down: { x: number; y: number; t: number; moved: number } | null = null

    const localPoint = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect()
      return { x: e.clientX - rect.left, y: e.clientY - rect.top }
    }

    const onDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId)
      const p = localPoint(e)
      pointers.set(e.pointerId, p)
      if (pointers.size === 1) {
        down = { x: p.x, y: p.y, t: performance.now(), moved: 0 }
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()]
        pinchDist = Math.hypot(a.x - b.x, a.y - b.y)
        down = null
      }
    }

    const onMove = (e: PointerEvent) => {
      const prev = pointers.get(e.pointerId)
      if (!prev) {
        return
      }
      const p = localPoint(e)
      pointers.set(e.pointerId, p)

      if (pointers.size >= 2) {
        const [a, b] = [...pointers.values()]
        const dist = Math.hypot(a.x - b.x, a.y - b.y)
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
        if (pinchDist > 0) {
          const worldMid = screenToWorld(mid.x, mid.y)
          scale = Math.min(6, Math.max(0.25, scale * (dist / pinchDist)))
          tx = mid.x - width / 2 - worldMid.x * scale
          ty = mid.y - height / 2 - worldMid.y * scale
        }
        pinchDist = dist
        kick()
        return
      }

      // Single-pointer pan.
      const dx = p.x - prev.x
      const dy = p.y - prev.y
      tx += dx
      ty += dy
      if (down) {
        down.moved += Math.hypot(dx, dy)
      }
      kick()
    }

    const hitTest = (sx: number, sy: number): SimNode | null => {
      let best: SimNode | null = null
      let bestD = Infinity
      for (const node of simNodes) {
        if (node.x == null) {
          continue
        }
        const p = worldToScreen(node.x, node.y ?? 0)
        const d = Math.hypot(p.x - sx, p.y - sy)
        const r = nodeRadius(node) * Math.min(1.4, Math.max(0.7, scale)) + 8
        if (d < r && d < bestD) {
          bestD = d
          best = node
        }
      }
      return best
    }

    const onUp = (e: PointerEvent) => {
      const wasTap = down && pointers.size === 1 && down.moved < 8 && performance.now() - down.t < 400
      pointers.delete(e.pointerId)
      if (pinchDist && pointers.size < 2) {
        pinchDist = 0
      }
      if (wasTap && down) {
        const node = hitTest(down.x, down.y)
        if (node) {
          selected.id = node.id
          onSelectRef.current(node)
          kick()
        }
      }
      down = null
    }

    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onUp)

    return () => {
      ro.disconnect()
      sim.stop()
      if (raf != null) {
        cancelAnimationFrame(raf)
      }
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
    }
  }, [nodes, edges])

  return (
    <div className="min-h-0 flex-1" ref={containerRef}>
      <canvas className="touch-none" ref={canvasRef} />
    </div>
  )
}
