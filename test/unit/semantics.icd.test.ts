/**
 * The interface control document (src/semantics/icd.ts): one row per
 * connection with its ends, items each way, allocated flows and a status.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { parseModel, resolveConnectorFeatureChains } from '@text/index';
import { preloadFullLibrary, loadFullStandardLibrary } from '../../src/library/full-library';
import { resolveTypeReferences } from '../../src/library/resolve';
import { icdReport } from '../../src/semantics/icd';
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
    item def Cmd; item def Report;
    port def CmdPort { out item cmd : Cmd; }
    port def ReportPort { out item report : Report; }
    action def Command { out cmd : Cmd; }
    action def Execute { in cmd : Cmd; out report : Report; }
    action def Show { in report : Report; }
    part def Ground { out port cmdOut : CmdPort; in port reportIn : ~ReportPort; }
    part def Drone { in port cmdIn : ~CmdPort; out port reportOut : ReportPort; }`;

const SYS = `
    action command : Command; action execute : Execute; action show : Show;
    flow cmdFlow of Cmd from command.cmd to execute.cmd;
    flow reportFlow of Report from execute.report to show.report;
    part ground : Ground; part drone : Drone; part other : Ground;
    allocate command to ground; allocate show to ground; allocate execute to drone;
    connection cmdLink connect ground.cmdOut to drone.cmdIn;
    connection reportLink connect drone.reportOut to ground.reportIn;
    connection otherLink connect other.cmdOut to drone.cmdIn;`;

const rep = async (body: string, owner = false) => {
  const m = await bound(`package P { ${DEFS} part sys { ${SYS} ${body} } }`);
  const sys = m.all().find((e) => e.declaredName === 'sys');
  return icdReport(m, owner ? sys!.id : undefined);
};
const status = (r: Awaited<ReturnType<typeof rep>>, name: string) => r.rows.find((x) => x.connection.endsWith(`::${name}`))?.status;

describe('icd', () => {
  beforeAll(async () => {
    await preloadFullLibrary();
  });

  it('reports CONSISTENT, UNCARRIED, UNUSED rows and an unallocated crossing flow', async () => {
    const r = await rep('flow cmdFlow2 of Cmd from command.cmd to execute.cmd; allocate cmdFlow to cmdLink; allocate cmdFlow2 to otherLink;');
    expect(status(r, 'cmdLink')).toBe('CONSISTENT');
    expect(status(r, 'otherLink')).toBe('UNCARRIED');
    expect(status(r, 'reportLink')).toBe('UNUSED');
    expect(r.unallocated.map((u) => u.flow)).toEqual([expect.stringMatching(/reportFlow$/)]);
    expect(r.verdict).toEqual({ uncarried: 1, unallocated: 1, exitCode: 1 });
    const cmd = r.rows.find((x) => x.connection.endsWith('::cmdLink'))!;
    expect(cmd.items).toEqual([{ item: 'cmd', direction: 'A->B' }]);
    expect(cmd.flows[0]).toMatchObject({ item: 'Cmd' });
    expect(cmd.ends[1]).toMatchObject({ portDefinition: 'CmdPort', conjugated: true });
    const rl = r.rows.find((x) => x.connection.endsWith('::reportLink'))!;
    expect(rl.items).toEqual([{ item: 'report', direction: 'A->B' }]);
  });

  it('exits 0 for a model whose every flow is carried by a connection that can carry it', async () => {
    const r = await rep('allocate cmdFlow to cmdLink; allocate reportFlow to reportLink;');
    expect(r.verdict.exitCode).toBe(0);
    expect(status(r, 'otherLink')).toBe('UNUSED');
  });

  it('is silent (UNJUDGED) in a layer that allocates no flows, and a direction-wrong link is UNCARRIED', async () => {
    const quiet = await rep('');
    expect(quiet.rows.every((x) => x.status === 'UNJUDGED')).toBe(true);
    expect(quiet.verdict.exitCode).toBe(0);
    const wrong = await rep('allocate reportFlow to cmdLink; allocate cmdFlow to cmdLink;');
    expect(status(wrong, 'cmdLink')).toBe('UNCARRIED');
  });

  it('scopes to an owner, and exits 2 when there is nothing to read', async () => {
    const r = await rep('allocate cmdFlow to cmdLink;', true);
    expect(r.rows.length).toBe(3);
    const none = icdReport(await bound('package P { part def A; part a : A; }'));
    expect(none.verdict.exitCode).toBe(2);
  });
});
