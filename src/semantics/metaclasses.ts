/**
 * The KerML + SysML v2 **metaclass generalization hierarchy**, encoded as data.
 *
 * The OMG abstract syntax organises every metaclass into a single-rooted
 * generalization lattice under `Element`. This module captures that lattice as a
 * map from each metaclass name to its DIRECT metaclass supertypes, then exposes
 * two pure queries over its reflexive-transitive closure:
 *
 *  - {@link isKindOf} — is `metaclass` the same as, or a (transitive) subtype of,
 *    `superMetaclass`? (e.g. `PartUsage` is a kind of `Usage`, `Feature`, `Type`
 *    and `Element`, but NOT a kind of `Relationship`.)
 *  - {@link metaclassChain} — the metaclass and all its supertypes, nearest
 *    first, ending at `Element`.
 *
 * Faithfulness / scope notes:
 *  - The map covers every metaclass named in the metamodel catalogues
 *    (`ALL_METACLASSES` = Definitions + Usages + control nodes + annotations +
 *    relationships) PLUS the abstract KerML roots they generalize through
 *    (`Element`, `Namespace`, `Type`, `Classifier`, `Feature`, `Definition`,
 *    `Usage`, `OccurrenceDefinition`, `OccurrenceUsage`, …) AND the concrete
 *    KerML metaclasses the bundled library uses for its own types (`DataType`,
 *    `Class`, `Structure`, `Behavior`, `Function`, `Predicate`, `Interaction`,
 *    `Association`, `Metaclass`, `Step`, `Connector`, `BindingConnector`), so the
 *    queries answer correctly for user AND library elements.
 *  - Where the SysML abstract syntax gives a metaclass several supertypes (e.g.
 *    `ItemDefinition` ▸ `OccurrenceDefinition` and `Structure`; `Connector` ▸
 *    `Feature` and `Relationship`), all direct supertypes are recorded.
 *  - Both queries are cycle-safe (the data is acyclic, but the walk guards
 *    against accidental loops) and never allocate beyond the visited chain.
 *
 * Spec references: docs/02-omg-standard-reference.md (KerML classification,
 * specialization & featuring; SysML Definition/Usage layering).
 */

/**
 * Direct metaclass supertypes for every metaclass, following the OMG abstract
 * syntax. `Element` is the root and therefore has no entry / an empty list.
 */
export const DIRECT_SUPERTYPES: Readonly<Record<string, readonly string[]>> = {
  /* ── KerML kernel roots ─────────────────────────────────────────────── */
  Element: [],
  Relationship: ['Element'],
  Namespace: ['Element'],
  Type: ['Namespace'],
  Classifier: ['Type'],
  Feature: ['Type'],

  // Concrete KerML classifiers (used by the bundled library data).
  DataType: ['Classifier'],
  Class: ['Classifier'],
  Structure: ['Class'],
  Behavior: ['Class'],
  Function: ['Behavior'],
  Predicate: ['Function'],
  Association: ['Classifier', 'Relationship'],
  Interaction: ['Behavior', 'Association'],
  Metaclass: ['Structure'],

  // Concrete KerML features (used by the bundled library data).
  Step: ['Feature'],
  Connector: ['Feature', 'Relationship'],
  BindingConnector: ['Connector'],

  /* ── SysML Definition/Usage roots ───────────────────────────────────── */
  Definition: ['Classifier'],
  Usage: ['Feature'],

  /* ── Packages ───────────────────────────────────────────────────────── */
  Package: ['Namespace'],
  LibraryPackage: ['Package'],

  /* ── Occurrences (base of the structural + behavioral towers) ───────── */
  OccurrenceDefinition: ['Definition', 'Class'],
  OccurrenceUsage: ['Usage'],

  /* ── Items & Parts ──────────────────────────────────────────────────── */
  ItemDefinition: ['OccurrenceDefinition', 'Structure'],
  ItemUsage: ['OccurrenceUsage'],
  PartDefinition: ['ItemDefinition'],
  PartUsage: ['ItemUsage'],

  /* ── Attributes & Enumerations (value types) ────────────────────────── */
  AttributeDefinition: ['Definition', 'DataType'],
  AttributeUsage: ['Usage'],
  EnumerationDefinition: ['AttributeDefinition'],
  EnumerationUsage: ['AttributeUsage'],

  /* ── Ports ──────────────────────────────────────────────────────────── */
  PortDefinition: ['OccurrenceDefinition', 'Structure'],
  PortUsage: ['OccurrenceUsage'],

  /* ── Connections, Interfaces, Flows ─────────────────────────────────── */
  ConnectionDefinition: ['PartDefinition', 'Association'],
  ConnectionUsage: ['PartUsage', 'Connector'],
  InterfaceDefinition: ['ConnectionDefinition'],
  InterfaceUsage: ['ConnectionUsage'],
  FlowDefinition: ['ConnectionDefinition'],
  FlowUsage: ['ConnectionUsage'],
  BindingConnectorAsUsage: ['ConnectionUsage'],

  /* ── Actions & States (behavioral tower) ────────────────────────────── */
  ActionDefinition: ['OccurrenceDefinition', 'Behavior'],
  ActionUsage: ['OccurrenceUsage', 'Step'],
  StateDefinition: ['ActionDefinition'],
  StateUsage: ['ActionUsage'],

  // Action-usage specialisations.
  TransitionUsage: ['ActionUsage'],
  AcceptActionUsage: ['ActionUsage'],
  SendActionUsage: ['ActionUsage'],
  AssignmentActionUsage: ['ActionUsage'],
  IfActionUsage: ['ActionUsage'],
  WhileLoopActionUsage: ['ActionUsage'],
  ForLoopActionUsage: ['ActionUsage'],
  PerformActionUsage: ['ActionUsage'],
  ExhibitStateUsage: ['StateUsage'],

  /* ── Calculations & Constraints (functional tower) ──────────────────── */
  CalculationDefinition: ['ActionDefinition', 'Function'],
  CalculationUsage: ['ActionUsage'],
  ConstraintDefinition: ['CalculationDefinition', 'Predicate'],
  ConstraintUsage: ['CalculationUsage'],

  /* ── Requirements & Concerns ────────────────────────────────────────── */
  RequirementDefinition: ['ConstraintDefinition'],
  RequirementUsage: ['ConstraintUsage'],
  ConcernDefinition: ['RequirementDefinition'],
  ConcernUsage: ['RequirementUsage'],
  SatisfyRequirementUsage: ['RequirementUsage'],

  /* ── Cases (analysis / verification / use case) ─────────────────────── */
  CaseDefinition: ['CalculationDefinition'],
  CaseUsage: ['CalculationUsage'],
  AnalysisCaseDefinition: ['CaseDefinition'],
  AnalysisCaseUsage: ['CaseUsage'],
  VerificationCaseDefinition: ['CaseDefinition'],
  VerificationCaseUsage: ['CaseUsage'],
  UseCaseDefinition: ['CaseDefinition'],
  UseCaseUsage: ['CaseUsage'],
  IncludeUseCaseUsage: ['UseCaseUsage'],

  /* ── Views, Viewpoints, Renderings ──────────────────────────────────── */
  ViewDefinition: ['PartDefinition'],
  ViewUsage: ['PartUsage'],
  ViewpointDefinition: ['RequirementDefinition'],
  ViewpointUsage: ['RequirementUsage'],
  RenderingDefinition: ['PartDefinition'],
  RenderingUsage: ['PartUsage'],

  /* ── Metadata ───────────────────────────────────────────────────────── */
  MetadataDefinition: ['ItemDefinition', 'Metaclass'],
  MetadataUsage: ['ItemUsage'],

  /* ── Reference usage ────────────────────────────────────────────────── */
  ReferenceUsage: ['Usage'],

  /* ── Control nodes (action-flow features) ───────────────────────────── */
  ControlNode: ['ActionUsage'],
  InitialNode: ['ControlNode'],
  MergeNode: ['ControlNode'],
  DecisionNode: ['ControlNode'],
  ForkNode: ['ControlNode'],
  JoinNode: ['ControlNode'],
  DoneNode: ['ControlNode'],

  /* ── Memberships (containment relationships) ────────────────────────── */
  Membership: ['Relationship'],
  OwningMembership: ['Membership'],
  FeatureMembership: ['OwningMembership'],
  VariantMembership: ['OwningMembership'],
  FeatureValue: ['OwningMembership'],
  ElementFilterMembership: ['OwningMembership'],
  // Feature-membership variants carrying parameters / results / ends.
  EndFeatureMembership: ['FeatureMembership'],
  ParameterMembership: ['FeatureMembership'],
  ReturnParameterMembership: ['ParameterMembership'],
  ResultExpressionMembership: ['FeatureMembership'],
  // SysML-layer feature-membership variants.
  ObjectiveMembership: ['FeatureMembership'],
  SubjectMembership: ['ParameterMembership'],
  ActorMembership: ['ParameterMembership'],
  StakeholderMembership: ['ParameterMembership'],
  RequirementConstraintMembership: ['FeatureMembership'],
  FramedConcernMembership: ['RequirementConstraintMembership'],
  RequirementVerificationMembership: ['RequirementConstraintMembership'],
  StateSubactionMembership: ['FeatureMembership'],
  TransitionFeatureMembership: ['FeatureMembership'],
  ViewRenderingMembership: ['FeatureMembership'],

  /* ── Specialization family ──────────────────────────────────────────── */
  Specialization: ['Relationship'],
  Subclassification: ['Specialization'],
  FeatureTyping: ['Specialization'],
  Subsetting: ['Specialization'],
  Redefinition: ['Subsetting'],
  ReferenceSubsetting: ['Subsetting'],
  Conjugation: ['Relationship'],

  // Featuring & the remaining KerML type-relationship family. These relate a
  // Type to another Type/Feature without being classical Specializations.
  Featuring: ['Relationship'],
  TypeFeaturing: ['Featuring'],
  FeatureChaining: ['Relationship'],
  FeatureInverting: ['Relationship'],
  Unioning: ['Relationship'],
  Intersecting: ['Relationship'],
  Differencing: ['Relationship'],
  Disjoining: ['Relationship'],

  /* ── Multiplicities ─────────────────────────────────────────────────── */
  Multiplicity: ['Feature'],
  MultiplicityRange: ['Multiplicity'],

  /* ── Imports ────────────────────────────────────────────────────────── */
  Import: ['Relationship'],
  NamespaceImport: ['Import'],
  MembershipImport: ['Import'],
  Expose: ['MembershipImport'],

  /* ── Dependency-family & cross-cutting relationships ────────────────── */
  Dependency: ['Relationship'],
  Allocation: ['Dependency'],
  Trace: ['Dependency'],
  Refine: ['Dependency'],
  Satisfy: ['Dependency'],
  Verify: ['Dependency'],
  Derive: ['Dependency'],

  /* ── Connector-family features (KerML Connector ▸ Feature, Relationship) ── */
  Succession: ['Connector'],
  Flow: ['Connector'],
  SuccessionFlow: ['Flow', 'Succession'],
  // KerML spec names for item flows (the library uses the shorter Flow forms).
  ItemFlow: ['Connector', 'Step'],
  SuccessionItemFlow: ['ItemFlow', 'Succession'],
  TransitionFeature: ['Relationship'],

  /* ── Expressions (KerML functional tower: Expression ▸ Step ▸ Feature) ── */
  Expression: ['Step'],
  InvocationExpression: ['Expression'],
  OperatorExpression: ['InvocationExpression'],
  FeatureChainExpression: ['OperatorExpression'],
  CollectExpression: ['OperatorExpression'],
  SelectExpression: ['OperatorExpression'],
  FeatureReferenceExpression: ['Expression'],
  MetadataAccessExpression: ['Expression'],
  NullExpression: ['Expression'],
  LiteralExpression: ['Expression'],
  LiteralBoolean: ['LiteralExpression'],
  LiteralString: ['LiteralExpression'],
  LiteralInteger: ['LiteralExpression'],
  LiteralRational: ['LiteralExpression'],
  LiteralInfinity: ['LiteralExpression'],

  /* ── Additional KerML classifiers used by the library ───────────────── */
  AssociationStructure: ['Association', 'Structure'],

  /* ── SysML Definition/Usage kinds not covered above ─────────────────── */
  AllocationDefinition: ['ConnectionDefinition'],
  AllocationUsage: ['ConnectionUsage'],
  AssertConstraintUsage: ['ConstraintUsage'],
  ConjugatedPortDefinition: ['PortDefinition'],
  EventOccurrenceUsage: ['OccurrenceUsage'],
  SuccessionAsUsage: ['ConnectionUsage', 'Succession'],

  /* ── Annotations ────────────────────────────────────────────────────── */
  AnnotatingElement: ['Element'],
  Comment: ['AnnotatingElement'],
  Documentation: ['Comment'],
  TextualRepresentation: ['AnnotatingElement'],
  MetadataFeature: ['AnnotatingElement', 'Feature'],
};

/**
 * The metaclass and all its supertypes, nearest first (breadth-first over the
 * generalization lattice), ending at the root `Element`. The metaclass itself is
 * always the first entry; each metaclass appears exactly once (a shared ancestor
 * reached by several paths is listed at its shallowest depth). Unknown
 * metaclasses yield a single-element chain `[metaclass]`.
 */
export function metaclassChain(metaclass: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let frontier: string[] = [metaclass];
  while (frontier.length) {
    const next: string[] = [];
    for (const mc of frontier) {
      if (seen.has(mc)) continue;
      seen.add(mc);
      out.push(mc);
      const supers = DIRECT_SUPERTYPES[mc];
      if (supers) for (const s of supers) if (!seen.has(s)) next.push(s);
    }
    frontier = next;
  }
  return out;
}

/**
 * True iff `metaclass` is the same as, or a reflexive-transitive subtype of,
 * `superMetaclass` in the OMG metaclass generalization lattice. Cycle-safe.
 */
export function isKindOf(metaclass: string, superMetaclass: string): boolean {
  if (metaclass === superMetaclass) return true;
  const seen = new Set<string>([metaclass]);
  const stack = [...(DIRECT_SUPERTYPES[metaclass] ?? [])];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === superMetaclass) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const supers = DIRECT_SUPERTYPES[cur];
    if (supers) for (const s of supers) if (!seen.has(s)) stack.push(s);
  }
  return false;
}

/** True when `metaclass` is (a kind of) a KerML `Feature` — carries features. */
export const isFeatureMetaclass = (metaclass: string): boolean =>
  isKindOf(metaclass, 'Feature');

/** True when `metaclass` is (a kind of) a KerML `Type` (Classifier or Feature). */
export const isTypeMetaclass = (metaclass: string): boolean => isKindOf(metaclass, 'Type');
