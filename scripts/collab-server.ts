/**
 * Yjs collaboration RELAY server — NODE-ONLY.
 *
 * A self-contained y-websocket relay (the y-websocket 3.x package no longer
 * ships `bin/utils`, so we hand-roll the y-protocols sync + awareness relay).
 * One shared {@link Y.Doc} + {@link Awareness} per room; updates are broadcast
 * to every other connection in the same room. It never persists to disk — it is
 * a pure fan-out relay (clients keep their own state via y-indexeddb).
 *
 * ⚠️ This file imports "ws" and is therefore NEVER reachable from the browser
 * bundle. Run it with:  npm run collab   (i.e. `tsx scripts/collab-server.ts`).
 *
 * Env: PORT (default 1234), HOST (default 127.0.0.1 — loopback; set 0.0.0.0 to
 * expose), COLLAB_ALLOW_ORIGIN (comma-separated browser Origin allowlist).
 */

import http from 'http';
import { WebSocketServer, type WebSocket } from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import { PRODUCT_NAME } from '../src/branding';

const PORT = Number(process.env.PORT ?? 1234);
// Bind loopback by default — the relay is unauthenticated, so exposing it on
// 0.0.0.0 lets any reachable client join/mutate/exfiltrate a shared doc. Set
// HOST=0.0.0.0 explicitly (behind an allowlist) to open it up.
const HOST = process.env.HOST ?? '127.0.0.1';
// Comma-separated Origin allowlist for the WS upgrade. Empty ⇒ same-host only
// (browsers send an Origin header; non-browser clients omit it and are allowed).
const ALLOWED_ORIGINS = (process.env.COLLAB_ALLOW_ORIGIN ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
/** Cap a single WS frame to 10 MiB (ws defaults to 100 MiB). */
const MAX_PAYLOAD = 10 * 1024 * 1024;

/** Wire message type tags — MUST match the y-websocket client. */
const messageSync = 0;
const messageAwareness = 1;
const messageQueryAwareness = 3;

const PING_TIMEOUT = 30000;

/**
 * Cap the number of concurrent rooms and per-room connections (finding M4) so an
 * unauthenticated client cannot exhaust server memory by opening unbounded rooms
 * or flooding one room. Empty rooms are already dropped on the last disconnect,
 * and dead connections are evicted by the ping/pong below; these caps bound the
 * live footprint. Override via env for larger deployments.
 */
const MAX_ROOMS = Number(process.env.COLLAB_MAX_ROOMS ?? 512);
const MAX_CONNS_PER_ROOM = Number(process.env.COLLAB_MAX_CONNS_PER_ROOM ?? 256);
/** Optional shared secret; when set, clients must connect with `?token=<token>`. */
const COLLAB_TOKEN = process.env.COLLAB_TOKEN ?? '';

/** A shared document for a single room, plus its connected sockets. */
class WSSharedDoc extends Y.Doc {
  name: string;
  awareness: awarenessProtocol.Awareness;
  /** conn → set of awareness client ids controlled by that conn. */
  conns = new Map<WebSocket, Set<number>>();

  constructor(name: string) {
    super({ gc: true });
    this.name = name;
    this.awareness = new awarenessProtocol.Awareness(this);
    this.awareness.setLocalState(null);

    this.awareness.on(
      'update',
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        const changed = added.concat(updated, removed);
        if (origin instanceof Object && this.conns.has(origin as WebSocket)) {
          const controlled = this.conns.get(origin as WebSocket)!;
          for (const id of added) controlled.add(id);
          for (const id of removed) controlled.delete(id);
        }
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, messageAwareness);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed),
        );
        const buf = encoding.toUint8Array(encoder);
        for (const c of this.conns.keys()) send(this, c, buf);
      },
    );

    this.on('update', (update: Uint8Array, origin: unknown) => {
      // Broadcast structural updates to every connection (origin included is
      // harmless — Yjs applies idempotently — but we skip the emitter).
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageSync);
      syncProtocol.writeUpdate(encoder, update);
      const buf = encoding.toUint8Array(encoder);
      for (const c of this.conns.keys()) {
        if (c !== origin) send(this, c, buf);
      }
    });
  }
}

const docs = new Map<string, WSSharedDoc>();

function getDoc(name: string): WSSharedDoc | undefined {
  let doc = docs.get(name);
  if (!doc) {
    if (docs.size >= MAX_ROOMS) return undefined; // room cap reached
    doc = new WSSharedDoc(name);
    docs.set(name, doc);
  }
  return doc;
}

function send(doc: WSSharedDoc, conn: WebSocket, message: Uint8Array): void {
  if (conn.readyState !== conn.OPEN && conn.readyState !== conn.CONNECTING) {
    closeConn(doc, conn);
    return;
  }
  try {
    conn.send(message, (err) => {
      if (err) closeConn(doc, conn);
    });
  } catch {
    closeConn(doc, conn);
  }
}

function closeConn(doc: WSSharedDoc, conn: WebSocket): void {
  const controlled = doc.conns.get(conn);
  if (controlled) {
    doc.conns.delete(conn);
    awarenessProtocol.removeAwarenessStates(doc.awareness, [...controlled], null);
    if (doc.conns.size === 0) {
      // Room is empty — drop it so memory doesn't grow unbounded.
      doc.destroy();
      docs.delete(doc.name);
    }
  }
  try {
    conn.close();
  } catch {
    /* ignore */
  }
}

function onMessage(conn: WebSocket, doc: WSSharedDoc, message: Uint8Array): void {
  try {
    const encoder = encoding.createEncoder();
    const decoder = decoding.createDecoder(message);
    const messageType = decoding.readVarUint(decoder);
    switch (messageType) {
      case messageSync: {
        encoding.writeVarUint(encoder, messageSync);
        syncProtocol.readSyncMessage(decoder, encoder, doc, conn);
        // If the reply has content beyond the type tag, send it back.
        if (encoding.length(encoder) > 1) send(doc, conn, encoding.toUint8Array(encoder));
        break;
      }
      case messageAwareness: {
        awarenessProtocol.applyAwarenessUpdate(
          doc.awareness,
          decoding.readVarUint8Array(decoder),
          conn,
        );
        break;
      }
      case messageQueryAwareness: {
        encoding.writeVarUint(encoder, messageAwareness);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(
            doc.awareness,
            [...doc.awareness.getStates().keys()],
          ),
        );
        send(doc, conn, encoding.toUint8Array(encoder));
        break;
      }
      default:
        break;
    }
  } catch (err) {
    console.error('[collab] message error', err);
  }
}

function setupConnection(conn: WebSocket, req: http.IncomingMessage): void {
  conn.binaryType = 'arraybuffer';
  const url = req.url ?? '/';
  // Opt-in shared-secret auth: OFF by default (loopback + Origin allowlist).
  // When COLLAB_TOKEN is set, the client must connect with `?token=<token>`
  // (browsers can't set WS headers, so a query param is the practical channel).
  if (COLLAB_TOKEN) {
    const q = url.includes('?') ? new URLSearchParams(url.slice(url.indexOf('?') + 1)) : null;
    if (q?.get('token') !== COLLAB_TOKEN) {
      try {
        conn.close(1008, 'unauthorized'); // 1008 = policy violation
      } catch {
        /* ignore */
      }
      return;
    }
  }
  const rawRoom = url.slice(1).split('?')[0];
  let roomName = 'default';
  try {
    roomName = decodeURIComponent(rawRoom) || 'default';
  } catch {
    // Malformed %-escape — fall back to the raw segment rather than crashing.
    roomName = rawRoom || 'default';
  }
  const doc = getDoc(roomName);
  if (!doc) {
    // Server-wide room cap reached — refuse politely (1013 = Try Again Later).
    try {
      conn.close(1013, 'server room limit reached');
    } catch {
      /* ignore */
    }
    return;
  }
  if (doc.conns.size >= MAX_CONNS_PER_ROOM) {
    try {
      conn.close(1013, 'room connection limit reached');
    } catch {
      /* ignore */
    }
    return;
  }
  doc.conns.set(conn, new Set());

  conn.on('message', (data: ArrayBuffer | Buffer) =>
    onMessage(conn, doc, new Uint8Array(data as ArrayBuffer)),
  );

  // Liveness ping/pong.
  let alive = true;
  const pingInterval = setInterval(() => {
    if (!alive) {
      closeConn(doc, conn);
      clearInterval(pingInterval);
      return;
    }
    if (doc.conns.has(conn)) {
      alive = false;
      try {
        conn.ping();
      } catch {
        closeConn(doc, conn);
        clearInterval(pingInterval);
      }
    }
  }, PING_TIMEOUT);
  conn.on('pong', () => {
    alive = true;
  });

  conn.on('close', () => {
    closeConn(doc, conn);
    clearInterval(pingInterval);
  });

  // 1) Send SyncStep1 (our state vector) so the client can reconcile.
  {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageSync);
    syncProtocol.writeSyncStep1(encoder, doc);
    send(doc, conn, encoding.toUint8Array(encoder));
  }
  // 2) Send current awareness snapshot.
  const states = doc.awareness.getStates();
  if (states.size > 0) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageAwareness);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(doc.awareness, [...states.keys()]),
    );
    send(doc, conn, encoding.toUint8Array(encoder));
  }
}

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`${PRODUCT_NAME} collab relay — OK\n`);
});

const wss = new WebSocketServer({
  server,
  maxPayload: MAX_PAYLOAD,
  verifyClient: ({ origin }: { origin?: string }) => {
    // No Origin header ⇒ a non-browser client (e.g. a native tool); allow.
    if (!origin) return true;
    if (ALLOWED_ORIGINS.length === 0) return true;
    return ALLOWED_ORIGINS.includes(origin);
  },
});
wss.on('connection', setupConnection);

server.listen(PORT, HOST, () => {
  console.log(`[collab] relay listening on ws://${HOST}:${PORT}`);
});

const shutdown = () => {
  console.log('[collab] shutting down');
  wss.close();
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
