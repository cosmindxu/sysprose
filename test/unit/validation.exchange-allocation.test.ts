/**
 * Exchange allocation across layers (Arcadia, Voirin 2018: §19.10–19.11,
 * §20.4, §21.9; SysML v2 §7.15 sets no consistency rule on an allocation).
 * Before this rule every fault below passed `check` with no finding.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { parseModel, resolveConnectorFeatureChains } from '@text/index';
import { preloadFullLibrary, loadFullStandardLibrary } from '../../src/library/full-library';
import { resolveTypeReferences } from '../../src/library/resolve';
import { exchangeAllocation, exchangeUnallocated, functionalPortRealisation } from '../../src/validation/rules-allocation';
import { RULES_BY_ID } from '@validation/index';
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
    port def RfPort;
    action def Command { out cmd : Cmd; }
    action def Execute { in cmd : Cmd; out report : Report; }
    action def Show { in report : Report; }
    part def Ground { out port cmdOut : CmdPort; in port reportIn : ~ReportPort; }
    part def Drone { in port cmdIn : ~CmdPort; out port reportOut : ReportPort; }
    part def Node { inout port rf : RfPort; }`;

const SYS = `
        action command : Command; action execute : Execute; action show : Show;
        flow cmdFlow of Cmd from command.cmd to execute.cmd;
        flow reportFlow of Report from execute.report to show.report;
        part ground : Ground; part drone : Drone; part other : Ground;
        allocate command to ground; allocate show to ground; allocate execute to drone;
        connection cmdLink connect ground.cmdOut to drone.cmdIn;
        connection reportLink connect drone.reportOut to ground.reportIn;
        connection otherLink connect other.cmdOut to drone.cmdIn;
        part gNode : Node; part dNode : Node; part xNode : Node;
        allocate ground to gNode; allocate drone to dNode; allocate other to xNode;
        connection rfLink connect gNode.rf to dNode.rf;`;

const run = async (body: string, defs = DEFS) =>
  exchangeAllocation.run(await bound(`package P { ${defs} part sys { ${SYS} ${body} } }`)).map((d) => d.message);

describe('exchange-allocation', () => {
  beforeAll(async () => {
    await preloadFullLibrary();
  });

  it('is registered as a warning', () => {
    expect(RULES_BY_ID.get('exchange-allocation')?.severity).toBe('warning');
  });

  it('accepts flows on the links between their functions\' components, and links on the link between their nodes', async () => {
    expect(await run('allocate cmdFlow to cmdLink; allocate reportFlow to reportLink; allocate cmdLink to rfLink; allocate reportLink to rfLink;')).toEqual([]);
  });

  it('flags a flow put on a link between other components (§20.4)', async () => {
    const m = await run('flow cmdFlow2 of Cmd from command.cmd to execute.cmd; allocate cmdFlow2 to otherLink;');
    expect(m).toHaveLength(1);
    expect(m[0]).toMatch(/runs from a function on .*ground to one on .*drone, but the link joins .*other and .*drone.*§20\.4/);
  });

  it('flags a flow whose item the link\'s ports do not carry (§21.9), once', async () => {
    const m = await run('allocate reportFlow to cmdLink;');
    expect(m).toHaveLength(1);
    expect(m[0]).toMatch(/carries Report, but port .* has no feature of that kind.*§21\.9/);
  });

  it('flags a flow that runs against the direction of the item on the link (§7.12.1)', async () => {
    const m = await run('action echo : Command; allocate echo to drone; action take : Execute; allocate take to ground; flow back of Cmd from echo.cmd to take.cmd; allocate back to cmdLink;');
    expect(m.length).toBeGreaterThan(0);
    expect(m[0]).toMatch(/leaves through port .*cmdIn, where cmd is `in`; it must be `out`/);
  });

  it('flags a link put on a physical link between nodes its components are not deployed on (§19.10–19.11)', async () => {
    const m = await run('allocate otherLink to rfLink;');
    expect(m).toHaveLength(1);
    expect(m[0]).toMatch(/joins .*other and .*drone, but the link joins .*gNode and .*dNode.*§19\.10/);
  });

  it('accepts a physical link in either order (a physical port is not oriented)', async () => {
    expect(await run('connection rfBack connect dNode.rf to gNode.rf; allocate cmdLink to rfBack;')).toEqual([]);
  });

  it('flags a flow allocated to two exchanges (one and only one, §20.4)', async () => {
    const m = await run('allocate cmdFlow to cmdLink; flow dup of Cmd from command.cmd to execute.cmd; allocate cmdFlow to otherLink;');
    expect(m.some((x) => /allocated to 2 exchanges .*one and only one/.test(x))).toBe(true);
  });

  it('reads `perform` as hosting, and a member that subsets its fleet as that fleet', async () => {
    const defs = `${DEFS}
    part def Swarm { part fleet : Drone [4]; part a :> fleet; part b :> fleet; }`;
    const body = `part ops : Ground { perform command; }
        part swarm : Swarm;
        allocate execute to swarm.fleet;
        connection opsLink connect ops.cmdOut to swarm.a.cmdIn;
        flow f2 of Cmd from command.cmd to execute.cmd;
        allocate f2 to opsLink;`;
    // command is allocated to ground AND performed by ops: either host matches.
    expect(await run(body, defs)).toEqual([]);
  });

  it('does not judge a flow whose functions are allocated nowhere', async () => {
    expect(await run('action loose : Command; action loose2 : Execute; flow f3 of Cmd from loose.cmd to loose2.cmd; allocate f3 to otherLink;')).toEqual([]);
  });
});

describe('exchange-unallocated and functional-port-realisation', () => {
  const runR = async (rule: typeof exchangeUnallocated, body: string) =>
    rule.run(await bound(`package P { ${DEFS} part sys { ${SYS} ${body} } }`)).map((d) => d.message);

  it('are registered as warnings', () => {
    expect(RULES_BY_ID.get('exchange-unallocated')?.severity).toBe('warning');
    expect(RULES_BY_ID.get('functional-port-realisation')?.severity).toBe('warning');
  });

  it('I1: silent when no flow is allocated anywhere (opt-in)', async () => {
    expect(await runR(exchangeUnallocated, '')).toEqual([]);
  });

  it('I1: one allocated and one not gives exactly one finding', async () => {
    const m = await runR(exchangeUnallocated, 'allocate cmdFlow to cmdLink;');
    expect(m).toHaveLength(1);
    expect(m[0]).toMatch(/reportFlow.*crosses from .*drone to .*ground and no connection carries it.*§20\.4/);
  });

  it('I1: all allocated is silent; a same-host flow is silent', async () => {
    expect(await runR(exchangeUnallocated, 'allocate cmdFlow to cmdLink; allocate reportFlow to reportLink;')).toEqual([]);
    expect(await runR(exchangeUnallocated, 'allocate cmdFlow to cmdLink; allocate reportFlow to reportLink; action echo : Show; allocate echo to ground; flow local of Report from show.report to echo.report;')).toEqual([]);
  });

  it('I1: a host through perform counts', async () => {
    const m = await runR(exchangeUnallocated, 'part ops : Drone { perform execute; } allocate cmdFlow to cmdLink; action act2 : Show; part g2 : Ground { perform act2; } flow viaPerform of Report from execute.report to act2.report;');
    expect(m.some((x) => /viaPerform/.test(x))).toBe(true);
  });

  it('I1: a flow with an unhosted end is silent', async () => {
    expect(await runR(exchangeUnallocated, 'allocate cmdFlow to cmdLink; allocate reportFlow to reportLink; action loose : Show; flow lf of Report from execute.report to loose.report;')).toEqual([]);
  });

  it('I2: a parameter allocated to the right port is silent', async () => {
    expect(await runR(functionalPortRealisation, 'allocate command.cmd to ground.cmdOut; allocate execute.cmd to drone.cmdIn; allocate execute.report to drone.reportOut;')).toEqual([]);
  });

  it('I2: a port on another component is flagged', async () => {
    const m = await runR(functionalPortRealisation, 'allocate execute.cmd to ground.cmdOut;');
    expect(m).toHaveLength(1);
    expect(m[0]).toMatch(/port is on .*ground, but the function runs on .*drone.*§20\.3/);
  });

  it('I2: wrong direction and wrong item are flagged', async () => {
    const d = await runR(functionalPortRealisation, 'allocate execute.cmd to drone.reportOut;');
    expect(d).toHaveLength(1);
    expect(d[0]).toMatch(/has no feature of that kind/);
    const dir = await runR(functionalPortRealisation, 'allocate execute.report to drone.reportOut; allocate command.cmd to ground.cmdOut; action sink : Show; allocate sink to ground; allocate sink.report to ground.cmdOut;');
    expect(dir.length).toBeGreaterThan(0);
    const o = await runR(functionalPortRealisation, 'allocate execute.cmd to drone.cmdIn;');
    expect(o).toEqual([]);
  });

  it('I2: an out parameter on an in port is flagged', async () => {
    const m = await runR(functionalPortRealisation, 'action cmdIn2 : Command; allocate cmdIn2 to drone; allocate cmdIn2.cmd to drone.cmdIn;');
    expect(m).toHaveLength(1);
    expect(m[0]).toMatch(/parameter is `out` but cmd is `in`/);
  });
});
