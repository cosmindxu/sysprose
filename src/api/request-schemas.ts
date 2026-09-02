/**
 * Inbound request-body schemas for the REST / OMG API (finding H1).
 *
 * Every mutating handler used to `as`-cast `req.body` with no runtime check, so a
 * client (or a fuzzer) sending a non-object body or a wrong-typed field could
 * drive type-confusion crashes or malformed-state writes. These `ajv` validators
 * reject such bodies up front; the handler then returns `400 Bad Request`.
 *
 * The schemas are ADDITIVE: they do not require fields (each handler keeps its
 * own "missing required field ⇒ 405/handler-specific" behaviour) — they only
 * assert that a body, WHEN PRESENT, is an object with correctly-typed fields.
 */
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';

let _ajv: Ajv | undefined;
function ajv(): Ajv {
  return _ajv ?? (_ajv = new Ajv({ allErrors: true }));
}

/** `{ name?: string }` — project create / rename. */
const projectBody = {
  type: 'object',
  properties: { name: { type: 'string' } },
  additionalProperties: false,
} as const;

/** `{ name?, fromCommit?, fromCommitId? }` — branch create. */
const branchBody = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    fromCommit: { type: 'string' },
    fromCommitId: { type: 'string' },
  },
  additionalProperties: false,
} as const;

/** `{ name?, commit?, commitId? }` — tag create. */
const tagBody = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    commit: { type: 'string' },
    commitId: { type: 'string' },
  },
  additionalProperties: false,
} as const;

/** `{ source?, target?, sourceBranch?, targetBranch?, strategy? }` — merge. */
const mergeBody = {
  type: 'object',
  properties: {
    source: { type: 'string' },
    target: { type: 'string' },
    sourceBranch: { type: 'string' },
    targetBranch: { type: 'string' },
    strategy: { type: 'string' },
  },
  additionalProperties: false,
} as const;

/**
 * Commit request: `{ branch?, baseCommit?, description?, changes? }`. `changes`
 * is the load-bearing part — each entry must be an object carrying an
 * `operation` string, so a malformed change array is rejected before
 * `applyChange` runs. Extra OMG transport fields are tolerated.
 */
const commitBody = {
  type: 'object',
  properties: {
    branch: { type: 'string' },
    branchId: { type: 'string' },
    baseCommit: { type: 'string' },
    baseCommitId: { type: 'string' },
    description: { type: 'string' },
    changes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['create', 'update', 'delete'] },
          identifier: { type: 'string' },
          // Endpoint arrays must be arrays if present — a scalar here would
          // crash applyChange's `refs.map` (finding H1).
          element: {
            type: 'object',
            properties: {
              source: { type: 'array' },
              target: { type: 'array' },
              attrs: { type: 'object' },
            },
          },
        },
        required: ['operation'],
      },
    },
  },
  additionalProperties: true,
} as const;

/**
 * Stored-query body: `{ name?, query?, … }`. The query itself has a rich,
 * recursively-typed shape validated downstream by the query engine (and the
 * ReDoS-safe `matches` matcher); here we only assert an object body with a
 * string `name`, tolerating the query fields.
 */
const queryBody = {
  type: 'object',
  properties: { name: { type: 'string' } },
  additionalProperties: true,
} as const;

export type RequestBodyKind =
  | 'project'
  | 'branch'
  | 'tag'
  | 'merge'
  | 'commit'
  | 'query';

let _validators: Record<RequestBodyKind, ValidateFunction> | undefined;

function validators(): Record<RequestBodyKind, ValidateFunction> {
  if (!_validators) {
    const a = ajv();
    _validators = {
      project: a.compile(projectBody),
      branch: a.compile(branchBody),
      tag: a.compile(tagBody),
      merge: a.compile(mergeBody),
      commit: a.compile(commitBody),
      query: a.compile(queryBody),
    };
  }
  return _validators;
}

/** Compact, human-readable rendering of an ajv error. */
function fmtError(e: ErrorObject): string {
  const path = e.instancePath || '(body)';
  return `${path} ${e.message ?? 'is invalid'}`.trim();
}

/**
 * Validate a request body against the named schema. Returns `null` when the
 * body is absent (undefined/null — the handler decides what to do) or valid;
 * otherwise a list of human-readable error strings.
 */
export function validateRequestBody(kind: RequestBodyKind, body: unknown): string[] | null {
  if (body === undefined || body === null) return null;
  const validate = validators()[kind];
  if (validate(body)) return null;
  return (validate.errors ?? []).map(fmtError);
}
