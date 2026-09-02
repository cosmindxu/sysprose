/**
 * Public surface of the interop module — a clean-room client for the OMG
 * *SysML v2 API & Services* REST protocol. See {@link PilotApiClient}.
 */

export { PilotApiClient, elementsToModel } from './pilot-client';
export type {
  ProjectResource,
  BranchResource,
  CommitResource,
  ChangeRecord,
  PilotApiClientOptions,
  ElementPage,
} from './pilot-client';

// FMI (fmi-standard.org) export — SysML block → FMI 3.0 FMU.
export {
  fmiModelDescription,
  fmiVariablesOf,
  exportFmu,
  zipStore,
  unzipStored,
  crc32,
  parseModelDescription,
  importFmiBlock,
  importFmiXml,
  readModelDescriptionFromFmu,
  type FmiType,
  type FmiVariable,
  type FmiUnit,
  type FmiModelDescription,
  type FmiExportOptions,
  type FmuExport,
  type ZipEntry,
  CoSimMaster,
  sysmlBlockInstance,
  analyticFmu,
  type FmiParsedModel,
  type FmiImportedVariable,
  type Fmi3Instance,
  type CoSimConnection,
  type CoSimSample,
  type CoSimTrace,
  type AnalyticSpec,
} from './fmi/index';
