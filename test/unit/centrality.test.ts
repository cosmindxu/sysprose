import { describe, it, expect } from 'vitest';
import { elementCentrality, type CentralityElement } from '@diagram/index';

// A NODE carries no endpoints; an EDGE carries both. Classification is by
// endpoints (matching the Analysis view), NOT by metaclass name.
function node(id: string, extra: Partial<CentralityElement> = {}): CentralityElement {
  return { id, eClass: 'PartUsage', attrs: {}, ...extra };
}
function edge(id: string, source: string[], target: string[], eClass = 'Dependency'): CentralityElement {
  return { id, eClass, attrs: {}, source, target };
}

describe('elementCentrality (per-element PageRank)', () => {
  it('scores every user node and ranks them (competition rank)', () => {
    const els = [node('a'), node('b'), node('c'), edge('r1', ['a'], ['b']), edge('r2', ['a'], ['c'])];
    const c = elementCentrality(els);
    expect(c.nodeCount).toBe(3);
    expect(c.score.size).toBe(3);
    expect(c.score.get('b')!).toBeGreaterThan(c.score.get('a')!);
    // b and c tie (both pointed at by a): competition ranking, so 1, 1, 3.
    expect([...c.rank.values()].sort((x, y) => x - y)).toEqual([1, 1, 3]);
    expect(c.rank.get('b')).toBeLessThan(c.rank.get('a')!);
  });

  it('excludes library elements from the node set and edges', () => {
    const els = [node('u'), node('lib', { attrs: { isLibrary: true } }), edge('r', ['u'], ['lib'])];
    const c = elementCentrality(els);
    expect(c.nodeCount).toBe(1);
    expect(c.score.has('lib')).toBe(false);
    expect(c.score.has('u')).toBe(true);
  });

  it('classifies an endpoint-bearing USAGE as an edge, not a node', () => {
    // ConnectionUsage is NOT a RELATIONSHIP_KIND, but it carries endpoints — it
    // must contribute an edge (a→b) and NOT be a ranked node. This is the exact
    // case the Analysis view handles and the old isRelationship split got wrong.
    const els = [node('a'), node('b'), edge('conn', ['a'], ['b'], 'ConnectionUsage')];
    const c = elementCentrality(els);
    expect(c.score.has('conn')).toBe(false); // the connection is an edge, not a node
    expect(c.nodeCount).toBe(2);
    // b is pointed at by a via the connection → outranks a.
    expect(c.score.get('b')!).toBeGreaterThan(c.score.get('a')!);
  });

  it('excludes implicit and annotation elements from the node set', () => {
    const els = [
      node('a'),
      node('imp', { attrs: { implicit: true } }),
      node('doc', { eClass: 'Documentation' }),
      node('note', { eClass: 'Comment' }),
    ];
    const c = elementCentrality(els);
    expect(c.nodeCount).toBe(1);
    expect(c.score.has('a')).toBe(true);
    expect(c.score.has('imp')).toBe(false);
    expect(c.score.has('doc')).toBe(false);
    expect(c.score.has('note')).toBe(false);
  });

  it('drops self-loops and edges to non-nodes', () => {
    const els = [node('a'), edge('self', ['a'], ['a']), edge('ghost', ['a'], ['missing'])];
    const c = elementCentrality(els);
    expect(c.nodeCount).toBe(1);
    expect(c.score.get('a')).toBeCloseTo(1, 5);
  });

  it('returns an empty result for a model with no user nodes', () => {
    const c = elementCentrality([node('lib', { attrs: { isLibrary: true } })]);
    expect(c.nodeCount).toBe(0);
    expect(c.score.size).toBe(0);
    expect(c.rank.size).toBe(0);
  });

  it('gives a more-referenced node a higher score (hub)', () => {
    const els = [
      node('h'),
      node('a'),
      node('b'),
      node('c'),
      node('z'),
      edge('r1', ['a'], ['h']),
      edge('r2', ['b'], ['h']),
      edge('r3', ['c'], ['h']),
    ];
    const c = elementCentrality(els);
    expect(c.rank.get('h')).toBe(1);
    expect(c.score.get('h')!).toBeGreaterThan(c.score.get('z')!);
  });

  it('gives tied scores one rank (competition ranking), whatever the ids are', () => {
    // a and b point at h; nothing points at a, b or z: the three tie, so they share rank 2. Ids are random per load, so neither the
    // ids' order nor a reversal of them may change a rank.
    const build = (ids: string[]) => {
      const [h, a, b, z] = ids;
      const els = [node(h), node(a), node(b), node(z), edge('r1', [a], [h]), edge('r2', [b], [h])];
      return { h, a, b, z, c: elementCentrality(els) };
    };
    for (const ids of [['h', 'a', 'b', 'z'], ['z', 'b', 'a', 'h']]) {
      const { h, a, b, z, c } = build(ids);
      expect(c.score.get(a)).toBe(c.score.get(b));
      expect(c.rank.get(h)).toBe(1);
      expect(c.rank.get(a)).toBe(c.rank.get(b));
      expect(c.rank.get(a)).toBe(2);
      expect(c.rank.get(z)).toBe(2);
    }
  });
});
