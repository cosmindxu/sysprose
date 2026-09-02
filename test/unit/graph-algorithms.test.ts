/**
 * Pure network-analysis primitives behind the Graph Analysis view + DSM.
 * Correctness + DETERMINISM are the load-bearing properties here.
 */
import { describe, it, expect } from 'vitest';
import {
  type Graph,
  connectedComponents,
  louvain,
  labelPropagation,
  modularity,
  degreeCentrality,
  directedDegree,
  pageRank,
  forceLayout,
  circularLayout,
  gridLayout,
  dsmOrderByCommunity,
  cuthillMcKee,
} from '@diagram/graph-algorithms';

/** Two triangles joined by a single bridge edge — the textbook 2-community graph. */
function twoTriangles(): Graph {
  return {
    nodes: ['a', 'b', 'c', 'd', 'e', 'f'],
    edges: [
      ['a', 'b'], ['b', 'c'], ['c', 'a'], // triangle 1
      ['d', 'e'], ['e', 'f'], ['f', 'd'], // triangle 2
      ['c', 'd'], // bridge
    ].map(([source, target]) => ({ source, target, weight: 1 })),
  };
}

function numCommunities(m: Map<string, number>): number {
  return new Set(m.values()).size;
}

describe('connectedComponents', () => {
  it('separates disjoint subgraphs', () => {
    const g: Graph = {
      nodes: ['a', 'b', 'c', 'd'],
      edges: [{ source: 'a', target: 'b', weight: 1 }, { source: 'c', target: 'd', weight: 1 }],
    };
    const c = connectedComponents(g);
    expect(numCommunities(c)).toBe(2);
    expect(c.get('a')).toBe(c.get('b'));
    expect(c.get('a')).not.toBe(c.get('c'));
  });
  it('an isolated node is its own component', () => {
    const g: Graph = { nodes: ['a', 'b', 'lonely'], edges: [{ source: 'a', target: 'b', weight: 1 }] };
    expect(numCommunities(connectedComponents(g))).toBe(2);
  });
});

describe('louvain', () => {
  it('finds the two triangle communities with positive modularity', () => {
    const g = twoTriangles();
    const comm = louvain(g);
    expect(numCommunities(comm)).toBe(2);
    expect(comm.get('a')).toBe(comm.get('b'));
    expect(comm.get('a')).toBe(comm.get('c'));
    expect(comm.get('d')).toBe(comm.get('e'));
    expect(comm.get('a')).not.toBe(comm.get('d'));
    expect(modularity(g, comm)).toBeGreaterThan(0.3);
  });

  it('is deterministic (same input → identical labels)', () => {
    const g = twoTriangles();
    expect([...louvain(g).entries()]).toEqual([...louvain(g).entries()]);
  });

  it('returns 0-based contiguous community indices', () => {
    const labels = new Set(louvain(twoTriangles()).values());
    expect([...labels].sort()).toEqual([0, 1]);
  });

  it('handles an empty graph and an edgeless graph', () => {
    expect(louvain({ nodes: [], edges: [] }).size).toBe(0);
    const solo = louvain({ nodes: ['a', 'b'], edges: [] });
    expect(numCommunities(solo)).toBe(2);
  });

  it('beats the all-in-one-community partition on modularity', () => {
    const g = twoTriangles();
    const one = new Map(g.nodes.map((n) => [n, 0]));
    expect(modularity(g, louvain(g))).toBeGreaterThan(modularity(g, one));
  });

  it('modularity counts self-loops consistently (a lone self-loop → Q = 0)', () => {
    const g: Graph = { nodes: ['a'], edges: [{ source: 'a', target: 'a', weight: 1 }] };
    expect(modularity(g, new Map([['a', 0]]))).toBeCloseTo(0, 9);
  });
});

describe('labelPropagation', () => {
  it('separates disjoint clusters and is deterministic', () => {
    // LPA can merge small bridged graphs (a known instability); on cleanly
    // separated clusters its result is well-defined.
    const g = twoTriangles();
    const noBridge: Graph = { nodes: g.nodes, edges: g.edges.filter((e) => !(e.source === 'c' && e.target === 'd')) };
    const comm = labelPropagation(noBridge);
    expect(numCommunities(comm)).toBe(2);
    expect(comm.get('a')).toBe(comm.get('c'));
    expect(comm.get('a')).not.toBe(comm.get('f'));
    expect([...labelPropagation(noBridge).entries()]).toEqual([...comm.entries()]);
  });
});

describe('centrality', () => {
  it('degree centrality reflects weighted degree', () => {
    const g: Graph = {
      nodes: ['hub', 'x', 'y', 'z'],
      edges: [
        { source: 'hub', target: 'x', weight: 1 },
        { source: 'hub', target: 'y', weight: 1 },
        { source: 'hub', target: 'z', weight: 1 },
      ],
    };
    const d = degreeCentrality(g);
    expect(d.get('hub')).toBe(3);
    expect(d.get('x')).toBe(1);
  });

  it('pageRank sums to 1 and ranks a sink above a source', () => {
    const g: Graph = {
      nodes: ['a', 'b', 'c'],
      edges: [
        { source: 'a', target: 'c', weight: 1 },
        { source: 'b', target: 'c', weight: 1 },
      ],
    };
    const pr = pageRank(g);
    const sum = [...pr.values()].reduce((s, v) => s + v, 0);
    expect(sum).toBeCloseTo(1, 6);
    expect(pr.get('c')!).toBeGreaterThan(pr.get('a')!);
  });
});

describe('layouts', () => {
  it('forceLayout is deterministic and pulls connected nodes closer than unconnected ones', () => {
    const g: Graph = {
      nodes: ['a', 'b', 'far'],
      edges: [{ source: 'a', target: 'b', weight: 1 }],
    };
    const p1 = forceLayout(g, { iterations: 200 });
    const p2 = forceLayout(g, { iterations: 200 });
    expect([...p1.entries()]).toEqual([...p2.entries()]); // deterministic
    const dist = (x: string, y: string) => Math.hypot(p1.get(x)!.x - p1.get(y)!.x, p1.get(x)!.y - p1.get(y)!.y);
    expect(dist('a', 'b')).toBeLessThan(dist('a', 'far'));
  });

  it('forceLayout places two triangle communities into two separated clusters', () => {
    const g = twoTriangles();
    const p = forceLayout(g, { iterations: 400 });
    const centroid = (ids: string[]) => ({
      x: ids.reduce((s, i) => s + p.get(i)!.x, 0) / ids.length,
      y: ids.reduce((s, i) => s + p.get(i)!.y, 0) / ids.length,
    });
    const c1 = centroid(['a', 'b', 'c']);
    const c2 = centroid(['d', 'e', 'f']);
    const spread = (ids: string[], c: { x: number; y: number }) =>
      Math.max(...ids.map((i) => Math.hypot(p.get(i)!.x - c.x, p.get(i)!.y - c.y)));
    const between = Math.hypot(c1.x - c2.x, c1.y - c2.y);
    // The two clusters' centroids are farther apart than either cluster's radius.
    expect(between).toBeGreaterThan(spread(['a', 'b', 'c'], c1));
  });

  it('circular + grid layouts position every node', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    expect(circularLayout(ids).size).toBe(5);
    expect(gridLayout(ids).size).toBe(5);
  });
});

describe('DSM ordering', () => {
  it('dsmOrderByCommunity makes module members contiguous', () => {
    const g = twoTriangles();
    const { order, module } = dsmOrderByCommunity(g, louvain(g));
    expect(order).toHaveLength(6);
    // Each module occupies a contiguous run in the order.
    const runs = order.map((n) => module.get(n)!);
    const changes = runs.filter((m, i) => i > 0 && m !== runs[i - 1]).length;
    expect(changes).toBe(1); // exactly one module→module transition
  });

  it('cuthillMcKee returns a permutation of all nodes', () => {
    const order = cuthillMcKee(twoTriangles());
    expect(new Set(order)).toEqual(new Set(twoTriangles().nodes));
    expect(order).toHaveLength(6);
  });
});

describe('directedDegree', () => {
  // a→hub (w2), b→hub (w1), hub→c (w1): hub is a heavy sink, c a pure sink.
  const g: Graph = {
    nodes: ['a', 'b', 'hub', 'c'],
    edges: [
      { source: 'a', target: 'hub', weight: 2 },
      { source: 'b', target: 'hub', weight: 1 },
      { source: 'hub', target: 'c', weight: 1 },
    ],
  };

  it('sums weighted in-/out-degree honouring edge direction; total = in + out', () => {
    const { in: inD, out: outD, total } = directedDegree(g);
    expect(inD.get('hub')).toBe(3); // 2 + 1 incoming
    expect(outD.get('hub')).toBe(1); // 1 outgoing
    expect(total.get('hub')).toBe(4);
    expect(inD.get('a')).toBe(0);
    expect(outD.get('a')).toBe(2);
    expect(total.get('a')).toBe(2);
    expect(inD.get('c')).toBe(1);
    expect(outD.get('c')).toBe(0);
    for (const n of g.nodes) expect(total.get(n)).toBe((inD.get(n) ?? 0) + (outD.get(n) ?? 0));
  });

  it('on a self-loop-free graph, total matches the undirected degreeCentrality', () => {
    const { total } = directedDegree(g);
    const dc = degreeCentrality(g);
    for (const n of g.nodes) expect(total.get(n)).toBe(dc.get(n));
  });

  it('a self-loop counts toward in-, out-, AND total degree', () => {
    const { in: inD, out: outD, total } = directedDegree({
      nodes: ['x'],
      edges: [{ source: 'x', target: 'x', weight: 3 }],
    });
    expect(inD.get('x')).toBe(3);
    expect(outD.get('x')).toBe(3);
    expect(total.get('x')).toBe(6); // in + out — the self-loop is not dropped
  });
});
