/**
 * Pipeline integration — Text ↔ Model ↔ Text round-trip on the on-disk example.
 *
 * Reads examples/vehicle.sysml from the filesystem, parses it through @text into
 * a real @core Model, asserts that every kind of element the example declares
 * survived the parse, then serialises and re-parses to prove the element set is
 * stable across a full text→model→text→model cycle.
 *
 * Note: the example uses forward type references (e.g. `port fuelIn : FuelPort`
 * before `port def FuelPort`) which the single-pass resolver records as textual
 * `typeRef`s with `warning` diagnostics, and a couple of transition spellings
 * the subset parser flags — so the FIRST parse is not error-free. What this test
 * guarantees is the cross-module invariant that matters: serialising a parsed
 * model and re-parsing it reproduces the identical element set (round-trip
 * stability), regardless of those input-notation quirks.
 */

import { describe, it, expect } from 'vitest';
import { parseModel, serializeModel } from '@text/index';
import { elementSetDiffs, readVehicleSource } from './_shared';

describe('pipeline: Text → Model round-trip (examples/vehicle.sysml)', () => {
  const src = readVehicleSource();
  const { model, diagnostics } = parseModel(src);

  it('reads a non-empty SysML v2 source from disk', () => {
    expect(src).toContain('package VehicleModel');
    expect(src.length).toBeGreaterThan(100);
  });

  it('parses into a populated core model with every reference bound', () => {
    expect(model.size).toBeGreaterThan(0);
    // The example writes six FORWARD typings (`in port fuelIn : FuelPort;`
    // before `port def FuelPort;`). They used to leave an "unresolved
    // reference" warning apiece for the library binder to retract; `parseModel`
    // resolves them itself now, so a valid file parses SILENT — and every one
    // of the six is a real FeatureTyping, not a textual `attrs.typeRef`.
    expect(diagnostics).toEqual([]);
    const fuelIn = model.all().find((e) => e.declaredName === 'fuelIn')!;
    expect(fuelIn.attrs.typeRef).toBeUndefined();
    expect(model.typesOf(fuelIn.id).map((t) => t.declaredName)).toEqual(['FuelPort']);
  });

  it('captures the Vehicle part definition and its sibling definitions', () => {
    const partDefs = model.ofKind('PartDefinition');
    const names = partDefs.map((e) => e.declaredName).sort();
    expect(names).toEqual(['Engine', 'Transmission', 'Vehicle']);
    const vehicleDef = partDefs.find((e) => e.declaredName === 'Vehicle');
    expect(vehicleDef).toBeDefined();
    expect(model.qualifiedName(vehicleDef!.id)).toBe('VehicleModel::Vehicle');
  });

  it('captures ports (usages and definitions)', () => {
    // 4 declared + 4 implicit usage-scoped ports (connector feature chains).
    expect(model.ofKind('PortUsage')).toHaveLength(8);
    expect(model.ofKind('PortDefinition').map((e) => e.declaredName).sort()).toEqual([
      'FuelPort',
      'TorquePort',
    ]);
  });

  it('captures the connections inside the vehicle usage', () => {
    const connections = model.ofKind('ConnectionUsage');
    expect(connections).toHaveLength(2);
    expect(connections.map((c) => c.declaredName).sort()).toEqual(['driveline', 'fuelLine']);
  });

  it('captures action usages and at least one succession', () => {
    expect(model.ofKind('ActionDefinition').map((e) => e.declaredName)).toContain('Drive');
    expect(model.ofKind('ActionUsage').length).toBeGreaterThanOrEqual(4);
    expect(model.ofKind('Succession').length).toBeGreaterThanOrEqual(1);
  });

  it('captures the state machine and its transitions', () => {
    expect(model.ofKind('StateDefinition').map((e) => e.declaredName)).toContain('VehicleStates');
    expect(model.ofKind('StateUsage').length).toBeGreaterThanOrEqual(3);
    expect(model.ofKind('TransitionUsage')).toHaveLength(4);
  });

  it('captures the requirement, its constraint and the satisfy relationship', () => {
    const reqDef = model.ofKind('RequirementDefinition').find((e) => e.declaredName === 'MassRequirement');
    expect(reqDef).toBeDefined();
    expect(model.ofKind('ConstraintUsage').length).toBeGreaterThanOrEqual(1);
    const satisfy = model.ofKind('Satisfy');
    expect(satisfy).toHaveLength(1);
    // satisfy MassRequirement by vehicle  →  source = vehicle, target = requirement.
    expect((satisfy[0].target ?? []).map((id) => model.qualifiedName(id))).toContain(
      'VehicleModel::MassRequirement',
    );
    expect((satisfy[0].source ?? []).map((id) => model.qualifiedName(id))).toContain(
      'VehicleModel::vehicle',
    );
  });

  it('serialise → parse reproduces an identical element set (round-trip stable)', () => {
    const text2 = serializeModel(model);
    expect(text2).toContain('package VehicleModel');
    const { model: model2 } = parseModel(text2);
    expect(model2.size).toBe(model.size);
    expect(elementSetDiffs(model, model2)).toEqual([]);
  });

  it('is element-set stable across two serialise/parse cycles', () => {
    const once = parseModel(serializeModel(model)).model;
    const twice = parseModel(serializeModel(once)).model;
    expect(twice.size).toBe(once.size);
    expect(elementSetDiffs(once, twice)).toEqual([]);
  });
});
