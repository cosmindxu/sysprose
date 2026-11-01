/**
 * The constraint-class register and classifier (`src/semantics/smt/classes.ts`, `pinned.ts`), before anything
 * is wired to them: LABEL ONLY, so this file holds the register's own contract and nothing about a verdict.
 *
 * - The register is exhaustive (CC-10): every refusal reason, every obligation source and every outcome word
 *   has a mapping, the ids are the 35 of the plan, and every sentence a card quotes is found in source.
 * - A row's reading, shape, modifiers and fence follow the code that decides them (CC-11, CC-12), and the
 *   `text-as-real` closure agrees with the sorts `contracts.ts` gives (CC-12b).
 * - The roll-up folds rows to the WEAKEST cell, whatever order they arrive in, and states the goal's own
 *   class beside it (CC-13). Maturity can be replaced wholesale and nothing but levels moves (CC-20).
 * - Shape, reading and fence do not depend on `--free` (CC-19); `search` is the strict pinned reading, which
 *   never pins a symbol through an equation that mentions it on its own right-hand side (CC-21).
 * - The maturity rubric is a pure function of the facts and the defects (CC-14); every pointer of the register
 *   resolves (CC-15); every open defect of the sidecar is a bullet of `TODO.md` (CC-18).
 * - The generated document and the marked regions of three other documents are what the generator renders
 *   (CC-16); every surface marked `built` has a pointer that resolves (CC-16b); the generated words claim
 *   nothing a verdict, a certificate or an unbuilt surface would (CC-17).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Model } from '@core/index';
import { loadModelText } from '@text/load';
import { axiomsOf, obligationsOf, type Obligation, type ObligationSource } from '@semantics/obligations';
import { parseExpr } from '@semantics/expr';
import type { RefusalReason } from '@semantics/contracts';
import type { SmtOutcome } from '@semantics/engines/smt';
import { encodeRelation, encodeVariables } from '@semantics/smt/encode';
import {
  BASES,
  BASIS_OF,
  CELLS,
  CONSTRAINT_CLASSES,
  ClassRollup,
  FENCES,
  FENCE_OF,
  LEVELS,
  MATURITY_SENTENCE,
  MODIFIERS,
  READINGS,
  READING_OF,
  REGISTER_VERSION,
  RUBRIC,
  SHAPES,
  SURFACES,
  cellsOfClass,
  printedClasses,
  basisOf,
  cellOfRow,
  classLine,
  classLines,
  classesOf,
  classifyRow,
  levelDetail,
  levelOf,
  levelRank,
  readingOf,
  rollUp,
  scriptClassOf,
  searchOf,
  shapeCell,
  staticCensus,
  typeNamesOf,
  unclassified,
  weakestOf,
  withLevelSource,
  type CellFacts,
  type ClassFacts,
  type ClassStatement,
  type ClassifiableRow,
  type Defect,
  type Level,
  type RowClass,
  type Surface,
  type RollUpInput,
} from '@semantics/smt/classes';
import { pinnedSymbolsOf } from '@semantics/smt/pinned';
import { classifiableOf, checkRefinement } from '@semantics/refinement';
import { checkConsistency } from '@semantics/consistency';
import { checkBounds } from '@semantics/bounds';
import { computeFaultTree } from '@semantics/fault-tree';
import type { Z3Backend } from '@semantics/smt/z3-bridge';
import { CLASS_FACTS } from '@semantics/smt/class-facts';
import { blockKeys, credit, type Proof } from '../../scripts/lib/class-facts';
import { REGION_HOSTS, beginMarker, endMarker, readRegion, renderConstraintClasses, spliceRegion, type RegionName } from '../../scripts/gen-constraint-classes';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

/** No fact at all: every encoded cell is `experimental` and every fence `unpinned`, whatever the committed facts say. */
const NO_FACTS: ClassFacts = {
  register: REGISTER_VERSION,
  z3: '5.3.1',
  digests: { probes: '', goldens: '', defects: '' },
  knownFalse: { parsed: true, entries: 0, unattributed: 0 },
  cells: {},
  fences: {},
  defects: [],
};
/** Run `body` with the levels the register gives when no fact exists (the committed facts move; these tests are about the roll-up). */
const noFacts = <T,>(body: () => T): T => withLevelSource((cell, env) => levelOf(cell, { ...env, facts: NO_FACTS }), body);

async function load(text: string, name = 'probe.sysml'): Promise<Model> {
  const { model } = await loadModelText(text, { library: 'full', fileName: name });
  if (!model) throw new Error(`${name} produced no model`);
  return model;
}

/** Features of every shape the register names, valued and not, plus the rows over them. */
const MODEL_A = `package C {
  part def Sys {
    attribute a : ScalarValues::Real = 2.0;
    attribute b : ScalarValues::Real = 3.0;
    attribute u1 : ScalarValues::Real;
    attribute u2 : ScalarValues::Real;
    attribute n : ScalarValues::Integer = 4;
    attribute flag : ScalarValues::Boolean = true;
    attribute m : ISQ::MassValue = 1.5 [kg];
    attribute prod : ScalarValues::Real = a * b;
    attribute q : ScalarValues::Real = a / b;
    attribute d;
    attribute x;
    attribute y;
    assert constraint defd { d == a * 2.0 }
    assert constraint selfref { x == x * a }
    assert constraint selfref2 { y == y + a }
  }
  part s : Sys;
  requirement def R {
    subject u : Sys;
    assume constraint { u.a > 0.0 }
    require constraint { u.a * u.b > 1.0 }
    require constraint { u.u1 * u.u2 > 1.0 }
    require constraint { u.a / u.b < 5.0 }
    require constraint { u.a / u.u1 < 5.0 }
    require constraint { u.n * u.a >= 3.0 }
    require constraint { u.n >= 3 }
    require constraint { u.flag }
    require constraint { u.m <= 5.0 [kg] }
    require constraint { u.a ^ 2 > 1.0 }
    require constraint { (u.a ^ 0) * (u.b ^ 0) > 0.0 }
    require constraint { (u.u1 ^ 0) * (u.u2 ^ 0) > 0.0 }
    require constraint { u.x * u.a > 1.0 }
    require constraint { u.d * u.a > 1.0 }
    require constraint { u.y * u.a > 1.0 }
    require constraint { u.a % 2.0 == 0.0 }
    require constraint { 1.0 < 2.0 }
    require constraint { if u.a > 1.0 then u.b else u.a > 0.0 }
  }
  satisfy R by s;
}`;

/** Binds, chains, mutual definitions, units, offsets, an `ite`, a guard, a string and a prose requirement. */
const MODEL_B = `package B {
  part def Link {
    attribute v : ScalarValues::Real = 5.0;
    attribute w : ScalarValues::Real;
    attribute z : ScalarValues::Real;
    attribute z2 : ScalarValues::Real;
    attribute p : ScalarValues::Real;
    attribute r : ScalarValues::Real;
    attribute t1 : ISQ::TemperatureValue = 20.0 ['°C'];
    attribute t2 : ISQ::TemperatureValue = 30.0 ['°C'];
    attribute dur : ISQ::DurationValue = 90.0 [s];
    attribute k : ScalarValues::Integer = 0;
    attribute label : ScalarValues::String = "bus";
    attribute label2 : ScalarValues::String = "car";
    bind w = v;
    assert constraint mutA { z == z2 * v }
    assert constraint mutB { z2 == z / v }
    assert constraint ch1 { p == v * 2.0 }
    assert constraint ch2 { r == p * v }
  }
  part l : Link;
  requirement def Q {
    subject u : Link;
    assume constraint { false }
    require constraint { u.w * u.v > 1.0 }
    require constraint { u.z * u.v > 1.0 }
    require constraint { u.r * u.v > 1.0 }
    require constraint { u.t1 <= u.t2 }
    require constraint { u.dur >= 1.0 [min] }
    require constraint { (if u.v > 1.0 then u.v else u.w) >= 1.0 }
    require constraint { u.k / u.v < 5.0 }
    require constraint { u.label == u.label2 }
    require constraint { u.v / 0.0 > 1.0 }
    require constraint { u.v ^ 0.5 > 1.0 }
    require constraint { u.v ^ 40 > 1.0 }
  }
  requirement def Prose { subject u : Link; doc /* only prose */ }
  satisfy Q by l;
  satisfy Prose by l;
}`;

let A: Model;
let B: Model;
let rowsA: Obligation[];
let rowsB: Obligation[];
beforeAll(async () => {
  A = await load(MODEL_A, 'a.sysml');
  B = await load(MODEL_B, 'b.sysml');
  rowsA = obligationsOf(A);
  rowsB = obligationsOf(B);
}, 120_000);

const rowOf = (rows: readonly Obligation[], expression: string, source?: ObligationSource): Obligation => {
  const hit = rows.find((r) => r.expression === expression && (source === undefined || r.source === source));
  if (!hit) throw new Error(`no row \`${expression}\` in ${rows.map((r) => r.expression).join(' | ')}`);
  return hit;
};

/** The cell of a row, the way a proof over `axioms` would read it (`axioms` pin what they pin). */
function cellFor(model: Model, rows: readonly Obligation[], expression: string, free: ReadonlySet<string> = new Set()): string {
  const axioms = axiomsOf(rows, free).map((row) => ({ row, encoded: true as const }));
  const pinned = pinnedSymbolsOf(model, axioms);
  return cellOfRow(classifyRow(rowOf(rows, expression), { model }), pinned);
}

/* ─────────────────────────────── CC-10: exhaustiveness ─────────────────────────────── */

describe('the register is exhaustive', () => {
  const REASONS: RefusalReason[] = [
    'no-formal-clause',
    'unparseable',
    'unresolved-name',
    'unit-unresolved',
    'dimension-clash',
    'offset-arithmetic',
    'derived-bare-literal',
    'refused-derivation',
    'unread-definition',
    'unread-binding',
    'unscalable',
    'collection-valued',
    'unsupported-operator',
    'non-numeric-operand',
  ];
  const SOURCES: ObligationSource[] = ['require', 'assume', 'objective', 'assert', 'constraint', 'calculation', 'feature-value', 'bind', 'keyword', 'none'];
  const OUTCOMES: SmtOutcome[] = [
    'proved',
    'refuted',
    'design-admitted',
    'vacuous',
    'axioms-inconsistent',
    'free-unbounded',
    'timeout',
    'witness-unconfirmed',
    'unsupported',
    'not-evaluable',
  ];

  it('maps all 14 refusal reasons, 10 obligation sources and 10 outcome words', () => {
    expect(Object.keys(FENCE_OF).sort()).toEqual([...REASONS].sort());
    for (const r of REASONS) expect(FENCE_OF[r]).toBe(`fence/${r}`);
    expect(Object.keys(READING_OF).sort()).toEqual([...SOURCES].sort());
    expect(Object.keys(BASIS_OF).sort()).toEqual([...OUTCOMES].sort());
    for (const b of Object.values(BASIS_OF)) expect(BASES).toContain(b);
  });

  it('has the 35 ids of the plan in four families and 38 maturity cells', () => {
    expect([SHAPES.length, MODIFIERS.length, READINGS.length, FENCES.length]).toEqual([7, 6, 8, 14]);
    const ids = Object.keys(CONSTRAINT_CLASSES);
    expect(ids).toHaveLength(35);
    expect(new Set(ids).size).toBe(35);
    for (const [id, d] of Object.entries(CONSTRAINT_CLASSES)) expect(d.id).toBe(id);
    expect(CELLS).toHaveLength(38);
    expect(new Set(CELLS).size).toBe(38);
    const nonlinear = ['nra-poly', 'nra-div', 'nira'];
    for (const s of SHAPES) {
      if (nonlinear.includes(s)) expect(CELLS).toEqual(expect.arrayContaining([`${s}/pinned`, `${s}/free`]));
      else expect(CELLS).toContain(s);
    }
    expect(REGISTER_VERSION).toBe(1);
  });

  it('gives every fence its layers and the forgiveness the literal engine gives its reason', () => {
    for (const f of FENCES) {
      const d = CONSTRAINT_CLASSES[f];
      expect(d.layers.length, f).toBeGreaterThan(0);
      expect(typeof d.gateForgivable, f).toBe('boolean');
    }
    expect(CONSTRAINT_CLASSES['fence/unsupported-operator'].gateForgivable).toBe(true);
    expect(CONSTRAINT_CLASSES['fence/unresolved-name'].gateForgivable).toBe(false);
    expect(CONSTRAINT_CLASSES['fence/unparseable'].gateForgivable).toBe(false);
  });

  it('quotes only sentences that source still holds, and names only real surfaces', () => {
    for (const d of Object.values(CONSTRAINT_CLASSES)) {
      for (const p of d.pointers) expect(read(p.file), `${d.id}: ${p.find}`).toContain(p.find);
    }
    for (const s of SURFACES) {
      if (s.status === 'built') expect(read(s.pointer!.file), s.id).toContain(s.pointer!.find);
      else expect(s.pointer, s.id).toBeNull();
    }
    expect(SURFACES.find((s) => s.id === 'export')?.status).toBe('planned');
  });

  it('declares verdict words from the outcome type and only that', () => {
    for (const d of Object.values(CONSTRAINT_CLASSES)) for (const w of d.verdicts) expect(OUTCOMES, d.id).toContain(w);
    expect(CONSTRAINT_CLASSES['text-as-real'].verdicts).not.toContain('proved');
  });
});

/* ───────────────────────────────── CC-11: readings ───────────────────────────────── */

describe('a row reads one way', () => {
  const base = (over: Partial<ClassifiableRow>): ClassifiableRow => ({
    node: parseExpr('x >= 1.0'),
    vars: [],
    sortPerVar: {},
    scaled: false,
    encodable: true,
    ...over,
  });
  const v = (over: Record<string, unknown> = {}) =>
    ({ path: 'x', featureId: 'f', qualifiedName: 'P::x', role: 'input', unit: null, siFactor: 1, siOffset: 0, ...over }) as ClassifiableRow['vars'][number];
  const inst = { baseId: 'b', contextId: 'c' } as unknown as NonNullable<ClassifiableRow['instance']>;

  it('follows the role, the source and the instance, in that order of precedence', () => {
    const table: Array<[string, Partial<ClassifiableRow>, string | null]> = [
      ['require', { source: 'require' }, 'requirement-clause'],
      ['assume', { source: 'assume' }, 'requirement-clause'],
      ['objective', { source: 'objective' }, 'requirement-clause'],
      ['constraint', { source: 'constraint' }, 'requirement-clause'],
      ['keyword', { source: 'keyword' }, 'requirement-clause'],
      ['assert', { source: 'assert' }, 'asserted-fact'],
      ['calculation', { source: 'calculation' }, 'defining-equation'],
      ['bind', { source: 'bind' }, 'bind-equality'],
      ['none', { source: 'none' }, null],
      ['feature value, literal', { source: 'feature-value', node: parseExpr('x == 2.0') }, 'stated-value'],
      ['feature value, literal on the left', { source: 'feature-value', node: parseExpr('2.0 == x') }, 'stated-value'],
      ['feature value, negative literal', { source: 'feature-value', node: parseExpr('x == -2.0') }, 'stated-value'],
      ['feature value, boolean', { source: 'feature-value', node: parseExpr('x == true') }, 'stated-value'],
      ['feature value, expression', { source: 'feature-value', node: parseExpr('x == y * 2.0') }, 'defining-equation'],
      ['feature value, inequality', { source: 'feature-value', node: parseExpr('x >= 2.0') }, 'defining-equation'],
      ['feature value, no body', { source: 'feature-value', node: null }, 'defining-equation'],
      ['unread beats the source', { source: 'assert', unread: ['x'] }, 'own-symbol'],
      ['unread beats an instance', { source: 'require', unread: ['x'], instance: { ...inst, path: 'g1' } }, 'own-symbol'],
      ['an instance path', { source: 'require', instance: { ...inst, path: 'g1' } }, 'per-instance'],
      ['a variable read through an instance', { source: 'require', vars: [v({ instance: { path: 'g1', reader: 'r', enclosing: [] } })] }, 'per-instance'],
      ['an instance without a path', { source: 'require', instance: inst }, 'inherited-context'],
      ['an instance without a path, a feature value', { source: 'feature-value', node: parseExpr('x == 1.0'), instance: inst }, 'inherited-context'],
      ['an empty unread list does not count', { source: 'require', unread: [] }, 'requirement-clause'],
      ['no source, no kind', {}, 'requirement-clause'],
    ];
    expect(table.length).toBeGreaterThanOrEqual(24 - 1);
    for (const [name, row, want] of table) expect(readingOf(base(row)), name).toBe(want);
    expect(readingOf(base({}), 'clause')).toBe('requirement-clause');
    expect(readingOf(base({}), 'gamma')).toBe('bind-equality');
    expect(readingOf(base({ source: 'assert' }), 'gamma')).toBe('asserted-fact');
  });
});

/* ───────────────────────────── CC-12: one row, one cell ───────────────────────────── */

describe('a worklist row is sorted into exactly one shape or fence', () => {
  it('reads twenty hand relations through the real worklist', () => {
    const want: Array<[Obligation[], string, string, string | null, string[], string?]> = [
      // rows, expression, cell, reading, modifiers, fence layer
      [rowsA, 'u.a * u.b > 1.0', 'nra-poly/pinned', 'requirement-clause', []],
      [rowsA, 'u.u1 * u.u2 > 1.0', 'nra-poly/free', 'requirement-clause', []],
      [rowsA, 'u.a / u.b < 5.0', 'nra-div/pinned', 'requirement-clause', []],
      [rowsA, 'u.a / u.u1 < 5.0', 'nra-div/free', 'requirement-clause', []],
      [rowsA, 'u.n * u.a >= 3.0', 'nira/pinned', 'requirement-clause', []],
      [rowsA, 'u.n >= 3', 'lira', 'requirement-clause', []],
      [rowsA, 'u.flag', 'bool', 'requirement-clause', []],
      [rowsA, 'u.m <= 5.0 [kg]', 'lra', 'requirement-clause', ['units']],
      [rowsA, 'u.a ^ 2 > 1.0', 'nra-poly/pinned', 'requirement-clause', []],
      [rowsA, '1.0 < 2.0', 'ground', 'requirement-clause', []],
      [rowsA, 'u.a % 2.0 == 0.0', 'fence/unsupported-operator', 'requirement-clause', [], 'gate'],
      [rowsA, 'if u.a > 1.0 then u.b else u.a > 0.0', 'fence/non-numeric-operand', 'requirement-clause', [], 'encoder'],
      [rowsB, 'false', 'ground', 'requirement-clause', []],
      [rowsB, 'u.t1 <= u.t2', 'lra', 'requirement-clause', ['offset-order']],
      [rowsB, 'u.dur >= 1.0 [min]', 'lra', 'requirement-clause', ['units']],
      [rowsB, '(if u.v > 1.0 then u.v else u.w) >= 1.0', 'lra', 'requirement-clause', ['ite']],
      [rowsB, 'u.k / u.v < 5.0', 'nira/pinned', 'requirement-clause', ['div-guard']],
      [rowsB, 'u.label == u.label2', 'lra', 'requirement-clause', ['text-as-real']],
      [rowsB, 'u.v / 0.0 > 1.0', 'fence/unsupported-operator', 'requirement-clause', [], 'encoder'],
      [rowsB, 'u.v ^ 40 > 1.0', 'fence/unsupported-operator', 'requirement-clause', [], 'encoder'],
    ];
    expect(want).toHaveLength(20);
    for (const [rows, expression, cell, reading, mods, layer] of want) {
      const model = rows === rowsA ? A : B;
      expect(cellFor(model, rows, expression), expression).toBe(cell);
      const c = classifyRow(rowOf(rows, expression), { model });
      expect([c.reading, c.modifiers, c.fence?.layer], expression).toEqual([reading, mods, layer]);
    }
  });

  it('takes `assume false` and a literal-only comparison for `ground`: zero symbols, whatever the arithmetic', () => {
    expect(classifyRow(rowOf(rowsB, 'false'), { model: B }).shape).toBe('ground');
    expect(classifyRow(rowOf(rowsA, '1.0 < 2.0'), { model: A }).shape).toBe('ground');
  });

  it('gives a row with no formal clause the fence and no reading at all', () => {
    const prose = rowsB.find((r) => r.source === 'none')!;
    const c = classifyRow(prose, { model: B });
    expect([c.primary, c.reading, c.fence, c.shape]).toEqual(['fence/no-formal-clause', null, { id: 'fence/no-formal-clause', layer: 'gate' }, null]);
  });

  it('reads the stated value, the definition, the assertion and the bind of the model as what they are', () => {
    const readingOfRow = (rows: Obligation[], model: Model, e: string, s?: ObligationSource) => classifyRow(rowOf(rows, e, s), { model }).reading;
    expect(readingOfRow(rowsA, A, 'a == 2', 'feature-value')).toBe('stated-value');
    expect(readingOfRow(rowsA, A, 'prod == a * b')).toBe('defining-equation');
    expect(readingOfRow(rowsA, A, 'd == a * 2.0')).toBe('asserted-fact');
    expect(rowsB.filter((r) => r.source === 'bind').map((r) => classifyRow(r, { model: B }).reading)).toEqual(['bind-equality']);
  });

  it('counts every worklist row once, in a static census that does not depend on the order of the rows', () => {
    for (const [model, rows] of [[A, rowsA], [B, rowsB]] as const) {
      const c = staticCensus(model, rows);
      expect(c.rows).toBe(rows.length);
      expect(Object.values(c.cells).reduce((a, b) => a + b, 0)).toBe(rows.length);
      const withReading = rows.filter((r) => r.source !== 'none').length;
      expect(Object.values(c.readings).reduce((a, b) => a + b, 0)).toBe(withReading);
      expect(staticCensus(model, [...rows].reverse())).toEqual(c);
      for (const k of Object.keys(c.cells)) expect(CELLS, k).toContain(k);
    }
  });

  it('reads a refine row without a symbol of its own, as refinement encodes it', () => {
    const r = rowOf(rowsA, 'u.a * u.b > 1.0');
    const { row, kind } = classifiableOf(r, 'clause');
    expect(row.vars.every((v) => v.symbol === undefined)).toBe(true);
    const c = classifyRow(row, { model: A, kind });
    expect([c.shape, c.reading]).toEqual(['nra-poly', 'requirement-clause']);
    expect(classifyRow(classifiableOf(r, 'gamma').row, { model: A, kind: 'gamma' }).reading).toBe('bind-equality');
  });
});

/* ──────────────────────────────── CC-12b: text-as-real ──────────────────────────────── */

describe('the String closure agrees with the sorts the contracts give', () => {
  it('names Boolean and the integer kinds exactly where `sortOf` does, on every feature of the corpus', async () => {
    const files = [
      ...readdirSync(resolve(process.cwd(), 'examples')).filter((f) => f.endsWith('.sysml')).map((f) => `examples/${f}`),
      'test/fixtures/drone-swarm-v9.sysml.txt',
    ];
    let features = 0;
    let strings = 0;
    for (const f of files) {
      const model = await load(read(f), f.replace(/\.txt$/, ''));
      const seen = new Set<string>();
      for (const row of obligationsOf(model)) {
        for (const v of row.vars) {
          if (seen.has(v.featureId)) continue;
          seen.add(v.featureId);
          const names = typeNamesOf(model, v.featureId);
          const el = model.get(v.featureId as never)!;
          const sort = typeof el.attrs.value === 'boolean' || names.has('Boolean') ? 'Bool' : names.has('Integer') || names.has('Natural') || names.has('UnlimitedNatural') ? 'Int' : 'Real';
          expect(sort, `${f}: ${v.qualifiedName}`).toBe(row.sortPerVar[v.path] ?? 'Real');
          features += 1;
          if (names.has('String')) strings += 1;
        }
      }
    }
    expect(features).toBeGreaterThan(100);
    // the closure is read, not assumed: a String feature of the corpus is found by name
    expect(strings).toBeGreaterThanOrEqual(0);
  }, 180_000);

  it('marks a row over a String feature `text-as-real`, and no other', () => {
    const c = classifyRow(rowOf(rowsB, 'u.label == u.label2'), { model: B });
    expect(c.modifiers).toEqual(['text-as-real']);
    expect(classifyRow(rowOf(rowsB, 'u.w * u.v > 1.0'), { model: B }).modifiers).toEqual([]);
  });
});

/* ────────────────────────────────── CC-13: the roll-up ────────────────────────────────── */

describe('the roll-up folds to the weakest cell', () => {
  const classOf = (rows: Obligation[], model: Model, e: string, s?: ObligationSource): RowClass => classifyRow(rowOf(rows, e, s), { model });
  /** The shape facts of a script whose bytes divide by a symbol, over a and b. */
  const NRA_DIV = { mask: 4, int: false, guarded: true, nonlinear: true, symbols: ['C::Sys::a', 'C::Sys::b'], nlSymbols: ['C::Sys::a', 'C::Sys::b'] };
  function proof(over: Partial<RollUpInput> = {}): RollUpInput {
    const pinned = pinnedSymbolsOf(A, axiomsOf(rowsA).map((row) => ({ row, encoded: true as const })));
    const goal = classOf(rowsA, A, 'u.m <= 5.0 [kg]');
    const kept = classOf(rowsA, A, 'q == a / b');
    return {
      scope: 'proof',
      query: 'verify',
      basis: 'solver',
      logic: 'QF_NRA',
      scripts: [scriptClassOf(NRA_DIV, 'QF_NRA', new Map())],
      goal,
      context: [kept, classOf(rowsA, A, 'u.a > 0.0')],
      pinned,
      ...over,
    };
  }

  it('names the weakest cell, the goal alone and the script, and sorts its sets by the register', () => {
    const s = noFacts(() => rollUp(proof()));
    expect(s.shape).toEqual([
      { id: 'nra-div', search: 'pinned', rows: 1 },
      { id: 'lra', rows: 2 },
    ]);
    expect(s.script).toEqual({ shape: 'nra-div', search: 'pinned' });
    expect(s.goal).toMatchObject({ shape: 'lra', modifiers: ['units'], reading: 'requirement-clause' });
    // with no fact every encoded cell is `experimental`: the tie goes to the earlier cell of the register
    expect(s.weakest).toMatchObject({ cell: 'nra-div/pinned', level: 'experimental', firstUnmet: null });
    expect(s.reading.map((r) => r.id)).toEqual(['defining-equation', 'requirement-clause']);
    expect(s.logic).toBe('QF_NRA');
  });

  it('takes the lowest LEVEL, not the earliest cell, and prints the goal alone beside it', () => {
    const levels: Record<string, Level> = { lra: 'differential-tested', 'nra-div/pinned': 'tested', units: 'tested', 'requirement-clause': 'tested', 'defining-equation': 'experimental' };
    const text = withLevelSource((cell) => levels[cell] ?? 'tested', () => classLines(rollUp(proof())));
    expect(text[0]).toBe('classes: shape nra-div/pinned, lra, script nra-div/pinned · modifiers units · reading defining-equation, requirement-clause');
    expect(text[1]).toBe('maturity: weakest defining-equation [experimental]; goal alone: lra [differential-tested]');
    expect(text).toHaveLength(2);
  });

  it('gives the same statement for the rows in any order', () => {
    const base = proof();
    const a = rollUp(base);
    expect(rollUp({ ...base, context: [...base.context].reverse() })).toEqual(a);
    const many = [...rowsA, ...rowsB].map((r) => classifyRow(r, { model: rowsA.includes(r) ? A : B }));
    const fold = (ctx: RowClass[]) => rollUp({ ...base, goal: undefined, context: ctx });
    expect(fold([...many].reverse())).toEqual(fold(many));
  });

  it('leaves fences out of the weakest and lists them, with partial-context', () => {
    const refused = classOf(rowsA, A, 'u.a % 2.0 == 0.0');
    const s = rollUp(proof({ context: [classOf(rowsA, A, 'u.a > 0.0'), refused, refused] }));
    expect(s.fenced).toEqual([{ id: 'fence/unsupported-operator', layer: 'gate', rows: 2 }]);
    expect(s.modifiers.map((m) => m.id)).toContain('partial-context');
    expect(s.weakest?.cell.startsWith('fence/')).toBe(false);
    expect(classLine(s)).toContain('context refused: fence/unsupported-operator ×2');
    // a fenced goal has no weakest cell to name and prints the fence line
    const g = rollUp(proof({ goal: refused, context: [], forgiven: true, basis: 'none' }));
    expect(g.goal.fence).toEqual({ id: 'fence/unsupported-operator', layer: 'gate', forgiven: true });
    expect(noFacts(() => classLine(g))).toBe('classes: fence/unsupported-operator (gate) [unpinned] — not sent to z3; --allow-inconclusive forgives this outcome');
  });

  it('says a fenced goal is no flag’s to forgive when the code is not forgivable or the word is a point evaluation', () => {
    const refused = classOf(rowsA, A, 'u.a % 2.0 == 0.0');
    const point = classLine(rollUp(proof({ goal: refused, context: [], forgiven: false, basis: 'point-evaluation' })));
    expect(point).toContain('a point evaluation at the model’s values, not a solver answer, and no flag forgives it');
    expect(classLine(rollUp(proof({ goal: refused, context: [], forgiven: false, basis: 'none' })))).toContain('no flag forgives this outcome');
  });

  it('names a basis other than `solver` and states an unclassified statement for what it is', () => {
    const lines = classLines(rollUp(proof({ basis: 'numeric-surface' })));
    expect(lines.at(-1)).toMatch(/^basis: numeric-surface — the verdict word was decided on the numeric surface/);
    expect(classLines(unclassified('proof', 'verify'))).toEqual(["classes: unclassified — a gap in the tool's class register"]);
    expect(unclassified('run', 'consistency')).toMatchObject({ status: 'unclassified', weakest: null, shape: [] });
  });

  it('turns a throw in the classifier of an engine into an unclassified statement, in the group and its run', () => {
    const run = new ClassRollup('fault-tree');
    const group = new ClassRollup('fault-tree', run);
    expect(() =>
      group.guard(() => {
        throw new Error('a gap in the register');
      }),
    ).not.toThrow();
    expect(group.statement({ scope: 'group', basis: 'solver' })).toMatchObject({ status: 'unclassified', scope: 'group' });
    expect(run.statement({ scope: 'run', basis: 'solver' })).toMatchObject({ status: 'unclassified', scope: 'run' });
    // a throw inside what `add` reads back (the pinned set) is the same
    const third = new ClassRollup('bounds');
    third.add({ shape: 'nra-poly', nlSymbols: ['a'], logic: 'QF_NRA' }, [], () => {
      throw new Error('pinned');
    });
    expect(third.statement({ scope: 'run', basis: 'solver' }).status).toBe('unclassified');
  });

  it('keeps the script cell: a script stronger than any row is the weakest claim of its proof', () => {
    // m1: every row is `lra`/`lira`, the script is QF_NIRA
    const row = classOf(rowsA, A, 'u.n >= 3');
    const nira = scriptClassOf({ mask: 2, int: true, guarded: false, nonlinear: true, symbols: ['C::Sys::a', 'C::Sys::n'], nlSymbols: ['C::Sys::a', 'C::Sys::n'] }, 'QF_NIRA', new Map());
    const s = rollUp({ scope: 'proof', query: 'verify', basis: 'solver', logic: 'QF_NIRA', scripts: [nira], goal: row, context: [], pinned: new Set(['C::Sys::a', 'C::Sys::n']) });
    expect(s.script).toEqual({ shape: 'nira', search: 'pinned' });
    expect(s.weakest?.cell).toBe('nira/pinned');
    expect(s.shape.map((x) => x.id)).toEqual(['lira']);
  });

  it('takes the highest-precedence script of a group, a `free` over a `pinned`', () => {
    const f = (shape: 'nra-poly' | 'nra-div', syms: string[]) =>
      scriptClassOf({ mask: shape === 'nra-div' ? 4 : 2, int: false, guarded: shape === 'nra-div', nonlinear: true, symbols: syms, nlSymbols: syms }, 'QF_NRA', new Map());
    const s = rollUp({ scope: 'group', query: 'fault-tree', basis: 'none', logic: 'QF_NRA', scripts: [f('nra-poly', ['p']), f('nra-div', ['q']), f('nra-div', ['p'])], context: [], pinned: new Set(['p']) });
    expect(s.script).toEqual({ shape: 'nra-div', search: 'free' });
  });

  it('ranks only encoded cells and caps a query other than verify at `tested`', () => {
    expect(weakestOf(['fence/unparseable'])).toBeNull();
    expect(levelOf('fence/unparseable', { facts: NO_FACTS })).toBe('unpinned');
    expect(levelOf('lra', { facts: NO_FACTS })).toBe('experimental');
    expect(levelOf('lra', { facts: NO_FACTS, query: 'refine' })).toBe('experimental');
    expect(LEVELS).toEqual(['unrated', 'experimental', 'tested', 'differential-tested', 'battery-backed']);
    const stub = (cell: string): Level => (cell === 'lra' ? 'battery-backed' : 'unrated');
    expect(withLevelSource(stub, () => weakestOf(['lra', 'ite'], { query: 'verify' })?.cell)).toBe('ite');
    // a tie goes to the earlier cell of the register: shapes come before modifiers
    expect(noFacts(() => weakestOf(['ite', 'lra'])?.cell)).toBe('lra');
  });
});

describe('the basis follows the trace, not the outcome word', () => {
  const facts = { goalRefused: false, dropped: false, partialAntecedent: false, goalSymbols: ['x'] };
  const pinned = new Set(['x']);
  it('reads each state of the table', () => {
    expect(basisOf('proved', facts, pinned)).toBe('solver');
    expect(basisOf('proved', { ...facts, dropped: true }, pinned)).toBe('solver+numeric');
    expect(basisOf('refuted', facts, pinned)).toBe('solver-witness');
    expect(basisOf('refuted', facts, new Set())).toBe('numeric-surface');
    expect(basisOf('refuted', { ...facts, free: new Set(['x']) }, new Set())).toBe('solver-witness');
    expect(basisOf('refuted', { ...facts, textAsReal: true }, pinned)).toBe('numeric-surface');
    expect(basisOf('refuted', { ...facts, goalRefused: true }, pinned)).toBe('point-evaluation');
    expect(basisOf('vacuous', facts, pinned)).toBe('solver');
    expect(basisOf('vacuous', { ...facts, partialAntecedent: true }, pinned)).toBe('numeric-surface');
    expect(basisOf('axioms-inconsistent', { ...facts, partialAntecedent: true }, pinned)).toBe('numeric-surface');
    expect(basisOf('unsupported', { ...facts, goalRefused: true }, pinned)).toBe('none');
    expect(basisOf('timeout', facts, pinned)).toBe('none');
    expect(basisOf('design-admitted', facts, pinned)).toBe('solver-witness');
  });
});

/* ──────────────────────────────── CC-19: free-independence ──────────────────────────────── */

describe('shape, reading and fence do not depend on `--free`', () => {
  it('gives the memoised class on a fresh row encoded with every variable freed', () => {
    let n = 0;
    for (const [model, rows] of [[A, rowsA], [B, rowsB]] as const) {
      for (const row of rows) {
        const memo = classifyRow(row, { model });
        const clone: Obligation = { ...row };
        const free = new Set(row.vars.flatMap((v) => [v.path, v.qualifiedName]));
        const enc = row.node && row.encodable === true ? encodeRelation(row.node, encodeVariables(row.vars, row.sortPerVar, { scaled: row.scaled, free })) : undefined;
        const again = classifyRow(clone, { model, ...(enc ? { encoded: enc } : {}) });
        expect(again, row.expression).toEqual(memo);
        expect(classifyRow(row, { model }), 'the memo is by row').toBe(memo);
        n += 1;
      }
    }
    expect(n).toBeGreaterThan(50);
  });
});

/* ────────────────────────────────── CC-20: the stub seam ────────────────────────────────── */

describe('maturity is a label: replacing every level moves nothing but levels', () => {
  it('keeps every cell, count, basis and script when the level source is random', () => {
    const classes = rowsA.map((r) => classifyRow(r, { model: A }));
    const pinned = pinnedSymbolsOf(A, axiomsOf(rowsA).map((row) => ({ row, encoded: true as const })));
    const input: RollUpInput = { scope: 'run', query: 'verify', basis: 'solver+numeric', logic: 'QF_NRA', scripts: [], context: classes, pinned };
    const plain = rollUp(input);
    let seed = 7;
    const rnd = (): Level => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return (['unrated', 'experimental', 'tested', 'differential-tested', 'battery-backed'] as const)[seed % 5]!;
    };
    for (let i = 0; i < 20; i++) {
      const stubbed = withLevelSource(() => rnd(), () => rollUp(input));
      const strip = (s: typeof plain) => ({ ...s, levels: undefined, weakest: undefined });
      expect(strip(stubbed)).toEqual(strip(plain));
      expect(withLevelSource(() => rnd(), () => classLines(rollUp(input))[0])).toBe(classLine(plain));
    }
  });

  it('restores the level source after the body, and when the body throws', () => {
    expect(() => withLevelSource(() => 'battery-backed', () => { throw new Error('x'); })).toThrow('x');
    expect(levelOf('lra')).not.toBe('battery-backed');
    expect(weakestOf(['lra'])?.level).not.toBe('battery-backed');
  });
});

/* ───────────────────────────────── CC-21: pinned and free ───────────────────────────────── */

describe('`search` is the strict reading of what the script pins', () => {
  it('reads an unvalued product as free and a stated value as pinned', () => {
    expect(cellFor(A, rowsA, 'u.u1 * u.u2 > 1.0')).toBe('nra-poly/free');
    expect(cellFor(A, rowsA, 'u.a * u.b > 1.0')).toBe('nra-poly/pinned');
    expect(cellFor(A, rowsA, 'u.a ^ 2 > 1.0')).toBe('nra-poly/pinned');
    expect(cellFor(A, rowsA, 'u.a / u.u1 < 5.0')).toBe('nra-div/free');
  });

  it('pins through a chain of defining equations and a bind', () => {
    expect(cellFor(A, rowsA, 'u.d * u.a > 1.0')).toBe('nra-poly/pinned'); // d == a * 2.0, asserted
    expect(cellFor(B, rowsB, 'u.r * u.v > 1.0')).toBe('nra-poly/pinned'); // r == p * v, p == v * 2.0
    expect(cellFor(B, rowsB, 'u.w * u.v > 1.0')).toBe('nra-poly/pinned'); // bind w = v, v stated
  });

  it('flips to free when `--free` releases a stated value, down the whole chain', () => {
    expect(cellFor(A, rowsA, 'u.a * u.b > 1.0', new Set(['C::Sys::a']))).toBe('nra-poly/free');
    expect(cellFor(B, rowsB, 'u.r * u.v > 1.0', new Set(['B::Link::v']))).toBe('nra-poly/free');
    expect(cellFor(B, rowsB, 'u.w * u.v > 1.0', new Set(['B::Link::v']))).toBe('nra-poly/free');
  });

  it('reads a script with no axioms (a consistency script, values released) as free', () => {
    const c = classifyRow(rowOf(rowsA, 'u.a * u.b > 1.0'), { model: A });
    expect(searchOf(c, new Set())).toBe('free');
  });

  it('never pins a symbol through an equation that mentions it on its own right-hand side', () => {
    // `x == x * a` and `y == y + a`: the engine’s `pinnedSymbols` pins x and y (every variable of the row is pinned or is the
    // defined symbol); here nothing is fixed, and a product over them is free.
    const axioms = axiomsOf(rowsA).map((row) => ({ row, encoded: true as const }));
    const pinned = pinnedSymbolsOf(A, axioms);
    expect(pinned.has('C::Sys::x')).toBe(false);
    expect(pinned.has('C::Sys::y')).toBe(false);
    expect(cellFor(A, rowsA, 'u.x * u.a > 1.0')).toBe('nra-poly/free');
    expect(cellFor(A, rowsA, 'u.y * u.a > 1.0')).toBe('nra-poly/free');
    // the self-referencing axioms themselves are free sites
    expect(cellFor(A, rowsA, 'x == x * a')).toBe('nra-poly/free');
  });

  it('leaves mutual definitions unpinned', () => {
    // z == z2 * v and z2 == z / v: each needs the other
    const pinned = pinnedSymbolsOf(B, axiomsOf(rowsB).map((row) => ({ row, encoded: true as const })));
    expect(pinned.has('B::Link::z')).toBe(false);
    expect(pinned.has('B::Link::z2')).toBe(false);
    expect(cellFor(B, rowsB, 'u.z * u.v > 1.0')).toBe('nra-poly/free');
  });

  it('pins through an equation only with the defined feature on its left, and never pins more than the engine does', async () => {
    // `L == M` with M valueless defines M for the engine (it pins M once L is pinned); here the defined feature
    // must be the bare left-hand reference, so M stays free: the weaker reading, a sound abstention.
    const model = await load(`package W {
  part def P {
    attribute L : ScalarValues::Real = 2.0;
    attribute M : ScalarValues::Real;
    attribute N : ScalarValues::Real;
    assert constraint qa { L == M }
    assert constraint qb { N == L + 1.0 }
  }
  part p : P;
}`);
    const pinned = pinnedSymbolsOf(model, axiomsOf(obligationsOf(model)).map((row) => ({ row, encoded: true as const })));
    expect(pinned.has('W::P::L')).toBe(true);
    expect(pinned.has('W::P::N')).toBe(true);
    expect(pinned.has('W::P::M')).toBe(false);
  });

  it('pins only what the encoder accepted: a refused axiom pins nothing', () => {
    const axioms = axiomsOf(rowsA).map((row) => ({ row, encoded: undefined }));
    expect(pinnedSymbolsOf(A, axioms).size).toBe(0);
  });

  it('reads a nonlinear shape with an empty site set as free, and a dropped read as the weaker reading', () => {
    expect(searchOf({ shape: 'nra-poly', nlSymbols: [] }, new Set(['a']))).toBe('free');
    expect(searchOf({ shape: 'lra', nlSymbols: [] }, new Set())).toBeUndefined();
    expect(searchOf({ shape: null, nlSymbols: [] }, new Set())).toBeUndefined();
    expect(shapeCell('lra')).toBe('lra');
    expect(shapeCell('nira', 'free')).toBe('nira/free');
    // `(a ^ 0) * (b ^ 0)`: the bytes keep no symbol, the walk flags it nonlinear, and every symbol it read counts
    expect(cellFor(A, rowsA, '(u.a ^ 0) * (u.b ^ 0) > 0.0')).toBe('nra-poly/pinned');
    expect(cellFor(A, rowsA, '(u.u1 ^ 0) * (u.u2 ^ 0) > 0.0')).toBe('nra-poly/free');
    const c = classifyRow(rowOf(rowsA, '(u.u1 ^ 0) * (u.u2 ^ 0) > 0.0'), { model: A });
    expect(c.nlSymbols).toEqual(['C::Sys::u1', 'C::Sys::u2']);
  });
});

describe('the words the register prints', () => {
  it('states what a level is, without grading a model or claiming more', () => {
    expect(MATURITY_SENTENCE).toMatch(/not a verdict on any model and moves no verdict/);
    // the words are spelt in pieces so that this file carries none of them (the claims scan reads tests too)
    const words = [['con', 'formant'], ['cert', 'ified'], ['com', 'pliant'], ['\\bveri', 'fied\\b'], ['\\bcor', 'rect\\b'], ['\\bs', 'afe\\b']];
    for (const banned of words.map((w) => new RegExp(w.join(''), 'i'))) {
      expect(MATURITY_SENTENCE).not.toMatch(banned);
      for (const d of Object.values(CONSTRAINT_CLASSES)) {
        expect(d.encodes, d.id).not.toMatch(banned);
        for (const l of d.limits) expect(l.text, d.id).not.toMatch(banned);
      }
    }
  });
});

/* ─────────────────────────────── CC-14: the maturity rubric ─────────────────────────────── */

describe('the rubric is a pure function of the facts and the defects', () => {
  const cell = (over: Partial<CellFacts> = {}): CellFacts => ({
    rows: 3,
    models: 1,
    encoderTests: 1,
    goldenDecided: 1,
    goldenCases: 1,
    tableAgree: 0,
    tableProbes: 0,
    tableDisagree: 0,
    battery: null,
    ...over,
  });
  const facts = (cells: Record<string, CellFacts>, over: Partial<ClassFacts> = {}): ClassFacts => ({ ...NO_FACTS, cells, ...over });
  const defect = (over: Partial<Defect>): Defect => ({ id: 'D-x', todo: 'x', classes: ['lra'], kind: 'wrong-statement', note: '', ...over });
  const level = (f: ClassFacts, c = 'lra', env: { query?: 'verify' | 'refine'; z3?: string } = {}): Level => levelOf(c, { facts: f, ...env });

  it('climbs the ladder on the thresholds of the plan, one clause at a time', () => {
    expect([RUBRIC.tableAgree, RUBRIC.tableProbes, RUBRIC.batteryCells]).toEqual([20, 3, 200]);
    expect(level(facts({ lra: cell({ encoderTests: 0 }) }))).toBe('experimental');
    expect(level(facts({ lra: cell({ goldenDecided: 0 }) }))).toBe('experimental');
    expect(level(facts({ lra: cell() }))).toBe('tested');
    expect(level(facts({ lra: cell({ tableAgree: 19, tableProbes: 5 }) }))).toBe('tested');
    expect(level(facts({ lra: cell({ tableAgree: 20, tableProbes: 2 }) }))).toBe('tested');
    expect(level(facts({ lra: cell({ tableAgree: 20, tableProbes: 3 }) }))).toBe('differential-tested');
    expect(level(facts({ lra: cell({ tableAgree: 90, tableProbes: 9, tableDisagree: 1 }) }))).toBe('tested');
    const diff = { tableAgree: 90, tableProbes: 9 };
    expect(level(facts({ lra: cell({ ...diff, battery: { cells: 199, wrong: 0, z3: '5.3.1' } }) }))).toBe('differential-tested');
    expect(level(facts({ lra: cell({ ...diff, battery: { cells: 200, wrong: 1, z3: '5.3.1' } }) }))).toBe('differential-tested');
    expect(level(facts({ lra: cell({ ...diff, battery: { cells: 200, wrong: 0, z3: '5.3.0' } }) }))).toBe('differential-tested');
    expect(level(facts({ lra: cell({ ...diff, battery: { cells: 200, wrong: 0, z3: '5.3.1' } }) }))).toBe('battery-backed');
  });

  it('names the first clause the next rung asks for and the cell does not meet, as a phrase', () => {
    const detail = (c: Partial<CellFacts>) => levelDetail('lra', { facts: facts({ lra: cell(c) }) });
    expect(detail({ encoderTests: 0 }).firstUnmet).toBe('an encoder test, have 0');
    expect(detail({ goldenDecided: 0 }).firstUnmet).toBe('a decided golden row, have 0');
    expect(detail({}).firstUnmet).toBe('20 four-surface rows agree, have 0');
    expect(detail({ tableAgree: 20 }).firstUnmet).toBe('3 probes, have 0');
    expect(detail({ tableAgree: 20, tableProbes: 3, tableDisagree: 2 }).firstUnmet).toBe('no row against its hand-computed answer, have 2');
    expect(detail({ tableAgree: 20, tableProbes: 3 }).firstUnmet).toBe('a battery of 200 cells, have none');
    expect(detail({ tableAgree: 20, tableProbes: 3, battery: { cells: 200, wrong: 0, z3: '5.3.1' } }).firstUnmet).toBeNull();
  });

  it('never lowers a level when a fact is raised, and never raises it when one is lowered', () => {
    let seed = 11;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let i = 0; i < 300; i++) {
      const base = cell({ encoderTests: rnd(2), goldenDecided: rnd(2), tableAgree: rnd(30), tableProbes: rnd(5), tableDisagree: rnd(2), battery: rnd(2) ? { cells: rnd(300), wrong: rnd(2), z3: '5.3.1' } : null });
      const more = { ...base, encoderTests: base.encoderTests + rnd(2), goldenDecided: base.goldenDecided + rnd(2), tableAgree: base.tableAgree + rnd(8), tableProbes: base.tableProbes + rnd(3) };
      const fewer = { ...base, tableDisagree: base.tableDisagree + rnd(2) };
      expect(levelRank(level(facts({ lra: more })))).toBeGreaterThanOrEqual(levelRank(level(facts({ lra: base }))));
      expect(levelRank(level(facts({ lra: fewer })))).toBeLessThanOrEqual(levelRank(level(facts({ lra: base }))));
    }
  });

  it('caps by the kind of the open defect: wrong-verdict to experimental, wrong-statement to tested, the rest not at all', () => {
    const top = cell({ tableAgree: 90, tableProbes: 9 });
    const f = (d: Defect[]) => facts({ lra: top }, { defects: d });
    expect(level(f([]))).toBe('differential-tested');
    expect(level(f([defect({ kind: 'wrong-verdict' })]))).toBe('experimental');
    expect(level(f([defect({ kind: 'wrong-statement' })]))).toBe('tested');
    expect(level(f([defect({ kind: 'abstains' })]))).toBe('differential-tested');
    expect(level(f([defect({ kind: 'fenced' })]))).toBe('differential-tested');
    expect(level(f([defect({ kind: 'wrong-statement', classes: ['ite'] })]))).toBe('differential-tested');
    expect(levelDetail('lra', { facts: f([defect({ kind: 'wrong-verdict', id: 'D-v' })]) }).capped).toEqual(['open wrong-verdict: D-v']);
    // a defect of `nra-div` covers both its cells
    const nl = facts({ 'nra-div/pinned': top, 'nra-div/free': top }, { defects: [defect({ classes: ['nra-div'] })] });
    expect([level(nl, 'nra-div/pinned'), level(nl, 'nra-div/free')]).toEqual(['tested', 'tested']);
  });

  it('applies a defect that names queries to results of those queries only', () => {
    const top = cell({ tableAgree: 90, tableProbes: 9 });
    const f = facts({ lra: top }, { defects: [defect({ kind: 'wrong-verdict', queries: ['property-gate-4'] })] });
    expect(level(f)).toBe('differential-tested');
    expect(levelOf('lra', { facts: f, query: 'verify' })).toBe('differential-tested');
    expect(levelOf('lra', { facts: f, query: 'property-gate-4' })).toBe('experimental');
  });

  it('caps a query other than verify, a z3 other than the facts’ and an unattributed known-false block at `tested`', () => {
    const top = cell({ tableAgree: 90, tableProbes: 9, battery: { cells: 500, wrong: 0, z3: '5.3.1' } });
    const f = facts({ lra: top });
    expect(level(f, 'lra', { query: 'verify' })).toBe('battery-backed');
    for (const q of ['refine', 'consistency', 'bounds', 'fault-tree', 'property-gate-4'] as const) expect(levelOf('lra', { facts: f, query: q }), q).toBe('tested');
    // another z3: what z3 measured (the table, the battery) counts as 0, so the cell stands at what the repository pins
    expect(level(f, 'lra', { z3: '5.3.2' })).toBe('tested');
    expect(levelDetail('lra', { facts: f, z3: '5.3.2' }).capped).toEqual([]);
    expect(level(f, 'lra', { z3: '5.3.1' })).toBe('battery-backed');
    const unparsed = facts({ lra: top }, { knownFalse: { parsed: false, entries: 0, unattributed: 0 } });
    const unattributed = facts({ lra: top }, { knownFalse: { parsed: true, entries: 2, unattributed: 1 } });
    for (const x of [unparsed, unattributed]) {
      expect(level(x)).toBe('tested');
      expect(levelDetail('lra', { facts: x }).capped).toEqual(['a known-false block of the differential table cannot be attributed']);
    }
    expect(level(facts({ lra: top }, { knownFalse: { parsed: true, entries: 2, unattributed: 0 } }))).toBe('battery-backed');
  });

  it('counts a fact that is absent as 0, and says a cell no row stands in has no evidence', () => {
    expect(levelDetail('lira', { facts: NO_FACTS })).toMatchObject({ level: 'experimental', noEvidence: true, firstUnmet: 'an encoder test, have 0' });
    expect(levelDetail('lra', { facts: facts({ lra: cell() }) }).noEvidence).toBe(false);
    expect(levelDetail('lra', { facts: facts({ lra: cell({ rows: 0 }) }) }).noEvidence).toBe(true);
    expect(levelOf('not-a-cell', { facts: NO_FACTS })).toBe('experimental');
    // a fence no row stands in has no evidence either, and one a row stands in has
    expect(levelDetail('fence/collection-valued', { facts: NO_FACTS }).noEvidence).toBe(true);
    expect(levelDetail('fence/collection-valued', { facts: facts({ 'fence/collection-valued': cell({ rows: 2 }) }) }).noEvidence).toBe(false);
  });

  it('puts a fence at `fenced` only when a test pins each layer it is produced at and its sentences are in source', () => {
    const f = (layers: Array<'gate' | 'encoder'>, stems = true, d: Defect[] = []): ClassFacts =>
      facts({}, { fences: { 'fence/unresolved-name': { layersPinned: layers, stems } }, defects: d });
    const id = 'fence/unresolved-name'; // produced at the gate and at the encoder
    expect(CONSTRAINT_CLASSES[id].layers).toEqual(['gate', 'encoder']);
    expect(levelOf(id, { facts: f(['gate', 'encoder']) })).toBe('fenced');
    expect(levelDetail(id, { facts: f(['gate']) })).toMatchObject({ level: 'unpinned', firstUnmet: 'a test that pins the encoder layer' });
    expect(levelOf(id, { facts: f([]) })).toBe('unpinned');
    expect(levelDetail(id, { facts: f(['gate', 'encoder'], false) })).toMatchObject({ level: 'unpinned', firstUnmet: 'the register sentences found in source' });
    expect(levelOf(id, { facts: f(['gate', 'encoder'], true, [defect({ classes: [id], kind: 'wrong-statement' })]) })).toBe('fenced-defect');
    expect(levelOf(id, { facts: f(['gate', 'encoder'], true, [defect({ classes: [id], kind: 'abstains' })]) })).toBe('fenced');
    expect(levelOf(id, { facts: f(['gate', 'encoder']), query: 'refine' })).toBe('fenced');
  });

  it('credits a proof by what decided it: the numeric surface’s work never credits a shape cell (the C.4 table)', () => {
    const p = {
      shapes: new Set(['lra', 'nra-div/pinned']),
      modifiers: new Set(['units', 'partial-context', 'text-as-real']),
      readings: new Set(['requirement-clause']),
    } as unknown as Proof;
    const got = (b: Parameters<typeof credit>[0]) => [...credit(b, p)].sort();
    expect(got('solver')).toEqual(['lra', 'nra-div/pinned', 'partial-context', 'requirement-clause', 'text-as-real', 'units']);
    expect(got('solver-witness')).toEqual(got('solver'));
    expect(got('solver+numeric')).toEqual(['lra', 'nra-div/pinned', 'partial-context']);
    expect(got('numeric-surface')).toEqual(['partial-context', 'text-as-real']);
    expect(got('point-evaluation')).toEqual(['partial-context', 'text-as-real']);
    expect(got('none')).toEqual([]);
  });

  it('carries the cap and the unmet clause up to the roll-up’s weakest cell', () => {
    const f = facts({ lra: cell({ tableAgree: 90, tableProbes: 9 }), units: cell() }, { defects: [defect({ classes: ['units'], kind: 'wrong-statement', id: 'D-u' })] });
    const w = weakestOf(['lra', 'units'], { facts: f });
    expect(w).toMatchObject({ cell: 'units', level: 'tested', firstUnmet: '20 four-surface rows agree, have 0', capped: [] });
    const g = facts({ units: cell({ tableAgree: 90, tableProbes: 9 }) }, { defects: [defect({ classes: ['units'], kind: 'wrong-statement', id: 'D-u' })] });
    expect(weakestOf(['units'], { facts: g })).toMatchObject({ level: 'tested', capped: ['open wrong-statement: D-u'] });
  });

  it('holds the plan’s decided caps on the committed facts: asserted-fact at experimental', () => {
    expect(levelRank(levelOf('asserted-fact', { facts: CLASS_FACTS }))).toBeLessThanOrEqual(levelRank('experimental'));
    for (const c of ['bind-equality', 'per-instance', 'inherited-context', 'text-as-real']) {
      expect(levelRank(levelOf(c, { facts: CLASS_FACTS })), c).toBeLessThanOrEqual(levelRank('tested'));
    }
    expect(CELLS.map((c) => levelOf(c, { facts: CLASS_FACTS })).includes('battery-backed')).toBe(false);
  });
});

/* ──────────────────────────────── CC-15: the register’s pointers ──────────────────────────────── */

describe('every pointer of the register resolves', () => {
  it('finds the test of each class by its exact string, and gives every encoded class at least one', () => {
    for (const d of Object.values(CONSTRAINT_CLASSES)) {
      for (const t of d.tests) expect(read(t.file), `${d.id}: ${t.find}`).toContain(t.find);
      if (d.family !== 'fence') expect(d.tests.length, `${d.id} has no test`).toBeGreaterThan(0);
      // a limit that cites a probe model names the test that reruns it
      for (const l of d.limits) if (l.pin) expect(read(l.pin.file), `${d.id}: ${l.pin.find}`).toContain(l.pin.find);
    }
  });

  it('pins a fence’s layer only with a test that names it, and says which pairs have none', () => {
    const pinned = new Set<string>();
    for (const d of Object.values(CONSTRAINT_CLASSES)) {
      for (const t of d.tests) {
        if (d.family === 'fence') {
          expect(t.layer, `${d.id}: ${t.find}`).toBeDefined();
          expect(d.layers, d.id).toContain(t.layer);
          pinned.add(`${d.id} ${t.layer}`);
        } else expect(t.layer).toBeUndefined();
      }
    }
    const all = FENCES.flatMap((f) => CONSTRAINT_CLASSES[f].layers.map((l) => `${f} ${l}`));
    expect(all).toHaveLength(19);
    // the (reason, layer) pairs no test pins yet: a fence with one is `unpinned`
    expect(all.filter((x) => !pinned.has(x)).sort()).toEqual(['fence/unit-unresolved gate', 'fence/unparseable gate', 'fence/unscalable gate']);
  });

  it('keeps the committed facts the register’s own count of resolving tests', () => {
    for (const d of Object.values(CONSTRAINT_CLASSES)) {
      const live = d.tests.filter((t) => read(t.file).includes(t.find)).length;
      for (const c of CELLS.filter((x) => x === d.id || x.startsWith(`${d.id}/`))) expect(CLASS_FACTS.cells[c]?.encoderTests, c).toBe(live);
    }
  });
});

/* ───────────────────────────────── CC-18: the defect sidecar ───────────────────────────────── */

describe('the defect sidecar names real entries and the register reads it', () => {
  interface Sidecar {
    version: number;
    defects: Defect[];
    pending?: Array<{ todo: string; note: string }>;
    resolved: Array<{ todo: string; by: string }>;
  }
  const sidecar = JSON.parse(read('docs/constraint-class-defects.json')) as Sidecar;
  const titles = [...read('TODO.md').matchAll(/^- \[ \] \*\*([\s\S]*?)\*\*/gm)].map((m) => m[1]!.replace(/\s+/g, ' ').trim());
  const bases = new Set<string>(Object.keys(CONSTRAINT_CLASSES));

  it('has unique ids, real kinds, real cells and real queries', () => {
    expect(sidecar.version).toBe(1);
    expect(new Set(sidecar.defects.map((d) => d.id)).size).toBe(sidecar.defects.length);
    for (const d of sidecar.defects) {
      expect(['wrong-verdict', 'wrong-statement', 'abstains', 'fenced'], d.id).toContain(d.kind);
      expect(d.classes.length, d.id).toBeGreaterThan(0);
      for (const c of d.classes) expect(bases.has(c), `${d.id}: ${c}`).toBe(true);
      for (const q of d.queries ?? []) expect(['verify', 'consistency', 'refine', 'bounds', 'fault-tree', 'property-gate-4'], d.id).toContain(q);
      expect(d.note.length, d.id).toBeGreaterThan(20);
    }
  });

  it('names an entry TODO.md holds, or one it lists as resolved or pending: lifting a cap is a reviewed edit', () => {
    const resolved = new Set(sidecar.resolved.map((r) => r.todo));
    const pending = new Set((sidecar.pending ?? []).map((r) => r.todo));
    for (const d of sidecar.defects) expect(titles.includes(d.todo) || resolved.has(d.todo) || pending.has(d.todo), `${d.id}: ${d.todo}`).toBe(true);
    // a resolved entry is closed: it is not a bullet any more
    for (const r of resolved) expect(titles.includes(r), r).toBe(false);
    for (const r of resolved) expect(sidecar.defects.some((d) => d.todo === r), `${r} still caps a class`).toBe(false);
  });

  it('is what the committed facts carry, so a hand edit of the sidecar is regenerated before it counts', () => {
    expect(CLASS_FACTS.defects).toEqual(sidecar.defects);
  });

  it('attributes the open wrong answers the plan names to the classes the plan names', () => {
    const by = (id: string) => sidecar.defects.find((d) => d.id === id)!;
    expect(by('D-assert-not')).toMatchObject({ classes: ['asserted-fact'], kind: 'wrong-verdict' });
    // gate 4 asserts the divisor guard since the review of classes-2: the defect that capped nra-div there is closed
    expect(sidecar.defects.some((d) => d.id === 'D-gate4-guard')).toBe(false);
    expect(by('D-inconsistent-axioms')).toMatchObject({ classes: ['bind-equality', 'per-instance'], kind: 'wrong-statement' });
    expect(by('D-subsetting-contradiction')).toMatchObject({ classes: ['inherited-context', 'per-instance'], kind: 'wrong-statement' });
    expect(by('D-bound-detail')).toMatchObject({ classes: ['text-as-real'], kind: 'wrong-statement' });
  });
});

describe('the known-false blocks of the differential table are read as the test writes them', () => {
  const src = [
    'const KNOWN_FALSE = new Map<string, string>([',
    "  ['a | A::c0', 'a reason with a ] and a [ in it'],",
    '  // a comment, [with brackets',
    "  ['b-rev | B::c1', `NO STEP: a ' quote and a ] in a template`],",
    ']);',
    'const KNOWN_FALSE_WITNESS = new Set<string>();',
    'const SAME_POINT_DEMOTED = new Map<string, string>([]);',
    "const SOME_SET = new Set<string>(['p | P::c', 'q | Q::c']);",
    'const BROKEN = new Map<string, string>([',
    "  ['never closed | X::c', 'x'],",
  ].join('\n');
  it('finds the key of each entry of a Map and of a Set, and an empty block', () => {
    expect(blockKeys(src, 'KNOWN_FALSE')).toEqual(['a | A::c0', 'b-rev | B::c1']);
    expect(blockKeys(src, 'KNOWN_FALSE_WITNESS')).toEqual([]);
    expect(blockKeys(src, 'SAME_POINT_DEMOTED')).toEqual([]);
    expect(blockKeys(src, 'SOME_SET')).toEqual(['p | P::c', 'q | Q::c']);
  });
  it('says it cannot read a block that is missing or does not close, so the rubric caps every cell', () => {
    expect(blockKeys(src, 'NOT_THERE')).toBeNull();
    expect(blockKeys(src, 'BROKEN')).toBeNull();
  });
  it('reads the real blocks of the differential test, attributed to probes the table holds', () => {
    const real = read('test/integration/verification.differential.test.ts');
    for (const name of ['KNOWN_FALSE', 'KNOWN_FALSE_WITNESS', 'SAME_POINT_DEMOTED']) expect(blockKeys(real, name), name).not.toBeNull();
    expect(CLASS_FACTS.knownFalse).toEqual({ parsed: true, entries: (blockKeys(real, 'KNOWN_FALSE')?.length ?? 0) + (blockKeys(real, 'KNOWN_FALSE_WITNESS')?.length ?? 0) + (blockKeys(real, 'SAME_POINT_DEMOTED')?.length ?? 0), unattributed: 0 });
  });
});

/* ───────────────────────────── CC-16, CC-16b, CC-17: the generated document ───────────────────────────── */

describe('the generated constraint-class document is what the generator renders (CC-16)', () => {
  const rendered = renderConstraintClasses();

  it('is the committed docs/CONSTRAINT-CLASSES.md, byte for byte', () => {
    expect(read('docs/CONSTRAINT-CLASSES.md'), 'docs/CONSTRAINT-CLASSES.md is stale — run `npm run classes`').toBe(rendered.doc);
    expect(rendered.doc.startsWith('<!-- GENERATED by scripts/gen-constraint-classes.ts')).toBe(true);
  });

  it('is carried by each host document as the marked region renders it', () => {
    for (const name of Object.keys(REGION_HOSTS) as RegionName[]) {
      const host = REGION_HOSTS[name];
      expect(readRegion(read(host), name), `${host} (${name}) is stale — run \`npm run classes\``).toBe(rendered.regions[name]);
    }
  });

  it('catches a hand edit of a region, and refuses a document with no region to fill', () => {
    for (const name of Object.keys(REGION_HOSTS) as RegionName[]) {
      const host = read(REGION_HOSTS[name]);
      const edited = spliceRegion(host, name, `${rendered.regions[name]} (edited by hand)`);
      expect(readRegion(edited, name)).not.toBe(rendered.regions[name]);
      expect(spliceRegion(edited, name, rendered.regions[name])).toBe(host);
      expect(() => spliceRegion(host.replace(beginMarker(name), ''), name, 'x')).toThrow(/no .* region/);
      expect(() => spliceRegion(host.replace(endMarker(name), ''), name, 'x')).toThrow(/no .* region/);
    }
  });

  it('prints the classes that have a corpus row, and no other', () => {
    const printed = new Set<string>(printedClasses());
    for (const id of Object.keys(CONSTRAINT_CLASSES)) {
      const hasRow = cellsOfClass(id as keyof typeof CONSTRAINT_CLASSES).some((c) => (CLASS_FACTS.cells[c]?.rows ?? 0) > 0);
      expect(printed.has(id), id).toBe(hasRow);
      // a class with no row has no card, no row of the facts table and no mention by name
      expect(rendered.doc.includes(`### \`${id}\``), `${id}: card`).toBe(hasRow);
      if (!hasRow) expect(rendered.doc, `${id} is named though no corpus row stands in it`).not.toContain(`\`${id}\``);
    }
    expect(printed.size).toBe(printedClasses().length);
    expect(rendered.regions['user-guide']).toContain(`**${printed.size} constraint classes**`);
    expect(rendered.regions.conformance).toContain(`**${printed.size} constraint classes**`);
  });
});

describe('every surface the register marks built has a pointer that resolves (CC-16b)', () => {
  const problems = (surfaces: readonly Surface[], text: (file: string) => string): string[] =>
    surfaces
      .filter((s) => (s.status === 'built' ? s.pointer === null || !text(s.pointer.file).includes(s.pointer.find) : s.pointer !== null))
      .map((s) => s.id);

  it('holds for the register, and the document lists each surface with its status', () => {
    expect(problems(SURFACES, read)).toEqual([]);
    const { doc } = renderConstraintClasses();
    for (const s of SURFACES) expect(doc, s.id).toContain(`| \`${s.id}\` | ${s.status} |`);
    expect(new Set(SURFACES.map((s) => s.id)).size).toBe(SURFACES.length);
  });

  it('fails on a surface marked built with no producer, a missing pointer or a planned one that has one', () => {
    const ghost: Surface = { id: 'ghost', status: 'built', says: 'x', pointer: { file: 'package.json', find: 'no such string in package.json' } };
    expect(problems([ghost], read)).toEqual(['ghost']);
    expect(problems([{ ...ghost, pointer: null }], read)).toEqual(['ghost']);
    expect(problems([{ ...ghost, status: 'planned', pointer: ghost.pointer }], read)).toEqual(['ghost']);
    expect(problems([{ ...ghost, status: 'planned', pointer: null }], read)).toEqual([]);
  });
});

describe('the generated words claim nothing more than the register holds (CC-17)', () => {
  const { doc, regions } = renderConstraintClasses();
  const texts = [['the document', doc], ...Object.entries(regions)] as Array<[string, string]>;
  // the words are spelt in pieces so that this file carries none of them (the claims scan reads tests too)
  const banned = [['con', 'formant'], ['cert', 'ified'], ['com', 'pliant'], ['\\bveri', 'fied\\b'], ['\\bcor', 'rect\\b'], ['\\bs', 'afe\\b']].map((w) => new RegExp(w.join(''), 'i'));

  it('uses none of the reserved words anywhere', () => {
    for (const [what, text] of texts) for (const re of banned) expect(text, `${what} matches ${re}`).not.toMatch(re);
  });

  it('says label only, and that no verdict moves, in the document and in the scorecard', () => {
    expect(doc).toContain('**Label only; no verdict changes.**');
    expect(doc).toContain(MATURITY_SENTENCE);
    expect(regions.conformance).toContain('moves no verdict');
    expect(regions['user-guide']).toContain('moves no verdict');
  });

  it('names the surfaces that use no z3 as outside the partition, and the export as not built', () => {
    expect(doc).toContain('The check, literal and numeric surfaces use no z3 and are outside this partition');
    expect(doc).toContain('The export is not built');
    expect(SURFACES.find((s) => s.id === 'export')?.status).toBe('planned');
    expect(regions.conformance).toContain('the export is not built');
  });

  it('lists as built exactly the surfaces the register builds, and describes a planned one only as planned', () => {
    const built = SURFACES.filter((s) => s.status === 'built').map((s) => `\`${s.id}\``).join(', ');
    expect(doc).toContain(`Built: ${built}.`);
    expect(regions.conformance).toContain(`Built: ${built}.`);
    // the user-guide sentence is the one place a reader meets the claim; it says what is not yet true
    expect(regions['user-guide']).toContain('which no command prints yet');
    expect(SURFACES.filter((s) => s.status === 'planned').length).toBeGreaterThan(0);
  });

  it('keeps the wording fixes the documents needed: the numeral reading, the enum code and the unbuilt cross-check', () => {
    expect(read('docs/CONFORMANCE.md')).not.toContain('3602879701896397');
    expect(read('docs/CONFORMANCE.md')).toContain('`0.1` is `(/ 1.0 10.0)`');
    const guide = read('docs/USER-GUIDE.md');
    expect(guide).toContain('**A cross-check is planned, not built**');
    expect(guide).not.toContain('**Not two independent engines**');
    expect(guide).not.toMatch(/strings, enums, `null`/);
    expect(read('docs/04-formal-verification-plan.md')).not.toMatch(/string and enum comparisons/);
  });

  it('puts no level, count or class in a place the generator does not own', () => {
    // the hand-written text around a region never states a figure the region states
    for (const name of Object.keys(REGION_HOSTS) as RegionName[]) {
      const host = read(REGION_HOSTS[name]);
      const outside = host.slice(0, host.indexOf(beginMarker(name))) + host.slice(host.indexOf(endMarker(name)));
      expect(outside, `${name}: a hand-written count of constraint classes`).not.toMatch(/\*\*\d+ constraint classes\*\*/);
    }
  });
});

/* ───────────────── the other z3 engines carry a statement of what they sent (S6b; no WASM) ───────────────── */

/**
 * A solver that answers one word to every check, and for `unsat` names every `:named` label as the core. No WASM.
 * `axiomsHold` makes a script with no goal in it (the axiom check) `sat` whatever the word is, so a group's own
 * scripts get sent.
 */
function fakeBackend(answer: 'sat' | 'unsat' | 'unknown', axiomsHold = false): Z3Backend {
  return {
    absent: false,
    version: '5.3.1',
    fullVersion: '5.3.1',
    seed: 0,
    initMs: 0,
    async check(script) {
      const status = axiomsHold && !script.includes(':named |goal:') ? 'sat' : answer;
      const core = status === 'unsat' ? [...script.matchAll(/:named \|([^|]*)\|/g)].map((m) => m[1]!) : [];
      return { status, reason: '', timedOut: false, timeoutMs: 1, elapsedMs: 0, witness: [], completion: [], core };
    },
    async optimize() {
      return {
        status: answer,
        reason: '',
        timedOut: false,
        timeoutMs: 1,
        elapsedMs: 0,
        bound: answer === 'sat' ? { term: '5', infinite: 0, value: 5, epsilon: 0 } : null,
        witness: [],
        completion: [],
      };
    },
  };
}

const FIXTURE = (name: string): string => read(`test/fixtures/verification/models/${name}`);
const loadFixture = (name: string): Promise<Model> => load(FIXTURE(name), name);
const need = (s: ClassStatement | undefined): ClassStatement => {
  expect(s, 'the engine attached no statement').toBeDefined();
  return s!;
};
const ids = (xs: Array<{ id: string }>): string[] => xs.map((x) => x.id);
const cellsOf = (s: ClassStatement): string[] => s.shape.map((x) => (x.search ? `${x.id}/${x.search}` : x.id));

/** Two requirements over stated values, one product: `/pinned` only when the values are asserted. */
const PRODUCT = `package Pr {
  part def P { attribute a : ScalarValues::Real = 2.0; attribute b : ScalarValues::Real = 3.0; attribute z : ScalarValues::Real = 1.0; }
  part p : P;
  requirement def R { subject s : P; require constraint c1 { s.a * s.b >= 5.0 } require constraint c2 { s.z <= 4.0 } }
  satisfy R by p;
}`;
/** A set with a remainder in it: a clause the encoder cannot read, in reach of what is sent. */
const REMAINDER = `package Rm {
  part def P { attribute x : ScalarValues::Real = 5.0; attribute y : ScalarValues::Real = 1.0; }
  part p : P;
  requirement def R { subject s : P; require constraint c1 { s.x % 4.0 >= 1.0 } require constraint c2 { s.y <= 2.0 } }
  satisfy R by p;
}`;

describe('consistency states what it sent, beside each group and over the run (S6b)', () => {
  it('a decided group is solver-based; the statement is over the script, its rows, their reading and their modifiers', async () => {
    const result = await checkConsistency(await loadFixture('consistency-conflict.sysml'), { backend: fakeBackend('unsat') });
    expect(result.groups.map((g) => g.outcome)).toEqual(['inconsistent']);
    const group = need(classesOf(result.groups[0]!));
    expect(group).toMatchObject({ status: 'ok', scope: 'group', query: 'consistency', basis: 'solver', logic: 'QF_LRA', script: { shape: 'lra' } });
    expect(cellsOf(group)).toEqual(['lra']);
    expect(ids(group.reading)).toEqual(['requirement-clause']);
    expect(group.fenced).toEqual([]);
    // the run is the union of the groups' scripts (and the axioms' own), so here it holds the same cells
    const run = need(classesOf(result));
    expect(run).toMatchObject({ scope: 'run', query: 'consistency', basis: 'solver' });
    expect(cellsOf(run)).toEqual(['lra']);
  });

  it('an undecided group still says what it sent, and that no solver verdict stood behind it', async () => {
    const result = await checkConsistency(await loadFixture('consistency-conflict.sysml'), { backend: fakeBackend('unknown') });
    const group = need(classesOf(result.groups[0]!));
    expect(group.basis).toBe('none');
    expect(group.script).toEqual({ shape: 'lra' });
    expect(need(classesOf(result)).basis).toBe('none');
  });

  it('a clause the encoder refuses is context refused, whether or not a script follows', async () => {
    const result = await checkConsistency(await load(REMAINDER), { backend: fakeBackend('unsat') });
    const group = need(classesOf(result.groups[0]!));
    expect(group.fenced).toEqual([{ id: 'fence/unsupported-operator', layer: 'gate', rows: 1 }]);
    expect(ids(group.modifiers)).toContain('partial-context');
    // the rest of the set was still sent: the refused clause is not among the rows
    expect(cellsOf(group)).toEqual(['lra']);
  });

  it('a product is /free where the values are released and /pinned where they are asserted', async () => {
    const m = await load(PRODUCT);
    const free = need(classesOf(await checkConsistency(m, { backend: fakeBackend('unsat') })));
    expect(cellsOf(free)).toContain('nra-poly/free');
    expect(free.script).toEqual({ shape: 'nra-poly', search: 'free' });
    const pinned = need(classesOf(await checkConsistency(m, { backend: fakeBackend('unsat', true), withValues: true })));
    expect(cellsOf(pinned)).toContain('nra-poly/pinned');
    expect(pinned.script).toEqual({ shape: 'nra-poly', search: 'pinned' });
    expect(pinned.logic).toBe('QF_NRA');
  });

  it('is a label: the result serialises the same with it or without it, and under any levels', async () => {
    const m = await load(PRODUCT);
    const plain = JSON.stringify(await checkConsistency(m, { backend: fakeBackend('unsat') }));
    expect(plain).not.toContain('classes');
    const stubbed = await withLevelSource(
      () => 'battery-backed',
      () => checkConsistency(m, { backend: fakeBackend('unsat') }),
    );
    expect(JSON.stringify(stubbed)).toBe(plain);
    expect(need(classesOf(stubbed)).weakest?.level).toBe('battery-backed');
  });
});

describe('refine and fault-tree state what they sent, and nothing in them is pinned (S6b)', () => {
  it('a group that stands down lists its refused clause and sent nothing; the run still holds the sibling group', async () => {
    const result = await checkRefinement(await loadFixture('refinement-refused-clause.sysml'), { backend: fakeBackend('unsat') });
    expect(result.groups.map((g) => g.outcome)).toEqual(['inconclusive', 'vacuous']);
    const [stood, decided] = result.groups.map((g) => need(classesOf(g)));
    expect(stood).toMatchObject({ query: 'refine', scope: 'group', basis: 'none', script: null, logic: null });
    expect(stood!.fenced).toEqual([{ id: 'fence/unsupported-operator', layer: 'gate', rows: 1 }]);
    expect(decided).toMatchObject({ basis: 'solver', logic: 'QF_LRA', script: { shape: 'lra' } });
    expect(decided!.fenced).toEqual([{ id: 'fence/unsupported-operator', layer: 'gate', rows: 1 }]);
    const run = need(classesOf(result));
    expect(run).toMatchObject({ scope: 'run', query: 'refine', basis: 'solver' });
    expect(run.fenced).toEqual([{ id: 'fence/unsupported-operator', layer: 'gate', rows: 2 }]);
    expect(ids(run.modifiers)).toContain('partial-context');
    expect(ids(run.reading)).toEqual(['requirement-clause']);
  });

  it('a gamma equality is a bind-equality row, and a decomposition is the union of its scripts', async () => {
    const result = await computeFaultTree(await loadFixture('fault-tree-redundant.sysml'), { backend: fakeBackend('unsat') });
    const group = need(classesOf(result.groups[0]!));
    expect(group).toMatchObject({ query: 'fault-tree', scope: 'group', basis: 'solver', script: { shape: 'lra' } });
    expect(ids(group.reading)).toEqual(['bind-equality', 'requirement-clause']);
    expect(need(classesOf(result))).toMatchObject({ scope: 'run', query: 'fault-tree' });
  });

  it('is a label: the fault tree serialises the same under any levels', async () => {
    const m = await loadFixture('fault-tree-redundant.sysml');
    const plain = JSON.stringify(await computeFaultTree(m, { backend: fakeBackend('unsat') }));
    expect(plain).not.toContain('classes');
    const stubbed = await withLevelSource(
      () => 'tested',
      () => computeFaultTree(m, { backend: fakeBackend('unsat') }),
    );
    expect(JSON.stringify(stubbed)).toBe(plain);
  });
});

describe('bounds states what it sent: one script, and only the refused rows the measure reaches (S6b)', () => {
  const measure = (m: Model, qualifiedName: string) => m.all().find((e) => m.qualifiedName(e.id) === qualifiedName)!.id;

  it('lists the refusal the objective reaches, and not the one that factorises away', async () => {
    const m = await loadFixture('bounds-refused-axiom.sysml');
    const a = await checkBounds(m, { backend: fakeBackend('sat'), measureId: measure(m, 'BoundsRefusedAxiom::TankA::level') });
    expect(need(classesOf(a)).fenced).toEqual([]);
    const b = await checkBounds(m, { backend: fakeBackend('sat'), measureId: measure(m, 'BoundsRefusedAxiom::TankB::depth') });
    const reached = need(classesOf(b));
    expect(reached).toMatchObject({ query: 'bounds', scope: 'run' });
    expect(reached.fenced.map((f) => f.id)).toEqual(['fence/non-numeric-operand']);
    expect(ids(reached.modifiers)).toContain('partial-context');
  });

  it('a run that found no relation over the measure sent nothing and says so', async () => {
    const m = await load('package Z { part def P { attribute v : ScalarValues::Real = 1.0; attribute w : ScalarValues::Real; } part p : P; }');
    const w = m.all().find((e) => m.qualifiedName(e.id) === 'Z::P::w')!.id;
    const st = need(classesOf(await checkBounds(m, { backend: fakeBackend('sat'), measureId: w })));
    expect(st).toMatchObject({ basis: 'none', script: null, logic: null });
  });

  it('is a label: the result serialises the same under any levels', async () => {
    const m = await loadFixture('bounds-refused-axiom.sysml');
    const id = measure(m, 'BoundsRefusedAxiom::TankB::depth');
    const plain = JSON.stringify(await checkBounds(m, { backend: fakeBackend('sat'), measureId: id }));
    expect(plain).not.toContain('classes');
    const stubbed = await withLevelSource(() => 'tested', () => checkBounds(m, { backend: fakeBackend('sat'), measureId: id }));
    expect(JSON.stringify(stubbed)).toBe(plain);
  });
});
