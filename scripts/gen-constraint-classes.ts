#!/usr/bin/env tsx
/**
 * Generate `docs/CONSTRAINT-CLASSES.md` and the marked regions of the documents that quote it.
 *
 * Everything printed is read from the register (`src/semantics/smt/classes.ts`), the facts counted from this
 * repository (`src/semantics/smt/class-facts.ts`) and the levels the rubric computes from them, so a document
 * cannot say more than the code holds: `test/unit/semantics.constraint-class.test.ts` holds each file to what
 * {@link renderConstraintClasses} writes today.
 *
 * LABEL ONLY. The text says so, and says which surfaces exist: a `planned` surface of the register is listed as
 * planned and described by nothing else. Only classes with a corpus row are printed (user decision 1,
 * 2026-10-30).
 *
 * Run: npm run classes [-- --check]
 *
 *   --check   write nothing: exit 1 when a file is not what the generator renders
 *
 * Exit 0 on success, 1 when `--check` finds a difference, 2 on a usage error or a missing marker region.
 * Imported (the drift test does), it writes nothing.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flagGiven, isArgError, parseArgs, type FlagSpec } from './lib/args';
import { runMain } from './lib/exit';
import { isMainModule } from './lib/is-main';
import { CLASS_FACTS } from '../src/semantics/smt/class-facts';
import {
  CONSTRAINT_CLASSES,
  FENCE_LEVELS,
  LEVELS,
  MATURITY_SENTENCE,
  REGISTER_VERSION,
  RUBRIC,
  SURFACES,
  cellsOfClass,
  isFenceCell,
  levelDetail,
  printedClasses,
  type ClassDef,
  type ClassId,
  type Family,
  type Level,
} from '../src/semantics/smt/classes';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DOC_PATH = 'docs/CONSTRAINT-CLASSES.md';

/** The three documents that carry a marked region, and the region each carries. */
export const REGION_HOSTS = {
  'user-guide': 'docs/USER-GUIDE.md',
  conformance: 'docs/CONFORMANCE.md',
  'test-report': 'docs/TEST-REPORT.md',
} as const;
export type RegionName = keyof typeof REGION_HOSTS;

const GENERATED_BY = 'scripts/gen-constraint-classes.ts; npm run classes';
export const beginMarker = (name: RegionName): string => `<!-- BEGIN GENERATED constraint-classes:${name} (${GENERATED_BY}) -->`;
export const endMarker = (name: RegionName): string => `<!-- END GENERATED constraint-classes:${name} -->`;

/** The text between the markers of a region, or `null` when the document has none. */
export function readRegion(source: string, name: RegionName): string | null {
  const from = source.indexOf(beginMarker(name));
  const to = source.indexOf(endMarker(name));
  if (from < 0 || to < from) return null;
  return source.slice(from + beginMarker(name).length, to);
}

/** `source` with the text between the markers of a region replaced; throws when a marker is missing. */
export function spliceRegion(source: string, name: RegionName, body: string): string {
  const from = source.indexOf(beginMarker(name));
  const to = source.indexOf(endMarker(name));
  if (from < 0 || to < from) throw new Error(`no ${name} region: ${beginMarker(name)} ... ${endMarker(name)}`);
  return source.slice(0, from + beginMarker(name).length) + body + source.slice(to);
}

/* ─────────────────────────────────────── the facts, as tables ─────────────────────────────────────── */

const FAMILY_TITLE: Record<Family, string> = {
  shape: 'Shapes',
  modifier: 'Modifiers',
  reading: 'Readings',
  fence: 'Fences',
};

const FAMILY_TEXT: Record<Family, () => string> = {
  shape: () =>
    'What z3 is asked: the `set-logic` the relation’s own bytes need. A relation that carries no symbol is `ground`. ' +
    `The precedence among the printed shapes is ${list(printedClasses().filter((id) => CONSTRAINT_CLASSES[id].family === 'shape'))}. ` +
    'A nonlinear shape is split into `/pinned` and `/free`: `/pinned` when every variable at a nonlinear site is fixed by a stated value, or by an equation solved for it from fixed values, in the script.',
  modifier: () => 'An extra reading that rides on a shape. A modifier only ever lowers the weakest cell of a proof.',
  reading: () =>
    'How a fact entered the proof. A relation that has a formal clause has exactly one reading; a requirement with no formal clause has none and is only `fence/no-formal-clause`.',
  fence: () =>
    'A relation that was not sent to z3, one class per refusal reason. A fence carries no solver verdict: a fenced goal is `unsupported` or `not-evaluable`, ' +
    'and a refused relation that the model’s own values violate is `refuted` by point evaluation, which no flag lowers.',
};

const cellsPrinted = (): string[] => printedClasses().flatMap((id) => cellsOfClass(id).filter((c) => (CLASS_FACTS.cells[c]?.rows ?? 0) > 0));

const sentence = (t: string): string => {
  const u = t.charAt(0).toUpperCase() + t.slice(1);
  return u.endsWith('.') ? u : `${u}.`;
};

const list = (xs: readonly string[]): string => (xs.length === 0 ? 'none' : xs.map((x) => `\`${x}\``).join(', '));

/** One table row per printed cell: the counts the rubric reads, and the level they give. */
function factsTable(): string {
  const head = [
    '| Cell | Rows | Models | Encoder tests | Decided golden rows | Agreeing table rows (probes) | Table rows against | Battery cells | Level |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---|',
  ];
  const rows = cellsPrinted().map((cell) => {
    const f = CLASS_FACTS.cells[cell]!;
    const fence = isFenceCell(cell);
    const level = levelDetail(cell).level;
    return `| \`${cell}\` | ${f.rows} | ${f.models} | ${f.encoderTests} | ${fence ? '—' : f.goldenDecided} | ${fence ? '—' : `${f.tableAgree} (${f.tableProbes})`} | ${fence ? '—' : f.tableDisagree} | ${f.battery ? f.battery.cells : 'none'} | \`${level}\` |`;
  });
  return [...head, ...rows].join('\n');
}

/** How many printed cells stand at each level, in ladder order. */
function levelCounts(): Array<{ level: Level; cells: string[] }> {
  const all: Level[] = [...LEVELS, ...FENCE_LEVELS];
  return all
    .map((level) => ({ level, cells: cellsPrinted().filter((c) => levelDetail(c).level === level) }))
    .filter((x) => x.cells.length > 0);
}

const classCount = (): number => printedClasses().length;
const countByFamily = (): Record<Family, number> => {
  const out: Record<Family, number> = { shape: 0, modifier: 0, reading: 0, fence: 0 };
  for (const id of printedClasses()) out[CONSTRAINT_CLASSES[id].family] += 1;
  return out;
};

const surfaces = (status: 'built' | 'planned'): string[] => SURFACES.filter((s) => s.status === status).map((s) => s.id);

/** The sentence every region and the document share about what exists. */
const labelSentence = (): string =>
  'A class is a label: it moves no verdict, no code, no exit code, no `detail`, no digest and no script byte.';

/* ─────────────────────────────────────── the cards ─────────────────────────────────────── */

function defectLines(id: ClassId): string[] {
  const out: string[] = [];
  for (const d of CLASS_FACTS.defects) {
    if (!d.classes.includes(id)) continue;
    const scope = d.queries === undefined ? '' : `, for the ${d.queries.map((q) => `\`${q}\``).join(', ')} query only`;
    out.push(`- \`${d.id}\` (${d.kind}${scope}): ${d.note}`);
  }
  return out;
}

function card(id: ClassId): string {
  const d: ClassDef = CONSTRAINT_CLASSES[id];
  const lines: string[] = [`### \`${id}\``, '', `- **Encodes.** ${sentence(d.encodes)}`];
  if (d.logic !== null) lines.push(`- **Logic.** \`${d.logic}\`.`);
  if (d.family !== 'fence' && d.verdicts.length < 10) lines.push(`- **Verdict words it can produce.** ${list(d.verdicts)}.`);
  if (d.family === 'fence') {
    lines.push(`- **Produced at.** ${d.layers.map((l) => `the ${l} layer`).join(' and ')}.`);
    const encoderLayer = d.layers.includes('encoder');
    const gate = d.gateForgivable
      ? 'A goal refused at the gate for this reason is `verification/unsupported-construct`, which `--allow-inconclusive` lowers to exit 0.'
      : 'A refusal for this reason is `verification/not-evaluable`, a defect in the relation or a limit of the tool, which no flag lowers.';
    const encoder = encoderLayer ? ' A refusal at the encoder layer is `verification/not-evaluable`, which no flag lowers.' : '';
    lines.push(`- **Forgiveness.** ${gate}${encoder}`);
  }
  for (const cell of cellsOfClass(id)) {
    if ((CLASS_FACTS.cells[cell]?.rows ?? 0) === 0) continue;
    const l = levelDetail(cell);
    const why = [l.firstUnmet === null ? null : `first unmet: ${l.firstUnmet}`, ...l.capped.map((c) => `capped by ${c}`)].filter((x): x is string => x !== null);
    lines.push(`- **Level of \`${cell}\`.** \`${l.level}\`${why.length > 0 ? ` (${why.join('; ')})` : ''}.`);
  }
  if (d.limits.length > 0) {
    lines.push('- **Limits.**');
    for (const lim of d.limits) {
      lines.push(`  - ${sentence(lim.text)}${lim.pin ? ` Pinned by \`${lim.pin.file}\`: “${lim.pin.find}”.` : ''}`);
    }
  }
  const defects = defectLines(id);
  if (defects.length > 0) lines.push('- **Open defects.**', ...defects.map((x) => `  ${x}`));
  if (d.tests.length > 0) {
    lines.push('- **Tests.**');
    for (const t of d.tests) lines.push(`  - \`${t.file}\`: ${t.layer ? `(${t.layer} layer) ` : ''}“${t.find}”`);
  }
  return lines.join('\n');
}

/* ─────────────────────────────────────── the document ─────────────────────────────────────── */

function ladderText(): string {
  const noBattery = !Object.values(CLASS_FACTS.cells).some((c) => c.battery !== null);
  return [
    `- \`experimental\`: the class is encoded.`,
    `- \`tested\`: an encoder test points at it, at least one \`proved\` or \`refuted\` row of the golden verdicts rests on it, and it has no open wrong-verdict defect.`,
    `- \`differential-tested\`: \`tested\`, and at least ${RUBRIC.tableAgree} rows of the differential table over at least ${RUBRIC.tableProbes} probes agree with the hand-computed answer, none against it.`,
    `- \`battery-backed\`: \`differential-tested\`, and at least ${RUBRIC.batteryCells} cells of a battery with none wrong, at the z3 release the facts were measured under.${noBattery ? ' No battery lives in this repository, so no class is `battery-backed`.' : ''}`,
    '',
    'The caps only lower a level: an open wrong-verdict defect caps a class at `experimental`, an open wrong-statement defect at `tested`; a level read for a query other than `verify`, under another z3 release than the facts’, or while a known-false entry of the differential table cannot be attributed, is capped at `tested`. A fact that is absent counts as 0.',
    '',
    'A fence has its own three states: `fenced` when a test pins each layer it is produced at and its register sentences are still in source, `fenced-defect` when a wrong-statement or wrong-verdict defect is open on it, `unpinned` otherwise.',
  ].join('\n');
}

function surfaceTable(): string {
  const rows = SURFACES.map((s) => {
    const where = s.pointer === null ? '—' : `\`${s.pointer.file}\``;
    return `| \`${s.id}\` | ${s.status} | ${s.says} | ${where} |`;
  });
  return ['| Surface | Status | It states | Where |', '|---|---|---|---|', ...rows].join('\n');
}

function document(): string {
  const byFamily = countByFamily();
  const printed = printedClasses();
  const sections: string[] = [];
  for (const family of ['shape', 'modifier', 'reading', 'fence'] as const) {
    const ids = printed.filter((id) => CONSTRAINT_CLASSES[id].family === family);
    if (ids.length === 0) continue;
    sections.push([`## ${FAMILY_TITLE[family]}`, '', FAMILY_TEXT[family](), '', ids.map(card).join('\n\n')].join('\n'));
  }
  return `<!-- GENERATED by scripts/gen-constraint-classes.ts — do not edit by hand.
     Edit src/semantics/smt/classes.ts (the register) or its facts (\`npm run measure:classes\`) and run \`npm run classes\`. -->

# Constraint classes

Everything Sysprose hands to z3, or refuses to hand over, is sorted into a **constraint class**: what the solver is asked (a shape), which extra reading rides on it (a modifier), how the fact entered the proof (a reading), or why nothing was sent (a fence). Each class carries a **maturity level**, computed from facts counted in this repository.

**Label only; no verdict changes.** ${labelSentence()} A level ${MATURITY_SENTENCE}

The register is version ${REGISTER_VERSION}; its facts were measured under z3 ${CLASS_FACTS.z3}. This page prints the **${classCount()} constraint classes** that have a row in the corpus (${byFamily.shape} shapes, ${byFamily.modifier} modifiers, ${byFamily.reading} readings, ${byFamily.fence} fences). A class with no row is kept in the register and is not printed until a row stands in it.

## What exists today

The check, literal and numeric surfaces use no z3 and are outside this partition: they have no class.

${surfaceTable()}

Built: ${list(surfaces('built'))}. Planned, so described by nothing but the table above: ${list(surfaces('planned'))}. The export is not built: there is no \`export\` command, and the one rule fixed for it is that a class comment goes after the script header and never inside the script bytes.

## The levels

${ladderText()}

Where the printed classes stand now:

${levelCounts()
  .map((x) => `- \`${x.level}\`: ${list(x.cells)}.`)
  .join('\n')}

## The facts behind each level

Counted with no solver from this repository (\`npm run census:classes -- --check --strict\` holds them to a recount). A row is a worklist row of the corpus; a decided golden row is a \`proved\` or \`refuted\` row of the golden verdicts that rests on the cell; an agreeing table row is a probe of the differential table whose SMT letter is decided and equals the hand-computed answer.

${factsTable()}

${sections.join('\n\n')}
`;
}

/* ─────────────────────────────────────── the regions ─────────────────────────────────────── */

function userGuideRegion(): string {
  return ` The rows this tool sorts, encoded or refused, fall into **${classCount()} constraint classes** with a computed maturity level each (shape, modifier, reading, fence): a label only, which moves no verdict and which no command prints yet — see [\`CONSTRAINT-CLASSES.md\`](CONSTRAINT-CLASSES.md).`;
}

function conformanceRegion(): string {
  const lv = levelCounts()
    .map((x) => `| \`${x.level}\` | ${x.cells.length} | ${list(x.cells)} |`)
    .join('\n');
  return `
**${classCount()} constraint classes** have a row in the corpus. ${labelSentence()} A level ${MATURITY_SENTENCE} The check, literal and numeric surfaces use no z3 and are outside the partition. Built: ${list(surfaces('built'))}. Planned: ${list(surfaces('planned'))}; the export is not built.

| Level | Cells | Which |
|---|---:|---|
${lv}

The thresholds are \`tested\` (an encoder test and a decided golden row), \`differential-tested\` (${RUBRIC.tableAgree} agreeing rows over ${RUBRIC.tableProbes} probes, none against) and \`battery-backed\` (${RUBRIC.batteryCells} battery cells, none wrong); each class and card is in [\`CONSTRAINT-CLASSES.md\`](CONSTRAINT-CLASSES.md).
`;
}

function testReportRegion(): string {
  return `
${factsTable()}
`;
}

/** The document and the three regions, as strings, from the register and the facts and nothing else. */
export function renderConstraintClasses(): { doc: string; regions: Record<RegionName, string> } {
  return {
    doc: document(),
    regions: { 'user-guide': userGuideRegion(), conformance: conformanceRegion(), 'test-report': testReportRegion() },
  };
}

/* ─────────────────────────────────────── running it ─────────────────────────────────────── */

const FLAGS: readonly FlagSpec[] = [{ name: 'check', kind: 'boolean', doc: 'Write nothing; exit 1 when a file is not what the generator renders.' }];

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2), FLAGS);
  if (isArgError(args)) {
    process.stderr.write(`gen-constraint-classes: ${args.error}\n`);
    return 2;
  }
  const check = flagGiven(args, 'check');
  const { doc, regions } = renderConstraintClasses();
  const wanted = new Map<string, string>([[DOC_PATH, doc]]);
  for (const name of Object.keys(REGION_HOSTS) as RegionName[]) {
    const path = REGION_HOSTS[name];
    const source = wanted.get(path) ?? readFileSync(join(ROOT, path), 'utf8');
    try {
      wanted.set(path, spliceRegion(source, name, regions[name]));
    } catch (e) {
      process.stderr.write(`gen-constraint-classes: ${path}: ${(e as Error).message}\n`);
      return 2;
    }
  }
  let stale = 0;
  for (const [path, text] of wanted) {
    let current: string | null = null;
    try {
      current = readFileSync(join(ROOT, path), 'utf8');
    } catch {
      current = null;
    }
    if (current === text) {
      process.stdout.write(`ok     ${path}\n`);
      continue;
    }
    if (check) {
      stale += 1;
      process.stdout.write(`STALE  ${path}: run npm run classes\n`);
    } else {
      writeFileSync(join(ROOT, path), text);
      process.stdout.write(`wrote  ${path}\n`);
    }
  }
  return stale > 0 ? 1 : 0;
}

if (isMainModule(import.meta.url)) runMain('gen-constraint-classes', main);
