/**
 * The bundled SysML v2 / KerML standard model library.
 *
 * CLEAN-ROOM NOTICE. This is an INDEPENDENT implementation of a faithful subset
 * of the OMG SysML v2 / KerML normative model libraries. The element names and
 * their `:>` specialization hierarchy are the STANDARD's normative interface —
 * defined by the OMG SysML v2 and KerML specifications — which we are entitled
 * to implement. Every declaration, doc comment and line of code here was
 * AUTHORED ORIGINALLY from the specification and the project's own standard
 * reference (docs/02-omg-standard-reference.md). The EPL-2.0
 * `Systems-Modeling/SysML-v2-Release` repository was consulted ONLY to
 * fact-check names and the type/specialization hierarchy; NO source text, code
 * or comments were copied or transcribed from it. See docs/LICENSES.md.
 *
 * Our hand-written textual parser cannot ingest the full normative library
 * grammar (feature chains, invariant bodies, unit conversions, metadata, …), so
 * this module authors the subset PROGRAMMATICALLY as native {@link Model}
 * elements. The packages implemented — with the standard's normative package
 * names — are:
 *
 *   - Base          — the KerML semantic-library roots (Anything, DataValue).
 *   - ScalarValues  — the KerML scalar data-type tower (Boolean/String + the
 *                     Positive→…→Number numeric hierarchy).
 *   - Collections   — the KerML collection data types (Array/Bag/Set/…).
 *   - Quantities    — the quantity-value roots bridging Collections + ScalarValues.
 *   - ISQ           — a curated slice of ISQ scalar quantity kinds.
 *   - SI            — SI unit definitions plus the seven base + common derived units.
 *
 * Fidelity notes:
 *  - The normative libraries use KerML metaclasses (`Classifier`, `DataType`,
 *    `Class`) that this modeler's metamodel does not expose directly. Per the
 *    task brief we map value types to `AttributeDefinition` (SysML's DataType-
 *    style Definition) and the single root classifier `Anything` to
 *    `ItemDefinition` (a general Classifier-style Definition). Concrete SI units
 *    (`metre`, `kilogram`, …) are `attribute` USAGES, so they are modeled as
 *    `AttributeUsage` typed (FeatureTyping) by their unit Definition.
 *  - The normative libs express `:>` between definitions as Subclassification
 *    and typing (`:`) as FeatureTyping — created here via
 *    {@link ModelFactory.subclassification} / {@link ModelFactory.featureTyping}.
 *  - Anything uncertain / adapted is flagged inline with an `[adapted]` note.
 *
 * Every element created here (packages, definitions, usages AND the reified
 * relationship elements) is marked `attrs.isLibrary = true` and its id is
 * returned from {@link loadStandardLibrary}.
 */

import { Model, ModelFactory, type ElementId } from '@core/index';

/** Metaclasses we instantiate for library content. */
type LibKind = 'ItemDefinition' | 'AttributeDefinition' | 'AttributeUsage';

/** A single library type/usage declaration. */
interface TypeSpec {
  /** declaredName (unique within its package). */
  name: string;
  /** declaredShortName / symbol alias, e.g. metre `<m>`. */
  short?: string;
  /** Metaclass; defaults to 'AttributeDefinition' (DataType-style). */
  eClass?: LibKind;
  /** KerML `abstract` marker (recorded as attrs.isAbstract). */
  abstract?: boolean;
  /**
   * General types this element specialises via `:>` (Subclassification).
   * Each ref is a qualified `Package::Name` or a simple `Name`.
   */
  specializes?: string[];
  /** For unit usages: the unit Definition this usage is typed by (`:`). */
  typedBy?: string;
  /** Free-form provenance/adaptation note (kept on attrs.libNote). */
  note?: string;
}

/** A library package and its members. */
interface PackageSpec {
  name: string;
  short?: string;
  types: TypeSpec[];
}

/* ─────────────────────────── the library data ──────────────────────────── */

/**
 * The faithful subset, package by package. Refs in `specializes`/`typedBy` are
 * resolved after all elements exist, so declaration order is irrelevant.
 */
const LIBRARY: PackageSpec[] = [
  // KerML Semantic Library — the two roots every other type bottoms out in.
  {
    name: 'Base',
    types: [
      {
        name: 'Anything',
        eClass: 'ItemDefinition',
        abstract: true,
        note: 'KerML root Classifier; mapped to ItemDefinition (no plain Classifier kind).',
      },
      { name: 'DataValue', abstract: true, specializes: ['Base::Anything'] },
    ],
  },

  // KerML Data Type Library — ScalarValues. The numeric tower is the headline
  // hierarchy: Positive :> Natural :> Integer :> Rational :> Real :> Complex :>
  // Number :> NumericalValue :> ScalarValue :> DataValue.
  {
    name: 'ScalarValues',
    types: [
      { name: 'ScalarValue', abstract: true, specializes: ['Base::DataValue'] },
      { name: 'Boolean', specializes: ['ScalarValue'] },
      { name: 'String', specializes: ['ScalarValue'] },
      { name: 'NumericalValue', abstract: true, specializes: ['ScalarValue'] },
      { name: 'Number', abstract: true, specializes: ['NumericalValue'] },
      { name: 'Complex', specializes: ['Number'] },
      { name: 'Real', specializes: ['Complex'] },
      { name: 'Rational', specializes: ['Real'] },
      { name: 'Integer', specializes: ['Rational'] },
      { name: 'Natural', specializes: ['Integer'] },
      { name: 'Positive', specializes: ['Natural'] },
    ],
  },

  // KerML Data Type Library — Collections.
  {
    name: 'Collections',
    types: [
      { name: 'Collection', abstract: true },
      { name: 'OrderedCollection', abstract: true, specializes: ['Collection'] },
      { name: 'UniqueCollection', abstract: true, specializes: ['Collection'] },
      { name: 'Array', specializes: ['OrderedCollection'] },
      { name: 'Bag', specializes: ['Collection'] },
      { name: 'Set', specializes: ['UniqueCollection'] },
      { name: 'OrderedSet', specializes: ['OrderedCollection', 'UniqueCollection'] },
      { name: 'List', specializes: ['OrderedCollection'] },
    ],
  },

  // Quantities — the roots of the quantity-value tower. ScalarQuantityValue is
  // the base every ISQ quantity kind specialises, and it bridges Collections
  // (via Array) and ScalarValues (via NumericalValue).
  {
    name: 'Quantities',
    types: [
      {
        name: 'TensorQuantityValue',
        abstract: true,
        specializes: ['Collections::Array'],
        note: 'Normative alias: QuantityValue.',
      },
      { name: 'VectorQuantityValue', abstract: true, specializes: ['TensorQuantityValue'] },
      {
        name: 'ScalarQuantityValue',
        abstract: true,
        specializes: ['VectorQuantityValue', 'ScalarValues::NumericalValue'],
      },
    ],
  },

  // ISQ — a curated slice of quantity kinds (all scalar), each :> ScalarQuantityValue.
  {
    name: 'ISQ',
    types: [
      { name: 'LengthValue', specializes: ['Quantities::ScalarQuantityValue'] },
      { name: 'MassValue', specializes: ['Quantities::ScalarQuantityValue'] },
      { name: 'DurationValue', specializes: ['Quantities::ScalarQuantityValue'] },
      {
        name: 'TimeValue',
        specializes: ['DurationValue'],
        note: '[adapted] normative ISQ declares `alias TimeValue for DurationValue`; modeled as a specialization since this metamodel has no alias construct.',
      },
      { name: 'ThermodynamicTemperatureValue', specializes: ['Quantities::ScalarQuantityValue'] },
      {
        name: 'TemperatureValue',
        specializes: ['ThermodynamicTemperatureValue'],
        note: '[adapted] convenience name (not a normative ISQ declaration); specializes ThermodynamicTemperatureValue.',
      },
      { name: 'ElectricCurrentValue', specializes: ['Quantities::ScalarQuantityValue'] },
      { name: 'AmountOfSubstanceValue', specializes: ['Quantities::ScalarQuantityValue'] },
      { name: 'LuminousIntensityValue', specializes: ['Quantities::ScalarQuantityValue'] },
      { name: 'SpeedValue', specializes: ['Quantities::ScalarQuantityValue'] },
      { name: 'AccelerationValue', specializes: ['Quantities::ScalarQuantityValue'] },
      { name: 'AreaValue', specializes: ['Quantities::ScalarQuantityValue'] },
      { name: 'VolumeValue', specializes: ['Quantities::ScalarQuantityValue'] },
      { name: 'AngularVelocityValue', specializes: ['Quantities::ScalarQuantityValue'] },
      { name: 'ForceValue', specializes: ['Quantities::ScalarQuantityValue'] },
      { name: 'EnergyValue', specializes: ['Quantities::ScalarQuantityValue'] },
      { name: 'PowerValue', specializes: ['Quantities::ScalarQuantityValue'] },
      { name: 'PressureValue', specializes: ['Quantities::ScalarQuantityValue'] },
      { name: 'MomentumValue', specializes: ['Quantities::ScalarQuantityValue'] },
      { name: 'FrequencyValue', specializes: ['Quantities::ScalarQuantityValue'] },
    ],
  },

  // SI — unit Definitions plus the seven base + a few derived concrete units.
  // Concrete units are `attribute` USAGES typed by their unit Definition.
  {
    name: 'SI',
    types: [
      // Unit definitions. MeasurementUnit is the shared abstract root.
      {
        name: 'MeasurementUnit',
        abstract: true,
        note: '[adapted] shared abstract root for the SI unit definitions below (the normative libs root units in MeasurementReferences::Unit).',
      },
      { name: 'LengthUnit', specializes: ['MeasurementUnit'] },
      { name: 'MassUnit', specializes: ['MeasurementUnit'] },
      { name: 'DurationUnit', specializes: ['MeasurementUnit'] },
      { name: 'ElectricCurrentUnit', specializes: ['MeasurementUnit'] },
      { name: 'ThermodynamicTemperatureUnit', specializes: ['MeasurementUnit'] },
      { name: 'AmountOfSubstanceUnit', specializes: ['MeasurementUnit'] },
      { name: 'LuminousIntensityUnit', specializes: ['MeasurementUnit'] },
      { name: 'ForceUnit', specializes: ['MeasurementUnit'] },
      { name: 'EnergyUnit', specializes: ['MeasurementUnit'] },
      { name: 'PowerUnit', specializes: ['MeasurementUnit'] },
      { name: 'PressureUnit', specializes: ['MeasurementUnit'] },
      { name: 'FrequencyUnit', specializes: ['MeasurementUnit'] },

      // The seven SI base units.
      { name: 'metre', short: 'm', eClass: 'AttributeUsage', typedBy: 'LengthUnit' },
      { name: 'gram', short: 'g', eClass: 'AttributeUsage', typedBy: 'MassUnit' },
      {
        name: 'kilogram',
        short: 'kg',
        eClass: 'AttributeUsage',
        typedBy: 'MassUnit',
        note: 'SI base mass unit; normatively the kilo-prefixed gram.',
      },
      { name: 'second', short: 's', eClass: 'AttributeUsage', typedBy: 'DurationUnit' },
      { name: 'ampere', short: 'A', eClass: 'AttributeUsage', typedBy: 'ElectricCurrentUnit' },
      { name: 'kelvin', short: 'K', eClass: 'AttributeUsage', typedBy: 'ThermodynamicTemperatureUnit' },
      { name: 'mole', short: 'mol', eClass: 'AttributeUsage', typedBy: 'AmountOfSubstanceUnit' },
      { name: 'candela', short: 'cd', eClass: 'AttributeUsage', typedBy: 'LuminousIntensityUnit' },

      // A few common coherent derived units.
      { name: 'newton', short: 'N', eClass: 'AttributeUsage', typedBy: 'ForceUnit' },
      { name: 'joule', short: 'J', eClass: 'AttributeUsage', typedBy: 'EnergyUnit' },
      { name: 'watt', short: 'W', eClass: 'AttributeUsage', typedBy: 'PowerUnit' },
      { name: 'pascal', short: 'Pa', eClass: 'AttributeUsage', typedBy: 'PressureUnit' },
      { name: 'hertz', short: 'Hz', eClass: 'AttributeUsage', typedBy: 'FrequencyUnit' },
    ],
  },
];

/** The set of package names authored by this module (declaration order). */
export const STANDARD_LIBRARY_PACKAGE_NAMES: string[] = LIBRARY.map((p) => p.name);

/** Alias emphasising that these are the CURATED (subset) package names. */
export const CURATED_LIBRARY_PACKAGE_NAMES: string[] = STANDARD_LIBRARY_PACKAGE_NAMES;

/* ─────────────────────────────── loader ────────────────────────────────── */

/** Options for {@link buildCuratedLibrary}. */
export interface LoadStandardLibraryOptions {
  /** If given, load only these packages (by name); otherwise load all. */
  packages?: string[];
}

/** Last `::`-segment of a (possibly qualified) reference. */
function lastSegment(ref: string): string {
  const parts = ref.split('::');
  return parts[parts.length - 1].trim();
}

/**
 * Author the CURATED standard library into `model`, creating 'LibraryPackage'
 * roots and their contents as Definitions/Usages with correct names and
 * specialization relationships. Every created element (including reified
 * relationships) is marked `attrs.isLibrary = true`.
 *
 * This is the small, hand-authored subset used as the fallback when the full
 * bundled library ({@link ../full-library}) is unavailable, and for focused
 * unit tests. The default runtime loader ({@link ../index}.loadStandardLibrary)
 * prefers the full library and falls back to this builder.
 *
 * @returns the ids of every element created, in creation order.
 */
export function buildCuratedLibrary(
  model: Model,
  opts: LoadStandardLibraryOptions = {},
): ElementId[] {
  const factory = new ModelFactory(model);
  const wanted = opts.packages ? new Set(opts.packages) : undefined;
  const packages = LIBRARY.filter((p) => !wanted || wanted.has(p.name));

  const createdIds: ElementId[] = [];
  // Resolution indices for specialization/typing refs.
  const byQName = new Map<string, ElementId>(); // "Pkg::Name" → id
  const byName = new Map<string, ElementId>(); // "Name" → id (first wins)
  // Deferred specialization work applied once all elements exist.
  const links: Array<{ id: ElementId; kind: 'sub' | 'type'; refs: string[] }> = [];

  model.transaction(() => {
    for (const pkg of packages) {
      const pkgEl = model.create('LibraryPackage', {
        declaredName: pkg.name,
        declaredShortName: pkg.short,
        attrs: { isLibrary: true },
      });
      createdIds.push(pkgEl.id);

      for (const t of pkg.types) {
        const attrs: Record<string, string | boolean> = { isLibrary: true };
        if (t.abstract) attrs.isAbstract = true;
        if (t.note) attrs.libNote = t.note;
        const el = model.create(t.eClass ?? 'AttributeDefinition', {
          declaredName: t.name,
          declaredShortName: t.short,
          ownerId: pkgEl.id,
          attrs,
        });
        createdIds.push(el.id);

        const qname = `${pkg.name}::${t.name}`;
        byQName.set(qname, el.id);
        if (!byName.has(t.name)) byName.set(t.name, el.id);
        if (t.short && !byName.has(t.short)) byName.set(t.short, el.id);

        if (t.specializes?.length) links.push({ id: el.id, kind: 'sub', refs: t.specializes });
        if (t.typedBy) links.push({ id: el.id, kind: 'type', refs: [t.typedBy] });
      }
    }

    // Resolve a ref to a created id: exact qualified name, else simple last segment.
    const resolve = (ref: string): ElementId | undefined =>
      byQName.get(ref) ?? byName.get(lastSegment(ref));

    for (const link of links) {
      for (const ref of link.refs) {
        const targetId = resolve(ref);
        if (!targetId) continue; // target package not in this load; skip silently.
        const rel =
          link.kind === 'sub'
            ? factory.subclassification(link.id, targetId)
            : factory.featureTyping(link.id, targetId);
        model.setAttrs(rel.id, { isLibrary: true });
        createdIds.push(rel.id);
      }
    }
  });

  return createdIds;
}

/**
 * Backwards-compatible alias for {@link buildCuratedLibrary}: authors the
 * curated library subset into `model`. Used as the runtime fallback when the
 * full bundled library cannot be loaded.
 */
export const loadCuratedLibrary = buildCuratedLibrary;
