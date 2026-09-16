/**
 * Traps on `reach` — the configurations no run leaves
 * (plan `docs/06-model-checking-implementation-plan.md` §3.2a).
 *
 * EVERY ASSERTION HERE NAMES THE WRONG ANSWER IT EXCLUDES, because each of them
 * was a wrong answer some revision of the plan would have shipped. A trap is a
 * bottom strongly-connected component of the retained relation that survives
 * three exemptions — an ending, a deadlock row, the component holding the
 * opening — and it is published under ONE gate, `walkIsExact`, which is the
 * increasing gate and not the decreasing conjunction the unreachable and dead
 * lists read. The two halves of this file follow that split:
 *
 *  1. **The exemptions.** The mission DAG into `done` produces no row and prints
 *     the no-trap sentence naming 1 ending exempted; the two-state sink produces
 *     `verification/deadlock` AND the same sentence naming 1 deadlocked
 *     configuration exempted,
 *     in one output — the self-contradiction the draft's wording ("nothing this
 *     walk found is inescapable") would have shipped beside a deadlock row; the
 *     three shipped machines are one whole-graph component each and are silent.
 *  2. **The gate.** One fixture per mechanism that can make the retained
 *     relation differ from the machine's: a preempted dwell (time), a trigger
 *     nobody may send (environment), a guard nobody bound (store), and a bound.
 *     On every one of them the field is EMPTIED, never shortened, and the
 *     no-trap sentence is not written either — a refusal is not a clean bill.
 *
 * `trapguard.sysml` holds TWO machines, so every argv assertion over it is
 * scoped to the block of the machine it is about.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Model, ModelFactory, type ElementId } from '@core/index';
import { loadModelText } from '@text/load';
import {
  DEADLOCK_CODE,
  NONDETERMINISTIC_CHOICE_CODE,
  TRAP_ENTRY_WALK_ADMITS,
  TRAP_REFUSAL_SENTENCE,
  UNRECOVERABLE_MODE_CODE,
  boundsSentence,
  exploreMachine,
  reachReport,
  stateMachinesIn,
  type MachineReach,
  type ReachReport,
} from '../../src/semantics/mc/explore';
import {
  DWELL_SENTENCE,
  environmentSentence,
  SIMULATOR_SENTENCE,
} from '../../src/semantics/mc/publishable';
import { main as sysproseMain } from '../../scripts/sysprose';

const root = (p: string) => resolve(process.cwd(), p);
const read = (p: string) => readFileSync(root(p), 'utf8');
const FIX = 'test/fixtures/verification/models';

async function load(file: string): Promise<Model> {
  const loaded = await loadModelText(read(file), { fileName: file });
  expect(loaded.model, `${file} did not load`).toBeDefined();
  return loaded.model!;
}

/**
 * The command in-process, stdout captured — the campaign's `run` shape, because
 * `reach` is not solver-bearing and what is asserted here is the TEXT it prints.
 */
async function cli(args: string[]): Promise<{ code: number; stdout: string }> {
  const out: string[] = [];
  const realOut = process.stdout.write;
  const realErr = process.stderr.write;
  const sink =
    (): typeof process.stdout.write =>
    (chunk: unknown): boolean => {
      out.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    };
  process.stdout.write = sink();
  process.stderr.write = sink();
  let code: number;
  try {
    code = await sysproseMain(args);
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
  return { code, stdout: out.join('') };
}

/** The lines of one machine's block in the text report. */
function machineBlock(text: string, qualifiedName: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`  ${qualifiedName} [`));
  expect(start, `no block for ${qualifiedName} in:\n${text}`).toBeGreaterThanOrEqual(0);
  let end = start + 1;
  while (end < lines.length && lines[end].startsWith('    ')) end++;
  return lines.slice(start, end).join('\n');
}

const names = (rows: readonly { name: string }[]) => rows.map((r) => r.name);

/** The no-trap accounting, byte for byte, as the plan states it. */
function noTrapSentence(
  m: MachineReach,
  counts: { ending: number; deadlock: number; core: number },
): string {
  return (
    `no component of this walk is inescapable beyond its endings — ${counts.ending} ending, ` +
    `${counts.deadlock} deadlocked configuration(s) and ${counts.core} whole-graph component were exempted, ` +
    `exhaustive under ${boundsSentence(m.bounds)}`
  );
}

/** The null shape every refused walk publishes: facts about the relation stay, answers about the machine go. */
function expectRefused(m: MachineReach, clause: 'bound' | 'environment' | 'time' | 'store'): void {
  expect(m.traps, `${m.machine.qualifiedName}: a refused walk published a trap list`).toEqual([]);
  expect(m.trapCensus.refusedByGate).toBe(clause);
  expect(m.trapCensus.sentence, 'a refused walk wrote the no-trap sentence').toBeNull();
  // The wrong answer: a numeric `exemptedAsDeadlock` about a node that only
  // LOOKS like a sink because the edge out of it was never retained.
  expect(m.trapCensus.trapsAfterExemptions).toBeNull();
  expect(m.trapCensus.exemptedAsEnding).toBeNull();
  expect(m.trapCensus.exemptedAsDeadlock).toBeNull();
  expect(m.trapCensus.exemptedAsCore).toBeNull();
  expect(m.trapCensus.sccs).toBeTypeOf('number');
  expect(m.trapCensus.bottomSccs).toBeTypeOf('number');
}

const trapCodes = (r: ReachReport) =>
  r.diagnostics.filter((d) => d.code === UNRECOVERABLE_MODE_CODE);

/* ═══════════════════════ the positive fixture ═══════════════════════ */

describe('the trap probe: one set of configurations nothing leaves', () => {
  const file = `${FIX}/trap-probe.sysml`;
  let report: ReachReport;

  beforeAll(async () => {
    report = reachReport(await load(file));
  }, 60_000);

  it('publishes one trap of two configurations, entered in three steps', () => {
    const m = report.machines[0];
    expect(m.exactness.walkIsExact).toBe(true);
    expect(m.traps).toHaveLength(1);
    const [t] = m.traps;
    expect(t.configs).toBe(2);
    // The union of the active STACKS over the component, never the leaves —
    // the two are the same on this flat machine; `composite-trap.sysml`, in
    // the block after the exemptions, is where they differ.
    expect(names(t.states)).toEqual(['failsafe', 'failsafeHold']);
    expect(names(t.entry)).toEqual(['standby', 'alpha', 'beta', 'failsafe']);
    expect(t.steps).toBe(3);
  });

  it('is `verification/unrecoverable-mode`, a warning, at exit 0 — the finding names declared states', () => {
    const rows = trapCodes(report);
    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe('warning');
    expect(rows[0].message).toContain(
      'trap — 2 configuration(s) form a set nothing leaves: {failsafe, failsafeHold}. Entered in 3 step(s) from `standby`.',
    );
    expect(rows[0].elementName).toBe('TrapProbe::Probe::Modes::failsafe');
    expect(report.totals.traps).toBe(1);
  });

  it('prints the simulator sentence beside the trap row, because `beta` is a choice point', () => {
    // §2.4(d): every increasing claim is about the MACHINE's semantics, and on
    // a machine with a nondeterministic choice the reader is told so rather
    // than left to reproduce the trap with `simulate` and fail.
    const m = report.machines[0];
    expect(m.nondeterminism.map((n) => n.state.name)).toEqual(['beta']);
    expect(report.diagnostics.some((d) => d.code === NONDETERMINISTIC_CHOICE_CODE)).toBe(true);
    expect(trapCodes(report)[0].message).toContain(SIMULATOR_SENTENCE);
  });

  it('records the census: three components, one bottom, one trap, nothing exempted', () => {
    expect(report.machines[0].trapCensus).toEqual({
      sccs: 3,
      bottomSccs: 1,
      trapsAfterExemptions: 1,
      exemptedAsEnding: 0,
      exemptedAsDeadlock: 0,
      exemptedAsCore: 0,
      refusedByGate: null,
      // The no-trap sentence is for the machines with no trap. This one has one.
      sentence: null,
    });
  });

  it('argv: the text block carries the trap row and the finding', async () => {
    const r = await cli(['reach', root(file)]);
    expect(r.code).toBe(0);
    const block = machineBlock(r.stdout, 'TrapProbe::Probe::Modes');
    expect(block).toContain(
      '    trap         {failsafe, failsafeHold} — 2 configuration(s) nothing leaves; entered in 3 step(s) from standby',
    );
    expect(r.stdout).toContain('verification/unrecoverable-mode');
    // The JSON payload carries the row with no CLI edit: the whole report is
    // the payload.
    const j = await cli(['reach', root(file), '--json']);
    const body = JSON.parse(j.stdout) as { reach: ReachReport };
    expect(body.reach.machines[0].traps[0].configs).toBe(2);
    expect(body.reach.diagnostics.map((d) => d.code)).toContain(UNRECOVERABLE_MODE_CODE);
  }, 60_000);

  it('`--max-configs 2` EMPTIES the list — never a 1-row list over a frontier that looks like a sink', async () => {
    const m = reachReport(await load(file), { maxConfigs: 2 }).machines[0];
    expect(m.boundHit).toBe('configs');
    expectRefused(m, 'bound');
    expect(trapCodes(reachReport(await load(file), { maxConfigs: 2 }))).toEqual([]);
    // The relation the bound left behind: two nodes, and the second's only
    // successor was never numbered — so to Tarjan it is a bottom component,
    // which is exactly why the exemption counts above are `null` and not `1`.
    expect(m.trapCensus.sccs).toBe(2);
    expect(m.trapCensus.bottomSccs).toBe(1);
  }, 60_000);

  it('`--max-configs 3` is where a bound INVENTS a trap, and the list is still empty', async () => {
    // THE BOUND'S REAL WRONG ANSWER. At 2 the frontier node is a no-successor
    // singleton and exemption 1 empties the list whatever the gate says; at 3
    // the walk retains `alpha ⇄ beta` and refuses `beta -> failsafe`, so the
    // relation is `[[1],[2],[1]]` and `{alpha, beta}` is a bottom component
    // of the WALK that is a genuine cycle with an escape in the MACHINE. Any
    // gate looser than `walkIsExact` — `decreasingOk`, "finished or bounded" —
    // publishes `trap — 2 configuration(s) form a set nothing leaves:
    // {alpha, beta}` here. Measured on the walk, then asserted on the report.
    const model = await load(file);
    const walk = exploreMachine(model, stateMachinesIn(model)[0].id, { maxConfigs: 3 });
    expect(walk.boundHit).toBe('configs');
    expect(walk.successors).toEqual([[1], [2], [1]]);
    const r = reachReport(model, { maxConfigs: 3 });
    const m = r.machines[0];
    expectRefused(m, 'bound');
    expect(m.trapCensus.sccs).toBe(2);
    expect(m.trapCensus.bottomSccs).toBe(1);
    expect(trapCodes(r)).toEqual([]);
    expect(r.diagnostics.map((d) => d.message).join('\n')).not.toContain('{alpha, beta}');
    const c = await cli(['reach', root(file), '--max-configs', '3']);
    expect(c.code).toBe(0);
    expect(c.stdout).not.toContain('    trap ');
    expect(c.stdout).toContain('SUPPRESSED');
  }, 60_000);
});

/* ═══════════════════════ the three exemptions ═══════════════════════ */

describe('exemption 2: an ending is not a trap', () => {
  it('the mission DAG into `done` publishes no row and names 1 ending exempted', async () => {
    const model = await load(`${FIX}/mission-dag.sysml`);
    const r = reachReport(model);
    const m = r.machines[0];
    expect(m.exactness.walkIsExact).toBe(true);
    expect(m.traps).toEqual([]);
    expect(trapCodes(r)).toEqual([]);
    expect(m.deadlocks).toEqual([]);
    expect(m.trapCensus).toEqual({
      sccs: 5,
      bottomSccs: 1,
      trapsAfterExemptions: 0,
      exemptedAsEnding: 1,
      exemptedAsDeadlock: 0,
      exemptedAsCore: 0,
      refusedByGate: null,
      sentence: noTrapSentence(m, { ending: 1, deadlock: 0, core: 0 }),
    });
    // Byte for byte: the draft's "every reachable configuration lies in one
    // component" is false on this file — five components — and would have
    // printed anyway.
    expect(m.trapCensus.sentence).toBe(
      'no component of this walk is inescapable beyond its endings — 1 ending, 0 deadlocked configuration(s) and 0 whole-graph component were exempted, exhaustive under ' +
        boundsSentence(m.bounds),
    );
  }, 60_000);
});

describe('exemption 1: a configuration with no successor is already `verification/deadlock`', () => {
  it('the two-state sink reports the deadlock, no trap, and a sentence that names the deadlock it exempted — in ONE output', async () => {
    const r = reachReport(await load(`${FIX}/sink.sysml`));
    const m = r.machines[0];
    expect(m.deadlocks.map((d) => d.leaf.name)).toEqual(['b']);
    expect(r.diagnostics.map((d) => d.code)).toEqual([DEADLOCK_CODE]);
    expect(m.traps).toEqual([]);
    // THE SELF-CONTRADICTION TEST. A row above says `b` has no way out; the
    // sentence below must not say nothing is inescapable. It says what it
    // exempted, and equality with the published rows holds on this shape.
    expect(m.trapCensus.exemptedAsDeadlock).toBe(m.deadlocks.length);
    expect(m.trapCensus).toEqual({
      sccs: 2,
      bottomSccs: 1,
      trapsAfterExemptions: 0,
      exemptedAsEnding: 0,
      exemptedAsDeadlock: 1,
      exemptedAsCore: 0,
      refusedByGate: null,
      sentence: noTrapSentence(m, { ending: 0, deadlock: 1, core: 0 }),
    });
    expect(m.trapCensus.sentence).toContain('1 deadlocked configuration(s)');
  }, 60_000);

  it('two configurations at one sink state are two exemptions beside ONE deadlock row — the sentence counts configurations, not rows', () => {
    // `start -> A` twice, with two effects: the walk stands at `A` under two
    // stores, both with no successor, and `recordDeadlock` dedupes rows by
    // leaf. The wrong answer is a sentence saying "2 deadlock row(s)" beside
    // a report that shows one — a decided figure under the wrong noun.
    const { model, machineId } = twoSinkConfigsMachine();
    const walk = exploreMachine(model, machineId);
    expect(walk.successors).toEqual([[1, 2], [], []]);
    const r = reachReport(model);
    const m = r.machines[0];
    expect(m.exactness.walkIsExact).toBe(true);
    expect(m.deadlocks.map((d) => d.leaf.name)).toEqual(['A']);
    expect(r.diagnostics.filter((d) => d.code === DEADLOCK_CODE)).toHaveLength(1);
    expect(m.traps).toEqual([]);
    expect(m.trapCensus.exemptedAsDeadlock).toBe(2);
    expect(m.trapCensus.sentence).toBe(noTrapSentence(m, { ending: 0, deadlock: 2, core: 0 }));
    expect(m.trapCensus.sentence).toContain('2 deadlocked configuration(s)');
    expect(m.trapCensus.sentence).not.toContain('row');
  });
});

describe('the states of a trap: the active stacks, never the leaves alone', () => {
  const file = `${FIX}/composite-trap.sysml`;

  it('a cycle inside a composite names the composite — `{degraded, sub2, sub1}`, not `{sub1, sub2}`', async () => {
    const r = reachReport(await load(file));
    const m = r.machines[0];
    expect(m.exactness.walkIsExact).toBe(true);
    expect(m.traps).toHaveLength(1);
    const [t] = m.traps;
    expect(t.configs).toBe(2);
    // The wrong answer: `['sub1', 'sub2']`, the leaves — a reader told the run
    // is stuck in `{sub1, sub2}` is never told it is stuck in `degraded`. The
    // order is node order, and `sub2`'s configuration is discovered first
    // inside the component.
    expect(names(t.states)).toEqual(['degraded', 'sub2', 'sub1']);
    expect(names(t.states)).not.toEqual(['sub1', 'sub2']);
    expect(names(t.entry)).toEqual(['nominal', 'sub1', 'sub2']);
    expect(t.steps).toBe(2);
    expect(trapCodes(r)[0].message).toContain(
      'trap — 2 configuration(s) form a set nothing leaves: {degraded, sub2, sub1}. Entered in 2 step(s) from `nominal`.',
    );
  }, 60_000);

  it('argv: the composite is inside the braces', async () => {
    const r = await cli(['reach', root(file)]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      '    trap         {degraded, sub2, sub1} — 2 configuration(s) nothing leaves; entered in 2 step(s) from nominal',
    );
    expect(r.stdout).not.toContain('{sub1, sub2}');
  }, 60_000);

  it('a state can stand in a deadlock row AND in a trap when two stores put two configurations at it — the rows are per configuration', () => {
    // `start -> X` under `x = 1` and under `x = 2`; `X -> Y` only when `x == 2`;
    // `Y -> X`. Node 1 (`X`, x=1) is a sink and a deadlock row; nodes 2–3
    // (`X` and `Y`, x=2) cycle and are a trap. The plan's MUST NEVER — a trap
    // row and a deadlock row about ONE CONFIGURATION — holds: the two rows are
    // about different configurations that happen to share a state name, and
    // the census partitions the bottom components. A test that forbade the
    // state NAME from appearing in both would forbid a true report.
    const { model, machineId } = overlapMachine();
    const walk = exploreMachine(model, machineId);
    expect(walk.successors).toEqual([[1, 2], [], [3], [2]]);
    expect(walk.undeterminedGuards).toEqual([]);
    const r = reachReport(model);
    const m = r.machines[0];
    expect(m.exactness.walkIsExact).toBe(true);
    expect(m.deadlocks.map((d) => d.leaf.name)).toEqual(['X']);
    expect(m.traps).toHaveLength(1);
    expect(m.traps[0].configs).toBe(2);
    expect(names(m.traps[0].states)).toEqual(['X', 'Y']);
    expect(m.trapCensus.bottomSccs).toBe(2);
    expect(m.trapCensus.exemptedAsDeadlock).toBe(1);
    expect(m.trapCensus.trapsAfterExemptions).toBe(1);
    expect(r.diagnostics.map((d) => d.code)).toEqual([
      DEADLOCK_CODE,
      UNRECOVERABLE_MODE_CODE,
      NONDETERMINISTIC_CHOICE_CODE,
    ]);
  });
});

describe('exemption 3: the component holding the opening is the reachable set, not a trap', () => {
  for (const file of ['examples/uav-isr.sysml', 'examples/vehicle.sysml', 'examples/views-tour.sysml']) {
    it(`${file} is silent, and its no-trap sentence names 1 whole-graph component`, async () => {
      const r = reachReport(await load(file));
      expect(r.machines).toHaveLength(1);
      const m = r.machines[0];
      expect(m.traps).toEqual([]);
      expect(trapCodes(r)).toEqual([]);
      // Without this exemption `FlightModes`' entire operating region — one
      // component of all four configurations, none final — is a trap row.
      expect(m.trapCensus.exemptedAsCore).toBe(1);
      expect(m.trapCensus.trapsAfterExemptions).toBe(0);
      expect(m.trapCensus.sentence).toBe(noTrapSentence(m, { ending: 0, deadlock: 0, core: 1 }));
    }, 60_000);
  }
});

/* ═══════════════════════ the gate, one fixture per mechanism ═══════════════════════ */

/**
 * `failsafe ⇄ failsafeHold` on dwells, with an escape the interpreter would
 * never take: `after(5)` is declared before `after(60)`, so the real machine
 * preempts the escape every time, while the walk offers both. Factory-built,
 * because `accept after(n)` is a parse error (plan §0 correction 22).
 */
function preemptedDwellMachine(): { model: Model; machineId: ElementId } {
  const m = new Model();
  const f = new ModelFactory(m);
  const sm = f.stateDef('Dwells');
  const standby = f.state('standby', sm.id);
  const failsafe = f.state('failsafe', sm.id);
  const failsafeHold = f.state('failsafeHold', sm.id);
  f.transition(standby.id, failsafe.id, { ownerId: sm.id });
  f.transition(failsafe.id, failsafeHold.id, { ownerId: sm.id, trigger: 'after(5)' });
  f.transition(failsafe.id, standby.id, { ownerId: sm.id, trigger: 'after(60)' });
  f.transition(failsafeHold.id, failsafe.id, { ownerId: sm.id, trigger: 'after(5)' });
  return { model: m, machineId: sm.id };
}

/** The same machine with its dwells spelled as numeric `attrs.after` — no label at all. */
function numericAfterMachine(): { model: Model; machineId: ElementId } {
  const m = new Model();
  const f = new ModelFactory(m);
  const sm = f.stateDef('Dwells');
  const standby = f.state('standby', sm.id);
  const failsafe = f.state('failsafe', sm.id);
  const failsafeHold = f.state('failsafeHold', sm.id);
  f.transition(standby.id, failsafe.id, { ownerId: sm.id });
  for (const [from, to, after] of [
    [failsafe, failsafeHold, 5],
    [failsafe, standby, 60],
    [failsafeHold, failsafe, 5],
  ] as const) {
    m.create('TransitionUsage', {
      ownerId: sm.id,
      attrs: { after },
      source: [from.id],
      target: [to.id],
    });
  }
  return { model: m, machineId: sm.id };
}

/** `start -> A` twice under two effects: two configurations at one sink state. */
function twoSinkConfigsMachine(): { model: Model; machineId: ElementId } {
  const m = new Model();
  const f = new ModelFactory(m);
  const sm = f.stateDef('M');
  const start = f.state('start', sm.id);
  const a = f.state('A', sm.id);
  f.transition(start.id, a.id, { ownerId: sm.id, effect: 'x = 1' });
  f.transition(start.id, a.id, { ownerId: sm.id, effect: 'x = 2' });
  return { model: m, machineId: sm.id };
}

/** `X` is a sink under `x = 1` and inside the `X ⇄ Y` cycle under `x = 2`. */
function overlapMachine(): { model: Model; machineId: ElementId } {
  const m = new Model();
  const f = new ModelFactory(m);
  const sm = f.stateDef('M');
  const start = f.state('start', sm.id);
  const x = f.state('X', sm.id);
  const y = f.state('Y', sm.id);
  f.transition(start.id, x.id, { ownerId: sm.id, effect: 'x = 1' });
  f.transition(start.id, x.id, { ownerId: sm.id, effect: 'x = 2' });
  f.transition(x.id, y.id, { ownerId: sm.id, guard: 'x == 2' });
  f.transition(y.id, x.id, { ownerId: sm.id });
  return { model: m, machineId: sm.id };
}

describe('clause (b), time: a dwell the walk takes without a clock', () => {
  it('the preempted dwell refuses on `time` — the wrong answer is the no-trap sentence', () => {
    const { model, machineId } = preemptedDwellMachine();
    expect(stateMachinesIn(model).map((x) => x.id)).toEqual([machineId]);
    const r = reachReport(model);
    const m = r.machines[0];
    // The walk sees an escape from `{failsafe, failsafeHold}` — the `after(60)`
    // edge — that the interpreter never takes, so its relation is one SCC and
    // exemption 3 would print "no component of this walk is inescapable" about
    // a machine whose failsafe is genuinely inescapable. The gate refuses first.
    expect(m.exactness.failedClause).toBe('time');
    expectRefused(m, 'time');
    expect(trapCodes(r)).toEqual([]);
  });

  it('the numeric-`attrs.after` spelling refuses on `time` too, with no label in the alphabet', () => {
    const { model, machineId } = numericAfterMachine();
    const walk = exploreMachine(model, machineId);
    expect(walk.bounds.alphabet).toEqual([]);
    expect(walk.timedTransitions.size).toBe(3);
    const m = reachReport(model).machines[0];
    expectRefused(m, 'time');
  });

  it('argv on a dwell machine is not possible, and the text path prints the dwell sentence in-process', async () => {
    // The refusal line the CLI prints is composed from the same constants the
    // report exposes; no `.sysml` file can carry a dwell, so the line is
    // asserted through the constant it prints rather than through argv.
    expect(TRAP_REFUSAL_SENTENCE.time).toContain('inconclusive:');
    expect(TRAP_REFUSAL_SENTENCE.time).toContain('after(n)');
    expect(DWELL_SENTENCE).toContain('advances no clock');
  });
});

describe('clause (c), environment: a trigger nobody may send', () => {
  const file = `${FIX}/latch.sysml`;

  it('the latch refuses on `environment` — the wrong answer names 1 whole-graph component', async () => {
    const r = reachReport(await load(file));
    const m = r.machines[0];
    expect(m.bounds.alphabet).toEqual(['unlatch']);
    expectRefused(m, 'environment');
    // Measured: one SCC of two containing the opening — and it is one SCC only
    // because the walk supplies `unlatch`. Exemption 3 would fire and publish
    // "no component of this walk is inescapable beyond its endings … 1
    // whole-graph component was exempted" about a design in which `locked` is
    // inescapable unless somebody sends `unlatch`.
    expect(m.trapCensus.sccs).toBe(1);
    expect(m.trapCensus.bottomSccs).toBe(1);
    expect(m.trapCensus.exemptedAsCore).toBeNull();
    expect(r.diagnostics.filter((d) => d.code?.startsWith('verification/'))).toEqual([]);
  }, 60_000);

  it('argv: rc 0, the environment `inconclusive` line and the standing sentence, and still no finding', async () => {
    const r = await cli(['reach', root(file)]);
    expect(r.code).toBe(0);
    const block = machineBlock(r.stdout, 'Latch::Latch::Modes');
    // THE NAMED NEGATIVE TEST. The standing sentence is about the trigger THIS
    // machine names — `unlatch` — and about no other. The constant it replaced
    // was §2.4(a) verbatim with the plan's example trigger inside it, and this
    // very line asserted `reach` printing *a witness that consumes \`abort\`*
    // about a file in which `abort` occurs nowhere.
    expect(block).toContain(`    ${TRAP_REFUSAL_SENTENCE.environment}; ${environmentSentence(['unlatch'])}`);
    expect(block, 'the example trigger of the plan, printed about a machine that never names it').not.toContain('consumes `abort`');
    expect(block).not.toContain('inconclusive inconclusive');
    expect(block).not.toContain('    trap ');
    expect(r.stdout).not.toContain('inescapable');
    // No finding line: the report's diagnostics block is empty. (The fixture
    // PATH and the profile text both contain `verification/`, so the check is
    // on the payload, not on a substring of the transcript.)
    const j = await cli(['reach', root(file), '--json']);
    expect((JSON.parse(j.stdout) as { reach: ReachReport }).reach.diagnostics).toEqual([]);
  }, 60_000);
});

describe('clause (d), store: a guard nobody bound', () => {
  const TRAP = 'TrapGuard::Trap::Modes';
  const WRONG =
    'trap — 2 configuration(s) form a set nothing leaves: {degradedA, degradedB}. Entered in 1 step(s) from `nominal`.';

  it('the base file refuses on `store` — the wrong answer is a trap row naming {degradedA, degradedB}', async () => {
    const r = reachReport(await load(`${FIX}/trapguard.sysml`));
    const trap = r.machines.find((m) => m.machine.qualifiedName === TRAP)!;
    expect(trap.undeterminedGuards).toHaveLength(1);
    expectRefused(trap, 'store');
    // The relation is missing the escape edge because nothing decided it, so
    // `{degradedA, degradedB}` is a bottom component of the WALK and not of
    // the machine — the row below is what an ungated pass publishes.
    expect(trap.trapCensus.bottomSccs).toBe(1);
    // The joined-string form: `not.toContain` over an array compares members
    // with `===`, so an asymmetric matcher there matches nothing and asserts
    // nothing.
    expect(r.diagnostics.map((d) => d.message).join('\n')).not.toContain(WRONG);
    expect(trapCodes(r)).toEqual([]);
    // Both machines in the file are refused on the same clause.
    for (const m of r.machines) expect(m.trapCensus.refusedByGate).toBe('store');
  }, 60_000);

  it('argv on the base file: the store `inconclusive` line in the Trap block, and no trap row', async () => {
    const r = await cli(['reach', root(`${FIX}/trapguard.sysml`)]);
    expect(r.code).toBe(0);
    const block = machineBlock(r.stdout, TRAP);
    expect(block).toContain(`    ${TRAP_REFUSAL_SENTENCE.store}`);
    expect(block).not.toContain('inconclusive inconclusive');
    expect(block).not.toContain('    trap ');
    expect(r.stdout).not.toContain('unrecoverable-mode');
  }, 60_000);

  it('`= false`: the guard is decided, the gate holds, and the trap row IS published', async () => {
    const r = reachReport(await load(`${FIX}/trapguard-false.sysml`));
    const trap = r.machines.find((m) => m.machine.qualifiedName === 'TrapGuardFalse::Trap::Modes')!;
    expect(trap.undeterminedGuards).toEqual([]);
    expect(trap.exactness.walkIsExact).toBe(true);
    expect(trap.traps).toHaveLength(1);
    expect(names(trap.traps[0].states)).toEqual(['degradedA', 'degradedB']);
    expect(names(trap.traps[0].entry)).toEqual(['nominal', 'degradedA']);
    expect(trap.transitions.dead).toHaveLength(1);
    const rows = trapCodes(r);
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toContain(WRONG);
    expect(rows[0].elementName).toBe('TrapGuardFalse::Trap::Modes::degradedA');
    // No choice point in this machine, so no simulator sentence beside the row.
    expect(rows[0].message).not.toContain(SIMULATOR_SENTENCE);
    // The sibling `TwoState` is the two-state sink: exemption 1, in the same
    // output, with the sentence naming the deadlock it exempted.
    const two = r.machines.find((m) => m.machine.qualifiedName === 'TrapGuardFalse::TwoState::Modes')!;
    expect(two.deadlocks.map((d) => d.leaf.name)).toEqual(['degraded']);
    expect(two.traps).toEqual([]);
    expect(two.trapCensus.exemptedAsDeadlock).toBe(two.deadlocks.length);
    expect(two.trapCensus.sentence).toBe(noTrapSentence(two, { ending: 0, deadlock: 1, core: 0 }));
  }, 60_000);

  it('argv on `= false`: the trap row prints in the Trap block only', async () => {
    const r = await cli(['reach', root(`${FIX}/trapguard-false.sysml`)]);
    expect(r.code).toBe(0);
    const block = machineBlock(r.stdout, 'TrapGuardFalse::Trap::Modes');
    expect(block).toContain(
      '    trap         {degradedA, degradedB} — 2 configuration(s) nothing leaves; entered in 1 step(s) from nominal',
    );
    expect(machineBlock(r.stdout, 'TrapGuardFalse::TwoState::Modes')).not.toContain('    trap ');
    expect(r.stdout).toContain('verification/unrecoverable-mode');
  }, 60_000);

  it('`= true`: the escape edge is retained, the relation is one SCC holding the opening, and exemption 3 fires', async () => {
    // Putting this variant in the positive slot lands the test red and invites
    // weakening exemption 3 — which is what gives `FlightModes` a trap row
    // over its whole operating region. It is the no-trap case, deliberately.
    const r = reachReport(await load(`${FIX}/trapguard-true.sysml`));
    const trap = r.machines.find((m) => m.machine.qualifiedName === 'TrapGuardTrue::Trap::Modes')!;
    expect(trap.exactness.walkIsExact).toBe(true);
    expect(trap.traps).toEqual([]);
    expect(trap.trapCensus.sccs).toBe(1);
    expect(trap.trapCensus.exemptedAsCore).toBe(1);
    expect(trap.trapCensus.sentence).toBe(noTrapSentence(trap, { ending: 0, deadlock: 0, core: 1 }));
    expect(trapCodes(r)).toEqual([]);
  }, 60_000);

  it('`-typed`: a fully valued feature under a guard that still decides nothing is the SHIPPED predicate, and refuses on `store`', async () => {
    const r = reachReport(await load(`${FIX}/trapguard-typed.sysml`));
    const trap = r.machines[0];
    expect(trap.undeterminedGuards).toHaveLength(1);
    expect(trap.undeterminedGuards[0].unresolved).toEqual([]);
    // The narrower reading — "no declared value" — is satisfied here and would
    // publish the trap row over a missing edge with the gate green.
    expectRefused(trap, 'store');
    expect(trapCodes(r)).toEqual([]);
  }, 60_000);

  it('`deadlock-guarded`: both machines refused on `store` while `Ctrl`’s decided sink keeps its deadlock row', async () => {
    // A0 and this feature never disagree on one file: the deadlock row is gated
    // per configuration and `done` (a STATE named `done`, not a `done` node) is
    // a decided sink, so it is published; the trap field is gated on the whole
    // walk and the walk carries an undecided guard, so it is refused.
    const r = reachReport(await load(`${FIX}/deadlock-guarded.sysml`));
    expect(r.machines).toHaveLength(2);
    const ctrl = r.machines.find((m) => m.machine.qualifiedName === 'DeadlockGuarded::Ctrl::Modes')!;
    expect(ctrl.deadlocks.map((d) => d.leaf.name)).toEqual(['done']);
    expect(ctrl.deadlocksWithheld.map((d) => d.leaf.name)).toEqual(['holding']);
    for (const m of r.machines) expectRefused(m, 'store');
    expect(trapCodes(r)).toEqual([]);
  }, 60_000);
});

/* ═══════════════════════ what is never printed ═══════════════════════ */

describe('the sentences this feature is forbidden', () => {
  const FILES = [
    `${FIX}/trap-probe.sysml`,
    `${FIX}/mission-dag.sysml`,
    `${FIX}/sink.sysml`,
    `${FIX}/latch.sysml`,
    `${FIX}/trapguard.sysml`,
    `${FIX}/trapguard-false.sysml`,
    `${FIX}/trapguard-true.sysml`,
    `${FIX}/trapguard-typed.sysml`,
    `${FIX}/deadlock-guarded.sysml`,
    `${FIX}/composite-trap.sysml`,
    'examples/uav-isr.sysml',
  ];

  it('the W2 re-wording exists and is printed nowhere while A6 gates the row', async () => {
    // The sentence is written now so a per-claim relaxation of the gate cannot
    // be made silently; the row is suppressed whole under A6, so it never
    // reaches an output.
    expect(TRAP_ENTRY_WALK_ADMITS).toContain('on a run this WALK admits');
    for (const file of FILES) {
      const r = await cli(['reach', root(file)]);
      expect(r.stdout, file).not.toContain(TRAP_ENTRY_WALK_ADMITS);
      const j = await cli(['reach', root(file), '--json']);
      expect(j.stdout, file).not.toContain(TRAP_ENTRY_WALK_ADMITS);
    }
  }, 120_000);

  it('the no-trap sentence is `--json` only, never a text row; a refusal prints neither', async () => {
    for (const file of FILES) {
      const r = await cli(['reach', root(file)]);
      expect(r.stdout, file).not.toContain('inescapable beyond its endings');
      const report = reachReport(await load(file));
      for (const m of report.machines) {
        if (m.trapCensus.refusedByGate !== null) {
          expect(m.traps, `${file} ${m.machine.qualifiedName}`).toEqual([]);
          expect(m.trapCensus.sentence, `${file} ${m.machine.qualifiedName}`).toBeNull();
        } else {
          expect(m.trapCensus.sentence === null, `${file} ${m.machine.qualifiedName}`).toBe(
            m.traps.length > 0,
          );
        }
        // A trap row and a deadlock row about one configuration: never. The
        // invariant is at CONFIGURATION granularity — the census partitions
        // the bottom components, so a component counted twice or dropped
        // reddens the sum. A state NAME may stand in both rows (see the
        // overlap machine above): two stores, two configurations, one state.
        if (m.trapCensus.refusedByGate === null) {
          const c = m.trapCensus;
          expect(
            c.exemptedAsEnding! + c.exemptedAsDeadlock! + c.exemptedAsCore! + c.trapsAfterExemptions!,
            `${file} ${m.machine.qualifiedName}: the exemptions and the traps do not partition the bottom components`,
          ).toBe(c.bottomSccs);
        }
      }
    }
  }, 120_000);

  it('no output says the machine is recoverable, or free of deadlocks, or livelocks', async () => {
    for (const file of FILES) {
      const r = await cli(['reach', root(file)]);
      expect(r.stdout, file).not.toMatch(/\brecoverab|livelock|deadlock-free|always recover/i);
    }
  }, 120_000);
});
