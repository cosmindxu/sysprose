# Bundled SysML v2 / KerML Standard Model Library (converted)

This directory holds the **full** OMG SysML v2 / KerML standard model library,
converted into this project's serialized-model JSON. It **replaces** the small
curated library previously authored in `src/library/standard-library.ts`.

> **License:** the contents of this directory are **EPL-2.0** (see `LICENSE` and
> `NOTICE`). This is the only EPL-licensed part of the repository; everything
> else is MIT. See `docs/LICENSES.md`.

## Files

| File | What it is |
|------|------------|
| `stdlib.json` | A `SerializedModel` (`{ formatVersion, generator, elements, rootIds }`) valid for `Model.fromJSON`. Every element carries `attrs.isLibrary === true`. |
| `manifest.json` | Provenance: `{ sourceRepo, commit, generatedFromCount, emittedElementCount, packages[] }`. |
| `LICENSE` | The full Eclipse Public License v2.0 text. |
| `NOTICE` | Attribution to the upstream copyright holders + statement that this is converted model data. |

## Provenance

Converted by `scripts/build-stdlib.ts` from the machine-readable (XMI) form of
the standard library in
[`Systems-Modeling/SysML-v2-Release`](https://github.com/Systems-Modeling/SysML-v2-Release),
at commit **`ee25530ed24b8c93a0e3e4b8d5fbfaa5a8d8ffb4`** (see `manifest.json`
for the exact recorded commit and counts). The upstream `sysml.library.xmi/`
tree contains the Kernel Libraries, the Systems Library and the Domain
Libraries (`*.kermlx`, `*.sysmlx`, `*.xmi`).

## Conversion scope

The converter emits the **structural type library** and its type hierarchy:

- **Emitted as nodes:** every `Package` / `LibraryPackage`, `Definition`,
  `Usage`, `Feature`, `DataType`, `Classifier`, `Class`, `Structure`,
  `Behavior`, `Function`, `Step`, `Association`, `Metaclass`, etc. — anything
  that is not a relationship or an omitted body element (below).
- **Emitted as relationships (with `source`/`target`):** the specialization
  family — `Subclassification`, `Subsetting`, `Redefinition`, `FeatureTyping`,
  `ReferenceSubsetting`, `Conjugation`, `Specialization`.
- **Flattened (not emitted):** containment/annotation link relationships
  (`*Membership`, `*Import`, `Annotation`, `FeatureValue`, `FeatureChaining`,
  …). Containment is denormalized onto each element's `ownerId`; the anonymous
  root `Namespace` wrapper of each file is dropped so its member packages become
  model roots.
- **Omitted:** documentation/comment prose (`Documentation`, `Comment`,
  `TextualRepresentation`) and the expression/literal/multiplicity computation
  machinery that forms function/constraint **bodies** (`OperatorExpression`,
  `LiteralInteger`, `MultiplicityRange`, …). These are runtime **semantics** for
  a later increment, not needed for name/type resolution, and omitting them
  keeps the bundle compact.

Ids are namespaced with a `stdlib:` prefix to avoid collisions with user-model
ids. Cross-file references (`href="…#uuid"`) resolve by their globally-unique
`xmi:id` fragment.

## Name resolution note

`Model.resolveQualifiedName` walks **strict containment** only. A name like
`ScalarValues::Real`, `SI::metre`, `Collections::List` or `Base::Anything`
resolves directly because those members are owned by their package. A few names
that the standard exposes through a package's **public namespace import** — e.g.
`ISQ::MassValue`, whose definition is actually owned by `ISQBase` and
re-exported by `ISQ` — do **not** resolve through strict `resolveQualifiedName`
(it does not follow imports), but they **do** resolve through
`findLibraryType` (this project's library resolver), which falls back to a
last-segment match, and they resolve strictly under their owning package
(`ISQBase::MassValue`).

## Regenerating

```sh
# 1. Clone the source repo to a scratch dir OUTSIDE this project.
git clone --depth 1 https://github.com/Systems-Modeling/SysML-v2-Release ~/.stdlib-src

# 2. Run the converter (writes stdlib.json + manifest.json here).
npx tsx scripts/build-stdlib.ts ~/.stdlib-src src/library/std
```

The cloned EPL source repository must **not** be committed into this tree — only
the derived JSON, the converter script, and these license files are bundled.
