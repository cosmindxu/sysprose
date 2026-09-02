/**
 * `PilotApiClient` — a clean-room HTTP client for the OMG *SysML v2 API &
 * Services* REST protocol (docs/02-omg-standard-reference.md §5.2–5.7).
 *
 * Written from the published OMG API & Services specification (recorded in
 * docs/LICENSES.md), it speaks the same wire contract our in-process
 * {@link SysmlApiServer} exposes over HTTP (src/server/app.ts) — so a model can
 * be pushed to / pulled from any server speaking that contract: our own Express
 * deployment (spec-shaped, never conformance-tested), or a live OMG pilot server
 * given `baseUrl` + `token`.
 *
 * The Git-like resource model is:
 *   Project ─▶ Branch (movable head) ─▶ Commit (immutable) ─▶ Element (read AT a commit)
 *
 * A write is a POST of *change records* (`create`/`update`/`delete`) to
 * `/projects/:id/commits`, which the server applies to the branch head and
 * snapshots as a new commit. Reads page the element graph (offset **or** cursor)
 * and this client follows the pagination to fetch the full set.
 *
 * Element bodies use the OMG element-graph JSON shape: flat `@id`/`@type`,
 * reified `ownedRelationship`/`ownedMember` refs, an `owner` back-link,
 * relationship endpoints as `{'@id'}` refs, and metaclass attributes spread as
 * open additional properties (mirrors {@link ModelApi.toElementJSON}).
 */

import { Model, FORMAT_VERSION } from '@core/index';
import type { ElementRecord, SerializedModel } from '@core/index';
import type { OmgElementJSON, QueryResult, Query } from '@api/index';
import { GENERATOR_ID } from '../branding';

/* ─────────────────────────────── Wire types ─────────────────────────────── */

/** OMG *Project* resource. */
export interface ProjectResource {
  '@id': string;
  '@type': 'Project';
  name: string;
  defaultBranch: { '@id': string };
  defaultCommit: string;
}

/** OMG *Branch* resource. */
export interface BranchResource {
  '@id': string;
  '@type': 'Branch';
  name: string;
  project: { '@id': string };
  head: { '@id': string };
}

/** OMG *Commit* resource. */
export interface CommitResource {
  '@id': string;
  '@type': 'Commit';
  project: { '@id': string };
  branch: { '@id': string };
  previousCommit?: { '@id': string };
  description?: string;
  created?: string;
}

/** A single OMG *change record* posted in a commit body. */
export interface ChangeRecord {
  operation: 'create' | 'update' | 'delete';
  identifier?: string;
  element?: {
    '@type'?: string;
    identifier?: string;
    declaredName?: string;
    declaredShortName?: string;
    ownerId?: string | null;
    attrs?: Record<string, unknown>;
    source?: string[];
    target?: string[];
  };
}

/** Options accepted by {@link PilotApiClient}. */
export interface PilotApiClientOptions {
  /** Bearer token sent as `Authorization: Bearer <token>` on every request. */
  token?: string;
  /** Override the global `fetch` (for tests or non-Node runtimes). */
  fetchImpl?: typeof fetch;
  /** Default page size used when paging element reads (default 200). */
  pageSize?: number;
}

/** Paging window for {@link PilotApiClient.getElements}. */
export interface ElementPage {
  /** Cursor page size (OMG `page[size]`). */
  size?: number;
  /** Start cursor (OMG `page[after]`); resume from a previous page. */
  after?: string;
  /** Stop once at least this many elements have been collected (bounded pull). */
  max?: number;
}

/** Reserved OMG element-graph keys that are NOT metaclass attributes. */
const RESERVED_KEYS = new Set([
  '@id',
  '@type',
  'identifier',
  'declaredName',
  'declaredShortName',
  'ownedRelationship',
  'ownedMember',
  'owner',
  'source',
  'target',
]);

/* ──────────────────────────────── Client ────────────────────────────────── */

export class PilotApiClient {
  private readonly root: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly pageSize: number;

  /**
   * @param baseUrl The API root URL, verbatim (trailing slashes trimmed). Our
   *   own server mounts the API at `/api` (pass `http://h:1/api`); the OMG pilot
   *   serves at the host root (pass `http://h:1`).
   */
  constructor(baseUrl: string, opts: PilotApiClientOptions = {}) {
    this.root = normalizeApiRoot(baseUrl);
    this.token = opts.token;
    const globalFetch = (globalThis as { fetch?: typeof fetch }).fetch;
    const impl = opts.fetchImpl ?? globalFetch;
    if (!impl) throw new Error('No fetch implementation available; pass opts.fetchImpl');
    // Bind so implementations that check `this` (some polyfills) don't throw.
    this.fetchImpl = impl === globalFetch ? impl.bind(globalThis) : impl;
    this.pageSize = opts.pageSize ?? 200;
  }

  /* ─────────────────────────────── Projects ───────────────────────────────── */

  /** `GET /projects` — all projects. */
  async listProjects(): Promise<ProjectResource[]> {
    return this.request<ProjectResource[]>('GET', '/projects');
  }

  /** `POST /projects` — create a project (with a `main` branch + initial commit). */
  async createProject(name: string): Promise<ProjectResource> {
    return this.request<ProjectResource>('POST', '/projects', { name });
  }

  /** `GET /projects/:id`. */
  async getProject(projectId: string): Promise<ProjectResource> {
    return this.request<ProjectResource>('GET', `/projects/${enc(projectId)}`);
  }

  /* ─────────────────────────────── Branches ───────────────────────────────── */

  /** `GET /projects/:id/branches`. */
  async listBranches(projectId: string): Promise<BranchResource[]> {
    return this.request<BranchResource[]>('GET', `/projects/${enc(projectId)}/branches`);
  }

  /** The project's default (`main`) branch resource. */
  async getDefaultBranch(projectId: string): Promise<BranchResource> {
    const project = await this.getProject(projectId);
    const defaultId = project.defaultBranch['@id'];
    return this.request<BranchResource>(
      'GET',
      `/projects/${enc(projectId)}/branches/${enc(defaultId)}`,
    );
  }

  /* ──────────────────────────────── Commits ───────────────────────────────── */

  /** `GET /projects/:id/commits` (optionally scoped to one branch). */
  async listCommits(projectId: string, branchId?: string): Promise<CommitResource[]> {
    const q = branchId ? `?branch=${enc(branchId)}` : '';
    return this.request<CommitResource[]>('GET', `/projects/${enc(projectId)}/commits${q}`);
  }

  /**
   * `POST /projects/:id/commits` — apply `changes` (OMG change records) to
   * `branchId`'s head and snapshot a new commit.
   */
  async createCommit(
    projectId: string,
    branchId: string,
    changes: ChangeRecord[],
    description?: string,
  ): Promise<CommitResource> {
    const body: Record<string, unknown> = { branch: branchId, changes };
    if (description !== undefined) body.description = description;
    return this.request<CommitResource>('POST', `/projects/${enc(projectId)}/commits`, body);
  }

  /* ──────────────────────────────── Elements ──────────────────────────────── */

  /**
   * `GET /projects/:id/commits/:cid/elements` — the FULL element graph at a
   * commit, following cursor pagination (`page[size]`/`page[after]` →
   * `nextCursor`) across as many requests as needed.
   */
  async getElements(
    projectId: string,
    commitId: string,
    page?: ElementPage,
  ): Promise<OmgElementJSON[]> {
    const size = page?.size ?? this.pageSize;
    const start = `${this.root}/projects/${enc(projectId)}/commits/${enc(commitId)}/elements?page[size]=${size}`;
    let url: string | undefined = page?.after !== undefined ? `${start}&page[after]=${enc(page.after)}` : start;
    const all: OmgElementJSON[] = [];
    const max = page?.max ?? Infinity;
    // Follow pages until exhausted (or `max` reached); guard against a looping server.
    const seen = new Set<string>();
    while (url && !seen.has(url)) {
      seen.add(url);
      const { items, nextUrl } = await this.fetchElementPage(url);
      for (const el of items) all.push(el);
      if (all.length >= max) break;
      url = nextUrl;
    }
    return all;
  }

  /**
   * Fetch one page of elements, tolerating BOTH dialects: a bare JSON array with
   * an RFC-5988 `Link: <…>; rel="next"` header (the OMG pilot) OR an
   * `{ elements, nextCursor }` envelope (our own server).
   */
  private async fetchElementPage(url: string): Promise<{ items: OmgElementJSON[]; nextUrl?: string }> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const res = await this.fetchImpl(url, { method: 'GET', headers });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`OMG API GET ${url} → ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`);
    }
    const body: unknown = await res.json();
    const items: OmgElementJSON[] = Array.isArray(body)
      ? (body as OmgElementJSON[])
      : ((body as ElementsPageResponse)?.elements ?? []);
    const linkHeader = res.headers?.get?.('link') ?? undefined;
    let nextUrl = linkHeader ? parseNextLink(linkHeader) : undefined;
    if (!nextUrl && !Array.isArray(body)) {
      const cursor = (body as ElementsPageResponse)?.nextCursor;
      if (cursor) {
        const u = new URL(url);
        u.searchParams.set('page[after]', String(cursor));
        nextUrl = u.toString();
      }
    }
    return { items, nextUrl };
  }

  /** `GET /projects/:id/commits/:cid/elements/:eid` — one element. */
  async getElement(
    projectId: string,
    commitId: string,
    elementId: string,
  ): Promise<OmgElementJSON> {
    return this.request<OmgElementJSON>(
      'GET',
      `/projects/${enc(projectId)}/commits/${enc(commitId)}/elements/${enc(elementId)}`,
    );
  }

  /**
   * `POST /projects/:id/commits/:cid/query-results` — evaluate an OMG Query at a
   * commit and return the matched elements.
   */
  async query(projectId: string, commitId: string, query: Query): Promise<QueryResult> {
    return this.request<QueryResult>(
      'POST',
      `/projects/${enc(projectId)}/commits/${enc(commitId)}/query-results`,
      query,
    );
  }

  /* ──────────────────────────── High-level helpers ────────────────────────── */

  /**
   * Push `model` to a fresh project named `projectName`: create the project,
   * then commit one `create` change record per element — emitted in
   * owner-before-child order so every element's owner already exists on the
   * server when it is applied. Returns the resulting ids.
   */
  async pushModel(
    model: Model,
    projectName: string,
  ): Promise<{ projectId: string; branchId: string; commitId: string }> {
    const project = await this.createProject(projectName);
    const projectId = project['@id'];
    const branchId = project.defaultBranch['@id'];
    const changes = orderByOwnership(model.all()).map(recordToCreateChange);
    const commit = await this.createCommit(projectId, branchId, changes, `Push ${projectName}`);
    return { projectId, branchId, commitId: commit['@id'] };
  }

  /**
   * Pull the model snapshotted at `commitId`: fetch every element (all pages)
   * and reconstruct an equivalent {@link Model} (ids, metaclasses, names,
   * containment and relationship endpoints all preserved).
   */
  async pullModel(projectId: string, commitId: string): Promise<Model> {
    const elements = await this.getElements(projectId, commitId);
    return elementsToModel(elements);
  }

  /* ──────────────────────────────── Transport ─────────────────────────────── */

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await this.fetchImpl(`${this.root}${path}`, init);
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`OMG API ${method} ${path} → ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
}

/* ─────────────────────────────── Wire helpers ───────────────────────────── */

/** One page of an element listing (superset of the fields we consume). */
interface ElementsPageResponse {
  elements: OmgElementJSON[];
  nextCursor?: string;
  total?: number;
}

/**
 * Normalise a server base URL to the API root: strip trailing slashes and use
 * the URL VERBATIM as the API root. The base URL must already point at the API
 * root — do not assume a `/api` mount, which is specific to our own server and
 * absent from other implementations (the OMG pilot serves resources at the
 * host root, e.g. `http://host:9000/projects`).
 */
function normalizeApiRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/** Extract the `rel="next"` URL from an RFC-5988 `Link` header, if present. */
function parseNextLink(header: string): string | undefined {
  for (const part of header.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel\s*=\s*"?next"?/i);
    if (m) return m[1];
  }
  return undefined;
}

function enc(id: string): string {
  return encodeURIComponent(id);
}

/**
 * Order records so every element appears after its owner (containment is a
 * tree, but we guard against malformed cycles). Endpoints (`source`/`target`)
 * impose no ordering — the server stores them as plain id refs.
 */
function orderByOwnership(records: ElementRecord[]): ElementRecord[] {
  const byId = new Map(records.map((r) => [r.id, r] as const));
  const emitted = new Set<string>();
  const onStack = new Set<string>();
  const out: ElementRecord[] = [];
  const visit = (r: ElementRecord): void => {
    if (emitted.has(r.id) || onStack.has(r.id)) return;
    onStack.add(r.id);
    const owner = r.ownerId != null ? byId.get(r.ownerId) : undefined;
    if (owner) visit(owner);
    onStack.delete(r.id);
    emitted.add(r.id);
    out.push(r);
  };
  for (const r of records) visit(r);
  return out;
}

/** Build a `create` change record from a core {@link ElementRecord}. */
function recordToCreateChange(el: ElementRecord): ChangeRecord {
  const element: NonNullable<ChangeRecord['element']> = {
    '@type': el.eClass,
    identifier: el.id,
    ownerId: el.ownerId,
  };
  if (el.declaredName !== undefined) element.declaredName = el.declaredName;
  if (el.declaredShortName !== undefined) element.declaredShortName = el.declaredShortName;
  if (Object.keys(el.attrs).length > 0) element.attrs = { ...el.attrs };
  if (el.source) element.source = [...el.source];
  if (el.target) element.target = [...el.target];
  return { operation: 'create', element };
}

/**
 * Reconstruct a {@link Model} from a set of OMG element-graph JSON objects
 * (the inverse of {@link ModelApi.toElementJSON}): `@type` → metaclass,
 * `owner.@id` → containment, `source`/`target` → endpoint id refs, and every
 * non-reserved property folded back into `attrs`.
 */
export function elementsToModel(elements: OmgElementJSON[]): Model {
  const records: ElementRecord[] = elements.map((j) => {
    const attrs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(j)) {
      if (!RESERVED_KEYS.has(k)) attrs[k] = v;
    }
    const rec: ElementRecord = {
      id: (j['@id'] ?? j.identifier) as string,
      eClass: j['@type'],
      ownerId: (j.owner as { '@id'?: string } | undefined)?.['@id'] ?? null,
      attrs: attrs as ElementRecord['attrs'],
    };
    if (j.declaredName !== undefined) rec.declaredName = j.declaredName;
    if (j.declaredShortName !== undefined) rec.declaredShortName = j.declaredShortName;
    if (Array.isArray(j.source)) rec.source = j.source.map((s) => s['@id']);
    if (Array.isArray(j.target)) rec.target = j.target.map((t) => t['@id']);
    return rec;
  });
  const data: SerializedModel = {
    formatVersion: FORMAT_VERSION,
    generator: `${GENERATOR_ID}/interop`,
    elements: records,
    rootIds: records.filter((r) => r.ownerId === null).map((r) => r.id),
  };
  return Model.fromJSON(data);
}
