/**
 * Interface conformance (SysML v2 §7.12.1, §7.12.2, §7.12.3, §7.16; KerML
 * §7.4.6), on parsed and library-bound models — the state a real check sees.
 *
 * Before this branch every fault below passed `check` with no finding: the
 * compatibility rule read only a port USAGE's own direction and whether the two
 * ports shared a port definition, while the spec (and v9) put directions on the
 * features of a port definition and flip them with `~`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { parseModel, resolveConnectorFeatureChains, serializeModel } from '@text/index';
import { preloadFullLibrary, loadFullStandardLibrary } from '../../src/library/full-library';
import { resolveTypeReferences } from '../../src/library/resolve';
import {
  connectionCompatibility,
  flowEndCompatibility,
  interfaceEndConformance,
  portTyping,
} from '../../src/validation/rules-connection';
import { RULES_BY_ID } from '@validation/index';
import { effectiveDirection, endPairs } from '@semantics/port-conformance';
import type { Model } from '@core/index';

async function bound(src: string): Promise<Model> {
  const { model } = parseModel(src);
  await preloadFullLibrary();
  loadFullStandardLibrary(model);
  resolveTypeReferences(model);
  resolveConnectorFeatureChains(model);
  return model;
}

const DEFS = `
    item def Msg; item def Report;
    port def MeshPort { out item update : Msg; }
    port def GroundPort { out item report : Report; }
    interface def MeshInterface { end sender : MeshPort; end receiver : ~MeshPort; }
    part def Drone { port meshOut : MeshPort; port meshIn : ~MeshPort; port ground : GroundPort; port groundIn : ~GroundPort; }`;

const on = (m: Model, rule: { run(m: Model): { message: string }[] }, name: string) =>
  rule.run(m).filter((d) => d.message.includes(`"${name}"`)).map((d) => d.message);

describe('interface conformance', () => {
  beforeAll(async () => {
    await preloadFullLibrary();
  });

  it('G1: an interface whose related ports are of another port definition', async () => {
    const m = await bound(`package P {${DEFS}
    part sys { part a : Drone; part b : Drone; interface g1 : MeshInterface connect a.ground to b.groundIn; }
}`);
    const f = on(m, interfaceEndConformance, 'P::sys::g1');
    expect(f).toHaveLength(2);
    expect(f[0]).toMatch(/end `sender : MeshPort`, which GroundPort does not specialise/);
    expect(f[1]).toMatch(/end `receiver : ~MeshPort`/);
  });

  it('G2: an interface connected the wrong way round (conjugation disagrees with the end)', async () => {
    const m = await bound(`package P {${DEFS}
    part sys { part a : Drone; part b : Drone; interface g2 : MeshInterface connect a.meshIn to b.meshOut; }
}`);
    const f = on(m, interfaceEndConformance, 'P::sys::g2');
    expect(f).toHaveLength(2);
    for (const msg of f) expect(msg).toMatch(/conjugated differently/);
  });

  it('G3: two unconjugated ports whose directed features are both out do not conform (§7.12.1)', async () => {
    const m = await bound(`package P {${DEFS}
    part sys { part a : Drone; part b : Drone; connection g3 connect a.meshOut to b.meshOut; }
}`);
    const f = on(m, connectionCompatibility, 'P::sys::g3');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatch(/do not conform \(SysML v2 §7\.12\.1\): `out update : Msg`.*meets `out update`/);
  });

  it('G4: a flow whose payload conforms to neither end feature', async () => {
    const m = await bound(`package P {${DEFS}
    part sys { part a : Drone; part b : Drone; flow g4 of Report from a.meshOut.update to b.meshIn.update; }
}`);
    const f = on(m, flowEndCompatibility, 'P::sys::g4');
    expect(f).toHaveLength(2);
    expect(f[0]).toMatch(/carries Report but its source .*update is Msg/);
    expect(f[1]).toMatch(/its target .*update is Msg/);
  });

  it('the canonical pair is silent under every rule', async () => {
    const m = await bound(`package P {${DEFS}
    part sys {
        part a : Drone; part b : Drone;
        interface ok : MeshInterface connect a.meshOut to b.meshIn;
        flow okFlow of Msg from a.meshOut.update to b.meshIn.update;
    }
}`);
    for (const rule of [connectionCompatibility, interfaceEndConformance, flowEndCompatibility, portTyping]) {
      expect(rule.run(m).map((d) => d.message)).toEqual([]);
    }
  });

  it('reads a feature reached through a conjugated port with its direction flipped (§7.12.3)', async () => {
    const m = await bound(`package P {${DEFS}
    part sys { part a : Drone; part b : Drone; flow f of Msg from a.meshOut.update to b.meshIn.update; }
}`);
    const flow = m.all().find((e) => e.declaredName === 'f')!;
    // The implicit copy under b.meshIn stores `out` as written on MeshPort; seen through `~MeshPort` it is `in`.
    expect(effectiveDirection(m, flow.source![0])).toBe('out');
    expect(effectiveDirection(m, flow.target![0])).toBe('in');
  });

  it('a flow from an in feature into an out feature is reported on both ends', async () => {
    const m = await bound(`package P {${DEFS}
    part sys { part a : Drone; part b : Drone; flow back of Msg from b.meshIn.update to a.meshOut.update; }
}`);
    const f = on(m, flowEndCompatibility, 'P::sys::back');
    expect(f).toHaveLength(2);
    expect(f[0]).toMatch(/takes its payload from .*an `in` feature/);
    expect(f[1]).toMatch(/delivers its payload to .*an `out` feature/);
  });

  it('conformance is structural: two port definitions with matching features conform', async () => {
    const m = await bound(`package P {
    item def Msg;
    port def TxPort { out item m : Msg; }
    port def RxPort { in item m : Msg; }
    part def A { port tx : TxPort; } part def B { port rx : RxPort; }
    part sys { part a : A; part b : B; connection c connect a.tx to b.rx; }
}`);
    expect(on(m, connectionCompatibility, 'P::sys::c')).toEqual([]);
  });

  it('ports with no directed feature keep the nominal check (a port definition in common)', async () => {
    const m = await bound(`package P {
    port def PowerPort; port def DataPort;
    part def A { out port p : PowerPort; } part def B { in port q : DataPort; }
    part sys { part a : A; part b : B; connection c connect a.p to b.q; }
}`);
    expect(on(m, connectionCompatibility, 'P::sys::c')[0]).toMatch(/share no port definition/);
  });

  it('port-typing: a port typed by an item definition (§7.12.2)', async () => {
    const m = await bound(`package P {
    item def TaskingOrder;
    part def S { in port taskingIn : TaskingOrder; }
}`);
    const f = portTyping.run(m).map((d) => d.message);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatch(/"P::S::taskingIn" is typed by TaskingOrder \(ItemDefinition\)/);
  });

  it('port-typing leaves keyword-less directed features alone: action parameters are not ports', async () => {
    const m = await bound(`package P {
    item def Order;
    action def Decide; action decide : Decide { in risk : Order; out order : Order; }
}`);
    expect(portTyping.run(m)).toEqual([]);
  });

  it('a keyword-less `out x : T;` in a port definition is one of its directed features (§7.12.1)', async () => {
    const m = await bound(`package P {
    item def Msg;
    port def TxPort { out m : Msg; }
    part def A { port tx : TxPort; port tx2 : TxPort; }
    part sys { part a : A; part b : A; connection c connect a.tx to b.tx2; }
}`);
    expect(on(m, connectionCompatibility, 'P::sys::c')[0]).toMatch(/do not conform \(SysML v2 §7\.12\.1\)/);
  });

  it('a conjugation mismatch on a port definition with no directed feature is worded as classification', async () => {
    const m = await bound(`package P {
    port def DataPort { attribute rate : ScalarValues::Real; }
    interface def Svc { end provider : DataPort; end consumer : ~DataPort; }
    part def A { out port o : DataPort; } part def B { in port i : DataPort; }
    part sys { part a : A; part b : B; interface s : Svc connect a.o to b.i; }
}`);
    const f = on(m, interfaceEndConformance, 'P::sys::s');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatch(/not classified by its conjugate/);
  });

  it('port-direction no longer asks for a direction on a port whose features are directed', async () => {
    const m = await bound(`package P {${DEFS}
    port def Bare;
    part def X { port bare : Bare; }
}`);
    const f = RULES_BY_ID.get('port-direction')!.run(m).map((d) => d.message);
    expect(f).toEqual(['Port "P::X::bare" has no direction (expected in/out/inout).']);
  });
});

describe('named connector ends (SysML v2 §8.2.2.13 ConnectorEnd)', () => {
  beforeAll(async () => {
    await preloadFullLibrary();
  });

  const SRC = `package P {${DEFS}
    part sys {
        part a : Drone; part b : Drone;
        interface n1 : MeshInterface connect receiver ::> b.meshIn to sender ::> a.meshOut;
        interface n2 : MeshInterface connect receiver references a.meshOut to sender references b.meshIn;
    }
}`;

  it('parse, and pair each related feature with the end it names, whatever the order', async () => {
    const m = await bound(SRC);
    const n1 = m.all().find((e) => e.declaredName === 'n1')!;
    expect(endPairs(m, n1.id).map((p) => [p.end.declaredName, p.written])).toEqual([
      ['receiver', 'name'],
      ['sender', 'name'],
    ]);
    expect(on(m, interfaceEndConformance, 'P::sys::n1')).toEqual([]);
    expect(on(m, interfaceEndConformance, 'P::sys::n2')).toHaveLength(2);
  });

  it('Save writes the end names back, and the saved text reads the same', async () => {
    const m = await bound(SRC);
    const text = serializeModel(m);
    expect(text).toContain('connect receiver ::> b.meshIn to sender ::> a.meshOut');
    expect(text).toContain('connect receiver ::> a.meshOut to sender ::> b.meshIn');
    const again = await bound(text);
    expect(on(again, interfaceEndConformance, 'P::sys::n1')).toEqual([]);
    expect(on(again, interfaceEndConformance, 'P::sys::n2')).toHaveLength(2);
  });
});
