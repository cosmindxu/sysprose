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

// Verification lane (plan docs/04-formal-verification-plan.md §3.1, §3.2, §3.4)
export {
  contractReport,
  consistencyReport,
  obligationsReport,
  verifyModel,
  ALLOW_INCONCLUSIVE_CODES,
  INCONSISTENT_REQUIREMENTS_CODE,
  VERIFICATION_CODES,
  VERIFICATION_ERROR_CODES,
  VerifyOptionError,
} from './verification';
export type {
  ConsistencyReport,
  ConsistencyReportOptions,
  ContractReport,
  ContractReportOptions,
  KeywordOrigin,
  KeywordUse,
  ObligationReport,
  ObligationVerdict,
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
