/**
 * LIVE write round-trip against a real OMG SysML v2 pilot API server:
 * create a throwaway project → commit a VERDICT-BEARING model (OMG
 * Commit/DataVersion format) → pull the elements back → report what survived →
 * DELETE the project (cleanup).
 * Read-only-safe except the one test project it creates and then deletes.
 *
 * WHAT CHANGED, AND WHY IT IS THE POINT OF THE PROBE. This script used to push
 * a bare `Package` named `InteropTest`, which answered "does the write path
 * work" and nothing else. The question the verification lane actually owes a
 * reader is narrower and harder: this tool writes a `verdict` facet and an
 * `@SysproseVerification::Evidence` carrier that the standard does not define —
 * both are §7.27 metadata over a `metadata def`, i.e. tool-local tags holding
 * quoted strings — and a conforming reader is *entitled* to drop what it does
 * not recognise. Whether a real one DOES is a fact about someone else's server
 * that no amount of testing inside Sysprose can establish. So the fixture is
 * now the verdict-bearing model of `scripts/lib/verdict-fixture.ts`, written by
 * the real `verify` + `attachEvidence` path, and the round trip is compared on
 * exactly the things this lane writes.
 *
 * THREE STAGES, BECAUSE ONE 500 WOULD HAVE HIDDEN THE ANSWER — AND BECAUSE THE
 * LAST REPAIR COSTS A MEASUREMENT. Stage 1 pushes what this tool writes, byte
 * for byte. Stage 2 repairs three NAMED defects of our own element-graph dialect
 * ({@link DIALECT_REPAIRS}) and pushes again. Stage 3 drops one more property,
 * `MetadataUsage.type` ({@link TYPE_REPAIR}), which the pilot ALSO refuses — and
 * that repair is held back to a stage of its own precisely because `type` is the
 * only thing on the wire naming which `metadata def` a carrier instances. Once
 * it is gone a carrier is indistinguishable from any other `MetadataUsage`, so
 * the carrier row of stage 3 would measure OUR erasure and report it as the far
 * end's loss; it is printed as NOT MEASURABLE instead. Every repair is named and
 * printed before it is applied, so a reader can tell the stages apart and nobody
 * can quote a later stage as though the tool had written what it pushed.
 *
 * The transport stays hand-rolled rather than going through `PilotApiClient`:
 * the client's `createCommit` posts our own server's `{branch, changes:[{
 * operation, element }]}` dialect, while the pilot wants
 * `{'@type':'Commit', change:[DataVersion{identity,payload}]}`. Sending the
 * wrong dialect would fail as a *transport* error and be recorded as though the
 * pilot had dropped the metadata.
 *
 * It answers the API/JSON path only. What a foreign TEXTUAL parser makes of the
 * `.sysml` bytes is a different question, and this script does not touch it.
 *
 *   npx tsx scripts/pilot-write-roundtrip.ts          # the public OMG pilot
 *   SYSMLV2_PILOT_URL=… npx tsx scripts/pilot-write-roundtrip.ts
 */
import { PRODUCT_SLUG } from '../src/branding';
import { ModelApi, type OmgElementJSON } from '../src/api/index';
import { elementsToModel } from '../src/interop/index';
import { buildVerdictBearingModel, verdictBearingSignature } from './lib/verdict-fixture';

const BASE = process.env.SYSMLV2_PILOT_URL || 'http://sysml2.intercax.com:9000';
const TOKEN = process.env.SYSMLV2_PILOT_TOKEN;

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data: any; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data).slice(0, 400)}`);
  return data;
}

/**
 * The three places our element JSON disagrees with the metamodel the pilot
 * validates against, each stated as what we send and what the standard says.
 *
 * They are OURS, not the pilot's: every one of them is a property this project
 * writes in a shape the specification does not give it. Repairing them here
 * repairs the PROBE, not the tool — the fix belongs in the serializer and is not
 * this script's to make.
 */
const DIALECT_REPAIRS = [
  '`Satisfy` → `SatisfyRequirementUsage` (the metaclass name the standard gives it)',
  '`RequirementDefinition.text` scalar → list (`text : String[0..*]`)',
  'drop `MetadataUsage.annotation` (boolean), where the standard has `annotation : Annotation[0..*]`',
] as const;

/**
 * The fourth defect, held back to a stage of its own.
 *
 * The specification DERIVES `MetadataUsage.type` from the annotated definition
 * rather than storing it, so sending it is as much our defect as the other
 * three — and the pilot refuses it just as flatly (stage 2 below is stage 3 with
 * only this property kept, and it comes back 500). But `type` is also the only
 * property on the wire that says an `@SysproseVerification::Evidence` carrier is
 * one: {@link verdictBearingSignature} reads it to find carriers at all. Drop it
 * and the carrier count comes back 0 from a PERFECT echo. So it is repaired in
 * its own stage, and that stage reports the carrier row as not measurable.
 */
const TYPE_REPAIR =
  'drop `MetadataUsage.type` (string), which the specification derives — and which is the only property on the wire identifying an evidence carrier';

/**
 * Apply {@link DIALECT_REPAIRS} to a copy of the element set, and
 * {@link TYPE_REPAIR} as well when `alsoType` is set (stage 3 only).
 */
function repairDialect(elements: readonly OmgElementJSON[], alsoType = false): OmgElementJSON[] {
  return elements.map((e) => {
    const p: OmgElementJSON = { ...e };
    if (p['@type'] === 'Satisfy') p['@type'] = 'SatisfyRequirementUsage';
    if (typeof p.text === 'string') p.text = [p.text];
    if (p['@type'] === 'MetadataUsage') {
      delete p.annotation;
      if (alsoType) delete p.type;
    }
    return p;
  });
}

/** Does this element set still carry what identifies an evidence carrier? */
function carriersAreIdentifiable(elements: readonly OmgElementJSON[]): boolean {
  return elements.some((e) => e['@type'] === 'MetadataUsage' && typeof e.type === 'string');
}

/**
 * The four structural facts the round trip is also claimed to preserve.
 *
 * Read off the raw element JSON on BOTH sides, because the claim is about the
 * wire: "ids, metaclasses, declaredNames and containment preserved, and `text`
 * returned as written once it was a list" is a sentence `docs/CONFORMANCE.md`
 * §6.1 prints, and a sentence a doc prints has to be one this script re-derives
 * on a re-run rather than one a reader takes on trust.
 */
interface StructuralSignature {
  ids: string[];
  metaclasses: string[];
  names: string[];
  containment: string[];
  texts: string[];
}

/** The `@id` a reference field points at, whatever shape the far end used. */
function refId(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof (v as { '@id'?: unknown })['@id'] === 'string') {
    return (v as { '@id': string })['@id'];
  }
  return null;
}

function structuralSignature(elements: readonly Record<string, any>[]): StructuralSignature {
  const ids: string[] = [];
  const metaclasses: string[] = [];
  const names: string[] = [];
  const containment: string[] = [];
  const texts: string[] = [];
  for (const e of elements) {
    const id = String(e['@id'] ?? '');
    ids.push(id);
    metaclasses.push(`${id}: ${String(e['@type'] ?? '?')}`);
    if (typeof e.declaredName === 'string') names.push(`${id} = ${e.declaredName}`);
    const owner = refId(e.owner);
    if (owner) containment.push(`${id} in ${owner}`);
    if (e.text !== undefined) texts.push(`${id} = ${JSON.stringify(e.text)}`);
  }
  return {
    ids: ids.sort(),
    metaclasses: metaclasses.sort(),
    names: names.sort(),
    containment: containment.sort(),
    texts: texts.sort(),
  };
}

/** Report one side of a comparison, and say whether it held. */
function compare(what: string, sent: readonly string[], back: readonly string[]): boolean {
  const ok = sent.length === back.length && sent.every((x, i) => x === back[i]);
  console.log(`  ${ok ? 'KEPT' : 'LOST'}  ${what}: sent ${sent.length}, back ${back.length}`);
  if (!ok) {
    for (const x of sent.filter((s) => !back.includes(s))) console.log(`        only sent: ${x}`);
    for (const x of back.filter((b) => !sent.includes(b))) console.log(`        only back: ${x}`);
  }
  return ok;
}

/**
 * Push one element set into a fresh project, pull it back and report.
 *
 * @returns whether everything this lane writes came back as it was sent, or
 *   `undefined` when the server refused the commit outright.
 */
async function probe(stage: string, elements: readonly OmgElementJSON[]): Promise<boolean | undefined> {
  const { model } = await buildVerdictBearingModel();
  const sent = verdictBearingSignature(model);
  const sentShape = structuralSignature(elements as readonly Record<string, any>[]);
  let pid: string | undefined;
  try {
    const name = `${PRODUCT_SLUG}-interop-test-${Date.now()}`;
    const proj = await call('POST', '/projects', { '@type': 'Project', name });
    pid = proj['@id'];
    console.log(`${stage}: project "${name}"  id=${pid}`);
    const bid = proj.defaultBranch?.['@id'] ?? (await call('GET', `/projects/${pid}/branches`))[0]['@id'];

    const commit = await call('POST', `/projects/${pid}/commits?branchId=${bid}`, {
      '@type': 'Commit',
      change: elements.map((payload) => ({
        '@type': 'DataVersion',
        identity: { '@id': payload['@id'], '@type': 'DataIdentity' },
        payload,
      })),
    });
    const cid = commit['@id'];
    console.log(`  committed ${elements.length} element(s) -> commit ${cid}`);

    const body = await call('GET', `/projects/${pid}/commits/${cid}/elements`);
    const els: any[] = Array.isArray(body) ? body : body.elements ?? [];
    console.log(`  pulled ${els.length} element(s)`);
    // The structure first: what came back at all, before what it carried.
    const backShape = structuralSignature(els);
    compare('element ids', sentShape.ids, backShape.ids);
    compare('metaclasses', sentShape.metaclasses, backShape.metaclasses);
    compare('declaredNames', sentShape.names, backShape.names);
    compare('containment (owner)', sentShape.containment, backShape.containment);
    compare('text bodies', sentShape.texts, backShape.texts);

    const back = verdictBearingSignature(elementsToModel(els));
    // The carrier row is a measurement only while the discriminator is on the
    // wire. Where our own repair removed it, say so rather than score it.
    const comparable = carriersAreIdentifiable(elements);
    if (!comparable) {
      console.log(
        `  N/A   evidence carriers: sent ${sent.carriers.length}, back NOT MEASURABLE — this ` +
          "stage's own repair dropped `MetadataUsage.type`, the only property naming a carrier",
      );
    }
    const kept = [
      ...(comparable ? [compare('evidence carriers', sent.carriers, back.carriers)] : []),
      compare('verdict cells', sent.verdicts, back.verdicts),
      compare('record summary cells', sent.cells, back.cells),
    ];
    const recordKept = back.recordChars === sent.recordChars;
    console.log(
      `  ${recordKept ? 'KEPT' : 'LOST'}  stored record string: sent ${sent.recordChars} chars, back ${back.recordChars}`,
    );
    return kept.every(Boolean) && recordKept;
  } catch (e) {
    console.log(`  REFUSED  ${(e as Error).message}`);
    return undefined;
  } finally {
    if (pid) {
      try { await call('DELETE', `/projects/${pid}`); console.log(`  deleted test project ${pid}`); }
      catch (e) { console.log(`  cleanup: could not delete ${pid}: ${(e as Error).message}`); }
    }
  }
}

const { model } = await buildVerdictBearingModel();
const sent = verdictBearingSignature(model);
const elements = new ModelApi(model).toModelJSON();
console.log(
  `fixture: ${elements.length} element(s), ${sent.carriers.length} evidence carrier(s), ` +
    `${sent.verdicts.length} verdict cell(s), record ${sent.recordChars} chars`,
);
console.log(`target: ${BASE}`);

const asWritten = await probe('stage 1 — as this tool writes it', elements);
let repaired: boolean | undefined;
let withoutType: boolean | undefined;
if (asWritten === undefined) {
  console.log('stage 2 — the same model with three defects of OUR dialect repaired:');
  for (const r of DIALECT_REPAIRS) console.log(`  · ${r}`);
  repaired = await probe('stage 2 — dialect repaired', repairDialect(elements));
  if (repaired === undefined) {
    console.log('stage 3 — the same again, plus the one repair that costs a measurement:');
    console.log(`  · ${TYPE_REPAIR}`);
    withoutType = await probe(
      'stage 3 — carrier discriminator dropped too',
      repairDialect(elements, true),
    );
  }
}

console.log('');
console.log(
  asWritten === true
    ? 'RESULT: the verdict facet and the evidence carrier came back as sent.'
    : asWritten === false
      ? 'RESULT: the commit was accepted and part of what this lane writes did not come back (above).'
      : repaired === true
        ? 'RESULT: refused as written; with our three dialect defects repaired, everything this lane writes came back.'
        : repaired === false
          ? 'RESULT: refused as written; with our three dialect defects repaired the commit was accepted, and the verdict cells did NOT come back — the pilot keeps the elements and drops the tool-local values.'
          : withoutType === undefined
            ? 'RESULT: the server refused the model as written and both repaired forms — no interop claim either way.'
            : withoutType
              ? 'RESULT: refused until `MetadataUsage.type` was dropped as well; with it gone the commit was accepted and every value this lane writes came back. The carrier row is NOT MEASURABLE at that stage — dropping `type` is our own repair, and it is what makes a carrier unidentifiable.'
              : 'RESULT: refused until `MetadataUsage.type` was dropped as well; with it gone the commit was accepted and the verdict cells did NOT come back — the pilot keeps the elements and drops the tool-local values. The carrier row is NOT MEASURABLE at that stage — dropping `type` is our own repair, and it is what makes a carrier unidentifiable.',
);
process.exitCode = asWritten === true ? 0 : 1;
