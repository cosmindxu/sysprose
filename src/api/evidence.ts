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

import { type ElementId, type ElementRecord, type Model } from '@core/index';
import { PRODUCT_SLUG, PRODUCT_VERSION } from '../branding';
import { FULL_LIBRARY_MANIFEST_COUNT } from '../library/full-library';
import { type ExprNode } from '../semantics/expr';
import { type ContractRef, type ContractVariable } from '../semantics/contracts';
import { isUserElement } from './analytics';

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
 */
export function canonicalElements(model: Model): string[] {
  const snapshot = model.toJSONWhere((el) => isUserElement(model, el));
  return snapshot.elements
    .map((el) => [model.qualifiedName(el.id), canonicalJson(canonicalElement(model, el))] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([, json]) => json);
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
