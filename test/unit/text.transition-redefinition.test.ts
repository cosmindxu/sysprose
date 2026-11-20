/**
 * SysML v2: `transition t2 :>> t1 first a accept E then b;` (also `redefines`) is a transition that REDEFINES an
 * inherited one. It reads as the TransitionUsage plus a Redefinition to t1, the walk and the interpreter treat it as
 * REPLACING t1, it round-trips, and a target that does not resolve is reported, never dropped.
 */
import { describe, it, expect } from 'vitest';
import { loadModelText } from '@text/load';
import { serializeModel } from '@text/index';
import { runStateMachine } from '@semantics/index';
import { reachReport, machineStates } from '../../src/semantics/mc/explore';

const load = async (text: string): Promise<any> => loadModelText(text, { fileName: 'tr.sysml', library: 'none' });
const idOf = (m: any, qn: string): any => m.all().find((e: any) => m.qualifiedName(e.id) === qn)!.id;
const nameOf = (m: any, id: any): any => m.get(id)?.declaredName ?? null;

const base = `state s0; state s1; state s2; attribute n : Integer = 0;
  transition t1 first s0 accept a then s1;
  transition t0 first s1 accept b then s2;`;

function digest(model: any, machineId: any): unknown {
  const m = reachReport(model).machines.find((r: any) => r.machine.id === machineId)!;
  return {
    unsupported: m.unsupported.map((u: any) => u.construct),
    exhaustive: m.exhaustive,
    configs: m.configs,
    unreachable: m.states.unreachable.map((s: any) => s.name).sort(),
    dead: m.transitions.dead.map((t: any) => t.name).sort(),
    deadlocks: m.deadlocks.map((d: any) => [d.leaf.name, d.steps]).sort(),
    states: machineStates(model, machineId).map((s: any) => s.declaredName),
  };
}
const runs = (model: any, id: any): unknown =>
  [['a', 'b'], ['b', 'a', 'a'], ['c', 'a', 'b'], []].map((ev) => {
    const r = runStateMachine(model, id, ev);
    return [r.visited.map((v: any) => nameOf(model, v)), r.fired.map((f: any) => nameOf(model, f.transitionId)), nameOf(model, r.finalState)];
  });

describe('transition redefinition in text', () => {
  for (const op of [':>>', 'redefines']) {
    it(`\`${op}\` builds a Redefinition and the walk equals the hand-flattened twin`, async () => {
      const text = `package G { state def Base { ${base} } state def D :> Base { transition t2 ${op} t1 first s0 accept c then s2; } }`;
      const twin = `package G { state def Flat { ${base.replace('transition t1 first s0 accept a then s1;', '')} transition t2 first s0 accept c then s2; } }`;
      const r = await load(text);
      expect(r.report.diagnostics.filter((d: any) => d.severity === 'error')).toEqual([]);
      const m = r.model;
      const t2 = m.get(idOf(m, 'G::D::t2'));
      const red = m.children(t2.id).filter((e: any) => e.eClass === 'Redefinition');
      expect(red).toHaveLength(1);
      expect(red[0].target[0]).toBe(idOf(m, 'G::Base::t1'));
      const flat = (await load(twin)).model;
      const d = digest(m, idOf(m, 'G::D'));
      expect((d as any).unsupported).toEqual([]);
      const f: any = digest(flat, idOf(flat, 'G::Flat'));
      expect(d).toEqual({ ...f });
      expect(runs(m, idOf(m, 'G::D'))).toEqual(runs(flat, idOf(flat, 'G::Flat')));
    });
  }

  it('keeps the guard / time-trigger / shorthand forms parsing, and round-trips with the model equal', async () => {
    const text = `package G {
      state def Base { ${base} }
      state def D :> Base { transition t2 :>> t1 first s0 accept c if n < 1 then s2; transition t3 first s1 accept after 5[min] then s0; }
      state def S { state off; accept E then on; state on; transition t first on accept E if n < 0 then off; attribute n : Integer; }
    }`;
    const r = await load(text);
    expect(r.report.diagnostics.filter((d: any) => d.severity === 'error')).toEqual([]);
    const out = serializeModel(r.model);
    expect(out).toContain('transition t2 :>> t1 first s0');
    const r2 = await load(out);
    expect(r2.report.diagnostics.filter((d: any) => d.severity === 'error')).toEqual([]);
    expect(serializeModel(r2.model)).toBe(out);
    const sig = (mm: any): unknown =>
      mm
        .all()
        .filter((e: any) => e.eClass === 'TransitionUsage' || e.eClass === 'Redefinition')
        .map((e: any) => [mm.qualifiedName(e.id), e.eClass, e.attrs.trigger, e.attrs.guard, e.attrs.timeTrigger, (e.target ?? []).map((t: any) => mm.qualifiedName(t))]);
    expect(sig(r2.model)).toEqual(sig(r.model));
  });

  it('an unresolved target keeps a diagnostic', async () => {
    const r = await load(`package G { state def Base { ${base} } state def D :> Base { transition t2 :>> nope first s0 accept c then s2; } }`);
    expect(r.report.diagnostics.some((d: any) => /nope/.test(d.message))).toBe(true);
  });
});

describe('a specialization other than a redefinition on a transition', () => {
  it('is refused, not read as nothing', async () => {
    const text = 'package P { item def E; state def M { entry; then a; state a; state b; transition t1 first a accept E then b; transition t2 :> t1 first b accept E then a; } }';
    const r: any = await loadModelText(text, { fileName: 'x.sysml' });
    expect(r.report.diagnostics.map((d: any) => d.code)).toContain('mapper/state-form-unread');
  });
});
