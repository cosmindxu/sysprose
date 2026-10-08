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
import { buildSampleModel } from '@core/index';
import {
  CHECKS,
  checksFor,
  commandFileName,
  commandNote,
  runCheck,
  NOT_ISOLATED,
  QUALIFIED_NAME_PLACEHOLDER,
  type CheckContext,
} from '../../src/ui/checks';
import { COMMANDS } from '../../scripts/lib/sysprose-spec';
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
