/**
 * Shared helpers for the persistence + API-server integration tests.
 *
 * Provides order-independent element-set comparison at two fidelities:
 *  - {@link strictSignatures} — eClass + qualifiedName + attrs + endpoints
 *    (used for the loss-less `model-json` / `api-json` interchange formats).
 *  - {@link identitySignatures} — eClass + qualifiedName only (used for the
 *    `sysml` textual format, whose serializer is intentionally lossy on a few
 *    derived attributes such as `requirementRole`/`expression`).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect } from 'vitest';
import { Model, type ElementRecord } from '@core/index';
import { parseModel } from '@text/index';

/** Parse the shipped `examples/vehicle.sysml` into a fresh {@link Model}. */
export function loadVehicleExample(): Model {
  const text = readFileSync(resolve(process.cwd(), 'examples/vehicle.sysml'), 'utf8');
  return parseModel(text).model;
}

/** Full-fidelity signature: metaclass, qualified name, sorted attrs, endpoints. */
export function strictSignature(model: Model, el: ElementRecord): string {
  const attrs = Object.entries(el.attrs)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .sort()
    .join(',');
  const src = (el.source ?? []).map((id) => model.qualifiedName(id)).sort().join('|');
  const tgt = (el.target ?? []).map((id) => model.qualifiedName(id)).sort().join('|');
  return `${el.eClass}@@${model.qualifiedName(el.id)}@@{${attrs}}@@${src}=>${tgt}`;
}

/** Identity signature: metaclass + qualified name only (attr-insensitive). */
export function identitySignature(model: Model, el: ElementRecord): string {
  return `${el.eClass}@@${model.qualifiedName(el.id)}`;
}

/** Wiring signature: metaclass + qualified name + endpoints (no attrs). */
export function wiringSignature(model: Model, el: ElementRecord): string {
  const src = (el.source ?? []).map((id) => model.qualifiedName(id)).sort().join('|');
  const tgt = (el.target ?? []).map((id) => model.qualifiedName(id)).sort().join('|');
  return `${el.eClass}@@${model.qualifiedName(el.id)}@@${src}=>${tgt}`;
}

function multiset(model: Model, sig: (m: Model, e: ElementRecord) => string): Map<string, number> {
  const out = new Map<string, number>();
  for (const el of model.all()) {
    const s = sig(model, el);
    out.set(s, (out.get(s) ?? 0) + 1);
  }
  return out;
}

function diffMultisets(a: Map<string, number>, b: Map<string, number>): string[] {
  const diff: string[] = [];
  for (const [k, n] of a) if (b.get(k) !== n) diff.push(`A->B ${k} (${n} vs ${b.get(k) ?? 0})`);
  for (const [k, n] of b) if (a.get(k) !== n) diff.push(`B->A ${k} (${n} vs ${a.get(k) ?? 0})`);
  return diff;
}

/** Assert two models carry the identical element set at full fidelity. */
export function expectSameElementSet(a: Model, b: Model): void {
  expect(diffMultisets(multiset(a, strictSignature), multiset(b, strictSignature))).toEqual([]);
  expect(b.size).toBe(a.size);
}

/** Assert two models carry the same elements by metaclass + qualified name. */
export function expectSameElementIdentities(a: Model, b: Model): void {
  expect(diffMultisets(multiset(a, identitySignature), multiset(b, identitySignature))).toEqual([]);
  expect(b.size).toBe(a.size);
}

/** Multiset of element signatures by wiring (metaclass + name + endpoints, no attrs). */
export function signatures(model: Model): Map<string, number> {
  return multiset(model, wiringSignature);
}

/** Return the human-readable diffs between two models' wiring multisets. */
export function elementSetDiffs(a: Model, b: Model): string[] {
  return diffMultisets(signatures(a), signatures(b));
}
