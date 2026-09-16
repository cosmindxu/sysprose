/**
 * Components of the retained relation, the acyclicity census, and the deadlock
 * row a guard in another region used to silence
 * (plan `docs/06-model-checking-implementation-plan.md` §3.P, §2.3 row A0).
 *
 * THE ARITHMETIC IS CHECKED ON GRAPHS WHOSE ANSWER IS KNOWN BY CONSTRUCTION,
 * before any sentence is printed from it. Three shipped machines are each one
 * component containing everything they reach; the trap probe is the shape the
 * component pass exists for, with its two answers — the size of the set nothing
 * leaves, and the number of configurations that cannot get back to `standby` —
 * measured apart, because they are different numbers about different questions
 * and a feature that fused them would print the first under the second.
 *
 * THE CENSUS FIELD IS THREE-VALUED AND THAT IS THE POINT OF HALF THIS FILE.
 * `acyclic` reads `null` whenever the walk is not exact, which is wider than
 * *whenever a bound was hit*: an edge behind a guard nothing decided is a
 * cycle-closing edge the walk never had, so a machine whose stated relation
 * cycles can be walked into an acyclic one and a boolean would publish the
 * artefact. Two fixtures pin the wrong answer by name — the unresolved-endpoint
 * model, whose walk builds no relation at all, and the two-state trapguard
 * model, whose walk builds a relation that is missing exactly the edge that
 * closes its cycle.
 *
 * AND THE DEADLOCK ROW. The shipped gate empties the whole array when any guard
 * anywhere in the machine was left undecided. `deadlock-guarded.sysml` is the
 * machine that shows what that costs: an undecided way out of `holding`, and a
 * real sink at `done` that no guard was ever consulted about. The row for
 * `done` is a fact about the design; the row for `holding` is a question the
 * walk did not answer. They are now told apart.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Model, type ElementId } from '@core/index';
import { loadModelText } from '@text/load';
import {
  DEADLOCK_WITHHELD_SENTENCE,
  exploreMachine,
  reachReport,
  stateMachinesIn,
  type ExploreResult,
  type MachineReach,
} from '../../src/semantics/mc/explore';
import { checkProperty } from '../../src/semantics/mc/patterns';
import {
  acyclic,
  bottomComponents,
  reverseReachable,
  tarjanComponents,
} from '../../src/semantics/mc/scc';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

/** One machine of one file, walked. */
interface Walked {
  model: Model;
  machineId: ElementId;
  walk: ExploreResult;
}

/** Every machine of a file, walked, keyed by the qualified name of the machine. */
async function walkFile(file: string): Promise<Map<string, Walked>> {
  const loaded = await loadModelText(read(file), { fileName: file });
  const model = loaded.model!;
  const out = new Map<string, Walked>();
  for (const machine of stateMachinesIn(model)) {
    out.set(model.qualifiedName(machine.id), {
      model,
      machineId: machine.id,
      walk: exploreMachine(model, machine.id),
    });
  }
  return out;
}

/** The `reach` row for one machine of one file. */
async function reachRow(file: string, qualifiedName: string): Promise<MachineReach> {
  const loaded = await loadModelText(read(file), { fileName: file });
  const row = reachReport(loaded.model!).machines.find(
    (m) => m.machine.qualifiedName === qualifiedName,
  );
  expect(row, `${file} no longer declares ${qualifiedName}`).toBeDefined();
  return row!;
}

/** The leaf name of a node number, so a component reads as states. */
function leafNames(w: Walked, nodes: readonly number[]): string[] {
  return nodes
    .map((i) => {
      const leaf = w.walk.configLeaves[i];
      return leaf === null || leaf === undefined ? '<none>' : (w.model.get(leaf)?.declaredName ?? '?');
    })
    .sort();
}

/* ═══════════════ the components of the three shipped machines ════════════════ */

describe('Tarjan over the relation the walk retained', () => {
  const FILES = {
    uav: 'examples/uav-isr.sysml',
    vehicle: 'examples/vehicle.sysml',
    tour: 'examples/views-tour.sysml',
  };
  const walks = new Map<string, Walked>();

  beforeAll(async () => {
    for (const [key, file] of Object.entries(FILES)) {
      const loaded = await loadModelText(read(file), { fileName: file });
      const model = loaded.model!;
      const [machine] = stateMachinesIn(model);
      walks.set(key, { model, machineId: machine.id, walk: exploreMachine(model, machine.id) });
    }
  }, 120_000);

  it('makes `FlightModes` ONE component of 4, which is its own bottom component', () => {
    const w = walks.get('uav')!;
    const comps = tarjanComponents(w.walk.successors);
    expect(comps.members).toHaveLength(1);
    expect(comps.members[0]).toHaveLength(4);
    expect(leafNames(w, comps.members[0])).toEqual([
      'autonomous',
      'failsafe',
      'manual',
      'standby',
    ]);
    // Every node is in it, so every node's component number is the same one.
    expect([...new Set(comps.componentOf)]).toEqual([0]);
    const bottom = bottomComponents(w.walk.successors);
    expect(bottom).toHaveLength(1);
    expect(bottom[0]).toEqual(comps.members[0]);
    // A whole-graph component is why this machine raises no trap row: the set
    // nothing leaves is the graph, opening included.
    expect(acyclic(w.walk.successors)).toBe(false);
  });

  it('makes `vehicle` one component of 3 and `views-tour` one of 2, both cyclic', () => {
    const vehicle = walks.get('vehicle')!;
    const vComps = tarjanComponents(vehicle.walk.successors);
    expect(vComps.members).toHaveLength(1);
    expect(leafNames(vehicle, vComps.members[0])).toEqual(['idling', 'moving', 'off']);
    expect(bottomComponents(vehicle.walk.successors)).toEqual([vComps.members[0]]);
    expect(acyclic(vehicle.walk.successors)).toBe(false);

    const tour = walks.get('tour')!;
    const tComps = tarjanComponents(tour.walk.successors);
    expect(tComps.members).toHaveLength(1);
    expect(leafNames(tour, tComps.members[0])).toEqual(['flying', 'standby']);
    expect(bottomComponents(tour.walk.successors)).toEqual([tComps.members[0]]);
    expect(acyclic(tour.walk.successors)).toBe(false);
  });

  it('is computed over the relation and not over its spanning tree, so all three read CYCLIC', () => {
    // The regression this pins is one commit upstream: an edge recorded only at
    // the admission point leaves the breadth-first spanning tree, which has one
    // edge fewer than it has nodes and no cycle at all. Every machine here would
    // then read acyclic, and `{failsafe}` would come back as a component nothing
    // leaves on the flagship example.
    for (const key of ['uav', 'vehicle', 'tour']) {
      const w = walks.get(key)!;
      expect(acyclic(w.walk.successors), key).toBe(false);
      expect(w.walk.successors.flat().length).toBeGreaterThan(w.walk.configs - 1);
    }
  });
});

/* ════════════════ the two `off -> on` fixtures, acyclic by shape ═════════════ */

describe('a machine that steps once and stops', () => {
  const FILES = [
    'test/fixtures/agent-authoring/L2-bare-transition-arrow/fixed.sysml',
    'test/fixtures/agent-authoring/L3-unresolved-transition-end/fixed.sysml',
  ];

  it('is acyclic, one component per configuration, and the second is the bottom one', async () => {
    for (const file of FILES) {
      const machines = await walkFile(file);
      const [w] = [...machines.values()];
      expect(w.walk.configs, file).toBe(2);
      expect(acyclic(w.walk.successors), file).toBe(true);
      const comps = tarjanComponents(w.walk.successors);
      expect(comps.members.map((c) => c.length), file).toEqual([1, 1]);
      const bottom = bottomComponents(w.walk.successors);
      // The ending, and only the ending: the opening configuration has an edge
      // out of its own component, so it is not one.
      expect(bottom, file).toEqual([[1]]);
      expect(leafNames(w, bottom[0])[0], file).toMatch(/^(on|running)$/);
    }
  });
});

/* ═══════════════ the trap probe: two numbers, two questions ══════════════════ */

describe('the trap probe', () => {
  const FILE = 'test/fixtures/verification/models/trap-probe.sysml';
  let w: Walked;

  beforeAll(async () => {
    w = (await walkFile(FILE)).get('TrapProbe::Probe::Modes')!;
  }, 120_000);

  it('walks five configurations over the relation the model states', () => {
    expect(w.walk.configs).toBe(5);
    expect(w.walk.depth).toBe(4);
    expect(w.walk.exhaustive).toBe(true);
    expect(w.walk.boundHit).toBe('none');
    // No guard, no dwell, no named trigger: the retained relation is the
    // machine's, which is what makes every number below a number about the
    // design rather than about the walk.
    expect(w.walk.undeterminedGuards).toEqual([]);
    expect(w.walk.timedTransitions.size).toBe(0);
    expect(w.walk.bounds.alphabet).toEqual([]);
    expect(w.walk.census.counts.unaccounted).toBe(0);
  });

  it('has a bottom component of TWO — and a second cycle that is a component but not a bottom one', () => {
    const comps = tarjanComponents(w.walk.successors);
    expect(comps.members.map((c) => leafNames(w, c))).toEqual([
      ['failsafe', 'failsafeHold'],
      ['alpha', 'beta'],
      ['standby'],
    ]);
    const bottom = bottomComponents(w.walk.successors);
    expect(bottom).toHaveLength(1);
    expect(bottom[0]).toHaveLength(2);
    expect(leafNames(w, bottom[0])).toEqual(['failsafe', 'failsafeHold']);
    // `{alpha, beta}` cycles just as hard and `beta` leaves it, which is the
    // distinction a size-based reading of "nothing leaves this" would lose.
    expect(leafNames(w, comps.members[1])).toEqual(['alpha', 'beta']);
    expect(bottom.map((c) => leafNames(w, c))).not.toContainEqual(['alpha', 'beta']);
  });

  it('has FOUR configurations that cannot reach `standby`, which is not the bottom component’s two', () => {
    const standby = w.walk.configLeaves.findIndex(
      (leaf) => leaf !== null && w.model.get(leaf)?.declaredName === 'standby',
    );
    expect(standby).toBe(0);
    const canReach = reverseReachable(w.walk.successors, [standby]);
    // Nothing returns to the opening, so the set that can reach it is the
    // opening alone.
    expect([...canReach]).toEqual([0]);
    const cannot = w.walk.successors.map((_, i) => i).filter((i) => !canReach.has(i));
    expect(cannot).toHaveLength(4);
    expect(leafNames(w, cannot)).toEqual(['alpha', 'beta', 'failsafe', 'failsafeHold']);
    // THE TWO NUMBERS, ASSERTED APART. A report that printed the bottom
    // component's size under the recovery question would say 2 here, and 2 is
    // the answer to the other question.
    expect(cannot.length).not.toBe(bottomComponents(w.walk.successors)[0].length);
  });

  it('answers reverse reachability REFLEXIVELY, so a configuration reaches the state it stands in', () => {
    for (let i = 0; i < w.walk.configs; i++) {
      expect(reverseReachable(w.walk.successors, [i]).has(i), `node ${i}`).toBe(true);
    }
    // And the whole graph reaches the trap, because every run arrives there.
    const failsafe = w.walk.configLeaves.findIndex(
      (leaf) => leaf !== null && w.model.get(leaf)?.declaredName === 'failsafe',
    );
    expect(reverseReachable(w.walk.successors, [failsafe]).size).toBe(5);
  });
});

/* ════════════════ the iterative claim, on a graph that would blow ════════════ */

describe('the component pass is iterative', () => {
  it('walks a 5,000-configuration chain without touching the call stack', () => {
    const n = 5_000;
    // A chain, plus one edge back from the end to the start: one component of
    // 5,000, which is the deepest recursion Tarjan can be asked for at this
    // size and the shape a recursive transcription dies on.
    const successors: number[][] = Array.from({ length: n }, (_, i) => (i + 1 < n ? [i + 1] : [0]));
    const comps = tarjanComponents(successors);
    expect(comps.members).toHaveLength(1);
    expect(comps.members[0]).toHaveLength(n);
    expect(acyclic(successors)).toBe(false);
    expect(bottomComponents(successors, comps)).toHaveLength(1);
    expect(reverseReachable(successors, [0]).size).toBe(n);

    // The same size with no back edge: 5,000 components, still one frame.
    const open: number[][] = Array.from({ length: n }, (_, i) => (i + 1 < n ? [i + 1] : []));
    expect(tarjanComponents(open).members).toHaveLength(n);
    expect(acyclic(open)).toBe(true);
    expect(bottomComponents(open)).toEqual([[n - 1]]);
  });

  it('calls a self-loop a cycle, which a component-size reading alone would not', () => {
    // `hazard -> hazard` is one component of one node, so the size test reads
    // "no cycle" and the edge test reads the truth.
    expect(tarjanComponents([[0]]).members).toEqual([[0]]);
    expect(acyclic([[0]])).toBe(false);
    expect(acyclic([[]])).toBe(true);
    expect(bottomComponents([[0]])).toEqual([[0]]);
  });

  it('refuses an edge naming a configuration the walk never numbered', () => {
    // The producer's invariant, asserted here as well as at the producer: a
    // target a bound refused is never given a number. A phantom node would be
    // trivially its own bottom component and trivially acyclic, which is the
    // silent wrong answer this raises instead.
    expect(() => tarjanComponents([[1]])).toThrow(/names node 1 .*has 1 node/);
    expect(() => acyclic([[1]])).toThrow(/names node 1/);
    expect(() => bottomComponents([[1]], { members: [[0]], componentOf: [0] })).toThrow(
      /names node 1/,
    );
    expect(() => reverseReachable([[1]], [0])).toThrow(/names node 1/);
  });

  it('refuses a TARGET naming a configuration the walk never numbered, in both directions', () => {
    // The other half of the same refusal, and the half that fails in the
    // direction the lane cares about: a target outside the range used to be
    // dropped silently, and the answer over a three-cycle asked about node 9
    // was the EMPTY set — *nothing can reach it* — which a caller counting
    // "configurations that cannot reach `p`" reads as all of them. A numbering
    // mistake one off would have manufactured the maximal refutation.
    const cycle = [[1], [2], [0]];
    expect([...reverseReachable(cycle, [0])].sort()).toEqual([0, 1, 2]);
    expect(() => reverseReachable(cycle, [9])).toThrow(/asked about node 9, but the walk has 3 node/);
    expect(() => reverseReachable(cycle, [-1])).toThrow(/asked about node -1/);
    // A target that is in range beside one that is not still raises: the set
    // is either every configuration the caller meant or it is an error.
    expect(() => reverseReachable(cycle, [0, 3])).toThrow(/asked about node 3/);
    // And a DUPLICATE target is not a defect: asking twice about one node is a
    // set with repeats, and the answer is the answer for the set.
    expect([...reverseReachable(cycle, [0, 0])].sort()).toEqual([0, 1, 2]);
  });

  it('refuses components computed over a different relation', () => {
    // `bottomComponents` and `acyclic` accept a precomputed pass so one Tarjan
    // run answers several questions; handed the components of ANOTHER graph
    // they used to answer about neither. Measured: singleton components read
    // against a three-cycle returned `[]` — no set is inescapable — where the
    // relation alone returns the one component there is. The length mismatch
    // is the cheap half of that defect and the half worth refusing.
    const cycle = [[1], [2], [0]];
    expect(bottomComponents(cycle)).toEqual([[0, 1, 2]]);
    const foreign = { members: [[0], [1]], componentOf: [0, 1] };
    expect(() => bottomComponents(cycle, foreign)).toThrow(
      /components cover 2 node\(s\) but the relation has 3/,
    );
    expect(() => acyclic(cycle, foreign)).toThrow(/components cover 2 node\(s\) but the relation has 3/);
    // The same-length mismatch is NOT caught — the comment on the producer says
    // so — and the case above that hands `bottomComponents([[1]], …)` a
    // one-node pass reaches the edge check for exactly that reason.
    expect(bottomComponents(cycle, tarjanComponents(cycle))).toEqual([[0, 1, 2]]);
  });
});

/* ══════════════ the census field, and the two wrong answers it pins ══════════ */

describe('`acyclic` is three-valued, and reads `null` on a walk that was not exact', () => {
  it('reads `false` on the three shipped machines, which cycle', async () => {
    for (const [file, name] of [
      ['examples/uav-isr.sysml', 'UAVSurveillanceSystem::FlightModes'],
      ['examples/vehicle.sysml', 'VehicleModel::VehicleStates'],
      ['examples/views-tour.sysml', 'DroneDemo::FlightModes'],
    ] as const) {
      const row = await reachRow(file, name);
      expect(row.exactness.acyclic, name).toBe(false);
      expect(row.exactness.walkIsExact, name).toBe(true);
      expect(row.exactness.failedClause, name).toBeNull();
    }
  }, 120_000);

  it('reads `true` on the acyclic fixture, so the field is not a constant', async () => {
    const row = await reachRow(
      'test/fixtures/agent-authoring/L3-unresolved-transition-end/fixed.sysml',
      'P::M',
    );
    expect(row.exactness.acyclic).toBe(true);
    expect(row.exactness.walkIsExact).toBe(true);
    expect(row.exactness.edges).toBe(1);
    expect(row.exactness.openFrontier).toBe(false);
  });

  it('reads `null` on the unsupported-construct walk — NEVER `true`, over a relation that was never built', async () => {
    const row = await reachRow(
      'test/fixtures/agent-authoring/L3-unresolved-transition-end/input.sysml',
      'P::M',
    );
    expect(row.configs).toBe(0);
    expect(row.exactness.edges).toBe(0);
    expect(row.exactness.openFrontier).toBe(true);
    // THE NAMED WRONG ANSWER. An empty relation has no cycle, so a boolean
    // computed off the graph reads `true` here — a census field stating a
    // property of a graph the engine refused to walk, on the one machine class
    // it refuses. Lane G's release gate counts `acyclic === true`.
    expect(row.exactness.acyclic).toBeNull();
    expect(row.exactness.acyclic).not.toBe(true);
    expect(row.exactness.walkIsExact).toBe(false);
    expect(row.exactness.failedClause).toBe('unsupported');
  });

  it('reads `null` on the two-state trapguard machine, whose missing edge is the one that closes its cycle', async () => {
    const row = await reachRow(
      'test/fixtures/verification/models/trapguard.sysml',
      'TrapGuard::TwoState::Modes',
    );
    // The walk finished, inside every bound, and the relation it retained is
    // two nodes and one edge — because `degraded -> nominal` is behind a guard
    // nothing valued.
    expect(row.exhaustive).toBe(false);
    expect(row.boundHit).toBe('none');
    expect(row.exactness.openFrontier).toBe(false);
    expect(row.exactness.edges).toBe(1);
    expect(row.exactness.undeterminedGuards).toBe(1);
    // THE NAMED WRONG ANSWER, and it is the reason the field is not gated on
    // `openFrontier`: this walk hit no bound at all, so an `openFrontier`
    // reading publishes `acyclic: true` about a machine whose stated relation
    // is `nominal -> degraded -> nominal`.
    expect(row.exactness.acyclic).toBeNull();
    expect(row.exactness.acyclic).not.toBe(true);
    expect(row.exactness.walkIsExact).toBe(false);
    expect(row.exactness.failedClause).toBe('store');
  });

  it('reads `false` on the same machine once the guard is decided and the edge is back', async () => {
    const row = await reachRow(
      'test/fixtures/verification/models/trapguard-true.sysml',
      'TrapGuardTrue::TwoState::Modes',
    );
    expect(row.exactness.undeterminedGuards).toBe(0);
    expect(row.exactness.walkIsExact).toBe(true);
    // The escape edge closes the cycle the other walk could not see. Same
    // machine, same shape, one literal apart — and the answers are `false` and
    // `null`, never `true` and `true`.
    expect(row.exactness.acyclic).toBe(false);
    expect(row.exactness.edges).toBe(2);
  });

  it('records the exactness census beside it, one number per clause', async () => {
    const latch = await reachRow('test/fixtures/verification/models/latch.sysml', 'Latch::Latch::Modes');
    // The one file in the tree that names a trigger: clause (c) fails, the
    // walk is otherwise whole, and the census says which of the four numbers
    // is the non-zero one.
    expect(latch.exactness.alphabet).toBe(1);
    expect(latch.exactness.timedTransitions).toBe(0);
    expect(latch.exactness.timedLabels).toBe(0);
    expect(latch.exactness.undeterminedGuards).toBe(0);
    expect(latch.exactness.walkIsExact).toBe(false);
    expect(latch.exactness.failedClause).toBe('environment');
    expect(latch.exactness.acyclic).toBeNull();

    const probe = await reachRow(
      'test/fixtures/verification/models/trap-probe.sysml',
      'TrapProbe::Probe::Modes',
    );
    expect(probe.exactness).toEqual({
      acyclic: false,
      openFrontier: false,
      edges: 6,
      timedTransitions: 0,
      timedLabels: 0,
      alphabet: 0,
      undeterminedGuards: 0,
      walkIsExact: true,
      failedClause: null,
    });
  }, 120_000);

  it('is a payload field and not a report row, so no sentence of the walk names it', () => {
    // The census is a kill MEASUREMENT — what says whether a later lane has any
    // customer at all — and not a finding a reader acts on. It is published on
    // `--json` and the text block never prints it; the process-level half of
    // that assertion is in the CLI campaign, and the half here is that nothing
    // the report composes for a person carries the word.
    const rendered = readFileSync(resolve(process.cwd(), 'scripts/sysprose.ts'), 'utf8');
    const block = /function machineLines\([\s\S]*?\n}\n/.exec(rendered);
    expect(block, 'scripts/sysprose.ts no longer renders a machine block').not.toBeNull();
    expect(block![0]).not.toContain('exactness');
    expect(block![0]).not.toContain('acyclic');
    // And the half of the report that DOES print from this commit: the block
    // renders the withheld rows, one line each, in the one sentence exported
    // for it — so an API caller and the CLI withhold a row in the same words.
    expect(block![0]).toContain('m.deadlocksWithheld');
    expect(block![0]).toContain('DEADLOCK_WITHHELD_SENTENCE');
    expect(DEADLOCK_WITHHELD_SENTENCE).toContain('a guard the walk consulted decided nothing');
  });
});

/* ═══════════ A0: a guard in one region no longer silences a sink in another ══ */

describe('the deadlock row survives an undecided guard somewhere else in the machine', () => {
  const FILE = 'test/fixtures/verification/models/deadlock-guarded.sysml';
  const MACHINE = 'DeadlockGuarded::Ctrl::Modes';
  let row: MachineReach;
  let walk: ExploreResult;
  let model: Model;

  beforeAll(async () => {
    row = await reachRow(FILE, MACHINE);
    const walked = (await walkFile(FILE)).get(MACHINE)!;
    walk = walked.walk;
    model = walked.model;
  }, 120_000);

  it('finds both configurations nothing leaves, before anything is withheld', () => {
    expect(walk.deadlocks.map((d) => d.leaf.name)).toEqual(['holding', 'done']);
    expect(walk.undeterminedGuards).toHaveLength(1);
    expect(walk.undeterminedGuards[0].guard).toBe('resetOk');
    expect(walk.undeterminedGuards[0].transition.from!.name).toBe('holding');
  });

  it('publishes `done` and withholds `holding`, which is the whole of the strengthening', () => {
    // BEFORE: the walk-wise gate emptied the array, so `done` — a sink no guard
    // was ever consulted about — was lost with `holding`, whose only way out is
    // a question nothing answered. The walk-wise gate is not relaxed by this:
    // on every machine where no guard is undetermined the two readings are the
    // same expression, because the set of undecided edges is empty.
    expect(row.deadlocks.map((d) => d.leaf.name)).toEqual(['done']);
    expect(row.deadlocks).toHaveLength(1);
    expect(row.deadlocks[0].leaf.name).not.toBe('holding');
  });

  it('keeps the rest of the row withheld, because the other lists are walk-wise claims', () => {
    // A deadlock row is an absence over ONE configuration's outgoing edges, so
    // it can be decided one configuration at a time. `unreachable` and `dead`
    // are absences over the whole walk and are not: the undecided edge could
    // have led anywhere, so both stay empty and the qualification still says
    // THOSE lists are withheld.
    expect(row.suppressed).toBe(true);
    expect(row.states.unreachable).toEqual([]);
    expect(row.transitions.dead).toEqual([]);
    expect(row.qualification).toContain('1 guard(s) the walk could not evaluate');
    expect(row.qualification).toContain(
      'the unreachable and dead lists are WITHHELD and are NOT reported as findings',
    );
  });

  it('carries the withheld row out, and no sentence says the published one was withheld', () => {
    // THE REPORT MUST NOT CONTRADICT ITSELF ABOUT ONE MACHINE. Before this was
    // asserted, the qualification enumerated *the unreachable, dead and
    // no-way-out lists* as withheld three lines above a published `no way out`
    // row — true by construction only while the whole array was emptied. Now
    // the withheld half travels with the published half, and every sentence
    // that names the no-way-out list as withheld counts it from these rows.
    expect(row.deadlocksWithheld.map((d) => d.leaf.name)).toEqual(['holding']);
    expect(row.deadlocks.map((d) => d.leaf.name)).toEqual(['done']);
    expect(
      [...row.deadlocks, ...row.deadlocksWithheld].map((d) => d.leaf.name).sort(),
    ).toEqual(walk.deadlocks.map((d) => d.leaf.name).sort());
    expect(row.qualification).not.toContain('no-way-out lists');
    expect(row.qualification).toContain(
      'as is the no-way-out row for 1 configuration(s) whose only ways out are guards this walk could not decide',
    );
    // The finding raised for the guard names what it withheld the same way.
    const report = reachReport(model);
    const guardRows = report.diagnostics.filter(
      (d) => d.code === 'verification/guard-undetermined' && d.elementName?.includes('Ctrl'),
    );
    expect(guardRows).toHaveLength(1);
    expect(guardRows[0].message).toContain('the unreachable and dead lists for this machine are withheld');
    expect(guardRows[0].message).toContain('as is the no-way-out row for 1 configuration(s)');
    expect(guardRows[0].message).not.toContain('no-way-out lists');
    // And the published row is a finding, beside it.
    expect(
      report.diagnostics
        .filter((d) => d.code === 'verification/deadlock')
        .map((d) => d.elementName),
    ).toEqual(['DeadlockGuarded::Ctrl::Modes::done']);
  });

  it('is described the same way by `check-behaviour`, which speaks about `reach` on the same machine', async () => {
    // The one place the two commands speak about each other. `check-behaviour`
    // reports a property over this machine inconclusive and says what `reach`
    // withholds for the same reason — and it must not say `reach` withholds a
    // row `reach` prints. It names the two lists that go walk-wise, and no
    // third.
    const { model, machineId } = (await walkFile(FILE)).get(MACHINE)!;
    const verdict = checkProperty(model, machineId, {
      pattern: 'absence',
      scope: 'after',
      q: 'state done',
      p: 'state nominal',
      // The two provenance fields a `--pattern` flag carries.
      source: 'flag',
      carrier: null,
    });
    expect(verdict.claim).toBe('inconclusive');
    expect(verdict.detail).toContain(
      '`reach` on the same machine withholds its unreachable and dead lists for the same reason',
    );
    expect(verdict.detail).not.toContain('no-way-out');
  });

  it('leaves the two fixture machines that carry a deadlock and no guard byte-identical', async () => {
    // The measured non-regression: neither `on` nor `running` carries a guard,
    // so both gates are vacuously true on them and their rows do not move. No
    // shipped example carries a deadlock row at all.
    for (const [file, name] of [
      ['test/fixtures/agent-authoring/L2-bare-transition-arrow/fixed.sysml', 'on'],
      ['test/fixtures/agent-authoring/L3-unresolved-transition-end/fixed.sysml', 'running'],
    ] as const) {
      const r = await reachRow(file, 'P::M');
      expect(r.deadlocks.map((d) => d.leaf.name), file).toEqual([name]);
      expect(r.deadlocks[0].steps, file).toBe(1);
      expect(r.undeterminedGuards, file).toEqual([]);
    }
    const succ = await reachRow(
      'test/fixtures/verification/models/succession-mixed.sysml',
      'SuccMix::Ctrl::Modes',
    );
    expect(succ.deadlocks.map((d) => d.leaf.name)).toEqual(['done']);
  }, 120_000);

  it('asks the question of the whole active STACK, so a guard on a composite still withholds', async () => {
    // The leaf-only reading of this rule is the one that looks right and is
    // not: `sub2` has no outgoing transition of its own, so a check scoped to
    // the leaf finds nothing undecided and publishes the row — about a
    // configuration whose way out is `degraded -> nominal`, an edge the model
    // states, the step relation offers at every configuration inside
    // `degraded`, and this walk could not decide.
    const nested = 'DeadlockGuarded::Nested::Modes';
    const w = (await walkFile(FILE)).get(nested)!;
    expect(w.walk.deadlocks.map((d) => d.leaf.name)).toEqual(['sub2']);
    const row = w.walk.deadlocks[0];
    expect(row.stack.map((s) => s.name)).toEqual(['degraded', 'sub2']);
    expect(w.walk.undeterminedGuards[0].transition.from!.name).toBe('degraded');

    const published = await reachRow(FILE, nested);
    expect(published.deadlocks).toEqual([]);
    expect(published.deadlocksWithheld.map((d) => d.leaf.name)).toEqual(['sub2']);
    expect(published.suppressed).toBe(true);
  }, 120_000);

  it('still withholds every row on a machine whose only leaf is undecided', async () => {
    // `GuardProbe::Ctrl` is the corpus witness for the store clause, and the
    // configuration it stands in has exactly one way out — behind the guard
    // that decided nothing. Nothing survives the filter there, which is the
    // measurement that says this is a strengthening of availability and not a
    // relaxation of the gate.
    const r = await reachRow(
      'test/fixtures/verification/models/guard-undetermined.sysml',
      'GuardProbe::Ctrl::Modes',
    );
    expect(r.undeterminedGuards).toHaveLength(1);
    expect(r.deadlocks).toEqual([]);
    // Withheld, not lost: the row the walk found is carried out under the
    // sentence that says why it is not a finding.
    expect(r.deadlocksWithheld.map((d) => d.leaf.name)).toEqual(['idle']);
    expect(r.suppressed).toBe(true);
  });
});
