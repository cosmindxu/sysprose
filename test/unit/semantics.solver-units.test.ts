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
  gatherConstraints,
  gatherInequalities,
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

  it('and the same statement written with a value agrees on both surfaces — and with the solved value', () => {
    // The 5 the solver finds above is the value that satisfies `n == km`
    // stated outright. Units-eval used to answer `violated` here ("dimensions
    // differ ⇒ values differ"), so a value the solver had just solved for
    // failed its own equation; the equality is now the bare-literal contract,
    // as an ordering of the same pair is.
    const m = parse(`package P {
    attribute km : ISQ::LengthValue = 5.0 [km];
    attribute n : Real = 5.0;
    constraint c { n == km }
}
`);
    expect(unitAware(m)).toEqual(['satisfied']);
    expect(numeric(m)).toEqual(['satisfied']);
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

  /*
   * A `[unit]` beside an EXPRESSION value is part of the value: `(k * 2.0)
   * [GiB]` is the number `k * 2.0` in GiB, as the validation surface applies
   * it. Joined as the bare `total == k * 2.0`, the gates scaled the
   * dimension-one feature and read `k * 2.0` as SI: `total` solved to 6 bits
   * (6.98e-10 GiB), `solveFeasible` called `total >= 5.0 [GiB]` infeasible by
   * 4.29e10, and the measure was published as 6.98e-10 GiB beside a check that
   * read 6 GiB.
   */
  it('a value written `(k * 2.0) [GiB]` is 6 GiB to the solve, the measure and feasibility', () => {
    const m = parse(`package P {
    part def Mem {
        attribute k : ScalarValues::Real = 3.0;
        attribute capacityMeasure : ISQ::StorageCapacityValue = (k * 2.0) [GiB];
        constraint floor { capacityMeasure >= 5.0 [GiB] }
    }
    part m : Mem;
}
`);
    expect(solvedOf(m, 'capacityMeasure')).toBeCloseTo(6, 9);
    expect(unitAware(m)).toEqual(['satisfied']);
    expect(numeric(m)).toEqual(['satisfied']);
    const moe = evaluateMoEs(m).find((x) => x.name === 'capacityMeasure');
    expect(moe?.value).toBeCloseTo(6, 9);
    expect(moe?.unit).toBe('GiB');
    expect(solveFeasible(m).feasible).toBe(true);
  });

  it('and a dimensioned `(d1 / d2) [km]` is the ratio in km, not `d1` read in its stored km', () => {
    const m = parse(
      req(
        `        attribute d1 : ISQ::LengthValue = 2.0 [km];
        attribute d2 : ISQ::LengthValue = 1.0 [m];
        attribute lenMeasure : ISQ::LengthValue = (d1 / d2) [km];`,
        'v.lenMeasure == 2000.0 [km]',
      ),
    );
    expect(solvedOf(m, 'lenMeasure')).toBeCloseTo(2000, 6);
    expect(unitAware(m)).toEqual(['satisfied']);
    expect(numeric(m)).toEqual(['satisfied']);
  });

  it('a self-contained `(6.0 [GiB] / 2.0 [GiB]) [GiB]` seeds 3 GiB, not 3 bits', () => {
    // The seed read the body as SI and converted it into the storage unit:
    // 3 / 2^33 GiB, and `(6.0 [km] / 2.0 [m]) [km]` as 3 km for a value of 3000.
    const m = parse(
      req(
        `        attribute r : ISQ::StorageCapacityValue = (6.0 [GiB] / 2.0 [GiB]) [GiB];
        attribute len : ISQ::LengthValue = (6.0 [km] / 2.0 [m]) [km];`,
        'v.r == 3.0 [GiB] and v.len == 3000.0 [km]',
      ),
    );
    expect(solvedOf(m, 'r')).toBeCloseTo(3, 9);
    expect(solvedOf(m, 'len')).toBeCloseTo(3000, 6);
    expect(solve(m).converged).toBe(true);
    expect(numeric(m)).toEqual(['satisfied']);
  });

  it('a value that puts a unit on bits is solved from nothing and judged by nothing', () => {
    // `(cap * 2.0) [GiB]` relabels 2^35 bit as GiB: the validation surface
    // refuses it, so the solver lane neither solves nor seeds it.
    for (const value of ['(cap * 2.0) [GiB]', '(2.0 * 1.0 [GiB]) [GiB]']) {
      const m = parse(
        req(
          `        attribute cap : ISQ::StorageCapacityValue = 2.0 [GiB];
        attribute dbl : ISQ::StorageCapacityValue = ${value};`,
          'v.dbl > 1000.0 [GiB]',
        ),
      );
      expect(solvedOf(m, 'dbl'), value).toBeUndefined();
      expect(unitAware(m), value).toEqual(['unknown']);
      expect(numeric(m), value).toEqual(['unknown']);
    }
  });

  it('nor is a value the solver found for a defined feature given the unit the check refuses', () => {
    // `x` is defined as `cap * 2.0`, bits: the validation surface refuses
    // `(v.x) [GiB]`, and the solved 2^35 must not be relabelled here either.
    const m = parse(
      req(
        `        attribute cap : ISQ::StorageCapacityValue = 2.0 [GiB];
        attribute x : ISQ::StorageCapacityValue;
        assert constraint def1 { x == cap * 2.0 }`,
        '(v.x) [GiB] > 1000.0 [GiB]',
      ),
    );
    expect(solvedOf(m, 'x')).toBeCloseTo(2 ** 35, 0);
    const row = checkConstraintsNumeric(m).find((r) => r.raw.includes('1000.0'));
    expect(row?.result).toBe('unknown');
    expect(checkConstraints(m).find((c) => c.expression.includes('1000.0'))?.result).toBe('unknown');
  });

  /*
   * A relabel the MODEL'S POINT does not show: with an input the model gives
   * no value, the validation surface merely has no value for the feature, and
   * the solver joined `x == expr * 1.0 [GiB]` — solving `tot = (cap + k) [GiB]`
   * to 17179869185 (2^34 bit + 1, read as GiB) and `dbl = (cap * k) [GiB]` with
   * `k` pinned at 3 to 51539607552 GiB. Whatever `k` is, the unit lands on
   * bits, so neither is solved; a value that is a number for every `k` is.
   */
  it('nor is a value that puts a unit on bits for EVERY value of an input the model leaves free', () => {
    const cap = '        attribute cap : ISQ::StorageCapacityValue = 2.0 [GiB];';
    const shapes: Array<[string, string]> = [
      ['attribute k : ScalarValues::Real; assert constraint kpos { k >= 1.0 }', '(cap * k) [GiB]'],
      ['attribute k : ScalarValues::Real; assert constraint kpos { k >= 0.0 }', '(cap + k) [GiB]'],
      ['attribute k : ScalarValues::Real; constraint pin { k == 3.0 }', '(cap * k) [GiB]'],
      ['attribute big : ScalarValues::Boolean;', '(if big then cap * 1.0 else cap * 2.0) [GiB]'],
      ['attribute y : ISQ::StorageCapacityValue; assert constraint ylo { y >= cap }', '(y) [GiB]'],
      ['attribute mirror; bind mirror = cap;', '(mirror * 2.0) [GiB]'],
    ];
    for (const [inputs, value] of shapes) {
      const m = parse(
        req(`${cap}\n        ${inputs}\n        attribute dbl : ISQ::StorageCapacityValue = ${value};`, 'v.dbl >= 1000.0 [GiB]'),
      );
      expect(solvedOf(m, 'dbl'), value).toBeUndefined();
      expect(checkConstraintsNumeric(m).find((r) => r.raw.includes('v.dbl'))?.result, value).toBe('unknown');
    }
    // A number for every value of the free input is joined, and solved.
    const m = parse(
      req(
        `${cap}
        attribute k : ScalarValues::Real; constraint pin { k == 3.0 }
        attribute total : ISQ::StorageCapacityValue = (k * 2.0) [GiB];
        attribute y : ISQ::StorageCapacityValue; bind y = cap;
        attribute back : ISQ::StorageCapacityValue = (y / 1.0 [MiB]) [MiB];`,
        'v.back == 2048.0 [MiB]',
      ),
    );
    expect(solvedOf(m, 'total')).toBeCloseTo(6, 9);
    expect(solvedOf(m, 'back')).toBeCloseTo(2048, 6);
    expect(numeric(m)).toEqual(['satisfied', 'satisfied']);
  });

  it('nor one over a ratio of another kind of dimension one: GiB over mm/m is still bits', () => {
    // One power of GiB over one of mm/m summed to zero: 2^34 / 0.002 bit was
    // read as 8.6e12 GiB, where the quantity is 1000 GiB.
    const m = parse(
      req(
        `        attribute cap : ISQ::StorageCapacityValue = 2.0 [GiB];
        attribute strain : ScalarValues::Real = 2.0 [mm/m];
        attribute x : ISQ::StorageCapacityValue = (cap / strain) [GiB];
        attribute r : ScalarValues::Real = (strain / 1.0 [km/m]) [mm/m];`,
        'v.x > 1.0E12 [GiB]',
      ),
    );
    expect(solvedOf(m, 'x')).toBeUndefined();
    expect(unitAware(m)).toEqual(['unknown']);
    expect(numeric(m)).toEqual(['unknown']);
    // A ratio over a ratio of the same kind is a number: 0.002 / 1000.
    expect(solvedOf(m, 'r')).toBeCloseTo(2e-6, 15);
  });

  it('seeds a self-contained lifted value over one derivation pass, not one per feature', () => {
    // Each seed made its own memo, and every memo walked the owner's whole
    // scope again: (n + 1)² reads of the model for n such values, and 2 400 of
    // them took 22 times as long to solve as plain literals. One pass reads
    // each feature's types twice.
    const n = 200;
    const attrs = Array.from(
      { length: n },
      (_, i) => `        attribute x${i} : ISQ::StorageCapacityValue = (1.0 + 1.0) [GiB];`,
    ).join('\n');
    const m = parse(`package P {\n    part def V {\n${attrs}\n    }\n    part v : V;\n}\n`);
    const typesOf = m.typesOf.bind(m);
    let reads = 0;
    m.typesOf = (id) => {
      reads++;
      return typesOf(id);
    };
    const solved = solve(m);
    const last = m.all().find((e) => e.declaredName === `x${n - 1}`)!;
    expect(solved.values.get(last.id)).toBeCloseTo(2, 9);
    expect(reads).toBeLessThan(10 * n);
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

  it('and a tie the unit-aware evaluator judges is a tie too, on every surface (the tie rule)', () => {
    // `compareQ` read operands within its tolerance as equal for every
    // operator, the strict ones SATISFIED — `mass < 25.0 [kg]` at 25 kg held
    // where the scalar path and the SMT engine read it violated. It decides a
    // tie by the decimals written now, as every surface does.
    const scaled = parse(`package P {
    attribute mass : ISQ::MassValue = 25.0 [kg];
    constraint c { mass < 25.0 [kg] }
}
`);
    expect(unitAware(scaled)).toEqual(['violated']);
    expect(numeric(scaled)).toEqual(['violated']);
    expect(solveFeasible(scaled).feasible).toBe(false);
    expect(solveFeasible(scaled).decided).toBe(true);
    const plain = parse(`package P {
    attribute x = 25.0;
    constraint c { x < 25.0 }
}
`);
    expect(unitAware(plain)).toEqual(['violated']);
    expect(numeric(plain)).toEqual(['violated']);
    expect(solveFeasible(plain).feasible).toBe(false);
    const x = plain.all().find((e) => e.declaredName === 'x' && e.attrs.isLibrary !== true);
    expect(optimize(plain, x!.id, [], { constraints: true }).feasible).toBe(false);
    // A near miss is no tie: 0.9999999999 < 1.0 is true of the decimals.
    const near = parse(`package P {
    attribute x = 0.9999999999;
    constraint c { x < 1.0 }
}
`);
    expect(unitAware(near)).toEqual(['satisfied']);
    expect(numeric(near)).toEqual(['satisfied']);
    expect(solveFeasible(near).feasible).toBe(true);
  });

  it('feasibility takes the validation surface’s verdict on an inequality over stated values (R3b)', () => {
    // `x <= 0.2999999` at 0.3 misses by 1e-7: inside the absolute 1e-6 the
    // numeric surface and the feasibility gate read raw magnitudes by, and
    // both called it satisfied — feasible — beside a check that reads it
    // violated and an SMT engine that refutes it.
    const over = parse(`package P {
    attribute x = 0.3;
    constraint c { x <= 0.2999999 }
}
`);
    expect(unitAware(over)).toEqual(['violated']);
    expect(numeric(over)).toEqual(['violated']);
    const f = solveFeasible(over);
    expect([f.feasible, f.decided, f.violations.length]).toEqual([false, true, 1]);
    const under = parse(`package P {
    attribute x = 0.3;
    constraint c { x > 0.2999999 }
}
`);
    expect(unitAware(under)).toEqual(['satisfied']);
    expect(numeric(under)).toEqual(['satisfied']);
    expect(solveFeasible(under).feasible).toBe(true);
    // On the bare-literal path too: a kinded `limit` read in its declared unit.
    const literal = parse(`package P {
    attribute limit : ISQ::MassValue = 25.0000005;
    constraint c { limit <= 25.0 }
}
`);
    expect(unitAware(literal)).toEqual(['violated']);
    expect(numeric(literal)).toEqual(['violated']);
    expect(solveFeasible(literal).feasible).toBe(false);
    // `0.1 + 0.2 > 0.3` is false of the decimals, on every surface.
    const sum = parse(`package P {
    attribute f = 0.1;
    constraint c { f + 0.2 > 0.3 }
}
`);
    expect(unitAware(sum)).toEqual(['violated']);
    expect(numeric(sum)).toEqual(['violated']);
    expect(solveFeasible(sum).feasible).toBe(false);
  });

  it('but only at the model’s own point: a value stated over a fixed or optimised one is read where it stands', () => {
    // `y` is stated, as an expression over `x`: at the model's `x = 9.0` it is
    // 18, past `y <= 5.0`. With `x` fixed to 1 it is 2, and the validation
    // surface's verdict at 18 made that point infeasible — `c` violated by 0.
    const m = parse(`package P {
    attribute x = 9.0;
    attribute y = x * 2.0;
    constraint c { y <= 5.0 }
}
`);
    const id = (name: string) => m.all().find((e) => e.declaredName === name && e.attrs.isLibrary !== true)!.id;
    expect(solveFeasible(m).feasible).toBe(false);
    const fixed = solveFeasible(m, { fixed: new Map([[id('x'), 1.0]]) });
    expect([fixed.feasible, fixed.decided, fixed.violations, fixed.values.get(id('y'))]).toEqual([true, true, [], 2]);
    // So does the optimum: `y` maximised over `x` meets its bound at 5.
    const bounds = new Map<string, [number, number]>([[id('x'), [0, 10]]]);
    const best = optimize(m, id('y'), [id('x')], { sense: 'max', constraints: true, bounds });
    expect(best.value).toBeCloseTo(5, 5);
    expect(best.feasible).toBe(true);
  });

  it('and every relation is read there, every feature at the fixed point — a `!=`, a connective, an equality (f1d)', () => {
    // `y != 18.0` was judged by the unit-aware evaluator at the model's own y
    // of 18: violated at x fixed to 1, where y is 2, and that point decided
    // infeasible. Every name now reads the value the point gives it.
    const m = parse(`package F1d {
    attribute x = 9.0;
    attribute y = x * 2.0;
    constraint ne { y != 18.0 }
    constraint conn { y > 1.0 and y < 5.0 }
    constraint eq { y == 2.0 }
    constraint le { y <= 5.0 }
}
`);
    const id = (name: string) => m.all().find((e) => e.declaredName === name && e.attrs.isLibrary !== true)!.id;
    expect(numeric(m)).toEqual(['violated', 'violated', 'violated', 'violated']);
    const fixed = { fixed: new Map([[id('x'), 1.0]]) };
    expect(checkConstraintsNumeric(m, fixed).map((r) => r.result)).toEqual(['satisfied', 'satisfied', 'satisfied', 'satisfied']);
    const f = solveFeasible(m, fixed);
    expect([f.feasible, f.decided, f.violations]).toEqual([true, true, []]);
    // A definition's relation read in a context is the validation surface's
    // verdict at the values the model STATES: at a point holding one fixed to
    // another it is not this point's, and is not judged here.
    const ctx = parse(`package F1f {
    part def P { attribute load : Real default = 1.0; constraint c { load <= 10.0 } }
    part p : P { attribute heavy :>> load = 50.0; }
}
`);
    const inP = (rows: ReturnType<typeof checkConstraintsNumeric>) => rows.find((r) => r.context !== undefined)!;
    expect(inP(checkConstraintsNumeric(ctx)).result).toBe('violated');
    const heavy = ctx.all().find((e) => e.declaredName === 'heavy')!.id;
    const held = inP(checkConstraintsNumeric(ctx, { fixed: new Map([[heavy, 5.0]]) }));
    expect([held.result, held.reason]).toEqual(['unknown', expect.stringMatching(/not this point's/)]);
    // A value the caller FIXED is the decimal it gave, read exactly, as a
    // value the model states is — never a value the solve produced, known
    // only to its tolerance (decision 11): read so, `x <= 0.99999999999` and
    // `x == 1.00000000001` held at x fixed to 1 (t3), and so did `x + c <=
    // 25.99999999999` beside a stated c of 25 (t1).
    const t3 = parse(`package T3 {
    attribute x = 3.0;
    attribute c = 25.0;
    constraint kx { x <= 0.99999999999 }
    constraint kxe { x == 1.00000000001 }
    constraint kc { x + c <= 25.99999999999 }
}
`);
    const at1 = { fixed: new Map([[t3.all().find((e) => e.declaredName === 'x')!.id, 1.0]]) };
    expect(checkConstraintsNumeric(t3, at1).map((r) => r.result)).toEqual(['violated', 'violated', 'violated']);
    const f3 = solveFeasible(t3, at1);
    expect([f3.feasible, f3.decided, f3.violations.map((v) => v.name)]).toEqual([false, true, ['kx', 'kc']]);
    // A name the point gives no value, whose value the model states over what
    // the point moved, is no value of that point: `ok = x > 5.0`, read at the
    // model's x of 9, held at x fixed to 1 and decided the point feasible (t4).
    const t4 = parse(`package T4 {
    attribute x = 9.0;
    attribute ok : Boolean = x > 5.0;
    constraint c { ok }
    constraint c2 { ok and x > 0.0 }
}
`);
    expect(numeric(t4)).toEqual(['satisfied', 'satisfied']);
    const at4 = { fixed: new Map([[t4.all().find((e) => e.declaredName === 'x')!.id, 1.0]]) };
    const rows4 = checkConstraintsNumeric(t4, at4);
    expect(rows4.map((r) => [r.result, r.reason])).toEqual([
      ['unknown', expect.stringMatching(/^ok has no value at this point/)],
      ['unknown', expect.stringMatching(/^ok has no value at this point/)],
    ]);
    const f4 = solveFeasible(t4, at4);
    expect([f4.violations, f4.decided]).toEqual([[], false]);
  });

  it('a strict ordering within the tolerance of a solved value is undecided, never read as a tie', () => {
    // x is solved from `x * 3.0 == 0.29999999`: 0.0999999966…, so `x < 0.1`
    // is TRUE. Read as a tie inside the solve's tolerance, it was violated on
    // the numeric surface and decided infeasible.
    const below = parse(`package P {
    attribute x : Real;
    constraint d { x * 3.0 == 0.29999999 }
    constraint lt { x < 0.1 }
    constraint le { x <= 0.1 }
}
`);
    expect(numeric(below)).toEqual(['satisfied', 'unknown', 'satisfied']);
    expect(checkConstraintsNumeric(below)[1].reason).toMatch(/known only to that tolerance/);
    const f = solveFeasible(below);
    expect([f.feasible, f.decided, f.violations]).toEqual([true, false, []]);
    // In kilograms the evaluator's own relative tolerance decides it — 3.3e-9
    // short of a bound of 0.1 — and feasibility, whose gate is wider, leaves
    // it open rather than contradict it: the row was satisfied and the same
    // row a violation of the same point.
    const kg = parse(`package P {
    attribute x : ISQ::MassValue;
    constraint d { x * 3.0 == 0.29999999 [kg] }
    constraint lt { x < 0.1 [kg] }
}
`);
    expect(numeric(kg)).toEqual(['satisfied', 'satisfied']);
    const k = solveFeasible(kg);
    expect([k.feasible, k.violations]).toEqual([true, []]);
    // And at 0.1 exactly (`x * 3.0 == 0.3`; the solve stops a few ulps away)
    // the strict bound is false: undecided too, never satisfied.
    const at = parse(`package P {
    attribute x : Real;
    constraint d { x * 3.0 == 0.3 }
    constraint lt { x < 0.1 }
}
`);
    expect(numeric(at)).toEqual(['satisfied', 'unknown']);
    expect(solveFeasible(at).decided).toBe(false);
    // A bound an optimum is driven against is met just inside it: `y = 2 * x`
    // maximised under `y < 5.0` is a feasible optimum, not a tie.
    const opt = parse(`package P {
    attribute x : Real;
    attribute y : Real;
    constraint d { y == 2.0 * x }
    constraint c { y < 5.0 }
}
`);
    const id = (name: string) => opt.all().find((e) => e.declaredName === name && e.attrs.isLibrary !== true)!.id;
    const bounds = new Map<string, [number, number]>([[id('x'), [0, 10]]]);
    const best = optimize(opt, id('y'), [id('x')], { sense: 'max', constraints: true, bounds });
    expect(best.value).toBeCloseTo(5, 5);
    expect(best.feasible).toBe(true);
  });
});

/*
 * `a != b` is the NEGATION of `a == b` on the numeric surface: the same
 * operands, the same gates, the same scale and residual, the opposite verdict.
 * Before, it had no residual at all, so wherever the unit-aware evaluator left
 * a bare literal to the scalar fallback the row was `unknown` — while the
 * validation surface read it violated and the SMT engine refuted it.
 */
describe('`!=` is judged as the negation of `==`, and never solved for', () => {
  it('reads a kinded literal against a bare literal by the declared-unit contract', () => {
    const m = parse(`package L {
    attribute limit : ISQ::MassValue = 25.0;
    constraint ne { limit != 25.0 }
    constraint neOther { limit != 26.0 }
    constraint neKg { limit != 25.0 [kg] }
    constraint neG { limit != 25.0 [g] }
}
`);
    expect(unitAware(m)).toEqual(['violated', 'satisfied', 'violated', 'satisfied']);
    expect(numeric(m)).toEqual(['violated', 'satisfied', 'violated', 'satisfied']);
    // The margin by which two values differ is no slack a reader could act on.
    expect(checkConstraintsNumeric(m).map((r) => [r.kind, r.slack, r.amount])).toEqual([
      ['boolean', null, 0],
      ['boolean', null, 0],
      ['boolean', null, 0],
      ['boolean', null, 0],
    ]);
  });

  it('refuses a `!=` exactly where its `==` is refused (guard)', () => {
    const m = parse(`package T {
    attribute t : ISQ::TemperatureValue = 20.0 ['°C'];
    constraint eq { t == 20.0 }
    constraint ne { t != 20.0 }
}
`);
    const [eq, ne] = checkConstraintsNumeric(m);
    expect([eq.result, ne.result]).toEqual(['unknown', 'unknown']);
    expect(ne.reason).toBe(eq.reason);
    expect(ne.reason).toMatch(/offset temperature scale/);
  });

  it('reads `==` and `!=` exactly where the contract leaves them to the residual, as the check does', () => {
    // The validation surface's scalar path reads both exactly; an absolute
    // 1e-6 here called `limit == 25.0000001` satisfied and its `!=` violated.
    const m = parse(`package Q {
    attribute limit : ISQ::MassValue = 25.0;
    constraint eq { limit == 25.0000001 }
    constraint ne { limit != 25.0000001 }
    constraint eqUnit { limit == 25.0000001 [kg] }
}
`);
    expect(unitAware(m)).toEqual(['violated', 'satisfied', 'violated']);
    expect(numeric(m)).toEqual(['violated', 'satisfied', 'violated']);
  });

  it('reads a connective the contract leaves to the scalar path, as the check does', () => {
    const m = parse(`package C {
    attribute limit : ISQ::MassValue = 25.0;
    constraint a { limit != 25.0 and limit >= 20.0 }
    constraint b { not (limit == 25.0) }
    constraint c { limit != 25.0 or limit >= 20.0 }
}
`);
    expect(unitAware(m)).toEqual(['violated', 'violated', 'satisfied']);
    expect(numeric(m)).toEqual(['violated', 'violated', 'satisfied']);
  });

  it('determines nothing: it is checked at the solved values, not solved from (guard)', () => {
    const m = parse(`package N {
    attribute x : Real;
    constraint c { x != 3.0 }
}
`);
    expect(gatherConstraints(m)).toEqual([]);
    expect(solvedOf(m, 'x')).toBeUndefined();
    expect(numeric(m)).toEqual(['unknown']);
  });
});

/*
 * Gate (e) on the numeric surface. A bare number compared with a value whose
 * dimension only a derivation gives has no declared unit to be read in: the
 * validation surface refused it, and this surface compared the raw SI
 * magnitude (3544.6 s ≥ 45, satisfied) — or, where an asserted equation fixed
 * the value, the raw quotient in hours (0.98 ≤ 60, satisfied). It is refused
 * here now, in the validation surface's own sentence, and kept out of the
 * relation set; and a feature an equation fixes is solved in the units the
 * equation derives.
 */
describe('a bare number against a dimension only a derivation gives is refused, as the check refuses it', () => {
  const INPUTS = `attribute capacity : ISQ::EnergyValue = 640.0 [Wh];
    attribute power : ISQ::PowerValue = 650.0 [W];`;
  const BODIES = `
    constraint eq { e == 45.0 }
    constraint ne { e != 45.0 }
    constraint ge { e >= 45.0 }
    constraint le { e <= 60.0 }
    constraint sum { e + 5.0 >= 50.0 [s] }`;

  it('refuses every operator of the gate-(c) set, with the check’s own sentence', () => {
    for (const fix of [
      'attribute e = capacity / power;',
      'attribute e; assert constraint { e == capacity / power }',
      'attribute c2; attribute e; assert constraint { c2 == capacity * 2.0 } assert constraint { e == c2 / power }',
    ]) {
      const m = parse(`package D { ${INPUTS} ${fix} ${BODIES} }`);
      const checks = new Map(checkConstraints(m).map((c) => [c.expression, c]));
      const rows = checkConstraintsNumeric(m).filter((r) => !r.raw.includes('power') && !r.raw.includes('capacity'));
      expect(rows.map((r) => r.raw), fix).toEqual([
        'e == 45.0',
        'e != 45.0',
        'e >= 45.0',
        'e <= 60.0',
        'e + 5.0 >= 50.0 [s]',
      ]);
      for (const r of rows) {
        expect([r.result, r.slack], `${fix} — ${r.raw}`).toEqual(['unknown', null]);
        expect(r.reason, `${fix} — ${r.raw}`).toMatch(/^"e" is derived from dimensioned quantities \(T\)/);
        expect(`Could not evaluate: ${r.reason}`, `${fix} — ${r.raw}`).toBe(checks.get(r.raw)!.message);
      }
    }
  });

  it('solves a feature an asserted equation fixes in SI, and no refused relation pins it', () => {
    const m = parse(`package E { ${INPUTS}
    attribute c2;
    attribute e;
    assert constraint { c2 == capacity * 2.0 }
    assert constraint { e == c2 / power }
    constraint pin { e == 45.0 }
    constraint geMin { e >= 45.0 [min] }
}
`);
    // 1280 Wh is 4 608 000 J; over 650 W, 7089.23 s — not 1.97 (hours).
    expect(solvedOf(m, 'c2')).toBeCloseTo(4_608_000, 3);
    expect(solvedOf(m, 'e')).toBeCloseTo(7089.2308, 3);
    const geMin = checkConstraintsNumeric(m).find((r) => r.raw === 'e >= 45.0 [min]')!;
    expect([geMin.result, geMin.slackUnit]).toEqual(['satisfied', 's']);
    expect(geMin.slack).toBeCloseTo(7089.2308 - 2700, 3);
    expect(unitAware(m).slice(-1)).toEqual(['satisfied']);
  });

  it('refuses a KINDED derived feature as well, in the check’s typed sentence — a kinded literal keeps the contract', () => {
    // What decides is whether the VALUE is derived from dimensioned
    // quantities, not whether the feature declares a kind: this surface read
    // `45.0` in the kind's SI unit and called `e >= 45.0` satisfied (3544.6 s),
    // where the validation surface refused it.
    const m = parse(`package K { ${INPUTS}
    attribute e : ISQ::DurationValue = capacity / power;
    attribute limit : ISQ::MassValue = 25.0;
    attribute half = 12.5;
    attribute k : ISQ::MassValue = half * 2.0;
    constraint ge { e >= 45.0 }
    constraint le { limit <= 25.0 }
    constraint kEq { k == 25.0 }
}
`);
    const checks = new Map(checkConstraints(m).map((c) => [c.expression, c]));
    const [ge, le, kEq] = checkConstraintsNumeric(m);
    expect([ge.result, ge.slack]).toEqual(['unknown', null]);
    expect(ge.reason).toMatch(
      /^"e" is derived from dimensioned quantities \(T\) and cannot be compared as a bare number; compare against a unit literal of dimension T/,
    );
    expect(`Could not evaluate: ${ge.reason}`).toBe(checks.get('e >= 45.0')!.message);
    expect(gatherInequalities(m).map((i) => i.raw)).toEqual(['limit <= 25.0']);
    // A literal, and a dimensionless derivation the kind relabels, are read
    // in the declared unit (guard).
    expect([le.result, kEq.result]).toEqual(['satisfied', 'satisfied']);
    expect(unitAware(m)).toEqual(['unknown', 'satisfied', 'satisfied']);
  });

  it('reads no magnitude from a value with a bare number against a derived dimension inside it', () => {
    // `m` was 5.98 on the scalar path (`e` read unit-blind as 0.98 h) and
    // 3549.6 here (`e` in SI): `m <= 10.0` satisfied there and violated here.
    // Neither is the author's, so `m` — and `n`, which reads it — is neither
    // solved nor compared, and the sentence names the operand inside.
    const m = parse(`package F { ${INPUTS}
    attribute e = capacity / power;
    attribute m = e + 5.0;
    attribute n = m * 2.0;
    constraint le { m <= 10.0 }
    constraint geS { m >= 50.0 [s] }
    constraint twice { n >= 1.0 }
}
`);
    expect(solvedOf(m, 'm')).toBeUndefined();
    expect(solvedOf(m, 'n')).toBeUndefined();
    const checks = new Map(checkConstraints(m).map((c) => [c.expression, c]));
    const rows = checkConstraintsNumeric(m);
    expect(rows.map((r) => r.result)).toEqual(['unknown', 'unknown', 'unknown']);
    for (const r of rows) expect(`Could not evaluate: ${r.reason}`, r.raw).toBe(checks.get(r.raw)!.message);
    expect(rows[0]!.reason).toMatch(/^"m" cannot be derived: "e" is derived from dimensioned quantities \(T\)/);
    expect(rows[2]!.reason).toMatch(/^"n" cannot be derived: "m" cannot be derived: "e" is derived/);
  });

  it('still solves a value whose dimensions agree, and keeps a kinded literal’s contract inside one (guard)', () => {
    const m = parse(`package G { ${INPUTS}
    attribute e = capacity / power;
    attribute m = e + 5.0 [s];
    attribute limit : ISQ::MassValue = 25.0;
    attribute z = limit + 5.0;
}
`);
    expect(solvedOf(m, 'm')).toBeCloseTo(3549.6154, 3);
    expect(solvedOf(m, 'z')).toBe(30);
  });
});

/*
 * An operand the validation surface refuses to read — its derivation
 * disagrees with its type, or applies a `[unit]` to a value that already
 * derives a dimension — is refused here too, with the same sentence, and the
 * relation leaves the relation set. The numeric row was already `unknown`;
 * the SMT engine, reading the same relation in raw magnitudes, PROVED `e <=
 * 45.0` from 0.98.
 */
describe('an operand whose derivation the check refuses is refused on the solver lane', () => {
  const INPUTS = `attribute capacity : ISQ::EnergyValue = 640.0 [Wh];
    attribute power : ISQ::PowerValue = 650.0 [W];`;

  it('in the check’s own sentence, and out of the relation set', () => {
    const m = parse(`package R { ${INPUTS}
    attribute e : ScalarValues::Real = capacity / power;
    attribute x : ScalarValues::Real;
    assert constraint fixX { x == capacity / power }
    attribute w : ISQ::DurationValue [min] = capacity / power;
    constraint le { e <= 45.0 }
    constraint xle { x <= 45.0 }
    constraint wge { w >= 45.0 [min] }
}
`);
    const checks = new Map(checkConstraints(m).map((c) => [c.expression, c]));
    const rows = checkConstraintsNumeric(m);
    for (const r of rows) {
      expect(r.result, r.raw).toBe('unknown');
      expect(`Could not evaluate: ${r.reason}`, r.raw).toBe(checks.get(r.raw)!.message);
    }
    expect(rows.map((r) => r.reason)).toEqual([
      '"x" derives to a dimension that disagrees with its declared type, so it is excluded from unit-aware evaluation',
      '"e" derives to a dimension that disagrees with its declared type, so it is excluded from unit-aware evaluation',
      '"x" derives to a dimension that disagrees with its declared type, so it is excluded from unit-aware evaluation',
      '"w" cannot be derived: a unit literal [min] was applied to an operand that already has dimension T',
    ]);
    expect(gatherInequalities(m)).toEqual([]);
    // The definition of `x` reads `x`, which it refuses: it fixes nothing.
    expect(solvedOf(m, 'x')).toBeUndefined();
  });
});

/*
 * A feature an asserted equation defines is solved from THAT equation. The
 * propagation sweep oriented each equality in model order, so a check written
 * above the definition fixed the feature: `e == 1.0 [h]` made `e` 3600 s, the
 * check was satisfied and the definition violated here, while the validation
 * surface read the definition as `defines e = 3544.62 [s]` and the check as
 * violated.
 */
describe('a feature an asserted equation defines is solved from that equation', () => {
  const INPUTS = `attribute capacity : ISQ::EnergyValue = 640.0 [Wh];
    attribute power : ISQ::PowerValue = 650.0 [W];`;

  it('whatever is written above it', () => {
    const m = parse(`package T { ${INPUTS}
    attribute e;
    constraint eqH { e == 1.0 [h] }
    assert constraint fixE { e == capacity / power }
}
`);
    expect(solvedOf(m, 'e')).toBeCloseTo(3544.6154, 3);
    expect(unitAware(m)).toEqual(['violated', 'satisfied']);
    expect(numeric(m)).toEqual(['violated', 'satisfied']);
  });

  it('through a chain of definitions and a value between them', () => {
    const m = parse(`package J { ${INPUTS}
    attribute c2;
    attribute c3 = c2 / 4.0;
    attribute e;
    constraint eqH { e == 1.0 [h] }
    assert constraint fixC2 { c2 == capacity * 2.0 }
    assert constraint fixE { e == c3 / power }
}
`);
    // 1280 Wh / 4 / 650 W = 1772.3 s.
    expect(solvedOf(m, 'e')).toBeCloseTo(1772.3077, 3);
    expect(numeric(m)).toEqual(unitAware(m));
    expect(numeric(m)[0]).toBe('violated');
  });

  it('while a feature nothing defines is still fixed by any equality (guard)', () => {
    const m = parse(`package U {
    attribute x;
    constraint pin { x == 3.0 }
    constraint ge { x >= 2.0 }
}
`);
    expect(solvedOf(m, 'x')).toBe(3);
    expect(numeric(m)).toEqual(['satisfied', 'satisfied']);
  });
});

/*
 * Every instance is a variable of its own (D1 Stage 2). One per feature made
 * two parts of one type one value: `g1.g == 3.0` fixed `g2.g` too, and
 * `g2.g <= 1.0` was violated and the model infeasible; a derived value read in
 * a usage that changes its input was the definition's.
 */
describe('every instance is a variable of its own on the solver lane', () => {
  it('solves each instance from its own equations, and fixes no other instance from one', () => {
    const m = parse(`package SI {
    part def P { attribute load : Real default = 1.0; attribute m2 : Real = 10.0 - load; }
    part p1 : P;
    part p2 : P { attribute :>> load = 50.0; }
    constraint diff { p1.m2 - p2.m2 >= 40.0 }
    part def G { attribute g : Real; }
    part g1 : G;
    part g2 : G;
    constraint pin { g1.g == 3.0 }
    constraint other { g2.g <= 1.0 }
}
`);
    const solved = solve(m);
    const instance = (symbol: string) => [...solved.values].find(([k]) => k.endsWith(`@${symbol}`))?.[1];
    // p1 changes nothing m2 reads: P's own 9. p2's is its own.
    expect([solvedOf(m, 'm2'), instance('SI::p2::m2'), instance('SI::p1::m2')]).toEqual([9, -40, undefined]);
    expect([instance('SI::g1::g'), instance('SI::g2::g')]).toEqual([3, undefined]);
    const rows = new Map(checkConstraintsNumeric(m).map((r) => [r.name, r]));
    expect([rows.get('diff')!.result, rows.get('diff')!.slack]).toEqual(['satisfied', 9]);
    expect(rows.get('other')!.result).toBe('unknown');
    expect(solveFeasible(m).feasible).toBe(true);
    // The Solve panel lists an instance's value under the instance's name.
    expect(analysisReport(m).values.map((v) => v.element.qualifiedName)).toContain('SI::p2::m2');
  });

  it('solves a copy a binding materialises as the value it reads — the feature’s, or the instance’s own', () => {
    // `bind w = p.load` binds p's copy of P's load: 5, never a value the solve
    // picks for the copy (it read `w >= 2.0` violated at 1). Through `s : S`,
    // the copy is of S's `:>> load = 5.0`; through p2, whose load P's `m2`
    // reads, the copy of m2 is p2's −40.
    const m = parse(`package BC {
    part def P { attribute load : Real default = 5.0; attribute m2 : Real = 10.0 - load; }
    part def S :> P { attribute :>> load = 7.0; }
    part p : P;
    part s : S;
    part p2 : P { attribute :>> load = 50.0; }
    attribute w : Real;
    attribute ws : Real;
    attribute w2 : Real;
    bind w = p.load;
    bind ws = s.load;
    bind w2 = p2.m2;
}
`);
    expect([solvedOf(m, 'w'), solvedOf(m, 'ws'), solvedOf(m, 'w2')]).toEqual([5, 7, -40]);

    // A copy declares no unit: bound through the feature whose value it reads,
    // P's `len default = 2.0 [km]` is 2000 m in `wr`, never the stored 2, and
    // the model is feasible (u4).
    const u4 = parse(`package U4 {
    part def P { attribute len : ISQ::LengthValue default = 2.0 [km]; }
    part q : P { attribute :>> len = 6.0 [km]; }
    part r : P;
    attribute w : ISQ::LengthValue;
    attribute wr : ISQ::LengthValue;
    bind w = q.len;
    bind wr = r.len;
    constraint cqT { w >= 5999.0 [m] }
    constraint crT { wr >= 1999.0 [m] }
}
`);
    expect([solvedOf(u4, 'w'), solvedOf(u4, 'wr')]).toEqual([6000, 2000]);
    expect(numeric(u4)).toEqual(['satisfied', 'satisfied']);
    expect(solveFeasible(u4).feasible).toBe(true);
    // A copy's value written `(expr) [unit]` is `expr` IN that unit, read in
    // the copy's own context: q's `len` is (3 * 2.0) km, 6000 m in `w` (u5).
    const u5 = parse(`package U5 {
    part def P {
        attribute k : Real default = 1.0;
        attribute len : ISQ::LengthValue = (k * 2.0) [km];
    }
    part q : P { attribute :>> k = 3.0; }
    attribute w : ISQ::LengthValue;
    bind w = q.len;
    constraint cqT { w >= 5999.0 [m] }
}
`);
    expect(solvedOf(u5, 'w')).toBe(6000);
    expect(numeric(u5)).toEqual(['satisfied']);
    // One the gates cannot scale (an offset unit) is unreadable, and so is
    // what it binds: `w` is unknown, never 1 at the solve's starting point.
    const u5c = parse(`package U5C {
    part def P {
        attribute k : Real default = 1.0;
        attribute t : ISQ::TemperatureValue = (k * 2.0) ['°C'];
    }
    part q : P { attribute :>> k = 3.0; }
    attribute w : ISQ::TemperatureValue;
    bind w = q.t;
    constraint cqT { w >= 5.0 ['°C'] }
}
`);
    expect(solvedOf(u5c, 'w')).toBeUndefined();
    expect(numeric(u5c)).toEqual(['unknown']);
  });

  it('holds an instance to the asserts of the instance enclosing it, which no check orients (d2)', () => {
    // P's assert is a fact of p's sub: p.sub.x is 10, whatever a check
    // written beside it says — read for the instance alone, the check fixed
    // it at 1, and `p.sub.x >= 4.0` was violated.
    const m = parse(`package D2 {
    part def Sub { attribute x : Real; }
    part def P { part sub : Sub; assert constraint lim { sub.x == 10.0 } }
    part p : P;
    constraint xeq { p.sub.x == 1.0 }
    constraint xT { p.sub.x >= 4.0 }
}
`);
    const rows = new Map(checkConstraintsNumeric(m).map((r) => [r.name, r]));
    expect([rows.get('xeq')!.result, rows.get('xT')!.result, rows.get('xT')!.slack]).toEqual([
      'violated',
      'satisfied',
      6,
    ]);
  });

  it('computes every instance a definition determines from that definition, not as a Newton unknown', () => {
    // A depth-8 tree of instances over 256 free leaves: every instance's sum
    // is its own variable. One dense Newton step over every instance value
    // took a minute on a depth-9 tree; substituted in dependency order, each
    // is its definition's value at whatever its free leaves are.
    const defs = [
      'part def N0 { attribute x : Real; attribute s : Real = x; }',
      ...Array.from(
        { length: 8 },
        (_, i) => `part def N${i + 1} { part a : N${i}; part b : N${i}; attribute s : Real = a.s + b.s; }`,
      ),
    ];
    const m = parse(`package T8 {
    ${defs.join('\n    ')}
    part top : N8;
    constraint sum { top.s == top.a.s + top.b.s }
}
`);
    const solved = solve(m);
    expect(solved.converged).toBe(true);
    // The leaves are design freedoms, and so is every sum over them: each an
    // instance's own variable, solved along the freedom and never published
    // as a value; the check holds at every point of it.
    const free = (symbol: string) => solved.free.some((k) => k.endsWith(`@${symbol}`));
    expect(['T8::top::s', 'T8::top::a::s', 'T8::top::b::s'].map(free)).toEqual([true, true, true]);
    expect([...solved.values.keys()].some((k) => k.includes('@'))).toBe(false);
    // …and the Solve panel lists each as a freedom, under the instance's name.
    expect(analysisReport(m).free.map((f) => f.qualifiedName)).toEqual(
      expect.arrayContaining(['T8::top::s', 'T8::top::a::s', 'T8::top::b::s']),
    );
    expect(numeric(m)).toEqual(['satisfied']);
  });

  it('holds a binding and an asserted equation as facts no check orients, at the top and in an instance (c3, c7, b3, d1)', () => {
    // Bindings are gathered last: `w == 18.0` was oriented first, w was 18
    // beside the −40 (9) it is bound to, and the check "satisfied — imposed
    // by the solve" where every other surface reads it violated.
    const bound = (copy: string) => `package C3 {
    part def P { attribute load : Real default = 1.0; attribute m2 : Real = 10.0 - load; }
    part p : P { attribute :>> load = 50.0; }
    attribute load : Real = 1.0;
    attribute m2 : Real = 10.0 - load;
    attribute w : Real;
    bind w = ${copy};
    constraint wF { w == 18.0 }
}
`;
    for (const [copy, value] of [
      ['p.m2', -40],
      ['m2', 9],
    ] as const) {
      const m = parse(bound(copy));
      expect([solvedOf(m, 'w'), only(m).result, only(m).imposed], copy).toEqual([value, 'violated', undefined]);
    }
    // An asserted `p.x == 3.0` defines p's x, so its `y = x * 2.0` is 6, never the 7 a check asks for.
    const b3 = parse(`package B3 {
    part def P { attribute x : Real; attribute y : Real = x * 2.0; }
    part p : P;
    assert constraint px { p.x == 3.0 }
    constraint gF { p.y == 7.0 }
}
`);
    const r3 = new Map(checkConstraintsNumeric(b3).map((r) => [r.name, r]));
    expect([r3.get('gF')!.result, r3.get('gF')!.imposed]).toEqual(['violated', undefined]);
    // Sys's binding carries the asserted 5 to s.q.load: `== 1.0` is violated, `>= 4.0` holds.
    const d1 = parse(`package D1 {
    part def P { attribute load : Real; }
    part def Sys { part p : P; part q : P; bind p.load = q.load; }
    part s : Sys;
    assert constraint pFix { s.p.load == 5.0 }
    constraint qeq { s.q.load == 1.0 }
    constraint qT { s.q.load >= 4.0 }
}
`);
    const r1 = new Map(checkConstraintsNumeric(d1).map((r) => [r.name, r]));
    expect([r1.get('qeq')!.result, r1.get('qT')!.result, r1.get('qT')!.slack]).toEqual(['violated', 'satisfied', 1]);
    expect(solveFeasible(d1).violations).toEqual([]);
  });

  it('holds a stated value expression as a fact no check orients either, wherever the check is written (b4)', () => {
    // x is asserted 3, so the stated `y = x * 2.0` is 6. A plain `y == 7.0`
    // was oriented to fix y at 7 beside it: the solver published 7, and
    // `w == y + 1.0` imposed w = 8, so `w <= 7.5` was violated where w = 7
    // meets it.
    const b4 = (checkFirst: boolean) => {
      const check = 'constraint gF { y == 7.0 }';
      return `package B4 {
    ${checkFirst ? check : ''}
    attribute x : Real;
    attribute y : Real = x * 2.0;
    attribute w : Real;
    assert constraint px { x == 3.0 }
    ${checkFirst ? '' : check}
    constraint wd { w == y + 1.0 }
    constraint wl { w <= 7.5 }
}
`;
    };
    for (const checkFirst of [false, true]) {
      const m = parse(b4(checkFirst));
      const tag = checkFirst ? 'check written first' : 'check written after';
      expect([solvedOf(m, 'y'), solvedOf(m, 'w')], tag).toEqual([6, 7]);
      const r = new Map(checkConstraintsNumeric(m).map((row) => [row.name, row]));
      expect([r.get('gF')!.result, r.get('gF')!.amount, r.get('gF')!.imposed], tag).toEqual(['violated', 1, undefined]);
      expect([r.get('wd')!.result, r.get('wd')!.imposed, r.get('wl')!.result], tag).toEqual(['satisfied', true, 'satisfied']);
      // The imposed equation fixed w alone: y is the model's own.
      expect(r.get('wd')!.reason, tag).toMatch(/fixes w, so/);
      const f = solveFeasible(m);
      expect([f.feasible, f.decided, f.violations], tag).toEqual([true, true, []]);
      expect(analysisReport(m).violations.map((v) => [v.expression, v.amount]), tag).toEqual([['y == 7.0', 1]]);
    }
  });

  it('judges a definition’s constraint in a context at the values the model states, and not at a caller’s (sf1, sf2)', () => {
    const ctx = (x: number) => `package SF {
    part def P {
        attribute k : Real default = 1.0;
        attribute x : Real default = 10.0;
        attribute y : Real = x * k;
        constraint c { y >= 10.0 }
    }
    part p : P { attribute :>> k = 2.0; attribute :>> x = ${x}; }
}
`;
    const xOf = (m: Model) => m.all().find((e) => e.ownerId != null && m.qualifiedName(e.ownerId) === 'SF::p' && typeof e.attrs.value === 'number' && e.attrs.value !== 2)!.id;
    // Stated 3: violated in p, and decided so.
    const broken = parse(ctx(3));
    expect([solveFeasible(broken).feasible, solveFeasible(broken).decided]).toEqual([false, true]);
    // Fixed to another value, the stated values' verdict is of another point:
    // p.x = 10 meets c, and p.x = 1 breaks it where the stated 30 met it.
    for (const [stated, fixed] of [
      [3, 10],
      [30, 1],
    ] as const) {
      const m = parse(ctx(stated));
      const r = solveFeasible(m, { fixed: new Map([[xOf(m), fixed]]) });
      expect([r.violations, r.decided], `stated ${stated}, fixed ${fixed}`).toEqual([[], false]);
    }
  });

  it('joins a unit beside a value where an instance reads it, never at the definition alone (iu1)', () => {
    // P's k is a number, p's GiB: p's copy of `(k * 2.0) [GiB]` puts GiB on
    // bits, and was solved as 2^35 GiB — `p.total <= 5.0 [GiB]` decided
    // infeasible where every other surface cannot derive p's total.
    const m = parse(`package IU {
    part def P {
        attribute cap : ISQ::StorageCapacityValue default = 2.0 [GiB];
        attribute k : Real default = 1.0;
        attribute total : ISQ::StorageCapacityValue = (k * 2.0) [GiB];
    }
    part p : P { attribute :>> k = cap; }
    part r : P { attribute :>> k = cap / 1.0 [GiB]; }
    constraint pSmall { p.total <= 5.0 [GiB] }
    constraint rT { r.total == 4.0 [GiB] }
}
`);
    const solved = solve(m);
    const instance = (symbol: string) => [...solved.values].find(([k]) => k.endsWith(`@${symbol}`))?.[1];
    expect([instance('IU::p::total'), instance('IU::r::total')]).toEqual([undefined, 4]);
    expect(numeric(m)).toEqual(['unknown', 'satisfied']);
    expect(solveFeasible(m).violations).toEqual([]);
  });
});

/*
 * A feature chain to a value only an asserted equation defines: the
 * validation surface does not read a definition through a chain, and says
 * so; the solver lane did, and judged `p.e >= 45.0 [min]` from it.
 */
describe('a feature chain is read no further on the solver lane than the check reads it', () => {
  const chain = (usage: string) => `package S {
    part def P {
      attribute capacity : ISQ::EnergyValue default = 640.0 [Wh];
      attribute power : ISQ::PowerValue = 650.0 [W];
      attribute e;
      assert constraint fixE { e == capacity / power }
    }
    ${usage}
    constraint withUnit { p.e >= 45.0 [min] }
    constraint bare { p.e >= 45.0 }
}
`;

  it('reads a chain to a defined value through a usage that redefines its input in that usage, as the check reads it (Stage 2)', () => {
    // P's definition holds of p, over p's names: 1300 Wh / 650 W = 2 h.
    const m = parse(chain('part p : P { attribute :>> capacity = 1300.0 [Wh]; }'));
    const checks = new Map(checkConstraints(m).map((c) => [c.expression, c]));
    const rows = new Map(checkConstraintsNumeric(m).map((r) => [r.raw, r]));
    expect([rows.get('p.e >= 45.0 [min]')!.result, checks.get('p.e >= 45.0 [min]')!.result]).toEqual([
      'satisfied',
      'satisfied',
    ]);
    expect(rows.get('p.e >= 45.0 [min]')!.slack).toBeCloseTo(7200 - 2700, 6);
    const bare = rows.get('p.e >= 45.0')!;
    expect(bare.result).toBe('unknown');
    expect(`Could not evaluate: ${bare.reason}`).toBe(checks.get('p.e >= 45.0')!.message);
    // p's e is a variable of its own, apart from P's 3544.6 s.
    const values = [...solve(m).values].filter(([k]) => k.includes('@')).map(([, v]) => v);
    expect(values.some((v) => Math.abs(v - 7200) < 1e-6)).toBe(true);
  });

  it('reads it where the usage changes nothing it reads, as the check reads it (P’s e, 59.1 min)', () => {
    const m = parse(chain('part p : P;'));
    const checks = new Map(checkConstraints(m).map((c) => [c.expression, c]));
    const rows = new Map(checkConstraintsNumeric(m).map((r) => [r.raw, r]));
    expect([rows.get('p.e >= 45.0 [min]')!.result, checks.get('p.e >= 45.0 [min]')!.result]).toEqual([
      'satisfied',
      'satisfied',
    ]);
    // A bare number against the derived duration is refused on both, in one sentence.
    const bare = rows.get('p.e >= 45.0')!;
    expect(bare.result).toBe('unknown');
    expect(`Could not evaluate: ${bare.reason}`).toBe(checks.get('p.e >= 45.0')!.message);
    expect(gatherInequalities(m).map((i) => i.raw)).toEqual(['p.e >= 45.0 [min]']);
  });
});

/*
 * What the validation surface reads one definition at a time — a loop, a nest
 * past the cap — is a limit of that reading, not a fault in the value: the
 * solver lane solves such a system as a whole, as it always has. Refusing every
 * relation over it left a unitless coupled system with no values at all, every
 * row `unknown`, and `solveFeasible` calling an impossible bound feasible.
 */
describe('a system the check reads one definition at a time is still solved', () => {
  it('solves a coupled pair of definitions and judges the relations over it', () => {
    const m = parse(`package ML {
    attribute dry = 100.0;
    attribute mass;
    attribute fuel;
    assert constraint m { mass == dry + fuel }
    assert constraint f { fuel == mass * 0.2 }
    constraint chk { mass <= 200.0 }
    constraint chk2 { fuel >= 30.0 }
}
`);
    expect([solvedOf(m, 'mass'), solvedOf(m, 'fuel')]).toEqual([125, 25]);
    expect(numeric(m)).toEqual(['satisfied', 'satisfied', 'satisfied', 'violated']);
    const f = solveFeasible(m);
    expect([f.feasible, f.violations.map((v) => v.name)]).toEqual([false, ['chk2']]);
  });

  it('solves a chain of definitions nested past the cap', () => {
    let body = 'attribute x0 = 1.0;\n';
    for (let i = 1; i <= 70; i++) body += `attribute x${i}; assert constraint d${i} { x${i} == x${i - 1} + 1.0 }\n`;
    const m = parse(`package Deep { ${body} constraint chk { x70 <= 80.0 } }\n`);
    expect(solvedOf(m, 'x70')).toBe(71);
    expect(checkConstraintsNumeric(m).find((r) => r.name === 'chk')!.result).toBe('satisfied');
  });
});

/*
 * Only a definition that ANSWERS holds its feature against every other
 * equality. One with an input nothing fixes yet (`x == 2.0 ^ y`) defines no
 * value: the system is solved as a whole, a check beside it fixing `x` and
 * the equation then `y`. Holding `x` for it left the system unsolved — and
 * `solveFeasible` spread a violation over values that broke both equalities.
 */
describe('a definition that answers nothing yet holds nothing', () => {
  it('solves an equation whose input only another equality fixes', () => {
    const m = parse(`package E {
    attribute x; attribute y;
    assert constraint dx { x == 2.0 ^ y }
    constraint c { x == 1024.0 }
}
`);
    const solved = solve(m);
    expect(solved.converged).toBe(true);
    expect([solvedOf(m, 'x'), solvedOf(m, 'y')]).toEqual([1024, 10]);
    expect(numeric(m)).toEqual(['satisfied', 'satisfied']);
  });

  it('reports the true violation of an infeasible bound, not one spread over broken equalities', () => {
    const m = parse(`package TripI {
    attribute d = 100.0;
    attribute t;
    attribute v;
    assert constraint speed { v == d / t }
    constraint target { v == 20.0 }
    constraint tmax { t <= 4.0 }
}
`);
    const f = solveFeasible(m);
    const valueOf = (name: string) => f.values.get(m.all().find((e) => e.declaredName === name)!.id)!;
    expect(f.feasible).toBe(false);
    expect(f.violations.map((v) => v.name)).toEqual(['tmax']);
    expect(f.violations[0]!.amount).toBeCloseTo(1, 9);
    expect(valueOf('t')).toBeCloseTo(5, 9);
    expect(valueOf('v')).toBeCloseTo(20, 9);
  });
});

/*
 * A feature whose own value reads a chain the validation surface reads no
 * definition through has no value the solver lane may use — and it is no
 * design freedom either: `solveFeasible` drove `total` to −1 to meet `total <=
 * 2.5` and reported the model feasible.
 */
describe('a value over a chain the check does not read is no free variable', () => {
  const battery = (usage: string) => `package VC {
    part def Battery { attribute capacity default = 640.0; attribute power = 650.0; attribute e; assert constraint d { e == capacity / power } }
    ${usage}
    attribute total = p.e * 2.0;
    constraint chk { total <= 2.5 }
}
`;

  it('solves it where the chain reads the definition in the usage that changes its input, and does not move it (Stage 2)', () => {
    // Battery's definition holds of p, over p's capacity: e = 2, total = 4.
    const m = parse(battery('part p : Battery { attribute :>> capacity = 1300.0; }'));
    const total = m.all().find((e) => e.declaredName === 'total')!.id;
    expect(solve(m).values.get(total)).toBeCloseTo(4, 9);
    const f = solveFeasible(m);
    expect([f.feasible, f.values.get(total)]).toEqual([false, solve(m).values.get(total)]);
    expect(checkConstraintsNumeric(m).find((r) => r.name === 'chk')!.result).toBe('violated');
    expect(checkConstraints(m).find((c) => c.expression === 'total <= 2.5')!.result).toBe('violated');
  });

  it('solves it where the chain reads the definition, and judges the check on both surfaces', () => {
    const m = parse(battery('part p : Battery;'));
    const total = m.all().find((e) => e.declaredName === 'total')!.id;
    expect(solve(m).values.get(total)).toBeCloseTo((640 / 650) * 2, 9);
    expect(checkConstraintsNumeric(m).find((r) => r.name === 'chk')!.result).toBe('satisfied');
    expect(checkConstraints(m).find((c) => c.expression === 'total <= 2.5')!.result).toBe('satisfied');
  });
});

/*
 * A calculation's value body, a binding and a defining equation with a
 * `[unit]` literal each give a value a dimension the solver lane used to miss:
 * it solved them unit-blind (0.98, Wh/W) or raw, and judged — and the SMT
 * engine proved — bare numbers against them that the validation surface
 * refuses or could not read.
 */
describe('every derivation is read in SI on the solver lane', () => {
  const INPUTS = `attribute capacity : ISQ::EnergyValue = 640.0 [Wh];
    attribute power : ISQ::PowerValue = 650.0 [W];`;
  const sentence = (name: string) =>
    new RegExp(`^"${name}" is derived from dimensioned quantities \\(T\\) and cannot be compared as a bare number`);

  for (const [shape, decl, name] of [
    ['a calculation', 'calc e { capacity / power }', 'e'],
    ['a binding', 'attribute d = capacity / power; attribute e; bind e = d;', 'e'],
    ['a defining equation with a unit literal', 'attribute e; assert constraint fixE { e == 640.0 [Wh] / power }', 'e'],
  ] as const) {
    it(`${shape}: solved in seconds, refused against a bare number, judged against a unit literal`, () => {
      const m = parse(`package D { ${INPUTS}
    ${decl}
    constraint ge { ${name} >= 45.0 }
    constraint geMin { ${name} >= 45.0 [min] }
}
`);
      expect(solvedOf(m, name)).toBeCloseTo(3544.6154, 3);
      const checks = new Map(checkConstraints(m).map((c) => [c.expression, c]));
      const rows = new Map(checkConstraintsNumeric(m).map((r) => [r.raw, r]));
      const ge = rows.get(`${name} >= 45.0`)!;
      expect(ge.result).toBe('unknown');
      expect(ge.reason).toMatch(sentence(name));
      expect(`Could not evaluate: ${ge.reason}`).toBe(checks.get(`${name} >= 45.0`)!.message);
      expect([rows.get(`${name} >= 45.0 [min]`)!.result, checks.get(`${name} >= 45.0 [min]`)!.result]).toEqual([
        'satisfied',
        'satisfied',
      ]);
      // A refused bare number never pins the feature it reads.
      expect(gatherInequalities(m).map((i) => i.raw)).toEqual([`${name} >= 45.0 [min]`]);
    });
  }
});

/*
 * The validation surface's scalar path reads `==` exactly over what the model
 * STATES; a value only the solver determined it does not read at all. An
 * exact reading of a solved unknown reported the equation the unknown was
 * solved from as violated (`x * 3.0 == 0.3` with `x` 0.09999999999999999).
 */
describe('a relation over a solved unknown keeps the solver’s tolerance', () => {
  it('judges the equation it solved from as satisfied, and reads a stated value exactly (guard)', () => {
    const m = parse(`package CS {
    attribute x : ISQ::MassValue;
    constraint c { x * 3.0 == 0.3 }
    attribute limit : ISQ::MassValue = 25.0;
    constraint near { limit == 25.0000001 }
}
`);
    expect(numeric(m)).toEqual(['satisfied', 'violated']);
  });
});

/*
 * A valueless feature with an ASSERTED definition is never fixed by a plain
 * check, and never a design freedom of `solveFeasible`, whatever stopped that
 * definition — a gate refused it (it reads an inherited `e` only P's own
 * equation defines), it loops, it nests past the cap, or it reads a value
 * nothing numeric gives. Only an input that is a genuine design freedom (no
 * value, no equation, no binding of its own: `x == 2.0 ^ y`) lets a check
 * stand in. The checks it would have oriented read the inverse of the
 * definition: `f == 100.0` satisfied and `f <= 10.0` violated over `f == e +
 * 1.0` (7), or a loop's asserted `fuel == mass * 0.2` violated beside a
 * satisfied `mass == 130.0`.
 */
describe('a check never stands in for an asserted definition', () => {
  const feature = (m: Model, name: string) => m.all().find((e) => e.declaredName === name && e.attrs.isLibrary !== true)!;
  const rows = (m: Model) => new Map(checkConstraintsNumeric(m).map((r) => [r.name, r.result]));

  it('solves a feature whose definition reads an inherited value its context changes from that definition, read there (C2)', () => {
    const m = parse(`package C2 {
    part def P { attribute a default = 2.0; attribute b = 3.0; attribute e; assert constraint d { e == a * b } }
    part def S :> P {
      attribute :>> a = 5.0;
      attribute f;
      assert constraint g { f == e + 1.0 }
      constraint c { f == 100.0 }
      constraint u { f <= 10.0 }
    }
}
`);
    // P's `d` holds of every S, over S's `a`: e is 15 in S (P's own is 6), so
    // f is 16 — from its definition, never from the check `f == 100.0`.
    const f = feature(m, 'f').id;
    expect(solve(m).values.get(f)).toBe(16);
    const r = rows(m);
    expect([r.get('g'), r.get('c'), r.get('u')]).toEqual(['satisfied', 'violated', 'violated']);
    const checks = new Map(checkConstraints(m).map((c) => [c.expression, c.result]));
    expect([checks.get('f == 100.0'), checks.get('f <= 10.0')]).toEqual(['violated', 'violated']);
    const feas = solveFeasible(m);
    expect([feas.values.get(f), feas.violations.map((v) => v.name)]).toEqual([16, ['u']]);
    const report = analysisReport(m);
    expect(report.violations.map((v) => v.expression)).toEqual(['f == 100.0', 'f <= 10.0']);
    expect(report.unknowns).toEqual([]);
    // S's own e is listed under its own name, beside P's.
    expect(report.values.filter((v) => v.element.qualifiedName.endsWith('::e')).map((v) => [v.element.qualifiedName, v.value])).toEqual([
      ['C2::P::e', 6],
      ['C2::S::e', 15],
    ]);
  });

  it('reads the inherited definition where the specialisation changes nothing it reads (C2, unredefined)', () => {
    const m = parse(`package C2n {
    part def P { attribute a = 2.0; attribute b = 3.0; attribute e; assert constraint d { e == a * b } }
    part def S :> P {
      attribute f;
      assert constraint g { f == e + 1.0 }
      constraint c { f == 100.0 }
      constraint u { f <= 10.0 }
    }
}
`);
    expect(solvedOf(m, 'f')).toBe(7);
    const r = rows(m);
    expect([r.get('g'), r.get('c'), r.get('u')]).toEqual(['satisfied', 'violated', 'satisfied']);
    const checks = new Map(checkConstraints(m).map((c) => [c.expression, c.result]));
    expect([checks.get('f == 100.0'), checks.get('f <= 10.0')]).toEqual(['violated', 'satisfied']);
    expect(solveFeasible(m).violations.map((v) => v.name)).toEqual([]);
  });

  it('does not move such a feature to meet a bound, in a usage or a specialisation, and reads it there (U5, U6)', () => {
    const usage = parse(`package U5 {
    part def Drone {
      attribute capacity default = 640.0;
      attribute power = 650.0;
      attribute endurance;
      assert constraint d { endurance == capacity / power }
    }
    part drone : Drone {
      attribute :>> capacity = 1300.0;
      attribute margin;
      assert constraint dm { margin == endurance - 0.5 }
      constraint req { margin >= 1.0 }
    }
}
`);
    const special = parse(`package U6 {
    part def P { attribute a default = 2.0; attribute b = 3.0; attribute e; assert constraint d { e == a * b } }
    part def S :> P { attribute :>> a = 5.0; attribute f; assert constraint g { f == e + 1.0 } constraint u { f >= 10.0 } }
}
`);
    // The definitions hold of the usage and the specialisation, over their own
    // inputs: drone's endurance is 2 (margin 1.5), S's e is 15 (f 16).
    for (const [m, name, bound, value] of [
      [usage, 'margin', 'req', 1.5],
      [special, 'f', 'u', 16],
    ] as const) {
      const feas = solveFeasible(m);
      expect([feas.feasible, feas.values.get(feature(m, name).id)], name).toEqual([true, value]);
      expect(rows(m).get(bound), name).toBe('satisfied');
    }
  });

  it('solves a loop from its definitions, whatever check is written beside it (G5b)', () => {
    const m = parse(`package G5b {
    attribute dry = 100.0;
    attribute mass;
    attribute fuel;
    constraint c { mass == 130.0 }
    assert constraint m { mass == dry + fuel }
    assert constraint f { fuel == mass * 0.2 }
    constraint u { fuel <= 25.5 }
}
`);
    expect([solvedOf(m, 'mass'), solvedOf(m, 'fuel')]).toEqual([125, 25]);
    const r = rows(m);
    // The definitions hold; the check is judged against them, as SMT reads them.
    expect([r.get('m'), r.get('f'), r.get('c'), r.get('u')]).toEqual(['satisfied', 'satisfied', 'violated', 'satisfied']);
    const feas = solveFeasible(m);
    expect([feas.feasible, feas.violations]).toEqual([true, []]);
  });

  it('solves a chain past the cap from its definitions, with the check written above it (G6b)', () => {
    let body = 'constraint c { x70 == 200.0 }\nattribute x0 = 1.0;\n';
    for (let i = 1; i <= 70; i++) body += `attribute x${i}; assert constraint d${i} { x${i} == x${i - 1} + 1.0 }\n`;
    const m = parse(`package G6b { ${body} constraint u { x70 <= 75.0 } }\n`);
    expect(solvedOf(m, 'x70')).toBe(71);
    const r = rows(m);
    expect([r.get('d70'), r.get('c'), r.get('u')]).toEqual(['satisfied', 'violated', 'satisfied']);
    expect(solveFeasible(m).violations).toEqual([]);
  });

  it('solves no value from a definition over a string, and frees nothing (guard)', () => {
    const m = parse(`package G7 {
    attribute a = "abc";
    attribute e;
    assert constraint d { e == a * 2.0 }
    constraint c { e == 9.0 }
    constraint u { e <= 5.0 }
}
`);
    const solved = solve(m);
    expect([solved.values.has(feature(m, 'a').id), solved.values.has(feature(m, 'e').id)]).toEqual([false, false]);
    expect([...rows(m).values()]).toEqual(['unknown', 'unknown', 'unknown']);
    const feas = solveFeasible(m);
    expect([feas.values.has(feature(m, 'e').id), feas.violations]).toEqual([false, []]);
  });
});

/*
 * A definition binds what it defines only where the definitions ALONE
 * determine it. One that leaves a design freedom — an input reached through a
 * chain, held by a binding, written after the loop's other operand, a chain
 * past the cap from a free root, a redundant pair — is solved with the check
 * that fixes it, as it always was: left out, the solve stopped at an arbitrary
 * least-squares point and reported a satisfiable check violated, invented a
 * measure of effectiveness, and called a feasible design infeasible.
 */
describe('a definition that leaves a design freedom holds nothing a check fixes', () => {
  const byName = (m: Model) => new Map(checkConstraintsNumeric(m).map((r) => [r.name, r.result]));

  it('solves a free capacity read through a chain from the check that sizes it (d10)', () => {
    const m = parse(`package D10 {
    part def Battery { attribute capacity : ISQ::EnergyValue; }
    part def Drone {
      part battery : Battery;
      attribute power : ISQ::PowerValue = 200.0 [W];
      attribute enduranceMeasure : ISQ::TimeValue;
      assert constraint de { enduranceMeasure == battery.capacity / power }
      constraint sized { enduranceMeasure == 2.0 [h] }
      constraint need { enduranceMeasure >= 1.5 [h] }
    }
}
`);
    const solved = solve(m);
    expect(solved.converged).toBe(true);
    expect(solvedOf(m, 'enduranceMeasure')).toBeCloseTo(7200, 6);
    // The capacity solved is Drone's battery's — an instance of Battery, its own
    // variable — not Battery's own (one for every battery).
    expect(solved.values.has(m.all().find((e) => e.declaredName === 'capacity')!.id)).toBe(false);
    const own = [...solved.values].find(([k]) => k.endsWith('@D10::Drone::battery::capacity'));
    expect(own?.[1]).toBeCloseTo(1.44e6, 3);
    expect([...byName(m).values()]).toEqual(['satisfied', 'satisfied', 'satisfied']);
    expect(solveFeasible(m).feasible).toBe(true);
    expect(evaluateMoEs(m).find((x) => x.name === 'enduranceMeasure')?.value).toBeCloseTo(7200, 6);
  });

  it('solves a loop over a free input whatever order its operands are written in (d1r)', () => {
    for (const sum of ['dry + fuel', 'fuel + dry']) {
      const m = parse(`package D1 {
    attribute dry;
    attribute mass;
    attribute fuel;
    assert constraint dm { mass == ${sum} }
    assert constraint df { fuel == mass * 0.2 }
    constraint target { mass == 130.0 }
}
`);
      const solved = [solvedOf(m, 'mass'), solvedOf(m, 'fuel'), solvedOf(m, 'dry')].map((x) => Number(x?.toPrecision(12)));
      expect(solved, sum).toEqual([130, 26, 104]);
      expect([...byName(m).values()], sum).toEqual(['satisfied', 'satisfied', 'satisfied']);
    }
  });

  it('solves a chain of 66 definitions from a free root, past the cap, from the check at its end', () => {
    let body = 'attribute x0;\n';
    for (let i = 1; i <= 66; i++) body += `attribute x${i}; assert constraint d${i} { x${i} == x${i - 1} + 1.0 }\n`;
    const m = parse(`package DP { ${body} constraint fix { x66 == 96.0 } }\n`);
    const solved = solve(m);
    expect(solved.converged).toBe(true);
    expect(solvedOf(m, 'x0')).toBeCloseTo(30, 9);
    expect(checkConstraintsNumeric(m).filter((r) => r.result !== 'satisfied')).toEqual([]);
  });

  it('solves a redundant pair of definitions from the check that fixes it (d5)', () => {
    const m = parse(`package D5 {
    attribute voltage = 12.0;
    attribute power;
    attribute current;
    assert constraint dp { power == voltage * current }
    assert constraint dc { current == power / voltage }
    constraint target { power == 120.0 }
    constraint lim { current <= 15.0 }
}
`);
    expect([solvedOf(m, 'power'), solvedOf(m, 'current')]).toEqual([120, 10]);
    expect([...byName(m).values()]).toEqual(['satisfied', 'satisfied', 'satisfied', 'satisfied']);
    expect(solveFeasible(m).feasible).toBe(true);
  });
});

describe('a design freedom no relation fixes is never judged at the solver’s point (D5)', () => {
  const rows = (m: Model) => new Map(checkConstraintsNumeric(m).map((r) => [r.name, r]));
  const byName = (m: Model) => new Map([...rows(m)].map(([n, r]) => [n, r.result]));
  const idOf = (m: Model, name: string) => m.all().find((e) => e.declaredName === name && e.attrs.isLibrary !== true)!.id;
  const freeNames = (m: Model) => solve(m).free.map((id) => m.get(id)?.declaredName).sort();
  /** The asserted loop `mass == dry + fuel`, `fuel == mass * 0.2`, then `extra`. */
  const loop = (extra: string, dry = '') => `package D2 {
    attribute dry${dry};
    attribute mass;
    attribute fuel;
    assert constraint dm { mass == dry + fuel }
    assert constraint df { fuel == mass * 0.2 }
    ${extra}
}
`;

  it('withholds a loop over a free input and judges nothing over it (p01)', () => {
    const m = parse(loop('constraint need { mass >= 130.0 }\n    constraint cap { dry <= 110.0 }'));
    const solved = solve(m);
    expect(freeNames(m)).toEqual(['dry', 'fuel', 'mass']);
    for (const name of ['dry', 'fuel', 'mass']) expect(solved.values.has(idOf(m, name)), name).toBe(false);
    const r = rows(m);
    // The asserted equations hold at every point of the freedom.
    expect([r.get('dm')!.result, r.get('df')!.result]).toEqual(['satisfied', 'satisfied']);
    expect(r.get('dm')!.imposed).toBeUndefined();
    for (const name of ['need', 'cap']) {
      expect(r.get(name)!.result, name).toBe('unknown');
      expect(r.get(name)!.slack, name).toBeNull();
      expect(r.get(name)!.reason, name).toMatch(/left free by the equations/);
    }
    const report = analysisReport(m);
    expect(report.violations).toEqual([]);
    expect(report.feasible).toBe(true);
    expect(report.unknowns.map((u) => u.element.declaredName)).toEqual(['need', 'cap']);
    expect(report.free.map((f) => f.declaredName).sort()).toEqual(['dry', 'fuel', 'mass']);
    expect(report.values).toEqual([]);
    const feasible = solveFeasible(m);
    expect([feasible.feasible, feasible.decided]).toEqual([true, true]);
  });

  it('a value derived from a freedom is free with it (p06)', () => {
    const m = parse(loop('assert constraint dc { cost == mass * 3.0 }\n    attribute cost;\n    constraint budget { cost >= 300.0 }'));
    expect(solve(m).values.has(idOf(m, 'cost'))).toBe(false);
    expect(byName(m).get('budget')).toBe('unknown');
    expect(rows(m).get('budget')!.reason).toMatch(/^cost is left free by the equations/);
  });

  it('still judges what the equations determine beside a freedom (p04)', () => {
    const m = parse(`package P4 {
    attribute x = 3.0;
    attribute y;
    attribute a;
    attribute b;
    assert constraint dy { y == x * 2.0 }
    constraint total { a + b == 10.0 }
    constraint ylim { y <= 5.0 }
    constraint alim { a <= 100.0 }
    constraint blim { b >= 8.0 }
}
`);
    const r = byName(m);
    expect([r.get('ylim'), r.get('alim'), r.get('blim')]).toEqual(['violated', 'unknown', 'unknown']);
    expect(analysisReport(m).violations.map((v) => v.expression)).toEqual(['y <= 5.0']);
    const feasible = solveFeasible(m);
    expect(feasible.decided).toBe(true);
    expect(feasible.violations.map((v) => v.name)).toEqual(['ylim']);
    expect(feasible.unresolved.map((v) => v.name)).toEqual(['blim']);
  });

  it('leaves determined systems as they were (p03, p05)', () => {
    const p3 = parse(`package P3 {
    attribute a;
    attribute b;
    constraint total { a + b == 10.0 }
    constraint diff { a - b == 2.0 }
    constraint lim { a >= 8.0 }
}
`);
    expect([solvedOf(p3, 'a'), solvedOf(p3, 'b')]).toEqual([6, 4]);
    expect(byName(p3).get('lim')).toBe('violated');
    expect(solve(p3).free).toEqual([]);
    const feasible = solveFeasible(p3);
    expect(feasible.violations.map((v) => [v.name, v.amount])).toEqual([['lim', 2]]);
    expect([feasible.values.get(idOf(p3, 'a')), feasible.values.get(idOf(p3, 'b'))]).toEqual([6, 4]);
    // A plain check that fixes the freedom still fixes it.
    const p5 = parse(`package P5 {
    attribute a;
    attribute b;
    constraint total { a + b == 10.0 }
    constraint pick { a == 3.0 }
    constraint lim { b >= 8.0 }
}
`);
    expect(byName(p5).get('lim')).toBe('violated');
  });

  it('labels a PLAIN constraint the solve took as a design equation imposed by the solve', () => {
    const p5 = parse(`package P5 {
    attribute a;
    attribute b;
    constraint total { a + b == 10.0 }
    constraint pick { a == 3.0 }
    constraint lim { b >= 8.0 }
}
`);
    const r = rows(p5);
    for (const name of ['total', 'pick']) {
      expect(r.get(name)!.result, name).toBe('satisfied');
      expect(r.get(name)!.imposed, name).toBe(true);
      expect(r.get(name)!.reason, name).toMatch(/^imposed by the solve: no value the model states fixes a/);
    }
    // A bound judged at what they fix is a verdict, not an imposition.
    expect(r.get('lim')!.imposed).toBeUndefined();
    // One over a freedom holds along it, and is imposed all the same (p02).
    const p2 = parse(`package P2 {
    attribute a;
    attribute b;
    constraint total { a + b == 10.0 }
    constraint lim { a >= 8.0 }
}
`);
    const r2 = rows(p2);
    expect([r2.get('total')!.result, r2.get('total')!.imposed]).toEqual(['satisfied', true]);
    expect(r2.get('lim')!.result).toBe('unknown');
    // A plain constraint over values the model states is a check, and an
    // asserted equation holds by assertion: neither is labelled.
    const stated = parse(`package S {
    attribute a = 3.0;
    attribute b;
    constraint c { a == 3.0 }
    assert constraint d { b == a * 2.0 }
}
`);
    const rs = rows(stated);
    expect([rs.get('c')!.result, rs.get('c')!.imposed, rs.get('c')!.reason]).toEqual(['satisfied', undefined, undefined]);
    expect([rs.get('d')!.result, rs.get('d')!.imposed]).toEqual(['satisfied', undefined]);
  });

  it('known is what is stated, fixed or bound — never a value oriented from a freedom (xs5)', () => {
    // `cost` is oriented from `mass` once Newton has put a number on the free
    // loop: a value the solve reached, not one the model states.
    const xs5 = parse(loop('attribute cost;\n    assert constraint dc { cost == 3.0 / (mass - 1.0) }\n    constraint need { mass >= 130.0 }'));
    expect(freeNames(xs5)).toEqual(['cost', 'dry', 'fuel', 'mass']);
    expect(solve(xs5).values.size).toBe(0);
    expect(byName(xs5).get('need')).toBe('unknown');
    // A value the caller fixes, and one a binding carries from a stated value,
    // are given: the loop is determined from either.
    const fixed = parse(loop('constraint need { mass >= 130.0 }'));
    const held = solve(fixed, { fixed: { [idOf(fixed, 'dry')]: 100 } });
    expect(held.free).toEqual([]);
    expect(held.values.get(idOf(fixed, 'mass'))).toBeCloseTo(125, 9);
    const bound = parse(loop('attribute dryStated = 100.0;\n    bind dry = dryStated;\n    constraint need { mass >= 130.0 }'));
    expect(solve(bound).free).toEqual([]);
    expect(solvedOf(bound, 'mass')).toBeCloseTo(125, 9);
    expect(byName(bound).get('need')).toBe('violated');
  });

  it('a relation whose residual jumps inside the probe fixes nothing (`if`, `%`)', () => {
    // Each relation is solved at x = 1 exactly, on its step, where the central
    // difference reads the step's height over the probe's width: a pivot that
    // "determined" x, and `x <= 1.5` was satisfied although x = 1.9 solves the
    // relation as well and breaks the bound.
    for (const body of ['r == (if x >= 1.0 then 1.0 else 0.0)', 'r == x - x % 1.0']) {
      const m = parse(`package J {
    attribute r = 1.0;
    attribute x;
    constraint c { ${body} }
    constraint lim { x <= 1.5 }
}
`);
      expect(freeNames(m), body).toEqual(['x']);
      const r = rows(m);
      expect(r.get('lim')!.result, body).toBe('unknown');
      expect(r.get('lim')!.reason, body).toMatch(/^x is left free by the equations/);
      expect([r.get('c')!.result, r.get('c')!.imposed], body).toEqual(['satisfied', true]);
    }
    // The step is read in its own feature: a co-variable of 5e6 in the same
    // relation, steeper than the step's slope, hid it (r6, r7).
    for (const body of ['y == z + (if x >= 1.0 then 1.0 else 0.0)', 'y == z + x - x % 1.0']) {
      const m = parse(`package R6 {
    attribute q = 1.0;
    attribute y = 5000001.0;
    attribute z;
    attribute x;
    constraint dz { z == 5000000.0 * q }
    constraint c { ${body} }
    constraint lim { x <= 1.5 }
}
`);
      expect(freeNames(m), body).toEqual(['x']);
      expect(solvedOf(m, 'z'), body).toBe(5000000);
      expect(byName(m).get('lim'), body).toBe('unknown');
    }
    // Asserted definitions stopped on a step, or where a slope cannot be read,
    // determine nothing either: `a == b` beside either solves every a past 1
    // (r8) — or every a up to 1 (r9) — and a = 1 was published and judged.
    for (const [d2, lim] of [
      ['b == (if a >= 1.0 then a else a + 1.0)', 'a <= 1.5'],
      ['b == a + 0.0 * (1.0 - a) ^ 0.5', 'a >= 0.8'],
    ] as const) {
      const m = parse(`package R8 {
    attribute a;
    attribute b;
    assert constraint d1 { a == b }
    assert constraint d2 { ${d2} }
    constraint lim { ${lim} }
}
`);
      expect(freeNames(m), d2).toEqual(['a', 'b']);
      expect(byName(m).get('lim'), d2).toBe('unknown');
    }
  });

  it('a step a definition stops on binds nothing, and the search moves past it (j3b, j1b)', () => {
    // Every a ≥ 1 solves both definitions; the solve stopped at a = 1, where
    // `a >= 2.0` was VIOLATED, and the search held a there: decided infeasible.
    const j3b = parse(`package J3B {
    attribute a;
    attribute b;
    assert constraint d1 { a == b }
    assert constraint d2 { b == a + (if a >= 1.0 then 0.0 else 1.0) }
    constraint lim2 { a >= 2.0 }
}
`);
    expect(freeNames(j3b)).toEqual(['a', 'b']);
    expect(byName(j3b).get('lim2')).toBe('unknown');
    const f3 = solveFeasible(j3b);
    expect([f3.feasible, f3.decided, f3.violations]).toEqual([true, true, []]);
    expect(f3.values.get(idOf(j3b, 'a'))).toBeGreaterThanOrEqual(2 - 1e-6);
    // A single equation over the step pinned x where the solve stopped, though
    // the solve itself reads x as free.
    const j1b = parse(`package J1B {
    attribute r = 1.0;
    attribute x;
    constraint c { r == (if x >= 1.0 then 1.0 else 0.0) }
    constraint lim { x >= 2.0 }
}
`);
    const f1 = solveFeasible(j1b);
    expect([f1.feasible, f1.decided, f1.violations]).toEqual([true, true, []]);
    expect(f1.values.get(idOf(j1b, 'x'))).toBeGreaterThanOrEqual(2 - 1e-6);
    // Definitions read as closing what they define where a slope cannot be
    // read (a = 1, the edge of `(1.0 - a) ^ 0.5`) were held there: `a <= 0.8`
    // decided infeasible, although a = b = 0.5 solves both (r9b).
    const r9b = parse(`package R9B {
    attribute a;
    attribute b;
    assert constraint d1 { a == b }
    assert constraint d2 { b == a + 0.0 * (1.0 - a) ^ 0.5 }
    constraint lim { a <= 0.8 }
}
`);
    const f9 = solveFeasible(r9b);
    expect([f9.feasible, f9.decided, f9.violations]).toEqual([true, true, []]);
    expect(f9.values.get(idOf(r9b, 'a'))).toBeLessThanOrEqual(0.8 + 1e-6);
  });

  it('definitions stopped on a step leave a check free to fix what they do not (j6)', () => {
    // Read as binding at a = 1, the definitions kept `a == 3.0` out of the
    // solve: a = 1 was published, the check read violated and `a <= 2.0`
    // satisfied — but a = b = 3 solves everything, and breaks the bound.
    const m = parse(`package J6 {
    attribute a;
    attribute b;
    assert constraint d1 { a == b }
    assert constraint d2 { b == a + (if a >= 1.0 then 0.0 else 1.0) }
    constraint c { a == 3.0 }
    constraint lim { a <= 2.0 }
}
`);
    expect([solvedOf(m, 'a'), solvedOf(m, 'b')]).toEqual([3, 3]);
    const r = rows(m);
    expect([r.get('c')!.result, r.get('c')!.imposed, r.get('lim')!.result]).toEqual(['satisfied', true, 'violated']);
    const feasible = solveFeasible(m);
    expect([feasible.feasible, feasible.decided]).toEqual([false, true]);
    expect(feasible.violations.map((v) => v.name)).toEqual(['lim']);
  });

  it('a feature that reads a freedom is free with it, however small the dependence (r2c, r2n)', () => {
    // `offset` moves a `range` of a hundred kilometres by 1e-8 of its row in
    // millimetres — under any pivot tolerance — and by an exact 0 in
    // nanometres. `range` was published as determined, `range >= 100.5 [km]`
    // refuted, and infeasibility decided, although an offset of 500 m meets it.
    for (const unit of ['mm', 'nm']) {
      const m = parse(`package R2 {
    attribute base : ISQ::LengthValue = 100.0 [km];
    attribute range : ISQ::LengthValue [km];
    attribute offset : ISQ::LengthValue [${unit}];
    assert constraint c { range == base + offset }
    constraint reach { range >= 100.5 [km] }
}
`);
      expect(freeNames(m), unit).toEqual(['offset', 'range']);
      expect(byName(m).get('reach'), unit).toBe('unknown');
      const feasible = solveFeasible(m);
      expect([feasible.feasible, feasible.decided], unit).toEqual([true, true]);
      expect(feasible.values.get(idOf(m, 'range')), unit).toBeCloseTo(100.5, 6);
    }
  });

  it('an equation over a pole at the guess is taken back in once the step is off it (e2)', () => {
    // From x = 1, `2.0 / (x - 1.0)` has no value: the equation was left out of
    // the whole solve, the point reached without it (x = y = 2.5) published,
    // and the ASSERTED equation judged violated although x = 3 ± √2 solve both.
    const m = parse(`package E4 {
    attribute x;
    attribute y;
    constraint e1 { x + y == 5.0 }
    assert constraint e2 { y == 2.0 / (x - 1.0) }
    constraint lim { x >= 5.0 }
}
`);
    const solved = solve(m);
    expect([solved.converged, solved.free]).toEqual([true, []]);
    const x = solvedOf(m, 'x')!;
    expect(Math.min(Math.abs(x - (3 + Math.SQRT2)), Math.abs(x - (3 - Math.SQRT2)))).toBeLessThan(1e-6);
    expect([byName(m).get('e2'), byName(m).get('lim')]).toEqual(['satisfied', 'violated']);
    const feasible = solveFeasible(m);
    expect([feasible.feasible, feasible.decided]).toEqual([false, true]);
    expect(feasible.violations.map((v) => v.name)).toEqual(['lim']);
  });

  it('Newton writes back only what it drives, and an undrivable equation no longer ends it (p16, p17, p12, p19)', () => {
    // p16: `z` is read only by the check; it was written back at the guess 1
    // and the check, which fixes it, then read violated by 4.
    const p16 = parse(loop('attribute z;\n    constraint fixz { mass + z == 130.0 }', ' = 100.0'));
    expect(solvedOf(p16, 'z')).toBeCloseTo(5, 9);
    expect(solve(p16).converged).toBe(true);
    expect(byName(p16).get('fixz')).toBe('satisfied');
    // p17: two features one check reads are a freedom of it.
    const p17 = parse(loop('attribute z;\n    attribute w;\n    constraint fixzw { mass + z + w == 130.0 }\n    constraint zlim { z >= 3.0 }', ' = 100.0'));
    expect([byName(p17).get('fixzw'), byName(p17).get('zlim')]).toEqual(['satisfied', 'unknown']);
    const feasible = solveFeasible(p17);
    expect(feasible.feasible).toBe(true);
    expect(feasible.values.get(idOf(p17, 'z'))).toBeCloseTo(3, 5);
    expect(feasible.values.get(idOf(p17, 'w'))).toBeCloseTo(2, 5);
    // p12: `subject c = craft` has no residual; it ended Newton on its first
    // iteration, every unknown was written back at 1, and the asserted loop
    // read VIOLATED by 1 and 0.8.
    const p12 = parse(`package P12 {
    part def Craft {
      attribute dry;
      attribute mass;
      attribute fuel;
      assert constraint dm { mass == dry + fuel }
      assert constraint df { fuel == mass * 0.2 }
    }
    part craft : Craft;
    requirement def NeedMass {
      subject c : Craft;
      require constraint { c.mass >= 130.0 }
    }
    requirement need : NeedMass { subject c = craft; }
    satisfy need by craft;
}
`);
    const r12 = checkConstraintsNumeric(p12);
    expect(r12.filter((r) => r.name === 'dm' || r.name === 'df').map((r) => r.result)).toEqual(['satisfied', 'satisfied']);
    expect(r12.find((r) => r.raw === 'c.mass >= 130.0')?.result).toBe('unknown');
    expect([...solve(p12).values.keys()].map((id) => p12.get(id)?.declaredName)).not.toContain('c');
    // p19: a Boolean read by `== false` has no numeric value, not the guess 1.
    const p19 = parse(`package P19 {
    part def Unit {
      attribute withinOperatingEnvelope : Boolean = false;
      attribute load = 3.0;
    }
    part u : Unit;
    requirement def R {
      subject s : Unit;
      assume constraint { s.withinOperatingEnvelope == false }
      require constraint { s.load <= 5.0 }
    }
    requirement r : R;
    satisfy r by u;
}
`);
    expect(solve(p19).values.has(idOf(p19, 'withinOperatingEnvelope'))).toBe(false);
    expect(solveFeasible(p19).values.has(idOf(p19, 'withinOperatingEnvelope'))).toBe(false);
  });

  it('a measure over a freedom is unknown, and an objective over one is not optimised (p07, p08)', () => {
    const p7 = parse(loop('attribute massMeasure;\n    assert constraint mm { massMeasure == mass }'));
    expect(evaluateMoEs(p7).find((x) => x.name === 'massMeasure')?.value).toBeNull();
    const p8 = parse(`package P8 {
    attribute a;
    attribute b;
    attribute total;
    assert constraint dt { total == a + b }
    constraint blim { b >= 5.0 }
}
`);
    const a = idOf(p8, 'a');
    const res = optimize(p8, idOf(p8, 'total'), [a], { bounds: { [a]: [0, 10] }, sense: 'max', constraints: true });
    expect(Number.isNaN(res.value)).toBe(true);
    expect(res.feasible).toBeUndefined();
    expect(res.free).toEqual(expect.arrayContaining([idOf(p8, 'b'), idOf(p8, 'total')]));
  });
});
