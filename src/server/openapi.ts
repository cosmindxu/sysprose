/**
 * OpenAPI 3.1 description of the routes mounted by {@link createServer}
 * (see `src/server/app.ts`).
 *
 * This is a hand-authored, clean-room description of the SysML v2 API &
 * Services REST surface (OMG "Systems Modeling API and Services", REST/HTTP
 * PSM — docs/02-omg-standard-reference.md §5.2–5.7) plus the representative
 * OSLC linked-data routes. It is served verbatim at `GET /openapi.json`; a
 * plain, CDN-free viewer is served at `GET /docs`.
 *
 * The document is a plain JS object (valid JSON) so it can be imported by
 * tests and serialised without a build step. `openapi` is pinned to `3.1.1`.
 */

import { PRODUCT_NAME } from '../branding';

/** The mounted API base path reflected into the served document's paths. */
export const API_BASE = '/api';

/** A `$ref` into `#/components/schemas`. */
function ref(name: string): { $ref: string } {
  return { $ref: `#/components/schemas/${name}` };
}

/**
 * The shared list-endpoint query parameters: offset/limit paging, cursor paging
 * (`page[size]`/`page[after]`) and `type`/`name` filtering — all defined once as
 * reusable `components.parameters` and referenced from every list endpoint.
 */
const listParams = [
  { $ref: '#/components/parameters/Offset' },
  { $ref: '#/components/parameters/Limit' },
  { $ref: '#/components/parameters/PageSize' },
  { $ref: '#/components/parameters/PageAfter' },
  { $ref: '#/components/parameters/TypeFilter' },
  { $ref: '#/components/parameters/NameFilter' },
];

/**
 * Build the OpenAPI 3.1 document. `basePath` is prefixed onto the OMG REST
 * paths (defaults to {@link API_BASE}); OSLC paths are always served at `/oslc`.
 */
export function buildOpenApiDocument(basePath: string = API_BASE): Record<string, unknown> {
  const b = basePath.replace(/\/$/, '');
  const p = (suffix: string): string => `${b}${suffix}`;

  return {
    openapi: '3.1.1',
    info: {
      title: `${PRODUCT_NAME} API`,
      version: '0.1.0',
      description:
        'Clean-room implementation of the OMG SysML v2 API & Services REST/HTTP PSM ' +
        'plus a representative OSLC linked-data surface, served over HTTP by the ' +
        `optional Node/Express deployment of ${PRODUCT_NAME}.`,
      license: { name: 'MIT' },
    },
    servers: [{ url: '/', description: 'This server' }],
    tags: [
      { name: 'system', description: 'Health and discovery.' },
      { name: 'projects', description: 'Projects, branches, tags and commits (Git-like model).' },
      { name: 'elements', description: 'Element read access, at a commit or the default HEAD.' },
      { name: 'query', description: 'Constraint-tree queries and query-results.' },
      { name: 'analytics', description: 'Model metrics, constraint and execution reports.' },
      { name: 'oslc', description: 'OSLC linked-data (JSON-LD) discovery and query.' },
    ],
    paths: {
      '/health': {
        get: {
          tags: ['system'],
          summary: 'Liveness probe.',
          operationId: 'getHealth',
          responses: {
            '200': {
              description: 'Server is up.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      status: { type: 'string', const: 'ok' },
                      name: { type: 'string' },
                    },
                    required: ['status'],
                  },
                },
              },
            },
          },
        },
      },
      '/openapi.json': {
        get: {
          tags: ['system'],
          summary: 'This OpenAPI 3.1 document.',
          operationId: 'getOpenApi',
          responses: { '200': { description: 'The OpenAPI document.' } },
        },
      },
      [p('/projects')]: {
        get: {
          tags: ['projects'],
          summary: 'List projects.',
          operationId: 'listProjects',
          responses: {
            '200': {
              description: 'The projects in the repository.',
              content: {
                'application/json': {
                  schema: { type: 'array', items: ref('Project') },
                },
              },
            },
          },
        },
        post: {
          tags: ['projects'],
          summary: 'Create a project.',
          operationId: 'createProject',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { name: { type: 'string' } },
                  required: ['name'],
                },
              },
            },
          },
          responses: {
            '201': { description: 'Created.', content: { 'application/json': { schema: ref('Project') } } },
            '405': { $ref: '#/components/responses/Error' },
          },
        },
      },
      [p('/projects/{projectId}')]: {
        get: {
          tags: ['projects'],
          summary: 'Get a project.',
          operationId: 'getProject',
          parameters: [{ $ref: '#/components/parameters/ProjectId' }],
          responses: {
            '200': { description: 'The project.', content: { 'application/json': { schema: ref('Project') } } },
            '404': { $ref: '#/components/responses/Error' },
          },
        },
        put: {
          tags: ['projects'],
          summary: 'Rename a project.',
          operationId: 'updateProject',
          parameters: [{ $ref: '#/components/parameters/ProjectId' }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
              },
            },
          },
          responses: {
            '200': { description: 'The updated project.', content: { 'application/json': { schema: ref('Project') } } },
            '404': { $ref: '#/components/responses/Error' },
            '405': { $ref: '#/components/responses/Error' },
          },
        },
        delete: {
          tags: ['projects'],
          summary: 'Delete a project (and its branches, tags and commits).',
          operationId: 'deleteProject',
          parameters: [{ $ref: '#/components/parameters/ProjectId' }],
          responses: {
            '204': { description: 'Deleted.' },
            '404': { $ref: '#/components/responses/Error' },
          },
        },
      },
      [p('/projects/{projectId}/branches')]: {
        get: {
          tags: ['projects'],
          summary: 'List branches.',
          operationId: 'listBranches',
          parameters: [{ $ref: '#/components/parameters/ProjectId' }, ...listParams],
          responses: {
            '200': {
              description: 'Branches.',
              content: { 'application/json': { schema: { type: 'array', items: ref('Branch') } } },
            },
          },
        },
        post: {
          tags: ['projects'],
          summary: 'Create a branch.',
          operationId: 'createBranch',
          parameters: [{ $ref: '#/components/parameters/ProjectId' }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    fromCommit: { type: 'string' },
                  },
                  required: ['name'],
                },
              },
            },
          },
          responses: {
            '201': { description: 'Created.', content: { 'application/json': { schema: ref('Branch') } } },
            '404': { $ref: '#/components/responses/Error' },
          },
        },
      },
      [p('/projects/{projectId}/branches/{branchId}')]: {
        get: {
          tags: ['projects'],
          summary: 'Get a branch.',
          operationId: 'getBranch',
          parameters: [
            { $ref: '#/components/parameters/ProjectId' },
            { name: 'branchId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'The branch.', content: { 'application/json': { schema: ref('Branch') } } },
            '404': { $ref: '#/components/responses/Error' },
          },
        },
        delete: {
          tags: ['projects'],
          summary: 'Delete a branch (the default branch cannot be deleted).',
          operationId: 'deleteBranch',
          parameters: [
            { $ref: '#/components/parameters/ProjectId' },
            { name: 'branchId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '204': { description: 'Deleted.' },
            '404': { $ref: '#/components/responses/Error' },
            '409': { $ref: '#/components/responses/Error' },
          },
        },
      },
      [p('/projects/{projectId}/tags')]: {
        get: {
          tags: ['projects'],
          summary: 'List tags.',
          operationId: 'listTags',
          parameters: [{ $ref: '#/components/parameters/ProjectId' }, ...listParams],
          responses: {
            '200': {
              description: 'Tags.',
              content: { 'application/json': { schema: { type: 'array', items: ref('Tag') } } },
            },
          },
        },
        post: {
          tags: ['projects'],
          summary: 'Create a tag.',
          operationId: 'createTag',
          parameters: [{ $ref: '#/components/parameters/ProjectId' }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { name: { type: 'string' }, commit: { type: 'string' } },
                  required: ['name', 'commit'],
                },
              },
            },
          },
          responses: {
            '201': { description: 'Created.', content: { 'application/json': { schema: ref('Tag') } } },
            '404': { $ref: '#/components/responses/Error' },
          },
        },
      },
      [p('/projects/{projectId}/tags/{tagId}')]: {
        get: {
          tags: ['projects'],
          summary: 'Get a tag.',
          operationId: 'getTag',
          parameters: [
            { $ref: '#/components/parameters/ProjectId' },
            { name: 'tagId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'The tag.', content: { 'application/json': { schema: ref('Tag') } } },
            '404': { $ref: '#/components/responses/Error' },
          },
        },
        delete: {
          tags: ['projects'],
          summary: 'Delete a tag.',
          operationId: 'deleteTag',
          parameters: [
            { $ref: '#/components/parameters/ProjectId' },
            { name: 'tagId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '204': { description: 'Deleted.' },
            '404': { $ref: '#/components/responses/Error' },
          },
        },
      },
      [p('/projects/{projectId}/commits')]: {
        get: {
          tags: ['projects'],
          summary: 'List commits.',
          operationId: 'listCommits',
          parameters: [
            { $ref: '#/components/parameters/ProjectId' },
            { name: 'branch', in: 'query', required: false, schema: { type: 'string' } },
            ...listParams,
          ],
          responses: {
            '200': {
              description: 'Commits.',
              content: { 'application/json': { schema: { type: 'array', items: ref('Commit') } } },
            },
          },
        },
        post: {
          tags: ['projects'],
          summary: 'Create a commit (apply changes, snapshot, advance branch head).',
          operationId: 'createCommit',
          parameters: [{ $ref: '#/components/parameters/ProjectId' }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: ref('CommitRequest') } },
          },
          responses: {
            '201': { description: 'Created.', content: { 'application/json': { schema: ref('Commit') } } },
            '404': { $ref: '#/components/responses/Error' },
          },
        },
      },
      [p('/projects/{projectId}/commits/{commitId}')]: {
        get: {
          tags: ['projects'],
          summary: 'Get a commit.',
          operationId: 'getCommit',
          parameters: [
            { $ref: '#/components/parameters/ProjectId' },
            { $ref: '#/components/parameters/CommitId' },
          ],
          responses: {
            '200': { description: 'The commit.', content: { 'application/json': { schema: ref('Commit') } } },
            '404': { $ref: '#/components/responses/Error' },
          },
        },
      },
      [p('/projects/{projectId}/commits/{commitId}/elements')]: {
        get: {
          tags: ['elements'],
          summary: 'List elements as of a commit (paginated, optionally constrained).',
          operationId: 'listElementsAtCommit',
          parameters: [
            { $ref: '#/components/parameters/ProjectId' },
            { $ref: '#/components/parameters/CommitId' },
            ...listParams,
          ],
          responses: {
            '200': {
              description: 'A page of elements.',
              content: { 'application/json': { schema: ref('ElementsPage') } },
            },
            '404': { $ref: '#/components/responses/Error' },
          },
        },
      },
      [p('/projects/{projectId}/commits/{commitId}/elements/{elementId}')]: {
        get: {
          tags: ['elements'],
          summary: 'Get one element as of a commit.',
          operationId: 'getElementAtCommit',
          parameters: [
            { $ref: '#/components/parameters/ProjectId' },
            { $ref: '#/components/parameters/CommitId' },
            { name: 'elementId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'The element.', content: { 'application/json': { schema: ref('Element') } } },
            '404': { $ref: '#/components/responses/Error' },
          },
        },
      },
      [p('/projects/{projectId}/commits/{commitId}/elements/{elementId}/relationships')]: {
        get: {
          tags: ['elements'],
          summary: 'Navigate the relationships around an element (owned/owning/incoming/outgoing).',
          operationId: 'getElementRelationships',
          parameters: [
            { $ref: '#/components/parameters/ProjectId' },
            { $ref: '#/components/parameters/CommitId' },
            { name: 'elementId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': {
              description: 'The element-navigation view.',
              content: { 'application/json': { schema: ref('RelationshipsResult') } },
            },
            '404': { $ref: '#/components/responses/Error' },
          },
        },
      },
      [p('/projects/{projectId}/commits/{commitId}/roots')]: {
        get: {
          tags: ['elements'],
          summary: 'List the root elements as of a commit.',
          operationId: 'listRootsAtCommit',
          parameters: [
            { $ref: '#/components/parameters/ProjectId' },
            { $ref: '#/components/parameters/CommitId' },
          ],
          responses: {
            '200': {
              description: 'Root elements.',
              content: { 'application/json': { schema: { type: 'array', items: ref('Element') } } },
            },
            '404': { $ref: '#/components/responses/Error' },
          },
        },
      },
      [p('/projects/{projectId}/commits/{commitId}/query-results')]: {
        post: {
          tags: ['query'],
          summary: 'Evaluate a query as of a commit.',
          operationId: 'postQueryResults',
          parameters: [
            { $ref: '#/components/parameters/ProjectId' },
            { $ref: '#/components/parameters/CommitId' },
          ],
          requestBody: { required: true, content: { 'application/json': { schema: ref('Query') } } },
          responses: {
            '200': {
              description: 'The query result.',
              content: { 'application/json': { schema: ref('QueryResult') } },
            },
            '404': { $ref: '#/components/responses/Error' },
          },
        },
      },
      [p('/projects/{projectId}/commits/{commitId}/diff/{baseCommitId}')]: {
        get: {
          tags: ['projects'],
          summary: 'Element-level diff of a commit against a base commit.',
          operationId: 'diffCommits',
          parameters: [
            { $ref: '#/components/parameters/ProjectId' },
            { $ref: '#/components/parameters/CommitId' },
            { name: 'baseCommitId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'The diff.', content: { 'application/json': { schema: ref('CommitDiff') } } },
            '404': { $ref: '#/components/responses/Error' },
          },
        },
      },
      [p('/projects/{projectId}/diff')]: {
        get: {
          tags: ['projects'],
          summary: 'Element-level diff between two arbitrary commits of a project.',
          operationId: 'diffArbitraryCommits',
          parameters: [
            { $ref: '#/components/parameters/ProjectId' },
            { name: 'base', in: 'query', required: true, description: 'Base commit id.', schema: { type: 'string' } },
            { name: 'compare', in: 'query', required: true, description: 'Compare commit id.', schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'The diff.', content: { 'application/json': { schema: ref('CommitDiff') } } },
            '404': { $ref: '#/components/responses/Error' },
          },
        },
      },
      [p('/projects/{projectId}/merge')]: {
        post: {
          tags: ['projects'],
          summary: 'Three-way merge of a source branch into a target branch.',
          operationId: 'mergeBranches',
          parameters: [{ $ref: '#/components/parameters/ProjectId' }],
          requestBody: { required: true, content: { 'application/json': { schema: ref('MergeRequest') } } },
          responses: {
            '201': {
              description: 'Merge applied; a merge commit was created.',
              content: { 'application/json': { schema: ref('MergeResult') } },
            },
            '404': { $ref: '#/components/responses/Error' },
            '405': { $ref: '#/components/responses/Error' },
            '409': {
              description: 'Manual-strategy merge with unresolved conflicts; no commit produced.',
              content: { 'application/json': { schema: ref('MergeResult') } },
            },
          },
        },
      },
      [p('/projects/{projectId}/queries')]: {
        get: {
          tags: ['query'],
          summary: 'List stored queries.',
          operationId: 'listStoredQueries',
          parameters: [{ $ref: '#/components/parameters/ProjectId' }, ...listParams],
          responses: {
            '200': {
              description: 'Stored queries.',
              content: { 'application/json': { schema: { type: 'array', items: ref('StoredQuery') } } },
            },
          },
        },
        post: {
          tags: ['query'],
          summary: 'Create (store) a query.',
          operationId: 'createStoredQuery',
          parameters: [{ $ref: '#/components/parameters/ProjectId' }],
          requestBody: { required: true, content: { 'application/json': { schema: ref('StoredQueryRequest') } } },
          responses: {
            '201': { description: 'Created.', content: { 'application/json': { schema: ref('StoredQuery') } } },
            '404': { $ref: '#/components/responses/Error' },
          },
        },
      },
      [p('/projects/{projectId}/queries/{queryId}')]: {
        get: {
          tags: ['query'],
          summary: 'Get a stored query.',
          operationId: 'getStoredQuery',
          parameters: [
            { $ref: '#/components/parameters/ProjectId' },
            { name: 'queryId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'The stored query.', content: { 'application/json': { schema: ref('StoredQuery') } } },
            '404': { $ref: '#/components/responses/Error' },
          },
        },
        put: {
          tags: ['query'],
          summary: 'Update a stored query.',
          operationId: 'updateStoredQuery',
          parameters: [
            { $ref: '#/components/parameters/ProjectId' },
            { name: 'queryId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          requestBody: { required: true, content: { 'application/json': { schema: ref('StoredQueryRequest') } } },
          responses: {
            '200': { description: 'The updated stored query.', content: { 'application/json': { schema: ref('StoredQuery') } } },
            '404': { $ref: '#/components/responses/Error' },
          },
        },
        delete: {
          tags: ['query'],
          summary: 'Delete a stored query.',
          operationId: 'deleteStoredQuery',
          parameters: [
            { $ref: '#/components/parameters/ProjectId' },
            { name: 'queryId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '204': { description: 'Deleted.' },
            '404': { $ref: '#/components/responses/Error' },
          },
        },
      },
      [p('/projects/{projectId}/queries/{queryId}/results')]: {
        get: {
          tags: ['query'],
          summary: 'Evaluate a stored query at the default branch head.',
          operationId: 'getStoredQueryResults',
          parameters: [
            { $ref: '#/components/parameters/ProjectId' },
            { name: 'queryId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'The query result.', content: { 'application/json': { schema: ref('QueryResult') } } },
            '404': { $ref: '#/components/responses/Error' },
          },
        },
      },
      [p('/projects/{projectId}/elements')]: {
        get: {
          tags: ['elements'],
          summary: 'List elements at the default HEAD (legacy shortcut).',
          operationId: 'listElements',
          parameters: [{ $ref: '#/components/parameters/ProjectId' }, ...listParams],
          responses: {
            '200': {
              description: 'A page of elements.',
              content: { 'application/json': { schema: ref('ElementsPage') } },
            },
          },
        },
      },
      [p('/elements/{elementId}')]: {
        get: {
          tags: ['elements'],
          summary: 'Get one element from the default HEAD (legacy).',
          operationId: 'getElement',
          parameters: [{ name: 'elementId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'The element.', content: { 'application/json': { schema: ref('Element') } } },
            '404': { $ref: '#/components/responses/Error' },
          },
        },
      },
      [p('/queries')]: {
        post: {
          tags: ['query'],
          summary: 'Evaluate a query against the default HEAD (legacy).',
          operationId: 'postQuery',
          requestBody: { required: true, content: { 'application/json': { schema: ref('Query') } } },
          responses: {
            '200': {
              description: 'The query result.',
              content: { 'application/json': { schema: ref('QueryResult') } },
            },
          },
        },
      },
      [p('/analytics/metrics')]: {
        get: {
          tags: ['analytics'],
          summary: 'Model metrics.',
          operationId: 'getMetrics',
          responses: {
            '200': {
              description: 'Metrics report.',
              content: { 'application/json': { schema: ref('Metrics') } },
            },
          },
        },
      },
      [p('/analytics/constraints')]: {
        get: {
          tags: ['analytics'],
          summary: 'Constraint report.',
          operationId: 'getConstraints',
          responses: { '200': { description: 'Constraint report.' } },
        },
      },
      [p('/analytics/execution')]: {
        get: {
          tags: ['analytics'],
          summary: 'Execution report.',
          operationId: 'getExecution',
          responses: { '200': { description: 'Execution report.' } },
        },
      },
      '/oslc/catalog': {
        get: {
          tags: ['oslc'],
          summary: 'OSLC ServiceProviderCatalog (JSON-LD).',
          operationId: 'oslcCatalog',
          responses: { '200': { description: 'The catalog.' } },
        },
      },
      '/oslc/services': {
        get: {
          tags: ['oslc'],
          summary: 'OSLC ServiceProvider (JSON-LD).',
          operationId: 'oslcServices',
          responses: { '200': { description: 'The service provider.' } },
        },
      },
      '/oslc/query': {
        get: {
          tags: ['oslc'],
          summary: 'OSLC query capability.',
          operationId: 'oslcQuery',
          parameters: [
            { name: 'oslc.where', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'oslc.select', in: 'query', required: false, schema: { type: 'string' } },
          ],
          responses: { '200': { description: 'An oslc:ResponseInfo with rdfs:member entries.' } },
        },
      },
      '/oslc/elements/{elementId}': {
        get: {
          tags: ['oslc'],
          summary: 'JSON-LD representation of one element.',
          operationId: 'oslcElement',
          parameters: [{ name: 'elementId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'The element as JSON-LD.' },
            '404': { $ref: '#/components/responses/Error' },
          },
        },
      },
    },
    components: {
      parameters: {
        ProjectId: {
          name: 'projectId',
          in: 'path',
          required: true,
          description: 'Project id (the alias `project-default` resolves to the seeded demo project).',
          schema: { type: 'string' },
        },
        CommitId: { name: 'commitId', in: 'path', required: true, schema: { type: 'string' } },
        Offset: {
          name: 'offset',
          in: 'query',
          required: false,
          description: 'Offset-paging: number of items to skip.',
          schema: { type: 'integer', minimum: 0 },
        },
        Limit: {
          name: 'limit',
          in: 'query',
          required: false,
          description: 'Offset-paging: maximum number of items to return.',
          schema: { type: 'integer', minimum: 0 },
        },
        PageSize: {
          name: 'page[size]',
          in: 'query',
          required: false,
          description: 'Cursor-paging: page size (selects cursor mode; `size` is also accepted).',
          schema: { type: 'integer', minimum: 0 },
        },
        PageAfter: {
          name: 'page[after]',
          in: 'query',
          required: false,
          description:
            'Cursor-paging: opaque cursor — the id of the last item of the previous page ' +
            '(`after` is also accepted).',
          schema: { type: 'string' },
        },
        TypeFilter: {
          name: 'type',
          in: 'query',
          required: false,
          description: 'Filter: keep only items whose type (`@type`/`eClass`) equals this value.',
          schema: { type: 'string' },
        },
        NameFilter: {
          name: 'name',
          in: 'query',
          required: false,
          description: 'Filter: keep only items whose name contains this substring.',
          schema: { type: 'string' },
        },
      },
      responses: {
        Error: {
          description: 'Error.',
          content: { 'application/json': { schema: ref('Error') } },
        },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: { error: { type: 'string' } },
          required: ['error'],
        },
        Project: {
          type: 'object',
          description: 'An OMG SysML v2 Project resource.',
          properties: {
            '@id': { type: 'string' },
            '@type': { const: 'Project' },
            name: { type: 'string' },
            defaultBranch: ref('Ref'),
            defaultCommit: { type: 'string' },
          },
          required: ['@id', '@type', 'name'],
        },
        Branch: {
          type: 'object',
          properties: {
            '@id': { type: 'string' },
            '@type': { const: 'Branch' },
            name: { type: 'string' },
            project: ref('Ref'),
            head: ref('Ref'),
          },
          required: ['@id', '@type', 'name'],
        },
        Tag: {
          type: 'object',
          properties: {
            '@id': { type: 'string' },
            '@type': { const: 'Tag' },
            name: { type: 'string' },
            project: ref('Ref'),
            taggedCommit: ref('Ref'),
          },
          required: ['@id', '@type', 'name'],
        },
        Commit: {
          type: 'object',
          description: 'An immutable snapshot of the model.',
          properties: {
            '@id': { type: 'string' },
            '@type': { const: 'Commit' },
            project: ref('Ref'),
            branch: ref('Ref'),
            previousCommit: ref('Ref'),
            description: { type: 'string' },
            created: { type: 'string' },
          },
          required: ['@id', '@type'],
        },
        Ref: {
          type: 'object',
          description: 'A reference to another resource by id.',
          properties: { '@id': { type: 'string' } },
          required: ['@id'],
        },
        Element: {
          type: 'object',
          description:
            'An element in the OMG element-graph shape. Metaclass-specific fields ' +
            'appear as open additionalProperties.',
          properties: {
            '@id': { type: 'string' },
            '@type': { type: 'string' },
            declaredName: { type: 'string' },
            declaredShortName: { type: 'string' },
            qualifiedName: { type: 'string' },
            owner: ref('Ref'),
            ownedRelationship: { type: 'array', items: ref('Ref') },
            ownedMember: { type: 'array', items: ref('Ref') },
            source: { type: 'array', items: ref('Ref') },
            target: { type: 'array', items: ref('Ref') },
          },
          required: ['@id', '@type'],
          additionalProperties: true,
        },
        ElementsPage: {
          type: 'object',
          description: 'A paginated collection of elements at a commit.',
          properties: {
            commitId: { type: 'string' },
            total: { type: 'integer' },
            offset: { type: 'integer' },
            limit: { type: ['integer', 'null'] },
            size: { type: 'integer' },
            nextCursor: { type: 'string' },
            elements: { type: 'array', items: ref('Element') },
          },
          required: ['commitId', 'total', 'elements'],
        },
        PrimitiveConstraint: {
          type: 'object',
          properties: {
            property: { type: 'string' },
            operator: {
              type: 'string',
              enum: ['=', '!=', '<', '>', '<=', '>=', 'in', 'contains', 'exists', 'matches'],
            },
            value: {},
          },
          required: ['property', 'operator'],
        },
        CompositeConstraint: {
          type: 'object',
          properties: {
            operator: { type: 'string', enum: ['and', 'or', 'not'] },
            constraint: { type: 'array', items: ref('Constraint') },
            kind: { type: 'string', enum: ['and', 'or', 'not'] },
            operands: { type: 'array', items: ref('Constraint') },
          },
        },
        Constraint: {
          description: 'A leaf comparison or a boolean combination of constraints.',
          oneOf: [ref('PrimitiveConstraint'), ref('CompositeConstraint')],
        },
        Query: {
          type: 'object',
          description: 'An OMG API & Services Query: constraint tree + projection, scope and paging.',
          properties: {
            constraint: ref('Constraint'),
            select: { type: 'array', items: { type: 'string' } },
            scopeOwnerId: { type: 'string' },
            orderBy: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  property: { type: 'string' },
                  direction: { type: 'string', enum: ['asc', 'desc'] },
                },
                required: ['property'],
              },
            },
            page: {
              type: 'object',
              properties: {
                offset: { type: 'integer' },
                limit: { type: 'integer' },
                size: { type: 'integer' },
                after: { type: 'string' },
              },
            },
          },
        },
        QueryResultElement: {
          type: 'object',
          description:
            'A query-result element in the native model-JSON (element-record) shape ' +
            'produced by `Model#toJSON` — as returned by the query endpoints. This ' +
            'differs from the OMG element-graph {@link Element} shape (`@id`/`@type`): ' +
            'query results use `id`/`eClass` with an `attrs` bag.',
          properties: {
            id: { type: 'string' },
            eClass: { type: 'string' },
            declaredName: { type: 'string' },
            declaredShortName: { type: 'string' },
            ownerId: { type: ['string', 'null'] },
            attrs: { type: 'object', additionalProperties: true },
            source: { type: 'array', items: { type: 'string' } },
            target: { type: 'array', items: { type: 'string' } },
          },
          required: ['id', 'eClass', 'ownerId', 'attrs'],
          additionalProperties: true,
        },
        QueryResult: {
          type: 'object',
          properties: {
            commitId: { type: 'string' },
            total: { type: 'integer' },
            nextCursor: { type: 'string' },
            elements: { type: 'array', items: ref('QueryResultElement') },
          },
          required: ['commitId', 'total', 'elements'],
        },
        Metrics: {
          type: 'object',
          description: 'Aggregate model metrics (see `modelMetrics` in `src/api/analytics.ts`).',
          properties: {
            totalElements: { type: 'integer' },
            nodeCount: { type: 'integer' },
            relationshipCount: { type: 'integer' },
            rootCount: { type: 'integer' },
            maxDepth: { type: 'integer' },
            diagramableCount: { type: 'integer' },
            byMetaclass: { type: 'object', additionalProperties: { type: 'integer' } },
          },
          required: [
            'totalElements',
            'nodeCount',
            'relationshipCount',
            'rootCount',
            'maxDepth',
            'diagramableCount',
            'byMetaclass',
          ],
        },
        CommitChange: {
          type: 'object',
          properties: {
            operation: { type: 'string', enum: ['create', 'update', 'delete'] },
            identifier: { type: 'string' },
            element: {
              type: 'object',
              properties: {
                '@type': { type: 'string' },
                identifier: { type: 'string' },
                declaredName: { type: 'string' },
                declaredShortName: { type: 'string' },
                ownerId: { type: ['string', 'null'] },
                attrs: { type: 'object', additionalProperties: true },
                source: { type: 'array', items: { type: 'string' } },
                target: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
        CommitRequest: {
          type: 'object',
          properties: {
            branch: { type: 'string' },
            description: { type: 'string' },
            changes: { type: 'array', items: ref('CommitChange') },
          },
        },
        CommitDiff: {
          type: 'object',
          properties: {
            base: ref('Ref'),
            compare: ref('Ref'),
            added: { type: 'array', items: ref('Element') },
            removed: { type: 'array', items: ref('Element') },
            changed: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  '@id': { type: 'string' },
                  before: ref('Element'),
                  after: ref('Element'),
                },
              },
            },
          },
          required: ['base', 'compare', 'added', 'removed', 'changed'],
        },
        StoredQuery: {
          type: 'object',
          description: 'A named, persisted Query owned by a project.',
          properties: {
            '@id': { type: 'string' },
            '@type': { const: 'StoredQuery' },
            name: { type: 'string' },
            project: ref('Ref'),
            query: ref('Query'),
          },
          required: ['@id', '@type', 'query'],
        },
        StoredQueryRequest: {
          type: 'object',
          description:
            'Body for creating/updating a stored query: either an explicit `query` object ' +
            'plus an optional `name`, or the Query fields lifted to the top level.',
          properties: {
            name: { type: 'string' },
            query: ref('Query'),
            constraint: ref('Constraint'),
            select: { type: 'array', items: { type: 'string' } },
            scopeOwnerId: { type: 'string' },
          },
          additionalProperties: true,
        },
        MergeRequest: {
          type: 'object',
          description: 'A request to merge a source branch into a target branch.',
          properties: {
            source: { type: 'string', description: 'Source (theirs) branch id.' },
            target: { type: 'string', description: 'Target (ours) branch id.' },
            strategy: { type: 'string', enum: ['ours', 'theirs', 'manual'] },
          },
          required: ['source', 'target'],
        },
        MergeConflict: {
          type: 'object',
          description: 'A single per-element conflict discovered during a 3-way merge.',
          properties: {
            '@id': { type: 'string' },
            kind: { type: 'string', enum: ['change-change', 'change-remove', 'remove-change'] },
            resolution: { type: 'string', enum: ['source', 'target'] },
          },
          required: ['@id', 'kind', 'resolution'],
        },
        MergeResult: {
          type: 'object',
          description: 'The outcome of a 3-way branch merge.',
          properties: {
            '@type': { const: 'MergeResult' },
            strategy: { type: 'string', enum: ['ours', 'theirs', 'manual'] },
            applied: { type: 'boolean' },
            commit: { oneOf: [ref('Commit'), { type: 'null' }] },
            ancestorCommit: ref('Ref'),
            conflicts: { type: 'array', items: ref('MergeConflict') },
          },
          required: ['@type', 'strategy', 'applied', 'conflicts'],
        },
        RelationshipsResult: {
          type: 'object',
          description: 'Element-navigation view: relationships/edges around one element at a commit.',
          properties: {
            '@id': { type: 'string' },
            '@type': { const: 'RelationshipsResult' },
            commitId: { type: 'string' },
            owned: { type: 'array', items: ref('Element') },
            owning: { type: 'array', items: ref('Element') },
            incoming: { type: 'array', items: ref('Element') },
            outgoing: { type: 'array', items: ref('Element') },
          },
          required: ['@id', '@type', 'commitId', 'owned', 'owning', 'incoming', 'outgoing'],
        },
      },
    },
  };
}

/** The default OpenAPI document (base path {@link API_BASE}). */
export const openApiDocument = buildOpenApiDocument();

/**
 * A minimal, dependency-free HTML viewer for the OpenAPI document. It fetches
 * `/openapi.json` and renders it as pretty-printed JSON in a `<pre>` — no CDN,
 * no network dependency.
 */
export function docsHtml(openApiUrl: string = '/openapi.json'): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${PRODUCT_NAME} API — docs</title>
  <style>
    body { font: 14px/1.5 system-ui, sans-serif; margin: 0; background: #0d1117; color: #c9d1d9; }
    header { padding: 1rem 1.5rem; border-bottom: 1px solid #30363d; }
    header h1 { margin: 0 0 .25rem; font-size: 1.1rem; }
    header a { color: #58a6ff; }
    pre { margin: 0; padding: 1.5rem; overflow: auto; white-space: pre; tab-size: 2; }
  </style>
</head>
<body>
  <header>
    <h1>${PRODUCT_NAME} API</h1>
    <p>OpenAPI 3.1 document: <a href="${openApiUrl}">${openApiUrl}</a></p>
  </header>
  <pre id="doc">Loading ${openApiUrl} …</pre>
  <script>
    fetch(${JSON.stringify(openApiUrl)})
      .then(function (r) { return r.json(); })
      .then(function (doc) {
        document.getElementById('doc').textContent = JSON.stringify(doc, null, 2);
      })
      .catch(function (e) {
        document.getElementById('doc').textContent = 'Failed to load: ' + e;
      });
  </script>
</body>
</html>`;
}
