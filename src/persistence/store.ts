/**
 * Project persistence stores.
 *
 * A {@link ProjectStore} is a tiny key/value abstraction over a model snapshot
 * ({@link SerializedModel}, the shape produced by `Model.toJSON()`). Three
 * implementations are provided — {@link InMemoryStore} (volatile, always
 * available), {@link LocalStorageStore} (synchronous web storage) and
 * {@link IndexedDBStore} (asynchronous, larger capacity) — plus
 * {@link createDefaultStore} which picks the best one available in the current
 * environment (indexedDB → localStorage → memory).
 *
 * All implementations are dependency-free and guard every browser API so the
 * module imports cleanly under Node (e.g. for unit tests and SSR).
 */

import type { SerializedModel } from '@core/index';
import { LEGACY_STORAGE_DB } from '../branding';

/**
 * Persists named model snapshots. The unit of storage is a
 * {@link SerializedModel} (plain JSON), so a store never needs to know about
 * the live {@link Model} class.
 */
export interface ProjectStore {
  /** Create or overwrite the project named `name`. */
  saveProject(name: string, data: SerializedModel): Promise<void>;
  /** Load a project, or `null` when no project with that name exists. */
  loadProject(name: string): Promise<SerializedModel | null>;
  /** Names of all stored projects (unordered). */
  listProjects(): Promise<string[]>;
  /** Remove a project; a no-op when it does not exist. */
  deleteProject(name: string): Promise<void>;
}

/** Deep-clone a JSON-safe value (so stored snapshots never alias live data). */
function clone<T>(value: T): T {
  const sc = (globalThis as { structuredClone?: <U>(v: U) => U }).structuredClone;
  if (typeof sc === 'function') return sc(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

/* ─────────────────────────────── In-memory ──────────────────────────────── */

/**
 * Volatile store backed by an in-process {@link Map}. Always available; used as
 * the final fallback and ideal for unit tests. Snapshots are deep-cloned on the
 * way in and out so callers cannot mutate stored state by reference.
 */
export class InMemoryStore implements ProjectStore {
  private readonly projects = new Map<string, SerializedModel>();

  async saveProject(name: string, data: SerializedModel): Promise<void> {
    this.projects.set(name, clone(data));
  }

  async loadProject(name: string): Promise<SerializedModel | null> {
    const data = this.projects.get(name);
    return data ? clone(data) : null;
  }

  async listProjects(): Promise<string[]> {
    return [...this.projects.keys()];
  }

  async deleteProject(name: string): Promise<void> {
    this.projects.delete(name);
  }
}

/* ───────────────────────────── localStorage ─────────────────────────────── */

/** True when a usable `localStorage` is reachable in this environment. */
export function isLocalStorageAvailable(): boolean {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (!ls) return false;
    const probe = '__sysml_probe__';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * Store backed by the Web Storage `localStorage` API. Each project is one key
 * (`{prefix}{name}`); the snapshot is JSON-serialised. Capacity is browser
 * limited (~5 MB) but ample for PoC-sized models.
 */
export class LocalStorageStore implements ProjectStore {
  private readonly prefix: string;

  constructor(prefix = 'sysml.project.') {
    this.prefix = prefix;
  }

  private get storage(): Storage {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (!ls) throw new Error('localStorage is not available in this environment');
    return ls;
  }

  private key(name: string): string {
    return this.prefix + name;
  }

  async saveProject(name: string, data: SerializedModel): Promise<void> {
    this.storage.setItem(this.key(name), JSON.stringify(data));
  }

  async loadProject(name: string): Promise<SerializedModel | null> {
    const raw = this.storage.getItem(this.key(name));
    if (raw === null) return null;
    return JSON.parse(raw) as SerializedModel;
  }

  async listProjects(): Promise<string[]> {
    const out: string[] = [];
    const s = this.storage;
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k && k.startsWith(this.prefix)) out.push(k.slice(this.prefix.length));
    }
    return out;
  }

  async deleteProject(name: string): Promise<void> {
    this.storage.removeItem(this.key(name));
  }
}

/* ────────────────────────────── IndexedDB ───────────────────────────────── */

/** True when an `indexedDB` factory is reachable in this environment. */
export function isIndexedDBAvailable(): boolean {
  try {
    return typeof (globalThis as { indexedDB?: IDBFactory }).indexedDB !== 'undefined' &&
      (globalThis as { indexedDB?: IDBFactory }).indexedDB !== null;
  } catch {
    return false;
  }
}

/** Promisify an {@link IDBRequest}. */
function _reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Store backed by IndexedDB. A single object store (`STORE_NAME`) maps project
 * name → snapshot. Implemented with a minimal promise wrapper and no external
 * dependencies. Skipped by unit tests (jsdom lacks indexedDB) and exercised via
 * E2E; guarded so construction never throws when indexedDB is missing.
 */
export class IndexedDBStore implements ProjectStore {
  private static readonly STORE_NAME = 'projects';
  private readonly dbName: string;
  private readonly version = 1;
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(dbName = LEGACY_STORAGE_DB) {
    this.dbName = dbName;
  }

  private get factory(): IDBFactory {
    const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    if (!idb) throw new Error('indexedDB is not available in this environment');
    return idb;
  }

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const req = this.factory.open(this.dbName, this.version);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IndexedDBStore.STORE_NAME)) {
          db.createObjectStore(IndexedDBStore.STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbPromise;
  }

  private async tx<T>(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(IndexedDBStore.STORE_NAME, mode);
      const store = transaction.objectStore(IndexedDBStore.STORE_NAME);
      const req = fn(store);
      transaction.oncomplete = () => resolve(req.result);
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async saveProject(name: string, data: SerializedModel): Promise<void> {
    await this.tx('readwrite', (store) => store.put(clone(data), name));
  }

  async loadProject(name: string): Promise<SerializedModel | null> {
    const result = await this.tx<SerializedModel | undefined>('readonly', (store) =>
      store.get(name),
    );
    return result ?? null;
  }

  async listProjects(): Promise<string[]> {
    const keys = await this.tx<IDBValidKey[]>('readonly', (store) => store.getAllKeys());
    return keys.map((k) => String(k));
  }

  async deleteProject(name: string): Promise<void> {
    await this.tx('readwrite', (store) => store.delete(name));
  }
}

/* ───────────────────────────── Default picker ───────────────────────────── */

/**
 * Pick the best available store for the current environment:
 * IndexedDB → localStorage → in-memory. Pass a `dbName`/`prefix` namespace to
 * isolate projects from other apps on the same origin.
 */
export function createDefaultStore(
  opts: { dbName?: string; prefix?: string } = {},
): ProjectStore {
  if (isIndexedDBAvailable()) return new IndexedDBStore(opts.dbName);
  if (isLocalStorageAvailable()) return new LocalStorageStore(opts.prefix);
  return new InMemoryStore();
}
