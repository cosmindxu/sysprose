/**
 * Google Drive (optional) — public surface.
 *
 * - Shapes and constants: {@link DriveConfig}, {@link DriveFileRef},
 *   {@link DriveFileMeta}, {@link DRIVE_SCOPE}, {@link DRIVE_FIELDS}.
 * - Hosts: {@link DRIVE_HOSTS}, grouped by CSP directive (the only place a
 *   Google URL is spelled).
 * - Config: {@link parseDriveConfig}, {@link loadDriveConfig} (`drive.json`).
 * - Links: {@link driveLinkFromUrl}, {@link parseDriveFileRef},
 *   {@link driveDeepLink}, {@link driveWebViewLink}.
 * - Drive itself: {@link DriveGateway} — {@link createRestDriveGateway} over
 *   the REST API, {@link InMemoryDriveGateway} for tests — and the
 *   {@link DriveError} classes every call rejects with.
 * - Google's scripts: {@link loadScriptOnce}, which loads the two of
 *   {@link DRIVE_SCRIPTS} and nothing else.
 * - Sign-in: {@link DriveAuth} — {@link createGisPopupAuth} over Google
 *   Identity Services, {@link FakeDriveAuth} for tests.
 * - The Picker: {@link DrivePicker} — {@link createGooglePicker},
 *   {@link FakeDrivePicker} for tests.
 */

export type { DriveConfig, DriveFileRef, DriveFileMeta, DriveSession } from './types';
export {
  DRIVE_DOWNLOAD_MAX_BYTES,
  DRIVE_FIELDS,
  DRIVE_REASON,
  DRIVE_SCOPE,
  DRIVE_UPLOAD_MAX_BYTES,
  DriveAuthError,
  DriveBadResponseError,
  DriveError,
  DriveForbiddenError,
  DriveNetworkError,
  DriveNotFoundError,
  DriveRateLimitError,
  driveErrorMessage,
} from './types';

export { DRIVE_API_ORIGIN, DRIVE_HOSTS, DRIVE_REVOKE_URL, DRIVE_SCRIPTS, DRIVE_WEB_ORIGINS } from './hosts';

export { DRIVE_CONFIG_TIMEOUT_MS, loadDriveConfig, parseDriveConfig } from './config';

export {
  DRIVE_FILE_ID,
  DRIVE_RESOURCE_KEY,
  driveDeepLink,
  driveLinkFromUrl,
  driveWebViewLink,
  parseDriveFileRef,
} from './links';

export type { DriveAccount, DriveGateway, DriveGatewayCall, DriveGatewayOp } from './gateway';
export {
  DRIVE_RETRY_AFTER_MAX_MS,
  DRIVE_TIMEOUT_MS,
  DRIVE_UPLOAD_TIMEOUT_MS,
  InMemoryDriveGateway,
  buildMultipart,
  createRestDriveGateway,
  driveErrorFor,
  isDriveFileMeta,
  multipartBoundary,
} from './gateway';

export type { ScriptLoader } from './loader';
export { DRIVE_SCRIPT_TIMEOUT_MS, createScriptLoader, loadScriptOnce } from './loader';

export type { DriveAuth, DriveSignInPrompt, FakeDriveAuthCall, GisTokenResponse, GoogleNs } from './auth';
export { DRIVE_REVOKE_TIMEOUT_MS, DRIVE_TOKEN_MARGIN_MS, FakeDriveAuth, createGisPopupAuth } from './auth';

export type {
  DocsViewLike,
  DrivePicked,
  DrivePicker,
  FakeDrivePickerCall,
  GapiNs,
  GooglePickerNs,
  PickerBuilderLike,
} from './picker';
export { DRIVE_PICKER_MIME_TYPES, FakeDrivePicker, createGooglePicker } from './picker';
