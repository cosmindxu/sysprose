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

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Model } from '@core/index';
import { parseModel, serializeModel } from '@text/index';
import { loadModelText } from '@text/load';
import { checkText } from '../../src/text/check';
import { checkConstraints } from '@semantics/index';
import { checkConstraintsNumeric, solve } from '@semantics/solver';
import {
  analysisReport,
  connectivityReport,
  requirementSatisfaction,
  traceabilityMatrix,
} from '@api/index';
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

/**
 * The reporting surface on the shipped model.
 *
 * The app's own Requirement-satisfaction button read this model as 7.7% covered
 * because the report counted the bundled library's requirements alongside the
 * two the example declares; the connectivity report counted the library's ports
 * AND the usage-scoped copies the feature-chain resolver materialises, then
 * called the copies' connections nothing to do with the declared ports. These
 * are the numbers a reader can verify by eye in `examples/uav-isr.sysml`, so
 * they are the tripwire: a filter or a lift that regresses moves one of them.
 */
describe('examples/uav-isr.sysml — reporting counts the model, not the library', () => {
  let model: Model;
  beforeAll(async () => {
    // The full library bind is what puts the ~38,700 library elements in the
    // model, so it is the only load that can catch the contamination.
    const loaded = await loadModelText(src, { fileName: 'uav-isr.sysml' });
    model = loaded.model!;
  });

  it('requirement coverage is 2 of 2, not 2 of 26', () => {
    const r = requirementSatisfaction(model);
    expect(r.total).toBe(2);
    expect(r.satisfied).toBe(2);
    expect(r.coverage).toBe(1);
    expect(r.libraryExcluded).toBe(24);
    expect(r.requirements.map((x) => x.requirement.declaredName).sort()).toEqual([
      'EnduranceRequirement',
      'MassRequirement',
    ]);
  });

  it('connectivity is 15 declared ports, 9 connections, 14 of them connected', () => {
    const c = connectivityReport(model);
    expect(c.portCount).toBe(15);
    expect(c.connectionCount).toBe(9);
    // The mutation tripwire: without the lift every connection references an
    // implicit copy, so a filter alone reports 15 ports and 0 connected.
    expect(c.connectedPortCount).toBe(14);
    expect(c.implicitResolved).toBe(18);
    expect(c.libraryExcluded).toBe(8);
    expect(c.implicitExcluded).toBe(14);
    expect(c.unconnectedPorts.map((p) => p.qualifiedName)).toEqual([
      'UAVSurveillanceSystem::DataLink::antenna',
    ]);
    // Every part definition here is used exactly once, so the per-usage answer
    // agrees with the declaration-level one — and says WHICH part the dangling
    // end is in, which is what a reader has to know to go and fix it.
    expect(
      c.unconnectedPortUsages.map((o) => `${o.part.qualifiedName}.${o.port.declaredName}`),
    ).toEqual(['UAVSurveillanceSystem::AirVehicle::radio.antenna']);
  });

  it('reports each endpoint both as recorded and as the declared port it stands for', () => {
    const c = connectivityReport(model);
    const power = c.connections.find((x) => x.connection.declaredName === 'powerToComputer')!;
    // As recorded: the usage-scoped copies under `battery` and `flightComputer`.
    expect(power.source.map((id) => model.qualifiedName(id))).toEqual([
      'UAVSurveillanceSystem::AirVehicle::battery::powerOut',
    ]);
    expect(power.target.map((id) => model.qualifiedName(id))).toEqual([
      'UAVSurveillanceSystem::AirVehicle::flightComputer::powerIn',
    ]);
    // Lifted: the two ports of the 15 the inventory counts.
    expect(power.sourcePorts.map((id) => model.qualifiedName(id))).toEqual([
      'UAVSurveillanceSystem::BatteryPack::powerOut',
    ]);
    expect(power.targetPorts.map((id) => model.qualifiedName(id))).toEqual([
      'UAVSurveillanceSystem::FlightController::powerIn',
    ]);
    // Which is the join the lift exists for: every lifted id is a port the
    // report also counts.
    const inventory = new Set(
      [...c.unconnectedPorts.map((p) => p.id), ...c.connections.flatMap((x) => [...x.sourcePorts, ...x.targetPorts])],
    );
    expect(inventory.size).toBe(15);
  });

  it('the traceability matrix rows are the 7 declared parts', () => {
    const tm = traceabilityMatrix(model, 'PartUsage', 'RequirementDefinition', 'Satisfy');
    expect(tm.rows).toHaveLength(7);
    expect(tm.columns.map((c) => c.declaredName)).toEqual([
      'EnduranceRequirement',
      'MassRequirement',
    ]);
    expect(tm.libraryExcluded).toBe(20);
    expect(tm.links).toHaveLength(2);
    const uav = tm.rows.findIndex((r) => r.declaredName === 'uav');
    expect(tm.cells[uav]).toEqual([true, true]);
  });

  it('counts each excluded matrix candidate once, however many axes it sits on', () => {
    // Both axes are PartUsage, so every candidate is a candidate twice: the
    // model holds 11 library parts, and an exclusion count that reported 22
    // would be a new wrong number in place of the one this commit removed.
    const parts = traceabilityMatrix(model, 'PartUsage', 'PartUsage', 'Allocation');
    expect(model.ofKind('PartUsage').filter((p) => p.attrs.isLibrary === true)).toHaveLength(11);
    expect(parts.libraryExcluded).toBe(11);
    expect(parts.rows).toHaveLength(7);
    expect(parts.columns).toHaveLength(7);

    // The implicit half, on the axis that has one: 37 port candidates = 15
    // declared + 8 library + 14 usage-scoped copies.
    const ports = traceabilityMatrix(model, 'PortUsage', 'PortUsage', 'Dependency');
    expect(ports.rows).toHaveLength(15);
    expect(ports.libraryExcluded).toBe(8);
    expect(ports.implicitExcluded).toBe(14);
  });
});
