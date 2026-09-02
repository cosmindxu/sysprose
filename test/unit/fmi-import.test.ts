import { describe, it, expect } from 'vitest';
import { Model, ModelFactory } from '@core/index';
import {
  fmiModelDescription,
  exportFmu,
  parseModelDescription,
  importFmiXml,
  readModelDescriptionFromFmu,
} from '@interop/index';

/** Vehicle block: input port, output port, parameter attribute (mirrors the export test). */
function vehicleBlock() {
  const m = new Model();
  const f = new ModelFactory(m);
  const veh = m.create('PartDefinition', { declaredName: 'Vehicle' });
  m.create('PortUsage', { ownerId: veh.id, declaredName: 'throttle', attrs: { direction: 'in' } });
  m.create('PortUsage', { ownerId: veh.id, declaredName: 'power', attrs: { direction: 'out' } });
  f.attribute('mass', veh.id, { value: 1500 });
  return { m, blockId: veh.id };
}

describe('parseModelDescription — FMI 3.0 XML → variables', () => {
  it('parses the model name, version and typed variables', () => {
    const { m, blockId } = vehicleBlock();
    const parsed = parseModelDescription(fmiModelDescription(m, blockId).xml);
    expect(parsed.modelName).toBe('Vehicle');
    expect(parsed.fmiVersion).toBe('3.0');
    const byName = Object.fromEntries(parsed.variables.map((v) => [v.name, v]));
    expect(byName.throttle.causality).toBe('input');
    expect(byName.throttle.type).toBe('Float64');
    expect(byName.power.causality).toBe('output');
    expect(byName.mass.causality).toBe('parameter');
    expect(byName.mass.start).toBe('1500');
  });

  it('defaults a missing model name and tolerates an empty variable list', () => {
    const parsed = parseModelDescription(
      '<fmiModelDescription fmiVersion="3.0"><ModelVariables></ModelVariables></fmiModelDescription>',
    );
    expect(parsed.modelName).toBe('ImportedFMU');
    expect(parsed.variables).toEqual([]);
  });
});

describe('importFmiXml — FMI → SysML block', () => {
  it('creates ports/attributes mirroring the FMI variables', () => {
    const src = vehicleBlock();
    const xml = fmiModelDescription(src.m, src.blockId).xml;
    const m2 = new Model();
    const id = importFmiXml(m2, xml);
    expect(m2.get(id)!.eClass).toBe('PartDefinition');
    expect(m2.get(id)!.declaredName).toBe('Vehicle');
    const kids = Object.fromEntries(m2.children(id).map((c) => [c.declaredName, c]));
    expect(kids.throttle.eClass).toBe('PortUsage');
    expect(kids.throttle.attrs.direction).toBe('in');
    expect(kids.throttle.attrs.type).toBe('Real');
    expect(kids.power.eClass).toBe('PortUsage');
    expect(kids.power.attrs.direction).toBe('out');
    expect(kids.mass.eClass).toBe('AttributeUsage');
    expect(kids.mass.attrs.value).toBe(1500);
  });

  it('round-trips block → FMI → block preserving the interface', () => {
    const src = vehicleBlock();
    const md1 = fmiModelDescription(src.m, src.blockId);
    const m2 = new Model();
    const id = importFmiXml(m2, md1.xml);
    const md2 = fmiModelDescription(m2, id);
    const norm = (md: typeof md1) =>
      md.variables.map((v) => `${v.name}:${v.causality}:${v.type}`).sort();
    expect(norm(md2)).toEqual(norm(md1));
  });

  it('imports an external-style description (Int64 / Boolean / units)', () => {
    const xml = `<?xml version="1.0"?>
<fmiModelDescription fmiVersion="3.0" modelName="Ext">
  <ModelVariables>
    <Int64 name="count" valueReference="0" causality="parameter" variability="fixed" start="7"/>
    <Boolean name="on" valueReference="1" causality="input" variability="discrete" start="true"/>
    <Float64 name="v" valueReference="2" causality="input" variability="continuous" start="3" unit="m/s"/>
  </ModelVariables>
</fmiModelDescription>`;
    const m = new Model();
    const id = importFmiXml(m, xml);
    const kids = Object.fromEntries(m.children(id).map((c) => [c.declaredName, c]));
    expect(kids.count.attrs.type).toBe('Integer');
    expect(kids.count.attrs.value).toBe(7);
    expect(kids.on.attrs.type).toBe('Boolean');
    expect(kids.on.attrs.value).toBe(true);
    expect(kids.v.attrs.unit).toBe('m/s');
  });

  it('handles a > inside a quoted attribute value (quote-aware tag scan)', () => {
    const parsed = parseModelDescription(
      '<fmiModelDescription fmiVersion="3.0" modelName="M"><ModelVariables>' +
        '<Float64 name="h" description="valid when x > 0" valueReference="5" causality="output" start="1"/>' +
        '</ModelVariables></fmiModelDescription>',
    );
    const v = parsed.variables[0];
    expect(v.causality).toBe('output'); // not silently defaulted to local
    expect(v.valueReference).toBe(5);
  });

  it('parses single-quoted attributes and a namespace-prefixed document', () => {
    const parsed = parseModelDescription(
      "<fmi3:fmiModelDescription fmiVersion='3.0' modelName='NS'><fmi3:ModelVariables>" +
        "<fmi3:Float64 name='u' valueReference='0' causality='input'/>" +
        '</fmi3:ModelVariables></fmi3:fmiModelDescription>',
    );
    expect(parsed.modelName).toBe('NS');
    expect(parsed.variables.map((v) => `${v.name}:${v.causality}`)).toEqual(['u:input']);
  });

  it('ignores a variable-shaped tag inside a comment, maps structuralParameter', () => {
    const parsed = parseModelDescription(
      '<fmiModelDescription fmiVersion="3.0" modelName="M"><ModelVariables>' +
        '<!-- <Float64 name="ghost" valueReference="9" causality="output"/> -->' +
        '<Int64 name="dim" valueReference="0" causality="structuralParameter" start="3"/>' +
        '</ModelVariables></fmiModelDescription>',
    );
    expect(parsed.variables.map((v) => v.name)).toEqual(['dim']); // ghost not parsed
    expect(parsed.variables[0].causality).toBe('parameter'); // structuralParameter → parameter
  });

  it('de-duplicates colliding value references and names', () => {
    const parsed = parseModelDescription(
      '<fmiModelDescription fmiVersion="3.0" modelName="M"><ModelVariables>' +
        '<Float64 name="x" valueReference="0" causality="input"/>' +
        '<Float64 name="x" valueReference="0" causality="output"/>' +
        '</ModelVariables></fmiModelDescription>',
    );
    expect(parsed.variables.map((v) => v.name)).toEqual(['x', 'x_2']);
    expect(new Set(parsed.variables.map((v) => v.valueReference)).size).toBe(2);
  });

  it('flags non-FMI input as invalid instead of inventing a block', () => {
    const parsed = parseModelDescription('just some random text, not xml at all');
    expect(parsed.valid).toBe(false);
    expect(parsed.variables).toEqual([]);
  });

  it('keeps empty / special / oversized numeric starts sane', () => {
    const m = new Model();
    const id = importFmiXml(
      m,
      '<fmiModelDescription fmiVersion="3.0" modelName="M"><ModelVariables>' +
        '<Float64 name="e" valueReference="0" causality="parameter" start=""/>' +
        '<Float64 name="inf" valueReference="1" causality="parameter" start="INF"/>' +
        '<Int64 name="big" valueReference="2" causality="parameter" start="9223372036854775807"/>' +
        '</ModelVariables></fmiModelDescription>',
    );
    const kids = Object.fromEntries(m.children(id).map((c) => [c.declaredName, c]));
    expect(kids.e.attrs.value).toBeUndefined(); // empty start ≠ 0
    expect(kids.inf.attrs.value).toBe('INF'); // xs:double special kept exact
    expect(kids.big.attrs.value).toBe('9223372036854775807'); // exact large int as string
  });

  it('reads modelDescription.xml back out of a STORED .fmu', () => {
    const src = vehicleBlock();
    const fmu = exportFmu(src.m, src.blockId);
    const xml = readModelDescriptionFromFmu(fmu.data);
    expect(parseModelDescription(xml).modelName).toBe('Vehicle');
  });
});
