/**
 * `connection-compatibility`, run directly (independent of the registry) on
 * parsed and library-bound models — the state a real check sees.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseModel, resolveConnectorFeatureChains } from '@text/index';
import { preloadFullLibrary, loadFullStandardLibrary } from '../../src/library/full-library';
import { resolveTypeReferences } from '../../src/library/resolve';
import { connectionCompatibility } from '../../src/validation/rules-connection';
import type { Model } from '@core/index';

async function bound(src: string): Promise<Model> {
  const { model } = parseModel(src);
  await preloadFullLibrary();
  loadFullStandardLibrary(model);
  resolveTypeReferences(model);
  resolveConnectorFeatureChains(model);
  return model;
}
const findings = (m: Model) => connectionCompatibility.run(m).map((d) => d.message);

describe('connection-compatibility', () => {
  beforeAll(async () => {
    await preloadFullLibrary();
  });

  it('flags out→out and a type mismatch, on the connector', async () => {
    const m = await bound(`package G {
    port def PowerPort; port def DataPort;
    part def Battery { out port powerOut : PowerPort; }
    part def FC { out port motorOut : DataPort; in port powerIn : PowerPort; }
    part def Sys {
        part battery : Battery; part flightComputer : FC;
        connection badDir connect battery.powerOut to flightComputer.motorOut;
        connection badType connect flightComputer.motorOut to flightComputer.powerIn;
    }
    part s : Sys;
}
`);
    const f = connectionCompatibility.run(m);
    const byConnector = (name: string) => f.filter((d) => d.message.includes(`"${name}"`));
    // badDir: out→out AND PowerPort→DataPort ⇒ both sub-checks fire.
    expect(byConnector('G::Sys::badDir')).toHaveLength(2);
    expect(byConnector('G::Sys::badDir').some((d) => /joins two `out` ports/.test(d.message))).toBe(true);
    expect(byConnector('G::Sys::badDir').some((d) => /share no port definition/.test(d.message))).toBe(true);
    // badType: DataPort→PowerPort, directions out→in are fine ⇒ only the type check.
    expect(byConnector('G::Sys::badType')).toHaveLength(1);
    expect(byConnector('G::Sys::badType')[0].message).toMatch(/share no port definition/);
    expect(f).toHaveLength(3);
    // Anchored on the CONNECTOR — validate() would drop an implicit-end anchor.
    for (const d of f) expect(m.get(d.elementId!)?.eClass).toBe('ConnectionUsage');
  });

  it('accepts the canonical conjugate pair T ↔ ~T, out → in', async () => {
    const m = await bound(`package C {
    port def PowerPort;
    part def A { out port p : PowerPort; }
    part def B { in port q : ~PowerPort; }
    part def Sys { part a : A; part b : B; connection ok connect a.p to b.q; }
    part s : Sys;
}
`);
    expect(findings(m)).toEqual([]);
  });

  it('accepts a specialised port definition against its ancestor', async () => {
    const m = await bound(`package S {
    port def Base; port def Special :> Base;
    part def A { out port p : Special; }
    part def B { in port q : Base; }
    part def Sys { part a : A; part b : B; connection ok connect a.p to b.q; }
    part s : Sys;
}
`);
    expect(findings(m)).toEqual([]);
  });

  it('stays silent when a direction is not declared — that is port-direction\'s finding', async () => {
    const m = await bound(`package U {
    port def Pt;
    part def A { port p : Pt; }
    part def Sys { part a : A; part b : A; connection c connect a.p to b.p; }
    part s : Sys;
}
`);
    expect(findings(m)).toEqual([]);
  });

  it.each(['examples/vehicle.sysml', 'examples/uav-isr.sysml'])('%s is clean', async (f) => {
    expect(findings(await bound(readFileSync(f, 'utf8')))).toEqual([]);
  });
});
