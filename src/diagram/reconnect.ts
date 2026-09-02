/**
 * Pure endpoint-reconnection logic for relationship edges.
 *
 * When a user drags one end of a reconnectable diagram edge onto another node,
 * React Flow reports the old edge and the new connection. Exactly one end moves
 * per drag; this computes which side changed and the model patch that re-targets
 * the backing relationship's `source` / `target`. Kept framework-free so it can
 * be unit-tested without driving a real pointer drag.
 */

/** The relevant fields of the edge being reconnected. */
export interface ReconnectEdge {
  /** React Flow source node id (owning node for port edges). */
  source: string;
  /** React Flow target node id. */
  target: string;
  /** The backing relationship element id, if any (structural edges have none). */
  elementId?: string;
}

/** The new connection React Flow proposes (node ids; either end may be null). */
export interface ReconnectConnection {
  source: string | null;
  target: string | null;
}

/** A resolved model patch: which relationship to update and with what endpoint. */
export interface ReconnectPatch {
  relId: string;
  patch: { source?: string[]; target?: string[] };
}

/**
 * Compute the model patch for an endpoint reconnect, or `null` when it should be
 * a no-op (no backing element, incomplete connection, no end actually moved, or
 * the moved end doesn't resolve to a model element).
 *
 * @param resolve  maps a React Flow node id back to its model element id.
 */
export function reconnectEndpoint(
  edge: ReconnectEdge,
  conn: ReconnectConnection,
  resolve: (rfNodeId: string) => string | null,
): ReconnectPatch | null {
  const relId = edge.elementId;
  if (!relId || !conn.source || !conn.target) return null;

  if (conn.source !== edge.source) {
    const el = resolve(conn.source);
    return el ? { relId, patch: { source: [el] } } : null;
  }
  if (conn.target !== edge.target) {
    const el = resolve(conn.target);
    return el ? { relId, patch: { target: [el] } } : null;
  }
  return null; // neither end moved — dropped back where it started
}
