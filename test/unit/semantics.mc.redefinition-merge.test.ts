/**
 * T-115 (merge): `state r :>> s { ... }` over an `s` that holds substates and steps merges them with r's own body; each
 * case equals its FLATTENED twin written out by hand, on the walk (reach) and the interpreter (`runStateMachine` on
 * random trigger lists) alike. What the view does not read stays a `machine-boundary` with its reason.
 */
import { describe, it, expect } from 'vitest';
import { ModelFactory, type ElementId, type Model } from '@core/index';
import { runStateMachine } from '@semantics/index';
import { loadModelText } from '@text/load';
import { machineStates, reachReport } from '../../src/semantics/mc/explore';
import { behaviourReport } from '../../src/semantics/mc/patterns';

let seed = 1150;
const rnd = (n: number): number => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return (seed >> 8) % n;
};
const pick = <T,>(xs: readonly T[]): T => xs[rnd(xs.length)];

interface Step {
  name: string;
  from: string;
  to: string;
  trig: string;
  guard: string | null;
  effect: string | null;
}
const stepText = (t: Step): string =>
  `transition ${t.name} first ${t.from} accept ${t.trig}${t.guard ? ` if ${t.guard}` : ''} then ${t.to};`;
let counter = 0;
const mkStep = (froms: string[], tos: string[], attrs: string[], prefix = 't'): Step => ({
  name: `${prefix}${counter++}`,
  from: pick(froms),
  to: pick(tos),
  trig: pick(['a', 'b']),
  guard: rnd(2) === 0 ? null : `${pick(attrs)} ${pick(['<', '>', '=='])} ${rnd(4)}`,
  effect: rnd(3) === 0 ? `${pick(attrs)} = ${pick(attrs)} + 1` : null,
});

const load = async (text: string, steps: readonly Step[]): Promise<Model> => {
  const model = (await loadModelText(text, { fileName: 'redef.sysml', library: 'none' })).model;
  expect(model, text).toBeDefined();
  for (const e of steps) {
    if (e.effect === null) continue;
    const el = model!.all().find((r) => r.eClass === 'TransitionUsage' && r.declaredName === e.name);
    expect(el, `${e.name} in ${text}`).toBeDefined();
    model!.setAttrs(el!.id, { effect: e.effect });
  }
  return model!;
};
const idOf = (m: Model, qn: string): ElementId => m.all().find((e) => m.qualifiedName(e.id) === qn)!.id;
const nameOf = (model: Model, id: ElementId | undefined | null): string | null => (id == null ? null : (model.get(id)?.declaredName ?? null));

function digest(model: Model, machineId: ElementId): unknown {
  const m = reachReport(model).machines.find((r) => r.machine.id === machineId)!;
  if (!m) throw new Error("no machine: " + model.qualifiedName(machineId));
  const claims: Record<string, unknown> = {};
  for (const s of machineStates(model, machineId)) {
    for (const pattern of ['absence', 'cover'] as const) {
      const v = behaviourReport(model, {
        machineId,
        pattern: `pattern=${pattern}, scope=globally, p=state ${s.declaredName}`,
      }).properties.at(-1)!;
      claims[`${pattern} ${s.declaredName}`] = [v.claim, v.code, v.witness.map((w) => [w.event, nameOf(model, w.transition?.id), w.leaf?.name ?? null])];
    }
  }
  return {
    unsupported: m.unsupported.map((u) => u.construct),
    exhaustive: m.exhaustive,
    configs: m.configs,
    unreachable: m.states.unreachable.map((s) => s.name).sort(),
    dead: m.transitions.dead.map((t) => t.name).sort(),
    deadlocks: m.deadlocks.map((d) => [d.leaf.name, d.steps]).sort(),
    choices: m.nondeterminism.map((n) => [n.state.name, n.event, n.taken.name, n.notTaken.map((t) => t.name).sort()]).sort(),
    claims,
  };
}
function runs(model: Model, machineId: ElementId, lists: string[][]): unknown {
  return lists.map((events) => {
    const r = runStateMachine(model, machineId, events);
    return [r.visited.map((v) => nameOf(model, v)), r.fired.map((f) => nameOf(model, f.transitionId)), nameOf(model, r.finalState), [...r.valueStore].sort()];
  });
}
const lists = (): string[][] => Array.from({ length: 20 }, () => Array.from({ length: rnd(5) }, () => pick(['a', 'b'])));

async function same(text: string, qn: string, twinText: string, steps: readonly Step[], where: string): Promise<void> {
  const model = await load(text, steps);
  const twin = await load(twinText, steps);
  const l = lists();
  const a = idOf(model, qn);
  const b = idOf(twin, 'G::Flat');
  expect((digest(model, a) as { unsupported: unknown[] }).unsupported, where).toEqual([]);
  expect(digest(model, a), where).toEqual(digest(twin, b));
  expect(runs(model, a, l), `${where}\nruns`).toEqual(runs(twin, b, l));
}

const refusedAs = async (text: string, qn: string, constructs: string[] = ['machine-boundary']): Promise<string> => {
  const model = (await loadModelText(text, { fileName: 'redef.sysml', library: 'none' })).model!;
  const m = reachReport(model).machines.find((r) => r.machine.id === idOf(model, qn));
  expect(m, text).toBeDefined();
  expect(m!.unsupported.map((u) => u.construct), text).toEqual(expect.arrayContaining(constructs));
  expect(m!.exhaustive, text).toBe(false);
  return m!.unsupported.map((u) => u.detail).join(' | ');
};

describe('a state redefined over one that holds substates and steps merges both (T-115)', () => {
  it('equals its flattened twin: s members first, then r own (def and typed)', async () => {
    for (let i = 0; i < 40; i++) {
      counter = 0;
      const attrs = ['n'];
      const outer = ['s0', 's1'];
      const inner = ['i1', 'i2', 'i3'].slice(0, 2 + rnd(2));
      const baseSteps = Array.from({ length: 1 + rnd(3) }, () => mkStep([...outer, 'x'], [...outer, 'x'], attrs));
      const sSteps = Array.from({ length: 1 + rnd(3) }, () => mkStep(inner, rnd(3) === 0 ? [...inner, 's0'] : inner, attrs, 'ti'));
      const sBody = `${inner.map((s) => `state ${s};`).join(' ')} ${sSteps.map(stepText).join('\n')}`;
      const rEntry0 = rnd(3) === 0;
      const rOwn = rEntry0 && rnd(2) === 0 ? '' : 'state j;';
      const rEntry = rEntry0 ? 'entry action e0;' : '';
      const outerSteps = Array.from({ length: 1 + rnd(3) }, () => mkStep(['r', ...outer], ['r', ...outer], attrs, 'to'));
      const all = [...baseSteps, ...sSteps, ...outerSteps];
      const typed = i % 2 === 1;
      const nVal = rnd(3);
      const baseBody = `attribute n : Integer = ${nVal};\n${outer.map((s) => `state ${s};`).join('\n')}\nstate x { ${sBody} }\n${baseSteps.map(stepText).join('\n')}`;
      const ownBody = [`state r :>> x { ${rEntry} ${rOwn} }`, ...outerSteps.map(stepText)].join('\n');
      const text = `package G {\nstate def Base {\n${baseBody}\n}\n${typed ? `part def H { exhibit state m : Base {\n${ownBody}\n} }` : `state def Derived :> Base {\n${ownBody}\n}`}\n}`;
      const ren = (t: Step): Step => ({ ...t, from: t.from === 'x' ? 'r' : t.from, to: t.to === 'x' ? 'r' : t.to });
      const flat = `package G { state def Flat {\nattribute n : Integer = ${nVal};\n${outer.map((s) => `state ${s};`).join('\n')}\nstate r { ${sBody} ${rEntry} ${rOwn} }\n${baseSteps.map((t) => stepText(ren(t))).join('\n')}\n${outerSteps.map(stepText).join('\n')}\n} }`;
      await same(text, typed ? 'G::H::m' : 'G::Derived', flat, all, `#${i}\n${text}\n---\n${flat}`);
    }
  }, 600_000);

  it('stays refused, with the reason: s holds an entry action, a name is held twice, a nested redefinition', async () => {
    const entry = await refusedAs(
      `package G { state def A { state s0 { entry action e0; state in0; } state s1; transition t0 first s0 accept a then s1; }
        state def D :> A { state r :>> s0 { state in1; } transition tz first r accept b then s1; } }`,
      'G::D',
    );
    expect(entry).toContain('something other than substates and steps');
    const twice = await refusedAs(
      `package G { state def A { state s0 { state in0; } state s1; transition t0 first s0 accept a then s1; }
        state def D :> A { state r :>> s0 { state in0; } transition tz first r accept b then s1; } }`,
      'G::D',
    );
    expect(twice).toContain('already holds');
    await refusedAs(
      `package G { state def A { state s0 { state in0; } state s1; transition t0 first s0 accept a then s1; }
        state def D :> A { state r :>> s0 { state in1 :>> in0; } transition tz first r accept b then s1; } }`,
      'G::D',
    );
  });
});
