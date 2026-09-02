# Licensing & Third-Party Sources

## This project

**Sysprose is dual-licensed.** The repository is licensed under the **MIT
License** — all source code, tests and documentation are original works authored
for this project — **EXCEPT the bundled standard model library in
`src/library/std/`, which is licensed under the Eclipse Public License, v2.0
(EPL-2.0)**. That directory contains *converted model data* derived from the
EPL-2.0 `Systems-Modeling/SysML-v2-Release` repository (see
[The bundled full standard model library](#the-bundled-full-standard-model-library-epl-20)
below and `src/library/std/{LICENSE,NOTICE,README.md}`). Everything else is MIT,
except where explicitly attributed below.

**Standards status.** Sysprose is a *candidate* implementation of a SysML v2–style textual notation and an OMG-API-shaped element graph. It is not certified or conformance-tested, and claims no conformance to any OMG specification. SysML® is a registered trademark of the Object Management Group, Inc.; this project is not affiliated with, sponsored by, or endorsed by the OMG.

## The Langium textual grammar (clean-room statement)

The Langium grammar for the SysML v2 textual notation (`src/text/langium/`) is
an **original, clean-room** work authored for this project. It now backs the
**default** `parseModel` (via the `src/text/langium/map-to-model.ts` AST→Model
mapper); the original hand-written recursive-descent parser is preserved
verbatim in `src/text/parser-legacy.ts` as a rollback/reference oracle.

- **Normative source.** The textual notation is the standard's **normative
  interface** — its BNF is defined by the OMG **SysML v2** and **KerML**
  specifications, which anyone is entitled to implement. The grammar rules were
  authored from those specifications and from this project's own engineering
  reference (`docs/02-omg-standard-reference.md`), and to mirror exactly the
  construct/attribute set the legacy parser (`src/text/parser.ts`) already
  produces.
- **No copying.** **No `.langium` grammar text, parser code, or rule text was
  copied or transcribed** from SysIDE / Syside, the OMG SysML v2 pilot
  implementation, or any other repository. Every rule, terminal and comment in
  `src/text/langium/sysml.langium` and the hand-authored `module.ts` was written
  originally for this project. `src/text/langium/generated/` is produced
  mechanically by `langium-cli` from our own grammar. The AST→Model mapper
  (`src/text/langium/map-to-model.ts`) is likewise an original work: it walks the
  generated AST and reproduces the element/attribute shapes of this project's own
  legacy parser — no external mapper/linker code was consulted or copied.
- **Langium.** The [Langium](https://github.com/eclipse-langium/langium) parser
  framework and `langium-cli` are licensed **MIT** (compatible with this MIT
  project); they are used as ordinary build/runtime dependencies.

## The bundled standard model library (clean-room statement)

The bundled standard model library (`src/library/`) is an **INDEPENDENT,
clean-room implementation** of a faithful subset of the OMG **SysML v2** and
**KerML** normative model libraries (`Base`, `ScalarValues`, `Collections`,
`Quantities`, `ISQ`, `SI`).

- **Normative source.** The element **names** and their **type /
  specialization (`:>`) hierarchy** are the *standard's normative interface* —
  defined by the OMG SysML v2 and KerML specifications — which anyone is
  entitled to implement. Our implementation was authored from those
  specifications and from this project's own engineering reference
  (`docs/02-omg-standard-reference.md`). Element names, short-name symbols
  (e.g. the unit symbol `m` for `metre`), and specialization chains follow the
  standard so that references such as `ScalarValues::Real` and `ISQ::MassValue`
  resolve as users expect.
- **No copying.** **No source text, code, comments, documentation or file
  content was copied or transcribed** from any third-party repository. Every
  declaration, data table, doc comment and line of code in `src/library/` was
  written originally for this project.
- **Reference repository consulted only to fact-check.** The
  `Systems-Modeling/SysML-v2-Release` repository is licensed **EPL-2.0**, which
  is **incompatible** with dropping its file text into an MIT-licensed tree.
  That repository was consulted **only** to fact-check names and the
  type/specialization hierarchy against the standard — **nothing was transcribed
  from it**. Its `.kerml` / `.sysml` / XMI library files were not copied in
  whole or in part.
- **Deliberate adaptations.** Where this modeler's pragmatic metamodel lacks a
  KerML construct (e.g. a bare `Classifier` kind, `alias`, or unit-conversion
  machinery), the implementation adapts faithfully and records the adaptation
  inline on the element's `attrs.libNote` (and in the module doc comment). Such
  adaptations are our own design decisions, not reproductions of external text.

## The bundled full standard model library (EPL-2.0)

The directory **`src/library/std/`** bundles the **full** OMG SysML v2 / KerML
standard model library as **converted model data**, and is licensed under the
**Eclipse Public License, v2.0 (EPL-2.0)** — the same license as its upstream
source. This is the **only EPL-licensed part of the repository**; it supersedes
the small curated clean-room library described in the section above for
production type/name resolution.

- **Source.** Derived by `scripts/build-stdlib.ts` from the machine-readable
  (XMI) library tree (`sysml.library.xmi/`) of
  [`Systems-Modeling/SysML-v2-Release`](https://github.com/Systems-Modeling/SysML-v2-Release)
  at commit **`ee25530ed24b8c93a0e3e4b8d5fbfaa5a8d8ffb4`**.
- **Converted, not copied verbatim.** The converter re-serializes the element
  graph (packages, definitions, usages, features, data types, classifiers and
  their specialization-family relationships) into this project's
  `SerializedModel` JSON, flattening containment onto `ownerId` and namespacing
  ids with a `stdlib:` prefix. Documentation/comment prose and
  expression/literal bodies are **not** reproduced. See
  `src/library/std/README.md` for the exact conversion scope and how to
  regenerate.
- **Attribution.** The original KerML/SysML v2 models are copyright the
  respective holders listed in `src/library/std/NOTICE` (California Institute of
  Technology/JPL, DEKonsult, IncQuery Labs, Intercax, Itemis, Mgnite, Model
  Driven Solutions, SAF Consulting, Siemens AG, Twingineer), licensed under
  EPL-2.0. The full license text is in `src/library/std/LICENSE`.
- **Not committed: the source repo.** The cloned EPL source repository is kept
  in a scratch directory outside this tree and is **not** committed; only the
  derived JSON, the converter script, and the license/notice files are bundled.

## The API & Services surface, incl. the OSLC facade (clean-room statement)

The API & Services implementation (`src/api/` — the SDK, Query engine,
analytics, version-controlled repository, REST facade `src/api/rest.ts`, and the
**OSLC PSM facade** `src/api/oslc.ts`) is an **original, clean-room** work
authored for this project from the OMG specifications and this project's own
engineering reference (`docs/02-omg-standard-reference.md`).

- **Normative source.** The OMG **Systems Modeling API & Services** spec defines
  the resource model (Project ▸ Branch/Tag ▸ Commit ▸ Element), the REST/HTTP
  PSM (OpenAPI paths, element-graph JSON, Query language, pagination) and the
  **OSLC PSM** (mirrored as the OASIS *OSLC Systems Modeling Language v2.0*).
  These are the standard's **normative interface**, which anyone is entitled to
  implement. `src/api/oslc.ts` implements a **representative subset** of the
  OSLC PSM — a ServiceProviderCatalog, a ServiceProvider with a query capability
  and creation factory, a minimal `oslc.where` query, and JSON-LD element
  representations — authored from the OSLC Core and OMG specs. It further adds
  the "full-shape" OSLC constructs: **`oslc:ResourceShape`** resources
  (`/oslc/shapes/:type`) whose `oslc:Property` entries carry
  `oslc:propertyDefinition`/`oslc:valueType`/`oslc:occurs`, **delegated
  `oslc:Dialog`s** (creation + selection, `/oslc/dialogs/*`) with
  `oslc:dialog`/`oslc:hintWidth`/`oslc:label`, and an **`oslc:Compact`** UI
  preview (`/oslc/elements/:id?compact` or a compact `Accept`) with
  `dcterms:title`/`oslc:shortTitle`/`oslc:icon`. All are advertised from the
  ServiceProvider (`oslc:resourceShape`/`oslc:creationDialog`/
  `oslc:selectionDialog`/`oslc:queryCapability`) and content-negotiate
  Turtle/RDF-XML/JSON-LD. All shapes were authored from the OSLC Core 3.0
  "Resource Shape", "Delegated Dialogs" and "UI Preview" sections.
- **No copying.** **No source text, code, OpenAPI/YAML, or JSON-LD/shape text
  was copied or transcribed** from `Systems-Modeling/SysML-v2-API-Services`, the
  generated API clients, the OASIS OSLC documents, or any other repository.
  Every route, resource shape and comment was written originally for this
  project.
- **SDK versioning wiring (clean-room).** The `ModelApi` versioning surface
  (`api.repository` plus the `commit`/`history`/`diffWithPrevious`/`createBranch`/
  `tag` convenience methods in `src/api/sdk.ts`) and the minimal "Commit" /
  commit-id history affordance in the UI API console (`src/ui/panels/BottomPanel.tsx`)
  are original works. They are thin ergonomic wrappers over this project's own
  `ProjectRepository` (`src/api/versioning.ts`), which implements the OMG
  Project ▸ Branch/Tag ▸ Commit resource model with deterministic counter-based
  ids. No third-party SDK, client, or UI code was copied or transcribed.
- **RDF serializers + optimistic concurrency (clean-room).** The optional
  Node/Express deployment surface (`src/server/`) adds two original works: (1) a
  dependency-free RDF serializer (`src/server/rdf.ts`) that renders the OSLC
  facade's JSON-LD graph as **Turtle** and **RDF/XML** (content-negotiated on
  `Accept` with a `?format=` override, JSON-LD default), authored from the W3C
  **RDF 1.1 Turtle** and **RDF 1.1 XML Syntax** recommendations and the OSLC
  Core 3.0 "RDF Representations" section; and (2) HTTP optimistic-concurrency +
  multi-user write serialization in `src/server/app.ts` / `src/api/versioning.ts`
  — `ETag` on commit/branch responses, `If-Match`/`baseCommit` conditional commit
  writes returning **409 Conflict** `{ currentHead, expected }` on a stale base
  head (HTTP conditional-request semantics, RFC 9110 §13/§8.8), a **per-project
  write queue** that applies overlapping async commit requests atomically in
  arrival order (no lost updates) while leaving reads and cross-project writes
  unblocked, and a repository-level `StaleHeadError` check-and-advance guard. No
  RDF library or third-party serializer/concurrency code was bundled, copied, or
  transcribed; `express` stays out of the browser bundle.

## Third-party sources

| Source | URL | License | How used |
|--------|-----|---------|----------|
| OMG **SysML v2** specification (v2.0) | <https://www.omg.org/spec/SysML/> | OMG specification terms | Normative source for SysML domain library names & the Definition/Usage hierarchy (implemented, not copied). |
| OMG **KerML** specification (v1.0) | <https://www.omg.org/spec/KerML/> | OMG specification terms | Normative source for the kernel data-type / scalar-value / collections hierarchy (implemented, not copied). |
| OMG **Systems Modeling API & Services** (v1.0) | <https://www.omg.org/spec/SystemsModelingAPI/> | OMG specification terms | Normative source for the resource model, REST/HTTP PSM & Query language implemented in `src/api/` (implemented, not copied). |
| **OASIS OSLC Systems Modeling Language v2.0** (OSLC PSM) | <https://docs.oasis-open-projects.org/oslc-op/sysml/v2.0/psd01/sysml-spec.html> | OASIS Open Project terms | Normative reference for the representative OSLC facade `src/api/oslc.ts` (implemented, not copied). |
| **OSLC Core 3.0** (OASIS) | <https://docs.oasis-open-projects.org/oslc-op/core/v3.0/> | OASIS Open Project terms | Reference for OSLC ServiceProviderCatalog/ServiceProvider/QueryCapability shapes, `oslc.where`/`oslc.select`, and the "RDF Representations" content-negotiation requirement served by `src/server/rdf.ts` (implemented, not copied). |
| W3C **RDF 1.1 Turtle** | <https://www.w3.org/TR/turtle/> | W3C Document License | Reference for the Turtle concrete syntax emitted by `src/server/rdf.ts` (implemented, not copied). |
| W3C **RDF 1.1 XML Syntax** | <https://www.w3.org/TR/rdf-syntax-grammar/> | W3C Document License | Reference for the RDF/XML concrete syntax emitted by `src/server/rdf.ts` (implemented, not copied). |
| IETF **RFC 9110** (HTTP Semantics) | <https://www.rfc-editor.org/rfc/rfc9110> | IETF Trust / RFC terms | Reference for `ETag`/`If-Match` conditional-request + `409 Conflict` optimistic-concurrency semantics wired in `src/server/app.ts` (implemented, not copied). |
| `Systems-Modeling/SysML-v2-Release` reference repository | <https://github.com/Systems-Modeling/SysML-v2-Release> | **EPL-2.0** | Two uses: (1) consulted to fact-check the curated clean-room library in `src/library/standard-library.ts` (no text copied); (2) its XMI library tree is **converted** into `src/library/std/` (converted model data — see below), which is therefore **EPL-2.0**. |
| **Derived standard library** `src/library/std/` (converted from the repo above, commit `ee25530ed24b8c93a0e3e4b8d5fbfaa5a8d8ffb4`) | <https://github.com/Systems-Modeling/SysML-v2-Release> | **EPL-2.0** | Full SysML v2 / KerML standard model library, converted to this project's JSON by `scripts/build-stdlib.ts`. See `src/library/std/{LICENSE,NOTICE,README.md}`. |
| Project reference: `docs/02-omg-standard-reference.md` | (in this repository) | MIT (this project) | Primary internal engineering reference used while authoring the library and the Langium grammar. |
| **Langium** parser framework + `langium-cli` | <https://github.com/eclipse-langium/langium> | **MIT** | Build/runtime dependency driving the **default** textual parser (`src/text/langium/`). No grammar text copied from it. |
| BIPM **SI Brochure** (9th ed., 2019) — International System of Units | <https://www.bipm.org/en/publications/si-brochure> | BIPM (definitions are physical facts) | Consulted for the SI base/derived-unit *definitions*, decimal prefix powers, and exact defined equivalents (e.g. 0 °C ≡ 273.15 K) used to author the clean-room dimension model + unit registry in `src/semantics/units.ts`. No prose, table, or data file copied; every factor/offset implemented originally from the definitions. |
