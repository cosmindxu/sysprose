/**
 * Shared helpers for the cross-module pipeline integration tests.
 *
 * These tests import the REAL module barrels (@core, @text, @validation, @api,
 * @diagram) and exercise them end-to-end against the on-disk example model,
 * read from the filesystem with Node `fs` exactly as a CLI/automation client
 * would.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export { signatures, elementSetDiffs } from './helpers';

/**
 * Absolute path to the shipped example. Vitest runs with the project root as
 * the working directory, so we resolve the example from there.
 */
export const VEHICLE_PATH = resolve(process.cwd(), 'examples/vehicle.sysml');

/** Read the example SysML v2 source from disk (no caching — fresh each call). */
export function readVehicleSource(): string {
  return readFileSync(VEHICLE_PATH, 'utf8');
}
