/**
 * Unit tests for buildDiagram — model→graph projection for every ViewKind.
 * Exercises buildSampleModel plus purpose-built fixtures for the behavioural
 * views, asserting node/edge counts, kinds, parentId nesting, ports and edge
 * endpoints.
 */

import { describe, expect, it } from 'vitest';
import { Model, ModelFactory, buildSampleModel } from '@core/index';
import { buildDiagram } from '@diagram/build';
import type { DiagramGraph, DiagramNode } from '@diagram/types';

/** Find the single node whose label matches. */
function nodeByLabel(g: DiagramGraph, label: string): DiagramNode {
  const n = g.nodes.find((x) => x.label === label);
  if (!n) throw new Error(`no node labelled ${label}`);
  return n;
}

function ids(g: DiagramGraph, label: string): string {
  return nodeByLabel(g, label).elementId;
}

describe('buildDiagram — general view (sample)', () => {
  const m = buildSampleModel();
  const g = buildDiagram(m, 'general');

  it('projects definitions + structural usages as nodes (not compartments)', () => {
    expect(g.viewKind).toBe('general');
    expect(g.nodes).toHaveLength(5);
    const labels = g.nodes.map((n) => n.label).sort();
    expect(labels).toEqual(['Engine', 'Vehicle', 'engine', 'maxMass', 'vehicle']);
  });

  it('excludes packages, attributes, ports and connections from nodes', () => {
    expect(g.nodes.find((n) => n.kind === 'Package')).toBeUndefined();
    expect(g.nodes.find((n) => n.kind === 'AttributeUsage')).toBeUndefined();
    expect(g.nodes.find((n) => n.kind === 'PortUsage')).toBeUndefined();
    expect(g.nodes.find((n) => n.kind === 'ConnectionUsage')).toBeUndefined();
  });

  it('puts attributes and ports in owner compartments', () => {
    const vehicle = nodeByLabel(g, 'vehicle');
    expect((vehicle.data.attributes as unknown[]).length).toBe(1);
    expect((vehicle.data.ports as unknown[]).length).toBe(1);
    expect(vehicle.data.keyword).toBe('part');
    const engine = nodeByLabel(g, 'engine');
    expect((engine.data.ports as unknown[]).length).toBe(1);
  });

  it('emits composition, feature-typing and satisfy edges', () => {
    expect(g.edges).toHaveLength(4);
    const composite = g.edges.filter((e) => e.kind === 'composite');
    expect(composite).toHaveLength(1);
    expect(composite[0].source).toBe(ids(g, 'vehicle'));
    expect(composite[0].target).toBe(ids(g, 'engine'));

    const typed = g.edges.filter((e) => e.kind === 'typed-by');
    expect(typed).toHaveLength(2);

    const satisfy = g.edges.filter((e) => e.kind === 'satisfy');
    expect(satisfy).toHaveLength(1);
    expect(satisfy[0].source).toBe(ids(g, 'vehicle'));
    expect(satisfy[0].target).toBe(ids(g, 'maxMass'));
  });
});

describe('buildDiagram — tree view (sample)', () => {
  const m = buildSampleModel();
  const g = buildDiagram(m, 'tree');

  it('includes every non-relationship element as a node', () => {
    expect(g.viewKind).toBe('tree');
    expect(g.nodes).toHaveLength(10);
    expect(g.nodes.find((n) => n.kind === 'FeatureTyping')).toBeUndefined();
    expect(g.nodes.find((n) => n.kind === 'Satisfy')).toBeUndefined();
  });

  it('wires containment edges and parentId nesting', () => {
    expect(g.edges).toHaveLength(9);
    expect(g.edges.every((e) => e.kind === 'containment')).toBe(true);
    const engine = nodeByLabel(g, 'engine');
    const vehicle = nodeByLabel(g, 'vehicle');
    expect(engine.parentId).toBe(vehicle.elementId);
    const root = nodeByLabel(g, 'VehicleModel');
    expect(root.parentId).toBeUndefined();
  });
});

describe('buildDiagram — interconnection view (sample, scoped to vehicle)', () => {
  const m = buildSampleModel();
  const vehicle = m.all().find((e) => e.declaredName === 'vehicle')!;
  const g = buildDiagram(m, 'interconnection', vehicle.id);

  it('nests parts and exposes boundary ports', () => {
    expect(g.viewKind).toBe('interconnection');
    expect(g.nodes).toHaveLength(2);
    const engine = nodeByLabel(g, 'engine');
    expect(engine.parentId).toBe(vehicle.id);
    const frame = nodeByLabel(g, 'vehicle');
    expect(frame.parentId).toBeUndefined();
    expect(frame.ports?.[0].label).toBe('fuelIn');
    expect(frame.ports?.[0].side).toBe('left'); // direction 'in'
    expect(engine.ports?.[0].label).toBe('fuelOut');
    expect(engine.ports?.[0].side).toBe('right'); // direction 'out'
  });

  it('routes connections between port endpoints', () => {
    expect(g.edges).toHaveLength(1);
    const edge = g.edges[0];
    expect(edge.kind).toBe('connection');
    const fuelOut = m.all().find((e) => e.declaredName === 'fuelOut')!;
    const fuelIn = m.all().find((e) => e.declaredName === 'fuelIn')!;
    expect(edge.source).toBe(fuelOut.id);
    expect(edge.target).toBe(fuelIn.id);
  });
});

describe('buildDiagram — requirement view (sample)', () => {
  const m = buildSampleModel();
  const g = buildDiagram(m, 'requirement');

  it('shows requirement + satisfier with a satisfy edge', () => {
    expect(g.viewKind).toBe('requirement');
    expect(g.nodes).toHaveLength(2);
    expect(g.nodes.map((n) => n.label).sort()).toEqual(['maxMass', 'vehicle']);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].kind).toBe('satisfy');
    expect(g.edges[0].source).toBe(ids(g, 'vehicle'));
    expect(g.edges[0].target).toBe(ids(g, 'maxMass'));
  });
});

describe('buildDiagram — action view (fixture)', () => {
  const m = new Model();
  const f = new ModelFactory(m);
  const pkg = f.pkg('P');
  const actDef = f.actionDef('Process', pkg.id);
  const a1 = f.action('start', actDef.id);
  const a2 = f.action('compute', actDef.id);
  const fork = m.create('ForkNode', { declaredName: 'fork', ownerId: actDef.id });
  f.succession(a1.id, a2.id, actDef.id);
  f.succession(a2.id, fork.id, actDef.id);
  const g = buildDiagram(m, 'action');

  it('renders action usages + control nodes, successions as edges', () => {
    expect(g.viewKind).toBe('action');
    expect(g.nodes).toHaveLength(3);
    expect(g.nodes.find((n) => n.label === 'fork')!.kind).toBe('ForkNode');
    expect(g.nodes.find((n) => n.label === 'fork')!.data.isControl).toBe(true);
    expect(g.nodes.find((n) => n.kind === 'ActionDefinition')).toBeUndefined();
    expect(g.edges).toHaveLength(2);
    expect(g.edges.every((e) => e.kind === 'succession')).toBe(true);
    const first = g.edges.find((e) => e.source === a1.id)!;
    expect(first.target).toBe(a2.id);
  });
});

describe('buildDiagram — action view includes ActionUsage subtypes', () => {
  const m = new Model();
  const f = new ModelFactory(m);
  const pkg = f.pkg('P');
  const actDef = f.actionDef('Process', pkg.id);
  const plain = f.action('plain', actDef.id);
  const accept = m.create('AcceptActionUsage', { declaredName: 'accept', ownerId: actDef.id });
  const send = m.create('SendActionUsage', { declaredName: 'send', ownerId: actDef.id });
  const g = buildDiagram(m, 'action');

  it('renders Accept/Send action usages, not only the base ActionUsage', () => {
    // Previously buildAction matched only eClass === "ActionUsage", silently
    // dropping every action subtype (regression guard for review finding M12).
    const kinds = g.nodes.map((n) => n.kind);
    expect(kinds).toContain('ActionUsage');
    expect(kinds).toContain('AcceptActionUsage');
    expect(kinds).toContain('SendActionUsage');
    expect(g.nodes.map((n) => n.id).sort()).toEqual([accept.id, plain.id, send.id].sort());
  });
});

describe('buildDiagram — state view (fixture)', () => {
  const m = new Model();
  const f = new ModelFactory(m);
  const pkg = f.pkg('P');
  const stDef = f.stateDef('Machine', pkg.id);
  const off = f.state('off', stDef.id);
  const on = f.state('on', stDef.id);
  f.transition(off.id, on.id, { ownerId: stDef.id, trigger: 'powerOn', guard: 'ok', effect: 'ignite' });
  f.transition(on.id, off.id, { ownerId: stDef.id, trigger: 'powerOff' });
  const g = buildDiagram(m, 'state');

  it('renders states + labelled transitions', () => {
    expect(g.viewKind).toBe('state');
    expect(g.nodes).toHaveLength(2);
    expect(g.nodes.map((n) => n.label).sort()).toEqual(['off', 'on']);
    expect(g.edges).toHaveLength(2);
    const t1 = g.edges.find((e) => e.source === off.id)!;
    expect(t1.target).toBe(on.id);
    expect(t1.kind).toBe('transition');
    expect(t1.label).toBe('powerOn [ok] / ignite');
    const t2 = g.edges.find((e) => e.source === on.id)!;
    expect(t2.label).toBe('powerOff');
  });
});

describe('buildDiagram — specialization + reference edges (fixture)', () => {
  const m = new Model();
  const f = new ModelFactory(m);
  const pkg = f.pkg('P');
  const base = f.partDef('Base', pkg.id);
  const derived = f.partDef('Derived', pkg.id);
  f.subclassification(derived.id, base.id);
  const host = f.partDef('Host', pkg.id);
  const ref = m.create('ReferenceUsage', { declaredName: 'peer', ownerId: host.id });
  const g = buildDiagram(m, 'general');

  it('maps subclassification to specialize and reference usage to reference edge', () => {
    const spec = g.edges.filter((e) => e.kind === 'specialize');
    expect(spec).toHaveLength(1);
    expect(spec[0].source).toBe(derived.id);
    expect(spec[0].target).toBe(base.id);
    const reference = g.edges.filter((e) => e.kind === 'reference');
    expect(reference).toHaveLength(1);
    expect(reference[0].source).toBe(host.id);
    expect(reference[0].target).toBe(ref.id);
  });
});
