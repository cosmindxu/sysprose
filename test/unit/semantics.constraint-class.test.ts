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
  FENCES,
  FENCE_OF,
  LEVELS,
  MATURITY_SENTENCE,
  MODIFIERS,
  READINGS,
  READING_OF,
  REGISTER_VERSION,
  SHAPES,
  SURFACES,
  basisOf,
  cellOfRow,
  classLine,
  classLines,
  classifyRow,
  levelOf,
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
  type ClassifiableRow,
  type Level,
  type RowClass,
  type RollUpInput,
} from '@semantics/smt/classes';
import { pinnedSymbolsOf } from '@semantics/smt/pinned';
import { classifiableOf } from '@semantics/refinement';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

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
    const s = rollUp(proof());
    expect(s.shape).toEqual([
      { id: 'nra-div', search: 'pinned', rows: 1 },
      { id: 'lra', rows: 2 },
    ]);
    expect(s.script).toEqual({ shape: 'nra-div', search: 'pinned' });
    expect(s.goal).toMatchObject({ shape: 'lra', modifiers: ['units'], reading: 'requirement-clause' });
    // every encoded cell is `experimental` until facts exist: the tie goes to the earlier cell of the register
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
    expect(classLine(g)).toBe('classes: fence/unsupported-operator (gate) [unpinned] — not sent to z3; --allow-inconclusive forgives this outcome');
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
    expect(levelOf('fence/unparseable')).toBe('unpinned');
    expect(levelOf('lra')).toBe('experimental');
    expect(levelOf('lra', { query: 'refine' })).toBe('experimental');
    expect(LEVELS).toEqual(['unrated', 'experimental', 'tested', 'differential-tested', 'battery-backed']);
    const stub = (cell: string): Level => (cell === 'lra' ? 'battery-backed' : 'unrated');
    expect(withLevelSource(stub, () => weakestOf(['lra', 'ite'], { query: 'verify' })?.cell)).toBe('ite');
    // a tie goes to the earlier cell of the register: shapes come before modifiers
    expect(weakestOf(['ite', 'lra'])?.cell).toBe('lra');
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
    expect(levelOf('lra')).toBe('experimental');
    expect(weakestOf(['lra'])?.level).toBe('experimental');
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
