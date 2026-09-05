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
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve(process.cwd(), 'scripts/sysprose.ts');
const UAV = resolve(process.cwd(), 'examples/uav-isr.sysml');
const FIX = resolve(process.cwd(), 'test/fixtures/agent-authoring');

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
function run(args: string[], input?: string): Run {
  const r = spawnSync('npx', ['tsx', CLI, ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...(input !== undefined ? { input } : {}),
    stdio: input !== undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
  });
  if (r.error) throw r.error;
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

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
    ]) {
      expect(top.stdout, `${name} must be listed`).toContain(name);
    }

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
