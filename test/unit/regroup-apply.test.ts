/**
 * regroup-apply — Phase 2 of the Regroup Workbench: planApply (pure
 * pre-validation → op list) + applyRegroup (the atomic mutation), plus the
 * store command's undo/atomicity contract.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Model, ModelFactory } from '@core/index';
import type { ElementRecord } from '@core/index';
import {
  planApply,
  applyRegroup,
  planRegroup,
  defaultRegroupConfig,
} from '@diagram/index';
import type { RegroupConfig } from '@diagram/index';

// The store (imported below for the store-level tests) kicks off an async
// standard-library merge at module load; stub it so the singleton model stays
// deterministic (same idiom as store.reducers.test.ts).
vi.mock('../../src/library/full-library', () => ({
  loadFullStandardLibrary: () => {},
  preloadFullLibrary: async () => {},
}));
vi.mock('../../src/library/standard-library', () => ({
  loadCuratedLibrary: () => {},
}));

// Forced-failure switch for the store-level rollback tests (F3/F5): the store
// imports applyRegroup from @diagram/index, so wrapping it here lets one test
// make the apply throw AFTER a partial mutation has landed — exercising the
// snapshot restore. With `failNext` false the wrapper is a pure passthrough.
const applyCtl = vi.hoisted(() => ({ failNext: false }));
vi.mock('@diagram/index', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/diagram/index')>();
  return {
    ...mod,
    applyRegroup: (model: unknown, plan: unknown) => {
      if (applyCtl.failNext) {
        applyCtl.failNext = false;
        // Worst case: a PARTIAL mutation lands before the throw.
        (model as { create(eClass: string, opts: object): unknown }).create('PartUsage', {
          declaredName: 'partial-junk',
        });
        throw new Error('forced mid-apply failure');
      }
      return (mod.applyRegroup as (m: unknown, p: unknown) => unknown)(model, plan);
    },
  };
});

import { useAppStore } from '../../src/ui/store';

/** Chain a—b—c—d (PartUsages, one port each; aP–bP, bP–cP, cP–dP). */
function chain() {
  const m = new Model();
  const f = new ModelFactory(m);
  const pkg = f.pkg('Sys');
  const mk = (name: string, direction?: 'in' | 'out') => {
    const part = f.part(name, pkg.id);
    const port = f.port(`${name}P`, part.id, direction ? { direction } : {});
    return { part, port };
  };
  const a = mk('a');
  const b = mk('b', 'out');
  const c = mk('c', 'in');
  const d = mk('d');
  const ab = f.connect(a.port.id, b.port.id, { name: 'ab', ownerId: pkg.id });
  const bc = f.connect(b.port.id, c.port.id, { name: 'bc', ownerId: pkg.id });
  const cd = f.connect(c.port.id, d.port.id, { name: 'cd', ownerId: pkg.id });
  return { m, f, pkg, a, b, c, d, ab, bc, cd };
}

const cfg = (over: Partial<RegroupConfig> = {}): RegroupConfig => ({
  ...defaultRegroupConfig(),
  ...over,
});

const B1 = { id: 'new:0', label: 'Bundle 1', isNew: true };
const B2 = { id: 'new:1', label: 'Bundle 2', isNew: true };

function splitConfig(s: ReturnType<typeof chain>): RegroupConfig {
  return cfg({
    bundles: [B1, B2],
    membership: {
      [s.a.part.id]: B1.id,
      [s.b.part.id]: B1.id,
      [s.c.part.id]: B2.id,
      [s.d.part.id]: B2.id,
    },
  });
}

const isUser = (el: ElementRecord): boolean => el.attrs.isLibrary !== true;

describe('planApply — op list', () => {
  it('produces createParts (common-ancestor owner), moves, and per-endpoint ports', () => {
    const s = chain();
    const plan = planApply(s.m, splitConfig(s));
    expect(plan.errors).toEqual([]);
    // Two new composites, both owned by the members' common ancestor (the pkg).
    expect(plan.ops.createParts).toEqual([
      { bundleId: B1.id, label: 'Bundle 1', ownerId: s.pkg.id, eClass: 'PartUsage' },
      { bundleId: B2.id, label: 'Bundle 2', ownerId: s.pkg.id, eClass: 'PartUsage' },
    ]);
    // All four explicit members move (new bundles are always a new owner).
    expect(plan.ops.moves).toEqual([
      { partId: s.a.part.id, bundleId: B1.id },
      { partId: s.b.part.id, bundleId: B1.id },
      { partId: s.c.part.id, bundleId: B2.id },
      { partId: s.d.part.id, bundleId: B2.id },
    ]);
    // ONE port per (bundle, inside endpoint): bP out of B1, cP out of B2 —
    // each rewiring its side of the crossing b–c connection.
    expect(plan.ops.ports).toEqual([
      {
        bundleId: B1.id,
        label: 'bP',
        direction: 'out',
        insideEndpointId: s.b.port.id,
        innerBundleId: null,
        rewires: [{ connectionId: s.bc.id, side: 'source' }],
      },
      {
        bundleId: B2.id,
        label: 'cP',
        direction: 'in',
        insideEndpointId: s.c.port.id,
        innerBundleId: null,
        rewires: [{ connectionId: s.bc.id, side: 'target' }],
      },
    ]);
    expect(plan.summary).toEqual({ newParts: 2, moves: 4, ports: 2, bindings: 2, rewires: 2 });
  });

  it('is pure — planning never mutates the model', () => {
    const s = chain();
    const before = JSON.stringify(s.m.toJSON());
    planApply(s.m, splitConfig(s));
    expect(JSON.stringify(s.m.toJSON())).toBe(before);
  });

  it('skips empty isNew bundles (no empty composites)', () => {
    const s = chain();
    const plan = planApply(s.m, cfg({ bundles: [B1], membership: {} }));
    expect(plan.ops.createParts).toEqual([]);
    expect(plan.summary).toEqual({ newParts: 0, moves: 0, ports: 0, bindings: 0, rewires: 0 });
    expect(plan.errors).toEqual([]);
  });

  it('flags reparent cycles (member is the target / an ancestor of the target)', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const pkg = f.pkg('P');
    const anc = f.part('anc', pkg.id);
    const X = f.part('X', anc.id); // X is a descendant of anc
    // Moving anc INTO X would create a containment cycle; X into itself too.
    const plan = planApply(
      m,
      cfg({
        bundles: [{ id: X.id, label: 'X', isNew: false }],
        membership: { [anc.id]: X.id, [X.id]: X.id },
      }),
    );
    expect(plan.errors.length).toBeGreaterThanOrEqual(2);
    expect(plan.errors.join(' ')).toMatch(/cycle/);
    expect(plan.errors.join(' ')).toMatch(/itself/);
    // Refused: applyRegroup throws BEFORE any mutation.
    const before = JSON.stringify(m.toJSON());
    expect(() => applyRegroup(m, plan)).toThrow(/not applicable/);
    expect(JSON.stringify(m.toJSON())).toBe(before);
  });

  it('flags an existing-part bundle whose target vanished from the model', () => {
    const s = chain();
    const plan = planApply(
      s.m,
      cfg({
        bundles: [{ id: 'deleted-part-id', label: 'Gone', isNew: false }],
        membership: { [s.a.part.id]: 'deleted-part-id' },
      }),
    );
    expect(plan.errors.join(' ')).toMatch(/no longer exists/);
  });

  it('resolves outer-port name collisions deterministically (p, p_2)', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const pkg = f.pkg('P');
    const mk = (name: string) => {
      const part = f.part(name, pkg.id);
      const port = f.port('p', part.id); // BOTH members name their port "p"
      return { part, port };
    };
    const m1 = mk('m1');
    const m2 = mk('m2');
    const z = f.part('z', pkg.id);
    const z1 = f.port('z1', z.id);
    const z2 = f.port('z2', z.id);
    f.connect(m1.port.id, z1.id, { name: 'k1', ownerId: pkg.id });
    f.connect(m2.port.id, z2.id, { name: 'k2', ownerId: pkg.id });
    const config = cfg({
      bundles: [B1],
      membership: { [m1.part.id]: B1.id, [m2.part.id]: B1.id },
    });
    const plan = planApply(m, config);
    expect(plan.errors).toEqual([]);
    // Two distinct inside endpoints → two outer ports, suffixed in boundary
    // order. F2: the labels are CONSUMED from planRegroup's proposedPorts (the
    // single source of truth), so the preview promised these exact names.
    expect(plan.ops.ports.map((p) => p.label)).toEqual(['p', 'p_2']);
    expect(planRegroup(m, config).bundles[0].proposedPorts.map((p) => p.label)).toEqual(
      plan.ops.ports.map((p) => p.label),
    );
    const res = applyRegroup(m, plan);
    const composite = m.get(res.createdPartIds[0])!;
    const portNames = m
      .children(composite.id)
      .filter((c) => c.eClass === 'PortUsage')
      .map((c) => c.declaredName);
    expect(portNames).toEqual(['p', 'p_2']);
  });

  // F1: members spanning ROOTS have no common ancestor chain — the composite
  // must be created at the ROOT (null owner), never at a member-relative
  // fallback (the old "first member's owner" could BE another member, making
  // the later reparent of that member throw mid-apply).
  it('creates the composite at the root when members span roots (never inside a member)', () => {
    const m = new Model();
    const P = m.create('PartUsage', { declaredName: 'P', ownerId: null });
    const Q = m.create('PartUsage', { declaredName: 'Q', ownerId: null });
    const X = m.create('PartUsage', { declaredName: 'X', ownerId: P.id }); // owned by member P
    const config = cfg({
      bundles: [B1],
      membership: { [X.id]: B1.id, [P.id]: B1.id, [Q.id]: B1.id },
    });
    const plan = planApply(m, config);
    expect(plan.errors).toEqual([]);
    expect(plan.ops.createParts).toEqual([
      { bundleId: B1.id, label: 'Bundle 1', ownerId: null, eClass: 'PartUsage' },
    ]);
    // And the apply goes through — no mid-apply reparent throw.
    const res = m.transaction(() => applyRegroup(m, plan));
    const composite = res.createdPartIds[0];
    expect(m.get(composite)?.ownerId).toBeNull();
    for (const id of [X.id, P.id, Q.id]) expect(m.get(id)?.ownerId).toBe(composite);
  });

  // F4: cycles that only materialize once OTHER planned moves have landed —
  // e.g. two existing-part bundles swapping members (A→X and X→A) — must be
  // refused up-front by the simulated-ownership validation, not throw mid-apply.
  it('refuses move-induced cycles across two existing-part bundles (simulated)', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const pkg = f.pkg('P');
    const A = f.part('A', pkg.id);
    const X = f.part('X', pkg.id);
    const plan = planApply(
      m,
      cfg({
        bundles: [
          { id: X.id, label: 'X', isNew: false },
          { id: A.id, label: 'A', isNew: false },
        ],
        membership: { [A.id]: X.id, [X.id]: A.id }, // A into X AND X into A
      }),
    );
    expect(plan.errors.join(' ')).toMatch(/cycle once the other planned moves/);
    const before = JSON.stringify(m.toJSON());
    expect(() => applyRegroup(m, plan)).toThrow(/not applicable/);
    expect(JSON.stringify(m.toJSON())).toBe(before); // refused ⇒ zero mutation
  });

  // L5: two isNew bundles resolving to the SAME label under the SAME computed
  // owner would create two indistinguishable sibling composites — refused.
  it('flags two isNew bundles sharing a label under the same owner', () => {
    const s = chain();
    const config = cfg({
      bundles: [
        { id: 'new:0', label: 'Same', isNew: true },
        { id: 'new:1', label: 'Same', isNew: true },
      ],
      membership: { [s.a.part.id]: 'new:0', [s.c.part.id]: 'new:1' }, // both owned by pkg
    });
    expect(planApply(s.m, config).errors.join(' ')).toMatch(/share the label "Same"/);
    // Same label under DIFFERENT owners is fine (distinct namespaces).
    const m2 = new Model();
    const f2 = new ModelFactory(m2);
    const p1 = f2.pkg('P1');
    const p2 = f2.pkg('P2');
    const x1 = f2.part('x1', p1.id);
    const x2 = f2.part('x2', p2.id);
    const ok = planApply(
      m2,
      cfg({
        bundles: [
          { id: 'new:0', label: 'Same', isNew: true },
          { id: 'new:1', label: 'Same', isNew: true },
        ],
        membership: { [x1.id]: 'new:0', [x2.id]: 'new:1' },
      }),
    );
    expect(ok.errors).toEqual([]);
  });

  // L2: `flow from a to b` maps to eClass 'Flow' — a flow crossing a bundle
  // boundary must be detected (boundary entry) and rewired like any connection.
  it('detects and rewires a Flow crossing the bundle boundary', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const pkg = f.pkg('P');
    const a = f.part('a', pkg.id);
    const aP = f.port('aP', a.id);
    const b = f.part('b', pkg.id);
    const bP = f.port('bP', b.id);
    const flow = m.create('Flow', {
      declaredName: 'fuel',
      ownerId: pkg.id,
      source: [aP.id],
      target: [bP.id],
    });
    const config = cfg({ bundles: [B1], membership: { [a.id]: B1.id } });
    const preview = planRegroup(m, config);
    expect(preview.boundary).toHaveLength(1);
    expect(preview.boundary[0]).toMatchObject({ connectionId: flow.id, connectionKind: 'Flow' });
    const plan = planApply(m, config);
    expect(plan.errors).toEqual([]);
    const res = applyRegroup(m, plan);
    expect(m.get(flow.id)?.source).toEqual([res.createdPortIds[0]]); // rewired
    expect(m.get(flow.id)?.target).toEqual([bP.id]); // outside side untouched
  });
});

describe('applyRegroup — the atomic mutation', () => {
  it('creates composites, reparents members, synthesizes ports+bindings, rewires', () => {
    const s = chain();
    const plan = planApply(s.m, splitConfig(s));
    const sizeBefore = s.m.all().length;
    const res = s.m.transaction(() => applyRegroup(s.m, plan));

    // Composites exist under the common ancestor, with the members inside.
    const [b1, b2] = res.createdPartIds;
    expect(s.m.get(b1)).toMatchObject({ declaredName: 'Bundle 1', eClass: 'PartUsage', ownerId: s.pkg.id });
    expect(s.m.get(b2)).toMatchObject({ declaredName: 'Bundle 2', ownerId: s.pkg.id });
    expect(s.m.get(s.a.part.id)?.ownerId).toBe(b1);
    expect(s.m.get(s.b.part.id)?.ownerId).toBe(b1);
    expect(s.m.get(s.c.part.id)?.ownerId).toBe(b2);
    expect(s.m.get(s.d.part.id)?.ownerId).toBe(b2);
    expect(res.movedPartIds).toHaveLength(4);

    // Outer delegation ports on the composites, direction copied.
    const [p1, p2] = res.createdPortIds;
    expect(s.m.get(p1)).toMatchObject({ declaredName: 'bP', eClass: 'PortUsage', ownerId: b1 });
    expect(s.m.get(p1)?.attrs.direction).toBe('out');
    expect(s.m.get(p2)).toMatchObject({ declaredName: 'cP', ownerId: b2 });
    expect(s.m.get(p2)?.attrs.direction).toBe('in');

    // ONE BindingConnectorAsUsage per outer port: outer → inner endpoint.
    const [g1, g2] = res.createdBindingIds;
    expect(s.m.get(g1)).toMatchObject({ eClass: 'BindingConnectorAsUsage', ownerId: b1 });
    expect(s.m.get(g1)?.source).toEqual([p1]);
    expect(s.m.get(g1)?.target).toEqual([s.b.port.id]);
    expect(s.m.get(g2)?.source).toEqual([p2]);
    expect(s.m.get(g2)?.target).toEqual([s.c.port.id]);

    // The crossing connection now runs OUTER-to-OUTER; the internal ones are untouched.
    expect(s.m.get(s.bc.id)?.source).toEqual([p1]);
    expect(s.m.get(s.bc.id)?.target).toEqual([p2]);
    expect(res.rewiredConnectionIds).toEqual([s.bc.id]);
    expect(s.m.get(s.ab.id)?.source).toEqual([s.a.port.id]);
    expect(s.m.get(s.ab.id)?.target).toEqual([s.b.port.id]);
    expect(s.m.get(s.cd.id)?.source).toEqual([s.c.port.id]);
    expect(s.m.get(s.cd.id)?.target).toEqual([s.d.port.id]);

    // Exactly the created elements were added: 2 parts + 2 ports + 2 bindings.
    expect(s.m.all().length).toBe(sizeBefore + 6);

    // A fresh default preview over the new shape carries no stale state.
    const preview = planRegroup(s.m, defaultRegroupConfig());
    expect(preview.stats.partCount).toBe(6); // a,b,c,d + the two composites
    expect(preview.boundary).toEqual([]);
    expect(preview.stats.internalCount).toBe(0);
  });

  it('existing-part bundle: a no-op already-owned member keeps the target’s PRE-EXISTING interface (no new port)', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const pkg = f.pkg('P');
    const X = f.part('X', pkg.id);
    const e = f.part('e', X.id); // ALREADY owned by the bundle target
    const eP = f.port('eP', e.id, { direction: 'out' });
    const z = f.part('z', pkg.id);
    const zP = f.port('zP', z.id);
    const conn = f.connect(eP.id, zP.id, { name: 'link', ownerId: pkg.id });
    const plan = planApply(
      m,
      cfg({ bundles: [{ id: X.id, label: 'X', isNew: false }], membership: { [e.id]: X.id } }),
    );
    expect(plan.errors).toEqual([]);
    expect(plan.ops.createParts).toEqual([]);
    expect(plan.ops.moves).toEqual([]); // nothing to reparent
    // e was already inside X and z already outside — the eP–zP crossing is X's
    // OWN pre-existing external interface, not a crossing this regroup created,
    // so no delegation port is synthesized and the connection is left as-is.
    expect(plan.ops.ports).toEqual([]);
    expect(plan.summary).toEqual({ newParts: 0, moves: 0, ports: 0, bindings: 0, rewires: 0 });
    const res = applyRegroup(m, plan);
    expect(res.createdPortIds).toEqual([]);
    expect(m.get(e.id)?.ownerId).toBe(X.id); // untouched
    expect(m.get(conn.id)?.source).toEqual([eP.id]); // connection untouched
  });

  it('part-endpoint connection: synthetic part_connection port, binding to the PART id', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const pkg = f.pkg('P');
    const a = f.part('a', pkg.id);
    const b = f.part('b', pkg.id);
    const conn = f.connect(a.id, b.id, { name: 'c1', ownerId: pkg.id }); // parts bound directly
    const plan = planApply(m, cfg({ bundles: [B1], membership: { [a.id]: B1.id } }));
    expect(plan.ops.ports).toEqual([
      {
        bundleId: B1.id,
        label: 'a_c1',
        direction: null,
        insideEndpointId: a.id,
        innerBundleId: null,
        rewires: [{ connectionId: conn.id, side: 'source' }],
      },
    ]);
    const res = applyRegroup(m, plan);
    const outer = m.get(res.createdPortIds[0])!;
    expect(outer.attrs.direction).toBeUndefined(); // null direction → no attr
    expect(m.get(res.createdBindingIds[0])?.target).toEqual([a.id]); // binds the PART
    expect(m.get(conn.id)?.source).toEqual([outer.id]);
  });

  it('ATOMICITY: a mid-apply failure restores the pre-apply snapshot exactly', () => {
    const s = chain();
    const plan = planApply(s.m, splitConfig(s));
    // Inject an inconsistency the pre-validation could not have seen: a rewire
    // against a connection id that does not exist. It is hit AFTER composites,
    // moves, and the first port have already mutated the model.
    plan.ops.ports[1].rewires.push({ connectionId: 'no-such-connection', side: 'source' });

    // The store-equivalent wrapper: snapshot → transaction(apply) → on throw
    // restore via resetPreserving (exactly what store.applyRegroup does).
    const snapshot = s.m.toJSONWhere(isUser);
    const before = JSON.stringify(s.m.toJSON());
    expect(() => s.m.transaction(() => applyRegroup(s.m, plan))).toThrow(/no longer references|missing/);
    expect(JSON.stringify(s.m.toJSON())).not.toBe(before); // partial mutation DID land…
    s.m.resetPreserving(snapshot, (el) => el.attrs.isLibrary === true);
    expect(JSON.stringify(s.m.toJSON())).toBe(before); // …and the restore erases it
  });
});

describe('apply — existing-part bundle interior + port renames', () => {
  it('delegates ONLY the member’s external, leaving the member↔interior + target’s own interface untouched', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const pkg = f.pkg('P');
    const X = f.part('X', pkg.id);
    const N = f.part('N', X.id); // pre-existing child of the target
    const n1 = f.port('n1', N.id);
    const n2 = f.port('n2', N.id);
    const M = f.part('M', pkg.id); // moved into X
    const m1 = f.port('m1', M.id);
    const m2 = f.port('m2', M.id);
    const O = f.part('O', pkg.id); // outside
    const o1 = f.port('o1', O.id);
    const o2 = f.port('o2', O.id);
    const cMN = f.connect(m1.id, n1.id, { name: 'mn', ownerId: pkg.id }); // internal after move
    const cMO = f.connect(m2.id, o1.id, { name: 'mo', ownerId: pkg.id }); // delegate on X
    const cNO = f.connect(n2.id, o2.id, { name: 'no', ownerId: pkg.id }); // X's own interface

    const plan = planApply(
      m,
      cfg({ bundles: [{ id: X.id, label: 'X', isNew: false }], membership: { [M.id]: X.id } }),
    );
    expect(plan.errors).toEqual([]);
    expect(plan.summary).toMatchObject({ ports: 1, bindings: 1, rewires: 1 });
    expect(plan.ops.ports[0]).toMatchObject({ bundleId: X.id, insideEndpointId: m2.id });

    const res = applyRegroup(m, plan);
    expect(m.get(M.id)?.ownerId).toBe(X.id); // member moved in
    expect(res.createdPortIds).toHaveLength(1);
    // Only the member's external was rewired; the internal + own-interface stay.
    expect(res.rewiredConnectionIds).toEqual([cMO.id]);
    expect(m.get(cMN.id)?.source).toEqual([m1.id]); // member↔interior untouched
    expect(m.get(cMN.id)?.target).toEqual([n1.id]);
    expect(m.get(cNO.id)?.source).toEqual([n2.id]); // X's own interface untouched
  });

  it('a portLabels rename flows through to the synthesized outer port name', () => {
    const s = chain();
    const key = `${B1.id}::${s.b.port.id}`;
    const plan = planApply(s.m, { ...splitConfig(s), portLabels: { [key]: 'ctrlPort' } });
    const b1Port = plan.ops.ports.find((p) => p.bundleId === B1.id)!;
    expect(b1Port.label).toBe('ctrlPort');
    const res = applyRegroup(s.m, plan);
    const created = res.createdPortIds.map((id) => s.m.get(id)?.declaredName);
    expect(created).toContain('ctrlPort');
  });

  it('MISSING-PORT fix: a pre-existing child moved OUT earns the target a new delegation port', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const pkg = f.pkg('P');
    const X = f.part('X', pkg.id); // existing TARGET bundle
    const N = f.part('N', X.id); // pre-existing child of X…
    const nP = f.port('nP', N.id);
    const N2 = f.part('N2', X.id); // …connected internally to a sibling in X
    const n2P = f.port('n2P', N2.id);
    const outside = f.part('outside', pkg.id); // pulls the new bundle's owner ABOVE X
    const outP = f.port('outP', outside.id);
    const cInternal = f.connect(nP.id, n2P.id, { name: 'nn', ownerId: pkg.id });
    f.connect(outP.id, nP.id, { name: 'on', ownerId: pkg.id }); // ties N to `outside` in B

    // X is a target; move its child N out into a NEW bundle B (whose composite
    // lands under pkg, OUTSIDE X, because its members span X's boundary). The
    // N–N2 connection now newly crosses X → X needs a delegation port for n2P.
    const plan = planApply(
      m,
      cfg({
        bundles: [B1, { id: X.id, label: 'X', isNew: false }],
        membership: { [N.id]: B1.id, [outside.id]: B1.id },
      }),
    );
    expect(plan.errors).toEqual([]);
    const xPort = plan.ops.ports.find((p) => p.insideEndpointId === n2P.id);
    expect(xPort, 'X must get a delegation port for the newly-crossing n2P').toBeTruthy();
    expect(xPort!.bundleId).toBe(X.id);
    // n2P is the connection's TARGET endpoint, so that is the side X takes over.
    expect(xPort!.rewires).toEqual([{ connectionId: cInternal.id, side: 'target' }]);
  });

  it('refuses nested existing-part bundles (target inside another target)', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const pkg = f.pkg('P');
    const X1 = f.part('X1', pkg.id);
    const X2 = f.part('X2', X1.id); // X2 nested inside X1
    const m1 = f.part('m1', pkg.id);
    const plan = planApply(
      m,
      cfg({
        bundles: [
          { id: X1.id, label: 'X1', isNew: false },
          { id: X2.id, label: 'X2', isNew: false },
        ],
        membership: { [m1.id]: X1.id },
      }),
    );
    expect(plan.errors.join(' ')).toMatch(/nested inside/);
  });

  it('refuses an existing target whose ancestor is a moved member', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const pkg = f.pkg('P');
    const A = f.part('A', pkg.id);
    const X = f.part('X', A.id); // target X sits inside A…
    const other = f.part('other', pkg.id);
    const plan = planApply(
      m,
      cfg({
        bundles: [B1, { id: X.id, label: 'X', isNew: false }],
        membership: { [A.id]: B1.id, [other.id]: X.id }, // …and A is moved into B1
      }),
    );
    expect(plan.errors.join(' ')).toMatch(/being moved into another bundle/);
  });

  it('refuses two bundles that share the same id', () => {
    const s = chain();
    const plan = planApply(
      s.m,
      cfg({
        bundles: [B1, { id: B1.id, label: 'Dup', isNew: true }],
        membership: { [s.a.part.id]: B1.id },
      }),
    );
    expect(plan.errors.join(' ')).toMatch(/share the same id/);
  });

  it('NESTED new bundles: only the inner composite is ported; the model applies cleanly', () => {
    // parent A → Bundle 1, child B → Bundle 2, deep connection C.cP – A.aP.
    // B2 nests inside B1 after apply, so ONLY B2's composite gets a delegation
    // port; B1 gets none. (Regression: B1 used to get a spurious aP port.)
    const m = new Model();
    const f = new ModelFactory(m);
    const pkg = f.pkg('P');
    const A = f.part('A', pkg.id);
    const aP = f.port('aP', A.id);
    const B = f.part('B', A.id);
    const C = f.part('C', B.id);
    const cP = f.port('cP', C.id);
    const conn = f.connect(cP.id, aP.id, { name: 'deep', ownerId: pkg.id });

    const plan = planApply(
      m,
      cfg({ bundles: [B1, B2], membership: { [A.id]: B1.id, [B.id]: B2.id } }),
    );
    expect(plan.errors).toEqual([]);
    expect(plan.summary).toMatchObject({ newParts: 2, ports: 1, bindings: 1, rewires: 1 });
    // The single port belongs to Bundle 2, delegating C.cP.
    expect(plan.ops.ports[0]).toMatchObject({ bundleId: B2.id, insideEndpointId: cP.id });

    const res = m.transaction(() => applyRegroup(m, plan));
    expect(res.createdPortIds).toHaveLength(1);
    const outer = m.get(res.createdPortIds[0])!;
    const comp1 = res.createdPartIds.find((id) => m.get(id)?.declaredName === 'Bundle 2')!;
    const comp0 = res.createdPartIds.find((id) => m.get(id)?.declaredName === 'Bundle 1')!;
    expect(outer.ownerId).toBe(comp1); // port on the INNER composite
    // A.aP side untouched; C.cP side rewired onto the inner port.
    expect(m.get(conn.id)?.target).toEqual([aP.id]);
    expect(m.get(conn.id)?.source).toEqual([outer.id]);
    // Both A and C end up inside the OUTER composite (the connection is internal
    // to it, which is exactly why B1 needed no port).
    expect(m.ancestors(A.id).some((a) => a.id === comp0)).toBe(true);
    expect(m.ancestors(C.id).some((a) => a.id === comp0)).toBe(true);
  });

  it('MULTI-LEVEL: a deep-inside→fully-outside crossing gets a CHAINED port at each level', () => {
    // A→B1 (comp1), B (child of A)→B2 (comp2, nested in comp1), C rides into
    // comp2; C.cP connects to O fully outside. Ports on BOTH comp2 (inner) and
    // comp1 (outer), chained comp2.port→cP, comp1.port→comp2.port; the connection
    // attaches at the OUTERMOST (comp1) port.
    const m = new Model();
    const f = new ModelFactory(m);
    const pkg = f.pkg('P');
    const A = f.part('A', pkg.id);
    const B = f.part('B', A.id);
    const C = f.part('C', B.id);
    const cP = f.port('cP', C.id);
    const O = f.part('O', pkg.id);
    const oP = f.port('oP', O.id);
    const conn = f.connect(cP.id, oP.id, { name: 'deepOut', ownerId: pkg.id });

    const plan = planApply(
      m,
      cfg({ bundles: [B1, B2], membership: { [A.id]: B1.id, [B.id]: B2.id } }),
    );
    expect(plan.errors).toEqual([]);
    expect(plan.summary).toMatchObject({ ports: 2, bindings: 2, rewires: 1 });

    const res = m.transaction(() => applyRegroup(m, plan));
    expect(res.createdPortIds).toHaveLength(2);
    const comp1 = res.createdPartIds.find((id) => m.get(id)?.declaredName === 'Bundle 1')!; // outer
    const comp2 = res.createdPartIds.find((id) => m.get(id)?.declaredName === 'Bundle 2')!; // inner
    const pInner = res.createdPortIds.find((id) => m.get(id)?.ownerId === comp2)!;
    const pOuter = res.createdPortIds.find((id) => m.get(id)?.ownerId === comp1)!;
    expect(pInner).toBeTruthy();
    expect(pOuter).toBeTruthy();
    // Chained bindings: inner→endpoint, outer→inner.
    const bindings = res.createdBindingIds.map((id) => m.get(id)!);
    expect(bindings.find((b) => b.source?.[0] === pInner)?.target).toEqual([cP.id]);
    expect(bindings.find((b) => b.source?.[0] === pOuter)?.target).toEqual([pInner]);
    // Connection attaches at the OUTERMOST port.
    expect(m.get(conn.id)?.source).toEqual([pOuter]);
  });

  it('MULTI-LEVEL: two connections from one endpoint at DIFFERENT depths attach at their own outermost port', () => {
    // Same nesting; cP has TWO connections: one to `far` (fully outside → crosses
    // B2 + B1), one to `mid` (a sibling of B inside comp1 but outside comp2 →
    // crosses B2 only). The shared inner port is reused; each connection attaches
    // at its own outermost crossed level.
    const m = new Model();
    const f = new ModelFactory(m);
    const pkg = f.pkg('P');
    const A = f.part('A', pkg.id);
    const B = f.part('B', A.id);
    const C = f.part('C', B.id);
    const cP = f.port('cP', C.id);
    const far = f.part('far', pkg.id);
    const farP = f.port('farP', far.id);
    const mid = f.part('mid', A.id); // inside comp1 (rides with A) but outside comp2
    const midP = f.port('midP', mid.id);
    const cFar = f.connect(cP.id, farP.id, { name: 'cf', ownerId: pkg.id }); // crosses B2 + B1
    const cMid = f.connect(cP.id, midP.id, { name: 'cm', ownerId: pkg.id }); // crosses B2 only

    const plan = planApply(
      m,
      cfg({ bundles: [B1, B2], membership: { [A.id]: B1.id, [B.id]: B2.id } }),
    );
    expect(plan.errors).toEqual([]);
    expect(plan.summary).toMatchObject({ ports: 2, rewires: 2 });

    const res = m.transaction(() => applyRegroup(m, plan));
    const comp1 = res.createdPartIds.find((id) => m.get(id)?.declaredName === 'Bundle 1')!;
    const comp2 = res.createdPartIds.find((id) => m.get(id)?.declaredName === 'Bundle 2')!;
    const pInner = res.createdPortIds.find((id) => m.get(id)?.ownerId === comp2)!;
    const pOuter = res.createdPortIds.find((id) => m.get(id)?.ownerId === comp1)!;
    // cFar reaches fully outside → attaches at the OUTER port; cMid only leaves
    // comp2 → attaches at the INNER port (which is shared).
    expect(m.get(cFar.id)?.source).toEqual([pOuter]);
    expect(m.get(cMid.id)?.source).toEqual([pInner]);
    // The inner port binds to cP; the outer chains from the inner.
    const bindings = res.createdBindingIds.map((id) => m.get(id)!);
    expect(bindings.find((b) => b.source?.[0] === pInner)?.target).toEqual([cP.id]);
    expect(bindings.find((b) => b.source?.[0] === pOuter)?.target).toEqual([pInner]);
  });
});

describe('store.applyRegroup — undoable command', () => {
  const st = () => useAppStore.getState();

  beforeEach(() => {
    applyCtl.failNext = false;
    useAppStore.setState({
      model: new Model(),
      undoStack: [],
      redoStack: [],
      selectionId: null,
      activeView: 'regroup',
      regroupConfig: defaultRegroupConfig(),
      regroup: null,
      regroupApply: null,
    });
  });

  it('apply then undo() round-trips the model exactly', () => {
    const model = st().model;
    const f = new ModelFactory(model);
    const pkg = f.pkg('Sys');
    const a = f.part('a', pkg.id);
    const aP = f.port('aP', a.id);
    const b = f.part('b', pkg.id);
    const bP = f.port('bP', b.id);
    f.connect(aP.id, bP.id, { name: 'ab', ownerId: pkg.id });
    useAppStore.setState({
      regroupConfig: cfg({ bundles: [B1], membership: { [a.id]: B1.id } }),
    });
    const before = JSON.stringify(model.toJSONWhere(isUser));

    st().applyRegroup();
    // One undo step; the composite + port + binding landed; config consumed.
    expect(st().undoStack).toHaveLength(1);
    expect(model.all().some((e) => e.declaredName === 'Bundle 1')).toBe(true);
    expect(model.get(a.id)?.ownerId).not.toBe(pkg.id);
    expect(st().regroupConfig).toEqual(defaultRegroupConfig());

    st().undo();
    expect(JSON.stringify(model.toJSONWhere(isUser))).toBe(before);
    expect(model.all().some((e) => e.declaredName === 'Bundle 1')).toBe(false);
  });

  it('refuses an erroneous plan with ZERO mutation and no undo entry', () => {
    const model = st().model;
    const f = new ModelFactory(model);
    const pkg = f.pkg('P');
    const anc = f.part('anc', pkg.id);
    const X = f.part('X', anc.id);
    useAppStore.setState({
      regroupConfig: cfg({
        bundles: [{ id: X.id, label: 'X', isNew: false }],
        membership: { [anc.id]: X.id }, // ancestor → cycle error
      }),
    });
    const before = JSON.stringify(model.toJSON());
    st().applyRegroup();
    expect(JSON.stringify(model.toJSON())).toBe(before);
    expect(st().undoStack).toHaveLength(0);
    expect(st().regroupApply?.errors.length).toBeGreaterThan(0);
  });

  it('does nothing (not even an undo entry) when there is no work', () => {
    st().applyRegroup(); // default config: no bundles, no membership
    expect(st().undoStack).toHaveLength(0);
  });

  // F3 + F5: a failed apply must (a) restore the model exactly, (b) keep the
  // user's REDO history (pushUndo cleared it, so the catch must put it back),
  // and (c) surface the failure in the plan-errors strip — never silently.
  it('a failed apply restores the model, keeps the redo stack, and surfaces the error', () => {
    const model = st().model;
    const f = new ModelFactory(model);
    const pkg = f.pkg('Sys');
    const a = f.part('a', pkg.id);
    const aP = f.port('aP', a.id);
    const b = f.part('b', pkg.id);
    const bP = f.port('bP', b.id);
    f.connect(aP.id, bP.id, { name: 'ab', ownerId: pkg.id });
    // Build a redo entry: one store edit, then undo it.
    st().createElement('PartDefinition', null, 'Temp');
    st().undo();
    expect(st().redoStack).toHaveLength(1);
    useAppStore.setState({ regroupConfig: cfg({ bundles: [B1], membership: { [a.id]: B1.id } }) });
    const before = JSON.stringify(model.toJSONWhere(isUser));

    applyCtl.failNext = true; // the wrapped engine mutates partially, then throws
    st().applyRegroup();

    expect(JSON.stringify(model.toJSONWhere(isUser))).toBe(before); // rolled back
    expect(model.all().some((e) => e.declaredName === 'partial-junk')).toBe(false);
    expect(st().redoStack).toHaveLength(1); // F3: redo history preserved
    expect(st().undoStack).toHaveLength(0); // the failed apply's snapshot popped
    expect(st().regroupApply?.errors.join(' ')).toMatch(/forced mid-apply failure/); // F5
    expect(st().regroupConfig.bundles).toHaveLength(1); // config NOT consumed on failure
  });
});
