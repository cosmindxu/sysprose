/**
 * {@link connect} — wire a {@link Y.Doc} to the collaboration transport.
 *
 * BROWSER-SAFE. Uses:
 *   - {@link WebsocketProvider} from 'y-websocket' (native `WebSocket`, no `ws`)
 *   - {@link IndexeddbPersistence} from 'y-indexeddb' (offline cache; only when
 *     `indexedDB` exists — e.g. skipped under Node/SSR)
 *   - {@link Awareness} from 'y-protocols/awareness' (presence: user + selection)
 *
 * This module MUST NOT import "ws" or any y-websocket server code — that would
 * pull Node-only code into the browser bundle.
 */

import type * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';
import { Awareness } from 'y-protocols/awareness';
import type { ElementId } from '../core/metamodel';

/** Identity of the local collaborator. */
export interface CollabUser {
  name: string;
  /** CSS colour for cursors/badges. Auto-derived from the client id if absent. */
  color?: string;
}

export interface ConnectOptions {
  /** WebSocket relay base URL, e.g. `ws://localhost:1234`. */
  url: string;
  /** Room / document name (collaborators sharing this string sync together). */
  room: string;
  /** The local user's presence identity. */
  user: CollabUser;
}

/** Live connection handle returned by {@link connect}. */
export interface CollabConnection {
  provider: WebsocketProvider;
  awareness: Awareness;
  persistence: IndexeddbPersistence | null;
  /** Tear down the transport (and awareness/persistence). */
  disconnect(): void;
}

/** A peer as surfaced to the UI. */
export interface Peer {
  clientId: number;
  name: string;
  color: string;
  selection: ElementId | null;
}

const PALETTE = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
  '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#469990',
];

/** Deterministic colour for a client id (used when the user has none). */
export function colorForClient(clientId: number): string {
  return PALETTE[Math.abs(clientId) % PALETTE.length];
}

export function connect(doc: Y.Doc, opts: ConnectOptions): CollabConnection {
  const awareness = new Awareness(doc);
  awareness.setLocalStateField('user', {
    name: opts.user.name,
    color: opts.user.color ?? colorForClient(doc.clientID),
  });
  awareness.setLocalStateField('selection', null);

  const provider = new WebsocketProvider(opts.url, opts.room, doc, {
    awareness,
    connect: true,
  });

  let persistence: IndexeddbPersistence | null = null;
  const hasIdb =
    typeof globalThis !== 'undefined' &&
    typeof (globalThis as { indexedDB?: unknown }).indexedDB !== 'undefined';
  if (hasIdb) {
    persistence = new IndexeddbPersistence(opts.room, doc);
  }

  return {
    provider,
    awareness,
    persistence,
    disconnect() {
      try {
        provider.disconnect();
        provider.destroy();
      } catch {
        /* ignore */
      }
      if (persistence) {
        try {
          persistence.destroy();
        } catch {
          /* ignore */
        }
      }
      awareness.destroy();
    },
  };
}

/** Publish the local user's current selection to peers. */
export function setLocalSelection(awareness: Awareness, elementId: ElementId | null): void {
  awareness.setLocalStateField('selection', elementId);
}

/** Read the current set of REMOTE peers (excludes the local client). */
export function readPeers(awareness: Awareness): Peer[] {
  const peers: Peer[] = [];
  const localId = awareness.clientID;
  for (const [clientId, state] of awareness.getStates().entries()) {
    if (clientId === localId) continue;
    const user = (state?.user ?? {}) as { name?: string; color?: string };
    peers.push({
      clientId,
      name: user.name ?? `user-${clientId}`,
      color: user.color ?? colorForClient(clientId),
      selection: (state?.selection ?? null) as ElementId | null,
    });
  }
  return peers.sort((a, b) => a.clientId - b.clientId);
}
