/**
 * In-memory, version-controlled model repository (plan §6, OMG API & Services
 * "repository / version-control tier"; see docs/02-omg-standard-reference.md
 * §5.2–5.3).
 *
 * Implements the Git-like resource model the standard prescribes:
 *
 *   Project ──has──▶ Branch (movable head) ──points to──▶ Commit (immutable)
 *      ├──has──▶ Tag (fixed label) ──────────────────────▶ Commit
 *      └──has──▶ Commit ──contains──▶ Element (read AT a commit)
 *
 * Faithfulness / PoC notes:
 *  - Projects contain commits; **commits are immutable**; branches and tags are
 *    the only mutable pointers and merely reference a commit. Writing to the
 *    model creates a NEW commit and advances the branch head.
 *  - A commit stores a full {@link SerializedModel} snapshot (`data`) rather than
 *    a change-set delta. This keeps reads reproducible and `getModelAtCommit`
 *    trivial; {@link ProjectRepository.diff} recovers element-level change
 *    records by comparing two snapshots.
 *  - **Determinism.** All ids (project/branch/commit/tag) are counter-based —
 *    never `Date.now`/`Math.random` — so histories are byte-stable across test
 *    runs. `created` timestamps are optional and only set when the caller passes
 *    one in.
 */

import { Model, FORMAT_VERSION, isRelationship, isMembership } from '@core/index';
import type { ElementRecord, SerializedModel } from '@core/index';

/* ───────────────────────────────── Types ────────────────────────────────── */

/** Top-level container; owns branches, tags and commits. */
export interface Project {
  id: string;
  name: string;
  /** Id of the branch that reads/writes target by default (the 'main' branch). */
  defaultBranchId: string;
}

/** A named, movable pointer to the head commit of a line of development. */
export interface Branch {
  id: string;
  name: string;
  projectId: string;
  /** The commit this branch currently points at (its head). */
  headCommitId: string;
}

/** An immutable snapshot of the model, linked to its predecessor. */
export interface Commit {
  id: string;
  projectId: string;
  branchId: string;
  /** The commit this one was based on (absent for a project's initial commit). */
  previousCommitId?: string;
  description?: string;
  /** Optional caller-supplied timestamp (omitted by default for determinism). */
  created?: string;
  /** Full serialised model snapshot as of this commit. */
  data: SerializedModel;
}

/** A named, immutable pointer to a specific commit (a labeled snapshot). */
export interface Tag {
  id: string;
  name: string;
  projectId: string;
  commitId: string;
}

/**
 * Raised by {@link ProjectRepository.commit} when an optimistic-concurrency
 * `expectedHead` no longer matches the branch's live head — i.e. another writer
 * advanced the branch since the caller read its base. Carries both ids so the
 * transport can surface a `{ currentHead, expected }` 409 (OMG API & Services
 * conditional-write semantics; OSLC "ETag / If-Match" precondition).
 */
export class StaleHeadError extends Error {
  constructor(
    /** The head the caller believed it was writing on top of. */
    readonly expected: string,
    /** The branch's actual current head at write time. */
    readonly currentHead: string,
  ) {
    super(`Stale base commit: expected branch head ${expected} but it is at ${currentHead}`);
    this.name = 'StaleHeadError';
  }
}

/** Options for {@link ProjectRepository.commit}. */
export interface CommitOptions {
  /**
   * Optimistic-concurrency precondition: the commit id the caller read as the
   * branch head when it authored these changes. When supplied and it no longer
   * equals the branch's live head, {@link StaleHeadError} is thrown instead of
   * applying a lost update. Omit (or pass `''`/`'*'`) for an unconditional write.
   */
  expectedHead?: string;
}

/** A single element-level change between two commits. */
export interface ElementChange {
  id: string;
  before: ElementRecord;
  after: ElementRecord;
}

/** Result of comparing two commits, keyed by element id. */
export interface CommitDiff {
  added: ElementRecord[];
  removed: ElementRecord[];
  changed: ElementChange[];
}

/** How a 3-way merge resolves a per-element conflict. */
export type MergeStrategy = 'ours' | 'theirs' | 'manual';

/** A single per-element conflict discovered during a 3-way merge. */
export interface MergeConflict {
  id: string;
  /** The nature of the disagreement between the two branch heads. */
  kind: 'change-change' | 'change-remove' | 'remove-change';
  /** The common-ancestor record (absent when both sides added the id). */
  base?: ElementRecord;
  /** The source-branch ("theirs") record (absent when source removed it). */
  source?: ElementRecord;
  /** The target-branch ("ours") record (absent when target removed it). */
  target?: ElementRecord;
  /** Which side the produced snapshot kept for this element. */
  resolution: 'source' | 'target';
}

/** Options controlling {@link ProjectRepository.mergeBranches}. */
export interface MergeOptions {
  /**
   * Conflict resolution: `ours` keeps the target head's version, `theirs` keeps
   * the source head's version, `manual` reports conflicts *without* producing a
   * merge commit (leaving resolution to the caller). Default `manual`.
   */
  strategy?: MergeStrategy;
  /** Description for the resulting merge commit. */
  description?: string;
}

/** Outcome of a 3-way branch merge. */
export interface MergeResult {
  /** Which strategy was applied. */
  strategy: MergeStrategy;
  /** Whether a merge commit was actually produced and the target head advanced. */
  applied: boolean;
  /** The merge commit, when applied; otherwise `null`. */
  commit: Commit | null;
  /** The common-ancestor commit id (absent when the branches share no history). */
  ancestorCommitId?: string;
  /** Per-element conflicts (empty for a clean merge). */
  conflicts: MergeConflict[];
}

/** Element-navigation view around a single element (KerML relationship roles). */
export interface ElementRelationships {
  /** Relationship elements contained by (owned by) the element. */
  owned: ElementRecord[];
  /** Relationship(s) that own the element (its owner + memberships targeting it). */
  owning: ElementRecord[];
  /** Edge elements whose `target` includes the element. */
  incoming: ElementRecord[];
  /** Edge elements whose `source` includes the element. */
  outgoing: ElementRecord[];
}

/* ────────────────────────────── Repository ──────────────────────────────── */

/**
 * An in-memory repository of {@link Project}s, their {@link Branch}es,
 * immutable {@link Commit}s and {@link Tag}s. Every mutating operation returns
 * the created resource; all ids are deterministic counter-based strings.
 */
export class ProjectRepository {
  private projects = new Map<string, Project>();
  private branches = new Map<string, Branch>();
  private commits = new Map<string, Commit>();
  private tags = new Map<string, Tag>();

  // Monotonic counters → deterministic ids (no Date.now / Math.random).
  private projectCounter = 0;
  private branchCounter = 0;
  private commitCounter = 0;
  private tagCounter = 0;

  /* ─────────────────────────────── Projects ───────────────────────────────── */

  /**
   * Create a project with a `main` branch and an initial commit snapshotting
   * `model` (or an empty model). The new branch becomes the project's default.
   */
  createProject(name: string, model?: Model): Project {
    const projectId = `project-${++this.projectCounter}`;
    const branchId = `branch-${++this.branchCounter}`;

    const project: Project = { id: projectId, name, defaultBranchId: branchId };
    this.projects.set(projectId, project);

    const branch: Branch = {
      id: branchId,
      name: 'main',
      projectId,
      headCommitId: '', // set once the initial commit exists
    };
    this.branches.set(branchId, branch);

    const snapshot = (model ?? new Model()).toJSON();
    const initial = this.newCommit(projectId, branchId, snapshot, undefined, 'Initial commit');
    branch.headCommitId = initial.id;

    return project;
  }

  getProject(id: string): Project | undefined {
    return this.projects.get(id);
  }

  listProjects(): Project[] {
    return [...this.projects.values()];
  }

  /** Rename a project. */
  renameProject(id: string, name: string): Project {
    const project = this.projects.get(id);
    if (!project) throw new Error(`No such project: ${id}`);
    project.name = name;
    return project;
  }

  /** Delete a project and all of its branches, tags and commits. */
  deleteProject(id: string): void {
    if (!this.projects.has(id)) throw new Error(`No such project: ${id}`);
    this.projects.delete(id);
    for (const [bid, b] of this.branches) if (b.projectId === id) this.branches.delete(bid);
    for (const [tid, t] of this.tags) if (t.projectId === id) this.tags.delete(tid);
    for (const [cid, c] of this.commits) if (c.projectId === id) this.commits.delete(cid);
  }

  /* ─────────────────────────────── Branches ───────────────────────────────── */

  /**
   * Create a branch in `projectId` pointing at `fromCommitId` (defaults to the
   * project's default-branch head).
   */
  createBranch(projectId: string, name: string, fromCommitId?: string): Branch {
    const project = this.projects.get(projectId);
    if (!project) throw new Error(`No such project: ${projectId}`);

    let headCommitId = fromCommitId;
    if (headCommitId === undefined) {
      const def = this.branches.get(project.defaultBranchId);
      headCommitId = def?.headCommitId;
    }
    if (headCommitId === undefined || !this.commits.has(headCommitId)) {
      throw new Error(`Cannot branch from unknown commit: ${fromCommitId ?? '(default head)'}`);
    }

    const branchId = `branch-${++this.branchCounter}`;
    const branch: Branch = { id: branchId, name, projectId, headCommitId };
    this.branches.set(branchId, branch);
    return branch;
  }

  getBranch(id: string): Branch | undefined {
    return this.branches.get(id);
  }

  listBranches(projectId: string): Branch[] {
    return [...this.branches.values()].filter((b) => b.projectId === projectId);
  }

  /** Delete a branch. The project's default branch cannot be deleted. */
  deleteBranch(branchId: string): void {
    const branch = this.branches.get(branchId);
    if (!branch) throw new Error(`No such branch: ${branchId}`);
    const project = this.projects.get(branch.projectId);
    if (project && project.defaultBranchId === branchId) {
      throw new Error(`Cannot delete the default branch: ${branchId}`);
    }
    this.branches.delete(branchId);
  }

  /** Move a branch head to a (existing) commit. */
  setBranchHead(branchId: string, commitId: string): Branch {
    const branch = this.branches.get(branchId);
    if (!branch) throw new Error(`No such branch: ${branchId}`);
    if (!this.commits.has(commitId)) throw new Error(`No such commit: ${commitId}`);
    branch.headCommitId = commitId;
    return branch;
  }

  /* ──────────────────────────────── Commits ───────────────────────────────── */

  /**
   * Snapshot `model` as a new immutable commit on `branchId`, linked to the
   * branch's current head as `previousCommitId`, then advance the head.
   */
  commit(
    projectId: string,
    branchId: string,
    model: Model,
    description?: string,
    opts: CommitOptions = {},
  ): Commit {
    const project = this.projects.get(projectId);
    if (!project) throw new Error(`No such project: ${projectId}`);
    const branch = this.branches.get(branchId);
    if (!branch) throw new Error(`No such branch: ${branchId}`);
    if (branch.projectId !== projectId) {
      throw new Error(`Branch ${branchId} does not belong to project ${projectId}`);
    }

    // Optimistic-concurrency check-and-advance. This method never `await`s, so —
    // Node being single-threaded — the compare against the live head and the
    // head advance below are one atomic step: two writers that read the same
    // base cannot both pass this gate. A `'*'` expectation matches any head.
    const { expectedHead } = opts;
    if (
      expectedHead !== undefined &&
      expectedHead !== '' &&
      expectedHead !== '*' &&
      branch.headCommitId !== expectedHead
    ) {
      throw new StaleHeadError(expectedHead, branch.headCommitId);
    }

    const previousCommitId = branch.headCommitId || undefined;
    const created = this.newCommit(projectId, branchId, model.toJSON(), previousCommitId, description);
    branch.headCommitId = created.id;
    return created;
  }

  getCommit(id: string): Commit | undefined {
    return this.commits.get(id);
  }

  /** List commits for a project, optionally restricted to a single branch. */
  listCommits(projectId: string, branchId?: string): Commit[] {
    return [...this.commits.values()].filter(
      (c) => c.projectId === projectId && (branchId === undefined || c.branchId === branchId),
    );
  }

  /* ────────────────────────────────── Tags ────────────────────────────────── */

  /** Attach an immutable named pointer to an existing commit. */
  createTag(projectId: string, name: string, commitId: string): Tag {
    const project = this.projects.get(projectId);
    if (!project) throw new Error(`No such project: ${projectId}`);
    const target = this.commits.get(commitId);
    if (!target) throw new Error(`No such commit: ${commitId}`);
    if (target.projectId !== projectId) {
      throw new Error(`Commit ${commitId} does not belong to project ${projectId}`);
    }

    const tagId = `tag-${++this.tagCounter}`;
    const tag: Tag = { id: tagId, name, projectId, commitId };
    this.tags.set(tagId, tag);
    return tag;
  }

  /** Delete a tag. */
  deleteTag(tagId: string): void {
    if (!this.tags.has(tagId)) throw new Error(`No such tag: ${tagId}`);
    this.tags.delete(tagId);
  }

  getTag(id: string): Tag | undefined {
    return this.tags.get(id);
  }

  listTags(projectId: string): Tag[] {
    return [...this.tags.values()].filter((t) => t.projectId === projectId);
  }

  /* ─────────────────────────── Model reconstruction ───────────────────────── */

  /** Reconstruct the exact {@link Model} snapshotted at `commitId`. */
  getModelAtCommit(commitId: string): Model {
    const commit = this.commits.get(commitId);
    if (!commit) throw new Error(`No such commit: ${commitId}`);
    return Model.fromJSON(commit.data);
  }

  /**
   * Element-level difference between two commits, keyed by element id:
   *  - `added`   — elements present in `compare` but not `base`.
   *  - `removed` — elements present in `base` but not `compare`.
   *  - `changed` — elements present in both whose record differs.
   */
  diff(baseCommitId: string, compareCommitId: string): CommitDiff {
    const baseCommit = this.commits.get(baseCommitId);
    if (!baseCommit) throw new Error(`No such commit: ${baseCommitId}`);
    const compareCommit = this.commits.get(compareCommitId);
    if (!compareCommit) throw new Error(`No such commit: ${compareCommitId}`);

    const baseMap = indexById(baseCommit.data.elements);
    const compareMap = indexById(compareCommit.data.elements);

    const added: ElementRecord[] = [];
    const removed: ElementRecord[] = [];
    const changed: ElementChange[] = [];

    for (const [id, after] of compareMap) {
      const before = baseMap.get(id);
      if (!before) added.push(after);
      else if (!deepEqual(before, after)) changed.push({ id, before, after });
    }
    for (const [id, before] of baseMap) {
      if (!compareMap.has(id)) removed.push(before);
    }

    return { added, removed, changed };
  }

  /* ───────────────────────────── Merge (3-way) ────────────────────────────── */

  /** The chain of commit ids from `commitId` back to a root (inclusive). */
  private commitChain(commitId: string): string[] {
    const chain: string[] = [];
    const seen = new Set<string>();
    let cur: string | undefined = commitId;
    while (cur && this.commits.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      chain.push(cur);
      cur = this.commits.get(cur)!.previousCommitId;
    }
    return chain;
  }

  /** Lowest common ancestor of two commits along their `previousCommit` chains. */
  commonAncestor(a: string, b: string): string | undefined {
    const ancestorsOfA = new Set(this.commitChain(a));
    for (const c of this.commitChain(b)) if (ancestorsOfA.has(c)) return c;
    return undefined;
  }

  /**
   * Three-way merge of `sourceBranchId` (theirs) into `targetBranchId` (ours)
   * over their common ancestor. Element-level: non-conflicting adds/changes/
   * removes on either side auto-merge; a change to the same element on both
   * sides (that does not coincide) is a conflict. `opts.strategy` decides which
   * side a conflict keeps (`ours`|`theirs`); `manual` (default) reports the
   * conflicts and produces NO commit so the caller can resolve them. On a clean
   * merge (or `ours`/`theirs`) a merge commit is created on the target branch,
   * advancing its head. Deterministic: element ordering follows target-then-
   * source-then-ancestor order, all ids counter-based.
   */
  mergeBranches(
    projectId: string,
    sourceBranchId: string,
    targetBranchId: string,
    opts: MergeOptions = {},
  ): MergeResult {
    const project = this.projects.get(projectId);
    if (!project) throw new Error(`No such project: ${projectId}`);
    const source = this.branches.get(sourceBranchId);
    if (!source || source.projectId !== projectId) {
      throw new Error(`No such branch: ${sourceBranchId}`);
    }
    const target = this.branches.get(targetBranchId);
    if (!target || target.projectId !== projectId) {
      throw new Error(`No such branch: ${targetBranchId}`);
    }

    const strategy: MergeStrategy = opts.strategy ?? 'manual';
    const ancestorId = this.commonAncestor(source.headCommitId, target.headCommitId);
    const ancestor = ancestorId ? this.commits.get(ancestorId) : undefined;
    const sourceCommit = this.commits.get(source.headCommitId)!;
    const targetCommit = this.commits.get(target.headCommitId)!;

    const baseMap = indexById(ancestor?.data.elements ?? []);
    const sourceMap = indexById(sourceCommit.data.elements);
    const targetMap = indexById(targetCommit.data.elements);

    // Deterministic id ordering: target snapshot, then source-only, then base-only.
    const orderedIds: string[] = [];
    const seen = new Set<string>();
    for (const list of [targetCommit.data.elements, sourceCommit.data.elements, ancestor?.data.elements ?? []]) {
      for (const el of list) if (!seen.has(el.id)) (seen.add(el.id), orderedIds.push(el.id));
    }

    const merged: ElementRecord[] = [];
    const conflicts: MergeConflict[] = [];
    for (const id of orderedIds) {
      const base = baseMap.get(id);
      const ours = targetMap.get(id);
      const theirs = sourceMap.get(id);
      const ourChange = !deepEqual(base, ours);
      const theirChange = !deepEqual(base, theirs);

      let result: ElementRecord | undefined;
      if (!theirChange) {
        result = ours; // source untouched relative to base ⇒ keep ours
      } else if (!ourChange) {
        result = theirs; // only source changed ⇒ take theirs
      } else if (deepEqual(ours, theirs)) {
        result = ours; // both made the identical change ⇒ no conflict
      } else {
        const kind: MergeConflict['kind'] = !ours
          ? 'remove-change'
          : !theirs
            ? 'change-remove'
            : 'change-change';
        const resolution: 'source' | 'target' = strategy === 'theirs' ? 'source' : 'target';
        result = resolution === 'source' ? theirs : ours;
        const conflict: MergeConflict = { id, kind, resolution };
        if (base) conflict.base = base;
        if (theirs) conflict.source = theirs;
        if (ours) conflict.target = ours;
        conflicts.push(conflict);
      }
      if (result) merged.push(result);
    }

    const applied = strategy !== 'manual' || conflicts.length === 0;
    let commit: Commit | null = null;
    if (applied) {
      const data: SerializedModel = {
        formatVersion: FORMAT_VERSION,
        elements: merged.map((e) => ({ ...e })),
        rootIds: merged.filter((e) => e.ownerId === null).map((e) => e.id),
      };
      const model = Model.fromJSON(data);
      const description = opts.description ?? `Merge ${source.name} into ${target.name}`;
      commit = this.commit(projectId, targetBranchId, model, description);
    }

    const result: MergeResult = { strategy, applied, commit, conflicts };
    if (ancestorId !== undefined) result.ancestorCommitId = ancestorId;
    return result;
  }

  /* ──────────────────────────────── Internal ──────────────────────────────── */

  private newCommit(
    projectId: string,
    branchId: string,
    data: SerializedModel,
    previousCommitId: string | undefined,
    description: string | undefined,
  ): Commit {
    const id = `commit-${++this.commitCounter}`;
    const commit: Commit = { id, projectId, branchId, data };
    if (previousCommitId !== undefined) commit.previousCommitId = previousCommitId;
    if (description !== undefined) commit.description = description;
    this.commits.set(id, commit);
    return commit;
  }
}

/* ───────────────────────────────── Helpers ──────────────────────────────── */

/**
 * Element-navigation helper: classify the relationships/edges around one element
 * into KerML-style roles (see docs/02-omg-standard-reference.md, "Element" §5.4):
 *  - `owned`    — relationship elements contained (owned) by the element.
 *  - `owning`   — relationship(s) that own the element: its owner when that owner
 *                 is itself a relationship, plus any Membership targeting it.
 *  - `incoming` — edge elements whose `target` includes the element.
 *  - `outgoing` — edge elements whose `source` includes the element.
 * Any element carrying `source`/`target` endpoints is treated as an edge (KerML
 * Relationships and endpoint-bearing Usages alike), mirroring `Model.edgesOf`.
 */
export function relationshipsOfElement(model: Model, id: string): ElementRelationships {
  const owned = model.children(id).filter((c) => isRelationship(c.eClass));
  const owning: ElementRecord[] = [];
  const ownerEl = model.owner(id);
  if (ownerEl && isRelationship(ownerEl.eClass)) owning.push(ownerEl);
  for (const r of model.relationships()) {
    if (isMembership(r.eClass) && (r.target ?? []).includes(id) && !owning.some((o) => o.id === r.id)) {
      owning.push(r);
    }
  }
  const incoming = model.edgesTo(id).filter((e) => e.id !== id);
  const outgoing = model.edgesFrom(id).filter((e) => e.id !== id);
  return { owned, owning, incoming, outgoing };
}

function indexById(elements: ElementRecord[]): Map<string, ElementRecord> {
  const map = new Map<string, ElementRecord>();
  for (const el of elements) map.set(el.id, el);
  return map;
}

/** Structural deep equality (order-insensitive on object keys, order-sensitive on arrays). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;

  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr && bArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }

  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  const bKeys = Object.keys(bo);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}
