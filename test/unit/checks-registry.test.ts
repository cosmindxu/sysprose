/**
 * The palette's Checks section, against the CLI it names.
 *
 * The registry's promise is that what a person runs in the app and what they
 * run in a terminal are the same check. That holds only if every entry names a
 * real subcommand, every view offers something, and a check that cannot run
 * here says so instead of returning a verdict it has not earned.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { buildSampleModel } from '@core/index';
import { contractReport, isUserElement, obligationsReport } from '@api/index';
import { loadModelText } from '@text/load';
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
} from '../../src/ui/checks';
import { COMMANDS } from '../../scripts/lib/sysprose-spec';
import { main as sysproseMain } from '../../scripts/sysprose';
import { verdictOf, type StoredResult } from '../../src/ui/panels/checks-store';
import type { ViewKind } from '@diagram/index';

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
