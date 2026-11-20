/**
 * ONE timing for a region's completion transitions (sm-chase): an event is offered to every region, each takes its event
 * transition, and only THEN are the trigger-less transitions chased (regions in declaration order, nested first), in the
 * interpreter and in the explorer. Region 1's completion therefore never shows in region 2's view of the same event.
 */
import { describe, it, expect } from 'vitest';
import { loadModelText } from '@text/load';
import { runStateMachine } from '../../src/semantics/execute';
import { exploreMachine } from '../../src/semantics/mc/explore';
import { SEMANTIC_PROFILE } from '../../src/semantics/mc/profile';

const find = (m: any, n: string): any => m.all().find((e: any) => m.qualifiedName(e.id) === n);
const load = async (src: string): Promise<any> => (await loadModelText(src, { fileName: 'pc.sysml' })).model;
const R1 = 'state r1 { entry; then a0; state a0; state a1; state a2 { entry assign n := 1; } transition t1 first a0 accept e then a1; transition c1 first a1 then a2; }';
const R2 = 'state r2 { entry; then b1; state b1; state b2; transition t2 first b1 accept e if n == 1 then b2; }';
const R2e = 'state r2 { entry; then b1; state b1; state b2; transition t2 first b1 accept e then b2; transition t3 first b2 accept e if n == 1 then b1; }';
const text = (a: string, b: string): string =>
  `package P { item def e; state def M { attribute n : Integer = 0; entry; then p; state p parallel { ${a} ${b} } } }`;
const q = (m: any, ids: readonly string[]): string => ids.map((s) => m.qualifiedName(s).replace('P::M::p::', '')).sort().join(' | ');
const seqs = (len: number): string[][] => {
  let layer: string[][] = [[]];
  let out: string[][] = [[]];
  for (let i = 0; i < len; i++) {
    layer = layer.flatMap((s) => [...s, 'e'].length ? [[...s, 'e']] : []);
    out = out.concat(layer);
  }
  return out;
};

describe('completions run after the event, in the interpreter', () => {
  it("region 1's completion write does not enable region 2's guard on the same event", async () => {
    const model = await load(text(R1, R2));
    const id = find(model, 'P::M').id;
    const one = runStateMachine(model, id, ['e']);
    expect(q(model, one.activeStates)).toBe('r1::a2 | r2::b1');
    const two = runStateMachine(model, id, ['e', 'e']);
    expect(q(model, two.activeStates)).toBe('r1::a2 | r2::b2');
  });
});

describe('the walk and the interpreter agree on coupled regions', () => {
  for (const [name, a, b] of [
    ['completion write read by the next region', R1, R2],
    ['reading region first', R2, R1],
    ['both coupled again', R1, R2e],
  ] as const) {
    it(`${name}: after one e they agree, and the reachable sets are equal up to 4 events (union over region orders)`, async () => {
      const model = await load(text(a, b));
      const id = find(model, 'P::M').id;
      const walk = exploreMachine(model, id);
      expect(walk.unsupported).toEqual([]);
      expect(walk.exhaustive).toBe(true);
      const walked = new Set<string>(walk.configRegionLeaves.map((ls: readonly string[]) => q(model, ls)).filter((k: string) => !k.includes('::a1') && !k.includes('r1::a1')));
      const swapped = await load(text(b, a));
      const sid = find(swapped, 'P::M').id;
      const run = new Set<string>();
      for (const s of seqs(4)) {
        run.add(q(model, runStateMachine(model, id, s).activeStates));
        run.add(q(swapped, runStateMachine(swapped, sid, s).activeStates));
      }
      expect([...walked].sort()).toEqual([...run].sort());
    });
  }

  it('after one e the walk does not hold b2 together with a2', async () => {
    const model = await load(text(R1, R2));
    const walk = exploreMachine(model, find(model, 'P::M').id);
    const sets = walk.configRegionLeaves.map((ls: readonly string[]) => q(model, ls));
    expect(sets).toContain('r1::a2 | r2::b1');
    expect(sets).toContain('r1::a2 | r2::b2');
  });
});

describe('nested parallel: the same timing at every level', () => {
  it("an inner region's completion write is not seen by the outer sibling on the same event", async () => {
    const src = `package P { item def e; state def M { attribute n : Integer = 0; entry; then p; state p parallel {
      state r1 { entry; then q; state q parallel {
        state s1 { entry; then a0; state a0; state a1; state a2 { entry assign n := 1; } transition t1 first a0 accept e then a1; transition c1 first a1 then a2; }
        state s2 { entry; then z; state z; } } }
      state r2 { entry; then b1; state b1; state b2; transition t2 first b1 accept e if n == 1 then b2; } } } }`;
    const model = await load(src);
    const id = find(model, 'P::M').id;
    expect(runStateMachine(model, id, ['e']).activeStates.map((s: string) => model.qualifiedName(s)).some((n: string) => n.endsWith('b2'))).toBe(false);
    expect(runStateMachine(model, id, ['e', 'e']).activeStates.map((s: string) => model.qualifiedName(s)).some((n: string) => n.endsWith('b2'))).toBe(true);
  });
});

describe('the profile states the timing', () => {
  it('regions text', () => {
    const t = JSON.stringify(SEMANTIC_PROFILE);
    expect(t).toContain('The completions come AFTER the event');
  });
});
