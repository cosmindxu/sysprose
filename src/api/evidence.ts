/**
 * The evidence record: what was claimed, by which engine, about which model.
 *
 * THE PROBLEM THIS FILE SOLVES, STATED FIRST BECAUSE IT IS NOT OBVIOUS.
 * **Element ids in this tool are fresh UUIDs on every load.** Parse the same
 * bytes twice and every `ElementRecord.id` differs, so a digest taken over a
 * raw {@link SerializedModel} — the obvious thing to do — changes on a no-op
 * reparse, and an evidence record bound to it would go stale the moment anybody
 * opened the file. That is defect family D3 of the verification plan's §1.1, and
 * the answer, here and in the SMT-LIB exporter that lands later, is the same
 * one: **canonicalise every id to a qualified name before hashing.** No digest
 * and no assertion name in this lane is ever keyed on an element id.
 *
 * WHAT A RECORD IS FOR. A verdict with no provenance is an opinion. `rushby-1993`
 * and `cofer-miller-2014` both make the same point about evidence in an
 * assurance argument: it has to name the tool, the tool's version, and the
 * assumptions the claim was obtained under, or a reader cannot argue with it.
 * So a record carries the claim, the engine that produced it, the tool and its
 * version, the bound the claim holds within, the model digest it was taken
 * against, and the `flags` — every option that changed what was shown. A proof
 * obtained under `--free uav.cruisePower` may not be replayed as though the
 * model had said something it did not.
 *
 * WHAT IT DELIBERATELY DOES NOT CARRY. No timestamp. A record is a function of
 * the model, the engine and the options, and nothing else: two runs over one
 * unchanged file produce byte-identical records, which is what makes a record
 * diffable, a golden testable, and "did anything actually change?" a question a
 * `diff` can answer. The moment a record is ATTACHED to a file (commit 7 of the
 * plan) it acquires the file's own history; it does not need one of its own.
 *
 * WHY SHA-256 IS IMPLEMENTED HERE. This module is reachable from the browser
 * bundle through `src/api/index.ts`, and `node:crypto` is not. `crypto.subtle`
 * is asynchronous and unavailable on a plain `http:` origin, and every caller
 * of {@link obligationDigest} is synchronous. Sixty lines of FIPS-180-4 with a
 * known-answer test beside it is the smaller price.
 */

import { isRequirement, type ElementId, type ElementRecord, type Model } from '@core/index';
import { PRODUCT_SLUG, PRODUCT_VERSION } from '../branding';
import { FULL_LIBRARY_MANIFEST_COUNT } from '../library/full-library';
import { type ExprNode } from '../semantics/expr';
import { type ContractRef, type ContractVariable } from '../semantics/contracts';
import { PERFORMED_METHOD, VERIFICATION_METHOD_DEF } from '../semantics/verify';
import {
  FAULTED_DECLARATION_REFUSAL,
  RM_METADATA_NAME,
  carriesItsOwnText,
  getRequirementAttr,
  requirementShortId,
  setRequirementAttr,
} from '../semantics/requirements';
import {
  EVIDENCE_DEFINITION,
  EVIDENCE_QUALIFIED_NAME,
} from '../semantics/verification-vocabulary';
import { impactClosure, isUserElement } from './analytics';

/* ────────────────────────────── SHA-256 ─────────────────────────────────── */

/** Round constants: the first 32 bits of the fractional parts of ∛(first 64 primes). */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/**
 * SHA-256 of a string, as 64 lowercase hex characters (FIPS 180-4).
 *
 * Exported because the two digests below are not the only things this lane
 * hashes — the source text is hashed too — and because a hash with no
 * known-answer test is a hash nobody can trust; the test in
 * `test/unit/api.evidence.test.ts` checks it against the published vectors.
 */
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const bitLen = bytes.length * 8;
  // Padded length: message + 0x80 + zeroes + 8-byte length, rounded to 64.
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  // JavaScript numbers hold the high word exactly for any string a browser can
  // allocate, so the 64-bit length is written as two 32-bit halves.
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(padded.length - 4, bitLen >>> 0);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }
  return [...h].map((x) => x.toString(16).padStart(8, '0')).join('');
}

/**
 * JSON with object keys in sorted order — the only stringify a digest may use.
 *
 * `JSON.stringify` preserves INSERTION order, so two structurally identical
 * objects built by different code paths serialise differently and hash
 * differently. Every digest in this file goes through here.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/* ──────────────────────────── the model version ──────────────────────────── */

/** Which build of the tool produced a record. */
export interface ToolVersion {
  name: string;
  version: string;
  /**
   * The git commit, when `git rev-parse` answered. **Omitted otherwise, never
   * invented**: a record that names a commit nobody can check out is worse than
   * one that names none, because a reader cannot tell the two apart.
   */
  git?: string;
}

/** What a record is bound to: the model, optionally its bytes, and the build. */
export interface ModelVersion {
  /** `sha256:…` over the canonical user model, with ids replaced by qualified names. */
  graph: string;
  /** `sha256:…` over the source text, when the caller had it. */
  source?: string;
  /**
   * How many elements of the bundled standard library the model was bound
   * against, per the library's own manifest — and **0 when it was not bound**.
   *
   * The count is the build's, but the zero is the model's: a `--no-library` run
   * analyses a model whose library types resolve to nothing, and a record that
   * claimed 38 000 library elements over it would name a context that was never
   * in force. (The `graph` digest moves too, because binding resolves typings
   * on the user's own elements — that is honest and intended.)
   */
  library: number;
  sysprose: ToolVersion;
}

/** True when running under Node — the same probe `src/library/full-library.ts` uses. */
function inNode(): boolean {
  return (
    typeof process !== 'undefined' &&
    typeof (process as { getBuiltinModule?: unknown }).getBuiltinModule === 'function'
  );
}

/**
 * The build that produced a record: name, package version, and the git commit
 * when there is one to name.
 *
 * `cwd` is a parameter rather than an assumption so the absence path is
 * TESTABLE: run it in a directory that is not a git working tree and the `git`
 * field must be gone. An absence that cannot be exercised is an absence that
 * rots into a fabricated commit id.
 */
export function toolVersion(cwd?: string): ToolVersion {
  const base: ToolVersion = { name: PRODUCT_SLUG, version: PRODUCT_VERSION };
  if (!inNode()) return base;
  try {
    const proc = process as unknown as { getBuiltinModule: (id: string) => unknown };
    const cp = proc.getBuiltinModule('node:child_process') as {
      execFileSync: (f: string, a: string[], o: Record<string, unknown>) => string;
    };
    const sha = cp
      .execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: cwd ?? process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      .trim();
    return /^[0-9a-f]{40}$/.test(sha) ? { ...base, git: sha } : base;
  } catch {
    return base;
  }
}

/**
 * The digest a record is bound to: the user's model, canonically.
 *
 * THREE THINGS MAKE IT SURVIVE A REPARSE, and all three are load-bearing.
 * **Element ids are replaced by qualified names** (D3 — ids are fresh UUIDs per
 * load). **Elements are sorted by qualified name**, with the canonical
 * serialisation as the tiebreak, because `toJSONWhere` preserves insertion
 * order and a reordered file would otherwise read as a
 * changed model. **Library elements are excluded**, because binding the
 * standard library is not an edit to the reader's model and a digest that moved
 * when the library was bound would call every `--no-library` run a different
 * design.
 *
 * What it does NOT ignore: anything the author wrote. Change a literal, rename
 * a feature, add a clause, and the digest moves — which is what the stale-record
 * rule of the plan's §3.10 is built on.
 */
export function modelVersionOf(model: Model, sourceText?: string): ModelVersion {
  return {
    graph: `sha256:${sha256Hex(canonicalJson({ elements: canonicalElements(model) }))}`,
    ...(sourceText !== undefined ? { source: `sha256:${sha256Hex(sourceText)}` } : {}),
    library: model.hasLibrary ? FULL_LIBRARY_MANIFEST_COUNT : 0,
    sysprose: toolVersion(),
  };
}

/**
 * Exactly the elements the graph digest is taken over, canonically serialised
 * and in a fixed order.
 *
 * EXPORTED FOR THE GUARD, not for callers. "Library elements are excluded" is
 * a property of WHICH elements enter the hash, and no assertion over a hash can
 * see it: the bundled library's ids come out of shipped JSON and are stable
 * across loads, so a digest that wrongly included all 38 000 of them would
 * still be byte-identical on a reparse, would still move when a literal moved,
 * and would still differ between a bound and an unbound load. Every test that
 * looks only at the digest stays green under that mutation. The count of what
 * goes IN is the only thing that reddens, so it is reachable.
 *
 * The sort is on the qualified name FIRST — `toJSONWhere` preserves insertion
 * order, so a reordered file would otherwise read as a changed model. The
 * canonical serialisation is the tiebreak, because two elements can share a
 * qualified name (an unnamed member's is `''`) and a sort that stopped at the
 * name would then be unstable between loads.
 *
 * AND EVIDENCE ITSELF IS NOT PART OF THE DESIGN IT IS ABOUT. This is the
 * fourth exclusion and it arrives with {@link attachEvidence}, because without
 * it the feature is impossible rather than merely wrong: a record names the
 * digest of the model it was taken over, attaching it writes elements into that
 * model, and the record would therefore be stale the instant it was written —
 * every run reporting every record it had just produced as out of date. So the
 * carriers this module writes, everything under them, and the `verdict` facet
 * cell that goes with them are all left out. The line the exclusion draws is
 * exactly "what a verification run wrote", not "metadata": every other facet a
 * requirement carries — status, risk, owner, rationale — is in the hash, and a
 * change to any of them still moves it, because those are the author's.
 */
export function canonicalElements(model: Model): string[] {
  const snapshot = model.toJSONWhere(
    (el) => isUserElement(model, el) && !isEvidenceArtefact(model, el),
  );
  return snapshot.elements
    .map((el) => [model.qualifiedName(el.id), canonicalJson(canonicalElement(model, el))] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([, json]) => json);
}

/**
 * Was this element written by a verification run rather than by the author?
 *
 * EXPORTED FOR THE GUARD, for the same reason {@link canonicalElements} is:
 * "the digest ignores what verification wrote" is a property of WHICH elements
 * enter the hash, and no assertion over a hash alone can see it — a digest that
 * wrongly swept the carriers in would still be stable across a reparse and
 * would still move when a literal moved. The count of what goes in is the only
 * thing that reddens.
 *
 * FIVE shapes, and the last two are one fact in two elements. The Evidence CARRIER; anything
 * OWNED by one (its cells, and whatever a future record shape nests under
 * them); the `verdict` CELL on the requirement-metadata carrier, which
 * {@link attachEvidence} writes from the record; and the requirement-metadata
 * CARRIER itself when that cell is all it holds — because attaching evidence to
 * a requirement that had no facets at all creates the carrier as well as the
 * cell, and leaving the empty shell in the hash would move the digest for the
 * same reason the cell would. And the standard
 * `@VerificationCases::VerificationMethod { attribute kind = analyze; }`
 * annotation `writeVerdict` puts on a case that declared no method, with its
 * one cell.
 *
 * WHY THAT FIFTH SHAPE IS SAFE TO EXCLUDE, WHICH IS NOT OBVIOUS. The method IS
 * load-bearing — it is the gate that decides whether a case is judged at all —
 * so excluding "a method annotation" wholesale would let an author change
 * `analyze` to `test` without moving the digest, and every record on the file
 * would go on reading as current over a case the tool would no longer judge.
 * The exclusion is therefore drawn at exactly the shape this tool writes and
 * nothing wider: annotating, typed `VerificationMethod`, and holding one `kind`
 * cell whose only value is `analyze`. A model carrying it and the same model
 * without it are GATE-EQUIVALENT — a case that declares no method is judged on
 * the analyze part, which is what the annotation says — so the annotation adds
 * no fact the gate reads, and its presence cannot change a verdict. Edit it to
 * any other kind, add a second kind, or add a second cell, and the shape stops
 * matching and the digest moves again, which is the direction that matters.
 * Without this, `evidence-attach` would invalidate the records it had just
 * written: the annotation is written into the model the records were taken
 * over, so every attach onto a case with no stated method produced a file that
 * was born `validation/stale-evidence`.
 *
 * THE LINE IS DRAWN BY SHAPE, NOT BY PROVENANCE, and the two consequences are
 * stated here rather than left to be discovered. Nothing in the file marks WHO
 * wrote a `verdict` cell, so one a person typed on a requirement that never
 * carried evidence is out of the hash too: editing it does not move the digest,
 * and the state it can reach is caught by
 * {@link VERDICT_OVERSTATES_EVIDENCE_CODE} — which compares the facet against
 * the record's claim — rather than by staleness. And the owner walk below is at
 * ANY depth, so whatever an author nests under an `@Evidence` carrier of their
 * own is out of the hash as well; the carrier is this lane's own vocabulary,
 * what a future record shape may nest under it is not fixed, and a hash that had
 * to be told the exact shape of a record would break every time one grew.
 */
export function isEvidenceArtefact(model: Model, el: ElementRecord): boolean {
  if (isEvidenceCarrier(el)) return true;
  if (isVerdictCell(model, el)) return true;
  if (isVerdictOnlyMetadata(model, el)) return true;
  if (isToolWrittenMethodAnnotation(model, el)) return true;
  if (isToolWrittenMethodCell(model, el)) return true;
  // Owned by a carrier, at any depth. Walked upwards rather than downwards so
  // one element can answer for itself without the caller holding a set.
  let owner = el.ownerId === null ? undefined : model.get(el.ownerId);
  const seen = new Set<ElementId>([el.id]);
  while (owner && !seen.has(owner.id)) {
    seen.add(owner.id);
    if (isEvidenceCarrier(owner)) return true;
    owner = owner.ownerId === null ? undefined : model.get(owner.ownerId);
  }
  return false;
}

/** The `verdict` cell on a requirement's facet carrier — what an attach writes. */
function isVerdictCell(model: Model, el: ElementRecord): boolean {
  if (el.eClass !== 'AttributeUsage' || el.declaredName !== 'verdict') return false;
  const owner = el.ownerId === null ? undefined : model.get(el.ownerId);
  return owner !== undefined && isRequirementMetadata(owner);
}

/** A facet carrier holding nothing but a verdict — created by the attach itself. */
function isVerdictOnlyMetadata(model: Model, el: ElementRecord): boolean {
  if (!isRequirementMetadata(el)) return false;
  const children = model.children(el.id);
  return children.length > 0 && children.every((c) => isVerdictCell(model, c));
}

/**
 * The single-`analyze` method annotation this tool writes onto a case.
 *
 * Matched on the last `::` segment because a file may import or qualify the
 * definition, and on the CONTENT as well as the type: one cell, named `kind`,
 * valued exactly `analyze`. Anything else an author wrote there is theirs and
 * stays in the digest — see {@link isEvidenceArtefact} for why the line is
 * drawn this tightly.
 */
function isToolWrittenMethodAnnotation(model: Model, el: ElementRecord): boolean {
  if (el.eClass !== 'MetadataUsage' || el.attrs.annotation !== true) return false;
  const type = el.attrs.type;
  if (typeof type !== 'string') return false;
  if ((type.split('::').pop() ?? type) !== VERIFICATION_METHOD_DEF) return false;
  const children = model.children(el.id);
  return (
    children.length === 1 &&
    children[0].eClass === 'AttributeUsage' &&
    children[0].declaredName === 'kind' &&
    children[0].attrs.value === PERFORMED_METHOD
  );
}

/** The `kind = analyze;` cell inside one of those, which travels with it. */
function isToolWrittenMethodCell(model: Model, el: ElementRecord): boolean {
  if (el.eClass !== 'AttributeUsage' || el.declaredName !== 'kind') return false;
  const owner = el.ownerId === null ? undefined : model.get(el.ownerId);
  return owner !== undefined && isToolWrittenMethodAnnotation(model, owner);
}

/** The `metadata RequirementMetadata { … }` carrier, in both read spellings. */
function isRequirementMetadata(el: ElementRecord): boolean {
  return (
    el.eClass === 'MetadataUsage' &&
    el.attrs.annotation !== true &&
    (el.declaredName === RM_METADATA_NAME || el.attrs.typeRef === RM_METADATA_NAME)
  );
}

/** One element with every id it carries replaced by the name a person would write. */
function canonicalElement(model: Model, el: ElementRecord): Record<string, unknown> {
  const name = (id: ElementId): string => model.qualifiedName(id) || `«unresolved:${el.eClass}»`;
  return {
    eClass: el.eClass,
    qualifiedName: model.qualifiedName(el.id),
    ...(el.declaredName !== undefined ? { declaredName: el.declaredName } : {}),
    ...(el.declaredShortName !== undefined ? { declaredShortName: el.declaredShortName } : {}),
    owner: el.ownerId === null ? null : name(el.ownerId),
    attrs: canonicalAttrs(model, el.attrs),
    ...(el.source ? { source: el.source.map(name) } : {}),
    ...(el.target ? { target: el.target.map(name) } : {}),
  };
}

/**
 * Attribute values with any element id among them replaced by a qualified name.
 *
 * An id can hide anywhere in the `attrs` bag — the parser stores resolved
 * references there — and one that survived into the digest would reintroduce
 * exactly the instability the canonicalisation exists to remove. The test is
 * membership in the model rather than a UUID-shaped regex, so a reference is
 * rewritten because it IS one, not because it looks like one.
 */
function canonicalAttrs(model: Model, attrs: Record<string, unknown>): Record<string, unknown> {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const el = model.get(v);
      return el ? `#${model.qualifiedName(v)}` : v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return walk(attrs) as Record<string, unknown>;
}

/* ───────────────────────────── the obligation digest ─────────────────────── */

/**
 * The identity of one obligation: its NORMAL FORM, not its text and not its id.
 *
 * Taken over the parsed {@link ExprNode} after unit lowering and literal
 * substitution, with every reference rewritten to the qualified name of the
 * feature it resolves to — the same normal form the SMT-LIB exporter will
 * serialise, which is why this is defined and required from the commit that
 * introduces evidence rather than from the commit that introduces SMT. Two
 * consequences follow and both are intended: reformatting a clause, or
 * reparsing the file, leaves the digest alone; changing a literal, a unit or a
 * feature the clause reads moves it.
 *
 * A row with no readable relation — a prose-only requirement, or a body the
 * shared parser could not read — still needs an identity, so it falls back to a
 * digest over the clause's qualified name and the text as written. That form is
 * tagged `text`, so a consumer can never mistake it for a normal form.
 */
export function obligationDigest(row: {
  node: ExprNode | null;
  vars: readonly ContractVariable[];
  expression: string;
  element: ContractRef;
}): string {
  const form =
    row.node === null
      ? { form: 'text', clause: row.element.qualifiedName, text: row.expression }
      : { form: 'expr', node: canonicalNode(row.node, row.vars) };
  return `sha256:${sha256Hex(canonicalJson(form))}`;
}

/** The expression tree with every reference canonicalised to a qualified name. */
function canonicalNode(node: ExprNode, vars: readonly ContractVariable[]): unknown {
  const byPath = new Map(vars.map((v) => [v.path, v.qualifiedName]));
  const walk = (n: ExprNode): unknown => {
    switch (n.kind) {
      case 'ref': {
        const path = n.path.join('.');
        // A path that resolves is written as the feature it names; one that does
        // not stays as written, marked, so two different unresolved names never
        // collapse into one digest.
        const q = byPath.get(path);
        return { kind: 'ref', name: q ?? `?${path}` };
      }
      case 'unary':
        return { kind: 'unary', op: n.op, operand: walk(n.operand) };
      case 'binary':
        return { kind: 'binary', op: n.op, left: walk(n.left), right: walk(n.right) };
      case 'if':
        return { kind: 'if', cond: walk(n.cond), then: walk(n.then), else: walk(n.else) };
      default:
        return n;
    }
  };
  return walk(node);
}

/* ───────────────────────────── the record itself ─────────────────────────── */

/**
 * What an engine may claim, exhaustively.
 *
 * `proved` is reserved for UNSAT-of-negation under a satisfiable axiom set. The
 * literal engine cannot reach it and never will: `holds-at-values` is a point
 * evaluation, and the two words are kept apart here so a display that upgrades
 * one to the other has to do so in the open.
 */
export type EvidenceClaim =
  | 'proved'
  | 'holds-at-values'
  | 'holds-structurally'
  | 'holds-within-bound'
  | 'refuted'
  | 'design-admitted'
  | 'vacuous'
  | 'inconclusive';

/**
 * The verdict facet, which is written for exactly two claims.
 *
 * `proved` ⇒ `pass`; `refuted` at the model's values ⇒ `fail`. Everything else
 * is `inconclusive`, and the finer claim lives in {@link EvidenceRecord.claim}.
 * A `pass` whose claim is not `proved` is the defect `verification/verdict-
 * overstates-evidence` names.
 */
export type EvidenceVerdict = 'pass' | 'fail' | 'inconclusive';

/** The point, bound or scope a claim holds within — never left to be inferred. */
export interface EvidenceBound {
  /** A branchable tag: what KIND of bound this is. */
  kind: 'model-values' | 'free-variables' | 'timeout' | 'scope' | 'none';
  /** The sentence a reader needs beside the tag. */
  detail: string;
  /**
   * The two magnitudes the comparison was actually made on, in coherent SI.
   *
   * Present whenever the unit-aware evaluator had both sides. It is here
   * because a WITNESS on its own can be read against the claim it supports: a
   * derived feature stores whatever its own equation produced — `uav.endurance`
   * stores `0.7877`, hours, with no declared unit — beside a requirement
   * written `>= 45.0 [min]`, and a reader shown only that number sees a
   * refutation. `{lhs: 2835.69, rhs: 2700, dimension: 'T'}` is what was
   * compared.
   */
  si?: { lhs: number; rhs: number; dimension?: string };
}

/** One record: one claim, about one obligation, by one engine, over one model. */
export interface EvidenceRecord {
  schema: 'sysprose-evidence/1';
  obligation: {
    /** The requirement's qualified name, or `null` for a model-level relation. */
    requirement: string | null;
    /** The `<R-UAV-001>` short name, or `''`. */
    shortId: string;
    /** The clause's qualified name. Never an element id. */
    clause: string;
    obligationDigest: string;
    /** The relation as written, for a person reading the record. */
    expression: string;
  };
  verdict: EvidenceVerdict;
  claim: EvidenceClaim;
  engine: 'literal' | 'smt';
  tool: ToolVersion;
  bound: EvidenceBound;
  /**
   * The point the claim was read at, when there is one.
   *
   * `role` is part of the value, not decoration: a `derived` feature stores the
   * magnitude its own equation produced, in whatever unit that arithmetic
   * landed in, and `unit` is `null` because the author declared none. Without
   * the role a reader cannot tell a stated value they could edit from a
   * computed one they could not, and the SI pair the comparison was made on is
   * in `bound.si`.
   */
  witness?: {
    kind: 'model-values';
    values: Array<{
      path: string;
      qualifiedName: string;
      value: number | boolean | string | null;
      unit: string | null;
      role: 'input' | 'output' | 'parameter' | 'derived';
    }>;
  };
  /** A machine-checkable artefact from an external engine. Never produced here. */
  certificate?: { format: string; text: string };
  modelVersion: ModelVersion;
  /** The command a reader can run to reproduce this record. */
  producedBy: string;
  /**
   * Every option that changed what was shown.
   *
   * A proof obtained under `--free uav.cruisePower` is a different claim from
   * one obtained with every value bound, and a record that did not say so could
   * be replayed as though the model had said something it did not.
   */
  flags: Record<string, string | number | boolean | string[]>;
  /** The `verification/*` code, for any claim that is not `proved` or `refuted`. */
  code?: string;
  /** The sentence the report printed. */
  detail: string;
}

/**
 * Build the records for a finished run.
 *
 * A pure function of the report: same run, same bytes. It is the one place the
 * `pass` facet rule is applied, so nothing else in this lane has to remember it.
 */
export function recordEvidence(input: {
  rows: ReadonlyArray<
    Omit<EvidenceRecord, 'schema' | 'tool' | 'modelVersion' | 'producedBy' | 'flags' | 'verdict'>
  >;
  modelVersion: ModelVersion;
  producedBy: string;
  flags: Record<string, string | number | boolean | string[]>;
}): EvidenceRecord[] {
  return input.rows.map((row) => ({
    schema: 'sysprose-evidence/1' as const,
    ...row,
    // Derived here rather than accepted from the caller — the input type has no
    // `verdict` field at all. This is the rule the plan states twice, and a rule
    // enforced in one place cannot be forgotten by the second caller that ships.
    verdict: verdictFor(row.claim),
    tool: input.modelVersion.sysprose,
    modelVersion: input.modelVersion,
    producedBy: input.producedBy,
    flags: input.flags,
  }));
}

/** `proved` ⇒ pass, `refuted` ⇒ fail, everything else ⇒ inconclusive. */
export function verdictFor(claim: EvidenceClaim): EvidenceVerdict {
  if (claim === 'proved') return 'pass';
  if (claim === 'refuted') return 'fail';
  return 'inconclusive';
}

/* ─────────────────── the carrier: evidence written into the file ─────────── */

/**
 * The attribute a whole record lives in, and the five beside it a person reads.
 *
 * WHY ONE JSON ATTRIBUTE AND NOT TWENTY. A record is nested — `bound.si.lhs`,
 * `witness.values[3].role`, `flags.free[0]` — and the notation's attribute
 * names are identifiers, so a field-per-attribute carrier would have to invent
 * a flattening (`boundSiLhs`) and an un-flattening, and every future field of
 * the schema would need both. Measured instead: a quoted string value survives
 * the round trip with its escapes intact — `attribute record = "{\"a\":\"x\\\"y\"}"`
 * comes back byte-identical — so the canonical JSON of the record IS the
 * carrier, and {@link evidenceOf} is a `JSON.parse` rather than a
 * reconstruction that could lose a field nobody tested.
 *
 * WHY THE FIVE OTHERS EXIST ANYWAY. The gate this commit is written against
 * says a verdict in the file always NAMES its tool, its version and its model
 * digest. It does that inside the JSON too, but a person opening the `.sysml`
 * reads lines, not a 2 kB string, and the claim word is the whole point of the
 * carrier. So five scalars are written above `record` as a RENDERING of it:
 * `claim`, `verdict`, `engine`, `tool`, `modelGraph`. They are derived on
 * write and ignored on read — {@link evidenceOf} answers from `record` alone —
 * because two readable copies of one datum can disagree, and the one that must
 * win is the one a consumer parses.
 *
 * Hand-editing either half is out of scope by declaration, not by oversight:
 * the plan's own trap register says the digest catches model edits, not edited
 * evidence, and nothing here pretends otherwise.
 */
export const EVIDENCE_RECORD_ATTR = 'record';

/** The scalars written above {@link EVIDENCE_RECORD_ATTR}, in written order. */
export const EVIDENCE_SUMMARY_ATTRS = ['claim', 'verdict', 'engine', 'tool', 'modelGraph'] as const;

/** `sysprose 0.4.0` — or with the commit, when the record names one. */
function toolLabel(tool: ToolVersion): string {
  return `${tool.name} ${tool.version}${tool.git !== undefined ? ` (${tool.git})` : ''}`;
}

/**
 * Is this element a `@SysproseVerification::Evidence { … }` carrier?
 *
 * Both spellings of the annotation's type are accepted — the qualified one this
 * module writes and a bare `@Evidence` a person may write after importing the
 * package — because the parser stores whatever was written and refusing the
 * short form would mean the tool could not read a carrier it told the reader
 * how to write. What is NOT accepted is a non-annotating `metadata Evidence`:
 * that owns facets FOR its owner in the requirement-metadata sense, and reading
 * it as a record would let the two carriers collide.
 */
export function isEvidenceCarrier(el: ElementRecord): boolean {
  if (el.eClass !== 'MetadataUsage' || el.attrs.annotation !== true) return false;
  const type = el.attrs.type;
  return type === EVIDENCE_QUALIFIED_NAME || type === EVIDENCE_DEFINITION;
}

/** The evidence carriers owned by one element, in file order. */
export function evidenceCarriers(model: Model, id: ElementId): ElementRecord[] {
  return model.children(id).filter(isEvidenceCarrier);
}

/** The text a carrier cell holds, unquoted — the same lexeme shape facets use. */
function cellText(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // A malformed literal is still text somebody wrote; hand it back unquoted
      // rather than dropping the carrier it is on.
    }
    return raw.slice(1, -1);
  }
  return raw;
}

/**
 * The record one carrier holds, or `undefined` when it holds nothing readable.
 *
 * `undefined` rather than a throw: a carrier a person hand-wrote, or one from a
 * future schema, is a fact about the file and not a reason for the checker to
 * stop. {@link evidenceStatus} counts them separately so they are visible
 * rather than silently absent.
 */
export function recordOfCarrier(model: Model, carrier: ElementRecord): EvidenceRecord | undefined {
  const cell = model
    .children(carrier.id)
    .find((c) => c.eClass === 'AttributeUsage' && c.declaredName === EVIDENCE_RECORD_ATTR);
  const text = cellText(cell?.attrs.value);
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const rec = parsed as EvidenceRecord;
    return rec.schema === 'sysprose-evidence/1' ? rec : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every evidence record attached under one element, in the order the file
 * carries them — which is the order they were attached, so the LAST one is the
 * most recent claim and the ones before it are what it replaced.
 */
export function evidenceOf(model: Model, id: ElementId): EvidenceRecord[] {
  const out: EvidenceRecord[] = [];
  for (const carrier of evidenceCarriers(model, id)) {
    const rec = recordOfCarrier(model, carrier);
    if (rec) out.push(rec);
  }
  return out;
}

/** One element carrying evidence, with what it carries. */
export interface EvidenceHolder {
  id: ElementId;
  qualifiedName: string;
  eClass: string;
  records: EvidenceRecord[];
  /** Carriers whose `record` could not be read — hand-written, or a future schema. */
  unreadable: number;
}

/** Every element in the user model that carries evidence, in model order. */
export function evidenceHolders(model: Model): EvidenceHolder[] {
  const out: EvidenceHolder[] = [];
  for (const el of model.all()) {
    if (!isUserElement(model, el)) continue;
    const carriers = evidenceCarriers(model, el.id);
    if (carriers.length === 0) continue;
    const records: EvidenceRecord[] = [];
    let unreadable = 0;
    for (const c of carriers) {
      const rec = recordOfCarrier(model, c);
      if (rec) records.push(rec);
      else unreadable++;
    }
    out.push({
      id: el.id,
      qualifiedName: model.qualifiedName(el.id),
      eClass: el.eClass,
      records,
      unreadable,
    });
  }
  return out;
}

/* ──────────────── one requirement, several obligations, one verdict ──────── */

/**
 * The identity of one obligation ACROSS runs: the clause and its normal form.
 *
 * The pair, never half of it. A clause name alone does not identify an
 * obligation — `require constraint { … }` twice under one requirement gives
 * both clauses the same qualified name `R::«ConstraintUsage»`, so keying on the
 * name would fuse two unrelated obligations and read the second one's verdict
 * as having REPLACED the first one's. A digest alone does not identify one
 * either: the same normal form can appear under two clauses, and re-recording
 * one of them is not a change to the other.
 *
 * DEFENSIVE ON BOTH HALVES, because {@link recordOfCarrier} admits any payload
 * that names the schema — a hand-written carrier, or one from a build that
 * spelled the obligation differently — and a checker rule that threw on one
 * would take `npm run check` down over a line somebody typed. A record with no
 * readable obligation gets a key of its own, so it supersedes nothing and
 * nothing supersedes it.
 */
function obligationKey(record: EvidenceRecord, index = 0): string {
  const ob: Partial<EvidenceRecord['obligation']> | undefined = record.obligation;
  if (typeof ob?.clause !== 'string' || typeof ob.obligationDigest !== 'string') {
    return `unkeyed record ${index}`;
  }
  return `${ob.clause} :: ${ob.obligationDigest}`;
}

/**
 * The records that still speak for an element: the LAST one per obligation.
 *
 * Evidence accumulates — `attachEvidence` appends and never deletes — so the
 * carriers on one requirement are a HISTORY, and the history of an obligation
 * is not the same thing as its current claim. Everything that summarises a
 * requirement (the verdict facet, the status row, the table cell, the
 * stale-evidence rule) reads the live set rather than the raw list, because a
 * superseded record is a fact about the past and must not be counted twice.
 *
 * Insertion order is preserved on the FIRST appearance of each obligation, so
 * a requirement's obligations keep the order the file carries them in.
 */
export function liveEvidence(records: readonly EvidenceRecord[]): EvidenceRecord[] {
  const byObligation = new Map<string, EvidenceRecord>();
  records.forEach((record, i) => byObligation.set(obligationKey(record, i), record));
  return [...byObligation.values()];
}

/**
 * How bad a verdict is. `fail` outranks `inconclusive` outranks `pass`.
 *
 * The order is the whole point of {@link summariseEvidence}: a requirement is
 * discharged only when EVERY obligation under it is, so the one verdict the
 * file carries has to be the worst of them.
 */
const VERDICT_RANK: Record<EvidenceVerdict, number> = { fail: 2, inconclusive: 1, pass: 0 };

/** One requirement's evidence, reduced to the one thing a facet can hold. */
export interface EvidenceSummary {
  /** The worst live verdict — derived from a claim, never read off a record. */
  verdict: EvidenceVerdict;
  /** The claim of the record that governs, so the claim word is never upgraded. */
  claim: EvidenceClaim;
  /** The governing record itself. */
  record: EvidenceRecord;
  /** Every live record, one per obligation, in file order. */
  live: EvidenceRecord[];
}

/**
 * The one verdict a requirement with several obligations carries: the WORST.
 *
 * WHY THIS IS NOT "THE LAST RECORD". A requirement may state several
 * obligations, and one run produces one record for each of them. Taking the
 * last record in file order would make the verdict depend on the ORDER THE
 * CLAUSES ARE WRITTEN IN: swap two lines in the source and the same evidence
 * writes `pass` where it wrote `fail`. Worse, it launders — a requirement whose
 * first clause is refuted and whose second is proved would record
 * `verdict = "pass"` on a file that carries a refutation, and every consumer
 * downstream (the status row, the table cell, the stale rule) would repeat it.
 *
 * AND THE VERDICT IS DERIVED FROM THE CLAIM, never read off the record's own
 * `verdict` field: {@link verdictFor} is the only place the `proved ⇒ pass` rule
 * lives, and a record file somebody edited is exactly the input this must not
 * trust.
 *
 * The tie-break among equally-bad obligations is the last one in file order, so
 * a requirement with ONE obligation still reports its most recent claim.
 */
export function summariseEvidence(
  records: readonly EvidenceRecord[],
): EvidenceSummary | undefined {
  const live = liveEvidence(records);
  if (live.length === 0) return undefined;
  let governing = live[0];
  for (const record of live.slice(1)) {
    if (VERDICT_RANK[verdictFor(record.claim)] >= VERDICT_RANK[verdictFor(governing.claim)]) {
      governing = record;
    }
  }
  return { verdict: verdictFor(governing.claim), claim: governing.claim, record: governing, live };
}

/* ────────────────────────────── attach / detach ──────────────────────────── */

/** Why one record could not be attached, in the reader's words. */
export interface EvidenceSkip {
  /** The record's clause, so the reader can find it in the `--record` file. */
  clause: string;
  reason: string;
}

/**
 * A verdict that CHANGED on this attach, which is the one thing that may never
 * happen quietly.
 *
 * `fail` → `pass` is the direction the plan names, and it is the direction a
 * laundered claim travels; every other change is reported too, because a reader
 * who is told about one direction and not the other learns to trust the silence.
 */
export interface VerdictChange {
  element: string;
  clause: string;
  from: EvidenceVerdict;
  to: EvidenceVerdict;
  fromClaim: EvidenceClaim;
  toClaim: EvidenceClaim;
  /** `fail` replaced by `pass` — the laundering direction, flagged by name. */
  launders: boolean;
}

/** What an attach did, in the terms the command prints. */
export interface AttachReport {
  /** Records written as a new carrier. */
  attached: number;
  /** Records already present, byte for byte, and therefore not written twice. */
  unchanged: number;
  /** Records that named nothing this model could carry them on. */
  skipped: EvidenceSkip[];
  /** Elements that gained a carrier, by qualified name. */
  elements: string[];
  /** Verdict facets written, by qualified name and value. */
  verdicts: Array<{ element: string; verdict: EvidenceVerdict; claim: EvidenceClaim }>;
  /** Every verdict this attach moved — printed, never swallowed. */
  changes: VerdictChange[];
}

/**
 * Write evidence records into the model, as annotations on what they are about.
 *
 * THREE REFUSALS, each replacing a write that would be lost or meaningless.
 * A LIBRARY element is refused: the bundled standard library is not the
 * reader's file, a carrier written onto it is never saved, and a caller aiming
 * evidence at `ISQ::MassValue` has the wrong element. A FAULTED declaration is
 * refused with {@link FAULTED_DECLARATION_REFUSAL} — the same sentence the
 * facet editors show — because the serializer re-emits that declaration's
 * source verbatim and everything written underneath it is gone on the next
 * save. And a record naming no requirement is SKIPPED rather than attached
 * somewhere plausible: evidence belongs on the thing it is evidence about.
 *
 * EVIDENCE ACCUMULATES. A second run APPENDS a carrier; nothing is overwritten
 * and no earlier verdict is deleted, so the file keeps the history of what was
 * claimed and when it changed. The one exception is a record that is already
 * there byte for byte, which is counted as `unchanged` — otherwise writing the
 * same run back into the same file twice would grow it without saying anything
 * new, and `evidence-attach` could not be run twice safely.
 *
 * THE VERDICT FACET IS DERIVED, NEVER ACCEPTED. Every verdict this function
 * writes — the facet on the requirement, the `verdict` summary cell on the
 * carrier, and the `verdict` field of the record it stores — comes out of
 * {@link verdictFor} applied to the CLAIM. The record's own `verdict` field is
 * never copied through, because a `--from` file is JSON somebody can edit and a
 * record that said `{"claim":"holds-at-values","verdict":"pass"}` would
 * otherwise launder a point evaluation into a proof on the way into the file.
 * So a `holds-at-values` record writes `inconclusive` however it is spelled,
 * and there is no path through this function by which a claim that is not
 * `proved` writes `pass`.
 *
 * AND A REQUIREMENT WITH SEVERAL OBLIGATIONS CARRIES THE WORST OF THEM
 * ({@link summariseEvidence}), not the last one written: a facet taken from the
 * last record would depend on the order the clauses happen to be written in,
 * and would let one clause's `pass` overwrite another clause's `fail`.
 *
 * NOTHING IS WRITTEN UNTIL EVERY TARGET HAS BEEN CHECKED. The two refusals
 * below are raised in a pass of their own, before the first carrier goes in,
 * because a throw from the middle of the write loop would leave the model
 * half-attached — carriers on the records it reached, no facets, and no report
 * saying which — and half an attach is worse than none.
 *
 * @throws when a record names a library element, or one whose declaration (or
 *   an enclosing one) could not be parsed.
 */
export function attachEvidence(
  model: Model,
  records: readonly EvidenceRecord[],
): AttachReport {
  const report: AttachReport = {
    attached: 0,
    unchanged: 0,
    skipped: [],
    elements: [],
    verdicts: [],
    changes: [],
  };

  // PASS ONE — resolve every target and raise every refusal, writing nothing.
  // An array of pairs rather than a Map keyed on the record: the same record
  // may legitimately appear twice in one `--from` file, and a Map would silently
  // collapse the duplicate instead of counting it as `unchanged`.
  const targets: Array<[EvidenceRecord, ElementRecord]> = [];
  for (const record of records) {
    const qn = record.obligation.requirement;
    if (qn === null || qn === '') {
      report.skipped.push({
        clause: record.obligation.clause,
        reason:
          'the record is about a model-level relation, not a requirement — there is no requirement ' +
          'to annotate, and evidence written anywhere else would be evidence about something else',
      });
      continue;
    }
    const target = resolveByQualifiedName(model, qn);
    if (!target) {
      report.skipped.push({
        clause: record.obligation.clause,
        reason: `no element of this model is called \`${qn}\` — the record was produced against a different file`,
      });
      continue;
    }
    if (!isUserElement(model, target)) {
      throw new Error(
        `attachEvidence: ${qn} is a bundled standard-library element. A carrier written onto the ` +
          'library is never saved with the reader’s file, so it would read back in memory and be ' +
          'gone the moment the model was reloaded.',
      );
    }
    if (!carriesItsOwnText(model, target.id)) {
      throw new Error(`attachEvidence: ${qn} — ${FAULTED_DECLARATION_REFUSAL}`);
    }
    targets.push([record, target]);
  }

  // Elements whose facet has to be recomputed. WIDER than the set that gained a
  // carrier: a record already present byte for byte writes nothing, but the
  // facet beside it may have drifted since — hand-edited, or written by an
  // older build — and `verification/verdict-overstates-evidence` names
  // re-attaching as its first remedy. A remedy that did nothing would be worse
  // than no remedy at all, so an `unchanged` record still repairs the facet.
  const facetTargets = new Set<ElementId>();
  const gained = new Set<ElementId>();

  // PASS TWO — write.
  for (const [record, target] of targets) {
    const qn = record.obligation.requirement as string;
    // Stored with its verdict DERIVED, so the carrier's payload can never
    // disagree with its own claim whatever the `--from` file said.
    const stored: EvidenceRecord = { ...record, verdict: verdictFor(record.claim) };
    const canonical = canonicalJson(stored);
    const existing = evidenceOf(model, target.id);
    facetTargets.add(target.id);
    if (existing.some((r) => canonicalJson(r) === canonical)) {
      report.unchanged++;
      continue;
    }
    // The verdict this record MOVES, if any. Compared against the most recent
    // record about the SAME OBLIGATION — the pair `clause` + `obligationDigest`,
    // which is the key the schema itself names. The clause alone would fuse two
    // anonymous obligations of one requirement (both are called
    // `R::«ConstraintUsage»`) and report a change between two claims that were
    // never about the same thing.
    const key = obligationKey(stored);
    const prior = [...existing].reverse().find((r) => obligationKey(r) === key);
    if (prior && verdictFor(prior.claim) !== stored.verdict) {
      report.changes.push({
        element: qn,
        clause: record.obligation.clause,
        from: verdictFor(prior.claim),
        to: stored.verdict,
        fromClaim: prior.claim,
        toClaim: stored.claim,
        launders: verdictFor(prior.claim) === 'fail' && stored.verdict === 'pass',
      });
    }

    writeCarrier(model, target.id, stored, canonical);
    report.attached++;
    if (!gained.has(target.id)) {
      gained.add(target.id);
      report.elements.push(qn);
    }
  }

  // The facet last, once per element, from the WORST live obligation under it —
  // so a requirement whose obligations disagree carries the verdict of the one
  // that is not discharged, whichever order the clauses were written in.
  for (const id of facetTargets) {
    const summary = summariseEvidence(evidenceOf(model, id));
    if (!summary) continue;
    const el = model.get(id);
    if (!el || !isRequirement(el.eClass)) continue;
    setRequirementAttr(model, id, 'verdict', summary.verdict);
    report.verdicts.push({
      element: model.qualifiedName(id),
      verdict: summary.verdict,
      claim: summary.claim,
    });
  }
  return report;
}

/** One carrier, written in the shape the notation reads back unchanged. */
function writeCarrier(
  model: Model,
  ownerId: ElementId,
  record: EvidenceRecord,
  canonical: string,
): void {
  model.transaction(() => {
    const carrier = model.create('MetadataUsage', {
      ownerId,
      attrs: { annotation: true, type: EVIDENCE_QUALIFIED_NAME },
    });
    const summary: Record<(typeof EVIDENCE_SUMMARY_ATTRS)[number], string> = {
      claim: record.claim,
      verdict: record.verdict,
      engine: record.engine,
      tool: toolLabel(record.tool),
      modelGraph: record.modelVersion.graph,
    };
    for (const key of EVIDENCE_SUMMARY_ATTRS) {
      model.create('AttributeUsage', {
        declaredName: key,
        ownerId: carrier.id,
        attrs: { value: JSON.stringify(summary[key]) },
      });
    }
    model.create('AttributeUsage', {
      declaredName: EVIDENCE_RECORD_ATTR,
      ownerId: carrier.id,
      attrs: { value: JSON.stringify(canonical) },
    });
  });
}

/**
 * An element by qualified name, falling back to a unique suffix match.
 *
 * `Model.resolveQualifiedName` walks the name segment by segment from the
 * roots, which is exactly right for the name a record carries — records write
 * qualified names precisely so this is possible. The suffix fallback is for the
 * one shape it cannot walk: an element whose owner chain includes an anonymous
 * member, whose qualified name contains a `«MetaClass»` segment nothing is
 * declared under.
 */
function resolveByQualifiedName(model: Model, qn: string): ElementRecord | undefined {
  const direct = model.resolveQualifiedName(qn);
  if (direct) return direct;
  const matches = model.all().filter((el) => model.qualifiedName(el.id) === qn);
  return matches.length === 1 ? matches[0] : undefined;
}

/** What a detach removed. */
export interface DetachReport {
  /** Carriers removed. */
  removed: number;
  /** Elements they came off, by qualified name. */
  elements: string[];
  /** Verdict facets cleared with them. */
  verdictsCleared: string[];
  /**
   * Verification cases the tool-written method annotation came off, by name.
   *
   * `evidence-attach` writes `@VerificationCases::VerificationMethod
   * { kind = analyze; }` onto a case that stated no method, so the file says
   * which method the verdict was reached under. A detach that left it behind
   * would make attach→detach non-inverse: the file would keep a tool-authored
   * claim about the METHOD that its author never wrote and no command removes.
   */
  methodAnnotationsRemoved: string[];
}

/** The two metaclasses a verification case is written as. */
const VERIFICATION_CASE_KINDS = new Set(['VerificationCaseDefinition', 'VerificationCaseUsage']);

/**
 * Take every evidence carrier off the model, and the verdict facets with them.
 *
 * THE FACET GOES WITH THE EVIDENCE, and that is the whole reason this is one
 * command rather than two. A `verdict = "pass"` left behind by a detach is a
 * claim with nothing behind it — exactly the state
 * `verification/claimed-without-evidence` exists to report — so a detach that
 * removed only the carriers would MANUFACTURE the defect this lane is written
 * against. A facet a person wrote by hand on a requirement that never carried
 * evidence is left alone: this only clears what it can see it wrote.
 *
 * THE METHOD ANNOTATION GOES WITH IT, for the same reason and with the same
 * limit. `evidence-attach` writes exactly one standard annotation —
 * `@VerificationCases::VerificationMethod { kind = analyze; }` on a case that
 * declared no method — and nothing in a file records who wrote it, so this
 * removes the exact shape it writes and nothing wider: annotating, typed
 * `VerificationMethod`, one `kind` cell, valued `analyze`. An author who wrote
 * that exact annotation by hand loses it here, which is the same trade the
 * `verdict` facet already makes; a case saying anything else about its method
 * — a second kind, `test`, an extra cell — is not this shape and is untouched.
 * And it happens only when the detach actually removed evidence, so a command
 * that found nothing to take off never edits a case.
 *
 * @param scopeId when given, only evidence under that element (and itself).
 */
export function detachEvidence(model: Model, scopeId?: ElementId): DetachReport {
  const report: DetachReport = {
    removed: 0,
    elements: [],
    verdictsCleared: [],
    methodAnnotationsRemoved: [],
  };
  const inScope = (id: ElementId): boolean => {
    if (scopeId === undefined) return true;
    if (id === scopeId) return true;
    return model.descendants(scopeId).some((d) => d.id === id);
  };
  model.transaction(() => {
    for (const holder of evidenceHolders(model)) {
      if (!inScope(holder.id)) continue;
      const carriers = evidenceCarriers(model, holder.id);
      if (carriers.length === 0) continue;
      for (const c of carriers) model.remove(c.id);
      report.removed += carriers.length;
      report.elements.push(holder.qualifiedName);
      const el = model.get(holder.id);
      if (el && isRequirement(el.eClass) && getRequirementAttr(model, holder.id, 'verdict') !== undefined) {
        setRequirementAttr(model, holder.id, 'verdict', null);
        report.verdictsCleared.push(holder.qualifiedName);
      }
    }
    if (report.removed === 0) return;
    for (const el of model.all()) {
      if (!VERIFICATION_CASE_KINDS.has(el.eClass)) continue;
      if (!isUserElement(model, el) || !inScope(el.id)) continue;
      for (const child of model.children(el.id)) {
        if (!isToolWrittenMethodAnnotation(model, child)) continue;
        model.remove(child.id);
        report.methodAnnotationsRemoved.push(model.qualifiedName(el.id));
      }
    }
  });
  return report;
}

/* ─────────────────────────────── the status ──────────────────────────────── */

/**
 * A verdict facet with no evidence behind it.
 *
 * INFO, not an error, and the severity is a judgement rather than a default: a
 * `verdict` facet is standard requirements management, and a programme whose
 * `verificationMethod` is `inspect` records a human's verdict there with no
 * tool involved at all. Reporting that as a defect would tell an engineer their
 * own process is a fault. What the row says is narrower and true: THIS tool has
 * no evidence for that verdict, so nothing here stands behind it.
 */
export const CLAIMED_WITHOUT_EVIDENCE_CODE = 'verification/claimed-without-evidence';

/**
 * A `verdict = "pass"` facet over a carrier whose claim is not `proved`.
 *
 * ERROR, and this one is not a judgement call: the two artefacts are both the
 * tool's own, they contradict each other, and the contradiction is in the
 * direction that overstates. `pass` is written for exactly one claim
 * ({@link verdictFor}), so a file in this state was either hand-edited or
 * written by something that did not go through this module — and either way the
 * file now claims more than the evidence beside it supports.
 */
export const VERDICT_OVERSTATES_EVIDENCE_CODE = 'verification/verdict-overstates-evidence';

/** What one requirement's evidence says about itself. */
export interface EvidenceStatusRow {
  id: ElementId;
  qualifiedName: string;
  shortId: string;
  /**
   * `current` — a record whose model digest still matches. `stale` — one taken
   * over a different model. `unrecorded` — a verdict facet with no carrier at
   * all. `none` — neither, which is most of a model and is not a finding.
   */
  status: 'current' | 'stale' | 'unrecorded' | 'none';
  /** The verdict facet the file states, if it states one. */
  claimedVerdict?: string;
  /** The most recent record's claim, if there is a record. */
  claim?: EvidenceClaim;
  /** The most recent record's verdict. */
  verdict?: EvidenceVerdict;
  /** The digest the record was taken against. */
  recordedGraph?: string;
  /** Records attached here. */
  records: number;
  /** Carriers whose payload could not be read back. */
  unreadable: number;
  /**
   * The requirement's slice — what a reader must re-check before believing a
   * stale record. Qualified names, nearest hop first, from
   * `impactClosure(model, id, 2)`.
   */
  slice: string[];
  /** The sentence the report prints for this row. */
  detail: string;
  /** The `verification/*` code, when the row is one. */
  code?: string;
}

/** Every row, plus the digest they were all compared against. */
export interface EvidenceStatusReport {
  /** The model's digest right now — what every `current` row matched. */
  graph: string;
  rows: EvidenceStatusRow[];
  current: number;
  stale: number;
  unrecorded: number;
  overstated: number;
}

/**
 * How much of the model a stale row names — two hops, per the plan's §3.10.
 *
 * Two rather than one because a requirement's clause reads FEATURES, and a
 * feature's value is one hop further out than the feature: at depth 1 a stale
 * row named the clause and the subject and nothing a reader could have edited.
 */
export const EVIDENCE_SLICE_DEPTH = 2;

/**
 * What was shown, over which model, and whether it still holds.
 *
 * THE COMPARISON IS A DIGEST AND NOTHING ELSE, and the limit that follows is
 * stated on every stale row rather than hidden: the digest is taken over the
 * WHOLE user model, so any edit anywhere moves it, and this function cannot say
 * WHICH element changed — it never saw the earlier model, only its hash. What
 * it can do is name the slice a reader has to re-read before believing the
 * record again, which is what `impactClosure(model, id, 2)` is for.
 *
 * MUST NEVER UPGRADE A CLAIM. A `holds-at-values` row is never shown as
 * *proved*, a stale row is never counted as discharged, and a `pass` facet over
 * a claim that is not `proved` is a finding rather than a verdict.
 *
 * AND A ROW SUMMARISES OBLIGATIONS, NOT CARRIERS. A requirement may state
 * several, each with its own record and its own history; the row reads the LIVE
 * set ({@link liveEvidence}) and reports the WORST of them
 * ({@link summariseEvidence}), so a refuted clause cannot be hidden behind a
 * discharged one that happened to be written after it, and a superseded record
 * cannot keep a row stale after the obligation was re-recorded.
 */
export function evidenceStatus(model: Model): EvidenceStatusReport {
  const graph = modelVersionOf(model).graph;
  const holders = new Map(evidenceHolders(model).map((h) => [h.id, h]));
  const rows: EvidenceStatusRow[] = [];

  for (const el of model.all()) {
    if (!isUserElement(model, el)) continue;
    const holder = holders.get(el.id);
    const isReq = isRequirement(el.eClass);
    const claimed = isReq ? getRequirementAttr(model, el.id, 'verdict') : undefined;
    if (!holder && claimed === undefined) continue;

    const qualifiedName = model.qualifiedName(el.id);
    const shortId = isReq ? requirementShortId(model, el.id) : '';
    const records = holder?.records ?? [];
    const summary = summariseEvidence(records);
    // STALE IF ANY LIVE OBLIGATION IS. One re-recorded clause does not make the
    // requirement current again while another clause's record still names an
    // older model.
    const staleRecord = summary?.live.find((r) => r.modelVersion.graph !== graph);
    const slice =
      staleRecord !== undefined
        ? impactClosure(model, el.id, EVIDENCE_SLICE_DEPTH).impacted.map(
            (i) => i.element.qualifiedName || i.element.id,
          )
        : [];

    const base = {
      id: el.id,
      qualifiedName,
      shortId,
      records: records.length,
      unreadable: holder?.unreadable ?? 0,
      slice,
      ...(claimed !== undefined ? { claimedVerdict: claimed } : {}),
      ...(summary !== undefined
        ? {
            claim: summary.claim,
            verdict: summary.verdict,
            // The digest a reader has to act on: the stale one when there is
            // one, because that is the record that no longer stands.
            recordedGraph: (staleRecord ?? summary.record).modelVersion.graph,
          }
        : {}),
    };

    if (!summary) {
      const unreadable = holder?.unreadable ?? 0;
      if (claimed === undefined) {
        // A carrier this tool cannot read on something that states no verdict.
        // NOT `claimed-without-evidence`: that code's precondition is a verdict
        // facet, and reporting a code whose `when` sentence is false of the row
        // teaches a reader to distrust the catalogue. Reported anyway, because
        // a carrier nothing can parse is a fact about the file — but as what it
        // is, and without inflating the `unrecorded` count.
        rows.push({
          ...base,
          status: 'none',
          detail:
            `${unreadable} evidence carrier(s) here could not be read back — this element states ` +
            'no verdict, so nothing is being claimed, but nothing this tool wrote is readable ' +
            'either. Re-run `verify --record` and `evidence-attach`, or remove the carrier.',
        });
        continue;
      }
      // A verdict facet and no readable record. An unreadable carrier is named
      // rather than counted as evidence: a payload nothing can parse supports
      // nothing, and calling that row `current` would be the exact upgrade this
      // function is written to refuse.
      rows.push({
        ...base,
        status: 'unrecorded',
        code: CLAIMED_WITHOUT_EVIDENCE_CODE,
        detail:
          `unrecorded — the file states verdict = "${claimed}" and this tool has no evidence ` +
          `behind it${unreadable > 0 ? ` (${unreadable} carrier(s) here could not be read back)` : ''}. ` +
          'Run `verify --record` and `evidence-attach`, or read it as a verdict somebody reached another way.',
      });
      continue;
    }

    const stale = staleRecord !== undefined;
    // The overstatement test is over the FACET against the CLAIM the evidence
    // summarises to. `pass` is written for `proved` alone, and a requirement
    // with several obligations is proved only when every one of them is — so
    // the governing claim is the one the facet has to match.
    const overstates = claimed === 'pass' && summary.claim !== 'proved';
    rows.push({
      ...base,
      status: stale ? 'stale' : 'current',
      ...(overstates
        ? {
            code: VERDICT_OVERSTATES_EVIDENCE_CODE,
            detail:
              `the file states verdict = "pass" over a record whose claim is \`${summary.claim}\` — ` +
              '`pass` is written for `proved` alone, and nothing here proved anything. ' +
              `The record is ${stale ? 'stale' : 'current'} (${(staleRecord ?? summary.record).modelVersion.graph}).`,
          }
        : {
            detail: stale
              ? `stale — recorded at ${staleRecord.modelVersion.graph}, the model is now ${graph}; ` +
                `${slice.length} element(s) in this requirement’s slice must be re-read, and the ` +
                'digest is over the whole model so this tool cannot say which of them moved. ' +
                'Re-run `verify --record`.'
              : `current — the model still hashes to ${graph}; claim \`${summary.claim}\`, ` +
                `verdict \`${summary.verdict}\`, by ${toolLabel(summary.record.tool)}` +
                `${summary.live.length > 1 ? ` (the weakest of ${summary.live.length} obligations)` : ''}.`,
          }),
    });
  }

  return {
    graph,
    rows,
    current: rows.filter((r) => r.status === 'current').length,
    stale: rows.filter((r) => r.status === 'stale').length,
    unrecorded: rows.filter((r) => r.status === 'unrecorded').length,
    overstated: rows.filter((r) => r.code === VERDICT_OVERSTATES_EVIDENCE_CODE).length,
  };
}
