/**
 * `recovery` — reverse reachability to a named state (plan
 * `docs/06-model-checking-implementation-plan.md` §3.2b): from every
 * configuration the walk reached, can the machine get back to `p`?
 *
 * WHAT IS PINNED, AND WHAT EACH PIN NAMES AS THE WRONG ANSWER. `AG EF p` is a
 * branching-time question, and this engine is a bad-prefix search — which finds
 * no bad prefix for it on ANY graph and would answer `pass` for free. So the
 * headline assertion here is about POSITION: the arm sits after the
 * unsupported-construct refusal and before the search, and it never reaches
 * the search. Every other case is a machine whose answer is known by
 * construction, with the answer it must not print named beside it:
 *
 *  - the trap probe reads `not recoverable` naming FOUR configurations, with
 *    the trap row's TWO in its own clause — never the one number under the
 *    other's question;
 *  - the three shipped machines read `recoverable`, reflexively: the opening
 *    configuration reaches its own state in zero steps and is never reported;
 *  - on a composite state, `state degraded` matches every configuration inside
 *    it and `node degraded` matches NONE — read through `atomHolds`'s own
 *    selection, asserted against `atomHolds` on every configuration, with the
 *    shipped `absence` pair beside it; `recovery p = node degraded` answering
 *    `recoverable` at exit 0 is the wrong answer;
 *  - an unreachable `p` is a `fail`, never `vacuous`;
 *  - `fires`, `trigger` and `expression` atoms are refused as
 *    `verification/malformed-property` and never earn `verification/refuted`,
 *    the `expression` reason byte-identical to §3.R's row 4;
 *  - the three gate fixtures, one per mechanism: the preempted dwell (time,
 *    `recoverable` named wrong), the latch (environment, `recoverable` at exit
 *    0 named wrong — the draft's A7 held on that walk), and the trapguard
 *    (store, `not recoverable: 2 …` at exit 1 named wrong — the one fixture
 *    whose wrong answer is a REFUTATION, and the reason the arm gates both
 *    directions);
 *  - `trapguard-false` is the one file where `not recoverable` legitimately
 *    publishes, and `trapguard-true` reads `recoverable`.
 *
 * AND NOTHING ELSE MOVED: every non-recovery row on the behaviour fixtures is
 * pinned byte-for-byte against a golden captured on the tree before the arm
 * existed (`test/fixtures/verification/behaviour-golden-b97f391.json`).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Model, ModelFactory, type ElementId } from '@core/index';
import { loadModelText } from '@text/load';
import {
  BEHAVIOUR_UNSUPPORTED_CODE,
  BOUND_EXHAUSTED_CODE,
  GUARD_UNDETERMINED_CODE,
  exploreMachine,
  machineAlphabet,
  stateMachinesIn,
} from '../../src/semantics/mc/explore';
import {
  PATTERNS,
  STEP_ATOM_REASON,
  STORE_ATOM_REASON,
  behaviourReport,
  checkProperty,
  type PropertyText,
  type PropertyVerdict,
} from '../../src/semantics/mc/patterns';
import {
  ABSENCE_CLAIMS,
  CLAUSE_SENTENCE,
  DWELL_SENTENCE,
  ENVIRONMENT_SENTENCE,
  SIMULATOR_SENTENCE,
  publishabilityOf,
  walkIsExact,
} from '../../src/semantics/mc/publishable';
import { MALFORMED_PROPERTY_CODE, atomHolds, readAtom } from '../../src/semantics/mc/atoms';
import {
  hashConfig,
  initialConfig,
  seedStore,
  stepCandidates,
  stepConfig,
  type MachineConfig,
} from '../../src/semantics/mc/config';
import { diagnosticCode } from '@text/index';
import { main } from '../../scripts/sysprose';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

const MODELS = 'test/fixtures/verification/models';
const FILES = {
  uav: 'examples/uav-isr.sysml',
  vehicle: 'examples/vehicle.sysml',
  viewsTour: 'examples/views-tour.sysml',
  probe: `${MODELS}/trap-probe.sysml`,
  latch: `${MODELS}/latch.sysml`,
  trapguard: `${MODELS}/trapguard.sysml`,
  trapguardTrue: `${MODELS}/trapguard-true.sysml`,
  trapguardFalse: `${MODELS}/trapguard-false.sysml`,
  trapguardTyped: `${MODELS}/trapguard-typed.sysml`,
  composite: `${MODELS}/recovery-composite.sysml`,
  sealed: `${MODELS}/cover-sealed.sysml`,
};

function prop(fields: Partial<PropertyText> & { pattern: string; scope: string }): PropertyText {
  return { source: 'flag', carrier: null, ...fields };
}
/** `recovery × globally` over one atom — the shape every decided case has. */
const recovery = (p: string): PropertyText => prop({ pattern: 'recovery', scope: 'globally', p });
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
  const el = model.all().find((e) => model.qualifiedName(e.id) === name || e.declaredName === name);
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

async function reportOf(file: string, machine: string, pattern: string, maxConfigs?: number) {
  const model = await modelOf(file);
  return behaviourReport(model, { machineId: machineIn(model, machine), pattern, ...(maxConfigs ? { maxConfigs } : {}) });
}

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

const RECOVERY = 'pattern=recovery, scope=globally, p=';

/** The row every arm answer must have in common, refusals included. */
function expectArmShape(v: PropertyVerdict, walkConfigs: number): void {
  expect(v.pattern).toBe('recovery');
  expect(v.patternClass).toBe('branching');
  expect(v.configs).toBe(walkConfigs);
  expect(v.machineConfigs).toBe(walkConfigs);
  expect(v.witness).toEqual([]);
  expect(v.modality).toBeNull();
  expect(v.activated).toBe(true);
  expect(v.recovery, 'a recovery row carries its census').toBeDefined();
}

beforeAll(async () => {
  for (const file of Object.values(FILES)) await modelOf(file);
}, 120_000);

/* ═══════════════════════════ the dispatch ═══════════════════════════ */

describe('the dispatch: a branching-time question never reaches the bad-prefix search', () => {
  const src = read('src/semantics/mc/patterns.ts');

  it('`recoveryRow` reads `walkIsExact` and `reverseReachable`, and nothing from the search or the decreasing family', () => {
    // THE REGISTER IS THE WIRING, AND THIS READS THE WIRE — the same shape as
    // the `reachOne` and `modalityOf` assertions in the publishable suite.
    // `search` is module-private, so "never reaches `search`, asserted by a
    // spy" is asserted off the source instead: the arm's body names none of
    // the search's symbols, and `checkProperty` returns to it before the
    // search is called.
    const body = /function recoveryRow\([\s\S]*?\n}\n/.exec(src);
    expect(body, 'patterns.ts no longer declares recoveryRow').not.toBeNull();
    const arm = body![0];
    expect(arm).toContain('walkIsExact(');
    expect(arm).toContain('reverseReachable(');
    for (const banned of ['search(', 'found', 'decreasingOk', 'publishabilityOf', 'searchComplete', 'walk.reachable']) {
      expect(arm, `recoveryRow reads \`${banned}\``).not.toContain(banned);
    }
    // Both directions behind ONE gate: the decided rows read the gate's own
    // field, and the target predicate is `atomHolds`'s selection per kind.
    expect(arm).toContain("atom.kind === 'state' ? walk.configStates[i].includes(id) : walk.configLeaves[i] === id");
    expect(arm).toContain('if (!gate.seenWhole)');
    expect(arm).toContain('switch (gate.failedClause)');
  });

  it("the arm sits after the unsupported refusal and before `const found = search(` in `checkProperty`'s source", () => {
    const body = /export function checkProperty\([\s\S]*?\n}\n/.exec(src);
    expect(body, 'patterns.ts no longer declares checkProperty').not.toBeNull();
    const fn = body![0];
    const walk = fn.indexOf('const walk = exploreMachine(');
    const unsupported = fn.indexOf('if (walk.unsupported.length > 0) {');
    const arm = fn.indexOf("if (property.pattern.kind === 'branching') return recoveryRow(");
    const search = fn.indexOf('const found = search(');
    expect(walk).toBeGreaterThan(-1);
    expect(unsupported).toBeGreaterThan(walk);
    expect(arm, 'checkProperty no longer dispatches the branching class').toBeGreaterThan(unsupported);
    expect(search).toBeGreaterThan(arm);
    expect(fn.match(/return recoveryRow\(/g)).toHaveLength(1);
    // And the walk is opened ONCE: the arm reads the same `walk` the
    // unsupported refusal enforced `seenWhole`'s construct conjunct on.
    expect(fn.match(/exploreMachine\(/g)).toHaveLength(1);
  });

  it('a machine with an unsupported construct is refused before the arm — the unsupported refusal wins, and no recovery census is composed', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Parallel');
    m.update(sm.id, { attrs: { parallel: true } });
    const r1 = f.state('R1', sm.id);
    const r2 = f.state('R2', sm.id);
    const a1 = f.state('a1', r1.id);
    const a2 = f.state('a2', r1.id);
    const b1 = f.state('b1', r2.id);
    const b2 = f.state('b2', r2.id);
    f.transition(a1.id, a2.id, { ownerId: r1.id });
    f.transition(b1.id, b2.id, { ownerId: r2.id });
    expect(exploreMachine(m, sm.id).unsupported.map((u) => u.construct)).toEqual(['parallel-regions']);
    const v = checkProperty(m, sm.id, recovery('state a1'));
    expect(v.claim).toBe('inconclusive');
    expect(v.code).toBe(BEHAVIOUR_UNSUPPORTED_CODE);
    expect(v.detail).toMatch(/^the machine was not walked/);
    expect(v.recovery, 'the recovery arm ran over an unexplored graph').toBeUndefined();
    expect(v.exhaustive).toBe(false);
    // The wrong answers, both named: an arm placed ahead of the refusal would
    // read an empty relation and print either of these about a machine that
    // was never walked.
    expect(v.detail).not.toContain('recoverable');
    expect(v.claim).not.toBe('pass');
    expect(v.claim).not.toBe('fail');
  });

  it('`recovery` is a catalogue pattern of class `branching`, after `cover` and before the liveness pair', () => {
    const names = PATTERNS.map((p) => p.name);
    expect(names).toEqual(['absence', 'universality', 'bounded-existence', 'precedence', 'cover', 'recovery', 'existence', 'response']);
    const row = PATTERNS.find((p) => p.name === 'recovery')!;
    expect(row.kind).toBe('branching');
    expect(row.fields).toEqual(['p']);
    expect(row.needsCount).toBe(false);
    expect(PATTERNS.filter((p) => p.kind === 'liveness').map((p) => p.name)).toEqual(['existence', 'response']);
  });
});

/* ═══════════════════════ 4 versus 2, and reflexivity ═══════════════════════ */

describe('the trap probe: four configurations cannot reach `standby`, and two of them are the trap', () => {
  it('`not recoverable` names FOUR, with the trap row’s TWO in its own clause — never one number under the other’s question', async () => {
    const r = await reportOf(FILES.probe, 'TrapProbe::Probe::Modes', `${RECOVERY}state standby`);
    const v = r.properties[0];
    expectArmShape(v, 5);
    expect(v.claim).toBe('fail');
    expect(v.code).toBe('verification/refuted');
    expect(r.exitCode).toBe(1);
    expect(r.counts).toEqual({ passed: 0, failed: 1, vacuous: 0, inconclusive: 0, covered: 0, notCovered: 0 });
    expect(v.detail).toBe(
      'not recoverable: 4 configuration(s) cannot reach `state standby`: {alpha, beta, failsafe, failsafeHold}; the nearest is entered in 1 step(s) from `standby`. Of these, 2 form a set nothing leaves — `reach` reports them as `verification/unrecoverable-mode`.',
    );
    expect(v.recovery).toEqual({ atomKind: 'state', targetConfigs: 1, cannotReach: 4, bottomSccOverlap: 2, refusedByGate: null });
    expect(v.exhaustive).toBe(true);
    expect(v.qualification).toMatch(/^exhaustive under \{maxConfigs 10000/);
    // The two wrong answers: the trap size printed as the cannot-reach
    // count, and the cannot-reach count printed as the trap size.
    expect(v.detail).not.toContain('2 configuration(s) cannot reach');
    expect(v.detail).not.toContain('Of these, 4');
    // A set, not a run: the claim word is `fail`, the text says `not
    // recoverable`, and there is no witness and no modality on the row.
    expect(v.detail).not.toContain('witness');
    // The diagnostic is the lane's one error, with the set hint and not the
    // trace hint — there is no trace to read.
    const d = r.diagnostics.find((x) => x.code === 'verification/refuted')!;
    expect(d.severity).toBe('error');
    expect(d.hint).toMatch(/^Read the set:/);
    expect(d.hint).not.toContain('witness trace');
  });

  it('the CLI prints the set under the `FAIL` row, labels the count as configurations, and exits 1', async () => {
    const r = await cli(['check-behaviour', FILES.probe, '--element', 'TrapProbe::Probe::Modes', '--pattern', `${RECOVERY}state standby`]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('FAIL         `state standby` is reachable from every reachable configuration, over the whole run');
    expect(r.stdout).toContain('not recoverable: 4 configuration(s) cannot reach `state standby`');
    expect(r.stdout).toContain('Of these, 2 form a set nothing leaves');
    expect(r.stdout).toContain('5 configuration(s) explored — exhaustive under');
    expect(r.stdout).not.toContain('product state(s) explored');
    expect(r.stdout).not.toContain('witness —');
    expect(r.stdout).toContain('error verification/refuted');
  });

  it('reflexivity: `standby` on the flagship machine is `recoverable`, exit 0, with `searchComplete` ABSENT and the simulator sentence present', async () => {
    // `standby` is the OPENING configuration. Read non-reflexively the opening
    // would be reported as unable to reach its own state.
    const r = await reportOf(FILES.uav, 'FlightModes', `${RECOVERY}state standby`);
    const v = r.properties[0];
    expectArmShape(v, 4);
    expect(v.claim).toBe('pass');
    expect(v.code).toBeNull();
    expect(r.exitCode).toBe(0);
    expect(v.recovery).toEqual({ atomKind: 'state', targetConfigs: 1, cannotReach: 0, bottomSccOverlap: 0, refusedByGate: null });
    expect(v.detail).toMatch(/^recoverable: `state standby` is reachable from every reachable configuration, exhaustive under \{maxConfigs 10000/);
    // §2.4(d): the walk explored both branches at `autonomous`; the simulator
    // takes one. Printed on the row — and §2.4(a) never is: a machine that
    // names a trigger is REFUSED on this row, not qualified.
    expect(v.detail).toContain(SIMULATOR_SENTENCE);
    expect(v.detail).not.toContain(ENVIRONMENT_SENTENCE);
    expect(v.detail).not.toContain('standby cannot');
    // The register's half of the dispatch test: no search ran, so the
    // product-search conjunct has no value — absent, never `false`.
    const model = await modelOf(FILES.uav);
    const walk = exploreMachine(model, machineIn(model, 'FlightModes'));
    expect('searchComplete' in publishabilityOf(walk)).toBe(false);
    expect(walk.nondeterminism.length).toBeGreaterThan(0);
  });

  it('`vehicle` and `views-tour` read `recoverable` too, and the choice-free one carries no simulator sentence', async () => {
    const vehicle = (await reportOf(FILES.vehicle, 'VehicleStates', `${RECOVERY}state off`)).properties[0];
    expect(vehicle.claim).toBe('pass');
    expect(vehicle.recovery!.cannotReach).toBe(0);
    expect(vehicle.detail).toContain(SIMULATOR_SENTENCE);
    const tour = (await reportOf(FILES.viewsTour, 'FlightModes', `${RECOVERY}state standby`)).properties[0];
    expect(tour.claim).toBe('pass');
    expect(tour.recovery!.cannotReach).toBe(0);
    expect(tour.detail).not.toContain(SIMULATOR_SENTENCE);
    expect(tour.detail).toMatch(/exhaustive under \{[^}]*\}$/);
  });
});

/* ═══════════════════════════ the composite pair ═══════════════════════════ */

/**
 * Every configuration of the walk, rebuilt from the exported step functions
 * with the same inputs in the same order `exploreMachine` uses, so `atomHolds`
 * can be asked at each index — §3.P deliberately retains no `MachineConfig`.
 */
function configsOf(model: Model, machineId: ElementId): MachineConfig[] {
  const seeded = new Map<string, unknown>();
  seedStore(model, model.get(machineId)!, seeded);
  const opening = initialConfig(model, machineId, { store: seeded });
  const inputs = [
    { kind: 'completion' as const },
    ...machineAlphabet(model, machineId).map((trigger) => ({ kind: 'trigger' as const, trigger })),
  ];
  const seen = new Set<string>([hashConfig(opening.config)]);
  const out: MachineConfig[] = [opening.config];
  for (let head = 0; head < out.length; head++) {
    for (const input of inputs) {
      const { enabled } = stepCandidates(model, out[head], input, true);
      if (enabled.length === 0) continue;
      const innermost = enabled[0].level;
      for (const choice of enabled) {
        if (choice.level !== innermost) continue;
        const next = stepConfig(model, out[head], choice);
        const key = hashConfig(next.config);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(next.config);
      }
    }
  }
  return out;
}

describe('one atom, two readings: the composite fixture', () => {
  it('`state degraded` matches every configuration inside it and `node degraded` matches none — asserted against `atomHolds` on every configuration, with the shipped `absence` pair beside it', async () => {
    const model = await modelOf(FILES.composite);
    const machineId = machineIn(model, 'RecoveryComposite::Ctrl::Modes');
    const walk = exploreMachine(model, machineId);
    expect(walk.configs).toBe(3);
    expect(walkIsExact(walk, walk.bounds).walkIsExact).toBe(true);

    // The rebuild mirrors the walk index for index.
    const configs = configsOf(model, machineId);
    expect(configs).toHaveLength(walk.configs);
    for (let i = 0; i < walk.configs; i++) {
      expect(configs[i].stack, `configuration ${i}`).toEqual(walk.configStates[i]);
    }
    const stateAtom = readAtom(model, machineId, 'state degraded');
    const nodeAtom = readAtom(model, machineId, 'node degraded');
    expect(stateAtom.ok && nodeAtom.ok).toBe(true);
    if (!stateAtom.ok || !nodeAtom.ok) return;
    const id = stateAtom.atom.elementId!;
    expect(nodeAtom.atom.elementId).toBe(id);
    // THE SELECTION `recoveryRow` MAKES, per kind, is `atomHolds`'s own — on
    // every configuration of the same walk.
    const stateTargets: number[] = [];
    const nodeTargets: number[] = [];
    for (let i = 0; i < walk.configs; i++) {
      const obs = { config: configs[i], input: null, transition: null };
      const viaStack = walk.configStates[i].includes(id);
      const viaLeaf = walk.configLeaves[i] === id;
      expect(atomHolds(model, stateAtom.atom, obs), `state at ${i}`).toBe(viaStack);
      expect(atomHolds(model, nodeAtom.atom, obs), `node at ${i}`).toBe(viaLeaf);
      if (viaStack) stateTargets.push(i);
      if (viaLeaf) nodeTargets.push(i);
    }
    expect(stateTargets).toEqual([1, 2]);
    expect(nodeTargets).toEqual([]);

    // The `recovery` pair. `state degraded` is reachable from everywhere;
    // `node degraded` is the leaf of nothing, so the row is the second
    // refutation — never `vacuous`, and never `recoverable` at exit 0, which is
    // what one hand-written stack predicate for both kinds printed.
    const viaState = behaviourReport(model, { machineId, pattern: `${RECOVERY}state degraded` });
    expect(viaState.properties[0].claim).toBe('pass');
    expect(viaState.properties[0].recovery).toMatchObject({ atomKind: 'state', targetConfigs: 2, cannotReach: 0 });
    expect(viaState.exitCode).toBe(0);
    const viaNode = behaviourReport(model, { machineId, pattern: `${RECOVERY}node degraded` });
    const nodeRow = viaNode.properties[0];
    expectArmShape(nodeRow, 3);
    expect(nodeRow.claim).toBe('fail');
    expect(nodeRow.claim).not.toBe('vacuous');
    expect(nodeRow.claim).not.toBe('pass');
    expect(nodeRow.code).toBe('verification/refuted');
    expect(viaNode.exitCode).toBe(1);
    expect(nodeRow.detail).toMatch(/^not recoverable: `node degraded` is the active leaf of no reachable configuration/);
    expect(nodeRow.detail).not.toContain('unreachable-state');
    expect(nodeRow.recovery).toEqual({ atomKind: 'node', targetConfigs: 0, cannotReach: 3, bottomSccOverlap: 0, refusedByGate: null });

    // And the shipped `absence` pair, measured on the same walk, which the two
    // readings must keep agreeing with: `node degraded` never holds, `state
    // degraded` holds one step in.
    const absNode = behaviourReport(model, { machineId, pattern: 'pattern=absence, scope=globally, p=node degraded' });
    expect(absNode.properties[0].claim).toBe('pass');
    expect(absNode.exitCode).toBe(0);
    const absState = behaviourReport(model, { machineId, pattern: 'pattern=absence, scope=globally, p=state degraded' });
    expect(absState.properties[0].claim).toBe('fail');
    expect(absState.properties[0].witness.length - 1).toBe(1);
    expect(absState.exitCode).toBe(1);
  });

  it('an unreachable `state` is a `fail` with the second sentence and the `reach` pointer — never `vacuous`', async () => {
    // `cover-sealed`: nothing enters `failsafe`, no trigger, no guard — the
    // gate holds and the target set is empty for a reason other than the atom
    // kind. `AG EF p` over a non-empty reachable set with no `p` anywhere is
    // decidedly false; `vacuous` would file a refutation at exit 2.
    const r = await reportOf(FILES.sealed, 'CoverProbe::Sealed::Modes', `${RECOVERY}state failsafe`);
    const v = r.properties[0];
    expectArmShape(v, 2);
    expect(v.claim).toBe('fail');
    expect(v.claim).not.toBe('vacuous');
    expect(v.code).toBe('verification/refuted');
    expect(r.exitCode).toBe(1);
    expect(v.detail).toMatch(/^not recoverable: `state failsafe` is on the stack of no reachable configuration/);
    expect(v.detail).toContain('`reach` reports it under `verification/unreachable-state`');
    expect(v.recovery).toEqual({ atomKind: 'state', targetConfigs: 0, cannotReach: 2, bottomSccOverlap: 0, refusedByGate: null });
  });
});

/* ═══════════════════ the empty-target row, and the named set ═══════════════════ */

/** `standby -> alpha`, `alpha <-> beta`, and an `orphan` nothing enters: an unreachable state beside a trap. */
function orphanMachine(): { model: Model; machineId: ElementId } {
  const m = new Model();
  const f = new ModelFactory(m);
  const sm = f.stateDef('Modes');
  const standby = f.state('standby', sm.id);
  const alpha = f.state('alpha', sm.id);
  const beta = f.state('beta', sm.id);
  f.state('orphan', sm.id);
  f.transition(standby.id, alpha.id, { ownerId: sm.id });
  f.transition(alpha.id, beta.id, { ownerId: sm.id });
  f.transition(beta.id, alpha.id, { ownerId: sm.id });
  return { model: m, machineId: sm.id };
}

/** Two leaves both spelt `idle`, under `alpha` and `beta`; `boot -> alpha -> beta`. */
function twoIdleMachine(): { model: Model; machineId: ElementId; idles: ElementId[] } {
  const m = new Model();
  const f = new ModelFactory(m);
  const sm = f.stateDef('Modes');
  const boot = f.state('boot', sm.id);
  const alpha = f.state('alpha', sm.id);
  const idleA = f.state('idle', alpha.id);
  const beta = f.state('beta', sm.id);
  const idleB = f.state('idle', beta.id);
  f.transition(boot.id, alpha.id, { ownerId: sm.id });
  f.transition(alpha.id, beta.id, { ownerId: sm.id });
  return { model: m, machineId: sm.id, idles: [idleA.id, idleB.id] };
}

/** A composite re-entered from outside: `standby -> p1 -> outer{x -> y}`, `outer -> p2 -> outer`. */
function reenteredMachine(): { model: Model; machineId: ElementId } {
  const m = new Model();
  const f = new ModelFactory(m);
  const sm = f.stateDef('Modes');
  const standby = f.state('standby', sm.id);
  const p1 = f.state('p1', sm.id);
  const outer = f.state('outer', sm.id);
  const x = f.state('x', outer.id);
  const y = f.state('y', outer.id);
  const p2 = f.state('p2', sm.id);
  f.transition(x.id, y.id, { ownerId: outer.id });
  f.transition(standby.id, p1.id, { ownerId: sm.id });
  f.transition(p1.id, outer.id, { ownerId: sm.id });
  f.transition(outer.id, p2.id, { ownerId: sm.id });
  f.transition(p2.id, outer.id, { ownerId: sm.id });
  return { model: m, machineId: sm.id };
}

describe('the empty-target row says which of two things it is, and the set can be read against its count', () => {
  it('a plain unreachable leaf under the `node` reading gets the unreachable sentence and the `reach` pointer — not the composite explanation', async () => {
    // `cover-sealed`'s `failsafe` is a leaf nothing enters. The shipped row
    // branched on the atom kind alone, so `node failsafe` printed the
    // composite explanation — advice whose `state failsafe` reads the same
    // refutation — and withheld the pointer `reach` makes true of it.
    const r = await reportOf(FILES.sealed, 'CoverProbe::Sealed::Modes', `${RECOVERY}node failsafe`);
    const v = r.properties[0];
    expectArmShape(v, 2);
    expect(v.claim).toBe('fail');
    expect(v.code).toBe('verification/refuted');
    expect(v.detail).toMatch(/^not recoverable: `node failsafe` is on the stack of no reachable configuration/);
    expect(v.detail).toContain('`reach` reports it under `verification/unreachable-state`');
    expect(v.detail).not.toContain('a composite state is on the stack inside its substates');
    // The two readings agree on the reason, so the two rows carry one sentence
    // after the atom text.
    const s = await reportOf(FILES.sealed, 'CoverProbe::Sealed::Modes', `${RECOVERY}state failsafe`);
    expect(s.properties[0].detail.replace('`state failsafe`', '`node failsafe`')).toBe(v.detail);
    // And the composite keeps its own explanation: `degraded` IS on a stack.
    const c = await reportOf(FILES.composite, 'RecoveryComposite::Ctrl::Modes', `${RECOVERY}node degraded`);
    expect(c.properties[0].detail).toContain('a composite state is on the stack inside its substates and the leaf of none');
    expect(c.properties[0].detail).not.toContain('unreachable-state');
  });

  it('the fail hint on an empty-target row promises no named set and no step count — the row carries neither', async () => {
    for (const [file, machine, p] of [
      [FILES.sealed, 'CoverProbe::Sealed::Modes', 'state failsafe'],
      [FILES.sealed, 'CoverProbe::Sealed::Modes', 'node failsafe'],
      [FILES.composite, 'RecoveryComposite::Ctrl::Modes', 'node degraded'],
    ] as const) {
      const r = await reportOf(file, machine, `${RECOVERY}${p}`);
      const d = r.diagnostics.find((x) => x.code === 'verification/refuted')!;
      expect(r.properties[0].recovery!.targetConfigs, p).toBe(0);
      expect(d.hint, p).toMatch(/^No configuration this walk reached holds the state/);
      expect(d.hint, p).not.toContain('number of steps given');
      expect(d.hint, p).not.toContain('each configuration named');
      expect(d.hint, p).not.toContain('witness trace');
    }
    // The named-set row keeps the hint that reads the set.
    const t = await reportOf(FILES.probe, 'TrapProbe::Probe::Modes', `${RECOVERY}state standby`);
    expect(t.diagnostics.find((x) => x.code === 'verification/refuted')!.hint).toMatch(/^Read the set:/);
  });

  it('the empty-target row prints the count it names and the trap overlap its census carries — one number on both surfaces', () => {
    const { model, machineId } = orphanMachine();
    const walk = exploreMachine(model, machineId);
    expect(walk.configs).toBe(3);
    const r = behaviourReport(model, { machineId, pattern: `${RECOVERY}state orphan` });
    const v = r.properties[0];
    expectArmShape(v, 3);
    expect(v.claim).toBe('fail');
    expect(v.recovery).toEqual({ atomKind: 'state', targetConfigs: 0, cannotReach: 3, bottomSccOverlap: 2, refusedByGate: null });
    // "Of these" has an antecedent — the count — and the 2 is on the row,
    // not only in the JSON.
    expect(v.detail).toContain('so none of the 3 configuration(s) this walk reached can reach it');
    expect(v.detail).toContain('Of these, 2 form a set nothing leaves — `reach` reports them as `verification/unrecoverable-mode`');
    // And the sibling row on the same machine prints the same clause off the
    // same classifier.
    const s = behaviourReport(model, { machineId, pattern: `${RECOVERY}state standby` }).properties[0];
    expect(s.detail).toContain('2 configuration(s) cannot reach `state standby`: {alpha, beta}');
    expect(s.detail).toContain('Of these, 2 form a set nothing leaves');
    expect(s.recovery!.bottomSccOverlap).toBe(2);
  });

  it('two same-named leaves are two entries, spelt by their qualified names; one state holding many configurations says so', async () => {
    const two = twoIdleMachine();
    const r = behaviourReport(two.model, { machineId: two.machineId, pattern: `${RECOVERY}state boot` }).properties[0];
    expect(r.claim).toBe('fail');
    expect(r.recovery!.cannotReach).toBe(2);
    const [qa, qb] = two.idles.map((id) => two.model.qualifiedName(id));
    expect(qa).not.toBe(qb);
    // Deduplicated by leaf identity, not spelling: `{idle}` — one name for
    // two configurations — was the shipped set.
    expect(r.detail).toContain(`cannot reach \`state boot\`: {${qa}, ${qb}};`);
    expect(r.detail).not.toContain('{idle}');

    const re = reenteredMachine();
    // Six configurations: the opening and five that cannot return to it —
    // `outer/x` is reached twice, once from `p1` and once re-entered from
    // `p2`, so five configurations rest in four states.
    const walk = exploreMachine(re.model, re.machineId);
    expect(walk.configs).toBe(6);
    const v = behaviourReport(re.model, { machineId: re.machineId, pattern: `${RECOVERY}state standby` }).properties[0];
    expect(v.claim).toBe('fail');
    expect(v.recovery!.cannotReach).toBe(5);
    // Four states rest the five configurations; the row says so beside the
    // set, so its cardinality can be read against the count that introduces
    // it — the shipped row printed "5 configuration(s) … {p1, x, y, p2}"
    // with nothing to explain the gap.
    expect(v.detail).toContain('5 configuration(s) cannot reach `state standby`: {p1, x, y, p2} (4 state(s), holding the 5 configurations between them); the nearest is entered in 1 step(s) from `standby`.');
    // And where the two agree — the trap probe, four configurations in four
    // states — no such clause is printed, so the byte-pinned sentence stands.
    const t = await reportOf(FILES.probe, 'TrapProbe::Probe::Modes', `${RECOVERY}state standby`);
    expect(t.properties[0].detail).not.toContain('holding the');
    expect(t.properties[0].detail).toContain('{alpha, beta, failsafe, failsafeHold}; the nearest');
  });
});

/* ═══════════════════════ the atom-kind gate, and the scope ═══════════════════════ */

/** A machine naming a trigger AND a named transition, so `trigger abort` and `fires T` both resolve. */
function triggeredMachine(): { model: Model; machineId: ElementId } {
  const m = new Model();
  const f = new ModelFactory(m);
  const sm = f.stateDef('Triggered');
  const idle = f.state('idle', sm.id);
  const armed = f.state('armed', sm.id);
  f.transition(idle.id, armed.id, { ownerId: sm.id });
  m.create('TransitionUsage', {
    ownerId: sm.id,
    declaredName: 'T',
    attrs: { trigger: 'abort' },
    source: [armed.id],
    target: [idle.id],
  });
  return { model: m, machineId: sm.id };
}

describe('the atom-kind gate: three kinds the configuration graph cannot observe', () => {
  // Ungated, each of these would have an EMPTY target set and land on the
  // empty-target refutation: `not recoverable … holds at no reachable
  // configuration at all`, `verification/refuted`, exit 1, about a well-formed
  // model on the strength of an atom kind the engine cannot observe. That is
  // the wrong answer every case here names.
  it('`fires T` and `trigger abort` are refused with the step reason, ahead of the environment clause', () => {
    const { model, machineId } = triggeredMachine();
    expect(machineAlphabet(model, machineId)).toEqual(['abort']);
    for (const p of ['fires T', 'trigger abort']) {
      const r = behaviourReport(model, { machineId, pattern: `${RECOVERY}${p}` });
      const v = r.properties[0];
      expectArmShape(v, 2);
      expect(v.claim, p).toBe('inconclusive');
      expect(v.code, p).toBe(MALFORMED_PROPERTY_CODE);
      expect(v.code, p).not.toBe('verification/refuted');
      expect(r.exitCode, p).toBe(2);
      expect(v.detail, p).toContain(STEP_ATOM_REASON);
      expect(v.detail, p).not.toContain('not recoverable');
      expect(v.exhaustive, p).toBe(false);
      // The atom gate is part of the arm and comes BEFORE the exactness gate:
      // this machine names `abort`, and the row is an atom refusal, not an
      // environment one.
      // And no target set was collected, so its count is `null` — a `0`
      // here read as "no configuration holds it" about a set never computed.
      expect(v.recovery, p).toEqual({ atomKind: p.startsWith('fires') ? 'fires' : 'trigger', targetConfigs: null, cannotReach: null, bottomSccOverlap: null, refusedByGate: null });
      expect(v.recovery!.targetConfigs, p).not.toBe(0);
      expect(v.detail, p).not.toContain(ENVIRONMENT_SENTENCE);
    }
  });

  it('`p=(mode == 3)` is refused with the store reason, byte-identical to §3.R’s row 4', async () => {
    const r = await reportOf(FILES.probe, 'TrapProbe::Probe::Modes', `${RECOVERY}(mode == 3)`);
    const v = r.properties[0];
    expectArmShape(v, 5);
    expect(v.claim).toBe('inconclusive');
    expect(v.code).toBe(MALFORMED_PROPERTY_CODE);
    expect(v.code).not.toBe('verification/refuted');
    expect(r.exitCode).toBe(2);
    expect(v.detail).toContain(STORE_ATOM_REASON);
    expect(v.detail.endsWith(STORE_ATOM_REASON)).toBe(true);
    expect(v.recovery!.atomKind).toBe('expression');
    expect(STORE_ATOM_REASON).toBe('this atom reads the store, which this walk does not retain');
    // The SAME sentence §3.R's row 4 prints, read off a row-4 modality: the
    // two sections cannot drift back apart.
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
    const loadedRow4 = await loadModelText(text, { fileName: 'fires-cycle.sysml' });
    const row4 = checkProperty(loadedRow4.model!, machineIn(loadedRow4.model!, 'P::Fires'), absence('mode == 3'));
    expect(row4.claim).toBe('fail');
    expect(row4.modality!.sentence).toBe(`not decided: ${STORE_ATOM_REASON}`);
  });

  it('a scope other than `globally` is refused as malformed — a scope is a monitor over a run, and this question is asked of configurations', async () => {
    const r = await reportOf(FILES.probe, 'TrapProbe::Probe::Modes', 'pattern=recovery, scope=before, p=state standby, r=state alpha');
    const v = r.properties[0];
    expectArmShape(v, 5);
    expect(v.claim).toBe('inconclusive');
    expect(v.code).toBe(MALFORMED_PROPERTY_CODE);
    expect(r.exitCode).toBe(2);
    expect(v.detail).toContain('`recovery` is read over `globally` only');
    expect(v.scope).toBe('before');
    // The census on a row that read nothing: every figure `null`, the target
    // count included — `targetConfigs: 0` was the shipped answer here, on a
    // machine whose `state standby` holds at one configuration under
    // `globally`, and read as "none holds it".
    expect(v.recovery).toEqual({ atomKind: 'state', targetConfigs: null, cannotReach: null, bottomSccOverlap: null, refusedByGate: null });
  });
});

/* ═══════════════════════ the gate: one fixture per mechanism ═══════════════════════ */

/** The two-dwell machine of `semantics.mc.publishable.test.ts`, copied: `after(5)` before `after(60)`. */
function twoDwellMachine(): { model: Model; machineId: ElementId } {
  const m = new Model();
  const f = new ModelFactory(m);
  const sm = f.stateDef('Dwells');
  const failsafe = f.state('failsafe', sm.id);
  const failsafeHold = f.state('failsafeHold', sm.id);
  const standby = f.state('standby', sm.id);
  const orphan = f.state('orphan', sm.id);
  f.transition(failsafe.id, failsafeHold.id, { ownerId: sm.id, trigger: 'after(5)' });
  f.transition(failsafe.id, standby.id, { ownerId: sm.id, trigger: 'after(60)' });
  f.transition(failsafeHold.id, failsafe.id, { ownerId: sm.id, trigger: 'after(5)' });
  f.transition(orphan.id, failsafe.id, { ownerId: sm.id, trigger: 'after(5)' });
  return { model: m, machineId: sm.id };
}

/** The same shape spelled with numeric `attrs.after` and no trigger: `alphabet []`. */
function numericDwellMachine(): { model: Model; machineId: ElementId } {
  const m = new Model();
  const f = new ModelFactory(m);
  const sm = f.stateDef('NumericDwells');
  const failsafe = f.state('failsafe', sm.id);
  const failsafeHold = f.state('failsafeHold', sm.id);
  const standby = f.state('standby', sm.id);
  for (const [from, to, after] of [
    [failsafe.id, failsafeHold.id, 5],
    [failsafe.id, standby.id, 60],
    [failsafeHold.id, failsafe.id, 5],
  ] as const) {
    m.create('TransitionUsage', { ownerId: sm.id, attrs: { after }, source: [from], target: [to] });
  }
  return { model: m, machineId: sm.id };
}

describe('the exactness gate refuses BOTH directions, one fixture per mechanism', () => {
  it('time: the preempted-dwell machine, both spellings, with `recoverable` named as the wrong answer', () => {
    // The walk offers `after(60)` at `failsafe` as if `after(5)` had never
    // preempted it, so `standby` looks reachable from everywhere. The
    // interpreter would take `after(5)` first, every time.
    for (const [label, built] of [['trigger', twoDwellMachine()], ['numeric', numericDwellMachine()]] as const) {
      const r = behaviourReport(built.model, { machineId: built.machineId, pattern: `${RECOVERY}state standby` });
      const v = r.properties[0];
      expect(v.claim, label).toBe('inconclusive');
      expect(v.claim, label).not.toBe('pass');
      expect(v.code, label).toBe(BEHAVIOUR_UNSUPPORTED_CODE);
      expect(r.exitCode, label).toBe(2);
      expect(v.detail, label).toMatch(/^inconclusive: this machine carries `after\(n\)` dwell transitions/);
      expect(v.detail, label).toContain(DWELL_SENTENCE);
      expect(v.detail, label).not.toContain('recoverable');
      expect(v.recovery, label).toMatchObject({ atomKind: 'state', cannotReach: null, bottomSccOverlap: null, refusedByGate: 'time' });
      expect(v.exhaustive, label).toBe(false);
      expect(v.qualification, label).toBe(CLAUSE_SENTENCE.time);
      expect(v.witness, label).toEqual([]);
    }
  });

  it('environment: the latch file, in-process and through argv, with `recoverable` at exit 0 named as the wrong answer', async () => {
    // `nominal -> locked`, `locked --unlatch--> nominal`: one whole-graph
    // component, two configurations, and the draft's A7 held on that walk and
    // published `recoverable` — a pass about a design in which `locked ->
    // nominal` exists only because the walk supplies `unlatch`.
    const v = await verdictOf(FILES.latch, 'Latch::Latch::Modes', recovery('state nominal'));
    expectArmShape(v, 2);
    expect(v.claim).toBe('inconclusive');
    expect(v.claim).not.toBe('pass');
    expect(v.code).toBe(BEHAVIOUR_UNSUPPORTED_CODE);
    expect(v.detail).toMatch(/^inconclusive: this machine names triggers this walk offers at every configuration/);
    expect(v.detail).toContain(ENVIRONMENT_SENTENCE);
    expect(v.detail).not.toContain('recoverable');
    expect(v.recovery).toEqual({ atomKind: 'state', targetConfigs: 1, cannotReach: null, bottomSccOverlap: null, refusedByGate: 'environment' });
    expect(v.qualification).toBe(CLAUSE_SENTENCE.environment);

    const r = await cli(['check-behaviour', FILES.latch, '--element', 'Latch::Latch::Modes', '--pattern', `${RECOVERY}state nominal`]);
    expect(r.code).toBe(2);
    expect(r.code).not.toBe(0);
    expect(r.stdout).toContain('INCONCLUSIVE `state nominal` is reachable from every reachable configuration');
    expect(r.stdout).toContain('inconclusive: this machine names triggers this walk offers at every configuration');
    expect(r.stdout).toContain(`info ${BEHAVIOUR_UNSUPPORTED_CODE}`);
    expect(r.stdout).not.toContain('recoverable:');
    expect(r.stdout).not.toMatch(/\bPASS\b/);
  });

  it('store: the trapguard file, both ways, with the REFUTATION named as the wrong answer — the reason the arm gates both directions', async () => {
    // `degradedA if resetOk then nominal` over an unvalued `resetOk`: the
    // escape edge is absent from the retained relation while the model states
    // it. Read through the decreasing gate this half would publish `not
    // recoverable: 2 configuration(s) cannot reach \`state nominal\``,
    // `verification/refuted`, exit 1, on a design that declares the way back.
    const v = await verdictOf(FILES.trapguard, 'TrapGuard::Trap::Modes', recovery('state nominal'));
    expectArmShape(v, 3);
    expect(v.claim).toBe('inconclusive');
    expect(v.claim).not.toBe('fail');
    expect(v.code).toBe(GUARD_UNDETERMINED_CODE);
    expect(v.code).not.toBe('verification/refuted');
    expect(v.detail).toMatch(/^inconclusive: a transition of this machine is guarded by a condition the walk consulted and could not decide/);
    expect(v.detail).toContain('neither direction of this claim is made');
    expect(v.detail).toContain(CLAUSE_SENTENCE.store);
    expect(v.detail).not.toContain('not recoverable');
    expect(v.recovery).toEqual({ atomKind: 'state', targetConfigs: 1, cannotReach: null, bottomSccOverlap: null, refusedByGate: 'store' });
    expect(v.exhaustive).toBe(false);

    const r = await cli(['check-behaviour', FILES.trapguard, '--element', 'TrapGuard::Trap::Modes', '--pattern', `${RECOVERY}state nominal`]);
    expect(r.code).toBe(2);
    expect(r.code).not.toBe(1);
    expect(r.stdout).not.toContain('not recoverable: 2 configuration(s) cannot reach `state nominal`');
    expect(r.stdout).not.toContain('verification/refuted');
    expect(r.stdout).toContain(`warning ${GUARD_UNDETERMINED_CODE}`);
    expect(r.stdout).toContain('3 configuration(s) explored — ' + CLAUSE_SENTENCE.store);
  });

  it('store tracks decidedness, not the presence of a guard: `-typed` refuses, `-false` DECIDES the refutation, `-true` reads `recoverable`', async () => {
    // `mode : Integer = 3` with `if not mode`: every name resolves and the
    // guard still decides nothing — the shipped predicate, not "no declared
    // value".
    const typed = await verdictOf(FILES.trapguardTyped, 'TrapGuardTyped::Trap::Modes', recovery('state nominal'));
    expect(typed.claim).toBe('inconclusive');
    expect(typed.recovery!.refusedByGate).toBe('store');
    // The escape edge is absent because the MODEL says so: the gate holds,
    // and this is the one file where `not recoverable` legitimately publishes.
    const decided = await reportOf(FILES.trapguardFalse, 'TrapGuardFalse::Trap::Modes', `${RECOVERY}state nominal`);
    const f = decided.properties[0];
    expect(f.claim).toBe('fail');
    expect(f.code).toBe('verification/refuted');
    expect(decided.exitCode).toBe(1);
    expect(f.detail).toBe(
      'not recoverable: 2 configuration(s) cannot reach `state nominal`: {degradedA, degradedB}; the nearest is entered in 1 step(s) from `nominal`. Of these, 2 form a set nothing leaves — `reach` reports them as `verification/unrecoverable-mode`.',
    );
    expect(f.recovery).toEqual({ atomKind: 'state', targetConfigs: 1, cannotReach: 2, bottomSccOverlap: 2, refusedByGate: null });
    expect(f.exhaustive).toBe(true);
    // With the escape retained the relation is one component holding the
    // opening: every configuration reaches `nominal`, and the walk recorded a
    // choice at `degradedA`, so the simulator sentence prints.
    const t = (await reportOf(FILES.trapguardTrue, 'TrapGuardTrue::Trap::Modes', `${RECOVERY}state nominal`)).properties[0];
    expect(t.claim).toBe('pass');
    expect(t.recovery).toEqual({ atomKind: 'state', targetConfigs: 1, cannotReach: 0, bottomSccOverlap: 0, refusedByGate: null });
    expect(t.detail).toContain(SIMULATOR_SENTENCE);
  });

  it('bound: `--max-configs 2` on the trap probe is `inconclusive` under `verification/bound-exhausted`, with the machine answers null', async () => {
    const r = await reportOf(FILES.probe, 'TrapProbe::Probe::Modes', `${RECOVERY}state standby`, 2);
    const v = r.properties[0];
    expectArmShape(v, 2);
    expect(v.claim).toBe('inconclusive');
    expect(v.code).toBe(BOUND_EXHAUSTED_CODE);
    expect(r.exitCode).toBe(2);
    expect(v.detail).toMatch(/^inconclusive: bound exhausted — the recovery claim is not made/);
    expect(v.boundHit).toBe('configs');
    expect(v.exhaustive).toBe(false);
    // A frontier node looks like a sink: the naive answer over two
    // configurations is a one-configuration refutation, and it is not made.
    expect(v.detail).not.toContain('not recoverable');
    expect(v.recovery).toEqual({ atomKind: 'state', targetConfigs: 1, cannotReach: null, bottomSccOverlap: null, refusedByGate: 'bound' });
    const c = await cli(['check-behaviour', FILES.probe, '--element', 'TrapProbe::Probe::Modes', '--pattern', `${RECOVERY}state standby`, '--max-configs', '2']);
    expect(c.code).toBe(2);
    expect(c.stdout).toContain('bound exhausted — the recovery claim is not made');
  });
});

/* ═══════════════════════ the register, the catalogue, and nothing else moved ═══════════════════════ */

describe('the register and the catalogue', () => {
  it('A7 names `recoveryRow` as its producer, polarity increasing, `walkIsExact`, and no product-search condition', () => {
    const a7 = ABSENCE_CLAIMS.find((r) => r.id === 'A7')!;
    expect(a7.polarity).toBe('increasing');
    expect(a7.walkRequires).toBe('walkIsExact');
    expect(a7.alsoRequires).toEqual([]);
    expect(a7.producedBy).toEqual({ file: 'src/semantics/mc/patterns.ts', symbol: 'recoveryRow' });
  });

  it('the four catalogue entries the arm files under name the recovery cause', () => {
    const malformed = diagnosticCode('verification/malformed-property')!;
    expect(malformed.when).toContain('`recovery`');
    expect(malformed.when).toContain('a `p` whose atom kind this pattern cannot observe');
    const listed = /outside the catalogue \(([^)]*)\)/.exec(malformed.when)!;
    expect([...listed[1].matchAll(/`([a-z-]+)`/g)].map((m) => m[1])).toEqual(PATTERNS.map((p) => p.name));
    expect(diagnosticCode('verification/refuted')!.when).toContain('`recovery`');
    expect(diagnosticCode('verification/refuted')!.when).toContain('not recoverable');
    expect(diagnosticCode('verification/bound-exhausted')!.when).toContain('`recovery`');
    expect(diagnosticCode('verification/behaviour-unsupported-construct')!.when).toContain('`recovery`');
  });
});

describe('nothing else on the row moved: every non-recovery fixture is byte-identical to the pre-commit tree', () => {
  interface Golden {
    file: string;
    machine: string;
    pattern: string;
    claim: string;
    code: string | null;
    detail: string;
    witness: (string | null)[];
    exitCode: number;
    counts: Record<string, number>;
  }
  const golden: Golden[] = JSON.parse(read('test/fixtures/verification/behaviour-golden-b97f391.json'));

  it('captured 84 rows over the seven other patterns, and each still reads the same', async () => {
    expect(golden).toHaveLength(84);
    expect(new Set(golden.map((g) => g.pattern.split(',')[0]))).toEqual(
      new Set(['absence', 'universality', 'bounded-existence', 'precedence', 'cover', 'existence', 'response'].map((p) => `pattern=${p}`)),
    );
    for (const want of golden) {
      const model = await modelOf(want.file);
      const machineId = model.all().find((e) => model.qualifiedName(e.id) === want.machine)!.id;
      const r = behaviourReport(model, { machineId, pattern: want.pattern });
      const row = r.properties[0];
      const label = `${want.file} :: ${want.machine} :: ${want.pattern}`;
      expect(row.claim, label).toBe(want.claim);
      expect(row.code, label).toBe(want.code);
      expect(row.detail, label).toBe(want.detail);
      expect(row.witness.map((w) => w.leaf?.name ?? null), label).toEqual(want.witness);
      expect(r.exitCode, label).toBe(want.exitCode);
      expect(r.counts, label).toEqual(want.counts);
      expect(row.recovery, label).toBeUndefined();
    }
  });
});
