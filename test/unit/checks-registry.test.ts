/**
 * The palette's Checks section, against the CLI it names.
 *
 * The registry's promise is that what a person runs in the app and what they
 * run in a terminal are the same check. That holds only if every entry names a
 * real subcommand, every view offers something, and a check that cannot run
 * here says so instead of returning a verdict it has not earned.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { fireEvent, render } from '@testing-library/react';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildSampleModel, type ElementId, type Model } from '@core/index';
import { isKnownCode, parseModel } from '@text/index';
import { loadModelText } from '@text/load';
import { reachReport, stateMachinesIn } from '@semantics/mc/explore';
import { behaviourReport, exitCodeOf } from '@semantics/mc/patterns';
import { confirmUnderRunToCompletion } from '@semantics/mc/rtc-gap';
import {
  ELEMENT_REQUIRED_LEAD,
  NO_DEFAULT_MACHINE,
  libraryElementRefusal,
  reachLines,
} from '@semantics/mc/report-lines';
import {
  CHECKS,
  CHECK_META_CODES,
  checksFor,
  commandFileName,
  commandNote,
  runCheck,
  NOT_ISOLATED,
  QUALIFIED_NAME_PLACEHOLDER,
  type CheckContext,
  type CheckResult,
} from '../../src/ui/checks';
import { BehaviourReport } from '../../src/ui/panels/BehaviourReport';
import {
  behaviourResult,
  degradedRow,
  pickBehaviourMachine,
  reachResult,
  unwalkedStates,
  withholds,
} from '../../src/ui/behaviour-checks';
import type { LoadHealth } from '../../src/ui/store';
import { COMMANDS } from '../../scripts/lib/sysprose-spec';
import { main as sysproseMain } from '../../scripts/sysprose';
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

  it('turns a check that throws into a finding, never into a pass', () => {
    const broken = { ...CHECKS[0], id: 'stats', run: () => { throw new Error('boom'); } };
    const result = runCheck(broken, ctx());
    expect(result.verdict).toBe('issues');
    expect(result.rows[0].code).toBe('checks/internal-error');
    expect(result.rows[0].message).toContain('boom');
  });
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
  const confirmations = r.machines.map((m) => confirmUnderRunToCompletion(model, m));
  return reachResult(r, model, { fileName: 'model.sysml', health, confirmations });
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

  it('demotes the walk-only rows of `spurious` to undecided, flagged walk-only', () => {
    const result = reachOf(inline(SPURIOUS), healthy);
    expect(result.verdict).toBe('undecided');
    expect(result.rows.filter((r) => r.code === 'checks/walk-only')).toHaveLength(1);
    expect(result.rows.filter((r) => r.code.startsWith('verification/') && r.walkOnly)).toHaveLength(3);
  });

  it('demotes an undecided guard consulted only where a completion is due (guardTransient)', () => {
    const result = reachOf(inline(GUARD_TRANSIENT), healthy);
    expect(result.verdict).toBe('undecided');
    expect(result.rows.filter((r) => r.code === 'verification/guard-undetermined' && r.walkOnly)).toHaveLength(1);
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
    const confirmations = r.machines.map((m) => confirmUnderRunToCompletion(model, m));
    const result = reachResult(r, model, { fileName: 'model.sysml', health: healthy, confirmations });
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

  it('does not count a witness that takes a run-to-completion gap (a15)', () => {
    for (const [pattern, expectedExit] of [['cover', 0], ['absence', 1]] as const) {
      const model = inline(a15(pattern));
      const m = machine(model, 'P::M');
      // The terminal still reports the witness and its exit; the page demotes it.
      expect(behaviourReport(model, { machineId: m.id }).exitCode, pattern).toBe(expectedExit);
      const result = behaviourOf(model, m.id, m.name, healthy);
      expect(result.verdict, pattern).toBe('undecided');
      expect(result.rows.filter((r) => r.code === 'checks/walk-only'), pattern).toHaveLength(1);
    }
  });

  it('holds when the completion guard is false (falseGuard)', () => {
    const model = inline(FALSE_GUARD);
    const m = machine(model, 'P::M');
    const result = behaviourOf(model, m.id, m.name, healthy);
    expect(result.verdict).toBe('holds');
  });

  it('applies the terminal\u2019s exit arithmetic before demotion', () => {
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
        stored: { result, rev: 0, at: 0 },
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

  it('keeps witness-step lines as plain text, not buttons', () => {
    const model = inline(mission('absence', 'state landed'));
    const m = singleMachine(model);
    const result = runCheck(
      behSpec,
      ctx({ model, selectionId: m.id, selectionName: m.name, loadHealth: healthy }),
    );
    const { view } = mount('check-behaviour', result, model);
    const steps = [...view.container.querySelectorAll('.checks-report-line[data-kind="witness-step"]')];
    expect(steps).toHaveLength(3);
    for (const el of steps) expect(el.querySelector('button')).toBeNull();
    expect(view.container.querySelector('[data-claim="fail"]')).not.toBeNull();
  });

  it('labels a reach machine by qualified name, with its status tokens and chips', () => {
    const model = inline(SPURIOUS);
    const result = runCheck(reachSpec, ctx({ model, loadHealth: healthy }));
    const { view } = mount('reach', result, model);
    const machine = view.container.querySelector('.checks-report-machine')!;
    expect(machine.getAttribute('data-machine')).toBe('P::M');
    expect(machine.getAttribute('data-status')!.split(' ')).toEqual(
      expect.arrayContaining(['withheld', 'walk-only']),
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

  it('shows a demoted block\u2019s NOT COUNTED chip and note, never PASS', () => {
    const model = inline(a15('cover'));
    const m = singleMachine(model);
    const result = runCheck(
      behSpec,
      ctx({ model, selectionId: m.id, selectionName: m.name, loadHealth: healthy }),
    );
    const { view } = mount('check-behaviour', result, model);
    const block = view.container.querySelector('[data-claim="covered"][data-walk-only="true"]')!;
    expect(block.textContent).toContain('NOT COUNTED');
    expect(block.querySelector('[data-testid="checks-report-note"]')).not.toBeNull();
    expect(block.textContent).toContain('covered — witness trace');
    for (const el of block.querySelectorAll('*')) {
      expect(el.textContent, 'no element reads PASS').not.toBe('PASS');
      expect(el.textContent, 'no element reads holds').not.toBe('holds');
    }
  });

  it('flags the spurious no-way-out and choice lines walk-only', () => {
    const model = inline(SPURIOUS);
    const result = runCheck(reachSpec, ctx({ model, loadHealth: healthy }));
    const { view } = mount('reach', result, model);
    expect(
      view.container.querySelectorAll('.checks-report-line[data-kind="no-way-out"][data-walk-only="true"]'),
    ).toHaveLength(2);
    expect(
      view.container.querySelectorAll('.checks-report-line[data-kind="choice"][data-walk-only="true"]'),
    ).toHaveLength(1);
  });

  it('renders a state named <b>x</b> as text, never as markup (I11)', () => {
    const model = inline("package P { state def M { state a; state '<b>x</b>'; transition first a then a; } }");
    const result = runCheck(reachSpec, ctx({ model, loadHealth: healthy }));
    const { view } = mount('reach', result, model);
    expect(view.container.textContent).toContain('<b>x</b>');
    expect(view.container.querySelector('b')).toBeNull();
  });
});
