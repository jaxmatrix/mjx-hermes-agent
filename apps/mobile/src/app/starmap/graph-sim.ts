import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation
} from 'd3-force'

import type { StarmapEdge, StarmapGraph, StarmapNode } from '@/types/hermes'

export type StarmapFilter = 'all' | 'used' | 'learned'

export interface SimNode extends StarmapNode {
  x?: number
  y?: number
  vx?: number
  vy?: number
  index?: number
}
export interface SimLink {
  source: string | SimNode
  target: string | SimNode
}

// Deterministic string hash (FNV-ish) — stable node placement + category hues.
export function hash(value: string): number {
  let h = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** A category maps to a stable HSL hue so clusters read as color families. */
export function categoryColor(category: string): string {
  return `hsl(${hash(category || 'other') % 360}, 55%, 62%)`
}

/** Node radius grows sub-linearly with use so hot nodes read bigger, capped. */
export function nodeRadius(node: Pick<StarmapNode, 'useCount' | 'pinned'>): number {
  return (node.pinned ? 6 : 5) + Math.min(Math.sqrt(Math.max(0, node.useCount)) * 1.6, 14)
}

/** All / Used (has activity) / Learned (agent-created or a memory node). */
export function filterNodes(nodes: StarmapNode[], filter: StarmapFilter): StarmapNode[] {
  if (filter === 'used') {
    return nodes.filter(n => n.useCount > 0)
  }
  if (filter === 'learned') {
    return nodes.filter(n => n.kind === 'memory' || Boolean(n.createdBy))
  }
  return nodes
}

/** Filtered nodes + only the edges whose endpoints both survive the filter. */
export function filterGraph(graph: StarmapGraph, filter: StarmapFilter): { nodes: StarmapNode[]; edges: StarmapEdge[] } {
  const nodes = filterNodes(graph.nodes, filter)
  const ids = new Set(nodes.map(n => n.id))
  return { nodes, edges: graph.edges.filter(e => ids.has(e.source) && ids.has(e.target)) }
}

/** A seeded, spread-out starting position so the layout doesn't collapse to a point. */
export function seedNodes(nodes: StarmapNode[]): SimNode[] {
  return nodes.map(n => {
    const a = (hash(n.id) % 360) * (Math.PI / 180)
    const r = 40 + (hash(n.id + 'r') % 200)
    return { ...n, x: Math.cos(a) * r, y: Math.sin(a) * r }
  })
}

export function buildSimulation(nodes: SimNode[], links: SimLink[]): Simulation<SimNode, SimLink> {
  return forceSimulation(nodes)
    .force('charge', forceManyBody<SimNode>().strength(-45).distanceMax(400))
    .force(
      'link',
      forceLink<SimNode, SimLink>(links)
        .id(d => d.id)
        .distance(46)
        .strength(0.25)
    )
    .force('collide', forceCollide<SimNode>().radius(d => nodeRadius(d) + 4))
    .force('x', forceX(0).strength(0.045))
    .force('y', forceY(0).strength(0.045))
    .alpha(1)
    .alphaDecay(0.028)
}
