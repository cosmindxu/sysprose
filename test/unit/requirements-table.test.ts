/**
 * buildRequirementsTable — the pure projection behind the requirements-table
 * editor. Verifies hierarchy/outline numbering, scalar cells, and the LOCKED
 * reference direction (source = related element, target = requirement).
 */
import { describe, it, expect } from 'vitest';
import { Model, ModelFactory } from '@core/index';
import {
  buildRequirementsTable,
  REQUIREMENT_ATTR_COLUMNS,
  REQUIREMENT_REF_COLUMNS,
  REQUIREMENT_SCALAR_COLUMNS,
} from '@diagram/index';
import { parseModel, serializeModel } from '@text/index';
import { setRequirementAttr } from '@semantics/index';

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

  it('reads the ID cell from the slot the file keeps, falling back to the legacy one', () => {
    // The cell read `attrs.reqId` alone while the file is written from
    // `declaredShortName`, so an id edited in the native slot showed the stale
    // legacy copy — and a natively named requirement showed nothing.
    const m = new Model();
    const pkg = m.create('Package', { declaredName: 'P' });
    const native = m.create('RequirementUsage', {
      declaredName: 'native',
      declaredShortName: 'N-1',
      ownerId: pkg.id,
    });
    const both = m.create('RequirementUsage', {
      declaredName: 'both',
      declaredShortName: 'NEW',
      ownerId: pkg.id,
      attrs: { reqId: 'STALE' },
    });
    const legacy = m.create('RequirementUsage', {
      declaredName: 'legacy',
      ownerId: pkg.id,
      attrs: { reqId: 'L-1' },
    });
    const rows = buildRequirementsTable(m).rows;
    const idOf = (id: string) => rows.find((r) => r.id === id)!.reqId;
    expect(idOf(native.id)).toBe('N-1');
    expect(idOf(both.id)).toBe('NEW');
    expect(idOf(legacy.id)).toBe('L-1');
  });

  it('labels a chip by the short name the file keeps before a stale legacy id', () => {
    // The chip is the related element's best label; an unnamed requirement
    // labels by its id, and the id edit removes the legacy key — so a chip
    // that read the legacy key first showed the pre-edit id.
    const { m, pkg, r1 } = seed();
    const parent = m.create('RequirementUsage', {
      declaredShortName: 'NEW',
      ownerId: pkg.id,
      attrs: { reqId: 'STALE' },
    });
    m.create('Derive', { ownerId: pkg.id, source: [parent.id], target: [r1.id] });
    const row = buildRequirementsTable(m).rows.find((r) => r.id === r1.id)!;
    expect(row.refs.derivedFrom!.map((ref) => ref.label)).toEqual(['NEW']);
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

/**
 * The facet columns — the kind, and the nine management attributes.
 *
 * The table is where a requirement is read as a ROW rather than as an element,
 * so a facet that exists in the model and not in the row is a facet nobody
 * sees. `Kind` leads them because it decides what the rest of the row means: a
 * `prose` row is in the grid to be read, not to be covered.
 */
describe('buildRequirementsTable — the requirement facets', () => {
  it('declares the kind column first, then the nine stored facets', () => {
    const { m } = seed();
    const t = buildRequirementsTable(m);
    expect(t.attrColumns.map((c) => c.key)).toEqual([
      'statementKind',
      'status',
      'verdict',
      'risk',
      'priority',
      'criticality',
      'rationale',
      'source',
      'owner',
      'verificationMethod',
    ]);
    // A closed list travels with the column, so the editor offers exactly the
    // values `setRequirementAttr` would accept and no second list can drift.
    const kind = t.attrColumns.find((c) => c.key === 'statementKind')!;
    expect(kind.label).toBe('Kind');
    expect(kind.values).toEqual(['requirement', 'prose', 'prompt']);
    expect(t.attrColumns.find((c) => c.key === 'status')!.values).toContain('open');
    // Free text has no list rather than an empty one.
    expect(t.attrColumns.find((c) => c.key === 'rationale')!.values).toBeUndefined();
  });

  /**
   * The three column lists say in their doc comment that they are "exported so
   * the panel + tests share them". Two of them were reachable from the barrel
   * and the third was not, which made the sentence false for it and the
   * constant dead. Ask for all three the way a consumer would.
   */
  it('publishes its column definitions on the @diagram barrel', () => {
    const t = buildRequirementsTable(seed().m);
    expect(REQUIREMENT_SCALAR_COLUMNS).toEqual(t.scalarColumns);
    expect(REQUIREMENT_REF_COLUMNS).toEqual(t.refColumns);
    expect(REQUIREMENT_ATTR_COLUMNS).toEqual(t.attrColumns);
  });

  it('carries each row\'s set facets, and its kind even when nothing is set', () => {
    const { m, r1, r2 } = seed();
    setRequirementAttr(m, r1.id, 'status', 'done');
    setRequirementAttr(m, r1.id, 'risk', 'high');
    setRequirementAttr(m, r2.id, 'statementKind', 'prose');
    const t = buildRequirementsTable(m);
    const rowR1 = t.rows.find((r) => r.id === r1.id)!;
    const rowR2 = t.rows.find((r) => r.id === r2.id)!;
    expect(rowR1.attrs.status).toBe('done');
    expect(rowR1.attrs.risk).toBe('high');
    expect(rowR1.attrs.owner).toBeUndefined();
    // Untagged: the metaclass answers, so every row says what kind it is.
    expect(rowR1.attrs.statementKind).toBe('requirement');
    expect(rowR2.attrs.statementKind).toBe('prose');
  });

  it('keeps a prose row in the grid — it is labelled, not hidden', () => {
    const { m, r2 } = seed();
    setRequirementAttr(m, r2.id, 'statementKind', 'prose');
    const t = buildRequirementsTable(m);
    expect(t.rows.map((r) => r.id)).toContain(r2.id);
  });

  it('does not create a metadata carrier just by being read', () => {
    const { m } = seed();
    const before = m.size;
    buildRequirementsTable(m);
    expect(m.size).toBe(before);
  });
});
