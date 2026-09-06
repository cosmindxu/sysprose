/**
 * The validation rule registry.
 *
 * Each rule is a small, dependency-light checker over the {@link Model} graph.
 * Rules are pure and side-effect free; they emit precise {@link Diagnostic}s
 * carrying the offending `elementId` wherever one applies. The set below covers
 * the structural well-formedness constraints called out in the build plan
 * (naming, endpoints, typing, multiplicity, requirements, containment).
 *
 * Diagnostic id scheme: `<ruleId>#<n>` where `n` is a per-rule running index.
 * Because every rule id is unique, diagnostic ids are unique model-wide.
 */

import {
  type AttrValue,
  type ElementId,
  type ElementRecord,
  type Model,
  isRelationship,
  isRequirement,
  isSpecialization,
} from '@core/index';
import { findLibraryType } from '../library/resolve';
import {
  checkConstraints,
  conforms,
  effectiveFeatures,
  generalizationsWithImplicit,
  isFeatureMetaclass,
  isKindOf,
  resolveFullName,
  resolveQualifiedNameFull,
  resolveRedefinedFeature,
  isNonNormativeStatement,
  statementKindOf,
  valueConformsToType,
  isWritableNoteBody,
  NOTE_BODY_TERMINATOR,
} from '../semantics/index';
import { dimEqual, dimToString } from '../semantics/units';
import {
  dimensionClaimDetail,
  dimensionalFacets,
  resolveUnitRef,
  unitRefsIn,
  type DerivationMemo,
} from '../semantics/units-eval';
import type { Diagnostic, Severity, ValidationRule } from './types';
import { connectionCompatibility } from './rules-connection';

/* ───────────────────────────── small helpers ───────────────────────────── */

/** Read an attribute as a string, or undefined when absent/non-string. */
function asString(v: AttrValue | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * Best-effort, cycle-safe qualified label for an element in messages.
 *
 * We compute the owner path ourselves with a `visited` guard rather than using
 * `Model.qualifiedName`, because a malformed model (self-ownership / containment
 * cycle — exactly what some rules detect) would send the core walker into an
 * infinite loop.
 */
function label(model: Model, el: ElementRecord): string {
  const parts: string[] = [];
  const visited = new Set<string>();
  let cur: ElementRecord | undefined = el;
  while (cur && !visited.has(cur.id)) {
    visited.add(cur.id);
    parts.unshift(cur.declaredName ?? cur.declaredShortName ?? `«${cur.eClass}»`);
    cur = cur.ownerId !== null ? model.get(cur.ownerId) : undefined;
  }
  return parts.length ? parts.join('::') : `«${el.eClass}» ${el.id}`;
}

/** A factory that builds uniquely-id'd diagnostics for one rule run. */
function diagBuilder(ruleId: string, defaultSeverity: Severity) {
  let n = 0;
  return (message: string, elementId?: string, severity?: Severity): Diagnostic => ({
    id: `${ruleId}#${n++}`,
    ruleId,
    severity: severity ?? defaultSeverity,
    message,
    elementId,
  });
}

/** Endpoint count (source + target) for an edge-bearing element. */
function endpointCount(el: ElementRecord): number {
  return (el.source?.length ?? 0) + (el.target?.length ?? 0);
}

/** True for bundled standard-library content (never flagged by semantic rules). */
function isLibraryElement(el: ElementRecord): boolean {
  return el.attrs.isLibrary === true;
}

/**
 * Resolve the id of a feature's declared TYPE element, for conformance checks:
 * an `attrs.type`/`attrs.typeRef` name (resolved against the standard library or
 * a user qualified name) or the target of an owned FeatureTyping. Returns
 * `undefined` when the type is absent or cannot be resolved (→ no judgement).
 */
function declaredTypeElementId(model: Model, featureId: ElementId): ElementId | undefined {
  const el = model.get(featureId);
  if (!el) return undefined;
  const name = asString(el.attrs.type) ?? asString(el.attrs.typeRef);
  if (name && name.trim() !== '') {
    const lib = findLibraryType(model, name);
    if (lib) return lib.id;
    // Full KerML scoping (owned/inherited/imported), so an imported qualified
    // type name resolves for the conformance check.
    const q = resolveQualifiedNameFull(model, name);
    if (q) return q.id;
  }
  for (const r of model.relationshipsFrom(featureId)) {
    if (r.eClass === 'FeatureTyping') {
      const t = r.target?.[0];
      if (t && model.has(t)) return t;
    }
  }
  return undefined;
}

/* ─────────────────────────── constant catalogues ───────────────────────── */

const VALID_DIRECTIONS = new Set(['in', 'out', 'inout']);

/** Multiplicity tokens accepted by the textual notation. */
const MULTIPLICITY_RE = /^\d+(\.\.(\d+|\*))?$/;

/**
 * Connector-like metaclasses that require ≥2 endpoints. Includes the
 * flow/succession family (Succession, SuccessionFlow, Flow, FlowUsage) whose
 * `first…then` / `from…to` clauses need both endpoints (finding H10).
 */
const CONNECTOR_KINDS = new Set([
  'ConnectionUsage',
  'InterfaceUsage',
  'Connector',
  'BindingConnectorAsUsage',
  'Succession',
  'SuccessionFlow',
  'Flow',
  'FlowUsage',
]);

/**
 * Annotation metaclasses whose `body` the serializer writes between note
 * delimiters — the three branches at the top of `serializeElement`.
 */
const NOTE_BODY_KINDS = new Set(['Documentation', 'Comment', 'TextualRepresentation']);

/** Requirement metaclasses that must carry a subject. */
const REQUIREMENT_KINDS = new Set(['RequirementUsage', 'RequirementDefinition']);

/** Specialization metaclasses whose target must resolve. */
const REDEF_SUBSET_KINDS = new Set(['Redefinition', 'Subsetting', 'ReferenceSubsetting']);

/* ─────────────────────────────────  rules  ─────────────────────────────── */

/** (1) Two sibling elements declaring the same name in one namespace. */
const duplicateName: ValidationRule = {
  id: 'duplicate-name',
  description: 'Duplicate declaredName within the same owner/namespace.',
  severity: 'error',
  run(model) {
    const mk = diagBuilder(this.id, this.severity);
    const out: Diagnostic[] = [];
    // group: ownerId → (name → element ids)
    const groups = new Map<string, Map<string, ElementRecord[]>>();
    for (const el of model.all()) {
      if (isLibraryElement(el)) continue; // trusted, well-formed library content
      const name = el.declaredName;
      if (name === undefined || name.trim() === '') continue;
      const ownerKey = el.ownerId ?? '\0root';
      let byName = groups.get(ownerKey);
      if (!byName) groups.set(ownerKey, (byName = new Map()));
      const list = byName.get(name);
      if (list) list.push(el);
      else byName.set(name, [el]);
    }
    for (const byName of groups.values()) {
      for (const [name, els] of byName) {
        if (els.length < 2) continue;
        for (const el of els) {
          out.push(
            mk(
              `Duplicate name "${name}" within ${
                el.ownerId ? label(model, model.require(el.ownerId)) : 'the root namespace'
              }.`,
              el.id,
            ),
          );
        }
      }
    }
    return out;
  },
};

/** (2) A named element whose declaredName is present but blank. */
const blankName: ValidationRule = {
  id: 'blank-name',
  description: 'Named element with an empty or whitespace-only declaredName.',
  severity: 'error',
  run(model) {
    const mk = diagBuilder(this.id, this.severity);
    const out: Diagnostic[] = [];
    for (const el of model.all()) {
      if (isLibraryElement(el)) continue;
      if (el.declaredName !== undefined && el.declaredName.trim() === '') {
        out.push(mk(`Element «${el.eClass}» has a blank name.`, el.id));
      }
    }
    return out;
  },
};

/** (3) A relationship/edge endpoint referencing a non-existent element. */
const danglingEndpoint: ValidationRule = {
  id: 'dangling-endpoint',
  description: 'Relationship source/target id not present in the model.',
  severity: 'error',
  run(model) {
    const mk = diagBuilder(this.id, this.severity);
    const out: Diagnostic[] = [];
    for (const el of model.all()) {
      if (isLibraryElement(el)) continue;
      const source = el.source ?? [];
      const target = el.target ?? [];
      for (const ref of source) {
        if (!model.has(ref)) {
          out.push(mk(`Dangling source endpoint "${ref}" on «${el.eClass}».`, el.id));
        }
      }
      for (const ref of target) {
        if (!model.has(ref)) {
          out.push(mk(`Dangling target endpoint "${ref}" on «${el.eClass}».`, el.id));
        }
      }
    }
    return out;
  },
};

/** The specialization-family attributes the mapper leaves behind as TEXT. */
const TEXTUAL_REF_KEYS = ['typeRef', 'specializes', 'redefines', 'references'];

/** Every still-textual type/specialization reference an element carries. */
function textualRefsOf(el: ElementRecord): Array<{ key: string; ref: string }> {
  const out: Array<{ key: string; ref: string }> = [];
  for (const key of TEXTUAL_REF_KEYS) {
    const v = el.attrs[key];
    if (typeof v === 'string') {
      if (v.trim() !== '') out.push({ key, ref: v });
    } else if (Array.isArray(v)) {
      for (const x of v) if (typeof x === 'string' && x.trim() !== '') out.push({ key, ref: x });
    }
  }
  return out;
}

/**
 * Does one textual reference denote something? The rule's own predicate,
 * factored out so {@link scopeMembersIncomplete} asks the identical question
 * about the SCOPES a reference is judged in.
 *
 * A reference is not a defect when it resolves FROM THE ELEMENT'S OWN SCOPE —
 * the same walk the parser and the binder use, so this rule agrees with them by
 * construction — or, failing that, against the loaded library.
 */
function referenceResolves(
  model: Model,
  el: ElementRecord,
  key: string,
  ref: string,
): boolean {
  if (model.has(ref)) return true;
  // KerML §8.2.3.5.1 gives a redefinition its own rule: the generals of the
  // owning type are searched first.
  const scoped =
    key === 'redefines'
      ? resolveRedefinedFeature(model, ref, el.id, el.ownerId)
      : resolveFullName(model, ref, el.ownerId, { exclude: el.id });
  if (scoped) return true;
  // Library fallbacks, but only for a NON-FEATURE library element.
  // `findLibraryType` matches an unqualified name against every library
  // element, so short names hit function parameters and unit symbols — `w` resolves to
  // `VectorFunctions::+::w`, `W` to `SI::watt`, `B` to `SI::byte`. That
  // silently blessed every dangling `:>> w`. Bare library DEFINITIONS
  // (`:> Part`) still count: naming one without an import is leniency this
  // tool chooses to keep.
  const lib = findLibraryType(model, ref) ?? resolveQualifiedNameFull(model, ref);
  return lib !== undefined && !(lib.attrs.isLibrary === true && isFeatureMetaclass(lib.eClass));
}

/**
 * Is the namespace a reference is judged in INCOMPLETE — i.e. does some scope
 * it resolves through carry a type or general that does not resolve either?
 *
 * A reference is only "dangling" if the tool could have enumerated the members
 * it might have named. When an enclosing type's own supertype is unresolved,
 * its inherited members are unknown, so calling a `:>>` of one an ERROR asserts
 * something the tool cannot know. That is the ordinary case for a file that
 * cites library content the bundled subset does not carry:
 * `attribute def MyValue :> ScalarQuantityValue { attribute :>> num : Real; }`
 * loses `ScalarQuantityValue` (warned separately) and then reported `num` as a
 * hard error — 348 of them in one library file, 2 155 → 4 882 over the 309-file
 * corpus. The unresolved GENERAL is the finding worth reading; everything
 * downstream of it is noise.
 *
 * The test is whether the scope's own declarations BOUND, not whether their
 * names could be resolved — different questions here, because this rule is
 * lenient about a bare library definition while the BINDER is not. `attribute
 * def SpeedOfLightInAMediumValue :> ScalarQuantityValue` in `ISQLight.sysml`
 * keeps `attrs.specializes` and has NO general in the model, yet the name
 * itself "resolves" under that leniency — asking the name put 3 288 of the
 * errors straight back.
 *
 * The element's own refs are not consulted: those are what is being judged.
 */
function scopeMembersIncomplete(model: Model, el: ElementRecord): boolean {
  const unbound = (e: ElementRecord): boolean => {
    // The specialization-family attributes are pure RESIDUE — the mapper writes
    // them only where nothing bound, and the library binder clears them when it
    // succeeds — so their PRESENCE is the hole.
    if (textualRefsOf(e).length > 0) return true;
    // `attrs.type` is different: it is the silent fallback for an unresolved
    // `:` on an Attribute*, but a RESOLVED typing leaves it in place for the
    // serializer to re-emit, so it counts only when nothing bound.
    const t = asString(e.attrs.type);
    return t !== undefined && t.trim() !== '' && model.typesOf(e.id).length === 0;
  };
  let scope = el.ownerId;
  const seen = new Set<ElementId>();
  while (scope != null && !seen.has(scope)) {
    seen.add(scope);
    const scopeEl = model.get(scope);
    if (!scopeEl) break;
    if (unbound(scopeEl)) return true;
    // Transitively: a resolved general whose OWN general is unresolved leaves
    // the same hole.
    for (const g of generalizationsWithImplicit(model, scope)) {
      if (g.attrs.isLibrary !== true && unbound(g)) return true;
    }
    scope = scopeEl.ownerId;
  }
  return false;
}

/** (4) Unresolved type/specialization references (attrs.typeRef + node-level
 * `specializes`/`redefines`/`references` keys — finding H9). */
const unresolvedTypeRef: ValidationRule = {
  id: 'unresolved-type-ref',
  description: 'Type/specialization reference does not resolve to any element.',
  severity: 'error',
  run(model) {
    const mk = diagBuilder(this.id, this.severity);
    const out: Diagnostic[] = [];
    for (const el of model.all()) {
      if (isLibraryElement(el)) continue;
      // `attrs.typeRef` (an unresolved `:` FeatureTyping) plus the node-level
      // keys the parser fills when an inline `:>`/`:>>`/`::>` target cannot be
      // resolved. `attrs.type` — the SILENT fallback for an unresolved `:` on
      // an Attribute* — is deliberately not judged (pinned by
      // `L3-unresolved-attribute-type-is-silent`), though it does count as a
      // hole for the scope test below.
      for (const { key, ref } of textualRefsOf(el)) {
        if (referenceResolves(model, el, key, ref)) continue;
        // Refusing a library FEATURE is what unmasks a dangling `:>> w`. It
        // must not also turn every redefinition of an inherited feature into an
        // error when the inheritance itself is broken: with a supertype the
        // tool could not bind, it has no basis for the claim.
        if (scopeMembersIncomplete(model, el)) continue;
        out.push(mk(`Unresolved type reference "${ref}" on ${label(model, el)}.`, el.id));
      }
    }
    return out;
  },
};

/** (5) PortUsage with a missing or invalid direction. */
const portDirection: ValidationRule = {
  id: 'port-direction',
  description: 'PortUsage direction missing or not one of in/out/inout.',
  severity: 'error',
  run(model) {
    const mk = diagBuilder(this.id, this.severity);
    const out: Diagnostic[] = [];
    for (const el of model.ofKind('PortUsage')) {
      if (isLibraryElement(el)) continue;
      const dir = asString(el.attrs.direction);
      if (dir === undefined) {
        out.push(mk(`Port "${label(model, el)}" has no direction (expected in/out/inout).`, el.id, 'warning'));
      } else if (!VALID_DIRECTIONS.has(dir)) {
        out.push(mk(`Port "${label(model, el)}" has invalid direction "${dir}".`, el.id));
      }
    }
    return out;
  },
};

/** (6) A multiplicity string that does not match the accepted grammar. */
/**
 * A declaration that parsed to nothing but a keyword.
 *
 * `port in in a : Pt;` or `port foo bar;` splits into a bare keyword-only
 * member plus a second member, because a usage's name and terminator are both
 * optional in the grammar. The bare member becomes a nameless element with no
 * type, no value, no body and no specialization — something no author writes
 * on purpose. It used to render as a phantom port handle with no diagnostic.
 */
const splitDeclaration: ValidationRule = {
  id: 'split-declaration',
  description: 'A keyword-only declaration with no name, type, value, body or specialization.',
  severity: 'warning',
  run(model) {
    const mk = diagBuilder(this.id, this.severity);
    const out: Diagnostic[] = [];
    for (const el of model.all()) {
      if (isLibraryElement(el)) continue;
      if (isRelationship(el.eClass)) continue;
      if (el.attrs.implicit === true) continue;
      if (el.declaredName !== undefined || el.declaredShortName !== undefined) continue;
      // Anonymous elements the language legitimately has: comments, docs,
      // control nodes, connectors, requirement clauses, expressions, imports.
      if (!SPLIT_CANDIDATE_KINDS.has(el.eClass)) continue;
      const attrs = el.attrs;
      const hasSubstance =
        // An element that carries its own unparsed source (a syntax residue,
        // or a grammar-legal keyword this tool models no metaclass for) is not
        // a split declaration — it is a declaration this tool could not read,
        // already reported once by the parser or the mapper. Reporting it
        // again here pointed the author at a completely different repair.
        attrs.unparsedText !== undefined ||
        attrs.type !== undefined ||
        attrs.typeRef !== undefined ||
        attrs.value !== undefined ||
        attrs.expression !== undefined ||
        attrs.specializes !== undefined ||
        attrs.redefines !== undefined ||
        attrs.references !== undefined ||
        model.children(el.id).length > 0;
      if (hasSubstance) continue;
      out.push(
        mk(
          `A bare «${el.eClass}» with no name, type, value or body — this declaration was probably split by a misplaced keyword.`,
          el.id,
        ),
      );
    }
    return out;
  },
};

/** Metaclasses a stray keyword can produce; anonymous forms of these are never intentional. */
const SPLIT_CANDIDATE_KINDS = new Set([
  'PartUsage',
  'PartDefinition',
  'PortUsage',
  'PortDefinition',
  'AttributeUsage',
  'AttributeDefinition',
  'ItemUsage',
  'ItemDefinition',
  'ActionUsage',
  'ActionDefinition',
  'StateUsage',
  'StateDefinition',
  'RequirementUsage',
  'RequirementDefinition',
  'ReferenceUsage',
  'ConstraintDefinition',
  'InterfaceDefinition',
  'ConnectionDefinition',
  'Package',
]);

const malformedMultiplicity: ValidationRule = {
  id: 'malformed-multiplicity',
  description: "Multiplicity must match /^\\d+(\\.\\.(\\d+|\\*))?$/ or '*'.",
  severity: 'error',
  run(model) {
    const mk = diagBuilder(this.id, this.severity);
    const out: Diagnostic[] = [];
    for (const el of model.all()) {
      if (isLibraryElement(el)) continue;
      const m = asString(el.attrs.multiplicity);
      if (m === undefined) continue;
      if (m === '*' || MULTIPLICITY_RE.test(m)) continue;
      // The parser stores a trailing unit (e.g. `= 1500 [kg]`) in attrs.multiplicity
      // as a bare identifier. A real multiplicity always contains a digit or `*`,
      // so a purely-alphabetic value is a unit, not a malformed multiplicity.
      if (/^[A-Za-z]\w*$/.test(m)) continue;
      out.push(mk(`Malformed multiplicity "${m}" on ${label(model, el)}.`, el.id));
    }
    return out;
  },
};

/** (7) A connection/connector with fewer than two endpoints. */
const connectorEndpoints: ValidationRule = {
  id: 'connector-endpoints',
  description: 'Connection/connector must have at least two endpoints.',
  severity: 'error',
  run(model) {
    const mk = diagBuilder(this.id, this.severity);
    const out: Diagnostic[] = [];
    for (const el of model.all()) {
      if (isLibraryElement(el)) continue;
      if (!CONNECTOR_KINDS.has(el.eClass)) continue;
      const count = endpointCount(el);
      if (count < 2) {
        out.push(
          mk(`Connector "${label(model, el)}" has ${count} endpoint(s); at least 2 are required.`, el.id),
        );
      }
    }
    return out;
  },
};

/**
 * (8) A requirement with no subject.
 *
 * NORMATIVE statements only. A subject is what a requirement constrains, which
 * makes "what is this about?" a fair question to ask of a rule and a
 * meaningless one to ask of an explanation or of guidance written for an agent
 * — both of which are written in requirement shape here and tagged with a
 * `#prose` / `#prompt` keyword. Without the filter, every paragraph of prose in
 * a model bought a warning, so the tool would have argued with its own feature.
 */
const requirementSubject: ValidationRule = {
  id: 'requirement-subject',
  description:
    'Requirement has no subject (attribute, subject feature declared or inherited, or satisfy/verify).',
  severity: 'warning',
  run(model) {
    const mk = diagBuilder(this.id, this.severity);
    const out: Diagnostic[] = [];
    for (const el of model.all()) {
      if (isLibraryElement(el)) continue;
      if (!REQUIREMENT_KINDS.has(el.eClass)) continue;
      if (!isNormative(model, el)) continue;
      if (hasSubject(model, el)) continue;
      out.push(mk(`Requirement "${label(model, el)}" has no subject.`, el.id));
    }
    return out;
  },
};

/**
 * True when this statement is the kind that binds — the only kind a requirement
 * rule has anything to say about.
 *
 * An untagged requirement is normative: `statementKindOf` answers from the
 * metaclass when no keyword says otherwise, so a model written before statement
 * kinds existed is checked exactly as it was. One predicate, so every
 * requirement rule added later asks the question the same way.
 *
 * A rule that also judges plain CONSTRAINTS cannot use this one — a
 * `constraint c { … }` has no statement kind, so it would fail this test and be
 * skipped. That rule asks {@link isNonNormativeStatement} instead, which
 * exempts only what an author explicitly tagged.
 */
function isNormative(model: Model, el: ElementRecord): boolean {
  return statementKindOf(model, el.id) === 'requirement';
}

/**
 * True when a feature plays the SUBJECT role of the requirement that owns it.
 *
 * The textual `subject v : Vehicle;` clause maps to a child ReferenceUsage
 * tagged `attrs.requirementRole = 'subject'` (the grammar's `kind='subject'`,
 * sysml.langium:279). That form was not checked here, so a requirement with a
 * perfectly good subject was reported as having none — a false positive on the
 * most idiomatic way to write one. `SubjectMembership` and the bare name cover
 * models built programmatically, which carry no clause tag.
 *
 * The same predicate judges own and inherited candidates, but the two candidate
 * SETS differ: only the first two forms can ever be inherited, because the
 * inherited set is Usages only (see {@link hasSubject}). A `SubjectMembership`
 * is not a Usage, so that disjunct answers for the element that owns it and for
 * no other — measured, not assumed.
 */
function isSubjectFeature(c: ElementRecord): boolean {
  return (
    c.attrs.requirementRole === 'subject' ||
    c.declaredName === 'subject' ||
    c.eClass === 'SubjectMembership'
  );
}

/**
 * True when a requirement element carries a subject by any supported means.
 *
 * A subject may be stated once, on the definition, and inherited by every usage
 * of it: `requirement r : MassLimit;` is the shape the OMG's own published
 * models are written in, and reading only the usage's OWN children asked the
 * author to repeat the subject on every usage and warned when they did not. So
 * the inherited feature set is asked too, and the same role test is applied.
 *
 * The query is {@link effectiveFeatures}, which follows DECLARED generals only,
 * and deliberately not `effectiveFeaturesWithLibrary`, which also follows the
 * implicit library base. The rule asks what the AUTHOR said this requirement is
 * about, and an implicit base is not something the author said. The wider walk
 * is NOT equivalent: measured, `effectiveFeaturesWithLibrary` of a bare
 * `requirement Naked;` already returns nine features of the implicit base
 * `Requirements::RequirementCheck`, one of them a subject reference — it is
 * spelled `subj`, so only its NAME keeps that walk harmless today. Two rule
 * tests hold the line: one asserts the shape of that difference, the other
 * plants a subject-shaped feature on the implicit base and asserts the rule
 * still fires, which is the assertion that goes red the day this query is
 * widened.
 *
 * Two boundaries of the inherited path, both pinned by tests rather than left
 * to be rediscovered:
 *  - The inherited candidates are USAGES only ({@link effectiveFeatures} →
 *    `ownFeatures`, `src/semantics/inheritance.ts`:49). A `SubjectMembership`
 *    or any other non-Usage child therefore answers on the own-children line
 *    below and never through inheritance.
 *  - `effectiveFeatures` masks an inherited feature by NAME (KerML
 *    redefinition-by-name). An own feature of the usage that happens to share
 *    the inherited subject's name hides it, and the requirement is reported as
 *    having no subject. That is the inheritance semantics the whole codebase
 *    shares, so it is recorded here rather than special-cased for one rule.
 */
function hasSubject(model: Model, req: ElementRecord): boolean {
  const subj = req.attrs.subject;
  if (subj !== undefined && subj !== null && subj !== '') return true;
  if (model.children(req.id).some(isSubjectFeature)) return true;
  if (effectiveFeatures(model, req.id).some(isSubjectFeature)) return true;
  // A `satisfy R by X;` / `verify R by X;` names the thing being checked against
  // the requirement, which is the subject in all but name. A SOURCE-LESS one
  // does not: the bare `verify R;` clause inside a case objective says only
  // WHICH requirement the case checks, never who or what it checks it on, so it
  // must not silence a requirement that still has no subject.
  return model
    .relationshipsTo(req.id)
    .some(
      (r) =>
        (r.eClass === 'Satisfy' || r.eClass === 'Verify') &&
        ((r.source ?? []).length > 0 || typeof r.attrs.sourceRef === 'string'),
    );
}

/** (9) A redefinition/subsetting whose target is missing or unresolved. */
const redefinitionTarget: ValidationRule = {
  id: 'redefinition-target-missing',
  description: 'Redefinition/subsetting/reference-subsetting target is missing or unresolved.',
  severity: 'error',
  run(model) {
    const mk = diagBuilder(this.id, this.severity);
    const out: Diagnostic[] = [];
    for (const el of model.all()) {
      if (isLibraryElement(el)) continue;
      if (!REDEF_SUBSET_KINDS.has(el.eClass)) continue;
      const targets = el.target ?? [];
      if (targets.length === 0) {
        out.push(mk(`«${el.eClass}» on ${label(model, el)} has no target.`, el.id));
        continue;
      }
      for (const t of targets) {
        if (!model.has(t)) {
          out.push(mk(`«${el.eClass}» target "${t}" does not exist.`, el.id));
        }
      }
    }
    return out;
  },
};

/** (10) Self-ownership or a containment cycle. */
const containmentCycle: ValidationRule = {
  id: 'containment-cycle',
  description: 'Element owns itself or participates in a containment cycle.',
  severity: 'error',
  run(model) {
    const mk = diagBuilder(this.id, this.severity);
    const out: Diagnostic[] = [];
    for (const el of model.all()) {
      if (isLibraryElement(el)) continue;
      const visited = new Set<string>([el.id]);
      let cur: ElementRecord | undefined = el;
      while (cur && cur.ownerId !== null) {
        if (cur.ownerId === el.id) {
          out.push(
            mk(
              el.ownerId === el.id
                ? `Element ${label(model, el)} owns itself.`
                : `Containment cycle through ${label(model, el)}.`,
              el.id,
            ),
          );
          break;
        }
        // Cycle that does not pass through `el`: it will be reported from one of
        // its own members; stop here to avoid duplicate findings.
        if (visited.has(cur.ownerId)) break;
        visited.add(cur.ownerId);
        cur = model.get(cur.ownerId);
      }
    }
    return out;
  },
};

/**
 * (10b) A specialization-family cycle (Subsetting/Subclassification/
 * FeatureTyping/Redefinition/ReferenceSubsetting/Conjugation forming a loop,
 * e.g. `A :> B :> A`). `typesOf`/`generalizationsOf`/`conforms` walk these
 * edges, so a cycle makes type resolution self-referential and can hang the
 * BFS walks (finding H8). A cycle that does not pass through the start element
 * is reported from one of its own members.
 */
const specializationCycle: ValidationRule = {
  id: 'specialization-cycle',
  description: 'Specialization-family relationships form a cycle.',
  severity: 'error',
  run(model) {
    const mk = diagBuilder(this.id, this.severity);
    const out: Diagnostic[] = [];
    const edges = (id: ElementId): ElementId[] =>
      model
        .relationshipsFrom(id)
        .filter((r) => isSpecialization(r.eClass))
        .map((r) => r.target?.[0])
        .filter((t): t is string => t !== undefined && model.has(t));
    for (const start of model.all()) {
      if (isLibraryElement(start)) continue;
      // Iterative DFS following every specialization edge. If an edge returns
      // to `start`, the element is on a cycle; back-edges to other path
      // members are cycles owned by those members (reported from their start).
      const path = new Set<ElementId>([start.id]);
      const stack: Array<{ id: ElementId; idx: number }> = [{ id: start.id, idx: 0 }];
      while (stack.length) {
        const frame = stack[stack.length - 1];
        const next = edges(frame.id);
        if (frame.idx >= next.length) {
          stack.pop();
          path.delete(frame.id);
          continue;
        }
        const t = next[frame.idx++];
        if (t === start.id) {
          out.push(
            mk(
              frame.id === start.id
                ? `Element ${label(model, start)} specializes itself.`
                : `Specialization cycle through ${label(model, start)}.`,
              start.id,
            ),
          );
          break;
        }
        if (path.has(t)) continue;
        path.add(t);
        stack.push({ id: t, idx: 0 });
      }
    }
    return out;
  },
};

/** (11) A relationship element with no owner. */
const orphanRelationship: ValidationRule = {
  id: 'orphan-relationship',
  description: 'Relationship element is not owned by any element.',
  severity: 'warning',
  run(model) {
    const mk = diagBuilder(this.id, this.severity);
    const out: Diagnostic[] = [];
    for (const el of model.all()) {
      if (isLibraryElement(el)) continue;
      if (isRelationship(el.eClass) && el.ownerId === null) {
        out.push(mk(`Orphan «${el.eClass}» relationship is not owned.`, el.id));
      }
    }
    return out;
  },
};

/**
 * (12) A FeatureTyping whose target is not a KerML `Type`.
 *
 * KerML says a FeatureTyping's general end must be a `Type` — and every
 * Classifier AND Feature (hence every SysML Definition AND Usage) is a `Type`.
 * We therefore trust any target whose metaclass {@link isKindOf} `'Type'`
 * (Definitions, library `DataType`/`Class`/`Classifier`/`Function`/…, and even a
 * Usage used as a type), and flag only targets whose metaclass is genuinely NOT
 * a type — e.g. a `Package`/`Namespace`, an annotation, or a relationship. Using
 * the metaclass lattice (rather than the SysML-Definition-only check) removes the
 * former false positives on library types and on feature-as-type references.
 * Library-content targets are additionally trusted as a defensive fallback for
 * any metaclass outside the encoded lattice.
 */
const featureTypingNonType: ValidationRule = {
  id: 'feature-typing-non-type',
  description: 'Feature is typed by a non-type element (FeatureTyping target metaclass is not a Type).',
  severity: 'error',
  run(model) {
    const mk = diagBuilder(this.id, this.severity);
    const out: Diagnostic[] = [];
    for (const el of model.ofKind('FeatureTyping')) {
      if (isLibraryElement(el)) continue;
      for (const t of el.target ?? []) {
        const target = model.get(t);
        // Missing targets are handled by dangling-endpoint; only flag wrong kind.
        if (target && !isLibraryElement(target) && !isKindOf(target.eClass, 'Type')) {
          out.push(
            mk(
              `Feature typed by non-type «${target.eClass}» ${label(model, target)}.`,
              el.source?.[0] ?? el.id,
            ),
          );
        }
      }
    }
    return out;
  },
};

/**
 * (12b) A connector / binding-connector endpoint that is not a `Feature`.
 *
 * KerML connectors (Connector, ConnectionUsage, InterfaceUsage, binding
 * connectors) relate *features* — their endpoints must be `Feature`s (parts,
 * ports, attributes, …, all of which are Usages hence Features). An endpoint
 * resolving to a non-feature (e.g. a `Definition`/Classifier, a Package, or an
 * annotation) is malformed. Uses the metaclass lattice via {@link isKindOf};
 * missing endpoints are left to `dangling-endpoint`.
 */
const connectorEndNotFeature: ValidationRule = {
  id: 'connector-end-not-feature',
  description: 'Connector/binding endpoint does not resolve to a Feature.',
  severity: 'error',
  run(model) {
    const mk = diagBuilder(this.id, this.severity);
    const out: Diagnostic[] = [];
    for (const el of model.all()) {
      if (isLibraryElement(el)) continue;
      if (!CONNECTOR_KINDS.has(el.eClass)) continue;
      for (const end of [...(el.source ?? []), ...(el.target ?? [])]) {
        const target = model.get(end);
        if (target && !isLibraryElement(target) && !isKindOf(target.eClass, 'Feature')) {
          out.push(
            mk(
              `Connector "${label(model, el)}" end «${target.eClass}» ${label(model, target)} is not a Feature.`,
              el.id,
            ),
          );
        }
      }
    }
    return out;
  },
};

/* ───────────────────────── semantic rules (KerML) ──────────────────────── */

/**
 * (13) An attribute's stored literal value is inconsistent with its declared
 * numeric/Boolean/String type family (e.g. `count : Integer = 3.5`, or a String
 * literal on a numeric attribute). Uses {@link valueConformsToType}; only clear
 * mismatches are flagged (missing values / non-literal expressions are ignored).
 */
const valueTypeMismatch: ValidationRule = {
  id: 'value-type-mismatch',
  description: 'Attribute literal value inconsistent with its declared numeric/Boolean/String type.',
  severity: 'warning',
  run(model) {
    const mk = diagBuilder(this.id, this.severity);
    const out: Diagnostic[] = [];
    for (const el of model.ofKind('AttributeUsage', 'AttributeDefinition')) {
      if (isLibraryElement(el)) continue;
      if (valueConformsToType(model, el.id) !== 'mismatch') continue;
      out.push(
        mk(
          `Value ${JSON.stringify(el.attrs.value)} of ${label(model, el)} is inconsistent with its declared type "${
            asString(el.attrs.type) ?? '?'
          }".`,
          el.id,
        ),
      );
    }
    return out;
  },
};

/**
 * (14) A Redefinition whose redefining feature's declared type does NOT conform
 * to (specialize) the redefined feature's declared type — the KerML rule that a
 * redefining feature may only narrow, never widen or diverge from, the type of
 * the feature it redefines. Skipped when either type is unresolved.
 */
const redefinitionConformance: ValidationRule = {
  id: 'redefinition-conformance',
  description: "Redefining feature's type does not conform to the redefined feature's type.",
  severity: 'warning',
  run(model) {
    const mk = diagBuilder(this.id, this.severity);
    const out: Diagnostic[] = [];
    for (const el of model.ofKind('Redefinition')) {
      if (isLibraryElement(el)) continue;
      const redefiningId = el.source?.[0];
      const redefinedId = el.target?.[0];
      if (!redefiningId || !redefinedId || !model.has(redefiningId) || !model.has(redefinedId)) {
        continue;
      }
      const redefiningType = declaredTypeElementId(model, redefiningId);
      const redefinedType = declaredTypeElementId(model, redefinedId);
      // Only judge when both feature types are known.
      if (!redefiningType || !redefinedType) continue;
      if (conforms(model, redefiningType, redefinedType)) continue;
      out.push(
        mk(
          `Redefining feature ${label(model, model.require(redefiningId))} has type "${
            model.get(redefiningType)?.declaredName ?? redefiningType
          }" which does not conform to the redefined feature's type "${
            model.get(redefinedType)?.declaredName ?? redefinedType
          }".`,
          redefiningId,
        ),
      );
    }
    return out;
  },
};

/**
 * (15) Constraint/requirement satisfaction, from {@link checkConstraints}: a
 * `violated` boolean constraint is a warning (message includes the expression);
 * an `unknown` (unevaluable) constraint is reported as info. Satisfied
 * constraints produce no diagnostic.
 *
 * This rule reads REQUIREMENTS as well as constraints ({@link checkConstraints}
 * enumerates both metaclasses), so it is a requirement rule too and takes the
 * same exemption: an author who wrote `#prose` or `#prompt` in front of a
 * statement said it binds nothing, and a tool that then argues the statement is
 * violated has contradicted the author's own tag. The test is
 * {@link isNonNormativeStatement}, NOT `!isNormative`: an ordinary
 * `constraint c { … }` carries no statement kind at all and is judged exactly
 * as it always was.
 */
const constraintViolation: ValidationRule = {
  id: 'constraint-violation',
  description: 'Constraint/requirement expression is violated (warning) or unevaluable (info).',
  severity: 'warning',
  run(model) {
    const mk = diagBuilder(this.id, this.severity);
    const out: Diagnostic[] = [];
    for (const check of checkConstraints(model)) {
      const el = model.get(check.id);
      if (!el || isLibraryElement(el)) continue;
      if (isNonNormativeStatement(model, el.id)) continue;
      if (check.result === 'violated') {
        out.push(mk(check.message, check.id, 'warning'));
      } else if (check.result === 'unknown') {
        out.push(
          mk(`Constraint could not be evaluated ("${check.expression}"): ${check.message}.`, check.id, 'info'),
        );
      }
    }
    return out;
  },
};

/**
 * (16) A feature typed by an ISQ quantity kind whose value carries a unit of a
 * DIFFERENT physical dimension — e.g. a `mass : MassValue = 5 [m]` (mass typed,
 * but valued in metres). Compares the quantity-kind dimension (from
 * {@link quantityKindDimension}) against the value's unit dimension (from
 * {@link dimensionOf}); flagged only when BOTH are known and differ.
 */
/**
 * A value whose `[unit]` the registry cannot resolve.
 *
 * `dimensional-consistency` skips a feature whose unit dimension is unknown, so
 * an unregistered unit — `[Wh]` before it was added, `[furlong]`, a typo — was
 * SILENTLY exempt from every check, and the unit-aware evaluator then treated
 * the value as a bare number in arithmetic. Say so instead.
 *
 * A unit written INSIDE an expression — a constraint body
 * (`{ m <= 25 [furlong] }`), a transition guard, an expression value — is the
 * spec's `'['` operator; KerML's textual grammar (note 2 on BracketExpression)
 * asks a tool to warn when it is used with no concrete definition, which is
 * what an unregistered unit is here. Those texts are scanned too.
 */
const unknownUnit: ValidationRule = {
  id: 'unknown-unit',
  description: "A value, expression or guard carries a unit symbol the unit registry does not know.",
  severity: 'warning',
  run(model) {
    const mk = diagBuilder(this.id, this.severity);
    const out: Diagnostic[] = [];
    for (const el of model.all()) {
      if (isLibraryElement(el)) continue;
      const reported = new Set<string>();
      const facets = dimensionalFacets(model, el.id);
      if (facets.unit && !facets.unitDimension) {
        reported.add(facets.unit);
        out.push(
          mk(
            `${label(model, el)} has value unit "${facets.unit}", which the unit registry does not know; no dimensional check or conversion can be applied to it.`,
            el.id,
          ),
        );
      }
      // Expression texts: the constraint/guard bodies, and a value that is an
      // expression rather than a literal (a literal's unit is `facets.unit`).
      const texts: string[] = [];
      const expression = asString(el.attrs.expression);
      if (expression) texts.push(expression);
      const guard = asString(el.attrs.guard);
      if (guard) texts.push(guard);
      // A quoted string value is text, and its brackets are text too
      // (`"see table [3]"`, `"R-UAV-001 [rev A]"`): never a unit reference.
      const value = asString(el.attrs.value)?.trim();
      const isStringLiteral =
        value !== undefined &&
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")));
      if (
        value &&
        !isStringLiteral &&
        !/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?\s*(?:\[[^\]]*\])?$/.test(value)
      ) {
        texts.push(value);
      }
      for (const text of texts) {
        for (const unit of unitRefsIn(text)) {
          if (reported.has(unit) || resolveUnitRef(unit)) continue;
          reported.add(unit);
          out.push(
            mk(
              `${label(model, el)} uses unit "[${unit}]" in its expression, which the unit registry does not know; the expression cannot be evaluated.`,
              el.id,
            ),
          );
        }
      }
    }
    return out;
  },
};

/**
 * (17) An expression-valued feature whose DERIVED dimension disagrees with its
 * declared type: a `Real` computed from dimensioned quantities (the hand-rolled
 * conversion `… / cruisePower * 60.0`, which derives to seconds while the author
 * means minutes), or an ISQ kind whose derivation has another dimension. Such
 * a feature is excluded from unit-aware constraint evaluation — a constraint
 * that reads it answers unknown — and this rule is the reason the author sees.
 * A LITERAL with a unit of the wrong dimension is `dimensional-consistency`'s.
 */
const derivedDimensionMismatch: ValidationRule = {
  id: 'derived-dimension-mismatch',
  description: "An expression-valued feature's derived dimension disagrees with its declared type.",
  severity: 'warning',
  run(model) {
    const mk = diagBuilder(this.id, this.severity);
    const out: Diagnostic[] = [];
    // One derivation cache for the whole sweep: a chain of shared derivations
    // is re-evaluated per reference path otherwise, exponentially.
    const memo: DerivationMemo = new Map();
    for (const el of model.all()) {
      if (isLibraryElement(el)) continue;
      if (typeof el.attrs.value !== 'string') continue;
      const d = dimensionClaimDetail(model, el.id, memo);
      if (d.claim !== 'mismatch' || !d.derived) continue;
      // A unit beside the value is judged by `dimensional-consistency`.
      if (dimensionalFacets(model, el.id).unitDimension) continue;
      const typeName = d.typeName ?? '?';
      const why = d.declared
        ? `the declared kind "${typeName}" is ${dimToString(d.declared)}`
        : `"${typeName}" is a pure number, not a quantity`;
      out.push(
        mk(
          `${label(model, el)} is typed "${typeName}" but its value derives to dimension ${dimToString(
            d.derived,
          )} — ${why}; it is excluded from unit-aware constraint evaluation.`,
          el.id,
        ),
      );
    }
    return out;
  },
};

const dimensionalConsistency: ValidationRule = {
  id: 'dimensional-consistency',
  description: "Feature's value unit has a different physical dimension than its ISQ quantity kind.",
  severity: 'warning',
  run(model) {
    const mk = diagBuilder(this.id, this.severity);
    const out: Diagnostic[] = [];
    for (const el of model.all()) {
      if (isLibraryElement(el)) continue;
      const facets = dimensionalFacets(model, el.id);
      if (!facets.unitDimension || !facets.kindDimension) continue;
      if (dimEqual(facets.unitDimension, facets.kindDimension)) continue;
      out.push(
        mk(
          `${label(model, el)} is typed by quantity kind "${facets.kindName ?? '?'}" (${dimToString(
            facets.kindDimension,
          )}) but its value's unit "${facets.unit}" has dimension ${dimToString(facets.unitDimension)}.`,
          el.id,
        ),
      );
    }
    return out;
  },
};

/* ──────────────────────────────── registry ─────────────────────────────── */

/** The ordered list of all built-in validation rules. */
/**
 * An `import` naming a namespace that is not present in the model.
 *
 * Silence here is expensive for an agent: an import that resolves to nothing
 * changes what every unqualified name in the file can see, and the agent has no
 * way to discover that its import did nothing. Library imports are exempt (the
 * bundled library imports across packages that conversion may not have carried).
 */
const unresolvedImport: ValidationRule = {
  id: 'unresolved-import',
  description: 'An import names a namespace that is not present in the model.',
  severity: 'warning',
  run(model) {
    const diag = diagBuilder('unresolved-import', 'warning');
    const out: Diagnostic[] = [];
    for (const el of model.all()) {
      if (isLibraryElement(el)) continue;
      if (el.eClass !== 'NamespaceImport' && el.eClass !== 'MembershipImport') continue;
      const raw = el.attrs.importedName;
      if (typeof raw !== 'string' || raw.trim() === '') continue;
      // Strip the wildcard suffix: `Pkg::*` and `Pkg::**` both import `Pkg`.
      // Bound by the binder (target set) — or, at parse time before the library
      // is loaded, resolvable by name. Either is enough.
      if ((el.target ?? []).length > 0) continue;
      const target = raw.replace(/::\*+\s*$/, '').trim();
      if (target === '') continue;
      if (model.resolveQualifiedName(target)) continue;
      if (findLibraryType(model, target)) continue;
      out.push(diag(`Unresolved import "${raw}" — no such namespace is loaded.`, el.id));
    }
    return out;
  },
};

/**
 * A note body — or a requirement statement — the notation cannot write back.
 *
 * `doc`, `comment` and `rep` bodies, and the `doc` line a requirement's
 * statement is written as, are emitted with NO escaping, and the grammar gives
 * their delimiter no escape sequence at all (see `semantics/notes.ts`, which
 * also records the one other verbatim-written string this rule does not cover).
 * A body carrying the closing delimiter used to be
 * written out verbatim: it closed the note early and the rest of the value came
 * back as DECLARATIONS — a requirement statement grew a `Satisfy` nobody wrote,
 * and the second save promoted the mis-parse into the canonical form.
 *
 * The UI write paths refuse such a value now, so this reports what reached the
 * model another way (the element-graph API, a hand-written model JSON) BEFORE a
 * save runs into it. It is an error, not a warning: the file cannot be written
 * at all while it stands.
 */
const unwritableNoteBody: ValidationRule = {
  id: 'unwritable-note-body',
  description: 'A note body (or requirement statement) contains the sequence that ends a note.',
  severity: 'error',
  run(model) {
    const mk = diagBuilder(this.id, this.severity);
    const out: Diagnostic[] = [];
    for (const el of model.all()) {
      if (isLibraryElement(el)) continue;
      // Exactly the attributes the serializer writes between note delimiters:
      // a `body` on the three annotation metaclasses, and a REQUIREMENT's
      // statement. `attrs.text` on anything else is never emitted as a note, so
      // reporting it would be a finding with no defect behind it.
      const key = NOTE_BODY_KINDS.has(el.eClass)
        ? 'body'
        : isRequirement(el.eClass)
          ? 'text'
          : undefined;
      if (key === undefined) continue;
      const value = el.attrs[key];
      if (isWritableNoteBody(value)) continue;
      out.push(
        mk(
          `The ${key === 'text' ? 'statement' : 'note body'} on ${label(model, el)} contains ` +
            `"${NOTE_BODY_TERMINATOR}", which would close the note it is written into and turn ` +
            `the rest of the text into declarations.`,
          el.id,
        ),
      );
    }
    return out;
  },
};

export const RULES: ValidationRule[] = [
  duplicateName,
  unresolvedImport,
  blankName,
  danglingEndpoint,
  unresolvedTypeRef,
  portDirection,
  splitDeclaration,
  connectionCompatibility,
  malformedMultiplicity,
  connectorEndpoints,
  requirementSubject,
  redefinitionTarget,
  containmentCycle,
  specializationCycle,
  orphanRelationship,
  featureTypingNonType,
  connectorEndNotFeature,
  valueTypeMismatch,
  redefinitionConformance,
  constraintViolation,
  dimensionalConsistency,
  unknownUnit,
  derivedDimensionMismatch,
  unwritableNoteBody,
];

/** Rule lookup by id. */
export const RULES_BY_ID: ReadonlyMap<string, ValidationRule> = new Map(
  RULES.map((r) => [r.id, r]),
);

/** All rule ids (stable order). */
export const RULE_IDS: string[] = RULES.map((r) => r.id);
