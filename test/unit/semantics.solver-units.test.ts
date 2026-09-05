/**
 * The numeric surface judges WITH units (I6) — a number-level agreement suite.
 *
 * Before this, `solve()` was a scalar fixpoint over raw magnitudes in whatever
 * unit each feature happened to declare: `640 [Wh]` beside `650 [W]` beside
 * `45 [min]` solved to 640/650 = 0.98 and `checkConstraintsNumeric` called the
 * endurance requirement VIOLATED while the unit-aware `checkConstraints` called
 * it satisfied — two verdicts for one model, one of them wrong. A constraint
 * body carrying a `[unit]` literal vanished from the numeric list entirely.
 *
 * The assertions here are deliberately about NUMBERS (solved values, slack and
 * its unit, convergence, feasibility), not only verdicts: once the numeric
 * verdict is taken from the unit-aware evaluator, verdict-level agreement is
 * tautological and cannot see a wrong solved value (5 km + 400 m = 405) or a
 * vacuously "converged" nanosecond system.
 */
import { describe, it, expect } from 'vitest';
import { Model } from '@core/index';
import { parseModel } from '@text/index';
import { checkConstraints, simulateStateMachine } from '@semantics/index';
import {
  checkConstraintsNumeric,
  evaluateMoEs,
  optimize,
  solve,
  solveFeasible,
} from '@semantics/solver';
import { analysisReport } from '@api/index';

/** Parse a source with no library binding (ISQ kinds resolve by name). */
function parse(src: string): Model {
  const { model, diagnostics } = parseModel(src);
  const errors = diagnostics.filter((d) => d.severity === 'error');
  expect(errors.map((d) => d.message)).toEqual([]);
  return model;
}

/** The verdicts of both surfaces, in model order. */
const unitAware = (m: Model): string[] => checkConstraints(m).map((c) => c.result);
const numeric = (m: Model): string[] => checkConstraintsNumeric(m).map((c) => c.result);
/** The single numeric row of a one-constraint model. */
const only = (m: Model) => {
  const rows = checkConstraintsNumeric(m);
  expect(rows).toHaveLength(1);
  return rows[0];
};
/** The solved value of the named feature. */
function solvedOf(m: Model, name: string): number | undefined {
  const el = m.all().find((e) => e.declaredName === name && e.attrs.isLibrary !== true);
  expect(el, `no feature named ${name}`).toBeDefined();
  return solve(m).values.get(el!.id);
}

/** A requirement over one part `v : V` whose body is `body`. */
const req = (attrs: string, body: string) => `package P {
    part def V {
${attrs}
    }
    part v : V;
    requirement def R { subject v : V; require constraint { ${body} } }
}
`;

describe('dimensioned constraints agree on both surfaces', () => {
  it('(a) 640 [Wh] / 650 [W] >= 45 [min] — satisfied, slack in seconds', () => {
    const m = parse(
      req(
        `        attribute capacity : ISQ::EnergyValue = 640.0 [Wh];
        attribute power : ISQ::PowerValue = 650.0 [W];
        attribute minEndurance : ISQ::DurationValue = 45.0 [min];`,
        'v.capacity / v.power >= v.minEndurance',
      ),
    );
    expect(unitAware(m)).toEqual(['satisfied']);
    const row = only(m);
    expect(row.result).toBe('satisfied');
    // 640 Wh = 2 304 000 J at 650 W lasts 3544.6 s; the bound is 2700 s.
    expect(row.slack).toBeCloseTo(3544.615384 - 2700, 4);
    expect(row.slackUnit).toBe('s');
    expect(row.amount).toBe(0);
  });

  it('(b) 640 [Wh] <= 3 [MJ] — satisfied, slack in joules', () => {
    const m = parse(
      req(
        `        attribute capacity : ISQ::EnergyValue = 640.0 [Wh];
        attribute budget : ISQ::EnergyValue = 3.0 [MJ];`,
        'v.capacity <= v.budget',
      ),
    );
    expect(unitAware(m)).toEqual(['satisfied']);
    const row = only(m);
    expect(row.result).toBe('satisfied');
    expect(row.slack).toBeCloseTo(3e6 - 2.304e6, 3);
    expect(row.slackUnit).toBe('J');
  });

  it('(c) 5 [km] >= 4000 [m] — satisfied, slack in metres', () => {
    const m = parse(
      req(
        `        attribute range : ISQ::LengthValue = 5.0 [km];
        attribute floor : ISQ::LengthValue = 4000.0 [m];`,
        'v.range >= v.floor',
      ),
    );
    expect(unitAware(m)).toEqual(['satisfied']);
    const row = only(m);
    expect(row.result).toBe('satisfied');
    expect(row.slack).toBeCloseTo(1000, 6);
    expect(row.slackUnit).toBe('m');
  });
});

describe('solved VALUES carry the conversion, not only the verdict', () => {
  const legs = (extra = '') => `package P {
    part def V {
        attribute leg1 : ISQ::LengthValue = 5.0 [km];
        attribute leg2 : ISQ::LengthValue = 400.0 [m];
        attribute totalMeasure : ISQ::LengthValue;${extra}
        constraint total { totalMeasure == leg1 + leg2 }
    }
    part v : V;
}
`;

  it('(d) 5 km + 400 m solves to 5400 m, not 405', () => {
    const m = parse(legs());
    expect(solvedOf(m, 'totalMeasure')).toBeCloseTo(5400, 6);
    expect(numeric(m)).toEqual(['satisfied']);
    expect(only(m).slack).toBeCloseTo(0, 9);
  });

  it('(d) the same unknown declaring [km] reads back 5.4 (storage units)', () => {
    const m = parse(legs());
    const total = m.all().find((e) => e.declaredName === 'totalMeasure')!;
    // The grammar cannot state a unit without a value, so the [km] storage unit
    // is set the way a programmatic/API author would (probe P7).
    m.setAttrs(total.id, { unit: 'km' });
    expect(solve(m).values.get(total.id)).toBeCloseTo(5.4, 9);
    expect(numeric(m)).toEqual(['satisfied']);
  });

  it('(m) evaluateMoEs labels a unit-less kinded measure with its coherent SI symbol', () => {
    const m = parse(legs());
    const moe = evaluateMoEs(m).find((x) => x.name === 'totalMeasure');
    expect(moe).toBeDefined();
    expect(moe!.value).toBeCloseTo(5400, 6);
    // The value is in metres, so the label must say metres — not nothing.
    expect(moe!.unit).toBe('m');
    expect(moe!.dimension).toBe('L');
  });

  it('(n) a simulation sample reports the same converted value', () => {
    const m = parse(`package P {
    part def V {
        attribute leg1 : ISQ::LengthValue = 5.0 [km];
        attribute leg2 : ISQ::LengthValue = 400.0 [m];
        attribute totalMeasure : ISQ::LengthValue;
        constraint total { totalMeasure == leg1 + leg2 }
        state def Modes { state idle; state busy; transition idle -> busy; }
    }
    part v : V;
}
`);
    const sm = m.ofKind('StateDefinition')[0];
    const trace = simulateStateMachine(m, sm.id, [], { solve: true });
    expect(trace.samples[0].solved?.totalMeasure).toBeCloseTo(5400, 6);
  });
});

describe('the bare-literal contract survives', () => {
  it('(e) `range = 5 [km]` against a bare `<= 10.0` stays satisfied on both surfaces', () => {
    const m = parse(req('        attribute range : ISQ::LengthValue = 5.0 [km];', 'v.range <= 10.0'));
    expect(unitAware(m)).toEqual(['satisfied']);
    const row = only(m);
    expect(row.result).toBe('satisfied');
    // Unscaled: the literal is read in the feature's declared unit, so the
    // slack is 5 km and carries no SI label.
    expect(row.slack).toBeCloseTo(5, 9);
    expect(row.slackUnit).toBeUndefined();
  });
});

describe('constraint bodies carrying a unit literal are judged, never dropped', () => {
  it('(f) `mass <= 2000 [kg]` on a 2500 kg mass is violated, not absent', () => {
    const m = parse(
      req('        attribute mass : ISQ::MassValue = 2500.0 [kg];', 'v.mass <= 2000.0 [kg]'),
    );
    expect(unitAware(m)).toEqual(['violated']);
    expect(numeric(m)).toEqual(['violated']);
    const row = only(m);
    expect(row.kind).toBe('inequality');
    expect(row.amount).toBeCloseTo(500, 6);
    expect(row.slackUnit).toBe('kg');
  });

  it('(l) analysisReport is infeasible for it, and feasible for the endurance case', () => {
    const bad = parse(
      req('        attribute mass : ISQ::MassValue = 2500.0 [kg];', 'v.mass <= 2000.0 [kg]'),
    );
    const badReport = analysisReport(bad);
    expect(badReport.feasible).toBe(false);
    expect(badReport.violations.map((v) => v.expression)).toEqual(['v.mass <= 2000.0 [kg]']);
    expect(badReport.violations[0].unit).toBe('kg');

    const good = parse(
      req(
        `        attribute capacity : ISQ::EnergyValue = 640.0 [Wh];
        attribute power : ISQ::PowerValue = 650.0 [W];
        attribute minEndurance : ISQ::DurationValue = 45.0 [min];`,
        'v.capacity / v.power >= v.minEndurance',
      ),
    );
    const report = analysisReport(good);
    expect(report.feasible).toBe(true);
    expect(report.violations).toEqual([]);
  });

  it('(g) a unit the registry does not know answers unknown, with the reason', () => {
    const m = parse(
      req('        attribute range : ISQ::LengthValue = 5.0 [km];', 'v.range >= 4.0 [furlong]'),
    );
    expect(unitAware(m)).toEqual(['unknown']);
    const row = only(m);
    expect(row.result).toBe('unknown');
    expect(row.slack).toBeNull();
    expect(row.reason).toMatch(/furlong/);
  });

  it('an ASSIGNMENT value carrying a unit literal is solved, not left unknown', () => {
    // `= count * 3.0 [kg]` used to throw in the scalar parser, leaving `total`
    // with no value at all and the requirement absent from the numeric list.
    const m = parse(`package P {
    part def V {
        attribute count : Real = 2.0;
        attribute total : ISQ::MassValue = count * 3.0 [kg];
    }
    part v : V;
    requirement def R { subject v : V; require constraint { v.total <= 5.0 [kg] } }
}
`);
    expect(solvedOf(m, 'total')).toBeCloseTo(6, 9);
    expect(unitAware(m)).toEqual(['violated']);
    const row = only(m);
    expect(row.result).toBe('violated');
    expect(row.amount).toBeCloseTo(1, 9);
    expect(row.slackUnit).toBe('kg');
  });

  it('(j) `1 [ft] == 12 [in]` is satisfied on both (registry float noise absorbed)', () => {
    const m = parse(
      req('        attribute z : Real = 1.0;', "1.0 [ft] == 12.0 ['in']"),
    );
    expect(unitAware(m)).toEqual(['satisfied']);
    expect(numeric(m)).toEqual(['satisfied']);
  });
});

describe('refusals stay refusals on the numeric surface', () => {
  it('(h) °C arithmetic answers unknown on BOTH surfaces, never a confident number', () => {
    const m = parse(
      req(
        `        attribute t1 : ISQ::TemperatureValue = 20.0 ['°C'];
        attribute t2 : ISQ::TemperatureValue = 30.0 ['°C'];
        attribute dT : ISQ::TemperatureValue = 10.0 ['°C'];`,
        'v.dT == v.t2 - v.t1',
      ),
    );
    expect(unitAware(m)).toEqual(['unknown']);
    const row = only(m);
    expect(row.result).toBe('unknown');
    expect(row.reason).toMatch(/offset temperature scale/);
  });

  it('(h) but two absolute temperatures may still be ordered', () => {
    const m = parse(
      req(
        `        attribute t2 : ISQ::TemperatureValue = 30.0 ['°C'];`,
        'v.t2 >= 300.0 [K]',
      ),
    );
    expect(unitAware(m)).toEqual(['satisfied']);
    expect(numeric(m)).toEqual(['satisfied']);
  });

  it('the factor-60 hand conversion is refused numerically too', () => {
    // `Real = capacity * fraction / power * 60.0` derives to a DURATION while
    // claiming to be a plain number: scaling it would report 170 141 s.
    const m = parse(`package P {
    part def V {
        attribute capacity : ISQ::EnergyValue = 640.0 [Wh];
        attribute power : ISQ::PowerValue = 650.0 [W];
        attribute usableEnergyFraction : Real = 0.8;
        attribute enduranceMin : Real = capacity * usableEnergyFraction / power * 60.0;
    }
    part v : V;
    requirement def R { subject v : V; require constraint { v.enduranceMin >= 45.0 [min] } }
}
`);
    expect(unitAware(m)).toEqual(['unknown']);
    expect(only(m).result).toBe('unknown');
    // The solved value keeps the author's (unscaled) arithmetic — 47.26 min.
    expect(solvedOf(m, 'enduranceMin')).toBeCloseTo(47.2615384, 5);
  });
});

describe('unitless behaviour is unchanged', () => {
  it('(i) a Newton-solved equality stays satisfied within tolerance', () => {
    const m = parse(`package P {
    part def V { attribute x : Real; attribute k : Real = 2.0; constraint c1 { x * x == k } }
    part v : V;
}
`);
    expect(solvedOf(m, 'x')).toBeCloseTo(Math.SQRT2, 9);
    expect(numeric(m)).toEqual(['satisfied']);
  });

  it('(k) a nanosecond system is violated and does NOT vacuously converge', () => {
    const m = parse(
      req(
        `        attribute t : ISQ::DurationValue = 5.0 [ns];
        attribute u : ISQ::DurationValue = 3.0 [ns];`,
        'v.t == v.u',
      ),
    );
    expect(unitAware(m)).toEqual(['violated']);
    expect(numeric(m)).toEqual(['violated']);
    // 2 ns is 2e-9 in SI — under the 1e-6 ABSOLUTE convergence gate, which is
    // why a scaled equation is judged against its own scale instead.
    expect(solve(m).converged).toBe(false);
  });
});

describe('bindings convert into the target feature storage unit', () => {
  it('(o) `bind a = b` fills a unit-less kinded feature in SI and a Real raw', () => {
    const m = parse(`package P {
    part def V {
        attribute a : ISQ::LengthValue = 5.0 [km];
        attribute b : ISQ::LengthValue;
        attribute r : Real;
        bind a = b;
        bind a = r;
    }
    part v : V;
}
`);
    // b has a dimension (LengthValue) but no unit, so it stores SI metres.
    expect(solvedOf(m, 'b')).toBeCloseTo(5000, 6);
    // r has no dimension at all: the magnitude is copied verbatim.
    expect(solvedOf(m, 'r')).toBeCloseTo(5, 9);
  });
});

/* ══════════════════ review findings — gates, scales, labels ═══════════════ */

/**
 * The gates decide with DIMENSIONS, not with a boolean "is this dimensioned".
 * Comparing two operands that merely both carry a dimension is precisely the
 * question the unit-aware evaluator refuses, so SI-scaling it publishes a
 * confident verdict against a refusal — and, worse, the OPPOSITE verdict from
 * the validation surface (5000 >= 3000 where 5 >= 3000 is false).
 *
 * Not scaling it is only half the answer, though: the relation was still JUDGED
 * from the declared magnitudes (5 against 3000), which is the same wrong
 * verdict one conversion earlier. Since the `dimension-clash` refusal, neither
 * surface answers it at all.
 */
describe('two different dimensions are not a comparison the solver may answer', () => {
  const lengthVsDuration = (op: string) =>
    req(
      `        attribute d : ISQ::LengthValue = 5.0 [km];
        attribute t : ISQ::DurationValue = 3000.0 [s];`,
      `v.d ${op} v.t`,
    );

  it('`v.d >= v.t` (a length against a duration) is refused, not judged, on both surfaces', () => {
    const m = parse(lengthVsDuration('>='));
    expect(unitAware(m)).toEqual(['unknown']);
    expect(numeric(m)).toEqual(['unknown']);
    const row = only(m);
    expect(row.reason).toMatch(/L and T are different physical dimensions/);
    // No slack columns: 5 − 3000 is a subtraction of unrelated magnitudes.
    expect(row.slack).toBeNull();
    expect(row.amount).toBe(0);
    expect(row.slackUnit).toBeUndefined();
    // An unknown is reported as one, never folded into feasibility.
    const report = analysisReport(m);
    expect(report.unknowns).toHaveLength(1);
    expect(report.violations).toEqual([]);
    expect(report.feasible).toBe(true);
  });

  it('and so does the `<=` mirror — the refusal does not turn on which magnitude is larger', () => {
    const m = parse(lengthVsDuration('<='));
    expect(unitAware(m)).toEqual(['unknown']);
    expect(numeric(m)).toEqual(['unknown']);
    expect(only(m).slack).toBeNull();
    expect(analysisReport(m).unknowns).toHaveLength(1);
  });

  it('and `solveFeasible` does not answer it either — it is not in the relation set', () => {
    // `checkConstraintsNumeric` has the unit-aware verdict in front of its
    // residual; `solveFeasible` (a published SDK surface) has nothing but the
    // residual, so refusing in one place left the two DISAGREEING: feasibility
    // reported `false` with a violation of 2995 — 5 km − 3000 s, the very
    // subtraction the other surfaces refuse — for a model `analysisReport`
    // calls feasible. The relation is dropped at gathering instead.
    const m = parse(lengthVsDuration('>='));
    const f = solveFeasible(m);
    expect(f.violations).toEqual([]);
    expect(f.feasible).toBe(true);
    expect(analysisReport(m).feasible).toBe(true);
  });

  it('and it does not DRIVE a free variable either', () => {
    // The sharper form of the same fault: with the length free, the penalty
    // descent moved `d` to satisfy a bound expressed in SECONDS, publishing a
    // solved length nothing in the model justifies.
    const m = parse(
      req(
        `        attribute d : ISQ::LengthValue;
        attribute t : ISQ::DurationValue = 2.0 [s];`,
        'v.d <= v.t',
      ),
    );
    const d = m.all().find((e) => e.declaredName === 'd' && e.attrs.isLibrary !== true)!;
    expect(solveFeasible(m).values.get(d.id)).toBeUndefined();
    expect(solveFeasible(m).feasible).toBe(true);
    expect(solvedOf(m, 'd')).toBeUndefined();
    expect(numeric(m)).toEqual(['unknown']);
  });

  it('nor does a cross-dimension EQUALITY pin one', () => {
    // `t == d` used to determine `t` from a length. It is not an equation.
    const m = parse(`package P {
    attribute d : ISQ::LengthValue = 5.0 [km];
    attribute t : ISQ::DurationValue;
    constraint c { t == d }
}
`);
    expect(solvedOf(m, 't')).toBeUndefined();
    expect(unitAware(m)).toEqual(['unknown']);
    expect(numeric(m)).toEqual(['unknown']);
    // …and no zero-amount "violation" reaches the published report.
    const report = analysisReport(m);
    expect(report.violations).toEqual([]);
    expect(report.unknowns).toHaveLength(1);
  });

  it('and the SIMULATION surface agrees — it is the third one, and it was unit-blind', () => {
    // `SimSample.constraints` is evaluated by the scalar `evalConstraint`,
    // which never consulted the unit-aware engine: after the refusal landed on
    // the other two surfaces this one still reported `satisfied` for a mass
    // against a limit mistyped as a length. It now honours a refusal, reading
    // the live store and the parametric solve as quantities to do so — the
    // names a state machine's constraint uses reach it no other way.
    const m = parse(`package P {
    part def Crate {
        attribute mass : ISQ::MassValue = 18.5 [kg];
        attribute massLimit : ISQ::LengthValue = 25.0 [m];
        state def Modes {
            constraint within { mass <= massLimit }
            state idle; state busy; transition idle -> busy;
        }
    }
    part crate : Crate;
}
`);
    expect(unitAware(m)).toEqual(['unknown']);
    expect(numeric(m)).toEqual(['unknown']);
    const sm = m.ofKind('StateDefinition')[0];
    const trace = simulateStateMachine(m, sm.id, [], { solve: true });
    expect(trace.samples[0].constraints.map((c) => c.status)).toEqual(['unknown']);
  });

  it('but the simulation surface still answers a constraint it CAN judge', () => {
    // The guard on the rule above: only a refusal is honoured, so a live store
    // value the static scopes cannot see still decides the verdict.
    const m = parse(`package P {
    part def Crate {
        attribute mass : ISQ::MassValue = 18.5 [kg];
        attribute massLimit : ISQ::MassValue = 25.0 [kg];
        state def Modes {
            constraint within { mass <= massLimit }
            state idle; state busy; transition idle -> busy;
        }
    }
    part crate : Crate;
}
`);
    const sm = m.ofKind('StateDefinition')[0];
    const trace = simulateStateMachine(m, sm.id, [], { solve: true });
    expect(trace.samples[0].constraints.map((c) => c.status)).toEqual(['satisfied']);
  });

  it('a `[unit]` literal of the wrong dimension is unknown, not a confident violation', () => {
    const m = parse(
      req('        attribute mass : ISQ::MassValue = 2500.0 [kg];', 'v.mass <= 2000.0 [s]'),
    );
    expect(unitAware(m)).toEqual(['unknown']);
    const row = only(m);
    expect(row.result).toBe('unknown');
    expect(row.reason).toMatch(/different physical dimensions/);
    expect(row.slack).toBeNull();
    expect(analysisReport(m).unknowns).toHaveLength(1);
  });

  it('an equality joining a plain Real to a dimensioned value is not SI-scaled', () => {
    // The `==` is itself in the gate set, so the gate has to see the JOIN, not
    // the two sides apart: unscaled, `n` reads the 5 the model wrote.
    //
    // This is also where gate (c) is still OBSERVED at the scale level. A
    // DIMENSIONLESS side is not a clash, so the relation stays in the set and
    // stays unscaled, and the solved value is the difference: 5, not 5000.
    // (The two-different-dimensions half of gate (c) can no longer be watched
    // through a solved value — such a relation is dropped before scaling —
    // which is why the clash tests above assert the DROP instead.)
    const m = parse(`package P {
    attribute km : ISQ::LengthValue = 5.0 [km];
    attribute n : Real;
    constraint c { n == km }
}
`);
    expect(solvedOf(m, 'n')).toBeCloseTo(5, 9);
  });

  it('and the same statement written with a value agrees on both surfaces', () => {
    // A dimensionless number is not a length: units-eval has always answered
    // `violated` here, and the numeric surface now answers the same.
    const m = parse(`package P {
    attribute km : ISQ::LengthValue = 5.0 [km];
    attribute n : Real = 5.0;
    constraint c { n == km }
}
`);
    expect(unitAware(m)).toEqual(['violated']);
    expect(numeric(m)).toEqual(['violated']);
  });
});

/**
 * A scaled relation's residual is an SI quantity, so every ABSOLUTE constant in
 * the solver — the convergence gate, the Newton acceptance and step tests, the
 * feasibility tolerance — has to become relative to the relation's own SI
 * magnitude. Otherwise a millisecond model stops four decimal places short of
 * its root and is then flagged violated by the (relative) unit-aware verdict,
 * and a second-scale model is called infeasible over a 4e-7 overshoot.
 */
describe('a scaled relation is solved and judged relative to its own SI scale', () => {
  it('a millisecond-scale implicit equality solves to the exact root', () => {
    const m = parse(`package P {
    attribute x : ISQ::DurationValue;
    attribute k : ISQ::DurationValue = 4.0 [ms];
    constraint c1 { x * x == k * k * 0.25 }
}
`);
    // 4 ms / 2 = 2 ms, in SI seconds — to a RELATIVE 1e-12, not an absolute 1e-9.
    const x = solvedOf(m, 'x')!;
    expect(Math.abs(x - 0.002) / 0.002).toBeLessThan(1e-12);
    expect(solve(m).converged).toBe(true);
    expect(numeric(m)).toEqual(['satisfied']);
  });

  it('a nanometre-scale coupled system solves and converges', () => {
    const m = parse(`package P {
    attribute x : ISQ::LengthValue;
    attribute y : ISQ::LengthValue;
    attribute k : ISQ::LengthValue = 2.0 [nm];
    constraint c1 { x * x == k * y }
    constraint c2 { y == x + k }
}
`);
    // x² = k(x + k) ⇒ x = k·(1 + √5)/2.
    const exact = 2e-9 * ((1 + Math.sqrt(5)) / 2);
    const x = solvedOf(m, 'x')!;
    expect(Math.abs(x - exact) / exact).toBeLessThan(1e-9);
    expect(solve(m).converged).toBe(true);
    expect(numeric(m)).toEqual(['satisfied', 'satisfied']);
  });

  it('giving an ordinary model units does not make it infeasible', () => {
    const dimensioned = parse(`package P {
    attribute t : ISQ::DurationValue;
    attribute lim : ISQ::DurationValue = 3.0 [s];
    constraint c { t >= lim }
}
`);
    const unitless = parse(`package P {
    attribute t : Real;
    attribute lim : Real = 3.0;
    constraint c { t >= lim }
}
`);
    // Same numbers, same verdict: the feasibility gate is the historical 1e-6
    // made RELATIVE, not a noise floor the line search cannot reach.
    expect(solveFeasible(dimensioned).feasible).toBe(true);
    expect(solveFeasible(unitless).feasible).toBe(true);

    const bounded = (m: Model) => {
      const x = m.all().find((e) => e.declaredName === 't')!;
      return optimize(m, x.id, [x.id], { sense: 'max', bounds: { [x.id]: [0, 10] }, constraints: true });
    };
    expect(bounded(dimensioned).feasible).toBe(true);
    expect(bounded(unitless).feasible).toBe(true);
  });

  it('a PICOSECOND-scale equality is violated and reported as NOT converged', () => {
    // The convergence flag is relative too: at 1e-12 even the caller's own
    // absolute `tol` of 1e-9 is larger than the whole system, so an absolute
    // gate would call a model that the unit-aware verdict rejects "converged".
    const m = parse(
      req(
        `        attribute t : ISQ::DurationValue = 5.0 [ps];
        attribute u : ISQ::DurationValue = 3.0 [ps];`,
        'v.t == v.u',
      ),
    );
    expect(unitAware(m)).toEqual(['violated']);
    expect(numeric(m)).toEqual(['violated']);
    expect(solve(m).converged).toBe(false);
  });

  it('but a nanosecond-scale violation is still caught by that relative gate', () => {
    const m = parse(
      req(
        `        attribute t : ISQ::DurationValue = 5.0 [ns];
        attribute u : ISQ::DurationValue = 3.0 [ns];`,
        'v.t <= v.u',
      ),
    );
    // 2 ns of violation is far under the historical ABSOLUTE 1e-6.
    expect(solveFeasible(m).feasible).toBe(false);
    expect(numeric(m)).toEqual(['violated']);
  });
});

/** A label, a seed and a row may never claim more than the solver knows. */
describe('labels and seeds never outrun what the solver knows', () => {
  it('a relation the gates refused to scale leaves its measure UNLABELLED', () => {
    // `furlong` is not in the registry, so nothing here is in SI: the value is
    // 5 + 400 = 405, which is not 405 metres, and must not be labelled `m`.
    const m = parse(`package P {
    attribute leg1 : ISQ::LengthValue = 5.0 [furlong];
    attribute leg2 : ISQ::LengthValue = 400.0 [m];
    attribute totalMeasure : ISQ::LengthValue;
    constraint c { totalMeasure == leg1 + leg2 }
}
`);
    const moe = evaluateMoEs(m).find((x) => x.name === 'totalMeasure');
    expect(moe!.value).toBeCloseTo(405, 6);
    expect(moe!.unit).toBeUndefined();
    expect(moe!.dimension).toBe('L');
  });

  it('a dimension with several coherent units is labelled in base units, not the first', () => {
    // T⁻¹ is `Hz` AND `Bd`, and (information content being dimension one) it is
    // also every bit rate: 100 Mbit/s is not "100 MHz".
    const m = parse(`package P {
    attribute rateMeasure : ISQ::BinaryDigitRateValue;
    attribute source : ISQ::BinaryDigitRateValue = 100.0 [Mbit/s];
    bind source = rateMeasure;
}
`);
    const moe = evaluateMoEs(m).find((x) => x.name === 'rateMeasure');
    expect(moe!.value).toBeCloseTo(1e8, 0);
    expect(moe!.unit).toBe('s⁻¹');
  });

  it('a self-contained `= 2 * 3 [kg]` value seeds the feature and everything downstream', () => {
    const m = parse(`package P {
    attribute m1 : ISQ::MassValue = 2.0 * 3.0 [kg];
    attribute doubled : ISQ::MassValue = m1 * 2.0;
}
`);
    expect(solvedOf(m, 'm1')).toBeCloseTo(6, 9);
    expect(solvedOf(m, 'doubled')).toBeCloseTo(12, 9);
  });

  it('the same value in tonnes seeds the SI storage magnitude', () => {
    const m = parse('package P { attribute m1 : ISQ::MassValue = 2.0 * 3.0 [t]; }');
    expect(solvedOf(m, 'm1')).toBeCloseTo(6000, 6);
  });

  it('a body neither engine can put a residual on still gets a row', () => {
    const m = parse(`package P {
    attribute a : Real = 3.0;
    attribute b : Real = 4.0;
    constraint c { a > 1.0 and b > 2.0 }
}
`);
    expect(unitAware(m)).toEqual(['satisfied']);
    const row = only(m);
    expect(row.kind).toBe('boolean');
    expect(row.result).toBe('satisfied');
    expect(row.slack).toBeNull();
  });
});

/* ══════════════ F3 — offset scales, dimension one, strictness ═════════════ */

/**
 * An offset (affine) scale is ORDERED in kelvin and refused everywhere else —
 * on BOTH surfaces, and in the relation set, not only in the published row.
 *
 * Gate (b) used to refuse to SCALE any relation touching °C/°F and then leave
 * it in the set in raw magnitudes. `checkConstraintsNumeric` took its verdict
 * from the unit-aware evaluator and so read right, but `solveFeasible` and
 * `optimize` read the residual directly and so read 100 °C against 350 K as
 * `100 >= 350` — INFEASIBLE for a model that holds, and feasible for one that
 * does not. The affine map is monotone, so an ORDERING may be judged in SI (it
 * is what `compareQ` already does); `+`, `-`, `==` and `!=` on an absolute
 * stay refusals, and are now dropped from the relation set the way a
 * dimension clash is, instead of driving a value nothing may judge.
 */
describe('an offset scale is ordered in SI and refused everywhere else', () => {
  const tempReq = (temp: string, body: string) => `package P {
    attribute temp : ISQ::ThermodynamicTemperatureValue = ${temp};
    attribute limit : ISQ::ThermodynamicTemperatureValue = 350.0 [K];
    constraint hot { ${body} }
}
`;

  it('100 °C >= 350 K holds — and feasibility says so too', () => {
    // 100 °C is 373.15 K, so the requirement holds. Read in raw magnitudes it
    // is `100 >= 350`, which is where the inverted feasibility came from.
    const m = parse(tempReq("100.0 ['°C']", 'temp >= limit'));
    expect(unitAware(m)).toEqual(['satisfied']);
    const row = only(m);
    expect(row.result).toBe('satisfied');
    expect(row.slack).toBeCloseTo(23.15, 6);
    expect(row.slackUnit).toBe('K');
    expect(solveFeasible(m).feasible).toBe(true);
    expect(analysisReport(m).feasible).toBe(true);
  });

  it('30 °C <= 300 K does NOT hold — and feasibility says that too', () => {
    const m = parse(`package P {
    attribute temp : ISQ::ThermodynamicTemperatureValue = 30.0 ['°C'];
    attribute limit : ISQ::ThermodynamicTemperatureValue = 300.0 [K];
    constraint cool { temp <= limit }
}
`);
    expect(unitAware(m)).toEqual(['violated']);
    const row = only(m);
    expect(row.result).toBe('violated');
    expect(row.slack).toBeCloseTo(-3.15, 6);
    expect(row.amount).toBeCloseTo(3.15, 6);
    expect(solveFeasible(m).feasible).toBe(false);
    expect(analysisReport(m).feasible).toBe(false);
  });

  it('an ordering against a [K] literal carries its slack in kelvin', () => {
    const m = parse(req(`        attribute t2 : ISQ::TemperatureValue = 30.0 ['°C'];`, 'v.t2 >= 300.0 [K]'));
    expect(unitAware(m)).toEqual(['satisfied']);
    const row = only(m);
    expect(row.result).toBe('satisfied');
    expect(row.slack).toBeCloseTo(3.15, 6);
    expect(row.slackUnit).toBe('K');
  });

  it('an EQUALITY touching an absolute scale determines nothing', () => {
    // The unit-aware evaluator refuses `==` on an offset scale (the scale's
    // zero is not the dimension's zero), so the solver must not answer it
    // either: reading it raw filled a kelvin-storage feature with 20.
    const m = parse(`package P {
    attribute t1 : ISQ::TemperatureValue = 20.0 ['°C'];
    attribute dT : ISQ::TemperatureValue;
    constraint same { dT == t1 }
}
`);
    expect(unitAware(m)).toEqual(['unknown']);
    expect(only(m).result).toBe('unknown');
    expect(solvedOf(m, 'dT')).toBeUndefined();
  });
});

/**
 * A BINDING is an identity of physical values, not a predicate: it publishes no
 * verdict, so it converts across the affine map instead of being refused.
 * Copying the magnitude filled a kelvin-storage feature with 20 and let the
 * numeric surface answer a kelvin constraint confidently wrong. A test pinned
 * that 20, justified by a residual objection that only held while the equation
 * itself was read in raw degrees; scaled, both sides are SI and it converges.
 */
describe('a binding across an offset scale converts', () => {
  const src = `package P {
    attribute a : ISQ::TemperatureValue = 20.0 ['°C'];
    attribute measureT : ISQ::TemperatureValue;
    bind a = measureT;
    constraint frozen { measureT <= 273.15 [K] }
}
`;

  it('fills the kelvin-storage feature with 293.15, and still converges', () => {
    const m = parse(src);
    expect(solvedOf(m, 'measureT')).toBeCloseTo(293.15, 9);
    expect(solve(m).converged).toBe(true);
    expect(solve(m).residual).toBeCloseTo(0, 9);
  });

  it('and the kelvin constraint on it is violated, not satisfied by 253 K', () => {
    const m = parse(src);
    const row = only(m);
    expect(row.result).toBe('violated');
    expect(row.amount).toBeCloseTo(20, 6);
  });
});

/**
 * Dimension one is not "unitless": the ISO 80000-13 information units are
 * deliberately dimension one (a byte is 8 bit, not 8 of something else), so a
 * gate that asks "is this DIMENSIONED?" skips exactly the conversion that
 * makes 2 B and 16 bit the same quantity.
 */
describe('a dimension-one unit with a factor is still converted', () => {
  const store = (body: string) => `package P {
    part def Store {
        attribute cap : ISQ::StorageCapacityValue = 2.0 [B];
        attribute need : ISQ::InformationContentValue [bit];
        constraint fits { ${body} }
    }
    part s : Store;
}
`;

  it('2 [B] == need [bit] solves need to 16, not 2', () => {
    const m = parse(store('need == cap'));
    expect(solvedOf(m, 'need')).toBeCloseTo(16, 9);
    const row = only(m);
    expect(row.result).toBe('satisfied');
    expect(row.slack).toBeCloseTo(0, 9);
  });

  it('and the km/m control still solves the same way', () => {
    const m = parse(`package P {
    part def V {
        attribute far : ISQ::LengthValue = 2.0 [km];
        attribute near : ISQ::LengthValue [m];
        constraint fits { near == far }
    }
    part v : V;
}
`);
    expect(solvedOf(m, 'near')).toBeCloseTo(2000, 6);
  });

  it('a binding into a [bit] feature converts too', () => {
    const m = parse(`package P {
    part def Store {
        attribute cap : ISQ::StorageCapacityValue = 2.0 [B];
        attribute need : ISQ::InformationContentValue [bit];
        bind cap = need;
    }
    part s : Store;
}
`);
    expect(solvedOf(m, 'need')).toBeCloseTo(16, 9);
  });
});

/**
 * A STRICT ordering has no slack at its boundary. On the scalar-fallback path
 * (a bare literal beside a dimensioned value, where the unit-aware evaluator
 * declines and both surfaces read the declared magnitudes) the numeric side
 * applied the same ±1e-6 to `<` as to `<=`, so `mass < 25.0` at 25 kg read
 * SATISFIED here and VIOLATED on the validation surface — the two surfaces
 * answering one model differently, which is the thing this seam exists to
 * prevent.
 */
describe('strictness survives the scalar fallback', () => {
  const massReq = (body: string) =>
    req(`        attribute mass : ISQ::MassValue = 25.0 [kg];`, body);

  it('`mass < 25.0` at 25 kg is violated on both surfaces', () => {
    const m = parse(massReq('v.mass < 25.0'));
    expect(unitAware(m)).toEqual(['violated']);
    expect(numeric(m)).toEqual(['violated']);
  });

  it('`mass > 25.0` at 25 kg is violated on both surfaces', () => {
    const m = parse(massReq('v.mass > 25.0'));
    expect(unitAware(m)).toEqual(['violated']);
    expect(numeric(m)).toEqual(['violated']);
  });

  it('but `<=` still holds at the boundary, on both', () => {
    const m = parse(massReq('v.mass <= 25.0'));
    expect(unitAware(m)).toEqual(['satisfied']);
    expect(numeric(m)).toEqual(['satisfied']);
  });

  it('and a strictly smaller magnitude still satisfies `<`', () => {
    const m = parse(massReq('v.mass < 25.5'));
    expect(unitAware(m)).toEqual(['satisfied']);
    expect(numeric(m)).toEqual(['satisfied']);
  });
});

/**
 * The fixes above moved three seams, and each one had a second site that has to
 * move with it — a label, a value and a feasibility verdict that would
 * otherwise contradict the surface the fix was made to agree with.
 */
describe('the second site of each fix agrees with the first', () => {
  /**
   * A relation the gates REFUSE is dropped from the equation set, which is
   * also how it leaves `unitBlindIds`' sight. The measure's value then comes
   * from the raw-magnitude fallback while the label says coherent SI: a 20 °C
   * magnitude published as `20 [K]`. The label is claimed for a value the
   * SOLVER produced, never for one a fallback supplied.
   */
  it('a measure whose relation was refused stays UNLABELLED', () => {
    const m = parse(`package P {
    part def Room {
        attribute ambient : ISQ::ThermodynamicTemperatureValue = 20.0 ['°C'];
        attribute measureT : ISQ::ThermodynamicTemperatureValue = ambient + 0.0;
    }
    part r : Room;
}
`);
    const moe = evaluateMoEs(m).find((x) => x.name === 'measureT');
    expect(moe!.value).toBeCloseTo(20, 9);
    expect(moe!.unit).toBeUndefined();
    expect(moe!.dimension).toBe('Θ');
  });

  /**
   * A feature value that is a BARE REFERENCE states an identity, exactly as a
   * binding does, and publishes no verdict — so it converts rather than being
   * refused. Refusing it dropped the feature out of `SolveResult.values`
   * altogether, with nothing anywhere saying why.
   */
  it('a pure-copy assignment across an offset scale converts, like a binding', () => {
    const m = parse(`package P {
    part def Room {
        attribute ambient : ISQ::ThermodynamicTemperatureValue = 20.0 ['°C'];
        attribute target : ISQ::ThermodynamicTemperatureValue = ambient;
    }
    part r : Room;
}
`);
    expect(solvedOf(m, 'target')).toBeCloseTo(293.15, 9);
    expect(solve(m).converged).toBe(true);
    const moe = evaluateMoEs(m).find((x) => x.name === 'target');
    expect(moe).toBeUndefined(); // not a measure — the copy is checked above
  });

  it('but ARITHMETIC on an absolute in a value expression is still refused', () => {
    const m = parse(`package P {
    part def Room {
        attribute ambient : ISQ::ThermodynamicTemperatureValue = 20.0 ['°C'];
        attribute warmer : ISQ::ThermodynamicTemperatureValue = ambient + 5.0;
    }
    part r : Room;
}
`);
    expect(solvedOf(m, 'warmer')).toBeUndefined();
  });

  /**
   * The solver scales a dimension-one unit with a factor against a KIND-LESS
   * feature (a plain `Real`) — which is what the unit-aware evaluator does too,
   * `r : Real = 2.0` against `2 [B]` being violated on both surfaces below. The
   * binding propagation in ./connectors has to read the same feature the same
   * way, or the two write 16 and 2 into the same variable and the model reports
   * NOT CONVERGED.
   */
  it('a binding from a [B] feature into a plain Real converges', () => {
    const m = parse(`package P {
    attribute cap : ISQ::StorageCapacityValue = 2.0 [B];
    attribute r : Real;
    bind cap = r;
}
`);
    expect(solve(m).converged).toBe(true);
    expect(solve(m).residual).toBeCloseTo(0, 9);
    expect(solvedOf(m, 'r')).toBeCloseTo(16, 9);
  });

  it('and the km-against-a-plain-Real control still copies verbatim', () => {
    // A DIMENSIONED value against a kind-less one is the declared-unit
    // contract: gate (c) refuses to scale it, and the binding copies the 5.
    const m = parse(`package P {
    attribute a : ISQ::LengthValue = 5.0 [km];
    attribute r : Real;
    bind a = r;
}
`);
    expect(solve(m).converged).toBe(true);
    expect(solvedOf(m, 'r')).toBeCloseTo(5, 9);
  });

  it('a plain Real is read in SI against a [B] value on BOTH surfaces', () => {
    // The evidence that scaling `r == cap` is right rather than a broken
    // plain-`Real` contract: the unit-aware evaluator reads dimension one in
    // SI as well, so 2 is not 2 bytes and 16 is.
    const two = parse(`package P {
    attribute cap : ISQ::StorageCapacityValue = 2.0 [B];
    attribute r : Real = 2.0;
    constraint c { r == cap }
}
`);
    expect(unitAware(two)).toEqual(['violated']);
    expect(numeric(two)).toEqual(['violated']);
    const sixteen = parse(`package P {
    attribute cap : ISQ::StorageCapacityValue = 2.0 [B];
    attribute r : Real = 16.0;
    constraint c { r == cap }
}
`);
    expect(unitAware(sixteen)).toEqual(['satisfied']);
    expect(numeric(sixteen)).toEqual(['satisfied']);
  });

  /**
   * `checkConstraintsNumeric` reads a strict ordering exactly on the fallback
   * path; `solveFeasible` and `optimize` read the same relation's residual.
   * Whichever way the rule goes, all three have to go with it, or the row says
   * violated while feasibility says feasible.
   */
  it('feasibility reads a strict tie the way the check surface does', () => {
    const m = parse(`package P {
    part def V { attribute mass : ISQ::MassValue = 25.0 [kg]; }
    part v : V;
    constraint c5 { v.mass < 25.0 }
}
`);
    expect(unitAware(m)).toEqual(['violated']);
    expect(numeric(m)).toEqual(['violated']);
    expect(solveFeasible(m).feasible).toBe(false);
    expect(analysisReport(m).feasible).toBe(false);
    const mass = m.all().find((e) => e.declaredName === 'mass' && e.attrs.isLibrary !== true);
    expect(optimize(m, mass!.id, [], { constraints: true }).feasible).toBe(false);
  });

  it('and a residual inside the ±1e-6 gate goes the same way', () => {
    const m = parse(`package P {
    part def V { attribute mass : ISQ::MassValue = 25.0000005 [kg]; }
    part v : V;
    constraint c5 { v.mass < 25.0 }
}
`);
    expect(numeric(m)).toEqual(['violated']);
    expect(solveFeasible(m).feasible).toBe(false);
  });

  it('but a tie the unit-aware evaluator JUDGES is feasible on every surface', () => {
    // `compareQ` counts operands within its tolerance as equal for every
    // operator, so this tie is satisfied — and feasibility must not overrule a
    // verdict the check surface publishes.
    const scaled = parse(`package P {
    attribute mass : ISQ::MassValue = 25.0 [kg];
    constraint c { mass < 25.0 [kg] }
}
`);
    expect(unitAware(scaled)).toEqual(['satisfied']);
    expect(numeric(scaled)).toEqual(['satisfied']);
    expect(solveFeasible(scaled).feasible).toBe(true);
    const plain = parse(`package P {
    attribute x = 25.0;
    constraint c { x < 25.0 }
}
`);
    expect(unitAware(plain)).toEqual(['satisfied']);
    expect(numeric(plain)).toEqual(['satisfied']);
    expect(solveFeasible(plain).feasible).toBe(true);
  });
});
