/**
 * The constraint classes: what everything Sysprose hands to z3, or refuses to hand over, is SORTED into.
 *
 * LABEL ONLY. Nothing in the lane branches on a class: no claim, code, exit code, `detail`, digest or script
 * byte depends on anything in this file (the constraint-classes plan, decision 3), and it is not wired to any
 * engine or surface yet. It is the register (what each class encodes and where it ends), the classifier (one
 * row to its cell), the roll-up (the rows of one proof, one run or one group to one statement) and the lines
 * a surface will print.
 *
 * One deciding function per fact. The shape of a term is read from the BYTES the encoder emitted and the
 * walk's flag ({@link ./shape}), because z3 checks the `set-logic` line against that syntax and an
 * expression-tree reading disagrees with it on `a * (b ^ 0)`; this file only turns those facts into a cell.
 * {@link ./encode} imports `shape.ts` and never this file: this file imports types from `encode`,
 * `obligations` and `contracts`, so a runtime import the other way would be a cycle.
 *
 * Four families, 35 ids. Seven SHAPES (`ground` < `bool` < `lra` < `lira` < `nra-poly` < `nra-div` < `nira`,
 * the precedence), six MODIFIERS that only ever lower the weakest, eight READINGS (exactly one per row that
 * has a formal clause), and fourteen FENCES, one per refusal reason, which carry no solver verdict. A row
 * with no formal clause has no reading: it is `fence/no-formal-clause` and nothing else (user decision 2,
 * 2026-10-30). A row that carries no symbol is `ground` (decision 3).
 *
 * Maturity is computed by one pure function ({@link levelOf}) from committed facts. Until the facts exist
 * (the next step) every encoded cell is `experimental` and every fence `unpinned`: the weaker reading wins.
 * A level states the evidence this build holds for the class. It grades no model.
 *
 * The check, literal and numeric surfaces use no z3 and are outside this partition.
 */
import type { ElementId, Model } from '@core/index';
import { isOutsideTheFragment } from '../engines/literal';
import type { SmtOutcome } from '../engines/smt';
import { generalizationsOf } from '../inheritance';
import type { Encodable, Refusal, RefusalReason, VarSort, ContractVariable, ContractRef } from '../contracts';
import type { ExprNode } from '../expr';
import type { Obligation, ObligationRole, ObligationSource } from '../obligations';
import { encodeRelation, encodeVariables, type RelationEncoding } from './encode';
import { pinnedSymbolsOf } from './pinned';
import { SHAPE_BITS, type ShapeFacts } from './shape';

/** Bump on a rename, a removal or a change of meaning of any id; a rename adds `renamedFrom`. */
export const REGISTER_VERSION = 1;

/* ─────────────────────────────────── vocabulary ─────────────────────────────────── */

/** The seven shapes, weakest claim first: the precedence is the index. */
export const SHAPES = ['ground', 'bool', 'lra', 'lira', 'nra-poly', 'nra-div', 'nira'] as const;
export type ShapeId = (typeof SHAPES)[number];

/** Row modifiers, then the one context modifier. They only ever lower the weakest. */
export const MODIFIERS = ['units', 'offset-order', 'ite', 'div-guard', 'text-as-real', 'partial-context'] as const;
export type ModifierId = (typeof MODIFIERS)[number];

/** How a fact entered the proof; exactly one per row that has a formal clause. */
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

/** A fence id is `fence/<RefusalReason>`. */
export type FenceId = `fence/${RefusalReason}`;

/** Every `RefusalReason` to its fence id. `Record` makes `tsc` fail if the type grows without a mapping. */
export const FENCE_OF: Record<RefusalReason, FenceId> = {
  'no-formal-clause': 'fence/no-formal-clause',
  unparseable: 'fence/unparseable',
  'unresolved-name': 'fence/unresolved-name',
  'unit-unresolved': 'fence/unit-unresolved',
  'dimension-clash': 'fence/dimension-clash',
  'offset-arithmetic': 'fence/offset-arithmetic',
  'derived-bare-literal': 'fence/derived-bare-literal',
  'refused-derivation': 'fence/refused-derivation',
  'unread-definition': 'fence/unread-definition',
  'unread-binding': 'fence/unread-binding',
  unscalable: 'fence/unscalable',
  'collection-valued': 'fence/collection-valued',
  'unsupported-operator': 'fence/unsupported-operator',
  'non-numeric-operand': 'fence/non-numeric-operand',
};
export const FENCES: readonly FenceId[] = Object.values(FENCE_OF);

/** How a feature value reads: a literal equality is a stated value, any other equation defines one. */
export interface LiteralSplit {
  ifLiteral: ReadingId;
  otherwise: ReadingId;
}

/** Every `ObligationSource` to the reading it gives (`null`: the row has no formal clause). */
export const READING_OF: Record<ObligationSource, ReadingId | LiteralSplit | null> = {
  require: 'requirement-clause',
  assume: 'requirement-clause',
  objective: 'requirement-clause',
  constraint: 'requirement-clause',
  keyword: 'requirement-clause',
  assert: 'asserted-fact',
  calculation: 'defining-equation',
  bind: 'bind-equality',
  'feature-value': { ifLiteral: 'stated-value', otherwise: 'defining-equation' },
  none: null,
};

export type ClassId = ShapeId | ModifierId | ReadingId | FenceId;
export type Family = 'shape' | 'modifier' | 'reading' | 'fence';

/** `pinned` or `free`: whether every variable at a nonlinear site is fixed in the script (see {@link searchOf}). */
export type Search = 'pinned' | 'free';

/** What actually decided the verdict word; the outcome word alone cannot say. */
export const BASES = ['solver', 'solver-witness', 'solver+numeric', 'numeric-surface', 'point-evaluation', 'none'] as const;
export type Basis = (typeof BASES)[number];

/** Which command's question the script answers. */
export type Query = 'verify' | 'consistency' | 'refine' | 'bounds' | 'fault-tree' | 'property-gate-4';
export type Scope = 'proof' | 'run' | 'group';
export type Layer = 'gate' | 'encoder';

/** The default basis of an outcome word. A DEFAULT: the trace of the judgement overrides it ({@link basisOf}). */
export const BASIS_OF: Record<SmtOutcome, Basis> = {
  proved: 'solver',
  refuted: 'solver-witness',
  'design-admitted': 'solver-witness',
  vacuous: 'solver',
  'axioms-inconsistent': 'solver',
  'free-unbounded': 'solver',
  timeout: 'none',
  'witness-unconfirmed': 'none',
  unsupported: 'none',
  'not-evaluable': 'none',
};

const NONLINEAR_SHAPES: readonly ShapeId[] = ['nra-poly', 'nra-div', 'nira'];
const isNonlinearShape = (s: ShapeId): boolean => NONLINEAR_SHAPES.includes(s);

/** The maturity cell of a shape: nonlinear shapes split into `/pinned` and `/free`. */
export function shapeCell(shape: ShapeId, search?: Search): string {
  return isNonlinearShape(shape) && search !== undefined ? `${shape}/${search}` : shape;
}

/**
 * Every maturity cell, in the register order that breaks a tie in {@link weakestOf}: shapes from the most
 * demanding down (a nonlinear `/free` before its `/pinned`), then modifiers, readings and fences.
 * 4 linear shapes + 6 nonlinear cells + 6 modifiers + 8 readings + 14 fences = 38.
 */
export const CELLS: readonly string[] = [
  ...[...SHAPES].reverse().flatMap((s) => (isNonlinearShape(s) ? [`${s}/free`, `${s}/pinned`] : [s])),
  ...MODIFIERS,
  ...READINGS,
  ...FENCES,
];
const CELL_INDEX = new Map(CELLS.map((c, i) => [c, i]));
const cellIndex = (c: string): number => CELL_INDEX.get(c) ?? CELLS.length;

/* ─────────────────────────────────── the register ─────────────────────────────────── */

/** A string that must still be found in a file: the register's pointer into source or tests. */
export interface Pointer {
  file: string;
  find: string;
}

/** One limit of a class. A `pin` names a probe that exercises the sentence. */
export interface Limit {
  text: string;
  pin?: string;
}

export interface ClassDef {
  id: ClassId;
  family: Family;
  /** What the class encodes, in a sentence. */
  encodes: string;
  /** The `set-logic` the class gives, or `null` where there is none to give. */
  logic: string | null;
  /** The `SmtOutcome` words the class can produce. */
  verdicts: readonly SmtOutcome[];
  limits: readonly Limit[];
  /** Open defects attributed to the class (the sidecar, a later step, carries their kinds). */
  defects: readonly string[];
  pointers: readonly Pointer[];
  /** Probe ids that pin a sentence of this card. */
  probes: readonly string[];
  /** Fences only: the layers the refusal is produced at. */
  layers: readonly Layer[];
  /** Fences only: is a refusal at the gate layer forgivable by `--allow-inconclusive` (`isOutsideTheFragment`)? */
  gateForgivable?: boolean;
  /** Set by a rename; see {@link REGISTER_VERSION}. */
  renamedFrom?: string;
}

const ALL_WORDS: readonly SmtOutcome[] = [
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
const ENCODE_TS = 'src/semantics/smt/encode.ts';
const CONTRACTS_TS = 'src/semantics/contracts.ts';

function def(id: ClassId, family: Family, d: Partial<ClassDef> & { encodes: string }): ClassDef {
  return { id, family, logic: null, verdicts: ALL_WORDS, limits: [], defects: [], pointers: [], probes: [], layers: [], ...d };
}

const FENCE_CARDS: Record<RefusalReason, { encodes: string; layers: readonly Layer[]; limits?: Limit[]; pointers?: Pointer[] }> = {
  'no-formal-clause': { encodes: 'a requirement with prose only: nothing to send', layers: ['gate'], limits: [{ text: 'prose only' }] },
  unparseable: {
    encodes: 'a body this tool cannot read, or a name no SMT symbol can carry',
    layers: ['gate', 'encoder'],
    limits: [{ text: 'the body is not an expression this tool can read; a name holding `|` or `\\` is refused at the encoder' }],
    pointers: [{ file: ENCODE_TS, find: 'contains a character no SMT symbol can carry' }],
  },
  'unresolved-name': {
    encodes: 'a name that resolves to no feature',
    layers: ['gate', 'encoder'],
    limits: [{ text: 'a name the encoder was given no variable for has no symbol to encode' }],
    pointers: [{ file: ENCODE_TS, find: 'names nothing the encoder was given a variable for' }],
  },
  'unit-unresolved': { encodes: 'a unit the registry does not know', layers: ['gate'] },
  'dimension-clash': { encodes: 'operands of different dimensions', layers: ['gate'] },
  'offset-arithmetic': {
    encodes: 'arithmetic on a point of an offset scale (degC, degF)',
    layers: ['gate'],
    limits: [{ text: 'the origin does not cancel' }],
    pointers: [{ file: CONTRACTS_TS, find: 'the origin does not cancel' }],
  },
  'derived-bare-literal': { encodes: 'a bare literal against a derived quantity', layers: ['gate'] },
  'refused-derivation': { encodes: 'a derivation the unit gates refused', layers: ['gate'] },
  'unread-definition': {
    encodes: 'a value defined in a context this tool does not read it in',
    layers: ['gate'],
    limits: [{ text: 'a parameterised calculation is refused here' }],
  },
  'unread-binding': { encodes: 'a binding this tool does not read through', layers: ['gate'] },
  unscalable: { encodes: 'a scale the encoder cannot write', layers: ['gate', 'encoder'] },
  'collection-valued': {
    encodes: 'a feature that admits more than one value',
    layers: ['gate'],
    limits: [{ text: 'only single-valued scalar features are encoded' }],
  },
  'unsupported-operator': {
    encodes: 'an operator or operand outside the polynomial fragment',
    layers: ['gate', 'encoder'],
    limits: [
      { text: 'the remainder operator `%` has no encoding in this fragment (gate)' },
      { text: 'the exponent is not a literal, and a variable exponent has no polynomial reading (gate)' },
      { text: 'divides by the literal zero, which SMT-LIB leaves unspecified rather than undefined (encoder)' },
      { text: 'a fractional power is a root, which is outside the polynomial fragment (encoder)' },
      { text: 'an exponent above 32 is not expanded into a product (encoder)' },
    ],
    pointers: [
      { file: ENCODE_TS, find: 'divides by the literal zero' },
      { file: ENCODE_TS, find: 'is not an integer; a fractional power is a root' },
      { file: ENCODE_TS, find: 'the remainder operator `%` has no encoding' },
    ],
  },
  'non-numeric-operand': {
    encodes: 'a string, `null`, a proposition used as a number, or a branch of the wrong sort',
    layers: ['gate', 'encoder'],
    limits: [{ text: 'only numeric and boolean operands are encoded' }],
    pointers: [{ file: ENCODE_TS, find: 'only numeric and boolean operands are encoded' }],
  },
};

/** Every class, keyed by id: the static half of the register (the facts and the levels are computed). */
export const CONSTRAINT_CLASSES: Record<ClassId, ClassDef> = (() => {
  const nlNote = 'An algebraic witness has no reading, which gives `witness-unconfirmed`; `bounds` gives `bound-without-optimality`.';
  const r: Partial<Record<ClassId, ClassDef>> = {
    ground: def('ground', 'shape', {
      encodes: 'a relation that carries no symbol (`assume false`, literal-only comparisons)',
      logic: 'QF_LRA',
      pointers: [{ file: ENCODE_TS, find: 'export function encodeScript' }],
    }),
    bool: def('bool', 'shape', {
      encodes: 'Bool features under not, and, or, xor, =>, = and distinct',
      logic: 'QF_LRA',
      limits: [{ text: 'a Bool with a unit scale is `non-numeric-operand`; `Bool + Real` is a sort clash' }],
    }),
    lra: def('lra', 'shape', {
      encodes: 'comparisons and `+ - *` with at most one symbol-carrying operand, and `/` by a literal',
      logic: 'QF_LRA',
      limits: [
        { text: 'division by the literal zero is `unsupported-operator`, `not-evaluable`, not forgivable' },
        { text: 'a numeral is the written decimal (`0.1` is `(/ 1.0 10.0)`); beyond 15 significant digits, the double’s own rational' },
      ],
    }),
    lira: def('lira', 'shape', {
      encodes: 'Integer, Natural and UnlimitedNatural features, declared `Int` and read through `to_real`',
      logic: 'QF_LIRA',
      limits: [{ text: 'the sort comes from the declared type name only' }],
      pointers: [{ file: CONTRACTS_TS, find: "names.has('Integer')" }],
    }),
    'nra-poly': def('nra-poly', 'shape', {
      encodes: 'a product of two symbol-carrying terms, or a literal integer power 2..32',
      logic: 'QF_NRA',
      limits: [
        { text: 'z3 may answer `unknown`, which is `timeout`' },
        { text: nlNote },
        { text: 'an exponent above 32 or a fractional one is refused at the encoder, which no flag forgives' },
      ],
    }),
    'nra-div': def('nra-div', 'shape', {
      encodes: '`(/ a b)` with a symbol-carrying divisor, plus the guard `(distinct b 0.0)` asserted as `side:`',
      logic: 'QF_NRA',
      limits: [
        { text: 'The guard is an encoding assumption: a pinned-zero divisor makes it contradict the axioms. Division in an axiom surfaces as `inconsistent-axioms` at step 0.', pin: 'm7' },
        { text: 'Division in the goal surfaces as `vacuous`, never as `proved`.', pin: 'm8' },
        { text: 'Gate 4 of `property-check` does not assert the guard.' },
        { text: nlNote },
      ],
      defects: [
        'the vacuous detail names the premises where the unsat core names the goal’s side guard (wrong-statement)',
        'gate 4 omits the divisor guard (wrong-verdict for query property-gate-4, unverified end to end)',
      ],
    }),
    nira: def('nira', 'shape', {
      encodes: 'any nonlinear shape with an Int read, in one row or only in the script as a whole',
      logic: 'QF_NIRA',
      limits: [
        { text: 'The script can be stronger than every row: goal QF_NRA, axioms QF_LIRA, script QF_NIRA, `proved`.', pin: 'm1' },
        { text: 'undecidable in general; z3 may answer `unknown`' },
      ],
    }),
    units: def('units', 'modifier', {
      encodes: '`factor * x + offset` over a symbol in storage units, and `[unit]` literals as exact rationals',
      limits: [{ text: 'The trust base is the unit registry and the ScaleMap gates; `unit-unresolved`, `dimension-clash` and `unscalable` are `not-evaluable`.' }],
    }),
    'offset-order': def('offset-order', 'modifier', {
      encodes: 'degC and degF ordering, read in kelvin',
      limits: [{ text: 'arithmetic on an offset scale is `offset-arithmetic`, forgivable' }],
    }),
    ite: def('ite', 'modifier', {
      encodes: '`(ite c t e)`',
      limits: [{ text: 'branches of different sorts give `non-numeric-operand`' }],
    }),
    'div-guard': def('div-guard', 'modifier', {
      encodes: 'the `d != 0` assumption on a `nira` row that `nra-div` would otherwise outrank',
      limits: [{ text: 'see `nra-div`' }],
    }),
    'text-as-real': def('text-as-real', 'modifier', {
      encodes: 'a feature whose declared type names String, read as a Real; its value axiom is refused, so nothing pins it',
      verdicts: ['refuted', 'witness-unconfirmed', 'not-evaluable'],
      limits: [
        { text: '`refuted` only through the numeric surface; `s.a == s.b` ("bus", "car") is `refuted`, basis `numeric-surface`', pin: 'm6' },
        { text: 'equal strings and `!=` are `not-evaluable`, "witness not confirmed"' },
      ],
      defects: ['bound.detail says "decided by z3" on a numeric-surface decision (wrong-statement)'],
    }),
    'partial-context': def('partial-context', 'modifier', {
      encodes: 'a kept axiom or premise was refused and the proof stands on the rest',
      limits: [
        { text: '`proved` is sound (dropping a hypothesis strengthens the entailment); `vacuous` and `axioms-inconsistent` can be decided on the numeric surface alone.', pin: 'm4' },
        { text: '`--free` makes it `not-evaluable`' },
      ],
    }),
    'stated-value': def('stated-value', 'reading', { encodes: '`f == literal`, verbatim; `--free` drops it' }),
    'defining-equation': def('defining-equation', 'reading', {
      encodes: '`f == expr`, and calculations',
      limits: [{ text: 'a parameterised calculation is `unread-definition`' }],
      defects: ['TODO.md:827 (abstains)'],
    }),
    'bind-equality': def('bind-equality', 'reading', {
      encodes: '`bind`, and the gamma edges of refine',
      limits: [{ text: 'a bare `connection` is not an equality unless `--connections-as-equalities`' }],
      defects: ['TODO.md:522, 803, 820 (abstain)', 'TODO.md:620 (wrong-statement)'],
    }),
    'asserted-fact': def('asserted-fact', 'reading', { encodes: '`assert constraint`', defects: ['TODO.md:499 (wrong-verdict)'] }),
    'requirement-clause': def('requirement-clause', 'reading', { encodes: '`require`, `assume`, `objective`, `constraint` and `keyword` clauses' }),
    'inherited-context': def('inherited-context', 'reading', {
      encodes: 'a relation read in a specialising context',
      defects: ['TODO.md:26, 98 (abstain)', 'TODO.md:125 (wrong-statement, possibly decided wrong cells)'],
    }),
    'per-instance': def('per-instance', 'reading', {
      encodes: 'one symbol per instance',
      defects: ['TODO.md:620 and :125 (wrong-statement)', 'TODO.md:573 (abstains)'],
    }),
    'own-symbol': def('own-symbol', 'reading', {
      encodes: 'a goal or premise over a name the check reads no value for',
      limits: [{ text: 'an unread premise is `not-evaluable` ("proof not claimed"); an axiom over one is refused' }],
    }),
  };
  for (const reason of Object.keys(FENCE_OF) as RefusalReason[]) {
    const card = FENCE_CARDS[reason];
    const id = FENCE_OF[reason];
    r[id] = def(id, 'fence', {
      encodes: card.encodes,
      verdicts: ['unsupported', 'not-evaluable', 'refuted'],
      layers: card.layers,
      limits: card.limits ?? [],
      pointers: card.pointers ?? [],
      gateForgivable: isOutsideTheFragment(reason),
    });
  }
  return r as Record<ClassId, ClassDef>;
})();

/** Is this a fence cell? */
export const isFenceCell = (cell: string): boolean => cell.startsWith('fence/');

/* ──────────────────────────────── maturity (levels) ──────────────────────────────── */

/** Encoded cells climb this ladder; the next step computes the rungs from committed facts. */
export const LEVELS = ['unrated', 'experimental', 'tested', 'differential-tested', 'battery-backed'] as const;
/** Fence cells have their own three states. */
export const FENCE_LEVELS = ['fenced', 'fenced-defect', 'unpinned'] as const;
export type Level = (typeof LEVELS)[number] | (typeof FENCE_LEVELS)[number];

/** What a level is asked under. */
export interface LevelEnv {
  query?: Query;
}

/**
 * The level of a cell. PURE and total. Until the facts exist an encoded cell is `experimental` and a fence
 * `unpinned`; a query other than `verify` caps an encoded cell at `tested`.
 */
export function levelOf(cell: string, env: LevelEnv = {}): Level {
  if (isFenceCell(cell)) return 'unpinned';
  const base: Level = 'experimental';
  if (env.query !== undefined && env.query !== 'verify') return rankOf(base) > rankOf('tested') ? 'tested' : base;
  return base;
}

const rankOf = (l: Level): number => (LEVELS as readonly string[]).indexOf(l);

/** The seam the inertness test (CC-20) uses: replace the level source and see that nothing but levels move. */
let levelSource: ((cell: string, env: LevelEnv) => Level) | undefined;
export function withLevelSource<T>(source: (cell: string, env: LevelEnv) => Level, body: () => T): T {
  const saved = levelSource;
  levelSource = source;
  try {
    return body();
  } finally {
    levelSource = saved;
  }
}
const levelFor = (cell: string, env: LevelEnv): Level => (levelSource ? levelSource(cell, env) : levelOf(cell, env));

/* ─────────────────────────────── classifying one row ─────────────────────────────── */

/** The part of a relation the classifier reads: an `Obligation` fits, and so does anything with these fields. */
export interface ClassifiableRow {
  node: ExprNode | null;
  vars: readonly ContractVariable[];
  sortPerVar: Readonly<Record<string, VarSort>>;
  scaled: boolean;
  encodable: Encodable;
  role?: ObligationRole;
  source?: ObligationSource;
  instance?: Obligation['instance'];
  unread?: readonly string[];
  element?: ContractRef;
}

/** What a row that is not a worklist row is: an author's clause, or a gamma item flow of refine. */
export type RowKind = 'clause' | 'gamma';

export interface ClassifyContext {
  model: Model;
  /** The row's encoding if the caller has it; otherwise it is encoded here with nothing freed. */
  encoded?: RelationEncoding;
  /** The reading of a row with no `source`. */
  kind?: RowKind;
}

/** One row's class. Shape, reading and fence do not depend on `--free`; `search` does, and is computed apart. */
export interface RowClass {
  /** The primary cell: the shape id, or the fence id. */
  primary: ShapeId | FenceId;
  shape: ShapeId | null;
  /** Qualified names under the nonlinear sites; `[]` for a linear shape and for a fence. */
  nlSymbols: string[];
  modifiers: ModifierId[];
  /** `null` only for a row with no formal clause, which is fence-only. */
  reading: ReadingId | null;
  fence: { id: FenceId; layer: Layer } | null;
}

/** `ref == literal`, either way round. */
function isLiteralEquality(node: ExprNode | null): boolean {
  if (node?.kind !== 'binary' || node.op !== '==') return false;
  const lit = (n: ExprNode): boolean =>
    n.kind === 'num' || n.kind === 'bool' || n.kind === 'str' || (n.kind === 'unary' && (n.op === '-' || n.op === '+') && n.operand.kind === 'num');
  return (node.left.kind === 'ref' && lit(node.right)) || (node.right.kind === 'ref' && lit(node.left));
}

/** The reading of a row, or `null` when it has no formal clause. */
export function readingOf(row: ClassifiableRow, kind?: RowKind): ReadingId | null {
  if ((row.unread?.length ?? 0) > 0) return 'own-symbol';
  if (row.instance?.path !== undefined || row.vars.some((v) => v.instance !== undefined)) return 'per-instance';
  if (row.instance !== undefined) return 'inherited-context';
  if (row.source === undefined) return kind === 'gamma' ? 'bind-equality' : 'requirement-clause';
  const rule = READING_OF[row.source];
  if (rule === null || typeof rule === 'string') return rule;
  return isLiteralEquality(row.node) ? rule.ifLiteral : rule.otherwise;
}

/** Does this node carry a `[unit]` literal (a `num` whose written form was lowered)? */
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

/**
 * The declared-type names of a feature, its generalization closure included: the name set `sortOf` in
 * `contracts.ts` reads `Boolean`, `Integer`, `Natural` and `UnlimitedNatural` off (a duplicate of it, so
 * `contracts.ts` stays untouched; the parity is a test).
 */
export function typeNamesOf(model: Model, id: string): ReadonlySet<string> {
  const names = new Set<string>();
  const el = model.get(id as ElementId);
  if (!el) return names;
  for (const t of model.typesOf(el.id)) {
    if (t.declaredName) names.add(t.declaredName);
    for (const g of generalizationsOf(model, t.id)) if (g.declaredName) names.add(g.declaredName);
  }
  const declared = el.attrs.type;
  if (typeof declared === 'string') names.add(declared.includes('::') ? declared.slice(declared.lastIndexOf('::') + 2) : declared);
  return names;
}

const TEXT_MEMO = new WeakMap<Model, Map<string, boolean>>();
function textAsReal(model: Model, featureId: string): boolean {
  let per = TEXT_MEMO.get(model);
  if (!per) TEXT_MEMO.set(model, (per = new Map()));
  let hit = per.get(featureId);
  if (hit === undefined) per.set(featureId, (hit = typeNamesOf(model, featureId).has('String')));
  return hit;
}

/** The shape a term's bytes stand for, given the sort of each symbol the bytes carry (C.1 of the plan). */
export function shapeIdOf(facts: ShapeFacts, sortOf: (qualifiedName: string) => VarSort | undefined): ShapeId {
  if (facts.nonlinear) {
    if (facts.int) return 'nira';
    return (facts.mask & SHAPE_BITS.DIV_SYM) !== 0 || facts.guarded ? 'nra-div' : 'nra-poly';
  }
  if (facts.int) return 'lira';
  // Zero symbols is `ground` whatever the arithmetic around the literals (user decision 3).
  if (facts.symbols.length === 0) return 'ground';
  return facts.symbols.some((s) => sortOf(s) !== 'Bool') ? 'lra' : 'bool';
}

const MEMO = new WeakMap<object, Map<string, RowClass>>();

/**
 * Sort one row. The single entry point: `contracts`, `obligations`, the engines and the page all call this.
 * Memoised on the row object, which is safe because shape, reading and fence are independent of `--free`.
 */
export function classifyRow(row: ClassifiableRow, ctx: ClassifyContext): RowClass {
  const key = ctx.kind ?? '';
  const hit = MEMO.get(row)?.get(key);
  if (hit) return hit;
  const c = compute(row, ctx);
  let per = MEMO.get(row);
  if (!per) MEMO.set(row, (per = new Map()));
  per.set(key, c);
  return c;
}

function fenceOf(refusal: Refusal, layer: Layer, reading: ReadingId | null): RowClass {
  const id = FENCE_OF[refusal.reason];
  return { primary: id, shape: null, nlSymbols: [], modifiers: [], reading, fence: { id, layer } };
}

function compute(row: ClassifiableRow, ctx: ClassifyContext): RowClass {
  const reading = readingOf(row, ctx.kind);
  if (row.node === null || row.encodable !== true) {
    const refusal: Refusal =
      row.encodable === true ? { reason: 'unparseable', detail: 'the relation has no readable body' } : row.encodable;
    return fenceOf(refusal, 'gate', reading);
  }
  const vars = encodeVariables(row.vars, row.sortPerVar, { scaled: row.scaled });
  const enc = ctx.encoded ?? encodeRelation(row.node, vars);
  if (!enc.ok) return fenceOf(enc.refusal, 'encoder', reading);

  const sorts = new Map<string, VarSort>();
  for (const v of vars) if (!sorts.has(v.qualifiedName)) sorts.set(v.qualifiedName, v.sort);
  const facts = enc.shape;
  const shape = shapeIdOf(facts, (q) => sorts.get(q));
  const reads = new Set(enc.reads);
  const carried = vars.filter((v) => reads.has(v.qualifiedName));
  const modifiers: ModifierId[] = [];
  if (carried.some((v) => v.factor !== 1) || hasLiteral(row.node)) modifiers.push('units');
  if (carried.some((v) => v.offset !== 0)) modifiers.push('offset-order');
  if ((facts.mask & SHAPE_BITS.ITE) !== 0) modifiers.push('ite');
  if (shape === 'nira' && enc.sideConditions.length > 0) modifiers.push('div-guard');
  if (row.vars.some((v) => textAsReal(ctx.model, v.featureId))) modifiers.push('text-as-real');
  return {
    primary: shape,
    shape,
    // A nonlinear shape with no symbol under a site is read as `/free` by searchOf.
    nlSymbols: isNonlinearShape(shape) ? [...facts.nlSymbols] : [],
    modifiers,
    reading,
    fence: null,
  };
}

/** A script's class: the bytes of every assertion it holds, the guards included. */
export interface ScriptClass {
  shape: ShapeId;
  nlSymbols: string[];
  logic: string;
}

/** The script cell, from `SmtScript.shape` and the sort of each symbol the script was built over. */
export function scriptClassOf(shape: ShapeFacts, logic: string, sorts: ReadonlyMap<string, VarSort>): ScriptClass {
  const id = shapeIdOf(shape, (q) => sorts.get(q));
  return { shape: id, nlSymbols: isNonlinearShape(id) ? [...shape.nlSymbols] : [], logic };
}

/**
 * `pinned` when every symbol at a nonlinear site is in `pinned`, `free` otherwise, and `free` when no
 * symbol is recorded at the site at all (an empty set pins nothing: the weaker reading wins).
 * `undefined` for a linear shape and for a fence.
 */
export function searchOf(c: { shape: ShapeId | null; nlSymbols: readonly string[] }, pinned: ReadonlySet<string>): Search | undefined {
  if (c.shape === null || !isNonlinearShape(c.shape)) return undefined;
  return c.nlSymbols.length > 0 && c.nlSymbols.every((s) => pinned.has(s)) ? 'pinned' : 'free';
}

/** The maturity cell a classified row stands in, given the symbols the script's axioms pin. */
export function cellOfRow(c: RowClass, pinned: ReadonlySet<string>): string {
  return c.shape === null ? c.primary : shapeCell(c.shape, searchOf(c, pinned));
}

/** The symbols a set of rows pins; a re-export of {@link pinnedSymbolsOf} for callers that import only this file. */
export { pinnedSymbolsOf };

/* ──────────────────────────────── the static census ──────────────────────────────── */

/** Counts of cells over worklist rows, with no solver. */
export interface StaticCensus {
  rows: number;
  /** Primary cell (a shape cell with its search, or a fence id) to row count. */
  cells: Record<string, number>;
  modifiers: Record<string, number>;
  readings: Record<string, number>;
  fences: Record<string, number>;
}

const bump = (m: Record<string, number>, k: string, by = 1): void => {
  m[k] = (m[k] ?? 0) + by;
};

/** Order-independent: a sum over rows, with the axioms' pinned set taken once. */
export function staticCensus(model: Model, rows: readonly Obligation[]): StaticCensus {
  const out: StaticCensus = { rows: rows.length, cells: {}, modifiers: {}, readings: {}, fences: {} };
  const classes = rows.map((r) => classifyRow(r, { model }));
  const encodedAxioms = rows.filter((r, i) => r.role === 'axiom' && classes[i]!.fence === null).map((row) => ({ row, encoded: true as const }));
  const pinned = pinnedSymbolsOf(model, encodedAxioms);
  for (const c of classes) {
    bump(out.cells, cellOfRow(c, pinned));
    for (const m of c.modifiers) bump(out.modifiers, m);
    if (c.reading !== null) bump(out.readings, c.reading);
    if (c.fence) bump(out.fences, `${c.fence.id}\t${c.fence.layer}`);
  }
  return out;
}

/* ────────────────────────────────────── basis ────────────────────────────────────── */

/** The facts of one judgement that decide its basis; the engine's trace supplies them (the wiring step). */
export interface BasisFacts {
  /** Was the goal refused, so that nothing was encoded for it? */
  goalRefused: boolean;
  /** A premise or kept axiom in reach was refused, and the proof stood on the rest. */
  dropped: boolean;
  /** The verdict word came out of `partialAntecedent`, the numeric surface's re-read of refused context. */
  partialAntecedent: boolean;
  /** The symbols the goal reads. */
  goalSymbols: readonly string[];
  /** Symbols `--free` released. */
  free?: ReadonlySet<string>;
  /** The goal reads a feature whose declared type names String (its value axiom is refused). */
  textAsReal?: boolean;
}

/**
 * What decided the verdict word. The outcome alone cannot say: the numeric surface decides `vacuous` and
 * `axioms-inconsistent` over a partial context, a `refuted` whose goal reads a symbol the encoding does not
 * pin is confirmed at a point z3 did not choose, and a refused relation read violated at the model's values
 * is no solver answer at all. {@link BASIS_OF} is the default; this is the rule.
 */
export function basisOf(outcome: SmtOutcome, facts: BasisFacts, pinned: ReadonlySet<string>): Basis {
  if (facts.goalRefused) return outcome === 'refuted' ? 'point-evaluation' : 'none';
  switch (outcome) {
    case 'proved':
      return facts.dropped ? 'solver+numeric' : 'solver';
    case 'refuted': {
      const fixed = facts.goalSymbols.every((s) => pinned.has(s) || (facts.free?.has(s) ?? false));
      return fixed && facts.textAsReal !== true ? 'solver-witness' : 'numeric-surface';
    }
    case 'vacuous':
    case 'axioms-inconsistent':
      return facts.partialAntecedent ? 'numeric-surface' : BASIS_OF[outcome];
    default:
      return BASIS_OF[outcome];
  }
}

/* ────────────────────────────────────── roll-up ────────────────────────────────────── */

export interface ClassStatement {
  register: number;
  status: 'ok' | 'unclassified';
  scope: Scope;
  basis: Basis;
  query: Query;
  /** The deciding script's `set-logic` line. */
  logic: string | null;
  script: { shape: ShapeId; search?: Search } | null;
  shape: Array<{ id: ShapeId; search?: Search; rows: number }>;
  modifiers: Array<{ id: ModifierId; rows: number }>;
  reading: Array<{ id: ReadingId; rows: number }>;
  /** Context rows that were refused. A goal's own fence is under `goal`. */
  fenced: Array<{ id: FenceId; layer: Layer; rows: number }>;
  goal: {
    shape: ShapeId | null;
    search?: Search;
    modifiers: ModifierId[];
    reading: ReadingId | null;
    fence?: { id: FenceId; layer: Layer; forgiven: boolean };
  };
  weakest: { cell: string; level: Level; firstUnmet: string | null; capped: string[] } | null;
  /** Report only; never stored in a record. */
  levels: Record<string, Level>;
}

export interface RollUpInput {
  scope: Scope;
  query: Query;
  basis: Basis;
  logic: string | null;
  /** The scripts that were sent: one for a proof, every one for a group. */
  scripts: readonly ScriptClass[];
  /** The goal row, if the statement is about one. */
  goal?: RowClass;
  /** Premises, kept axioms and anything else in the footprint. Order does not matter. */
  context: readonly RowClass[];
  /** What the script's asserted axioms pin ({@link pinnedSymbolsOf}). */
  pinned: ReadonlySet<string>;
  /** A refused row in reach that is not in `context` (a `notEncoded` connection, a stood-down requirement). */
  partialContext?: boolean;
  /** `ALLOW_INCONCLUSIVE_CODES.has(code)` of the goal row's actual code: never derived from (reason, layer). */
  forgiven?: boolean;
}

const count = <K extends string>(items: readonly K[]): Map<K, number> => {
  const m = new Map<K, number>();
  for (const i of items) m.set(i, (m.get(i) ?? 0) + 1);
  return m;
};

/**
 * The weakest of a set of cells by level (the lowest rank; fences are excluded: they carry no verdict), a
 * tie going to the earlier cell in {@link CELLS}. `null` when there is no encoded cell.
 */
export function weakestOf(cells: Iterable<string>, env: LevelEnv = {}): ClassStatement['weakest'] {
  let best: { cell: string; level: Level } | null = null;
  for (const cell of new Set(cells)) {
    if (isFenceCell(cell)) continue;
    const level = levelFor(cell, env);
    if (best === null || rankOf(level) < rankOf(best.level) || (rankOf(level) === rankOf(best.level) && cellIndex(cell) < cellIndex(best.cell))) {
      best = { cell, level };
    }
  }
  return best === null ? null : { ...best, firstUnmet: null, capped: [] };
}

/** The statement for one proof, one run or one group: sets of cells with counts, never a concatenation. */
export function rollUp(input: RollUpInput): ClassStatement {
  const env: LevelEnv = { query: input.query };
  const rows = [...(input.goal ? [input.goal] : []), ...input.context];
  const rowCells = rows.filter((r) => r.shape !== null).map((r) => cellOfRow(r, input.pinned));
  const shapeCount = count(rowCells);
  const fenced = count(input.context.filter((r) => r.fence !== null).map((r) => `${r.fence!.id}\t${r.fence!.layer}`));
  const partial = input.partialContext === true || fenced.size > 0;
  const modifiers = count(rows.flatMap((r) => r.modifiers));
  if (partial) modifiers.set('partial-context', [...fenced.values()].reduce((a, b) => a + b, 0) || 1);
  const readings = count(rows.flatMap((r) => (r.reading === null ? [] : [r.reading])));

  const scripts = input.scripts.map((s) => ({ ...s, search: searchOf(s, input.pinned) }));
  // The script the statement names: the highest-precedence one (the weakest claim), a `free` over a `pinned`.
  const top = scripts.reduce<(typeof scripts)[number] | null>(
    (m, s) => (m === null || SHAPES.indexOf(s.shape) > SHAPES.indexOf(m.shape) || (s.shape === m.shape && s.search === 'free' && m.search !== 'free') ? s : m),
    null,
  );
  const scriptCells = scripts.map((s) => shapeCell(s.shape, s.search));

  const cellId = (id: string): { id: string; search?: Search } => {
    const [base, search] = id.split('/');
    return search === undefined ? { id: base! } : { id: base!, search: search as Search };
  };
  const byRegister = <T extends { key: string }>(xs: T[]): T[] => xs.sort((a, b) => cellIndex(a.key) - cellIndex(b.key) || (a.key < b.key ? -1 : 1));

  const goalClass = input.goal;
  const goalCell = goalClass && goalClass.shape !== null ? cellOfRow(goalClass, input.pinned) : null;
  const goalStatement: ClassStatement['goal'] = goalClass
    ? {
        shape: goalClass.shape,
        ...(goalCell && cellId(goalCell).search ? { search: cellId(goalCell).search } : {}),
        modifiers: [...goalClass.modifiers],
        reading: goalClass.reading,
        ...(goalClass.fence ? { fence: { ...goalClass.fence, forgiven: input.forgiven === true } } : {}),
      }
    : { shape: null, modifiers: [], reading: null };

  const allCells = [...rowCells, ...scriptCells, ...modifiers.keys(), ...readings.keys()];
  const levels: Record<string, Level> = {};
  for (const c of new Set([...allCells, ...fenced.keys()].map((k) => k.split('\t')[0]!))) levels[c] = levelFor(c, env);

  return {
    register: REGISTER_VERSION,
    status: 'ok',
    scope: input.scope,
    basis: input.basis,
    query: input.query,
    logic: input.logic,
    script: top ? { shape: top.shape, ...(top.search ? { search: top.search } : {}) } : null,
    shape: byRegister([...shapeCount].map(([key, rows]) => ({ key, ...cellId(key), rows }))).map(({ key: _k, id, search, rows }) => ({
      id: id as ShapeId,
      ...(search ? { search } : {}),
      rows,
    })),
    modifiers: byRegister([...modifiers].map(([id, rows]) => ({ key: id, id, rows }))).map(({ id, rows }) => ({ id: id as ModifierId, rows })),
    reading: [...readings].map(([id, rows]) => ({ id, rows })).sort((a, b) => cellIndex(a.id) - cellIndex(b.id)),
    fenced: [...fenced]
      .map(([k, rows]) => {
        const [id, layer] = k.split('\t');
        return { id: id as FenceId, layer: layer as Layer, rows };
      })
      .sort((a, b) => cellIndex(a.id) - cellIndex(b.id) || (a.layer < b.layer ? -1 : 1)),
    goal: goalStatement,
    weakest: weakestOf(allCells, env),
    levels,
  };
}

/** What a classifier failure is: a gap in the register, never an exit code. */
export function unclassified(scope: Scope, query: Query): ClassStatement {
  return {
    register: REGISTER_VERSION,
    status: 'unclassified',
    scope,
    basis: 'none',
    query,
    logic: null,
    script: null,
    shape: [],
    modifiers: [],
    reading: [],
    fenced: [],
    goal: { shape: null, modifiers: [], reading: null },
    weakest: null,
    levels: {},
  };
}

/* ─────────────────────────────────── the printed words ─────────────────────────────────── */

/** Printed with every census; scanned by the claims test. It grades no model and moves no verdict. */
export const MATURITY_SENTENCE =
  'states the evidence this build holds for each class (docs/CONSTRAINT-CLASSES.md). It is not a verdict on any model and moves no verdict.';

const BASIS_TEXT: Record<Basis, string> = {
  solver: 'z3 decided the verdict over an encoded, complete context',
  'solver-witness': 'z3 decided it; its counterexample was re-read exactly, every symbol the goal reads being pinned or freed',
  'solver+numeric': 'z3 decided the entailment; a part the encoding left out was re-read on the numeric surface',
  'numeric-surface': 'the verdict word was decided on the numeric surface, not by z3’s answer alone; a `bound:` sentence naming z3 does not say otherwise',
  'point-evaluation': 'a refused relation was read violated at the model’s values; nothing was encoded for it',
  none: 'no solver verdict',
};

const cellText = (id: string, search?: Search): string => (search ? `${id}/${search}` : id);

/** The first line, `classes:` (the one the Checks tab shows). */
export function classLine(s: ClassStatement): string {
  if (s.status === 'unclassified') return "classes: unclassified — a gap in the tool's class register";
  if (s.goal.fence) {
    const f = s.goal.fence;
    const level = levelFor(f.id, { query: s.query });
    const tail = f.forgiven
      ? '--allow-inconclusive forgives this outcome'
      : s.basis === 'point-evaluation'
        ? 'the verdict is a point evaluation at the model’s values, not a solver answer, and no flag forgives it'
        : 'no flag forgives this outcome';
    return `classes: ${f.id} (${f.layer}) [${level}] — not sent to z3; ${tail}`;
  }
  const shapes = s.shape.map((x) => cellText(x.id, x.search));
  let line = `classes: shape ${shapes.length > 0 ? shapes.join(', ') : 'none'}`;
  if (s.script) line += `, script ${cellText(s.script.shape, s.script.search)}`;
  if (s.modifiers.length > 0) line += ` · modifiers ${s.modifiers.map((m) => m.id).join(', ')}`;
  if (s.reading.length > 0) line += ` · reading ${s.reading.map((r) => r.id).join(', ')}`;
  if (s.fenced.length > 0) line += ` · context refused: ${s.fenced.map((f) => `${f.id} ×${f.rows}`).join(', ')}`;
  return line;
}

/** All the lines of a statement: `classes:`, `maturity:` only when the weakest differs from the goal's own cell, `basis:` unless `solver`. */
export function classLines(s: ClassStatement): string[] {
  const lines = [classLine(s)];
  if (s.status === 'unclassified') return lines;
  const env: LevelEnv = { query: s.query };
  if (s.weakest && !s.goal.fence) {
    const goalCell = s.goal.shape === null ? null : shapeCell(s.goal.shape, s.goal.search);
    if (goalCell !== s.weakest.cell) {
      const unmet = s.weakest.firstUnmet === null ? '' : ` (first unmet: ${s.weakest.firstUnmet})`;
      const alone = goalCell === null ? '' : `; goal alone: ${goalCell} [${levelFor(goalCell, env)}]`;
      lines.push(`maturity: weakest ${s.weakest.cell} [${s.weakest.level}]${unmet}${alone}`);
    }
  }
  if (s.basis !== 'solver') lines.push(`basis: ${s.basis} — ${BASIS_TEXT[s.basis]}`);
  return lines;
}

/* ───────────────────────────────────── the surfaces ───────────────────────────────────── */

/** A place the class is stated. `built` needs a pointer that resolves; `planned` says so and nothing more. */
export interface Surface {
  id: string;
  status: 'built' | 'planned';
  pointer: Pointer | null;
}

export const SURFACES: readonly Surface[] = [
  { id: 'register', status: 'built', pointer: { file: 'src/semantics/smt/classes.ts', find: 'export const CONSTRAINT_CLASSES' } },
  { id: 'classifier', status: 'built', pointer: { file: 'src/semantics/smt/classes.ts', find: 'export function classifyRow' } },
  { id: 'verify-text', status: 'planned', pointer: null },
  { id: 'verify-json', status: 'planned', pointer: null },
  { id: 'other-z3-commands', status: 'planned', pointer: null },
  { id: 'checks-tab', status: 'planned', pointer: null },
  { id: 'contracts-view', status: 'planned', pointer: null },
  { id: 'evidence-record', status: 'planned', pointer: null },
  { id: 'generated-docs', status: 'planned', pointer: null },
  { id: 'test-report-counts', status: 'planned', pointer: null },
  { id: 'export', status: 'planned', pointer: null },
];
