/**
 * BottomPanel — the tabbed bottom area.
 *
 *  (1) Problems — lists {@link useAppStore.diagnostics}; click a row to select
 *      the offending element.
 *  (2) Text     — embeds the {@link TextEditor}.
 *  (3) API      — a console over the data-analysis / automation SDK: run a JSON
 *      {@link Query} (`store.runQuery`) and render the result as a table, plus
 *      one-click analytics (model metrics, requirement satisfaction, where-used
 *      on the current selection). `window.sysml` is the same live SDK.
 */

import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../store';
import type { ElementRecord } from '../../core/index';
import type { ProjectedRow } from '../../api/query';

/** Narrow a query-result row: full {@link ElementRecord} vs `select`-projected row. */
function isFullQueryElement(el: ElementRecord | ProjectedRow): el is ElementRecord {
  return typeof el.id === 'string';
}
import { TextEditor } from './TextEditor';
import { SimulationTab } from './SimulationTab';
import {
  modelMetrics,
  requirementSatisfaction,
  whereUsed,
  type MergeConflict,
  type MergeStrategy,
  type Query,
} from '@api/index';
import { SEVERITY_ORDER, type Diagnostic } from '@validation/index';
import './panels.css';

type Tab = 'problems' | 'text' | 'api' | 'versions' | 'simulation';

/** A few illustrative canned queries to seed the console. */
const CANNED: Array<{ label: string; query: string }> = [
  { label: 'All elements', query: '{}' },
  {
    label: 'Named elements',
    query: JSON.stringify({ constraint: { property: 'name', operator: 'exists' } }, null, 2),
  },
  {
    label: 'Requirement definitions',
    query: JSON.stringify(
      { constraint: { property: '@type', operator: '=', value: 'RequirementDefinition' } },
      null,
      2,
    ),
  },
  {
    label: 'Part usages',
    query: JSON.stringify(
      { constraint: { property: '@type', operator: '=', value: 'PartUsage' } },
      null,
      2,
    ),
  },
];

/** Discriminated result of the last console action. */
type Output =
  | { kind: 'none' }
  | { kind: 'error'; text: string }
  | { kind: 'query' }
  | { kind: 'json'; title: string; data: unknown };

/* ─────────────────────────────── Problems ───────────────────────────────── */

function ProblemsTab(): JSX.Element {
  const diagnostics = useAppStore((s) => s.diagnostics);
  const select = useAppStore((s) => s.select);

  const sorted = useMemo(
    () => [...diagnostics].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]),
    [diagnostics],
  );

  if (sorted.length === 0) {
    return <div className="panel-empty">No problems detected.</div>;
  }

  const icon = (sev: Diagnostic['severity']) => (sev === 'error' ? '✕' : sev === 'warning' ? '▲' : 'ⓘ');

  return (
    <div className="problems-list">
      {sorted.map((d) => (
        <div
          key={d.id}
          className="problem-row"
          data-testid="problem-row"
          data-elementid={d.elementId ?? ''}
          onClick={() => d.elementId && select(d.elementId)}
          title={d.elementId ? 'Select the related element' : undefined}
        >
          <span className={`problem-sev ${d.severity}`}>
            {icon(d.severity)} {d.severity}
          </span>
          <span className="problem-msg">{d.message}</span>
          <span className="problem-rule">{d.ruleId}</span>
        </div>
      ))}
    </div>
  );
}

/* ───────────────────────────── API console ──────────────────────────────── */

function ApiTab(): JSX.Element {
  const model = useAppStore((s) => s.model);
  const api = useAppStore((s) => s.api);
  const rev = useAppStore((s) => s.rev);
  const selectionId = useAppStore((s) => s.selectionId);
  const runQuery = useAppStore((s) => s.runQuery);
  const queryResult = useAppStore((s) => s.queryResult);
  const select = useAppStore((s) => s.select);

  const [queryText, setQueryText] = useState(CANNED[0].query);
  const [output, setOutput] = useState<Output>({ kind: 'none' });
  // Version history over the live SDK's repository (seeded lazily on first read).
  const [commits, setCommits] = useState<string[]>(() => api.history().map((c) => c.id));

  const currentCommit = commits[commits.length - 1] ?? '';

  const onCommit = () => {
    const snap = api.commit(`Snapshot ${api.history().length}`);
    const ids = api.history().map((c) => c.id);
    setCommits(ids);
    setOutput({ kind: 'json', title: `Committed ${snap.id}`, data: { head: snap.id, history: ids } });
  };

  const onRun = () => {
    let query: Query;
    try {
      query = (queryText.trim() === '' ? {} : JSON.parse(queryText)) as Query;
    } catch (err) {
      setOutput({ kind: 'error', text: `Invalid JSON query: ${(err as Error).message}` });
      return;
    }
    try {
      runQuery(query);
      setOutput({ kind: 'query' });
    } catch (err) {
      setOutput({ kind: 'error', text: `Query failed: ${(err as Error).message}` });
    }
  };

  // Analytics run against the live model (rev keeps the deps honest).
  void rev;
  const onMetrics = () => setOutput({ kind: 'json', title: 'Model metrics', data: modelMetrics(model) });
  const onSatisfaction = () =>
    setOutput({ kind: 'json', title: 'Requirement satisfaction', data: requirementSatisfaction(model) });
  const onWhereUsed = () => {
    if (!selectionId) {
      setOutput({ kind: 'error', text: 'Where-used: select an element first.' });
      return;
    }
    setOutput({ kind: 'json', title: 'Where used', data: whereUsed(model, selectionId) });
  };

  return (
    <div className="api-console">
      <div className="api-console-hint">
        Live SDK on <code>window.sysml</code> — run a JSON query or one-click analytics below.
      </div>

      <div className="api-commit-bar" data-testid="api-commit-bar">
        <button data-testid="api-commit" onClick={onCommit} title="Snapshot the current model into the version history">
          Commit
        </button>
        <span>
          Current commit: <code data-testid="api-commit-id">{currentCommit || '(none)'}</code>
        </span>
        <span className="api-commit-list" data-testid="api-commit-list">
          {commits.join(', ')}
        </span>
      </div>

      <div className="api-console-row">
        <select
          aria-label="Canned queries"
          onChange={(e) => {
            const c = CANNED[Number(e.target.value)];
            if (c) setQueryText(c.query);
          }}
          value=""
        >
          <option value="" disabled>
            Canned queries…
          </option>
          {CANNED.map((c, i) => (
            <option key={c.label} value={i}>
              {c.label}
            </option>
          ))}
        </select>
        <button data-testid="api-run" onClick={onRun}>
          Run query
        </button>
        <button data-testid="api-metrics" onClick={onMetrics}>
          Metrics
        </button>
        <button data-testid="api-satisfaction" onClick={onSatisfaction}>
          Requirement satisfaction
        </button>
        <button data-testid="api-whereused" onClick={onWhereUsed}>
          Where-used (selection)
        </button>
      </div>

      <textarea
        className="api-query"
        data-testid="api-query"
        spellCheck={false}
        value={queryText}
        onChange={(e) => setQueryText(e.target.value)}
        placeholder='{ "constraint": { "property": "@type", "operator": "=", "value": "PartUsage" } }'
      />

      <div className="api-results" data-testid="api-results">
        {output.kind === 'none' && <span className="panel-empty">No results yet.</span>}
        {output.kind === 'error' && <span className="api-error">{output.text}</span>}
        {output.kind === 'json' && (
          <>
            <div className="api-result-title">{output.title}</div>
            {JSON.stringify(output.data, null, 2)}
          </>
        )}
        {output.kind === 'query' &&
          (queryResult && queryResult.elements.length > 0 ? (
            <table className="api-table">
              <thead>
                <tr>
                  <th>id</th>
                  <th>type</th>
                  <th>name</th>
                  <th>qualifiedName</th>
                </tr>
              </thead>
              <tbody>
                {queryResult.elements.map((el) =>
                  isFullQueryElement(el) ? (
                    <tr key={el.id} onClick={() => select(el.id)} title="Select element">
                      <td>{el.id}</td>
                      <td>{el.eClass}</td>
                      <td>{el.declaredName ?? ''}</td>
                      <td>{model.qualifiedName(el.id)}</td>
                    </tr>
                  ) : (
                    // A `select`-projected row: not a live element — show the
                    // projection payload instead of an id-less empty row.
                    <tr key={JSON.stringify(el)}>
                      <td colSpan={4} className="api-projected-row">
                        {JSON.stringify(el)}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          ) : (
            <span className="panel-empty">
              {queryResult
                ? `0 of ${queryResult.total} elements matched (commit ${queryResult.commitId}).`
                : 'No results yet.'}
            </span>
          ))}
      </div>
    </div>
  );
}

/* ─────────────────────────────── Versions ───────────────────────────────── */

/** Display name for a conflicting element (best-effort across the 3 sides). */
function conflictName(c: MergeConflict): string {
  const rec = c.target ?? c.source ?? c.base;
  return rec?.declaredName ?? rec?.eClass ?? c.id;
}

/** Which side of a merge conflict was kept in the produced snapshot. */
function conflictWinner(c: MergeConflict): string {
  return c.resolution === 'source' ? 'theirs (source) won' : 'ours (target) won';
}

function VersionsTab(): JSX.Element {
  const currentBranchId = useAppStore((s) => s.currentBranchId);
  const branches = useAppStore((s) => s.branches);
  const commits = useAppStore((s) => s.commits);
  const mergeResult = useAppStore((s) => s.mergeResult);
  const refreshVersions = useAppStore((s) => s.refreshVersions);
  const commitVersion = useAppStore((s) => s.commitVersion);
  const createBranchCmd = useAppStore((s) => s.createBranchCmd);
  const switchBranch = useAppStore((s) => s.switchBranch);
  const mergeBranchesCmd = useAppStore((s) => s.mergeBranchesCmd);

  // Populate the branch/commit lists on first mount (seeds the repository).
  useEffect(() => {
    refreshVersions();
  }, [refreshVersions]);

  const [branchName, setBranchName] = useState('feature');
  const [mergeSource, setMergeSource] = useState('');
  const [mergeTarget, setMergeTarget] = useState('');
  const [strategy, setStrategy] = useState<MergeStrategy>('manual');

  // Keep the merge selects pointing at real branches as the list changes.
  useEffect(() => {
    if (branches.length === 0) return;
    setMergeSource((cur) => (branches.some((b) => b.id === cur) ? cur : branches[0].id));
    setMergeTarget((cur) =>
      branches.some((b) => b.id === cur) ? cur : currentBranchId || branches[0].id,
    );
  }, [branches, currentBranchId]);

  const current = branches.find((b) => b.id === currentBranchId);

  return (
    <div className="versions-panel" data-testid="versions-panel" style={{ padding: 8, fontSize: 13 }}>
      <div
        className="versions-header"
        data-testid="version-current"
        style={{ marginBottom: 8 }}
      >
        Branch: <strong>{current?.name ?? '(none)'}</strong> @{' '}
        <code>{current?.headCommitId ?? '(none)'}</code>
      </div>

      <div
        className="versions-actions"
        style={{ display: 'flex', gap: 8, alignItems: 'center' }}
      >
        <button
          data-testid="version-commit-btn"
          onClick={() => commitVersion()}
          title="Snapshot the working model as a commit on the current branch"
        >
          Commit
        </button>
        <input
          data-testid="version-branch-name"
          className="version-branch-name"
          value={branchName}
          onChange={(e) => setBranchName(e.target.value)}
          placeholder="branch name"
          aria-label="New branch name"
        />
        <button
          data-testid="version-branch-new"
          onClick={() => branchName.trim() && createBranchCmd(branchName.trim())}
          title="Create a branch off the current head and switch to it"
        >
          New branch
        </button>
      </div>

      <div className="versions-columns" style={{ display: 'flex', gap: 16, marginTop: 8 }}>
        <div className="versions-col" style={{ flex: 1, minWidth: 0 }}>
          <div className="versions-col-title" style={{ fontWeight: 600, marginBottom: 4 }}>
            Branches
          </div>
          <div className="versions-list" style={{ maxHeight: 160, overflow: 'auto' }}>
            {branches.map((b) => (
              <div
                key={b.id}
                data-testid="version-branch"
                data-branchid={b.id}
                className={`version-branch-row ${b.id === currentBranchId ? 'is-active' : ''}`}
                onClick={() => switchBranch(b.id)}
                title="Switch to this branch (loads its head into the workspace)"
                style={{
                  cursor: 'pointer',
                  padding: '2px 4px',
                  fontWeight: b.id === currentBranchId ? 700 : 400,
                }}
              >
                <span className="vb-name">{b.name}</span>
                {b.id === currentBranchId && <span className="vb-current"> (current)</span>}
                <span className="vb-head"> @ {b.headCommitId}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="versions-col" style={{ flex: 1, minWidth: 0 }}>
          <div className="versions-col-title" style={{ fontWeight: 600, marginBottom: 4 }}>
            History ({current?.name ?? '—'})
          </div>
          <div className="versions-list" style={{ maxHeight: 160, overflow: 'auto' }}>
            {commits.map((c) => (
              <div key={c.id} data-testid="version-commit" className="version-commit-row">
                <code>{c.id}</code>
                <span className="vc-desc"> {c.description ?? ''}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="versions-merge" style={{ marginTop: 12 }}>
        <div className="versions-col-title" style={{ fontWeight: 600, marginBottom: 4 }}>
          Merge (3-way)
        </div>
        <div
          className="versions-merge-row"
          style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}
        >
          <label>
            Source (theirs)
            <select
              data-testid="version-merge-source"
              value={mergeSource}
              onChange={(e) => setMergeSource(e.target.value)}
            >
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Target (ours)
            <select
              data-testid="version-merge-target"
              value={mergeTarget}
              onChange={(e) => setMergeTarget(e.target.value)}
            >
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Strategy
            <select
              data-testid="version-merge-strategy"
              value={strategy}
              onChange={(e) => setStrategy(e.target.value as MergeStrategy)}
            >
              <option value="ours">ours</option>
              <option value="theirs">theirs</option>
              <option value="manual">manual</option>
            </select>
          </label>
          <button
            data-testid="version-merge-btn"
            onClick={() =>
              mergeSource && mergeTarget && mergeBranchesCmd(mergeSource, mergeTarget, strategy)
            }
          >
            Merge
          </button>
        </div>

        {mergeResult && (
          <div
            className="versions-merge-result"
            data-testid="version-merge-box"
            style={{ marginTop: 8 }}
          >
            <div>
              Merge commit:{' '}
              <code data-testid="version-merge-result">{mergeResult.commitId ?? '(no commit)'}</code>
            </div>
            {mergeResult.conflicts.length === 0 ? (
              <div className="version-noconflict" data-testid="version-noconflict">
                No conflicts.
              </div>
            ) : (
              <div className="version-conflicts">
                <div className="version-conflicts-title">
                  {mergeResult.conflicts.length} conflict(s):
                </div>
                {mergeResult.conflicts.map((c) => (
                  <div key={c.id} data-testid="version-conflict" className="version-conflict-row">
                    <span className="vcf-el">
                      {conflictName(c)} <code>({c.id})</code>
                    </span>
                    <span className="vcf-kind">{c.kind}</span>
                    <span className="vcf-side">{conflictWinner(c)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ──────────────────────────────── Shell ─────────────────────────────────── */

export function BottomPanel(): JSX.Element {
  const [tab, setTab] = useState<Tab>('problems');
  const problemCount = useAppStore((s) => s.diagnostics.length);

  const tabs: Array<{ id: Tab; testid: string; label: string }> = [
    { id: 'problems', testid: 'tab-problems', label: `Problems${problemCount ? ` (${problemCount})` : ''}` },
    { id: 'text', testid: 'tab-text', label: 'Text' },
    { id: 'api', testid: 'tab-api', label: 'API Console' },
    { id: 'simulation', testid: 'tab-simulation', label: 'Simulation' },
    { id: 'versions', testid: 'tab-versions', label: 'Versions' },
  ];

  return (
    <>
      <div className="bottom-tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            data-testid={t.testid}
            className={`bottom-tab ${tab === t.id ? 'is-active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="bottom-content">
        {tab === 'problems' && <ProblemsTab />}
        {tab === 'text' && <TextEditor />}
        {tab === 'api' && <ApiTab />}
        {tab === 'simulation' && <SimulationTab />}
        {tab === 'versions' && <VersionsTab />}
      </div>
    </>
  );
}

export default BottomPanel;
