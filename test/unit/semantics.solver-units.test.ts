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
 */
describe('two different dimensions are not a comparison the solver may answer', () => {
  const lengthVsDuration = (op: string) =>
    req(
      `        attribute d : ISQ::LengthValue = 5.0 [km];
        attribute t : ISQ::DurationValue = 3000.0 [s];`,
      `v.d ${op} v.t`,
    );

  it('`v.d >= v.t` (a length against a duration) agrees with the validation surface', () => {
    const m = parse(lengthVsDuration('>='));
    expect(unitAware(m)).toEqual(['violated']);
    expect(numeric(m)).toEqual(['violated']);
    // Judged in the declared magnitudes (5 >= 3000), not in SI (5000 >= 3000).
    expect(only(m).amount).toBeCloseTo(2995, 6);
    expect(only(m).slackUnit).toBeUndefined();
    expect(analysisReport(m).feasible).toBe(false);
  });

  it('and so does the `<=` mirror', () => {
    const m = parse(lengthVsDuration('<='));
    expect(unitAware(m)).toEqual(['satisfied']);
    expect(numeric(m)).toEqual(['satisfied']);
    expect(analysisReport(m).feasible).toBe(true);
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

  it('a binding across an OFFSET scale copies, so its equation still converges', () => {
    // The solver refuses to scale a relation touching °C (gate b), so the
    // binding equation is read in raw magnitudes; converting the propagated
    // value to kelvin would leave that equation with a residual of 273.15.
    const m = parse(`package P {
    attribute a : ISQ::TemperatureValue = 20.0 ['°C'];
    attribute b : ISQ::TemperatureValue;
    bind a = b;
}
`);
    expect(solvedOf(m, 'b')).toBeCloseTo(20, 9);
    expect(solve(m).converged).toBe(true);
    expect(solve(m).residual).toBeCloseTo(0, 9);
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
