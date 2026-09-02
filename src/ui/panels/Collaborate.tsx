/**
 * Collaborate — the real-time multi-user presence affordance.
 *
 * A single toolbar button (`tb-collab`) toggles an inline popover holding a room
 * input, Connect / Disconnect, a live connection-status indicator, and a
 * presence roster. The roster lists this client ("You") plus every remote peer,
 * each as a `collab-peer` row carrying `data-clientid` + name and a colour dot —
 * so the E2E can assert the participant count and each peer's colour.
 *
 * All state flows through {@link useAppStore}: `collab.connected/room/self/peers`
 * are read here; `connectCollab` / `disconnectCollab` drive the Yjs transport.
 * Nothing here imports the Node-only relay — the browser client is `../store`'s
 * `../collab` barrel (WebsocketProvider + awareness).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store';

export function Collaborate(): JSX.Element {
  const collab = useAppStore((s) => s.collab);
  const connectCollab = useAppStore((s) => s.connectCollab);
  const disconnectCollab = useAppStore((s) => s.disconnectCollab);

  const [open, setOpen] = useState(false);
  const [room, setRoom] = useState(collab.room || 'room-1');
  const wrapRef = useRef<HTMLDivElement>(null);

  // Keep the input in sync when the store's room changes (e.g. URL auto-connect).
  useEffect(() => {
    if (collab.room) setRoom(collab.room);
  }, [collab.room]);

  // Close the popover on an outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const onConnect = useCallback(() => {
    connectCollab(room.trim() || 'room-1');
  }, [connectCollab, room]);

  // Total participants = self + remote peers (drives the "N present" badge).
  const participants = collab.peers.length + 1;

  return (
    <div className="toolbar-collab" ref={wrapRef} style={{ position: 'relative' }}>
      <button
        data-testid="tb-collab"
        className={collab.connected ? 'is-active' : ''}
        onClick={() => setOpen((o) => !o)}
        title="Real-time collaboration"
      >
        <span
          className="collab-indicator"
          data-connected={collab.connected}
          style={{ background: collab.connected ? '#3cb44b' : 'var(--text-muted, #888)' }}
        />
        Collaborate
        {collab.connected ? ` (${participants})` : ''}
      </button>

      {open && (
        <div className="collab-panel" data-testid="collab-panel">
          <div className="collab-panel-title">Real-time collaboration</div>

          <label className="collab-field">
            <span>Room</span>
            <input
              data-testid="collab-room"
              className="collab-room-input"
              value={room}
              placeholder="room name"
              disabled={collab.connected}
              onChange={(e) => setRoom(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !collab.connected) onConnect();
              }}
            />
          </label>

          <div className="collab-actions">
            <button
              data-testid="collab-connect"
              onClick={onConnect}
              disabled={collab.connected}
              title="Join the room"
            >
              Connect
            </button>
            <button
              data-testid="collab-disconnect"
              onClick={() => disconnectCollab()}
              disabled={!collab.connected}
              title="Leave the room"
            >
              Disconnect
            </button>
          </div>

          <div
            data-testid="collab-status"
            className={`collab-status ${collab.connected ? 'is-connected' : 'is-disconnected'}`}
            data-connected={collab.connected}
            data-room={collab.connected ? collab.room : ''}
          >
            {collab.connected ? `Connected to "${collab.room}"` : 'Disconnected'}
          </div>

          <div className="collab-presence">
            <div className="collab-presence-title">Present ({participants})</div>

            {/* This client. */}
            <div
              className="collab-peer collab-peer-self"
              data-testid="collab-peer"
              data-clientid="self"
              data-self="true"
            >
              <span className="collab-dot" style={{ background: collab.self.color }} />
              <span className="collab-peer-name">{collab.self.name}</span>
              <span className="collab-peer-you">you</span>
            </div>

            {/* Remote peers. */}
            {collab.peers.map((p) => (
              <div
                key={p.clientId}
                className="collab-peer"
                data-testid="collab-peer"
                data-clientid={p.clientId}
              >
                <span className="collab-dot" style={{ background: p.color }} />
                <span className="collab-peer-name">{p.name}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default Collaborate;
