import { describe, it, expect } from 'vitest';
import { Model, collectSubtrees, pasteSubtrees } from '@core/index';

/** P { Car ▸ { engine, wheel, conn engine→wheel }, Garage, req }. */
function build() {
  const m = new Model();
  const p = m.create('Package', { declaredName: 'P' });
  const car = m.create('PartDefinition', { declaredName: 'Car', declaredShortName: 'C', ownerId: p.id });
  const engine = m.create('PartUsage', { declaredName: 'engine', ownerId: car.id });
  const wheel = m.create('PartUsage', { declaredName: 'wheel', ownerId: car.id });
  const conn = m.create('ConnectionUsage', {
    ownerId: car.id,
    source: [engine.id],
    target: [wheel.id],
  });
  const garage = m.create('PartDefinition', { declaredName: 'Garage', ownerId: p.id });
  const req = m.create('RequirementUsage', { declaredName: 'req', ownerId: p.id });
  const sat = m.create('SatisfyRequirementUsage', {
    ownerId: car.id,
    source: [engine.id],
    target: [req.id], // external to Car
  });
  return { m, p, car, engine, wheel, conn, garage, req, sat };
}

describe('collectSubtrees / pasteSubtrees — copy-paste of subtrees', () => {
  it('pastes a subtree under a DIFFERENT owner, remapping internal refs, keeping external', () => {
    const { m, car, garage, req } = build();
    const clip = collectSubtrees(m, [car.id]);
    expect(clip.rootIds).toEqual([car.id]);
    // Car + engine + wheel + conn + sat = 5 records.
    expect(clip.records.length).toBe(5);

    const before = m.size;
    const roots = pasteSubtrees(m, clip, garage.id); // paste Car under Garage
    expect(roots.length).toBe(1);
    expect(m.size).toBe(before + 5);

    const clone = m.get(roots[0])!;
    expect(clone.ownerId).toBe(garage.id); // pasted under the target
    expect(clone.declaredName).toBe('Car'); // no collision under Garage → same name
    expect(clone.declaredShortName).toBeUndefined();

    const kids = m.childIds(roots[0]).map((id) => m.get(id)!);
    const cEngine = kids.find((e) => e.declaredName === 'engine')!;
    const cWheel = kids.find((e) => e.declaredName === 'wheel')!;
    const cConn = kids.find((e) => e.eClass === 'ConnectionUsage')!;
    const cSat = kids.find((e) => e.eClass === 'SatisfyRequirementUsage')!;
    // Internal connection rewired to the pasted clones.
    expect(cConn.source).toEqual([cEngine.id]);
    expect(cConn.target).toEqual([cWheel.id]);
    // Satisfy: internal source → clone; external target (req) preserved.
    expect(cSat.source).toEqual([cEngine.id]);
    expect(cSat.target).toEqual([req.id]);
  });

  it('keeps a relationship with a still-live external ref; drops one whose ref vanished', () => {
    // req PRESENT: the satisfy's external target survives → the clone is kept.
    const kept = build();
    const clipK = collectSubtrees(kept.m, [kept.car.id]);
    const rootsK = pasteSubtrees(kept.m, clipK, kept.garage.id);
    const satK = kept.m
      .childIds(rootsK[0])
      .map((id) => kept.m.get(id)!)
      .find((e) => e.eClass === 'SatisfyRequirementUsage')!;
    expect(satK.source).toEqual([kept.m.childIds(rootsK[0]).find((id) => kept.m.get(id)!.declaredName === 'engine')]);
    expect(satK.target).toEqual([kept.req.id]); // external, still live → preserved

    // req DELETED after copy: the satisfy's only target vanishes → dropped, not
    // materialized with an empty endpoint (LOW-1).
    const gone = build();
    const clipG = collectSubtrees(gone.m, [gone.car.id]);
    gone.m.remove(gone.req.id);
    const rootsG = pasteSubtrees(gone.m, clipG, gone.garage.id);
    const satG = gone.m
      .childIds(rootsG[0])
      .map((id) => gone.m.get(id)!)
      .find((e) => e.eClass === 'SatisfyRequirementUsage');
    expect(satG).toBeUndefined(); // the endpoint-less satisfy was dropped
  });

  it('drops a copied relationship whose endpoints all vanished (no empty orphan)', () => {
    const m = new Model();
    const box = m.create('PartDefinition', { declaredName: 'Box' });
    const a = m.create('PartUsage', { declaredName: 'a' }); // external to Box
    const b = m.create('PartUsage', { declaredName: 'b' }); // external to Box
    // A dependency OWNED by Box but pointing between two external elements.
    m.create('Dependency', { ownerId: box.id, source: [a.id], target: [b.id] });
    const dst = m.create('PartDefinition', { declaredName: 'Dst' });

    const clip = collectSubtrees(m, [box.id]);
    m.remove(a.id);
    m.remove(b.id); // both endpoints gone after copy
    const before = m.size;
    const roots = pasteSubtrees(m, clip, dst.id);
    // Box clone created (1), the endpoint-less dependency dropped → net +1.
    expect(roots.length).toBe(1);
    expect(m.size).toBe(before + 1);
    expect(m.childIds(roots[0]).length).toBe(0); // no orphan dependency child
  });

  it('pastes at the root when the target owner is null', () => {
    const { m, car } = build();
    const clip = collectSubtrees(m, [car.id]);
    const roots = pasteSubtrees(m, clip, null);
    expect(m.get(roots[0])!.ownerId).toBeNull();
  });

  it('gives a pasted root a name unique among its new siblings', () => {
    const { m, car, p } = build();
    const clip = collectSubtrees(m, [car.id]);
    const roots = pasteSubtrees(m, clip, p.id); // paste Car back under P (Car exists)
    expect(m.get(roots[0])!.declaredName).toBe('Car copy');
    const roots2 = pasteSubtrees(m, clip, p.id);
    expect(m.get(roots2[0])!.declaredName).toBe('Car copy 2');
  });

  it('drops a copied root that is a descendant of another copied root', () => {
    const { m, car, engine } = build();
    const clip = collectSubtrees(m, [car.id, engine.id]); // engine ⊂ Car
    expect(clip.rootIds).toEqual([car.id]);
  });

  it('empty payload pastes nothing', () => {
    const { m } = build();
    expect(pasteSubtrees(m, { records: [], rootIds: [] }, null)).toEqual([]);
  });
});
