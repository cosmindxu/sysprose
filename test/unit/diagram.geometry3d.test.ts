/**
 * Unit tests for the PURE 3D geometry-scene builder ({@link buildGeometryScene}).
 *
 * These exercise shape/position/size/colour derivation, containment (`parentId`),
 * library exclusion, and overall bounds — all without Three.js/WebGL, which jsdom
 * cannot provide. The Three.js `Geometry3DView` is validated by Playwright E2E and
 * is deliberately NOT mounted here.
 */

import { describe, expect, it } from 'vitest';
import { Model, ModelFactory } from '@core/index';
import { buildGeometryScene, colorFromString } from '@diagram/geometry3d';

/** Build a fixture model with a mix of explicit and defaulted geometry parts. */
function fixture() {
  const m = new Model();
  const f = new ModelFactory(m);
  const pkg = f.pkg('P');
  const system = f.part('system', pkg.id);

  // Explicit shape + position + size (nested inside `system`).
  const placed = m.create('PartUsage', {
    declaredName: 'placed',
    ownerId: system.id,
    attrs: {
      shape: 'sphere',
      position: { x: 10, y: 5, z: -3 },
      size: { w: 4, h: 4, d: 4 },
      color: '#ff8800',
    },
  });

  // A cylinder via {width,height,depth} + explicit shape keyword synonym.
  const rod = m.create('PartUsage', {
    declaredName: 'rod',
    ownerId: system.id,
    attrs: { shape: 'cylinder', size: { width: 2, height: 8, depth: 2 } },
  });

  // Shape inferred from a library-shape typing (Cuboid → box).
  const cuboidDef = m.create('ItemDefinition', {
    declaredName: 'Cuboid',
    attrs: { isLibrary: true },
  });
  const block = f.part('block', system.id, cuboidDef.id);

  // No shape / position / size at all → defaults (box, grid pos, unit size).
  const bare = f.part('bare', system.id);

  return { m, pkg, system, placed, rod, cuboidDef, block, bare };
}

describe('buildGeometryScene — pure 3D projection', () => {
  const { m, system, placed, rod, block, bare } = fixture();
  const scene = buildGeometryScene(m);
  const byEl = (id: string) => scene.items.find((it) => it.elementId === id)!;

  it('emits one item per in-scope part usage/definition and excludes the library', () => {
    // system, placed, rod, block, bare = 5 user parts. The library Cuboid def is excluded.
    expect(scene.items.length).toBe(5);
    expect(scene.items.some((it) => it.label === 'Cuboid')).toBe(false);
    expect(scene.items.every((it) => it.elementId === it.id)).toBe(true);
  });

  it('honours an explicit shape keyword', () => {
    expect(byEl(placed.id).shape).toBe('sphere');
    expect(byEl(rod.id).shape).toBe('cylinder');
  });

  it('infers shape from a library-shape typing (Cuboid → box)', () => {
    expect(byEl(block.id).shape).toBe('box');
  });

  it('defaults an untyped, shapeless part to a box', () => {
    expect(byEl(bare.id).shape).toBe('box');
  });

  it('honours an explicit {x,y,z} position', () => {
    expect(byEl(placed.id).position).toEqual({ x: 10, y: 5, z: -3 });
  });

  it('deterministically grid-places parts without an explicit position', () => {
    // Distinct, finite coordinates; and stable across a rebuild.
    const rebuilt = buildGeometryScene(m);
    for (const id of [system.id, rod.id, block.id, bare.id]) {
      const a = byEl(id).position;
      const b = rebuilt.items.find((it) => it.elementId === id)!.position;
      expect(a).toEqual(b);
      expect(Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z)).toBe(true);
    }
    expect(byEl(system.id).position).not.toEqual(byEl(rod.id).position);
  });

  it('honours explicit size (both {w,h,d} and {width,height,depth})', () => {
    expect(byEl(placed.id).size).toEqual({ x: 4, y: 4, z: 4 });
    expect(byEl(rod.id).size).toEqual({ x: 2, y: 8, z: 2 });
  });

  it('defaults size to a unit box when absent', () => {
    expect(byEl(bare.id).size).toEqual({ x: 1, y: 1, z: 1 });
  });

  it('uses an explicit color, else a stable metaclass hash', () => {
    expect(byEl(placed.id).color).toBe('#ff8800');
    const c = byEl(bare.id).color;
    expect(c).toMatch(/^#[0-9a-f]{6}$/);
    expect(c).toBe(colorFromString('PartUsage'));
  });

  it('captures containment via parentId (nearest emitted ancestor)', () => {
    expect(byEl(placed.id).parentId).toBe(system.id);
    expect(byEl(rod.id).parentId).toBe(system.id);
    expect(byEl(system.id).parentId).toBeUndefined();
  });

  it('computes overall bounds enclosing every item', () => {
    const { bounds } = scene;
    // The sphere at x=10 with size 4 reaches x=12 → max.x must cover it.
    expect(bounds.max.x).toBeGreaterThanOrEqual(12);
    expect(bounds.min.x).toBeLessThanOrEqual(8);
    expect(bounds.size.x).toBe(bounds.max.x - bounds.min.x);
    expect(bounds.center.x).toBeCloseTo((bounds.min.x + bounds.max.x) / 2, 6);
    for (const it of scene.items) {
      expect(it.position.x + it.size.x / 2).toBeLessThanOrEqual(bounds.max.x + 1e-9);
      expect(it.position.x - it.size.x / 2).toBeGreaterThanOrEqual(bounds.min.x - 1e-9);
    }
  });

  it('returns a zeroed bounds for an empty model', () => {
    const empty = buildGeometryScene(new Model());
    expect(empty.items).toEqual([]);
    expect(empty.bounds.size).toEqual({ x: 0, y: 0, z: 0 });
    expect(empty.bounds.center).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('excludes library parts by default and includes them when asked', () => {
    const lm = new Model();
    const lf = new ModelFactory(lm);
    const pkg = lf.pkg('P');
    lf.part('userPart', pkg.id);
    lm.create('PartUsage', {
      declaredName: 'libPart',
      ownerId: pkg.id,
      attrs: { isLibrary: true },
    });

    const excluded = buildGeometryScene(lm); // default excludeLibrary: true
    expect(excluded.items.some((it) => it.label === 'libPart')).toBe(false);
    expect(excluded.items.some((it) => it.label === 'userPart')).toBe(true);

    const withLib = buildGeometryScene(lm, { excludeLibrary: false });
    expect(withLib.items.some((it) => it.label === 'libPart')).toBe(true);
    expect(withLib.items.length).toBeGreaterThan(excluded.items.length);
  });

  it('produces stable, well-formed colours from the hash helper', () => {
    expect(colorFromString('PartUsage')).toBe(colorFromString('PartUsage'));
    expect(colorFromString('ItemUsage')).not.toBe(colorFromString('PartUsage'));
    expect(colorFromString('X')).toMatch(/^#[0-9a-f]{6}$/);
  });
});
