/**
 * Some run, or every run? — the guaranteed / potential modality on a `fail`
 * (plan `docs/06-model-checking-implementation-plan.md` §3.R).
 *
 * WHAT IS PINNED, AND WHAT EACH PIN NAMES AS THE WRONG ANSWER. A refutation
 * prints a witness; this feature says whether that witness is one run among
 * several or the only kind of run there is. Every case below is a machine whose
 * answer is known by construction, and the ones that could invent a value name
 * the value they must not print:
 *
 *  - the shipped `FlightModes` reads `potential` naming the cycle
 *    `manual → autonomous → manual` — never the simulator's tie-break;
 *  - a straight line reads `guaranteed`; a self-loop the violating state never
 *    leaves reads `guaranteed`, with `potential` named as the wrong answer
 *    (a sink is a sink in the FULL relation or it is not a sink);
 *  - a cycle reached only THROUGH the violation reads `guaranteed`, with the
 *    cycle named as the wrong answer (reachability is taken inside *G*);
 *  - a real way around that ENDS rather than cycles reads `potential` with the
 *    sink wording — the only coverage the sink arm of row 8 gets;
 *  - the latch machine, the dwell machine (both spellings) and the trapguard
 *    family read `not decided` at rows 5, 6 and 7 — one row per clause of the
 *    exactness gate — each with the naive answer named: `guaranteed` on the
 *    latch and on the trapguard, `potential … nominal → hold → nominal` on the
 *    dwell cycle;
 *  - a stateful monitor, a step-valued atom and a store-valued atom are refused
 *    at rows 2, 3 and 4, the last with `potential … the cycle …` named as the
 *    wrong answer on a machine where every run sets `mode = 3`;
 *  - a machine satisfying rows 5, 6, 7 and 8 at once prints row 5, so the
 *    dispatch ORDER is pinned rather than inferred.
 *
 * AND NOTHING ELSE ON THE ROW MOVED. The claim, code, detail, witness,
 * diagnostic severity and exit code of every `fail` above are pinned against
 * a table captured on the tree BEFORE the field existed, and the text report
 * is asserted to differ from that capture by the one inserted line and nothing
 * else. The modality annotates; it replaces nothing.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Model, ModelFactory, type ElementId } from '@core/index';
import { loadModelText } from '@text/load';
import { exploreMachine, stateMachinesIn } from '../../src/semantics/mc/explore';
import {
  behaviourReport,
  checkProperty,
  type Modality,
  type PropertyText,
  type PropertyVerdict,
} from '../../src/semantics/mc/patterns';
import {
  ABSENCE_CLAIMS,
  CLAUSE_SENTENCE,
  DWELL_SENTENCE,
  SIMULATOR_SENTENCE,
  WITNESS_CLAIMS,
  walkIsExact,
} from '../../src/semantics/mc/publishable';
import { acyclic, tarjanComponents } from '../../src/semantics/mc/scc';
import { main } from '../../scripts/sysprose';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

const MODELS = 'test/fixtures/verification/models';
const UAV = 'examples/uav-isr.sysml';

/** A property as a caller writes one, with the two provenance fields filled in. */
function prop(fields: Partial<PropertyText> & { pattern: string; scope: string }): PropertyText {
  return { source: 'flag', carrier: null, ...fields };
}

/** `absence × globally` over one atom — the memoryless shape rows 8 and 9 need. */
const absence = (p: string): PropertyText => prop({ pattern: 'absence', scope: 'globally', p });

const loaded = new Map<string, Model>();

async function modelOf(file: string): Promise<Model> {
  const have = loaded.get(file);
  if (have) return have;
  const r = await loadModelText(read(file), { fileName: file });
  expect(r.model, `${file} did not load`).toBeDefined();
  loaded.set(file, r.model!);
  return r.model!;
}

/** The one machine under the element a `--element` argument would name. */
function machineIn(model: Model, name: string): ElementId {
  const el = model
    .all()
    .find((e) => model.qualifiedName(e.id) === name || e.declaredName === name);
  expect(el, `no element named ${name}`).toBeDefined();
  const machines = stateMachinesIn(model, el!.id);
  expect(machines, `${name} holds ${machines.length} machine(s)`).toHaveLength(1);
  return machines[0].id;
}

async function verdictOf(
  file: string,
  machine: string,
  text: PropertyText,
  maxConfigs?: number,
): Promise<PropertyVerdict> {
  const model = await modelOf(file);
  return checkProperty(model, machineIn(model, machine), text, maxConfigs ? { maxConfigs } : {});
}

/** The modality of a row that MUST be a `fail` — every case here is one. */
function modalityOf(v: PropertyVerdict): Modality {
  expect(v.claim).toBe('fail');
  expect(v.modality, 'a fail row carries a modality').not.toBeNull();
  return v.modality!;
}

const FILES = {
  dag: `${MODELS}/modality-line.sysml`,
  sink: `${MODELS}/modality-self-loop.sysml`,
  avoidingSink: `${MODELS}/avoiding-sink.sysml`,
  cycleBehind: `${MODELS}/cycle-behind-violation.sysml`,
  latch: `${MODELS}/latch.sysml`,
  trapguard: `${MODELS}/trapguard.sysml`,
  trapguardTrue: `${MODELS}/trapguard-true.sysml`,
  trapguardFalse: `${MODELS}/trapguard-false.sysml`,
  trapguardTyped: `${MODELS}/trapguard-typed.sysml`,
};

beforeAll(async () => {
  for (const file of [UAV, ...Object.values(FILES)]) await modelOf(file);
}, 120_000);

/* ═══════════════════════ rows 8 and 9: the decided values ═══════════════════ */

describe('potential on FlightModes, guaranteed on the mission DAG', () => {
  it('names the avoiding cycle on `FlightModes`, and never the tie-break', async () => {
    const m = modalityOf(await verdictOf(UAV, 'FlightModes', absence('state failsafe')));
    expect(m.value).toBe('potential');
    expect(m.failedClause).toBeNull();
    expect(m.sentence).toContain('potential — some run avoids it: the cycle manual → autonomous → manual never enters `failsafe`');
    // THE MUST-NEVER: a modality derived from the simulator's declaration-order
    // tie-break would print a claim about the simulator as a claim about the
    // model. Scoped to `modality.sentence`, not to `detail` — the shipped
    // `detail` already names the tie-break on every `fail`, honestly.
    expect(m.sentence).not.toContain('tie-break');
    expect(m.sentence).not.toContain('enabled[0]');
    // The (d) sentence, folded into the same line: this machine has one
    // nondeterministic choice point, so the reader is told the verdict is
    // about the machine and not about what `simulate` does.
    expect(m.sentence).toContain(SIMULATOR_SENTENCE);
    expect(m.avoiding!.map((s) => s.name)).toEqual(['manual', 'autonomous', 'manual']);
  });

  it('reads `guaranteed` when the opening itself violates: G₀ is empty', async () => {
    // `absence (state standby)` on a machine that opens in `standby` is refuted
    // at step 0 — the shipped `--json` campaign case — and every run violates.
    const m = modalityOf(await verdictOf(UAV, 'FlightModes', absence('state standby')));
    expect(m.value).toBe('guaranteed');
    expect(m.sentence).toContain('guaranteed — every maximal run of this machine reaches it');
    expect(m.avoiding).toBeNull();
    expect(m.sentence).toContain(SIMULATOR_SENTENCE);
  });

  it('reads `guaranteed` on the mission DAG, with no simulator sentence on a machine with no choice point', async () => {
    const v = await verdictOf(FILES.dag, 'Mission', absence('state landed'));
    const m = modalityOf(v);
    expect(m.value).toBe('guaranteed');
    expect(m.sentence).toBe('guaranteed — every maximal run of this machine reaches it');
    expect(m.sentence).not.toContain(SIMULATOR_SENTENCE);
    // `universality` reads the violating set the other way round — the
    // configurations where `p` does NOT hold — and lands on the same answer.
    const u = modalityOf(
      await verdictOf(FILES.dag, 'Mission', prop({ pattern: 'universality', scope: 'globally', p: 'state takeoff' })),
    );
    expect(u.value).toBe('guaranteed');
  });

  it('reads `guaranteed` on the sink, with `potential` named as the wrong answer', async () => {
    // `nominal -> hazard`, `hazard -> hazard`. Inside the non-violating subgraph
    // `nominal` has no successor — its one edge leads into `hazard` — so a
    // reading that tests for a sink THERE prints `potential — some run avoids
    // it` about a machine every maximal run of which is `nominal -> hazard ->
    // hazard …`. A sink is a sink in the full relation or it is not a sink.
    const m = modalityOf(await verdictOf(FILES.sink, 'Plant', absence('state hazard')));
    expect(m.value).toBe('guaranteed');
    expect(m.value).not.toBe('potential');
    expect(m.sentence).not.toContain('some run avoids it');
    // The same answer through the `node` spelling of the atom, which reads the
    // active leaf rather than the stack and agrees on a flat machine.
    const node = modalityOf(await verdictOf(FILES.sink, 'Plant', absence('node hazard')));
    expect(node.value).toBe('guaranteed');
  });

  it('reads `potential` with the sink wording where a run ends without violating', async () => {
    // `start -> alarm`, `start -> parked`, `parked` terminal: the run that parks
    // never enters `alarm`, and it is a SINK of the full relation, not a cycle.
    // This is the only coverage the sink arm of row 8 gets.
    const m = modalityOf(await verdictOf(FILES.avoidingSink, 'Vehicle', absence('state alarm')));
    expect(m.value).toBe('potential');
    expect(m.sentence).toContain('potential — some run avoids it: the run that stops in `parked` never enters `alarm`');
    expect(m.avoiding!.map((s) => s.name)).toEqual(['parked']);
    // Two completion transitions leave `start`, so the simulator parks on no
    // run at all — and the line says so.
    expect(m.sentence).toContain(SIMULATOR_SENTENCE);
  });

  it('reads `guaranteed` on a cycle that sits BEHIND the violation, with the cycle named as the wrong answer', async () => {
    // `boot -> fault -> recoverA <-> recoverB`. The non-violating subgraph holds
    // the cycle `recoverA -> recoverB -> recoverA`; no violation-avoiding run
    // reaches it, because from `boot` the only step leads into `fault`.
    const m = modalityOf(await verdictOf(FILES.cycleBehind, 'Controller', absence('state fault')));
    expect(m.value).toBe('guaranteed');
    expect(m.value).not.toBe('potential');
    expect(m.sentence).not.toContain('recoverA → recoverB → recoverA');
    expect(m.sentence).not.toContain('some run avoids it');
  });
});

/* ═══════════════════ rows 1–4: the walk and the monitor ═══════════════════ */

describe('not decided — rows 1 to 4', () => {
  it('row 1: a `fail` found under a bound decides nothing about every run', async () => {
    // Measured: `--max-configs 3` on `FlightModes` still refutes (a bound can
    // hide a witness and can never invent one) and the walk stopped at the
    // configuration bound — so the row is `fail`, exit 1, and the modality is
    // withheld on the gate's first clause.
    const v = await verdictOf(UAV, 'FlightModes', absence('state failsafe'), 3);
    expect(v.claim).toBe('fail');
    expect(v.qualification).toContain('partial under');
    const m = modalityOf(v);
    expect(m.value).toBe('not-decided');
    expect(m.failedClause).toBe('bound');
    expect(m.sentence).toMatch(/^not decided: the walk was not exhaustive/);
    expect(m.sentence).toContain(CLAUSE_SENTENCE.bound);
    expect(m.avoiding).toBeNull();
  });

  it('row 2: a stateful monitor names the pattern, and a non-global scope names the scope', async () => {
    const precedence = modalityOf(
      await verdictOf(
        UAV,
        'FlightModes',
        prop({ pattern: 'precedence', scope: 'globally', p: 'state manual', s: 'state failsafe' }),
      ),
    );
    expect(precedence.value).toBe('not-decided');
    expect(precedence.failedClause).toBeNull();
    expect(precedence.sentence).toBe(
      'not decided: this monitor carries state (`precedence`), so the product does not collapse onto the configuration graph',
    );
    const after = modalityOf(
      await verdictOf(
        UAV,
        'FlightModes',
        prop({ pattern: 'absence', scope: 'after', q: 'state manual', p: 'state failsafe' }),
      ),
    );
    expect(after.value).toBe('not-decided');
    expect(after.sentence).toContain('carries state (`after`)');
    // On FlightModes the gate HOLDS, so `failedClause: null` above cannot tell
    // "the monitor's refusal" from "the gate's clause was null". This machine
    // names a trigger — the gate's clause is `environment` — and the field
    // still reads `null`: the refusal is the monitor's, and a `--json` consumer
    // reading `value === 'not-decided' && failedClause !== null` as "refused by
    // the gate" must not absorb a row-2 refusal into that bucket.
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Prec');
    const a = f.state('a', sm.id);
    const b = f.state('b', sm.id);
    const c = f.state('c', sm.id);
    f.transition(a.id, b.id, { ownerId: sm.id, trigger: 'go' });
    f.transition(b.id, c.id, { ownerId: sm.id });
    const walk = exploreMachine(m, sm.id);
    expect(walkIsExact(walk, walk.bounds).failedClause).toBe('environment');
    const triggered = modalityOf(
      checkProperty(m, sm.id, prop({ pattern: 'precedence', scope: 'globally', p: 'state a', s: 'state c' })),
    );
    expect(triggered.value).toBe('not-decided');
    expect(triggered.sentence).toContain('carries state (`precedence`)');
    expect(triggered.failedClause).toBeNull();
    expect(triggered.failedClause).not.toBe('environment');
  });

  it('row 3: a step-valued atom — `fires` or `trigger` — is not a configuration predicate', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Atoms');
    const idle = f.state('idle', sm.id);
    const busy = f.state('busy', sm.id);
    const t = f.transition(idle.id, busy.id, { ownerId: sm.id, trigger: 'go' });
    m.update(t.id, { declaredName: 'starting' });
    // The gate's own clause on this machine is `environment` — it names `go`.
    const walk = exploreMachine(m, sm.id);
    expect(walkIsExact(walk, walk.bounds).failedClause).toBe('environment');
    for (const p of ['fires starting', 'trigger go']) {
      const v = checkProperty(m, sm.id, absence(p));
      const mod = modalityOf(v);
      expect(mod.value, p).toBe('not-decided');
      expect(mod.sentence, p).toBe(
        'not decided: this atom is a property of a step, not of a configuration, so the product does not collapse onto the configuration graph',
      );
      // Rows 2–4 come BEFORE the relation clauses: this machine names a trigger,
      // and the row still says "step", not "environment".
      expect(mod.sentence, p).not.toContain('names triggers');
      // And the FIELD agrees with the sentence: the refusal is the atom's, so
      // `failedClause` is `null` even though the gate's clause is not. Copying
      // the gate's clause here would file every step-atom refusal on a
      // triggered machine under "refused by the gate".
      expect(mod.failedClause, p).toBeNull();
      expect(mod.failedClause, p).not.toBe('environment');
    }
  });

  it('row 4: an `expression` atom reads the store, with `potential … the cycle` named as the wrong answer', async () => {
    // `GuardProbe::Fires` with a cycle added: `mode = 3`, so every run sets it
    // and the property is refuted at the opening. Left open, no configuration
    // would be marked violating — the walk retains no store — so G would be
    // the whole graph and the row would print `potential — some run avoids it:
    // the cycle idle → hazard → idle` about a machine where every run violates.
    const text = `package P {
  part def Fires {
    attribute mode : Integer = 3;
    state def Modes {
      state idle;
      state hazard;
      transition idle if mode == 3 then hazard;
      transition hazard then idle;
    }
  }
}`;
    const r = await loadModelText(text, { fileName: 'fires-cycle.sysml' });
    const model = r.model!;
    const machineId = machineIn(model, 'P::Fires');
    const v = checkProperty(model, machineId, absence('mode == 3'));
    expect(v.witness.map((s) => s.leaf!.name)).toEqual(['idle']);
    const mod = modalityOf(v);
    expect(mod.value).toBe('not-decided');
    expect(mod.sentence).toBe('not decided: this atom reads the store, which this walk does not retain');
    expect(mod.value).not.toBe('potential');
    expect(mod.sentence).not.toContain('the cycle');
    // The gate itself HOLDS on this walk — the guard is decided true — so it
    // is the atom kind alone that withholds the answer, which is the point.
    expect(mod.failedClause).toBeNull();
  });
});

/* ═════════════════ rows 5, 6, 7: the three clauses of the gate ═════════════ */

/** `nominal → hazard` on a 5-tick dwell, declared before a 60-tick escape into a `hold` loop. */
function dwellCycleMachine(): { model: Model; machineId: ElementId } {
  const m = new Model();
  const f = new ModelFactory(m);
  const sm = f.stateDef('Dwells');
  const nominal = f.state('nominal', sm.id);
  const hazard = f.state('hazard', sm.id);
  const hold = f.state('hold', sm.id);
  f.transition(nominal.id, hazard.id, { ownerId: sm.id, trigger: 'after(5)' });
  f.transition(nominal.id, hold.id, { ownerId: sm.id, trigger: 'after(60)' });
  f.transition(hold.id, nominal.id, { ownerId: sm.id, trigger: 'after(1)' });
  return { model: m, machineId: sm.id };
}

/** The same machine re-spelled with numeric `attrs.after` and no trigger: `alphabet []`. */
function numericDwellCycleMachine(): { model: Model; machineId: ElementId } {
  const m = new Model();
  const f = new ModelFactory(m);
  const sm = f.stateDef('NumericDwells');
  const nominal = f.state('nominal', sm.id);
  const hazard = f.state('hazard', sm.id);
  const hold = f.state('hold', sm.id);
  for (const [from, to, after] of [
    [nominal.id, hazard.id, 5],
    [nominal.id, hold.id, 60],
    [hold.id, nominal.id, 1],
  ] as const) {
    m.create('TransitionUsage', { ownerId: sm.id, attrs: { after }, source: [from], target: [to] });
  }
  return { model: m, machineId: sm.id };
}

describe('not decided — rows 5, 6 and 7, one per clause of `walkIsExact`', () => {
  it('row 5: the latch file names its trigger, with `guaranteed` named as the wrong answer', async () => {
    // `nominal -> locked`, `locked --unlatch--> nominal`. Naively: the
    // violating set is `{locked}`, G is `{nominal}`, no sink, no cycle —
    // `guaranteed`. In the system where `unlatch` never arrives the machine
    // sits in `nominal` forever, and that run was never a candidate.
    const m = modalityOf(await verdictOf(FILES.latch, 'Latch', absence('state locked')));
    expect(m.value).toBe('not-decided');
    expect(m.failedClause).toBe('environment');
    expect(m.sentence).toBe(
      'not decided: this machine names triggers, and "every run" would be a claim about an environment this walk has no carrier for',
    );
    expect(m.value).not.toBe('guaranteed');
    expect(m.sentence).not.toContain('guaranteed');
  });

  it('row 6: the dwell cycle, with `potential … nominal → hold → nominal` named as the wrong answer', () => {
    // The walk offers `after(60)` at `nominal` as a named event with no clock,
    // so G₀ holds the cycle `nominal → hold → nominal` built entirely from
    // dwell edges — on a machine where `enabled[0]` sends EVERY run into
    // `hazard` after five ticks and the named cycle exists on no run at all.
    const { model, machineId } = dwellCycleMachine();
    const v = checkProperty(model, machineId, absence('state hazard'));
    const m = modalityOf(v);
    expect(m.value).toBe('not-decided');
    expect(m.failedClause).toBe('time');
    expect(m.sentence).toMatch(/^not decided: this machine carries `after\(n\)` dwell transitions/);
    expect(m.sentence).toContain(DWELL_SENTENCE);
    expect(m.value).not.toBe('potential');
    expect(m.sentence).not.toContain('nominal → hold → nominal');
    // A dwell is not a trigger an environment can withhold, so the row points
    // at no fairness carrier and does not call the dwells "triggers".
    expect(m.sentence).not.toContain('FairnessAssumption');
    expect(m.sentence).not.toContain('names triggers');
  });

  it('row 6 again on the numeric `attrs.after` spelling, where the alphabet is empty', () => {
    // The draft's alphabet-only rule decided a modality here — `alphabet []` —
    // and would have printed `potential` naming the same phantom cycle. The
    // transition set is the clause's producer, and rows 5 and 6 are two
    // independent clauses, not one.
    const { model, machineId } = numericDwellCycleMachine();
    expect(exploreMachine(model, machineId).bounds.alphabet).toEqual([]);
    const m = modalityOf(checkProperty(model, machineId, absence('state hazard')));
    expect(m.value).toBe('not-decided');
    expect(m.failedClause).toBe('time');
    expect(m.sentence).toContain(DWELL_SENTENCE);
    expect(m.value).not.toBe('guaranteed');
    expect(m.value).not.toBe('potential');
    expect(m.sentence).not.toContain('guaranteed');
    expect(m.sentence).not.toContain('potential');
  });

  it('row 7: the trapguard file, with `guaranteed` named as the wrong answer and the store sentence beside it', async () => {
    // `nominal -> degradedA -> degradedB -> degradedA`, escape `degradedA if
    // resetOk then nominal` over an unvalued `resetOk`. Against `absence (state
    // degradedB)` the retained relation has no escape edge, G is `{nominal,
    // degradedA}`, no cycle, no full-relation sink — the naive answer is
    // `guaranteed`, about a machine whose model states the way out.
    const m = modalityOf(await verdictOf(FILES.trapguard, 'TrapGuard::Trap', absence('state degradedB')));
    expect(m.value).toBe('not-decided');
    expect(m.failedClause).toBe('store');
    expect(m.sentence).toMatch(/^not decided: a transition of this machine is guarded by a condition the walk consulted and could not decide/);
    expect(m.sentence).toContain(CLAUSE_SENTENCE.store);
    expect(m.value).not.toBe('guaranteed');
    expect(m.sentence).not.toContain('guaranteed');
    expect(m.sentence).not.toContain('potential');
  });

  it('row 7 tracks decidedness, not the presence of a guard: both literal variants are DECIDED', async () => {
    // `= true` retains the escape edge: G₀ holds `nominal → degradedA → nominal`
    // and the answer is `potential`, with the simulator sentence beside it
    // (two completion transitions leave `degradedA`).
    const t = modalityOf(await verdictOf(FILES.trapguardTrue, 'TrapGuardTrue::Trap', absence('state degradedB')));
    expect(t.value).toBe('potential');
    expect(t.failedClause).toBeNull();
    expect(t.sentence).toContain('the cycle nominal → degradedA → nominal never enters `degradedB`');
    expect(t.sentence).toContain(SIMULATOR_SENTENCE);
    // `= false` drops the edge because the MODEL says so: every run reaches
    // `degradedB`, and the answer is `guaranteed` — decided, not withheld.
    const f = modalityOf(await verdictOf(FILES.trapguardFalse, 'TrapGuardFalse::Trap', absence('state degradedB')));
    expect(f.value).toBe('guaranteed');
    expect(f.failedClause).toBeNull();
    // And the fully valued `not mode` file is row 7 too: `mode = 3` is
    // declared, and the guard still decided nothing. The row reads the shipped
    // predicate, not "no declared value" — which is why its sentence does not
    // say that.
    const typed = modalityOf(await verdictOf(FILES.trapguardTyped, 'TrapGuardTyped::Trap', absence('state degradedB')));
    expect(typed.value).toBe('not-decided');
    expect(typed.failedClause).toBe('store');
    expect(typed.sentence).not.toContain('no declared value');
  });
});

/* ═══════════════════════ the order of the dispatch ═══════════════════════ */

describe('the rows are a dispatch, top to bottom', () => {
  it('a machine satisfying rows 5, 6, 7 and 8 at once prints row 5', () => {
    // A real trigger (`abort`), a dwell (`after(5)`), a guard nothing values
    // (`resetOk`) and an avoiding cycle (`nominal → hold → nominal`): every
    // relation clause fails and the graph holds a cycle, so rows 5, 6, 7 and 8
    // all apply. The sentence is row 5's — an author whose machine names
    // `abort` has something to do about it — and the order is pinned here
    // rather than inferred from the gate's own test.
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Everything');
    const nominal = f.state('nominal', sm.id);
    const hazard = f.state('hazard', sm.id);
    const hold = f.state('hold', sm.id);
    const safe = f.state('safe', sm.id);
    f.attribute('resetOk', sm.id, { type: 'Boolean' });
    f.transition(nominal.id, hazard.id, { ownerId: sm.id });
    f.transition(nominal.id, hold.id, { ownerId: sm.id, trigger: 'abort' });
    f.transition(hold.id, nominal.id, { ownerId: sm.id });
    f.transition(hold.id, hazard.id, { ownerId: sm.id, trigger: 'after(5)' });
    f.transition(nominal.id, safe.id, { ownerId: sm.id, guard: 'resetOk' });
    // The four producers, asserted so the case cannot pass on a machine that
    // satisfies only one row.
    const walk = exploreMachine(m, sm.id);
    expect(walk.bounds.alphabet).toEqual(['abort', 'after(5)']);
    expect(walk.timedTransitions.size).toBe(1);
    expect(walk.undeterminedGuards).toHaveLength(1);
    expect(walk.exhaustive).toBe(true);
    // The fourth producer — row 8's precondition — computed the way the
    // producer computes it: V = the configurations whose leaf is `hazard`,
    // G₀ = what the opening reaches inside the rest, and the relation induced
    // on G₀ holds a cycle (`nominal → hold → nominal`) and no full-relation
    // sink. Without this the "not `some run avoids it`" assertion below could
    // pass on a machine that satisfies only rows 5–7, and the case would pin
    // nothing about the ORDER.
    const violates = (i: number): boolean => walk.configStates[i].includes(hazard.id);
    const g0: number[] = violates(0) ? [] : [0];
    for (let head = 0; head < g0.length; head++) {
      for (const w of walk.successors[g0[head]]) if (!g0.includes(w) && !violates(w)) g0.push(w);
    }
    // `safe` is not in G₀: its edge is guarded by the unvalued `resetOk`, read false.
    expect(g0.map((i) => walk.configLeaves[i])).toEqual([nominal.id, hold.id]);
    const induced = walk.successors.map((ts, v) => (g0.includes(v) ? ts.filter((w) => g0.includes(w)) : []));
    expect(acyclic(induced, tarjanComponents(induced))).toBe(false);
    expect(g0.filter((i) => walk.successors[i].length === 0)).toEqual([]);
    const mod = modalityOf(checkProperty(m, sm.id, absence('state hazard')));
    expect(mod.value).toBe('not-decided');
    expect(mod.failedClause).toBe('environment');
    expect(mod.sentence).toContain('this machine names triggers');
    expect(mod.sentence).not.toContain('dwell');
    expect(mod.sentence).not.toContain('guarded');
    expect(mod.sentence).not.toContain('some run avoids it');
  });
});

/* ══════════════════ the field on every claim that is not a fail ═══════════════ */

describe('the field is required and `null` on every claim but `fail`', () => {
  it('carries `modality: null` on a pass, a vacuity, a bound, a liveness refusal and an unreadable property', async () => {
    const model = await modelOf(UAV);
    const machineId = machineIn(model, 'FlightModes');
    // `A -a→ B -b→ C -c→ D` plus an orphan `E`: `between B and E` never closes
    // a segment, which is the vacuity the patterns suite pins.
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Chain');
    const a = f.state('A', sm.id);
    const b = f.state('B', sm.id);
    const c = f.state('C', sm.id);
    f.state('E', sm.id);
    f.transition(a.id, b.id, { ownerId: sm.id, trigger: 'a' });
    f.transition(b.id, c.id, { ownerId: sm.id, trigger: 'b' });
    const rows: Array<[string, string, PropertyVerdict]> = [
      [
        'pass',
        'pass',
        checkProperty(model, machineId, prop({ pattern: 'precedence', scope: 'globally', p: 'state failsafe', s: 'state manual' })),
      ],
      [
        'vacuous',
        'vacuous',
        checkProperty(m, sm.id, prop({ pattern: 'absence', scope: 'between', p: 'state C', q: 'state B', r: 'state E' })),
      ],
      ['bound', 'inconclusive', checkProperty(model, machineId, absence('state failsafe'), { maxConfigs: 1 })],
      [
        'liveness',
        'inconclusive',
        checkProperty(model, machineId, prop({ pattern: 'existence', scope: 'globally', p: 'state failsafe' })),
      ],
      ['unreadable', 'inconclusive', checkProperty(model, machineId, absence('state nowhere'))],
    ];
    for (const [what, claim, v] of rows) {
      expect(v.claim, what).toBe(claim);
      expect('modality' in v, `${what}: the key is present`).toBe(true);
      expect(v.modality, `${what}: ${v.claim}`).toBeNull();
    }
  });

  it('is the census: `value` and `failedClause` on the one field, and nothing on the report', async () => {
    const model = await modelOf(FILES.trapguard);
    const report = behaviourReport(model, {
      machineId: machineIn(model, 'TrapGuard::Trap'),
      pattern: 'pattern=absence, scope=globally, p=state degradedB',
    });
    expect(Object.keys(report).sort()).toEqual([
      'counts',
      'coverRequired',
      'diagnostics',
      'exitCode',
      'machine',
      'profile',
      'properties',
      'strictVacuity',
    ]);
    expect(report.properties[0].modality).toMatchObject({ value: 'not-decided', failedClause: 'store' });
  });
});

/* ═══════════════════ the register names this producer ═══════════════════ */

describe('A8 and W3 are produced here, and by one function', () => {
  it('both rows point at `modalityOf` in `patterns.ts`', () => {
    const a8 = ABSENCE_CLAIMS.find((r) => r.id === 'A8')!;
    const w3 = WITNESS_CLAIMS.find((r) => r.id === 'W3')!;
    expect(a8.producedBy).toEqual({ file: 'src/semantics/mc/patterns.ts', symbol: 'modalityOf' });
    expect(w3.producedBy).toEqual(a8.producedBy);
    expect(a8.walkRequires).toBe('walkIsExact');
    expect(w3.walkRequires).toBe('walkIsExact');
  });
});

/* ═════════════════ nothing else on the row moved, byte for byte ═════════════ */

interface Before {
  id: string;
  file: string;
  machine: string;
  pattern: string;
  maxConfigs?: number;
  claim: string;
  code: string;
  /** `[leaf name, holds]` per step of the witness. */
  witness: Array<[string, string[]]>;
  exitCode: number;
  counts: {
    passed: number;
    failed: number;
    vacuous: number;
    inconclusive: number;
    // The two `cover` buckets (§3.1) landed beside these; 0 on every absence row.
    covered: number;
    notCovered: number;
  };
  /** `[severity, code]` per diagnostic the report emitted. */
  diagnostics: Array<[string, string]>;
  /** The property block `check-behaviour` printed, from the claim line to the profile. */
  textLines: string[];
}

/**
 * Every `fail` row above, captured on the tree BEFORE the modality existed —
 * `63d228b`, hand-verified once — down to the text the command printed.
 *
 * The gate of this commit is *"the annotation moved nothing on the row"*, and a
 * gate nobody can fail proves nothing: every figure below is a published one,
 * and the text block is asserted to differ from what the command prints now by
 * the ONE inserted line and by nothing else.
 */
const BEFORE: readonly Before[] = [
  {
    id: 'uav-failsafe',
    file: 'examples/uav-isr.sysml',
    machine: 'FlightModes',
    pattern: 'pattern=absence, scope=globally, p=state failsafe',
    claim: 'fail',
    code: 'verification/refuted',
    witness: [['standby', []], ['manual', []], ['autonomous', []], ['failsafe', ['p']]],
    exitCode: 1,
    counts: { passed: 0, failed: 1, vacuous: 0, inconclusive: 0, covered: 0, notCovered: 0 },
    diagnostics: [['error', 'verification/refuted']],
    textLines: [
      '  FAIL         `state failsafe` never holds, over the whole run',
      '    from --pattern',
      '    fail — witness trace of 3 step(s): `state failsafe` never holds, over the whole run. The run below is one this semantics admits; the simulator’s declaration-order tie-break may never take it.',
      '    verification/refuted',
      '    3 product state(s) explored — exhaustive under {maxConfigs 10000, maxDepth 200, maxCompletion 64, alphabet no named trigger, store seeded from declared literal values — a guard over an attribute with no declared value is read as false} — the count beside it is the product states seen up to the witness, not the size of the product space',
      '    witness — a run this semantics admits:',
      '       0  start → UAVSurveillanceSystem::FlightModes::standby',
      '       1  completion standby -> manual → UAVSurveillanceSystem::FlightModes::manual',
      '       2  completion manual -> autonomous → UAVSurveillanceSystem::FlightModes::autonomous',
      '       3  completion autonomous -> failsafe → UAVSurveillanceSystem::FlightModes::failsafe  [holds p]',
    ],
  },
  {
    id: 'uav-standby',
    file: 'examples/uav-isr.sysml',
    machine: 'FlightModes',
    pattern: 'pattern=absence, scope=globally, p=state standby',
    claim: 'fail',
    code: 'verification/refuted',
    witness: [['standby', ['p']]],
    exitCode: 1,
    counts: { passed: 0, failed: 1, vacuous: 0, inconclusive: 0, covered: 0, notCovered: 0 },
    diagnostics: [['error', 'verification/refuted']],
    textLines: [
      '  FAIL         `state standby` never holds, over the whole run',
      '    from --pattern',
      '    fail — witness trace of 0 step(s): `state standby` never holds, over the whole run. The run below is one this semantics admits; the simulator’s declaration-order tie-break may never take it.',
      '    verification/refuted',
      '    1 product state(s) explored — exhaustive under {maxConfigs 10000, maxDepth 200, maxCompletion 64, alphabet no named trigger, store seeded from declared literal values — a guard over an attribute with no declared value is read as false} — the count beside it is the product states seen up to the witness, not the size of the product space',
      '    witness — a run this semantics admits:',
      '       0  start → UAVSurveillanceSystem::FlightModes::standby  [holds p]',
    ],
  },
  {
    id: 'uav-failsafe-max3',
    file: 'examples/uav-isr.sysml',
    machine: 'FlightModes',
    pattern: 'pattern=absence, scope=globally, p=state failsafe',
    maxConfigs: 3,
    claim: 'fail',
    code: 'verification/refuted',
    witness: [['standby', []], ['manual', []], ['autonomous', []], ['failsafe', ['p']]],
    exitCode: 1,
    counts: { passed: 0, failed: 1, vacuous: 0, inconclusive: 0, covered: 0, notCovered: 0 },
    diagnostics: [['error', 'verification/refuted']],
    textLines: [
      '  FAIL         `state failsafe` never holds, over the whole run',
      '    from --pattern',
      '    fail — witness trace of 3 step(s): `state failsafe` never holds, over the whole run. The run below is one this semantics admits; the simulator’s declaration-order tie-break may never take it.',
      '    verification/refuted',
      '    3 product state(s) explored — partial under {maxConfigs 3, maxDepth 200, maxCompletion 64, alphabet no named trigger, store seeded from declared literal values — a guard over an attribute with no declared value is read as false} — the configuration bound was reached — the count beside it is the product states seen up to the witness, not the size of the product space',
      '    witness — a run this semantics admits:',
      '       0  start → UAVSurveillanceSystem::FlightModes::standby',
      '       1  completion standby -> manual → UAVSurveillanceSystem::FlightModes::manual',
      '       2  completion manual -> autonomous → UAVSurveillanceSystem::FlightModes::autonomous',
      '       3  completion autonomous -> failsafe → UAVSurveillanceSystem::FlightModes::failsafe  [holds p]',
    ],
  },
  {
    id: 'uav-precedence',
    file: 'examples/uav-isr.sysml',
    machine: 'FlightModes',
    pattern: 'pattern=precedence, scope=globally, p=state manual, s=state failsafe',
    claim: 'fail',
    code: 'verification/refuted',
    witness: [['standby', []], ['manual', ['p']]],
    exitCode: 1,
    counts: { passed: 0, failed: 1, vacuous: 0, inconclusive: 0, covered: 0, notCovered: 0 },
    diagnostics: [['error', 'verification/refuted']],
    textLines: [
      '  FAIL         `state failsafe` holds before `state manual` ever does, over the whole run',
      '    from --pattern',
      '    fail — witness trace of 1 step(s): `state failsafe` holds before `state manual` ever does, over the whole run. The run below is one this semantics admits; the simulator’s declaration-order tie-break may never take it.',
      '    verification/refuted',
      '    1 product state(s) explored — exhaustive under {maxConfigs 10000, maxDepth 200, maxCompletion 64, alphabet no named trigger, store seeded from declared literal values — a guard over an attribute with no declared value is read as false} — the count beside it is the product states seen up to the witness, not the size of the product space',
      '    witness — a run this semantics admits:',
      '       0  start → UAVSurveillanceSystem::FlightModes::standby',
      '       1  completion standby -> manual → UAVSurveillanceSystem::FlightModes::manual  [holds p]',
    ],
  },
  {
    id: 'uav-after',
    file: 'examples/uav-isr.sysml',
    machine: 'FlightModes',
    pattern: 'pattern=absence, scope=after, q=state manual, p=state failsafe',
    claim: 'fail',
    code: 'verification/refuted',
    witness: [['standby', []], ['manual', ['q']], ['autonomous', []], ['failsafe', ['p']]],
    exitCode: 1,
    counts: { passed: 0, failed: 1, vacuous: 0, inconclusive: 0, covered: 0, notCovered: 0 },
    diagnostics: [['error', 'verification/refuted']],
    textLines: [
      '  FAIL         `state failsafe` never holds, from the first `state manual` onwards',
      '    from --pattern',
      '    fail — witness trace of 3 step(s): `state failsafe` never holds, from the first `state manual` onwards. The run below is one this semantics admits; the simulator’s declaration-order tie-break may never take it.',
      '    verification/refuted',
      '    3 product state(s) explored — exhaustive under {maxConfigs 10000, maxDepth 200, maxCompletion 64, alphabet no named trigger, store seeded from declared literal values — a guard over an attribute with no declared value is read as false} — the count beside it is the product states seen up to the witness, not the size of the product space',
      '    witness — a run this semantics admits:',
      '       0  start → UAVSurveillanceSystem::FlightModes::standby',
      '       1  completion standby -> manual → UAVSurveillanceSystem::FlightModes::manual  [holds q]',
      '       2  completion manual -> autonomous → UAVSurveillanceSystem::FlightModes::autonomous',
      '       3  completion autonomous -> failsafe → UAVSurveillanceSystem::FlightModes::failsafe  [holds p]',
    ],
  },
  {
    id: 'uav-universality',
    file: 'examples/uav-isr.sysml',
    machine: 'FlightModes',
    pattern: 'pattern=universality, scope=globally, p=state standby',
    claim: 'fail',
    code: 'verification/refuted',
    witness: [['standby', ['p']], ['manual', []]],
    exitCode: 1,
    counts: { passed: 0, failed: 1, vacuous: 0, inconclusive: 0, covered: 0, notCovered: 0 },
    diagnostics: [['error', 'verification/refuted']],
    textLines: [
      '  FAIL         `state standby` holds at every configuration, over the whole run',
      '    from --pattern',
      '    fail — witness trace of 1 step(s): `state standby` holds at every configuration, over the whole run. The run below is one this semantics admits; the simulator’s declaration-order tie-break may never take it.',
      '    verification/refuted',
      '    1 product state(s) explored — exhaustive under {maxConfigs 10000, maxDepth 200, maxCompletion 64, alphabet no named trigger, store seeded from declared literal values — a guard over an attribute with no declared value is read as false} — the count beside it is the product states seen up to the witness, not the size of the product space',
      '    witness — a run this semantics admits:',
      '       0  start → UAVSurveillanceSystem::FlightModes::standby  [holds p]',
      '       1  completion standby -> manual → UAVSurveillanceSystem::FlightModes::manual',
    ],
  },
  {
    id: 'dag',
    file: 'test/fixtures/verification/models/modality-line.sysml',
    machine: 'Mission',
    pattern: 'pattern=absence, scope=globally, p=state landed',
    claim: 'fail',
    code: 'verification/refuted',
    witness: [['takeoff', []], ['cruise', []], ['landed', ['p']]],
    exitCode: 1,
    counts: { passed: 0, failed: 1, vacuous: 0, inconclusive: 0, covered: 0, notCovered: 0 },
    diagnostics: [['error', 'verification/refuted']],
    textLines: [
      '  FAIL         `state landed` never holds, over the whole run',
      '    from --pattern',
      '    fail — witness trace of 2 step(s): `state landed` never holds, over the whole run. The run below is one this semantics admits; the simulator’s declaration-order tie-break may never take it.',
      '    verification/refuted',
      '    2 product state(s) explored — exhaustive under {maxConfigs 10000, maxDepth 200, maxCompletion 64, alphabet no named trigger, store seeded from declared literal values — a guard over an attribute with no declared value is read as false} — the count beside it is the product states seen up to the witness, not the size of the product space',
      '    witness — a run this semantics admits:',
      '       0  start → MissionDag::Mission::Modes::takeoff',
      '       1  completion takeoff -> cruise → MissionDag::Mission::Modes::cruise',
      '       2  completion cruise -> landed → MissionDag::Mission::Modes::landed  [holds p]',
    ],
  },
  {
    id: 'dag-universality',
    file: 'test/fixtures/verification/models/modality-line.sysml',
    machine: 'Mission',
    pattern: 'pattern=universality, scope=globally, p=state takeoff',
    claim: 'fail',
    code: 'verification/refuted',
    witness: [['takeoff', ['p']], ['cruise', []]],
    exitCode: 1,
    counts: { passed: 0, failed: 1, vacuous: 0, inconclusive: 0, covered: 0, notCovered: 0 },
    diagnostics: [['error', 'verification/refuted']],
    textLines: [
      '  FAIL         `state takeoff` holds at every configuration, over the whole run',
      '    from --pattern',
      '    fail — witness trace of 1 step(s): `state takeoff` holds at every configuration, over the whole run. The run below is one this semantics admits; the simulator’s declaration-order tie-break may never take it.',
      '    verification/refuted',
      '    1 product state(s) explored — exhaustive under {maxConfigs 10000, maxDepth 200, maxCompletion 64, alphabet no named trigger, store seeded from declared literal values — a guard over an attribute with no declared value is read as false} — the count beside it is the product states seen up to the witness, not the size of the product space',
      '    witness — a run this semantics admits:',
      '       0  start → MissionDag::Mission::Modes::takeoff  [holds p]',
      '       1  completion takeoff -> cruise → MissionDag::Mission::Modes::cruise',
    ],
  },
  {
    id: 'sink',
    file: 'test/fixtures/verification/models/modality-self-loop.sysml',
    machine: 'Plant',
    pattern: 'pattern=absence, scope=globally, p=state hazard',
    claim: 'fail',
    code: 'verification/refuted',
    witness: [['nominal', []], ['hazard', ['p']]],
    exitCode: 1,
    counts: { passed: 0, failed: 1, vacuous: 0, inconclusive: 0, covered: 0, notCovered: 0 },
    diagnostics: [['error', 'verification/refuted']],
    textLines: [
      '  FAIL         `state hazard` never holds, over the whole run',
      '    from --pattern',
      '    fail — witness trace of 1 step(s): `state hazard` never holds, over the whole run. The run below is one this semantics admits; the simulator’s declaration-order tie-break may never take it.',
      '    verification/refuted',
      '    1 product state(s) explored — exhaustive under {maxConfigs 10000, maxDepth 200, maxCompletion 64, alphabet no named trigger, store seeded from declared literal values — a guard over an attribute with no declared value is read as false} — the count beside it is the product states seen up to the witness, not the size of the product space',
      '    witness — a run this semantics admits:',
      '       0  start → Sink::Plant::Modes::nominal',
      '       1  completion nominal -> hazard → Sink::Plant::Modes::hazard  [holds p]',
    ],
  },
  {
    id: 'avoiding-sink',
    file: 'test/fixtures/verification/models/avoiding-sink.sysml',
    machine: 'Vehicle',
    pattern: 'pattern=absence, scope=globally, p=state alarm',
    claim: 'fail',
    code: 'verification/refuted',
    witness: [['start', []], ['alarm', ['p']]],
    exitCode: 1,
    counts: { passed: 0, failed: 1, vacuous: 0, inconclusive: 0, covered: 0, notCovered: 0 },
    diagnostics: [['error', 'verification/refuted']],
    textLines: [
      '  FAIL         `state alarm` never holds, over the whole run',
      '    from --pattern',
      '    fail — witness trace of 1 step(s): `state alarm` never holds, over the whole run. The run below is one this semantics admits; the simulator’s declaration-order tie-break may never take it.',
      '    verification/refuted',
      '    1 product state(s) explored — exhaustive under {maxConfigs 10000, maxDepth 200, maxCompletion 64, alphabet no named trigger, store seeded from declared literal values — a guard over an attribute with no declared value is read as false} — the count beside it is the product states seen up to the witness, not the size of the product space',
      '    witness — a run this semantics admits:',
      '       0  start → AvoidingSink::Vehicle::Modes::start',
      '       1  completion start -> alarm → AvoidingSink::Vehicle::Modes::alarm  [holds p]',
    ],
  },
  {
    id: 'cycle-behind',
    file: 'test/fixtures/verification/models/cycle-behind-violation.sysml',
    machine: 'Controller',
    pattern: 'pattern=absence, scope=globally, p=state fault',
    claim: 'fail',
    code: 'verification/refuted',
    witness: [['boot', []], ['fault', ['p']]],
    exitCode: 1,
    counts: { passed: 0, failed: 1, vacuous: 0, inconclusive: 0, covered: 0, notCovered: 0 },
    diagnostics: [['error', 'verification/refuted']],
    textLines: [
      '  FAIL         `state fault` never holds, over the whole run',
      '    from --pattern',
      '    fail — witness trace of 1 step(s): `state fault` never holds, over the whole run. The run below is one this semantics admits; the simulator’s declaration-order tie-break may never take it.',
      '    verification/refuted',
      '    1 product state(s) explored — exhaustive under {maxConfigs 10000, maxDepth 200, maxCompletion 64, alphabet no named trigger, store seeded from declared literal values — a guard over an attribute with no declared value is read as false} — the count beside it is the product states seen up to the witness, not the size of the product space',
      '    witness — a run this semantics admits:',
      '       0  start → CycleBehindViolation::Controller::Modes::boot',
      '       1  completion boot -> fault → CycleBehindViolation::Controller::Modes::fault  [holds p]',
    ],
  },
  {
    id: 'latch',
    file: 'test/fixtures/verification/models/latch.sysml',
    machine: 'Latch',
    pattern: 'pattern=absence, scope=globally, p=state locked',
    claim: 'fail',
    code: 'verification/refuted',
    witness: [['nominal', []], ['locked', ['p']]],
    exitCode: 1,
    counts: { passed: 0, failed: 1, vacuous: 0, inconclusive: 0, covered: 0, notCovered: 0 },
    diagnostics: [['error', 'verification/refuted']],
    textLines: [
      '  FAIL         `state locked` never holds, over the whole run',
      '    from --pattern',
      '    fail — witness trace of 1 step(s): `state locked` never holds, over the whole run. The run below is one this semantics admits; the simulator’s declaration-order tie-break may never take it.',
      '    verification/refuted',
      '    1 product state(s) explored — exhaustive under {maxConfigs 10000, maxDepth 200, maxCompletion 64, alphabet unlatch, store seeded from declared literal values — a guard over an attribute with no declared value is read as false} — the count beside it is the product states seen up to the witness, not the size of the product space',
      '    witness — a run this semantics admits:',
      '       0  start → Latch::Latch::Modes::nominal',
      '       1  completion nominal -> locked → Latch::Latch::Modes::locked  [holds p]',
    ],
  },
  {
    id: 'trapguard',
    file: 'test/fixtures/verification/models/trapguard.sysml',
    machine: 'TrapGuard::Trap',
    pattern: 'pattern=absence, scope=globally, p=state degradedB',
    claim: 'fail',
    code: 'verification/refuted',
    witness: [['nominal', []], ['degradedA', []], ['degradedB', ['p']]],
    exitCode: 1,
    counts: { passed: 0, failed: 1, vacuous: 0, inconclusive: 0, covered: 0, notCovered: 0 },
    diagnostics: [['error', 'verification/refuted']],
    textLines: [
      '  FAIL         `state degradedB` never holds, over the whole run',
      '    from --pattern',
      '    fail — witness trace of 2 step(s): `state degradedB` never holds, over the whole run. The run below is one this semantics admits; the simulator’s declaration-order tie-break may never take it.',
      '    verification/refuted',
      '    2 product state(s) explored — undetermined under {maxConfigs 10000, maxDepth 200, maxCompletion 64, alphabet no named trigger, store seeded from declared literal values — a guard over an attribute with no declared value is read as false} — 1 guard(s) the walk could not evaluate — the count beside it is the product states seen up to the witness, not the size of the product space',
      '    witness — a run this semantics admits:',
      '       0  start → TrapGuard::Trap::Modes::nominal',
      '       1  completion nominal -> degradedA → TrapGuard::Trap::Modes::degradedA',
      '       2  completion degradedA -> degradedB → TrapGuard::Trap::Modes::degradedB  [holds p]',
    ],
  },
  {
    id: 'trapguard-true',
    file: 'test/fixtures/verification/models/trapguard-true.sysml',
    machine: 'TrapGuardTrue::Trap',
    pattern: 'pattern=absence, scope=globally, p=state degradedB',
    claim: 'fail',
    code: 'verification/refuted',
    witness: [['nominal', []], ['degradedA', []], ['degradedB', ['p']]],
    exitCode: 1,
    counts: { passed: 0, failed: 1, vacuous: 0, inconclusive: 0, covered: 0, notCovered: 0 },
    diagnostics: [['error', 'verification/refuted']],
    textLines: [
      '  FAIL         `state degradedB` never holds, over the whole run',
      '    from --pattern',
      '    fail — witness trace of 2 step(s): `state degradedB` never holds, over the whole run. The run below is one this semantics admits; the simulator’s declaration-order tie-break may never take it.',
      '    verification/refuted',
      '    2 product state(s) explored — exhaustive under {maxConfigs 10000, maxDepth 200, maxCompletion 64, alphabet no named trigger, store seeded from declared literal values — a guard over an attribute with no declared value is read as false} — the count beside it is the product states seen up to the witness, not the size of the product space',
      '    witness — a run this semantics admits:',
      '       0  start → TrapGuardTrue::Trap::Modes::nominal',
      '       1  completion nominal -> degradedA → TrapGuardTrue::Trap::Modes::degradedA',
      '       2  completion degradedA -> degradedB → TrapGuardTrue::Trap::Modes::degradedB  [holds p]',
    ],
  },
  {
    id: 'trapguard-false',
    file: 'test/fixtures/verification/models/trapguard-false.sysml',
    machine: 'TrapGuardFalse::Trap',
    pattern: 'pattern=absence, scope=globally, p=state degradedB',
    claim: 'fail',
    code: 'verification/refuted',
    witness: [['nominal', []], ['degradedA', []], ['degradedB', ['p']]],
    exitCode: 1,
    counts: { passed: 0, failed: 1, vacuous: 0, inconclusive: 0, covered: 0, notCovered: 0 },
    diagnostics: [['error', 'verification/refuted']],
    textLines: [
      '  FAIL         `state degradedB` never holds, over the whole run',
      '    from --pattern',
      '    fail — witness trace of 2 step(s): `state degradedB` never holds, over the whole run. The run below is one this semantics admits; the simulator’s declaration-order tie-break may never take it.',
      '    verification/refuted',
      '    2 product state(s) explored — exhaustive under {maxConfigs 10000, maxDepth 200, maxCompletion 64, alphabet no named trigger, store seeded from declared literal values — a guard over an attribute with no declared value is read as false} — the count beside it is the product states seen up to the witness, not the size of the product space',
      '    witness — a run this semantics admits:',
      '       0  start → TrapGuardFalse::Trap::Modes::nominal',
      '       1  completion nominal -> degradedA → TrapGuardFalse::Trap::Modes::degradedA',
      '       2  completion degradedA -> degradedB → TrapGuardFalse::Trap::Modes::degradedB  [holds p]',
    ],
  },
  {
    id: 'trapguard-typed',
    file: 'test/fixtures/verification/models/trapguard-typed.sysml',
    machine: 'TrapGuardTyped::Trap',
    pattern: 'pattern=absence, scope=globally, p=state degradedB',
    claim: 'fail',
    code: 'verification/refuted',
    witness: [['nominal', []], ['degradedA', []], ['degradedB', ['p']]],
    exitCode: 1,
    counts: { passed: 0, failed: 1, vacuous: 0, inconclusive: 0, covered: 0, notCovered: 0 },
    diagnostics: [['error', 'verification/refuted']],
    textLines: [
      '  FAIL         `state degradedB` never holds, over the whole run',
      '    from --pattern',
      '    fail — witness trace of 2 step(s): `state degradedB` never holds, over the whole run. The run below is one this semantics admits; the simulator’s declaration-order tie-break may never take it.',
      '    verification/refuted',
      '    2 product state(s) explored — undetermined under {maxConfigs 10000, maxDepth 200, maxCompletion 64, alphabet no named trigger, store seeded from declared literal values — a guard over an attribute with no declared value is read as false} — 1 guard(s) the walk could not evaluate — the count beside it is the product states seen up to the witness, not the size of the product space',
      '    witness — a run this semantics admits:',
      '       0  start → TrapGuardTyped::Trap::Modes::nominal',
      '       1  completion nominal -> degradedA → TrapGuardTyped::Trap::Modes::degradedA',
      '       2  completion degradedA -> degradedB → TrapGuardTyped::Trap::Modes::degradedB  [holds p]',
    ],
  },
  {
    id: 'node-atom',
    file: 'test/fixtures/verification/models/modality-self-loop.sysml',
    machine: 'Plant',
    pattern: 'pattern=absence, scope=globally, p=node hazard',
    claim: 'fail',
    code: 'verification/refuted',
    witness: [['nominal', []], ['hazard', ['p']]],
    exitCode: 1,
    counts: { passed: 0, failed: 1, vacuous: 0, inconclusive: 0, covered: 0, notCovered: 0 },
    diagnostics: [['error', 'verification/refuted']],
    textLines: [
      '  FAIL         `node hazard` never holds, over the whole run',
      '    from --pattern',
      '    fail — witness trace of 1 step(s): `node hazard` never holds, over the whole run. The run below is one this semantics admits; the simulator’s declaration-order tie-break may never take it.',
      '    verification/refuted',
      '    1 product state(s) explored — exhaustive under {maxConfigs 10000, maxDepth 200, maxCompletion 64, alphabet no named trigger, store seeded from declared literal values — a guard over an attribute with no declared value is read as false} — the count beside it is the product states seen up to the witness, not the size of the product space',
      '    witness — a run this semantics admits:',
      '       0  start → Sink::Plant::Modes::nominal',
      '       1  completion nominal -> hazard → Sink::Plant::Modes::hazard  [holds p]',
    ],
  },
];
function capture(sink: string[]): typeof process.stdout.write {
  return ((chunk: string | Uint8Array, enc?: unknown, cb?: unknown): boolean => {
    sink.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    const done = typeof enc === 'function' ? enc : cb;
    if (typeof done === 'function') (done as () => void)();
    return true;
  }) as typeof process.stdout.write;
}

/** The command, in-process, as the L7 suite drives it: text and exit status. */
async function cli(args: string[]): Promise<{ code: number; stdout: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const realOut = process.stdout.write;
  const realErr = process.stderr.write;
  process.stdout.write = capture(out);
  process.stderr.write = capture(err);
  try {
    const code = await main(args);
    return { code, stdout: out.join('') };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

const MODALITY_LINE = /^    every run\? /;

describe('the annotation moved nothing on the row', () => {
  it('claim, code, witness, diagnostic severity, counts and exit code are what they were', async () => {
    for (const want of BEFORE) {
      const model = await modelOf(want.file);
      const report = behaviourReport(model, {
        machineId: machineIn(model, want.machine),
        pattern: want.pattern,
        ...(want.maxConfigs ? { maxConfigs: want.maxConfigs } : {}),
      });
      const v = report.properties[0];
      expect(
        {
          claim: v.claim,
          code: v.code,
          witness: v.witness.map((s) => [s.leaf?.name ?? null, s.holds]),
          exitCode: report.exitCode,
          counts: report.counts,
          diagnostics: report.diagnostics.map((d) => [d.severity, d.code]),
        },
        want.id,
      ).toEqual({
        claim: want.claim,
        code: want.code,
        witness: want.witness,
        exitCode: want.exitCode,
        counts: want.counts,
        diagnostics: want.diagnostics,
      });
      // And the row carries the field, decided or withheld — never absent.
      expect(v.modality, want.id).not.toBeNull();
    }
  });

  it('the text report differs from the capture by the one inserted line, and by nothing else', async () => {
    for (const want of BEFORE) {
      const r = await cli([
        'check-behaviour',
        want.file,
        '--element',
        want.machine,
        '--pattern',
        want.pattern,
        ...(want.maxConfigs ? ['--max-configs', String(want.maxConfigs)] : []),
      ]);
      expect(r.code, want.id).toBe(want.exitCode);
      const lines = r.stdout.split('\n');
      const start = lines.findIndex((l) => /^  (PASS|FAIL|VACUOUS|INCONCLUSIVE)\b/.test(l));
      const end = lines.findIndex((l) => l.startsWith('  semantic profile'));
      expect(start, want.id).toBeGreaterThanOrEqual(0);
      const block = lines.slice(start, end);
      const inserted = block.filter((l) => MODALITY_LINE.test(l));
      expect(inserted, want.id).toHaveLength(1);
      // The value word comes first on the inserted line, after the label.
      expect(inserted[0], want.id).toMatch(/^    every run\? (guaranteed —|potential —|not decided:)/);
      // It sits after the code line and before the product-states line.
      const at = block.indexOf(inserted[0]);
      expect(block[at - 1], want.id).toBe(`    ${want.code}`);
      expect(block[at + 1], want.id).toMatch(/product state\(s\) explored/);
      expect(block.filter((l) => !MODALITY_LINE.test(l)), want.id).toEqual(want.textLines);
    }
  }, 120_000);
});
