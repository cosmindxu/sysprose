/**
 * The evidence lane's primitives, pinned where a golden cannot pin them.
 *
 * WHY THIS FILE EXISTS AT ALL. `src/api/evidence.ts` implements SHA-256 by hand
 * — `node:crypto` is unreachable from the browser bundle and `crypto.subtle` is
 * asynchronous where every caller is not — and its own doc comment says "a hash
 * with no known-answer test is a hash nobody can trust". It then named this
 * file, which did not exist. Every digest in the lane, and the twelve L8
 * goldens that quote them, rested on twelve opaque hex strings that agree with
 * each other by construction: a padding bug present from the first run would
 * have been recorded INTO the goldens and nothing would ever have gone red.
 *
 * The vectors below are the published FIPS 180-4 ones plus a length sweep
 * across the padding boundary (a message of 55, 56, 63, 64 or 65 bytes is where
 * a hand-written implementation gets the extra block wrong) and non-ASCII input
 * (the hash is over UTF-8 bytes, not UTF-16 code units). `node:crypto` is the
 * differential oracle — available here because a test runs in Node even though
 * the module under test may not.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  attachEvidence,
  canonicalElements,
  detachEvidence,
  evidenceHolders,
  evidenceOf,
  evidenceStatus,
  isEvidenceArtefact,
  isEvidenceCarrier,
  modelVersionOf,
  recordEvidence,
  sha256Hex,
  verifyModel,
  CLAIMED_WITHOUT_EVIDENCE_CODE,
  VERDICT_OVERSTATES_EVIDENCE_CODE,
  type EvidenceRecord,
} from '@api/index';
import { isUserElement } from '@api/index';
import { FAULTED_DECLARATION_REFUSAL, getRequirementAttr, setRequirementAttr } from '@semantics/index';
import { validate } from '@validation/index';
import { serializeElement } from '@text/index';
import { loadModelText } from '@text/load';
import type { Model } from '@core/index';

/** The oracle: Node's own SHA-256 over the same UTF-8 bytes. */
const reference = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

describe('sha256Hex — the published known answers', () => {
  // FIPS 180-4 §D and the two standard extras. Written out rather than computed
  // so a reader can check them against the document, and so this file would
  // still be a test if the oracle below were removed.
  const VECTORS: Array<[string, string]> = [
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
    [
      'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
      'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
    ],
  ];

  for (const [input, expected] of VECTORS) {
    it(`hashes ${input === '' ? 'the empty string' : `${input.length} byte(s)`} to the published digest`, () => {
      expect(sha256Hex(input)).toBe(expected);
      // And the same value the platform computes, so a transcription error in
      // the constant above cannot make this case pass for the wrong reason.
      expect(sha256Hex(input)).toBe(reference(input));
    });
  }

  it('agrees with node:crypto across the whole padding boundary', () => {
    // 0..130 covers every residue mod 64 twice, including the 56..63 band where
    // the length field does not fit in the final block and one more must be
    // emitted — the single most common defect in a hand-written SHA-256.
    for (let n = 0; n <= 130; n++) {
      const s = 'a'.repeat(n);
      expect(sha256Hex(s), `length ${n}`).toBe(reference(s));
    }
  });

  it('hashes the UTF-8 bytes, not the UTF-16 code units', () => {
    // A digest keyed on code units would agree with the oracle on ASCII and
    // silently disagree on every accented character an engineer writes in a
    // requirement, and on any emoji in a doc comment.
    for (const s of ['é', 'ü ber', '日本語', '😀', 'a😀b', '—']) {
      expect(sha256Hex(s), s).toBe(reference(s));
    }
  });

  it('handles a message long enough to need many blocks', () => {
    const s = 'a'.repeat(100_000);
    expect(sha256Hex(s)).toBe(reference(s));
  });

  it('returns 64 lowercase hex characters, always', () => {
    for (const s of ['', 'abc', 'a'.repeat(64), '日本語']) {
      expect(sha256Hex(s), s).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});


/* ══════════════════════ the file half of the lane (§3.10) ═══════════════════ */

/**
 * WHAT THESE CASES ARE FOR, and why they are not a golden.
 *
 * The L8 corpus pins what an ENGINE claims. Nothing there touches the file: a
 * verdict only becomes durable when it is written into the `.sysml`, and every
 * defect this commit can ship lives on that path — a record that cannot be read
 * back, an attach that overwrites a refutation, a digest that makes every
 * record stale the instant it is written, a display that shows a point
 * evaluation as a proof. Each of those is a property of a round trip, so each
 * of them is a round trip here.
 *
 * The model is deliberately tiny and parsed from TEXT rather than built with
 * the factory: the whole claim is that what this writes comes back out of the
 * notation, and a model that never went through the parser could not fail that
 * way.
 */
const SUBJECT = `package P {
    part def Vehicle {
        attribute mass : Real = 1500.0;
    }
    part vehicle : Vehicle;
    requirement <R1> massLimit {
        doc /* The vehicle mass shall not exceed 2000 kg. */
        subject vehicle : Vehicle;
        require constraint { vehicle.mass <= 2000.0 }
    }
    satisfy massLimit by vehicle;
}
`;

/** Parse without the standard library — none of this needs it, and it costs a second. */
async function parse(text: string): Promise<Model> {
  const { model, report } = await loadModelText(text, { fileName: 'evidence.sysml', library: 'none' });
  expect(
    report.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message),
    'the fixture text must parse',
  ).toEqual([]);
  return model!;
}

/** The reader's own roots as text — what `evidence-attach --out` writes. */
function textOf(model: Model): string {
  return model
    .rootIds()
    .filter((id) => model.get(id)?.attrs.isLibrary !== true)
    .map((id) => serializeElement(model, id, 0))
    .join('\n\n');
}

/** The one requirement of {@link SUBJECT}. */
function requirementId(model: Model): string {
  const el = model.all().find((e) => e.declaredName === 'massLimit');
  expect(el, 'the fixture declares `massLimit`').toBeDefined();
  return el!.id;
}

/** A record over this model, as `verify --engine literal --record` would write it. */
async function literalRecords(model: Model): Promise<EvidenceRecord[]> {
  const r = await verifyModel(model, { engine: 'literal' });
  expect(r.records.length, 'the fixture states one obligation').toBe(1);
  expect(r.records[0].claim, 'the literal engine can only ever say this').toBe('holds-at-values');
  return r.records;
}

/** The same record with one field forced — for the verdict-movement cases. */
function withVerdict(
  record: EvidenceRecord,
  verdict: EvidenceRecord['verdict'],
  claim: EvidenceRecord['claim'],
): EvidenceRecord {
  return { ...record, verdict, claim };
}

describe('attachEvidence — what goes into the file comes back out of it', () => {
  it('round-trips through the notation: attach → serialize → parse → the same records', async () => {
    const model = await parse(SUBJECT);
    const records = await literalRecords(model);
    const report = attachEvidence(model, records);
    expect(report.attached).toBe(1);
    expect(report.elements).toEqual(['P::massLimit']);

    const inMemory = evidenceOf(model, requirementId(model));
    expect(inMemory, 'the record must be readable back off the model it was written to').toEqual(
      records,
    );

    // THE ROUND TRIP THAT MATTERS. A record is a nested object with quotes and
    // backslashes in it, written into a quoted string literal in a `.sysml`
    // file. If any of that escaping were lossy the record would come back
    // subtly different — and the difference would be invisible until somebody
    // tried to re-check it.
    const text = textOf(model);
    const reparsed = await parse(text);
    expect(evidenceOf(reparsed, requirementId(reparsed))).toEqual(records);

    // IDEMPOTENT FROM THE SECOND SAVE, which is the standard this plan holds
    // every round trip to (§2.1): the first save may canonicalise the author's
    // layout, and after that the bytes must stop moving.
    expect(textOf(reparsed)).toBe(text);
  }, 60_000);

  it('writes the verdict facet from the claim — a point evaluation never writes `pass`', async () => {
    const model = await parse(SUBJECT);
    attachEvidence(model, await literalRecords(model));
    expect(getRequirementAttr(model, requirementId(model), 'verdict')).toBe('inconclusive');
    // Not `pass`, and not a value the caller could have chosen: the facet is
    // derived inside `recordEvidence` from the claim, and `holds-at-values` is
    // not `proved`.
    const text = textOf(model);
    expect(text).toContain('attribute verdict = "inconclusive"');
    expect(text).not.toContain('attribute verdict = "pass"');
  }, 60_000);

  it('appends a second record, never overwrites, and reports a fail replaced by a pass', async () => {
    const model = await parse(SUBJECT);
    const [base] = await literalRecords(model);
    const failed = withVerdict(base, 'fail', 'refuted');
    attachEvidence(model, [failed]);

    // Re-attaching the SAME record says nothing new, so it writes nothing: the
    // command has to be safe to run twice over one file.
    const again = attachEvidence(model, [failed]);
    expect(again).toMatchObject({ attached: 0, unchanged: 1 });
    expect(evidenceOf(model, requirementId(model))).toHaveLength(1);

    // A DIFFERENT record appends. The refutation stays in the file — evidence
    // accumulates, and a history that deleted its own inconvenient half would
    // be worth nothing.
    const passed = withVerdict(base, 'pass', 'proved');
    const second = attachEvidence(model, [passed]);
    expect(second.attached).toBe(1);
    const both = evidenceOf(model, requirementId(model));
    expect(both.map((r) => r.verdict), 'the fail must still be in the file').toEqual([
      'fail',
      'pass',
    ]);

    // AND THE MOVE IS REPORTED, in the direction the plan names by hand.
    expect(second.changes).toEqual([
      {
        element: 'P::massLimit',
        clause: base.obligation.clause,
        from: 'fail',
        to: 'pass',
        fromClaim: 'refuted',
        toClaim: 'proved',
        launders: true,
      },
    ]);
    // The facet follows the LAST record, so the file agrees with its own most
    // recent claim rather than with whichever obligation came first.
    expect(getRequirementAttr(model, requirementId(model), 'verdict')).toBe('pass');
  }, 60_000);

  it('refuses a library element, because a carrier written there is never saved', async () => {
    const { model } = await loadModelText(SUBJECT, { fileName: 'e.sysml', library: 'full' });
    const lib = model!.all().find((el) => el.attrs.isLibrary === true && el.declaredName === 'MassValue');
    expect(lib, 'the bundled library declares MassValue').toBeDefined();
    const [base] = await literalRecords(model!);
    const aimedAtLibrary: EvidenceRecord = {
      ...base,
      obligation: { ...base.obligation, requirement: model!.qualifiedName(lib!.id) },
    };
    expect(() => attachEvidence(model!, [aimedAtLibrary])).toThrow(/standard-library element/);
  }, 120_000);

  it('refuses a faulted declaration with the sentence the facet editors show', async () => {
    // A requirement whose own declaration could not be parsed keeps its source
    // as residue and is re-emitted verbatim on save, subtree included — so a
    // carrier written under it reads back perfectly in memory and is gone from
    // the next file.
    // The same shape `test/unit/ui.properties-facets.test.ts` uses: a stray word
    // between two declarations, which the recovery keeps as residue on the
    // declaration that follows it.
    const broken = `package P {
    part vehicle;
    wibble
    requirement <R1> massLimit { subject vehicle; }
}
`;
    const { model } = await loadModelText(broken, { fileName: 'broken.sysml', library: 'none' });
    const req = model!.all().find((e) => e.declaredName === 'massLimit');
    expect(req, 'the recovery keeps the requirement').toBeDefined();
    expect(
      typeof req!.attrs.unparsedText,
      'the requirement must be the one carrying the residue, or this case tests nothing',
    ).toBe('string');
    const template = recordEvidence({
      rows: [
        {
          obligation: {
            requirement: model!.qualifiedName(req!.id),
            shortId: 'R1',
            clause: 'P::massLimit::«ConstraintUsage»',
            obligationDigest: `sha256:${'0'.repeat(64)}`,
            expression: 'vehicle.mass <= 2000.0',
          },
          claim: 'holds-at-values',
          engine: 'literal',
          bound: { kind: 'model-values', detail: 'the model’s own values' },
          detail: 'holds at the model’s values',
        },
      ],
      modelVersion: modelVersionOf(model!),
      producedBy: 'test',
      flags: {},
    });
    expect(() => attachEvidence(model!, template)).toThrow(FAULTED_DECLARATION_REFUSAL);
  }, 60_000);

  it('skips a record about a model-level relation rather than attaching it somewhere plausible', async () => {
    const model = await parse(SUBJECT);
    const [base] = await literalRecords(model);
    const report = attachEvidence(model, [
      { ...base, obligation: { ...base.obligation, requirement: null } },
    ]);
    expect(report.attached).toBe(0);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0].reason).toMatch(/no requirement to annotate/);
  }, 60_000);
});

/* ─────────── a requirement with MORE THAN ONE obligation (the worst wins) ──── */

/**
 * WHY THIS BLOCK EXISTS. Every case above states one obligation, and under one
 * obligation "the last record" and "the worst record" are the same record — so
 * the whole family of order-dependent defects is invisible to them. A
 * requirement may state several clauses, one run produces one record for each,
 * and the file holds ONE verdict facet: which of them it takes is the question,
 * and taking the last one in file order means swapping two lines of source
 * turns a `fail` into a `pass` over identical evidence.
 */
const TWO_CLAUSES = `package Q {
    part def Vehicle {
        attribute mass : Real = 1500.0;
        attribute topSpeed : Real = 260.0;
    }
    part vehicle : Vehicle;
    requirement <R2> massAndSpeed {
        subject vehicle : Vehicle;
        require constraint speedOk { vehicle.topSpeed <= 200.0 }
        require constraint massOk { vehicle.mass <= 2000.0 }
    }
}
`;

/** The same requirement with the two clauses written the other way round. */
const TWO_CLAUSES_SWAPPED = TWO_CLAUSES.replace(
  /( *require constraint speedOk \{[^\n]*\n)( *require constraint massOk \{[^\n]*\n)/,
  '$2$1',
);

/** Both records over a two-clause model: one refuted, one holding at values. */
async function twoClauseRecords(model: Model): Promise<EvidenceRecord[]> {
  const r = await verifyModel(model, { engine: 'literal' });
  expect(r.records.map((x) => x.claim).sort(), 'one clause is refuted and one holds').toEqual([
    'holds-at-values',
    'refuted',
  ]);
  return r.records;
}

/** The `massAndSpeed` requirement of {@link TWO_CLAUSES}. */
function twoClauseRequirement(model: Model): string {
  const el = model.all().find((e) => e.declaredName === 'massAndSpeed');
  expect(el, 'the fixture declares `massAndSpeed`').toBeDefined();
  return el!.id;
}

describe('a requirement with several obligations carries the WORST of them', () => {
  it('a refuted clause is not overwritten by a discharged one written after it', async () => {
    const model = await parse(TWO_CLAUSES);
    const records = await twoClauseRecords(model);
    const report = attachEvidence(model, records);
    expect(report.attached).toBe(2);
    // ONE facet, and it is the one that is not discharged. `fail` outranks
    // `inconclusive` outranks `pass`, because a requirement is discharged only
    // when every obligation under it is.
    expect(report.verdicts).toEqual([
      { element: 'Q::massAndSpeed', verdict: 'fail', claim: 'refuted' },
    ]);
    expect(getRequirementAttr(model, twoClauseRequirement(model), 'verdict')).toBe('fail');
  }, 60_000);

  it('gives the same verdict whichever order the clauses are written in', async () => {
    // THE DEFECT THIS PINS. A facet taken from the last record in file order
    // made the verdict a function of the source layout: the same evidence over
    // the same design wrote `fail` one way round and `inconclusive` the other.
    const swapped = await parse(TWO_CLAUSES_SWAPPED);
    expect(TWO_CLAUSES_SWAPPED, 'the swap must actually have moved a line').not.toBe(TWO_CLAUSES);
    attachEvidence(swapped, await twoClauseRecords(swapped));
    expect(getRequirementAttr(swapped, twoClauseRequirement(swapped), 'verdict')).toBe('fail');
  }, 60_000);

  it('reports the row as `current` under the weakest live claim, never the last one', async () => {
    const model = await parse(TWO_CLAUSES);
    attachEvidence(model, await twoClauseRecords(model));
    const row = evidenceStatus(model).rows.find((r) => r.qualifiedName === 'Q::massAndSpeed');
    expect(row?.status).toBe('current');
    expect(row?.claim, 'the refutation was hidden behind the clause written after it').toBe(
      'refuted',
    );
    expect(row?.verdict).toBe('fail');
    expect(row?.detail).toContain('the weakest of 2 obligations');
  }, 60_000);

  it('goes stale when ANY live obligation is stale, not only the last one', async () => {
    const model = await parse(TWO_CLAUSES);
    const [first, ...rest] = await twoClauseRecords(model);
    // The FIRST record names a model nobody has; the second names this one.
    attachEvidence(model, [
      { ...first, modelVersion: { ...first.modelVersion, graph: `sha256:${'0'.repeat(64)}` } },
      ...rest,
    ]);
    const row = evidenceStatus(model).rows.find((r) => r.qualifiedName === 'Q::massAndSpeed');
    expect(row?.status, 'a stale obligation was hidden behind a current one').toBe('stale');
    expect(row?.recordedGraph, 'the digest a reader has to act on is the stale one').toBe(
      `sha256:${'0'.repeat(64)}`,
    );
    expect(row?.detail).toContain(`stale — recorded at sha256:${'0'.repeat(64)}`);
    // And the ordinary checker says so too, which is what the next person to
    // open the file runs.
    expect(
      validate(model)
        .filter((d) => d.ruleId === 'stale-evidence')
        .map((d) => d.message),
    ).toHaveLength(1);
  }, 60_000);

  it('does not report a change between two DIFFERENT obligations that share a clause name', async () => {
    // Two anonymous `require constraint { … }` clauses of one requirement both
    // have the qualified name `R::«ConstraintUsage»`. Keying the prior-record
    // lookup on the clause alone fused them and printed "a refutation is being
    // replaced by a pass" between two claims that were never about one thing.
    const anonymous = TWO_CLAUSES.replace(/constraint (speedOk|massOk) /g, 'constraint ');
    const model = await parse(anonymous);
    const records = await twoClauseRecords(model);
    expect(
      new Set(records.map((r) => r.obligation.clause)).size,
      'this case tests nothing unless the two clauses share a name',
    ).toBe(1);
    expect(new Set(records.map((r) => r.obligation.obligationDigest)).size).toBe(2);
    const report = attachEvidence(model, records);
    expect(report.attached).toBe(2);
    expect(report.changes, 'a change was invented between two unrelated obligations').toEqual([]);
  }, 60_000);

  it('does report a change when the SAME obligation is re-recorded with another verdict', async () => {
    const model = await parse(TWO_CLAUSES);
    const records = await twoClauseRecords(model);
    const refuted = records.find((r) => r.claim === 'refuted')!;
    attachEvidence(model, [refuted]);
    const report = attachEvidence(model, [{ ...refuted, claim: 'proved', verdict: 'pass' }]);
    expect(report.changes).toEqual([
      {
        element: 'Q::massAndSpeed',
        clause: refuted.obligation.clause,
        from: 'fail',
        to: 'pass',
        fromClaim: 'refuted',
        toClaim: 'proved',
        launders: true,
      },
    ]);
  }, 60_000);
});

describe('attachEvidence derives every verdict it writes, and writes nothing on a refusal', () => {
  it('writes `inconclusive` for a record that SAYS `pass` over a claim that is not `proved`', async () => {
    // A `--from` file is JSON somebody can edit, and `verdict` and `claim` are
    // two independent enumerations in the schema — so a record can be valid
    // against it and still be a laundered claim. Copying the record's own
    // `verdict` through wrote `attribute verdict = "pass"` over a point
    // evaluation, which is the one thing this lane exists to make impossible.
    const model = await parse(SUBJECT);
    const [base] = await literalRecords(model);
    const laundered: EvidenceRecord = { ...base, verdict: 'pass' };
    const report = attachEvidence(model, [laundered]);
    expect(report.verdicts).toEqual([
      { element: 'P::massLimit', verdict: 'inconclusive', claim: 'holds-at-values' },
    ]);
    expect(getRequirementAttr(model, requirementId(model), 'verdict')).toBe('inconclusive');
    // And the stored record is corrected too, so the carrier cannot disagree
    // with its own claim once it is in the file.
    expect(evidenceOf(model, requirementId(model))[0].verdict).toBe('inconclusive');
    expect(textOf(model), 'a point evaluation wrote a pass').not.toContain(
      'attribute verdict = "pass"',
    );
  }, 60_000);

  it('re-attaching the same records repairs a facet that drifted — the remedy the hint names', async () => {
    // `verification/verdict-overstates-evidence` tells the reader to re-attach.
    // The identical-record short circuit used to skip the facet pass with it,
    // so the command reported success and the error stood.
    const model = await parse(SUBJECT);
    const records = await literalRecords(model);
    attachEvidence(model, records);
    setRequirementAttr(model, requirementId(model), 'verdict', 'pass');
    expect(evidenceStatus(model).overstated).toBe(1);

    const repair = attachEvidence(model, records);
    expect(repair).toMatchObject({ attached: 0, unchanged: 1 });
    expect(repair.verdicts, 'the facet pass skipped an element that gained no carrier').toEqual([
      { element: 'P::massLimit', verdict: 'inconclusive', claim: 'holds-at-values' },
    ]);
    expect(getRequirementAttr(model, requirementId(model), 'verdict')).toBe('inconclusive');
    expect(evidenceStatus(model).overstated).toBe(0);
  }, 60_000);

  it('writes NOTHING when a later record is refused — half an attach is worse than none', async () => {
    // The refusals used to be raised from inside the write loop, so a valid
    // record ahead of a refused one had already been written when the throw
    // arrived: carriers in the model, no facets, and no report saying which.
    const { model } = await loadModelText(SUBJECT, { fileName: 'e.sysml', library: 'full' });
    const lib = model!
      .all()
      .find((el) => el.attrs.isLibrary === true && el.declaredName === 'MassValue');
    expect(lib, 'the bundled library declares MassValue').toBeDefined();
    const [base] = await literalRecords(model!);
    expect(() =>
      attachEvidence(model!, [
        base,
        { ...base, obligation: { ...base.obligation, requirement: model!.qualifiedName(lib!.id) } },
      ]),
    ).toThrow(/standard-library element/);
    expect(
      evidenceHolders(model!),
      'the record ahead of the refused one was written and left behind',
    ).toEqual([]);
    expect(getRequirementAttr(model!, requirementId(model!), 'verdict')).toBeUndefined();
  }, 120_000);
});

describe('detachEvidence under a scope leaves everything outside it alone', () => {
  it('clears one requirement’s evidence and keeps the other’s', async () => {
    const two = `package S {
    part def Vehicle {
        attribute mass : Real = 1500.0;
    }
    part vehicle : Vehicle;
    requirement <A1> a {
        subject vehicle : Vehicle;
        require constraint { vehicle.mass <= 2000.0 }
    }
    requirement <A2> b {
        subject vehicle : Vehicle;
        require constraint { vehicle.mass <= 3000.0 }
    }
}
`;
    const model = await parse(two);
    const { records } = await verifyModel(model, { engine: 'literal' });
    expect(records).toHaveLength(2);
    attachEvidence(model, records);
    const a = model.all().find((e) => e.declaredName === 'a')!;
    const b = model.all().find((e) => e.declaredName === 'b')!;
    expect(evidenceOf(model, a.id)).toHaveLength(1);
    expect(evidenceOf(model, b.id)).toHaveLength(1);

    const report = detachEvidence(model, a.id);
    expect(report).toMatchObject({ removed: 1, elements: ['S::a'], verdictsCleared: ['S::a'] });
    expect(evidenceOf(model, a.id)).toEqual([]);
    expect(getRequirementAttr(model, a.id, 'verdict')).toBeUndefined();
    // The other requirement is outside the scope and keeps both halves.
    expect(evidenceOf(model, b.id)).toHaveLength(1);
    expect(getRequirementAttr(model, b.id, 'verdict')).toBe('inconclusive');
  }, 60_000);
});

describe('the model digest ignores what a verification run wrote', () => {
  it('does not move when evidence is attached — or no record could ever be current', async () => {
    const model = await parse(SUBJECT);
    const before = modelVersionOf(model).graph;
    const beforeCount = canonicalElements(model).length;
    attachEvidence(model, await literalRecords(model));
    expect(
      modelVersionOf(model).graph,
      'attaching a record moved the digest the record names — every record would be born stale',
    ).toBe(before);
    // And the elements really WERE added: the digest is unchanged because they
    // are excluded, not because nothing happened.
    expect(model.all().filter((el) => isUserElement(model, el)).length).toBeGreaterThan(beforeCount);
    expect(canonicalElements(model).length).toBe(beforeCount);
  }, 60_000);

  it('names exactly what it leaves out, which no assertion over the hash can see', async () => {
    const model = await parse(SUBJECT);
    attachEvidence(model, await literalRecords(model));
    const excluded = model
      .all()
      .filter((el) => isUserElement(model, el) && isEvidenceArtefact(model, el));
    // The carrier, its six cells, the verdict cell, and the facet carrier that
    // exists only to hold it. Anything else in this list would mean the digest
    // had stopped noticing part of the design.
    const kinds = excluded.map((el) => `${el.eClass}:${el.declaredName ?? '«anon»'}`).sort();
    expect(kinds).toEqual([
      'AttributeUsage:claim',
      'AttributeUsage:engine',
      'AttributeUsage:modelGraph',
      'AttributeUsage:record',
      'AttributeUsage:tool',
      'AttributeUsage:verdict',
      'AttributeUsage:verdict',
      'MetadataUsage:RequirementMetadata',
      'MetadataUsage:«anon»',
    ]);
    expect(excluded.filter((el) => isEvidenceCarrier(el))).toHaveLength(1);
  }, 60_000);

  it('still moves when the author edits the design, evidence attached or not', async () => {
    const model = await parse(SUBJECT);
    attachEvidence(model, await literalRecords(model));
    const attached = modelVersionOf(model).graph;
    const edited = await parse(SUBJECT.replace('1500.0', '1600.0'));
    attachEvidence(edited, await literalRecords(edited));
    expect(modelVersionOf(edited).graph, 'a literal moved and the digest did not').not.toBe(attached);
  }, 60_000);

  it('still moves when the author edits a facet that is not the verdict', async () => {
    // The exclusion is "what a verification run wrote", not "metadata": a
    // status, an owner or a rationale is the author's and stays in the hash.
    const model = await parse(SUBJECT);
    const before = modelVersionOf(model).graph;
    const { setRequirementAttr } = await import('@semantics/index');
    setRequirementAttr(model, requirementId(model), 'status', 'done');
    expect(modelVersionOf(model).graph).not.toBe(before);
  }, 60_000);
});

describe('evidenceStatus — current, stale, unrecorded, overstated', () => {
  it('reports a fresh attach as current, and names the tool that produced it', async () => {
    const model = await parse(SUBJECT);
    attachEvidence(model, await literalRecords(model));
    const r = evidenceStatus(model);
    expect({ current: r.current, stale: r.stale, unrecorded: r.unrecorded, overstated: r.overstated }).toEqual({
      current: 1,
      stale: 0,
      unrecorded: 0,
      overstated: 0,
    });
    expect(r.rows[0].claim, 'the claim is carried verbatim, never upgraded').toBe('holds-at-values');
    expect(r.rows[0].detail).toContain('sysprose');
    expect(r.rows[0].slice, 'a current row has nothing to re-read').toEqual([]);
  }, 60_000);

  it('goes stale on an edit and names the slice a reader has to re-read', async () => {
    const model = await parse(SUBJECT);
    attachEvidence(model, await literalRecords(model));
    const text = textOf(model);
    const edited = await parse(text.replace('1500.0', '1600.0'));
    const r = evidenceStatus(edited);
    expect(r.stale).toBe(1);
    const row = r.rows[0];
    expect(row.status).toBe('stale');
    expect(row.slice.length, 'a stale row names the requirement’s slice').toBeGreaterThan(0);
    // And it says what it CANNOT say. The digest is over the whole model, so
    // naming the changed element is beyond this report and claiming otherwise
    // would be a fabricated attribution.
    expect(row.detail).toContain('cannot say which of them moved');
  }, 60_000);

  it('calls a verdict with nothing behind it unrecorded, and does not call it a defect', async () => {
    const model = await parse(SUBJECT);
    const { setRequirementAttr } = await import('@semantics/index');
    setRequirementAttr(model, requirementId(model), 'verdict', 'pass');
    const r = evidenceStatus(model);
    expect(r.unrecorded).toBe(1);
    expect(r.rows[0].code).toBe(CLAIMED_WITHOUT_EVIDENCE_CODE);
    expect(r.rows[0].claim, 'there is no claim, because there is no record').toBeUndefined();
  }, 60_000);

  it('refuses to let a `pass` facet stand over a claim that is not `proved`', async () => {
    const model = await parse(SUBJECT);
    attachEvidence(model, await literalRecords(model));
    const { setRequirementAttr } = await import('@semantics/index');
    // The one state `attachEvidence` cannot produce, reached the way a file
    // reaches it: by hand.
    setRequirementAttr(model, requirementId(model), 'verdict', 'pass');
    const r = evidenceStatus(model);
    expect(r.overstated).toBe(1);
    expect(r.rows[0].code).toBe(VERDICT_OVERSTATES_EVIDENCE_CODE);
    expect(r.rows[0].detail).toContain('`pass` is written for `proved` alone');
    // The record beside it is still current — the finding is about the FACET,
    // and conflating the two would report an edit that never happened.
    expect(r.rows[0].status).toBe('current');
  }, 60_000);

  it('does not call an unreadable carrier a claim when nothing claimed anything', async () => {
    // `verification/claimed-without-evidence` reads "A requirement carries a
    // `verdict` facet and no evidence record this tool can read". A carrier
    // nothing can parse, on an element that states no verdict, satisfies
    // NEITHER half — it is not a requirement and there is no facet — and
    // reporting the code over it inflated the `unrecorded` count and printed
    // `the file states verdict = ""`, which is not a sentence about anything.
    const model = await parse(`package Q {
    metadata def Evidence;
    part def Rig;
    part rig : Rig {
        @Evidence { attribute witnessMass = 1.0; }
    }
}
`);
    const r = evidenceStatus(model);
    expect(r.unrecorded, 'a carrier nobody claimed anything with inflated the count').toBe(0);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].qualifiedName).toBe('Q::rig');
    expect(r.rows[0].status).toBe('none');
    expect(r.rows[0].code, 'a code whose `when` sentence is false of the row').toBeUndefined();
    expect(r.rows[0].unreadable).toBe(1);
    expect(r.rows[0].detail).toContain('could not be read back');
    expect(r.rows[0].detail, 'the row asserted a verdict the file does not state').not.toContain(
      'verdict = ""',
    );
  }, 60_000);

  it('says nothing at all about a model that carries neither', async () => {
    const model = await parse(SUBJECT);
    expect(evidenceStatus(model).rows).toEqual([]);
    expect(evidenceHolders(model)).toEqual([]);
  }, 60_000);
});

describe('detachEvidence — the facet goes with the evidence', () => {
  it('removes every carrier and the verdict it wrote, leaving the design untouched', async () => {
    const model = await parse(SUBJECT);
    const before = textOf(model);
    attachEvidence(model, await literalRecords(model));
    expect(textOf(model)).not.toBe(before);

    const r = detachEvidence(model);
    expect(r).toMatchObject({ removed: 1, elements: ['P::massLimit'], verdictsCleared: ['P::massLimit'] });
    expect(evidenceOf(model, requirementId(model))).toEqual([]);
    expect(getRequirementAttr(model, requirementId(model), 'verdict')).toBeUndefined();
    // A detach that left the facet behind would MANUFACTURE
    // `verification/claimed-without-evidence` — the very defect this lane
    // reports — so the file must come back exactly as it went in.
    expect(textOf(model)).toBe(before);
    expect(evidenceStatus(model).rows).toEqual([]);
  }, 60_000);
});
