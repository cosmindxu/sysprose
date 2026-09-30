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
 *  - a model's layer packages read left to right as columns.
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
  TARGET_ASPECT,
  connectedPieces,
  intrinsicSize,
  packRows,
  thoroughnessFor,
} from '@diagram/layout';
import { keywordLabelsAreRepetition, REPEATED_KEYWORD_MIN } from '@diagram/edge-labels';
import { fitRouteToEnds, roundedPath, routeIsCurrent, routeLabelPoint } from '@diagram/edges';
import type { DiagramGraph, DiagramNode, Point, ViewKind } from '@diagram/types';

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
