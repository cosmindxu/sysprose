/**
 * The palette's Checks section, against the CLI it names.
 *
 * The registry's promise is that what a person runs in the app and what they
 * run in a terminal are the same check. That holds only if every entry names a
 * real subcommand, every view offers something, and a check that cannot run
 * here says so instead of returning a verdict it has not earned.
 */
import { describe, expect, it } from 'vitest';
import { buildSampleModel } from '@core/index';
import { CHECKS, checksFor, runCheck, NOT_ISOLATED, type CheckContext } from '../../src/ui/checks';
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

  it('turns a check that throws into a finding, never into a pass', () => {
    const broken = { ...CHECKS[0], id: 'stats', run: () => { throw new Error('boom'); } };
    const result = runCheck(broken, ctx());
    expect(result.verdict).toBe('issues');
    expect(result.rows[0].code).toBe('checks/internal-error');
    expect(result.rows[0].message).toContain('boom');
  });
});
