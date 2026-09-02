/**
 * PlanningView — a DOORS→CodeBeamer-style migration/effort wave planner over
 * the live model. ATOMIC elements (each carrying a workload attribute) roll up
 * into GROUPS by a chosen association, the groups are ORDERED by a chosen
 * algorithm and bin-packed into capacity-bounded time SLICES (waves), rendered
 * as a horizontally-scrolling board of wave cards. All configuration lives in
 * `store.planConfig`; changing it re-runs {@link buildPlan} via the store's
 * rebuild. Clicking a group/member selects its model element (selection sync).
 */

import { useEffect, useState } from 'react';
import { useAppStore } from '../store';
import type {
  PlanConfig,
  PlanGroup,
  PlanGrouping,
  PlanMember,
  PlanModel,
  PlanOrdering,
  PlanWave,
} from '@diagram/index';
import './panels.css';

/* ─────────────────────────────── formatting ──────────────────────────────── */

/** Compact workload number: integers plain, fractions to one decimal. */
const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** `count unit(s)` with correct singular/plural (1 item, 2 items, 1 week, 2 weeks). */
const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'}`;

const GROUPING_OPTIONS: { value: PlanGrouping; label: string }[] = [
  { value: 'satisfy', label: 'Satisfied by' },
  { value: 'subject', label: 'Subject' },
  { value: 'containment', label: 'Containment (owner)' },
  { value: 'refine', label: 'Refine' },
  { value: 'derive', label: 'Derive' },
  { value: 'trace', label: 'Trace' },
];

const ORDERING_OPTIONS: { value: PlanOrdering; label: string }[] = [
  { value: 'dependency', label: 'Dependency' },
  { value: 'coupling', label: 'Coupling' },
  { value: 'capacity', label: 'Capacity-balanced' },
  { value: 'domain-first', label: 'Domain-first' },
  { value: 'milp', label: 'MILP (exact)' },
  { value: 'annealing', label: 'Annealing' },
];

const TIME_UNITS = ['day', 'week', 'hour', 'sprint', 'month'];

/* ─────────────────────────────── config strip ────────────────────────────── */

function Select<T extends string>(props: {
  testid: string;
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}): JSX.Element {
  return (
    <label className="plan-field">
      <span>{props.label}</span>
      <select
        data-testid={props.testid}
        value={props.value}
        onChange={(e) => props.onChange(e.currentTarget.value as T)}
      >
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Small text input that commits on blur / Enter (Escape reverts). */
function TextField(props: {
  testid: string;
  label: string;
  value: string;
  onCommit: (v: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
  return (
    <label className="plan-field">
      <span>{props.label}</span>
      <input
        data-testid={props.testid}
        className="plan-input"
        value={draft}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={() => {
          const v = draft.trim();
          if (v && v !== props.value) props.onCommit(v);
          else setDraft(props.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') setDraft(props.value);
        }}
      />
    </label>
  );
}

/**
 * Capacity number input — commits on blur / Enter (Escape reverts), so a plan is
 * re-sliced once per edit rather than on every keystroke. A finite, strictly
 * positive value is required; anything else reverts to the last good capacity.
 */
function CapacityField(props: { value: number; onCommit: (v: number) => void }): JSX.Element {
  const [draft, setDraft] = useState(String(props.value));
  useEffect(() => setDraft(String(props.value)), [props.value]);
  const commit = () => {
    const n = Number(draft);
    if (Number.isFinite(n) && n > 0) props.onCommit(n);
    else setDraft(String(props.value));
  };
  return (
    <label className="plan-field">
      <span>Capacity</span>
      <input
        data-testid="plan-capacity"
        className="plan-input plan-input-num"
        type="number"
        min={0}
        step="any"
        value={draft}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') setDraft(String(props.value));
        }}
      />
    </label>
  );
}

function ConfigStrip(props: {
  plan: PlanModel;
  config: PlanConfig;
  set: (patch: Partial<PlanConfig>) => void;
}): JSX.Element {
  const { plan, config, set } = props;
  // Offer every atomic metaclass present in the model; keep the configured kind
  // selectable even when the model currently has no instances of it.
  const kindOptions = plan.atomicKindsPresent.map((k) => ({
    value: k.eClass,
    label: `${k.eClass} (${k.count})`,
  }));
  if (!kindOptions.some((o) => o.value === config.atomicKind)) {
    kindOptions.unshift({ value: config.atomicKind, label: `${config.atomicKind} (0)` });
  }
  // Cohesion only shapes the coupling-aware orderings (and Domain-first, which
  // is contiguous by construction); Dependency / Capacity-balanced ignore it.
  const cohesionApplies = config.ordering !== 'dependency' && config.ordering !== 'capacity';
  return (
    <div className="plan-config">
      <Select
        testid="plan-atomic-kind"
        label="Atomic kind"
        value={config.atomicKind}
        options={kindOptions}
        onChange={(atomicKind) => set({ atomicKind })}
      />
      <TextField
        testid="plan-workload-attr"
        label="Workload attr"
        value={config.workloadAttr}
        onCommit={(workloadAttr) => set({ workloadAttr })}
      />
      <Select
        testid="plan-grouping"
        label="Grouping"
        value={config.grouping}
        options={GROUPING_OPTIONS}
        onChange={(grouping) => set({ grouping })}
      />
      <Select
        testid="plan-timeunit"
        label="Time unit"
        value={config.timeUnit}
        options={TIME_UNITS.map((u) => ({ value: u, label: u }))}
        onChange={(timeUnit) => set({ timeUnit })}
      />
      <CapacityField value={config.capacity} onCommit={(capacity) => set({ capacity })} />
      <Select
        testid="plan-ordering"
        label="Ordering"
        value={config.ordering}
        options={ORDERING_OPTIONS}
        onChange={(ordering) => set({ ordering })}
      />
      <label
        className={`plan-field plan-check${cohesionApplies ? '' : ' is-disabled'}`}
        title={
          cohesionApplies
            ? 'Hard constraint: each functional block (domain) occupies one contiguous run of the schedule — its groups migrate in the same window, and no wave ever mixes two blocks.'
            : 'Cohesion applies to the Coupling, MILP, Annealing, and Domain-first orderings. Dependency and Capacity-balanced orderings do not keep functional blocks together.'
        }
      >
        <input
          type="checkbox"
          data-testid="plan-cohesion"
          checked={config.cohesion}
          disabled={!cohesionApplies}
          onChange={(e) => set({ cohesion: e.currentTarget.checked })}
        />
        <span>Keep functional blocks together</span>
      </label>
      <span className="plan-summary" data-testid="plan-summary">
        {plural(plan.atomicCount, 'item')} · {plural(plan.groupCount, 'group')} ·{' '}
        {plural(plan.span, plan.timeUnit)} · {fmt(plan.totalWorkload)} total
      </span>
      <span
        className="plan-coupling"
        data-testid="plan-coupling-cost"
        title="Weighted MinLA coupling cost of this order: Σ w·|Δposition| over coupled group pairs — lower means coupled groups are scheduled closer together"
      >
        coupling {fmt(plan.couplingCost)}
        {plan.couplingCost < plan.couplingBaseline && ` (↓ from ${fmt(plan.couplingBaseline)})`}
        {plan.optimalOrder && (
          <span className="plan-badge-optimal" title="An exact solver proved this order optimal">
            optimal
          </span>
        )}
      </span>
    </div>
  );
}

/* ─────────────────────────────── wave board ──────────────────────────────── */

function GroupRow(props: {
  group: PlanGroup;
  selectionId: string | null;
  onSelect: (id: string) => void;
}): JSX.Element {
  const { group, selectionId, onSelect } = props;
  const [open, setOpen] = useState(false);
  return (
    <div
      data-testid="plan-group"
      data-element-id={group.id}
      className={`plan-group${group.id === selectionId ? ' is-selected' : ''}`}
      onClick={() => onSelect(group.id)}
    >
      <div className="plan-group-row">
        <button
          className="plan-twisty"
          title={open ? 'Collapse members' : `Expand ${group.members.length} member(s)`}
          onClick={(e) => {
            e.stopPropagation();
            setOpen((o) => !o);
          }}
        >
          {open ? '▾' : '▸'}
        </button>
        <span className="plan-group-label" title={group.label}>
          {group.label}
        </span>
        {group.oversized && (
          <span className="plan-badge-over" title="This group alone exceeds a wave's capacity">
            oversized
          </span>
        )}
        <span className="plan-group-load">{fmt(group.workload)}</span>
      </div>
      <div className="plan-group-hint">
        {group.eClass} · {group.domain} · {group.members.length} item(s)
      </div>
      {open && (
        <ul className="plan-members">
          {group.members.map((m) => (
            <li
              key={m.id}
              data-testid="plan-member"
              data-element-id={m.id}
              className={`plan-member${m.id === selectionId ? ' is-selected' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(m.id);
              }}
            >
              <span className="plan-member-label" title={m.label}>
                {m.label}
              </span>
              <span className="plan-group-load">{fmt(m.workload)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function WaveCard(props: {
  wave: PlanWave;
  timeUnit: string;
  selectionId: string | null;
  onSelect: (id: string) => void;
}): JSX.Element {
  const { wave, timeUnit, selectionId, onSelect } = props;
  const over = wave.utilization > 1;
  return (
    <div className="plan-wave" data-testid="plan-wave">
      <div className="plan-wave-head">
        <div className="plan-wave-title">
          <span>{wave.label}</span>
          <span className="plan-wave-load">
            {fmt(wave.workload)}/{fmt(wave.capacity)} per {timeUnit} ·{' '}
            {Math.round(wave.utilization * 100)}%
          </span>
        </div>
        <div className="plan-util" title={`Utilization ${Math.round(wave.utilization * 100)}%`}>
          <div
            className={`plan-util-fill${over ? ' is-over' : ''}`}
            style={{ width: `${Math.min(100, wave.utilization * 100)}%` }}
          />
        </div>
      </div>
      <div className="plan-wave-groups">
        {wave.groups.map((g) => (
          <GroupRow key={g.id} group={g} selectionId={selectionId} onSelect={onSelect} />
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────────────── ungrouped ───────────────────────────────── */

function UngroupedCallout(props: {
  ungrouped: PlanMember[];
  grouping: PlanGrouping;
  selectionId: string | null;
  onSelect: (id: string) => void;
}): JSX.Element {
  const { ungrouped, grouping, selectionId, onSelect } = props;
  const label = GROUPING_OPTIONS.find((o) => o.value === grouping)?.label ?? grouping;
  return (
    <div className="plan-ungrouped" data-testid="plan-ungrouped">
      <span className="plan-ungrouped-head">
        {ungrouped.length} ungrouped item(s) — no “{label}” association:
      </span>
      {ungrouped.map((m) => (
        <button
          key={m.id}
          data-testid="plan-chip"
          data-element-id={m.id}
          className={`plan-chip${m.id === selectionId ? ' is-selected' : ''}`}
          title={`${m.label} (workload ${fmt(m.workload)})`}
          onClick={() => onSelect(m.id)}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

/* ─────────────────────────────── main view ───────────────────────────────── */

export function PlanningView(): JSX.Element {
  const plan = useAppStore((s) => s.plan);
  const config = useAppStore((s) => s.planConfig);
  const selectionId = useAppStore((s) => s.selectionId);
  const select = useAppStore((s) => s.select);
  const setPlanConfig = useAppStore((s) => s.setPlanConfig);
  const set = (patch: Partial<PlanConfig>) => setPlanConfig(patch);

  if (!plan) {
    return (
      <div className="plan-wrap" data-testid="planning-view">
        <div className="center-empty">Building plan…</div>
      </div>
    );
  }

  return (
    <div className="plan-wrap" data-testid="planning-view">
      <ConfigStrip plan={plan} config={config} set={set} />
      <div className="plan-board">
        {plan.waves.length === 0 ? (
          <div className="center-empty">
            No plan waves — no “{config.atomicKind}” element rolls up to a group under the current
            grouping. Pick another atomic kind or grouping.
          </div>
        ) : (
          plan.waves.map((w) => (
            <WaveCard
              key={w.index}
              wave={w}
              timeUnit={plan.timeUnit}
              selectionId={selectionId}
              onSelect={select}
            />
          ))
        )}
      </div>
      {plan.ungrouped.length > 0 && (
        <UngroupedCallout
          ungrouped={plan.ungrouped}
          grouping={config.grouping}
          selectionId={selectionId}
          onSelect={select}
        />
      )}
    </div>
  );
}
