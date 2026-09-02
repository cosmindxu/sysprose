import { describe, it, expect } from 'vitest';
import { Model } from '@core/index';
import { ProjectRepository } from '@api/index';

/** A small helper: a fresh model with a single named package root. */
function pkgModel(name: string): Model {
  const m = new Model();
  m.create('Package', { id: 'pkg', declaredName: name });
  return m;
}

describe('ProjectRepository — project creation', () => {
  it('creates a project with a main branch and an initial commit', () => {
    const repo = new ProjectRepository();
    const project = repo.createProject('Demo', pkgModel('Root'));

    expect(project.id).toBe('project-1');
    expect(project.name).toBe('Demo');
    expect(repo.getProject('project-1')).toBe(project);
    expect(repo.listProjects()).toHaveLength(1);

    const branches = repo.listBranches(project.id);
    expect(branches).toHaveLength(1);
    const main = branches[0];
    expect(main.name).toBe('main');
    expect(main.id).toBe(project.defaultBranchId);
    expect(main.projectId).toBe(project.id);

    // Initial commit exists and is the branch head.
    const commits = repo.listCommits(project.id);
    expect(commits).toHaveLength(1);
    const initial = commits[0];
    expect(initial.id).toBe(main.headCommitId);
    expect(initial.previousCommitId).toBeUndefined();
    expect(initial.branchId).toBe(main.id);
    // Snapshot captured the model contents.
    expect(initial.data.elements).toHaveLength(1);
    expect(initial.data.elements[0].declaredName).toBe('Root');
  });

  it('creates an initial empty commit when no model is supplied', () => {
    const repo = new ProjectRepository();
    const project = repo.createProject('Empty');
    const head = repo.getBranch(project.defaultBranchId)!.headCommitId;
    expect(repo.getCommit(head)!.data.elements).toHaveLength(0);
  });

  it('assigns deterministic counter-based ids across projects', () => {
    const repo = new ProjectRepository();
    const a = repo.createProject('A');
    const b = repo.createProject('B');
    expect(a.id).toBe('project-1');
    expect(b.id).toBe('project-2');
    // Commit ids are monotonic and independent of the wall clock.
    expect(repo.listCommits('project-1')[0].id).toBe('commit-1');
    expect(repo.listCommits('project-2')[0].id).toBe('commit-2');
  });
});

describe('ProjectRepository — linear commit history', () => {
  it('commit twice builds a previousCommitId chain and advances the branch head', () => {
    const repo = new ProjectRepository();
    const model = pkgModel('Root');
    const project = repo.createProject('Demo', model);
    const branchId = project.defaultBranchId;
    const initialHead = repo.getBranch(branchId)!.headCommitId;

    model.create('PartUsage', { id: 'p1', declaredName: 'wheel', ownerId: 'pkg' });
    const c1 = repo.commit(project.id, branchId, model, 'add wheel');
    expect(c1.previousCommitId).toBe(initialHead);
    expect(c1.description).toBe('add wheel');
    expect(repo.getBranch(branchId)!.headCommitId).toBe(c1.id);

    model.create('PartUsage', { id: 'p2', declaredName: 'axle', ownerId: 'pkg' });
    const c2 = repo.commit(project.id, branchId, model, 'add axle');
    expect(c2.previousCommitId).toBe(c1.id);
    expect(repo.getBranch(branchId)!.headCommitId).toBe(c2.id);

    // Three commits now exist in history.
    expect(repo.listCommits(project.id)).toHaveLength(3);
    expect(repo.getCommit(c2.id)).toBe(c2);
  });

  it('getModelAtCommit reconstructs the exact snapshot at each commit', () => {
    const repo = new ProjectRepository();
    const model = pkgModel('Root');
    const project = repo.createProject('Demo', model);
    const branchId = project.defaultBranchId;
    const initialHead = repo.getBranch(branchId)!.headCommitId;

    model.create('PartUsage', { id: 'p1', declaredName: 'wheel', ownerId: 'pkg' });
    const c1 = repo.commit(project.id, branchId, model, 'add wheel');

    // Reading the initial commit still shows only the package (time-travel).
    const atInitial = repo.getModelAtCommit(initialHead);
    expect(atInitial.size).toBe(1);
    expect(atInitial.has('p1')).toBe(false);

    // Reading c1 shows the added part.
    const atC1 = repo.getModelAtCommit(c1.id);
    expect(atC1.size).toBe(2);
    expect(atC1.get('p1')!.declaredName).toBe('wheel');

    // Mutating a reconstructed model must not corrupt the stored snapshot.
    atC1.create('PartUsage', { id: 'p9', ownerId: 'pkg' });
    expect(repo.getModelAtCommit(c1.id).size).toBe(2);
  });
});

describe('ProjectRepository — branching and tagging', () => {
  it('branches from a specific commit and can move a branch head', () => {
    const repo = new ProjectRepository();
    const model = pkgModel('Root');
    const project = repo.createProject('Demo', model);
    const mainId = project.defaultBranchId;
    const base = repo.getBranch(mainId)!.headCommitId;

    model.create('PartUsage', { id: 'p1', ownerId: 'pkg' });
    const c1 = repo.commit(project.id, mainId, model);

    const dev = repo.createBranch(project.id, 'dev', base);
    expect(dev.name).toBe('dev');
    expect(dev.headCommitId).toBe(base);
    expect(repo.listBranches(project.id)).toHaveLength(2);

    // Branch without an explicit commit defaults to the default-branch head.
    const feature = repo.createBranch(project.id, 'feature');
    expect(feature.headCommitId).toBe(c1.id);

    // setBranchHead moves the pointer.
    repo.setBranchHead(dev.id, c1.id);
    expect(repo.getBranch(dev.id)!.headCommitId).toBe(c1.id);
  });

  it('tags a commit with an immutable named pointer', () => {
    const repo = new ProjectRepository();
    const project = repo.createProject('Demo', pkgModel('Root'));
    const head = repo.getBranch(project.defaultBranchId)!.headCommitId;

    const tag = repo.createTag(project.id, 'v1.0', head);
    expect(tag.name).toBe('v1.0');
    expect(tag.commitId).toBe(head);
    expect(repo.getTag(tag.id)).toBe(tag);
    expect(repo.listTags(project.id)).toHaveLength(1);
  });

  it('rejects branching or tagging against unknown commits/projects', () => {
    const repo = new ProjectRepository();
    const project = repo.createProject('Demo');
    expect(() => repo.createBranch('nope', 'x')).toThrow();
    expect(() => repo.createBranch(project.id, 'x', 'commit-999')).toThrow();
    expect(() => repo.createTag(project.id, 't', 'commit-999')).toThrow();
  });
});

describe('ProjectRepository — diff', () => {
  it('detects added, removed and changed elements between two commits', () => {
    const repo = new ProjectRepository();
    const model = pkgModel('Root');
    const project = repo.createProject('Demo', model);
    const branchId = project.defaultBranchId;

    // Base commit: pkg + keepMe + dropMe.
    model.create('PartUsage', { id: 'keep', declaredName: 'keepMe', ownerId: 'pkg' });
    model.create('PartUsage', { id: 'drop', declaredName: 'dropMe', ownerId: 'pkg' });
    const base = repo.commit(project.id, branchId, model);

    // Compare commit: remove 'drop', rename 'keep', add 'fresh'.
    model.remove('drop');
    model.rename('keep', 'keptRenamed');
    model.create('PartUsage', { id: 'fresh', declaredName: 'freshOne', ownerId: 'pkg' });
    const compare = repo.commit(project.id, branchId, model);

    const d = repo.diff(base.id, compare.id);

    expect(d.added.map((e) => e.id)).toEqual(['fresh']);
    expect(d.removed.map((e) => e.id)).toEqual(['drop']);
    expect(d.changed).toHaveLength(1);
    expect(d.changed[0].id).toBe('keep');
    expect(d.changed[0].before.declaredName).toBe('keepMe');
    expect(d.changed[0].after.declaredName).toBe('keptRenamed');
  });

  it('reports no differences between a commit and itself', () => {
    const repo = new ProjectRepository();
    const project = repo.createProject('Demo', pkgModel('Root'));
    const head = repo.getBranch(project.defaultBranchId)!.headCommitId;
    const d = repo.diff(head, head);
    expect(d.added).toHaveLength(0);
    expect(d.removed).toHaveLength(0);
    expect(d.changed).toHaveLength(0);
  });
});
