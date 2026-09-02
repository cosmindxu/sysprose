/**
 * layoutDiagram — assign positions & sizes to a {@link DiagramGraph} using elkjs.
 *
 * Uses ELK's `layered` algorithm with port constraints and hierarchical nesting
 * (children laid out *within* their parents). We import the **bundled** ELK
 * build so the exact same code runs headlessly in Node (Vitest) and in the
 * browser — no web-worker or WASM wiring required.
 *
 * Returns a NEW graph; the input is not mutated. Every node receives a numeric
 * `position` (parent-relative for nested nodes, matching React Flow semantics)
 * and a non-zero `size`. Edge routing is left to React Flow.
 */

// The bundled build is self-contained and runs in Node and the browser alike.
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ELK as ElkInstance, ElkExtendedEdge, ElkNode, ElkPort } from 'elkjs/lib/elk-api';
import type { DiagramEdge, DiagramGraph, DiagramNode, ViewKind } from './types';

/** Default box size before ELK sizes containers to fit their children. */
const DEFAULT_NODE_W = 180;
const DEFAULT_NODE_H = 80;
const PORT_SIZE = 10;

/**
 * Port-constraint mode used for boundary ports: their assigned side is fixed
 * (in→WEST, out→EAST) but ELK may still order/distribute them along that side.
 */
export const PORT_CONSTRAINTS = 'FIXED_SIDE';

/**
 * Map a diagram port side — or a raw feature direction (`in`/`out`) — to an ELK
 * port-side constant. Inbound features anchor WEST, outbound EAST, matching the
 * SysML flow convention (and the left/right boundary sides {@link buildDiagram}
 * assigns). Exposed so the port-side policy is unit-testable without ELK.
 */
export function elkPortSide(side: string): string {
  switch (side) {
    case 'left':
    case 'in':
      return 'WEST';
    case 'right':
    case 'out':
      return 'EAST';
    case 'top':
      return 'NORTH';
    case 'bottom':
      return 'SOUTH';
    default:
      return 'EAST';
  }
}

/**
 * Preferred primary layout direction per view. Structural/browsing views flow
 * left→right; the hierarchical and behavioural views (tree/requirement/state/
 * action/case) read top→down like their SysML notation counterparts. Exposed for
 * unit tests.
 */
export function layoutDirectionFor(viewKind: ViewKind): 'RIGHT' | 'DOWN' {
  switch (viewKind) {
    case 'tree':
    case 'requirement':
    case 'state':
    case 'action':
    case 'case':
      return 'DOWN';
    default:
      return 'RIGHT';
  }
}

/**
 * Root ELK layout options for a view: the `layered` algorithm with a per-view
 * primary direction, orthogonal edge routing, hierarchical nesting (children laid
 * out within their parents), and sensible node/edge spacing. Pure + exported so
 * the layout policy is verifiable without invoking ELK.
 */
export function layoutOptionsFor(viewKind: ViewKind): Record<string, string> {
  return {
    'elk.algorithm': 'layered',
    'elk.direction': layoutDirectionFor(viewKind),
    'elk.edgeRouting': 'ORTHOGONAL',
    'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    'elk.layered.spacing.nodeNodeBetweenLayers': '60',
    'elk.layered.spacing.edgeNodeBetweenLayers': '25',
    'elk.spacing.nodeNode': '40',
    'elk.spacing.edgeNode': '20',
    'elk.spacing.edgeEdge': '15',
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    'elk.layered.mergeEdges': 'true',
  };
}

/** Heuristic intrinsic size for a node from its compartments. */
function intrinsicSize(node: DiagramNode): { w: number; h: number } {
  const data = node.data ?? {};
  const attrs = Array.isArray((data as Record<string, unknown>).attributes)
    ? ((data as Record<string, unknown>).attributes as unknown[]).length
    : 0;
  const portsCompartment = Array.isArray((data as Record<string, unknown>).ports)
    ? ((data as Record<string, unknown>).ports as unknown[]).length
    : 0;
  const rows = attrs + portsCompartment;
  const labelW = Math.max(DEFAULT_NODE_W, node.label.length * 8 + 40);
  const h = DEFAULT_NODE_H + rows * 18;
  return { w: labelW, h };
}

/** Build the ELK node tree from the diagram's parent/child relationships. */
function toElkTree(graph: DiagramGraph): { root: ElkNode; nodeById: Map<string, DiagramNode> } {
  const nodeById = new Map<string, DiagramNode>();
  const elkById = new Map<string, ElkNode>();
  const childrenOf = new Map<string | undefined, DiagramNode[]>();

  for (const n of graph.nodes) {
    nodeById.set(n.id, n);
    const key = n.parentId;
    const list = childrenOf.get(key) ?? [];
    list.push(n);
    childrenOf.set(key, list);
  }

  const makeElk = (n: DiagramNode): ElkNode => {
    const { w, h } = intrinsicSize(n);
    const ports: ElkPort[] = (n.ports ?? []).map((p) => ({
      id: p.id,
      width: PORT_SIZE,
      height: PORT_SIZE,
      layoutOptions: { 'elk.port.side': elkPortSide(p.side) },
    }));
    const elk: ElkNode = {
      id: n.id,
      width: w,
      height: h,
      ...(ports.length ? { ports } : {}),
    };
    if (ports.length) {
      elk.layoutOptions = {
        'elk.portConstraints': PORT_CONSTRAINTS,
        'elk.portAlignment.default': 'DISTRIBUTED',
      };
    }
    const kids = childrenOf.get(n.id) ?? [];
    if (kids.length) {
      elk.children = kids.map(makeElk);
      // Give nested containers room and padding around children.
      elk.layoutOptions = {
        ...(elk.layoutOptions ?? {}),
        'elk.padding': '[top=36,left=20,bottom=20,right=20]',
      };
    }
    elkById.set(n.id, elk);
    return elk;
  };

  const roots = (childrenOf.get(undefined) ?? []).map(makeElk);

  // Every edge endpoint may be a node id or a port id; ELK resolves both.
  const edges: ElkExtendedEdge[] = graph.edges.map((e: DiagramEdge) => ({
    id: e.id,
    sources: [e.source],
    targets: [e.target],
  }));

  const root: ElkNode = {
    id: 'root',
    layoutOptions: layoutOptionsFor(graph.viewKind),
    children: roots,
    edges,
  };
  return { root, nodeById };
}

/** Walk the laid-out ELK tree and copy positions/sizes onto a node-id map. */
function collect(
  elk: ElkNode,
  out: Map<string, { x: number; y: number; w: number; h: number }>,
): void {
  for (const child of elk.children ?? []) {
    out.set(child.id, {
      x: child.x ?? 0,
      y: child.y ?? 0,
      w: child.width ?? DEFAULT_NODE_W,
      h: child.height ?? DEFAULT_NODE_H,
    });
    collect(child, out);
  }
}

let elkInstance: ElkInstance | null = null;
function getElk(): ElkInstance {
  if (!elkInstance) elkInstance = new ELK();
  return elkInstance;
}

/**
 * Lay out `graph` and return a new graph with `position` and `size` set on every
 * node. Positions of nested nodes are relative to their parent (React Flow
 * semantics); top-level nodes are relative to the diagram origin.
 */
export async function layoutDiagram(graph: DiagramGraph): Promise<DiagramGraph> {
  if (graph.nodes.length === 0) {
    return { nodes: [], edges: graph.edges.map((e) => ({ ...e })), viewKind: graph.viewKind };
  }

  const { root } = toElkTree(graph);
  const laidOut = await getElk().layout(root);

  const geom = new Map<string, { x: number; y: number; w: number; h: number }>();
  collect(laidOut, geom);

  const nodes: DiagramNode[] = graph.nodes.map((n) => {
    const g = geom.get(n.id);
    const x = g?.x ?? 0;
    const y = g?.y ?? 0;
    const w = g?.w && g.w > 0 ? g.w : DEFAULT_NODE_W;
    const h = g?.h && g.h > 0 ? g.h : DEFAULT_NODE_H;
    return { ...n, position: { x, y }, size: { w, h } };
  });

  return { nodes, edges: graph.edges.map((e) => ({ ...e })), viewKind: graph.viewKind };
}
