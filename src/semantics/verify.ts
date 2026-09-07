/**
 * Verification cases get a computed verdict — behind a gate on the METHOD.
 *
 * THE CHARTER OF THIS MODULE, IN ONE LINE: **a verdict is never claimed for a
 * method this tool did not perform, and an unjudged case is never mistaken for
 * a refutation.** Everything below follows from that sentence.
 *
 *  - **`analyze` is the only method this tool performs.** `VerificationMethod`
 *    carries `kind : VerificationMethodKind [1..*]` (library
 *    `VerificationCases.sysml`), so a case may legitimately say
 *    `kind = (analyze, test)`. A case whose list CONTAINS `analyze`, or which
 *    states no method at all, is judged on the analyze part and reports every
 *    other kind as not performed. A case with no `analyze` in its list is **not
 *    judged**: `verification/method-not-performed`, inconclusive, exit 2 — never
 *    exit 1, because an unjudged case is not a refutation. `--allow-inconclusive`
 *    does not reach it: §2 scopes that flag to `verification/timeout` and
 *    `verification/unsupported-construct`, and an unperformed method is neither.
 *  - **A kind this tool cannot read is not `analyze`.** An unrecognised spelling
 *    fails towards "not performed", never towards a verdict, and is named on the
 *    row so a reader can see which word was not understood.
 *  - **Two verdict words, deliberately, and they are not the same question.**
 *    {@link VerificationCaseVerdict.verdict} is the library's `PassIf` reading
 *    over the ENGINE THAT WAS ASKED FOR — under `--engine literal` a case whose
 *    obligations all hold at the model's values passes, exactly as the run does.
 *    {@link VerificationCaseVerdict.facet} is what may be WRITTEN INTO THE FILE,
 *    and it is `pass` only when every obligation was `proved`. The two coincide
 *    under `--engine smt` and diverge under `--engine literal`, which is the
 *    whole point: a point evaluation is a green run and is not a proof, and a
 *    facet that said `pass` over one would be the laundering §3.4 forbids.
 *  - **Nothing here judges anything.** The obligations arrive already judged
 *    ({@link VerificationCaseOptions.judged}); this module decides which of them
 *    a case stands on, whether the case's method allows a verdict at all, and
 *    what the resulting word is. Keeping the engines out of this file is what
 *    lets one run's rows answer for every case in it, and is why a case verdict
 *    can never disagree with the obligation rows printed under it.
 *
 * **BOTH SPELLINGS OF "THIS CASE VERIFIES THAT REQUIREMENT" ARE READ, and they
 * land differently in the model.** `verify R by V;` builds a `Verify`
 * relationship with the case as its SOURCE and the requirement as its target.
 * `objective { verify R; }` builds a `Verify` whose source is EMPTY — the case
 * is its owner, not its endpoint (`map-to-model.ts`, `isBareVerifyReference`).
 * So a traceability matrix, which walks source→target pairs, sees the first form
 * and cannot see the second: measured on `examples/uav-isr-verification.sysml`,
 * `traceabilityMatrix(model, 'VerificationCaseUsage', 'RequirementDefinition',
 * 'Verify')` reports ONE link where the file states three. That is not a defect
 * in the matrix — a matrix reports edges and the objective form declares none —
 * it is the reason this module walks containment as well, and the reason the
 * suite cross-checks the two rather than trusting either alone.
 *
 * A third shape is invisible to BOTH walks over `Verify` and is read off
 * containment: `objective { verify X; }` is turned into a `Verify` only while
 * `X` resolves to a requirement (`map-to-model.ts`, `isBareVerifyReference`),
 * and otherwise stays a `ConstraintUsage` with `requirementRole = 'verify'`.
 * Reporting such a case as naming no requirement would be a true sentence about
 * the graph and a false one about the file, so it is listed as dangling
 *
 * Pure and deterministic apart from {@link writeVerdict}, which is the one
 * function here that mutates a model and says so in its name.
 */

import { type ElementId, type ElementRecord, type Model } from '@core/index';
import { isUserModelElement, type ContractRef } from './contracts';
import { generalizationsOf } from './inheritance';
import {
  VERIFICATION_METHOD_VALUES,
  getRequirementAttr,
  setRequirementAttr,
  type VerdictKind,
} from './requirements';

/* ────────────────────────────── the vocabulary ───────────────────────────── */

/** The two metaclasses a verification case is written as. */
const VERIFICATION_CASE_KINDS = new Set(['VerificationCaseDefinition', 'VerificationCaseUsage']);

/** The metaclasses a requirement is written as — the only thing a case may verify. */
const REQUIREMENT_KINDS = new Set(['RequirementDefinition', 'RequirementUsage']);

/**
 * The one method this tool performs.
 *
 * Spelled once, here, because three places branch on it: the gate that decides
 * whether a case is judged at all, the sentence that says which kinds were not
 * performed, and {@link writeVerdict}'s method annotation.
 */
export const PERFORMED_METHOD = 'analyze';

/**
 * The last segment of the library metadata definition a method is declared with.
 *
 * Matched on the SEGMENT rather than on the whole name because a file may write
 * `@VerificationCases::VerificationMethod`, `@VerificationMethod` after an
 * import, or an alias of its own — and metadata is unbound in this tool, so
 * `attrs.type` is the source lexeme rather than a resolved element. Reading only
 * the fully qualified spelling would silently ignore the two idiomatic ones and
 * report every such case as declaring no method at all, which is the arm that
 * JUDGES. Failing towards "no method declared" is the wrong direction for a gate.
 */
export const VERIFICATION_METHOD_DEF = 'VerificationMethod';

/** The attribute inside that metadata usage which carries the kinds. */
const METHOD_KIND_ATTR = 'kind';

/** A case that names no property to check is not a case that passed. */
export const NO_PROPERTY_CODE = 'verification/no-property';

/** A method this tool did not perform, so there is no verdict to give. */
export const METHOD_NOT_PERFORMED_CODE = 'verification/method-not-performed';

/** The file already says something else about this requirement. */
export const VERDICT_CHANGED_CODE = 'verification/verdict-changed';

/**
 * Every `verification/*` code this module can put in front of a reader.
 *
 * Exported so `src/api/verification.ts` can fold it into the lane's single code
 * set, which the catalogue guard reads: a code a reader is shown is a code
 * `docs/DIAGNOSTIC-CODES.md` must explain, whichever module raises it.
 */
export const VERIFICATION_CASE_CODES: readonly string[] = [
  NO_PROPERTY_CODE,
  METHOD_NOT_PERFORMED_CODE,
  VERDICT_CHANGED_CODE,
];

/* ──────────────────────────────── the inputs ─────────────────────────────── */

/**
 * One already-judged obligation, in the shape this module needs of it.
 *
 * STRUCTURAL ON PURPOSE. `ObligationVerdict` (`src/api/verification.ts`) is
 * assignable to it, so the caller hands its own rows straight through — but the
 * type is declared HERE, so `src/semantics` does not import `src/api` and the
 * layering stays one-way. What is left out is as deliberate as what is in: this
 * module never reads a witness, a bound or a premise, because it never re-argues
 * a verdict the engines already reached.
 */
export interface JudgedObligation {
  /** The requirement the clause belongs to, or `null` for a model-level relation. */
  requirement: { id: ElementId; qualifiedName: string } | null;
  /** The `<R-UAV-001>` short name of that requirement, or `''`. */
  shortId: string;
  /** The clause this row IS. */
  clause: { id: ElementId; qualifiedName: string };
  /** The relation as written. */
  expression: string;
  /** The engine's own word: `proved`, `holds-at-values`, `refuted`, … */
  claim: string;
  /** Did it count as discharged UNDER THE ENGINE THAT WAS ASKED FOR? */
  discharged: boolean;
  /** The `verification/*` code, for any row that is not decided. */
  code: string | null;
  /** The sentence the row printed. */
  detail: string;
}

/** How a case run is narrowed, and what it is judged from. */
export interface VerificationCaseOptions {
  /**
   * The judged obligations of the SAME model — what the run already decided.
   *
   * Required rather than optional: a case report computed from no rows would
   * report every case as `verification/no-property`, which is a sentence about
   * the model and would here be a sentence about the caller.
   */
  judged: readonly JudgedObligation[];
  /** Restrict to one case, by element id. */
  caseId?: ElementId;
  /**
   * Did the engine that was asked for fail to run at all?
   *
   * A case over rows that are every one of them `verification/tool-absent` is
   * inconclusive for that reason, and saying so on the case row saves a reader
   * from reading "not discharged" as "does not hold".
   */
  toolAbsent?: boolean;
}

/* ─────────────────────────────── the outputs ─────────────────────────────── */

/** One requirement a case verifies, and which spelling declared it. */
export interface VerifiedRequirement {
  requirement: ContractRef;
  /**
   * `relationship` is `verify R by V;`, `objective` is `objective { verify R; }`.
   *
   * Published because a consumer cross-checking this report against a
   * traceability matrix has to know which rows the matrix could have seen: only
   * the first form declares an edge with both endpoints.
   */
  via: 'relationship' | 'objective';
  /** The `Verify` element itself, so a reader can find the line. */
  edge: ContractRef;
}

/**
 * One verified requirement's OWN roll-up — the facet ITS rows reach.
 *
 * WHY THIS IS PER REQUIREMENT AND NOT PER CASE. A case verdict is a roll-up
 * over every requirement the case verifies; a `verdict` facet is a statement
 * ABOUT ONE REQUIREMENT. Writing the case's word onto each of them makes the
 * file contradict itself the moment two of them disagree — a case that is
 * `fail` because one requirement was refuted would stamp `fail` onto the one
 * beside it that this same run proved, next to an `@Evidence` carrier saying
 * `holds-at-values`. So each requirement is rolled up from its own rows, and a
 * requirement this run produced NO row for gets `facet: null` and is written
 * nothing at all: a facet there would state a verdict nothing checked.
 */
export interface RequirementFacet {
  requirementId: ElementId;
  requirement: string;
  /** `null` when this run produced no obligation row for the requirement. */
  facet: 'pass' | 'fail' | 'inconclusive' | null;
  /** How many of the case's judged rows belong to this requirement. */
  rows: number;
}

/** What a `Verify` element pointed at that was not a requirement this tool could use. */
export interface DanglingVerification {
  edge: ContractRef;
  via: 'relationship' | 'objective';
  /** The name as written, when the reference resolved to nothing. */
  named: string;
  reason: string;
}

/** What the method annotation on a case says, read rather than judged. */
export interface MethodReading {
  /** Every kind the case declares, in the order written, exactly as spelled. */
  declared: string[];
  /** The kinds this tool performed. At most `['analyze']`. */
  performed: string[];
  /** The kinds it did not perform — every declared kind that is not `analyze`. */
  notPerformed: string[];
  /** Declared spellings that name no `VerificationMethodKind` this tool knows. */
  unrecognised: string[];
  /** Did the case declare a method at all? A case that declares none is judged. */
  declaresMethod: boolean;
}

/** One case, its method gate, and the verdict that follows. */
export interface VerificationCaseVerdict {
  case: ContractRef;
  /** The case's own short name, or `''`. */
  shortId: string;
  method: MethodReading;
  /**
   * Was the case JUDGED at all?
   *
   * `false` only for a method gate. It is a different fact from an inconclusive
   * verdict — one says the tool did not look, the other says it looked and could
   * not tell — and a reader who cannot tell them apart cannot act on either.
   */
  judged: boolean;
  /**
   * The library `PassIf` reading, over the engine that was asked for.
   *
   * `pass` iff every verified obligation was discharged by that engine and none
   * was vacuous; `fail` iff one was refuted at the model's values; `error` when
   * the engine could not run at all; `inconclusive` otherwise. This is the word
   * the exit code is computed from.
   */
  verdict: VerdictKind;
  /**
   * The word that may be WRITTEN INTO THE FILE, which is a stricter question.
   *
   * `pass` only when every obligation's claim is `proved`, `fail` only when one
   * is `refuted`, `inconclusive` for everything else — the same rule
   * `verdictFor` applies to a single claim, applied to a case. Under
   * `--engine literal` a case may legitimately be `verdict: 'pass'` and
   * `facet: 'inconclusive'`: the run is green because a point evaluation was
   * asked for by name, and the file may not say `pass` about it.
   */
  facet: 'pass' | 'fail' | 'inconclusive';
  /** The case-level `verification/*` code, or `null` when the case was decided. */
  code: string | null;
  detail: string;
  verifies: VerifiedRequirement[];
  /**
   * The per-requirement roll-up {@link writeVerdict} writes from.
   *
   * One entry per verified requirement, in the order they were found, whether
   * or not this run produced a row for it — a reader has to be able to see
   * which of a case's requirements the verdict actually stands on.
   */
  facets: RequirementFacet[];
  /** `verify` targets that named nothing this tool could verify. */
  dangling: DanglingVerification[];
  /** The judged rows the verdict was computed from, in the order they were judged. */
  obligations: JudgedObligation[];
  /**
   * Requirements whose `verdict` facet already says something else.
   *
   * READ, NEVER BELIEVED, and never repaired here: this module reports the
   * disagreement and {@link writeVerdict} is the only thing that resolves it.
   */
  changed: VerdictDisagreement[];
}

/** A `verdict` facet in the file that disagrees with what this run computed. */
export interface VerdictDisagreement {
  requirement: string;
  /** What the file says. */
  claimed: string;
  /** What this run computed, under the rule that governs the facet. */
  computed: 'pass' | 'fail' | 'inconclusive';
  /** `pass` in the file over a run that refuted it — the laundering direction. */
  overstates: boolean;
}

/** What a whole run of the cases came to. */
export interface VerificationCaseReport {
  cases: VerificationCaseVerdict[];
  passed: number;
  failed: number;
  inconclusive: number;
  /** Cases the method gate refused to judge. Always inconclusive, always exit 2. */
  notPerformed: number;
  /**
   * The contribution these cases make to the run's exit code.
   *
   * `1` for a case the model refutes, `2` for a case this tool would not or
   * could not judge, `0` when every case passed — **and `0` when there is no
   * case at all**, because a model that declares none has said nothing about
   * verification cases and the obligations decide the run on their own.
   */
  exitCode: 0 | 1 | 2;
  /** Was the report narrowed to one case? */
  caseId?: ElementId;
  /**
   * The same narrowing, as the name a person typed and a consumer can use.
   *
   * `caseId` is a per-load UUID (D3 — ids are fresh on every load), so a JSON
   * consumer cannot key on it, join it to anything, or replay it. The qualified
   * name is what `flags.case` publishes in a record for exactly that reason,
   * and the two must agree.
   */
  case?: string;
}

/* ─────────────────────────────── reading the model ───────────────────────── */

function ref(model: Model, el: ElementRecord): ContractRef {
  return {
    id: el.id,
    eClass: el.eClass,
    ...(el.declaredName !== undefined ? { declaredName: el.declaredName } : {}),
    qualifiedName: model.qualifiedName(el.id),
  };
}

/**
 * The case and every definition it specializes that the READER wrote.
 *
 * Library generals are dropped rather than walked. A method or an objective in
 * the bundled standard library is not the reader's statement about their model
 * — and `VerificationCase` itself is a general of every case in every file, so
 * walking it would put the same library subtree under every case in the report
 * and pay for it once per case.
 */
function caseChain(model: Model, caseEl: ElementRecord): ElementRecord[] {
  return [
    caseEl,
    ...generalizationsOf(model, caseEl.id).filter((g) => isUserModelElement(model, g)),
  ];
}

/** Every verification case the READER wrote — never the bundled library's. */
export function verificationCasesOf(model: Model): ElementRecord[] {
  return model
    .all()
    .filter((el) => VERIFICATION_CASE_KINDS.has(el.eClass) && isUserModelElement(model, el));
}

/**
 * Every name the definition of a metadata usage could have been written under.
 *
 * FOUR SLOTS, BECAUSE THE MAPPER USES FOUR, and reading fewer than all of them
 * is how a gate fails open. Measured on parse-clean files:
 * `@VerificationCases::VerificationMethod { … }` lands the source lexeme in
 * `attrs.type`; `metadata VerificationMethod { … }` lands it in
 * `declaredName`, because a bare `metadata` declaration is stored as a NAME
 * (the same fact `getRequirementMetadata` reads, `src/semantics/requirements.ts`);
 * `metadata vm : VerificationMethod { … }` and its fully-qualified twin land it
 * on a `FeatureTyping` CHILD whose target resolves into the library, leaving the
 * usage's own `attrs` empty; and `attrs.typeRef` is the fourth spelling the
 * mapper can produce. Each is reduced to its last `::` segment, because metadata
 * is unbound in this tool and a file may import, qualify or alias the definition.
 */
function metadataTypeNames(model: Model, el: ElementRecord): string[] {
  const out: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v !== 'string' || v === '') return;
    out.push(v.split('::').pop() ?? v);
  };
  push(el.attrs.type);
  push(el.attrs.typeRef);
  // A NAMED metadata usage's `declaredName` is the instance name in
  // `metadata vm : X`, and the DEFINITION name in the bare `metadata X` form;
  // both are read, because a name that happens to match is harmless and a
  // definition name that is missed opens the gate.
  if (el.attrs.annotation !== true) push(el.declaredName);
  for (const ch of model.children(el.id)) {
    if (ch.eClass !== 'FeatureTyping') continue;
    push(ch.attrs.typeRef);
    push(ch.attrs.general);
    for (const t of ch.target ?? []) push(model.qualifiedName(t));
  }
  return out;
}

/** The `kind` cells of one metadata usage, in both spellings the notation has. */
function kindCells(model: Model, carrier: ElementRecord): ElementRecord[] {
  return model.children(carrier.id).filter((cell) => {
    if (cell.declaredName === METHOD_KIND_ATTR) return true;
    const redefines = cell.attrs.redefines;
    // `attribute :>> kind = test;` — the redefinition spelling, which carries no
    // declared name at all and whose value would otherwise be invisible.
    return Array.isArray(redefines) && redefines.some((r) => String(r).split('::').pop() === METHOD_KIND_ATTR);
  });
}

/** Every `VerificationMethodKind` term one cell's value spells out. */
function kindTerms(cell: ElementRecord): string[] {
  const raw = cell.attrs.value;
  if (typeof raw !== 'string') return [];
  return raw
    .replace(/^\s*\(|\)\s*$/g, '')
    .split(',')
    .map((term) => (term.split('::').pop() ?? term).trim())
    .filter((word) => word !== '');
}

/**
 * The method kinds a case declares, read off its `VerificationMethod` metadata.
 *
 * WHAT IS PARSED AND WHY BY HAND. Metadata is unbound in this tool, so the
 * `kind` attribute's value arrives as the SOURCE LEXEME of whatever expression
 * the author wrote: `analyze`, `VerificationCases::VerificationMethodKind::test`,
 * or `(analyze, test)` for the `[1..*]` multiplicity the library declares. There
 * is no resolved enumeration reference to read, so the last `::` segment of each
 * comma-separated term is taken and matched against the library's four literals.
 *
 * A term that matches none of them is `unrecognised` — reported, and NOT
 * silently treated as `analyze`. That is the fail direction the whole gate is
 * about: a misspelt `analyse` must leave the case unjudged rather than judged.
 *
 * TWO WAYS A CARRIER IS RECOGNISED, and the second one exists because the first
 * cannot be complete. A metadata usage whose definition is written as
 * `VerificationMethod` under any of the four spellings
 * ({@link metadataTypeNames}) is a method declaration. So is ANY metadata usage
 * on the case that owns a `kind` cell naming a `VerificationMethodKind` — which
 * catches the alias (`alias VM for …VerificationMethod; @VM { kind = test; }`)
 * and the misspelt definition name, neither of which this tool can resolve,
 * because metadata is unbound. A metadata usage that is neither is ignored: a
 * case may legitimately carry `@Rationale`, `#risk` or any other annotation, and
 * a gate that shut on every unread annotation would refuse to judge models that
 * say nothing about a method at all.
 *
 * INHERITED METHODS ARE READ. `verification def BenchTest { @VerificationMethod
 * { kind = test; } }` with `verification b : BenchTest;` is the standard
 * factoring, and a usage read off its own children alone declares nothing and is
 * JUDGED — the fail-open direction. The generalization chain
 * ({@link generalizationsOf}) is walked for the same reason prerequisite D4 made
 * `requirement-subject` resolve through it, and the kinds of every carrier
 * reachable that way are merged: a case is not judged if ANY definition it
 * specializes says the method is something this tool does not perform.
 */
export function methodOf(model: Model, caseEl: ElementRecord): MethodReading {
  const declared: string[] = [];
  const unrecognised: string[] = [];
  const carriers = caseChain(model, caseEl);
  for (const owner of carriers) {
    for (const child of model.children(owner.id)) {
      if (child.eClass !== 'MetadataUsage') continue;
      const cells = kindCells(model, child);
      const named = metadataTypeNames(model, child).includes(VERIFICATION_METHOD_DEF);
      const speaksKinds = cells.some((cell) =>
        kindTerms(cell).some((w) => (VERIFICATION_METHOD_VALUES as readonly string[]).includes(w)),
      );
      if (!named && !speaksKinds) continue;
      for (const cell of cells) {
        for (const word of kindTerms(cell)) {
          if ((VERIFICATION_METHOD_VALUES as readonly string[]).includes(word)) declared.push(word);
          else unrecognised.push(word);
        }
      }
    }
  }
  const performed = declared.filter((k) => k === PERFORMED_METHOD);
  return {
    declared,
    performed: performed.length > 0 ? [PERFORMED_METHOD] : [],
    notPerformed: declared.filter((k) => k !== PERFORMED_METHOD),
    unrecognised,
    declaresMethod: declared.length > 0 || unrecognised.length > 0,
  };
}

/**
 * Everything one case says it verifies, through BOTH spellings.
 *
 * The `verify R by V;` form declares an edge — the case is the `Verify`
 * element's source — and the `objective { verify R; }` form declares none: the
 * case OWNS the `Verify`, whose source array is empty. Walking only the edges
 * would miss every objective-form case in a file; walking only containment
 * would miss every case whose verification is stated at package level. Both are
 * walked, and each row says which one it came from.
 */
export function verifiedRequirementsOf(
  model: Model,
  caseEl: ElementRecord,
): { verifies: VerifiedRequirement[]; dangling: DanglingVerification[] } {
  const verifies: VerifiedRequirement[] = [];
  const dangling: DanglingVerification[] = [];
  const seen = new Set<ElementId>();

  // THE CASE, AND EVERY DEFINITION IT SPECIALIZES. `verification def Check {
  // objective { verify R; } }` with `verification c : Check;` is the standard
  // factoring, and a usage read off its own containment alone verifies nothing
  // — which reports `verification/no-property` over a file that plainly states
  // a `verify`. The generalization chain is walked for the same reason
  // {@link methodOf} walks it, and for the reason prerequisite D4 made
  // `requirement-subject` resolve through it.
  const sources = caseChain(model, caseEl).map((g) => g.id);
  const owned = new Set<ElementId>(sources);
  for (const s of sources) for (const d of model.descendants(s)) owned.add(d.id);

  for (const el of model.all()) {
    if (el.eClass !== 'Verify') continue;
    const bySource = (el.source ?? []).some((s) => sources.includes(s));
    const byOwner = el.ownerId != null && owned.has(el.ownerId);
    if (!bySource && !byOwner) continue;
    const via: 'relationship' | 'objective' = bySource ? 'relationship' : 'objective';
    const targetId = (el.target ?? [])[0];
    const target = targetId !== undefined ? model.get(targetId) : undefined;
    if (!target) {
      const named = typeof el.attrs.targetRef === 'string' ? el.attrs.targetRef : '';
      dangling.push({
        edge: ref(model, el),
        via,
        named,
        reason:
          named === ''
            ? 'the `verify` statement names no requirement at all'
            : `\`${named}\` names nothing in this model — the requirement it points at is missing or misspelt`,
      });
      continue;
    }
    if (!REQUIREMENT_KINDS.has(target.eClass)) {
      dangling.push({
        edge: ref(model, el),
        via,
        named: model.qualifiedName(target.id),
        reason: `${model.qualifiedName(target.id)} is a ${target.eClass}, and only a requirement carries a property to check`,
      });
      continue;
    }
    if (seen.has(target.id)) continue;
    seen.add(target.id);
    verifies.push({ requirement: ref(model, target), via, edge: ref(model, el) });
  }

  // THE OBJECTIVE-FORM VERIFY THAT NEVER BECAME AN EDGE. `objective { verify
  // R; }` is read as a REFERENCE only while `R` resolves to a requirement
  // (`map-to-model.ts`, `isBareVerifyReference` and `mayBindVerifyTarget`);
  // where it does not, the mapper keeps the CLAUSE reading and the model holds
  // a `ConstraintUsage` with `requirementRole = 'verify'` and no `Verify`
  // element anywhere. Walking the edges alone therefore cannot see it, and the
  // case would report "names no requirement at all" over a file that plainly
  // states one — a true sentence about the graph and a false one about the
  // source. It is listed as dangling instead, with the name as written.
  for (const el of owned) {
    const node = model.get(el);
    if (!node || node.eClass !== 'ConstraintUsage') continue;
    if (node.attrs.requirementRole !== 'verify') continue;
    const named = node.declaredName ?? '';
    dangling.push({
      edge: ref(model, node),
      via: 'objective',
      named,
      reason:
        named === ''
          ? 'an `objective { verify … }` names nothing this tool could resolve'
          : `\`${named}\` is not a requirement in this model — only a requirement carries a property to check, so no verification relationship was built for it`,
    });
  }
  return { verifies, dangling };
}

/* ────────────────────────────── the verdict rules ────────────────────────── */

/** The facet rule, applied to a set of claims rather than to one. */
function facetOf(rows: readonly JudgedObligation[]): 'pass' | 'fail' | 'inconclusive' {
  if (rows.length === 0) return 'inconclusive';
  if (rows.some((r) => r.claim === 'refuted')) return 'fail';
  return rows.every((r) => r.claim === 'proved') ? 'pass' : 'inconclusive';
}

/** The `PassIf` rule, over the engine that was asked for. */
function verdictOfRows(rows: readonly JudgedObligation[], toolAbsent: boolean): VerdictKind {
  if (toolAbsent) return 'error';
  if (rows.some((r) => r.claim === 'refuted')) return 'fail';
  if (rows.some((r) => r.claim === 'vacuous')) return 'inconclusive';
  return rows.every((r) => r.discharged) ? 'pass' : 'inconclusive';
}

/** The sentence a judged case prints, which has to name what the verdict stands on. */
function judgedDetail(
  verdict: VerdictKind,
  rows: readonly JudgedObligation[],
  method: MethodReading,
): string {
  const n = rows.length;
  const head =
    verdict === 'pass'
      ? `pass: ${n} obligation(s) discharged by the engine that was asked for, none vacuous`
      : verdict === 'fail'
        ? `fail: ${rows.filter((r) => r.claim === 'refuted').length} of ${n} obligation(s) refuted with every feature at its model value`
        : verdict === 'error'
          ? `error: the engine that was asked for did not run, so none of the ${n} obligation(s) was decided`
          : `inconclusive: ${rows.filter((r) => !r.discharged).length} of ${n} obligation(s) undecided`;
  const rest =
    method.notPerformed.length > 0
      ? ` — judged on the analyze part only; ${method.notPerformed.join(', ')} not performed by this tool`
      : '';
  const unread =
    method.unrecognised.length > 0
      ? `; ${method.unrecognised.join(', ')} names no VerificationMethodKind this tool knows`
      : '';
  return `${head}${rest}${unread}`;
}

/**
 * Judge every verification case in the model, or the one that was asked for.
 *
 * The obligations arrive judged; what happens here is the gate and the roll-up.
 * Read the module header for why those two are one function and why neither of
 * them touches an engine.
 */
export function runVerificationCases(
  model: Model,
  opts: VerificationCaseOptions,
): VerificationCaseReport {
  const toolAbsent = opts.toolAbsent === true;
  const byRequirement = new Map<ElementId, JudgedObligation[]>();
  for (const row of opts.judged) {
    if (row.requirement === null) continue;
    const list = byRequirement.get(row.requirement.id);
    if (list) list.push(row);
    else byRequirement.set(row.requirement.id, [row]);
  }

  const cases: VerificationCaseVerdict[] = [];
  for (const caseEl of verificationCasesOf(model)) {
    if (opts.caseId !== undefined && caseEl.id !== opts.caseId) continue;
    const method = methodOf(model, caseEl);
    const { verifies, dangling } = verifiedRequirementsOf(model, caseEl);
    // THE CASE'S OWN OBLIGATIONS, WHICH BELONG TO NO REQUIREMENT. A case may
    // state its property directly — `objective { require constraint { … } }` —
    // and `contractsOf` reads the CASE as the contract, so the obligation row
    // it produces is filed under the case rather than under a requirement.
    // Ignoring those rows made the report say "it names no requirement at all"
    // two lines under the case's own obligation, which is two rows about one
    // element contradicting each other. The definitions the case specializes
    // are read for the same reason {@link methodOf} reads them: a usage of a
    // `verification def` that owns the objective states the property through it.
    const caseIds = caseChain(model, caseEl).map((g) => g.id);
    const ownRows = caseIds.flatMap((id) => byRequirement.get(id) ?? []);
    const verifiedRows = verifies.flatMap((v) => byRequirement.get(v.requirement.id) ?? []);
    const rows = [...ownRows, ...verifiedRows];

    // THE GATE COMES FIRST, before anything about the obligations is read. A
    // case whose method this tool does not perform has no verdict at all, and
    // computing one and then discarding it is how the discarded one eventually
    // reaches a report.
    if (method.declaresMethod && method.performed.length === 0) {
      const kinds = [...method.declared, ...method.unrecognised];
      cases.push({
        case: ref(model, caseEl),
        shortId: caseEl.declaredShortName ?? '',
        method,
        judged: false,
        verdict: 'inconclusive',
        facet: 'inconclusive',
        code: METHOD_NOT_PERFORMED_CODE,
        detail:
          `inconclusive: method is ${kinds.join(', ')} — this tool performs analysis only. ` +
          'No verdict is given for a method it did not perform, and this is exit 2 with and ' +
          'without `--allow-inconclusive`: an unjudged case is not a refutation.',
        verifies,
        facets: verifies.map((v) => ({
          requirementId: v.requirement.id,
          requirement: v.requirement.qualifiedName,
          facet: null,
          rows: 0,
        })),
        dangling,
        obligations: [],
        changed: [],
      });
      continue;
    }

    // A case that names no property is not a case that passed. Both shapes of
    // that reach here: a case verifying nothing at all, and one verifying a
    // requirement that carries prose and no constraint body.
    if (rows.length === 0) {
      const why =
        verifies.length === 0
          ? dangling.length > 0
            ? `the ${dangling.length} \`verify\` statement(s) on it name nothing this tool can check: ${dangling
                .map((d) => d.reason)
                .join('; ')}`
            : 'it names no requirement at all — neither `verify R by <case>;` nor `objective { verify R; }`'
          : `the requirement(s) it verifies (${verifies
              .map((v) => v.requirement.qualifiedName)
              .join(', ')}) state no formal clause this lane could gather`;
      cases.push({
        case: ref(model, caseEl),
        shortId: caseEl.declaredShortName ?? '',
        method,
        judged: true,
        verdict: 'inconclusive',
        facet: 'inconclusive',
        code: NO_PROPERTY_CODE,
        detail: `inconclusive: no property to check — ${why}`,
        verifies,
        facets: verifies.map((v) => ({
          requirementId: v.requirement.id,
          requirement: v.requirement.qualifiedName,
          facet: null,
          rows: 0,
        })),
        dangling,
        obligations: [],
        changed: [],
      });
      continue;
    }

    const verdict = verdictOfRows(rows, toolAbsent);
    const facet = toolAbsent ? 'inconclusive' : facetOf(rows);
    // THE ROLL-UP IS PER REQUIREMENT. See {@link RequirementFacet} for why: the
    // case's word is a summary over a set, and a `verdict` facet is a sentence
    // about one member of it. A requirement with no row of its own gets `null`
    // — this run said nothing about it — and the disagreement below is measured
    // against ITS facet rather than against the case's.
    const facets: RequirementFacet[] = verifies.map((v) => {
      const own = byRequirement.get(v.requirement.id) ?? [];
      return {
        requirementId: v.requirement.id,
        requirement: v.requirement.qualifiedName,
        facet: own.length === 0 ? null : toolAbsent ? 'inconclusive' : facetOf(own),
        rows: own.length,
      };
    });
    const changed: VerdictDisagreement[] = [];
    for (const f of facets) {
      if (f.facet === null) continue;
      const claimed = getRequirementAttr(model, f.requirementId, 'verdict');
      if (claimed === undefined || claimed === f.facet) continue;
      changed.push({
        requirement: f.requirement,
        claimed,
        computed: f.facet,
        overstates: claimed === 'pass' && f.facet !== 'pass',
      });
    }
    cases.push({
      case: ref(model, caseEl),
      shortId: caseEl.declaredShortName ?? '',
      method,
      judged: true,
      verdict,
      facet,
      code: null,
      detail: judgedDetail(verdict, rows, method),
      verifies,
      facets,
      dangling,
      obligations: rows,
      changed,
    });
  }

  const failed = cases.filter((c) => c.verdict === 'fail').length;
  const passed = cases.filter((c) => c.verdict === 'pass').length;
  const notPerformed = cases.filter((c) => !c.judged).length;
  return {
    cases,
    passed,
    failed,
    inconclusive: cases.length - passed - failed,
    notPerformed,
    exitCode: caseExitCode(cases),
    ...(opts.caseId !== undefined
      ? { caseId: opts.caseId, case: model.qualifiedName(opts.caseId) }
      : {}),
  };
}

/**
 * What the cases contribute to the run's exit code, and what they deliberately
 * do not.
 *
 * A refuted case is **1**: it is the same decided finding the obligation under
 * it already reported, and it is the one thing that outranks every forgiveness.
 * A case carrying a CASE-LEVEL code — an unperformed method, no property — is
 * **2**, and no flag lowers it. Everything else is **0** *from here*: a case
 * that is inconclusive because its obligations are undecided contributes
 * nothing, because those rows are already in the run's own exit arithmetic and
 * counting them twice would let a case row override a forgiveness the flag
 * legitimately granted the row beneath it.
 */
function caseExitCode(cases: readonly VerificationCaseVerdict[]): 0 | 1 | 2 {
  if (cases.some((c) => c.verdict === 'fail')) return 1;
  if (cases.some((c) => c.code !== null || c.verdict === 'error')) return 2;
  return 0;
}

/* ─────────────────────────── writing a verdict back ──────────────────────── */

/** What {@link writeVerdict} did, in the terms a report prints. */
export interface WriteVerdictReport {
  /** Requirements whose facet was written, with the value written. */
  written: Array<{ requirement: string; verdict: 'pass' | 'fail' | 'inconclusive' }>;
  /** Facets this write MOVED — printed, never swallowed. */
  changes: VerdictDisagreement[];
  /** Requirements left alone, with the reason. */
  skipped: Array<{ requirement: string; reason: string }>;
  /** Was `@VerificationMethod { kind = analyze; }` written onto the case? */
  methodWritten: boolean;
}

/**
 * Write a computed case verdict into the model.
 *
 * THREE RULES, and each of them is the plan's rather than this function's.
 *
 *  1. **An unjudged case is refused outright.** Writing a verdict for a method
 *     this tool did not perform is precisely what the gate exists to prevent,
 *     and a write path that quietly wrote `inconclusive` instead would put a
 *     tool-authored facet on a case nobody analysed.
 *  2. **The facet is a FACET, never a {@link VerificationCaseVerdict.verdict},
 *     and it is rolled up PER REQUIREMENT.** So `pass` is written only where
 *     every obligation of THAT requirement was `proved`, and a green
 *     `--engine literal` run writes `inconclusive` — the same rule
 *     `attachEvidence` applies to a record, so the two writers cannot put
 *     different words on one requirement. A requirement this run produced no
 *     row for is written nothing at all and is named in `skipped`: the case's
 *     word is a summary over a set, and stamping it onto a member the run never
 *     looked at is how a `pass` reaches a requirement nobody checked.
 *  3. **The standard's own verdict slot is not bound.** `VerificationCase::
 *     verdict : VerdictKind {redefines result}` stays untouched, as
 *     `docs/CONFORMANCE.md` records; what is written is the tool-local
 *     `RequirementMetadata` facet on each requirement the case verifies, and
 *     the standard `@VerificationCases::VerificationMethod { kind = analyze; }`
 *     annotation on the case when it declared no method — so the file says which
 *     method the verdict was reached under rather than leaving it to be assumed.
 *
 * @throws when the case was not judged.
 */
export function writeVerdict(model: Model, verdict: VerificationCaseVerdict): WriteVerdictReport {
  if (!verdict.judged) {
    throw new Error(
      `writeVerdict: ${verdict.case.qualifiedName} was not judged — ${verdict.detail} A verdict ` +
        'written for a method this tool did not perform is the one thing the method gate exists ' +
        'to prevent.',
    );
  }
  const report: WriteVerdictReport = {
    written: [],
    changes: [],
    skipped: [],
    methodWritten: false,
  };
  for (const f of verdict.facets) {
    const el = model.get(f.requirementId);
    if (!el) {
      report.skipped.push({
        requirement: f.requirement,
        reason: 'the requirement is no longer in the model',
      });
      continue;
    }
    if (!isUserModelElement(model, el)) {
      report.skipped.push({
        requirement: f.requirement,
        reason:
          'it is a bundled standard-library element — a facet written onto the library is never ' +
          'saved with the reader’s file',
      });
      continue;
    }
    if (f.facet === null) {
      report.skipped.push({
        requirement: f.requirement,
        reason:
          'this run produced no obligation row for it — the case’s verdict stands on the other ' +
          'requirement(s) it verifies, and a facet written here would state a verdict nothing checked',
      });
      continue;
    }
    const claimed = getRequirementAttr(model, f.requirementId, 'verdict');
    setRequirementAttr(model, f.requirementId, 'verdict', f.facet);
    report.written.push({ requirement: f.requirement, verdict: f.facet });
    if (claimed !== undefined && claimed !== f.facet) {
      report.changes.push({
        requirement: f.requirement,
        claimed,
        computed: f.facet,
        overstates: claimed === 'pass' && f.facet !== 'pass',
      });
    }
  }
  if (!verdict.method.declaresMethod) {
    writeMethodAnnotation(model, verdict.case.id);
    report.methodWritten = true;
  }
  return report;
}

/**
 * `@VerificationCases::VerificationMethod { attribute kind = analyze; }`, in the
 * shape the notation reads back unchanged.
 *
 * The one thing written here that is STANDARD rather than tool-local, which is
 * why it is written at all: a case with a computed verdict and no stated method
 * leaves a reader to assume which method produced it, and the specification has
 * a slot for exactly that. Measured: this shape parses with zero diagnostics,
 * lands as a `MetadataUsage` with `attrs.annotation` and a `kind` cell holding
 * the source lexeme, and round-trips.
 */
function writeMethodAnnotation(model: Model, caseId: ElementId): void {
  model.transaction(() => {
    const carrier = model.create('MetadataUsage', {
      ownerId: caseId,
      attrs: { annotation: true, type: `VerificationCases::${VERIFICATION_METHOD_DEF}` },
    });
    model.create('AttributeUsage', {
      declaredName: METHOD_KIND_ATTR,
      ownerId: carrier.id,
      attrs: { value: PERFORMED_METHOD },
    });
  });
}
