/**
 * The palette's Checks section, against the CLI it names.
 *
 * The registry's promise is that what a person runs in the app and what they
 * run in a terminal are the same check. That holds only if every entry names a
 * real subcommand, every view offers something, and a check that cannot run
 * here says so instead of returning a verdict it has not earned.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { fireEvent, render } from '@testing-library/react';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildSampleModel, Model, type ElementId } from '@core/index';
import { contractReport, isUserElement, obligationsReport } from '@api/index';
import { isKnownCode, measureTextHealth, parseModel, resolveConnectorFeatureChains, serializeUserModelSignals, type MeasuredText } from '@text/index';
import { loadModelText } from '@text/load';
import { resolveTypeReferences } from '@library/resolve';
import { loadFullStandardLibrary } from '@library/full-library';
import { loadCuratedLibrary } from '@library/standard-library';
import { reachReport, stateMachinesIn } from '@semantics/mc/explore';
import { behaviourReport, exitCodeOf, traceLine } from '@semantics/mc/patterns';
import {
  ELEMENT_REQUIRED_LEAD,
  NO_DEFAULT_MACHINE,
  behaviourLines,
  libraryElementRefusal,
  reachLines,
} from '@semantics/mc/report-lines';
import {
  CHECKS,
  checkScope,
  CHECK_META_CODES,
  checksFor,
  commandFileName,
  commandNote,
  runCheck,
  NOT_ISOLATED,
  QUALIFIED_NAME_PLACEHOLDER,
  selectionKey,
  type CheckContext,
  type CheckResult,
} from '../../src/ui/checks';
import { BehaviourReport } from '../../src/ui/panels/BehaviourReport';
import {
  behaviourClassesOf,
  behaviourResult,
  compactWitnesses,
  degradedRow,
  marksStatusLine,
  marksStatusText,
  pickBehaviourMachine,
  reachMarks,
  reachResult,
  unwalkedStates,
  withholds,
  type ReachMark,
} from '../../src/ui/behaviour-checks';
import type { StoredResult } from '../../src/ui/panels/checks-store';
import type { LoadHealth, PendingLoadHealth } from '../../src/ui/store';
import { COMMANDS } from '../../scripts/lib/sysprose-spec';
import { main as sysproseMain } from '../../scripts/sysprose';
import {
  CheckHost,
  libraryKey,
  mergeLibrary,
  NO_REQUEST,
  userPart,
  type CheckReply,
  type CheckRequest,
  type HealthRequest,
} from '../../src/ui/checks-offthread';
import { runningVerdict, useChecksStore, verdictOf } from '../../src/ui/panels/checks-store';
import {
  FRAME_WAIT_MS,
  IDLE_MS,
  WATCHDOG_MS,
  cancelChecked,
  resetCheckRunner,
  runChecked,
  runCheckedOnceDrawn,
  setCheckWorkerFactory,
  type CheckWorker,
  type RunStart,
} from '../../src/ui/panels/checks-runner';
import type { ViewKind } from '@diagram/index';

// The passes the reports make, counted: wrapped, not replaced, so every answer is the real one.
vi.mock('@api/index', async (importOriginal) => {
  const real = await importOriginal<typeof import('@api/index')>();
  return { ...real, contractReport: vi.fn(real.contractReport), obligationsReport: vi.fn(real.obligationsReport) };
});

/** Every ViewKind, listed here so a new view cannot quietly ship with no check. */
const VIEW_KINDS: readonly ViewKind[] = [
  'general', 'interconnection', 'action', 'state', 'requirement', 'tree', 'parametric', 'sequence',
  'allocation', 'geometry', 'case', 'grid', 'requirements', 'analysis', 'planning', 'regroup', 'contracts',
];

const ctx = (over: Partial<CheckContext> = {}): CheckContext => ({
  model: buildSampleModel(),
  selectionId: null,
  selectionName: null,
  isolated: false,
  fileName: 'model.sysml',
  loadHealth: healthy,
  ...over,
});

/** The terminal command in-process, its output captured. */
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

describe('the checks registry', () => {
  it('names only real CLI subcommands', () => {
    const cli = new Set(COMMANDS.map((c) => c.name));
    const unknown = CHECKS.filter((c) => !cli.has(c.id)).map((c) => c.id);
    expect(unknown, 'registry entries with no CLI subcommand of that name').toEqual([]);
  });

  it('puts the command it would run into the copyable text', () => {
    for (const spec of CHECKS) {
      const command = spec.command(ctx());
      expect(command, spec.id).toContain(`sysprose -- ${spec.id} `);
      expect(command, spec.id).toContain('model.sysml');
    }
  });

  it('offers at least one check on every view', () => {
    const bare = VIEW_KINDS.filter((v) => checksFor(v).length === 0);
    expect(bare, 'views with no check at all').toEqual([]);
  });

  it('runs the model-engine checks on the sample model, and every row carries a code', () => {
    for (const spec of CHECKS.filter((c) => c.engine === 'model')) {
      const result = runCheck(spec, ctx());
      expect(['holds', 'issues', 'undecided', 'not-run'], `${spec.id} verdict`).toContain(result.verdict);
      expect(result.summary.length, `${spec.id} summary`).toBeGreaterThan(0);
      for (const row of result.rows) expect(row.code, `${spec.id} row without a code`).toMatch(/\S/);
    }
  });

  it('never reports a solver check as passed on a page that cannot run one', () => {
    for (const spec of CHECKS.filter((c) => c.engine === 'solver')) {
      const result = runCheck(spec, ctx());
      expect(result.verdict, spec.id).toBe('unavailable');
      expect(result.summary).toBe(NOT_ISOLATED);
      // The way out is the command, and it is in the rows.
      expect(result.rows.some((r) => r.message.includes(`sysprose -- ${spec.id}`)), spec.id).toBe(true);
    }
  });

  it('reads the selection where the CLI would take --element', () => {
    const model = buildSampleModel();
    const part = model.ofKind('PartUsage')[0];
    const withSelection = ctx({ model, selectionId: part.id, selectionName: model.qualifiedName(part.id) });
    const whereUsedSpec = CHECKS.find((c) => c.id === 'where-used')!;
    expect(whereUsedSpec.command(withSelection)).toContain(`--element ${model.qualifiedName(part.id)}`);
    expect(runCheck(whereUsedSpec, withSelection).verdict).toBe('holds');
    // With nothing selected it asks for a selection rather than inventing one.
    expect(runCheck(whereUsedSpec, ctx()).verdict).toBe('not-run');
    expect(whereUsedSpec.command(ctx())).toContain('--element <qualified name>');
  });

  /**
   * The command is pasted into a terminal — bash, or on Windows cmd.exe or
   * PowerShell — and the names in it are not the app's to choose: a Google
   * Drive file is called whatever its owner typed (the app's own "Save as
   * copy" makes `Swarm (copy).sysml`), and a qualified name may hold quoted
   * parts. No quoting is inert in all three shells (cmd.exe reads `&` inside
   * '…' as the end of a command; a POSIX `'\''` closes a PowerShell string),
   * so such a name never enters the command: a stand-in of plain characters
   * does, or the `<qualified name>` placeholder, and the note beside the
   * command says what each stands for.
   */
  it('puts a file or element name into the command only as a plain word, and says what a stand-in stands for', () => {
    const plain = /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/;
    const stats = CHECKS.find((c) => c.id === 'stats')!;
    const whereUsed = CHECKS.find((c) => c.id === 'where-used')!;
    const names = [
      'Swarm (copy).sysml',
      'R&D swarm.sysml',
      'a&echo INJECTED&b.sysml',
      'a|calc|b.sysml',
      "x';calc;'.sysml",
      'notes$(echo INJECTED).sysml',
      '%PATH%.sysml',
      'say "hi".sysml',
      "it's; rm -rf x `y` > z.sysml",
      '-rf.sysml',
      'Схема.sysml',
      '',
    ];
    for (const name of names) {
      const file = commandFileName(name);
      expect(file, name).toMatch(plain);
      const command = stats.command(ctx({ fileName: name }));
      expect(command, name).toBe(`npm run sysprose -- stats ${file}`);
      for (const word of command.split(' ')) expect(word, command).toMatch(/^[A-Za-z0-9_.:-]+$/);
      // bash hands it on as one word (a shell function stands in for npm).
      const words = execFileSync('bash', ['-c', `npm() { printf '%s\\n' "$@"; }; ${command}`], { encoding: 'utf8' });
      expect(words.split('\n').slice(0, -1), command).toEqual(['run', 'sysprose', '--', 'stats', file]);
      if (name !== '') {
        expect(commandNote(stats, ctx({ fileName: name })), name).toBe(
          `Save the file as ${file} to run this: its name, ${name}, has characters a terminal could read as commands.`,
        );
      }

      // An element's qualified name with such a part: the placeholder, last, and the name beside the command.
      const qualified = `P::'${name}'`;
      const withSelection = ctx({ fileName: 'model.sysml', selectionId: 'x', selectionName: qualified });
      const elementCommand = whereUsed.command(withSelection);
      expect(elementCommand).toBe(`npm run sysprose -- where-used model.sysml --element ${QUALIFIED_NAME_PLACEHOLDER}`);
      expect(commandNote(whereUsed, withSelection)).toContain(`${QUALIFIED_NAME_PLACEHOLDER} stands for ${qualified},`);
    }
    // A placeholder left in runs nothing: the shell refuses the line whole.
    const left = whereUsed.command(ctx());
    expect(() => execFileSync('bash', ['-c', `npm() { echo RAN; }; ${left}`], { encoding: 'utf8', stdio: 'pipe' })).toThrow(
      /syntax error/,
    );
  });

  it('names a plain file and a plain qualified name as they are, with nothing to say beside the command', () => {
    const whereUsed = CHECKS.find((c) => c.id === 'where-used')!;
    const bounds = CHECKS.find((c) => c.id === 'bounds')!;
    for (const fileName of ['model.sysml', 'Swarm_v2.sysml', 'drone-swarm.sysml', '2026-plan.sysml']) {
      expect(commandFileName(fileName)).toBe(fileName);
    }
    const c = ctx({ fileName: 'Swarm.sysml', selectionId: 'x', selectionName: 'Swarm::Drone::mass' });
    expect(whereUsed.command(c)).toBe('npm run sysprose -- where-used Swarm.sysml --element Swarm::Drone::mass');
    expect(bounds.command(c)).toBe('npm run sysprose -- bounds Swarm.sysml --measure Swarm::Drone::mass');
    expect(commandNote(whereUsed, c)).toBeNull();
    // A solver check's rows: the command, and — only when it left a name out — what it left out.
    expect(runCheck(bounds, c).rows.map((r) => r.code)).toEqual(['checks/not-here']);
    expect(runCheck(bounds, { ...c, fileName: 'Swarm (copy).sysml' }).rows.map((r) => r.code)).toEqual([
      'checks/not-here',
      'checks/command-note',
    ]);
  });

  /**
   * `contracts` and `obligations` take an optional `--element` in a terminal,
   * which narrows the report to that element and what it contains. The palette
   * reads the selection the same way and its command names it; with nothing to
   * narrow to — no selection, or a library element the terminal refuses — the
   * check covers the whole model, its command says nothing about an element,
   * and its summary and a coded row say the result covers the whole model.
   */
  it('scopes contracts and obligations to the selection as --element does, and says when they cover the whole model', () => {
    const model = buildSampleModel();
    const contracts = CHECKS.find((c) => c.id === 'contracts')!;
    const obligations = CHECKS.find((c) => c.id === 'obligations')!;
    const vehicle = model.resolveQualifiedName('VehicleModel::vehicle')!;
    const maxMass = model.resolveQualifiedName('VehicleModel::maxMass')!;
    const on = (id: string) => ctx({ model, selectionId: id, selectionName: model.qualifiedName(id) });
    // The sample model narrows: one of its two obligations sits under `vehicle`, its one contract on `maxMass`.
    expect(obligationsReport(model).total).toBe(2);

    expect(obligations.command(on(vehicle.id))).toBe(
      'npm run sysprose -- obligations model.sysml --element VehicleModel::vehicle',
    );
    const scoped = runCheck(obligations, on(vehicle.id));
    // The whole model's figure beside the scoped one, so the narrowed count never reads as the total.
    expect(scoped.summary).toMatch(/^1 of 2 obligation\(s\): .* — scoped to VehicleModel::vehicle$/);
    expect(scoped.rows[0]).toMatchObject({ code: 'checks/scoped', elementId: vehicle.id });

    expect(contracts.command(on(maxMass.id))).toBe('npm run sysprose -- contracts model.sysml --element VehicleModel::maxMass');
    const one = runCheck(contracts, on(maxMass.id));
    expect(one.summary).toBe('1 of 1 contract(s) — scoped to VehicleModel::maxMass');
    expect(one.rows.filter((r) => r.code === 'contracts/contract').map((r) => r.elementId)).toEqual([maxMass.id]);
    expect(runCheck(contracts, on(vehicle.id)).summary).toBe('0 of 1 contract(s) — scoped to VehicleModel::vehicle');

    // Nothing selected: the terminal's own default, and the row says so.
    for (const spec of [contracts, obligations]) {
      expect(spec.command(ctx({ model })), spec.id).toBe(`npm run sysprose -- ${spec.id} model.sysml`);
      const whole = runCheck(spec, ctx({ model }));
      expect(whole.summary, spec.id).toMatch(/ — covers the whole model: nothing is selected$/);
      expect(whole.rows[0], spec.id).toMatchObject({ code: 'checks/whole-model' });
    }
    expect(runCheck(obligations, ctx({ model })).summary).toMatch(/^2 obligation\(s\)/);

    // A library element is no scope — the terminal refuses one — so neither is it here.
    const library = model.create('Package', { declaredName: 'ScalarValues', attrs: { isLibrary: true } });
    const onLibrary = on(library.id);
    expect(contracts.command(onLibrary)).toBe('npm run sysprose -- contracts model.sysml');
    expect(runCheck(contracts, onLibrary).summary).toBe(
      '1 contract(s) — covers the whole model: ScalarValues is a bundled library element, and these figures leave the library out',
    );
    expect(commandNote(contracts, onLibrary)).toBeNull();

    // A name no shell passes on as it is: the placeholder, and what it stands for beside the command.
    const odd = ctx({ model, selectionId: vehicle.id, selectionName: "VehicleModel::'odd name'" });
    expect(contracts.command(odd)).toBe(`npm run sysprose -- contracts model.sysml --element ${QUALIFIED_NAME_PLACEHOLDER}`);
    expect(commandNote(contracts, odd)).toContain(`${QUALIFIED_NAME_PLACEHOLDER} stands for VehicleModel::'odd name',`);
  });

  /**
   * The promise itself, held against the terminal: the command the palette
   * prints, run by the CLI over the same file, reports the same contracts and
   * the same obligations the palette's run found — scoped, and whole.
   */
  it('covers what its printed command covers in a terminal', async () => {
    const file = 'examples/uav-power-budget.sysml';
    const loaded = await loadModelText(readFileSync(file, 'utf8'), { fileName: file });
    const model = loaded.model!;
    const contracts = CHECKS.find((c) => c.id === 'contracts')!;
    const obligations = CHECKS.find((c) => c.id === 'obligations')!;
    /** A selection by qualified name, or by id for an element that has none to resolve by. */
    const on = (ref: string | null): CheckContext => {
      const el = ref === null ? undefined : (model.resolveQualifiedName(ref) ?? model.get(ref));
      if (ref !== null) expect(el, ref).toBeDefined();
      return ctx({ model, fileName: 'uav-power-budget.sysml', selectionId: el?.id ?? null, selectionName: el ? model.qualifiedName(el.id) : null });
    };
    // A `doc` comment: an element that can hold no contract, so no scope — the whole model, here and there.
    const doc = model.all().find((el) => el.eClass === 'Documentation' && isUserElement(model, el))!;
    expect(doc).toBeDefined();
    /** The printed command, in-process, over the real file, as JSON. */
    const terminal = async (command: string): Promise<{ code: number; json: Record<string, unknown> }> => {
      const words = command.split(' ');
      expect(words.slice(0, 4)).toEqual(['npm', 'run', 'sysprose', '--']);
      const args = [words[4], file, ...words.slice(6), '--json'];
      const { code, stdout } = await cli(args);
      return { code, json: JSON.parse(stdout) as Record<string, unknown> };
    };

    // The terminal's whole-model figures, which a scoped summary carries beside its own.
    const wholeContracts = ((await terminal(contracts.command(on(null)))).json.contracts as { contracts: unknown[] }).contracts.length;
    const wholeObligations = ((await terminal(obligations.command(on(null)))).json.obligations as { total: number }).total;
    for (const scope of ['UAVPowerBudget::BatterySupply', null, 'ScalarValues::Real', doc.id]) {
      const c = on(scope);
      const scoped = checkScope(c).kind === 'element';
      const ran = runCheck(contracts, c);
      const here = ran.rows.filter((r) => r.code === 'contracts/contract').map((r) => model.qualifiedName(r.elementId!));
      const there = await terminal(contracts.command(c));
      expect(there.code, contracts.command(c)).toBe(0);
      const listed = (there.json.contracts as { contracts: { qualifiedName: string }[] }).contracts.map((x) => x.qualifiedName);
      expect(here.sort(), `${scope}: ${contracts.command(c)}`).toEqual(listed.sort());
      expect(ran.summary, `${scope}`).toMatch(new RegExp(`^${listed.length}${scoped ? ` of ${wholeContracts}` : ''} contract\\(s\\) — `));

      const of = scoped ? ` of ${wholeObligations}` : '';
      const counted = runCheck(obligations, c).summary;
      const report = (await terminal(obligations.command(c))).json.obligations as { total: number; byRole: Record<string, number> };
      expect(counted, `${scope}: ${obligations.command(c)}`).toMatch(
        new RegExp(`^${report.total}${of} obligation\\(s\\): ${report.byRole.axiom} axiom, ${report.byRole.premise} premise, ${report.byRole.obligation} to prove — `),
      );
    }
    // The scope did narrow — one contract of the five, two obligations of the nineteen.
    expect([wholeContracts, wholeObligations]).toEqual([5, 19]);
    expect(runCheck(contracts, on('UAVPowerBudget::BatterySupply')).summary).toBe('1 of 5 contract(s) — scoped to UAVPowerBudget::BatterySupply');
    expect(runCheck(contracts, on(null)).summary).toMatch(/^5 contract\(s\) — covers the whole model/);
    expect(runCheck(obligations, on('UAVPowerBudget::BatterySupply')).summary).toMatch(/^2 of 19 obligation\(s\)/);
    expect(contracts.command(on(doc.id))).toBe('npm run sysprose -- contracts uav-power-budget.sysml');
    expect(runCheck(contracts, on(doc.id)).summary).toMatch(/^5 contract\(s\) — covers the whole model: .* contains no contract or obligation$/);
    // And the library element the palette would not pass on is one the terminal refuses.
    const refused = await cli(['contracts', file, '--element', 'ScalarValues::Real']);
    expect(refused.code).toBe(2);
    expect(refused.stdout).toContain('is a bundled standard-library element');
  }, 120_000);

  /**
   * The app selects the model's first root on open, so a first Run is scoped to
   * it. Beside the scoped figure goes the whole model's (` of N`) — a second pass
   * over the model, which for the one root there is would only repeat the first:
   * that root contains everything a person wrote. Measured on the drone-swarm
   * model it was the difference between 25 and 54 ms for `obligations`.
   */
  it('makes one pass, not two, when the scope is the only root, and two when it is one of several', () => {
    const model = buildSampleModel();
    const contracts = CHECKS.find((c) => c.id === 'contracts')!;
    const obligations = CHECKS.find((c) => c.id === 'obligations')!;
    const roots = model.roots().filter((r) => r.attrs.isLibrary !== true);
    expect(roots.map((r) => r.declaredName), 'the sample is one package').toEqual(['VehicleModel']);
    const on = (id: string) => ctx({ model, selectionId: id, selectionName: model.qualifiedName(id) });
    const passes = (spec: typeof contracts, c: CheckContext): number => {
      const report = spec === contracts ? vi.mocked(contractReport) : vi.mocked(obligationsReport);
      report.mockClear();
      runCheck(spec, c);
      return report.mock.calls.length;
    };

    // The only root: the scoped figure is the whole model's, printed once.
    expect(passes(contracts, on(roots[0].id))).toBe(1);
    expect(passes(obligations, on(roots[0].id))).toBe(1);
    expect(runCheck(contracts, on(roots[0].id)).summary).toBe('1 of 1 contract(s) — scoped to VehicleModel');
    expect(runCheck(obligations, on(roots[0].id)).summary).toMatch(/^2 of 2 obligation\(s\): .* — scoped to VehicleModel$/);
    // The same figures the second pass gives.
    expect(contractReport(model, { scopeId: roots[0].id }).contracts.length).toBe(contractReport(model).contracts.length);
    expect(obligationsReport(model, { scopeId: roots[0].id }).total).toBe(obligationsReport(model).total);

    // Something inside it: a narrower figure beside the whole model's, so two.
    const vehicle = model.resolveQualifiedName('VehicleModel::vehicle')!;
    expect(passes(obligations, on(vehicle.id))).toBe(2);
    expect(runCheck(obligations, on(vehicle.id)).summary).toMatch(/^1 of 2 obligation/);

    // One of two roots does not contain the other's elements: two passes, and the figures differ.
    const other = model.create('Package', { declaredName: 'Other' });
    expect(passes(obligations, on(roots[0].id))).toBe(2);
    expect(passes(contracts, on(other.id))).toBe(2);
    expect(runCheck(contracts, on(other.id)).summary).toBe('0 of 1 contract(s) — scoped to Other');
  });

  /**
   * On open the app selects the model's first root (`rootSelection`,
   * `src/ui/store.ts`), which nobody chose. In a file that starts with a header
   * comment or an import that root is an element that can hold no contract; in
   * one with two packages it is the first package. A Run nobody narrowed must
   * not report zero for a model that has contracts: the first covers the whole
   * model and says why, the second carries the whole model's figure beside its
   * own.
   */
  it('never reports a bare zero for the root the app selects on open', async () => {
    const contracts = CHECKS.find((c) => c.id === 'contracts')!;
    const obligations = CHECKS.find((c) => c.id === 'obligations')!;
    /** What the app selects on open: the first root that is not the library's. */
    const onOpen = async (text: string, fileName: string) => {
      const model = (await loadModelText(text, { fileName })).model!;
      const first = model.rootIds().filter((id) => model.get(id)?.attrs.isLibrary !== true)[0];
      return { model, first: model.get(first)!, c: ctx({ model, selectionId: first, selectionName: model.qualifiedName(first) }) };
    };

    // The shipped example the reader reached: a header comment above its one package.
    const tour = await onOpen(readFileSync('examples/views-tour.sysml', 'utf8'), 'views-tour.sysml');
    expect(tour.first.eClass).toBe('TextualRepresentation');
    const whole = { contracts: contractReport(tour.model).contracts.length, obligations: obligationsReport(tour.model).total };
    expect(whole.contracts).toBeGreaterThan(0);
    expect(whole.obligations).toBeGreaterThan(0);
    const why = `covers the whole model: ${tour.c.selectionName} contains no contract or obligation`;
    expect(runCheck(contracts, tour.c).summary).toBe(`${whole.contracts} contract(s) — ${why}`);
    expect(runCheck(obligations, tour.c).summary).toMatch(new RegExp(`^${whole.obligations} obligation\\(s\\): .* — ${why}$`));
    expect(runCheck(contracts, tour.c).rows[0]).toMatchObject({ code: 'checks/whole-model' });
    // Its command names no element, so a terminal covers the same model; nothing was left out of it.
    expect(contracts.command(tour.c)).toBe('npm run sysprose -- contracts model.sysml');
    expect(commandNote(contracts, tour.c)).toBeNull();

    const body = `package Arch { part def Vehicle { attribute mass : ScalarValues::Real; } }
package Reqs {
  requirement def MassLimit { subject v : Arch::Vehicle; require constraint { v.mass <= 1500 } }
  requirement def MassFloor { subject v : Arch::Vehicle; require constraint { v.mass >= 1 } }
}`;
    // A top-level import is the first root just the same.
    const imported = await onOpen(`private import ScalarValues::*;\n${body}`, 'm.sysml');
    expect(imported.first.eClass).toBe('NamespaceImport');
    expect(runCheck(contracts, imported.c).summary).toMatch(/^2 contract\(s\) — covers the whole model: .* contains no contract or obligation$/);

    // Two packages: the first is a real scope, and its figure says what it is out of.
    const two = await onOpen(body, 'm.sysml');
    expect(two.c.selectionName).toBe('Arch');
    expect(runCheck(contracts, two.c).summary).toBe('0 of 2 contract(s) — scoped to Arch');
    expect(runCheck(obligations, two.c).summary).toMatch(/^0 of 2 obligation\(s\): .* — scoped to Arch$/);
  });

  /** With nothing selected, the placeholder in a command that needs an element is explained like any other. */
  it('says what <qualified name> stands for when nothing is selected', () => {
    for (const spec of CHECKS.filter((c) => c.needsSelection === true)) {
      expect(spec.command(ctx()), spec.id).toContain(QUALIFIED_NAME_PLACEHOLDER);
      expect(commandNote(spec, ctx()), spec.id).toBe(
        `${QUALIFIED_NAME_PLACEHOLDER} stands for the element this check reads, and nothing is selected: select it, or type its qualified name in.`,
      );
    }
    const bounds = CHECKS.find((c) => c.id === 'bounds')!;
    expect(runCheck(bounds, ctx()).rows.map((r) => r.code)).toEqual(['checks/not-here', 'checks/command-note']);
    // A check that reads no selection has nothing to say about one.
    expect(commandNote(CHECKS.find((c) => c.id === 'stats')!, ctx())).toBeNull();
    expect(commandNote(CHECKS.find((c) => c.id === 'contracts')!, ctx())).toBeNull();
  });

  /**
   * The palette shows a result beside the command for what is selected now. A
   * result that read the selection is stale there once the selection moves,
   * as it is after an edit; the Checks tab, whose rows select what they name,
   * keeps showing what each result said.
   */
  it('shows a result that read the selection as stale in the palette once the selection moves', () => {
    const model = buildSampleModel();
    const contracts = CHECKS.find((c) => c.id === 'contracts')!;
    const whereUsed = CHECKS.find((c) => c.id === 'where-used')!;
    const stats = CHECKS.find((c) => c.id === 'stats')!;
    const vehicle = model.resolveQualifiedName('VehicleModel::vehicle')!;
    const maxMass = model.resolveQualifiedName('VehicleModel::maxMass')!;
    const on = (id: string | null) => ctx({ model, selectionId: id, selectionName: id ? model.qualifiedName(id) : null });
    const library = model.create('Package', { declaredName: 'ScalarValues', attrs: { isLibrary: true } });

    expect(selectionKey(contracts, on(vehicle.id))).toBe(`element ${vehicle.id}`);
    // Every whole-model run covers the same elements, whatever the reason given.
    expect(new Set([on(null), on(library.id)].map((c) => selectionKey(contracts, c)))).toEqual(new Set(['model']));
    expect(selectionKey(whereUsed, on(vehicle.id))).toBe(vehicle.id);
    expect(selectionKey(stats, on(vehicle.id))).toBeUndefined();

    const stored = (spec: typeof contracts, c: CheckContext): StoredResult => ({
      result: runCheck(spec, c),
      rev: 7,
      selection: selectionKey(spec, c),
      ranIn: 'page',
      at: 0,
    });
    const ran = stored(contracts, on(vehicle.id));
    expect(verdictOf(ran, 7, selectionKey(contracts, on(vehicle.id)))).toBe('holds');
    expect(verdictOf(ran, 7, selectionKey(contracts, on(maxMass.id)))).toBe('stale');
    expect(verdictOf(ran, 7, selectionKey(contracts, on(null)))).toBe('stale');
    // The Checks tab passes no selection, and an edit is stale everywhere.
    expect(verdictOf(ran, 7)).toBe('holds');
    expect(verdictOf(ran, 8, selectionKey(contracts, on(vehicle.id)))).toBe('stale');
    // A whole-model result stays current while the selection gives no scope.
    expect(verdictOf(stored(contracts, on(null)), 7, selectionKey(contracts, on(library.id)))).toBe('holds');
    // A check that reads no selection never goes stale on one.
    expect(verdictOf(stored(stats, on(vehicle.id)), 7, selectionKey(stats, on(maxMass.id)))).toBe('holds');
    // A solver check's result is the command, not a verdict, and stays `not here`.
    const bounds = CHECKS.find((c) => c.id === 'bounds')!;
    expect(verdictOf(stored(bounds, on(vehicle.id)), 8, selectionKey(bounds, on(maxMass.id)))).toBe('unavailable');
  });

  it('turns a check that throws into a finding, never into a pass', () => {
    const broken = { ...CHECKS[0], id: 'stats', run: () => { throw new Error('boom'); } };
    const result = runCheck(broken, ctx());
    expect(result.verdict).toBe('issues');
    expect(result.rows[0].code).toBe('checks/internal-error');
    expect(result.rows[0].message).toContain('boom');
  });
});

/*
 * ─── The state-machine checks run off the page's thread ────────────────────────
 *
 * `reach` and `check-behaviour` walk configuration graphs, and a walk is bounded
 * by configurations, not by time. A two-dozen-state machine with five composites
 * among them reaches the 10,000-configuration bound — measured in the built app
 * at a fifth of a second for `reach` and half a second for `check-behaviour` with
 * three properties (`docs/TEST-REPORT.md` §2.15) — so the palette runs those two
 * in a worker. These
 * tests pin the two halves of that: the worker's answer is the page's answer, and
 * the run around it (busy, Cancel, stale, fallback) does what a person is told.
 */

/**
 * A machine with `composites` composite states of `children` substates each,
 * driven by events — the shape of a flight controller's modes. The walk keeps
 * where each composite was left, so the configurations multiply with the
 * composites: two are a few hundred, five reach the walk's bound.
 */
function hierarchical(pkg: string, composites: number, children: number, withProperties: boolean): string {
  const L = [`package ${pkg} {`, '  item def Cmd { attribute id; }', '  part def Machine {', '    state def Modes {'];
  if (withProperties) {
    L.push(
      '      @SysproseVerification::PropertyPattern {',
      '        attribute pattern = "recovery";',
      '        attribute scope = "globally";',
      '        attribute p = "state Idle";',
      '      }',
      '      @SysproseVerification::PropertyPattern {',
      '        attribute pattern = "absence";',
      '        attribute scope = "globally";',
      '        attribute p = "state Nowhere";',
      '      }',
    );
  }
  L.push('      initial start;', '      transition start -> Idle;', '      state Idle;');
  for (let c = 0; c < composites; c++) {
    L.push(`      state C${c} {`, '        initial go;', `        transition go -> C${c}_0;`);
    for (let k = 0; k < children; k++) L.push(`        state C${c}_${k};`);
    for (let k = 0; k + 1 < children; k++) {
      L.push(`        transition c${c}_${k} first C${c}_${k} accept step${c}_${k} : Cmd then C${c}_${k + 1};`);
    }
    L.push('      }');
  }
  for (let c = 0; c < composites; c++) {
    L.push(`      transition in${c} first Idle accept enter${c} : Cmd then C${c};`);
    L.push(`      transition out${c} first C${c} accept leave${c} : Cmd then Idle;`);
  }
  L.push('    }', '  }', '}');
  return `${L.join('\n')}\n`;
}

const WALKERS = CHECKS.filter((c) => c.offThread === true);

/** What a request for `spec` over `c` carries. */
const requestFor = (spec: (typeof CHECKS)[number], c: CheckContext, id = 1): CheckRequest => ({
  id,
  check: spec.id,
  model: userPart(c.model),
  library: libraryKey(c.model),
  selectionId: c.selectionId,
  selectionName: c.selectionName,
  isolated: c.isolated,
  fileName: c.fileName,
  loadHealth: c.loadHealth,
});

/** A model as the page holds it: the sample, with the bundled library merged in. */
function pageModel(): Model {
  const model = buildSampleModel();
  loadFullStandardLibrary(model);
  return model;
}

describe('the checks that run in a worker', () => {
  it('are the two that walk a state machine, and both are plain model checks', () => {
    expect(WALKERS.map((c) => c.id)).toEqual(['reach', 'check-behaviour']);
    for (const spec of WALKERS) {
      expect(spec.engine, spec.id).toBe('model');
      expect(typeof spec.run, `${spec.id} needs the function the worker calls`).toBe('function');
    }
    // Everything else answers in a few milliseconds and is run on the spot.
    expect(CHECKS.filter((c) => c.offThread !== true).length).toBe(CHECKS.length - 2);
  });

  it('give in the worker the answer they give on the page, on every kind of machine', async () => {
    const sources: Array<[string, string]> = [
      ['no machine at all', 'package Empty { part def P; }'],
      ['a chain into an ending', readFileSync('test/fixtures/verification/models/mission-dag.sysml', 'utf8')],
      ['a guard nothing decides', readFileSync('test/fixtures/verification/models/guard-undetermined.sysml', 'utf8')],
      ['a machine nothing leaves', readFileSync('test/fixtures/verification/models/deadlock-guarded.sysml', 'utf8')],
      ['the UAV example', readFileSync('examples/uav-isr.sysml', 'utf8')],
      ['two composites, two properties', hierarchical('Small', 2, 3, true)],
    ];
    // One host for all of them: a request replaces the user's part and leaves the library.
    const host = new CheckHost(mergeLibrary);
    let machines = 0;
    for (const [what, text] of sources) {
      const loaded = await loadModelText(text, { fileName: 'm.sysml' });
      const model = loaded.model!;
      // The first state machine is selected as well as nothing, for the check that reads the selection.
      const machine = model.all().find((e) => e.eClass === 'StateDefinition' && e.attrs.isLibrary !== true);
      for (const selected of [null, machine?.id ?? null]) {
        const c = ctx({ model, selectionId: selected, selectionName: selected ? model.qualifiedName(selected) : null });
        for (const spec of WALKERS) {
          const reply = await host.handle(requestFor(spec, c));
          expect(reply.ok, `${what}: ${spec.id}`).toBe(true);
          if (!reply.ok) continue;
          expect(reply.result, `${what}: ${spec.id}, selected ${selected}`).toEqual(runCheck(spec, c));
          if (reply.result.verdict !== 'not-run' || machine) machines++;
        }
      }
    }
    expect(machines, 'the cases must include real machines, or this compares two empty answers').toBeGreaterThan(8);
  });

  it('give a machine at the walk\'s bound the same undecided answer, and take the time it takes', { timeout: 120_000 }, async () => {
    const loaded = await loadModelText(hierarchical('Big', 5, 4, true), { fileName: 'big.sysml' });
    const c = ctx({ model: loaded.model! });
    const host = new CheckHost(mergeLibrary);
    for (const spec of WALKERS) {
      const reply = await host.handle(requestFor(spec, c));
      expect(reply.ok).toBe(true);
      if (!reply.ok) continue;
      expect(reply.result).toEqual(runCheck(spec, c));
      // Nothing is claimed about a walk that hit its bound.
      expect(['undecided', 'not-run'], `${spec.id} says ${reply.result.verdict}: ${reply.result.summary}`).toContain(reply.result.verdict);
    }
    expect(runCheck(CHECKS.find((x) => x.id === 'reach')!, c).verdict).toBe('undecided');
  });

  it('read a snapshot: an edit made after the request was sent changes nothing in it', async () => {
    const loaded = await loadModelText(hierarchical('Snap', 1, 2, false), { fileName: 's.sysml' });
    const model = loaded.model!;
    const c = ctx({ model });
    const reach = WALKERS[0];
    const request = requestFor(reach, c);
    const before = runCheck(reach, c);
    // What `postMessage` does at the send: copy.
    const sent = structuredClone(request);
    // The only way into C0_1 is removed: the page now finds a state nothing reaches.
    const way = model.all().find((e) => e.eClass === 'TransitionUsage' && e.declaredName === 'c0_0')!;
    model.remove(way.id, { cascade: true });
    expect(runCheck(reach, c).rows.some((r) => r.code === 'verification/unreachable-state')).toBe(true);
    expect(before.rows.some((r) => r.code === 'verification/unreachable-state')).toBe(false);
    const host = new CheckHost(mergeLibrary);
    const reply = await host.handle(sent);
    expect(reply.ok && reply.result).toEqual(before);
  });

  /**
   * The worker rebuilds each owner's children from the order the user part lists
   * them in. Listed in the order the elements were added, a state dragged in the
   * Explorer came back among its new siblings where it had been added: a
   * composite with no `initial` entered it, and the palette said `issues` beside
   * a copied command that said `holds` (review 2026-10-14 D-1, D's probes d2 and
   * d7). And the page decided by its own order: of two transitions out of an
   * `initial`, it took the one added first, so a drag that put that one second
   * in the text left the page saying `holds` where the worker and a terminal
   * over the saved text said `issues` (the S2 review). A drag in the app lists
   * the page's model as every copy is rebuilt (`Model.adoptSerialOrder`, called
   * by the store's drag commands, a regroup and the SDK); the moves below make
   * it as they do. The fresh loads the test above compares were never
   * reparented, so they could not show either.
   */
  it('give the page\'s answer after a reparent in the Explorer, and the terminal\'s over the text it saves', { timeout: 120_000 }, async () => {
    const machine = (never: string, states: string[]): string =>
      [
        'package P {',
        '  item def Cmd { attribute id; }',
        '  part def Machine {',
        '    state def M {',
        '      @SysproseVerification::PropertyPattern {',
        '        attribute pattern = "absence";',
        '        attribute scope = "globally";',
        `        attribute p = "state ${never}";`,
        '      }',
        ...states.map((s) => `      ${s}`),
        '    }',
        '  }',
        '}',
        '',
      ].join('\n');
    const cases: Array<{
      what: string;
      text: string;
      move: (m: Model, by: (n: string) => ElementId) => void;
      /** The verdict before the move, and after it: on the page, from the worker and from a terminal over the saved text. */
      was: 'holds' | 'issues';
      is: { verdict: 'holds' | 'issues'; tally: string; exit: number };
    }> = [
      {
        // d7: the machine opens in Idle; Work, which has no `initial`, enters its first state.
        what: 'an older state dragged into a composite with no initial',
        text: machine('Spare', [
          'initial start;',
          'transition start -> Idle;',
          'state Idle;',
          'state Spare;',
          'state Work {',
          '  state Prep;',
          '  state Run;',
          '  transition r first Prep accept go : Cmd then Run;',
          '}',
          'transition w first Idle accept go : Cmd then Work;',
        ]),
        move: (m, by) => m.reparent(by('Spare'), by('Work')),
        was: 'holds',
        is: { verdict: 'holds', tally: '1 pass, 0 fail', exit: 0 },
      },
      {
        // d2: a machine with no `initial` opens in its first state; A, dragged out and back, is its last.
        what: 'a state of a machine with no initial dragged out and back in',
        text: machine('C', ['state A;', 'state B;', 'state C;', 'transition t1 first A accept go : Cmd then C;']),
        move: (m, by) => {
          m.reparent(by('A'), by('Machine'));
          m.reparent(by('A'), by('M'));
        },
        was: 'issues',
        is: { verdict: 'holds', tally: '1 pass, 0 fail', exit: 0 },
      },
      {
        // The S2 review: toA, dragged out and back, is now the second transition out of `start`.
        what: 'the first of two transitions out of initial dragged out and back in',
        text: machine('B', ['initial start;', 'transition toA first start then A;', 'transition toB first start then B;', 'state A;', 'state B;']),
        move: (m, by) => {
          m.reparent(by('toA'), by('Machine'));
          m.reparent(by('toA'), by('M'));
        },
        was: 'holds',
        is: { verdict: 'issues', tally: '0 pass, 1 fail', exit: 1 },
      },
    ];
    const host = new CheckHost(mergeLibrary);
    const dir = mkdtempSync(join(tmpdir(), 'checks-registry-reparent-'));
    /** Reach's rows on the page and from the worker, alike, and a terminal over the saved text lists them in that order. */
    const sameRows = async (model: Model, c: CheckContext, what: string): Promise<void> => {
      const reach = runCheck(WALKERS[0], c);
      const reply = await host.handle(requestFor(WALKERS[0], c));
      expect(reply.ok && reply.result, `${what}: reach`).toEqual(reach);
      const file = join(dir, 'm.sysml');
      writeFileSync(file, serializeUserModelSignals(model).text);
      const terminal = await cli(['reach', file]);
      const walked = /\d+ configuration\(s\) explored/;
      expect(terminal.stdout.match(walked)?.[0], `${what}: reach`).toBe(reach.summary.match(walked)?.[0]);
      expect(reach.rows.length, what).toBeGreaterThan(0);
      const at = reach.rows.map((row) => terminal.stdout.indexOf(`${row.code}  ${row.message}`));
      expect(at.every((i) => i >= 0), `${what}: every row of reach in the terminal's`).toBe(true);
      expect(at, `${what}: in the same order`).toEqual([...at].sort((a, b) => a - b));
    };
    try {
      for (const { what, text, move, was, is } of cases) {
        const model = (await loadModelText(text, { fileName: 'm.sysml' })).model!;
        const by = (name: string): ElementId => model.all().find((e) => e.declaredName === name && e.attrs.isLibrary !== true)!.id;
        const M = by('M');
        const c = ctx({ model, selectionId: M, selectionName: model.qualifiedName(M), fileName: 'm.sysml' });
        expect(runCheck(WALKERS[1], c).verdict, `${what}: before the move`).toBe(was);
        move(model, by);
        model.adoptSerialOrder();
        for (const spec of WALKERS) {
          const page = runCheck(spec, c);
          const reply = await host.handle(requestFor(spec, c));
          expect(reply.ok, `${what}: ${spec.id}`).toBe(true);
          expect(reply.ok && reply.result, `${what}: ${spec.id} — verdict, configurations, findings`).toEqual(page);
        }
        // The page is right: a terminal over the text Save writes says the same.
        const file = join(dir, 'm.sysml');
        writeFileSync(file, serializeUserModelSignals(model).text);
        const behaviour = runCheck(WALKERS[1], c);
        expect(behaviour.verdict, what).toBe(is.verdict);
        expect(behaviour.summary, what).toContain(is.tally);
        const terminal = await cli(['check-behaviour', file, '--element', 'P::Machine::M']);
        expect(terminal.code, what).toBe(is.exit);
        expect(terminal.stdout, what).toContain(is.tally);
        await sameRows(model, c, what);
      }

      // Two machines, the first dragged out of their package and back in: the text, the page and the worker list M2 first.
      const twoMachines = [
        'package P {',
        '  state def M1 { state a; state b; state dead1; transition t1 first a then b; }',
        '  state def M2 { state x; state y; state dead2; transition t2 first x then y; }',
        '}',
        '',
      ].join('\n');
      const model = (await loadModelText(twoMachines, { fileName: 'm.sysml' })).model!;
      const by = (name: string): ElementId => model.all().find((e) => e.declaredName === name && e.attrs.isLibrary !== true)!.id;
      model.reparent(by('M1'), null);
      model.reparent(by('M1'), by('P'));
      model.adoptSerialOrder();
      const c = ctx({ model, fileName: 'm.sysml' });
      expect(runCheck(WALKERS[0], c).rows[0].message).toContain('P::M2::');
      await sameRows(model, c, 'two machines, the first dragged out and back in');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('are given the library the page has: the two passes the worker leaves out change none of it', () => {
    const page = new Model();
    loadFullStandardLibrary(page);
    resolveTypeReferences(page);
    resolveConnectorFeatureChains(page);
    const worker = new Model();
    mergeLibrary(worker);
    // Ids of relationships made while binding are fresh each time; what they join is not.
    const shape = (m: Model): string[] =>
      m
        .all()
        .map((e) => JSON.stringify([e.eClass, e.ownerId, e.declaredName, e.source, e.target, e.attrs]))
        .sort();
    expect(worker.size).toBeGreaterThan(30_000);
    expect(shape(worker)).toEqual(shape(page));
  });

  it('say so, and run nothing, when the page holds another library than the worker\'s', async () => {
    const host = new CheckHost(mergeLibrary);
    const reach = WALKERS[0];
    const answer = (model: Model) => host.handle(requestFor(reach, ctx({ model })));
    const full = pageModel();

    // The same library, as a model saved with its library and read back is: answered.
    const saved = Model.fromJSON(JSON.parse(JSON.stringify(full.toJSON())));
    expect(libraryKey(saved)).toBe(libraryKey(full));
    expect((await answer(full)).ok).toBe(true);
    expect((await answer(saved)).ok).toBe(true);

    // The curated subset the page falls back to when its fetch fails; no library yet, in the first
    // moments after open; and a library of another build, here one package short. Each reads a
    // reference in the user's part differently in the worker, so the worker declines.
    const curated = buildSampleModel();
    loadCuratedLibrary(curated);
    const none = buildSampleModel();
    const older = Model.fromJSON(JSON.parse(JSON.stringify(full.toJSON())));
    older.remove(older.rootIds().filter((id) => older.get(id)?.attrs.isLibrary === true)[0], { cascade: true });
    const keys = [full, saved, curated, none, older].map(libraryKey);
    expect(new Set(keys).size, `keys: ${keys.join(' | ')}`).toBe(4);
    for (const [what, model] of [['the curated subset', curated], ['no library', none], ['another build\'s', older]] as const) {
      const reply = await answer(model);
      expect(reply.ok, what).toBe(false);
      expect(reply, what).toMatchObject({ id: 1, message: expect.stringContaining('standard library'), libraryMismatch: true });
    }
  });

  it('say so when they cannot run, and try the library again on the next request', async () => {
    let attempts = 0;
    const host = new CheckHost((model) => {
      attempts++;
      if (attempts === 1) throw new Error('the library data could not be fetched');
      mergeLibrary(model);
    });
    const c = ctx({ model: pageModel() });
    const reach = WALKERS[0];
    const first = await host.handle(requestFor(reach, c, 7));
    expect(first).toEqual({ id: 7, ok: false, message: 'the library data could not be fetched' });
    const second = await host.handle(requestFor(reach, c, 8));
    expect(second.ok).toBe(true);
    expect(second.id).toBe(8);
    expect(await host.handle({ ...requestFor(reach, c, 9), check: 'no-such-check' })).toMatchObject({ id: 9, ok: false });
  });
});

/** A worker the test answers by hand. */
class FakeWorker implements CheckWorker {
  static made: FakeWorker[] = [];
  /** The checks it was asked to run. */
  posted: CheckRequest[] = [];
  /** The texts it was asked to measure. */
  health: HealthRequest[] = [];
  terminated = false;
  onmessage: CheckWorker['onmessage'] = null;
  onerror: CheckWorker['onerror'] = null;
  onmessageerror: CheckWorker['onmessageerror'] = null;
  constructor() {
    FakeWorker.made.push(this);
  }
  postMessage(message: CheckRequest | HealthRequest): void {
    if ('kind' in message && message.kind === 'health') this.health.push(message);
    else this.posted.push(message as CheckRequest);
  }
  terminate(): void {
    this.terminated = true;
  }
  /** Answer the latest request with `result`, as the worker would. */
  answer(result: CheckResult = { verdict: 'holds', summary: 'from the worker', rows: [] }): void {
    const req = this.posted[this.posted.length - 1];
    this.onmessage?.({ data: { id: req.id, ok: true, result } satisfies CheckReply });
  }
  /** Answer the latest load request with these counts, as the worker would. */
  measured(texts: MeasuredText[]): void {
    const req = this.health[this.health.length - 1];
    this.onmessage?.({ data: { id: req.id, ok: true, texts } });
  }
}

/**
 * A load still to be measured, as `loadHealthNow` hands one over, recording what
 * it is asked; measured on the page (`here`), it is `onPage` — clean unless a
 * test says otherwise.
 */
function pendingLoad(
  texts: string[] = ['package Q;\n'],
  onPage: (after: string | undefined) => LoadHealth = () => healthy,
): {
  load: PendingLoadHealth;
  calls: { finished: MeasuredText[][]; unchecked: string[]; here: number; after: Array<string | undefined> };
} {
  const calls = { finished: [] as MeasuredText[][], unchecked: [] as string[], here: 0, after: [] as Array<string | undefined> };
  const load: PendingLoadHealth = {
    unmeasured: texts,
    finish: (measured) => {
      calls.finished.push([...measured]);
      const parse = measured.reduce((n, m) => n + m.parseErrors, 0);
      const validation = measured.reduce((n, m) => Math.max(n, m.validationErrors), 0);
      return parse + validation === 0
        ? healthy
        : degradedHealth({ errors: parse + validation, saved: { parseErrors: parse }, exported: { parseErrors: parse }, validationErrors: validation });
    },
    unchecked: (why) => {
      calls.unchecked.push(why);
      return { ...healthy, errors: 1, unchecked: why };
    },
    here: (after) => {
      calls.here++;
      calls.after.push(after);
      return onPage(after);
    },
  };
  return { load, calls };
}

/** What a worker counts for a text that parses and loads cleanly, and writes back as itself. */
const cleanCount = (text = 'package Q;'): MeasuredText => ({ parseErrors: 0, validationErrors: 0, rewritten: text });

describe('running a check from the palette', () => {
  const reach = CHECKS.find((c) => c.id === 'reach')!;
  const behaviour = CHECKS.find((c) => c.id === 'check-behaviour')!;
  const stats = CHECKS.find((c) => c.id === 'stats')!;
  const running = (id: string): boolean => useChecksStore.getState().running[id] !== undefined;
  const stored = (id: string): StoredResult | undefined => useChecksStore.getState().results[id];

  // A model with a state machine in it, which is what a walk is started for. One,
  // shared: a test that edits a model loads its own.
  let machine: Model;
  beforeAll(async () => {
    machine = (await loadModelText(hierarchical('Small', 1, 2, false), { fileName: 'small.sysml' })).model!;
  });
  const walkable = (over: Partial<CheckContext> = {}): CheckContext => ctx({ model: machine, ...over });

  const withFakeWorker = (): void => {
    FakeWorker.made = [];
    setCheckWorkerFactory(() => new FakeWorker());
  };

  afterEach(() => {
    vi.useRealTimers();
    resetCheckRunner();
    setCheckWorkerFactory(undefined);
    useChecksStore.setState({ results: {}, running: {}, runs: 0 });
  });

  it('runs a check that answers at once on the spot, with no worker started', () => {
    withFakeWorker();
    runChecked(stats, ctx(), 3);
    expect(FakeWorker.made).toHaveLength(0);
    expect(stored('stats')?.result.verdict).toBe('holds');
    expect(running('stats')).toBe(false);
  });

  it('runs a walk in the worker: running from the click, recorded when the worker answers', () => {
    withFakeWorker();
    const c = walkable();
    runChecked(reach, c, 3);
    expect(running('reach')).toBe(true);
    expect(stored('reach')).toBeUndefined();
    // The Checks tab comes forward at the click (`runs` moves), not when the answer comes.
    expect(useChecksStore.getState().runs).toBe(1);
    // What was sent is the user's part of this model, and who is asking.
    expect(FakeWorker.made).toHaveLength(1);
    const sent = FakeWorker.made[0].posted;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ check: 'reach', fileName: 'model.sysml', selectionId: null, library: libraryKey(c.model) });
    expect(sent[0].model.elements.length).toBe(c.model.all().filter((e) => e.attrs.isLibrary !== true).length);
    expect(sent[0].model.elements.some((e) => e.attrs.isLibrary === true)).toBe(false);

    FakeWorker.made[0].answer();
    expect(running('reach')).toBe(false);
    expect(stored('reach')).toMatchObject({ rev: 3, ranIn: 'worker', result: { summary: 'from the worker' } });
    // Landing does not bring the tab forward again: the person may be in another by now.
    expect(useChecksStore.getState().runs).toBe(1);
  });

  it('answers a model with no state machine on the spot, and starts no worker to say so', () => {
    withFakeWorker();
    const empty = ctx();
    expect(empty.model.all().some((e) => e.eClass === 'StateDefinition')).toBe(false);
    runChecked(reach, empty, 1);
    runChecked(behaviour, empty, 1);
    expect(FakeWorker.made).toHaveLength(0);
    expect([running('reach'), running('check-behaviour')]).toEqual([false, false]);
    expect(stored('reach')).toMatchObject({ ranIn: 'page', result: { verdict: 'not-run' } });
    expect(stored('check-behaviour')).toMatchObject({ ranIn: 'page', result: runCheck(behaviour, empty) });
    expect(useChecksStore.getState().runs).toBe(2);
    // And a model with one is walked in the worker, with nothing selected as well as with the machine.
    runChecked(behaviour, walkable(), 2);
    expect(FakeWorker.made).toHaveLength(1);
    expect(running('check-behaviour')).toBe(true);
  });

  it('records a result against the model and selection of the click, so an edit made meanwhile shows it stale', async () => {
    withFakeWorker();
    const model = (await loadModelText(hierarchical('Stale', 1, 2, false), { fileName: 'stale.sysml' })).model!;
    const modes = model.all().find((e) => e.eClass === 'StateDefinition' && e.attrs.isLibrary !== true)!;
    const c = ctx({ model, selectionId: modes.id, selectionName: 'Stale::Machine::Modes' });
    runChecked(behaviour, c, 5);
    // The model is edited while the walk runs.
    model.rename(modes.id, 'Modes2');
    FakeWorker.made[0].answer();
    const s = stored('check-behaviour')!;
    expect(s.rev).toBe(5);
    expect(s.selection).toBe(modes.id);
    expect(verdictOf(s, 6, modes.id)).toBe('stale');
    expect(verdictOf(s, 5, 'another element')).toBe('stale');
    expect(verdictOf(s, 5, modes.id)).toBe('holds');
  });

  it('does not start a check that is already running', () => {
    withFakeWorker();
    runChecked(reach, walkable(), 1);
    runChecked(reach, walkable(), 1);
    expect(FakeWorker.made).toHaveLength(1);
    expect(FakeWorker.made[0].posted).toHaveLength(1);
  });

  it('lets a second walk wait for the first: one worker, one run at a time', () => {
    withFakeWorker();
    runChecked(reach, walkable(), 1);
    runChecked(behaviour, walkable(), 1);
    expect([running('reach'), running('check-behaviour')]).toEqual([true, true]);
    expect(FakeWorker.made).toHaveLength(1);
    expect(FakeWorker.made[0].posted.map((r) => r.check)).toEqual(['reach']);

    FakeWorker.made[0].answer();
    expect([running('reach'), running('check-behaviour')]).toEqual([false, true]);
    expect(FakeWorker.made[0].posted.map((r) => r.check)).toEqual(['reach', 'check-behaviour']);
    FakeWorker.made[0].answer({ verdict: 'issues', summary: 'second', rows: [] });
    expect(stored('check-behaviour')?.result.summary).toBe('second');
    expect(FakeWorker.made).toHaveLength(1);
  });

  it('ends the worker on Cancel, keeps the result the check had, and starts a new worker for the next run', () => {
    withFakeWorker();
    runChecked(reach, walkable(), 1);
    FakeWorker.made[0].answer({ verdict: 'holds', summary: 'before', rows: [] });

    runChecked(reach, walkable(), 2);
    const first = FakeWorker.made[0];
    expect(running('reach')).toBe(true);
    cancelChecked('reach');
    expect(running('reach')).toBe(false);
    expect(first.terminated).toBe(true);
    // A cancelled run decided nothing: what the check said before stays. (`runs` moved at the click, as it does for any run.)
    expect(stored('reach')).toMatchObject({ rev: 1, result: { summary: 'before' } });
    expect(useChecksStore.getState().runs).toBe(2);
    // A reply that still comes from the ended worker lands nothing.
    first.answer({ verdict: 'issues', summary: 'too late', rows: [] });
    expect(stored('reach')?.result.summary).toBe('before');

    runChecked(reach, walkable(), 3);
    expect(FakeWorker.made).toHaveLength(2);
    expect(running('reach')).toBe(true);
    // And a reply that carries the token of the cancelled run is not this run's.
    FakeWorker.made[1].onmessage?.({ data: { id: FakeWorker.made[0].posted[1].id, ok: true, result: { verdict: 'issues', summary: 'old run', rows: [] } } });
    expect(running('reach')).toBe(true);
    FakeWorker.made[1].answer();
    expect(stored('reach')).toMatchObject({ rev: 3, result: { summary: 'from the worker' } });
  });

  it('takes a walk that is waiting out of the queue on Cancel, and lets the one running finish', () => {
    withFakeWorker();
    runChecked(reach, walkable(), 1);
    runChecked(behaviour, walkable(), 1);
    cancelChecked('check-behaviour');
    expect(running('check-behaviour')).toBe(false);
    expect(FakeWorker.made[0].terminated).toBe(false);
    FakeWorker.made[0].answer();
    expect(stored('reach')).toBeDefined();
    expect(FakeWorker.made[0].posted.map((r) => r.check)).toEqual(['reach']);
  });

  it('cancels the walk in the worker and runs the one waiting behind it in a new worker', () => {
    withFakeWorker();
    runChecked(reach, walkable(), 1);
    runChecked(behaviour, walkable(), 1);
    cancelChecked('reach');
    expect(FakeWorker.made[0].terminated).toBe(true);
    expect(FakeWorker.made).toHaveLength(2);
    expect(FakeWorker.made[1].posted.map((r) => r.check)).toEqual(['check-behaviour']);
    expect([running('reach'), running('check-behaviour')]).toEqual([false, true]);
  });

  it('runs the check here when the page has no worker, as every check did before', () => {
    setCheckWorkerFactory(null);
    runChecked(reach, walkable(), 4);
    expect(running('reach')).toBe(false);
    expect(stored('reach')).toMatchObject({ rev: 4, ranIn: 'page', result: runCheck(reach, walkable()) });
  });

  it('runs the check here when the worker says it could not, or dies, and never records a pass for it', () => {
    withFakeWorker();
    runChecked(reach, walkable(), 1);
    const w = FakeWorker.made[0];
    w.onmessage?.({ data: { id: w.posted[0].id, ok: false, message: 'library data not found' } });
    expect(running('reach')).toBe(false);
    expect(w.terminated).toBe(true);
    expect(stored('reach')).toMatchObject({ ranIn: 'page', result: runCheck(reach, walkable()) });

    runChecked(behaviour, walkable(), 2);
    const dying = FakeWorker.made[1];
    dying.onerror?.({ message: 'script failed to load' });
    expect(running('check-behaviour')).toBe(false);
    expect(dying.terminated).toBe(true);
    expect(stored('check-behaviour')?.result).toEqual(runCheck(behaviour, walkable()));
  });

  it('does not ask a worker about a library that one declined, until the page holds another', () => {
    withFakeWorker();
    const c = walkable();
    runChecked(reach, c, 1);
    const first = FakeWorker.made[0];
    first.onmessage?.({ data: { id: first.posted[0].id, ok: false, message: 'not the library this worker holds', libraryMismatch: true } });
    expect(first.terminated).toBe(true);
    expect(stored('reach')).toMatchObject({ rev: 1, ranIn: 'page', result: runCheck(reach, c) });

    // Every run after it, of either walker, is answered on the page, and no worker is started to be told the same.
    runChecked(reach, c, 2);
    runChecked(behaviour, c, 2);
    expect(FakeWorker.made).toHaveLength(1);
    expect([running('reach'), running('check-behaviour')]).toEqual([false, false]);
    expect(stored('reach')).toMatchObject({ rev: 2, ranIn: 'page', result: runCheck(reach, c) });
    expect(stored('check-behaviour')).toMatchObject({ rev: 2, ranIn: 'page', result: runCheck(behaviour, c) });

    // A page holding another library (here, one package) is a new question, and a worker is asked.
    const other = Model.fromJSON(JSON.parse(JSON.stringify(machine.toJSON())));
    other.create('Package', { declaredName: 'OtherLibrary', attrs: { isLibrary: true } });
    expect(libraryKey(other)).not.toBe(libraryKey(machine));
    runChecked(reach, ctx({ model: other }), 3);
    expect(FakeWorker.made).toHaveLength(2);
    expect(running('reach')).toBe(true);

    // A reply that is not about the library does not close the door on it.
    resetCheckRunner();
    FakeWorker.made = [];
    runChecked(reach, c, 4);
    const w = FakeWorker.made[0];
    w.onmessage?.({ data: { id: w.posted[0].id, ok: false, message: 'library data not found' } });
    runChecked(reach, c, 5);
    expect(FakeWorker.made).toHaveLength(2);
  });

  it('runs the check here when the model cannot be sent', () => {
    setCheckWorkerFactory(
      () =>
        Object.assign(new FakeWorker(), {
          postMessage() {
            throw new Error('DataCloneError');
          },
        }),
    );
    runChecked(reach, walkable(), 1);
    expect(running('reach')).toBe(false);
    expect(stored('reach')?.result).toEqual(runCheck(reach, walkable()));
  });

  it('ends a worker nobody has used for a minute, and starts another on the next run', () => {
    vi.useFakeTimers();
    withFakeWorker();
    runChecked(reach, walkable(), 1);
    FakeWorker.made[0].answer();
    vi.advanceTimersByTime(IDLE_MS - 1);
    expect(FakeWorker.made[0].terminated).toBe(false);
    vi.advanceTimersByTime(1);
    expect(FakeWorker.made[0].terminated).toBe(true);
    runChecked(reach, walkable(), 2);
    expect(FakeWorker.made).toHaveLength(2);
  });

  it('keeps a worker that has a run waiting, however long ago the run before it answered', () => {
    vi.useFakeTimers();
    withFakeWorker();
    runChecked(reach, walkable(), 1);
    FakeWorker.made[0].answer();
    vi.advanceTimersByTime(IDLE_MS - 10);
    runChecked(behaviour, walkable(), 1);
    // Past the minute the first answer started, and short of the one the second run has.
    vi.advanceTimersByTime(WATCHDOG_MS / 2);
    expect(FakeWorker.made[0].terminated).toBe(false);
    expect(running('check-behaviour')).toBe(true);
  });

  it('reads a reply that names no request as the answer to the run it waits on, and no other id as that run\'s', () => {
    withFakeWorker();
    runChecked(reach, walkable(), 1);
    const w = FakeWorker.made[0];
    // The browser could not read the request: the worker has no id to answer under (`NO_REQUEST`).
    w.onmessage?.({ data: { id: NO_REQUEST, ok: false, message: 'the request could not be read' } });
    expect(running('reach')).toBe(false);
    expect(w.terminated).toBe(true);
    expect(stored('reach')).toMatchObject({ ranIn: 'page', result: runCheck(reach, walkable()) });

    // A reply for some other run (a number the runner never handed out) is still nobody's.
    runChecked(behaviour, walkable(), 2);
    const next = FakeWorker.made[1];
    next.onmessage?.({ data: { id: 9999, ok: false, message: 'not this run' } });
    expect(running('check-behaviour')).toBe(true);
    expect(next.terminated).toBe(false);
  });

  it('runs the check here when the worker has said nothing for a minute, and not before', () => {
    vi.useFakeTimers();
    withFakeWorker();
    runChecked(reach, walkable(), 1);
    runChecked(behaviour, walkable(), 1);
    const hung = FakeWorker.made[0];
    vi.advanceTimersByTime(WATCHDOG_MS - 1);
    expect(running('reach')).toBe(true);
    expect(hung.terminated).toBe(false);
    vi.advanceTimersByTime(1);
    // The hung walk is answered on the page, which is what the check did before there was a worker...
    expect(hung.terminated).toBe(true);
    expect(running('reach')).toBe(false);
    expect(stored('reach')).toMatchObject({ ranIn: 'page', rev: 1, result: runCheck(reach, walkable()) });
    // ...and the one behind it was not left waiting for it: it has a new worker, and a minute of its own.
    expect(FakeWorker.made).toHaveLength(2);
    expect(FakeWorker.made[1].posted.map((r) => r.check)).toEqual(['check-behaviour']);
    vi.advanceTimersByTime(WATCHDOG_MS - 1);
    expect(running('check-behaviour')).toBe(true);
    FakeWorker.made[1].answer();
    expect(stored('check-behaviour')).toMatchObject({ ranIn: 'worker' });
    // An answer ends the wait: the minute that was running does not fire afterwards.
    vi.advanceTimersByTime(WATCHDOG_MS * 2);
    expect(FakeWorker.made).toHaveLength(2);
    expect(stored('check-behaviour')).toMatchObject({ ranIn: 'worker' });
  });

  it('does not run on the page a walk that Cancel has ended', () => {
    vi.useFakeTimers();
    withFakeWorker();
    runChecked(reach, walkable(), 1);
    cancelChecked('reach');
    vi.advanceTimersByTime(WATCHDOG_MS * 2);
    expect(stored('reach')).toBeUndefined();
    expect(running('reach')).toBe(false);
  });

  /*
   * The load first, in the worker (review 2026-10-14, D-3 and U3): a text no parse
   * has measured goes to the worker before the walk, and the page is not held for
   * the parse. A load nobody could measure is never clean.
   */
  it('checks the load in the worker before the walk: checking the load from the click, then the walk, judged over what the worker counted', () => {
    withFakeWorker();
    const { load, calls } = pendingLoad();
    runChecked(reach, walkable({ loadHealth: undefined }), 3, load);
    const run = useChecksStore.getState().running.reach;
    expect(run).toMatchObject({ phase: 'load', rev: 3 });
    expect(runningVerdict(run)).toBe('checking');
    const w = FakeWorker.made[0];
    expect(w.health).toEqual([{ id: expect.any(Number), kind: 'health', texts: load.unmeasured }]);
    expect(w.posted, 'no walk before its load is known').toHaveLength(0);

    w.measured([{ parseErrors: 2, validationErrors: 0, rewritten: null }]);
    expect(calls.finished).toEqual([[{ parseErrors: 2, validationErrors: 0, rewritten: null }]]);
    expect(useChecksStore.getState().running.reach).toMatchObject({ phase: 'walk' });
    expect(runningVerdict(useChecksStore.getState().running.reach)).toBe('running');
    // The walk goes to the same worker, judged over what it counted.
    expect(FakeWorker.made).toHaveLength(1);
    expect(w.posted).toHaveLength(1);
    expect(w.posted[0].loadHealth).toMatchObject({ errors: 2, saved: { parseErrors: 2 } });
    w.answer();
    expect(running('reach')).toBe(false);
    expect(stored('reach')).toMatchObject({ rev: 3, ranIn: 'worker', result: { summary: 'from the worker' } });
  });

  /** Each way a worker can fail to measure the load, and what the page is told of it. */
  const loadFailures = (): Array<[string, (w: FakeWorker) => void, string]> => [
    ['no counts', (w) => w.onmessage?.({ data: { id: w.health[0].id, ok: false, message: 'the library data could not be fetched' } }), 'the background worker could not check it (the library data could not be fetched)'],
    ['counts for other texts', (w) => w.measured([]), 'the background worker answered something other than the texts asked about'],
    ['an error', (w) => w.onerror?.({ message: 'script failed to load' }), 'the background worker stopped'],
    ['a reply it could not read', (w) => w.onmessageerror?.({}), 'the background worker could not read its answer'],
    ['a minute of silence', () => vi.advanceTimersByTime(WATCHDOG_MS), 'the background worker said nothing for a minute'],
  ];

  it('measures the load on the page where the worker could not, and the check runs here over that: a true answer, not none', () => {
    vi.useFakeTimers();
    const term = inline(TERM);
    const c = ctx({ model: term, loadHealth: undefined });
    let rev = 1;
    for (const [what, fail, why] of loadFailures()) {
      withFakeWorker();
      const { load, calls } = pendingLoad();
      runChecked(reach, c, rev, load);
      const w = FakeWorker.made[0];
      fail(w);
      expect(running('reach'), what).toBe(false);
      expect(w.terminated, what).toBe(true);
      expect(calls.here, what).toBe(1);
      expect(calls.after, what).toEqual([why]);
      expect(calls.finished, what).toHaveLength(0);
      expect(FakeWorker.made, `${what}: no second worker for the walk`).toHaveLength(1);
      expect(stored('reach'), what).toMatchObject({ rev, ranIn: 'page', result: runCheck(reach, { ...c, loadHealth: healthy }) });
      expect(stored('reach')!.result.verdict, `${what}: measured clean on the page, it holds`).toBe('holds');
      resetCheckRunner();
      rev++;
    }
  });

  it('takes a load neither the worker nor the page could measure as not checked: the check runs here over that, and never holds', () => {
    vi.useFakeTimers();
    const term = inline(TERM);
    const c = ctx({ model: term, loadHealth: undefined });
    expect(runCheck(reach, { ...c, loadHealth: healthy }).verdict, 'over a clean load, it holds').toBe('holds');
    // The page has no library either: what `loadHealthNow`'s `here` answers then.
    const noLibrary = (after: string | undefined): LoadHealth => ({ ...healthy, errors: 1, unchecked: `${after}, and the standard library has not loaded in this page` });
    let rev = 1;
    for (const [what, fail, why] of loadFailures()) {
      withFakeWorker();
      const { load } = pendingLoad(undefined, noLibrary);
      runChecked(reach, c, rev, load);
      fail(FakeWorker.made[0]);
      expect(running('reach'), what).toBe(false);
      const s = stored('reach')!;
      expect(s, what).toMatchObject({ rev, ranIn: 'page' });
      expect(s.result.verdict, what).toBe('undecided');
      expect(s.result.rows[0], what).toMatchObject({ code: 'checks/degraded', severity: 'warning' });
      expect(s.result.rows[0].message, what).toContain(`could not be checked (${why}, and the standard library has not loaded in this page)`);
      expect(s.result.rows[0].message, `${what}: reach lists what parsed`).toContain('this is a report of what parsed');
      expect(s.result.summary, what).toContain('could not be checked');
      resetCheckRunner();
      rev++;
    }
  });

  it('measures the load here where the page has no worker, or one cannot be started, as it always did', () => {
    setCheckWorkerFactory(null);
    const none = pendingLoad();
    runChecked(reach, walkable({ loadHealth: undefined }), 4, none.load);
    expect(none.calls.here).toBe(1);
    expect(running('reach')).toBe(false);
    expect(stored('reach')).toMatchObject({ rev: 4, ranIn: 'page', result: runCheck(reach, walkable()) });

    setCheckWorkerFactory(() => {
      throw new Error('this browser starts no module worker');
    });
    const refused = pendingLoad();
    runChecked(behaviour, walkable({ loadHealth: undefined }), 5, refused.load);
    expect(refused.calls.here).toBe(1);
    expect(stored('check-behaviour')).toMatchObject({ rev: 5, ranIn: 'page', result: runCheck(behaviour, walkable()) });
  });

  it('starts no load phase for a load already known', () => {
    withFakeWorker();
    runChecked(reach, walkable({ loadHealth: undefined }), 2, { known: healthy });
    expect(useChecksStore.getState().running.reach).toMatchObject({ phase: 'walk' });
    const w = FakeWorker.made[0];
    expect(w.health).toHaveLength(0);
    expect(w.posted[0].loadHealth).toEqual(healthy);
  });

  it('checks the load of a model with no state machine in the worker, then answers the check here: nothing to walk', () => {
    withFakeWorker();
    const { load } = pendingLoad();
    runChecked(reach, ctx({ loadHealth: undefined }), 1, load);
    const w = FakeWorker.made[0];
    expect(w.health).toHaveLength(1);
    expect(running('reach')).toBe(true);
    w.measured([cleanCount()]);
    expect(w.posted, 'no walk is sent').toHaveLength(0);
    expect(running('reach')).toBe(false);
    expect(stored('reach')).toMatchObject({ ranIn: 'page', result: runCheck(reach, ctx()) });
  });

  it('ends the worker on Cancel while the load is checked, and a late count lands nothing', () => {
    withFakeWorker();
    const { load, calls } = pendingLoad();
    runChecked(reach, walkable({ loadHealth: undefined }), 1, load);
    const w = FakeWorker.made[0];
    cancelChecked('reach');
    expect(w.terminated).toBe(true);
    expect(running('reach')).toBe(false);
    w.measured([cleanCount()]);
    expect(calls.finished).toHaveLength(0);
    expect(stored('reach')).toBeUndefined();
  });

  it('walks the model of the click: an edit made while the load is checked, or while a run ahead walks, is not what the worker walks (review 2026-10-14, L1)', () => {
    withFakeWorker();
    const m = inline(TERM);
    const transition = m.all().find((e) => e.eClass === 'TransitionUsage' && e.attrs.isLibrary !== true)!;
    const state = m.all().find((e) => e.declaredName === 'b' && e.attrs.isLibrary !== true)!;
    const sent = (req: CheckRequest) => ({
      effect: req.model.elements.find((e) => e.id === transition.id)?.attrs.effect,
      name: req.model.elements.find((e) => e.id === state.id)?.declaredName,
    });
    // Reach waits for its load; Behaviour properties, clicked while it does, waits for Reach.
    const { load } = pendingLoad();
    runChecked(reach, ctx({ model: m, loadHealth: undefined }), 1, load);
    runChecked(behaviour, ctx({ model: m, loadHealth: undefined }), 1, { known: healthy });
    expect(useChecksStore.getState().running['check-behaviour']).toMatchObject({ phase: 'walk' });
    // The person edits while the worker parses: an effect the text cannot hold, a rename (both change records in place).
    m.setAttrs(transition.id, { effect: '}' });
    m.rename(state.id, 'renamed');
    const w = FakeWorker.made[0];
    w.measured([cleanCount()]);
    expect(w.posted).toHaveLength(1);
    expect(sent(w.posted[0]), 'Reach walks the model its load was measured on').toEqual({ effect: undefined, name: 'b' });
    w.answer();
    expect(w.posted).toHaveLength(2);
    expect(sent(w.posted[1]), 'Behaviour properties walks the model of its click').toEqual({ effect: undefined, name: 'b' });
    w.answer();
    // Both land against the click's revision, so the edit shows them stale.
    expect(stored('reach')).toMatchObject({ rev: 1, ranIn: 'worker' });
    expect(verdictOf(stored('reach'), 2)).toBe('stale');
    expect(verdictOf(stored('check-behaviour'), 2)).toBe('stale');
  });

  /*
   * A run whose start would hold the page (review 2026-10-14, D-3): reading its load waits on an
   * edit's recompute, which validates the model and writes its text — most of a second on the
   * drone-swarm model. It begins at the click and reads the page once its row is drawn.
   */
  /** Fake timers with frames: the runner waits for one before it reads the page. */
  const withFrames = (): void => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  };
  /** A read that counts its calls and returns `start`. */
  const reading = (start: RunStart): { read: () => RunStart; reads: () => number } => {
    let n = 0;
    return {
      read: () => {
        n++;
        return start;
      },
      reads: () => n,
    };
  };

  it('begins at the click a run whose start would hold the page, and reads the page in a task after the next frame', () => {
    withFrames();
    withFakeWorker();
    const { load } = pendingLoad();
    const r = reading({ model: machine, rev: 4, health: load });
    runCheckedOnceDrawn(reach, walkable({ loadHealth: undefined }), 3, r.read);
    // Under way from the click, checking the load, the Checks tab brought forward; nothing read yet, no worker asked.
    expect(useChecksStore.getState().running.reach).toMatchObject({ phase: 'load', rev: 3 });
    expect(runningVerdict(useChecksStore.getState().running.reach)).toBe('checking');
    expect(useChecksStore.getState().runs).toBe(1);
    expect(r.reads()).toBe(0);
    expect(FakeWorker.made).toHaveLength(0);
    // The frame draws the row; the read is a task of its own after it.
    vi.advanceTimersToNextFrame();
    expect(r.reads(), 'not in the frame itself').toBe(0);
    vi.advanceTimersByTime(1);
    expect(r.reads()).toBe(1);
    // Then the run goes on as one begun at the click: the load to the worker, then the walk.
    const w = FakeWorker.made[0];
    expect(w.health).toEqual([{ id: expect.any(Number), kind: 'health', texts: load.unmeasured }]);
    w.measured([cleanCount()]);
    expect(useChecksStore.getState().running.reach).toMatchObject({ phase: 'walk' });
    w.answer();
    // It lands against the revision read with the load; the tab came forward once, at the click.
    expect(stored('reach')).toMatchObject({ rev: 4, ranIn: 'worker', result: { summary: 'from the worker' } });
    expect(useChecksStore.getState().runs).toBe(1);
    vi.advanceTimersByTime(FRAME_WAIT_MS);
    expect(r.reads(), 'once').toBe(1);
  });

  it('reads the page after FRAME_WAIT_MS where no frame comes (a page in a background tab)', () => {
    withFrames();
    vi.stubGlobal('requestAnimationFrame', () => 0);
    try {
      withFakeWorker();
      const r = reading({ model: machine, rev: 1, health: { known: healthy } });
      runCheckedOnceDrawn(reach, walkable(), 1, r.read);
      vi.advanceTimersByTime(FRAME_WAIT_MS - 1);
      expect(r.reads()).toBe(0);
      vi.advanceTimersByTime(1);
      expect(r.reads()).toBe(1);
      // A load already known: straight to the walk.
      expect(useChecksStore.getState().running.reach).toMatchObject({ phase: 'walk' });
      expect(FakeWorker.made[0].posted).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reads nothing for a run cancelled before its row is drawn, and a run begun again reads once', () => {
    withFrames();
    withFakeWorker();
    const first = reading({ model: machine, rev: 1, health: { known: healthy } });
    runCheckedOnceDrawn(reach, walkable(), 1, first.read);
    // Started again while it is under way: nothing new begins.
    runCheckedOnceDrawn(reach, walkable(), 1, first.read);
    runChecked(reach, walkable(), 1, { known: healthy });
    expect(useChecksStore.getState().runs).toBe(1);
    cancelChecked('reach');
    expect(running('reach')).toBe(false);
    const second = reading({ model: machine, rev: 2, health: { known: healthy } });
    runCheckedOnceDrawn(reach, walkable(), 2, second.read);
    vi.advanceTimersByTime(FRAME_WAIT_MS);
    expect([first.reads(), second.reads()]).toEqual([0, 1]);
    expect(FakeWorker.made).toHaveLength(1);
    expect(FakeWorker.made[0].posted).toHaveLength(1);
    FakeWorker.made[0].answer();
    expect(stored('reach')).toMatchObject({ rev: 2, ranIn: 'worker' });
  });

  it('lands a run with nothing to walk, once its row is drawn, as worked out here', () => {
    withFrames();
    withFakeWorker();
    const c = ctx({ loadHealth: undefined });
    runCheckedOnceDrawn(reach, c, 1, () => ({ model: c.model, rev: 2, health: { known: healthy } }));
    vi.advanceTimersByTime(FRAME_WAIT_MS);
    expect(running('reach')).toBe(false);
    expect(FakeWorker.made).toHaveLength(0);
    expect(stored('reach')).toMatchObject({ rev: 2, ranIn: 'page', result: runCheck(reach, ctx()) });
    expect(useChecksStore.getState().runs).toBe(1);
  });

  it('ends a run whose read throws as a check that threw does, not `checking the load…` until cancelled', () => {
    withFrames();
    withFakeWorker();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      runCheckedOnceDrawn(reach, walkable(), 3, () => {
        throw new Error('boom');
      });
      vi.advanceTimersByTime(FRAME_WAIT_MS);
      // Begun at the click with no job behind it, nothing else would end it: it lands at the click's revision.
      expect(running('reach')).toBe(false);
      expect(stored('reach')).toMatchObject({
        rev: 3,
        ranIn: 'page',
        result: { verdict: 'issues', rows: [{ code: 'checks/internal-error', message: 'boom', severity: 'error' }] },
      });
      expect(FakeWorker.made).toHaveLength(0);
      expect(logged).toHaveBeenCalled();
      // The next Run starts afresh.
      runCheckedOnceDrawn(reach, walkable(), 4, () => ({ model: machine, rev: 4, health: { known: healthy } }));
      vi.advanceTimersByTime(FRAME_WAIT_MS);
      FakeWorker.made[0].answer();
      expect(stored('reach')).toMatchObject({ rev: 4, ranIn: 'worker' });
    } finally {
      logged.mockRestore();
    }
  });
});

/*
 * The load, measured in the worker as a terminal measures it: `measureTextHealth`
 * is held to `loadModelText` — the CLI's loader, the real standard library merged —
 * over the corpus and a mutation fuzz of every field the serializer writes back
 * verbatim, so a count the app reads is a count a terminal prints.
 */
describe('the load, measured as a terminal measures it', () => {
  const terminal = async (text: string, file = 'm.sysml') => (await loadModelText(text, { fileName: file })).report;
  /** A terminal's errors of the text itself: the parse's, and the loader's own refusal of it (`import/*`). */
  const parseErrorsIn = (r: Awaited<ReturnType<typeof terminal>>) =>
    r.diagnostics.filter((d) => d.severity === 'error' && (d.ruleId === 'parse' || d.ruleId === 'import')).length;

  it('counts each text in the worker as a terminal loads it, and keeps the counts by text', async () => {
    const host = new CheckHost(mergeLibrary);
    const clean = read('examples/uav-isr.sysml');
    const faulty = 'package F { part def P { attribute rate : Real = 1 +; } }\n';
    const reply = await host.measure({ id: 4, kind: 'health', texts: [clean, faulty] });
    expect(reply).toMatchObject({ id: 4, ok: true });
    if (!reply.ok) return;
    for (const [i, text] of [clean, faulty].entries()) {
      const r = await terminal(text);
      expect(reply.texts[i].parseErrors + reply.texts[i].validationErrors).toBe(r.summary.errors);
      expect(reply.texts[i].parseErrors).toBe(parseErrorsIn(r));
    }
    expect(reply.texts[0]).toMatchObject({ parseErrors: 0, validationErrors: 0 });
    expect(reply.texts[1].parseErrors).toBeGreaterThan(0);
    // A text that parses is written back from its parse, for the page to set beside what the model on screen writes;
    // one that does not is faulty already.
    const back = await loadModelText(clean, { fileName: 'm.sysml' });
    expect(reply.texts[0].rewritten).toBe(serializeUserModelSignals(back.model!).text);
    expect(reply.texts[1].rewritten).toBeNull();
    const again = await host.measure({ id: 5, kind: 'health', texts: [faulty] });
    expect(again.ok && again.texts[0], 'kept, not parsed again').toBe(reply.texts[1]);
  }, 60_000);

  it('says it could not count when the library could not be loaded, and tries again on the next request', async () => {
    let attempts = 0;
    const host = new CheckHost((model) => {
      attempts++;
      if (attempts === 1) throw new Error('the library data could not be fetched');
      mergeLibrary(model);
    });
    expect(await host.measure({ id: 1, kind: 'health', texts: ['package Q;\n'] })).toEqual({
      id: 1,
      ok: false,
      message: 'the library data could not be fetched',
    });
    expect(await host.measure({ id: 2, kind: 'health', texts: ['package Q;\n'] })).toEqual({
      id: 2,
      ok: true,
      texts: [{ parseErrors: 0, validationErrors: 0, rewritten: 'package Q;' }],
    });
  });

  it('is a terminal’s count over the corpus: the fixtures, the examples and the authoring campaign', async () => {
    const files = (dir: string): string[] =>
      readdirSync(root(dir), { recursive: true, encoding: 'utf8' })
        .filter((f) => f.endsWith('.sysml'))
        .sort()
        .map((f) => `${dir}/${f}`);
    const corpus = [...files('test/fixtures/verification/models'), ...files('examples'), ...files('test/fixtures/agent-authoring')];
    expect(corpus.length).toBeGreaterThan(200);
    let faulty = 0;
    let fixpoints = 0;
    for (const file of corpus) {
      const text = read(file);
      const m = measureTextHealth(text, loadFullStandardLibrary);
      const loaded = await loadModelText(text, { fileName: file });
      const r = loaded.report;
      expect(m.parseErrors + m.validationErrors, file).toBe(r.summary.errors);
      expect(m.parseErrors, file).toBe(parseErrorsIn(r));
      if (!r.ok) faulty++;
      else if (!file.startsWith('test/fixtures/agent-authoring')) {
        // The model as the app writes it back is a file of itself, with the library bound: its parse writes the same text.
        const written = serializeUserModelSignals(loaded.model!).text;
        expect(measureTextHealth(written, loadFullStandardLibrary).rewritten, `${file}: written back, it reads as another model`).toBe(written);
        fixpoints++;
      }
    }
    expect(faulty, 'the campaign fixtures that test a fault').toBeGreaterThan(20);
    expect(fixpoints, 'the corpus models that load').toBeGreaterThan(60);
  }, 600_000);

  /** A model Reachability holds over, with a field of every kind the serializer writes back verbatim. */
  const FUZZ = `package Fz {
  state def M {
    state s1;
    state s2;
    state final;
    transition t1 first s1 then s2;
    transition t2 first s2 then final;
  }
  part def Pump { attribute rate : Real = 2; }
  constraint def Lim { in attribute lim : Real; lim <= 10 }
  part def Sys { part p : Pump [1]; }
}
`;
  const fuzzCases = (): Array<[string, string, Record<string, unknown> | string]> => [
    ...['}', 'do do', 'action (', 'a then s1; state s9; transition x first s2', '{', 'send'].map((v): [string, string, Record<string, unknown>] => ['t1', 'effect', { effect: v }]),
    ...['true )', 'x >', '(', '"', 'x > 0 then s2'].map((v): [string, string, Record<string, unknown>] => ['t1', 'guard', { guard: v }]),
    ...['go now', 'go;', 'a b }', 'after', '{'].map((v): [string, string, Record<string, unknown>] => ['t1', 'trigger', { trigger: v }]),
    ...[
      '2; attribute rate = 3',
      '1 +',
      '"a\nb"',
      '2 )',
      '2; part def Pump',
      '1 // c',
      '2 }',
      '"open',
      "'q",
      '2 [kg',
      '2; state def Z { state a; state b; state c; transition first a then b; } attribute zz = 0',
      '2; } state def Z { state a; state b; state c; transition first a then b; } part def Q { attribute zz = 0',
    ].map((v): [string, string, Record<string, unknown>] => ['rate', 'value', { value: v, valueText: undefined }]),
    ...['Real // kg', 'Real; part def Z', 'Real }'].map((v): [string, string, Record<string, unknown>] => ['rate', 'type', { type: v }]),
    ...[{ a: 1 }, [1, 2], NaN, Infinity, true].map((v): [string, string, Record<string, unknown>] => ['rate', 'value', { value: v, valueText: undefined }]),
    ...['lim <=', 'lim <= 10 }', 'lim <= 10; attribute q', ')'].map((v): [string, string, Record<string, unknown>] => ['Lim', 'expression', { expression: v }]),
    ...[['my meta'], ['X\nY'], ['A;B'], ['}']].map((v): [string, string, Record<string, unknown>] => ['Pump', 'metadata', { metadata: v }]),
    ...['k\ng', 'kg; part def Z'].map((v): [string, string, Record<string, unknown>] => ['rate', 'unit', { unit: v }]),
    ...['1..', '1 2', '*..*'].map((v): [string, string, Record<string, unknown>] => ['p', 'multiplicity', { multiplicity: v }]),
    ...['sideways', 'in out'].map((v): [string, string, Record<string, unknown>] => ['lim', 'direction', { direction: v }]),
    ...['Pu\nmp', '', 'done', "a'b", 'part', 'Pump Two', 'Pump;'].map((v): [string, string, string] => ['Pump', 'name', v]),
    ...['s\n2', 'state'].map((v): [string, string, string] => ['s2', 'name', v]),
  ];
  it('a mutation fuzz of every verbatim field, counted in the worker: a terminal’s count each time, so a text it rejects is never counted clean, and one it loads as another model is told apart', async () => {
    const host = new CheckHost(mergeLibrary);
    const term = (await terminal(FUZZ)).ok;
    expect(term, 'the fuzz starts from a text a terminal loads').toBe(true);
    const reach = CHECKS.find((c) => c.id === 'reach')!;
    const reachOver = (model: Model) => runCheck(reach, ctx({ model, loadHealth: healthy }));
    let rejected = 0;
    let other = 0;
    let id = 0;
    for (const [name, field, change] of fuzzCases()) {
      const model = parseModel(FUZZ).model;
      const el = model.all().find((e) => e.declaredName === name)!;
      if (typeof change === 'string') model.rename(el.id, change);
      else model.setAttrs(el.id, change as never);
      let text: string;
      try {
        text = serializeUserModelSignals(model).text;
      } catch {
        continue; // a model the serializer refuses is no file's text; the page counts it as unwritable
      }
      const what = `${name}.${field} = ${JSON.stringify(change)}`;
      const reply = await host.measure({ id: ++id, kind: 'health', texts: [text] });
      expect(reply.ok, what).toBe(true);
      if (!reply.ok) continue;
      const loaded = await loadModelText(text, { fileName: 'm.sysml' });
      const r = loaded.report;
      expect(reply.texts[0].parseErrors + reply.texts[0].validationErrors, `${what}\n${text}`).toBe(r.summary.errors);
      if (!r.ok) rejected++;
      else if (reply.texts[0].rewritten === text) {
        // Written back as itself: a file of the model fuzzed, and a terminal's Reachability over it is the page's.
        const [page, file] = [reachOver(model), reachOver(loaded.model!)];
        expect([file.verdict, file.rows.map((row) => row.code)], `${what}\n${text}`).toEqual([page.verdict, page.rows.map((row) => row.code)]);
      } else other++;
    }
    expect(rejected, 'the fuzz must make texts a terminal rejects').toBeGreaterThanOrEqual(30);
    expect(other, 'and texts a terminal loads as another model').toBeGreaterThanOrEqual(3);
  }, 300_000);
});
/* ════════════ the two behaviour lanes, judged as the terminal judges them ══ */

const root = (p: string): string => resolve(process.cwd(), p);
const read = (p: string): string => readFileSync(root(p), 'utf8');
const FIX = 'test/fixtures/verification/models';

/** Parse a snippet of textual notation to a bare model (no library). */
const inline = (src: string): Model => parseModel(src).model;

/** A model that loads cleanly and validates cleanly: `errors === 0`. */
const healthy: LoadHealth = {
  errors: 0,
  saved: { parseErrors: 0 },
  exported: { parseErrors: 0 },
  sameText: true,
  validationErrors: 0,
  validateThrew: false,
  unwritable: null,
  libraryPending: false,
};

/** A degraded model, one error deep, unless overridden. */
const degradedHealth = (over: Partial<LoadHealth> = {}): LoadHealth => ({
  errors: 1,
  saved: { parseErrors: 1 },
  exported: { parseErrors: 1 },
  sameText: true,
  validationErrors: 0,
  validateThrew: false,
  unwritable: null,
  libraryPending: false,
  ...over,
});

async function load(file: string): Promise<Model> {
  const loaded = await loadModelText(read(file), {
    fileName: file,
    library: file.startsWith('examples/') ? 'full' : 'none',
  });
  expect(loaded.model, `${file} did not load`).toBeDefined();
  return loaded.model!;
}

/** The reach result over a model, judged under a health (fails closed when absent). */
const reachOf = (model: Model, health?: LoadHealth) => {
  const r = reachReport(model);
  return reachResult(r, model, { fileName: 'model.sysml', health });
};

/** The check-behaviour result over one machine, judged under a health. */
const behaviourOf = (model: Model, machineId: ElementId, machineName: string, health?: LoadHealth) => {
  const b = behaviourReport(model, { machineId });
  return behaviourResult(b, model, { fileName: 'model.sysml', machineName, health });
};

/** A machine's id by qualified name. */
const idOf = (model: Model, qn: string): ElementId => {
  const el = model.all().find((e) => model.qualifiedName(e.id) === qn);
  expect(el, `no element named ${qn}`).toBeDefined();
  return el!.id;
};

/* The inline models the verdict table runs on. */
const TERM = 'package Q { state def Term { state a; state b; state final; transition a then b; transition b then final; } }';
const ACCEPT_CYCLE = 'package Q { state def Cyc { state a; state b; transition a_then_b first a accept go then b; transition b_then_a first b accept back then a; } }';
const COMPLETION_CYCLE = 'package Q { state def Cyc { state a; state b; transition a_then_b first a then b; transition b_then_a first b then a; } }';
const SPURIOUS = 'package P { state def M { state a; state b; state c; state d; transition a_b first a then b; transition a_c first a accept e then c; transition a_d first a accept e then d; transition b_a first b accept e then a; } }';
const GUARD_TRANSIENT = 'package P { state def M { state a; state b; state c; transition a_b first a then b; transition a_c first a accept e if x > 0 then c; transition b_a first b accept back then a; } }';
const LONELY = 'package Q { state def Lonely { state a; state b; } state def M { state x; state y; transition first x then y; transition first y then x; } part def Drone { exhibit state modes : M; } }';
const EXHIBIT_BODY = 'package Q { state def M { state x; state y; transition first x then y; transition first y then x; } part def Drone { exhibit state run : M { state extra; } } }';
const TYPO_TRANS = 'package Q { state def M { state a; state b; transiton a then b; transiton b then a; } }';

const carrier = (pattern: string, p: string): string =>
  `@SysproseVerification::PropertyPattern { attribute pattern = "${pattern}"; attribute scope = "globally"; attribute p = "${p}"; }`;
const mission = (pattern: string, p: string): string =>
  `package MissionDag { part def Mission { state def Modes { ${carrier(pattern, p)} state takeoff; state cruise; state landed; transition takeoff then cruise; transition cruise then landed; } } }`;
const MISSION_RESP =
  'package MissionDag { part def Mission { state def Modes { @SysproseVerification::PropertyPattern { attribute pattern = "response"; attribute scope = "globally"; attribute p = "state takeoff"; attribute s = "state landed"; } state takeoff; state cruise; state landed; transition takeoff then cruise; transition cruise then landed; } } }';
/** `a_b` is a completion transition beside `a accept e then c`: the `cover`/`absence` witness takes a gap. */
const a15 = (pattern: string): string =>
  `package P { state def M { ${carrier(pattern, 'state c')} state a; state b; state c; transition a_b first a then b; transition a_c first a accept e then c; transition b_a first b accept back then a; } }`;
const FALSE_GUARD = `package P { state def M { ${carrier('cover', 'state c')} attribute k = 0; state a; state b; state c; transition a_b first a if k > 0 then b; transition a_c first a accept e then c; } }`;
const TWO = `package Q { part def Two { state def A { ${carrier('absence', 'state y')} state x; state y; transition x -> y; } state def B { state m; state n; transition m -> n; } } }`;

describe('the reach verdict table', () => {
  it('reads undecided when a trap answer is withheld (latch), never holds', async () => {
    const model = await load(`${FIX}/latch.sysml`);
    const result = reachOf(model, healthy);
    expect(result.verdict).toBe('undecided');
    expect(result.summary).toContain('withheld on 1 of 1');
    // A withholding machine is a withheld answer, not a finding: no rows.
    expect(result.rows).toHaveLength(0);
  });

  it('reads undecided on a triggered machine the walk cannot finish', () => {
    expect(reachOf(inline(ACCEPT_CYCLE), healthy).verdict).toBe('undecided');
  });

  it('reads holds only on a terminating machine the walk finished', () => {
    expect(reachOf(inline(TERM), healthy).verdict).toBe('holds');
    // A completion livelock is not a bound hit, so the cycle still holds.
    expect(reachOf(inline(COMPLETION_CYCLE), healthy).verdict).toBe('holds');
  });

  it('reads holds on the views-tour completion livelock', async () => {
    const model = await load('examples/views-tour.sysml');
    expect(reachOf(model, healthy).verdict).toBe('holds');
  });

  it('lists exactly the trap-probe findings, in the terminal\u2019s order', async () => {
    const model = await load(`${FIX}/trap-probe.sysml`);
    const result = reachOf(model, healthy);
    expect(result.verdict).toBe('issues');
    expect(result.rows.map((r) => [r.code, r.severity])).toEqual([
      ['verification/unrecoverable-mode', 'warning'],
      ['verification/nondeterministic-choice', 'warning'],
    ]);
  });

  it('reports a confirmed deadlock as a finding (cover-reachable)', async () => {
    const model = await load(`${FIX}/cover-reachable.sysml`);
    const result = reachOf(model, healthy);
    expect(result.verdict).toBe('issues');
    expect(result.rows.map((r) => r.code)).toContain('verification/deadlock');
  });

  it('reports an undecided guard as findings (guard-undetermined), five rows', async () => {
    const model = await load(`${FIX}/guard-undetermined.sysml`);
    const result = reachOf(model, healthy);
    expect(result.verdict).toBe('issues');
    expect(result.rows.filter((r) => r.code === 'verification/guard-undetermined')).toHaveLength(1);
    expect(result.rows.filter((r) => r.severity === 'warning')).toHaveLength(5);
  });

  it('reports a withheld answer beside a finding (deadlock-guarded)', async () => {
    const model = await load(`${FIX}/deadlock-guarded.sysml`);
    const result = reachOf(model, healthy);
    expect(result.verdict).toBe('issues');
    expect(result.summary).toMatch(/withheld on 2 of 2/);
  });

  it('reports a typed undetermined guard as a finding (trapguard-typed)', async () => {
    const model = await load(`${FIX}/trapguard-typed.sysml`);
    expect(reachOf(model, healthy).verdict).toBe('issues');
  });

  it('reports `spurious`\u2019s unreachable states and dead transitions as findings (the walk is exact)', () => {
    const result = reachOf(inline(SPURIOUS), healthy);
    expect(result.verdict).toBe('issues');
    expect(result.rows.map((r) => r.code)).toEqual([
      'verification/unreachable-state',
      'verification/unreachable-state',
      'verification/dead-transition',
      'verification/dead-transition',
    ]);
  });

  it('reports `guardTransient`\u2019s dead transition as a finding (the walk is exact)', () => {
    const result = reachOf(inline(GUARD_TRANSIENT), healthy);
    expect(result.verdict).toBe('issues');
    expect(result.rows.map((r) => r.code)).toEqual([
      'verification/unreachable-state',
      'verification/dead-transition',
    ]);
  });

  it('marks states under no walked machine (lonely) as not-walked', () => {
    const result = reachOf(inline(LONELY), healthy);
    expect(result.verdict).toBe('undecided');
    expect(result.rows.filter((r) => r.code === 'checks/not-walked').map((r) => r.elementId)).toHaveLength(3);
  });

  it('marks an exhibit body and its extra state (exhibitBody) as not-walked', () => {
    const result = reachOf(inline(EXHIBIT_BODY), healthy);
    expect(result.verdict).toBe('undecided');
    expect(result.rows.filter((r) => r.code === 'checks/not-walked')).toHaveLength(2);
  });

  it('reads not-run, with not-walked rows, for a file that owns no transition (succession-only)', async () => {
    const model = await load(`${FIX}/succession-only.sysml`);
    const result = reachOf(model, healthy);
    expect(result.verdict).toBe('not-run');
    expect(result.rows.filter((r) => r.code === 'checks/not-walked')).toHaveLength(2);
  });

  it('reads undecided when a bound stops the walk', async () => {
    const model = await load('examples/views-tour.sysml');
    const r = reachReport(model, { maxConfigs: 1 });
    const result = reachResult(r, model, { fileName: 'model.sysml', health: healthy });
    expect(result.verdict).toBe('undecided');
  });

  it('never reads holds over a degraded or unknown health', () => {
    for (const model of [inline(TERM), inline(COMPLETION_CYCLE)]) {
      expect(reachOf(model, degradedHealth()).verdict).not.toBe('holds');
      expect(reachOf(model).verdict).not.toBe('holds');
    }
  });

  it('keeps a finding over a degraded model, but puts the degraded row first', async () => {
    const model = await load(`${FIX}/trap-probe.sysml`);
    const result = reachOf(model, degradedHealth());
    expect(result.verdict).toBe('issues');
    expect(result.rows[0].code).toBe('checks/degraded');
  });

  it('reads a partial parse as undecided, degraded first (typoTrans)', () => {
    const model = inline(TYPO_TRANS);
    const errors = parseModel(TYPO_TRANS).diagnostics.filter((d) => d.severity === 'error').length;
    expect(errors).toBeGreaterThan(0);
    const health = degradedHealth({ errors, saved: { parseErrors: errors }, exported: { parseErrors: errors } });
    const result = reachOf(model, health);
    expect(result.verdict).toBe('undecided');
    expect(result.summary).toContain('did not load cleanly');
    expect(result.rows[0].code).toBe('checks/degraded');
  });
});

describe('the check-behaviour verdicts', () => {
  const machine = (model: Model, qn: string): { id: ElementId; name: string } => {
    const m = stateMachinesIn(model).find((mm) => model.qualifiedName(mm.id) === qn);
    expect(m, `no machine ${qn}`).toBeDefined();
    return { id: m!.id, name: qn };
  };

  it('maps the exit arithmetic to the chip (missionFail, missionCover, missionResp)', () => {
    const fail = inline(mission('absence', 'state landed'));
    const failMachine = machine(fail, 'MissionDag::Mission::Modes');
    expect(behaviourOf(fail, failMachine.id, failMachine.name, healthy).verdict).toBe('issues');

    const cover = inline(mission('cover', 'state cruise'));
    const coverMachine = machine(cover, 'MissionDag::Mission::Modes');
    const covered = behaviourOf(cover, coverMachine.id, coverMachine.name, healthy);
    expect(covered.verdict).toBe('holds');
    expect(covered.summary).toContain('1 covered');

    const resp = inline(MISSION_RESP);
    const respMachine = machine(resp, 'MissionDag::Mission::Modes');
    expect(behaviourOf(resp, respMachine.id, respMachine.name, healthy).verdict).toBe('undecided');
  });

  it('reads undecided for a machine that states no property', () => {
    const two = inline(TWO);
    const b = machine(two, 'Q::Two::B');
    expect(behaviourOf(two, b.id, b.name, healthy).verdict).toBe('undecided');
  });

  it('demotes a degraded model to undecided', () => {
    const fail = inline(mission('absence', 'state landed'));
    const failMachine = machine(fail, 'MissionDag::Mission::Modes');
    expect(behaviourOf(fail, failMachine.id, failMachine.name, degradedHealth()).verdict).toBe('undecided');
  });

  it('reads a15 by the exact walk: cover is not-covered, absence passes', () => {
    const cover = inline(a15('cover'));
    const cm = machine(cover, 'P::M');
    // The exact walk never takes `e` while the completion `a_b` is due, so `c`
    // is unreachable: `cover state c` is `not covered`, and no witness is drawn.
    expect(behaviourReport(cover, { machineId: cm.id }).exitCode).toBe(2);
    const coverResult = behaviourOf(cover, cm.id, cm.name, healthy);
    expect(coverResult.verdict).toBe('undecided');
    expect(coverResult.rows.filter((r) => r.code === 'checks/walk-only')).toHaveLength(0);

    const absence = inline(a15('absence'));
    const am = machine(absence, 'P::M');
    expect(behaviourReport(absence, { machineId: am.id }).exitCode).toBe(0);
    expect(behaviourOf(absence, am.id, am.name, healthy).verdict).toBe('holds');
  });

  it('holds when the completion guard is false (falseGuard)', () => {
    const model = inline(FALSE_GUARD);
    const m = machine(model, 'P::M');
    const result = behaviourOf(model, m.id, m.name, healthy);
    expect(result.verdict).toBe('holds');
  });

  it('applies the terminal\u2019s exit arithmetic', () => {
    const fail = inline(mission('absence', 'state landed'));
    const fm = machine(fail, 'MissionDag::Mission::Modes');
    const b = behaviourReport(fail, { machineId: fm.id });
    expect(exitCodeOf(b.counts, b.properties.length, false)).toBe(b.exitCode);
  });
});

describe('the meta rows and codes (I2, I9)', () => {
  it('names only catalogued verification codes and the closed meta-code set', async () => {
    const model = await load(`${FIX}/guard-undetermined.sysml`);
    const result = reachOf(model, healthy);
    for (const row of result.rows) {
      expect(isKnownCode(row.code) || CHECK_META_CODES.includes(row.code), row.code).toBe(true);
      expect(row.code, row.code).not.toBe('verification/bound-hit');
      expect(row.code, row.code).not.toBe('verification/property');
    }
  });

  it('pins the meta codes to the checks/* literals in src/ui', () => {
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const name of readdirSync(dir)) {
        const abs = join(dir, name);
        if (statSync(abs).isDirectory()) walk(abs, out);
        else if (name.endsWith('.ts') || name.endsWith('.tsx')) out.push(abs);
      }
      return out;
    };
    const literals = new Set<string>();
    for (const file of walk(resolve(process.cwd(), 'src/ui'))) {
      for (const m of readFileSync(file, 'utf8').matchAll(/checks\/[a-z-]+/g)) literals.add(m[0]);
    }
    expect([...CHECK_META_CODES].sort()).toEqual([...literals].sort());
  });
});

describe('the reach rows project the report\u2019s diagnostics one to one', () => {
  const corpus: Array<{ file: string; model: Model }> = [];
  beforeAll(async () => {
    const files = [
      ...readdirSync(resolve(process.cwd(), FIX))
        .filter((n) => n.endsWith('.sysml'))
        .map((n) => `${FIX}/${n}`),
      'examples/views-tour.sysml',
      'examples/vehicle.sysml',
    ];
    for (const file of files) {
      const loaded = await loadModelText(read(file), {
        fileName: file,
        library: file.startsWith('examples/') ? 'full' : 'none',
      });
      if (loaded.model) corpus.push({ file, model: loaded.model });
    }
  }, 240_000);

  it('reads holds only where every machine is exact and nothing is withheld (I3, I17)', () => {
    for (const { file, model } of corpus) {
      const r = reachReport(model);
      const result = reachOf(model, healthy);
      if (result.verdict !== 'holds') continue;
      for (const m of r.machines) {
        expect(m.exhaustive, `${file} :: ${m.machine.qualifiedName}`).toBe(true);
        expect(m.exactness.walkIsExact, `${file} :: ${m.machine.qualifiedName}`).toBe(true);
        expect(withholds(m), `${file} :: ${m.machine.qualifiedName}`).toBe(false);
      }
      expect(r.diagnostics.filter((d) => d.severity === 'error' || d.severity === 'warning'), file).toEqual([]);
      expect(unwalkedStates(model, r), file).toEqual([]);
      expect(result.lines?.some((l) => l.withholds), file).toBe(false);
    }
  });

  it('marks every withheld leaf, unreached suppressed state, and unwalked state (I6)', () => {
    for (const { file, model } of corpus) {
      const r = reachReport(model);
      const { marks } = reachMarks(model, r);
      for (const m of r.machines) {
        const states = model
          .descendants(m.machine.id)
          .filter((d) => d.eClass === 'StateUsage' || d.eClass === 'ExhibitStateUsage');
        expect(m.states.total, `${file} :: ${m.machine.qualifiedName}`).toBe(states.length);
        for (const d of m.deadlocksWithheld) {
          expect(marks[d.leaf.id], `${file} :: ${d.leaf.qualifiedName}`).toBe('withheld');
        }
        if (m.suppressed || m.unsupported.length > 0) {
          const reached = new Set(m.states.reachable.map((s) => s.id));
          for (const d of states) {
            if (!reached.has(d.id)) {
              expect(marks[d.id], `${file} :: ${m.machine.qualifiedName} :: ${d.id}`).toBe('not-decided');
            }
          }
        }
        if (m.trapCensus.refusedByGate !== null) {
          for (const s of m.states.reachable) expect(marks[s.id]).not.toBe('trap');
        }
      }
      for (const id of unwalkedStates(model, r)) {
        expect(marks[id], `${file} :: ${id}`).toBe('not-walked');
      }
    }
  });
});

describe('the degraded row against the terminal (P14)', () => {
  let dir: string;
  const file = (name: string): string => join(dir, name);
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'checks-registry-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  async function cliSplit(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const realOut = process.stdout.write;
    const realErr = process.stderr.write;
    const sink = (into: string[]): typeof process.stdout.write => (chunk: unknown): boolean => {
      into.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    };
    process.stdout.write = sink(out);
    process.stderr.write = sink(err);
    let code: number;
    try {
      code = await sysproseMain(args);
    } finally {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
    }
    return { code, stdout: out.join(''), stderr: err.join('') };
  }

  it('names exit 1 for a model whose saved text fails and whose export parses (p5a)', async () => {
    // The applied text carries a syntax error `part x : ;`; Export writes the
    // recovered `part x;`, which parses.
    const typed = 'package C { state def M { state a; state b; transition a then b; transition b then a; } }\npackage Broken { part x : ; }\n';
    const exported = 'package C { state def M { state a; state b; transition a then b; transition b then a; } }\npackage Broken { part x; }\n';
    writeFileSync(file('p5a.sysml'), typed);
    const p = parseModel(typed).diagnostics.filter((d) => d.severity === 'error').length;
    expect(p).toBeGreaterThan(0);
    expect(parseModel(exported).diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
    const health = degradedHealth({
      errors: p,
      saved: { parseErrors: p },
      exported: { parseErrors: 0 },
      sameText: false,
    });
    const row = degradedRow('reach', health);
    expect(row.code).toBe('checks/degraded');
    expect(row.message).toContain('Save writes');
    expect(row.message).toContain('Export');
    expect(row.message).toContain('exits 1');
    expect(row.message).toContain('Export ▾ SysML writes the model as it stands, and that text parses');
    const got = await cliSplit(['reach', file('p5a.sysml'), '--no-library']);
    expect(got.code).toBe(1);
    // Only the text Save writes is refused: a file holding the one Export writes loads, so the
    // row names the one, not "either text" (review of load-health, 2026-10-15).
    expect(row.message).toContain('`reach` on a file holding the text Save writes exits 1');
    expect(row.message).not.toContain('either text');
    writeFileSync(file('p5a-export.sysml'), exported);
    expect((await cliSplit(['reach', file('p5a-export.sysml'), '--no-library'])).code, 'reach on a file holding the text Export writes').toBe(0);
    // The other way about: only the text Export writes has syntax errors.
    const exportFaulty = degradedRow('reach', degradedHealth({ errors: 1, saved: { parseErrors: 0 }, exported: { parseErrors: 1 }, sameText: false })).message;
    expect(exportFaulty).toContain('`reach` on a file holding the text Export ▾ SysML writes exits 1');
    expect(exportFaulty).not.toContain('that text parses');
    // Both faulty, or validation errors beside them: either text.
    expect(degradedRow('reach', degradedHealth({ errors: 2, saved: { parseErrors: 1 }, exported: { parseErrors: 1 }, sameText: false })).message).toContain(
      'on a file holding either text exits 1',
    );
    expect(degradedRow('reach', degradedHealth({ errors: 3, saved: { parseErrors: 1 }, exported: { parseErrors: 0 }, sameText: false, validationErrors: 2 })).message).toContain(
      'on a file holding either text exits 1',
    );
  });

  it('names exit 1 for reach and exit 2 for check-behaviour on a raw value (a18)', async () => {
    const text =
      'package C {\n  part def Ctl { state def M { state idle; state busy; transition idle then busy; transition busy then idle; } }\n  part def Pump { attribute rate : Real = 1 +; }\n}\n';
    writeFileSync(file('a18.sysml'), text);
    const errors = parseModel(text).diagnostics.filter((d) => d.severity === 'error').length;
    expect(errors).toBeGreaterThan(0);
    const health = degradedHealth({ errors, saved: { parseErrors: errors }, exported: { parseErrors: errors }, sameText: true });
    expect(degradedRow('reach', health).message).toContain('exits 1');
    expect(degradedRow('check-behaviour', health).message).toContain('exits 2');
    expect((await cliSplit(['reach', file('a18.sysml'), '--no-library'])).code).toBe(1);
    expect((await cliSplit(['check-behaviour', file('a18.sysml'), '--no-library', '--element', 'C::Ctl::M'])).code).toBe(2);
  });
});

describe('the machine pick against the terminal (I14)', () => {
  let dir: string;
  const file = (name: string): string => join(dir, name);
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'checks-registry-pick-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  async function cliSplit(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const realOut = process.stdout.write;
    const realErr = process.stderr.write;
    const sink = (into: string[]): typeof process.stdout.write => (chunk: unknown): boolean => {
      into.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    };
    process.stdout.write = sink(out);
    process.stderr.write = sink(err);
    let code: number;
    try {
      code = await sysproseMain(args);
    } finally {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
    }
    return { code, stdout: out.join(''), stderr: err.join('') };
  }

  it('refuses the way the terminal does, and runs the machine the terminal accepts', async () => {
    const model = inline(TWO);
    writeFileSync(file('two.sysml'), TWO);
    const twoId = idOf(model, 'Q::Two');
    const aId = idOf(model, 'Q::Two::A');
    const xId = idOf(model, 'Q::Two::A::x');

    // Nothing selected: the lead and the reason, and the carriers (only A).
    const none = pickBehaviourMachine(model, null);
    expect(none.kind).toBe('refused');
    if (none.kind === 'refused') {
      expect(none.summary).toBe(`${ELEMENT_REQUIRED_LEAD}${NO_DEFAULT_MACHINE}`);
      expect(none.rows).toHaveLength(1);
    }
    // A reference holding two machines: refused with one pick row each.
    const two = pickBehaviourMachine(model, twoId);
    expect(two.kind).toBe('refused');
    if (two.kind === 'refused') expect(two.rows).toHaveLength(2);
    // A state inside A: refused, one pick row for A.
    const state = pickBehaviourMachine(model, xId);
    expect(state.kind).toBe('refused');
    if (state.kind === 'refused') {
      expect(state.summary).toContain('inside `Q::Two::A`');
      expect(state.rows).toHaveLength(1);
    }
    // A machine: runs.
    expect(pickBehaviourMachine(model, aId).kind).toBe('machine');

    // The terminal agrees: exit 2 for the refusals, with the composer's words in stderr.
    expect((await cliSplit(['check-behaviour', file('two.sysml'), '--no-library'])).code).toBe(2);
    expect((await cliSplit(['check-behaviour', file('two.sysml'), '--no-library', '--element', 'Q::Two'])).code).toBe(2);
    const stateCli = await cliSplit(['check-behaviour', file('two.sysml'), '--no-library', '--element', 'Q::Two::A::x']);
    expect(stateCli.code).toBe(2);
    expect(stateCli.stderr).toContain('holds no state machine');
  });

  it('refuses a library element with the library sentence', async () => {
    const text = 'package P { state def M { state a; state b; transition a -> b; } }\n';
    const loaded = await loadModelText(text, { fileName: 'lib.sysml', library: 'full' });
    const model = loaded.model!;
    const libEl = model.all().find((el) => el.attrs.isLibrary === true);
    expect(libEl).toBeDefined();
    const pick = pickBehaviourMachine(model, libEl!.id);
    expect(pick.kind).toBe('refused');
    if (pick.kind === 'refused') {
      expect(pick.summary).toBe(libraryElementRefusal(model.qualifiedName(libEl!.id) || libEl!.id));
    }
  });

  it('runs a machine named by a quoted state definition (R1 should 5)', async () => {
    const text = "package Two { state def 'A b' { state x; state y; transition x -> y; } }\n";
    const model = inline(text);
    const machine = stateMachinesIn(model)[0];
    expect(model.qualifiedName(machine.id)).toBe('Two::A b');
    const pick = pickBehaviourMachine(model, machine.id);
    expect(pick.kind).toBe('machine');
    if (pick.kind === 'machine') {
      const result = behaviourOf(model, pick.id, pick.qualifiedName, healthy);
      expect(result.lines).toBeDefined();
      expect(result.verdict).toBe('undecided');
    }
    const spec = CHECKS.find((c) => c.id === 'check-behaviour')!;
    const note = commandNote(spec, ctx({ model, selectionId: machine.id, selectionName: 'Two::A b' }));
    expect(note).toContain('stands for Two::A b');
  });
});

describe('defaults and questions (I10)', () => {
  it('runs the copied command\u2019s options, and prints the terminal\u2019s default bounds', async () => {
    const reach = CHECKS.find((c) => c.id === 'reach')!;
    const command = reach.command(ctx());
    expect(command).not.toContain('--max-configs');
    expect(command).not.toContain('--pattern');

    const model = await load(`${FIX}/latch.sysml`);
    const r = reachReport(model);
    const lines = reachLines(r, { name: 'latch.sysml' });
    for (const l of lines.filter((x) => x.kind === 'figures')) {
      expect(l.text).toContain('maxConfigs 10000');
    }
  });

  it('asks the reach question, and a check-behaviour question that names the carriers', () => {
    const reach = CHECKS.find((c) => c.id === 'reach')!;
    const beh = CHECKS.find((c) => c.id === 'check-behaviour')!;
    expect(reach.question).toBe('Which states are reachable, which transitions are dead, where did the simulator hide a choice?');
    expect(beh.question.startsWith('Does this behaviour pattern hold on every reachable configuration, and can this design reach the situation I name?')).toBe(true);
    expect(beh.question).toContain('@PropertyPattern');
  });
});

describe('the Checks tab renders the terminal report (D.5 step 4)', () => {
  const reachSpec = CHECKS.find((c) => c.id === 'reach')!;
  const behSpec = CHECKS.find((c) => c.id === 'check-behaviour')!;

  /** Render `BehaviourReport` over a stored result, with no store and no mocks. */
  const mount = (checkId: string, result: CheckResult, model: Model) => {
    const onSelect = vi.fn();
    const view = render(
      React.createElement(BehaviourReport, {
        checkId,
        stored: { result, rev: 0, at: 0, ranIn: 'page' },
        exists: (id: string) => model.get(id) !== undefined,
        onSelect,
      }),
    );
    return { view, onSelect };
  };

  /** The first (only) machine of a single-machine model, for check-behaviour. */
  const singleMachine = (model: Model): { id: ElementId; name: string } => {
    const m = stateMachinesIn(model)[0];
    expect(m, 'no machine').toBeDefined();
    return { id: m.id, name: model.qualifiedName(m.id) };
  };

  it('renders one checks-report-line per line, data-withholds matching', () => {
    const model = inline(SPURIOUS);
    const result = runCheck(reachSpec, ctx({ model, loadHealth: healthy }));
    const { view } = mount('reach', result, model);
    const lines = result.lines!;
    const els = [...view.container.querySelectorAll('.checks-report-line')];
    expect(els).toHaveLength(lines.length);
    for (let i = 0; i < lines.length; i++) {
      expect(els[i].getAttribute('data-kind')).toBe(lines[i].kind);
      expect(els[i].getAttribute('data-withholds')).toBe(lines[i].withholds ? 'true' : 'false');
    }
  });

  it('makes a line that names a live element a button that selects it', () => {
    const model = inline(SPURIOUS);
    const result = runCheck(reachSpec, ctx({ model, loadHealth: healthy }));
    const { view, onSelect } = mount('reach', result, model);
    const lines = result.lines!;
    const firstClickable = lines.find(
      (l) => l.elementId !== null && l.kind !== 'witness-step' && model.get(l.elementId!) !== undefined,
    );
    expect(firstClickable, 'no line names a live element').toBeDefined();
    const buttons = [...view.container.querySelectorAll('.checks-report-line button')];
    expect(buttons.length, 'at least one line is a button').toBeGreaterThan(0);
    fireEvent.click(buttons[0]);
    expect(onSelect).toHaveBeenCalledWith(firstClickable!.elementId);
  });

  it('renders a15 cover as not-covered, with no witness (the walk is exact)', () => {
    const model = inline(a15('cover'));
    const m = singleMachine(model);
    const result = runCheck(
      behSpec,
      ctx({ model, selectionId: m.id, selectionName: m.name, loadHealth: healthy }),
    );
    const { view } = mount('check-behaviour', result, model);
    expect(view.container.querySelector('[data-claim="not-covered"]')).not.toBeNull();
    expect(view.container.querySelectorAll('.checks-report-line[data-kind="witness-step"]')).toHaveLength(0);
    expect(view.container.textContent).not.toContain('walk only');
  });

  it('labels a reach machine by qualified name, with its status tokens and chips', () => {
    const model = inline(SPURIOUS);
    const result = runCheck(reachSpec, ctx({ model, loadHealth: healthy }));
    const { view } = mount('reach', result, model);
    const machine = view.container.querySelector('.checks-report-machine')!;
    expect(machine.getAttribute('data-machine')).toBe('P::M');
    expect(machine.getAttribute('data-status')!.split(' ')).toEqual(
      expect.arrayContaining(['findings']),
    );
    expect(machine.getAttribute('data-status')).not.toContain('holds');
  });

  it('shows an inconclusive block\u2019s detail and never reads PASS or holds', () => {
    const model = inline(MISSION_RESP);
    const m = singleMachine(model);
    const result = runCheck(
      behSpec,
      ctx({ model, selectionId: m.id, selectionName: m.name, loadHealth: healthy }),
    );
    const { view } = mount('check-behaviour', result, model);
    const block = view.container.querySelector('[data-claim="inconclusive"]')!;
    expect(block.textContent).toContain('inconclusive: liveness not checked in-process');
    for (const el of block.querySelectorAll('*')) {
      expect(el.textContent, 'no element reads PASS').not.toBe('PASS');
      expect(el.textContent, 'no element reads holds').not.toBe('holds');
    }
  });

  it('shows a not-covered block\u2019s chip, never PASS or holds (a15)', () => {
    const model = inline(a15('cover'));
    const m = singleMachine(model);
    const result = runCheck(
      behSpec,
      ctx({ model, selectionId: m.id, selectionName: m.name, loadHealth: healthy }),
    );
    const { view } = mount('check-behaviour', result, model);
    const block = view.container.querySelector('[data-claim="not-covered"]')!;
    expect(block.textContent).toContain('NOT-COVERED');
    for (const el of block.querySelectorAll('*')) {
      expect(el.textContent, 'no element reads PASS').not.toBe('PASS');
      expect(el.textContent, 'no element reads holds').not.toBe('holds');
    }
  });

  it('does not flag the spurious lines walk-only (the walk is exact)', () => {
    const model = inline(SPURIOUS);
    const result = runCheck(reachSpec, ctx({ model, loadHealth: healthy }));
    const { view } = mount('reach', result, model);
    expect(view.container.querySelectorAll('.checks-report-line[data-walk-only="true"]')).toHaveLength(0);
    expect(view.container.querySelectorAll('.checks-report-line[data-kind="unreachable"]').length).toBeGreaterThan(0);
  });

  it('renders a state named <b>x</b> as text, never as markup (I11)', () => {
    const model = inline("package P { state def M { state a; state '<b>x</b>'; transition first a then a; } }");
    const result = runCheck(reachSpec, ctx({ model, loadHealth: healthy }));
    const { view } = mount('reach', result, model);
    expect(view.container.textContent).toContain('<b>x</b>');
    expect(view.container.querySelector('b')).toBeNull();
  });
});

describe('the state-view marks and the status panel (D.5 step 5)', () => {
  const marksOf = (model: Model) => {
    const r = reachReport(model);
    return reachMarks(model, r);
  };
  const mark = (marks: Record<string, ReachMark>, model: Model, qn: string): ReachMark => marks[idOf(model, qn)];

  it('marks guard-undetermined by the A.4 precedence', async () => {
    const model = await load(`${FIX}/guard-undetermined.sysml`);
    const { marks } = marksOf(model);
    expect(mark(marks, model, 'GuardProbe::Ctrl::Modes::idle')).toBe('withheld');
    expect(mark(marks, model, 'GuardProbe::Ctrl::Modes::hazard')).toBe('not-decided');
    expect(mark(marks, model, 'GuardProbe::Decided::Modes::hazard')).toBe('unreachable');
    expect(mark(marks, model, 'GuardProbe::Decided::Modes::idle')).toBe('no-way-out');
    expect(mark(marks, model, 'GuardProbe::Fires::Modes::hazard')).toBe('no-way-out');
  });

  it('marks trap-probe traps and its choice', async () => {
    const model = await load(`${FIX}/trap-probe.sysml`);
    const { marks } = marksOf(model);
    expect(mark(marks, model, 'TrapProbe::Probe::Modes::failsafe')).toBe('trap');
    expect(mark(marks, model, 'TrapProbe::Probe::Modes::failsafeHold')).toBe('trap');
    expect(mark(marks, model, 'TrapProbe::Probe::Modes::beta')).toBe('choice');
  });

  it('marks nothing on latch, and counts its trap refusal (never a state mark)', async () => {
    const model = await load(`${FIX}/latch.sysml`);
    const { marks, summary } = marksOf(model);
    expect(marks).toEqual({});
    expect(summary.trapWithheld).toBe(1);
  });

  it('marks the spurious unreachable states (the walk is exact)', () => {
    const model = inline(SPURIOUS);
    const { marks } = marksOf(model);
    expect(mark(marks, model, 'P::M::c')).toBe('unreachable');
    expect(mark(marks, model, 'P::M::d')).toBe('unreachable');
    expect(marks[idOf(model, 'P::M::a')]).toBeUndefined();
  });

  it('marks the lonely not-walked states', () => {
    const model = inline(LONELY);
    const { marks } = marksOf(model);
    expect(mark(marks, model, 'Q::Lonely::a')).toBe('not-walked');
    expect(mark(marks, model, 'Q::Lonely::b')).toBe('not-walked');
    expect(mark(marks, model, 'Q::Drone::modes')).toBe('not-walked');
  });

  it('walks a state def nested inside a machine as its own, so its states decide themselves', () => {
    const model = inline(
      'package N { state def M { state a; state b; transition a then b; transition b then a; state def Inner { state p; state q; transition p then q; } } }',
    );
    const { marks } = marksOf(model);
    // The nested definition's states are neither unreachable in the outer
    // machine nor unwalked: Inner is a machine, and it decides them.
    expect(marks[idOf(model, 'N::M::a')]).toBeUndefined();
    expect(marks[idOf(model, 'N::M::Inner::p')]).toBeUndefined();
    // `q` is the nested machine's real dead end, and it is a finding there.
    expect(mark(marks, model, 'N::M::Inner::q')).toBe('no-way-out');

    // A nested `state def` that owns no transition is nobody's machine, so its
    // states are read `not walked` rather than called unreachable under M.
    const empty = inline(
      'package N { state def M { state a; state b; transition a then b; state def Empty { state z; } } }',
    );
    expect(mark(marksOf(empty).marks, empty, 'N::M::Empty::z')).toBe('not-walked');
  });

  it('marks a dead transition and an undecided guard on the edge itself (S7)', () => {
    const deadModel = inline(
      'package P { state def M { state a; state b; state c; transition a then b; transition c then b; } }',
    );
    const dead = marksOf(deadModel);
    const deadTr = deadModel
      .all()
      .find((e) => e.eClass === 'TransitionUsage' && deadModel.get(e.source![0])?.declaredName === 'c')!;
    expect(dead.edgeMarks[deadTr.id]).toBe('dead');
    expect(dead.summary.edgeMarked.dead).toBe(1);

    const guardModel = inline(
      'package Q { state def M { attribute x; state a; state b; transition a if x > 0 then b; } }',
    );
    const guarded = marksOf(guardModel);
    const guardTr = guardModel.all().find((e) => e.eClass === 'TransitionUsage')!;
    expect(guarded.edgeMarks[guardTr.id]).toBe('undecided');
    expect(guarded.summary.edgeMarked.undecided).toBe(1);
  });

  it('states the withheld counts only when non-zero (I7)', async () => {
    const term = marksOf(inline(TERM)).summary;
    const line = marksStatusLine(term, 0);
    expect(line).toContain('no state marked');
    expect(line).not.toContain('trap answer withheld');
    expect(line).not.toContain('not decided on');
    expect(line).not.toContain('walk only');
    expect(line).not.toContain('not walked');
    expect(line).not.toContain('dead transition');
    expect(line).not.toContain('undecided guard');

    expect(marksStatusLine(marksOf(await load(`${FIX}/latch.sysml`)).summary, 0)).toContain(
      'trap answer withheld on 1 of 1',
    );
    expect(marksStatusLine(marksOf(inline(SPURIOUS)).summary, 0)).toContain('2 unreachable');
    expect(marksStatusLine(marksOf(inline(LONELY)).summary, 0)).toContain('3 not walked');

    // The edge marks read in their own words, after the state marks (S7).
    const dead = marksOf(
      inline('package P { state def M { state a; state b; state c; transition a then b; transition c then b; } }'),
    ).summary;
    expect(marksStatusLine(dead, 0)).toContain('1 dead transition(s)');
  });

  it('expands to the full meaning, naming a row', async () => {
    const text = marksStatusText(marksOf(await load(`${FIX}/trap-probe.sysml`)).summary);
    expect(text).toContain('names a row');
    // The base sentence states the walk's run-to-completion rule.
    expect(marksStatusText(marksOf(inline(SPURIOUS)).summary)).toContain('run-to-completion');
  });

  describe('behaviourClassesOf', () => {
    const storedOf = (model: Model): StoredResult => ({ result: reachOf(model, healthy), rev: 0, at: 0, ranIn: 'page' });
    const baseInput = (model: Model, stored: StoredResult) => ({
      reach: stored,
      beh: undefined,
      rev: 0,
      activeView: 'state' as ViewKind,
      marksHidden: false,
      witness: null as null,
      machineExists: (id: string) => model.get(id) !== undefined,
    });

    it('paints nothing on a stale rev, off the state view, or with marks hidden', () => {
      const model = inline(SPURIOUS);
      const base = baseInput(model, storedOf(model));
      expect(behaviourClassesOf(base).classes.size).toBeGreaterThan(0);
      expect(behaviourClassesOf({ ...base, rev: 1 }).classes.size).toBe(0);
      expect(behaviourClassesOf({ ...base, activeView: 'general' }).classes.size).toBe(0);
      expect(behaviourClassesOf({ ...base, marksHidden: true }).classes.size).toBe(0);
    });

    it('paints nothing for a witness at a non-current resultAt, and nothing beside an open witness', () => {
      const model = inline(SPURIOUS);
      const stored = storedOf(model);
      const machineId = idOf(model, 'P::M');
      const base = { ...baseInput(model, stored), beh: stored };
      // A witness whose resultAt no longer matches the stored run paints nothing.
      const stale = behaviourClassesOf({ ...base, witness: { resultAt: 999, machineId, block: 0, step: 0 } });
      expect(stale.witnessOpen).toBe(false);
      expect(stale.classes.size).toBeGreaterThan(0);
      // An open witness at the current resultAt suppresses the marks.
      const open = behaviourClassesOf({ ...base, witness: { resultAt: 0, machineId, block: 0, step: 0 } });
      expect(open.witnessOpen).toBe(true);
      expect(open.classes.size).toBe(0);
    });

    it('returns interned mark classes from the closed set, stable across calls', () => {
      const model = inline(SPURIOUS);
      const input = baseInput(model, storedOf(model));
      const a = behaviourClassesOf(input);
      const b = behaviourClassesOf(input);
      expect(a.classes.size).toBeGreaterThan(0);
      for (const [id, cls] of a.classes) {
        expect(b.classes.get(id), id).toBe(cls);
        expect(cls).toMatch(/^rf-beh rf-beh-[a-z-]+$/);
      }
      const unmarked = model.all().find((el) => el.eClass === 'StateUsage' && !a.classes.has(el.id));
      expect(unmarked, 'an unmarked state').toBeDefined();
      expect(a.classes.has(unmarked!.id)).toBe(false);
    });

    it('paints edge classes for a dead transition, and gives them up when the marks do (S7)', () => {
      const model = inline(
        'package P { state def M { state a; state b; state c; transition a then b; transition c then b; } }',
      );
      const stored = storedOf(model);
      const base = baseInput(model, stored);
      const res = behaviourClassesOf(base);
      expect(res.edgeClasses.size).toBeGreaterThan(0);
      for (const [, cls] of res.edgeClasses) {
        expect(cls).toMatch(/^rf-beh-edge rf-beh-edge-(dead|undecided)$/);
      }
      // Interned: two calls over equal input give the same strings by reference.
      const again = behaviourClassesOf(base);
      for (const [id, cls] of res.edgeClasses) expect(again.edgeClasses.get(id)).toBe(cls);
      // The same gates as the node marks: stale, off-view, hidden, an open witness.
      expect(behaviourClassesOf({ ...base, rev: 1 }).edgeClasses.size).toBe(0);
      expect(behaviourClassesOf({ ...base, activeView: 'general' }).edgeClasses.size).toBe(0);
      expect(behaviourClassesOf({ ...base, marksHidden: true }).edgeClasses.size).toBe(0);
    });
  });
});

describe('the witness stepper (D.5 step 6)', () => {
  const machineOf = (model: Model) => {
    const m = stateMachinesIn(model)[0];
    expect(m, 'no machine').toBeDefined();
    return { id: m!.id, name: model.qualifiedName(m!.id) };
  };
  /** `compactWitnesses` over the report, the way `behaviourResult` stores it. */
  const witnessViews = (model: Model) => {
    const m = machineOf(model);
    const b = behaviourReport(model, { machineId: m.id });
    const lines = behaviourLines(b, { name: 'model.sysml', machineName: m.name });
    return { b, views: compactWitnesses(b, lines) };
  };

  it('compacts the missionFail witness to the CLI traceLine rows', () => {
    const model = inline(mission('absence', 'state landed'));
    const { b, views } = witnessViews(model);
    expect(views).toHaveLength(1);
    expect(views[0].machineId).not.toBeNull();
    expect(views[0].steps).toHaveLength(3);
    expect(views[0].steps.map((s) => s.text)).toEqual(b.properties[0].witness.map((s) => traceLine(s)));
    // The opening step carries no transition, and the leaf ids match the witness.
    expect(views[0].steps[0].index).toBe(0);
    expect(views[0].steps[0].transitionId).toBeNull();
    expect(views[0].steps[2].leafId).toBe(idOf(model, 'MissionDag::Mission::Modes::landed'));
  });

  it('compacts no witness for a15 cover (the walk is exact, so there is none)', () => {
    const model = inline(a15('cover'));
    const { views } = witnessViews(model);
    expect(views).toHaveLength(0);
  });

  it('renders a witness as step buttons with prev/next/close, and never selects', () => {
    const model = inline(mission('absence', 'state landed'));
    const m = machineOf(model);
    const result = runCheck(
      CHECKS.find((c) => c.id === 'check-behaviour')!,
      ctx({ model, selectionId: m.id, selectionName: m.name, loadHealth: healthy }),
    );
    const onSelect = vi.fn();
    const view = render(
      React.createElement(BehaviourReport, {
        checkId: 'check-behaviour',
        stored: { result, rev: 0, at: 0, ranIn: 'page' },
        exists: (id: string) => model.get(id) !== undefined,
        onSelect,
      }),
    );
    const steps = [...view.container.querySelectorAll('.checks-witness-step')];
    expect(steps).toHaveLength(3);
    expect(steps[2].getAttribute('data-step')).toBe('2');
    expect(view.container.querySelector('.checks-witness-prev')).not.toBeNull();
    expect(view.container.querySelector('.checks-witness-next')).not.toBeNull();
    expect(view.container.querySelector('.checks-witness-close')).not.toBeNull();
    fireEvent.click(steps[2]);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('never constructs a SimulationSession or calls select on the witness path (I12, I19)', () => {
    for (const file of ['src/ui/behaviour-checks.ts', 'src/ui/panels/BehaviourReport.tsx', 'src/ui/panels/behaviour-store.ts']) {
      const src = readFileSync(root(file), 'utf8');
      expect(src, `${file} constructs a SimulationSession`).not.toContain('SimulationSession');
      expect(src, `${file} calls simStart`).not.toContain('simStart');
      expect(src, `${file} calls simInject`).not.toContain('simInject');
      expect(src, `${file} calls simAdvance`).not.toContain('simAdvance');
      expect(src, `${file} calls select(`).not.toContain('select(');
    }
  });
});
