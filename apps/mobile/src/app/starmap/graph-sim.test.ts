import { describe, expect, it } from 'vitest'

import type { StarmapGraph, StarmapNode } from '@/types/hermes'

import { categoryColor, filterGraph, filterNodes, hash, nodeRadius } from './graph-sim'

const node = (over: Partial<StarmapNode>): StarmapNode => ({
  id: 'n',
  label: 'N',
  kind: 'skill',
  category: 'general',
  useCount: 0,
  state: 'idle',
  createdBy: null,
  pinned: false,
  ...over
})

describe('starmap graph helpers', () => {
  it('hashes deterministically', () => {
    expect(hash('memory')).toBe(hash('memory'))
    expect(hash('a')).not.toBe(hash('b'))
  })

  it('maps a category to a stable hue', () => {
    expect(categoryColor('coding')).toBe(categoryColor('coding'))
    expect(categoryColor('coding')).toMatch(/^hsl\(\d+, 55%, 62%\)$/)
  })

  it('grows the radius with use and bumps pinned nodes', () => {
    expect(nodeRadius(node({ useCount: 100 }))).toBeGreaterThan(nodeRadius(node({ useCount: 0 })))
    expect(nodeRadius(node({ pinned: true, useCount: 0 }))).toBeGreaterThan(nodeRadius(node({ pinned: false, useCount: 0 })))
  })

  it('filters by used / learned', () => {
    const nodes = [
      node({ id: 'a', useCount: 5 }),
      node({ id: 'b', useCount: 0 }),
      node({ id: 'c', kind: 'memory' }),
      node({ id: 'd', createdBy: 'agent' })
    ]
    expect(filterNodes(nodes, 'all').map(n => n.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(filterNodes(nodes, 'used').map(n => n.id)).toEqual(['a'])
    expect(filterNodes(nodes, 'learned').map(n => n.id)).toEqual(['c', 'd'])
  })

  it('drops edges whose endpoints are filtered out', () => {
    const graph: StarmapGraph = {
      nodes: [node({ id: 'a', useCount: 5 }), node({ id: 'b', useCount: 0 })],
      edges: [{ source: 'a', target: 'b' }],
      clusters: [],
      memory: [],
      stats: {}
    }
    // 'b' is filtered out under 'used', so the a→b edge goes too.
    expect(filterGraph(graph, 'used').edges).toEqual([])
    expect(filterGraph(graph, 'all').edges).toHaveLength(1)
  })
})
