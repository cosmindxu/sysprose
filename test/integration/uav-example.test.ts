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
  impactClosure,
  isUserElement,
  CONNECTION_KINDS,
  orphanReport,
  requirementSatisfaction,
  traceabilityMatrix,
  whereUsed,
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

/**
 * The two reports that answer a question about the model rather than counting
 * it: what is declared and never used, and what a change to one element reaches.
 *
 * Both are calibrated here rather than only on hand-built fixtures because both
 * are threshold judgements, and a threshold is only honest against a model
 * somebody wrote for its own sake. The orphan reading in particular is a choice:
 * "an element with no edges" is true of 67 of this model's 113 elements and says
 * nothing, while "a definition with no edges" is true of exactly the two the
 * file declares and never instantiates.
 */
describe('examples/uav-isr.sysml — what nothing uses, and what a change reaches', () => {
  let model: Model;
  beforeAll(async () => {
    const loaded = await loadModelText(src, { fileName: 'uav-isr.sysml' });
    model = loaded.model!;
  });

  it('finds the two definitions the example declares and never uses', () => {
    const r = orphanReport(model);
    expect(r.orphans.map((o) => o.declaredName)).toEqual(['FlyMission', 'FlightModes']);
    // The reader can count these in the file: 14 definitions, of which the 7
    // part definitions, 3 port definitions and 2 requirement definitions are
    // all referenced somewhere.
    expect(r.definitionsExamined).toBe(14);
    // The bundled library declares thousands of definitions and none of them
    // are this reader's dead code.
    expect(r.libraryExcluded).toBeGreaterThan(1000);
    // The one package in the file is a namespace, not a finding.
    expect(r.packagesSkipped).toBe(1);

    // The naive reading, measured on the same model, is the reason for the
    // narrowing — and the number the ledger quotes: 67 of these 113 elements
    // carry no edge at all, because attributes, documentation and untyped
    // parts legitimately have none.
    const own = model.all().filter((e) => isUserElement(model, e));
    expect(own).toHaveLength(113);
    expect(own.filter((e) => model.edgesOf(e.id).length === 0)).toHaveLength(67);
  });

  it('reaches the requirements AirVehicle must satisfy only at the second hop', () => {
    const airVehicle = model.all().find((e) => e.declaredName === 'AirVehicle')!;

    // One hop: the part usage `uav`, and the two `ReferenceUsage` subjects the
    // requirements declare. Nothing yet says which requirements those are.
    const one = impactClosure(model, airVehicle.id);
    expect(one.impacted.map((i) => i.element.qualifiedName)).toEqual([
      'UAVSurveillanceSystem::uav',
      'UAVSurveillanceSystem::EnduranceRequirement::uav',
      'UAVSurveillanceSystem::MassRequirement::uav',
    ]);
    expect(one.truncated).toBe(true);

    // Two hops: the requirements themselves, through the `Satisfy` edges — the
    // answer to "what do I have to re-check if I change this part", which the
    // one-hop report cannot give at all.
    const two = impactClosure(model, airVehicle.id, 2);
    expect(
      two.impacted.filter((i) => i.depth === 2).map((i) => `${i.via} ${i.element.declaredName}`),
    ).toEqual(['Satisfy EnduranceRequirement', 'Satisfy MassRequirement']);
    // The second hop is also the last one, and the report says so THERE rather
    // than only when asked for a third: the two requirements have nothing left
    // to reach, so a depth-2 answer is the whole answer and must not be
    // labelled a prefix of itself.
    expect(two.truncated).toBe(false);

    // And the closure closes: a third hop adds nothing, so the impact of
    // changing `AirVehicle` is five elements, not the whole model.
    const all = impactClosure(model, airVehicle.id, 99);
    expect(all.impacted).toHaveLength(5);
    expect(all.truncated).toBe(false);
    // Two hops out, not three: the depth reported is the deepest element in the
    // answer, never the pass that found nothing to add.
    expect(all.depth).toBe(2);
    expect(all.impacted.map((i) => i.depth)).toEqual([1, 1, 1, 2, 2]);
  });

  it('never reports an element of this model as reached across a wire', () => {
    // The limit `impactClosure` documents, pinned as a measurement on the file
    // the docs point at rather than left as prose. Every connection here is
    // written under a part usage, so both its ends are usage-scoped copies and
    // the wire costs three hops — out to the near copy, across, back down to
    // the far declaration — while the two ports it joins share a port
    // definition and are two hops apart up and down it. The typing detour
    // therefore always arrives first and the visited set closes the far port
    // before the cable reaches it.
    const own = model.all().filter((e) => isUserElement(model, e));
    expect(own).toHaveLength(113);
    // Swept to the COMPLETE closure, not to some depth that happens to be
    // deep enough: "no reported element is ever reached across a wire" is a
    // claim about every hop this model has, and a bounded sweep only says the
    // cable had not arrived YET. `CONNECTION_KINDS` rather than a hand-written
    // pattern for the same reason — a `/Connection|Flow|Interface/` matches
    // three of the eight kinds the walk calls a wire, so a `Connector`, an
    // `Allocation` or a `BindingConnectorAsUsage` would pass this pin silently.
    const reached = own.flatMap(
      (e) => impactClosure(model, e.id, Number.POSITIVE_INFINITY).impacted,
    );
    expect(reached.length).toBeGreaterThan(0);
    expect(reached.filter((i) => CONNECTION_KINDS.has(i.via))).toEqual([]);

    // The mechanism, on the one port the doc comment names. `powerOut` is
    // declared on `BatteryPack` and wired to five `powerIn` ports through its
    // usage-scoped copy under `AirVehicle::battery`.
    const powerOut = own.find((e) => model.qualifiedName(e.id).endsWith('BatteryPack::powerOut'))!;
    const closure = impactClosure(model, powerOut.id, 99);
    // The five far ends ARE in the answer — reached at depth 2 through the
    // shared `PowerPort` definition, alongside nothing else, because on this
    // model the ports of that definition and the ports wired to `powerOut` are
    // the same six elements. A reader cannot tell a wire from a shared type
    // here; `connectivityReport` is what answers that question.
    expect(closure.impacted.map((i) => `${i.depth} ${i.via} ${i.element.declaredName}`)).toEqual([
      '1 FeatureTyping PowerPort',
      '2 FeatureTyping powerIn',
      '2 FeatureTyping powerIn',
      '2 FeatureTyping powerIn',
      '2 FeatureTyping powerIn',
      '2 FeatureTyping powerIn',
    ]);
    // The conduit is crossed all the same — six copies walked through, none
    // reported — so the closure is pruned by the visited set, not by a wall.
    expect(closure.implicitExcluded).toBe(6);
    expect(closure.impacted.every((i) => isUserElement(model, model.get(i.element.id)!))).toBe(true);

    // And depth 1 is still exactly `whereUsed` of the reader's own model: the
    // label lift changed what a crossing is CALLED, never what a hop costs.
    const direct = whereUsed(model, powerOut.id).usedBy.filter((u) =>
      isUserElement(model, model.get(u.id)!),
    );
    expect(impactClosure(model, powerOut.id).impacted.map((i) => i.element.id)).toEqual(
      direct.map((u) => u.id),
    );
  });
});
