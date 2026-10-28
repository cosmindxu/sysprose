import { afterEach, describe, it, expect, vi } from 'vitest';
import { Model, ModelFactory } from '@core/index';
import { fmiModelDescription, exportFmu, zipStore, crc32 } from '@interop/index';
import { instanceIndexSeam } from '../../src/semantics/defining-equation';
import { parseModel } from '@text/index';

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

describe('fmiModelDescription — <BaseUnit> carries the conversion, not just the dimension', () => {
  /** A block whose attributes exercise every shape of unit. */
  function unitBlock() {
    const m = new Model();
    const blk = m.create('PartDefinition', { declaredName: 'Pack' });
    const attr = (name: string, value: number, unit: string) =>
      m.create('AttributeUsage', {
        declaredName: name,
        ownerId: blk.id,
        attrs: { type: 'Real', value, unit },
      });
    attr('capacity', 640, 'Wh'); // non-coherent: 3600 J
    attr('range', 25, 'km'); // prefixed: 1000 m
    attr('cycle', 45, 'min'); // 60 s
    attr('ambient', 20, '°C'); // affine: offset 273.15
    attr('mass', 3.4, 'kg'); // coherent: no factor, no offset
    attr('storage', 512, 'B'); // dimension one, factor 8
    attr('bits', 8, 'bit'); // dimension one, factor 1
    attr('link', 100, 'Mbit/s'); // compound: T⁻¹, factor 1e6
    attr('gain', 20, 'dB'); // LOGARITHMIC: not a registry unit at all
    attr('speed', 3, 'm/SI::s'); // qualified atom inside an expression
    return { m, blockId: blk.id };
  }

  it('emits factor and offset from the resolved unit', () => {
    const { m, blockId } = unitBlock();
    const md = fmiModelDescription(m, blockId);
    const byName = Object.fromEntries(md.units.map((u) => [u.name, u]));

    // Before this, `640 [Wh]` was exported as a <BaseUnit kg m s> with no
    // factor — an importer read it as 640 joules.
    expect(byName.Wh.factor).toBe(3600);
    expect(byName.km.factor).toBe(1000);
    expect(byName.min.factor).toBe(60);
    expect(byName['°C'].offset).toBe(273.15);
    expect(byName['°C'].factor).toBeUndefined(); // factor 1 is the default
    expect(byName.kg.factor).toBeUndefined();
    expect(byName.kg.offset).toBeUndefined();
    expect(byName['Mbit/s'].factor).toBe(1e6);

    expect(md.xml).toContain('<Unit name="Wh"><BaseUnit kg="1" m="2" s="-2" factor="3600"/></Unit>');
    expect(md.xml).toContain('<Unit name="°C"><BaseUnit K="1" offset="273.15"/></Unit>');
    expect(md.xml).toContain('<Unit name="kg"><BaseUnit kg="1"/></Unit>');
  });

  it('a dimension-one information unit exports with no base exponents', () => {
    const { m, blockId } = unitBlock();
    const md = fmiModelDescription(m, blockId);
    // ISO 80000-13 makes information content dimension one, so there is no
    // exponent to emit — a byte is still eight bits, which the factor carries.
    expect(md.xml).toContain('<Unit name="B"><BaseUnit factor="8"/></Unit>');
    // A bit is the reference itself: dimension one, factor one, nothing to say.
    expect(md.xml).toContain('<Unit name="bit"/>');
    // A bit RATE is T⁻¹ — the same dimension as a frequency.
    expect(md.xml).toContain('<Unit name="Mbit/s"><BaseUnit s="-1" factor="1000000"/></Unit>');
  });

  it('an unresolved unit exports bare, with no invented conversion', () => {
    const { m, blockId } = unitBlock();
    const md = fmiModelDescription(m, blockId);
    // The decibel is a logarithmic ratio, not a linear registry unit. It must
    // not decompose as deci + byte: `<BaseUnit factor="0.8"/>` would tell an
    // importer that 20 dB is 16 of something.
    expect(md.xml).toContain('<Unit name="dB"/>');
    expect(md.xml).not.toContain('name="dB"><BaseUnit');
  });

  it('a qualified atom inside an expression keeps the whole dimension', () => {
    const { m, blockId } = unitBlock();
    const md = fmiModelDescription(m, blockId);
    // `m/SI::s` is a speed. Cutting the whole string at its last `::` used to
    // export it as `<BaseUnit s="1"/>` — a duration.
    expect(md.xml).toContain('<Unit name="m/SI::s"><BaseUnit m="1" s="-1"/></Unit>');
  });
});

/*
 * text-order S2: a feature two asserted equations give two values has no start of its own. `evaluateFeatureValue`
 * returns the first equation written, so the export wrote 50 or 60 as `L`'s start by the order of the text
 * (the soft/hard analysis' `reconcile/n-ab.sysml` and `n-ba.sysml`), and a value tied to it the arithmetic over
 * that: 100 or 120.
 */
describe('fmiModelDescription — a feature two asserted equations give two values', () => {
  afterEach(() => vi.restoreAllMocks());
  const GEN = { generationDate: '2026-01-01T00:00:00Z' };
  /** The description of part def P in `body`'s package. */
  const describeP = (body: string) => {
    const { model: m, diagnostics } = parseModel(`package RN { part def P { ${body} } }`);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const p = m.all().find((e) => e.eClass === 'PartDefinition' && e.declaredName === 'P')!;
    return fmiModelDescription(m, p.id, GEN);
  };
  const starts = (md: ReturnType<typeof describeP>) => Object.fromEntries(md.variables.map((v) => [v.name, v.start]));
  const L = 'attribute L : ScalarValues::Real;';
  const AB = 'assert constraint c50 { L == 50.0 } assert constraint c60 { L == 60.0 }';
  const BA = 'assert constraint c60 { L == 60.0 } assert constraint c50 { L == 50.0 }';

  it('gives L the type default in either order, the same description', () => {
    const ab = describeP(`${L} ${AB}`);
    const ba = describeP(`${L} ${BA}`);
    expect(starts(ab)).toEqual({ L: '0' });
    expect(starts(ba)).toEqual({ L: '0' });
    // Apart from the token each export draws.
    const bare = (xml: string) => xml.replace(/instantiationToken="[^"]*"/, '');
    expect(bare(ba.xml)).toBe(bare(ab.xml));
    expect(ab.xml).toContain('<Float64 name="L" valueReference="0" causality="parameter" variability="fixed" start="0"');
  });

  it('gives a value tied to it none either: derived from it, or an input', () => {
    for (const eqs of [AB, BA]) {
      const md = describeP(
        `${L} attribute W : ScalarValues::Real; in attribute I : ScalarValues::Real; ${eqs} ` +
          'assert constraint cw { W == 2.0 * L } assert constraint ci { I == L + 1.0 }',
      );
      expect(starts(md)).toEqual({ L: '0', W: '0', I: '0' });
    }
  });

  it('leaves a local without a start and without initial="exact"', () => {
    for (const eqs of [AB, BA]) {
      const md = describeP(`inout attribute L : ScalarValues::Real; ${eqs}`);
      expect(md.variables[0]).toMatchObject({ name: 'L', causality: 'local', start: undefined, initial: undefined });
    }
  });

  it('gives a Boolean pair the type default in either order', () => {
    for (const eqs of ['assert constraint a { f == true } assert constraint b { f == false }', 'assert constraint b { f == false } assert constraint a { f == true }']) {
      const md = describeP(`attribute f : ScalarValues::Boolean; ${eqs}`);
      expect(md.variables[0]).toMatchObject({ name: 'f', type: 'Boolean', start: 'false' });
    }
  });

  it('keeps the start of a feature the equations do not reach, and of one that is written', () => {
    for (const eqs of [AB, BA]) {
      const md = describeP(`${L} attribute K : ScalarValues::Real = 7.0; attribute B : ScalarValues::Boolean = true; ${eqs}`);
      expect(starts(md)).toEqual({ L: '0', K: '7', B: 'true' });
    }
  });

  it('still reads the start from equations that agree or from one', () => {
    for (const body of [
      `${L} assert constraint c50 { L == 50.0 }`,
      `${L} assert constraint c50 { L == 50.0 } assert constraint c50b { L == 50.0 }`,
      `${L} assert constraint c50 { L == 50.0 } assert constraint c25 { L == 25.0 * 2.0 }`,
    ]) {
      expect(starts(describeP(body)), body).toEqual({ L: '50' });
    }
  });

  it('flags a withheld start, so a co-simulation holds no input at the placeholder', () => {
    const md = describeP(`${L} attribute K : ScalarValues::Real = 7.0; inout attribute T : ScalarValues::Real; ${AB} assert constraint ct { T == 2.0 * L }`);
    const by = Object.fromEntries(md.variables.map((v) => [v.name, v]));
    expect(by.L).toMatchObject({ start: '0', startWithheld: true });
    // A written value and a local carry no flag; a local carries no start either.
    expect('startWithheld' in by.K).toBe(false);
    expect(by.T).toMatchObject({ causality: 'local', start: undefined });
    expect('startWithheld' in by.T).toBe(false);
  });

  it('falls to the default in a definition whose own equation is consistent while a usage elsewhere contradicts it', () => {
    // The abstention is by feature, not by instance (TODO: narrow it): P::load keeps no start although P alone
    // states load == 1.0, and nothing else says so. A lost reading, never a value that turns on the text.
    const { model: m } = parseModel(
      'package RN { part def P { attribute load : ScalarValues::Real; assert constraint c1 { load == 1.0 } } ' +
        'part def Q { part p : P { attribute :>> load; assert constraint c50 { load == 50.0 } } } }',
    );
    const p = m.all().find((e) => e.eClass === 'PartDefinition' && e.declaredName === 'P')!;
    expect(fmiModelDescription(m, p.id, GEN).variables.map((v) => [v.name, v.start, v.startWithheld])).toEqual([['load', '0', true]]);
  });

  it('keeps a written literal where the listing of the equations threw, and withholds the rest', () => {
    vi.spyOn(instanceIndexSeam, 'contradictedDefinitions').mockImplementation(() => {
      throw new RangeError('contradictedDefinitions, planted to throw');
    });
    const md = describeP(
      `${L} attribute M : ScalarValues::Real; attribute K : ScalarValues::Real = 7.0; attribute B : ScalarValues::Boolean = true; ` +
        `attribute S : ScalarValues::String = "abc"; attribute X : ScalarValues::Real = 2.0 * 3.0; ` +
        `${AB} assert constraint cm { M == 3.0 }`,
    );
    // Which features the pair reaches is unknown, so each an equation gives its value is read as one with no
    // value (not the first equation written); a number, a Boolean or a quoted String written reads no name, so
    // no equation reaches it. An expression written is withheld there: what it reads is unknown.
    expect(starts(md)).toEqual({ L: '0', M: '0', K: '7', B: 'true', S: 'abc', X: '0' });
  });
});
