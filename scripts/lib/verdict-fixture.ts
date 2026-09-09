/**
 * The verdict-bearing model the interoperability probe pushes.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT `buildSampleModel`. The plan's §3.10 says,
 * in the same paragraph that describes the evidence carrier, that the round trip
 * which matters is Sysprose → somebody else's tool, and that pushing our own
 * sample model proves nothing about it: a sample model carries no verdict facet
 * and no `@SysproseVerification::Evidence` annotation, so a green round trip of
 * it says only that ordinary parts survive the wire. What has to survive is the
 * pair of things this lane WRITES, both of which are tool-local tags the
 * standard does not define — a `metadata RequirementMetadata { attribute verdict
 * = "…"; }` cell and an `@SysproseVerification::Evidence { … }` carrier holding
 * the record — because a foreign reader is entitled to drop what it does not
 * recognise, and "entitled to" and "does" are different sentences.
 *
 * THE CARRIER IS WRITTEN BY THE TOOL, NOT TYPED HERE. The source below holds no
 * verdict: {@link buildVerdictBearingModel} runs the real `verify` and the real
 * `attachEvidence` over it, so what goes on the wire is what this tool actually
 * produces, down to the claim word and the digest. A carrier pasted in by hand
 * would probe the fixture author's memory of the write path instead of the write
 * path. The engine is `literal`, which needs no solver, so the probe runs
 * anywhere — and its claim is `holds-at-values`, whose facet is `inconclusive`:
 * the probe is about the JSON surviving, and inventing a `pass` here to make the
 * fixture look better would be the exact laundering `attachEvidence` refuses.
 *
 * It is shared between `scripts/pilot-write-roundtrip.ts` (the LIVE probe
 * against `SYSMLV2_PILOT_URL`) and `test/interop/self-roundtrip.test.ts` (the
 * offline one against `createServer()`), so the two cannot drift into probing
 * different things.
 */
import { attachEvidence } from '../../src/api/evidence';
import { verifyModel } from '../../src/api/verification';
import type { Model } from '../../src/core/index';
import { loadModelText } from '../../src/text/load';

/**
 * A requirement, its subject and one bounded clause — with no library types, so
 * the fixture parses with zero diagnostics wherever it is loaded and the probe
 * never has to distinguish a wire failure from a resolution failure.
 */
export const VERDICT_FIXTURE_SOURCE = `package InteropVerdict {
    part def Airframe {
        attribute mass = 18.5;
    }
    part airframe : Airframe;
    requirement def MassLimit {
        doc /* The airframe shall stay within the 25 kg limit. */
        subject airframe : Airframe;
        require constraint {
            airframe.mass <= 25.0
        }
    }
    satisfy MassLimit by airframe;
}
`;

/** What the probe looks for on both sides of the wire. */
export interface VerdictBearingSignature {
  /** `@SysproseVerification::Evidence` carriers, by owner qualified name. */
  carriers: string[];
  /** Every `verdict` cell, as `owner qualified name = value`. */
  verdicts: string[];
  /** Every summary cell on a carrier (`claim`, `engine`, …), as `name = value`. */
  cells: string[];
  /** Length of the stored record JSON — the longest string on the wire. */
  recordChars: number;
}

/**
 * Load the fixture, verify it and write the evidence back into it.
 *
 * @returns the model with the carrier and the facet in it, plus the source text
 *   the digest inside the record was taken over.
 */
export async function buildVerdictBearingModel(): Promise<{ model: Model; source: string }> {
  const loaded = await loadModelText(VERDICT_FIXTURE_SOURCE, {
    fileName: 'interop-verdict.sysml',
    library: 'none',
  });
  // `loadModelText` never throws: a fixture it could not bind comes back with no
  // model, and pushing `undefined` at the probe would report a parse failure of
  // OURS as though the far end had dropped something.
  const model = loaded.model;
  if (!model) throw new Error('the verdict fixture no longer parses; the interop probe has nothing to push');
  const report = await verifyModel(model, {
    engine: 'literal',
    sourceText: VERDICT_FIXTURE_SOURCE,
    producedBy: 'sysprose verify --engine literal (interop probe)',
  });
  attachEvidence(model, report.records);
  return { model, source: VERDICT_FIXTURE_SOURCE };
}

/**
 * The signature the probe compares across the wire.
 *
 * Read off the ELEMENT GRAPH rather than off the evidence API, because the
 * pulled model is whatever came back: a reader that dropped the carrier's
 * children, or kept the carrier and lost the record string, must show up as a
 * difference here rather than as an exception inside a helper that assumed the
 * shape it was looking for.
 */
export function verdictBearingSignature(model: Model): VerdictBearingSignature {
  const qn = (id: string | null): string =>
    (id && model.qualifiedName(id)) || `«${(id && model.get(id)?.eClass) ?? '?'}»`;
  const carriers: string[] = [];
  const verdicts: string[] = [];
  const cells: string[] = [];
  let recordChars = 0;
  for (const el of model.all()) {
    const type = String(el.attrs.type ?? el.attrs.typeRef ?? el.declaredName ?? '');
    if (el.eClass === 'MetadataUsage' && /(^|::)Evidence$/.test(type)) {
      carriers.push(qn(el.ownerId));
    }
    if (el.eClass === 'AttributeUsage' && typeof el.attrs.value === 'string') {
      const name = el.declaredName ?? '';
      const value = el.attrs.value;
      if (name === 'record') recordChars = Math.max(recordChars, value.length);
      else if (name === 'verdict') verdicts.push(`${qn(el.ownerId)} = ${value}`);
      else if (name !== '') cells.push(`${name} = ${value}`);
    }
  }
  return {
    carriers: carriers.sort(),
    verdicts: verdicts.sort(),
    cells: cells.sort(),
    recordChars,
  };
}
