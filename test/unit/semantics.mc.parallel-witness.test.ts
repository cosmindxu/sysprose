/**
 * Witnesses on a machine with a parallel state. A witness step is an event (or a completion); on concurrent regions it
 * fires one transition per region. The witness is published only when the interpreter fires the same transitions, in
 * declaration order, and stands in the same leaves; a witness that needs another order of coupled regions is withheld.
 */
import { describe, it, expect } from 'vitest';
import { loadModelText } from '@text/load';
import { runStateMachine } from '../../src/semantics/execute';
import { checkProperty, WITNESS_NOT_REPLAYED_CODE, type PropertyText } from '../../src/semantics/mc/patterns';
import { readAtom, UNKNOWN_ATOM_CODE } from '../../src/semantics/mc/atoms';
import { SEMANTIC_PROFILE } from '../../src/semantics/mc/profile';

const find = (m: any, n: string): any => m.all().find((e: any) => m.qualifiedName(e.id) === n);
const prop = (f: Partial<PropertyText> & { pattern: string }): PropertyText =>
  ({ source: 'flag', carrier: null, scope: 'globally', ...f }) as PropertyText;
const load = async (src: string): Promise<any> => (await loadModelText(src, { fileName: 'pw.sysml' })).model;

const nested = `package P { item def f; item def g; state def M { entry; then p;
  state p parallel {
    state r1 { entry; then a1; state a1; state a2; transition t1 first a1 accept f then a2; }
    state r2 { entry; then b1; state b1; state b2; transition t2 first b1 accept f then b2; }
  }
  state q; transition go first p accept g then q; } }`;

describe('a witness on a parallel machine is replayed through the interpreter', () => {
  it('an absence violated: published, and the interpreter ends in the witness leaves', async () => {
    const model = await load(nested);
    const id = find(model, 'P::M').id;
    const v = checkProperty(model, id, prop({ pattern: 'absence', p: 'state b2' }));
    expect(v.claim).toBe('fail');
    expect(v.code).not.toBe(WITNESS_NOT_REPLAYED_CODE);
    expect(v.witness.length).toBe(2);
    const last = v.witness[v.witness.length - 1];
    expect(last.fires!.map((i) => model.qualifiedName(i))).toEqual(['P::M::p::r1::t1', 'P::M::p::r2::t2']);
    const run = runStateMachine(model, id, v.witness.slice(1).map((s) => s.event));
    expect(run.activeStates.slice().sort()).toEqual(last.leaves!.slice().sort());
  });

  it('a cover property: covered, witness published', async () => {
    const model = await load(nested);
    const id = find(model, 'P::M').id;
    const v = checkProperty(model, id, prop({ pattern: 'cover', p: 'state a2' }));
    expect(v.claim).toBe('covered');
    expect(v.witness.length).toBeGreaterThan(1);
  });

  it('coupled regions whose shortest witness needs the other order: withheld, with the reason', async () => {
    // r2 reads n, r1 writes it: n == 1 holds for r2 only when r1 fires first (declaration order below puts r2 first).
    const src = `package P { item def f; state def M { attribute n : Integer = 0; entry; then p;
      state p parallel {
        state r2 { entry; then b1; state b1; state b2; transition t2 first b1 accept f if n == 1 then b2; }
        state r1 { entry; then a1; state a1; state a2 { entry assign n := 1; } transition t1 first a1 accept f then a2; }
      }
      state q; transition go first p accept g then q; } }`;
    const model = await load(src);
    const id = find(model, 'P::M').id;
    const v = checkProperty(model, id, prop({ pattern: 'absence', p: 'state b2' }));
    expect(v.claim).toBe('inconclusive');
    expect(v.code).toBe(WITNESS_NOT_REPLAYED_CODE);
    expect(v.detail).toContain('declaration order');
    expect(v.witness).toEqual([]);
  });

  it('the profile no longer says a witness is withheld on every parallel machine', () => {
    const f = SEMANTIC_PROFILE.find((x) => x.field === 'regions')!;
    expect(f.reading).toContain('replayed');
  });
});

// A machine that IS a parallel state: it opens at the composite with every region entered, so the witness's first
// configuration is the composite and the interpreter's is the regions' leaves.
const root = `package P { item def e1; item def e2; state def M { entry; then run;
  state run parallel {
    state r1 { entry; then a1; state a1; state a2; transition x first a1 accept e1 then a2; }
    state r2 { entry; then b1; state b1; state b2; transition y first b1 accept e2 then b2; }
  } } }`;
const rootId = async (src: string): Promise<[any, string]> => {
  const model = await load(src);
  return [model, find(model, 'P::M::run').id];
};

describe('a witness that opens at the parallel composite is replayed region by region', () => {
  it('absence of a region state: fail with the witness published; cover: covered', async () => {
    const [model, id] = await rootId(root);
    const f = checkProperty(model, id, prop({ pattern: 'absence', p: 'state a2' }));
    expect(f.claim).toBe('fail');
    expect(f.code).not.toBe(WITNESS_NOT_REPLAYED_CODE);
    expect(f.witness.length).toBe(2);
    const c = checkProperty(model, id, prop({ pattern: 'cover', p: 'state b2' }));
    expect(c.claim).toBe('covered');
  });

  it('a state no run enters: the absence passes (a replayed witness is not needed, none is invented)', async () => {
    const [model, id] = await rootId(root.replace('state b2;', 'state b2; state never;'));
    expect(checkProperty(model, id, prop({ pattern: 'absence', p: 'state never' })).claim).toBe('pass');
  });

  it('the coupled-order refusal still holds at a parallel root', async () => {
    const src = `package P { item def f; state def M { attribute n : Integer = 0; entry; then p;
      state p parallel {
        state r2 { entry; then b1; state b1; state b2; transition t2 first b1 accept f if n == 1 then b2; }
        state r1 { entry; then a1; state a1; state a2 { entry assign n := 1; } transition t1 first a1 accept f then a2; }
      } } }`;
    const model = await load(src);
    const id = find(model, 'P::M::p').id;
    const v = checkProperty(model, id, prop({ pattern: 'absence', p: 'state b2' }));
    expect(v.claim).toBe('inconclusive');
    expect(v.code).toBe(WITNESS_NOT_REPLAYED_CODE);
    expect(v.detail).toContain('declaration order');
  });
});

describe('Boolean atoms over state occupancy', () => {
  // r1 and r2 share n: each region takes its step only while n == 0 and sets it, so a2 and b2 are never both held.
  const excl = `package P { item def e1; item def e2; state def M { entry; then run; attribute n : Integer = 0;
    state run parallel {
      state r1 { entry; then a1; state a1; state a2 { entry assign n := 1; } transition x first a1 accept e1 if n == 0 then a2; }
      state r2 { entry; then b1; state b1; state b2 { entry assign n := 1; } transition y first b1 accept e2 if n == 0 then b2; }
    } } }`;

  it('`and`: reachable in the independent machine, unreachable in the exclusive one', async () => {
    const [m1, id1] = await rootId(root);
    expect(checkProperty(m1, id1, prop({ pattern: 'absence', p: 'state a2 and state b2' })).claim).toBe('fail');
    expect(checkProperty(m1, id1, prop({ pattern: 'cover', p: 'state a2 and state b2' })).claim).toBe('covered');
    const [m2, id2] = await rootId(excl);
    const v = checkProperty(m2, id2, prop({ pattern: 'absence', p: 'state a2 and state b2' }));
    expect(v.claim).toBe('pass');
    expect(checkProperty(m2, id2, prop({ pattern: 'absence', p: 'state a2' })).claim).toBe('fail');
    expect(checkProperty(m2, id2, prop({ pattern: 'cover', p: 'state a2 and state b2' })).claim).not.toBe('covered');
  });

  it('`or`, `not` and parentheses', async () => {
    const [m, id] = await rootId(excl);
    expect(checkProperty(m, id, prop({ pattern: 'universality', p: 'state a1 or state a2' })).claim).toBe('pass');
    expect(checkProperty(m, id, prop({ pattern: 'universality', p: 'state a1 or state b1' })).claim).toBe('pass');
    expect(checkProperty(m, id, prop({ pattern: 'universality', p: 'not state a2' })).claim).toBe('fail');
    expect(checkProperty(m, id, prop({ pattern: 'universality', p: 'not (state a2 and state b2)' })).claim).toBe('pass');
    expect(checkProperty(m, id, prop({ pattern: 'universality', p: 'state a1 and state b1' })).claim).toBe('fail');
    // precedence: `not` over `and` over `or`
    expect(checkProperty(m, id, prop({ pattern: 'absence', p: 'state a2 and state b2 or state a2 and not state a2' })).claim).toBe('pass');
  });

  it('the qualified `state r1::a2` resolves; an ambiguous or unknown name stays a refusal', async () => {
    const [m, id] = await rootId(excl);
    const q: any = readAtom(m, id, 'state r1::a2');
    expect(q.ok).toBe(true);
    expect(checkProperty(m, id, prop({ pattern: 'absence', p: 'state r1::a2' })).claim).toBe('fail');
    const dup = excl.replace('state b1; state b2', 'state b1; state a2');
    const [m3, id3] = await rootId(dup);
    const amb: any = readAtom(m3, id3, 'state a2 and state b1');
    expect(amb.ok).toBe(false);
    expect(amb.refusal.code).toBe(UNKNOWN_ATOM_CODE);
    expect((readAtom(m3, id3, 'state r1::a2') as any).ok).toBe(true);
    for (const bad of ['state a2 and state zz', 'state a2 and', 'not state zz', 'state a2 or (state b2', 'state r9::a2 or state a1']) {
      const v = checkProperty(m, id, prop({ pattern: 'absence', p: bad }));
      expect(v.claim, bad).toBe('inconclusive');
    }
    // a step leaf is not mixed in (an expression leaf is: see the mixed-formula block)
    for (const step of ['state a2 and trigger e1', 'state a2 or fires x', 'not state a2 and node a1']) {
      const r: any = readAtom(m, id, step);
      expect(r.ok, step).toBe(false);
      expect(r.refusal.code, step).toBe(UNKNOWN_ATOM_CODE);
      expect(checkProperty(m, id, prop({ pattern: 'absence', p: step })).claim, step).toBe('inconclusive');
    }
  });

  it('works under a scope and in a plain (non-parallel) machine, and a feature called `not` still reads as an expression', async () => {
    const [m, id] = await rootId(excl);
    const v = checkProperty(m, id, prop({ pattern: 'absence', scope: 'after', q: 'state a2', p: 'state b2 and state a2' } as any));
    expect(['pass', 'fail']).toContain(v.claim);
    const flat = await load(`package P { item def go; state def F { attribute k : Boolean = false; entry; then s1; state s1; state s2; transition t first s1 accept go then s2; } }`);
    const fid = find(flat, 'P::F').id;
    expect(checkProperty(flat, fid, prop({ pattern: 'absence', p: 'state s1 and state s2' })).claim).toBe('pass');
    expect(checkProperty(flat, fid, prop({ pattern: 'cover', p: 'not state s1' })).claim).toBe('covered');
    expect(checkProperty(flat, fid, prop({ pattern: 'universality', p: 'not k' })).claim).toBe('pass');
  });

  it('a formula is read by `recovery` as the plain atom is: the same census on a trigger-less machine', async () => {
    const m = await load(`package P { state def R { entry; then s1; state s1; state s2; state s3; transition a first s1 then s2; transition b first s2 then s3; } }`);
    const id = find(m, 'P::R').id;
    for (const [plain, formula] of [['state s3', 'state s3 or state s3'], ['state s1', 'not (not state s1)'], ['state s2', 'state s2 and not state s3']]) {
      const a = checkProperty(m, id, prop({ pattern: 'recovery', p: plain }));
      const b = checkProperty(m, id, prop({ pattern: 'recovery', p: formula }));
      expect(b.claim, formula).toBe(a.claim);
      expect(b.recovery?.targetConfigs, formula).toBe(a.recovery?.targetConfigs);
    }
  });
});

describe('mixed formulas: state leaves with expression leaves, in one configuration', () => {
  // a1 -> a2 on e1 sets n := n + 2 on entry; r2 independent. n reaches 2 exactly when a2 is active.
  const src = `package P { item def e1; item def e2; state def M { attribute n : Integer = 0; entry; then run;
    state run parallel {
      state r1 { entry; then a1; state a1; state a2 { entry assign n := 2; } transition x first a1 accept e1 then a2; }
      state r2 { entry; then b1; state b1; state b2; transition y first b1 accept e2 then b2; }
    } } }`;
  const chk = async (p: string, pattern = 'absence', text = src): Promise<string> => {
    const [m, id] = await rootId(text);
    return checkProperty(m, id, prop({ pattern, p })).claim;
  };

  it('and / or / not over a state leaf and an expression leaf', async () => {
    expect(await chk('state a2 and n == 2')).toBe('fail');
    expect(await chk('state a2 and n == 0')).toBe('pass'); // n is 2 wherever a2 is active
    expect(await chk('state a1 and n == 2')).toBe('pass');
    expect(await chk('state a1 or n == 2', 'universality')).toBe('pass'); // a1 or (a2 with n == 2)
    expect(await chk('state a1 or n == 3', 'universality')).toBe('fail');
    expect(await chk('not (state a2 and n == 2)', 'universality')).toBe('fail');
    expect(await chk('state b2 and n == 2', 'cover')).toBe('covered'); // independent regions: both advance
    expect(await chk('state a1 and n == 2', 'cover')).not.toBe('covered');
    expect(await chk('(state a2) and (n + 0) == 2')).toBe('fail'); // a group, then an expression starting with (
    expect(await chk('n > 1 and state b2')).toBe('fail');
  });

  it('a one-leaf formula agrees with the plain atom', async () => {
    for (const [plain, wrapped] of [['state a2', 'state a2 and true'], ['n == 2', 'state a1 or n == 2 or not state a1']] as const) {
      expect(await chk(wrapped), wrapped).toBe(await chk(plain));
    }
  });

  it('an expression leaf the evaluator cannot decide is inconclusive, never false or a pass', async () => {
    for (const bad of ['state a2 and zz == 1', 'state a1 or zz == 1', 'not (state a2 and zz == 1)', 'state a2 and n']) {
      for (const pattern of ['absence', 'universality']) {
        const c = await chk(bad, pattern);
        expect(c, `${pattern} ${bad}`).toBe('inconclusive');
      }
    }
    // an expression that does not parse is a malformed property, not a false leaf
    expect(await chk('state a2 and n == ')).toBe('inconclusive');
  });

  it('`recovery` withholds a formula that reads the store, as it does a plain expression', async () => {
    const [m, id] = await rootId(src);
    expect(checkProperty(m, id, prop({ pattern: 'recovery', p: 'state a2 and n == 2' })).claim).toBe('inconclusive');
  });
});
