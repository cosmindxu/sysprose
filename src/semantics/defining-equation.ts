/**
 * The defining equation of a feature that states no value (CV-17):
 * `attribute est; assert constraint { est == a * b / c }` gives `est` the value
 * of the right-hand side.
 *
 * It lives apart from both evaluators because both read it: the scalar scope in
 * {@link ./evaluate-model} and the quantity scope in {@link ./units-eval}, which
 * imports nothing from the former. Two copies of the rule were two chances to
 * let one scope read an equation as a definition that the other reads as a
 * check — the same model then fixed a value on one path and not on the other.
 *
 * The rule has three parts, all here:
 *  - WHICH equations may define a name, and in what order
 *    ({@link definingEquationsFor});
 *  - which of them DOES, when a derivation is under way
 *    ({@link chooseDefinition}): the first that gives the name a value — one
 *    that would lead back to a feature already being derived never does;
 *  - how deep definitions may nest ({@link MAX_DERIVATION_DEPTH}).
 *
 * It is also where every scope reads NAMES ({@link DefiningEquations.scope}):
 * the one walk the scalar, the quantity and the variable scope share, which
 * ./relations cannot host (it reads the unit-aware evaluator, which reads this
 * module) — and with it what a name's VALUE is in a context: what each name
 * denotes ({@link DefiningEquations.denote}), the feature a redefinition that
 * states nothing reads ({@link DefiningEquations.carrier}), whether a value
 * written elsewhere is the same there ({@link DefiningEquations.sameIn}), the
 * binding a redefinition contradicts ({@link contradictedBindingOf}), two
 * values a context inherits under one name ({@link DefiningEquations.clash}),
 * the contexts a requirement's subject is bound in ({@link
 * DefiningEquations.satisfaction}), and the names a body declares itself
 * ({@link shadowedNamesOf}).
 */

import { type AttrValue, type ElementId, type ElementRecord, type Model, TEXTUAL_KEYWORD, isDefinition, isTypingSpecialization, isUsage } from '@core/index';
import {
  effectiveFeatures,
  effectiveNameOf,
  effectiveQualifiedName,
  generalizationsOf,
  inheritedNameClashes,
  maskedByName,
  ownFeatures,
  redefinedClosure,
} from './inheritance';
import { resolveFullName } from './bind';
import { type ExprNode } from './expr';
import { isKindOf } from './metaclasses';
import { decimalRational, scaleRational, type Rational } from './smt/encode';
import { NO_MARKERS, parseRelationBody, type MarkerDimensions } from './unit-literals';
import { DIMENSIONLESS, dimEqual, divideDim, multiplyDim, resolveUnit, type Dimension } from './units';

/** An asserted equation that may define a name: `name == <expr>`, or `<expr> == name`. */
export interface DefiningEquation {
  constraint: ElementRecord;
  /** The side that defines the name — the other one. */
  definition: ExprNode;
  /** True when the name is the LEFT side: the CV-17 form `name == <expr>`. */
  left: boolean;
  /**
   * The `[unit]` literals the equation carries, lowered: `definition` reads a
   * marker name for each ({@link ./unit-literals}). Empty for a body without.
   */
  literals: MarkerDimensions;
}

const SHADOWED = new WeakMap<DefiningEquation, readonly string[]>();

/**
 * The names an equation reads that its constraint declares itself while its
 * owner's scope resolves them to another feature ({@link shadowedNamesOf}) —
 * `[]` for nearly every one. Such an equation is a REFUSED definition: the
 * feature it defines reads no value on any surface, and is no design freedom
 * either. Asked where a definition is READ, never while the equations are
 * gathered: the test reads the owner's scope, whose walk reads the equations.
 */
export function shadowedEquation(model: Model, eq: DefiningEquation): readonly string[] {
  let hit = SHADOWED.get(eq);
  if (!hit) {
    const whole = equationOf(eq.constraint);
    hit = whole ? shadowedNamesOf(model, eq.constraint, refsIn(whole.node, whole.literals)) : [];
    SHADOWED.set(eq, hit);
  }
  return hit;
}

/**
 * Every asserted equation `name == <expr>` (either way round) among the
 * constraints `ownerId` owns, in the order a derivation tries them: those with
 * the name on the LEFT — the CV-17 form, the one an author writes as a
 * definition — first, then those with it on the right; each in declaration
 * order.
 *
 * Declaration order alone decided before, and on either side: `assert
 * constraint { b == a }` written above `assert constraint { a == x0 * 2.0 }`
 * read the alias as `a`'s definition, so `a` was derived from `b`, `b` from
 * `a`, and both were refused as the loop "a → b → a" — swap the two lines and
 * a = b = 2 m. Two equations that fix the same name to DIFFERENT values
 * (`x == 1.0` and `2.0 == x`) are a model at odds with itself; the one that
 * defines is the first in this order that gives a value — so `x == 1.0` in
 * either order — and the other is judged against it, and violated. Where two
 * give it values that differ, or that this tool cannot compare (an equation
 * over other names that may give it a value among them), no surface that
 * judges a relation reads either, nor any relation over the name ({@link
 * contradictedDefinitions}): which comes first would decide its verdicts.
 */
export function definingEquationsFor(model: Model, ownerId: ElementId, name: string): DefiningEquation[] {
  return equationsByName(model, ownerId).get(name) ?? [];
}

/** The first of {@link definingEquationsFor}: whether a name has a defining equation at all. */
export function definingEquationFor(model: Model, ownerId: ElementId, name: string): DefiningEquation | undefined {
  return definingEquationsFor(model, ownerId, name)[0];
}

/** {@link definingEquationsFor} for every name at once: one parse of each constraint `ownerId` owns. */
function equationsByName(model: Model, ownerId: ElementId): Map<string, DefiningEquation[]> {
  const left = new Map<string, DefiningEquation[]>();
  const right = new Map<string, DefiningEquation[]>();
  const add = (into: Map<string, DefiningEquation[]>, name: string, e: DefiningEquation) => {
    const list = into.get(name);
    if (list) list.push(e);
    else into.set(name, [e]);
  };
  for (const c of model.children(ownerId)) {
    if (!isAsserted(c)) continue;
    const eq = equationOf(c);
    if (!eq) continue;
    const { node, literals } = eq;
    // A DOTTED defined name (`assert constraint { p.x == 3.0 }`) indexes under
    // the whole path; a single-segment ref is the bare name it always was.
    const l = definedName(node.left, literals);
    const r = definedName(node.right, literals);
    if (l !== undefined) add(left, l, { constraint: c, definition: node.right, left: true, literals });
    if (r !== undefined && r !== l) add(right, r, { constraint: c, definition: node.left, left: false, literals });
  }
  for (const [name, list] of right) {
    const first = left.get(name);
    if (first) first.push(...list);
    else left.set(name, list);
  }
  // No asserted equation defines a name that denotes, where it is written, a feature that writes a
  // `default` (decision 14 amended 2026-10-22, {@link writesStandingDefault}): it is checked against that
  // default, or against what a binding gives the feature, as against a value written with `=`.
  for (const name of [...left.keys()]) {
    const f = featureNamedBelow(model, ownerId, name);
    if (f !== undefined && writesStandingDefault(model, f)) left.delete(name);
  }
  return left;
}

/** The feature a bare or dotted `name` names below `ownerId`, segment by segment by effective name — or `undefined`. */
function featureNamedBelow(model: Model, ownerId: ElementId, name: string): ElementRecord | undefined {
  let cur = ownerId;
  let f: ElementRecord | undefined;
  for (const segment of name.split('.')) {
    f = [...ownFeatures(model, cur), ...effectiveFeatures(model, cur)].find((h) => effectiveNameOf(model, h) === segment);
    if (!f) return undefined;
    cur = f.id;
  }
  return f;
}

/**
 * How a scope admits a name: `value` — the scopes that read VALUES (the
 * scalar scope of ./evaluate-model, the quantity scope of ./units-eval) map a
 * name to the feature whose value it reads, read where the context the name
 * is read in needs it read ({@link DefiningEquations.valueRef}), and a name
 * with no value to read to nothing; `all` — the scope that names VARIABLES
 * (`idScopeFor` of ./relations: the gates, the solver's names, the
 * verification lane's symbols) maps every named feature. Which feature a name
 * DENOTES is the same in both: one walk ({@link DefiningEquations.scope}).
 */
export type ScopeAdmission = 'value' | 'all';

const BEHAVIOUR = new Map<string, boolean>();

/**
 * Is `f` a feature whose own features are a BODY's — a behaviour's — and never
 * a bare name of the scope that encloses it ({@link DefiningEquations.scope})?
 * Every kind of action usage: a constraint's or a requirement's parameters and
 * locals, a calculation's or a case's, and an action's, a state's, a
 * transition's, a performed action's — `perform action deliver : Deliver { in
 * payload = 5.0; }` answered the bare `payload` of the part around it, so
 * `payload <= maxPayload` was refuted at a parameter's 5.
 */
function ownsBody(f: ElementRecord): boolean {
  let hit = BEHAVIOUR.get(f.eClass);
  if (hit === undefined) {
    hit = isKindOf(f.eClass, 'ActionUsage');
    BEHAVIOUR.set(f.eClass, hit);
  }
  return hit;
}

/**
 * Is `f` a DIRECTED feature — a parameter, `in`, `out` or `inout`? Its value is
 * what a call, a port's connection or a flow puts there, never a bare name of
 * the scope around its owner: `port pwr { in attribute voltage = 12.0; }` made
 * `voltage <= 5.0` of the part refuted at 12.
 */
function isDirected(f: ElementRecord): boolean {
  const direction = f.attrs.direction;
  return direction === 'in' || direction === 'out' || direction === 'inout';
}

/**
 * What a name denotes in a scope ({@link DefiningEquations.denote}): the
 * feature, the context it is read in — the scope's root for a direct name,
 * else the usage on the chain whose effective feature it is — and whether it
 * lies below a calculation with a parameter.
 *
 * `instance` is WHICH instance of the reader the name is read in: the path of
 * usages from the scope's root, spelled as a qualified name (`R::q1::p` for
 * `q1.p.load` read in R, where `p` is Q's part and the reader `Q::p` itself).
 * Two usages of one type are two instances, whose features are each their own
 * value ({@link DefiningEquations.symbolOf}). A requirement's subject that
 * nothing binds, read where the requirement is the scope's root, is the
 * GENERIC instance of its type — the requirement is about any one — and a
 * subject something binds is the instance it is bound to, `satisfy R by
 * q1.p` q1's p.
 *
 * `enclosing` is every instance the walk passed through on the way to
 * `instance`, outermost first — the scope's root included — each with the
 * context its features are read in: `R` (read in R) and `R::s` (read in `s`)
 * for `s.q.load` read in R over `part s : Sys`. Each is an instance of its
 * own types, whose asserts and bindings constrain what lies below it (Sys's
 * `bind p.load = q.load` is a fact of `R::s::q`'s load as much as P's own
 * asserts are).
 */
export interface Denotation {
  feature: ElementRecord;
  reader: ElementId;
  inCall: boolean;
  instance: string;
  enclosing: readonly InstanceFrame[];
}

/** One instance a walk is in ({@link Denotation}): its path, and the context its features are read in. */
export interface InstanceFrame {
  instance: string;
  reader: ElementId;
}

/**
 * Where a name's VALUE is read ({@link DefiningEquations.valueRef}): the
 * feature whose value it is, and — when that value reads something the
 * reading context changes — the context it is read IN, rather than where it
 * is written.
 */
export interface ValueRef {
  target: ElementRecord;
  at?: ElementId;
}

/**
 * A name read through an instance of its own ({@link
 * DefiningEquations.instanceReadings}): its symbol, the instance (`R::p`),
 * the context the walk read it in, the feature whose value it reads, and
 * where that value is read when not where it is written.
 */
export interface InstanceReading {
  symbol: string;
  instance: string;
  reader: ElementId;
  /** The instances that enclose `instance` on the walk ({@link Denotation}), re-rooted as `instance` is. */
  enclosing: readonly InstanceFrame[];
  /** The feature the variable scope maps the path to ({@link DefiningEquations.carrier}). */
  feature: ElementRecord;
  target: ElementRecord;
  at?: ElementId;
}

/**
 * A `satisfy`, the subject of a requirement usage a value binds, or a
 * reference whose value resolves in an element around it, read at the values
 * of the element its path is resolved in while an instance of that element
 * reads it otherwise ({@link DefiningEquations.satisfierOtherwise}, {@link
 * DefiningEquations.referenceOtherwise}); or a usage that subsets a feature
 * an instance reads otherwise (`part p2 :> p1;`, {@link
 * DefiningEquations.subsettingOtherwise}), and a `satisfy` or a subject read
 * through one (`via`).
 */
export interface ReadOtherwise {
  /**
   * `valueless`: a reference redefinition that states no value of the valued
   * reference it redefines (`ref part :>> r;` over `ref part r : T0 = x`),
   * which the walk reads as a fresh instance of its type, never as what `x`
   * names ({@link satisfierTaint}). `subsetting`: a usage that subsets a
   * feature an instance reads otherwise (`part p2 :> p1;` in W beside w's
   * `part :>> p1 { … }`), which the walk reads as the element's own, never
   * as one of what that instance's feature is ({@link
   * DefiningEquations.subsettingOtherwise}).
   */
  kind: 'satisfy' | 'subject' | 'reference' | 'valueless' | 'subsetting' | 'end';
  /** The `satisfy` relationship, the requirement usage, the reference, the valueless redefinition, or the subsetting usage. */
  written: ElementRecord;
  /**
   * The element the path is resolved in, at whose own values it is read; for `valueless`, the redefinition's
   * owner; for `subsetting`, the element the subsetted feature is a feature of.
   */
  scope: ElementRecord;
  /** The path as written: the satisfier's (`top.a`), the subject's value (`p1`), the reference's value, the subsetted feature's name. */
  path: string;
  /** The context that reads it otherwise — `undefined` past a binding cap, and for `valueless`. */
  instance: ElementRecord | undefined;
  /** For `valueless`: the valued reference it redefines; for `subsetting`: the feature it subsets. */
  redefined?: ElementRecord;
  /** For `satisfy` and `subject`: the subsetting usage the satisfier is read through, where that is why ({@link subsettingTaint}). */
  via?: ReadOtherwise;
  /** For `satisfy`: written outside the definition `scope` whose feature it names, by a path not resolved where it is written. */
  outside?: true;
  /**
   * For `subsetting` read the other way ({@link DefiningEquations.subsettedOtherwise}): `written` is the subsetted
   * usage, this the usage that subsets it — the NEAREST one that is read otherwise, or that subsets what is.
   */
  subsetter?: ElementRecord;
  /** For `subsetting` read the other way, up a chain or across a usage with two supers: the usage the reading started from, when it is not {@link subsetter}. */
  root?: ElementRecord;
  /** For `subsetting`, where a subsetter that says something of its own names the subsetted usage through a path (`part q :> sub.p1 { … }`) or from outside the usage it is a feature of: `written` is that usage, this the subsetter. */
  chain?: true;
  /**
   * For `subsetting` across a usage that subsets more than one (`part u4 :> u1, u3;`) in a component one member of which
   * says something of its own: `via` is that usage, `sayer` the member that says it.
   */
  bridge?: { via: ElementRecord; sayer: ElementRecord };
  /** For `subsetting` carried up a chain or across a usage with two supers: the element whose instances read the first usage otherwise, when it is not {@link scope}. */
  reader?: ElementRecord;
}

/**
 * The defining equations one evaluation pass reads, gathered once per context
 * — with the valueless feature of each name an equation there may define — so
 * a long chain does not re-parse every constraint of its context at every
 * link; and the NAMES every scope reads, walked once per context
 * ({@link scope}). It reads the model as it is at one revision: a pass takes
 * it from {@link sharedDefinitions}, which hands out a fresh one whenever the
 * model has moved on.
 */
export class DefiningEquations {
  /** The model revision this reading is of. */
  readonly rev: number;
  private readonly equations = new Map<ElementId, Map<string, DefiningEquation[]>>();
  private readonly valueless = new Map<ElementId, Map<string, ElementRecord>>();
  private readonly named = new Map<ElementId, Map<string, ElementRecord>>();
  private readonly same = new Map<string, boolean>();
  private readonly stated = new Map<ElementId, { value: AttrValue | undefined; names?: string[] }>();
  private readonly effective = new Map<ElementId, ElementRecord[]>();
  private readonly names = new Map<ElementId, string | undefined>();
  private readonly aliases = new Map<ElementId, string[]>();
  private readonly scopes = new Map<string, Map<string, ElementId>>();
  private readonly readers = new Map<ElementId, Map<string, ElementId>>();
  private readonly qualified = new Map<ElementId, string>();
  private redefining?: ReadonlySet<ElementId>;
  private readonly pinned = new Map<string, boolean>();
  private readonly pinning = new Set<string>();
  private readonly denoted = new Map<ElementId, Map<string, Denotation>>();
  private readonly carrying = new Map<string, ElementRecord>();
  private readonly carried = new Map<string, ElementRecord>();
  private readonly contradicted = new Map<ElementId, BindingConflict | null>();
  private readonly clashes = new Map<ElementId, Map<string, NameClash>>();
  /** The clashes of a context that hold a family of features ({@link NameClash}'s `family`), per context. */
  private readonly familyClashes = new Map<ElementId, NameClash[]>();
  /** The features that redefine two at once, by feature ({@link mergedLines}), built on first ask. */
  private redefiningTwo?: Map<ElementId, ElementRecord[]>;
  /** {@link inheritedClashes} per context. */
  private readonly inherited = new Map<ElementId, Map<string, NameClash>>();
  private reportedClashes?: ReadonlyArray<{ context: ElementRecord; name: string; clash: NameClash }>;
  /** The user's binding connectors by the feature an end is, or copies ({@link boundPathsOf}). */
  private boundEnds?: Map<ElementId, Array<{ binding: ElementRecord; other: ElementId }>>;
  /** The {@link sameIn} questions being asked, and whether one was answered by a guess meanwhile. */
  private readonly asking = new Set<string>();
  private guessed = false;
  private bound?: ReadonlySet<ElementId>;
  /** The elements that own a binding the editor parted from a copy ({@link partedHolder}), once asked. */
  private parted?: ReadonlySet<ElementId>;
  /** Per context, the scopes {@link partedHolder} left unread: the path they are reached by, and their owner. */
  private readonly withheldIn = new Map<ElementId, Map<string, ElementId>>();
  /** The types an owner of a binding specialises, for {@link endsInGeneral}. */
  private readonly generalIds = new Map<ElementId, ReadonlySet<ElementId>>();
  private specialised?: Map<ElementId, ElementRecord[]>;
  private satisfying?: Map<ElementId, { requirement: ElementRecord; satisfier: ElementRecord }>;
  private readonly clauseContexts = new Map<ElementId, ElementRecord[]>();
  /** {@link changingContexts} per relation and names, with those a feature-only binding reading lists too. */
  private readonly changing = new Map<string, { listed: ElementRecord[]; plain: ReadonlySet<ElementId> }>();
  /** The user elements by the instance a scope rooted at each reads its features in ({@link framesAbove}). */
  private rootsByInstance?: Map<string, ElementRecord[]>;
  /** {@link framesAbove} per instance spelling (`null`: no chain spells it). */
  private readonly above = new Map<string, readonly InstanceFrame[] | null>();
  /** The asserted relations each reader holds, with the names each reads ({@link assertsOf}). */
  private readonly asserted = new Map<ElementId, ReadonlyArray<{ expr: string; names: readonly string[] }>>();
  /** {@link anyAsserted}, once asked. */
  private anyAsserts?: boolean;
  /** {@link reachingAssert} per `${contextId} ${name}` (`null`: none). */
  private readonly reaching = new Map<string, { site: ElementId; path: string; equations: readonly DefiningEquation[] } | null>();
  /** {@link boundAbove} per context and names (`null`: none above) — every instance row of a group asks it of the usage. */
  private readonly aboveBound = new Map<string, BoundAbove | null>();
  /** {@link valuedByBinding} per context and names. */
  private readonly valuedByBindingMemo = new Map<string, boolean>();
  /** The contexts whose {@link denote} walk met {@link MAX_NAME_WALK_OWNERS} ({@link nameWalkCut}). */
  private readonly cutWalks = new Set<ElementId>();
  /** {@link lexicalNames} per context. */
  private readonly lexical = new Map<
    ElementId,
    {
      admitted: ReadonlyMap<string, Denotation>;
      refused: ReadonlyMap<string, string>;
      written: ReadonlyMap<string, readonly ElementRecord[]>;
    }
  >();
  /** The ends of the user's binding connectors and what each redefines, for {@link lexicallyUniform}. */
  private joined?: ReadonlySet<ElementId>;
  /** The implicit contexts (connector-end copies) that specialise each element, for {@link lexicallyUniform}. */
  private implicitlySpecialised?: ReadonlyMap<ElementId, readonly ElementRecord[]>;
  /** {@link assertedNames}, once asked. */
  private assertNames?: ReadonlyMap<string, ReadonlySet<ElementId>>;
  /** {@link namesWritten} per element. */
  private readonly writtenNames = new Map<ElementId, ReadonlyMap<string, readonly ElementRecord[]>>();
  /** The features {@link subjectScope} is resolving: a value that leads back to one of them stands for nothing. */
  private readonly resolving = new Set<ElementId>();
  /** The features {@link boundInstance} is naming the instance of, for the same guard. */
  private readonly instancing = new Set<ElementId>();
  /** {@link satisfierOtherwise} per context (`null`: read as written). */
  private readonly satisfierAsked = new Map<ElementId, ReadOtherwise | null>();
  /** {@link referenceOtherwise} per reference (`null`: read as written). */
  private readonly referenceAsked = new Map<ElementId, ReadOtherwise | null>();
  /** {@link subjectOtherwise} per subject (`null`: read as written). */
  private readonly subjectAsked = new Map<ElementId, ReadOtherwise | null>();
  /** The contexts {@link satisfierOtherwise} is answering, for its re-entry guard. */
  private readonly satisfierAsking = new Set<ElementId>();
  /** {@link subsettingOtherwise} per usage (`null`: read as written). */
  private readonly subsettingAsked = new Map<ElementId, ReadOtherwise | null>();

  constructor(readonly model: Model) {
    this.rev = model.rev;
  }

  /** {@link definingEquationsFor}. */
  of(contextId: ElementId, name: string): readonly DefiningEquation[] {
    let byName = this.equations.get(contextId);
    if (!byName) {
      byName = equationsByName(this.model, contextId);
      this.equations.set(contextId, byName);
    }
    return byName.get(name) ?? [];
  }

  /** {@link effectiveFeatures}, once per context. */
  features(contextId: ElementId): readonly ElementRecord[] {
    let hit = this.effective.get(contextId);
    if (!hit) {
      // A `satisfy R by x` is a context with R's features ({@link satisfaction}).
      const satisfied = this.satisfaction(contextId);
      hit = effectiveFeatures(this.model, satisfied ? satisfied.requirement.id : contextId);
      this.effective.set(contextId, hit);
    }
    return hit;
  }

  /**
   * What a `satisfy R by x` relationship states, read as a CONTEXT: a usage of
   * R whose subject is x — KerML's SatisfyRequirementUsage. `undefined` for
   * any other element, and for a satisfier that does not conform to the type
   * of R's subject (it is no instance of what R constrains). R's clauses are
   * read there with the subject standing for x ({@link subjectOf}), so `s.load
   * <= 10.0` in `requirement def R { subject s : P; }` is read at `p`'s load,
   * not P's: proved at P's values while p — `:>> load = 50.0` over a
   * `default` — breaks it was a false proof. The satisfier is the feature
   * its path names where the `satisfy` is written: an instance's own
   * redefinition of the feature the relationship records ({@link
   * writtenSatisfier}) — `satisfy RF by p1` in `part w : W { part :>> p1 {
   * attribute :>> load = 50.0; } }`, or `satisfy RF by w.p1` — whose 50 W's
   * own p1 (1) stood for.
   */
  satisfaction(contextId: ElementId): { requirement: ElementRecord; satisfier: ElementRecord } | undefined {
    if (!this.satisfying) {
      const out = new Map<ElementId, { requirement: ElementRecord; satisfier: ElementRecord }>();
      for (const rel of this.model.ofKind('Satisfy')) {
        if (rel.attrs.isLibrary === true) continue;
        const requirement = rel.target?.[0] !== undefined ? this.model.get(rel.target[0]) : undefined;
        const recorded = rel.source?.[0] !== undefined ? this.model.get(rel.source[0]) : undefined;
        if (!requirement || !recorded) continue;
        const satisfier = writtenSatisfier(this.model, rel, recorded) ?? recorded;
        const subject = effectiveFeatures(this.model, requirement.id).find((f) => f.attrs.requirementRole === 'subject');
        const type = subject ? this.model.typesOf(subject.id)[0] : undefined;
        if (!type) continue;
        const conforms =
          satisfier.id === type.id || generalizationsOf(this.model, satisfier.id).some((g) => g.id === type.id);
        if (conforms) out.set(rel.id, { requirement, satisfier });
      }
      this.satisfying = out;
    }
    return this.satisfying.get(contextId);
  }

  /**
   * The feature a SUBJECT stands for, where something binds it: in a
   * `satisfy R by x` context ({@link satisfaction}), x; and where the subject
   * is bound by value — `requirement r : R { subject s = p; }`, `subject s : P
   * = p` — the feature `p` names, resolved outward from where the subject is
   * written. A chain through the subject reads through that feature, as SysML
   * reads it: `s.m2` IS `p.m2`, never P's own. `undefined` for any other
   * feature, and for a subject bound to nothing this walk resolves.
   */
  subjectOf(contextId: ElementId, f: ElementRecord): ElementRecord | undefined {
    return this.subjectScope(contextId, f)?.feature;
  }

  /**
   * {@link subjectOf}, with WHERE the value it stands for was resolved: the
   * `scope` — the first namespace outward from where the value is written in
   * which its `path` resolves (`s` in `part p : P { ref part :>> r = s; }`
   * written in Q is Q's `s`, resolved in Q), or the context `f` is read in
   * where that is an instance of the element the value is written in and the
   * path is below it ({@link referencedIn}) — or no scope for a `satisfy R by
   * x`'s subject, whose satisfier is no name resolved anywhere. The coverage
   * guard re-resolves `path` in the instance that plays `scope`'s part
   * ({@link instanceReadsOtherwise}).
   *
   * What `f` lands on may stand for another feature in turn — a reference to
   * a part a binding equates (`ref part r = pp` over `bind pp = top.a`), a
   * reference to a reference, a `satisfy R by pp` — and it is read on to the
   * last ({@link standsIn}, one step each), as SysML reads it: `r.load` is
   * top's a's load, never pp's own. Such a feature is answered with no
   * `scope`: the guard cannot re-resolve a path of two steps, and says so.
   * A value that leads back to `f` stands for nothing.
   */
  subjectScope(
    contextId: ElementId,
    f: ElementRecord,
  ): { feature: ElementRecord; scope?: ElementId; path?: string } | undefined {
    if (this.resolving.has(f.id)) return undefined;
    this.resolving.add(f.id);
    try {
      const step = this.standsIn(contextId, f);
      if (!step) return undefined;
      const onward = this.subjectScope(step.reader, step.feature);
      if (onward) return { feature: onward.feature };
      return {
        feature: step.feature,
        ...(step.scope !== undefined ? { scope: step.scope } : {}),
        ...(step.path !== undefined ? { path: step.path } : {}),
      };
    } finally {
      this.resolving.delete(f.id);
    }
  }

  /**
   * Every feature {@link subjectScope} lands on from `f` read in `contextId`,
   * one step each, in order — the last the one `f` stands for — or `[]` for a
   * feature that stands for nothing. W's `ref part r2 = r1` read in `w : W {
   * ref part :>> r1 = p2; }` lands on w's r1, then p2: the taint test of an
   * unread binding reads each ({@link readsTainted}).
   */
  standsThrough(contextId: ElementId, f: ElementRecord): ElementRecord[] {
    const out: ElementRecord[] = [];
    const seen = new Set<ElementId>([f.id]);
    for (let step = this.standsIn(contextId, f); step && !seen.has(step.feature.id); step = this.standsIn(step.reader, step.feature)) {
      seen.add(step.feature.id);
      out.push(step.feature);
    }
    return out;
  }

  /**
   * One step of {@link subjectScope}: the feature `f`, read in `contextId`,
   * stands for, and the namespace that feature is read in there (`reader`:
   * the owner of the last link of the path, or the satisfier's owner) —
   * `undefined` for a feature that stands for nothing.
   */
  private standsIn(
    contextId: ElementId,
    f: ElementRecord,
  ): { feature: ElementRecord; reader: ElementId; scope?: ElementId; path?: string } | undefined {
    const subject = f.attrs.requirementRole === 'subject';
    // A part a part-valued binding equates with another, saying nothing of its
    // own (`bind pp = top.a`), stands for it as a reference does: its path is
    // resolved in the instance read, of the element the binding is written in
    // (w's own top for `part w : W { part :>> top { … } }`), and there alone.
    const equated = subject ? undefined : this.equatedPart(f, contextId);
    // A REFERENCE feature (`ref part :>> r = r1`) stands for the feature its
    // value names, exactly as a bound subject does: every chain through it
    // reads the referenced feature, so `q.r.L` is r1's 50, not R's own 1.
    if (!subject && f.attrs.isRef !== true && !equated) return undefined;
    if (subject) {
      const satisfied = this.satisfaction(contextId);
      if (satisfied) {
        const s = satisfied.satisfier;
        return { feature: s, reader: s.ownerId ?? contextId };
      }
    }
    const v = equated ? equated.path : f.attrs.value;
    if (typeof v !== 'string') return undefined;
    const path = v.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(path)) return undefined;
    const inContext = equated || subject ? undefined : this.referencedIn(contextId, f, path);
    const seen = new Set<ElementId>();
    for (
      let cur = equated ? equated.from : (inContext ?? f.ownerId);
      cur != null && !seen.has(cur);
      cur = equated || inContext !== undefined ? null : (this.model.get(cur)?.ownerId ?? null)
    ) {
      seen.add(cur);
      const end = this.chain([cur], path);
      if (end && end.feature !== f) return { feature: end.feature, reader: end.via ?? cur, scope: cur, path };
    }
    return undefined;
  }

  /**
   * The context a REFERENCE's value is resolved in when `f` is read in
   * `contextId` ({@link standsIn}): the context itself, where `f` is one of
   * its own features written in another element — that element, a usage it
   * types, one that specialises it — and the first link of `path` is a
   * feature of that element, which the context has as it is or redefined.
   * KerML evaluates a feature's value in each instance that has the feature:
   * W's `ref part pp : T0 = top.a` read in `part w : W { part :>> top { … } }`
   * is w's top's a, never W's own (V8R read 1 for w's 50). `undefined`
   * elsewhere: the value is resolved where it is written, and outward.
   */
  private referencedIn(contextId: ElementId, f: ElementRecord, path: string): ElementId | undefined {
    if (f.ownerId == null || contextId === f.ownerId) return undefined;
    const owner = this.model.get(f.ownerId);
    if (!owner || !(isUsage(owner.eClass) || isDefinition(owner.eClass))) return undefined;
    if (!this.features(contextId).includes(f)) return undefined;
    const head = path.split('.')[0]!;
    const theirs = this.byName(f.ownerId).get(head);
    const mine = this.byName(contextId).get(head);
    if (!theirs || !mine) return undefined;
    return mine.id === theirs.id || redefinedClosure(this.model, mine).some((g) => g.id === theirs.id) ? contextId : undefined;
  }

  /**
   * The partner a part-valued binding has `f` stand for ({@link equatedParts})
   * when read in `contextId`: its path, and where it is resolved — the
   * context, when `f` is a feature of the element the binding is written in
   * and the context has it among its own (that element, a usage it types, one
   * that specialises it: an instance reads its own partner), else that
   * element. `undefined` for any other feature.
   */
  equatedPart(f: ElementRecord, contextId: ElementId): { path: string; from: ElementId } | undefined {
    const hit = equatedParts(this.model).standsFor.get(f.id);
    if (!hit || contextId === hit.from || f.ownerId !== hit.from || !this.features(contextId).includes(f)) return hit;
    return { path: hit.path, from: contextId };
  }

  /**
   * The name every scope reads `f` by — {@link effectiveNameOf}: its declared
   * name, else the name of what an unnamed redefinition (`attribute :>> load
   * = 50.0`) redefines. The one name hook of the walk, of the shadowing test
   * ({@link shadowedNamesOf}) and of every value path.
   */
  nameOf(f: ElementRecord): string | undefined {
    if (f.declaredName !== undefined) return f.declaredName;
    if (!this.names.has(f.id)) this.names.set(f.id, effectiveNameOf(this.model, f));
    return this.names.get(f.id);
  }

  /** {@link effectiveQualifiedName}, once per element. */
  qualifiedNameOf(id: ElementId): string {
    let hit = this.qualified.get(id);
    if (hit === undefined) {
      hit = effectiveQualifiedName(this.model, id);
      this.qualified.set(id, hit);
    }
    return hit;
  }

  /**
   * The instance a scope rooted at `contextId` reads its own features in
   * ({@link Denotation}): the context's effective qualified name — and for a
   * `satisfy R by x` ({@link satisfaction}), the usage of R it is, named for
   * its satisfier: `P::p1::«satisfy R»`. Every Satisfy is named `«Satisfy»`
   * in its package, so two of them read R's own features — a constraint's
   * local `attribute k` — as ONE symbol, and two satisfiers each pinned to
   * its own k made the model's values "inconsistent".
   */
  instanceNameOf(contextId: ElementId): string {
    const satisfied = this.satisfaction(contextId);
    if (!satisfied) return this.qualifiedNameOf(contextId);
    const requirement = this.nameOf(satisfied.requirement) ?? this.qualifiedNameOf(satisfied.requirement.id);
    return `${this.qualifiedNameOf(satisfied.satisfier.id)}::«satisfy ${requirement}»`;
  }

  /**
   * The other names a RENAMED redefinition answers to — `attribute heavy
   * redefines load` is `load` too, as the feature it redefines is not
   * inherited beside it — or `[]`.
   */
  aliasesOf(f: ElementRecord): readonly string[] {
    let hit = this.aliases.get(f.id);
    if (!hit) {
      const own = this.nameOf(f);
      hit = [];
      for (const g of redefinedClosure(this.model, f)) {
        const n = this.nameOf(g);
        if (n !== undefined && n !== own && !hit.includes(n)) hit.push(n);
      }
      this.aliases.set(f.id, hit);
    }
    return hit;
  }

  /** The first of `contextId`'s effective features named `name` that states no value. */
  feature(contextId: ElementId, name: string): ElementRecord | undefined {
    let byName = this.valueless.get(contextId);
    if (!byName) {
      byName = new Map();
      for (const f of this.features(contextId)) {
        const n = this.nameOf(f);
        if (n && !hasStatedValue(this.model, f) && !byName.has(n)) byName.set(n, f);
      }
      this.valueless.set(contextId, byName);
    }
    return byName.get(name);
  }

  /**
   * `contextId`'s effective features by effective name, first occurrence: the
   * feature a bare name denotes there — a renamed redefinition under the names
   * it redefines too, where nothing else claims them.
   */
  byName(contextId: ElementId): ReadonlyMap<string, ElementRecord> {
    let byName = this.named.get(contextId);
    if (!byName) {
      byName = new Map();
      const features = this.features(contextId);
      for (const f of features) {
        const n = this.nameOf(f);
        if (n && !byName.has(n)) byName.set(n, f);
      }
      for (const f of features) {
        for (const n of this.aliasesOf(f)) if (!byName.has(n)) byName.set(n, f);
      }
      this.named.set(contextId, byName);
    }
    return byName;
  }

  /**
   * The name → feature-id map of a scope rooted at `contextId` — THE walk
   * every scope reads names through, the scalar, the quantity and the
   * variable scope alike: every effective feature of the context under its
   * name, and every feature below it under its dotted chain, the chain
   * descending through each USAGE on the way — its own (re)definitions first,
   * then what its types declare (`q.p.load` in `part q : Q { part :>> p {
   * attribute :>> load = 50.0; } }` is q's p's load, never Q's or P's). A name
   * maps to the feature whose value it reads ({@link carrier}): a redefinition
   * that states nothing reads the one it redefines.
   *
   * THE BARE-NAME RULE. A body reads its context's own features by their bare
   * names, and the walk offers a NESTED feature's bare name as a convenience
   * (`mass` for the subject's `s.mass`). Three rules keep the convenience from
   * ever answering a name with the wrong feature:
   *  - every DIRECT feature of the context claims its bare name, valued or not
   *    — a nested `q.x = 7.0` used to answer `x` where the context's own `x`
   *    states no value, so `x >= 5.0` was refuted at a value of q's;
   *  - a nested bare name is offered only when exactly ONE feature below the
   *    context has it — of `a.y` and `b.y`, `y` named whichever came first;
   *  - the features of a behaviour — a constraint, a requirement, a
   *    calculation, an action, a state ({@link ownsBody}) — and a directed
   *    feature, with everything below either, are never a bare name of the
   *    scope around them — `in x = 1.0` of one constraint answered the bare
   *    `x` of its siblings.
   *
   * `admission` decides only whether a name the walk resolves is MAPPED
   * ({@link ScopeAdmission}); which feature it denotes, and which names are
   * claimed, do not depend on it ({@link denote}). The map is shared: a caller
   * copies it before changing it.
   *
   * A value scope maps a name to the feature whose value it reads
   * ({@link valueRef}) — and where that value reads something the context
   * changes, it is read IN the context ({@link readAt}): P's `attribute m2 =
   * 10.0 - load` read as `p.m2`, in a `p` whose `:>> load = 50.0` overrides a
   * `default`, is p's −40, where it was read as P's 9 (a false proof) and then
   * as no value at all.
   */
  scope(contextId: ElementId, admission: ScopeAdmission): ReadonlyMap<string, ElementId> {
    const key = `${admission} ${contextId}`;
    let hit = this.scopes.get(key);
    if (!hit) {
      hit = new Map();
      const readers = new Map<string, ElementId>();
      for (const [name, d] of this.denote(contextId)) {
        if (admission === 'all') {
          hit.set(name, this.carrier(d.reader, d.feature).id);
          continue;
        }
        if (d.inCall || this.clash(d.reader, d.feature)) continue;
        if (name.includes('.') && this.clashAlong(contextId, name) !== undefined) continue;
        const ref = this.valueRef(d);
        if (!ref) continue;
        hit.set(name, ref.target.id);
        if (ref.at !== undefined) readers.set(name, ref.at);
      }
      this.scopes.set(key, hit);
      if (admission === 'value') this.readers.set(contextId, readers);
    }
    return hit;
  }

  /**
   * The context a name of the value scope rooted at `contextId` is read IN,
   * where that is not where the value it reads is written ({@link valueRef}):
   * the usage on the chain, or the context, that changes what the value
   * reads. `undefined` for a name read where its value is written.
   */
  readAt(contextId: ElementId, name: string): ElementId | undefined {
    if (!this.readers.has(contextId)) this.scope(contextId, 'value');
    return this.readers.get(contextId)?.get(name);
  }

  /**
   * Where the value a name that denotes `d` reads is read: the feature whose
   * value it is ({@link carrier}: a redefinition that states nothing reads the
   * value it redefines), and the context to read it in when that is not where
   * it is written. A value written in P and read in a context that changes
   * nothing it reads is P's own ({@link sameIn}), read once for every such
   * context; one read in a context that changes an input is that context's
   * — the expression evaluated over the context's names (KerML: a feature's
   * value is per instance). `undefined` for a feature with no value to read:
   * none stated, none it redefines, or one an asserted equation defines.
   */
  valueRef(d: Denotation): ValueRef | undefined {
    const target = this.carrier(d.reader, d.feature);
    if (target !== d.feature) return { target };
    if (this.statedValue(target) !== undefined) {
      return target.ownerId === d.reader || (this.sameIn(d.reader, target) && !this.changedByAssert(d.reader, target))
        ? { target }
        : { target, at: d.reader };
    }
    // An asserted equation that defines it answers it, not a value it redefines.
    if (this.statesOrDefines(d.reader, target)) return undefined;
    for (const g of redefinedClosure(this.model, target)) {
      // Nor a default a binding of it overrides: the binding gives its value.
      if (this.statedValue(g) !== undefined) {
        return boundOverDefault(this.model, target, g) ? undefined : { target: g, at: d.reader };
      }
      const n = this.nameOf(g);
      if (n !== undefined && g.ownerId != null && this.of(g.ownerId, n).length > 0) return undefined;
    }
    return undefined;
  }

  /**
   * What every name of the scope rooted at `contextId` DENOTES — the walk
   * {@link scope} admits from, before any value is asked of it: the feature,
   * and the context it is read in. Two readings of a value are compared name
   * by name through it ({@link sameIn}): `e.load` and a nested bare `load`
   * denote `E::load` read through P's `e` in P, and p's own `load` in `part p
   * : P { part :>> e { attribute :>> load = 50.0; } }`.
   */
  denote(contextId: ElementId): ReadonlyMap<string, Denotation> {
    let hit = this.denoted.get(contextId);
    if (!hit) {
      hit = this.walk(contextId);
      this.denoted.set(contextId, hit);
    }
    return hit;
  }

  /**
   * Did the {@link denote} walk of `contextId` stop at its work cap, so that
   * names below it are not registered: the sentence a name it does not answer
   * reads unknown with, else `undefined`.
   */
  nameWalkCut(contextId: ElementId): string | undefined {
    this.denote(contextId);
    return this.cutWalks.has(contextId)
      ? `the names below ${this.qualifiedNameOf(contextId)} are not all read: its parts are typed by parts of each other in more than ` +
          `${MAX_NAME_WALK_OWNERS.toLocaleString('en')} routes`
      : undefined;
  }

  private walk(contextId: ElementId): Map<string, Denotation> {
    const ids = new Map<string, Denotation>();
    const direct = new Set<string>();
    // Each nested bare name: how many features below the context have it, and
    // what the first of them denotes.
    const nested = new Map<string, { denoted: Denotation; count: number }>();
    // TWO guards, because they answer different questions. `onPath` is the
    // CYCLE guard and must be keyed on the owner ALONE: a feature whose type is
    // one of its own owners (`item def Person { timeslice asPresident : Person;
    // }`, the L4-self-typed-feature fixture) generates an unbounded name tower
    // `asPresident.asPresident…`, and a key that carries the prefix never
    // repeats, so it cannot see the cycle — it recursed until the stack died.
    // `visited` is only a WORK BOUND for a diamond reached twice at the SAME
    // prefix, so it keeps the prefix: two sibling features of one type (`part
    // a : T; part b : T;`) are different scopes and both must be walked —
    // except an owner that is a library element, walked once (see the use).
    const visited = new Set<string>();
    const onPath = new Set<ElementId>();
    // A WORK CAP on the tower itself: the guards cut cycles and diamonds, not
    // the number of simple routes, which grows factorially in a web of part
    // definitions that type parts of each other. Past the cap no owner is
    // entered: the names registered stand (first route wins, as in a whole
    // walk), the rest read unknown ({@link nameWalkCut}), and the two readings
    // that infer from what the walk did NOT find stay off — the `nested`
    // bare-name admission (its counts are low only because the walk stopped)
    // and the lexical one (a direct name never registered would let an outer
    // attribute of the same name through).
    let entered = 0;
    let cut = false;
    const held = new Map<string, ElementId>();
    this.withheldIn.set(contextId, held);
    // `inCall`: below a calculation with a parameter, whose features are the
    // values of a CALL — its `in y = 100.0` a default nothing invokes, its
    // `return r = y` the result of one — so a value scope reads none of them.
    // `instance`: the instance of `ownerId` the walk is in, and `enclosing`
    // the ones it passed through to get there ({@link Denotation}).
    const visit = (
      ownerId: ElementId,
      prefix: string,
      inBody: boolean,
      inCall: boolean,
      instance: string,
      enclosing: readonly InstanceFrame[],
    ): void => {
      if (onPath.has(ownerId)) return;
      // A library feature's members are walked once, whatever the prefix: its
      // feature graph is a dense web (`Part` owns features typed by `Part`...),
      // so `part p3 : Parts::Part;` beside an instance and a constraint ran out
      // of memory. No model reads such a member by a chain below a user feature.
      const guardKey = this.model.get(ownerId)?.attrs.isLibrary === true ? `library ${ownerId}` : `${prefix} ${ownerId}`;
      if (visited.has(guardKey)) return;
      if (entered >= MAX_NAME_WALK_OWNERS) {
        cut = true;
        return;
      }
      entered++;
      visited.add(guardKey);
      // The names of a scope whose binding the editor parted from a copy are not offered ({@link partedHolder}).
      if (this.partedHolder(ownerId)) {
        held.set(prefix, ownerId);
        return;
      }
      onPath.add(ownerId);
      for (const feat of this.features(ownerId)) {
        const name = this.nameOf(feat);
        if (!name) continue;
        const denoted: Denotation = { feature: feat, reader: ownerId, inCall, instance, enclosing };
        // A directed feature is its owner's parameter: never a nested bare name.
        const own = inBody || isDirected(feat);
        for (const n of [name, ...this.aliasesOf(feat)]) {
          const full = prefix ? `${prefix}.${n}` : n;
          if (!ids.has(full)) ids.set(full, denoted);
          if (prefix === '') direct.add(n);
          else if (!own) {
            const seen = nested.get(n);
            if (seen) seen.count++;
            else nested.set(n, { denoted, count: 1 });
          }
        }
        // A subject something binds is read through what it stands for, in
        // the instance it stands for.
        const into = this.subjectOf(ownerId, feat) ?? feat;
        const bound = into !== feat ? this.boundInstance(ownerId, feat, into, { instance, enclosing }) : undefined;
        visit(
          into.id,
          prefix ? `${prefix}.${name}` : name,
          own || ownsBody(feat),
          inCall || isCall(this.model, feat),
          bound?.instance ?? this.instanceBelow(instance, feat, name, prefix === ''),
          bound?.enclosing ?? [...enclosing, { instance, reader: ownerId }],
        );
      }
      onPath.delete(ownerId);
    };
    visit(contextId, '', false, false, this.instanceNameOf(contextId), []);
    if (cut) {
      this.cutWalks.add(contextId);
      return ids;
    }
    // A name the context's own features do not answer is the attribute its
    // owning namespaces declare ({@link lexicalNames}), as KerML resolves it.
    const lexical = this.lexicalNames(contextId);
    for (const [n, denoted] of lexical.admitted) if (!ids.has(n)) ids.set(n, denoted);
    // Last, the one feature nested below the context that has the name — this
    // tool's reading of a bare name KerML resolves to nothing where it is
    // written. One a body read here names and KerML resolves there (an owner's
    // member, through an import or an alias; one {@link lexicalNames} leaves
    // unread) is never read so: A's `x = K` beside `part p : P` with P's `K =
    // 7.0` is the package's K (50) KerML gives it, never p's 7 (NX3), and
    // read so on every surface, the H5 rules' other side of an assert included
    // (NX1, NX4).
    for (const [n, seen] of nested) {
      if (direct.has(n) || ids.has(n) || seen.count !== 1 || lexical.refused.has(n)) continue;
      if (lexical.written.get(n)?.some((x) => resolveFullName(this.model, n, x.id) !== undefined)) continue;
      ids.set(n, seen.denoted);
    }
    return ids;
  }

  /**
   * The names `contextId` reads through the OWNING namespaces of the elements
   * that write its bodies (E3, KerML's lexical scope): `K` in `package Lex {
   * attribute K = 7.0; part def A { attribute x = K; } }` is Lex's K, which
   * A's own features do not answer. The bodies read in a context are its own
   * and its general types' ({@link namesWritten}); each names `n` as KerML
   * resolves it where it is written ({@link resolveFullName}: its owners
   * outward, with their imports and aliases), and `n` is read here only where
   * every one of them resolves it to one attribute, which the nearest owner
   * of each declaring a feature by that name declares. So an import or an
   * alias on the way (`import Consts::*;`) leaves the name unread, as does a
   * name a writer does not see (H's K for A's `x = K`, where A is declared
   * outside H), and one a specialiser of the context answers with another
   * feature, where that specialiser reads it — one that declares it itself
   * reads it in no body it inherits ({@link lexicalShadows}: q's `part :>> p
   * { attribute L … }` beside Q's p reading Q's L, which Q's p then reads).
   * Each is read where it is declared, as one value:
   *  - a package's attribute is one instance wherever it is read;
   *  - an enclosing definition's or usage's attribute is read in the instance
   *    that encloses the reading, so it is read here only where that is the
   *    same value in EVERY instance of its owner ({@link lexicallyUniform}):
   *    none specialises the owner and declares it anew, no binding joins it,
   *    no asserted relation names it where it is a `default` an assertion may
   *    replace ({@link replaceableDefaults}: none), and what its value reads is
   *    the same too. Where one is not (h2c0's `q : Q { :>> L = 50.0; }` beside
   *    Q's p `:>> load = L`), the name is left unread — the generic read
   *    abstains where a specialiser changes the value — and the reason is kept
   *    (`refused`, {@link lexicalRefusal}).
   * Once per context; it reads no {@link denote} walk, and no value a binding
   * or an assert decides ({@link lexicallyUniform}). `written`: each bare name
   * a body read here names that the context's own features do not answer,
   * with the elements that write it — what {@link walk} asks before it reads
   * such a name as the one feature nested below the context.
   */
  private lexicalNames(contextId: ElementId): {
    admitted: ReadonlyMap<string, Denotation>;
    refused: ReadonlyMap<string, string>;
    written: ReadonlyMap<string, readonly ElementRecord[]>;
  } {
    const hit = this.lexical.get(contextId);
    if (hit) return hit;
    const admitted = new Map<string, Denotation>();
    const refused = new Map<string, string>();
    const written = new Map<string, ElementRecord[]>();
    const out = { admitted, refused, written };
    this.lexical.set(contextId, out);
    // A relation's body is read with the context it is read in around it,
    // whose own owners answer such a name: the relation itself offers none (P's
    // `c` read in Q2's p reads no attribute of P as an owner's).
    const context = this.model.get(contextId);
    if (!context || context.attrs.isLibrary === true || isKindOf(context.eClass, 'ConstraintUsage')) return out;
    const own = this.byName(contextId);
    const writers = [context, ...generalizationsOf(this.model, contextId).filter((t) => t.attrs.isLibrary !== true)];
    for (const w of writers) {
      for (const [n, at] of this.namesWritten(w.id)) if (!own.has(n)) written.set(n, [...(written.get(n) ?? []), ...at]);
    }
    for (const [n, at] of written) {
      // Each element that writes it: the nearest of its owners that declares
      // the name answers it, and KerML's resolution agrees — no import, alias
      // or member of its own answers it first.
      let target: { owner: ElementRecord; feature: ElementRecord } | undefined;
      const agree = at.every((x) => {
        const t = this.lexicalTarget(x.id, n);
        if (!t || (target !== undefined && (t.feature !== target.feature || t.owner !== target.owner))) return false;
        target = t;
        return resolveFullName(this.model, n, x.id)?.id === t.feature.id;
      });
      if (!agree || !target || target.feature.eClass !== 'AttributeUsage') continue;
      const { owner: o, feature: f } = target;
      // A specialiser that answers the name with another feature reads that one for this body — unless it
      // reads the name there not at all ({@link lexicalShadows}: DY1's q's p, which declares `L` itself):
      // then this reading is the body's in every instance that reads it.
      if (this.specialisersOf(contextId).some((s) => (this.byName(s.id).get(n) ?? f) !== f && !this.clashesIn(s.id).get(n)?.shadow)) continue;
      // A package's `default` an assertion may replace ({@link replaceableDefaults}: none since decision 14 was
      // amended), which an assert other than its own names (one nested in it too), would give way there with
      // the default it is set equal to (U7): not one value either. Every other default is the one value it is,
      // as one written with `=`, and the assert is checked against it (LP1, SLP).
      const elsewhere =
        isPackage(o) &&
        f.attrs.defaultValue === true &&
        replaceableDefaults(this.model).has(f.id) &&
        [...(this.assertedNames().get(n) ?? [])].some((x) => x !== o.id);
      const why = elsewhere ? `an asserted relation other than its own names ${n}` : isPackage(o) ? undefined : this.lexicallyUniform(o.id, f, n);
      if (why !== undefined) {
        refused.set(n, `${n} is read through ${this.qualifiedNameOf(o.id)}, which declares it, and is not one value in every instance of it: ${why}`);
        continue;
      }
      admitted.set(n, { feature: f, reader: o.id, inCall: false, instance: this.instanceNameOf(o.id), enclosing: [] });
    }
    return out;
  }

  /**
   * The bare names the bodies `id` owns read — its features' values and its
   * relations' expressions, by the first segment of each — with the elements
   * that write them ({@link lexicalNames}). Once per element.
   */
  private namesWritten(id: ElementId): ReadonlyMap<string, readonly ElementRecord[]> {
    let hit = this.writtenNames.get(id);
    if (!hit) {
      const out = new Map<string, ElementRecord[]>();
      const add = (names: readonly string[], x: ElementRecord): void => {
        for (const n of names) {
          const head = n.split('.')[0]!;
          const list = out.get(head);
          if (!list) out.set(head, [x]);
          else if (!list.includes(x)) list.push(x);
        }
      };
      for (const x of this.model.children(id)) {
        if (typeof x.attrs.value === 'string') add(namesOfValue(x.attrs.value), x);
        if (typeof x.attrs.expression === 'string') add(relationNamesOf(x.attrs.expression), x);
      }
      this.writtenNames.set(id, (hit = out));
    }
    return hit;
  }

  /**
   * The attribute a body read in `contextId` reads `name` as through the
   * owners of the element that writes it ({@link lexicalNames}) — `undefined`
   * where it reads none so: a feature of the context, or a name left unread.
   */
  lexicalFeature(contextId: ElementId, name: string): ElementRecord | undefined {
    return this.byName(contextId).has(name) ? undefined : this.lexicalNames(contextId).admitted.get(name)?.feature;
  }

  /**
   * Why a name a body reads through its owners ({@link lexicalNames}) is left
   * unread in `contextId` — the sentence naming what makes it another value in
   * some instance — or `undefined`. So is one the context declares itself that
   * a body of a general type reads through that type's owners ({@link
   * lexicalShadows}): the shadow's sentence.
   */
  lexicalRefusal(contextId: ElementId, name: string): string | undefined {
    const shadowed = this.clashesIn(contextId).get(name);
    if (shadowed?.shadow) return clashSentence(this.model, contextId, shadowed);
    if (!this.denote(contextId).has(name)) {
      const cut = this.nameWalkCut(contextId);
      if (cut !== undefined) return cut;
    }
    return this.byName(contextId).has(name) ? undefined : this.lexicalNames(contextId).refused.get(name);
  }

  /** The feature the nearest owner of `fromId` that declares `name` declares under it, with that owner. */
  private lexicalTarget(fromId: ElementId, name: string): { owner: ElementRecord; feature: ElementRecord } | undefined {
    const seen = new Set<ElementId>([fromId]);
    for (let id = this.model.get(fromId)?.ownerId ?? null; id != null && !seen.has(id); ) {
      seen.add(id);
      const o = this.model.get(id);
      if (!o || o.attrs.isLibrary === true) return undefined;
      const feature = this.byName(id).get(name);
      if (feature) return { owner: o, feature };
      id = o.ownerId;
    }
    return undefined;
  }

  /**
   * Is the attribute `f`, declared as `name` in (or inherited by) the
   * definition or usage `ownerId`, one value in EVERY instance of it — so that
   * reading it where it is declared is reading it in whichever instance
   * encloses the reading ({@link lexicalNames})? `undefined` when it is; else
   * why not. No context that specialises the owner answers the name with
   * another feature; no binding joins it, and no asserted relation names it
   * where it is a `default` (a value given per instance); it states a literal,
   * or an expression whose every name is such a value where it is read, as
   * KerML resolves it there. Conservative: a value it cannot follow so is not
   * one.
   */
  private lexicallyUniform(ownerId: ElementId, f: ElementRecord, name: string, seen = new Set<ElementId>()): string | undefined {
    if (seen.has(f.id)) return `${name}'s value reads itself`;
    seen.add(f.id);
    // Every context that specialises the owner — an implicit connector-end
    // copy included, which redefines what a binding reaches into.
    if (!this.implicitlySpecialised) {
      const out = new Map<ElementId, ElementRecord[]>();
      for (const x of this.model.all()) {
        if (x.attrs.isLibrary === true || x.attrs.implicit !== true || (!isUsage(x.eClass) && !isDefinition(x.eClass))) continue;
        for (const g of generalizationsOf(this.model, x.id)) out.set(g.id, [...(out.get(g.id) ?? []), x]);
      }
      this.implicitlySpecialised = out;
    }
    const changed = [...this.specialisersOf(ownerId), ...(this.implicitlySpecialised.get(ownerId) ?? [])].find(
      (s) => this.byName(s.id).get(name) !== f,
    );
    if (changed) return `${this.qualifiedNameOf(changed.id)} declares ${name} anew`;
    // A binding end, or a feature one redefines: a value given per instance.
    if (!this.joined) {
      const joined = new Set<ElementId>();
      for (const e of this.model.all()) {
        if (e.attrs.isLibrary === true || !isBindingConnector(e)) continue;
        for (const id of [...(e.source ?? []), ...(e.target ?? [])]) {
          joined.add(id);
          const end = this.model.get(id);
          if (end) for (const g of redefinedClosure(this.model, end)) joined.add(g.id);
        }
      }
      this.joined = joined;
    }
    if (this.joined.has(f.id)) return `a binding joins ${name}`;
    // An assert is checked against a `default` as against a value written with
    // `=` (decision 14 amended 2026-10-22): only one an assertion may replace
    // ({@link replaceableDefaults}: none) is no one value where an assert names
    // it. Refused here, a contradicting assert over such a default was never
    // reported violated (SLO, SLD).
    if (f.attrs.defaultValue === true && replaceableDefaults(this.model).has(f.id) && this.assertedNames().has(name)) {
      return `an asserted relation names ${name}`;
    }
    // The value as written: whether a `default` gives way is a binding's or an
    // assert's question, both answered above — and asking it here would read
    // the walk this one is part of.
    const v = f.attrs.value;
    if (typeof v === 'number' || typeof v === 'boolean') return undefined;
    if (typeof v !== 'string') return `${name} states no value`;
    if (isQuoted(v.trim())) return undefined;
    for (const m of namesOfValue(v)) {
      if (m.includes('.')) return `${name}'s value reads ${m} through another feature`;
      const g = this.byName(ownerId).get(m);
      if (g) {
        const why = this.lexicallyUniform(ownerId, g, m, seen);
        if (why !== undefined) return why;
        continue;
      }
      const t = f.ownerId != null ? this.lexicalTarget(f.ownerId, m) : undefined;
      if (!t) return `${name}'s value reads ${m}, which nothing declares`;
      if (resolveFullName(this.model, m, f.id)?.id !== t.feature.id) return `${name}'s value reads ${m}, which an import or an alias answers`;
      if (isPackage(t.owner)) continue;
      const why = this.lexicallyUniform(t.owner.id, t.feature, m, seen);
      if (why !== undefined) return why;
    }
    return undefined;
  }

  /**
   * Every name the user's asserted relations read, by each segment, with the
   * owners of the relations that read it — once per revision. An assert typed
   * by a constraint definition reads its type's expression and the values its
   * parameters are given (`assert constraint e : Eq { in a = L; }`), so both
   * count, the type's own parameter values too.
   */
  private assertedNames(): ReadonlyMap<string, ReadonlySet<ElementId>> {
    if (!this.assertNames) {
      const out = new Map<string, Set<ElementId>>();
      const add = (seg: string, owner: ElementId): void => {
        const owners = out.get(seg);
        if (owners) owners.add(owner);
        else out.set(seg, new Set([owner]));
      };
      for (const c of this.model.ofKind('ConstraintUsage')) {
        if (c.attrs.isLibrary === true || !isAsserted(c) || c.ownerId == null) continue;
        for (const x of [c, ...generalizationsOf(this.model, c.id).filter((t) => t.attrs.isLibrary !== true)]) {
          if (typeof x.attrs.expression === 'string') {
            for (const n of relationNamesOf(x.attrs.expression)) for (const seg of n.split('.')) add(seg, c.ownerId);
          }
          for (const [n] of this.namesWritten(x.id)) add(n, c.ownerId);
        }
      }
      this.assertNames = out;
    }
    return this.assertNames;
  }

  /**
   * The instance the walk is in below `feat`, read in `instance` — the one its
   * features are read in ({@link Denotation}): `instance::name`; the instance
   * a subject is bound to (`into`); and for a subject nothing binds, read
   * where its requirement is the scope's root (`atRoot`), the generic instance
   * of its type — the requirement is about any one.
   *
   * Nowhere else is a subject generic. Reached through a usage on the chain —
   * `r1.s` beside `r2.s` for two usages of one requirement, a nested
   * requirement's `r2.t`, `sys.ra.s` — it is that usage's subject: one
   * symbol for every such reading made `r2.s.load >= 5.0` PROVED from
   * `assert r1.s.load >= 5.0`. And a subject that says something of its own
   * below it — a value or a redefinition (`subject s : P { attribute :>> load
   * = 50.0; }`), an assert, a constraint or a binding — is an instance of its
   * own: generic, its own assert was filed as a fact of EVERY P, and another
   * requirement's `t.load <= 3.0` was proved from it.
   */
  private instanceBelow(instance: string, feat: ElementRecord, name: string, atRoot: boolean): string {
    if (atRoot && feat.attrs.requirementRole === 'subject') {
      const type = this.model.typesOf(feat.id)[0];
      if (type && !this.saysOwn(feat)) return this.qualifiedNameOf(type.id);
    }
    return `${instance}::${name}`;
  }

  /**
   * The instance a subject bound to `into` stands for, in `contextId` — and
   * the instances that enclose it: the satisfier of a `satisfy R by x`
   * ({@link satisfaction}) read where the relationship is written, and the
   * feature a subject's value names (`subject s = q1.p`) read where it
   * resolves. `satisfy R by q1.p` is q1's p — Q's `assert constraint { p.x
   * >= 1.0 }` holds of it — and not the p of every Q, nor P's own. A name
   * that does not resolve so is the bound feature's own instance.
   *
   * The chain is walked link by link ({@link chainInstance}), never through
   * the {@link denote} walk of a scope it starts in: that walk may be the one
   * running — the requirement's own, or its package's, which visits the
   * requirement — and answered then, the subject was the bound feature's own
   * instance, cached for good. `subject s = q1.p` in r1 and `subject s =
   * q2.p` in r2 were then ONE symbol, Q's p's x: `s.x >= 5.0` beside `s.x <=
   * 3.0` "inconsistent", and the x of every Q bounded to [5, 7] "exactly".
   */
  private boundInstance(
    contextId: ElementId,
    f: ElementRecord,
    into: ElementRecord,
    at?: { instance: string; enclosing: readonly InstanceFrame[] },
  ): { instance: string; enclosing: readonly InstanceFrame[] } {
    const fallback = { instance: this.qualifiedNameOf(into.id), enclosing: [] };
    // A value whose instance leads back to one being named is named by its feature.
    if (this.instancing.has(f.id)) return fallback;
    this.instancing.add(f.id);
    try {
      return this.stepInstances(contextId, f, into, at) ?? fallback;
    } finally {
      this.instancing.delete(f.id);
    }
  }

  /** {@link boundInstance}'s steps, to the instance `into` is, or `undefined`. */
  private stepInstances(
    contextId: ElementId,
    f: ElementRecord,
    into: ElementRecord,
    at?: { instance: string; enclosing: readonly InstanceFrame[] },
  ): { instance: string; enclosing: readonly InstanceFrame[] } | undefined {
    const seen = new Set<ElementId>();
    let step: { contextId: ElementId; f: ElementRecord; at?: { instance: string; enclosing: readonly InstanceFrame[] } } = {
      contextId,
      f,
      ...(at ? { at } : {}),
    };
    for (;;) {
      if (seen.has(step.f.id)) return undefined;
      seen.add(step.f.id);
      const end = this.instanceStep(step.contextId, step.f, step.at);
      if (!end) return undefined;
      if (end.feature.id === into.id) return end.bare ? undefined : { instance: end.instance, enclosing: end.enclosing };
      // What it lands on stands for another feature in turn ({@link
      // subjectScope}): on from the instance that one is, read in its owner.
      const owner = end.enclosing[end.enclosing.length - 1];
      if (!owner || this.subjectOf(owner.reader, end.feature) === undefined) return undefined;
      step = { contextId: owner.reader, f: end.feature, at: { instance: owner.instance, enclosing: end.enclosing.slice(0, -1) } };
    }
  }

  /**
   * One step of {@link boundInstance}: the feature `f`, read in `contextId`
   * (in the walk's instance `at` of it, where given), lands on, with the
   * instance it is and the instances enclosing it — the last of them its
   * owner's. A part a binding equates and a reference read in an instance of
   * the element it is written in ({@link referencedIn}) are resolved in
   * `at`; a satisfier no path names (`satisfy R by pp`) is its own instance
   * (`bare`: no instance a path spelled).
   */
  private instanceStep(
    contextId: ElementId,
    f: ElementRecord,
    at?: { instance: string; enclosing: readonly InstanceFrame[] },
  ): { feature: ElementRecord; instance: string; enclosing: InstanceFrame[]; bare?: true } | undefined {
    // A part a binding equates is read where the binding is written ({@link
    // equatedPart}): read in the walk's instance of that element (`at`), the
    // partner is that instance's own — s's w's top's a for W's `bind pp =
    // top.a` reached as `s.w.pp`, never the a of Sys's own w.
    const equated = this.equatedPart(f, contextId);
    if (equated && at && equated.from === contextId) {
      return this.chainFrom(at.instance, at.enclosing, contextId, equated.path, false, true);
    }
    const satisfied = equated ? undefined : this.satisfaction(contextId);
    const written = satisfied ? this.model.get(contextId) : undefined;
    // A satisfier named bare is a path of one link from where the `satisfy` is
    // written, as a chain is, where that element has it: `satisfy RF by p1`
    // in `part sys : W { … }` is sys's p1, whose load sys's K gives through
    // W's `bind p1.load = K` — never W's own p1, read at W's K.
    const bare =
      satisfied && written?.ownerId != null && f.attrs.requirementRole === 'subject'
        ? this.bareSatisfierPath(written.ownerId, satisfied.satisfier)
        : undefined;
    const ref = equated ? equated.path : satisfied ? (written?.attrs.sourceChain ?? written?.attrs.sourceRef ?? bare) : f.attrs.value;
    if (typeof ref !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(ref.trim())) {
      const s = satisfied && f.attrs.requirementRole === 'subject' ? satisfied.satisfier : undefined;
      if (!s) return undefined;
      const frames = s.ownerId != null ? [{ instance: this.instanceNameOf(s.ownerId), reader: s.ownerId }] : [];
      return { feature: s, instance: this.qualifiedNameOf(s.id), enclosing: frames, bare: true };
    }
    const path = ref.trim();
    // A reference read in an instance of the element its value is written in
    // names that instance's own feature.
    const inContext = equated || satisfied || f.attrs.isRef !== true ? undefined : this.referencedIn(contextId, f, path);
    if (inContext !== undefined && at) return this.chainFrom(at.instance, at.enclosing, contextId, path, false, true);
    // So does one read where it is written, in an instance of that element the
    // walk is in other than the element's own: W's `part sub { ref part r : T0
    // = x; }` reached as `w.sub.r` is w's sub's x, whose load W's `bind
    // sub.x.load = K` gives w's K. It named W's own sub's x (K's default) for
    // every instance, true on all four surfaces where w's breaks the relation.
    if (inContext === undefined && at && !equated && !satisfied && f.attrs.isRef === true && contextId === f.ownerId) {
      const end = at.instance !== this.instanceNameOf(contextId) ? this.chainFrom(at.instance, at.enclosing, contextId, path, false, true) : undefined;
      if (end) return end;
    }
    const seen = new Set<ElementId>();
    for (
      let cur = equated ? equated.from : satisfied ? (written?.ownerId ?? null) : (inContext ?? f.ownerId);
      cur != null && !seen.has(cur);
      cur = satisfied || equated || inContext !== undefined ? null : (this.model.get(cur)?.ownerId ?? null)
    ) {
      seen.add(cur);
      const end = this.chainFrom(this.instanceNameOf(cur), [], cur, path, true, true);
      if (end) return end;
    }
    return undefined;
  }

  /**
   * The name a `satisfy` written in `ownerId` reaches its satisfier by, as a
   * path of one link from there ({@link instanceStep}): where the satisfier
   * is a feature that element INHERITS, under its own name — sys's p1 for
   * `satisfy RF by p1` in `part sys : W`. `undefined` for one written beside
   * its satisfier (in W, or in a package), which is its own instance, as
   * before.
   */
  private bareSatisfierPath(ownerId: ElementId, satisfier: ElementRecord): string | undefined {
    if (satisfier.ownerId === ownerId) return undefined;
    const name = this.nameOf(satisfier);
    return name !== undefined && this.byName(ownerId).get(name) === satisfier ? name : undefined;
  }

  /**
   * The instance a dotted `path`, read in `contextId`, ends at — as the
   * {@link denote} walk names it — with the instances that enclose it,
   * outermost first, and the feature it is: each link among the effective
   * features of the one before ({@link byName}), and each instance below a
   * link named as the walk names it ({@link instanceBelow}). `undefined` when
   * the path does not resolve, or passes through a subject something binds
   * (the walk re-roots there).
   */
  private chainInstance(
    contextId: ElementId,
    path: string,
  ): { feature: ElementRecord; instance: string; enclosing: InstanceFrame[] } | undefined {
    return this.chainFrom(this.instanceNameOf(contextId), [], contextId, path, true);
  }

  /**
   * {@link chainInstance} from `instance`, the instance of `contextId` the
   * caller is in, below the instances `above` (`atRoot`: `contextId` is the
   * scope's root). `reroot`: a link that stands for another feature (a
   * reference, a bound subject, an equated part) is read on as the {@link
   * denote} walk reads it — in the instance it stands for ({@link
   * boundInstance}) — where it otherwise ends the chain: `rr.pp` for `ref
   * part rr : W = w` is w's pp, and a reference valued `rr.pp` names w's
   * top's a through it, never W's own (it read W's top's a, 1).
   */
  private chainFrom(
    instance: string,
    above: readonly InstanceFrame[],
    contextId: ElementId,
    path: string,
    atRoot: boolean,
    reroot = false,
  ): { feature: ElementRecord; instance: string; enclosing: InstanceFrame[] } | undefined {
    const segments = path.split('.');
    let owner = contextId;
    let enclosing: InstanceFrame[] = [...above];
    for (let i = 0; i < segments.length; i++) {
      const feature = this.byName(owner).get(segments[i]!);
      const name = feature ? this.nameOf(feature) : undefined;
      if (!feature || name === undefined) return undefined;
      const outer = enclosing;
      enclosing = [...enclosing, { instance, reader: owner }];
      if (i === segments.length - 1) return { feature, instance: `${instance}::${name}`, enclosing };
      const into = this.subjectOf(owner, feature);
      if (into) {
        if (!reroot) return undefined;
        const bound = this.boundInstance(owner, feature, into, { instance, enclosing: outer });
        instance = bound.instance;
        enclosing = [...bound.enclosing];
        owner = into.id;
        continue;
      }
      instance = this.instanceBelow(instance, feature, name, atRoot && i === 0);
      owner = feature.id;
    }
    return undefined;
  }

  /**
   * The instances ENCLOSING the instance `inst`, outermost first, each with
   * the context its features are read in ({@link Denotation}'s `enclosing`):
   * `R1` (read in R1) and `R1::q1` (read in q1) for `R1::q1::p` — spelled link
   * by link ({@link chainInstance}) from the OUTERMOST user element whose own
   * instance prefixes it. A reading for an instance that is not its context's
   * own — a group row reads Q's p for q1's p; a derived value is read in its
   * definition for the instance it belongs to — reads none of these from its
   * context's walk, whose frames are the context's ({@link enclosingAssertOn}).
   * `undefined` where no element's chain spells `inst` (a subject a value
   * binds, a `satisfy` context).
   */
  framesAbove(inst: string): readonly InstanceFrame[] | undefined {
    const hit = this.above.get(inst);
    if (hit !== undefined) return hit ?? undefined;
    if (!this.rootsByInstance) {
      this.rootsByInstance = new Map();
      for (const el of this.model.all()) {
        if (el.attrs.isLibrary === true) continue;
        const name = this.instanceNameOf(el.id);
        const list = this.rootsByInstance.get(name);
        if (list) list.push(el);
        else this.rootsByInstance.set(name, [el]);
      }
    }
    const segments = inst.split('::');
    let found: readonly InstanceFrame[] | null = null;
    for (let k = 1; k < segments.length && found === null; k++) {
      const path = segments.slice(k).join('.');
      for (const root of this.rootsByInstance.get(segments.slice(0, k).join('::')) ?? []) {
        const end = this.chainInstance(root.id, path);
        if (end && end.instance === inst) {
          found = end.enclosing;
          break;
        }
      }
    }
    this.above.set(inst, found);
    return found ?? undefined;
  }

  /**
   * Does any user element own an asserted relation ({@link assertsOf})? Where
   * none does, no frame constrains a read ({@link enclosingAssertOn}). Once per
   * revision.
   */
  anyAsserted(): boolean {
    this.anyAsserts ??= this.model
      .ofKind('ConstraintUsage')
      .some(
        (c) =>
          c.attrs.isLibrary !== true &&
          isAsserted(c) &&
          typeof c.attrs.expression === 'string' &&
          c.attrs.expression.trim() !== '',
      );
    return this.anyAsserts;
  }

  /**
   * The asserted relations `readerId` owns, user-written, each with the names
   * its body reads ({@link relationNamesOf}) — once per reader, for
   * {@link enclosingAssertOn}.
   */
  assertsOf(readerId: ElementId): ReadonlyArray<{ expr: string; names: readonly string[] }> {
    let hit = this.asserted.get(readerId);
    if (!hit) {
      const out: Array<{ expr: string; names: readonly string[] }> = [];
      for (const child of this.model.children(readerId)) {
        if (child.attrs.isLibrary === true || !isAsserted(child)) continue;
        const expr = child.attrs.expression;
        if (typeof expr !== 'string' || expr.trim() === '') continue;
        out.push({ expr, names: relationNamesOf(expr) });
      }
      hit = out;
      this.asserted.set(readerId, hit);
    }
    return hit;
  }

  /**
   * What a requirement context binds its subject to: a `satisfy R by x`
   * ({@link satisfaction}), or a usage of R whose subject is bound by value
   * (`requirement r1 : R { subject s = q1; }`) — R, the feature the subject
   * stands for, and the instance it reads it as ({@link boundInstance}), with
   * the instances enclosing it. `undefined` for any other element.
   */
  subjectInstance(contextId: ElementId):
    | { requirement: ElementRecord; bound: ElementRecord; instance: string; enclosing: readonly InstanceFrame[] }
    | undefined {
    const satisfied = this.satisfaction(contextId);
    const requirement = satisfied ? satisfied.requirement : this.model.typesOf(contextId)[0];
    if (!requirement) return undefined;
    const subject = this.features(contextId).find((f) => f.attrs.requirementRole === 'subject');
    const bound = subject ? this.subjectOf(contextId, subject) : undefined;
    if (!subject || !bound) return undefined;
    return { requirement, bound, ...this.boundInstance(contextId, subject, bound) };
  }

  /** The type of the subject of the requirement `requirementId`, if it has one. */
  subjectTypeOf(requirementId: ElementId): ElementRecord | undefined {
    const subject = effectiveFeatures(this.model, requirementId).find((f) => f.attrs.requirementRole === 'subject');
    return subject ? this.model.typesOf(subject.id)[0] : undefined;
  }

  /**
   * Where a `satisfy R by x` ({@link satisfaction}), or a requirement usage
   * whose subject a value binds (`requirement q : RF { subject s = p1; }`),
   * reads its satisfier in an element — the `satisfy`'s owner, the namespace
   * the subject's value resolves in: W for either, written in `part def W` —
   * and an instance of that element reads what R requires of the satisfier
   * otherwise: what it answers, the instance first; else `undefined`. Every
   * surface reads such a context once, at W's own values, never in each
   * instance of W: sd0's `satisfy RF by p1` read W's p1's 1, and held for
   * every W, where w's `part :>> p1 { attribute :>> load = 50.0; }` breaks
   * RF. So each row of it abstains ({@link equatedPartsRefusal}), as one of a
   * satisfier this tool does not read through does ({@link equatedParts}),
   * which keeps that sentence. The test is the one that gives a constraint
   * written in W a row per instance: the names R's clauses read through the
   * subject — directly, or through the values of R's own features — spelled
   * through the satisfier's path (`s.load`, a bare `load`, and `m` over `m =
   * s.load`, as `p1.load`; every name below p1 where a name cannot be
   * followed so), read otherwise in a context that specialises W ({@link
   * changingContexts}), or — W a usage below another instance — through a
   * binding above it ({@link boundAbove}). Satisfied in a package, or read
   * alike in every instance (`part w : W;`), it reads as written — save where
   * a name below the satisfier reads through a usage that subsets a feature an
   * instance reads otherwise (`via`, {@link subsettingTaint}), in a package
   * too.
   */
  satisfierOtherwise(contextId: ElementId): ReadOtherwise | undefined {
    const hit = this.satisfierAsked.get(contextId);
    if (hit !== undefined) return hit ?? undefined;
    const written = this.model.get(contextId);
    if (!written || written.attrs.isLibrary === true) return undefined;
    // Re-entered through a context of the element the question is about (a
    // `satisfy` written in a requirement another satisfies): no answer is
    // kept, and the one given abstains.
    if (this.satisfierAsking.has(contextId)) {
      return { kind: this.satisfaction(contextId) ? 'satisfy' : 'subject', written, scope: written, path: '', instance: undefined };
    }
    this.satisfierAsking.add(contextId);
    let answer: ReadOtherwise | undefined;
    try {
      answer = this.satisfierOtherwiseOf(written);
    } finally {
      this.satisfierAsking.delete(contextId);
    }
    this.satisfierAsked.set(contextId, answer ?? null);
    return answer;
  }

  /** {@link satisfierOtherwise}, worked out. */
  private satisfierOtherwiseOf(written: ElementRecord): ReadOtherwise | undefined {
    const satisfied = this.satisfaction(written.id);
    if (!satisfied && !isUsage(written.eClass)) return undefined;
    const subject = this.features(written.id).find((f) => f.attrs.requirementRole === 'subject');
    const subjectName = subject ? this.nameOf(subject) : undefined;
    if (!subject || subjectName === undefined) return undefined;
    let path: string | undefined;
    let scope: ElementRecord | undefined;
    if (satisfied) {
      // The satisfier's path is resolved where the `satisfy` is written, and
      // there alone ({@link instanceStep}).
      const chain = written.attrs.sourceChain ?? written.attrs.sourceRef;
      path = typeof chain === 'string' ? chain.trim() : this.nameOf(satisfied.satisfier);
      scope = written.ownerId != null ? this.model.get(written.ownerId) : undefined;
      const outside = this.satisfierFromOutside(written, satisfied.satisfier, typeof chain === 'string' ? chain.trim() : undefined);
      if (outside) return outside;
    } else {
      // A subject's value, from where it is written outward ({@link standsIn}).
      if (typeof subject.attrs.value !== 'string') return undefined;
      path = subject.attrs.value.trim();
      if (!VALUE_PATH.test(path)) return undefined;
      const seen = new Set<ElementId>();
      for (let cur = subject.ownerId ?? null; cur != null && !seen.has(cur); cur = this.model.get(cur)?.ownerId ?? null) {
        seen.add(cur);
        if (this.chain([cur], path)) {
          scope = this.model.get(cur);
          break;
        }
      }
    }
    if (path === undefined || !VALUE_PATH.test(path) || !scope) return undefined;
    // Resolved in a package, the satisfier is one instance, read alike wherever
    // it is read — save through a usage that subsets a feature an instance
    // reads otherwise ({@link subsettingTaint}): a package's `satisfy RF by
    // w.p2`, or `requirement r : RF { subject s = w.p2; }`, over W's `part p2 :>
    // p1;` read W's own p2 (1) where w's p2 is one of w's p1s (50), filed no row
    // of its own, and `verify` exited 0.
    const inPackage = isPackage(scope);
    if (inPackage && subsettingTaint(this.model).taint.size === 0) return undefined;
    if (equatedParts(this.model).unread.some((u) => u.id === written.id || u.id === subject.id)) return undefined;
    // R's clauses' names through the subject, spelled through the satisfier —
    // and, for a feature of R's own a clause reads, the names its value or an
    // asserted equation that defines it reads, transitively: `m <= 5.0` over
    // `attribute m = s.load` reads `p1.load`. A name this cannot follow so — a
    // feature a binding gives its value (`bind m = s.load`), one the walk reads
    // through the subject by another route, a value's name R does not resolve
    // — answers with every name below the satisfier, as a reference's value
    // does ({@link referenceOtherwise}). Only the names spelled through the
    // subject were read, so `m` was dropped, no instance was found to read the
    // satisfier otherwise, and w's 50 was never read: SM1's `satisfy RF by p1`
    // held on all four surfaces.
    // A walk that stopped at its cap lists not every name below the satisfier: the row abstains.
    if (this.nameWalkCut(written.id) !== undefined || (scope.id !== written.id && this.nameWalkCut(scope.id) !== undefined)) {
      return { kind: satisfied ? 'satisfy' : 'subject', written, scope, path, instance: undefined };
    }
    const denoted = this.denote(written.id);
    const through = this.subjectInstance(written.id)?.instance;
    const own = this.instanceNameOf(written.id);
    const names: string[] = [];
    const add = (n: string): void => {
      if (!names.includes(n)) names.push(n);
    };
    const pending: Array<{ n: string; ofValue: boolean }> = [];
    for (const c of this.features(written.id)) {
      const role = c.attrs.requirementRole;
      if ((role !== 'require' && role !== 'assume') || typeof c.attrs.expression !== 'string') continue;
      for (const n of relationNamesOf(c.attrs.expression)) pending.push({ n, ofValue: false });
    }
    const asked = new Set<string>();
    let whole = false;
    while (pending.length > 0 && !whole) {
      const { n, ofValue } = pending.pop()!;
      if (asked.has(n)) continue;
      asked.add(n);
      const head = n.split('.')[0]!;
      if (head === subjectName) {
        add(`${path}${n.slice(head.length)}`);
        continue;
      }
      const d = denoted.get(n);
      // A clause's name nothing resolves fails on its own; a value's may be
      // written where R does not spell it (a nested owner naming `s` outward).
      if (d === undefined) {
        whole = ofValue;
        continue;
      }
      // A nested bare name the subject answers (`load` for `s.load`): the walk keeps one record for both.
      let alias: string | undefined;
      if (!n.includes('.')) {
        for (const [k, v] of denoted) {
          if (v === d && k.startsWith(`${subjectName}.`)) {
            alias = k;
            break;
          }
        }
      }
      if (alias !== undefined) {
        add(`${path}${alias.slice(subjectName.length)}`);
        continue;
      }
      // A feature of R's own lands in the context's own instance, which a
      // `satisfy` spells below its satisfier's (`W::p1::«satisfy RF»`).
      const ownFeature = d.instance === own || d.instance.startsWith(`${own}::`);
      if (!ownFeature && through !== undefined && (d.instance === through || d.instance.startsWith(`${through}::`))) {
        whole = true;
        continue;
      }
      const reads = this.readsOf(this.carrier(d.reader, d.feature), [d.reader]);
      if (reads === undefined) {
        whole = true;
        continue;
      }
      const prefix = n.includes('.') ? n.slice(0, n.lastIndexOf('.') + 1) : '';
      for (const r of reads) for (const v of r.names) pending.push({ n: `${prefix}${v}`, ofValue: true });
    }
    if (whole) {
      for (const k of this.denote(scope.id).keys()) if (k === path || k.startsWith(`${path}.`)) add(k);
    }
    if (names.length === 0) return undefined;
    const kind = satisfied ? 'satisfy' : 'subject';
    const otherwise = inPackage ? undefined : this.instanceReadingOtherwise(`${written.id} satisfier`, scope, names);
    if (otherwise) return { kind, written, scope, path, instance: otherwise.instance };
    // A name below the satisfier read through a usage that subsets a feature an
    // instance reads otherwise ({@link subsettingOtherwise}): the test above reads
    // such a usage as the element's own in every instance, so it found none.
    // sa3's `satisfy RF by p2` over W's `part p2 :> p1;` read W's p2 (1) for every
    // W, where w's `part :>> p1 { attribute :>> load = 50.0; }` makes w's p2 one of
    // w's p1s (50): no row was filed for w, and `verify` exited 0. So in a
    // package, which the test above does not ask.
    const subsetting = subsettingTaint(this.model);
    if (subsetting.taint.size === 0) return undefined;
    for (const n of names) {
      const b = readsTainted(this.model, subsetting.taint, [scope.id], n);
      const via = b ? subsetting.why.get(b.id) : undefined;
      if (via) return { kind, written, scope, path, instance: via.instance, via };
    }
    return undefined;
  }

  /**
   * A `satisfy` written OUTSIDE the definition whose feature it names, by a path that does not resolve where it
   * is written (`satisfy RF by NQ1::w.p1;` or `by w.p1;` in a package nested in the one that declares `w`, or in a
   * part body): the mapper records the satisfier as W's own `p1`, and {@link writtenSatisfier} finds w's redefinition
   * only for a path resolved at the owner, so the row was read at W's values and a requirement w's `part :>> p1 {
   * attribute :>> load = 50.0; }` breaks held (NQ1, NQ2, NQ5, NQ7; NQ3, written in the package that declares `w`,
   * files w's row). When an instance of W reads a name below that feature otherwise, the satisfy is read for none:
   * the answer is of kind `satisfy` with `outside`. A satisfy written in W, in an instance of it or below one reads
   * as before; so does one no instance reads otherwise (`part w : W;`). `undefined` otherwise.
   */
  private satisfierFromOutside(written: ElementRecord, satisfier: ElementRecord, chain: string | undefined): ReadOtherwise | undefined {
    const owner = written.ownerId;
    const home = satisfier.ownerId != null ? this.model.get(satisfier.ownerId) : undefined;
    if (owner == null || !home || !isDefinition(home.eClass) || isPackage(home) || satisfier.attrs.isLibrary === true) return undefined;
    if (chain !== undefined && VALUE_PATH.test(chain) && featuresAlongValue(this.model, owner, chain)?.scope === owner) return undefined;
    // In W, in an instance of it, or below one: read where it is written, as before.
    const seen = new Set<ElementId>();
    for (let cur: ElementId | null = owner; cur != null && !seen.has(cur); cur = this.model.get(cur)?.ownerId ?? null) {
      seen.add(cur);
      if (cur === home.id || generalizationsOf(this.model, cur).some((g) => g.id === home.id)) return undefined;
    }
    const name = this.nameOf(satisfier);
    if (name === undefined) return undefined;
    if (this.nameWalkCut(home.id) !== undefined) return { kind: 'satisfy', written, scope: home, path: chain ?? name, instance: undefined, outside: true };
    const names = [...this.denote(home.id).keys()].filter((k) => k === name || k.startsWith(`${name}.`));
    const otherwise = names.length > 0 ? this.instanceReadingOtherwise(`${written.id} satisfier`, home, names) : undefined;
    return otherwise ? { kind: 'satisfy', written, scope: home, path: chain ?? name, instance: otherwise.instance, outside: true } : undefined;
  }

  /**
   * Where a REFERENCE's value (`ref part r : T0 = p1`) resolves not below the
   * element it is written in but in one around it — W, for r written in W's
   * `part sub { … }` — and an instance of that element reads what the path
   * names otherwise: what it answers, as {@link satisfierOtherwise} does for
   * a subject; else `undefined`. The walk resolves such a value in that
   * element ({@link standsIn}), at its own values — W's own p1 (1) — never in
   * each instance of it (w's p1, 50): W's sub's `r.load <= 5.0` held for every
   * W, and so did `w.sub.r.load <= 5.0`. So each reading through it abstains
   * ({@link equatedPartsRefusal}). One that resolves below its own element is
   * read in each instance of it ({@link referencedIn}, {@link instanceStep}).
   */
  referenceOtherwise(f: ElementRecord): ReadOtherwise | undefined {
    const hit = this.referenceAsked.get(f.id);
    if (hit !== undefined) return hit ?? undefined;
    let answer: ReadOtherwise | undefined;
    if (f.attrs.isRef === true && f.attrs.isLibrary !== true && typeof f.attrs.value === 'string' && f.ownerId != null) {
      answer = this.pathOtherwise(f, f.attrs.value.trim(), 'reference', f);
    }
    this.referenceAsked.set(f.id, answer ?? null);
    return answer;
  }

  /**
   * {@link referenceOtherwise} for the subject of a requirement usage a value
   * binds (`requirement q : RF { subject s = p1; }` in W): where an instance
   * of the element the value resolves in reads ANY name below the path
   * otherwise — what a relation read through the subject from outside reads
   * (`w.q.s.load`), whatever R's clauses read ({@link satisfierOtherwise} asks
   * of those alone). R's `s.tag <= 5.0` read in w changes nothing w's `part
   * :>> p1 { attribute :>> load = 50.0; }` writes, but `w.q.s.load <= 5.0` read
   * W's own p1 (1) where w's is 50: true on all four surfaces.
   */
  subjectOtherwise(subject: ElementRecord): ReadOtherwise | undefined {
    const hit = this.subjectAsked.get(subject.id);
    if (hit !== undefined) return hit ?? undefined;
    let answer: ReadOtherwise | undefined;
    const written = subject.ownerId != null ? this.model.get(subject.ownerId) : undefined;
    if (subject.attrs.requirementRole === 'subject' && subject.attrs.isLibrary !== true && typeof subject.attrs.value === 'string' && written) {
      answer = this.pathOtherwise(subject, subject.attrs.value.trim(), 'subject', written);
    }
    this.subjectAsked.set(subject.id, answer ?? null);
    return answer;
  }

  /**
   * The answer of {@link referenceOtherwise} or {@link subjectOtherwise} for
   * the feature `f` valued with `path`: the first namespace outward from `f`'s
   * owner the path resolves in, where that is neither `f`'s owner nor a
   * package and an instance of it reads any name below the path otherwise.
   */
  private pathOtherwise(f: ElementRecord, path: string, kind: 'reference' | 'subject', written: ElementRecord): ReadOtherwise | undefined {
    let scope: ElementRecord | undefined;
    const seen = new Set<ElementId>();
    for (let cur: ElementId | null = VALUE_PATH.test(path) ? f.ownerId : null; cur != null && !seen.has(cur); cur = this.model.get(cur)?.ownerId ?? null) {
      seen.add(cur);
      if (this.chain([cur], path)) {
        scope = this.model.get(cur);
        break;
      }
    }
    const unread = () => equatedParts(this.model).unread.some((u) => u.id === f.id || u.id === written.id);
    if (!scope || scope.id === f.ownerId || isPackage(scope) || unread()) return undefined;
    const names = [...this.denote(scope.id).keys()].filter((k) => k === path || k.startsWith(`${path}.`));
    const otherwise = names.length > 0 ? this.instanceReadingOtherwise(`${f.id} ${kind}`, scope, names) : undefined;
    return otherwise ? { kind, written, scope, path, instance: otherwise.instance } : undefined;
  }

  /**
   * Where the usage `f` SUBSETS a feature (`part p2 :> p1;` in `part def W`)
   * that an instance of the element it is a feature of reads otherwise (`part
   * w : W { part :>> p1 { attribute :>> load = 50.0; } }`): what it answers,
   * that instance first; else `undefined`. Every w's p2 is one of w's p1s, so
   * its load is 50, but the walk reads p2 in w as W's own — its features are
   * W's p2's, through W's p1 ({@link walk}) — never as one of what w's p1 is:
   * `constraint k { w.p2.load <= 5.0 }` and W's `c { p2.load <= 5.0 }` read
   * T0's 1, true on all four surfaces, and no row was filed for w (sa7). So
   * each reading through `f` abstains ({@link satisfierTaint}), W's own too,
   * which stands for every W. The test is {@link pathOtherwise}'s: the names
   * below the subsetted feature, read in the element it is a feature of — the
   * first namespace outward from `f`'s owner that has it, else the feature's
   * own owner — read otherwise in a context that specialises that element
   * ({@link instanceReadingOtherwise}). A feature of a package is one instance
   * (v9's `attribute x :> Common::x`), read alike wherever it is read. Asked
   * once per usage, by {@link subsettingTaint} alone.
   */
  subsettingOtherwise(f: ElementRecord): ReadOtherwise | undefined {
    const hit = this.subsettingAsked.get(f.id);
    if (hit !== undefined) return hit ?? undefined;
    const answer = f.attrs.isLibrary !== true && f.ownerId != null && isUsage(f.eClass) ? this.subsettingOtherwiseOf(f) : undefined;
    this.subsettingAsked.set(f.id, answer ?? null);
    return answer;
  }

  /**
   * {@link subsettingOtherwise}, worked out: the feature `f` subsets that a context reads otherwise — of several, the
   * one with the lowest qualified name, not the first the relations were written in.
   */
  private subsettingOtherwiseOf(f: ElementRecord): ReadOtherwise | undefined {
    let best: { answer: ReadOtherwise; key: string } | undefined;
    for (const r of this.model.relationshipsFrom(f.id)) {
      if (r.eClass !== 'Subsetting' && r.eClass !== 'ReferenceSubsetting') continue;
      for (const t of r.target ?? []) {
        const g = this.model.get(t);
        const path = g ? this.nameOf(g) : undefined;
        if (!g || g.id === f.id || g.attrs.isLibrary === true || !isUsage(g.eClass) || path === undefined) continue;
        let scope: ElementRecord | undefined;
        const seen = new Set<ElementId>();
        for (let cur: ElementId | null = f.ownerId; cur != null && !seen.has(cur); cur = this.model.get(cur)?.ownerId ?? null) {
          seen.add(cur);
          if (this.features(cur).some((x) => x.id === g.id)) {
            scope = this.model.get(cur);
            break;
          }
        }
        scope ??= g.ownerId != null ? this.model.get(g.ownerId) : undefined;
        if (!scope || isPackage(scope)) continue;
        const names = [...this.denote(scope.id).keys()].filter((k) => k === path || k.startsWith(`${path}.`));
        const otherwise = names.length > 0 ? this.instanceReadingOtherwise(`${f.id} subsetting`, scope, names) : undefined;
        if (!otherwise) continue;
        const key = this.qualifiedNameOf(g.id);
        if (!best || key < best.key) best = { answer: { kind: 'subsetting', written: f, scope, path, instance: otherwise.instance, redefined: g }, key };
      }
    }
    return best?.answer;
  }

  /**
   * The usage `g` is SUBSETTED by a usage `f` of the same owner (`part p2 :> p1;` in `part def W`, `p1` here) that an
   * instance of that owner reads otherwise (`part w : W { part :>> p2 { attribute :>> load = 50.0; } }`): what it
   * answers, that instance first; else `undefined`. Every w's p2 is one of w's p1s, and w's only one when both are
   * `[1]`, so `w.p1.load` is 50; the walk reads p1 at W's own values (`T0`'s 1) and the rows over it — W's `c {
   * p1.load <= 5.0 }`, a package's `k { w.p1.load <= 5.0 }` and its negation — held on all four surfaces (RV1).
   * The test is {@link subsettingOtherwiseOf}'s turned round, for a usage of a definition or a part: the names
   * below the subsetter `f` read otherwise in a context that specialises the owner. Multiplicity is not read, so
   * a `p1[0..*]` that other members fill is withdrawn too. Asked once per subsetting, by {@link subsettingTaint}.
   */
  subsettedOtherwise(f: ElementRecord, g: ElementRecord): ReadOtherwise | undefined {
    if (f.attrs.isLibrary === true || g.attrs.isLibrary === true || f.id === g.id || f.ownerId == null) return undefined;
    if (!isUsage(f.eClass) || !isUsage(g.eClass)) return undefined;
    const scope = this.model.get(f.ownerId);
    const path = this.nameOf(f);
    // A subsetter that says something of its own, declared where `g` is a feature: in an instance (`part w : W { part q
    // :> p1 { attribute :>> load = 50.0; } }`; its own subsetters and its own supers' too, so a chain `r :> q :> p1`
    // it declares reaches p1), in the definition (`part def W { part p1; part q :> p1 { … } }`) or in a specialisation
    // of it. That instance, or every instance of that definition, reads `g` otherwise; the instance is `scope` itself.
    // It says something of its own by what it declares below it, by a value it states (`attribute y :> x = 50.0;`), or
    // through its type (`part q : Q50 :> p1;` over a Q50 that redefines a feature).
    const inScope = scope !== undefined && !isPackage(scope) && this.features(scope.id).some((x) => x.id === g.id);
    if (inScope && this.saysOwnOver(f, g)) {
      return { kind: 'subsetting', written: g, scope: scope!, path: path ?? '', instance: isUsage(scope!.eClass) ? scope : undefined, subsetter: f };
    }
    // A subsetter a package declares (`part u3 :> u1 { … }` beside the package's `part u1`) says it of the one usage u1 is.
    const says = !inScope && this.saysOwnOver(f, g, true);
    if (says && scope !== undefined && isPackage(scope) && g.ownerId === scope.id) {
      return { kind: 'subsetting', written: g, scope, path: this.nameOf(g) ?? '', instance: undefined, subsetter: f, chain: true };
    }
    // The same where `g` is NOT a feature of what the subsetter is declared in: it names it through a path (`part q :>
    // sub.p1 { … }` in w, `part x :> w.p1 { … }` in a package, `part q :> w.p1 { … }` in a usage of w), and every usage of
    // what `g` is a feature of is read as the element has it. The usage it names is `g`, which is what the mapper keeps.
    if (says) {
      const home = g.ownerId != null ? this.model.get(g.ownerId) : undefined;
      if (home && !isPackage(home) && home.attrs.isLibrary !== true) {
        return { kind: 'subsetting', written: g, scope: home, path: this.nameOf(g) ?? '', instance: undefined, subsetter: f, chain: true };
      }
    }
    if (!scope || isPackage(scope) || path === undefined) return undefined;
    const names = [...this.denote(scope.id).keys()].filter((k) => k === path || k.startsWith(`${path}.`));
    const otherwise = names.length > 0 ? this.instanceReadingOtherwise(`${f.id} subsetted`, scope, names) : undefined;
    return otherwise ? { kind: 'subsetting', written: g, scope, path, instance: otherwise.instance, subsetter: f } : undefined;
  }

  /**
   * Does the subsetter `f` of `g` say something of its own ({@link saysOwn}), state a value (`attribute y :> x = 50.0;`),
   * or have a type that does — one `g`'s does not have, with a redefinition, a constraint, a calculation or a binding
   * (`part q : Q50 :> p1;` over `part def Q50 :> T0 { attribute :>> load = 50.0; }`)? `g` may be several usages (the others a usage is joined with); `undefined`: any type. `strict`:
   * a value, a constraint, a calculation or a binding, at any depth below — not a bare redefinition (`attribute :>> M;`),
   * which states nothing the redefined feature does not.
   */
  saysOwnOver(f: ElementRecord, g: ElementRecord | readonly ElementRecord[] | undefined, strict = false): boolean {
    const own = (c: ElementRecord): boolean => c.eClass === 'ConstraintUsage' || c.eClass === 'CalculationUsage' || isBindingConnector(c);
    // What a usage declares below it that is a value, at any depth (a bare redefinition, `attribute :>> M;`, is none).
    const valued = (x: ElementRecord, depth: number): boolean =>
      this.model.children(x.id).some(
        (c) => c.attrs.isLibrary !== true && (own(c) || (isUsage(c.eClass) && (hasStatedValue(this.model, c) || (depth < 8 && valued(c, depth + 1))))),
      );
    if (strict ? hasStatedValue(this.model, f) || valued(f, 0) : this.saysOwn(f) || hasStatedValue(this.model, f)) return true;
    const typed = (x: ElementRecord): Map<ElementId, ElementRecord> => {
      const out = new Map<ElementId, ElementRecord>();
      // The definitions it is typed by (the usage a subsetter subsets is among `typesOf`, and is no type).
      for (const t of this.model.typesOf(x.id)) {
        if (isUsage(t.eClass)) continue;
        out.set(t.id, t);
        for (const general of generalizationsOf(this.model, t.id)) out.set(general.id, general);
      }
      return out;
    };
    // The types of the usage it subsets (or of the others it is joined with): a type they share says nothing of its own.
    const theirs = new Map<ElementId, ElementRecord>();
    for (const o of g === undefined ? [] : Array.isArray(g) ? g : [g as ElementRecord]) for (const [id, t] of typed(o)) theirs.set(id, t);
    // A type states a value for its instances by what it redefines (or declares with a value); a constraint, a calculation or a
    // binding it holds is a relation over them, which a subsetter's type that differs from the subsetted usage's does not change.
    for (const [id, t] of typed(f)) {
      if (theirs.has(id) || t.attrs.isLibrary === true) continue;
      const states = this.model.children(id).some(
        (c) =>
          c.attrs.isLibrary !== true &&
          !own(c) &&
          isUsage(c.eClass) &&
          (strict ? hasStatedValue(this.model, c) || valued(c, 1) : redefinedClosure(this.model, c).length > 0),
      );
      if (states) return true;
    }
    return false;
  }

  /**
   * The context of `scope` that reads `names` — spelled in `scope` — otherwise
   * than `scope` does, as a relation written there would be read anew in it:
   * one that specialises `scope` ({@link changingContexts}, under the pseudo
   * relation `key`), or, `scope` a usage below another instance (`part def Sys {
   * part w : W { … } }`), a binding above it that reads them otherwise there
   * ({@link boundAbove}; `instance` `undefined` past a cap) — else `undefined`.
   */
  private instanceReadingOtherwise(
    key: string,
    scope: ElementRecord,
    names: readonly string[],
  ): { instance: ElementRecord | undefined } | undefined {
    const listed = this.contextsOf({ id: key, ownerId: scope.id }, names).listed;
    if (listed.length > 0) return { instance: listed[0] };
    if (!isUsage(scope.eClass)) return undefined;
    const seen = new Set<ElementId>();
    let nested = false;
    for (let o = scope.ownerId != null ? this.model.get(scope.ownerId) : undefined; o && !seen.has(o.id); o = o.ownerId != null ? this.model.get(o.ownerId) : undefined) {
      seen.add(o.id);
      if ((isDefinition(o.eClass) && !isPackage(o)) || (isUsage(o.eClass) && this.specialisersOf(o.id).length > 0)) nested = true;
    }
    const above = nested ? this.boundAbove(scope.id, names) : undefined;
    return above === undefined ? undefined : { instance: 'pastCap' in above ? undefined : above };
  }

  /**
   * Does a usage say something of its own below it — a feature with a value
   * or a redefinition, a constraint (asserted or not), a calculation, or a
   * binding ({@link instanceBelow})?
   */
  saysOwn(f: ElementRecord): boolean {
    return this.model.children(f.id).some(
      (c) =>
        c.eClass === 'ConstraintUsage' ||
        c.eClass === 'CalculationUsage' ||
        isBindingConnector(c) ||
        (isUsage(c.eClass) && (hasStatedValue(this.model, c) || redefinedClosure(this.model, c).length > 0)),
    );
  }

  /**
   * The value a feature that states NONE reads as a redefinition — an implicit
   * connector-end copy included — where its own context changes what that
   * value reads, so it is read there ({@link valueRef} with `at`): p's copy of
   * P's `m2 = 10.0 - load` (`bind w2 = p.m2`) in a `p` whose `:>> load =
   * 50.0` overrides a `default` is −40. `undefined` for every other feature —
   * where the context changes nothing, the copy reads the value it redefines
   * by that feature's own name ({@link carrier}).
   */
  redefinedValueOf(f: ElementRecord): (ValueRef & { at: ElementId }) | undefined {
    if (f.ownerId == null || this.statedValue(f) !== undefined) return undefined;
    // Most features redefine nothing, or nothing that states a value: answered
    // before any walk.
    this.redefining ??= new Set(this.model.ofKind('Redefinition').flatMap((r) => r.source ?? []));
    if (!this.redefining.has(f.id)) return undefined;
    if (!redefinedClosure(this.model, f).some((g) => this.statedValue(g) !== undefined)) return undefined;
    const name = this.nameOf(f);
    if (name === undefined) return undefined;
    const d = this.denote(f.ownerId).get(name);
    if (!d || d.feature !== f) return undefined;
    const ref = this.valueRef(d);
    return ref && ref.at !== undefined && ref.target !== f ? { target: ref.target, at: ref.at } : undefined;
  }

  /**
   * The symbol the verification lane reads a name that denotes `d` by — one
   * per INSTANCE of the feature whose value it reads: `R::g1::g` and
   * `R::g2::g` for `g1.g` and `g2.g` over `part def G { attribute g; }`, where
   * one symbol `R::G::g` made `g1.g == g2.g` PROVED of two values nothing
   * relates; `R::p::m2` for `p.m2`, whose value is p's own. The feature's own
   * qualified name where the instance is its generic one (the name read where
   * it is declared, or through a subject nothing binds), and where its value
   * is the same in every instance — a literal, or a value over literals that
   * the instance changes nothing of ({@link pinnedIn}): an instance symbol
   * there would be one more name for one number.
   */
  symbolOf(d: Denotation): string {
    const target = this.carrier(d.reader, d.feature);
    const own = this.qualifiedNameOf(target.id);
    const name = this.nameOf(d.feature);
    if (name === undefined) return own;
    const symbol = `${d.instance}::${name}`;
    // The generic reading needs no more asking; another one is its own unless pinned.
    return symbol === own || this.pinnedIn(d.reader, target) ? own : symbol;
  }

  /**
   * The symbol of each of `paths` read by `el` — its owner's scope first,
   * then its own ({@link symbolOf}) — for the paths read through an instance
   * of their own, with the instance it is read in, the reader, and the feature
   * whose value it is ({@link valueRef}): what an engine that gives the
   * instance its own symbol must read there too — that value, and every
   * relation the reader's types hold of each of their instances. `instance`
   * re-roots the reading where `el` is a relation of its owner read for one of
   * the owner's INSTANCES (`load` in P's assert read for `R::p` is
   * `R::p::load`). A path whose symbol is its feature's own qualified name is
   * left out.
   */
  instanceReadings(el: ElementRecord, paths: readonly string[], instance?: string): Map<string, InstanceReading> {
    const out = new Map<string, InstanceReading>();
    const roots = [el.ownerId, el.id].filter((c): c is ElementId => c != null);
    const rebase = (symbol: string, root: ElementId): string => {
      if (instance === undefined) return symbol;
      const own = root === el.ownerId;
      const from = this.instanceNameOf(own ? root : el.id);
      const to = own ? instance : `${instance}::${effectiveNameOf(this.model, el) ?? el.declaredShortName ?? `«${el.eClass}»`}`;
      if (symbol === from) return to;
      return symbol.startsWith(`${from}::`) ? `${to}${symbol.slice(from.length)}` : symbol;
    };
    for (const path of paths) {
      for (const root of roots) {
        const d = this.denote(root).get(path);
        if (!d) continue;
        const target = this.carrier(d.reader, d.feature);
        // A value the same in every instance keeps its own symbol, however read.
        const own = this.symbolOf(d);
        const symbol =
          instance === undefined || (own === this.qualifiedNameOf(target.id) && this.pinnedIn(d.reader, target))
            ? own
            : rebase(own, root);
        if (symbol !== this.qualifiedNameOf(target.id)) {
          const ref = this.valueRef(d);
          out.set(path, {
            symbol,
            instance: rebase(d.instance, root),
            reader: d.reader,
            enclosing: d.enclosing.map((e) => ({ instance: rebase(e.instance, root), reader: e.reader })),
            feature: target,
            target: ref?.target ?? target,
            ...(ref?.at !== undefined ? { at: ref.at } : {}),
          });
        }
        break;
      }
    }
    return out;
  }

  /**
   * Is `f`'s value, read in `contextId`, the same in EVERY instance — a
   * literal; a value over names that are all such values where it is written,
   * which `contextId` changes nothing of ({@link sameIn}); a redefinition that
   * states nothing of a value that is ({@link carrier}); a feature an asserted
   * equation defines over such values? A feature with no value, a value a
   * binding holds, and one whose inputs the context changes are not: each
   * instance has its own ({@link symbolOf}).
   */
  pinnedIn(contextId: ElementId, f: ElementRecord): boolean {
    const key = `${contextId} ${f.id}`;
    const hit = this.pinned.get(key);
    if (hit !== undefined) return hit;
    if (this.pinning.has(key)) return false;
    this.pinning.add(key);
    let answer: boolean;
    try {
      answer = this.pinnedUncached(contextId, f);
    } finally {
      this.pinning.delete(key);
    }
    this.pinned.set(key, answer);
    return answer;
  }

  private pinnedUncached(contextId: ElementId, f: ElementRecord): boolean {
    // A `default` a binding holds ({@link defaultGivesWay}), or one a held
    // redefinition falls through to somewhere ({@link
    // BindingEnds.heldSomewhere}), is another value in each instance it reads
    // (F8, `held-redef`): its symbol is the instance's own.
    if (defaultGivesWaySomewhere(this.model, f)) return false;
    // So is one an asserted equation of an enclosing element defines in some
    // instance (H5, {@link assertHeldInSome}): q1's p's x is 50, every other P's 2.
    if (assertHeldInSome(this.model, f)) return false;
    // A literal is the one value in every instance — one a binding it
    // contradicts contradicts in every instance too.
    const v = this.statedValue(f);
    if (typeof v === 'number' || typeof v === 'boolean') return true;
    if (typeof v === 'string' && isQuoted(v.trim())) return true;
    if (this.contradiction(f) || this.clash(contextId, f)) return false;
    if (typeof v === 'string') {
      const s = v.trim();
      if (f.ownerId == null || (f.ownerId !== contextId && !this.sameIn(contextId, f))) return false;
      return this.namesPinnedIn(f.ownerId, namesOfValue(s));
    }
    const g = this.carrier(contextId, f);
    if (g !== f) return this.pinnedIn(contextId, g);
    const name = this.nameOf(f);
    if (name === undefined || f.ownerId == null) return false;
    const site = this.of(contextId, name).length > 0 ? contextId : this.of(f.ownerId, name).length > 0 ? f.ownerId : undefined;
    if (site === undefined || (site !== contextId && !this.sameIn(contextId, f, site))) return false;
    return this.of(site, name).every((eq) => this.namesPinnedIn(site, refsIn(eq.definition, eq.literals)));
  }

  /** Is every one of `names`, read in `contextId`, a value the same in every instance ({@link pinnedIn})? */
  private namesPinnedIn(contextId: ElementId, names: readonly string[]): boolean {
    const here = this.denote(contextId);
    for (const n of names) {
      const d = here.get(n);
      if (!d || !this.pinnedIn(d.reader, this.carrier(d.reader, d.feature))) return false;
    }
    return true;
  }

  /**
   * Where the asserted equations that define the valueless feature a bare
   * `name` denotes in `contextId` are written, and the context they are read
   * IN, when none in `contextId` may: the feature's owner — or the nearest
   * feature it redefines with one — read there when `contextId` changes
   * nothing they read ({@link inheritedSite}), and in `contextId` where it
   * does (the definition is a fact of every instance, over that instance's
   * names). `undefined` when none defines it.
   */
  definitionReadIn(contextId: ElementId, name: string): { site: ElementId; at: ElementId } | undefined {
    if (this.of(contextId, name).length > 0) return undefined;
    const feature = this.feature(contextId, name);
    if (!feature) return undefined;
    const site = this.definitionOwner(feature);
    if (site === undefined || site === contextId) return undefined;
    return { site, at: this.sameIn(contextId, feature, site) ? site : contextId };
  }

  /**
   * Does `contextId` read `feature`'s stated value otherwise than where it is
   * written because an asserted equation of an enclosing context defines a
   * name the value reads there, by its dotted path ({@link reachingAssert})?
   * B1's `p.y`, over P's `y = x * 2.0` and the package's `assert constraint {
   * p.x == 3.0 }`, is p's own: 6, where P's x has no value.
   */
  private changedByAssert(contextId: ElementId, feature: ElementRecord): boolean {
    if (!this.anyAsserted()) return false;
    const stated = this.statedOf(feature);
    if (typeof stated.value !== 'string') return false;
    stated.names ??= namesOfValue(stated.value);
    return stated.names.some((n) => this.reachingAssert(contextId, n) !== undefined);
  }

  /**
   * The asserted equation of an ENCLOSING context that defines, by its DOTTED
   * path, the valueless feature a bare `name` denotes in `contextId` — `assert
   * constraint { p.x == 3.0 }` in the package, read at `part p : P` whose P
   * declares `x` with no value: p's x is 3 (class C). The
   * path is the chain of usages that own one another from that context down
   * to `contextId`, then `name`; `site` writes the equations. Only one that
   * reads no name defines here — the same value in every instance the context
   * stands for; one over names is read per instance (H5's enclosing rule).
   * Nor a feature that writes a value, or a `default`: an equation against a
   * value is checked against it, and one over a default is that enclosing
   * rule's too. Nor one a binding gives a value, nor one two asserts give
   * different values. `undefined` when none does.
   */
  reachingAssert(
    contextId: ElementId,
    name: string,
  ): { site: ElementId; path: string; equations: readonly DefiningEquation[] } | undefined {
    if (name.includes('.') || !this.anyAsserted()) return undefined;
    const key = `${contextId} ${name}`;
    if (!this.reaching.has(key)) this.reaching.set(key, this.reachingUncached(contextId, name) ?? null);
    return this.reaching.get(key) ?? undefined;
  }

  private reachingUncached(
    contextId: ElementId,
    name: string,
  ): { site: ElementId; path: string; equations: readonly DefiningEquation[] } | undefined {
    const f = this.feature(contextId, name);
    if (!f) return undefined;
    // A binding that joins the feature — its own end (the implicit end copy
    // `bind p.x = L` makes), or one it redefines — gives it the binding's
    // value, against which the assert is checked, not read (RB). So does a
    // binding, or a value, that equates a part on the path with another part
    // (`bind r = s`: q's r is s, whose x the assert does not define).
    const ends = bindingEndsOf(this.model);
    const fixed = (g: ElementRecord): boolean => ends.has(g.id) || (g.attrs.value !== undefined && g.attrs.value !== null);
    if ([f, ...redefinedClosure(this.model, f)].some(fixed)) return undefined;
    const path = [name];
    for (let cur = this.model.get(contextId); cur && isUsage(cur.eClass) && cur.ownerId != null; ) {
      const owner = this.model.get(cur.ownerId);
      const n = this.nameOf(cur);
      if (!owner || owner.attrs.isLibrary === true || n === undefined || fixed(cur)) return undefined;
      path.unshift(n);
      const equations = this.of(owner.id, path.join('.'));
      if (equations.length > 0) {
        // Two asserts that give it different values leave it undecided (`two-values`).
        const first = JSON.stringify([equations[0]!.definition, [...equations[0]!.literals]]);
        return equations.every(
          (eq) => refsIn(eq.definition, eq.literals).length === 0 && JSON.stringify([eq.definition, [...eq.literals]]) === first,
        )
          ? { site: owner.id, path: path.join('.'), equations }
          : undefined;
      }
      cur = owner;
    }
    return undefined;
  }

  /** Where `f`'s asserted definitions are written: its owner, else the owner of the nearest feature it redefines that has one. */
  private definitionOwner(f: ElementRecord): ElementId | undefined {
    for (const g of [f, ...redefinedClosure(this.model, f)]) {
      const n = this.nameOf(g);
      if (n === undefined || g.ownerId == null) continue;
      if (this.of(g.ownerId, n).length > 0) return g.ownerId;
      if (hasStatedValue(this.model, g)) return undefined;
    }
    return undefined;
  }

  /**
   * {@link chainSite}, read in the instance the chain names: the valueless
   * feature a dotted chain ends at, where its asserted definition is written,
   * and the context it is read IN — where it is written when the usage the
   * chain reads it through changes nothing it reads, else that usage. `p.e`,
   * over P's `e == load * 2.0` and a `p` whose `:>> load = 50.0` overrides a
   * `default`, is 100. `undefined` when the chain ends at no such feature.
   */
  chainDefinition(
    contexts: readonly ElementId[],
    path: string,
  ): { feature: ElementRecord; site: ElementId; at: ElementId } | undefined {
    if (!path.includes('.')) return undefined;
    const end = this.chain(contexts, path);
    if (!end || !end.clean || !end.usage) return undefined;
    const { feature } = end;
    const name = this.nameOf(feature);
    if (!name || hasStatedValue(this.model, feature)) return undefined;
    const site =
      end.via !== undefined && this.of(end.via, name).length > 0 ? end.via : this.definitionOwner(feature);
    if (site === undefined) return undefined;
    const same = site === end.usage.id || this.sameIn(end.usage.id, feature, site);
    return { feature, site, at: same ? site : end.usage.id };
  }

  /**
   * The feature a dotted chain ends at, walked as every scope walks it — its
   * head among the first of `contexts` that has it, each later link among the
   * effective features of the USAGE before it (its own (re)definitions first,
   * then what its types declare) — with the usage the last link was read
   * through, as `via`. `clean` is kept for the callers: a chain through the
   * usage always reads the feature the usage has. `undefined` when the chain
   * does not resolve.
   */
  chain(
    contexts: readonly ElementId[],
    path: string,
  ): { feature: ElementRecord; usage?: ElementRecord; via?: ElementId; clean: boolean } | undefined {
    const [head, ...rest] = path.split('.');
    let feature: ElementRecord | undefined;
    let owner: ElementId | undefined;
    for (const c of contexts) {
      feature = this.byName(c).get(head!);
      owner = c;
      if (feature) break;
    }
    let usage: ElementRecord | undefined;
    let via: ElementId | undefined;
    for (const segment of rest) {
      if (!feature || owner === undefined) return undefined;
      // A subject something binds is read through what it stands for, as the walk reads it.
      const into = this.subjectOf(owner, feature) ?? feature;
      const next = this.byName(into.id).get(segment);
      if (!next) return undefined;
      via = into.id;
      usage = into;
      owner = into.id;
      feature = next;
    }
    return feature ? { feature, ...(usage ? { usage } : {}), ...(via !== undefined ? { via } : {}), clean: true } : undefined;
  }

  /**
   * Does a name that denotes `mine` in `contextId` read the value `g` gives —
   * `g` itself, the feature whose value `mine` reads ({@link carrier}), or,
   * where neither states nor defines anything, the valueless feature `mine`
   * redefines (an implicit connector-end copy of a port, `attribute :>> x;`
   * of an `x` with no value: both are the one unknown) — or the same literal,
   * restated?
   *
   * Not a redefinition that states nothing of its own but CHANGES what lies
   * below it — `part :>> e { attribute :>> load = 50.0; }`, `part :>> e : E2`:
   * a chain through it reads another feature than one through `g`.
   */
  readsAs(contextId: ElementId, mine: ElementRecord, g: ElementRecord): boolean {
    if (mine === g || this.carrier(contextId, mine) === g) return true;
    // A redefinition that restates the literal it redefines reads that value.
    if (isLiteralRestatement(mine, g)) return true;
    if (this.statesOrDefines(contextId, mine) || this.statesOrDefines(contextId, g)) return false;
    if (changesBelow(this.model, mine)) return false;
    return redefinedClosure(this.model, mine).some((h) => h.id === g.id);
  }

  /** Does `f` state a value, or have an asserted definition where it is written or in `contextId`? */
  private statesOrDefines(contextId: ElementId, f: ElementRecord): boolean {
    if (hasStatedValue(this.model, f)) return true;
    const name = this.nameOf(f);
    if (name === undefined) return false;
    return (f.ownerId != null && this.of(f.ownerId, name).length > 0) || this.of(contextId, name).length > 0;
  }

  /**
   * Is `feature`'s value — its stated value expression, a calculation's
   * body, or the definition the asserted equations in `site` give it — the
   * same read in `contextId` as where it is written?
   *
   * Every evaluator reads such a value where it is WRITTEN, over the names
   * there: P's `calc margin { 10.0 - load }` is P's arithmetic over P's
   * `load`. Read in a context that inherits it (`part p : P`, `part def S :>
   * P`), or through a chain (`p.margin`), that is the value the context has
   * exactly when the context changes nothing it reads — no feature of the
   * context redefines one with a value of its own, by name or by an unnamed
   * `:>>`, transitively through the values and definitions those names have.
   * Each name is compared WHOLE, as the walk resolves it in both places
   * ({@link denote}) — `e.load` and a nested bare `load` reach p's own `load`
   * through `part :>> e { … }` — and one feature read through two usages is
   * the same only where its value is the same in both (`p.m2` through Q's `p`
   * and through q's `:>> p`).
   * Where one does (`:>> load = 50.0` over a `default`, making margin −40),
   * the value is the context's own: read IN the context, over its names
   * ({@link valueRef}), and by a symbol of its own ({@link symbolOf}) — it
   * was read as P's (a false proof), then as no value at all (a refusal).
   * Where none does, every such context reads the one value written, once.
   * A redefinition that states nothing reads what it
   * redefines ({@link readsAs}) and changes nothing. A name the body reads
   * that is no feature of where it is written, and a valueless input a
   * binding holds, are not followed: answered as changed — but a name that
   * resolves neither where the value is written nor in the context reads the
   * same nothing in both, and leaves the value its own fault. `valueOnly` asks of
   * the value alone, for a feature the context's name does not denote itself
   * (the one a redefinition that states nothing reads: {@link carrier}).
   */
  sameIn(contextId: ElementId, feature: ElementRecord, site?: ElementId, valueOnly = false): boolean {
    const key = `${contextId} ${feature.id} ${site ?? ''} ${valueOnly}`;
    const hit = this.same.get(key);
    if (hit !== undefined) return hit;
    // A question that comes back to itself while it is asked (through a
    // redefinition that reads what it redefines: {@link carrier}) answers
    // "same" — it adds no change of its own — and nothing answered on the
    // strength of that guess is kept but the outermost answer.
    if (this.asking.has(key)) {
      this.guessed = true;
      return true;
    }
    const outermost = this.asking.size === 0;
    this.asking.add(key);
    try {
      const answer = this.sameUncached(contextId, feature, site, valueOnly);
      if (outermost || !this.guessed) this.same.set(key, answer);
      return answer;
    } finally {
      this.asking.delete(key);
      if (outermost) this.guessed = false;
    }
  }

  private sameUncached(contextId: ElementId, feature: ElementRecord, site: ElementId | undefined, valueOnly: boolean): boolean {
    const own = this.nameOf(feature);
    if (!valueOnly && own !== undefined && this.denote(contextId).get(own)?.feature !== feature) return false;
    const reads = this.readsOf(feature, site !== undefined ? [site] : []);
    if (reads === undefined) return false;
    const here = this.denote(contextId);
    for (const { owner, names } of reads) {
      const there = this.denote(owner);
      for (const name of names) {
        // Each name WHOLE — `e.load`, a nested bare `load` — as the walk
        // resolves it in both places: the head alone named P's `e` and p's `:>>
        // e` "the same", and missed the `load = 50.0` p's `e` holds.
        const g = there.get(name);
        const mine = here.get(name);
        // A name nothing resolves where the value is written, nor here, reads
        // nothing either place: unchanged, and the value keeps its own fault.
        if (g === undefined && mine === undefined) continue;
        if (g === undefined || mine === undefined || !this.sameReading(mine, g, name)) return false;
        // A name the context states twice or merges into a line it redefines one of ({@link NameClash}) is read nowhere
        // there: a value over it (`attribute Z = X + 1.0;` below `X :>> M, N;`) is the context's own, and has none.
        if (this.clashAlong(contextId, name) !== undefined && this.clashAlong(owner, name) === undefined) return false;
      }
    }
    return true;
  }

  /**
   * Does a name that denotes `mine` here read the value it reads where `g` is
   * what it denotes? The same feature read in the same context, or in another
   * that reads its value the same ({@link sameIn}: `p.m2` through Q's `p` and
   * through q's `:>> p`, whose `load` differs, is not); else `mine` reading
   * `g`'s value ({@link readsAs}) where that value is the same.
   */
  private sameReading(mine: Denotation, g: Denotation, name: string): boolean {
    const leaf = this.nameOf(g.feature) ?? name.slice(name.lastIndexOf('.') + 1);
    const site = g.reader !== g.feature.ownerId && this.of(g.reader, leaf).length > 0 ? g.reader : undefined;
    if (mine.feature === g.feature) {
      return mine.reader === g.reader || this.sameIn(mine.reader, g.feature, site);
    }
    return this.readsAs(mine.reader, mine.feature, g.feature) && this.sameIn(mine.reader, g.feature, site, true);
  }

  /**
   * The features `feature`'s value reads, transitively — through its stated
   * value, the asserted equations that define it (in `contextId` and where it
   * is written), and, for a redefinition that states nothing, the value it
   * redefines — each as resolved where the value is written AND in
   * `contextId` (a chain in the usage it is read through). The inputs a
   * context may change: for a value read where it is not ({@link sameIn}
   * false), the features whose change made it so.
   */
  dependencies(contextId: ElementId, feature: ElementRecord): ElementId[] {
    const out = new Set<ElementId>();
    const seen = new Set<string>();
    const visit = (f: ElementRecord, sites: readonly ElementId[], context: ElementId): void => {
      const key = `${f.id} ${context}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (!hasStatedValue(this.model, f)) for (const g of redefinedClosure(this.model, f)) visit(g, sites, context);
      const here = this.denote(context);
      for (const { owner, names } of this.readsOf(f, sites) ?? []) {
        const there = this.denote(owner);
        for (const name of names) {
          const mine = here.get(name);
          if (mine) {
            out.add(mine.feature.id);
            out.add(this.carrier(mine.reader, mine.feature).id);
          }
          const g = there.get(name);
          if (g) {
            out.add(g.feature.id);
            visit(g.feature, [owner], mine?.reader ?? context);
          }
        }
      }
    };
    visit(feature, [contextId], contextId);
    return [...out];
  }

  /**
   * The feature whose value a name read in `contextId` reads, where the
   * feature it denotes there, `f` (the most specific), states none and
   * nothing defines it where it is written or in `contextId`: the nearest
   * feature it redefines that states a value or has an asserted definition
   * where it is written — when that value is the same read in `contextId`
   * ({@link sameIn}, the value alone). `attribute :>> load;` in `part p : P`
   * reads P's `load = 1.0`. Else `f` itself: a redefinition of a valueless
   * feature (an implicit connector-end copy) is the feature the chain names.
   */
  carrier(contextId: ElementId, f: ElementRecord): ElementRecord {
    const key = `${contextId} ${f.id}`;
    const hit = this.carried.get(key);
    if (hit) return hit;
    const asked = this.carrying.get(key);
    if (asked) {
      this.guessed = true;
      return asked;
    }
    const answer = this.carrierUncached(contextId, f, key);
    if (this.asking.size === 0 || !this.guessed) this.carried.set(key, answer);
    return answer;
  }

  private carrierUncached(contextId: ElementId, f: ElementRecord, key: string): ElementRecord {
    if (hasStatedValue(this.model, f)) return f;
    const name = this.nameOf(f);
    if (name === undefined) return f;
    if (f.ownerId != null && this.of(f.ownerId, name).length > 0) return f;
    if (this.of(contextId, name).length > 0) return f;
    for (const g of redefinedClosure(this.model, f)) {
      const gName = this.nameOf(g);
      const defined = gName !== undefined && g.ownerId != null && this.of(g.ownerId, gName).length > 0;
      if (!hasStatedValue(this.model, g) && !defined) continue;
      // A default the binding of `f` overrides is no value `f` reads.
      if (!defined && boundOverDefault(this.model, f, g)) return f;
      // While asked, `f` reads `g` (what `sameIn` meets of `f` again).
      this.carrying.set(key, g);
      try {
        return this.sameIn(contextId, g, defined ? g.ownerId! : undefined, true) ? g : f;
      } finally {
        this.carrying.delete(key);
      }
    }
    return f;
  }

  /**
   * The other value `contextId` inherits under `f`'s name where `f` is the
   * feature its name keeps there ({@link inheritedNameClashes}), or
   * `undefined` — `part def C :> A, B` over A's `:>> load = 5.0` and B's `:>>
   * load = 7.0`, both of P's `load`. Every C is an A and a B, so its load is
   * 5 AND 7; reading A's 5 dropped B's binding silently, and `c.load <= 6.0`
   * was PROVED. The name reads no value there on any surface. `contradiction`
   * when both values are bindings (`=`, not `default`) that neither overrides
   * — the model states both — and `decided` when both are literals that
   * differ ({@link compareWrittenValues}).
   */
  clash(contextId: ElementId, f: ElementRecord): NameClash | undefined {
    const name = this.nameOf(f);
    if (name === undefined) return undefined;
    const clashes = this.clashesIn(contextId);
    // Under every name the feature stands for too: `attribute Y :>> X;` is the line X, M and N are filed under.
    for (const n of [name, ...this.aliasesOf(f)]) {
      const hit = clashes.get(n);
      if (hit && hit.kept === f) return hit.merged && hit.merged.name !== name ? { ...hit, merged: { ...hit.merged, name } } : hit;
    }
    // A feature that redefines one a merged line or a twice-stated feature holds is held too, whoever the name keeps
    // (a renamed redefiner beside the context's own redefinition of the line, written in either order).
    let held: NameClash[] | undefined = this.familyClashes.get(contextId);
    if (held === undefined) {
      held = [...new Set([...clashes.values()].filter((c) => c.family !== undefined))];
      this.familyClashes.set(contextId, held);
    }
    if (held.length === 0) return undefined;
    const mine = [f, ...redefinedClosure(this.model, f)];
    const hit = held.find((c) => mine.some((g) => c.family!.has(g.id)));
    if (!hit) return undefined;
    return hit.merged ? { ...hit, merged: { ...hit.merged, name } } : hit;
  }

  /**
   * Does `name`, read in `contextId`, denote a feature two values the context
   * it is read in inherit under one name ({@link clash})? Such a name reads
   * neither value on any surface, and nothing read through a binding stands in
   * for them (A.2.1): the binding reaches one of the two.
   */
  clashedIn(contextId: ElementId, name: string): boolean {
    return this.clashAlong(contextId, name) !== undefined;
  }

  /**
   * The {@link clash} a name read in `contextId` meets: the feature the name denotes, or a feature on its way — `s.X.x` below
   * a line of parts `part X :>> M, N;` that `s` redefines one of is below the one feature X, M and N are, whatever the leaf —
   * with the context that reads it.
   */
  clashAlong(contextId: ElementId, name: string): { contextId: ElementId; clash: NameClash } | undefined {
    const denoted = this.denote(contextId);
    for (let end = name.length; end > 0; end = name.lastIndexOf('.', end - 1)) {
      const d = denoted.get(name.slice(0, end));
      const clash = d !== undefined ? this.clash(d.reader, d.feature) : undefined;
      if (d !== undefined && clash !== undefined) return { contextId: d.reader, clash };
    }
    return undefined;
  }

  /**
   * Every {@link clash} of `contextId`, by name, once per context: the two
   * values it inherits under one name ({@link inheritedClashes}); the same
   * pair where the context's own feature of that name states nothing of its
   * own ({@link statesNothing}) — an implicit connector-end copy, or a
   * redefinition with no value (`attribute :>> L;`) — over two general types
   * that each redefine it, directly (MI1D's `part q : Q2, Q3 { bind p.load =
   * L; }`, whose Q2's and Q3's `L` are 50 and 60) or through a general (MI1's
   * `q : Q23` over `Q23 :> Q2, Q3`): the copy redefines Q's declared L and
   * states nothing, and q's L is no more the copy's than it is 50 or 60 (read
   * through it, q's p's load read P's default 1 on every surface, and no
   * `#clash` was filed at q); and each name a body of a general reads through
   * that general's owners that the context declares itself ({@link
   * lexicalShadows}).
   */
  clashesIn(contextId: ElementId): ReadonlyMap<string, NameClash> {
    let out = this.clashes.get(contextId);
    if (!out) {
      out = new Map(this.inheritedClashes(contextId));
      const own = this.byName(contextId);
      const transparent = (f: ElementRecord): boolean => f.ownerId === contextId && statesNothing(this.model, f);
      if ([...own.values()].some(transparent)) {
        for (const [name, clash] of this.clashesOf(contextId, transparent, true)) {
          const mine = own.get(name);
          if (out.has(name) || mine === undefined || mine === clash.kept || !transparent(mine)) continue;
          out.set(name, { ...clash, kept: mine });
        }
      }
      for (const [name, shadow] of this.lexicalShadows(contextId)) if (!out.has(name)) out.set(name, shadow);
      for (const [name, merged] of this.mergedLines(contextId)) if (!out.has(name)) out.set(name, merged);
      for (const [name, twice] of this.redefinedTwice(contextId)) if (!out.has(name)) out.set(name, twice);
      this.clashes.set(contextId, out);
    }
    return out;
  }

  /** The two values `contextId` inherits under one name ({@link inheritedNameClashes}), once per context. */
  private inheritedClashes(contextId: ElementId): ReadonlyMap<string, NameClash> {
    let out = this.inherited.get(contextId);
    if (!out) {
      out = this.clashesOf(contextId);
      this.inherited.set(contextId, out);
    }
    return out;
  }

  /**
   * {@link inheritedClashes}, worked out — with the own features `transparent`
   * says state nothing set aside. With `agreeing`, two values that are the
   * same are a clash too (`same`), where no other pair differs: ME6's `part s
   * : Q2, Q3 { bind p.load = L; }` over Q2's and Q3's `L = 50.0`, whose copy
   * redefines Q's declared L and reads neither 50 — so P's `load default =
   * 1.0` stood for s's p's load on every surface (`s.p.load == 50.0`
   * refuted). The copy gives way to them ({@link endValue}), and is read nowhere.
   */
  private clashesOf(contextId: ElementId, transparent?: (f: ElementRecord) => boolean, agreeing = false): Map<string, NameClash> {
    const out = new Map<string, NameClash>();
    for (const [name, [kept, ...others]] of inheritedNameClashes(this.model, contextId, transparent)) {
      const rk = valueSourceOf(this.model, kept!);
      if (!rk) continue;
      const keptOwner = kept!.ownerId;
      let agreed: NameClash | undefined;
      for (const other of others) {
        // The kept feature's owner specialises the other's: it masks it, as
        // a feature masks one by name ({@link contradictedBindingOf}).
        if (
          keptOwner != null &&
          other.ownerId != null &&
          generalizationsOf(this.model, keptOwner).some((g) => g.id === other.ownerId)
        ) {
          continue;
        }
        const ro = valueSourceOf(this.model, other);
        if (!ro || ro === rk || redefinedClosure(this.model, rk).includes(ro)) continue;
        const compared = compareWrittenValues(rk, ro);
        if (compared === 'same') {
          if (agreeing) agreed ??= { kept: kept!, other, keptValue: rk, otherValue: ro, contradiction: false, decided: false, same: true };
          continue;
        }
        const independent = !redefinedClosure(this.model, ro).includes(rk);
        const contradiction = independent && rk.attrs.defaultValue !== true && ro.attrs.defaultValue !== true;
        out.set(name, {
          kept: kept!,
          other,
          keptValue: rk,
          otherValue: ro,
          contradiction,
          decided: contradiction && compared === 'differs',
        });
        break;
      }
      if (agreed !== undefined && !out.has(name)) out.set(name, agreed);
    }
    return out;
  }

  /**
   * The names `contextId` declares itself that a body one of its general types
   * writes reads through that type's OWNERS — KerML resolves a name where it
   * is written, and the general's own features do not answer it there — as
   * another feature ({@link NameClash}'s `shadow`): DY1's `q : Q { part :>> p
   * { attribute L = 50.0; } }` beside Q's p's `:>> load = L`, which is Q's L
   * (1) in every Q. The walk answers a bare name in the context with the
   * context's own feature, so that body read q's p's L (50), and `q.p.m2 <=
   * 0.0` held on three surfaces. One walk cannot give the name both meanings,
   * so it reads neither there, on every surface ({@link clash}) — the
   * context's own bodies included, which read its own feature: weaker, never
   * false. A general whose own features answer the name (one the context
   * redefines) is read as before.
   */
  private lexicalShadows(contextId: ElementId): Map<string, NameClash> {
    const out = new Map<string, NameClash>();
    const context = this.model.get(contextId);
    if (!context || context.attrs.isLibrary === true || isKindOf(context.eClass, 'ConstraintUsage')) return out;
    const own = this.byName(contextId);
    for (const general of generalizationsOf(this.model, contextId)) {
      if (general.attrs.isLibrary === true) continue;
      const theirs = this.byName(general.id);
      for (const [name, writers] of this.namesWritten(general.id)) {
        const mine = own.get(name);
        if (mine === undefined || theirs.has(name) || out.has(name)) continue;
        for (const writer of writers) {
          const read = resolveFullName(this.model, name, writer.id);
          if (read === undefined || read.id === mine.id || redefinedClosure(this.model, mine).some((g) => g.id === read.id)) continue;
          out.set(name, {
            kept: mine,
            other: read,
            keptValue: valueSourceOf(this.model, mine) ?? mine,
            otherValue: valueSourceOf(this.model, read) ?? read,
            contradiction: false,
            decided: false,
            shadow: { writer, general },
          });
          break;
        }
      }
    }
    return out;
  }

  /**
   * The names `contextId` reads through ONE feature of a general type that redefines two features at once
   * (`attribute X :>> M, N default = 3.0;` in Q2) while a feature of the context's own redefines one of them (`part s
   * : Q2 { attribute :>> M = 1.0; attribute :>> N = 2.0; }`): `M` and `N` are then the one feature `X`, and the usage
   * gives it two values (MU, MUR). The mapper keeps each of s's redefinitions on the feature its name finds (Q's M, Q's
   * N: {@link resolveRedefinedFeature}), so every surface read two features, each with its own value (`s.M == 1.0`
   * and `s.N == 2.0` held on all four, and `s.N == 1.0` was refuted on a feature that is also M). One walk cannot give
   * the line both readings, so the context reads neither name ({@link NameClash}'s `merged`): weaker, never false.
   * A single redefinition of one of them (`:>> M = 4.0`) is the same line, and gives way the same; one of the line
   * itself (`:>> X = 5.0`) states one value for the one feature, and reads every name of it.
   */
  private mergedLines(contextId: ElementId): Map<string, NameClash> {
    const out = new Map<string, NameClash>();
    const context = this.model.get(contextId);
    if (!context || context.attrs.isLibrary === true || isKindOf(context.eClass, 'ConstraintUsage')) return out;
    // The features that redefine two at once, found once; most models hold none.
    this.redefiningTwo ??= (() => {
      const byLine = new Map<ElementId, ElementRecord[]>();
      for (const r of this.model.ofKind('Redefinition')) {
        const x = r.source?.[0] !== undefined ? this.model.get(r.source[0]) : undefined;
        if (!x || r.attrs.isLibrary === true || x.attrs.isLibrary === true || !isUsage(x.eClass)) continue;
        const targets = (r.target ?? []).flatMap((t) => this.model.get(t) ?? []);
        byLine.set(x.id, [...(byLine.get(x.id) ?? []), ...targets]);
      }
      for (const [id, targets] of byLine) if (new Set(targets.map((t) => t.id)).size < 2) byLine.delete(id);
      return byLine;
    })();
    if (this.redefiningTwo.size === 0) return out;
    const holders = [context, ...generalizationsOf(this.model, contextId)].filter((h) => h.attrs.isLibrary !== true);
    const lines: Array<{ line: ElementRecord; targets: ElementRecord[] }> = [];
    for (const h of holders) {
      for (const x of this.model.children(h.id)) {
        const targets = this.redefiningTwo.get(x.id);
        if (targets) lines.push({ line: x, targets: [...new Map(targets.map((t) => [t.id, t])).values()] });
      }
    }
    if (lines.length === 0) return out;
    const byName = this.byName(contextId);
    for (const { line, targets } of lines) {
      const ids = new Set(targets.map((t) => t.id));
      const another = holders.some((h) =>
        this.model.children(h.id).some(
          (f) =>
            f.id !== line.id &&
            isUsage(f.eClass) &&
            f.attrs.implicit !== true &&
            this.model.relationshipsFrom(f.id).some((r) => r.eClass === 'Redefinition' && (r.target ?? []).some((t) => ids.has(t))),
        ),
      );
      // A line that states no value, over targets that state different ones (`attribute X :>> M, N;` over M's `default
      // = 1.0` and N's `= 2.0`), has no one value to read: whichever came first was read, so the target order decided.
      const differing = line.attrs.value == null ? this.differingSources(targets) : [];
      if (!another && differing.length === 0) continue;
      for (const g of [line, ...targets]) {
        const name = effectiveNameOf(this.model, g);
        const kept = name !== undefined ? byName.get(name) : undefined;
        if (name === undefined || kept === undefined || out.has(name)) continue;
        out.set(name, { kept, other: line, keptValue: kept, otherValue: line, contradiction: false, decided: false, merged: { line, name, differing }, family: new Set([line.id, ...ids]) });
      }
    }
    return out;
  }

  /** The written values of `targets` that differ (the first pair that does, as sources), or `[]`: a firm one and a default count as different. */
  private differingSources(targets: readonly ElementRecord[]): ElementRecord[] {
    const sources = [...new Set(targets.map((t) => valueSourceOf(this.model, t)).filter((x): x is ElementRecord => x !== undefined))];
    for (const [i, a] of sources.entries()) {
      for (const b of sources.slice(i + 1)) {
        if (redefinedClosure(this.model, a).includes(b) || redefinedClosure(this.model, b).includes(a)) continue;
        if (compareWrittenValues(a, b) !== 'same') return [a, b];
      }
    }
    return [];
  }

  /**
   * The names `contextId` states TWICE (`part s : Q2 { :>> x = 5.0; :>> x = 6.0; }`): it redefines one feature more than
   * once, or declares a feature beside a redefinition of the same name (`attribute x = 5.0; attribute :>> x = 6.0;`),
   * and the statements do not all say the same thing — values that differ or are written in different units, a value
   * beside none (`attribute :>> x; attribute :>> x default = 3.0;`), or any nested content (`part :>> p { … } part
   * :>> p { … }`). The model states both for the one feature; the check, literal and numeric surfaces read whichever
   * came first, and the SMT one found the axioms inconsistent. The context reads no such name, nor a name below one
   * ({@link NameClash}'s `twice`): weaker, never false.
   */
  private redefinedTwice(contextId: ElementId): Map<string, NameClash> {
    const out = new Map<string, NameClash>();
    const context = this.model.get(contextId);
    if (!context || context.attrs.isLibrary === true || isKindOf(context.eClass, 'ConstraintUsage')) return out;
    const byName = this.byName(contextId);
    // Unnamed statements of one feature share a qualified name: what they state tells them apart, not the order they were written in.
    const key = (e: ElementRecord): string =>
      `${this.qualifiedNameOf(e.id)}\0${String(e.attrs.valueText ?? e.attrs.value ?? '')}\0${String(e.attrs.unit ?? '')}\0${e.attrs.defaultValue === true ? 'd' : 'f'}`;
    const byQn = (a: ElementRecord, b: ElementRecord): number => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
    // What the context states twice itself, and what a general type it specialises does (its `s : Q3` inherits both).
    for (const holder of [context, ...generalizationsOf(this.model, contextId)]) {
      if (holder.attrs.isLibrary === true) continue;
      // The usages the holder owns, joined where they redefine one feature or answer to one name: a component is the
      // statements of ONE feature, however many of the two ways of saying so reach it.
      const parent = new Map<string, string>();
      const find = (x: string): string => {
        let r = x;
        while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
        return r;
      };
      const join = (x: string, y: string): void => {
        for (const k of [x, y]) if (!parent.has(k)) parent.set(k, k);
        parent.set(find(x), find(y));
      };
      const users = new Map<string, ElementRecord>();
      const targets = new Map<string, ElementRecord>();
      for (const x of this.model.children(holder.id)) {
        if (!isUsage(x.eClass) || x.attrs.implicit === true) continue;
        users.set(x.id, x);
        const name = this.nameOf(x);
        if (name !== undefined) join(x.id, `n ${name}`);
        for (const r of this.model.relationshipsFrom(x.id)) {
          if (r.eClass !== 'Redefinition') continue;
          for (const t of r.target ?? []) {
            join(x.id, `t ${t}`);
            const g = this.model.get(t);
            if (g) targets.set(`t ${t}`, g);
          }
        }
      }
      const components = new Map<string, { xs: ElementRecord[]; ts: ElementRecord[] }>();
      for (const [id, x] of users) {
        if (!parent.has(id)) continue;
        const c = components.get(find(id)) ?? { xs: [], ts: [] };
        c.xs.push(x);
        components.set(find(id), c);
      }
      for (const [key, g] of targets) components.get(find(key))?.ts.push(g);
      for (const { xs, ts } of components.values()) {
        if (xs.length < 2) continue;
        xs.sort(byQn);
        ts.sort(byQn);
        const pair = xs.flatMap((a, i) => xs.slice(i + 1).filter((b) => !this.statesSame(a, b)).map((b) => [a, b] as const))[0];
        if (!pair) continue;
        const clash: Omit<NameClash, 'kept'> = {
          other: pair[1],
          keptValue: pair[0],
          otherValue: pair[1],
          contradiction: false,
          decided: false,
          twice: {
            target: ts[0] ?? xs[0]!,
            // A feature declared beside a redefinition of it (`attribute x = 5.0; attribute :>> x = 6.0;`) is stated twice, not redefined twice.
            redefines:
              ts.length > 0 &&
              xs.filter((x) => this.model.relationshipsFrom(x.id).some((r) => r.eClass === 'Redefinition' && (r.target ?? []).includes(ts[0]!.id))).length > 1,
            hasValues: pair[0].attrs.value != null && pair[1].attrs.value != null,
            byUnit: xs.every((a, i) => xs.slice(i + 1).every((b) => this.statesSame(a, b) || this.sameValueOtherUnit(a, b))),
          },
          family: new Set<ElementId>([...xs.map((x) => x.id), ...ts.map((t) => t.id)]),
        };
        for (const x of xs) {
          for (const name of [this.nameOf(x), ...this.aliasesOf(x)]) {
            const kept = name !== undefined ? byName.get(name) : undefined;
            if (name === undefined || kept === undefined || out.has(name)) continue;
            out.set(name, { ...clash, kept });
          }
        }
      }
    }
    return out;
  }

  /** Do `a` and `b` state the same quantity, written in different units (`5.0 [kg]`, `5000.0 [g]`), neither nested nor valueless? */
  private sameValueOtherUnit(a: ElementRecord, b: ElementRecord): boolean {
    const valued = (e: ElementRecord): boolean => e.attrs.value !== undefined && e.attrs.value !== null;
    return (
      valued(a) &&
      valued(b) &&
      (a.attrs.defaultValue === true) === (b.attrs.defaultValue === true) &&
      (a.attrs.unit ?? '') !== (b.attrs.unit ?? '') &&
      compareWrittenValues(a, b) === 'same' &&
      !this.model.children(a.id).some((c) => isUsage(c.eClass)) &&
      !this.model.children(b.id).some((c) => isUsage(c.eClass))
    );
  }

  /**
   * Is `f` one of several statements of a feature that all state the one quantity, in different units, in its owner
   * (`:>> x = 5.0 [kg]; :>> x = 5000.0 [g];`)? The statements agree, but the SMT lane pins a symbol to the magnitude
   * the file stores, in each statement's own unit, so it would find the axioms inconsistent: it carries none of them.
   */
  statedInOtherUnits(f: ElementRecord): boolean {
    return f.ownerId != null && this.clash(f.ownerId, f)?.twice?.byUnit === true;
  }

  /**
   * Do two statements of one feature in one context say the same thing — the same value in the same unit, both a
   * `default` or both firm, and nothing nested below either? A value beside none does not.
   */
  private statesSame(a: ElementRecord, b: ElementRecord): boolean {
    const valued = (e: ElementRecord): boolean => e.attrs.value !== undefined && e.attrs.value !== null;
    const nested = (e: ElementRecord): boolean => this.model.children(e.id).some((c) => c.attrs.implicit !== true && (isUsage(c.eClass) || isBindingConnector(c)));
    if (valued(a) !== valued(b) || nested(a) || nested(b)) return false;
    if (!valued(a)) return true;
    if ((a.attrs.defaultValue === true) !== (b.attrs.defaultValue === true)) return false;
    if ((a.attrs.unit ?? '') !== (b.attrs.unit ?? '')) return false;
    return compareWrittenValues(a, b) === 'same';
  }

  /**
   * Every {@link clash} that is a contradiction, once — at the most general
   * user context it arises in (`part def C :> A, B`, not every `part c : C`
   * too), in model order.
   */
  contradictoryClashes(): ReadonlyArray<{ context: ElementRecord; name: string; clash: NameClash }> {
    if (!this.reportedClashes) {
      const out: Array<{ context: ElementRecord; name: string; clash: NameClash }> = [];
      for (const x of this.model.all()) {
        if (x.attrs.isLibrary === true || x.attrs.implicit === true) continue;
        if (!isUsage(x.eClass) && !isDefinition(x.eClass)) continue;
        for (const [name, clash] of this.clashesIn(x.id)) {
          if (!clash.contradiction) continue;
          const inherited = generalizationsOf(this.model, x.id).some((g) => {
            if (g.attrs.isLibrary === true) return false;
            const there = this.clashesIn(g.id).get(name);
            return there !== undefined && there.keptValue === clash.keptValue && there.otherValue === clash.otherValue;
          });
          if (!inherited) out.push({ context: x, name, clash });
        }
      }
      this.reportedClashes = out;
    }
    return this.reportedClashes;
  }

  /**
   * The BINDING `f`'s stated value contradicts, or `undefined`
   * ({@link contradictedBindingOf}), once per feature.
   */
  contradiction(f: ElementRecord): BindingConflict | undefined {
    let hit = this.contradicted.get(f.id);
    if (hit === undefined) {
      hit = contradictedBindingOf(this.model, f) ?? null;
      this.contradicted.set(f.id, hit);
    }
    return hit ?? undefined;
  }

  /**
   * Where the asserted equations that define the valueless feature a bare
   * `name` denotes in `contextId` are read, when none in `contextId` may: the
   * feature's owner, when `contextId` INHERITS the feature and its definition
   * (`part def S :> P`, over P's `assert constraint { e == a * b }`) and
   * changes nothing the definition reads ({@link sameIn}). `undefined`
   * otherwise — and then the definition is read in `contextId` itself
   * ({@link definitionReadIn}), or nowhere: what a context comparing its
   * reading with its owner's asks ({@link changingContexts}).
   */
  inheritedSite(contextId: ElementId, name: string): ElementId | undefined {
    if (this.of(contextId, name).length > 0) return undefined;
    const feature = this.feature(contextId, name);
    const owner = feature?.ownerId;
    if (!feature || owner == null || owner === contextId || this.of(owner, name).length === 0) return undefined;
    return this.sameIn(contextId, feature, owner) ? owner : undefined;
  }

  /**
   * The valueless feature a dotted chain read in `contexts` ends at, and where
   * the asserted equations that define it are read — the usage the chain
   * reads it through, else its owner — when the usage changes nothing the
   * definition reads ({@link sameIn}): `p.e`, over `part p : P` and P's `e ==
   * a * b`, is P's e. `undefined` otherwise — where the usage changes what it
   * reads, it reads the definition itself ({@link chainDefinition}).
   */
  chainSite(contexts: readonly ElementId[], path: string): { feature: ElementRecord; site: ElementId } | undefined {
    if (!path.includes('.')) return undefined;
    const end = this.chain(contexts, path);
    if (!end || !end.clean || !end.usage) return undefined;
    const { feature } = end;
    const name = this.nameOf(feature);
    if (!name || hasStatedValue(this.model, feature)) return undefined;
    const site = [end.via, feature.ownerId].find((c): c is ElementId => c != null && this.of(c, name).length > 0);
    if (site === undefined) return undefined;
    return site === end.usage.id || this.sameIn(end.usage.id, feature, site) ? { feature, site } : undefined;
  }

  /**
   * The user contexts that SPECIALISE `typeId` — every usage typed by it and
   * every definition or usage that specialises it, transitively — in model
   * order. Implicit connector-end copies are no context of their own.
   */
  specialisersOf(typeId: ElementId): readonly ElementRecord[] {
    if (!this.specialised) {
      const out = new Map<ElementId, ElementRecord[]>();
      const add = (g: ElementRecord, x: ElementRecord): void => {
        if (g.attrs.isLibrary === true) return;
        const list = out.get(g.id);
        if (list) list.push(x);
        else out.set(g.id, [x]);
      };
      for (const x of this.model.all()) {
        if (x.attrs.isLibrary === true || x.attrs.implicit === true) continue;
        // A `satisfy R by x` specialises R, and what R specialises.
        const satisfied = this.satisfaction(x.id);
        if (satisfied) {
          for (const g of [satisfied.requirement, ...generalizationsOf(this.model, satisfied.requirement.id)]) add(g, x);
          continue;
        }
        if (!isUsage(x.eClass) && !isDefinition(x.eClass)) continue;
        for (const g of generalizationsOf(this.model, x.id)) add(g, x);
      }
      this.specialised = out;
    }
    return this.specialised.get(typeId) ?? [];
  }

  /**
   * The name a context is shown by: a `satisfy R by x`'s satisfier's
   * ({@link satisfaction}) — the instance it names, `q1.p`'s `R::q1::p` —
   * else the context's own effective qualified name.
   */
  contextName(contextId: ElementId): string {
    const satisfied = this.satisfaction(contextId);
    if (!satisfied) return this.qualifiedNameOf(contextId);
    return this.subjectInstance(contextId)?.instance ?? this.qualifiedNameOf(satisfied.satisfier.id);
  }

  /**
   * The contexts a relation `el` holds in that read it DIFFERENTLY from where
   * it is written: of the user contexts that specialise `el`'s owner ({@link
   * specialisersOf}), those where a name the body reads (`names`, as written)
   * denotes another feature — a redefinition with a value of its own, never a
   * redefinition that states nothing ({@link readsAs}) — or a value read
   * there and not in the owner, or the other way round (a derived value whose
   * inputs the context changes), or one defined by an asserted equation in
   * one and not in the other. A definition's constraints and asserts hold in
   * every context that specialises it, so each such context reads them anew;
   * one that reads every name exactly as an earlier one does adds nothing
   * (`part s : S` beside `part def S :> P { :>> load … }`).
   */
  changingContexts(el: ElementRecord, names: readonly string[]): ElementRecord[] {
    return this.contextsOf(el, names).listed;
  }

  /**
   * Is the context `contextId` one `el` is read in ({@link readingContexts})
   * only because a binding member is read there otherwise than where it is
   * written ({@link readsOtherwise}) — a context the binding's reading by
   * feature alone does not list? M7's `q2 : Q { :>> K = 25.0; }` reads Q's `L =
   * 2.0 * K`, which Q's `bind p.load = L` gives p's load, as its own 50: Q's `c
   * { p.load <= 5.0 }` is q2's own there. Every surface reads it at the
   * context's own instance (E7), as it reads one a binding above lists (F5) —
   * q2's load of 50 — except over a member stated twice there, or a binding
   * not read there ({@link boundStatedTwiceIn}). Read as the context reads its
   * names, not at its instance, it published a value the binding does not
   * give: over an asserted partner (`assert constraint { L == 2.0 * K }`), P's
   * default through the end copy, as Q2's `p.load` beside Q2's L of 50 (G340).
   */
  readsBoundOnly(el: ElementRecord, names: readonly string[], contextId: ElementId): boolean {
    const role = el.attrs.requirementRole;
    if ((role !== 'require' && role !== 'assume') || el.ownerId == null) {
      return !this.contextsOf(el, names).plain.has(contextId);
    }
    for (const c of this.model.children(el.ownerId)) {
      const r = c.attrs.requirementRole;
      if ((r !== 'require' && r !== 'assume') || typeof c.attrs.expression !== 'string') continue;
      const body = parseRelationBody(c.attrs.expression);
      if (body && this.contextsOf(c, refsIn(body.node, body.literals)).plain.has(contextId)) return false;
    }
    return true;
  }

  /**
   * Why a context {@link readsBoundOnly} lists is not read at its instance, or
   * `undefined` where it is. `'two-values'`: a binding of `el`'s owner joins
   * what `names` read, in the context `contextId`, to a component two of whose
   * members state a value there (A.3's `valued`, {@link classified}) — Q's `load
   * = 1.0` beside the bound `L = 2.0 * K`, read in `q2 : Q { :>> K = 25.0; }`:
   * the model states 1 and 50 for q2's load, and its instance reading reads the
   * first alone. `'unread'`: fail closed, where that binding is not read in the
   * context. Every surface leaves such a reading undecided ({@link
   * boundHereSentence}).
   */
  boundStatedTwiceIn(el: ElementRecord, names: readonly string[], contextId: ElementId): BoundHere | undefined {
    if (el.ownerId == null) return 'unread';
    const { readings } = bindingEnds(this.model);
    const own = readings.get(el.ownerId);
    const there = readings.get(contextId);
    if (!own || !there) return 'unread';
    const reads = this.boundReads(el.ownerId, names);
    for (const [path, r] of own) {
      if (!reads.has(r.feature)) continue;
      const x = there.get(path);
      if (!x) return 'unread';
      if (classified(this.model, contextId, x.component).valued.length > 1) return 'two-values';
    }
    return undefined;
  }

  /**
   * Does the context `contextId` read what `el` reads through a binding of
   * `el`'s owner otherwise than the owner does ({@link bindingReadingIn})? h2c's
   * `q : Q { :>> L = 50.0; }`, whose L Q's `bind p.load = L` carries into the
   * p.m2 Q's `c` reads, and M7's `q2 : Q { :>> K = 25.0; }`, whose K reaches the
   * bound L: the context's reading of `el` is carried by a binding (PI-3), so
   * it is an instance's reading, reported as one (`constraint-by-instance`).
   * Only where the binding carries it: a name the context redefines is its own
   * value there (`q : Q { :>> L = 500.0; }` under Q's `L <= 100.0`), and a
   * bound feature whose value is its own is no value carried in (Q's `defL { L
   * == 2.0 * K }` read in `Q2 :> Q { :>> K = 25.0; }`, L the binding's source).
   * So is a context in whose instances an asserted equation defines what a
   * bound partner's value reads, and nothing the relation reads itself ({@link
   * partnerReads}): R22B's `q2 : Q { assert constraint { K == 25.0 } }` (the
   * package's `q2.K == 25.0` for R27F) under Q's `L = 2.0 * K` and `bind load
   * = L` — the binding carries q2's K into load, as for M7's `:>> K = 25.0`. A
   * throw reads it so: the code an agent may not pass over.
   */
  readsThroughBinding(el: ElementRecord, names: readonly string[], contextId: ElementId): boolean {
    if (el.ownerId == null) return false;
    const there = this.denote(contextId);
    const here = this.denote(el.ownerId);
    const reads = this.boundReads(el.ownerId, names.filter((n) => there.get(n)?.feature.id === here.get(n)?.feature.id));
    if (reads.size === 0) return false;
    const own = bindingReadingIn(this.model, el.ownerId, el.ownerId, reads);
    if (own === undefined) return false;
    if (bindingReadingIn(this.model, el.ownerId, contextId, reads) !== own) {
      if (this.boundSources(el.ownerId, contextId, reads).some(({ path, sources }) => sources.some((p) => p !== path))) return true;
    }
    try {
      const partnered = this.partnerReads(el.ownerId, reads);
      return (
        partnered.size > reads.size &&
        assertedThrough(this.model, contextId, reads, true) === undefined &&
        assertedThrough(this.model, contextId, partnered, true) !== undefined
      );
    } catch {
      return true;
    }
  }

  /**
   * The member written in `rootId` that states the value a binding carries
   * there into what `names` read — C.1's anchor rule, the component's single
   * stated member: q's `:>> L = 50.0` for Q's `c { p.m2 >= 0.0 }` read in `q :
   * Q` over Q's `bind p.load = L` — or `undefined`: no binding carries one in,
   * more than one member could, or the one that does is written outside
   * `rootId` (M7's `L = 2.0 * K`, Q's own for every Q). Only the paths below
   * `under` are read (an instance's own, `p.` for q1's p in q1): a root of a
   * thousand instances is not scanned whole for each of them.
   */
  statedMember(rootId: ElementId, names: readonly string[], under = ''): ElementRecord | undefined {
    const reading = bindingEnds(this.model).readings.get(rootId);
    // A root that writes nothing of its own (`part a : T4;`) states no member: no reading is asked of it.
    if (reading === undefined || !this.model.children(rootId).some((c) => isUsage(c.eClass) && c.attrs.implicit !== true)) return undefined;
    const reads = this.boundReads(rootId, names);
    if (reads.size === 0) return undefined;
    for (const { path, sources } of this.boundSources(rootId, rootId, reads, under)) {
      const others = sources.filter((p) => p !== path);
      const member = others.length === 1 ? this.model.get(reading.get(others[0]!)?.feature ?? '') : undefined;
      for (let cur = member; cur; cur = cur.ownerId != null ? this.model.get(cur.ownerId) : undefined) {
        if (cur.id === rootId) return member;
      }
    }
    return undefined;
  }

  /**
   * Per path the binding reading of `rootId` holds one of `reads` at ({@link
   * bindingReadingIn}), the members that give its component its value in
   * `contextId` ({@link classified}): the stated ones, else the readable
   * defaults — of the paths below `under` alone, where one is given.
   */
  private boundSources(
    rootId: ElementId,
    contextId: ElementId,
    reads: ReadonlySet<ElementId>,
    under = '',
  ): Array<{ path: string; sources: readonly string[] }> {
    const { readings } = bindingEnds(this.model);
    const own = readings.get(rootId);
    const there = readings.get(contextId);
    const out: Array<{ path: string; sources: readonly string[] }> = [];
    if (!own || !there) return out;
    for (const [path, r] of own) {
      const x = path.startsWith(under) && reads.has(r.feature) ? there.get(path) : undefined;
      if (!x) continue;
      const { valued, readable } = classified(this.model, contextId, x.component);
      out.push({ path, sources: valued.length > 0 ? valued : readable });
    }
    return out;
  }

  /**
   * {@link changingContexts}, and the contexts the binding reading by feature
   * alone lists (`plain`, {@link bindingReadingIn}): a context is listed where
   * either lists it, so none a feature-only reading lists is ever dropped.
   */
  private contextsOf(
    el: Pick<ElementRecord, 'id' | 'ownerId'>,
    names: readonly string[],
  ): { listed: ElementRecord[]; plain: ReadonlySet<ElementId> } {
    // An answer worked out while the subsetting usages are listed reads none of them ({@link
    // subsettingsBeingListed}): it is kept apart from the one read once they are.
    const key = `${el.id} ${el.ownerId ?? ''} ${names.join(' ')}${subsettingsBeingListed(this.model) ? ' ~listing' : ''}`;
    const hit = this.changing.get(key);
    if (hit) return hit;
    const answer = this.contextsUncached(el, names);
    this.changing.set(key, answer);
    return answer;
  }

  private contextsUncached(
    el: Pick<ElementRecord, 'id' | 'ownerId'>,
    names: readonly string[],
  ): { listed: ElementRecord[]; plain: ReadonlySet<ElementId> } {
    const plain = new Set<ElementId>();
    const owner = el.ownerId;
    if (owner == null || names.length === 0) return { listed: [], plain };
    // The context with fewer usages around it first, whatever the text put first: only the first context of a reading is listed, and
    // a renamed redefinition written before its definition (`part p2 :>> p` in an instance of Q, Q declared below)
    // took the place of Q::p, whose group then was never made (e5-renamed, reversed). A stable sort: ties keep the text order.
    const usageDepth = (c: ElementRecord): number => {
      let n = 0;
      for (let cur = c.ownerId != null ? this.model.get(c.ownerId) : undefined; cur; cur = cur.ownerId != null ? this.model.get(cur.ownerId) : undefined) {
        if (isUsage(cur.eClass)) n++;
      }
      return n;
    };
    const contexts = [...this.specialisersOf(owner)].sort((a, b) => usageDepth(a) - usageDepth(b));
    if (contexts.length === 0) return { listed: [], plain };
    const ownAll = this.scope(owner, 'all');
    const ownValue = this.scope(owner, 'value');
    const reads = this.boundReads(owner, names);
    const ownBound = reads.size > 0 ? bindingReadingIn(this.model, owner, owner, reads) : undefined;
    const ownPlain = reads.size > 0 ? bindingReadingIn(this.model, owner, owner, reads, false) : undefined;
    const out: ElementRecord[] = [];
    const readings = new Set<string>();
    const plainReadings = new Set<string>();
    // A name read in the context through a binding, a value or a `satisfy`
    // this tool does not read ({@link equatedPartsRefusal}), where the owner
    // reads it through none, is the context's own: W's `pp.load` over `pp =
    // top.a`, read in `w : W { part :>> top = t50; }`, denotes T0's load in
    // both, but w's through its top, a value no surface reads through. Listed,
    // its row is read per instance and left undecided there; unlisted, W's own
    // reading (1, through W's top) stood for w's (50).
    const taint = equatedParts(this.model).unread.length > 0 ? equatedTaint(this.model) : undefined;
    const ownTainted = new Map<string, boolean>();
    // What the relation reads, with what the bindings it reads through read ({@link partnerReads}), once asked.
    let partnered: ReadonlySet<ElementId> | undefined;
    // The usages that subset a feature an instance reads otherwise, with what
    // reads through them ({@link subsettingTaint}) — none asked while they are
    // being listed: their own test is this walk ({@link
    // instanceReadingOtherwise}). `null`: listing them threw.
    let subsetting: ReadonlyMap<ElementId, ElementRecord> | null | undefined;
    if (!subsettingsBeingListed(this.model)) {
      try {
        const t = subsettingTaint(this.model).taint;
        subsetting = t.size > 0 ? t : undefined;
      } catch {
        subsetting = null;
      }
    }
    // A binding's own row is the pair its two ends state (`bindingConflicts`): no value a binding gives lists a context for it.
    const relation = this.model.get(el.id);
    const relationIsBinding = relation !== undefined && isBindingConnector(relation);
    for (const x of contexts) {
      if (x.id === owner || x.id === el.id) continue;
      const all = this.scope(x.id, 'all');
      const value = this.scope(x.id, 'value');
      let changed = false;
      const reading: string[] = [];
      // A `satisfy`, or a requirement usage whose subject a value binds, read
      // at the values of the element it is written in where an instance of
      // that element reads its satisfier otherwise ({@link
      // satisfierOtherwise}): its row is its own, and abstains. Unlisted, it
      // read as R's own (sd0: W's p1's 1 for every W, where w's p1 is 50). A
      // throw lists it, its row read and contained on its own (A.2.9).
      let satisfierElsewhere: boolean;
      try {
        satisfierElsewhere = this.satisfierOtherwise(x.id) !== undefined;
      } catch {
        satisfierElsewhere = true;
      }
      if (satisfierElsewhere) {
        changed = true;
        reading.push(`satisfier~${x.id}`);
      }
      // A context at or below a usage that subsets a feature an instance reads
      // otherwise ({@link subsettingTaint}), which the walk reads as its
      // element's own in every instance: W's `part p2 : T1 :> p1;` beside w's
      // `part :>> p1 { attribute :>> load = 50.0; }` reads T1's `tc { load <=
      // 5.0 }` at T1's 1, as T1 does, so it was left to T1's own row — true on
      // all four surfaces, where every w's p2 is one of w's p1s (50). Listed,
      // its row is its own and abstains ({@link satisfierRefusal}), as W's `c {
      // p2.load <= 5.0 }` does. A throw lists it, its row read and contained on
      // its own (A.2.9).
      if (subsetting === null || (subsetting !== undefined && taintedAt(this.model, subsetting, x) !== undefined)) {
        changed = true;
        reading.push(`subsetting~${x.id}`);
      }
      for (const n of names) {
        const idT = ownAll.get(n);
        if (idT === undefined) continue;
        if (taint !== undefined) {
          let own = ownTainted.get(n);
          if (own === undefined) ownTainted.set(n, (own = readsTainted(this.model, taint, [owner], n) !== undefined));
          const there = own ? undefined : readsTainted(this.model, taint, [x.id], n);
          // Each such context its own row: read alike with another the
          // source taints too, it read the owner's value (RF's p1, which Q's `r =
          // p1` reaches, beside Q's own r: P's `c` held there unread).
          if (there !== undefined) {
            changed = true;
            reading.push(`${n}~${there.id}~${x.id}`);
          }
        }
        const idX = all.get(n);
        const valued = value.has(n);
        // A value read IN the context, over its own names (`readAt`), is the
        // context's own: one its inputs make other than where it is written.
        const at = valued ? this.readAt(x.id, n) : undefined;
        const site = valued ? undefined : this.definitionSite(x.id, n);
        reading.push(`${n}=${idX ?? ''}:${valued}:${site ?? ''}:${at ?? ''}`);
        // A name the context reads in an instance other than the owner's own,
        // re-rooted there ({@link landsElsewhere}): a reference on its path the
        // context rebinds, or a renamed redefinition. W's `pp.load` over `ref
        // part pp = top.a`, read in `w : W { ref part :>> top = t50; }`, is
        // T1's a's load in both, but t50's in w (50) and W's own top's in W (1);
        // read in `part top2 redefines top { … }`, w's top2's; and so does a
        // name whose value reads such a path (RB9's `m = pp.load`). Unlisted,
        // W's reading stood for w's. A throw lists the context (A.2.9).
        let elsewhere: string | undefined;
        try {
          elsewhere = idX !== undefined ? this.landsElsewhere(owner, x.id, n) : undefined;
        } catch {
          elsewhere = `@threw:${x.id}`;
        }
        if (elsewhere !== undefined) {
          changed = true;
          reading.push(`${n}@${elsewhere}`);
        }
        // A value an asserted equation gives in the context's instance over a name valued only in some
        // usages (PIN2's `L == M` with p's `:>> M = 7.0` and p2's 5, {@link EnclosingAsserts.framed}): the
        // context's own, read alike only where that name is the same feature. A
        // throw lists the context, its row read and contained on its own (A.2.9).
        let framedHere: string | undefined;
        try {
          framedHere = idX !== undefined ? this.framedDefinition(x.id, this.model.get(idX)) : undefined;
        } catch {
          framedHere = `@threw:${x.id}`;
        }
        if (framedHere !== undefined) {
          reading.push(framedHere);
          changed = true;
        }
        if (idX === undefined) {
          changed = true;
          continue;
        }
        if (idX !== idT) {
          const fT = this.model.get(idT);
          const fX = this.model.get(idX);
          if (!fT || !fX || !this.readsAs(x.id, fX, fT)) changed = true;
        }
        if (valued !== ownValue.has(n)) changed = true;
        else if (valued && (at === undefined) !== (this.readAt(owner, n) === undefined)) changed = true;
        // Read in a usage of the context's own on the path that the owner does
        // not read it in: n02's q2, whose `part :>> p { :>> extra = 50.0; }`
        // changes an input of P's `m2 = 10.0 - load - extra` that Q's `p.m2`
        // reads, where Q reads it in Q's p because Q's `bind p.load = L` changes
        // another. Both read it IN some usage, so the test above saw no change,
        // and q2's −41 was never read: `sysml-check --strict` said OK. Only
        // where what it reads there differs: a usage that redefines the path
        // and changes no input (`part :>> p { attribute tag = 1.0; }`) reads
        // Q's value.
        else if (valued && at !== undefined && at !== x.id && at !== this.readAt(owner, n) && this.readsOtherInputsContained(x.id, owner, n)) {
          changed = true;
        }
        else if (!valued && (site === undefined) !== (this.definitionSite(owner, n) === undefined)) changed = true;
      }
      // A value read through a binding the context joins otherwise: its own —
      // by the features it joins (`plain`), or by what a member reads there.
      let listed = false;
      if (ownBound !== undefined) {
        const bound = bindingReadingIn(this.model, owner, x.id, reads);
        const byFeature = bindingReadingIn(this.model, owner, x.id, reads, false);
        const key = [...reading, byFeature ?? ''].join(' ');
        if ((changed || byFeature !== ownPlain) && !plainReadings.has(key)) {
          plainReadings.add(key);
          plain.add(x.id);
          listed = true;
        }
        reading.push(bound ?? '');
        if (bound !== ownBound) changed = true;
      } else if (changed && !plainReadings.has(reading.join(' '))) {
        plainReadings.add(reading.join(' '));
        plain.add(x.id);
      }
      const key = reading.join(' ');
      if (changed && !readings.has(key)) {
        readings.add(key);
        listed = true;
      }
      // A context in whose instances an asserted equation — its own, of an
      // element above it, or of one nested below it — defines what the relation
      // reads (H5's enclosing rule), or a usage nested below it values a name
      // such an equation reads ({@link assertedBelow}): its reading is its own.
      // A throw lists it, to be read, and contained, as its own row (A.2.9).
      if (!listed && !plain.has(x.id) && reads.size > 0) {
        let asserting: ElementRecord | undefined;
        try {
          partnered ??= this.partnerReads(owner, reads);
          asserting = assertedThrough(this.model, x.id, partnered, true) ?? assertedBelow(this.model, x.id, owner, partnered);
        } catch {
          asserting = x;
        }
        if (asserting !== undefined && !readings.has(`${key} ${asserting.id}`)) {
          readings.add(`${key} ${asserting.id}`);
          plain.add(x.id);
          listed = true;
        }
      }
      // A usage whose instance a binding gives a value the relation reads that the feature states nowhere (VC's
      // `bind p.load = L` over P's `assert constraint { load <= 10.0 }` and Q's `L = 50.0`; RB5's `bind p.x = K` in q1
      // under Q's `assert constraint tie { p.x == 50.0 }`), where the relation's owner reads none of it through a
      // binding of its own (those are the contexts above): the model states that value of the instance, so the
      // relation is read there, at it — a violated assert is a model that contradicts itself.
      if (!listed && !plain.has(x.id) && !relationIsBinding && this.valuedByBinding(x.id, owner, names)) {
        plain.add(x.id);
        listed = true;
      }
      // A usage one instance of which a binding written in its own element
      // reads otherwise (A7's q2: `bind p.extra = E` makes q2's p a copy of
      // Q's p): nothing it reads is another feature, and no binding of an
      // owner lists it, so it is listed here, to be read per instance.
      if (!listed && !plain.has(x.id) && isUsage(x.eClass) && bindingsIntoRedefiners(this.model).has(x.id)) {
        if (this.boundInRedefiner(x.id, this.boundReads(x.id, names), names) !== undefined) {
          plain.add(x.id);
          listed = true;
        }
      }
      if (listed || plain.has(x.id)) out.push(x);
    }
    return { listed: out, plain };
  }

  /**
   * Does a binding give a name `names` read, in the usage `contextId`, a value the feature it denotes states nowhere —
   * not it, and not a feature it redefines, as a value or as a `default`? P's `load`, which P's `assert constraint {
   * load <= 10.0 }` reads in Q's `part p : P`, over Q's `bind p.load = L` and `L = 50.0` (VC); Q's `p.x`, which Q's
   * `assert constraint tie { p.x == 50.0 }` reads in `part q1 : Q { … bind p.x = K; }` — the binding written in the
   * instance, in a usage below it, in a package or in a definition around it (RB5). No reading of the context lists it
   * for what it states ({@link changingContexts}), and the relation was read where the feature has none, or not at
   * all: the model contradicts itself in an instance no row read. Only where a binding of the model gives the
   * instance's symbol a source this tool reads ({@link boundSourceIn}): one that abstains (`defaults-differ`,
   * `two-values`, `free`, a cap) gives the instance no value to read. A feature with a value, or a `default`, anywhere
   * on its chain is listed by what it states (a `default` a binding overrides, {@link boundOverDefault}). A throw is
   * `true`: the context is read, and contained as its own row (A.2.9) — unless the caller drops an abstention on the
   * answer (`contained` false), which then meets the throw itself: a context that may not be read is no reason to
   * read nothing of it.
   *
   * The answer is kept per context, and {@link standingUnderInstance} asks it while {@link enclosingAsserts} is still
   * being built (to drop an abstention): the answer that abstention was dropped on is the one the check lists the
   * context by, whichever surface asks first. So nothing {@link valuedAbove} and the calls below it make may read
   * `unread`, `partners` or the taint of {@link equatedParts} — until the index is built they hold the sweep's
   * sources alone, and an answer computed then and kept could differ from one computed after (the unit test
   * `answers which contexts a binding gives a value alike whichever surface asks first` holds the two together).
   */
  valuedByBinding(contextId: ElementId, ownerId: ElementId, names: readonly string[], contained = true): boolean {
    const x = this.model.get(contextId);
    if (!x || !isUsage(x.eClass) || !hasUserBindings(this.model)) return false;
    const key = `${contextId} ${ownerId} ${names.join('\u0000')}`;
    let hit = this.valuedByBindingMemo.get(key);
    if (hit === undefined) {
      if (contained) {
        try {
          hit = this.valuedAbove(x, ownerId, names);
        } catch {
          return true;
        }
      } else {
        hit = this.valuedAbove(x, ownerId, names);
      }
      this.valuedByBindingMemo.set(key, hit);
    }
    return hit;
  }

  /**
   * {@link valuedByBinding}, worked out — through the seam a test makes it throw through, and only where the relation's
   * owner `ownerId` reads none of what `names` read through a binding of its own: the contexts of those are listed
   * by {@link changingContexts}, as they were (M7's q2, whose K the owner's `bind load = L` carries).
   */
  private valuedAbove(x: ElementRecord, ownerId: ElementId, names: readonly string[]): boolean {
    const reads = this.boundReads(ownerId, names);
    if (reads.size > 0 && bindingReadingIn(this.model, ownerId, ownerId, reads) !== undefined) return false;
    return instanceIndexSeam.bindingValued(this, x, names);
  }

  /**
   * The instance `name`, read in the context `contextId`, lands in, where that
   * is not the one it lands in read in `ownerId` re-rooted at the context
   * ({@link rebaseInstance}) — spelled below the context's own instance where
   * it lies there — or `undefined` where the two agree. W's `top.a.load` read
   * in `w : W { part :>> top { … } }` lands in w's top's a, W's own re-rooted;
   * read in `w : W { ref part :>> top = t50; }`, in t50's a, and W's `pp.load`
   * over `ref part pp : T0 = top.a` with it. A renamed redefinition on the
   * path (`part top2 redefines top { … }`) lands in w's top2's a. The feature
   * is T1's a's load every time, so no test by feature tells these apart
   * ({@link contextsUncached}). So, for a name whose value is an expression,
   * is each instance a name of that value lands in, read in the instance the
   * name is ({@link readsLandIn}): RB9's `attribute m = pp.load` is W's m in
   * W and in w, read in W and in w, but its `pp.load` lands in t50's a in w.
   * Compared by the name alone, w was not listed, and W's own reading (1)
   * stood for w's (50). A subject's reading is left out: a satisfaction or a
   * bound subject reads what its subject stands for by its own rule ({@link
   * subjectInstance}).
   */
  private landsElsewhere(ownerId: ElementId, contextId: ElementId, name: string): string | undefined {
    if (this.satisfaction(contextId)) return undefined;
    const mine = this.denote(ownerId).get(name);
    const theirs = this.denote(contextId).get(name);
    if (!mine || !theirs) return undefined;
    const head = name.split('.')[0]!;
    for (const d of [this.denote(ownerId).get(head), this.denote(contextId).get(head)]) {
      if (d?.feature.attrs.requirementRole === 'subject') return undefined;
    }
    const here = this.instanceNameOf(contextId);
    const own: string[] = [];
    const there: string[] = [];
    this.readsLandIn(mine, own, new Set(), 0);
    this.readsLandIn(theirs, there, new Set(), 0);
    // Past the cap neither side is known: the context is listed, its row read
    // in its own instance as a shorter chain's is. Alike, the two marks hid a
    // reference w rebinds at the end of a 16-link chain (rbd16n's `m0 = m1;
    // … m16 = pp.load`), and W's own row (1) stood for w's (50).
    if (own.includes(LANDS_CAP) || there.includes(LANDS_CAP)) return LANDS_CAP;
    // The context's side re-rooted too where it is not already below the
    // context's own instance: a link the walk resolves at the owner's own
    // instance either way (a reference valued with a feature around it, {@link
    // referenceOtherwise}) is no instance the context lands in otherwise. One
    // below it is the context's own already — a context nested in the owner
    // (massR's `subject s : P` in P) is spelled below the owner's instance too,
    // and re-rooted again it was another.
    for (let i = 0; i < Math.max(own.length, there.length); i++) {
      const inst = there[i] ?? '';
      const below = inst === here || inst.startsWith(`${here}::`);
      const theirs = below ? inst : rebaseInstance(this, ownerId, here, inst);
      if (own[i] !== undefined && rebaseInstance(this, ownerId, here, own[i]!) === theirs) continue;
      // A link the context alone reads — through a binding its own type
      // writes on the name, as QB's `bind p.load = L` on AM's q0's L — that
      // lands in the context's own instance is that instance's, read per
      // instance by the binding's own rule ({@link bindingReadingIn}); no
      // reference lands it elsewhere. Listed, it filed a row QB's stood for,
      // and the SMT engine claimed no proof beside its refused axiom.
      if (own[i] === undefined && below) continue;
      return inst.startsWith(`${here}::`) ? inst.slice(here.length) : inst;
    }
    return undefined;
  }

  /**
   * The instances a reading of `d` lands in ({@link landsElsewhere}), in
   * order: its own, then — where the value it reads ({@link carrier}) is
   * stated as an expression, or a binding written where that feature is, or
   * where `d` is read, joins it to a path ({@link boundPathsOf}) — each
   * instance a name of that value, or that path, lands in, read where `d` is
   * read and re-rooted at `d`'s instance, transitively. RBB1's `attribute m;
   * bind m = pp.load;` is m read through `pp.load` as RB9's `m = pp.load` is:
   * followed by its stated value alone, w (whose `ref part :>> top = t50`
   * makes it 50) was not listed, and W's own reading (1) stood for w's.
   * Only a name whose first link is a feature of both `d`'s reader and the
   * element the value (or the binding) is written in — the same feature, or
   * the reader's redefinition of it — is followed: one resolved outward of
   * either is spelled at the outer element's own instance, which re-roots at
   * no instance of it (LexU's `pl` for Q's p, read in q0), and one only the
   * reader resolves is a feature the value does not name (DY1's q's p's own
   * `L`, where the `load = L` Q's p writes names Q's). Each such name, as one
   * that resolves nowhere, lands in nothing (`?name`), alike either way, and
   * the rule for names read outward stands ({@link standsIn}); past
   * `MAX_LANDS_DEPTH` links the reading ends in a mark of its own, which
   * lists the context ({@link landsElsewhere}).
   */
  private readsLandIn(d: Denotation, out: string[], seen: Set<string>, depth: number): void {
    out.push(d.instance);
    const target = this.carrier(d.reader, d.feature);
    if (target.ownerId == null) return;
    const links: Array<{ name: string; writtenIn: ElementId }> = this.valueNamesOf(target).map((name) => ({ name, writtenIn: target.ownerId! }));
    links.push(...this.boundPathsOf(target, d.reader));
    if (links.length === 0) return;
    const key = `${d.reader} ${target.id}`;
    if (seen.has(key)) return;
    if (depth >= MAX_LANDS_DEPTH) {
      out.push(LANDS_CAP);
      return;
    }
    seen.add(key);
    const scope = this.denote(d.reader);
    for (const { name: v, writtenIn } of links) {
      const written = this.denote(writtenIn);
      const head = v.split('.')[0]!;
      const mine = scope.get(head);
      const theirs = written.get(head);
      // A subject reads what it stands for by its own rule, as a name's own head does ({@link landsElsewhere}).
      if (mine?.feature.attrs.requirementRole === 'subject' || theirs?.feature.attrs.requirementRole === 'subject') {
        out.push(`§${v}`);
        continue;
      }
      const dv =
        mine && theirs && mine.reader === d.reader && theirs.reader === writtenIn &&
        (mine.feature === theirs.feature || redefinedClosure(this.model, mine.feature).some((g) => g.id === theirs.feature.id))
          ? scope.get(v)
          : undefined;
      if (dv) this.readsLandIn({ ...dv, instance: rebaseInstance(this, d.reader, d.instance, dv.instance) }, out, seen, depth + 1);
      else out.push(`?${v}`);
    }
    seen.delete(key);
  }

  /**
   * The paths the user's binding connectors written in `f`'s owner, or in
   * `reader`, join `f` to — an end that is `f`, or an implicit copy of it —
   * each the other end's path below the element the binding is written in
   * ({@link bindingEndPath}): RBB1's `bind m = pp.load` gives W's m `pp.load`,
   * written in W. For {@link readsLandIn}, which follows each as a name of a
   * value `f` reads.
   */
  private boundPathsOf(f: ElementRecord, reader: ElementId): Array<{ name: string; writtenIn: ElementId }> {
    if (!hasUserBindings(this.model)) return [];
    if (!this.boundEnds) {
      const index = new Map<ElementId, Array<{ binding: ElementRecord; other: ElementId }>>();
      for (const b of this.model.all()) {
        if (b.attrs.isLibrary === true || b.ownerId == null || !isBindingConnector(b)) continue;
        const ends = [b.source?.[0], b.target?.[0]];
        for (let i = 0; i < 2; i++) {
          const end = ends[i] !== undefined ? this.model.get(ends[i]!) : undefined;
          const other = ends[1 - i];
          if (!end || other === undefined) continue;
          const keys = [end.id, ...(end.attrs.implicit === true ? redefinedClosure(this.model, end).map((g) => g.id) : [])];
          for (const k of keys) {
            const list = index.get(k);
            if (list) list.push({ binding: b, other });
            else index.set(k, [{ binding: b, other }]);
          }
        }
      }
      this.boundEnds = index;
    }
    const out: Array<{ name: string; writtenIn: ElementId }> = [];
    for (const { binding, other } of this.boundEnds.get(f.id) ?? []) {
      const at = binding.ownerId!;
      if (at !== f.ownerId && at !== reader) continue;
      const name = bindingEndPath(this.model, other, at);
      if (name !== undefined && !out.some((x) => x.name === name && x.writtenIn === at)) out.push({ name, writtenIn: at });
    }
    return out;
  }

  /** The names `f`'s stated value reads ({@link namesOfValue}), once per feature. */
  private valueNamesOf(f: ElementRecord): readonly string[] {
    const stated = this.statedOf(f);
    if (typeof stated.value !== 'string') return [];
    stated.names ??= namesOfValue(stated.value);
    return stated.names;
  }

  /**
   * The contexts a relation is read in besides where it is written: for a
   * clause of a requirement — an `assume` or a `require` — every context ANY
   * clause of that requirement is read differently in, so the requirement is
   * read there whole, each goal under its own assumptions (`assume A; require
   * G` where only G changes in `satisfy R by p` still reads A in p); for any
   * other relation, its own {@link changingContexts}.
   */
  readingContexts(el: ElementRecord, names: readonly string[]): ElementRecord[] {
    const role = el.attrs.requirementRole;
    if ((role !== 'require' && role !== 'assume') || el.ownerId == null) return this.changingContexts(el, names);
    let hit = this.clauseContexts.get(el.ownerId);
    if (!hit) {
      const out: ElementRecord[] = [];
      for (const c of this.model.children(el.ownerId)) {
        const r = c.attrs.requirementRole;
        if ((r !== 'require' && r !== 'assume') || typeof c.attrs.expression !== 'string') continue;
        const body = parseRelationBody(c.attrs.expression);
        if (!body) continue;
        for (const x of this.changingContexts(c, refsIn(body.node, body.literals))) {
          if (!out.includes(x)) out.push(x);
        }
      }
      hit = out;
      this.clauseContexts.set(el.ownerId, hit);
    }
    return hit;
  }

  /**
   * A context ABOVE the usage `contextId` that reads what `names` read there
   * through a binding otherwise than the usage's owner does — `q : Q`, where
   * Q's `bind p.load = L` joins Q's p's load to q's `L = 50.0`, for P's `load
   * <= 10.0` read in `Q::p` — or `undefined`. A relation read in `Q::p` is read
   * for Q's own p; q's p is an instance of P that no context names, so the
   * reading is not every Q's p's ({@link bindingReadingIn}).
   *
   * While a binding of the model was read in fewer contexts than it holds in
   * ({@link bindingCapOf}), the context that reads it otherwise may be one
   * left out: any reading of a binding's end — what `names` read, or what
   * their values read — answers the cap (`pastCap`), wherever it is read. So
   * does a reading of an end of one binding left out of a context
   * ({@link BindingEnds.unread}).
   *
   * So is a binding written in an instance of the usage's own element, which
   * no binding of an owner tells apart ({@link boundInRedefiner}): A7's `q2 :
   * Q { bind p.extra = E; }` gives q2's p the extra of q2's E, while Q's p —
   * and every other Q's — reads P's default.
   */
  boundAbove(contextId: ElementId, names: readonly string[]): BoundAbove | undefined {
    if (!readsPerInstance(this.model)) return undefined;
    const key = `${contextId} ${names.join('\u0000')}`;
    let hit = this.aboveBound.get(key);
    if (hit === undefined) {
      hit = this.boundAboveOf(contextId, names) ?? null;
      this.aboveBound.set(key, hit);
    }
    return hit ?? undefined;
  }

  /** {@link boundAbove}, worked out. */
  private boundAboveOf(contextId: ElementId, names: readonly string[]): BoundAbove | undefined {
    const reads = this.boundReads(contextId, names);
    if (reads.size === 0) return undefined;
    const { overCap, unread } = bindingEnds(this.model);
    if (overCap.size > 0 || unread.size > 0) {
      for (const id of reads) {
        const met = overCap.get(id);
        if (met !== undefined) return { pastCap: met };
        if (unread.has(id)) return { pastCap: 'outside' };
      }
    }
    const seen = new Set<ElementId>();
    for (let cur = this.model.get(contextId); cur && isUsage(cur.eClass) && cur.ownerId != null; ) {
      if (seen.has(cur.id)) break;
      seen.add(cur.id);
      const owner = this.model.get(cur.ownerId);
      if (!owner) break;
      const own = bindingReadingIn(this.model, owner.id, owner.id, reads);
      if (own !== undefined) {
        const other = this.specialisersOf(owner.id).find((y) => bindingReadingIn(this.model, owner.id, y.id, reads) !== own);
        if (other) return other;
      }
      cur = owner;
    }
    // An asserted equation of an element above the usage that defines what it
    // reads in that element's instances (H5's enclosing rule): each instance
    // reads it otherwise, as under a binding.
    return this.boundInRedefiner(contextId, reads, names) ?? assertedThrough(this.model, contextId, reads);
  }

  /**
   * The element a binding is written in that reaches INTO a redefinition of
   * the usage `contextId` — an end at or below it ({@link
   * bindingsIntoRedefiners}) that is, or redefines, one of the features the
   * usage's reading reads (`reads`, {@link boundReads}), or the redefinition
   * itself — or `undefined`. A7's `part q2 : Q { attribute E = 20.0; bind p.extra =
   * E; }` makes q2's p a copy of Q's p whose extra is q2's E: P's `extra <=
   * 10.0`, read in Q's p, is q2's p's own there, though no feature of Q's p
   * is redefined and no binding of an owner joins it otherwise. Read for Q's
   * own p alone, it was proved, and nothing read q2's — a decided violation
   * no surface reported.
   */
  private boundInRedefiner(contextId: ElementId, reads: ReadonlySet<ElementId>, names: readonly string[]): ElementRecord | undefined {
    const into = bindingsIntoRedefiners(this.model).get(contextId);
    if (into === undefined || reads.size === 0) return undefined;
    for (const { end, holder } of into) {
      const f = this.model.get(end);
      if (!f) continue;
      const closure = [f, ...redefinedClosure(this.model, f)];
      if (closure.some((g) => g.id === contextId) || this.readsEnd(contextId, names, f, closure)) return this.model.get(holder);
    }
    return undefined;
  }

  /**
   * Does a relation reading `names` in the usage `contextId` read the end `f`
   * of a binding written in an instance of the usage ({@link
   * boundInRedefiner}; `closure`: `f` and what it redefines)? By PATH: the
   * end lies below the redefinition of the usage at a path whose every link
   * is, or redefines, the feature a name of the relation denotes at that link
   * in the usage — one path the prefix of the other. Q's `bind p.s.extra = E`
   * in q2 reaches Q's p's `s.extra`, never `t.extra`, though both are S's
   * `extra`: matched by feature, q2's binding into p's s grouped Q's p for P's
   * `t.extra <= 10.0`, an extra group of rows read alike (BA). Where a name is
   * not so read — a link the walk does not resolve, one read through a
   * reference or a bound subject, or a bare name the walk answers below the
   * usage — it is matched by feature as before; and so is every feature a
   * name's value reads ({@link dependencies}): what a value reads is no path.
   */
  private readsEnd(contextId: ElementId, names: readonly string[], f: ElementRecord, closure: readonly ElementRecord[]): boolean {
    // The links from below the usage's redefinition down to the end, each with what it redefines.
    const links: Array<ReadonlySet<ElementId>> = [];
    for (let cur: ElementRecord | undefined = f; cur; cur = cur.ownerId != null ? this.model.get(cur.ownerId) : undefined) {
      const mine = [cur, ...redefinedClosure(this.model, cur)];
      if (mine.some((g) => g.id === contextId)) break;
      links.unshift(new Set(mine.map((g) => g.id)));
      if (links.length > MAX_BINDING_SEGMENTS) return closure.some((g) => names.some((n) => this.boundReads(contextId, [n]).has(g.id)));
    }
    const ids = new Set(closure.map((g) => g.id));
    const denoted = this.denote(contextId);
    for (const n of names) {
      const d = denoted.get(n);
      if (!d) continue;
      if (this.dependencies(contextId, d.feature).some((id) => ids.has(id))) return true;
      const segments = n.split('.');
      const dens = segments.map((_, k) => denoted.get(segments.slice(0, k + 1).join('.')));
      const plain =
        dens.every((x) => x !== undefined) &&
        dens[0]!.reader === contextId &&
        dens.slice(0, -1).every((x) => this.subjectOf(x!.reader, x!.feature) === undefined);
      if (!plain) {
        if (ids.has(d.feature.id) || ids.has(this.carrier(d.reader, d.feature).id)) return true;
        continue;
      }
      const k = Math.min(dens.length, links.length);
      let along = true;
      for (let i = 0; i < k && along; i++) along = links[i]!.has(dens[i]!.feature.id);
      if (along) return true;
    }
    return false;
  }

  /**
   * `reads` ({@link boundReads} in `ownerId`), with every other member of a
   * binding component one of them is in there, and what each member's value
   * reads ({@link dependencies}): R22B's `c { load <= 5.0 }` over Q's `bind
   * load = L` and `L = 2.0 * K` reads K through the binding, so a context in
   * whose instances an asserted equation defines K — q2's own `assert
   * constraint { K == 25.0 }` over K's `default`, or the package's `q2.K ==
   * 25.0` (R27F) — reads it otherwise (H5's enclosing rule). Read for Q's own
   * instance alone, q2's load of 50 was never read, and `sysml-check --strict`
   * said OK.
   */
  private partnerReads(ownerId: ElementId, reads: ReadonlySet<ElementId>): ReadonlySet<ElementId> {
    const own = bindingEnds(this.model).readings.get(ownerId);
    if (!own) return reads;
    const members = indexOf(this.model).members.get(ownerId);
    const out = new Set(reads);
    for (const r of own.values()) {
      if (!reads.has(r.feature)) continue;
      for (const path of members?.get(r.component) ?? []) {
        const f = this.model.get(own.get(path)?.feature ?? '');
        if (!f || out.has(f.id)) continue;
        out.add(f.id);
        out.add(this.carrier(ownerId, f).id);
        for (const id of this.dependencies(ownerId, f)) out.add(id);
      }
    }
    return out;
  }

  /**
   * The features the values of `names` read in `contextId` — each feature a
   * name denotes, what it reads ({@link carrier}), and its value's
   * {@link dependencies} — for {@link bindingReadingIn}.
   */
  private boundReads(contextId: ElementId, names: readonly string[]): Set<ElementId> {
    const out = new Set<ElementId>();
    if (!readsPerInstance(this.model)) return out;
    const denoted = this.denote(contextId);
    for (const n of names) {
      const d = denoted.get(n);
      if (!d) continue;
      out.add(d.feature.id);
      out.add(this.carrier(d.reader, d.feature).id);
      for (const id of this.dependencies(contextId, d.feature)) out.add(id);
    }
    return out;
  }

  /**
   * Does the value of `name`, read IN a usage in both `contextId` and its
   * owner `ownerId` ({@link readAt}), read other inputs in the one than in the
   * other — the features it reads, each as resolved in the usage it is read in
   * ({@link dependencies})? q2's `part :>> p { attribute :>> extra = 50.0; }`
   * makes the extra of P's `m2 = 10.0 - load - extra` q2's own, where Q's p
   * reads P's; a `part :>> p` that redefines no input reads Q's.
   */
  private readsOtherInputsContained(contextId: ElementId, ownerId: ElementId, name: string): boolean {
    // A throw answers yes: the context is listed, and its row read and contained on its own (A.2.9).
    try {
      return this.readsOtherInputs(contextId, ownerId, name);
    } catch {
      return true;
    }
  }

  /** {@link readsOtherInputsContained}, uncontained. */
  private readsOtherInputs(contextId: ElementId, ownerId: ElementId, name: string): boolean {
    const atHere = this.readAt(contextId, name);
    const atThere = this.readAt(ownerId, name);
    const here = this.model.get(this.scope(contextId, 'value').get(name) ?? '');
    const there = this.model.get(this.scope(ownerId, 'value').get(name) ?? '');
    if (atHere === undefined || atThere === undefined || !here || !there) return true;
    const mine = new Set(this.dependencies(atHere, here));
    const theirs = this.dependencies(atThere, there);
    return here !== there || mine.size !== theirs.length || theirs.some((id) => !mine.has(id));
  }

  /**
   * A key for what an asserted equation over a name valued only in some
   * usages ({@link EnclosingAsserts.framed}) gives `f` in the instance of
   * `contextId` — the features the equation's names read in its frame, or its
   * abstention — or `undefined` where no such equation defines it there.
   */
  private framedDefinition(contextId: ElementId, f: ElementRecord | undefined): string | undefined {
    if (!f || !assertHeldInSome(this.model, f)) return undefined;
    const { framed } = enclosingAsserts(this.model);
    if (framed.size === 0) return undefined;
    const inst = this.instanceNameOf(contextId);
    if (!assertDefinitionsIn(this.model, f, inst).some((d) => d.equations.some((eq) => framed.has(eq.constraint.id)))) return undefined;
    const def = assertDefinitionIn(this.model, f, inst);
    if (def === undefined) return undefined;
    if ('abstain' in def) return `@${def.abstain}`;
    const there = this.denote(def.frame.reader);
    return `@${def.equation.constraint.id}:${refsIn(def.equation.definition, def.equation.literals).map((r) => there.get(r)?.feature.id ?? r).join(',')}`;
  }

  /** Where the asserted equation that defines the valueless feature `name` denotes in `contextId` is read, if anywhere. */
  private definitionSite(contextId: ElementId, name: string): ElementId | undefined {
    if (name.includes('.')) return this.chainSite([contextId], name)?.site;
    return this.of(contextId, name).length > 0 ? contextId : this.inheritedSite(contextId, name);
  }

  /** {@link statedValueOf}, once per feature — and the names a string value reads, once. */
  statedValue(f: ElementRecord): AttrValue | undefined {
    return this.statedOf(f).value;
  }

  private statedOf(f: ElementRecord): { value: AttrValue | undefined; names?: string[] } {
    let hit = this.stated.get(f.id);
    if (!hit) {
      hit = { value: statedValueOf(this.model, f) };
      this.stated.set(f.id, hit);
    }
    return hit;
  }

  /**
   * The names `f`'s value is read from, with the context each is read in: its
   * stated value's (in its owner), or its asserted definitions' in `sites`
   * and in its owner. `undefined` for a valueless feature a binding holds.
   */
  private readsOf(f: ElementRecord, sites: readonly ElementId[]): Array<{ owner: ElementId; names: string[] }> | undefined {
    const stated = this.statedOf(f);
    if (stated.value !== undefined) {
      if (typeof stated.value !== 'string' || f.ownerId == null) return [];
      stated.names ??= namesOfValue(stated.value);
      return [{ owner: f.ownerId, names: stated.names }];
    }
    const name = this.nameOf(f);
    if (!name) return [];
    const out: Array<{ owner: ElementId; names: string[] }> = [];
    for (const site of new Set([...sites, ...(f.ownerId != null ? [f.ownerId] : [])])) {
      for (const eq of this.of(site, name)) out.push({ owner: site, names: refsIn(eq.definition, eq.literals) });
    }
    return out.length === 0 && this.boundFeatures().has(f.id) ? undefined : out;
  }

  /**
   * Does `id`, or a type it specialises, own a binding the editor set aside because an end of it is a copy a member
   * of its owner takes the name of (`attrs.partedEnd`, the serializer's markStaleBindings)? The reopened file binds
   * that member, which the page cannot follow: no name of that scope (the ends, the features the file may join to
   * them, what is nested below them) is read, so it is unresolved, and a row naming one is not decided on a reading
   * the file may not give. So is a binding with an end held with no copy in its owner, on a type the owner
   * specialises (a bound end moved up into the type): the file makes the copy.
   */
  private partedHolder(id: ElementId): boolean {
    const parted = this.partedOwners();
    return parted.size > 0 && (parted.has(id) || generalizationsOf(this.model, id).some((g) => parted.has(g.id)));
  }

  /**
   * Does the model hold a scope {@link partedHolder} leaves unread? The axioms of a solver run are built from every
   * scope, so a run over such a model proves or refutes on a set the reopened file may find inconsistent
   * (`verification/inconsistent-axioms`): the SMT lane decides nothing there (./api/verification).
   */
  hasWithheldScope(): boolean {
    return this.partedOwners().size > 0;
  }

  private partedOwners(): ReadonlySet<ElementId> {
    if (this.parted === undefined) {
      const out = new Set<ElementId>();
      for (const b of this.model.ofKind('BindingConnectorAsUsage', 'BindingConnector')) {
        if (b.ownerId == null || b.attrs.isLibrary === true) continue;
        if (b.attrs.partedEnd === true) out.add(b.ownerId);
        // An end that is a feature of a type its owner specialises, held with no copy of its own in the owner (a bound
        // end moved up into the type): the saved file makes the copy, which the page does not hold.
        else if (this.endsInGeneral(b)) out.add(b.ownerId);
      }
      this.parted = out;
    }
    return this.parted;
  }

  /**
   * The owner of the scope that leaves `name` unread when read in `contextId` ({@link partedHolder}), or `undefined`:
   * the name is the path it was reached by, or goes through it.
   */
  withheldOwner(contextId: ElementId, name: string): ElementRecord | undefined {
    this.denote(contextId);
    for (const [path, owner] of this.withheldIn.get(contextId) ?? []) {
      if (path === '' || name === path || name.startsWith(`${path}.`)) return this.model.get(owner);
    }
    return undefined;
  }

  /** Does an end of the binding `b` belong to a type its owner specialises ({@link partedHolder})? */
  private endsInGeneral(b: ElementRecord): boolean {
    const owner = b.ownerId!;
    for (const end of [...(b.source ?? []), ...(b.target ?? [])]) {
      const home = this.model.get(end)?.ownerId;
      if (home == null || home === owner) continue;
      let general = this.generalIds.get(owner);
      if (general === undefined) this.generalIds.set(owner, (general = new Set(generalizationsOf(this.model, owner).map((g) => g.id))));
      if (general.has(home)) return true;
    }
    return false;
  }

  /** Every feature a binding connector touches ({@link bindingEndsOf}). */
  private boundFeatures(): ReadonlySet<ElementId> {
    this.bound ??= bindingEndsOf(this.model);
    return this.bound;
  }
}

/**
 * Is `el` a binding connector — the test `isBindingEdge` of ./connectors
 * makes, written here because that module reads the unit-aware evaluator,
 * which reads this one.
 */
export function isBindingConnector(el: ElementRecord): boolean {
  // One the editor's settle marked: an end of it is a copy the saved file does not make, which reads it unresolved.
  if (el.attrs.staleEnd === true) return false;
  const kind = el.attrs.connectorKind ?? el.attrs.kind;
  return (
    el.eClass === 'BindingConnectorAsUsage' ||
    el.eClass === 'BindingConnector' ||
    el.attrs.bind === true ||
    kind === 'bind' ||
    kind === 'equals' ||
    kind === 'equality'
  );
}

const SHARED = new WeakMap<Model, DefiningEquations>();

/**
 * The {@link DefiningEquations} of `model` at its current revision — one
 * reading shared by every pass and every scope asked of the same revision,
 * and a fresh one as soon as the model changes. A caller that holds no pass
 * (`idScopeFor` of ./relations) asks here rather than building one per
 * relation: the walk is the costly part of a scope, and it is the same walk.
 */
export function sharedDefinitions(model: Model): DefiningEquations {
  const hit = SHARED.get(model);
  if (hit && hit.rev === model.rev) return hit;
  const fresh = new DefiningEquations(model);
  SHARED.set(model, fresh);
  return fresh;
}

/** The names a value expression reads, a `[unit]` literal's marker excluded — `[]` for one that does not parse. */
function namesOfValue(text: string): string[] {
  const s = text.trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) return [];
  const body = parseRelationBody(s);
  return body ? refsIn(body.node, body.literals) : [];
}

/** The names a node reads, a `[unit]` literal's marker excluded. */
function refsIn(node: ExprNode, literals: MarkerDimensions): string[] {
  const out: string[] = [];
  const walk = (n: ExprNode): void => {
    switch (n.kind) {
      case 'ref': {
        const path = n.path.join('.');
        if (!literals.has(path)) out.push(path);
        return;
      }
      case 'unary':
        walk(n.operand);
        return;
      case 'binary':
        walk(n.left);
        walk(n.right);
        return;
      case 'if':
        walk(n.cond);
        walk(n.then);
        walk(n.else);
        return;
      default:
        return;
    }
  };
  walk(node);
  return out;
}

/**
 * Is `el` an `assert constraint` — the one constraint whose equation may
 * DEFINE a value? An assert states a fact about the model; a `require` or
 * `assume` clause, and a plain `constraint` usage, are checks of values the
 * model gives elsewhere. Reading those as definitions too made a brief's test
 * condition, `require constraint { jammedFraction == 0.5 }` on a measure that
 * carries no value by design, report "defines jammedFraction = 0.5" — a value
 * the model never stated — while the budget beside it (`<= 12`) read "has no
 * value anywhere". The verification lane already files the roles this way
 * (`assert` an axiom, `require` an obligation: `roleOf` in obligations.ts),
 * so the literal reading now agrees with it. The mapper records the clause
 * keyword on `attrs.requirementRole`, wherever the clause is written.
 */
export function isAsserted(el: ElementRecord): boolean {
  return el.eClass === 'ConstraintUsage' && el.attrs.requirementRole === 'assert';
}

/**
 * When `constraint` reads `name == <expr>` or `<expr> == name`, the `<expr>`
 * side; else `undefined`. `=` is the same equation in the solver's spelling.
 */
export function definedSide(constraint: ElementRecord, name: string): ExprNode | undefined {
  return definedSideOf(constraint, name)?.node;
}

/** {@link definedSide}, with the `[unit]` literals the side may read. */
export function definedSideOf(
  constraint: ElementRecord,
  name: string,
): { node: ExprNode; literals: MarkerDimensions } | undefined {
  const eq = equationOf(constraint);
  if (!eq) return undefined;
  const { node, literals } = eq;
  if (bareName(node.left, literals) === name) return { node: node.right, literals };
  if (bareName(node.right, literals) === name) return { node: node.left, literals };
  return undefined;
}

/** The bare names either side of the equation `constraint` states is — the names it may define. */
export function namesDefinedBy(constraint: ElementRecord): string[] {
  const eq = equationOf(constraint);
  if (!eq) return [];
  const names = [bareName(eq.node.left, eq.literals), bareName(eq.node.right, eq.literals)].filter(
    (n): n is string => n !== undefined,
  );
  return [...new Set(names)];
}

/**
 * The equation `constraint` states, parsed as every relation body is parsed
 * ({@link parseRelationBody}) — `undefined` for anything else.
 *
 * A `[unit]` literal is part of the equation, not a reason it is none.
 * `assert constraint { e == 640.0 [Wh] / power }` was no definition to the
 * validation surface — the scalar grammar rejects `[` — while the solver lane
 * solved it and the SMT engine took it as an axiom: `e` had no value on one
 * surface and 3544.6 s, proved against bare literals, on the other two. A
 * literal whose unit could not be lowered (an unknown unit, an offset scale)
 * leaves the body no equation at all: what it would define is unknown.
 */
function equationOf(
  constraint: ElementRecord,
): { node: Extract<ExprNode, { kind: 'binary' }>; literals: MarkerDimensions } | undefined {
  const expr = constraint.attrs.expression;
  if (typeof expr !== 'string') return undefined;
  const body = parseRelationBody(expr);
  if (!body || (body.hadUnit && !body.resolved)) return undefined;
  const node = body.node;
  if (node.kind !== 'binary' || (node.op !== '==' && node.op !== '=')) return undefined;
  return { node, literals: body.literals.size > 0 ? body.literals : NO_MARKERS };
}

/**
 * The name a side of an equation DEFINES — its bare name, or its whole dotted
 * path (`p.x` in `assert constraint { p.x == 3.0 }`) — a lowered `[unit]`
 * literal's marker excluded, or `undefined` for anything that is no reference.
 */
function definedName(n: ExprNode, literals: MarkerDimensions = NO_MARKERS): string | undefined {
  if (n.kind !== 'ref' || n.path.length === 0) return undefined;
  return n.path.some((s) => literals.has(s)) ? undefined : n.path.join('.');
}

/** The bare name a side of an equation is, a lowered `[unit]` literal's marker excluded. */
function bareName(n: ExprNode, literals: MarkerDimensions = NO_MARKERS): string | undefined {
  return n.kind === 'ref' && n.path.length === 1 && !literals.has(n.path[0]!) ? n.path[0] : undefined;
}

/**
 * The value a feature STATES: its `attrs.value`, or — for a calculation usage
 * whose body is a value expression (`calc endurance { capacity / power }`)
 * rather than a relation — that body. `undefined` for one that states none.
 *
 * A calculation's body is a value the way a feature value is: the solver lane
 * has always solved it as `endurance = capacity / power` and read relations
 * over `endurance` from that. The validation surface did not read it at all
 * ("endurance has no value anywhere"), and the solver read it unit-blind
 * (0.98, Wh/W) — so `endurance <= 60.0` was satisfied and PROVED on one side
 * and unknown on the other. Every surface now reads it as the value it states,
 * a derivation like any other.
 *
 * NOT a calculation that has a PARAMETER — a feature with a direction (`in y
 * = 100.0`), or any feature its body names, owned or inherited from the `calc
 * def` that types it. Its body is read in its OWNER's scope, where such a name
 * is the owner's feature or nothing: `calc g { in y = 100.0; y }` beside
 * `attribute y = 4.0` read 4, so `g <= 10.0` — false, g is 100 — passed the
 * literal gate. Such a calculation states no value this tool reads, as before
 * calculation bodies were read ({@link isParameterisedCalculation}).
 *
 * Nor a `default` a binding, or an asserted equation, overrides ({@link
 * defaultGivesWay}): the default gives way, and the feature states no value of
 * its own.
 */
export function statedValueOf(model: Model, el: ElementRecord): AttrValue | undefined {
  const v = el.attrs.value;
  if (v !== undefined && v !== null) return defaultGivesWay(model, el) ? undefined : v;
  if (el.eClass !== 'CalculationUsage' || !el.declaredName) return undefined;
  const body = el.attrs.expression;
  if (typeof body !== 'string' || !isValueBody(body)) return undefined;
  return ownsParameter(model, el, body) ? undefined : body;
}

/** Does `f` state a value ({@link statedValueOf})? */
export function hasStatedValue(model: Model, f: ElementRecord): boolean {
  return statedValueOf(model, f) !== undefined;
}

/**
 * Does `f` state a value of its own — one written with `=` or as a `default`, on it or on a feature it redefines
 * ({@link hasStatedValue})? Such a feature is checked against, whatever its asserted equations: two that define
 * it are no pair ({@link contradictedDefinitions}), and no value they leave undecided taints it but through its
 * own value expression ({@link spreadContradiction}).
 */
export function statesOwnValue(model: Model, f: ElementRecord): boolean {
  return hasStatedValue(model, f) || [f, ...redefinedClosure(model, f)].some((g) => g.attrs.value !== undefined && g.attrs.value !== null);
}

/**
 * The ends of the model's binding connectors, and the features whose
 * `default` gives way to one ({@link heldDefaults}), once per model revision.
 */
interface BindingEnds {
  rev: number;
  ends: ReadonlySet<ElementId>;
  /**
   * The features a binding holds over a `default` — the one they write, or the
   * one they read through a redefinition (an implicit connector-end copy of
   * P's `load`): no surface reads that default for them.
   */
  held: ReadonlySet<ElementId>;
  /**
   * The features whose `default` a binding joins, in some context, to an end
   * an asserted equation defines, with no value written with `=` in the
   * component (H2f's `bind L = L0` beside `assert constraint { L == 50.0 }`,
   * L0's `default = 1.0`): no assertion replaces a default ({@link
   * replaceableDefaults}), so each STANDS there as a value written with `=`
   * — never held, and read as one of the component's values ({@link
   * classified}): beside the equation's, two values, as `L0 = 1.0` is. Not one
   * past a cap, nor one a package's binding on a definition's feature holds in
   * every instance: that gives way here too, and reads what the binding gives
   * it ({@link standingAt} for one held only in another context).
   */
  standing: ReadonlySet<ElementId>;
  /**
   * By `${root} ${path}`, the members of such a component whose `default` a
   * binding holds only in ANOTHER context — a specialisation or a sibling
   * instance that sets the bound feature with `=` (T4C's never-instantiated
   * `Q5 :> Q { :>> L = 7.0 }`, T4D's `q5 : Q { :>> L = 7.0 }`), which no
   * binding read here reaches: each stands HERE, as {@link standing} does, and
   * gives way there. Read through the binding here, Q's `bind p.load = L`
   * carried Q's asserted `L == 50.0` into q's p's `default = 1.0` on three
   * surfaces ({@link defaultStandsIn} reads it per instance).
   */
  standingAt: ReadonlySet<string>;
  /**
   * By `${root} ${component}`, the package heads ({@link DefinitionHead})
   * whose slot a member of that component is: W4X3A's `bind p2.load = L` (L
   * asserted 5) at P's load, which the package's `bind P::load = M` joins to M
   * in every instance of P; X3's Q's `bind p.load = L` at Q's p. The two
   * components are one value there: an asserted equation that defines a member
   * of the first is read against the head's ({@link definedAgainstBoundIn}).
   */
  headSlots: ReadonlyMap<string, ReadonlyArray<{ root: ElementId; head: DefinitionHead }>>;
  /**
   * Per context a binding holds in: each end path there, the feature at it,
   * and the component it is in ({@link heldDefaults}).
   */
  readings: ReadonlyMap<ElementId, ReadonlyMap<string, { feature: ElementId; component: string }>>;
  /**
   * Whether ANY binding of the model was read in fewer contexts than it holds
   * in ({@link BindingEnds.overCap}), and which cap it met first — the
   * model-wide summary {@link bindingCapOf} reports. The guards read the
   * per-binding {@link BindingEnds.overCap}, so a model with one deep binding
   * no longer abstains every bound read ({@link boundPartnerSafe}, {@link
   * DefiningEquations.boundAbove}).
   */
  partial: boolean;
  cap?: BindingCap;
  /**
   * The ends of the bindings read in fewer contexts than they hold in — past
   * {@link MAX_BINDING_FRAMES}, or a context deeper than
   * {@link MAX_BINDING_SEGMENTS} usages left out ({@link heldDefaults}) — each
   * with the cap its own binding met, and every end of a binding joined to one
   * of them in the global component of the connectors' ends, through what an
   * end redefines too ({@link pastCapComponents}): such a binding carries the
   * capped value on. Per component, never model-wide. Only a reading of one of
   * THESE ends answers the cap ({@link boundPartnerSafe},
   * {@link DefiningEquations.boundAbove}, {@link boundSourceIn},
   * {@link defaultStandsIn}); a deep binding no longer abstains every bound
   * read of the model.
   */
  overCap: ReadonlyMap<ElementId, BindingCap>;
  /**
   * The ends of the bindings read in a context where one of their ends is no
   * feature this tool finds ({@link heldDefaults}) — held as past a cap, and
   * read for no one instance ({@link boundPartnerSafe}, {@link
   * DefiningEquations.boundAbove}): per binding, not model-wide.
   */
  unread: ReadonlySet<ElementId>;
  /**
   * The instance spellings at which a held redefinition's fall-through would
   * read the redefined feature's own `default` — the original feature's
   * default gives way THERE, and only there ({@link defaultGivesWayIn}): the
   * held-redefinition defect's per-instance hold.
   */
  heldIn: ReadonlySet<string>;
  /**
   * The features a binding holds over a `default` SOMEWHERE ({@link heldIn}):
   * a feature whose default gives way in one instance is not a value the same
   * in every instance ({@link DefiningEquations.pinnedIn}), and the numeric
   * and SMT lanes key it per instance, rather than seeding the definition's
   * own value.
   */
  heldSomewhere: ReadonlySet<ElementId>;
  /**
   * The ends of the bindings that join a feature of an instance enclosing
   * where they are written (R's `L` in `part q : Q { bind p.load = L; }`):
   * read where they are written by their own id (`#…`), for every such
   * instance alike ({@link readAsJoined}).
   */
  enclosed: ReadonlySet<ElementId>;
  /** How many binding connectors the USER wrote — the library's are never read ({@link hasUserBindings}). */
  userBindings: number;
  /** The two ends of each of them: what one connector joins, whatever context reads it ({@link joinedTo}). */
  edges: ReadonlyArray<readonly [ElementId, ElementId]>;
  /** Each of them by the element it is written in, with its ends ({@link bindingsIntoRedefiners}). */
  written: ReadonlyArray<{ holder: ElementId; ends: readonly ElementId[] }>;
  /** Each of them, in the model's order ({@link componentConnectors}). */
  connectors: readonly ElementRecord[];
  /** {@link connectors} by the feature their source end is, each with its place in `connectors`, built when first asked. */
  bySource?: ReadonlyMap<ElementId, ReadonlyArray<{ connector: ElementRecord; order: number }>>;
  /** Lazy indexes over `readings`, built when first asked ({@link indexOf}). */
  index?: BindingIndex;
  /** {@link bindingsIntoRedefiners}, built when first asked. */
  into?: ReadonlyMap<ElementId, ReadonlyArray<{ end: ElementId; holder: ElementId }>>;
  /**
   * The context roots of `readings` by the instance each reads its own
   * features in, each with its place in `readings` ({@link outermostReading}),
   * built when first asked.
   */
  byInstance?: ReadonlyMap<string, ReadonlyArray<{ root: ElementId; order: number }>>;
  /** What one component read in one root states and joins, per `${root} ${component}` ({@link componentFacts}). */
  components?: Map<string, ComponentFacts>;
  /** {@link boundSourceIn} per instance symbol, once per revision. */
  sources?: Map<string, BoundSource | undefined>;
  /** The {@link DefinitionHead} members of each package's binding reading, by root ({@link heldDefaults}). */
  heads: ReadonlyMap<ElementId, readonly DefinitionHead[]>;
  /** {@link outsideBindingsOf}, built when first asked. */
  outside?: ReadonlyMap<ElementId, readonly OutsideBinding[]>;
  /** {@link boundPartnerSafe} per `${contextId} ${name} ${featureId}`, once per revision. */
  partnerSafe?: Map<string, boolean>;
  /** {@link statedAgainstBoundSomewhere}'s features, built when first asked. */
  against?: ReadonlySet<ElementId>;
  /** {@link definedAgainstBoundIn} per `${featureId} ${symbol}`, once per revision. */
  definedAgainst?: Map<string, DefinedAgainst | null>;
}

/**
 * What the component `component` read in the context `root` states and joins,
 * each worked out once per revision when first asked ({@link componentFacts}):
 * its member paths in reading order, the connectors that join it, what its
 * members state ({@link classified}), and the member whose default stands
 * there ({@link standingDefaultPath}).
 */
interface ComponentFacts {
  paths: readonly string[];
  connectors?: readonly ElementRecord[];
  /** The ids of {@link connectors}. */
  bindingIds?: readonly ElementId[];
  classified?: ComponentClass;
  standing?: { path: string; source: ElementRecord } | null;
}

/**
 * The cap a binding's reading met ({@link BindingEnds.partial}) — or, for one
 * binding alone, `outside`: a context it holds in where an end it joins is no
 * feature this tool finds ({@link BindingEnds.unread}).
 */
export type BindingCap = 'frames' | 'segments' | 'outside';

/**
 * The lazy indexes over {@link BindingEnds.readings}: each context's
 * components with their member paths (`members`), the contexts and paths
 * each feature is a member at (`roots`), how each member is read there
 * (`marks`, {@link readsOtherwise}), the features the connectors join to
 * each end (`joined`, {@link joinedTo}), and whether every context reads a
 * feature's component as its connectors join it (`uniform`).
 */
interface BindingIndex {
  members: Map<ElementId, Map<string, string[]>>;
  roots: Map<ElementId, Array<{ root: ElementId; path: string }>>;
  marks: Map<ElementId, Map<string, string>>;
  joined?: Map<ElementId, ReadonlySet<ElementId>>;
  uniform: Map<ElementId, boolean>;
}

const BINDING_ENDS = new WeakMap<Model, BindingEnds>();

/** Past this many contexts for one binding, its ends are held wherever they read a default. */
const MAX_BINDING_FRAMES = 4096;

/** Past this many usages on a context's path below where a binding is written, the context is not read. */
const MAX_BINDING_SEGMENTS = 32;

/**
 * The most owners one {@link DefiningEquations.denote} walk enters. A web of
 * part definitions that each type parts of the others has a name tower that
 * grows with the number of simple routes through it (five definitions of four
 * such parts each: over 10^5 names, then the heap); the bundled examples and the
 * v9 model enter fewer than 600 owners.
 */
const MAX_NAME_WALK_OWNERS = 10_000;

/**
 * Past this many values read through one another, a name's reading is followed
 * no further ({@link DefiningEquations.landsElsewhere}): it ends in
 * {@link LANDS_CAP}, and the context is listed.
 */
const MAX_LANDS_DEPTH = 16;

/** The mark a reading followed past {@link MAX_LANDS_DEPTH} ends in, and the answer it lists a context with. */
const LANDS_CAP = '…';

function bindingEnds(model: Model): BindingEnds {
  const hit = BINDING_ENDS.get(model);
  if (hit && hit.rev === model.rev) return hit;
  const ends = new Set<ElementId>();
  const bindings: ElementRecord[] = [];
  const edges: Array<readonly [ElementId, ElementId]> = [];
  for (const el of model.all()) {
    if (!isBindingConnector(el)) continue;
    for (const id of [...(el.source ?? []), ...(el.target ?? [])]) ends.add(id);
    if (el.attrs.isLibrary === true || el.ownerId == null) continue;
    bindings.push(el);
    const [s, t] = [el.source?.[0], el.target?.[0]];
    if (s !== undefined && t !== undefined && s !== t) edges.push([s, t]);
  }
  const read: Pick<BindingEnds, 'held' | 'standing' | 'standingAt' | 'headSlots' | 'readings' | 'cap' | 'unread' | 'enclosed' | 'heldIn' | 'heldSomewhere' | 'overCap' | 'heads'> =
    bindings.length > 0
      ? heldDefaults(model, bindings)
      : { held: new Set<ElementId>(), standing: new Set<ElementId>(), standingAt: new Set<string>(), headSlots: new Map(), readings: new Map(), unread: new Set<ElementId>(), enclosed: new Set<ElementId>(), heldIn: new Set<string>(), heldSomewhere: new Set<ElementId>(), overCap: new Map(), heads: new Map() };
  const fresh: BindingEnds = {
    rev: model.rev,
    ends,
    ...read,
    partial: read.cap !== undefined,
    userBindings: bindings.length,
    edges,
    written: bindings.map((b) => ({ holder: b.ownerId!, ends: [...(b.source ?? []), ...(b.target ?? [])] })),
    connectors: bindings,
  };
  BINDING_ENDS.set(model, fresh);
  return fresh;
}

/**
 * The user's bindings that reach INTO a redefinition, by the feature it
 * redefines: each binding end, then each usage that owns it in turn — an
 * implicit connector-end copy (q2's `bind p.extra = E` makes q2's p, a copy of
 * Q's p, and its extra, a copy of P's), a redefinition of the user's own
 * (`part :>> p { bind extra = E; }`), the usage the binding is written in —
 * is filed, with the end and the element the binding is written in, under
 * every feature that usage redefines: Q's p, for A7's q2. A binding written in
 * the usage itself holds in every instance of it, and is filed under nothing
 * of it. An end that states a value of its own ({@link endValue}: `=`, or an
 * asserted equation that defines it — G340's `L == 2.0 * K` under `bind
 * r.q.p.load = r.q.L`) is no end a value is carried INTO: the binding carries
 * its value out, or states a second one (its own finding, `#bind`). Once per
 * revision ({@link DefiningEquations.boundAbove}).
 */
function bindingsIntoRedefiners(model: Model): ReadonlyMap<ElementId, ReadonlyArray<{ end: ElementId; holder: ElementId }>> {
  const ends = bindingEnds(model);
  if (ends.into) return ends.into;
  const into = new Map<ElementId, Array<{ end: ElementId; holder: ElementId }>>();
  for (const { holder, ends: ids } of ends.written) {
    const holderEl = model.get(holder);
    if (!holderEl) continue;
    for (const end of new Set(ids)) {
      const f = model.get(end);
      if (!f || endValue(model, f, holderEl, '').kind === 'value') continue;
      const seen = new Set<ElementId>();
      for (let o: ElementRecord | undefined = f; o && !seen.has(o.id); o = o.ownerId != null ? model.get(o.ownerId) : undefined) {
        if (seen.size > 0 && !isUsage(o.eClass)) break;
        seen.add(o.id);
        for (const g of redefinedClosure(model, o)) {
          if (g.id === o.id) continue;
          const list = into.get(g.id);
          if (list) list.push({ end, holder });
          else into.set(g.id, [{ end, holder }]);
        }
      }
    }
  }
  ends.into = into;
  return into;
}

/** Every feature a binding connector touches ({@link isBindingConnector}), once per model revision. */
export function bindingEndsOf(model: Model): ReadonlySet<ElementId> {
  return bindingEnds(model).ends;
}

/**
 * Does a binding of the user's join a feature of an instance enclosing where
 * it is written ({@link BindingEnds.enclosed}: R's `L` in `part q : Q { bind
 * p.load = L; }`)? Such a binding holds of every instance below that one —
 * r0's q, read through Q's p's own walk as `r0::q::p`, as much as r's — so the
 * engines that hold an instance's frames hold those above it too
 * ({@link enclosedBindingFrame}). Once per revision.
 */
export function hasEnclosedBindings(model: Model): boolean {
  return bindingEnds(model).enclosed.size > 0;
}

/**
 * The user's bindings that join a feature of an instance enclosing where they are written ({@link
 * hasEnclosedBindings}), in the model's order — R's `bind p.load = L` in `part q : Q { … }`. Each holds of
 * every instance of the enclosing definition, below the one that writes it.
 */
export function enclosedBindingsOf(model: Model): readonly ElementRecord[] {
  const { enclosed, connectors } = bindingEnds(model);
  if (enclosed.size === 0) return [];
  return connectors.filter((b) => (b.source?.[0] !== undefined && enclosed.has(b.source[0])) || (b.target?.[0] !== undefined && enclosed.has(b.target[0])));
}

/**
 * Does the user's model hold a binding connector of its own? The library
 * carries dozens (82 `BindingConnectorAsUsage` in the full one), and no
 * surface reads them as the model's: a model that writes none — v9 — reads
 * every value as it always did, and nothing below asks about bindings.
 */
export function hasUserBindings(model: Model): boolean {
  return bindingEnds(model).userBindings > 0;
}

/**
 * The cap a binding of the model met ({@link BindingEnds.partial}) —
 * `undefined` while every binding is read in every context it holds in.
 */
export function bindingCapOf(model: Model): BindingCap | undefined {
  return bindingEnds(model).cap;
}

/**
 * The model's PART-VALUED bindings (`bind pp = top.a`, both ends parts,
 * items, ports, or structured attributes — any usage but a scalar attribute,
 * {@link isStructuredAttribute}), once per revision. Such a binding equates
 * the two: `pp.load` IS `top.a.load`, where every surface read pp's own
 * `default` (a false verdict on all four, O5 S5), and `q.x` IS `top.pos.x`
 * for `bind q = top.pos` between two values of an `attribute def V {
 * attribute x … }` (R8A read q's own default). An end that says nothing of
 * its own — no feature, binding end, value or redefinition below it or below
 * what it redefines, no other feature redefining it, no asserted relation
 * reading through its name, one such binding only, no type its partner
 * lacks, and a feature of the element the binding is written in unless that
 * is a package — STANDS FOR its partner (`standsFor`: the partner's path
 * below the binding's owner, where it is resolved), when the partner itself
 * stands for nothing else: every chain through it reads the partner, as a
 * reference's value is read ({@link DefiningEquations.subjectScope}). The
 * partner then has everything both say. A reference's or a bound subject's
 * value, or a `satisfy`, that lands on such an end reads on through it to
 * the partner ({@link DefiningEquations.subjectScope}). Where neither end is
 * so plain, each says something the other's reading would miss (`unread`,
 * the binding; `unreadEnds`, its ends): no relation row that may read a
 * value either carries is read ({@link equatedPartsRefusal}). A part, port,
 * item or structured attribute VALUED with another (`part pp : T0 = top.a`)
 * equates the two the same way: one that says nothing else of its own, whose
 * value is a path below its owner to a partner as plain, stands for it
 * there; any other is an unread pair of its own, with its partner where it
 * says something of its own or has a type the partner lacks (`partners`: what
 * its value names, each as the links a read reaches it through — the partner
 * has what the valued one says, `pp`'s `load = 50.0` for `part pp : T0 =
 * top.a { … }`, which top's a's own reading misses). A
 * `satisfy` written in a definition, or below one another element
 * specialises, whose satisfier is a reference, an end that stands for its
 * partner or a subject, or is reached through one, is unread too: the
 * surfaces read such a satisfaction at the definition's own values only, and
 * an instance can make what that satisfier stands for another. So is a
 * reference redefined over another's `=` value ({@link contradictedBindingOf}):
 * the model states both. The sweep reads the model alone — no binding reading
 * and no scope — since the walk asks it.
 */
const EQUATED_PARTS = new WeakMap<
  Model,
  {
    rev: number;
    standsFor: ReadonlyMap<ElementId, { path: string; from: ElementId }>;
    unread: readonly ElementRecord[];
    partners: ReadonlyMap<ElementId, readonly ElementRecord[]>;
    unreadEnds: ReadonlySet<ElementId>;
    /**
     * The binding ends a plain pair's other end stands for (`q.p` of `bind pp =
     * q.p`): the instance there is the partner's own, and no value of the pair
     * reaches it ({@link assertDefinitionsAt} reads an asserted equation past one).
     */
    partnerEnds: ReadonlySet<ElementId>;
    /** {@link equatedTaint}, built on first ask. */
    taint?: ReadonlyMap<ElementId, ElementRecord>;
    /** Set where listing the asserted equations no surface reads threw (A.2.9): the sentence every row abstains in. */
    failed?: string;
  }
>();

/** The usages whose value naming another equates the two ({@link equatedParts}), with a structured attribute. */
const VALUED_PART_KINDS: ReadonlySet<string> = new Set(['PartUsage', 'PortUsage', 'ItemUsage']);

/**
 * The library types whose every value is one number, boolean or string to the
 * surfaces: a scalar value (`ScalarValues::Real`, `Boolean`, …) and a scalar
 * quantity value (`ISQ::MassValue`). {@link isScalarTyped}.
 */
const LIBRARY_SCALARS: ReadonlySet<string> = new Set(['ScalarValues::ScalarValue', 'Quantities::ScalarQuantityValue']);

/**
 * Is `e` typed by a library scalar ({@link LIBRARY_SCALARS}) — through its own
 * types, what it redefines, or anything they specialise? Such an attribute
 * holds one scalar value whatever features a user type adds to it (`attribute
 * def RatedMass :> ISQ::MassValue { attribute margin … }`, `Num :>
 * ScalarValues::Real { attribute tol … }`): `m = base`, `m2 = 2.0 * base` and
 * `bind m1 = m2` are the scalar readings', never an equating of two
 * structured attributes (they read a plain mass, and abstained on all four
 * surfaces).
 */
function isScalarTyped(model: Model, e: ElementRecord): boolean {
  return generalizationsOf(model, e.id).some((g) => g.attrs.isLibrary === true && LIBRARY_SCALARS.has(model.qualifiedName(g.id)));
}

/**
 * Is `e` an attribute with a feature of the user's own below it — its own,
 * or its type's (`attribute q : V` over `attribute def V { attribute x … }`)?
 * A binding or a value that joins two such attributes equates their features
 * as one of two parts does ({@link equatedParts}); a scalar attribute's
 * binding is the binding reading's ({@link bindingEnds}). Library types —
 * `ScalarValues::Real`, a quantity value — are read as scalars, and so is a
 * user type that specialises one ({@link isScalarTyped}).
 */
function isStructuredAttribute(model: Model, e: ElementRecord): boolean {
  if (e.eClass !== 'AttributeUsage') return false;
  const own = [e, ...redefinedClosure(model, e)];
  const userTyped = own.some((h) => model.typesOf(h.id).some((t) => t.attrs.isLibrary !== true));
  if (!userTyped && !own.some((h) => model.children(h.id).some((c) => c.attrs.isLibrary !== true && isUsage(c.eClass)))) {
    return false;
  }
  return effectiveFeatures(model, e.id).some((x) => x.attrs.isLibrary !== true && isUsage(x.eClass)) && !isScalarTyped(model, e);
}

/**
 * Is `e` an attribute whose TYPE has a feature of the user's own (`attribute
 * q : V`)? Its value, whatever expression gives it, is a V, and says what
 * its features are; an attribute structured only by its own body (`attribute
 * w = k * 2.0 { attribute k = 100.0; }`) holds a scalar value beside them, as
 * does one whose type is a library scalar's specialisation ({@link
 * isScalarTyped}).
 */
function isStructuredByType(model: Model, e: ElementRecord): boolean {
  if (e.eClass !== 'AttributeUsage') return false;
  return (
    [e, ...redefinedClosure(model, e)].some((h) =>
      model
        .typesOf(h.id)
        .some((t) => t.attrs.isLibrary !== true && effectiveFeatures(model, t.id).some((x) => x.attrs.isLibrary !== true && isUsage(x.eClass))),
    ) && !isScalarTyped(model, e)
  );
}

/**
 * The feature a `satisfy`'s path — its chain (`w.p1`), or the name of the
 * feature the relationship records (`p1`) — names where the `satisfy` is
 * written, link by link below its owner, where that is a redefinition of the
 * recorded feature: an instance's own (`part :>> p1 { … }` in w, the
 * `satisfy` written there or reached as `w.p1`). The relationship records
 * the feature it redefines (W's p1), which says nothing of the instance's
 * values. `undefined` where the path names the recorded feature itself, or
 * does not resolve below the owner ({@link DefiningEquations.satisfaction}).
 */
function writtenSatisfier(model: Model, rel: ElementRecord, recorded: ElementRecord): ElementRecord | undefined {
  if (rel.ownerId == null) return undefined;
  const chain = rel.attrs.sourceChain ?? rel.attrs.sourceRef;
  const path = typeof chain === 'string' ? chain.trim() : effectiveNameOf(model, recorded);
  if (path === undefined || !VALUE_PATH.test(path)) return undefined;
  const found = featuresAlongValue(model, rel.ownerId, path);
  const last = found?.scope === rel.ownerId ? found.links[found.links.length - 1] : undefined;
  return last !== undefined && last.id !== recorded.id && redefinedClosure(model, last).some((g) => g.id === recorded.id) ? last : undefined;
}

/**
 * The feature each link of the dotted `path` names, read where a value is
 * written: below `ownerId` or, failing that, below the first namespace
 * outward in which it resolves (`scope`) — each link among the effective
 * features of the one before, by effective name — or `undefined` where it
 * resolves nowhere ({@link equatedParts}: a value's partner, read without
 * the walk).
 */
function featuresAlongValue(
  model: Model,
  ownerId: ElementId,
  path: string,
): { scope: ElementId; links: ElementRecord[] } | undefined {
  const seen = new Set<ElementId>();
  for (let cur: ElementId | null = ownerId; cur != null && !seen.has(cur); cur = model.get(cur)?.ownerId ?? null) {
    seen.add(cur);
    const links: ElementRecord[] = [];
    let owner = cur;
    for (const segment of path.split('.')) {
      const f = effectiveFeatures(model, owner).find((x) => effectiveNameOf(model, x) === segment);
      if (!f) break;
      links.push(f);
      owner = f.id;
    }
    if (links.length === path.split('.').length) return { scope: cur, links };
  }
  return undefined;
}

/** A plain dotted path (`top.a`), the only value that names one feature. */
const VALUE_PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/** Every dotted name a value's text spells, for one the name reader does not parse (a call: `Same(top.a)`). */
const NAMES_IN_TEXT = /[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/g;

/**
 * What the `value` of a valued `e` no surface reads through ({@link
 * equatedParts}) equates it with: the feature a path names — or each feature
 * another value names, every dotted name in it where the name reader does not
 * parse it (`Same(top.a)`) — each (`partner`) with the links a read reaches it
 * by (`links`): the first, and each after it that is the one before's own
 * (`top`; and `a` too, where top's own body declares it — an `a` top inherits
 * is read through top). `[]` where it names nothing that resolves where `e` is
 * written, or outward.
 */
function valuePartners(model: Model, e: ElementRecord, value: string): Array<{ partner: ElementRecord; links: ElementRecord[] }> {
  const parsed = VALUE_PATH.test(value) ? [value] : namesOfValue(value);
  const names = parsed.length > 0 ? parsed : (value.match(NAMES_IN_TEXT) ?? []);
  const out: Array<{ partner: ElementRecord; links: ElementRecord[] }> = [];
  for (const n of names) {
    const found = e.ownerId != null ? featuresAlongValue(model, e.ownerId, n) : undefined;
    if (!found) continue;
    const links: ElementRecord[] = [];
    for (let i = 0; i < found.links.length; i++) {
      const l = found.links[i]!;
      if (l.id === e.id || (i > 0 && l.ownerId !== found.links[i - 1]!.id)) break;
      links.push(l);
    }
    out.push({ partner: found.links[found.links.length - 1]!, links });
  }
  return out;
}

/**
 * Each user redefinition whose redefining feature and redefined feature are two features of ONE owner, as the pair
 * (redefiner, redefined): KerML lets a feature redefine only one its owner inherits, and `redefinitionConformance`
 * of ../validation/rules reports the same condition as `validation/redefinition-own-sibling`.
 */
function ownSiblingRedefinitions(model: Model): Array<[ElementRecord, ElementRecord]> {
  const out: Array<[ElementRecord, ElementRecord]> = [];
  for (const r of model.ofKind('Redefinition')) {
    if (r.attrs.isLibrary === true) continue;
    const f = r.source?.[0] !== undefined ? model.get(r.source[0]) : undefined;
    const g = r.target?.[0] !== undefined ? model.get(r.target[0]) : undefined;
    if (!f || !g || f.id === g.id || f.ownerId == null || f.ownerId !== g.ownerId) continue;
    if (f.attrs.isLibrary === true || g.attrs.isLibrary === true || !isUsage(f.eClass) || !isUsage(g.eClass)) continue;
    out.push([f, g]);
  }
  return out;
}

function equatedParts(model: Model): NonNullable<ReturnType<typeof EQUATED_PARTS.get>> {
  const hit = EQUATED_PARTS.get(model);
  if (hit && hit.rev === model.rev) return hit;
  const standsFor = new Map<ElementId, { path: string; from: ElementId }>();
  const unread: ElementRecord[] = [];
  const partners = new Map<ElementId, ElementRecord[]>();
  const unreadEnds = new Set<ElementId>();
  const partnerEnds = new Set<ElementId>();
  const partLike = (e: ElementRecord | undefined): e is ElementRecord =>
    e !== undefined && isUsage(e.eClass) && (e.eClass !== 'AttributeUsage' || isStructuredAttribute(model, e));
  const pairs: Array<{ b: ElementRecord; f: ElementRecord; g: ElementRecord }> = [];
  const count = new Map<ElementId, number>();
  for (const b of model.all()) {
    if (!isBindingConnector(b) || b.attrs.isLibrary === true || b.ownerId == null) continue;
    const f = b.source?.[0] !== undefined ? model.get(b.source[0]) : undefined;
    const g = b.target?.[0] !== undefined ? model.get(b.target[0]) : undefined;
    if (!partLike(f) || !partLike(g) || f.id === g.id) continue;
    pairs.push({ b, f, g });
    for (const e of [f, g]) count.set(e.id, (count.get(e.id) ?? 0) + 1);
  }
  // A part, port or item valued with another (`part pp : T0 = top.a`, or
  // any expression) equates the two as a binding does, and so does an
  // attribute of a structured type valued with any expression, or one
  // structured by its own body whose value is a path to another that is not a
  // scalar (`attribute q : V = top.pos`); one structured by its body alone and
  // valued with an expression (`w = k * 2.0`, a scalar) or a scalar is the
  // binding reading's, as before.
  const valued: Array<{ e: ElementRecord; path: string; found?: { scope: ElementId; links: ElementRecord[] } }> = [];
  for (const e of model.all()) {
    if (e.attrs.isLibrary === true || e.attrs.isRef === true) continue;
    const v = e.attrs.value;
    if (e.ownerId == null || e.attrs.requirementRole === 'subject' || typeof v !== 'string' || isQuoted(v.trim())) continue;
    const path = v.trim();
    const part = VALUED_PART_KINDS.has(e.eClass);
    const typed = !part && isStructuredByType(model, e);
    if (!part && !typed && !(VALUE_PATH.test(path) && isStructuredAttribute(model, e))) continue;
    // A part's or a structured type's value is one whatever it reads: a call
    // the name reader does not parse (`Same(top.a)`) equates as much as a
    // path does.
    if (!part && !typed && namesOfValue(v).length === 0) continue;
    const found = VALUE_PATH.test(path) ? featuresAlongValue(model, e.ownerId, path) : undefined;
    const last = found?.links[found.links.length - 1];
    if (!part && !typed && last && last.eClass === 'AttributeUsage' && !isStructuredAttribute(model, last)) continue;
    valued.push({ e, path, ...(found ? { found } : {}) });
  }
  if (pairs.length > 0 || valued.length > 0) {
    const redefined = new Set(
      [...model.ofKind('Redefinition'), ...model.ofKind('Subsetting')].flatMap((r) => r.target ?? []),
    );
    // The names an asserted relation reads a feature THROUGH (`pp` of `pp.load
    // == 3.0`): such a relation says something of the part.
    const through = new Set<string>();
    for (const c of model.all()) {
      if (c.attrs.isLibrary === true || !isAsserted(c) || typeof c.attrs.expression !== 'string') continue;
      for (const n of relationNamesOf(c.attrs.expression)) n.split('.').slice(0, -1).forEach((s) => through.add(s));
    }
    const kinds = (e: ElementRecord): Set<ElementId> =>
      new Set(generalizationsOf(model, e.id).filter((t) => isDefinition(t.eClass)).map((t) => t.id));
    // Each owner of `e` up to `holder` reads its features as written: no
    // reference or subject, no end of a part-valued binding.
    const cleanTo = (e: ElementRecord, holder: ElementId): boolean => {
      for (let o = e.ownerId != null ? model.get(e.ownerId) : undefined; o && o.id !== holder; o = o.ownerId != null ? model.get(o.ownerId) : undefined) {
        if (o.attrs.isRef === true || o.attrs.requirementRole === 'subject' || count.has(o.id)) return false;
      }
      return true;
    };
    // `f` says nothing of its own, bound `binds` times; `valuedBy`: the value
    // that equates it, which is no value of its own.
    const silent = (f: ElementRecord, holder: ElementId, binds: number, valuedBy: boolean): boolean => {
      if ((count.get(f.id) ?? 0) !== binds || redefined.has(f.id)) return false;
      const name = effectiveNameOf(model, f);
      if (name === undefined || through.has(name)) return false;
      // Read below the binding's owner, the partner is resolved in that owner's
      // instance, which only a package has one of ({@link
      // DefiningEquations.equatedPart}).
      const owner = model.get(holder);
      if (f.ownerId !== holder && (!owner || isUsage(owner.eClass) || isDefinition(owner.eClass))) return false;
      for (const h of [f, ...redefinedClosure(model, f)]) {
        if ((h !== f || !valuedBy) && h.attrs.value !== undefined) return false;
        if (h.attrs.requirementRole === 'subject') return false;
        if (model.children(h.id).some((c) => isUsage(c.eClass))) return false;
      }
      return cleanTo(f, holder);
    };
    const partnerOf = (f: ElementRecord, g: ElementRecord): boolean => {
      if (g.attrs.value !== undefined || g.attrs.requirementRole === 'subject') return false;
      const theirs = kinds(g);
      return [...kinds(f)].every((t) => theirs.has(t));
    };
    const plain = (f: ElementRecord, g: ElementRecord, holder: ElementId): boolean =>
      silent(f, holder, 1, false) &&
      count.get(g.id) === 1 &&
      partnerOf(f, g) &&
      cleanTo(g, holder) &&
      bindingEndPath(model, g.id, holder) !== undefined;
    for (const { b, f, g } of pairs) {
      const holder = b.ownerId!;
      const [from, to] = plain(f, g, holder) ? [f, g] : plain(g, f, holder) ? [g, f] : [undefined, undefined];
      if (from && to) {
        standsFor.set(from.id, { path: bindingEndPath(model, to.id, holder)!, from: holder });
        partnerEnds.add(to.id);
        continue;
      }
      unread.push(b);
      unreadEnds.add(f.id).add(g.id);
    }
    // A valued one stands for its value's partner where both are as plain and
    // the value is a path below its owner, every link of it read as written
    // (no reference, subject or equated end on the way); else no surface reads
    // through it: an unread pair of its own, so no row that may read through
    // it is read.
    for (const { e, path, found } of valued) {
      const holder = e.ownerId!;
      const links = found?.scope === holder ? found.links : undefined;
      const g = links?.[links.length - 1];
      const clean = links?.every(
        (l) => l.id !== e.id && l.attrs.isRef !== true && l.attrs.requirementRole !== 'subject' && !count.has(l.id),
      );
      if (g && clean && silent(e, holder, 0, true) && partnerOf(e, g)) {
        standsFor.set(e.id, { path, from: holder });
        continue;
      }
      unread.push(e);
      unreadEnds.add(e.id);
      // Its partner has what it says (`load = 50.0` below `pp = top.a`), which
      // the partner's own reading misses, as each end of an unread binding —
      // unless it says nothing of its own and has no type the partner lacks
      // (`in port cap = drone.battery.capacity`, a value only the call reads):
      // then the partner's reading is the whole of it.
      const quiet = silent(e, holder, 0, true);
      const named = valuePartners(model, e, path)
        .filter(({ partner }) => !quiet || ![...kinds(e)].every((t) => kinds(partner).has(t)))
        .flatMap(({ links: through }) => through);
      if (named.length > 0) partners.set(e.id, [...new Set(named)]);
      for (const p of named) unreadEnds.add(p.id);
    }
  }
  // A `satisfy R by x` that every surface reads once, at the definition's own
  // values, where an instance can make its satisfier another feature: written
  // in a definition or a usage another element specialises (or below one),
  // its satisfier — or a link of the path that names it — a reference with a
  // value, an end that stands for its partner, or a subject. W's `satisfy RF
  // by r` over `ref part r : T0 = pp` and `bind pp = top.a` was read at W's
  // own top's a and held, where w's top's a breaks it.
  const subjects = model.all().filter(
    (x) => x.attrs.isLibrary !== true && x.attrs.requirementRole === 'subject' && typeof x.attrs.value === 'string' && x.ownerId != null,
  );
  const definitions = model.ofKind('Satisfy').length > 0 || subjects.length > 0 ? sharedDefinitions(model) : undefined;
  const perInstance = (id: ElementId | null | undefined): boolean => {
    const seen = new Set<ElementId>();
    for (let x = id != null ? model.get(id) : undefined; x && !seen.has(x.id); x = x.ownerId != null ? model.get(x.ownerId) : undefined) {
      seen.add(x.id);
      if (!isUsage(x.eClass) && !isDefinition(x.eClass)) return false;
      if (definitions!.specialisersOf(x.id).length > 0) return true;
    }
    return false;
  };
  // A reference with no value that a usage redefines as a reference or with a
  // value (F1's `ref part :>> r = p50` in w over W's `ref part r : T0`): that
  // instance's r is another part, which a reading at W's own values never
  // reaches — built when first asked.
  let rebound: Set<ElementId> | undefined;
  const reboundRef = (l: ElementRecord): boolean => {
    if (l.attrs.isRef !== true) return false;
    if (!rebound) {
      rebound = new Set();
      for (const x of model.all()) {
        if (x.attrs.isLibrary === true || !isUsage(x.eClass)) continue;
        if (x.attrs.isRef !== true && (x.attrs.value === undefined || x.attrs.value === null)) continue;
        for (const g of redefinedClosure(model, x)) rebound.add(g.id);
      }
    }
    return rebound.has(l.id);
  };
  const standsElsewhere = (l: ElementRecord): boolean =>
    (l.attrs.isRef === true && typeof l.attrs.value === 'string') ||
    l.attrs.requirementRole === 'subject' ||
    standsFor.has(l.id) ||
    reboundRef(l);
  for (const rel of model.ofKind('Satisfy')) {
    if (rel.attrs.isLibrary === true || rel.ownerId == null) continue;
    const satisfier = rel.source?.[0] !== undefined ? model.get(rel.source[0]) : undefined;
    if (!satisfier) continue;
    const chain = rel.attrs.sourceChain ?? rel.attrs.sourceRef;
    const found = typeof chain === 'string' && VALUE_PATH.test(chain.trim()) ? featuresAlongValue(model, rel.ownerId, chain.trim()) : undefined;
    if ([...(found?.links ?? []), satisfier].some(standsElsewhere) && perInstance(rel.ownerId)) unread.push(rel);
  }
  // So is a requirement usage written there whose subject's value names it
  // through such a feature (F3's `requirement rr : RF { subject s = r; }` in
  // W, over W's `ref part r : T0` that w's `ref part :>> r = p50` redefines):
  // read at W's own r alone, never at w's p50.
  for (const s of subjects) {
    const requirement = model.get(s.ownerId!);
    const path = String(s.attrs.value).trim();
    if (!requirement || requirement.ownerId == null || !VALUE_PATH.test(path)) continue;
    const found = featuresAlongValue(model, requirement.id, path);
    if (found !== undefined && found.links.some(standsElsewhere) && perInstance(requirement.ownerId)) unread.push(s);
  }
  // A reference redefined with a value other than the one it redefines writes
  // with `=` (`ref part :>> r1 = p2` in w over W's `ref part r1 = p1`): the
  // model states both — a redefinition may override only a `default` — and the
  // binding row reads neither ({@link contradictedBindingOf}). A read through
  // it, or through a reference that reaches it (W's `r2 = r1` read in w), read
  // the redefinition's alone, decided on every surface.
  for (const e of model.all()) {
    if (e.attrs.isLibrary === true || e.attrs.isRef !== true || typeof e.attrs.value !== 'string') continue;
    if (redefinedClosure(model, e).length > 0 && contradictedBindingOf(model, e) !== undefined) unread.push(e);
  }
  // A feature that redefines one its own owner declares (`attribute mass default = 1.2; attribute :>> mass = 0.8;`
  // in Battery, `validation/redefinition-own-sibling`): the model states the feature twice, and each surface read
  // whichever value its walk met — the redefinition's `0.8` over the `default`, the `default` over a valueless
  // redefinition, SMT inconsistent beside the others. An unread pair of its own, the redefiner with the feature.
  for (const [f, g] of ownSiblingRedefinitions(model)) {
    if (!unread.includes(f)) unread.push(f);
    partners.set(f.id, [...new Set([...(partners.get(f.id) ?? []), g])]);
  }
  const fresh: NonNullable<ReturnType<typeof EQUATED_PARTS.get>> = { rev: model.rev, standsFor, unread, partners, unreadEnds, partnerEnds };
  EQUATED_PARTS.set(model, fresh);
  // The asserted equations decision 14 makes define a `default` this tool does
  // not read ({@link EnclosingAsserts.unreadAsserts}), each a source of its own:
  // read after the sweep is kept, since that index reads it (its `partnerEnds`).
  // Nothing {@link enclosingAsserts} reaches may read `unread`, `partners` or
  // the taint: until this returns they hold the sweep's sources alone. A throw
  // there (A.2.9) is kept as `failed`, never thrown out of the sweep: which rows
  // one of those equations reaches is then unknown, so every row a surface asks
  // about abstains in that sentence ({@link equatedPartsRefusal}) — never one
  // decided again from the sweep's sources alone, from the binding's default.
  let held: EnclosingAsserts['unreadAsserts'];
  try {
    held = instanceIndexSeam.enclosingAsserts(model).unreadAsserts;
  } catch (e) {
    fresh.failed =
      'the asserted equations that define a `default` this tool does not read (decision 14) could not be listed: ' +
      `the reading failed (${e instanceof Error ? e.constructor.name : 'error'}); reported, not dropped`;
    return fresh;
  }
  for (const { constraint, taint } of held.values()) {
    unread.push(constraint);
    partners.set(constraint.id, [...new Set([...(partners.get(constraint.id) ?? []), ...taint])]);
  }
  if (held.size > 0) delete fresh.taint;
  return fresh;
}

/**
 * What an unread part-valued binding ({@link equatedParts}) may carry a value
 * to, each with the binding, once per revision: its two ends and each usage
 * above an end up to where the binding is written (for an unread value, the
 * valued feature and its partners; for an unread `satisfy`, the satisfaction
 * itself, the context its rows are read in); then, to a fixpoint, the
 * ends of every binding one end of which is, or is read through, one of them
 * (and each usage above such an end); every feature whose value reads
 * through one; the first link of each name an asserted relation reads beside
 * one; what redefines or subsets one; an equated part whose partner is one
 * ({@link DefiningEquations.equatedPart}); and a `satisfy` of one. A relation
 * read through none of them, for an instance below none of them, reads what
 * the binding carries nowhere ({@link equatedPartsRefusal}).
 */
function equatedTaint(model: Model): ReadonlyMap<ElementId, ElementRecord> {
  const parts = equatedParts(model);
  if (parts.taint) return parts.taint;
  if (parts.unread.length === 0) return (parts.taint = new Map());
  // An asserted equation that is a source itself ({@link EnclosingAsserts.unreadAsserts}) taints what it names, not
  // the first link of each path it reads.
  const sources = new Set(parts.unread.filter((b) => isAsserted(b)).map((b) => b.id));
  parts.taint = spreadTaint(model, sources, (add) => {
    for (const b of parts.unread) {
      if (isBindingConnector(b)) {
        for (const id of [b.source?.[0], b.target?.[0]]) {
          const end = id !== undefined ? model.get(id) : undefined;
          if (end) add(end, b, b.ownerId!);
        }
      } else add(b, b);
      // A valued one's partner, as a binding's other end ({@link equatedParts}).
      for (const p of parts.partners.get(b.id) ?? []) add(p, b);
    }
  });
  return parts.taint;
}

/**
 * The fixpoint of {@link equatedTaint}, from what `seed` adds (each element with the source it is tainted by),
 * shared with {@link contradictedTaint}: the ends of every binding one end of which is, or is read through, a
 * tainted element (and, with `holders`, each usage above such an end: a part an equated part's value is carried
 * into; {@link contradictedTaint}'s values are attributes, whose holders carry none); every feature whose value
 * reads through one; the first link of each name an asserted relation reads beside one (`sources` aside: an
 * asserted equation that is a source itself taints what it names); what redefines or subsets one; an equated part
 * whose partner is one; and a `satisfy` of one. With `stated`, neither the binding step nor the asserted-relation
 * step taints an element `stated` holds (a feature that states its own value, {@link spreadContradiction}), and the
 * asserted-relation step taints the feature each name denotes, not its first link, where the name is dotted and
 * that feature is one: a part above it holds features that state their own values.
 */
function spreadTaint(
  model: Model,
  sources: ReadonlySet<ElementId>,
  seed: (add: (e: ElementRecord, b: ElementRecord, holder?: ElementId) => void) => void,
  holders = true,
  stated?: (e: ElementRecord) => boolean,
): Map<ElementId, ElementRecord> {
  const parts = equatedParts(model);
  const taint = new Map<ElementId, ElementRecord>();
  const defs = sharedDefinitions(model);
  const ownerOf = (e: ElementRecord): ElementRecord | undefined => (e.ownerId != null ? model.get(e.ownerId) : undefined);
  let grew = true;
  // `e`, and with `holder` each usage above it up to `holder`.
  const add = (e: ElementRecord, b: ElementRecord, holder?: ElementId): void => {
    for (let cur: ElementRecord | undefined = e; cur && cur.id !== holder; cur = ownerOf(cur)) {
      if (cur !== e && !isUsage(cur.eClass)) break;
      if (!taint.has(cur.id)) {
        taint.set(cur.id, b);
        grew = true;
      }
      if (holder === undefined) break;
    }
  };
  const users = model.all().filter((el) => el.attrs.isLibrary !== true);
  const bindings = users.filter((el) => isBindingConnector(el) && el.ownerId != null);
  const valued = users.filter((el) => isUsage(el.eClass) && typeof el.attrs.value === 'string');
  const asserted = users.filter((el) => isAsserted(el) && typeof el.attrs.expression === 'string');
  const narrowing = [...model.ofKind('Redefinition'), ...model.ofKind('Subsetting')];
  seed(add);
  const endsOf = (b: ElementRecord): ElementRecord[] =>
    [b.source?.[0], b.target?.[0]].flatMap((id) => (id !== undefined ? (model.get(id) ?? []) : []));
  while (grew) {
    grew = false;
    for (const b of bindings) {
      const ends = endsOf(b);
      const hit = ends
        .map((e) => taintedAt(model, taint, e) ?? readsTainted(model, taint, [b.ownerId!], bindingEndPath(model, e.id, b.ownerId!)))
        .find((x) => x !== undefined);
      if (hit) for (const e of ends) if (!stated?.(e)) add(e, hit, holders ? b.ownerId! : undefined);
    }
    for (const f of valued) {
      const hit = namesOfValue(f.attrs.value as string)
        .map((n) => readsTainted(model, taint, [f.ownerId!], n))
        .find((x) => x !== undefined);
      if (hit) add(f, hit);
    }
    for (const a of asserted) {
      if (sources.has(a.id)) continue;
      const roots = [a.ownerId, a.id].filter((x): x is ElementId => x != null);
      const names = relationNamesOf(a.attrs.expression as string);
      const hit = names.map((n) => readsTainted(model, taint, roots, n)).find((x) => x !== undefined);
      if (!hit) continue;
      for (const n of names) {
        const head = n.split('.')[0]!;
        for (const r of roots) {
          if (stated) {
            const whole = defs.denote(r).get(n)?.feature;
            if (whole && stated(whole)) continue;
            if (whole && n.includes('.')) {
              add(whole, hit);
              continue;
            }
          }
          const d = defs.denote(r).get(head);
          if (d && !stated?.(d.feature)) add(d.feature, hit);
        }
      }
    }
    for (const r of narrowing) {
      const target = r.target?.[0] !== undefined ? model.get(r.target[0]) : undefined;
      const source = r.source?.[0] !== undefined ? model.get(r.source[0]) : undefined;
      const hit = target ? taintedAt(model, taint, target) : undefined;
      if (hit && source) add(source, hit);
    }
    for (const [id, { path, from }] of parts.standsFor) {
      const end = model.get(id);
      const hit = readsTainted(model, taint, [from], path);
      if (end && hit) add(end, hit);
    }
    for (const rel of model.ofKind('Satisfy')) {
      const s = rel.source?.[0] !== undefined ? model.get(rel.source[0]) : undefined;
      const hit = s ? taintedAt(model, taint, s) : undefined;
      if (hit) add(rel, hit);
    }
  }
  return taint;
}

/** The binding whose value `e`, or a usage above it, may carry ({@link equatedTaint}). */
function taintedAt(model: Model, taint: ReadonlyMap<ElementId, ElementRecord>, e: ElementRecord | undefined): ElementRecord | undefined {
  const seen = new Set<ElementId>();
  for (let cur = e; cur && !seen.has(cur.id); cur = cur.ownerId != null ? model.get(cur.ownerId) : undefined) {
    seen.add(cur.id);
    const hit = taint.get(cur.id);
    if (hit) return hit;
    if (!isUsage(cur.eClass)) return undefined;
  }
  return undefined;
}

/**
 * The binding a dotted `name` read in `roots` (the first that resolves its
 * first link, else each namespace enclosing the first root) carries a value
 * through: a link that denotes a feature of {@link equatedTaint}, or is read
 * in one (a reference's `r.load` read in the `pp` it names), or the walk
 * reaches it through an instance at or below one ({@link Denotation}'s
 * `enclosing`, the scope's own root aside). A reference, a bound subject or
 * an equated end read in an instance reaches its partner through that
 * instance's own features, which no link of the name names: W's `pp = top.a`
 * read as `w.pp` is read through w's top, and w's `part :>> top = t50` is a
 * value no surface reads through (it read w's top as a fresh T1). So, last,
 * is every feature such a link lands on on the way ({@link
 * DefiningEquations.standsThrough}): W's `r2 = r1` read in w lands on w's own
 * r1 before the part it names.
 */
function readsTainted(
  model: Model,
  taint: ReadonlyMap<ElementId, ElementRecord>,
  roots: readonly ElementId[],
  name: string | undefined,
): ElementRecord | undefined {
  if (name === undefined || roots.length === 0) return undefined;
  const defs = sharedDefinitions(model);
  const segments = name.split('.');
  let scopes = roots.filter((r) => defs.denote(r).has(segments[0]!));
  if (scopes.length === 0) {
    scopes = [];
    const seen = new Set<ElementId>();
    for (let o = model.get(roots[0]!)?.ownerId ?? null; o != null && !seen.has(o); o = model.get(o)?.ownerId ?? null) {
      seen.add(o);
      scopes.push(o);
    }
  }
  for (const r of scopes) {
    const denoted = defs.denote(r);
    for (let k = 1; k <= segments.length; k++) {
      const d = denoted.get(segments.slice(0, k).join('.'));
      const hit = d
        ? (taintedAt(model, taint, d.feature) ??
          taintedAt(model, taint, model.get(d.reader)) ??
          d.enclosing.map((fr) => (fr.reader === r ? undefined : taintedAt(model, taint, model.get(fr.reader)))).find((x) => x !== undefined) ??
          defs.standsThrough(d.reader, d.feature).map((s) => taintedAt(model, taint, s)).find((x) => x !== undefined))
        : undefined;
      if (hit) return hit;
    }
  }
  return undefined;
}

/**
 * Did listing the asserted equations no surface reads throw ({@link
 * equatedParts}' `failed`, A.2.9)? Every row {@link equatedPartsRefusal}
 * refuses then abstains as `internal`: the reading failed.
 */
export function equatedPartsFailed(model: Model): boolean {
  return equatedParts(model).failed !== undefined || satisfierTaint(model).failed !== undefined;
}

/**
 * Why a relation row of `model` is not read ({@link equatedParts}), or
 * `undefined`: the row may read a value a part-valued binding neither end of
 * which stands for the other carries ({@link equatedTaint}) — a name of
 * `expression` read in its context (`at.contextId`; for its own row, where
 * the relation is written) through such a feature, or the instance it is read
 * for (that context, or `at.path`) at or below one. Each part says something
 * of its own that the other's reading would miss. Every surface leaves such a
 * row undecided in this sentence (`checkConstraints` of ./evaluate-model,
 * `numericRows` of ./solver, `obligationsOf` of ./obligations, under the
 * reason `unread-binding`: a limit of this tool, not a defect in the
 * relation); any other row reads as before. So does a row read in a
 * `satisfy`, or through the subject of a requirement usage a value binds,
 * that an instance of the element it is written in reads otherwise ({@link
 * satisfierTaint}): each of R's read there, a relation the usage owns, and
 * any other read through that subject (`w.q.s.load`); and a row read through
 * a reference valued with a feature around it that an instance reads
 * otherwise, or through a reference redefinition that states no value of the
 * valued one it redefines, or through a usage that subsets a feature an
 * instance reads otherwise (`part p2 :> p1;`, {@link
 * DefiningEquations.subsettingOtherwise}) — or through a value, a binding or
 * an asserted equation that reads through any of them.
 */
export function equatedPartsRefusal(
  model: Model,
  relationId: ElementId,
  expression: string,
  at?: { contextId: ElementId; path?: string },
): string | undefined {
  return unreadRefusal(model, relationId, expression, at) ?? satisfierRefusal(model, relationId, expression, at);
}

/**
 * The `satisfy`s, the subjects of requirement usages and the references an
 * instance of the element they are resolved in reads otherwise ({@link
 * DefiningEquations.satisfierOtherwise}, {@link
 * DefiningEquations.referenceOtherwise}), once per revision: each by its own
 * id — the `satisfy`, the context its rows are read in; the subject or the
 * reference, which every read through it reaches; and the requirement usage
 * whose subject it is, whose clauses and features read through that subject
 * by names no link of which is the subject (`m` over `attribute m = s.load`)
 * — with that answer; and the usages that subset a feature an instance reads
 * otherwise ({@link subsettingTaint}: `part p2 :> p1;`), with what reads
 * through them. Then, to a fixpoint, as {@link equatedTaint} follows an
 * unread binding: every usage whose value reads through one (RC7's `attribute
 * m = r.load` in W's `part sub { ref part r : T0 = p1; }`, read as `sub.m` and
 * `w.sub.m`), the ends of a binding one end of which is one or reads through
 * one, what else an asserted relation that reads through one names (`x == r.load`),
 * and what redefines or subsets one (`ref part :>> r;` in an instance, a `::>`
 * too), each with the answer of what it reads through. The taint stopped at the
 * reference, so `sub.m <= 5.0` read W's own p1 (1) for every W, where w's is
 * 50: true on all four surfaces. What they name is read per instance as any
 * feature is. `grouped` leaves the references themselves out: a group's
 * instance row re-resolves a reference in its own instance, and abstains
 * where that lands elsewhere ({@link instanceReadsOtherwise}).
 */
const SATISFIERS_OTHERWISE = new WeakMap<Model, SatisfiersOtherwise>();

/**
 * {@link SATISFIERS_OTHERWISE}' entry. `failed` where building it threw
 * (A.2.9): which rows read through one is then unknown, so every row {@link
 * equatedPartsRefusal} is asked about abstains in that sentence, as `internal`
 * ({@link equatedPartsFailed}) — never decided from an empty taint, and never
 * a throw out of the check, which ended the load (`import/internal-error`, no
 * model at all). Kept for the revision, as {@link equatedParts}' is.
 */
interface SatisfiersOtherwise {
  rev: number;
  taint: ReadonlyMap<ElementId, ElementRecord>;
  grouped: ReadonlyMap<ElementId, ElementRecord>;
  why: ReadonlyMap<ElementId, ReadOtherwise>;
  failed?: string;
}

function satisfierTaint(model: Model): SatisfiersOtherwise {
  const hit = SATISFIERS_OTHERWISE.get(model);
  if (hit && hit.rev === model.rev) return hit;
  let fresh: SatisfiersOtherwise;
  try {
    fresh = instanceIndexSeam.satisfiersOtherwise(model);
  } catch (e) {
    fresh = {
      rev: model.rev,
      taint: new Map(),
      grouped: new Map(),
      why: new Map(),
      failed:
        'the satisfactions, subjects, references and subsetting usages an instance reads otherwise could not be listed: the reading failed ' +
        `(${e instanceof Error ? e.constructor.name : 'error'}); reported, not dropped`,
    };
  }
  SATISFIERS_OTHERWISE.set(model, fresh);
  return fresh;
}

/** {@link satisfierTaint}, worked out — uncontained, and reached only through {@link instanceIndexSeam}. */
function satisfiersOtherwise(model: Model): SatisfiersOtherwise {
  const taint = new Map<ElementId, ElementRecord>();
  const why = new Map<ElementId, ReadOtherwise>();
  const subjects = model.all().filter(
    (x) => x.attrs.isLibrary !== true && x.attrs.requirementRole === 'subject' && typeof x.attrs.value === 'string' && x.ownerId != null,
  );
  const satisfies = model.ofKind('Satisfy').filter((x) => x.attrs.isLibrary !== true);
  const references = model.all().filter(
    (x) => x.attrs.isLibrary !== true && x.attrs.isRef === true && typeof x.attrs.value === 'string' && x.ownerId != null,
  );
  if (subjects.length > 0 || satisfies.length > 0 || references.length > 0) {
    const defs = sharedDefinitions(model);
    for (const rel of satisfies) {
      const answer = defs.satisfierOtherwise(rel.id);
      if (!answer) continue;
      taint.set(rel.id, rel);
      why.set(rel.id, answer);
    }
    for (const subject of subjects) {
      const answer = defs.satisfierOtherwise(subject.ownerId!);
      if (answer) {
        taint.set(subject.id, subject);
        why.set(subject.id, answer);
        if (!taint.has(subject.ownerId!)) taint.set(subject.ownerId!, subject);
        continue;
      }
      // Read through from outside (`w.q.s.load`), the subject reads any feature below its path, not only what
      // R's clauses read: R's rows in q read as before, every read through the subject abstains.
      const wide = defs.subjectOtherwise(subject);
      if (!wide) continue;
      taint.set(subject.id, subject);
      why.set(subject.id, wide);
    }
    for (const r of references) {
      const answer = defs.referenceOtherwise(r);
      if (!answer) continue;
      taint.set(r.id, r);
      why.set(r.id, answer);
    }
  }
  // A reference redefinition that states no value of the valued reference it
  // redefines (`ref part :>> r;` in `w : W` over W's `ref part r : T0 = x`):
  // the walk reads it as a fresh instance of its type, never as what `x`
  // names, so `W::c { r.load <= 5.0 }` read in w and `w.r.load` read T0's
  // default where w's x is 50 — true on all four surfaces. So is the copy a
  // binding's end makes of a valued reference (w's `bind m = pp.load` over W's
  // `ref part pp : T0 = top.a`): `w.m` read T0's default 1 where w's `ref part
  // :>> top = t50` makes it 50, on all four surfaces since before the branch.
  for (const s of model.ofKind('Redefinition')) {
    const source = s.source?.[0] !== undefined ? model.get(s.source[0]) : undefined;
    if (!source || taint.has(source.id) || source.attrs.isLibrary === true) continue;
    const copy = source.attrs.implicit === true;
    if ((!copy && source.attrs.isRef !== true) || source.ownerId == null || source.attrs.value !== undefined) continue;
    const valued = redefinedClosure(model, source).find((g) => typeof g.attrs.value === 'string');
    const scope = model.get(source.ownerId);
    if (!valued || !scope || (copy && valued.attrs.isRef !== true)) continue;
    taint.set(source.id, source);
    why.set(source.id, { kind: 'valueless', written: source, scope, path: String(valued.attrs.value).trim(), instance: undefined, redefined: valued });
  }
  // A usage that subsets a feature an instance reads otherwise ({@link subsettingTaint}), with what reads through it.
  const subsetting = subsettingTaint(model);
  for (const [id, source] of subsetting.taint) if (!taint.has(id)) taint.set(id, source);
  for (const [id, answer] of subsetting.why) if (!why.has(id)) why.set(id, answer);
  // An end of a connection the model connects to features (`connection cn : C connect w.p1 to t;`) is the feature it is
  // connected to, which may state what the end's type does not (w's `p1` redefines `load = 50.0`); the walk reads the end
  // as its own type has it (`cn.a.load` read T0's default where w's p1 is 50). Every end of the types of such a connection
  // is read by no relation: weaker than reading the connected feature, never false.
  for (const c of model.all()) {
    if (c.attrs.isLibrary === true || !['ConnectionUsage', 'InterfaceUsage', 'FlowUsage'].includes(c.eClass)) continue;
    if ((c.source?.length ?? 0) === 0 && (c.target?.length ?? 0) === 0) continue;
    for (const type of model.typesOf(c.id)) {
      if (type.attrs.isLibrary === true) continue;
      for (const end of effectiveFeatures(model, type.id)) {
        if (end.attrs.isEnd !== true || end.attrs.isLibrary === true || taint.has(end.id)) continue;
        taint.set(end.id, end);
        if (!why.has(end.id)) why.set(end.id, { kind: 'end', written: c, scope: type, path: effectiveNameOf(model, end) ?? '', instance: undefined, redefined: end });
      }
    }
  }
  // What subsets one by reference (`ref part r2 ::> r;`) too, as {@link subsettingTaint} follows.
  if (taint.size > 0) spreadOtherwise(model, taint, [...model.ofKind('Redefinition'), ...model.ofKind('Subsetting', 'ReferenceSubsetting')]);
  // Only a reference itself is left to a group's own re-resolution: what reads through it is not.
  const grouped = new Map([...taint].filter(([id, source]) => !(id === source.id && why.get(id)?.kind === 'reference')));
  return { rev: model.rev, taint, grouped, why };
}

/**
 * {@link satisfierTaint}'s fixpoint, in place: every usage whose value reads through an element of `taint`, the
 * ends of a binding one end of which is one or reads through one, the first link of each other name an asserted
 * relation reads beside one (as {@link spreadTaint}'s step: decision 14, an asserted equation defines what it
 * names), and the source of each of `narrowing` (the redefinitions and subsettings) whose target is one, each with
 * the source of what it reads through.
 */
function spreadOtherwise(model: Model, taint: Map<ElementId, ElementRecord>, narrowing: readonly ElementRecord[]): void {
  const users = model.all().filter((el) => el.attrs.isLibrary !== true);
  // A calculation's body reads like a value written beside it (`calc m1 { 10.0 - p1.load }` in W).
  const valueText = (el: ElementRecord): string | undefined =>
    typeof el.attrs.value === 'string' ? el.attrs.value : el.eClass === 'CalculationUsage' && typeof el.attrs.expression === 'string' ? el.attrs.expression : undefined;
  const valued = users.filter((el) => isUsage(el.eClass) && valueText(el) !== undefined && el.ownerId != null);
  const bindings = users.filter((el) => isBindingConnector(el) && el.ownerId != null);
  const asserted = users.filter((el) => isAsserted(el) && typeof el.attrs.expression === 'string' && el.ownerId != null);
  const defs = sharedDefinitions(model);
  const endsOf = (b: ElementRecord): ElementRecord[] =>
    [b.source?.[0], b.target?.[0]].flatMap((id) => (id !== undefined ? (model.get(id) ?? []) : []));
  let grew = true;
  const join = (e: ElementRecord, source: ElementRecord): void => {
    if (taint.has(e.id) || e.attrs.isLibrary === true) return;
    taint.set(e.id, source);
    grew = true;
  };
  while (grew) {
    grew = false;
    for (const f of valued) {
      if (taint.has(f.id)) continue;
      const hit = namesOfValue(valueText(f)!)
        .map((n) => readsTainted(model, taint, [f.ownerId!], n))
        .find((x) => x !== undefined);
      if (hit) join(f, hit);
    }
    for (const b of bindings) {
      const ends = endsOf(b);
      const hit = ends
        .map((e) => taintedAt(model, taint, e) ?? readsTainted(model, taint, [b.ownerId!], bindingEndPath(model, e.id, b.ownerId!)))
        .find((x) => x !== undefined);
      if (hit) for (const e of ends) join(e, hit);
    }
    // An asserted equation that reads through one gives what else it names that value (decision 14): W's `assert
    // constraint { x == p2.load }`, or a package's `y == w.p2.load`, over W's `part p2 :> p1;` made `w.x <= 5.0`
    // read W's own p2 (1) where w's is 50, true on all four surfaces, and `bounds` claimed "1 exactly". A name that
    // reads through one itself is left out: its first link (the package's w) holds what is read alike.
    for (const a of asserted) {
      const roots = [a.ownerId!, a.id];
      const names = relationNamesOf(a.attrs.expression as string);
      const through = names.map((n) => readsTainted(model, taint, roots, n));
      const hit = through.find((x) => x !== undefined);
      if (!hit) continue;
      names.forEach((n, i) => {
        if (through[i] !== undefined) return;
        const head = n.split('.')[0]!;
        for (const r of roots) {
          const d = defs.denote(r).get(head);
          if (d) join(d.feature, hit);
        }
      });
    }
    for (const r of narrowing) {
      const target = r.target?.[0] !== undefined ? model.get(r.target[0]) : undefined;
      const source = r.source?.[0] !== undefined ? model.get(r.source[0]) : undefined;
      const hit = target ? taint.get(target.id) : undefined;
      if (hit && source) join(source, hit);
    }
  }
}

/**
 * The usages that subset a feature an instance of the element it is a feature
 * of reads otherwise ({@link DefiningEquations.subsettingOtherwise}) — each by
 * its own id, with that answer — and, to {@link spreadOtherwise}'s fixpoint,
 * what reads through one: a usage whose value does, a binding's ends, and what
 * redefines or subsets one (`part p3 :> p2;`, a reference subsetting `::>`
 * too), once per revision. {@link satisfierTaint} takes it whole; it is kept
 * apart because a `satisfy` whose satisfier is read through one is answered
 * from it ({@link DefiningEquations.satisfierOtherwise}), and that answer is
 * one {@link satisfierTaint} is built from. Asked again while it is built,
 * it throws, uncached: the asker lists that context, read and contained on
 * its own (A.2.9), rather than read it from part of the answer. The path
 * there is the instance test of a subsetted feature whose element a `satisfy`
 * specialises (R's `part q :> s;`) asking each `satisfy` of R: the one whose
 * question started the listing is met by {@link
 * DefiningEquations.satisfierOtherwise}'s own re-entry guard, a second one
 * written in a package by this throw (two package `satisfy R by …`, RE3);
 * both are listed, and q's rows abstain. A throw out of the listing itself
 * is contained where {@link satisfierTaint} is: every row it may reach
 * abstains, `internal`.
 */
const SUBSETTINGS_OTHERWISE = new WeakMap<Model, SubsettingsOtherwise>();
/** The models whose {@link subsettingTaint} is being built. */
const SUBSETTINGS_LISTING = new WeakSet<Model>();

/**
 * Is {@link subsettingTaint} being built for `model`? The per-instance walk then lists no context for being at or
 * below one of its usages ({@link DefiningEquations.changingContexts}): the listing's own test is that walk.
 */
function subsettingsBeingListed(model: Model): boolean {
  return SUBSETTINGS_LISTING.has(model);
}

/** {@link SUBSETTINGS_OTHERWISE}' entry. */
interface SubsettingsOtherwise {
  rev: number;
  taint: ReadonlyMap<ElementId, ElementRecord>;
  why: ReadonlyMap<ElementId, ReadOtherwise>;
}

function subsettingTaint(model: Model): SubsettingsOtherwise {
  const hit = SUBSETTINGS_OTHERWISE.get(model);
  if (hit && hit.rev === model.rev) return hit;
  if (SUBSETTINGS_LISTING.has(model)) throw new Error('the subsettings an instance reads otherwise are being listed');
  SUBSETTINGS_LISTING.add(model);
  try {
    const fresh = instanceIndexSeam.subsettingsOtherwise(model);
    SUBSETTINGS_OTHERWISE.set(model, fresh);
    return fresh;
  } finally {
    SUBSETTINGS_LISTING.delete(model);
  }
}

/**
 * {@link subsettingTaint}, worked out — uncontained, and reached only through {@link instanceIndexSeam}. A usage a
 * context reads otherwise, or that subsets one that does, is tainted ({@link DefiningEquations.subsettingOtherwise},
 * {@link DefiningEquations.subsettedOtherwise}); then, to a fixpoint, every OTHER usage it subsets, whatever its own
 * answer was (a usage with two supers is both of them: `part u3 :> u1, u2;` beside w's `:>> u2 { … }` makes w's u1 the
 * valued one too), alternating with {@link spreadOtherwise}, which brings what subsets or reads through a tainted one:
 * the whole undirected subsetting component of a usage read otherwise abstains, whatever the multiplicities (the
 * feature the context redefines itself is read as it says). Each usage's sentence is the nearest one's, then the
 * lowest qualified name — not the order the relations were written in.
 */
function subsettingsOtherwise(model: Model): SubsettingsOtherwise {
  const taint = new Map<ElementId, ElementRecord>();
  const why = new Map<ElementId, ReadOtherwise>();
  const subsettings = model.ofKind('Subsetting', 'ReferenceSubsetting').filter((r) => r.attrs.isLibrary !== true);
  if (subsettings.length === 0) return { rev: model.rev, taint, why };
  const defs = sharedDefinitions(model);
  const pairs = subsettings.flatMap((r) => {
    const f = r.source?.[0] !== undefined ? model.get(r.source[0]) : undefined;
    const g = r.target?.[0] !== undefined ? model.get(r.target[0]) : undefined;
    return f && g ? [{ r, f, g, key: `${defs.qualifiedNameOf(f.id)} ${defs.qualifiedNameOf(g.id)}` }] : [];
  });
  pairs.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  const nameKey = (r: ElementRecord): string => `${defs.qualifiedNameOf(r.source?.[0] ?? '')} ${defs.qualifiedNameOf(r.target?.[0] ?? '')}`;
  const hops = new Map<ElementId, number>();
  const offers = new Map<ElementId, { answer: ReadOtherwise; hop: number; key: string }>();
  const offer = (g: ElementRecord, answer: ReadOtherwise, hop: number): void => {
    if (taint.has(g.id)) return;
    const near = answer.subsetter ?? answer.written;
    const key = `${String(hop).padStart(6, '0')} ${defs.qualifiedNameOf(near.id)} ${defs.qualifiedNameOf((answer.root ?? answer.redefined ?? near).id)}`;
    const cur = offers.get(g.id);
    if (!cur || key < cur.key) offers.set(g.id, { answer, hop, key });
  };
  /** Take the offers: the best of each usage; whether any is new. */
  const accept = (): boolean => {
    let any = false;
    for (const [id, { answer, hop }] of offers) {
      const g = model.get(id);
      if (!g || taint.has(id)) continue;
      taint.set(id, g);
      why.set(id, answer);
      hops.set(id, hop);
      any = true;
    }
    offers.clear();
    return any;
  };
  // A usage that subsets more than one (`part u4 :> u1, u3;`) joins them into one: where a member of the component says
  // something of its own (a value, a redefinition below it), that is the value of every member, in every instance of
  // what they are features of — instances that redefine nothing included. The walk reads each at its own values.
  const bridges = new Map<ElementId, ElementRecord>();
  {
    const supers = new Map<ElementId, Set<ElementId>>();
    const members = new Map<ElementId, ElementRecord>();
    const parent = new Map<ElementId, ElementId>();
    const find = (x: ElementId): ElementId => {
      let r = x;
      while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
      return r;
    };
    for (const { f, g } of pairs) {
      if (f.id === g.id || !isUsage(f.eClass) || !isUsage(g.eClass) || f.attrs.isLibrary === true || g.attrs.isLibrary === true) continue;
      supers.set(f.id, (supers.get(f.id) ?? new Set<ElementId>()).add(g.id));
      members.set(f.id, f);
      members.set(g.id, g);
      for (const x of [f.id, g.id]) if (!parent.has(x)) parent.set(x, x);
      parent.set(find(f.id), find(g.id));
    }
    const joins = [...supers].filter(([, set]) => set.size >= 2).map(([id]) => members.get(id)!);
    if (joins.length > 0) {
      const components = new Map<ElementId, ElementRecord[]>();
      for (const m of members.values()) components.set(find(m.id), [...(components.get(find(m.id)) ?? []), m]);
      for (const via of joins.sort((a, b) => (defs.qualifiedNameOf(a.id) < defs.qualifiedNameOf(b.id) ? -1 : 1))) {
        const all = components.get(find(via.id)) ?? [];
        const sayer = all.filter((m) => defs.saysOwnOver(m, all.filter((o) => o.id !== m.id), true)).sort((a, b) => (defs.qualifiedNameOf(a.id) < defs.qualifiedNameOf(b.id) ? -1 : 1))[0];
        if (!sayer) continue;
        for (const m of all) {
          const scope = m.ownerId != null ? model.get(m.ownerId) : undefined;
          if (!scope || bridges.has(m.id)) continue;
          bridges.set(m.id, m);
          offer(m, { kind: 'subsetting', written: m, scope, path: defs.nameOf(m) ?? '', instance: undefined, subsetter: via, bridge: { via, sayer } }, 0);
        }
      }
    }
  }
  // The usages that subset a feature an instance reads otherwise, and the subsetted usage of a subsetter that is
  // (RV1): it is the subsetter's value that fills it there, which the walk reads at the owner's own values.
  for (const { f, g } of pairs) {
    const own = defs.subsettingOtherwise(f);
    if (own) offer(f, own, 0);
    const other = defs.subsettedOtherwise(f, g);
    if (other) offer(g, other, 0);
  }
  accept();
  if (taint.size === 0) return { rev: model.rev, taint, why };
  const narrowing = [...model.ofKind('Redefinition'), ...subsettings].map((r) => ({ r, key: nameKey(r) })).sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0)).map((x) => x.r);
  const answerOf = (x: ElementRecord): ReadOtherwise | undefined => {
    const source = taint.get(x.id);
    return source ? why.get(source.id) : undefined;
  };
  for (let grew = true; grew; ) {
    // Every other usage a tainted one subsets (not the feature the instance itself redefines), nearest first.
    for (let more = true; more; more = accept()) {
      for (const { f, g } of pairs) {
        const a = answerOf(f);
        if (!a || taint.has(g.id) || g.id === f.id || g.attrs.isLibrary === true || !isUsage(g.eClass)) continue;
        const seed = a.root ?? a.subsetter ?? a.written;
        const scope = g.ownerId != null ? model.get(g.ownerId) : undefined;
        // f's own distance from the usage a context reads otherwise: its accepted hop, else (joined by what reads through a
        // tainted usage) one more than the usage it was joined from.
        const own = hops.get(f.id) ?? (hops.get(taint.get(f.id)!.id) ?? 0) + 1;
        offer(g, { ...a, written: g, scope: scope ?? a.scope, reader: a.reader ?? a.scope, subsetter: f, root: seed.id === f.id ? undefined : seed }, own + 1);
      }
    }
    const size = taint.size;
    spreadOtherwise(model, taint, narrowing);
    grew = taint.size > size;
  }
  return { rev: model.rev, taint, why };
}

/** {@link equatedPartsRefusal} for a row read in, or through, what {@link satisfierTaint} holds. */
function satisfierRefusal(
  model: Model,
  relationId: ElementId,
  expression: string,
  at?: { contextId: ElementId; path?: string },
): string | undefined {
  const { taint: all, grouped, why, failed } = satisfierTaint(model);
  if (failed !== undefined) return relationNamesOf(expression).length > 0 ? `${failed}, so no relation that may read one is read` : undefined;
  if (all.size === 0) return undefined;
  // A row of an expanded group — an instance's (`at.path`), or the usage's own, beside which every other
  // instance is a row of its own — reads a reference in its own instance ({@link instanceGroups}).
  const inGroup =
    at !== undefined &&
    (at.path !== undefined || instanceGroups(model).some((g) => g.expanded && g.relationId === relationId && g.usageId === at.contextId));
  const taint = inGroup ? grouped : all;
  if (taint.size === 0) return undefined;
  const rel = model.get(relationId);
  const context = at ? model.get(at.contextId) : rel;
  const roots = [at ? at.contextId : rel?.ownerId, relationId].filter((x): x is ElementId => x != null);
  const b =
    relationNamesOf(expression)
      .map((n) => readsTainted(model, taint, roots, n))
      .find((x) => x !== undefined) ??
    taintedAt(model, taint, context) ??
    subsettingAround(model, at ? context : rel?.ownerId != null ? model.get(rel.ownerId) : undefined);
  const answer = b ? why.get(b.id) : undefined;
  return answer ? satisfierSentence(model, answer) : undefined;
}

/**
 * The usage of {@link subsettingTaint} at or below a context that specialises
 * an element the usage `el` — a row's context, or the owner of the relation an
 * own row reads — is nested in, from its owner outward to the first
 * definition; else `undefined`. Such a context has its own instance of `el`,
 * which no element names, so no context row is listed for it ({@link
 * DefiningEquations.changingContexts} lists those of `el` itself), and the
 * walk reads it as `el` reads, at the element's own values: TC8's T1 `part sub
 * { attribute v = load; constraint tc { v <= 5.0 } }`, under W's `part p2 :
 * T1 :> p1;` beside w's `part :>> p1 { attribute :>> load = 50.0; }`, read T1's
 * 1 for every T1's sub — true on all four surfaces, where w's p2's sub reads
 * 50. So the row abstains.
 */
function subsettingAround(model: Model, el: ElementRecord | undefined): ElementRecord | undefined {
  const { taint } = subsettingTaint(model);
  if (taint.size === 0) return undefined;
  const defs = sharedDefinitions(model);
  const seen = new Set<ElementId>();
  for (let cur = el; cur && isUsage(cur.eClass) && cur.ownerId != null && !seen.has(cur.id); ) {
    seen.add(cur.id);
    const owner = model.get(cur.ownerId);
    if (!owner || isPackage(owner)) return undefined;
    for (const s of defs.specialisersOf(owner.id)) {
      const hit = taintedAt(model, taint, s);
      if (hit) return hit;
    }
    cur = owner;
  }
  return undefined;
}

/** {@link equatedPartsRefusal} for what {@link equatedParts} leaves unread. */
function unreadRefusal(
  model: Model,
  relationId: ElementId,
  expression: string,
  at?: { contextId: ElementId; path?: string },
): string | undefined {
  const { unread, failed } = equatedParts(model);
  if (failed !== undefined) return relationNamesOf(expression).length > 0 ? `${failed}, so no relation that may read one is read` : undefined;
  if (unread.length === 0) return undefined;
  const names = relationNamesOf(expression);
  if (names.length === 0) return undefined;
  const taint = equatedTaint(model);
  const rel = model.get(relationId);
  const context = at ? model.get(at.contextId) : rel;
  const roots = [at ? at.contextId : rel?.ownerId, relationId].filter((x): x is ElementId => x != null);
  let b = names.map((n) => readsTainted(model, taint, roots, n)).find((x) => x !== undefined);
  b ??= taintedAt(model, taint, context);
  if (!b && at?.path !== undefined) {
    const frames = sharedDefinitions(model).framesAbove(at.path);
    b = frames === undefined ? unread[0] : frames.map((fr) => taintedAt(model, taint, model.get(fr.reader))).find((x) => x !== undefined);
  }
  if (!b) return undefined;
  return b.eClass === 'Satisfy'
    ? `${equatedSentence(model, b)}, so no relation it requires of the satisfier is read`
    : `${equatedSentence(model, b)}, so no relation that may read a value it carries is read`;
}

/**
 * Why `bounds` claims no bound of the feature `featureId`, read as the
 * instance symbol `symbol` (`PPB::pp::load`) and spelled `spelled` (the
 * `--measure` text), or `undefined`: the measure may read a value a
 * part-valued binding neither end of which stands for the other carries
 * ({@link equatedTaint}) — the feature is one such a binding may carry a
 * value to, an instance the symbol is read through is at or below one, or
 * the dotted path spelled is read through one ({@link readsTainted}, from
 * each of the user's packages that reads it, as `--measure` resolves it).
 * The axioms hold no equality for such a binding, so a bound over them would
 * be the measure's own value alone: pp's `default = 3.0` was bounded "3
 * exactly" where `bind pp = top.a` makes it top's a's 50, and `top.a.load`,
 * resolved to T0's own `load` (no relation reads top's a's), was bounded at
 * T0's 1 where pp's `load = 50.0` makes it 50. So for a measure read in, or
 * through, a `satisfy`, a subject, a reference, a valueless reference
 * redefinition or a subsetting usage an instance reads otherwise ({@link
 * satisfierTaint}): `w.q.s.load` resolved to T0's own load, `w.sub.m` to W's
 * own sub's m, `w.r.load` over w's `ref part :>> r;` to T0's load and
 * `w.p2.load` over W's `part p2 :> p1;` to T0's load were each bounded "1
 * exactly" where w's is 50.
 */
export function equatedPartsMeasureRefusal(
  model: Model,
  featureId: ElementId,
  symbol: string,
  spelled?: string,
): string | undefined {
  return unreadMeasureRefusal(model, featureId, symbol, spelled) ?? satisfierMeasureRefusal(model, featureId, symbol, spelled);
}

/** {@link equatedPartsMeasureRefusal} for a measure read through what {@link satisfierTaint} holds. */
function satisfierMeasureRefusal(model: Model, featureId: ElementId, symbol: string, spelled?: string): string | undefined {
  const { taint, why, failed } = satisfierTaint(model);
  if (failed !== undefined) return `${failed}, so no bound of a value read through one is claimed`;
  if (taint.size === 0) return undefined;
  let b = taintedAt(model, taint, model.get(featureId));
  if (!b && spelled !== undefined && spelled.includes('.') && VALUE_PATH.test(spelled)) {
    const defs = sharedDefinitions(model);
    for (const p of model.all()) {
      if (b || p.attrs.isLibrary === true || p.attrs.implicit === true || !isPackage(p) || !defs.denote(p.id).has(spelled)) continue;
      b = readsTainted(model, taint, [p.id], spelled);
    }
  }
  b ??= sharedDefinitions(model)
    .framesAbove(symbol)
    ?.map((fr) => taintedAt(model, taint, model.get(fr.reader)))
    .find((x) => x !== undefined);
  const answer = b ? why.get(b.id) : undefined;
  return answer ? satisfierSentence(model, answer, true) : undefined;
}

/** {@link equatedPartsMeasureRefusal} for what {@link equatedParts} leaves unread. */
function unreadMeasureRefusal(model: Model, featureId: ElementId, symbol: string, spelled?: string): string | undefined {
  const { unread, failed } = equatedParts(model);
  if (failed !== undefined) return `${failed}, so no bound of a value one may give is claimed`;
  if (unread.length === 0) return undefined;
  const taint = equatedTaint(model);
  let b = taintedAt(model, taint, model.get(featureId));
  if (!b && spelled !== undefined && spelled.includes('.') && VALUE_PATH.test(spelled)) {
    const defs = sharedDefinitions(model);
    for (const p of model.all()) {
      if (b || p.attrs.isLibrary === true || p.attrs.implicit === true || !isPackage(p) || !defs.denote(p.id).has(spelled)) continue;
      b = readsTainted(model, taint, [p.id], spelled);
    }
  }
  if (!b) {
    const frames = sharedDefinitions(model).framesAbove(symbol);
    b = frames === undefined ? unread[0] : frames.map((fr) => taintedAt(model, taint, model.get(fr.reader))).find((x) => x !== undefined);
  }
  return b ? `${equatedSentence(model, b)}, so no bound of a value it may carry is claimed` : undefined;
}

/**
 * Why a `satisfy`, or a requirement usage whose subject a value binds, is not
 * read ({@link DefiningEquations.satisfierOtherwise}): read at the values of
 * the element its satisfier is resolved in, it holds of no instance that
 * reads the satisfier otherwise, and this tool reads it in none. So for a
 * reference valued with a feature around it ({@link
 * DefiningEquations.referenceOtherwise}), for a reference redefinition
 * that states no value of the valued one it redefines (`valueless`), which
 * the walk reads as a fresh instance of its type, and for a usage that
 * subsets a feature an instance reads otherwise (`subsetting`, {@link
 * DefiningEquations.subsettingOtherwise}), which the walk reads through that
 * feature as its element has it — named too where a `satisfy` or a subject
 * is read through one (`via`; in a package, one instance, the sentence's
 * only reason).
 */
function satisfierSentence(model: Model, s: ReadOtherwise, measure = false): string {
  const where = effectiveQualifiedName(model, s.scope.id);
  // `bounds` claims no bound of a measure read through it ({@link equatedPartsMeasureRefusal}).
  const so = (rows: string): string => (measure ? ', so no bound of a value read through it is claimed' : `, so ${rows} is read`);
  if (s.kind === 'valueless') {
    const name = effectiveNameOf(model, s.written) ?? s.written.id;
    const redefined = s.redefined ? effectiveQualifiedName(model, s.redefined.id) : 'a valued reference';
    const what =
      s.written.attrs.implicit === true
        ? `the copy of ${redefined} (\`= ${s.path}\`) that a binding's end makes in ${where} as \`${name}\` states no value of its own`
        : `\`${name}\` in ${where} redefines ${redefined} (\`= ${s.path}\`) and states no value of its own`;
    return `${what}: this tool reads it as a fresh instance of its type, never as what \`${s.path}\` names${so('no relation that reads through it')}`;
  }
  if (s.kind === 'end') {
    const connection = effectiveNameOf(model, s.written) ?? s.written.id;
    return (
      `\`${connection}\` connects features to the end \`${s.path}\` of ${where}: the end is the feature it is connected to, which may state what ` +
      `the end's type does not, and this tool reads it as ${where} has it${so(`no relation that reads through \`${s.path}\``)}`
    );
  }
  const who = s.instance ? effectiveQualifiedName(model, s.instance.id) : `an instance of ${where}`;
  if (s.kind === 'subsetting' && s.bridge) {
    const name = effectiveNameOf(model, s.written) ?? s.written.id;
    const nm = (e: ElementRecord): string => `\`${effectiveNameOf(model, e) ?? e.id}\``;
    const { via, sayer } = s.bridge;
    const rows = so(`no relation that reads through \`${name}\``);
    const reads = `this tool reads \`${name}\` at ${where}'s own values`;
    return s.written.id === sayer.id
      ? `\`${name}\` in ${where} says something of its own, and ${nm(via)} subsets more than one usage, which joins it with the others: ${reads}, never as one of them${rows}`
      : `\`${name}\` in ${where} is one usage with ${nm(sayer)}, which says something of its own (${nm(via)} subsets more than one usage, which joins them): ${reads}, never as the ${nm(sayer)} it is${rows}`;
  }
  if (s.kind === 'subsetting' && s.chain && s.subsetter) {
    const name = effectiveNameOf(model, s.written) ?? s.written.id;
    const nm = (e: ElementRecord): string => `\`${effectiveNameOf(model, e) ?? e.id}\``;
    const sayer = s.root ?? s.subsetter;
    return (
      `\`${name}\` in ${where} is one usage with ${nm(sayer)}, which says something of its own and is declared outside the instances and definitions that have \`${name}\` as a feature (in a package, or naming it through a path): ` +
      `this tool reads \`${name}\` at ${where}'s own values, never as the ${nm(sayer)} it is${so(`no relation that reads through \`${name}\` or ${nm(sayer)}`)}`
    );
  }
  if (s.kind === 'subsetting' && s.subsetter) {
    const name = effectiveNameOf(model, s.written) ?? s.written.id;
    const nm = (e: ElementRecord): string => `\`${effectiveNameOf(model, e) ?? e.id}\``;
    // `subsetter` is the nearest usage that is read otherwise or is read with one (`root`: the one it started from; `redefined`:
    // the feature that one subsets, where that is what the instance reads otherwise).
    const by = nm(s.subsetter) + (s.root ? `, which is read together with ${nm(s.root)}` : '') + (s.redefined ? `, which subsets ${nm(s.redefined)}` : '');
    const held = s.redefined ? nm(s.redefined) : nm(s.root ?? s.subsetter);
    return (
      `\`${name}\` in ${where} is subsetted by ${by}, which ${contextSpelling(model, s.instance) ?? (s.reader ? `an instance of ${effectiveQualifiedName(model, s.reader.id)}` : who)} reads otherwise: this tool ` +
      `reads \`${name}\` at ${where}'s own values, never as the ${held} that instance holds${so(`no relation that reads through \`${name}\` or ${nm(s.subsetter)}`)}`
    );
  }
  if (s.kind === 'subsetting') {
    const name = effectiveNameOf(model, s.written) ?? s.written.id;
    const at = s.written.ownerId != null ? effectiveQualifiedName(model, s.written.ownerId) : where;
    return `\`${name}\` in ${at} subsets \`${s.path}\`, which ${contextSpelling(model, s.instance) ?? who} reads otherwise: ${subsettingRead(model, s)}${so('no relation that reads through it')}`;
  }
  const tail = `is read at ${where}'s own values only, never in each instance of it, and ${who} reads`;
  // A satisfier or a subject read through such a subsetting usage says which ({@link subsettingTaint}); resolved in
  // a package, one instance, it is read otherwise through that usage alone.
  const nmv = (e: ElementRecord): string => `\`${effectiveNameOf(model, e) ?? e.id}\``;
  const through = s.via?.subsetter
    ? `through ${nmv(s.via.written)}, which ${nmv(s.via.subsetter)} subsets: ` +
      `this tool reads ${nmv(s.via.written)} at ${effectiveQualifiedName(model, s.via.scope.id)}'s own values, never as the ${nmv(s.via.redefined ?? s.via.root ?? s.via.subsetter)} that ${contextSpelling(model, s.via.instance) ?? 'instance'} holds`
    : s.via ? `through \`${effectiveNameOf(model, s.via.written) ?? s.via.written.id}\`, which subsets \`${s.via.path}\`: ${subsettingRead(model, s.via)}` : '';
  const inPackage = s.via !== undefined && isPackage(s.scope);
  const via = through && !inPackage ? `, ${through}` : '';
  if (s.kind === 'reference') {
    const name = effectiveNameOf(model, s.written) ?? s.written.id;
    const at = effectiveQualifiedName(model, s.written.ownerId!);
    return `\`${name} = ${s.path}\` in ${at} names a feature of ${where}, which ${tail} it otherwise${so('no relation that reads through it')}`;
  }
  if (s.kind === 'satisfy') {
    const requirement = s.written.target?.[0] !== undefined ? model.get(s.written.target[0]) : undefined;
    const req = requirement ? (effectiveNameOf(model, requirement) ?? effectiveQualifiedName(model, requirement.id)) : '…';
    if (s.outside) {
      const at = s.written.ownerId != null ? effectiveQualifiedName(model, s.written.ownerId) : where;
      return (
        `\`satisfy ${req} by ${s.path || '…'}\` in ${at} names a feature of ${where} from outside it: this tool reads that path ` +
        `as ${where}'s own feature, never as the instance it names, and ${who} reads its satisfier otherwise${so('no relation it requires of the satisfier')}`
      );
    }
    const head = `\`satisfy ${req} by ${s.path || '…'}\` in ${where}`;
    if (inPackage) return `${head} reads its satisfier ${through}${so('no relation it requires of the satisfier')}`;
    return `${head} ${tail} its satisfier otherwise${via}${so('no relation it requires of the satisfier')}`;
  }
  const subject = effectiveFeatures(model, s.written.id).find((f) => f.attrs.requirementRole === 'subject');
  const spelled = subject ? `\`subject ${effectiveNameOf(model, subject) ?? subject.id} = ${s.path || '…'}\`` : 'its subject';
  const head = `${spelled} in ${effectiveQualifiedName(model, s.written.id)}`;
  if (inPackage) return `${head} reads what it names ${through}${so('no relation it requires of the subject')}`;
  return `${head} ${tail} what it names otherwise${via}${so('no relation it requires of the subject')}`;
}

/**
 * How this tool reads a usage that subsets a feature an instance reads
 * otherwise ({@link DefiningEquations.subsettingOtherwise}), for {@link
 * satisfierSentence}: through the subsetted feature as the element it is a
 * feature of has it (`s.scope`: W's own p1, Q's own p1 for `p2 :> q.p1`),
 * never as one of what that feature is in the instance that reads it
 * otherwise. The usage is named in its own owner by the sentence's head:
 * W for W's p2, w for a `part p3 :> p1;` w writes.
 */
function subsettingRead(model: Model, s: ReadOtherwise): string {
  const name = effectiveNameOf(model, s.written) ?? s.written.id;
  const where = effectiveQualifiedName(model, s.scope.id);
  return `this tool reads \`${name}\` through ${where}'s own \`${s.path}\`, never as one of what \`${s.path}\` is in ${contextSpelling(model, s.instance) ?? 'that instance'}`;
}

/**
 * A context as a sentence names it: a `satisfy` as written (`satisfy R by p50` in its owner) — its qualified name
 * is the relationship's `«Satisfy»` — any other element by its qualified name; `undefined` for none.
 */
function contextSpelling(model: Model, el: ElementRecord | undefined): string | undefined {
  if (!el) return undefined;
  if (el.eClass !== 'Satisfy') return effectiveQualifiedName(model, el.id);
  const requirement = el.target?.[0] !== undefined ? model.get(el.target[0]) : undefined;
  const satisfier = el.source?.[0] !== undefined ? model.get(el.source[0]) : undefined;
  const chain = el.attrs.sourceChain ?? el.attrs.sourceRef;
  const by = typeof chain === 'string' ? chain.trim() : satisfier ? (effectiveNameOf(model, satisfier) ?? satisfier.id) : '…';
  const req = requirement ? (effectiveNameOf(model, requirement) ?? effectiveQualifiedName(model, requirement.id)) : '…';
  return `\`satisfy ${req} by ${by}\`${el.ownerId != null ? ` in ${effectiveQualifiedName(model, el.ownerId)}` : ''}`;
}

/** What the unread binding, value or satisfaction `b` ({@link equatedParts}) is, and why this tool does not read through it. */
function equatedSentence(model: Model, b: ElementRecord): string {
  const held = isAsserted(b) ? enclosingAsserts(model).unreadAsserts.get(b.id) : undefined;
  if (held) return held.why;
  if (b.eClass === 'Satisfy') {
    const requirement = b.target?.[0] !== undefined ? model.get(b.target[0]) : undefined;
    const satisfier = b.source?.[0] !== undefined ? model.get(b.source[0]) : undefined;
    const chain = b.attrs.sourceChain ?? b.attrs.sourceRef;
    const by = typeof chain === 'string' ? chain.trim() : satisfier ? (effectiveNameOf(model, satisfier) ?? satisfier.id) : '…';
    const req = requirement ? (effectiveNameOf(model, requirement) ?? effectiveQualifiedName(model, requirement.id)) : '…';
    return (
      `\`satisfy ${req} by ${by}\` in ${effectiveQualifiedName(model, b.ownerId!)} names its satisfier through a feature ` +
      'that stands for another (a reference, a subject, or a part a binding or a value equates with its partner); ' +
      'this tool reads a satisfaction written in a definition, or in a usage another specialises, at its own values ' +
      'only, never in each instance of it, and an instance can make that feature stand for another'
    );
  }
  if (b.attrs.requirementRole === 'subject') {
    const requirement = b.ownerId != null ? model.get(b.ownerId) : undefined;
    return (
      `\`subject ${effectiveNameOf(model, b) ?? b.id} = ${String(b.attrs.value).trim()}\` in ` +
      `${requirement ? effectiveQualifiedName(model, requirement.id) : '…'} names the subject through a feature that stands for ` +
      'another (a reference, a subject, or a part a binding or a value equates with its partner); this tool reads a ' +
      'requirement written in a definition, or in a usage another specialises, at its own values only, never in each ' +
      'instance of it, and an instance can make that feature stand for another'
    );
  }
  const sibling = ownSiblingRedefinitions(model).find(([f]) => f.id === b.id);
  if (sibling) {
    const [f, g] = sibling;
    const name = effectiveNameOf(model, g) ?? g.id;
    return (
      `\`${f.declaredName ? `${f.declaredName} ` : ''}:>> ${name}\` in ${effectiveQualifiedName(model, f.ownerId!)} redefines \`${name}\`, a feature ` +
      `${model.get(f.ownerId!)?.declaredName ?? 'its owner'} declares itself (a feature redefines only one its owner inherits, ` +
      '`validation/redefinition-own-sibling`): the model states the feature twice, and this tool reads neither as ' +
      "the other's value"
    );
  }
  const contradicted = b.attrs.isRef === true ? contradictedBindingOf(model, b) : undefined;
  if (contradicted) {
    const owner = contradicted.binding.ownerId != null ? model.get(contradicted.binding.ownerId) : undefined;
    return (
      `\`${effectiveNameOf(model, b) ?? b.id} = ${String(b.attrs.value).trim()}\` in ${effectiveQualifiedName(model, b.ownerId!)} ` +
      `redefines ${writtenName(model, contradicted.binding)} = ${writtenValue(contradicted.binding)}, a reference every ` +
      `${owner?.declaredName ?? owner?.declaredShortName ?? 'instance of its owner'} holds (a value written with \`=\`, not a ` +
      '`default`): the model states both, and this tool reads a reference through neither'
    );
  }
  if (!isBindingConnector(b)) {
    return (
      `\`${effectiveNameOf(model, b) ?? b.id} = ${String(b.attrs.value).trim()}\` in ${effectiveQualifiedName(model, b.ownerId!)} ` +
      'values a part, port, item or structured attribute with another, which equates the two as a binding does; this ' +
      'tool reads through such a value only where the feature says nothing else of its own and its value is a path, ' +
      'below where it is written, to one as plain, and that is not so here'
    );
  }
  const [l, r] = [b.source?.[0], b.target?.[0]].map((id) => (id !== undefined ? bindingEndPath(model, id, b.ownerId!) : undefined));
  const ends = l !== undefined && r !== undefined ? `\`bind ${l} = ${r}\`` : 'a binding';
  return (
    `${ends} in ${effectiveQualifiedName(model, b.ownerId!)} equates two parts, ports, items or structured attributes; ` +
    'this tool reads such a binding only where one says nothing of its own and is bound once, as the other, and ' +
    'neither is here'
  );
}

/* ───── Two asserted equations that give one feature with no value two values (the soft/hard analysis, Q5) ───── */

/**
 * A feature with no value that two or more asserted equations each define where they meet, two of them with
 * constant sides that differ ({@link contradictedDefinitions}).
 */
export interface ContradictedDefinition {
  /** The element every instance of which each equation holds of: where they meet. */
  context: ElementRecord;
  /** The name they define there, as written from it: `L`, or `p.L` in an element around p. */
  path: string;
  /** The feature that name denotes there. */
  feature: ElementRecord;
  /** Every asserted equation that defines it there, in the model's order. */
  equations: readonly ElementRecord[];
  /** `differs`: two constant sides differ, or two Boolean ones; `undecided`: two this tool cannot compare. */
  verdict: 'differs' | 'undecided';
  /**
   * Why two cannot be compared, where `undecided`: `unit`, one number is written with a unit and the other
   * without; `names`, one side reads other names that may give it a value; `form`, one side reads no name but is
   * not a number over `+ - * /` and `[unit]` literals (`2.0 ^ 3`, `10 % 3`), or a Boolean beside a number.
   */
  why?: 'unit' | 'names' | 'form';
  /** The features no reading of which is decided: that feature, and the one each equation names where it is written. */
  features: readonly ElementRecord[];
  /**
   * Where equations of features a `bind` joins to `feature` are among `equations` (`bind L = K` beside `L == 50.0`
   * and `K == 60.0`): the joined name and the binding, as a sentence names them (``to `K` by `bind L = K` ``). The
   * binding states the two features are one value, so the equations define one feature twice.
   */
  joined?: readonly string[];
  /**
   * Where each equation's defining side is read, in the order of `equations`: the element its names are read in,
   * the name it defines as written from there, and the feature that name denotes there. An `undecided` set is
   * read there by the check's own evaluator (`definitionConflicts` of ./evaluate-model).
   */
  sites: ReadonlyArray<{ equation: DefiningEquation; at: ElementId; name: string; feature: ElementRecord }>;
}

/** {@link contradictedDefinitions}' entry, once per revision. */
interface ContradictedDefinitions {
  rev: number;
  sets: readonly ContradictedDefinition[];
  /** Each equation of a set by its id: the set a row it reaches is refused for. */
  bySource: ReadonlyMap<ElementId, ContradictedDefinition>;
  /** {@link contradictedTaint}, built on first ask. */
  taint?: ReadonlyMap<ElementId, ElementRecord>;
  /** {@link contradictedTaint} of each set alone, built on first ask ({@link contradictedSideReadsAnother}). */
  taintOf?: Map<ContradictedDefinition, ReadonlyMap<ElementId, ElementRecord>>;
  /** Set where listing them threw (A.2.9): the sentence every row that reads a name abstains in. */
  failed?: string;
}

const CONTRADICTED_DEFINITIONS = new WeakMap<Model, ContradictedDefinitions>();

/**
 * The features with no value that two asserted equations give two values, once per revision (the soft/hard
 * defaults analysis, Q5, decided 2026-10-22). Every evaluator takes the FIRST of a name's defining equations that
 * gives a value ({@link chooseDefinition}) — the element's own before one it inherits or one an element around it
 * writes ({@link DefiningEquations.definitionReadIn}, {@link DefiningEquations.reachingAssert}) — and judges the
 * others against it: `L == 50.0` and `L == 60.0` in P read `t50 { p.L == 50.0 }` true, with the literal engine's
 * exit 0, and swapped false, with exit 1 (M8); one in P and one in `part p : P { … }` read both true, `check`
 * silent (F1). An asserted equation is a fact of every instance it holds of, so such a model states both values
 * and contradicts itself, whichever is written first: no reading of the feature is decided on any surface that
 * reads values ({@link contradictedDefinitionRefusal}), the SMT engine finds its axioms inconsistent, and the check
 * reports the equations where they meet (`definitionConflicts` of ./evaluate-model).
 *
 * Where they meet: each element X — a definition, a usage, a package — and each name N an asserted equation
 * defines in X or in an element X specialises ({@link generalizationsOf}: its types and supertypes, what it
 * redefines or subsets), with every equation of theirs that defines N, and, for a dotted N (`p.L` in K), every
 * equation of the usage each prefix names, and of what that usage specialises, that defines the rest (`L` in p's
 * own body and in P). So is an equation written in an element nested in one of them whose name that element does
 * not answer and KerML resolves to the feature it names there (`L == 60.0` in `part p : R { … }` written in Q,
 * which declares L; one in a package nested in the one that declares L). Each must name the feature N denotes in
 * X, or one that shares with it a feature they override ({@link overriddenBy}): one it redefines, one it masks by
 * name, or the one two redefinitions X inherits together redefine. That feature must state no value and write no
 * `default`: one that does is checked against, whatever its equations, and `=` reads alike in any order. A set
 * met in X and again in an element that specialises X is X's alone.
 *
 * Compared, exactly ({@link exactConstant}): each defining side is read as a number over `+ - * /` and `[unit]`
 * literals, or a Boolean, its names read where it is read — a value written, or what the asserted equations that
 * define a name with none give, while they agree — and two that differ make the set `differs` (`L == a * 2.0`
 * with a = 30 beside `L == 50.0`). Else two this tool cannot compare make it `undecided`, unless their sides are
 * the same expression ({@link sameBody}): a number written with a unit beside one without, a side that reads no
 * name in another form (`2.0 ^ 3`, `10 % 3`), and a side over names it does not read exactly (one a binding
 * joins, one read around the element, one defined where it is not read), which may give L a value the other
 * does not. A side that gives no value — it reads a name nothing gives one, or reads back the feature it
 * defines, as an alias's `b == a` read as a's definition does — is left out: every evaluator tries another
 * first, in either order.
 *
 * Two equations on the two ends of one binding are the same pair: `bind L = K` in P says L and K are one value in
 * every P, so `L == 50.0` and `K == 60.0` define it twice (wave 3 contradictory-models S3). The equations of every
 * name the bindings that hold in X — written in it or in what it specialises — join N to, through one another too
 * (`bind L = M; bind M = K`), are gathered with N's, each name a feature of X or, through a part, of an instance of its type
 * (`bind p.L = M` beside `L == 50.0` in P and `M == 60.0` in X: P's L is then undecided in every P, the fence's price
 * of reading the pair where the binding meets it), each hop one the binding really joins there ({@link joinedTo}) — a
 * chain across a specialisation (`bind K = L` in P, `bind N = K` in P2) too. They count
 * only where the comparison decides two of them differ: a side over another name, a unit or a form this tool cannot
 * compare leaves the binding's own row to report the pair, as before. The set is named by the feature declared
 * first, whichever equation is written first, and its `joined` says which binding joins the others.
 */
export function contradictedDefinitions(model: Model): ContradictedDefinitions {
  const hit = CONTRADICTED_DEFINITIONS.get(model);
  if (hit && hit.rev === model.rev) return hit;
  let fresh: ContradictedDefinitions;
  try {
    fresh = instanceIndexSeam.contradictedDefinitions(model);
  } catch (e) {
    fresh = {
      rev: model.rev,
      sets: [],
      bySource: new Map(),
      failed:
        'the asserted equations that give one feature with no value two values could not be listed: the reading ' +
        `failed (${e instanceof Error ? e.constructor.name : 'error'}); reported, not dropped`,
    };
  }
  CONTRADICTED_DEFINITIONS.set(model, fresh);
  return fresh;
}

/** {@link contradictedDefinitions}, worked out — uncontained, and reached only through {@link instanceIndexSeam}. */
function contradictedDefinitionsUncached(model: Model): ContradictedDefinitions {
  const empty: ContradictedDefinitions = { rev: model.rev, sets: [], bySource: new Map() };
  // Each owner of an asserted equation, with its equations by the name each defines: the index every evaluator
  // reads (`equationsByName`), so a name whose feature writes a `default` is none of them.
  const byOwner = new Map<ElementId, Map<string, DefiningEquation[]>>();
  let count = 0;
  for (const c of model.all()) {
    if (c.attrs.isLibrary === true || c.ownerId == null || byOwner.has(c.ownerId) || !isAsserted(c)) continue;
    const index = equationsByName(model, c.ownerId);
    byOwner.set(c.ownerId, index);
    for (const list of index.values()) count += list.length;
  }
  if (count < 2) return empty;
  const namedMemo = new Map<string, ElementRecord | undefined>();
  const named = (at: ElementId, name: string): ElementRecord | undefined => {
    const key = `${at} ${name}`;
    if (!namedMemo.has(key)) namedMemo.set(key, featureNamedBelow(model, at, name));
    return namedMemo.get(key);
  };
  const generalMemo = new Map<ElementId, ElementRecord[]>();
  const generalOf = (id: ElementId): ElementRecord[] => {
    let hit = generalMemo.get(id);
    if (!hit) generalMemo.set(id, (hit = generalizationsOf(model, id)));
    return hit;
  };
  // Each equation whose name its owner does not answer but an element around it declares, under that element by
  // the name as it reads there, with the feature it names: as KerML resolves it, unless an import or an alias
  // answers it first.
  const lexical = new Map<ElementId, Map<string, Array<{ eq: DefiningEquation; named: ElementRecord }>>>();
  for (const [ownerId, index] of byOwner) {
    for (const [name, list] of index) {
      if (named(ownerId, name)) continue;
      const head = name.split('.')[0]!;
      const seen = new Set<ElementId>([ownerId]);
      for (let id = model.get(ownerId)?.ownerId ?? null; id != null && !seen.has(id); id = model.get(id)?.ownerId ?? null) {
        seen.add(id);
        if (model.get(id)?.attrs.isLibrary === true) break;
        const declared = named(id, head);
        if (!declared) continue;
        const f = named(id, name);
        const resolved = resolveFullName(model, head, ownerId);
        if (f && (!resolved || resolved.id === declared.id)) {
          const into = lexical.get(id) ?? new Map<string, Array<{ eq: DefiningEquation; named: ElementRecord }>>();
          lexical.set(id, into);
          into.set(name, [...(into.get(name) ?? []), ...list.map((eq) => ({ eq, named: f }))]);
        }
        break;
      }
    }
  }
  const statesValue = (f: ElementRecord): boolean => statesOwnValue(model, f);
  const slots = new Map<ElementId, ReadonlySet<ElementId>>();
  const slotOf = (f: ElementRecord): ReadonlySet<ElementId> => {
    let hit = slots.get(f.id);
    if (!hit) slots.set(f.id, (hit = new Set([f.id, ...overriddenBy(model, f).map((g) => g.id)])));
    return hit;
  };
  const sameSlot = (f: ElementRecord, g: ElementRecord): boolean => {
    const mine = slotOf(f);
    return [...slotOf(g)].some((id) => mine.has(id));
  };
  /**
   * The asserted equations that define `path` read in X (`feature`, there), each with the element the names its
   * defining side reads are read in: X's own and those of what it specialises, read in X; for a dotted path, those
   * of the usage each prefix names and of what that usage specialises, read in that usage; and one written in an
   * element nested in one of them whose name resolves to the feature there, read where it is written. Each must
   * name `feature`, or a feature that shares with it one they override ({@link overriddenBy}).
   */
  type Gathered = { eq: DefiningEquation; named: ElementRecord; at: ElementId; name: string; readAs: ElementRecord };
  const gather = (x: ElementRecord, path: string, feature: ElementRecord): Gathered[] => {
    const out: Gathered[] = [];
    const push = (eq: DefiningEquation, f: ElementRecord | undefined, at: ElementId, name: string): void => {
      if (out.some((c) => c.eq.constraint.id === eq.constraint.id)) return;
      if (f && sameSlot(feature, f)) out.push({ eq, named: f, at, name, readAs: named(at, name) ?? f });
    };
    const take = (owner: ElementRecord, name: string, at: ElementId): void => {
      for (const eq of byOwner.get(owner.id)?.get(name) ?? []) push(eq, named(owner.id, name), at, name);
      for (const l of lexical.get(owner.id)?.get(name) ?? []) push(l.eq, l.named, l.eq.constraint.ownerId!, name);
    };
    for (const y of [x, ...generalOf(x.id)]) take(y, path, x.id);
    const segments = path.split('.');
    for (let k = 1; k < segments.length; k++) {
      const u = named(x.id, segments.slice(0, k).join('.'));
      if (!u) break;
      const rest = segments.slice(k).join('.');
      for (const y of [u, ...generalOf(u.id)]) take(y, rest, u.id);
    }
    return out;
  };
  // Every asserted equation by each feature it may define (the one its name names where it is written, and every
  // one that feature overrides): what may give a name read beside it a value.
  const definers = new Map<ElementId, Set<ElementId>>();
  const defines = (f: ElementRecord, c: ElementRecord): void => {
    for (const id of slotOf(f)) definers.set(id, (definers.get(id) ?? new Set<ElementId>()).add(c.id));
  };
  for (const [ownerId, index] of byOwner) {
    for (const [name, list] of index) {
      const f = named(ownerId, name);
      if (f) for (const eq of list) defines(f, eq.constraint);
    }
  }
  for (const into of lexical.values()) for (const list of into.values()) for (const l of list) defines(l.named, l.eq.constraint);
  const definersOf = (g: ElementRecord): ReadonlySet<ElementId> => {
    const out = new Set<ElementId>();
    for (const id of slotOf(g)) for (const c of definers.get(id) ?? []) out.add(c);
    return out;
  };
  const bound = (g: ElementRecord): boolean => [g, ...redefinedClosure(model, g)].some((h) => joinedTo(model, h.id).size > 1);
  // The user's bindings by the element each holds in, with its ends as that element spells them: `bind L = K` in P
  // says L and K are one value in every P, so the equations of either define both.
  const joins = new Map<ElementId, Array<{ left: string; right: string; text: string }>>();
  for (const b of bindingEnds(model).connectors) {
    const read = bindingHolder(model, b);
    if (!read || read.left === undefined || read.right === undefined || read.left === read.right) continue;
    const list = joins.get(read.holder.id) ?? [];
    list.push({ left: read.left, right: read.right, text: `bind ${read.left} = ${read.right}` });
    joins.set(read.holder.id, list);
  }
  /** Does a binding join `a` (or what it redefines) to `b` (or what it redefines)? */
  const joinedAmong = (a: ElementRecord, b: ElementRecord): boolean => {
    const ids = new Set([b, ...redefinedClosure(model, b)].map((h) => h.id));
    return [a, ...redefinedClosure(model, a)].some((h) => [...joinedTo(model, h.id)].some((id) => ids.has(id)));
  };
  /** Words for a list: `a`, `a and b`, `a, b and c`. */
  const listed = (items: readonly string[]): string =>
    items.length <= 2 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]!}`;
  /**
   * The ends of the bindings that hold in every `x` — those written in `x` or in what it specialises
   * ({@link generalizationsOf}) — crossed from `path` outward, through one another too (`bind L = M; bind M = K;`):
   * each as the name it is crossed from, the name it reaches, and the binding. A name reached by two bindings is
   * listed by both. A name through a part (`p.L`) is a feature of every instance of that part's type, so a
   * contradiction read here leaves it undecided wherever it is read (fence-readings S2: a pair read there is a pair of
   * the one feature, whichever end is dotted, and abstains).
   */
  type Crossing = { from: string; path: string; text: string };
  const crossings = (holders: readonly ElementRecord[], path: string): Crossing[] => {
    const out: Crossing[] = [];
    if (!holders.some((h) => joins.has(h.id))) return out;
    const seen = new Set([path]);
    for (const queue = [path]; queue.length > 0; ) {
      const at = queue.shift()!;
      for (const h of holders) {
        for (const j of joins.get(h.id) ?? []) {
          const other = j.left === at ? j.right : j.right === at ? j.left : undefined;
          if (other === undefined) continue;
          out.push({ from: at, path: other, text: j.text });
          if (!seen.has(other)) {
            seen.add(other);
            queue.push(other);
          }
        }
      }
    }
    return out;
  };
  /**
   * An exact reading of a defining side, or why there is none: `free`, it gives no value — it reads a name with
   * none that nothing gives one, or one whose every definition reads back a feature in flight (the one it defines
   * among them), which every evaluator passes over, or one nested past the depth every evaluator refuses a
   * derivation at; `opaque`, it may give one this tool does not read exactly — a name bound, read around the
   * element, defined where it is not read, or past the work this reading is allowed. A name with a value written
   * reads that value; one without reads what its asserted equations give where it is read, when every one that
   * may give it one is among them and those that give one agree.
   */
  type Exact = { k: Constant } | { bool: boolean } | 'free' | 'opaque';
  let budget = 0;
  const sameExact = (a: Exact, b: Exact): boolean =>
    typeof a === 'object' && typeof b === 'object'
      ? 'k' in a && 'k' in b
        ? compareConstants(a.k, b.k) === 'same'
        : 'bool' in a && 'bool' in b && a.bool === b.bool
      : false;
  const exactName = (at: ElementId, n: string, flight: ReadonlySet<ElementId>, depth: number): Exact => {
    // Past the depth every evaluator refuses a derivation at, a side gives no value on any surface.
    if (depth > MAX_DERIVATION_DEPTH) return 'free';
    if (--budget < 0) return 'opaque';
    const g = named(at, n);
    if (!g) return 'opaque';
    if (flight.has(g.id)) return 'free';
    if (bound(g)) return 'opaque';
    const inner = new Set(flight);
    for (const id of slotOf(g)) inner.add(id);
    if (statesValue(g)) {
      const v = statedValueOf(model, g);
      if (typeof v === 'boolean') return { bool: v };
      if (typeof v === 'number') {
        const k = constantOf(g);
        return k ? { k } : 'opaque';
      }
      if (typeof v !== 'string' || isQuoted(v.trim()) || g.ownerId == null) return 'opaque';
      const body = parseRelationBody(v.trim());
      if (!body || (body.hadUnit && !body.resolved)) return 'opaque';
      return exactSide(body.node, body.literals, g.ownerId, inner, depth + 1);
    }
    const sides = gather(model.get(at)!, n, g);
    const considered = new Set(sides.map((s) => s.eq.constraint.id));
    if ([...definersOf(g)].some((id) => !considered.has(id))) return 'opaque';
    let out: Exact = 'free';
    for (const s of sides) {
      const r = exactSide(s.eq.definition, s.eq.literals, s.at, inner, depth + 1);
      if (r === 'free') continue;
      if (r === 'opaque') return 'opaque';
      if (out === 'free') out = r;
      else if (!sameExact(out, r)) return 'opaque';
    }
    return out;
  };
  /** Does `n`, read in `at`, name a feature with no value, no binding, and no asserted equation that defines it? */
  const plainlyFree = (at: ElementId, n: string): boolean => {
    const g = named(at, n);
    return g !== undefined && !statesValue(g) && !bound(g) && definersOf(g).size === 0;
  };
  const exactSide = (node: ExprNode, literals: MarkerDimensions, at: ElementId, flight: ReadonlySet<ElementId>, depth: number): Exact => {
    const names = [...new Set(refsIn(node, literals))];
    if (names.length === 0) {
      const k = exactConstant(node, literals);
      return k ? { k } : node.kind === 'bool' ? { bool: node.value } : 'opaque';
    }
    // A name nothing gives a value first: such a side gives none, whatever its other names give.
    if (names.some((n) => plainlyFree(at, n))) return 'free';
    const read = names.map((n) => [n, exactName(at, n, flight, depth)] as const);
    if (read.some(([, r]) => r === 'free')) return 'free';
    if (read.some(([, r]) => r === 'opaque')) return 'opaque';
    if (node.kind === 'ref' && read.length === 1) return read[0]![1];
    const env = new Map<string, Constant>();
    for (const [n, r] of read) {
      if (typeof r !== 'object' || !('k' in r)) return 'opaque';
      env.set(n, r.k);
    }
    const k = exactConstant(node, literals, env);
    return k ? { k } : 'opaque';
  };
  type Side = { kind: 'constant'; k: Constant } | { kind: 'bool'; value: boolean } | { kind: 'other'; why: 'names' | 'form' };
  const sideOf = (eq: DefiningEquation, at: ElementId, flight: ReadonlySet<ElementId>): Side | undefined => {
    budget = 4096;
    const r = exactSide(eq.definition, eq.literals, at, flight, 0);
    if (r === 'free') return undefined;
    if (r === 'opaque') return { kind: 'other', why: refsIn(eq.definition, eq.literals).length > 0 ? 'names' : 'form' };
    return 'k' in r ? { kind: 'constant', k: r.k } : { kind: 'bool', value: r.bool };
  };
  const compare = (
    a: { eq: DefiningEquation; side: Side },
    b: { eq: DefiningEquation; side: Side },
  ): { v: WrittenComparison; why?: ContradictedDefinition['why'] } => {
    if (a.side.kind === 'constant' && b.side.kind === 'constant') {
      const v = compareConstants(a.side.k, b.side.k);
      return v === 'undecided' ? { v, why: 'unit' } : { v };
    }
    if (a.side.kind === 'bool' && b.side.kind === 'bool') return { v: a.side.value === b.side.value ? 'same' : 'differs' };
    if (sameBody(a.eq.definition, a.eq.literals, b.eq.definition, b.eq.literals)) return { v: 'same' };
    const why = a.side.kind === 'other' && a.side.why === 'names' ? 'names' : b.side.kind === 'other' ? b.side.why : 'form';
    return { v: 'undecided', why };
  };
  const order = new Map<ElementId, number>();
  model.all().forEach((e, i) => order.set(e.id, i));
  // Where equations may meet: each owner, each element around an equation that declares the name it defines,
  // and every element that specialises one ({@link generalizationsOf} read backwards, once), in the model's order.
  const specific = new Map<ElementId, ElementId[]>();
  for (const r of model.all()) {
    if (!isTypingSpecialization(r.eClass)) continue;
    for (const g of r.target ?? []) {
      const list = specific.get(g) ?? [];
      list.push(...(r.source ?? []));
      specific.set(g, list);
    }
  }
  const anchors = new Set<ElementId>();
  for (const queue = [...byOwner.keys(), ...lexical.keys()]; queue.length > 0; ) {
    const id = queue.pop()!;
    if (anchors.has(id)) continue;
    anchors.add(id);
    queue.push(...(specific.get(id) ?? []));
  }
  const holds = (y: ElementRecord): boolean => byOwner.has(y.id) || lexical.has(y.id);
  const countOf = (y: ElementRecord, path: string): number =>
    (byOwner.get(y.id)?.get(path)?.length ?? 0) + (lexical.get(y.id)?.get(path)?.length ?? 0);
  // The sets found, by the equations each holds: met again in an element that specialises the one it was met in,
  // a set is that element's; met in two unrelated elements, it is each one's.
  const found = new Map<string, Array<{ set: ContradictedDefinition; general: ReadonlySet<ElementId> }>>();
  for (const x of model.all()) {
    if (x.attrs.isLibrary === true || !anchors.has(x.id)) continue;
    if (!holds(x) && !isUsage(x.eClass) && !isDefinition(x.eClass)) continue;
    const general = generalizationsOf(model, x.id);
    const owners = [x, ...general].filter(holds);
    if (owners.length === 0) continue;
    const paths = owners.flatMap((y) => [...(byOwner.get(y.id)?.keys() ?? []), ...(lexical.get(y.id)?.keys() ?? [])]);
    const holders = [x, ...general];
    const joining = holders.some((h) => joins.has(h.id));
    for (const path of new Set(paths)) {
      // One equation of a bare name among the owners meets no other: only a dotted one reads more, below, and one a
      // binding joins to a name that has equations of its own.
      if (!path.includes('.') && !joining && owners.reduce((n, y) => n + countOf(y, path), 0) < 2) continue;
      const feature = featureNamedBelow(model, x.id, path);
      if (!feature || statesValue(feature)) continue;
      const own = gather(x, path, feature);
      // The equations of every name a binding joins it to, which the binding makes one value with it: `bind L = K`
      // beside `L == 50.0` and `K == 60.0`. Added only where they decide a contradiction (below), so that a pair
      // this tool reads otherwise — `L == K` beside `bind L = K`, which reads K back — is read as before.
      const partners: Array<{ eq: Gathered; via: readonly string[]; path: string }> = [];
      // Each hop is checked where it is crossed: the feature a name denotes in x must be the one the binding joins
      // (or one that redefines it) to the feature the name before it denotes there — an element that masks a name with
      // a feature of its own is joined to nothing here — and a chain goes on through a hop only once that hop holds
      // (`bind N = K` in P2 beside `bind K = L` in P, whose K P2's own K redefines). A name that states a value or
      // has no equation of its own is still crossed, giving no equation.
      const reach = new Map<string, { feature: ElementRecord; via: readonly string[] }>([[path, { feature, via: [] }]]);
      const crossed = crossings(holders, path);
      for (let grew = crossed.length > 0; grew; ) {
        grew = false;
        for (const j of crossed) {
          const from = reach.get(j.from);
          if (from === undefined || reach.has(j.path)) continue;
          const g = named(x.id, j.path);
          if (!g || !joinedAmong(from.feature, g)) continue;
          const via = [...from.via, j.text];
          reach.set(j.path, { feature: g, via });
          grew = true;
          if (statesValue(g)) continue;
          for (const eq of gather(x, j.path, g)) {
            if (!own.some((c) => c.eq.constraint.id === eq.eq.constraint.id) && !partners.some((c) => c.eq.eq.constraint.id === eq.eq.constraint.id)) {
              partners.push({ eq, via, path: j.path });
            }
          }
        }
      }
      if (own.length < 2 && partners.length === 0) continue;
      /** The verdict of `competing`'s sides compared pair by pair, or `undefined` where there is none to give. */
      const judge = (
        competing: readonly Gathered[],
      ): { verdict: ContradictedDefinition['verdict']; why?: ContradictedDefinition['why'] } | undefined => {
        // The feature, and every one it overrides, is in flight: a side that reads it back gives it no value.
        const flight = new Set(competing.flatMap((c) => [...slotOf(c.named)]));
        const sides = competing.flatMap((c) => {
          const side = sideOf(c.eq, c.at, flight);
          return side ? [{ eq: c.eq, side }] : [];
        });
        let verdict: ContradictedDefinition['verdict'] | undefined;
        let why: ContradictedDefinition['why'];
        for (let i = 0; i < sides.length && verdict !== 'differs'; i++) {
          for (let j = i + 1; j < sides.length; j++) {
            const c = compare(sides[i]!, sides[j]!);
            if (c.v === 'differs') {
              verdict = 'differs';
              why = undefined;
              break;
            }
            if (c.v === 'undecided' && verdict === undefined) {
              verdict = 'undecided';
              why = c.why;
            }
          }
        }
        return verdict === undefined ? undefined : { verdict, ...(why ? { why } : {}) };
      };
      let competing: readonly Gathered[] = own;
      let judged = own.length >= 2 ? judge(own) : undefined;
      let joined: string[] = [];
      if (partners.length > 0) {
        const all = [...own, ...partners.map((p) => p.eq)];
        const together = judge(all);
        if (together?.verdict === 'differs') {
          competing = all;
          judged = together;
          joined = [...new Set(partners.map((p) => `to \`${p.path}\` by ${listed(p.via.map((t) => `\`${t}\``))}`))];
        }
      }
      if (judged === undefined || competing.length < 2) continue;
      const { verdict, why } = judged;
      const ordered = [...competing].sort((a, b) => order.get(a.eq.constraint.id)! - order.get(b.eq.constraint.id)!);
      const equations = ordered.map((c) => c.eq.constraint);
      const sites = ordered.map((c) => ({ equation: c.eq, at: c.at, name: c.name, feature: c.readAs }));
      const features = [...new Map([feature, ...competing.map((c) => c.named)].map((f) => [f.id, f])).values()];
      const key = equations.map((c) => c.id).join(' ');
      const met = found.get(key) ?? [];
      const mine = new Set(general.map((g) => g.id));
      // One it was met in already that X specialises keeps it; any it was met in that specialises X gives it up. One
      // met in X again, under another name a binding joins to the first (`L`, then `K`), is the same set, named by
      // the feature declared first — not the equation written first, whose order decides nothing.
      if (met.some((m) => mine.has(m.set.context.id))) continue;
      const again = met.find((m) => m.set.context.id === x.id);
      if (again !== undefined && order.get(again.set.feature.id)! <= order.get(feature.id)!) continue;
      const kept = met.filter((m) => m !== again && !m.general.has(x.id));
      kept.push({
        set: { context: x, path, feature, equations, verdict, ...(why ? { why } : {}), features, sites, ...(joined.length > 0 ? { joined } : {}) },
        general: mine,
      });
      found.set(key, kept);
    }
  }
  const sets = [...found.values()].flat().map((m) => m.set);
  if (sets.length === 0) return empty;
  sets.sort((a, b) => order.get(a.context.id)! - order.get(b.context.id)! || a.path.localeCompare(b.path));
  const bySource = new Map<ElementId, ContradictedDefinition>();
  for (const set of sets) for (const c of set.equations) if (!bySource.has(c.id)) bySource.set(c.id, set);
  return { rev: model.rev, sets, bySource };
}

/**
 * What a {@link ContradictedDefinition} decides nothing of, each with the first equation of its set: its
 * equations, its features, and from them, to the fixpoint {@link equatedTaint} reaches (a binding's other end, a
 * feature whose value reads one, what an asserted relation over one reads beside it, what redefines or subsets
 * one), every value tied to them — a binding's end alone, not the part that holds it (`bind k.K = p.L` leaves
 * k's own W read). Once per revision.
 */
function contradictedTaint(model: Model): ReadonlyMap<ElementId, ElementRecord> {
  const index = contradictedDefinitions(model);
  if (index.taint) return index.taint;
  if (index.sets.length === 0) return (index.taint = new Map());
  index.taint = instanceIndexSeam.spreadContradiction(model, index, index.sets);
  return index.taint;
}

/**
 * {@link contradictedTaint} from `sets` alone. A feature that states its own value is never tainted by the step that
 * carries the taint across a binding, nor by the one that carries it to a name an asserted relation reads beside a
 * tainted one ({@link statesOwnValue}): a value written with `=` (or a `default`) is read whatever its asserts and
 * bindings, and an assert over it alone — `M <= 10.0` beside `s { L >= 0.0 [kg] or M >= 0.0 }` — is still judged
 * at it, and reported violated. It is tainted where its value expression reads a tainted name.
 */
function spreadContradiction(
  model: Model,
  index: ContradictedDefinitions,
  sets: readonly ContradictedDefinition[],
): ReadonlyMap<ElementId, ElementRecord> {
  // An equation of a set taints the names it reads beside a tainted one only where it ties two features, a bare name
  // on each side: `K == L` beside `L == 50.0` and `L == 60.0` is a member of the set and still makes K the L it reads,
  // whichever of the two equations comes first (parentheses round a name change nothing: `(K) == (L)`). `L == a * 2.0`
  // defines L and ties a to nothing.
  const bareTie = /^\s*[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\s*==\s*[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\s*$/;
  const sources = new Set(
    index.sets.flatMap((s) => s.equations.filter((c) => !(typeof c.attrs.expression === 'string' && bareTie.test(c.attrs.expression.replace(/[()]/g, ' ')))).map((c) => c.id)),
  );
  return spreadTaint(
    model,
    sources,
    (add) => {
      for (const set of sets) {
        const first = set.equations[0]!;
        for (const c of set.equations) add(c, first);
        for (const f of set.features) add(f, first);
      }
    },
    false,
    (e) => isUsage(e.eClass) && statesOwnValue(model, e),
  );
}

/**
 * Does the defining side of `site`, one equation of `set`, read a value another set of the model leaves undecided
 * ({@link contradictedTaint} of every other set)? The check reads such a value as the first of ITS equations written
 * defines it, so a reading of `set` over it would turn on the order of the text: `definitionConflicts` of
 * ./evaluate-model does not read `set` apart over it. A throw reads as `true`.
 */
export function contradictedSideReadsAnother(model: Model, set: ContradictedDefinition, site: ContradictedDefinition['sites'][number]): boolean {
  const index = contradictedDefinitions(model);
  if (index.failed !== undefined) return true;
  const others = index.sets.filter((s) => s !== set);
  if (others.length === 0) return false;
  try {
    index.taintOf ??= new Map();
    const taints = others.map((o) => {
      let t = index.taintOf!.get(o);
      if (!t) index.taintOf!.set(o, (t = instanceIndexSeam.spreadContradiction(model, index, [o])));
      return t;
    });
    const roots = [site.at, site.equation.constraint.id];
    return refsIn(site.equation.definition, site.equation.literals).some((n) =>
      taints.some((t) => readsTainted(model, t, roots, n) !== undefined),
    );
  } catch {
    return true;
  }
}

/**
 * Is `featureId` a feature two asserted equations give two values, or one whose value is tied to one ({@link
 * contradictedTaint})? No value of it is printed (`modelBindings` of ./engines/literal): the evaluators still
 * derive the first equation written, which is no value the model states. True too where listing them, or this
 * reading, threw (A.2.9).
 */
export function readsContradictedDefinition(model: Model, featureId: ElementId): boolean {
  const index = contradictedDefinitions(model);
  if (index.failed !== undefined) return true;
  if (index.sets.length === 0) return false;
  try {
    return taintedAt(model, contradictedTaint(model), model.get(featureId)) !== undefined;
  } catch {
    return true;
  }
}

/**
 * Why a relation row of `model` is not read ({@link contradictedDefinitions}), or `undefined`: a name of
 * `expression` read in its context (`at.contextId`; for its own row, where the relation is written) reaches a
 * feature two asserted equations give two values, or a value tied to one ({@link contradictedTaint}), or the
 * row is one of those equations. Every surface that reads values leaves a decided row undecided in this sentence
 * (`checkConstraints` and `bindingConflicts` of ./evaluate-model, `numericRows` of ./solver); the obligations
 * lane encodes such a row as before, and the SMT engine, whose axioms hold both equations, finds them
 * inconsistent (`verification/inconsistent-axioms`), naming both in its core.
 */
export function contradictedDefinitionRefusal(
  model: Model,
  relationId: ElementId,
  expression: string,
  at?: { contextId: ElementId; path?: string },
): string | undefined {
  return contradictedDefinitionRefusalOf(model, relationId, expression, at)?.sentence;
}

/**
 * {@link contradictedDefinitionRefusal}, with the set it names and what that set is: `differs` where the model
 * states two values (an instance row's cause `two-values`), `undecided` where this tool cannot compare them
 * exactly, `failed` where listing them, or reading this row against them, threw (A.2.9: the row abstains as
 * `internal`, and nothing else is lost).
 */
export function contradictedDefinitionRefusalOf(
  model: Model,
  relationId: ElementId,
  expression: string,
  at?: { contextId: ElementId; path?: string },
): { sentence: string; verdict: ContradictedDefinition['verdict'] | 'failed'; set?: ContradictedDefinition } | undefined {
  const index = contradictedDefinitions(model);
  if (index.failed === undefined && index.sets.length === 0) return undefined;
  const names = relationNamesOf(expression);
  if (index.failed !== undefined) {
    return names.length > 0 ? { sentence: `${index.failed}, so no relation that may read one is read`, verdict: 'failed' } : undefined;
  }
  try {
    const taint = contradictedTaint(model);
    const rel = model.get(relationId);
    const context = at ? model.get(at.contextId) : rel;
    const roots = [at ? at.contextId : rel?.ownerId, relationId].filter((x): x is ElementId => x != null);
    let b = names.map((n) => readsTainted(model, taint, roots, n)).find((x) => x !== undefined);
    b ??= taintedAt(model, taint, context) ?? taintedAt(model, taint, rel);
    if (!b && at?.path !== undefined) {
      const frames = sharedDefinitions(model).framesAbove(at.path);
      b =
        frames === undefined
          ? index.sets[0]!.equations[0]
          : frames.map((fr) => taintedAt(model, taint, model.get(fr.reader))).find((x) => x !== undefined);
    }
    const set = b ? index.bySource.get(b.id) : undefined;
    return set ? { sentence: contradictedDefinitionSentence(model, set), verdict: set.verdict, set } : undefined;
  } catch (e) {
    // A.2.9: a reading that throws is this row's, reported — never a throw out of the sweep.
    return names.length > 0
      ? {
          sentence:
            'this relation could not be read against the asserted equations that give one feature with no value two ' +
            `values: the reading failed (${e instanceof Error ? e.constructor.name : 'error'}); reported, not dropped`,
          verdict: 'failed',
        }
      : undefined;
  }
}

/** The clause every sentence about `set` opens with: its equations, where they meet, and what they give. */
function contradictedDefinitionClause(model: Model, set: ContradictedDefinition): string {
  const what =
    set.verdict === 'differs'
      ? 'two different values'
      : set.why === 'names'
        ? 'two values this tool does not compare exactly (one reads other names)'
        : set.why === 'form'
          ? 'two values this tool cannot compare exactly (one is not a number over `+ - * /`)'
          : 'two values this tool cannot compare exactly (one is written with a unit, the other without)';
  return `${contradictedDefinitionNaming(model, set)}, which states no value, and give it ${what}`;
}

/**
 * `set`'s equations and where they meet, as every sentence about it names them: "the asserted `L == 50.0` (P::c1)
 * and `L == 60.0` (P::c2) each define `L` in P" (`contradictedDetail` of ./engines/literal too).
 */
export function contradictedDefinitionNaming(model: Model, set: ContradictedDefinition): string {
  const named = set.equations.map((c) => `\`${String(c.attrs.expression ?? '').trim()}\` (${effectiveQualifiedName(model, c.id)})`);
  const listed = named.length <= 2 ? named.join(' and ') : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]!}`;
  const joined = set.joined !== undefined && set.joined.length > 0 ? ` (joined ${set.joined.join(', ')})` : '';
  return `the asserted ${listed} each define \`${set.path}\`${joined} in ${effectiveQualifiedName(model, set.context.id)}`;
}

/** Why a row {@link contradictedDefinitionRefusal} refuses is not read: the feature, and the equations that give it two values. */
export function contradictedDefinitionSentence(model: Model, set: ContradictedDefinition): string {
  const name = effectiveNameOf(model, set.feature) ?? set.path;
  return set.verdict === 'differs'
    ? `${name} is not read: ${contradictedDefinitionClause(model, set)} — the model contradicts itself there, ` +
        'whichever is written first, and this tool reads neither value, so no relation that may read it is decided'
    : `${name} is not read: ${contradictedDefinitionClause(model, set)}, so this tool reads neither, and no ` +
        'relation that may read it is decided';
}

/**
 * The sentence of the check that reports `set` where its equations meet (`definitionConflicts` of
 * ./evaluate-model): what they give, why that is a contradiction, and what is left undecided. `apart`, for an
 * `undecided` set: what the check's own evaluator reads each defining side at, where two of those readings
 * differ — the model then states two values, as for `differs`.
 */
export function contradictedDefinitionConflict(model: Model, set: ContradictedDefinition, apart?: readonly string[]): string {
  const name = effectiveNameOf(model, set.feature) ?? set.path;
  const contradicts =
    ' — an asserted equation is a fact of every instance it holds of, so the model states both values and ' +
    `contradicts itself, whichever is written first; no relation that may read ${name} is decided`;
  if (set.verdict === 'differs') return `${contradictedDefinitionClause(model, set)}${contradicts}`;
  if (apart !== undefined) {
    return `${contradictedDefinitionClause(model, set)}, which differ at the model's values (${apart.join(', ')})${contradicts}`;
  }
  return `${contradictedDefinitionClause(model, set)}, so this tool reads neither, and no relation that may read ${name} is decided`;
}

/** The indexes over the model's binding readings ({@link BindingIndex}), built once per revision. */
function indexOf(model: Model): BindingIndex {
  const ends = bindingEnds(model);
  if (ends.index) return ends.index;
  const members = new Map<ElementId, Map<string, string[]>>();
  const roots = new Map<ElementId, Array<{ root: ElementId; path: string }>>();
  for (const [root, reading] of ends.readings) {
    const byComponent = new Map<string, string[]>();
    for (const [path, r] of reading) {
      const list = byComponent.get(r.component);
      if (list) list.push(path);
      else byComponent.set(r.component, [path]);
      const at = roots.get(r.feature);
      if (at) at.push({ root, path });
      else roots.set(r.feature, [{ root, path }]);
    }
    members.set(root, byComponent);
  }
  ends.index = { members, roots, marks: new Map(), uniform: new Map() };
  return ends.index;
}

/**
 * How the member at `path` of the binding reading of context `root` is read
 * there: its feature id, with `@` and what its value reads there
 * ({@link readSignature}) where it is read in another context than where it
 * is written ({@link readsOtherwise}) — once per member.
 */
function markOf(model: Model, root: ElementId, path: string): string | undefined {
  const r = bindingEnds(model).readings.get(root)?.get(path);
  if (!r) return undefined;
  const { marks } = indexOf(model);
  let byPath = marks.get(root);
  if (!byPath) {
    byPath = new Map();
    marks.set(root, byPath);
  }
  let mark = byPath.get(path);
  if (mark === undefined) {
    const f = model.get(r.feature);
    const at = f ? readsOtherwise(model, root, path, f) : undefined;
    mark = at === undefined || !f ? r.feature : `${r.feature}@${readSignature(model, at, f)}`;
    byPath.set(path, mark);
  }
  return mark;
}

/**
 * What makes the value of `f`, read in the context `at` ({@link
 * readsOtherwise}), the one it is there: the features it reads, as `at`
 * resolves them ({@link DefiningEquations.dependencies}). A usage that
 * changes nothing the value reads — each of a thousand `part qi : Q2;` — reads
 * it as Q2 does and signs it alike, so {@link
 * DefiningEquations.changingContexts} lists one of them, as it lists one for a
 * value it reads directly; q's `:>> K = 25.0` and q2's `:>> K = 0.1` sign it
 * apart. Where the value reads a binding's end, what that end reads is no
 * feature `at` resolves (`L = 2.0 * K` with `bind K = J`): the context itself
 * signs it.
 */
function readSignature(model: Model, at: ElementId, f: ElementRecord): string {
  const deps = sharedDefinitions(model).dependencies(at, f);
  const { ends } = bindingEnds(model);
  if (deps.length === 0 || deps.some((id) => ends.has(id))) return at;
  return [...deps].sort().join('+');
}

/**
 * The context the value of `f`, the member at `path` of a binding read in
 * `contextId`, is read IN there, where that is not where it is written — or
 * `undefined`. A value over names the context changes is the context's own
 * ({@link DefiningEquations.readAt}): Q's `L = 2.0 * K` read at `L` in `q :
 * Q { :>> K = 25.0; }` is q's 50, not Q's 1. So is one an asserted equation
 * defines, read where the context changes what it reads ({@link
 * DefiningEquations.definitionReadIn}, {@link
 * DefiningEquations.chainDefinition}). A literal never is: it is one value in
 * every instance — Q's `L default = 7.0` under Q's `assert { L == 2.0 * K }`
 * is 7 in every Q, the assert checked against it, since no assertion replaces
 * a default ({@link replaceableDefaults}; P5H read q1's 50 where q1's K is 25
 * before decision 14 was amended) — save a literal `default` held by an
 * assert, one a typed assert may define, which is read nowhere.
 *
 * Where its own reading reads it already is no other context: a redefinition
 * that states nothing reads the value it redefines in its own usage ({@link
 * DefiningEquations.redefinedValueOf}) — p's copy of P's `m2 = 10.0 - load`
 * in `p : P { :>> load = 50.0; }` is p's −40 however it is reached.
 *
 * Two contexts that join the same features read a binding alike only where
 * each member is read as its own reading reads it in both — or in one context
 * both share: a value the binding carries to its other end is read for the
 * instance, and the generic reading of a partner (`boundDerivation` of
 * ./units-eval, which reads it so) is that instance's only then ({@link
 * boundPartnerSafe}).
 */
export function readsOtherwise(model: Model, contextId: ElementId, path: string, f: ElementRecord): ElementId | undefined {
  const v = f.attrs.value;
  if ((typeof v === 'number' || typeof v === 'boolean') && !assertHeld(model).has(f.id)) return undefined;
  if (path.startsWith('#')) return undefined;
  const definitions = sharedDefinitions(model);
  const at = definitions.readAt(contextId, path);
  if (at !== undefined) return at === definitions.redefinedValueOf(f)?.at ? undefined : at;
  const read = path.includes('.')
    ? definitions.chainDefinition([contextId], path)
    : definitions.definitionReadIn(contextId, path);
  return read && read.at !== read.site ? read.at : undefined;
}

/**
 * Where a context `contextId` reads the binding component of the feature its
 * bare `name` denotes — the context itself where a binding is read there,
 * else the nearest context above it, climbing from a usage to its owner as
 * {@link heldDefaults} does (`Q::p`'s `load` is read in Q, at `p.load`) — or
 * `undefined` where no binding reaches it.
 */
function componentOf(
  model: Model,
  contextId: ElementId,
  name: string,
): { root: ElementId; path: string; feature: ElementId; component: string } | undefined {
  const { readings } = bindingEnds(model);
  const definitions = sharedDefinitions(model);
  const seen = new Set<ElementId>();
  let path = name;
  for (let cur = model.get(contextId); cur && !seen.has(cur.id); ) {
    seen.add(cur.id);
    const r = readings.get(cur.id)?.get(path);
    if (r) return { root: cur.id, path, ...r };
    if (!isUsage(cur.eClass) || cur.ownerId == null || path.split('.').length > MAX_BINDING_SEGMENTS) return undefined;
    const n = definitions.nameOf(cur);
    if (n === undefined) return undefined;
    path = `${n}.${path}`;
    cur = model.get(cur.ownerId);
  }
  return undefined;
}

/**
 * The member of the binding component a name read in `contextId` meets
 * ({@link componentOf}) whose name two values reach in its own context
 * ({@link DefiningEquations.clash}), with that context — or `undefined`.
 * MI1's `q.p.load`, which q's `bind p.load = L` joins to q's L, over `Q23
 * :> Q2, Q3` whose L are 50 and 60: the binding gives the load a value the
 * model states twice, read nowhere — never one the solve may choose (read
 * as free, it took `q.p.load == 50.0` as a design equation and refuted `==
 * 60.0` at its own point).
 */
export function boundClashOf(
  model: Model,
  contextId: ElementId,
  name: string,
): { contextId: ElementId; clash: NameClash } | undefined {
  if (!hasUserBindings(model)) return undefined;
  const at = componentOf(model, contextId, name);
  if (!at) return undefined;
  const definitions = sharedDefinitions(model);
  for (const r of bindingEnds(model).readings.get(at.root)?.values() ?? []) {
    if (r.component !== at.component) continue;
    const f = model.get(r.feature);
    const clash = f?.ownerId != null ? definitions.clash(f.ownerId, f) : undefined;
    if (clash) return { contextId: f!.ownerId!, clash };
  }
  return undefined;
}

/**
 * The features the user's binding connectors join to `featureId`, itself
 * included — each connector's two ends, joined through the ends they share
 * (`bind x = y; bind y = e;` holds `x` to `e`), wherever they are read. These
 * are the partners `boundDerivation` of ./units-eval reads a value from.
 */
export function joinedTo(model: Model, featureId: ElementId): ReadonlySet<ElementId> {
  const index = indexOf(model);
  if (!index.joined) {
    const parent = new Map<ElementId, ElementId>();
    const find = (a: ElementId): ElementId => {
      let root = a;
      while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!;
      parent.set(a, root);
      return root;
    };
    for (const [a, b] of bindingEnds(model).edges) {
      if (!parent.has(a)) parent.set(a, a);
      if (!parent.has(b)) parent.set(b, b);
      const [x, y] = [find(a), find(b)];
      if (x !== y) parent.set(x, y);
    }
    const classes = new Map<ElementId, Set<ElementId>>();
    for (const id of parent.keys()) {
      const root = find(id);
      const set = classes.get(root) ?? new Set<ElementId>();
      set.add(id);
      classes.set(root, set);
    }
    index.joined = new Map([...parent.keys()].map((id) => [id, classes.get(find(id))!]));
  }
  return index.joined.get(featureId) ?? new Set([featureId]);
}

/**
 * Does context `root` read the binding component `component` as its
 * connectors join it to `featureId` — its members exactly the features they
 * join ({@link joinedTo}), none a redefinition that stands in one's place
 * there (`q2 : Q { :>> L = 50.0; }` joins Q's `load` to q2's own L), and each
 * read where it is written ({@link readsOtherwise})? Then the value a partner
 * gives where it is written is the value it gives there.
 *
 * Where the binding is written, a feature of an instance enclosing it is read
 * by its own id — R's `L` for `part q : Q { bind p.load = L; }`, whichever R
 * the q is in ({@link BindingEnds.enclosed}) — so that reading is every such
 * instance's only `alike`: when every context that reads the binding in an
 * instance of R reads it as joined ({@link uniformlyRead}).
 */
function readAsJoined(model: Model, root: ElementId, component: string, featureId: ElementId, alike = false): boolean {
  const { readings, enclosed } = bindingEnds(model);
  const reading = readings.get(root);
  const paths = indexOf(model).members.get(root)?.get(component) ?? [];
  const joined = joinedTo(model, featureId);
  const features = new Set<ElementId>();
  for (const path of paths) {
    if (markOf(model, root, path)?.includes('@')) return false;
    const r = reading?.get(path);
    if (!r || !joined.has(r.feature)) return false;
    if (!alike && path.startsWith('#') && enclosed.has(r.feature)) return false;
    features.add(r.feature);
  }
  return features.size === joined.size;
}

/**
 * Does every context a binding is read in read the component of `featureId`
 * as its connectors join it ({@link readAsJoined})? Then a partner's value is
 * one in every instance, and its generic reading is each one's. Vacuously so
 * for a feature no binding reading reaches.
 */
function uniformlyRead(model: Model, featureId: ElementId): boolean {
  const index = indexOf(model);
  const hit = index.uniform.get(featureId);
  if (hit !== undefined) return hit;
  const { readings } = bindingEnds(model);
  let answer = true;
  for (const { root, path } of index.roots.get(featureId) ?? []) {
    const component = readings.get(root)?.get(path)?.component;
    if (component === undefined || !readAsJoined(model, root, component, featureId, true)) {
      answer = false;
      break;
    }
  }
  index.uniform.set(featureId, answer);
  return answer;
}

/**
 * May the value a BINDING gives the valueless feature `featureId` — the one
 * the bare `name` denotes in `contextId` — be read where its partner is
 * written (`boundDerivation` of ./units-eval, which reads a derived partner at
 * its own element)? That is each instance's value only where every instance
 * the reading stands for reads the partner so:
 *  - always, in a model that writes no binding ({@link hasUserBindings});
 *  - never, while a binding was read in fewer contexts than it holds in
 *    ({@link BindingEnds.partial}) and the feature, or the one it reads, is
 *    any binding's end — or is an end of a binding left out of a context
 *    ({@link BindingEnds.unread});
 *  - where every context reads its component as its connectors join it
 *    ({@link uniformlyRead});
 *  - else where the context's own reading of the component does
 *    ({@link readAsJoined}), and no context above it reads the binding
 *    otherwise ({@link DefiningEquations.boundAbove}).
 *
 * M2's `q.p.m2` (P's `10.0 - load`, Q's `bind p.load = L` over `L = 2.0 *
 * K`, q's K of 25) is read in `Q::p` for every Q's p: read at Q, L was 1 and
 * m2 9 — a false refutation of `q.p.m2 <= 0.0`, where q's is −40. So was
 * Q's `load <= 5.0` read in `q2 : Q { :>> L = 50.0; }` over Q's `L default =
 * 2.0 * K`: Q's L of 1, where q2's load is its own L of 50. No value is read
 * there now; only a reading per instance may give one.
 */
export function boundPartnerSafe(model: Model, contextId: ElementId, name: string, featureId: ElementId): boolean {
  const ends = bindingEnds(model);
  if (ends.userBindings === 0) return true;
  // Once per revision: every instance row of a group reads the usage's names
  // through the usage, and asks the same question of it.
  const memo = (ends.partnerSafe ??= new Map());
  const key = `${contextId} ${name} ${featureId}`;
  let safe = memo.get(key);
  if (safe === undefined) {
    safe = partnerSafeOf(model, ends, contextId, name, featureId);
    memo.set(key, safe);
  }
  return safe;
}

/** {@link boundPartnerSafe}, worked out. */
function partnerSafeOf(model: Model, ends: BindingEnds, contextId: ElementId, name: string, featureId: ElementId): boolean {
  const f = model.get(featureId);
  if (!f) return true;
  const definitions = sharedDefinitions(model);
  const carried = definitions.carrier(contextId, f).id;
  if (ends.overCap.has(f.id) || ends.overCap.has(carried)) return false;
  // A feature whose default a held redefinition falls through to SOMEWHERE
  // (`held-redef`): its generic reading is one instance's only, so a partner
  // read through it is not safe.
  if (ends.heldSomewhere.has(f.id) || ends.heldSomewhere.has(carried)) return false;
  if (ends.unread.has(f.id) || ends.unread.has(carried)) return false;
  if (uniformlyRead(model, f.id)) return true;
  // Read where the context reads the component: no binding reaching it there
  // leaves nothing that says which instances it stands for.
  const own = componentOf(model, contextId, name);
  if (!own || own.feature !== f.id || !readAsJoined(model, own.root, own.component, f.id)) return false;
  return definitions.boundAbove(contextId, [name]) === undefined;
}

/**
 * What {@link DefiningEquations.boundAbove} finds above a context: another
 * context that reads a binding otherwise, or the cap a binding of the model
 * met ({@link BindingEnds.partial}).
 */
export type BoundAbove = ElementRecord | { pastCap: BindingCap };

/**
 * The sentence a cap answers a bound read with ({@link BindingEnds.overCap}):
 * the binding it belongs to held in more contexts than this tool reads, or is
 * read deeper than {@link MAX_BINDING_SEGMENTS} usages.
 */
function bindingCapSentence(cap: BindingCap): string {
  return cap === 'frames'
    ? `a binding of this model holds in more than ${MAX_BINDING_FRAMES.toLocaleString('en')} contexts`
    : `a binding of this model is read deeper than ${MAX_BINDING_SEGMENTS} usages`;
}

/**
 * Why a relation read in `contextId` is not read there for one instance
 * ({@link DefiningEquations.boundAbove}) — the sentence every surface refuses
 * or abstains on it with.
 */
export function boundAboveSentence(definitions: DefiningEquations, contextId: ElementId, above: BoundAbove): string {
  const where = definitions.contextName(contextId);
  if ('pastCap' in above) {
    if (above.pastCap === 'outside') {
      return (
        `the relation is read in ${where} and reads a value a binding joins, and that binding joins a feature ` +
        'outside where it is written that this tool finds no instance of in a context the binding holds in: ' +
        'so it reads no value the binding gives for any one instance, and the relation is not carried'
      );
    }
    const cap = bindingCapSentence(above.pastCap);
    return (
      `the relation is read in ${where} and reads a value a binding joins, and ${cap}: past that, this tool ` +
      'reads no bound value for any one instance, so it is not carried'
    );
  }
  if (assertFrameOnly(definitions.model, above)) {
    return (
      `the relation is read in ${where}, and an asserted equation of ${definitions.contextName(above.id)} above it ` +
      'defines what it reads there: each instance reads it otherwise, and this tool reads it for one alone, so it is not carried'
    );
  }
  return (
    `the relation is read in ${where}, and a binding above it joins what it reads to another value in ` +
    `${definitions.contextName(above.id)}: each instance reads it otherwise, and this tool reads it for one ` +
    'alone, so it is not carried'
  );
}

/** Why a context listed only for a binding member's own value there is not read at its instance. */
export type BoundHere = 'two-values' | 'unread';

/**
 * Why a relation is not read in the context `contextId`, which reads it
 * otherwise only because a binding member's value is its own there ({@link
 * DefiningEquations.readsBoundOnly}): beside another member that states a
 * value there, or over a binding not read there ({@link
 * DefiningEquations.boundStatedTwiceIn}) — the sentence every surface leaves
 * that reading undecided with.
 */
export function boundHereSentence(definitions: DefiningEquations, contextId: ElementId, why: BoundHere): string {
  const where = definitions.contextName(contextId);
  return why === 'two-values'
    ? `the relation is read in ${where}, and a binding joins what it reads to a value ${where} reads as its own ` +
        'and to another value the model states there: this tool reads neither of two values, so it is not carried'
    : `the relation is read in ${where}, and a binding joins what it reads to a value ${where} reads as its own: ` +
        `this tool reads that binding in no instance of ${where}, so it is not carried`;
}

/**
 * Why a relation written in a USAGE is not read for one instance — the usage
 * stands for several, and a binding above it reads what the relation reads
 * otherwise in one of them ({@link DefiningEquations.boundAbove}) — or
 * `undefined`. `part p : P { constraint c2 { load <= 10.0 } }` in Q, whose
 * `bind p.load = L` gives q's p the load of q's `L = 50.0`, was PROVED at Q's
 * own L of 1: c2 is a feature of every Q's p, and q's breaks it. Every surface
 * reads such a relation as no verdict, in this sentence; an asserted one stays
 * a fact of the model (its generic reading is a weaker, sound assumption).
 * `names` are the names its body reads.
 */
export function usageOwnedRefusal(model: Model, el: ElementRecord, names: readonly string[]): string | undefined {
  if (el.ownerId == null || !readsPerInstance(model)) return undefined;
  const owner = model.get(el.ownerId);
  if (!owner || !isUsage(owner.eClass)) return undefined;
  const definitions = sharedDefinitions(model);
  const above = definitions.boundAbove(owner.id, names);
  return above ? boundAboveSentence(definitions, owner.id, above) : undefined;
}

/** The names a relation body reads, a `[unit]` literal's marker excluded, once each — `[]` for one that does not parse. */
export function relationNamesOf(expr: string): string[] {
  const body = parseRelationBody(expr.trim());
  return body ? [...new Set(refsIn(body.node, body.literals))] : [];
}

/**
 * The dotted path of feature `id` below `ownerId`, by effective names —
 * `undefined` when it is not below it: `p.load` for the end of Q's `bind
 * p.load = L`.
 */
export function bindingEndPath(model: Model, id: ElementId | undefined, ownerId: ElementId): string | undefined {
  const segments: string[] = [];
  const seen = new Set<ElementId>();
  for (let cur = id !== undefined ? model.get(id) : undefined; cur; cur = cur.ownerId != null ? model.get(cur.ownerId) : undefined) {
    if (cur.id === ownerId) return segments.length > 0 ? segments.join('.') : undefined;
    if (seen.has(cur.id)) return undefined;
    seen.add(cur.id);
    const name = effectiveNameOf(model, cur);
    if (name === undefined) return undefined;
    segments.unshift(name);
  }
  return undefined;
}

/**
 * What a feature at a binding's end states, for {@link heldDefaults}: a value
 * — `asserted` where it is one an asserted equation gives an end that states
 * none ({@link assertDefinesEnd}) — a `default`, with the feature that writes
 * it, or nothing.
 */
type EndValue = { kind: 'value'; asserted?: true } | { kind: 'default'; source: ElementRecord } | { kind: 'none' };

/**
 * The features whose `default` gives way to a binding (decision 10) — read in
 * every CONTEXT a binding holds in: where it is written, every context that
 * specialises its owner, and every context such an instance is a feature of
 * (Q's `bind p.load = L` holds in R at `q.p.load` and `q.L` for `part q : Q`
 * in R, and in `part r : R` at `r.q.p.load`). In each context the bindings
 * that hold there join their ends — each end the most specific feature at its
 * path there — into components: `bind B = A; bind C = B;` is one, and so is
 * Q's binding beside R's `bind q.L = M`. Where a component has a value of its
 * own — written with `=`, or defined by an asserted equation — every
 * `default` in it gives way: the one a member writes (q's `:>> load default =
 * 30.0` in a `p` Q binds to its `L = 50.0`) and the one a member reads
 * through a redefinition (the copy `bind p.load = L` makes of P's `load`).
 * Where it has none, one default stands — a binding to a feature nothing
 * gives a value (`attribute w; bind w = p.load;`) carries the default INTO
 * it, as it always did, an expression too — and two or more stand only where
 * they are one CONSTANT value ({@link defaultsAgree}); otherwise they give
 * way: two defaults bound to each other are no value the model states, and
 * reading both made it contradict itself. An expression is never one value
 * by its text: `2.0 * K` is another value in each instance that sets K.
 *
 * Read per context, a context's own value is no reason for a default where
 * the binding does not reach: Q's `L default = 1.0` stands in Q, though `q :
 * Q` sets L to 50 (q's L masks it there). The answer is per FEATURE: a
 * default that gives way in one context gives way in every one — a context
 * where it would have stood reads it through the binding, or not at all.
 *
 * A binding read in fewer contexts than it holds in — more than {@link
 * MAX_BINDING_FRAMES}, or one deeper than {@link MAX_BINDING_SEGMENTS} usages
 * left out — holds its ends wherever they read a default, since the context
 * left out may be the one that gives them another value (a package's `bind
 * top.a.….a.L = X` 33 usages down left T1's `L default = 1.0` standing
 * beside X's 50), and sets `cap` ({@link BindingEnds.partial}).
 */
function heldDefaults(
  model: Model,
  bindings: readonly ElementRecord[],
): Pick<BindingEnds, 'held' | 'standing' | 'standingAt' | 'headSlots' | 'readings' | 'cap' | 'unread' | 'enclosed' | 'heldIn' | 'heldSomewhere' | 'overCap' | 'heads'> {
  const definitions = sharedDefinitions(model);
  // Per context: the paths its bindings join, and the feature at each.
  const contexts = new Map<ElementId, { parent: Map<string, string>; at: Map<string, ElementRecord> }>();
  const held = new Set<ElementId>();
  const standing = new Set<ElementId>();
  const replaceable = replaceableDefaults(model);
  const unread = new Set<ElementId>();
  const enclosed = new Set<ElementId>();
  const heldIn = new Set<string>();
  const heldSomewhere = new Set<ElementId>();
  const standingAt = new Set<string>();
  // The holds that cover every context the feature is read in: past a cap, at a package's head, at a feature
  // that redefines a head's ({@link standingAt} is decided against these alone).
  const wide = new Set<ElementId>();
  const overCap = new Map<ElementId, BindingCap>();
  let cap: BindingCap | undefined;
  // Read nowhere in particular: held wherever an end reads a default.
  const holdEnds = (holder: ElementRecord, ids: readonly ElementId[]): void => {
    for (const id of ids) {
      const f = model.get(id);
      if (f && endValue(model, f, holder, '').kind === 'default') {
        holdDefault(model, held, heldIn, heldSomewhere, f);
        wide.add(f.id);
      }
    }
  };
  // The feature at `path` in `root`, and the path as `root` spells it: a
  // segment a renamed redefinition answers to (`part pp :>> p` in `part q :
  // Q`, under Q's `bind p.load = L`) by that redefinition's own name — q's
  // `pp.load`, the instance every surface reads (H5, E8: R13).
  const resolve = (root: ElementId, path: string): { f: ElementRecord; path: string } | undefined => {
    let owner = root;
    let f: ElementRecord | undefined;
    const spelled: string[] = [];
    for (const seg of path.split('.')) {
      f = definitions.byName(owner).get(seg);
      if (!f) return undefined;
      spelled.push(definitions.nameOf(f) ?? seg);
      owner = f.id;
    }
    return f ? { f, path: spelled.join('.') } : undefined;
  };
  const find = (parent: Map<string, string>, a: string): string => {
    let root = a;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (a !== root) {
      const next = parent.get(a)!;
      parent.set(a, root);
      a = next;
    }
    return root;
  };
  for (const b of bindings) {
    const holder = model.get(b.ownerId!);
    const left = b.source?.[0];
    const right = b.target?.[0];
    if (!holder || left === undefined || right === undefined || left === right) continue;
    const pair = [left, right] as const;
    const places = [endPlace(model, left, holder), endPlace(model, right, holder)] as const;
    places.forEach((place, k) => place.kind === 'enclosed' && enclosed.add(pair[k]));
    // The contexts it holds in, each with the path its ends are read at — and,
    // for an end of an instance that encloses the holder (R's `L` in `part q :
    // Q { bind p.load = L; }`), the path from the context to that instance
    // (`outer`), once a climb from a usage to its owner reached it.
    type Frame = { root: ElementRecord; prefix: string; outer: readonly [string | undefined, string | undefined] };
    const frames: Frame[] = [{ root: holder, prefix: '', outer: [undefined, undefined] }];
    const index = new Map<string, number>([[`${holder.id} `, 0]]);
    const next: number[][] = [];
    let dropped = false;
    for (let i = 0; i < frames.length && frames.length <= MAX_BINDING_FRAMES; i++) {
      const { root, prefix, outer } = frames[i]!;
      const succ: Frame[] = definitions.specialisersOf(root.id).map((z) => ({ root: z, prefix, outer }));
      const name = isUsage(root.eClass) ? definitions.nameOf(root) : undefined;
      const owner = root.ownerId != null ? model.get(root.ownerId) : undefined;
      if (name !== undefined && owner && owner.attrs.isLibrary !== true) {
        const up = (k: 0 | 1): string | undefined => {
          const o = outer[k];
          if (o !== undefined) return o === '' ? name : `${name}.${o}`;
          const place = places[k];
          return place.kind === 'enclosed' && place.within.has(owner.id) ? '' : undefined;
        };
        succ.push({ root: owner, prefix: prefix === '' ? name : `${name}.${prefix}`, outer: [up(0), up(1)] });
      }
      const edges: number[] = [];
      for (const f of succ) {
        const key = `${f.root.id} ${f.prefix}`;
        const known = index.get(key);
        if (known !== undefined) {
          edges.push(known);
          continue;
        }
        if (f.prefix.split('.').length > MAX_BINDING_SEGMENTS) {
          dropped = true;
          continue;
        }
        index.set(key, frames.length);
        edges.push(frames.length);
        frames.push(f);
      }
      next[i] = edges;
    }
    if (frames.length > MAX_BINDING_FRAMES) {
      cap ??= 'frames';
      for (const id of pair) overCap.set(id, 'frames');
      holdEnds(holder, pair);
      continue;
    }
    if (dropped) {
      cap ??= 'segments';
      for (const id of pair) overCap.set(id, 'segments');
      holdEnds(holder, pair);
    }
    // A context below the instance that owns an end (a usage of the holder in
    // that instance's definition, before a climb reaches it) reads the end
    // where the climb does (`pending`); one in which an end is no feature at
    // all — its path does not resolve there, or no climb reaches its owner —
    // is a context left out, and its ends are held as past a cap.
    const located: boolean[] = [];
    const pending: boolean[] = [];
    let outside = false;
    for (let i = 0; i < frames.length; i++) {
      const { root, prefix, outer } = frames[i]!;
      const own = prefix === '' && root.id === holder.id;
      const at = (k: 0 | 1): [string, ElementRecord] | 'pending' | undefined => {
        const end = pair[k];
        const place = places[k];
        if (own || place.kind === 'global') {
          const f = model.get(end);
          return f ? [own && place.kind === 'below' ? place.path : `#${end}`, f] : undefined;
        }
        if (place.kind === 'nowhere') return undefined;
        let full: string;
        if (place.kind === 'below') full = prefix === '' ? place.path : `${prefix}.${place.path}`;
        else if (outer[k] === undefined) return 'pending';
        else full = outer[k] === '' ? place.path : `${outer[k]}.${place.path}`;
        const hit = resolve(root.id, full);
        return hit ? [hit.path, hit.f] : undefined;
      };
      const l = at(0);
      const r = at(1);
      if (l === undefined || r === undefined) {
        outside = true;
        continue;
      }
      if (l === 'pending' || r === 'pending') {
        pending[i] = true;
        continue;
      }
      located[i] = true;
      let ctx = contexts.get(root.id);
      if (!ctx) {
        ctx = { parent: new Map(), at: new Map() };
        contexts.set(root.id, ctx);
      }
      for (const [path, f] of [l, r]) {
        if (!ctx.parent.has(path)) ctx.parent.set(path, path);
        ctx.at.set(path, f);
      }
      const a = find(ctx.parent, l[0]);
      const c = find(ctx.parent, r[0]);
      if (a !== c) ctx.parent.set(a, c);
    }
    // A pending context is read where a climb from it reads both ends; one
    // no climb takes there is left out.
    const reached = located.slice();
    for (let changed = true; changed; ) {
      changed = false;
      for (let i = frames.length - 1; i >= 0; i--) {
        if (reached[i] === true || pending[i] !== true || !(next[i] ?? []).some((j) => reached[j] === true)) continue;
        reached[i] = true;
        changed = true;
      }
    }
    if (pending.some((p, i) => p && reached[i] !== true)) outside = true;
    if (outside) {
      holdEnds(holder, pair);
      for (const id of pair) unread.add(id);
    }
  }
  if (overCap.size > 0) pastCapComponents(model, bindings, overCap, holdEnds);
  const readings = new Map<ElementId, Map<string, { feature: ElementId; component: string }>>();
  const { heads, byRedefined } = headsOfReadings(model, definitions, contexts, (rootId, path) => find(contexts.get(rootId)!.parent, path));
  // The names an owner's asserted equations define, once per owner ({@link fallsToDefault}).
  const asserted = new Map<ElementId, ReadonlySet<string>>();
  type Member = { f: ElementRecord; value: EndValue; path: string };
  const byRoot = new Map<ElementId, { root: ElementRecord; components: Map<string, Member[]> }>();
  for (const [rootId, ctx] of contexts) {
    const root = model.get(rootId)!;
    const components = new Map<string, Member[]>();
    const reading = new Map<string, { feature: ElementId; component: string }>();
    for (const [path, f] of ctx.at) {
      const key = find(ctx.parent, path);
      const list = components.get(key) ?? [];
      list.push({ f, value: endValue(model, f, root, path), path });
      components.set(key, list);
      reading.set(path, { feature: f.id, component: key });
    }
    readings.set(rootId, reading);
    byRoot.set(rootId, { root, components });
  }
  // Whether what fixes each head's slot states a value a `default` gives way to ({@link DefinitionHead.states}):
  // an asserted equation never does, and a binding member at the slot does unless asserted equations alone give
  // its component a value. Every component a binding member at a slot is in is the head's, joined at the slot
  // (`headSlots`), whatever states the value.
  const headSlots = new Map<string, Array<{ root: ElementId; head: DefinitionHead }>>();
  for (const [headRoot, list] of heads) {
    for (const head of list) {
      if (head.fixedBy === 'assert') head.states = false;
      if (head.fixedBy !== 'binding') continue;
      let states = false;
      for (const slot of head.slots ?? []) {
        const values = (byRoot.get(slot.root)?.components.get(slot.component) ?? []).filter((m) => m.value.kind !== 'none');
        if (values.length === 0 || !values.every((m) => m.value.kind === 'value' && m.value.asserted === true)) states = true;
        const key = `${slot.root} ${slot.component}`;
        const at = headSlots.get(key) ?? [];
        if (!at.some((x) => x.head === head)) at.push({ root: headRoot, head });
        headSlots.set(key, at);
      }
      head.states = states;
    }
  }
  // The components an asserted equation alone gives a value: each `default` in one stands there as a value
  // written with `=` — unless it gives way elsewhere (below, once every other component is read).
  const defined: Array<{ rootId: ElementId; root: ElementRecord; members: readonly Member[]; redefiners: readonly ElementRecord[] }> = [];
  for (const [rootId, { root, components }] of byRoot) {
    for (const [key, members] of components) {
      // A package's binding on a DEFINITION's feature (w4, {@link
      // definitionHeadMatch}) holds in every instance of the definition, and
      // so over every feature that redefines that one with a value of its own
      // (`part p3 : P { attribute :>> load default = 7.0; }` under `bind
      // P::load = L`): each is a member's value too. Two such members (`bind
      // P::load = P::cap`) are read per instance, and no default of theirs is
      // the component's one value; nor is any where an instance's slot is
      // fixed outside the component ({@link DefinitionHead.fixed}).
      const mine = (heads.get(rootId) ?? []).filter((h) => h.component === key);
      const redefiners = mine.length > 0 ? [...new Set(mine.flatMap((h) => byRedefined?.get(h.feature) ?? []))] : [];
      // One default per MEMBER, not per source: R3a's `A::v` read at a1.v and
      // at a2.v is two readings of `2.0 * K`, one per instance.
      const defaults = [
        ...members.flatMap((m) => (m.value.kind === 'default' ? [m.value.source] : [])),
        ...redefiners.filter((r) => r.attrs.defaultValue === true),
      ];
      if (defaults.length === 0) continue;
      // A head whose slot only an assertion fixes outside the component states nothing a default gives way to
      // (W4X5's `p2.load == 5.0` under `bind P::load = M`): M's default stands, as `M = 9.0` does.
      const stated = members.some((m) => m.value.kind === 'value' && m.value.asserted !== true) || mine.some(fixesSlot);
      // The binding route: a value an asserted equation gives an end (H2f's `bind L = L0` beside `assert
      // constraint { L == 50.0 }`) is carried into no `default` an assertion may not replace ({@link
      // replaceableDefaults}) — none: each stands there as a value written with `=` does (`standing`), so the
      // component holds two values, as `L0 = 1.0` makes it, and L0 reads its own 1, never the equation's 50.
      // H2f reads as its `=` twin. Where a value is written with `=` too, the defaults give way to that one.
      if (!stated && members.some((m) => m.value.kind === 'value' && m.value.asserted === true)) {
        defined.push({ rootId, root, members, redefiners });
        continue;
      }
      if (stated || mine.length > 1 || !defaultsAgree(defaults)) {
        for (const r of redefiners) {
          if (r.attrs.defaultValue !== true) continue;
          holdDefault(model, held, heldIn, heldSomewhere, r);
          wide.add(r.id);
        }
        for (const m of members) {
          if (m.value.kind !== 'default') continue;
          const inst = heldInstance(definitions, rootId, m.path);
          holdDefault(model, held, heldIn, heldSomewhere, m.f, inst, fallsToDefault(model, m.f, root, m.path, asserted, m.value.source));
          // A package's binding on a definition's feature (a head, {@link DefinitionHead}: X3's `P.load`), or one
          // written on a global feature (`#…`), holds in every instance of it.
          if (inst === undefined || mine.some((h) => h.path === m.path)) wide.add(m.f.id);
        }
      }
    }
  }
  // Read after every other component: a default held where this component is read too gives way here — one a
  // package's binding on a definition's feature holds in every instance (X3's `bind P::load = M` over every P,
  // read in Q beside Q's `bind p.load = L` and Q's asserted `L == 3.0`), one held past a cap, one held at this
  // very instance (X6's W's `bind q.p.load = M`, read in w) — reading what the binding gives it; it is never a
  // second value beside the one it gave way to. Every other default stands, as a value written with `=`
  // (`standing`), and no hold another context made is undone: X6's W's binding holds W's q's p's load, which
  // reads M's 3 there, while Q's own p keeps P's 1 against Q's assert. So does one a binding to a value written
  // with `=` holds only in another context (`standingAt`, by root and path): T4C's `Q5 :> Q { :>> L = 7.0 }`,
  // never instantiated, holds Q's p's load in Q5, and Q's q keeps P's 1 against Q's assert — held there too,
  // it read Q's asserted 50 through Q's binding, the one value no default takes. One an assertion may replace
  // ({@link replaceableDefaults}: none) would give way to the equation. Decided first and applied after, so no
  // hold made here decides another component.
  const giveWay: Array<() => void> = [];
  const stand: Array<{ rootId: ElementId; path: string; f: ElementRecord; source: ElementRecord }> = [];
  for (const { rootId, root, members, redefiners } of defined) {
    for (const r of redefiners) {
      if (r.attrs.defaultValue !== true) continue;
      if (replaceable.has(r.id) || held.has(r.id)) giveWay.push(() => holdDefault(model, held, heldIn, heldSomewhere, r));
      else stand.push({ rootId, path: '', f: r, source: r });
    }
    for (const m of members) {
      if (m.value.kind !== 'default') continue;
      const inst = heldInstance(definitions, rootId, m.path);
      const givenWay = wide.has(m.f.id) || wide.has(m.value.source.id) || (inst !== undefined && heldIn.has(inst));
      if (replaceable.has(m.value.source.id) || givenWay) {
        const source = m.value.source;
        giveWay.push(() => holdDefault(model, held, heldIn, heldSomewhere, m.f, inst, fallsToDefault(model, m.f, root, m.path, asserted, source)));
      } else stand.push({ rootId, path: m.path, f: m.f, source: m.value.source });
    }
  }
  for (const hold of giveWay) hold();
  for (const { rootId, path, f, source } of stand) {
    // A head's redefinition (no path) stands as before.
    if (path !== '' && (held.has(f.id) || held.has(source.id))) standingAt.add(`${rootId} ${path}`);
    else standing.add(f.id);
  }
  return { held, standing, standingAt, headSlots, readings, unread, enclosed, heldIn, heldSomewhere, overCap, heads, ...(cap !== undefined ? { cap } : {}) };
}

/**
 * Past a cap, a binding is read in fewer contexts than it holds in — and the
 * value it gives in a context left out still reaches every feature joined to
 * its ends there, whatever binding joins them: CAP1's `bind Y = top.a.….a.load`,
 * read in the package, joins Y's `default = 1.0` to the load T1's `bind a.load
 * = L` gives X's 50 thirty-three usages down, a binding past the segment cap
 * (the package is the context left out). Read as one component in the package,
 * Y and the load's fall-through were two defaults that agree, and Y stood at
 * 1 (`Y >= 40.0` refuted where it holds). So the cap reaches the whole GLOBAL
 * component of the connectors' ends — their union-find over every user
 * binding, each end joined to every other binding's end it redefines ({@link
 * redefinedClosure}), since the end the package's binding reads at that path
 * redefines the one T1's joins: every end in a component with an end past a
 * cap is past that cap too (`overCap`, the first cap the component met), and
 * every default in it is held (`holdEnds`). The readings that consult
 * `overCap` — {@link boundSourceIn}, {@link defaultStandsIn}, {@link
 * boundPartnerSafe}, {@link DefiningEquations.boundAbove} — then abstain on
 * every one of them, never on a binding the capped one does not reach. A
 * feature no binding names joins nothing: U's `bind a.load = M` on its own
 * `part a : T0` redefines T0's load, as T1's capped end does, and joined
 * through it U's M and load were held past a cap that is not theirs — free
 * to the numeric lane, which then solved `u.a.load == 9.0` as a design
 * equation where both are U's default of 1 (CAPU2).
 */
function pastCapComponents(
  model: Model,
  bindings: readonly ElementRecord[],
  overCap: Map<ElementId, BindingCap>,
  holdEnds: (holder: ElementRecord, ids: readonly ElementId[]) => void,
): void {
  const parent = new Map<ElementId, ElementId>();
  const find = (a: ElementId): ElementId => {
    if (!parent.has(a)) parent.set(a, a);
    let root = a;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (a !== root) {
      const next = parent.get(a)!;
      parent.set(a, root);
      a = next;
    }
    return root;
  };
  const union = (a: ElementId, b: ElementId): void => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(ra, rb);
  };
  const joined: Array<{ holder: ElementRecord; pair: readonly [ElementId, ElementId] }> = [];
  for (const b of bindings) {
    const holder = model.get(b.ownerId!);
    const left = b.source?.[0];
    const right = b.target?.[0];
    if (!holder || left === undefined || right === undefined || left === right) continue;
    joined.push({ holder, pair: [left, right] as const });
  }
  const ends = new Set<ElementId>(joined.flatMap(({ pair }) => pair));
  for (const { pair } of joined) {
    union(pair[0], pair[1]);
    // Through what an end redefines only where that is another binding's end: a feature of a
    // definition no binding names (T0's `load`) is redefined in every instance that binds it, and
    // joined through it two instances' bindings were one component.
    for (const id of pair) {
      const f = model.get(id);
      if (f) for (const g of redefinedClosure(model, f)) if (ends.has(g.id)) union(id, g.id);
    }
  }
  // The component above joins ends through what they redefine, and what an end redefines turns on the text order
  // (CAP1's `bind Y = top.a.….a.load` redefines only T0's load when it is written before T1, whose own `bind a.load =
  // L` has no end copy yet when the chain resolves): an end read through an instance of a definition that owns a
  // capped end is past that cap too, whichever way the text was written.
  const cappedDefs = new Map<ElementId, BindingCap>();
  for (const [cid, met] of overCap) {
    for (let cur = model.get(cid); cur && cur.ownerId != null; cur = model.get(cur.ownerId)) {
      const owner = model.get(cur.ownerId);
      if (owner && isDefinition(owner.eClass)) {
        cappedDefs.set(owner.id, met);
        break;
      }
    }
  }
  if (cappedDefs.size > 0) {
    for (const id of ends) {
      if (overCap.has(id)) continue;
      for (let cur = model.get(model.get(id)?.ownerId ?? ''); cur; cur = cur.ownerId != null ? model.get(cur.ownerId) : undefined) {
        const hit = [cur, ...generalizationsOf(model, cur.id)].find((t) => cappedDefs.has(t.id));
        if (hit) {
          overCap.set(id, cappedDefs.get(hit.id)!);
          break;
        }
      }
    }
  }
  const capped = new Map<ElementId, BindingCap>();
  for (const [id, met] of overCap) {
    const root = find(id);
    if (!capped.has(root)) capped.set(root, met);
  }
  for (const { holder, pair } of joined) {
    const met = capped.get(find(pair[0]));
    if (met === undefined) continue;
    for (const id of pair) if (!overCap.has(id)) overCap.set(id, met);
    holdEnds(holder, pair);
  }
}

/**
 * Hold the default a binding overrides — and, for `inst`, the instance at
 * which a held member falls through to the redefined feature's own
 * `default`. Reading `P::a` generically where a redefinition of it
 * (`part :>> p { attribute :>> a default = 50.0; }`) is held would read the
 * redefined feature's default beside the binding there (`held-redef`): the
 * original's default gives way at that instance alone
 * ({@link defaultGivesWayIn}), so other instances of P keep it. So does a
 * held member that states nothing and reads the redefined default
 * (`fallsThrough`, {@link fallsToDefault}): the implicit end copy q2's `bind
 * p.extra = E` makes of P's `extra default = 0.0` (A4) holds P's extra at
 * q2's p, though the copy writes no default.
 */
function holdDefault(
  model: Model,
  held: Set<ElementId>,
  heldIn: Set<string>,
  heldSomewhere: Set<ElementId>,
  f: ElementRecord,
  inst?: string,
  fallsThrough = false,
): void {
  held.add(f.id);
  // A held redefinition falls through to the default it redefines when read
  // generically: that default is per instance — heldSomewhere, not held — so
  // the reading surfaces suppress it only at the instance (`defaultGivesWayIn`)
  // while the numeric and SMT lanes key it per instance.
  for (const g of redefinedClosure(model, f)) if (g.attrs.defaultValue === true) heldSomewhere.add(g.id);
  // A held member that WRITES a default suppresses the redefined feature at
  // that instance, and so does one that writes nothing and falls through to
  // it: read there, the redefined default was a decided answer a binding
  // overrides (A4: P's extra of 0 at q2's p, against q2's E of 20, the SMT
  // lane's instance value row beside the binding's). A valueless end copy
  // redefining a feature an asserted equation defines (GA6's `p.load`) does
  // not ({@link fallsToDefault}): its fall-through reads the assert.
  if (inst !== undefined && (f.attrs.defaultValue === true || fallsThrough)) heldIn.add(inst);
}

/** The instance spelling of the member at `path` read in the frame rooted at `rootId` — or `undefined` for one no path spells. */
function heldInstance(definitions: DefiningEquations, rootId: ElementId, path: string): string | undefined {
  if (path.startsWith('#')) return undefined;
  return `${definitions.instanceNameOf(rootId)}::${path.split('.').join('::')}`;
}

const ASSERT_HELD = new WeakMap<Model, { rev: number; held: ReadonlySet<ElementId>; typedBy: ReadonlyMap<ElementId, ElementRecord> }>();

/** No `default` an assertion may replace ({@link replaceableDefaults}). */
const NO_DEFAULTS: ReadonlySet<ElementId> = new Set();

/**
 * The features whose `default` an asserted equation may REPLACE, as a
 * redefinition or a binding to a value does (decision 10): none. A `default`
 * stands against every assertion (plan J decision 14, amended by the
 * maintainer 2026-10-22: the soft/hard defaults analysis, Q1 = a), as a value
 * written with `=` does — KerML 8.3.4.10.2 gives it way only to "another value
 * explicitly given" for the instance, and SysML 7.20.1 reads a false asserted
 * constraint as an inconsistency for tooling to flag. So `attribute L default
 * = 1.0` beside `assert constraint { L == 50.0 }` is L = 1 on every surface,
 * and the assert is reported violated, whatever its shape: `L == 50.0`, `L >=
 * 50.0 and L <= 50.0` and two asserts `L == 50.0`, `L >= 0.0` read alike
 * (G1, G3), and two that disagree read alike in either order (M8). A soft
 * value is written as the value (`:>> L = …`), or as a feature with no value
 * that an asserted equation defines — that keeps decision 14 (v9's CV-17).
 * The readings that let one give way each ask this set — the local rule
 * ({@link assertHeld}), the enclosing rule ({@link enclosingAsserts}), the
 * binding route ({@link heldDefaults}: an end an asserted equation defines)
 * and the lexical reading of a name an owning namespace declares ({@link
 * DefiningEquations.lexicalNames}: a `default` an assert names is the one
 * value it is there, LP1, SLD) — so that an opt-in tag that lets an assertion
 * adjust a written number, held until a model needs one (TODO.md), would
 * answer here alone. Typed asserts
 * are another matter: no surface reads their equation, so a `default` one may
 * define is read nowhere ({@link typedAssertHolding}).
 */
export function replaceableDefaults(_model: Model): ReadonlySet<ElementId> {
  return NO_DEFAULTS;
}

/**
 * Does `f` write a `default` no assertion replaces ({@link
 * replaceableDefaults}) — its own, or that of a feature it redefines, the
 * nearest value written? Such a feature is no feature WITHOUT a value, so no
 * asserted equation defines it (decision 14 keeps only those): not where its
 * default stands, and not where a binding makes it give way — it then reads
 * what the binding gives it, or nothing (two defaults that differ), never the
 * equation's value. GA6's `bind p.load = L` between P's `load default = 7.0`
 * and Q's `L default = 5.0` reads no value at either end; read as features
 * without one, each assert "defined" them, 7 and 5, past the binding.
 */
export function writesStandingDefault(model: Model, f: ElementRecord): boolean {
  const g = [f, ...redefinedClosure(model, f)].find((x) => x.attrs.value !== undefined && x.attrs.value !== null);
  return g !== undefined && g.attrs.defaultValue === true && !replaceableDefaults(model).has(g.id);
}

/**
 * Why `name`, read in `contextId`, has no value an assertion may give it: it
 * denotes a feature that writes a `default` ({@link writesStandingDefault})
 * which a binding makes give way there and gives no value of its own — two
 * defaults that differ (GWM's `bind p.load = L` between P's `load default =
 * 1.0` and Q's `L default = 7.0`), a cap, a value only an evaluation could
 * read — in the binding's own sentence ({@link boundSourceIn}'s abstention);
 * `undefined` where it does not. The check, the literal engine and the
 * numeric surface read no value for it there (the solver's
 * `givenWayDefaults`), and no asserted relation over it gives it one, since no
 * assertion replaces a default (decision 14 amended 2026-10-22): the
 * verification lane carries no such axiom (`gateRelation` of ./contracts).
 * Carried, Q's asserted `L == 2.0` proved `P::c in Q::p` (`load >= 1.5`) at 2
 * on the SMT engine alone.
 */
export function givenWayUnvalued(model: Model, contextId: ElementId, name: string): string | undefined {
  if (!hasUserBindings(model)) return undefined;
  const d = sharedDefinitions(model).denote(contextId).get(name);
  if (!d || !writesStandingDefault(model, d.feature)) return undefined;
  const g = [d.feature, ...redefinedClosure(model, d.feature)].find((x) => x.attrs.value !== undefined && x.attrs.value !== null);
  if (!g || (!bindingEnds(model).held.has(d.feature.id) && !defaultGivesWayIn(model, g, d.instance))) return undefined;
  const source = boundSourceIn(model, `${d.instance}::${name.slice(name.lastIndexOf('.') + 1)}`);
  return source !== undefined && 'abstain' in source ? source.sentence : undefined;
}

/**
 * Why `name`, read in `contextId`, carries what an asserted relation gives it
 * into a `default` that gives way and has no value: a feature with no value of
 * its own, whose binding component is the slot of a package's binding on a
 * definition's feature ({@link BindingEnds.headSlots}) at an instance, where
 * that binding's own component holds only defaults that give way — E1's
 * `bind p2.load = L` beside `assert constraint fix { L == 5.0 }`, at P's load,
 * which the package's `bind P::load = M` joins to M's `default = 9.0` and to
 * p4's `:>> load default = 7.0`, two that differ (decision 10) — or the
 * head's own feature read at an instance, which an assert fixes with no
 * binding at the slot (`assert constraint fix { p2.load == 5.0 }`). Carried, the
 * assert's 5 reached M through p2, and so every P's load: the SMT engine
 * PROVED `p3.load <= 6.0`, where the other surfaces read no value for p3's
 * load. No assertion gives a default a value (decision 14 amended
 * 2026-10-22), so the verification lane carries no such axiom (`gateRelation`
 * of ./contracts); `undefined` where none of that holds. {@link
 * definedAgainstHead} reads the route where the head's component states a
 * value.
 */
export function givenWayThroughHead(model: Model, contextId: ElementId, name: string): string | undefined {
  if (!hasUserBindings(model)) return undefined;
  const ends = bindingEnds(model);
  if (ends.heads.size === 0) return undefined;
  const d = sharedDefinitions(model).denote(contextId).get(name);
  if (!d || [d.feature, ...redefinedClosure(model, d.feature)].some((g) => g.attrs.value !== undefined && g.attrs.value !== null)) {
    return undefined;
  }
  const symbol = `${d.instance}::${name.slice(name.lastIndexOf('.') + 1)}`;
  const best = outermostReading(model, symbol);
  if (!best) return undefined;
  // The head's own feature read at an instance (E1's `p2.load == 5.0`, no binding at the slot): the same component.
  if (best.head !== undefined) {
    const cls = classified(model, best.root, best.head.component);
    if (cls.valued.length > 0 || cls.readable.length > 0 || cls.heldDefaults.length === 0) return undefined;
    const words = componentBindingWords(model, best.root, best.head.component);
    return `is the slot of ${best.head.path}, which ${words.bind}${words.of} joins to defaults that give way and give it no value (${componentPaths(model, best.root, best.head.component).join(', ')})`;
  }
  for (const { root: headRoot, head } of ends.headSlots.get(`${best.root} ${best.component}`) ?? []) {
    const cls = classified(model, headRoot, head.component);
    if (cls.valued.length > 0 || cls.readable.length > 0 || cls.heldDefaults.length === 0) continue;
    const slot = head.slots?.find((s) => s.root === best.root && s.component === best.component)?.path ?? head.path;
    const { bind, of } = componentBindingWords(model, best.root, best.component);
    const words = componentBindingWords(model, headRoot, head.component);
    return (
      `${bind}${of} joins it to ${slot}, which ${words.bind}${words.of} joins to defaults that give way and give it ` +
      `no value (${componentPaths(model, headRoot, head.component).join(', ')})`
    );
  }
  return undefined;
}

/**
 * Why the asserted EQUATION `el`, violated, did not change the `default` it
 * was written to give a value ({@link replaceableDefaults}), and how to write
 * that value instead: "Battery::mass's `default = 1.2` is not changed by an
 * assertion: write the analysis as the value (`:>> mass = …`) to replace it".
 * Only the shape decision 14 read as a definition before it was amended: a
 * side that is the default's feature, by its bare or dotted name, with the
 * other side reading neither it back nor any other `default` (a pair of
 * defaults gave neither a value, U7) — `mass == 0.8`, `p.x == 2.0 * K`. A
 * dotted name says where the value goes: q1's `p.x == 50.0` reads "write the
 * analysis as the value (`part :>> p { attribute :>> x = …; }` in R::q1)". A
 * name with no value that a binding carries a `default` into (RB3's `q.p.x`)
 * names that default and the binding ({@link carriedDefaultOf}). Given an
 * instance's record (the relation read in a context, as `readInContexts` does),
 * the names are those the instance reads. An
 * inequality never defined a default (U5), and an equation over one on its
 * other side (`mass == 0.2 * cells` beside `cells default = 4.0`) only reads
 * it: either is a requirement checked against the default, and naming the
 * default as the thing to rewrite would tell an agent to silence it. Never one
 * a binding holds in any instance, nor one a typed assert names. `undefined`
 * where none of that holds, or `el` is no `assert`: a plain constraint, a
 * `require` or an `assume` is an obligation, judged against the value, and
 * was never one to change it.
 */
export function standingDefaultSentence(model: Model, el: ElementRecord): string | undefined {
  if (el.ownerId == null || !isAsserted(el)) return undefined;
  const eq = equationOf(el);
  if (!eq) return undefined;
  const ownerId = el.ownerId;
  const denoted = sharedDefinitions(model).denote(ownerId);
  const valueOf = (f: ElementRecord): ElementRecord | undefined =>
    [f, ...redefinedClosure(model, f)].find((x) => x.attrs.value !== undefined && x.attrs.value !== null);
  const said = new Map<ElementId, string>();
  for (const [side, other] of [
    [eq.node.left, eq.node.right],
    [eq.node.right, eq.node.left],
  ] as const) {
    const n = definedName(side, eq.literals);
    if (n === undefined) continue;
    const reads = refsIn(other, eq.literals);
    if (reads.includes(n)) continue;
    // The other side over another `default` set the two equal: no definition of either (U7).
    if (reads.some((r) => { const h = denoted.get(r)?.feature; return h !== undefined && valueOf(h)?.attrs.defaultValue === true; })) continue;
    const d = denoted.get(n);
    const f = d?.feature;
    const g = f && valueOf(f);
    if (d && f && !g) {
      // A feature with no value that a binding carries a `default` into (RB3's `q.p.x`, joined to q's `L default =
      // 4.0`): that default is the value the equation was written to give, and it stood.
      const carried = carriedDefaultOf(model, `${d.instance}::${n.slice(n.lastIndexOf('.') + 1)}`);
      const h = carried && valueOf(carried);
      if (carried && h && h.attrs.defaultValue === true && !said.has(h.id) && !defaultGivesWaySomewhere(model, carried) && !defaultGivesWaySomewhere(model, h)) {
        said.set(
          h.id,
          `${writtenName(model, h)}'s \`default = ${writtenValue(h)}\` is carried into ${n} by a binding and is not changed by an ` +
            `assertion: write the analysis as the value of ${writtenName(model, h)} to replace it`,
        );
      }
      continue;
    }
    if (!f || !g || g.attrs.defaultValue !== true || said.has(g.id) || replaceableDefaults(model).has(g.id)) continue;
    if (defaultGivesWaySomewhere(model, f) || defaultGivesWaySomewhere(model, g)) continue;
    said.set(
      g.id,
      `${writtenName(model, g)}'s \`default = ${writtenValue(g)}\` is not changed by an assertion: write the analysis as the ` +
        `value (${redefinitionSpelling(model, ownerId, n, f, g)}) to replace it`,
    );
  }
  return said.size > 0 ? [...said.values()].join('; ') : undefined;
}

/**
 * The feature whose `default` a binding carries into the instance `symbol` ({@link boundSourceIn}'s one readable
 * `default`: no member of the component states a value), or `undefined`.
 */
function carriedDefaultOf(model: Model, symbol: string): ElementRecord | undefined {
  const source = boundSourceIn(model, symbol);
  if (!source || 'abstain' in source) return undefined;
  const reading = bindingEnds(model).readings.get(source.root)?.get(source.via.source);
  return reading ? model.get(reading.feature) : undefined;
}

/**
 * Where the value of the feature `path` names below `ownerId` is written to
 * replace its `default` ({@link standingDefaultSentence}): `` `:>> mass = …` ``
 * for a bare name the element inherits (a usage of the definition, or a
 * specialisation of it); for a dotted one, the redefinitions down the path,
 * each with its own keyword, in the element that writes the assert — `` `part
 * :>> p { attribute :>> x = …; }` in R::q1 `` — since a bare `:>> x` there
 * would name no feature of q1's. A feature the element declares itself, or
 * reads through an owning namespace, is no feature it may redefine: a feature
 * that redefines its own sibling is no KerML, and one nested below the
 * declaring namespace has no such feature at all. So the leading segments the
 * element declares down the path are not redefined but entered — Pack's `b.mass
 * == 0.8` over its own `part b : Battery` reads `` `attribute :>> mass = …;` in
 * M4::Pack::b `` — and a feature declared all the way down (`f`, the one the
 * path denotes; `g`, the one that writes the default) has its value written
 * where it is declared: `` `= …` in place of `default = 1.2` where M1::Battery
 * declares mass ``.
 */
function redefinitionSpelling(model: Model, ownerId: ElementId, path: string, f: ElementRecord, g: ElementRecord): string {
  const segments = path.split('.');
  const keywords: string[] = [];
  // The element each segment is read in, and whether the feature there is one it declares itself.
  const holders: ElementId[] = [];
  const declared: boolean[] = [];
  let cur = ownerId;
  for (const segment of segments) {
    holders.push(cur);
    const h = [...ownFeatures(model, cur), ...effectiveFeatures(model, cur)].find((x) => effectiveNameOf(model, x) === segment);
    keywords.push(h ? (TEXTUAL_KEYWORD[h.eClass] ?? '') : '');
    declared.push(h !== undefined && h.ownerId === cur);
    if (h) cur = h.id;
  }
  // A bare name no feature of the element answers is one it reads through an owning namespace.
  if (segments.length === 1 && keywords[0] === '' && f.ownerId != null && f.ownerId !== ownerId) declared[0] = true;
  const entered = declared.findIndex((d) => !d);
  if (entered === -1) {
    const at = f.ownerId != null ? effectiveQualifiedName(model, f.ownerId) : effectiveQualifiedName(model, holders[holders.length - 1]!);
    const name = segments[segments.length - 1]!;
    return f.id === g.id
      ? `\`= …\` in place of \`default = ${writtenValue(g)}\` where ${at} declares ${name}`
      : `\`= …\` on the ${name} ${at} declares`;
  }
  if (segments.length === 1) return `\`:>> ${path} = …\``;
  const at = (k: number): string => `${keywords[k] ? `${keywords[k]} ` : ''}:>> ${segments[k]}`;
  let text = `${at(segments.length - 1)} = …;`;
  for (let k = segments.length - 2; k >= entered; k--) text = `${at(k)} { ${text} }`;
  return `\`${text}\` in ${effectiveQualifiedName(model, holders[entered]!)}`;
}

/**
 * The features whose `default` an asserted EQUATION would override, once per
 * revision — none since decision 14 was amended ({@link replaceableDefaults}):
 * the set holds only the defaults a typed assert may define, read nowhere. An
 * equation would hold a feature where it, of its owner or of a general type of
 * its owner, defines its effective name — or one of a feature it redefines,
 * under that feature's name: Q's `assert { L == 5.0 }` holds q's `:>> L
 * default = 9.0` too (HR). The equation is the LOCAL rule only; one written in
 * an enclosing context (`part q1 : Q { assert { p.x == 50.0 } }`) is read per
 * instance (S3).
 *
 * The equation defines the default's feature only where its other side has
 * a value of its own that does not read that feature back: a name-free side,
 * or one whose every name is a feature with a value (`=`, or a `default`),
 * not the feature itself, and whose value reads none of it in turn. Where the other side reads a feature with no value,
 * the equation defines THAT feature from the default, as it always did (`L
 * == M`, M valueless: M = L's default). Two defaults an equation sets equal
 * (`L == K`) each give way, so neither is read: the value is undecided (U7).
 * An inequality defines nothing, and the default stands (U5): the assert is
 * checked against it. A plain `=` value never gives way: against an assert
 * that contradicts it, it is the strict-KerML contradiction (decision 1).
 */
function assertHeld(model: Model): ReadonlySet<ElementId> {
  return assertHeldIndex(model).held;
}

/**
 * The assert typed by a constraint definition whose body holds an equation that
 * may define `f` — a `default` it holds ({@link assertHeld}), or a feature it
 * names that states no value — or a feature `f` redefines, up to the first
 * that states a value: the one a sentence names ({@link typedAssertNames}).
 * `undefined` where none does, or where `f`, or a feature on the way, states
 * a value written with `=`, which gives way to nothing.
 */
export function typedAssertHolding(model: Model, f: ElementRecord): ElementRecord | undefined {
  const { typedBy } = assertHeldIndex(model);
  if (typedBy.size === 0) return undefined;
  for (const g of [f, ...redefinedClosure(model, f)]) {
    const a = typedBy.get(g.id);
    if (a) return a;
    if (g.attrs.value !== undefined && g.attrs.value !== null) return undefined;
  }
  return undefined;
}

/**
 * Is `f` itself a feature an assert typed by an equation's definition may
 * define ({@link typedAssertHolding})? The numeric surface reads such a
 * feature as no design freedom: the model states what it is, and nothing here
 * reads the equation that does.
 */
export function typedAssertNames(model: Model, f: ElementRecord): boolean {
  return assertHeldIndex(model).typedBy.has(f.id);
}

/** Does any assert typed by an equation's definition name a feature it may define ({@link typedAssertNames})? */
export function typedAssertsName(model: Model): boolean {
  return assertHeldIndex(model).typedBy.size > 0;
}

/** {@link assertHeld}, with what the typed asserts may define ({@link typedAssertHolding}), once per revision. */
function assertHeldIndex(model: Model): NonNullable<ReturnType<typeof ASSERT_HELD.get>> {
  const hit = ASSERT_HELD.get(model);
  if (hit && hit.rev === model.rev) return hit;
  const held = new Set<ElementId>();
  const typedBy = new Map<ElementId, ElementRecord>();
  const owners = new Set<ElementId>();
  const defaults: ElementRecord[] = [];
  // The asserts typed by a constraint definition whose body holds an equation
  // (CD1's `assert constraint e : Eq { in a = L; }` over Eq's `a == 50.0`; one in
  // a conjunction, `a == 50.0 and a >= 0.0`, too), or a body this tool cannot
  // parse — each with the definitions that make it one. An inequality alone
  // defines nothing (U5).
  const typedAsserts: Array<{ a: ElementRecord; types: ElementRecord[] }> = [];
  // The local rule reads only the defaults an assertion may replace: none ({@link replaceableDefaults}).
  const replaceable = replaceableDefaults(model);
  for (const el of model.all()) {
    if (el.attrs.isLibrary === true) continue;
    if (isAsserted(el) && el.ownerId != null) {
      owners.add(el.ownerId);
      const types = generalizationsOf(model, el.id).filter((t) => {
        if (t.attrs.isLibrary === true || typeof t.attrs.expression !== 'string' || t.attrs.expression.trim() === '') return false;
        const node = parseRelationBody(t.attrs.expression.trim())?.node;
        return node === undefined || holdsEquation(node);
      });
      if (types.length > 0) typedAsserts.push({ a: el, types });
    } else if (el.attrs.defaultValue === true && el.attrs.value !== undefined && el.attrs.value !== null && replaceable.has(el.id)) defaults.push(el);
  }
  const named = new Map<ElementId, ReadonlyMap<string, ElementRecord>>();
  const featuresOf = (ownerId: ElementId): ReadonlyMap<string, ElementRecord> => {
    let m = named.get(ownerId);
    if (!m) {
      const byName = new Map<string, ElementRecord>();
      for (const h of [...ownFeatures(model, ownerId), ...effectiveFeatures(model, ownerId)]) {
        const n = effectiveNameOf(model, h);
        if (n !== undefined && !byName.has(n)) byName.set(n, h);
      }
      named.set(ownerId, (m = byName));
    }
    return m;
  };
  // What such an assert may define, fail-closed (decision 14: an asserted
  // equation overrides a default): every feature a name in it reads — each value
  // it gives a parameter (`in a = L`, `in a = p.load`, `in a = q.L` in a
  // package), resolved from the element that owns the assert, bare or dotted,
  // each feature it binds one to (`bind a = L;`), and each name its
  // definition's body, or a value it gives a parameter, reads that is no
  // parameter of it — with
  // the features that one redefines, up to the first stating a value, and the
  // features that redefine it (an instance's own `:>> L default = 9.0`, or
  // `:>> L;`). No surface reads such an equation: a `default` among them gives
  // way, read nowhere — never as the default it overrides (CD1 read L's 1, and
  // `L == 50.0` was refuted on all four surfaces) — and one that states no value
  // is no design freedom ({@link typedAssertNames}). A value written with `=`
  // gives way to nothing, and is read as written. By FEATURE, in every instance
  // that reads it: an assert in a usage over its type's default (`part q : Q {
  // assert constraint e : Eq { in a = L; } }`) holds Q's L in every Q — weaker
  // than reading q's alone, never false.
  const typedTargets = new Map<ElementId, ElementRecord>();
  if (typedAsserts.length > 0) {
    let redefining: Map<ElementId, ElementRecord[]> | undefined;
    const redefinersOf = (id: ElementId): readonly ElementRecord[] => {
      if (!redefining) {
        redefining = new Map();
        for (const x of model.all()) {
          if (x.attrs.isLibrary === true || x.attrs.implicit === true || !isUsage(x.eClass)) continue;
          for (const g of redefinedClosure(model, x)) {
            const list = redefining.get(g.id);
            if (list) list.push(x);
            else redefining.set(g.id, [x]);
          }
        }
      }
      return redefining.get(id) ?? [];
    };
    const stated = (g: ElementRecord): boolean => g.attrs.value !== undefined && g.attrs.value !== null;
    const target = (f: ElementRecord, a: ElementRecord): void => {
      for (const g of [f, ...redefinedClosure(model, f)]) {
        if (stated(g) && g.attrs.defaultValue !== true) break;
        if (g.attrs.isLibrary !== true && !typedTargets.has(g.id)) typedTargets.set(g.id, a);
        if (stated(g)) break;
      }
      for (const x of redefinersOf(f.id)) {
        if ((!stated(x) || x.attrs.defaultValue === true) && !typedTargets.has(x.id)) typedTargets.set(x.id, a);
      }
    };
    const resolve = (from: ElementId, path: string): ElementRecord | undefined => {
      const [head, ...rest] = path.split('.');
      let h = featuresOf(from).get(head!);
      if (!h) {
        const r = resolveFullName(model, head!, from);
        h = r && isUsage(r.eClass) ? r : undefined;
      }
      for (const segment of rest) h = h && featuresOf(h.id).get(segment);
      return h;
    };
    // Every feature below `f`, for a body name read through a parameter whose
    // value names `f` where the rest of the name resolves to nothing there.
    const targetBelow = (f: ElementRecord, a: ElementRecord, seen = new Set<ElementId>()): void => {
      if (seen.has(f.id) || seen.size > 4096) return;
      seen.add(f.id);
      for (const g of featuresOf(f.id).values()) {
        target(g, a);
        targetBelow(g, a, seen);
      }
    };
    for (const { a, types } of typedAsserts) {
      // Where its parameters are given values: the assert, and each constraint
      // usage it specialises (`constraint e0 : Eq { in x = p.load; }` under
      // `assert constraint ea :> e0;`), each resolved from its own owner.
      const givers = [a, ...generalizationsOf(model, a.id).filter((g) => g.attrs.isLibrary !== true && isUsage(g.eClass) && g.ownerId != null)];
      // A feature of the assert's own, of a usage it specialises, or of its definitions: a parameter.
      const own = new Set([...givers.map((g) => g.id), ...types.map((t) => t.id)]);
      const parameter = (e: ElementRecord): boolean => {
        for (let cur: ElementRecord | undefined = e; cur; cur = cur.ownerId != null ? model.get(cur.ownerId) : undefined) {
          if (own.has(cur.id)) return true;
        }
        return false;
      };
      // What each parameter is given, by its name: the feature a path value
      // names, or a binding's end outside it — the nearest giver first.
      const given = new Map<string, ElementRecord | null>();
      const give = (name: string | undefined, f: ElementRecord | undefined): void => {
        if (name !== undefined && !given.has(name)) given.set(name, f ?? null);
      };
      for (const g of givers) {
        for (const c of model.children(g.id)) {
          // A parameter bound rather than valued (`bind a = L;`): the end outside it.
          if (isBindingConnector(c)) {
            const ends = [c.source?.[0], c.target?.[0]].map((id) => (id !== undefined ? model.get(id) : undefined));
            for (let i = 0; i < 2; i++) {
              const e = ends[i];
              if (!e || parameter(e)) continue;
              target(e, a);
              const p = ends[1 - i];
              if (p && parameter(p)) give(effectiveNameOf(model, p), e);
            }
            continue;
          }
          if (typeof c.attrs.value !== 'string') continue;
          for (const n of namesOfValue(c.attrs.value)) {
            const f = resolve(g.ownerId!, n);
            if (f) target(f, a);
          }
          const path = c.attrs.value.trim();
          give(effectiveNameOf(model, c), VALUE_PATH.test(path) ? resolve(g.ownerId!, path) : undefined);
        }
      }
      for (const t of types) {
        // Its body, and the values its definition gives its parameters itself (`in a = L;` in Eq).
        for (const c of model.children(t.id)) {
          const path = typeof c.attrs.value === 'string' ? c.attrs.value.trim() : undefined;
          if (path !== undefined) give(effectiveNameOf(model, c), VALUE_PATH.test(path) ? resolve(t.id, path) : undefined);
        }
        const values = model.children(t.id).flatMap((c) => (typeof c.attrs.value === 'string' ? namesOfValue(c.attrs.value) : []));
        for (const n of [...relationNamesOf(String(t.attrs.expression)), ...values]) {
          const [head, ...rest] = n.split('.');
          if (featuresOf(t.id).has(head!)) {
            // A name read through a parameter (`x.load` over `in x = p`) reads
            // what the parameter is given: p's load. Where that rest names
            // nothing there, or the value is no path, every feature below it.
            if (rest.length === 0 || !given.has(head!)) continue;
            const p = given.get(head!);
            if (!p) continue;
            let f: ElementRecord | undefined = p;
            for (const segment of rest) f = f && featuresOf(f.id).get(segment);
            if (f) target(f, a);
            else targetBelow(p, a);
            continue;
          }
          const f = resolve(t.id, n);
          if (f) target(f, a);
        }
      }
    }
  }
  if (owners.size > 0) {
    const parsed = new Map<ElementId, Map<string, DefiningEquation[]>>();
    const equationsOf = (ownerId: ElementId): Map<string, DefiningEquation[]> => {
      let m = parsed.get(ownerId);
      if (!m) parsed.set(ownerId, (m = equationsByName(model, ownerId)));
      return m;
    };
    // The other side has a value of its own that does not read `name` back,
    // through the values it reads in turn (`K = L; M = K * 2.0` beside `L ==
    // M` reads L back: the default stands, IND). A name with no value, a
    // dotted one, or a cycle is no value of its own.
    const valued = (ownerId: ElementId, eq: DefiningEquation, name: string): boolean => {
      const seen = new Map<string, boolean>();
      const independent = (n: string): boolean => {
        const hit = seen.get(n);
        if (hit !== undefined) return hit;
        seen.set(n, false);
        let answer = false;
        if (n !== name && !n.includes('.')) {
          const h = featuresOf(ownerId).get(n);
          const g = h && [h, ...redefinedClosure(model, h)].find((x) => x.attrs.value !== undefined && x.attrs.value !== null);
          const v = g?.attrs.value;
          answer = v !== undefined && v !== null && (typeof v !== 'string' || namesOfValue(v).every(independent));
          // A name the owner's owners declare (E3): a constant written with `=` is a value of its own.
          if (!h) answer = lexicalConstant(model, ownerId, n) !== undefined;
        }
        seen.set(n, answer);
        return answer;
      };
      return refsIn(eq.definition, eq.literals).every(independent);
    };
    for (const f of defaults) {
      const hit = [f, ...redefinedClosure(model, f)].some((g) => {
        const name = effectiveNameOf(model, g);
        if (name === undefined || g.ownerId == null) return false;
        return [g.ownerId, ...generalizationsOf(model, g.ownerId).map((t) => t.id)].some(
          (o) => owners.has(o) && (equationsOf(o).get(name) ?? []).some((eq) => valued(o, eq, name)),
        );
      });
      if (hit) held.add(f.id);
    }
  }
  // A typed assert holds what no equation this tool reads holds already: one
  // that does keeps its reading, as against a value written with `=`.
  for (const [id, a] of typedTargets) {
    if (held.has(id)) continue;
    typedBy.set(id, a);
    const f = model.get(id);
    if (f?.attrs.defaultValue === true) held.add(id);
  }
  const fresh = { rev: model.rev, held, typedBy };
  ASSERT_HELD.set(model, fresh);
  return fresh;
}

/** Does the parsed body `node` hold an equation (`==`, `=`) anywhere — a conjunct, an operand, an argument? */
function holdsEquation(node: unknown): boolean {
  if (node === null || typeof node !== 'object') return false;
  const n = node as { kind?: unknown; op?: unknown };
  if (n.kind === 'binary' && (n.op === '==' || n.op === '=')) return true;
  return Object.values(node).some((v) => (Array.isArray(v) ? v.some(holdsEquation) : holdsEquation(v)));
}

/**
 * The attribute a bare name `n` reads in `contextId` through the owners of the
 * element that writes it (E3, {@link DefiningEquations.lexicalFeature}), where
 * it is a CONSTANT written with `=` — a number, a boolean, or an expression
 * that parses and reads no name: a value of its own for an asserted equation
 * over a `default` ({@link assertHeld}, {@link enclosingAsserts}), LA4's
 * package `L = 50.0` for p's `x == L`. `undefined` for any other name.
 */
function lexicalConstant(model: Model, contextId: ElementId, n: string): ElementRecord | undefined {
  const definitions = sharedDefinitions(model);
  const f = definitions.lexicalFeature(contextId, n);
  if (!f || f.attrs.defaultValue === true) return undefined;
  // Only where the context's own scope reads the name as that feature: a unique feature nested below the
  // context answers it first (`part p : P` with P's `K`, beside the package's `K`: NX1), and that is read.
  if (definitions.denote(contextId).get(n)?.feature.id !== f.id) return undefined;
  const v = f.attrs.value;
  if (typeof v === 'number' || typeof v === 'boolean') return f;
  return typeof v === 'string' && !isQuoted(v.trim()) && parseRelationBody(v.trim()) && namesOfValue(v).length === 0 ? f : undefined;
}

/**
 * The asserted equations that define a `default` in the INSTANCES an element
 * stands for (H5's enclosing rule, plan J decision 14), once per revision:
 * per element that writes them, by the path — dotted or bare — each defines,
 * and the defaulted features those paths end at. `part q1 : Q { assert
 * constraint { p.x == 50.0 } }` over P's `x default = 2.0` makes q1's p's x
 * 50, while every other P keeps 2; so does the package's `assert constraint {
 * q1.p.x == 50.0 }`, and Q2's `p.x == 50.0` in every Q2 (`q1 : Q2`). An
 * equation whose other side is a value of its own — name-free, or over names
 * written with `=` that do not read the path back — gives it that value. One
 * whose other side reads a `default` (q1's `p.x == L` over q1's `L default =
 * 9.0`) gives it none: both defaults give way there and neither is read
 * (`undecided`, U7) — L's is filed under its own name. Never a dotted name on
 * the other side. One over a name the owner leaves valueless and usages value
 * with a literal (PIN2's `L == M`, p's `:>> M = 7.0`) defines the path in each
 * such instance alone (`framed`). Not past a feature a binding joins or a
 * part a value equates (`part r = s`) — a part a plain part-valued binding's
 * other end stands for (`bind pp = q.p`) is its own instance, and read past —
 * nor onto an end a binding joins: the binding's value is read there, and
 * the assert is checked against it (RB). Not past a reference or a subject,
 * nor past a part some usage redefines as one or with a value (`ref part :>>
 * r = p1`, `part :>> p = other`): the instance there may be another one
 * altogether, which no path below the frame reads. Where decision 14 makes
 * such an equation stand over a `default` this tool then does not read — the
 * binding's (RB3, RB5), the referenced instance's (RF) — it is an unread
 * source (`unreadAsserts`), and every reading it may change abstains. A bare
 * equation over a default the local rule already holds ({@link assertHeld})
 * is filed, for two values, but splits no instance.
 */
interface EnclosingAsserts {
  byOwner: ReadonlyMap<ElementId, ReadonlyMap<string, readonly DefiningEquation[]>>;
  /** Per owner and path, the feature each segment names — matched by identity where an instance renames one ({@link assertDefinitionsAt}). */
  chains: ReadonlyMap<ElementId, ReadonlyMap<string, readonly ElementId[]>>;
  features: ReadonlySet<ElementId>;
  /**
   * The asserted relations among them whose other side reads a `default`, with the names that read one:
   * where such a name still reads a `default` in the frame, they give no value ({@link assertDefinitionIn}).
   */
  undecided: ReadonlyMap<ElementId, readonly string[]>;
  /** The `default`s such a relation sets equal to the path's (q1's L, with what each redefines), by the element that writes it. */
  partners: ReadonlyMap<ElementId, ElementId>;
  /**
   * The asserted relations among them whose other side reads a name valued only in the usages that redefine
   * it (PIN2's `L == M`, p's `:>> M = 7.0`), with those names: they define the path only in a frame that gives
   * such a name a value ({@link assertDefinitionsAt}); in any other, the equation defines that name from the
   * path's `default`, which stands (invariant (e)).
   */
  framed: ReadonlyMap<ElementId, readonly string[]>;
  /**
   * The asserted equations that, under decision 14, give a `default` a value
   * this tool does not read ({@link equatedParts} reads each as an unread
   * source, `unread-binding`): by the relation, the features whose readings
   * it may change and the sentence that says why. RB3's package `q.p.x ==
   * 3.0` over q's `L default = 4.0` that `bind p.x = L` carries — wherever
   * such a binding is written, at the path's slot in some instance; RF's Q's
   * `r.x == 50.0`, which q's `ref part :>> r = p1` makes p1's; one that sets
   * the path equal to a `default` a binding joins; and one over a name valued
   * in some usage by an expression over other names (PIN2's shape, `:>> M =
   * K`), or joined to a value by a binding (`bind M = K`).
   */
  unreadAsserts: ReadonlyMap<ElementId, { constraint: ElementRecord; taint: readonly ElementRecord[]; why: string }>;
  /**
   * Each such path read from the element that writes it: the features it
   * passes through (`through`, with what each redefines and what redefines
   * it — q's `part pp :>> p`) and the one it ends at (`end`, likewise) — the
   * usages whose instances it reads otherwise — and, for an equation over a
   * name valued only in usages (`framed`), those usages (`valuedBy`).
   */
  paths: ReadonlyArray<{ owner: ElementId; through: ReadonlySet<ElementId>; end: ReadonlySet<ElementId>; valuedBy?: ReadonlySet<ElementId> }>;
  /** {@link assertHeldEverywhere} per feature, when first asked. */
  everywhere: Map<ElementId, boolean>;
}

const ENCLOSING_ASSERTS = new WeakMap<Model, { rev: number; index: EnclosingAsserts }>();

function enclosingAsserts(model: Model): EnclosingAsserts {
  const hit = ENCLOSING_ASSERTS.get(model);
  if (hit && hit.rev === model.rev) return hit.index;
  const byOwner = new Map<ElementId, Map<string, DefiningEquation[]>>();
  const chains = new Map<ElementId, Map<string, ElementId[]>>();
  const features = new Set<ElementId>();
  const undecided = new Map<ElementId, string[]>();
  const framed = new Map<ElementId, string[]>();
  const framedNames = new Map<DefiningEquation, string[]>();
  // The usages that value such a name, per equation: the frames below which it defines the path ({@link
  // assertedBelow}).
  const framedBy = new Map<DefiningEquation, ElementRecord[]>();
  // A name valued only in usages, one of which values it with an expression over other names — or a valueless
  // name a binding joins to a value (`binding`): what gives it the value this rule does not read, per equation.
  const framedUnsure = new Map<DefiningEquation, { name: string; by: ElementRecord; binding?: ElementRecord }>();
  const unreadAsserts = new Map<ElementId, { constraint: ElementRecord; taint: ElementRecord[]; why: string }>();
  const partnerOf = new Map<ElementId, ElementId>();
  const paths: Array<{ owner: ElementId; through: Set<ElementId>; end: Set<ElementId>; valuedBy?: ReadonlySet<ElementId> }> = [];
  const owners = new Set<ElementId>();
  // The definitions that write an assert, whatever the rule reads ({@link standingUnderInstance}).
  const assertOwners = new Set<ElementId>();
  const ends = new Set<ElementId>();
  const userBindings: ElementRecord[] = [];
  // Every path this rule files, and every equation it leaves unread, ends at a `default` an assertion would
  // replace, carries one, or sets one equal to another: with none it may replace ({@link replaceableDefaults}),
  // no owner is read and the index is empty — each default stands, read as written, and the assert is checked
  // against it as against a value written with `=`.
  const replaceable = replaceableDefaults(model);
  for (const el of model.all()) {
    if (isBindingConnector(el)) {
      if (el.attrs.isLibrary !== true && el.ownerId != null) userBindings.push(el);
      for (const id of [...(el.source ?? []), ...(el.target ?? [])]) ends.add(id);
    } else if (el.attrs.isLibrary !== true && isAsserted(el) && el.ownerId != null) {
      assertOwners.add(el.ownerId);
      if (replaceable.size > 0) owners.add(el.ownerId);
    }
  }
  // The user's usages by each feature they redefine, through any number of redefinitions — built when first asked.
  let redefining: Map<ElementId, ElementRecord[]> | undefined;
  const redefinersOf = (id: ElementId): readonly ElementRecord[] => {
    if (!redefining) {
      redefining = new Map();
      for (const x of model.all()) {
        if (x.attrs.isLibrary === true || !isUsage(x.eClass)) continue;
        for (const g of redefinedClosure(model, x)) {
          const list = redefining.get(g.id);
          if (list) list.push(x);
          else redefining.set(g.id, [x]);
        }
      }
    }
    return redefining.get(id) ?? [];
  };
  // A reference, a subject, or a part some usage redefines as one or with a value: another instance may stand there.
  const elsewhere = (h: ElementRecord): boolean =>
    [h, ...redefinedClosure(model, h)].some((g) => g.attrs.isRef === true || g.attrs.requirementRole === 'subject') ||
    redefinersOf(h.id).some((x) => x.attrs.isRef === true || (x.attrs.value !== undefined && x.attrs.value !== null));
  const named = new Map<ElementId, ReadonlyMap<string, ElementRecord>>();
  const featuresOf = (ownerId: ElementId): ReadonlyMap<string, ElementRecord> => {
    let m = named.get(ownerId);
    if (!m) {
      const byName = new Map<string, ElementRecord>();
      for (const h of [...ownFeatures(model, ownerId), ...effectiveFeatures(model, ownerId)]) {
        const n = effectiveNameOf(model, h);
        if (n !== undefined && !byName.has(n)) byName.set(n, h);
      }
      named.set(ownerId, (m = byName));
    }
    return m;
  };
  const valueOf = (h: ElementRecord): ElementRecord | undefined =>
    [h, ...redefinedClosure(model, h)].find((x) => x.attrs.value !== undefined && x.attrs.value !== null);
  // Not a part a plain part-valued binding's other end stands for (`bind pp = q.p`): q's p is its own instance.
  const { partnerEnds } = equatedParts(model);
  const bound = (h: ElementRecord): boolean => [h, ...redefinedClosure(model, h)].some((g) => ends.has(g.id) && !partnerEnds.has(g.id));
  const local = assertHeld(model);
  // The ends of the user's bindings whose component carries a `default` and no value written with `=`
  // ({@link bindsOnlyDefaults}), by each feature an end is or redefines — built when first asked.
  let defaultEnds: Map<ElementId, Array<{ b: ElementRecord; e: ElementRecord }>> | undefined;
  const defaultEndsOf = (f: ElementRecord): Array<{ b: ElementRecord; e: ElementRecord }> => {
    if (!defaultEnds) {
      defaultEnds = new Map();
      for (const b of userBindings) {
        for (const id of new Set([b.source?.[0], b.target?.[0]])) {
          const e = id !== undefined ? model.get(id) : undefined;
          if (!e || !bindsOnlyDefaults(model, e, (y) => replaceable.has(y.id))) continue;
          for (const g of [e, ...redefinedClosure(model, e)]) {
            const list = defaultEnds.get(g.id);
            if (list) list.push({ b, e });
            else defaultEnds.set(g.id, [{ b, e }]);
          }
        }
      }
    }
    const out = new Map<string, { b: ElementRecord; e: ElementRecord }>();
    for (const g of [f, ...redefinedClosure(model, f)]) for (const x of defaultEnds.get(g.id) ?? []) out.set(`${x.b.id} ${x.e.id}`, x);
    return [...out.values()];
  };
  // The feature each segment of `segments` names below `ownerId`, or `undefined` where one names none.
  const featuresAlong = (ownerId: ElementId, segments: readonly string[]): ElementRecord[] | undefined => {
    const out: ElementRecord[] = [];
    let cur = ownerId;
    for (const segment of segments) {
      const h = featuresOf(cur).get(segment);
      if (!h) return undefined;
      out.push(h);
      cur = h.id;
    }
    return out;
  };
  // Two features of one slot: one is, or redefines, the other, or both redefine a third (two end copies).
  const closureOf = (x: ElementRecord): ReadonlySet<ElementId> => new Set([x.id, ...redefinedClosure(model, x).map((g) => g.id)]);
  const sameSlot = (a: ElementRecord, b: ElementRecord): boolean => {
    const mine = closureOf(a);
    return [...closureOf(b)].some((id) => mine.has(id));
  };
  // Two elements some instance is both of: one, one redefining or specialising the other, two definitions
  // a third specialises (two usages of one type are two instances), or a usage and a definition that types
  // a usage redefining it — or a specialiser of that definition does (q2's `part :>> p : P2` makes q2's p,
  // an instance of Q's p, a P2).
  const sameInstance = (x: ElementRecord, y: ElementRecord): boolean => {
    if (x.id === y.id || sameSlot(x, y)) return true;
    if (generalizationsOf(model, x.id).some((t) => t.id === y.id) || generalizationsOf(model, y.id).some((t) => t.id === x.id)) return true;
    if (isUsage(x.eClass) !== isUsage(y.eClass)) {
      const [u, d] = isUsage(x.eClass) ? [x, y] : [y, x];
      if (!isDefinition(d.eClass)) return false;
      return redefinersOf(u.id).some((r) => generalizationsOf(model, r.id).some((t) => t.id === d.id));
    }
    if (!isDefinition(x.eClass) || !isDefinition(y.eClass)) return false;
    return sharedDefinitions(model).specialisersOf(x.id).some((s) => generalizationsOf(model, s.id).some((t) => t.id === y.id));
  };
  // Does the end `e` of binding `b` stand, in some instance, at the slot `chain` (the features a path read
  // from `o` names)? The two paths agree from their last segment back as far as the shorter goes, and what
  // the longer reads above that is an instance of what the shorter is read from: RB3's `q.p.x` from the
  // package and Q's binding at `p.x` (q is a Q); Q's `p.x` and q1's `bind p.x = K` (q1 is a Q), the
  // package's `bind q1.p.x = K`, or q1's `part :>> p { bind x = K; }` (it redefines Q's p). An end placed
  // nowhere this can read meets every slot.
  const meets = (b: ElementRecord, e: ElementRecord, o: ElementId, chain: readonly ElementRecord[]): boolean => {
    const at = b.ownerId!;
    const spelled = bindingEndPath(model, e.id, at);
    const mine = spelled !== undefined ? featuresAlong(at, spelled.split('.')) : undefined;
    if (!mine) return true;
    const k = Math.min(mine.length, chain.length);
    for (let i = 1; i <= k; i++) if (!sameSlot(mine[mine.length - i]!, chain[chain.length - i]!)) return false;
    const x = mine.length > k ? mine[mine.length - k - 1] : model.get(at);
    const y = chain.length > k ? chain[chain.length - k - 1] : model.get(o);
    return !x || !y || sameInstance(x, y);
  };
  // The other side's names, each a value written in `ownerId` (a `default` too) that reads `path` back
  // through no name it reads in turn — and the defaulted features among them, through `=` values too, but
  // for one the local rule holds (its equation's value). `undefined` where one is not (a dotted name, a
  // name with no value, a cycle). A bare name the owner's owners declare (E3) is a value of its own where
  // it is read there as a constant written with `=` ({@link lexicalConstant}); one they declare that is not
  // read so gives the path no value either (`unread`, filed as undecided: it abstains, LA1).
  const unread = new Map<DefiningEquation, string[]>();
  const valued = (ownerId: ElementId, eq: DefiningEquation, path: string): ElementRecord[] | undefined => {
    const seen = new Map<string, boolean>();
    const defaults: ElementRecord[] = [];
    const independent = (n: string): boolean => {
      const known = seen.get(n);
      if (known !== undefined) return known;
      seen.set(n, false);
      // Not a name the owner's scope reads as a feature nested below it (`part r : R` with R's `K`, beside
      // the package's `K`: NX4): it gives the path no value of its own.
      const scoped = !n.includes('.') ? sharedDefinitions(model).denote(ownerId).get(n) : undefined;
      const lexical = scoped === undefined || scoped.feature.id === sharedDefinitions(model).lexicalFeature(ownerId, n)?.id;
      if (n !== path && !n.includes('.') && !featuresOf(ownerId).has(n) && lexical) {
        const outer = lexicalConstant(model, ownerId, n) !== undefined || resolveFullName(model, n, ownerId) !== undefined;
        if (outer && lexicalConstant(model, ownerId, n) === undefined) unread.set(eq, [...(unread.get(eq) ?? []), n]);
        seen.set(n, outer);
        return outer;
      }
      const h = n !== path && !n.includes('.') ? featuresOf(ownerId).get(n) : undefined;
      const g = h && valueOf(h);
      // With no value where it is written, but an end of a binding whose component has one — the name
      // itself, a feature it redefines, or a usage's copy of it (p2's `bind M = K`, or the package's `bind
      // p2.M = K`): a value of its own in those instances that this rule does not read (it read L's default
      // there, and the binding's 9 against it as a violation). Unsure, as an expression over names is.
      const joined =
        h !== undefined && g === undefined
          ? [h, ...redefinedClosure(model, h), ...redefinersOf(h.id)].find(
              (x) => ends.has(x.id) && [...joinedTo(model, x.id)].some((id) => id !== x.id && model.get(id) !== undefined && valueOf(model.get(id)!) !== undefined),
            )
          : undefined;
      if (joined !== undefined) {
        const binding = userBindings.find((b) => b.source?.[0] === joined.id || b.target?.[0] === joined.id);
        if (!framedUnsure.has(eq)) framedUnsure.set(eq, { name: n, by: joined, ...(binding ? { binding } : {}) });
        seen.set(n, false);
        return false;
      }
      // Valued only in the usages that redefine it (PIN2: P's `L == M` with p's `:>> M = 7.0`): a value of
      // its own in each of those instances, none in the owner's — read in the frame (`unread`, filed as
      // undecided: the owner's own instance, and one that gives it a `default`, abstain; p's L is 7).
      const valuing = h !== undefined && g === undefined ? redefinersOf(h.id).filter((x) => x.attrs.value !== undefined && x.attrs.value !== null) : [];
      if (valuing.length > 0) {
        // Each a literal, or a `default` (U7 in that frame): an expression over names may read the path back.
        const other = valuing.find((x) => {
          const xv = x.attrs.value;
          if (x.attrs.defaultValue === true || typeof xv === 'number' || typeof xv === 'boolean') return false;
          return !(typeof xv === 'string' && !isQuoted(xv.trim()) && parseRelationBody(xv.trim()) && namesOfValue(xv).length === 0);
        });
        if (other !== undefined) {
          if (!framedUnsure.has(eq)) framedUnsure.set(eq, { name: n, by: other });
          seen.set(n, false);
          return false;
        }
        unread.set(eq, [...(unread.get(eq) ?? []), n]);
        framedNames.set(eq, [...(framedNames.get(eq) ?? []), n]);
        framedBy.set(eq, [...(framedBy.get(eq) ?? []), ...valuing]);
        seen.set(n, true);
        return true;
      }
      const v = g?.attrs.value;
      const answer = g !== undefined && v !== undefined && v !== null && (typeof v !== 'string' || namesOfValue(v).every(independent));
      // A `default` no assertion may replace is a value of its own, as one written with `=` is.
      if (answer && g.attrs.defaultValue === true && !local.has(g.id) && replaceable.has(g.id)) defaults.push(h!);
      seen.set(n, answer);
      return answer;
    };
    return refsIn(eq.definition, eq.literals).every(independent) ? defaults : undefined;
  };
  const file = (
    o: ElementId,
    path: string,
    equations: readonly DefiningEquation[],
    end: ElementRecord,
    through: Set<ElementId>,
    chain: readonly ElementId[],
  ): void => {
    let m = byOwner.get(o);
    if (!m) byOwner.set(o, (m = new Map()));
    const list = m.get(path);
    if (list) list.push(...equations.filter((eq) => !list.includes(eq)));
    else m.set(path, [...equations]);
    let c = chains.get(o);
    if (!c) chains.set(o, (c = new Map()));
    c.set(path, [...chain]);
    // A bare name the local rule holds already is read by its equation everywhere: no instance of its own.
    if (!path.includes('.') && local.has(valueOf(end)!.id)) return;
    const closure = new Set([end, ...redefinedClosure(model, end)].map((g) => g.id));
    for (const id of closure) features.add(id);
    // What redefines the path's own features — never a sibling's redefinition of what they redefine.
    const read = new Set(closure);
    for (const x of redefinersOf(end.id)) read.add(x.id);
    for (const id of chain.slice(0, -1)) for (const x of redefinersOf(id)) through.add(x.id);
    const by = equations.flatMap((eq) => framedBy.get(eq) ?? []);
    paths.push({ owner: o, through, end: read, ...(by.length > 0 ? { valuedBy: new Set(by.map((x) => x.id)) } : {}) });
  };
  for (const o of owners) {
    const byName = equationsByName(model, o);
    for (const [path, equations] of byName) {
      let read = equations.map((eq) => ({ eq, defaults: valued(o, eq, path) })).filter((r) => r.defaults !== undefined);
      const unsure = equations.filter((eq) => framedUnsure.has(eq));
      if (read.length === 0 && unsure.length === 0) continue;
      // The feature the path ends at, read from `o` segment by segment.
      let end: ElementRecord | undefined;
      let cur: ElementId = o;
      const through = new Set<ElementId>();
      const chain: ElementId[] = [];
      const segments = path.split('.');
      // Where the walk stopped short of a path it would read: a binding's end, or a feature that stands for another instance.
      let stopped: { h: ElementRecord; at: number; kind: 'bound' | 'elsewhere' } | undefined;
      for (const [i, segment] of segments.entries()) {
        const h = featuresOf(cur).get(segment);
        if (!h) break;
        if (bound(h)) {
          stopped = { h, at: i, kind: 'bound' };
          break;
        }
        chain.push(h.id);
        if (i === segments.length - 1) end = h;
        else if (valueOf(h) !== undefined || elsewhere(h)) {
          stopped = { h, at: i, kind: 'elsewhere' };
          break;
        } else for (const g of [h, ...redefinedClosure(model, h)]) through.add(g.id);
        cur = h.id;
      }
      // Decision 14 gives the `default` the path ends at a value this tool does not read: an unread source
      // of its own (`unread-binding`), every reading it may change left undecided.
      const lastOf = (h: ElementRecord, at: number): ElementRecord | undefined => {
        let x: ElementRecord | undefined = h;
        for (const segment of segments.slice(at + 1)) x = x && featuresOf(x.id).get(segment);
        return x;
      };
      const defaultEnd = (x: ElementRecord | undefined): boolean => {
        const v = x !== undefined ? valueOf(x) : undefined;
        return v !== undefined && v.attrs.defaultValue === true && replaceable.has(v.id);
      };
      const refuse = (eqs: readonly DefiningEquation[], taint: ElementRecord[], why: (eq: DefiningEquation) => string): void => {
        for (const eq of eqs) {
          if (!unreadAsserts.has(eq.constraint.id)) unreadAsserts.set(eq.constraint.id, { constraint: eq.constraint, taint, why: why(eq) });
        }
      };
      const said = (eq: DefiningEquation): string =>
        `the asserted \`${String(eq.constraint.attrs.expression ?? '').trim()}\` in ${effectiveQualifiedName(model, o)}`;
      if (stopped && read.length > 0 && stopped.kind === 'elsewhere' && defaultEnd(lastOf(stopped.h, stopped.at))) {
        const { h } = stopped;
        const standing = [h, ...redefinersOf(h.id)];
        const partners = standing.flatMap((x) =>
          typeof x.attrs.value === 'string' ? valuePartners(model, x, x.attrs.value.trim()).map((v) => v.partner) : [],
        );
        const name = effectiveNameOf(model, h) ?? h.id;
        refuse(read.map((r) => r.eq), [...new Set([...standing, ...partners])], (eq) =>
          `${said(eq)} defines ${path} through ${name}, a reference, a subject or a part a value equates, which may stand ` +
          'for another instance there: under decision 14 the equation stands over that instance\'s `default`, and this tool ' +
          'does not read an asserted equation through such a feature');
      }
      // An end of a binding whose component carries only `default`s, standing at the path's slot in some
      // instance — wherever the binding is written ({@link meets}): RB3's package `q.p.x == 3.0` over Q's `bind
      // p.x = L` (L's `default = 4.0`), Q's `p.x == 50.0` over q1's `bind p.x = K`, the package's `bind
      // q1.p.x = K` or q1's `part :>> p { bind x = K; }`, Q2's `p.x == 3.0` over the binding of the Q it
      // specialises, P's `L == M` over q's `bind p.L = K`. The assert stands over the default the binding
      // carries (decision 14), which the binding reading does not read: it read the default, and judged
      // the assert against it. Not one the binding reading reads itself ({@link endValue}): an equation of
      // the end's own feature under its own name in the element that declares it — the local rule's, over a
      // default it holds (GA6's P's `load == 7.0`, Q's `L == 5.0`) or over a feature with no value (AMD's `L
      // == 1.0`) — or of the element that owns the end (GA5B's a1's `v == 3.0`); nor a package's binding on
      // a definition's feature (w4), which reads an asserted equation that fixes an instance's slot itself
      // ({@link DefinitionHead.fixed}: W4X5's `p2.load == 5.0`).
      const full = read.length > 0 ? featuresAlong(o, segments) : undefined;
      if (full !== undefined) {
        const readByBinding = (b: ElementRecord, e: ElementRecord): boolean => {
          const holder = b.ownerId != null ? model.get(b.ownerId) : undefined;
          const owner = e.ownerId != null ? model.get(e.ownerId) : undefined;
          if (holder && isPackage(holder) && owner && isDefinition(owner.eClass)) return true;
          if (path.includes('.')) return false;
          const own = [e, ...redefinedClosure(model, e)].find((g) => g.ownerId === o && effectiveNameOf(model, g) === path);
          if (!own) return false;
          const v = valueOf(e);
          return own === e || v === undefined || local.has(v.id);
        };
        const hit = defaultEndsOf(full[full.length - 1]!).find(({ b, e }) => !readByBinding(b, e) && meets(b, e, o, full));
        if (hit) {
          const at = hit.b.ownerId!;
          const ends = [hit.b.source?.[0], hit.b.target?.[0]].map((id) => (id !== undefined ? (bindingEndPath(model, id, at) ?? '…') : '…'));
          refuse(read.map((r) => r.eq), [hit.e], (eq) =>
            `${said(eq)} defines ${path}, which \`bind ${ends[0]} = ${ends[1]}\` in ${effectiveQualifiedName(model, at)} joins to a ` +
            '`default` there: under decision 14 the equation stands over the default the binding carries, and this tool does ' +
            'not read an asserted equation through a binding\'s end');
        }
      }
      const holder = end && valueOf(end);
      if (!holder || holder.attrs.defaultValue !== true || !replaceable.has(holder.id)) continue;
      for (const eq of unsure) {
        const { name, by, binding } = framedUnsure.get(eq)!;
        const at = binding?.ownerId != null ? binding.ownerId : undefined;
        refuse([eq], [holder, ...redefinersOf(holder.id), ...(binding ? [by] : [])], () =>
          binding && at !== undefined
            ? `${said(eq)} defines ${path} where ${name} has a value, and \`bind ${bindingEndPath(model, binding.source?.[0], at) ?? '…'} = ` +
              `${bindingEndPath(model, binding.target?.[0], at) ?? '…'}\` in ${effectiveQualifiedName(model, at)} gives ${name} one: ` +
              'this tool reads such an equation in an instance only over a literal value, never one a binding carries'
            : `${said(eq)} defines ${path} in each instance that gives ${name} a value of its own, and ` +
              `${effectiveQualifiedName(model, by.ownerId!)}'s \`${name} = ${String(by.attrs.value).trim()}\` reads other names: ` +
              'this tool reads such an equation in an instance only over a literal value');
      }
      if (read.length === 0) continue;
      // Over a `default` the other side reads, the equation gives no value (U7): that default gives way
      // with this one — unless a binding joins it, whose value is read (the equation then stays unread).
      // A bare name the local rule holds keeps its reading (`L == 2.0 * K`: L is twice K's default).
      if (!path.includes('.') && local.has(holder.id)) read = read.filter((r) => r.defaults!.length === 0 && !unread.has(r.eq));
      if (read.length === 0) continue;
      const partners = read.flatMap((r) => r.defaults!);
      if (partners.some(bound)) {
        refuse(read.map((r) => r.eq), [end!, ...partners], (eq) =>
          `${said(eq)} sets ${path} equal to a \`default\` a binding joins: this tool does not read which of them stands`);
        continue;
      }
      for (const r of read) {
        const inFrame = framedNames.get(r.eq);
        if (inFrame !== undefined) framed.set(r.eq.constraint.id, [...new Set([...(framed.get(r.eq.constraint.id) ?? []), ...inFrame])]);
        const names = undecided.get(r.eq.constraint.id) ?? [];
        for (const n of unread.get(r.eq) ?? []) if (!names.includes(n)) names.push(n);
        if (names.length > 0) undecided.set(r.eq.constraint.id, names);
        if (r.defaults!.length === 0) continue;
        for (const h of r.defaults!) {
          const n = effectiveNameOf(model, h);
          if (n !== undefined && !names.includes(n)) names.push(n);
        }
        undecided.set(r.eq.constraint.id, names);
      }
      file(o, path, read.map((r) => r.eq), end!, through, chain);
      for (const h of partners) {
        const n = effectiveNameOf(model, h);
        if (n === undefined) continue;
        const own = (byName.get(n) ?? []).filter((eq) => undecided.has(eq.constraint.id));
        file(o, n, own.length > 0 ? own : read.filter((r) => r.defaults!.includes(h)).map((r) => r.eq), h, new Set(), [h.id]);
        for (const g of [h, ...redefinedClosure(model, h)]) if (!partnerOf.has(g.id)) partnerOf.set(g.id, o);
      }
    }
  }
  standingUnderInstance(model, assertOwners, userBindings, featuresAlong, meets, unreadAsserts);
  const index: EnclosingAsserts = { byOwner, chains, features, undecided, partners: partnerOf, framed, unreadAsserts, paths, everywhere: new Map() };
  ENCLOSING_ASSERTS.set(model, { rev: model.rev, index });
  return index;
}

/**
 * The asserted equations of a DEFINITION whose path, in an instance of it, is
 * an end of a binding written in that instance — in it, below it, or on a
 * path through it — whose component carries only `default`s (RB5: Q's `assert
 * constraint tie { p.x == 50.0 }`, q1's `bind p.x = K` beside q1's `K default
 * = 9.0`; RB5C's in q1's `part :>> p`, RB5D's the package's `bind q1.p.x =
 * K`, RB5F's W's `bind q1.p.x = K` for W's `part q1 : Q`), each an unread
 * source (`unreadAsserts`): every reading the binding's end may change
 * abstains, the definition's own reading of the assert too. K's default stands
 * against the assert (decision 14 amended), so q1's p.x is 9 and the assert is
 * violated at q1. Only where this tool does NOT read the assert at q1: an
 * instance a binding gives a value this tool reads is a context the assert is
 * read in ({@link DefiningEquations.valuedByBinding}), where its row says
 * whether it holds — violated, the model contradicts itself — and the defaults
 * the binding carries are read as they stand. What is left is the component
 * that gives q1 no value (`defaults-differ`, `two-values`, `free`, a cap): the
 * assert is not read there, the model may contradict itself unreported, and
 * every reading the binding's end may change abstains. An assert
 * written above or beside the binding — the package's `q.p.x == 3.0` over Q's
 * binding (RB3, RB4), a specialiser's or a usage's of the binding's owner
 * (RBS1, RBS5) — reads the binding there, and is checked against the default.
 */
function standingUnderInstance(
  model: Model,
  assertOwners: ReadonlySet<ElementId>,
  userBindings: readonly ElementRecord[],
  featuresAlong: (ownerId: ElementId, segments: readonly string[]) => ElementRecord[] | undefined,
  meets: (b: ElementRecord, e: ElementRecord, o: ElementId, chain: readonly ElementRecord[]) => boolean,
  unreadAsserts: Map<ElementId, { constraint: ElementRecord; taint: ElementRecord[]; why: string }>,
): void {
  if (userBindings.length === 0) return;
  // The ends of the user's bindings whose component carries `default`s alone, by each feature an end is or redefines.
  let standingEnds: Map<ElementId, Array<{ b: ElementRecord; e: ElementRecord }>> | undefined;
  const standingEndsOf = (f: ElementRecord): Array<{ b: ElementRecord; e: ElementRecord }> => {
    if (!standingEnds) {
      standingEnds = new Map();
      for (const b of userBindings) {
        for (const id of new Set([b.source?.[0], b.target?.[0]])) {
          const e = id !== undefined ? model.get(id) : undefined;
          if (!e || !bindsOnlyDefaults(model, e, () => true)) continue;
          for (const g of [e, ...redefinedClosure(model, e)]) {
            const list = standingEnds.get(g.id);
            if (list) list.push({ b, e });
            else standingEnds.set(g.id, [{ b, e }]);
          }
        }
      }
    }
    const out = new Map<string, { b: ElementRecord; e: ElementRecord }>();
    for (const g of [f, ...redefinedClosure(model, f)]) for (const x of standingEnds.get(g.id) ?? []) out.set(`${x.b.id} ${x.e.id}`, x);
    return [...out.values()];
  };
  for (const o of assertOwners) {
    const owner = model.get(o);
    if (!owner || !isDefinition(owner.eClass) || isPackage(owner)) continue;
    // An instance of the definition: a usage it, or a definition that specialises it, types.
    const instanceOfOwner = (x: ElementRecord): boolean => isUsage(x.eClass) && generalizationsOf(model, x.id).some((t) => t.id === o);
    // The instance of the definition the binding is written in, below, or on a path through, or `undefined`.
    const underInstance = (b: ElementRecord, e: ElementRecord): ElementRecord | undefined => {
      for (let x = b.ownerId != null ? model.get(b.ownerId) : undefined; x; x = x.ownerId != null ? model.get(x.ownerId) : undefined) {
        if (instanceOfOwner(x)) return x;
      }
      const spelled = bindingEndPath(model, e.id, b.ownerId!);
      const along = spelled !== undefined ? featuresAlong(b.ownerId!, spelled.split('.')) : undefined;
      return along?.slice(0, -1).find(instanceOfOwner);
    };
    for (const [path, equations] of equationsByName(model, o)) {
      const full = featuresAlong(o, path.split('.'));
      if (!full) continue;
      // Not one the binding reading reads itself ({@link endValue}): an equation of the end's own feature under
      // its own name in the element that declares it (G340's Q's `L == 2.0 * K` over the package's `bind
      // r.q.p.load = r.q.L`: L has two values there, and the binding is reported), nor a package's binding on
      // a definition's feature (w4), which reads an asserted equation that fixes an instance's slot itself.
      const readByBinding = (b: ElementRecord, e: ElementRecord): boolean => {
        const holder = b.ownerId != null ? model.get(b.ownerId) : undefined;
        const declarer = e.ownerId != null ? model.get(e.ownerId) : undefined;
        if (holder && isPackage(holder) && declarer && isDefinition(declarer.eClass)) return true;
        if (path.includes('.')) return false;
        const own = [e, ...redefinedClosure(model, e)].find((g) => g.ownerId === o && effectiveNameOf(model, g) === path);
        if (!own) return false;
        const v = [e, ...redefinedClosure(model, e)].find((x) => x.attrs.value !== undefined && x.attrs.value !== null);
        return own === e || v === undefined;
      };
      const definitions = sharedDefinitions(model);
      const hit = standingEndsOf(full[full.length - 1]!).find(({ b, e }) => {
        if (readByBinding(b, e)) return false;
        const instance = underInstance(b, e);
        // An instance the assert is read in, at the value the binding carries (RB5): its row says whether it holds there.
        return instance !== undefined && meets(b, e, o, full) && !definitions.valuedByBinding(instance.id, o, [path], false);
      });
      if (!hit) continue;
      const at = hit.b.ownerId!;
      const sides = [hit.b.source?.[0], hit.b.target?.[0]].map((id) => (id !== undefined ? (bindingEndPath(model, id, at) ?? '…') : '…'));
      for (const eq of equations) {
        if (unreadAsserts.has(eq.constraint.id)) continue;
        unreadAsserts.set(eq.constraint.id, {
          constraint: eq.constraint,
          taint: [hit.e],
          why:
            `the asserted \`${String(eq.constraint.attrs.expression ?? '').trim()}\` in ${effectiveQualifiedName(model, o)} is not ` +
            `read where \`bind ${sides[0]} = ${sides[1]}\` in ${effectiveQualifiedName(model, at)} joins ${path} to a \`default\`, ` +
            'which no assertion replaces: the assert holds in that instance too, and this tool does not read it there, so ' +
            'the model may contradict itself unreported',
        });
      }
    }
  }
}

/**
 * Does the binding component the end `h` is in ({@link joinedTo}) carry a
 * `default` that `counts` and no other value — one written with `=`, or a
 * `default` it does not count (one no assertion may replace, where `counts`
 * is {@link replaceableDefaults}' membership)? An asserted equation on
 * RB3's q's p's x would stand over q's `L default = 4.0` that `bind p.x = L`
 * carries. Over a plain value (RB's `L = 4.0`), and over a default since
 * decision 14 was amended ({@link replaceableDefaults}), the binding's value
 * is read and the assert checked against it (decision 1).
 */
function bindsOnlyDefaults(model: Model, h: ElementRecord, counts: (y: ElementRecord) => boolean): boolean {
  let stated = false;
  for (const g of [h, ...redefinedClosure(model, h)]) {
    for (const id of joinedTo(model, g.id)) {
      const x = model.get(id);
      for (const y of x ? [x, ...redefinedClosure(model, x)] : []) {
        if (y.attrs.value === undefined || y.attrs.value === null) continue;
        if (y.attrs.defaultValue !== true || !counts(y)) return false;
        stated = true;
      }
    }
  }
  return stated;
}

/**
 * Does an asserted equation of an enclosing element define `f`'s `default` in
 * SOME instance ({@link enclosingAsserts})? Its value is then the instance's
 * own wherever it is read through one (its symbol is, {@link
 * DefiningEquations.pinnedIn}), and a generic reading that cannot key it per
 * instance reads no default there.
 */
export function assertHeldInSome(model: Model, f: ElementRecord): boolean {
  const { features } = enclosingAsserts(model);
  return features.size > 0 && [f, ...redefinedClosure(model, f)].some((g) => features.has(g.id));
}

/**
 * Does an asserted equation of an element enclosing `f`'s OWN declaration —
 * an owner up its containment, or a general type of one — define `f` there
 * ({@link enclosingAsserts})? Every instance `f` stands for is then such an
 * element's, and its `default` gives way in each — the feature's own reading
 * included ({@link defaultGivesWay}): q1's `part :>> p { attribute :>> x
 * default = 9.0; }` under q1's, or q1's type's, `p.x == 50.0` is 50 wherever
 * it is read, and no surface reads its 9 (U7's Q3). P's own x is no such
 * feature: P's own instance has no frame that asserts it.
 */
function assertHeldEverywhere(model: Model, f: ElementRecord): boolean {
  if (!assertHeldInSome(model, f)) return false;
  const index = enclosingAsserts(model);
  const hit = index.everywhere.get(f.id);
  if (hit !== undefined) return hit;
  let answer = false;
  let path = effectiveNameOf(model, f);
  const seen = new Set<ElementId>();
  for (let cur: ElementRecord | undefined = f; path !== undefined && cur?.ownerId != null && !answer; ) {
    const owner = model.get(cur.ownerId);
    if (!owner || owner.attrs.isLibrary === true || seen.has(owner.id)) break;
    seen.add(owner.id);
    const at = path;
    // Not one over a name valued only in some usages ({@link EnclosingAsserts.framed}): it defines `f` in those alone.
    answer = [owner.id, ...generalizationsOf(model, owner.id).map((t) => t.id)].some(
      (o) => index.byOwner.get(o)?.get(at)?.some((eq) => !index.framed.has(eq.constraint.id)) === true,
    );
    const n = effectiveNameOf(model, owner);
    path = n === undefined ? undefined : `${n}.${path}`;
    cur = owner;
  }
  index.everywhere.set(f.id, answer);
  return answer;
}

/** Does an asserted equation of the model set one `default` equal to another, both giving way (U7, {@link undecidedPartnerOf})? */
export function hasUndecidedPartners(model: Model): boolean {
  return enclosingAsserts(model).partners.size > 0;
}

/**
 * The element whose asserted equation sets `f`'s `default` equal to another
 * `default` (U7 Q4: q1's `p.x == L` over q1's `L default = 9.0` and P's `x
 * default = 2.0`), where `f`'s value is still such a default and gives way
 * wherever `f` is read ({@link assertHeldEverywhere}): both give way, so `f`
 * has no value, and that equation derives none for it either — it would read
 * the other side's default, the very one that gave way. `undefined` for any
 * other feature, and for one that states a plain value (H2E's q's `:>> L =
 * 50.0`), which is its own.
 */
export function undecidedPartnerOf(model: Model, f: ElementRecord): ElementId | undefined {
  const { partners } = enclosingAsserts(model);
  if (partners.size === 0) return undefined;
  const chain = [f, ...redefinedClosure(model, f)];
  if (chain.find((g) => g.attrs.value !== undefined && g.attrs.value !== null)?.attrs.defaultValue !== true) return undefined;
  if (!assertHeldEverywhere(model, f)) return undefined;
  for (const g of chain) {
    const o = partners.get(g.id);
    if (o !== undefined) return o;
  }
  return undefined;
}

/**
 * Does a model read a value per instance — a binding of the user's own
 * ({@link hasUserBindings}), or an asserted equation of an enclosing element
 * that defines a `default` in some instance ({@link enclosingAsserts})?
 */
export function readsPerInstance(model: Model): boolean {
  return hasUserBindings(model) || enclosingAsserts(model).features.size > 0;
}

/**
 * The element whose asserted equation defines, in some instance of the usage
 * `contextId`, a feature among `reads` — the path it defines passes through
 * the usage ({@link enclosingAsserts}): HE's q1, whose `p.x == 50.0` makes
 * q1's p read otherwise than Q's p does. `undefined` where none does. With
 * `own`, the usage may write the equation itself (a context whose own assert
 * changes what a relation of its type reads).
 */
function assertedThrough(model: Model, contextId: ElementId, reads: ReadonlySet<ElementId>, own = false): ElementRecord | undefined {
  const { paths } = enclosingAsserts(model);
  for (const p of paths) {
    if (!(p.through.has(contextId) || (own && p.owner === contextId))) continue;
    for (const id of p.end) if (reads.has(id)) return model.get(p.owner);
  }
  return undefined;
}

/**
 * The element at or below the context `contextId` — nested in it through
 * usages (one below a general type of it is that type's: a context of its
 * own) — whose asserted equation defines a
 * feature among `reads` ({@link enclosingAsserts}), or that values a name such
 * an equation reads only in the usages that value it (`valuedBy`, PIN2's
 * frames): what `contextId`'s instances read there is their own, where the
 * relation's owner `ownerId` (and what it specialises) reads it through no such
 * element. Q's `cq { p.L <= 6.0 }` over P's `L == M`, read in `q : Q { part
 * :>> p { attribute :>> M = 7.0; } }` (q's p's L is 7); W's `cw { pp.x <= 10.0
 * }` over `bind pp = q.p`, in `w : W { part :>> q { assert constraint { p.x
 * == 50.0 } } }`; Q's `p.load + p.extra <= 10.0` in `q2 : Q { part :>> p {
 * assert constraint { extra == 20.0 } } }`. Each read only Q's or W's own
 * value, and `sysml-check --strict` said OK.
 *
 * So is a usage at or below the context typed by a DEFINITION that writes such
 * an equation, or values such a name, where the owner's own reading of that
 * slot is not of that definition: `q : Q { part :>> p : P5; }`, P5 :> P with
 * `:>> M = 7.0` under P's `L == M` (q's p's L is 7, Q's p's 2), or P2 :> P
 * with `assert constraint { extra == 50.0 }` typing q2's p — directly, or
 * through a specialisation (`Q2 :> Q { part :>> p : P5; }`). The usage is
 * returned. `undefined` where none does.
 */
function assertedBelow(model: Model, contextId: ElementId, ownerId: ElementId, reads: ReadonlySet<ElementId>): ElementRecord | undefined {
  const { paths } = enclosingAsserts(model);
  if (paths.length === 0) return undefined;
  const owners = new Set([ownerId, ...generalizationsOf(model, ownerId).map((t) => t.id)]);
  const under = (id: ElementId): boolean => {
    const seen = new Set<ElementId>();
    for (let cur = model.get(id); cur && !seen.has(cur.id); cur = cur.ownerId != null ? model.get(cur.ownerId) : undefined) {
      seen.add(cur.id);
      if (owners.has(cur.id)) return false;
      if (cur.id === contextId) return true;
      if (cur.id !== id && !isUsage(cur.eClass)) return false;
    }
    return false;
  };
  // The definition that writes `id` — itself, or the nearest owner through usages — when it is none of the
  // owner's types: its instances read the equation, or the name it values, wherever a usage is typed by it.
  const writer = (id: ElementId): ElementRecord | undefined => {
    const seen = new Set<ElementId>();
    for (let cur = model.get(id); cur && !seen.has(cur.id); cur = cur.ownerId != null ? model.get(cur.ownerId) : undefined) {
      seen.add(cur.id);
      if (isDefinition(cur.eClass)) return owners.has(cur.id) || cur.attrs.isLibrary === true ? undefined : cur;
      if (!isUsage(cur.eClass)) return undefined;
    }
    return undefined;
  };
  const typing = new Set<ElementId>();
  for (const p of paths) {
    if (![...p.end].some((id) => reads.has(id))) continue;
    for (const at of [p.owner, ...(p.valuedBy ?? [])]) {
      if (under(at)) return model.get(at);
      const d = writer(at);
      if (d !== undefined) typing.add(d.id);
    }
  }
  if (typing.size === 0) return undefined;
  // Each usage at or below the context — its own and inherited features, through usages — against the
  // feature the owner reads at the same slot (`slot`, spelled from the owner; the owner itself for the
  // context): a definition among its types that the owner's slot is not of is the instance's own. A
  // feature the owner reads at no slot is no reading of the relation's. Past MAX_BELOW usages, or 32
  // segments deep, the context is listed whole: a context read per instance needlessly is still read.
  const MAX_BELOW = 4096;
  const context = model.get(contextId);
  const top = model.get(ownerId);
  if (!context || !top) return undefined;
  const stack: Array<{ u: ElementRecord; slot: ElementRecord; depth: number }> = [{ u: context, slot: top, depth: 0 }];
  // Each usage once per slot: one inherited along two paths is read against each.
  const seen = new Set<string>();
  while (stack.length > 0) {
    const { u, slot, depth } = stack.pop()!;
    if (seen.has(`${u.id} ${slot.id}`)) continue;
    seen.add(`${u.id} ${slot.id}`);
    if (seen.size > MAX_BELOW || depth > 32) return context;
    // Not the context's own types: such a definition specialises the owner, and is a context of its own.
    if (u.id !== contextId) {
      const theirs = new Set([slot.id, ...generalizationsOf(model, slot.id).map((t) => t.id)]);
      if (generalizationsOf(model, u.id).some((t) => typing.has(t.id) && !theirs.has(t.id))) return u;
    }
    // The owner's own feature, inherited unchanged: what lies below it is the owner's reading.
    if (u.id === slot.id) continue;
    const slotFeatures = effectiveFeaturesByName(model, slot.id);
    for (const h of [...ownFeatures(model, u.id), ...effectiveFeatures(model, u.id)]) {
      if (!isUsage(h.eClass)) continue;
      const n = effectiveNameOf(model, h);
      const there = n !== undefined ? slotFeatures.get(n) : undefined;
      if (there !== undefined && !seen.has(`${h.id} ${there.id}`)) stack.push({ u: h, slot: there, depth: depth + 1 });
    }
  }
  return undefined;
}

/** The effective features of `typeId` by effective name, the first of each name. */
function effectiveFeaturesByName(model: Model, typeId: ElementId): ReadonlyMap<string, ElementRecord> {
  const out = new Map<string, ElementRecord>();
  for (const h of [...ownFeatures(model, typeId), ...effectiveFeatures(model, typeId)]) {
    const n = effectiveNameOf(model, h);
    if (n !== undefined && !out.has(n)) out.set(n, h);
  }
  return out;
}

/** Is `el` an element whose asserted equation defines a `default` below it ({@link enclosingAsserts}), and that writes no binding? */
function assertFrameOnly(model: Model, el: ElementRecord): boolean {
  return enclosingAsserts(model).byOwner.has(el.id) && !bindingEnds(model).written.some((w) => w.holder === el.id);
}

/** One asserted equation an enclosing element writes that defines a value at an instance ({@link assertDefinitionsAt}). */
export interface AssertDefinition {
  /** The element that writes it: the frame's own, or a general type of it. */
  owner: ElementId;
  /** The path it defines, spelled below that frame. */
  path: string;
  equations: readonly DefiningEquation[];
  /** The frame it is read in: the instance enclosing the value, and the element read there. */
  frame: InstanceFrame;
}

/**
 * The asserted equations of the elements ENCLOSING the instance `symbol` —
 * each frame above it ({@link DefiningEquations.framesAbove}), its reader and
 * every general type of the reader — that define `symbol`'s path below that
 * frame, where `f` (the feature read there) states a `default` some such
 * equation overrides ({@link enclosingAsserts}): R1's `R1::q1::p::x` is
 * defined by q1's `assert constraint { p.x == 50.0 }`. `[]` where none does,
 * where `f` reads a plain value, and where a binding carries a value into the instance ({@link
 * boundSourceIn}), or one of its end copies lies on the path below a frame
 * (`part q1 : Q { bind p.x = K; }` under Q's `p.x == 50.0`): the binding's
 * value is read there, and the assert is checked against it (RB).
 */
export function assertDefinitionsAt(model: Model, f: ElementRecord, symbol: string): readonly AssertDefinition[] {
  if (!assertHeldInSome(model, f) || boundSourceMemo(model, symbol) !== undefined) return [];
  // Only a `default` gives way: a plain value read there (q's `:>> L = 50.0`) is its own (decision 1).
  const holder = [f, ...redefinedClosure(model, f)].find((g) => g.attrs.value !== undefined && g.attrs.value !== null);
  if (holder?.attrs.defaultValue !== true) return [];
  const { byOwner, chains, framed } = enclosingAsserts(model);
  const definitions = sharedDefinitions(model);
  const { ends } = bindingEnds(model);
  // One over a name valued only in some usages defines the path only in a frame that values it ({@link
  // EnclosingAsserts.framed}): PIN2's p and p2, never P's own instance, where it defines M from L's default.
  const valuedIn = (reader: ElementId, n: string): boolean => {
    const h = definitions.byName(reader).get(n);
    return h !== undefined && [h, ...redefinedClosure(model, h)].some((x) => x.attrs.value !== undefined && x.attrs.value !== null);
  };
  // A part a plain part-valued binding's other end stands for (SF's q's p under `bind pp = q.p`) is the
  // partner's own instance: no value of the pair reaches it, so an equation reads past it.
  const { partnerEnds } = equatedParts(model);
  const out: AssertDefinition[] = [];
  for (const frame of definitions.framesAbove(symbol) ?? []) {
    if (!symbol.startsWith(`${frame.instance}::`)) continue;
    const spelled = symbol.slice(frame.instance.length + 2).split('::').join('.');
    let cur: ElementId | undefined = frame.reader;
    const read: ElementRecord[] = [];
    for (const segment of spelled.split('.')) {
      const h: ElementRecord | undefined = cur === undefined ? undefined : definitions.byName(cur).get(segment);
      cur = h && ![h, ...redefinedClosure(model, h)].some((g) => ends.has(g.id) && !partnerEnds.has(g.id)) ? h.id : undefined;
      if (h) read.push(h);
    }
    if (cur === undefined) continue;
    // The path the owner writes as the instance spells it, or whose every segment is the feature the
    // instance reads there or one it redefines: q's `part pp :>> p` reads Q's `p.x == 50.0` at `pp.x`.
    const names = (id: ElementId, h: ElementRecord): boolean => h.id === id || redefinedClosure(model, h).some((g) => g.id === id);
    for (const owner of [frame.reader, ...generalizationsOf(model, frame.reader).map((t) => t.id)]) {
      for (const [path, chain] of chains.get(owner) ?? []) {
        if (path !== spelled && (chain.length !== read.length || !chain.every((id, k) => names(id, read[k]!)))) continue;
        const equations = byOwner.get(owner)?.get(path)?.filter((eq) => (framed.get(eq.constraint.id) ?? []).every((n) => valuedIn(frame.reader, n)));
        if (equations && equations.length > 0) out.push({ owner, path, equations, frame });
      }
    }
  }
  return out;
}

/**
 * The default a feature's own `default` gives way to a binding ({@link
 * defaultGivesWay}) — or gives way AT the instance `inst` because a held
 * redefinition of it falls through there (`held-redef`). `undefined` `inst`
 * answers the per-feature hold alone.
 */
export function defaultGivesWaySomewhere(model: Model, f: ElementRecord): boolean {
  if (f.attrs.defaultValue !== true) return false;
  const ends = bindingEnds(model);
  return ends.held.has(f.id) || ends.heldSomewhere.has(f.id) || assertHeld(model).has(f.id) || assertHeldEverywhere(model, f);
}

/**
 * The default a feature's own `default` gives way to a binding ({@link
 * defaultGivesWay}) — or gives way AT the instance `inst` because a held
 * redefinition of it falls through there (`held-redef`). `undefined` `inst`
 * answers the per-feature hold alone.
 */
export function defaultGivesWayIn(model: Model, f: ElementRecord, inst: string | undefined): boolean {
  if (f.attrs.defaultValue !== true) return false;
  const ends = bindingEnds(model);
  if (ends.held.has(f.id) || assertHeld(model).has(f.id) || assertHeldEverywhere(model, f)) return true;
  if (inst === undefined) return false;
  let answer = ends.heldIn.has(inst);
  if (!answer) {
    const name = effectiveNameOf(model, f);
    answer = name !== undefined && ends.heldIn.has(`${inst}::${name}`);
  }
  // An asserted equation of an element enclosing the instance defines it there (H5's enclosing rule).
  if (!answer) answer = assertDefinitionsIn(model, f, inst).length > 0;
  recording?.push({ kind: 'gives-way', feature: f, inst, answer });
  return answer;
}

/**
 * {@link assertDefinitionsAt} for `f` read at `inst` — the instance of its
 * owner (`R1::q1::p`) or its own (`R1::q1::p::x`), as {@link
 * defaultGivesWayIn} is asked either.
 */
export function assertDefinitionsIn(model: Model, f: ElementRecord, inst: string): readonly AssertDefinition[] {
  const name = effectiveNameOf(model, f);
  if (name === undefined || !assertHeldInSome(model, f)) return [];
  const below = assertDefinitionsAt(model, f, `${inst}::${name}`);
  return below.length > 0 || !inst.endsWith(`::${name}`) ? below : assertDefinitionsAt(model, f, inst);
}

/**
 * The ONE asserted equation of the elements enclosing the instance `inst`
 * that defines `f` there ({@link assertDefinitionsIn}): the equation, the
 * path it defines, the element that writes it and the frame it is read in —
 * a definition read in that frame, over the frame's own names. `{ abstain:
 * 'two-values' }` where such equations give it two values — two over names
 * read in two frames, or written by two elements, are two whatever their text
 * (q1's `p.x == M` reads q1's M, the package's `q1.p.x == M` the package's);
 * `{ abstain: 'defaults' }` where one sets it equal to another `default` and
 * both give way (U7); `undefined` where none defines it. A question of the
 * instance's spelling, recorded as one ({@link InstanceLookup}).
 */
export function assertDefinitionIn(
  model: Model,
  f: ElementRecord,
  inst: string,
):
  | { owner: ElementId; path: string; equation: DefiningEquation; frame: InstanceFrame; constant: boolean }
  | { abstain: 'two-values' | 'defaults'; owner: ElementId }
  | undefined {
  const defs = assertDefinitionsIn(model, f, inst);
  let answer: ReturnType<typeof assertDefinitionIn>;
  if (defs.length > 0) {
    const all = defs.flatMap((d) => d.equations.map((equation) => ({ owner: d.owner, path: d.path, equation, frame: d.frame })));
    const constant = (eq: DefiningEquation): boolean => refsIn(eq.definition, eq.literals).length === 0;
    const text = (d: (typeof all)[number]): string =>
      JSON.stringify([d.equation.definition, [...d.equation.literals], constant(d.equation) ? '' : `${d.owner} ${d.frame.instance}`]);
    const first = all[0]!;
    // One over a `default` gives no value where a name it reads still reads one in the frame — not in q,
    // whose `:>> L = 50.0` is read where Q's `p.load == L` meets Q's `L default = 1.0` (H2E).
    const { undecided, framed } = enclosingAsserts(model);
    const definitions = sharedDefinitions(model);
    const open = all.find((d) =>
      (undecided.get(d.equation.constraint.id) ?? []).some((n) => {
        // A name the writer's owners declare, read as no constant (E3): no value, whatever the frame has.
        if (!definitions.byName(d.owner).has(n)) return true;
        const h = definitions.byName(d.frame.reader).get(n);
        const g = h && [h, ...redefinedClosure(model, h)].find((x) => x.attrs.value !== undefined && x.attrs.value !== null);
        // A name valued only in usages that one gives a `default` (PIN3's p3, `:>> M default = 4.0`): two
        // defaults the equation sets equal, both giving way (U7) — though the local rule holds that one.
        const inFrame = (framed.get(d.equation.constraint.id) ?? []).includes(n);
        return g === undefined || (g.attrs.defaultValue === true && (inFrame || !assertHeld(model).has(g.id)));
      }),
    );
    answer = open
      ? { abstain: 'defaults', owner: open.owner }
      : all.some((d) => text(d) !== text(first))
        ? { abstain: 'two-values', owner: first.owner }
        : { ...first, constant: constant(first.equation) };
  }
  recording?.push({ kind: 'asserted', feature: f, inst, answer: assertedKey(answer) });
  return answer;
}

/**
 * {@link assertDefinitionIn}'s answer as a key: two answers with one key read
 * one value, or abstain alike — the frame's instance included, whose names an
 * equation over names reads.
 */
function assertedKey(answer: ReturnType<typeof assertDefinitionIn>): string {
  if (answer === undefined) return '';
  if ('abstain' in answer) return `${answer.abstain} ${answer.owner}`;
  return `${answer.owner} ${answer.path} ${answer.equation.constraint.id} ${answer.frame.instance}`;
}

/**
 * Do the defaults a binding component joins with no value of its own — one
 * per member, `sources` the features that write them ({@link heldDefaults})
 * — stand as ONE value in every instance they are read in?
 *  - One default stands: a binding into a feature with nothing of its own
 *    carries it, even an expression, read in that member's own instance.
 *  - Two or more agree only where each is a CONSTANT — a literal number with
 *    its unit, a boolean, or an expression that reads no name ({@link
 *    constantOf}) — and all compare the same exactly ({@link sameConstant}).
 *    Never by their text: R3a's one `v default = 2.0 * K`, read at a1.v and
 *    at a2.v where a2 sets K to 5, is 2 and 10; and R3c's P and Q each write
 *    `2.0 * K` over a K of their own.
 */
function defaultsAgree(sources: readonly ElementRecord[]): boolean {
  if (sources.length < 2) return true;
  const [first, ...rest] = sources;
  return rest.every((g) => sameConstant(first!, g));
}

/**
 * Do `a` and `b` write one CONSTANT value, compared exactly ({@link
 * defaultsAgree})? Two literal numbers as {@link compareQuantities} reads
 * them, two booleans as written, and otherwise two name-free expressions
 * ({@link compareConstants}); anything that reads a name is no constant.
 */
function sameConstant(a: ElementRecord, b: ElementRecord): boolean {
  const x = a.attrs.value;
  const y = b.attrs.value;
  if (typeof x === 'number' && typeof y === 'number') return compareQuantities(a, b) === 'same';
  if (typeof x === 'boolean' && typeof y === 'boolean') return x === y;
  const cx = constantOf(a);
  const cy = constantOf(b);
  return cx !== undefined && cy !== undefined && compareConstants(cx, cy) === 'same';
}

/**
 * Where an end of a binding written in `holder` is, for {@link heldDefaults}:
 *  - `below` the holder, at a path every context of it reads (`p.load` in `part
 *    q : Q { bind p.load = L; }`);
 *  - `global`: a feature of no definition — a package's, or a feature of one
 *    of its usages — one instance wherever it is read (a package's `attribute G
 *    = 2.0 * K` beside `part def Q { bind p.load = G; }`);
 *  - `enclosed` by an instance the holder is a feature of: the nearest owner
 *    of the holder the end is a feature of, through usages alone — R for R's
 *    `L` above — with the path below it, and the contexts that are such an
 *    instance (`within`: the owner and what specialises it);
 *  - `nowhere` this tool finds an instance of it.
 */
type EndPlace =
  | { kind: 'below'; path: string }
  | { kind: 'global' }
  | { kind: 'enclosed'; path: string; within: ReadonlySet<ElementId> }
  | { kind: 'nowhere' };

function endPlace(model: Model, end: ElementId, holder: ElementRecord): EndPlace {
  const below = bindingEndPath(model, end, holder.id);
  if (below !== undefined) return { kind: 'below', path: below };
  const seen = new Set<ElementId>();
  for (let cur = model.get(end); cur && !seen.has(cur.id); ) {
    seen.add(cur.id);
    const owner = cur.ownerId != null ? model.get(cur.ownerId) : undefined;
    if (!owner || isDefinition(owner.eClass)) break;
    if (!isUsage(owner.eClass)) return { kind: 'global' };
    cur = owner;
  }
  const definitions = sharedDefinitions(model);
  seen.clear();
  for (let cur = holder.ownerId != null ? model.get(holder.ownerId) : undefined; cur && !seen.has(cur.id); ) {
    seen.add(cur.id);
    if (cur.attrs.isLibrary === true) break;
    const path = instancePathBelow(model, end, cur.id);
    if (path !== undefined) {
      return { kind: 'enclosed', path, within: new Set([cur.id, ...definitions.specialisersOf(cur.id).map((x) => x.id)]) };
    }
    cur = cur.ownerId != null ? model.get(cur.ownerId) : undefined;
  }
  return { kind: 'nowhere' };
}

/**
 * A binding `edge` written in `holder`, read for `instance` (an instance of
 * `holder` or of what it is a type of), whose one end is a feature of an
 * instance ENCLOSING `holder` ({@link endPlace}'s `enclosed`: R's `L` in `part
 * q : Q { bind p.load = L; }`): the enclosing instance it is read in — the
 * nearest frame above `instance` whose reader is that owner or specialises it
 * ({@link DefiningEquations.framesAbove}) — with each end, in the edge's
 * order, as a path below that frame's reader: `q.p.load` and `L` in r, for
 * r's q (E3). `undefined` for any other binding, or where no frame above
 * `instance` is such an instance (the end has no instance there).
 */
export function enclosedBindingFrame(
  model: Model,
  edge: ElementRecord,
  holder: ElementRecord,
  instance: string,
): { reader: ElementId; instance: string; ends: readonly [string, string] } | undefined {
  const pair = [edge.source?.[0], edge.target?.[0]] as const;
  if (pair[0] === undefined || pair[1] === undefined) return undefined;
  const places = [endPlace(model, pair[0], holder), endPlace(model, pair[1], holder)] as const;
  const k = places[0].kind === 'enclosed' ? 0 : 1;
  const up = places[k];
  const down = places[1 - k]!;
  if (up.kind !== 'enclosed' || down.kind !== 'below') return undefined;
  const frames = sharedDefinitions(model).framesAbove(instance) ?? [];
  for (let i = frames.length - 1; i >= 0; i--) {
    const frame = frames[i]!;
    if (!up.within.has(frame.reader) || !instance.startsWith(`${frame.instance}::`)) continue;
    const below = `${instance.slice(frame.instance.length + 2).split('::').join('.')}.${down.path}`;
    return { reader: frame.reader, instance: frame.instance, ends: k === 0 ? [up.path, below] : [below, up.path] };
  }
  return undefined;
}

/**
 * The dotted path of feature `id` below `ownerId` through usages alone — the
 * path an instance of `ownerId` reads it at — or `undefined`.
 */
function instancePathBelow(model: Model, id: ElementId, ownerId: ElementId): string | undefined {
  const segments: string[] = [];
  const seen = new Set<ElementId>();
  for (let cur = model.get(id); cur; cur = cur.ownerId != null ? model.get(cur.ownerId) : undefined) {
    if (cur.id === ownerId) return segments.length > 0 ? segments.join('.') : undefined;
    if (seen.has(cur.id) || !isUsage(cur.eClass)) return undefined;
    seen.add(cur.id);
    const name = effectiveNameOf(model, cur);
    if (name === undefined) return undefined;
    segments.unshift(name);
  }
  return undefined;
}

/**
 * How a binding reads what `features` are among, in `contextId` where it
 * holds — the features of the binding component each is in there, one
 * signature per component ({@link heldDefaults}) — or `undefined` where no
 * binding joins any of them in `ownerId`. Q's `bind p.load = L` joins p's load
 * to Q's `L` in Q and to q's `:>> L = 50.0` in `q : Q`: a value Q reads
 * through p's load (`m2 = 10.0 - load`) is another in q, though no name of it
 * is redefined there.
 *
 * Each member is signed with what its value reads where it is read ({@link
 * readsOtherwise}, {@link readSignature}): Q's `L = 2.0 * K` is the same
 * feature in `q : Q { :>> K = 25.0; }`, read there as q's own 50 — so q joins
 * p's load to another value too, and a relation Q reads through it is q's own
 * (`Q::c in q`). `marked: false` signs by feature alone, as this did before
 * values were signed ({@link DefiningEquations.readsBoundOnly}).
 */
export function bindingReadingIn(
  model: Model,
  ownerId: ElementId,
  contextId: ElementId,
  features: ReadonlySet<ElementId>,
  marked = true,
): string | undefined {
  const { readings } = bindingEnds(model);
  const own = readings.get(ownerId);
  if (!own) return undefined;
  const there = readings.get(contextId);
  const { members } = indexOf(model);
  const sign = (root: ElementId, p: string): string =>
    (marked ? markOf(model, root, p) : readings.get(root)?.get(p)?.feature) ?? '';
  const signed = (root: ElementId, component: string): string =>
    [...new Set((members.get(root)?.get(component) ?? []).map((p) => sign(root, p)))].sort().join(',');
  const out: string[] = [];
  for (const [path, r] of own) {
    if (!features.has(r.feature)) continue;
    // A context that renames a redefinition on the path spells it its own way
    // (R38's `q2 : Q { attribute ld :>> load; }` holds Q's `bind load = L` at
    // `ld`): the member there is the one whose feature is, or redefines, the
    // owner's. Read at the owner's own signature instead, q2's `:>> K = 25.0`
    // (L, and so ld, 50) went unseen, and no surface read `c in q2`. One the
    // context's reading holds nowhere is the context's own.
    const x = there?.get(path) ?? (there !== undefined ? renamedMember(model, there, r.feature) : undefined);
    out.push(`${path}=${x ? signed(contextId, x.component) : there !== undefined ? `?${contextId}` : signed(ownerId, r.component)}`);
  }
  return out.length > 0 ? out.sort().join(' ') : undefined;
}

/** The member of a binding reading ({@link bindingReadingIn}) whose feature is `featureId` or redefines it. */
function renamedMember(
  model: Model,
  reading: ReadonlyMap<string, { feature: ElementId; component: string }>,
  featureId: ElementId,
): { feature: ElementId; component: string } | undefined {
  for (const m of reading.values()) {
    if (m.feature === featureId) return m;
    const f = model.get(m.feature);
    if (f && redefinedClosure(model, f).some((g) => g.id === featureId)) return m;
  }
  return undefined;
}

/**
 * What the feature `f` at `path` in the context `root` states, for a binding
 * end ({@link heldDefaults}): a value of its own — the nearest value it or a
 * feature it redefines writes, with `=`; or an asserted equation of its owner,
 * or of the context, that defines it — a `default`, with the feature that
 * writes it, or nothing.
 */
function endValue(model: Model, f: ElementRecord, root: ElementRecord, path: string): EndValue {
  for (const g of [f, ...redefinedClosure(model, f)]) {
    if (g.attrs.value === undefined || g.attrs.value === null) continue;
    // A `default` an asserted equation would override ({@link assertHeld}:
    // since decision 14 was amended, only one a typed assert may define, read
    // nowhere) is no default of the component's to stand: it counts as a
    // value, and a default in the component gives way to it.
    return g.attrs.defaultValue === true && !assertHeld(model).has(g.id) ? { kind: 'default', source: g } : { kind: 'value' };
  }
  // No value of its own: an asserted equation that defines the feature — its
  // own, or one it redefines, an assert inherited from a general definition
  // through the copy's redefinition closure (the G340 family, `assert-min`) —
  // is a stated value, carried into every member with none; a `default` in the
  // component stands against it, as against any assertion ({@link
  // heldDefaults}: `standing`).
  if (assertDefinesEnd(model, f, root, path)) return { kind: 'value', asserted: true };
  // A feature that states nothing of its own under a name its context
  // inherits two values under (MI1's q's end copy `L` over Q2's 50 and Q3's
  // 60, MI3's `attribute :>> L;`, {@link DefiningEquations.clashesIn}) has
  // values, read nowhere: a `default` in the component gives way to them,
  // never stands for both.
  if (f.ownerId != null && sharedDefinitions(model).clash(f.ownerId, f) !== undefined) return { kind: 'value' };
  return { kind: 'none' };
}

/**
 * Does `f` state nothing of its own — an implicit connector-end copy, or a
 * redefinition that writes no value (`attribute :>> L;`)? Under a name its
 * owner inherits two values under, it leaves the pair as it finds it
 * ({@link DefiningEquations.clashesIn}).
 */
function statesNothing(model: Model, f: ElementRecord): boolean {
  if (f.attrs.implicit === true) return true;
  if (f.attrs.value !== undefined && f.attrs.value !== null) return false;
  return redefinedClosure(model, f).length > 0;
}

/**
 * Does an asserted equation define the binding end `f` at `path` in `root` —
 * one of the owner of `f` or of a feature it redefines, under that feature's
 * name, one of the context, under the path, or one of a feature the path
 * passes through in the context, under the rest of it ({@link endValue})? The
 * last is a redefinition that writes the assert where the end is no feature
 * of its own: q2's `part :>> p { assert constraint { load == 50.0 } }` under
 * Q's `bind p.load = L`, read in q2 at `p.load` (an end copy Q's p owns), or
 * Q2's `part :>> p { … }` for `Q2 :> Q`. Asked of the end's owner alone, the
 * assert went unseen, Q's `L default = 1.0` was never one of two values
 * there, and the check read q2's p's load at the equation's 50 where the
 * numeric surface read the default's 1 (M2, M3).
 */
function assertDefinesEnd(
  model: Model,
  f: ElementRecord,
  root: ElementRecord,
  path: string,
  cache?: Map<ElementId, ReadonlySet<string>>,
): boolean {
  // Given a `cache`, each owner's asserted names are gathered once (a package of thousands of usages is
  // the root of every held member it reads).
  const definedIn = (ownerId: ElementId, n: string): boolean => {
    if (!cache) return model.children(ownerId).some((c) => isAsserted(c) && namesDefinedBy(c).includes(n));
    let hit = cache.get(ownerId);
    if (!hit) {
      hit = new Set(model.children(ownerId).flatMap((c) => (isAsserted(c) ? namesDefinedBy(c) : [])));
      cache.set(ownerId, hit);
    }
    return hit.has(n);
  };
  const defines = (ownerId: ElementId | null, n: string | undefined): boolean =>
    n !== undefined && ownerId != null && definedIn(ownerId, n);
  if ([f, ...redefinedClosure(model, f)].some((g) => defines(g.ownerId, effectiveNameOf(model, g))) || defines(root.id, path)) return true;
  // Each feature the path passes through in the context, and what it redefines, under the rest of the path.
  const segments = path.split('.');
  const definitions = sharedDefinitions(model);
  let owner = root.id;
  for (let i = 0; i < segments.length - 1; i++) {
    const h = definitions.byName(owner).get(segments[i]!);
    if (!h) return false;
    const rest = segments.slice(i + 1).join('.');
    if ([h, ...redefinedClosure(model, h)].some((g) => defines(g.id, rest))) return true;
    owner = h.id;
  }
  return false;
}

/**
 * Does the binding end `f` — at `path` in `root`, where it reads a `default`
 * ({@link endValue}) — state nothing of its own, so that read generically it
 * falls through to the `default` of a feature it redefines? The implicit
 * connector-end copy q2's `bind p.extra = E` makes of P's `extra default =
 * 0.0` does: read at q2's p, through the copy, the redefined default is what
 * the reading meets, and it is not q2's p's value (A4). So does one an
 * asserted equation defines (GA6's `p.load`, whose P asserts `load == 7.0`):
 * the default stands against the assert ({@link replaceableDefaults}), and
 * the fall-through reads the default. Only over a `default` an assertion may
 * replace (`source`, the feature that writes it) would the fall-through read
 * the assert.
 */
function fallsToDefault(
  model: Model,
  f: ElementRecord,
  root: ElementRecord,
  path: string,
  cache: Map<ElementId, ReadonlySet<string>>,
  source: ElementRecord,
): boolean {
  if (f.attrs.value !== undefined && f.attrs.value !== null) return false;
  if (!replaceableDefaults(model).has(source.id)) return true;
  return !assertDefinesEnd(model, f, root, path, cache);
}

/**
 * Does a binding override `f`'s `default` — is `f` written `attribute load
 * default = 1.0`, and held by a binding ({@link heldDefaults})? The default
 * gives way to the binding exactly as to a redefinition: the feature reads the
 * value the binding gives it — on every surface — and no surface reads the
 * default (`bind load = L` with `L` set to 50 in `q` is q's load of 50, never
 * the 1.0 that, read beside the binding, made the model contradict itself in
 * q). So does a `default` an asserted equation defines (H5, {@link
 * assertHeld}), one of an enclosing element's in every instance the feature
 * stands for included ({@link assertHeldEverywhere}). A value written with `=` is a binding of its own and gives way to
 * nothing: against another binding it is a contradiction (strict KerML). A
 * redefinition that states nothing over a default — the implicit
 * connector-end copy `bind p.load = L` creates of P's `load` — reads no
 * default either ({@link DefiningEquations.carrier}).
 */
export function defaultGivesWay(model: Model, f: ElementRecord): boolean {
  return f.attrs.defaultValue === true && (bindingEnds(model).held.has(f.id) || assertHeld(model).has(f.id) || assertHeldEverywhere(model, f));
}

/**
 * What the `default` that `f` or a feature it redefines writes gives way to,
 * for a sentence: an asserted equation that defines one of them (`assert`,
 * {@link assertHeld}, {@link assertHeldEverywhere}), else the user's binding
 * that holds one of them (`binding`, its connector: BW4's `bind p.load = L`
 * over P's `load default = 2.0`) — `undefined` where neither holds one. A
 * chain to a feature whose default a binding holds had said it "gives way to
 * an asserted equation" of a model with no assert.
 */
export function defaultGivesWayTo(
  model: Model,
  f: ElementRecord,
): { to: 'assert' } | { to: 'typed'; assert: ElementRecord } | { to: 'binding'; bindingId?: ElementId } | undefined {
  const chain = [f, ...redefinedClosure(model, f)];
  const typed = typedAssertHolding(model, f);
  if (typed !== undefined && !chain.some((g) => assertHeldEverywhere(model, g))) return { to: 'typed', assert: typed };
  if (chain.some((g) => assertHeld(model).has(g.id) || assertHeldEverywhere(model, g))) return { to: 'assert' };
  const ends = bindingEnds(model);
  if (!chain.some((g) => ends.held.has(g.id))) return undefined;
  const ids = new Set(chain.map((g) => g.id));
  const joins = (end: ElementId | undefined): boolean => {
    const e = end !== undefined ? model.get(end) : undefined;
    return e !== undefined && (ids.has(e.id) || redefinedClosure(model, e).some((g) => ids.has(g.id)));
  };
  const connector = ends.connectors.find((c) => joins(c.source?.[0]) || joins(c.target?.[0]));
  return connector ? { to: 'binding', bindingId: connector.id } : { to: 'binding' };
}

/**
 * Does a binding of the model, or one joined to it, meet a cap ({@link
 * BindingEnds.overCap}), or hold in a context where an end has no instance
 * ({@link BindingEnds.unread}, the `outside` cap)?
 */
export function hasPastCapBindings(model: Model): boolean {
  const { overCap, unread } = bindingEnds(model);
  return overCap.size > 0 || unread.size > 0;
}

/**
 * Is the feature `featureId` an end of a binding past a cap ({@link
 * BindingEnds.overCap}, or {@link BindingEnds.unread}: `outside`), or one that
 * redefines such an end — a feature whose value a binding holds in a context
 * this tool does not read? Its `default` was held for that (`holdEnds`), not
 * because a binding gives it another value, and where nothing else determines
 * it, it is no value the model leaves free: the value is there, unread.
 * CAPU4's `part s : T1;` beside T1's chain 33 usages deep holds s's L and its
 * a's load at T1's default of 1; read as free, `s.a.load == 9.0` was solved as
 * a design equation, and `s.L <= 5.0` refuted at that 9. So was R's nested Q,
 * used outside any R, for `r2 : R`'s q's p's load, where r2's L is R's default
 * of 1 (`r2.q.p.m2 >= 5.0` refuted at m2 = 1). The numeric lane reads such a
 * feature as one it cannot read (the solver's `unreadable`) unless its
 * bindings fix it from values the model states (CAP1's Y, 50 from X).
 */
export function pastCapEnd(model: Model, featureId: ElementId): boolean {
  return pastCapOf(model, featureId) !== undefined;
}

/** The cap a {@link pastCapEnd} feature's binding met — the first of it and the features it redefines — or `undefined`. */
export function pastCapOf(model: Model, featureId: ElementId): BindingCap | undefined {
  const { overCap, unread } = bindingEnds(model);
  if (overCap.size === 0 && unread.size === 0) return undefined;
  const capOf = (id: ElementId): BindingCap | undefined => overCap.get(id) ?? (unread.has(id) ? 'outside' : undefined);
  const own = capOf(featureId);
  if (own !== undefined) return own;
  const f = model.get(featureId);
  if (f === undefined) return undefined;
  for (const g of redefinedClosure(model, f)) {
    const cap = capOf(g.id);
    if (cap !== undefined) return cap;
  }
  return undefined;
}

/**
 * Why a {@link pastCapEnd} feature has no value read for an instance — what
 * is not read, and the cap: `R::L is held by a binding that joins a feature
 * outside where it is written, … so no value the binding gives it is read for
 * any one instance`. Its `default`, where it states one, was held for the cap,
 * and is no value of its own here either: never `declared without one`.
 */
export function heldPastCapSentence(name: string, cap: BindingCap): string {
  const held =
    cap === 'outside'
      ? 'a binding that joins a feature outside where it is written, which this tool finds no instance of in a context the binding holds in'
      : cap === 'frames'
        ? `a binding that holds in more than ${MAX_BINDING_FRAMES.toLocaleString('en')} contexts`
        : `a binding read deeper than ${MAX_BINDING_SEGMENTS} usages`;
  return `${name} is held by ${held}, so no value the binding gives it is read for any one instance`;
}

/**
 * Does a feature `f` read nothing of `g`, the feature it redefines that states
 * a value — a `default` a binding holding `f` overrides ({@link heldDefaults})?
 */
function boundOverDefault(model: Model, f: ElementRecord, g: ElementRecord): boolean {
  return g.attrs.defaultValue === true && bindingEnds(model).held.has(f.id);
}

/*
 * THE INSTANCE INDEX (plan per-instance-check, step F3). One shared index over
 * the bindings a model states, used by the per-instance readings of the check
 * (F5) and the per-instance rows of the obligations lane (F7). F3 builds the
 * index and its tests; no consumer reads it yet, so a model's `held`/`readings`
 * are byte-identical and no verdict moves.
 *
 *  - {@link bindingFrames}: the contexts a definition (or a usage at the top of
 *    a usage chain) is read in, as {@link heldDefaults} walks them.
 *  - {@link classified}: what a binding component's members state in one frame
 *    root — a value, a readable `default`, or a `default` the binding holds.
 *  - {@link boundSourceIn}: the outermost frame root a name's instance reads a
 *    binding through, and which member there gives its value (A.2).
 *  - {@link instancesOfDefinition} / {@link instancesOfUsage}: the instances
 *    of a definition, frames ∪ `denote` over every user package.
 *  - {@link instanceGroups}: the groups a relation is read per instance in,
 *    expanded all-or-nothing past the caps (A.7).
 *  - {@link rebaseInstance}, {@link enclosingAssertOn}: the helpers A.2 threads
 *    an instance through a reading with.
 */

/** Why a per-instance reading abstains (A.9). */
export type InstanceAbstention =
  | 'free'
  | 'defaults-differ'
  | 'held-elsewhere'
  | 'two-values'
  | 'enclosing-assert'
  | 'past-cap'
  | 'not-enumerated'
  | 'internal';

/**
 * The A.9 `internal` sentence (A.2.9): a per-instance reading of `name` in
 * `instance` threw, and says so, naming the error's class. It is reported,
 * never dropped and never thrown on: a throw out of the sweep made `validate()`
 * throw, and the app's Problems view (`safeValidate`) then showed nothing at
 * all, every other rule's findings included. One sentence for the scalar
 * reading and its unit-aware twin.
 */
export function failedReadingSentence(name: string, instance: string, e: unknown): string {
  return `${name} is not read in ${instance}: ${READING_FAILED} ` +
    `(${e instanceof Error ? e.constructor.name : 'error'}); reported, not dropped`;
}

const READING_FAILED = 'the per-instance reading failed';

/**
 * Is this refusal sentence a {@link failedReadingSentence}: the tool failed, whatever the relation says? The
 * verification lanes close such a row in a sentence that blames the tool, not the relation ({@link refusalTail}).
 */
export function isFailedReading(sentence: string): boolean {
  return sentence.includes(`: ${READING_FAILED} (`);
}

/** One context a definition is read in, with the dotted path to it from that context's root ({@link bindingFrames}). */
export interface BindingFrame {
  root: ElementRecord;
  prefix: string;
}

/** What a binding component's members state, classified by path ({@link classified}). */
export interface ComponentClass {
  /** Members that state a value — `=`, or an asserted equation. */
  readonly valued: readonly string[];
  /** Members whose `default` stands — not held by the binding. */
  readonly readable: readonly string[];
  /** Members whose `default` gives way to the binding. */
  readonly heldDefaults: readonly string[];
}

/**
 * The source of a name's value read through a binding ({@link boundSourceIn}):
 * the frame root it is read in, the member paths the component joins there,
 * the component, and — where one member supplies the value — which binding
 * connectors join it and which path is the source. Or the abstention, with its
 * sentence (A.9).
 */
export type BoundSource =
  | {
      root: ElementId;
      paths: readonly string[];
      component: string;
      via: { bindingIds: readonly ElementId[]; source: string };
    }
  | { abstain: InstanceAbstention; sentence: string };

/** One group a relation is read per instance in ({@link instanceGroups}): (relation, shared usage). */
export interface InstanceGroup {
  relationId: ElementId;
  usageId: ElementId;
  definitionId: ElementId;
  /** The instances the usage is read in, its own (generic) first. */
  instances: readonly string[];
  /** Whether the group was expanded — every instance read — or kept as today's single refusal. */
  expanded: boolean;
  refusal?: {
    kind: InstanceAbstention;
    sentence: string;
    /** On a group left unexpanded past an instance cap: the instances it holds, none read, and the cap (C.3's `not read in {r} ({cap})`). */
    unread?: { count: number; cap: string; atLeast?: true };
  };
  /**
   * The instances of an expanded group its rows do NOT read (A.7's coverage
   * guard), each with the kind and the sentence every surface abstains on it
   * with ({@link instanceReadsOtherwise}): one whose own element cannot be
   * read for it (`not-enumerated`), or that an enclosing assert constrains
   * (`enclosing-assert`). Absent where there is none.
   */
  otherwise?: ReadonlyMap<string, { kind: InstanceAbstention; sentence: string }>;
  /**
   * The instances of an expanded group read in an element of their OWN, by
   * that element's id: an instance whose most specific element reads a name of
   * the relation — or a name its value reads — through another feature than
   * the usage does (a redefinition with a value of its own, a specialised
   * type, a nested override; {@link instanceReadsOtherwise}) is read there, at
   * the instance, never through the usage's features. Absent where there is
   * none.
   */
  readIn?: ReadonlyMap<string, ElementId>;
  /**
   * The instances of an expanded group that are an element's own instance,
   * by that element's id — an element other than the usage (q2's `part :>> p
   * { … }` is q2's p; Q2's `part :>> p : P2` is Q2's p): the group's row for
   * the instance IS the relation read in that element, so the element is no
   * context of the relation's own — no other row reads it there, and the
   * instance is filed once under its name. Absent where there is none.
   */
  standsFor?: ReadonlyMap<string, ElementId>;
}

/** Past this many instances of one usage, its group is not expanded (A.7, E). */
export const MAX_INSTANCE_READS = 4096;

/** Past this many instance readings in one sweep, later groups are not expanded (A.7, E). */
export const MAX_INSTANCE_RELATIONS = 16384;

/** Past this many instance goal rows in one verify run, a group keeps its single refusal (A.7, E). */
export const MAX_INSTANCE_GOALS = 256;

/** Past this many paths of what a relation reads, the coverage guard compares no further and abstains (A.7). */
const MAX_GUARD_PATHS = 256;

/**
 * The contexts a definition (or a usage at the top of a usage chain) is read
 * in, as {@link heldDefaults} walks them: itself, then every context that
 * specialises it, and — where it is a usage — the contexts above it, climbing
 * from a usage to its owner up to the outermost non-library owner, packages
 * included. Each frame is a context `root` and the dotted `prefix` of the path
 * from that root to the definition's instance. `truncated` is set past
 * {@link MAX_BINDING_FRAMES} contexts, or a context deeper than
 * {@link MAX_BINDING_SEGMENTS} usages left out.
 *
 * The walk is the one {@link heldDefaults} takes, extracted so the per-instance
 * index and the held-default reading share it; {@link heldDefaults} keeps its
 * own copy because its frames carry an `outer` the index does not need.
 */
export function bindingFrames(
  definitions: DefiningEquations,
  holder: ElementRecord,
): { frames: BindingFrame[]; truncated: boolean } {
  const model = definitions.model;
  const frames: BindingFrame[] = [{ root: holder, prefix: '' }];
  const index = new Map<string, number>([[`${holder.id} `, 0]]);
  let truncated = false;
  for (let i = 0; i < frames.length && frames.length <= MAX_BINDING_FRAMES; i++) {
    const { root, prefix } = frames[i]!;
    const succ: BindingFrame[] = definitions.specialisersOf(root.id).map((z) => ({ root: z, prefix }));
    const name = isUsage(root.eClass) ? definitions.nameOf(root) : undefined;
    const owner = root.ownerId != null ? model.get(root.ownerId) : undefined;
    if (name !== undefined && owner && owner.attrs.isLibrary !== true) {
      succ.push({ root: owner, prefix: prefix === '' ? name : `${name}.${prefix}` });
    }
    for (const f of succ) {
      const key = `${f.root.id} ${f.prefix}`;
      if (index.has(key)) continue;
      if (f.prefix.split('.').length > MAX_BINDING_SEGMENTS) {
        truncated = true;
        continue;
      }
      index.set(key, frames.length);
      frames.push(f);
    }
  }
  if (frames.length > MAX_BINDING_FRAMES) truncated = true;
  return { frames, truncated };
}

/**
 * Re-root an instance spelling: the instance `symbol`, read as rooted at
 * `contextId`'s own instance, read instead where the instance is `instance`
 * (A.2.1). The Denotation the fallback reads is rooted at the row's context;
 * this re-roots it to the instance the reading is for.
 */
export function rebaseInstance(
  definitions: DefiningEquations,
  contextId: ElementId,
  instance: string,
  symbol: string,
): string {
  const from = definitions.instanceNameOf(contextId);
  if (symbol === from) return instance;
  return symbol.startsWith(`${from}::`) ? `${instance}${symbol.slice(from.length)}` : symbol;
}

/**
 * `path`, a member path written in a general type of `contextId` (an end of
 * Q's `bind p.load = L`), as `contextId` spells it: a segment a renamed
 * redefinition answers to (`part pp :>> p` in `part q : Q`) by that
 * redefinition's own name — q's `pp.load`, the symbol every relation over
 * q's pp reads (H5, E8: R13). `path` itself where the scope names it, or
 * where a segment resolves to nothing there.
 */
export function spelledIn(definitions: DefiningEquations, contextId: ElementId, path: string): string {
  const denoted = definitions.denote(contextId);
  if (denoted.has(path)) return path;
  let spelled = '';
  for (const seg of path.split('.')) {
    const d = denoted.get(spelled === '' ? seg : `${spelled}.${seg}`);
    const name = d ? definitions.nameOf(d.feature) : undefined;
    if (name === undefined) return path;
    spelled = spelled === '' ? name : `${spelled}.${name}`;
  }
  return spelled;
}

/**
 * The {@link ComponentFacts} record of the component `component` read in
 * `root`, made when first asked with the member paths alone — in reading
 * order, from the `members` index ({@link indexOf}) rather than a scan of the
 * whole reading per ask — and filled in by each fact's own reader. Thousands
 * of instance symbols read through one root (big-bind's q's, perf9b's 767
 * N0s) ask the same component.
 */
function componentFacts(model: Model, root: ElementId, component: string): ComponentFacts {
  const ends = bindingEnds(model);
  const memo = (ends.components ??= new Map());
  const key = `${root} ${component}`;
  let facts = memo.get(key);
  if (!facts) {
    facts = { paths: Object.freeze(indexOf(model).members.get(root)?.get(component) ?? []) };
    memo.set(key, facts);
  }
  return facts;
}

/**
 * What the members of a binding component state, classified by path (A.3):
 * `valued` (a value of its own — a `default` that stands against an end an
 * asserted equation defines included, {@link BindingEnds.standing}),
 * `readable` (a `default` the binding does not hold), and `heldDefaults` (a
 * `default` it holds, {@link heldDefaults}).
 * Once per (root, component) and revision; the record is shared — read it,
 * never change it.
 */
export function classified(model: Model, root: ElementId, component: string): ComponentClass {
  const facts = componentFacts(model, root, component);
  if (facts.classified) return facts.classified;
  const { readings, held, standing, standingAt } = bindingEnds(model);
  const valued: string[] = [];
  const readable: string[] = [];
  const heldDefaults: string[] = [];
  const reading = readings.get(root);
  const rootEl = model.get(root);
  if (reading && rootEl) {
    for (const path of facts.paths) {
      const r = reading.get(path);
      const f = r ? model.get(r.feature) : undefined;
      if (!f) continue;
      const v = endValue(model, f, rootEl, path);
      // A `default` that stands against an end an asserted equation defines is one of the values, as `=` is —
      // here, where it is held only in another context ({@link BindingEnds.standingAt}), too.
      if (v.kind === 'value' || (v.kind === 'default' && (standing.has(f.id) || standingAt.has(`${root} ${path}`)))) valued.push(path);
      else if (v.kind === 'default') (held.has(f.id) ? heldDefaults : readable).push(path);
    }
  }
  facts.classified = Object.freeze({
    valued: Object.freeze(valued),
    readable: Object.freeze(readable),
    heldDefaults: Object.freeze(heldDefaults),
  });
  return facts.classified;
}

/** Every member path of `component` read in `root`, in reading order — the component's own list, frozen. */
function componentPaths(model: Model, root: ElementId, component: string): readonly string[] {
  return componentFacts(model, root, component).paths;
}

/** The ids of the {@link componentConnectors} of `component` read in `root` — the component's own list, frozen. */
function componentBindingIds(model: Model, root: ElementId, component: string): readonly ElementId[] {
  const facts = componentFacts(model, root, component);
  facts.bindingIds ??= Object.freeze(componentConnectors(model, root, component).map((c) => c.id));
  return facts.bindingIds;
}

/**
 * The binding connectors that join the component read in `root` — the
 * connectors whose two ends are the features the component's members read,
 * each member matched through what it redefines (an implicit connector-end
 * copy of the end) — in the model's order. Best-effort: the per-instance
 * reading (F5) is what consumes this, and it reads the member it names rather
 * than these ids. Once per (root, component) and revision, over the user's
 * binding connectors ({@link BindingEnds.connectors}), never the whole model.
 */
function componentConnectors(model: Model, root: ElementId, component: string): readonly ElementRecord[] {
  const facts = componentFacts(model, root, component);
  if (facts.connectors) return facts.connectors;
  const ends = bindingEnds(model);
  const reading = ends.readings.get(root);
  const origins = new Set<ElementId>();
  for (const path of facts.paths) {
    const r = reading?.get(path);
    if (!r) continue;
    origins.add(r.feature);
    const f = model.get(r.feature);
    if (f) for (const g of redefinedClosure(model, f)) origins.add(g.id);
  }
  facts.connectors = origins.size === 0 ? [] : connectorsAmong(ends, origins);
  return facts.connectors;
}

/**
 * The user's binding connectors whose two ends are both among `origins`, in the
 * model's order — found by each origin's own connectors ({@link
 * BindingEnds.bySource}), not by testing every connector once per component.
 */
function connectorsAmong(ends: BindingEnds, origins: ReadonlySet<ElementId>): readonly ElementRecord[] {
  if (!ends.bySource) {
    const bySource = new Map<ElementId, Array<{ connector: ElementRecord; order: number }>>();
    ends.connectors.forEach((connector, order) => {
      const s = connector.source?.[0];
      if (s === undefined) return;
      const list = bySource.get(s);
      if (list) list.push({ connector, order });
      else bySource.set(s, [{ connector, order }]);
    });
    ends.bySource = bySource;
  }
  const found: Array<{ connector: ElementRecord; order: number }> = [];
  for (const origin of origins) {
    for (const entry of ends.bySource.get(origin) ?? []) {
      const t = entry.connector.target?.[0];
      if (t !== undefined && origins.has(t)) found.push(entry);
    }
  }
  return found.sort((a, b) => a.order - b.order).map((e) => e.connector);
}

/**
 * The context roots of the binding readings by the instance each reads its
 * own features in ({@link DefiningEquations.instanceNameOf}), in reading
 * order — so a symbol's frame roots are found by its own prefixes, not by
 * spelling every root's instance per symbol. Once per revision.
 */
function readingsByInstance(model: Model): ReadonlyMap<string, ReadonlyArray<{ root: ElementId; order: number }>> {
  const ends = bindingEnds(model);
  if (ends.byInstance) return ends.byInstance;
  const definitions = sharedDefinitions(model);
  const byInstance = new Map<string, Array<{ root: ElementId; order: number }>>();
  let order = 0;
  for (const root of ends.readings.keys()) {
    const inst = definitions.instanceNameOf(root);
    const list = byInstance.get(inst);
    if (list) list.push({ root, order });
    else byInstance.set(inst, [{ root, order }]);
    order += 1;
  }
  ends.byInstance = byInstance;
  return byInstance;
}

/** Is `e` a package — a namespace, which {@link isDefinition} counts among the definitions? */
function isPackage(e: ElementRecord): boolean {
  return e.eClass === 'Package' || e.eClass === 'LibraryPackage';
}

/**
 * The DEFINITION the member path `path` of `rootId`'s reading is written below
 * — the last one the path names, P for `P.load` or `Pkg.P.sub.load` below a
 * package — with the features from it down to the member ({@link
 * featuresAtPath}); `undefined` for a path through usages alone (`q1.p.load`,
 * though P owns that load).
 */
function definitionHeadOf(
  model: Model,
  definitions: DefiningEquations,
  rootId: ElementId,
  path: string,
): { definition: ElementRecord; tail: ElementRecord[] } | undefined {
  const chain = featuresAtPath(model, definitions, rootId, path);
  if (!chain) return undefined;
  for (let at = chain.length - 2; at >= 0; at--) {
    const e = chain[at]!;
    if (isDefinition(e.eClass) && !isPackage(e)) return { definition: e, tail: chain.slice(at + 1) };
  }
  return undefined;
}

/**
 * A member of a binding reading written on a DEFINITION's feature from outside
 * it — a package's `bind P::load = L` (w4), at `P.load` in the package's
 * reading — with the definition (`P`) and the features from it down to the
 * member (`[P::load]`): the binding holds in every instance of P, read at the
 * instance's own path ({@link definitionHeadMatch}).
 */
interface DefinitionHead {
  path: string;
  component: string;
  feature: ElementId;
  definition: ElementRecord;
  tail: readonly ElementRecord[];
  /** Does a feature with a value of its own redefine the member — an instance's `:>> load default = 7.0`? */
  redefined: boolean;
  /**
   * What gives the member's slot a value in some instance of the definition
   * OUTSIDE the component — and so gives the component's one-instance end
   * (the package's `L`) that value, which this tool does not read into the
   * other instances: a redefinition's own `=` (`part p4 : P { attribute :>>
   * load = 7.0; }`), a member of another binding reading at an instance's
   * path (Q's `bind p.load = M` for `part p : P`, the package's own `bind
   * p2.load = K`), or an asserted equation that defines an instance's slot
   * (`assert constraint { p2.load == 5.0 }`). No `default` in such a
   * component is its value ({@link heldDefaults}, {@link standingDefaultIn})
   * — save where the slot's value is only an assertion's ({@link
   * DefinitionHead.states}).
   */
  fixed?: string;
  /** What {@link DefinitionHead.fixed} names: a redefinition's `=`, a member of another binding, or an asserted equation. */
  fixedBy?: 'value' | 'binding' | 'assert';
  /**
   * Every member of another component that is the head's slot at an instance
   * ({@link DefinitionHead.fixed}'s `binding`): the root it is read in, its
   * component there and its path.
   */
  slots?: Array<{ root: ElementId; component: string; path: string }>;
  /**
   * Does what fixes the slot STATE a value a `default` gives way to — a value
   * written with `=`, or a binding to a component with a value, a `default` or
   * nothing of its own (decision 10, as before)? Not an asserted equation, nor
   * a binding to a component whose only values asserted equations give
   * (W4X3A's `bind p2.load = L` beside `assert constraint { L == 5.0 }`): no
   * assertion replaces a `default` (decision 14 amended, {@link
   * replaceableDefaults}), so the package's `M default = 9.0` stands in every
   * instance, as `M = 9.0` does, never solved from the assert's 5. Set by
   * {@link heldDefaults}.
   */
  states?: boolean;
}

/** Does `h`'s slot take, outside its component, a value a `default` in it gives way to ({@link DefinitionHead.states})? */
function fixesSlot(h: DefinitionHead): boolean {
  return h.fixed !== undefined && h.states !== false;
}

/**
 * The {@link DefinitionHead} members of each binding reading in `contexts`,
 * by root — only a package's reading has any, the one a binding written there
 * reads its ends in — and the user's features with a value of their own
 * (`=` or `default`) by each feature they redefine, built only where a head
 * exists. A head's slot is `fixed` where a redefinition states it with `=`,
 * or where a member of another component read in any root ({@link
 * heldDefaults}' `contexts`), or a path an asserted equation defines, is the
 * slot at an instance of the head's definition: the instance the path's
 * prefix names (a usage or definition that specialises it, or the root
 * itself), and below it the head's features, each the feature or one that
 * redefines it. Once per revision, inside {@link heldDefaults}.
 */
function headsOfReadings(
  model: Model,
  definitions: DefiningEquations,
  contexts: ReadonlyMap<ElementId, { at: ReadonlyMap<string, ElementRecord> }>,
  componentOf: (rootId: ElementId, path: string) => string,
): { heads: Map<ElementId, DefinitionHead[]>; byRedefined?: ReadonlyMap<ElementId, readonly ElementRecord[]> } {
  const heads = new Map<ElementId, DefinitionHead[]>();
  const all: Array<{ rootId: ElementId; head: DefinitionHead }> = [];
  for (const [rootId, ctx] of contexts) {
    const root = model.get(rootId);
    if (!root || !isPackage(root)) continue;
    for (const [path, f] of ctx.at) {
      const head = definitionHeadOf(model, definitions, rootId, path);
      if (!head) continue;
      const entry: DefinitionHead = { path, component: componentOf(rootId, path), feature: f.id, ...head, redefined: false };
      const list = heads.get(rootId) ?? [];
      list.push(entry);
      heads.set(rootId, list);
      all.push({ rootId, head: entry });
    }
  }
  if (all.length === 0) return { heads };
  const byRedefined = new Map<ElementId, ElementRecord[]>();
  for (const x of model.all()) {
    if (x.attrs.isLibrary === true || !isUsage(x.eClass) || x.attrs.value === undefined || x.attrs.value === null) continue;
    for (const g of redefinedClosure(model, x)) {
      const list = byRedefined.get(g.id);
      if (list) list.push(x);
      else byRedefined.set(g.id, [x]);
    }
  }
  for (const { head } of all) {
    const redefiners = byRedefined.get(head.feature) ?? [];
    head.redefined = redefiners.length > 0;
    const plain = redefiners.find((r) => r.attrs.defaultValue !== true);
    if (plain) {
      head.fixed = `the value ${effectiveQualifiedName(model, plain.id)} states`;
      head.fixedBy = 'value';
    }
  }
  // Is `path` read in `rootId` the slot `head` names at an instance of its definition?
  const chains = new Map<string, ElementRecord[] | undefined>();
  const slotOf = (rootId: ElementId, path: string, head: DefinitionHead): boolean => {
    const key = `${rootId} ${path}`;
    if (!chains.has(key)) chains.set(key, featuresAtPath(model, definitions, rootId, path));
    const chain = chains.get(key);
    if (!chain) return false;
    const at = chain.length - head.tail.length - 1;
    const instance = at >= 0 ? chain[at] : at === -1 ? model.get(rootId) : undefined;
    if (!instance || isPackage(instance)) return false;
    if (instance.id !== head.definition.id && !generalizationsOf(model, instance.id).some((g) => g.id === head.definition.id)) return false;
    return head.tail.every((g, k) => {
      const mine = chain[at + 1 + k]!;
      return mine.id === g.id || redefinedClosure(model, mine).some((x) => x.id === g.id);
    });
  };
  // Every binding member at a slot, not the first alone: {@link heldDefaults} asks whether any of them states a
  // value ({@link DefinitionHead.states}).
  for (const [rootId, ctx] of contexts) {
    for (const path of ctx.at.keys()) {
      for (const { rootId: headRoot, head } of all) {
        if (head.fixedBy === 'value' || (rootId === headRoot && componentOf(rootId, path) === head.component)) continue;
        if (!slotOf(rootId, path, head)) continue;
        (head.slots ??= []).push({ root: rootId, component: componentOf(rootId, path), path });
        if (head.fixed === undefined) {
          head.fixed = `a binding read in ${effectiveQualifiedName(model, rootId)} at ${path}`;
          head.fixedBy = 'binding';
        }
      }
    }
  }
  for (const el of model.all()) {
    if (el.attrs.isLibrary === true || el.ownerId == null || !isAsserted(el)) continue;
    const eq = equationOf(el);
    if (!eq) continue;
    const paths = [definedName(eq.node.left, eq.literals), definedName(eq.node.right, eq.literals)];
    for (const { head } of all) {
      if (head.fixed !== undefined) continue;
      if (paths.some((p) => p !== undefined && slotOf(el.ownerId!, p, head))) {
        head.fixed = `the asserted equation ${effectiveQualifiedName(model, el.id)}`;
        head.fixedBy = 'assert';
      }
    }
  }
  return { heads, byRedefined };
}

/**
 * The element at each segment of the dotted `path` below `root` (075b306's
 * `featureAtPath`), resolved through the model's ownership by effective name
 * — a definition and its features included (`Q.p.load` below a package, Q's
 * own p's load), which a scope's {@link DefiningEquations.denote} walk leaves
 * out — then through each element's effective features. `undefined` where a
 * segment resolves to nothing.
 */
function featuresAtPath(model: Model, definitions: DefiningEquations, root: ElementId, path: string): ElementRecord[] | undefined {
  const out: ElementRecord[] = [];
  let owner = root;
  for (const seg of path.split('.')) {
    const f =
      childNamed(model, definitions, owner, seg) ??
      definitions.byName(owner).get(seg) ??
      definitions.features(owner).find((c) => definitions.nameOf(c) === seg);
    if (!f) return undefined;
    out.push(f);
    owner = f.id;
  }
  return out;
}

/** Each owner's children by name, the first of each name, once per {@link DefiningEquations} (one revision). */
const CHILDREN_BY_NAME = new WeakMap<DefiningEquations, Map<ElementId, ReadonlyMap<string, ElementRecord>>>();

/**
 * The first child of `owner` whose name is `name` ({@link featuresAtPath}):
 * indexed per owner, so a package's reading of many paths scans its children
 * once, not once per path.
 */
function childNamed(model: Model, definitions: DefiningEquations, owner: ElementId, name: string): ElementRecord | undefined {
  let byOwner = CHILDREN_BY_NAME.get(definitions);
  if (!byOwner) CHILDREN_BY_NAME.set(definitions, (byOwner = new Map()));
  let named = byOwner.get(owner);
  if (!named) {
    const m = new Map<string, ElementRecord>();
    for (const c of model.children(owner)) {
      const n = definitions.nameOf(c);
      if (n !== undefined && !m.has(n)) m.set(n, c);
    }
    byOwner.set(owner, (named = m));
  }
  return named.get(name);
}

/**
 * The {@link DefinitionHead} member of `root`'s reading that the path `path`
 * of `root` reads (H5, w4): an instance of the head's definition at a prefix
 * of the path — a usage it types or specialises, `p2` for P — and below it the
 * head's features, each segment the feature itself or one that redefines it.
 * A package's `bind P::load = L` is read at `p2.load` for `part p2 : P`, and at
 * `q.p.load` for a `part def Q { part p : P; }` and `part q : Q`. `undefined`
 * where none matches, or where two in different components do (that instance
 * is read through neither).
 */
function definitionHeadMatch(model: Model, root: ElementId, path: string): DefinitionHead | undefined {
  const heads = bindingEnds(model).heads.get(root);
  if (!heads || path === '') return undefined;
  const slots = featuresAtPath(model, sharedDefinitions(model), root, path);
  if (!slots) return undefined;
  const same = (mine: ElementRecord, g: ElementRecord): boolean =>
    mine.id === g.id || redefinedClosure(model, mine).some((x) => x.id === g.id);
  let match: DefinitionHead | undefined;
  for (const head of heads) {
    const at = slots.length - head.tail.length - 1;
    if (at < 0) continue;
    const instance = slots[at]!;
    if (!isUsage(instance.eClass)) continue;
    if (!generalizationsOf(model, instance.id).some((g) => g.id === head.definition.id)) continue;
    if (!head.tail.every((g, k) => same(slots[at + 1 + k]!, g))) continue;
    if (match && match.component !== head.component) return undefined;
    match ??= head;
  }
  return match;
}

/**
 * A binding a package writes on a definition's features ({@link
 * outsideBindingsOf}), with each end's path below the definition — or
 * `undefined` for an end that is one instance wherever it is read.
 */
export interface OutsideBinding {
  binding: ElementRecord;
  ends: readonly [string | undefined, string | undefined];
}

/**
 * The bindings a package writes on the features of the definition
 * `definitionId` (w4: `bind P::load = L`), each with its ends: the path below
 * the definition of an end that is one of its features (`load`), `undefined`
 * for an end of no definition — the package's `L`, one instance wherever it is
 * read. Such a binding holds in every instance of the definition, as one the
 * definition writes does: the numeric and SMT lanes read it for each instance
 * they read, over that instance's own symbols, as the check reads it
 * ({@link definitionHeadMatch}). One whose other end is a feature of another
 * definition is not listed. Once per revision.
 */
export function outsideBindingsOf(model: Model, definitionId: ElementId): readonly OutsideBinding[] {
  if (!hasUserBindings(model)) return [];
  const ends = bindingEnds(model);
  if (!ends.outside) {
    const outside = new Map<ElementId, OutsideBinding[]>();
    const definitions = sharedDefinitions(model);
    for (const b of ends.connectors) {
      const holder = b.ownerId != null ? model.get(b.ownerId) : undefined;
      if (!holder || !isPackage(holder)) continue;
      // Each end at its path in the package, as the package's reading spells it.
      const paths = [b.source?.[0], b.target?.[0]].map((id) => (id !== undefined ? bindingEndPath(model, id, holder.id) : undefined));
      if (paths[0] === undefined || paths[1] === undefined) continue;
      const heads = paths.map((p) => definitionHeadOf(model, definitions, holder.id, p!));
      const definition = (heads[0] ?? heads[1])?.definition;
      if (!definition || heads.some((h) => h !== undefined && h.definition.id !== definition.id)) continue;
      // An end of no definition is a feature of the package: one instance (`undefined`).
      const below = heads.map((h) => (h ? h.tail.map((f) => definitions.nameOf(f) ?? '').join('.') : undefined));
      const list = outside.get(definition.id) ?? [];
      list.push({ binding: b, ends: [below[0], below[1]] });
      outside.set(definition.id, list);
    }
    ends.outside = outside;
  }
  return ends.outside.get(definitionId) ?? [];
}

/**
 * The OUTERMOST frame root whose instance prefixes the instance `symbol` —
 * the symbol itself, or a prefix of it up to a `::` — and whose binding
 * reading holds the rest of the path, with the component and the feature at
 * that path: the one with the fewest `::` segments, the first in reading
 * order among equals. Each prefix of the symbol is looked up in
 * {@link readingsByInstance}; the answer is the one a scan of every root
 * would give. A path a package's reading does not hold is read through a
 * binding written there on a definition's feature ({@link
 * definitionHeadMatch}: `head`). `undefined` where no binding reading holds
 * the symbol.
 */
function outermostReading(
  model: Model,
  symbol: string,
): { root: ElementId; component: string; feature: ElementId; head?: DefinitionHead } | undefined {
  const { readings } = bindingEnds(model);
  const byInstance = readingsByInstance(model);
  let best: { root: ElementId; component: string; feature: ElementId; head?: DefinitionHead } | undefined;
  let bestSegments = Number.POSITIVE_INFINITY;
  let bestOrder = Number.POSITIVE_INFINITY;
  const consider = (inst: string): void => {
    const roots = byInstance.get(inst);
    if (!roots) return;
    const rest = symbol === inst ? '' : symbol.slice(inst.length + 2);
    const path = rest.split('::').join('.');
    const segments = inst.split('::').length;
    for (const { root, order } of roots) {
      const head = readings.get(root)?.has(path) ? undefined : definitionHeadMatch(model, root, path);
      const r = head ?? readings.get(root)?.get(path);
      if (!r) continue;
      // The roots of one instance are in reading order: the first that holds the path is this prefix's answer.
      if (segments < bestSegments || (segments === bestSegments && order < bestOrder)) {
        best = { root, component: r.component, feature: r.feature, ...(head ? { head } : {}) };
        bestSegments = segments;
        bestOrder = order;
      }
      return;
    }
  };
  consider(symbol);
  for (let i = symbol.indexOf('::'); i >= 0; i = symbol.indexOf('::', i + 1)) consider(symbol.slice(0, i));
  return best;
}

/** The instance of the feature the member `path` of `root` names, for {@link boundSourceIn}'s own-path check. */
function memberInstance(definitions: DefiningEquations, root: ElementId, path: string): string | undefined {
  if (path.startsWith('#')) {
    const f = definitions.model.get(path.slice(1));
    return f ? definitions.instanceNameOf(f.id) : undefined;
  }
  const d = definitions.denote(root).get(path);
  if (!d) return undefined;
  return `${d.instance}::${definitions.nameOf(d.feature) ?? ''}`;
}

/**
 * The first connector of a binding component in words — `` `bind p.load = L` ``
 * and ` of D1E::Q`, the element that writes it — and whether both its ends have
 * a path there (`ends`); `a binding` where they do not.
 */
function componentBindingWords(model: Model, root: ElementId, component: string): { bind: string; of: string; ends: boolean } {
  const connector = componentConnectors(model, root, component)[0];
  const read = connector ? bindingHolder(model, connector) : undefined;
  const ends = read !== undefined && read.left !== undefined && read.right !== undefined;
  const holder = read ? effectiveQualifiedName(model, read.holder.id) : undefined;
  return { bind: ends ? `\`bind ${read!.left} = ${read!.right}\`` : 'a binding', of: holder !== undefined ? ` of ${holder}` : '', ends };
}

/**
 * The element a binding connector is read in — where it is written, or, where
 * one end is a feature of an instance enclosing that usage (R's `L` in `part q :
 * Q { bind p.load = L; }`), the nearest element around it below which both ends
 * lie (R, at `q.p.load` and `L`) — with each end's path there; an end with no
 * path there is `undefined`. Its own row (`#bind`) is read there, and in every
 * context that changes what it joins there.
 */
export function bindingHolder(
  model: Model,
  b: ElementRecord,
): { holder: ElementRecord; left: string | undefined; right: string | undefined } | undefined {
  let holder = b.ownerId != null ? model.get(b.ownerId) : undefined;
  if (!holder) return undefined;
  let left = bindingEndPath(model, b.source?.[0], holder.id);
  let right = bindingEndPath(model, b.target?.[0], holder.id);
  const seen = new Set<ElementId>();
  while (isUsage(holder.eClass) && holder.ownerId != null && (left === undefined) !== (right === undefined) && !seen.has(holder.id)) {
    seen.add(holder.id);
    const up = model.get(holder.ownerId);
    if (!up) break;
    const [l, r] = [bindingEndPath(model, b.source?.[0], up.id), bindingEndPath(model, b.target?.[0], up.id)];
    holder = up;
    left = l;
    right = r;
  }
  return { holder, left, right };
}

/**
 * Why a binding component gives no value, in the A.9 sentence — `two-values`
 * pointing at the binding's own finding, which a package's binding on a
 * definition's feature does not file (`finding` false). One whose end is
 * outside the element that writes it (R's `L` in `part q : Q { bind p.load =
 * L; }`, EB4) files it in the element around it that holds both ends
 * ({@link bindingHolder}).
 */
function abstentionSentence(
  model: Model,
  symbol: string,
  root: ElementId,
  component: string,
  kind: 'free' | 'defaults-differ' | 'two-values',
  finding = true,
): string {
  const sep = symbol.lastIndexOf('::');
  const name = sep >= 0 ? symbol.slice(sep + 2) : symbol;
  const instance = sep >= 0 ? symbol.slice(0, sep) : '';
  const members = componentPaths(model, root, component);
  const { bind, of, ends } = componentBindingWords(model, root, component);
  if (kind === 'two-values') {
    return (
      `${name} is not read in ${instance}: ${bind}${of} joins two values the model states (${members.join(', ')}), ` +
      'and a binding holds in every instance' +
      (finding && ends ? ' (see the binding\u2019s own finding)' : '')
    );
  }
  if (kind === 'defaults-differ') {
    return (
      `${name} has no value in ${instance}: ${bind}${of} joins defaults that differ or are not constants ` +
      `(${members.join(', ')}), and the model states neither`
    );
  }
  return `${name} has no value in ${instance}: ${bind}${of} joins it to ${members.join(', ')}, and none of them states one`;
}

/**
 * One question a per-instance reading asked of an instance's SPELLING, with
 * the answer it got: where a binding carries a value into it ({@link
 * boundSourceIn}), whether a held default stands there ({@link
 * defaultStandsIn}) or gives way ({@link defaultGivesWayIn}), what an
 * enclosing asserted equation defines there ({@link assertDefinitionIn}), and
 * whether an enclosing assert constrains a read there ({@link
 * enclosingAssertOn}). These are the only places a reading decides anything
 * by an instance's spelling;
 * everywhere else it passes the spelling on, extends it (`${inst}::x`, {@link
 * rebaseInstance}), keys a memo with it, or prints it. A memo keyed with it
 * keeps the lookups each entry was worked out with ({@link lookupsWhile}) and
 * records them again at every hit ({@link replayLookups}), so a reading asked
 * them whether it worked a value out or took it from the memo. So two
 * instances whose questions get the same answers are read alike ({@link
 * lookupsHold}).
 */
export type InstanceLookup =
  | { kind: 'source'; symbol: string; answer: BoundSource | undefined }
  | { kind: 'stands'; symbol: string; answer: ElementRecord | undefined }
  | { kind: 'gives-way'; feature: ElementRecord; inst: string; answer: boolean }
  | { kind: 'asserted'; feature: ElementRecord; inst: string; answer: string }
  | {
      kind: 'enclosing';
      contextId: ElementId;
      enclosing: readonly InstanceFrame[];
      name: string;
      inst: string;
      answer: { frame: ElementId; expr: string } | undefined;
    };

/** The lookups of the reading {@link recordingLookups} is recording, while it runs. */
let recording: InstanceLookup[] | undefined;

/**
 * Run `read`, and return what it gave with every {@link InstanceLookup} it
 * made, in order. A reading recorded inside another's is recorded in both.
 */
export function recordingLookups<T>(read: () => T): { value: T; lookups: InstanceLookup[] } {
  const outer = recording;
  const lookups: InstanceLookup[] = [];
  recording = lookups;
  try {
    return { value: read(), lookups };
  } finally {
    recording = outer;
    if (outer) for (const l of lookups) outer.push(l);
  }
}

/**
 * Work out a memo entry keyed on an instance — `read` — and return its value
 * with the lookups it made, each question once ({@link lookupKey}), to be kept
 * beside the entry and said again at every hit ({@link replayLookups}). They
 * are recorded for the reading the entry is worked out in too, as {@link
 * recordingLookups} records them.
 */
export function lookupsWhile<T>(read: () => T): { value: T; lookups: readonly InstanceLookup[] } {
  const outer = recording;
  const lookups: InstanceLookup[] = [];
  recording = lookups;
  let asked: readonly InstanceLookup[] = lookups;
  try {
    const value = read();
    asked = distinctLookups(lookups);
    return { value, lookups: asked };
  } finally {
    recording = outer;
    if (outer) for (const l of asked) outer.push(l);
  }
}

/**
 * Record `lookups` — the questions a memo entry keyed on an instance was
 * worked out with ({@link lookupsWhile}) — for the reading being recorded, if
 * any. A memo hit gives the entry's value without asking them again, and the
 * reading that takes it reads that value all the same: a reading whose every
 * value came from the memo recorded no question of its instance, and every
 * other instance of the group took its verdict ({@link lookupsHold}) — Sh1's
 * `m <= 10.0` read q2's p at q1's m of 4, worked out for `m <= 1000.0` just
 * before, and held where q2's m is 100.
 */
export function replayLookups(lookups: readonly InstanceLookup[] | undefined): void {
  if (recording !== undefined && lookups !== undefined) for (const l of lookups) recording.push(l);
}

/** `lookups`, each question once, in order: a memo entry's replayed list stays as long as the questions it asks. */
function distinctLookups(lookups: readonly InstanceLookup[]): readonly InstanceLookup[] {
  if (lookups.length < 2) return lookups;
  const seen = new Set<string>();
  const out: InstanceLookup[] = [];
  for (const l of lookups) {
    const key = lookupKey(l);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}

/** The question a lookup asks, as a key: two lookups with one key asked the same, and were answered the same. */
function lookupKey(l: InstanceLookup): string {
  if (l.kind === 'source' || l.kind === 'stands') return `${l.kind} ${l.symbol}`;
  if (l.kind === 'gives-way' || l.kind === 'asserted') return `${l.kind} ${l.feature.id} ${l.inst}`;
  return `${l.kind} ${l.contextId} ${l.name} ${l.inst} ${l.enclosing.map((f) => `${f.reader}@${f.instance}`).join(' ')}`;
}

/**
 * The lookups among `lookups` (recorded reading the instance `inst`) whose
 * question spells `inst` — the rest ask the same of every instance — each
 * once, in order: what {@link lookupsHold} asks again of another instance.
 */
export function lookupsOf(lookups: readonly InstanceLookup[], inst: string): InstanceLookup[] {
  const spells = (s: string): boolean => spellsInstance(s, inst);
  const seen = new Set<string>();
  const out: InstanceLookup[] = [];
  for (const l of lookups) {
    if (l.kind === 'source' || l.kind === 'stands') {
      if (!spells(l.symbol)) continue;
    } else if (l.kind === 'gives-way' || l.kind === 'asserted') {
      if (!spells(l.inst)) continue;
    } else if (!spells(l.inst) && !l.enclosing.some((f) => spells(f.instance))) {
      continue;
    }
    const key = lookupKey(l);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}

/**
 * Would a reading for the instance `to` get the answers `lookups` record for
 * `from` ({@link lookupsOf})? Each question is asked again, `from`'s spelling
 * replaced by `to`'s where it begins one. Where every answer is the same, a
 * reading for `to` takes the path the reading for `from` took — it reads the
 * same values from the same sources and comes to the same verdict — and only
 * the spellings that extend `from` change (tree10: the 512 instances of
 * `T1::a` under `top` each read top's L through one component). An answer
 * that abstains is never the same: its sentence names its instance.
 */
export function lookupsHold(model: Model, lookups: readonly InstanceLookup[], from: string, to: string): boolean {
  const outer = recording;
  recording = undefined;
  try {
    for (const l of lookups) {
      if (l.kind === 'source') {
        if (!sameSource(l.answer, boundSourceIn(model, respell(l.symbol, from, to)))) return false;
      } else if (l.kind === 'stands') {
        if (defaultStandsIn(model, respell(l.symbol, from, to)) !== l.answer) return false;
      } else if (l.kind === 'gives-way') {
        if (defaultGivesWayIn(model, l.feature, respell(l.inst, from, to)) !== l.answer) return false;
      } else if (l.kind === 'asserted') {
        if (assertedKey(assertDefinitionIn(model, l.feature, respell(l.inst, from, to))) !== l.answer) return false;
      } else {
        const enclosing = l.enclosing.some((f) => respell(f.instance, from, to) !== f.instance)
          ? l.enclosing.map((f) => ({ instance: respell(f.instance, from, to), reader: f.reader }))
          : l.enclosing;
        const a = enclosingAssertOn(model, l.contextId, enclosing, l.name, respell(l.inst, from, to));
        if (a?.frame !== l.answer?.frame || a?.expr !== l.answer?.expr) return false;
      }
    }
    return true;
  } finally {
    recording = outer;
  }
}

/** `s`, the instance `from` it begins with (or is) spelled `to` instead; any other spelling as it is. */
function respell(s: string, from: string, to: string): string {
  if (s === from) return to;
  return spellsInstance(s, from) ? `${to}${s.slice(from.length)}` : s;
}

/** Is `s` the instance `inst`, or a spelling below it (`${inst}::…`)? */
export function spellsInstance(s: string, inst: string): boolean {
  return s === inst || (s.length >= inst.length + 2 && s.startsWith(inst) && s.startsWith('::', inst.length));
}

/**
 * Do two {@link boundSourceIn} answers read the same member of the same
 * component in the same root — so the same paths, through the same
 * connectors, which are the component's own ({@link componentFacts})? Never
 * an abstention.
 */
function sameSource(a: BoundSource | undefined, b: BoundSource | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if ('abstain' in a || 'abstain' in b) return false;
  return a.root === b.root && a.component === b.component && a.via.source === b.via.source;
}

/**
 * The source of the value a name read at the instance `symbol` gets through a
 * binding (A.2.2): the OUTERMOST frame root whose generic instance prefixes
 * `symbol` and whose readings hold the rest of the path, its component
 * classified ({@link classified}) and resolved as A.3 does — one valued member
 * (read, unless it is the name's own path), else one readable `default`, else
 * `two-values`, `defaults-differ` or `free`. `undefined` where no binding
 * holds `symbol`. Once per symbol and revision: every instance reading of a
 * sweep asks it per name, and the check, the numeric lane and the unit-aware
 * twin ask the same symbols again. The answer is shared, and frozen with its
 * lists — read it, never change it.
 */
export function boundSourceIn(model: Model, symbol: string): BoundSource | undefined {
  const source = boundSourceMemo(model, symbol);
  recording?.push({ kind: 'source', symbol, answer: source });
  return source;
}

/** {@link boundSourceIn}, once per symbol and revision. */
function boundSourceMemo(model: Model, symbol: string): BoundSource | undefined {
  if (!hasUserBindings(model)) return undefined;
  const ends = bindingEnds(model);
  const memo = (ends.sources ??= new Map());
  const hit = memo.get(symbol);
  if (hit !== undefined || memo.has(symbol)) return hit;
  const source = boundSourceOf(model, symbol);
  if (source !== undefined && !('abstain' in source)) Object.freeze(source.via);
  memo.set(symbol, source === undefined ? undefined : Object.freeze(source));
  return source;
}

/** {@link boundSourceIn}, worked out. */
function boundSourceOf(model: Model, symbol: string): BoundSource | undefined {
  const definitions = sharedDefinitions(model);
  const best = outermostReading(model, symbol);
  if (!best) return undefined;
  // A name defined by an asserted equation in a general definition — the G340
  // family, where the binding's implicit end copy masks the assert: the value
  // is the equation's, not the binding's, and no per-instance value is read
  // here (today's reading abstains).
  const member = model.get(best.feature);
  if (
    member &&
    [member, ...redefinedClosure(model, member)].some(
      (g) => definitions.of(g.ownerId ?? best.root, definitions.nameOf(g) ?? '').length > 0,
    )
  ) {
    return undefined;
  }
  // A binding read nowhere this tool finds an instance of one of its ends
  // ({@link BindingEnds.unread}) reads no value per instance (A.3).
  const { unread, overCap } = bindingEnds(model);
  const carried = member ? definitions.carrier(best.root, member).id : undefined;
  if (member && (unread.has(member.id) || (carried !== undefined && unread.has(carried)))) return undefined;
  // Past a cap for THIS binding (A.3), no bound value is read for any one
  // instance: the frame that carries the value may be one the cap dropped. So
  // too for a binding joined to a capped one in the global component of the
  // connectors' ends ({@link pastCapComponents}: CAP1's Y, bound to the load a
  // capped binding gives 50); a cap no binding of it reaches never abstains it.
  const capped = member ? (overCap.get(member.id) ?? (carried !== undefined ? overCap.get(carried) : undefined)) : undefined;
  if (capped !== undefined) return { abstain: 'past-cap', sentence: bindingCapSentence(capped) };
  // A package's binding between two features of definitions (`bind P::load =
  // P::cap`) joins them in every instance, each at its own value there: read
  // in the package, the component holds P's own — no value for any instance.
  if (best.head && pairedHeads(model, best.root, best.component)) {
    return { abstain: 'free', sentence: pairedHeadsSentence(model, symbol, best.root, best.component) };
  }
  // A binding whose end is a feature of an instance ENCLOSING where it is
  // written (R's `L` in `part q : Q { bind p.load = L; }`) is read in that
  // enclosing instance (E3): the outermost root's reading holds the end at
  // the path its climb reached it by (`r.L` for r's q), so r's q reads r's L,
  // and r0's q r0's.
  const cls = classified(model, best.root, best.component);
  // The member paths and the connectors are the component's own: one list each
  // for every symbol read through it ({@link componentFacts}), never copied.
  const source = (valuePath: string): BoundSource => ({
    root: best!.root,
    paths: componentPaths(model, best!.root, best!.component),
    component: best!.component,
    via: { bindingIds: componentBindingIds(model, best!.root, best!.component), source: valuePath },
  });
  if (cls.valued.length > 1) {
    return { abstain: 'two-values', sentence: abstentionSentence(model, symbol, best.root, best.component, 'two-values') };
  }
  if (cls.valued.length === 1) {
    // The member that states the value IS the name's own path: today's reading
    // already answers it, and the fallback adds nothing.
    if (memberInstance(definitions, best.root, cls.valued[0]!) === symbol) return undefined;
    return source(cls.valued[0]!);
  }
  // A readable default: the one that is not the name's own path (a binding
  // INTO a feature with nothing of its own carries the source's default, K's
  // `bind w = x` over `x default = 5.0`). The name's own default is no value
  // the binding gives it — the partner supplies none either (the G340 family).
  const readable = cls.readable.find((p) => memberInstance(definitions, best.root, p) !== symbol);
  if (readable !== undefined) return source(readable);
  // A package's binding on a definition's feature whose slot an instance
  // fixes outside the component ({@link DefinitionHead.fixed}) says so, not
  // that no member states a value.
  const fixed = bindingEnds(model).heads.get(best.root)?.find((h) => h.component === best.component && fixesSlot(h));
  if (cls.heldDefaults.length > 0) {
    return {
      abstain: 'defaults-differ',
      sentence: fixed
        ? fixedHeadSentence(model, symbol, best.root, best.component, fixed)
        : abstentionSentence(model, symbol, best.root, best.component, 'defaults-differ'),
    };
  }
  return {
    abstain: 'free',
    sentence: fixed
      ? fixedHeadSentence(model, symbol, best.root, best.component, fixed)
      : abstentionSentence(model, symbol, best.root, best.component, 'free'),
  };
}

/**
 * Two members of a binding component read in `root` that each give a value —
 * `own`, the member a name read at an instance is, and `written`, one whose
 * value is written with `=` — by their paths there ({@link
 * statedAgainstBoundIn}, {@link definedAgainstBoundIn}), for a caller that
 * evaluates both where the component's valued members are read (A.2.3).
 */
export interface BoundPair {
  root: ElementId;
  own: string;
  written: string;
  /** The instance symbols of the two members: the evaluation reads each where it is stated. */
  symbols: readonly string[];
  /**
   * `own` is the member an asserted equation defines ({@link definedAgainstBoundIn}): it is read through
   * that equation, as the check reads it, never through the binding it is compared with.
   */
  defined?: true;
}

/**
 * How the two values of a {@link BoundPair} compare, evaluated exactly —
 * `undecided` where the evaluation does not decide it. The evaluation is the
 * unit-aware reader's (`boundPairAt` of ./units-eval), which this module
 * does not import; every caller passes that one, so the readings agree.
 */
export type DecidePair = (pair: BoundPair) => WrittenComparison;

/**
 * Why the value `f` states with `=`, read at the instance `inst`, is not read
 * there: a binding joins it to another value written with `=` that DIFFERS
 * from it (A.5, U11) — `part q : Q { part :>> p { attribute :>> load = 30.0;
 * } }` under Q's `L = 50.0` and `bind p.load = L` (d1plain), or `part p4 : P
 * { attribute :>> load = 7.0; }` under a package's `bind P::load = L`
 * (w4-plain). A value written with `=` is a binding too, so the model states
 * both, and neither is read where the binding joins them: the A.9 `two-values`
 * sentence, with the binding's own row reporting the pair
 * ({@link bindsDifferingWrittenValues}) — none for a package's binding on a
 * definition's feature, whose package-side value, one instance, is still read
 * at its own. The values are compared as
 * written ({@link compareWrittenValues}), as {@link contradictedBindingOf}
 * compares a redefinition with the binding it redefines. A pair only an
 * evaluation could compare (`load = 30.0` against `L = 2.0 * K`, D1E; M7Y's
 * `load = 1.0` against it, which meets it at Q's own K and not at q2's) is
 * evaluated, both values where the binding's valued members are read
 * (`decide`): one value where the two meet exactly (D1C's `load = 50.0` at K
 * 25), and two where they differ. Where the evaluation decides neither, the
 * value is not read either, in a sentence of its own: whether the two meet
 * takes an evaluation this tool does not make there, and read as before, the
 * one value was read where the model states both (false on every surface but
 * the SMT engine's inconsistent axioms). The binding's finding judges that
 * pair at the two values as written ({@link bindsUndecidedWrittenValues}).
 * `undefined` where `f` writes no `=` value, no binding joins it at `inst`, or
 * every value written there is the same as it.
 */
export function statedAgainstBoundIn(model: Model, f: ElementRecord, inst: string, decide: DecidePair): string | undefined {
  // Asked first, per feature: no instance is asked anything of the others.
  if (!statedAgainstBoundSomewhere(model, f)) return undefined;
  const name = sharedDefinitions(model).nameOf(f);
  if (name === undefined) return undefined;
  const symbol = `${inst}::${name}`;
  const src = boundSourceIn(model, symbol);
  if (src === undefined || ('abstain' in src && src.abstain !== 'two-values')) return undefined;
  const best = outermostReading(model, symbol);
  const reading = best ? bindingEnds(model).readings.get(best.root) : undefined;
  // The member the symbol names states `f`'s value, or is the slot `f` redefines (a package's head).
  const own = best ? model.get(best.feature) : undefined;
  if (!best || !reading || !own || !(valueSourceOf(model, own) === f || redefinedClosure(model, f).includes(own))) {
    return undefined;
  }
  let differs = false;
  let undecided: ElementRecord | undefined;
  for (const path of classified(model, best.root, best.component).valued) {
    const member = reading.get(path);
    const g = member ? model.get(member.feature) : undefined;
    const written = g ? valueSourceOf(model, g) : undefined;
    // A value an asserted equation states is not written to compare: today's reading stands beside it.
    if (written === undefined || written === f || written.attrs.defaultValue === true) continue;
    let compared = compareWrittenValues(f, written);
    if (compared === 'undecided') {
      const mine = ownPathOf(model, best.root, best.component, symbol);
      if (mine !== undefined && !path.startsWith('#')) compared = decide(boundPair(model, best.root, mine, path, symbol));
    }
    if (compared === 'differs') differs = true;
    else if (compared === 'undecided') undecided ??= written;
  }
  if (differs) return 'abstain' in src ? src.sentence : abstentionSentence(model, symbol, best.root, best.component, 'two-values', false);
  if (undecided === undefined) return undefined;
  const sep = symbol.lastIndexOf('::');
  const { bind, of } = componentBindingWords(model, best.root, best.component);
  return (
    `${symbol.slice(sep + 2)} is not read in ${symbol.slice(0, sep)}: ${bind}${of} joins ${writtenName(model, f)} = ` +
    `${writtenValue(f)} to ${writtenName(model, undecided)} = ${writtenValue(undecided)}, two values written with ` +
    '`=` that are not the same as written, and a binding holds in every instance; whether the two meet there takes ' +
    'an evaluation this tool does not make, so neither is read'
  );
}

/**
 * The path, in `root`'s reading of `component`, of the member that IS the
 * instance symbol `symbol` ({@link memberInstance}) — not a package's head
 * (`#id`) — or `undefined`.
 */
function ownPathOf(model: Model, root: ElementId, component: string, symbol: string): string | undefined {
  const definitions = sharedDefinitions(model);
  return componentPaths(model, root, component).find((p) => !p.startsWith('#') && memberInstance(definitions, root, p) === symbol);
}

/** The {@link BoundPair} of the members `own` (the instance symbol `symbol`) and `written` of `root`'s reading. */
function boundPair(model: Model, root: ElementId, own: string, written: string, symbol: string): BoundPair {
  const other = memberInstance(sharedDefinitions(model), root, written);
  return { root, own, written, symbols: other !== undefined ? [symbol, other] : [symbol] };
}

/**
 * {@link definedAgainstBoundIn}'s answer: the two values are decided to
 * differ (`differs`, a contradiction the binding's own row reports), or
 * whether they meet is not decided (`undecided`); the sentence says which.
 */
export interface DefinedAgainst {
  verdict: 'differs' | 'undecided';
  sentence: string;
}

/**
 * Why `feature`, read at `instance` under `name`, is not read there: it states
 * no value, an asserted equation of the element that declares it (or of one
 * whose feature it redefines, or of the element that denotes the instance —
 * q1's `part :>> p { assert … }`) defines it, and a binding joins it there to
 * another member that states a value written with `=` that the equation does
 * not give it — RBL2's `part p : P { assert constraint { x == 3.0 } }` under
 * q's `attribute L = 4.0; bind p.x = L;`. The model states two values for it
 * (strict KerML: a binding holds in every instance), so it is not read, as
 * A.5 reads neither of two written values ({@link statedAgainstBoundIn}); the
 * binding's own row reports the pair. Read as before, the check took the
 * equation's 3 and the numeric surface the binding's 4: `q.p.x <= 3.5` was T
 * on the one and F on the other. Where the equation restates the value
 * exactly — as written, or evaluated where the binding's valued members are
 * read (`decide`: RY4's `x == y * 2.0` at y 1.5 against `L = 3.0`) — the two
 * are one value, and it is read as before; where neither decides it, it is
 * not read either, in a sentence of its own (`undecided`: whether the two meet
 * takes an evaluation this tool does not make). So with a member whose
 * `default` stands against the equation, as every one does since decision 14
 * was amended ({@link BindingEnds.standing}: H2f's L0, H2f reading as its `=`
 * twin). A binding to a member with no value of its own carries the
 * equation's value, as before; a `default` the binding holds (one given way
 * to a value written with `=`) is none. `undefined` where any of that does
 * not hold.
 */
export function definedAgainstBoundIn(
  model: Model,
  feature: ElementRecord,
  instance: string,
  name: string,
  decide: DecidePair,
): DefinedAgainst | undefined {
  if (!hasUserBindings(model) || hasStatedValue(model, feature)) return undefined;
  const memo = (bindingEnds(model).definedAgainst ??= new Map());
  const key = `${feature.id} ${instance}::${name}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit ?? undefined;
  const found = definedAgainstBoundUncached(model, feature, instance, name, decide);
  memo.set(key, found ?? null);
  return found;
}

/** {@link definedAgainstBoundIn}, worked out. */
function definedAgainstBoundUncached(
  model: Model,
  feature: ElementRecord,
  instance: string,
  name: string,
  decide: DecidePair,
): DefinedAgainst | undefined {
  const definitions = sharedDefinitions(model);
  const symbol = `${instance}::${name}`;
  const best = outermostReading(model, symbol);
  const reading = best ? bindingEnds(model).readings.get(best.root) : undefined;
  const own = best ? model.get(best.feature) : undefined;
  if (!best || !reading || !own || hasStatedValue(model, own)) return undefined;
  // The feature read (a generic `P::x`, read per instance) and the member the
  // binding holds there (p's end copy, whose element writes the equation) —
  // after the element that denotes the instance, whose own asserts define it
  // there first (RBL4: q1's `part :>> p { assert constraint { x == 3.0 } }`
  // under Q's `bind p.x = L`, read T on the check against F on the numeric
  // surface while only the end copy's and P's owners were asked).
  const read = [feature, ...redefinedClosure(model, feature)];
  const held = [own, ...redefinedClosure(model, own)];
  // A value of its own anywhere it redefines (P's `x = 3.0` beside an `x ==
  // 4.0`) is the feature's, and the equation a check of it: where the equation
  // does not give it the bound value, that is no contradiction of the
  // binding's (A.5 compares the two written values), so the pair is never
  // `differs` — the binding's own row is judged as before — but the feature is
  // still not read there, where the check took the equation's 4 and the
  // numeric surface the 3 (G304).
  const stated = [...held, ...read].find((g) => hasStatedValue(model, g));
  const sites: Array<{ site: ElementId; name: string }> = [];
  const element = denotingElementOf(definitions, instance);
  if (element) sites.push({ site: element.id, name });
  for (const g of [...held, ...read]) {
    const n = definitions.nameOf(g);
    if (n !== undefined && g.ownerId != null) sites.push({ site: g.ownerId, name: n });
  }
  let equations: readonly DefiningEquation[] = [];
  for (const s of sites) {
    equations = definitions.of(s.site, s.name);
    if (equations.length > 0) break;
  }
  if (equations.length === 0) return undefined;
  const closure = new Set([...read, ...held].map((g) => g.id));
  const constants = equations.map((eq) => exactConstant(eq.definition, eq.literals));
  const { standing, standingAt } = bindingEnds(model);
  let found: { verdict: DefinedAgainst['verdict']; written: ElementRecord } | undefined;
  for (const path of classified(model, best.root, best.component).valued) {
    const member = reading.get(path);
    const g = member ? model.get(member.feature) : undefined;
    const written = g ? valueSourceOf(model, g) : undefined;
    if (!g || !written || closure.has(g.id) || closure.has(written.id)) continue;
    if (written.attrs.defaultValue === true && !standing.has(g.id) && !standingAt.has(`${best.root} ${path}`)) continue;
    if (memberInstance(definitions, best.root, path) === symbol) continue;
    // An equation that restates the written value exactly gives the one value:
    // compared as written where both are constants, else evaluated.
    const w = constantOf(written);
    let compared: WrittenComparison = 'undecided';
    if (w && constants.every((c) => c !== undefined)) {
      const each = constants.map((c) => compareConstants(c!, w));
      compared = each.every((x) => x === 'same') ? 'same' : each.some((x) => x === 'differs') ? 'differs' : 'undecided';
    }
    if (compared === 'undecided' && !path.startsWith('#')) {
      const mine = ownPathOf(model, best.root, best.component, symbol);
      if (mine !== undefined) compared = decide({ ...boundPair(model, best.root, mine, path, symbol), defined: true });
    }
    if (compared === 'same') continue;
    if (compared === 'differs' && stated === undefined) {
      found = { verdict: 'differs', written };
      break;
    }
    found ??= { verdict: 'undecided', written };
  }
  const eq = equations[0]!.constraint;
  if (!found) {
    const viaHead = definedAgainstHead(model, best.root, best.component, constants, stated);
    if (!viaHead) return undefined;
    const { bind, of } = componentBindingWords(model, best.root, best.component);
    const words = componentBindingWords(model, viaHead.root, viaHead.head.component);
    return {
      verdict: viaHead.verdict,
      sentence:
        `${name} is not read in ${instance}: ${effectiveQualifiedName(model, eq.ownerId ?? eq.id)}'s asserted ` +
        `\`${String(eq.attrs.expression ?? '').trim()}\` defines it, and ${bind}${of} joins it to ${viaHead.slot}, which ` +
        `${words.bind}${words.of} joins to ${standingText(model, viaHead.written)} in every instance of ` +
        `${effectiveQualifiedName(model, viaHead.head.definition.id)}` +
        (viaHead.verdict === 'differs'
          ? ', which differs from the one the equation gives it: the model states two values for it there, and it is not read'
          : ': whether the two meet there takes an evaluation this tool does not make, so it is not read'),
    };
  }
  const { bind, of } = componentBindingWords(model, best.root, best.component);
  const head =
    `${name} is not read in ${instance}: ${effectiveQualifiedName(model, eq.ownerId ?? eq.id)}'s asserted ` +
    `\`${String(eq.attrs.expression ?? '').trim()}\` defines it, and ${bind}${of} joins it to ${standingText(model, found.written)}`;
  if (stated !== undefined) {
    return {
      verdict: 'undecided',
      sentence:
        `${head}, beside its own \`${writtenValue(stated)}\` (${writtenName(model, stated)}): a binding holds in every ` +
        'instance, and the equation does not give it the value the binding joins it to there, so it is not read',
    };
  }
  return {
    verdict: found.verdict,
    sentence:
      found.verdict === 'differs'
        ? `${head} that differs from the one the equation gives it there: a binding holds in every instance, so the ` +
          'model states two values for it, and it is not read (see the binding’s own finding)'
        : `${head}: a binding holds in every instance, and whether the two meet there takes an evaluation this tool ` +
          'does not make, so it is not read',
  };
}

/**
 * A value a binding joins an asserted equation's feature to, named as written
 * ({@link definedAgainstBoundIn}): `L0 = 1.0, a value written with \`=\`` —
 * or a standing `default`, with why it counts as one: `P::L0's \`default =
 * 1.0\`, a value no assertion replaces (as one written with \`=\`)`.
 */
function standingText(model: Model, written: ElementRecord): string {
  return written.attrs.defaultValue === true
    ? `${writtenName(model, written)}'s \`default = ${writtenValue(written)}\`, a value no assertion replaces (as one written with \`=\`)`
    : `${writtenName(model, written)} = ${writtenValue(written)}, a value written with \`=\``;
}

/**
 * Why `f`, a feature with no value of its own and no equation, is not read
 * through its binding class (`boundDerivation` of ./units-eval): the class
 * joins it both to `defined`, a member an asserted equation (`constraintId`)
 * defines, and to `stated`, a member with a value the model states — written
 * with `=`, or a `default` no assertion replaces — and the two are not the one
 * value (`differs`), or only an evaluation this tool does not make would say
 * (`undecided`). T1C's M under `bind L = M; bind M = L0;`, beside the asserted
 * `L == 50.0` and L0's `default = 1.0`: read through L, M was 50 on the check
 * and the literal engine where the numeric surface read L0's 1. L is not read
 * there either ({@link definedAgainstBoundIn}), in the same words.
 */
export function boundAgainstAssertSentence(
  model: Model,
  f: ElementRecord,
  defined: ElementRecord,
  stated: ElementRecord,
  constraintId: ElementId | undefined,
  verdict: 'differs' | 'undecided',
): string {
  const owner = f.ownerId != null ? effectiveQualifiedName(model, f.ownerId) : undefined;
  const eq = constraintId !== undefined ? model.get(constraintId) : undefined;
  const by = eq
    ? `which ${effectiveQualifiedName(model, eq.ownerId ?? eq.id)}'s asserted \`${String(eq.attrs.expression ?? '').trim()}\` defines`
    : 'which an asserted equation defines';
  const written = valueSourceOf(model, stated) ?? stated;
  return (
    `${effectiveNameOf(model, f) ?? writtenName(model, f)} is not read${owner ? ` in ${owner}` : ''}: a binding joins it to ` +
    `${writtenName(model, defined)}, ${by}, and to ${standingText(model, written)}` +
    (verdict === 'differs'
      ? ', which differs from the one the equation gives: a binding holds in every instance, so the model states two values for it, and it is not read (see the binding’s own finding)'
      : ': whether the two meet takes an evaluation this tool does not make, so it is not read')
  );
}

/**
 * The value a package head ({@link DefinitionHead}) carries into a member of
 * the component `component` read in `root`, where that member is the head's
 * slot at an instance and asserted equations alone give the component a value
 * ({@link BindingEnds.headSlots}): W4X3A's `bind p2.load = L` beside `assert
 * constraint { L == 5.0 }` joins L to p2's load, which the package's `bind
 * P::load = M` joins to M in every instance of P — M's `default = 9.0`
 * standing, as `M = 9.0` does. The two components are one value at p2: the
 * equation's 5 and M's 9 are two values, and L is read nowhere ({@link
 * definedAgainstBoundIn}); read alone, it was 5 on the check and the numeric
 * surface, where the model gives it 9 as well. `differs` where the equation's
 * constant and the written value are two constants that differ, `undecided`
 * where they are not both constants, or the feature states a value of its own
 * (`stated`); `undefined` where the head's component states nothing, or what
 * it states is the equation's value exactly.
 */
function definedAgainstHead(
  model: Model,
  root: ElementId,
  component: string,
  constants: ReadonlyArray<ReturnType<typeof exactConstant>>,
  stated: ElementRecord | undefined,
): { verdict: DefinedAgainst['verdict']; written: ElementRecord; head: DefinitionHead; root: ElementId; slot: string } | undefined {
  const ends = bindingEnds(model);
  for (const { root: headRoot, head } of ends.headSlots.get(`${root} ${component}`) ?? []) {
    const slot = head.slots?.find((s) => s.root === root && s.component === component)?.path ?? head.path;
    const reading = ends.readings.get(headRoot);
    const cls = classified(model, headRoot, head.component);
    for (const path of [...cls.valued, ...cls.readable]) {
      const member = reading?.get(path);
      const g = member ? model.get(member.feature) : undefined;
      const written = g ? valueSourceOf(model, g) : undefined;
      if (!written) continue;
      const w = constantOf(written);
      let compared: WrittenComparison = 'undecided';
      if (w && constants.every((c) => c !== undefined)) {
        const each = constants.map((c) => compareConstants(c!, w));
        compared = each.every((x) => x === 'same') ? 'same' : each.some((x) => x === 'differs') ? 'differs' : 'undecided';
      }
      if (compared === 'same') continue;
      return { verdict: compared === 'differs' && stated === undefined ? 'differs' : 'undecided', written, head, root: headRoot, slot };
    }
  }
  return undefined;
}

/**
 * The element that denotes `instance` — the feature its last link names, in
 * the element the instance's walk reads it in ({@link
 * DefiningEquations.framesAbove}): q1's `part :>> p` for `R::q1::p` — or
 * `undefined` where no walk spells it.
 */
function denotingElementOf(definitions: DefiningEquations, instance: string): ElementRecord | undefined {
  const frames = definitions.framesAbove(instance);
  const last = frames?.[frames.length - 1];
  const sep = instance.lastIndexOf('::');
  if (!last || sep < 0 || last.instance !== instance.slice(0, sep)) return undefined;
  return definitions.byName(last.reader).get(instance.slice(sep + 2));
}

/**
 * Is `f` a value written with `=` that a binding joins, in SOME context it is
 * read in, to another value written with `=` that differs from it, or that
 * only an evaluation could compare with it ({@link statedAgainstBoundIn})?
 * Both are, and a redefinition with a value of
 * its own of the slot a package's binding joins (`fixed`,
 * {@link DefinitionHead}) is joined so to every value written in that
 * component. The readings that key no instance — the numeric lane's seeds, a
 * generic unit-aware derivation — read none of them, as they read no
 * `default` a binding holds somewhere ({@link defaultGivesWaySomewhere}).
 * Once per revision.
 */
export function statedAgainstBoundSomewhere(model: Model, f: ElementRecord): boolean {
  if (f.attrs.value === undefined || f.attrs.value === null || f.attrs.defaultValue === true) return false;
  if (!hasUserBindings(model)) return false;
  const ends = bindingEnds(model);
  if (!ends.against) {
    const out = new Set<ElementId>();
    const against = (list: readonly ElementRecord[]): void => {
      for (const w of list) if (list.some((o) => o !== w && compareWrittenValues(w, o) !== 'same')) out.add(w.id);
    };
    const fixed: Array<{ head: DefinitionHead; written: ElementRecord[] }> = [];
    for (const [root, reading] of ends.readings) {
      const written = new Map<string, ElementRecord[]>();
      for (const { feature, component } of reading.values()) {
        const g = model.get(feature);
        const w = g ? valueSourceOf(model, g) : undefined;
        if (!w || w.attrs.defaultValue === true) continue;
        const list = written.get(component) ?? [];
        if (!list.includes(w)) list.push(w);
        written.set(component, list);
      }
      for (const list of written.values()) against(list);
      for (const head of ends.heads.get(root) ?? []) {
        if (head.fixed === undefined || !head.redefined) continue;
        fixed.push({ head, written: written.get(head.component) ?? [] });
      }
    }
    if (fixed.length > 0) {
      for (const g of model.all()) {
        if (g.attrs.isLibrary === true || g.attrs.defaultValue === true) continue;
        if (g.attrs.value === undefined || g.attrs.value === null) continue;
        const closure = redefinedClosure(model, g);
        for (const { head, written } of fixed) {
          if (written.length > 0 && closure.some((r) => r.id === head.feature)) against([g, ...written]);
        }
      }
    }
    ends.against = out;
  }
  return ends.against.has(f.id);
}

/**
 * Do the two features a binding's ends denote state values written with `=`
 * that DIFFER as written ({@link compareWrittenValues}) — each end's own
 * value, else the nearest it redefines that states one ({@link valueSourceOf}:
 * an implicit end copy states none of its own), never a `default`? Then the
 * binding itself joins two values the model states (A.5): its own row is
 * violated, though neither end reads either value any more
 * ({@link statedAgainstBoundIn}). A binding whose own ends agree, or one end of
 * which states no such value, is judged at the values read, whatever else its
 * component joins.
 */
export function bindsDifferingWrittenValues(model: Model, a: ElementRecord, b: ElementRecord): boolean {
  return writtenPairOf(model, a, b) === 'differs';
}

/**
 * Do the two features a binding's ends denote state values written with `=`
 * that only an evaluation could compare ({@link compareWrittenValues}: D1E's
 * `load = 30.0` against `L = 2.0 * K`)? Neither end reads either value where
 * the binding joins them ({@link statedAgainstBoundIn}), so the binding's own
 * row judges the pair at the two values as written, each read where it is
 * written, in the context the row is read in.
 */
export function bindsUndecidedWrittenValues(model: Model, a: ElementRecord, b: ElementRecord): boolean {
  return writtenPairOf(model, a, b) === 'undecided';
}

/** How the values written with `=` that a binding's two ends read compare, or `undefined` where an end reads none. */
function writtenPairOf(model: Model, a: ElementRecord, b: ElementRecord): WrittenComparison | undefined {
  const x = valueSourceOf(model, a);
  const y = valueSourceOf(model, b);
  if (x === undefined || y === undefined || x === y) return undefined;
  if (x.attrs.defaultValue === true || y.attrs.defaultValue === true) return undefined;
  return compareWrittenValues(x, y);
}

/**
 * The member of the component at `root` whose `default` STANDS for the
 * instance that root's reading serves (F8, A.4 Part 2) — its path and the
 * feature that writes it — or `undefined`. A `default` a binding holds only
 * per FEATURE ({@link heldDefaults}) gives way where the bindings joined to it
 * reach a value of its own; in an instance whose outermost component states
 * none, and whose every default is a literal agreeing exactly, it stands there
 * (P's `load default = 5.0` beside Q's `bind p.load = L`: q1 sets L, q2 leaves
 * it, and q2's load is 5.0). A component with a stated member has a value the
 * binding gives; a default that reads a name, or two that do not compare the
 * same exactly, may be another value in each instance and gives way. Once per
 * (root, component) and revision ({@link componentFacts}).
 */
function standingDefaultPath(
  model: Model,
  root: ElementId,
  component: string,
): { path: string; source: ElementRecord } | undefined {
  const facts = componentFacts(model, root, component);
  if (facts.standing === undefined) facts.standing = standingDefaultOf(model, root, facts.paths) ?? null;
  return facts.standing ?? undefined;
}

/** {@link standingDefaultPath}, worked out over the component's member `paths`, in reading order. */
function standingDefaultOf(
  model: Model,
  root: ElementId,
  paths: readonly string[],
): { path: string; source: ElementRecord } | undefined {
  const { readings, standing, standingAt } = bindingEnds(model);
  const rootEl = model.get(root);
  const reading = readings.get(root);
  if (!rootEl || !reading) return undefined;
  const definitions = sharedDefinitions(model);
  // A member DEFINED by an asserted equation — its own, or one inherited from
  // a general definition, which {@link endValue} does not see — is a stated
  // value: the default does not stand. `equationsByName` is direct, so the
  // generalisations are walked. Except where a default stands HERE against it
  // ({@link BindingEnds.standingAt}: one held only in another context, T4E's
  // `L0 default = 1.0` under Q's `bind L0 = L` and Q's asserted `L == 50.0`,
  // which `part q5 : Q { :>> L = 50.0; }` holds per feature, read in q): no
  // assertion replaces a default (decision 14 amended 2026-10-22), so the
  // asserted member is no value it gives way to, and the default is the one
  // this instance reads — the literal the numeric and SMT lanes stand it on.
  const against = paths.some((p) => standingAt.has(`${root} ${p}`));
  const asserted = (ownerId: ElementId | null | undefined, name: string | undefined): boolean => {
    if (name === undefined || ownerId == null) return false;
    for (const o of [model.get(ownerId), ...generalizationsOf(model, ownerId)]) {
      if (o && definitions.of(o.id, name).length > 0) return true;
    }
    return false;
  };
  let first: { path: string; source: ElementRecord } | undefined;
  for (const path of paths) {
    const r = reading.get(path);
    const f = r ? model.get(r.feature) : undefined;
    if (!f) continue;
    const name = effectiveNameOf(model, f);
    const v = endValue(model, f, rootEl, path);
    if (asserted(f.ownerId, name) || asserted(root, path)) {
      if (!against) return undefined;
      if (v.kind !== 'default') continue;
    }
    if (v.kind === 'value') {
      if (against && v.asserted === true) continue;
      return undefined;
    }
    if (v.kind !== 'default') continue;
    // Beside one that stands here, a default given way here is no value of the component's.
    if (against && !standingAt.has(`${root} ${path}`) && !standing.has(f.id)) return undefined;
    // A member read through a reference lands where the reference stands: w's
    // `pp.load`, over W's `ref part pp : T0 = top.a` and w's `ref part :>> top
    // = t50`, is t50's a's load, which T1's `bind a.load = L` makes 50. Its
    // default is that instance's to keep or give way, which no path below
    // `root` reads, so none stands here: the binding's own row carries the
    // value from where it lands. Stood, w's m was T0's 1 beside that row's 50,
    // and the solver lane's axioms contradicted on a consistent model (RBB1).
    if (landsAway(definitions, root, path)) return undefined;
    const literal = v.source.attrs.value;
    if (typeof literal !== 'number' && typeof literal !== 'boolean') return undefined;
    if (first === undefined) {
      first = { path, source: v.source };
      continue;
    }
    if (!sameConstant(first.source, v.source)) return undefined;
  }
  return first;
}

/**
 * Does the member at `path` in the binding reading rooted at `rootId` land in
 * an instance other than the one its path spells ({@link standingDefaultOf})
 * — read through a reference, which the walk resolves where it stands
 * ({@link Denotation}'s `instance`)?
 */
function landsAway(definitions: DefiningEquations, rootId: ElementId, path: string): boolean {
  if (path.startsWith('#') || !path.includes('.')) return false;
  const d = definitions.denote(rootId).get(path);
  const spelled = heldInstance(definitions, rootId, path);
  if (!d || spelled === undefined) return false;
  return `${d.instance}::${path.slice(path.lastIndexOf('.') + 1)}` !== spelled;
}

/**
 * The feature whose `default` STANDS for the name read at the instance
 * `symbol` (F8, A.4 Part 2) — the default a binding holds per feature but
 * which this instance's outermost component reads as its value — or
 * `undefined`. `symbol` is the spelling {@link boundSourceIn} reads
 * (`W2::q2::p::load`). Past a binding cap, or where an end has no instance,
 * no bound value is read for any one instance ({@link defaultGivesWay} stays
 * the per-feature answer). The solver and the SMT lane read this to give the
 * instance the literal value the check reads there.
 */
export function defaultStandsIn(model: Model, symbol: string): ElementRecord | undefined {
  const answer = standingDefaultIn(model, symbol);
  recording?.push({ kind: 'stands', symbol, answer });
  return answer;
}

/**
 * Does the `default` of the member the instance `symbol` is stand at its
 * outermost reading against the asserted members of its component, though a
 * binding holds it per FEATURE in another context ({@link
 * BindingEnds.standingAt})? It is then that instance's value on every surface
 * ({@link defaultStandsIn}), as one held nowhere is — T4E's q's `L0 default =
 * 1.0`, which `part q5 : Q { :>> L = 50.0; }` holds per feature under Q's
 * `bind L0 = L` — and never the value Q's asserted `L == 50.0` gives L.
 */
export function standsAgainstAssertsIn(model: Model, symbol: string): boolean {
  if (!hasUserBindings(model)) return false;
  const { standingAt } = bindingEnds(model);
  if (standingAt.size === 0) return false;
  const best = outermostReading(model, symbol);
  if (!best) return false;
  const path = ownPathOf(model, best.root, best.component, symbol);
  return path !== undefined && standingAt.has(`${best.root} ${path}`);
}

/** {@link defaultStandsIn}, worked out. */
function standingDefaultIn(model: Model, symbol: string): ElementRecord | undefined {
  if (!hasUserBindings(model)) return undefined;
  const definitions = sharedDefinitions(model);
  const best = outermostReading(model, symbol);
  if (!best) return undefined;
  const member = model.get(best.feature);
  const { unread, overCap } = bindingEnds(model);
  const carried = member ? definitions.carrier(best.root, member).id : undefined;
  if (
    member &&
    (unread.has(member.id) ||
      (carried !== undefined && unread.has(carried)) ||
      overCap.get(member.id) !== undefined ||
      (carried !== undefined && overCap.get(carried) !== undefined))
  ) {
    return undefined;
  }
  // A definition's feature joined so carries every instance's value into the
  // component: where one redefines it with a value of its own (`part p4 : P {
  // attribute :>> load = 7.0; }` under `bind P::load = L`, L valueless), P's
  // default is no value of the component's (L is 7) — none stands.
  if (pairedHeads(model, best.root, best.component, true)) return undefined;
  // Nor one an assert typed by an equation's definition may define: it gives
  // way there as everywhere ({@link typedAssertHolding}).
  const source = standingDefaultPath(model, best.root, best.component)?.source;
  return source !== undefined && typedAssertHolding(model, source) !== undefined ? undefined : source;
}

/**
 * Does the component read in the package `root` join two or more features of
 * definitions ({@link DefinitionHead}) — `bind P::load = P::cap` — which each
 * instance of the definition reads at values of its own? With `orRedefined`,
 * or one a feature with a value of its own redefines in some instance.
 */
function pairedHeads(model: Model, root: ElementId, component: string, orRedefined = false): boolean {
  const heads = (bindingEnds(model).heads.get(root) ?? []).filter((h) => h.component === component);
  return heads.length > 1 || (orRedefined && heads.some((h) => h.redefined || fixesSlot(h)));
}

/** Why a package's binding between features of definitions gives an instance no value ({@link pairedHeads}). */
function pairedHeadsSentence(model: Model, symbol: string, root: ElementId, component: string): string {
  const sep = symbol.lastIndexOf('::');
  const name = sep >= 0 ? symbol.slice(sep + 2) : symbol;
  const instance = sep >= 0 ? symbol.slice(0, sep) : '';
  const members = componentPaths(model, root, component);
  return (
    `${name} has no value in ${instance}: a binding of ${effectiveQualifiedName(model, root)} joins features of a ` +
    `definition (${members.join(', ')}), each at its own value in every instance, and this tool reads none of them there`
  );
}

/**
 * Why a package's binding on a definition's feature gives an instance no
 * value where some instance fixes that feature outside it ({@link
 * DefinitionHead.fixed}): the binding carries that value into its other
 * ends, and so into every instance, which this tool does not read.
 */
function fixedHeadSentence(model: Model, symbol: string, root: ElementId, component: string, head: DefinitionHead): string {
  const sep = symbol.lastIndexOf('::');
  const name = sep >= 0 ? symbol.slice(sep + 2) : symbol;
  const instance = sep >= 0 ? symbol.slice(0, sep) : '';
  const members = componentPaths(model, root, component);
  return (
    `${name} has no value in ${instance}: a binding of ${effectiveQualifiedName(model, root)} joins ${members.join(', ')} ` +
    `in every instance of ${effectiveQualifiedName(model, head.definition.id)}, and ${head.fixed} gives ${head.path} a value ` +
    'in one of them, which this tool does not read into the others'
  );
}

/** The user packages of a model — `package` elements, nested ones included. */
function userPackages(model: Model): ElementRecord[] {
  return model.all().filter((e) => e.eClass === 'Package' && e.attrs.isLibrary !== true);
}

/**
 * One entry of a user package's {@link DefiningEquations.denote} walk, with
 * its place in the walk over every user package in turn (`order`).
 */
interface PackageDenotation {
  order: number;
  pkg: ElementId;
  path: string;
  denoted: Denotation;
}

/**
 * Every entry of every user package's {@link DefiningEquations.denote} walk,
 * by the feature it denotes — {@link instanceSitesOf}'s union half, built once
 * per {@link DefiningEquations} (one per revision, {@link sharedDefinitions})
 * rather than walked again for each definition a group is read for.
 */
const PACKAGE_DENOTE = new WeakMap<DefiningEquations, ReadonlyMap<ElementId, readonly PackageDenotation[]>>();

/** {@link PACKAGE_DENOTE} of `definitions`, built when first asked. */
function packageDenotations(definitions: DefiningEquations): ReadonlyMap<ElementId, readonly PackageDenotation[]> {
  const hit = PACKAGE_DENOTE.get(definitions);
  if (hit) return hit;
  const byFeature = new Map<ElementId, PackageDenotation[]>();
  let order = 0;
  for (const pkg of userPackages(definitions.model)) {
    for (const [path, denoted] of definitions.denote(pkg.id)) {
      const entry = { order: order++, pkg: pkg.id, path, denoted };
      const list = byFeature.get(denoted.feature.id);
      if (list) list.push(entry);
      else byFeature.set(denoted.feature.id, [entry]);
    }
  }
  PACKAGE_DENOTE.set(definitions, byFeature);
  return byFeature;
}

/**
 * The instances of a definition — or of a usage at the top of a usage chain —
 * in reading order, its own (generic) instance first: every frame of
 * {@link bindingFrames} spelled through the {@link DefiningEquations.denote}
 * walk, unioned with the `denote` entries of every user package that reach it
 * or a specialiser, deduplicated by string. The union guards against a frame
 * spelling gap (R14b/c/d), so an instance the full `denote` walk finds is
 * never dropped because a frame failed to spell it.
 */
export function instancesOfDefinition(definitions: DefiningEquations, definition: ElementRecord): string[] {
  return [...instanceSitesOf(definitions, definition).sites.keys()];
}

/** {@link instancesOfDefinition}, for a shared usage: a usage is its own definition at the top of a usage chain. */
export function instancesOfUsage(definitions: DefiningEquations, usage: ElementRecord): string[] {
  return instancesOfDefinition(definitions, usage);
}

/**
 * Where an instance is spelled ({@link instanceSitesOf}): a context `root`
 * and the dotted `path` the {@link DefiningEquations.denote} walk takes from
 * it to the instance — `''` for the root itself.
 */
interface InstanceSite {
  root: ElementId;
  path: string;
}

/**
 * {@link instancesOfDefinition}, in the same order, with every site each
 * instance is spelled at — the places the coverage guard reads it from
 * ({@link instanceReadsOtherwise}) — and whether {@link bindingFrames} was
 * truncated. A package's `denote` entry is a site only under the path the
 * walk takes to it: under an alias, or a nested bare name, it names the
 * instance but no path below it.
 */
function instanceSitesOf(
  definitions: DefiningEquations,
  definition: ElementRecord,
): { sites: Map<string, InstanceSite[]>; truncated: boolean } {
  const sites = new Map<string, InstanceSite[]>();
  const add = (s: string, site?: InstanceSite): void => {
    let list = sites.get(s);
    if (!list) {
      list = [];
      sites.set(s, list);
    }
    if (site) list.push(site);
  };
  const { frames, truncated } = bindingFrames(definitions, definition);
  for (const { root, prefix } of frames) {
    if (prefix === '') {
      add(definitions.instanceNameOf(root.id), { root: root.id, path: '' });
      continue;
    }
    const d = definitions.denote(root.id).get(prefix);
    if (d) add(`${d.instance}::${definitions.nameOf(d.feature) ?? ''}`, { root: root.id, path: prefix });
  }
  // The package entries that denote the definition or a specialiser, in the
  // order the walk over every user package meets them ({@link packageDenotations}).
  const byFeature = packageDenotations(definitions);
  const entries = [...new Set([definition.id, ...definitions.specialisersOf(definition.id).map((s) => s.id)])]
    .flatMap((id) => byFeature.get(id) ?? [])
    .sort((a, b) => a.order - b.order);
  for (const { pkg, path, denoted: d } of entries) {
    const name = definitions.nameOf(d.feature) ?? '';
    const walked = path.slice(path.lastIndexOf('.') + 1) === name && (path.includes('.') || d.reader === pkg);
    add(`${d.instance}::${name}`, walked ? { root: pkg, path } : undefined);
  }
  return { sites, truncated };
}

/**
 * What a relation reads in one context ({@link readFeatures}). `paths`: by
 * dotted path below the context, a signature of what each path reads.
 * `crossings`: each prefix of a read path that stands for what a reference's
 * — or a bound subject's — value names (`r` of `r.x` over `ref part :>> r =
 * s`), a value the {@link DefiningEquations.denote} walk resolves once, where
 * it is written ({@link DefiningEquations.subjectScope}). `bound`: the first
 * prefix — the context itself (`''`) included — that a binding connector
 * touches, or that redefines one it touches: a part bound to another, whose
 * features every reading reads as its type's (`bind p.r = s` joins p's `r` to
 * Q's `s`, and `r.x` read R's own x); {@link boundSourceIn} carries a value
 * bound to a read feature, never the identity of a bound part.
 */
interface GuardReading {
  /**
   * `assertedDefault`: the asserted equations that define a path's `default`, by id; `readAt`: those among them the
   * enclosing rule reads at the instance ({@link enclosingAsserts}), so a reading in the element reads them.
   */
  paths: Map<string, { signature: string; assertedDefault?: string; readAt?: string }>;
  crossings: Array<{ path: string; reader: ElementId; feature: ElementRecord }>;
  bound?: { path: string; prefix: string };
}

/**
 * What `names` read in the context `contextId` ({@link GuardReading}): each
 * name, and every name the value of what it denotes reads — its stated value,
 * the value it redefines ({@link DefiningEquations.carrier}), the asserted
 * equations that define it where it is read and where it is written —
 * transitively, each resolved below the instance it is read in, as the
 * {@link DefiningEquations.denote} walk resolves it. Each path's signature is
 * the feature it denotes, the one whose value that is, the asserts that
 * define it (`''` where it denotes nothing) and — below a prefix — the
 * feature it is read through, the instance it is read in where that is
 * spelled outside the context (through a reference to `rb`, `rb::x`), and
 * whether two values inherited under its name collide where it is read
 * ({@link DefiningEquations.clash}: it then reads neither). A
 * binding partner is not followed: the per-instance reading reads it in the
 * binding's own frame ({@link boundSourceIn}). `undefined` past
 * {@link MAX_GUARD_PATHS} paths.
 */
function readFeatures(
  definitions: DefiningEquations,
  contextId: ElementId,
  names: readonly string[],
): GuardReading | undefined {
  const model = definitions.model;
  const denoted = definitions.denote(contextId);
  const root = definitions.instanceNameOf(contextId);
  const ends = bindingEndsOf(model);
  const isBound = (f: ElementRecord): boolean =>
    ends.has(f.id) || redefinedClosure(model, f).some((g) => ends.has(g.id));
  const paths: GuardReading['paths'] = new Map();
  const crossings: GuardReading['crossings'] = [];
  const crossed = new Set<string>();
  const context = model.get(contextId);
  let bound: GuardReading['bound'] = context && isBound(context) ? { path: names[0] ?? '', prefix: '' } : undefined;
  const queue = [...names];
  for (let i = 0; i < queue.length; i++) {
    const path = queue[i]!;
    if (paths.has(path)) continue;
    if (paths.size >= MAX_GUARD_PATHS) return undefined;
    // What the path is read through: a part a binding joins to another, and a
    // reference whose value stands for another feature.
    const segments = path.split('.');
    for (let k = 1; k < segments.length; k++) {
      const prefix = segments.slice(0, k).join('.');
      const p = denoted.get(prefix);
      if (!p) continue;
      if (bound === undefined && isBound(p.feature)) bound = { path, prefix };
      if (!crossed.has(prefix) && definitions.subjectOf(p.reader, p.feature) !== undefined) {
        crossed.add(prefix);
        crossings.push({ path: prefix, reader: p.reader, feature: p.feature });
      }
    }
    const d = denoted.get(path);
    if (!d) {
      paths.set(path, { signature: '' });
      continue;
    }
    const target = definitions.carrier(d.reader, d.feature);
    const name = definitions.nameOf(target);
    const asserts: DefiningEquation[] = [];
    if (name !== undefined) {
      for (const site of new Set([d.reader, target.ownerId, d.feature.ownerId])) {
        if (site != null) asserts.push(...definitions.of(site, name));
      }
    }
    // The instance the feature is read in, below the context: where the names
    // its value reads are read. One the walk reaches through a bound subject
    // is spelled elsewhere: that instance is compared, and its reads are not
    // followed.
    const at =
      d.instance === root
        ? ''
        : d.instance.startsWith(`${root}::`)
          ? d.instance.slice(root.length + 2).split('::').join('.')
          : undefined;
    const signature = [
      d.feature.id,
      target === d.feature ? '' : target.id,
      asserts.map((eq) => eq.constraint.id).sort().join(','),
      segments.length > 1 ? d.reader : '',
      at === undefined ? d.instance : '',
      definitions.clash(d.reader, d.feature) !== undefined ? 'clash' : '',
    ].join(' ');
    // A `default` an asserted equation constrains and may replace (H5): the
    // asserts, by id — and those the enclosing rule reads at the instance, an
    // element's own included (H5B: q2's `part :>> p { assert constraint {
    // extra == 20.0 } }` would be q2's p's extra, 20), where no local rule
    // holds the default already. None may since decision 14 was amended
    // ({@link replaceableDefaults}): the default is read there as written, as
    // a value written with `=` is, and the assert is checked against it.
    const replaceable = replaceableDefaults(model);
    const holder = [d.feature, target].find((f) => f.attrs.defaultValue === true && replaceable.has(f.id));
    const index = holder !== undefined && asserts.length > 0 ? instanceIndexSeam.enclosingAsserts(model) : undefined;
    const readAt =
      index !== undefined && name !== undefined && instanceIndexSeam.assertHeldInSome(model, holder!) && !assertHeld(model).has(holder!.id)
        ? asserts.filter(
            (eq) => eq.constraint.ownerId != null && (index.byOwner.get(eq.constraint.ownerId)?.get(name) ?? []).some((x) => x.constraint.id === eq.constraint.id),
          )
        : [];
    paths.set(path, {
      signature,
      ...(holder !== undefined && asserts.length > 0
        ? {
            assertedDefault: asserts.map((eq) => eq.constraint.id).sort().join(','),
            ...(readAt.length > 0 ? { readAt: readAt.map((eq) => eq.constraint.id).sort().join(',') } : {}),
          }
        : {}),
    });
    if (at === undefined) continue;
    const reads: string[] = [];
    for (const f of new Set([d.feature, target])) {
      const v = definitions.statedValue(f);
      if (typeof v === 'string') reads.push(...namesOfValue(v));
    }
    for (const eq of asserts) reads.push(...refsIn(eq.definition, eq.literals));
    for (const n of reads) queue.push(at === '' ? n : `${at}.${n}`);
  }
  return { paths, crossings, ...(bound ? { bound } : {}) };
}

/**
 * The features a dotted `path` passes through, read in `contextId` as
 * {@link DefiningEquations.chain} reads it; `undefined` where it does not
 * resolve, or passes through a reference.
 */
function featuresAlong(definitions: DefiningEquations, contextId: ElementId, path: string): ElementRecord[] | undefined {
  const out: ElementRecord[] = [];
  let owner = contextId;
  for (const segment of path.split('.')) {
    if (out.length > 0 && definitions.subjectOf(owner, out[out.length - 1]!) !== undefined) return undefined;
    if (out.length > 0) owner = out[out.length - 1]!.id;
    const f = definitions.byName(owner).get(segment);
    if (!f) return undefined;
    out.push(f);
  }
  return out;
}

/** Is `e` — or a feature it redefines — `t`, or of a type that is or specialises `t`? */
function standsAs(model: Model, e: ElementRecord, t: ElementRecord): boolean {
  return [e, ...redefinedClosure(model, e)].some(
    (x) => x.id === t.id || generalizationsOf(model, x.id).some((g) => g.id === t.id),
  );
}

/**
 * Whether a reference the reading crosses ({@link GuardReading}) stands for
 * the same feature at an instance as where its value is written: the value's
 * path is resolved once, in the namespace it is written in or encloses it —
 * Q's `s` for `ref part :>> r = s` written in Q's p — and an instance of Q
 * reads it in ITS `s` (q2's `part :>> s { … }`, Q2's `part :>> s : R2`). The
 * namespace that plays that part at the instance is the innermost of the
 * features along the crossing's path, the instance's element, the features
 * along the site's path back to its root, and the root's owners, that is or
 * specialises it; the path is read there again. A package is one namespace
 * for every instance. A phrase where the reading differs, a binding reaches
 * into the feature it stands for (its value may then differ per instance),
 * or this tool cannot tell; `undefined` where it is the same.
 */
function crossingReadsOtherwise(
  definitions: DefiningEquations,
  site: InstanceSite,
  element: ElementRecord,
  crossing: GuardReading['crossings'][number],
): string | undefined {
  const model = definitions.model;
  const cannot = `this tool cannot tell what its ${crossing.path} stands for there`;
  const resolved = definitions.subjectScope(crossing.reader, crossing.feature);
  if (resolved?.scope === undefined || resolved.path === undefined) return cannot;
  const scope = model.get(resolved.scope);
  if (!scope) return cannot;
  if (scope.eClass === 'Package' || scope.attrs.isLibrary === true) return undefined;
  const chain: ElementRecord[] = [];
  const below = crossing.path.split('.');
  const denoted = definitions.denote(element.id);
  for (let k = below.length - 1; k >= 1; k--) {
    const d = denoted.get(below.slice(0, k).join('.'));
    if (!d || definitions.subjectOf(d.reader, d.feature) !== undefined) return cannot;
    chain.push(d.feature);
  }
  chain.push(element);
  if (site.path !== '') {
    const steps = site.path.split('.');
    const fromRoot = definitions.denote(site.root);
    for (let k = steps.length - 1; k >= 1; k--) {
      const d = fromRoot.get(steps.slice(0, k).join('.'));
      if (!d || definitions.subjectOf(d.reader, d.feature) !== undefined) return cannot;
      chain.push(d.feature);
    }
  }
  const seen = new Set(chain.map((e) => e.id));
  for (let cur = model.get(site.root); cur; cur = cur.ownerId != null ? model.get(cur.ownerId) : undefined) {
    if (seen.has(cur.id)) continue;
    seen.add(cur.id);
    chain.push(cur);
  }
  const at = chain.find((e) => standsAs(model, e, scope));
  if (!at) return cannot;
  const its = featuresAlong(definitions, scope.id, resolved.path);
  const mine = featuresAlong(definitions, at.id, resolved.path);
  const named = (f: ElementRecord | undefined) => (f ? definitions.qualifiedNameOf(f.id) : 'nothing this tool resolves');
  if (!its || !mine || its.length !== mine.length || its.some((f, k) => f !== mine[k])) {
    return `its ${crossing.path} there stands for ${named(mine?.[mine.length - 1])}, not ${named(resolved.feature)}`;
  }
  const head = its[0]!;
  for (const id of bindingEndsOf(model)) {
    for (let e = model.get(id); e; e = e.ownerId != null ? model.get(e.ownerId) : undefined) {
      if (e.id === head.id) {
        return `its ${crossing.path} stands for ${named(resolved.feature)} of that instance, which a binding reaches into`;
      }
    }
  }
  return undefined;
}

/**
 * The features `ownerId` inherits under `name` from two general types or
 * more, none redefining another — a diamond: `part def Q3 :> Q2, Q4` over
 * Q2's `part :>> p : P2` and Q4's `part :>> p : P4`, both of Q's `p`; a usage
 * typed by both, `part q3 : Q2, Q4` — unless a feature `ownerId` declares
 * under the name redefines every one of them. `undefined` where there is no
 * such pair. Every instance of `ownerId` is an instance of each, so its `p`
 * is P2's and P4's at once; the {@link DefiningEquations.denote} walk reads
 * the name through one of them (Q2's), and a feature `ownerId` declares that
 * redefines only Q's `p` (`part :>> p;`) reads neither. `cache` holds the
 * answer per owner and name, for one sweep.
 */
function inheritedTwice(
  model: Model,
  ownerId: ElementId,
  name: string,
  cache: Map<string, readonly ElementRecord[] | undefined>,
): readonly ElementRecord[] | undefined {
  const key = `${ownerId} ${name}`;
  if (cache.has(key)) return cache.get(key);
  const candidates = new Set<ElementRecord>();
  for (const general of generalizationsOf(model, ownerId)) {
    if (general.attrs.isLibrary === true) continue;
    for (const f of ownFeatures(model, general.id)) if (effectiveNameOf(model, f) === name) candidates.add(f);
  }
  let hit: readonly ElementRecord[] | undefined;
  if (candidates.size >= 2) {
    const redefined = new Set<ElementId>();
    for (const f of candidates) for (const g of redefinedClosure(model, f)) redefined.add(g.id);
    const left = [...candidates].filter((f) => !redefined.has(f.id));
    const mine = ownFeatures(model, ownerId).find((f) => effectiveNameOf(model, f) === name);
    const covered = new Set(mine ? redefinedClosure(model, mine).map((g) => g.id) : []);
    if (left.length >= 2 && left.some((f) => !covered.has(f.id))) hit = left;
  }
  cache.set(key, hit);
  return hit;
}

/**
 * What one sweep of {@link groupsOf} works out once and asks again for each
 * instance — the instances of one tree share their sites' prefixes, and the
 * guard asks each instance's sites more than once.
 */
interface PathCaches {
  /** {@link inheritedTwice} per owner and name. */
  twice: Map<string, readonly ElementRecord[] | undefined>;
  /** {@link siteWalk} per site root and path. */
  walks: Map<string, SiteWalk>;
  /** {@link instanceElementOf} per instance, by its sites (`null`: none). */
  elements: Map<readonly InstanceSite[], ElementRecord | null>;
}

/** A path name inherited twice: the element, the name, and the features ({@link inheritedTwice}). */
type PathDiamond = { owner: ElementRecord; name: string; features: readonly ElementRecord[] };

/**
 * The {@link DefiningEquations.denote} walk along a site's path, so far: the
 * first diamond on it, else the element it has reached (`undefined` where it
 * reaches none, and stops).
 */
type SiteWalk = { diamond: PathDiamond } | { owner: ElementRecord | undefined };

/**
 * {@link diamondOnPath} for one site, and the element its walk reaches: the
 * walk to the path's last segment ({@link PathCaches.walks}), then that
 * segment — read in what the walk reached, then the element it denotes. Once
 * per site root and path; every path extends a shorter one's walk.
 */
function siteWalk(definitions: DefiningEquations, root: ElementId, path: string, caches: PathCaches): SiteWalk {
  const key = `${root} ${path}`;
  const hit = caches.walks.get(key);
  if (hit) return hit;
  let walk: SiteWalk;
  if (path === '') {
    walk = { owner: definitions.model.get(root) };
  } else {
    const sep = path.lastIndexOf('.');
    const before = siteWalk(definitions, root, sep < 0 ? '' : path.slice(0, sep), caches);
    const step = path.slice(sep + 1);
    if ('diamond' in before || before.owner === undefined) {
      walk = 'diamond' in before ? before : { owner: undefined };
    } else {
      const features = inheritedTwice(definitions.model, before.owner.id, step, caches.twice);
      if (features !== undefined) {
        walk = { diamond: { owner: before.owner, name: step, features } };
      } else {
        const d = definitions.denote(root).get(path);
        walk = { owner: d ? (definitions.subjectOf(d.reader, d.feature) ?? d.feature) : undefined };
      }
    }
  }
  caches.walks.set(key, walk);
  return walk;
}

/**
 * The first segment of an instance's path, spelled from a site ({@link
 * instanceSitesOf}), that the element it is read in inherits twice ({@link
 * inheritedTwice}): the element, the name, and the features. Each segment is
 * read in the site's root, then in what the {@link DefiningEquations.denote}
 * walk reaches along the path before it ({@link siteWalk}). `undefined` where
 * none is.
 */
function diamondOnPath(
  definitions: DefiningEquations,
  sites: readonly InstanceSite[],
  caches: PathCaches,
): PathDiamond | undefined {
  for (const { root, path } of sites) {
    if (path === '') continue;
    const walk = siteWalk(definitions, root, path, caches);
    if ('diamond' in walk) return walk.diamond;
  }
  return undefined;
}

/**
 * The most specific element that denotes an instance: the one the {@link
 * DefiningEquations.denote} walk reaches along the instance's path from each
 * site it is spelled at ({@link instanceSitesOf}) — what a subject or a
 * reference there stands for, else the feature itself — or `undefined` where
 * it is spelled at no site, at sites that reach different elements, or along
 * a path that inherits a name twice ({@link diamondOnPath}): no one element
 * stands for an instance of Q3's p, which is Q2's p and Q4's p at once. Once
 * per instance ({@link PathCaches.elements}).
 */
function instanceElementOf(
  definitions: DefiningEquations,
  sites: readonly InstanceSite[],
  caches: PathCaches,
): ElementRecord | undefined {
  const hit = caches.elements.get(sites);
  if (hit !== undefined) return hit ?? undefined;
  let element: ElementRecord | undefined;
  if (diamondOnPath(definitions, sites, caches) === undefined) {
    const elements = new Set<ElementRecord | undefined>();
    for (const { root, path } of sites) {
      if (path === '') {
        elements.add(definitions.model.get(root));
        continue;
      }
      const d = definitions.denote(root).get(path);
      elements.add(d ? (definitions.subjectOf(d.reader, d.feature) ?? d.feature) : undefined);
    }
    if (elements.size === 1) [element] = elements;
  }
  caches.elements.set(sites, element ?? null);
  return element;
}

/**
 * What the coverage guard makes of one instance ({@link instanceReadsOtherwise}):
 * the instance is read in an element of its own, `element` — the most specific
 * element that denotes it — or its row abstains, in `sentence`.
 */
type GuardVerdict = { element: ElementRecord } | { kind: InstanceAbstention; sentence: string };

/**
 * THE COVERAGE GUARD (A.7, `not-enumerated`). A group reads every instance of
 * its shared usage U through U's own features, re-rooted at the instance: a
 * value a binding carries into one instance is read there ({@link
 * boundSourceIn}), and nothing else is. So an instance whose element — the
 * most specific element that denotes it, the one the {@link
 * DefiningEquations.denote} walk reaches along its path from each site it is
 * spelled at ({@link instanceSitesOf}) — reads a name of the relation, or a
 * name such a name's value reads, through ANOTHER feature or source than U
 * does — a redefinition with a value of its own (`part :>> p { attribute :>>
 * extra = 20.0; }`), a specialised type (`part :>> p : P2`), a nested
 * override on its path, a binding written there (its implicit end copy, A4's
 * `bind p.extra = E` in q2), an asserted equation of its own, a reference to
 * another feature (`ref part :>> r = ra`) — is not read through U: read so,
 * it published U's value as its own (A2: `P::c in q2::p` held at P's `extra`
 * of 0 while q2's p states 20). It is read in that element instead, at the
 * instance (`{ element }`): A2's q2's p is read in q2's `part :>> p`, whose
 * extra is 20, and A3's q2's p in Q2's `part :>> p : P2`, at q2's own values
 * — the reading the element's own context row gives where the element is the
 * instance's alone.
 *
 * Its row abstains — `undefined` where it reads every name as U does — where
 * that element cannot be read for it either: an instance spelled at no site,
 * at sites that reach different elements, along a path that inherits a name
 * twice ({@link diamondOnPath}: Q3's p, where `Q3 :> Q2, Q4` and each types
 * its p, is both at once), or whose reading runs past {@link MAX_GUARD_PATHS}
 * paths; one that redefines the relation itself (`constraint :>> c { … }`;
 * its own relation is read in its own row); one read through a part a binding
 * joins to another (`bind p.r = s`); one where a reference the reading
 * crosses stands for another feature than where its value is written ({@link
 * crossingReadsOtherwise}: `r = s` written in Q's p is Q's `s`, and q2's p
 * reads q2's); one whose element states a `default` an asserted equation of
 * its own constrains (H5: which of the two stands is not decided here); and
 * one an asserted relation of an instance ENCLOSING the element constrains
 * ({@link assertAbove}, A.2.4: `enclosing-assert`).
 * `cache` holds {@link readFeatures} per context and relation, and `caches`
 * the path walks ({@link PathCaches}), for one sweep.
 */
function instanceReadsOtherwise(
  definitions: DefiningEquations,
  relation: ElementRecord,
  usage: ElementRecord,
  instance: string,
  sites: readonly InstanceSite[],
  names: readonly string[],
  cache: Map<string, GuardReading | undefined>,
  caches: PathCaches,
): GuardVerdict | undefined {
  const model = definitions.model;
  const head = `${effectiveQualifiedName(model, relation.id)} is not read in ${instance}`;
  const named = (f: ElementRecord | undefined) => (f ? definitions.qualifiedNameOf(f.id) : 'nothing this tool resolves');
  const abstain = (sentence: string): GuardVerdict => ({ kind: 'not-enumerated', sentence });
  const diamond = diamondOnPath(definitions, sites, caches);
  if (diamond !== undefined) {
    const features = diamond.features.map((f) => named(f));
    const listed = `${features.slice(0, -1).join(', ')} and ${features[features.length - 1]}`;
    return abstain(
      `${head}: ${definitions.qualifiedNameOf(diamond.owner.id)} inherits ${listed} ` +
        `under the one name \`${diamond.name}\`, ${diamond.features.length === 2 ? 'neither redefining the other' : 'none redefining another'}, ` +
        'so this tool cannot tell which element stands for it there',
    );
  }
  const element = instanceElementOf(definitions, sites, caches);
  if (element === undefined) {
    return abstain(`${head}: this tool cannot tell which element stands for it there`);
  }
  // The relation itself, redefined there: the instance's own relation is read in its own row.
  const relationName = definitions.nameOf(relation);
  if (element.id !== usage.id && relationName !== undefined) {
    const mine = definitions.byName(element.id).get(relationName);
    if (mine !== undefined && mine.id !== relation.id) {
      return abstain(
        `${head}: its ${relationName} there is ${named(mine)}, not ${named(relation)}, and that relation is read in a row of its own`,
      );
    }
  }
  const shared = guardReading(definitions, relation, usage.id, names, cache);
  const own = element.id === usage.id ? shared : guardReading(definitions, relation, element.id, names, cache);
  if (shared === undefined || own === undefined) {
    return abstain(`${head}: what it reads there runs past ${MAX_GUARD_PATHS} names, and this tool compares no further`);
  }
  if (own.bound !== undefined) {
    return abstain(`${head}: ${boundPartPhrase(own.bound, instance)}`);
  }
  let differs = false;
  if (element.id !== usage.id) {
    for (const path of new Set([...shared.paths.keys(), ...own.paths.keys()])) {
      if (shared.paths.get(path)?.signature !== own.paths.get(path)?.signature) {
        differs = true;
        break;
      }
    }
  }
  for (const crossing of own.crossings) {
    for (const site of sites) {
      const why = crossingReadsOtherwise(definitions, site, element, crossing);
      if (why !== undefined) {
        return abstain(`${head}: ${why}, and this tool resolves what a reference stands for only where its value is written`);
      }
    }
  }
  if (!differs) return undefined;
  // A value of the element's own that states a `default` and that an asserted
  // equation the usage does not read constrains: under decision 14 the
  // equation stands. One the enclosing rule reads at the instance is read
  // there, in the element (H5B: q2's `part :>> p { assert constraint { extra
  // == 20.0 } }` over P's `extra default = 0.0` makes q2's p's extra 20, and P's
  // `load + extra <= 10.0` is violated there); for any other, a reading in the
  // element would read the default — so it abstains.
  for (const [path, mine] of own.paths) {
    const theirs = shared.paths.get(path)?.assertedDefault;
    if (mine.assertedDefault === undefined || mine.assertedDefault === theirs) continue;
    const known = new Set([...(theirs ?? '').split(','), ...(mine.readAt ?? '').split(',')]);
    if (mine.assertedDefault.split(',').every((id) => known.has(id))) continue;
    return abstain(
      `${head}: its ${path} there states a default that an asserted equation of its own constrains, ` +
        'and this tool does not decide per instance which of the two it reads',
    );
  }
  const assert = assertAbove(definitions, sites, element, [...own.paths.keys()]);
  if (assert !== undefined) {
    return {
      kind: 'enclosing-assert',
      sentence:
        `${head}: ${effectiveQualifiedName(model, assert.frame)}'s asserted \`${assert.expr}\` constrains it there, ` +
        'and this tool does not read a value an enclosing assert constrains',
    };
  }
  return { element };
}

/**
 * The first asserted relation of an instance ENCLOSING `element` on an
 * instance's path — the root of a site it is spelled at ({@link
 * instanceSitesOf}), every usage on the path between, and each one's types
 * and the features it redefines, user-written — that references a path
 * `element` reads (`paths`, as {@link readFeatures} lists them), spelled
 * below that instance: q2's `assert constraint { p.load >= 0.5 }` over q2's
 * `part :>> p { … }` reading `load`. A.2.4: an enclosing assert constrains
 * the value, and a reading in `element` reads none of it — save an asserted
 * equation that defines a `default` there, which the reading reads at the
 * instance (H5, {@link enclosingAsserts}). `undefined` where none does.
 */
function assertAbove(
  definitions: DefiningEquations,
  sites: readonly InstanceSite[],
  element: ElementRecord,
  paths: readonly string[],
): { frame: ElementId; expr: string } | undefined {
  const model = definitions.model;
  for (const site of sites) {
    if (site.path === '') continue;
    const steps = site.path.split('.');
    const denoted = definitions.denote(site.root);
    // The instances above the element, outermost first, each with the path
    // from it down to the element.
    const frames: Array<{ el: ElementRecord; below: string }> = [];
    const root = model.get(site.root);
    if (root) frames.push({ el: root, below: site.path });
    for (let k = 1; k < steps.length; k++) {
      const d = denoted.get(steps.slice(0, k).join('.'));
      if (d) frames.push({ el: definitions.subjectOf(d.reader, d.feature) ?? d.feature, below: steps.slice(k).join('.') });
    }
    for (const { el, below } of frames) {
      if (el.id === element.id) continue;
      const holders = new Set<ElementRecord>();
      for (const h of [el, ...redefinedClosure(model, el)]) {
        holders.add(h);
        for (const g of generalizationsOf(model, h.id)) holders.add(g);
      }
      for (const holder of holders) {
        if (holder.attrs.isLibrary === true) continue;
        // An equation that defines a `default` the element reads is read at the instance, as a binding is (H5's
        // enclosing rule, {@link assertDefinitionIn}): no reason to abstain.
        const defining = enclosingAsserts(model).byOwner.get(holder.id);
        for (const child of model.children(holder.id)) {
          if (child.attrs.isLibrary === true || !isAsserted(child)) continue;
          const expr = child.attrs.expression;
          if (typeof expr !== 'string' || expr.trim() === '') continue;
          for (const n of relationNamesOf(expr)) {
            for (const p of paths) {
              const remaining = `${below}.${p}`;
              if (n === remaining && defining?.get(n)?.some((eq) => eq.constraint.id === child.id)) continue;
              if (n === remaining || n.startsWith(`${remaining}.`) || remaining.startsWith(`${n}.`)) {
                return { frame: holder.id, expr };
              }
            }
          }
        }
      }
    }
  }
  return undefined;
}

/** {@link readFeatures} of `relation` in `contextId`, once per sweep (`cache`). */
function guardReading(
  definitions: DefiningEquations,
  relation: ElementRecord,
  contextId: ElementId,
  names: readonly string[],
  cache: Map<string, GuardReading | undefined>,
): GuardReading | undefined {
  const key = `${contextId} ${relation.id}`;
  if (!cache.has(key)) cache.set(key, readFeatures(definitions, contextId, names));
  return cache.get(key);
}

/**
 * Why a reading through a bound part ({@link GuardReading}'s `bound`) is no
 * reading: the clause after `{rel} is not read … in {where}: `.
 */
function boundPartPhrase(bound: NonNullable<GuardReading['bound']>, where: string): string {
  const through = bound.prefix === '' ? `${where} itself` : bound.prefix;
  return `it reads ${bound.path} through ${through}, which a binding joins to another feature, and this tool reads no feature through a bound part`;
}

/** {@link instanceGroups} per model, keyed on its revision (B.5): nothing survives an edit. */
const INSTANCE_GROUPS = new WeakMap<Model, { rev: number; groups: readonly InstanceGroup[] }>();

/** The instances of the usage `x` ({@link instanceSitesOf}), once per usage and model revision ({@link bindingValued} asks for every context). */
const INSTANCE_NAMES = new WeakMap<DefiningEquations, Map<ElementId, string[]>>();

function instanceNamesOf(definitions: DefiningEquations, x: ElementRecord): string[] {
  let byUsage = INSTANCE_NAMES.get(definitions);
  if (!byUsage) INSTANCE_NAMES.set(definitions, (byUsage = new Map()));
  let names = byUsage.get(x.id);
  if (!names) byUsage.set(x.id, (names = [...instanceIndexSeam.instanceSitesOf(definitions, x).sites.keys()]));
  return names;
}

/**
 * {@link DefiningEquations.valuedByBinding}, worked out: does a name of `names`, read in the usage `x`, denote a
 * feature of one of its instances that states no value and whose instance symbol a binding gives a source this tool
 * reads ({@link boundSourceIn})? A name read in an instance of the context's own, never one an owning namespace
 * answers. The symbol is asked at the context's own instance, and at every other instance of `x` (`q::p` of `Q::p`:
 * `bind p.load = L` carries `q.L`, which only an instance of Q gives); a feature that states a value it derives
 * (`m2 = 10.0 - load`) is valued where a name its value reads is (four levels deep).
 */
function bindingValued(definitions: DefiningEquations, x: ElementRecord, names: readonly string[]): boolean {
  const denoted = definitions.denote(x.id);
  const here = definitions.instanceNameOf(x.id);
  const sourced = (symbol: string): boolean => {
    const source = boundSourceIn(definitions.model, symbol);
    return source !== undefined && !('abstain' in source);
  };
  let others: string[] | undefined;
  const valued = (n: string, depth: number): boolean => {
    const d = denoted.get(n);
    if (!d || !(d.instance === here || d.instance.startsWith(`${here}::`))) return false;
    // A value, or a `default`, anywhere on the redefinition chain is read by the rules that list a context for what it states.
    if (statesOwnValue(definitions.model, d.feature)) {
      const value = statedValueOf(definitions.model, d.feature);
      if (depth >= 4 || typeof value !== 'string') return false;
      const beside = n.slice(0, n.lastIndexOf('.') + 1);
      return namesOfValue(value).some((m) => valued(`${beside}${m}`, depth + 1));
    }
    const symbol = definitions.symbolOf(d);
    if (sourced(symbol)) return true;
    others ??= instanceNamesOf(definitions, x).filter((i) => i !== here);
    return symbol.startsWith(here) && others.some((i) => sourced(`${i}${symbol.slice(here.length)}`));
  };
  return names.some((n) => valued(n, 0));
}

/**
 * The calls the instance index makes to itself where a throw is contained
 * (A.2.9) — inside {@link instanceGroups} (a usage's sites, and the asserted
 * equations the coverage guard reads, {@link readFeatures}), in {@link
 * equatedParts} (the asserted equations no surface reads), in {@link
 * satisfierTaint} (what an instance reads otherwise, the subsetting usages of
 * {@link subsettingTaint} among it), in {@link
 * contradictedDefinitions} (two asserted equations that give one feature two
 * values), in {@link contradictedTaint} (what they leave undecided, asked
 * per row: a throw refuses that row, `internal`) and in {@link
 * DefiningEquations.valuedByBinding} (the contexts a binding gives a value:
 * a throw lists the context, to be read and contained as its own row) —
 * made through this object, never directly: the seam a test makes one of
 * them throw through (`vi.spyOn`), since a module-level stub reaches only the
 * calls another module makes. Each is the function it names; nothing else
 * changes them.
 */
export const instanceIndexSeam = {
  enclosingAsserts: (model: Model): EnclosingAsserts => enclosingAsserts(model),
  satisfiersOtherwise: (model: Model): SatisfiersOtherwise => satisfiersOtherwise(model),
  subsettingsOtherwise: (model: Model): SubsettingsOtherwise => subsettingsOtherwise(model),
  contradictedDefinitions: (model: Model): ContradictedDefinitions => contradictedDefinitionsUncached(model),
  spreadContradiction: (
    model: Model,
    index: ContradictedDefinitions,
    sets: readonly ContradictedDefinition[],
  ): ReadonlyMap<ElementId, ElementRecord> => spreadContradiction(model, index, sets),
  assertHeldInSome: (model: Model, f: ElementRecord): boolean => assertHeldInSome(model, f),
  instanceSitesOf: (definitions: DefiningEquations, usage: ElementRecord): ReturnType<typeof instanceSitesOf> =>
    instanceSitesOf(definitions, usage),
  bindingValued: (definitions: DefiningEquations, x: ElementRecord, names: readonly string[]): boolean =>
    bindingValued(definitions, x, names),
};

/**
 * The groups a relation is read per instance in, one per (relation, shared
 * usage) — a usage whose reading `boundAbove` reports otherwise. Each group is
 * expanded all-or-nothing (A.7): the frames of its definition are not
 * truncated, it has at most {@link MAX_INSTANCE_READS} instances, and the
 * sweep stays at or under {@link MAX_INSTANCE_RELATIONS}. An unexpanded group
 * keeps today's single refusal, in the cap's sentence. So does a group whose
 * usage reads the relation through a bound part ({@link GuardReading}'s
 * `bound`; `bind p.r = s`): no row of it — its generic row included — reads
 * what the part is bound to (`not-enumerated`). In an expanded group, an
 * instance whose own element reads the relation otherwise than the usage
 * does is read in that element (`readIn`), or — where that element cannot be
 * read for it — not read: the coverage guard ({@link instanceReadsOtherwise})
 * lists it in `otherwise`, and its row abstains on every surface. An instance
 * that is an element's own instance is that element's reading (`standsFor`),
 * and one that a group of a more specific usage lists is that group's: every
 * instance is one row.
 *
 * Once per model revision ({@link INSTANCE_GROUPS}, B.5): the check, the
 * obligations lane and the numeric lane each ask it, and the app's validation
 * sweep, Check and Solve ask it again of the same revision. The list, its
 * groups and their instance lists are shared, and frozen, and the maps are
 * read-only — read them, never change them.
 *
 * Never throws for a usage (A.2.9): a throw while one is grouped — its
 * `boundAbove`, its sites, the coverage guard's reading — makes that usage's
 * group one unexpanded `internal` refusal, in the A.9 sentence
 * ({@link failedReadingSentence}), which every surface abstains on as it does
 * on a capped group; the relation's other groups, and every other relation,
 * read as they would.
 */
export function instanceGroups(model: Model): readonly InstanceGroup[] {
  const hit = INSTANCE_GROUPS.get(model);
  if (hit && hit.rev === model.rev) return hit.groups;
  const groups = Object.freeze(
    groupsOf(model).map((g) => {
      Object.freeze(g.instances);
      if (g.refusal) Object.freeze(g.refusal);
      return Object.freeze(g);
    }),
  );
  INSTANCE_GROUPS.set(model, { rev: model.rev, groups });
  return groups;
}

/** {@link instanceGroups}, worked out. */
function groupsOf(model: Model): InstanceGroup[] {
  const definitions = sharedDefinitions(model);
  if (!readsPerInstance(model)) return [];
  const out: InstanceGroup[] = [];
  const read = new Map<string, GuardReading | undefined>();
  const caches: PathCaches = { twice: new Map(), walks: new Map(), elements: new Map() };
  let budget = MAX_INSTANCE_RELATIONS;
  for (const el of model.ofKind('ConstraintUsage', 'RequirementUsage')) {
    if (el.ownerId == null) continue;
    const expr = el.attrs.expression;
    if (typeof expr !== 'string' || expr.trim() === '') continue;
    const definition = model.get(el.ownerId);
    if (!definition || definition.attrs.isLibrary === true) continue;
    const names = relationNamesOf(expr);
    // A.2.9: a throw while a usage is grouped is that group's — one `internal`
    // refusal, which every surface abstains on in its sentence, as a reading
    // that throws in `bindingConflicts` or `boundInInstanceQ` is that row's —
    // never a throw out of the sweep: the check, the obligations lane and the
    // numeric lane all ask this, and a throw here emptied every one of them. A
    // usage whose question throws is grouped so, and the budget the group had
    // taken is given back. (`readingContexts` is the relation's own context
    // walk, which every reading of it asks too: not the index's.)
    const failed = (usage: ElementRecord, e: unknown): InstanceGroup => ({
      relationId: el.id,
      usageId: usage.id,
      definitionId: definition.id,
      instances: [definitions.instanceNameOf(usage.id)],
      expanded: false,
      refusal: {
        kind: 'internal',
        sentence: failedReadingSentence(effectiveQualifiedName(model, el.id), definitions.instanceNameOf(usage.id), e),
      },
    });
    const threw = new Map<ElementId, { error: unknown }>();
    const groupedAbove = (usage: ElementRecord): boolean => {
      try {
        return definitions.boundAbove(usage.id, names) !== undefined;
      } catch (error) {
        threw.set(usage.id, { error });
        return true;
      }
    };
    const usages: ElementRecord[] = [];
    for (const usage of definitions.readingContexts(el, names)) {
      if (isUsage(usage.eClass) && groupedAbove(usage)) usages.push(usage);
    }
    // A relation OWNED by a usage U (R17c/R17, R1-M2): U is itself a group —
    // its own row is U's generic reading, and each other instance gets a row
    // of its own. `readingContexts` never lists the owner, so this is added.
    if (isUsage(definition.eClass) && groupedAbove(definition)) usages.push(definition);
    let mine: InstanceGroup[] = [];
    // The instances on whose path a name is inherited twice, per group
    // ({@link diamondOnPath}): no group of one of the features takes them.
    const diamonds = new Map<InstanceGroup, Set<string>>();
    const before = budget;
    for (const usage of usages) {
      const early = threw.get(usage.id);
      if (early !== undefined) {
        mine.push(failed(usage, early.error));
        continue;
      }
      const spent = budget;
      try {
        const { sites, truncated } = instanceIndexSeam.instanceSitesOf(definitions, usage);
        const instances = [...sites.keys()];
        const group: InstanceGroup = { relationId: el.id, usageId: usage.id, definitionId: definition.id, instances, expanded: false };
        if (truncated) {
          group.refusal = {
            kind: 'past-cap',
            sentence: `a binding of this model holds in more than ${MAX_BINDING_FRAMES.toLocaleString('en')} contexts`,
            // The sites found before the frame cap tripped: a lower bound of the group's instances.
            unread: { count: instances.length, cap: `a binding of this model holds in more than ${MAX_BINDING_FRAMES.toLocaleString('en')} contexts`, atLeast: true },
          };
        } else if (instances.length > MAX_INSTANCE_READS) {
          group.refusal = {
            kind: 'past-cap',
            sentence: `${effectiveQualifiedName(model, el.id)} is read in more than ${MAX_INSTANCE_READS.toLocaleString('en')} instances of ${definitions.contextName(usage.id)}; this tool reads none of them per instance`,
            unread: { count: instances.length, cap: `more than ${MAX_INSTANCE_READS.toLocaleString('en')} instances` },
          };
        } else if (budget - instances.length < 0) {
          group.refusal = {
            kind: 'past-cap',
            sentence: `more than ${MAX_INSTANCE_RELATIONS.toLocaleString('en')} instance readings in this model`,
            unread: { count: instances.length, cap: `more than ${MAX_INSTANCE_RELATIONS.toLocaleString('en')} instance readings in this model` },
          };
        } else {
          // The usage's own reading first: through a bound part (or past the
          // guard's budget) no row of the group reads what it stands for.
          const reading = guardReading(definitions, el, usage.id, names, read);
          const where = definitions.contextName(usage.id);
          if (reading === undefined || reading.bound !== undefined) {
            group.refusal = {
              kind: 'not-enumerated',
              sentence: `${effectiveQualifiedName(model, el.id)} is not read per instance in ${where}: ${
                reading === undefined
                  ? `what it reads runs past ${MAX_GUARD_PATHS} names, and this tool cannot tell which instance reads it otherwise`
                  : boundPartPhrase(reading.bound!, where)
              }`,
            };
          } else {
            group.expanded = true;
            budget -= instances.length;
            const otherwise = new Map<string, { kind: InstanceAbstention; sentence: string }>();
            const readIn = new Map<string, ElementId>();
            const standsFor = new Map<string, ElementId>();
            const crossed = new Set<string>();
            for (const instance of instances.slice(1)) {
              const own = sites.get(instance) ?? [];
              if (diamondOnPath(definitions, own, caches) !== undefined) crossed.add(instance);
              // The element whose own instance this is: the group's row reads the
              // relation there, so that element's context row is this row.
              const element = instanceElementOf(definitions, own, caches);
              if (element !== undefined && element.id !== usage.id && definitions.instanceNameOf(element.id) === instance) {
                standsFor.set(instance, element.id);
              }
              const verdict = instanceReadsOtherwise(definitions, el, usage, instance, own, names, read, caches);
              if (verdict === undefined) continue;
              if ('element' in verdict) readIn.set(instance, verdict.element.id);
              else otherwise.set(instance, verdict);
            }
            if (otherwise.size > 0) group.otherwise = otherwise;
            if (readIn.size > 0) group.readIn = readIn;
            if (standsFor.size > 0) group.standsFor = standsFor;
            if (crossed.size > 0) diamonds.set(group, crossed);
          }
        }
        mine.push(group);
      } catch (e) {
        budget = spent;
        mine.push(failed(usage, e));
      }
    }
    // A group of a usage that redefines another group's usage (Q2's `part :>>
    // p : P2`, a group of its own where q2 sets Q's L, below Q's p) reads its
    // instances itself — through the more specific usage, each in its own
    // element: the other group files none of them, so each is one row. An
    // instance on whose path a name is inherited twice (Q3's p, Q2's p and
    // Q4's p at once) is no more Q2's than Q4's: the group it is taken from
    // keeps it, and every group of one of the features drops it. One that
    // two groups still list is filed by the first.
    try {
      const byUsage = new Map(mine.map((g) => [g.usageId, g] as const));
      const taken = new Map<InstanceGroup, Set<string>>();
      const dropped = (g: InstanceGroup): Set<string> => {
        let set = taken.get(g);
        if (!set) taken.set(g, (set = new Set<string>()));
        return set;
      };
      if (mine.length > 1) {
        for (const h of mine) {
          const hu = model.get(h.usageId);
          for (const x of hu ? redefinedClosure(model, hu) : []) {
            const g = byUsage.get(x.id);
            if (g === undefined || g === h) continue;
            const listed = new Set(g.instances);
            for (const [k, i] of h.instances.entries()) {
              if (k > 0 && diamonds.get(h)?.has(i) === true && listed.has(i)) dropped(h).add(i);
              else dropped(g).add(i);
            }
          }
        }
        const filed = new Set<string>();
        for (const g of mine) {
          for (const [k, i] of g.instances.entries()) {
            if (k === 0 || taken.get(g)?.has(i) === true) continue;
            if (filed.has(i)) dropped(g).add(i);
            else filed.add(i);
          }
        }
      }
      for (const [g, theirs] of taken) {
        g.instances = g.instances.filter((i, k) => k === 0 || !theirs.has(i));
        const keep = <V>(m: ReadonlyMap<string, V> | undefined): Map<string, V> | undefined => {
          const kept = new Map([...(m ?? [])].filter(([i]) => !theirs.has(i)));
          return kept.size > 0 ? kept : undefined;
        };
        const [otherwise, readIn, standsFor] = [keep(g.otherwise), keep(g.readIn), keep(g.standsFor)];
        if (otherwise) g.otherwise = otherwise;
        else delete g.otherwise;
        if (readIn) g.readIn = readIn;
        else delete g.readIn;
        if (standsFor) g.standsFor = standsFor;
        else delete g.standsFor;
      }
    } catch (e) {
      budget = before;
      mine = mine.map((g) => failed(model.get(g.usageId) ?? definition, e));
    }
    out.push(...mine);
  }
  return out;
}

/**
 * Whether a name read at an instance lies below a frame among `enclosing` whose
 * reader asserts a relation referencing the remaining dotted path — the read
 * then abstains with `enclosing-assert` (A.2.4, R1-S5): the enclosing assert
 * constrains the value, and this tool reads no value an enclosing assert
 * constrains. Each frame is checked against the name as it is spelled below
 * that frame (`q1.p.x` read in R1, q1's `assert { p.x == 50.0 }` references the
 * remaining `p.x`). `{ frame, expr }` names the first such frame and its
 * expression; `undefined` where none does.
 *
 * `inst` is the instance the context is read for. Where it is not the
 * context's own — a group row reads Q's p for `R1::q1::p`, a derived value is
 * read in its definition for the instance it belongs to — the frames are the
 * INSTANCE's: every instance enclosing `inst` ({@link
 * DefiningEquations.framesAbove}), outermost first, the name spelled below
 * each (`p.x` below q1, `q1.p.x` below R1), then the context's own frames
 * below it. Read through the usage's frames alone, R1's group row `P::c in
 * R1::q1::p` read x's default past q1's `assert constraint { p.x == 50.0 }`,
 * decided where the own row `top1`, the same quantity at the same instance,
 * abstained (A-H1). The package is the outermost such frame (H1C's `assert
 * constraint { q1.p.x == 50.0 }` constrains q1's p's x as q1's own does). A
 * type definition's own instance (`R1::Q` above `R1::Q::p`) is no such frame:
 * its asserts hold of every instance of it, and a reading in its usage reads
 * them as today, whether the name is read there or in a value that usage
 * reads.
 */
export function enclosingAssertOn(
  model: Model,
  contextId: ElementId,
  enclosing: readonly InstanceFrame[],
  name: string,
  inst?: string,
): { frame: ElementId; expr: string } | undefined {
  const answer = assertEnclosing(model, contextId, enclosing, name, inst);
  // Where nothing is asserted, the answer is the same for every instance: no question of its spelling.
  if (inst !== undefined && recording !== undefined && sharedDefinitions(model).anyAsserted()) {
    recording.push({ kind: 'enclosing', contextId, enclosing, name, inst, answer });
  }
  return answer;
}

/** {@link enclosingAssertOn}, worked out: only a frame whose reader asserts something is spelled out. */
function assertEnclosing(
  model: Model,
  contextId: ElementId,
  enclosing: readonly InstanceFrame[],
  name: string,
  inst?: string,
): { frame: ElementId; expr: string } | undefined {
  const definitions = sharedDefinitions(model);
  if (!definitions.anyAsserted()) return undefined;
  const root = definitions.instanceNameOf(contextId);
  const segments = name.split('.');
  const constrains = (reader: ElementRecord, remaining: string): { frame: ElementId; expr: string } | undefined => {
    for (const { expr, names } of definitions.assertsOf(reader.id)) {
      for (const n of names) {
        if (n === remaining || n.startsWith(`${remaining}.`) || remaining.startsWith(`${n}.`)) {
          return { frame: reader.id, expr };
        }
      }
    }
    return undefined;
  };
  if (inst !== undefined && inst !== root) {
    for (const frame of definitions.framesAbove(inst) ?? []) {
      if (definitions.assertsOf(frame.reader).length === 0) continue;
      const reader = model.get(frame.reader);
      if (!reader || reader.attrs.isLibrary === true) continue;
      // A type definition's own frame reads as before; a package's is the instance's outermost frame (its
      // `assert constraint { q1.p.x == 50.0 }` constrains q1's p's x as q1's own `p.x == 50.0` does).
      if (isDefinition(reader.eClass) && reader.eClass !== 'Package' && reader.eClass !== 'LibraryPackage') continue;
      if (!inst.startsWith(`${frame.instance}::`)) continue;
      const below = inst.slice(frame.instance.length + 2).split('::');
      const hit = constrains(reader, [...below, ...segments].join('.'));
      if (hit) return hit;
    }
  }
  for (const frame of enclosing) {
    if (definitions.assertsOf(frame.reader).length === 0) continue;
    const reader = model.get(frame.reader);
    if (!reader || reader.attrs.isLibrary === true) continue;
    const rel =
      frame.instance === root
        ? 0
        : frame.instance.startsWith(`${root}::`)
          ? frame.instance.slice(root.length + 2).split('::').length
          : segments.length;
    // The row's own context is read as today (A.2.4); only the frames strictly
    // between it and the instance constrain the read.
    if (rel === 0) continue;
    const remaining = segments.slice(rel).join('.');
    if (remaining === '') continue;
    const hit = constrains(reader, remaining);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Is `f` a calculation whose stated value is its BODY ({@link statedValueOf})?
 *
 * Such a body is read in the calculation's owner, over the owner's names. It
 * is a value there; read where the calculation is INHERITED (`part p : P`,
 * over P's `calc margin { 10.0 - load }`) or through a feature chain
 * (`p.margin`), it is P's arithmetic over P's inputs — the value the reading
 * context has when that context changes nothing it reads, and the wrong one
 * wherever it redefines one (`:>> load = 50.0` makes margin −40, read as 5).
 * Every surface reads it there as it reads an inherited asserted definition:
 * over the context's own names ({@link DefiningEquations.valueRef}).
 */
export function isCalculationValue(model: Model, f: ElementRecord): boolean {
  if (f.eClass !== 'CalculationUsage') return false;
  if (f.attrs.value !== undefined && f.attrs.value !== null) return false;
  return statedValueOf(model, f) !== undefined;
}

/**
 * Does `f` state a value that READS something — an expression over names, or a
 * calculation's body — rather than a literal? Such a value is read where it is
 * written, and in a context that changes what it reads, over that context's
 * names ({@link DefiningEquations.valueRef}).
 */
export function isDerivedValue(model: Model, f: ElementRecord): boolean {
  if (isCalculationValue(model, f)) return true;
  const v = f.attrs.value;
  return typeof v === 'string' && namesOfValue(v).length > 0;
}

/* ─────────────────────── A value written with `=` is a binding ─────────────────────── */

/**
 * How two written values compare ({@link compareWrittenValues}): the same
 * value, two different values, or a pair only an evaluation could compare.
 */
export type WrittenComparison = 'same' | 'differs' | 'undecided';

/**
 * Two values a context inherits under one name ({@link DefiningEquations.clash}):
 * the feature the name keeps and the other one, the features whose written
 * values each reads ({@link valueSourceOf}), and whether the two are bindings
 * that contradict each other — `decided` where two literals differ.
 */
export interface NameClash {
  kept: ElementRecord;
  other: ElementRecord;
  keptValue: ElementRecord;
  otherValue: ElementRecord;
  contradiction: boolean;
  decided: boolean;
  /**
   * Set where the other is no inherited value but the feature a body a general
   * type writes (`writer`, in `general`) reads the name as, through that
   * type's owners ({@link DefiningEquations.lexicalShadows}): never a
   * contradiction, and `other` is that feature.
   */
  shadow?: { writer: ElementRecord; general: ElementRecord };
  /**
   * Set where the name is one of the features a general type's `line` redefines together (`attribute X :>> M, N;`)
   * beside a redefinition of one of them in the context ({@link DefiningEquations.mergedLines}): never a
   * contradiction, and `other` is that line.
   */
  merged?: { line: ElementRecord; name: string; differing: ElementRecord[] };
  /**
   * Set where the context states one feature twice, and not alike ({@link DefiningEquations.redefinedTwice}): `keptValue` and
   * `otherValue` are two of the statements, `target` the feature redefined (`redefines`; else the first of the features
   * that hide each other by name), `hasValues` whether both state a value, `byUnit` whether they all state one quantity in
   * different units.
   */
  twice?: { target: ElementRecord; redefines: boolean; hasValues: boolean; byUnit: boolean };
  /**
   * The features this clash holds, beside the one the name keeps ({@link DefiningEquations.clash}): a merged line's line and
   * targets, the features a context states twice and the one they redefine. A feature that redefines one of them is held too,
   * whatever name it answers to (`attribute Y :>> X;` beside `attribute :>> X default = 2.0;`).
   */
  family?: ReadonlySet<ElementId>;
  /**
   * Set where the two values are the same, and the context's own feature of
   * the name states nothing and redefines neither ({@link
   * DefiningEquations.clashesIn}): never a contradiction, and read nowhere,
   * since this tool does not read the agreed value through that feature.
   */
  same?: true;
}

/** The feature whose written value `f` reads: `f` itself, else the nearest it redefines that states one. */
function valueSourceOf(model: Model, f: ElementRecord): ElementRecord | undefined {
  for (const g of [f, ...redefinedClosure(model, f)]) {
    if (g.attrs.isLibrary === true) return undefined;
    if (g.attrs.value !== undefined && g.attrs.value !== null) return g;
  }
  return undefined;
}

/**
 * `C::load` inherits A::load = 5.0 and B::load = 7.0 … — the one sentence every
 * surface gives a name two inherited values collide under ({@link NameClash}).
 */
export function clashSentence(model: Model, contextId: ElementId, clash: NameClash): string {
  const context = effectiveQualifiedName(model, contextId);
  const name = effectiveNameOf(model, clash.kept) ?? 'the feature';
  if (clash.shadow) {
    const { writer, general } = clash.shadow;
    const body = effectiveNameOf(model, writer) ?? 'a body';
    return (
      `${context} declares \`${name}\` itself, and \`${body}\` in ${effectiveQualifiedName(model, general.id)} reads \`${name}\` as ` +
      `${effectiveQualifiedName(model, clash.other.id)}, as KerML resolves it where it is written; one reading of ${context} ` +
      'cannot give the name both meanings, so neither is read there'
    );
  }
  if (clash.twice) {
    const { target, redefines, hasValues } = clash.twice;
    const feature = effectiveNameOf(model, target) ?? name;
    const what = redefines ? `redefines \`${feature}\` twice` : `states \`${feature}\` twice (declared beside a redefinition of it)`;
    const how = hasValues ? `, with ${writtenValue(clash.keptValue)} and ${writtenValue(clash.otherValue)}` : ', and not alike (a value beside none, or content nested below)';
    return `${context} ${what}${how}, so the model states both for the one feature and neither is read`;
  }
  if (clash.merged) {
    const { line, differing } = clash.merged;
    const names = [...new Set(model.relationshipsFrom(line.id).filter((r) => r.eClass === 'Redefinition').flatMap((r) => r.target ?? []).map((t) => `\`${effectiveNameOf(model, model.require(t)) ?? t}\``))];
    const row = clash.merged.name;
    const spelled = line.declaredName !== undefined ? effectiveQualifiedName(model, line.id) : `the unnamed \`:>> ${names.map((n) => n.slice(1, -1)).join(', ')}\` in ${line.ownerId != null ? effectiveQualifiedName(model, line.ownerId) : '…'}`;
    const read = row === (effectiveNameOf(model, line) ?? row) ? `\`${row}\`` : `\`${row}\` (a name of the line's one feature)`;
    if (differing.length > 0) {
      return (
        `${spelled} redefines ${names.join(' and ')} together, so in ${context} they are one feature, and what they state differs ` +
        `(${differing.map((d) => `${writtenName(model, d)} ${d.attrs.defaultValue === true ? 'default ' : ''}= ${writtenValue(d)}`).join(' and ')}); ` +
        `the one feature has no one value to read (a firm value beats a default, and two of either do not agree), so ${read} is not read there`
      );
    }
    return (
      `${spelled} redefines ${names.join(' and ')} together, so in ${context} they are one feature, ` +
      `which a redefinition of each can give two values; this tool reads them as separate features, so ${read} is not read there`
    );
  }
  const both =
    `${context} inherits ${writtenName(model, clash.keptValue)} = ${writtenValue(clash.keptValue)} and ` +
    `${writtenName(model, clash.otherValue)} = ${writtenValue(clash.otherValue)} under the one name \`${name}\``;
  if (clash.decided) {
    return `${both}, both bindings every instance holds (values written with \`=\`), so the model states both values and neither is read`;
  }
  if (clash.same) {
    return (
      `${both}, which agree; but its own \`${name}\` states nothing (an implicit connector-end copy, or a redefinition with no ` +
      'value) and redefines neither, and this tool does not read the value they agree on through it, so neither is read'
    );
  }
  return `${both}, and which one an instance has is not decided by reading them, so neither is read`;
}

/**
 * A redefinition's value against a BINDING it redefines
 * ({@link contradictedBindingOf}): the binding, and whether the two values are
 * DECIDED to differ — two literal values, compared exactly. Undecided, the
 * two may still meet (`:>> load = 50.0` over `load = 2.0 * k` where the
 * redefinition's context makes k 25): neither is read here, and the
 * verification lane, which carries both, decides.
 */
export interface BindingConflict {
  binding: ElementRecord;
  decided: boolean;
}

/**
 * The BINDING `f`'s own stated value contradicts — the nearest feature `f`
 * overrides ({@link overriddenBy}), transitively, whose value is written with
 * `=` (not `default`) and is not the value `f` states — or `undefined`.
 *
 * KerML reads `attribute load = 1.0` in `part def P` as a binding: every P,
 * in every context, has load 1.0. A usage that redefines it with another
 * value (`part p : P { attribute :>> load = 50.0; }`) states that p's load is
 * 50 AND 1: the model contradicts itself, and no surface may silently read
 * either value as p's. Only `attribute load default = 1.0` is overridable —
 * the redefinition's value replaces a DEFAULT in its own context.
 *
 * The values are compared as VALUES, never as spelled
 * ({@link compareWrittenValues}): `1000.0 [g]` restates `1.0 [kg]`, `10.0-k`
 * restates `10.0 - k`, and neither contradicts anything; `1.0 [g]` against
 * `1.0 [kg]` does. A pair only an evaluation could compare is a conflict
 * that is not `decided`.
 */
export function contradictedBindingOf(model: Model, f: ElementRecord): BindingConflict | undefined {
  const v = f.attrs.value;
  if (v === undefined || v === null) return undefined;
  for (const g of overriddenBy(model, f)) {
    const w = g.attrs.value;
    // The standard library's own values are its modelling, not a design's
    // bindings: a redefinition of one is read as the library means it.
    if (w === undefined || w === null || g.attrs.defaultValue === true || g.attrs.isLibrary === true) continue;
    const compared = compareWrittenValues(f, g);
    if (compared !== 'same') return { binding: g, decided: compared === 'differs' };
  }
  return undefined;
}

/**
 * The features `f` overrides: every feature it redefines, transitively, and
 * every one it masks BY NAME ({@link maskedByName}) — `attribute load = 50.0`
 * written in `part p : P` with no `:>>` over P's `load = 1.0` replaced it all
 * the same, silently, where the strict reading makes it a contradiction.
 */
function overriddenBy(model: Model, f: ElementRecord): ElementRecord[] {
  const masked = maskedByName(model, f);
  const closure = redefinedClosure(model, f);
  return masked.length === 0 ? closure : [...closure, ...masked.filter((g) => !closure.includes(g))];
}

/**
 * Do `a` and `b` state the same value — compared as values, not as written?
 *  - Two literal numbers: exactly, as the decimals written, each in SI
 *    through the unit registry (`1000.0 [g]` is `1.0 [kg]`; a mass is never
 *    a length) — `same` or `differs`. A unit nothing converts is compared as
 *    spelled, and one side with a unit and the other without is `undecided`.
 *  - Two booleans, or two quoted strings: as written.
 *  - Two value expressions: the same parsed body — whitespace and the
 *    spelling of a unit literal aside — is `same`; any other pair of
 *    expressions, or an expression against a literal, only an evaluation
 *    could compare: `undecided`.
 */
export function compareWrittenValues(a: ElementRecord, b: ElementRecord): WrittenComparison {
  const x = a.attrs.value;
  const y = b.attrs.value;
  if (typeof x === 'number' && typeof y === 'number') return compareQuantities(a, b);
  if (typeof x === 'boolean' && typeof y === 'boolean') return x === y ? 'same' : 'differs';
  if (typeof x === 'string' && typeof y === 'string') {
    const s = x.trim();
    const t = y.trim();
    if (isQuoted(s) && isQuoted(t)) return s === t ? 'same' : 'differs';
    if (s === t) return 'same';
  }
  // A value that reads no name is a CONSTANT, compared exactly: `2.0 * 0.5`
  // is the binding `1.0`, and `1000.0 [g]` is `1.0 [kg]`.
  const cx = constantOf(a);
  const cy = constantOf(b);
  if (cx && cy) return compareConstants(cx, cy);
  if (typeof x !== 'string' || typeof y !== 'string') return 'undecided';
  const p = parseRelationBody(x.trim());
  const q = parseRelationBody(y.trim());
  if (!p || !q || (p.hadUnit && !p.resolved) || (q.hadUnit && !q.resolved)) return 'undecided';
  return sameBody(p.node, p.literals, q.node, q.literals) ? 'same' : 'undecided';
}

/** An exact constant: its value in SI, and its dimension — `undefined` for a bare number. */
interface Constant {
  si: Rational;
  dimension: Dimension | undefined;
}

/** Two constants compared exactly: a bare number against a quantity is not decided by reading them. */
function compareConstants(a: Constant, b: Constant): WrittenComparison {
  if (a.dimension === undefined || b.dimension === undefined) {
    if (a.dimension !== b.dimension) return 'undecided';
    return equalRationals(a.si, b.si) ? 'same' : 'differs';
  }
  if (!dimEqual(a.dimension, b.dimension)) return 'differs';
  return equalRationals(a.si, b.si) ? 'same' : 'differs';
}

/**
 * `f`'s value as an exact constant — a literal number with the unit beside it,
 * or a value expression that reads no name, over `+ - * /` and `[unit]`
 * literals — or `undefined`.
 */
function constantOf(f: ElementRecord): Constant | undefined {
  const v = f.attrs.value;
  if (typeof v === 'number') {
    const m = magnitudeOf(f);
    const unit = typeof f.attrs.unit === 'string' ? f.attrs.unit.trim() : '';
    if (!m) return undefined;
    if (unit === '') return { si: m, dimension: undefined };
    const u = resolveUnit(unit);
    if (!u || u.offsetSI) return undefined;
    return { si: multiplyRationals(m, scaleRational(u.factorToSI, u.factorTerms)), dimension: u.dimension };
  }
  if (typeof v !== 'string' || isQuoted(v.trim())) return undefined;
  const body = parseRelationBody(v.trim());
  if (!body || (body.hadUnit && !body.resolved)) return undefined;
  return exactConstant(body.node, body.literals);
}

/**
 * A name-free expression evaluated exactly, or `undefined` where it reads a name or leaves `+ - * /` — with `env`,
 * the names it gives an exact value read as that value.
 */
function exactConstant(n: ExprNode, literals: MarkerDimensions, env?: ReadonlyMap<string, Constant>): Constant | undefined {
  switch (n.kind) {
    case 'num': {
      const r = decimalRational(String(n.value));
      return r ? { si: r, dimension: undefined } : undefined;
    }
    case 'ref': {
      const lit = literals.get(n.path.join('.'));
      if (!lit) return env?.get(n.path.join('.'));
      const m = decimalRational(lit.magnitude);
      if (!m) return undefined;
      return { si: multiplyRationals(m, scaleRational(lit.factor, lit.factorTerms)), dimension: lit.dimension };
    }
    case 'unary': {
      if (n.op === 'not') return undefined;
      const x = exactConstant(n.operand, literals, env);
      return x && n.op === '-' ? { si: { num: -x.si.num, den: x.si.den }, dimension: x.dimension } : x;
    }
    case 'binary': {
      const l = exactConstant(n.left, literals, env);
      const r = exactConstant(n.right, literals, env);
      if (!l || !r) return undefined;
      const dims = (d: (x: Dimension, y: Dimension) => Dimension): Dimension | undefined =>
        l.dimension === undefined ? r.dimension : r.dimension === undefined ? l.dimension : d(l.dimension, r.dimension);
      switch (n.op) {
        case '+':
        case '-': {
          if ((l.dimension === undefined) !== (r.dimension === undefined)) return undefined;
          if (l.dimension && r.dimension && !dimEqual(l.dimension, r.dimension)) return undefined;
          const sign = n.op === '-' ? -1n : 1n;
          return {
            si: { num: l.si.num * r.si.den + sign * r.si.num * l.si.den, den: l.si.den * r.si.den },
            dimension: l.dimension,
          };
        }
        case '*':
          return { si: multiplyRationals(l.si, r.si), dimension: dims(multiplyDim) };
        case '/':
          if (r.si.num === 0n) return undefined;
          return {
            si: { num: r.si.num < 0n ? -l.si.num * r.si.den : l.si.num * r.si.den, den: l.si.den * (r.si.num < 0n ? -r.si.num : r.si.num) },
            dimension: l.dimension === undefined && r.dimension !== undefined ? divideDim(DIMENSIONLESS, r.dimension) : dims(divideDim),
          };
        default:
          return undefined;
      }
    }
    default:
      return undefined;
  }
}

/** Two literal numbers, each with the unit written beside it, compared exactly in SI. */
function compareQuantities(a: ElementRecord, b: ElementRecord): WrittenComparison {
  const ua = typeof a.attrs.unit === 'string' ? a.attrs.unit.trim() : '';
  const ub = typeof b.attrs.unit === 'string' ? b.attrs.unit.trim() : '';
  const ma = magnitudeOf(a);
  const mb = magnitudeOf(b);
  if (!ma || !mb) return a.attrs.value === b.attrs.value && ua === ub ? 'same' : 'undecided';
  if (ua === '' && ub === '') return equalRationals(ma, mb) ? 'same' : 'differs';
  if (ua === '' || ub === '') return 'undecided';
  const fa = resolveUnit(ua);
  const fb = resolveUnit(ub);
  if (!fa || !fb || fa.offsetSI || fb.offsetSI) {
    if (ua !== ub) return 'undecided';
    return equalRationals(ma, mb) ? 'same' : 'differs';
  }
  if (!dimEqual(fa.dimension, fb.dimension)) return 'differs';
  const sa = multiplyRationals(ma, scaleRational(fa.factorToSI, fa.factorTerms));
  const sb = multiplyRationals(mb, scaleRational(fb.factorToSI, fb.factorTerms));
  return equalRationals(sa, sb) ? 'same' : 'differs';
}

/** A literal value as the exact decimal written — its `valueText`, else the number's shortest spelling. */
function magnitudeOf(f: ElementRecord): Rational | undefined {
  const text = typeof f.attrs.valueText === 'string' ? f.attrs.valueText : String(f.attrs.value);
  return decimalRational(text) ?? (typeof f.attrs.value === 'number' ? decimalRational(String(f.attrs.value)) : undefined);
}

function multiplyRationals(a: Rational, b: Rational): Rational {
  return { num: a.num * b.num, den: a.den * b.den };
}

function equalRationals(a: Rational, b: Rational): boolean {
  return a.num * b.den === b.num * a.den;
}

function isQuoted(s: string): boolean {
  return s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")));
}

/**
 * Two parsed bodies the same expression — the same tree, the same names, the
 * same numbers, and every `[unit]` literal the same quantity exactly.
 */
function sameBody(a: ExprNode, la: MarkerDimensions, b: ExprNode, lb: MarkerDimensions): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'num':
      return a.value === (b as typeof a).value;
    case 'bool':
      return a.value === (b as typeof a).value;
    case 'ref': {
      const pa = a.path.join('.');
      const pb = (b as typeof a).path.join('.');
      const ma = la.get(pa);
      const mb = lb.get(pb);
      if (ma || mb) {
        if (!ma || !mb || !dimEqual(ma.dimension, mb.dimension)) return false;
        const ra = decimalRational(ma.magnitude);
        const rb = decimalRational(mb.magnitude);
        if (!ra || !rb) return ma.si === mb.si;
        return equalRationals(
          multiplyRationals(ra, scaleRational(ma.factor, ma.factorTerms)),
          multiplyRationals(rb, scaleRational(mb.factor, mb.factorTerms)),
        );
      }
      return pa === pb;
    }
    case 'unary':
      return a.op === (b as typeof a).op && sameBody(a.operand, la, (b as typeof a).operand, lb);
    case 'binary':
      return (
        a.op === (b as typeof a).op &&
        sameBody(a.left, la, (b as typeof a).left, lb) &&
        sameBody(a.right, la, (b as typeof a).right, lb)
      );
    case 'if':
      return (
        sameBody(a.cond, la, (b as typeof a).cond, lb) &&
        sameBody(a.then, la, (b as typeof a).then, lb) &&
        sameBody(a.else, la, (b as typeof a).else, lb)
      );
    default:
      return JSON.stringify(a) === JSON.stringify(b);
  }
}

/** Does `mine` restate the LITERAL value `g` states — one that reads no name — as the same value ({@link compareWrittenValues})? */
function isLiteralRestatement(mine: ElementRecord, g: ElementRecord): boolean {
  const v = g.attrs.value;
  if (v === undefined || v === null || mine.attrs.value === undefined || mine.attrs.value === null) return false;
  if (typeof v === 'string' && namesOfValue(v).length > 0) return false;
  return compareWrittenValues(mine, g) === 'same';
}

/**
 * Does `f` — a redefinition that states no value — change what lies below it:
 * own a feature that states a value or redefines one, or carry a type of its
 * own (`part :>> e : E2`)? An implicit connector-end copy changes nothing.
 */
function changesBelow(model: Model, f: ElementRecord): boolean {
  if (model.relationshipsFrom(f.id).some((r) => r.eClass === 'FeatureTyping')) return true;
  return model
    .children(f.id)
    .some((c) => isUsage(c.eClass) && (hasStatedValue(model, c) || redefinedClosure(model, c).length > 0));
}

/**
 * The one sentence every surface gives a feature whose value conflicts with a
 * binding it overrides ({@link contradictedBindingOf}): `p::load = 50.0
 * contradicts P::load = 1.0, a binding …` where the two values are decided to
 * differ, and where only an evaluation could compare them, that neither is
 * read while the verification lane decides.
 */
export function contradictionSentence(model: Model, f: ElementRecord, conflict: BindingConflict): string {
  const { binding } = conflict;
  const owner = binding.ownerId != null ? model.get(binding.ownerId) : undefined;
  const ownerName = owner?.declaredName ?? owner?.declaredShortName ?? 'its owner';
  const overrides = redefinedClosure(model, f).includes(binding) ? 'redefines' : 'masks by name';
  if (!conflict.decided) {
    return (
      `${writtenName(model, f)} = ${writtenValue(f)} ${overrides} ${writtenName(model, binding)} = ` +
      `${writtenValue(binding)}, a binding every ${ownerName} holds (a value written with \`=\`), with a value ` +
      'that is not the same as written; whether the two meet takes an evaluation this tool does not make here, so ' +
      'neither is read — the verification lane carries both and decides'
    );
  }
  return (
    `${writtenName(model, f)} = ${writtenValue(f)} contradicts ${writtenName(model, binding)} = ` +
    `${writtenValue(binding)}, a binding every ${ownerName} holds (a value written with \`=\`); a redefinition ` +
    'may override only a `default`, so the model states both values and neither is read'
  );
}

/** `p::load` — the owner's name and the feature's effective one. */
function writtenName(model: Model, f: ElementRecord): string {
  const owner = f.ownerId != null ? model.get(f.ownerId) : undefined;
  const own = effectiveNameOf(model, f) ?? f.declaredShortName ?? `«${f.eClass}»`;
  const ownerName = owner ? (effectiveNameOf(model, owner) ?? owner.declaredShortName) : undefined;
  return ownerName ? `${ownerName}::${own}` : own;
}

/** A feature's value as written, its unit beside it. */
function writtenValue(f: ElementRecord): string {
  const text = typeof f.attrs.valueText === 'string' ? f.attrs.valueText : String(f.attrs.value);
  return typeof f.attrs.unit === 'string' && f.attrs.unit !== '' ? `${text} [${f.attrs.unit}]` : text;
}

/**
 * Does calculation `el` have a parameter — a directed feature, or any feature
 * its `body` names — among its EFFECTIVE features? A calculation typed by a
 * `calc def` owns none of the definition's parameters and has every one of
 * them: `calc t : Scale { x * 5.0 }` reads Scale's `in x`, not the `x` of the
 * part it is written in.
 */
function ownsParameter(model: Model, el: ElementRecord, body: string): boolean {
  // A calculation that specialises one with a body of its own — `calc t : Two {
  // x * 5.0 }` over `calc def Two { 2.0 }`, `calc t :> base { … }` — has that
  // result binding too: its own body is not its whole value.
  if (inheritsBody(model, el)) return true;
  const features = effectiveFeatures(model, el.id);
  if (features.length === 0) return false;
  const parsed = parseRelationBody(body);
  const read = new Set<string>();
  const walk = (n: ExprNode): void => {
    switch (n.kind) {
      case 'ref':
        if (n.path[0] !== undefined) read.add(n.path[0]);
        return;
      case 'unary':
        walk(n.operand);
        return;
      case 'binary':
        walk(n.left);
        walk(n.right);
        return;
      case 'if':
        walk(n.cond);
        walk(n.then);
        walk(n.else);
        return;
      default:
        return;
    }
  };
  if (parsed) walk(parsed.node);
  return features.some((c) => {
    const direction = c.attrs.direction;
    if (direction === 'in' || direction === 'out' || direction === 'inout') return true;
    const name = effectiveNameOf(model, c);
    return name !== undefined && read.has(name);
  });
}

/** Does a calculation or calc def `el` specialises (typing, subsetting, redefinition) carry a body of its own? */
function inheritsBody(model: Model, el: ElementRecord): boolean {
  return generalizationsOf(model, el.id).some(
    (g) =>
      g.attrs.isLibrary !== true &&
      (g.eClass === 'CalculationUsage' || g.eClass === 'CalculationDefinition') &&
      typeof g.attrs.expression === 'string' &&
      g.attrs.expression.trim() !== '',
  );
}

/**
 * Is `el` a calculation whose body is a value expression that it states no
 * value by — one with a parameter ({@link statedValueOf})? Its body is the
 * value of a CALL, over arguments, and read in the owner's scope it is a value
 * nothing in the model states: no surface reads it, and the verification lane
 * asserts no axiom from it.
 */
export function isParameterisedCalculation(model: Model, el: ElementRecord): boolean {
  if (el.eClass !== 'CalculationUsage' || !el.declaredName) return false;
  if (el.attrs.value !== undefined && el.attrs.value !== null) return false;
  const body = el.attrs.expression;
  return typeof body === 'string' && isValueBody(body) && ownsParameter(model, el, body);
}

/* ─────────────────────── Names a body's own features shadow ─────────────────────── */

/**
 * The names `names` (as a body reads them, dotted or bare) whose HEAD `el`
 * declares ITSELF — an owned or inherited feature of the constraint,
 * calculation, requirement or feature that owns the body, by its effective
 * name ({@link DefiningEquations.nameOf}: an unnamed `in :>> y = 100.0` is
 * `y`): a parameter (`in y = 100.0`), a local `attribute y`, a parameter of
 * the `constraint def` or `calc def` typing it, a feature of a feature's own
 * — where the scope of `el`'s OWNER resolves that head to a DIFFERENT
 * feature.
 *
 * Every evaluator reads a body through its owner's names first. SysML resolves
 * a name in the innermost namespace first, so there the name is `el`'s own
 * feature, and every surface read the owner's: `constraint c { in y = 100.0; y
 * <= 10.0 }` beside `attribute y = 4.0` was satisfied, and PROVED, with y 100.
 * Where the owner has no such name the merged scope already reads `el`'s own,
 * and nothing is shadowed. A shadowed body is read by no surface: it is
 * undecided, never judged against the owner's value — and an assumption that
 * is one is no premise a proof may stand on.
 */
export function shadowedNamesOf(model: Model, el: ElementRecord, names: Iterable<string>): string[] {
  if (el.ownerId == null) return [];
  const definitions = sharedDefinitions(model);
  let own: ReadonlyMap<string, ElementRecord> | undefined;
  const out: string[] = [];
  for (const name of new Set(names)) {
    own ??= ownNames(definitions, el);
    if (own.size === 0) return [];
    const head = name.split('.')[0]!;
    const f = own.get(head);
    if (f === undefined) continue;
    const outer = definitions.scope(el.ownerId, 'all').get(head);
    if (outer !== undefined && outer !== f.id && outer !== definitions.carrier(el.id, f).id) out.push(name);
  }
  return out;
}

/** `el`'s own named features — owned or inherited, the user's own (a library feature is not read). */
function ownNames(definitions: DefiningEquations, el: ElementRecord): ReadonlyMap<string, ElementRecord> {
  const own = new Map<string, ElementRecord>();
  for (const f of definitions.features(el.id)) {
    if (f.attrs.isLibrary === true) continue;
    const n = definitions.nameOf(f);
    if (n === undefined || n === '' || own.has(n)) continue;
    own.set(n, f);
  }
  return own;
}

/** The one sentence every surface gives a body {@link shadowedNamesOf} refuses. */
export function shadowedSentence(model: Model, el: ElementRecord, shadowed: readonly string[]): string {
  const definitions = sharedDefinitions(model);
  const head = shadowed[0]!.split('.')[0]!;
  const f = ownNames(definitions, el).get(head);
  const outer = el.ownerId != null ? definitions.scope(el.ownerId, 'all').get(head) : undefined;
  const who = effectiveNameOf(model, el) ?? effectiveQualifiedName(model, el.id);
  const what =
    f && typeof f.attrs.direction === 'string'
      ? `its own ${f.attrs.direction} parameter`
      : f && f.ownerId !== el.id
        ? 'a feature it inherits'
        : 'a feature of its own';
  return (
    `\`${head}\` in ${who} is ${f ? effectiveQualifiedName(model, f.id) : head}, ${what}; this tool reads a ` +
    `body in its owner's scope, where \`${head}\` is ${outer !== undefined ? effectiveQualifiedName(model, outer) : 'another feature'} ` +
    `— another feature — ${BODY_NOT_READ}`
  );
}

const BODY_NOT_READ = 'so the body is not read';

/** Is this refusal sentence a {@link shadowedSentence}: a body over a name its own element declares, which may state no value? */
export function isShadowedBody(sentence: string): boolean {
  return sentence.endsWith(`— another feature — ${BODY_NOT_READ}`);
}

/**
 * Is `el` a calculation whose features are the values of a CALL — one with a
 * parameter: a calculation that states no value by its body for one
 * ({@link isParameterisedCalculation}), or any with a directed feature, owned
 * or from the `calc def` that types it (`calc g { in y = 100.0; return r = y;
 * }`)? A chain into it (`g.r`) reads a default nothing invokes, and no
 * surface reads it.
 */
export function isCall(model: Model, el: ElementRecord): boolean {
  if (el.eClass !== 'CalculationUsage') return false;
  if (isParameterisedCalculation(model, el)) return true;
  return effectiveFeatures(model, el.id).some((c) => {
    const direction = c.attrs.direction;
    return direction === 'in' || direction === 'out' || direction === 'inout';
  });
}

/** A calculation body that is a value — arithmetic or a name — rather than a relation or a test. */
function isValueBody(body: string): boolean {
  if (body.trim() === '') return false;
  const parsed = parseRelationBody(body);
  if (!parsed || (parsed.hadUnit && !parsed.resolved)) return false;
  const node = parsed.node;
  if (node.kind === 'binary') return ['+', '-', '*', '/', '%', '^'].includes(node.op);
  if (node.kind === 'unary') return node.op !== 'not';
  return node.kind === 'num' || node.kind === 'ref' || node.kind === 'if';
}

/* ─────────────────────── Which equation defines, mid-derivation ─────────────────────── */

/**
 * The derivation stack of one evaluation, in the order it was entered: each
 * feature being derived, and the asserted equation it is being derived through
 * — `undefined` for a feature's own value expression.
 */
export type InFlight = Map<ElementId, ElementId | undefined>;

/**
 * How an answer met the derivation stack: the features in flight it came back
 * to — through a loop, or only by reading an equation back ({@link returnTo})
 * — and whether the depth guard answered somewhere under it. An answer with a
 * contact depends on what else was being derived at the time, so neither
 * evaluator memoises it; one without is a fact about the model, the same
 * whichever check asked first.
 */
export interface Contact {
  loops: ReadonlySet<ElementId>;
  echoes: ReadonlySet<ElementId>;
  guard: boolean;
}

const NONE: ReadonlySet<ElementId> = new Set();

/** The contact of a depth limit answering: the guard at the cap, or the engine's own stack running out. */
export const GUARD_CONTACT: Contact = { loops: NONE, echoes: NONE, guard: true };

/**
 * What reading `id` again while it is in flight is. An ECHO when the reader —
 * the derivation on top of the stack — is another feature derived through the
 * same equation: `e2 == e` read as `e`'s definition (through `e2`) and then as
 * `e2`'s (through `e`) is one equation read back, not a loop the author wrote.
 * Any other return is a LOOP: `a == b * 2.0` beside `b == a / 2.0`, or
 * `x == x + 1`.
 */
export function returnTo(inFlight: InFlight, id: ElementId): Contact {
  const via = inFlight.get(id);
  let reader: [ElementId, ElementId | undefined] | undefined;
  for (const entry of inFlight) reader = entry;
  const echo = via !== undefined && reader !== undefined && reader[0] !== id && reader[1] === via;
  return echo ? { loops: NONE, echoes: new Set([id]), guard: false } : { loops: new Set([id]), echoes: NONE, guard: false };
}

/** Both contacts, as one. */
export function mergeContact(a: Contact | undefined, b: Contact | undefined): Contact | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    loops: a.loops.size === 0 ? b.loops : b.loops.size === 0 ? a.loops : new Set([...a.loops, ...b.loops]),
    echoes: a.echoes.size === 0 ? b.echoes : b.echoes.size === 0 ? a.echoes : new Set([...a.echoes, ...b.echoes]),
    guard: a.guard || b.guard,
  };
}

/** How many of the features in flight are being derived through a defining equation. */
export function definitionsInFlight(inFlight: InFlight): number {
  let n = 0;
  for (const via of inFlight.values()) if (via !== undefined) n++;
  return n;
}

/**
 * How many defining equations one derivation may read through, nested, before
 * it answers `depth` instead — on both paths, the scalar one and the
 * unit-aware one, so past it neither has a value the other lacks. It is a fact
 * about the model, so the answer does not depend on which derivations an
 * earlier check left in the memo. Measured, uncapped: a chain of asserted
 * equations `x_i == x_{i-1} + 1.0` derived to 801 at 800 links and overflowed
 * the stack at 900 (a cold `tsx` process, node 22, default stack); the scalar
 * scope, which catches the overflow, gave a value at 1400 links and nothing at
 * 1200 in one warm process. The drone-swarm v9 model's equations nest two deep
 * at most. The cap is far from both. A candidate past it ends the search for a
 * definition ({@link chooseDefinition}).
 */
export const MAX_DERIVATION_DEPTH = 64;

/** What one candidate's derivation came to, as {@link chooseDefinition} reads it. */
export interface CandidateOutcome {
  /** True when it gave the feature a value. */
  answered: boolean;
  /** True when it has none because its definitions nest past {@link MAX_DERIVATION_DEPTH}. */
  deep: boolean;
  /** Everything it met of the derivation stack: the answer depends on all of it. */
  contact?: Contact;
  /**
   * What its LACK of a value met: the contact of the inputs that had none.
   * An input that had a value, through a candidate of its own passed over for
   * coming back, is no part of why this one has none.
   */
  cause?: Contact;
}

/**
 * THE choice among the equations that may define `featureId` (in the order
 * of {@link definingEquationsFor}), for both evaluators: the first whose
 * derivation gives the feature a value — tried with `featureId` in flight,
 * through the candidate, while `derive` runs. One that gives none is passed
 * over for the next: an equation that would read the feature back into its own
 * derivation, and one with an input nothing fixes, alike.
 *
 * Stopping at the first that FAILED for a reason of its own made the value
 * turn on declaration order once more: `b == c + 0.0` (with `c` unfixed)
 * written above `b == x0 * 2.0` left `b` with no value, and swapped b = 2. So
 * did the reach of a failure: a candidate whose input `d` had a value only by
 * passing over an equation that read the feature back was itself "a loop",
 * and skipped — so swapping `d`'s two equations, neither of them the
 * feature's, decided whether `a == d + b` (with `b` unfixed) or `d == a`
 * defined `a`. Every candidate that answers now answers the same in a model
 * whose equations agree, so which one comes first decides nothing there; in
 * one at odds with itself, the first in the order above decides — for no row
 * a surface judges where two asserted equations give a feature with no value
 * values that differ, or that this tool cannot compare ({@link
 * contradictedDefinitions}).
 *
 * One failure does end the search: a candidate whose definitions nest past
 * {@link MAX_DERIVATION_DEPTH} is the answer, refused for it. The cap is met
 * at a count of definitions in flight, so whether a candidate meets it turns
 * on how deep the derivation already is, and on which links an earlier check
 * left in the memo (they are read whole there, not re-derived to the cap):
 * passing it over made the next candidate's value the answer in one order of
 * checks and not in the other. And every link of a chain past the cap would
 * re-derive the link below once for each of its own candidates — a 150-link
 * chain whose links each read the one below through two definitions, and the
 * one above through a third, did not finish in five minutes.
 *
 * When none gives a value, the first that failed for a reason of its own —
 * its `cause` comes back to no feature in flight — is the answer, and its
 * reason is; when every one came back, the first that LOOPED is, and its own
 * derivation names the loop; when all of them only read an equation back, the
 * name has no definition here (`chosen` absent). `contact` is what every
 * candidate tried met, and `cause` — when none answered — what their failures
 * met: the answer depends on them.
 */
export function chooseDefinition<T>(
  inFlight: InFlight,
  featureId: ElementId,
  candidates: readonly DefiningEquation[],
  derive: (c: DefiningEquation) => T,
  outcome: (t: T) => CandidateOutcome,
): { chosen?: T; contact?: Contact; cause?: Contact } {
  let contact: Contact | undefined;
  let cause: Contact | undefined;
  let own: T | undefined;
  let looped: T | undefined;
  try {
    for (const c of candidates) {
      inFlight.set(featureId, c.constraint.id);
      const t = derive(c);
      const o = outcome(t);
      contact = mergeContact(contact, o.contact);
      if (o.answered) return { chosen: t, ...(contact ? { contact } : {}) };
      cause = mergeContact(cause, o.cause);
      if (o.deep) return { chosen: t, ...(contact ? { contact } : {}), ...(cause ? { cause } : {}) };
      const back = o.cause ? cameBack(o.cause, inFlight) : undefined;
      if (back === undefined) own ??= t;
      else if (back === 'loop') looped ??= t;
    }
  } finally {
    inFlight.delete(featureId);
  }
  const chosen = own ?? looped;
  return { ...(chosen !== undefined ? { chosen } : {}), ...(contact ? { contact } : {}), ...(cause ? { cause } : {}) };
}

/** Whether `contact` comes back to a feature still in flight: through a loop, else only by an echo. */
function cameBack(contact: Contact, inFlight: InFlight): 'loop' | 'echo' | undefined {
  for (const id of contact.loops) if (inFlight.has(id)) return 'loop';
  for (const id of contact.echoes) if (inFlight.has(id)) return 'echo';
  return undefined;
}

/**
 * The key of a feature's value read IN a context that is not where it is
 * written ({@link DefiningEquations.readAt}) — its memo key and its key on a
 * derivation stack, apart from the value it has where it is written.
 */
export function instanceKey(featureId: ElementId, contextId: ElementId): string {
  return `${featureId}@${contextId}`;
}

/** The feature an {@link instanceKey} (or a plain feature id) is of. */
export function baseIdOf(key: string): ElementId {
  const at = key.indexOf('@');
  return at < 0 ? key : key.slice(0, at);
}

/** The memo key of the derivation an equation in `contextId` gives a feature — never a bare element id. */
export function definitionKey(featureId: ElementId, contextId: ElementId): string {
  return `${featureId} defined in ${contextId}`;
}
