/**
 * Per-element PageRank centrality over the USER model.
 *
 * PageRank is inherently a WHOLE-GRAPH metric — an element's score depends on
 * the entire relationship structure — so it cannot be computed one element at a
 * time like the cheap degree/where-used metrics. This helper builds the directed
 * relationship graph of the user model once and returns every node's score plus
 * a derived 1-based ranking, so the Properties panel can show "how central is
 * this element" for the current selection with a single memoised pass.
 *
 * Node/edge partition is EXACTLY the Analysis view's (graph-analysis.ts
 * isNodeCandidate / isEdgeElement), so Properties and the Analysis view agree:
 *  - a NODE is a non-library, non-implicit, non-annotation element that carries
 *    NO endpoints (source/target empty);
 *  - an EDGE is any non-library element that carries BOTH a source and a target
 *    — this deliberately includes endpoint-bearing *usages* (ConnectionUsage,
 *    TransitionUsage, IncludeUseCaseUsage, …), not just the relationship
 *    metaclasses, since those are the structure the user actually draws.
 * Each edge contributes directed source→target pairs, kept only when both
 * endpoints are nodes (drops dangling/library references and self-loops).
 *
 * Pure and DOM-free (the caller supplies the element list) — exhaustively
 * unit-testable.
 */

import { isAnnotation } from '@core/index';
import { pageRank, type Graph, type GraphEdge } from './graph-algorithms';

/** The slice of an element record this helper reads. */
export interface CentralityElement {
  id: string;
  eClass: string;
  attrs: Record<string, unknown>;
  source?: string[];
  target?: string[];
}

export interface ElementCentrality {
  /** PageRank score per node id (∑ ≈ 1 over the graph); absent for non-nodes. */
  score: Map<string, number>;
  /** 1-based rank by descending score (1 = most central); ties broken by id. */
  rank: Map<string, number>;
  /** Number of nodes in the centrality graph. */
  nodeCount: number;
}

/** A ranked NODE: user, non-implicit, non-annotation, endpoint-free. */
function isCentralityNode(el: CentralityElement): boolean {
  return (
    el.attrs?.isLibrary !== true &&
    el.attrs?.implicit !== true &&
    !isAnnotation(el.eClass) &&
    (el.source?.length ?? 0) === 0 &&
    (el.target?.length ?? 0) === 0
  );
}

/** An EDGE: any user element carrying both a source and a target. */
function isCentralityEdge(el: CentralityElement): boolean {
  return (
    el.attrs?.isLibrary !== true &&
    (el.source?.length ?? 0) > 0 &&
    (el.target?.length ?? 0) > 0
  );
}

export function elementCentrality(elements: readonly CentralityElement[]): ElementCentrality {
  const nodeIds = new Set<string>();
  for (const el of elements) if (isCentralityNode(el)) nodeIds.add(el.id);

  const edges: GraphEdge[] = [];
  for (const el of elements) {
    if (!isCentralityEdge(el)) continue;
    for (const s of el.source ?? []) {
      if (!nodeIds.has(s)) continue;
      for (const t of el.target ?? []) {
        if (t === s || !nodeIds.has(t)) continue;
        edges.push({ source: s, target: t, weight: 1 });
      }
    }
  }
  const graph: Graph = { nodes: [...nodeIds], edges };
  const score = pageRank(graph);
  // Rank by descending score, ties broken by id for a stable, deterministic order.
  const ordered = [...score.entries()].sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );
  const rank = new Map<string, number>();
  ordered.forEach(([id], i) => rank.set(id, i + 1));
  return { score, rank, nodeCount: nodeIds.size };
}
