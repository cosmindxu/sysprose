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

  describe('nested ports, undirected features and conjugated copies (§7.12.1, §7.12.3)', () => {
    const wrap = (defs: string, conn: string) => `package N {
    ${defs}
    part def A { port p : P; }
    part def B { port q : ${conn}; }
    part def Sys { part a : A; part b : B; connection c connect a.p to b.q; }
}`;

    it('flags a nested port missing on the other end, naming the path', async () => {
      const m = await bound(
        wrap(`port def Inner { out item x; } port def P { out item top; port sub : Inner; } port def Q { in item top; }`, 'Q'),
      );
      const f = findings(m);
      expect(f).toHaveLength(1);
      expect(f[0]).toMatch(/§7\.12\.1/);
      expect(f[0]).toMatch(/nested/);
      expect(f[0]).toMatch(/sub/);
    });

    it('flags a direction mismatch inside nested ports, with conjugation composed along the path', async () => {
      const m = await bound(
        wrap(
          `port def Inner { out item x; } port def P { port sub : Inner; } port def Q { port sub : Inner; }`,
          'Q', // not conjugated: sub.x is out on both sides
        ),
      );
      const f = findings(m);
      expect(f).toHaveLength(1);
      expect(f[0]).toMatch(/sub\.x/);
    });

    it('stays silent for a conjugated pair with nested ports that conform', async () => {
      const m = await bound(
        wrap(`port def Inner { out item x; } port def P { out item top; port sub : Inner; }`, '~P'),
      );
      expect(findings(m)).toEqual([]);
    });

    it('stays silent when a port def has no nested ports (as before)', async () => {
      const m = await bound(wrap(`port def P { out item top; }`, '~P'));
      expect(findings(m)).toEqual([]);
    });

    it('stays silent for an empty nested port the other end omits', async () => {
      const m = await bound(wrap(`port def E; port def P { out item top; port sub : E; } port def Q { in item top; }`, 'Q'));
      expect(findings(m)).toEqual([]);
    });

    it('terminates on a nested port typed by its own definition', async () => {
      const m = await bound(wrap(`port def P { out item top; port sub : P; }`, '~P'));
      expect(() => findings(m)).not.toThrow();
      expect(findings(m)).toEqual([]);
    });

    it('flags an undirected attribute with no same-named counterpart', async () => {
      const m = await bound(
        wrap(`port def P { out item top; attribute id : ScalarValues::String; } port def Q { in item top; }`, 'Q'),
      );
      const f = findings(m);
      expect(f).toHaveLength(1);
      expect(f[0]).toMatch(/id/);
    });

    it('stays silent when the undirected attribute exists on both ends', async () => {
      const m = await bound(
        wrap(`port def P { out item top; attribute id : ScalarValues::String; } port def Q { in item top; attribute id : ScalarValues::String; }`, 'Q'),
      );
      expect(findings(m)).toEqual([]);
    });

    it('reads a feature copy through a conjugated port as reversed (effectiveDirection)', async () => {
      const m = await bound(`package R {
    port def P { out item update; }
    part def B { port meshIn : ~P; }
}`);
      const port = m.all().find((e) => e.declaredName === 'meshIn')!;
      const { effectiveDirection } = await import('../../src/semantics/port-conformance');
      const copies = m.all().filter((e) => e.declaredName === 'update' && e.ownerId === port.id);
      const proto = m.all().find((e) => e.declaredName === 'update' && e.ownerId !== port.id && e.attrs.isLibrary !== true)!;
      expect(effectiveDirection(m, proto.id)).toBe('out');
      for (const c of copies) expect(effectiveDirection(m, c.id)).toBe('in');
    });
  });
});
