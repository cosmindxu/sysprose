import { describe, it, expect } from 'vitest';
import { Model, ModelFactory, buildSampleModel } from '@core/index';
import type { ElementRecord, SerializedModel } from '@core/index';
import { validate, isValid, RULES, RULE_IDS, RULES_BY_ID } from '@validation/index';
import { loadStandardLibrary } from '../../src/library/index';
import { modelVersionOf, obligationDigest, proofScopeOf } from '@api/index';
import { obligationsOf } from '@semantics/obligations';
import { loadModelText } from '@text/load';
import { parseModel, serializeElement, serializeModel } from '@text/index';
import {
  NOTE_BODY_TERMINATOR,
  effectiveFeatures,
  effectiveFeaturesWithLibrary,
  generalizationsWithImplicit,
  setStatementKind,
  statementKindOf,
} from '@semantics/index';

/** Run a single rule in isolation and return its diagnostics. */
function runRule(model: Model, ruleId: string) {
  const rule = RULES_BY_ID.get(ruleId);
  if (!rule) throw new Error(`unknown rule ${ruleId}`);
  return rule.run(model);
}

describe('validation registry', () => {
  it('exposes all 52 documented rules with unique ids', () => {
    expect(RULES.length).toBe(52);
    expect(new Set(RULE_IDS).size).toBe(RULES.length);
  });

  it('reports a clean sample model as valid with zero diagnostics', () => {
    const m = buildSampleModel();
    expect(validate(m)).toEqual([]);
    expect(isValid(m)).toBe(true);
  });
});

describe('rule 1 — duplicate-name', () => {
  it('positive: distinct sibling names produce no diagnostic', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    f.partDef('A', p.id);
    f.partDef('B', p.id);
    expect(runRule(m, 'duplicate-name')).toHaveLength(0);
  });

  it('negative: two siblings with the same name are flagged, and a name a refused clause swallowed is none', async () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    f.partDef('Dup', p.id);
    f.partDef('Dup', p.id);
    const diags = runRule(m, 'duplicate-name');
    expect(diags).toHaveLength(2);
    expect(diags[0].ruleId).toBe('duplicate-name');
    expect(diags[0].severity).toBe('error');
    // `assert not x > 1.0;` declares no `x`: the name is the first token of an expression the recovery abandoned, and
    // having declared it made `duplicate-name` fire beside the mapper's refusal whenever a sibling held `x` (W4).
    const swallowed = await loadModelText('package A { part def P { attribute x = 3.0; assert not x > 1.0; } }', {
      library: 'none',
    });
    expect(swallowed.report.diagnostics.filter((d) => d.code === 'validation/duplicate-name')).toEqual([]);
    expect(swallowed.report.diagnostics.filter((d) => d.code === 'mapper/negated-assert-unread')).toHaveLength(1);
    // Two attributes really named `x` are still two findings.
    const dup = await loadModelText('package A { part def P { attribute x = 3.0; attribute x = 4.0; } }', {
      library: 'none',
    });
    expect(dup.report.diagnostics.filter((d) => d.code === 'validation/duplicate-name')).toHaveLength(2);
    // And a TERMINATED refused clause wrote its name as a name: beside a sibling it is a real duplicate.
    const terminated = await loadModelText('package A { part def P { attribute c = 3.0; assert not constraint c; } }', {
      library: 'none',
    });
    expect(terminated.report.diagnostics.filter((d) => d.code === 'validation/duplicate-name')).toHaveLength(2);
  });
});

describe('rule 2 — blank-name', () => {
  it('positive: a properly named element is fine', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    f.pkg('Named');
    expect(runRule(m, 'blank-name')).toHaveLength(0);
  });

  it('negative: a whitespace-only name is flagged', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    m.create('PartUsage', { declaredName: '   ', ownerId: p.id });
    const diags = runRule(m, 'blank-name');
    expect(diags).toHaveLength(1);
    expect(diags[0].elementId).toBeDefined();
  });
});

describe('rule 3 — dangling-endpoint', () => {
  it('positive: a connector between real elements is fine', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const a = f.part('a', p.id);
    const b = f.part('b', p.id);
    f.connect(a.id, b.id, { ownerId: p.id });
    expect(runRule(m, 'dangling-endpoint')).toHaveLength(0);
  });

  it('negative: an endpoint to a missing element is flagged', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const a = f.part('a', p.id);
    m.create('Dependency', { ownerId: p.id, source: ['ghost'], target: [a.id] });
    const diags = runRule(m, 'dangling-endpoint');
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('ghost');
  });
});

describe('rule 4 — unresolved-type-ref', () => {
  it('positive: a typeRef resolving by id is fine', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const def = f.partDef('T', p.id);
    m.create('PartUsage', { declaredName: 'x', ownerId: p.id, attrs: { typeRef: def.id } });
    expect(runRule(m, 'unresolved-type-ref')).toHaveLength(0);
  });

  it('negative: an unresolvable typeRef is flagged', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    m.create('PartUsage', { declaredName: 'x', ownerId: p.id, attrs: { typeRef: 'No::Such::Type' } });
    const diags = runRule(m, 'unresolved-type-ref');
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe('unresolved-type-ref');
  });
});

describe('rule 5 — port-direction', () => {
  it('positive: a port with a valid direction is fine', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const part = f.part('part', p.id);
    f.port('p1', part.id, { direction: 'in' });
    expect(runRule(m, 'port-direction')).toHaveLength(0);
  });

  it('negative: an invalid direction is an error, a missing one a warning', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const part = f.part('part', p.id);
    m.create('PortUsage', { declaredName: 'bad', ownerId: part.id, attrs: { direction: 'sideways' } });
    m.create('PortUsage', { declaredName: 'none', ownerId: part.id });
    const diags = runRule(m, 'port-direction');
    expect(diags).toHaveLength(2);
    expect(diags.some((d) => d.severity === 'error')).toBe(true);
    expect(diags.some((d) => d.severity === 'warning')).toBe(true);
  });
});

describe('rule 6 — malformed-multiplicity', () => {
  it('positive: well-formed multiplicities pass', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const part = f.part('part', p.id);
    f.attribute('a', part.id, { multiplicity: '0..*' });
    f.attribute('b', part.id, { multiplicity: '*' });
    f.attribute('c', part.id, { multiplicity: '1..5' });
    f.attribute('d', part.id, { multiplicity: '3' });
    expect(runRule(m, 'malformed-multiplicity')).toHaveLength(0);
  });

  it('negative: a malformed multiplicity is flagged', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const part = f.part('part', p.id);
    f.attribute('bad', part.id, { multiplicity: '1..2..3' });
    const diags = runRule(m, 'malformed-multiplicity');
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('1..2..3');
  });
});

describe('rule 7 — connector-endpoints', () => {
  it('positive: a two-ended connection is fine', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const a = f.part('a', p.id);
    const b = f.part('b', p.id);
    f.connect(a.id, b.id, { ownerId: p.id });
    expect(runRule(m, 'connector-endpoints')).toHaveLength(0);
  });

  it('a connection written with two `end … references` bodies is two-ended (§8.2.2.13); one related end or an unrelated end is not', () => {
    const src = (ends: string) => `package EP {
  part def Hub; part def Dev;
  connection def Link { end part hub : Hub; end part dev : Dev; }
  part def Sys { part h : Hub; part d : Dev; connection c : Link { ${ends} } }
}`;
    const run = (ends: string) => runRule(parseModel(src(ends)).model, 'connector-endpoints');
    expect(run('end part hub references h; end part dev references d;')).toHaveLength(0);
    expect(run('end part hub references h; end part dev;')).toHaveLength(1);
    expect(run('end part hub references h;')).toHaveLength(1);
  });

  it('negative: a connection with one endpoint is flagged', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const a = f.part('a', p.id);
    m.create('ConnectionUsage', { declaredName: 'lonely', ownerId: p.id, source: [a.id] });
    const diags = runRule(m, 'connector-endpoints');
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe('error');
  });
});

/**
 * The rule's own subject test, restated here so the query cases can ask which
 * features are subject-shaped directly. Deliberately a copy: if `rules.ts`
 * narrows its predicate, these cases must keep asking the whole question.
 */
function isSubjectShaped(c: ElementRecord): boolean {
  return (
    c.attrs.requirementRole === 'subject' ||
    c.declaredName === 'subject' ||
    c.eClass === 'SubjectMembership'
  );
}

describe('rule 8 — requirement-subject', () => {
  it('positive: a requirement with an explicit subject attr is fine', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const part = f.part('subjectPart', p.id);
    const req = f.requirement('R', p.id);
    m.setAttrs(req.id, { subject: part.id });
    expect(runRule(m, 'requirement-subject')).toHaveLength(0);
  });

  it('negative: a requirement without any subject is flagged', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    f.requirement('Naked', p.id);
    const diags = runRule(m, 'requirement-subject');
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe('warning');
  });

  /**
   * The rule is about NORMATIVE statements.
   *
   * A subject is what a requirement constrains, so the question "what is this
   * about" is a fair one to ask of a rule and a meaningless one to ask of an
   * explanation or of guidance for an agent. Before this, writing prose in
   * requirement shape bought one warning per paragraph — a rule that punishes
   * the feature the tool just shipped.
   */
  it('skips prose and prompt, which constrain nothing', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const note = f.requirement('Note', p.id);
    setStatementKind(m, note.id, 'prose');
    const guidance = f.requirement('Guidance', p.id);
    setStatementKind(m, guidance.id, 'prompt');
    expect(runRule(m, 'requirement-subject')).toHaveLength(0);
  });

  it('still flags a requirement tagged as one explicitly', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const req = f.requirement('Naked', p.id);
    setStatementKind(m, req.id, 'requirement');
    expect(runRule(m, 'requirement-subject')).toHaveLength(1);
  });

  /**
   * A `verify R by X;` names the thing being checked AGAINST the requirement,
   * which is the subject in all but name — so it answers the rule. A SOURCE-LESS
   * `Verify`, which is what the bare `verify R;` clause inside a case objective
   * builds, says only WHICH requirement the case checks. It names no subject,
   * and must not silence a requirement that still has none: reading the clause
   * as a reference otherwise turned this warning off for every requirement a
   * case mentions.
   */
  it('a two-ended verify answers the rule; a source-less one does not', () => {
    const withSource = new Model();
    const fa = new ModelFactory(withSource);
    const pa = fa.pkg('P');
    const reqA = fa.requirement('R', pa.id);
    const part = fa.part('X', pa.id);
    withSource.create('Verify', {
      ownerId: pa.id,
      source: [part.id],
      target: [reqA.id],
    });
    expect(runRule(withSource, 'requirement-subject')).toHaveLength(0);

    const sourceless = new Model();
    const fb = new ModelFactory(sourceless);
    const pb = fb.pkg('P');
    const reqB = fb.requirement('R', pb.id);
    sourceless.create('Verify', { ownerId: pb.id, source: [], target: [reqB.id] });
    expect(runRule(sourceless, 'requirement-subject')).toHaveLength(1);
  });

  /**
   * A subject stated once, on the definition, answers for every usage of it.
   *
   * `requirement r : MassLimit;` is the shape the OMG's own published models
   * are written in — 34 occurrences across `sysml.library` and the release
   * models, `requirement r : R;` verbatim among them (the ledger quotes the
   * grep that counts them): the definition says what the requirement is about,
   * the usage says where it applies. Reading only the usage's OWN children
   * asked the author to repeat the subject on every usage, and warned when they
   * did not — a false positive on the shape a contract reader has to be able to
   * trust, which is why it is paid off before anything reads one.
   */
  it('positive: a subject inherited from the definition answers the rule', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const vehicle = f.partDef('Vehicle', p.id);
    f.part('v', p.id, vehicle.id);
    const def = f.requirementDef('MassLimit', p.id);
    const subject = m.create('ReferenceUsage', {
      declaredName: 'v',
      ownerId: def.id,
      attrs: { requirementRole: 'subject' },
    });
    f.featureTyping(subject.id, vehicle.id);
    const use = f.requirement('r', p.id);
    f.featureTyping(use.id, def.id);
    expect(runRule(m, 'requirement-subject')).toHaveLength(0);
  });

  /**
   * Inheritance is transitive, because `effectiveFeatures` is: a definition
   * that specializes the one carrying the subject answers too, and so does a
   * usage of that definition. Three elements, one subject, no warning.
   */
  it('positive: a subject inherited through an intermediate definition answers too', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const vehicle = f.partDef('Vehicle', p.id);
    const base = f.requirementDef('Base', p.id);
    const subject = m.create('ReferenceUsage', {
      declaredName: 'v',
      ownerId: base.id,
      attrs: { requirementRole: 'subject' },
    });
    f.featureTyping(subject.id, vehicle.id);
    const mid = f.requirementDef('Mid', p.id);
    f.subclassification(mid.id, base.id);
    const use = f.requirement('r', p.id);
    f.featureTyping(use.id, mid.id);
    expect(runRule(m, 'requirement-subject')).toHaveLength(0);
  });

  /**
   * The other half of the same behaviour change: inheriting from a definition
   * that has no subject inherits no subject. Both elements are still reported,
   * because neither of them says what it is about.
   */
  it('negative: a usage of a subject-less definition is still flagged, twice', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const def = f.requirementDef('Bare', p.id);
    const use = f.requirement('r', p.id);
    f.featureTyping(use.id, def.id);
    expect(runRule(m, 'requirement-subject')).toHaveLength(2);
  });

  /**
   * An inherited feature is not an inherited SUBJECT.
   *
   * A requirement definition owns assumptions, constraints and subrequirements
   * as well, and every one of them is an effective feature of every usage. Only
   * the one tagged `requirementRole = 'subject'` answers the question the rule
   * asks — accepting any inherited feature would silence the rule for every
   * requirement definition that has a body.
   */
  it('negative: inheriting a non-subject clause is not inheriting a subject', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const def = f.requirementDef('Bounded', p.id);
    m.create('ConstraintUsage', {
      declaredName: 'bound',
      ownerId: def.id,
      attrs: { requirementRole: 'require', expression: 'mass < 10.0' },
    });
    const use = f.requirement('r', p.id);
    f.featureTyping(use.id, def.id);
    expect(runRule(m, 'requirement-subject')).toHaveLength(2);
  });

  /**
   * A requirement is judged on what its author declared, library or no library.
   *
   * The rule asks `effectiveFeatures`, which follows DECLARED generals, rather
   * than the library-aware walk that also follows the implicit base. The two
   * are NOT equivalent, which is why the choice is worth a test: for the same
   * bare requirement the narrow walk returns nothing at all, while the wide one
   * already returns the nine features of `Requirements::RequirementCheck` — one
   * of which IS a subject reference, spelled `subj`. Only that spelling keeps
   * the wide walk harmless today, so both halves are asserted here: the day the
   * library extraction renames `subj` to `subject`, this case says so before
   * anyone widens the query.
   */
  it('negative: the merged standard library does not silence a subject-less requirement', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    loadStandardLibrary(m);
    const p = f.pkg('P');
    const naked = f.requirement('Naked', p.id);
    const diags = runRule(m, 'requirement-subject');
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('"P::Naked"');

    // The two queries differ, and the difference is one rename away from
    // mattering: the implicit base carries a subject reference named `subj`.
    expect(effectiveFeatures(m, naked.id)).toHaveLength(0);
    const wide = effectiveFeaturesWithLibrary(m, naked.id);
    expect(wide.map((feat) => feat.declaredName)).toContain('subj');
    expect(wide.some(isSubjectShaped)).toBe(false);
  });

  /**
   * The discriminator the previous case cannot be: the query choice itself.
   *
   * `effectiveFeatures` (declared generals) and `effectiveFeaturesWithLibrary`
   * (declared generals PLUS the implicit library base) answer the same for
   * every model the corpus contains, so a swap between them is invisible to
   * every other test. Here the bundled library is given exactly what it lacks —
   * a subject-shaped feature on the implicit base of every RequirementUsage —
   * and the rule must STILL fire, because a feature nobody declared is not the
   * author saying what their requirement is about. Widen the query and this
   * case goes red; it is the only one that does.
   */
  it('negative: a subject on the IMPLICIT library base answers for nobody', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    loadStandardLibrary(m);
    const p = f.pkg('P');
    const naked = f.requirement('Naked', p.id);

    const base = generalizationsWithImplicit(m, naked.id)[0];
    expect(base.declaredName).toBe('RequirementCheck');
    m.create('ReferenceUsage', {
      declaredName: 'subject',
      ownerId: base.id,
      attrs: { requirementRole: 'subject' },
    });

    expect(effectiveFeatures(m, naked.id).some(isSubjectShaped)).toBe(false);
    expect(effectiveFeaturesWithLibrary(m, naked.id).some(isSubjectShaped)).toBe(true);
    expect(runRule(m, 'requirement-subject')).toHaveLength(1);
  });

  /**
   * A `SubjectMembership` answers for the element that owns it — and only for
   * that element.
   *
   * The inherited candidate set is USAGES (`effectiveFeatures` → `ownFeatures`,
   * which filters on `isUsage`), and `SubjectMembership` is not a Usage. So the
   * programmatic membership shape reaches the rule on the own-children line and
   * cannot reach it through inheritance. This records today's answer, not a
   * desired invariant: a model built this way must state the subject on the
   * usage too, or use the tagged ReferenceUsage the textual `subject v : V;`
   * clause produces, which does inherit (see the cases above).
   */
  it('a SubjectMembership answers for its owner, and does not inherit', () => {
    const own = new Model();
    const fa = new ModelFactory(own);
    const pa = fa.pkg('P');
    const reqA = fa.requirement('R', pa.id);
    own.create('SubjectMembership', { declaredName: 'v', ownerId: reqA.id });
    expect(runRule(own, 'requirement-subject')).toHaveLength(0);

    const inherited = new Model();
    const fb = new ModelFactory(inherited);
    const pb = fb.pkg('P');
    const def = fb.requirementDef('MassLimit', pb.id);
    inherited.create('SubjectMembership', { declaredName: 'v', ownerId: def.id });
    const use = fb.requirement('r', pb.id);
    fb.featureTyping(use.id, def.id);
    const diags = runRule(inherited, 'requirement-subject');
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('"P::r"');
  });

  /**
   * An own feature that shares the inherited subject's NAME masks it.
   *
   * `effectiveFeatures` resolves redefinition by name too: a feature the usage
   * declares itself hides the same-named feature it would otherwise inherit
   * (`src/semantics/inheritance.ts`:149). So a usage that re-uses the subject's
   * name for something else loses the inherited subject and is reported as
   * having none. That is the inheritance semantics the whole codebase shares —
   * this case pins it so the behaviour is a recorded answer rather than a
   * surprise, and so a future change to masking cannot pass unnoticed.
   */
  it("negative: an own feature with the subject's name masks the inherited subject", () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const vehicle = f.partDef('Vehicle', p.id);
    const def = f.requirementDef('MassLimit', p.id);
    const subject = m.create('ReferenceUsage', {
      declaredName: 'v',
      ownerId: def.id,
      attrs: { requirementRole: 'subject' },
    });
    f.featureTyping(subject.id, vehicle.id);
    const use = f.requirement('r', p.id);
    f.featureTyping(use.id, def.id);
    // Without this own `v`, the usage inherits the subject and is silent.
    m.create('AttributeUsage', { declaredName: 'v', ownerId: use.id });
    const diags = runRule(m, 'requirement-subject');
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('"P::r"');
  });
});

describe('rule 9 — redefinition-target-missing', () => {
  it('positive: a redefinition with a valid target is fine', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const base = f.part('base', p.id);
    const sub = f.part('sub', p.id);
    f.redefinition(sub.id, base.id);
    expect(runRule(m, 'redefinition-target-missing')).toHaveLength(0);
  });

  it('negative: a redefinition with a missing target is flagged', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const sub = f.part('sub', p.id);
    m.create('Redefinition', { ownerId: sub.id, source: [sub.id], target: ['ghost'] });
    const diags = runRule(m, 'redefinition-target-missing');
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe('redefinition-target-missing');
  });
});

describe('rule 10 — containment-cycle', () => {
  it('positive: ordinary nesting has no cycle', () => {
    const m = buildSampleModel();
    expect(runRule(m, 'containment-cycle')).toHaveLength(0);
  });

  it('negative: a self-owning element is flagged', () => {
    const data: SerializedModel = {
      formatVersion: '0.1.0',
      elements: [{ id: 'a', eClass: 'Package', ownerId: 'a', attrs: {} }],
      rootIds: [],
    };
    const m = Model.fromJSON(data);
    const diags = runRule(m, 'containment-cycle');
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('owns itself');
  });
});

describe('rule 10b — specialization-cycle (finding H8)', () => {
  it('positive: a clean specialization chain produces no diagnostic', () => {
    const m = buildSampleModel();
    expect(runRule(m, 'specialization-cycle')).toHaveLength(0);
  });

  it('negative: a two-element :> loop is flagged on both members', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const a = f.partDef('A', p.id);
    const b = f.partDef('B', p.id);
    m.create('Subsetting', { ownerId: a.id, source: [a.id], target: [b.id] });
    m.create('Subsetting', { ownerId: b.id, source: [b.id], target: [a.id] });
    const diags = runRule(m, 'specialization-cycle');
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].message).toContain('cycle');
  });

  it('negative: a self-specialization is flagged', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const a = f.partDef('A', p.id);
    m.create('Subsetting', { ownerId: a.id, source: [a.id], target: [a.id] });
    const diags = runRule(m, 'specialization-cycle');
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('itself');
  });
});

describe('rule 4b — unresolved node-level specialization refs (finding H9)', () => {
  it('negative: an unresolvable specializes/redefines/references entry is flagged', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    f.partDef('A', p.id);
    m.create('PartUsage', {
      declaredName: 'x',
      ownerId: p.id,
      attrs: { specializes: ['Ghost::Type'], redefines: ['Base::ghost'], references: ['Other::ghost'] },
    });
    const diags = runRule(m, 'unresolved-type-ref');
    expect(diags).toHaveLength(3);
  });

  it('positive: entries resolving by in-model id or qualified name are fine', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const a = f.partDef('A', p.id);
    m.create('PartUsage', {
      declaredName: 'x',
      ownerId: p.id,
      attrs: { specializes: [a.id], references: ['P::A'] },
    });
    expect(runRule(m, 'unresolved-type-ref')).toHaveLength(0);
  });

  it('positive: a reference resolving from the ELEMENT\'s own scope is fine', () => {
    // The rule used to resolve only from the ROOT, so a name that is perfectly
    // resolvable where it was written (an inherited member) was reported unless
    // some library short name happened to match it.
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const base = f.partDef('Base', p.id);
    m.create('PartUsage', { declaredName: 'w', ownerId: base.id });
    const car = f.partDef('Car', p.id);
    m.create('Subclassification', { ownerId: car.id, source: [car.id], target: [base.id] });
    m.create('PartUsage', { declaredName: 'w2', ownerId: car.id, attrs: { redefines: ['w'] } });
    expect(runRule(m, 'unresolved-type-ref')).toHaveLength(0);
  });

  it('negative: a library FEATURE no longer masks a dangling redefinition', () => {
    // `findLibraryType` matches an UNQUALIFIED name against every library
    // element, and the bundled library has a function parameter named `w`
    // (`VectorFunctions::+::w`), so `:>> w` on a model with no `w` anywhere
    // passed validation silently. A library feature is not the answer to a user
    // reference; a bare library DEFINITION still is.
    const m = new Model();
    const f = new ModelFactory(m);
    loadStandardLibrary(m);
    const p = f.pkg('P');
    const car = f.partDef('Car', p.id);
    m.create('PartUsage', { declaredName: 'w2', ownerId: car.id, attrs: { redefines: ['nope'] } });
    m.create('PartUsage', { declaredName: 'w3', ownerId: car.id, attrs: { redefines: ['w'] } });
    const diags = runRule(m, 'unresolved-type-ref');
    expect(diags.map((d) => d.message).join('\n')).toContain('"w"');
    expect(diags).toHaveLength(2);

    // …while a bare library DEFINITION stays acceptable (recorded leniency).
    m.create('PartUsage', { declaredName: 'w4', ownerId: car.id, attrs: { specializes: ['Part'] } });
    expect(runRule(m, 'unresolved-type-ref')).toHaveLength(2);
  });

  it('positive: silent while the owning type\'s OWN general is unresolved', () => {
    // The counterweight to the case above. Refusing a library feature unmasks a
    // dangling `:>> w`, but only where the tool could have enumerated the
    // members `w` might have named. With the supertype itself unbound it could
    // not: `attribute def MyValue :> ScalarQuantityValue { attribute :>> num; }`
    // reported `num` as an ERROR purely because it had already lost
    // `ScalarQuantityValue` — 348 such errors in one library file, and the
    // unresolved GENERAL is the finding worth reading.
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const mine = f.partDef('MyValue', p.id);
    m.setAttrs(mine.id, { specializes: ['ScalarQuantityValue'] });
    m.create('PartUsage', { declaredName: 'n', ownerId: mine.id, attrs: { redefines: ['num'] } });
    // Only the unresolved general itself.
    const diags = runRule(m, 'unresolved-type-ref');
    expect(diags.map((d) => d.message)).toEqual([
      expect.stringContaining('"ScalarQuantityValue"'),
    ]);

    // Bind the general, and the dangling redefinition is reported again.
    const real = f.partDef('ScalarQuantityValue', p.id);
    m.setAttrs(mine.id, { specializes: undefined });
    m.create('Subclassification', { ownerId: mine.id, source: [mine.id], target: [real.id] });
    expect(runRule(m, 'unresolved-type-ref').map((d) => d.message)).toEqual([
      expect.stringContaining('"num"'),
    ]);
  });

  it('positive: an unresolved `attrs.type` on the owner is a hole too', () => {
    // The library's own shape: `attribute yocto : UnitPrefix { :>> longName; }`
    // where `UnitPrefix` is not in the bundled subset. An unresolved `:` on an
    // Attribute* falls back to `attrs.type` and stays SILENT, so the scope test
    // has to look there as well — checking `typeRef` alone reported 84 errors
    // in `SIPrefixes.sysml` for redefinitions of members it could not see.
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const yocto = f.attribute('yocto', p.id);
    m.setAttrs(yocto.id, { type: 'UnitPrefix' });
    m.create('ReferenceUsage', {
      declaredName: 'longName',
      ownerId: yocto.id,
      attrs: { redefines: ['longName'] },
    });
    expect(runRule(m, 'unresolved-type-ref')).toEqual([]);

    // A RESOLVED typing leaves `attrs.type` in place for the serializer, and
    // must NOT be read as a hole — otherwise the rule silences itself.
    const prefix = f.partDef('UnitPrefix', p.id);
    m.create('FeatureTyping', { ownerId: yocto.id, source: [yocto.id], target: [prefix.id] });
    expect(runRule(m, 'unresolved-type-ref').map((d) => d.message)).toEqual([
      expect.stringContaining('"longName"'),
    ]);
  });
});

describe('rule 7b — flow/succession connectors (finding H10)', () => {
  it('negative: a Succession with a single endpoint is flagged', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const a = f.part('a', p.id);
    m.create('Succession', { declaredName: 's', ownerId: p.id, source: [a.id] });
    expect(runRule(m, 'connector-endpoints')).toHaveLength(1);
  });

  it('negative: a Flow with no endpoints is flagged', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    m.create('Flow', { ownerId: p.id });
    const diags = runRule(m, 'connector-endpoints');
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('Flow');
  });
});

describe('rule 11 — orphan-relationship', () => {
  it('positive: an owned relationship is fine', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const a = f.part('a', p.id);
    const b = f.part('b', p.id);
    f.dependency(a.id, b.id, p.id);
    expect(runRule(m, 'orphan-relationship')).toHaveLength(0);
  });

  it('negative: an unowned relationship is flagged', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const a = f.part('a', p.id);
    const b = f.part('b', p.id);
    m.create('Dependency', { ownerId: null, source: [a.id], target: [b.id] });
    const diags = runRule(m, 'orphan-relationship');
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe('warning');
  });
});

describe('rule 12 — feature-typing-non-type', () => {
  it('positive: a feature typed by a Definition is fine', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const def = f.partDef('Engine', p.id);
    f.part('engine', p.id, def.id); // FeatureTyping → Definition (a Classifier ⊑ Type)
    expect(runRule(m, 'feature-typing-non-type')).toHaveLength(0);
  });

  it('positive: a feature typed by a Usage is now trusted (a Usage is a kind of Type)', () => {
    // A KerML Feature (hence a Usage) IS a Type, so typing a feature by another
    // Usage is not a well-formedness defect — the metaclass-aware rule no longer
    // raises this former false positive.
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const target = f.part('anotherPart', p.id); // PartUsage — a kind of Type
    const feature = f.part('feature', p.id);
    f.featureTyping(feature.id, target.id);
    expect(runRule(m, 'feature-typing-non-type')).toHaveLength(0);
  });

  it('negative: a feature typed by a genuinely non-type element (Package) is flagged', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const nonType = f.pkg('NotAType', p.id); // Package ⊑ Namespace, NOT a Type
    const feature = f.part('feature', p.id);
    f.featureTyping(feature.id, nonType.id);
    const diags = runRule(m, 'feature-typing-non-type');
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('non-type');
  });
});

describe('rule 12b — connector-end-not-feature', () => {
  it('positive: a connector between two features (parts) is fine', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const a = f.part('a', p.id); // PartUsage — a Feature
    const b = f.part('b', p.id);
    f.connect(a.id, b.id, { ownerId: p.id });
    expect(runRule(m, 'connector-end-not-feature')).toHaveLength(0);
  });

  it('negative: a connector whose endpoint is a Definition (non-Feature) is flagged', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const feature = f.part('a', p.id); // Feature end (ok)
    const def = f.partDef('Engine', p.id); // PartDefinition — a Classifier, NOT a Feature
    m.create('ConnectionUsage', {
      declaredName: 'bad',
      ownerId: p.id,
      source: [feature.id],
      target: [def.id],
    });
    const diags = runRule(m, 'connector-end-not-feature');
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe('error');
    expect(diags[0].message).toContain('is not a Feature');
  });
});

describe('multiplicity-conformance and binding-conformance (BD2, BD4)', () => {
  const run = async (body: string, rule: string) => {
    const r = await loadModelText(`package P { ${body} }`);
    return runRule(r.model!, rule).map((d) => d.message);
  };

  it('flags lower above upper, a subset above its superset, a widening redefinition', async () => {
    expect(await run('part q [3..1];', 'multiplicity-conformance')).toHaveLength(1);
    expect(await run('part def D; part fleet : D [4]; part extra : D [5] :> fleet;', 'multiplicity-conformance')).toHaveLength(1);
    const w = await run('part def A { attribute r [1..2]; } part def B :> A { attribute :>> r [0..5]; }', 'multiplicity-conformance');
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('widens');
  });

  it('stays silent on legal bounds: a subsetter with a lower bound below the superset, a narrowing redefinition, unbounded, inherited', async () => {
    expect(await run('part def D; part fleet : D [4..8]; part a : D [1] :> fleet; part b : D [0..1] :> fleet; part c : D [3] :> fleet;', 'multiplicity-conformance')).toEqual([]);
    expect(await run('part def A { attribute r [1..2]; } part def B :> A { attribute :>> r [2]; }', 'multiplicity-conformance')).toEqual([]);
    expect(await run('part def D; part fleet : D [1..*]; part s : D [2..*] :> fleet; part t : D [*]; part u : D [0..*] :> t; part v : D :> fleet;', 'multiplicity-conformance')).toEqual([]);
  });

  it('flags a bind between types that do not conform, not one that does either way', async () => {
    expect(await run('attribute x : Real; attribute y : String; bind x = y;', 'binding-conformance')).toHaveLength(1);
    expect(await run('attribute x : Real; attribute y : Integer; bind x = y; bind y = x;', 'binding-conformance')).toEqual([]);
    expect(await run('attribute x : Real; attribute y; bind x = y;', 'binding-conformance')).toEqual([]);
  });

  it('flags bound features whose multiplicities share no cardinality, not overlapping ones', async () => {
    const m = await run('part def D; part a : D [1]; part b : D [2..3]; bind a = b;', 'binding-conformance');
    expect(m).toHaveLength(1);
    expect(m[0]).toContain('no cardinality in common');
    expect(await run('part def D; part a : D [1..2]; part b : D [2..3]; bind a = b;', 'binding-conformance')).toEqual([]);
  });
});

describe('structural fences wave 2 (BD3, BD6-BD9, BD11)', () => {
  const run = async (body: string, rule: string) => {
    const r = await loadModelText(`package P { ${body} }`);
    return runRule(r.model!, rule).map((d) => d.message);
  };

  it('BD3 subset-type-conformance: flags a subsetter whose type does not specialise the subsetted type', async () => {
    const w = await run('part def A; part def B; part def X { part a : A [2]; part b : B subsets a; }', 'subset-type-conformance');
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('subsets');
  });
  it('BD3: silent on a specialising type, the same type and an untyped subsetter', async () => {
    expect(await run('part def A; part def B :> A; part def X { part a : A [2]; part b : B subsets a; part c : A subsets a; part d subsets a; }', 'subset-type-conformance')).toEqual([]);
  });

  it('BD3: the type a redefined feature gives is judged; a conforming one stays silent', async () => {
    const w = await run('part def A; part def B; part def Base { part x : B; part a : A [2]; } part def X :> Base { part c redefines x subsets a; }', 'subset-type-conformance');
    expect(w).toHaveLength(1);
    expect(await run('part def A; part def B :> A; part def Base { part x : B; part a : A [2]; } part def X :> Base { part c redefines x subsets a; }', 'subset-type-conformance')).toEqual([]);
  });

  it('BD11: chains with quoted names and a qualified head are read', async () => {
    const decl = "part def E { attribute mass : Real; } part def Car { part 'main engine' : E; attribute ok : Real = 'main engine'.mass; attribute bad : Real = 'main engine'.nosuch; attribute q : Real = P::Car::'main engine'.nosuch2; attribute okq : Real = P::Car::'main engine'.mass; }";
    const w = await run(decl, 'unresolved-value-chain');
    expect(w).toHaveLength(2);
    expect(w.join('\n')).toContain('nosuch');
    expect(w.join('\n')).toContain('nosuch2');
  });

  it('BD6 disjoint-sum-exceeds: flags disjoint subsets whose lower bounds exceed the superset', async () => {
    const w = await run('part def W; part def Car { part wheels : W [4]; part front : W [3] subsets wheels; part rear : W [3] subsets wheels; disjoint front from rear; }', 'disjoint-sum-exceeds');
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('add up to 6');
  });
  it('BD6: silent when not declared disjoint, when the sum fits, or when the lower bounds are below', async () => {
    const car = (extra: string, fl: string, rl: string) => `part def W; part def Car { part wheels : W [4]; part front : W ${fl} subsets wheels; part rear : W ${rl} subsets wheels; ${extra} }`;
    expect(await run(car('', '[3]', '[3]'), 'disjoint-sum-exceeds')).toEqual([]);
    expect(await run(car('disjoint front from rear;', '[2]', '[2]'), 'disjoint-sum-exceeds')).toEqual([]);
    expect(await run(car('disjoint front from rear;', '[0..3]', '[0..3]'), 'disjoint-sum-exceeds')).toEqual([]);
  });

  it('BD6 through variants: alternatives are not summed; a sum needing a variant is an info naming it', async () => {
    const run2 = async (body: string) => {
      const r = await loadModelText(`package P { ${body} }`);
      return runRule(r.model!, 'disjoint-sum-exceeds');
    };
    // two variants of one point are alternatives: never present together, so no sum (a false positive before)
    expect(
      await run2('part def W; part def Car { part wheels : W [4]; variation part opt { variant part a : W [3] subsets wheels; variant part b : W [3] subsets wheels; disjoint a from b; } }'),
    ).toEqual([]);
    // a fixed subsetter plus a variant's: exceeds only when the variant is selected
    const d = await run2('part def W; part def Car { part wheels : W [4]; part front : W [3] subsets wheels; variation part opt { variant part extra : W [3] subsets wheels; variant part none : W [0..1]; } disjoint front from opt::extra; }');
    expect(d).toHaveLength(1);
    expect(d[0]!.severity).toBe('info');
    expect(d[0]!.message).toContain('only in');
    expect(d[0]!.message).toContain('extra');
    // a variant whose sum fits stays silent
    expect(
      await run2('part def W; part def Car { part wheels : W [8]; part front : W [3] subsets wheels; variation part opt { variant part extra : W [3] subsets wheels; } disjoint front from opt::extra; }'),
    ).toEqual([]);
    // no variants: the warning says it holds in every configuration
    const e = await run2('part def W; part def Car { part wheels : W [4]; part front : W [3] subsets wheels; part rear : W [3] subsets wheels; disjoint front from rear; }');
    expect(e[0]!.severity).toBe('warning');
    expect(e[0]!.message).toContain('in every configuration');
  });

  it('BD6 under the family constraints: excluded selection silent, forced selection warns, partial names the configurations', async () => {
    const run2 = async (c: string) => {
      const r = await loadModelText(`package P { part def W; part def Car { part wheels : W [4]; part front : W [3] subsets wheels; variation part opt { variant part extra : W [3] subsets wheels; variant part none : W [0..1]; } disjoint front from opt::extra; ${c} } }`);
      return runRule(r.model!, 'disjoint-sum-exceeds');
    };
    // no valid configuration selects extra: the sum never arises
    expect(await run2('assert constraint c { not (opt == opt::extra) }')).toEqual([]);
    // every valid configuration selects extra: a warning
    const w = await run2('assert constraint c { opt == opt::extra }');
    expect(w).toHaveLength(1);
    expect(w[0]!.severity).toBe('warning');
    expect(w[0]!.message).toContain('in every valid configuration');
    // some do: an info naming the configurations
    const i = await run2('');
    expect(i[0]!.severity).toBe('info');
    expect(i[0]!.message).toContain('exceeds only in: opt = ');
  });

  it('BD6 per configuration: every exceeding clique is reported, each with its own configurations', async () => {
    const run2 = async (c: string) => {
      const r = await loadModelText(`package P { part def W; part def Car { part wheels : W [4]; part front : W [3] subsets wheels; variation part opt { variant part x : W [3] subsets wheels; variant part y : W [3] subsets wheels; variant part none : W [0..1]; } disjoint front from opt::x; disjoint front from opt::y; ${c} } }`);
      return runRule(r.model!, 'disjoint-sum-exceeds');
    };
    // two cliques (front+x, front+y), each exceeding in its own configuration: both reported (one was missed before)
    const d = await run2('');
    expect(d).toHaveLength(2);
    expect(d.every((x) => x.severity === 'info')).toBe(true);
    expect(d.some((x) => x.message.includes('opt = opt::x')) && d.some((x) => x.message.includes('opt = opt::y'))).toBe(true);
    // the constraint removes y: only the x clique remains
    const e = await run2('assert constraint c { not (opt == opt::y) }');
    expect(e).toHaveLength(1);
    expect(e[0]!.message).toContain('opt = opt::x');
    // a configuration forced to x: that clique is a warning, y silent
    const f = await run2('assert constraint c { opt == opt::x }');
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe('warning');
    expect(f[0]!.message).toContain('in every valid configuration');
    // a sum that fits in every configuration stays silent
    const r = await loadModelText('package P { part def W; part def Car { part wheels : W [8]; part front : W [3] subsets wheels; variation part opt { variant part x : W [3] subsets wheels; variant part y : W [3] subsets wheels; } disjoint front from opt::x; disjoint front from opt::y; } }');
    expect(runRule(r.model!, 'disjoint-sum-exceeds')).toEqual([]);
  });

  it('BD6 past the V4 cap: the exact search decides the selection; verdicts equal the enumeration on a small family', async () => {
    // 20 two-variant padding points make 2^20 structural configurations, above the enumeration cap.
    const pad = (n: number) => Array.from({ length: n }, (_, k) => `variation part pad${k} { variant part a${k}; variant part b${k}; }`).join(' ');
    const run2 = async (c: string, n: number) => {
      const r = await loadModelText(`package P { part def W; part def Car { part wheels : W [4]; part front : W [3] subsets wheels; variation part opt { variant part extra : W [3] subsets wheels; variant part none : W [0..1]; } disjoint front from opt::extra; ${pad(n)} ${c} } }`);
      return runRule(r.model!, 'disjoint-sum-exceeds');
    };
    for (const c of ['', 'assert constraint c { opt == opt::extra }', 'assert constraint c { pad0 == pad0::a0 implies opt == opt::extra }']) {
      const small = await run2(c, 2);
      const cut = await run2(c, 20);
      expect(cut.map((d) => d.severity)).toEqual(small.map((d) => d.severity));
    }
    // forced selection: warning past the cap; avoidable selection: info with a witness
    const w = await run2('assert constraint c { opt == opt::extra }', 20);
    expect(w[0]!.severity).toBe('warning');
    expect(w[0]!.message).toContain('in every valid configuration');
    const i = await run2('', 20);
    expect(i[0]!.severity).toBe('info');
    expect(i[0]!.message).toContain('exceeds in at least one valid configuration: ');
    // the only exceeding clique is excluded by the constraints: decided, silent
    const x = await run2('assert constraint c { not (opt == opt::extra) }', 20);
    expect(x).toEqual([]);
  }, 120000);

  it('BD6 past the V4 cap: an excluded heaviest clique does not silence a lighter exceeding one', async () => {
    const pad = Array.from({ length: 20 }, (_, k) => `variation part pad${k} { variant part a${k}; variant part b${k}; }`).join(' ');
    const run2 = async (c: string) => {
      const r = await loadModelText(`package P { part def W; part def Car { part wheels : W [4]; part front : W [3] subsets wheels; variation part opt { variant part x : W [3] subsets wheels; variant part y : W [2] subsets wheels; variant part none : W [0..1]; } disjoint front from opt::x; disjoint front from opt::y; ${pad} ${c} } }`);
      return runRule(r.model!, 'disjoint-sum-exceeds');
    };
    const d = await run2('assert constraint c { not (opt == opt::x) }');
    expect(d).toHaveLength(1);
    expect(d[0]!.message).toContain('exceeds in at least one valid configuration');
    expect(await run2('assert constraint c { opt == opt::none }')).toEqual([]);
  }, 120000);

  it('BD6 with more than 14 candidates: per configuration listing (some, all, none)', async () => {
    const fill = Array.from({ length: 15 }, (_, k) => `part f${k} : W [0] subsets wheels;`).join(' ') + ' ' + Array.from({ length: 14 }, (_, k) => `disjoint f${k} from f${k + 1};`).join(' ');
    const mk = async (hiSup: number, c: string) => {
      const r = await loadModelText(`package P { part def W; part def Car { part wheels : W [${hiSup}]; part front : W [3] subsets wheels; variation part opt { variant part x : W [3] subsets wheels; variant part y : W [3] subsets wheels; variant part none : W [0..1]; } disjoint front from opt::x; disjoint front from opt::y; ${fill} ${c} } }`);
      return runRule(r.model!, 'disjoint-sum-exceeds');
    };
    const some = await mk(4, '');
    expect(some).toHaveLength(2);
    expect(some.every((d) => d.severity === 'info')).toBe(true);
    expect(some.some((d) => d.message.includes('opt = opt::x')) && some.some((d) => d.message.includes('opt = opt::y'))).toBe(true);
    const all = await mk(4, 'assert constraint c { opt == opt::x }');
    expect(all).toHaveLength(1);
    expect(all[0]!.severity).toBe('warning');
    expect(all[0]!.message).toContain('in every valid configuration');
    expect(await mk(8, '')).toEqual([]);
    expect(await mk(4, 'assert constraint c { opt == opt::none }')).toEqual([]);
  });

  it('BD6 with more than 14 candidates: an exhausted search is reported, never a pass', async () => {
    const n = 36;
    const subs = Array.from({ length: n }, (_, k) => `part s${k} : W [1] subsets wheels;`).join(' ');
    let ds = '';
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if ((i * 7 + j * 13) % 10 !== 0) ds += `disjoint s${i} from s${j}; `;
    const r = await loadModelText(`package P { part def W; part def Car { part wheels : W [100]; ${subs} ${ds} } }`);
    const d = runRule(r.model!, 'disjoint-sum-exceeds');
    expect(d.map((x) => x.severity)).toEqual(['info']);
    expect(d[0]!.message).toContain('ran out of budget');
  }, 120000);

  it('BD6 with more than 14 candidate subsetters: the exact clique search finds the exceeding clique, and stays silent without one', async () => {
    const mk = (n: number, hiSup: number, lo: number, disj: boolean) => {
      const subs = Array.from({ length: n }, (_, k) => `part s${k} : W [${lo}] subsets wheels;`).join(' ');
      const ds = disj ? Array.from({ length: n - 1 }, (_, k) => `disjoint s${k} from s${k + 1};`).join(' ') : '';
      return `package P { part def W; part def Car { part wheels : W [${hiSup}]; ${subs} ${ds} } }`;
    };
    // 16 candidates, chained disjoint pairs only: heaviest clique is a pair (2 x 3 = 6 > 5)
    const r = await loadModelText(mk(16, 5, 3, true));
    const d = runRule(r.model!, 'disjoint-sum-exceeds');
    expect(d).toHaveLength(1);
    expect(d[0]!.message).toContain('add up to 6');
    // the same 16 with a superset big enough: silent
    const r2 = await loadModelText(mk(16, 6, 3, true));
    expect(runRule(r2.model!, 'disjoint-sum-exceeds')).toEqual([]);
    // 16 candidates, none declared disjoint: no clique
    const r3 = await loadModelText(mk(16, 2, 3, false));
    expect(runRule(r3.model!, 'disjoint-sum-exceeds')).toEqual([]);
  });

  it('BD7 enum-value-not-member: flags a literal the enum lacks, another enum literal, a number', async () => {
    const enums = 'enum def Color { red; green; } enum def Size { big; }';
    expect(await run(`${enums} part def X { attribute c : Color = Color::blue; }`, 'enum-value-not-member')).toHaveLength(1);
    expect(await run(`${enums} part def X { attribute d : Color = 3; }`, 'enum-value-not-member')).toHaveLength(1);
    expect(await run(`${enums} part def X { attribute e : Color = Size::big; }`, 'enum-value-not-member')).toHaveLength(1);
  });
  it('BD7: silent on a member, an untyped attribute and an enum over an attribute def', async () => {
    const enums = 'enum def Color { red; green; }';
    expect(await run(`${enums} part def X { attribute c : Color = Color::red; attribute d = Color::blue; attribute e : Color; }`, 'enum-value-not-member')).toEqual([]);
    expect(await run('attribute def Len :> Real; enum def Dia :> Len { small = 60.0; } part def X { attribute c : Dia = 60.0; }', 'enum-value-not-member')).toEqual([]);
  });

  it('BD8 value-multiplicity-mismatch: flags a list over a [1], and a literal below the lower bound', async () => {
    expect(await run('part def X { attribute c : Real [1] = (1.0, 2.0); }', 'value-multiplicity-mismatch')).toHaveLength(1);
    expect(await run('part def X { attribute b : Real [0..1] = (1, 2); }', 'value-multiplicity-mismatch')).toHaveLength(1);
    const w = await run('part def X { attribute a : Real [2] = 3.0; }', 'value-multiplicity-mismatch');
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('below its lower bound');
  });
  it('BD8: silent on fitting counts, a default, a parenthesised expression and a non-literal', async () => {
    expect(
      await run('part def X { attribute a : Real [2] = (1.0, 2.0); attribute b : Real [2] default 3.0; attribute c : Real [1] = (1.0 + 2.0); attribute d : Real [2] = other; attribute e [1..*] = (1, 2, 3); attribute f : Real [1] = 4.0; }', 'value-multiplicity-mismatch'),
    ).toEqual([]);
  });

  it('BD8: values the evaluator decides - a reference, arithmetic over references, a sequence, a call', async () => {
    const R = 'value-multiplicity-mismatch';
    // reference to a feature bound to a list of three, into a [1]
    expect(await run('part def X { attribute t : Real [3] = (1.0, 2.0, 3.0); attribute a : Real [1] = t; }', R)).toHaveLength(1);
    // reference to a scalar, into a [2] bound (fewer than the lower bound)
    expect(await run('part def X { attribute k : Real = 3.0; attribute n : Real [2] = k; }', R)).toHaveLength(1);
    // arithmetic over references decided as one value each
    expect(await run('part def X { attribute k : Real [1] = 3.0; attribute n : Real [2] = k + 1.0; }', R)).toHaveLength(1);
    // a sequence of decided parts adds up
    expect(await run('part def X { attribute t : Real [2] = (1.0, 2.0); attribute a : Real [2] = (t, 5.0); }', R)).toHaveLength(1);
    // a call whose result states [3] into a [1]
    expect(await run('calc def F { in x : Real; return r : Real [3]; } part def X { attribute a : Real [1] = F(1.0); }', R)).toHaveLength(1);
  });
  it('BD8: an undecidable value stays silent, and decided values that fit are silent', async () => {
    const R = 'value-multiplicity-mismatch';
    // a reference to a feature with no stated count, a ranged count, a chain and an unresolved name
    expect(await run('part def X { attribute u : Real; attribute r : Real [1..3]; attribute a : Real [2] = u; attribute b : Real [2] = r; attribute c : Real [2] = u + 1.0; attribute d : Real [2] = z; }', R)).toEqual([]);
    // a call with no stated result multiplicity
    expect(await run('calc def F { in x : Real; return r : Real; } part def X { attribute a : Real [2] = F(1.0); }', R)).toEqual([]);
    // decided and fitting
    expect(await run('part def X { attribute t : Real [3] = (1.0, 2.0, 3.0); attribute a : Real [3] = t; attribute k : Real [1] = 3.0; attribute n : Real [1] = k + 1.0; attribute m : Real [4] = (t, 5.0); }', R)).toEqual([]);
  });
  it('BD8: arithmetic of literals is one value; a name in it stays unread', async () => {
    expect(await run('part def X { attribute a : Real [2] = 2.0 * 3.0 + 1.0; attribute b : Real [1] = (1.0 + 2.0, 3.0); }', 'value-multiplicity-mismatch')).toHaveLength(2);
    expect(await run('part def X { attribute a : Real [1] = 2.0 * 3.0 + 1.0; attribute n : Real [2] = 1.0 + other; attribute c : Real [2] = (1.0 + 2.0, 3.0); }', 'value-multiplicity-mismatch')).toEqual([]);
  });

  it('BD9 specialization-kind-incompatible: flags item def :> attribute def, part def :> port def, enum :> enum', async () => {
    expect(await run('attribute def V; item def C :> V;', 'specialization-kind-incompatible')).toHaveLength(1);
    expect(await run('port def Q; part def B :> Q;', 'specialization-kind-incompatible')).toHaveLength(1);
    expect(await run('enum def E { a; } enum def F :> E { b; }', 'specialization-kind-incompatible')).toHaveLength(1);
  });
  it('BD9: silent on one line of the hierarchy and on attribute :> enum', async () => {
    expect(await run('item def I; part def B :> I; part def C :> B; occurrence def O; item def D :> O; attribute def V; attribute def W :> V; enum def E { a; } attribute def Z :> E;', 'specialization-kind-incompatible')).toEqual([]);
  });

  it('BD9 usage level: a usage subsetting or redefining a usage of another line is flagged', async () => {
    expect(await run('part def A; port def Q; part def X { part p : A; attribute v :> p; }', 'specialization-kind-incompatible')).toHaveLength(1);
    expect(await run('port def Q; part def X { port r : Q; part s subsets r; }', 'specialization-kind-incompatible')).toHaveLength(1);
    expect(await run('part def A; part def Y { part p : A; } part def Z :> Y { attribute p redefines p; }', 'specialization-kind-incompatible')).toHaveLength(1);
  });
  it('BD9 usage level: item over part, state over action, a ref usage and same kinds stay silent', async () => {
    expect(await run('part def A; part def X { part p : A; item i :> p; ref r :> p; part q :> p; attribute a; attribute b :> a; action act; state st :> act; ref x; part y :> x; }', 'specialization-kind-incompatible')).toEqual([]);
  });

  it('BD11 unresolved-value-chain: flags a chain whose later name is not a feature', async () => {
    const w = await run('part def E { attribute mass : Real; } part def Car { part e : E; attribute m : Real = e.mass; attribute bad : Real = e.nosuch; }', 'unresolved-value-chain');
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('nosuch');
  });
  it('BD11: silent on resolving chains, inherited features, an untyped head and an unresolved head', async () => {
    expect(
      await run('part def E { attribute mass : Real; } part def E2 :> E; part def Car { part e : E2; attribute m : Real = e.mass; part u; attribute x = u.anything; attribute y = nothere.mass; }', 'unresolved-value-chain'),
    ).toEqual([]);
  });
});

describe('rule 15 — constraint-violation', () => {
  /**
   * A package to hang statements on. The expression below is a bare literal
   * comparison, so what the rule says turns on the STATEMENT KIND alone and not
   * on whether a name resolved.
   */
  const VIOLATED = '30 <= 25';

  function violating(): { m: Model; pkg: string } {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    return { m, pkg: p.id };
  }

  it('negative: a violated requirement expression is a warning', () => {
    const { m, pkg } = violating();
    const f = new ModelFactory(m);
    const req = f.requirement('MassLimit', pkg);
    m.setAttrs(req.id, { expression: VIOLATED });
    const diags = runRule(m, 'constraint-violation');
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe('warning');
  });

  /**
   * This rule reads REQUIREMENTS as well as constraints, so it is a requirement
   * rule too and takes the same exemption as `requirement-subject`. Before this,
   * an author who wrote `#prose` in front of a paragraph was told by the tool
   * that the paragraph was violated — the tool contradicting the author's own
   * tag, on the very statement the tag exists to exempt.
   */
  it('skips a requirement tagged prose or prompt', () => {
    for (const kind of ['prose', 'prompt'] as const) {
      const { m, pkg } = violating();
      const f = new ModelFactory(m);
      const req = f.requirement('ANote', pkg);
      m.setAttrs(req.id, { expression: VIOLATED });
      setStatementKind(m, req.id, kind);
      expect(runRule(m, 'constraint-violation'), kind).toHaveLength(0);
    }
  });

  /**
   * The guard must NOT be "is this normative?". A plain `constraint c { … }`
   * carries no statement kind at all, so that test would have failed for it and
   * quietly stopped checking every ordinary constraint in every model.
   */
  it('still judges a plain constraint, which has no statement kind', () => {
    const { m, pkg } = violating();
    const con = m.create('ConstraintUsage', {
      declaredName: 'c',
      ownerId: pkg,
      attrs: { expression: VIOLATED },
    });
    expect(statementKindOf(m, con.id)).toBeUndefined();
    expect(runRule(m, 'constraint-violation')).toHaveLength(1);
  });

  it('still judges a requirement tagged as one explicitly', () => {
    const { m, pkg } = violating();
    const f = new ModelFactory(m);
    const req = f.requirement('MassLimit', pkg);
    m.setAttrs(req.id, { expression: VIOLATED });
    setStatementKind(m, req.id, 'requirement');
    expect(runRule(m, 'constraint-violation')).toHaveLength(1);
  });
});

describe('rule 16 — unknown-unit', () => {
  function withConstraint(expression: string) {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const v = f.part('v', p.id);
    m.create('AttributeUsage', { declaredName: 'mtow', ownerId: v.id, attrs: { type: 'ISQ::MassValue', value: 18.5, unit: 'kg' } });
    m.create('ConstraintUsage', { declaredName: 'c', ownerId: v.id, attrs: { expression } });
    return m;
  }

  it('positive: a registered unit inside a constraint body is fine, qualified or not', () => {
    expect(runRule(withConstraint('mtow <= 25.0 [kg]'), 'unknown-unit')).toHaveLength(0);
    expect(runRule(withConstraint('mtow <= 25.0 [SI::kg]'), 'unknown-unit')).toHaveLength(0);
  });

  it('negative: `[furlong]` inside a constraint body is reported on the constraint', () => {
    const diags = runRule(withConstraint('mtow <= 25.0 [furlong]'), 'unknown-unit');
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe('warning');
    expect(diags[0].message).toContain('[furlong]');
  });

  it('negative: a unit beside an expression value is judged, not misreported', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const v = f.part('v', p.id);
    m.create('AttributeUsage', { declaredName: 'span', ownerId: v.id, attrs: { type: 'ISQ::LengthValue', value: '(1 + 2)', unit: 'm' } });
    m.create('AttributeUsage', { declaredName: 'odd', ownerId: v.id, attrs: { type: 'ISQ::LengthValue', value: '(1 + 2)', unit: 'furlong' } });
    const diags = runRule(m, 'unknown-unit');
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('odd');
  });

  it('positive: brackets inside a STRING value or a string literal in a body are text, not units', () => {
    // Review finding: `"see table [3]"` warned `unknown-unit: [3]` and failed
    // --strict on a model that was clean before the body scan existed.
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const v = f.part('v', p.id);
    m.create('AttributeUsage', { declaredName: 'note', ownerId: v.id, attrs: { type: 'String', value: '"see table [3]"' } });
    m.create('AttributeUsage', { declaredName: 'label', ownerId: v.id, attrs: { value: "'row [x]'" } });
    m.create('AttributeUsage', { declaredName: 'id', ownerId: v.id, attrs: { value: '"R-UAV-001 [rev A]"' } });
    // An escaped quote inside the string ends the lexer's string token early
    // and leaves the regex fallback an unpaired quote before `[b]`; the rule
    // skips a quoted VALUE outright, so this is still text.
    m.create('AttributeUsage', { declaredName: 'quoted', ownerId: v.id, attrs: { value: '"a \\" [b]"' } });
    m.create('AttributeUsage', { declaredName: 'n', ownerId: v.id, attrs: { type: 'Real', value: 1.0 } });
    m.create('ConstraintUsage', { declaredName: 'c', ownerId: v.id, attrs: { expression: 'n > 0.0 and "x [zz]" == "x [zz]"' } });
    expect(runRule(m, 'unknown-unit')).toHaveLength(0);
    // A unit OUTSIDE the string in the same body is still read.
    m.create('ConstraintUsage', { declaredName: 'c2', ownerId: v.id, attrs: { expression: 'n > 0.0 [furlong] and "x [zz]" == "x [zz]"' } });
    const diags = runRule(m, 'unknown-unit');
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('[furlong]');
  });
});

describe('rule 17 — derived-dimension-mismatch', () => {
  function withDerived(type: string, value: string) {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const v = f.part('v', p.id);
    m.create('AttributeUsage', { declaredName: 'mtow', ownerId: v.id, attrs: { type: 'ISQ::MassValue', value: 18.5, unit: 'kg' } });
    m.create('AttributeUsage', { declaredName: 'derived', ownerId: v.id, attrs: { type, value } });
    return m;
  }

  it('positive: a derivation whose dimension matches the declared kind, or is a true ratio', () => {
    expect(runRule(withDerived('ISQ::MassValue', 'mtow * 2.0'), 'derived-dimension-mismatch')).toHaveLength(0);
    expect(runRule(withDerived('Real', 'mtow / 25.0 [kg]'), 'derived-dimension-mismatch')).toHaveLength(0);
    expect(runRule(withDerived('Real', '2.0 * 3.0'), 'derived-dimension-mismatch')).toHaveLength(0);
  });

  it('negative: a Real derived from a mass, and a DurationValue derived from a mass', () => {
    const real = runRule(withDerived('Real', 'mtow / 25.0'), 'derived-dimension-mismatch');
    expect(real).toHaveLength(1);
    expect(real[0].severity).toBe('warning');
    expect(real[0].message).toMatch(/typed "Real".*dimension M/);
    const kind = runRule(withDerived('ISQ::DurationValue', 'mtow * 2.0'), 'derived-dimension-mismatch');
    expect(kind).toHaveLength(1);
    expect(kind[0].message).toMatch(/declared kind "ISQ::DurationValue" is T/);
  });
});

describe('rule 18 — unwritable-note-body', () => {
  /** A package holding one annotation with the given body. */
  function withBody(eClass: 'Documentation' | 'Comment' | 'TextualRepresentation', body: string) {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    m.create(eClass, { ownerId: p.id, attrs: { body } });
    return m;
  }

  it('positive: an ordinary note body, and one that merely contains a slash, are fine', () => {
    expect(runRule(withBody('Documentation', 'the mass shall be under 25 kg'), 'unwritable-note-body')).toHaveLength(0);
    expect(runRule(withBody('Comment', 'see /* the note above'), 'unwritable-note-body')).toHaveLength(0);
  });

  it('negative: a body carrying the note terminator is reported on every note kind', () => {
    for (const eClass of ['Documentation', 'Comment', 'TextualRepresentation'] as const) {
      const diags = runRule(withBody(eClass, `a ${NOTE_BODY_TERMINATOR} b`), 'unwritable-note-body');
      expect(diags, eClass).toHaveLength(1);
      expect(diags[0].severity).toBe('error');
      expect(diags[0].elementId).toBeDefined();
    }
  });

  it('negative: a requirement statement carrying it is reported too', () => {
    // `attrs.text` is a second, unescaped doc-emitting site — the grid and the
    // Properties panel both write it, and the serializer turns it into a `doc`
    // line of its own.
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const r = f.requirement('R', p.id);
    m.setAttrs(r.id, { text: `mass <= 25 kg ${NOTE_BODY_TERMINATOR} satisfy R by V; doc /*` });
    const diags = runRule(m, 'unwritable-note-body');
    expect(diags).toHaveLength(1);
    expect(diags[0].elementId).toBe(r.id);
  });

  it('says nothing about an `attrs.text` on something that is not a requirement', () => {
    // Only a requirement's text is written as a note; on anything else the key
    // is not this rule's business, and flagging it would be a false report.
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const a = f.partDef('A', p.id);
    m.setAttrs(a.id, { text: `a ${NOTE_BODY_TERMINATOR} b` });
    expect(runRule(m, 'unwritable-note-body')).toHaveLength(0);
  });
});

describe('rule 19 — stale-evidence', () => {
  /**
   * A requirement carrying one evidence carrier whose record names `graph`.
   *
   * Built rather than parsed, in the style of the rest of this file: the rule
   * reads the model graph, and a carrier is four `create` calls. The record is
   * the minimum a reader of it needs — `schema` is what tells the reader this
   * is one at all, and `modelVersion.graph` is the whole comparison.
   */
  function withEvidence(graph: string) {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const v = f.part('vehicle', p.id);
    const r = f.requirement('massLimit', p.id);
    m.create('SubjectMembership', { ownerId: r.id, source: [r.id], target: [v.id] });
    const carrier = m.create('MetadataUsage', {
      ownerId: r.id,
      attrs: { annotation: true, type: 'SysproseVerification::Evidence' },
    });
    m.create('AttributeUsage', {
      declaredName: 'record',
      ownerId: carrier.id,
      attrs: {
        value: JSON.stringify(
          JSON.stringify({
            schema: 'sysprose-evidence/1',
            claim: 'holds-at-values',
            verdict: 'inconclusive',
            modelVersion: { graph },
          }),
        ),
      },
    });
    return { m, requirementId: r.id };
  }

  it('positive: a model with no evidence at all is not asked about', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const v = f.part('vehicle', p.id);
    const r = f.requirement('massLimit', p.id);
    m.create('SubjectMembership', { ownerId: r.id, source: [r.id], target: [v.id] });
    expect(runRule(m, 'stale-evidence')).toHaveLength(0);
  });

  it('positive: a record naming THIS model’s digest is current', () => {
    // The digest has to be taken from the model the carrier is already on: the
    // exclusion of what a verification run wrote is what makes that possible,
    // and a rule that computed it before the carrier existed would report every
    // freshly attached record as stale.
    const { m } = withEvidence('placeholder');
    const current = modelVersionOf(m).graph;
    const cell = m.all().find((el) => el.declaredName === 'record');
    m.setAttrs(cell!.id, {
      value: JSON.stringify(
        JSON.stringify({
          schema: 'sysprose-evidence/1',
          claim: 'holds-at-values',
          verdict: 'inconclusive',
          modelVersion: { graph: current },
        }),
      ),
    });
    expect(runRule(m, 'stale-evidence')).toHaveLength(0);
  });

  it('negative: a record over another model is a warning that NAMES the slice', () => {
    const { m, requirementId } = withEvidence(`sha256:${'0'.repeat(64)}`);
    const diags = runRule(m, 'stale-evidence');
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe('warning');
    expect(diags[0].elementId).toBe(requirementId);
    // The two halves of an honest finding: what to re-read, and what the tool
    // cannot tell you. A message that named neither would be a warning a reader
    // can do nothing with.
    expect(diags[0].message).toContain('P::vehicle');
    expect(diags[0].message).toContain('cannot say which of them moved');
  });

  it('negative: a stale obligation written BEFORE a current one still fires', () => {
    // A requirement may state several obligations, each with its own carrier.
    // Reading only the last carrier in file order missed a stale record whose
    // clause happened to be written first — and the file then passed `npm run
    // check` with a verdict reached over a model nobody has.
    const { m, requirementId } = withEvidence(`sha256:${'0'.repeat(64)}`);
    const first = m.all().find((el) => el.declaredName === 'record')!;
    // Distinguish the two obligations, or the second record supersedes the
    // first and there is nothing stale left to find.
    m.setAttrs(first.id, {
      value: JSON.stringify(
        JSON.stringify({
          schema: 'sysprose-evidence/1',
          claim: 'holds-at-values',
          verdict: 'inconclusive',
          obligation: { clause: 'P::massLimit::speedOk', obligationDigest: 'sha256:aa' },
          modelVersion: { graph: `sha256:${'0'.repeat(64)}` },
        }),
      ),
    });
    const second = m.create('MetadataUsage', {
      ownerId: requirementId,
      attrs: { annotation: true, type: 'SysproseVerification::Evidence' },
    });
    m.create('AttributeUsage', {
      declaredName: 'record',
      ownerId: second.id,
      attrs: {
        value: JSON.stringify(
          JSON.stringify({
            schema: 'sysprose-evidence/1',
            claim: 'holds-at-values',
            verdict: 'inconclusive',
            obligation: { clause: 'P::massLimit::massOk', obligationDigest: 'sha256:bb' },
            modelVersion: { graph: modelVersionOf(m).graph },
          }),
        ),
      },
    });
    const diags = runRule(m, 'stale-evidence');
    expect(diags, 'a stale obligation was hidden behind a current one').toHaveLength(1);
    expect(diags[0].message).toContain(`sha256:${'0'.repeat(64)}`);
  });

  it('says nothing when the SAME obligation was re-recorded over this model', () => {
    // Evidence accumulates, so a superseded record stays in the file. It is
    // history, not a live claim: reporting it would make re-recording an
    // obligation impossible to do without leaving a permanent warning behind.
    const { m, requirementId } = withEvidence(`sha256:${'0'.repeat(64)}`);
    const stale = m.all().find((el) => el.declaredName === 'record')!;
    const payload = (graph: string) =>
      JSON.stringify(
        JSON.stringify({
          schema: 'sysprose-evidence/1',
          claim: 'holds-at-values',
          verdict: 'inconclusive',
          obligation: { clause: 'P::massLimit::only', obligationDigest: 'sha256:aa' },
          modelVersion: { graph },
        }),
      );
    m.setAttrs(stale.id, { value: payload(`sha256:${'0'.repeat(64)}`) });
    const fresh = m.create('MetadataUsage', {
      ownerId: requirementId,
      attrs: { annotation: true, type: 'SysproseVerification::Evidence' },
    });
    m.create('AttributeUsage', {
      declaredName: 'record',
      ownerId: fresh.id,
      attrs: { value: payload(modelVersionOf(m).graph) },
    });
    expect(runRule(m, 'stale-evidence')).toHaveLength(0);
  });

  it('says nothing about a carrier whose payload it cannot read', () => {
    // A hand-written carrier, or one from a future schema, is a fact about the
    // file and not a reason to claim a verdict went stale — the rule has no
    // digest to compare and must not invent one.
    const { m } = withEvidence('placeholder');
    const cell = m.all().find((el) => el.declaredName === 'record');
    m.setAttrs(cell!.id, { value: '"not json at all"' });
    expect(runRule(m, 'stale-evidence')).toHaveLength(0);
  });

  /* ─────────────── the SCOPED comparison, with no solver in sight ─────────── */

  /**
   * A model with a premise, an axiom the proof reads, and one it cannot.
   *
   * Parsed rather than built, because a proof scope is a read-closure over
   * relation BODIES and the factory writes none. No units and no standard
   * library: everything here is about which digest moves, not about scale.
   */
  const SCOPED_SUBJECT = `package P {
    part def Vehicle {
        attribute mass : Real = 1500.0;
    }
    part vehicle : Vehicle;
    requirement massLimit {
        subject vehicle : Vehicle;
        assume constraint { vehicle.mass >= 0.0 }
        require constraint { vehicle.mass <= 2000.0 }
    }
    satisfy massLimit by vehicle;
}
`;

  async function parsed(text: string): Promise<Model> {
    const { model, report } = await loadModelText(text, {
      fileName: 'scoped.sysml',
      library: 'none',
    });
    expect(report.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message)).toEqual([]);
    return model!;
  }

  /**
   * The record a `verify --engine smt --record` run would have written over
   * `text`, with the scope it would have carried — HAND-BUILT, and that is the
   * point of these two cases.
   *
   * Every other test of the scoped comparison is a campaign case gated on a
   * solver being installed, and `withZ3` SKIPS rather than fails when none is.
   * A regression that collapsed the scoped rule back to the whole-model answer
   * would have gone unnoticed on any machine without z3. `proofScopeOf` needs no
   * solver — the scope is a function of the model — so the guard does not either.
   */
  async function scopedRecord(text: string) {
    const model = await parsed(text);
    const rows = obligationsOf(model);
    const row = rows.find((r) => r.role === 'obligation');
    expect(row, 'the fixture states one obligation').toBeDefined();
    return {
      schema: 'sysprose-evidence/1',
      claim: 'proved',
      verdict: 'pass',
      modelVersion: { graph: modelVersionOf(model).graph },
      obligation: {
        clause: row!.element.qualifiedName,
        obligationDigest: obligationDigest(row!),
      },
      proofScope: proofScopeOf(model, row!, { rows }),
    };
  }

  /** Put one record on `massLimit` of an already-parsed model. */
  function carry(model: Model, record: unknown): void {
    const req = model.all().find((el) => el.declaredName === 'massLimit');
    expect(req, 'the fixture declares `massLimit`').toBeDefined();
    const carrier = model.create('MetadataUsage', {
      ownerId: req!.id,
      attrs: { annotation: true, type: 'SysproseVerification::Evidence' },
    });
    model.create('AttributeUsage', {
      declaredName: 'record',
      ownerId: carrier.id,
      attrs: { value: JSON.stringify(JSON.stringify(record)) },
    });
  }

  it('is SILENT on an edit that moved the whole model and nothing the proof reads', async () => {
    const record = await scopedRecord(SCOPED_SUBJECT);
    // A declaration with no value states no axiom, so it enters no axiom set
    // and no read-closure — the whole-model digest is the only thing it moves.
    const edited = await parsed(
      SCOPED_SUBJECT.replace(
        '    part vehicle : Vehicle;',
        '    part def DataLink { attribute txPower : Real; }\n    part vehicle : Vehicle;',
      ),
    );
    carry(edited, record);
    expect(
      modelVersionOf(edited).graph,
      'the edit did not move the whole-model digest, so this case proves nothing',
    ).not.toBe(record.modelVersion.graph);
    expect(runRule(edited, 'stale-evidence')).toHaveLength(0);
  });

  it('REPORTS a premise edit, which no other conjunct can see', async () => {
    const record = await scopedRecord(SCOPED_SUBJECT);
    // The premise is not an axiom, is not in the footprint and is not the
    // goal — it is what STEP 2 asks about, and STEP 2 is what separates
    // `proved` from `vacuous`.
    const edited = await parsed(
      SCOPED_SUBJECT.replace('vehicle.mass >= 0.0', 'vehicle.mass >= 5000.0'),
    );
    carry(edited, record);
    const diags = runRule(edited, 'stale-evidence');
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('premises changed');
    expect(diags[0].message).toContain('scoped to what');
  });

  it('does not take the checker down over a carrier that names no obligation', async () => {
    // `recordOfCarrier` validates nothing beyond `schema`, so a hand-written
    // record reaches every reader as whatever JSON the file holds. A reader
    // that dereferenced `record.obligation.clause` threw inside `loadModelText`
    // — which discards the MODEL and every real diagnostic with it, and in the
    // browser store is swallowed whole and returns no diagnostics at all.
    const text = SCOPED_SUBJECT.replace(
      '    satisfy massLimit by vehicle;',
      '    satisfy massLimit by vehicle;',
    );
    const model = await parsed(text);
    carry(model, {
      schema: 'sysprose-evidence/1',
      claim: 'proved',
      verdict: 'pass',
      modelVersion: { graph: `sha256:${'0'.repeat(64)}` },
      proofScope: 'nonsense',
    });
    const { model: reloaded, report } = await loadModelText(
      model
        .rootIds()
        .filter((id) => model.get(id)?.attrs.isLibrary !== true)
        .map((id) => serializeElement(model, id, 0))
        .join('\n\n'),
      { fileName: 'partial.sysml', library: 'none' },
    );
    expect(report.diagnostics.map((d) => d.code)).not.toContain('import/internal-error');
    expect(reloaded, 'the model was discarded over one hand-written line').toBeDefined();
    expect(report.elements.count).toBeGreaterThan(0);
    // The record is unreadable as a scope, so the comparison falls back to the
    // whole model — which it fails, loudly, rather than silently.
    expect(report.diagnostics.map((d) => d.code)).toContain('validation/stale-evidence');
    expect(report.evidenceScope?.[0]).toMatchObject({ scoped: false, clause: '' });
  });
});

describe('validate() aggregation & ordering', () => {
  it('sorts diagnostics with errors before warnings', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    // a warning: requirement without subject
    f.requirement('Naked', p.id);
    // an error: blank-named element
    m.create('PartUsage', { declaredName: '  ', ownerId: p.id });
    const diags = validate(m);
    expect(diags.length).toBeGreaterThanOrEqual(2);
    expect(diags[0].severity).toBe('error');
    expect(diags[diags.length - 1].severity).toBe('warning');
    expect(isValid(m)).toBe(false);
  });

  it('honours the ruleIds subset selection', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    f.requirement('Naked', p.id);
    m.create('PartUsage', { declaredName: '  ', ownerId: p.id });
    const only = validate(m, { ruleIds: ['blank-name'] });
    expect(only.every((d) => d.ruleId === 'blank-name')).toBe(true);
    expect(only.length).toBe(1);
  });

  it('honours excludeRuleIds', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    f.requirement('Naked', p.id);
    const diags = validate(m, { excludeRuleIds: ['requirement-subject'] });
    expect(diags.every((d) => d.ruleId !== 'requirement-subject')).toBe(true);
  });

  it('assigns unique diagnostic ids', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    f.partDef('Dup', p.id);
    f.partDef('Dup', p.id);
    const ids = validate(m).map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/**
 * (15b) A target over a valueless measure, read once per context through the
 * feature that specialises the measure there: one finding per context, at the
 * specialiser — a miss a warning, a met or unreadable one info.
 */
const BRIEF_TARGETS = `package B {
  package Common {
    attribute m : ScalarValues::Real;
    require constraint t { m >= 0.9 }
  }
  package LA {
    attribute fleet = 12;
    attribute share = 0.05;
    attribute m :> Common::m;
    assert constraint { m == fleet * share }
  }
  package PA {
    attribute m :> Common::m = 0.95;
  }
}`;

describe('validation — target-by-specialisation', () => {
  const parsed = (src: string): Model => parseModel(src).model;
  const named = (m: Model, qualified: string) => m.all().find((e) => m.qualifiedName(e.id) === qualified)!;

  it('reports one finding per context, at the specialiser: a miss is a warning, a met target info', () => {
    const m = parsed(BRIEF_TARGETS);
    const diags = runRule(m, 'target-by-specialisation');
    expect(diags.map((d) => [d.severity, d.elementId, d.message])).toEqual([
      ['warning', named(m, 'B::LA::m').id, 'LA::m = 0.6 misses Common::t (m >= 0.9)'],
      ['info', named(m, 'B::PA::m').id, 'PA::m = 0.95 meets Common::t (m >= 0.9)'],
    ]);
  });

  it('keeps the target’s own constraint-violation info, with the message that says why', () => {
    const m = parsed(BRIEF_TARGETS);
    const own = validate(m).filter((d) => d.ruleId === 'constraint-violation');
    expect(own).toHaveLength(1);
    expect(own[0].severity).toBe('info');
    expect(own[0].message).toBe(
      'Constraint could not be evaluated ("m >= 0.9"): Could not evaluate: m has no value here; ' +
        'evaluated per specialisation: LA::m, PA::m.',
    );
  });

  it('reports an unreadable context as info, and nothing for a target nothing specialises', () => {
    const m = parsed(`package Common { attribute m : Real; constraint t { m >= 0.9 } attribute b : Real; constraint u { b <= 1 } }
      package PA { attribute x :> Common::m = 0.5; attribute y :> Common::m = 0.95; }`);
    const diags = runRule(m, 'target-by-specialisation');
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe('info');
  });

  it('anchors a miss no binding carries at its own element, not at a line a definition shares (nb12)', () => {
    // The first value the row shows is P2's `load = 5.0`, which every P2 states: the finding points at q2's p
    // (the element of its own), naming nothing; where that value is q2's own redefinition, it stays there.
    const head = `package GG {
      part def P { attribute load : ScalarValues::Real default = 1.0; attribute extra : ScalarValues::Real default = 0.0; }
      part def P2 :> P { attribute :>> load = 5.0; }
      part def Q { part p : P { constraint c2 { load + extra <= 10.0 } } }
      part q1 : Q;`;
    const shared = parsed(`${head} part q2 : Q { part :>> p : P2 { attribute :>> extra = 12.0; } } }`);
    const p = shared.all().find((e) => e.ownerId === named(shared, 'GG::q2').id && e.eClass === 'PartUsage')!;
    expect(runRule(shared, 'target-by-specialisation').map((d) => [d.elementId, d.message])).toEqual([
      [p.id, 'P2::load = 5, p::extra = 12 misses p::c2 (load + extra <= 10.0)'],
    ]);
    const own = parsed(`${head} part q2 : Q { part :>> p { attribute :>> extra = 12.0; } } }`);
    const diags = runRule(own, 'target-by-specialisation');
    expect(diags).toHaveLength(1);
    expect(own.get(diags[0].elementId!)?.eClass).toBe('AttributeUsage');
    expect(diags[0].message).toBe('p::extra = 12 misses p::c2 (load + extra <= 10.0)');
  });

  it('is silent for a #prose target, as constraint-violation is', () => {
    const m = parsed(`package Common { attribute m : Real; #prose constraint t { m >= 0.9 } }
      package LA { attribute m :> Common::m = 0.5; }`);
    expect(runRule(m, 'target-by-specialisation')).toEqual([]);
  });

  it('runs inside validate under its own code, after the sweep constraint-violation took', async () => {
    const { diagnostics } = (await loadModelText(BRIEF_TARGETS)).report;
    const ours = diagnostics.filter((d) => d.code === 'validation/target-by-specialisation');
    expect(ours.map((d) => d.severity)).toEqual(['warning', 'info']);
    // Anchored at the estimate's line, not the target's.
    expect(ours.map((d) => d.range?.start.line)).toEqual([9, 13]);
  });

  it('re-anchors a context row sitting on an implicit specialiser (H6a)', () => {
    const m = parsed(`package H2P {
      part def P {
        attribute load : ScalarValues::Real default = 1.0;
        attribute m2 : ScalarValues::Real = 10.0 - load;
        constraint c { load <= 10.0 }
      }
      part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
      part q : Q { attribute :>> L = 50.0; }
    }`);
    // The generic row is constraint-by-instance's (PI-5): this rule leaves the group's rows to it.
    expect(runRule(m, 'target-by-specialisation')).toEqual([]);
    const diags = runRule(m, 'constraint-by-instance');
    expect(diags.length).toBeGreaterThan(0);
    for (const d of diags) {
      expect(d.elementId, d.message).toBeDefined();
      expect(m.get(d.elementId!)?.attrs.implicit, d.message).not.toBe(true);
    }
  });

  it('folds more than 20 contexts of one relation into one finding per result', () => {
    const pkgs = Array.from({ length: 25 }, (_, i) => `package P${i} { attribute m :> Common::m = ${((i % 8) + 1) / 10}; }`).join('\n');
    const m = parsed(`package Common { attribute m : Real; constraint t { m >= 0.9 } }\n${pkgs}`);
    const diags = runRule(m, 'target-by-specialisation');
    // One folded finding per result — every P<i> misses (0.x < 0.9), so one warning.
    expect(diags).toHaveLength(1);
    expect(diags[0]!.severity).toBe('warning');
    expect(diags[0]!.message).toMatch(/25 of 25 contexts miss the target/);
    expect(diags[0]!.message).toMatch(/P0/);
  });
});

describe('validation — constraint-by-instance (the 27th rule)', () => {
  const parsed = (src: string): Model => parseModel(src).model;

  it('is registered with its own id and code suffix', () => {
    expect(RULES_BY_ID.has('constraint-by-instance')).toBe(true);
    expect(RULES.map((r) => r.id)).toContain('constraint-by-instance');
    expect(RULES.findIndex((r) => r.id === 'target-by-specialisation')).toBeLessThan(
      RULES.findIndex((r) => r.id === 'constraint-by-instance'),
    );
  });

  it('takes the sweep constraint-violation swept, after target-by-specialisation', () => {
    const m = parsed(BRIEF_TARGETS);
    const own = runRule(m, 'constraint-violation');
    const bySpec = runRule(m, 'target-by-specialisation');
    const byInstance = runRule(m, 'constraint-by-instance');
    expect(own.length).toBeGreaterThan(0);
    expect(bySpec.length).toBeGreaterThan(0);
    // F4: no reading carries `via` or `instance` yet, so the 27th rule is quiet.
    expect(byInstance).toEqual([]);
  });
});

describe('validation — transition-in-parallel-state (the 29th rule)', () => {
  const PARALLEL = `package P {
    state def Modes parallel {
      state nav { state off; state on; transition off accept go then on; }
      state comms { state idle; state busy; transition idle accept send then busy; }
      transition nav.off accept hop then comms.idle;
    }
  }`;

  it('is registered last, after every rule whose ordinal a document names', () => {
    expect(RULES_BY_ID.has('transition-in-parallel-state')).toBe(true);
    expect(RULE_IDS.indexOf('transition-in-parallel-state')).toBe(28);
    expect(RULES.findIndex((r) => r.id === 'constraint-by-instance')).toBeLessThan(RULES.length - 5);
  });

  it('refuses a transition between two concurrent substates, and is silent within one region or without `parallel`', async () => {
    const m = parseModel(PARALLEL).model;
    const diags = runRule(m, 'transition-in-parallel-state');
    // The `off -> on` and `idle -> busy` steps stay inside their own region;
    // only `nav.off -> comms.idle` crosses the two.
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe('error');
    expect(diags[0].ruleId).toBe('transition-in-parallel-state');
    expect(diags[0].message).toContain('§7.18.2');
    expect(diags[0].message).toContain('Modes');
    expect(diags[0].elementId).toBeDefined();
    // The exclusive twin is the same machine without `parallel`: the same step is legal there.
    const exclusive = parseModel(PARALLEL.replace(' parallel {', ' {')).model;
    expect(runRule(exclusive, 'transition-in-parallel-state')).toEqual([]);
    // The step is a violation wherever it is WRITTEN: a transition at the
    // enclosing machine's level whose endpoints lie in two regions of the
    // parallel state joins the same pair (§7.18.2 does not qualify the position).
    const outside = parseModel(`package P {
      part def Ctl {
        state def Top {
          state M parallel { state a; state b; }
          transition M::a accept x then M::b;
        }
      }
    }`).model;
    const outsideDiags = runRule(outside, 'transition-in-parallel-state');
    expect(outsideDiags).toHaveLength(1);
    expect(outsideDiags[0].severity).toBe('error');
    expect(outsideDiags[0].message).toContain('M');
    // Through the text pipeline the finding carries its catalogue code and a range.
    const loaded = await loadModelText(PARALLEL, { library: 'none' });
    const finding = loaded.report.diagnostics.find((d) => d.code === 'validation/transition-in-parallel-state')!;
    expect(finding.severity).toBe('error');
    expect(finding.range).toBeDefined();
  });
});

describe('BD5 connector-end-multiplicity', () => {
  const run = async (body: string) => {
    const r = await loadModelText(`package P { ${body} }`);
    return runRule(r.model!, 'connector-end-multiplicity').map((d) => d.message);
  };
  it('flags an end multiplicity above the connected part', async () => {
    const w = await run('part def W; part def H; part def S { part wheels : W [4]; part hub : H; connection c connect [5] wheels to [1] hub; }');
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('wheels');
    expect(await run('part def W; part def H; part def S { part a : W [2]; part b : H [3]; connection c connect a to [4] b; }')).toHaveLength(1);
  });
  it('flags a usage end above the definition end, and many parts on a one-instance end', async () => {
    const d = 'part def W; part def H; connection def DC { end [0..2] part device : W; end [1] part hub : H; }';
    expect(await run(`${d} part def S { part ds : W [4]; part hub : H; connection c : DC connect [3] device ::> ds to hub; }`)).toHaveLength(1);
    expect(await run(`${d} part def S { part ds : W [3]; part hub : H; connection c : DC connect ds to hub; }`)).toHaveLength(1);
  });
  it('is silent on legal look-alikes', async () => {
    const d = 'part def W; part def H; connection def DC { end [0..4] part device : W; end [1] part hub : H; }';
    expect(await run('part def W; part def H; part def S { part wheels : W [4]; part hub : H; connection c connect [4] wheels to [1] hub; connection e connect [1..4] wheels to hub; }')).toEqual([]);
    expect(await run(`${d} part def S { part ds : W [4]; part hub : H; connection c : DC connect [2] device ::> ds to hub; }`)).toEqual([]);
    expect(await run(`${d} part def S { part ds : W [3]; part hub : H [2]; connection c : DC connect ds to hub; }`)).toEqual([]);
    expect(await run('part def W; part def S { part a : W [2]; part b : W [3]; connection c connect a to b; }')).toEqual([]);
  });
  it('reads the list form and the end-body form', async () => {
    const d = 'part def W; part def H; connection def DC { end [0..2] part device : W; end [1] part hub : H; }';
    // list form: cross multiplicity above the part, and a usage above the definition end
    expect(await run('part def W; part def H; part def S { part wheels : W [4]; part hub : H; connection c connect ([5] wheels, [1] hub); }')).toHaveLength(1);
    expect(await run(`${d} part def S { part ds : W [4]; part hub : H; connection c : DC connect ([3] device ::> ds, hub ::> hub); }`)).toHaveLength(1);
    expect(await run('part def W; part def H; part def S { part wheels : W [4]; part hub : H; connection c connect ([4] wheels, [1] hub); }')).toEqual([]);
    expect(await run(`${d} part def S { part ds : W [4]; part hub : H; connection c : DC connect ([2] device ::> ds, hub ::> hub); }`)).toEqual([]);
    // end bodies: above the part, above the definition end, and the legal look-alikes
    expect(await run('part def W; part def H; part def S { part ws : W [4]; part hub : H; connection c { end [5] part a references ws; end [1] part b references hub; } }')).toHaveLength(1);
    expect(await run(`${d} part def S { part ds : W [4]; part hub : H; connection c : DC { end [3] part device references ds; end part hub references hub; } }`)).toHaveLength(1);
    expect(await run('part def W; part def H; part def S { part ws : W [4]; part hub : H; connection c { end [4] part a references ws; end [1] part b references hub; } }')).toEqual([]);
    expect(await run(`${d} part def S { part ds : W [4]; part hub : H; connection c : DC { end [2] part device references ds; end part hub references hub; } }`)).toEqual([]);
    // a post-name multiplicity on a usage end is the end's own (not a cross multiplicity): an end must be 1..1 (conn-chains C2)
    const own = await run('part def W; part def H; part def S { part ws : W [4]; part hub : H; connection c { end part a [9] references ws; end part b references hub; } }');
    expect(own).toHaveLength(1);
    expect(own[0]).toContain('1..1');
    expect(await run('part def W; part def H; part def S { part ws : W [4]; part hub : H; connection c { end part a [0..1] references ws; end part b references hub; } }')).toHaveLength(1);
    expect(await run('part def W; part def H; part def S { part ws : W [4]; part hub : H; connection c { end part a [1] references ws; end part b [1] references hub; } }')).toEqual([]);
    expect(await run('part def W; part def H; part def S { part ws : W [4]; part hub : H; connection c { end [4] part a [1] references ws; end part b references hub; } }')).toEqual([]);
    // three ends in a list are read end by end (conn-nary; they were a syntax error, nothing checked, before)
    expect(await run('part def W; part def S { part a : W [2]; part b : W; part c : W; connection d connect ([9] a, b, c); }')).toHaveLength(1);
    expect(await run('part def W; part def S { part a : W [2]; part b : W; part c : W; connect (a, b, c); }')).toEqual([]);
  });
  it('reads a body of three or more ends end by end, and a many-instance other end (n-ary, C2)', async () => {
    const pre = 'part def W; part def H; part def G;';
    // n-ary: an end above its own part, and a usage above the definition end, on the third end
    expect(await run(`${pre} part def S { part a : W [2]; part b : H; part g : G [2]; connection c { end part x references a; end part y references b; end [3] part z references g; } }`)).toHaveLength(1);
    const d = `${pre} connection def T { end part x : W; end part y : H; end [0..1] part z : G; }`;
    expect(await run(`${d} part def S { part a : W; part b : H; part g : G; connection c : T { end part x references a; end part y references b; end [2] part z references g; } }`)).toHaveLength(1);
    // no cross multiplicity: three parts on a [0..1] end with all other ends single
    expect(await run(`${d} part def S { part a : W; part b : H; part g : G [3]; connection c : T { end part x references a; end part y references b; end part z references g; } }`)).toHaveLength(1);
    // legal n-ary: within the part, and the other ends are many enough to take the instances
    expect(await run(`${pre} part def S { part a : W [2]; part b : H; part g : G [2]; connection c { end [2] part x references a; end part y references b; end [2] part z references g; } }`)).toEqual([]);
    expect(await run(`${d} part def S { part a : W [2]; part b : H; part g : G [2]; connection c : T { end part x references a; end part y references b; end part z references g; } }`)).toEqual([]);
    // C2: the other end has several instances; 4 parts on a [0..2] end need more than 2 tuples when the other has 1..1, 2 tuples suffice
    const e = `${pre} connection def U { end [0..2] part x : W; end part y : H; }`;
    expect(await run(`${e} part def S { part a : W [5]; part b : H [2]; connection c : U connect a to b; }`)).toHaveLength(1);
    expect(await run(`${e} part def S { part a : W [4]; part b : H [2]; connection c : U connect a to b; }`)).toEqual([]);
    expect(await run(`${e} part def S { part a : W [5]; part b : H [0..*]; connection c : U connect a to b; }`)).toEqual([]);
  });
  it('reads the list form of three or more ends end by end, maps it to owned ends and round-trips it (conn-nary)', async () => {
    const pre = 'part def W; part def H; part def G;';
    expect(await run(`${pre} part def S { part a : W [2]; part b : H; part g : G [2]; connection c connect ([2] a, b, [3] g); }`)).toHaveLength(1);
    expect(await run(`${pre} part def S { part a : W [2]; part b : H; part g : G [2]; connection c connect ([2] a, b, [2] g); }`)).toEqual([]);
    // the definition end named on an end narrows or exceeds it
    const d = `${pre} connection def T { end part x : W; end part y : H; end [0..1] part z : G; }`;
    expect(await run(`${d} part def S { part a : W; part b : H; part g : G [2]; connection c : T connect (x ::> a, y ::> b, [2] z ::> g); }`)).toHaveLength(1);
    expect(await run(`${d} part def S { part a : W; part b : H; part g : G [2]; connection c : T connect (x ::> a, y ::> b, [1] z ::> g); }`)).toEqual([]);
    // the model: three owned ends, each with a reference subsetting and its cross multiplicity; no source/target
    const src = `package P { ${pre} part def S { part a : W [2]; part b : H; part g : G [2]; connection c connect ([2] a, b, [2] g); } }`;
    const r = await loadModelText(src, { library: 'none' });
    const c = r.model!.all().find((e) => e.declaredName === 'c')!;
    const ends = r.model!.children(c.id).filter((e) => e.attrs.isEnd === true);
    expect(ends).toHaveLength(3);
    expect(ends.map((e) => e.attrs.endCrossMult)).toEqual(['2', undefined, '2']);
    expect(ends.every((e) => r.model!.relationshipsFrom(e.id).some((x) => x.eClass === 'ReferenceSubsetting'))).toBe(true);
    const text = serializeModel(r.model!);
    expect(text).toContain('connect ([2] a, b, [2] g)');
    expect(serializeModel((await loadModelText(text, { library: 'none' })).model!)).toBe(text);
    // an end given as a feature chain resolves and round-trips (L3)
    const ch = await loadModelText('part def W { port p; } part def S { part a : W; part b : W; part c : W; connection d connect (a.p, b.p, c.p); }', { library: 'none' });
    const cht = serializeModel(ch.model!);
    expect(cht).toContain('connect (a.p, b.p, c.p)');
    expect(serializeModel((await loadModelText(cht, { library: 'none' })).model!)).toBe(cht);
    // the bare statement form, no multiplicities, maps and round-trips too
    const bare = await loadModelText('part def W; part def S { part a : W; part b : W; part c : W; connect (a, b, c); }', { library: 'none' });
    const bt = serializeModel(bare.model!);
    expect(bt).toContain('connect (a, b, c)');
    expect(serializeModel((await loadModelText(bt, { library: 'none' })).model!)).toBe(bt);
    // two ends stay the binary mapping
    const two = await loadModelText('part def W; part def S { part a : W; part b : W; connection c connect (a, b); }', { library: 'none' });
    const c2 = two.model!.all().find((e) => e.declaredName === 'c')!;
    expect(c2.source).toHaveLength(1);
    expect(two.model!.children(c2.id).filter((e) => e.attrs.isEnd === true)).toHaveLength(0);
  });
  it('checks a chain end in a list, a body and the binary form against the usage-scoped feature (conn-chains C1)', async () => {
    const w = 'part def H; part def W { part p : H [4]; } part def S { part a : W; part hub : H; part g : H; ';
    for (const c of [
      'connection c connect [5] a.p to hub;',
      'connection c connect ([5] a.p, hub, g);',
      'connection c { end [5] part x references a.p; end part y references hub; }',
      'connection c { end [5] part x references a.p; end part y references hub; end part z references g; }',
    ]) expect(await run(`${w}${c} }`), c).toHaveLength(1);
    for (const c of [
      'connection c connect [4] a.p to hub;',
      'connection c connect ([4] a.p, hub, g);',
      'connection c { end [4] part x references a.p; end part y references hub; end part z references g; }',
      // unresolved chain: unchecked
      'connection c connect ([5] a.nope, hub, g);',
      'connection c connect ([5] nowhere.p, hub, g);',
    ]) expect(await run(`${w}${c} }`), c).toEqual([]);
    // a many-instance part on the way: the chain holds the product of the multiplicities (conn-ends2 E2), 3 x 4 = 12
    expect(await run('part def H; part def W { part p : H [4]; } part def S { part a : W [3]; part hub : H; part g : H; connection c connect ([5] a.p, hub, g); }')).toEqual([]);
    // the path as written round-trips
    const r = await loadModelText(`package P { ${w}connection c connect ([4] a.p, hub, g); } }`, { library: 'none' });
    const t = serializeModel(r.model!);
    expect(t).toContain('connect ([4] a.p, hub, g)');
    expect(serializeModel((await loadModelText(t, { library: 'none' })).model!)).toBe(t);
    const b = await loadModelText(`package P { ${w}connection c { end part x references a.p; end part y references hub; end part z references g; } } }`, { library: 'none' });
    const bt = serializeModel(b.model!);
    expect(bt).toContain('::> a.p');
    expect(serializeModel((await loadModelText(bt, { library: 'none' })).model!)).toBe(bt);
  });
  it('checks a chain through a many-instance part against the product of the multiplicities (conn-ends2 E2)', async () => {
    const w = (a: string, p: string, c: string) => `part def H; part def W { part p : H ${p}; } part def S { part a : W ${a}; part hub : H; ${c} }`;
    // 3 x 2 = 6 values of a.p: a cross multiplicity of 7 is more than the chain holds, 6 is not
    expect(await run(w('[3]', '[2]', 'connection c connect [7] a.p to hub;'))).toHaveLength(1);
    expect(await run(w('[3]', '[2]', 'connection c connect ([7] a.p, hub);'))).toHaveLength(1);
    expect(await run(w('[3]', '[2]', 'connection c { end [7] part x references a.p; end part y references hub; }'))).toHaveLength(1);
    expect(await run(w('[3]', '[2]', 'connection c connect [6] a.p to hub;'))).toEqual([]);
    expect(await run(w('[3]', '[2]', 'connection c connect [1..6] a.p to hub;'))).toEqual([]);
    // an unbounded factor, or one that is not a literal, leaves it unchecked
    expect(await run(w('[3]', '[*]', 'connection c connect [70] a.p to hub;'))).toEqual([]);
    expect(await run(w('[0..*]', '[2]', 'connection c connect [70] a.p to hub;'))).toEqual([]);
    expect(await run(w('[n]', '[2]', 'connection c connect [70] a.p to hub;'))).toEqual([]);
  });
  it('judges the ends a connection definition owns by the 1..1 rule, an inherited one where owned (conn-ends2 E1)', async () => {
    const d = (body: string) => `part def W; part def H; ${body}`;
    // §7.13.2: a definition's end features must have multiplicity 1..1 too; the cross multiplicity goes before the keyword
    const own = await run(d('connection def DC { end part device [0..2] : W; end part hub : H; }'));
    expect(own).toHaveLength(1);
    expect(own[0]).toContain('1..1');
    expect(await run(d('interface def IC { end ref a [3] : W; end ref b : H; }'))).toHaveLength(1);
    expect(await run(d('connection def DC { end [0..2] part device : W; end part hub [1] : H; end part x : H; }'))).toEqual([]);
    // inherited: flagged once, on the definition that writes it, not on the one that specialises it
    expect(await run(d('connection def DC { end part device [0..2] : W; end part hub : H; } connection def DD :> DC { }'))).toHaveLength(1);
    expect(await run(d('connection def DC { end [0..2] part device : W; end part hub : H; } connection def DD :> DC { }'))).toEqual([]);
  });
  it('is silent on an n-ary list whose end does not resolve, and connector-endpoints is silent on it', async () => {
    const pre = 'part def W; part def S { part a : W [2]; part b : W; ';
    expect(await run(`${pre}connection c connect ([2] a, b, nowhere); }`)).toEqual([]);
    const r = await loadModelText(`${pre}connection c connect ([2] a, b, a); }`, { library: 'none' });
    expect(runRule(r.model!, 'connector-endpoints')).toEqual([]);
  });
  it('reads end [m] before the keyword on a definition end like end part x [m]', async () => {
    const d = (end: string) => `part def W; part def H; connection def DC { ${end} end part hub : H [1]; }`;
    const use = 'part def S { part ds : W [3]; part hub : H; connection c : DC connect ds to hub; }';
    expect(await run(`${d('end [0..2] part device : W;')} ${use}`)).toHaveLength(1);
    expect(await run(`${d('end [0..2] part device : W;')} ${use}`)).toHaveLength(1);
    expect(await run(`${d('end [0..4] part device : W;')} ${use}`)).toEqual([]);
  });
  it('round-trips the list form and the end multiplicity before the keyword', async () => {
    const src = 'package P { part def W; connection def DC { end [0..2] part device : W; end [1..*] ordered part hub : W; } part def S { part a : W [4]; part b : W; connection c : DC connect ([2] device ::> a, hub ::> b); connection d : DC { end [1] part device references a; end [0..4] part hub references b; } } }';
    const r = await loadModelText(src);
    const c = r.model!.all().find((e) => e.declaredName === 'c')!;
    expect(c.attrs.sourceCrossMult).toBe('2');
    expect(r.model!.all().find((e) => e.declaredName === 'device' && e.attrs.endCrossMult === '0..2')).toBeDefined();
    const text = serializeModel(r.model!);
    expect(text).toContain('end [0..2] part device');
    expect(text).toContain('end [1..*] ordered part hub');
    expect(text).toContain('connect [2] device ::> a to hub ::> b');
    expect(text).toContain('end [1] part device ::> a');
    const bare = serializeModel((await loadModelText(src, { library: 'none' })).model!);
    expect(serializeModel((await loadModelText(bare, { library: 'none' })).model!)).toBe(bare);
  });
  it('maps and round-trips the end multiplicity', async () => {
    const src = 'package P { part def W; part def S { part a : W [4]; part b : W; connection c connect [2] a to [1] b; connection d connect [3] x ::> a to b; } }';
    const r = await loadModelText(src);
    const c = r.model!.all().find((e) => e.declaredName === 'c')!;
    expect(c.attrs.sourceCrossMult).toBe('2');
    expect(c.attrs.targetCrossMult).toBe('1');
    const text = serializeModel(r.model!);
    expect(text).toContain('connect [2] a to [1] b');
    expect(text).toMatch(/connect \[3\] x ::> a to b/);
  });
});
