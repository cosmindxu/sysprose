/**
 * Public surface of the persistence + import/export module.
 *
 * - Stores: {@link InMemoryStore}, {@link LocalStorageStore},
 *   {@link IndexedDBStore} behind the {@link ProjectStore} interface, plus
 *   {@link createDefaultStore} to pick the best available backend.
 * - Import/export: {@link exportModel}/{@link importModel} across
 *   `'model-json'`, `'sysml'` and `'api-json'` formats.
 * - Browser helpers: {@link downloadText}, {@link openTextFile}.
 */

export type { ProjectStore } from './store';
export {
  InMemoryStore,
  LocalStorageStore,
  IndexedDBStore,
  createDefaultStore,
  isLocalStorageAvailable,
  isIndexedDBAvailable,
} from './store';

export type { ModelFormat, ImportResult } from './io';
export { exportModel, importModel } from './io';

export type { OpenedFile } from './file';
export { downloadText, downloadBytes, openTextFile, MIME_BY_EXTENSION } from './file';
