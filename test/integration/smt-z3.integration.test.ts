/**
 * The z3 seam: three pinned checks, a bounded one, an absent one, and the
 * packaging rules that keep the solver out of the browser.
 *
 * This is the only suite in the repository that loads `z3-solver`, and it is
 * written so that both of its worlds are real:
 *
 *  - **With the solver installed** (the machine this plan is being built on) it
 *    pins the three probe checks the plan measured before any of this existed —
 *    unsat, negation-unsat, and sat with a witness — plus the two properties a
 *    verdict later stands on: a check is BOUNDED (a hard nonlinear instance
 *    comes back `unknown` with `reasonUnknown() === 'timeout'`, it does not
 *    hang), and a script z3 REFUSES is an `error` rather than an `unknown` that
 *    `--allow-inconclusive` could forgive.
 *  - **With it absent** — `SYSPROSE_NO_Z3=1`, the switch the plan's §5 CI job
 *    uses, or a clone that skipped optional dependencies — `loadZ3()` answers
 *    with a reason and throws nothing. That path is asserted here rather than
 *    assumed, because it is the single most likely thing in this lane to rot
 *    into a silent green.
 *
 * `z3-solver` is an OPTIONAL dependency, so the solver cases are skipped (not
 * failed) where it is missing — and the skip is itself guarded: the absent
 * branch asserts a non-empty reason, so a suite that skipped everything still
 * asserted the honest-absence contract.
 *
 * **The init figure is measured separately from the checks** (§6): the plan
 * carries one number for "init plus three checks" and could not tell which half
 * it was. `resetZ3Cache()` exists for this case alone.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_TIMEOUT_MS,
  RANDOM_SEED,
  loadZ3,
  rationalToNumber,
  resetZ3Cache,
  z3Disabled,
  type Z3Backend,
} from '@semantics/smt/z3-bridge';
import { encodeRelation, encodeScript, notTerm } from '@semantics/smt/encode';
import { parseExpr } from '@semantics/expr';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

/** `mtow = 18.5 kg` under a 25 kg limit — the flagship shape, hand-encoded. */
const MTOW = '|UAV::uav::mtow|';
const AXIOM = `(= ${MTOW} (/ 37.0 2.0))`;
const GUARANTEE = `(<= ${MTOW} 25.0)`;

function script(assertions: Array<{ kind: 'axiom' | 'goal'; name: string; term: string }>): string {
  return encodeScript({
    variables: [
      {
        path: 'uav.mtow',
        qualifiedName: 'UAV::uav::mtow',
        sort: 'Real',
        factor: 1,
        offset: 0,
        free: false,
      },
    ],
    assertions,
    nonlinear: false,
  }).text;
}

/**
 * A hard nonlinear INTEGER instance: `x³ + y³ = z³` with `x, y, z ≥ 1`.
 *
 * Nonlinear integer arithmetic is undecidable, so z3 does not return — which is
 * precisely the point. A budget is the only thing between this and a hung gate.
 */
const HARD = [
  '(set-logic QF_NIA)',
  '(declare-fun x () Int)',
  '(declare-fun y () Int)',
  '(declare-fun z () Int)',
  '(assert (and (>= x 1) (>= y 1) (>= z 1)))',
  '(assert (= (+ (* x x x) (* y y y)) (* z z z)))',
].join('\n');

let backend: Z3Backend | undefined;
let absentReason = '';

/** Is the optional dependency actually on disk? */
const installed = existsSync(resolve(process.cwd(), 'node_modules/z3-solver/package.json'));

beforeAll(async () => {
  const loaded = await loadZ3();
  if (loaded.absent) absentReason = loaded.reason;
  else backend = loaded;
  // The one thing this file must never do is pass by doing nothing. Every
  // solver case below degrades to a SKIP when there is no backend, and a skip
  // that fires on a machine which HAS the package would turn twelve assertions
  // into vacuous green the moment `loadZ3` broke — a z3-solver major bump, an
  // `init()` that throws, a stray env var in CI. So the degradation is itself
  // guarded: where the package is installed and nothing switched it off, a
  // missing backend is a FAILURE, and the reason z3 gave is the message.
  if (!backend && installed && !z3Disabled()) {
    throw new Error(
      '`node_modules/z3-solver` is installed and SYSPROSE_NO_Z3 is unset, so `loadZ3()` must ' +
        `return a backend. It answered: ${absentReason}`,
    );
  }
}, 60_000);

/**
 * Skip a solver case where the optional dependency is not installed.
 *
 * `ctx.skip()` rather than an early `return`: a skipped case is reported as a
 * skip, so a run that decided nothing does not read as a run that passed.
 */
const withZ3 = (name: string, fn: (z3: Z3Backend) => Promise<void>, timeout = 30_000) =>
  it(
    name,
    async (ctx) => {
      if (!backend) {
        expect(absentReason.length, 'no backend and no reason either').toBeGreaterThan(20);
        ctx.skip();
        return;
      }
      await fn(backend);
    },
    timeout,
  );

describe('the three probe checks, re-pinned', () => {
  withZ3('unsat: an 18.5 kg mass cannot be 30 kg', async (z3) => {
    const r = await z3.check(
      script([
        { kind: 'axiom', name: 'UAV::uav::mtow', term: AXIOM },
        { kind: 'goal', name: 'R-UAV-002', term: `(>= ${MTOW} 30.0)` },
      ]),
    );
    expect(r.status).toBe('unsat');
    expect(r.core).toEqual(['axiom:UAV::uav::mtow', 'goal:R-UAV-002']);
  });

  withZ3('negation-unsat: the guarantee is PROVED under the axiom', async (z3) => {
    // This is the shape of a proof (§3.4 step 1): A ∧ ¬G unsat.
    const r = await z3.check(
      script([
        { kind: 'axiom', name: 'UAV::uav::mtow', term: AXIOM },
        { kind: 'goal', name: 'R-UAV-002', term: notTerm(GUARANTEE) },
      ]),
    );
    expect(r.status).toBe('unsat');
  });

  withZ3('sat with a witness: releasing the value admits a counterexample', async (z3) => {
    const r = await z3.check(
      script([{ kind: 'goal', name: 'R-UAV-002', term: notTerm(GUARANTEE) }]),
      { variables: ['UAV::uav::mtow'] },
    );
    expect(r.status).toBe('sat');
    expect(r.witness).toHaveLength(1);
    expect(r.witness[0].symbol).toBe('UAV::uav::mtow');
    // The witness must actually refute the guarantee, or the encoding is wrong
    // in the direction the plan's re-evaluation gate exists to catch.
    expect(typeof r.witness[0].value === 'number' && r.witness[0].value > 25).toBe(true);
  });

  withZ3('names the variables the caller asked for, and no assertion label', async (z3) => {
    const r = await z3.check(
      script([{ kind: 'goal', name: 'R-UAV-002', term: notTerm(GUARANTEE) }]),
      { variables: ['UAV::uav::mtow'] },
    );
    expect(r.witness.map((w) => w.symbol)).toEqual(['UAV::uav::mtow']);
  });
});

describe('every check is bounded, and an unknown says so', () => {
  withZ3('returns unknown on a hard nonlinear instance rather than hanging', async (z3) => {
    const started = Date.now();
    const r = await z3.check(HARD, { timeoutMs: 400 });
    const wall = Date.now() - started;
    expect(r.status).toBe('unknown');
    expect(r.timedOut).toBe(true);
    expect(r.reason).toBe('timeout');
    expect(r.timeoutMs).toBe(400);
    // Generous, because a loaded machine is allowed to be slow — the assertion
    // is that the budget is enforced at all, not how tightly.
    expect(wall, `a 400 ms budget took ${wall} ms`).toBeLessThan(20_000);
  });

  withZ3('refuses a budget that is not one, rather than running unbounded', async (z3) => {
    await expect(z3.check(script([]), { timeoutMs: 0 })).rejects.toThrow(/finite positive/);
    await expect(z3.check(script([]), { timeoutMs: Number.POSITIVE_INFINITY })).rejects.toThrow(
      /finite positive/,
    );
  });

  withZ3('defaults to the declared budget when the caller names none', async (z3) => {
    const r = await z3.check(script([{ kind: 'goal', name: 'R', term: GUARANTEE }]));
    expect(r.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });
});

describe('a script z3 refuses is an error, never an inconclusive', () => {
  withZ3('reports a malformed script as `error`, with z3’s own message', async (z3) => {
    const r = await z3.check('(declare-fun x () Real)\n(assert (bogus x))');
    expect(r.status).toBe('error');
    expect(r.reason).toContain('bogus');
    expect(r.witness).toEqual([]);
  });

  withZ3('reports a logic the assertions do not fit as `error`', async (z3) => {
    // The fragment claim in a verdict line is therefore one z3 CHECKED: a
    // `QF_LRA` script carrying a product of two variables is refused outright.
    const r = await z3.check(
      '(set-logic QF_LRA)\n(declare-fun x () Real)\n(declare-fun y () Real)\n(assert (> (* x y) 1.0))',
    );
    expect(r.status).toBe('error');
    expect(r.reason).toContain('nonlinear');
  });
});

/**
 * The cross-check the two suites were missing.
 *
 * The unit suite asserts what the encoder EMITS and never runs it; this file
 * asserted hand-written scripts and never encoded one. The gap between them is
 * exactly where a `set-logic` line that disagrees with its own assertions
 * lives: z3 refuses such a script outright and the bridge reports `error`,
 * which by its own charter means a defect in our output — so an encoder-built
 * script coming back `error` is a bug, in either half, that nothing else here
 * would see.
 */
describe('every script the ENCODER builds is one z3 accepts', () => {
  const V = (path: string, over: Record<string, unknown> = {}) => ({
    path,
    qualifiedName: `P::${path}`,
    sort: 'Real' as const,
    factor: 1,
    offset: 0,
    free: false,
    ...over,
  });

  const bodies: Array<[string, ReturnType<typeof V>[]]> = [
    // The plan's flagship, with the divisor PINNED — the ordinary no-`--free`
    // case, and the one a free-relative logic line gets wrong.
    ['endurance == capacity * fraction / cruisePower', [V('endurance', { free: true }), V('capacity'), V('fraction'), V('cruisePower')]],
    ['a * b >= 1.0', [V('a'), V('b')]],
    ['open / a >= 1.0', [V('open'), V('a')]],
    ['x ^ 3 <= y', [V('x'), V('y')]],
    ['x ^ -2 <= y', [V('x'), V('y')]],
    ['2.0 * z >= 1.0', [V('z')]],
    ['n <= x', [V('n', { sort: 'Int' }), V('x')]],
    ['(if p then x else y) >= 1.0', [V('p', { sort: 'Bool' }), V('x'), V('y')]],
  ];

  for (const [body, variables] of bodies) {
    withZ3(`z3 accepts the script for \`${body}\``, async (z3) => {
      const r = encodeRelation(parseExpr(body), variables);
      expect(r.ok, r.ok ? '' : JSON.stringify(r.refusal)).toBe(true);
      if (!r.ok) return;
      const built = encodeScript({
        variables,
        assertions: [
          { kind: 'goal', name: 'R', term: r.term },
          ...r.sideConditions.map((c, i) => ({ kind: 'side' as const, name: `guard-${i}`, term: c.term })),
        ],
        nonlinear: r.nonlinear,
        syntacticNonlinear: r.syntacticNonlinear,
      });
      const out = await z3.check(built.text);
      expect(out.status, `${built.logic}: ${out.reason}`).not.toBe('error');
      expect(['sat', 'unsat', 'unknown']).toContain(out.status);
    });
  }
});

describe('the backend names itself, and answers the same way twice', () => {
  withZ3('captures a non-empty version', async (z3) => {
    expect(z3.version.length).toBeGreaterThan(0);
    expect(z3.version).toMatch(/^\d+\.\d+/);
    expect(z3.fullVersion.length).toBeGreaterThan(z3.version.length);
    expect(z3.seed).toBe(RANDOM_SEED);
  });

  withZ3('gives the same answer and the same witness on a second run', async (z3) => {
    const s = script([{ kind: 'goal', name: 'R', term: notTerm(GUARANTEE) }]);
    const a = await z3.check(s, { variables: ['UAV::uav::mtow'] });
    const b = await z3.check(s, { variables: ['UAV::uav::mtow'] });
    expect(a.status).toBe(b.status);
    expect(a.witness).toEqual(b.witness);
  });
});

/**
 * The measurement §6 asks for, taken here rather than remembered.
 *
 * The plan carries "init plus three checks measured once at 343 ms" and could
 * not say which half that was. This splits them and prints both, so the figure
 * registered in the ledger is one this suite reproduces.
 */
describe('init is measured separately from the checks', () => {
  withZ3(
    'pays init once, and a check is a small fraction of it',
    async () => {
      resetZ3Cache();
      const t0 = performance.now();
      const loaded = await loadZ3();
      const initWall = performance.now() - t0;
      expect(loaded.absent).toBe(false);
      if (loaded.absent) return;

      const s = [
        script([
          { kind: 'axiom', name: 'UAV::uav::mtow', term: AXIOM },
          { kind: 'goal', name: 'R', term: `(>= ${MTOW} 30.0)` },
        ]),
        script([
          { kind: 'axiom', name: 'UAV::uav::mtow', term: AXIOM },
          { kind: 'goal', name: 'R', term: notTerm(GUARANTEE) },
        ]),
        script([{ kind: 'goal', name: 'R', term: notTerm(GUARANTEE) }]),
      ];
      const t1 = performance.now();
      for (const one of s) await loaded.check(one);
      const checksWall = performance.now() - t1;

      console.log(
        `[smt] z3 ${loaded.fullVersion}: init ${initWall.toFixed(0)} ms ` +
          `(reported ${loaded.initMs.toFixed(0)} ms), three checks ${checksWall.toFixed(0)} ms`,
      );
      expect(loaded.initMs).toBeGreaterThan(0);
      // Bounds a person would notice breaking, not a benchmark: the figure that
      // matters is the one printed above and registered in the ledger.
      expect(initWall, 'z3 init').toBeLessThan(30_000);
      expect(checksWall, 'three checks').toBeLessThan(10_000);
    },
    120_000,
  );
});

/**
 * The check loop has to survive the call counts this lane is being built for.
 *
 * `z3.Context(…)` allocates in the WASM heap and nothing in the JS API gives it
 * back, so a context per check grew the heap by ~9 MB EVERY TIME — 185 MB after
 * init, 2 GB after 400 checks. No case in either suite ran more than a handful,
 * so nothing noticed; a fault tree's Σ C(n,k) checks or the explorer's 10 000
 * configurations would have exhausted memory instead of answering. One context
 * lives beside the cached module and only the solver is fresh.
 */
describe('a long run of checks does not grow the heap without bound', () => {
  withZ3(
    'runs 200 checks inside a bounded working set',
    async (z3) => {
      const one = (k: number): string =>
        `(set-logic QF_LRA)\n(declare-fun x () Real)\n(assert (> x ${k}.0))\n(assert (< x ${k + 2}.0))`;
      // Warm up first: the baseline has to be taken after the WASM heap has
      // reached its steady size, or it measures init rather than the loop.
      for (let i = 0; i < 20; i += 1) await z3.check(one(i));
      const before = process.memoryUsage().rss;
      for (let i = 0; i < 200; i += 1) await z3.check(one(i));
      const grew = (process.memoryUsage().rss - before) / 1e6;
      // A context per check cost ~1800 MB over these 200; one context costs
      // tens. The bound is loose on purpose — it is a leak detector, not a
      // benchmark, and JS garbage the collector has not run on is allowed.
      expect(grew, `200 checks grew RSS by ${grew.toFixed(0)} MB`).toBeLessThan(400);
    },
    120_000,
  );
});

describe('the absent path is a first-class answer', () => {
  it('reports a reason, and throws nothing, under SYSPROSE_NO_Z3', async () => {
    const before = process.env.SYSPROSE_NO_Z3;
    process.env.SYSPROSE_NO_Z3 = '1';
    try {
      expect(z3Disabled()).toBe(true);
      const loaded = await loadZ3();
      expect(loaded.absent).toBe(true);
      if (!loaded.absent) return;
      expect(loaded.disabled).toBe(true);
      expect(loaded.reason).toContain('SYSPROSE_NO_Z3');
    } finally {
      if (before === undefined) delete process.env.SYSPROSE_NO_Z3;
      else process.env.SYSPROSE_NO_Z3 = before;
    }
  });

  it('reads the switch exactly as `src/api/verification.ts` does', () => {
    const before = process.env.SYSPROSE_NO_Z3;
    try {
      for (const [value, off] of [
        ['1', true],
        ['true', true],
        ['0', false],
        ['', false],
      ] as Array<[string, boolean]>) {
        process.env.SYSPROSE_NO_Z3 = value;
        expect(z3Disabled(), `SYSPROSE_NO_Z3=${JSON.stringify(value)}`).toBe(off);
      }
      delete process.env.SYSPROSE_NO_Z3;
      expect(z3Disabled()).toBe(false);
    } finally {
      if (before === undefined) delete process.env.SYSPROSE_NO_Z3;
      else process.env.SYSPROSE_NO_Z3 = before;
    }
  });

  it('reads z3’s own value renderings, including the ones that are not doubles', () => {
    expect(rationalToNumber('(/ 11.0 4.0)')).toBe(2.75);
    expect(rationalToNumber('(- 3.0)')).toBe(-3);
    expect(rationalToNumber('4')).toBe(4);
    expect(rationalToNumber('true')).toBe(true);
    // An algebraic number has no decimal reading, and `null` says so rather
    // than a rounded number a witness would then be printed with.
    expect(rationalToNumber('(root-obj (+ (^ x 2) (- 2)) 2)')).toBeNull();
  });
});

/**
 * The packaging rules, which no run-time assertion can reach.
 *
 * "The browser bundle does not carry the WASM" is a property of the config and
 * of how the import is written, and both are asserted as text — a build would
 * prove it too, but only on a machine where the optional dependency is present,
 * which is exactly the machine that cannot tell the difference.
 */
describe('the solver stays out of the browser build', () => {
  it('is an OPTIONAL dependency, never a plain one', () => {
    const pkg = JSON.parse(read('package.json')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    expect(pkg.optionalDependencies?.['z3-solver']).toBeDefined();
    expect(pkg.dependencies['z3-solver']).toBeUndefined();
    expect(pkg.devDependencies['z3-solver']).toBeUndefined();
  });

  it('is excluded by the bundler, in both the dev and the build path', () => {
    const config = read('vite.config.ts');
    expect(config).toMatch(/optimizeDeps:\s*\{\s*exclude:\s*\['z3-solver'\]\s*\}/);
    expect(config).toMatch(/external:\s*\['z3-solver'\]/);
  });

  it('is never imported statically anywhere in src/', () => {
    // A static `import … from 'z3-solver'` ANYWHERE in `src/` puts the package
    // into the module graph the bundler walks, whatever the config says — so
    // this walks the tree rather than the two files that happen to be new. The
    // bridge reaches it through a variable specifier; nothing else reaches it.
    const files = walk(resolve(process.cwd(), 'src'));
    expect(files.length, 'the walk found no sources at all').toBeGreaterThan(50);
    const mentions: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      if (!text.includes('z3-solver')) continue;
      mentions.push(file);
      // Anchored at the start of a line, so the bridge's own doc comment —
      // which QUOTES the import it refuses to write — is not a false positive.
      for (const forbidden of [
        /^\s*(?:import|export)\b[^\n]*\bfrom\s*['"]z3-solver['"]/m,
        /^\s*import\s*['"]z3-solver['"]/m,
        /\brequire\s*\(\s*['"]z3-solver['"]\s*\)/,
      ]) {
        expect(text, `${file} imports z3-solver statically (${String(forbidden)})`).not.toMatch(
          forbidden,
        );
      }
    }
    // …and the two places that name it at all do so behind a variable specifier.
    for (const file of mentions) {
      expect(readFileSync(file, 'utf8'), `${file} names z3-solver`).toContain(
        "const spec = 'z3-solver'",
      );
    }
    const bridge = read('src/semantics/smt/z3-bridge.ts');
    expect(bridge).toContain("const spec = 'z3-solver'");
    expect(bridge).toContain('@vite-ignore');
    expect(read('src/semantics/smt/encode.ts')).not.toContain('z3-solver');
  });

  it('fails the BUILD if a specifier ever survives into an emitted chunk', () => {
    // `external` alone points the wrong way for an import: it leaves a bare
    // `z3-solver` specifier in the chunk, which builds green and then breaks the
    // published page in a browser, silently. The guard is a build plugin, so
    // this asserts it is wired rather than re-running vite here.
    const config = read('vite.config.ts');
    expect(config).toContain('refuse-bundled-z3');
    expect(config).toMatch(/plugins:\s*\[[^\]]*refuseBundledZ3\(\)/);
    expect(config).toContain('generateBundle');
  });
});

/** Every `.ts`/`.tsx` file under a directory, generated code included. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}
