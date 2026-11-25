/** The Interconnection overlay: status -> style and hover text (src/ui/icd-overlay.ts). */
import { describe, it, expect } from 'vitest';
import { parseModel, resolveConnectorFeatureChains } from '@text/index';
import { preloadFullLibrary, loadFullStandardLibrary } from '../../src/library/full-library';
import { resolveTypeReferences } from '../../src/library/resolve';
import { icdEdgeClass, icdHoverText, icdOverlay } from '../../src/ui/icd-overlay';
import type { IcdRow } from '../../src/semantics/icd';

const row = (o: Partial<IcdRow>): IcdRow => ({
  connection: 'P::c', kind: 'ConnectionUsage', ends: [{ part: 'a', conjugated: false }, { part: 'b', conjugated: false }],
  items: [], flows: [], carries: [], allocatedTo: [], status: 'UNJUDGED', findings: [], ...o,
});

describe('icd overlay', () => {
  it('maps each status to a class; UNJUDGED leaves the edge alone', () => {
    expect(icdEdgeClass('CONSISTENT')).toBe('rf-icd-consistent');
    expect(icdEdgeClass('UNCARRIED')).toBe('rf-icd-uncarried');
    expect(icdEdgeClass('UNUSED')).toBe('rf-icd-unused');
    expect(icdEdgeClass('UNJUDGED')).toBeUndefined();
  });
  it('CONSISTENT hover lists the flow, item and direction', () => {
    const t = icdHoverText(row({ status: 'CONSISTENT', flows: [{ flow: 'P::f', item: 'Cmd', sender: 'g', receiver: 'd' }] }));
    expect(t).toBe('ICD: CONSISTENT\nflow P::f : Cmd (g -> d)');
  });
  it('UNCARRIED hover quotes the finding', () => {
    const t = icdHoverText(row({ status: 'UNCARRIED', flows: [{ flow: 'P::f' }], findings: ['cannot carry f'] }));
    expect(t).toContain('ICD: UNCARRIED');
    expect(t).toContain('flow P::f');
    expect(t).toContain('cannot carry f');
  });
  it('UNUSED hover says what it carries and that nothing is allocated', () => {
    const t = icdHoverText(row({ status: 'UNUSED', items: [{ item: 'cmd', direction: 'A->B' }] }));
    expect(t).toBe('ICD: UNUSED\nunused: carries cmd A->B, nothing allocated');
  });
});

const SRC = (body: string) => `package P {
  item def Cmd; port def CmdPort { out item cmd : Cmd; }
  action def Command { out cmd : Cmd; } action def Execute { in cmd : Cmd; }
  part def Ground { out port cmdOut : CmdPort; } part def Drone { in port cmdIn : ~CmdPort; }
  part sys { action command : Command; action execute : Execute;
    flow cmdFlow of Cmd from command.cmd to execute.cmd;
    part ground : Ground; part drone : Drone;
    allocate command to ground; allocate execute to drone;
    connection cmdLink connect ground.cmdOut to drone.cmdIn; ${body} } }`;
const overlay = async (body: string) => {
  const { model } = parseModel(SRC(body));
  await preloadFullLibrary();
  loadFullStandardLibrary(model);
  resolveTypeReferences(model);
  resolveConnectorFeatureChains(model);
  return [...icdOverlay(model).values()];
};

describe('icd overlay on a model', () => {
  it('colours an allocated connection and shows its flow; stays silent when nothing is allocated', async () => {
    const m = await overlay('allocate cmdFlow to cmdLink;');
    expect(m).toHaveLength(1);
    expect(m[0]!.className).toBe('rf-icd-consistent');
    expect(m[0]!.title).toMatch(/flow .*cmdFlow : Cmd/);
    expect(await overlay('')).toHaveLength(0);
  });
});
