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
import type { CreateElementOptions } from '@core/index';
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

  it('a removal that keeps the owner\'s children puts them at the top level on every peer', () => {
    const { m1, m2, d1 } = setup();
    m1.create('Package', { id: 'F', declaredName: 'F' });
    m1.create('PartUsage', { id: 'E', declaredName: 'E', ownerId: 'F' });
    m1.remove('F', { cascade: false });
    // Not left under an owner nobody has: the peer that removed it reads E where the others do.
    expect(m1.get('E')!.ownerId).toBeNull();
    expect(m1.rootIds()).toEqual(['E']);
    expect(snapshot(m1)).toEqual(snapshot(m2));
    expect(m2.rootIds()).toEqual(['E']);
    const joined = new Model();
    const dj = new Y.Doc();
    Y.applyUpdate(dj, Y.encodeStateAsUpdate(d1), 'remote');
    bindModelToDoc(joined, dj);
    expect(snapshot(joined)).toEqual(snapshot(m1));
  });

  it('three peers that move and remove (with or without the children) at random points end alike', () => {
    // The sequences that ended in different trees before the removing peer moved the kept children up (172 of 2000).
    const rng = (seed: number) => {
      let x = seed >>> 0;
      return () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    };
    const ids = ['A', 'B', 'C', 'D', 'E', 'F'];
    const tree = (m: Model) => JSON.stringify([m.all().map((e) => [e.id, e.ownerId, m.childIds(e.id)]).sort(), m.rootIds()]);
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed * 7919);
      const models = [new Model(), new Model(), new Model()];
      const docs = models.map(() => new Y.Doc());
      models.forEach((m, i) => bindModelToDoc(m, docs[i]));
      const queues: Uint8Array[][][] = docs.map(() => docs.map(() => []));
      docs.forEach((d, i) =>
        d.on('update', (u: Uint8Array, o: unknown) => {
          if (o !== 'remote') docs.forEach((_, j) => j !== i && queues[i][j].push(u));
        }),
      );
      const hear = () => {
        for (let n = 0; n < 4; n++)
          docs.forEach((_, i) => docs.forEach((d, j) => i !== j && queues[i][j].splice(0).forEach((u) => Y.applyUpdate(d, u, 'remote'))));
      };
      models[0].transaction(() => ids.forEach((id) => models[0].create('Package', { id, declaredName: id })));
      hear();
      for (let round = 0; round < 12; round++) {
        for (const m of models) {
          if (r() >= 0.7) continue;
          const live = ids.filter((id) => m.has(id));
          if (live.length === 0) continue;
          const pick = () => live[Math.floor(r() * live.length)];
          try {
            if (r() < 0.78) m.reparent(pick(), r() < 0.15 ? null : pick());
            else m.remove(pick(), { cascade: r() < 0.5 });
          } catch {
            /* a move into itself or a descendant is refused */
          }
        }
        if (r() < 0.6) hear();
      }
      hear();
      hear();
      const want = tree(models[0]);
      models.forEach((m, i) => expect(tree(m), `seed ${seed}, peer ${i}`).toBe(want));
    }
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

  /**
   * A room keeps each owner's child order (review 2026-10-14 D-2, collab-order
   * S2). A peer used to create a batch of elements last to first, and a peer
   * that joined took each owner's children in the order the room's document
   * listed its keys — the order they first reached it, where a reset, a drag
   * back in and a later peer's edit leave a key — so a composite with no
   * `initial` could enter another state on each, and the Text view differed.
   */
  describe("each owner's children in the order the peer who made the edit holds them", () => {
    /** A peer that joins now: a fresh document that receives the room's state, then a model bound to it (the API's way). */
    function join(d: Y.Doc): Model {
      const m = new Model();
      const d3 = new Y.Doc();
      Y.applyUpdate(d3, Y.encodeStateAsUpdate(d), 'remote');
      bindModelToDoc(m, d3);
      return m;
    }
    /**
     * A page that joins now, as the app joins (`connectCollab`): its own model,
     * here a package `Mine`, bound to a new document, which then receives the
     * room's state — a reconcile, as a peer present takes an edit in.
     */
    function appJoin(d: Y.Doc, own = true): Model {
      const m = new Model();
      if (own) m.create('Package', { id: 'Mine', declaredName: 'Mine' });
      const d3 = new Y.Doc();
      bindModelToDoc(m, d3);
      Y.applyUpdate(d3, Y.encodeStateAsUpdate(d), 'remote');
      return m;
    }
    /** Every owner's children, the top level's under `''`. */
    const childOrder = (m: Model): Record<string, string[]> =>
      Object.fromEntries(['', ...m.all().map((e) => e.id)].map((o) => [o, m.childIds(o === '' ? null : o)]).filter(([, c]) => c.length > 0));

    it('after a batch, a reset and a drag followed by a join, every peer holds them as the mover does', () => {
      const { m1, m2, d1 } = setup();

      // A batch: three parts made in one transaction (one update), as a paste or a script's `commit` makes them.
      m1.create('Package', { id: 'P', declaredName: 'P' });
      m1.transaction(() => {
        for (const id of ['a', 'b', 'c']) m1.create('PartUsage', { id, declaredName: id, ownerId: 'P' });
      });
      m1.adoptSerialOrder();
      expect(m1.childIds('P')).toEqual(['a', 'b', 'c']);
      expect(m2.childIds('P'), 'a peer present').toEqual(['a', 'b', 'c']);
      expect(join(d1).childIds('P'), 'a peer that joins').toEqual(['a', 'b', 'c']);
      expect(appJoin(d1).childIds('P'), 'a page that joins').toEqual(['a', 'b', 'c']);

      // A reset — Apply, Import, Undo, Redo — to x, y, z; then one that only puts them in another order, as an Undo
      // of a drag does: no element changes owner, so only the order the room carries can say so.
      const snapshot = (ids: string[]) => {
        const s = new Model();
        s.create('Package', { id: 'P', declaredName: 'P' });
        for (const id of ids) s.create('PartUsage', { id, declaredName: id, ownerId: 'P' });
        return s.toJSON();
      };
      m1.reset(snapshot(['x', 'y', 'z']));
      expect(m2.childIds('P')).toEqual(['x', 'y', 'z']);
      expect(join(d1).childIds('P')).toEqual(['x', 'y', 'z']);
      let told = 0;
      m2.subscribe(() => told++);
      m1.reset(snapshot(['z', 'x', 'y']));
      expect(m2.childIds('P')).toEqual(['z', 'x', 'y']);
      expect(told, 'the peer is told, so its Explorer and Text view refresh').toBeGreaterThan(0);
      expect(join(d1).childIds('P')).toEqual(['z', 'x', 'y']);
      expect(appJoin(d1).childIds('P')).toEqual(['z', 'x', 'y']);

      // A drag out of a machine and back in, then a peer joins.
      m1.create('StateDefinition', { id: 'M', declaredName: 'M' });
      m1.transaction(() => {
        m1.create('InitialNode', { id: 'start', declaredName: 'start', ownerId: 'M' });
        m1.create('StateUsage', { id: 'A', declaredName: 'A', ownerId: 'M' });
        m1.create('StateUsage', { id: 'B', declaredName: 'B', ownerId: 'M' });
        m1.create('TransitionUsage', { id: 'toA', ownerId: 'M', source: ['start'], target: ['A'] });
        m1.create('TransitionUsage', { id: 'toB', ownerId: 'M', source: ['start'], target: ['B'] });
      });
      m1.adoptSerialOrder();
      m1.reparent('toA', null);
      m1.adoptSerialOrder();
      m1.reparent('toA', 'M');
      m1.adoptSerialOrder();
      const m3 = join(d1);
      const outOfStart = (m: Model) => m.edgesFrom('start').map((e) => e.id);
      for (const [peer, m] of [['the mover', m1], ['a peer present', m2], ['a peer that joined', m3]] as const) {
        expect(m.childIds('M'), peer).toEqual(['start', 'A', 'B', 'toB', 'toA']);
        expect(outOfStart(m), peer).toEqual(['toB', 'toA']);
        expect(m.rootIds(), peer).toEqual(['P', 'M']);
        expect(childOrder(m), peer).toEqual(childOrder(m1));
        expect(m.all().map((e) => e.id), peer).toEqual(m1.all().map((e) => e.id));
      }
      // A page that joins as the app does holds the room's owners as the mover does, beside its own package.
      const page = appJoin(d1);
      expect(page.childIds('M')).toEqual(['start', 'A', 'B', 'toB', 'toA']);
      expect(outOfStart(page)).toEqual(['toB', 'toA']);
      expect(page.childIds('P')).toEqual(m1.childIds('P'));
      expect(page.rootIds().filter((id) => id !== 'Mine')).toEqual(['P', 'M']);
    });

    it('a batch reaches a peer in the order it was made: what a load lists later, such as typings, too, so Where used lists the usages alike', () => {
      const { m1, m2, d1 } = setup();
      m1.create('Package', { id: 'P', declaredName: 'P' });
      m1.create('PartDefinition', { id: 'D', declaredName: 'D', ownerId: 'P' });
      // A paste of three typed parts: one transaction.
      m1.transaction(() => {
        for (const u of ['u1', 'u2', 'u3']) {
          m1.create('PartUsage', { id: u, declaredName: u, ownerId: 'P' });
          m1.create('FeatureTyping', { id: `t-${u}`, ownerId: u, source: [u], target: ['D'] });
        }
      });
      m1.adoptSerialOrder();
      const typedByD = (m: Model) => m.edgesTo('D').map((e) => e.source?.[0]);
      expect(typedByD(m1)).toEqual(['u1', 'u2', 'u3']);
      expect(typedByD(m2), 'a peer present').toEqual(['u1', 'u2', 'u3']);
      expect(m2.all().map((e) => e.id)).toEqual(m1.all().map((e) => e.id));
      expect(typedByD(join(d1)), 'a peer that joins').toEqual(['u1', 'u2', 'u3']);
    });

    it('the standard library: its owners give their children no place until one is moved there, and every peer holds them as the mover does', () => {
      // The library, loaded before the room: two packages of the library's, and a package of the user's.
      const m1 = new Model();
      m1.create('Package', { id: 'U', declaredName: 'U' });
      m1.create('PartUsage', { id: 'u1', declaredName: 'u1', ownerId: 'U' });
      m1.create('Package', { id: 'Lib', declaredName: 'Lib', attrs: { isLibrary: true } });
      for (const id of ['Real', 'Integer', 'Boolean']) m1.create('DataType', { id, declaredName: id, ownerId: 'Lib', attrs: { isLibrary: true } });
      m1.create('Package', { id: 'ISQ', declaredName: 'ISQ', attrs: { isLibrary: true } });
      for (const id of ['Length', 'Mass']) m1.create('AttributeDefinition', { id, declaredName: id, ownerId: 'ISQ', attrs: { isLibrary: true } });
      m1.create('Package', { id: 'Units', declaredName: 'Units', attrs: { isLibrary: true } });
      for (const id of ['kg', 's']) m1.create('AttributeDefinition', { id, declaredName: id, ownerId: 'Units', attrs: { isLibrary: true } });
      // One of the library's under the user's package, ahead of a typing there: both held after its declarations.
      m1.create('DataType', { id: 'libU0', declaredName: 'libU0', ownerId: 'U', attrs: { isLibrary: true } });
      m1.create('FeatureTyping', { id: 't0', ownerId: 'U', source: ['U'], target: ['Real'] });
      // The peer present writes with the higher client id, so a copy made from the room's state lists its keys first.
      const d1 = new Y.Doc();
      d1.clientID = 1;
      bindModelToDoc(m1, d1);
      const elements = d1.getMap('elements') as Y.Map<Y.Map<unknown>>;
      const placeOf = (id: string) => elements.get(id)!.get('order');
      expect(['Real', 'Integer', 'Boolean', 'Length'].map((id) => elements.get(id)!.has('order')), 'no place under an owner of the library\'s').toEqual([false, false, false, false]);
      expect(placeOf('Lib'), 'a place at the top level').toBe(1);
      expect(placeOf('libU0'), 'a place under an owner of the user\'s').toBe(1);
      expect(join(d1).childIds('Lib')).toEqual(['Real', 'Integer', 'Boolean']);
      expect(join(d1).childIds('U')).toEqual(['u1', 'libU0', 't0']);
      // A peer present, and one that joins as the app joins: its own model bound to a new doc, the room synced in.
      const live = new Model();
      const dl = new Y.Doc();
      dl.clientID = 2 ** 30;
      Y.applyUpdate(dl, Y.encodeStateAsUpdate(d1), 'remote');
      bindModelToDoc(live, dl);
      wire(d1, dl);
      const owners = ['Lib', 'ISQ', 'Units', 'U'];
      const agree = (label: string) => {
        for (const [peer, m] of [['a peer present', live], ['a peer that joins', join(d1)], ['a page that joins', appJoin(d1)]] as const) {
          for (const o of owners) expect(m.childIds(o), `${label}: ${peer}, ${o}`).toEqual(m1.childIds(o));
          expect(m.rootIds().filter((id) => id !== 'Mine'), `${label}: ${peer}, the top level`).toEqual(m1.rootIds());
        }
      };
      // A package of the user's made at the top level after the library's goes after it, on every peer.
      m1.create('Package', { id: 'V', declaredName: 'V' });
      expect(m1.rootIds()).toEqual(['U', 'Lib', 'ISQ', 'Units', 'V']);
      agree('a package made');
      const before = m1.toJSON();

      // An element of the library's dragged out to the top level and back, as the Explorer lets one move within the
      // library: every child of its owner then takes a place, so that it goes last on every peer, as on the mover.
      m1.reparent('Real', null);
      m1.adoptSerialOrder();
      m1.reparent('Real', 'Lib');
      m1.adoptSerialOrder();
      expect(m1.childIds('Lib')).toEqual(['Integer', 'Boolean', 'Real']);
      expect(['Integer', 'Boolean', 'Real'].map(placeOf)).toEqual([0, 1, 2]);
      agree('out to the top level and back');
      // One dragged into another owner of the library's, and a root of the library's into a package of its own.
      m1.reparent('Integer', 'ISQ');
      m1.adoptSerialOrder();
      m1.reparent('ISQ', 'Lib');
      m1.adoptSerialOrder();
      expect(m1.childIds('ISQ')).toEqual(['Length', 'Mass', 'Integer']);
      expect(m1.childIds('Lib')).toEqual(['Boolean', 'Real', 'ISQ']);
      agree('into another owner of the library\'s');
      // An Undo back past them: the reset puts each where it was, and gives places to the owners it moves one into.
      m1.reset(before);
      expect(m1.childIds('Lib')).toEqual(['Real', 'Integer', 'Boolean']);
      agree('an Undo of the drags');
      const midway = m1.toJSON();
      m1.reparent('Boolean', 'ISQ');
      m1.adoptSerialOrder();
      m1.reset(midway);
      expect(m1.childIds('Lib')).toEqual(['Real', 'Integer', 'Boolean']);
      agree('an Undo of a drag out of an owner of the library\'s');

      // An element of the library's made under one of the user's (the SDK's `create` with `attrs.isLibrary` puts it
      // where it is asked) takes a place there, and is held after the owner's declarations, on every peer.
      m1.create('DataType', { id: 'libU', declaredName: 'libU', ownerId: 'U', attrs: { isLibrary: true } });
      m1.adoptSerialOrder();
      m1.create('PartUsage', { id: 'u2', declaredName: 'u2', ownerId: 'U' });
      m1.adoptSerialOrder();
      expect(m1.childIds('U')).toEqual(['u1', 'u2', 'libU0', 't0', 'libU']);
      agree('one of the library\'s under an owner of the user\'s');
      // A typing made after it, then a reset, which writes the room's document whole: each keeps its place.
      m1.create('FeatureTyping', { id: 'tU', ownerId: 'U', source: ['U'], target: ['Real'] });
      m1.adoptSerialOrder();
      m1.reset(m1.toJSON());
      expect(m1.childIds('U')).toEqual(['u1', 'u2', 'libU0', 't0', 'libU', 'tU']);
      agree('a reset over it');
      // One added, by another peer, to an owner of the library's whose children hold no place (a member the library
      // lacked): a place for each, or a copy that lists that peer's keys first would hold it first.
      expect(['kg', 's'].some((id) => elements.get(id)!.has('order'))).toBe(false);
      live.create('AttributeDefinition', { id: 'mol', declaredName: 'mol', ownerId: 'Units', attrs: { isLibrary: true } });
      live.adoptSerialOrder();
      expect(m1.childIds('Units')).toEqual(['kg', 's', 'mol']);
      expect(['kg', 's', 'mol'].map(placeOf)).toEqual([0, 1, 2]);
      agree('a member added to the library');
    });

    it('the library loaded in a room takes no place; a reset at the moment another peer drags one of its members out leaves every peer holding them alike', () => {
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
      const exchange = () => {
        for (let n = 0; n < 3; n++) {
          a2b.splice(0).forEach((u) => Y.applyUpdate(d2, u, 'remote'));
          b2a.splice(0).forEach((u) => Y.applyUpdate(d1, u, 'remote'));
        }
      };
      m1.create('Package', { id: 'U', declaredName: 'U' });
      // The library loads in the room: one batch, every element of it added, none given a place below the top level.
      m1.transaction(() => {
        m1.create('Package', { id: 'Lib', declaredName: 'Lib', attrs: { isLibrary: true } });
        for (const id of ['a', 'b', 'c', 'd']) m1.create('DataType', { id, declaredName: id, ownerId: 'Lib', attrs: { isLibrary: true } });
      });
      exchange();
      const elements = d1.getMap('elements') as Y.Map<Y.Map<unknown>>;
      expect(['a', 'b', 'c', 'd'].some((id) => elements.get(id)!.has('order'))).toBe(false);
      expect(m2.childIds('Lib')).toEqual(['a', 'b', 'c', 'd']);
      const snapshot = m1.toJSON();

      // At once: the second peer drags b out of the library's package to the top level; the first resets, which writes
      // b back where it was. The reset wins b; the second peer takes it back in where the doc lists it, not last.
      m2.reparent('b', null);
      m2.adoptSerialOrder();
      m1.reset(snapshot);
      exchange();
      for (const m of [m1, m2, join(d1), join(d2), appJoin(d1)]) expect(m.childIds('Lib')).toEqual(['a', 'b', 'c', 'd']);
    });

    it('a room whose document an earlier build wrote, with no places: what a peer adds goes last on every peer', () => {
      // The room as an earlier build seeded it: P { a, b }, and no `order` key.
      const old = new Y.Doc();
      const m0 = new Model();
      m0.create('Package', { id: 'P', declaredName: 'P' });
      for (const id of ['a', 'b']) m0.create('PartUsage', { id, declaredName: id, ownerId: 'P' });
      bindModelToDoc(m0, old);
      old.transact(() => {
        for (const ym of (old.getMap('elements') as Y.Map<Y.Map<unknown>>).values()) ym.delete('order');
      });
      // Two peers of this build over copies of the room, live between them.
      const [d1, d2] = [new Y.Doc(), new Y.Doc()];
      Y.applyUpdate(d1, Y.encodeStateAsUpdate(old), 'remote');
      Y.applyUpdate(d2, Y.encodeStateAsUpdate(old), 'remote');
      const p1 = new Model();
      const p2 = new Model();
      bindModelToDoc(p1, d1);
      bindModelToDoc(p2, d2);
      wire(d1, d2);
      p1.create('PartUsage', { id: 'c', declaredName: 'c', ownerId: 'P' });
      p1.adoptSerialOrder();
      for (const m of [p1, p2, join(d1), appJoin(d2)]) expect(m.childIds('P')).toEqual(['a', 'b', 'c']);
      // Every child of P took the place it holds.
      const els = d1.getMap('elements') as Y.Map<Y.Map<unknown>>;
      expect(['a', 'b', 'c'].map((id) => els.get(id)!.get('order'))).toEqual([0, 1, 2]);
    });

    it('two peers that add to one owner at once, and a peer that joins after, hold the result in one order', () => {
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
      const exchange = () => {
        for (let n = 0; n < 3; n++) {
          a2b.splice(0).forEach((u) => Y.applyUpdate(d2, u, 'remote'));
          b2a.splice(0).forEach((u) => Y.applyUpdate(d1, u, 'remote'));
        }
      };
      m1.create('Package', { id: 'P', declaredName: 'P' });
      m1.create('PartUsage', { id: 'p0', declaredName: 'p0', ownerId: 'P' });
      exchange();

      // At once, before either hears of the other: each adds two parts to P, and the second moves p0 out and back in.
      m1.transaction(() => {
        m1.create('PartUsage', { id: 'one-a', ownerId: 'P' });
        m1.create('PartUsage', { id: 'one-b', ownerId: 'P' });
      });
      m2.create('PartUsage', { id: 'two-a', ownerId: 'P' });
      m2.reparent('p0', null);
      m2.reparent('p0', 'P');
      m2.create('PartUsage', { id: 'two-b', ownerId: 'P' });
      exchange();

      expect(m1.childIds('P').sort()).toEqual(['one-a', 'one-b', 'p0', 'two-a', 'two-b']);
      expect(m2.childIds('P')).toEqual(m1.childIds('P'));
      expect(join(d1).childIds('P')).toEqual(m1.childIds('P'));
      expect(join(d2).childIds('P')).toEqual(m1.childIds('P'));
      // Each peer's own adds keep their order among themselves.
      const own = (prefix: string) => m1.childIds('P').filter((id) => id.startsWith(prefix));
      expect(own('one-')).toEqual(['one-a', 'one-b']);
      expect(own('two-')).toEqual(['two-a', 'two-b']);
    });

    it("one peer changes a member's kind while another adds to its owner at once: every peer, and one that joins, hold them alike", () => {
      // What seats a member after its owner's declarations (an implicit feature, one of the library's, a typing) made
      // a declaration through the SDK's `setAttrs` or `update`. Its peer tells the room the place it gives in a doc
      // transaction before the one that changes the kind, so a peer took that place in under the old kind, seated the
      // owner by it, and kept that order until the owner was next edited (the branch review's flip race).
      const flips: Array<[string, string, CreateElementOptions, (m: Model) => void]> = [
        ['implicit', 'AttributeUsage', { attrs: { implicit: true } }, (m) => m.setAttrs('x', { implicit: undefined })],
        ['library', 'DataType', { attrs: { isLibrary: true } }, (m) => m.setAttrs('x', { isLibrary: undefined })],
        ['kind', 'FeatureTyping', { source: ['o'], target: ['P'] }, (m) => m.update('x', { eClass: 'PartUsage' })],
      ];
      for (const [what, eClass, x, flip] of flips) {
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
        const exchange = () => {
          for (let n = 0; n < 3; n++) {
            a2b.splice(0).forEach((u) => Y.applyUpdate(d2, u, 'remote'));
            b2a.splice(0).forEach((u) => Y.applyUpdate(d1, u, 'remote'));
          }
        };
        // o { w, x }, x held after the declaration w; then w removed: x alone, at place 1.
        m1.create('Package', { id: 'P', declaredName: 'P' });
        m1.create('PartUsage', { id: 'o', declaredName: 'o', ownerId: 'P' });
        m1.create('AttributeUsage', { id: 'w', declaredName: 'w', ownerId: 'o' });
        m1.create(eClass, { ...x, id: 'x', declaredName: 'x', ownerId: 'o' });
        m1.adoptSerialOrder();
        exchange();
        m1.remove('w');
        m1.adoptSerialOrder();
        exchange();
        expect(d1.getMap<Y.Map<unknown>>('elements').get('x')!.get('order'), what).toBe(1);

        // At once, before either hears of the other: the first makes x a declaration, the second adds y to o.
        flip(m1);
        m1.adoptSerialOrder();
        m2.create('PartUsage', { id: 'y', declaredName: 'y', ownerId: 'o' });
        m2.adoptSerialOrder();
        exchange();

        expect([...m1.childIds('o')].sort(), what).toEqual(['x', 'y']);
        expect(m2.childIds('o'), what).toEqual(m1.childIds('o'));
        expect(join(d1).childIds('o'), what).toEqual(m1.childIds('o'));
        expect(join(d2).childIds('o'), what).toEqual(m1.childIds('o'));
      }
    });

    it('a reset that swaps two elements\' nesting moves both on a peer', () => {
      const { m1, m2, d1 } = setup();
      // Q before P in the room's document, then Q dragged into P: P { Q }.
      m1.create('Package', { id: 'Q', declaredName: 'Q' });
      m1.create('Package', { id: 'P', declaredName: 'P' });
      m1.reparent('Q', 'P');
      const before = m1.toJSON();
      // Q out, then P into Q: Q { P }.
      m1.reparent('Q', null);
      m1.reparent('P', 'Q');
      expect(m2.get('P')!.ownerId).toBe('Q');
      // An Undo back to P { Q }: the peer takes in Q's move first, which would put Q under its own child P, and is
      // refused until P has moved out from under Q.
      m1.reset(before);
      for (const m of [m1, m2, join(d1)]) {
        expect(m.get('Q')!.ownerId).toBe('P');
        expect(m.get('P')!.ownerId).toBeNull();
        expect(m.rootIds()).toEqual(['P']);
        expect(m.childIds('P')).toEqual(['Q']);
      }
    });

    it('one peer removes an owner while another moves an element into it: every peer holds the element at the top level', () => {
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
      const exchange = () => {
        for (let n = 0; n < 3; n++) {
          a2b.splice(0).forEach((u) => Y.applyUpdate(d2, u, 'remote'));
          b2a.splice(0).forEach((u) => Y.applyUpdate(d1, u, 'remote'));
        }
      };
      m1.create('Package', { id: 'P', declaredName: 'P' });
      m1.create('Package', { id: 'R', declaredName: 'R' });
      m1.create('PartUsage', { id: 'x', declaredName: 'x', ownerId: 'R' });
      m1.create('PartUsage', { id: 'y', declaredName: 'y', ownerId: 'R' });
      exchange();

      m1.remove('P');
      m2.reparent('x', 'P');
      m2.create('PartUsage', { id: 'z', declaredName: 'z', ownerId: 'P' });
      exchange();

      // The room's document holds x and z under P, which it no longer holds: at the top level, on every peer alike —
      // and among the top level's children, not left under an owner that is gone.
      for (const m of [m1, m2, join(d1)]) {
        expect(m.has('P')).toBe(false);
        expect(m.get('x')!.ownerId).toBeNull();
        expect(m.get('z')!.ownerId).toBeNull();
        expect([...m.rootIds()].sort()).toEqual(['R', 'x', 'z']);
        expect(m.childIds('R')).toEqual(['y']);
      }
      expect(m2.rootIds()).toEqual(m1.rootIds());

      // A later edit that writes no owner and adds no element (a rename, an attribute) reads the owners as the doc
      // holds them, without the scan, and leaves the orphans where they stood.
      m1.update('x', { declaredName: 'x2' });
      m2.setAttrs('z', { note: 'n' });
      exchange();
      for (const m of [m1, m2]) {
        expect(m.get('x')!.declaredName).toBe('x2');
        expect(m.get('z')!.attrs.note).toBe('n');
        expect([...m.rootIds()].sort()).toEqual(['R', 'x', 'z']);
      }
    });

    it('two peers who each move one of two elements into the other at once: every peer, a page that joins and a bound model hold the lowest id at the top level', () => {
      const m1 = new Model();
      const m2 = new Model();
      const d1 = new Y.Doc();
      const d2 = new Y.Doc();
      bindModelToDoc(m1, d1);
      bindModelToDoc(m2, d2);
      m1.create('Package', { id: 'X', declaredName: 'X' });
      m1.create('Package', { id: 'Y', declaredName: 'Y' });
      m1.create('PartUsage', { id: 'x1', declaredName: 'x1', ownerId: 'X' });
      m1.create('PartUsage', { id: 'y1', declaredName: 'y1', ownerId: 'Y' });
      Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1), 'remote');
      // Each peer moves one into the other before it hears of the other's move: neither refuses its own.
      const a2b: Uint8Array[] = [];
      const b2a: Uint8Array[] = [];
      d1.on('update', (u: Uint8Array, o: unknown) => o !== 'remote' && a2b.push(u));
      d2.on('update', (u: Uint8Array, o: unknown) => o !== 'remote' && b2a.push(u));
      m1.reparent('X', 'Y');
      m2.reparent('Y', 'X');
      const exchange = () => {
        for (let n = 0; n < 3; n++) {
          a2b.splice(0).forEach((u) => Y.applyUpdate(d2, u, 'remote'));
          b2a.splice(0).forEach((u) => Y.applyUpdate(d1, u, 'remote'));
        }
      };
      exchange();
      // X, the lower id, stands at the top level with Y under it, and what each holds comes with it.
      for (const m of [m1, m2, join(d1), join(d2), appJoin(d1), appJoin(d2, false)]) {
        expect(m.get('X')!.ownerId).toBeNull();
        expect(m.get('Y')!.ownerId).toBe('X');
        expect([...m.rootIds()].filter((id) => id !== 'Mine')).toEqual(['X']);
        expect(m.childIds('X')).toEqual(['x1', 'Y']);
        expect(m.childIds('Y')).toEqual(['y1']);
      }
      // The cycle is gone from the document, so a move of either element again is read alike by every peer.
      const els = d1.getMap('elements') as Y.Map<Y.Map<unknown>>;
      expect([els.get('X')!.get('ownerId'), els.get('Y')!.get('ownerId')]).toEqual([null, 'X']);
      m2.reparent('Y', null);
      exchange();
      for (const m of [m1, m2, join(d1)]) {
        expect(m.get('X')!.ownerId).toBeNull();
        expect(m.get('Y')!.ownerId).toBeNull();
        expect([...m.rootIds()].sort()).toEqual(['X', 'Y']);
      }
    });

    it('elements a document holds in a ring of three, or one in itself, read with the lowest id at the top level', () => {
      const d = new Y.Doc();
      const els = d.getMap('elements') as Y.Map<Y.Map<unknown>>;
      d.transact(() => {
        // C under B under A under C; S under itself; T under S; U under T and V under U (a tail off no ring).
        for (const [id, owner] of [['A', 'C'], ['B', 'A'], ['C', 'B'], ['S', 'S'], ['T', 'S'], ['U', 'T'], ['V', 'U']] as const) {
          const ym = new Y.Map<unknown>();
          els.set(id, ym);
          ym.set('eClass', 'Package');
          ym.set('ownerId', owner);
          ym.set('attrs', new Y.Map());
        }
      });
      const model = new Model();
      bindModelToDoc(model, d);
      expect(model.rootIds().sort()).toEqual(['A', 'S']);
      expect(model.get('B')!.ownerId).toBe('A');
      expect(model.get('C')!.ownerId).toBe('B');
      expect(model.get('T')!.ownerId).toBe('S');
      expect(model.get('V')!.ownerId).toBe('U');
      expect(model.size).toBe(7);
      // The binding wrote the reading into the document: the lowest of each ring at the top level.
      expect(['A', 'S'].map((id) => els.get(id)!.get('ownerId'))).toEqual([null, null]);
      // A peer that holds them otherwise takes the same reading in when the document changes.
      const other = new Model();
      const d2 = new Y.Doc();
      bindModelToDoc(other, d2);
      Y.applyUpdate(d2, Y.encodeStateAsUpdate(d), 'remote');
      for (const id of ['A', 'B', 'C', 'S', 'T', 'U', 'V']) expect(other.get(id)!.ownerId, id).toBe(model.get(id)!.ownerId);
    });

    /**
     * A sweep over random rooms, seeded so that a failure replays. One peer
     * loads a small standard library in the room; then three peers make random
     * edits — batches, typings, drags, a drag out and back in, resets to an
     * earlier snapshot, deletions, a kind changed, a member of the library
     * dragged within it or to the top level, one of the library's added to an
     * owner of its own or of the user's — first one at a time, then at once,
     * before any hears of the others. One at a time, every peer and a peer or
     * a page that joins hold each owner's children as the peer who made the
     * edit does; at once, every peer and a peer that joins hold them alike once
     * all have heard.
     */
    it('a sweep over random rooms: every peer, and one that joins, holds each owner\'s children alike', () => {
      let seed = 20261021;
      const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
      const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
      const KINDS = ['Package', 'PartUsage', 'PartDefinition', 'StateUsage', 'AttributeUsage'];
      let n = 0;
      const snapshots: ReturnType<Model['toJSON']>[] = [];
      function edit(m: Model): void {
        const els = m.all();
        const owners = els.filter((e) => e.eClass !== 'FeatureTyping');
        const library = els.filter((e) => e.attrs.isLibrary === true);
        const r = rnd();
        if (r < 0.35 || els.length < 3) {
          const ownerId = rnd() < 0.2 || owners.length === 0 ? null : pick(owners).id;
          m.transaction(() => {
            for (let k = 1 + Math.floor(rnd() * 3); k > 0; k--) m.create(pick(KINDS), { id: `e${n++}`, ownerId });
          });
        } else if (r < 0.45) {
          const [u, d] = [pick(owners), pick(owners)];
          if (u.id !== d.id) m.create('FeatureTyping', { id: `t${n++}`, ownerId: u.id, source: [u.id], target: [d.id] });
        } else if (r < 0.75) {
          const x = pick(els);
          const back = r >= 0.65;
          try {
            m.transaction(() => {
              const to = back ? x.ownerId : rnd() < 0.15 ? null : pick(owners).id;
              m.reparent(x.id, null);
              m.reparent(x.id, to);
            });
          } catch {
            /* into its own descendant: refused */
          }
        } else if (r < 0.83 && snapshots.length > 0) {
          m.reset(pick(snapshots));
        } else if (r < 0.88) {
          m.remove(pick(els).id);
        } else if (r < 0.94 && library.length > 0) {
          const x = pick(library);
          if (rnd() < 0.6) {
            try {
              m.reparent(x.id, rnd() < 0.3 ? null : pick(library).id);
            } catch {
              /* into its own descendant: refused */
            }
          } else {
            m.create('DataType', { id: `l${n++}`, ownerId: rnd() < 0.5 ? x.id : pick(owners).id, attrs: { isLibrary: true } });
          }
        } else {
          const x = pick(els);
          m.setAttrs(x.id, { implicit: x.attrs.implicit === true ? undefined : true });
        }
        m.adoptSerialOrder();
        if (rnd() < 0.2) snapshots.push(m.toJSON());
      }
      const childOrder = (m: Model): string =>
        JSON.stringify(['', ...m.all().map((e) => e.id).sort()].map((o) => m.childIds(o === '' ? null : o)));
      let checked = 0;
      for (let trial = 0; trial < 6; trial++) {
        const models = [new Model(), new Model(), new Model()];
        const docs = models.map(() => new Y.Doc());
        models.forEach((m, i) => bindModelToDoc(m, docs[i]));
        const outbox: Uint8Array[][] = [[], [], []];
        docs.forEach((d, i) => d.on('update', (u: Uint8Array, o: unknown) => o !== 'remote' && outbox[i].push(u)));
        const hear = () => {
          for (let pass = 0; pass < 4; pass++) {
            outbox.forEach((us, i) => us.splice(0).forEach((u) => docs.forEach((d, j) => j !== i && Y.applyUpdate(d, u, 'remote'))));
          }
        };
        snapshots.length = 0;
        // The library loads in the room: one batch.
        models[0].transaction(() => {
          for (const p of ['L1', 'L2']) {
            models[0].create('Package', { id: p, declaredName: p, attrs: { isLibrary: true } });
            for (let k = 0; k < 3; k++) models[0].create('DataType', { id: `${p}m${k}`, ownerId: p, attrs: { isLibrary: true } });
          }
        });
        hear();
        // One at a time.
        for (let round = 0; round < 60; round++) {
          const mover = models[Math.floor(rnd() * 3)];
          edit(mover);
          hear();
          const want = childOrder(mover);
          for (const m of [...models, join(docs[0]), appJoin(docs[0], false)]) expect(childOrder(m), `trial ${trial}, round ${round}`).toBe(want);
          checked++;
        }
        // At once.
        for (let round = 0; round < 30; round++) {
          for (const m of models) if (rnd() < 0.6) edit(m);
          hear();
          const want = childOrder(models[0]);
          for (const m of [...models, join(docs[0])]) expect(childOrder(m), `trial ${trial}, at once, round ${round}`).toBe(want);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(500);
    }, 60_000);
  });
});
