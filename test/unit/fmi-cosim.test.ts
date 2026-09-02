import { describe, it, expect } from 'vitest';
import { Model } from '@core/index';
import { CoSimMaster, analyticFmu, sysmlBlockInstance } from '@interop/index';

/** An FMU that integrates its input: y' = u  ⇒  y += u·dt. */
function integrator(name = 'integ') {
  return analyticFmu(name, {
    inputs: ['u'],
    outputs: ['y'],
    doStep: (v, dt) => v.set('y', (v.get('y') ?? 0) + (v.get('u') ?? 0) * dt),
  });
}

/** A constant source with a single output `u`. */
function source(name: string, u: number) {
  return analyticFmu(name, { outputs: ['u'], initial: { u }, doStep: () => {} });
}

describe('analyticFmu', () => {
  it('assigns causality/value-references and steps its state function', () => {
    const f = integrator();
    const byName = Object.fromEntries(f.variables.map((v) => [v.name, v]));
    expect(byName.u.causality).toBe('input');
    expect(byName.y.causality).toBe('output');
    f.initialize();
    f.setReal(byName.u.valueReference, 2);
    f.doStep(0, 1);
    expect(f.getReal(byName.y.valueReference)).toBe(2);
    f.doStep(1, 1);
    expect(f.getReal(byName.y.valueReference)).toBe(4);
  });

  it('rejects a name reused across causalities (would alias one storage cell)', () => {
    expect(() => analyticFmu('bad', { inputs: ['x'], outputs: ['x'], doStep: () => {} })).toThrow(
      /duplicate variable name/i,
    );
  });

  it('ignores setReal on an output (no causality footgun) and preserves parameter overrides across initialize', () => {
    const f = analyticFmu('p', {
      parameters: { k: 1 },
      outputs: ['y'],
      doStep: (v) => v.set('y', v.get('k') ?? -1),
    });
    const vr = (n: string) => f.variables.find((v) => v.name === n)!.valueReference;
    f.setReal(vr('y'), 999); // output — must be ignored
    f.setReal(vr('k'), 42); // parameter — must survive initialize()
    f.initialize();
    f.doStep(0, 1);
    expect(f.getReal(vr('k'))).toBe(42);
    expect(f.getReal(vr('y'))).toBe(42);
  });
});

describe('CoSimMaster — coupled instances on one clock', () => {
  it('propagates a source output into an integrator input each step', () => {
    const master = new CoSimMaster();
    master.add(source('src', 2));
    master.add(integrator());
    master.connect('src', 'u', 'integ', 'u');

    const trace = master.run(5, 1);
    expect(trace.samples.length).toBe(6); // sample 0 (reset) + 5 steps
    const last = trace.samples[trace.samples.length - 1];
    expect(last.clock).toBe(5);
    expect(last.ok).toBe(true);
    expect(last.values.integ.y).toBe(10); // ∫ 2 dt over [0,5]
    expect(last.values.integ.u).toBe(2); // coupled from the source
  });

  it('errors clearly on an unknown instance / variable in a connection', () => {
    const master = new CoSimMaster();
    master.add(integrator());
    expect(() => master.connect('nope', 'u', 'integ', 'u')).toThrow(/no co-sim instance/i);
    expect(() => master.connect('integ', 'zzz', 'integ', 'u')).toThrow(/no variable/i);
  });

  it('rejects a miswired connection (into an output / from an input)', () => {
    const master = new CoSimMaster();
    master.add(source('src', 1));
    master.add(integrator());
    // target integ.y is an output — not settable
    expect(() => master.connect('src', 'u', 'integ', 'y')).toThrow(/must be an input/i);
    // source integ.u is an input — not a readable source
    expect(() => master.connect('integ', 'u', 'integ', 'u')).toThrow(/must be an output/i);
  });

  it('rejects a second driver on the same input', () => {
    const master = new CoSimMaster();
    master.add(source('a', 1));
    master.add(source('b', 2));
    master.add(integrator());
    master.connect('a', 'u', 'integ', 'u');
    expect(() => master.connect('b', 'u', 'integ', 'u')).toThrow(/already has a driver/i);
  });

  it('rejects a duplicate instance name instead of silently dropping one', () => {
    const master = new CoSimMaster();
    master.add(source('dup', 1));
    expect(() => master.add(source('dup', 2))).toThrow(/already registered/i);
  });

  it('validates dt in step() and run()', () => {
    const master = new CoSimMaster().add(integrator());
    master.reset();
    expect(() => master.step(Number.NaN)).toThrow(/positive finite/i);
    expect(() => master.step(-1)).toThrow(/positive finite/i);
    expect(() => master.run(10, 0)).toThrow(/positive finite/i);
    expect(() => master.run(-1, 1)).toThrow(/non-negative finite/i);
    // clock stays clean after the rejected steps
    expect(Number.isFinite(master.clock)).toBe(true);
  });

  it('lands the final sample exactly on `until` when dt does not divide it', () => {
    const master = new CoSimMaster().add(source('src', 1)).add(integrator());
    master.connect('src', 'u', 'integ', 'u');
    const trace = master.run(10, 3);
    const last = trace.samples[trace.samples.length - 1];
    expect(last.clock).toBe(10); // not 12
    expect(last.values.integ.y).toBe(10); // ∫ 1 dt over [0,10]
  });

  it('lands exactly on `until` for a decimal step size (no float drift at the horizon)', () => {
    const master = new CoSimMaster().add(source('src', 1)).add(integrator());
    master.connect('src', 'u', 'integ', 'u');
    const last = master.run(1, 0.1).samples.at(-1)!;
    expect(last.clock).toBe(1); // not 0.9999999999999999
    expect(last.values.integ.y).toBeCloseTo(1, 10);
  });

  it('still simulates the window when dt vastly exceeds until (eps not scaled by dt alone)', () => {
    const master = new CoSimMaster().add(source('src', 1)).add(integrator());
    master.connect('src', 'u', 'integ', 'u');
    const last = master.run(1, 2e9).samples.at(-1)!;
    expect(last.clock).toBe(1); // not silently stuck at 0
  });

  it('exchange is independent of connect() call order (two-phase Jacobi)', () => {
    const chain = (orderA: boolean) => {
      const m = new Model();
      const blk = m.create('PartDefinition', { declaredName: 'Gain' });
      m.create('PortUsage', { ownerId: blk.id, declaredName: 'u', attrs: { direction: 'in' } });
      m.create('PortUsage', { ownerId: blk.id, declaredName: 'y', attrs: { direction: 'out' } });
      m.create('ConstraintUsage', { ownerId: blk.id, declaredName: 'law', attrs: { expression: 'y = u * 3' } });
      const master = new CoSimMaster();
      master.add(source('src', 2));
      master.add(sysmlBlockInstance(m, blk.id)); // "Gain"
      master.add(integrator('acc'));
      if (orderA) {
        master.connect('src', 'u', 'Gain', 'u');
        master.connect('Gain', 'y', 'acc', 'u');
      } else {
        master.connect('Gain', 'y', 'acc', 'u');
        master.connect('src', 'u', 'Gain', 'u');
      }
      return master.run(3, 1).samples.map((s) => s.values.acc.y);
    };
    expect(chain(true)).toEqual(chain(false)); // identical regardless of wiring order
  });

  it('returned samples do not alias the master history (defensive copy)', () => {
    const master = new CoSimMaster().add(source('src', 1)).add(integrator());
    master.connect('src', 'u', 'integ', 'u');
    const s = master.run(2, 1).samples[1];
    s.values.integ.y = 999999; // mutate the handed-back sample
    const again = master.trace().samples[1];
    expect(again.values.integ.y).not.toBe(999999);
  });
});

describe('sysmlBlockInstance — a SysML block co-simulates as an FMU', () => {
  function gainBlock(law = 'y = u * 3') {
    const m = new Model();
    const blk = m.create('PartDefinition', { declaredName: 'Gain' });
    m.create('PortUsage', { ownerId: blk.id, declaredName: 'u', attrs: { direction: 'in' } });
    m.create('PortUsage', { ownerId: blk.id, declaredName: 'y', attrs: { direction: 'out' } });
    m.create('ConstraintUsage', { ownerId: blk.id, declaredName: 'law', attrs: { expression: law } });
    return { m, blockId: blk.id };
  }

  it('derives outputs from inputs via the parametric solver', () => {
    const { m, blockId } = gainBlock();
    const inst = sysmlBlockInstance(m, blockId);
    const vr = (n: string) => inst.variables.find((v) => v.name === n)!.valueReference;
    inst.initialize();
    inst.setReal(vr('u'), 4);
    inst.doStep(0, 1);
    expect(inst.getReal(vr('y'))).toBe(12);
    expect(inst.converged!()).toBe(true);
  });

  it('co-simulates a SysML block coupled to an analytic source', () => {
    const { m, blockId } = gainBlock();
    const master = new CoSimMaster();
    master.add(source('src', 5));
    master.add(sysmlBlockInstance(m, blockId)); // named "Gain"
    master.connect('src', 'u', 'Gain', 'u');

    const trace = master.run(1, 1);
    const last = trace.samples[trace.samples.length - 1];
    expect(last.values.Gain.y).toBe(15); // y = u·3, u driven to 5 by the source
  });

  it('keeps every captured sample self-consistent when the coupled input varies', () => {
    // A ramp source (u = t+1 each step) driving the gain block. Every row must
    // satisfy the block's own law y = 3·u for the u recorded in that same row.
    const { m, blockId } = gainBlock();
    const ramp = analyticFmu('ramp', {
      outputs: ['u'],
      initial: { u: 1 },
      doStep: (v, dt, t) => v.set('u', t + dt + 1),
    });
    const master = new CoSimMaster();
    master.add(ramp);
    master.add(sysmlBlockInstance(m, blockId));
    master.connect('ramp', 'u', 'Gain', 'u');
    const trace = master.run(4, 1);
    for (const s of trace.samples) {
      expect(s.values.Gain.y).toBe(3 * s.values.Gain.u); // law holds in every sample
    }
  });

  it('re-seeds declared start values on reset so re-runs restart cleanly', () => {
    const { m, blockId } = gainBlock();
    const inst = sysmlBlockInstance(m, blockId);
    const master = new CoSimMaster().add(inst);
    const vr = (n: string) => inst.variables.find((v) => v.name === n)!.valueReference;
    master.reset();
    inst.setReal(vr('u'), 5);
    master.step(1);
    expect(master.trace().samples[1].values.Gain.y).toBe(15);
    // A second reset must restart from the declared default (u start "0"), not u=5.
    const s0 = master.reset();
    expect(s0.values.Gain.u).toBe(0);
    expect(s0.values.Gain.y).toBe(0);
  });

  it('flags an infeasible solve as not-converged and reports NaN, not fabricated data', () => {
    const { m, blockId } = gainBlock('y * y = u'); // no real solution for u < 0
    const inst = sysmlBlockInstance(m, blockId);
    const vr = (n: string) => inst.variables.find((v) => v.name === n)!.valueReference;
    inst.initialize();
    inst.setReal(vr('u'), -4);
    inst.doStep(0, 1);
    expect(inst.converged!()).toBe(false);
  });

  it('excludes non-numeric (Boolean/String) ports from the co-sim surface', () => {
    const m = new Model();
    const blk = m.create('PartDefinition', { declaredName: 'Mixed' });
    m.create('PortUsage', { ownerId: blk.id, declaredName: 'u', attrs: { direction: 'in' } });
    m.create('PortUsage', { ownerId: blk.id, declaredName: 'y', attrs: { direction: 'out' } });
    m.create('ConstraintUsage', { ownerId: blk.id, declaredName: 'law', attrs: { expression: 'y = u * 2' } });
    // A Boolean input and a String input must NOT appear as co-sim variables.
    m.create('AttributeUsage', { ownerId: blk.id, declaredName: 'flag', attrs: { direction: 'in', type: 'Boolean' } });
    m.create('AttributeUsage', { ownerId: blk.id, declaredName: 'label', attrs: { direction: 'in', type: 'String' } });
    const inst = sysmlBlockInstance(m, blk.id);
    const names = inst.variables.map((v) => v.name);
    expect(names).toContain('u');
    expect(names).toContain('y');
    expect(names).not.toContain('flag');
    expect(names).not.toContain('label');
    inst.initialize();
    inst.setReal(inst.variables.find((v) => v.name === 'u')!.valueReference, 6);
    inst.doStep(0, 1);
    expect(inst.converged!()).toBe(true); // no laundered NaN dragging it down
    expect(inst.getReal(inst.variables.find((v) => v.name === 'y')!.valueReference)).toBe(12);
  });

  it('propagates a non-finite input as non-converged / NaN instead of laundering it', () => {
    const { m, blockId } = gainBlock();
    const inst = sysmlBlockInstance(m, blockId);
    const vr = (n: string) => inst.variables.find((v) => v.name === n)!.valueReference;
    inst.initialize();
    inst.setReal(vr('u'), Number.NaN);
    inst.doStep(0, 1);
    expect(inst.getReal(vr('u'))).toBeNaN(); // input preserved as NaN
    expect(inst.getReal(vr('y'))).toBeNaN(); // NOT a fabricated finite value
    expect(inst.converged!()).toBe(false);
  });
});
