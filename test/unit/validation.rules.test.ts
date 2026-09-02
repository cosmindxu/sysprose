import { describe, it, expect } from 'vitest';
import { Model, ModelFactory, buildSampleModel } from '@core/index';
import type { SerializedModel } from '@core/index';
import { validate, isValid, RULES, RULE_IDS, RULES_BY_ID } from '@validation/index';

/** Run a single rule in isolation and return its diagnostics. */
function runRule(model: Model, ruleId: string) {
  const rule = RULES_BY_ID.get(ruleId);
  if (!rule) throw new Error(`unknown rule ${ruleId}`);
  return rule.run(model);
}

describe('validation registry', () => {
  it('exposes all 12 documented rules with unique ids', () => {
    expect(RULES.length).toBeGreaterThanOrEqual(12);
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
