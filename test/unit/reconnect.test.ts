import { describe, it, expect } from 'vitest';
import { reconnectEndpoint } from '@diagram/reconnect';
import { buildSampleModel } from '@core/index';
import { buildDiagram } from '@diagram/build';
import { toReactFlow, toReactFlowEdge } from '@diagram/reactflow';
import type { DiagramGraph } from '@diagram/types';

/** Identity resolver: node id === element id for plain (non-port) element nodes. */
const idResolve = (id: string) => id;

describe('reconnectEndpoint — pure endpoint reconnection', () => {
  const edge = { source: 'A', target: 'B', elementId: 'rel1' };

  it('re-targets the SOURCE when the source end moves', () => {
    const out = reconnectEndpoint(edge, { source: 'C', target: 'B' }, idResolve);
    expect(out).toEqual({ relId: 'rel1', patch: { source: ['C'] } });
  });

  it('re-targets the TARGET when the target end moves', () => {
    const out = reconnectEndpoint(edge, { source: 'A', target: 'D' }, idResolve);
    expect(out).toEqual({ relId: 'rel1', patch: { target: ['D'] } });
  });

  it('is a no-op when neither end moved', () => {
    expect(reconnectEndpoint(edge, { source: 'A', target: 'B' }, idResolve)).toBeNull();
  });

  it('is a no-op for a structural edge with no backing element', () => {
    const structural = { source: 'A', target: 'B' };
    expect(reconnectEndpoint(structural, { source: 'C', target: 'B' }, idResolve)).toBeNull();
  });

  it('is a no-op when the connection is incomplete (dangling end)', () => {
    expect(reconnectEndpoint(edge, { source: null, target: 'B' }, idResolve)).toBeNull();
    expect(reconnectEndpoint(edge, { source: 'A', target: null }, idResolve)).toBeNull();
  });

  it('is a no-op when the moved end does not resolve to a model element', () => {
    expect(reconnectEndpoint(edge, { source: 'ghost', target: 'B' }, () => null)).toBeNull();
  });

  it('prefers the SOURCE branch when both ends differ (one drag moves one end)', () => {
    // Defensive: even if both differ, only one patch is produced (source wins).
    const out = reconnectEndpoint(edge, { source: 'C', target: 'D' }, idResolve);
    expect(out).toEqual({ relId: 'rel1', patch: { source: ['C'] } });
  });
});

describe('toReactFlowEdge — reconnectable gating', () => {
  it('marks element-level relationship edges reconnectable, structural + port edges not', () => {
    const m = buildSampleModel();
    // General view carries a «satisfy» relationship edge (rel:) and structural
    // containment edges (comp:/own:) with no backing element.
    const general = toReactFlow(buildDiagram(m, 'general'));
    const rel = general.edges.find((e) => e.id.startsWith('rel:'));
    const structural = general.edges.find(
      (e) => e.id.startsWith('comp:') || e.id.startsWith('own:'),
    );
    expect(rel, 'expected a relationship edge in the general view').toBeTruthy();
    expect(rel!.reconnectable).toBe(true);
    if (structural) expect(structural.reconnectable).toBe(false);

    // Interconnection view routes a ConnectionUsage through boundary ports →
    // the edge has a handle and must NOT be reconnectable (can't collapse a port
    // connection onto its owner via a drag).
    const vehicle = m.all().find((e) => e.declaredName === 'vehicle')!;
    const inter = toReactFlow(buildDiagram(m, 'interconnection', vehicle.id));
    const portEdge = inter.edges.find((e) => e.sourceHandle || e.targetHandle);
    if (portEdge) expect(portEdge.reconnectable).toBe(false);
  });

  it('honors the builder opt-out: a display-only edge (reconnectable:false) is NOT reconnectable', () => {
    const graph: DiagramGraph = {
      viewKind: 'case',
      nodes: [
        { id: 'n1', elementId: 'n1', kind: 'usecase', label: 'A', ports: [], data: {} },
        { id: 'n2', elementId: 'n2', kind: 'usecase', label: 'B', ports: [], data: {} },
      ],
      edges: [
        // A relationship edge with true endpoints → reconnectable.
        { id: 'rel:r1', elementId: 'r1', source: 'n1', target: 'n2', kind: 'satisfy' },
        // An `include` rendered ownerId→self: display-only endpoints, opted out.
        {
          id: 'include:i1',
          elementId: 'i1',
          source: 'n1',
          target: 'n2',
          kind: 'include',
          reconnectable: false,
        },
      ],
    };
    const rel = toReactFlowEdge(graph.edges[0], graph);
    const inc = toReactFlowEdge(graph.edges[1], graph);
    expect(rel.reconnectable).toBe(true);
    expect(inc.reconnectable).toBe(false); // opt-out beats the elementId+non-port default
  });
});
