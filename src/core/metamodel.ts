/**
 * SysML v2 / KerML abstract-syntax metamodel (pragmatic browser subset).
 *
 * This module is the SHARED CONTRACT for the whole modeler. Every other module
 * (text parser, API/SDK, validation, diagram, UI) builds against the types and
 * constants defined here. It is intentionally faithful to the OMG SysML v2
 * abstract syntax (KerML kernel + SysML layer) while staying ergonomic enough
 * to implement and unit-test in a browser without a server.
 *
 * Faithfulness notes:
 *  - In KerML, every Relationship IS an Element. We model that with a single
 *    {@link ElementRecord} type carrying optional `source`/`target` endpoint
 *    arrays (populated only for relationship metaclasses).
 *  - Containment (ownership) is denormalised onto `ownerId` for fast traversal,
 *    but is also recoverable as OwningMembership/FeatureMembership relationships
 *    when serialising to the OMG API JSON shape (see api/ serializer).
 *  - `eClass` is the metaclass name (e.g. 'PartUsage'). We keep it a string so
 *    new metaclasses can be added without editing a closed union, but every
 *    known metaclass is enumerated in the constant arrays below for palettes,
 *    validation and parsing.
 *
 * Spec references: see docs/02-omg-standard-reference.md (KerML, SysML v2
 * textual & graphical notation, API & Services).
 */

export type ElementId = string;

/** Primitive attribute values stored on an element's `attrs` bag. */
export type AttrValue =
  | string
  | number
  | boolean
  | null
  | ElementId
  | string[]
  | Record<string, unknown>;

/**
 * The single uniform record for every model element (including relationships).
 * Relationship metaclasses additionally populate `source` and `target`.
 */
export interface ElementRecord {
  /** Stable, globally-unique element identifier (UUID-like). */
  id: ElementId;
  /** Metaclass name, e.g. 'PartUsage', 'PartDefinition', 'FeatureTyping'. */
  eClass: string;
  /** User-declared name (may be undefined for anonymous features). */
  declaredName?: string;
  /** User-declared short name (the `<short>` alias). */
  declaredShortName?: string;
  /** Owning element id (containment); null for root-level elements. */
  ownerId: ElementId | null;
  /** Metaclass-specific attributes (direction, multiplicity, value, …). */
  attrs: Record<string, AttrValue>;
  /** Relationship source endpoints (only for relationship metaclasses). */
  source?: ElementId[];
  /** Relationship target endpoints (only for relationship metaclasses). */
  target?: ElementId[];
}

/** A serialised, plain-JSON snapshot of an entire model/project. */
export interface SerializedModel {
  formatVersion: string;
  /** Tool that produced this snapshot. */
  generator?: string;
  /** Flat list of all element records. */
  elements: ElementRecord[];
  /** Ids of the top-level (root) elements, in declaration order. */
  rootIds: ElementId[];
  /** Optional project metadata. */
  meta?: Record<string, unknown>;
}

/* ───────────────────────── Metaclass catalogues ───────────────────────── */

/** SysML v2 *Definition* metaclasses (the type/library layer). */
export const DEFINITION_KINDS = [
  'Package',
  'LibraryPackage',
  'PartDefinition',
  'AttributeDefinition',
  'ItemDefinition',
  'PortDefinition',
  'ConnectionDefinition',
  'InterfaceDefinition',
  'FlowDefinition',
  'ActionDefinition',
  'StateDefinition',
  'CalculationDefinition',
  'ConstraintDefinition',
  'RequirementDefinition',
  'ConcernDefinition',
  'CaseDefinition',
  'AnalysisCaseDefinition',
  'VerificationCaseDefinition',
  'UseCaseDefinition',
  'ViewDefinition',
  'ViewpointDefinition',
  'RenderingDefinition',
  'MetadataDefinition',
  'EnumerationDefinition',
  'OccurrenceDefinition',
] as const;

/** SysML v2 *Usage* metaclasses (the instance/feature layer). */
export const USAGE_KINDS = [
  'PartUsage',
  'AttributeUsage',
  'ItemUsage',
  'PortUsage',
  'ReferenceUsage',
  'ConnectionUsage',
  'InterfaceUsage',
  'FlowUsage',
  'BindingConnectorAsUsage',
  'ActionUsage',
  'StateUsage',
  'CalculationUsage',
  'ConstraintUsage',
  'RequirementUsage',
  'ConcernUsage',
  'CaseUsage',
  'AnalysisCaseUsage',
  'VerificationCaseUsage',
  'UseCaseUsage',
  'ViewUsage',
  'ViewpointUsage',
  'EnumerationUsage',
  'OccurrenceUsage',
  'SatisfyRequirementUsage',
  'TransitionUsage',
  'AcceptActionUsage',
  'SendActionUsage',
  'AssignmentActionUsage',
  'IfActionUsage',
  'WhileLoopActionUsage',
  'ForLoopActionUsage',
  'PerformActionUsage',
  'ExhibitStateUsage',
  'IncludeUseCaseUsage',
] as const;

/** Control nodes (action & state machine flow). */
export const CONTROL_NODE_KINDS = [
  'InitialNode',
  'MergeNode',
  'DecisionNode',
  'ForkNode',
  'JoinNode',
  'DoneNode',
] as const;

/** Relationship metaclasses (every one is itself an Element in KerML). */
export const RELATIONSHIP_KINDS = [
  // Memberships (containment)
  'OwningMembership',
  'FeatureMembership',
  'Membership',
  'VariantMembership',
  // Specialization family
  'Specialization',
  'Subclassification',
  'FeatureTyping',
  'Subsetting',
  'Redefinition',
  'ReferenceSubsetting',
  'Conjugation',
  // Cross-cutting / SysML relationships
  'Dependency',
  'Allocation',
  'Connector',
  'Succession',
  'Flow',
  'SuccessionFlow',
  'TransitionFeature',
  'Satisfy',
  'Verify',
  'Refine',
  'Expose',
  'Trace',
  'Derive',
  // Feature value / expression
  'FeatureValue',
  'ResultExpressionMembership',
  // Imports
  'NamespaceImport',
  'MembershipImport',
] as const;

/** Requirement metaclasses (finding L11 — canonical set). */
export const REQUIREMENT_KINDS = ['RequirementUsage', 'RequirementDefinition'] as const;
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];

/** Documentation / annotation metaclasses. */
export const ANNOTATION_KINDS = [
  'Comment',
  'Documentation',
  'TextualRepresentation',
  'MetadataUsage',
] as const;

export type DefinitionKind = (typeof DEFINITION_KINDS)[number];
export type UsageKind = (typeof USAGE_KINDS)[number];
export type ControlNodeKind = (typeof CONTROL_NODE_KINDS)[number];
export type RelationshipKind = (typeof RELATIONSHIP_KINDS)[number];
export type AnnotationKind = (typeof ANNOTATION_KINDS)[number];

const DEFINITION_SET = new Set<string>(DEFINITION_KINDS);
const USAGE_SET = new Set<string>(USAGE_KINDS);
const CONTROL_NODE_SET = new Set<string>(CONTROL_NODE_KINDS);
const RELATIONSHIP_SET = new Set<string>(RELATIONSHIP_KINDS);
const REQUIREMENT_SET = new Set<string>(REQUIREMENT_KINDS);
const ANNOTATION_SET = new Set<string>(ANNOTATION_KINDS);

export const ALL_NODE_KINDS: string[] = [
  ...DEFINITION_KINDS,
  ...USAGE_KINDS,
  ...CONTROL_NODE_KINDS,
  ...ANNOTATION_KINDS,
];

export const ALL_METACLASSES: string[] = [...ALL_NODE_KINDS, ...RELATIONSHIP_KINDS];

/* ───────────────────────── Metaclass predicates ───────────────────────── */

export const isDefinition = (eClass: string): boolean => DEFINITION_SET.has(eClass);
export const isUsage = (eClass: string): boolean => USAGE_SET.has(eClass);
export const isControlNode = (eClass: string): boolean => CONTROL_NODE_SET.has(eClass);
export const isRequirement = (eClass: string): boolean => REQUIREMENT_SET.has(eClass);
export const isRelationship = (eClass: string): boolean => RELATIONSHIP_SET.has(eClass);
export const isAnnotation = (eClass: string): boolean => ANNOTATION_SET.has(eClass);
/** A "node" is anything that is not a relationship (renders as a box/shape). */
export const isNode = (eClass: string): boolean => !RELATIONSHIP_SET.has(eClass);

/** Specialization-family relationship metaclasses (typing/generalization). */
const SPECIALIZATION_SET = new Set<string>([
  'Specialization',
  'Subclassification',
  'FeatureTyping',
  'Subsetting',
  'Redefinition',
  'ReferenceSubsetting',
  'Conjugation',
]);
export const isSpecialization = (eClass: string): boolean => SPECIALIZATION_SET.has(eClass);

/**
 * True typing/generalization kinds — relationships that make one element an
 * instance of another. Conjugation and ReferenceSubsetting are excluded
 * (finding H7): a conjugated or `::>`-referenced element is not a general type
 * of its source, and including them skewed `typesOf` for the inheritance,
 * solving and conformance machinery.
 *
 * Redefinition IS kept: a redefining feature inherits its type through the
 * redefined feature, and the implicit-feature materialisation (`connect a.p to
 * b.p`) links each implicit usage-scoped feature to its type-owned prototype
 * with a Redefinition — so `typeClosure` must walk through it.
 */
const TYPING_SET = new Set<string>([
  'Specialization',
  'Subclassification',
  'FeatureTyping',
  'Subsetting',
  'Redefinition',
]);
export const isTypingSpecialization = (eClass: string): boolean => TYPING_SET.has(eClass);

const MEMBERSHIP_SET = new Set<string>([
  'OwningMembership',
  'FeatureMembership',
  'Membership',
  'VariantMembership',
]);
export const isMembership = (eClass: string): boolean => MEMBERSHIP_SET.has(eClass);

/**
 * Map a Usage metaclass to its corresponding Definition metaclass (and back).
 * Used by the parser and the "create definition from usage" command.
 */
export const USAGE_TO_DEFINITION: Record<string, string> = {
  PartUsage: 'PartDefinition',
  AttributeUsage: 'AttributeDefinition',
  ItemUsage: 'ItemDefinition',
  PortUsage: 'PortDefinition',
  ConnectionUsage: 'ConnectionDefinition',
  InterfaceUsage: 'InterfaceDefinition',
  FlowUsage: 'FlowDefinition',
  ActionUsage: 'ActionDefinition',
  StateUsage: 'StateDefinition',
  CalculationUsage: 'CalculationDefinition',
  ConstraintUsage: 'ConstraintDefinition',
  RequirementUsage: 'RequirementDefinition',
  ConcernUsage: 'ConcernDefinition',
  CaseUsage: 'CaseDefinition',
  AnalysisCaseUsage: 'AnalysisCaseDefinition',
  VerificationCaseUsage: 'VerificationCaseDefinition',
  UseCaseUsage: 'UseCaseDefinition',
  ViewUsage: 'ViewDefinition',
  ViewpointUsage: 'ViewpointDefinition',
  EnumerationUsage: 'EnumerationDefinition',
  OccurrenceUsage: 'OccurrenceDefinition',
};

export const DEFINITION_TO_USAGE: Record<string, string> = Object.fromEntries(
  Object.entries(USAGE_TO_DEFINITION).map(([u, d]) => [d, u]),
);

/** Port/flow direction. */
export type FeatureDirection = 'in' | 'out' | 'inout';

/** Built-in primitive attribute types from the SysML standard library. */
export const PRIMITIVE_TYPES = [
  'String',
  'Integer',
  'Real',
  'Rational',
  'Natural',
  'Boolean',
  'NumericalValue',
] as const;
export type PrimitiveType = (typeof PRIMITIVE_TYPES)[number];

/**
 * Human-readable keyword used in the textual notation for each metaclass,
 * e.g. 'PartDefinition' → 'part def', 'PartUsage' → 'part'. Drives both the
 * parser (keyword → metaclass) and the serializer (metaclass → keyword).
 */
export const TEXTUAL_KEYWORD: Record<string, string> = {
  Package: 'package',
  LibraryPackage: 'library package',
  PartDefinition: 'part def',
  PartUsage: 'part',
  AttributeDefinition: 'attribute def',
  AttributeUsage: 'attribute',
  ItemDefinition: 'item def',
  ItemUsage: 'item',
  PortDefinition: 'port def',
  PortUsage: 'port',
  ConnectionDefinition: 'connection def',
  ConnectionUsage: 'connection',
  InterfaceDefinition: 'interface def',
  InterfaceUsage: 'interface',
  FlowDefinition: 'flow def',
  FlowUsage: 'flow',
  MetadataDefinition: 'metadata def',
  MetadataUsage: 'metadata',
  ActionDefinition: 'action def',
  ActionUsage: 'action',
  StateDefinition: 'state def',
  StateUsage: 'state',
  CalculationDefinition: 'calc def',
  CalculationUsage: 'calc',
  ConstraintDefinition: 'constraint def',
  ConstraintUsage: 'constraint',
  RequirementDefinition: 'requirement def',
  RequirementUsage: 'requirement',
  ConcernDefinition: 'concern def',
  ConcernUsage: 'concern',
  CaseDefinition: 'case def',
  CaseUsage: 'case',
  AnalysisCaseDefinition: 'analysis def',
  AnalysisCaseUsage: 'analysis',
  VerificationCaseDefinition: 'verification def',
  VerificationCaseUsage: 'verification',
  UseCaseDefinition: 'use case def',
  UseCaseUsage: 'use case',
  ViewDefinition: 'view def',
  ViewUsage: 'view',
  ViewpointDefinition: 'viewpoint def',
  ViewpointUsage: 'viewpoint',
  // `rendering def R;` — the grammar always accepted the keyword, but without
  // this entry the mapper rejected it ("Unknown keyword") and the serializer
  // emitted the bare eClass `RenderingDefinition` (unparseable). C9-residual.
  RenderingDefinition: 'rendering def',
  // `message` / `rendering` usage keywords (F-follow-up: grammar-legal input
  // previously produced "Unknown keyword").
  MessageDefinition: 'message def',
  MessageUsage: 'message',
  RenderingUsage: 'rendering',
  EnumerationDefinition: 'enum def',
  EnumerationUsage: 'enum',
  OccurrenceDefinition: 'occurrence def',
  OccurrenceUsage: 'occurrence',
  ReferenceUsage: 'ref',
  // Requirement cross-relationship (label lookup only — the serializer emits
  // these via dedicated statement forms, never through the generic keyword path).
  Derive: 'derive',
};

/** Inverse of {@link TEXTUAL_KEYWORD}; longest keywords first for greedy match. */
export const KEYWORD_TO_METACLASS: Array<[keyword: string, eClass: string]> = Object.entries(
  TEXTUAL_KEYWORD,
)
  .map(([eClass, kw]) => [kw, eClass] as [string, string])
  .sort((a, b) => b[0].length - a[0].length);

/** Notation operators for the specialization family in the textual syntax. */
export const SPECIALIZATION_OPERATOR: Record<string, string> = {
  Subclassification: ':>',
  Subsetting: ':>',
  FeatureTyping: ':',
  Redefinition: ':>>',
  ReferenceSubsetting: '::>',
};
