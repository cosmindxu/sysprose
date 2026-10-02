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
 * A feature chain to a value only an asserted equation defines: the
 * validation surface does not read a definition through a chain, and says
 * so; the solver lane did, and judged `p.e >= 45.0 [min]` from it.
 */
describe('a feature chain is read no further on the solver lane than the check reads it', () => {
  const chain = (usage: string) => `package S {
    part def P {
      attribute capacity : ISQ::EnergyValue = 640.0 [Wh];
      attribute power : ISQ::PowerValue = 650.0 [W];
      attribute e;
      assert constraint fixE { e == capacity / power }
    }
    ${usage}
    constraint withUnit { p.e >= 45.0 [min] }
    constraint bare { p.e >= 45.0 }
}
`;

  it('refuses a chain to a defined value through a usage that redefines its input, in the check’s sentence, with or without a unit', () => {
    const m = parse(chain('part p : P { attribute :>> capacity = 1300.0 [Wh]; }'));
    const checks = new Map(checkConstraints(m).map((c) => [c.expression, c]));
    const rows = checkConstraintsNumeric(m).filter((r) => r.raw.startsWith('p.'));
    expect(rows.map((r) => r.result)).toEqual(['unknown', 'unknown']);
    for (const r of rows) {
      expect(r.reason, r.raw).toMatch(/^p\.e has no value: P::e is declared without one, its asserted equation is not read/);
      expect(`Could not evaluate: ${r.reason}`, r.raw).toBe(checks.get(r.raw)!.message);
    }
    expect(gatherInequalities(m)).toEqual([]);
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
    part def Battery { attribute capacity = 640.0; attribute power = 650.0; attribute e; assert constraint d { e == capacity / power } }
    ${usage}
    attribute total = p.e * 2.0;
    constraint chk { total <= 2.5 }
}
`;

  it('leaves the feature out of the solve and out of feasibility', () => {
    const m = parse(battery('part p : Battery { attribute :>> capacity = 1300.0; }'));
    const total = m.all().find((e) => e.declaredName === 'total')!.id;
    expect(solve(m).values.has(total)).toBe(false);
    expect(solveFeasible(m).values.has(total)).toBe(false);
    expect(checkConstraintsNumeric(m).find((r) => r.name === 'chk')!.result).toBe('unknown');
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

  it('leaves a feature whose refused definition reads an inherited value unknown, oriented by nothing (C2)', () => {
    const m = parse(`package C2 {
    part def P { attribute a = 2.0; attribute b = 3.0; attribute e; assert constraint d { e == a * b } }
    part def S :> P {
      attribute :>> a = 5.0;
      attribute f;
      assert constraint g { f == e + 1.0 }
      constraint c { f == 100.0 }
      constraint u { f <= 10.0 }
    }
}
`);
    const f = feature(m, 'f').id;
    expect(solve(m).values.has(f)).toBe(false);
    const r = rows(m);
    expect([r.get('c'), r.get('u')]).toEqual(['unknown', 'unknown']);
    const feas = solveFeasible(m);
    expect([feas.values.has(f), feas.violations.map((v) => v.name)]).toEqual([false, []]);
    // The Solve panel lists them as unknowns, never as a violation of `u`.
    const report = analysisReport(m);
    expect(report.violations.map((v) => v.expression)).toEqual([]);
    expect(report.unknowns.map((u) => u.expression).sort()).toEqual(['f == 100.0', 'f <= 10.0', 'f == e + 1.0'].sort());
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

  it('does not move such a feature to meet a bound, in a usage or a specialisation (U5, U6)', () => {
    const usage = parse(`package U5 {
    part def Drone {
      attribute capacity = 640.0;
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
    part def P { attribute a = 2.0; attribute b = 3.0; attribute e; assert constraint d { e == a * b } }
    part def S :> P { attribute :>> a = 5.0; attribute f; assert constraint g { f == e + 1.0 } constraint u { f >= 10.0 } }
}
`);
    for (const [m, name, bound] of [
      [usage, 'margin', 'req'],
      [special, 'f', 'u'],
    ] as const) {
      const feas = solveFeasible(m);
      expect(feas.values.has(feature(m, name).id), name).toBe(false);
      expect(rows(m).get(bound), name).toBe('unknown');
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
    expect(solvedOf(m, 'capacity')).toBeCloseTo(1.44e6, 3);
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
