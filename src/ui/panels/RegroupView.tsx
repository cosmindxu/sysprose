/**
 * RegroupView — the Regroup Workbench. The user re-bundles parts into proposed
 * bundles (drag-and-drop chips between bins, or seed the bundles from Louvain
 * clusters over the part connectivity graph) and previews which connections
 * would become EXTERNAL interfaces of each bundle, plus the delegation ports
 * Apply would synthesize ({@link planRegroup} / {@link planApply}).
 *
 * The preview itself never mutates the model: dropping a chip only updates
 * `store.regroupConfig.membership` (pure UI state), and both engines are pure
 * reads. The ONLY mutation is the **Apply** button → `store.applyRegroup()`,
 * which executes the pre-validated plan as one atomic, undoable step (create
 * composites → reparent members → delegation ports + bindings → rewires) and
 * then resets the config for a fresh preview over the new shape.
 */

import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store';
import { RegroupScenarios } from './RegroupScenarios';
import { proposedPortKey } from '@diagram/index';
import type {
  RegroupBoundary,
  RegroupMember,
  RegroupModel,
  RegroupPlannedBundle,
  RegroupProposedPort,
} from '@diagram/index';
import './panels.css';

/** dataTransfer key carrying the dragged part's element id. */
const DRAG_KEY = 'application/x-sysml-regroup-part';

/* ─────────────────────────────── chips + bins ────────────────────────────── */

/** A draggable part chip; clicking selects the part in the model. */
function PartChip(props: {
  member: RegroupMember;
  selectionId: string | null;
  onSelect: (id: string) => void;
}): JSX.Element {
  const { member, selectionId, onSelect } = props;
  return (
    <button
      data-testid="regroup-part"
      data-element-id={member.id}
      className={`regroup-chip${member.id === selectionId ? ' is-selected' : ''}`}
      title={member.label}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_KEY, member.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={() => onSelect(member.id)}
    >
      {member.label}
    </button>
  );
}

/**
 * A drop-target bin (the "Unassigned" pool when `bundleId` is null, else a
 * bundle card). Dropping a chip re-assigns the part in `regroupConfig` only.
 */
function Bin(props: {
  bundleId: string | null;
  header: React.ReactNode;
  children: React.ReactNode;
  onDropPart: (partId: string, bundleId: string | null) => void;
}): JSX.Element {
  const [isOver, setIsOver] = useState(false);
  return (
    <div
      data-testid="regroup-bin"
      data-bundle-id={props.bundleId ?? ''}
      className={`regroup-bin${isOver ? ' is-drop-target' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setIsOver(true);
      }}
      onDragLeave={() => setIsOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsOver(false);
        const partId = e.dataTransfer.getData(DRAG_KEY);
        if (partId) props.onDropPart(partId, props.bundleId);
      }}
    >
      <div className="regroup-bin-head">{props.header}</div>
      <div className="regroup-bin-body">{props.children}</div>
    </div>
  );
}

/** Bundle title: NEW bundles are renamable inline; existing parts are read-only. */
function BundleLabel(props: {
  bundle: RegroupPlannedBundle;
  onRename: (label: string) => void;
}): JSX.Element {
  const { bundle, onRename } = props;
  const [draft, setDraft] = useState(bundle.label);
  // Escape cancels: the flag makes the blur it triggers a no-op, because the
  // blur handler runs synchronously and would otherwise still see (and commit)
  // the pre-reset draft closure.
  const cancelled = useRef(false);
  useEffect(() => setDraft(bundle.label), [bundle.label]);
  if (!bundle.isNew) {
    return (
      <span className="regroup-bin-title" title={bundle.label}>
        {bundle.label}
      </span>
    );
  }
  return (
    <input
      data-testid="regroup-bundle-label"
      className="regroup-label-input"
      value={draft}
      onChange={(e) => setDraft(e.currentTarget.value)}
      onBlur={() => {
        if (cancelled.current) {
          cancelled.current = false;
          setDraft(bundle.label);
          return;
        }
        const v = draft.trim();
        if (v && v !== bundle.label) onRename(v);
        else setDraft(bundle.label);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          cancelled.current = true;
          setDraft(bundle.label);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

/* ─────────────────────────────── boundary panel ──────────────────────────── */

/**
 * Commit-on-blur editor for ONE proposed delegation port's name. Shows the
 * user's RAW override when present (so re-editing is stable), else the
 * auto-generated label; committing an empty value clears the override.
 * Escape cancels (the flag makes the blur it triggers a no-op).
 */
function PortNameInput(props: {
  bundleId: string;
  port: RegroupProposedPort;
  rawOverride: string | undefined;
  onRename: (bundleId: string, endpointId: string, value: string) => void;
}): JSX.Element {
  const { bundleId, port, rawOverride, onRename } = props;
  const initial = rawOverride ?? port.label;
  const [draft, setDraft] = useState(initial);
  const cancelled = useRef(false);
  useEffect(() => setDraft(initial), [initial]);
  return (
    <input
      data-testid="regroup-port-name"
      data-endpoint-id={port.insideEndpointId}
      className="regroup-port-input"
      value={draft}
      title={`Rename the delegation port “${port.label}”`}
      onChange={(e) => setDraft(e.currentTarget.value)}
      onBlur={() => {
        if (cancelled.current) {
          cancelled.current = false;
          setDraft(initial);
          return;
        }
        if (draft !== initial) onRename(bundleId, port.insideEndpointId, draft);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          cancelled.current = true;
          setDraft(initial);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

function BoundaryPanel(props: {
  regroup: RegroupModel;
  selectionId: string | null;
  onSelect: (id: string) => void;
  portLabels: Record<string, string> | undefined;
  onRenamePort: (bundleId: string, endpointId: string, value: string) => void;
}): JSX.Element {
  const { regroup, selectionId, onSelect, portLabels, onRenamePort } = props;
  const byBundle = regroup.bundles
    .map((b) => ({
      bundle: b,
      entries: regroup.boundary.filter((e) => e.bundleId === b.id),
    }))
    .filter((g) => g.entries.length > 0);
  return (
    <div className="regroup-boundary" data-testid="regroup-boundary">
      {regroup.boundary.length === 0 ? (
        <div className="regroup-empty">No external interfaces yet — assign parts to bundles.</div>
      ) : (
        byBundle.map(({ bundle, entries }) => (
          <div key={bundle.id} className="regroup-boundary-group">
            <div className="regroup-boundary-head">
              {bundle.label} — {entries.length} external connection(s) ·{' '}
              {bundle.proposedPorts.length} proposed port(s)
            </div>
            {bundle.proposedPorts.length > 0 && (
              <div className="regroup-port-editor" data-testid="regroup-port-editor">
                {bundle.proposedPorts.map((p) => (
                  <label key={p.insideEndpointId} className="regroup-port-field">
                    <PortNameInput
                      bundleId={bundle.id}
                      port={p}
                      rawOverride={portLabels?.[proposedPortKey(bundle.id, p.insideEndpointId)]}
                      onRename={onRenamePort}
                    />
                    {p.direction ? <span className="regroup-port-dir">{p.direction}</span> : null}
                  </label>
                ))}
              </div>
            )}
            {entries.map((e: RegroupBoundary, i: number) => (
              <div
                key={`${e.connectionId}:${i}`}
                data-testid="regroup-boundary-row"
                data-element-id={e.connectionId}
                className={`regroup-boundary-row${
                  e.connectionId === selectionId ? ' is-selected' : ''
                }`}
                title={`${e.connectionKind} "${e.connectionLabel}" would cross the ${bundle.label} boundary`}
                onClick={() => onSelect(e.connectionId)}
              >
                <span className="regroup-flow">
                  {e.insidePartLabel}.{e.insideEndpointLabel} → {e.outsidePartLabel}.
                  {e.outsideEndpointLabel}
                </span>
                <span className="regroup-port">
                  ⟹ + port “{e.proposedPortLabel}”
                  {e.proposedPortDirection ? ` (${e.proposedPortDirection})` : ''} on {bundle.label}
                </span>
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
}

/* ─────────────────────────────── main view ───────────────────────────────── */

export function RegroupView(): JSX.Element {
  const regroup = useAppStore((s) => s.regroup);
  const config = useAppStore((s) => s.regroupConfig);
  const selectionId = useAppStore((s) => s.selectionId);
  const select = useAppStore((s) => s.select);
  const setRegroupConfig = useAppStore((s) => s.setRegroupConfig);
  const seedRegroup = useAppStore((s) => s.seedRegroup);
  const applyPlan = useAppStore((s) => s.regroupApply);
  const applyRegroup = useAppStore((s) => s.applyRegroup);

  if (!regroup) {
    return (
      <div className="regroup-wrap" data-testid="regroup-view">
        <div className="center-empty">Building regroup preview…</div>
      </div>
    );
  }

  /** Re-assign a part (null bundle = back to Unassigned). Config-only — NO model change. */
  const assign = (partId: string, bundleId: string | null): void => {
    const membership = { ...config.membership };
    if (bundleId === null) delete membership[partId];
    else membership[partId] = bundleId;
    setRegroupConfig({ membership });
  };

  const addBundle = (): void => {
    // A monotonic-by-availability id (NOT length-based): after a removeBundle,
    // reusing the length could collide with a surviving `new:N` and create two
    // bundles with the same id.
    const used = new Set(config.bundles.map((b) => b.id));
    let n = 0;
    while (used.has(`new:${n}`)) n++;
    setRegroupConfig({
      bundles: [
        ...config.bundles,
        { id: `new:${n}`, label: `Bundle ${config.bundles.length + 1}`, isNew: true },
      ],
    });
  };

  /** Add an EXISTING part as a bundle target (parts get re-bundled INTO it). */
  const addExistingBundle = (partId: string): void => {
    if (!partId || config.bundles.some((b) => b.id === partId)) return;
    const label = regroup.candidateParts.find((p) => p.id === partId)?.label ?? partId;
    // A part used as a container must not also be a member of another bundle.
    const membership = { ...config.membership };
    delete membership[partId];
    setRegroupConfig({
      bundles: [...config.bundles, { id: partId, label, isNew: false }],
      membership,
    });
  };

  /** Remove a bundle: its members return to Unassigned; its port renames drop. */
  const removeBundle = (id: string): void => {
    const membership = { ...config.membership };
    for (const k of Object.keys(membership)) if (membership[k] === id) delete membership[k];
    const portLabels = { ...(config.portLabels ?? {}) };
    const prefix = `${id}::`;
    for (const k of Object.keys(portLabels)) if (k.startsWith(prefix)) delete portLabels[k];
    setRegroupConfig({
      bundles: config.bundles.filter((b) => b.id !== id),
      membership,
      portLabels,
    });
  };

  const renameBundle = (id: string, label: string): void => {
    setRegroupConfig({
      bundles: config.bundles.map((b) => (b.id === id ? { ...b, label } : b)),
    });
  };

  /** Set/clear a delegation port's user rename (empty ⇒ back to auto name). */
  const renamePort = (bundleId: string, endpointId: string, value: string): void => {
    const key = proposedPortKey(bundleId, endpointId);
    const portLabels = { ...(config.portLabels ?? {}) };
    const v = value.trim();
    if (v) portLabels[key] = v;
    else delete portLabels[key];
    setRegroupConfig({ portLabels });
  };

  // The engine's `unassigned` already excludes existing-target parts and
  // reflects EXPLICIT-only membership (an inert/stale membership entry still
  // shows as unassigned), so it is the single source of truth both for the
  // draggable pool AND for the parts eligible to become a new existing-part
  // bundle — keeping the picker consistent with the chips.
  const unassignedChips = regroup.unassigned;
  const freeParts = regroup.unassigned;

  // Part-kind facet: every part metaclass present, keeping the configured kind
  // selectable even when the model currently has no instances of it.
  const kindOptions = regroup.partKindsPresent.map((k) => ({
    value: k.eClass,
    label: `${k.eClass} (${k.count})`,
  }));
  if (!kindOptions.some((o) => o.value === config.partKind)) {
    kindOptions.unshift({ value: config.partKind, label: `${config.partKind} (0)` });
  }

  const boundaryCountOf = (bundleId: string): number =>
    regroup.boundary.reduce((n, e) => n + (e.bundleId === bundleId ? 1 : 0), 0);

  // Apply is possible only when the pre-validated plan has real work + no errors.
  const summary = applyPlan?.summary;
  const hasWork =
    !!summary && (summary.newParts > 0 || summary.moves > 0 || summary.ports > 0 || summary.rewires > 0);
  const hasErrors = (applyPlan?.errors.length ?? 0) > 0;
  const applyTitle = hasErrors
    ? 'The plan has errors (see below) — fix the configuration first'
    : hasWork
      ? 'Execute the previewed regroup as ONE undoable model mutation'
      : 'Nothing to apply — assign parts to bundles first';

  return (
    <div className="regroup-wrap" data-testid="regroup-view">
      <div className="regroup-config">
        <button
          data-testid="regroup-seed"
          className="regroup-btn"
          title="Replace the bundles with Louvain communities detected over the part connectivity graph (preview only)"
          onClick={seedRegroup}
        >
          Seed from clusters
        </button>
        <button
          data-testid="regroup-add-bundle"
          className="regroup-btn"
          title="Add an empty proposed bundle (a new composite to be created on Apply)"
          onClick={addBundle}
        >
          + New bundle
        </button>
        <select
          data-testid="regroup-add-existing"
          className="regroup-select"
          value=""
          disabled={freeParts.length === 0}
          title="Bundle parts INTO an existing part (adds it as a target bundle — no new composite is created)"
          onChange={(e) => addExistingBundle(e.currentTarget.value)}
        >
          <option value="">+ Existing part…</option>
          {freeParts.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <button
          data-testid="regroup-apply"
          className="regroup-btn regroup-btn-primary"
          disabled={!hasWork || hasErrors}
          title={applyTitle}
          onClick={applyRegroup}
        >
          Apply
        </button>
        <label className="regroup-field">
          <span>Part kind</span>
          <select
            data-testid="regroup-partkind"
            value={config.partKind}
            onChange={(e) => setRegroupConfig({ partKind: e.currentTarget.value })}
          >
            {kindOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <span className="regroup-summary" data-testid="regroup-summary">
          {regroup.stats.partCount} parts · {regroup.stats.bundleCount} bundles ·{' '}
          {regroup.stats.boundaryCount} external connections
        </span>
        <span className="regroup-note" data-testid="regroup-note">
          {summary
            ? `Preview — Apply reparents ${summary.moves} part(s), creates ${summary.ports} port(s) + ${summary.bindings} binding(s), rewires ${summary.rewires} connection(s), as one undoable step.`
            : 'Preview only — nothing is modified until Apply'}
        </span>
      </div>

      {hasErrors && (
        <div className="regroup-errors" data-testid="regroup-errors">
          {applyPlan!.errors.map((e, i) => (
            <div key={i} className="regroup-error-row">
              ⚠ {e}
            </div>
          ))}
        </div>
      )}

      <div className="regroup-bins" data-testid="regroup-bins">
        <Bin
          bundleId={null}
          onDropPart={assign}
          header={
            <span className="regroup-bin-title">
              Unassigned <span className="regroup-bin-hint">{unassignedChips.length} part(s)</span>
            </span>
          }
        >
          {unassignedChips.map((m) => (
            <PartChip key={m.id} member={m} selectionId={selectionId} onSelect={select} />
          ))}
        </Bin>
        {regroup.bundles.map((b) => (
          <Bin
            key={b.id}
            bundleId={b.id}
            onDropPart={assign}
            header={
              <>
                <BundleLabel bundle={b} onRename={(label) => renameBundle(b.id, label)} />
                <span className="regroup-bin-hint">
                  {b.members.length} part(s) · {boundaryCountOf(b.id)} external
                  {b.isNew ? '' : ' · existing'}
                </span>
                <button
                  data-testid="regroup-remove-bundle"
                  data-bundle-id={b.id}
                  className="regroup-bin-remove"
                  title="Remove this bundle (its parts return to Unassigned)"
                  onClick={() => removeBundle(b.id)}
                >
                  ×
                </button>
              </>
            }
          >
            {b.members.map((m) => (
              <PartChip key={m.id} member={m} selectionId={selectionId} onSelect={select} />
            ))}
          </Bin>
        ))}
      </div>

      <BoundaryPanel
        regroup={regroup}
        selectionId={selectionId}
        onSelect={select}
        portLabels={config.portLabels}
        onRenamePort={renamePort}
      />

      <RegroupScenarios />
    </div>
  );
}
