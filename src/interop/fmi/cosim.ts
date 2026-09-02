/**
 * FMI co-simulation MASTER — orchestrate several {@link Fmi3Instance}s on one
 * shared clock, exchanging connected port values each step (a fixed-step Jacobi
 * master, the common FMI co-simulation scheme).
 *
 * An `Fmi3Instance` is the abstraction every co-simulated participant implements —
 * `set` inputs, `doStep(t, dt)`, `get` outputs, and optionally report whether its
 * last evaluation `converged`. Two participant kinds ship here:
 *  - {@link sysmlBlockInstance} — a SysML block driven by the parametric solver
 *    (its input ports are held while `solve` derives the outputs), so a SysML
 *    model co-simulates as a first-class FMU; and
 *  - {@link analyticFmu} — an in-TS FMU defined by a step function, for tests and
 *    for lightweight analytic components.
 *
 * A WebAssembly-compiled fmi3 FMU is the third kind: wrap its exported fmi3
 * functions (fmi3DoStep / fmi3GetFloat64 / fmi3SetFloat64) behind this same
 * `Fmi3Instance` interface and `add()` it to the master. That bridge is not
 * bundled — a browser cannot run the NATIVE binaries inside a standard `.fmu`
 * (only a wasm-compiled FMU has runnable code), so it requires a wasm FMU asset;
 * the interface below is the integration point for one.
 *
 * Semantics notes:
 *  - Coupling is Jacobi: within a step every instance advances on the inputs set
 *    by the PREVIOUS exchange, then outputs are propagated into inputs. Coupled
 *    signals therefore carry the standard one-step Jacobi lag between producer and
 *    consumer. Each captured sample is nonetheless internally self-consistent — a
 *    block's outputs always match the inputs recorded alongside them.
 *  - The clock accumulates `dt`; with non-power-of-two steps floating-point
 *    rounding can make an intermediate clock read e.g. 0.30000000000000004. `run`
 *    lands its final sample exactly on `until`.
 */

import { type ElementId, type Model } from '@core/index';
import { solve } from '@semantics/index';
import { fmiVariablesOf, type FmiVariable } from './model-description';

/** A co-simulated FMU instance (the fmi3 co-simulation subset this master uses). */
export interface Fmi3Instance {
  readonly name: string;
  /** The instance's variables (name ↔ valueReference ↔ causality). */
  readonly variables: FmiVariable[];
  /** Enter/exit initialization: compute a consistent initial output set. */
  initialize(): void;
  /** Advance internal state from `currentTime` by `stepSize`. */
  doStep(currentTime: number, stepSize: number): void;
  /** Read a real-valued variable by value reference. */
  getReal(valueReference: number): number;
  /** Set a real-valued input/parameter by value reference. */
  setReal(valueReference: number, value: number): void;
  /**
   * Whether the instance's current values are a valid (converged) evaluation.
   * Optional — a participant without a solve step is always considered converged.
   */
  converged?(): boolean;
  /** Free the instance. */
  terminate(): void;
}

/** A directed value coupling: `from` instance's output → `to` instance's input. */
export interface CoSimConnection {
  fromInstance: string;
  fromVr: number;
  toInstance: string;
  toVr: number;
}

/** One co-simulation time sample: every instance's variable values. */
export interface CoSimSample {
  step: number;
  clock: number;
  /** False if any instance reported a non-converged evaluation for this sample. */
  ok: boolean;
  /** instanceName → (variableName → value). */
  values: Record<string, Record<string, number>>;
}

export interface CoSimTrace {
  instances: string[];
  samples: CoSimSample[];
}

/** Deep-copy a sample so callers never alias the master's internal history. */
function cloneSample(s: CoSimSample): CoSimSample {
  const values: Record<string, Record<string, number>> = {};
  for (const k of Object.keys(s.values)) values[k] = { ...s.values[k] };
  return { step: s.step, clock: s.clock, ok: s.ok, values };
}

/* ─────────────────────────────── master ──────────────────────────────── */

export class CoSimMaster {
  private readonly instances = new Map<string, Fmi3Instance>();
  private readonly connections: CoSimConnection[] = [];
  private clockT = 0;
  private stepCount = 0;
  private samples: CoSimSample[] = [];

  /** Register an instance; its `name` must be unique across the master. */
  add(instance: Fmi3Instance): this {
    if (this.instances.has(instance.name))
      throw new Error(`A co-sim instance named "${instance.name}" is already registered.`);
    this.instances.set(instance.name, instance);
    return this;
  }

  /** Couple `fromInstance.fromVar` (an output) to `toInstance.toVar` (an input). */
  connect(fromInstance: string, fromVar: string, toInstance: string, toVar: string): this {
    const from = this.varOf(fromInstance, fromVar);
    const to = this.varOf(toInstance, toVar);
    if (from.causality !== 'output' && from.causality !== 'local')
      throw new Error(
        `connect: source "${fromInstance}.${fromVar}" must be an output (is "${from.causality}").`,
      );
    if (to.causality !== 'input' && to.causality !== 'parameter')
      throw new Error(
        `connect: target "${toInstance}.${toVar}" must be an input (is "${to.causality}").`,
      );
    if (this.connections.some((c) => c.toInstance === toInstance && c.toVr === to.valueReference))
      throw new Error(`connect: input "${toInstance}.${toVar}" already has a driver.`);
    this.connections.push({ fromInstance, fromVr: from.valueReference, toInstance, toVr: to.valueReference });
    return this;
  }

  /** Initialize every instance, propagate initial values, and capture sample 0. */
  reset(): CoSimSample {
    this.clockT = 0;
    this.stepCount = 0;
    this.samples = [];
    for (const inst of this.instances.values()) inst.initialize();
    this.propagate();
    return this.capture();
  }

  /** Advance all instances by `dt`, propagate coupled values, capture a sample. */
  step(dt = 1): CoSimSample {
    if (!Number.isFinite(dt) || dt <= 0)
      throw new Error(`step: dt must be a positive finite number (got ${dt}).`);
    for (const inst of this.instances.values()) inst.doStep(this.clockT, dt);
    this.clockT += dt;
    this.stepCount += 1;
    this.propagate();
    return this.capture();
  }

  /** Run from a fresh reset to exactly `until` in steps of `dt`, returning the series. */
  run(until: number, dt = 1): CoSimTrace {
    if (!Number.isFinite(dt) || dt <= 0)
      throw new Error(`run: dt must be a positive finite number (got ${dt}).`);
    if (!Number.isFinite(until) || until < 0)
      throw new Error(`run: until must be a non-negative finite number (got ${until}).`);
    this.reset();
    // Tolerance scaled by the window (not dt alone) so a huge dt cannot swallow
    // the whole horizon; the last full-ish step is clamped to `remaining` so the
    // final sample lands exactly on `until` even for decimal step sizes.
    const eps = Math.max(Math.abs(until), dt) * 1e-12;
    while (until - this.clockT > eps) {
      const remaining = until - this.clockT;
      this.step(remaining <= dt + eps ? remaining : dt);
    }
    return this.trace();
  }

  get clock(): number {
    return this.clockT;
  }

  trace(): CoSimTrace {
    return { instances: [...this.instances.keys()], samples: this.samples.map(cloneSample) };
  }

  /** Resolve a variable by name on an instance (unique-name checked). */
  private varOf(instanceName: string, varName: string): FmiVariable {
    const inst = this.instances.get(instanceName);
    if (!inst) throw new Error(`No co-sim instance named "${instanceName}".`);
    const matches = inst.variables.filter((x) => x.name === varName);
    if (matches.length === 0)
      throw new Error(`Instance "${instanceName}" has no variable "${varName}".`);
    if (matches.length > 1)
      throw new Error(`Instance "${instanceName}" has ${matches.length} variables named "${varName}" (ambiguous).`);
    return matches[0];
  }

  /** Copy each connected output into its coupled input (Jacobi exchange). */
  private propagate(): void {
    // Two-phase: read every coupled output from the pre-exchange state first,
    // then apply them — so a chain through a lazily-solved block settles the same
    // way regardless of the order connections were declared in.
    const pending: Array<{ to: Fmi3Instance; vr: number; value: number }> = [];
    for (const c of this.connections) {
      const from = this.instances.get(c.fromInstance);
      const to = this.instances.get(c.toInstance);
      if (from && to) pending.push({ to, vr: c.toVr, value: from.getReal(c.fromVr) });
    }
    for (const p of pending) p.to.setReal(p.vr, p.value);
  }

  private capture(): CoSimSample {
    const values: Record<string, Record<string, number>> = {};
    let ok = true;
    for (const inst of this.instances.values()) {
      const row: Record<string, number> = {};
      for (const v of inst.variables) row[v.name] = inst.getReal(v.valueReference);
      values[inst.name] = row;
      if (inst.converged && !inst.converged()) ok = false;
    }
    const sample: CoSimSample = { step: this.stepCount, clock: this.clockT, ok, values };
    this.samples.push(sample);
    return cloneSample(sample);
  }
}

/* ─────────────────────────── SysML block FMU ─────────────────────────── */

/**
 * Wrap a SysML block as an {@link Fmi3Instance} driven by the parametric solver:
 * input/parameter variables are held constant and {@link solve} derives the
 * outputs over the block's own constraint network. The block is algebraic (no
 * internal state), so outputs are re-solved lazily whenever a held input changes
 * — every read is consistent with the current inputs, and `converged()` reports
 * whether the last solve actually satisfied the constraints. This lets a SysML
 * model co-simulate alongside external FMUs on one clock.
 *
 * Only numeric (Float64/Int64) ports form the co-simulation surface — Boolean and
 * String features cannot be numerically co-simulated, so they are not exposed as
 * co-sim variables (a numeric solve would otherwise launder their starts).
 */
export function sysmlBlockInstance(model: Model, blockId: ElementId): Fmi3Instance {
  const variables = fmiVariablesOf(model, blockId).filter(
    (v) => v.type === 'Float64' || v.type === 'Int64',
  );
  const byVr = new Map(variables.map((v) => [v.valueReference, v]));
  const inputs = new Map<ElementId, number>(); // featureId → held value
  let solved = new Map<ElementId, number>();
  let solvedOk = true;
  let dirty = true;

  const seedInputs = (): void => {
    inputs.clear();
    for (const v of variables) {
      if ((v.causality === 'input' || v.causality === 'parameter') && v.start !== undefined) {
        const n = Number(v.start);
        if (Number.isFinite(n)) inputs.set(v.featureId, n);
      }
    }
    dirty = true;
  };

  const ensureSolved = (): void => {
    if (!dirty) return;
    // A non-finite held input cannot be a fixed override (solve filters it out),
    // which would silently launder into fabricated finite outputs — so flag the
    // step as non-converged and let those outputs read back as NaN.
    const hasNonFinite = [...inputs.values()].some((v) => !Number.isFinite(v));
    if (hasNonFinite) {
      solved = new Map();
      solvedOk = false;
    } else {
      const r = solve(model, { fixed: inputs, scopeId: blockId });
      solved = r.values;
      solvedOk = r.converged;
    }
    dirty = false;
  };

  seedInputs();

  return {
    name: model.get(blockId)?.declaredName || String(blockId),
    variables,
    initialize() {
      seedInputs(); // restore declared start values so re-runs restart cleanly
      ensureSolved();
    },
    doStep() {
      ensureSolved();
    },
    setReal(vr, value) {
      const v = byVr.get(vr);
      if (v && (v.causality === 'input' || v.causality === 'parameter')) {
        inputs.set(v.featureId, value);
        dirty = true;
      }
    },
    getReal(vr) {
      const v = byVr.get(vr);
      if (!v) return NaN;
      if (inputs.has(v.featureId)) return inputs.get(v.featureId)!;
      ensureSolved();
      return solved.get(v.featureId) ?? NaN;
    },
    converged() {
      ensureSolved();
      return solvedOk;
    },
    terminate() {
      inputs.clear();
      solved = new Map();
    },
  };
}

/* ───────────────────────────── analytic FMU ──────────────────────────── */

export interface AnalyticSpec {
  inputs?: string[];
  outputs?: string[];
  parameters?: Record<string, number>;
  /** Initial values (name → value); missing entries default to 0. */
  initial?: Record<string, number>;
  /**
   * Advance the internal state by `dt` at time `t`; read/write any variable by
   * name through `v`. Outputs must be written here (or in `initial`).
   */
  doStep: (v: Map<string, number>, dt: number, t: number) => void;
}

/**
 * An in-TS {@link Fmi3Instance} defined by a step function — for tests and for
 * lightweight analytic co-simulation components (e.g. an integrator).
 */
export function analyticFmu(name: string, spec: AnalyticSpec): Fmi3Instance {
  const inNames = spec.inputs ?? [];
  const outNames = spec.outputs ?? [];
  const paramNames = Object.keys(spec.parameters ?? {});
  const allNames = [...paramNames, ...inNames, ...outNames];
  const dup = allNames.find((n, i) => allNames.indexOf(n) !== i);
  if (dup) throw new Error(`analyticFmu "${name}": duplicate variable name "${dup}".`);

  const values = new Map<string, number>();

  // Sequential value references over parameters, inputs, then outputs.
  const variables: FmiVariable[] = [];
  let vr = 0;
  const add = (n: string, causality: FmiVariable['causality']): void => {
    variables.push({
      featureId: `${name}.${n}`,
      name: n,
      valueReference: vr++,
      type: 'Float64',
      causality,
      variability: causality === 'parameter' ? 'fixed' : 'continuous',
    });
  };
  for (const n of paramNames) add(n, 'parameter');
  for (const n of inNames) add(n, 'input');
  for (const n of outNames) add(n, 'output');
  const byVr = new Map(variables.map((v) => [v.valueReference, v]));
  const paramOverrides = new Map<string, number>(); // parameters set via setReal survive re-seed

  const seed = (): void => {
    values.clear();
    for (const [n, val] of Object.entries(spec.parameters ?? {})) values.set(n, val);
    for (const [n, val] of Object.entries(spec.initial ?? {})) values.set(n, val);
    for (const v of variables) if (!values.has(v.name)) values.set(v.name, 0);
    for (const [n, val] of paramOverrides) values.set(n, val);
  };
  seed();

  return {
    name,
    variables,
    initialize() {
      seed();
    },
    doStep(t, dt) {
      spec.doStep(values, dt, t);
    },
    getReal(ref) {
      const v = byVr.get(ref);
      return v ? values.get(v.name) ?? NaN : NaN;
    },
    setReal(ref, value) {
      const v = byVr.get(ref);
      if (!v) return;
      if (v.causality === 'input' || v.causality === 'parameter') {
        values.set(v.name, value);
        if (v.causality === 'parameter') paramOverrides.set(v.name, value);
      }
    },
    terminate() {
      values.clear();
      paramOverrides.clear();
    },
  };
}
