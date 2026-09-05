/**
 * Public surface of the diagram module.
 *
 * Maps the SysML v2 {@link Model} into per-view {@link DiagramGraph} projections
 * ({@link buildDiagram}), auto-lays-them-out with elkjs ({@link layoutDiagram}),
 * and provides React Flow custom renderers ({@link nodeTypes}/{@link edgeTypes})
 * plus an adapter ({@link toReactFlow}) for the UI.
 */

export type {
  ViewKind,
  DiagramNode,
  DiagramEdge,
  DiagramGraph,
  DiagramPort,
  AllocationMatrix,
  SequenceDiagram,
  GridModel,
  RequirementsTableModel,
  ReqRow,
  ReqReference,
  ReqRefColumn,
  ReqAttrColumn,
  AnalysisConfig,
  GraphAnalysisModel,
  GraphAnalysisNode,
  GraphAnalysisEdge,
  AnalysisLegendEntry,
  DSMModel,
  DSMCell,
  DSMModule,
  GraphLayoutKind,
  GraphClusterKind,
  GraphSizeKind,
  GraphColorKind,
  DsmOrderKind,
  PlanConfig,
  PlanModel,
  PlanGroup,
  PlanWave,
  PlanMember,
  PlanGrouping,
  PlanOrdering,
  RegroupBundle,
  RegroupConfig,
  RegroupMember,
  RegroupProposedPort,
  RegroupBoundary,
  RegroupPlannedBundle,
  RegroupModel,
} from './types';

export { buildDiagram } from './build';
export { layoutDiagram } from './layout';

// Pure, DOM-free SVG export of a laid-out DiagramGraph (de-facto graphical
// interchange). Rasterised to PNG in the browser by the toolbar.
export { svgFromDiagram, escapeXml } from './svg-export';
export type { SvgExportOptions } from './svg-export';

// Pure 3D geometry-scene builder + its contract. Three.js-free, so importing
// this never pulls the Three.js bundle onto the entry graph; the WebGL renderer
// (`Geometry3DView`) is loaded lazily by the UI and is deliberately NOT re-exported here.
export { buildGeometryScene, colorFromString } from './geometry3d';
export type {
  GeometryScene,
  GeometryItem,
  GeometryShape,
  GeometryBounds,
  Vec3,
  BuildGeometrySceneOptions,
} from './geometry3d';

export { nodeTypes, SysmlNode, ControlNode } from './nodes';
export { edgeTypes, SysmlEdge, FloatingEdge, EdgeMarkers, edgeStyleFor, MARKER } from './edges';
export { toReactFlow, toReactFlowNode, toReactFlowEdge } from './reactflow';
export { reconnectEndpoint } from './reconnect';
export type { ReconnectEdge, ReconnectConnection, ReconnectPatch } from './reconnect';
export { resolveReparentTarget, subtreeRoots } from './reparent-target';
export type { ReparentTargetModel } from './reparent-target';
export { elementCentrality } from './centrality';
export type { ElementCentrality, CentralityElement } from './centrality';

// Pure edge-routing geometry (shape-aware floating edges). Framework-light,
// Three.js-free; unit-tested in isolation.
export { shapeForKind, getNodeIntersection, getEdgeEndpoints } from './geometry';
export type { NodeShape, Point, ShapedNode, EdgeEndpoints } from './geometry';

export { buildTraceabilityMatrix, buildAllocationMatrix } from './matrix';
export {
  buildRequirementsTable,
  REQUIREMENT_REF_COLUMNS,
  REQUIREMENT_SCALAR_COLUMNS,
  REQUIREMENT_ATTR_COLUMNS,
} from './requirements-table';
export {
  buildGraphAnalysis,
  buildDSM,
  defaultAnalysisConfig,
  restyleNodeSizes,
  categoryOf,
  relationSymbol,
  CATEGORY_COLORS,
  CATEGORY_LABELS,
  COMMUNITY_PALETTE,
} from './graph-analysis';
export { buildPlan, defaultPlanConfig, orderByMinLA, minlaCost } from './planning';
export type { MinLAInstance } from './planning';
// Regroup Workbench engine — Phase 1: pure/read-only preview (no model mutation).
export {
  planRegroup,
  defaultRegroupConfig,
  endpointToPart,
  seedRegroupFromClusters,
  seedRegroupFromNodeIds,
  proposedPortKey,
} from './regroup';
// Regroup Workbench — Phase 2: pre-validated apply plan + the atomic mutation.
export { planApply, applyRegroup } from './regroup-apply';
export type {
  RegroupApplyPlan,
  RegroupApplyResult,
  RegroupApplyCreatePart,
  RegroupApplyMove,
  RegroupApplyPort,
  RegroupApplyRewire,
} from './regroup-apply';
export { buildSequence } from './sequence';
export { buildGrid } from './grid';
export type { BuildGridOptions } from './grid';
export { MatrixView } from './MatrixView';
export type { MatrixViewProps } from './MatrixView';
export { SequenceView } from './SequenceView';
export type { SequenceViewProps } from './SequenceView';
export { GridView } from './GridView';
export type { GridViewProps } from './GridView';
