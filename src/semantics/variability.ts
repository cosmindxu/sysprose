/**
 * Variability — what a family model admits, and whether a configuration of it is valid.
 *
 * THE PROFILE (P5: every spelling that counts is stated here, and what is not
 * read is refused with its reason, never guessed — a wrong verdict is worse
 * than "not read").
 *
 * SUPERSET OWNER. A definition or usage that directly holds a VARIATION POINT
 * and is not itself inside a variant. A variation point is a usage with
 * `variation` (SysML v2 §7.6.7), or a usage TYPED by a variation definition
 * (Annex A.12: `variation part transmission : TransmissionChoices;` takes its
 * variants from the definition). Its VARIANTS are its owned `variant` usages
 * (or the definition's); a `variant X;` reference form is named by the
 * usage it references (SysML v2 `Usage::namingFeature()`), and name resolution
 * reads `p::X` as that variant (`resolve-names.ts`). A point with both own variants and a variation
 * definition, a variant with no name, or two variants of one name make the
 * owner NOT READ.
 *
 * OPTIONALITY. No multiplicity or `[1]`: exactly one variant (P1). `[0..1]`:
 * at most one. Any other multiplicity on a point is not read (it would allow
 * several variants at once, which this profile does not model).
 *
 * NESTING (P3). A point inside a variant (reached through plain members) is
 * ACTIVE only when that variant is selected; an inactive point has no
 * selection and a selection written for it is invalid. A point under a
 * multiplicity above 1 (`cylinder : Cylinder [6]` holding `diameter`) is read
 * as ONE choice shared by the instances: independent per-instance choices are
 * not modelled, and the report says so.
 *
 * A POINT WITH NO VARIANTS (A.12 `sunroof`) cannot be configured by any
 * selection: it is left OUT of the formula, reported, and every analysis of
 * that owner says it ranges over the other points.
 *
 * SELECTION CONSTRAINTS. `assert constraint` members of the owner whose body
 * is built from atoms `p == p::v` or `p == Def::v` (p a point of the owner,
 * unique by simple name, v one of its variants) combined with `and`, `or`,
 * `xor`, `implies`, `not ( … )` and parentheses. One binary operator per
 * parenthesis level (mixed precedence is refused, not guessed), `implies` not
 * chained, `not` only before parentheses. An atom is false when its point is
 * inactive. Any other atom, operator or spelling: the constraint is NOT READ,
 * with the reason. Not-read constraints widen the model: the count is then "at
 * most", dead variants, core variants and a void model stay sound (more
 * constraints only remove configurations), a "not dead"/"not core" claim is
 * not made, and a HOLDS verdict is qualified as over the constraints read.
 *
 * SELECTIONS (a CONFIGURATION is a usage that subsets or is typed by the
 * owner and redefines points in its body):
 *   - `part :>> p = X::v;`  (bound with `=`; X is the point's name or its
 *     variation definition's name) — a selection;
 *   - `part :>> p :> X::v;` (the redefinition subsets the variant) — a selection,
 *     for a reference-form variant too (`:> p::smallEngine`); subsetting the
 *     usage such a variant references (`:> smallEngine`) is not one, and its
 *     reason names the spelling that is;
 *   - everything else is NOT a selection and is refused with its reason:
 *     `default`/`:=` values (overridable), an unqualified `= v`, typing only
 *     (`: Engine4Cyl` names a type, not a variant), a subsetting of a
 *     non-variant, a `bind`. A selection that names a variant of ANOTHER point,
 *     or a name that is no variant of the point, is INVALID. Selecting a point
 *     twice is invalid. Any not-read selection withholds the verdict (the
 *     configuration might select it).
 *
 * DECISION. By exhaustive enumeration of the structural configurations (one
 * choice per active point; nested points follow their variant), each checked
 * against the constraints: exact, synchronous, with no solver to be absent or to
 * time out, and the formula is small (a family with 10^6 raw configurations is
 * refused as not established, with the cap stated). The equivalent
 * propositional formula (one boolean per point-variant; exactly one per active
 * point, at most one if optional; a variant's nested points exist only under it;
 * the constraints) is what the enumeration decides, so counts, backbones
 * (core/dead), and false-optional are the exact answers of the questions
 * AO10-AO15 (P4). A solver would be the way past the cap, and is not used.
 *
 * CONNECTIONS. A connector of the owner between two ports is re-typed per configuration: an end that is a feature
 * owned directly by a point is replaced by the chosen variant's feature that redefines it, and §7.12.1 conformance
 * (portMismatches) or declared port-definition conformance decides. Newly broken connectors are
 * `variability-connection-broken` (error, exit 1); `valid` is NOT reduced, the broken configurations are listed apart.
 *
 * PER-CONFIGURATION EVALUATION AND EXPLANATION: see the section "per-configuration evaluation" below (V4) and "explanation" (V3).
 *
 * VERDICT AND EXIT CODE. `exitCode` and `verdict` follow VARIABILITY_EXIT_CODES
 * (scripts/lib/sysprose-spec.ts): 1 for a decided negative (INVALID, VIOLATED,
 * VOID), 2 for anything undecided or refused, 0 only when nothing is either. A
 * dead variant or false-optional point is a warning and does not move it.
 *
 * FALSE-OPTIONAL (AO15): an optional point that is selected in EVERY valid
 * configuration where it is active, and active in at least one.
 */
import type { ElementRecord, Model } from '@core/index';
import { generalizationsOf } from './inheritance';
import { reachReport, stateMachinesIn } from './mc/explore';
import { connectorEndsOf } from './connectors';
import { evaluate, exprRefusal, parseExpr } from './expr';
import { declaredDefinitions, definitionsConform, portMismatches } from './port-conformance';

/** Diagnostic codes of this module (catalogued by the integrator). */
export const VARIABILITY_CODES = {
  invalidSelection: 'verification/variability-invalid-selection',
  constraintViolated: 'verification/variability-constraint-violated',
  partial: 'verification/variability-partial-configuration',
  selectionNotRead: 'verification/variability-selection-not-read',
  constraintNotRead: 'verification/variability-constraint-not-read',
  ownerNotRead: 'verification/variability-owner-not-read',
  noVariants: 'verification/variability-no-variants',
  void: 'verification/variability-void',
  deadVariant: 'verification/variability-dead-variant',
  falseOptional: 'verification/variability-false-optional',
  notEstablished: 'verification/variability-not-established',
  family: 'verification/variability-family',
  connectionBroken: 'verification/variability-connection-broken',
  configurationViolates: 'verification/variability-configuration-violates',
  behaviour: 'verification/variability-behaviour',
  behaviourDead: 'verification/variability-behaviour-dead',
} as const;

/** The most structural configurations enumerated before the analyses are withheld. */
export const VARIABILITY_CAP = 1_000_000;

export type VariabilitySeverity = 'error' | 'warning' | 'info';

export interface VariabilityDiagnostic {
  code: string;
  severity: VariabilitySeverity;
  message: string;
  elementId?: string;
}

export interface VariabilityVariant {
  key: string;
  name: string;
  /** The feature a reference-form variant (`variant X;`) references, by id. */
  referenced?: string;
}

export interface VariabilityPoint {
  id: string;
  name: string;
  qualifiedName: string;
  optional: boolean;
  /** Read from the point's variation definition rather than owned variants. */
  viaDefinition: string | null;
  variants: VariabilityVariant[];
  /** The variant (`key`) that activates this point, or null when always active. */
  activatedBy: string | null;
  /** Under a feature of multiplicity above 1: read as one shared choice. */
  sharedAcrossInstances: boolean;
  /** No variants: left out of the formula. */
  configurable: boolean;
}

export interface ConstraintRow {
  id: string;
  name: string;
  text: string;
  read: boolean;
  reason?: string;
}

export interface FamilyAnalysis {
  established: boolean;
  /** Why not, when not established. */
  reason?: string;
  structural: number;
  valid: number;
  /** true when the count is exact; false = "at most" (constraints not read). */
  exact: boolean;
  void: boolean;
  core: string[];
  dead: string[];
  falseOptional: string[];
  /** Points left out of the formula (no variants). */
  excludedPoints: string[];
  /** The valid configurations, as `point = variant` lists (only when few). */
  configurations: string[][];
  /**
   * Valid configurations (they satisfy the structure and the constraints read) in which a connector of the owner
   * is ill-typed once the chosen variants' redefined ports replace the superset's. `valid` still counts them
   * (it answers the constraint question); they are listed here and make the verdict a decided negative.
   */
  connectionBroken: ConnectionBreak[];
  /** When void: a minimal set of the read constraints that conflict (empty: the structure alone), null when not computed. */
  voidCore: string[] | null;
  /** Dead variants with a minimal set of the read constraints that kills each, when computed. */
  deadWhy: Array<{ variant: string; killedBy: string[] }>;
}

/** One constraint or requirement evaluated in one configuration, with the selected variant's values visible. */
export interface ConfigurationEvaluation {
  configuration: string;
  word: 'HOLDS' | 'VIOLATED' | 'UNDECIDED';
  /** The values read (`eng.mass = 400`), or why none could be. */
  values: string[];
  reason?: string;
}

/** A constraint of the owner, or a requirement satisfied by a part on a path through a point, over every configuration. */
export interface FamilyEvaluation {
  kind: 'constraint' | 'requirement';
  id: string;
  name: string;
  text: string;
  /** holds only when EVERY enumerated configuration holds; never while one is undecided. */
  verdict: 'holds' | 'violated' | 'undecided';
  holds: number;
  violated: number;
  undecided: number;
  /** 'exact: all N enumerated' or 'undecided: K of N enumerated'. */
  coverage: string;
  /** Violated and undecided configurations (at most 50 of each); a holding one is counted only. */
  items: ConfigurationEvaluation[];
  /** True when constraints this analysis does not read could exclude a violating configuration: no error is raised. */
  qualified: boolean;
}

export interface ConnectionBreak {
  /** The configuration as `point = variant` text (family) or its name (a configuration usage). */
  configuration: string;
  connector: string;
  why: string;
}

export type SelectionStatus = 'valid' | 'invalid' | 'not-read';

export interface SelectionRow {
  point: string | null;
  text: string;
  status: SelectionStatus;
  reason: string;
}

export type ConfigurationStatus =
  | 'invalid'
  | 'not-evaluated'
  | 'partial'
  | 'holds'
  | 'holds-over-read-constraints'
  | 'violated';

export interface ConfigurationReport {
  id: string;
  name: string;
  selections: SelectionRow[];
  status: ConfigurationStatus;
  missing: string[];
  completes?: boolean;
  completion?: string[];
  forced?: string[];
  violated?: string[];
  /** The ids of the violated constraints (names may repeat: `<anonymous>`). */
  violatedIds?: string[];
  blockedBy?: string[];
  /** Connectors of the owner that are ill-typed under this (complete) selection. */
  connectionBroken?: ConnectionBreak[];
  note?: string;
}

export interface OwnerReport {
  id: string;
  name: string;
  status: 'read' | 'not-read';
  reasons: string[];
  points: VariabilityPoint[];
  constraints: ConstraintRow[];
  analysis: FamilyAnalysis | null;
  configurations: ConfigurationReport[];
  /** Per-configuration evaluation of the owner's attribute constraints and of the requirements satisfied through a point (V4). */
  evaluations: FamilyEvaluation[];
  /** State machines per configuration (V6). */
  behaviour: OwnerBehaviour;
}

/** One state machine and where it exists: in every configuration (`variants` empty) or only where one of the variants is selected. */
export interface MachineBehaviour {
  machine: string;
  /** Variants (by name) whose selection brings the machine in; empty = the same machine in every configuration. */
  variants: string[];
  /** Configurations that have it / enumerated configurations (null = not enumerated). */
  presentIn: number | null;
  total: number | null;
  /** The walk was exhaustive; false = no claim of absence or reachability is made. */
  conclusive: boolean;
  why?: string;
  unreachable: string[];
  dead: string[];
}

export interface OwnerBehaviour {
  machines: MachineBehaviour[];
  /** Variants that add, remove or redefine states or transitions in a way not read per configuration: behaviour analysed on the superset only. */
  supersetOnly: Array<{ variant: string; why: string }>;
}

export interface VariabilityVerdictCounts {
  /** Configurations whose selection constraints HOLD (all read). */
  holds: number;
  /** Decided negatives: an INVALID selection, a VIOLATED constraint, a VOID family. */
  invalid: number;
  violated: number;
  /** Configurations (family or usage) in which a connector breaks under the chosen variants. */
  connectionBroken: number;
  voidFamilies: number;
  /** Families in which a constraint or requirement is VIOLATED by a configuration (decided negative). */
  configurationViolated: number;
  /** Undecided: PARTIAL, not evaluated, holds only over read constraints, constraints/owners not read, families not established. */
  undecided: number;
}

export interface VariabilityReport {
  owners: OwnerReport[];
  diagnostics: VariabilityDiagnostic[];
  summary: { errors: number; warnings: number; infos: number };
  cap: number;
  /** The figures the exit code is computed from (see VARIABILITY_EXIT_CODES in scripts/lib/sysprose-spec.ts). */
  verdict: VariabilityVerdictCounts;
  /** 0 every configuration holds and every family is satisfiable, nothing refused; 1 a decided negative; 2 anything undecided or nothing to read. */
  exitCode: 0 | 1 | 2;
}

/* ───────────────────────────── model helpers ───────────────────────────── */

const isUsage = (e: ElementRecord): boolean => e.eClass.endsWith('Usage');
const isDefinition = (e: ElementRecord): boolean => e.eClass.endsWith('Definition');

function members(model: Model, id: string): ElementRecord[] {
  return model.children(id).filter((c) => isUsage(c) || isDefinition(c));
}
function rels(model: Model, id: string, eClass: string): ElementRecord[] {
  return model.children(id).filter((c) => c.eClass === eClass);
}
function targets(model: Model, id: string, eClass: string): ElementRecord[] {
  const out: ElementRecord[] = [];
  for (const r of rels(model, id, eClass)) {
    for (const t of r.target ?? []) {
      const e = model.get(t);
      if (e) out.push(e);
    }
  }
  return out;
}
const isRedefinition = (model: Model, e: ElementRecord): boolean => rels(model, e.id, 'Redefinition').length > 0;
const isVariantUsage = (e: ElementRecord): boolean => e.attrs.isVariant === true && isUsage(e);
const isLibrary = (e: ElementRecord): boolean => e.attrs.isLibrary === true;

function variationDefsOf(model: Model, e: ElementRecord): ElementRecord[] {
  return targets(model, e.id, 'FeatureTyping').filter((t) => t.attrs.isVariation === true && isDefinition(t));
}
function isPointUsage(model: Model, e: ElementRecord): boolean {
  if (!isUsage(e) || isVariantUsage(e) || isRedefinition(model, e)) return false;
  return e.attrs.isVariation === true || variationDefsOf(model, e).length > 0;
}
function insideVariant(model: Model, e: ElementRecord): boolean {
  let o = e.ownerId !== null ? model.get(e.ownerId) : undefined;
  while (o) {
    if (isVariantUsage(o)) return true;
    o = o.ownerId !== null ? model.get(o.ownerId) : undefined;
  }
  return false;
}
// SysML v2 `Usage::namingFeature()`: a variant is named by the feature its
// ownedReferenceSubsetting references (`variant X;`), any other usage by its
// first redefinition (KerML `Feature::namingFeature()`). A plain subsetting
// names nothing: an unnamed `variant part :> X;` has no name.
function nameOf(model: Model, e: ElementRecord): string | null {
  if (e.declaredName) return e.declaredName;
  const t = targets(model, e.id, isVariantUsage(e) ? 'ReferenceSubsetting' : 'Redefinition')[0];
  return t?.declaredName ?? null;
}
function multiplicityOf(e: ElementRecord): string | null {
  const m = e.attrs.multiplicity;
  return typeof m === 'string' ? m.replace(/\s+/g, '') : null;
}

/* ─────────────────────────────── extraction ────────────────────────────── */

interface Owned {
  points: VariabilityPoint[];
  reasons: string[];
}

function extractPoints(model: Model, owner: ElementRecord): Owned {
  const points: VariabilityPoint[] = [];
  const reasons: string[] = [];

  const addPoint = (e: ElementRecord, activatedBy: string | null, shared: boolean): void => {
    const name = nameOf(model, e) ?? '<anonymous>';
    const defs = variationDefsOf(model, e);
    const own = members(model, e.id).filter(isVariantUsage);
    const q = model.qualifiedName(e.id) || name;
    if (own.length > 0 && defs.length > 0) {
      reasons.push(`${q}: owns variants AND is typed by a variation definition (${defs.map((d) => d.declaredName).join(', ')}); which variants apply is not defined here`);
      return;
    }
    if (e.attrs.isVariation !== true && own.length > 0) {
      reasons.push(`${q}: owns variants but is not a variation`);
      return;
    }
    const mult = multiplicityOf(e);
    let optional = false;
    if (mult === '0..1') optional = true;
    else if (mult !== null && mult !== '1') {
      reasons.push(`${q}: multiplicity [${mult}] on a variation point would allow several variants at once; only none, [1] and [0..1] are read`);
      return;
    }
    const source = own.length > 0 ? own : defs.flatMap((d) => members(model, d.id).filter(isVariantUsage));
    const variants: VariabilityVariant[] = [];
    const seen = new Set<string>();
    const nested: Array<{ el: ElementRecord; key: string }> = [];
    for (const v of source) {
      const vn = nameOf(model, v);
      if (vn === null) {
        reasons.push(`${q}: a variant has no name and references no named usage`);
        return;
      }
      if (seen.has(vn)) {
        reasons.push(`${q}: two variants are named \`${vn}\``);
        return;
      }
      seen.add(vn);
      const key = `${e.id}/${v.id}`;
      const ref = v.declaredName ? undefined : targets(model, v.id, 'ReferenceSubsetting')[0]?.id;
      variants.push(ref === undefined ? { key, name: vn } : { key, name: vn, referenced: ref });
      nested.push({ el: v, key });
    }
    points.push({
      id: e.id,
      name,
      qualifiedName: q,
      optional,
      viaDefinition: own.length === 0 && defs.length > 0 ? defs.map((d) => d.declaredName).join(', ') : null,
      variants,
      activatedBy,
      sharedAcrossInstances: shared,
      configurable: variants.length > 0,
    });
    for (const n of nested) walk(n.el, n.key, shared);
  };

  const walk = (el: ElementRecord, activatedBy: string | null, shared: boolean): void => {
    for (const c of members(model, el.id)) {
      if (!isUsage(c)) continue;
      if (isVariantUsage(c)) continue;
      if (isPointUsage(model, c)) {
        addPoint(c, activatedBy, shared);
        continue;
      }
      const m = multiplicityOf(c);
      walk(c, activatedBy, shared || (m !== null && m !== '1' && m !== '0..1'));
    }
  };

  // The owner's own members are points directly; plain members that hold points
  // are owners of their own (not part of this owner's formula) EXCEPT through variants.
  for (const c of members(model, owner.id)) {
    if (isPointUsage(model, c)) addPoint(c, null, false);
  }
  return { points, reasons };
}

/* ──────────────────────────── selection constraints ─────────────────────── */

type Ast =
  | { k: 'atom'; point: string; variant: string }
  | { k: 'not'; a: Ast }
  | { k: 'op'; op: 'and' | 'or' | 'xor' | 'implies'; args: Ast[] };

type RawAst =
  | { k: 'atom'; lhs: string; rhs: string }
  | { k: 'not'; a: RawAst }
  | { k: 'op'; op: 'and' | 'or' | 'xor' | 'implies'; args: RawAst[] };

class Refuse extends Error {}

function tokenize(text: string): string[] {
  const out: string[] = [];
  const re = /\s+|==|!=|\(|\)|[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*|[\s\S]/y;
  let m: RegExpExecArray | null;
  while (re.lastIndex < text.length && (m = re.exec(text)) !== null) {
    if (/^\s+$/.test(m[0])) continue;
    out.push(m[0]);
  }
  return out;
}

const NAME = /^[A-Za-z_]\w*(::\w+)*$/;

function parseConstraint(text: string): RawAst {
  const toks = tokenize(text);
  let i = 0;
  const OPS = new Set(['and', 'or', 'xor', 'implies']);
  const peek = (): string | undefined => toks[i];
  const expr = (): RawAst => {
    const first = term();
    let op: string | undefined;
    const args = [first];
    while (peek() !== undefined && OPS.has(peek()!)) {
      const o = toks[i++];
      if (op !== undefined && op !== o) {
        throw new Refuse(`mixes \`${op}\` and \`${o}\` without parentheses; precedence is not guessed`);
      }
      op = o;
      args.push(term());
    }
    if (op === undefined) return first;
    if (op === 'implies' && args.length > 2) throw new Refuse('chains `implies` without parentheses');
    return { k: 'op', op: op as 'and', args };
  };
  const term = (): RawAst => {
    const t = peek();
    if (t === undefined) throw new Refuse('ends where an operand was expected');
    if (t === 'not') {
      i++;
      if (peek() !== '(') throw new Refuse('uses `not` before something other than a parenthesis');
      i++;
      const a = expr();
      if (peek() !== ')') throw new Refuse('has an unclosed parenthesis');
      i++;
      return { k: 'not', a };
    }
    if (t === '(') {
      i++;
      const a = expr();
      if (peek() !== ')') throw new Refuse('has an unclosed parenthesis');
      i++;
      return a;
    }
    if (NAME.test(t) && !OPS.has(t)) {
      i++;
      if (peek() === '==') {
        i++;
        const r = toks[i++];
        if (r === undefined || !NAME.test(r)) throw new Refuse(`has \`${t} ==\` followed by something that is not a name`);
        return { k: 'atom', lhs: t, rhs: r };
      }
      throw new Refuse(`has the operand \`${t}\`, which is not a comparison \`point == point::variant\``);
    }
    throw new Refuse(`contains \`${t}\`, which is outside the supported shape (\`==\`, and, or, xor, implies, not ( ), parentheses)`);
  };
  const ast = expr();
  if (i < toks.length) throw new Refuse(`has \`${toks[i]}\` where an operator was expected`);
  return ast;
}

const qualifierNames = (p: VariabilityPoint, prefix: string): boolean =>
  prefix === p.name || (p.viaDefinition !== null && p.viaDefinition.split(', ').some((d) => d === prefix || prefix.endsWith(`::${d}`)));

function resolveAst(raw: RawAst, points: VariabilityPoint[]): Ast {
  if (raw.k === 'not') return { k: 'not', a: resolveAst(raw.a, points) };
  if (raw.k === 'op') return { k: 'op', op: raw.op, args: raw.args.map((a) => resolveAst(a, points)) };
  const { lhs, rhs } = raw;
  if (lhs.includes('::')) throw new Refuse(`compares the qualified path \`${lhs}\`; only a point's simple name is read`);
  const cands = points.filter((p) => p.name === lhs);
  if (cands.length === 0) throw new Refuse(`compares \`${lhs}\`, which is not a variation point of this owner`);
  if (cands.length > 1) throw new Refuse(`compares \`${lhs}\`, which names ${cands.length} points of this owner`);
  const p = cands[0];
  const parts = rhs.split('::');
  const v = parts[parts.length - 1];
  const prefix = parts.slice(0, -1).join('::');
  if (prefix === '') throw new Refuse(`compares \`${lhs}\` to the unqualified \`${rhs}\`; write \`${p.name}::${rhs}\``);
  if (!qualifierNames(p, prefix)) throw new Refuse(`compares \`${lhs}\` to \`${rhs}\`, whose qualifier \`${prefix}\` is neither the point nor its variation definition`);
  const variant = p.variants.find((x) => x.name === v);
  if (!variant) throw new Refuse(`compares \`${lhs}\` to \`${rhs}\`, but \`${v}\` is not a variant of ${p.name} (${p.variants.map((x) => x.name).join(', ') || 'none'})`);
  return { k: 'atom', point: p.id, variant: variant.key };
}

type Sel = Map<string, string | null>;

function evalAst(a: Ast, sel: Sel): boolean {
  if (a.k === 'atom') return sel.get(a.point) === a.variant;
  if (a.k === 'not') return !evalAst(a.a, sel);
  const vs = a.args.map((x) => evalAst(x, sel));
  switch (a.op) {
    case 'and':
      return vs.every(Boolean);
    case 'or':
      return vs.some(Boolean);
    case 'xor':
      return vs.filter(Boolean).length % 2 === 1;
    case 'implies':
      return !vs[0] || vs[1];
  }
}

/* ─────────────────────────────── enumeration ───────────────────────────── */

class CapExceeded extends Error {}

/** Every structural configuration: one choice per active configurable point. */
function enumerate(points: VariabilityPoint[], visit: (sel: Sel) => void): number {
  const ps = points.filter((p) => p.configurable);
  const sel: Sel = new Map();
  const chosen = new Set<string>();
  let leaves = 0;
  const go = (i: number): void => {
    if (i === ps.length) {
      if (++leaves > VARIABILITY_CAP) throw new CapExceeded();
      visit(sel);
      return;
    }
    const p = ps[i];
    const active = p.activatedBy === null || chosen.has(p.activatedBy);
    if (!active) {
      sel.set(p.id, null);
      go(i + 1);
      return;
    }
    for (const v of p.variants) {
      sel.set(p.id, v.key);
      chosen.add(v.key);
      go(i + 1);
      chosen.delete(v.key);
    }
    if (p.optional) {
      sel.set(p.id, null);
      go(i + 1);
    }
  };
  go(0);
  return leaves;
}

/* ─────────────────────────────── the analysis ──────────────────────────── */

const vname = (points: VariabilityPoint[], key: string): string => {
  for (const p of points) {
    const v = p.variants.find((x) => x.key === key);
    if (v) return `${p.name}::${v.name}`;
  }
  return key;
};
const selText = (points: VariabilityPoint[], sel: Sel): string[] =>
  points.filter((p) => sel.get(p.id)).map((p) => `${p.name} = ${vname(points, sel.get(p.id)!)}`);

interface Formula {
  points: VariabilityPoint[];
  read: Array<{ row: ConstraintRow; ast: Ast }>;
  unread: number;
  valid: Sel[] | null; // null = not established
  structural: number;
  capReason?: string;
}

const holdsAll = (read: Formula['read'], sel: Sel): boolean => read.every((c) => evalAst(c.ast, sel));
const selects = (s: Sel, key: string): boolean => [...s.values()].includes(key);

function buildFormula(points: VariabilityPoint[], read: Formula['read'], unread: number): Formula {
  const valid: Sel[] = [];
  const f: Formula = { points, read, unread, valid, structural: 0 };
  try {
    f.structural = enumerate(points, (sel) => {
      if (holdsAll(read, sel)) valid.push(new Map(sel));
    });
  } catch (e) {
    if (!(e instanceof CapExceeded)) throw e;
    f.valid = null;
    f.capReason = `more than ${VARIABILITY_CAP} structural configurations: the enumeration is capped there and nothing is claimed`;
  }
  return f;
}

function analyse(f: Formula, excluded: string[]): FamilyAnalysis {
  if (f.valid === null) {
    return { established: false, reason: f.capReason, structural: 0, valid: 0, exact: false, void: false, core: [], dead: [], falseOptional: [], excludedPoints: excluded, configurations: [], connectionBroken: [], voidCore: null, deadWhy: [] };
  }
  const valid = f.valid;
  const core: string[] = [];
  const dead: string[] = [];
  for (const k of f.points.flatMap((p) => p.variants.map((v) => v.key))) {
    const n = valid.filter((s) => selects(s, k)).length;
    if (n === 0) dead.push(vname(f.points, k));
    else if (n === valid.length) core.push(vname(f.points, k));
  }
  const falseOptional: string[] = [];
  for (const p of f.points) {
    if (!p.optional || !p.configurable) continue;
    const act = valid.filter((s) => p.activatedBy === null || selects(s, p.activatedBy));
    if (act.length > 0 && act.every((s) => s.get(p.id))) falseOptional.push(p.name);
  }
  return {
    established: true,
    structural: f.structural,
    valid: valid.length,
    exact: f.unread === 0,
    void: valid.length === 0,
    core,
    dead,
    falseOptional,
    excludedPoints: excluded,
    configurations: valid.length <= 50 ? valid.map((s) => selText(f.points, s)) : [],
    connectionBroken: [],
    voidCore: null,
    deadWhy: [],
  };
}

/* ──────────────────── per-configuration connection typing ─────────────────── */

const CONNECTOR_KINDS = new Set(['ConnectionUsage', 'InterfaceUsage', 'Connector']);

/**
 * The feature a connector end denotes once the point it passes through is bound to its chosen variant: the end is
 * a feature owned by the point (`connect eng.p to ...`), and the variant may redefine it (`port :>> p : Sg`).
 * Anything else (the end is not under a chosen point, or the variant redefines nothing there) is the end itself.
 */
function endUnder(model: Model, endId: string, sel: Sel): string {
  const end = model.get(endId);
  if (!end || end.ownerId === null || !sel.has(end.ownerId)) return endId;
  const key = sel.get(end.ownerId);
  if (!key) return endId;
  const variant = model.get(key.slice(key.indexOf('/') + 1));
  if (!variant) return endId;
  const mine = new Set([endId, ...generalizationsOf(model, endId).map((g) => g.id)]);
  for (const f of members(model, variant.id)) {
    if (f.id === endId || mine.has(f.id)) continue;
    if (generalizationsOf(model, f.id).some((g) => mine.has(g.id))) return f.id;
  }
  return endId;
}

/** Why two port ends do not join (`undefined` when they do, or when there is no basis to judge): §7.12.1 conformance, else a shared port definition. */
function pairBreak(model: Model, a: string, b: string): string | undefined {
  const label = (id: string): string => model.qualifiedName(id) || model.get(id)?.declaredName || id;
  const pa = model.get(a);
  const pb = model.get(b);
  if (pa?.eClass !== 'PortUsage' || pb?.eClass !== 'PortUsage') return undefined;
  const mm = portMismatches(model, a, b);
  if (mm !== undefined) {
    if (mm.length === 0) return undefined;
    const m = mm[0];
    return `${label(m.port)}: \`${m.feature.direction} ${m.feature.name}\` ${m.reason === 'direction' ? 'meets a feature that is not its conjugate' : 'has no feature of a conforming definition on the other end'} (SysML v2 §7.12.1)`;
  }
  // The DECLARED definitions (a redefining port typed Sg is an Sg, whatever the port it redefines was typed).
  const da = declaredDefinitions(model, a).filter((d) => d.eClass === 'PortDefinition');
  const db = declaredDefinitions(model, b).filter((d) => d.eClass === 'PortDefinition');
  if (da.length === 0 || db.length === 0 || definitionsConform(model, a, b)) return undefined;
  const nm = (ds: ElementRecord[]): string => ds.map((x) => x.declaredName ?? x.id).join('/');
  return `${label(a)} : ${nm(da)} and ${label(b)} : ${nm(db)} do not conform (neither port definition specializes the other)`;
}

/** The connectors of `owner` that are well-typed in the superset but ill-typed under a selection; memoised on the selections the connector ends pass through. */
function connectionChecker(model: Model, owner: ElementRecord): (sel: Sel) => Array<{ connector: string; why: string }> {
  const connectors = members(model, owner.id)
    .filter((c) => CONNECTOR_KINDS.has(c.eClass))
    .map((c) => ({ c, ends: connectorEndsOf(model, c.id) }))
    .filter((x) => x.ends.length === 2 && x.ends.every((e) => model.get(e)?.eClass === 'PortUsage'))
    .filter((x) => pairBreak(model, x.ends[0], x.ends[1]) === undefined); // ill-typed already in the superset: connection-compatibility's finding
  const relevant = [...new Set(connectors.flatMap((x) => x.ends.map((e) => model.get(e)?.ownerId).filter((o): o is string => typeof o === 'string')))];
  const cache = new Map<string, Array<{ connector: string; why: string }>>();
  return (sel) => {
    if (connectors.length === 0) return [];
    const key = relevant.map((id) => sel.get(id) ?? '-').join('|');
    const hit = cache.get(key);
    if (hit) return hit;
    const out: Array<{ connector: string; why: string }> = [];
    for (const { c, ends } of connectors) {
      const under = ends.map((e) => endUnder(model, e, sel));
      if (under[0] === ends[0] && under[1] === ends[1]) continue;
      const why = pairBreak(model, under[0], under[1]);
      if (why !== undefined) out.push({ connector: model.qualifiedName(c.id) || c.declaredName || c.id, why });
    }
    cache.set(key, out);
    return out;
  };
}

/* ───────────────────────────── configurations ──────────────────────────── */

const QNAME = /^[A-Za-z_]\w*(::[A-Za-z_]\w*)+$/;

function selectionsOf(model: Model, cfg: ElementRecord, points: VariabilityPoint[]): { rows: SelectionRow[]; chosen: Map<string, string[]> } {
  const rows: SelectionRow[] = [];
  const chosen = new Map<string, string[]>();
  const pointById = new Map(points.map((p) => [p.id, p]));

  const addValid = (p: VariabilityPoint, key: string, text: string, how: string): void => {
    rows.push({ point: p.name, text, status: 'valid', reason: `${how} names a variant of ${p.name}` });
    chosen.set(p.id, [...(chosen.get(p.id) ?? []), key]);
  };

  const visit = (m: ElementRecord): void => {
    if (!isUsage(m)) return;
    for (const c of model.children(m.id)) {
      if (c.eClass === 'BindingConnectorAsUsage' || c.eClass === 'BindingConnector') {
        rows.push({ point: null, text: 'bind …', status: 'not-read', reason: 'a `bind` connector is not read as a selection; write `part :>> p = p::v;`' });
      }
    }
    const redefined = targets(model, m.id, 'Redefinition')
      .map((t) => pointById.get(t.id))
      .filter((p): p is VariabilityPoint => p !== undefined);
    // A redefinition the binder could not resolve (a nested point written
    // `:>> diameter` from the configuration's own scope) survives as the written
    // name in `attrs.redefines`; it is read as the point of that name when exactly
    // one point of the owner bears it, and ignored otherwise.
    if (rels(model, m.id, 'Redefinition').length === 0 && Array.isArray(m.attrs.redefines)) {
      for (const w of m.attrs.redefines as unknown[]) {
        const last = String(w).split('::').pop();
        const named = points.filter((p) => p.name === last);
        if (named.length === 1) redefined.push(named[0]);
      }
    }
    for (const p of redefined) {
      const label = `:>> ${p.name}`;
      const value = typeof m.attrs.value === 'string' ? (m.attrs.value as string).trim() : null;
      if (value !== null) {
        if (m.attrs.defaultValue === true || m.attrs.initialValue === true) {
          rows.push({ point: p.name, text: `${label} ${m.attrs.defaultValue === true ? 'default' : ':='} ${value}`, status: 'not-read', reason: 'a default or initial value can be overridden; only `=` selects' });
        } else if (!QNAME.test(value)) {
          rows.push({
            point: p.name,
            text: `${label} = ${value}`,
            status: 'not-read',
            reason: /^[A-Za-z_]\w*$/.test(value) ? `the unqualified \`${value}\` is not read; write \`${p.name}::${value}\`` : 'the value is not a qualified name `p::v`',
          });
        } else {
          const text = `${label} = ${value}`;
          const parts = value.split('::');
          const v = parts[parts.length - 1];
          const prefix = parts.slice(0, -1).join('::');
          const hit = p.variants.find((x) => x.name === v);
          if (qualifierNames(p, prefix)) {
            if (hit) addValid(p, hit.key, text, '`=`');
            else rows.push({ point: p.name, text, status: 'invalid', reason: `\`${v}\` is not a variant of ${p.name} (variants: ${p.variants.map((x) => x.name).join(', ')})` });
          } else {
            const other = points.find((q) => q !== p && qualifierNames(q, prefix));
            if (other && other.variants.some((x) => x.name === v)) {
              rows.push({ point: p.name, text, status: 'invalid', reason: `\`${value}\` is a variant of ${other.name}, not of ${p.name}` });
            } else {
              rows.push({ point: p.name, text, status: 'not-read', reason: `the qualifier \`${prefix}\` is neither ${p.name} nor its variation definition` });
            }
          }
        }
      }
      for (const t of targets(model, m.id, 'Subsetting')) {
        const hit = p.variants.find((x) => x.key === `${p.id}/${t.id}`);
        const text = `${label} :> ${hit ? `${p.name}::${hit.name}` : model.qualifiedName(t.id) || t.declaredName || t.id}`;
        if (hit) addValid(p, hit.key, text, '`:>`');
        else if (points.some((q) => q !== p && q.variants.some((x) => x.key === `${q.id}/${t.id}`))) {
          rows.push({ point: p.name, text, status: 'invalid', reason: `${t.declaredName} is a variant of another point, not of ${p.name}` });
        } else {
          const via = p.variants.find((x) => x.referenced === t.id);
          rows.push({
            point: p.name,
            text,
            status: 'not-read',
            reason: via
              ? `${t.declaredName} is what the variant ${p.name}::${via.name} references, not the variant; write \`:> ${p.name}::${via.name}\``
              : `${t.declaredName ?? 'the target'} is not a variant of ${p.name}; subsetting a non-variant is not a selection`,
          });
        }
      }
      const typed = targets(model, m.id, 'FeatureTyping');
      if (typed.length > 0 && value === null) {
        rows.push({ point: p.name, text: `${label} : ${typed.map((t) => t.declaredName).join(', ')}`, status: 'not-read', reason: 'typing names a type, not a variant; it is not a selection' });
      }
    }
    for (const c of members(model, m.id)) visit(c);
  };
  for (const c of members(model, cfg.id)) visit(c);
  return { rows, chosen };
}

function configurations(model: Model, owner: ElementRecord, f: Formula, diags: VariabilityDiagnostic[], breaksOf: (sel: Sel) => Array<{ connector: string; why: string }>, completeOut: Map<string, { name: string; sel: Sel }>): ConfigurationReport[] {
  const out: ConfigurationReport[] = [];
  const cfgs = model
    .all()
    .filter((e) => !isLibrary(e) && isUsage(e) && e.id !== owner.id)
    .filter((e) => ['Subsetting', 'FeatureTyping'].some((c) => targets(model, e.id, c).some((t) => t.id === owner.id)));
  const conf = f.points.filter((p) => p.configurable);
  for (const cfg of cfgs) {
    const name = model.qualifiedName(cfg.id) || cfg.declaredName || cfg.id;
    const { rows, chosen } = selectionsOf(model, cfg, f.points);
    // Points are in preorder, so a parent is settled before its nested points.
    const sel: Sel = new Map();
    const active = new Set<string>();
    for (const p of conf) {
      const picks = chosen.get(p.id) ?? [];
      if (picks.length === 0) continue;
      if (picks.length > 1) {
        rows.push({ point: p.name, text: picks.map((k) => vname(f.points, k)).join(' and '), status: 'invalid', reason: `${p.name} is selected more than once` });
        continue;
      }
      if (p.activatedBy !== null && !active.has(p.activatedBy)) {
        rows.push({ point: p.name, text: vname(f.points, picks[0]), status: 'invalid', reason: `${p.name} is inactive: it exists only when ${vname(f.points, p.activatedBy)} is selected (P3)` });
        continue;
      }
      sel.set(p.id, picks[0]);
      active.add(picks[0]);
    }
    const missing: string[] = [];
    const act2 = new Set<string>();
    for (const p of conf) {
      const s = sel.get(p.id);
      if (s) act2.add(s);
      else if ((p.activatedBy === null || act2.has(p.activatedBy)) && !p.optional && !(chosen.get(p.id)?.length)) missing.push(p.name);
    }
    for (const r of rows) {
      if (r.status === 'invalid') diags.push({ code: VARIABILITY_CODES.invalidSelection, severity: 'error', message: `${name}: invalid selection \`${r.text}\` — ${r.reason}`, elementId: cfg.id });
      if (r.status === 'not-read') diags.push({ code: VARIABILITY_CODES.selectionNotRead, severity: 'info', message: `${name}: \`${r.text}\` is not read as a selection — ${r.reason}`, elementId: cfg.id });
    }
    const rep: ConfigurationReport = { id: cfg.id, name, selections: rows, status: 'partial', missing };
    const extending = (valid: Sel[]): Sel[] => valid.filter((s) => [...sel.entries()].every(([k, v]) => s.get(k) === v));
    if (rows.some((r) => r.status === 'invalid')) {
      rep.status = 'invalid';
    } else if (rows.some((r) => r.status === 'not-read')) {
      rep.status = 'not-evaluated';
      rep.note = 'a spelling that is not read might select; no verdict is given over this configuration';
    } else if (f.valid === null) {
      rep.status = 'not-evaluated';
      rep.note = f.capReason;
    } else if (missing.length > 0) {
      rep.status = 'partial';
      const ext = extending(f.valid);
      rep.completes = ext.length > 0;
      const qual = f.unread > 0 ? ' over the constraints read' : '';
      if (ext.length > 0) {
        rep.completion = selText(f.points, ext[0]);
        rep.forced = conf
          .filter((p) => !sel.has(p.id) && ext[0].get(p.id) && ext.every((s) => s.get(p.id) === ext[0].get(p.id)))
          .map((p) => vname(f.points, ext[0].get(p.id)!));
        diags.push({ code: VARIABILITY_CODES.partial, severity: 'warning', message: `${name}: partial — no selection for ${missing.join(', ')}; completes${qual}; forced: ${rep.forced.join(', ') || 'nothing'}`, elementId: cfg.id });
      } else {
        const blockers = f.read
          .filter((c) => {
            let n = 0;
            enumerate(f.points, (s) => {
              if (evalAst(c.ast, s) && [...sel.entries()].every(([k, v]) => s.get(k) === v)) n++;
            });
            return n === 0;
          })
          .map((c) => c.row.name);
        rep.blockedBy = blockers.length > 0 ? blockers : ['the constraints jointly'];
        diags.push({ code: VARIABILITY_CODES.partial, severity: 'warning', message: `${name}: partial and CANNOT be completed — no valid configuration extends it (blocked by ${rep.blockedBy.join(', ')})`, elementId: cfg.id });
      }
    } else {
      const bad = f.read.filter((c) => !evalAst(c.ast, sel));
      if (bad.length === 0) completeOut.set(cfg.id, { name, sel: new Map(sel) });
      if (bad.length > 0) {
        rep.status = 'violated';
        rep.violated = bad.map((c) => c.row.name);
        rep.violatedIds = bad.map((c) => c.row.id);
        for (const c of bad) diags.push({ code: VARIABILITY_CODES.constraintViolated, severity: 'error', message: `${name}: the selection constraint ${c.row.name} is VIOLATED by ${selText(f.points, sel).join(', ')}`, elementId: cfg.id });
      } else {
        const broken = breaksOf(sel);
        if (broken.length > 0) {
          rep.connectionBroken = broken.map((b) => ({ configuration: name, ...b }));
          for (const b of rep.connectionBroken) diags.push({ code: VARIABILITY_CODES.connectionBroken, severity: 'error', message: `${name}: the connection ${b.connector} breaks under ${selText(f.points, sel).join(', ')} — ${b.why}`, elementId: cfg.id });
        }
        rep.status = f.unread === 0 ? 'holds' : 'holds-over-read-constraints';
      }
    }
    out.push(rep);
  }
  return out;
}

/* ───────────── per-configuration evaluation of attribute constraints and requirements (V4) ─────────────
 *
 * PRODUCT-BASED, EXACT UNDER THE ENUMERATION CAP. An owner's `assert constraint` that is not a selection
 * constraint (`eng.mass <= limit`) and a requirement satisfied by a part on a path through a point
 * (`satisfy R by c1.eng`) are evaluated in every configuration the family enumerates, with the SELECTED variant's
 * values visible through the feature chain: `eng.mass` reads the `mass` the chosen variant redefines (or, failing
 * that, the point's own). The expression evaluator is the one every lane reads (`./expr`); only its scope is
 * this module's selection overlay. A value the overlay cannot read (no stated number/boolean, a nested chain, an
 * inactive or unselected point, an arrow, a call, a qualified name) makes THAT configuration UNDECIDED and the
 * family verdict undecided: `holds` is the conjunction over ALL enumerated configurations, never a pass past one
 * undecided. A VIOLATED configuration is `variability-configuration-violates` (error); it is only a warning when
 * constraints this analysis does not read might exclude that configuration.
 * Spec: SysML v2 §7.6.7 (variation, variant, selection by redefinition); §7.19 (constraint and requirement
 * evaluation; `satisfy`, subject).
 */

const KEY_ELEMENT = (key: string): string => key.slice(key.indexOf('/') + 1);

/** The number or Boolean an attribute named `attr` states on `holder` (own redefinition or declaration), or undefined. */
function statedValue(model: Model, holder: ElementRecord, attr: string): number | boolean | undefined {
  const hits = members(model, holder.id).filter(
    (m) => m.eClass === 'AttributeUsage' && (m.declaredName === attr || targets(model, m.id, 'Redefinition').some((t) => t.declaredName === attr)),
  );
  if (hits.length !== 1) return undefined;
  // A `default` or `:=` value is overridable, so it is not the value the configuration has.
  if (hits[0].attrs.defaultValue === true || hits[0].attrs.initialValue === true) return undefined;
  const v = hits[0].attrs.value;
  return typeof v === 'number' || typeof v === 'boolean' ? v : undefined;
}

/** The value `point.attr` has under `sel`: the chosen variant's, else the point's own. Undefined = not read. */
function pointValue(model: Model, p: VariabilityPoint, attr: string, sel: Sel): number | boolean | undefined {
  const key = sel.get(p.id);
  if (!key) return undefined;
  const variant = p.variants.find((v) => v.key === key);
  const vel = model.get(variant?.referenced ?? KEY_ELEMENT(key));
  if (!vel) return undefined;
  const own = statedValue(model, vel, attr);
  if (own !== undefined) return own;
  const pel = model.get(p.id);
  return pel ? statedValue(model, pel, attr) : undefined;
}

interface EvalScope {
  /** The simple name the expression uses for the point's selected part (`eng`, or a requirement's subject). */
  alias: Map<string, VariabilityPoint>;
  /** Where an unqualified name is looked up (the owner, or the requirement). */
  holder: ElementRecord;
}

function evaluateText(model: Model, text: string, sc: EvalScope, sel: Sel): ConfigurationEvaluation {
  const configuration = selText([...sc.alias.values()], sel).join(', ');
  const read: string[] = [];
  let node;
  try {
    node = parseExpr(text);
  } catch {
    return { configuration, word: 'UNDECIDED', values: [], reason: 'the body is not an expression this tool parses' };
  }
  const refusal = exprRefusal(node);
  if (refusal !== undefined) return { configuration, word: 'UNDECIDED', values: [], reason: refusal.detail };
  const unread: string[] = [];
  const scope = (name: string): unknown => {
    const parts = name.split('.');
    let v: number | boolean | undefined;
    const p = sc.alias.get(parts[0]);
    if (p !== undefined) {
      if (!sel.get(p.id)) unread.push(`${name} (${p.name} has no selected variant here)`);
      else if (parts.length !== 2) unread.push(`${name} (only point.attribute is read)`);
      else v = pointValue(model, p, parts[1], sel);
    } else if (parts.length === 1) v = statedValue(model, sc.holder, parts[0]);
    if (v === undefined) {
      if (!unread.some((u) => u.startsWith(name))) unread.push(`${name} (no stated number or Boolean)`);
      return undefined;
    }
    read.push(`${name} = ${String(v)}`);
    return v;
  };
  const r = evaluate(node, scope);
  const values = [...new Set(read)];
  if ('value' in r && typeof r.value === 'boolean') return { configuration, word: r.value ? 'HOLDS' : 'VIOLATED', values };
  return { configuration, word: 'UNDECIDED', values, reason: unread.length > 0 ? `not read: ${[...new Set(unread)].join('; ')}` : 'the body does not evaluate to a Boolean' };
}

function summarise(
  kind: FamilyEvaluation['kind'],
  id: string,
  name: string,
  text: string,
  results: ConfigurationEvaluation[],
  total: number,
  qualified: boolean,
  enumerated: boolean,
): FamilyEvaluation {
  const count = (w: ConfigurationEvaluation['word']): number => results.filter((x) => x.word === w).length;
  const violated = count('VIOLATED');
  const undecided = count('UNDECIDED');
  const complete = enumerated && results.length === total;
  const verdict: FamilyEvaluation['verdict'] = violated > 0 && !qualified ? 'violated' : violated === 0 && undecided === 0 && complete ? 'holds' : 'undecided';
  return {
    kind,
    id,
    name,
    text,
    verdict,
    holds: count('HOLDS'),
    violated,
    undecided,
    coverage: !enumerated ? 'undecided: 0 enumerated (the enumeration is capped)' : undecided === 0 ? `exact: all ${total} enumerated` : `undecided: ${total - undecided} of ${total} enumerated`,
    items: [...results.filter((x) => x.word === 'VIOLATED').slice(0, 50), ...results.filter((x) => x.word === 'UNDECIDED').slice(0, 50)],
    qualified,
  };
}

function nameOrText(name: string, text: string): string {
  return name === '<anonymous>' ? `\`${text.length > 60 ? `${text.slice(0, 57)}...` : text}\`` : name;
}

/** The point a `satisfy` source chain ends at, when its qualifier names the owner or the configuration. */
function satisfyPoint(chain: string, points: VariabilityPoint[], allowed: Set<string>): VariabilityPoint | undefined {
  const parts = chain.split('.').map((x) => x.trim());
  const last = parts[parts.length - 1];
  if (parts.slice(0, -1).some((q) => !allowed.has(q))) return undefined;
  const cands = points.filter((p) => p.name === last && p.activatedBy === null);
  return cands.length === 1 ? cands[0] : undefined;
}

function evaluateFamily(
  model: Model,
  owner: ElementRecord,
  f: Formula,
  rows: ConstraintRow[],
  completeCfgs: Map<string, { name: string; sel: Sel }>,
  diags: VariabilityDiagnostic[],
  ownerName: string,
): FamilyEvaluation[] {
  const out: FamilyEvaluation[] = [];
  const unreadOther = (selfUnread: number): boolean => f.unread - selfUnread > 0;
  const all: Sel[] | null = f.valid;
  const alias = new Map(f.points.filter((p) => p.configurable).map((p) => [p.name, p] as const));
  // Every enumerated configuration is evaluated, over the selection constraints read (`valid`).
  const emit = (ev: FamilyEvaluation, per: Array<{ cfg: string; r: ConfigurationEvaluation }>, anchor: string): void => {
    for (const { cfg, r } of per.filter((x) => x.r.word === 'VIOLATED').slice(0, 20)) {
      diags.push({
        code: VARIABILITY_CODES.configurationViolates,
        severity: ev.qualified ? 'warning' : 'error',
        message: `${ownerName}: in ${cfg} the ${ev.kind} ${ev.name} is VIOLATED (${r.values.join(', ') || 'no value'})${ev.qualified ? ' — unless a constraint that is not read excludes this configuration' : ''}`,
        elementId: anchor,
      });
    }
  };
  // 1. attribute constraints of the owner that are not selection constraints.
  const attrRows = rows.filter((r) => !r.read && f.points.some((p) => r.text.includes(p.name)));
  for (const row of attrRows) {
    const sc: EvalScope = { alias, holder: owner };
    const per = (all ?? []).map((sel) => ({ cfg: `the configuration ${selText(f.points, sel).join(', ')}`, r: evaluateText(model, row.text, sc, sel) }));
    const ev = summarise('constraint', row.id, nameOrText(row.name, row.text), row.text, per.map((x) => x.r), all?.length ?? 0, unreadOther(1), all !== null);
    out.push(ev);
    emit(ev, per, row.id);
    for (const [cid, c] of completeCfgs) {
      const r = evaluateText(model, row.text, sc, c.sel);
      if (r.word === 'VIOLATED') {
        diags.push({ code: VARIABILITY_CODES.configurationViolates, severity: ev.qualified ? 'warning' : 'error', message: `${c.name}: the constraint ${ev.name} is VIOLATED (${r.values.join(', ')})`, elementId: cid });
      }
    }
  }
  // 2. requirements satisfied by a part on a path through a point.
  const cfgNames = new Map([...completeCfgs].map(([id, c]) => [id, c.name.split('::').pop() ?? c.name] as const));
  const ownerNames = new Set([owner.declaredName ?? '', 'self'].filter((x) => x !== ''));
  for (const sat of model.all().filter((e) => e.eClass === 'Satisfy' && !isLibrary(e))) {
    const holderId = sat.ownerId ?? '';
    const chain = sat.attrs.sourceChain ?? sat.attrs.sourceRef ?? model.get(sat.source?.[0] ?? '')?.declaredName;
    if (typeof chain !== 'string') continue;
    const familyLevel = holderId === owner.id;
    const cfg = completeCfgs.get(holderId);
    const allCfgs = model.all().some((e) => e.id === holderId && isUsage(e) && ['Subsetting', 'FeatureTyping'].some((c) => targets(model, e.id, c).some((t) => t.id === owner.id)));
    if (!familyLevel && !allCfgs) continue;
    const allowed = new Set([...ownerNames, model.get(holderId)?.declaredName ?? '']);
    const p = satisfyPoint(chain, f.points, allowed);
    if (p === undefined) continue;
    const req = model.get(sat.target?.[0] ?? '');
    if (!req) continue;
    const name = `${req.declaredName ?? '<anonymous>'} (satisfied by ${chain})`;
    const subject = members(model, req.id).find((m) => m.attrs.requirementRole === 'subject');
    const bodies = members(model, req.id).filter((m) => m.eClass === 'ConstraintUsage' && m.attrs.requirementRole === 'require');
    const assumes = members(model, req.id).filter((m) => m.eClass === 'ConstraintUsage' && m.attrs.requirementRole === 'assume');
    const texts = bodies.map((b) => (typeof b.attrs.expression === 'string' ? (b.attrs.expression as string).replace(/\s+/g, ' ').trim() : ''));
    const subjectName = subject?.declaredName;
    const sc: EvalScope = { alias: new Map(subjectName ? [[subjectName, p]] : []), holder: req };
    const evalOne = (sel: Sel): ConfigurationEvaluation => {
      const cfgLabel = selText(f.points, sel).join(', ');
      if (subjectName === undefined || bodies.length === 0 || texts.some((t) => t === '') || assumes.length > 0) {
        return { configuration: cfgLabel, word: 'UNDECIDED', values: [], reason: 'the requirement has no subject, no `require constraint` body, or an `assume` (not read)' };
      }
      const rs = texts.map((t) => evaluateText(model, t, sc, sel));
      const bad = rs.find((r) => r.word === 'VIOLATED');
      const und = rs.find((r) => r.word === 'UNDECIDED');
      const values = [...new Set(rs.flatMap((r) => r.values))];
      if (bad) return { configuration: cfgLabel, word: 'VIOLATED', values };
      if (und) return { configuration: cfgLabel, word: 'UNDECIDED', values, reason: und.reason };
      return { configuration: cfgLabel, word: 'HOLDS', values };
    };
    const sels: Array<{ cfg: string; sel: Sel }> = familyLevel
      ? (all ?? []).map((sel) => ({ cfg: `the configuration ${selText(f.points, sel).join(', ')}`, sel }))
      : cfg
        ? [{ cfg: cfgNames.get(holderId) ?? cfg.name, sel: cfg.sel }]
        : [];
    const per = sels.map((x) => ({ cfg: x.cfg, r: evalOne(x.sel) }));
    if (!familyLevel && !cfg) {
      out.push(summarise('requirement', sat.id, name, texts.join(' and '), [{ configuration: cfgNames.get(holderId) ?? holderId, word: 'UNDECIDED', values: [], reason: 'the configuration is not a complete valid selection' }], 1, false, true));
      continue;
    }
    const ev = summarise('requirement', sat.id, name, texts.join(' and '), per.map((x) => x.r), sels.length, unreadOther(0), familyLevel ? all !== null : true);
    out.push(ev);
    emit(ev, per, sat.id);
  }
  return out;
}

/* ─────────────── explanation of a void family and of dead variants (V3) ─────────────── */

/** The satisfaction bitmask of each structural configuration, with the variants it selects; null when too large or too many constraints. */
function maskTable(f: Formula): Array<{ mask: number; keys: Set<string> }> | null {
  if (f.read.length > 30 || f.structural > 200_000) return null;
  const rows: Array<{ mask: number; keys: Set<string> }> = [];
  enumerate(f.points, (sel) => {
    let mask = 0;
    f.read.forEach((c, i) => {
      if (evalAst(c.ast, sel)) mask |= 1 << i;
    });
    rows.push({ mask, keys: new Set([...sel.values()].filter((x): x is string => x !== null)) });
  });
  return rows;
}

/** A minimal subset of the constraints that no row satisfies together (deletion filtering); [] when even none excludes every row. */
function conflictCore(masks: number[], n: number): number[] | null {
  const sat = (set: number[]): boolean => {
    const m = set.reduce((a, i) => a | (1 << i), 0);
    return masks.some((x) => (x & m) === m);
  };
  let core = Array.from({ length: n }, (_, i) => i);
  if (sat(core)) return null;
  for (const i of [...core]) {
    const t = core.filter((x) => x !== i);
    if (!sat(t)) core = t;
  }
  return core;
}

function explain(f: Formula, a: FamilyAnalysis): void {
  if (!a.established || (!a.void && a.dead.length === 0)) return;
  const table = maskTable(f);
  if (table === null) return;
  const nm = (i: number): string => nameOrText(f.read[i].row.name, f.read[i].row.text);
  if (a.void) {
    const core = conflictCore(table.map((r) => r.mask), f.read.length);
    a.voidCore = core === null ? null : core.map(nm);
    return;
  }
  for (const k of f.points.flatMap((p) => p.variants.map((v) => v.key))) {
    const label = vname(f.points, k);
    if (!a.dead.includes(label)) continue;
    const core = conflictCore(table.filter((r) => r.keys.has(k)).map((r) => r.mask), f.read.length);
    if (core !== null) a.deadWhy.push({ variant: label, killedBy: core.map(nm) });
  }
}

/* ───────────────────────────────── driver ──────────────────────────────── */

function constraintsOf(model: Model, owner: ElementRecord, points: VariabilityPoint[]): { rows: ConstraintRow[]; read: Formula['read'] } {
  const rows: ConstraintRow[] = [];
  const read: Formula['read'] = [];
  for (const c of members(model, owner.id)) {
    if (c.eClass !== 'ConstraintUsage' || c.attrs.requirementRole !== 'assert') continue;
    const name = c.declaredName ?? '<anonymous>';
    const text = typeof c.attrs.expression === 'string' ? (c.attrs.expression as string).replace(/\s+/g, ' ').trim() : '';
    const row: ConstraintRow = { id: c.id, name, text, read: false };
    rows.push(row);
    try {
      if (c.attrs.negated === true || c.attrs.isNegated === true) throw new Refuse('is a negated assertion');
      if (text === '') throw new Refuse('has no expression body');
      if (!points.some((p) => text.includes(p.name))) throw new Refuse('mentions no variation point of this owner (not a selection constraint)');
      const ast = resolveAst(parseConstraint(text), points);
      row.read = true;
      read.push({ row, ast });
    } catch (e) {
      if (!(e instanceof Refuse)) throw e;
      row.reason = e.message;
    }
  }
  return { rows, read };
}

/**
 * The selection constraints this analysis decides, by constraint id, each with
 * the sentence that states its verdict per configuration. The model checker
 * (`constraint-violation`, `target-by-specialisation`) cannot evaluate a body
 * over variant references (`engine == engine::e4`): it names the verdict this
 * analysis gives instead of reporting the constraint as unevaluated beside a
 * report that decides it. Only a constraint read here (all of its body
 * understood) of an owner read here is listed; any other keeps the checker's
 * own note. Memoised per model revision.
 */
const decidedCache = new WeakMap<Model, { rev: number; map: Map<string, string> }>();
export function decidedSelectionConstraints(model: Model): Map<string, string> {
  const hit = decidedCache.get(model);
  if (hit !== undefined && hit.rev === model.rev) return hit.map;
  const map = new Map<string, string>();
  if (model.all().some((e) => e.attrs.isVariant === true && !isLibrary(e))) {
    for (const o of variabilityReport(model).owners) {
      if (o.status !== 'read') continue;
      for (const c of o.constraints) {
        if (!c.read) continue;
        const per = o.configurations.map((cfg) => {
          const short = cfg.name.split('::').pop() ?? cfg.name;
          const word =
            cfg.status === 'violated'
              ? cfg.violatedIds?.includes(c.id)
                ? 'VIOLATED'
                : 'HOLDS'
              : cfg.status === 'holds'
                ? 'HOLDS'
                : cfg.status === 'holds-over-read-constraints'
                  ? 'HOLDS over the constraints read'
                  : cfg.status === 'invalid'
                    ? 'INVALID selection'
                    : cfg.status === 'partial'
                      ? 'PARTIAL'
                      : 'NOT EVALUATED';
          return `${short} ${word}`;
        });
        map.set(
          c.id,
          `a selection constraint over the variation points of ${o.name}, decided per configuration by \`sysprose variability\`: ${per.length > 0 ? per.join(', ') : 'no configuration is written'}`,
        );
      }
    }
  }
  decidedCache.set(model, { rev: model.rev, map });
  return map;
}

export function variabilityReport(model: Model): VariabilityReport {
  const owners: OwnerReport[] = [];
  const diagnostics: VariabilityDiagnostic[] = [];
  for (const e of model.all()) {
    if (isLibrary(e) || !(isUsage(e) || isDefinition(e)) || insideVariant(model, e)) continue;
    if (!members(model, e.id).some((c) => isPointUsage(model, c))) continue;
    const name = model.qualifiedName(e.id) || e.declaredName || e.id;
    const { points, reasons } = extractPoints(model, e);
    if (reasons.length > 0) {
      owners.push({ id: e.id, name, status: 'not-read', reasons, points: [], constraints: [], analysis: null, configurations: [], evaluations: [], behaviour: { machines: [], supersetOnly: [] } });
      for (const r of reasons) diagnostics.push({ code: VARIABILITY_CODES.ownerNotRead, severity: 'info', message: `${name} is not read as a variability model — ${r}`, elementId: e.id });
      continue;
    }
    const { rows, read } = constraintsOf(model, e, points);
    for (const r of rows.filter((x) => !x.read)) {
      diagnostics.push({ code: VARIABILITY_CODES.constraintNotRead, severity: 'info', message: `${name}: the constraint ${r.name} is not read — it ${r.reason}; the analyses treat it as absent`, elementId: r.id });
    }
    const excluded = points.filter((p) => !p.configurable);
    for (const p of excluded) {
      diagnostics.push({ code: VARIABILITY_CODES.noVariants, severity: 'warning', message: `${p.qualifiedName} is a variation with no variants: no selection can configure it; it is left out of the formula and the analyses range over the other points`, elementId: p.id });
    }
    const f = buildFormula(points, read, rows.filter((x) => !x.read).length);
    const analysis = analyse(f, excluded.map((p) => p.name));
    if (analysis.established) explain(f, analysis);
    const breaksOf = connectionChecker(model, e);
    if (analysis.established && f.valid !== null) {
      for (const sel of f.valid) {
        for (const b of breaksOf(sel)) analysis.connectionBroken.push({ configuration: selText(f.points, sel).join(', '), ...b });
      }
      for (const b of analysis.connectionBroken.slice(0, 50)) diagnostics.push({ code: VARIABILITY_CODES.connectionBroken, severity: 'error', message: `${name}: in the configuration ${b.configuration} the connection ${b.connector} breaks — ${b.why}`, elementId: e.id });
    }
    if (!analysis.established) {
      diagnostics.push({ code: VARIABILITY_CODES.notEstablished, severity: 'warning', message: `${name}: family analyses not established — ${analysis.reason}`, elementId: e.id });
    } else {
      if (analysis.void) diagnostics.push({ code: VARIABILITY_CODES.void, severity: 'warning', message: `${name}: VOID — no configuration satisfies the variation structure and the selection constraints (AO10)${analysis.voidCore === null ? '' : analysis.voidCore.length === 0 ? '; the variation structure alone admits none' : `; conflicting constraints (a minimal set): ${analysis.voidCore.join(', ')}`}`, elementId: e.id });
      for (const d of analysis.dead) diagnostics.push({ code: VARIABILITY_CODES.deadVariant, severity: 'warning', message: `${name}: the variant ${d} is dead — no valid configuration selects it (AO14)${analysis.void ? '' : (w => w ? `; killed by ${w.killedBy.join(', ') || 'the variation structure'}` : '')(analysis.deadWhy.find((x) => x.variant === d))}`, elementId: e.id });
      for (const p of analysis.falseOptional) diagnostics.push({ code: VARIABILITY_CODES.falseOptional, severity: 'warning', message: `${name}: the optional point ${p} is selected in every valid configuration (AO15)`, elementId: e.id });
      diagnostics.push({ code: VARIABILITY_CODES.family, severity: 'info', message: `${name}: ${analysis.exact ? '' : 'at most '}${analysis.valid} valid configuration(s) of ${analysis.structural} structural (AO12)`, elementId: e.id });
    }
    const completeCfgs = new Map<string, { name: string; sel: Sel }>();
    const cfgReports = configurations(model, e, f, diagnostics, breaksOf, completeCfgs);
    const evaluations = evaluateFamily(model, e, f, rows, f.valid === null ? new Map() : completeCfgs, diagnostics, name);
    const behaviour = behaviourOf(model, e, f, name, diagnostics);
    owners.push({ id: e.id, name, status: 'read', reasons: [], points, constraints: rows, analysis, configurations: cfgReports, evaluations, behaviour });
  }
  const count = (s: VariabilitySeverity): number => diagnostics.filter((d) => d.severity === s).length;
  const verdict = verdictOf(owners);
  return { owners, diagnostics, summary: { errors: count('error'), warnings: count('warning'), infos: count('info') }, cap: VARIABILITY_CAP, verdict, exitCode: exitCodeOf(owners, verdict) };
}

/**
 * The verdict figures. A dead variant and a false-optional point are findings
 * (warnings) and are deliberately NOT counted here: they say something about
 * the family's design, not that a configuration is wrong, so they never move
 * the exit code.
 */
function verdictOf(owners: OwnerReport[]): VariabilityVerdictCounts {
  const v: VariabilityVerdictCounts = { holds: 0, invalid: 0, violated: 0, connectionBroken: 0, voidFamilies: 0, configurationViolated: 0, undecided: 0 };
  for (const o of owners) {
    if (o.status === 'not-read' || o.analysis === null) {
      v.undecided++;
      continue;
    }
    v.connectionBroken += o.analysis.connectionBroken.length;
    if (!o.analysis.established) v.undecided++;
    else if (o.analysis.void) v.voidFamilies++;
    if (!o.points.some((p) => p.configurable)) v.undecided++;
    v.undecided += o.constraints.filter((c) => !c.read).length;
    for (const ev of o.evaluations) {
      if (ev.verdict === 'violated') v.configurationViolated++;
      // an unread constraint is already counted undecided above; a requirement is counted here
      else if (ev.verdict === 'undecided' && ev.kind === 'requirement') v.undecided++;
    }
    for (const c of o.configurations) {
      if (c.connectionBroken !== undefined) v.connectionBroken++;
      else if (c.status === 'holds') v.holds++;
      else if (c.status === 'invalid') v.invalid++;
      else if (c.status === 'violated') v.violated++;
      else v.undecided++; // partial, not-evaluated, holds-over-read-constraints
    }
  }
  return v;
}

/** 1 (a decided negative) outranks 2 (something undecided), as in the other judging contracts. */
function exitCodeOf(owners: OwnerReport[], v: VariabilityVerdictCounts): 0 | 1 | 2 {
  if (owners.length === 0) return 2;
  if (v.invalid + v.violated + v.connectionBroken + v.voidFamilies + v.configurationViolated > 0) return 1;
  return v.undecided > 0 ? 2 : 0;
}

/* ─────────────────────────── state machines per configuration (V6) ─────────────────────────── */

/**
 * SysML v2 §7.17 (state usages, `exhibit state`, variation states) with §7.12 variation: a configuration
 * selects one variant per active point, and the machines of the configured part are those of the point (the same
 * in every configuration) plus those the selected variants own or are typed by. A machine the point types or owns
 * outside every variant is walked once. A machine a variant brings (inside it, or through its type) is walked once
 * and reported for the configurations that select the variant. Where a variant adds states or transitions outside a
 * machine of its own, redefines a state or transition, or is itself a state (a variant of a variation state), the
 * selection is not applied to a machine: the walk stays on the superset and an info says so. The walk is `reach`'s:
 * a walk that is not exhaustive claims nothing (no state is called unreachable or reachable).
 */
function nearestVariant(model: Model, e: ElementRecord): ElementRecord | undefined {
  let o = e.ownerId !== null ? model.get(e.ownerId) : undefined;
  while (o) {
    if (isVariantUsage(o)) return o;
    o = o.ownerId !== null ? model.get(o.ownerId) : undefined;
  }
  return undefined;
}

/** The machines an element's types (and their generals) own. */
function typeMachines(model: Model, el: ElementRecord): ElementRecord[] {
  const out = new Map<string, ElementRecord>();
  const seen = new Set<string>();
  for (const t of model.typesOf(el.id)) {
    for (const d of [t, ...generalizationsOf(model, t.id)]) {
      if (seen.has(d.id) || isLibrary(d)) continue;
      seen.add(d.id);
      for (const m of stateMachinesIn(model, d.id)) out.set(m.id, m);
    }
  }
  return [...out.values()];
}

const STATEISH = new Set(['StateUsage', 'StateDefinition', 'TransitionUsage', 'ExhibitStateUsage']);

function behaviourOf(model: Model, owner: ElementRecord, f: Formula, ownerName: string, diags: VariabilityDiagnostic[]): OwnerBehaviour {
  const result: OwnerBehaviour = { machines: [], supersetOnly: [] };
  const vkey = new Map<string, { key: string; name: string }>();
  for (const p of f.points) for (const v of p.variants) vkey.set(v.key.split('/')[1], { key: v.key, name: `${p.name}::${v.name}` });
  const fixed = new Map<string, ElementRecord>();
  for (const m of typeMachines(model, owner)) fixed.set(m.id, m);
  for (const m of stateMachinesIn(model, owner.id)) if (nearestVariant(model, m) === undefined) fixed.set(m.id, m);
  for (const p of f.points) {
    const el = model.get(p.id);
    if (el) for (const m of typeMachines(model, el)) fixed.set(m.id, m);
  }
  const bringers = new Map<string, { rec: ElementRecord; keys: Set<string>; names: Set<string> }>();
  const supersetWhy = (v: ElementRecord, name: string): void => {
    const why: string[] = [];
    const mine = (e: ElementRecord): boolean => nearestVariant(model, e)?.id === v.id;
    if (v.eClass === 'StateUsage') why.push('the variant is itself a state of a variation state');
    const ownMachines = stateMachinesIn(model, v.id).filter(mine);
    const inOwn = (e: ElementRecord): boolean => ownMachines.some((m) => m.id === e.id || model.ancestors(e.id).some((a) => a.id === m.id));
    const extra = model.descendants(v.id).filter((e) => !isLibrary(e) && STATEISH.has(e.eClass) && mine(e) && !inOwn(e));
    if (extra.length > 0) why.push(`it adds ${extra.length > 1 ? 'states or transitions' : 'a state or transition'} (${[...new Set(extra.map((e) => e.declaredName ?? e.eClass))].slice(0, 4).join(', ')}) outside a machine of its own`);
    const redef = model.descendants(v.id).filter((e) => STATEISH.has(e.eClass) && mine(e) && rels(model, e.id, 'Redefinition').length > 0);
    if (redef.length > 0) why.push(`it redefines ${[...new Set(redef.map((e) => e.declaredName ?? e.eClass))].slice(0, 4).join(', ')}`);
    for (const rel of ['Subsetting', 'Redefinition']) {
      for (const t of targets(model, v.id, rel)) {
        if (!isLibrary(t) && (typeMachines(model, t).length > 0 || stateMachinesIn(model, t.id).length > 0)) why.push(`it ${rel === 'Subsetting' ? 'subsets' : 'redefines'} ${t.declaredName ?? 'a usage'}, which owns a machine`);
      }
    }
    if (why.length > 0) result.supersetOnly.push({ variant: name, why: why.join('; ') });
  };
  for (const [vid, info] of vkey) {
    const v = model.get(vid);
    if (!v || isLibrary(v)) continue;
    supersetWhy(v, info.name);
    for (const m of [...typeMachines(model, v), ...stateMachinesIn(model, v.id).filter((x) => nearestVariant(model, x)?.id === v.id)]) {
      if (fixed.has(m.id)) continue;
      if (rels(model, m.id, 'Redefinition').length > 0 || generalizationsOf(model, m.id).some((g) => fixed.has(g.id))) {
        result.supersetOnly.push({ variant: info.name, why: `its type brings the machine ${m.declaredName ?? ''} that redefines or specialises one the point has` });
        continue;
      }
      const b = bringers.get(m.id) ?? { rec: m, keys: new Set<string>(), names: new Set<string>() };
      b.keys.add(info.key);
      b.names.add(info.name);
      bringers.set(m.id, b);
    }
  }
  const total = f.valid === null ? null : f.valid.length;
  const walk = (m: ElementRecord): { conclusive: boolean; why?: string; unreachable: string[]; dead: string[] } => {
    const mr = reachReport(model, { scopeId: m.id }).machines.find((x) => x.machine.id === m.id);
    if (!mr) return { conclusive: false, why: 'the machine was not read by the walk', unreachable: [], dead: [] };
    if (mr.unsupported.length > 0) return { conclusive: false, why: 'the walk refuses a construct in it', unreachable: [], dead: [] };
    if (!mr.exhaustive) return { conclusive: false, why: mr.boundHit !== 'none' ? `the walk hit its ${mr.boundHit} bound` : 'the walk could not decide every guard', unreachable: [], dead: [] };
    return { conclusive: true, unreachable: mr.states.unreachable.map((s) => s.name), dead: mr.transitions.dead.map((t) => t.name || t.qualifiedName) };
  };
  const emit = (b: MachineBehaviour): void => {
    result.machines.push(b);
    const superset = b.variants.length === 0 && result.supersetOnly.length > 0;
    const all = b.variants.length === 0 || (b.presentIn !== null && b.presentIn === b.total);
    const where = superset ? 'analysed on the superset only (a variant below changes behaviour)' : b.variants.length === 0 ? 'the same in every configuration (no variant adds or redefines it), walked once' : `present only in the configurations selecting ${b.variants.join(' or ')}${b.presentIn !== null && b.total !== null ? ` (${b.presentIn} of ${b.total})` : ''}`;
    const found = b.unreachable.length > 0 || b.dead.length > 0;
    const detail = !b.conclusive
      ? `inconclusive (${b.why}): no state is claimed reachable or unreachable`
      : found
        ? `${b.unreachable.length > 0 ? `unreachable state(s) ${b.unreachable.join(', ')}` : ''}${b.unreachable.length > 0 && b.dead.length > 0 ? '; ' : ''}${b.dead.length > 0 ? `dead transition(s) ${b.dead.join(', ')}` : ''} — ${superset ? 'on the superset; a configuration that adds or redefines behaviour may differ' : `dead in every configuration${all ? '' : ' that has it; in the others the machine does not exist'}`}`
        : superset ? 'every state reachable and no transition dead on the superset; no per-configuration claim' : 'every state reachable and no transition dead';
    const dead = found && b.conclusive && !superset;
    diags.push({ code: dead ? VARIABILITY_CODES.behaviourDead : VARIABILITY_CODES.behaviour, severity: dead ? 'warning' : 'info', message: `${ownerName}: the state machine ${b.machine} is ${where}: ${detail}`, elementId: owner.id });
  };
  if (fixed.size > 0 && vkey.size > 0) {
    for (const m of fixed.values()) emit({ machine: model.qualifiedName(m.id) || m.declaredName || m.id, variants: [], presentIn: total, total, ...walk(m) });
  }
  for (const b of bringers.values()) {
    let presentIn: number | null = null;
    if (f.valid !== null) presentIn = f.valid.filter((sel) => [...sel.values()].some((k) => k !== null && b.keys.has(k))).length;
    emit({ machine: model.qualifiedName(b.rec.id) || b.rec.declaredName || b.rec.id, variants: [...b.names], presentIn, total, ...walk(b.rec) });
  }
  for (const s of result.supersetOnly) {
    diags.push({ code: VARIABILITY_CODES.behaviour, severity: 'info', message: `${ownerName}: the variant ${s.variant} changes behaviour (${s.why}): behaviour analysed on the superset only — the selection is not applied to a state machine, so no per-configuration reachability is claimed`, elementId: owner.id });
  }
  return result;
}

/* ───────────────────────────────── rendering ───────────────────────────── */

const STATUS_WORD: Record<ConfigurationStatus, string> = {
  invalid: 'INVALID',
  'not-evaluated': 'NOT EVALUATED',
  partial: 'PARTIAL',
  holds: 'HOLDS',
  'holds-over-read-constraints': 'HOLDS (over the constraints read)',
  violated: 'VIOLATED',
};

export function variabilityLines(r: VariabilityReport, name: string): string[] {
  const out: string[] = [];
  out.push(`${name}: ${r.owners.length} variability owner(s) — ${r.summary.errors} error(s), ${r.summary.warnings} warning(s), ${r.summary.infos} info`);
  if (r.owners.length === 0) out.push('  no variation point in this file: nothing to configure');
  for (const o of r.owners) {
    out.push('', `${o.name}`);
    if (o.status === 'not-read') {
      out.push('  NOT READ:', ...o.reasons.map((x) => `    ${x}`));
      continue;
    }
    for (const p of o.points) {
      out.push(
        `  point ${p.name}${p.optional ? ' [0..1]' : ''}${p.viaDefinition ? ` (variants from ${p.viaDefinition})` : ''}: ${p.variants.map((v) => v.name).join(' | ') || 'NO VARIANTS — cannot be configured, left out'}` +
          (p.activatedBy ? `  active only when ${vname(o.points, p.activatedBy)}` : '') +
          (p.sharedAcrossInstances ? '  (one shared choice for every instance)' : ''),
      );
    }
    for (const c of o.constraints) out.push(`  constraint ${c.name}: ${c.read ? 'read' : `NOT READ — ${c.reason}`}`);
    const a = o.analysis!;
    if (!a.established) out.push(`  family: not established — ${a.reason}`);
    else {
      out.push(`  family: ${a.void ? 'VOID (no valid configuration)' : `${a.exact ? '' : 'at most '}${a.valid} valid of ${a.structural} structural`}`);
      if (a.excludedPoints.length > 0) out.push(`    ranging over the points that can be configured; left out: ${a.excludedPoints.join(', ')}`);
      out.push(`    core variants: ${a.core.join(', ') || 'none'}`, `    dead variants: ${a.dead.join(', ') || 'none'}`, `    false-optional: ${a.falseOptional.join(', ') || 'none'}`);
      if (a.connectionBroken.length > 0) {
        out.push(`    CONNECTION BROKEN in ${a.connectionBroken.length} valid configuration(s) (counted in \`valid\`: that figure answers the constraint question only):`);
        for (const b of a.connectionBroken.slice(0, 20)) out.push(`      ${b.configuration}: ${b.connector} — ${b.why}`);
      }
      if (!a.exact) out.push('    (constraints not read: the count is an upper bound; dead, core and void remain sound)');
      for (const c of a.configurations) out.push(`    - ${c.join(', ')}`);
    }
    if (a.void && a.voidCore !== null) out.push(`    void explained: ${a.voidCore.length === 0 ? 'the variation structure alone admits no configuration' : `conflicting constraints (minimal): ${a.voidCore.join(', ')}`}`);
    for (const d of a.deadWhy) if (!a.void) out.push(`    dead ${d.variant}: killed by ${d.killedBy.join(', ') || 'the variation structure'}`);
    for (const ev of o.evaluations) {
      out.push(`  ${ev.kind} ${ev.name}: every configuration ${ev.verdict === 'holds' ? 'HOLDS' : ev.verdict === 'violated' ? 'is NOT satisfied (VIOLATED in ' + ev.violated + ')' : 'is undecided'} — ${ev.coverage}; ${ev.holds} holds, ${ev.violated} violated, ${ev.undecided} undecided${ev.qualified ? ' (constraints not read could exclude a violating configuration)' : ''}`);
      for (const it of ev.items.slice(0, 20)) out.push(`    ${it.word}  ${it.configuration}${it.values.length > 0 ? ` — ${it.values.join(', ')}` : ''}${it.reason ? ` — ${it.reason}` : ''}`);
    }
    for (const m of o.behaviour.machines) out.push(`  machine ${m.machine}: ${m.variants.length === 0 ? 'same in every configuration' : `only with ${m.variants.join(' or ')}${m.presentIn !== null && m.total !== null ? ` (${m.presentIn} of ${m.total})` : ''}`} — ${m.conclusive ? (m.unreachable.length + m.dead.length === 0 ? 'every state reachable, no dead transition' : `unreachable: ${m.unreachable.join(', ') || 'none'}; dead: ${m.dead.join(', ') || 'none'}`) : `inconclusive (${m.why})`}`);
    for (const s of o.behaviour.supersetOnly) out.push(`  behaviour analysed on the superset only: variant ${s.variant} — ${s.why}`);
    for (const c of o.configurations) {
      out.push(`  configuration ${c.name}: ${STATUS_WORD[c.status]}`);
      // The status above answers the selection constraints only. When this named configuration's
      // selection is one the per-configuration evaluation found VIOLATED, say so beside it: a bare
      // HOLDS next to a violated constraint would read as the configuration satisfying it.
      const picked = c.selections.map((s) => s.text.replace(/^:>>\s*/, '')).sort().join(', ');
      for (const ev of o.evaluations) {
        for (const it of ev.items) {
          if (it.word !== 'VIOLATED') continue;
          const cfg = it.configuration.split(', ').sort().join(', ');
          if (picked !== '' && cfg === picked) out.push(`    VIOLATES ${ev.kind} ${ev.name}${it.values.length > 0 ? ` — ${it.values.join(', ')}` : ''} (its selection is valid; the configuration does not satisfy it)`);
        }
      }
      for (const s of c.selections) out.push(`    ${s.status}  ${s.text} — ${s.reason}`);
      if (c.missing.length > 0 && c.status === 'partial') out.push(`    missing: ${c.missing.join(', ')}`);
      if (c.completes !== undefined) out.push(`    completes: ${c.completes ? `yes, e.g. ${c.completion!.join(', ')}` : `NO (${c.blockedBy!.join(', ')})`}`);
      if (c.forced) out.push(`    forced: ${c.forced.join(', ') || 'nothing'}`);
      if (c.violated) out.push(`    violated: ${c.violated.join(', ')}`);
      for (const b of c.connectionBroken ?? []) out.push(`    CONNECTION BROKEN: ${b.connector} — ${b.why}`);
      if (c.note) out.push(`    ${c.note}`);
    }
  }
  if (r.diagnostics.length > 0) out.push('', ...r.diagnostics.map((d) => `  ${d.severity.padEnd(7)} ${d.code}  ${d.message}`));
  return out;
}
