/**
 * Round-trip invariants + OMG element-graph schema conformance.
 *
 * A SET of STANDARD MODELS is assembled and each is asserted to satisfy the
 * cross-format invariants a conformant tool must uphold:
 *
 *   - textual   — `parseModel(serializeModel(m))` reproduces the same element
 *                 set (metaclass + qualifiedName multiset), for models within
 *                 the serializer's supported subset.
 *   - model-json — `Model.fromJSON(m.toJSON()).toJSON()` deep-equals
 *                 `m.toJSON()` (loss-less native snapshot).
 *   - api-json  — `importModel(exportModel(m,'api-json'),'api-json')` preserves
 *                 the element set, and the exported document validates against
 *                 the OMG element-graph JSON Schema (draft 2020-12).
 *   - integrity — no relationship/edge endpoint references an absent id, and
 *                 every element carries an id.
 *
 * These run under the default (jsdom) vitest environment: no HTTP is used, so
 * the `// @vitest-environment node` pragma is intentionally omitted.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Model, buildSampleModel } from '@core/index';
import { parseModel, serializeModel } from '@text/index';
import { exportModel, importModel } from '@persistence/index';
import { loadStandardLibrary } from '../../src/library/index';
import { validateElementGraph } from '../../src/api/element-graph-schema';

/* ─────────────────────────── element-set signature ──────────────────────── */

/**
 * Order-independent multiset of `metaclass @@ qualifiedName`. This is the
 * identity the round-trip invariants must preserve (per the task brief).
 */
function elementSet(m: Model): Map<string, number> {
  const out = new Map<string, number>();
  for (const el of m.all()) {
    const key = `${el.eClass}@@${m.qualifiedName(el.id)}`;
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

/** Human-readable diff of two element-set multisets ([] when identical). */
function elementSetDiff(a: Model, b: Model): string[] {
  const sa = elementSet(a);
  const sb = elementSet(b);
  const diff: string[] = [];
  for (const [k, n] of sa) if (sb.get(k) !== n) diff.push(`only-in-A ${k} (${n} vs ${sb.get(k) ?? 0})`);
  for (const [k, n] of sb) if (sa.get(k) !== n) diff.push(`only-in-B ${k} (${n} vs ${sa.get(k) ?? 0})`);
  return diff;
}

/** Ids of elements whose endpoints reference an absent id, or that lack an id. */
function integrityViolations(m: Model): string[] {
  const ids = new Set(m.all().map((el) => el.id));
  const bad: string[] = [];
  for (const el of m.all()) {
    if (!el.id) bad.push(`element missing id (${el.eClass})`);
    for (const s of el.source ?? []) if (!ids.has(s)) bad.push(`${el.eClass}#${el.id} dangling source ${s}`);
    for (const t of el.target ?? []) if (!ids.has(t)) bad.push(`${el.eClass}#${el.id} dangling target ${t}`);
  }
  return bad;
}

/* ─────────────────────────── the standard models ────────────────────────── */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VEHICLE_PATH = path.resolve(HERE, '../../examples/vehicle.sysml');

interface StandardModel {
  name: string;
  build: () => Model;
  /** Whether the model is wholly within the serializer's supported subset. */
  serializeSubset: boolean;
}

const STANDARD_MODELS: StandardModel[] = [
  {
    name: 'buildSampleModel()',
    build: () => buildSampleModel(),
    serializeSubset: true,
  },
  {
    name: 'examples/vehicle.sysml',
    build: () => {
      const { model, diagnostics } = parseModel(fs.readFileSync(VEHICLE_PATH, 'utf8'));
      const errors = diagnostics.filter((d) => d.severity === 'error');
      expect(errors, `vehicle.sysml parse errors: ${JSON.stringify(errors)}`).toEqual([]);
      return model;
    },
    serializeSubset: true,
  },
  {
    name: 'standard library (ISQ + SI packages)',
    build: () => {
      const m = new Model();
      // Scope the load to a couple of packages from the bundled library.
      loadStandardLibrary(m, { packages: ['ISQ', 'SI'] });
      return m;
    },
    // Library usages carry FeatureTyping relationships; the serializer emits
    // every specialization relationship (`: Type`, `:>`, `:>>`, `::>`) and the
    // mapper reconstructs the FeatureTyping element when the type resolves, so
    // this model round-trips textually and is now within the serialize subset.
    serializeSubset: true,
  },
];

/* ──────────────────────────────── the suite ─────────────────────────────── */

describe('conformance — round-trip invariants across standard models', () => {
  for (const spec of STANDARD_MODELS) {
    describe(spec.name, () => {
      it('is non-empty', () => {
        expect(spec.build().size).toBeGreaterThan(0);
      });

      it('integrity: every element has an id and no endpoint dangles', () => {
        expect(integrityViolations(spec.build())).toEqual([]);
      });

      it('model-json: fromJSON(toJSON()).toJSON() deep-equals toJSON()', () => {
        const m = spec.build();
        const snapshot = m.toJSON();
        const reloaded = Model.fromJSON(snapshot).toJSON();
        expect(reloaded).toEqual(snapshot);
      });

      it('api-json: importModel(exportModel()) preserves the element set', () => {
        const m = spec.build();
        const back = importModel(exportModel(m, 'api-json'), 'api-json').model;
        expect(elementSetDiff(m, back)).toEqual([]);
        expect(back.size).toBe(m.size);
      });

      it('api-json: exported element-graph validates against the OMG schema', () => {
        const doc = JSON.parse(exportModel(spec.build(), 'api-json'));
        const result = validateElementGraph(doc);
        expect(result.errors).toEqual([]);
        expect(result.valid).toBe(true);
      });

      it('api-json: rebuilt export also validates (import→export stability)', () => {
        const m = spec.build();
        const once = exportModel(m, 'api-json');
        const rebuilt = importModel(once, 'api-json').model;
        expect(validateElementGraph(JSON.parse(exportModel(rebuilt, 'api-json'))).valid).toBe(true);
      });

      const textualTest = spec.serializeSubset ? it : it.skip;
      textualTest('textual: parseModel(serializeModel()) reproduces the element set', () => {
        const m = spec.build();
        const { model: rt, diagnostics } = parseModel(serializeModel(m));
        expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
        expect(elementSetDiff(m, rt)).toEqual([]);
      });
    });
  }
});

describe('conformance — element-graph schema rejects malformed documents', () => {
  it('rejects a document with no elements array', () => {
    const r = validateElementGraph({ '@type': 'ElementGraph' });
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toContain('elements');
  });

  it('rejects an element missing the required @id', () => {
    const r = validateElementGraph({ elements: [{ '@type': 'PartUsage' }] });
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toContain('@id');
  });

  it('rejects an element missing the required @type', () => {
    const r = validateElementGraph({ elements: [{ '@id': 'x1' }] });
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toContain('@type');
  });

  it('accepts a minimal well-formed element-graph', () => {
    const r = validateElementGraph({
      elements: [{ '@id': 'p1', '@type': 'Package', declaredName: 'P' }],
    });
    expect(r).toEqual({ valid: true, errors: [] });
  });
});
