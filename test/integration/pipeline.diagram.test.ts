/**
 * Pipeline integration — Model → Diagram → Layout.
 *
 * Builds the model from examples/vehicle.sysml, projects it through @diagram's
 * buildDiagram for every ViewKind, runs the elkjs auto-layout, and asserts the
 * resulting graphs have the expected nodes/edges and that every node receives a
 * finite numeric position and a positive size.
 */

import { describe, it, expect } from 'vitest';
import { parseModel } from '@text/index';
import { buildDiagram } from '@diagram/build';
import { layoutDiagram } from '@diagram/layout';
import type { DiagramGraph, ViewKind } from '@diagram/types';
import { readVehicleSource } from './_shared';

const { model } = parseModel(readVehicleSource());

const VIEW_KINDS: ViewKind[] = [
  'general',
  'interconnection',
  'action',
  'state',
  'requirement',
  'tree',
];

/** Assert every node in a laid-out graph has a finite position and positive size. */
function expectLaidOut(g: DiagramGraph): void {
  expect(g.nodes.length).toBeGreaterThan(0);
  for (const n of g.nodes) {
    expect(typeof n.position?.x).toBe('number');
    expect(typeof n.position?.y).toBe('number');
    expect(Number.isFinite(n.position!.x)).toBe(true);
    expect(Number.isFinite(n.position!.y)).toBe(true);
    expect(n.size!.w).toBeGreaterThan(0);
    expect(n.size!.h).toBeGreaterThan(0);
  }
}

describe('pipeline: Model → Diagram for every ViewKind', () => {
  for (const vk of VIEW_KINDS) {
    it(`builds and lays out the "${vk}" view with positioned nodes`, async () => {
      const built = buildDiagram(model, vk);
      expect(built.viewKind).toBe(vk);
      expect(built.nodes.length).toBeGreaterThan(0);
      const laid = await layoutDiagram(built);
      expect(laid.viewKind).toBe(vk);
      expect(laid.nodes).toHaveLength(built.nodes.length);
      expect(laid.edges).toHaveLength(built.edges.length);
      expectLaidOut(laid);
    });
  }
});

describe('pipeline: Model → Diagram view-specific projections', () => {
  it('the general view projects structural usages/definitions and their edges', async () => {
    const g = await layoutDiagram(buildDiagram(model, 'general'));
    // 20 declared + 2 implicit part usages (vehicle.engine / vehicle.transmission)
    // materialized for the connector feature-chain endpoints.
    expect(g.nodes).toHaveLength(22);
    // 14 declared + 2 containment + 2 redefinition edges for the implicit parts
    // + the 2 FeatureTypings `parseModel` now binds itself (`part engine :
    // Engine`, `part transmission : Transmission` are forward typings, which
    // used to reach the diagram only after the library binder ran).
    expect(g.edges).toHaveLength(20);
    // Packages, attributes, ports and connections are NOT general-view nodes.
    expect(g.nodes.find((n) => n.kind === 'Package')).toBeUndefined();
    expect(g.nodes.find((n) => n.kind === 'PortUsage')).toBeUndefined();
  });

  it('the tree view includes every non-relationship element with containment edges', async () => {
    const g = await layoutDiagram(buildDiagram(model, 'tree'));
    // 38 declared + 6 implicit connector-endpoint features (2 parts + 4 ports).
    expect(g.nodes).toHaveLength(44);
    expect(g.edges).toHaveLength(43);
    expect(g.edges.every((e) => e.kind === 'containment')).toBe(true);
  });

  it('the requirement view shows the requirement, its satisfier and a satisfy edge', async () => {
    const g = await layoutDiagram(buildDiagram(model, 'requirement'));
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].kind).toBe('satisfy');
  });

  it('the action view emits a succession edge between action usages', async () => {
    const g = await layoutDiagram(buildDiagram(model, 'action'));
    expect(g.edges.length).toBeGreaterThanOrEqual(1);
    expect(g.edges.every((e) => e.kind === 'succession')).toBe(true);
  });

  it('the interconnection view nests parts under the scoped Vehicle definition', async () => {
    const vehicleDef = model
      .ofKind('PartDefinition')
      .find((e) => e.declaredName === 'Vehicle')!;
    const g = await layoutDiagram(buildDiagram(model, 'interconnection', vehicleDef.id));
    expectLaidOut(g);
    const frame = g.nodes.find((n) => n.elementId === vehicleDef.id);
    expect(frame).toBeDefined();
    // engine + transmission nest inside the Vehicle frame.
    expect(g.nodes.filter((n) => n.parentId === vehicleDef.id)).toHaveLength(2);
  });
});
