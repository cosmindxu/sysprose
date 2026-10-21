/**
 * Readability of laid-out diagrams — the properties the layout promises,
 * checked on the geometry it returns (after Sun & Wong's layout criteria for
 * UML diagrams, IWPC 2005):
 *
 *  - no box overlaps another (C9), and no edge runs through a box it does not
 *    connect (C9) — edges follow ELK's orthogonal routes (C12);
 *  - every view flows left to right (C11), and a graph of many pieces is packed
 *    into rows about as wide as a screen, not one strip;
 *  - edge labels sit clear of every box and of each other;
 *  - boxes are wide enough for their text;
 *  - a label repeated on every line is dropped and the lines joined (C1, C3);
 *  - the tree grows one opened branch at a time;
 *  - a model's layer packages read left to right as columns, each headed by its
 *    package's name;
 *  - a hub that many dependency lines end on leads its piece, when that clearly
 *    cuts crossings.
 */

import { describe, expect, it } from 'vitest';
import { buildSampleModel } from '@core/index';
import { parseModel } from '@text/index';
import {
  buildDiagram,
  declutterLabels,
  edgeKeywordFor,
  edgeLabelText,
  edgeStyleFor,
  layoutDiagram,
  svgFromDiagram,
} from '@diagram/index';
import {
  HUB_MAX_NODES,
  HUB_MIN_CROSSINGS_SAVED,
  TARGET_ASPECT,
  connectedPieces,
  countCrossings,
  dependencyHubs,
  hubEdges,
  intrinsicSize,
  packRows,
  thoroughnessFor,
} from '@diagram/layout';
import { keywordLabelsAreRepetition, REPEATED_KEYWORD_MIN } from '@diagram/edge-labels';
import {
  COLUMN_HEADER_MAX_H,
  COLUMN_HEADER_MIN_H,
  COLUMN_LABEL_SCREEN_PX,
  COLUMN_STRIP_H,
  COLUMN_STRIP_LABEL_PX,
  columnHeaderHeight,
  columnLabelSize,
  columnLabelSizeAt,
  columnLabelSizeFor,
  columnSpans,
  columnStripCells,
  fitColumnLabel,
} from '@diagram/column-headers';
import { fitRouteToEnds, roundedPath, routeIsCurrent, routeLabelPoint } from '@diagram/edges';
import type { DiagramColumn, DiagramGraph, DiagramNode, Point, ViewKind } from '@diagram/types';

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Absolute box of every node (nested positions are parent-relative). */
function absoluteBoxes(g: DiagramGraph): Map<string, Box> {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const out = new Map<string, Box>();
  const abs = (n: DiagramNode): Point => {
    const p = n.parentId ? byId.get(n.parentId) : undefined;
    const base = p ? abs(p) : { x: 0, y: 0 };
    return { x: base.x + n.position!.x, y: base.y + n.position!.y };
  };
  for (const n of g.nodes) {
    const a = abs(n);
    out.set(n.id, { x: a.x, y: a.y, w: n.size!.w, h: n.size!.h });
  }
  return out;
}

function ancestors(g: DiagramGraph, id: string): Set<string> {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const s = new Set<string>();
  for (let p = byId.get(id)?.parentId; p; p = byId.get(p)?.parentId) s.add(p);
  return s;
}

const overlap = (a: Box, b: Box, m = 0.5): boolean =>
  Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > m && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > m;

/** The readability invariants every laid-out graph must meet. */
function expectReadable(g: DiagramGraph): void {
  const boxes = absoluteBoxes(g);
  const ids = [...boxes.keys()];
  // C9: no two boxes overlap, unless one contains the other.
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i]!;
      const b = ids[j]!;
      if (ancestors(g, a).has(b) || ancestors(g, b).has(a)) continue;
      expect(overlap(boxes.get(a)!, boxes.get(b)!), `${a} overlaps ${b}`).toBe(false);
    }
  }
  const portOwner = new Map<string, string>();
  for (const n of g.nodes) for (const p of n.ports ?? []) portOwner.set(p.id, n.id);
  for (const e of g.edges) {
    const route = e.route;
    expect(route, `edge ${e.id} was routed`).toBeDefined();
    // C12: every segment is horizontal or vertical.
    for (let k = 1; k < route!.length; k++) {
      const a = route![k - 1]!;
      const b = route![k]!;
      expect(Math.abs(a.x - b.x) < 0.5 || Math.abs(a.y - b.y) < 0.5, `edge ${e.id} segment ${k} is diagonal`).toBe(true);
    }
    // C9: the route enters no box but its own ends (and their containers).
    const s = portOwner.get(e.source) ?? e.source;
    const t = portOwner.get(e.target) ?? e.target;
    const allowed = new Set([s, t, ...ancestors(g, s), ...ancestors(g, t)]);
    for (let k = 1; k < route!.length; k++) {
      const a = route![k - 1]!;
      const b = route![k]!;
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 4));
      for (let q = 0; q <= steps; q++) {
        const p = { x: a.x + ((b.x - a.x) * q) / steps, y: a.y + ((b.y - a.y) * q) / steps };
        for (const [id, box] of boxes) {
          if (allowed.has(id)) continue;
          const inside = p.x > box.x + 1 && p.x < box.x + box.w - 1 && p.y > box.y + 1 && p.y < box.y + box.h - 1;
          expect(inside, `edge ${e.id} runs through ${id}`).toBe(false);
        }
      }
    }
  }
  // Labels: clear of every box but the frames their edge lives in, and of each
  // other (centre ± an estimated box).
  const labelBoxes = g.edges
    .filter((e) => e.labelAt && edgeLabelText(e))
    .map((e) => {
      const text = edgeLabelText(e)!;
      const w = text.length * 6 + 10;
      const s = portOwner.get(e.source) ?? e.source;
      const t = portOwner.get(e.target) ?? e.target;
      const frames = new Set([...ancestors(g, s), ...ancestors(g, t)]);
      return { id: e.id, frames, box: { x: e.labelAt!.x - w / 2, y: e.labelAt!.y - 7.5, w, h: 15 } };
    });
  for (const l of labelBoxes) {
    for (const [id, box] of boxes) {
      if (l.frames.has(id)) continue;
      expect(overlap(l.box, box, 1), `label of ${l.id} on ${id}`).toBe(false);
    }
  }
  for (let i = 0; i < labelBoxes.length; i++) {
    for (let j = i + 1; j < labelBoxes.length; j++) {
      expect(overlap(labelBoxes[i]!.box, labelBoxes[j]!.box, 1), `labels ${labelBoxes[i]!.id} / ${labelBoxes[j]!.id}`).toBe(false);
    }
  }
}

describe('packRows — pieces in reading order, about a screen wide', () => {
  it('places boxes left to right while the row has room', () => {
    const { offsets } = packRows([{ w: 100, h: 50 }, { w: 100, h: 80 }, { w: 100, h: 50 }], 20, 10);
    expect(offsets.map((o) => o.y)).toEqual([0, 0, 0]);
    expect(offsets.map((o) => o.x)).toEqual([0, 110, 220]);
  });

  it('starts the next row below the tallest box of the last one', () => {
    const { offsets } = packRows([{ w: 100, h: 50 }, { w: 100, h: 80 }, { w: 100, h: 50 }], 1.6, 10);
    expect(offsets[0]).toEqual({ x: 0, y: 0 });
    const wrapped = offsets.find((o) => o.y > 0)!;
    expect(wrapped.x).toBe(0);
    expect(wrapped.y).toBeGreaterThanOrEqual(50 + 10);
  });

  it('packs a hundred equal pieces into a block of roughly the target aspect', () => {
    const { width, height, offsets } = packRows(Array.from({ length: 100 }, () => ({ w: 180, h: 60 })));
    expect(width / height).toBeGreaterThan(TARGET_ASPECT / 2);
    expect(width / height).toBeLessThan(TARGET_ASPECT * 2);
    for (let i = 0; i < offsets.length; i++) {
      for (let j = i + 1; j < offsets.length; j++) {
        const a = { ...offsets[i]!, w: 180, h: 60 };
        const b = { ...offsets[j]!, w: 180, h: 60 };
        expect(overlap(a, b)).toBe(false);
      }
    }
  });
});

describe('connectedPieces', () => {
  it('joins boxes an edge connects and leaves the rest apart', () => {
    const g: DiagramGraph = {
      viewKind: 'general',
      nodes: ['a', 'b', 'c', 'd'].map((id) => ({ id, elementId: id, kind: 'PartDefinition', label: id, data: {} })),
      edges: [{ id: 'ab', source: 'a', target: 'b', kind: 'composite' }],
    };
    const pieces = connectedPieces(g);
    expect(pieces).toHaveLength(3);
    expect(pieces.find((p) => p.nodeIds.has('a'))!.nodeIds.has('b')).toBe(true);
    expect(pieces.find((p) => p.nodeIds.has('a'))!.edges.map((e) => e.id)).toEqual(['ab']);
  });
});

describe('layoutDiagram — readable geometry', () => {
  /** A flat graph shaped like a real view: a few chains and many loose boxes. */
  function manyPieces(): DiagramGraph {
    const nodes: DiagramNode[] = [];
    const edges: DiagramGraph['edges'] = [];
    for (let c = 0; c < 6; c++) {
      for (let k = 0; k < 4; k++) {
        nodes.push({ id: `c${c}n${k}`, elementId: `c${c}n${k}`, kind: 'StateUsage', label: `State${c}_${k}`, data: {} });
        if (k > 0) edges.push({ id: `c${c}e${k}`, source: `c${c}n${k - 1}`, target: `c${c}n${k}`, kind: 'transition', label: `go${k}` });
      }
    }
    for (let i = 0; i < 60; i++) {
      nodes.push({ id: `loose${i}`, elementId: `loose${i}`, kind: 'ActionUsage', label: `looseAction${i}`, data: {} });
    }
    return { nodes, edges, viewKind: 'state' };
  }

  it('packs many pieces into a block, not a strip', async () => {
    const g = await layoutDiagram(manyPieces());
    const boxes = [...absoluteBoxes(g).values()];
    const w = Math.max(...boxes.map((b) => b.x + b.w)) - Math.min(...boxes.map((b) => b.x));
    const h = Math.max(...boxes.map((b) => b.y + b.h)) - Math.min(...boxes.map((b) => b.y));
    expect(w / h).toBeGreaterThan(0.5);
    expect(w / h).toBeLessThan(4);
  });

  it('meets every readability invariant on a many-piece graph', async () => {
    expectReadable(await layoutDiagram(manyPieces()));
  });

  it('flows each chain left to right', async () => {
    const g = await layoutDiagram(manyPieces());
    const boxes = absoluteBoxes(g);
    for (const e of g.edges) expect(boxes.get(e.target)!.x).toBeGreaterThan(boxes.get(e.source)!.x);
  });

  it('meets every readability invariant in every graph view of the sample model', async () => {
    const m = buildSampleModel();
    for (const v of ['general', 'interconnection', 'action', 'state', 'requirement', 'tree', 'parametric', 'case'] as ViewKind[]) {
      expectReadable(await layoutDiagram(buildDiagram(m, v)));
    }
  });

  it('records where the end boxes were when each edge was routed', async () => {
    const g = await layoutDiagram(manyPieces());
    const boxes = absoluteBoxes(g);
    for (const e of g.edges) {
      expect(e.routeFrom!.source).toEqual({ x: boxes.get(e.source)!.x, y: boxes.get(e.source)!.y });
      expect(e.routeFrom!.target).toEqual({ x: boxes.get(e.target)!.x, y: boxes.get(e.target)!.y });
    }
  });
});

describe('SVG export — the shared picture matches the canvas', () => {
  it('draws each edge along its laid-out route, not straight through the boxes', async () => {
    const g = await layoutDiagram(buildDiagram(buildSampleModel(), 'general'));
    const doc = new DOMParser().parseFromString(svgFromDiagram(g), 'image/svg+xml');
    for (const e of g.edges) {
      const path = [...doc.querySelectorAll('path[data-edge-id]')].find((p) => p.getAttribute('data-edge-id') === e.id)!;
      const d = path.getAttribute('d')!;
      const first = e.route![0]!;
      expect(d.startsWith(`M ${Math.round(first.x * 100) / 100} ${Math.round(first.y * 100) / 100}`)).toBe(true);
      expect(d).not.toMatch(/[Cc]/);
    }
  });
});

describe('intrinsicSize — boxes fit their text', () => {
  it('grows with the name and never drops below the node minimum', () => {
    const short = intrinsicSize({ id: 'a', elementId: 'a', kind: 'PartDefinition', label: 'A', data: { name: 'A' } });
    const long = intrinsicSize({
      id: 'b',
      elementId: 'b',
      kind: 'PartDefinition',
      label: 'x',
      data: { name: 'MovingObjectDetectionAndClassificationSoftware' },
    });
    expect(short.w).toBeGreaterThanOrEqual(140);
    expect(long.w).toBeGreaterThan(short.w);
    expect(long.w).toBeGreaterThanOrEqual('MovingObjectDetectionAndClassificationSoftware'.length * 7);
  });

  it('leaves an ellipse (use case) room around its text, and draws control nodes as symbols', () => {
    const data = { name: 'OperatorSupervisionOfTheSwarm' };
    const box = intrinsicSize({ id: 'a', elementId: 'a', kind: 'PartDefinition', label: '', data });
    const ellipse = intrinsicSize({ id: 'b', elementId: 'b', kind: 'UseCaseDefinition', label: '', data });
    expect(ellipse.w).toBeGreaterThan(box.w + 40);
    const initial = intrinsicSize({ id: 'c', elementId: 'c', kind: 'InitialNode', label: '', data: {} });
    expect(initial.w).toBeLessThan(60);
  });

  it('adds a line per compartment row', () => {
    const bare = intrinsicSize({ id: 'a', elementId: 'a', kind: 'PartDefinition', label: '', data: { name: 'P' } });
    const rows = intrinsicSize({
      id: 'a',
      elementId: 'a',
      kind: 'PartDefinition',
      label: '',
      data: { name: 'P', attributes: [{ name: 'mass', type: 'Real' }, { name: 'span', type: 'Real' }, { name: 'x' }, { name: 'y' }] },
    });
    expect(rows.h).toBeGreaterThan(bare.h + 3 * 14 - 1);
  });
});

describe('edge labels — the «keyword», and when it is only repetition', () => {
  it('agrees with the renderer on every kind', () => {
    for (const k of ['satisfy', 'allocate', 'trace', 'verify', 'refine', 'derive', 'include', 'dependency', 'composite', 'transition']) {
      expect(edgeKeywordFor(k)).toBe(edgeStyleFor(k).keyword);
    }
  });

  it('calls a single keyword kind repeated on many lines repetition, and a mix information', () => {
    const many = Array.from({ length: REPEATED_KEYWORD_MIN }, () => ({ kind: 'satisfy' }));
    expect(keywordLabelsAreRepetition(many)).toBe(true);
    expect(keywordLabelsAreRepetition(many.slice(1))).toBe(false);
    expect(keywordLabelsAreRepetition([...many, { kind: 'allocate' }])).toBe(false);
  });

  it('drops the repeated labels and joins the lines when laying out', async () => {
    const nodes: DiagramNode[] = [
      { id: 'part', elementId: 'part', kind: 'PartUsage', label: 'part', data: {} },
      ...Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, elementId: `r${i}`, kind: 'RequirementUsage', label: `R${i}`, data: {} })),
    ];
    const edges = nodes.slice(1).map((n) => ({ id: `s${n.id}`, source: 'part', target: n.id, kind: 'satisfy' }));
    const g = await layoutDiagram({ nodes, edges, viewKind: 'requirement' });
    expect(g.edges.every((e) => e.hideKeyword && !edgeLabelText(e))).toBe(true);
    expectReadable(g);
  });
});

describe('tree view — one opened branch at a time', () => {
  const m = buildSampleModel();
  const root = m.all().find((e) => e.declaredName === 'VehicleModel')!;

  it('shows only the root, with how much it holds, when nothing is open', () => {
    const g = buildDiagram(m, 'tree', undefined, { treeExpanded: new Set() });
    expect(g.nodes.map((n) => n.label)).toEqual(['VehicleModel']);
    expect(g.nodes[0]!.data.treeHidden).toBeGreaterThan(0);
  });

  it('grows under the opened elements only', () => {
    const g = buildDiagram(m, 'tree', undefined, { treeExpanded: new Set([root.id]) });
    const labels = g.nodes.map((n) => n.label);
    expect(labels).toContain('vehicle');
    expect(labels).not.toContain('engine');
    const vehicle = g.nodes.find((n) => n.label === 'vehicle')!;
    expect(vehicle.data.treeHidden).toBeGreaterThan(0);
  });

  it('draws the whole tree when no expansion is given', () => {
    expect(buildDiagram(m, 'tree').nodes.map((n) => n.label)).toContain('engine');
  });
});

describe('general view — a layered model reads layer by layer, left to right', () => {
  const { model } = parseModel(`package System {
    package OA {
        part def Operator;
        part def Mission;
    }
    package SA {
        part def Swarm;
        part def Drone;
    }
    package PA {
        part def Airframe;
        part def Radio;
    }
}`);

  it('tags every box with its layer package, in package order', () => {
    const g = buildDiagram(model, 'general');
    const lane = (name: string) => g.nodes.find((n) => n.label === name)!.data.layoutPartition;
    expect(lane('Operator')).toBe(0);
    expect(lane('Swarm')).toBe(1);
    expect(lane('Radio')).toBe(2);
  });

  it('tags nothing when the diagram is scoped inside one package', () => {
    const sa = model.all().find((e) => e.declaredName === 'SA')!;
    const g = buildDiagram(model, 'general', sa.id);
    expect(g.nodes.every((n) => n.data.layoutPartition === undefined)).toBe(true);
    expect(g.partitions).toBeUndefined();
  });

  it('names the packages in the order the boxes are tagged', () => {
    const g = buildDiagram(model, 'general');
    expect(g.partitions!.map((p) => p.label)).toEqual(['OA', 'SA', 'PA']);
    for (const n of g.nodes) {
      const p = g.partitions![n.data.layoutPartition as number]!;
      expect(model.qualifiedName(n.elementId).startsWith(`System::${p.label}::`)).toBe(true);
    }
  });
});

describe('general view — each column of a layered model is headed by its package', () => {
  // Chains across the packages make connected pieces that span two or three
  // of them; Loner has no edge and is packed with the loose boxes.
  const { model } = parseModel(`package System {
    package OA {
        part def Operator;
        part def Mission;
    }
    package SA {
        part def Swarm :> OA::Operator;
        part def Drone;
        part def Relay :> OA::Mission;
    }
    package PA {
        part def Airframe :> SA::Drone;
        part def Radio;
        part def Dish :> SA::Relay;
        part def Loner;
    }
}`);

  it('puts one header over each package of a piece that spans several, in column order', async () => {
    const g = await layoutDiagram(buildDiagram(model, 'general'));
    const cols = g.columns!;
    // Three pieces span packages: Mission-Relay-Dish (OA, SA, PA), Operator-Swarm
    // (OA, SA) and Drone-Airframe (SA, PA).
    expect(cols.map((c) => c.label).sort()).toEqual(['OA', 'OA', 'PA', 'PA', 'SA', 'SA', 'SA']);
    // One piece's headers (the id ends with the piece's first box) read left to
    // right in package order.
    const pieces = new Map<string, string[]>();
    for (const c of [...cols].sort((a, b) => a.x - b.x)) {
      const piece = c.id.split(':')[2]!;
      pieces.set(piece, [...(pieces.get(piece) ?? []), c.label]);
    }
    expect([...pieces.values()].sort()).toEqual([['OA', 'SA'], ['OA', 'SA', 'PA'], ['SA', 'PA']]);
    for (const c of cols) {
      expect(c.w).toBeGreaterThan(0);
      expect(c.h).toBeGreaterThanOrEqual(32);
      expect(c.fontSize).toBeLessThanOrEqual(c.h);
      // The piece runs below its band: that is where the frozen strip's copy of the header leaves.
      expect(c.bottom).toBeGreaterThan(c.y + c.h);
    }
  });

  it('spans exactly its package\'s boxes, and sits above them', async () => {
    const g = await layoutDiagram(buildDiagram(model, 'general'));
    const boxes = absoluteBoxes(g);
    for (const c of g.columns!) {
      // The boxes under this header: the package's, in the header's piece, whose x-range is its own.
      const under = g.nodes.filter((n) => {
        const b = boxes.get(n.id)!;
        return n.elementId && model.qualifiedName(n.elementId).includes(`::${c.label}::`) && b.x >= c.x - 0.5 && b.x + b.w <= c.x + c.w + 0.5 && b.y >= c.y + c.h;
      });
      expect(under.length, `${c.label} header has boxes under it`).toBeGreaterThan(0);
      expect(Math.min(...under.map((n) => boxes.get(n.id)!.x))).toBeCloseTo(c.x, 0);
      expect(Math.max(...under.map((n) => boxes.get(n.id)!.x + boxes.get(n.id)!.w))).toBeCloseTo(c.x + c.w, 0);
    }
  });

  it('overlaps no box and no other header', async () => {
    const g = await layoutDiagram(buildDiagram(model, 'general'));
    const boxes = [...absoluteBoxes(g).values()];
    const cols = g.columns!;
    for (const c of cols) {
      for (const b of boxes) expect(overlap(c, b), `header ${c.label} overlaps a box`).toBe(false);
    }
    for (let i = 0; i < cols.length; i++) {
      for (let j = i + 1; j < cols.length; j++) expect(overlap(cols[i]!, cols[j]!), `headers ${i} and ${j} overlap`).toBe(false);
    }
    expectReadable(g);
  });

  it('gives a piece inside one package, and loose boxes, no header', async () => {
    // Every box of this model is alone, or in a pair inside one package.
    const { model: apart } = parseModel(`package System {
    package OA { part def A; part def B :> A; }
    package SA { part def C; part def D :> C; }
}`);
    const g = await layoutDiagram(buildDiagram(apart, 'general'));
    expect(g.nodes.every((n) => typeof n.data.layoutPartition === 'number')).toBe(true);
    expect(g.columns).toBeUndefined();
    // And an unpartitioned view has none.
    const sa = model.all().find((e) => e.declaredName === 'SA')!;
    expect((await layoutDiagram(buildDiagram(model, 'general', sa.id))).columns).toBeUndefined();
  });

  it('heads a view scoped to a package that holds several, not a wrapper or several top-level packages', async () => {
    const layers = 'package Layers { package OA { part def X; } package SA { part def Y :> OA::X; } }';
    const { model: wrapped } = parseModel(`package Top { ${layers} }`);
    const headsOf = async (m: typeof wrapped, scope?: string): Promise<string[]> => {
      const root = scope ? m.all().find((e) => e.declaredName === scope)!.id : undefined;
      return ((await layoutDiagram(buildDiagram(m, 'general', root))).columns ?? []).map((c) => c.label);
    };
    // One wrapper package around the layers: its only child is Layers, so the whole model is not layered.
    expect(await headsOf(wrapped)).toEqual([]);
    expect(await headsOf(wrapped, 'Top')).toEqual([]);
    // Scoped to the package that holds the layers, it is, and is headed.
    expect(await headsOf(wrapped, 'Layers')).toEqual(['OA', 'SA']);
    // A single layer package is not layered.
    expect(await headsOf(wrapped, 'OA')).toEqual([]);
    // Nor are two top-level packages: the view has no single root to take the columns from.
    const { model: roots } = parseModel('package OA { part def X; } package SA { part def Y :> OA::X; }');
    expect(await headsOf(roots)).toEqual([]);
  });

  it('draws them in the SVG export, inside its viewBox', async () => {
    const g = await layoutDiagram(buildDiagram(model, 'general'));
    const svg = svgFromDiagram(g);
    expect(svg).toContain('<g data-layer="column-headers">');
    expect(svg.match(/data-column-id=/g)!.length).toBe(g.columns!.length);
    for (const label of ['OA', 'SA', 'PA']) expect(svg).toContain(`>${label}</text>`);
    const [x, y, w, h] = /viewBox="([^"]+)"/.exec(svg)![1]!.split(' ').map(Number) as [number, number, number, number];
    for (const c of g.columns!) {
      expect(c.x).toBeGreaterThanOrEqual(x);
      expect(c.y).toBeGreaterThanOrEqual(y);
      expect(c.x + c.w).toBeLessThanOrEqual(x + w);
      expect(c.y + c.h).toBeLessThanOrEqual(y + h);
    }
  });
});

describe('general view — a hub that many dependency lines end on leads its piece', () => {
  /**
   * The drone-swarm model's operational layer in small: two members each have an
   * activity allocated to them per step, the two members' activities share a
   * definition, and a few hazards and use cases hold the members' type.
   */
  function hubText(steps: number, hazards: number, cases: number, wrap = false): string {
    const each = (n: number, f: (i: number) => string): string => Array.from({ length: n }, (_, i) => f(i)).join('\n    ');
    const body = `part def Member;
    part memberA : Member;
    part memberB : Member;
    ${each(cases, (i) => `use case def Case${i} { ref holder : Member; }`)}
    ${each(hazards, (i) => `requirement hazard${i} { ref holder : Member; }`)}
    ${each(steps, (i) => `action def Step${i};`)}
    ${each(steps, (i) => `action alpha${i} : Step${i};\n    action bravo${i} : Step${i};`)}
    ${each(steps, (i) => `allocate alpha${i} to memberA;\n    allocate bravo${i} to memberB;`)}
    ${each(hazards, (i) => `satisfy hazard${i} by alpha${i};`)}`;
    return wrap ? `package Layers {\n  package Ops {\n    ${body}\n  }\n  package Logic {\n    part def Controller;\n  }\n}\n` : `package Watch {\n    ${body}\n}\n`;
  }
  const generalOf = (text: string): DiagramGraph => buildDiagram(parseModel(text).model, 'general');
  const crossingsOf = (g: DiagramGraph): number => {
    const routes = new Map(g.edges.filter((e) => e.route).map((e) => [e.id, e.route!]));
    return countCrossings(routes, new Map(g.edges.map((e) => [e.id, [e.source, e.target] as [string, string]])));
  };
  const box = (g: DiagramGraph, label: string): Box => absoluteBoxes(g).get(g.nodes.find((n) => n.label === label)!.id)!;
  /** A route point sits on the outline of `b`. */
  const onOutline = (p: Point, b: Box): boolean => {
    const inX = p.x >= b.x - 1 && p.x <= b.x + b.w + 1;
    const inY = p.y >= b.y - 1 && p.y <= b.y + b.h + 1;
    return inX && inY && (Math.abs(p.x - b.x) < 1 || Math.abs(p.x - b.x - b.w) < 1 || Math.abs(p.y - b.y) < 1 || Math.abs(p.y - b.y - b.h) < 1);
  };

  it('names the boxes that min or more dependency lines end on, and no other line counts', () => {
    const into = (target: string, kind: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `${kind}:${target}:${i}`, target, kind }));
    const hubs = dependencyHubs([
      ...into('memberA', 'allocate', 4),
      ...into('R', 'satisfy', 2),
      ...into('Member', 'typed-by', 6),
      ...into('Owner', 'composite', 5),
    ]);
    expect([...hubs.keys()]).toEqual(['memberA']);
    expect(hubs.get('memberA')).toHaveLength(4);
    expect([...dependencyHubs(into('R', 'satisfy', 2), 2).keys()]).toEqual(['R']);
  });

  it('draws the hub first, its lines fanning out to the right, and leaves fewer crossings', async () => {
    const g0 = generalOf(hubText(8, 3, 6));
    const g = await layoutDiagram(g0);
    expectReadable(g);
    // The hubs sit left of every activity allocated to them; the lines still run source -> hub.
    for (const [hub, who] of [['memberA', 'alpha'], ['memberB', 'bravo']] as const) {
      const hubBox = box(g, hub);
      for (let i = 0; i < 8; i++) expect(box(g, `${who}${i}`).x, `${who}${i} is right of ${hub}`).toBeGreaterThan(hubBox.x + hubBox.w);
      const hubId = g.nodes.find((n) => n.label === hub)!.id;
      for (const e of g.edges.filter((x) => x.kind === 'allocate' && x.target === hubId)) {
        const src = absoluteBoxes(g).get(e.source)!;
        expect(onOutline(e.route![0]!, src), `${e.id} starts on its source`).toBe(true);
        expect(onOutline(e.route![e.route!.length - 1]!, hubBox), `${e.id} ends on its hub`).toBe(true);
      }
    }
    // The same graph laid out the usual way, every line source -> target (one layering forced, so no hub leads).
    const usualWay = await layoutDiagram(g0, { elkOptions: { 'elk.layered.layering.strategy': 'NETWORK_SIMPLEX' } });
    expect(box(usualWay, 'memberA').x).toBeGreaterThan(box(usualWay, 'alpha0').x);
    expect(crossingsOf(g)).toBeLessThanOrEqual(crossingsOf(usualWay) - HUB_MIN_CROSSINGS_SAVED);
  }, 60_000);

  it('keeps the usual direction where drawing from the hub saves too few crossings', async () => {
    const g = await layoutDiagram(generalOf(hubText(4, 2, 3)));
    expectReadable(g);
    for (let i = 0; i < 4; i++) expect(box(g, `alpha${i}`).x).toBeLessThan(box(g, 'memberA').x);
  }, 30_000);

  it('keeps the usual direction where both drawings cross nothing, though the hub-led one costs less', async () => {
    // Three parts that three or more lines end on, in a ring of allocations among them. Drawn either way no
    // line crosses another; drawn from the hubs, many more lines run right to left.
    const text = `package Y {
      part h1; part h2; part h3;
      part a; part b; part c; part d; part e; part f;
      allocate a to h1; allocate b to h1; allocate c to h1;
      allocate d to h2; allocate e to h2; allocate f to h2;
      allocate h1 to h3; allocate h2 to h3; allocate a to h3;
      allocate h3 to h1;
      allocate d to a; allocate e to b; allocate f to c;
      allocate a to d; allocate b to e; allocate c to f;
    }`;
    const g0 = generalOf(text);
    expect(connectedPieces(g0).flatMap((p) => [...hubEdges(g0, p)]).length).toBeGreaterThan(0);
    const backward = (g: DiagramGraph): number => g.edges.filter((e) => e.route && e.route.at(-1)!.x < e.route[0]!.x - 1).length;
    const g = await layoutDiagram(g0);
    const usualWay = await layoutDiagram(g0, { elkOptions: { 'elk.layered.layering.strategy': 'NETWORK_SIMPLEX' } });
    expectReadable(g);
    expect(crossingsOf(usualWay)).toBe(0);
    expect(backward(g)).toBeLessThanOrEqual(backward(usualWay));
  }, 30_000);

  it('tries the hubs only in a General view with no layer columns, of at most HUB_MAX_NODES boxes', () => {
    const linesOf = (text: string): { lines: string[]; boxes: number } => {
      const g = generalOf(text);
      const pieces = connectedPieces(g);
      return { lines: pieces.flatMap((p) => [...hubEdges(g, p)]), boxes: Math.max(...pieces.map((p) => p.nodeIds.size)) };
    };
    // memberA's and memberB's eight allocations each.
    expect(linesOf(hubText(8, 3, 6)).lines).toHaveLength(16);
    expect(linesOf(hubText(8, 3, 6, true)).lines).toEqual([]);
    // The drone-swarm model's largest layer has about 160 boxes; the cap is 200.
    expect(HUB_MAX_NODES).toBe(200);
    const near = linesOf(hubText(59, 3, 6));
    expect(near.boxes).toBeGreaterThan(160);
    expect(near.boxes).toBeLessThanOrEqual(HUB_MAX_NODES);
    expect(near.lines).toHaveLength(118);
    const over = linesOf(hubText(70, 3, 6));
    expect(over.boxes).toBeGreaterThan(HUB_MAX_NODES);
    expect(over.lines).toEqual([]);
  });

  it('keeps a layered model\'s columns in package order', async () => {
    const g = await layoutDiagram(generalOf(hubText(8, 3, 6, true)));
    const lane = (label: string) => g.nodes.find((n) => n.label === label)!.data.layoutPartition;
    expect([lane('memberA'), lane('Controller')]).toEqual([0, 1]);
    for (let i = 0; i < 8; i++) expect(box(g, `alpha${i}`).x).toBeLessThan(box(g, 'memberA').x);
  });
});

describe('column headers — size', () => {
  it('grows with the piece, between a floor and a ceiling', () => {
    expect(columnHeaderHeight(300)).toBe(COLUMN_HEADER_MIN_H);
    expect(columnHeaderHeight(5000)).toBe(200);
    expect(columnHeaderHeight(1_000_000)).toBe(COLUMN_HEADER_MAX_H);
  });

  it('keeps the label readable from far out, within its band', () => {
    const col = { fontSize: columnLabelSize(COLUMN_HEADER_MAX_H) };
    expect(columnLabelSizeAt(col, 1)).toBe(COLUMN_LABEL_SCREEN_PX);
    expect(columnLabelSizeAt(col, 2)).toBe(COLUMN_LABEL_SCREEN_PX);
    expect(columnLabelSizeAt(col, 0.1) * 0.1).toBeCloseTo(COLUMN_LABEL_SCREEN_PX, 5);
    expect(columnLabelSizeAt(col, 0.001)).toBe(col.fontSize);
  });

  it('cuts a label that cannot fit its column with an ellipsis', () => {
    expect(fitColumnLabel('OA', 100, 18)).toBe('OA');
    const cut = fitColumnLabel('SurveillanceDroneSwarm', 100, 18);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut.length).toBeLessThan('SurveillanceDroneSwarm'.length);
  });

  it('shrinks a name wider than its column before cutting it, to a floor', () => {
    const name = 'SurveillanceDroneSwarm';
    expect(columnLabelSizeFor('OA', 300, 18)).toBe(18);
    const snug = columnLabelSizeFor(name, 200, 18);
    expect(snug).toBeLessThan(18);
    expect(snug).toBeGreaterThan(18 * 0.6);
    expect(columnLabelSizeFor(name, 20, 18)).toBeCloseTo(18 * 0.6, 5);
  });

  it('names a column only where a piece spans two packages or more', () => {
    expect(columnSpans([{ partition: 1, x: 0, w: 100 }, { partition: 1, x: 200, w: 100 }])).toEqual([]);
    expect(
      columnSpans([
        { partition: 2, x: 400, w: 100 },
        { partition: 0, x: 0, w: 100 },
        { partition: 0, x: 20, w: 150 },
      ]),
    ).toEqual([
      { partition: 0, x0: 0, x1: 170 },
      { partition: 2, x0: 400, x1: 500 },
    ]);
  });
});

describe('column headers — the frozen strip, at the drone swarm\'s size', () => {
  // The whole drone-swarm General view: a main piece of five columns about
  // 19,000 px tall, and sixteen headers over four smaller pieces packed in a row
  // below it. At 1400x900 the fit zoom is about 0.021.
  const col = (id: string, x: number, w: number, y: number, bottom: number): DiagramColumn => ({
    id, elementId: id, label: id, x, y, w, h: 640, bottom, fontSize: 352,
  });
  const main = [0, 1, 2, 3, 4].map((i) => col(`main${i}`, i * 12_000, 11_800, 0, 19_000));
  const rest = [0, 1, 2, 3].flatMap((p) =>
    [0, 1, 2, 3].map((i) => col(`rest${p}${i}`, p * 15_000 + i * 3_500, 3_400, 19_500, 25_000)),
  );
  const columns = [...main, ...rest];
  const stripTop = 46;
  const fit = { x: 100, y: stripTop, zoom: 0.021 };
  const overlaps = (cells: ReturnType<typeof columnStripCells>): boolean =>
    cells.some((a, i) => cells.slice(i + 1).some((b) => a.left < b.left + b.width && b.left < a.left + a.width && Math.abs(a.top - b.top) < COLUMN_STRIP_H));

  it('draws its labels in screen space at a size that reads, whatever the zoom', () => {
    expect(columns).toHaveLength(21);
    expect(COLUMN_STRIP_LABEL_PX).toBeGreaterThanOrEqual(9);
    expect(COLUMN_STRIP_LABEL_PX).toBeLessThanOrEqual(COLUMN_STRIP_H);
  });

  it('names the top row\'s five columns at the whole model\'s Fit, each wide enough for its label', () => {
    const cells = columnStripCells(columns, fit, 1400, stripTop);
    expect(cells.map((c) => c.label)).toEqual(main.map((c) => c.id));
    for (const c of cells) {
      expect(c.width).toBeGreaterThanOrEqual(200);
      expect(c.top).toBe(0);
    }
    expect(overlaps(cells)).toBe(false);
  });

  it('keeps a column\'s header at the top while its piece runs beneath, clipped to the canvas', () => {
    // Panned 9,000 px down the main piece at zoom 0.5: its columns are 6,000 px wide on screen.
    const view = { x: -5_000, y: stripTop - 9_000 * 0.5, zoom: 0.5 };
    const cells = columnStripCells(columns, view, 1400, stripTop);
    expect(cells.map((c) => c.label)).toEqual(['main0', 'main1']);
    for (const c of cells) {
      expect(c.top).toBe(0);
      expect(c.left).toBeGreaterThanOrEqual(0);
      expect(c.left + c.width).toBeLessThanOrEqual(1400);
    }
    // Zoomed in on one column, the column's header still names it.
    expect(columnStripCells(columns, { x: -100, y: stripTop - 5_000, zoom: 1 }, 1400, stripTop).map((c) => c.label)).toEqual(['main0']);
  });

  it('leaves with the bottom of its piece, and the next row\'s headers come in as theirs arrives', () => {
    // The main piece's bottom edge `bottomOnScreen` px below the strip's top.
    const at = (bottomOnScreen: number) =>
      columnStripCells(columns, { x: 100, y: stripTop + bottomOnScreen - 19_000 * 0.021, zoom: 0.021 }, 1400, stripTop);
    const mainTops = (cells: ReturnType<typeof at>) => cells.filter((c) => c.label.startsWith('main')).map((c) => c.top);
    expect(mainTops(at(COLUMN_STRIP_H))).toEqual([0, 0, 0, 0, 0]);
    expect(mainTops(at(COLUMN_STRIP_H / 2))).toEqual(Array(5).fill(-COLUMN_STRIP_H / 2));
    expect(mainTops(at(0))).toEqual([]);
    // The second row begins 500 diagram px (10.5 px) below: its headers come in as the first row's go, and never lie over them.
    for (const b of [COLUMN_STRIP_H, COLUMN_STRIP_H / 2, 0, -5]) expect(overlaps(at(b))).toBe(false);
    expect(at(0).map((c) => c.label)).toEqual(rest.map((c) => c.id));
  });

  it('leaves a band that is on screen below the strip and tall enough to read to the band', () => {
    // Zoom 1: the 640 px band is on screen from the strip's top down.
    expect(columnStripCells(columns, { x: 100, y: stripTop, zoom: 1 }, 1400, stripTop)).toEqual([]);
    // Once panned past its top the strip takes the header over.
    expect(columnStripCells(columns, { x: 100, y: stripTop - 1, zoom: 1 }, 1400, stripTop).length).toBeGreaterThan(0);
  });

  it('skips a column too narrow on screen to hold its label', () => {
    const tiny = [col('tiny', 0, 800, 0, 1_000)];
    expect(columnStripCells(tiny, fit, 1400, stripTop)).toEqual([]);
  });
});

describe('edge routes — drawing and fitting', () => {
  it('draws a rounded orthogonal path through every point', () => {
    const d = roundedPath([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 40 }, { x: 100, y: 40 }]);
    expect(d.startsWith('M 0 0')).toBe(true);
    expect(d.endsWith('L 100 40')).toBe(true);
    expect(d).toContain('Q 50 0');
  });

  it('puts the label on the middle of the longest segment', () => {
    expect(routeLabelPoint([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 100 }])).toEqual({ x: 10, y: 50 });
  });

  it('moves the ends onto the real anchors and keeps every segment orthogonal', () => {
    const route = [{ x: 0, y: 10 }, { x: 40, y: 10 }, { x: 40, y: 60 }, { x: 90, y: 60 }];
    const fitted = fitRouteToEnds(route, { x: 0, y: 13 }, { x: 90, y: 57 });
    expect(fitted[0]).toEqual({ x: 0, y: 13 });
    expect(fitted[fitted.length - 1]).toEqual({ x: 90, y: 57 });
    for (let k = 1; k < fitted.length; k++) {
      const a = fitted[k - 1]!;
      const b = fitted[k]!;
      expect(a.x === b.x || a.y === b.y).toBe(true);
    }
  });

  it('turns a straight route between misaligned anchors into a step', () => {
    const fitted = fitRouteToEnds([{ x: 0, y: 0 }, { x: 100, y: 0 }], { x: 0, y: 0 }, { x: 100, y: 30 });
    expect(fitted).toHaveLength(4);
    for (let k = 1; k < fitted.length; k++) {
      expect(fitted[k - 1]!.x === fitted[k]!.x || fitted[k - 1]!.y === fitted[k]!.y).toBe(true);
    }
  });

  it('knows a route is stale once an end box has moved', () => {
    const from = { source: { x: 0, y: 0 }, target: { x: 200, y: 0 } };
    expect(routeIsCurrent(from, { x: 0, y: 0 }, { x: 200, y: 0 })).toBe(true);
    expect(routeIsCurrent(from, { x: 0, y: 0 }, { x: 260, y: 30 })).toBe(false);
    expect(routeIsCurrent(undefined, { x: 0, y: 0 }, { x: 200, y: 0 })).toBe(false);
  });
});

describe('declutterLabels — dense scatter plots', () => {
  const dots = Array.from({ length: 400 }, (_, i) => ({
    id: `n${i}`,
    label: `element${i}`,
    x: (i % 20) * 10,
    y: Math.floor(i / 20) * 10,
    size: i === 7 ? 6 : 2,
  }));
  const view = { x: -10, y: -10, w: 220, h: 220 };

  it('never places two labels over each other', () => {
    const placed = declutterLabels(dots, view, 1);
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) expect(overlap(placed[i]!, placed[j]!, 0)).toBe(false);
    }
  });

  it('labels the selection and the largest node first', () => {
    const placed = declutterLabels(dots, view, 1, 11, 'n300').map((p) => p.id);
    expect(placed[0]).toBe('n300');
    expect(placed).toContain('n7');
  });

  it('shows more labels as the reader zooms in', () => {
    const out = declutterLabels(dots, view, 1).length;
    const zoomedIn = declutterLabels(dots, view, 0.1).length;
    expect(zoomedIn).toBeGreaterThan(out);
  });
});

describe('thoroughnessFor', () => {
  it('spends full effort on small pieces and little on huge ones', () => {
    expect(Number(thoroughnessFor(20))).toBeGreaterThan(Number(thoroughnessFor(1000)));
  });
});

describe('flows, state-machine starts and constraint expressions', () => {
  const { model } = parseModel(`package P {
    part def Worker {
        port inp;
        port outp;
    }
    action produce { out item made; }
    action consume { in item taken; }
    flow handOver of Widget from produce.made to consume.taken;
    part def Widget;
    state def Modes {
        entry; then Idle;
        state Idle;
        state Busy;
        transition first Idle then Busy;
    }
    constraint { widgetCount <= 12 }
}`);

  it('draws an object flow between the actions at its ends, labelled with what flows', () => {
    const g = buildDiagram(model, 'action');
    const flows = g.edges.filter((e) => e.kind === 'flow');
    expect(flows).toHaveLength(1);
    const name = (id: string) => g.nodes.find((n) => n.id === id)!.label;
    expect([name(flows[0]!.source), name(flows[0]!.target)]).toEqual(['produce', 'consume']);
    expect(flows[0]!.label).toBe('Widget');
  });

  it('leaves a state machine\'s start point out of the action view', () => {
    const g = buildDiagram(model, 'action');
    expect(g.nodes.map((n) => n.label)).toEqual(expect.arrayContaining(['produce', 'consume']));
    expect(g.nodes.every((n) => !/Initial|Entry/.test(n.kind))).toBe(true);
  });

  it('gives a constraint box room for its expression', () => {
    const plain = intrinsicSize({ id: 'a', elementId: 'a', kind: 'ConstraintUsage', label: '', data: { name: 'c' } });
    const withExpr = intrinsicSize({
      id: 'b',
      elementId: 'b',
      kind: 'ConstraintUsage',
      label: '',
      data: { name: 'c', attrs: { expression: 'coordination.areaUnderWatchFraction >= 0.9 and coordination.coverageLossAfterMemberLossFraction <= 0.25' } },
    });
    expect(withExpr.h).toBeGreaterThan(plain.h);
    expect(withExpr.w).toBeLessThanOrEqual(420 + 1);
  });
});

