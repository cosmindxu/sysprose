/** A parallel state nested in a machine is performed concurrently (§7.18.2); shapes not performed are refused with a reason. */
import { describe, it, expect } from 'vitest';
import { loadModelText } from '@text/load';
import { runStateMachine } from '../../src/semantics/execute';

const load = async (t: string) => loadModelText(t, { fileName: 'np.sysml' });
const find = (m: any, n: string) => m.all().find((e: any) => m.qualifiedName(e.id) === n);

const top = `package P { state def M parallel { state nav { entry; then n1; state n1; state n2; } state comms { entry; then c1; state c1; state c2; } } }\n`;
const nested = `package P { item def e; state def M { entry; then p; state p parallel { state r1; state r2; } state q; transition go first p accept e then q; } }\n`;

describe('nested parallel fence', () => {
  it('top-level parallel machine still runs', async () => {
    const { model: m } = await load(top) as any;
    const r = runStateMachine(m, find(m, 'P::M').id, []);
    expect(r.unopened).toBeUndefined();
  });
  it('nested parallel state is performed concurrently (stage 2): both regions active, no refusal', async () => {
    const { model: m } = await load(nested) as any;
    const r = runStateMachine(m, find(m, 'P::M').id, []);
    expect(r.unopened).toBeUndefined();
    expect(r.activeStates.map((s: string) => m.qualifiedName(s))).toEqual(['P::M::p::r1', 'P::M::p::r2']);
  });
  it('a region that is itself a parallel state is performed (every substate of it a region)', async () => {
    const src = `package P { item def e; state def M { entry; then p; state p parallel { state r1 parallel { state s1; state s2; } state r2; } state q; transition go first p accept e then q; } }\n`;
    const { model: m } = await load(src) as any;
    const r = runStateMachine(m, find(m, 'P::M').id, ['e']);
    expect(r.unopened).toBeUndefined();
    expect(r.activeStates.map((s: string) => m.qualifiedName(s))).toEqual(['P::M::q']);
  });
});
