/**
 * Unit tests for layoutDiagram — elkjs auto-layout. Asserts that every node
 * receives a numeric position and non-zero size, and that nested children are
 * positioned within the bounds of their parent container.
 */

import { describe, expect, it } from 'vitest';
import { buildSampleModel } from '@core/index';
import { buildDiagram } from '@diagram/build';
import { layoutDiagram } from '@diagram/layout';

describe('layoutDiagram — general view', () => {
  it('assigns numeric positions and non-zero sizes to every node', async () => {
    const m = buildSampleModel();
    const g = await layoutDiagram(buildDiagram(m, 'general'));
    expect(g.nodes.length).toBeGreaterThan(0);
    for (const n of g.nodes) {
      expect(typeof n.position?.x).toBe('number');
      expect(typeof n.position?.y).toBe('number');
      expect(Number.isFinite(n.position!.x)).toBe(true);
      expect(Number.isFinite(n.position!.y)).toBe(true);
      expect(n.size!.w).toBeGreaterThan(0);
      expect(n.size!.h).toBeGreaterThan(0);
    }
  });

  it('separates distinct nodes (no total overlap)', async () => {
    const m = buildSampleModel();
    const g = await layoutDiagram(buildDiagram(m, 'general'));
    const positions = new Set(g.nodes.map((n) => `${n.position!.x},${n.position!.y}`));
    expect(positions.size).toBe(g.nodes.length);
  });
});

describe('layoutDiagram — nested interconnection view', () => {
  it('positions nested children within their parent container', async () => {
    const m = buildSampleModel();
    const vehicle = m.all().find((e) => e.declaredName === 'vehicle')!;
    const g = await layoutDiagram(buildDiagram(m, 'interconnection', vehicle.id));

    const frame = g.nodes.find((n) => n.elementId === vehicle.id)!;
    const engine = g.nodes.find((n) => n.parentId === vehicle.id)!;

    expect(frame.size!.w).toBeGreaterThan(0);
    expect(frame.size!.h).toBeGreaterThan(0);
    // Child position is parent-relative (React Flow semantics) and inside bounds.
    expect(engine.position!.x).toBeGreaterThanOrEqual(0);
    expect(engine.position!.y).toBeGreaterThanOrEqual(0);
    expect(engine.position!.x + engine.size!.w).toBeLessThanOrEqual(frame.size!.w + 1);
    expect(engine.position!.y + engine.size!.h).toBeLessThanOrEqual(frame.size!.h + 1);
  });
});

describe('layoutDiagram — empty graph', () => {
  it('returns an empty laid-out graph without error', async () => {
    const g = await layoutDiagram({ nodes: [], edges: [], viewKind: 'general' });
    expect(g.nodes).toHaveLength(0);
    expect(g.edges).toHaveLength(0);
    expect(g.viewKind).toBe('general');
  });
});
