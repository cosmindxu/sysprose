import { describe, it, expect } from 'vitest';
import { Model, ModelFactory } from '@core/index';
import { fmiModelDescription, exportFmu, zipStore, crc32 } from '@interop/index';

/** Vehicle block: an input port, an output port, and a parameter attribute. */
function vehicleBlock() {
  const m = new Model();
  const f = new ModelFactory(m);
  const veh = m.create('PartDefinition', { declaredName: 'Vehicle' });
  m.create('PortUsage', { ownerId: veh.id, declaredName: 'throttle', attrs: { direction: 'in' } });
  m.create('PortUsage', { ownerId: veh.id, declaredName: 'power', attrs: { direction: 'out' } });
  f.attribute('mass', veh.id, { value: 1500 }); // directionless attribute → parameter
  return { m, blockId: veh.id };
}

describe('fmiModelDescription — SysML block → FMI 3.0', () => {
  it('maps port direction to causality and attributes to parameters', () => {
    const { m, blockId } = vehicleBlock();
    const md = fmiModelDescription(m, blockId);
    expect(md.modelName).toBe('Vehicle');
    expect(md.modelIdentifier).toBe('Vehicle');

    const byName = Object.fromEntries(md.variables.map((v) => [v.name, v]));
    expect(byName.throttle.causality).toBe('input');
    expect(byName.throttle.type).toBe('Float64');
    expect(byName.throttle.variability).toBe('continuous');
    expect(byName.power.causality).toBe('output');
    expect(byName.power.start).toBeUndefined(); // outputs are calculated
    expect(byName.mass.causality).toBe('parameter');
    expect(byName.mass.variability).toBe('fixed');
    expect(byName.mass.start).toBe('1500');

    // Value references are unique and sequential.
    expect(md.variables.map((v) => v.valueReference).sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });

  it('emits a valid FMI 3.0 XML skeleton with CoSimulation, variables and structure', () => {
    const { m, blockId } = vehicleBlock();
    const md = fmiModelDescription(m, blockId);
    expect(md.xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(md.xml).toContain('<fmiModelDescription fmiVersion="3.0" modelName="Vehicle"');
    expect(md.xml).toContain('<CoSimulation modelIdentifier="Vehicle"');
    expect(md.xml).toContain('<Float64 name="throttle"');
    expect(md.xml).toContain('causality="input"');
    expect(md.xml).toContain('<Float64 name="mass"');
    expect(md.xml).toContain('start="1500"');
    // power is valueReference 1 → an Output + an InitialUnknown.
    const power = md.variables.find((v) => v.name === 'power')!;
    expect(md.xml).toContain(`<Output valueReference="${power.valueReference}"/>`);
    expect(md.xml).toContain(`<InitialUnknown valueReference="${power.valueReference}"/>`);
  });

  it('sanitises an odd block name into a valid model identifier', () => {
    const m = new Model();
    const veh = m.create('PartUsage', { declaredName: '2 Wheel-Drive!' });
    const md = fmiModelDescription(m, veh.id);
    expect(md.modelName).toBe('2 Wheel-Drive!'); // preserved (escaped) in modelName
    expect(md.modelIdentifier).toBe('_2_Wheel_Drive_'); // a valid C identifier
    expect(md.xml).toContain('modelName="2 Wheel-Drive!"');
  });
});

describe('fmiModelDescription — type mapping, starts, initial', () => {
  const desc = (feat: Record<string, unknown>) => {
    const m = new Model();
    const veh = m.create('PartDefinition', { declaredName: 'B' });
    m.create('AttributeUsage', { ownerId: veh.id, ...feat });
    return fmiModelDescription(m, veh.id).variables[0];
  };

  it('maps integer/boolean/string type names, anchored (no loose "int" substring)', () => {
    expect(desc({ declaredName: 'n', attrs: { type: 'Integer', value: 3 } }).type).toBe('Int64');
    expect(desc({ declaredName: 'b', attrs: { type: 'Boolean', value: true } }).type).toBe('Boolean');
    expect(desc({ declaredName: 's', attrs: { type: 'String', value: 'hi' } }).type).toBe('String');
    expect(desc({ declaredName: 'r', attrs: { type: 'Real', value: 1.5 } }).type).toBe('Float64');
    // "LuminousIntensityValue" contains "int" but is NOT an integer type.
    expect(desc({ declaredName: 'li', attrs: { type: 'LuminousIntensityValue', value: 5 } }).type).toBe(
      'Float64',
    );
  });

  it('rounds a non-integer value for an Int64 start', () => {
    expect(desc({ declaredName: 'n', attrs: { type: 'Integer', value: 2.7 } }).start).toBe('3');
  });

  it('always emits a start for parameter and input (type default when no value)', () => {
    // Directionless attribute, no value → parameter with the type default start.
    expect(desc({ declaredName: 'p', attrs: {} }).start).toBe('0');
    expect(desc({ declaredName: 'bp', attrs: { type: 'Boolean' } }).start).toBe('false');
    expect(desc({ declaredName: 'i', attrs: { direction: 'in' } }).start).toBe('0'); // input default
  });

  it('gives an inout→local variable an explicit initial="exact" when it carries a start', () => {
    const v = desc({ declaredName: 'io', attrs: { direction: 'inout', value: 2 } });
    expect(v.causality).toBe('local');
    expect(v.start).toBe('2');
    expect(v.initial).toBe('exact');
  });

  it('falls back to declaredShortName for an unnamed feature; empty block is valid', () => {
    const m = new Model();
    const b = m.create('PartDefinition', { declaredName: 'Empty' });
    expect(fmiModelDescription(m, b.id).variables.length).toBe(0);
    m.create('AttributeUsage', { ownerId: b.id, declaredShortName: 'k', attrs: { value: 1 } });
    expect(fmiModelDescription(m, b.id).variables[0].name).toBe('k');
  });
});

describe('zipStore — STORED zip / CRC-32', () => {
  it('CRC-32 matches the standard "123456789" vector', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('writes a spec-shaped archive that round-trips a single entry', () => {
    const data = new TextEncoder().encode('hello fmu');
    const zip = zipStore([{ name: 'a.txt', data }]);
    // Local file header signature PK\x03\x04.
    expect([...zip.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    // Name + data follow the fixed 30-byte local header.
    const nameLen = zip[26] | (zip[27] << 8);
    expect(new TextDecoder().decode(zip.slice(30, 30 + nameLen))).toBe('a.txt');
    expect(new TextDecoder().decode(zip.slice(30 + nameLen, 30 + nameLen + data.length))).toBe(
      'hello fmu',
    );
    // End-of-central-directory signature PK\x05\x06 (22-byte EOCD, no comment).
    expect([...zip.slice(-22, -18)]).toEqual([0x50, 0x4b, 0x05, 0x06]);
  });
});

/** Decode a STORED zip via its central directory, verifying each entry's CRC-32. */
function unzip(bytes: Uint8Array): Record<string, Uint8Array> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Locate the End Of Central Directory (no comment → last 22 bytes).
  const eocd = bytes.length - 22;
  expect(dv.getUint32(eocd, true)).toBe(0x06054b50);
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true); // central directory offset
  const out: Record<string, Uint8Array> = {};
  for (let i = 0; i < count; i++) {
    expect(dv.getUint32(p, true)).toBe(0x02014b50); // central dir header
    const crc = dv.getUint32(p + 16, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const lho = dv.getUint32(p + 42, true); // local header offset
    const name = new TextDecoder().decode(bytes.slice(p + 46, p + 46 + nameLen));
    // Data follows the local header (30 bytes + its own name + extra fields).
    const lNameLen = dv.getUint16(lho + 26, true);
    const lExtraLen = dv.getUint16(lho + 28, true);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    const data = bytes.slice(dataStart, dataStart + size);
    expect(crc32(data)).toBe(crc); // integrity: stored CRC matches recomputed
    out[name] = data;
    p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
  return out;
}

describe('exportFmu — .fmu archive', () => {
  it('packages modelDescription.xml into a PK zip named after the model', () => {
    const { m, blockId } = vehicleBlock();
    const fmu = exportFmu(m, blockId);
    expect(fmu.fileName).toBe('Vehicle.fmu');
    expect([...fmu.data.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(fmu.description.variables.length).toBe(3);
  });

  it('produces a decodable archive (central directory + CRC) with both entries', () => {
    const { m, blockId } = vehicleBlock();
    const fmu = exportFmu(m, blockId);
    const entries = unzip(fmu.data);
    expect(Object.keys(entries).sort()).toEqual(['documentation/generated.txt', 'modelDescription.xml']);
    const xml = new TextDecoder().decode(entries['modelDescription.xml']);
    expect(xml).toBe(fmu.description.xml); // round-trips byte-for-byte
    expect(xml).toContain('<fmiModelDescription fmiVersion="3.0"');
  });
});
