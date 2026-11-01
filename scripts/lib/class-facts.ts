/**
 * The measured facts the constraint-class rubric reads (step S4 of the constraint-classes plan): what is
 * counted for each maturity cell, from what the repository holds, with NO solver.
 *
 *  - `rows`, `models`: worklist rows of the corpus that stand in the cell (examples, the L8 models, v9 and,
 *    for the full measure, the agent-authoring inputs).
 *  - `encoderTests` (E1): the register's test pointers that still resolve, by exact string.
 *  - `goldenDecided`, `goldenCases` (G1): `proved` or `refuted` rows of the L8 goldens that rest on the cell,
 *    joined to the worklist by (requirement qualified name, clause qualified name), never by clause id.
 *  - `tableAgree`, `tableProbes`, `tableDisagree` (T1, T2): rows of the differential table whose pinned SMT
 *    letter is decided, against the hand-computed answer; the probes are read statically, with no solver.
 *
 * Credit follows the BASIS of a row ({@link credit}): a proof the numeric surface decided never credits a
 * shape cell, and a table row has no solver verdict here, so a shape cell is credited only when its footprint
 * has no refused row in reach, every symbol its goal reads is pinned and no String feature is read. Any doubt
 * means no credit. A disagreement is the other way round: it is charged to every cell the row rests on.
 *
 * The same functions write `src/semantics/smt/class-facts.ts` (`scripts/measure-classes.ts`) and recompute the
 * facts to hold the committed ones against ({@link compareLevels}), in the census's `--check --strict` and in
 * `test/integration/constraint-class.census.test.ts`. Every count is a sum over rows, so the facts do not
 * depend on the order models were read in.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Model } from '../../src/core/index';
import { loadModelText } from '../../src/text/load';
import { axiomsOf, obligationsOf, reachOfRow, reachedBy, refusalReaches, type Obligation } from '../../src/semantics/obligations';
import { notTerm, type ScriptAssertion } from '../../src/semantics/smt/encode';
import {
  CELLS,
  CONSTRAINT_CLASSES,
  REGISTER_VERSION,
  basisOf,
  cellOfRow,
  classifyRow,
  levelOf,
  levelRank,
  searchOf,
  shapeCell,
  type Basis,
  type CellFacts,
  type ClassFacts,
  type ClassId,
  type Defect,
  type FenceFacts,
  type Layer,
  type LevelEnv,
  type RowClass,
} from '../../src/semantics/smt/classes';
import { pinnedSymbolsOf } from '../../src/semantics/smt/pinned';
import type { SmtOutcome } from '../../src/semantics/engines/smt';
import { encRow, extractProbes, relevant, scriptOf, assertedOf, type EncRow, type ProbeEntry } from './class-census';

/* ──────────────────────────────────── the corpus ──────────────────────────────────── */

export interface CorpusItem {
  corpus: 'examples' | 'l8' | 'agent' | 'v9';
  name: string;
  path: string;
}

const listDir = (dir: string, ext: string): string[] => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(ext)).sort() : []);

/** The models the `rows` fact counts: the published examples, the L8 models, v9, and (full) the agent inputs. */
export function factsCorpus(root: string, full: boolean): CorpusItem[] {
  const at = (corpus: CorpusItem['corpus'], dir: string, ext: string): CorpusItem[] =>
    listDir(join(root, dir), ext).map((f) => ({ corpus, name: `${dir}/${f}`, path: join(root, dir, f) }));
  const agentDir = join(root, 'test/fixtures/agent-authoring');
  const agent: CorpusItem[] = full
    ? readdirSync(agentDir)
        .sort()
        .filter((d) => existsSync(join(agentDir, d, 'input.sysml')))
        .map((d) => ({ corpus: 'agent' as const, name: `test/fixtures/agent-authoring/${d}/input.sysml`, path: join(agentDir, d, 'input.sysml') }))
    : [];
  return [
    ...at('examples', 'examples', '.sysml'),
    ...at('l8', 'test/fixtures/verification/models', '.sysml'),
    ...agent,
    { corpus: 'v9', name: 'test/fixtures/drone-swarm-v9.sysml.txt', path: join(root, 'test/fixtures/drone-swarm-v9.sysml.txt') },
  ];
}

const loaded = new Map<string, Promise<Model | undefined>>();

/** A corpus model, loaded once per process: the facts and the tests that check them read the same files. */
export function loadAt(path: string): Promise<Model | undefined> {
  let hit = loaded.get(path);
  if (!hit) {
    hit = loadModelText(readFileSync(path, 'utf8'), { library: 'full', fileName: basename(path).replace(/\.txt$/, '') }).then((r) => r.model ?? undefined);
    loaded.set(path, hit);
  }
  return hit;
}

/* ───────────────────────────────── one model, scanned ───────────────────────────────── */

/** A model's worklist, encoded the way the SMT engine encodes it, and each row's class. */
export interface Scan {
  model: Model;
  rows: Obligation[];
  enc: EncRow[];
  byRow: Map<Obligation, EncRow>;
  cls: Map<Obligation, RowClass>;
  /** The axiom rows the engine asserts (a freed stated value is not one). */
  axioms: EncRow[];
  /** What those axioms pin, strictly. */
  pinned: Set<string>;
}

export function scanModel(model: Model, free: ReadonlySet<string> = new Set()): Scan {
  const rows = obligationsOf(model);
  const enc = rows.map(encRow);
  const byRow = new Map(enc.map((e) => [e.row, e]));
  const cls = new Map<Obligation, RowClass>();
  for (const e of enc) cls.set(e.row, classifyRow(e.row, { model, ...(e.encoded ? { encoded: e.encoded } : {}) }));
  const axioms = axiomsOf(rows, free).map((r) => byRow.get(r)!);
  const pinned = pinnedSymbolsOf(model, axioms.filter((a) => a.encoded !== undefined).map((a) => ({ row: a.row, encoded: true as const })));
  return { model, rows, enc, byRow, cls, axioms, pinned };
}

/** What one goal rests on, and what it takes to credit it. */
export interface Proof {
  goal: EncRow;
  context: EncRow[];
  dropped: number;
  /** Maturity cells of the shapes in the proof: its rows, and its script. */
  shapes: Set<string>;
  modifiers: Set<string>;
  readings: Set<string>;
  scriptCell: string;
  /** Every symbol the goal reads is pinned. */
  goalPinned: boolean;
  textAsReal: boolean;
  pinnedKept: Set<string>;
}

/** The proof of an encoded goal: the footprint (kept axioms, premises), the cells of its rows and its script. */
export function proofOf(scan: Scan, goal: EncRow, freeKnown = false): Proof | undefined {
  if (goal.encoded === undefined) return undefined;
  const g = goal.encoded;
  const premises = scan.enc.filter((e) => e.row.role === 'premise' && e.row.requirement !== null && goal.row.requirement !== null && e.row.requirement.id === goal.row.requirement.id);
  const { kept, reached } = relevant(scan.axioms, premises, g);
  const context = [...kept, ...premises, goal];
  const pinnedKept = freeKnown
    ? new Set<string>()
    : pinnedSymbolsOf(scan.model, kept.filter((k) => k.encoded !== undefined).map((row) => ({ row: row.row, encoded: true as const })));
  const contextReached = reachedBy([
    ...context.filter((e) => e.encoded !== undefined).map((e) => ({ vars: e.row.vars, symbols: e.vars.map((v) => v.qualifiedName) })),
    { vars: [], symbols: reached },
  ]);
  const dropped =
    premises.filter((p) => p.encoded === undefined).length +
    kept.filter((a) => a.encoded === undefined && refusalReaches(reachOfRow(a.row, a.vars.map((v) => v.qualifiedName)), contextReached)).length;

  const shapes = new Set<string>();
  const modifiers = new Set<string>();
  const readings = new Set<string>();
  for (const e of context) {
    if (e.encoded === undefined) continue;
    const c = scan.cls.get(e.row)!;
    shapes.add(cellOfRow(c, pinnedKept));
    for (const m of c.modifiers) modifiers.add(m);
    if (c.reading !== null) readings.add(c.reading);
  }
  const assertions: ScriptAssertion[] = [
    ...assertedOf(kept, 'axiom'),
    ...assertedOf(premises, 'premise'),
    ...g.sideConditions.map((s) => ({ kind: 'side' as const, name: goal.row.element.qualifiedName || goal.row.expression, term: s.term })),
    { kind: 'goal', name: goal.row.element.qualifiedName || goal.row.expression, term: notTerm(g.term) },
  ];
  const { cls } = scriptOf(context, assertions);
  const scriptCell = shapeCell(cls.shape, searchOf(cls, pinnedKept));
  shapes.add(scriptCell);
  const reads = new Set(g.reads);
  const goalPinned = goal.vars.filter((v) => reads.has(v.qualifiedName)).every((v) => pinnedKept.has(v.qualifiedName));
  if (dropped > 0) modifiers.add('partial-context');
  return { goal, context, dropped, shapes, modifiers, readings, scriptCell, goalPinned, textAsReal: scan.cls.get(goal.row)!.modifiers.includes('text-as-real'), pinnedKept };
}

/** The cells a proof of the given basis credits (C.4): z3's work is credited to what z3 read, the numeric surface's to nothing it did not. */
export function credit(basis: Basis, p: Proof): Set<string> {
  const out = new Set<string>();
  if (basis === 'solver' || basis === 'solver-witness') {
    for (const set of [p.shapes, p.modifiers, p.readings]) for (const c of set) out.add(c);
  } else if (basis === 'solver+numeric') {
    for (const c of p.shapes) out.add(c);
    out.add('partial-context');
  } else if (basis === 'numeric-surface' || basis === 'point-evaluation') {
    for (const c of p.modifiers) if (c === 'partial-context' || c === 'text-as-real') out.add(c);
  }
  return out;
}

/** Every cell a proof rests on, whatever its basis: where a disagreement is charged. */
export function restsOf(p: Proof): Set<string> {
  return new Set([...p.shapes, ...p.modifiers, ...p.readings]);
}

/* ────────────────────────────────────── the sums ────────────────────────────────────── */

const EMPTY = (): CellFacts => ({ rows: 0, models: 0, encoderTests: 0, goldenDecided: 0, goldenCases: 0, tableAgree: 0, tableProbes: 0, tableDisagree: 0, battery: null });

class Sums {
  readonly cells = new Map<string, CellFacts>();
  private readonly models = new Map<string, Set<string>>();
  private readonly cases = new Map<string, Set<string>>();
  private readonly probes = new Map<string, Set<string>>();
  constructor() {
    for (const c of CELLS) this.cells.set(c, EMPTY());
  }
  get(cell: string): CellFacts {
    let f = this.cells.get(cell);
    if (!f) this.cells.set(cell, (f = EMPTY()));
    return f;
  }
  private mark(map: Map<string, Set<string>>, cell: string, id: string): void {
    let s = map.get(cell);
    if (!s) map.set(cell, (s = new Set()));
    s.add(id);
  }
  row(cell: string, model: string): void {
    this.get(cell).rows += 1;
    this.mark(this.models, cell, model);
  }
  golden(cell: string, caseName: string): void {
    this.get(cell).goldenDecided += 1;
    this.mark(this.cases, cell, caseName);
  }
  agree(cell: string, probe: string): void {
    this.get(cell).tableAgree += 1;
    this.mark(this.probes, cell, probe);
  }
  disagree(cell: string): void {
    this.get(cell).tableDisagree += 1;
  }
  done(): Record<string, CellFacts> {
    const out: Record<string, CellFacts> = {};
    for (const cell of [...this.cells.keys()].sort()) {
      const f = this.cells.get(cell)!;
      out[cell] = { ...f, models: this.models.get(cell)?.size ?? 0, goldenCases: this.cases.get(cell)?.size ?? 0, tableProbes: this.probes.get(cell)?.size ?? 0 };
    }
    return out;
  }
}

/** The cells a row stands in: its primary cell, its modifiers, its reading and its fence. */
function cellsOfRow(c: RowClass, pinned: ReadonlySet<string>): string[] {
  return [cellOfRow(c, pinned), ...c.modifiers, ...(c.reading !== null ? [c.reading] : [])];
}

/** Count the rows of one model (and the proofs whose script outranks every row, and partial contexts). */
function countRows(sums: Sums, scan: Scan, name: string): void {
  for (const e of scan.enc) for (const cell of cellsOfRow(scan.cls.get(e.row)!, scan.pinned)) sums.row(cell, name);
  for (const g of scan.enc) {
    if (g.row.role !== 'obligation' || g.encoded === undefined) continue;
    const p = proofOf(scan, g);
    if (!p) continue;
    // A script cell no row of its proof stands in (the script is stronger than any row) is a stand-in of its own.
    const rowCells = new Set(p.context.filter((e) => e.encoded !== undefined).map((e) => cellOfRow(scan.cls.get(e.row)!, p.pinnedKept)));
    if (!rowCells.has(p.scriptCell)) sums.row(p.scriptCell, name);
    if (p.dropped > 0) sums.row('partial-context', name);
  }
}

/* ───────────────────────────────────── the goldens ───────────────────────────────────── */

interface GoldenCase {
  name: string;
  model: string;
  free: string[];
  obligations: Array<{ requirement: string | null; clause: string; claim: string }>;
}

/** The SMT cases of the L8 goldens: the model each runs, and the rows it pins. */
export function goldenCases(root: string): GoldenCase[] {
  const dir = join(root, 'test/fixtures/verification');
  const out: GoldenCase[] = [];
  for (const name of readdirSync(dir).sort()) {
    const meta = join(dir, name, 'meta.json');
    if (!existsSync(meta)) continue;
    const m = JSON.parse(readFileSync(meta, 'utf8')) as { model: string; engine: string; free?: string[] };
    if (m.engine !== 'smt') continue;
    const expected = JSON.parse(readFileSync(join(dir, name, 'expected.json'), 'utf8')) as { obligations: GoldenCase['obligations'] };
    out.push({ name, model: m.model, free: m.free ?? [], obligations: expected.obligations });
  }
  return out;
}

/** The outcome word a golden claim stands for, for the claims that carry a solver verdict. */
const GOLDEN_OUTCOME: Record<string, SmtOutcome | undefined> = { proved: 'proved', refuted: 'refuted' };

async function countGoldens(sums: Sums, root: string): Promise<{ decided: number; unmatched: string[] }> {
  let decided = 0;
  const unmatched: string[] = [];
  const models = new Map<string, Scan | undefined>();
  for (const c of goldenCases(root)) {
    const freeKnown = c.free.length > 0;
    const key = `${c.model}\u0000${freeKnown}`;
    if (!models.has(key)) {
      const model = await loadAt(join(root, c.model));
      models.set(key, model ? scanModel(model, new Set(c.free)) : undefined);
    }
    const scan = models.get(key);
    if (!scan) {
      unmatched.push(`${c.name}: the model did not load`);
      continue;
    }
    const goals = scan.enc.filter((e) => e.row.role === 'obligation');
    const pool = new Map<string, EncRow[]>();
    for (const g of goals) {
      const k = `${g.row.requirement?.qualifiedName ?? '-'}\u0000${g.row.element.qualifiedName}`;
      (pool.get(k) ?? pool.set(k, []).get(k)!).push(g);
    }
    for (const o of c.obligations) {
      const outcome = GOLDEN_OUTCOME[o.claim];
      if (outcome === undefined) continue;
      const g = pool.get(`${o.requirement ?? '-'}\u0000${o.clause}`)?.shift();
      if (!g) {
        unmatched.push(`${c.name}: ${o.requirement ?? '-'} :: ${o.clause}`);
        continue;
      }
      decided += 1;
      const p = proofOf(scan, g, freeKnown);
      if (!p) continue; // a fenced goal: a point evaluation, which credits no encoded cell
      const goalSymbols = g.vars.filter((v) => new Set(g.encoded!.reads).has(v.qualifiedName)).map((v) => v.qualifiedName);
      const basis = basisOf(outcome, { goalRefused: false, dropped: p.dropped > 0, partialAntecedent: false, goalSymbols, textAsReal: p.textAsReal }, p.pinnedKept);
      // A `--free` case reads its nonlinear sites as `/free` whatever they are (the weaker reading), so it credits
      // no nonlinear cell, `/pinned` or `/free`: it cannot say which of the two the proof stood on.
      for (const cell of credit(basis, p)) if (!(freeKnown && cell.includes('/'))) sums.golden(cell, c.name);
    }
  }
  return { decided, unmatched };
}

/* ───────────────────────────────────── the table ───────────────────────────────────── */

/**
 * The `'probe | row'` keys of a `new Map([...])` or `new Set([...])` block of the differential test (the first
 * string of each entry of a Map, every string of a Set), `[]` for an empty block, `null` if it is not found or
 * cannot be read: the caller treats that as a block it cannot attribute.
 */
export function blockKeys(source: string, name: string): string[] | null {
  const at = source.indexOf(`const ${name} = new `);
  if (at < 0) return null;
  const isMap = source.startsWith('Map', at + `const ${name} = new `.length);
  let i = source.indexOf('(', at);
  if (i < 0) return null;
  const open = source.slice(i + 1).match(/^\s*(\)|\[)/);
  if (!open) return null;
  if (open[1] === ')') return [];
  i = source.indexOf('[', i);
  const keys: string[] = [];
  let depth = 0;
  let expectKey = false;
  for (; i < source.length; i += 1) {
    const ch = source[i]!;
    if (ch === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i);
      if (i < 0) return null;
    } else if (ch === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i);
      if (i < 0) return null;
      i += 1;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      const begin = i + 1;
      for (i += 1; i < source.length && source[i] !== ch; i += source[i] === '\\' ? 2 : 1);
      if (i >= source.length) return null;
      if (isMap ? depth === 2 && expectKey : depth === 1) keys.push(source.slice(begin, i));
      expectKey = false;
    } else if (ch === '[' || ch === '(' || ch === '{') {
      depth += 1;
      expectKey = depth === 2 && ch === '[';
    } else if (ch === ']' || ch === ')' || ch === '}') {
      depth -= 1;
      if (depth === 0) return keys;
    }
  }
  return null;
}

const letterOf = (letters: string, surface: number): string => letters.split('/')[surface] ?? '?';
const decidedLetter = (l: string): boolean => l === 'T' || l === 'F';

export interface TableResult {
  extracted: number;
  rows: number;
  unmatched: number;
  failed: string[];
  knownFalse: ClassFacts['knownFalse'];
  digest: string;
}

async function countTable(sums: Sums, root: string, shard?: { k: number; n: number }): Promise<TableResult> {
  const source = readFileSync(join(root, 'test/integration/verification.differential.test.ts'), 'utf8');
  const { entries: raw, region } = extractProbes(source);
  // The table is an object: a name filed twice keeps the last.
  const byName = new Map<string, ProbeEntry>();
  for (const e of raw) byName.set(e.name, e);
  const entries = [...byName.values()];

  const known = {
    KNOWN_FALSE: blockKeys(source, 'KNOWN_FALSE'),
    KNOWN_FALSE_WITNESS: blockKeys(source, 'KNOWN_FALSE_WITNESS'),
    SAME_POINT_DEMOTED: blockKeys(source, 'SAME_POINT_DEMOTED'),
  };
  const parsed = Object.values(known).every((k) => k !== null);
  const named = new Map<string, 'KNOWN_FALSE' | 'KNOWN_FALSE_WITNESS' | 'SAME_POINT_DEMOTED'>();
  let entriesCount = 0;
  let unattributed = 0;
  for (const [block, keys] of Object.entries(known) as Array<[keyof typeof known, string[] | null]>) {
    for (const key of keys ?? []) {
      entriesCount += 1;
      const [probe, row] = key.split(' | ');
      const hit = byName.get(probe ?? '')?.rows.find((r) => r.key === row);
      if (!hit) unattributed += 1;
      else named.set(key, block);
    }
  }

  let rowsSeen = 0;
  let unmatched = 0;
  const failed: string[] = [];
  for (const [idx, e] of entries.entries()) {
    if (shard && idx % shard.n !== shard.k) continue;
    const model = (await loadModelText(e.text, { library: 'full', fileName: `${e.name}.sysml` })).model;
    if (!model) {
      failed.push(e.name);
      continue;
    }
    const scan = scanModel(model);
    // A row's name as the table writes it: the worklist adds ` (X's own)` to a relation read in its own type.
    const byRowName = new Map<string, EncRow[]>();
    for (const r of scan.rows) {
      const nm = r.element.qualifiedName.replace(/ \([^()]*'s own\)$/, '');
      (byRowName.get(nm) ?? byRowName.set(nm, []).get(nm)!).push(scan.byRow.get(r)!);
    }
    for (const pin of e.rows) {
      rowsSeen += 1;
      const found = byRowName.get(pin.key);
      if (!found) {
        unmatched += 1;
        continue;
      }
      const g = found.find((x) => x.row.role === 'obligation') ?? found[0]!;
      const smt = letterOf(pin.letters, 3);
      const listed = named.get(`${e.name} | ${pin.key}`);
      const differs = decidedLetter(smt) && smt !== pin.ref;
      const charged = differs || listed === 'KNOWN_FALSE_WITNESS' || listed === 'SAME_POINT_DEMOTED';
      if (!decidedLetter(smt) && !charged) continue;
      const proof = proofOf(scan, g);
      if (charged) {
        // Over-attribution is the safe direction: every cell the row rests on, whatever the basis.
        const cells = proof ? restsOf(proof) : new Set<string>();
        cells.add(cellOfRow(scan.cls.get(g.row)!, scan.pinned));
        for (const c of cells) sums.disagree(c);
        continue;
      }
      if (!proof) continue; // a fenced goal credits no encoded cell
      // No solver verdict here: any doubt about what decided the row is no credit.
      if (proof.dropped > 0 || !proof.goalPinned || proof.textAsReal) continue;
      for (const cell of credit(smt === 'T' ? 'solver' : 'solver-witness', proof)) sums.agree(cell, e.name);
    }
  }
  const digest = sha(source.slice(region.from, region.to) + (['KNOWN_FALSE', 'KNOWN_FALSE_WITNESS', 'SAME_POINT_DEMOTED'] as const).map((b) => `\n${b}=${JSON.stringify(known[b])}`).join(''));
  return { extracted: entries.length, rows: rowsSeen, unmatched, failed, knownFalse: { parsed, entries: entriesCount, unattributed }, digest };
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

/* ───────────────────────────── the register's own pointers ───────────────────────────── */

const fileCache = new Map<string, string>();
function textOf(root: string, file: string): string {
  const key = `${root}\u0000${file}`;
  let t = fileCache.get(key);
  if (t === undefined) {
    const p = join(root, file);
    fileCache.set(key, (t = existsSync(p) ? readFileSync(p, 'utf8') : ''));
  }
  return t;
}

/** Does a pointer of the register still resolve? The exact string, in the file. */
export const resolves = (root: string, p: { file: string; find: string }): boolean => textOf(root, p.file).includes(p.find);

function countPointers(sums: Sums, root: string): Record<string, FenceFacts> {
  const fences: Record<string, FenceFacts> = {};
  for (const [id, def] of Object.entries(CONSTRAINT_CLASSES) as Array<[ClassId, (typeof CONSTRAINT_CLASSES)[ClassId]]>) {
    const live = def.tests.filter((t) => resolves(root, t));
    if (def.family === 'fence') {
      fences[id] = {
        layersPinned: [...new Set(live.flatMap((t) => (t.layer ? [t.layer] : [])))].sort() as Layer[],
        stems: def.pointers.every((p) => resolves(root, p)),
      };
      sums.get(id).encoderTests = live.length;
    } else {
      // A shape or modifier or reading is counted under each of its maturity cells.
      for (const cell of CELLS.filter((c) => c === id || c.startsWith(`${id}/`))) sums.get(cell).encoderTests = live.length;
    }
  }
  return fences;
}

/* ───────────────────────────────────── the defects ───────────────────────────────────── */

export const DEFECTS_FILE = 'docs/constraint-class-defects.json';

export interface DefectsFile {
  version: number;
  defects: Defect[];
  /** Titles of `TODO.md` entries that do not exist yet (the coordinator appends them); the sidecar test allows these. */
  pending?: Array<{ todo: string; note: string }>;
  resolved: Array<{ todo: string; by: string }>;
}

export function readDefects(root: string): { file: DefectsFile; text: string } {
  const text = readFileSync(join(root, DEFECTS_FILE), 'utf8');
  return { file: JSON.parse(text) as DefectsFile, text };
}

/* ─────────────────────────────────────── the facts ─────────────────────────────────────── */

export function z3Release(root: string): string {
  const p = join(root, 'node_modules/z3-solver/package.json');
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as { version: string }).version : '';
}

export interface FactsOptions {
  root: string;
  /** Include the agent-authoring inputs in `rows` (the full measure). */
  full: boolean;
  /** Read the differential table (about 700 probes, no solver). */
  table: boolean;
  shard?: { k: number; n: number };
  /** Called with a note for each model read (progress). */
  log?: (line: string) => void;
}

export interface LiveFacts {
  facts: ClassFacts;
  notes: string[];
  unmatchedGoldens: string[];
  table: TableResult | null;
}

/** Measure everything. With `table: false` the table fields are 0 and `digests.probes` is the digest of nothing. */
export async function computeFacts(opts: FactsOptions): Promise<LiveFacts> {
  const sums = new Sums();
  const notes: string[] = [];
  for (const item of factsCorpus(opts.root, opts.full)) {
    const model = await loadAt(item.path);
    if (!model) {
      notes.push(`${item.name}: the model did not load`);
      continue;
    }
    countRows(sums, scanModel(model), item.name);
    opts.log?.(item.name);
  }
  const fences = countPointers(sums, opts.root);
  const goldens = await countGoldens(sums, opts.root);
  const table = opts.table ? await countTable(sums, opts.root, opts.shard) : null;

  const dirs = readdirSync(join(opts.root, 'test/fixtures/verification')).sort();
  const goldenText = dirs
    .filter((d) => existsSync(join(opts.root, 'test/fixtures/verification', d, 'meta.json')))
    .map((d) => `${d}\n${textOf(opts.root, `test/fixtures/verification/${d}/meta.json`)}\n${textOf(opts.root, `test/fixtures/verification/${d}/expected.json`)}`)
    .join('\n');
  const { file: dfile, text: dtext } = readDefects(opts.root);
  const facts: ClassFacts = {
    register: REGISTER_VERSION,
    z3: z3Release(opts.root),
    digests: { probes: table ? table.digest : '', goldens: sha(goldenText), defects: sha(dtext) },
    knownFalse: table ? table.knownFalse : { parsed: false, entries: 0, unattributed: 0 },
    cells: sums.done(),
    fences,
    defects: dfile.defects,
  };
  return { facts, notes, unmatchedGoldens: goldens.unmatched, table };
}

/* ─────────────────────────────── writing and holding them ─────────────────────────────── */

const sortKeys = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, sortKeys(x)])) : v;

/** The text of `src/semantics/smt/class-facts.ts`. */
export function renderFactsModule(facts: ClassFacts): string {
  const body = JSON.stringify(sortKeys(facts), null, 2);
  return [
    '// GENERATED by scripts/measure-classes.ts (npm run measure:classes). Do not edit by hand:',
    '// the facts are what the repository holds, counted with no solver, and `npm run census:classes -- --check --strict`',
    '// holds this file to a recount. Content digests only: no clock, no commit.',
    "import type { ClassFacts } from './classes';",
    '',
    `export const CLASS_FACTS: ClassFacts = ${body};`,
    '',
  ].join('\n');
}

export interface LevelDiff {
  cell: string;
  committed: string;
  live: string;
}

/**
 * The cells whose committed level is above the level the live facts give: the facts overstate. `fields` is the
 * part of the live facts to hold the committed ones against; the rest stays as committed (the cheap recount,
 * which does not read the differential table, holds only the cheap fields).
 */
export function compareLevels(committed: ClassFacts, live: ClassFacts, fields: 'cheap' | 'all', env: LevelEnv = {}): LevelDiff[] {
  const merged: ClassFacts =
    fields === 'all'
      ? live
      : {
          ...committed,
          cells: Object.fromEntries(
            Object.entries(committed.cells).map(([cell, f]) => {
              const l = live.cells[cell];
              return [cell, l ? { ...f, encoderTests: l.encoderTests, goldenDecided: l.goldenDecided, goldenCases: l.goldenCases } : f];
            }),
          ),
          fences: live.fences,
          defects: live.defects,
        };
  const out: LevelDiff[] = [];
  for (const cell of CELLS) {
    const a = levelOf(cell, { ...env, facts: committed });
    const b = levelOf(cell, { ...env, facts: merged });
    if (levelRank(a) > levelRank(b)) out.push({ cell, committed: a, live: b });
  }
  return out;
}
