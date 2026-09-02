/**
 * SimulationTab — the interactive simulation control surface (Phase 2).
 *
 * Drives the Phase-1 {@link SimulationSession} through the store: pick a state
 * machine, Reset / Step / inject events / auto-Play, scrub a time cursor over the
 * captured trace, and read each sample's clock, active states, fired transitions
 * and live constraint status. A value time-series plot ({@link SimPlot}) and the
 * on-canvas active-state glow (driven by `store.simActiveStates`) animate the run.
 */

import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../store';
import { isSimulatable } from '@semantics/index';
import { SimPlot } from './SimPlot';

/** Play tick interval (ms). */
const PLAY_MS = 650;

export function SimulationTab(): JSX.Element {
  const model = useAppStore((s) => s.model);
  const rev = useAppStore((s) => s.rev);
  const session = useAppStore((s) => s.simSession);
  const trace = useAppStore((s) => s.simTrace);
  const index = useAppStore((s) => s.simIndex);
  const targetId = useAppStore((s) => s.simTargetId);
  const playing = useAppStore((s) => s.simPlaying);
  const simStart = useAppStore((s) => s.simStart);
  const simInject = useAppStore((s) => s.simInject);
  const simAdvance = useAppStore((s) => s.simAdvance);
  const simSeek = useAppStore((s) => s.simSeek);
  const simReset = useAppStore((s) => s.simReset);
  const simSetPlaying = useAppStore((s) => s.simSetPlaying);
  const simSolve = useAppStore((s) => s.simSolve);
  const simSetSolve = useAppStore((s) => s.simSetSolve);
  const simStop = useAppStore((s) => s.simStop);
  const select = useAppStore((s) => s.select);
  const setActiveView = useAppStore((s) => s.setActiveView);

  void rev;

  // Simulatable state machines, outermost only (matches the report selection).
  const machines = useMemo(
    () =>
      model
        .all()
        .filter(
          (e) =>
            e.attrs.isLibrary !== true &&
            isSimulatable(model, e.id) &&
            !model.ancestors(e.id).some((a) => isSimulatable(model, a.id)),
        ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, rev],
  );

  const [pick, setPick] = useState<string>('');
  const pickId = pick || machines[0]?.id || '';
  // Drop a stale explicit pick when its machine is gone (deleted / model replaced).
  useEffect(() => {
    if (pick && !machines.some((m) => m.id === pick)) setPick('');
  }, [machines, pick]);

  // Auto-Play only advances the CLOCK, so it only does anything for a machine with
  // a timed `after(n)` transition; disable it for purely event-driven machines.
  const hasTimed = useMemo(() => {
    if (!targetId) return false;
    return model
      .descendants(targetId)
      .some(
        (d) =>
          d.eClass === 'TransitionUsage' &&
          (d.attrs.after !== undefined || /^\s*after\s*\(/.test(String(d.attrs.trigger ?? ''))),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, targetId, rev]);

  const [event, setEvent] = useState<string>('');
  const [xBy, setXBy] = useState<'index' | 'clock'>('index');
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);

  const sample = trace[index];
  const triggers = session?.triggers ?? [];

  // Every value key seen across the whole trace (for the series toggles).
  const allKeys = useMemo(() => {
    const set = new Set<string>();
    for (const s of trace) {
      for (const k of Object.keys(s.values)) set.add(k);
      for (const k of Object.keys(s.solved)) set.add(k); // parametric-derived series
    }
    return [...set];
  }, [trace]);

  // Reset the plotted-series selection when the target changes.
  useEffect(() => setSelectedKeys([]), [targetId]);
  useEffect(() => {
    setSelectedKeys((prev) =>
      prev.length ? prev.filter((k) => allKeys.includes(k)) : allKeys.slice(0, 4),
    );
  }, [allKeys]);

  // Auto-play: tick advance(1) until complete or the sample cap stops growth.
  useEffect(() => {
    if (!playing || !session) return;
    const timer = setInterval(() => {
      const st = useAppStore.getState();
      const before = st.simTrace.length;
      if (st.simTrace[before - 1]?.complete) {
        st.simSetPlaying(false);
        return;
      }
      st.simAdvance(1);
      if (useAppStore.getState().simTrace.length === before) st.simSetPlaying(false); // cap
    }, PLAY_MS);
    return () => clearInterval(timer);
  }, [playing, session]);

  if (machines.length === 0) {
    return (
      <div className="panel-empty" data-testid="sim-empty">
        No state machine to simulate. Add a state machine (states + transitions) to the model.
      </div>
    );
  }

  const toggleKey = (k: string): void =>
    setSelectedKeys((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));

  const revealState = (id: string): void => {
    select(id);
    setActiveView('state');
  };

  return (
    <div className="sim-tab" data-testid="sim-tab">
      {/* ── setup / teardown ── */}
      <div className="sim-setup">
        <label>
          Machine
          <select
            data-testid="sim-target"
            value={pickId}
            onChange={(e) => setPick(e.currentTarget.value)}
          >
            {machines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.declaredName || `«${m.eClass}»`}
              </option>
            ))}
          </select>
        </label>
        <button type="button" data-testid="sim-start" onClick={() => simStart(pickId)}>
          {session && targetId === pickId ? '↻ Restart' : '▶ Start'}
        </button>
        <label className="sim-solve-toggle" title="Solve the parametric/constraint network each step (derived values track the run)">
          <input
            type="checkbox"
            data-testid="sim-solve"
            checked={simSolve}
            onChange={(e) => simSetSolve(e.currentTarget.checked)}
          />
          Solve parametrics
        </label>
        {session && (
          <button type="button" data-testid="sim-stop" onClick={() => simStop()}>
            ✕ Stop
          </button>
        )}
      </div>

      {!session ? (
        <div className="panel-empty">Pick a state machine and press Start.</div>
      ) : (
        <>
          {/* ── transport ── */}
          <div className="sim-transport" data-testid="sim-transport">
            <button type="button" data-testid="sim-reset" title="Reset to the initial state" onClick={() => simReset()}>
              ⏮ Reset
            </button>
            <button
              type="button"
              data-testid="sim-play"
              className={playing ? 'is-active' : ''}
              aria-pressed={playing}
              disabled={!hasTimed}
              title={
                hasTimed
                  ? playing
                    ? 'Pause'
                    : 'Play (auto-advance the clock)'
                  : 'Event-driven machine — use Inject (Play only advances the clock, which has no timed transition to fire)'
              }
              onClick={() => simSetPlaying(!playing)}
            >
              {playing ? '⏸ Pause' : '▶ Play'}
            </button>
            <button type="button" data-testid="sim-step" title="Advance the clock by 1 tick" onClick={() => simAdvance(1)}>
              ⏭ Step
            </button>
            <span className="sim-sep" />
            <select
              data-testid="sim-event"
              value={event}
              onChange={(e) => setEvent(e.currentTarget.value)}
              disabled={triggers.length === 0}
            >
              <option value="">{triggers.length ? 'event…' : '(no events)'}</option>
              {triggers.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <button
              type="button"
              data-testid="sim-inject"
              disabled={!event}
              title="Inject the selected event"
              onClick={() => event && simInject(event)}
            >
              Inject
            </button>
          </div>

          {/* ── time cursor ── */}
          <div className="sim-cursor-row">
            <input
              type="range"
              data-testid="sim-cursor"
              min={0}
              max={Math.max(0, trace.length - 1)}
              value={index}
              onChange={(e) => simSeek(Number(e.currentTarget.value))}
            />
            <span className="sim-cursor-label">
              sample <b data-testid="sim-index">{index}</b> / {trace.length - 1} · clock{' '}
              <b data-testid="sim-clock">{sample?.clock ?? 0}</b>
              {sample?.complete && (
                <span className="sim-badge sim-badge-done" data-testid="sim-complete">
                  complete
                </span>
              )}
            </span>
          </div>

          {/* ── current sample readout ── */}
          <div className="sim-readout">
            <div className="sim-line">
              <span className="sim-k">Active</span>
              <span className="sim-v" data-testid="sim-active">
                {sample && sample.activeStates.length ? (
                  sample.activeStateNames.map((n, i) => (
                    <button
                      key={sample.activeStates[i]}
                      type="button"
                      className="sim-chip"
                      data-testid="sim-active-chip"
                      onClick={() => revealState(sample.activeStates[i])}
                    >
                      {n || '«state»'}
                    </button>
                  ))
                ) : (
                  <span className="sim-muted">—</span>
                )}
              </span>
            </div>
            {sample && sample.fired.length > 0 && (
              <div className="sim-line">
                <span className="sim-k">Fired</span>
                <span className="sim-v" data-testid="sim-fired">
                  {sample.fired.map((f) => f.trigger || '(completion)').join(', ')}
                </span>
              </div>
            )}
            {sample && sample.constraints.length > 0 && (
              <div className="sim-line">
                <span className="sim-k">Constraints</span>
                <span className="sim-v">
                  {sample.constraints.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className={`sim-chip sim-c-${c.status}`}
                      data-testid="sim-constraint"
                      title={c.expression}
                      onClick={() => select(c.id)}
                    >
                      {(c.name || 'constraint') + ': ' + c.status}
                    </button>
                  ))}
                </span>
              </div>
            )}
          </div>

          {/* ── value time-series ── */}
          {allKeys.length > 0 && (
            <div className="sim-plot-block">
              <div className="sim-series-toggles">
                {allKeys.map((k) => (
                  <label key={k} className="sim-series-toggle">
                    <input
                      type="checkbox"
                      checked={selectedKeys.includes(k)}
                      onChange={() => toggleKey(k)}
                    />
                    {k}
                  </label>
                ))}
                <button
                  type="button"
                  className="sim-x-toggle"
                  data-testid="sim-xby"
                  onClick={() => setXBy((x) => (x === 'index' ? 'clock' : 'index'))}
                  title="Toggle x-axis: sample index vs simulation clock"
                >
                  x: {xBy}
                </button>
              </div>
              <SimPlot
                samples={trace}
                keys={selectedKeys.filter((k) => allKeys.includes(k))}
                xBy={xBy}
                cursor={index}
              />
            </div>
          )}

          {/* ── trace list (click to scrub) ── */}
          <div className="sim-trace" data-testid="sim-trace">
            {trace.map((s) => (
              <div
                key={s.index}
                className={`sim-trace-row${s.index === index ? ' is-current' : ''}`}
                data-testid="sim-trace-row"
                onClick={() => simSeek(s.index)}
              >
                <span className="sim-trace-t">t={s.clock}</span>
                <span className="sim-trace-ev">{s.event ?? (s.index === 0 ? 'init' : '·')}</span>
                <span className="sim-trace-st">{s.activeStateNames.filter(Boolean).join(', ') || '—'}</span>
                {s.fired.length > 0 && (
                  <span className="sim-trace-fired">→ {s.fired.map((f) => f.trigger || '✓').join(',')}</span>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default SimulationTab;
