import { describe, it, expect } from 'vitest';
import { Model, ModelFactory } from '@core/index';
import {
  connectorEndsOf,
  bindingEquivalenceClasses,
  propagateValues,
  itemFlowsOf,
  isBindingEdge,
  isConnector,
} from '../../src/semantics/index';

/* ─────────────────────────── connector ends ──────────────────────────── */

describe('connectorEndsOf', () => {
  it('returns the source then target endpoints of a connector', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    const a = f.port('a', p.id, { direction: 'out' });
    const b = f.port('b', p.id, { direction: 'in' });
    const conn = f.connect(a.id, b.id, { name: 'link', ownerId: p.id });
    const ends = connectorEndsOf(m, conn.id);
    expect(ends).toEqual([a.id, b.id]);
    expect(isConnector(m.get(conn.id)!)).toBe(true);
  });

  it('falls back to end sub-features that reference the connected feature', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    const a = f.port('a', p.id);
    const b = f.port('b', p.id);
    // A connector modelled with end sub-features carrying referencedFeature ids.
    const conn = m.create('ConnectionUsage', { ownerId: p.id });
    m.create('ReferenceUsage', { ownerId: conn.id, attrs: { referencedFeature: a.id } });
    m.create('ReferenceUsage', { ownerId: conn.id, attrs: { referencedFeature: b.id } });
    expect(connectorEndsOf(m, conn.id)).toEqual([a.id, b.id]);
  });

  it('returns an empty list for a missing connector', () => {
    const m = new Model();
    expect(connectorEndsOf(m, 'nope')).toEqual([]);
  });
});

/* ─────────────────────── binding equivalence classes ─────────────────── */

describe('bindingEquivalenceClasses', () => {
  it('groups a multi-hop binding network into one class', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    const a = f.attribute('a', p.id, { type: 'Real' });
    const b = f.attribute('b', p.id, { type: 'Real' });
    const c = f.attribute('c', p.id, { type: 'Real' });
    m.create('BindingConnectorAsUsage', { ownerId: p.id, source: [a.id], target: [b.id] });
    m.create('BindingConnectorAsUsage', { ownerId: p.id, source: [b.id], target: [c.id] });
    const classes = bindingEquivalenceClasses(m);
    expect(classes.length).toBe(1);
    expect(new Set(classes[0])).toEqual(new Set([a.id, b.id, c.id]));
  });

  it('keeps disjoint binding networks in separate classes', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    const a = f.attribute('a', p.id, { type: 'Real' });
    const b = f.attribute('b', p.id, { type: 'Real' });
    const x = f.attribute('x', p.id, { type: 'Real' });
    const y = f.attribute('y', p.id, { type: 'Real' });
    m.create('BindingConnectorAsUsage', { ownerId: p.id, source: [a.id], target: [b.id] });
    m.create('BindingConnectorAsUsage', { ownerId: p.id, source: [x.id], target: [y.id] });
    const classes = bindingEquivalenceClasses(m);
    expect(classes.length).toBe(2);
  });

  it('recognises a kind:"bind" connector as a binding edge', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    const a = f.attribute('a', p.id, { type: 'Real' });
    const b = f.attribute('b', p.id, { type: 'Real' });
    const edge = m.create('ConnectionUsage', {
      ownerId: p.id,
      source: [a.id],
      target: [b.id],
      attrs: { kind: 'bind' },
    });
    expect(isBindingEdge(m.get(edge.id)!)).toBe(true);
    expect(bindingEquivalenceClasses(m).length).toBe(1);
  });
});

/* ──────────────────────── full value propagation ─────────────────────── */

describe('propagateValues', () => {
  it('propagates a literal across a multi-hop binding network (a=b=c, c=7)', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    const a = f.attribute('a', p.id, { type: 'Real' });
    const b = f.attribute('b', p.id, { type: 'Real' });
    const c = f.attribute('c', p.id, { type: 'Real', value: 7 });
    m.create('BindingConnectorAsUsage', { ownerId: p.id, source: [a.id], target: [b.id] });
    m.create('BindingConnectorAsUsage', { ownerId: p.id, source: [b.id], target: [c.id] });
    const values = propagateValues(m);
    expect(values.get(a.id)).toBe(7);
    expect(values.get(b.id)).toBe(7);
    expect(values.get(c.id)).toBe(7);
  });

  it('carries a source value forward along an item flow', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    const out = f.attribute('src', p.id, { type: 'Real', value: 42 });
    const inp = f.attribute('dst', p.id, { type: 'Real' });
    m.create('FlowUsage', {
      ownerId: p.id,
      source: [out.id],
      target: [inp.id],
      attrs: { payload: 'Fuel' },
    });
    const values = propagateValues(m);
    expect(values.get(out.id)).toBe(42);
    expect(values.get(inp.id)).toBe(42);
  });

  it('propagates across a mixed binding + flow network to a fixpoint', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    const seed = f.attribute('seed', p.id, { type: 'Real', value: 5 });
    const mid = f.attribute('mid', p.id, { type: 'Real' });
    const bound = f.attribute('bound', p.id, { type: 'Real' });
    // seed --flow--> mid ; mid == bound (binding)
    m.create('FlowUsage', { ownerId: p.id, source: [seed.id], target: [mid.id] });
    m.create('BindingConnectorAsUsage', { ownerId: p.id, source: [mid.id], target: [bound.id] });
    const values = propagateValues(m);
    expect(values.get(mid.id)).toBe(5);
    expect(values.get(bound.id)).toBe(5);
  });

  it('leaves an undetermined binding component out of the map', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    const a = f.attribute('a', p.id, { type: 'Real' });
    const b = f.attribute('b', p.id, { type: 'Real' });
    m.create('BindingConnectorAsUsage', { ownerId: p.id, source: [a.id], target: [b.id] });
    const values = propagateValues(m);
    expect(values.has(a.id)).toBe(false);
    expect(values.has(b.id)).toBe(false);
  });
});

/* ─────────────────────────────── item flows ──────────────────────────── */

describe('itemFlowsOf', () => {
  it('reports payload and source/target features for each flow', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    const a = f.port('a', p.id, { direction: 'out' });
    const b = f.port('b', p.id, { direction: 'in' });
    const flow = m.create('FlowUsage', {
      declaredName: 'fuelLine',
      ownerId: p.id,
      source: [a.id],
      target: [b.id],
      attrs: { payload: 'Fuel' },
    });
    const flows = itemFlowsOf(m);
    expect(flows.length).toBe(1);
    expect(flows[0].id).toBe(flow.id);
    expect(flows[0].payload).toBe('Fuel');
    expect(flows[0].source).toBe(a.id);
    expect(flows[0].target).toBe(b.id);
    expect(flows[0].name).toBe('fuelLine');
  });

  it('treats a Succession carrying a payload as a flow', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const act = f.actionDef('A');
    const s1 = f.action('s1', act.id);
    const s2 = f.action('s2', act.id);
    m.create('Succession', {
      ownerId: act.id,
      source: [s1.id],
      target: [s2.id],
      attrs: { payload: 'Token' },
    });
    const flows = itemFlowsOf(m);
    expect(flows.length).toBe(1);
    expect(flows[0].payload).toBe('Token');
  });

  it('returns an empty list when there are no flows', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    f.partDef('P');
    expect(itemFlowsOf(m)).toEqual([]);
  });
});
