/**
 * Public surface of the KerML semantics engine.
 *
 * Pure, side-effect-free analyses over a {@link Model}: inheritance
 * (generalization closure + effective features), conformance (specialization &
 * literal type checking), a self-contained expression parser/evaluator, and
 * model-level value/constraint evaluation.
 */

export { generalizationsOf, ownFeatures, effectiveFeatures } from './inheritance';
export { conforms, valueConformsToType } from './conformance';
export {
  DIRECT_SUPERTYPES,
  isKindOf,
  metaclassChain,
  isFeatureMetaclass,
  isTypeMetaclass,
} from './metaclasses';
export {
  IMPLICIT_BASE_TYPE,
  implicitBaseTypesOf,
  generalizationsWithImplicit,
  effectiveFeaturesWithLibrary,
  typeIntersectionConforms,
  featuringTypeOf,
  unionOf,
  intersectionOf,
  differenceOf,
  featureChain,
  inverseOf,
} from './featuring';
export { resolveName, resolveQualifiedNameFull } from './resolve-names';
export {
  resolveFullName,
  resolveRedefinedFeature,
  resolveImportTargets,
  type ResolveFullNameOptions,
} from './bind';
export {
  parseExpr,
  evaluate,
  type ExprNode,
  type BinaryOp,
  type EvalResult,
} from './expr';
export {
  scopeFor,
  evaluateFeatureValue,
  checkConstraints,
  type Scope,
  type ConstraintCheck,
} from './evaluate-model';
export {
  runActionFlow,
  runStateMachine,
  executeBehavior,
  propagateBindings,
  evaluateModel,
  executeModel,
  type ExecutionStep,
  type ExecutionTrace,
  type RunActionOptions,
  type StateFire,
  type PerformedAction,
  type RunStateOptions,
  type StateRunResult,
  type TimedStep,
  type StateStep,
  type ModelEvaluation,
  type BehaviorTrace,
  type BehaviorStep,
  type BehaviorExecution,
  type ExecuteBehaviorOptions,
  type ModelExecution,
} from './execute';
export {
  SimulationSession,
  simulateStateMachine,
  isSimulatable,
  discoverTriggers,
  type SimValue,
  type SimStep,
  type SimSample,
  type SimFire,
  type SimTrace,
  type SimConstraintStatus,
  type SimOptions,
} from './simulate';
export {
  connectorEndsOf,
  isConnector,
  isBindingEdge,
  bindingEquivalenceClasses,
  propagateValues,
  itemFlowsOf,
  type ItemFlowInfo,
} from './connectors';
export {
  gatherConstraints,
  gatherInequalities,
  solve,
  solveFeasible,
  checkConstraintsNumeric,
  evaluateMoEs,
  optimize,
  type Equation,
  type Inequality,
  type ComparisonOp,
  type SolveOptions,
  type SolveResult,
  type FeasibilityOptions,
  type FeasibilityResult,
  type ConstraintViolation,
  type NumericConstraintResult,
  type MeasureResult,
  type OptimizeSense,
  type OptimizeOptions,
  type OptimizeResult,
} from './solver';
export {
  DIMENSIONLESS,
  dim,
  multiplyDim,
  divideDim,
  powDim,
  dimEqual,
  dimToString,
  SI_PREFIXES,
  BINARY_PREFIXES,
  prefixFactor,
  UNIT_REGISTRY,
  unitByName,
  unitBySymbol,
  normalizeUnitRef,
  resolveUnit,
  dimensionOf,
  areCompatible,
  convert,
  libraryUnitName,
  siSymbolOf,
  quantityKindDimension,
  type Dimension,
  type Unit,
  type Prefix,
} from './units';
