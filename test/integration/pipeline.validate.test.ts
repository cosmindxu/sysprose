/**
 * Pipeline integration — Parse → Validate.
 *
 * Proves the text and validation modules compose: a model produced from clean
 * text yields zero error diagnostics, and once well-formedness violations are
 * injected (duplicate sibling name, malformed multiplicity, missing port
 * direction, dangling relationship endpoint) the checker reports each of them.
 */

import { describe, it, expect } from 'vitest';
import { Model, ModelFactory, buildSampleModel } from '@core/index';
import { parseModel, serializeModel } from '@text/index';
import { validate, isValid } from '@validation/index';

describe('pipeline: Parse → Validate (clean text)', () => {
  it('a clean parse validates with zero error diagnostics', () => {
    // Serialising the canonical sample yields error-free, re-parseable text.
    const cleanText = serializeModel(buildSampleModel());
    const { model, diagnostics } = parseModel(cleanText);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

    const findings = validate(model);
    expect(findings.filter((d) => d.severity === 'error')).toEqual([]);
    expect(isValid(model)).toBe(true);
  });
});

describe('pipeline: Parse → Validate (injected violations)', () => {
  /** Build a model carrying one instance of each targeted violation. */
  function buildBrokenModel(): Model {
    const m = new Model();
    const f = new ModelFactory(m);
    const pkg = f.pkg('Broken');

    // (1) duplicate sibling name.
    f.partDef('Dup', pkg.id);
    f.partDef('Dup', pkg.id);

    const host = f.part('host', pkg.id);

    // (2) malformed multiplicity ('1..2..3' is not 'n' / 'n..m' / 'n..*' / '*').
    m.create('AttributeUsage', {
      declaredName: 'badMult',
      ownerId: host.id,
      attrs: { multiplicity: '1..2..3' },
    });

    // (3) port with no direction at all.
    m.create('PortUsage', { declaredName: 'noDir', ownerId: host.id });

    // (4) dangling relationship endpoint (source id does not resolve).
    const real = f.part('real', pkg.id);
    m.create('Dependency', { ownerId: pkg.id, source: ['missing-element-id'], target: [real.id] });

    return m;
  }

  const findings = validate(buildBrokenModel());
  const byRule = (id: string) => findings.filter((d) => d.ruleId === id);

  it('flags the duplicate sibling names', () => {
    const dup = byRule('duplicate-name');
    expect(dup.length).toBeGreaterThanOrEqual(2);
    expect(dup.every((d) => d.severity === 'error')).toBe(true);
  });

  it('flags the malformed multiplicity', () => {
    const mult = byRule('malformed-multiplicity');
    expect(mult).toHaveLength(1);
    expect(mult[0].severity).toBe('error');
    expect(mult[0].message).toContain('1..2..3');
  });

  it('flags the port with a missing direction', () => {
    const dir = byRule('port-direction');
    expect(dir).toHaveLength(1);
    expect(dir[0].severity).toBe('warning');
    expect(dir[0].elementId).toBeDefined();
  });

  it('flags the dangling relationship endpoint', () => {
    const dangling = byRule('dangling-endpoint');
    expect(dangling).toHaveLength(1);
    expect(dangling[0].message).toContain('missing-element-id');
  });

  it('reports the model as invalid overall', () => {
    expect(isValid(buildBrokenModel())).toBe(false);
    expect(findings.some((d) => d.severity === 'error')).toBe(true);
  });
});
