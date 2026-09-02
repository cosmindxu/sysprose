/**
 * Connector feature-chain endpoint resolution (`connect a.p to b.p` where `p`
 * lives on the TYPE of `a`/`b`, not on the usage itself).
 *
 * The mapper materializes an IMPLICIT usage-scoped feature per chained segment
 * (attrs.implicit === true, redefining the type-owned prototype) so that:
 *  - distinct usages of the same type get DISTINCT endpoints (no self-edges),
 *  - the endpoint's owner is the USAGE (IBD edges land on usage nodes),
 *  - the serializer re-emits the relative path form (`connect a.p to b.p`),
 *    never the fully-qualified type-owned port (`T::p`).
 */
import { describe, it, expect } from 'vitest';
import { parseModel, serializeModel, resolveConnectorFeatureChains } from '@text/index';
import { buildDiagram } from '@diagram/index';
import { Model } from '@core/index';

const TYPES_FIRST = `package P {
    part def Battery { port pwrOut; }
    part def Pdb { port pwrIn; }
    part def Sys { part battery : Battery; part pdb : Pdb; }
    part sys : Sys { connection c connect battery.pwrOut to pdb.pwrIn; }
}`;

function connOf(model: Model) {
  const conn = model.all().find((e) => e.eClass === 'ConnectionUsage');
  expect(conn).toBeDefined();
  return conn!;
}

describe('connector feature-chain endpoints (types-first models)', () => {
  it('resolves connect a.port to b.port when ports live on the part definitions', () => {
    const { model } = parseModel(TYPES_FIRST);
    const conn = connOf(model);
    expect(conn.source?.length).toBe(1);
    expect(conn.target?.length).toBe(1);
    expect(conn.source![0]).not.toBe(conn.target![0]);
    expect(model.qualifiedName(conn.source![0])).toBe('P::sys::battery::pwrOut');
    expect(model.qualifiedName(conn.target![0])).toBe('P::sys::pdb::pwrIn');
    // Endpoints are usage-scoped implicit ports redefining the type-owned ones.
    const src = model.get(conn.source![0])!;
    expect(src.eClass).toBe('PortUsage');
    expect(src.attrs.implicit).toBe(true);
    const redef = model.children(src.id).find((c) => c.eClass === 'Redefinition');
    expect(redef).toBeDefined();
    expect(model.qualifiedName(redef!.target![0])).toBe('P::Battery::pwrOut');
  });

  it('same-type distinct usages resolve to DISTINCT endpoints (no self-edge)', () => {
    const src = `package Q {
        part def T { port p; }
        part def Sys { part a : T; part b : T; }
        part sys : Sys { connection k connect a.p to b.p; }
    }`;
    const { model } = parseModel(src);
    const conn = connOf(model);
    expect(conn.source![0]).toBeDefined();
    expect(conn.target![0]).toBeDefined();
    expect(conn.source![0]).not.toBe(conn.target![0]);
    expect(model.qualifiedName(conn.source![0])).toBe('Q::sys::a::p');
    expect(model.qualifiedName(conn.target![0])).toBe('Q::sys::b::p');

    // Interconnection diagram: the edge runs between ports owned by the a / b
    // usage nodes — not a self-loop, not on the definition T.
    const g = buildDiagram(model, 'interconnection');
    expect(g.edges).toHaveLength(1);
    const edge = g.edges[0];
    expect(edge.source).not.toBe(edge.target);
    const ownerName = (portId: string) => model.get(model.get(portId)!.ownerId!)!.declaredName;
    const owners = [ownerName(edge.source), ownerName(edge.target)].sort();
    expect(owners).toEqual(['a', 'b']);
    // Endpoint owners are usages (nested under sys), not the definition T.
    const defT = model.all().find((e) => e.declaredName === 'T' && e.eClass === 'PartDefinition')!;
    expect(model.get(edge.source)!.ownerId).not.toBe(defT.id);
    expect(model.get(edge.target)!.ownerId).not.toBe(defT.id);
  });

  it('resolves forward-declared local types and bare inherited ports (vehicle pattern)', () => {
    const src = `package V {
        part def Vehicle { port fuelIn; part engine : Engine; }
        part def Engine { port fuelOut; }
        part vehicle : Vehicle { connection fuelLine connect engine.fuelOut to fuelIn; }
    }`;
    const { model } = parseModel(src);
    const conn = connOf(model);
    expect(model.qualifiedName(conn.source![0])).toBe('V::vehicle::engine::fuelOut');
    // Bare `fuelIn` resolves through the ENCLOSING usage's type (Vehicle).
    expect(model.qualifiedName(conn.target![0])).toBe('V::vehicle::fuelIn');
    const g = buildDiagram(model, 'interconnection');
    expect(g.edges).toHaveLength(1);
  });

  it('round-trips: serializer re-emits the path form, and a re-parse is stable', () => {
    const { model } = parseModel(TYPES_FIRST);
    const text = serializeModel(model);
    expect(text).toContain('connect battery.pwrOut to pdb.pwrIn;');
    expect(text).not.toContain('P::Battery::pwrOut');
    // Implicit ports are never emitted as standalone declarations.
    expect(text.match(/port pwrOut/g)).toHaveLength(1); // only inside part def Battery
    expect(text.match(/port pwrIn/g)).toHaveLength(1);

    // Re-parse: identical structure (elements re-derived deterministically).
    const { model: model2 } = parseModel(text);
    const conn2 = connOf(model2);
    expect(model2.qualifiedName(conn2.source![0])).toBe('P::sys::battery::pwrOut');
    expect(model2.qualifiedName(conn2.target![0])).toBe('P::sys::pdb::pwrIn');
    expect(model2.all().length).toBe(model.all().length);
    // And the text is a fixpoint.
    expect(serializeModel(model2)).toBe(text);
  });

  it('a genuinely-unresolvable end degrades gracefully (warning + textual fallback)', () => {
    const src = `package R {
        part def T { port p; }
        part def Sys { part a : T; }
        part sys : Sys { connection c connect a.p to nope.missing; }
    }`;
    const { model, diagnostics } = parseModel(src);
    const conn = connOf(model);
    expect(model.qualifiedName(conn.source![0])).toBe('R::sys::a::p');
    expect(conn.target?.length ?? 0).toBe(0);
    expect(conn.attrs.targetRef).toBe('nope.missing');
    expect(diagnostics.some((d) => d.severity === 'warning' && d.message.includes('nope.missing'))).toBe(true);
    // The textual fallback survives serialization.
    expect(serializeModel(model)).toContain('connect a.p to nope.missing;');
    // A half-resolvable chain leaves no implicit debris on `a` beyond `p`.
    const a = model.all().find((e) => e.declaredName === 'a' && e.ownerId && model.get(e.ownerId)!.declaredName === 'sys');
    expect(a).toBeDefined();
    expect(model.children(a!.id).filter((c) => c.attrs.implicit === true)).toHaveLength(1);
  });

  it('produces ZERO false connection-end warnings when chains resolve', () => {
    const a = parseModel(TYPES_FIRST);
    expect(a.diagnostics.filter((d) => d.message.includes('connection end'))).toHaveLength(0);
    const b = parseModel(`package V {
        part def Vehicle { port fuelIn; part engine : Engine; }
        part def Engine { port fuelOut; }
        part vehicle : Vehicle { connection fuelLine connect engine.fuelOut to fuelIn; }
    }`);
    expect(b.diagnostics.filter((d) => d.message.includes('connection end'))).toHaveLength(0);
    // A genuinely-unresolvable end STILL warns (only stale ones are retracted).
    const c = parseModel(`package R {
        part def T { port p; }
        part def Sys { part a : T; }
        part sys : Sys { connection c connect a.p to nope.missing; }
    }`);
    expect(c.diagnostics.some((d) => d.message.includes("'nope.missing'"))).toBe(true);
    expect(c.diagnostics.some((d) => d.message.includes("'a.p'"))).toBe(false);
  });

  it('implicit-feature materialization does not change validation diagnostics', async () => {
    const { validate } = await import('@validation/index');
    const src = `package P {
        part def Battery { in port pwrOut; }
        part def Pdb { in port pwrIn; }
        part def Sys { part battery : Battery; part pdb : Pdb; }
        part sys : Sys { connection c connect battery.pwrOut to pdb.pwrIn; }
    }`;
    const { model } = parseModel(src);
    const implicitCount = model.all().filter((e) => e.attrs.implicit === true).length;
    expect(implicitCount).toBeGreaterThan(0);
    // No diagnostic is anchored on an implicit element.
    const diags = validate(model);
    for (const d of diags) {
      if (d.elementId) expect(model.get(d.elementId)?.attrs.implicit).not.toBe(true);
    }
  });

  it('implicit features have deterministic ids (stable across parses)', () => {
    const idsOf = (m: Model) =>
      m
        .all()
        .filter((e) => e.attrs.implicit === true)
        .map((e) => e.id)
        .sort();
    const a = idsOf(parseModel(TYPES_FIRST).model);
    const b = idsOf(parseModel(TYPES_FIRST).model);
    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(b);
    expect(a.every((id) => id.startsWith('impl-'))).toBe(true);
  });

  it('re-running the post-type-binding pass is idempotent', () => {
    const { model } = parseModel(TYPES_FIRST);
    const before = model.all().length;
    expect(resolveConnectorFeatureChains(model)).toBe(0); // nothing left to resolve
    resolveConnectorFeatureChains(model);
    expect(model.all().length).toBe(before);
  });

  it('resolveConnectorFeatureChains binds endpoints whose types resolve only later', () => {
    // Simulate the library case: strip the connection's endpoints back to text
    // and re-run the exported pass — it must rebuild the same implicit chain.
    const { model } = parseModel(TYPES_FIRST);
    const conn = connOf(model);
    const srcQ = model.qualifiedName(conn.source![0]);
    model.update(conn.id, { source: [], target: [] });
    model.setAttrs(conn.id, { sourceRef: 'battery.pwrOut', targetRef: 'pdb.pwrIn' });
    expect(resolveConnectorFeatureChains(model)).toBe(2);
    const again = connOf(model);
    expect(model.qualifiedName(again.source![0])).toBe(srcQ);
    expect(again.attrs.sourceRef).toBeUndefined();
  });
});
