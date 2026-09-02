/**
 * Convenience factory over {@link Model} for constructing common SysML v2
 * structures (packages, definitions, usages, typed features, connectors,
 * specializations, requirements). Keeps callers (UI commands, parser, tests,
 * SDK) free of low-level metaclass/attribute wiring.
 */

import type { ElementId, ElementRecord, FeatureDirection } from './metamodel';
import { Model } from './model';

export class ModelFactory {
  constructor(public readonly model: Model) {}

  pkg(name: string, ownerId: ElementId | null = null): ElementRecord {
    return this.model.create('Package', { declaredName: name, ownerId });
  }

  partDef(name: string, ownerId: ElementId | null = null): ElementRecord {
    return this.model.create('PartDefinition', { declaredName: name, ownerId });
  }

  part(name: string, ownerId: ElementId, typeId?: ElementId): ElementRecord {
    const p = this.model.create('PartUsage', { declaredName: name, ownerId });
    if (typeId) this.featureTyping(p.id, typeId);
    return p;
  }

  attributeDef(name: string, ownerId: ElementId | null = null): ElementRecord {
    return this.model.create('AttributeDefinition', { declaredName: name, ownerId });
  }

  attribute(
    name: string,
    ownerId: ElementId,
    opts: { type?: string; value?: string | number | boolean; multiplicity?: string } = {},
  ): ElementRecord {
    const attrs: Record<string, string | number | boolean> = {};
    if (opts.type) attrs.type = opts.type;
    if (opts.value !== undefined) attrs.value = opts.value;
    if (opts.multiplicity) attrs.multiplicity = opts.multiplicity;
    return this.model.create('AttributeUsage', { declaredName: name, ownerId, attrs });
  }

  portDef(name: string, ownerId: ElementId | null = null): ElementRecord {
    return this.model.create('PortDefinition', { declaredName: name, ownerId });
  }

  port(
    name: string,
    ownerId: ElementId,
    opts: { direction?: FeatureDirection; typeId?: ElementId } = {},
  ): ElementRecord {
    const attrs: Record<string, string> = {};
    if (opts.direction) attrs.direction = opts.direction;
    const p = this.model.create('PortUsage', { declaredName: name, ownerId, attrs });
    if (opts.typeId) this.featureTyping(p.id, opts.typeId);
    return p;
  }

  /** A connection/connector between two features (ports or parts). */
  connect(
    sourceId: ElementId,
    targetId: ElementId,
    opts: { name?: string; ownerId?: ElementId; eClass?: string } = {},
  ): ElementRecord {
    const ownerId = opts.ownerId ?? this.model.get(sourceId)?.ownerId ?? null;
    return this.model.create(opts.eClass ?? 'ConnectionUsage', {
      declaredName: opts.name,
      ownerId,
      source: [sourceId],
      target: [targetId],
    });
  }

  actionDef(name: string, ownerId: ElementId | null = null): ElementRecord {
    return this.model.create('ActionDefinition', { declaredName: name, ownerId });
  }

  action(name: string, ownerId: ElementId): ElementRecord {
    return this.model.create('ActionUsage', { declaredName: name, ownerId });
  }

  /** A succession (control flow) between two actions. */
  succession(sourceId: ElementId, targetId: ElementId, ownerId?: ElementId): ElementRecord {
    const owner = ownerId ?? this.model.get(sourceId)?.ownerId ?? null;
    return this.model.create('Succession', { ownerId: owner, source: [sourceId], target: [targetId] });
  }

  stateDef(name: string, ownerId: ElementId | null = null): ElementRecord {
    return this.model.create('StateDefinition', { declaredName: name, ownerId });
  }

  state(name: string, ownerId: ElementId): ElementRecord {
    return this.model.create('StateUsage', { declaredName: name, ownerId });
  }

  /** A state transition with optional trigger/guard/effect. */
  transition(
    sourceId: ElementId,
    targetId: ElementId,
    opts: { ownerId?: ElementId; trigger?: string; guard?: string; effect?: string } = {},
  ): ElementRecord {
    const owner = opts.ownerId ?? this.model.get(sourceId)?.ownerId ?? null;
    const attrs: Record<string, string> = {};
    if (opts.trigger) attrs.trigger = opts.trigger;
    if (opts.guard) attrs.guard = opts.guard;
    if (opts.effect) attrs.effect = opts.effect;
    return this.model.create('TransitionUsage', {
      ownerId: owner,
      attrs,
      source: [sourceId],
      target: [targetId],
    });
  }

  requirementDef(name: string, ownerId: ElementId | null = null): ElementRecord {
    return this.model.create('RequirementDefinition', { declaredName: name, ownerId });
  }

  requirement(
    name: string,
    ownerId: ElementId,
    opts: { reqId?: string; text?: string } = {},
  ): ElementRecord {
    const attrs: Record<string, string> = {};
    if (opts.reqId) attrs.reqId = opts.reqId;
    if (opts.text) attrs.text = opts.text;
    return this.model.create('RequirementUsage', { declaredName: name, ownerId, attrs });
  }

  /** A satisfy relationship: `satisfier` satisfies `requirement`. */
  satisfy(requirementId: ElementId, satisfierId: ElementId, ownerId?: ElementId): ElementRecord {
    const owner = ownerId ?? this.model.get(satisfierId)?.ownerId ?? null;
    return this.model.create('Satisfy', {
      ownerId: owner,
      source: [satisfierId],
      target: [requirementId],
    });
  }

  /** An allocation relationship from `from` to `to`. */
  allocate(fromId: ElementId, toId: ElementId, ownerId?: ElementId): ElementRecord {
    const owner = ownerId ?? this.model.get(fromId)?.ownerId ?? null;
    return this.model.create('Allocation', { ownerId: owner, source: [fromId], target: [toId] });
  }

  /** A generic dependency. */
  dependency(fromId: ElementId, toId: ElementId, ownerId?: ElementId): ElementRecord {
    const owner = ownerId ?? this.model.get(fromId)?.ownerId ?? null;
    return this.model.create('Dependency', { ownerId: owner, source: [fromId], target: [toId] });
  }

  /* ─────────────────────── Specialization relationships ───────────────── */

  featureTyping(featureId: ElementId, typeId: ElementId): ElementRecord {
    return this.model.create('FeatureTyping', {
      ownerId: featureId,
      source: [featureId],
      target: [typeId],
    });
  }

  subclassification(specificId: ElementId, generalId: ElementId): ElementRecord {
    return this.model.create('Subclassification', {
      ownerId: specificId,
      source: [specificId],
      target: [generalId],
    });
  }

  subsetting(subsetId: ElementId, supersetId: ElementId): ElementRecord {
    return this.model.create('Subsetting', {
      ownerId: subsetId,
      source: [subsetId],
      target: [supersetId],
    });
  }

  redefinition(redefiningId: ElementId, redefinedId: ElementId): ElementRecord {
    return this.model.create('Redefinition', {
      ownerId: redefiningId,
      source: [redefiningId],
      target: [redefinedId],
    });
  }

  /** Attach a documentation comment to an element. */
  doc(ownerId: ElementId, body: string): ElementRecord {
    return this.model.create('Documentation', { ownerId, attrs: { body } });
  }
}

/** Build a small, illustrative model for demos/tests. */
export function buildSampleModel(): Model {
  const m = new Model();
  const f = new ModelFactory(m);
  const sys = f.pkg('VehicleModel');
  const vehicleDef = f.partDef('Vehicle', sys.id);
  const engineDef = f.partDef('Engine', sys.id);
  const vehicle = f.part('vehicle', sys.id, vehicleDef.id);
  const engine = f.part('engine', vehicle.id, engineDef.id);
  f.attribute('mass', vehicle.id, { type: 'Real', value: 1500 });
  const pOut = f.port('fuelOut', engine.id, { direction: 'out' });
  const pIn = f.port('fuelIn', vehicle.id, { direction: 'in' });
  f.connect(pOut.id, pIn.id, { name: 'fuelLine', ownerId: vehicle.id });
  const req = f.requirement('maxMass', sys.id, { reqId: 'R1', text: 'Vehicle mass shall be < 2000 kg' });
  f.satisfy(req.id, vehicle.id, sys.id);
  return m;
}
