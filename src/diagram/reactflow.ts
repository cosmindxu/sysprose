/**
 * Adapter from the abstract {@link DiagramGraph} to React Flow's `Node`/`Edge`
 * arrays. Keeps the build/layout layers framework-agnostic while giving the UI a
 * one-call bridge that wires the correct custom `type`, positions, sizes, parent
 * nesting, boundary-port handles, and edge `kind` payloads.
 */

import type { Edge, Node } from '@xyflow/react';
import { isControlNode } from '@core/index';
import type { DiagramEdge, DiagramGraph, DiagramNode } from './types';

/** Pick the registered node component for a diagram node. */
function nodeTypeFor(node: DiagramNode): string {
  return isControlNode(node.kind) ? 'control' : 'sysml';
}

/** Convert one {@link DiagramNode} to a React Flow node. */
export function toReactFlowNode(n: DiagramNode): Node {
  const rf: Node = {
    id: n.id,
    type: nodeTypeFor(n),
    position: n.position ?? { x: 0, y: 0 },
    data: { ...n.data, elementId: n.elementId, kind: n.kind, label: n.label, boundaryPorts: n.ports },
  };
  if (n.parentId) {
    rf.parentId = n.parentId;
    rf.extent = 'parent';
  }
  if (n.size) {
    rf.width = n.size.w;
    rf.height = n.size.h;
    rf.style = { width: n.size.w, height: n.size.h };
  }
  return rf;
}

/** Convert one {@link DiagramEdge} to a React Flow edge (port-aware). */
export function toReactFlowEdge(e: DiagramEdge, graph: DiagramGraph): Edge {
  // For interconnection edges the endpoints are port ids; map them back to the
  // owning node id and pass the port as a source/target handle.
  const portOwner = (portOrNodeId: string): { node: string; handle?: string } => {
    for (const n of graph.nodes) {
      if (n.id === portOrNodeId) return { node: portOrNodeId };
      if (n.ports?.some((p) => p.id === portOrNodeId)) return { node: n.id, handle: portOrNodeId };
    }
    return { node: portOrNodeId };
  };
  const s = portOwner(e.source);
  const t = portOwner(e.target);
  // Only element-level relationship edges (those backed by a model element, and
  // not routed through a boundary port) may be endpoint-reconnected: dragging an
  // end re-targets the relationship's source/target. Excluded: structural
  // containment edges (no `elementId`); port-routed connections (a drag must not
  // collapse a port connection onto its owner element); and edges the builder
  // marked `reconnectable:false` because their rendered endpoints are display-
  // only, not the element's real source[0]/target[0] (e.g. `include`).
  const isPortEdge = s.handle != null || t.handle != null;
  const reconnectable = e.reconnectable !== false && e.elementId != null && !isPortEdge;
  return {
    id: e.id,
    source: s.node,
    target: t.node,
    sourceHandle: s.handle,
    targetHandle: t.handle,
    type: 'sysml',
    label: e.label,
    reconnectable,
    data: { kind: e.kind, elementId: e.elementId, label: e.label },
  };
}

/** Convert a whole {@link DiagramGraph} into React Flow `{ nodes, edges }`. */
export function toReactFlow(graph: DiagramGraph): { nodes: Node[]; edges: Edge[] } {
  return {
    nodes: graph.nodes.map(toReactFlowNode),
    edges: graph.edges.map((e) => toReactFlowEdge(e, graph)),
  };
}
