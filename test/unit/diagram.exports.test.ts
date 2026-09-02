/**
 * Smoke test for the diagram module barrel: verifies the public surface
 * (build/layout, React Flow node/edge type maps, adapter) is exported and that
 * the React Flow adapter wires types, nesting and port handles correctly.
 */

import { describe, expect, it } from 'vitest';
import { buildSampleModel } from '@core/index';
import {
  buildDiagram,
  layoutDiagram,
  nodeTypes,
  edgeTypes,
  edgeStyleFor,
  toReactFlow,
} from '@diagram/index';

describe('diagram barrel exports', () => {
  it('exposes build/layout and renderer maps', () => {
    expect(typeof buildDiagram).toBe('function');
    expect(typeof layoutDiagram).toBe('function');
    // Node components are React.memo-wrapped (H5) — memo returns an exotic
    // component object, not a bare function; assert renderable-component shape.
    expect(nodeTypes.sysml).toBeTruthy();
    expect(nodeTypes.control).toBeTruthy();
    expect(edgeTypes.sysml).toBeTypeOf('function');
  });

  it('maps edge kinds to marker specs', () => {
    expect(edgeStyleFor('composite').markerStart).toBeTruthy();
    expect(edgeStyleFor('specialize').markerEnd).toBeTruthy();
    expect(edgeStyleFor('typed-by').dashed).toBe(true);
  });

  it('converts a laid-out graph to React Flow nodes/edges', async () => {
    const m = buildSampleModel();
    const vehicle = m.all().find((e) => e.declaredName === 'vehicle')!;
    const graph = await layoutDiagram(buildDiagram(m, 'interconnection', vehicle.id));
    const { nodes, edges } = toReactFlow(graph);

    expect(nodes).toHaveLength(graph.nodes.length);
    const child = nodes.find((n) => n.parentId === vehicle.id)!;
    expect(child.extent).toBe('parent');
    expect(child.type).toBe('sysml');

    // Connection edge endpoints (ports) are resolved to owning nodes + handles.
    const edge = edges[0];
    const fuelOut = m.all().find((e) => e.declaredName === 'fuelOut')!;
    expect(edge.sourceHandle).toBe(fuelOut.id);
    expect(edge.source).not.toBe(fuelOut.id); // mapped to the owning node id
  });
});
