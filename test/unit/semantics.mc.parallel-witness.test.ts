/**
 * Witnesses on a machine with a parallel state. A witness step is an event (or a completion); on concurrent regions it
 * fires one transition per region. The witness is published only when the interpreter fires the same transitions, in
 * declaration order, and stands in the same leaves; a witness that needs another order of coupled regions is withheld.
 */
import { describe, it, expect } from 'vitest';
import { loadModelText } from '@text/load';
import { runStateMachine } from '../../src/semantics/execute';
import { checkProperty, WITNESS_NOT_REPLAYED_CODE, type PropertyText } from '../../src/semantics/mc/patterns';
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
