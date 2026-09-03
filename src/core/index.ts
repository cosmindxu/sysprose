/** Public surface of the core model module. */
export * from './metamodel';
export * from './ids';
export { Model, FORMAT_VERSION } from './model';
export type { ChangeEvent, ChangeListener, CreateElementOptions } from './model';
export { ModelFactory, buildSampleModel } from './factory';
export { duplicateSubtree } from './duplicate';
export { resolveTypeInScopeChain, findLibraryType } from './scope';
export { unquoteName, splitQualified, refSegments } from './names';
export { collectSubtrees, pasteSubtrees } from './paste';
export type { ClipboardPayload } from './paste';
