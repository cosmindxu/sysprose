/**
 * SysML v2 Part 1 §7.18.2-7.18.4 (States): every code example of the spec, VERBATIM, each wrapped in `package Spec { … }`
 * with only the declarations the spec defines elsewhere that the example names (said in a comment on each). For each
 * example the test pins either that it loads and what the model reads, or that it is refused with a stated diagnostic
 * naming the form (never a dropped clause, a wrong source or target, a lost guard), and what the interpreter
 * (`runStateMachine`) and the walk (`exploreMachine`) do with it: run/walk it, or refuse with a reason.
 */
import { describe, it, expect } from 'vitest';
import { loadModelText } from '@text/load';
import { serializeElement } from '@text/serializer';
import { runStateMachine } from '../../src/semantics/execute';
import { exploreMachine } from '../../src/semantics/mc/explore';

const load = async (src: string): Promise<any> => loadModelText(src, { fileName: 'spec-7-18.sysml' });
const find = (m: any, n: string): any => m.all().find((e: any) => m.qualifiedName(e.id) === n);
const codes = (r: any): string[] => r.diagnostics.map((d: any) => d.code);
/** `port commPort;` is written with no direction in the spec, so `validation/port-direction` is the one warning allowed. */
const stray = (r: any): any[] => r.diagnostics.filter((d: any) => d.code !== 'validation/port-direction');
const trans = (m: any, owner: string): any[] =>
  m.all().filter((e: any) => e.eClass === 'TransitionUsage' && !e.attrs.isLibrary && m.qualifiedName(e.id).startsWith(`${owner}::`));
const tr = (m: any, n: string): any => find(m, n);
const ends = (m: any, t: any): [string[], string[]] => [(t.source ?? []).map((i: string) => m.qualifiedName(i)), (t.target ?? []).map((i: string) => m.qualifiedName(i))];
const run = async (src: string, def: string) => {
  const l = await load(src);
  const id = find(l.model, def).id;
  return { l, id, run: runStateMachine(l.model, id, []) as any, walk: exploreMachine(l.model, id) as any };
};
const constructs = (w: any): string[] => w.unsupported.map((u: any) => u.construct);

// The spec text. Declarations the spec defines elsewhere, added only so the names resolve, are marked in each comment.
const EX: Record<string, string> = {
Exercising: `package Spec {
 action def WarmUp; action def Exercise; action def Cooldown;
 state def Exercising {
   entry action warmup : WarmUp;
   do action exercise : Exercise {
     action strengthTraining;
     then action cardioTraining;
   }
   exit action cooldown : Cooldown;
 }
}`,
Operating: `package Spec {
 attribute def StateCodes; part def Controller; item def ReadySignal;
 state def Operating {
   entry assign stateCode := StateCodes::Operating;
   do send new ReadySignal() to Controller;
 }
}`,
TurnedOn: `package Spec {
 action monitorTemperature;
 state def TurnedOn {
   // This is an empty entry action.
   entry;
   // The following is equivalent to
   // do action references monitorTemperature;
   do monitorTemperature;
 }
}`,
Op1: `package Spec {
 state def OperationalStates {
   entry action initial;
   then off;
   // The above shorthand is equivalent to
   // first initial then off;
   state off;
   state starting;
   state on;
 }
}`,
Op2: `package Spec {
 state def OperationalStates {
   entry action initial { out attribute isStarting : Boolean; }
   if not initial.isStarting then off;
   if initial.isStarting then starting;
   state off;
   state starting;
   state on;
 }
}`,
VehicleStates: `package Spec {
 state def HealthStates;
 state def OperationalStates;
 state def VehicleStates parallel {
   // These substates are performed concurrently.
   state OperationalStates;
   state HealthStates;
 }
}`,
OnOff1: `package Spec {
 state def OnOff1 {
   entry;
   then off;
   state off;
   state on;
   transition off_on first off then on;
   transition on_off first on then off;
 }
}`,
OnOff2: `package Spec {
 item def TurnOn;
 state def OnOff2 {
   port commPort;
   entry;
   then off;
   state off;
   state on;
   transition off_on
     first off
     accept TurnOn via commPort
     then on;
   transition on_off
     first on
     accept after 5[min]
     then off;
 }
}`,
OnOff3: `package Spec {
 item def TurnOn;
 state def OnOff3 {
   in attribute isInitOff : Boolean;
   in attribute isEnabled : Boolean;
   port commPort;
   entry action init;
   transition first init if isInitOff then off;
   transition first init if not isInitOff then on;
   state off;
   state on;
   transition off_on
     first off
     accept TurnOn via commPort
     if isEnabled
     then on;
   transition on_off
     first on
     accept after 5[min]
     if isEnabled
     then off;
 }
}`,
OnOff4: `package Spec {
 item def TurnOn;
 action def PowerUp;
 item def TimeoutSignal;
 state def OnOff4 {
   in attribute isInitOff;
   in attribute isEnabled;
   port commPort;
   entry action init;
   transition first init if isInitOff then off;
   transition first init if not isInitOff then on;
   state off;
   state on;
   transition off_on
     first off
     if isEnabled
     accept TurnOn via commPort
     do action powerUp : PowerUp;
     then on;
   transition on_off
     first on
     if isEnabled
     accept after 5[min]
     do send new TimeoutSignal() via commPort
     then off;
 }
}`,
OnOff5: `package Spec {
 item def TurnOn;
 action def PowerUp;
 item def TimeoutSignal;
 state def OnOff5 {
   in attribute isInitOff;
   in attribute isEnabled;
   port commPort;
   entry;
     if isInitOff then off;
     if not isInitOff then on;
   state off;
   accept TurnOn via commPort
     if isEnabled
     do action powerUp : PowerUp;
     then on;
   state on;
   accept after 5[min]
     if isEnabled
     do send new TimeoutSignal() via commPort;
     then off;
 }
}`,
OnOff6: `package Spec {
 item def TurnOn;
 item def Abort;
 state def OnOff6 {
   port commPort;
   entry; then off;
   state off;
   accept TurnOn via commPort then on;
   accept Abort via commPort then stop;
   state on;
   accept after 5[min] then done;
   action stop terminate;
 }
}`,
Vehicle: `package Spec {
 state def VehicleStates parallel { state operating; state monitoring; }
 part def Vehicle {
   exhibit state operatingState references VehicleStates::operating;
   abstract exhibit state monitoringState; // Exhibited state is itself.
 }
}`,
VehicleEx: `package Spec {
 state def VehicleStates parallel { state operating; state monitoring; }
 part def Vehicle {
   exhibit state operatingState references VehicleStates::operating;
   abstract exhibit state monitoringState; // Exhibited state is itself.
 }
 part vehicle : Vehicle {
   // The exhibited state is VehicleActions::monitoring.
   exhibit VehicleStates::monitoring :> Vehicle::monitoringState;
 }
}`,
};
// Added around the spec text (each is declared elsewhere in the spec or is only a name the example refers to):
//   Exercising: `action def WarmUp; Exercise; Cooldown` (the types of its entry/do/exit actions).
//   Operating:  `attribute def StateCodes`, `part def Controller`, `item def ReadySignal` (named by the assign and the send);
//               `stateCode` is NOT declared: the spec example assigns to it as written.
//   TurnedOn:   none (`action monitorTemperature;` is part of the example).
//   Op1/Op2 (the two OperationalStates): none. VehicleStates: `state def HealthStates; state def OperationalStates;`.
//   OnOff2-OnOff6: `item def TurnOn/Abort/TimeoutSignal`, `action def PowerUp` (the spec's own lines where it gives them).
//   Vehicle: `state def VehicleStates parallel { state operating; state monitoring; }` (the exhibited states).

describe('§7.18.2 state definitions', () => {
  it('Exercising: loads clean; entry, do (with its two steps) and exit actions kept with their types; run and walk', async () => {
    const r = await run(EX.Exercising, 'Spec::Exercising');
    expect(r.l.report.diagnostics).toEqual([]);
    const m = r.l.model;
    const phase = (n: string) => find(m, `Spec::Exercising::${n}`);
    expect([phase('warmup').attrs.stateSubaction, phase('exercise').attrs.stateSubaction, phase('cooldown').attrs.stateSubaction]).toEqual(['entry', 'do', 'exit']);
    expect(find(m, 'Spec::Exercising::exercise::strengthTraining')).toBeDefined();
    expect(find(m, 'Spec::Exercising::exercise::cardioTraining').attrs.succession).toBe('then');
    const typed = (n: string) => m.children(phase(n).id).filter((c: any) => c.eClass === 'FeatureTyping').flatMap((c: any) => c.target.map((t: string) => m.qualifiedName(t)));
    expect([typed('warmup'), typed('exercise'), typed('cooldown')]).toEqual([['Spec::WarmUp'], ['Spec::Exercise'], ['Spec::Cooldown']]);
    expect(r.run.unopened).toBeUndefined();
    expect(r.walk.exhaustive).toBe(true);
  });

  it('Operating: `do send new ReadySignal() to Controller;` is refused (state-form-unread, names `do send`); the entry assign is read; run and walk refuse over the unresolvable stateCode', async () => {
    const r = await run(EX.Operating, 'Spec::Operating');
    const d = r.l.report.diagnostics;
    expect(d.map((x: any) => x.code)).toEqual(['mapper/state-form-unread']);
    expect(d[0].message).toMatch(/`do send …`/);
    const m = r.l.model;
    expect(m.all().filter((e: any) => e.eClass === 'ActionUsage' && e.attrs.stateSubaction === 'do')).toEqual([]);
    expect(m.all().filter((e: any) => e.eClass === 'AssignmentActionUsage' && !e.attrs.isLibrary)).toHaveLength(1);
    expect(r.run.unopened).toMatch(/stateCode.*cannot evaluate/);
    expect(r.walk.exhaustive).toBe(false);
    expect(constructs(r.walk)).toEqual(['state-effect']);
  });

  it('TurnedOn: `entry;` is an empty entry action and `do monitorTemperature;` a reference to that action; run and walk', async () => {
    const r = await run(EX.TurnedOn, 'Spec::TurnedOn');
    expect(r.l.report.diagnostics).toEqual([]);
    const m = r.l.model;
    const kids = m.children(find(m, 'Spec::TurnedOn').id).filter((c: any) => c.attrs.stateSubaction !== undefined);
    const entry = kids.find((c: any) => c.attrs.stateSubaction === 'entry');
    const doRef = kids.find((c: any) => c.attrs.stateSubaction === 'do');
    expect(m.children(entry.id)).toEqual([]);
    expect(doRef.attrs.stateSubactionRef).toBe(true);
    const target = m.children(doRef.id).filter((c: any) => c.eClass === 'Subsetting').flatMap((c: any) => c.target.map((t: string) => m.qualifiedName(t)));
    expect(target).toEqual(['Spec::monitorTemperature']);
    expect(r.run.unopened).toBeUndefined();
    expect(r.walk.exhaustive).toBe(true);
  });

  it('OperationalStates (entry action initial; then off;): loads clean; the start is off; run and walk', async () => {
    const r = await run(EX.Op1, 'Spec::OperationalStates');
    expect(r.l.report.diagnostics).toEqual([]);
    const m = r.l.model;
    const start = m.all().find((e: any) => e.eClass === 'Succession' && e.attrs.entryTransition);
    expect(start.source.map((i: string) => m.qualifiedName(i))).toEqual(['Spec::OperationalStates::initial']);
    expect(start.target.map((i: string) => m.qualifiedName(i))).toEqual(['Spec::OperationalStates::off']);
    expect(r.run.unopened).toBeUndefined();
    expect(r.walk.exhaustive).toBe(true);
  });

  it('OperationalStates (conditional successions): `initial.isStarting` guards kept; run and walk refuse the guarded start', async () => {
    const r = await run(EX.Op2, 'Spec::OperationalStates');
    expect(r.l.report.diagnostics).toEqual([]);
    const m = r.l.model;
    const starts = m.all().filter((e: any) => e.eClass === 'Succession' && e.attrs.entryTransition);
    expect(starts.map((s: any) => s.attrs.guard)).toEqual(['not initial.isStarting', 'initial.isStarting']);
    expect(starts.map((s: any) => s.target.map((i: string) => m.qualifiedName(i)))).toEqual([['Spec::OperationalStates::off'], ['Spec::OperationalStates::starting']]);
    const entry = find(m, 'Spec::OperationalStates::initial');
    expect(m.children(entry.id).map((c: any) => m.qualifiedName(c.id))).toContain('Spec::OperationalStates::initial::isStarting');
    expect(r.run.unopened).toMatch(/does not start/);
    expect(r.walk.exhaustive).toBe(false);
    expect(constructs(r.walk)).toContain('edge-not-walked');
  });

  it('VehicleStates parallel: loads clean; both substates kept; the walk runs or refuses with a reason', async () => {
    const r = await run(EX.VehicleStates, 'Spec::VehicleStates');
    expect(r.l.report.diagnostics).toEqual([]);
    expect(find(r.l.model, 'Spec::VehicleStates').attrs.isParallel).toBe(true);
    expect(find(r.l.model, 'Spec::VehicleStates::OperationalStates')).toBeDefined();
    expect(find(r.l.model, 'Spec::VehicleStates::HealthStates')).toBeDefined();
    expect(r.run.unopened ?? '').toBe('');
    expect(r.walk.exhaustive === true || r.walk.unsupported.length > 0).toBe(true);
  });
});

describe('§7.18.3 transition usages', () => {
  it('OnOff1: loads clean; entry then off; two transitions; run and walk', async () => {
    const r = await run(EX.OnOff1, 'Spec::OnOff1');
    expect(r.l.report.diagnostics).toEqual([]);
    const m = r.l.model;
    expect(trans(m, 'Spec::OnOff1').map((t) => [t.declaredName, ...ends(m, t).map((e) => e[0].replace('Spec::OnOff1::', ''))])).toEqual([
      ['off_on', 'off', 'on'],
      ['on_off', 'on', 'off'],
    ]);
    expect(r.run.unopened).toBeUndefined();
    expect(r.walk.exhaustive).toBe(true);
  });

  it('OnOff2: two transitions; off_on trigger TurnOn via commPort; on_off timeTrigger 5[min]; run and walk refuse the time trigger', async () => {
    const r = await run(EX.OnOff2, 'Spec::OnOff2');
    expect(stray(r.l.report)).toEqual([]);
    const m = r.l.model;
    expect(trans(m, 'Spec::OnOff2')).toHaveLength(2);
    const a = tr(m, 'Spec::OnOff2::off_on');
    const b = tr(m, 'Spec::OnOff2::on_off');
    expect([a.attrs.trigger, a.attrs.via, a.attrs.timeTrigger]).toEqual(['TurnOn', 'commPort', undefined]);
    expect([b.attrs.timeTrigger, b.attrs.trigger]).toEqual(['5[min]', undefined]);
    expect([ends(m, a), ends(m, b)]).toEqual([
      [['Spec::OnOff2::off'], ['Spec::OnOff2::on']],
      [['Spec::OnOff2::on'], ['Spec::OnOff2::off']],
    ]);
    expect(r.run.unopened).toMatch(/time trigger/);
    expect(r.walk.exhaustive).toBe(false);
    expect(constructs(r.walk)).toEqual(['edge-not-walked']);
  });

  it('OnOff2 round-trips with its `via` and its time trigger', async () => {
    const { model } = await load(EX.OnOff2);
    const out = serializeElement(model, find(model, 'Spec').id);
    expect(out).toContain('transition off_on first off accept TurnOn via commPort then on;');
    expect(out).toContain('transition on_off first on accept after 5[min] then off;');
  });

  it('OnOff3: the two entry transitions keep their guards; off_on and on_off keep accepter and guard; run and walk refuse', async () => {
    const r = await run(EX.OnOff3, 'Spec::OnOff3');
    expect(stray(r.l.report)).toEqual([]);
    const m = r.l.model;
    const all = trans(m, 'Spec::OnOff3');
    expect(all).toHaveLength(4);
    const fromInit = all.filter((t) => ends(m, t)[0][0] === 'Spec::OnOff3::init');
    expect(fromInit.map((t) => [t.attrs.guard, ends(m, t)[1][0]])).toEqual([
      ['isInitOff', 'Spec::OnOff3::off'],
      ['not isInitOff', 'Spec::OnOff3::on'],
    ]);
    const a = tr(m, 'Spec::OnOff3::off_on');
    const b = tr(m, 'Spec::OnOff3::on_off');
    expect([a.attrs.trigger, a.attrs.via, a.attrs.guard]).toEqual(['TurnOn', 'commPort', 'isEnabled']);
    expect([b.attrs.timeTrigger, b.attrs.guard]).toEqual(['5[min]', 'isEnabled']);
    expect(r.run.unopened).toMatch(/does not start/);
    expect(r.walk.exhaustive).toBe(false);
    expect(constructs(r.walk)).toContain('edge-not-walked');
  });

  it('OnOff4: the guard written BEFORE the accepter is read the same; the typed effect is kept; the `do send` transition is refused', async () => {
    const r = await run(EX.OnOff4, 'Spec::OnOff4');
    expect(stray(r.l.report).map((d: any) => d.code)).toEqual(['mapper/state-form-unread']);
    expect(stray(r.l.report)[0].message).toMatch(/`do send …`/);
    const m = r.l.model;
    const a = tr(m, 'Spec::OnOff4::off_on');
    expect([a.attrs.trigger, a.attrs.via, a.attrs.guard, a.attrs.effect, a.attrs.effectType]).toEqual(['TurnOn', 'commPort', 'isEnabled', 'powerUp', 'PowerUp']);
    expect(ends(m, a)).toEqual([['Spec::OnOff4::off'], ['Spec::OnOff4::on']]);
    // the refused transition is not in the model at all: nothing half-read is left for a check to trust
    expect(tr(m, 'Spec::OnOff4::on_off')).toBeUndefined();
    expect(trans(m, 'Spec::OnOff4')).toHaveLength(3);
    expect(r.run.unopened).toMatch(/does not start/);
    expect(r.walk.exhaustive).toBe(false);
  });

  it('the clause order does not matter: accept, if, do before or after each other read the same transition', async () => {
    const body = (clauses: string) => `package Spec { item def E; action def PowerUp; state def M { in attribute g : Boolean; entry; then a; state a; state b; transition t first a ${clauses} then b; } }`;
    const reads = [
      'if g accept E do action p : PowerUp;',
      'accept E if g do action p : PowerUp;',
      'do action p : PowerUp; accept E if g',
    ];
    const seen: any[] = [];
    for (const c of reads) {
      const { model, report } = await load(body(c));
      expect(report.diagnostics).toEqual([]);
      const t = tr(model, 'Spec::M::t');
      seen.push([t.attrs.trigger, t.attrs.guard, t.attrs.effect, t.attrs.effectType]);
    }
    expect(seen).toEqual([['E', 'g', 'p', 'PowerUp'], ['E', 'g', 'p', 'PowerUp'], ['E', 'g', 'p', 'PowerUp']]);
  });

  it('a typed effect over an EMPTY action definition does nothing to the store: the walk and the run go on', async () => {
    const src = 'package Spec { item def E; action def PowerUp; state def M { entry; then a; state a; state b; transition t first a accept E do action p : PowerUp then b; } }';
    const l = await load(src);
    const id = find(l.model, 'Spec::M').id;
    expect(l.report.diagnostics).toEqual([]);
    const run1 = runStateMachine(l.model, id, ['E']) as any;
    expect(run1.unopened).toBeUndefined();
    expect(run1.fired.map((f: any) => f.trigger)).toEqual(['E']);
    expect(exploreMachine(l.model, id).unsupported).toEqual([]);
  });

  it('a typed effect over a definition with a body, or one that does not resolve, is refused by the run and the walk', async () => {
    for (const defn of ['action def PowerUp { assign n := 1; }', '']) {
      const src = `package Spec { item def E; ${defn} state def M { attribute n : Integer = 0; entry; then a; state a; state b; transition t first a accept E do action p : PowerUp then b; } }`;
      const l = await load(src);
      const id = find(l.model, 'Spec::M').id;
      expect((runStateMachine(l.model, id, ['E']) as any).unopened).toMatch(/PowerUp/);
      const w = exploreMachine(l.model, id);
      expect(w.exhaustive).toBe(false);
      expect(constructs(w)).toContain('state-effect');
    }
  });

  it('OnOff5: the transition out of off keeps accepter, via, guard, typed effect and its `then on;` target; the one out of on (do send) is refused whole', async () => {
    const r = await run(EX.OnOff5, 'Spec::OnOff5');
    expect(stray(r.l.report).map((d: any) => d.code)).toEqual(['mapper/state-form-unread']);
    expect(stray(r.l.report)[0].message).toMatch(/accept after.*`do send …`/);
    const m = r.l.model;
    const all = trans(m, 'Spec::OnOff5');
    expect(all).toHaveLength(1);
    const t = all[0];
    expect([t.attrs.trigger, t.attrs.via, t.attrs.guard, t.attrs.effect, t.attrs.effectType]).toEqual(['TurnOn', 'commPort', 'isEnabled', 'powerUp', 'PowerUp']);
    expect(ends(m, t)).toEqual([['Spec::OnOff5::off'], ['Spec::OnOff5::on']]);
    // nothing is left of the refused one: no stray accept action, no dangling `then off;` succession
    expect(m.all().filter((e: any) => (e.eClass === 'AcceptActionUsage' || e.eClass === 'Succession') && !e.attrs.isLibrary && !e.attrs.entryTransition)).toEqual([]);
    // the entry shorthand `entry; if isInitOff then off; if not isInitOff then on;` keeps both guards
    const starts = m.all().filter((e: any) => e.eClass === 'Succession' && e.attrs.entryTransition);
    expect(starts.map((s: any) => [s.attrs.guard, s.target.map((i: string) => m.qualifiedName(i))[0]])).toEqual([
      ['isInitOff', 'Spec::OnOff5::off'],
      ['not isInitOff', 'Spec::OnOff5::on'],
    ]);
    expect(r.run.unopened).toMatch(/does not start/);
    expect(r.walk.exhaustive).toBe(false);
    expect(constructs(r.walk)).toContain('edge-not-walked');
  });

  it('OnOff6: accept/then shorthands read; `then stop` targets the terminate action `action stop terminate;`; `then done` binds to the containing state\'s final (done) node; run and walk still refuse the time trigger', async () => {
    const r = await run(EX.OnOff6, 'Spec::OnOff6');
    expect(stray(r.l.report)).toEqual([]);
    const m = r.l.model;
    const stop = find(m, 'Spec::OnOff6::stop');
    expect([stop.eClass, stop.attrs.actionKind]).toEqual(['ActionUsage', 'terminate']);
    const all = trans(m, 'Spec::OnOff6');
    expect(all.map((t) => [t.attrs.trigger ?? t.attrs.timeTrigger, t.attrs.via, ends(m, t)[0][0], ends(m, t)[1][0]])).toEqual([
      ['TurnOn', 'commPort', 'Spec::OnOff6::off', 'Spec::OnOff6::on'],
      ['Abort', 'commPort', 'Spec::OnOff6::off', 'Spec::OnOff6::stop'],
      ['5[min]', undefined, 'Spec::OnOff6::on', 'Spec::OnOff6::«DoneNode»'],
    ]);
    expect(all[2].attrs.targetRef).toBeUndefined();
    expect(r.run.unopened).toMatch(/time trigger/);
    expect(r.walk.exhaustive).toBe(false);
    expect(constructs(r.walk)).not.toContain('transition-without-endpoints');
  });
});

describe('§7.18.4 exhibit state usages', () => {
  it('Vehicle: `exhibit state operatingState references VehicleStates::operating;` keeps its reference subsetting; the abstract exhibit is itself', async () => {
    const r = await run(EX.Vehicle, 'Spec::VehicleStates');
    expect(r.l.report.diagnostics).toEqual([]);
    const m = r.l.model;
    const op = find(m, 'Spec::Vehicle::operatingState');
    const refs = m.children(op.id).filter((c: any) => c.eClass === 'ReferenceSubsetting').flatMap((c: any) => c.target.map((t: string) => m.qualifiedName(t)));
    expect(refs).toEqual(['Spec::VehicleStates::operating']);
    expect(op.eClass).toBe('ExhibitStateUsage');
    const mon = find(m, 'Spec::Vehicle::monitoringState');
    expect([mon.eClass, mon.attrs.isAbstract]).toEqual(['ExhibitStateUsage', true]);
    expect(m.children(mon.id).filter((c: any) => c.eClass === 'ReferenceSubsetting')).toEqual([]);
  });

  it('`exhibit VehicleStates::monitoring :> Vehicle::monitoringState;` is read: a nameless exhibit state usage, exhibited state by reference subsetting, plus the subsetting; no diagnostic', async () => {
    const l = await load(EX.VehicleEx);
    expect(l.report.diagnostics).toEqual([]);
    const ex = l.model.children(find(l.model, 'Spec::vehicle').id).filter((c: any) => c.eClass === 'ExhibitStateUsage');
    expect(ex).toHaveLength(1);
    expect(ex[0].declaredName).toBeUndefined();
    const rel = (k: string) => l.model.children(ex[0].id).filter((c: any) => c.eClass === k).flatMap((c: any) => c.target.map((t: string) => l.model.qualifiedName(t)));
    expect(rel('ReferenceSubsetting')).toEqual(['Spec::VehicleStates::monitoring']);
    expect(rel('Subsetting')).toEqual(['Spec::Vehicle::monitoringState']);
  });
});
