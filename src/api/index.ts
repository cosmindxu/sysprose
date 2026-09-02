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
  countByMetaclass,
  modelMetrics,
  requirementSatisfaction,
  traceabilityMatrix,
  whereUsed,
  connectivityReport,
  constraintReport,
  executionReport,
  simulationReport,
  unitReport,
  analysisReport,
} from './analytics';
export type {
  ElementRef,
  ModelMetrics,
  RequirementStatus,
  SatisfactionReport,
  TraceabilityMatrix,
  UsageRef,
  WhereUsedReport,
  ConnectivityReport,
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
  SolvedValue,
} from './analytics';

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
