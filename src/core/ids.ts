/** Stable id generation, browser- and Node-safe. */

import type { ElementId } from './metamodel';

/** Monotonic counter guaranteeing uniqueness in the crypto-less fallback path. */
let fallbackCounter = 0;

/** Generate a fresh element id (UUID v4 where available). */
export function newId(): ElementId {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  if (c && typeof c.getRandomValues === 'function') {
    const b = new Uint8Array(16);
    c.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  // Last-resort fallback for environments without any crypto. A monotonic
  // counter guarantees uniqueness (the previous formula returned the SAME id on
  // every call, so the second Model.create threw "id already exists").
  fallbackCounter += 1;
  return `id-${(fallbackCounter).toString(16).padStart(12, '0')}-${Date.now().toString(16)}`;
}

/** A short, human-friendly id fragment for labels/debugging. */
export function shortId(id: ElementId): string {
  return id.replace(/-/g, '').slice(0, 8);
}
