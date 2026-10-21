/**
 * Unit tests for the *tuned* elkjs layout policy (task M5):
 *  - elkPortSide maps in→WEST / out→EAST (and the boundary sides).
 *  - layoutOptionsFor uses the layered algorithm, orthogonal edge routing,
 *    compound (INCLUDE_CHILDREN) layout only for pieces with nested boxes, and
 *    left-to-right flow in every view.
 *  - layoutDiagram still positions & sizes every node and nests children.
 */

import { describe, expect, it } from 'vitest';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ELK as ElkInstance, ElkNode } from 'elkjs/lib/elk-api';
import { buildSampleModel } from '@core/index';
import { buildDiagram } from '@diagram/build';
import {
  layoutDiagram,
  elkPortSide,
  layoutOptionsFor,
  layoutDirectionFor,
  PORT_CONSTRAINTS,
  setElkFactory,
} from '@diagram/layout';
import type { DiagramGraph, DiagramNode } from '@diagram/types';

describe('elkPortSide — in→WEST / out→EAST port-side policy', () => {
  it('maps feature directions and boundary sides to ELK sides', () => {
    expect(elkPortSide('in')).toBe('WEST');
    expect(elkPortSide('out')).toBe('EAST');
    expect(elkPortSide('left')).toBe('WEST');
    expect(elkPortSide('right')).toBe('EAST');
    expect(elkPortSide('top')).toBe('NORTH');
    expect(elkPortSide('bottom')).toBe('SOUTH');
  });

  it('fixes ports to a side via FIXED_SIDE', () => {
    expect(PORT_CONSTRAINTS).toBe('FIXED_SIDE');
  });
});

describe('layoutOptionsFor — layered + orthogonal + per-view direction', () => {
  it('always uses the layered algorithm with orthogonal routing', () => {
    for (const vk of ['general', 'interconnection', 'tree', 'state'] as const) {
      const o = layoutOptionsFor(vk);
      expect(o['elk.algorithm']).toBe('layered');
      expect(o['elk.edgeRouting']).toBe('ORTHOGONAL');
      expect(Number(o['elk.spacing.nodeNode'])).toBeGreaterThan(0);
    }
  });

  it('switches on compound layout only for pieces with nested boxes', () => {
    // ELK's compound mode does not pack disconnected pieces, so a flat view that
    // used it came out as one strip hundreds of screens long.
    expect(layoutOptionsFor('general')['elk.hierarchyHandling']).toBe('SEPARATE_CHILDREN');
    expect(layoutOptionsFor('interconnection', true)['elk.hierarchyHandling']).toBe('INCLUDE_CHILDREN');
  });

  it('hands ELK the compound option through layoutDiagram: INCLUDE_CHILDREN for a piece that nests, SEPARATE_CHILDREN for a flat one', async () => {
    // Measured at aac38fd (docs/UI-ROADMAP.md P1): SEPARATE_CHILDREN for a nested piece is 30-70x faster on the entry's 330 boxes but
    // leaves every edge that crosses a parent's border unrouted, so a nested piece keeps INCLUDE_CHILDREN.
    const box = (id: string, parentId?: string): DiagramNode => ({
      id, elementId: id, kind: 'PartUsage', label: id, data: {}, ...(parentId ? { parentId } : {}),
    });
    const graph = (nodes: DiagramNode[], viewKind: DiagramGraph['viewKind']): DiagramGraph => ({
      nodes, viewKind, edges: [{ id: 'e', source: nodes[nodes.length - 2]!.id, target: nodes[nodes.length - 1]!.id, kind: 'connection' }],
    });
    const seen: (string | undefined)[] = [];
    const real = new ELK();
    setElkFactory(() => ({
      layout: (g: ElkNode) => {
        seen.push(g.layoutOptions?.['elk.hierarchyHandling']);
        return real.layout(g);
      },
    }) as unknown as ElkInstance);
    try {
      await layoutDiagram(graph([box('a'), box('b')], 'interconnection'));
      await layoutDiagram(graph([box('p'), box('c1', 'p'), box('c2', 'p')], 'interconnection'));
    } finally {
      setElkFactory(null);
    }
    expect(seen).toEqual(['SEPARATE_CHILDREN', 'INCLUDE_CHILDREN']);
  });

  it('flows every view left to right', () => {
    for (const vk of ['tree', 'requirement', 'state', 'action', 'case', 'general', 'interconnection', 'parametric'] as const) {
      expect(layoutDirectionFor(vk)).toBe('RIGHT');
      expect(layoutOptionsFor(vk)['elk.direction']).toBe('RIGHT');
    }
  });
});

describe('layoutDiagram — positions every node under the tuned policy', () => {
  it('assigns finite positions and positive sizes for the tree view', async () => {
    const m = buildSampleModel();
    const g = await layoutDiagram(buildDiagram(m, 'tree'));
    expect(g.nodes.length).toBeGreaterThan(0);
    for (const n of g.nodes) {
      expect(Number.isFinite(n.position!.x)).toBe(true);
      expect(Number.isFinite(n.position!.y)).toBe(true);
      expect(n.size!.w).toBeGreaterThan(0);
      expect(n.size!.h).toBeGreaterThan(0);
    }
  });

  it('keeps ported children within their parent frame (interconnection)', async () => {
    const m = buildSampleModel();
    const vehicle = m.all().find((e) => e.declaredName === 'vehicle')!;
    const g = await layoutDiagram(buildDiagram(m, 'interconnection', vehicle.id));
    const frame = g.nodes.find((n) => n.elementId === vehicle.id)!;
    const child = g.nodes.find((n) => n.parentId === vehicle.id)!;
    expect(child.position!.x).toBeGreaterThanOrEqual(0);
    expect(child.position!.y).toBeGreaterThanOrEqual(0);
    expect(child.position!.x + child.size!.w).toBeLessThanOrEqual(frame.size!.w + 1);
    expect(child.position!.y + child.size!.h).toBeLessThanOrEqual(frame.size!.h + 1);
  });
});
