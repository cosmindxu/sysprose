/**
 * Level L7 — the `sysprose` reporting command.
 *
 * Sibling of `cli.test.ts`, which pins the checker's contract. This one pins
 * the ANALYSIS command: the same exit codes (0 clean · 1 findings · 2 usage/IO),
 * the same `-`-is-stdin rule, and the `{ok, file, <named payload>}` envelope
 * every subcommand emits under `--json`.
 *
 * The numbers here are measurements of `examples/uav-isr.sysml`, not round
 * figures: the command's whole value is that the figure a reader sees in a
 * terminal is the figure the analysis functions computed, so a change that
 * silently re-routes a subcommand to a different (or unfiltered) function has
 * to fail here. `requirements` reporting 2/2 rather than 2/26 and
 * `connectivity` reporting 14 connected ports rather than 0 are exactly the
 * two defects the reporting fixes removed — pinned again at the surface a
 * person actually uses.
 *
 * Three of the cases here pin things a report is worth nothing without, and
 * each replaced a run that looked clean: a payload larger than the pipe buffer
 * arriving WHOLE (ending with `process.exit` truncated `--json` at ~64 KiB and
 * still exited 0); a file the loader does not recognise saying so on stderr,
 * with `-` as the control that must not (the assertion was previously vacuous —
 * nothing ever printed a warning); and a file that failed to parse exiting 1
 * with its diagnostics rather than 2 as "no elements".
 *
 * Each spawn pays ~3.4 s of tsx startup plus the library bind, so the timeouts
 * are generous and the cases are chosen, not exhaustive.
 *
 * ── TWO WAYS TO INVOKE, AND WHICH ONE A CASE GETS ──────────────────────────
 *
 * This file used to spawn `npx tsx scripts/sysprose.ts` 240 times —
 * measured by logging the spawns, not by counting the `run([` call sites, two
 * of which sit inside loops — which was 787 s of a 790 s test gate: every other
 * file in the suite ran in parallel underneath this one, so the gate's wall
 * clock WAS this file. What was being paid 240 times, and is worth
 * paying a few dozen times, is process startup. 82 are left.
 *
 * So each invocation is asked what it is actually proving:
 *
 *  · `spawnCli(…)` — the PROGRAM. Everything only a process can be wrong
 *    about: the exit STATUS the shell sees, `-` on stdin, a payload larger than
 *    a pipe buffer, an unknown flag or subcommand, a file that cannot be read
 *    or written, every `--help`, the entry guard that decides whether the
 *    module runs at all (through a symlinked path, where it once decided
 *    wrongly and printed nothing), the two solver-bearing renderings the bridge
 *    below cannot compare, the one run that hands z3 an unbounded NONLINEAR
 *    optimisation (see that case for what it did to a shared context), and one
 *    full end-to-end run for each of the seven exit contracts in
 *    `scripts/lib/sysprose-spec.ts` (`report`, `verify`, `refine`, `bounds`,
 *    `write`, `behaviour`, `fault-tree`).
 *  · `run(…)` — the same `main`, called here, streams captured. Everything a
 *    case asserts about the TEXT the command prints and the code it comes back
 *    with, which is the code the program exits with because it is the number
 *    `runMain` assigns to `process.exitCode`.
 *
 * Nothing was deleted to make that split: every sentence asserted before is
 * asserted still, from the same models, with the same figures. The one thing
 * the split could quietly lose is the equality it assumes — that calling the
 * function and running the program do the same thing — so that equality is
 * itself a case: `the same argv, called and spawned, prints the same bytes`
 * near the end of this file walks a sample spanning ALL 22 subcommands and
 * requires byte-identical stdout, stderr and code from both — with two
 * exceptions it states and justifies rather than hides (a `--json` payload of
 * per-load UUIDs, and a report whose text is a point z3 chose). If those ever
 * diverge, the in-process cases are measuring something the binary does not do,
 * and that case is what says so.
 */
import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import { spawnSync } from 'node:child_process';
import { COMMANDS } from '../../scripts/lib/sysprose-spec';
// The command itself, for the cases that assert what it PRINTS. Importing it
// runs nothing: `scripts/sysprose.ts` calls `runMain` only when it was run as a
// script (`scripts/lib/is-main.ts`, shared with `gen-cli-reference.ts`). That
// guard is asserted here too — see the symlink case — because getting it wrong
// does not fail loudly, it runs nothing and exits 0.
import { main as sysproseMain } from '../../scripts/sysprose';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
// The shipped package is imported rather than retyped: the whole point of the
// inventory is that it resolves the text this tool ships, and a hand-copied
// package in a test resolves whatever the copy says.
import { SYSPROSE_VERIFICATION_LIBRARY } from '@semantics/index';

const CLI = resolve(process.cwd(), 'scripts/sysprose.ts');
/** The checker, spawned by the one case that has to prove it says nothing. */
const CHECK_CLI = resolve(process.cwd(), 'scripts/sysml-check.ts');
const UAV = resolve(process.cwd(), 'examples/uav-isr.sysml');
const FIX = resolve(process.cwd(), 'test/fixtures/agent-authoring');
/** The L8 verdict corpus, whose models this level re-uses at the command line. */
const FIXV = resolve(process.cwd(), 'test/fixtures/verification');

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the command as a PROGRAM: a real process, a real exit status.
 *
 * `spawnSync`, not `execFileSync`: the latter returns only stdout on success,
 * so every assertion about stderr on an exit-0 run silently held against the
 * empty string — which is how a warning the command never printed looked like a
 * warning it correctly suppressed.
 *
 * Every call here costs ~3.4 s — a node, a tsx transform of the whole import
 * graph, and a bind of the 38 761-element library — so it is spent only where
 * the process is what is being asserted; see the file header for the split.
 */
function spawnCli(args: string[], input?: string, env?: Record<string, string>): Run {
  const r = spawnSync('npx', ['tsx', CLI, ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    // Merged rather than replaced: the child needs PATH and HOME to run tsx at
    // all. `env` is here for ONE switch — `SYSPROSE_NO_Z3`, which forces the
    // honest-absence path on a machine that has the solver. Without it the
    // absent-engine cases below could only be written on a machine where the
    // optional dependency is missing, which is to say nowhere that runs CI.
    ...(env !== undefined ? { env: { ...process.env, ...env } } : {}),
    ...(input !== undefined ? { input } : {}),
    stdio: input !== undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
  });
  if (r.error) throw r.error;
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Collect what is written to a stream, in the chunks it is written in. */
function capture(sink: string[]): typeof process.stdout.write {
  return ((chunk: string | Uint8Array, enc?: unknown, cb?: unknown): boolean => {
    sink.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    const done = typeof enc === 'function' ? enc : cb;
    if (typeof done === 'function') (done as () => void)();
    return true;
  }) as typeof process.stdout.write;
}

/**
 * Run the command as a FUNCTION: `main` on this process, its streams captured.
 *
 * The same entry the binary calls (`scripts/sysprose.ts` exports it and runs it
 * only when it was RUN), with the same argv, so what is asserted here is what
 * the command prints — and the bridge case at the end of this file spawns and
 * calls the same argv for a sample spanning every subcommand and requires
 * byte-identical stdout and the same code, which is what keeps that sentence
 * true. ~140 ms against ~3.4 s, because node, the tsx transform and the parse
 * of the library JSON are paid once for the whole file instead of once per case.
 *
 * WHAT IT CANNOT DO, deliberately: stdin. `-` reads file descriptor 0, which in
 * this process is the test runner's, so a `-` here would read something that is
 * not the model — it is refused rather than silently answered. Every `-` case
 * spawns.
 *
 * SHARED STATE. What is shared between calls is the library JSON, parsed once
 * and read-only: every run still builds its OWN `Model` and merges the library
 * into it, so a subcommand that rewrites a model (`evidence-attach`) rewrites a
 * copy of its own, exactly as a process would. The bridge case is also the
 * check on that claim — it runs late, after every other in-process case in this
 * file, and compares against a process that starts clean.
 *
 * The exception, and it is deliberate on the other side too: the SOLVER. One
 * `Z3Context` is cached for the life of the process (`src/semantics/smt/
 * z3-bridge.ts`), so a witness or an unsat core — both of them points the
 * solver CHOSE — can move with what it solved before. Nothing here asserts such
 * a value, and the case above the bridge (`a report that carries a solver
 * choice prints the same bytes the second time in one process`) is what says so
 * out loud, so a future case that started depending on the order of this file
 * fails there rather than in a witness assertion.
 *
 * That shared context also has a MEMORY consequence, and it is the reason one
 * more case spawns. A nonlinear optimisation allocates without a bound, and one
 * that blows up in a shared context takes every solver-bearing case after it
 * with it — measured here: `bounds … --measure uav.endurance --free …` answered
 * in 200 ms against a fresh context and, in a warm one, asked for 4.2 GB, which
 * a 32-bit WASM module cannot serve; z3 aborted, its promise never settled, and
 * seven cases failed. The rule that follows is written on that case: a run
 * whose solver work is unbounded keeps its own process. Anything moved in here
 * later should be read against it.
 */
/**
 * The subcommands that can load `z3-solver`, and therefore cannot run in-process.
 *
 * z3 ships as a WASM module with process-global state, and it does not survive
 * being driven many times inside one worker: a full in-process conversion of
 * this file produced five `Aborted(Runtime error: The application has corrupted
 * its heap memory area (address zero)!)` unhandled errors over 70 solver calls,
 * and vitest's own warning for that condition is that it "might cause false
 * positive tests" — the failure mode is not a red test, it is a green one.
 *
 * The subprocess boundary was providing that isolation for free, and moving
 * these calls in-process removed it silently. So a solver-bearing subcommand
 * spawns, for the same reason `-` does: not because the assertion is about the
 * process, but because the invocation needs one. With `SYSPROSE_NO_Z3` set the
 * solver is never loaded, so those cases stay in-process and keep the speed.
 */
const SOLVER_BEARING = new Set(['verify', 'consistency', 'refine', 'bounds', 'fault-tree']);

async function run(args: string[], env?: Record<string, string>): Promise<Run> {
  if (args.includes('-')) {
    throw new Error('`-` reads this process\'s stdin — spawn it with spawnCli() instead');
  }
  if (SOLVER_BEARING.has(args[0] ?? '') && (env?.SYSPROSE_NO_Z3 ?? process.env.SYSPROSE_NO_Z3) === undefined) {
    return spawnCli(args, undefined, env);
  }
  const out: string[] = [];
  const err: string[] = [];
  const realOut = process.stdout.write;
  const realErr = process.stderr.write;
  const restore: Array<() => void> = [];
  for (const [k, v] of Object.entries(env ?? {})) {
    const before = process.env[k];
    restore.push(() => {
      if (before === undefined) delete process.env[k];
      else process.env[k] = before;
    });
    process.env[k] = v;
  }
  process.stdout.write = capture(out);
  process.stderr.write = capture(err);
  let code: number;
  try {
    code = await sysproseMain(args);
  } catch (thrown) {
    // THE PROGRAM'S OWN ENDING, reproduced rather than improved on. `runMain`
    // (scripts/lib/exit.ts) turns a rejection into `sysprose: internal error:`
    // plus the stack on stderr and exit 2, and a case that asserts what the
    // command does with a bad argument has to see what the command does — one
    // refusal reaches a reader down exactly this path today (`bounds --measure`
    // naming nothing throws `VerifyOptionError` past `main`, so its message is
    // delivered under an internal-error banner with a stack; the L7 case that
    // asserts the message and exit 2 passes either way, which is how it stayed
    // unnoticed while these cases were spawned). The one thing that is NOT the
    // same both ways is the stack's own text — file paths and line numbers
    // differ under vitest's transform — so no bridge row below takes this path.
    process.stderr.write(
      `sysprose: internal error: ${thrown instanceof Error ? thrown.stack : String(thrown)}\n`,
    );
    code = 2;
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    for (const undo of restore) undo();
  }
  return { code, stdout: out.join(''), stderr: err.join('') };
}

/** `SYSPROSE_NO_Z3=1` — the switch the §5 CI job asserts exit 2 under. */
const NO_Z3 = { SYSPROSE_NO_Z3: '1' };

/** Parse a `--json` payload and hand back its top-level key set as well. */
function payload<T>(r: Run): { keys: string[]; body: T } {
  const body = JSON.parse(r.stdout) as T;
  return { keys: Object.keys(body as object).sort(), body };
}

describe('L7 — sysprose reporting command', () => {
  it('stats reports the model, not the bundled library', () => {
    const r = spawnCli(['stats', UAV]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('113 element(s)');
    expect(r.stdout).toContain('82 node(s)');
    // The library is visible as its own figure rather than folded into the total.
    expect(r.stdout).toMatch(/library elements\s+3\d{4}/);
  }, 90_000);

  it('--json emits {ok, file, <named payload>} and nothing else', async () => {
    const r = await run(['stats', UAV, '--json']);
    expect(r.code).toBe(0);
    const { keys, body } = payload<{
      ok: boolean;
      file: string;
      stats: { totalElements: number; nodeCount: number; maxDepth: number; libraryElements: number };
    }>(r);
    expect(keys).toEqual(['file', 'ok', 'stats']);
    expect(body.ok).toBe(true);
    expect(body.file).toContain('uav-isr.sysml');
    expect(body.stats.totalElements).toBe(113);
    expect(body.stats.nodeCount).toBe(82);
    expect(body.stats.maxDepth).toBe(4);
    expect(body.stats.libraryElements).toBeGreaterThan(30_000);
  }, 90_000);

  it('requirements reports 2 of 2 covered, not 2 of 26', async () => {
    // The defect this command was blocked on: counting the bundled library's
    // requirements called a fully-covered model 7.7% covered.
    const r = await run(['requirements', UAV, '--json']);
    expect(r.code).toBe(0);
    const { keys, body } = payload<{
      requirements: {
        total: number;
        satisfied: number;
        coverage: number;
        libraryExcluded: number;
        nonNormativeExcluded: number;
        rows: Array<{ name: string; satisfied: boolean; satisfiedBy: string[] }>;
      };
    }>(r);
    expect(keys).toEqual(['file', 'ok', 'requirements']);
    expect(body.requirements.total).toBe(2);
    expect(body.requirements.satisfied).toBe(2);
    expect(body.requirements.coverage).toBe(1);
    expect(body.requirements.libraryExcluded).toBe(24);
    expect(body.requirements.rows.map((x) => x.name)).toEqual([
      'EnduranceRequirement',
      'MassRequirement',
    ]);
    expect(body.requirements.rows.every((x) => x.satisfied)).toBe(true);
    expect(body.requirements.rows[0].satisfiedBy).toContain('uav');

    const human = await run(['requirements', UAV]);
    expect(human.stdout).toContain('2 of 2');
    expect(human.stdout).toContain('EnduranceRequirement');
    // The shipped example tags nothing, so the divisor is untouched and the
    // report says nothing about statement kinds — the transcript in the guide
    // is this output.
    expect(body.requirements.nonNormativeExcluded).toBe(0);
    expect(human.stdout).not.toContain('prose or prompt');
  }, 120_000);

  /** A model with one of each kind, written in requirement shape. */
  const KINDS_MODEL = `package K {
    part def Vehicle;
    part v : Vehicle;
    requirement <R1> maxMass {
        subject s : Vehicle;
    }
    #prose requirement <N1> note {
        doc /* Mass is measured dry. */
    }
    #prompt requirement <G1> guidance {
        doc /* Ask for the weighing report before you close this. */
    }
    satisfy maxMass by v;
    satisfy note by v;
}
`;

  /**
   * A non-normative statement leaves the ratio, SAYS SO, and is still listed.
   *
   * Dropping it from the ratio silently would hand the reader a fraction the
   * rows in front of them do not add up to — the same failure the bundled
   * library caused, at a smaller scale and harder to spot. Dropping it from the
   * LIST is the mirror of that: the reader would see a `prose or prompt` count
   * and have no way to find out which statement it was about.
   */
  it('lists every kind by default, labels the ones the ratio leaves out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sysprose-kind-'));
    try {
      const file = join(dir, 'kinds.sysml');
      writeFileSync(file, KINDS_MODEL);
      const r = await run(['requirements', file, '--json']);
      expect(r.code).toBe(0);
      const { body } = payload<{
        requirements: {
          total: number;
          nonNormativeExcluded: number;
          kind: string | null;
          rows: Array<{
            name: string;
            kind: string;
            satisfied: boolean | null;
            satisfiedBy: string[];
          }>;
        };
      }>(r);
      // The ratio still counts the one normative statement, and says so.
      expect(body.requirements.total).toBe(1);
      expect(body.requirements.nonNormativeExcluded).toBe(2);
      expect(body.requirements.kind).toBeNull();
      // The listing is every requirement-shaped statement, each carrying its kind.
      expect(body.requirements.rows.map((x) => [x.name, x.kind])).toEqual([
        ['maxMass', 'requirement'],
        ['note', 'prose'],
        ['guidance', 'prompt'],
      ]);
      // `satisfied` is null, not false, on a statement nothing is supposed to
      // satisfy: reported as false it reads as an uncovered requirement.
      expect(body.requirements.rows.map((x) => x.satisfied)).toEqual([true, null, null]);
      // Withholding the VERDICT on a non-normative row must not delete its
      // EDGES: the model really does say `satisfy note by v`, and a row that
      // reported no satisfier would be contradicting the file it is reporting
      // on — on one column, while its neighbours named the same element.
      expect(body.requirements.rows.map((x) => x.satisfiedBy)).toEqual([['v'], ['v'], []]);

      const human = await run(['requirements', file]);
      expect(human.stdout).toContain('1 of 1');
      expect(human.stdout).toContain('2 statement(s) tagged prose or prompt');
      expect(human.stdout).toMatch(/note.*prose/);
      expect(human.stdout).toMatch(/guidance.*prompt/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  /**
   * `--kind` narrows the listing without moving the ratio.
   *
   * Coverage is a fact about the model, not about what the reader asked to see,
   * so it is the same headline under every filter — and the report says how
   * many of how many statements are in front of them, so a filtered list cannot
   * be mistaken for the whole one.
   */
  it('requirements --kind shows one kind, and refuses a kind that is not one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sysprose-kind-'));
    try {
      const file = join(dir, 'kinds.sysml');
      writeFileSync(file, KINDS_MODEL);

      const prompt = await run(['requirements', file, '--kind', 'prompt', '--json']);
      expect(prompt.code).toBe(0);
      const { body } = payload<{
        requirements: {
          total: number;
          satisfied: number;
          kind: string | null;
          rows: Array<{ name: string; kind: string }>;
        };
      }>(prompt);
      expect(body.requirements.kind).toBe('prompt');
      expect(body.requirements.rows.map((x) => x.name)).toEqual(['guidance']);
      // The ratio is about the model, so the filter does not move it.
      expect(body.requirements.total).toBe(1);
      expect(body.requirements.satisfied).toBe(1);

      const req = await run(['requirements', file, '--kind=requirement', '--json']);
      const only = payload<{ requirements: { rows: Array<{ name: string }> } }>(req);
      expect(only.body.requirements.rows.map((x) => x.name)).toEqual(['maxMass']);

      const human = await run(['requirements', file, '--kind', 'prose']);
      expect(human.code).toBe(0);
      expect(human.stdout).toContain('showing 1 of 3 statement(s)');
      expect(human.stdout).toContain('note');
      expect(human.stdout).not.toContain('maxMass');
      // A listing of one kind must not be read as a listing of the model: a
      // `#prompt` on a part or a package is guidance this command never sees.
      expect(human.stdout).toContain('prompts --element');

      // An unknown kind is refused, not defaulted.
      const bad = await run(['requirements', file, '--kind', 'notes']);
      expect(bad.code).toBe(2);
      expect(bad.stderr).toContain('unknown --kind');
      expect(bad.stderr).toContain('requirement, prose, prompt');

      // And refused BEFORE the file is read, which is the whole reason the
      // check is wired into `precheckArgs` and not left to the report. Only an
      // unreadable path can show the order: against a file that exists, a
      // post-load check would satisfy the case above just as well.
      const early = await run(['requirements', join(dir, 'nope.sysml'), '--kind', 'notes']);
      expect(early.code).toBe(2);
      expect(early.stderr).toContain('unknown --kind');
      expect(early.stderr).not.toContain('cannot read');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  /**
   * `prompts` answers the question a filtered requirements listing cannot.
   *
   * Guidance is worth writing once, on the definition or the package, and the
   * point of the command is that an agent handed the USAGE still finds it. So
   * the case is deliberately the indirect one: the prompt is written inside a
   * definition and asked for from a part typed by it.
   */
  it('prompts finds the guidance written on what an element is', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sysprose-prompt-'));
    try {
      const file = join(dir, 'guidance.sysml');
      writeFileSync(
        file,
        `package G {
    part def Engine {
        #prompt part guidance {
            doc /* Check the fuel line before you change this port. */
        }
    }
    part e : Engine;
    part def Wheel;
    part w : Wheel;
}
`,
      );

      const r = await run(['prompts', file, '--element', 'e', '--json']);
      expect(r.code).toBe(0);
      const { keys, body } = payload<{
        prompts: {
          element: { qualifiedName: string };
          prompts: Array<{
            prompt: { declaredName?: string };
            text: string;
            via: string;
            distance: number;
            attachedTo: { declaredName?: string };
          }>;
        };
      }>(r);
      expect(keys).toEqual(['file', 'ok', 'prompts']);
      expect(body.prompts.element.qualifiedName).toBe('G::e');
      expect(body.prompts.prompts).toHaveLength(1);
      const [applied] = body.prompts.prompts;
      expect(applied.prompt.declaredName).toBe('guidance');
      expect(applied.text).toBe('Check the fuel line before you change this port.');
      // Reached through the TYPE, one hop out — not written on `e` at all.
      expect(applied.via).toBe('type');
      expect(applied.distance).toBe(1);
      expect(applied.attachedTo.declaredName).toBe('Engine');

      const human = await run(['prompts', file, '--element', 'e']);
      expect(human.code).toBe(0);
      expect(human.stdout).toContain('1 prompt(s) apply');
      expect(human.stdout).toContain('Check the fuel line');
      expect(human.stdout).toContain('Engine');

      // An element nothing was written about says so, rather than reporting a
      // prompt from somewhere else in the model.
      const none = await run(['prompts', file, '--element', 'w']);
      expect(none.code).toBe(0);
      expect(none.stdout).toContain('0 prompt(s)');
      expect(none.stdout).not.toContain('fuel line');

      // The element is the question; without it there is nothing to answer.
      const bare = await run(['prompts', file]);
      expect(bare.code).toBe(2);
      expect(bare.stderr).toContain('needs --element');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it('connectivity reports 15 ports, 9 connections and 14 connected', async () => {
    // 0 connected (a filter with no lift) and 37 ports (no filter at all) are
    // the two wrong answers this figure has had.
    const r = await run(['connectivity', UAV, '--json']);
    expect(r.code).toBe(0);
    const { keys, body } = payload<{
      connectivity: {
        portCount: number;
        connectionCount: number;
        connectedPortCount: number;
        unconnectedPorts: Array<{ qualifiedName: string }>;
        implicitResolved: number;
      };
    }>(r);
    expect(keys).toEqual(['connectivity', 'file', 'ok']);
    expect(body.connectivity.portCount).toBe(15);
    expect(body.connectivity.connectionCount).toBe(9);
    expect(body.connectivity.connectedPortCount).toBe(14);
    expect(body.connectivity.implicitResolved).toBe(18);
    expect(body.connectivity.unconnectedPorts.map((p) => p.qualifiedName)).toEqual([
      'UAVSurveillanceSystem::DataLink::antenna',
    ]);

    const human = await run(['connectivity', UAV]);
    expect(human.stdout).toContain('15 port(s)');
    expect(human.stdout).toContain('14 connected');
    expect(human.stdout).toContain('antenna');
    // The UAV example writes its connections inside the part DEFINITION, so
    // its two halves agreed even while the report's key was wrong. This is the
    // control for the case below, and the reason the defect shipped.
    expect(human.stdout).toContain('AirVehicle::radio :: antenna');
  }, 120_000);

  it('never reassures and contradicts itself in the same connectivity report', async () => {
    // `examples/vehicle.sysml` writes its ports on the `part def`s and its
    // connections inside `part vehicle : Vehicle`. This report used to print
    // "every declared port is wired" and then list three of those same ports
    // as dangling — one of the two halves wrong, and no way for a reader to
    // tell which.
    const wired = await run(['connectivity', resolve(process.cwd(), 'examples/vehicle.sysml')]);
    expect(wired.code).toBe(0);
    expect(wired.stdout).toContain('every declared port is wired');
    expect(wired.stdout).not.toContain('unconnected port usages');

    // And the shape the per-usage list exists for is untouched: one definition
    // used twice, one end of each usage wired. Both DECLARED ports are wired
    // somewhere, so the declaration-level list is empty — and the headline says
    // so at the granularity it is true at, rather than reassuring the reader
    // above a list that disagrees with it.
    const dir = mkdtempSync(join(tmpdir(), 'sysprose-conn-'));
    try {
      const file = join(dir, 'reuse.sysml');
      writeFileSync(
        file,
        `package Reuse {
    port def PP;
    part def Node { in port a : PP; out port b : PP; }
    part n1 : Node;
    part n2 : Node;
    connection link connect n1.b to n2.a;
}
`,
      );
      const r = await run(['connectivity', file]);
      expect(r.code).toBe(0);
      // Two dangling ends of two DIFFERENT declared ports, and the line says
      // that. "2 usage(s) of one" would be a fresh false claim in the line
      // added to stop one.
      expect(r.stdout).toContain('each declared port is wired in some usage; 2 end(s) across 2 port(s) are not');
      expect(r.stdout).toContain('Reuse::n1 :: a');
      expect(r.stdout).toContain('Reuse::n2 :: b');
      // Not merely "not on its own line": the forbidden reassurance is not a
      // SUBSTRING of this transcript, so a grep over a saved log cannot find it
      // sitting above a list of dangling ends either.
      expect(r.stdout).not.toContain('every declared port is wired');
      // Nor does the headline say `0 unconnected` above that same list.
      expect(r.stdout).toContain('0 unconnected declaration(s), 2 unconnected end(s)');

      // A connector end that reaches a definition's own port from OUTSIDE the
      // definition says nothing about which usage was meant, so it wires no
      // occurrence — and the report states the disagreement between its two
      // readings instead of reporting every usage of `A` as wired.
      const outside = join(dir, 'outside.sysml');
      writeFileSync(
        outside,
        `package L {
    port def PP;
    part def A { out port p : PP; }
    part def B { in port q : PP; }
    part a1 : A;
    part a2 : A;
    part b1 : B;
    connection c connect A::p to B::q;
}
`,
      );
      const o = await run(['connectivity', outside]);
      expect(o.code).toBe(0);
      expect(o.stdout).toContain('L::a1 :: p');
      expect(o.stdout).toContain('L::a2 :: p');
      expect(o.stdout).toContain('L::b1 :: q');
      expect(o.stdout).toContain(
        'cannot reconcile the two lists for 2 port(s) — wired per declaration, dangling in every usage',
      );

      // And where the walk is coarser than an instance path it says so, even —
      // especially — when nothing dangled: `Rig` is used twice, its nested
      // parts occur once in this walk, and wiring `v1`'s ends leaves `v2`'s
      // with no row to appear on. An empty list here must not read as "nothing
      // is unwired".
      const nested = join(dir, 'nested.sysml');
      writeFileSync(
        nested,
        `package P {
    port def PP;
    part def Engine { out port p : PP; }
    part def Sink { in port q : PP; }
    part def Rig { part e : Engine; part s : Sink; }
    part v1 : Rig { connect e.p to s.q; }
    part v2 : Rig;
}
`,
      );
      const n = await run(['connectivity', nested]);
      expect(n.code).toBe(0);
      expect(n.stdout).not.toContain('unconnected port usages');
      expect(n.stdout).toContain('2 occurrence(s) answered per declaration, not per instance');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);

  it('elements lists the reader\'s model, not the tool\'s re-derived copies', async () => {
    const r = await run(['elements', UAV, '--json']);
    expect(r.code).toBe(0);
    const { keys, body } = payload<{ elements: Array<{ id: string; qualifiedName: string; metaclass: string }> }>(r);
    expect(keys).toEqual(['elements', 'file', 'ok']);
    // 80, not 94: the extra 14 are the usage-scoped connector endpoints the
    // feature-chain resolver materialises, which no one wrote and no one can
    // edit. Listing them made this command say 29 PortUsages for a model
    // `stats` says has 15 — two subcommands disagreeing about whose model it is.
    expect(body.elements).toHaveLength(80);
    expect(body.elements.filter((e) => e.id.startsWith('impl-'))).toHaveLength(0);
    const census = body.elements.filter((e) => e.metaclass === 'PortUsage');
    expect(census).toHaveLength(15);
    expect(body.elements.map((e) => e.qualifiedName)).toContain('UAVSurveillanceSystem::AirVehicle');
    expect(body.elements.find((e) => e.qualifiedName === 'UAVSurveillanceSystem::AirVehicle')?.metaclass).toBe(
      'PartDefinition',
    );

    // The same figure the element census reports, from the subcommand that
    // computes it independently: a listing that disagrees with `stats` is the
    // defect, whichever of the two moved.
    const stats = await run(['stats', UAV, '--json']);
    const st = payload<{ stats: { byMetaclass: Record<string, number> } }>(stats);
    expect(st.body.stats.byMetaclass.PortUsage).toBe(15);

    const human = await run(['elements', UAV]);
    expect(human.stdout).toContain('80 element(s)');
    expect(human.stdout).toContain('14 re-derived element(s)');

    // `--include-library` is a REPORTING knob, distinct from `--no-library`
    // which changes the model. Written to a file rather than piped: the
    // library's rows are tens of thousands of lines.
    const dir = mkdtempSync(join(tmpdir(), 'sysprose-cli-'));
    try {
      const out = join(dir, 'elements.txt');
      // Spawned, alone in this case: it is fed on stdin and it writes a file,
      // which are two things about the PROCESS rather than about the listing.
      const w = spawnCli(['elements', '-', '--include-library', '--out', out], 'package P { part def A; }\n');
      expect(w.code).toBe(0);
      expect(w.stdout).toContain('Wrote');
      const written = readFileSync(out, 'utf8');
      expect(written.split('\n').length).toBeGreaterThan(1000);
      expect(written).toContain('ISQ');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it('a report larger than the pipe buffer arrives whole, and parses', () => {
    // `execFileSync` gives the child a PIPE for stdout, which is what an agent
    // harness, `| jq` and `$(…)` all give it. A write past the pipe buffer is
    // asynchronous, so ending the run with `process.exit` used to cut the
    // report at ~64 KiB AND still exit 0: unparseable JSON reported as a clean
    // answer. `--include-library` is the documented way to ask for a payload
    // that large, so it is the one that has to survive the trip.
    const r = spawnCli(['elements', '-', '--include-library', '--json'], 'package P { part def A; }\n');
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(1_000_000);
    const body = JSON.parse(r.stdout) as { ok: boolean; elements: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.elements.length).toBeGreaterThan(20_000);
  }, 180_000);

  it('trace names its axes and lists the links it found', async () => {
    const r = await run(['trace', UAV, '--json']);
    expect(r.code).toBe(0);
    const { keys, body } = payload<{
      trace: {
        relation: string;
        relationshipKinds: string[];
        rows: Array<{ declaredName?: string }>;
        columns: Array<{ declaredName?: string }>;
        links: Array<{ from: string; to: string }>;
        unlinkedColumns: string[];
        libraryExcluded: number;
        implicitExcluded: number;
      };
    }>(r);
    expect(keys).toEqual(['file', 'ok', 'trace']);
    expect(body.trace.relation).toBe('satisfy');
    expect(body.trace.relationshipKinds).toContain('Satisfy');
    // Counted ONCE over the union of the axis metaclasses, matching the single
    // matrix `test/integration/uav-example.test.ts` pins. `satisfy` runs two
    // relationship kinds over one axis pair, so summing per matrix would report
    // 40 library candidates in a model that has 20.
    expect(body.trace.libraryExcluded).toBe(20);
    expect(body.trace.implicitExcluded).toBe(0);
    expect(body.trace.rows).toHaveLength(7);
    expect(body.trace.columns.map((c) => c.declaredName)).toEqual([
      'EnduranceRequirement',
      'MassRequirement',
    ]);
    expect(body.trace.links).toHaveLength(2);
    expect(body.trace.unlinkedColumns).toEqual([]);

    const human = await run(['trace', UAV]);
    expect(human.stdout).toContain('2 link(s)');
    // The axes are printed, because a matrix whose rows are a guess is unreadable.
    expect(human.stdout).toContain('PartUsage');
    expect(human.stdout).toContain('RequirementDefinition');
    expect(human.stdout).toContain('uav');
  }, 120_000);

  it('every walk-based report prints the typings it cannot follow', async () => {
    // The user-visible half of the omission counter, which nothing pinned: all
    // three figures could be hard-coded to 0 and the suite stayed green. They
    // are the whole point of the counter — a reader who sees "nothing
    // references it" beside a silent 0 has no way to tell an untyped feature
    // from a report that cannot see the type.
    //
    // The figures are measurements of `examples/uav-isr.sysml`: 13 attributes
    // are typed by an ISQ quantity kind, which the library binder deliberately
    // leaves without a `FeatureTyping`; three of them name `ISQ::MassValue`.
    const matrix = await run([
      'trace', UAV, '--relation', 'satisfy',
      '--from', 'AttributeUsage', '--to', 'AttributeUsage', '--json',
    ]);
    expect(matrix.code).toBe(0);
    const { body: mBody } = payload<{
      trace: { rows: unknown[]; columns: unknown[]; unresolvedTypings: number };
    }>(matrix);
    // Both axes are the SAME metaclass, so every element sits on both. A figure
    // that summed the axes reported 26 in a matrix with 16 rows — larger than
    // the thing the reader would check it against.
    expect(mBody.trace.rows).toHaveLength(16);
    expect(mBody.trace.unresolvedTypings).toBe(13);
    expect(mBody.trace.unresolvedTypings).toBeLessThanOrEqual(mBody.trace.rows.length);
    const matrixText = await run([
      'trace', UAV, '--relation', 'satisfy',
      '--from', 'AttributeUsage', '--to', 'AttributeUsage',
    ]);
    expect(matrixText.stdout).toContain('13 declared type(s) this walk cannot follow');

    // Asked about a TYPE, the walk finds no edge — and says how many written
    // typings name it anyway.
    const used = await run(['where-used', UAV, '--element', 'ISQBase::MassValue']);
    expect(used.code).toBe(0);
    expect(used.stdout).toContain('nothing references it');
    expect(used.stdout).toContain('3 declared type(s) this walk cannot follow');

    // And asked about one of those attributes, it counts its own.
    const prompts = await run([
      'prompts', UAV, '--element', 'UAVSurveillanceSystem::AirVehicle::mtow',
    ]);
    expect(prompts.code).toBe(0);
    expect(prompts.stdout).toContain('1 declared type(s) this walk cannot follow');
  }, 180_000);

  it('every --relation preset tabulates its own family', () => {
    // Five of the six presets have no relationship anywhere in the repo's
    // models, so a preset string that stopped matching the mapper's `eClass`
    // would ship as a silent empty matrix — the one outcome the axis
    // derivation exists to prevent. This fixture declares all six.
    const model = [
      'package V {',
      '    requirement def R1 { doc /* one */ }',
      '    requirement def R2 { doc /* two */ }',
      '    part def Box;',
      '    part b : Box;',
      '    part c : Box;',
      '    verify R1 by b;',
      '    refine R1 by c;',
      '    trace R1 to R2;',
      '    derive R2 from R1;',
      '    satisfy R1 by b;',
      '    allocate b to c;',
      '}',
      '',
    ].join('\n');

    // `libraryExcluded` differs per preset because the AXES differ, and it is
    // a union rather than a sum: `allocate` runs two relationship kinds over a
    // parts x parts axis, so a per-matrix sum would say 22 rather than 11, and
    // `derive` would say 18 rather than 9.
    const expected = [
      { rel: 'satisfy', kinds: ['Satisfy', 'SatisfyRequirementUsage'], from: 'PartUsage', to: 'RequirementDefinition', link: 'V::b->V::R1', lib: 20 },
      { rel: 'verify', kinds: ['Verify'], from: 'PartUsage', to: 'RequirementDefinition', link: 'V::b->V::R1', lib: 20 },
      { rel: 'refine', kinds: ['Refine'], from: 'PartUsage', to: 'RequirementDefinition', link: 'V::c->V::R1', lib: 20 },
      { rel: 'derive', kinds: ['Derive'], from: 'RequirementDefinition', to: 'RequirementDefinition', link: 'V::R1->V::R2', lib: 9 },
      { rel: 'trace', kinds: ['Trace'], from: 'RequirementDefinition', to: 'RequirementDefinition', link: 'V::R2->V::R1', lib: 9 },
      { rel: 'allocate', kinds: ['Allocation', 'AllocationUsage'], from: 'PartUsage', to: 'PartUsage', link: 'V::b->V::c', lib: 11 },
    ];

    for (const e of expected) {
      const r = spawnCli(['trace', '-', '--relation', e.rel, '--json'], model);
      expect(r.code, `${e.rel} must report`).toBe(0);
      const { body } = payload<{
        trace: {
          relationshipKinds: string[];
          fromKinds: string[];
          toKinds: string[];
          links: Array<{ fromName: string; toName: string }>;
          libraryExcluded: number;
          implicitExcluded: number;
        };
      }>(r);
      expect(body.trace.relationshipKinds, e.rel).toEqual(e.kinds);
      expect(body.trace.fromKinds, e.rel).toEqual([e.from]);
      expect(body.trace.toKinds, e.rel).toEqual([e.to]);
      expect(body.trace.links.map((l) => `${l.fromName}->${l.toName}`), e.rel).toEqual([e.link]);
      expect(body.trace.libraryExcluded, e.rel).toBe(e.lib);
      expect(body.trace.implicitExcluded, e.rel).toBe(0);
    }
  }, 300_000);

  it('an axis override naming a metaclass the model has none of exits 2', async () => {
    // The auto-derived axes refuse this shape; the manual override must too.
    // `--from PartUsages` (a plausible typo) otherwise reports 0 links over 0
    // rows and exits 0, which is indistinguishable from the honest answer.
    const r = await run(['trace', UAV, '--from', 'PartUsages']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--from names a metaclass this model has none of');
    // The refusal says what the relation DOES link, so the reader can fix it.
    expect(r.stderr).toContain('PartUsage to RequirementDefinition');

    const ok = await run(['trace', UAV, '--from', 'PartUsage', '--json']);
    expect(ok.code).toBe(0);
  }, 120_000);

  it('where-used walks as far as --depth says and stops', async () => {
    const one = await run(['where-used', UAV, '--element', 'AirVehicle', '--json']);
    expect(one.code).toBe(0);
    const { keys, body } = payload<{
      whereUsed: {
        element: { qualifiedName: string };
        depth: number;
        truncated: boolean;
        impacted: Array<{ element: { qualifiedName: string }; depth: number; via: string }>;
      };
    }>(one);
    expect(keys).toEqual(['file', 'ok', 'whereUsed']);
    expect(body.whereUsed.element.qualifiedName).toBe('UAVSurveillanceSystem::AirVehicle');
    expect(body.whereUsed.impacted).toHaveLength(3);
    expect(body.whereUsed.truncated).toBe(true);

    const two = await run(['where-used', UAV, '--element=AirVehicle', '--depth=2', '--json']);
    expect(two.code).toBe(0);
    const deep = payload<{ whereUsed: { impacted: unknown[]; truncated: boolean } }>(two);
    expect(deep.body.whereUsed.impacted).toHaveLength(5);
    expect(deep.body.whereUsed.truncated).toBe(false);

    const human = await run(['where-used', UAV, '--element', 'AirVehicle', '--depth', '2']);
    expect(human.stdout).toContain('5 element(s)');
    expect(human.stdout).toContain('EnduranceRequirement');
  }, 180_000);

  it('an ambiguous element name exits 2 and lists the candidates the reader wrote', async () => {
    // `powerIn` names 10 elements, 5 of them the tool's own usage-scoped
    // copies. Offering all 10 would ask the reader to choose between ids that
    // are not in their file.
    const r = await run(['where-used', UAV, '--element', 'powerIn']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('ambiguous');
    expect(r.stderr).toContain('UAVSurveillanceSystem::FlightController::powerIn');
    const candidates = r.stderr.split('\n').filter((l) => l.includes('::powerIn'));
    expect(candidates).toHaveLength(5);
  }, 90_000);

  it('an element name that matches nothing exits 2', async () => {
    const r = await run(['where-used', UAV, '--element', 'NoSuchThing']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('no element');
  }, 90_000);

  it('orphans reports the two definitions the example never uses', async () => {
    const r = await run(['orphans', UAV, '--json']);
    expect(r.code).toBe(0);
    const { keys, body } = payload<{
      orphans: {
        orphans: Array<{ declaredName?: string }>;
        definitionsExamined: number;
        packagesSkipped: number;
      };
    }>(r);
    expect(keys).toEqual(['file', 'ok', 'orphans']);
    expect(body.orphans.orphans.map((o) => o.declaredName)).toEqual(['FlyMission', 'FlightModes']);
    expect(body.orphans.definitionsExamined).toBe(14);
    expect(body.orphans.packagesSkipped).toBe(1);

    const human = await run(['orphans', UAV]);
    expect(human.stdout).toContain('FlyMission');
    expect(human.stdout).toContain('2 of 14');
  }, 120_000);

  it('reads stdin with -, and does not warn about its extension', () => {
    // The negative half of this pair is only worth asserting because the
    // POSITIVE half fires: a file the loader really does not recognise reports
    // `import/wrong-extension` on stderr. Without that control the assertion
    // held for any command that never printed a warning at all, which is what
    // it used to be.
    const dir = mkdtempSync(join(tmpdir(), 'sysprose-cli-'));
    try {
      const odd = join(dir, 'model.notsysml');
      writeFileSync(odd, 'package P {\n    part def A;\n    part a : A;\n}\n');
      const named = spawnCli(['stats', odd]);
      expect(named.code).toBe(0);
      expect(named.stderr).toContain('import/wrong-extension');
      expect(named.stderr).toContain('1 warning(s)');
      // A warning is not a finding about the MODEL, so the report still stands.
      expect(named.stdout).toContain('4 element(s)');

      const piped = spawnCli(['stats', '-'], 'package P {\n    part def A;\n    part a : A;\n}\n');
      expect(piped.code).toBe(0);
      expect(piped.stderr).not.toContain('wrong-extension');
      expect(piped.stderr).toBe('');
      expect(piped.stdout).toContain('<stdin>');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('a model that does not parse exits 1 with a degraded banner and reports what parsed', () => {
    const r = spawnCli(['stats', `${FIX}/L2-extra-closing-brace/input.sysml`]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('degraded');
    // The report is still produced: what survived error recovery is usually
    // exactly what the reader wants to see.
    expect(r.stdout).toContain('2 element(s)');

    const j = spawnCli(['stats', `${FIX}/L2-extra-closing-brace/input.sysml`, '--json']);
    expect(j.code).toBe(1);
    const { keys, body } = payload<{
      ok: boolean;
      degraded: { errors: number; diagnostics: Array<{ code: string }> };
      stats: { totalElements: number };
    }>(j);
    expect(keys).toEqual(['degraded', 'file', 'ok', 'stats']);
    expect(body.ok).toBe(false);
    expect(body.degraded.errors).toBeGreaterThan(0);
    expect(body.degraded.diagnostics[0].code).toBeTruthy();
    expect(body.stats.totalElements).toBe(2);
  }, 120_000);

  it('a model with no elements exits 2 rather than reporting an empty success', () => {
    const r = spawnCli(['stats', '-'], '// nothing here\n');
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('no elements');
  }, 90_000);

  it('a file that did not parse is broken, not empty: exit 1 with the reason', () => {
    // The empty-model refusal used to be checked first, so a file that failed
    // to parse and salvaged nothing was answered `no elements … nothing to
    // report` with every diagnostic thrown away — a broken file reported as an
    // empty one, and the exit code (2, usage/IO) blaming the reader's command
    // line for the file's contents.
    const r = spawnCli(['stats', '-'], '#$%^&\n');
    expect(r.code).toBe(1);
    expect(r.stderr).not.toContain('no elements');
    expect(r.stderr).toContain('degraded');
    expect(r.stderr).toContain('parse/no-viable-alt');
    expect(r.stdout).toContain('0 element(s)');
  }, 90_000);

  it('rejects an unknown option, an unknown subcommand and a missing subcommand', () => {
    const opt = spawnCli(['stats', UAV, '--wat']);
    expect(opt.code).toBe(2);
    expect(opt.stderr).toContain('unknown option');

    const sub = spawnCli(['metrics', UAV]);
    expect(sub.code).toBe(2);
    expect(sub.stderr).toContain('unknown subcommand');

    const none = spawnCli([]);
    expect(none.code).toBe(2);
    expect(none.stderr).toContain('Usage');

    // One model per run: two files are two namespaces, and one report over
    // both would be a figure true of neither.
    const two = spawnCli(['stats', UAV, resolve(process.cwd(), 'examples/vehicle.sysml')]);
    expect(two.code).toBe(2);
    expect(two.stderr).toContain('expected one file');

    // An unknown relation is refused rather than defaulted to `satisfy`, which
    // would answer a question nobody asked.
    const rel = spawnCli(['trace', UAV, '--relation', 'nope']);
    expect(rel.code).toBe(2);
    expect(rel.stderr).toContain('unknown --relation');
  }, 180_000);

  it('rejects a flag whose value is missing, rather than reading it as NaN', () => {
    const r = spawnCli(['where-used', UAV, '--element', 'AirVehicle', '--depth']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('missing value');
  }, 90_000);

  it('rejects a reporting flag on a subcommand that cannot honour it', () => {
    // `--include-library` changes what is REPORTED, and only the element
    // listing can honour it: the analysis reports exclude the library by
    // construction and say so in their own `libraryExcluded` figure. Accepting
    // the flag and ignoring it would be the silent answer.
    const r = spawnCli(['stats', UAV, '--include-library']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown option');
    expect(r.stderr).toContain('stats');
  }, 90_000);

  it('exits 2 when the file cannot be read, and reports nothing', () => {
    const r = spawnCli(['stats', `${FIX}/does-not-exist.sysml`]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('cannot read');
  }, 90_000);

  it('prints help for the command and for one subcommand', () => {
    const top = spawnCli(['--help']);
    expect(top.code).toBe(0);
    expect(top.stdout).toContain('Usage');
    for (const name of [
      'stats',
      'elements',
      'requirements',
      'trace',
      'connectivity',
      'where-used',
      'orphans',
      'prompts',
      'contracts',
      'obligations',
      'verify',
      'consistency',
      'refine',
    ]) {
      expect(top.stdout, `${name} must be listed`).toContain(name);
    }
    // The top-level text names ONE contract and then says which subcommands do
    // not obey it. Printing `EXIT_CODES` alone over a table that holds two
    // contracts would tell a `verify` reader that exit 1 means the model did
    // not load cleanly, when it means the requirement was refuted.
    expect(top.stdout).toContain('for every subcommand that REPORTS');
    // EVERY judging subcommand, and a sentence that survives there being more
    // than two of them: a list joined with commas rendered "`verify`,
    // `consistency` judges", which is not English and is the one line telling a
    // reader that the contract above does not apply to these. `check-behaviour`
    // belongs in it — its exit 1 is a property REFUTED, and left out of this
    // list it was documented, in the one place a reader meets the contract
    // before running anything, as "the model did not load cleanly".
    // FIVE subcommands now carry a contract of their own. The sentence is built
    // from the spec table, so assert the invariant — every non-report contract is
    // named, and the verb is not "judge" (`bounds` carries a contract and judges
    // nothing) — rather than a frozen string two parallel chains both rewrote.
    for (const c of COMMANDS.filter(
      // The sentence names the JUDGING commands. `report`'s exit 1 is about the
      // load and the writing commands have no 1 at all, so neither belongs in a
      // line whose whole job is to say the contract above does not apply.
      (x) => x.exitContract !== 'report' && x.exitContract !== 'write',
    )) {
      expect(top.stdout).toContain(`\`${c.name}\``);
    }
    expect(top.stdout).toContain('each carry a contract of their own');

    const sub = spawnCli(['where-used', '--help']);
    expect(sub.code).toBe(0);
    expect(sub.stdout).toContain('--depth');
  }, 120_000);

  it('--out writes the report and says where, instead of printing it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sysprose-cli-'));
    try {
      const out = join(dir, 'nested', 'stats.json');
      const r = spawnCli(['stats', UAV, '--json', '--out', out]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(out);
      const written = JSON.parse(readFileSync(out, 'utf8')) as { stats: { totalElements: number } };
      expect(written.stats.totalElements).toBe(113);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it('a --out path that cannot be written is an I/O refusal, not an internal error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sysprose-cli-'));
    try {
      // Writing to a directory reached the top-level handler and printed
      // `internal error` with a JavaScript stack, telling the reader the tool
      // is broken when their argument is.
      const r = spawnCli(['stats', UAV, '--out', dir]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('cannot write');
      expect(r.stderr).not.toContain('internal error');
      expect(r.stderr).not.toContain('at main');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it('--help does not answer a malformed command line', () => {
    // Help used to be decided by scanning the whole argv for `-h`/`--help`,
    // which outranked the grammar the rest of the line obeys: after `--` a
    // `-h` is a positional, and `--element --help` is a missing value. Both
    // were answered with the help text and exit 0.
    const afterDoubleDash = spawnCli(['stats', UAV, '--', '-h']);
    expect(afterDoubleDash.code).toBe(2);
    expect(afterDoubleDash.stderr).toContain('expected one file');

    const asAValue = spawnCli(['where-used', UAV, '--element', '--help']);
    expect(asAValue.code).toBe(2);
    expect(asAValue.stderr).toContain('missing value for --element');
  }, 120_000);

  it('runs when its own path goes through a symlink, instead of silently doing nothing', () => {
    // THE GUARD THAT DECIDES WHETHER THE COMMAND RUNS AT ALL, at the only
    // boundary that can see it. `scripts/sysprose.ts` calls `runMain` only when
    // it was RUN — otherwise importing it here would execute the command with
    // vitest's argv — and the first way that was written compared
    // `resolve(process.argv[1])` with `resolve(fileURLToPath(import.meta.url))`.
    // The loader resolves symlinks in a module URL and argv keeps them, so an
    // invocation through a symlinked directory read as an import and the
    // process did NOTHING: no report, no diagnostic, exit 0, on a path whose
    // contract is 2. That is the outcome `scripts/lib/exit.ts` calls the one
    // that must be impossible, and no in-process case can see it, because in
    // process the guard is not consulted at all.
    const dir = mkdtempSync(join(tmpdir(), 'sysprose-link-'));
    try {
      const link = join(dir, 'repo');
      symlinkSync(process.cwd(), link);
      const linked = join(link, 'scripts', 'sysprose.ts');

      const r = spawnSync('npx', ['tsx', linked, 'stats', UAV], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      });
      expect(r.status, 'the entry guard read a symlinked path as an import').toBe(0);
      expect(r.stdout, 'the command exited 0 having printed nothing at all').toContain(
        '113 element(s)',
      );

      // And the half that a silent pass would have hidden: a refusal is still
      // a refusal down the same path.
      const missing = spawnSync('npx', ['tsx', linked, 'stats', `${FIX}/does-not-exist.sysml`], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      });
      expect(missing.status, 'a file that cannot be read exited 0 through a symlinked entry').toBe(2);
      expect(missing.stderr).toContain('cannot read');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  /* ── the verification lane: two report commands, no solver ────────────── */

  it('contracts inventories the two requirements of the shipped example', async () => {
    const r = await run(['contracts', UAV]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('2 contract(s) on 1 subject(s)');
    expect(r.stdout).toContain('2 guarantee(s) in QF_LRA, 0 in QF_NRA, 0 unsupported');
    expect(r.stdout).toContain('subject uav : AirVehicle (declared)');
    expect(r.stdout).toContain('uav.endurance >= 45.0 [min]');
    expect(r.stdout).toContain('uav.mtow <= 25.0 [kg]');
    // The line that keeps the command inside its remit. A reader who takes an
    // inventory row for a verdict is the failure this whole lane is built
    // against, so the disclaimer is part of the contract, not decoration.
    expect(r.stdout).toContain('says nothing about whether any of it holds');
    // And the words it may never print, whatever the model says.
    expect(r.stdout).not.toMatch(/\bproved\b|\bsatisfied\b|\bconsistent\b/);
  }, 90_000);

  it('contracts --json publishes under `contracts`, beside ok and file', async () => {
    const r = await run(['contracts', UAV, '--json']);
    expect(r.code).toBe(0);
    const { keys, body } = payload<{
      contracts: {
        total: number;
        subjects: number;
        guaranteesQfLra: number;
        guaranteesQfNra: number;
        guaranteesUnsupported: number;
        libraryExcluded: number;
        contracts: Array<{
          qualifiedName: string;
          subject: { name: string; typeRef: string; typeId: string; origin: string };
          guarantees: Array<{ expression: string; fragment: string; encodable: unknown }>;
          satisfiedBy: Array<{ declaredName: string }>;
        }>;
      };
    }>(r);
    expect(keys).toEqual(['contracts', 'file', 'ok']);
    expect(body.contracts.total).toBe(2);
    expect(body.contracts.subjects).toBe(1);
    expect(body.contracts.guaranteesQfLra).toBe(2);
    expect(body.contracts.guaranteesQfNra).toBe(0);
    expect(body.contracts.guaranteesUnsupported).toBe(0);
    // The library's own requirements are excluded, and the figure says so.
    expect(body.contracts.libraryExcluded).toBe(24);
    const [endurance] = body.contracts.contracts;
    expect(endurance.qualifiedName).toBe('UAVSurveillanceSystem::EnduranceRequirement');
    expect(endurance.subject).toMatchObject({
      name: 'uav',
      typeRef: 'AirVehicle',
      origin: 'declared',
    });
    // The census counts subjects by the element the type RESOLVES to, so two
    // packages that each declare a `Sys` are two subjects and not one.
    expect(typeof endurance.subject.typeId).toBe('string');
    expect(endurance.guarantees[0].fragment).toBe('qf-lra');
    expect(endurance.guarantees[0].encodable).toBe(true);
    expect(endurance.satisfiedBy.map((x) => x.declaredName)).toEqual(['uav']);
  }, 90_000);

  it('obligations reports two things to show over an axiom set of bindings', async () => {
    const r = await run(['obligations', UAV, '--json']);
    expect(r.code).toBe(0);
    const { keys, body } = payload<{
      obligations: {
        total: number;
        byRole: { axiom: number; premise: number; obligation: number };
        byStatus: Record<string, number>;
        missing: number;
        refusedByReason: Record<string, number>;
      };
    }>(r);
    expect(keys).toEqual(['file', 'obligations', 'ok']);
    // The plan's own first deliverable: the two `require` bodies over the
    // derived-endurance equation plus the literal feature bindings, with
    // nothing refused.
    expect(body.obligations.byRole.obligation).toBe(2);
    expect(body.obligations.byRole.premise).toBe(0);
    expect(body.obligations.byRole.axiom).toBe(12);
    expect(body.obligations.total).toBe(14);
    expect(body.obligations.byStatus.open).toBe(14);
    // Nothing may ever be discharged without an evidence record, and none
    // exists — the record and its digest are a later commit.
    expect(body.obligations.byStatus.discharged).toBe(0);
    expect(body.obligations.byStatus.stale).toBe(0);
    expect(body.obligations.missing).toBe(0);
    expect(body.obligations.refusedByReason).toEqual({});
  }, 90_000);

  it('obligations --missing lists only what this lane would not decide', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sysprose-cli-'));
    const file = join(dir, 'missing.sysml');
    writeFileSync(
      file,
      `package P {
    part def Sys {
        attribute d : ISQ::LengthValue = 5.0 [km];
        attribute dur : ISQ::DurationValue = 3000.0 [s];
    }
    part s : Sys;
    requirement def Wordy { doc /* it shall be good */ subject u : Sys; }
    requirement def Clashing { subject u : Sys; require constraint { u.d >= u.dur } }
}
`,
    );
    try {
      const r = await run(['obligations', file, '--missing']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('showing the 2 row(s) this lane would not decide');
      expect(r.stdout).toContain('(no constraint body)');
      expect(r.stdout).toContain('u.d >= u.dur');
      // The refused relation is LISTED with the gate that refused it, never
      // dropped: a relation missing from a worklist reads as one that holds.
      expect(r.stdout).toContain('dimension-clash');
      const json = await run(['obligations', file, '--missing', '--json']);
      const { body } = payload<{
        obligations: { missing: number; missingOnly: boolean; refusedByReason: Record<string, number> };
      }>(json);
      expect(body.obligations.missing).toBe(2);
      expect(body.obligations.missingOnly).toBe(true);
      expect(body.obligations.refusedByReason).toEqual({
        'dimension-clash': 1,
        'no-formal-clause': 1,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  /* ── property-draft / property-check (§3.3) ────────────────────────────── */

  /**
   * The two rows §3.0 promises a CLI case each, asserted on the text the
   * command prints (`run`, in this process — see the file header).
   *
   * These are the two subcommands an agent meets first — drafting comes before
   * proving — and the whole value of both is that the sentence in the terminal
   * is the sentence the gates produced. A row whose dispatch arm was never
   * written prints help and exits 0, which is indistinguishable from a command
   * that ran and found nothing to say; every assertion below is one a missing
   * arm would fail.
   */
  it('property-draft prints the skeleton, the dictionary and the fields it cannot encode', async () => {
    const r = await run(['property-draft', UAV, '--element', 'MassRequirement']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('UAVSurveillanceSystem::MassRequirement');
    expect(r.stdout).toContain('subject   uav : AirVehicle (declared)');
    // The three mandatory FRETish fields, filled in from the model.
    expect(r.stdout).toContain('component  uav');
    // …and the three that are commentary, each carrying the same marker.
    for (const field of ['scope', 'condition', 'timing']) {
      expect(r.stdout, `${field} is emitted as guidance`).toMatch(
        new RegExp(`${field}\\s+fragment: temporal`),
      );
    }
    expect(r.stdout).toContain('export-only (§3.11)');
    // The dictionary is written THROUGH the subject, and offers no bare alias.
    expect(r.stdout).toContain('uav.mtow');
    expect(r.stdout).toContain('claim literal  = 18.5');
    expect(r.stdout).not.toMatch(/^ {4}mtow /m);
    expect(r.stdout).toContain('meaning is not checked; read the back-translation.');
  }, 90_000);

  it('property-draft --json publishes under `propertyDraft`, beside ok and file', async () => {
    const r = await run([
      'property-draft',
      UAV,
      '--element',
      'UAVSurveillanceSystem::EnduranceRequirement',
      '--json',
    ]);
    expect(r.code).toBe(0);
    const { keys, body } = payload<{
      propertyDraft: {
        requirement: { qualifiedName: string };
        fields: Array<{ field: string; mandatory: boolean; encodable: boolean }>;
        dictionary: Array<{ name: string }>;
        examples: string[];
        notice: string;
      };
    }>(r);
    expect(keys).toEqual(['file', 'ok', 'propertyDraft']);
    // The REF resolved as a QUALIFIED NAME, which §3.0 says every REF flag takes.
    expect(body.propertyDraft.requirement.qualifiedName).toBe(
      'UAVSurveillanceSystem::EnduranceRequirement',
    );
    expect(body.propertyDraft.fields.map((f) => f.field)).toEqual([
      'component',
      'shall',
      'response',
      'scope',
      'condition',
      'timing',
    ]);
    expect(body.propertyDraft.fields.filter((f) => f.encodable)).toHaveLength(3);
    expect(body.propertyDraft.dictionary.some((d) => d.name === 'uav.endurance')).toBe(true);
    expect(body.propertyDraft.dictionary.some((d) => d.name === 'endurance')).toBe(false);
    expect(body.propertyDraft.examples.length).toBeGreaterThan(0);
    expect(body.propertyDraft.notice).toBe('meaning is not checked; read the back-translation.');
  }, 90_000);

  it('property-check accepts a clause and says where it goes', async () => {
    const r = await run([
      'property-check',
      UAV,
      '--element',
      'MassRequirement',
      '--clause',
      'uav.mtow <= 25.0 [kg]',
    ]);
    // The REPORT contract: a clause is a string the caller passed, not something
    // in the file, so its refusal is in the payload and never in the exit code.
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('— accepted');
    expect(r.stdout).toContain('gate 4  non-trivial on its own         passed');
    expect(r.stdout).toContain('uav shall satisfy: uav.mtow is at most 25.0 kg');
    expect(r.stdout).toContain('require constraint { uav.mtow <= 25.0 [kg] }');
    // The insertion point is INSIDE the requirement body: line 138 is its
    // closing brace in the shipped example, and the clause goes on the line
    // before it.
    expect(r.stdout).toMatch(/line 138, column 1/);
    expect(r.stdout).toContain('meaning is not checked; read the back-translation.');
  }, 90_000);

  it('property-check refuses a temporal field at gate 0, and a bare name at gate 2', async () => {
    const temporal = await run([
      'property-check',
      UAV,
      '--element',
      'EnduranceRequirement',
      '--clause',
      'scope = after; uav.endurance >= 45.0 [min]',
    ]);
    expect(temporal.code).toBe(0);
    expect(temporal.stdout).toContain('refused at gate 0');
    expect(temporal.stdout).toContain('verification/temporal-field-unencodable');
    expect(temporal.stdout).toContain('gate 1  parses                         not-run');

    const bare = await run([
      'property-check',
      UAV,
      '--element',
      'EnduranceRequirement',
      '--clause',
      'endurance >= 45 [min]',
      '--json',
    ]);
    expect(bare.code).toBe(0);
    const { body } = payload<{
      propertyCheck: { outcome: string; refusedAt: number; code: string; expected: string[] };
    }>(bare);
    expect(body.propertyCheck.outcome).toBe('refused');
    expect(body.propertyCheck.refusedAt).toBe(2);
    expect(body.propertyCheck.code).toBe('verification/unresolved-name-in-property');
    expect(body.propertyCheck.expected).toContain('uav.endurance');
  }, 120_000);

  it('property-check reports the gap rather than a pass when there is no solver', async () => {
    const r = await run(
      [
        'property-check',
        UAV,
        '--element',
        'MassRequirement',
        '--clause',
        'uav.mtow <= uav.mtow',
        '--json',
      ],
      NO_Z3,
    );
    expect(r.code).toBe(0);
    const { body } = payload<{
      propertyCheck: { outcome: string; refusedAt: number | null; code: string };
    }>(r);
    // The same clause is REFUSED as trivial when z3 is there. With no solver the
    // gate is unrun and the clause is accepted WITH A GAP — never a pass.
    expect(body.propertyCheck.outcome).toBe('accepted-with-gap');
    expect(body.propertyCheck.refusedAt).toBeNull();
    expect(body.propertyCheck.code).toBe('verification/nontriviality-unchecked');
  }, 90_000);

  it('property-draft carries the shipped authoring prompts, and both rows refuse a bad REF', async () => {
    const prompts = await run([
      'property-draft',
      resolve(process.cwd(), 'examples/contract-authoring-prompts.sysml'),
      '--element',
      'PayloadMassRequirement',
    ]);
    expect(prompts.code).toBe(0);
    expect(prompts.stdout).toContain('authoring guidance — 4 #prompt(s), verbatim');
    expect(prompts.stdout).toContain('Name the subject in every path a clause reads');

    // A REF naming something that states no contract is refused BY NAME, exit 2.
    const notARequirement = await run(['property-draft', UAV, '--element', 'AirVehicle']);
    expect(notARequirement.code).toBe(2);
    expect(notARequirement.stderr).toContain('not a requirement or a case with an objective');

    // And `--clause` is the whole of the second command: a run without it is a
    // usage error raised before the model is even read.
    const noClause = await run(['property-check', UAV, '--element', 'MassRequirement']);
    expect(noClause.code).toBe(2);
    expect(noClause.stderr).toContain('`--clause TEXT` is the clause to judge');
  }, 120_000);

  /**
   * A requirement USAGE applying a definition is the shape a real model is full
   * of, and it owns no clause. Saying "prose only, nothing to encode" about it
   * would be false — the constraint is on the definition, one line above — and
   * it would inflate `--missing`, which is the figure that measures how much of
   * a model this lane cannot reach. The prose-only row beside it is the case
   * that sentence really belongs to.
   */
  it('contracts tells a usage that inherits its clauses from a requirement with none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sysprose-cli-'));
    const file = join(dir, 'usage.sysml');
    writeFileSync(
      file,
      `package P {
    part def Sys { attribute m : Real = 3.0; }
    part s : Sys;
    requirement def MassLimit { subject u : Sys; require constraint { u.m < 9.0 } }
    requirement massOk : MassLimit;
    satisfy massOk by s;
    requirement def Wordy { doc /* it shall be good */ subject u : Sys; }
}
`,
    );
    try {
      const r = await run(['contracts', file]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('no clause of its own: the clauses are on its definition P::MassLimit');
      expect(r.stdout).toContain('no formal clause: prose only, nothing to encode');
      expect(r.stdout).toContain('1 contract(s) carry no formal clause');
      const missing = await run(['obligations', file, '--missing']);
      expect(missing.stdout).toContain('showing the 1 row(s) this lane would not decide, of 3');
      // `no-formal-clause` is not a gate refusal — nothing refused the body,
      // there is no body — so it is not printed under a heading that says one
      // did.
      expect(missing.stdout).toContain('0 relation(s) refused by a gate');
      expect(missing.stdout).toContain(
        '1 requirement(s) carry no formal clause — no gate refused them',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  /**
   * A report that narrows its listing and not its findings contradicts itself
   * inside one block: `scoped to P::Scoped` over a diagnostic about
   * `P::Elsewhere`, and an exclusion census counting statements the reader did
   * not ask about.
   */
  it('--element narrows the diagnostics and the exclusion census too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sysprose-cli-'));
    const file = join(dir, 'scope.sysml');
    writeFileSync(
      file,
      `package P {
    part def Sys { attribute m : Real = 3.0; }
    package Scoped {
        requirement def Inner { subject u : Sys; require constraint { u.m < 9.0 } }
    }
    package Elsewhere {
        #prose requirement def Prosy { subject u : Sys; require constraint { u.m > 0.0 } }
        action def Go { attribute x : Real = 1.0; assume constraint { x > 0.0 } }
    }
}
`,
    );
    try {
      const whole = await run(['contracts', file]);
      expect(whole.stdout).toContain('verification/nonstandard-clause-location');
      expect(whole.stdout).toContain('1 statement(s) tagged prose or prompt left out');

      const scoped = await run(['contracts', file, '--element', 'P::Scoped']);
      expect(scoped.code).toBe(0);
      expect(scoped.stdout).toContain('scoped to P::Scoped');
      expect(scoped.stdout).toContain('P::Scoped::Inner');
      expect(scoped.stdout).not.toContain('verification/');
      expect(scoped.stdout).toContain('0 statement(s) tagged prose or prompt left out');

      const obligations = await run(['obligations', file, '--element', 'P::Scoped']);
      expect(obligations.stdout).not.toContain('verification/');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  /**
   * `--element` resolves the way every other `REF` in this command does, and
   * six commands sharing an undefined convention is how two of them end up with
   * different ones. Three shapes are pinned: a qualified name, a declared short
   * id, and an ambiguous bare name — which exits 2 with the candidates rather
   * than reporting on the first match.
   */
  it('--element resolves a qualified name, a short id, and refuses an ambiguous one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sysprose-cli-'));
    const file = join(dir, 'refs.sysml');
    writeFileSync(
      file,
      `package P {
    part def Sys { attribute m : Real = 3.0; }
    part def Other { attribute m : Real = 4.0; }
    part s : Sys;
    requirement def <R1> First { subject u : Sys; require constraint { u.m < 9.0 } }
    requirement def <R2> Second { subject u : Sys; require constraint { u.m > 1.0 } }
}
`,
    );
    try {
      const byQualified = await run(['contracts', file, '--element', 'P::Second', '--json']);
      expect(byQualified.code).toBe(0);
      const q = payload<{ contracts: { total: number; contracts: Array<{ shortId: string }> } }>(
        byQualified,
      );
      expect(q.body.contracts.total).toBe(1);
      expect(q.body.contracts.contracts[0].shortId).toBe('R2');

      const byShortId = await run(['obligations', file, '--element', 'R1', '--json']);
      expect(byShortId.code).toBe(0);
      const sid = payload<{ obligations: { byRole: { obligation: number } } }>(byShortId);
      expect(sid.body.obligations.byRole.obligation).toBe(1);

      const ambiguous = await run(['contracts', file, '--element', 'm']);
      expect(ambiguous.code).toBe(2);
      expect(ambiguous.stderr).toContain('is ambiguous');
      expect(ambiguous.stderr).toContain('P::Sys::m');
      expect(ambiguous.stderr).toContain('P::Other::m');

      // A reference into the bundled library is refused: every figure in these
      // reports is about the reader's model and excludes the library, so
      // scoping to a library element would print an inventory of zero that
      // reads exactly like a model with none.
      const library = await run(['contracts', file, '--element', 'Requirements::RequirementCheck']);
      expect(library.code).toBe(2);
      expect(library.stderr).toContain('bundled standard-library element');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  /* ── the keyword vocabulary: an inventory, and one door with a lock ────── */

  /**
   * `contracts --keywords` is the only place the two keyword codes are ever
   * printed, and the case asserts both halves of that: the inventory says the
   * four things §3.12 lets it say, and `npm run check` over the same file says
   * none of them.
   */
  it('contracts --keywords inventories the vocabulary, and check says none of it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sysprose-kw-'));
    const file = join(dir, 'vocabulary.sysml');
    writeFileSync(
      file,
      `${SYSPROSE_VERIFICATION_LIBRARY}

package P {
    import SysproseVerification::*;
    part def Sys { attribute m : Real = 3.0; }
    #exceptional state failsafe;
    #Exception state abort;
    #precondtion action launch;
    requirement def R { subject u : Sys; require constraint { u.m < 9.0 } }
}
`,
    );
    try {
      const quiet = await run(['contracts', file]);
      expect(quiet.code).toBe(0);
      expect(quiet.stdout).not.toContain('keywords:');
      expect(quiet.stdout).not.toContain('verification/foreign-keyword');

      const r = await run(['contracts', file, '--keywords']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('keywords: 3 use(s) of 3 distinct keyword(s)');
      expect(r.stdout).toContain('nothing here changes an obligation');
      expect(r.stdout).toContain(
        'sysprose vocabulary: #exceptional on P::failsafe → SysproseVerification::ExceptionalOutcome',
      );
      expect(r.stdout).toContain(
        'third-party spelling: #Exception read as `SysproseVerification::exceptional` on P::abort — not SysML v2, not a Sysprose keyword',
      );
      expect(r.stdout).toContain(
        'names nothing: #precondtion on P::launch resolves to no metadata definition in scope',
      );
      expect(r.stdout).toContain('verification/foreign-keyword');
      expect(r.stdout).toContain('verification/keyword-names-nothing');
      // The words this row may never use about somebody else's vocabulary, or
      // about its own.
      expect(r.stdout).not.toMatch(/\bstandard vocabulary\b|\bproved\b|\bsatisfied\b/);

      // The inventory is a report, not a finding: the checker's contract, its
      // exit code and its diagnostics are untouched by any of it.
      const checked = spawnSync('npx', ['tsx', CHECK_CLI, file], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      });
      expect(checked.status).toBe(0);
      expect(checked.stdout).not.toContain('verification/');

      const json = await run(['contracts', file, '--keywords', '--json']);
      const { body } = payload<{
        contracts: {
          keywordsAsked: boolean;
          keywords: Array<{ keyword: string; origin: string }>;
        };
      }>(json);
      expect(body.contracts.keywordsAsked).toBe(true);
      expect(body.contracts.keywords.map((k) => [k.keyword, k.origin])).toEqual([
        ['exceptional', 'sysprose'],
        ['Exception', 'foreign'],
        ['precondtion', 'unresolved'],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  /**
   * The tool's own statement keywords, in a file written the way the guide
   * documents them: read from the spelling, so nothing binds them and nothing
   * has to. The inventory says whose vocabulary it is; it does not report the
   * tag it acted on as a tag that names nothing.
   */
  it('contracts --keywords calls #prose its own, in a file that declares no package', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sysprose-kw-'));
    const file = join(dir, 'statements.sysml');
    writeFileSync(
      file,
      `package P {
    part def Sys { attribute m : Real = 3.0; }
    #prose requirement def Why { subject u : Sys; doc /* narrative */ }
    requirement def R { subject u : Sys; require constraint { u.m < 9.0 } }
}
`,
    );
    try {
      const r = await run(['contracts', file, '--keywords']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('1 statement(s) tagged prose or prompt left out');
      expect(r.stdout).toContain(
        'sysprose vocabulary: #prose on P::Why — read from the spelling; declare or import SysproseStatements to bind it',
      );
      // The census line above says the tool acted on the tag. It may not also
      // report it as naming nothing.
      expect(r.stdout).not.toContain('verification/keyword-names-nothing');
      expect(r.stdout).not.toContain('names nothing: #prose');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  /**
   * The door and its lock. A foreign `#precondition` files a premise only
   * because the command line asked it to, and the row it files says so on its
   * own line — the rule §3.9 states as "never contribute a keyword-derived
   * premise or guarantee without printing the keyword on that line".
   */
  it('obligations reads a foreign clause keyword only under --from-keywords', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sysprose-kw-'));
    const file = join(dir, 'foreign.sysml');
    writeFileSync(
      file,
      `package P {
    part def Sys { attribute m : Real = 3.0; attribute cap : Real = 9.0; }
    action def Move {
        #precondition constraint before { P::Sys::m > 0.0 }
        #postcondition constraint after { P::Sys::m < P::Sys::cap }
    }
}
`,
    );
    try {
      const off = await run(['obligations', file, '--json']);
      expect(off.code).toBe(0);
      const shut = payload<{
        obligations: {
          fromKeywords: boolean;
          byRole: { premise: number; obligation: number };
          obligations: Array<{ source: string; provenance?: unknown }>;
        };
      }>(off);
      expect(shut.body.obligations.fromKeywords).toBe(false);
      expect(shut.body.obligations.byRole.premise).toBe(0);
      expect(shut.body.obligations.obligations.some((o) => o.provenance !== undefined)).toBe(false);
      expect(shut.body.obligations.obligations.filter((o) => o.source === 'keyword')).toEqual([]);

      const on = await run(['obligations', file, '--from-keywords']);
      expect(on.code).toBe(0);
      expect(on.stdout).toContain('reading third-party #precondition / #postcondition');
      expect(on.stdout).toContain('2 row(s) filed by a keyword, each naming it');
      expect(on.stdout).toContain('from #precondition — a third-party spelling read as an');
      expect(on.stdout).toContain('from #postcondition — a third-party spelling read as a');
      expect(on.stdout).toContain('verification/foreign-keyword');
      // `verification/keyword-names-nothing` belongs to the inventory ALONE. A
      // worklist reports the vocabulary it ACTED on, and a keyword naming
      // nothing acted on nothing; four documents said both codes came from both
      // commands, and only the code was right.
      expect(on.stdout).not.toContain('verification/keyword-names-nothing');
      // Still a worklist and still no verdict: the flag buys a role, not a
      // claim about whether anything holds.
      expect(on.stdout).toContain('what is stored, never what is true');
      expect(on.stdout).not.toMatch(/\bproved\b|\bsatisfied\b|\bconsistent\b/);

      const onJson = await run(['obligations', file, '--from-keywords', '--json']);
      const opened = payload<{
        obligations: {
          fromKeywords: boolean;
          byRole: { premise: number; obligation: number };
          obligations: Array<{ source: string; provenance?: { keyword: string; note: string } }>;
        };
      }>(onJson);
      expect(opened.body.obligations.fromKeywords).toBe(true);
      expect(opened.body.obligations.byRole.premise).toBe(1);
      expect(
        opened.body.obligations.obligations
          .filter((o) => o.source === 'keyword')
          .map((o) => o.provenance?.keyword),
      ).toEqual(['precondition', 'postcondition']);

      // `--missing` narrows the LISTING; every figure on the header is over the
      // whole worklist, and the keyword count is one of them. Written on a
      // second file whose keyword row IS encodable, so `--missing` really does
      // drop it from the listing: counting the figure off that listing printed
      // "0 row(s) filed by a keyword" three lines above a diagnostic naming the
      // keyword that filed one, in a header whose own histogram counted it.
      const encodable = join(dir, 'encodable.sysml');
      writeFileSync(
        encodable,
        `package P {
    part def Sys {
        attribute m : Real = 3.0;
        #precondition constraint before { m > 0.0 }
    }
    requirement def R { subject u : Sys; doc /* no formal clause */ }
}
`,
      );
      const narrowed = await run(['obligations', encodable, '--missing', '--from-keywords']);
      expect(narrowed.code).toBe(0);
      expect(narrowed.stdout).toContain('showing the 1 row(s) this lane would not decide, of 3');
      expect(narrowed.stdout).toContain('1 row(s) filed by a keyword, each naming it');
      expect(narrowed.stdout).toContain('verification/foreign-keyword');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  /**
   * `verify` at the surface a person and a pipeline actually use.
   *
   * The suite above (`test/campaign/verification.test.ts`, level L8) pins the
   * verdicts in process. This case pins the thing only a spawned process can
   * show: the **exit code**, which is `verify`'s whole contract and the one
   * thing an automation branches on. Three engines, one file: a point
   * evaluation, a solver, and no solver at all — the third with
   * `--allow-inconclusive` unable to move it. That third is the honest-absence
   * path, the single most likely thing in this lane to rot into a silent green,
   * and it is forced with `SYSPROSE_NO_Z3` because this machine HAS the solver.
   */
  it('verify exits 0 at the model’s values and 2 with no solver, on the same file', () => {
    const lit = spawnCli(['verify', UAV, '--engine', 'literal']);
    expect(lit.code).toBe(0);
    // The INCONCLUSIVE count leads (§2): a reader scanning one line must see
    // the undecided figure before the green one.
    expect(lit.stdout).toContain('0 inconclusive, 2 discharged, 0 refuted');
    expect(lit.stdout).toContain("holds at the model's values");
    // The claim word this engine may never print, at the surface a person
    // reads. Matched as `proved:` — the claim is rendered `${claim}: ${detail}`
    // — because the header line deliberately contains the word `proved` inside
    // the disclaimer that says this engine never reaches it.
    expect(lit.stdout).toContain('never `proved`');
    expect(lit.stdout, 'a row claimed `proved` from the literal engine').not.toMatch(/\bproved:/);

    // The solver, on the same file: the one place in this repository where
    // `proved` may be printed, and it says what it stood on.
    const smt = spawnCli(['verify', UAV, '--engine', 'auto']);
    expect(smt.code, 'the shipped example does not verify').toBe(0);
    expect(smt.stdout).toContain('0 inconclusive, 2 discharged, 0 refuted');
    expect(smt.stdout).toContain('negation-unsat under a satisfiable axiom set');
    expect(smt.stdout).toMatch(/proved: A ∧ P ∧ ¬G unsat/);
    expect(smt.stdout, 'a proof with no satisfiable-assumptions witness').toContain(
      'assumptions satisfiable',
    );

    const auto = spawnCli(['verify', UAV, '--engine', 'auto'], undefined, NO_Z3);
    expect(auto.code, 'a missing solver must never be a green build').toBe(2);
    expect(auto.stdout).toContain('verification/tool-absent');
    expect(auto.stdout, 'the reader is not told what to run instead').toContain('--engine literal');
    expect(auto.stdout, 'a row claimed `proved` with no solver').not.toMatch(/\bproved:/);

    const forgiven = spawnCli(['verify', UAV, '--engine', 'auto', '--allow-inconclusive'], undefined, NO_Z3);
    expect(forgiven.code, '--allow-inconclusive must not lower an absent solver').toBe(2);
  }, 300_000);

  /**
   * The two flags this commit adds, asserted on what the command prints.
   *
   * Both are pinned for what they DO NOT do as much as for what they do:
   * `--timeout` is refused rather than repaired when it is not a budget,
   * because a reader who asked for a bound the tool silently replaced would
   * read every `unknown` under a bound that was never in force; and
   * `--strict-vacuity` raises a vacuity to an error and moves NO exit code,
   * which is the one property a flag that sounds like it decides something has
   * to be shown not to.
   */
  it('verify --timeout is refused when it is not a budget, and --strict-vacuity is loud and inert', async () => {
    const vacuous = `${FIXV}/models/premises-unsatisfiable.sysml`;

    const plain = await run(['verify', vacuous, '--engine', 'smt']);
    expect(plain.code, 'a vacuous obligation is undecided, which is exit 2').toBe(2);
    expect(plain.stdout).toContain('verification/vacuous');
    expect(plain.stdout, 'the flag was not asked for and the tool acted as if it had been').not.toContain(
      'verification/vacuous-property',
    );

    const strict = await run(['verify', vacuous, '--engine', 'smt', '--strict-vacuity']);
    expect(strict.code, '--strict-vacuity moved the exit code').toBe(plain.code);
    expect(strict.stdout).toContain('verification/vacuous-property');
    expect(strict.stdout).toContain('changes no exit code');

    // A budget that is honoured, printed in the header so a reader can see the
    // bound every `unknown` below it would have been reached under.
    const budgeted = await run(['verify', UAV, '--engine', 'smt', '--timeout', '9000']);
    expect(budgeted.code).toBe(0);
    expect(budgeted.stdout).toContain('at 9000 ms per check');
    expect(budgeted.stdout).toContain('timeout 9000 ms');

    for (const bad of ['0', 'forever', '1e999']) {
      const r = await run(['verify', UAV, '--engine', 'smt', '--timeout', bad]);
      expect(r.code, `--timeout ${bad} was accepted`).toBe(2);
      expect(r.stderr).toContain('--timeout must be a positive number of milliseconds');
      expect(r.stderr, 'the refusal does not say why there is no "off"').toContain('no timeout');
    }
    // `-1` is refused one layer earlier and for a different reason: a leading
    // `-` is the next OPTION to the argument reader, so the flag is reported as
    // having no value at all. Pinned rather than glossed — it is still exit 2
    // and still a usage error, and a parser change that made `-1` reach the
    // budget check would be a change worth noticing here.
    const negative = await run(['verify', UAV, '--engine', 'smt', '--timeout', '-1']);
    expect(negative.code, '--timeout -1 was accepted').toBe(2);
    expect(negative.stderr).toContain('missing value for --timeout');
  }, 300_000);

  /**
   * `--free` at the command's own surface: the flag that changes what a verdict
   * MEANS, and the two ways it must refuse rather than mislead.
   */
  it('verify --free reports a design the model admits, refuses a one-sided domain, and refuses a name that means nothing', async () => {
    const oneSided = `${FIXV}/models/free-one-sided.sysml`;
    const admitted = `${FIXV}/models/free-two-sided-refutable.sysml`;

    const unbounded = await run(['verify', oneSided, '--engine', 'smt', '--free', 'uav.cruisePower']);
    expect(unbounded.code, 'an unconfined free variable must not be green').toBe(2);
    expect(unbounded.stdout).toContain('verification/free-variable-unbounded');
    expect(unbounded.stdout).toMatch(/unbounded (above|below)/);
    expect(unbounded.stdout, 'a fabricated counterexample was printed').not.toMatch(/refuted:/);

    const design = await run(['verify', admitted, '--engine', 'smt', '--free', 'uav.cruisePower']);
    expect(design.code, 'a design the model admits is never exit 1').toBe(2);
    expect(design.stdout).toContain('design admitted by the model, not a violation of it');
    expect(design.stdout).toContain('witness:');
    // The header has to name the release, or a reader takes the row for a
    // verdict at the model's own values.
    expect(design.stdout).toContain('with uav.cruisePower released');

    const misspelt = await run(['verify', admitted, '--engine', 'smt', '--free', 'uav.cruisePowr']);
    expect(misspelt.code, 'a --free that named nothing still printed a verdict').toBe(2);
    expect(misspelt.stderr).toContain('--free names nothing in this model');
    // AND IT READS AS A USAGE ERROR, not as a crash. It reached the terminal as
    // `sysprose: internal error:` over four stack frames — which tells a person
    // the tool is broken when their argument is what named nothing. Same defect
    // class as `--out` naming a directory, which this file already pins.
    expect(misspelt.stderr, 'a usage error was reported as a tool defect').not.toContain(
      'internal error',
    );
    expect(misspelt.stderr, 'a usage error printed a stack trace').not.toMatch(/\n\s+at /);

    // A SPELLING THAT RESOLVES AND FREES NOTHING is the same defect wearing a
    // verdict. `AdmittedByDesign::uav` names the part usage: no relation reads
    // it, so the release is inert — and this run printed `proved` and exited 0
    // under a header reading "with uav released", where the intended
    // `--free uav.cruisePower` two assertions above is exit 2.
    //
    // Spelled QUALIFIED, and that is not incidental: the bare `uav` is
    // ambiguous in this model — the part usage and the requirement's own
    // `subject uav` both declare the name — so it is refused one rule earlier,
    // by the uniqueness check below. Both refusals are honest and the bare
    // spelling would test the wrong one.
    const inert = await run(['verify', admitted, '--engine', 'smt', '--free', 'AdmittedByDesign::uav']);
    expect(inert.code, 'a --free that released nothing still printed a verdict').toBe(2);
    expect(inert.stderr).toContain('which no relation in this model reads');
    expect(inert.stderr, 'the refusal does not say what could be freed instead').toContain(
      'AdmittedByDesign::AirVehicle::cruisePower',
    );
    expect(inert.stdout, 'a verdict was printed under a bound nobody released').not.toContain('proved:');
    // The bare spelling of the same name: refused too, by the other rule.
    const bare = await run(['verify', admitted, '--engine', 'smt', '--free', 'uav']);
    expect(bare.code, 'a bare --free naming two elements printed a verdict').toBe(2);
    expect(bare.stderr).toContain('names 2 elements of this model');
    expect(bare.stdout, 'a verdict was printed under a bound nobody released').not.toContain('proved:');

    // And a bare name that names TWO features is refused rather than resolved
    // to whichever the model walk reached first: `--free` is documented as
    // taking "a feature name unique in scope", and uniqueness is a promise the
    // resolver has to be able to check.
    const ambiguous = await run(['verify', `${FIXV}/models/ambiguous-name.sysml`, '--engine', 'smt', '--free', 'mass']);
    expect(ambiguous.code, 'an ambiguous --free was resolved silently').toBe(2);
    expect(ambiguous.stderr).toContain('names 2 elements of this model');
    expect(ambiguous.stderr, 'the candidates are not named').toContain('AmbiguousName::Wing::mass');
    expect(ambiguous.stderr).toContain('AmbiguousName::Fuselage::mass');
    // The control: the same model, the same feature, spelled unambiguously —
    // ACCEPTED, which is asserted on the refusal channel and on the header
    // rather than on the exit code. This run is still exit 2, because a `mass`
    // nothing confines from above is `free-variable-unbounded`; reading exit 0
    // as "accepted" would make the control pass for the wrong reason on a
    // model that happened to bound its features and fail on one that did not.
    const unique = await run([
      'verify', `${FIXV}/models/ambiguous-name.sysml`, '--engine', 'smt',
      '--free', 'AmbiguousName::Wing::mass',
    ]);
    expect(unique.stderr, 'a qualified --free was refused as ambiguous').not.toContain('--free');
    expect(unique.stdout, 'the header does not name the release it ran under').toContain(
      'with AmbiguousName::Wing::mass released',
    );
  }, 300_000);

  it('verify --json publishes a top-level verdict block, and --record writes the evidence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sysprose-cli-'));
    try {
      const out = join(dir, 'nested', 'uav.json');
      const r = await run(['verify', UAV, '--engine', 'literal', '--json', '--record', out]);
      expect(r.code).toBe(0);
      const { keys, body } = payload<{
        verdict: { discharged: number; violated: number; inconclusive: number; designAdmitted: number; exitCode: number };
        verify: { engine: string; results: Array<{ claim: string; obligationDigest: string }> };
      }>(r);
      // Top level, beside `ok` and `file`: an automation reads the verdict
      // without knowing this subcommand's payload key or report shape.
      expect(keys).toEqual(['file', 'ok', 'verdict', 'verify']);
      expect(body.verdict).toEqual({
        discharged: 2,
        violated: 0,
        inconclusive: 0,
        designAdmitted: 0,
        exitCode: 0,
      });
      expect(body.verdict.exitCode, 'the payload and the process must agree').toBe(r.code);

      // Against the schema that documents the envelope, not against a hand
      // list of keys: `docs/schemas/verify-report.schema.json` is what a
      // consumer is told to parse, and a schema nothing validates is prose.
      const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
      const validate = ajv.compile(
        JSON.parse(readFileSync(resolve(process.cwd(), 'docs/schemas/verify-report.schema.json'), 'utf8')) as object,
      );
      expect(validate(body), ajv.errorsText(validate.errors)).toBe(true);

      // AND THE SMT PAYLOAD, which is the shape that drifted. Four public
      // fields arrived with this engine — `timeoutMs`, `strictVacuity`,
      // `witness`, `tautology` — and the only case validating this schema ran
      // `--engine literal`, where all four are the empty/false defaults. The
      // schema is `additionalProperties: false` on both definitions, so a
      // field added to the report or to a row without a schema entry fails
      // here rather than reaching a consumer undocumented.
      const smt = await run(['verify', UAV, '--engine', 'smt', '--json']);
      expect(smt.code, 'the shipped example stopped proving under the solver').toBe(0);
      const smtBody = payload<{ verify: { results: Array<{ claim: string }> } }>(smt).body;
      expect(validate(smtBody), `--engine smt: ${ajv.errorsText(validate.errors)}`).toBe(true);
      expect(
        smtBody.verify.results.every((r) => r.claim === 'proved'),
        'the SMT payload validated is not the one that exercises the new fields',
      ).toBe(true);

      const records = JSON.parse(readFileSync(out, 'utf8')) as Array<{
        schema: string;
        claim: string;
        verdict: string;
        obligation: { obligationDigest: string };
        modelVersion: { graph: string };
      }>;
      expect(records).toHaveLength(2);
      for (const [i, rec] of records.entries()) {
        expect(rec.schema).toBe('sysprose-evidence/1');
        expect(rec.claim).toBe('holds-at-values');
        // The facet is written for `proved` and `refuted` alone; a point
        // evaluation never writes a pass.
        expect(rec.verdict).toBe('inconclusive');
        expect(rec.obligation.obligationDigest).toBe(body.verify.results[i].obligationDigest);
        expect(rec.modelVersion.graph).toMatch(/^sha256:[0-9a-f]{64}$/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('verify refuses a mistyped engine and --free on the engine that cannot honour it', async () => {
    const bad = await run(['verify', UAV, '--engine', 'nope']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('unknown --engine');

    // Accepted-and-ignored would print `holds-at-values` under a bound the
    // evidence record then claimed was in force.
    const freed = await run(['verify', UAV, '--engine', 'literal', '--free', 'UAV::AirVehicle::cruisePower']);
    expect(freed.code).toBe(2);
    expect(freed.stderr).toContain('--free is an SMT-engine option');
  }, 120_000);

  it('verify exits 1 on a refutation and 2 on a degraded model', async () => {
    const refuted = await run(['verify', `${FIXV}/models/refuted-at-values.sysml`, '--engine', 'literal']);
    // 1 means REFUTED here, which is the opposite of what 1 means for every
    // reporting subcommand — the reason `verify` carries its own contract.
    expect(refuted.code).toBe(1);
    expect(refuted.stdout).toContain('0 inconclusive, 0 discharged, 1 refuted');

    const dir = mkdtempSync(join(tmpdir(), 'sysprose-cli-'));
    try {
      const broken = join(dir, 'broken.sysml');
      // A file that does not parse cleanly still salvages a requirement. A
      // reporting subcommand answers 1 over it; a verdict over half a model is
      // not a verdict, so this is 2.
      writeFileSync(
        broken,
        'package P {\n    part def A { attribute m : Real = 1.0; }\n    part a : A;\n' +
          '    requirement def R { subject a : A; require constraint { a.m <= 2.0 } }\n' +
          '    part def ?? ;\n}\n',
      );
      const degraded = await run(['verify', broken, '--engine', 'literal']);
      expect(degraded.code).toBe(2);
      expect(degraded.stderr).toContain('nothing is judged over half a model');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it('verify --record refuses a model that did not load cleanly, and writes nothing', async () => {
    // §3.10 makes the refusal explicit for the write path, and this is where it
    // has teeth: a record is the DURABLE artefact — it outlives the process
    // status, which was the only honest signal — and one written here said
    // `holds-at-values` about a file the same run's stderr calls half a model,
    // with a `modelVersion.graph` taken over the SALVAGED elements, so a
    // consumer re-checking it against the same broken file would find it
    // current. Commit 7's `evidence-attach` consumes exactly these files.
    const dir = mkdtempSync(join(tmpdir(), 'sysprose-cli-'));
    try {
      const broken = join(dir, 'broken.sysml');
      writeFileSync(
        broken,
        'package P {\n    part def A { attribute m : Real = 1.0; }\n    part a : A;\n' +
          '    requirement def R { subject a : A; require constraint { a.m <= 2.0 } }\n' +
          '    part def ?? ;\n}\n',
      );
      const out = join(dir, 'rec.json');
      const r = await run(['verify', broken, '--engine', 'literal', '--record', out]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('--record refuses a model that did not load cleanly');
      expect(existsSync(out), 'a record was written over half a model').toBe(false);

      // Without --record the same file still reports, and still exits 2.
      const plain = await run(['verify', broken, '--engine', 'literal']);
      expect(plain.code).toBe(2);
      expect(plain.stderr).toContain('nothing is judged over half a model');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it('verify exits 2 over a model that states no obligation, under every engine', async () => {
    // The hole this closes: `exitCodeOf` read the rows alone, so an `auto` run
    // with no solver over a model with no requirements printed "no solver ran
    // … this run is exit 2" and exited 0. The printed sentence and the process
    // status must agree, and neither may be green.
    const dir = mkdtempSync(join(tmpdir(), 'sysprose-cli-'));
    try {
      const file = join(dir, 'empty.sysml');
      writeFileSync(
        file,
        'package NoObligations {\n    part def Widget { attribute mass : ISQ::MassValue = 1.0 [kg]; }\n' +
          '    part w : Widget;\n}\n',
      );
      // With NO SOLVER: the run says "exit 2" and must exit 2, which is where
      // the hole was. Forced with `SYSPROSE_NO_Z3` — the sentence about a
      // missing solver is only reachable when one is missing.
      const absent = await run(['verify', file, '--engine', 'auto'], NO_Z3);
      expect(absent.code, 'no solver, nothing verified, and the build went green').toBe(2);
      expect(absent.stdout).toContain('this run is exit 2');
      expect(absent.stdout).toContain('this model states no obligation at all');

      // And WITH one: a solver that ran and had nothing to decide is the same
      // answer. Exit 0 says every obligation was discharged; a model that
      // states none has been shown nothing, and that is true of every engine.
      const auto = await run(['verify', file, '--engine', 'auto']);
      expect(auto.code, 'a solver ran, decided nothing, and the build went green').toBe(2);
      expect(auto.stdout).toContain('this model states no obligation at all');

      const lit = await run(['verify', file, '--engine', 'literal']);
      expect(lit.code, 'nothing was discharged, so nothing is green').toBe(2);

      // And the payload agrees with the process, which is the one thing an
      // automation cannot recover from.
      const json = await run(['verify', file, '--engine', 'auto', '--json'], NO_Z3);
      const { body } = payload<{ verdict: { exitCode: number } }>(json);
      expect(body.verdict.exitCode).toBe(json.code);
      expect(body.verdict.exitCode).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);

  it('consistency exits 1 on a requirement set nothing can satisfy, and names the subset', () => {
    // 1 means the same KIND of thing here as it does for `verify` — a decided
    // finding about the model — and it is the reason both subcommands share the
    // third exit contract. What differs is the subject of the finding: `verify`
    // refutes one obligation, this one says no design at all could meet the set.
    //
    // SPAWNED, and the only `consistency` case that is. Its text is an unsat
    // CORE — a subset z3 chose — and a core is not canonical: measured, this
    // model's two members come back in the other order in a warm process than
    // in a fresh one, which is why the bridge case at the end of this file asks
    // its `consistency` row with the solver switched off. That exemption would
    // leave the solver-bearing rendering of this subcommand crossing no process
    // boundary anywhere in the suite, so this case keeps its process. The
    // assertions are membership rather than order, which is what lets it.
    const conflict = `${FIXV}/models/consistency-conflict.sysml`;
    const r = spawnCli(['consistency', conflict]);
    expect(r.code, 'a requirement set nothing can satisfy went green').toBe(1);
    expect(r.stdout).toContain('1 inconsistent, 0 inconclusive, 0 consistent');
    expect(r.stdout).toContain('verification/inconsistent-requirements');
    // NAMED, both ways: by the short id a reader knows the requirement by, and
    // by the qualified name of the relation itself.
    expect(r.stdout).toContain('R-UAV-002');
    expect(r.stdout).toContain('R-UAV-004');
    expect(r.stdout).toContain('ConsistencyConflict::MassCeiling::mtowCeiling');
    expect(r.stdout).toContain('ConsistencyConflict::MassFloor::mtowFloor');
    // And the word "minimal" is not available without the loop that earns it.
    expect(r.stdout).toContain('a conflicting subset');
    expect(r.stdout, 'a core was called minimal with no deletion loop').not.toContain('minimal');

    const reduced = spawnCli(['consistency', conflict, '--minimize']);
    expect(reduced.code).toBe(1);
    expect(reduced.stdout).toContain('a minimal conflicting subset');
  }, 240_000);

  it('consistency --json publishes a top-level verdict block that agrees with the process', async () => {
    const r = await run(['consistency', UAV, '--with-values', '--json']);
    expect(r.code).toBe(0);
    const { keys, body } = payload<{
      verdict: { consistent: number; inconsistent: number; inconclusive: number; exitCode: number };
      consistency: {
        withValues: boolean;
        released: string[];
        groups: Array<{ outcome: string; detail: string; witnessConfirmed: boolean }>;
      };
    }>(r);
    // The same envelope every judging subcommand publishes, so an automation
    // reads the verdict without knowing which payload key this one uses.
    expect(keys).toEqual(['consistency', 'file', 'ok', 'verdict']);
    expect(body.verdict).toEqual({
      consistent: 1,
      inconsistent: 0,
      inconclusive: 0,
      exitCode: 0,
    });
    expect(body.verdict.exitCode, 'the payload and the process must agree').toBe(r.code);
    expect(body.consistency.withValues).toBe(true);
    expect(body.consistency.released, '`--with-values` released something').toEqual([]);
    const [group] = body.consistency.groups;
    expect(group.outcome).toBe('consistent');
    expect(group.witnessConfirmed, 'a design point was printed unconfirmed').toBe(true);
    // MUST NEVER say "consistent" without the refused count and the mode.
    expect(group.detail).toMatch(/\d+ relations? refused/);
    expect(group.detail).toContain('--with-values');

    // And without the flag the file's own numbers are released, which the
    // report states rather than leaving a reader to infer.
    const released = await run(['consistency', UAV, '--json']);
    expect(released.code).toBe(0);
    const other = payload<{ consistency: { released: string[] } }>(released).body;
    expect(other.consistency.released).toContain('UAVSurveillanceSystem::AirVehicle::mtow');
  }, 240_000);

  it('consistency decides nothing with no solver, and --allow-inconclusive does not lower it', async () => {
    // The honest-absence path, forced with the switch the §5 CI job uses.
    // There is no second engine to fall back to here: whether a requirement set
    // is satisfiable is not a question the model's own values can answer.
    for (const extra of [[], ['--allow-inconclusive']]) {
      const r = await run(['consistency', UAV, ...extra], NO_Z3);
      expect(r.code, `--allow-inconclusive lowered an absent solver (${extra.join(' ') || 'no flag'})`).toBe(2);
      expect(r.stdout).toContain('verification/tool-absent');
      expect(r.stdout).toContain('no solver ran');
      // The census is still true — an absent solver must not read as an empty
      // model — and nothing was called consistent.
      expect(r.stdout).toContain('2 requirement(s) on 1 subject(s)');
      expect(r.stdout, 'a verdict was printed with no solver').not.toContain('— consistent');
    }
  }, 240_000);

  it('refine proves the power-budget decomposition and prints the γ census', async () => {
    const budget = resolve(process.cwd(), 'examples/uav-power-budget.sysml');
    const r = await run(['refine', budget, '--via', 'composition']);
    expect(r.code, 'the shipped decomposition stopped refining').toBe(0);
    expect(r.stdout).toContain('0 not refined, 0 vacuous, 0 inconclusive, 1 refined');
    // γ IS PRINTED, AND SO IS WHAT IT REFUSED. A verdict without the census is a
    // verdict a reader cannot act on: the same contracts wired with bare
    // `connect` give a different answer.
    expect(r.stdout).toContain('2 bind equalities, 1 item flow(s)');
    expect(r.stdout).toContain('1 connection(s) NOT encoded');
    expect(r.stdout).toContain('a connection is not an equality; bind the attributes');
    // Cimatti's two obligations, named as such and shown one per line.
    expect(r.stdout).toContain('obligation (3)  proved');
    expect(r.stdout).toContain('obligation (4) UAVPowerBudget::RadioDraw  proved');
    // MUST NEVER claim anything temporal, and must never claim the architecture
    // satisfies its requirements.
    expect(r.stdout).toContain('nothing here is claimed about ordering or time');
    expect(
      r.stdout,
      'a report claimed the architecture satisfies its requirements',
    ).not.toContain('satisfies its requirements');
  }, 240_000);

  it('refine --json publishes a top-level verdict block that agrees with the process', () => {
    const bare = `${FIXV}/models/refinement-bare-connection.sysml`;
    const r = spawnCli(['refine', bare, '--json']);
    expect(r.code, 'a decomposition with no encoded equality went green').toBe(1);
    const { keys, body } = payload<{
      verdict: {
        refined: number;
        notRefined: number;
        vacuous: number;
        inconclusive: number;
        exitCode: number;
      };
      refinement: {
        bindEqualities: number;
        itemFlows: number;
        connectionEqualities: number;
        notEncoded: number;
        groups: Array<{ outcome: string; obligations: Array<{ code: string | null }> }>;
      };
    }>(r);
    expect(keys).toEqual(['file', 'ok', 'refinement', 'verdict']);
    expect(body.verdict).toEqual({
      refined: 0,
      notRefined: 1,
      vacuous: 0,
      inconclusive: 0,
      exitCode: 1,
    });
    expect(body.verdict.exitCode, 'the payload and the process must agree').toBe(r.code);
    expect(body.refinement.bindEqualities + body.refinement.itemFlows).toBe(0);
    expect(body.refinement.notEncoded).toBe(1);
    expect(body.refinement.groups[0].outcome).toBe('not-refined');
    expect(
      body.refinement.groups[0].obligations.map((o) => o.code),
    ).toContain('verification/unconnected-assumption');

    // The opt-in changes the answer, so the flag says so on the process too.
    const opted = spawnCli(['refine', bare, '--connections-as-equalities']);
    expect(opted.code).toBe(0);
    expect(opted.stdout).toContain('`--connections-as-equalities` read bare `connect` edges');
  }, 240_000);

  it('refine reports a vacuous contract set as inconclusive, and no flag lowers it', async () => {
    const siblings = `${FIXV}/models/refinement-contradictory-siblings.sysml`;
    for (const extra of [[], ['--allow-inconclusive']]) {
      const r = await run(['refine', siblings, ...extra]);
      expect(r.code, `--allow-inconclusive laundered a vacuity (${extra.join(' ') || 'no flag'})`).toBe(2);
      expect(r.stdout).toContain('verification/contract-set-vacuous');
      expect(r.stdout).toContain('cannot hold together');
      expect(r.stdout, 'a contradiction was printed as a refinement').not.toContain('— refined');
    }
  }, 240_000);

  it('refine refuses a --via outside the four families, and a --element that names nothing', async () => {
    const budget = resolve(process.cwd(), 'examples/uav-power-budget.sysml');
    // A FAMILY THE MODEL STATES NOTHING IN is not a usage error and not a green
    // build either: the power-budget example states a decomposition and no
    // derivation, so `--via derive` says exactly that and exits 2, where exit 0
    // would claim every chain in the file was shown to refine.
    const derive = await run(['refine', budget, '--via', 'derive']);
    expect(derive.code).toBe(2);
    expect(derive.stdout).toContain('states no `derive` chain this lane can read');
    // AND IT PRINTS NO γ CENSUS. γ is a wiring question and a `derive` edge
    // joins two requirements — a run that read only chains borrowing the
    // decomposition line would tell a reader their file states an architecture
    // it does not.
    expect(
      derive.stdout,
      'a derivation-only run printed the connection census',
    ).not.toContain('γ, the connection assertion');
    const nonsense = await run(['refine', budget, '--via', 'sideways']);
    expect(nonsense.code).toBe(2);
    expect(nonsense.stderr).toContain('--via must be one of');

    // And a REF that resolves but names no decomposition is refused BY NAME
    // rather than reported as a file that states no architecture.
    const empty = await run(['refine', budget, '--element', 'UAVPowerBudget::BatteryPack::outputVoltage']);
    expect(empty.code).toBe(2);
    expect(empty.stderr).toContain('names no decomposition in this file');
    expect(
      empty.stdout,
      'a REF that selected nothing was reported as a model that states nothing',
    ).not.toContain('this model states no decomposition at all');

    // …and the refusal follows `--via`, because a `--via derive` run never read
    // a `satisfy` edge: advice to write one is advice about a different
    // question than the one that was asked.
    const emptyChain = await run([
      'refine',
      `${FIXV}/models/derivation-conjoins.sysml`,
      '--via',
      'derive',
      '--element',
      'DerivationConjoins::rig',
    ]);
    expect(emptyChain.code).toBe(2);
    expect(emptyChain.stderr).toContain('names no `derive` chain in this file');
    expect(
      emptyChain.stderr,
      'a derivation run advised the reader to write a `satisfy` edge',
    ).not.toContain('satisfy R by sys;');

    // AND ITS `--help` PUBLISHES ITS OWN CONTRACT, at the process boundary
    // where a reader actually meets it — spawned for that reason, like every
    // other `--help` in this file. `verify`'s paragraph is written in terms of
    // the file's VALUES — "with every feature at its model value", "a relation
    // not evaluable at the model's values", a `--free` clause — and a
    // refinement obligation reads none of them.
    const help = spawnCli(['refine', '--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('every decomposition or derivation chain the --via family reads');
    // …and it names every family `--via` accepts, so no reader meets an exit-1
    // cause their run cannot produce.
    expect(help.stdout).toContain('derive/refine chain');
    expect(help.stdout, 'refine published verify’s value-based exit contract').not.toContain(
      'at its model value',
    );
    expect(help.stdout).not.toContain('a refutation obtained under --free');
    expect(help.stdout).toContain('there is no --free here');
  }, 240_000);

  it('refine decides nothing with no solver, and --allow-inconclusive does not lower it', async () => {
    const budget = resolve(process.cwd(), 'examples/uav-power-budget.sysml');
    for (const extra of [[], ['--allow-inconclusive']]) {
      const r = await run(['refine', budget, ...extra], NO_Z3);
      expect(r.code, `--allow-inconclusive lowered an absent solver (${extra.join(' ') || 'no flag'})`).toBe(2);
      expect(r.stdout).toContain('verification/tool-absent');
      expect(r.stdout).toContain('no solver ran');
      // The census is still true — an absent solver must not read as a model
      // with no architecture in it.
      expect(r.stdout).toContain('1 decomposition(s) over 5 contract(s)');
      expect(r.stdout, 'a verdict was printed with no solver').not.toContain('— refined');
    }
  }, 240_000);

  it('refine reads a derivation chain with the orientation the mapper stores', async () => {
    // THE ORIENTATION, AS THE COMMAND REPORTS IT. `derive requirement D from R`
    // stores R on the source end, so R is the parent — and the same file read
    // the other way up does not refine. A build with the orientation reversed
    // would print "refined" here rather than failing, which is why both
    // directions are run.
    const chain = `${FIXV}/models/derivation-conjoins.sysml`;
    const r = await run(['refine', chain, '--via', 'derive']);
    expect(r.code, 'a chain the file states was not shown to refine').toBe(0);
    expect(r.stdout).toContain('1 derivation chain(s) over 3 contract(s)');
    expect(r.stdout).toContain('DerivationConjoins::TotalMass via derive — refined');
    // A derivation names no part, so the row must not claim one.
    expect(r.stdout, 'a derivation chain was reported on a part the edge never names').not.toContain(
      'via derive — refined on `',
    );
    expect(r.stdout).toContain('the derived set entails the parent’s guarantee  proved');
    expect(r.stdout).toContain('`derive requirement D from R` makes R the parent');
    expect(r.stdout).toContain('nothing here is claimed about ordering or time');

    // And the chain that is NOT a refinement is exit 1, with its own code and a
    // witness beside it.
    const stronger = `${FIXV}/models/derivation-stronger-assumption.sysml`;
    const bad = await run(['refine', stronger, '--via', 'derive']);
    expect(bad.code).toBe(1);
    expect(bad.stdout).toContain('verification/derivation-not-refinement');
    expect(bad.stdout).toContain('assumes no more: DerivationStrongerAssumption::BodyMass  refuted');
    expect(bad.stdout).toContain('witness: DerivationStrongerAssumption::Vehicle::speed');
  }, 240_000);

  it('bounds answers unbounded over a stated limit, and 25 exactly when it is folded in', () => {
    // THE FLAGSHIP PAIR OF §3.7, at the surface a person meets it: a `require`
    // clause is not an axiom, so the measure is unbounded above over a file
    // that plainly states a 25 kg limit — and the line says which clauses were
    // axioms, every time, rather than once in a header.
    const uav = `${FIXV}/models/bounds-uav.sysml`;
    const open = spawnCli(['bounds', uav, '--measure', 'uav.mtow', '--free', 'all']);
    expect(open.code, 'a proved unboundedness is a decided answer').toBe(0);
    expect(open.stdout).toContain('unbounded above');
    expect(open.stdout).toContain('`require` and `assume` clauses excluded');
    // No witness on an unbounded row: there is no maximising design to name.
    expect(open.stdout, 'a point was printed as the witness of an unbounded bound').not.toMatch(
      /unbounded above[\s\S]{0,400}?\n\s+at /,
    );

    const folded = spawnCli([
      'bounds',
      uav,
      '--measure',
      'uav.mtow',
      '--free',
      'all',
      '--with-requirements',
    ]);
    expect(folded.code).toBe(0);
    expect(folded.stdout).toContain('= 25');
    expect(folded.stdout).toContain('--with-requirements');
    expect(folded.stdout).toContain('1 requirement(s) folded in: BoundsUav::MassRequirement');
  }, 240_000);

  it('bounds prints a nonlinear bound as a bound, exits 2, and names the other optimiser', () => {
    // SPAWNED, and the only case here that spawns for a reason about MEMORY.
    // This is the one run in this file that hands z3 a NONLINEAR optimisation,
    // and an nlsat search over exact rationals has no bound on what it will
    // allocate. In its own process that is a run that takes what it takes and
    // gives it back. Sharing one `Z3Context` with forty other runs, it is not:
    // measured on this tree, the same argv answered in 200 ms from a fresh
    // context and, in a process that had already solved its way through this
    // file, drove `mpq_manager::rat_lt` into a 4.2 GB heap request that the
    // 32-bit WASM module cannot serve. z3 then aborts, the promise never
    // settles, this case times out, and every solver-bearing case AFTER it
    // fails too — seven of them, in the run that showed it. So this one keeps
    // its process, where a blow-up costs one case instead of the file.
    const uav = `${FIXV}/models/bounds-uav.sysml`;
    const r = spawnCli([
      'bounds',
      uav,
      '--measure',
      'uav.endurance',
      '--sense',
      'both',
      '--free',
      'BoundsUav::BatteryPack::capacity',
    ]);
    expect(r.code, 'a bound νZ did not certify went green').toBe(2);
    expect(r.stdout).toContain('verification/optimality-not-established');
    expect(r.stdout).toContain('optimality not established (nonlinear)');
    // The report names BOTH optimisers and says which is which, so the proved
    // bound and the heuristic search are never read as one thing.
    expect(r.stdout).toContain('src/semantics/solver.ts');

    // …and the JSON payload publishes a verdict block that agrees with the
    // process, under a contract with no exit 1 in it.
    const json = spawnCli([
      'bounds',
      uav,
      '--measure',
      'uav.payload',
      '--free',
      'uav.payload',
      '--sense',
      'both',
      '--json',
    ]);
    expect(json.code).toBe(0);
    const { keys, body } = payload<{
      verdict: { decided: number; undecided: number; exitCode: number };
      bounds: { bounds: Array<{ sense: string; outcome: string; value: number }> };
    }>(json);
    expect(keys).toEqual(['bounds', 'file', 'ok', 'verdict']);
    expect(body.verdict).toEqual({ decided: 2, undecided: 0, exitCode: 0 });
    expect(body.verdict.exitCode, 'the payload and the process must agree').toBe(json.code);
    expect(body.bounds.bounds.map((b) => [b.sense, b.outcome, b.value])).toEqual([
      ['min', 'optimum', 2],
      ['max', 'optimum', 6],
    ]);
  }, 240_000);

  it('bounds refuses a missing --measure, an unknown --sense, and publishes its own contract', async () => {
    const uav = `${FIXV}/models/bounds-uav.sysml`;
    const none = await run(['bounds', uav]);
    expect(none.code).toBe(2);
    expect(none.stderr).toContain('--measure names the feature to bound and is required');
    const sense = await run(['bounds', uav, '--measure', 'uav.mtow', '--sense', 'sideways']);
    expect(sense.code).toBe(2);
    expect(sense.stderr).toContain('--sense must be one of min, max, both');
    // A REF that names nothing is refused by name rather than reported as a
    // model with nothing to bound.
    const missing = await run(['bounds', uav, '--measure', 'uav.nosuchthing']);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('--measure names nothing in this model');

    // ITS `--help` PUBLISHES ITS OWN CONTRACT, and that contract has no exit 1:
    // this subcommand reports what the axioms admit and judges nothing. Spawned,
    // like every other `--help` here: the usage text is the one output a reader
    // reaches for when nothing else works, so it is asserted off the program.
    const help = spawnCli(['bounds', '--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('every bound asked for was DECIDED');
    expect(help.stdout).toContain('There is no exit 1');
    expect(help.stdout, 'bounds published a judging exit contract').not.toContain(
      'at least one obligation refuted',
    );
  }, 240_000);

  it('bounds stands a row down where a refused axiom reaches the objective', async () => {
    // AT THE COMMAND'S SURFACE, because this is the row a reader acts on: an
    // axiom nothing asserted widens the space the bound was computed over, so
    // the answer is looser than the model's — and "unbounded above" over a file
    // that plainly states a 9 m ceiling is exactly the sentence §3.7 forbids,
    // arriving through a silence instead of through a claim.
    const model = `${FIXV}/models/bounds-refused-axiom.sysml`;
    const near = await run([
      'bounds',
      model,
      '--measure',
      'b.depth',
      '--free',
      'BoundsRefusedAxiom::TankB::depth',
    ]);
    expect(near.code, 'a bound over a partial axiom set exited green').toBe(2);
    expect(near.stdout).toContain('verification/not-evaluable');
    expect(near.stdout).toContain('PARTIAL axiom set');
    expect(near.stdout, 'a widened space was published as unbounded').not.toContain(
      'unbounded above',
    );

    // The same refusal, out of reach of the other tank's objective: it can move
    // neither the bound nor whether one exists, so the row is decided and the
    // refusal is listed.
    const far = await run([
      'bounds',
      model,
      '--measure',
      'a.level',
      '--free',
      'BoundsRefusedAxiom::TankA::level',
    ]);
    expect(far.code).toBe(0);
    expect(far.stdout).toContain('max `BoundsRefusedAxiom::TankA::level` = 3');
    expect(far.stdout).toContain('1 relation(s) refused by a gate');
  }, 240_000);

  it('bounds decides nothing with no solver, and still names the measure', async () => {
    const uav = `${FIXV}/models/bounds-uav.sysml`;
    const r = await run(['bounds', uav, '--measure', 'uav.mtow', '--sense', 'both'], NO_Z3);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain('verification/tool-absent');
    expect(r.stdout).toContain('no solver ran');
    expect(r.stdout).toContain('BoundsUav::AirVehicle::mtow');
    expect(r.stdout, 'a bound was printed with no solver').not.toContain('exactly');
  }, 240_000);

  it('fault-tree names the single point of failure and prints the order it was found under', () => {
    const budget = resolve(process.cwd(), 'examples/uav-power-budget.sysml');
    const r = spawnCli(['fault-tree', budget]);
    // A DECOMPOSITION THAT REFINES CAN STILL HAVE FOUR SINGLE POINTS OF
    // FAILURE, and this file is the demonstration: `refine` exits 0 on it two
    // cases above, and this exits 1 on the same bytes.
    expect(r.code, 'a single point of failure went green').toBe(1);
    expect(r.stdout).toContain('verification/single-point-of-failure');
    expect(r.stdout).toContain('{BatterySupply}');
    expect(r.stdout).toContain('a basic event is "sub-contract not honoured"');
    // The bound travels with the answer, and so does what this command IS.
    expect(r.stdout).toContain('order bound 2, from the default');
    expect(r.stdout).toContain('6 solver check(s)');
    expect(r.stdout).toContain('not a behavioural safety analysis');
    // MUST NEVER read as a behavioural or probabilistic analysis.
    expect(r.stdout, 'a contract-level fault tree quoted a probability').not.toContain('probability of');
  }, 240_000);

  it('fault-tree --json publishes a top-level verdict block that agrees with the process', async () => {
    const redundant = `${FIXV}/models/fault-tree-redundant.sysml`;
    const r = await run(['fault-tree', redundant, '--json']);
    expect(r.code).toBe(1);
    const { keys, body } = payload<{
      verdict: {
        singlePointsOfFailure: number;
        withCutSets: number;
        noCutSet: number;
        vacuous: number;
        topEventOpen: number;
        inconclusive: number;
        undecidedChecks: number;
        exitCode: number;
      };
      faultTree: {
        checks: number;
        groups: Array<{
          maxOrder: number;
          singlePointOfFailure: boolean | null;
          cutSets: Array<{ order: number; shortIds: string[] }>;
          events: Array<{ intermediate: boolean }>;
        }>;
      };
    }>(r);
    expect(keys).toEqual(['faultTree', 'file', 'ok', 'verdict']);
    expect(body.verdict).toEqual({
      singlePointsOfFailure: 1,
      withCutSets: 1,
      noCutSet: 0,
      vacuous: 0,
      topEventOpen: 0,
      inconclusive: 0,
      // ITS OWN FIGURE, because it is a state the exit code is spent on that no
      // other number in this block accounts for: a tree that found an order-2
      // cut set and left an order-1 check unanswered is `withCutSets: 1,
      // inconclusive: 0` — and exit 2.
      undecidedChecks: 0,
      exitCode: 1,
    });
    expect(body.verdict.exitCode, 'the payload and the process must agree').toBe(r.code);
    expect(body.faultTree.groups[0].cutSets.map((c) => c.shortIds.join('+'))).toEqual([
      'BatteryCapacity',
      'PrimaryOutput+BackupOutput',
    ]);
    expect(body.faultTree.groups[0].maxOrder).toBe(2);
    expect(body.faultTree.checks).toBe(9);

    // The same model at order 1 finds the single point and says nothing about
    // the pair — a bounded absence is not an absence.
    const bounded = await run(['fault-tree', redundant, '--max-order', '1']);
    expect(bounded.code).toBe(1);
    expect(bounded.stdout).toContain('up to order 1');
    expect(bounded.stdout, 'a run bounded at order 1 named an order-2 set').not.toContain(
      '{PrimaryOutput, BackupOutput}',
    );
  }, 240_000);

  it('fault-tree refuses a state machine with the pointer, and a --max-order that is not a bound', async () => {
    // THE TWO SAFETY LANES STAY APART, at the surface a person meets them. An
    // empty cut-set list over a machine reads as a behaviour with no failure
    // mode, so the command refuses by name and points at the other lane.
    const machine = await run(['fault-tree', UAV, '--element', 'FlightModes']);
    expect(machine.code).toBe(2);
    expect(machine.stderr).toContain('contract-level fault trees do not cover behaviour');
    expect(machine.stderr).toContain('check-behaviour');
    expect(machine.stdout, 'a machine was answered with a cut-set list').not.toContain('cut set');

    // A bound that is not a bound is an answer about the command line, and it
    // arrives before the model is parsed.
    const bad = await run(['fault-tree', UAV, '--max-order', 'two']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('--max-order must be a whole number');
    const zero = await run(['fault-tree', UAV, '--max-order', '0']);
    expect(zero.code).toBe(2);
  }, 240_000);

  it('fault-tree reports a vacuous contract set, and decides nothing with no solver', async () => {
    const siblings = `${FIXV}/models/refinement-contradictory-siblings.sysml`;
    const vacuous = await run(['fault-tree', siblings]);
    expect(vacuous.code, 'a vacuity was laundered into an answer').toBe(2);
    expect(vacuous.stdout).toContain('verification/contract-set-vacuous');
    expect(vacuous.stdout).toContain('contract set vacuous');
    expect(vacuous.stdout, 'a vacuity was printed as an absence of failure').not.toContain(
      'no cut set up to order',
    );

    const budget = resolve(process.cwd(), 'examples/uav-power-budget.sysml');
    const absent = await run(['fault-tree', budget], NO_Z3);
    expect(absent.code).toBe(2);
    expect(absent.stdout).toContain('verification/tool-absent');
    expect(absent.stdout).toContain('no solver ran');
    // The census is still true — an absent solver must not read as a model with
    // no architecture in it — and no cut set, and no absence of one, is printed.
    expect(absent.stdout).toContain('4 basic event(s)');
    expect(absent.stdout, 'a cut set was printed with no solver').not.toContain('is a cut set');
    // AND IT STATES THE BOUND IT WAS GIVEN, not the one the module defaults to:
    // a run that enumerated nothing must not attribute an order bound to a
    // source the reader did not use.
    expect(absent.stdout).toContain('order bound 2, from the default');
    const boundedAbsent = await run(['fault-tree', budget, '--max-order', '1'], NO_Z3);
    expect(boundedAbsent.code).toBe(2);
    expect(boundedAbsent.stdout).toContain('order bound 1, from --max-order');
    expect(
      boundedAbsent.stdout,
      'a solverless run attributed the bound to a source the reader did not use',
    ).not.toContain('order bound 2, from the default');
  }, 240_000);

  it('consistency --subject narrows by what the reader typed, and refuses a REF that selects nothing', async () => {
    // THREE SPELLINGS A READER REACHES FOR, and the promise they rest on: "a
    // type answers for its subtypes". The type no contract names, and the part
    // usage the file writes after `subject` — which every row of this report
    // prints beside the type — both have to select the set the guide says they
    // select, and the conformance test underneath them inverts silently.
    const model = `${FIXV}/models/consistency-subtype.sysml`;
    const air = await run(['consistency', model, '--subject', 'ConsistencySubtype::AirVehicle']);
    expect(air.code).toBe(0);
    expect(air.stdout).toContain('4 requirement(s) on 1 subject(s)');
    expect(air.stdout).toContain('subject ConsistencySubtype::AirVehicle');
    expect(air.stdout, 'narrowing to a subtype pulled in its sibling set').not.toContain(
      'subject ConsistencySubtype::Vehicle',
    );

    const usage = await run(['consistency', model, '--subject', 'ConsistencySubtype::uav']);
    expect(usage.code).toBe(0);
    expect(usage.stdout).toContain('subject ConsistencySubtype::AirVehicle');

    // AND A REF THAT RESOLVES AND SELECTS NOTHING IS A USAGE ERROR. The
    // run-wide sentence says the file states no requirement set at all, and
    // printing that because a `--subject` matched none of them would be a false
    // statement about the reader's model in the one place they came for a true
    // one.
    const empty = await run(['consistency', model, '--subject', 'ConsistencySubtype::Vehicle::mass']);
    expect(empty.code).toBe(2);
    expect(empty.stderr).toContain('is not the subject of any requirement in this file');
    expect(
      empty.stdout,
      'a subject that selected nothing was reported as a model that states nothing',
    ).not.toContain('this model states no requirement set at all');
  }, 180_000);

  it('consistency refuses a budget that is not one and a subject that names nothing', async () => {
    const badCore = await run(['consistency', UAV, '--max-core', '0']);
    expect(badCore.code).toBe(2);
    expect(badCore.stderr).toContain('--max-core must be a positive whole number');
    expect(badCore.stderr, 'a usage error was reported as a tool defect').not.toContain(
      'internal error',
    );
    const badSubject = await run(['consistency', UAV, '--subject', 'NoSuchThing']);
    expect(badSubject.code).toBe(2);
    expect(badSubject.stderr).toContain('no element matches `NoSuchThing`');
  }, 180_000);

  it('the evidence round trip at the process boundary: record, attach, go stale, detach', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sysprose-cli-'));
    try {
      const model = join(dir, 'uav.sysml');
      writeFileSync(model, readFileSync(UAV, 'utf8'));
      const records = join(dir, 'evidence.json');

      const recorded = spawnCli(['verify', model, '--engine', 'literal', '--record', records]);
      expect(recorded.code).toBe(0);
      expect(existsSync(records)).toBe(true);

      // ATTACHING DOES NOT WRITE THE INPUT. The updated model is on stdout and
      // the file is untouched until `--out` says otherwise — the one property
      // that lets a reader run this command to see what it would do.
      const dry = spawnCli(['evidence-attach', model, '--from', records]);
      expect(dry.code).toBe(0);
      expect(dry.stdout).toContain('@SysproseVerification::Evidence');
      expect(dry.stderr).toContain('was NOT changed');
      expect(readFileSync(model, 'utf8'), 'the input file was rewritten without --out').toBe(
        readFileSync(UAV, 'utf8'),
      );

      const attached = spawnCli(['evidence-attach', model, '--from', records, '--out', model]);
      expect(attached.code).toBe(0);
      expect(attached.stderr).toContain('2 record(s) attached to 2 element(s)');
      expect(attached.stderr).toContain('2 verdict facet(s) written');
      const written = readFileSync(model, 'utf8');
      // A `--engine literal` record claims `holds-at-values`, so the facet it
      // derives is `inconclusive`. `pass` is written for `proved` alone.
      expect(written).toContain('attribute claim = "holds-at-values"');
      expect(written).toContain('attribute verdict = "inconclusive"');
      expect(written, 'a point evaluation wrote a pass').not.toContain(
        'attribute verdict = "pass"',
      );

      const fresh = spawnCli(['evidence-status', model]);
      expect(fresh.code).toBe(0);
      expect(fresh.stdout).toContain('0 stale, 2 current, 0 unrecorded');
      expect(fresh.stdout).toContain('`holds-at-values` is never shown as `proved`');

      // Re-attaching the same records says nothing new and writes nothing.
      const again = spawnCli(['evidence-attach', model, '--from', records]);
      expect(again.stderr).toContain('0 record(s) attached');
      expect(again.stderr).toContain('2 already present');

      // ONE LITERAL, and the verdict in the file stops standing on the model it
      // was reached over — reported by `evidence-status` AND by the ordinary
      // checker, which is what the next person to open the file runs.
      writeFileSync(model, written.replace('18.5 [kg]', '19.5 [kg]'));
      const stale = spawnCli(['evidence-status', model]);
      expect(stale.code).toBe(0);
      expect(stale.stdout).toContain('2 stale, 0 current');
      expect(stale.stdout).toMatch(/slice: UAVSurveillanceSystem::/);
      const checked = spawnSync('npx', ['tsx', CHECK_CLI, model], { encoding: 'utf8' });
      expect(checked.stdout).toContain('validation/stale-evidence');
      expect(checked.stdout, 'the warning must name the slice, not just count it').toContain(
        'Re-read this requirement’s slice — UAVSurveillanceSystem::',
      );

      // And the facet goes off with the carrier, or the detach would leave a
      // verdict with nothing behind it.
      const detached = spawnCli(['evidence-detach', model, '--out', model]);
      expect(detached.code).toBe(0);
      expect(detached.stderr).toContain('2 verdict facet(s) cleared');
      const bare = readFileSync(model, 'utf8');
      expect(bare).not.toContain('SysproseVerification::Evidence');
      expect(bare).not.toContain('attribute verdict =');
      expect(spawnCli(['evidence-status', model]).stdout).toContain(
        'nothing in this file states a verdict or carries a record',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);

  it('evidence-attach refuses a missing --from, a file that is not records, and a degraded model', async () => {
    const noFrom = await run(['evidence-attach', UAV]);
    expect(noFrom.code).toBe(2);
    expect(noFrom.stderr).toContain('--from PATH is required');
    // Refused BEFORE the library is bound: a run that parsed 38 761 elements to
    // discover it had nothing to attach is a run that wasted the reader's time.
    expect(noFrom.stdout, 'the model was loaded before the flag was checked').toBe('');

    const dir = mkdtempSync(join(tmpdir(), 'sysprose-cli-'));
    try {
      const notRecords = join(dir, 'notes.json');
      writeFileSync(notRecords, JSON.stringify([{ verdict: 'pass' }]));
      const bad = await run(['evidence-attach', UAV, '--from', notRecords]);
      expect(bad.code).toBe(2);
      expect(bad.stderr).toContain('does not hold evidence records this tool wrote');
      expect(bad.stderr).toContain('docs/schemas/evidence-record.schema.json');
      expect(bad.stderr, 'a bad input file was reported as a tool defect').not.toContain(
        'internal error',
      );

      const notJson = join(dir, 'notes.txt');
      writeFileSync(notJson, 'these are my notes');
      expect((await run(['evidence-attach', UAV, '--from', notJson])).stderr).toContain('is not JSON');

      // A model that did not load cleanly is never written back: serializing a
      // salvaged model over somebody's source is a lossy rewrite of it.
      const broken = join(dir, 'broken.sysml');
      writeFileSync(broken, 'package P {\n    part def A;\n    part a : A;\n    part def ?? ;\n}\n');
      const records = join(dir, 'ev.json');
      writeFileSync(records, '[]');
      const degraded = await run(['evidence-attach', broken, '--from', records]);
      expect(degraded.code).toBe(2);
      expect(degraded.stderr).toContain('refuses a model that did not load cleanly');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);

  it('evidence-status names a verdict with nothing behind it, and one that overstates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sysprose-cli-'));
    try {
      // A verdict somebody typed. INFO, not a defect: a verdict reached by
      // inspection is ordinary requirements management, and the row says only
      // that this tool has nothing standing behind it.
      const claimed = join(dir, 'claimed.sysml');
      writeFileSync(
        claimed,
        'package P {\n    part vehicle;\n    requirement <R1> massLimit {\n' +
          '        subject vehicle;\n' +
          '        metadata RequirementMetadata {\n            attribute verdict = "pass";\n        }\n' +
          '    }\n}\n',
      );
      const unrecorded = await run(['evidence-status', claimed, '--json']);
      expect(unrecorded.code).toBe(0);
      const { body } = payload<{
        evidenceStatus: { unrecorded: number; overstated: number; rows: Array<{ code?: string }> };
      }>(unrecorded);
      expect(body.evidenceStatus.unrecorded).toBe(1);
      expect(body.evidenceStatus.rows[0].code).toBe('verification/claimed-without-evidence');

      // The same file with a real record beside it, and the facet raised to
      // `pass` by hand over a claim that is `holds-at-values`. `evidence-attach`
      // cannot produce this state; a file in it was written by hand.
      const model = join(dir, 'uav.sysml');
      writeFileSync(model, readFileSync(UAV, 'utf8'));
      const records = join(dir, 'ev.json');
      expect((await run(['verify', model, '--engine', 'literal', '--record', records])).code).toBe(0);
      expect((await run(['evidence-attach', model, '--from', records, '--out', model])).code).toBe(0);
      // The FACET, not the carrier's own summary cell of the same name — the
      // record has to keep saying `inconclusive` or this case would be a file
      // that agrees with itself.
      writeFileSync(
        model,
        readFileSync(model, 'utf8').replace(
          /(metadata RequirementMetadata \{\s*attribute verdict = )"inconclusive"/g,
          '$1"pass"',
        ),
      );
      const overstated = await run(['evidence-status', model]);
      expect(overstated.stdout).toContain('overstated');
      expect(overstated.stdout).toContain('verification/verdict-overstates-evidence');
      expect(overstated.stdout).toContain('`pass` is written for `proved` alone');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);

  it('evidence-attach PRINTS every verdict it moves, and every record it could not place', async () => {
    // THE SENTENCE THE SECTION IS WRITTEN AROUND: a `fail` is never replaced by
    // a `pass` WITHOUT THE DIFF BEING PRINTED. The in-memory `AttachReport`
    // carries the change; nothing asserted that the command renders it, so both
    // stderr loops could be deleted and the suite stayed green.
    const dir = mkdtempSync(join(tmpdir(), 'sysprose-cli-'));
    try {
      const model = join(dir, 'refuted.sysml');
      writeFileSync(
        model,
        'package L {\n    part def Vehicle {\n        attribute topSpeed : Real = 260.0;\n    }\n' +
          '    part vehicle : Vehicle;\n    requirement <R1> speedLimit {\n' +
          '        subject vehicle : Vehicle;\n' +
          '        require constraint { vehicle.topSpeed <= 200.0 }\n    }\n}\n',
      );
      const refuted = join(dir, 'refuted.json');
      // A refuted obligation exits 1 under the judging contract — a decided
      // negative, which is exactly what this case needs.
      expect((await run(['verify', model, '--engine', 'literal', '--record', refuted])).code).toBe(1);
      const first = JSON.parse(readFileSync(refuted, 'utf8')) as Array<{
        claim: string;
        verdict: string;
        obligation: { requirement: string | null; clause: string };
      }>;
      expect(first[0].claim).toBe('refuted');

      const attached = await run(['evidence-attach', model, '--from', refuted, '--out', model]);
      expect(attached.code).toBe(0);
      expect(readFileSync(model, 'utf8')).toContain('attribute verdict = "fail"');

      // The SAME obligation, re-recorded as a proof. Nothing in the model
      // changed, so this is the laundering direction the plan names by hand.
      const proved = join(dir, 'proved.json');
      writeFileSync(
        proved,
        JSON.stringify([{ ...first[0], claim: 'proved', verdict: 'pass', engine: 'smt' }]),
      );
      const moved = await run(['evidence-attach', model, '--from', proved, '--out', model]);
      expect(moved.code).toBe(0);
      expect(moved.stderr).toContain('verdict fail → pass');
      expect(moved.stderr).toContain('(claim refuted → proved)');
      expect(
        moved.stderr,
        'a refutation was replaced by a pass and the command said nothing about it',
      ).toContain('a refutation is being replaced by a pass');
      // The refutation is still in the file: evidence accumulates.
      expect((await run(['evidence-status', model, '--json'])).stdout).toContain('"records": 2');

      // AND A RECORD THIS MODEL CANNOT CARRY IS NAMED, not silently dropped.
      const elsewhere = join(dir, 'elsewhere.json');
      writeFileSync(
        elsewhere,
        JSON.stringify([
          { ...first[0], obligation: { ...first[0].obligation, requirement: 'Other::notHere' } },
        ]),
      );
      const skipped = await run(['evidence-attach', model, '--from', elsewhere]);
      expect(skipped.code).toBe(0);
      expect(skipped.stderr).toContain(`skipped ${first[0].obligation.clause}`);
      expect(skipped.stderr).toContain('no element of this model is called `Other::notHere`');
      expect(skipped.stderr).toContain('0 record(s) attached');
      expect(skipped.stderr).toContain('1 skipped');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);

  it('a requirement with two obligations carries the worst of them, whichever order they are written in', async () => {
    // The facet used to come from the LAST record in file order, so the same
    // evidence over the same design wrote `fail` one way round and something
    // weaker the other — a verdict that was a function of the source layout.
    const dir = mkdtempSync(join(tmpdir(), 'sysprose-cli-'));
    try {
      const speed = '        require constraint speedOk { vehicle.topSpeed <= 200.0 }\n';
      const mass = '        require constraint massOk { vehicle.mass <= 2000.0 }\n';
      const head =
        'package W {\n    part def Vehicle {\n        attribute mass : Real = 1500.0;\n' +
        '        attribute topSpeed : Real = 260.0;\n    }\n    part vehicle : Vehicle;\n' +
        '    requirement <R1> massAndSpeed {\n        subject vehicle : Vehicle;\n';
      const tail = '    }\n}\n';

      for (const [name, clauses] of [
        ['refuted-first', speed + mass],
        ['refuted-last', mass + speed],
      ] as const) {
        const model = join(dir, `${name}.sysml`);
        writeFileSync(model, head + clauses + tail);
        const records = join(dir, `${name}.json`);
        expect((await run(['verify', model, '--engine', 'literal', '--record', records])).code).toBe(1);
        const attached = await run(['evidence-attach', model, '--from', records, '--out', model]);
        expect(attached.code).toBe(0);
        expect(attached.stderr).toContain('2 record(s) attached to 1 element(s)');
        expect(attached.stderr).toContain('1 verdict facet(s) written');
        const written = readFileSync(model, 'utf8');
        // The FACET the requirement carries, read past the two carriers'
        // own summary cells: the requirement is not discharged, because one of
        // its two obligations is refuted.
        expect(
          /metadata RequirementMetadata \{\s*attribute verdict = "fail"/.test(written),
          `${name}: the requirement's facet is not the worst of its obligations`,
        ).toBe(true);
        const status = await run(['evidence-status', model]);
        expect(status.stdout, name).toContain('claim `refuted`, verdict `fail`');
        expect(status.stdout, name).toContain('the weakest of 2 obligations');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);

  it('evidence-attach refuses a record whose stated verdict does not follow from its claim', async () => {
    // `verdict` and `claim` are two independent enumerations in the schema, so
    // `{"claim":"holds-at-values","verdict":"pass"}` is valid against it and is
    // still a laundered claim. Copying the record's own verdict through wrote
    // `attribute verdict = "pass"` over a point evaluation.
    const dir = mkdtempSync(join(tmpdir(), 'sysprose-cli-'));
    try {
      const model = join(dir, 'uav.sysml');
      writeFileSync(model, readFileSync(UAV, 'utf8'));
      const records = join(dir, 'ev.json');
      expect((await run(['verify', model, '--engine', 'literal', '--record', records])).code).toBe(0);
      const parsed = JSON.parse(readFileSync(records, 'utf8')) as Array<{
        claim: string;
        verdict: string;
      }>;
      expect(parsed[0].claim).toBe('holds-at-values');
      const laundered = join(dir, 'laundered.json');
      writeFileSync(laundered, JSON.stringify([{ ...parsed[0], verdict: 'pass' }]));

      const refused = await run(['evidence-attach', model, '--from', laundered, '--out', model]);
      expect(refused.code).toBe(2);
      expect(refused.stderr).toContain('says `pass` over the claim `holds-at-values`');
      expect(refused.stderr).toContain('`pass` is written for `proved` alone');
      expect(
        readFileSync(model, 'utf8'),
        'a refused record file still rewrote the model',
      ).toBe(readFileSync(UAV, 'utf8'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);

  it('verify --case judges one verification case, and the method gate decides the run', async () => {
    // The L7 case §3.0 promises per new REF flag, asserted on the report a
    // reader meets. The example ships three cases on purpose: one
    // `analyze`, one `test`, one `kind = (analyze, test)`.
    const VER = resolve(process.cwd(), 'examples/uav-isr-verification.sysml');

    // THE WHOLE FILE. Every obligation in it is discharged — the header says so
    // — and the run is still 2, because a case in it was never judged.
    const all = await run(['verify', VER, '--engine', 'literal']);
    expect(all.code, 'an unjudged case did not reach the exit code').toBe(2);
    expect(all.stdout).toContain('0 inconclusive, 3 discharged, 0 refuted');
    expect(all.stdout).toContain('3 verification case(s): 2 pass, 0 fail, 1 inconclusive');
    expect(all.stdout).toContain('1 not judged at all — this tool performs analysis only');

    // ONE CASE, JUDGED. The report is narrowed to the obligations of the
    // requirement it verifies; the other two requirements are still in the
    // model, and the axioms they stand on are still in force.
    const one = await run(['verify', VER, '--engine', 'literal', '--case', 'enduranceAnalysis']);
    expect(one.code).toBe(0);
    expect(one.stdout).toContain('uav.endurance >= 45.0 [min]');
    expect(one.stdout, 'a narrowed report showed another case’s obligation').not.toContain(
      'uav.mtow <= 25.0 [kg]',
    );
    expect(one.stdout).toContain('verifies UAVSurveillanceVerification::EnduranceRequirement');
    // The two verdict words, in the terminal: green run, and a file that may
    // still not say `pass` about a point evaluation.
    expect(one.stdout).toContain('the file may record `inconclusive`, not `pass`');

    // THE METHOD GATE, and the flag that does not reach it. Exit 2 both ways,
    // and 1 is not among them: an unjudged case is not a refutation.
    for (const extra of [[], ['--allow-inconclusive']]) {
      const bench = await run(['verify', VER, '--engine', 'literal', '--case', 'massBench', ...extra]);
      expect(bench.code, `--case massBench ${extra.join(' ')}`).toBe(2);
      expect(bench.stdout).toContain('verification/method-not-performed');
      expect(bench.stdout).toContain(
        'inconclusive: method is test — this tool performs analysis only',
      );
    }

    // THE MIXED CASE, judged on the analyze part and saying so.
    const mixed = await run(['verify', VER, '--engine', 'literal', '--case', 'linkQualification']);
    expect(mixed.code).toBe(0);
    expect(mixed.stdout).toContain('test not performed by this tool');

    // A REF THAT IS NOT A CASE is refused BY NAME rather than answered as a run
    // over the whole model, and the refusal lists what the file does have.
    const notACase = await run(['verify', VER, '--engine', 'literal', '--case', 'MassRequirement']);
    expect(notACase.code).toBe(2);
    expect(notACase.stderr).toContain('which is not a verification case');
    expect(notACase.stderr).toContain('UAVSurveillanceVerification::massBench');
    const missing = await run(['verify', VER, '--engine', 'literal', '--case', 'NoSuchCase']);
    expect(missing.code).toBe(2);

    // AND IT IS IN THE REPRODUCIBLE COMMAND, for the same reason `--free` is:
    // it changes which obligations the records are about.
    const dir = mkdtempSync(join(tmpdir(), 'sysprose-cli-'));
    try {
      const records = join(dir, 'endurance.json');
      expect(
        (await run(['verify', VER, '--engine', 'literal', '--case', 'enduranceAnalysis', '--record', records])).code,
      ).toBe(0);
      const parsed = JSON.parse(readFileSync(records, 'utf8')) as Array<{
        producedBy: string;
        flags: Record<string, unknown>;
        obligation: { requirement: string };
      }>;
      expect(parsed.length).toBe(1);
      expect(parsed[0].obligation.requirement).toBe(
        'UAVSurveillanceVerification::EnduranceRequirement',
      );
      expect(parsed[0].producedBy).toContain(
        '--case UAVSurveillanceVerification::enduranceAnalysis',
      );
      expect(parsed[0].flags.case).toBe('UAVSurveillanceVerification::enduranceAnalysis');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);

  it('record then attach writes the verdict facet and the standard method annotation', async () => {
    // The pipeline of §3.4, asserted on what the run prints. The case here states NO
    // method, so the attach writes `@VerificationCases::VerificationMethod
    // { kind = analyze; }` onto it — the one standard slot this lane writes,
    // so the file says which method the verdict was reached under instead of
    // leaving a reader to assume it.
    const dir = mkdtempSync(join(tmpdir(), 'sysprose-cli-'));
    try {
      const model = join(dir, 'case.sysml');
      writeFileSync(
        model,
        [
          'package RecordThenAttach {',
          '    part def Chassis {',
          '        attribute mass : ISQ::MassValue = 18.5 [kg];',
          '    }',
          '    part chassis : Chassis;',
          '    requirement def MassLimit {',
          '        attribute id = "R-1";',
          '        subject chassis : Chassis;',
          '        require constraint { chassis.mass <= 25.0 [kg] }',
          '    }',
          '    verification massAnalysis {',
          '        subject chassis : Chassis;',
          '        objective { verify MassLimit; }',
          '    }',
          '    satisfy MassLimit by chassis;',
          '}',
          '',
        ].join('\n'),
      );
      const records = join(dir, 'evidence.json');
      expect((await run(['verify', model, '--engine', 'literal', '--record', records])).code).toBe(0);

      const attached = await run(['evidence-attach', model, '--from', records, '--out', model]);
      expect(attached.code).toBe(0);
      // Nothing is written silently: the annotation is announced on stderr,
      // beside every record and every verdict the attach placed.
      expect(attached.stderr).toContain('declared no method — wrote the standard');
      const text = readFileSync(model, 'utf8');
      expect(text).toContain('@VerificationCases::VerificationMethod');
      expect(text).toContain('attribute kind = analyze');
      // A POINT EVALUATION NEVER WRITES `pass`, whichever writer put the facet
      // there — the record's rule and the case's rule are the same rule.
      expect(text).toContain('attribute verdict = "inconclusive"');
      expect(text, 'a literal run laundered into a proof').not.toContain(
        'attribute verdict = "pass"',
      );

      // THE FILE IT WROTE IS CLEAN, and this is the assertion with the teeth.
      // The annotation goes INTO the model the records were taken over, so
      // unless it is excluded from the canonical graph exactly as the carriers
      // are, `evidence-attach` invalidates inside one command the evidence it
      // has just attached: the saved file is born `validation/stale-evidence`.
      // Greping the bytes cannot see that; only asking the tool can.
      const status = await run(['evidence-status', model]);
      expect(status.code).toBe(0);
      expect(status.stdout, 'the attach wrote a file its own status calls stale').toContain(
        '0 stale, 1 current, 0 unrecorded',
      );
      // Every subcommand runs the checker over the file it was handed and
      // prints its findings on stderr, so a clean stderr IS the checker's
      // verdict on the artefact. Before the annotation was taken out of the
      // canonical graph this said `1 stale, 0 current` above and printed
      // `warning validation/stale-evidence` here, on the file the same command
      // had just written.
      expect(status.stderr, 'the attach wrote a file the checker calls stale').not.toContain(
        'validation/stale-evidence',
      );
      expect(status.stderr).not.toContain('warning(s)');

      // AND THE PAYLOAD SAYS WHAT THE FILE SAYS. The case layer runs after
      // `attachEvidence`, whose own report knows nothing about cases — so a
      // `--json` body carrying that report alone would state a verdict the
      // artefact beside it does not contain.
      const asJson = await run(['evidence-attach', model, '--from', records, '--json']);
      expect(asJson.code).toBe(0);
      const { body } = payload<{
        evidenceAttach: {
          caseVerdicts: Array<{
            case: string;
            verdict: string;
            written: Array<{ requirement: string; verdict: string }>;
            methodWritten: boolean;
          }>;
        };
      }>(asJson);
      const written = body.evidenceAttach.caseVerdicts;
      expect(written.length).toBe(1);
      expect(written[0].case).toBe('RecordThenAttach::massAnalysis');
      expect(written[0].verdict).toBe('inconclusive');
      expect(written[0].written).toEqual([
        { requirement: 'RecordThenAttach::MassLimit', verdict: 'inconclusive' },
      ]);

      // Idempotent from the second save: the case now DECLARES a method, so a
      // second attach does not stack a second annotation on it.
      const again = await run(['evidence-attach', model, '--from', records, '--out', model]);
      expect(again.code).toBe(0);
      expect(again.stderr).not.toContain('declared no method');
      expect(
        readFileSync(model, 'utf8').match(/@VerificationCases::VerificationMethod/g)?.length,
      ).toBe(1);
      expect((await run(['evidence-status', model])).stdout).toContain('0 stale, 1 current');

      // ATTACH THEN DETACH IS AN INVERSE, annotation included: a tool-authored
      // sentence about the METHOD that no command removed would outlive every
      // claim it was written beside.
      const detached = await run(['evidence-detach', model, '--out', model]);
      expect(detached.code).toBe(0);
      expect(detached.stderr).toContain('RecordThenAttach::massAnalysis');
      expect(readFileSync(model, 'utf8')).not.toContain('VerificationMethod');
      expect(readFileSync(model, 'utf8')).not.toContain('attribute verdict');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);

  it('the method gate reads every spelling of `kind`, including an inherited one', async () => {
    // FOUR PARSE-CLEAN SPELLINGS OF ONE SENTENCE, and the gate has to read all
    // of them, because the arm that JUDGES is the one a case falls into when no
    // method is found. Measured on this file before the reader was widened:
    // `metadata VerificationMethod { … }` (the definition name in
    // `declaredName`), `metadata vm : …VerificationMethod { … }` (the name on a
    // `FeatureTyping` child), `attribute :>> kind` (a redefinition cell with no
    // declared name) and a method declared on the `verification def` a usage
    // specializes ALL read as "none declared" — so a `test` case passed, exit 0.
    const dir = mkdtempSync(join(tmpdir(), 'sysprose-cli-'));
    try {
      const model = join(dir, 'spellings.sysml');
      writeFileSync(
        model,
        [
          'package Spellings {',
          '    part def Chassis {',
          '        attribute mass : ISQ::MassValue = 18.5 [kg];',
          '    }',
          '    part chassis : Chassis;',
          '    requirement def MassLimit {',
          '        subject chassis : Chassis;',
          '        require constraint { chassis.mass <= 25.0 [kg] }',
          '    }',
          '    verification bareMetadata {',
          '        subject chassis : Chassis;',
          '        metadata VerificationMethod { attribute kind = test; }',
          '        objective { verify MassLimit; }',
          '    }',
          '    verification typedMetadata {',
          '        subject chassis : Chassis;',
          '        metadata vm : VerificationCases::VerificationMethod { attribute kind = test; }',
          '        objective { verify MassLimit; }',
          '    }',
          '    verification def BenchDef {',
          '        @VerificationCases::VerificationMethod { attribute kind = test; }',
          '    }',
          '    verification inheritedMethod : BenchDef {',
          '        subject chassis : Chassis;',
          '        objective { verify MassLimit; }',
          '    }',
          '    satisfy MassLimit by chassis;',
          '}',
          '',
        ].join('\n'),
      );
      // The file itself is well formed — this is a gate defect, not a parse one.
      const parsed = await run(['stats', model]);
      expect(parsed.code).toBe(0);
      expect(parsed.stderr).not.toContain('error(s)');

      for (const name of ['bareMetadata', 'typedMetadata', 'inheritedMethod']) {
        const r = await run(['verify', model, '--engine', 'literal', '--case', name]);
        expect(r.code, `${name} was judged over a method this tool does not perform`).toBe(2);
        expect(r.stdout).toContain('verification/method-not-performed');
        expect(r.stdout).toContain('inconclusive: method is test');
        expect(r.stdout, `${name} read its own method as absent`).not.toContain(
          'method: none declared',
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);

  it('a case over two requirements writes each one its own verdict facet', async () => {
    // THE FACET IS ABOUT ONE REQUIREMENT; THE CASE VERDICT IS A ROLL-UP OVER A
    // SET. Writing the case's word onto each member made the file contradict
    // itself: `WidthLimit` carried `@Evidence { claim = "holds-at-values";
    // verdict = "inconclusive"; }` and, two lines below, `verdict = "fail"`
    // taken from the case that another requirement had refuted.
    const dir = mkdtempSync(join(tmpdir(), 'sysprose-cli-'));
    try {
      const model = join(dir, 'tworeqs.sysml');
      writeFileSync(
        model,
        [
          'package TwoReqs {',
          '    part def Chassis {',
          '        attribute mass : ISQ::MassValue = 3000.0 [kg];',
          '        attribute width : ISQ::LengthValue = 1.5 [m];',
          '    }',
          '    part chassis : Chassis;',
          '    requirement def MassLimit {',
          '        subject chassis : Chassis;',
          '        require constraint { chassis.mass <= 2000.0 [kg] }',
          '    }',
          '    requirement def WidthLimit {',
          '        subject chassis : Chassis;',
          '        require constraint { chassis.width <= 2.0 [m] }',
          '    }',
          '    verification bothAnalysis {',
          '        subject chassis : Chassis;',
          '        @VerificationCases::VerificationMethod { attribute kind = analyze; }',
          '        objective { verify MassLimit; verify WidthLimit; }',
          '    }',
          '    satisfy MassLimit by chassis;',
          '    satisfy WidthLimit by chassis;',
          '}',
          '',
        ].join('\n'),
      );
      const records = join(dir, 'evidence.json');
      // The case is `fail` — one of its two requirements is refuted at the
      // model's values — and that is exit 1.
      expect((await run(['verify', model, '--engine', 'literal', '--record', records])).code).toBe(1);
      expect((await run(['evidence-attach', model, '--from', records, '--out', model])).code).toBe(0);

      const text = readFileSync(model, 'utf8');
      const block = (name: string): string => {
        const at = text.indexOf(`requirement def ${name}`);
        expect(at, `${name} is missing from the written file`).toBeGreaterThan(-1);
        const next = text.indexOf('requirement def ', at + 1);
        return text.slice(at, next === -1 ? text.length : next);
      };
      expect(block('MassLimit')).toContain('attribute claim = "refuted"');
      expect(block('MassLimit')).toContain('attribute verdict = "fail"');
      // The one the same run showed holding keeps its own word, beside its own
      // carrier, rather than the case's.
      expect(block('WidthLimit')).toContain('attribute claim = "holds-at-values"');
      expect(block('WidthLimit')).toContain('attribute verdict = "inconclusive"');
      expect(
        block('WidthLimit'),
        'the case’s `fail` was stamped onto a requirement this run did not refute',
      ).not.toContain('attribute verdict = "fail"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);

  it('reach walks FlightModes and names the choice the simulator hides', async () => {
    const r = await run(['reach', UAV]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('1 state machine(s)');
    expect(r.stdout).toContain('FlightModes');
    expect(r.stdout).toContain('4 of 4 state(s) reachable');
    expect(r.stdout).toContain('0 dead');
    expect(r.stdout).toContain('exhaustive under {maxConfigs 10000, maxDepth 200, maxCompletion 64');
    expect(r.stdout).toContain('verification/nondeterministic-choice');
    expect(r.stdout).toContain('the simulator takes');
    // The machine is trigger-less, so the report may not print a trigger label
    // it made up: the alphabet line has to say there is none.
    expect(r.stdout).toContain('alphabet no named trigger');
    // And the words this command may never print, whatever it found.
    expect(r.stdout).not.toMatch(/\bproved\b|\bverified\b|\bdeadlock-free\b/);
  }, 90_000);

  it('reach --json publishes under `reach`, with the semantic profile beside the figures', async () => {
    const r = await run(['reach', UAV, '--json']);
    expect(r.code).toBe(0);
    const { keys, body } = payload<{
      reach: {
        machines: Array<{
          machine: { name: string };
          exhaustive: boolean;
          boundHit: string;
          qualification: string;
          bounds: { maxConfigs: number; maxCompletion: number; alphabet: string[] };
          states: { total: number; reachable: Array<{ name: string }>; unreachable: unknown[] };
          transitions: { total: number; fired: number; dead: unknown[] };
          nondeterminism: Array<{ state: { name: string }; event: string; taken: { to: { name: string } } }>;
        }>;
        profile: Array<{ field: string; reading: string; provenance: string }>;
        totals: { machines: number; exhaustive: number };
        diagnostics: Array<{ code: string; severity: string }>;
      };
    }>(r);
    expect(keys).toEqual(['file', 'ok', 'reach']);
    expect(body.reach.totals).toMatchObject({ machines: 1, exhaustive: 1 });
    const fm = body.reach.machines[0];
    expect(fm.machine.name).toBe('FlightModes');
    expect(fm.exhaustive).toBe(true);
    expect(fm.boundHit).toBe('none');
    expect(fm.states.total).toBe(4);
    expect(fm.states.unreachable).toEqual([]);
    expect(fm.transitions).toMatchObject({ total: 5, fired: 5, dead: [] });
    expect(fm.bounds.alphabet).toEqual([]);
    expect(fm.nondeterminism).toHaveLength(1);
    expect(fm.nondeterminism[0].state.name).toBe('autonomous');
    expect(fm.nondeterminism[0].event).toBe('');
    expect(fm.nondeterminism[0].taken.to.name).toBe('manual');
    // Every report carries the reading it holds under (plan §3.8).
    expect(body.reach.profile.map((f) => f.field)).toEqual([
      'run-to-completion',
      'priority',
      'history',
      'regions',
      'deferred events',
      'time',
    ]);
    expect(body.reach.diagnostics.map((d) => d.code)).toEqual([
      'verification/nondeterministic-choice',
    ]);
  }, 90_000);

  it('reach --max-configs suppresses both absence lists rather than shrinking them', async () => {
    const r = await run(['reach', UAV, '--max-configs', '2', '--json']);
    expect(r.code).toBe(0);
    const { body } = payload<{
      reach: {
        machines: Array<{
          exhaustive: boolean;
          boundHit: string;
          suppressed: boolean;
          qualification: string;
          states: { unreachable: unknown[] };
          transitions: { dead: unknown[] };
        }>;
        diagnostics: Array<{ code: string; message: string }>;
      };
    }>(r);
    const fm = body.reach.machines[0];
    expect(fm.boundHit).toBe('configs');
    expect(fm.exhaustive).toBe(false);
    expect(fm.suppressed).toBe(true);
    expect(fm.states.unreachable).toEqual([]);
    expect(fm.transitions.dead).toEqual([]);
    expect(fm.qualification).toContain('lower bounds');
    const bound = body.reach.diagnostics.find((d) => d.code === 'verification/bound-exhausted');
    expect(bound!.message).toContain('NOT reported as findings');
    expect(body.reach.diagnostics.some((d) => d.code === 'verification/unreachable-state')).toBe(
      false,
    );
  }, 90_000);

  it('reach withholds every absence over a guard it could not evaluate, and says why', async () => {
    // The defect at the surface a person uses. `GuardProbe::Ctrl` never values
    // `mode`, so `if mode == 3` decides nothing — and this command used to print
    // `exhaustive` beside three absence findings about it. The two machines
    // below it in the same file are the controls: `= 4` is a guard that is
    // genuinely false and keeps every finding, `= 3` fires.
    const probe = resolve(process.cwd(), `${FIXV}/models/guard-undetermined.sysml`);
    const r = await run(['reach', probe]);
    // A warning does not move a report command's exit code.
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('3 state machine(s), 2 walked to exhaustion');
    expect(r.stdout).toContain('verification/guard-undetermined');
    expect(r.stdout).toContain('undecided    idle -> hazard — guard `mode == 3`: no value for mode');
    expect(r.stdout).toContain(
      'the unreachable, dead and no-way-out lists are WITHHELD: a guard this walk could not evaluate is not a guard that is false',
    );
    // The undecided machine is never called exhaustive, and nothing is claimed
    // absent about it.
    const ctrl = r.stdout.slice(
      r.stdout.indexOf('GuardProbe::Ctrl::Modes'),
      r.stdout.indexOf('GuardProbe::Decided::Modes'),
    );
    expect(ctrl).toContain('undetermined under {maxConfigs 10000');
    expect(ctrl).not.toContain('exhaustive');
    expect(ctrl).not.toContain('unreachable  ');
    expect(ctrl).not.toContain('no way out   ');
    // The control: the machine that DID decide its guard still says everything.
    expect(r.stdout).toContain('unreachable  GuardProbe::Decided::Modes::hazard');
    expect(r.stdout).toContain('no way out   GuardProbe::Decided::Modes::idle');
    // And the words this command may never print, whatever it withheld.
    expect(r.stdout).not.toMatch(/\bproved\b|\bverified\b|\bdeadlock-free\b/);
  }, 90_000);

  it('reach walks a succession between two states, and counts it', async () => {
    // THE DEFECT AT THE SURFACE A PERSON USES. `SuccMix::Ctrl::Modes` writes
    // `first active then done;` in plain sight beside a `transition`, and this
    // command used to print `exhaustive`, `1 of 1 transition(s) fired`, `done`
    // unreachable and `active` with no way out — two absence claims about an
    // edge the walk did not follow. Both spellings are one relation now.
    const mixed = resolve(process.cwd(), `${FIXV}/models/succession-mixed.sysml`);
    const r = await run(['reach', mixed]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('2 state machine(s), 2 walked to exhaustion');
    const ctrl = r.stdout.slice(
      r.stdout.indexOf('SuccMix::Ctrl::Modes'),
      r.stdout.indexOf('SuccMix::Loop::Modes'),
    );
    expect(ctrl).toContain('3 of 3 state(s) reachable; 2 of 2 transition(s) fired, 0 dead');
    expect(ctrl, 'a state behind a succession is not an absent state').not.toContain(
      'unreachable  ',
    );
    // `done` really has no way out and is not marked final: the row that
    // survives is the one the whole graph supports, and `active`'s is gone.
    expect(r.stdout).toContain('no way out   SuccMix::Ctrl::Modes::done');
    expect(r.stdout).not.toContain('no way out   SuccMix::Ctrl::Modes::active');
    expect(r.stdout).not.toMatch(/\bproved\b|\bverified\b|\bdeadlock-free\b/);
  }, 90_000);

  it('reach --json publishes the producer census: every edge walked or refused', async () => {
    // The durable half. Four readers found four ways the retained relation
    // differed from the machine; the census is the fifth found by a test
    // instead — every edge under the machine lands in a bucket, and the
    // `unaccounted` bucket refuses the machine rather than shrinking a list.
    const mixed = resolve(process.cwd(), `${FIXV}/models/succession-mixed.sysml`);
    const r = await run(['reach', mixed, '--json']);
    expect(r.code).toBe(0);
    const { body } = payload<{
      reach: {
        machines: Array<{
          machine: { qualifiedName: string };
          transitions: { total: number; fired: number };
          census: {
            total: number;
            counts: Record<string, number>;
            rows: Array<{ eClass: string; account: string; reason: string }>;
            unaccounted: unknown[];
          };
        }>;
      };
    }>(r);
    const ctrl = body.reach.machines.find(
      (m) => m.machine.qualifiedName === 'SuccMix::Ctrl::Modes',
    )!;
    expect(ctrl.census.total).toBe(2);
    expect(ctrl.census.unaccounted).toEqual([]);
    expect(ctrl.census.counts.walked).toBe(2);
    // The census and the published transition total are the same fact read two
    // ways: an edge that is walked is an edge the `dead` list is read against.
    expect(ctrl.transitions.total).toBe(ctrl.census.counts.walked);
    expect(ctrl.census.rows.map((row) => row.eClass).sort()).toEqual([
      'Succession',
      'TransitionUsage',
    ]);
    for (const row of ctrl.census.rows) expect(row.reason.length).toBeGreaterThan(20);
  }, 90_000);

  it('reach says a purely succession-wired file declares no machine, and claims nothing', async () => {
    // The message this fix must not quietly replace. `stateMachinesIn` reads
    // "owns a TransitionUsage", so this file has no machine of this tool's —
    // and saying so is an answer about what was looked for, not an absence
    // claim about a graph.
    const only = resolve(process.cwd(), `${FIXV}/models/succession-only.sysml`);
    const r = await run(['reach', only]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('0 state machine(s), 0 walked to exhaustion');
    expect(r.stdout).toContain(
      'this file declares no element that owns a transition, so there is no configuration graph to walk',
    );
    // `0 walked to exhaustion` is the header's own count; what must not appear
    // is a walk that called ITSELF exhaustive, and any absence under it.
    expect(r.stdout).not.toContain('exhaustive under');
    expect(r.stdout).not.toContain('unreachable  ');
    expect(r.stdout).not.toContain('no way out   ');
  }, 90_000);

  it('check-behaviour will not pass a property over a guard it could not evaluate', async () => {
    // THE SAME DEFECT ONE LANE OVER, and the worse half of it: `reach`
    // withholding its lists while this command printed `pass`, `exhaustive` and
    // exit 0 over the SAME machine in the SAME file made the tool contradict
    // itself, and a bare `pass` is the half somebody acts on. Both commands now
    // read the fifth condition off one walk result.
    const probe = resolve(process.cwd(), `${FIXV}/models/guard-undetermined.sysml`);
    const pattern = 'pattern=absence, scope=globally, p=state hazard';
    const undecided = await run([
      'check-behaviour',
      probe,
      '--element',
      'GuardProbe::Ctrl::Modes',
      '--pattern',
      pattern,
    ]);
    // Inconclusive is exit 2 by the lane's contract, and no flag lowers this
    // one: `--allow-inconclusive` is scoped to `verification/timeout` and
    // `verification/unsupported-construct`.
    expect(undecided.code).toBe(2);
    expect(undecided.stdout).toContain('0 pass, 0 fail, 0 vacuous, 1 inconclusive');
    expect(undecided.stdout).toContain('verification/guard-undetermined');
    expect(undecided.stdout).toContain('undetermined under {maxConfigs 10000');
    expect(undecided.stdout).toContain('NOT a pass');
    // The verdict block must not carry the promise it declined to make.
    const verdict = undecided.stdout.slice(
      0,
      undecided.stdout.indexOf('semantic profile'),
    );
    expect(verdict).not.toContain('exhaustive');
    expect(verdict).not.toMatch(/\bPASS\b/);
    expect(undecided.stdout).not.toMatch(/\bproved\b|\bverified\b|\bdeadlock-free\b/);

    // THE CONTROL, in the same file: `mode = 4` decides the guard false, so
    // `hazard` really is never entered and the pass is earned. A fix that
    // withheld here would have replaced a wrong claim with silence.
    const decided = await run([
      'check-behaviour',
      probe,
      '--element',
      'GuardProbe::Decided::Modes',
      '--pattern',
      pattern,
    ]);
    expect(decided.code).toBe(0);
    expect(decided.stdout).toContain('1 pass, 0 fail, 0 vacuous, 0 inconclusive');
    expect(decided.stdout).toContain('exhaustive under {maxConfigs 10000');
  }, 90_000);

  it('reach reports a file with no machine at all, and exits 0 doing it', async () => {
    // NOT a usage error. Nothing was misused and nothing failed to load: the
    // file simply declares no machine, which is a fact about the model and the
    // report's answer to the question. `reach` carries `exitContract: 'report'`
    // and two of the shipped examples are this shape, so exiting 2 would break
    // a `set -e` walk over a directory of models on files that are fine.
    const noMachine = resolve(process.cwd(), 'examples/uav-isr-verification.sysml');
    const r = await run(['reach', noMachine]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('0 state machine(s)');
    expect(r.stdout).toContain('declares no element that owns a transition');

    const j = await run(['reach', noMachine, '--json']);
    expect(j.code).toBe(0);
    const { body } = payload<{ reach: { machines: unknown[]; totals: { machines: number } } }>(j);
    expect(body.reach.machines).toEqual([]);
    expect(body.reach.totals.machines).toBe(0);
  }, 90_000);

  it('reach refuses a --max-configs that is not a bound, and a REF that holds no machine', async () => {
    const bad = await run(['reach', UAV, '--max-configs', 'lots']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('--max-configs');

    const noMachine = await run(['reach', UAV, '--element', 'EnduranceRequirement']);
    expect(noMachine.code).toBe(2);
    expect(noMachine.stderr).toContain('no state machine');
  }, 90_000);

  it('check-behaviour refutes a property on FlightModes, with the witness the simulator hides', async () => {
    // THE FINDING ON THIS MACHINE, from the other side. `reach` says two
    // completion transitions are enabled at `autonomous` and the simulator
    // takes the first, so `failsafe` is never entered in simulation. Here the
    // same fact is a REFUTATION: the model admits a run that reaches it, and
    // the witness is that run.
    const r = spawnCli([
      'check-behaviour',
      UAV,
      '--element',
      'FlightModes',
      '--pattern',
      'pattern=absence, scope=globally, p=state failsafe',
    ]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('FAIL');
    expect(r.stdout).toContain('witness — a run this semantics admits');
    expect(r.stdout).toContain('failsafe');
    expect(r.stdout).toContain('verification/refuted');
    // The bound every figure holds under, and the words this command may never
    // print whatever it found.
    expect(r.stdout).toContain('exhaustive under {maxConfigs 10000');
    expect(r.stdout).not.toMatch(/\bproved\b|\bverified\b|\bdeadlock-free\b/);
  }, 90_000);

  it('check-behaviour --json publishes under `behaviour`, with a verdict beside it', async () => {
    const r = await run([
      'check-behaviour',
      UAV,
      '--element',
      'FlightModes',
      '--pattern',
      'pattern=absence, scope=globally, p=state standby',
      '--json',
    ]);
    expect(r.code).toBe(1);
    const { keys, body } = payload<{
      verdict: { passed: number; failed: number; vacuous: number; inconclusive: number; exitCode: number };
      behaviour: {
        machine: { name: string };
        properties: Array<{
          claim: string;
          code: string | null;
          patternClass: string;
          exhaustive: boolean;
          sentence: string;
          witness: Array<{ index: number; leaf: { name: string }; holds: string[] }>;
        }>;
        profile: Array<{ field: string }>;
        counts: { passed: number; failed: number };
        exitCode: number;
      };
    }>(r);
    expect(keys).toEqual(['behaviour', 'file', 'ok', 'verdict']);
    // The verdict block and the process status agree, which is the one thing an
    // automation cannot recover from if they do not.
    expect(body.verdict.exitCode).toBe(1);
    expect(body.verdict).toMatchObject({ passed: 0, failed: 1, vacuous: 0, inconclusive: 0 });
    expect(body.behaviour.machine.name).toBe('FlightModes');
    const p = body.behaviour.properties[0];
    expect(p.claim).toBe('fail');
    expect(p.code).toBe('verification/refuted');
    expect(p.patternClass).toBe('safety');
    // `standby` is the OPENING configuration, so the bad prefix is one step long.
    expect(p.witness.map((w) => w.leaf.name)).toEqual(['standby']);
    expect(p.witness[0].holds).toEqual(['p']);
    // Every verdict carries the reading it holds under (plan §3.8).
    expect(body.behaviour.profile.map((f) => f.field)).toEqual([
      'run-to-completion',
      'priority',
      'history',
      'regions',
      'deferred events',
      'time',
    ]);
  }, 90_000);

  it('check-behaviour never passes a liveness pattern, and says why', async () => {
    const r = await run([
      'check-behaviour',
      UAV,
      '--element',
      'FlightModes',
      '--pattern',
      'pattern=response, scope=globally, p=state standby, s=state failsafe',
    ]);
    // Inconclusive ⇒ exit 2, on a machine where a bad-prefix search finds
    // nothing at all — which is exactly when a naive engine would print a pass.
    expect(r.code).toBe(2);
    expect(r.stdout).toContain('INCONCLUSIVE');
    expect(r.stdout).toContain('liveness not checked in-process');
    expect(r.stdout).not.toContain('PASS');
  }, 90_000);

  it('check-behaviour exits 2 on a vacuity, with --strict-vacuity and without it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sysprose-behaviour-'));
    const file = join(dir, 'vacuous.sysml');
    // `stuck` is declared and nothing reaches it, so "absence of `manual` after
    // `stuck`" is true of this machine for a reason that has nothing to do with
    // it. Carried in the FILE, as §7.27 metadata, rather than given on the
    // command line — the carrier is the door this command is meant to be used
    // through.
    writeFileSync(
      file,
      `package Modes {
    state def M {
        @SysproseVerification::PropertyPattern {
            attribute pattern = "absence";
            attribute scope = "after";
            attribute p = "state manual";
            attribute q = "state stuck";
        }
        state standby;
        state manual;
        state stuck;
        transition standby -> manual;
        transition manual -> standby;
    }
}
`,
    );
    try {
      const plain = await run(['check-behaviour', file, '--element', 'M']);
      const strict = await run(['check-behaviour', file, '--element', 'M', '--strict-vacuity']);
      // BOTH SPELLINGS, so the flag cannot quietly acquire exit semantics §2
      // does not give it: it raises the row to an error and changes nothing else.
      expect(plain.code).toBe(2);
      expect(strict.code).toBe(2);
      expect(plain.stdout).toContain('VACUOUS');
      expect(strict.stdout).toContain('VACUOUS');
      expect(plain.stdout).not.toContain('verification/vacuous-property');
      expect(strict.stdout).toContain('error verification/vacuous-property');
      expect(strict.stdout).toContain('changes no exit code');
      // And the property was read off the carrier, not invented.
      expect(plain.stdout).toContain('@PropertyPattern on Modes::M');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('check-behaviour exits 2 on a pattern outside the catalogue, and on a missing --element', async () => {
    const unknown = await run([
      'check-behaviour',
      UAV,
      '--element',
      'FlightModes',
      '--pattern',
      'pattern=eventually, scope=globally, p=state failsafe',
    ]);
    expect(unknown.code).toBe(2);
    expect(unknown.stdout).toContain('verification/malformed-property');
    expect(unknown.stdout).toContain('not a pattern in the catalogue');

    // `--element` has no default, and the refusal says why rather than
    // reporting on every machine in the file.
    const noElement = await run(['check-behaviour', UAV]);
    expect(noElement.code).toBe(2);
    expect(noElement.stderr).toContain('--element REF is required');

    // A reference that holds no machine is refused BY NAME, the same way
    // `reach --element` refuses one.
    const noMachine = await run(['check-behaviour', UAV, '--element', 'EnduranceRequirement']);
    expect(noMachine.code).toBe(2);
    expect(noMachine.stderr).toContain('no state machine');

    // And a machine that states nothing to decide is exit 2, not exit 0: a run
    // that checked nothing has not passed.
    const nothing = await run(['check-behaviour', UAV, '--element', 'FlightModes']);
    expect(nothing.code).toBe(2);
    expect(nothing.stdout).toContain('states no property');

    // A `--pattern` WHOSE VALUE EXPANDED TO NOTHING — the CI line whose shell
    // variable was empty. It is a property nobody could read, not a flag nobody
    // gave: dropped, the run would report on the carriers alone and look like a
    // clean sweep. The row it lands as says which of the reader's properties
    // was not checked.
    const blank = await run(['check-behaviour', UAV, '--element', 'FlightModes', '--pattern', '']);
    expect(blank.code).toBe(2);
    expect(blank.stdout).toContain('verification/malformed-property');
    expect(blank.stdout).toContain('no fields at all');
    expect(blank.stdout).not.toContain('states no property');
  }, 210_000);

  it('--no-library skips binding and still reports the file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sysprose-cli-'));
    const file = join(dir, 'nolib.sysml');
    writeFileSync(file, 'package P {\n    part def A;\n    part a : A;\n}\n');
    try {
      const r = await run(['stats', file, '--no-library', '--json']);
      expect(r.code).toBe(0);
      const { body } = payload<{ stats: { libraryElements: number; totalElements: number } }>(r);
      expect(body.stats.libraryElements).toBe(0);
      expect(body.stats.totalElements).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  /* ── the bridge: the function and the program are the same command ─────── */

  /**
   * THE ONE PIECE OF MUTABLE STATE THESE CASES SHARE, AND THE GUARD ON IT.
   *
   * The library JSON is shared read-only and every run builds its own `Model`,
   * so the models are not the hazard. The solver is: `src/semantics/smt/
   * z3-bridge.ts` caches ONE `Z3Context` for the life of the process, on
   * purpose — initialising the WASM module costs ~340 ms and every case here
   * would pay it — and a context accumulates whatever was asserted into it. A
   * witness is a point the solver CHOSE and an unsat core is a subset it chose,
   * so both can legitimately move with what the context solved before, and
   * measured, they do: between a fresh process and a warm one a `consistency`
   * witness flipped sign, its core came back the other way round, and a
   * `fault-tree` witness field read 660.5 against 661.
   *
   * That is a property of the solver rather than of this file, and no case here
   * asserts a solver-chosen VALUE. But it makes the ORDER of the cases in this
   * file load-bearing, which nothing else would notice: a future case that
   * asserted a witness would pass where it was written and fail when a case was
   * inserted above it. So the constraint is stated as a case. Two subcommands
   * whose text carries a solver choice are run twice in a row, in this process,
   * and required to print the same bytes both times. It is green today; if it
   * ever is not, the answer is not to reorder the file — it is that a rendering
   * this tool publishes is not reproducible, and the encoder has to canonicalise
   * what it prints rather than echo what z3 returned.
   */
  it('a report that carries a solver choice prints the same bytes the second time in one process', async () => {
    for (const argv of [
      ['consistency', `${FIXV}/models/consistency-conflict.sysml`],
      ['fault-tree', resolve(process.cwd(), 'examples/uav-power-budget.sysml')],
    ]) {
      const first = await run(argv);
      const second = await run(argv);
      expect(second.stdout, `a warmed solver context moved this report — ${argv[0]}`).toBe(
        first.stdout,
      );
      expect(second.stderr, `stderr moved on the second call — ${argv[0]}`).toBe(first.stderr);
      expect(second.code, `the exit code moved on the second call — ${argv[0]}`).toBe(first.code);
      // Worth nothing over a run that decided nothing: both of these are
      // findings, and a finding is what carries the witness.
      expect(first.code, `${argv[0]} stopped reporting a finding here`).toBe(1);
    }
  }, 300_000);

  /**
   * THE CASE THAT MAKES THE SPLIT HONEST.
   *
   * Every `run(…)` case above asserts what the command prints while calling
   * `main` on this process. That is only worth something if calling `main` and
   * running the binary produce the same run — so here the same argv goes both
   * ways, for a sample that covers EVERY subcommand (the coverage is asserted,
   * not eyeballed: a twenty-third subcommand fails this case until it has a row
   * here), and the two are required to agree byte for byte on stdout, on stderr
   * and on the number.
   *
   * What it would catch: output that depends on how the module was entered
   * (`process.argv[1]`, `import.meta`, a stream that is a TTY on one path), a
   * subcommand whose dispatch arm only exists on the script path, a report that
   * carries state from an earlier run in the same process — this case runs LAST,
   * after every other in-process case in this file, against a process that
   * starts clean, so a model or a cache leaking between runs shows up here as a
   * diff. Without it the split is a coverage loss dressed as a speed win.
   *
   * The rows are chosen to be deterministic and to span the exit codes as well
   * as the subcommands: a report (0), a refutation (1), a usage refusal (2) and
   * an absent solver (2).
   *
   * TWO THINGS CANNOT BE COMPARED BYTE FOR BYTE, and both are properties of
   * what is being run rather than of how it was entered.
   *
   * The first is anything z3 CHOSE. A witness is *a* point and an unsat core is
   * *a* subset; neither is canonical, and both move with what the solver's
   * context solved before them — measured here, a `consistency` witness went
   * from `cruisePower = 1` in a fresh process to `-1` in one that had already
   * run two proofs, its conflicting subset came back in the other order, and a
   * `fault-tree` witness field read 660.5 against 661. Since the whole point of
   * this file's in-process cases is that they SHARE a process, a row whose text
   * embeds such a choice would fail here for a reason this case is not about.
   * Those rows therefore ask their question with `SYSPROSE_NO_Z3` set, where
   * every byte of the run is this tool's own. That exemption is only affordable
   * because each of the two SUBCOMMANDS it applies to keeps a spawned case with
   * the solver ON — `consistency exits 1 on a requirement set nothing can
   * satisfy` and `fault-tree names the single point of failure` — so the
   * rendering these
   * rows cannot compare still crosses a process boundary somewhere in this
   * file. Membership, not order, is what those two cases assert, which is what
   * lets them live with a core the solver may hand back either way round. A
   * third subcommand whose text embedded a solver choice could NOT simply be
   * switched off here; it would need a spawned case of its own first.
   *
   * The second is a `--json` payload,
   * because element ids are fresh UUIDs on every load (the plan's §1.1 defect
   * D3) and two loads of one file therefore never write the same bytes — in the
   * same process either. Measured here: with the 36-character ids blanked, two
   * loads agree exactly, for every subcommand's payload. So the `--json` rows
   * are compared with the ids blanked and are marked as such, and every row that
   * is compared strictly is a rendering that carries no id.
   */
  it('the same argv, called and spawned, prints the same bytes and the same code', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sysprose-bridge-'));
    try {
      // `evidence-attach` needs records to attach, and both invocations must
      // read the SAME ones: a record carries the moment it was made.
      const model = join(dir, 'uav.sysml');
      writeFileSync(model, readFileSync(UAV, 'utf8'));
      const records = join(dir, 'evidence.json');
      expect((await run(['verify', model, '--engine', 'literal', '--record', records])).code).toBe(0);

      const BUDGET = resolve(process.cwd(), 'examples/uav-power-budget.sysml');
      const BEHAVIOUR = ['--element', 'FlightModes', '--pattern', 'pattern=absence, scope=globally, p=state failsafe'];
      /**
       * One row: the argv, and how to read it.
       *
       * The subcommand is NOT a field. It was, and a hand-typed label is
       * exactly the wrong thing to key a coverage claim on: a row labelled
       * `consistency` whose argv ran `stats` would satisfy the check below and
       * the byte comparison both, leaving "every subcommand is bridged" true
       * only of the labels. It is read off `argv[0]`, which is what ran.
       */
      interface Row {
        argv: string[];
        env?: Record<string, string>;
        /** Compare with element ids blanked — for `--json` only; see above. */
        idBlind?: boolean;
      }
      const sample: Row[] = [
        { argv: ['stats', UAV] },
        { argv: ['elements', UAV] },
        { argv: ['requirements', UAV] },
        { argv: ['requirements', UAV, '--json'], idBlind: true },
        { argv: ['trace', UAV, '--relation', 'satisfy'] },
        { argv: ['connectivity', UAV] },
        { argv: ['where-used', UAV, '--element', 'AirVehicle', '--depth', '2'] },
        { argv: ['orphans', UAV] },
        { argv: ['prompts', UAV, '--element', 'AirVehicle'] },
        { argv: ['contracts', UAV] },
        { argv: ['obligations', UAV] },
        { argv: ['property-draft', UAV, '--element', 'MassRequirement'] },
        {
          argv: ['property-check', UAV, '--element', 'MassRequirement', '--clause', 'uav.mtow <= 25.0 [kg]'],
        },
        { argv: ['verify', UAV, '--engine', 'literal'] },
        // The SMT path, the payload an automation reads, and the tool-absent
        // path are three runs of one subcommand and all three are bridged: the
        // last is the one that must exit 2 identically both ways.
        { argv: ['verify', UAV, '--engine', 'auto'] },
        { argv: ['verify', UAV, '--engine', 'auto', '--json'], idBlind: true },
        { argv: ['verify', UAV, '--engine', 'smt'], env: NO_Z3 },
        // Solver-chosen text — see the note above: with z3 on, this model's
        // conflicting subset comes back in a different ORDER in a warm process
        // than in a fresh one. The z3-on rendering is pinned at the process
        // boundary by the spawned `consistency` case above.
        {
          argv: ['consistency', `${FIXV}/models/consistency-conflict.sysml`],
          env: NO_Z3,
        },
        { argv: ['refine', BUDGET] },
        {
          argv: ['bounds', `${FIXV}/models/bounds-uav.sysml`, '--measure', 'uav.mtow', '--sense', 'both'],
        },
        // A usage refusal, where the whole answer is on stderr.
        { argv: ['bounds', UAV] },
        // Solver-chosen text again: every cut set is printed with the witness
        // that confirmed it, and one field of that witness measured 660.5 in a
        // fresh process and 661 in a warm one. The solver-bearing rendering is
        // pinned at the process boundary by the spawned `fault-tree` case above.
        { argv: ['fault-tree', BUDGET], env: NO_Z3 },
        { argv: ['evidence-status', UAV] },
        { argv: ['evidence-attach', model, '--from', records] },
        { argv: ['evidence-detach', UAV] },
        { argv: ['reach', UAV] },
        { argv: ['check-behaviour', UAV, ...BEHAVIOUR] },
      ];

      // Every subcommand this tool ships, or this case is not the bridge it says
      // it is.
      expect([...new Set(sample.map((r) => r.argv[0]))].sort()).toEqual(
        COMMANDS.map((c) => c.name).sort(),
      );

      /** A fresh UUID per load is not a difference between the two runs. */
      const blank = (s: string, on: boolean): string =>
        on ? s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>') : s;

      const codes = new Set<number>();
      for (const { argv, env, idBlind = false } of sample) {
        const label = `${argv[0]}: ${argv.slice(1).join(' ')}${idBlind ? ' (ids blanked)' : ''}`;
        const called = await run(argv, env);
        const spawned = spawnCli(argv, undefined, env);
        expect(blank(spawned.stdout, idBlind), `stdout differs between the call and the run — ${label}`).toBe(
          blank(called.stdout, idBlind),
        );
        expect(blank(spawned.stderr, idBlind), `stderr differs between the call and the run — ${label}`).toBe(
          blank(called.stderr, idBlind),
        );
        expect(spawned.code, `exit code differs between the call and the run — ${label}`).toBe(
          called.code,
        );
        codes.add(spawned.code);
      }
      // The sample is worth nothing if every row is a clean report: the number
      // `main` returns has to be the number the process exits with for the
      // codes that MEAN something too.
      expect([...codes].sort()).toEqual([0, 1, 2]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 900_000);
});
