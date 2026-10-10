/**
 * The palette's Checks section, against the CLI it names.
 *
 * The registry's promise is that what a person runs in the app and what they
 * run in a terminal are the same check. That holds only if every entry names a
 * real subcommand, every view offers something, and a check that cannot run
 * here says so instead of returning a verdict it has not earned.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { buildSampleModel, Model } from '@core/index';
import { contractReport, isUserElement, obligationsReport } from '@api/index';
import { loadModelText } from '@text/load';
import { resolveConnectorFeatureChains } from '@text/index';
import { loadFullStandardLibrary } from '@library/full-library';
import { loadCuratedLibrary } from '@library/standard-library';
import { resolveTypeReferences } from '@library/resolve';
import {
  CHECKS,
  checkScope,
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
} from '../../src/ui/checks-offthread';
import { useChecksStore, verdictOf, type StoredResult } from '../../src/ui/panels/checks-store';
import {
  IDLE_MS,
  WATCHDOG_MS,
  cancelChecked,
  resetCheckRunner,
  runChecked,
  setCheckWorkerFactory,
  type CheckWorker,
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
    expect(runCheck(reach, c).summary).toContain('1 unreachable state');
    expect(before.summary).toContain('0 unreachable state');
    const host = new CheckHost(mergeLibrary);
    const reply = await host.handle(sent);
    expect(reply.ok && reply.result).toEqual(before);
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
      expect(reply, what).toMatchObject({ id: 1, message: expect.stringContaining('standard library') });
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
  posted: CheckRequest[] = [];
  terminated = false;
  onmessage: CheckWorker['onmessage'] = null;
  onerror: CheckWorker['onerror'] = null;
  onmessageerror: CheckWorker['onmessageerror'] = null;
  constructor() {
    FakeWorker.made.push(this);
  }
  postMessage(message: CheckRequest): void {
    this.posted.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  /** Answer the latest request with `result`, as the worker would. */
  answer(result: CheckResult = { verdict: 'holds', summary: 'from the worker', rows: [] }): void {
    const req = this.posted[this.posted.length - 1];
    this.onmessage?.({ data: { id: req.id, ok: true, result } satisfies CheckReply });
  }
}

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
    expect(stored('reach')).toMatchObject({ ranIn: 'page', result: { verdict: 'not-run', summary: 'No state machine in this model.' } });
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
});
