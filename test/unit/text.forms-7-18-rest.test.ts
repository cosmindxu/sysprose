/**
 * The last §7.18 forms: `exhibit A::B :> C;` (§7.18.4), the `[g]` guard right after the accept name of the target-transition
 * shorthand (read as the long form reads it), and `do send …` (still refused, with the reason).
 */
import { describe, it, expect } from 'vitest';
import { loadModelText } from '@text/load';
import { serializeElement } from '@text/serializer';

const load = async (text: string): Promise<any> => loadModelText(text, { fileName: 'f.sysml' });
const codes = (r: any) => r.diagnostics.map((d: any) => d.code);
const W = (b: string) => `package P {\n item def E;\n attribute g : Boolean;\n attribute n : Integer;\n action eff;\n state def M {\n${b}\n }\n}\n`;
const ts = (m: any) => m.all().filter((e: any) => e.eClass === 'TransitionUsage' && !e.attrs.isLibrary);
const EX = `package Spec {
 state def VS parallel { state operating; state monitoring; }
 part def Vehicle { abstract exhibit state monitoringState; }
 part vehicle : Vehicle { exhibit VS::monitoring :> Vehicle::monitoringState; }
}`;

describe('exhibit A::B :> C;', () => {
  it('round-trips: the serialized text reads back with the same reference subsetting and subsetting', async () => {
    const a = await load(EX);
    expect(a.report.diagnostics).toEqual([]);
    const v = a.model.all().find((e: any) => a.model.qualifiedName(e.id) === 'Spec::vehicle');
    const text = serializeElement(a.model, v.id);
    const b = await load(`package Spec {\n state def VS parallel { state operating; state monitoring; }\n part def Vehicle { abstract exhibit state monitoringState; }\n${text}\n}`);
    expect(b.report.diagnostics).toEqual([]);
    const ex = b.model.all().find((e: any) => e.eClass === 'ExhibitStateUsage' && !e.declaredName);
    expect(b.model.children(ex.id).map((c: any) => c.eClass + '>' + c.target.map((t: string) => b.model.qualifiedName(t)))).toEqual([
      'ReferenceSubsetting>Spec::VS::monitoring',
      'Subsetting>Spec::Vehicle::monitoringState',
    ]);
  });
  it('a name beside it is still a named exhibit state (no chain, no reference subsetting)', async () => {
    const a = await load('package S { state def V { state a; } part p { exhibit state x :> V::a; } }');
    expect(a.report.diagnostics).toEqual([]);
    const x = a.model.all().find((e: any) => e.declaredName === 'x');
    expect(a.model.children(x.id).map((c: any) => c.eClass)).toEqual(['Subsetting']);
  });
});

describe('target-transition shorthand with [g]', () => {
  const pair = (short: string, long: string) => [
    W('entry; then off;\n state off; ' + short + '\n state on;'),
    W('entry; then a;\n state a; state on;\n transition t first a ' + long),
  ];
  it('refuses `accept E [g] then on;`: in SysML v2 `[g]` after the payload is a multiplicity, a guard is `if g` (the long form is refused the same way)', async () => {
    const [s, l] = pair('accept E [g] then on;', 'accept E [g] then on;');
    const a = await load(s);
    const b = await load(l);
    expect(codes(a.report)).toContain('mapper/state-form-unread');
    expect(ts(a.model)).toEqual([]);
    // The long form is refused too (2026-11-21 ruling: fence UML's `[g]`; write `if g`).
    expect(codes(b.report)).toContain('mapper/state-form-unread');
    expect(ts(b.model)).toEqual([]);
  });
  it('a numeric, star or range bracket stays a refused multiplicity; a bracket beside an `if` guard is refused', async () => {
    for (const m of ['[2]', '[1..3]', '[*]']) {
      const a = await load(W('entry; then off;\n state off; accept E ' + m + ' then on;\n state on;'));
      expect(codes(a.report)).toContain('mapper/state-form-unread');
      expect(ts(a.model)).toEqual([]);
    }
    const c = await load(W('entry; then off;\n state off; accept E [g] if n < 0 then on;\n state on;'));
    expect(codes(c.report)).toContain('mapper/state-form-unread');
    expect(ts(c.model)).toEqual([]);
  });
  it('re-probes: if-guard, time trigger, plain, entry assign, do x, do action x, calc if-else all read as before', async () => {
    const a = await load(W('entry; then off;\n state off;\n accept E if n < 0 then on;\n accept after 5[min] then on;\n accept E then on;\n state on;'));
    expect(a.report.diagnostics).toEqual([]);
    expect(ts(a.model).map((t: any) => [t.attrs.trigger, t.attrs.guard, t.attrs.timeTrigger])).toEqual([
      ['E', 'n < 0', undefined], [undefined, undefined, '5[min]'], ['E', undefined, undefined],
    ]);
    const l = await load(W('entry; then a;\n state a; state b;\n transition t first a accept E if n < 0 then b;'));
    expect(ts(l.model).map((t: any) => t.attrs.guard)).toEqual(['n < 0']);
    const e = await load(W('state s { entry assign n := 1; do eff; }\n state s2 { do action x; }'));
    expect(e.report.diagnostics.filter((d: any) => d.severity === 'error')).toEqual([]);
    const c = await load('package P { calc def C { in a : Boolean; in b : Boolean; in c : Boolean; if a then b else c } }');
    expect(c.report.diagnostics).toEqual([]);
  });
});

describe('do send …', () => {
  it('stays refused (state-form-unread), as an entry/do/exit action and as a transition effect', async () => {
    const a = await load(W('state s { do send new E() via p; }'));
    expect(codes(a.report)).toContain('mapper/state-form-unread');
    const b = await load(W('entry; then a;\n state a; state b;\n transition t first a accept E do send new E() via p then b;'));
    expect(codes(b.report)).toContain('mapper/state-form-unread');
    expect(ts(b.model)).toEqual([]);
  });
});
