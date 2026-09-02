/**
 * Unit tests for the Model <-> Y.Doc binding (src/collab/model-doc.ts).
 *
 * NO NETWORK: we simulate the transport by wiring two docs' `update` events
 * directly to each other via Y.applyUpdate(..., 'remote'). This exercises the
 * exact CRDT convergence path a real WebsocketProvider would drive, but purely
 * in-memory and deterministically.
 */

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { Model } from '@core/index';
import { bindModelToDoc, ORIGIN_LOCAL } from '../../src/collab/model-doc';

/** Canonical, order-independent snapshot of a model for equality assertions. */
function snapshot(model: Model) {
  return model
    .all()
    .map((e) => ({
      id: e.id,
      eClass: e.eClass,
      declaredName: e.declaredName ?? null,
      declaredShortName: e.declaredShortName ?? null,
      ownerId: e.ownerId,
      attrs: e.attrs ?? {},
      source: e.source ?? null,
      target: e.target ?? null,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function idSet(model: Model): Set<string> {
  return new Set(model.all().map((e) => e.id));
}

/** Wire two docs into a bidirectional "network" with an update counter. */
function wire(d1: Y.Doc, d2: Y.Doc) {
  const counter = { updates: 0 };
  d1.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin === 'remote') return; // don't relay what we just received
    counter.updates++;
    Y.applyUpdate(d2, u, 'remote');
  });
  d2.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin === 'remote') return;
    counter.updates++;
    Y.applyUpdate(d1, u, 'remote');
  });
  return counter;
}

function setup() {
  const m1 = new Model();
  const m2 = new Model();
  const d1 = new Y.Doc();
  const d2 = new Y.Doc();
  const b1 = bindModelToDoc(m1, d1);
  const b2 = bindModelToDoc(m2, d2);
  const counter = wire(d1, d2);
  return { m1, m2, d1, d2, b1, b2, counter };
}

describe('bindModelToDoc — CRDT convergence', () => {
  it('exports ORIGIN_LOCAL as a stable symbol', () => {
    expect(typeof ORIGIN_LOCAL).toBe('symbol');
  });

  it('propagates create (Package + PartUsage) from user1 to user2 with containment', () => {
    const { m1, m2 } = setup();

    const pkg = m1.create('Package', { id: 'pkg-1', declaredName: 'Sys' });
    const part = m1.create('PartUsage', { id: 'part-1', declaredName: 'engine', ownerId: pkg.id });

    // user2 converges to the same elements + containment.
    expect(m2.has('pkg-1')).toBe(true);
    expect(m2.has('part-1')).toBe(true);
    expect(m2.get('part-1')!.ownerId).toBe('pkg-1');
    expect(m2.get('pkg-1')!.declaredName).toBe('Sys');
    expect(m2.get('part-1')!.eClass).toBe('PartUsage');
    expect(m2.childIds('pkg-1')).toContain('part-1');
    expect(idSet(m1)).toEqual(idSet(m2));
    void part;
  });

  it('propagates an attribute set from user2 back to user1', () => {
    const { m1, m2 } = setup();
    m1.create('PartUsage', { id: 'p', declaredName: 'wheel' });

    m2.setAttrs('p', { multiplicity: '4', isAbstract: true });

    expect(m1.get('p')!.attrs.multiplicity).toBe('4');
    expect(m1.get('p')!.attrs.isAbstract).toBe(true);
    expect(idSet(m1)).toEqual(idSet(m2));
  });

  it('field-level merge: sequential edits to DIFFERENT attributes both survive', () => {
    const { m1, m2 } = setup();
    m1.create('PartUsage', { id: 'p', declaredName: 'wheel', attrs: { color: 'red' } });
    expect(m2.get('p')!.attrs.color).toBe('red');

    // Interleaved edits from both sides to different keys of the same element.
    m1.setAttrs('p', { width: 10 });
    m2.setAttrs('p', { height: 20 });

    // Both attributes must be present on both sides (no clobber of siblings).
    expect(m1.get('p')!.attrs.width).toBe(10);
    expect(m1.get('p')!.attrs.height).toBe(20);
    expect(m2.get('p')!.attrs.width).toBe(10);
    expect(m2.get('p')!.attrs.height).toBe(20);
    expect(m1.get('p')!.attrs.color).toBe('red');
  });

  it('field-level merge under TRUE concurrency (buffered updates, different attrs)', () => {
    // Build an isolated pair we control the transport for.
    const m1 = new Model();
    const m2 = new Model();
    const d1 = new Y.Doc();
    const d2 = new Y.Doc();
    bindModelToDoc(m1, d1);
    bindModelToDoc(m2, d2);

    const a2b: Uint8Array[] = [];
    const b2a: Uint8Array[] = [];
    d1.on('update', (u: Uint8Array, origin: unknown) => {
      if (origin !== 'remote') a2b.push(u);
    });
    d2.on('update', (u: Uint8Array, origin: unknown) => {
      if (origin !== 'remote') b2a.push(u);
    });

    // Seed a shared element and flush both ways.
    m1.create('PartUsage', { id: 'p', declaredName: 'w' });
    a2b.splice(0).forEach((u) => Y.applyUpdate(d2, u, 'remote'));
    b2a.splice(0); // ignore any echo
    expect(m2.has('p')).toBe(true);

    // CONCURRENT: both edit different attrs BEFORE exchanging updates.
    m1.setAttrs('p', { alpha: 1 });
    m2.setAttrs('p', { beta: 2 });
    const fromA = a2b.splice(0);
    const fromB = b2a.splice(0);
    // Exchange the concurrent updates.
    fromA.forEach((u) => Y.applyUpdate(d2, u, 'remote'));
    fromB.forEach((u) => Y.applyUpdate(d1, u, 'remote'));
    // Settle any resulting echoes.
    a2b.splice(0).forEach((u) => Y.applyUpdate(d2, u, 'remote'));
    b2a.splice(0).forEach((u) => Y.applyUpdate(d1, u, 'remote'));

    expect(m1.get('p')!.attrs.alpha).toBe(1);
    expect(m1.get('p')!.attrs.beta).toBe(2);
    expect(m2.get('p')!.attrs.alpha).toBe(1);
    expect(m2.get('p')!.attrs.beta).toBe(2);
    expect(snapshot(m1)).toEqual(snapshot(m2));
  });

  it('concurrent edits to the SAME attribute converge deterministically', () => {
    const m1 = new Model();
    const m2 = new Model();
    const d1 = new Y.Doc();
    const d2 = new Y.Doc();
    bindModelToDoc(m1, d1);
    bindModelToDoc(m2, d2);

    const a2b: Uint8Array[] = [];
    const b2a: Uint8Array[] = [];
    d1.on('update', (u: Uint8Array, o: unknown) => o !== 'remote' && a2b.push(u));
    d2.on('update', (u: Uint8Array, o: unknown) => o !== 'remote' && b2a.push(u));

    m1.create('AttributeUsage', { id: 'a', declaredName: 'x' });
    a2b.splice(0).forEach((u) => Y.applyUpdate(d2, u, 'remote'));
    b2a.splice(0);

    // Concurrent write to the SAME key with different values.
    m1.setAttrs('a', { value: 'from-1' });
    m2.setAttrs('a', { value: 'from-2' });
    const fromA = a2b.splice(0);
    const fromB = b2a.splice(0);
    fromA.forEach((u) => Y.applyUpdate(d2, u, 'remote'));
    fromB.forEach((u) => Y.applyUpdate(d1, u, 'remote'));
    a2b.splice(0).forEach((u) => Y.applyUpdate(d2, u, 'remote'));
    b2a.splice(0).forEach((u) => Y.applyUpdate(d1, u, 'remote'));

    // Deterministic: both sides equal, and value is one of the two writes.
    expect(m1.get('a')!.attrs.value).toBe(m2.get('a')!.attrs.value);
    expect(['from-1', 'from-2']).toContain(m1.get('a')!.attrs.value as string);
    expect(snapshot(m1)).toEqual(snapshot(m2));
  });

  it('reparent converges', () => {
    const { m1, m2 } = setup();
    m1.create('Package', { id: 'A', declaredName: 'A' });
    m1.create('Package', { id: 'B', declaredName: 'B' });
    m1.create('PartUsage', { id: 'c', declaredName: 'c', ownerId: 'A' });
    expect(m2.get('c')!.ownerId).toBe('A');

    m1.reparent('c', 'B');
    expect(m2.get('c')!.ownerId).toBe('B');
    expect(m2.childIds('B')).toContain('c');
    expect(m2.childIds('A')).not.toContain('c');
    expect(snapshot(m1)).toEqual(snapshot(m2));
  });

  it('delete converges', () => {
    const { m1, m2 } = setup();
    m1.create('Package', { id: 'root', declaredName: 'R' });
    m1.create('PartUsage', { id: 'child', declaredName: 'ch', ownerId: 'root' });
    expect(m2.has('child')).toBe(true);

    m1.remove('child');
    expect(m2.has('child')).toBe(false);
    expect(m1.has('child')).toBe(false);
    expect(idSet(m1)).toEqual(idSet(m2));
  });

  it('cascade delete of a subtree converges', () => {
    const { m1, m2 } = setup();
    m1.create('Package', { id: 'r', declaredName: 'R' });
    m1.create('PartUsage', { id: 'a', ownerId: 'r' });
    m1.create('PartUsage', { id: 'b', ownerId: 'a' });
    expect(m2.has('b')).toBe(true);

    m1.remove('r'); // cascades r, a, b
    expect(m2.size).toBe(0);
    expect(m1.size).toBe(0);
    expect(idSet(m1)).toEqual(idSet(m2));
  });

  it('no echo loop: a single local edit produces a bounded number of updates', () => {
    const { m1, counter } = setup();
    const before = counter.updates;
    m1.create('Package', { id: 'solo', declaredName: 'S' });
    const delta = counter.updates - before;
    // One logical change should NOT cause an unbounded relay storm.
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThanOrEqual(4);
  });

  it('full element-set + snapshot equality after a mixed sequence', () => {
    const { m1, m2 } = setup();
    m1.create('Package', { id: 'P', declaredName: 'Proj' });
    m1.create('PartDefinition', { id: 'D', declaredName: 'Def', ownerId: 'P' });
    m2.create('PartUsage', { id: 'U', declaredName: 'use', ownerId: 'P' });
    m2.setAttrs('U', { multiplicity: '1..*' });
    m1.rename('D', 'Definition');
    m1.reparent('U', 'D');
    m2.setAttrs('P', { visibility: 'public' });

    expect(idSet(m1)).toEqual(idSet(m2));
    expect(snapshot(m1)).toEqual(snapshot(m2));
    expect(m1.get('D')!.declaredName).toBe('Definition');
    expect(m2.get('U')!.ownerId).toBe('D');
    expect(m2.get('U')!.attrs.multiplicity).toBe('1..*');
    expect(m1.get('P')!.attrs.visibility).toBe('public');
  });

  it('initial sync: binding a NON-empty doc loads the model from the doc', () => {
    // Prepare a populated doc via one bound model.
    const src = new Model();
    const dsrc = new Y.Doc();
    bindModelToDoc(src, dsrc);
    src.create('Package', { id: 'seed', declaredName: 'Seed' });
    src.create('PartUsage', { id: 'sp', declaredName: 'sp', ownerId: 'seed' });

    // Copy the doc state into a fresh doc, then bind an EMPTY model to it.
    const dst = new Y.Doc();
    Y.applyUpdate(dst, Y.encodeStateAsUpdate(dsrc));
    const loaded = new Model();
    expect(loaded.size).toBe(0);
    bindModelToDoc(loaded, dst);

    expect(loaded.has('seed')).toBe(true);
    expect(loaded.has('sp')).toBe(true);
    expect(loaded.get('sp')!.ownerId).toBe('seed');
  });

  it('initial sync: binding an EMPTY doc seeds it from a non-empty model', () => {
    const m = new Model();
    m.create('Package', { id: 'x', declaredName: 'X' });
    const d = new Y.Doc();
    bindModelToDoc(m, d);
    const elements = d.getMap('elements') as Y.Map<Y.Map<unknown>>;
    expect(elements.has('x')).toBe(true);
    expect(elements.get('x')!.get('declaredName')).toBe('X');
  });

  it('unbind stops propagation', () => {
    const { m1, m2, b1 } = setup();
    m1.create('Package', { id: 'before', declaredName: 'B' });
    expect(m2.has('before')).toBe(true);

    b1.unbind();
    m1.create('Package', { id: 'after', declaredName: 'A' });
    expect(m2.has('after')).toBe(false);
  });
});
