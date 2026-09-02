/**
 * RegroupScenarios — named what-if snapshots of the Regroup config. Save the
 * current bundle assignment under a name, reload any saved scenario, and diff
 * two of them (which parts moved between bundles). Session-scoped store state.
 */

import { useMemo, useState } from 'react';
import { useAppStore } from '../store';
import type { RegroupConfig } from '@diagram/index';

interface Move {
  partId: string;
  from: string;
  to: string;
}

/** Human bundle label for a bundle id within a config (— for unassigned). */
function bundleLabel(cfg: RegroupConfig, id: string | undefined): string {
  if (!id) return '—';
  return cfg.bundles.find((b) => b.id === id)?.label ?? '—';
}

/** Parts whose bundle assignment differs between two scenarios. */
export function diffScenarios(
  a: RegroupConfig,
  b: RegroupConfig,
  partLabelOf: (id: string) => string,
): Move[] {
  const parts = new Set([...Object.keys(a.membership), ...Object.keys(b.membership)]);
  const moves: Move[] = [];
  for (const p of parts) {
    const av = a.membership[p];
    const bv = b.membership[p];
    if (av !== bv) moves.push({ partId: p, from: bundleLabel(a, av), to: bundleLabel(b, bv) });
  }
  return moves.sort((x, y) => partLabelOf(x.partId).localeCompare(partLabelOf(y.partId)));
}

export function RegroupScenarios(): JSX.Element {
  const scenarios = useAppStore((s) => s.scenarios);
  const saveScenario = useAppStore((s) => s.saveScenario);
  const loadScenario = useAppStore((s) => s.loadScenario);
  const deleteScenario = useAppStore((s) => s.deleteScenario);
  const model = useAppStore((s) => s.model);
  const [name, setName] = useState('');
  const [pick, setPick] = useState<string[]>([]); // up to 2, for a diff

  const names = Object.keys(scenarios);
  const partLabelOf = (id: string): string =>
    model.get(id)?.declaredName || model.get(id)?.declaredShortName || id;

  const diff = useMemo(() => {
    if (pick.length !== 2) return null;
    const [a, b] = pick;
    if (!scenarios[a] || !scenarios[b]) return null;
    return { a, b, moves: diffScenarios(scenarios[a], scenarios[b], partLabelOf) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pick, scenarios]);

  const togglePick = (n: string): void =>
    setPick((p) => (p.includes(n) ? p.filter((x) => x !== n) : [...p, n].slice(-2)));

  return (
    <div className="regroup-scenarios" data-testid="regroup-scenarios">
      <div className="panel-title">Scenarios</div>
      <div className="scenario-save">
        <input
          data-testid="scenario-name"
          placeholder="Scenario name…"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          type="button"
          data-testid="scenario-save"
          disabled={!name.trim()}
          onClick={() => {
            saveScenario(name);
            setName('');
          }}
        >
          Save
        </button>
      </div>

      {names.length === 0 ? (
        <div className="rel-empty">Save the current config to compare what-ifs.</div>
      ) : (
        <ul className="scenario-list" data-testid="scenario-list">
          {names.map((n) => (
            <li key={n}>
              <label className="scenario-pick">
                <input
                  type="checkbox"
                  data-testid="scenario-pick"
                  checked={pick.includes(n)}
                  onChange={() => togglePick(n)}
                />
                <span>{n}</span>
              </label>
              <button
                type="button"
                className="scenario-load"
                data-testid="scenario-load"
                onClick={() => loadScenario(n)}
              >
                Load
              </button>
              <button
                type="button"
                className="scenario-del node-ctx-danger"
                data-testid="scenario-delete"
                title={`Delete ${n}`}
                onClick={() => {
                  deleteScenario(n);
                  setPick((p) => p.filter((x) => x !== n));
                }}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      {diff && (
        <div className="scenario-diff" data-testid="scenario-diff">
          <div className="panel-title">
            {diff.a} → {diff.b}: {diff.moves.length} change{diff.moves.length === 1 ? '' : 's'}
          </div>
          {diff.moves.length === 0 ? (
            <div className="rel-empty">Identical assignment.</div>
          ) : (
            <ul className="rel-list">
              {diff.moves.map((m) => (
                <li key={m.partId}>
                  {partLabelOf(m.partId)}: {m.from} → {m.to}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export default RegroupScenarios;
