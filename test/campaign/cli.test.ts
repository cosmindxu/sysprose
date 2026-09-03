/**
 * Level L7 — the command-line channel.
 *
 * The CLI is how an agent actually reaches the checker, so its CONTRACT is
 * tested, not just its happy path: the exit code an automation branches on, the
 * JSON shape it parses, and the guarantee that an unexpected failure never
 * exits 0 (a silent pass is the one outcome that would let a broken model
 * through).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve(process.cwd(), 'scripts/sysml-check.ts');
const FIX = resolve(process.cwd(), 'test/fixtures/agent-authoring');

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], input?: string): Run {
  try {
    const stdout = execFileSync('npx', ['tsx', CLI, ...args], {
      encoding: 'utf8',
      ...(input !== undefined ? { input } : {}),
      stdio: input !== undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('L7 — CLI contract', () => {
  it('exits 0 and says OK for a file with no errors', () => {
    const r = run([`${FIX}/L0-empty-file/fixed.sysml`]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('OK');
  }, 60_000);

  it('exits 1 for a file with errors, naming file, line and column', () => {
    const r = run([`${FIX}/L2-extra-closing-brace/input.sysml`]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/input\.sysml:\d+:\d+: error parse\/not-all-input-parsed/);
    expect(r.stdout).toContain('hint:');
  }, 60_000);

  it('exits 2 with usage when given no files', () => {
    const r = run([]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Usage');
  }, 60_000);

  it('exits 2 when a file cannot be read, and checks nothing', () => {
    const r = run([`${FIX}/does-not-exist.sysml`]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('cannot read');
  }, 60_000);

  it('emits a JSON report an agent can parse', () => {
    const r = run([`${FIX}/L4-duplicate-name/input.sysml`, '--json']);
    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.stdout) as {
      ok: boolean;
      files: Array<{
        fileName: string;
        ok: boolean;
        summary: { errors: number };
        diagnostics: Array<{ code: string; range?: { start: { line: number } }; hint?: string }>;
      }>;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.files).toHaveLength(1);
    const [f] = parsed.files;
    expect(f.summary.errors).toBeGreaterThan(0);
    const dup = f.diagnostics.find((d) => d.code === 'validation/duplicate-name');
    expect(dup, 'the duplicate-name finding must be present').toBeDefined();
    expect(dup?.range?.start.line, 'and must carry a line number').toBeGreaterThan(0);
    expect(dup?.hint, 'and a hint').toBeTruthy();
  }, 60_000);

  it('reads from stdin with -', () => {
    const r = run(['-'], 'package P {\n    part def A;\n    part def A;\n}\n');
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('duplicate-name');
  }, 60_000);

  it('checks several files at once and fails if any one fails', () => {
    const r = run([
      `${FIX}/L0-empty-file/fixed.sysml`,
      `${FIX}/L2-extra-closing-brace/input.sysml`,
      '--json',
    ]);
    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.stdout) as { ok: boolean; files: Array<{ ok: boolean }> };
    expect(parsed.files).toHaveLength(2);
    expect(parsed.files[0].ok).toBe(true);
    expect(parsed.files[1].ok).toBe(false);
    expect(parsed.ok).toBe(false);
  }, 90_000);

  it('--strict turns warnings into a failure', () => {
    const clean = run([`${FIX}/L4-port-no-direction/input.sysml`]);
    const strict = run([`${FIX}/L4-port-no-direction/input.sysml`, '--strict']);
    expect(clean.code, 'warnings alone do not fail by default').toBe(0);
    expect(strict.code, 'but they do with --strict').toBe(1);
  }, 90_000);

  it('--strict stays clean for a string value that happens to contain brackets', () => {
    // Review finding: `"R-UAV-001 [rev A]"` was read as a `[rev A]` unit and
    // failed --strict on a model that was clean before the body scan.
    const dir = mkdtempSync(join(tmpdir(), 'sysprose-cli-'));
    const file = join(dir, 'strings.sysml');
    writeFileSync(file, 'package P { part v { attribute id = "R-UAV-001 [rev A]"; } }\n');
    try {
      const r = run([file, '--strict']);
      expect(r.stdout).not.toContain('unknown-unit');
      expect(r.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it('--no-library resolves a forward `:>` and an in-file import', () => {
    // `--no-library` used to be a second-class mode: only the LIBRARY binder
    // re-resolved anything, so a forward reference and an `import Lib::*;`
    // both failed on a file that needs no library at all. The parse binds
    // them itself now, so this checks clean AND stays clean under --strict.
    const dir = mkdtempSync(join(tmpdir(), 'sysprose-cli-'));
    const file = join(dir, 'nolib.sysml');
    writeFileSync(
      file,
      `package Lib { part def Widget; }
package Use {
    import Lib::*;
    part def W2 :> Widget;
    part def Car :> Vehicle;
    part def Vehicle;
}
`,
    );
    try {
      const r = run([file, '--no-library', '--strict']);
      expect(r.stdout).not.toContain('unresolved');
      expect(r.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it('rejects an unknown option rather than ignoring it', () => {
    const r = run([`${FIX}/L0-empty-file/fixed.sysml`, '--wat']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown option');
  }, 60_000);

  it('prints help and exits 0', () => {
    const r = run(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Usage');
  }, 60_000);
});
