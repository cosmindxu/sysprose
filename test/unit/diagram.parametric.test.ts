/**
 * Unit tests for the parametric + geometry graph views, and for the
 * non-graph (sequence/allocation) view kinds that return an empty,
 * non-throwing projection pending their dedicated builders.
 */

import { describe, expect, it } from 'vitest';
import { Model, ModelFactory } from '@core/index';
import { buildDiagram } from '@diagram/build';
import type { DiagramGraph, DiagramNode } from '@diagram/types';

function nodeByLabel(g: DiagramGraph, label: string): DiagramNode | undefined {
  return g.nodes.find((n) => n.label === label);
}

describe('buildDiagram — parametric view (constraint bound to an attribute)', () => {
  const m = new Model();
  const f = new ModelFactory(m);
  const pkg = f.pkg('P');
  const rocket = f.partDef('Rocket', pkg.id);
  const mass = f.attribute('mass', rocket.id, { type: 'Real', value: 500 });
  const con = m.create('ConstraintUsage', { declaredName: 'massBudget', ownerId: rocket.id });
  // A parameter feature inside the constraint.
  const param = m.create('AttributeUsage', { declaredName: 'm', ownerId: con.id });
  // Binding connector: the constraint parameter is bound to the part's attribute.
  const bind = m.create('BindingConnectorAsUsage', {
    ownerId: rocket.id,
    source: [param.id],
    target: [mass.id],
  });

  const g = buildDiagram(m, 'parametric');

  it('projects constraint usages as distinct constraint nodes', () => {
    expect(g.viewKind).toBe('parametric');
    const c = nodeByLabel(g, 'massBudget');
    expect(c).toBeDefined();
    expect(c!.kind).toBe('ConstraintUsage');
    expect(c!.data.isConstraint).toBe(true);
  });

  it('includes constraint parameter features and bound attributes as nodes', () => {
    const p = nodeByLabel(g, 'm');
    expect(p).toBeDefined();
    expect(p!.data.isParameter).toBe(true);
    // The bound AttributeUsage is pulled in via the binding connector.
    const boundAttr = g.nodes.find((n) => n.elementId === mass.id);
    expect(boundAttr).toBeDefined();
  });

  it('wires the binding connector as a bind edge', () => {
    const bindEdges = g.edges.filter((e) => e.kind === 'bind');
    expect(bindEdges).toHaveLength(1);
    expect(bindEdges[0].elementId).toBe(bind.id);
    expect(bindEdges[0].source).toBe(param.id);
    expect(bindEdges[0].target).toBe(mass.id);
  });

  it('surfaces analysis Satisfy links that touch a constraint', () => {
    const m2 = new Model();
    const f2 = new ModelFactory(m2);
    const pkg2 = f2.pkg('Q');
    const con2 = m2.create('ConstraintUsage', { declaredName: 'c', ownerId: pkg2.id });
    const req2 = f2.requirement('R', pkg2.id);
    f2.satisfy(req2.id, con2.id, pkg2.id);
    const g2 = buildDiagram(m2, 'parametric');
    const sat = g2.edges.filter((e) => e.kind === 'satisfy');
    expect(sat).toHaveLength(1);
    expect(g2.nodes.find((n) => n.elementId === con2.id)).toBeDefined();
  });
});

describe('buildDiagram — geometry view', () => {
  const m = new Model();
  const f = new ModelFactory(m);
  const pkg = f.pkg('P');
  const sys = f.part('system', pkg.id);
  // A part with an explicit spatial position + size.
  const placed = m.create('PartUsage', {
    declaredName: 'placed',
    ownerId: sys.id,
    attrs: { position: { x: 120, y: 80 }, size: { w: 60, h: 40 } },
  });
  // Two parts without positions → grid-placed.
  const a = f.part('a', sys.id);
  const b = f.part('b', sys.id);

  const g = buildDiagram(m, 'geometry');

  it('positions every part node (explicit attrs.position or grid fallback)', () => {
    expect(g.viewKind).toBe('geometry');
    expect(g.nodes.length).toBeGreaterThanOrEqual(4);
    for (const n of g.nodes) {
      expect(typeof n.position?.x).toBe('number');
      expect(typeof n.position?.y).toBe('number');
      expect(Number.isFinite(n.position!.x)).toBe(true);
      expect(Number.isFinite(n.position!.y)).toBe(true);
    }
  });

  it('honours explicit position and size from attrs', () => {
    const p = g.nodes.find((n) => n.elementId === placed.id)!;
    expect(p.position).toEqual({ x: 120, y: 80 });
    expect(p.size).toEqual({ w: 60, h: 40 });
  });

  it('grid-places parts without an explicit position (distinct coordinates)', () => {
    const na = g.nodes.find((n) => n.elementId === a.id)!;
    const nb = g.nodes.find((n) => n.elementId === b.id)!;
    expect(na.position).not.toEqual(nb.position);
  });

  it('emits containment edges between nested parts', () => {
    expect(g.edges.length).toBeGreaterThan(0);
    expect(g.edges.every((e) => e.kind === 'containment')).toBe(true);
    const engineEdge = g.edges.find((e) => e.target === placed.id);
    expect(engineEdge?.source).toBe(sys.id);
  });
});

describe('buildDiagram — sequence & allocation (deferred to dedicated builders)', () => {
  const m = new Model();
  const f = new ModelFactory(m);
  f.pkg('P');

  it('returns an empty, non-throwing graph for the sequence view', () => {
    const g = buildDiagram(m, 'sequence');
    expect(g).toEqual({ nodes: [], edges: [], viewKind: 'sequence' });
  });

  it('returns an empty, non-throwing graph for the allocation view', () => {
    const g = buildDiagram(m, 'allocation');
    expect(g).toEqual({ nodes: [], edges: [], viewKind: 'allocation' });
  });
});
