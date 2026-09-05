/**
 * buildGraphAnalysis / buildDSM — the SysML Model → analysis-view-model pipeline.
 */
import { describe, it, expect } from 'vitest';
import { Model, ModelFactory } from '@core/index';
import {
  buildGraphAnalysis,
  buildDSM,
  defaultAnalysisConfig,
  restyleNodeSizes,
  categoryOf,
} from '@diagram/index';
import type { AnalysisConfig } from '@diagram/index';
import { parseModel } from '@text/index';
import { setRequirementShortId } from '@semantics/index';

/**
 * A small system: two "modules" — {ctrl, sensor, actuator} wired by connections,
 * and {ui, api} wired together — plus two use cases and a requirement satisfied
 * by ctrl. Cross-module link only sensor→api.
 */
function seed(): Model {
  const m = new Model();
  const f = new ModelFactory(m);
  const pkg = f.pkg('Sys');
  const ctrl = f.part('ctrl', pkg.id);
  const sensor = f.part('sensor', pkg.id);
  const actuator = f.part('actuator', pkg.id);
  const ui = f.part('ui', pkg.id);
  const api = f.part('api', pkg.id);
  const _uc1 = m.create('UseCaseUsage', { declaredName: 'Drive', ownerId: pkg.id });
  const _uc2 = m.create('UseCaseUsage', { declaredName: 'Monitor', ownerId: pkg.id });
  const req = f.requirement('Safety', pkg.id, { reqId: 'R-1' });
  const conn = (a: string, b: string) => m.create('ConnectionUsage', { ownerId: pkg.id, source: [a], target: [b] });
  conn(ctrl.id, sensor.id);
  conn(ctrl.id, actuator.id);
  conn(sensor.id, actuator.id);
  conn(ui.id, api.id);
  conn(sensor.id, api.id); // the single cross-module bridge
  m.create('Satisfy', { ownerId: pkg.id, source: [ctrl.id], target: [req.id] });
  return m;
}

const cfg = (over: Partial<AnalysisConfig> = {}): AnalysisConfig => ({ ...defaultAnalysisConfig(), ...over });

describe('buildGraphAnalysis', () => {
  it('extracts nodes (vertices) and edges (endpoint-bearing elements)', () => {
    const g = buildGraphAnalysis(seed(), cfg());
    // Sys package + 5 parts + 2 use cases + 1 requirement = 9 vertices;
    // connections/satisfy carry endpoints → they are edges, not nodes.
    expect(g.nodes).toHaveLength(9);
    expect(g.edges.length).toBe(6); // 5 connections + 1 satisfy
    expect(g.nodes.every((n) => n.x !== undefined && n.size > 0)).toBe(true);
  });

  it('colors nodes by category by default (use case ≠ block)', () => {
    const g = buildGraphAnalysis(seed(), cfg({ colorBy: 'type' }));
    const uc = g.nodes.find((n) => n.label === 'Drive')!;
    const block = g.nodes.find((n) => n.label === 'ctrl')!;
    expect(uc.category).toBe('usecase');
    expect(block.category).toBe('block');
    expect(uc.color).not.toBe(block.color);
  });

  it('the node filter keeps only the selected metaclasses', () => {
    const g = buildGraphAnalysis(seed(), cfg({ nodeKinds: ['UseCaseUsage'] }));
    expect(g.nodes.every((n) => n.eClass === 'UseCaseUsage')).toBe(true);
    expect(g.nodes).toHaveLength(2);
    // Facets still report everything present, for the filter UI.
    expect(g.nodeKindsPresent.some((f) => f.eClass === 'PartUsage')).toBe(true);
  });

  it('Louvain clustering separates the two wired modules', () => {
    const g = buildGraphAnalysis(seed(), cfg({ clustering: 'louvain' }));
    expect(g.communityCount).toBeGreaterThanOrEqual(2);
    expect(g.modularity).toBeGreaterThan(0);
    const comm = (label: string) => g.nodes.find((n) => n.label === label)!.community;
    expect(comm('ctrl')).toBe(comm('actuator')); // same module
    expect(comm('ui')).toBe(comm('api'));
    expect(comm('ctrl')).not.toBe(comm('ui')); // different modules
  });

  it('colorBy=community recolors nodes by cluster + builds a cluster legend', () => {
    const g = buildGraphAnalysis(seed(), cfg({ colorBy: 'community', clustering: 'louvain' }));
    expect(g.legend.every((l) => l.label.startsWith('Cluster'))).toBe(true);
    const ctrl = g.nodes.find((n) => n.label === 'ctrl')!;
    const ui = g.nodes.find((n) => n.label === 'ui')!;
    expect(ctrl.color).not.toBe(ui.color);
  });

  it('sizeBy=pagerank uses the true relationship direction (a sink outranks its sources)', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const a = f.part('a', p.id).id;
    const b = f.part('b', p.id).id;
    const sink = f.part('sink', p.id).id;
    m.create('Dependency', { ownerId: p.id, source: [a], target: [sink] });
    m.create('Dependency', { ownerId: p.id, source: [b], target: [sink] });
    const g = buildGraphAnalysis(m, cfg({ sizeBy: 'pagerank' }));
    const size = (label: string) => g.nodes.find((n) => n.label === label)!.size;
    expect(size('sink')).toBeGreaterThan(size('a'));
    expect(size('sink')).toBeGreaterThan(size('b'));
  });

  it('sizeBy in-degree vs out-degree size opposite ends of a directed edge', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const a = f.part('a', p.id).id;
    const b = f.part('b', p.id).id;
    const sink = f.part('sink', p.id).id;
    m.create('Dependency', { ownerId: p.id, source: [a], target: [sink] });
    m.create('Dependency', { ownerId: p.id, source: [b], target: [sink] });
    // In-degree: the sink (2 incoming) is the biggest, its sources the smallest.
    const gi = buildGraphAnalysis(m, cfg({ sizeBy: 'in-degree' }));
    const sizeI = (l: string) => gi.nodes.find((n) => n.label === l)!.size;
    expect(sizeI('sink')).toBeGreaterThan(sizeI('a'));
    expect(sizeI('sink')).toBeGreaterThan(sizeI('b'));
    // Out-degree flips it: the sources emit an edge, the sink emits none.
    const go = buildGraphAnalysis(m, cfg({ sizeBy: 'out-degree' }));
    const sizeO = (l: string) => go.nodes.find((n) => n.label === l)!.size;
    expect(sizeO('a')).toBeGreaterThan(sizeO('sink'));
    expect(sizeO('b')).toBeGreaterThan(sizeO('sink'));
  });

  it('containment is opt-in — off by default, adds owner→child edges when enabled', () => {
    const base = buildGraphAnalysis(seed(), cfg());
    // Default: no containment edges (the parts are wired only by connections).
    expect(base.edges.some((e) => e.containment)).toBe(false);
    const withC = buildGraphAnalysis(seed(), cfg({ edgeKinds: ['ConnectionUsage', 'containment'] }));
    expect(withC.edges.some((e) => e.containment)).toBe(true);
  });

  it('is deterministic (same model → identical layout + communities)', () => {
    const m = seed();
    const a = buildGraphAnalysis(m, cfg());
    const b = buildGraphAnalysis(m, cfg());
    expect(a.nodes.map((n) => [n.id, n.x, n.y, n.community])).toEqual(
      b.nodes.map((n) => [n.id, n.x, n.y, n.community]),
    );
  });
});

describe('buildDSM', () => {
  it('orders elements into contiguous modules with colored blocks', () => {
    const dsm = buildDSM(seed(), cfg({ dsmOrder: 'louvain' }));
    expect(dsm.elements).toHaveLength(9);
    expect(dsm.modules.length).toBeGreaterThanOrEqual(2);
    // Every element belongs to exactly one module block, and blocks are contiguous.
    const covered = dsm.modules.reduce((s, m) => s + m.size, 0);
    expect(covered).toBe(dsm.elements.length);
  });

  it('cells carry an interaction weight (heatmap) + a relation symbol', () => {
    const dsm = buildDSM(seed(), cfg());
    expect(dsm.cells.length).toBeGreaterThan(0);
    expect(dsm.maxWeight).toBeGreaterThanOrEqual(1);
    // The satisfy edge (ctrl→Safety) yields a cell with the 'S' badge.
    const ctrlIdx = dsm.elements.findIndex((e) => e.label === 'ctrl');
    const reqIdx = dsm.elements.findIndex((e) => e.label === 'Safety');
    const satCell = dsm.cells.find((c) => c.row === ctrlIdx && c.col === reqIdx);
    expect(satCell?.symbol).toBe('S');
    expect(satCell?.kinds).toContain('Satisfy');
  });

  it('cuthill-mckee order is a permutation of all elements (no modules)', () => {
    const dsm = buildDSM(seed(), cfg({ dsmOrder: 'cuthill-mckee' }));
    expect(new Set(dsm.elements.map((e) => e.id)).size).toBe(9);
    expect(dsm.modules).toHaveLength(0);
  });
});

describe('categoryOf', () => {
  it('maps metaclasses to coarse categories', () => {
    expect(categoryOf('PartUsage')).toBe('block');
    expect(categoryOf('UseCaseUsage')).toBe('usecase');
    expect(categoryOf('RequirementUsage')).toBe('requirement');
    expect(categoryOf('ActionUsage')).toBe('action');
  });
});

describe('node size scaling controls (sizeScale / sizeContrast)', () => {
  // A hub wired to 3 leaves → hub degree 3 (the max), each leaf degree 1.
  function hub() {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const h = f.part('hub', p.id).id;
    for (const n of ['l0', 'l1', 'l2']) {
      const l = f.part(n, p.id).id;
      m.create('ConnectionUsage', { ownerId: p.id, source: [h], target: [l] });
    }
    return m;
  }
  const sizeOf = (g: ReturnType<typeof buildGraphAnalysis>, label: string) =>
    g.nodes.find((n) => n.label === label)!.size;

  it('sizeScale multiplies every node size by the common factor', () => {
    const m = hub();
    const g1 = buildGraphAnalysis(m, cfg({ sizeBy: 'degree' }));
    const g2 = buildGraphAnalysis(m, cfg({ sizeBy: 'degree', sizeScale: 2 }));
    for (const n of g1.nodes) {
      const s2 = g2.nodes.find((x) => x.id === n.id)!.size;
      expect(s2).toBeCloseTo(n.size * 2, 6);
    }
  });

  it('sizeContrast amplifies the small↔large spread; the largest node is invariant', () => {
    const m = hub();
    const lo = buildGraphAnalysis(m, cfg({ sizeBy: 'degree', sizeContrast: 1 }));
    const hi = buildGraphAnalysis(m, cfg({ sizeBy: 'degree', sizeContrast: 3 }));
    expect(sizeOf(hi, 'hub')).toBeCloseTo(sizeOf(lo, 'hub'), 6); // max node unchanged
    expect(sizeOf(hi, 'l0')).toBeLessThan(sizeOf(lo, 'l0')); // a smaller node shrinks
  });

  it('sizeScale also scales uniform sizing', () => {
    const g = buildGraphAnalysis(hub(), cfg({ sizeBy: 'uniform', sizeScale: 2 }));
    for (const n of g.nodes) expect(n.size).toBe(16); // 8 × 2
  });

  it('restyleNodeSizes (the store fast path) matches a full rebuild', () => {
    // The O(n) in-place remap used for the size sliders must be byte-identical
    // to recomputing the whole projection at the new scale/contrast.
    const m = hub();
    const base = buildGraphAnalysis(m, cfg({ sizeBy: 'degree' }));
    for (const [scale, contrast] of [[2.5, 3], [0.5, 1], [1, 0.5]] as const) {
      const fast = restyleNodeSizes(base, scale, contrast);
      const full = buildGraphAnalysis(m, cfg({ sizeBy: 'degree', sizeScale: scale, sizeContrast: contrast }));
      const byId = (g: ReturnType<typeof buildGraphAnalysis>) =>
        new Map(g.nodes.map((n) => [n.id, n.size]));
      const a = byId(fast);
      const b = byId(full);
      for (const [id, s] of a) expect(s).toBeCloseTo(b.get(id)!, 9);
    }
  });
});

/**
 * An unnamed requirement is labelled by its id. The id edit writes the short
 * name and REMOVES the legacy `attrs.reqId`; these two views read the legacy
 * key with no short-name fallback, so the label fell through to the metaclass
 * the moment an id was edited, and stayed that way until a save and reopen.
 */
describe('labels of an unnamed requirement', () => {
  const labels = (m: Model) => ({
    graph: buildGraphAnalysis(m, cfg()).nodes.map((n) => n.label),
    dsm: buildDSM(m, cfg()).elements.map((e) => e.label),
  });

  it('follow the id across an edit in the network view and the DSM', () => {
    const { model } = parseModel('package P {\n    requirement <R1>;\n    part def V;\n}');
    const req = model.ofKind('RequirementUsage')[0]!;
    expect(labels(model).graph).toContain('R1');
    expect(labels(model).dsm).toContain('R1');

    setRequirementShortId(model, req.id, 'R9');
    const after = labels(model);
    expect(after.graph).toContain('R9');
    expect(after.dsm).toContain('R9');
    expect(after.graph).not.toContain('RequirementUsage');
    expect(after.dsm).not.toContain('RequirementUsage');
  });

  it('prefer the short name the file keeps over a stale legacy id', () => {
    const m = new Model();
    const pkg = m.create('Package', { declaredName: 'P' });
    m.create('RequirementUsage', {
      declaredShortName: 'NEW',
      ownerId: pkg.id,
      attrs: { reqId: 'STALE' },
    });
    const { graph, dsm } = labels(m);
    expect(graph).toContain('NEW');
    expect(dsm).toContain('NEW');
    expect(graph).not.toContain('STALE');
    expect(dsm).not.toContain('STALE');
  });
});
