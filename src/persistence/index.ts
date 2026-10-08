/**
 * Public surface of the persistence + import/export module.
 *
 * - Stores: {@link InMemoryStore}, {@link LocalStorageStore},
 *   {@link IndexedDBStore} behind the {@link ProjectStore} interface, plus
 *   {@link createDefaultStore} to pick the best available backend.
 * - Import/export: {@link exportModel}/{@link importModel} across
 *   `'model-json'`, `'sysml'` and `'api-json'` formats.
 * - Browser helpers: {@link downloadText}, {@link openTextFile}.
 * - Google Drive (optional): config, links, hosts, the Drive gateway and its
 *   errors, the script loader, sign-in and the Picker from `./drive`.
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
export { detectFormat, exportModel, importModel } from './io';

export type { OpenedFile } from './file';
export { downloadText, downloadBytes, openTextFile, MIME_BY_EXTENSION } from './file';

export type {
  DocsViewLike,
  DriveAccount,
  DriveAuth,
  DriveConfig,
  DriveFileRef,
  DriveFileMeta,
  DriveGateway,
  DriveGatewayCall,
  DriveGatewayOp,
  DrivePicked,
  DrivePicker,
  DriveSession,
  DriveSignInPrompt,
  FakeDriveAuthCall,
  FakeDrivePickerCall,
  GapiNs,
  GisTokenResponse,
  GoogleNs,
  GooglePickerNs,
  PickerBuilderLike,
  ScriptLoader,
} from './drive';
export {
  DRIVE_API_ORIGIN,
  DRIVE_CONFIG_TIMEOUT_MS,
  DRIVE_DOWNLOAD_MAX_BYTES,
  DRIVE_FIELDS,
  DRIVE_FILE_ID,
  DRIVE_HOSTS,
  DRIVE_PICKER_MIME_TYPES,
  DRIVE_REASON,
  DRIVE_RESOURCE_KEY,
  DRIVE_RETRY_AFTER_MAX_MS,
  DRIVE_REVOKE_TIMEOUT_MS,
  DRIVE_REVOKE_URL,
  DRIVE_SCOPE,
  DRIVE_SCRIPTS,
  DRIVE_SCRIPT_TIMEOUT_MS,
  DRIVE_TIMEOUT_MS,
  DRIVE_TOKEN_MARGIN_MS,
  DRIVE_UPLOAD_MAX_BYTES,
  DRIVE_UPLOAD_TIMEOUT_MS,
  DRIVE_WEB_ORIGINS,
  DriveAuthError,
  DriveBadResponseError,
  DriveError,
  DriveForbiddenError,
  DriveNetworkError,
  DriveNotFoundError,
  DriveRateLimitError,
  FakeDriveAuth,
  FakeDrivePicker,
  InMemoryDriveGateway,
  buildMultipart,
  createGisPopupAuth,
  createGooglePicker,
  createRestDriveGateway,
  createScriptLoader,
  driveDeepLink,
  driveErrorFor,
  driveErrorMessage,
  driveLinkFromUrl,
  driveWebViewLink,
  isDriveFileMeta,
  loadDriveConfig,
  loadScriptOnce,
  multipartBoundary,
  parseDriveConfig,
  parseDriveFileRef,
} from './drive';
