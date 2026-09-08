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
 * Each spawn pays ~3 s of tsx startup plus the library bind, so the timeouts
 * are generous and the cases are chosen, not exhaustive.
 */
import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
/** The L8 verdict corpus, whose models this level re-uses at the process boundary. */
const FIXV = resolve(process.cwd(), 'test/fixtures/verification');

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * `spawnSync`, not `execFileSync`: the latter returns only stdout on success,
 * so every assertion about stderr on an exit-0 run silently held against the
 * empty string — which is how a warning the command never printed looked like a
 * warning it correctly suppressed.
 */
function run(args: string[], input?: string, env?: Record<string, string>): Run {
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

/** `SYSPROSE_NO_Z3=1` — the switch the §5 CI job asserts exit 2 under. */
const NO_Z3 = { SYSPROSE_NO_Z3: '1' };

/** Parse a `--json` payload and hand back its top-level key set as well. */
function payload<T>(r: Run): { keys: string[]; body: T } {
  const body = JSON.parse(r.stdout) as T;
  return { keys: Object.keys(body as object).sort(), body };
}

describe('L7 — sysprose reporting command', () => {
  it('stats reports the model, not the bundled library', () => {
    const r = run(['stats', UAV]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('113 element(s)');
    expect(r.stdout).toContain('82 node(s)');
    // The library is visible as its own figure rather than folded into the total.
    expect(r.stdout).toMatch(/library elements\s+3\d{4}/);
  }, 90_000);

  it('--json emits {ok, file, <named payload>} and nothing else', () => {
    const r = run(['stats', UAV, '--json']);
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

  it('requirements reports 2 of 2 covered, not 2 of 26', () => {
    // The defect this command was blocked on: counting the bundled library's
    // requirements called a fully-covered model 7.7% covered.
    const r = run(['requirements', UAV, '--json']);
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

    const human = run(['requirements', UAV]);
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
  it('lists every kind by default, labels the ones the ratio leaves out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sysprose-kind-'));
    try {
      const file = join(dir, 'kinds.sysml');
      writeFileSync(file, KINDS_MODEL);
      const r = run(['requirements', file, '--json']);
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

      const human = run(['requirements', file]);
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
  it('requirements --kind shows one kind, and refuses a kind that is not one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sysprose-kind-'));
    try {
      const file = join(dir, 'kinds.sysml');
      writeFileSync(file, KINDS_MODEL);

      const prompt = run(['requirements', file, '--kind', 'prompt', '--json']);
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

      const req = run(['requirements', file, '--kind=requirement', '--json']);
      const only = payload<{ requirements: { rows: Array<{ name: string }> } }>(req);
      expect(only.body.requirements.rows.map((x) => x.name)).toEqual(['maxMass']);

      const human = run(['requirements', file, '--kind', 'prose']);
      expect(human.code).toBe(0);
      expect(human.stdout).toContain('showing 1 of 3 statement(s)');
      expect(human.stdout).toContain('note');
      expect(human.stdout).not.toContain('maxMass');
      // A listing of one kind must not be read as a listing of the model: a
      // `#prompt` on a part or a package is guidance this command never sees.
      expect(human.stdout).toContain('prompts --element');

      // An unknown kind is refused, not defaulted.
      const bad = run(['requirements', file, '--kind', 'notes']);
      expect(bad.code).toBe(2);
      expect(bad.stderr).toContain('unknown --kind');
      expect(bad.stderr).toContain('requirement, prose, prompt');

      // And refused BEFORE the file is read, which is the whole reason the
      // check is wired into `precheckArgs` and not left to the report. Only an
      // unreadable path can show the order: against a file that exists, a
      // post-load check would satisfy the case above just as well.
      const early = run(['requirements', join(dir, 'nope.sysml'), '--kind', 'notes']);
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
  it('prompts finds the guidance written on what an element is', () => {
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

      const r = run(['prompts', file, '--element', 'e', '--json']);
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

      const human = run(['prompts', file, '--element', 'e']);
      expect(human.code).toBe(0);
      expect(human.stdout).toContain('1 prompt(s) apply');
      expect(human.stdout).toContain('Check the fuel line');
      expect(human.stdout).toContain('Engine');

      // An element nothing was written about says so, rather than reporting a
      // prompt from somewhere else in the model.
      const none = run(['prompts', file, '--element', 'w']);
      expect(none.code).toBe(0);
      expect(none.stdout).toContain('0 prompt(s)');
      expect(none.stdout).not.toContain('fuel line');

      // The element is the question; without it there is nothing to answer.
      const bare = run(['prompts', file]);
      expect(bare.code).toBe(2);
      expect(bare.stderr).toContain('needs --element');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it('connectivity reports 15 ports, 9 connections and 14 connected', () => {
    // 0 connected (a filter with no lift) and 37 ports (no filter at all) are
    // the two wrong answers this figure has had.
    const r = run(['connectivity', UAV, '--json']);
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

    const human = run(['connectivity', UAV]);
    expect(human.stdout).toContain('15 port(s)');
    expect(human.stdout).toContain('14 connected');
    expect(human.stdout).toContain('antenna');
  }, 120_000);

  it('elements lists the reader\'s model, not the tool\'s re-derived copies', () => {
    const r = run(['elements', UAV, '--json']);
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
    const stats = run(['stats', UAV, '--json']);
    const st = payload<{ stats: { byMetaclass: Record<string, number> } }>(stats);
    expect(st.body.stats.byMetaclass.PortUsage).toBe(15);

    const human = run(['elements', UAV]);
    expect(human.stdout).toContain('80 element(s)');
    expect(human.stdout).toContain('14 re-derived element(s)');

    // `--include-library` is a REPORTING knob, distinct from `--no-library`
    // which changes the model. Written to a file rather than piped: the
    // library's rows are tens of thousands of lines.
    const dir = mkdtempSync(join(tmpdir(), 'sysprose-cli-'));
    try {
      const out = join(dir, 'elements.txt');
      const w = run(['elements', '-', '--include-library', '--out', out], 'package P { part def A; }\n');
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
    const r = run(['elements', '-', '--include-library', '--json'], 'package P { part def A; }\n');
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(1_000_000);
    const body = JSON.parse(r.stdout) as { ok: boolean; elements: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.elements.length).toBeGreaterThan(20_000);
  }, 180_000);

  it('trace names its axes and lists the links it found', () => {
    const r = run(['trace', UAV, '--json']);
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

    const human = run(['trace', UAV]);
    expect(human.stdout).toContain('2 link(s)');
    // The axes are printed, because a matrix whose rows are a guess is unreadable.
    expect(human.stdout).toContain('PartUsage');
    expect(human.stdout).toContain('RequirementDefinition');
    expect(human.stdout).toContain('uav');
  }, 120_000);

  it('every walk-based report prints the typings it cannot follow', () => {
    // The user-visible half of the omission counter, which nothing pinned: all
    // three figures could be hard-coded to 0 and the suite stayed green. They
    // are the whole point of the counter — a reader who sees "nothing
    // references it" beside a silent 0 has no way to tell an untyped feature
    // from a report that cannot see the type.
    //
    // The figures are measurements of `examples/uav-isr.sysml`: 13 attributes
    // are typed by an ISQ quantity kind, which the library binder deliberately
    // leaves without a `FeatureTyping`; three of them name `ISQ::MassValue`.
    const matrix = run([
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
    const matrixText = run([
      'trace', UAV, '--relation', 'satisfy',
      '--from', 'AttributeUsage', '--to', 'AttributeUsage',
    ]);
    expect(matrixText.stdout).toContain('13 declared type(s) this walk cannot follow');

    // Asked about a TYPE, the walk finds no edge — and says how many written
    // typings name it anyway.
    const used = run(['where-used', UAV, '--element', 'ISQBase::MassValue']);
    expect(used.code).toBe(0);
    expect(used.stdout).toContain('nothing references it');
    expect(used.stdout).toContain('3 declared type(s) this walk cannot follow');

    // And asked about one of those attributes, it counts its own.
    const prompts = run([
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
      const r = run(['trace', '-', '--relation', e.rel, '--json'], model);
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

  it('an axis override naming a metaclass the model has none of exits 2', () => {
    // The auto-derived axes refuse this shape; the manual override must too.
    // `--from PartUsages` (a plausible typo) otherwise reports 0 links over 0
    // rows and exits 0, which is indistinguishable from the honest answer.
    const r = run(['trace', UAV, '--from', 'PartUsages']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--from names a metaclass this model has none of');
    // The refusal says what the relation DOES link, so the reader can fix it.
    expect(r.stderr).toContain('PartUsage to RequirementDefinition');

    const ok = run(['trace', UAV, '--from', 'PartUsage', '--json']);
    expect(ok.code).toBe(0);
  }, 120_000);

  it('where-used walks as far as --depth says and stops', () => {
    const one = run(['where-used', UAV, '--element', 'AirVehicle', '--json']);
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

    const two = run(['where-used', UAV, '--element=AirVehicle', '--depth=2', '--json']);
    expect(two.code).toBe(0);
    const deep = payload<{ whereUsed: { impacted: unknown[]; truncated: boolean } }>(two);
    expect(deep.body.whereUsed.impacted).toHaveLength(5);
    expect(deep.body.whereUsed.truncated).toBe(false);

    const human = run(['where-used', UAV, '--element', 'AirVehicle', '--depth', '2']);
    expect(human.stdout).toContain('5 element(s)');
    expect(human.stdout).toContain('EnduranceRequirement');
  }, 180_000);

  it('an ambiguous element name exits 2 and lists the candidates the reader wrote', () => {
    // `powerIn` names 10 elements, 5 of them the tool's own usage-scoped
    // copies. Offering all 10 would ask the reader to choose between ids that
    // are not in their file.
    const r = run(['where-used', UAV, '--element', 'powerIn']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('ambiguous');
    expect(r.stderr).toContain('UAVSurveillanceSystem::FlightController::powerIn');
    const candidates = r.stderr.split('\n').filter((l) => l.includes('::powerIn'));
    expect(candidates).toHaveLength(5);
  }, 90_000);

  it('an element name that matches nothing exits 2', () => {
    const r = run(['where-used', UAV, '--element', 'NoSuchThing']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('no element');
  }, 90_000);

  it('orphans reports the two definitions the example never uses', () => {
    const r = run(['orphans', UAV, '--json']);
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

    const human = run(['orphans', UAV]);
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
      const named = run(['stats', odd]);
      expect(named.code).toBe(0);
      expect(named.stderr).toContain('import/wrong-extension');
      expect(named.stderr).toContain('1 warning(s)');
      // A warning is not a finding about the MODEL, so the report still stands.
      expect(named.stdout).toContain('4 element(s)');

      const piped = run(['stats', '-'], 'package P {\n    part def A;\n    part a : A;\n}\n');
      expect(piped.code).toBe(0);
      expect(piped.stderr).not.toContain('wrong-extension');
      expect(piped.stderr).toBe('');
      expect(piped.stdout).toContain('<stdin>');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('a model that does not parse exits 1 with a degraded banner and reports what parsed', () => {
    const r = run(['stats', `${FIX}/L2-extra-closing-brace/input.sysml`]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('degraded');
    // The report is still produced: what survived error recovery is usually
    // exactly what the reader wants to see.
    expect(r.stdout).toContain('2 element(s)');

    const j = run(['stats', `${FIX}/L2-extra-closing-brace/input.sysml`, '--json']);
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
    const r = run(['stats', '-'], '// nothing here\n');
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('no elements');
  }, 90_000);

  it('a file that did not parse is broken, not empty: exit 1 with the reason', () => {
    // The empty-model refusal used to be checked first, so a file that failed
    // to parse and salvaged nothing was answered `no elements … nothing to
    // report` with every diagnostic thrown away — a broken file reported as an
    // empty one, and the exit code (2, usage/IO) blaming the reader's command
    // line for the file's contents.
    const r = run(['stats', '-'], '#$%^&\n');
    expect(r.code).toBe(1);
    expect(r.stderr).not.toContain('no elements');
    expect(r.stderr).toContain('degraded');
    expect(r.stderr).toContain('parse/no-viable-alt');
    expect(r.stdout).toContain('0 element(s)');
  }, 90_000);

  it('rejects an unknown option, an unknown subcommand and a missing subcommand', () => {
    const opt = run(['stats', UAV, '--wat']);
    expect(opt.code).toBe(2);
    expect(opt.stderr).toContain('unknown option');

    const sub = run(['metrics', UAV]);
    expect(sub.code).toBe(2);
    expect(sub.stderr).toContain('unknown subcommand');

    const none = run([]);
    expect(none.code).toBe(2);
    expect(none.stderr).toContain('Usage');

    // One model per run: two files are two namespaces, and one report over
    // both would be a figure true of neither.
    const two = run(['stats', UAV, resolve(process.cwd(), 'examples/vehicle.sysml')]);
    expect(two.code).toBe(2);
    expect(two.stderr).toContain('expected one file');

    // An unknown relation is refused rather than defaulted to `satisfy`, which
    // would answer a question nobody asked.
    const rel = run(['trace', UAV, '--relation', 'nope']);
    expect(rel.code).toBe(2);
    expect(rel.stderr).toContain('unknown --relation');
  }, 180_000);

  it('rejects a flag whose value is missing, rather than reading it as NaN', () => {
    const r = run(['where-used', UAV, '--element', 'AirVehicle', '--depth']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('missing value');
  }, 90_000);

  it('rejects a reporting flag on a subcommand that cannot honour it', () => {
    // `--include-library` changes what is REPORTED, and only the element
    // listing can honour it: the analysis reports exclude the library by
    // construction and say so in their own `libraryExcluded` figure. Accepting
    // the flag and ignoring it would be the silent answer.
    const r = run(['stats', UAV, '--include-library']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown option');
    expect(r.stderr).toContain('stats');
  }, 90_000);

  it('exits 2 when the file cannot be read, and reports nothing', () => {
    const r = run(['stats', `${FIX}/does-not-exist.sysml`]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('cannot read');
  }, 90_000);

  it('prints help for the command and for one subcommand', () => {
    const top = run(['--help']);
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
    // reader that the contract above does not apply to these.
    expect(top.stdout).toContain(
      '`verify`, `consistency` and `refine` judge and have their own contract',
    );

    const sub = run(['where-used', '--help']);
    expect(sub.code).toBe(0);
    expect(sub.stdout).toContain('--depth');
  }, 120_000);

  it('--out writes the report and says where, instead of printing it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sysprose-cli-'));
    try {
      const out = join(dir, 'nested', 'stats.json');
      const r = run(['stats', UAV, '--json', '--out', out]);
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
      const r = run(['stats', UAV, '--out', dir]);
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
    const afterDoubleDash = run(['stats', UAV, '--', '-h']);
    expect(afterDoubleDash.code).toBe(2);
    expect(afterDoubleDash.stderr).toContain('expected one file');

    const asAValue = run(['where-used', UAV, '--element', '--help']);
    expect(asAValue.code).toBe(2);
    expect(asAValue.stderr).toContain('missing value for --element');
  }, 120_000);

  /* ── the verification lane: two report commands, no solver ────────────── */

  it('contracts inventories the two requirements of the shipped example', () => {
    const r = run(['contracts', UAV]);
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

  it('contracts --json publishes under `contracts`, beside ok and file', () => {
    const r = run(['contracts', UAV, '--json']);
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

  it('obligations reports two things to show over an axiom set of bindings', () => {
    const r = run(['obligations', UAV, '--json']);
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

  it('obligations --missing lists only what this lane would not decide', () => {
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
      const r = run(['obligations', file, '--missing']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('showing the 2 row(s) this lane would not decide');
      expect(r.stdout).toContain('(no constraint body)');
      expect(r.stdout).toContain('u.d >= u.dur');
      // The refused relation is LISTED with the gate that refused it, never
      // dropped: a relation missing from a worklist reads as one that holds.
      expect(r.stdout).toContain('dimension-clash');
      const json = run(['obligations', file, '--missing', '--json']);
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
   * The two rows §3.0 promises a CLI case each, at the process boundary.
   *
   * These are the two subcommands an agent meets first — drafting comes before
   * proving — and the whole value of both is that the sentence in the terminal
   * is the sentence the gates produced. A row whose dispatch arm was never
   * written prints help and exits 0, which is indistinguishable from a command
   * that ran and found nothing to say; every assertion below is one a missing
   * arm would fail.
   */
  it('property-draft prints the skeleton, the dictionary and the fields it cannot encode', () => {
    const r = run(['property-draft', UAV, '--element', 'MassRequirement']);
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

  it('property-draft --json publishes under `propertyDraft`, beside ok and file', () => {
    const r = run([
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

  it('property-check accepts a clause and says where it goes', () => {
    const r = run([
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

  it('property-check refuses a temporal field at gate 0, and a bare name at gate 2', () => {
    const temporal = run([
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

    const bare = run([
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

  it('property-check reports the gap rather than a pass when there is no solver', () => {
    const r = run(
      [
        'property-check',
        UAV,
        '--element',
        'MassRequirement',
        '--clause',
        'uav.mtow <= uav.mtow',
        '--json',
      ],
      undefined,
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

  it('property-draft carries the shipped authoring prompts, and both rows refuse a bad REF', () => {
    const prompts = run([
      'property-draft',
      resolve(process.cwd(), 'examples/contract-authoring-prompts.sysml'),
      '--element',
      'PayloadMassRequirement',
    ]);
    expect(prompts.code).toBe(0);
    expect(prompts.stdout).toContain('authoring guidance — 4 #prompt(s), verbatim');
    expect(prompts.stdout).toContain('Name the subject in every path a clause reads');

    // A REF naming something that states no contract is refused BY NAME, exit 2.
    const notARequirement = run(['property-draft', UAV, '--element', 'AirVehicle']);
    expect(notARequirement.code).toBe(2);
    expect(notARequirement.stderr).toContain('not a requirement or a case with an objective');

    // And `--clause` is the whole of the second command: a run without it is a
    // usage error raised before the model is even read.
    const noClause = run(['property-check', UAV, '--element', 'MassRequirement']);
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
  it('contracts tells a usage that inherits its clauses from a requirement with none', () => {
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
      const r = run(['contracts', file]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('no clause of its own: the clauses are on its definition P::MassLimit');
      expect(r.stdout).toContain('no formal clause: prose only, nothing to encode');
      expect(r.stdout).toContain('1 contract(s) carry no formal clause');
      const missing = run(['obligations', file, '--missing']);
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
  it('--element narrows the diagnostics and the exclusion census too', () => {
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
      const whole = run(['contracts', file]);
      expect(whole.stdout).toContain('verification/nonstandard-clause-location');
      expect(whole.stdout).toContain('1 statement(s) tagged prose or prompt left out');

      const scoped = run(['contracts', file, '--element', 'P::Scoped']);
      expect(scoped.code).toBe(0);
      expect(scoped.stdout).toContain('scoped to P::Scoped');
      expect(scoped.stdout).toContain('P::Scoped::Inner');
      expect(scoped.stdout).not.toContain('verification/');
      expect(scoped.stdout).toContain('0 statement(s) tagged prose or prompt left out');

      const obligations = run(['obligations', file, '--element', 'P::Scoped']);
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
  it('--element resolves a qualified name, a short id, and refuses an ambiguous one', () => {
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
      const byQualified = run(['contracts', file, '--element', 'P::Second', '--json']);
      expect(byQualified.code).toBe(0);
      const q = payload<{ contracts: { total: number; contracts: Array<{ shortId: string }> } }>(
        byQualified,
      );
      expect(q.body.contracts.total).toBe(1);
      expect(q.body.contracts.contracts[0].shortId).toBe('R2');

      const byShortId = run(['obligations', file, '--element', 'R1', '--json']);
      expect(byShortId.code).toBe(0);
      const sid = payload<{ obligations: { byRole: { obligation: number } } }>(byShortId);
      expect(sid.body.obligations.byRole.obligation).toBe(1);

      const ambiguous = run(['contracts', file, '--element', 'm']);
      expect(ambiguous.code).toBe(2);
      expect(ambiguous.stderr).toContain('is ambiguous');
      expect(ambiguous.stderr).toContain('P::Sys::m');
      expect(ambiguous.stderr).toContain('P::Other::m');

      // A reference into the bundled library is refused: every figure in these
      // reports is about the reader's model and excludes the library, so
      // scoping to a library element would print an inventory of zero that
      // reads exactly like a model with none.
      const library = run(['contracts', file, '--element', 'Requirements::RequirementCheck']);
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
  it('contracts --keywords inventories the vocabulary, and check says none of it', () => {
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
      const quiet = run(['contracts', file]);
      expect(quiet.code).toBe(0);
      expect(quiet.stdout).not.toContain('keywords:');
      expect(quiet.stdout).not.toContain('verification/foreign-keyword');

      const r = run(['contracts', file, '--keywords']);
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

      const json = run(['contracts', file, '--keywords', '--json']);
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
  it('contracts --keywords calls #prose its own, in a file that declares no package', () => {
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
      const r = run(['contracts', file, '--keywords']);
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
  it('obligations reads a foreign clause keyword only under --from-keywords', () => {
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
      const off = run(['obligations', file, '--json']);
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

      const on = run(['obligations', file, '--from-keywords']);
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

      const onJson = run(['obligations', file, '--from-keywords', '--json']);
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
      const narrowed = run(['obligations', encodable, '--missing', '--from-keywords']);
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
    const lit = run(['verify', UAV, '--engine', 'literal']);
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
    const smt = run(['verify', UAV, '--engine', 'auto']);
    expect(smt.code, 'the shipped example does not verify').toBe(0);
    expect(smt.stdout).toContain('0 inconclusive, 2 discharged, 0 refuted');
    expect(smt.stdout).toContain('negation-unsat under a satisfiable axiom set');
    expect(smt.stdout).toMatch(/proved: A ∧ P ∧ ¬G unsat/);
    expect(smt.stdout, 'a proof with no satisfiable-assumptions witness').toContain(
      'assumptions satisfiable',
    );

    const auto = run(['verify', UAV, '--engine', 'auto'], undefined, NO_Z3);
    expect(auto.code, 'a missing solver must never be a green build').toBe(2);
    expect(auto.stdout).toContain('verification/tool-absent');
    expect(auto.stdout, 'the reader is not told what to run instead').toContain('--engine literal');
    expect(auto.stdout, 'a row claimed `proved` with no solver').not.toMatch(/\bproved:/);

    const forgiven = run(['verify', UAV, '--engine', 'auto', '--allow-inconclusive'], undefined, NO_Z3);
    expect(forgiven.code, '--allow-inconclusive must not lower an absent solver').toBe(2);
  }, 300_000);

  /**
   * The two flags this commit adds, at the process boundary.
   *
   * Both are pinned for what they DO NOT do as much as for what they do:
   * `--timeout` is refused rather than repaired when it is not a budget,
   * because a reader who asked for a bound the tool silently replaced would
   * read every `unknown` under a bound that was never in force; and
   * `--strict-vacuity` raises a vacuity to an error and moves NO exit code,
   * which is the one property a flag that sounds like it decides something has
   * to be shown not to.
   */
  it('verify --timeout is refused when it is not a budget, and --strict-vacuity is loud and inert', () => {
    const vacuous = `${FIXV}/models/premises-unsatisfiable.sysml`;

    const plain = run(['verify', vacuous, '--engine', 'smt']);
    expect(plain.code, 'a vacuous obligation is undecided, which is exit 2').toBe(2);
    expect(plain.stdout).toContain('verification/vacuous');
    expect(plain.stdout, 'the flag was not asked for and the tool acted as if it had been').not.toContain(
      'verification/vacuous-property',
    );

    const strict = run(['verify', vacuous, '--engine', 'smt', '--strict-vacuity']);
    expect(strict.code, '--strict-vacuity moved the exit code').toBe(plain.code);
    expect(strict.stdout).toContain('verification/vacuous-property');
    expect(strict.stdout).toContain('changes no exit code');

    // A budget that is honoured, printed in the header so a reader can see the
    // bound every `unknown` below it would have been reached under.
    const budgeted = run(['verify', UAV, '--engine', 'smt', '--timeout', '9000']);
    expect(budgeted.code).toBe(0);
    expect(budgeted.stdout).toContain('at 9000 ms per check');
    expect(budgeted.stdout).toContain('timeout 9000 ms');

    for (const bad of ['0', 'forever', '1e999']) {
      const r = run(['verify', UAV, '--engine', 'smt', '--timeout', bad]);
      expect(r.code, `--timeout ${bad} was accepted`).toBe(2);
      expect(r.stderr).toContain('--timeout must be a positive number of milliseconds');
      expect(r.stderr, 'the refusal does not say why there is no "off"').toContain('no timeout');
    }
    // `-1` is refused one layer earlier and for a different reason: a leading
    // `-` is the next OPTION to the argument reader, so the flag is reported as
    // having no value at all. Pinned rather than glossed — it is still exit 2
    // and still a usage error, and a parser change that made `-1` reach the
    // budget check would be a change worth noticing here.
    const negative = run(['verify', UAV, '--engine', 'smt', '--timeout', '-1']);
    expect(negative.code, '--timeout -1 was accepted').toBe(2);
    expect(negative.stderr).toContain('missing value for --timeout');
  }, 300_000);

  /**
   * `--free` at the process boundary: the flag that changes what a verdict
   * MEANS, and the two ways it must refuse rather than mislead.
   */
  it('verify --free reports a design the model admits, refuses a one-sided domain, and refuses a name that means nothing', () => {
    const oneSided = `${FIXV}/models/free-one-sided.sysml`;
    const admitted = `${FIXV}/models/free-two-sided-refutable.sysml`;

    const unbounded = run(['verify', oneSided, '--engine', 'smt', '--free', 'uav.cruisePower']);
    expect(unbounded.code, 'an unconfined free variable must not be green').toBe(2);
    expect(unbounded.stdout).toContain('verification/free-variable-unbounded');
    expect(unbounded.stdout).toMatch(/unbounded (above|below)/);
    expect(unbounded.stdout, 'a fabricated counterexample was printed').not.toMatch(/refuted:/);

    const design = run(['verify', admitted, '--engine', 'smt', '--free', 'uav.cruisePower']);
    expect(design.code, 'a design the model admits is never exit 1').toBe(2);
    expect(design.stdout).toContain('design admitted by the model, not a violation of it');
    expect(design.stdout).toContain('witness:');
    // The header has to name the release, or a reader takes the row for a
    // verdict at the model's own values.
    expect(design.stdout).toContain('with uav.cruisePower released');

    const misspelt = run(['verify', admitted, '--engine', 'smt', '--free', 'uav.cruisePowr']);
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
    const inert = run(['verify', admitted, '--engine', 'smt', '--free', 'AdmittedByDesign::uav']);
    expect(inert.code, 'a --free that released nothing still printed a verdict').toBe(2);
    expect(inert.stderr).toContain('which no relation in this model reads');
    expect(inert.stderr, 'the refusal does not say what could be freed instead').toContain(
      'AdmittedByDesign::AirVehicle::cruisePower',
    );
    expect(inert.stdout, 'a verdict was printed under a bound nobody released').not.toContain('proved:');
    // The bare spelling of the same name: refused too, by the other rule.
    const bare = run(['verify', admitted, '--engine', 'smt', '--free', 'uav']);
    expect(bare.code, 'a bare --free naming two elements printed a verdict').toBe(2);
    expect(bare.stderr).toContain('names 2 elements of this model');
    expect(bare.stdout, 'a verdict was printed under a bound nobody released').not.toContain('proved:');

    // And a bare name that names TWO features is refused rather than resolved
    // to whichever the model walk reached first: `--free` is documented as
    // taking "a feature name unique in scope", and uniqueness is a promise the
    // resolver has to be able to check.
    const ambiguous = run(['verify', `${FIXV}/models/ambiguous-name.sysml`, '--engine', 'smt', '--free', 'mass']);
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
    const unique = run([
      'verify', `${FIXV}/models/ambiguous-name.sysml`, '--engine', 'smt',
      '--free', 'AmbiguousName::Wing::mass',
    ]);
    expect(unique.stderr, 'a qualified --free was refused as ambiguous').not.toContain('--free');
    expect(unique.stdout, 'the header does not name the release it ran under').toContain(
      'with AmbiguousName::Wing::mass released',
    );
  }, 300_000);

  it('verify --json publishes a top-level verdict block, and --record writes the evidence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sysprose-cli-'));
    try {
      const out = join(dir, 'nested', 'uav.json');
      const r = run(['verify', UAV, '--engine', 'literal', '--json', '--record', out]);
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
      const smt = run(['verify', UAV, '--engine', 'smt', '--json']);
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

  it('verify refuses a mistyped engine and --free on the engine that cannot honour it', () => {
    const bad = run(['verify', UAV, '--engine', 'nope']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('unknown --engine');

    // Accepted-and-ignored would print `holds-at-values` under a bound the
    // evidence record then claimed was in force.
    const freed = run(['verify', UAV, '--engine', 'literal', '--free', 'UAV::AirVehicle::cruisePower']);
    expect(freed.code).toBe(2);
    expect(freed.stderr).toContain('--free is an SMT-engine option');
  }, 120_000);

  it('verify exits 1 on a refutation and 2 on a degraded model', () => {
    const refuted = run(['verify', `${FIXV}/models/refuted-at-values.sysml`, '--engine', 'literal']);
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
      const degraded = run(['verify', broken, '--engine', 'literal']);
      expect(degraded.code).toBe(2);
      expect(degraded.stderr).toContain('nothing is judged over half a model');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it('verify --record refuses a model that did not load cleanly, and writes nothing', () => {
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
      const r = run(['verify', broken, '--engine', 'literal', '--record', out]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('--record refuses a model that did not load cleanly');
      expect(existsSync(out), 'a record was written over half a model').toBe(false);

      // Without --record the same file still reports, and still exits 2.
      const plain = run(['verify', broken, '--engine', 'literal']);
      expect(plain.code).toBe(2);
      expect(plain.stderr).toContain('nothing is judged over half a model');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it('verify exits 2 over a model that states no obligation, under every engine', () => {
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
      const absent = run(['verify', file, '--engine', 'auto'], undefined, NO_Z3);
      expect(absent.code, 'no solver, nothing verified, and the build went green').toBe(2);
      expect(absent.stdout).toContain('this run is exit 2');
      expect(absent.stdout).toContain('this model states no obligation at all');

      // And WITH one: a solver that ran and had nothing to decide is the same
      // answer. Exit 0 says every obligation was discharged; a model that
      // states none has been shown nothing, and that is true of every engine.
      const auto = run(['verify', file, '--engine', 'auto']);
      expect(auto.code, 'a solver ran, decided nothing, and the build went green').toBe(2);
      expect(auto.stdout).toContain('this model states no obligation at all');

      const lit = run(['verify', file, '--engine', 'literal']);
      expect(lit.code, 'nothing was discharged, so nothing is green').toBe(2);

      // And the payload agrees with the process, which is the one thing an
      // automation cannot recover from.
      const json = run(['verify', file, '--engine', 'auto', '--json'], undefined, NO_Z3);
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
    const conflict = `${FIXV}/models/consistency-conflict.sysml`;
    const r = run(['consistency', conflict]);
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

    const reduced = run(['consistency', conflict, '--minimize']);
    expect(reduced.code).toBe(1);
    expect(reduced.stdout).toContain('a minimal conflicting subset');
  }, 180_000);

  it('consistency --json publishes a top-level verdict block that agrees with the process', () => {
    const r = run(['consistency', UAV, '--with-values', '--json']);
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
    const released = run(['consistency', UAV, '--json']);
    expect(released.code).toBe(0);
    const other = payload<{ consistency: { released: string[] } }>(released).body;
    expect(other.consistency.released).toContain('UAVSurveillanceSystem::AirVehicle::mtow');
  }, 240_000);

  it('consistency decides nothing with no solver, and --allow-inconclusive does not lower it', () => {
    // The honest-absence path, forced with the switch the §5 CI job uses.
    // There is no second engine to fall back to here: whether a requirement set
    // is satisfiable is not a question the model's own values can answer.
    for (const extra of [[], ['--allow-inconclusive']]) {
      const r = run(['consistency', UAV, ...extra], undefined, NO_Z3);
      expect(r.code, `--allow-inconclusive lowered an absent solver (${extra.join(' ') || 'no flag'})`).toBe(2);
      expect(r.stdout).toContain('verification/tool-absent');
      expect(r.stdout).toContain('no solver ran');
      // The census is still true — an absent solver must not read as an empty
      // model — and nothing was called consistent.
      expect(r.stdout).toContain('2 requirement(s) on 1 subject(s)');
      expect(r.stdout, 'a verdict was printed with no solver').not.toContain('— consistent');
    }
  }, 240_000);

  it('refine proves the power-budget decomposition and prints the γ census', () => {
    const budget = resolve(process.cwd(), 'examples/uav-power-budget.sysml');
    const r = run(['refine', budget, '--via', 'composition']);
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
    const r = run(['refine', bare, '--json']);
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
    const opted = run(['refine', bare, '--connections-as-equalities']);
    expect(opted.code).toBe(0);
    expect(opted.stdout).toContain('`--connections-as-equalities` read bare `connect` edges');
  }, 240_000);

  it('refine reports a vacuous contract set as inconclusive, and no flag lowers it', () => {
    const siblings = `${FIXV}/models/refinement-contradictory-siblings.sysml`;
    for (const extra of [[], ['--allow-inconclusive']]) {
      const r = run(['refine', siblings, ...extra]);
      expect(r.code, `--allow-inconclusive laundered a vacuity (${extra.join(' ') || 'no flag'})`).toBe(2);
      expect(r.stdout).toContain('verification/contract-set-vacuous');
      expect(r.stdout).toContain('cannot hold together');
      expect(r.stdout, 'a contradiction was printed as a refinement').not.toContain('— refined');
    }
  }, 240_000);

  it('refine refuses a --via this build does not answer, and a --element that names nothing', () => {
    const budget = resolve(process.cwd(), 'examples/uav-power-budget.sysml');
    // A FAMILY THE PLAN NAMES AND THIS BUILD DOES NOT ANSWER is a usage error,
    // not an empty report: reporting nothing over the derivation edges would
    // read as a model that states none.
    const derive = run(['refine', budget, '--via', 'derive']);
    expect(derive.code).toBe(2);
    expect(derive.stderr).toContain('is not answered by this build');
    const nonsense = run(['refine', budget, '--via', 'sideways']);
    expect(nonsense.code).toBe(2);
    expect(nonsense.stderr).toContain('--via must be one of');

    // And a REF that resolves but names no decomposition is refused BY NAME
    // rather than reported as a file that states no architecture.
    const empty = run(['refine', budget, '--element', 'UAVPowerBudget::BatteryPack::outputVoltage']);
    expect(empty.code).toBe(2);
    expect(empty.stderr).toContain('names no decomposition in this file');
    expect(
      empty.stdout,
      'a REF that selected nothing was reported as a model that states nothing',
    ).not.toContain('this model states no decomposition at all');

    // AND ITS `--help` PUBLISHES ITS OWN CONTRACT, at the process boundary
    // where a reader actually meets it. `verify`'s paragraph is written in
    // terms of the file's VALUES — "with every feature at its model value", "a
    // relation not evaluable at the model's values", a `--free` clause — and a
    // refinement obligation reads none of them.
    const help = run(['refine', '--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('every decomposition the model states was shown to refine');
    expect(help.stdout, 'refine published verify’s value-based exit contract').not.toContain(
      'at its model value',
    );
    expect(help.stdout).not.toContain('a refutation obtained under --free');
    expect(help.stdout).toContain('there is no --free here');
  }, 240_000);

  it('refine decides nothing with no solver, and --allow-inconclusive does not lower it', () => {
    const budget = resolve(process.cwd(), 'examples/uav-power-budget.sysml');
    for (const extra of [[], ['--allow-inconclusive']]) {
      const r = run(['refine', budget, ...extra], undefined, NO_Z3);
      expect(r.code, `--allow-inconclusive lowered an absent solver (${extra.join(' ') || 'no flag'})`).toBe(2);
      expect(r.stdout).toContain('verification/tool-absent');
      expect(r.stdout).toContain('no solver ran');
      // The census is still true — an absent solver must not read as a model
      // with no architecture in it.
      expect(r.stdout).toContain('1 decomposition(s) over 5 contract(s)');
      expect(r.stdout, 'a verdict was printed with no solver').not.toContain('— refined');
    }
  }, 240_000);

  it('consistency --subject narrows by what the reader typed, and refuses a REF that selects nothing', () => {
    // THREE SPELLINGS A READER REACHES FOR, and the promise they rest on: "a
    // type answers for its subtypes". The type no contract names, and the part
    // usage the file writes after `subject` — which every row of this report
    // prints beside the type — both have to select the set the guide says they
    // select, and the conformance test underneath them inverts silently.
    const model = `${FIXV}/models/consistency-subtype.sysml`;
    const air = run(['consistency', model, '--subject', 'ConsistencySubtype::AirVehicle']);
    expect(air.code).toBe(0);
    expect(air.stdout).toContain('4 requirement(s) on 1 subject(s)');
    expect(air.stdout).toContain('subject ConsistencySubtype::AirVehicle');
    expect(air.stdout, 'narrowing to a subtype pulled in its sibling set').not.toContain(
      'subject ConsistencySubtype::Vehicle',
    );

    const usage = run(['consistency', model, '--subject', 'ConsistencySubtype::uav']);
    expect(usage.code).toBe(0);
    expect(usage.stdout).toContain('subject ConsistencySubtype::AirVehicle');

    // AND A REF THAT RESOLVES AND SELECTS NOTHING IS A USAGE ERROR. The
    // run-wide sentence says the file states no requirement set at all, and
    // printing that because a `--subject` matched none of them would be a false
    // statement about the reader's model in the one place they came for a true
    // one.
    const empty = run(['consistency', model, '--subject', 'ConsistencySubtype::Vehicle::mass']);
    expect(empty.code).toBe(2);
    expect(empty.stderr).toContain('is not the subject of any requirement in this file');
    expect(
      empty.stdout,
      'a subject that selected nothing was reported as a model that states nothing',
    ).not.toContain('this model states no requirement set at all');
  }, 180_000);

  it('consistency refuses a budget that is not one and a subject that names nothing', () => {
    const badCore = run(['consistency', UAV, '--max-core', '0']);
    expect(badCore.code).toBe(2);
    expect(badCore.stderr).toContain('--max-core must be a positive whole number');
    expect(badCore.stderr, 'a usage error was reported as a tool defect').not.toContain(
      'internal error',
    );
    const badSubject = run(['consistency', UAV, '--subject', 'NoSuchThing']);
    expect(badSubject.code).toBe(2);
    expect(badSubject.stderr).toContain('no element matches `NoSuchThing`');
  }, 180_000);

  it('the evidence round trip at the process boundary: record, attach, go stale, detach', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sysprose-cli-'));
    try {
      const model = join(dir, 'uav.sysml');
      writeFileSync(model, readFileSync(UAV, 'utf8'));
      const records = join(dir, 'evidence.json');

      const recorded = run(['verify', model, '--engine', 'literal', '--record', records]);
      expect(recorded.code).toBe(0);
      expect(existsSync(records)).toBe(true);

      // ATTACHING DOES NOT WRITE THE INPUT. The updated model is on stdout and
      // the file is untouched until `--out` says otherwise — the one property
      // that lets a reader run this command to see what it would do.
      const dry = run(['evidence-attach', model, '--from', records]);
      expect(dry.code).toBe(0);
      expect(dry.stdout).toContain('@SysproseVerification::Evidence');
      expect(dry.stderr).toContain('was NOT changed');
      expect(readFileSync(model, 'utf8'), 'the input file was rewritten without --out').toBe(
        readFileSync(UAV, 'utf8'),
      );

      const attached = run(['evidence-attach', model, '--from', records, '--out', model]);
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

      const fresh = run(['evidence-status', model]);
      expect(fresh.code).toBe(0);
      expect(fresh.stdout).toContain('0 stale, 2 current, 0 unrecorded');
      expect(fresh.stdout).toContain('`holds-at-values` is never shown as `proved`');

      // Re-attaching the same records says nothing new and writes nothing.
      const again = run(['evidence-attach', model, '--from', records]);
      expect(again.stderr).toContain('0 record(s) attached');
      expect(again.stderr).toContain('2 already present');

      // ONE LITERAL, and the verdict in the file stops standing on the model it
      // was reached over — reported by `evidence-status` AND by the ordinary
      // checker, which is what the next person to open the file runs.
      writeFileSync(model, written.replace('18.5 [kg]', '19.5 [kg]'));
      const stale = run(['evidence-status', model]);
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
      const detached = run(['evidence-detach', model, '--out', model]);
      expect(detached.code).toBe(0);
      expect(detached.stderr).toContain('2 verdict facet(s) cleared');
      const bare = readFileSync(model, 'utf8');
      expect(bare).not.toContain('SysproseVerification::Evidence');
      expect(bare).not.toContain('attribute verdict =');
      expect(run(['evidence-status', model]).stdout).toContain(
        'nothing in this file states a verdict or carries a record',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);

  it('evidence-attach refuses a missing --from, a file that is not records, and a degraded model', () => {
    const noFrom = run(['evidence-attach', UAV]);
    expect(noFrom.code).toBe(2);
    expect(noFrom.stderr).toContain('--from PATH is required');
    // Refused BEFORE the library is bound: a run that parsed 38 761 elements to
    // discover it had nothing to attach is a run that wasted the reader's time.
    expect(noFrom.stdout, 'the model was loaded before the flag was checked').toBe('');

    const dir = mkdtempSync(join(tmpdir(), 'sysprose-cli-'));
    try {
      const notRecords = join(dir, 'notes.json');
      writeFileSync(notRecords, JSON.stringify([{ verdict: 'pass' }]));
      const bad = run(['evidence-attach', UAV, '--from', notRecords]);
      expect(bad.code).toBe(2);
      expect(bad.stderr).toContain('does not hold evidence records this tool wrote');
      expect(bad.stderr).toContain('docs/schemas/evidence-record.schema.json');
      expect(bad.stderr, 'a bad input file was reported as a tool defect').not.toContain(
        'internal error',
      );

      const notJson = join(dir, 'notes.txt');
      writeFileSync(notJson, 'these are my notes');
      expect(run(['evidence-attach', UAV, '--from', notJson]).stderr).toContain('is not JSON');

      // A model that did not load cleanly is never written back: serializing a
      // salvaged model over somebody's source is a lossy rewrite of it.
      const broken = join(dir, 'broken.sysml');
      writeFileSync(broken, 'package P {\n    part def A;\n    part a : A;\n    part def ?? ;\n}\n');
      const records = join(dir, 'ev.json');
      writeFileSync(records, '[]');
      const degraded = run(['evidence-attach', broken, '--from', records]);
      expect(degraded.code).toBe(2);
      expect(degraded.stderr).toContain('refuses a model that did not load cleanly');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);

  it('evidence-status names a verdict with nothing behind it, and one that overstates', () => {
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
      const unrecorded = run(['evidence-status', claimed, '--json']);
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
      expect(run(['verify', model, '--engine', 'literal', '--record', records]).code).toBe(0);
      expect(run(['evidence-attach', model, '--from', records, '--out', model]).code).toBe(0);
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
      const overstated = run(['evidence-status', model]);
      expect(overstated.stdout).toContain('overstated');
      expect(overstated.stdout).toContain('verification/verdict-overstates-evidence');
      expect(overstated.stdout).toContain('`pass` is written for `proved` alone');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);

  it('evidence-attach PRINTS every verdict it moves, and every record it could not place', () => {
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
      expect(run(['verify', model, '--engine', 'literal', '--record', refuted]).code).toBe(1);
      const first = JSON.parse(readFileSync(refuted, 'utf8')) as Array<{
        claim: string;
        verdict: string;
        obligation: { requirement: string | null; clause: string };
      }>;
      expect(first[0].claim).toBe('refuted');

      const attached = run(['evidence-attach', model, '--from', refuted, '--out', model]);
      expect(attached.code).toBe(0);
      expect(readFileSync(model, 'utf8')).toContain('attribute verdict = "fail"');

      // The SAME obligation, re-recorded as a proof. Nothing in the model
      // changed, so this is the laundering direction the plan names by hand.
      const proved = join(dir, 'proved.json');
      writeFileSync(
        proved,
        JSON.stringify([{ ...first[0], claim: 'proved', verdict: 'pass', engine: 'smt' }]),
      );
      const moved = run(['evidence-attach', model, '--from', proved, '--out', model]);
      expect(moved.code).toBe(0);
      expect(moved.stderr).toContain('verdict fail → pass');
      expect(moved.stderr).toContain('(claim refuted → proved)');
      expect(
        moved.stderr,
        'a refutation was replaced by a pass and the command said nothing about it',
      ).toContain('a refutation is being replaced by a pass');
      // The refutation is still in the file: evidence accumulates.
      expect(run(['evidence-status', model, '--json']).stdout).toContain('"records": 2');

      // AND A RECORD THIS MODEL CANNOT CARRY IS NAMED, not silently dropped.
      const elsewhere = join(dir, 'elsewhere.json');
      writeFileSync(
        elsewhere,
        JSON.stringify([
          { ...first[0], obligation: { ...first[0].obligation, requirement: 'Other::notHere' } },
        ]),
      );
      const skipped = run(['evidence-attach', model, '--from', elsewhere]);
      expect(skipped.code).toBe(0);
      expect(skipped.stderr).toContain(`skipped ${first[0].obligation.clause}`);
      expect(skipped.stderr).toContain('no element of this model is called `Other::notHere`');
      expect(skipped.stderr).toContain('0 record(s) attached');
      expect(skipped.stderr).toContain('1 skipped');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);

  it('a requirement with two obligations carries the worst of them, whichever order they are written in', () => {
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
        expect(run(['verify', model, '--engine', 'literal', '--record', records]).code).toBe(1);
        const attached = run(['evidence-attach', model, '--from', records, '--out', model]);
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
        const status = run(['evidence-status', model]);
        expect(status.stdout, name).toContain('claim `refuted`, verdict `fail`');
        expect(status.stdout, name).toContain('the weakest of 2 obligations');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);

  it('evidence-attach refuses a record whose stated verdict does not follow from its claim', () => {
    // `verdict` and `claim` are two independent enumerations in the schema, so
    // `{"claim":"holds-at-values","verdict":"pass"}` is valid against it and is
    // still a laundered claim. Copying the record's own verdict through wrote
    // `attribute verdict = "pass"` over a point evaluation.
    const dir = mkdtempSync(join(tmpdir(), 'sysprose-cli-'));
    try {
      const model = join(dir, 'uav.sysml');
      writeFileSync(model, readFileSync(UAV, 'utf8'));
      const records = join(dir, 'ev.json');
      expect(run(['verify', model, '--engine', 'literal', '--record', records]).code).toBe(0);
      const parsed = JSON.parse(readFileSync(records, 'utf8')) as Array<{
        claim: string;
        verdict: string;
      }>;
      expect(parsed[0].claim).toBe('holds-at-values');
      const laundered = join(dir, 'laundered.json');
      writeFileSync(laundered, JSON.stringify([{ ...parsed[0], verdict: 'pass' }]));

      const refused = run(['evidence-attach', model, '--from', laundered, '--out', model]);
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

  it('verify --case judges one verification case, and the method gate decides the run', () => {
    // The L7 case §3.0 promises per new REF flag, at the process boundary where
    // a reader meets it. The example ships three cases on purpose: one
    // `analyze`, one `test`, one `kind = (analyze, test)`.
    const VER = resolve(process.cwd(), 'examples/uav-isr-verification.sysml');

    // THE WHOLE FILE. Every obligation in it is discharged — the header says so
    // — and the run is still 2, because a case in it was never judged.
    const all = run(['verify', VER, '--engine', 'literal']);
    expect(all.code, 'an unjudged case did not reach the exit code').toBe(2);
    expect(all.stdout).toContain('0 inconclusive, 3 discharged, 0 refuted');
    expect(all.stdout).toContain('3 verification case(s): 2 pass, 0 fail, 1 inconclusive');
    expect(all.stdout).toContain('1 not judged at all — this tool performs analysis only');

    // ONE CASE, JUDGED. The report is narrowed to the obligations of the
    // requirement it verifies; the other two requirements are still in the
    // model, and the axioms they stand on are still in force.
    const one = run(['verify', VER, '--engine', 'literal', '--case', 'enduranceAnalysis']);
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
      const bench = run(['verify', VER, '--engine', 'literal', '--case', 'massBench', ...extra]);
      expect(bench.code, `--case massBench ${extra.join(' ')}`).toBe(2);
      expect(bench.stdout).toContain('verification/method-not-performed');
      expect(bench.stdout).toContain(
        'inconclusive: method is test — this tool performs analysis only',
      );
    }

    // THE MIXED CASE, judged on the analyze part and saying so.
    const mixed = run(['verify', VER, '--engine', 'literal', '--case', 'linkQualification']);
    expect(mixed.code).toBe(0);
    expect(mixed.stdout).toContain('test not performed by this tool');

    // A REF THAT IS NOT A CASE is refused BY NAME rather than answered as a run
    // over the whole model, and the refusal lists what the file does have.
    const notACase = run(['verify', VER, '--engine', 'literal', '--case', 'MassRequirement']);
    expect(notACase.code).toBe(2);
    expect(notACase.stderr).toContain('which is not a verification case');
    expect(notACase.stderr).toContain('UAVSurveillanceVerification::massBench');
    const missing = run(['verify', VER, '--engine', 'literal', '--case', 'NoSuchCase']);
    expect(missing.code).toBe(2);

    // AND IT IS IN THE REPRODUCIBLE COMMAND, for the same reason `--free` is:
    // it changes which obligations the records are about.
    const dir = mkdtempSync(join(tmpdir(), 'sysprose-cli-'));
    try {
      const records = join(dir, 'endurance.json');
      expect(
        run(['verify', VER, '--engine', 'literal', '--case', 'enduranceAnalysis', '--record', records]).code,
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

  it('record then attach writes the verdict facet and the standard method annotation', () => {
    // The pipeline of §3.4 at the process boundary. The case here states NO
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
      expect(run(['verify', model, '--engine', 'literal', '--record', records]).code).toBe(0);

      const attached = run(['evidence-attach', model, '--from', records, '--out', model]);
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
      const status = run(['evidence-status', model]);
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
      const asJson = run(['evidence-attach', model, '--from', records, '--json']);
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
      const again = run(['evidence-attach', model, '--from', records, '--out', model]);
      expect(again.code).toBe(0);
      expect(again.stderr).not.toContain('declared no method');
      expect(
        readFileSync(model, 'utf8').match(/@VerificationCases::VerificationMethod/g)?.length,
      ).toBe(1);
      expect(run(['evidence-status', model]).stdout).toContain('0 stale, 1 current');

      // ATTACH THEN DETACH IS AN INVERSE, annotation included: a tool-authored
      // sentence about the METHOD that no command removed would outlive every
      // claim it was written beside.
      const detached = run(['evidence-detach', model, '--out', model]);
      expect(detached.code).toBe(0);
      expect(detached.stderr).toContain('RecordThenAttach::massAnalysis');
      expect(readFileSync(model, 'utf8')).not.toContain('VerificationMethod');
      expect(readFileSync(model, 'utf8')).not.toContain('attribute verdict');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);

  it('the method gate reads every spelling of `kind`, including an inherited one', () => {
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
      const parsed = run(['stats', model]);
      expect(parsed.code).toBe(0);
      expect(parsed.stderr).not.toContain('error(s)');

      for (const name of ['bareMetadata', 'typedMetadata', 'inheritedMethod']) {
        const r = run(['verify', model, '--engine', 'literal', '--case', name]);
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

  it('a case over two requirements writes each one its own verdict facet', () => {
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
      expect(run(['verify', model, '--engine', 'literal', '--record', records]).code).toBe(1);
      expect(run(['evidence-attach', model, '--from', records, '--out', model]).code).toBe(0);

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

  it('reach walks FlightModes and names the choice the simulator hides', () => {
    const r = run(['reach', UAV]);
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

  it('reach --json publishes under `reach`, with the semantic profile beside the figures', () => {
    const r = run(['reach', UAV, '--json']);
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

  it('reach --max-configs suppresses both absence lists rather than shrinking them', () => {
    const r = run(['reach', UAV, '--max-configs', '2', '--json']);
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

  it('reach reports a file with no machine at all, and exits 0 doing it', () => {
    // NOT a usage error. Nothing was misused and nothing failed to load: the
    // file simply declares no machine, which is a fact about the model and the
    // report's answer to the question. `reach` carries `exitContract: 'report'`
    // and two of the shipped examples are this shape, so exiting 2 would break
    // a `set -e` walk over a directory of models on files that are fine.
    const noMachine = resolve(process.cwd(), 'examples/uav-isr-verification.sysml');
    const r = run(['reach', noMachine]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('0 state machine(s)');
    expect(r.stdout).toContain('declares no element that owns a transition');

    const j = run(['reach', noMachine, '--json']);
    expect(j.code).toBe(0);
    const { body } = payload<{ reach: { machines: unknown[]; totals: { machines: number } } }>(j);
    expect(body.reach.machines).toEqual([]);
    expect(body.reach.totals.machines).toBe(0);
  }, 90_000);

  it('reach refuses a --max-configs that is not a bound, and a REF that holds no machine', () => {
    const bad = run(['reach', UAV, '--max-configs', 'lots']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('--max-configs');

    const noMachine = run(['reach', UAV, '--element', 'EnduranceRequirement']);
    expect(noMachine.code).toBe(2);
    expect(noMachine.stderr).toContain('no state machine');
  }, 90_000);

  it('--no-library skips binding and still reports the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sysprose-cli-'));
    const file = join(dir, 'nolib.sysml');
    writeFileSync(file, 'package P {\n    part def A;\n    part a : A;\n}\n');
    try {
      const r = run(['stats', file, '--no-library', '--json']);
      expect(r.code).toBe(0);
      const { body } = payload<{ stats: { libraryElements: number; totalElements: number } }>(r);
      expect(body.stats.libraryElements).toBe(0);
      expect(body.stats.totalElements).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
