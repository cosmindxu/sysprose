/**
 * Generate an FMI 3.0 `modelDescription.xml` from a SysML v2 block (a part
 * definition/usage), mapping its interface to FMI model variables.
 *
 * Mapping (SysML → FMI):
 *  - the block itself           → the FMU model (modelName / modelIdentifier);
 *  - a feature's `attrs.direction` `in`/`out`  → causality `input`/`output`;
 *    `inout` → `local` (FMI has no bidirectional causality);
 *  - a directionless AttributeUsage → `parameter` (a fixed design value);
 *  - a directionless PortUsage      → `local`;
 *  - the feature's declared type    → FMI type (Real→Float64, Integer→Int64,
 *    Boolean→Boolean, String→String; default Float64);
 *  - `attrs.value`                  → the variable `start`;
 *  - the feature's unit (via {@link dimensionalFacets}) → a Unit definition +
 *    the variable's `unit` reference, with an SI {@link BaseUnit} when the
 *    dimension is known.
 *
 * Pure and DOM-free (string generation only), so it is exhaustively unit-testable
 * and runs in the browser. This is the description half of an FMU; {@link
 * exportFmu} packages it into the `.fmu` zip.
 */

import { type ElementId, type ElementRecord, type Model } from '@core/index';
import { evaluateFeatureValue } from '@semantics/index';
import { dimensionalFacets } from '@semantics/units-eval';
import type { Dimension } from '@semantics/units';
import { PRODUCT_NAME } from '../../branding';

/** An FMI scalar type this exporter emits. */
export type FmiType = 'Float64' | 'Int64' | 'Boolean' | 'String';

/** One FMI model variable derived from a SysML feature. */
export interface FmiVariable {
  /** Source SysML feature id. */
  featureId: ElementId;
  name: string;
  valueReference: number;
  type: FmiType;
  causality: 'parameter' | 'input' | 'output' | 'local';
  variability: 'fixed' | 'continuous' | 'discrete';
  /** Start value (always present for parameter/input; omitted for calculated outputs). */
  start?: string;
  /** Explicit `initial` — set to `exact` only for a `local` that carries a start. */
  initial?: 'exact';
  /** Referenced Unit name (Float64 only). */
  unit?: string;
  description?: string;
}

/** A distinct unit used by some variable, with its SI base exponents when known. */
export interface FmiUnit {
  name: string;
  dimension?: Dimension;
}

/** The generated FMI model description plus the structured data behind it. */
export interface FmiModelDescription {
  modelName: string;
  modelIdentifier: string;
  variables: FmiVariable[];
  units: FmiUnit[];
  xml: string;
}

/** Options for {@link fmiModelDescription}. */
export interface FmiExportOptions {
  /** Overrides the generation timestamp (ISO string) for deterministic output. */
  generationDate?: string;
}

/* ────────────────────────────── mapping ─────────────────────────────── */

/**
 * The feature's declared type name — the parser's pre-resolution `attrs.type` /
 * `attrs.typeRef` string first (a text-loaded `attribute n : Integer` before name
 * resolution), then a resolved FeatureTyping's declaredName.
 */
function declaredTypeName(model: Model, feat: ElementRecord): string {
  const attrType = feat.attrs.type ?? feat.attrs.typeRef;
  if (typeof attrType === 'string' && attrType.trim() !== '') return attrType.trim();
  return model.typesOf(feat.id)[0]?.declaredName ?? '';
}

const INT_TYPE_NAMES = new Set([
  'integer', 'natural', 'positive', 'count',
  'int', 'int8', 'int16', 'int32', 'int64',
  'uint', 'uint8', 'uint16', 'uint32', 'uint64',
]);

/** FMI type for a feature, from its declared type name (default Float64). */
function fmiTypeOf(model: Model, feat: ElementRecord): FmiType {
  // Last qualified-name segment, lowercased (e.g. `ScalarValues::Integer` → integer).
  const name = declaredTypeName(model, feat).split(/[:.]/).pop()!.trim().toLowerCase();
  if (name === 'boolean' || name === 'bool') return 'Boolean';
  if (name === 'string' || name === 'text') return 'String';
  if (INT_TYPE_NAMES.has(name)) return 'Int64';
  return 'Float64'; // Real / Number / unknown → the safe numeric default
}

/** Format a feature's value as an FMI `start` string for the given type, or undefined. */
function startOf(model: Model, feat: ElementRecord, type: FmiType): string | undefined {
  const r = evaluateFeatureValue(model, feat.id);
  if (!('value' in r)) return undefined;
  const v = r.value;
  if (type === 'Boolean') return v === true ? 'true' : v === false ? 'false' : undefined;
  if (type === 'String') return typeof v === 'string' ? v : undefined;
  if (typeof v === 'number' && Number.isFinite(v)) {
    return type === 'Int64' ? String(Math.round(v)) : String(v); // Int64 start must be integral
  }
  if (typeof v === 'boolean') return v ? '1' : '0';
  return undefined;
}

/** A type-appropriate default start (FMI requires one for parameter/input). */
function defaultStart(type: FmiType): string {
  return type === 'Boolean' ? 'false' : type === 'String' ? '' : '0';
}

/** The causality of a feature from its direction + metaclass. */
function causalityOf(feat: ElementRecord): FmiVariable['causality'] {
  const dir = feat.attrs.direction;
  if (dir === 'in') return 'input';
  if (dir === 'out') return 'output';
  if (dir === 'inout') return 'local';
  // Directionless: a plain attribute is a fixed parameter; a port is a local.
  return feat.eClass === 'AttributeUsage' ? 'parameter' : 'local';
}

/** The FMI variability for a (type, causality) pair. */
function variabilityOf(type: FmiType, causality: FmiVariable['causality']): FmiVariable['variability'] {
  if (causality === 'parameter') return 'fixed';
  return type === 'Float64' ? 'continuous' : 'discrete';
}

/** Interface features of a block: its direct Attribute/Port usages. */
function interfaceFeatures(model: Model, blockId: ElementId): ElementRecord[] {
  return model
    .children(blockId)
    .filter((c) => c.eClass === 'AttributeUsage' || c.eClass === 'PortUsage');
}

/**
 * Build the FMI variables for a block, assigning sequential value references.
 */
export function fmiVariablesOf(model: Model, blockId: ElementId): FmiVariable[] {
  const out: FmiVariable[] = [];
  let vr = 0;
  const seen = new Set<string>();
  for (const feat of interfaceFeatures(model, blockId)) {
    const rawName = feat.declaredName?.trim() || feat.declaredShortName?.trim();
    if (!rawName) continue;
    // FMI variable names must be unique; suffix collisions deterministically.
    let name = rawName;
    let i = 2;
    while (seen.has(name)) name = `${rawName}_${i++}`;
    seen.add(name);

    const type = fmiTypeOf(model, feat);
    const causality = causalityOf(feat);
    const variability = variabilityOf(type, causality);
    // FMI 3.0: outputs are calculated (no start); parameter & input REQUIRE a
    // start (fall back to a type default); a local carries a start only when the
    // feature has a value, and then needs an explicit initial="exact".
    let start = causality === 'output' ? undefined : startOf(model, feat, type);
    if (start === undefined && (causality === 'parameter' || causality === 'input')) {
      start = defaultStart(type);
    }
    const initial = causality === 'local' && start !== undefined ? ('exact' as const) : undefined;
    const unit =
      type === 'Float64' ? dimensionalFacets(model, feat.id).unit ?? undefined : undefined;
    out.push({
      featureId: feat.id,
      name,
      valueReference: vr++,
      type,
      causality,
      variability,
      start,
      initial,
      unit,
      description: feat.declaredShortName || undefined,
    });
  }
  return out;
}

/* ─────────────────────────── XML generation ──────────────────────────── */

/** Escape a string for an XML attribute/text node. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A valid C identifier for the FMI modelIdentifier (used as the binary name). */
function toIdentifier(name: string): string {
  let id = name.replace(/[^A-Za-z0-9_]/g, '_');
  if (id === '' || /^[0-9]/.test(id)) id = `_${id}`;
  return id;
}

/** SI base-unit exponents → FMI `<BaseUnit>` attributes (omit zero exponents). */
function baseUnitAttrs(dim: Dimension): string {
  const map: Array<[keyof Dimension, string]> = [
    ['M', 'kg'],
    ['L', 'm'],
    ['T', 's'],
    ['I', 'A'],
    ['Th', 'K'],
    ['N', 'mol'],
    ['J', 'cd'],
  ];
  const parts: string[] = [];
  for (const [k, attr] of map) {
    const e = dim[k];
    if (e) parts.push(`${attr}="${e}"`);
  }
  return parts.join(' ');
}

/**
 * Generate the FMI 3.0 `modelDescription.xml` for the block `blockId`.
 */
export function fmiModelDescription(
  model: Model,
  blockId: ElementId,
  opts: FmiExportOptions = {},
): FmiModelDescription {
  const block = model.get(blockId);
  const modelName = block?.declaredName?.trim() || model.qualifiedName(blockId) || 'Model';
  const modelIdentifier = toIdentifier(modelName);
  const variables = fmiVariablesOf(model, blockId);

  // Distinct units + their dimensions (for UnitDefinitions).
  const unitMap = new Map<string, FmiUnit>();
  for (const v of variables) {
    if (!v.unit || unitMap.has(v.unit)) continue;
    const dim = dimensionalFacets(model, v.featureId).unitDimension;
    unitMap.set(v.unit, { name: v.unit, dimension: dim ?? undefined });
  }
  const units = [...unitMap.values()];

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    `<fmiModelDescription fmiVersion="3.0" modelName="${xmlEscape(modelName)}" ` +
      `instantiationToken="{sysml:${xmlEscape(blockId)}}" ` +
      `generationTool="${PRODUCT_NAME}"` +
      (opts.generationDate ? ` generationDateAndTime="${xmlEscape(opts.generationDate)}"` : '') +
      `>`,
  );
  lines.push(
    `  <CoSimulation modelIdentifier="${xmlEscape(modelIdentifier)}" ` +
      `canHandleVariableCommunicationStepSize="true"/>`,
  );

  if (units.length > 0) {
    lines.push('  <UnitDefinitions>');
    for (const u of units) {
      const attrs = u.dimension ? baseUnitAttrs(u.dimension) : '';
      if (attrs) {
        lines.push(`    <Unit name="${xmlEscape(u.name)}"><BaseUnit ${attrs}/></Unit>`);
      } else {
        lines.push(`    <Unit name="${xmlEscape(u.name)}"/>`);
      }
    }
    lines.push('  </UnitDefinitions>');
  }

  lines.push('  <ModelVariables>');
  for (const v of variables) {
    const attrs = [
      `name="${xmlEscape(v.name)}"`,
      `valueReference="${v.valueReference}"`,
      `causality="${v.causality}"`,
      `variability="${v.variability}"`,
    ];
    if (v.initial) attrs.push(`initial="${v.initial}"`);
    if (v.description) attrs.push(`description="${xmlEscape(v.description)}"`);
    if (v.start !== undefined) attrs.push(`start="${xmlEscape(v.start)}"`);
    if (v.unit) attrs.push(`unit="${xmlEscape(v.unit)}"`);
    lines.push(`    <${v.type} ${attrs.join(' ')}/>`);
  }
  lines.push('  </ModelVariables>');

  // ModelStructure: every output is an Output and an initial unknown.
  const outputs = variables.filter((v) => v.causality === 'output');
  lines.push('  <ModelStructure>');
  for (const v of outputs) lines.push(`    <Output valueReference="${v.valueReference}"/>`);
  for (const v of outputs) lines.push(`    <InitialUnknown valueReference="${v.valueReference}"/>`);
  lines.push('  </ModelStructure>');

  lines.push('</fmiModelDescription>');

  return { modelName, modelIdentifier, variables, units, xml: lines.join('\n') + '\n' };
}
