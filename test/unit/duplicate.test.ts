import { describe, it, expect } from 'vitest';
import { Model, duplicateSubtree } from '@core/index';

/**
 * Build: Package P ▸ { PartDef Car(short "C") ▸ { engine, wheel, a Connection
 * engine→wheel (INTERNAL), a Satisfy engine→req (req is OUTSIDE Car) }, req }.
 */
function build() {
  const m = new Model();
  const pkg = m.create('Package', { declaredName: 'P' });
  const car = m.create('PartDefinition', {
    declaredName: 'Car',
    declaredShortName: 'C',
    ownerId: pkg.id,
  });
  const engine = m.create('PartUsage', { declaredName: 'engine', ownerId: car.id });
  const wheel = m.create('PartUsage', { declaredName: 'wheel', ownerId: car.id });
  const conn = m.create('ConnectionUsage', {
    ownerId: car.id,
    source: [engine.id],
    target: [wheel.id],
  });
  const req = m.create('RequirementUsage', { declaredName: 'req', ownerId: pkg.id });
  const sat = m.create('SatisfyRequirementUsage', {
    ownerId: car.id,
    source: [engine.id],
    target: [req.id], // points OUTSIDE the Car subtree
  });
  return { m, pkg, car, engine, wheel, conn, req, sat };
}

describe('duplicateSubtree — deep-clone a subtree as a sibling', () => {
  it('clones the whole subtree as a sibling with a unique name', () => {
    const { m, pkg, car } = build();
    const before = m.all().length;
    const newId = duplicateSubtree(m, car.id);
    expect(newId).toBeTruthy();
    // Car + engine + wheel + conn + sat = 5 new elements.
    expect(m.all().length).toBe(before + 5);
    const clone = m.get(newId!)!;
    expect(clone.ownerId).toBe(pkg.id); // sibling of the original
    expect(clone.declaredName).toBe('Car copy');
    expect(clone.declaredShortName).toBeUndefined(); // root short name cleared
    expect(clone.id).not.toBe(car.id);
  });

  it('rewires INTERNAL references to the clones and PRESERVES external ones', () => {
    const { m, car, engine, wheel, req, conn } = build();
    const newId = duplicateSubtree(m, car.id)!;
    const kids = m.childIds(newId).map((id) => m.get(id)!);
    const cEngine = kids.find((e) => e.declaredName === 'engine')!;
    const cWheel = kids.find((e) => e.declaredName === 'wheel')!;
    const cConn = kids.find((e) => e.eClass === 'ConnectionUsage')!;
    const cSat = kids.find((e) => e.eClass === 'SatisfyRequirementUsage')!;

    // Cloned children are fresh elements.
    expect(cEngine.id).not.toBe(engine.id);
    expect(cWheel.id).not.toBe(wheel.id);
    // The internal connection now points at the CLONED endpoints.
    expect(cConn.source).toEqual([cEngine.id]);
    expect(cConn.target).toEqual([cWheel.id]);
    // The satisfy's internal source is remapped; its EXTERNAL target is kept.
    expect(cSat.source).toEqual([cEngine.id]);
    expect(cSat.target).toEqual([req.id]);

    // Originals are untouched.
    expect(m.get(conn.id)!.source).toEqual([engine.id]);
    expect(m.get(conn.id)!.target).toEqual([wheel.id]);
  });

  it('gives repeated duplicates distinct names (copy, copy 2, …)', () => {
    const { m, car } = build();
    const a = duplicateSubtree(m, car.id)!;
    const b = duplicateSubtree(m, car.id)!;
    expect(m.get(a)!.declaredName).toBe('Car copy');
    expect(m.get(b)!.declaredName).toBe('Car copy 2');
  });

  it('deep-clones attrs (mutating a clone attr does not touch the original)', () => {
    const m = new Model();
    const p = m.create('PartUsage', { declaredName: 'p', attrs: { tags: ['a'] } });
    const c = duplicateSubtree(m, p.id)!;
    (m.get(c)!.attrs!.tags as string[]).push('b');
    expect(m.get(p.id)!.attrs!.tags).toEqual(['a']); // original array untouched
  });

  it('returns null for a missing element', () => {
    const m = new Model();
    expect(duplicateSubtree(m, 'nope')).toBeNull();
  });

  it('duplicates an unnamed root without a name suffix', () => {
    const m = new Model();
    const p = m.create('PartUsage', {}); // no declaredName
    const c = duplicateSubtree(m, p.id)!;
    expect(m.get(c)!.declaredName).toBeUndefined();
  });
});
