/**
 * FMI (Functional Mock-up Interface, https://fmi-standard.org/) interop — export
 * a SysML v2 block as an FMI 3.0 FMU description / archive.
 */

export {
  fmiModelDescription,
  fmiVariablesOf,
  type FmiType,
  type FmiVariable,
  type FmiUnit,
  type FmiModelDescription,
  type FmiExportOptions,
} from './model-description';
export { exportFmu, type FmuExport } from './export';
export { zipStore, unzipStored, crc32, type ZipEntry } from './zip';
export {
  parseModelDescription,
  importFmiBlock,
  importFmiXml,
  readModelDescriptionFromFmu,
  type FmiParsedModel,
  type FmiImportedVariable,
} from './import';
export {
  CoSimMaster,
  sysmlBlockInstance,
  analyticFmu,
  type Fmi3Instance,
  type CoSimConnection,
  type CoSimSample,
  type CoSimTrace,
  type AnalyticSpec,
} from './cosim';
