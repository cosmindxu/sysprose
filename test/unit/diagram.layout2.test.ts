/**
 * Unit tests for the *tuned* elkjs layout policy (task M5):
 *  - elkPortSide maps in→WEST / out→EAST (and the boundary sides).
 *  - layoutOptionsFor uses the layered algorithm, orthogonal edge routing,
 *    hierarchical nesting, and a per-view primary direction (top-down for the
 *    hierarchical/behavioural views, left-right otherwise).
 *  - layoutDiagram still positions & sizes every node and nests children.
 */

import { describe, expect, it } from 'vitest';
import { buildSampleModel } from '@core/index';
import { buildDiagram } from '@diagram/build';
import {
  layoutDiagram,
  elkPortSide,
  layoutOptionsFor,
  layoutDirectionFor,
  PORT_CONSTRAINTS,
} from '@diagram/layout';

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
  it('always uses the layered algorithm with orthogonal routing and nesting', () => {
    for (const vk of ['general', 'interconnection', 'tree', 'state'] as const) {
      const o = layoutOptionsFor(vk);
      expect(o['elk.algorithm']).toBe('layered');
      expect(o['elk.edgeRouting']).toBe('ORTHOGONAL');
      expect(o['elk.hierarchyHandling']).toBe('INCLUDE_CHILDREN');
      expect(Number(o['elk.spacing.nodeNode'])).toBeGreaterThan(0);
    }
  });

  it('flows hierarchical/behavioural views top-down, others left-right', () => {
    expect(layoutDirectionFor('tree')).toBe('DOWN');
    expect(layoutDirectionFor('requirement')).toBe('DOWN');
    expect(layoutDirectionFor('state')).toBe('DOWN');
    expect(layoutDirectionFor('action')).toBe('DOWN');
    expect(layoutDirectionFor('case')).toBe('DOWN');
    expect(layoutDirectionFor('general')).toBe('RIGHT');
    expect(layoutDirectionFor('interconnection')).toBe('RIGHT');
    // The direction option is surfaced in the root options bag.
    expect(layoutOptionsFor('tree')['elk.direction']).toBe('DOWN');
    expect(layoutOptionsFor('general')['elk.direction']).toBe('RIGHT');
  });
});

describe('layoutDiagram — positions every node under the tuned policy', () => {
  it('assigns finite positions and positive sizes for a top-down view', async () => {
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
