/**
 * The shipped UAV example, end to end: it must CHECK clean, mean the same thing
 * on both verdict surfaces, and survive a text round-trip with its unit
 * literals intact.
 *
 * WHY it is a test and not a demo: examples/uav-isr.sysml is the model the
 * README, the screenshots and the docs all point at, and it is the one in-tree
 * model that exercises the whole units seam at once — a derived duration
 * (`capacity * fraction / power`, 640 Wh × 0.8 / 650 W), requirements that
 * compare it against `45.0 [min]` and `25.0 [kg]` literals, and a `[Mbit/s]`
 * information rate. Before the numeric surface learned units, the Problems
 * panel called this example satisfied while the Solve button called it violated
 * by 44 minutes; nothing in the suite noticed, because no test ran the example
 * through both.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseModel, serializeModel } from '@text/index';
import { checkText } from '../../src/text/check';
import { checkConstraints } from '@semantics/index';
import { checkConstraintsNumeric, solve } from '@semantics/solver';
import { analysisReport } from '@api/index';
import { elementSetDiffs } from './_shared';

const UAV_PATH = resolve(process.cwd(), 'examples/uav-isr.sysml');
const src = readFileSync(UAV_PATH, 'utf8');

describe('examples/uav-isr.sysml — the shipped model', () => {
  it('checks clean: 0 errors, 0 warnings, 0 infos', async () => {
    const report = await checkText(src, { fileName: 'uav-isr.sysml' });
    expect(report.summary).toEqual({ errors: 0, warnings: 0, infos: 0 });
    expect(report.ok).toBe(true);
  });

  it('is satisfied on BOTH verdict surfaces, and the numbers are seconds and kilograms', () => {
    const { model } = parseModel(src);
    expect(checkConstraints(model).map((c) => c.result)).toEqual(['satisfied', 'satisfied']);

    const numeric = checkConstraintsNumeric(model);
    expect(numeric.map((c) => c.result)).toEqual(['satisfied', 'satisfied']);
    const endurance = numeric.find((c) => c.raw.includes('45.0 [min]'))!;
    // 640 Wh × 0.8 / 650 W = 2835.7 s, 135.7 s clear of the 2700 s bound.
    expect(endurance.slack).toBeCloseTo(2835.6923 - 2700, 3);
    expect(endurance.slackUnit).toBe('s');
    const mass = numeric.find((c) => c.raw.includes('25.0 [kg]'))!;
    expect(mass.slack).toBeCloseTo(6.5, 6);
    expect(mass.slackUnit).toBe('kg');
  });

  it('solves the derived endurance to 2835.7 s and reports a feasible analysis', () => {
    const { model } = parseModel(src);
    const endurance = model
      .all()
      .find((e) => e.declaredName === 'endurance' && e.attrs.isLibrary !== true)!;
    expect(solve(model).values.get(endurance.id)).toBeCloseTo(2835.6923, 3);

    const report = analysisReport(model);
    expect(report.feasible).toBe(true);
    expect(report.violations).toEqual([]);
    expect(report.unknowns).toEqual([]);
  });

  it('breaking the requirement is violated on BOTH surfaces (the verdict is dimensional)', () => {
    // 100 min = 6000 s > 2835.7 s. A unit-blind reading compares 2835.7 with
    // 100 and calls it satisfied, so this is the case that proves the numeric
    // verdict converts rather than compares magnitudes.
    const { model } = parseModel(src.replace('>= 45.0 [min]', '>= 100.0 [min]'));
    expect(checkConstraints(model).map((c) => c.result)).toEqual(['violated', 'satisfied']);
    const numeric = checkConstraintsNumeric(model);
    expect(numeric.map((c) => c.result)).toEqual(['violated', 'satisfied']);
    const endurance = numeric.find((c) => c.raw.includes('100.0 [min]'))!;
    expect(endurance.amount).toBeCloseTo(6000 - 2835.6923, 3);
    expect(analysisReport(model).feasible).toBe(false);
  });

  it('serialises and re-parses to the identical element set, unit literals intact', () => {
    const { model } = parseModel(src);
    const text = serializeModel(model);
    expect(text).toContain('>= 45.0 [min]');
    expect(text).toContain('<= 25.0 [kg]');
    const { model: reparsed } = parseModel(text);
    expect(elementSetDiffs(model, reparsed)).toEqual([]);
  });
});
