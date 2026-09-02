/**
 * buildRequirementsTable — the pure projection behind the requirements-table
 * editor. Verifies hierarchy/outline numbering, scalar cells, and the LOCKED
 * reference direction (source = related element, target = requirement).
 */
import { describe, it, expect } from 'vitest';
import { Model, ModelFactory } from '@core/index';
import { buildRequirementsTable } from '@diagram/index';
import { parseModel, serializeModel } from '@text/index';

/** Seed: two top-level requirements, one nested; a part; satisfy + verify links. */
function seed() {
  const m = new Model();
  const f = new ModelFactory(m);
  const pkg = f.pkg('Sys');
  const r1 = f.requirement('MassReq', pkg.id, { reqId: 'R-1', text: 'mass < 2000' });
  const r1a = f.requirement('SubMass', r1.id, { reqId: 'R-1.1', text: 'dry mass < 1500' });
  const r2 = f.requirement('SpeedReq', pkg.id, { reqId: 'R-2', text: 'v > 100' });
  const part = f.partDef('Vehicle', pkg.id);
  // satisfy: source = satisfier (part), target = requirement (r1)
  const sat = f.satisfy(r1.id, part.id, pkg.id);
  // verify: same direction — source = element, target = requirement
  const ver = m.create('Verify', { ownerId: pkg.id, source: [part.id], target: [r2.id] });
  return { m, pkg, r1, r1a, r2, part, sat, ver };
}

describe('buildRequirementsTable', () => {
  it('lists requirements as rows with scalar cells from attrs', () => {
    const { m, r1 } = seed();
    const t = buildRequirementsTable(m);
    expect(t.rows).toHaveLength(3);
    const row = t.rows.find((r) => r.id === r1.id)!;
    expect(row.reqId).toBe('R-1');
    expect(row.name).toBe('MassReq');
    expect(row.text).toBe('mass < 2000');
    expect(t.scalarColumns.map((c) => c.key)).toEqual(['reqId', 'name', 'text']);
  });

  it('nests requirements by containment with outline numbers + depth', () => {
    const { m, r1, r1a, r2 } = seed();
    const t = buildRequirementsTable(m);
    const num = (id: string) => t.rows.find((r) => r.id === id)!;
    expect(num(r1.id).number).toBe('1');
    expect(num(r1.id).depth).toBe(0);
    expect(num(r1a.id).number).toBe('1.1');
    expect(num(r1a.id).depth).toBe(1);
    expect(num(r2.id).number).toBe('2');
    // A nested requirement appears once, right after its parent.
    const ids = t.rows.map((r) => r.id);
    expect(ids.indexOf(r1a.id)).toBe(ids.indexOf(r1.id) + 1);
  });

  it('resolves reference columns by relationship kind with source=element, target=requirement', () => {
    const { m, r1, r2, part, sat, ver } = seed();
    const t = buildRequirementsTable(m);
    const rowR1 = t.rows.find((r) => r.id === r1.id)!;
    const rowR2 = t.rows.find((r) => r.id === r2.id)!;
    // R1 satisfied by the part (via the Satisfy whose target is R1).
    expect(rowR1.refs.satisfiedBy).toHaveLength(1);
    expect(rowR1.refs.satisfiedBy[0].targetId).toBe(part.id);
    expect(rowR1.refs.satisfiedBy[0].relId).toBe(sat.id);
    expect(rowR1.refs.satisfiedBy[0].label).toBe('Vehicle');
    // R1 has no verify; R2 is verified by the part.
    expect(rowR1.refs.verifiedBy).toHaveLength(0);
    expect(rowR2.refs.verifiedBy).toHaveLength(1);
    expect(rowR2.refs.verifiedBy[0].targetId).toBe(part.id);
    expect(rowR2.refs.verifiedBy[0].relId).toBe(ver.id);
    // exposes all five reference columns.
    expect(t.refColumns.map((c) => c.key)).toEqual([
      'satisfiedBy',
      'verifiedBy',
      'refinedBy',
      'tracedTo',
      'derivedFrom',
    ]);
  });

  it('populates all five reference columns from TEXT-authored links (round-trip integration)', () => {
    // The parser workstream added verify/refine/trace/derive statements; a
    // text-authored model must light up the corresponding table columns, with
    // the referenced element on the requirement's row.
    const { model } = parseModel(`package P {
      requirement <'R-1'> Main;
      part def Comp;
      part def TestCase;
      requirement <'R-0'> Origin;
      satisfy Main by Comp;
      verify Main by TestCase;
      refine Main by Comp;
      trace Main to Comp;
      derive Main from Origin;
    }`);
    const t = buildRequirementsTable(model);
    const main = t.rows.find((r) => r.name === 'Main')!;
    expect(main.refs.satisfiedBy.map((r) => r.label)).toEqual(['Comp']);
    expect(main.refs.verifiedBy.map((r) => r.label)).toEqual(['TestCase']);
    expect(main.refs.refinedBy.map((r) => r.label)).toEqual(['Comp']);
    expect(main.refs.tracedTo.map((r) => r.label)).toEqual(['Comp']);
    expect(main.refs.derivedFrom.map((r) => r.label)).toEqual(['Origin']);
  });

  it('counts a usage-layer SatisfyRequirementUsage as a satisfier (matches analytics)', () => {
    const { m, r1, part } = seed();
    m.create('SatisfyRequirementUsage', { ownerId: m.get(r1.id)!.ownerId!, source: [part.id], target: [r1.id] });
    const t = buildRequirementsTable(m);
    // Both the factory Satisfy and the usage-layer satisfy show on the row.
    expect(t.rows.find((r) => r.id === r1.id)!.refs.satisfiedBy).toHaveLength(2);
  });

  it('a forward-referenced verify/derive statement leaves no permanent warning', () => {
    const { diagnostics } = parseModel(
      `package F { verify R by X; derive R from X; requirement R; part def X; }`,
    );
    expect(diagnostics.filter((d) => /Unresolved/.test(d.message))).toHaveLength(0);
  });

  it('round-trips requirement-relationship visibility', () => {
    const { model } = parseModel(`package P { requirement <'R'> R; part def X; private verify R by X; }`);
    expect(model.all().find((e) => e.eClass === 'Verify')!.attrs.visibility).toBe('private');
    expect(serializeModel(model)).toContain('private verify R by X;');
  });

  it('serializes a multi-endpoint requirement relationship as one statement per pair', () => {
    // Only reachable via API/JSON models; must not drop all but the first target.
    const m = new Model();
    const f = new ModelFactory(m);
    const pk = f.pkg('Q');
    const r1 = f.requirement('R1', pk.id, { reqId: 'A' });
    const r2 = f.requirement('R2', pk.id, { reqId: 'B' });
    const x = f.partDef('X', pk.id);
    m.create('Verify', { ownerId: pk.id, source: [x.id], target: [r1.id, r2.id] });
    const lines = serializeModel(m)
      .split('\n')
      .filter((l) => l.includes('verify'))
      .map((l) => l.trim());
    expect(lines).toEqual(['verify R1 by X;', 'verify R2 by X;']);
    // Re-parse reproduces both endpoints.
    const back = parseModel(serializeModel(m)).model;
    expect(back.all().filter((e) => e.eClass === 'Verify')).toHaveLength(2);
  });

  it('excludes standard-library requirements', () => {
    const { m, pkg } = seed();
    m.create('RequirementUsage', {
      declaredName: 'LibReq',
      ownerId: pkg.id,
      attrs: { isLibrary: true, reqId: 'LIB-1' },
    });
    const t = buildRequirementsTable(m);
    expect(t.rows.some((r) => r.name === 'LibReq')).toBe(false);
  });
});
