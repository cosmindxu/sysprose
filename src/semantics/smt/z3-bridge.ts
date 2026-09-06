/**
 * The z3 seam: one dynamic import, one place that says "no solver", and no
 * unbounded check anywhere.
 *
 * THE CHARTER OF THIS FILE, IN ONE LINE: **an absent solver is an ANSWER, not
 * an import error.** `z3-solver` is an OPTIONAL dependency — the WASM asset is
 * tens of megabytes, the browser cannot run it at all (§6 non-goal 9:
 * `SharedArrayBuffer` needs COOP/COEP headers GitHub Pages cannot set), and a
 * clone that skipped optional dependencies must still typecheck, build, and run
 * every suite. So the package is reached through a dynamic import behind a
 * variable specifier, its absence is reported as {@link Z3Absent} with a
 * sentence a person can act on, and NOTHING here throws because a package is
 * missing.
 *
 * Four rules this module exists to hold, each of which is a way the lane could
 * have gone quietly green:
 *
 *  - **`SYSPROSE_NO_Z3=1` forces the absent path.** The honest-absence route is
 *    the single most likely thing in this lane to rot into a silent green, and
 *    a machine that HAS z3 cannot exercise it by accident. The switch makes it
 *    testable here and runnable in CI (§5), and it is read on every call rather
 *    than once at module load, so a suite can set it around one case.
 *  - **Every check is bounded.** {@link Z3Backend.check} refuses a non-finite,
 *    zero or negative budget and defaults to {@link DEFAULT_TIMEOUT_MS}. z3
 *    answers `unknown` with `reasonUnknown() === 'timeout'` when the budget is
 *    spent, and that is reported as `unknown` WITH the bound — never retried
 *    with a weaker encoding, never rounded up to `unsat` (§6, "Nonlinearity").
 *  - **A script z3 REFUSES is an `error`, never an `unknown`.** z3 rejects a
 *    malformed script and a `(set-logic QF_LRA)` carrying nonlinear arithmetic
 *    by throwing out of `fromString`. Folding that into `unknown` would turn an
 *    ENCODER DEFECT into an ordinary inconclusive row that
 *    `--allow-inconclusive` may forgive. It is its own status, and the caller
 *    is told what z3 said.
 *  - **The seed is fixed.** `random_seed` is pinned to {@link RANDOM_SEED} on
 *    every solver, so a determinism failure in a suite is a real one and not a
 *    seed (§6, the worker-parallelism row).
 *
 * WHY SMT-LIB2 TEXT RATHER THAN THE `Context` OBJECT API. The encoder
 * ({@link ./encode}) builds a SCRIPT, and this bridge asserts it with
 * `Solver.fromString`. That keeps the encoder pure and free of any dependency
 * on a package that may not be installed — its whole suite runs with no solver
 * present — makes "two encodes of the same model are byte-equal" a statement
 * about an artefact a person can read, and makes the eventual
 * `export --format smt2` the same bytes the in-process solver saw rather than a
 * second rendering of them.
 *
 * The version is CAPTURED rather than assumed: `z3-solver`'s package version
 * and the z3 build it wraps are different numbers, and a verdict line that
 * names a solver has to name the one that ran.
 */

/** The per-check budget, in milliseconds. No check is ever unbounded. */
export const DEFAULT_TIMEOUT_MS = 5000;

/**
 * The fixed `random_seed`.
 *
 * Zero is not special to z3; what matters is that it does not move. A suite
 * that compares two runs — the same script twice, or the same suite under two
 * worker pools — is asserting determinism, and an unpinned seed would make that
 * assertion about luck.
 */
export const RANDOM_SEED = 0;

/** No backend, and the sentence saying why. Never an exception. */
export interface Z3Absent {
  readonly absent: true;
  /** What is missing and what the reader can do about it. */
  readonly reason: string;
  /** True when {@link SYSPROSE_NO_Z3} forced this, not a missing package. */
  readonly disabled: boolean;
}

/** A loaded solver, with everything a verdict line has to name. */
export interface Z3Backend {
  readonly absent: false;
  /** z3's own version string, e.g. `5.1.0`. Never empty. */
  readonly version: string;
  /** z3's long form, e.g. `Z3 5.1.0.0`. */
  readonly fullVersion: string;
  /** The seed every solver in this process is pinned to. */
  readonly seed: number;
  /** How long `init()` took, in ms — measured once, on the first load. */
  readonly initMs: number;
  /** Run one bounded check over an SMT-LIB2 script. */
  check(script: string, opts?: CheckOptions): Promise<CheckOutcome>;
}

/** What {@link loadZ3} answers: a backend, or an absence with a reason. */
export type Z3Load = Z3Backend | Z3Absent;

/** The environment switch that forces the absent path on a machine that has z3. */
export const SYSPROSE_NO_Z3 = 'SYSPROSE_NO_Z3';

/** How one check may be bounded and read. */
export interface CheckOptions {
  /** The budget in ms. Defaults to {@link DEFAULT_TIMEOUT_MS}; must be finite and positive. */
  timeoutMs?: number;
  /**
   * The symbols a `sat` witness should carry, in the caller's order.
   *
   * Omit it and every 0-arity constant in z3's model is returned, INCLUDING the
   * Boolean constants a `:named` assertion introduces. A caller that knows its
   * variables should say so; the encoder's script names them.
   */
  variables?: readonly string[];
}

/**
 * What one check came to.
 *
 * `error` is a fourth status on purpose — see the charter. It is never a
 * verdict about a model.
 */
export type CheckStatus = 'sat' | 'unsat' | 'unknown' | 'error';

/** One value of a `sat` witness, as z3 wrote it and as a number when it is one. */
export interface WitnessValue {
  /** The declared symbol — a qualified name, never an element id. */
  symbol: string;
  /** z3's own rendering, e.g. `(/ 11.0 4.0)`. The exact answer. */
  term: string;
  /**
   * The same value as a JS number, or `null` when it is not numeric.
   *
   * Lossy BY CONSTRUCTION — `(/ 1.0 3.0)` has no binary64 — which is why
   * {@link term} is kept beside it and is what an evidence record should carry.
   */
  value: number | boolean | null;
}

/** The result of one bounded check. */
export interface CheckOutcome {
  status: CheckStatus;
  /** z3's `reasonUnknown()`, or the message it refused the script with. `''` otherwise. */
  reason: string;
  /** True only for `unknown` whose reason is a spent budget. */
  timedOut: boolean;
  /** The budget the check ran under, in ms — printed beside every `unknown`. */
  timeoutMs: number;
  /** Wall clock for this check alone, excluding `init()`. */
  elapsedMs: number;
  /** The model, for `sat`. Empty otherwise. */
  witness: WitnessValue[];
  /** The `:named` labels of an UNSAT core, for `unsat`. Empty otherwise. */
  core: string[];
}

/**
 * Is the solver switched off by the environment, and what does that say?
 *
 * The reading matches `src/api/verification.ts`'s probe exactly — set,
 * non-empty and not `0` — because two readings of one switch is one switch too
 * many, and the CI job that asserts exit 2 under it (§5) must mean the same
 * thing as the suite that asserts an absent backend.
 */
export function z3Disabled(): boolean {
  if (typeof process === 'undefined') return false;
  const raw = process.env?.[SYSPROSE_NO_Z3];
  return raw !== undefined && raw !== '' && raw !== '0';
}

/**
 * The initialised module AND its one context, kept across calls.
 *
 * `init()` costs ~100 ms, which is the reason the module is cached. The CONTEXT
 * is cached for a different and sharper reason: every `z3.Context(…)` allocates
 * inside the WASM heap and nothing in the JS API releases it, so a context per
 * check grows the heap by roughly 9 MB every time — measured here as 185 MB
 * after init and 2 GB after 400 checks. The call counts this lane is being
 * built for (a fault tree's Σ C(n,k) checks, an explorer defaulting to 10 000
 * configurations, a differential gate over 81 fixtures) would exhaust memory
 * rather than answer. One context, a fresh `Solver` per check: the solver is
 * what carries the assertions, so no assertion outlives its script either way.
 */
let cached: { z3: Z3Api; ctx: Z3Context; initMs: number } | undefined;

/**
 * The slice of `z3-solver` this bridge uses.
 *
 * Declared structurally rather than imported: the package is optional, so a
 * `import type { … } from 'z3-solver'` would make `tsc` fail on a clone that
 * does not have it. Every member here is exercised by the suite, so a version
 * that moved the API would fail loudly rather than be typed into agreement.
 */
interface Z3Api {
  getVersionString(): string;
  getFullVersion(): string;
  setParam(name: string, value: string | number | boolean): void;
  Context(name: string): Z3Context;
}
interface Z3Context {
  Solver: new () => Z3Solver;
}
interface Z3Solver {
  set(key: string, value: string | number | boolean): void;
  fromString(script: string): void;
  check(): Promise<'sat' | 'unsat' | 'unknown'>;
  model(): Z3Model;
  unsatCore(): Iterable<{ toString(): string }>;
  reasonUnknown(): string;
}
interface Z3Model extends Iterable<Z3Decl> {
  get(decl: Z3Decl): { toString(): string };
}
interface Z3Decl {
  name(): { toString(): string };
}

/**
 * Load a z3 backend, or say why there is none.
 *
 * Never throws, never rejects. The two absences are told apart because they
 * mean different things to a reader: `SYSPROSE_NO_Z3=1` is a deliberate switch
 * (a CI job, a suite pinning the honest-absence path) and a missing package is
 * an installation a person can fix.
 */
export async function loadZ3(): Promise<Z3Load> {
  if (z3Disabled()) {
    return {
      absent: true,
      disabled: true,
      reason:
        `the solver is switched off by ${SYSPROSE_NO_Z3} in this environment; ` +
        'unset it to load `z3-solver`',
    };
  }
  if (typeof process === 'undefined') {
    // The browser, where §6 non-goal 9 says there is no solver at all: z3 WASM
    // needs `SharedArrayBuffer`, which needs COOP/COEP headers a static host
    // cannot set. The app's own affordance is "prove in the terminal".
    return {
      absent: true,
      disabled: false,
      reason:
        'there is no solver in the browser build (z3 WASM needs SharedArrayBuffer, i.e. COOP/COEP ' +
        'headers this deployment cannot set); run the proof in the terminal',
    };
  }
  if (!cached) {
    try {
      // The specifier is held in a variable and marked `@vite-ignore` so the
      // bundler neither resolves nor bundles a package the browser may not
      // have; `vite.config.ts` marks it external for the same reason.
      const spec = 'z3-solver';
      const mod = (await import(/* @vite-ignore */ spec)) as { init: () => Promise<Z3Api> };
      const t0 = now();
      const z3 = await mod.init();
      const initMs = now() - t0;
      // Process-wide, and set once: the per-solver `random_seed` below pins the
      // SMT core, this pins the modules that read the global namespace.
      z3.setParam('smt.random_seed', RANDOM_SEED);
      cached = { z3, ctx: z3.Context('sysprose'), initMs };
    } catch (err) {
      return {
        absent: true,
        disabled: false,
        reason:
          '`z3-solver` is not installed (it is an OPTIONAL dependency, and the WASM asset is tens ' +
          `of megabytes): ${messageOf(err)}. Run \`npm install z3-solver\` to install it, or use ` +
          '`--engine literal` for a point evaluation at the model’s values, which is not a proof',
      };
    }
  }

  const { z3, ctx, initMs } = cached;
  return {
    absent: false,
    version: z3.getVersionString(),
    fullVersion: z3.getFullVersion(),
    seed: RANDOM_SEED,
    initMs,
    check: (script, opts) => runCheck(ctx, script, opts),
  };
}

/**
 * Forget the initialised module, so the next {@link loadZ3} pays `init()` again.
 *
 * Exists for ONE reason: the init cost is a registered figure (§6), and a
 * measurement taken after another suite in the same worker already initialised
 * z3 would report zero. It is a test affordance and nothing else calls it.
 */
export function resetZ3Cache(): void {
  cached = undefined;
}

/**
 * One bounded check, with a fresh SOLVER so no assertion outlives its script.
 *
 * The solver is fresh; the context is not, and that asymmetry is the point —
 * see {@link cached}. Assertions live on the solver, so a new one per check is
 * the whole isolation this needs; a new context per check would only add ~9 MB
 * of WASM heap that is never given back.
 */
async function runCheck(
  ctx: Z3Context,
  script: string,
  opts: CheckOptions = {},
): Promise<CheckOutcome> {
  const timeoutMs = boundOf(opts.timeoutMs);
  const empty = { witness: [] as WitnessValue[], core: [] as string[], timeoutMs };
  const solver = new ctx.Solver();
  solver.set('timeout', timeoutMs);
  solver.set('random_seed', RANDOM_SEED);

  try {
    solver.fromString(script);
  } catch (err) {
    // The script itself was refused — a malformed term, an undeclared symbol,
    // or a `set-logic` the assertions do not fit. That is a defect in what this
    // tool produced, and it is reported as one.
    return { ...empty, status: 'error', reason: messageOf(err), timedOut: false, elapsedMs: 0 };
  }

  const t0 = now();
  let status: 'sat' | 'unsat' | 'unknown';
  try {
    status = await solver.check();
  } catch (err) {
    return {
      ...empty,
      status: 'error',
      reason: messageOf(err),
      timedOut: false,
      elapsedMs: now() - t0,
    };
  }
  const elapsedMs = now() - t0;

  if (status === 'sat') {
    return {
      ...empty,
      status,
      reason: '',
      timedOut: false,
      elapsedMs,
      witness: witnessOf(solver, opts.variables),
    };
  }
  if (status === 'unsat') {
    return { ...empty, status, reason: '', timedOut: false, elapsedMs, core: coreOf(solver) };
  }
  const reason = safe(() => solver.reasonUnknown(), 'unknown');
  return { ...empty, status, reason, timedOut: reason === 'timeout', elapsedMs };
}

/** The budget, refused rather than silently repaired when it is not one. */
function boundOf(ms: number | undefined): number {
  if (ms === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(
      `a check budget must be a finite positive number of milliseconds; got ${String(ms)}. ` +
        'No check in this lane is unbounded, so there is no spelling for "no timeout".',
    );
  }
  return Math.ceil(ms);
}

/** The model, as `symbol → value`, in the caller's order when it named one. */
function witnessOf(solver: Z3Solver, wanted: readonly string[] | undefined): WitnessValue[] {
  const found = new Map<string, string>();
  try {
    const model = solver.model();
    for (const decl of model) found.set(decl.name().toString(), model.get(decl).toString());
  } catch {
    return [];
  }
  const symbols = wanted ?? [...found.keys()].sort();
  const out: WitnessValue[] = [];
  for (const symbol of symbols) {
    const term = found.get(symbol);
    if (term === undefined) continue;
    out.push({ symbol, term, value: valueOf(term) });
  }
  return out;
}

/** The `:named` labels of the UNSAT core, in z3's order. */
function coreOf(solver: Z3Solver): string[] {
  try {
    return [...solver.unsatCore()].map((c) => stripPipes(c.toString()));
  } catch {
    return [];
  }
}

/** `|a::b|` → `a::b`. A quoted SMT symbol is the same symbol. */
function stripPipes(s: string): string {
  return s.startsWith('|') && s.endsWith('|') ? s.slice(1, -1) : s;
}

/**
 * z3's rendering of a value as a JS number or boolean, or `null`.
 *
 * z3 writes an exact rational (`(/ 11.0 4.0)`), a decimal, an integer, a
 * negation (`(- 3.0)`), or `true`/`false`. The division is where a value can
 * leave binary64, which is why the caller keeps the term beside the number.
 */
export function rationalToNumber(term: string): number | boolean | null {
  const t = term.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  const neg = /^\(-\s+([\s\S]+)\)$/.exec(t);
  if (neg) {
    const inner = rationalToNumber(neg[1]);
    return typeof inner === 'number' ? -inner : null;
  }
  const div = /^\(\/\s+([^\s()]+)\s+([^\s()]+)\)$/.exec(t);
  if (div) {
    const a = Number(div[1]);
    const b = Number(div[2]);
    return Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? a / b : null;
  }
  // A root of an irrational algebraic number prints as `(root-obj …)`, which
  // has no decimal reading at all: `null` is the honest answer.
  if (t.startsWith('(')) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** {@link rationalToNumber}, named for the field it fills. */
function valueOf(term: string): number | boolean | null {
  return rationalToNumber(term);
}

/** A monotonic-enough clock that works in Node and in a worker. */
function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** The message of a thrown thing, whatever it is. */
function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Call `fn`, or fall back — used where z3 may refuse a query about its own state. */
function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
