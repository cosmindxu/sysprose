/**
 * Public surface of the API / SDK module (plan §4, module A).
 *
 * Three surfaces over one implementation:
 *  - {@link ModelApi}        — ergonomic in-browser TypeScript SDK.
 *  - {@link evaluateQuery}   — OMG-API-shaped constraint-tree Query engine.
 *  - analytics functions     — pure, JSON-serialisable model analysis.
 *  - {@link SysmlApiServer}  — in-process OMG REST facade.
 */

// SDK
export { ModelApi } from './sdk';
export type { TraverseDir, OmgElementJSON } from './sdk';

// Query engine
export {
  evaluateQuery,
  matchesConstraint,
  getProperty,
  modelCommitId,
} from './query';
export type {
  Query,
  QueryResult,
  Constraint,
  PrimitiveConstraint,
  CompositeConstraint,
  QueryPage,
} from './query';

// Analytics
export {
  isUserElement,
  countByMetaclass,
  modelMetrics,
  requirementSatisfaction,
  traceabilityMatrix,
  whereUsed,
  impactClosure,
  promptsFor,
  orphanReport,
  CONNECTION_KINDS,
  connectivityReport,
  constraintReport,
  executionReport,
  simulationReport,
  unitReport,
  analysisReport,
  countUnfollowedTypings,
} from './analytics';
export type {
  ElementRef,
  ModelMetrics,
  RequirementStatus,
  SatisfactionReport,
  TraceabilityMatrix,
  UsageRef,
  WhereUsedReport,
  ImpactedElement,
  ImpactReport,
  PromptRelation,
  ApplicablePrompt,
  PromptReport,
  OrphanReport,
  ConnectivityReport,
  PortOccurrence,
  ConstraintReport,
  ConstraintReportEntry,
  ExecutionReport,
  SimulationReport,
  ActionFlowRun,
  StateMachineRun,
  ExecutionStepSummary,
  PerformedActionSummary,
  UnitFeatureAnalysis,
  UnitReport,
  AnalysisReport,
  AnalysisViolation,
  AnalysisUnknown,
  SolvedValue,
} from './analytics';

// Verification lane (plan docs/04-formal-verification-plan.md §3.1, §3.2, §3.4, §3.6)
export {
  boundsReport,
  contractReport,
  // The per-element half of the keyword inventory: the app asks it about the
  // selection, through the same classifier the command uses.
  keywordUsesOf,
  keywordUsesOn,
  faultTreeReport,
  faultTreeVerdict,
  consistencyReport,
  obligationsReport,
  refinementReport,
  verifyModel,
  ALLOW_INCONCLUSIVE_CODES,
  INCONSISTENT_REQUIREMENTS_CODE,
  VERIFICATION_CODES,
  VERIFICATION_ERROR_CODES,
  VERIFICATION_WARNING_CODES,
  VerifyOptionError,
} from './verification';
export type {
  BoundsReport,
  BoundsReportOptions,
  FaultTreeReport,
  FaultTreeReportOptions,
  FaultTreeVerdict,
  ConsistencyReport,
  ConsistencyReportOptions,
  ContractReport,
  ContractReportOptions,
  KeywordOrigin,
  KeywordUse,
  ObligationReport,
  ObligationVerdict,
  RefinementReport,
  RefinementReportOptions,
  VerifyEngine,
  VerifyEngineOption,
  VerifyOptions,
  VerifyReport,
} from './verification';
// Property authoring under gates (plan §3.3). The two halves of one loop — the
// dictionary and template an agent writes a clause FROM, and the gates it is
// judged by — so both come through the barrel, which the standing rule calls the
// door: a surface an agent cannot import in process is a surface it can only
// reach by spawning a CLI.
export {
  GATE_4_LIMIT,
  MANDATORY_FIELDS,
  MEANING_LIMIT,
  MEANING_NOTICE,
  PROPERTY_CODES,
  PROPERTY_CODE_SET,
  PROPERTY_LIMITS,
  PropertyRefError,
  TEMPORAL_FIELDS,
  TEMPORAL_FRAGMENT,
  backTranslate,
  propertyCheck,
  propertyDraft,
} from './property';
export type {
  DictionaryEntry,
  FretishField,
  FretishFieldRow,
  GateResult,
  GateStatus,
  PropertyCheckReport,
  PropertyDraftReport,
  PropertyOptions,
  PropertyOutcome,
} from './property';
// The consistency engine's own payload types, so a consumer coming through
// this barrel can walk a group, a core member and a refusal without a deep
// import into the semantics layer — the same reason the contract and
// obligation types are re-exported below.
export { DEFAULT_MAX_CORE, READING, witnessNumber } from '../semantics/consistency';
// The bounds engine's own payload types, for the same reason: a consumer coming
// through this barrel walks a bound and the measure it is about without a deep
// import into the semantics layer.
export {
  AXIOMS_ONLY_NOTE,
  BOUNDS_CODES,
  OPTIMALITY_NOT_ESTABLISHED_CODE,
  WITH_REQUIREMENTS_NOTE,
} from '../semantics/bounds';
export type {
  Bound,
  BoundOutcome,
  BoundsOptions,
  BoundsResult,
  BoundsSense,
  MeasureRef,
} from '../semantics/bounds';
// The fault-tree engine's own payload types and its two composed sentences, for
// the same reason again: a consumer coming through this barrel walks a cut set,
// a basic event and the order bound it was found under without a deep import
// into the semantics layer — and the refusal sentence is composed once, where
// the rule that the two safety lanes stay apart is written down.
export {
  behaviourLaneRefusal,
  isBehaviouralElement,
  CONTRACT_LEVEL_NOTE,
  DEFAULT_MAX_ORDER,
  FAULT_TREE_CODES,
  ORDERS_NOT_EXPLORED_NOTE,
  SINGLE_POINT_OF_FAILURE_CODE,
} from '../semantics/fault-tree';
export type {
  BasicEvent,
  CutSet,
  FaultTreeGroup,
  FaultTreeOptions,
  FaultTreeOutcome,
  FaultTreeResult,
  MaxOrderSource,
  UndecidedCheck,
} from '../semantics/fault-tree';
export type {
  ConsistencyGroup,
  ConsistencyOptions,
  ConsistencyOutcome,
  ConsistencyRequirement,
  ConsistencyResult,
  ConsistencySubject,
  CoreMember,
  CoreMemberKind,
  RefusedRelation,
  UnengageableRequirement,
} from '../semantics/consistency';
// Evidence (plan §3.10). `recordEvidence` and the digests are exported because
// a record is meant to be produced, stored and re-checked by a consumer, and
// `modelVersionOf` is what tells them whether one has gone stale.
export {
  // Exported for the guard that pins WHICH elements enter the graph digest:
  // library exclusion — and, since commit 7, the exclusion of what a
  // verification run itself wrote — is invisible to any assertion over the hash.
  canonicalElements,
  isEvidenceArtefact,
  modelVersionOf,
  obligationDigest,
  recordEvidence,
  sha256Hex,
  toolVersion,
  verdictFor,
  // The file half of the lane: what is written into a model, what is read back
  // out of it, and whether it still holds (plan §3.10).
  CLAIMED_WITHOUT_EVIDENCE_CODE,
  EVIDENCE_RECORD_ATTR,
  EVIDENCE_SUMMARY_ATTRS,
  VERDICT_OVERSTATES_EVIDENCE_CODE,
  attachEvidence,
  detachEvidence,
  evidenceCarriers,
  evidenceHolders,
  evidenceOf,
  evidenceStatus,
  isEvidenceCarrier,
  liveEvidence,
  recordOfCarrier,
  summariseEvidence,
} from './evidence';
export type {
  AttachReport,
  DetachReport,
  EvidenceBound,
  EvidenceClaim,
  EvidenceHolder,
  EvidenceRecord,
  EvidenceSkip,
  EvidenceStatusReport,
  EvidenceStatusRow,
  EvidenceSummary,
  EvidenceVerdict,
  ModelVersion,
  ToolVersion,
  VerdictChange,
} from './evidence';
// The payload types both reports publish, and the options the second takes.
// A consumer coming through this barrel — which the standing rule says is the
// door — could otherwise not type either argument or walk either row without a
// deep import into the semantics layer.
export type {
  Contract,
  ContractClause,
  ContractRef,
  ContractSubject,
  ContractVariable,
  Encodable,
  Fragment,
  Refusal,
  RefusalReason,
  VariableRole,
  VarSort,
} from '../semantics/contracts';
export type {
  EvidenceRef,
  Obligation,
  ObligationOptions,
  ObligationRole,
  ObligationSource,
  ObligationStatus,
} from '../semantics/obligations';
// Verification cases (plan §3.4). `runVerificationCases` is what `verify` runs
// over its own judged rows, and `writeVerdict` is the only thing in this lane
// that puts a CASE verdict into a file — so both come through the barrel, which
// the standing rule calls the door: a report nobody can import is not an API.
export {
  METHOD_NOT_PERFORMED_CODE,
  NO_PROPERTY_CODE,
  PERFORMED_METHOD,
  VERDICT_CHANGED_CODE,
  VERIFICATION_CASE_CODES,
  methodOf,
  runVerificationCases,
  verificationCasesOf,
  verifiedRequirementsOf,
  writeVerdict,
} from '../semantics/verify';
export type {
  DanglingVerification,
  JudgedObligation,
  MethodReading,
  RequirementFacet,
  VerdictDisagreement,
  VerificationCaseOptions,
  VerificationCaseReport,
  VerificationCaseVerdict,
  VerifiedRequirement,
  WriteVerdictReport,
} from '../semantics/verify';

// Bounded behaviour (plan §3.8). The step relation is here because §3.8 calls it
// an in-process API in those words — a checker that could only be reached by
// spawning a CLI is not one — and `reachReport` because it is what the `reach`
// subcommand is a rendering of.
export {
  BEHAVIOUR_CODES,
  BEHAVIOUR_UNSUPPORTED_CODE,
  BOUND_EXHAUSTED_CODE,
  DEAD_TRANSITION_CODE,
  DEADLOCK_CODE,
  DEFAULT_MAX_CONFIGS,
  DEFAULT_MAX_DEPTH,
  NONDETERMINISTIC_CHOICE_CODE,
  UNREACHABLE_STATE_CODE,
  exploreMachine,
  machineAlphabet,
  machineStates,
  reachReport,
  stateMachinesIn,
  transitionLabel,
} from '../semantics/mc/explore';
export type {
  BoundHit,
  DeadlockRow,
  ExploreBounds,
  ExploreOptions,
  ExploreResult,
  MachineReach,
  NondeterministicChoice,
  ReachOptions,
  ReachReport,
  StateRef,
  TransitionRef,
  UnsupportedConstruct,
} from '../semantics/mc/explore';
export {
  MAX_COMPLETION,
  advanceClock,
  enabledTransitions,
  hashConfig,
  initialConfig,
  leafOf,
  stepConfig,
} from '../semantics/mc/config';
export type {
  EnabledTransition,
  MachineConfig,
  StepEffects,
  StepInput,
  StepResult,
} from '../semantics/mc/config';
export { SEMANTIC_PROFILE, profileLines } from '../semantics/mc/profile';
export type { ProfileField } from '../semantics/mc/profile';
// Safety patterns over that graph (plan §3.8), through the same door and for
// the same reason: `check-behaviour` is a rendering of `behaviourReport`, and a
// checker an agent could only reach by spawning a CLI is not an in-process API.
export {
  PATTERNS,
  PROPERTY_FIELDS,
  PROPERTY_PATTERN_CODES,
  SCOPES,
  behaviourReport,
  checkProperty,
  isPropertyCarrier,
  parsePropertyText,
  propertiesOf,
  traceLine,
} from '../semantics/mc/patterns';
export type {
  BehaviourOptions,
  BehaviourReport,
  PatternClass,
  PatternName,
  PatternSpec,
  PropertyClaim,
  PropertySource,
  PropertyText,
  PropertyVerdict,
  ScopeName,
  ScopeSpec,
  TraceStep,
} from '../semantics/mc/patterns';
export {
  MALFORMED_PROPERTY_CODE,
  UNKNOWN_ATOM_CODE,
  atomHolds,
  readAtom,
} from '../semantics/mc/atoms';
export type { Atom, AtomKind, AtomRefusal, AtomResult, Observation } from '../semantics/mc/atoms';

// REST facade
export { SysmlApiServer } from './rest';
export type { ApiResponse, ProjectResource } from './rest';

// Version-controlled repository
export { ProjectRepository, relationshipsOfElement } from './versioning';
export type {
  Project,
  Branch,
  Commit,
  Tag,
  ElementChange,
  CommitDiff,
  MergeStrategy,
  MergeOptions,
  MergeConflict,
  MergeResult,
  ElementRelationships,
} from './versioning';
