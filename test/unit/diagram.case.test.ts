/**
 * Unit tests for the case-view builder ({@link buildDiagram} with `viewKind:
 * 'case'`) ≈ SysML v2 Case / Use-Case diagram.
 *
 * Covers: the case usage as the frame node; `actor`/`subject`/`objective`
 * features rendered as associated nodes with role-kinded edges; `include`d use
 * cases rendered as nodes wired by `include` edges; `satisfy`/`verify` links to
 * requirements; and that the empty `grid` projection is well-formed (the graph
 * builder defers grid to GridView).
 */

import { describe, expect, it } from 'vitest';
import { Model, ModelFactory } from '@core/index';
import { buildDiagram } from '@diagram/index';

/** A use-case model: withdrawCash with actor/subject/objective, an include, and a satisfy. */
function useCaseModel() {
  const m = new Model();
  const f = new ModelFactory(m);
  const pkg = f.pkg('ATM');

  const uc = m.create('UseCaseUsage', { declaredName: 'withdrawCash', ownerId: pkg.id });
  const actor = m.create('PartUsage', {
    declaredName: 'customer',
    ownerId: uc.id,
    attrs: { caseRole: 'actor' },
  });
  const subject = m.create('ReferenceUsage', {
    declaredName: 'atm',
    ownerId: uc.id,
    attrs: { caseRole: 'subject' },
  });
  const objective = m.create('RequirementUsage', {
    declaredName: 'dispenseCash',
    ownerId: uc.id,
    attrs: { caseRole: 'objective' },
  });

  // Included use case + the IncludeUseCaseUsage that wires it.
  const authenticate = m.create('UseCaseUsage', { declaredName: 'authenticate', ownerId: pkg.id });
  const inc = m.create('IncludeUseCaseUsage', {
    declaredName: 'includeAuth',
    ownerId: uc.id,
    source: [uc.id],
    target: [authenticate.id],
  });

  // A requirement the use case satisfies.
  const req = f.requirement('cashAvailable', pkg.id, { reqId: 'R1' });
  const sat = f.satisfy(req.id, uc.id, pkg.id);

  return {
    m,
    ids: {
      uc: uc.id,
      actor: actor.id,
      subject: subject.id,
      objective: objective.id,
      authenticate: authenticate.id,
      inc: inc.id,
      req: req.id,
      sat: sat.id,
    },
  };
}

describe('buildDiagram — case view', () => {
  const { m, ids } = useCaseModel();
  const g = buildDiagram(m, 'case');

  it('projects the case view kind', () => {
    expect(g.viewKind).toBe('case');
  });

  it('renders the use case as a frame node', () => {
    const frame = g.nodes.find((n) => n.id === ids.uc)!;
    expect(frame).toBeTruthy();
    expect(frame.kind).toBe('UseCaseUsage');
    expect(frame.data.isFrame).toBe(true);
    expect(frame.data.isCase).toBe(true);
    expect(frame.label).toBe('withdrawCash');
  });

  it('renders actor/subject/objective role features as nodes', () => {
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    expect(byId.get(ids.actor)!.data.caseRole).toBe('actor');
    expect(byId.get(ids.subject)!.data.caseRole).toBe('subject');
    expect(byId.get(ids.objective)!.data.caseRole).toBe('objective');
  });

  it('draws a role-kinded association edge from the case to each role feature', () => {
    const roleEdge = (target: string) => g.edges.find((e) => e.source === ids.uc && e.target === target)!;
    expect(roleEdge(ids.actor).kind).toBe('actor');
    expect(roleEdge(ids.subject).kind).toBe('subject');
    expect(roleEdge(ids.objective).kind).toBe('objective');
  });

  it('renders the included use case as a node and an include edge', () => {
    const included = g.nodes.find((n) => n.id === ids.authenticate)!;
    expect(included).toBeTruthy();
    expect(included.data.included).toBe(true);
    const incEdge = g.edges.find((e) => e.kind === 'include')!;
    expect(incEdge.source).toBe(ids.uc);
    expect(incEdge.target).toBe(ids.authenticate);
    expect(incEdge.elementId).toBe(ids.inc);
  });

  it('surfaces the satisfied requirement with a satisfy edge', () => {
    const reqNode = g.nodes.find((n) => n.id === ids.req)!;
    expect(reqNode).toBeTruthy();
    const satEdge = g.edges.find((e) => e.kind === 'satisfy')!;
    expect(satEdge.source).toBe(ids.uc);
    expect(satEdge.target).toBe(ids.req);
    expect(satEdge.elementId).toBe(ids.sat);
  });

  it('scopes the frame set to case-kind elements only (no stray boxes)', () => {
    // No relationship element (Satisfy/FeatureTyping) leaks in as a node.
    for (const n of g.nodes) {
      expect(n.kind).not.toBe('Satisfy');
      expect(n.kind).not.toBe('IncludeUseCaseUsage');
    }
  });

  it('defers the grid view to a non-throwing empty graph', () => {
    const grid = buildDiagram(m, 'grid');
    expect(grid.viewKind).toBe('grid');
    expect(grid.nodes).toEqual([]);
    expect(grid.edges).toEqual([]);
  });
});
