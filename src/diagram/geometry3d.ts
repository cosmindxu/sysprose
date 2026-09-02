/**
 * buildGeometryScene — project a {@link Model} into a **3D geometry scene**
 * ({@link GeometryScene}) for the WebGL geometry view.
 *
 * This is the pure, Three.js-free counterpart to the React {@link ../ui} layer:
 * it derives, for every in-scope structural usage, a renderable {@link GeometryItem}
 * (a shape, world position, size, colour, and optional containment parent) plus an
 * overall axis-aligned {@link GeometryBounds}. The Three.js component
 * ({@link ./Geometry3DView}) consumes this scene and instantiates one mesh per item;
 * keeping the derivation here (no WebGL, no DOM) makes it unit-testable under jsdom.
 *
 * Derivation rules (module brief):
 *  - **shape** — `attrs.shape` ('box'|'sphere'|'cylinder', plus common synonyms)
 *    when present, else inferred from the element's library-shape *typing*
 *    (a Box/Cuboid → box, Sphere/Ellipsoid → sphere, Cylinder/Cone → cylinder via
 *    {@link Model.typesOf}); default `box`.
 *  - **position** — `attrs.position` ({x,y,z}) when numeric, else a deterministic
 *    3D grid layout keyed by the item's index.
 *  - **size** — `attrs.size` ({w,h,d} / {width,height,depth} / {x,y,z}) when
 *    present, else a unit box.
 *  - **color** — `attrs.color` when a string, else a stable hash of the metaclass.
 *  - **parentId** — the nearest owning ancestor that is itself an emitted item.
 *  - library elements (`attrs.isLibrary`) are excluded by default.
 */

import type { ElementId, ElementRecord } from '@core/index';
import { Model } from '@core/index';

/* ─────────────────────────────── contract ──────────────────────────────── */

/** The primitive solids the geometry view renders. */
export type GeometryShape = 'box' | 'sphere' | 'cylinder';

/** A 3D vector (world coordinates / extents). */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A single renderable solid, projected from a model element. */
export interface GeometryItem {
  /** Scene-local id (defaults to the element id). */
  id: string;
  /** The model element this solid renders. */
  elementId: string;
  /** Primary label (declared name, short name, or metaclass). */
  label: string;
  /** Primitive solid kind. */
  shape: GeometryShape;
  /** World-space centre position. */
  position: Vec3;
  /** Full extents (width/height/depth) — always strictly positive. */
  size: Vec3;
  /** CSS/hex colour string (e.g. '#4f9dd6'). */
  color: string;
  /** Owning ancestor item's id, when its container is itself an emitted item. */
  parentId?: string;
}

/** Axis-aligned bounds of the whole scene. */
export interface GeometryBounds {
  min: Vec3;
  max: Vec3;
  center: Vec3;
  size: Vec3;
}

/** A complete 3D projection of the model for the geometry view. */
export interface GeometryScene {
  items: GeometryItem[];
  bounds: GeometryBounds;
}

/** Options controlling a {@link buildGeometryScene} projection. */
export interface BuildGeometrySceneOptions {
  /** Exclude bundled standard-library elements (`attrs.isLibrary`). Default `true`. */
  excludeLibrary?: boolean;
  /** Scope the scene to the subtree rooted at this element. */
  rootId?: ElementId;
}

/* ─────────────────────────────── helpers ───────────────────────────────── */

/** Structural usages/definitions that project as a solid. */
const PART_KINDS = new Set(['PartUsage', 'ItemUsage', 'PartDefinition']);

/** Best human label for an element. */
function labelOf(el: ElementRecord): string {
  return el.declaredName ?? el.declaredShortName ?? el.eClass;
}

/** Normalise a free-text shape keyword to a {@link GeometryShape} (or undefined). */
function shapeFromKeyword(raw: string): GeometryShape | undefined {
  const s = raw.trim().toLowerCase();
  if (/(sphere|ellipsoid|ball|orb)/.test(s)) return 'sphere';
  if (/(cylinder|cone|tube|pipe|rod|disc|disk)/.test(s)) return 'cylinder';
  if (/(box|cuboid|cube|block|brick|prism|rect)/.test(s)) return 'box';
  return undefined;
}

/**
 * Infer a shape from the element's library-shape typing: walk the specialization
 * chain (bounded) via {@link Model.typesOf} and match the first recognised name.
 */
function shapeFromTyping(model: Model, el: ElementRecord): GeometryShape | undefined {
  const seen = new Set<ElementId>();
  let frontier: ElementRecord[] = [el];
  for (let depth = 0; depth < 6 && frontier.length; depth++) {
    const next: ElementRecord[] = [];
    for (const node of frontier) {
      for (const type of model.typesOf(node.id)) {
        if (seen.has(type.id)) continue;
        seen.add(type.id);
        const byName = type.declaredName ? shapeFromKeyword(type.declaredName) : undefined;
        if (byName) return byName;
        next.push(type);
      }
    }
    frontier = next;
  }
  return undefined;
}

/** Read a numeric coordinate off an attrs record under any of the given keys. */
function num(rec: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

/** Read an explicit `{x,y,z}` position (z optional → 0) when x & y are numeric. */
function readPosition(v: unknown): Vec3 | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const rec = v as Record<string, unknown>;
  const x = num(rec, 'x');
  const y = num(rec, 'y');
  if (x === undefined || y === undefined) return undefined;
  return { x, y, z: num(rec, 'z') ?? 0 };
}

/** Read an explicit size ({w,h,d} / {width,height,depth} / {x,y,z}); missing → 1. */
function readSize(v: unknown): Vec3 | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const rec = v as Record<string, unknown>;
  const x = num(rec, 'w', 'width', 'x');
  const y = num(rec, 'h', 'height', 'y');
  const z = num(rec, 'd', 'depth', 'z');
  if (x === undefined && y === undefined && z === undefined) return undefined;
  const pos = (n: number | undefined): number => (n !== undefined && n > 0 ? n : 1);
  return { x: pos(x), y: pos(y), z: pos(z) };
}

/** Deterministic 3D grid placement for an item without an explicit position. */
function gridPosition(index: number): Vec3 {
  const N = 4;
  const SPACING = 3;
  const col = index % N;
  const row = Math.floor(index / N) % N;
  const layer = Math.floor(index / (N * N));
  return { x: col * SPACING, y: layer * SPACING, z: row * SPACING };
}

/** A stable, well-distributed hex colour derived from a string (FNV-1a → HSL). */
export function colorFromString(seed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const hue = (h >>> 0) % 360;
  return hslToHex(hue, 55, 55);
}

/** Convert an HSL triple to a `#rrggbb` string. */
function hslToHex(h: number, s: number, l: number): string {
  const sn = s / 100;
  const ln = l / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = ln - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = (v: number): string =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** Ids in scope: subtree of `rootId` (or whole model), minus library elements. */
function scopeIds(model: Model, rootId?: ElementId, excludeLibrary = true): Set<ElementId> {
  const ids = rootId
    ? new Set<ElementId>([rootId, ...model.descendants(rootId).map((d) => d.id)])
    : new Set<ElementId>(model.all().map((e) => e.id));
  if (excludeLibrary) {
    for (const id of ids) {
      if (model.get(id)?.attrs.isLibrary === true) ids.delete(id);
    }
  }
  return ids;
}

/* ─────────────────────────────── builder ───────────────────────────────── */

/**
 * Build the {@link GeometryScene} for `model`: one {@link GeometryItem} per
 * in-scope structural usage/definition, with shape/position/size/colour derived
 * per the module rules, containment captured in `parentId`, and an overall
 * {@link GeometryBounds}. Library elements are excluded by default. Pure — no
 * Three.js, no DOM.
 */
export function buildGeometryScene(
  model: Model,
  opts: BuildGeometrySceneOptions = {},
): GeometryScene {
  const scope = scopeIds(model, opts.rootId, opts.excludeLibrary ?? true);

  // Emit items in model declaration order so the grid layout is deterministic.
  const parts = model.all().filter((el) => scope.has(el.id) && PART_KINDS.has(el.eClass));
  const partIds = new Set(parts.map((el) => el.id));

  const items: GeometryItem[] = [];
  parts.forEach((el, index) => {
    const attrs = el.attrs;

    // shape: explicit keyword → library typing → default box.
    const explicitShape = typeof attrs.shape === 'string' ? shapeFromKeyword(attrs.shape) : undefined;
    const shape = explicitShape ?? shapeFromTyping(model, el) ?? 'box';

    // position: explicit {x,y,z} → deterministic grid fallback.
    const position = readPosition(attrs.position) ?? gridPosition(index);

    // size: explicit extents → unit box.
    const size = readSize(attrs.size) ?? { x: 1, y: 1, z: 1 };

    // color: explicit string → stable metaclass hash.
    const color = typeof attrs.color === 'string' && attrs.color.trim() !== ''
      ? attrs.color.trim()
      : colorFromString(el.eClass);

    // parentId: nearest owning ancestor that is itself an emitted item.
    let parentId: string | undefined;
    let ownerId = el.ownerId;
    while (ownerId) {
      if (partIds.has(ownerId)) {
        parentId = ownerId;
        break;
      }
      ownerId = model.get(ownerId)?.ownerId ?? null;
    }

    const item: GeometryItem = {
      id: el.id,
      elementId: el.id,
      label: labelOf(el),
      shape,
      position,
      size,
      color,
    };
    if (parentId) item.parentId = parentId;
    items.push(item);
  });

  return { items, bounds: computeBounds(items) };
}

/** Axis-aligned bounds over every item's extents (empty scene → origin box). */
function computeBounds(items: GeometryItem[]): GeometryBounds {
  if (items.length === 0) {
    const zero: Vec3 = { x: 0, y: 0, z: 0 };
    return { min: { ...zero }, max: { ...zero }, center: { ...zero }, size: { ...zero } };
  }
  const min: Vec3 = { x: Infinity, y: Infinity, z: Infinity };
  const max: Vec3 = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const it of items) {
    (['x', 'y', 'z'] as const).forEach((ax) => {
      const half = it.size[ax] / 2;
      min[ax] = Math.min(min[ax], it.position[ax] - half);
      max[ax] = Math.max(max[ax], it.position[ax] + half);
    });
  }
  const center: Vec3 = {
    x: (min.x + max.x) / 2,
    y: (min.y + max.y) / 2,
    z: (min.z + max.z) / 2,
  };
  const size: Vec3 = { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z };
  return { min, max, center, size };
}
