import { describe, it, expect } from 'vitest';
import { buildSampleModel } from '@core/index';
import { SysmlApiServer } from '@api/index';

function srv(): SysmlApiServer {
  return new SysmlApiServer(buildSampleModel());
}

/** Finding H1: inbound bodies are ajv-validated; malformed bodies ⇒ 400. */
describe('SysmlApiServer — request body validation (H1)', () => {
  it('rejects a non-object project body', () => {
    expect(srv().apiFetch('POST', '/projects', 'not-an-object').status).toBe(400);
    expect(srv().apiFetch('POST', '/projects', 42).status).toBe(400);
    expect(srv().apiFetch('POST', '/projects', ['a']).status).toBe(400);
  });

  it('rejects a wrong-typed project name but accepts a valid one', () => {
    expect(srv().apiFetch('POST', '/projects', { name: 123 }).status).toBe(400);
    expect(srv().apiFetch('POST', '/projects', { name: 'Proj' }).status).toBe(201);
  });

  it('rejects unknown fields on a strict body (additionalProperties:false)', () => {
    expect(srv().apiFetch('POST', '/projects', { name: 'X', junk: true }).status).toBe(400);
  });

  it('validates branch create bodies', () => {
    const s = srv();
    expect(s.apiFetch('POST', '/projects/project-default/branches', { name: 7 }).status).toBe(400);
    expect(
      s.apiFetch('POST', '/projects/project-default/branches', { fromCommit: 9 }).status,
    ).toBe(400);
    expect(
      s.apiFetch('POST', '/projects/project-default/branches', { name: 'dev' }).status,
    ).toBe(201);
  });

  it('validates the commit changes array shape', () => {
    const s = srv();
    // changes must be an array of {operation, …}
    expect(
      s.apiFetch('POST', '/projects/project-default/commits', { changes: 'nope' }).status,
    ).toBe(400);
    expect(
      s.apiFetch('POST', '/projects/project-default/commits', { changes: [{ noOp: 1 }] }).status,
    ).toBe(400);
  });

  it('rejects a non-object stored-query body', () => {
    expect(
      srv().apiFetch('POST', '/projects/project-default/queries', 'x').status,
    ).toBe(400);
    // A valid object body is accepted.
    expect(
      srv().apiFetch('POST', '/projects/project-default/queries', { name: 'q' }).status,
    ).toBe(201);
  });

  it('still 405s (not 400) when a required field is simply absent', () => {
    // An empty object is a valid shape; the handler then applies its own
    // missing-required-field behaviour (legacy 405), not a 400.
    expect(srv().apiFetch('POST', '/projects', {}).status).toBe(405);
  });

  it('does not crash on a malformed query constraint (H1 hang fix)', () => {
    const s = srv();
    // A non-string / missing constraint property must NOT throw — an uncaught
    // throw here would leave an HTTP client hanging forever.
    expect(() =>
      s.apiFetch('POST', '/queries', { constraint: { property: 123, operator: '=' } }),
    ).not.toThrow();
    expect(s.apiFetch('POST', '/queries', { constraint: { operator: '=' } }).status).toBe(200);
    expect(srv().apiFetch('POST', '/queries', 'not-an-object').status).toBe(400);
  });

  it('rejects an unknown commit operation and a scalar endpoint field', () => {
    const s = srv();
    expect(
      s.apiFetch('POST', '/projects/project-default/commits', {
        changes: [{ operation: 'frobnicate' }],
      }).status,
    ).toBe(400);
    expect(
      s.apiFetch('POST', '/projects/project-default/commits', {
        changes: [{ operation: 'create', element: { source: 'oops' } }],
      }).status,
    ).toBe(400);
  });
});
