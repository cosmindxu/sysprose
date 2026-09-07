import { describe, it, expect } from 'vitest';
import { Model, ModelFactory, buildSampleModel } from '@core/index';
import type { ElementRecord, SerializedModel } from '@core/index';
import { validate, isValid, RULES, RULE_IDS, RULES_BY_ID } from '@validation/index';
import { loadStandardLibrary } from '../../src/library/index';
import { modelVersionOf } from '@api/index';
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
  it('exposes all 25 documented rules with unique ids', () => {
    expect(RULES.length).toBe(25);
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

  it('negative: two siblings with the same name are flagged', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    f.partDef('Dup', p.id);
    f.partDef('Dup', p.id);
    const diags = runRule(m, 'duplicate-name');
    expect(diags).toHaveLength(2);
    expect(diags[0].ruleId).toBe('duplicate-name');
    expect(diags[0].severity).toBe('error');
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
   * `effectiveFeatures` resolves redefinition by name: a feature the usage
   * declares itself hides the same-named feature it would otherwise inherit
   * (`src/semantics/inheritance.ts`:71). So a usage that re-uses the subject's
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
