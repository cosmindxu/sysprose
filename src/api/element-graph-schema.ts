/**
 * JSON Schema (draft 2020-12) for the OMG SysML v2 *API & Services*
 * **element-graph** exchange shape — the document produced by
 * `exportModel(model, 'api-json')` (see {@link ../persistence/io}).
 *
 * CLEAN-ROOM NOTICE. This schema was authored ORIGINALLY from the OMG SysML v2
 * *API & Services* / OSLC specifications and the project's own standard
 * reference (docs/02-omg-standard-reference.md §5.4). No schema text was copied
 * from any implementation; consulted specs are recorded in docs/LICENSES.md.
 *
 * The element-graph is a flat, self-describing element list: an object with an
 * `elements` array, each entry carrying a required `@id` / `@type` (the OMG
 * `@id`/`@type` identity pair), optional `declaredName` / `declaredShortName`,
 * and reified relationship fields (`ownedRelationship`, `owningRelationship`,
 * `source`/`target`, the membership `memberElement` / `ownedMemberElement` /
 * `owningRelatedElement`). Every metaclass-specific attribute rides along at the
 * top level, so the schema is intentionally OPEN (`additionalProperties: true`)
 * — faithful to the exchange shape without being over-strict.
 *
 * The validator is built with the default `ajv` build (`import Ajv from 'ajv'`),
 * whose bundled meta-schema is draft-07. The core keywords used here (`type`,
 * `properties`, `required`, `items`, `additionalProperties`) are semantically
 * identical across draft-07 and draft 2020-12, so we compile a copy of the
 * schema with the `$schema` dialect declaration removed. The EXPORTED
 * {@link elementGraphSchema} keeps the draft 2020-12 `$schema` declaration so
 * downstream consumers see the intended dialect.
 */

import Ajv, { type ErrorObject } from 'ajv';
import { ELEMENT_GRAPH_SCHEMA_ID } from '../branding';

/** Result of {@link validateElementGraph}. */
export interface ElementGraphValidation {
  valid: boolean;
  errors: string[];
}

/** A `{ "@id": "…" }` reference to another element (open per OMG conventions). */
const refSchema = {
  type: 'object',
  properties: { '@id': { type: 'string' } },
  required: ['@id'],
  additionalProperties: true,
} as const;

/** An array of element references. */
const refArraySchema = {
  type: 'array',
  items: refSchema,
} as const;

/**
 * Schema for a single element in the graph. Required OMG identity: `@id`
 * (string) and `@type` (string). Everything else is optional and the object is
 * open so metaclass attributes ride along.
 */
const elementSchema = {
  type: 'object',
  required: ['@id', '@type'],
  properties: {
    '@id': { type: 'string' },
    '@type': { type: 'string' },
    identifier: { type: 'string' },
    declaredName: { type: 'string' },
    declaredShortName: { type: 'string' },
    // Reified containment / relationship structure.
    ownedRelationship: refArraySchema,
    owningRelationship: refSchema,
    source: refArraySchema,
    target: refArraySchema,
    memberElement: refSchema,
    ownedMemberElement: refSchema,
    owningRelatedElement: refSchema,
  },
  additionalProperties: true,
} as const;

/**
 * The OMG element-graph document schema (draft 2020-12). An object with an
 * `elements` array (required) plus optional `rootElement` index and document
 * metadata (`@type`, `formatVersion`, `generator`). Open at every level.
 */
export const elementGraphSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: ELEMENT_GRAPH_SCHEMA_ID,
  title: 'OMG SysML v2 API element-graph',
  type: 'object',
  required: ['elements'],
  properties: {
    '@type': { type: 'string' },
    formatVersion: { type: 'string' },
    generator: { type: 'string' },
    elements: {
      type: 'array',
      items: elementSchema,
    },
    rootElement: refArraySchema,
  },
  additionalProperties: true,
} as const;

/* ─────────────────────────────── validator ──────────────────────────────── */

const ajv = new Ajv({ allErrors: true });

// Compile a copy WITHOUT the draft 2020-12 `$schema` declaration: the default
// ajv build ships the draft-07 meta-schema and would otherwise refuse an
// unknown dialect. The validation semantics are unchanged for the core keywords
// used above.
const { $schema: _dialect, ...compilableSchema } = elementGraphSchema;
const validateFn = ajv.compile(compilableSchema);

/** Render an ajv error object as a compact, human-readable string. */
function formatError(err: ErrorObject): string {
  const where = err.instancePath || '(root)';
  return `${where} ${err.message ?? 'is invalid'}`.trim();
}

/**
 * Validate a parsed element-graph document against {@link elementGraphSchema}.
 *
 * @param json the PARSED JSON value (call `JSON.parse` on the export string
 *   first). Returns `{ valid, errors }`; `errors` is empty when `valid`.
 */
export function validateElementGraph(json: unknown): ElementGraphValidation {
  const valid = validateFn(json);
  if (valid) return { valid: true, errors: [] };
  const errors = (validateFn.errors ?? []).map(formatError);
  return { valid: false, errors };
}
