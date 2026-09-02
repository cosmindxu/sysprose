import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import {
  Awareness,
  encodeAwarenessUpdate,
  applyAwarenessUpdate,
} from 'y-protocols/awareness';
import { colorForClient, setLocalSelection, readPeers } from '../../src/collab/provider';

/**
 * Finding H20: the collab provider had zero unit tests. The transport (`connect`)
 * is E2E-only (needs a live WebSocket relay), so these cover the pure presence
 * helpers against an in-memory Yjs {@link Awareness} — no transport required.
 */
describe('collab provider — presence helpers (H20)', () => {
  it('colorForClient is deterministic, palette-bounded, and negative-safe', () => {
    expect(colorForClient(0)).toBe(colorForClient(0));
    expect(colorForClient(0)).not.toBe(colorForClient(1));
    // Wraps the 10-colour palette and never returns undefined.
    expect(colorForClient(10)).toBe(colorForClient(0));
    expect(colorForClient(-7)).toBe(colorForClient(7));
    for (const id of [0, 5, 9, 10, 123, -4]) {
      expect(typeof colorForClient(id)).toBe('string');
      expect(colorForClient(id)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('setLocalSelection publishes the selection to the local awareness state', () => {
    const doc = new Y.Doc();
    const aw = new Awareness(doc);
    setLocalSelection(aw, 'el-42');
    expect(aw.getLocalState()?.selection).toBe('el-42');
    setLocalSelection(aw, null);
    expect(aw.getLocalState()?.selection).toBe(null);
    aw.destroy();
  });

  it('readPeers excludes the local client', () => {
    const doc = new Y.Doc();
    const aw = new Awareness(doc);
    aw.setLocalStateField('user', { name: 'Me', color: '#000000' });
    expect(readPeers(aw)).toEqual([]);
    aw.destroy();
  });

  it('readPeers surfaces a remote peer with its user + selection, sorted', () => {
    const docLocal = new Y.Doc();
    const awLocal = new Awareness(docLocal);
    awLocal.setLocalStateField('user', { name: 'Local', color: '#111111' });

    // A second client whose state we sync into the local awareness.
    const docRemote = new Y.Doc();
    const awRemote = new Awareness(docRemote);
    awRemote.setLocalStateField('user', { name: 'Bob', color: '#e6194b' });
    awRemote.setLocalStateField('selection', 'el-7');

    const update = encodeAwarenessUpdate(awRemote, [awRemote.clientID]);
    applyAwarenessUpdate(awLocal, update, 'test');

    const peers = readPeers(awLocal);
    expect(peers).toHaveLength(1);
    expect(peers[0].clientId).toBe(awRemote.clientID);
    expect(peers[0].name).toBe('Bob');
    expect(peers[0].color).toBe('#e6194b');
    expect(peers[0].selection).toBe('el-7');

    awLocal.destroy();
    awRemote.destroy();
  });

  it('readPeers falls back to a generated name/color for a peer with no user', () => {
    const docLocal = new Y.Doc();
    const awLocal = new Awareness(docLocal);
    const docRemote = new Y.Doc();
    const awRemote = new Awareness(docRemote);
    // Remote sets only a selection, no user identity.
    awRemote.setLocalStateField('selection', null);

    applyAwarenessUpdate(
      awLocal,
      encodeAwarenessUpdate(awRemote, [awRemote.clientID]),
      'test',
    );

    const peers = readPeers(awLocal);
    expect(peers).toHaveLength(1);
    expect(peers[0].name).toBe(`user-${awRemote.clientID}`);
    expect(peers[0].color).toBe(colorForClient(awRemote.clientID));

    awLocal.destroy();
    awRemote.destroy();
  });
});
