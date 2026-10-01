/**
 * What the Text tab and Export write keeps what was read.
 *
 * Found on the drone-swarm model of mbse-workflow: exported from the app, its
 * three interfaces lost their ends (`interface peerLink : MeshInterface;`), a
 * package member came back written as a feature chain (`Hazards.X`), and a
 * definition specialising a library type (`:> ScalarValues::Real`) was never
 * bound, so it carried a standing "Unresolved reference" warning.
 */
import { describe, expect, it } from 'vitest';
import { loadModelText } from '../../src/text/load';
import { serializeElement } from '../../src/text/serializer';

async function roundTrip(src: string): Promise<{ text: string; warnings: string[] }> {
  const r = await loadModelText(src, { fileName: 't.sysml' });
  const m = r.model!;
  const root = m.all().find((e) => e.declaredName === 'R' && !e.ownerId)!;
  return {
    text: serializeElement(m, root.id, 0),
    warnings: r.report.diagnostics.filter((d) => d.severity === 'warning').map((d) => d.message),
  };
}

describe('export fidelity', () => {
  it('an interface keeps its type, its ends and its body', async () => {
    const { text } = await roundTrip(`package R {
      port def P; interface def I { end a : P; end b : ~P; }
      part def M { out port o : P; in port i : ~P; }
      part m1 : M; part m2 : M;
      interface link : I connect m1.o to m2.i { doc /* the link */ }
      connection c : I connect m2.o to m1.i;
    }`);
    expect(text).toContain('interface link : I connect m1.o to m2.i {');
    expect(text).toContain('doc /* the link */');
    expect(text).toContain('connection c : I connect m2.o to m1.i;');
  });

  it('a member of a package is written with `::`, a feature of a usage with `.`', async () => {
    const { text } = await roundTrip(`package R {
      package Hazards { requirement H1; }
      part def A; part def W { part wheel; }
      part car : W;
      satisfy Hazards::H1 by A;
      connection connect car.wheel to A;
    }`);
    expect(text).toContain('satisfy Hazards::H1 by A;');
    expect(text).not.toContain('Hazards.H1');
  });

  it('a definition specialising a library definition is bound, with no warning', async () => {
    const r = await loadModelText('package R { attribute def C :> ScalarValues::Real; part def P :> Parts::Part; }', {
      fileName: 't.sysml',
    });
    const m = r.model!;
    for (const [name, general] of [['C', 'Real'], ['P', 'Part']] as const) {
      const el = m.all().find((e) => e.declaredName === name)!;
      const sub = m.relationshipsFrom(el.id).find((x) => x.eClass === 'Subclassification');
      expect(m.get(sub?.target?.[0] ?? '')?.declaredName).toBe(general);
      expect(el.attrs.specializes).toBeUndefined();
    }
    expect(r.report.diagnostics.filter((d) => d.code === 'ref/unresolved-specialization')).toEqual([]);
    const { text } = await roundTrip('package R { attribute def C :> ScalarValues::Real; }');
    expect(text).toContain('attribute def C :> ScalarValues::Real;');
  });
});
