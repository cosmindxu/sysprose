/**
 * Unit tests for the pure edge-routing geometry ({@link getNodeIntersection},
 * {@link getEdgeEndpoints}, {@link shapeForKind}). These verify the per-shape
 * ray–boundary intersections that drive the shape-aware floating edges, so the
 * math is checked without a React Flow render context.
 */

import { describe, expect, it } from 'vitest';
import { Position } from '@xyflow/react';
import {
  getEdgeEndpoints,
  getNodeIntersection,
  shapeForKind,
  type ShapedNode,
} from '@diagram/geometry';

/** A point lies on the axis-aligned ellipse `(x/rx)² + (y/ry)² = 1`. */
function onEllipse(x: number, y: number, rx: number, ry: number): number {
  return (x / rx) ** 2 + (y / ry) ** 2;
}
/** A point lies on the rhombus `|x|/rx + |y|/ry = 1`. */
function onDiamond(x: number, y: number, rx: number, ry: number): number {
  return Math.abs(x) / rx + Math.abs(y) / ry;
}

describe('shapeForKind — mapping matches nodes.tsx', () => {
  it('maps use-case / case boxes to an ellipse', () => {
    expect(shapeForKind('UseCaseUsage')).toBe('ellipse');
    expect(shapeForKind('UseCaseDefinition')).toBe('ellipse');
    expect(shapeForKind('CaseUsage')).toBe('ellipse');
    expect(shapeForKind('CaseDefinition')).toBe('ellipse');
  });
  it('maps control nodes to their flow symbols', () => {
    expect(shapeForKind('DecisionNode')).toBe('diamond');
    expect(shapeForKind('MergeNode')).toBe('diamond');
    expect(shapeForKind('ForkNode')).toBe('bar');
    expect(shapeForKind('JoinNode')).toBe('bar');
    expect(shapeForKind('InitialNode')).toBe('ellipse');
    expect(shapeForKind('DoneNode')).toBe('ellipse');
  });
  it('maps states to a stadium and everything else to a rounded rectangle', () => {
    expect(shapeForKind('StateUsage')).toBe('stadium');
    expect(shapeForKind('StateDefinition')).toBe('stadium');
    expect(shapeForKind('PartUsage')).toBe('roundrect');
    expect(shapeForKind('RequirementUsage')).toBe('roundrect');
  });
});

describe('getNodeIntersection — rectangle clip', () => {
  const rect: ShapedNode = { x: 0, y: 0, w: 100, h: 60, shape: 'rect' };

  it('straight below → bottom-centre', () => {
    const p = getNodeIntersection(rect, { x: 0, y: 100 });
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(30);
  });
  it('straight right → right-edge midpoint', () => {
    const p = getNodeIntersection(rect, { x: 100, y: 0 });
    expect(p.x).toBeCloseTo(50);
    expect(p.y).toBeCloseTo(0);
  });
  it('45° diagonal on a square → the exact corner', () => {
    const sq: ShapedNode = { x: 0, y: 0, w: 100, h: 100, shape: 'rect' };
    const p = getNodeIntersection(sq, { x: 1000, y: 1000 });
    expect(p.x).toBeCloseTo(50);
    expect(p.y).toBeCloseTo(50);
  });
  it('diagonal on a wide box exits the longer (bottom) edge', () => {
    const p = getNodeIntersection(rect, { x: 1000, y: 1000 });
    expect(p.y).toBeCloseTo(30); // bottom edge (ry)
    expect(p.x).toBeGreaterThan(0);
    expect(p.x).toBeLessThan(50); // still within the flat span
  });
  it('roundrect and bar clip identically to rect', () => {
    const rr: ShapedNode = { ...rect, shape: 'roundrect' };
    const bar: ShapedNode = { ...rect, shape: 'bar' };
    expect(getNodeIntersection(rr, { x: 100, y: 0 }).x).toBeCloseTo(50);
    expect(getNodeIntersection(bar, { x: 0, y: 100 }).y).toBeCloseTo(30);
  });
});

describe('getNodeIntersection — ellipse', () => {
  const ell: ShapedNode = { x: 0, y: 0, w: 100, h: 60, shape: 'ellipse' };

  it('lands on the ellipse boundary for an arbitrary ray', () => {
    const p = getNodeIntersection(ell, { x: 37, y: -21 });
    expect(onEllipse(p.x, p.y, 50, 30)).toBeCloseTo(1, 5);
  });
  it('straight right → the rightmost point (rx, 0)', () => {
    const p = getNodeIntersection(ell, { x: 10, y: 0 });
    expect(p.x).toBeCloseTo(50);
    expect(p.y).toBeCloseTo(0);
  });
});

describe('getNodeIntersection — diamond', () => {
  const dia: ShapedNode = { x: 0, y: 0, w: 100, h: 60, shape: 'diamond' };

  it('lands on the rhombus boundary for an arbitrary ray', () => {
    const p = getNodeIntersection(dia, { x: 30, y: 40 });
    expect(onDiamond(p.x, p.y, 50, 30)).toBeCloseTo(1, 5);
  });
  it('straight up → the top vertex (0, -ry)', () => {
    const p = getNodeIntersection(dia, { x: 0, y: -5 });
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(-30);
  });
});

describe('getNodeIntersection — stadium (pill)', () => {
  // Horizontal pill: half-extents rx=60, ry=20 → cap radius 20, flat span ±40.
  const pill: ShapedNode = { x: 0, y: 0, w: 120, h: 40, shape: 'stadium' };

  it('a ray through the flat body exits the straight top edge', () => {
    const p = getNodeIntersection(pill, { x: 20, y: -100 });
    expect(p.y).toBeCloseTo(-20); // straight top edge (ry)
    expect(Math.abs(p.x)).toBeLessThanOrEqual(40); // within the flat span
  });
  it('a sideways ray exits on the semicircular end cap', () => {
    const p = getNodeIntersection(pill, { x: 100, y: 5 });
    // The end-cap circle is centred at (a, 0) = (40, 0) with radius r = 20.
    const d = Math.hypot(p.x - 40, p.y - 0);
    expect(d).toBeCloseTo(20, 4);
    expect(p.x).toBeGreaterThan(40); // beyond the flat span, in the cap
  });
});

describe('getNodeIntersection — defensive fallbacks', () => {
  it('unmeasured (zero-size) node → the node centre', () => {
    const p = getNodeIntersection({ x: 7, y: 9, w: 0, h: 0, shape: 'rect' }, { x: 100, y: 100 });
    expect(p).toEqual({ x: 7, y: 9 });
  });
  it('zero-length ray (coincident centres) → bottom-centre', () => {
    const p = getNodeIntersection({ x: 0, y: 0, w: 100, h: 60, shape: 'ellipse' }, { x: 0, y: 0 });
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(30);
  });
});

describe('getEdgeEndpoints — both borders + nearest sides', () => {
  it('two horizontally separated boxes meet at facing edge midpoints', () => {
    const source: ShapedNode = { x: 0, y: 0, w: 100, h: 60, shape: 'rect' };
    const target: ShapedNode = { x: 300, y: 0, w: 100, h: 60, shape: 'rect' };
    const e = getEdgeEndpoints(source, target);
    expect(e.sx).toBeCloseTo(50); // source right edge
    expect(e.sy).toBeCloseTo(0);
    expect(e.tx).toBeCloseTo(250); // target left edge
    expect(e.ty).toBeCloseTo(0);
    expect(e.sourcePos).toBe(Position.Right);
    expect(e.targetPos).toBe(Position.Left);
  });
  it('endpoints sit on each node boundary for a diagonal pair', () => {
    const source: ShapedNode = { x: 0, y: 0, w: 80, h: 80, shape: 'ellipse' };
    const target: ShapedNode = { x: 200, y: 150, w: 80, h: 80, shape: 'ellipse' };
    const e = getEdgeEndpoints(source, target);
    // Each endpoint is on its own circle (r = 40).
    expect(Math.hypot(e.sx - 0, e.sy - 0)).toBeCloseTo(40, 4);
    expect(Math.hypot(e.tx - 200, e.ty - 150)).toBeCloseTo(40, 4);
    // Target is down-right of source, so the source endpoint faces down/right.
    expect(e.sx).toBeGreaterThan(0);
    expect(e.sy).toBeGreaterThan(0);
  });
});
