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

  /**
   * A drag in the app lists the mover's model as its copies are rebuilt
   * (`Model.adoptSerialOrder`). The peer takes the move in as a reparent and
   * lists its model the same way, so the two decide alike: of two transitions
   * out of `start`, the one dragged out and back in is the second on both
   * (review 2026-10-14 D-1, the S2 review).
   */
  it("a peer's drag: the other peer holds and lists the moved element where the mover put it", () => {
    const { m1, m2 } = setup();
    // One at a time: a batch reaches the peer in another order (TODO.md, a room's child order).
    m1.create('StateDefinition', { id: 'M', declaredName: 'M' });
    m1.create('InitialNode', { id: 'start', declaredName: 'start', ownerId: 'M' });
    m1.create('StateUsage', { id: 'A', declaredName: 'A', ownerId: 'M' });
    m1.create('StateUsage', { id: 'B', declaredName: 'B', ownerId: 'M' });
    m1.create('TransitionUsage', { id: 'toA', ownerId: 'M', source: ['start'], target: ['A'] });
    m1.create('TransitionUsage', { id: 'toB', ownerId: 'M', source: ['start'], target: ['B'] });
    expect(m2.childIds('M')).toEqual(m1.childIds('M'));
    // What the store's drag does: out and back in, then the model listed as its copies are.
    m1.reparent('toA', null);
    m1.reparent('toA', 'M');
    m1.adoptSerialOrder();
    expect(m2.childIds('M')).toEqual(m1.childIds('M'));
    const outOfStart = (m: Model) => m.edgesFrom('start').map((e) => e.id);
    expect(outOfStart(m1)).toEqual(['toB', 'toA']);
    expect(outOfStart(m2)).toEqual(['toB', 'toA']);
    const listed = m2.inSerialOrder();
    expect(m2.all().every((el, i) => el === listed[i])).toBe(true);
  });

  /**
   * An element added is listed where the text puts it, not after everything
   * else: the store does so after each edit, and the peer after taking in the
   * peer's edits (`Model.adoptSerialOrder`). So a machine made in a package
   * above another machine's is walked before it on both, as a terminal over the
   * saved text walks it (review 2026-10-14 D-1, its S2 review).
   */
  it("a peer adds an element: both peers list it where the text puts it", () => {
    const { m1, m2 } = setup();
    // One at a time: a batch reaches the peer in another order (TODO.md, a room's child order).
    m1.create('Package', { id: 'P', declaredName: 'P' });
    m1.create('Package', { id: 'Q1', declaredName: 'Q1', ownerId: 'P' });
    m1.create('StateDefinition', { id: 'M1', declaredName: 'M1', ownerId: 'Q1' });
    m1.create('Package', { id: 'Q2', declaredName: 'Q2', ownerId: 'P' });
    m1.create('StateDefinition', { id: 'M2', declaredName: 'M2', ownerId: 'Q2' });
    // A machine made in Q1 afterwards, and the model listed as the store lists it after an edit.
    m1.create('StateDefinition', { id: 'M0', declaredName: 'M0', ownerId: 'Q1' });
    m1.adoptSerialOrder();
    const machines = (m: Model) => m.all().filter((e) => e.eClass === 'StateDefinition').map((e) => e.id);
    expect(machines(m1)).toEqual(['M1', 'M0', 'M2']);
    expect(machines(m2)).toEqual(['M1', 'M0', 'M2']);
    const listed = m2.inSerialOrder();
    expect(m2.all().every((el, i) => el === listed[i])).toBe(true);
  });

  /**
   * A peer that joins loads the model from the room's document, which lists
   * the elements in the order they reached it; and a doc a peer adds to a typed
   * part goes before the part's typing among its children, where a terminal
   * over the saved text holds it, so the typing stays where it was listed among
   * the typings. Every peer lists the model as the mover does — the one that
   * joins too, before and after an edit of its own that adds nothing (the
   * review of collab-order S1).
   */
  it('a peer that joins after an edit, and a doc a peer adds to a typed part: every peer lists the model as the mover does', () => {
    const { m1, m2, d1 } = setup();
    m1.create('Package', { id: 'P', declaredName: 'P' });
    m1.create('Package', { id: 'Q1', declaredName: 'Q1', ownerId: 'P' });
    m1.create('StateDefinition', { id: 'M1', declaredName: 'M1', ownerId: 'Q1' });
    m1.create('Package', { id: 'Q2', declaredName: 'Q2', ownerId: 'P' });
    m1.create('StateDefinition', { id: 'M2', declaredName: 'M2', ownerId: 'Q2' });
    m1.create('PartDefinition', { id: 'D', declaredName: 'D', ownerId: 'P' });
    m1.create('PartUsage', { id: 'u1', declaredName: 'u1', ownerId: 'P' });
    m1.create('PartUsage', { id: 'u2', declaredName: 'u2', ownerId: 'P' });
    // As a load makes them, once every name is known.
    m1.create('FeatureTyping', { id: 't1', ownerId: 'u1', source: ['u1'], target: ['D'] });
    m1.create('FeatureTyping', { id: 't2', ownerId: 'u2', source: ['u2'], target: ['D'] });
    m1.adoptSerialOrder();
    // A machine made in Q1, and a doc on u2, each listed as the store lists the model after an edit.
    m1.create('StateDefinition', { id: 'M0', declaredName: 'M0', ownerId: 'Q1' });
    m1.adoptSerialOrder();
    m1.create('Documentation', { id: 'doc', ownerId: 'u2', attrs: { body: 'note' } });
    m1.adoptSerialOrder();

    // A peer joins now: a fresh doc that receives the room's state.
    const m3 = new Model();
    const d3 = new Y.Doc();
    Y.applyUpdate(d3, Y.encodeStateAsUpdate(d1), 'remote');
    bindModelToDoc(m3, d3);
    wire(d1, d3);
    const machines = (m: Model) => m.all().filter((e) => e.eClass === 'StateDefinition').map((e) => e.id);
    const typedByD = (m: Model) => m.edgesTo('D').map((e) => e.source?.[0]);
    const ids = (m: Model) => m.all().map((e) => e.id);
    for (const [peer, m] of [['the mover', m1], ['a peer present', m2], ['a peer that joined', m3]] as const) {
      expect(machines(m), peer).toEqual(['M1', 'M0', 'M2']);
      expect(typedByD(m), peer).toEqual(['u1', 'u2']);
      expect(m.childIds('u2'), peer).toEqual(['doc', 't2']);
      expect(ids(m), peer).toEqual(ids(m1));
    }
    // An edit on the joined peer that adds nothing keeps that order.
    m3.rename('M1', 'M1r');
    m3.adoptSerialOrder();
    expect(machines(m3)).toEqual(['M1', 'M0', 'M2']);
    expect(ids(m3)).toEqual(ids(m1));
    const listed = m3.inSerialOrder();
    expect(m3.all().every((el, i) => el === listed[i])).toBe(true);
  });
});
