/**
 * Import an FMI 3.0 model description back into a SysML v2 block — the inverse of
 * {@link fmiModelDescription}. Parses a `modelDescription.xml` (or extracts one
 * from a STORED `.fmu` this tool produced) into a block whose ports/attributes
 * mirror the FMU's variables, so an external engine's FMU interface becomes a
 * first-class SysML element (and Phase-4 export → import round-trips).
 *
 * Mapping (FMI → SysML), the inverse of the exporter:
 *  - input/output variable  → a PortUsage with `attrs.direction` in/out;
 *  - parameter              → an AttributeUsage with the start `value`;
 *  - local                  → an AttributeUsage with `direction` inout;
 *  - Float64/Int64/Boolean/String → the SysML type Real/Integer/Boolean/String;
 *  - `start`                → `attrs.value`.
 *
 * The XML parse is a small, dependency-free reader over the well-structured FMI
 * variable elements — no DOMParser, so it runs identically in the browser and in
 * tests. Compressed (DEFLATE) external FMUs are not unzipped here; import their
 * `modelDescription.xml` directly (this tool's own FMUs are STORED and read fine).
 */

import { type AttrValue, type ElementId, type Model } from '@core/index';
import type { FmiType } from './model-description';
import { unzipStored } from './zip';

/** One variable parsed from a model description. */
export interface FmiImportedVariable {
  name: string;
  valueReference: number;
  type: FmiType;
  causality: 'parameter' | 'input' | 'output' | 'local';
  variability?: string;
  start?: string;
  unit?: string;
}

/** A parsed FMI model description. */
export interface FmiParsedModel {
  modelName: string;
  fmiVersion: string;
  variables: FmiImportedVariable[];
  /** True when an `<fmiModelDescription>` root was actually found (real FMI XML). */
  valid: boolean;
}

/** The FMI typed-variable element names this importer understands. */
const TYPE_ELEMENTS: Record<string, FmiType> = {
  Float64: 'Float64',
  Float32: 'Float64',
  Int64: 'Int64',
  Int32: 'Int64',
  Int16: 'Int64',
  Int8: 'Int64',
  UInt64: 'Int64',
  UInt32: 'Int64',
  UInt16: 'Int64',
  UInt8: 'Int64',
  Boolean: 'Boolean',
  String: 'String',
};

/** Decode the XML entity references we emit on export. */
function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Parse the `name="value"` / `name='value'` attributes out of a tag body. */
function parseAttrs(tagBody: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tagBody)) !== null) out[m[1]] = xmlUnescape(m[2] ?? m[3] ?? '');
  return out;
}

/** Normalise a causality string to the four we model (default local). */
function normCausality(c: string | undefined): FmiImportedVariable['causality'] {
  if (c === 'input' || c === 'output' || c === 'parameter' || c === 'local') return c;
  if (c === 'calculatedParameter' || c === 'structuralParameter') return 'parameter';
  return 'local';
}

// A quote-aware run of tag-body characters (a literal `>` inside a quoted value
// is legal XML and must not end the tag), and an optional namespace prefix.
const TAG_BODY = `(?:"[^"]*"|'[^']*'|[^"'>])*`;
const NS = `(?:[\\w.-]+:)?`;

/**
 * Parse an FMI 3.0 `modelDescription.xml` string into a {@link FmiParsedModel}.
 */
export function parseModelDescription(xml: string): FmiParsedModel {
  // Drop comments + CDATA so a variable-shaped tag inside them can't be parsed.
  const clean = xml.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');

  const root = new RegExp(`<${NS}fmiModelDescription\\b(${TAG_BODY})>`).exec(clean);
  const valid = root !== null;
  const rootAttrs = root ? parseAttrs(root[1]) : {};
  const modelName = rootAttrs.modelName?.trim() || 'ImportedFMU';
  const fmiVersion = rootAttrs.fmiVersion || '3.0';

  const section =
    new RegExp(`<${NS}ModelVariables\\b${TAG_BODY}>([\\s\\S]*?)</${NS}ModelVariables>`).exec(clean)?.[1] ??
    '';
  const typeAlt = Object.keys(TYPE_ELEMENTS).join('|');
  const varRe = new RegExp(`<${NS}(${typeAlt})\\b(${TAG_BODY})/?>`, 'g');

  const variables: FmiImportedVariable[] = [];
  const seenVr = new Set<number>();
  const seenName = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = varRe.exec(section)) !== null) {
    const type = TYPE_ELEMENTS[m[1]];
    const a = parseAttrs(m[2]);
    if (!a.name) continue;

    // Unique variable name (two variables can legally share a name in FMI,
    // distinguished by valueReference; SysML sibling features cannot).
    let name = a.name.trim();
    const baseName = name;
    for (let i = 2; seenName.has(name); i++) name = `${baseName}_${i}`;
    seenName.add(name);

    // Collision-safe value reference (fall back to the next unused index).
    const raw = Number(a.valueReference);
    let vr = Number.isFinite(raw) && !seenVr.has(raw) ? raw : variables.length;
    while (seenVr.has(vr)) vr++;
    seenVr.add(vr);

    variables.push({
      name,
      valueReference: vr,
      type,
      causality: normCausality(a.causality),
      variability: a.variability,
      start: a.start,
      unit: a.unit,
    });
  }
  return { modelName, fmiVersion, variables, valid };
}

/* ─────────────────────────── FMI → SysML ─────────────────────────────── */

const SYSML_TYPE: Record<FmiType, string> = {
  Float64: 'Real',
  Int64: 'Integer',
  Boolean: 'Boolean',
  String: 'String',
};

/** Parse an FMI `start` string into a typed SysML attribute value. */
function startValue(type: FmiType, start: string): number | boolean | string | undefined {
  if (type === 'Boolean') return start === 'true' || start === '1';
  if (type === 'String') return start;
  const s = start.trim();
  if (s === '') return undefined; // Number('') is 0 — don't invent a value
  // Keep xs:double specials and exact large integers as their original string.
  if (s === 'INF' || s === '-INF' || s === 'NaN') return s;
  const n = Number(s);
  if (type === 'Int64' && Number.isFinite(n) && !Number.isSafeInteger(n)) return s;
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Create a SysML block (PartDefinition) for a parsed FMI model under `ownerId`,
 * with a Port/Attribute usage per variable, and return the new block's id.
 */
export function importFmiBlock(
  model: Model,
  parsed: FmiParsedModel,
  ownerId: ElementId | null = null,
): ElementId {
  const block = model.create('PartDefinition', { declaredName: parsed.modelName, ownerId });
  for (const v of parsed.variables) {
    const type = SYSML_TYPE[v.type];
    const value = v.start !== undefined ? startValue(v.type, v.start) : undefined;
    if (v.causality === 'input' || v.causality === 'output') {
      const attrs: Record<string, AttrValue> = { direction: v.causality === 'input' ? 'in' : 'out', type, valueReference: v.valueReference };
      if (value !== undefined) attrs.value = value;
      if (v.unit) attrs.unit = v.unit;
      model.create('PortUsage', { ownerId: block.id, declaredName: v.name, attrs });
    } else {
      const attrs: Record<string, AttrValue> = { type, valueReference: v.valueReference };
      if (value !== undefined) attrs.value = value;
      if (v.causality === 'local') attrs.direction = 'inout';
      if (v.unit) attrs.unit = v.unit;
      model.create('AttributeUsage', { ownerId: block.id, declaredName: v.name, attrs });
    }
  }
  return block.id;
}

/**
 * Convenience: parse `modelDescription.xml` and import it as a block in one call.
 */
export function importFmiXml(model: Model, xml: string, ownerId: ElementId | null = null): ElementId {
  return importFmiBlock(model, parseModelDescription(xml), ownerId);
}

/**
 * Extract `modelDescription.xml` from a STORED `.fmu` archive (as produced by
 * {@link exportFmu}). Throws for a compressed (external) FMU — import its
 * `modelDescription.xml` directly instead.
 */
export function readModelDescriptionFromFmu(bytes: Uint8Array): string {
  const entries = unzipStored(bytes);
  const md = entries['modelDescription.xml'];
  if (!md) throw new Error('modelDescription.xml not found in the FMU archive.');
  return new TextDecoder().decode(md);
}
