/**
 * Pipeline integration — Parse → numeric solve → MoE + REST analysis.
 *
 * Parses a small parametric model in the textual notation (feature-value
 * expression assignments form the parametric chain), solves it through the
 * {@link ModelApi} SDK, reads its measure of effectiveness, and asserts the
 * shape of the `GET /analytics/analysis` REST route.
 */

import { describe, it, expect } from 'vitest';
import { parseModel } from '@text/index';
import { ModelApi, SysmlApiServer, type AnalysisReport } from '@api/index';

const SOURCE = `
package Parametric {
    part def Dynamics {
        attribute mass : Real = 1500.0;
        attribute acceleration : Real = 2.0;
        attribute velocity : Real = 10.0;
        attribute force : Real = mass * acceleration;
        attribute powerMoE : Real = force * velocity;
    }
}
`;

const { model } = parseModel(SOURCE);
const api = new ModelApi(model);

function id(qname: string): string {
  const el = api.byName(qname);
  if (!el) throw new Error(`No element: ${qname}`);
  return el.id;
}

describe('pipeline: Parse → ModelApi.solve', () => {
  it('parses the parametric attributes', () => {
    expect(api.byName('Parametric::Dynamics::force')).toBeDefined();
    expect(model.get(id('Parametric::Dynamics::force'))!.attrs.value).toBe('mass * acceleration');
  });

  it('solves the parametric chain to a fixpoint', () => {
    const res = api.solve();
    expect(res.converged).toBe(true);
    expect(res.values.get(id('Parametric::Dynamics::force'))).toBeCloseTo(3000, 6);
    expect(res.values.get(id('Parametric::Dynamics::powerMoE'))).toBeCloseTo(30000, 6);
    expect(res.residual).toBeLessThan(1e-6);
  });

  it('evaluates the named measure of effectiveness', () => {
    const measures = api.evaluateMoEs();
    const power = measures.find((mo) => mo.name === 'powerMoE');
    expect(power).toBeDefined();
    expect(power!.id).toBe(id('Parametric::Dynamics::powerMoE'));
    expect(power!.value).toBeCloseTo(30000, 6);
  });
});

describe('REST GET /analytics/analysis', () => {
  it('returns a solved analysis report with values + measures', () => {
    const server = new SysmlApiServer(model);
    const r = server.apiFetch('GET', '/analytics/analysis');
    expect(r.status).toBe(200);
    const body = r.body as AnalysisReport;
    expect(body.converged).toBe(true);
    expect(typeof body.iterations).toBe('number');
    expect(typeof body.residual).toBe('number');
    expect(Array.isArray(body.values)).toBe(true);
    expect(Array.isArray(body.measures)).toBe(true);
    // The solved value rows carry navigable element references.
    const forceRow = body.values.find((v) => v.element.declaredName === 'force');
    expect(forceRow).toBeDefined();
    expect(forceRow!.value).toBeCloseTo(3000, 6);
    // The MoE appears in the measures.
    expect(body.measures.some((mo) => mo.name === 'powerMoE' && mo.value === 30000)).toBe(true);
  });

  it('preserves the existing analytics routes', () => {
    const server = new SysmlApiServer(model);
    expect(server.apiFetch('GET', '/analytics/metrics').status).toBe(200);
    expect(server.apiFetch('GET', '/analytics/units').status).toBe(200);
    expect(server.apiFetch('GET', '/analytics/nope').status).toBe(404);
  });
});
