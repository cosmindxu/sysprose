/**
 * Coupled regions of a parallel state (SysML v2 §7.18.2: concurrent, no order fixed). The interpreter applies the
 * regions in declaration order; the explorer explores EVERY order, so its reachable leaf sets include each
 * interpreter run, in either declaration order, and equal the union over every declaration-order permutation.
 */
import { describe, it, expect } from 'vitest';
import { loadModelText } from '@text/load';
import { runStateMachine } from '../../src/semantics/execute';
import { exploreMachine, reachReport } from '../../src/semantics/mc/explore';
import { parallelRefusal } from '../../src/semantics/mc/parallel';
import { SEMANTIC_PROFILE } from '../../src/semantics/mc/profile';

const find = (m: any, n: string): any => m.all().find((e: any) => m.qualifiedName(e.id) === n);
const load = async (src: string): Promise<any> => (await loadModelText(src, { fileName: 'po.sysml' })).model;

const R: Record<string, string> = {
  r1: 'state r1 { entry; then a1; state a1; state a2 { entry assign n := 1; } transition t1 first a1 accept f then a2; }',
  r2: 'state r2 { entry; then b1; state b1; state b2 { entry assign n := 2; } transition t2 first b1 accept f if n == 1 then b2; }',
  r3: 'state r3 { entry; then c1; state c1; state c2; transition t3 first c1 accept f if n == 2 then c2; }',
  r4: 'state r4 { entry; then d1; state d1; state d2 { entry assign n := 0; } transition t4 first d1 accept g then d2; }',
  r5: 'state r5 { entry; then e1; state e1; state e2; transition t5 first e1 accept f if n == 0 then e2; }',
};
const text = (order: string[]): string =>
  `package P { item def f; item def g; state def M { attribute n : Integer = 0; entry; then p; state p parallel { ${order.map((k) => R[k]).join(' ')} } } }`;
const perms = <T,>(xs: T[]): T[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));
const EV = ['f', 'g'];
const seqs = (len: number): string[][] => {
  let layer: string[][] = [[]];
  let out: string[][] = [[]];
  for (let i = 0; i < len; i++) {
    layer = layer.flatMap((s) => EV.map((x) => [...s, x]));
    out = out.concat(layer);
  }
  return out;
};
async function interpLeaves(order: string[], len: number): Promise<Set<string>> {
  const model = await load(text(order));
  const id = find(model, 'P::M').id;
  const out = new Set<string>();
  for (const s of seqs(len)) {
    const r = runStateMachine(model, id, s);
    expect(r.unopened, s.join(',')).toBeUndefined();
    out.add(r.activeStates.map((x: string) => model.qualifiedName(x)).sort().join(' | '));
  }
  return out;
}
async function walkLeaves(order: string[]): Promise<{ set: Set<string>; walk: any }> {
  const model = await load(text(order));
  const walk = exploreMachine(model, find(model, 'P::M').id);
  return { set: new Set(walk.configRegionLeaves.map((ls: readonly string[]) => ls.map((s) => model.qualifiedName(s)).sort().join(' | '))), walk };
}

describe('coupled regions are explored in every order', () => {
  for (const keys of [['r1', 'r2'], ['r1', 'r2', 'r3'], ['r1', 'r2', 'r4', 'r5']]) {
    it(`${keys.join('+')}: the walk includes both declaration orders' runs and the union over all orders`, async () => {
      const { set: walked, walk } = await walkLeaves(keys);
      expect(walk.unsupported).toEqual([]);
      expect(walk.exhaustive).toBe(true);
      const len = keys.length > 3 ? 4 : 5;
      const union = new Set<string>();
      for (const o of perms(keys)) for (const k of await interpLeaves(o, len)) union.add(k);
      for (const k of union) expect(walked.has(k), `the walk lacks ${k}`).toBe(true);
      for (const k of await interpLeaves(keys, len)) expect(walked.has(k)).toBe(true);
      for (const k of await interpLeaves([...keys].reverse(), len)) expect(walked.has(k)).toBe(true);
      // Every order is a run of the machine, so nothing the walk holds is outside the union for these small machines.
      expect([...walked].sort()).toEqual([...union].sort());
      // The walk of the permuted text is the same set: the walk does not depend on the declaration order.
      expect([...(await walkLeaves([...keys].reverse())).set].sort()).toEqual([...walked].sort());
    });
  }

  it('the non-declaration order is reached: r2 before r1 leaves r2 behind', async () => {
    const { set } = await walkLeaves(['r1', 'r2']);
    expect([...set].some((k) => k.includes('::r1::a2') && k.includes('::r2::b1'))).toBe(true);
    expect([...set].some((k) => k.includes('::r1::a2') && k.includes('::r2::b2'))).toBe(true);
  });

  it('uncoupled regions keep one order (same result in every order)', async () => {
    const model = await load(
      `package P { item def f; state def M { entry; then p; state p parallel { state r1 { entry; then a; state a; state b; transition t first a accept f then b; } state r2 { entry; then c; state c; state d; transition u first c accept f then d; } } } }`,
    );
    const w = exploreMachine(model, find(model, 'P::M').id);
    expect(w.exhaustive).toBe(true);
    expect(w.configRegionLeaves.length).toBe(2);
  });

  it('more than 4 coupled regions are refused with a stated reason', async () => {
    const model = await load(text(['r1', 'r2', 'r3', 'r4', 'r5']));
    const id = find(model, 'P::M').id;
    expect(parallelRefusal(model, id)?.reason).toMatch(/coupled through the attribute store.*at most 4 regions/);
    const w = exploreMachine(model, id);
    expect(w.exhaustive).toBe(false);
    expect(w.unsupported[0].construct).toBe('parallel-regions');
  });

  it('the profile states every order, and a witness is replayed, withheld only where it needs another order', () => {
    const f = SEMANTIC_PROFILE.find((x) => x.field === 'regions')!;
    expect(f.reading).toContain('EVERY order');
    expect(f.reading).toContain('a witness whose path applies coupled regions in another order is withheld');
  });
});

describe('a guard in a region reads the attributes of the machine that holds it', () => {
  it('is decided, as the interpreter decides it (lexical scope through the parallel state)', async () => {
    const t = `package P { state def M { attribute n : Integer = 0; entry; then p;
      state p parallel { state r1 { entry; then b1; state b1; state b2; transition t2 first b1 accept f if n == 0 then b2; } } } }`;
    const { model } = await loadModelText(t, { fileName: 'scope.sysml' });
    const m: any = reachReport(model!).machines[0];
    expect(m.exhaustive).toBe(true);
    expect(m.undeterminedGuards ?? []).toEqual([]);
  });
});
