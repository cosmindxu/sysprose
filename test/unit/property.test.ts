/**
 * `property-draft` / `property-check` — the authoring gates (plan §3.3).
 *
 * The thing under test is a REFUSAL SURFACE, so nearly every case here asserts
 * that something plausible was turned away and why. That is the point of the
 * feature: an agent writing a clause from prose will write one that parses and
 * means the wrong thing far more often than one that does not parse at all, and
 * the only defence a tool can offer is to refuse everything it cannot decide
 * and to say, every single time, that it did not check the meaning.
 *
 * The one assertion that is easy to write and would be worthless: "an accepted
 * clause is correct". Nothing here asserts it, and {@link MEANING_NOTICE} is
 * asserted on every report instead.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadModelText } from '@text/load';
import type { Model } from '@core/index';
import type { TextRange } from '../../src/validation/types';
import {
  MEANING_NOTICE,
  PROPERTY_CODES,
  PropertyRefError,
  propertyCheck,
  propertyDraft,
} from '../../src/api/property';
import { promptsFor } from '../../src/api/analytics';
import { contractsOf } from '../../src/semantics/contracts';
import {
  BenchUsageError,
  SUITES,
  parseArgs,
  propertyCases,
} from '../../scripts/agent-repair-bench';

const root = (p: string) => resolve(process.cwd(), p);
const read = (p: string) => readFileSync(root(p), 'utf8');

/** One load of the shipped example, shared by every case that reads it. */
async function uav(): Promise<{ model: Model; ranges: Map<string, TextRange>; text: string }> {
  const text = read('examples/uav-isr.sysml');
  const loaded = await loadModelText(text, { fileName: 'examples/uav-isr.sysml' });
  expect(loaded.model, 'examples/uav-isr.sysml no longer loads').toBeDefined();
  return { model: loaded.model!, ranges: loaded.ranges, text };
}

/** A model built from a string, with the spans and the text that produced it. */
async function fromText(
  text: string,
): Promise<{ model: Model; ranges: Map<string, TextRange>; text: string }> {
  const loaded = await loadModelText(text, { fileName: 'insertion.sysml' });
  expect(loaded.model, 'the inline model no longer loads').toBeDefined();
  return { model: loaded.model!, ranges: loaded.ranges, text };
}

/** The id of the contract with this declared name, however it is declared. */
function contractId(model: Model, name: string): string {
  const c = contractsOf(model).find((x) => x.declaredName === name);
  expect(c, `no contract called ${name}`).toBeDefined();
  return c!.id;
}

/** The id of a user element by declared name. */
function idOf(model: Model, name: string): string {
  const el = model.all().find((e) => e.declaredName === name);
  expect(el, `examples/uav-isr.sysml has no element called ${name}`).toBeDefined();
  return el!.id;
}

describe('propertyDraft — the encodable skeleton, the dictionary and the guidance', () => {
  it('emits the three mandatory FRETish fields and marks the other three unencodable', async () => {
    const { model } = await uav();
    const draft = propertyDraft(model, idOf(model, 'EnduranceRequirement'));

    expect(draft.fields.map((f) => f.field)).toEqual([
      'component',
      'shall',
      'response',
      'scope',
      'condition',
      'timing',
    ]);
    const mandatory = draft.fields.filter((f) => f.mandatory).map((f) => f.field);
    expect(mandatory).toEqual(['component', 'shall', 'response']);
    for (const f of draft.fields.filter((f) => f.mandatory)) {
      expect(f.encodable, `${f.field} is one of the three this tool encodes`).toBe(true);
    }
    for (const f of draft.fields.filter((f) => !f.mandatory)) {
      expect(f.encodable, `${f.field} is temporal`).toBe(false);
      expect(f.note).toContain('temporal');
      expect(f.note).toContain('export-only');
    }
    // The component is the subject the file names, not a guess.
    expect(draft.fields[0].text).toBe('uav');
    expect(draft.subject?.name).toBe('uav');
  }, 60_000);

  it('gives every legal name with its type, unit, dimension claim and value', async () => {
    const { model } = await uav();
    const draft = propertyDraft(model, idOf(model, 'EnduranceRequirement'));
    const byName = new Map(draft.dictionary.map((e) => [e.name, e]));

    const mtow = byName.get('uav.mtow');
    expect(mtow).toBeDefined();
    expect(mtow!.type).toBe('ISQ::MassValue');
    expect(mtow!.unit).toBe('kg');
    expect(mtow!.dimension).toBe('M');
    expect(mtow!.claim).toBe('literal');
    expect(mtow!.value).toBe('18.5');
    expect(mtow!.numeric).toBe(true);

    // A derived feature is in the dictionary and says so: no unit of its own,
    // a dimension from its declared kind, and a value that is an expression.
    const endurance = byName.get('uav.endurance');
    expect(endurance!.unit).toBeNull();
    expect(endurance!.dimension).toBe('T');
    expect(endurance!.claim).toBe('consistent');
    expect(endurance!.value).toBe('battery.capacity * usableEnergyFraction / cruisePower');

    // THE BARE-NAME ALIAS IS NOT A LEGAL NAME HERE. `mass` resolves in the
    // model — first occurrence wins — and this model has two of them, so a
    // dictionary that offered it would be offering a silent coin toss.
    expect(byName.has('mass'), 'the dictionary offers no bare-name alias').toBe(false);
    expect(byName.has('endurance')).toBe(false);
    expect(byName.has('uav.battery.mass')).toBe(true);
    expect(byName.has('uav.gimbal.mass')).toBe(true);
  }, 60_000);

  it('every example clause it generates passes its own gates', async () => {
    const { model } = await uav();
    const id = idOf(model, 'EnduranceRequirement');
    const draft = propertyDraft(model, id);
    expect(draft.examples.length).toBeGreaterThan(0);
    for (const example of draft.examples) {
      const report = await propertyCheck(model, id, example);
      expect(
        report.refusedAt,
        `the drafted example \`${example}\` is refused at gate ${report.refusedAt}: ${report.detail}`,
      ).toBeNull();
    }
  }, 60_000);

  it('carries the authoring guidance and the notice, and refuses a REF that is not a requirement', async () => {
    const { model } = await uav();
    const draft = propertyDraft(model, idOf(model, 'EnduranceRequirement'));
    expect(draft.notice).toBe(MEANING_NOTICE);
    expect(draft.statement).toContain('at least 45 minutes');

    expect(() => propertyDraft(model, idOf(model, 'AirVehicle'))).toThrow(PropertyRefError);
  }, 60_000);
});

describe('propertyCheck — gate 0, then the four judging gates', () => {
  it('refuses a temporal field at gate 0 rather than accepting it with a gap', async () => {
    const { model } = await uav();
    const id = idOf(model, 'EnduranceRequirement');

    const after = await propertyCheck(model, id, 'scope = after; uav.endurance >= 45.0 [min]');
    expect(after.refusedAt).toBe(0);
    expect(after.code).toBe(PROPERTY_CODES.temporal);
    expect(after.code).toBe('verification/temporal-field-unencodable');
    expect(after.detail).toContain('scope');
    expect(after.detail).toContain('after');
    expect(after.outcome).toBe('refused');
    // Named, not swallowed: nothing downstream can decide it, so it is not
    // "accepted with a gap".
    expect(after.gates.find((g) => g.gate === 1)?.status).toBe('not-run');

    const timing = await propertyCheck(model, id, 'timing = eventually; uav.mtow <= 25.0 [kg]');
    expect(timing.refusedAt).toBe(0);
    expect(timing.detail).toContain('timing');

    // `scope = global` and `timing = always` are the readings a static engine
    // has, so they pass gate 0 rather than being refused for being present.
    const global = await propertyCheck(
      model,
      id,
      'scope = global; timing = always; uav.mtow <= 25.0 [kg]',
    );
    expect(global.refusedAt).toBeNull();
  }, 60_000);

  it('refuses a name outside the dictionary and suggests the one that is in it', async () => {
    const { model } = await uav();
    const report = await propertyCheck(
      model,
      idOf(model, 'EnduranceRequirement'),
      'endurance >= 45 [min]',
    );
    expect(report.refusedAt).toBe(2);
    expect(report.code).toBe('verification/unresolved-name-in-property');
    expect(report.detail).toContain('endurance');
    expect(report.expected).toContain('uav.endurance');
  }, 60_000);

  it('refuses a dimension clash at gate 3', async () => {
    const { model } = await uav();
    const report = await propertyCheck(
      model,
      idOf(model, 'EnduranceRequirement'),
      'uav.endurance >= 45.0 [kg]',
    );
    expect(report.refusedAt).toBe(3);
    expect(report.code).toBe('verification/dimension-clash-in-property');
    expect(report.detail).toContain('dimension');
  }, 60_000);

  it('refuses a clause that does not parse at gate 1', async () => {
    const { model } = await uav();
    const report = await propertyCheck(model, idOf(model, 'EnduranceRequirement'), 'uav.mtow <= ');
    expect(report.refusedAt).toBe(1);
    expect(report.code).toBe('verification/unsupported-expression');
  }, 60_000);

  it('calls a clause trivial with z3, and says the gate was not run without it', async () => {
    const { model } = await uav();
    const id = idOf(model, 'EnduranceRequirement');

    const withZ3 = await propertyCheck(model, id, 'uav.mtow <= uav.mtow');
    expect(withZ3.refusedAt, 'z3 is installed, so gate 4 decides').toBe(4);
    expect(withZ3.code).toBe('verification/trivial-property');
    expect(withZ3.outcome).toBe('refused');
    expect(withZ3.detail).toMatch(/valid|unsatisfiable/);

    const previous = process.env.SYSPROSE_NO_Z3;
    process.env.SYSPROSE_NO_Z3 = '1';
    try {
      const without = await propertyCheck(model, id, 'uav.mtow <= uav.mtow');
      expect(without.refusedAt, 'with no solver the gate is UNRUN, not passed').toBeNull();
      expect(without.outcome).toBe('accepted-with-gap');
      expect(without.code).toBe('verification/nontriviality-unchecked');
      expect(without.detail).toContain('z3');
      expect(without.gates.find((g) => g.gate === 4)?.status).toBe('not-run');
    } finally {
      if (previous === undefined) delete process.env.SYSPROSE_NO_Z3;
      else process.env.SYSPROSE_NO_Z3 = previous;
    }
  }, 60_000);

  it('passes a clause the model’s own literals already satisfy — gate 4 is syntactic only', async () => {
    const { model } = await uav();
    // `uav.mtow = 18.5 [kg]` is a literal in the file, so this clause is true
    // of the design as written. Gate 4 asks whether the CLAUSE is trivial on
    // its own, with no axioms asserted, and this one is not: mass is a free
    // symbol there. The limit is recorded in the §6 register and in
    // docs/CONFORMANCE.md, and `verify`'s tautology check is what covers it.
    const report = await propertyCheck(
      model,
      idOf(model, 'MassRequirement'),
      'uav.mtow <= 25.0 [kg]',
    );
    expect(report.refusedAt).toBeNull();
    expect(report.outcome).toBe('accepted');
    expect(report.gates.find((g) => g.gate === 4)?.status).toBe('passed');
    expect(report.limits.join(' ')).toContain('syntactic');
  }, 60_000);

  it('returns the insertion range inside the requirement body for an accepted clause', async () => {
    const { model, ranges } = await uav();
    const id = idOf(model, 'MassRequirement');
    const report = await propertyCheck(model, id, 'uav.mtow >= 1.0 [kg]', { ranges });
    expect(report.refusedAt).toBeNull();
    expect(report.range).not.toBeNull();
    // Zero-width: it is where the clause GOES, not what it replaces.
    expect(report.range!.start).toEqual(report.range!.end);
    // After the last clause the requirement already carries, and inside the
    // body: the requirement's own range ends one line further on.
    const own = ranges.get(id)!;
    expect(report.range!.start.offset).toBeGreaterThan(own.start.offset);
    expect(report.range!.start.offset).toBeLessThan(own.end.offset);
    expect(report.insertion).toBe('require constraint { uav.mtow >= 1.0 [kg] }');

    // With no range table there is no range to give, and the report says so
    // rather than inventing a position.
    const blind = await propertyCheck(model, id, 'uav.mtow >= 1.0 [kg]');
    expect(blind.range).toBeNull();
  }, 60_000);

  /**
   * The same question with the SOURCE TEXT as well, which is a different code
   * path and the one the CLI takes.
   *
   * Spans alone give a position that is exact to the LINE and assume the
   * indentation; spans plus text put the clause at the start of the
   * closing-brace line and copy the body's own indentation. The offset is what
   * separates the two, so it is what is asserted: a mutation anchoring the
   * insertion at the requirement's own `end` instead of the brace's line still
   * reports line 138 and is caught only here.
   */
  it('with the source text as well, the range is the closing-brace line and the indent is the body’s', async () => {
    const { model, ranges, text } = await uav();
    const id = idOf(model, 'MassRequirement');
    const report = await propertyCheck(model, id, 'uav.mtow >= 1.0 [kg]', {
      ranges,
      sourceText: text,
    });
    const own = ranges.get(id)!;
    expect(report.range).not.toBeNull();
    expect(report.range!.start.column).toBe(1);
    // Strictly inside the body: the closing brace itself sits AFTER this offset
    // on the same line, and the requirement's own span ends after that.
    expect(report.range!.start.offset).toBeGreaterThan(own.start.offset);
    expect(report.range!.start.offset).toBeLessThan(own.end.offset);
    expect(text.slice(report.range!.start.offset, own.end.offset)).toContain('}');
    // Copied from the last line of the body, not assumed.
    expect(report.indent).toBe('        ');
    expect(report.rangeNote).toBe('');
  }, 60_000);

  it('back-translates the clause into structured English', async () => {
    const { model } = await uav();
    const endurance = idOf(model, 'EnduranceRequirement');
    const mass = idOf(model, 'MassRequirement');

    const a = await propertyCheck(model, endurance, 'uav.endurance >= 45.0 [min]');
    expect(a.backTranslation).toBe('uav shall satisfy: uav.endurance is at least 45.0 min');

    const b = await propertyCheck(model, mass, 'uav.mtow <= 25.0 [kg]');
    expect(b.backTranslation).toBe('uav shall satisfy: uav.mtow is at most 25.0 kg');

    const c = await propertyCheck(model, mass, 'uav.mtow <= uav.battery.mass + 3.0');
    expect(c.backTranslation).toBe(
      'uav shall satisfy: uav.mtow is at most (uav.battery.mass plus 3)',
    );

    const d = await propertyCheck(
      model,
      mass,
      'uav.mtow > 1.0 [kg] and uav.mtow != 2.0 [kg]',
    );
    expect(d.backTranslation).toBe(
      'uav shall satisfy: uav.mtow is greater than 1.0 kg, and uav.mtow differs from 2.0 kg',
    );

    // Every report ends with the same line, whatever it decided.
    for (const r of [a, b, c, d]) expect(r.notice).toBe(MEANING_NOTICE);
  }, 60_000);

  it('never says the clause means what the prose meant', async () => {
    const { model } = await uav();
    const report = await propertyCheck(
      model,
      idOf(model, 'EnduranceRequirement'),
      'uav.endurance >= 45.0 [min]',
    );
    expect(report.outcome).toBe('accepted');
    expect(report.notice).toBe(MEANING_NOTICE);
    const said = JSON.stringify(report).toLowerCase();
    for (const forbidden of ['correct formalisation', 'means the same', 'faithful']) {
      expect(said, `a property report must never claim "${forbidden}"`).not.toContain(forbidden);
    }
  }, 60_000);
});

/**
 * Where an accepted clause is told to go, in the shapes that are NOT a
 * requirement written over several lines.
 *
 * Every case here applies the tool's own instruction and reloads the result,
 * because that is the only assertion that catches this class of defect: a clause
 * spliced into the enclosing package instead of the requirement body still
 * PARSES, and `npm run check` stays clean, so the misplacement is invisible to
 * everything except a reader of the contract afterwards.
 */
describe('propertyCheck — where the clause goes', () => {
  /** Apply the report's own range and indent, and read the contract back. */
  async function applied(
    source: string,
    name: string,
    range: TextRange,
    indent: string,
    insertion: string,
  ): Promise<string[]> {
    const spliced =
      source.slice(0, range.start.offset) +
      indent +
      insertion +
      (indent.includes('\n') || indent === ' ' ? '' : '\n') +
      source.slice(range.start.offset);
    const { model } = await fromText(spliced);
    const contract = contractsOf(model).find((c) => c.declaredName === name);
    return contract?.guarantees.map((g) => g.expression) ?? [];
  }

  const ONE_LINE = `package P {
    part def AirVehicle { attribute mtow : ISQ::MassValue = 18.5 [kg]; }
    requirement def OneLiner { subject uav : AirVehicle; require constraint { uav.mtow <= 25.0 [kg] } }
}
`;

  it('puts the clause INSIDE a requirement written on one line, not before it', async () => {
    const { model, ranges, text } = await fromText(ONE_LINE);
    const id = contractId(model, 'OneLiner');
    const report = await propertyCheck(model, id, 'uav.mtow >= 1.0 [kg]', {
      ranges,
      sourceText: text,
    });
    expect(report.outcome).toBe('accepted');
    const own = ranges.get(id)!;
    expect(report.range).not.toBeNull();
    // THE assertion: the anchor is inside the element. The unclamped answer is
    // the start of the brace's LINE, which for a one-line requirement is before
    // the requirement itself — in the enclosing package, where the clause
    // parses, binds nothing and raises no diagnostic.
    expect(report.range!.start.offset).toBeGreaterThan(own.start.offset);
    expect(report.range!.start.offset).toBeLessThan(own.end.offset);
    expect(report.indent).toBe(' ');
    expect(report.rangeNote).toContain('one line');

    expect(
      await applied(text, 'OneLiner', report.range!, report.indent, report.insertion!),
    ).toEqual(['uav.mtow <= 25.0 [kg]', 'uav.mtow >= 1.0 [kg]']);
  }, 60_000);

  it('gives no range for a one-line requirement when it was handed no source text', async () => {
    const { model, ranges } = await fromText(ONE_LINE);
    const report = await propertyCheck(model, contractId(model, 'OneLiner'), 'uav.mtow >= 1.0 [kg]', {
      ranges,
    });
    // Spans alone locate the closing-brace LINE, and for this shape that line is
    // the declaration's own. There is no text to find the brace in, so the
    // honest answer is the reason rather than a position outside the body.
    expect(report.range).toBeNull();
    expect(report.rangeNote).toContain('one line');
  }, 60_000);

  it('points inside `objective { … }` for a case, not at the case’s own brace', async () => {
    const source = `package P {
    part def AirVehicle { attribute mtow : ISQ::MassValue = 18.5 [kg]; }
    part uav : AirVehicle;
    verification def MassCase {
        subject uav : AirVehicle;
        objective {
            require constraint { uav.mtow <= 25.0 [kg] }
        }
    }
}
`;
    const { model, ranges, text } = await fromText(source);
    const id = contractId(model, 'MassCase');
    const report = await propertyCheck(model, id, 'uav.mtow >= 1.0 [kg]', {
      ranges,
      sourceText: text,
    });
    expect(report.outcome).toBe('accepted');
    expect(report.range).not.toBeNull();
    // A case's clauses are read out of its objective, so a clause anchored on
    // the CASE's closing brace lands after `objective { … }` — it parses, and
    // the contract does not have it.
    expect(
      await applied(text, 'MassCase', report.range!, report.indent, report.insertion!),
    ).toEqual(['uav.mtow <= 25.0 [kg]', 'uav.mtow >= 1.0 [kg]']);
  }, 60_000);

  it('says a requirement usage has no body, rather than blaming a stale file', async () => {
    const source = `package P {
    part def AirVehicle { attribute mtow : ISQ::MassValue = 18.5 [kg]; }
    requirement def MassReq {
        subject uav : AirVehicle;
        require constraint { uav.mtow <= 25.0 [kg] }
    }
    requirement massReq : MassReq;
}
`;
    const { model, ranges, text } = await fromText(source);
    const report = await propertyCheck(model, contractId(model, 'massReq'), 'uav.mtow >= 1.0 [kg]', {
      ranges,
      sourceText: text,
    });
    expect(report.range).toBeNull();
    expect(report.rangeNote).toContain('no body');
    // The file is not stale — it is the one that was just loaded — so the
    // report must not say it might have been edited.
    expect(report.rangeNote).not.toContain('edited');
  }, 60_000);
});

describe('propertyCheck — the FRETish mini-syntax the draft itself emits', () => {
  it('reads a field written with a colon, so it reaches gate 0 and not gate 1', async () => {
    const { model } = await uav();
    const id = idOf(model, 'MassRequirement');
    const colon = await propertyCheck(model, id, 'scope: after; uav.mtow <= 25.0 [kg]');
    expect(colon.refusedAt, 'the skeleton’s own spelling must reach gate 0').toBe(0);
    expect(colon.code).toBe(PROPERTY_CODES.temporal);
    expect(colon.detail).toContain('scope');
    // And the body is still the relation, not the whole string.
    expect(colon.body).toBe('uav.mtow <= 25.0 [kg]');
  }, 60_000);

  it('reads the draft’s own skeleton fields back when the comment markers come off', async () => {
    const { model } = await uav();
    const id = idOf(model, 'MassRequirement');
    const draft = propertyDraft(model, id);
    // The skeleton as an agent would hand it back: markers off, fields joined by
    // the separator the mini-syntax uses, and the live line replaced by a real
    // relation. Every field must be READ; none may fall through to the body.
    const fields = draft.skeleton
      .split('\n')
      .filter((l) => l.startsWith('// '))
      .map((l) => l.slice(3));
    const report = await propertyCheck(model, id, `${fields.join('; ')}; uav.mtow <= 25.0 [kg]`);
    expect(report.fields.map((f) => f.field)).toEqual([
      'component',
      'shall',
      'response',
      'scope',
      'condition',
      'timing',
    ]);
    // It is refused, and at gate 0 naming a temporal field — the skeleton says
    // in words that those three cannot be encoded, and the gate says the same.
    expect(report.refusedAt).toBe(0);
    expect(report.code).toBe(PROPERTY_CODES.temporal);
  }, 60_000);
});

describe('propertyDraft — what it points the author at', () => {
  it('drafts the response over a quantity the requirement already reads', async () => {
    const { model } = await uav();
    const draft = propertyDraft(model, idOf(model, 'MassRequirement'));
    const response = draft.fields.find((f) => f.field === 'response')!;
    // The requirement's own `require { uav.mtow <= 25.0 [kg] }` names `uav.mtow`,
    // so that is the quantity the skeleton points at. Taking whatever sorted
    // first handed a mass requirement `uav.cruisePower >= <bound> [W]`.
    expect(response.text).toBe('uav.mtow >= <bound> [kg]');
    expect(draft.skeleton).toContain('// response: uav.mtow >= <bound> [kg]');
  }, 60_000);

  it('generates example clauses for a model whose features carry no units', async () => {
    const text = read('examples/vehicle.sysml');
    const loaded = await loadModelText(text, { fileName: 'examples/vehicle.sysml' });
    const model = loaded.model!;
    const id = contractId(model, 'MassRequirement');
    const draft = propertyDraft(model, id);
    // `examples/vehicle.sysml` is plain `Real`/`Integer` throughout. A bare
    // comparison passes all five gates, so an examples block that vanished on
    // this model would be hiding a shape that works.
    expect(draft.examples.length).toBeGreaterThan(0);
    expect(draft.examples.some((e) => !e.includes('['))).toBe(true);
    for (const example of draft.examples) {
      const report = await propertyCheck(model, id, example);
      expect(report.refusedAt, `\`${example}\` refused: ${report.detail}`).toBeNull();
    }
  }, 60_000);
});

/**
 * The bench's own data half, which spends no `claude` call.
 *
 * `--suite verification` had no test of any kind and crashed on its first case:
 * the cases were collected from one load and replayed against a second, and
 * element ids are fresh UUIDs per load. The assertion that catches that is the
 * only one here that matters — every case's id must resolve in the model the
 * case carries.
 */
describe('the verification bench collects cases that resolve', () => {
  it('hands back a model each case’s requirement id is actually in', async () => {
    const cases = await propertyCases();
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      expect(c.model.get(c.requirementId), `${c.name} (${c.file}) is not in its own model`)
        .toBeDefined();
      // And the draft the prompt is built from can be taken over it.
      expect(() => propertyDraft(c.model, c.requirementId)).not.toThrow();
      expect(c.ranges.get(c.requirementId) ?? c.text).toBeDefined();
    }
  }, 120_000);

  it('refuses a suite name it does not have, in one sentence', () => {
    expect(() => parseArgs(['--suite', 'bogus'])).toThrow(BenchUsageError);
    expect(() => parseArgs(['--suite', 'bogus'])).toThrow(/--suite must be one of repair, verification/);
    expect(parseArgs(['--suite', 'verification']).suite).toBe('verification');
    expect(parseArgs([]).suite).toBe('repair');
    expect([...SUITES]).toEqual(['repair', 'verification']);
  });
});

describe('the authoring guidance ships as a #prompt package', () => {
  it('promptsFor collects it through the package', async () => {
    const text = read('examples/contract-authoring-prompts.sysml');
    const { model } = await loadModelText(text, {
      fileName: 'examples/contract-authoring-prompts.sysml',
    });
    expect(model).toBeDefined();
    const req = model!.all().find((e) => e.declaredName === 'PayloadMassRequirement');
    expect(req, 'the example no longer declares PayloadMassRequirement').toBeDefined();

    const report = promptsFor(model!, req!.id);
    expect(report.prompts.length).toBeGreaterThanOrEqual(4);
    const text0 = report.prompts.map((p) => p.text).join('\n');
    expect(text0).toContain('assume');
    expect(text0).toContain('one guarantee');
    expect(text0).toContain('subject');
    expect(text0).toContain('verdict');
    // Reached through the OWNER — the package — rather than written on the
    // requirement, which is the whole shape this example is here to show.
    expect(report.prompts.some((p) => p.via === 'owner')).toBe(true);

    // And the draft hands them to the agent verbatim, beside the dictionary.
    const draft = propertyDraft(model!, req!.id);
    expect(draft.prompts.length).toBe(report.prompts.length);
  }, 60_000);
});
