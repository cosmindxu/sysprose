/**
 * Optional Node/Express deployment surface for the modeler.
 *
 * The browser app is and remains **serverless** — it talks to the in-process
 * {@link SysmlApiServer}/{@link OslcServer} facades directly. This module wraps
 * those same facades in a real HTTP server so the API can also be deployed as a
 * standalone service. It is a *thin translation layer*: every request is turned
 * into an in-process `apiFetch(method, path, body)` / `oslcFetch(method, path)`
 * call and the `{ status, body }` result is written straight back to the wire.
 *
 * IMPORTANT: nothing under `src/ui` or `src/main.tsx` may import this module —
 * it pulls in `express`, which must never enter the browser bundle. See
 * `test/server/index-browser-guard.test.ts`.
 *
 * A single {@link ProjectRepository} lives on the app (via the bound
 * {@link SysmlApiServer}), seeded with a demo project by default, or empty when
 * `seed: false` is passed. CORS headers are emitted so the browser app can call
 * a deployed instance cross-origin.
 */

import express, { type Express, type Request, type Response } from 'express';
import { buildSampleModel, Model } from '@core/index';
import { SysmlApiServer } from '@api/rest';
import { OslcServer } from '@api/oslc';
import { API_BASE, buildOpenApiDocument, docsHtml } from './openapi';
import { chooseRdfFormat, rdfContentType, serializeRdf } from './rdf';
import { PRODUCT_SLUG } from '../branding';

/** Options for {@link createServer}. */
export interface CreateServerOptions {
  /**
   * Model to seed the shared repository from. When omitted, a demo model is
   * built (unless `seed` is `false`, in which case the repository starts empty).
   */
  model?: Model;
  /** When `false`, seed with an empty model instead of the demo. Default `true`. */
  seed?: boolean;
  /** Base path under which the OMG REST routes are mounted. Default `/api`. */
  basePath?: string;
  /**
   * Optional bearer token. When set (or via `SYSML_API_TOKEN`), every request
   * except `OPTIONS` preflight and `GET /health` must carry
   * `Authorization: Bearer <token>` or gets a `401`. Unset ⇒ NO auth — the
   * local-first default (bind loopback). Enable it before exposing the API.
   */
  token?: string;
}

/** Extra fields we hang off the Express app for callers/tests. */
export interface SysmlServerLocals {
  api: SysmlApiServer;
  oslc: OslcServer;
  basePath: string;
}

/**
 * Build (but do not start) the Express app. Call `.listen(port)` on the result.
 * The bound {@link SysmlApiServer} and {@link OslcServer} are exposed on
 * `app.locals` (typed via {@link SysmlServerLocals}).
 */
export function createServer(opts: CreateServerOptions = {}): Express {
  const model = opts.model ?? (opts.seed === false ? new Model() : buildSampleModel());
  const basePath = normalizeBase(opts.basePath ?? API_BASE);
  // Opt-in bearer auth: OFF by default (local-first, loopback). Set a token to
  // require `Authorization: Bearer <token>` before exposing the API.
  const apiToken = opts.token ?? process.env.SYSML_API_TOKEN ?? '';

  const api = new SysmlApiServer(model);
  const oslc = new OslcServer(model);
  const openApiDoc = buildOpenApiDocument(basePath);

  // Per-server, per-project write queues (see the `basePath` handler). Scoped to
  // this app instance so independent servers never share a lock.
  const writeQueues = new Map<string, Promise<void>>();

  const app = express();
  const locals = app.locals as unknown as SysmlServerLocals;
  locals.api = api;
  locals.oslc = oslc;
  locals.basePath = basePath;

  app.use(express.json({ limit: '8mb' }));

  // CORS — configurable allowlist. `CORS_ORIGINS` is a comma-separated list of
  // allowed origins; when set, only a matching request Origin is reflected.
  // Unset preserves the permissive `*` default for the local/dev serverless app.
  const corsAllow = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  app.use((req: Request, res: Response, next) => {
    const origin = req.headers.origin;
    if (corsAllow.length === 0) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (origin && corsAllow.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    // Baseline hardening headers. The only HTML surface (`GET /docs`) is
    // self-contained — inline <style>/<script> + a same-origin fetch — so this
    // CSP blocks every external/remote resource and framing while keeping it working.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
        "connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
    );
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    // Opt-in bearer auth (skipped for liveness). Constant-ish check; the token
    // is a shared secret, not a user credential.
    if (apiToken && req.path !== '/health') {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${apiToken}`) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
    }
    next();
  });

  // System / discovery routes.
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', name: PRODUCT_SLUG, basePath });
  });
  app.get('/openapi.json', (_req, res) => {
    res.status(200).json(openApiDoc);
  });
  app.get('/docs', (_req, res) => {
    res.status(200).type('html').send(docsHtml('/openapi.json'));
  });

  // OSLC linked-data surface → oslcFetch. `oslcFetch` expects a path that still
  // carries the leading `oslc` segment, so we re-prepend it (the mount strips it).
  //
  // RDF content negotiation: successful (200) OSLC documents are JSON-LD-shaped
  // graphs, so we serve them as Turtle / RDF/XML / JSON-LD per the `Accept`
  // header, with an optional `?format=turtle|rdfxml|jsonld` override (OSLC Core
  // 3.0 "RDF Representations"). Errors keep the plain JSON error shape.
  app.use('/oslc', (req: Request, res: Response) => {
    const { status, body } = oslc.oslcFetch(req.method, oslcRequestPath(req));
    if (status !== 200 || body === null || typeof body !== 'object') {
      res.status(status).json(body);
      return;
    }
    const format = chooseRdfFormat(req.headers.accept, firstQueryValue(req.query.format));
    res
      .status(status)
      .type(rdfContentType(format))
      .send(serializeRdf(body as Record<string, unknown>, format));
  });

  // Full OMG REST surface → apiFetch. Everything `apiFetch` supports is reached
  // through this single delegation, for every verb: projects (GET/POST/PUT/
  // DELETE), branches & tags (GET/POST/DELETE), commits (GET/POST) with
  // elements-at-commit, element relationships (navigation), roots, per-commit and
  // arbitrary (`/diff?base=&compare=`) diffs, query-results, stored queries
  // (GET/POST/PUT/DELETE + `/results`), branch merge (`POST …/merge`), the legacy
  // elements/queries/analytics routes, and full pagination (offset/limit and
  // cursor `page[size]`/`page[after]`) with `?type=`/`?name=` filtering.
  //
  // Optimistic concurrency + write serialization.
  //
  // A commit-create (`POST …/commits`) may carry an `If-Match` header (or a
  // `baseCommit` body field) naming the branch head it was authored against.
  // The head read + the commit write must happen with no intervening `await`,
  // so the check-and-advance is atomic. `apiFetch` is synchronous and therefore
  // already atomic per invocation; but request bodies are parsed asynchronously
  // and many writes can be in flight at once, so we additionally chain every
  // mutating request (POST/PUT/DELETE) onto a **per-project write queue**
  // (`enqueueWrite`). This guarantees writes to the same project apply strictly
  // one-at-a-time in arrival order (no lost updates / interleaving), while
  // writes to different projects run concurrently and reads are never blocked.
  // A stale client gets 409 Conflict; a fresh one advances the head. Commit/
  // branch responses carry an `ETag` naming the resulting head.
  app.use(basePath, (req: Request, res: Response) => {
    const verb = req.method.toUpperCase();
    const rel = relPath(req);

    // Always turn an unexpected apiFetch throw into a 500 response. On the write
    // path the call runs inside the per-key promise queue, so an uncaught throw
    // would otherwise reject silently and leave the client hanging forever
    // (finding H1). This is the transport-level backstop behind the per-handler
    // ajv validation.
    const fail = (err: unknown): void => {
      res
        .status(500)
        .json({ error: 'Internal error', detail: err instanceof Error ? err.message : String(err) });
    };

    const runWrite = (): void => {
      try {
        if (verb === 'POST') {
          const conflict = checkCommitPrecondition(api, req, rel);
          if (conflict) {
            res.status(409).json(conflict);
            return;
          }
        }
        const { status, body } = api.apiFetch(verb, rel, req.body);
        if (status >= 200 && status < 300) setETag(res, body);
        res.status(status).json(body);
      } catch (err) {
        fail(err);
      }
    };

    if (verb === 'POST' || verb === 'PUT' || verb === 'DELETE') {
      void enqueueWrite(writeQueues, writeKey(rel), runWrite);
    } else {
      // Reads bypass the queue: they don't mutate and must not be blocked. They
      // still carry an `ETag` naming the resource's head (e.g. a branch GET) so
      // clients can use it as an `If-Match` precondition for a later write.
      try {
        const { status, body } = api.apiFetch(verb, rel, req.body);
        if (status >= 200 && status < 300) setETag(res, body);
        res.status(status).json(body);
      } catch (err) {
        fail(err);
      }
    }
  });

  // Fallback 404 in the server's own JSON shape.
  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: `Unknown route: ${req.method} ${req.originalUrl}` });
  });

  return app;
}

/* ───────────────────────────────── Helpers ──────────────────────────────── */

/** Normalise a base path to a single leading slash and no trailing slash. */
function normalizeBase(base: string): string {
  const trimmed = `/${base}`.replace(/\/+/g, '/').replace(/\/$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/**
 * The request path (with query string) *relative to the current mount*, ready to
 * hand to the in-process facades. Inside an `app.use(mount, …)` handler,
 * `req.url` is already stripped of the mount prefix and still carries the query
 * string — exactly what `apiFetch`/`oslcFetch` want (they tolerate the leading
 * slash via `split('/').filter(Boolean)`).
 */
function relPath(req: Request): string {
  return req.url;
}

/**
 * The OSLC request path handed to `oslcFetch` (re-prepending the stripped `oslc`
 * mount segment). When the client asks for an OSLC **Compact** rendering via
 * `Accept` (e.g. `application/x-oslc-compact+xml`) on an element resource, we
 * fold that into a `?compact` param so the facade returns the `oslc:Compact`
 * document — the on-the-wire body is then negotiated to Turtle/RDF-XML/JSON-LD
 * like any other OSLC resource.
 */
function oslcRequestPath(req: Request): string {
  let path = `oslc${relPath(req)}`;
  const accept = String(req.headers.accept ?? '').toLowerCase();
  const wantsCompact = accept.includes('compact');
  const isElement = /^oslc\/elements\/[^/?]+$/.test(path.split('?')[0]);
  if (wantsCompact && isElement && !/[?&]compact(=|&|$)/.test(path)) {
    path += path.includes('?') ? '&compact' : '?compact';
  }
  return path;
}

/** First value of an express query param (which may be a string or array). */
function firstQueryValue(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return undefined;
}

/* ─────────────────────────── Write serialization ────────────────────────── */

/**
 * Queue key for a mutating request: writes are serialized per project so that
 * commits to the same project apply atomically in arrival order, while writes
 * to different projects (or non-project routes) proceed independently.
 */
function writeKey(rel: string): string {
  const seg = rel.split('?')[0].split('/').filter(Boolean);
  return seg[0] === 'projects' && seg[1] ? `project:${seg[1]}` : 'global';
}

/**
 * Chain `task` onto the queue identified by `key`, running it only after every
 * previously-enqueued task on that key has settled (in arrival order). `task`
 * is expected to be synchronous (it writes the response); the returned promise
 * resolves when it completes. A task's failure never poisons the queue — the
 * stored tail resolves regardless — so later writes still run.
 */
function enqueueWrite(
  queues: Map<string, Promise<void>>,
  key: string,
  task: () => void,
): Promise<void> {
  const prev = queues.get(key) ?? Promise.resolve();
  const run = prev.then(task, task);
  queues.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/* ─────────────────────── Optimistic concurrency ─────────────────────────── */

/** Body fields a conditional commit may carry to name its base head. */
interface CommitBody {
  branch?: string;
  branchId?: string;
  baseCommit?: string;
  baseCommitId?: string;
}

/**
 * If the request is a conditional commit-create whose expected base head does
 * NOT match the branch's *current* head, return a 409 body; otherwise `null`
 * (apply). The precondition comes from the `If-Match` header (preferred) or a
 * `baseCommit`/`baseCommitId` body field. `If-Match: *` matches any existing
 * head (unconditional apply). No precondition ⇒ apply (advance the head).
 */
function checkCommitPrecondition(
  api: SysmlApiServer,
  req: Request,
  rel: string,
): Record<string, unknown> | null {
  const seg = rel.split('?')[0].split('/').filter(Boolean);
  const isCommitCreate = seg[0] === 'projects' && seg.length === 3 && seg[2] === 'commits';
  if (!isCommitCreate) return null;

  const body = (req.body ?? {}) as CommitBody;
  const rawIfMatch = normalizeETag(req.headers['if-match']);
  if (rawIfMatch === '*') return null; // "if it exists" — always applies

  // Only honour string precondition fields; a non-string body field is left to
  // the routed, ajv-validated createCommit to reject (avoids echoing garbage in
  // a spurious 409 — finding H1).
  const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const expected = rawIfMatch ?? asStr(body.baseCommit) ?? asStr(body.baseCommitId);
  if (expected === undefined || expected === '') return null; // unconditional

  const projectId = seg[1];
  const branchId = asStr(body.branch) ?? asStr(body.branchId);
  const head = currentHead(api, projectId, branchId);

  if (head !== undefined && head !== expected) {
    return {
      error: 'Conflict: branch head has advanced since baseCommit',
      expected,
      currentHead: head,
    };
  }
  return null;
}

/** Current head commit id of a branch (or the project's default branch). */
function currentHead(api: SysmlApiServer, projectId: string, branchId?: string): string | undefined {
  if (branchId) {
    const r = api.apiFetch('GET', `/projects/${projectId}/branches/${branchId}`);
    if (r.status !== 200) return undefined;
    return (r.body as { head?: { '@id'?: string } }).head?.['@id'];
  }
  const p = api.apiFetch('GET', `/projects/${projectId}`);
  if (p.status !== 200) return undefined;
  return (p.body as { defaultCommit?: string }).defaultCommit;
}

/** Strip `W/` and surrounding quotes from a (possibly array-valued) ETag. */
function normalizeETag(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  const s = (Array.isArray(v) ? v[0] : v).trim();
  return s.replace(/^W\//, '').replace(/^"(.*)"$/, '$1');
}

/** Emit an `ETag` naming the resulting head for commit/branch responses. */
function setETag(res: Response, body: unknown): void {
  if (!body || typeof body !== 'object') return;
  const doc = body as { '@type'?: string; '@id'?: string; head?: { '@id'?: string } };
  if (doc['@type'] === 'Commit' && doc['@id']) {
    res.setHeader('ETag', `"${doc['@id']}"`);
  } else if (doc['@type'] === 'Branch' && doc.head?.['@id']) {
    res.setHeader('ETag', `"${doc.head['@id']}"`);
  }
}
