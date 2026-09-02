/**
 * In-process, OMG-API-shaped REST facade.
 *
 * `SysmlApiServer` mirrors the SysML v2 API & Services REST contract
 * (docs/02-omg-standard-reference.md §5.2–5.7) as a synchronous, in-memory
 * callable: `apiFetch(method, path, body?)` returns `{ status, body }` just like
 * an HTTP round-trip. All analysis logic lives in {@link ModelApi},
 * {@link evaluateQuery} and the analytics functions; the repository/version
 * tier lives in {@link ProjectRepository}. A real HTTP server would be a thin
 * wrapper forwarding to this same facade.
 *
 * The full Git-like resource set is exposed — Project ▸ Branch/Tag ▸ Commit ▸
 * Element (read AT a commit) plus commit diffs and queries — while remaining
 * **backward-compatible** with the original single-model routes:
 *   - `SysmlApiServer(model)` seeds a default project (`main` branch + initial
 *     commit) from `model`; that same live `model` still backs the legacy
 *     `GET /elements/:id`, `POST /queries`, `GET /analytics/*` and
 *     `GET /projects/:id/elements` routes (the "HEAD of the default project").
 *   - The default project resolves under both its repository id and the legacy
 *     alias `project-default`.
 *
 * Element bodies are emitted in the OMG element-graph shape (`@id`/`@type`,
 * reified `ownedRelationship`/`ownedMember`, endpoint refs) via
 * {@link ModelApi.toElementJSON}. Ids for projects/branches/commits/tags are
 * counter-based (from {@link ProjectRepository}) — never Date.now/Math.random.
 */

import type { ElementRecord, Model } from '@core/index';
import { validateRequestBody, type RequestBodyKind } from './request-schemas';
import { ModelApi, type OmgElementJSON } from './sdk';
import { evaluateQuery, modelCommitId, type Query, type QueryResult } from './query';
import { modelMetrics, constraintReport, executionReport, unitReport, analysisReport } from './analytics';
import {
  ProjectRepository,
  relationshipsOfElement,
  StaleHeadError,
  type Project,
  type Branch,
  type Commit,
  type Tag,
  type MergeResult,
  type MergeStrategy,
} from './versioning';

/** HTTP-shaped response from {@link SysmlApiServer.apiFetch}. */
export interface ApiResponse {
  status: number;
  body: unknown;
}

/** OMG-ish Project resource. */
export interface ProjectResource {
  '@id': string;
  '@type': 'Project';
  name: string;
  defaultBranch: { '@id': string };
  defaultCommit: string;
}

/** Legacy alias for the seeded default project. */
const DEFAULT_PROJECT_ALIAS = 'project-default';

/** A named, persisted {@link Query} owned by a project (OMG "Query" resource). */
interface StoredQuery {
  id: string;
  projectId: string;
  name?: string;
  query: Query;
}

export class SysmlApiServer {
  readonly api: ModelApi;
  readonly repo: ProjectRepository;
  private readonly defaultProjectId: string;

  /** Persisted named queries, keyed by counter-based id (deterministic). */
  private readonly storedQueries = new Map<string, StoredQuery>();
  private queryCounter = 0;

  constructor(public readonly model: Model) {
    this.api = new ModelApi(model);
    this.repo = new ProjectRepository();
    const rootName = model.roots()[0]?.declaredName ?? 'Untitled';
    const project = this.repo.createProject(rootName, model);
    this.defaultProjectId = project.id;
  }

  /* ───────────────────────────── Dispatch ───────────────────────────────── */

  /**
   * Route an in-process request. `path` may carry a query string
   * (`?offset=&limit=`). Returns `{ status, body }`.
   */
  apiFetch(method: string, path: string, body?: unknown): ApiResponse {
    const verb = method.toUpperCase();
    const [rawPath, rawQuery] = path.split('?');
    const seg = rawPath.split('/').filter(Boolean);
    const params = parseQuery(rawQuery);

    // GET /analytics/{metrics|constraints}
    if (seg[0] === 'analytics' && seg.length === 2) {
      if (verb !== 'GET') return methodNotAllowed();
      if (seg[1] === 'metrics') return ok(modelMetrics(this.model));
      if (seg[1] === 'constraints') return ok(constraintReport(this.model));
      if (seg[1] === 'execution') return ok(executionReport(this.model));
      if (seg[1] === 'units') return ok(unitReport(this.model));
      if (seg[1] === 'analysis') return ok(analysisReport(this.model));
      return notFound(`Unknown analytics route: /${seg.join('/')}`);
    }

    // POST /queries — evaluate against the default project's HEAD (legacy).
    if (seg[0] === 'queries' && seg.length === 1) {
      if (verb !== 'POST') return methodNotAllowed();
      const bad = bodyError('query', body);
      if (bad) return bad;
      return ok(this.runQuery(this.model, body));
    }

    // GET /elements/:id — OMG element JSON from the default HEAD (legacy).
    if (seg[0] === 'elements' && seg.length === 2) {
      if (verb !== 'GET') return methodNotAllowed();
      return this.getElement(seg[1]);
    }

    // /projects ...
    if (seg[0] === 'projects') {
      return this.routeProjects(verb, seg, params, body);
    }

    return notFound(`Unknown route: ${verb} /${seg.join('/')}`);
  }

  /* ──────────────────────────── Project routing ─────────────────────────── */

  private routeProjects(
    verb: string,
    seg: string[],
    params: Record<string, string>,
    body: unknown,
  ): ApiResponse {
    // /projects
    if (seg.length === 1) {
      if (verb === 'GET') return ok(pageResources(this.repo.listProjects().map((p) => this.projectJSON(p)), params));
      if (verb === 'POST') {
        const bad = bodyError('project', body);
        if (bad) return bad;
        const name = (body as { name?: string } | undefined)?.name;
        // No usable body ⇒ 405 (preserves legacy behaviour for `POST /projects`).
        if (!name) return methodNotAllowed();
        return created(this.projectJSON(this.repo.createProject(name)));
      }
      return methodNotAllowed();
    }

    const projectId = this.resolveProjectId(seg[1]);
    const project = this.repo.getProject(projectId);
    if (!project) return notFound(`No such project: ${seg[1]}`);

    // /projects/:id
    if (seg.length === 2) {
      if (verb === 'GET') return ok(this.projectJSON(project));
      if (verb === 'PUT') {
        const bad = bodyError('project', body);
        if (bad) return bad;
        const name = (body as { name?: string } | undefined)?.name;
        if (!name) return methodNotAllowed();
        return ok(this.projectJSON(this.repo.renameProject(projectId, name)));
      }
      if (verb === 'DELETE') {
        this.repo.deleteProject(projectId);
        for (const [qid, q] of this.storedQueries) {
          if (q.projectId === projectId) this.storedQueries.delete(qid);
        }
        return noContent();
      }
      return methodNotAllowed();
    }

    const sub = seg[2];

    // /projects/:id/elements — legacy shortcut: HEAD of the default project.
    if (sub === 'elements' && seg.length === 3) {
      if (verb !== 'GET') return methodNotAllowed();
      return ok(this.listElements(params));
    }

    if (sub === 'branches') return this.routeBranches(verb, seg, params, projectId, body);
    if (sub === 'tags') return this.routeTags(verb, seg, params, projectId, body);
    if (sub === 'commits') return this.routeCommits(verb, seg, params, projectId, body);
    if (sub === 'queries') return this.routeQueries(verb, seg, params, projectId, body);

    // POST /projects/:id/merge — 3-way branch merge.
    if (sub === 'merge' && seg.length === 3) return this.routeMerge(verb, projectId, body);

    // GET /projects/:id/diff?base=X&compare=Y — diff between arbitrary commits.
    if (sub === 'diff' && seg.length === 3) return this.routeDiff(verb, projectId, params);

    return notFound(`Unknown project sub-resource: /${seg.join('/')}`);
  }

  private routeBranches(
    verb: string,
    seg: string[],
    params: Record<string, string>,
    projectId: string,
    body: unknown,
  ): ApiResponse {
    // /projects/:id/branches
    if (seg.length === 3) {
      if (verb === 'GET') {
        return ok(pageResources(this.repo.listBranches(projectId).map((b) => this.branchJSON(b)), params));
      }
      if (verb === 'POST') {
        const bad = bodyError('branch', body);
        if (bad) return bad;
        const b = body as { name?: string; fromCommit?: string; fromCommitId?: string } | undefined;
        if (!b?.name) return methodNotAllowed();
        try {
          const branch = this.repo.createBranch(projectId, b.name, b.fromCommit ?? b.fromCommitId);
          return created(this.branchJSON(branch));
        } catch (e) {
          return notFound(errMsg(e));
        }
      }
      return methodNotAllowed();
    }
    // /projects/:id/branches/:bid
    if (seg.length === 4) {
      const branch = this.repo.getBranch(seg[3]);
      if (!branch || branch.projectId !== projectId) return notFound(`No such branch: ${seg[3]}`);
      if (verb === 'GET') return ok(this.branchJSON(branch));
      if (verb === 'DELETE') {
        try {
          this.repo.deleteBranch(seg[3]);
          return noContent();
        } catch (e) {
          return conflict({ error: errMsg(e) });
        }
      }
      return methodNotAllowed();
    }
    return notFound(`Unknown branch route: /${seg.join('/')}`);
  }

  private routeTags(
    verb: string,
    seg: string[],
    params: Record<string, string>,
    projectId: string,
    body: unknown,
  ): ApiResponse {
    // /projects/:id/tags
    if (seg.length === 3) {
      if (verb === 'GET') {
        return ok(pageResources(this.repo.listTags(projectId).map((t) => this.tagJSON(t)), params));
      }
      if (verb === 'POST') {
        const bad = bodyError('tag', body);
        if (bad) return bad;
        const b = body as { name?: string; commit?: string; commitId?: string } | undefined;
        const commitId = b?.commit ?? b?.commitId;
        if (!b?.name || !commitId) return methodNotAllowed();
        try {
          return created(this.tagJSON(this.repo.createTag(projectId, b.name, commitId)));
        } catch (e) {
          return notFound(errMsg(e));
        }
      }
      return methodNotAllowed();
    }
    // /projects/:id/tags/:tid
    if (seg.length === 4) {
      const tag = this.repo.getTag(seg[3]);
      if (!tag || tag.projectId !== projectId) return notFound(`No such tag: ${seg[3]}`);
      if (verb === 'GET') return ok(this.tagJSON(tag));
      if (verb === 'DELETE') {
        this.repo.deleteTag(seg[3]);
        return noContent();
      }
      return methodNotAllowed();
    }
    return notFound(`Unknown tag route: /${seg.join('/')}`);
  }

  /* ────────────────────────────── Stored queries ────────────────────────────── */

  private routeQueries(
    verb: string,
    seg: string[],
    params: Record<string, string>,
    projectId: string,
    body: unknown,
  ): ApiResponse {
    // /projects/:id/queries
    if (seg.length === 3) {
      if (verb === 'GET') {
        const list = [...this.storedQueries.values()]
          .filter((q) => q.projectId === projectId)
          .map((q) => this.storedQueryJSON(q));
        return ok(pageResources(list, params));
      }
      if (verb === 'POST') {
        const bad = bodyError('query', body);
        if (bad) return bad;
        const b = (body ?? {}) as { name?: string; query?: Query };
        const sq: StoredQuery = {
          id: `query-${++this.queryCounter}`,
          projectId,
          query: asQuery(b),
        };
        if (b.name !== undefined) sq.name = b.name;
        this.storedQueries.set(sq.id, sq);
        return created(this.storedQueryJSON(sq));
      }
      return methodNotAllowed();
    }

    const qid = seg[3];
    const sq = this.storedQueries.get(qid);
    if (!sq || sq.projectId !== projectId) return notFound(`No such query: ${qid}`);

    // /projects/:id/queries/:qid
    if (seg.length === 4) {
      if (verb === 'GET') return ok(this.storedQueryJSON(sq));
      if (verb === 'PUT') {
        const bad = bodyError('query', body);
        if (bad) return bad;
        const b = (body ?? {}) as { name?: string; query?: Query };
        if (b.name !== undefined) sq.name = b.name;
        if (b.query !== undefined || hasQueryFields(b)) sq.query = asQuery(b);
        return ok(this.storedQueryJSON(sq));
      }
      if (verb === 'DELETE') {
        this.storedQueries.delete(qid);
        return noContent();
      }
      return methodNotAllowed();
    }

    // /projects/:id/queries/:qid/results — evaluate at the default branch head.
    if (seg.length === 5 && seg[4] === 'results') {
      if (verb !== 'GET') return methodNotAllowed();
      const project = this.repo.getProject(projectId)!;
      const head = this.repo.getBranch(project.defaultBranchId)?.headCommitId;
      if (!head) return notFound(`No head commit for project: ${projectId}`);
      return ok(this.runQuery(this.repo.getModelAtCommit(head), sq.query));
    }

    return notFound(`Unknown queries route: /${seg.join('/')}`);
  }

  /* ─────────────────────────────────── Merge ────────────────────────────────── */

  private routeMerge(verb: string, projectId: string, body: unknown): ApiResponse {
    if (verb !== 'POST') return methodNotAllowed();
    const bad = bodyError('merge', body);
    if (bad) return bad;
    const b = body as
      | { source?: string; target?: string; sourceBranch?: string; targetBranch?: string; strategy?: MergeStrategy }
      | undefined;
    const sourceId = b?.source ?? b?.sourceBranch;
    const targetId = b?.target ?? b?.targetBranch;
    if (!sourceId || !targetId) return methodNotAllowed();
    try {
      const result = this.repo.mergeBranches(projectId, sourceId, targetId, { strategy: b?.strategy });
      const json = this.mergeJSON(result);
      // A `manual` merge that surfaced conflicts produces no commit → 409.
      return result.applied ? created(json) : conflict(json);
    } catch (e) {
      return notFound(errMsg(e));
    }
  }

  /* ────────────────────────────── Diff (arbitrary) ──────────────────────────── */

  private routeDiff(verb: string, projectId: string, params: Record<string, string>): ApiResponse {
    if (verb !== 'GET') return methodNotAllowed();
    const baseCid = params.base;
    const compareCid = params.compare;
    if (!baseCid || !compareCid) {
      return notFound('diff requires `base` and `compare` query parameters');
    }
    const base = this.repo.getCommit(baseCid);
    if (!base || base.projectId !== projectId) return notFound(`No such commit: ${baseCid}`);
    const compare = this.repo.getCommit(compareCid);
    if (!compare || compare.projectId !== projectId) return notFound(`No such commit: ${compareCid}`);
    return ok(this.diffCommits(baseCid, compareCid));
  }

  private routeCommits(
    verb: string,
    seg: string[],
    params: Record<string, string>,
    projectId: string,
    body: unknown,
  ): ApiResponse {
    // /projects/:id/commits
    if (seg.length === 3) {
      if (verb === 'GET') {
        const branchId = params.branch || params.branchId || undefined;
        return ok(pageResources(this.repo.listCommits(projectId, branchId).map((c) => this.commitJSON(c)), params));
      }
      if (verb === 'POST') return this.createCommit(projectId, body);
      return methodNotAllowed();
    }

    const commitId = seg[3];
    const commit = this.repo.getCommit(commitId);
    if (!commit || commit.projectId !== projectId) return notFound(`No such commit: ${commitId}`);

    // /projects/:id/commits/:cid
    if (seg.length === 4) {
      if (verb !== 'GET') return methodNotAllowed();
      return ok(this.commitJSON(commit));
    }

    const csub = seg[4];

    // /projects/:id/commits/:cid/elements[...]
    if (csub === 'elements') {
      if (seg.length === 5) {
        if (verb !== 'GET') return methodNotAllowed();
        return ok(this.listElementsAtCommit(commitId, params, body));
      }
      if (seg.length === 6) {
        if (verb !== 'GET') return methodNotAllowed();
        return this.getElementAtCommit(commitId, seg[5]);
      }
      // /projects/:id/commits/:cid/elements/:eid/relationships — navigation.
      if (seg.length === 7 && seg[6] === 'relationships') {
        if (verb !== 'GET') return methodNotAllowed();
        return this.relationshipsAtCommit(commitId, seg[5]);
      }
      return notFound(`Unknown elements route: /${seg.join('/')}`);
    }

    // /projects/:id/commits/:cid/roots
    if (csub === 'roots' && seg.length === 5) {
      if (verb !== 'GET') return methodNotAllowed();
      return ok(this.rootsAtCommit(commitId));
    }

    // /projects/:id/commits/:cid/query-results
    if (csub === 'query-results' && seg.length === 5) {
      if (verb !== 'POST') return methodNotAllowed();
      const bad = bodyError('query', body);
      if (bad) return bad;
      return ok(this.runQuery(this.repo.getModelAtCommit(commitId), body));
    }

    // /projects/:id/commits/:cid/diff/:baseCid
    if (csub === 'diff' && seg.length === 6) {
      if (verb !== 'GET') return methodNotAllowed();
      const baseCid = seg[5];
      const base = this.repo.getCommit(baseCid);
      if (!base || base.projectId !== projectId) return notFound(`No such commit: ${baseCid}`);
      return ok(this.diffCommits(baseCid, commitId));
    }

    return notFound(`Unknown commit sub-resource: /${seg.join('/')}`);
  }

  /* ─────────────────────────── Commit writes ────────────────────────────── */

  /**
   * Apply a set of change records to a clone of the target branch head, then
   * snapshot the result as a new immutable commit. Body shape:
   * ```
   * { branch?: branchId, description?: string, changes: [
   *     { operation:'create', element:{ '@type', declaredName?, ownerId?|owner?, attrs?, source?, target?, identifier? } },
   *     { operation:'update', identifier, element:{ declaredName?, attrs?, source?, target? } },
   *     { operation:'delete', identifier },
   * ] }
   * ```
   */
  private createCommit(projectId: string, body: unknown): ApiResponse {
    const bad = bodyError('commit', body);
    if (bad) return bad;
    const b = body as CommitRequest | undefined;
    if (!b) return methodNotAllowed();

    const branchId = b.branch ?? b.branchId ?? this.repo.getProject(projectId)!.defaultBranchId;
    const branch = this.repo.getBranch(branchId);
    if (!branch || branch.projectId !== projectId) return notFound(`No such branch: ${branchId}`);

    const working = this.repo.getModelAtCommit(branch.headCommitId);
    const expectedHead = b.baseCommit ?? b.baseCommitId;
    try {
      working.transaction(() => {
        for (const change of b.changes ?? []) applyChange(working, change);
      });
      const commit = this.repo.commit(projectId, branchId, working, b.description, { expectedHead });
      return created(this.commitJSON(commit));
    } catch (e) {
      // A stale optimistic base is a 409 Conflict carrying the live head, not a
      // 404 — mirrors the transport-level `If-Match` precondition in the server.
      if (e instanceof StaleHeadError) {
        return conflict({
          error: 'Conflict: branch head has advanced since baseCommit',
          expected: e.expected,
          currentHead: e.currentHead,
        });
      }
      return notFound(errMsg(e));
    }
  }

  /* ─────────────────────────────── Handlers ─────────────────────────────── */

  private projectJSON(project: Project): ProjectResource {
    const branch = this.repo.getBranch(project.defaultBranchId);
    return {
      '@id': this.displayProjectId(project.id),
      '@type': 'Project',
      name: project.name,
      defaultBranch: { '@id': project.defaultBranchId },
      defaultCommit: branch?.headCommitId ?? '',
    };
  }

  private branchJSON(branch: Branch): Record<string, unknown> {
    return {
      '@id': branch.id,
      '@type': 'Branch',
      name: branch.name,
      project: { '@id': this.displayProjectId(branch.projectId) },
      head: { '@id': branch.headCommitId },
    };
  }

  private tagJSON(tag: Tag): Record<string, unknown> {
    return {
      '@id': tag.id,
      '@type': 'Tag',
      name: tag.name,
      project: { '@id': this.displayProjectId(tag.projectId) },
      taggedCommit: { '@id': tag.commitId },
    };
  }

  private commitJSON(commit: Commit): Record<string, unknown> {
    const json: Record<string, unknown> = {
      '@id': commit.id,
      '@type': 'Commit',
      project: { '@id': this.displayProjectId(commit.projectId) },
      branch: { '@id': commit.branchId },
    };
    if (commit.previousCommitId !== undefined) {
      json.previousCommit = { '@id': commit.previousCommitId };
    }
    if (commit.description !== undefined) json.description = commit.description;
    if (commit.created !== undefined) json.created = commit.created;
    return json;
  }

  private getElement(id: string): ApiResponse {
    const json = this.api.toElementJSON(id);
    if (!json) return notFound(`No such element: ${id}`);
    return ok(json);
  }

  private listElements(params: Record<string, string>): ElementsPage {
    const all = filterElementRecords(this.model.all(), params);
    const { window, total, meta } = paginate(all, params);
    return {
      commitId: modelCommitId(this.model),
      total,
      ...meta,
      elements: window.map((el) => this.api.toElementJSON(el.id)!),
    };
  }

  private listElementsAtCommit(
    commitId: string,
    params: Record<string, string>,
    body: unknown,
  ): ElementsPage {
    const model = this.repo.getModelAtCommit(commitId);
    const api = new ModelApi(model);
    const constraint = (body as Query | undefined)?.constraint;
    // A constraint in the (optional) body filters the collection before paging.
    // Constraint-only queries never project, so the elements are always full
    // records here (finding M14 keeps `select` rows out of the model paths).
    const pool = constraint
      ? (evaluateQuery(model, { constraint }).elements as ElementRecord[])
      : model.all();
    const { window, total, meta } = paginate(filterElementRecords(pool, params), params);
    return {
      commitId,
      total,
      ...meta,
      elements: window.map((el) => api.toElementJSON(el.id)!),
    };
  }

  private getElementAtCommit(commitId: string, elementId: string): ApiResponse {
    const api = new ModelApi(this.repo.getModelAtCommit(commitId));
    const json = api.toElementJSON(elementId);
    if (!json) return notFound(`No such element: ${elementId}`);
    return ok(json);
  }

  private rootsAtCommit(commitId: string): OmgElementJSON[] {
    const model = this.repo.getModelAtCommit(commitId);
    const api = new ModelApi(model);
    return model.roots().map((el) => api.toElementJSON(el.id)!);
  }

  /** Element-navigation view (owned/owning/incoming/outgoing) at a commit. */
  private relationshipsAtCommit(commitId: string, elementId: string): ApiResponse {
    const model = this.repo.getModelAtCommit(commitId);
    if (!model.get(elementId)) return notFound(`No such element: ${elementId}`);
    const api = new ModelApi(model);
    const rel = relationshipsOfElement(model, elementId);
    const toJSON = (recs: { id: string }[]): OmgElementJSON[] => recs.map((r) => api.toElementJSON(r.id)!);
    return ok({
      '@id': elementId,
      '@type': 'RelationshipsResult',
      commitId,
      owned: toJSON(rel.owned),
      owning: toJSON(rel.owning),
      incoming: toJSON(rel.incoming),
      outgoing: toJSON(rel.outgoing),
    });
  }

  private mergeJSON(result: MergeResult): Record<string, unknown> {
    const json: Record<string, unknown> = {
      '@type': 'MergeResult',
      strategy: result.strategy,
      applied: result.applied,
      commit: result.commit ? this.commitJSON(result.commit) : null,
      conflicts: result.conflicts.map((c) => ({ '@id': c.id, kind: c.kind, resolution: c.resolution })),
    };
    if (result.ancestorCommitId !== undefined) {
      json.ancestorCommit = { '@id': result.ancestorCommitId };
    }
    return json;
  }

  private storedQueryJSON(sq: StoredQuery): Record<string, unknown> {
    const json: Record<string, unknown> = {
      '@id': sq.id,
      '@type': 'StoredQuery',
      project: { '@id': this.displayProjectId(sq.projectId) },
      query: sq.query,
    };
    if (sq.name !== undefined) json.name = sq.name;
    return json;
  }

  private diffCommits(baseCid: string, compareCid: string): Record<string, unknown> {
    const diff = this.repo.diff(baseCid, compareCid);
    const baseApi = new ModelApi(this.repo.getModelAtCommit(baseCid));
    const compareApi = new ModelApi(this.repo.getModelAtCommit(compareCid));
    return {
      base: { '@id': baseCid },
      compare: { '@id': compareCid },
      added: diff.added.map((e) => compareApi.toElementJSON(e.id)!),
      removed: diff.removed.map((e) => baseApi.toElementJSON(e.id)!),
      changed: diff.changed.map((c) => ({
        '@id': c.id,
        before: baseApi.toElementJSON(c.id)!,
        after: compareApi.toElementJSON(c.id)!,
      })),
    };
  }

  private runQuery(model: Model, body: unknown): QueryResult {
    return evaluateQuery(model, (body ?? {}) as Query);
  }

  /* ───────────────────────────────── Internal ───────────────────────────── */

  /** Resolve the legacy `project-default` alias to the seeded project's id. */
  private resolveProjectId(id: string): string {
    return id === DEFAULT_PROJECT_ALIAS ? this.defaultProjectId : id;
  }

  /** Present the seeded default project under its legacy `project-default` id. */
  private displayProjectId(id: string): string {
    return id === this.defaultProjectId ? DEFAULT_PROJECT_ALIAS : id;
  }
}

/* ────────────────────────────── Commit changes ──────────────────────────── */

interface CommitChange {
  operation?: 'create' | 'update' | 'delete';
  identifier?: string;
  element?: {
    '@type'?: string;
    identifier?: string;
    declaredName?: string;
    declaredShortName?: string;
    ownerId?: string | null;
    owner?: { '@id': string };
    attrs?: Record<string, string | number | boolean>;
    source?: Array<string | { '@id': string }>;
    target?: Array<string | { '@id': string }>;
  };
}

interface CommitRequest {
  branch?: string;
  branchId?: string;
  description?: string;
  changes?: CommitChange[];
  /** Optimistic-concurrency base head (see {@link CommitOptions.expectedHead}). */
  baseCommit?: string;
  baseCommitId?: string;
}

function refIds(refs: Array<string | { '@id': string }> | undefined): string[] | undefined {
  if (!refs) return undefined;
  return refs.map((r) => (typeof r === 'string' ? r : r['@id']));
}

function applyChange(model: Model, change: CommitChange): void {
  const op = change.operation ?? (change.identifier ? 'update' : 'create');
  if (op === 'delete') {
    if (change.identifier) model.remove(change.identifier);
    return;
  }
  const el = change.element ?? {};
  if (op === 'create') {
    model.create(el['@type'] ?? 'Element', {
      id: el.identifier ?? change.identifier,
      declaredName: el.declaredName,
      declaredShortName: el.declaredShortName,
      ownerId: el.ownerId ?? el.owner?.['@id'] ?? null,
      attrs: el.attrs,
      source: refIds(el.source),
      target: refIds(el.target),
    });
    return;
  }
  // update
  const id = change.identifier ?? el.identifier;
  if (!id) throw new Error('update change requires an identifier');
  model.update(id, {
    declaredName: el.declaredName,
    declaredShortName: el.declaredShortName,
    attrs: el.attrs,
    source: refIds(el.source),
    target: refIds(el.target),
  });
}

/* ───────────────────────────────── Helpers ──────────────────────────────── */

interface ElementsPage {
  commitId: string;
  total: number;
  offset?: number;
  limit?: number | null;
  size?: number;
  nextCursor?: string;
  elements: unknown[];
}

/** Cursor page size, honouring both `size` and the OMG `page[size]` spellings. */
function cursorSize(params: Record<string, string>): string | undefined {
  return params.size ?? params['page[size]'];
}
/** Cursor, honouring both `after` and the OMG `page[after]` spellings. */
function cursorAfter(params: Record<string, string>): string | undefined {
  return params.after ?? params['page[after]'];
}

/**
 * Window a list by offset/limit (default) or cursor (`size`/`after`, a.k.a.
 * `page[size]`/`page[after]`), returning the slice plus the paging metadata to
 * echo back.
 */
function paginate<T extends { id: string }>(
  all: T[],
  params: Record<string, string>,
): { window: T[]; total: number; meta: Record<string, unknown> } {
  const total = all.length;
  const size = cursorSize(params);
  const after = cursorAfter(params);
  if (size !== undefined || after !== undefined) {
    let start = 0;
    if (after !== undefined) {
      const idx = all.findIndex((el) => el.id === after);
      start = idx >= 0 ? idx + 1 : all.length;
    }
    const pageSize = size != null ? clampInt(size, total) : total;
    const window = all.slice(start, start + pageSize);
    const meta: Record<string, unknown> = { size: pageSize };
    const last = window[window.length - 1];
    if (last && all.indexOf(last) < total - 1) meta.nextCursor = last.id;
    return { window, total, meta };
  }
  const offset = clampInt(params.offset, 0);
  const limit = params.limit != null ? clampInt(params.limit, 0) : null;
  const window = limit != null ? all.slice(offset, offset + limit) : all.slice(offset);
  return { window, total, meta: { offset, limit } };
}

/** Filter element records by `?type=` (exact eClass) and `?name=` (substring). */
function filterElementRecords<T extends { eClass: string; declaredName?: string }>(
  list: T[],
  params: Record<string, string>,
): T[] {
  let out = list;
  if (params.type) out = out.filter((el) => el.eClass === params.type);
  if (params.name) out = out.filter((el) => (el.declaredName ?? '').includes(params.name));
  return out;
}

/** A resource JSON object, minimally shaped for filtering/paging. */
type ResourceJSON = { '@id'?: string; '@type'?: unknown; name?: unknown };

/** Filter resource JSON objects by `?type=` (exact `@type`) and `?name=` (substring). */
function filterResources<T extends ResourceJSON>(list: T[], params: Record<string, string>): T[] {
  let out = list;
  if (params.type) out = out.filter((r) => r['@type'] === params.type);
  if (params.name) out = out.filter((r) => String(r.name ?? '').includes(params.name));
  return out;
}

/**
 * Window a resource-JSON array by offset/limit or cursor (`size`/`after`, a.k.a.
 * `page[size]`/`page[after]`), keyed by each item's `@id`. Returns a plain array
 * (list endpoints stay array-shaped for backward compatibility).
 */
function windowResources<T extends ResourceJSON>(list: T[], params: Record<string, string>): T[] {
  const size = cursorSize(params);
  const after = cursorAfter(params);
  if (size !== undefined || after !== undefined) {
    let start = 0;
    if (after !== undefined) {
      const idx = list.findIndex((r) => r['@id'] === after);
      start = idx >= 0 ? idx + 1 : list.length;
    }
    const pageSize = size != null ? clampInt(size, list.length) : list.length;
    return list.slice(start, start + pageSize);
  }
  const offset = clampInt(params.offset, 0);
  const limit = params.limit != null ? clampInt(params.limit, 0) : null;
  return limit != null ? list.slice(offset, offset + limit) : list.slice(offset);
}

/** Filter (`?type=`/`?name=`) then paginate a resource-JSON list. */
function pageResources<T extends ResourceJSON>(list: T[], params: Record<string, string>): T[] {
  return windowResources(filterResources(list, params), params);
}

/** Whether a body carries any recognised top-level {@link Query} field. */
function hasQueryFields(b: Record<string, unknown>): boolean {
  return ['constraint', 'select', 'scopeOwnerId', 'orderBy', 'page'].some((k) => k in b);
}

/**
 * Coerce a stored-query request body into a {@link Query}: an explicit `query`
 * field wins; otherwise the recognised top-level query fields are lifted.
 */
function asQuery(b: { query?: Query } & Record<string, unknown>): Query {
  if (b.query) return b.query;
  const q: Query = {};
  if ('constraint' in b) q.constraint = b.constraint as Query['constraint'];
  if ('select' in b) q.select = b.select as Query['select'];
  if ('scopeOwnerId' in b) q.scopeOwnerId = b.scopeOwnerId as Query['scopeOwnerId'];
  if ('orderBy' in b) q.orderBy = b.orderBy as Query['orderBy'];
  if ('page' in b) q.page = b.page as Query['page'];
  return q;
}

function ok(body: unknown): ApiResponse {
  return { status: 200, body };
}
function created(body: unknown): ApiResponse {
  return { status: 201, body };
}
function noContent(): ApiResponse {
  return { status: 204, body: null };
}
function conflict(body: unknown): ApiResponse {
  return { status: 409, body };
}
function notFound(message: string): ApiResponse {
  return { status: 404, body: { error: message } };
}
function methodNotAllowed(): ApiResponse {
  return { status: 405, body: { error: 'Method not allowed' } };
}
function badRequest(errors: string[]): ApiResponse {
  return { status: 400, body: { error: 'Invalid request body', details: errors } };
}

/**
 * Validate an inbound body against the named schema (finding H1). Returns a
 * `400` {@link ApiResponse} to short-circuit the handler when the body is
 * present but malformed, or `null` when it is absent or valid.
 */
function bodyError(kind: RequestBodyKind, body: unknown): ApiResponse | null {
  const errors = validateRequestBody(kind, body);
  return errors ? badRequest(errors) : null;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Decode a percent-encoded query component; malformed input (e.g. a bare `%`)
 * is returned verbatim rather than throwing URIError (finding M3). */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseQuery(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const pair of raw.split('&')) {
    if (!pair) continue;
    const [k, v = ''] = pair.split('=');
    out[safeDecode(k)] = safeDecode(v);
  }
  return out;
}

function clampInt(value: string | undefined, fallback: number): number {
  if (value == null) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
