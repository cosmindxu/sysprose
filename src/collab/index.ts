/**
 * Public entrypoint for the browser-safe collaboration client.
 *
 * NOTE: nothing re-exported here imports "ws" or any y-websocket server code,
 * so this module (and everything it pulls in) is safe for the browser bundle.
 * The Node-only relay lives in `scripts/collab-server.ts`.
 */

export { bindModelToDoc, ORIGIN_LOCAL } from './model-doc';
export type { ModelDocBinding } from './model-doc';

export {
  connect,
  setLocalSelection,
  readPeers,
  colorForClient,
} from './provider';
export type {
  CollabConnection,
  CollabUser,
  ConnectOptions,
  Peer,
} from './provider';
