/**
 * The constraint-class census (step S0 of the constraint-classes plan): an INVENTORY of everything the
 * SMT lane hands to z3, or refuses to hand over, sorted into the classes the plan proposes.
 *
 * LABEL ONLY, and it adds nothing to `src/`. It reads the worklist (`obligationsOf`), the encoder's own
 * bytes (`encodeRelation`, `encodeScript`) and, with `--verdicts`, the verdicts `verifyModel` gives. The
 * classifier is carried HERE, twice, on purpose: once from the BYTES the encoder emitted (the derivation
 * `shape.ts` will move into `src/` at S1) and once from the AST (an independent oracle). A row on which the
 * two disagree is listed, never settled by choosing one.
 *
 * Everything counted is a sum over rows, so two partial censuses merge by adding their counts
 * ({@link mergeCensus}); that is what `--shard` and `--merge` rely on, and why no count here depends on
 * the order models were read in.
 */
import { createHash } from 'node:crypto';
import type { ElementId, Model } from '../../src/core/index';
import { generalizationsOf } from '../../src/semantics/inheritance';
import {
  axiomsOf,
  obligationsOf,
  reachOfRow,
  reachedBy,
  refusalReaches,
  type Obligation,
} from '../../src/semantics/obligations';
import type { ExprNode } from '../../src/semantics/expr';
import type { Refusal, RefusalReason, VarSort } from '../../src/semantics/contracts';
import {
  encodeRelation,
  encodeScript,
  encodeVariables,
  notTerm,
  symbolOf,
  type EncodeVariable,
  type EncodedRelation,
  type ScriptAssertion,
} from '../../src/semantics/smt/encode';
import { encodedFootprint } from '../../src/semantics/engines/smt';
import type { ObligationVerdict } from '../../src/api/verification';

/* ───────────────────────────────── vocabulary ───────────────────────────────── */

/** The seven shapes, weakest first: the precedence is the index. */
export const SHAPES = ['ground', 'bool', 'lra', 'lira', 'nra-poly', 'nra-div', 'nira'] as const;
export type ShapeId = (typeof SHAPES)[number];
const RANK = new Map<string, number>(SHAPES.map((s, i) => [s, i]));

/** The `set-logic` each shape stands for. `ground` and `bool` are scripts the encoder headers QF_LRA. */
export const SHAPE_LOGIC: Record<ShapeId, string> = {
  ground: 'QF_LRA',
  bool: 'QF_LRA',
  lra: 'QF_LRA',
  lira: 'QF_LIRA',
  'nra-poly': 'QF_NRA',
  'nra-div': 'QF_NRA',
  nira: 'QF_NIRA',
};

export const MODIFIERS = ['units', 'offset-order', 'ite', 'div-guard', 'text-as-real'] as const;
export const READINGS = [
  'stated-value',
  'defining-equation',
  'bind-equality',
  'asserted-fact',
  'requirement-clause',
  'inherited-context',
  'per-instance',
  'own-symbol',
] as const;
export type ReadingId = (typeof READINGS)[number];
/** The reading of a row with no formal clause at all: it has none, and the census says so. */
export const NO_READING = '(none)';

/** Every `RefusalReason`, as the plan's fence ids. `Record` makes `tsc` fail if the type grows. */
const FENCE_SET: Record<RefusalReason, true> = {
  'no-formal-clause': true,
  unparseable: true,
  'unresolved-name': true,
  'unit-unresolved': true,
  'dimension-clash': true,
  'offset-arithmetic': true,
  'derived-bare-literal': true,
  'refused-derivation': true,
  'unread-definition': true,
  'unread-binding': true,
  unscalable: true,
  'collection-valued': true,
  'unsupported-operator': true,
  'non-numeric-operand': true,
};
export const FENCES = Object.keys(FENCE_SET) as RefusalReason[];

/** What decided the verdict word, as far as it can be told from the report alone. */
export const BASES = ['solver', 'solver-witness', 'solver+numeric', 'numeric-surface', 'point-evaluation', 'none'] as const;
export type Basis = (typeof BASES)[number];

/* ───────────────────────────── the bytes of a term ───────────────────────────── */

type Sexp = string | Sexp[];

/** Tokenise and nest, `|a::b|` being one atom. Mirrors the encoder's own scan, by design a copy. */
function parseSexps(text: string): Sexp[] {
  const stack: Sexp[][] = [[]];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '(') {
      const child: Sexp[] = [];
      stack[stack.length - 1]!.push(child);
      stack.push(child);
      i += 1;
    } else if (c === ')') {
      if (stack.length > 1) stack.pop();
      i += 1;
    } else if (c === '|') {
      const end = text.indexOf('|', i + 1);
      if (end === -1) return stack[0]!;
      stack[stack.length - 1]!.push(text.slice(i, end + 1));
      i = end + 1;
    } else if (/\s/.test(c)) {
      i += 1;
    } else {
      let j = i;
      while (j < text.length && !/[\s()|]/.test(text[j]!)) j += 1;
      stack[stack.length - 1]!.push(text.slice(i, j));
      i = j;
    }
  }
  return stack[0]!;
}

const carries = (s: Sexp): boolean =>
  Array.isArray(s) ? s.slice(1).some(carries) : !/^[+-]?\d/.test(s) && s !== 'true' && s !== 'false';

/** What the bytes of one or more terms say, before any sort is known. */
export interface TermFacts {
  /** The quoted symbols the bytes carry. */
  symbols: Set<string>;
  /** A product of two symbol-carrying operands, a division by a symbol-carrying term, or a `^`. */
  nonlinear: boolean;
  /** A division whose divisor carries a symbol. */
  divSym: boolean;
  /** The symbols under the nonlinear subterms. */
  nlSymbols: Set<string>;
  /** An `ite` head. */
  ite: boolean;
  /** An arithmetic head (`+ - * / ^`). */
  arith: boolean;
}

export function termFacts(texts: readonly string[]): TermFacts {
  const f: TermFacts = { symbols: new Set(), nonlinear: false, divSym: false, nlSymbols: new Set(), ite: false, arith: false };
  const symbolsUnder = (s: Sexp, into: Set<string>): void => {
    if (Array.isArray(s)) for (const c of s) symbolsUnder(c, into);
    else if (s.startsWith('|')) into.add(s);
  };
  const walk = (s: Sexp): void => {
    if (!Array.isArray(s) || s.length === 0) {
      if (typeof s === 'string' && s.startsWith('|')) f.symbols.add(s);
      return;
    }
    const head = s[0];
    const args = s.slice(1);
    if (head === 'ite') f.ite = true;
    if (head === '+' || head === '-' || head === '*' || head === '/' || head === '^') f.arith = true;
    let nl = false;
    if (head === '*' && args.filter(carries).length >= 2) nl = true;
    if (head === '/' && args.slice(1).some(carries)) {
      nl = true;
      f.divSym = true;
    }
    if (head === '^') nl = true;
    if (nl) {
      f.nonlinear = true;
      symbolsUnder(s, f.nlSymbols);
    }
    for (const c of s) walk(c);
  };
  for (const t of texts) for (const s of parseSexps(t)) walk(s);
  return f;
}

/** The plan's C.1 shape rule, over the bytes and the encoder's own walk flags. */
export function shapeOfBytes(
  facts: TermFacts,
  sortOfSymbol: ReadonlyMap<string, VarSort>,
  walk: { syntacticNonlinear: boolean; sides: number },
): { shape: ShapeId; nonlinear: boolean; int: boolean } {
  const nonlinear = walk.syntacticNonlinear || facts.nonlinear;
  const sorts = [...facts.symbols].map((s) => sortOfSymbol.get(s));
  const int = sorts.includes('Int');
  const real = sorts.some((s) => s !== 'Bool');
  const shape: ShapeId = nonlinear
    ? int
      ? 'nira'
      : facts.divSym || walk.sides > 0
        ? 'nra-div'
        : 'nra-poly'
    : int
      ? 'lira'
      : real
        ? 'lra'
        : facts.symbols.size > 0
          ? 'bool'
          : 'ground';
  return { shape, nonlinear, int };
}

/* ─────────────────────────────── the AST oracle ─────────────────────────────── */

interface AstFacts {
  /** Symbols the BYTES carry (a `^ 0` drops its base). */
  syms: Set<string>;
  /** Any reference at all, dropped ones included (the encoder's walk flags read these). */
  refs: boolean;
  nl: boolean;
  divSide: boolean;
}

function literalExponent(n: ExprNode): number | undefined {
  if (n.kind === 'num') return n.value;
  if (n.kind === 'unary' && n.op === '-' && n.operand.kind === 'num') return -n.operand.value;
  return undefined;
}

function astWalk(n: ExprNode, byPath: ReadonlyMap<string, EncodeVariable>): AstFacts {
  const none = (): AstFacts => ({ syms: new Set(), refs: false, nl: false, divSide: false });
  const join = (...xs: AstFacts[]): AstFacts => ({
    syms: new Set(xs.flatMap((x) => [...x.syms])),
    refs: xs.some((x) => x.refs),
    nl: xs.some((x) => x.nl),
    divSide: xs.some((x) => x.divSide),
  });
  switch (n.kind) {
    case 'ref': {
      const v = byPath.get(n.path.join('.'));
      return { ...none(), syms: new Set(v ? [v.qualifiedName] : []), refs: true };
    }
    case 'unary':
      return astWalk(n.operand, byPath);
    case 'if':
      return join(astWalk(n.cond, byPath), astWalk(n.then, byPath), astWalk(n.else, byPath));
    case 'binary': {
      const l = astWalk(n.left, byPath);
      const r = astWalk(n.right, byPath);
      const both = join(l, r);
      if (n.op === '*') return { ...both, nl: both.nl || (l.refs && r.refs) };
      if (n.op === '/') return { ...both, nl: both.nl || r.refs, divSide: both.divSide || r.refs };
      if (n.op === '^') {
        const e = literalExponent(n.right);
        if (e === 0) return { ...none(), refs: l.refs, nl: l.nl, divSide: l.divSide }; // the read is dropped
        if (e !== undefined && e >= 2) return { ...l, nl: l.nl || l.refs };
        return l;
      }
      return both;
    }
    default:
      return none();
  }
}

/** The shape the AST says, modelling the `^ 0` read-drop and `^ 1`. */
export function astShape(node: ExprNode, vars: readonly EncodeVariable[]): ShapeId {
  const f = astWalk(node, new Map(vars.map((v) => [v.path, v])));
  const sort = new Map(vars.map((v) => [v.qualifiedName, v.sort]));
  const sorts = [...f.syms].map((s) => sort.get(s));
  const int = sorts.includes('Int');
  if (f.nl) return int ? 'nira' : f.divSide ? 'nra-div' : 'nra-poly';
  if (int) return 'lira';
  if (sorts.some((s) => s !== 'Bool')) return 'lra';
  return f.syms.size > 0 ? 'bool' : 'ground';
}

/* ─────────────────────────────── row classification ─────────────────────────────── */

/** `ref == literal`, either way round. */
function isLiteralEquality(node: ExprNode | null): boolean {
  if (node?.kind !== 'binary' || node.op !== '==') return false;
  const lit = (n: ExprNode): boolean =>
    n.kind === 'num' || n.kind === 'bool' || n.kind === 'str' || (n.kind === 'unary' && (n.op === '-' || n.op === '+') && n.operand.kind === 'num');
  return (node.left.kind === 'ref' && lit(node.right)) || (node.right.kind === 'ref' && lit(node.left));
}

/** The plan's C.1 reading rule. */
export function readingOf(row: Obligation): ReadingId | typeof NO_READING {
  if ((row.unread?.length ?? 0) > 0) return 'own-symbol';
  if (row.instance?.path !== undefined || row.vars.some((v) => v.instance !== undefined)) return 'per-instance';
  if (row.instance !== undefined) return 'inherited-context';
  switch (row.source) {
    case 'feature-value':
      return isLiteralEquality(row.node) ? 'stated-value' : 'defining-equation';
    case 'calculation':
      return 'defining-equation';
    case 'bind':
      return 'bind-equality';
    case 'assert':
      return 'asserted-fact';
    case 'none':
      return NO_READING;
    default:
      return 'requirement-clause';
  }
}

/** Does the declared-type closure of this feature name `String`? (`contracts.ts` `sortOf`'s name set.) */
function textAsReal(model: Model, featureId: string): boolean {
  const el = model.get(featureId as ElementId);
  if (!el) return false;
  const names = new Set<string>();
  for (const t of model.typesOf(el.id)) {
    if (t.declaredName) names.add(t.declaredName);
    for (const g of generalizationsOf(model, t.id)) if (g.declaredName) names.add(g.declaredName);
  }
  const declared = el.attrs.type;
  if (typeof declared === 'string') names.add(declared.includes('::') ? declared.slice(declared.lastIndexOf('::') + 2) : declared);
  return names.has('String');
}

/** One worklist row, encoded the way the SMT engine encodes it, with the refusal if there is one. */
interface EncRow {
  row: Obligation;
  vars: EncodeVariable[];
  encoded?: EncodedRelation;
  refusal?: Refusal;
  layer?: 'gate' | 'encoder';
}

function encRow(row: Obligation): EncRow {
  const vars = encodeVariables(row.vars, row.sortPerVar, { scaled: row.scaled, free: new Set() });
  if (row.node === null || row.encodable !== true) {
    return row.encodable === true
      ? { row, vars, refusal: { reason: 'unparseable', detail: 'the relation has no readable body' }, layer: 'gate' }
      : { row, vars, refusal: row.encodable, layer: 'gate' };
  }
  const e = encodeRelation(row.node, vars);
  return e.ok ? { row, vars, encoded: e } : { row, vars, refusal: e.refusal, layer: 'encoder' };
}

const symbolSorts = (vars: readonly EncodeVariable[]): Map<string, VarSort> => {
  const m = new Map<string, VarSort>();
  for (const v of vars) {
    const s = symbolOf(v.qualifiedName);
    if (s !== undefined) m.set(s, v.sort);
  }
  return m;
};

/* ───────────────────────────── pinned versus free ───────────────────────────── */

/**
 * The symbols a set of asserted axioms fixes, by the plan's strict rule (C.2): a defining row pins its
 * left-hand feature only if that feature does not occur on its own right-hand side and every symbol of the
 * right-hand side is already pinned; a `bind` pins both ends once either is pinned; an own symbol never pins.
 * Mutual definitions stay unpinned. This is NOT the engine's `pinnedSymbols`.
 */
export function pinnedStrict(axioms: readonly EncRow[]): Set<string> {
  const pinned = new Set<string>();
  const rows = axioms.filter((a) => a.encoded !== undefined);
  const qn = (r: EncRow, path: string): string | undefined => r.vars.find((v) => v.path === path)?.qualifiedName;
  const refsOf = (n: ExprNode): string[] =>
    n.kind === 'ref'
      ? [n.path.join('.')]
      : n.kind === 'unary'
        ? refsOf(n.operand)
        : n.kind === 'binary'
          ? [...refsOf(n.left), ...refsOf(n.right)]
          : n.kind === 'if'
            ? [...refsOf(n.cond), ...refsOf(n.then), ...refsOf(n.else)]
            : [];
  for (let grew = true; grew; ) {
    grew = false;
    for (const a of rows) {
      const node = a.row.node;
      if (node?.kind !== 'binary' || node.op !== '==') continue;
      if (a.row.source === 'bind' && node.left.kind === 'ref' && node.right.kind === 'ref') {
        const l = qn(a, node.left.path.join('.'));
        const r = qn(a, node.right.path.join('.'));
        if (l !== undefined && r !== undefined && pinned.has(l) !== pinned.has(r)) {
          pinned.add(l);
          pinned.add(r);
          grew = true;
        }
        continue;
      }
      if (!['feature-value', 'calculation', 'assert'].includes(a.row.source)) continue;
      if (node.left.kind !== 'ref') continue;
      const leftPath = node.left.path.join('.');
      const target = a.row.vars.find((v) => v.path === leftPath);
      if (!target || target.symbol !== undefined) continue;
      const symbol = target.qualifiedName;
      if (pinned.has(symbol)) continue;
      const rhs = refsOf(node.right);
      if (rhs.includes(leftPath)) continue;
      const rhsSymbols = rhs.map((p) => qn(a, p));
      if (rhsSymbols.some((s) => s === undefined || s === symbol || !pinned.has(s))) continue;
      pinned.add(symbol);
      grew = true;
    }
  }
  return pinned;
}

/* ──────────────────────────────── the census ──────────────────────────────── */

/** Every count is a sum over rows or proofs, keyed by a tab-joined tuple, so two censuses add. */
export interface Census {
  /** corpus, cell, layer, role, source, reading, search, modifiers, verdict, basis -> rows. */
  rows: Record<string, number>;
  /** corpus, goal cell, script cell, script logic, search, outranks, dropped, verdict, basis -> proofs. */
  proofs: Record<string, number>;
  /** corpus -> models read, loaded and failed to load. */
  models: Record<string, { read: number; loaded: number; failed: number }>;
  /** Named violations of the self-check invariants, each a count. */
  checks: Record<string, number>;
  /** shape -> logic -> rows, for the "each class maps to one logic" invariant. */
  logics: Record<string, number>;
  /** Named counters that are not a tuple of the row table. */
  facts: Record<string, number>;
  /** Free-text findings, by topic, capped. */
  notes: Record<string, string[]>;
  /** Per example model: rows, encoded rows, shape counts, units rows. */
  perModel: Record<string, { rows: number; encoded: number; units: number; shapes: Record<string, number> }>;
  /** The `--probes` section, when asked for. */
  probes?: ProbeCensus;
  verdicts: boolean;
}

export interface ProbeCensus {
  /** Named `probe(...)` entries. */
  total: number;
  extracted: number;
  interpolated: string[];
  /** Spread generators (`...reversed(...)`), each filing more than one probe. */
  spreads: number;
  /** Pinned row names (all extracted probes), and how many met a worklist row. */
  pinnedRows: number;
  unmatched: number;
  /** goal cell -> smt letter -> `agree` / `differ` / `undecided` -> rows. */
  byCell: Record<string, number>;
  /** Probes whose text did not load. */
  failed: string[];
}

export function newCensus(verdicts: boolean): Census {
  return { rows: {}, proofs: {}, models: {}, checks: {}, logics: {}, facts: {}, notes: {}, perModel: {}, verdicts };
}

const NOTE_CAP = 25;
const bump = (m: Record<string, number>, key: string, by = 1): void => {
  m[key] = (m[key] ?? 0) + by;
};
function note(c: Census, topic: string, text: string): void {
  const list = (c.notes[topic] ??= []);
  if (!list.includes(text)) list.push(text);
}
function violation(c: Census, name: string, text: string): void {
  bump(c.checks, name);
  note(c, name, text);
}

/** Add `b` into `a`. Counts add (the probe table's too), notes union (sorted, capped), `perModel` is taken as it comes. */
export function mergeCensus(a: Census, b: Census): Census {
  const add = (x: Record<string, number>, y: Record<string, number>): void => {
    for (const [k, v] of Object.entries(y)) bump(x, k, v);
  };
  add(a.rows, b.rows);
  add(a.proofs, b.proofs);
  add(a.checks, b.checks);
  add(a.logics, b.logics);
  add(a.facts, b.facts ?? {});
  for (const [k, v] of Object.entries(b.models)) {
    const m = (a.models[k] ??= { read: 0, loaded: 0, failed: 0 });
    m.read += v.read;
    m.loaded += v.loaded;
    m.failed += v.failed;
  }
  for (const [k, v] of Object.entries(b.notes)) a.notes[k] = [...new Set([...(a.notes[k] ?? []), ...v])].sort().slice(0, NOTE_CAP);
  Object.assign(a.perModel, b.perModel);
  if (b.probes && a.probes) {
    a.probes.pinnedRows += b.probes.pinnedRows;
    a.probes.unmatched += b.probes.unmatched;
    add(a.probes.byCell, b.probes.byCell);
    a.probes.failed = [...new Set([...a.probes.failed, ...b.probes.failed])].sort();
  } else if (b.probes) a.probes = b.probes;
  a.verdicts = a.verdicts || b.verdicts;
  return a;
}

/** The verdict word a report row comes to, as one token. */
export function verdictWord(v: ObligationVerdict): string {
  return v.claim === 'inconclusive' ? `inconclusive:${(v.code ?? 'none').replace(/^verification\//, '')}` : v.claim;
}

/** The ids a row is filed under, plus the proof-level facts that need the whole worklist. */
export interface ModelInput {
  corpus: string;
  name: string;
  model: Model;
  /** The `verifyModel` results, when `--verdicts` ran. */
  verdicts?: readonly ObligationVerdict[];
}

/** Rows above this are classified but not footprint-checked against the engine (the check is quadratic). */
const FOOTPRINT_CHECK_LIMIT = 400;

export function censusModel(c: Census, input: ModelInput): { script: string[] } {
  const { corpus, name, model } = input;
  const rows = obligationsOf(model);
  const enc = rows.map(encRow);
  const hashes: string[] = [];
  let tallied = 0;

  // The verdicts, joined by (requirement qualified name, clause qualified name) and occurrence, never by id.
  const verdictOf = new Map<Obligation, ObligationVerdict>();
  if (input.verdicts) {
    const pool = new Map<string, ObligationVerdict[]>();
    for (const v of input.verdicts) {
      const k = `${v.requirement?.qualifiedName ?? '-'}\u0000${v.clause.qualifiedName}`;
      const list = pool.get(k);
      if (list) list.push(v);
      else pool.set(k, [v]);
    }
    for (const r of rows) {
      if (r.role !== 'obligation') continue;
      const k = `${r.requirement?.qualifiedName ?? '-'}\u0000${r.element.qualifiedName}`;
      const v = pool.get(k)?.shift();
      if (v) verdictOf.set(r, v);
      else violation(c, 'join: obligation row with no verdict', `${name}: ${k.replace('\u0000', ' :: ')}`);
    }
    for (const [k, rest] of pool) if (rest.length > 0) violation(c, 'join: verdict with no obligation row', `${name}: ${k.replace('\u0000', ' :: ')} x${rest.length}`);
  }

  const axiomRows = axiomsOf(rows).map((a) => enc[rows.indexOf(a)]!);
  const pinnedModel = pinnedStrict(axiomRows);
  const rowCell = new Map<Obligation, string>();
  const perModel = name.startsWith('examples/') ? { rows: rows.length, encoded: 0, units: 0, shapes: {} as Record<string, number> } : undefined;

  for (const e of enc) {
    const r = e.row;
    const reading = readingOf(r);
    let cell: string;
    let search = '-';
    const mods: string[] = [];
    if (e.encoded) {
      const out = e.encoded;
      const facts = termFacts([out.term]);
      const sorts = symbolSorts(e.vars);
      const { shape } = shapeOfBytes(facts, sorts, { syntacticNonlinear: out.syntacticNonlinear, sides: out.sideConditions.length });
      cell = shape;
      // The logic the encoder gives this row alone must be the logic its shape stands for.
      const script = encodeScript({
        variables: e.vars,
        assertions: [{ kind: 'goal', name: r.element.qualifiedName || r.expression, term: out.term }, ...out.sideConditions.map((s) => ({ kind: 'side' as const, name: r.element.qualifiedName || r.expression, term: s.term }))],
        nonlinear: out.nonlinear,
        syntacticNonlinear: out.syntacticNonlinear,
      });
      bump(c.logics, `${shape}\t${script.logic}`);
      if (SHAPE_LOGIC[shape] !== script.logic) violation(c, 'logic: shape does not give the encoder’s logic', `${name}: ${r.expression} is ${shape}, the script says ${script.logic}`);
      hashes.push(`${corpus}\t${name}\t${r.element.qualifiedName || r.expression}\trow\t${script.logic}\t${sha(script.text)}`);
      const oracle = astShape(r.node!, e.vars);
      if (oracle !== shape) violation(c, 'oracle: AST shape differs from the bytes', `${name}: ${r.expression}: bytes ${shape}, AST ${oracle}`);
      if (shape === 'ground' && facts.arith) note(c, 'ground rows that carry arithmetic', `${name}: ${r.expression}`);
      if (shape === 'ground') note(c, 'ground rows', `${name}: ${r.expression}`);
      if (['nra-poly', 'nra-div', 'nira'].includes(shape)) {
        const nl = facts.nlSymbols.size > 0 ? facts.nlSymbols : facts.symbols;
        const pinnedSyms = new Set([...pinnedModel].map((q) => symbolOf(q)).filter((s): s is string => s !== undefined));
        search = [...nl].every((s) => pinnedSyms.has(s)) ? 'pinned' : 'free';
      }
      const reads = new Set(out.reads);
      const carried = e.vars.filter((v) => reads.has(v.qualifiedName));
      const viaFactor = carried.some((v) => v.factor !== 1);
      if (viaFactor || hasLiteral(r.node!)) mods.push('units');
      if (!viaFactor && hasLiteral(r.node!)) bump(c.facts, 'units rows visible only through a [unit] literal');
      if (carried.some((v) => v.offset !== 0)) mods.push('offset-order');
      if (facts.ite) mods.push('ite');
      if (shape === 'nira' && out.sideConditions.length > 0) mods.push('div-guard');
      if (r.vars.some((v) => textAsReal(model, v.featureId))) mods.push('text-as-real');
      if (perModel) {
        perModel.encoded += 1;
        perModel.shapes[shape] = (perModel.shapes[shape] ?? 0) + 1;
        if (mods.includes('units')) perModel.units += 1;
      }
    } else {
      cell = `fence/${e.refusal!.reason}`;
      if (!(e.refusal!.reason in FENCE_SET)) violation(c, 'partition: a refusal reason outside the vocabulary', `${name}: ${e.refusal!.reason}`);
    }
    rowCell.set(r, cell);
    const v = verdictOf.get(r);
    const basis = input.verdicts && r.role === 'obligation' ? basisEstimate(e, v, pinnedModel) : '-';
    const verdict = v ? verdictWord(v) : '-';
    if (e.encoded && !(reading !== NO_READING || r.source === 'none')) violation(c, 'partition: an encoded row with no reading', `${name}: ${r.expression}`);
    if (reading === NO_READING && e.encoded) violation(c, 'partition: a no-clause row that encoded', `${name}: ${r.expression}`);
    bump(c.rows, [corpus, cell, e.layer ?? '-', r.role, r.source, reading, search, mods.join('+') || '-', verdict, basis].join('\t'));
    tallied += 1;
    if (r.role === 'obligation' && v && cell.startsWith('fence/') && v.claim === 'refuted') {
      // Explained: nothing was encoded, so the refutation is a point evaluation (`engines/smt.ts`, the refused-goal arm).
      const pointEvaluation = v.bound.kind === 'model-values' && /numeric surface/.test(v.detail) && /nothing\s+was encoded|point evaluation/.test(`${v.bound.detail} ${v.detail}`);
      note(c, 'a fenced goal reported refuted', `${name}: ${r.element.qualifiedName} [${cell}, ${e.layer}] ${r.expression}: ${pointEvaluation ? 'a point evaluation on the numeric surface' : 'NOT a point evaluation: ' + v.bound.kind}`);
      if (!pointEvaluation) violation(c, 'anomaly: a fenced goal refuted without a point evaluation', `${name}: ${r.element.qualifiedName}`);
    }
  }
  if (tallied !== rows.length) violation(c, 'totals: tallied rows differ from obligationsOf', `${name}: ${tallied} vs ${rows.length}`);
  if (perModel) c.perModel[name] = perModel;

  // Step 0 of `verify` (and the baseline of `consistency` with values): every encoded axiom in one script.
  const encodedAxioms = axiomRows.filter((a) => a.encoded);
  if (encodedAxioms.length > 0) {
    const { script, shape } = scriptOf(encodedAxioms, assertedOf(encodedAxioms, 'axiom'));
    if (SHAPE_LOGIC[shape] !== script.logic) violation(c, 'logic: script shape does not give the encoder\u2019s logic', `${name}: step 0 is ${shape}, the script says ${script.logic}`);
    bump(c.facts, `step-0 axiom script (verify, consistency): ${shape} ${script.logic}`);
    hashes.push(`${corpus}\t${name}\t(step 0)\tstep0\t${script.logic}\t${sha(script.text)}`);
  }

  // Proofs: the script a goal stands on, from the encoder's bytes.
  const axioms = enc.filter((e) => axiomRows.includes(e));
  const checkFootprint = rows.length <= FOOTPRINT_CHECK_LIMIT;
  for (const g of enc) {
    if (g.row.role !== 'obligation' || !g.encoded) continue;
    const premises = enc.filter((e) => e.row.role === 'premise' && e.row.requirement !== null && g.row.requirement !== null && e.row.requirement.id === g.row.requirement.id);
    const { kept, reached } = relevant(axioms, premises, g.encoded);
    if (checkFootprint) {
      const mine = new Set(kept.map((k) => k.row.element.id));
      const theirs = encodedFootprint(rows, g.row);
      if (!theirs || theirs.size !== mine.size || [...mine].some((i) => !theirs.has(i))) violation(c, 'footprint: differs from the engine’s encodedFootprint', `${name}: ${g.row.element.qualifiedName}`);
    }
    const context = [...kept, ...premises, g];
    const assertions: ScriptAssertion[] = [
      ...assertedOf(kept, 'axiom'),
      ...assertedOf(premises, 'premise'),
      ...g.encoded.sideConditions.map((s) => ({ kind: 'side' as const, name: g.row.element.qualifiedName || g.row.expression, term: s.term })),
      { kind: 'goal', name: g.row.element.qualifiedName || g.row.expression, term: notTerm(g.encoded.term) },
    ];
    const { script, facts, shape: scriptShape } = scriptOf(context, assertions);
    hashes.push(`${corpus}\t${name}\t${g.row.element.qualifiedName || g.row.expression}\tproof\t${script.logic}\t${sha(script.text)}`);
    if (SHAPE_LOGIC[scriptShape] !== script.logic) violation(c, 'logic: script shape does not give the encoder’s logic', `${name}: ${g.row.element.qualifiedName} is ${scriptShape}, the script says ${script.logic}`);
    const rowShapes = context.map((e) => rowCell.get(e.row)!).filter((s) => !s.startsWith('fence/'));
    const maxRow = rowShapes.reduce((m, s) => ((RANK.get(s) ?? -1) > (RANK.get(m) ?? -1) ? s : m), 'ground');
    const outranks = (RANK.get(scriptShape) ?? 0) > (RANK.get(maxRow) ?? 0);
    if (outranks) note(c, 'proofs whose script cell outranks every row cell', `${name}: ${g.row.element.qualifiedName}: rows ${maxRow}, script ${scriptShape}`);
    let search = '-';
    if (['nra-poly', 'nra-div', 'nira'].includes(scriptShape)) {
      const pin = new Set([...pinnedStrict(kept)].map((q) => symbolOf(q)));
      const nl = facts.nlSymbols.size > 0 ? facts.nlSymbols : facts.symbols;
      search = [...nl].every((s) => pin.has(s)) ? 'pinned' : 'free';
    }
    const contextReached = reachedBy([
      ...context.filter((e) => e.encoded !== undefined).map((e) => ({ vars: e.row.vars, symbols: e.vars.map((v) => v.qualifiedName) })),
      { vars: [], symbols: reached },
    ]);
    const dropped =
      premises.filter((p) => p.encoded === undefined).length +
      kept.filter((a) => a.encoded === undefined && refusalReaches(reachOfRow(a.row, a.vars.map((v) => v.qualifiedName)), contextReached)).length;
    const v = verdictOf.get(g.row);
    const basis = input.verdicts ? basisEstimate(g, v, pinnedModel, dropped, kept) : '-';
    bump(c.proofs, [corpus, rowCell.get(g.row)!, scriptShape, script.logic, search, outranks ? 'outranks' : 'within', dropped > 0 ? 'dropped' : 'whole', v ? verdictWord(v) : '-', basis].join('\t'));
  }
  return { script: hashes };
}

/** The labelled assertions of encoded rows, side conditions included, as the engine files them. */
function assertedOf(list: readonly EncRow[], kind: 'axiom' | 'premise'): ScriptAssertion[] {
  return list.flatMap((e) =>
    e.encoded
      ? [
          { kind, name: e.row.element.qualifiedName || e.row.expression, term: e.encoded.term },
          ...e.encoded.sideConditions.map((s) => ({ kind: 'side' as const, name: e.row.element.qualifiedName || e.row.expression, term: s.term })),
        ]
      : [],
  );
}

/** One script over a context of rows, and the shape its BYTES have (symbols the script declares only). */
function scriptOf(context: readonly EncRow[], assertions: readonly ScriptAssertion[]): { script: ReturnType<typeof encodeScript>; facts: TermFacts; shape: ShapeId } {
  const variables: EncodeVariable[] = [];
  const seen = new Set<string>();
  for (const e of context) for (const v of e.vars) if (!seen.has(v.qualifiedName)) (seen.add(v.qualifiedName), variables.push(v));
  const synt = context.some((e) => e.encoded?.syntacticNonlinear === true);
  const script = encodeScript({ variables, assertions, nonlinear: context.some((e) => e.encoded?.nonlinear === true), syntacticNonlinear: synt });
  const facts = termFacts(assertions.map((a) => a.term));
  const declared = new Set(script.symbols.map((q) => symbolOf(q)));
  const read = new Map([...symbolSorts(variables)].filter(([sym]) => declared.has(sym)));
  const { shape } = shapeOfBytes({ ...facts, symbols: new Set([...facts.symbols].filter((x) => read.has(x))) }, read, { syntacticNonlinear: synt, sides: assertions.filter((x) => x.kind === 'side').length });
  return { script, facts, shape };
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

function hasLiteral(n: ExprNode): boolean {
  switch (n.kind) {
    case 'num':
      return n.literal !== undefined;
    case 'unary':
      return hasLiteral(n.operand);
    case 'binary':
      return hasLiteral(n.left) || hasLiteral(n.right);
    case 'if':
      return hasLiteral(n.cond) || hasLiteral(n.then) || hasLiteral(n.else);
    default:
      return false;
  }
}

/** `relevantAxioms` of `engines/smt.ts`, by its own rule, re-written here so the parity with `encodedFootprint` means something. */
function relevant(axioms: readonly EncRow[], premises: readonly EncRow[], goal: EncodedRelation): { kept: EncRow[]; reached: Set<string> } {
  const reached = new Set<string>(goal.reads);
  for (const p of premises) for (const r of p.encoded?.reads ?? []) reached.add(r);
  const kept: EncRow[] = [];
  const taken = new Set<EncRow>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const a of axioms) {
      if (taken.has(a)) continue;
      const reads = a.encoded?.reads ?? [];
      if (a.encoded !== undefined && !reads.some((r) => reached.has(r))) continue;
      taken.add(a);
      kept.push(a);
      for (const r of reads) reached.add(r);
      grew = true;
    }
  }
  return { kept, reached };
}

/**
 * What decided the verdict word, estimated from the report and the worklist ALONE. The engine's own trace
 * does not exist until S6a, so this is a static estimate and the output says so: a `vacuous` or
 * `axioms-inconsistent` row is read as the numeric surface's when its detail says it was false at the
 * model's values, and a `refuted` row as the solver's witness only when every symbol of the goal is pinned.
 */
function basisEstimate(
  e: EncRow,
  v: ObligationVerdict | undefined,
  pinnedModel: ReadonlySet<string>,
  dropped?: number,
  kept?: readonly EncRow[],
): Basis | '-' {
  if (!v) return '-';
  if (!e.encoded) return v.claim === 'refuted' ? 'point-evaluation' : 'none';
  if (v.claim === 'proved') {
    if (dropped === undefined) return 'solver';
    return dropped > 0 ? 'solver+numeric' : 'solver';
  }
  if (v.claim === 'refuted') {
    const pinned = kept ? pinnedStrict(kept) : pinnedModel;
    return e.vars.filter((x) => e.encoded!.reads.includes(x.qualifiedName)).every((x) => pinned.has(x.qualifiedName)) ? 'solver-witness' : 'numeric-surface';
  }
  if (v.claim === 'vacuous' || v.code === 'verification/inconsistent-axioms') {
    return /at the model.s (own )?values/.test(v.detail) ? 'numeric-surface' : 'solver';
  }
  return 'none';
}

/* ──────────────────────────────── the PROBES table ──────────────────────────────── */

export interface ProbeEntry {
  name: string;
  text: string;
  rows: Array<{ key: string; letters: string; ref: string }>;
}

/** The unescaped text of a template literal's raw source. */
const unescapeTemplate = (s: string): string =>
  s.replace(/\\(.)/gs, (_m, ch: string) => (ch === 'n' ? '\n' : ch === 't' ? '\t' : ch));

/**
 * Extract the `PROBES` table of the differential test without running it: every `name: probe(`…`, { rows })`
 * whose text is a plain template literal. The entries whose text is computed (an interpolation or a call) are
 * listed by name, and the spreads (`...reversed('name', text, rows)`, which file several probes from one call)
 * by their call; neither is read.
 */
export function extractProbes(source: string): { entries: ProbeEntry[]; interpolated: string[]; spreads: string[]; total: number } {
  const start = source.indexOf('const PROBES: Record<string,');
  if (start < 0) throw new Error('class-census: no PROBES table in the differential test');
  let i = source.indexOf('= {', start) + 3;
  const skipWs = (): void => {
    for (;;) {
      while (i < source.length && /\s/.test(source[i]!)) i += 1;
      if (source.startsWith('//', i)) i = source.indexOf('\n', i) + 1 || source.length;
      else if (source.startsWith('/*', i)) i = source.indexOf('*/', i) + 2;
      else return;
    }
  };
  /** Skip a template literal starting at `i` (a backtick); return its raw source and whether it interpolates. */
  const template = (): { raw: string; interpolates: boolean } => {
    const begin = ++i;
    let interpolates = false;
    for (; i < source.length; i += 1) {
      const ch = source[i]!;
      if (ch === '\\') i += 1;
      else if (ch === '`') break;
      else if (ch === '$' && source[i + 1] === '{') {
        interpolates = true;
        let depth = 1;
        i += 2;
        while (i < source.length && depth > 0) {
          if (source[i] === '`') {
            template();
          } else if (source[i] === '{') depth += 1;
          else if (source[i] === '}') depth -= 1;
          if (depth > 0) i += 1;
        }
      }
    }
    const raw = source.slice(begin, i);
    i += 1;
    return { raw, interpolates };
  };
  /** Skip one expression to the next top-level `,` or closing bracket; leaves `i` on it. */
  const expr = (): void => {
    let depth = 0;
    while (i < source.length) {
      const ch = source[i]!;
      if (ch === '`') {
        template();
        continue;
      }
      if (ch === "'" || ch === '"') {
        i += 1;
        while (i < source.length && source[i] !== ch) i += source[i] === '\\' ? 2 : 1;
        i += 1;
        continue;
      }
      if (source.startsWith('//', i)) {
        i = source.indexOf('\n', i);
        continue;
      }
      if (ch === '/' && /[(,=:[!&|?{};]/.test(source.slice(0, i).trimEnd().slice(-1))) {
        // A regular-expression literal: its brackets are not the table's.
        i += 1;
        for (let inClass = false; i < source.length && (source[i] !== '/' || inClass); i += 1) {
          if (source[i] === '\\') i += 1;
          else if (source[i] === '[') inClass = true;
          else if (source[i] === ']') inClass = false;
        }
        i += 1;
        continue;
      }
      if (ch === '(' || ch === '[' || ch === '{') depth += 1;
      else if (ch === ')' || ch === ']' || ch === '}') {
        if (depth === 0) return;
        depth -= 1;
      } else if (ch === ',' && depth === 0) return;
      i += 1;
    }
  };
  const entries: ProbeEntry[] = [];
  const interpolated: string[] = [];
  const spreads: string[] = [];
  let total = 0;
  for (;;) {
    skipWs();
    if (source[i] === '}') break;
    if (source.startsWith('...', i)) {
      // A spread (`...reversed('name', text, rows)` files two probes from one call): computed, listed, not read.
      const from = i;
      i += 3;
      expr();
      spreads.push(source.slice(from, i).replace(/\s+/g, ' ').slice(0, 48));
      if (source[i] === ',') i += 1;
      continue;
    }
    const key = /^(?:([A-Za-z_$][\w$]*)|'([^']*)'|"([^"]*)")\s*:\s*/.exec(source.slice(i, i + 200));
    if (!key) throw new Error(`class-census: cannot read a PROBES key at offset ${i}`);
    const name = key[1] ?? key[2] ?? key[3]!;
    i += key[0].length;
    if (!source.startsWith('probe(', i)) throw new Error(`class-census: PROBES entry ${name} is not a probe(...) call`);
    total += 1;
    i += 'probe('.length;
    skipWs();
    let text: string | undefined;
    if (source[i] === '`') {
      const t = template();
      if (!t.interpolates) text = unescapeTemplate(t.raw);
    } else expr();
    if (text === undefined) {
      // An interpolated or computed text: skip to the end of the call.
      for (;;) {
        expr();
        if (source[i] === ',') i += 1;
        else break;
      }
      interpolated.push(name);
      i += 1; // the `)`
      skipWs();
      if (source[i] === ',') i += 1;
      continue;
    }
    skipWs();
    i += 1; // the `,` after the text
    skipWs();
    const rowsStart = i;
    expr();
    const body = source.slice(rowsStart, i).replace(/^\s*\/\/.*$/gm, '');
    // A rows expression with a generic (`as Record<string, [string, Ref]>`) has a comma at depth 0.
    while (source[i] === ',') {
      i += 1;
      expr();
    }
    const rows = [...body.matchAll(/(['"`])((?:(?!\1).)+)\1\s*:\s*\[\s*'([^']*)'\s*,\s*'([^']*)'\s*\]/g)].map((m) => ({ key: m[2]!, letters: m[3]!, ref: m[4]! }));
    entries.push({ name, text, rows });
    i += 1; // the `)`
    skipWs();
    if (source[i] === ',') i += 1;
  }
  return { entries, interpolated, spreads, total };
}

/** Fold one probe's pinned rows into `byCell`: its goal cell, its SMT letter, and whether that letter is the hand-computed `ref`. */
export function censusProbe(p: ProbeCensus, entry: ProbeEntry, model: Model): void {
  // A row's name as the table writes it: the worklist adds ` (X's own)` to a relation read in its own type.
  const byName = new Map<string, EncRow[]>();
  for (const r of obligationsOf(model)) {
    const name = r.element.qualifiedName.replace(/ \([^()]*'s own\)$/, '');
    const list = byName.get(name) ?? [];
    list.push(encRow(r));
    byName.set(name, list);
  }
  for (const pin of entry.rows) {
    p.pinnedRows += 1;
    const found = byName.get(pin.key);
    const smt = pin.letters.split('/')[3] ?? '?';
    if (!found) {
      p.unmatched += 1;
      continue;
    }
    // One logical row, one count: its goal if it has one, else its first row.
    const e = found.find((x) => x.row.role === 'obligation') ?? found[0]!;
    const cell = e.encoded
      ? shapeOfBytes(termFacts([e.encoded.term]), symbolSorts(e.vars), { syntacticNonlinear: e.encoded.syntacticNonlinear, sides: e.encoded.sideConditions.length }).shape
      : `fence/${e.refusal!.reason}`;
    const decided = smt === 'T' || smt === 'F';
    bump(p.byCell, `${cell}\t${smt}\t${!decided ? 'undecided' : smt === pin.ref ? 'agree' : 'differ'}\t${e.row.role}`);
  }
}

/* ──────────────────────────────────── reading it ──────────────────────────────────── */

interface RowKey {
  corpus: string;
  cell: string;
  layer: string;
  role: string;
  source: string;
  reading: string;
  search: string;
  mods: string;
  verdict: string;
  basis: string;
}

const rowKey = (k: string): RowKey => {
  const [corpus, cell, layer, role, source, reading, search, mods, verdict, basis] = k.split('\t');
  return { corpus: corpus!, cell: cell!, layer: layer!, role: role!, source: source!, reading: reading!, search: search!, mods: mods!, verdict: verdict!, basis: basis! };
};

/** What the plan expects of the published examples (D.3), to be reproduced or explained. */
export const EXPECTED_EXAMPLES: Record<string, { rows: number; shapes: Record<string, number>; units: number; encoded?: number }> = {
  'examples/uav-isr.sysml': { rows: 14, shapes: { lra: 13, 'nra-div': 1 }, units: 3 },
  'examples/uav-isr-verification.sysml': { rows: 10, shapes: { lra: 9, 'nra-div': 1 }, units: 4 },
  'examples/uav-power-budget.sysml': { rows: 19, shapes: { lra: 19 }, units: 8 },
  'examples/vehicle.sysml': { rows: 5, shapes: { lra: 4, lira: 1 }, units: 0 },
  'examples/views-tour.sysml': { rows: 8, shapes: { lra: 6 }, units: 2, encoded: 6 },
  'examples/contract-authoring-prompts.sysml': { rows: 3, shapes: { lra: 3 }, units: 1 },
};

/** Sum the rows whose key passes `keep`, grouped by `by`. */
function group(c: Census, keep: (k: RowKey) => boolean, by: (k: RowKey) => string): Map<string, number> {
  const out = new Map<string, number>();
  for (const [k, n] of Object.entries(c.rows)) {
    const key = rowKey(k);
    if (keep(key)) out.set(by(key), (out.get(by(key)) ?? 0) + n);
  }
  return out;
}

/** The census as the text a person reads. Deterministic: no clock, no ids, no path outside the repo. */
export function renderCensus(c: Census): string {
  const out: string[] = [];
  const line = (s = ''): number => out.push(s);
  const total = Object.values(c.rows).reduce((a, b) => a + b, 0);
  const num = (n: number | undefined): string => String(n ?? 0).padStart(6);
  const cells = (): string[] => {
    const nl = ['nra-poly', 'nra-div', 'nira'];
    return [...SHAPES.flatMap((s) => (nl.includes(s) ? [`${s}/pinned`, `${s}/free`] : [s])), ...FENCES.map((f) => `fence/${f}`)];
  };
  const cellOf = (k: RowKey): string => (k.search === '-' ? k.cell : `${k.cell}/${k.search}`);

  line('CONSTRAINT-CLASS CENSUS (step S0: an inventory; nothing here is printed by Sysprose and no verdict depends on it)');
  line(`  worklist rows ${total} over ${Object.values(c.models).reduce((a, m) => a + m.loaded, 0)} loaded models`);
  for (const [k, m] of Object.entries(c.models).sort()) line(`    ${k.padEnd(14)} ${String(m.read).padStart(4)} read, ${String(m.loaded).padStart(4)} loaded, ${String(m.failed).padStart(4)} failed to load`);
  line();

  line('1. VOCABULARY AND REAL COUNTS (rows; a modifier counts every row that carries it)');
  line(`  ${'cell'.padEnd(34)}${'rows'.padStart(7)}${'axiom'.padStart(7)}${'premise'.padStart(9)}${'goal'.padStart(7)}`);
  const byCell = (name: string): Map<string, number> => group(c, (k) => cellOf(k) === name, (k) => k.role);
  for (const cell of cells()) {
    const m = byCell(cell);
    const n = [...m.values()].reduce((a, b) => a + b, 0);
    line(`  ${cell.padEnd(34)}${num(n)}${num(m.get('axiom')).padStart(7)}${num(m.get('premise')).padStart(9)}${num(m.get('obligation')).padStart(7)}${n === 0 ? '   no evidence' : ''}`);
  }
  const modCount = (mod: string): number => [...group(c, (k) => k.mods.split('+').includes(mod), () => 'x').values()].reduce((a, b) => a + b, 0);
  line();
  for (const mod of MODIFIERS) line(`  modifier ${mod.padEnd(24)}${num(modCount(mod))}${modCount(mod) === 0 ? '   no evidence' : ''}`);
  line(`    of which visible only through a [unit] literal (every variable factor is 1): ${c.facts['units rows visible only through a [unit] literal'] ?? 0}`);
  line(`  modifier ${'partial-context'.padEnd(24)}${num(sumProofs(c, (p) => p.dropped === 'dropped'))}   (proofs whose kept context holds a refused row it reaches)`);
  line();
  for (const rd of [...READINGS, NO_READING]) {
    const m = group(c, (k) => k.reading === rd, (k) => k.role);
    const n = [...m.values()].reduce((a, b) => a + b, 0);
    line(`  reading ${rd.padEnd(25)}${num(n)}${num(m.get('axiom')).padStart(7)}${num(m.get('premise')).padStart(9)}${num(m.get('obligation')).padStart(7)}${n === 0 ? '   no evidence' : ''}`);
  }
  line();
  line('  fence layers (gate = the gates refused it; encoder = it reached the encoder and was turned down)');
  for (const f of FENCES) {
    const m = group(c, (k) => k.cell === `fence/${f}`, (k) => k.layer);
    line(`  fence/${f.padEnd(24)}${num(m.get('gate'))} gate${num(m.get('encoder'))} encoder${[...m.values()].every((v) => v === 0) || m.size === 0 ? '   no evidence' : ''}`);
  }
  line();

  const empty = [
    ...cells().filter((x) => byCell(x).size === 0),
    ...MODIFIERS.filter((m) => modCount(m) === 0),
    ...READINGS.filter((rd) => group(c, (k) => k.reading === rd, () => 'x').size === 0),
  ];
  line(`  classes with no rows (no evidence, never "0 tested"): ${empty.length === 0 ? 'none' : empty.join(', ')}`);
  line();

  line('2. CELL x READING (encoded rows)');
  const readingCols = [...READINGS];
  line(`  ${''.padEnd(22)}${readingCols.map((r) => r.slice(0, 10).padStart(11)).join('')}`);
  for (const cell of cells().filter((x) => !x.startsWith('fence/'))) {
    const m = group(c, (k) => cellOf(k) === cell, (k) => k.reading);
    if (m.size === 0) continue;
    line(`  ${cell.padEnd(22)}${readingCols.map((r) => String(m.get(r) ?? 0).padStart(11)).join('')}`);
  }
  line();

  line('3. ROLE x SOURCE (every row)');
  const roleSource = group(c, () => true, (k) => `${k.role} / ${k.source}`);
  for (const [k, n] of [...roleSource].sort()) line(`  ${k.padEnd(34)}${num(n)}`);
  line();

  line('4. CORPUS x CELL');
  const corpora = Object.keys(c.models).sort();
  line(`  ${''.padEnd(22)}${corpora.map((x) => x.slice(0, 11).padStart(12)).join('')}`);
  for (const cell of cells()) {
    const m = group(c, (k) => cellOf(k) === cell, (k) => k.corpus);
    if (m.size === 0) continue;
    line(`  ${cell.padEnd(22)}${corpora.map((x) => String(m.get(x) ?? 0).padStart(12)).join('')}`);
  }
  line();

  line('5. PROOFS (a goal that encoded: the script its negation check would send, built from the encoder’s bytes)');
  const proofs = Object.entries(c.proofs).map(([k, n]) => {
    const [corpus, goal, script, logic, search, rank, dropped, verdict, basis] = k.split('\t');
    return { corpus: corpus!, goal: goal!, script: script!, logic: logic!, search: search!, rank: rank!, dropped: dropped!, verdict: verdict!, basis: basis!, n };
  });
  const nProofs = proofs.reduce((a, p) => a + p.n, 0);
  line(`  proofs ${nProofs}; script cell outranks every row cell in ${sumProofs(c, (p) => p.rank === 'outranks')} (the plan expects 0 on the corpus)`);
  for (const [title, f] of [['script shape', (p: (typeof proofs)[0]) => (p.search === '-' ? p.script : `${p.script}/${p.search}`)], ['script logic', (p: (typeof proofs)[0]) => p.logic], ['goal cell', (p: (typeof proofs)[0]) => p.goal]] as const) {
    const m = new Map<string, number>();
    for (const p of proofs) m.set(f(p), (m.get(f(p)) ?? 0) + p.n);
    line(`  by ${title}: ${[...m].sort().map(([k, n]) => `${k} ${n}`).join(', ')}`);
  }
  const goalVsScript = new Map<string, number>();
  for (const p of proofs) goalVsScript.set(`${p.goal} -> ${p.script}`, (goalVsScript.get(`${p.goal} -> ${p.script}`) ?? 0) + p.n);
  line(`  goal cell -> script shape: ${[...goalVsScript].sort().map(([k, n]) => `${k} ${n}`).join(', ')}`);
  line(`  step 0 (every encoded axiom in one script, as verify and consistency send it): ${Object.entries(c.facts).filter(([k]) => k.startsWith('step-0')).map(([k, n]) => `${k.replace(/^step-0 axiom script \(verify, consistency\): /, '')} ${n}`).sort().join(', ')}`);
  line();

  if (c.verdicts) {
    line('6. VERDICTS (verify --engine smt, z3; joined by requirement and clause qualified name, never by id)');
    const goals = group(c, (k) => k.role === 'obligation' && k.verdict !== '-', (k) => `${cellOf(k)}\t${k.verdict}`);
    const words = [...new Set([...goals.keys()].map((k) => k.split('\t')[1]!))].sort();
    const short = (w: string): string => w.replace('inconclusive:', 'inc:');
    const wide = Math.max(...words.map((w) => short(w).length), 8) + 2;
    line(`  ${'goal cell'.padEnd(34)}${words.map((w) => short(w).padStart(wide)).join('')}`);
    for (const cell of cells()) {
      if (![...goals.keys()].some((k) => k.startsWith(`${cell}\t`))) continue;
      line(`  ${cell.padEnd(34)}${words.map((w) => String(goals.get(`${cell}\t${w}`) ?? 0).padStart(wide)).join('')}`);
    }
    line();
    line('7. BASIS CENSUS (a static ESTIMATE from the report and the worklist: the engine’s own trace is S6a)');
    const basis = group(c, (k) => k.role === 'obligation' && k.basis !== '-', (k) => k.basis);
    line(`  ${BASES.map((b) => `${b} ${basis.get(b) ?? 0}`).join(', ')}`);
    const crossed = group(c, (k) => k.role === 'obligation' && k.basis !== '-', (k) => `${k.verdict} / ${k.basis}`);
    line(`  verdict / basis: ${[...crossed].sort().map(([k, n]) => `${k} ${n}`).join('; ')}`);
    line();
  }

  line('8. ANOMALIES AND FINDINGS');
  const topics = Object.keys(c.notes).sort();
  if (topics.length === 0) line('  none');
  for (const t of topics) {
    line(`  ${t} (${c.checks[t] ?? c.notes[t]!.length}${(c.checks[t] ?? 0) > NOTE_CAP || c.notes[t]!.length >= NOTE_CAP ? ', first 25 shown' : ''}):`);
    for (const x of c.notes[t]!) line(`    ${x}`);
  }
  line();

  line('9. EXAMPLES AGAINST THE PLAN (D.3)');
  for (const [name, want] of Object.entries(EXPECTED_EXAMPLES)) {
    const got = c.perModel[name];
    if (!got) {
      line(`  ${name}: not read`);
      continue;
    }
    const shapes = Object.entries(got.shapes).sort().map(([k, n]) => `${n} ${k}`).join(', ');
    const same =
      got.rows === want.rows && got.units === want.units && JSON.stringify(Object.entries(got.shapes).sort()) === JSON.stringify(Object.entries(want.shapes).sort()) && (want.encoded === undefined || got.encoded === want.encoded);
    line(`  ${same ? 'same   ' : 'DIFFERS'} ${name}: ${got.rows} rows, ${got.encoded} encoded (${shapes}), ${got.units} units rows${same ? '' : `; the plan says ${want.rows} rows, ${JSON.stringify(want.shapes)}, ${want.units} units`}`);
  }
  line();

  if (c.probes) {
    const p = c.probes;
    line('10. THE PROBES TABLE (verification.differential.test.ts, read statically)');
    line(`  ${p.total} named probe entries: ${p.extracted} plain template texts extracted, ${p.interpolated.length} computed (not read): ${p.interpolated.join(', ')}`);
    line(`  ${p.spreads} spread generators (each files several probes from one call) are not read either`);
    line(`  ${p.pinnedRows} pinned rows, ${p.unmatched} of them met no worklist row; ${p.failed.length} probe texts failed to load${p.failed.length ? ': ' + p.failed.join(', ') : ''}`);
    const letters = new Map<string, Map<string, number>>();
    let others = 0;
    for (const [k, n] of Object.entries(p.byCell)) {
      const [cell, , verdict, role] = k.split('\t') as [string, string, string, string];
      if (role !== 'obligation') {
        others += n;
        continue;
      }
      const m = letters.get(cell) ?? new Map<string, number>();
      m.set(verdict, (m.get(verdict) ?? 0) + n);
      letters.set(cell, m);
    }
    line(`  goals only; ${others} pinned rows are axioms or premises (not tabled). The SMT letter against the hand-computed one:`);
    line(`  ${'goal cell'.padEnd(34)}${'agree'.padStart(8)}${'differ'.padStart(8)}${'undecided'.padStart(11)}`);
    for (const cell of cells()) {
      const m = letters.get(cell);
      if (m) line(`  ${cell.padEnd(34)}${num(m.get('agree')).padStart(8)}${num(m.get('differ')).padStart(8)}${num(m.get('undecided')).padStart(11)}`);
    }
    line();
  }

  line('11. SELF-CHECK');
  const names = [
    'partition: a refusal reason outside the vocabulary',
    'partition: an encoded row with no reading',
    'partition: a no-clause row that encoded',
    'totals: tallied rows differ from obligationsOf',
    'logic: shape does not give the encoder’s logic',
    'logic: script shape does not give the encoder’s logic',
    'footprint: differs from the engine’s encodedFootprint',
    'oracle: AST shape differs from the bytes',
    ...(c.verdicts ? ['join: obligation row with no verdict', 'join: verdict with no obligation row', 'anomaly: a fenced goal refuted without a point evaluation'] : []),
  ];
  for (const n of names) line(`  ${(c.checks[n] ?? 0) === 0 ? 'ok     ' : 'FAILS  '} ${n}: ${c.checks[n] ?? 0}`);
  const maps = new Map<string, Set<string>>();
  for (const k of Object.keys(c.logics)) {
    const [shape, logic] = k.split('\t') as [string, string];
    maps.set(shape, (maps.get(shape) ?? new Set()).add(logic));
  }
  const many = [...maps].filter(([, s]) => s.size > 1);
  line(`  ${many.length === 0 ? 'ok     ' : 'FAILS  '} each shape maps to one logic: ${[...maps].sort().map(([k, s]) => `${k} -> ${[...s].join('|')}`).join(', ')}`);
  return out.join('\n') + '\n';
}

function sumProofs(c: Census, pred: (p: { rank: string; dropped: string }) => boolean): number {
  let n = 0;
  for (const [k, v] of Object.entries(c.proofs)) {
    const f = k.split('\t');
    if (pred({ rank: f[5]!, dropped: f[6]! })) n += v;
  }
  return n;
}

/** Do the census's own invariants all hold? The ones a model cannot make true by accident. */
export function invariantsHold(c: Census): boolean {
  const hard = [
    'partition: a refusal reason outside the vocabulary',
    'partition: an encoded row with no reading',
    'partition: a no-clause row that encoded',
    'totals: tallied rows differ from obligationsOf',
    'logic: shape does not give the encoder’s logic',
    'logic: script shape does not give the encoder’s logic',
    'footprint: differs from the engine’s encodedFootprint',
    ...(c.verdicts ? ['join: obligation row with no verdict', 'join: verdict with no obligation row', 'anomaly: a fenced goal refuted without a point evaluation'] : []),
  ];
  const maps = new Map<string, Set<string>>();
  for (const k of Object.keys(c.logics)) {
    const [shape, logic] = k.split('\t') as [string, string];
    maps.set(shape, (maps.get(shape) ?? new Set()).add(logic));
  }
  return hard.every((n) => (c.checks[n] ?? 0) === 0) && [...maps.values()].every((s) => s.size === 1);
}
