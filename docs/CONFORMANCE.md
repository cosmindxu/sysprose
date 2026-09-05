# Sysprose — Conformance Scorecard

> **Self-assessment, not certification.** This scorecard measures Sysprose against the OMG SysML v2 / KerML / API & Services specifications *as read by this project*. Sysprose is a candidate implementation; it has not been certified or conformance-tested by the OMG or anyone else, and nothing here is a conformance claim.

*Generated: 2026-07-01; suite, corpus and parse-rate figures re-measured
2026-09-04. Numbers below are captured from a live test run, not asserted from
memory. Reproduce with the commands in the last section.*

This is an honest conformance scorecard for the clean-room SysML v2 / KerML
modeler. It maps the project's automated evidence onto the OMG SysML v2 standard
family and states, candidly, what is and is not covered. Every pillar is a
**faithful, load-bearing subset** — see `docs/TEST-REPORT.md` §8 for the pillar
verdicts and `docs/LICENSES.md` for the clean-room / consulted-spec record.

**Consulted specifications** (implemented from, never copied — see
`docs/LICENSES.md`): OMG **SysML v2** v2.0, OMG **KerML** v1.0, OMG **Systems
Modeling API & Services** v1.0 (REST/HTTP PSM, element-graph JSON, Query
language), **OASIS OSLC Systems Modeling Language v2.0** + **OSLC Core 3.0**,
W3C **RDF 1.1** (Turtle / XML Syntax) and **JSON-LD 1.1**, **OpenAPI 3.1**.

---

## Headline numbers

| Dimension | Result |
|---|---|
| Conformance suite (`test/conformance`) | **71 passed / 0 failed** across **4 files** |
| Full automated suite | **2261 passed / 0 failed / 0 skipped** across **130 files** + **128 E2E** across **78 spec files** = **2389 green** (measured 2026-09-05) |
| OMG element-graph JSON Schema validity of our `api-json` exports | **PASS** (all standard models, import→export stable) |
| Reference XMI standard libraries ingested | **38,761 elements** across **98 packages** (from 109,673 source elements) |
| Real `.kerml` / `.sysml` corpus parse rate | **100 %** (94 / 94 files, 0 parse errors) |
| OMG REST endpoints validated against the OpenAPI 3.1 schema | **10 / 10** live endpoints (server: 25 paths / 29 operations / 18 schemas) |
| OSLC Core structural conformance | **8 / 8** structural checks + **11** full-shape checks (catalog / provider / query / resource / `oslc:ResourceShape` + Turtle / RDF-XML / JSON-LD) |
| Interop — self round-trip over HTTP (`test/interop`) | **PASS** — `PilotApiClient` push→pull preserves the **13-element** pilot model (element set + endpoints + query) |
| Interop — **LIVE round-trip vs. the real OMG pilot** (`SYSMLV2_PILOT_URL`) | **NOT RUN** — the build environment is offline; the client is ready (`npm run interop`) but no live OMG reference server has been exercised. See "The load-bearing gap" below. |

---

## 1. Round-trip invariants — `roundtrip.test.ts` (25 tests)

Each of three **standard models** — `buildSampleModel()`, `examples/vehicle.sysml`,
and the bundled **ISQ + SI** library packages — is asserted to uphold the
cross-format invariants a conformant tool must preserve. The preserved identity
is the order-independent multiset of `metaclass @@ qualifiedName`.

| Invariant | Holds | Notes |
|---|---|---|
| **Endpoint integrity** — every element has an id, no relationship endpoint dangles | **PASS** (3/3 models) | `integrityViolations()` empty for every model. |
| **model-json round-trip** — `Model.fromJSON(m.toJSON()).toJSON()` deep-equals `m.toJSON()` | **PASS** (3/3) | Loss-less native snapshot. |
| **api-json round-trip** — `importModel(exportModel(m,'api-json'))` preserves the element set | **PASS** (3/3) | Element-graph interchange is set-stable. |
| **api-json schema validity** — export validates against the OMG element-graph JSON Schema (draft 2020-12) | **PASS** (3/3) | See §2. |
| **api-json import→export stability** — the rebuilt export also validates | **PASS** (3/3) | Interchange is idempotent under the schema. |
| **textual round-trip** — `parseModel(serializeModel(m))` reproduces the element set | **PASS** (3/3) | Now full-fidelity: the serializer emits every specialization relationship (`: Type`, `:>`, `:>>`, `::>`) and the mapper reconstructs the `FeatureTyping` element on parse, so the ISQ+SI library model round-trips textually too (the former declared subset boundary is closed). |

Four additional schema-guard tests assert the element-graph schema **rejects**
malformed documents (missing `elements`, missing `@id`, missing `@type`) and
**accepts** a minimal well-formed graph.

## 2. Interchange — OMG element-graph JSON

- Our `api-json` element-graph exports (`src/persistence/io.ts` →
  `src/api/element-graph-schema.ts`) **validate cleanly** against the OMG
  element-graph JSON Schema for every standard model, and validation is stable
  under a second export cycle (import → export → validate). **PASS.**
- We **ingest the reference XMI standard libraries**: `src/library/std` bundles
  **38,761 elements** across **98 packages** (KerML, Kernel, Base, ISQ + all
  ISQ domains, SI, Quantities, Geometry, Analysis/Verification/Trade-study,
  Metadata, etc.), generated from **109,673** source elements of the
  Systems-Modeling XMI release (commit `ee25530`).
- We **parse 100 %** of the real `.kerml` / `.sysml` corpus at
  `~/.stdlib-src` (94 of 94 files parse with **0 errors**; read as test input
  only, never committed). Reproduce with `npx tsx scripts/grammar-coverage.ts`
  (measured 2026-09-03; an earlier revision claimed 94/94 while the harness
  measured 93/94 — `RequirementDerivation.sysml` uses `derive` as a declared
  name, accepted since the bracket-expression grammar pass). The wider release
  corpus — `sysml/src` training and validation models, `kerml/src`, plus this
  repo's `examples/` — is not a conformance claim; `--all` reports 279 of 405
  files parse clean, the rest use constructs the grammar does not yet cover.
- **Units and quantity kinds follow the bundled library, including where that
  costs us.** Unit references resolve through one model-free funnel
  (`src/semantics/units.ts`): the library's own qualified spelling
  (`SI::'watt hour'`), a symbol or long name with an SI prefix, the worded
  compounds (`metre per second`), and unit expressions in the library's own
  notation (`kg⋅m²⋅s⁻³⋅A⁻¹`, `J/(kg⋅K)`) or ASCII (`kg*m/s^2`). Information
  quantities are typed **as `ISQInformation` types them** — the nine rate kinds
  are T⁻¹ (their unit is a `DerivedUnit` with a duration power factor) and the
  content/entropy kinds are dimension one (their unit subclasses
  `DimensionOneUnit`), per ISO 80000-13, and the prefixes follow the same
  pairing: only the magnifying decimal prefixes attach to an information unit
  (`kB`, `Gbit`, never `mbit`) and the binary prefixes Ki..Yi only to bit, byte
  and octet — which is also what keeps `dB`, a logarithmic ratio that is not a
  unit of this kind at all, from decomposing as deci + byte. The visible
  consequence is that
  `bit/s` and `Hz` share a dimension: an eighth "information" axis would tell
  them apart but would diverge from the standard library we bundle and from
  FMI's `<BaseUnit>`, so it was not added. Conversion factors are authored from
  the SI Brochure and ISO 80000-13 *definitions*, never transcribed from the
  EPL-licensed bundle (`docs/LICENSES.md`); the bundle is consulted for which
  spellings and typings exist, not for values, and it carries no expression
  payload to copy. Known gap: a library long name beyond per/squared/cubed
  (`… second to the power minus 3 …`) does not resolve — the diagnostic hint
  teaches the symbol form.
- **Name resolution follows KerML §8.2.3.5, once.** One resolver
  (`src/semantics/bind.ts` `resolveFullName`) answers every textual reference,
  and `parseModel` calls it at a single point after the whole file is mapped:
  per namespace from the referencing scope outward, the local resolution of
  §8.2.3.5.3 (owned + alias, then INHERITED, then imported members), then root
  imports, then a root-anchored qualified name. Resolution is over the finished
  namespace, so **declaration order is not significant**: a name declared both
  in a supertype and in an enclosing namespace denotes the inherited one
  wherever it is written. `:>>` uses the §8.2.3.5.1 rule instead — the general
  types of the owning type are the local namespaces, tried before ordinary
  resolution, with the redefining feature excluded throughout. Two deliberate
  departures, both recorded in `docs/AGENT-AUTHORING-CAMPAIGN.md`: a named
  RELATIONSHIP element is reachable by name through a containment fallback
  (`flow f;` then `satisfy R by f;`), which the spec's Namespace membership does
  not cover; and a bare library definition (`:> Part`) is accepted without an
  import.
- The parser also **rejects** non-SysML rather than accepting anything: `!!! this
  is not sysml at all !!!` produces 6 parse errors, `package Broken { part def ;;;
  <<<not sysml>>> }` produces 2, and an unterminated body produces 1. (An earlier
  revision of this file claimed the grammar was permissive and that the 94/94
  figure therefore only measured an accepting path. That was **wrong** — the
  errors were being produced all along and discarded by the UI store before they
  reached the Problems panel; see `TEST-REPORT.md` §5 row 87. The parse-rate
  figure stands as measured.)

## 3. API & Services PSM — `api-contract.test.ts` (22 tests)

The REST surface is now a **networked HTTP/Express** server (`src/server`,
started on an ephemeral port under `// @vitest-environment node`). For each
representative endpoint the **live** response body is validated with Ajv +
ajv-formats against the response schema **declared for that endpoint** in the
served **OpenAPI 3.1.1** document — proving the API and its own description are
self-consistent.

Endpoints validated (10/10):

- `GET /api/projects` → `Project[]`
- `GET /api/projects/{id}` → `Project`
- `GET /api/projects/{id}/commits` → `Commit[]`
- `GET /api/projects/{id}/branches` → `Branch[]`
- `GET /api/projects/{id}/commits/{cid}/elements` → `ElementsPage` (element-graph)
- `GET /api/projects/{id}/commits/{cid}/elements/{eid}` → `Element`
- `GET /api/elements/{eid}` → `Element` (default HEAD)
- `GET /api/analytics/metrics` → `Metrics`
- `POST /api/queries` → `QueryResult` (native element records)
- `POST /api/projects/{id}/commits/{cid}/query-results` → `QueryResult`

The served OpenAPI document exposes **25 paths / 29 operations / 18 component
schemas**.

## 4. OSLC PSM — `oslc-conformance.test.ts` (8 tests)

OSLC Core 3.0 structural conformance of the linked-data facade (`src/api/oslc.ts`
served via `src/server`, with a dependency-free RDF serializer `src/server/rdf.ts`):

- `/oslc/catalog` is an `oslc:ServiceProviderCatalog` with ≥1 `oslc:serviceProvider`.
- `/oslc/services` is an `oslc:ServiceProvider` exposing an `oslc:queryCapability` with an `oslc:queryBase`.
- an element resource carries `@context`, `rdf:type` and `dcterms:identifier`.
- `/oslc/query` is an `oslc:ResponseInfo` with `rdfs:member` entries.
- **Content negotiation**: valid **Turtle** (`@prefix`), **RDF/XML** (`<rdf:RDF`) and **JSON-LD** (default), each returned with the correct `Content-Type`; element resources are served as Turtle and RDF/XML too.

## 5. Corpus parse conformance — `corpus.test.ts` (16 tests)

Known real-world corpus files parse with **0 errors**, produce **non-empty**
models, and are **dangling-free** (all endpoints resolve in-model), confirming
the textual front-end and model builder agree with the interchange invariants.

## 6. Interop / round-trip — `test/interop`, `scripts/pilot-roundtrip.ts`

Our **`PilotApiClient`** (`src/interop`) speaks the OMG **Systems Modeling API &
Services** REST protocol directly over `fetch`: it discovers projects/branches,
POSTs OMG **change records** to a branch head to create a commit, and pulls the
paginated OMG **element-graph** back, reconstructing a native `Model` from the
`@id`/`@type` element JSON. It is a general client, not a self-test harness — the
same code path drives both the self round-trip and the live-pilot adapter below.

- **Self round-trip (push → pull over HTTP).** `test/interop/self-roundtrip.test.ts`
  and `scripts/pilot-roundtrip.ts` stand up our own OMG-shaped Express server
  (`src/server`, `createServer().listen(0)`), then push a pilot model and pull it
  back through the client. The element set is **preserved exactly**: **13 pushed
  elements → 13 pulled elements**, **4 relationship endpoints preserved**, and a
  server-side `@type = PartUsage` query returns the expected matches. This proves
  the client and our server agree on the wire protocol end-to-end (**EQUIVALENT**).
- **Documented live-pilot adapter.** Set `SYSMLV2_PILOT_URL` (and, if the pilot
  requires auth, `SYSMLV2_PILOT_TOKEN`) and run **`npm run interop`**
  (`scripts/pilot-roundtrip.ts`) to run the identical push→pull round-trip against
  a **live OMG SysML v2 pilot server**. With the env var unset, the script targets
  the in-process server so the self round-trip always runs offline.

- **LIVE round-trip against the real OMG pilot — EXERCISED (2026-07-02).** The
  public OMG SysML v2 reference pilot at `http://sysml2.intercax.com:9000`
  (Intercax) was reachable and used for a genuine cross-implementation round-trip:
  - **READ** (`scripts/pilot-read-live.ts`): `PilotApiClient` pulled **300 real
    elements** from a live project (`Flashlight_StarterModel`) and reconstructed
    them into our `Model` — real KerML metaclasses (`FeatureMembership`,
    `OwningMembership`, `ReferenceSubsetting`, `FeatureChaining`, `Multiplicity`, …),
    all classified by our metaclass hierarchy. This surfaced + fixed two real
    dialect gaps in our client (verbatim base-URL; the pilot's bare-array +
    RFC-5988 `Link: rel=next` pagination vs. our `{elements,nextCursor}` envelope).
  - **WRITE** (`scripts/pilot-write-roundtrip.ts`): created a throwaway project,
    committed a `Package` in the OMG `Commit`→`change[]`→`DataVersion{identity,
    payload}` format (`POST /projects/{id}/commits?branchId=…`), and pulled it
    back with the element **`@id` preserved** — **ROUND-TRIP OK**.

> **Honest caveat.** The live round-trip is now exercised (above) and passed, but
> it is a **representative** exchange (one `Package` written; a bounded 300-element
> read), not a full-model bidirectional migration — pushing arbitrary models needs
> containment expressed as reified `OwningMembership` payloads, which this minimal
> proof did not exercise. Also, the pilot does not support project deletion
> (`DELETE /projects/:id` → 500), so one clearly-named `sysprose-interop-test-*`
> project remains on that public demo server. Point `SYSMLV2_PILOT_URL` at any
> conformant pilot to reproduce.

---

## Mapping to OMG conformance statements — and the honest gaps

| OMG conformance area | Addressed by | Honest gap |
|---|---|---|
| **Textual notation parsing** | Langium grammar; **100 % corpus parse**; full textual round-trip stability | Parse + full round-trip are closed; the residual is deep formal-semantics corners, not grammar coverage. |
| **Model interchange** | element-graph `api-json` validates against the OMG JSON Schema; XMI library ingest (38.8k elements); **self round-trip over HTTP** via `PilotApiClient` | No XMI *export*; interchange identity is the element-set multiset, not byte-for-byte; no live OMG pilot-server round-trip exercised offline (see §6). |
| **API PSM (REST + Query)** | 10 live endpoints validated against OpenAPI 3.1; versioning/Query engine; **concurrent-writer commit serialization** (`test/server/concurrency*`); **interop client** round-trips over HTTP (§6) | OpenAPI surface is representative (25 paths), not every endpoint/param. |
| **OSLC PSM** | OSLC Core catalog/provider/query + Turtle/RDF-XML/JSON-LD + **`oslc:ResourceShape` full-shape resources** (`test/server/oslc-shapes`) | A representative subset of the OSLC SysML PSM (no delegated dialogs). |

**The load-bearing gap.** The interop client round-trips **fully** against our own
spec-shaped server (§6), but the environment is **offline**, so there is **no live
round-trip against a running OMG SysML v2 pilot server** — set `SYSMLV2_PILOT_URL`
and run `npm run interop` to exercise it. We validate against the published
**specifications and schemas** (clean-room) and our own spec-shaped server, not a
running OMG reference implementation. Each pillar is a faithful, load-bearing
subset per `docs/TEST-REPORT.md` §8; the honest residual is the deepest
**formal-semantics** corners, not breadth. Nothing here is a conformance claim:
Sysprose has never been conformance-tested by the OMG or anyone else.

---

## How to reproduce

```bash
cd sysprose

# Full unit + integration + conformance suite (2261 pass / 0 skip, 130 files)
npm test                    # === npx vitest run

# Just the conformance scorecard suite (71 pass, 4 files)
npx vitest run test/conformance --no-coverage

# Interop self round-trip over HTTP (7 pass, 1 file)
npx vitest run test/interop --no-coverage

# Real .kerml/.sysml corpus parse rate (100 %)
npx tsx scripts/grammar-coverage.ts

# Self round-trip against our own OMG server (push→pull, 13 elements EQUIVALENT)
npm run interop             # or: npx tsx scripts/pilot-roundtrip.ts

# Live-pilot round-trip (requires a reachable OMG SysML v2 pilot server)
SYSMLV2_PILOT_URL=https://pilot.example/api SYSMLV2_PILOT_TOKEN=… npm run interop

# Networked API / OSLC server (manual smoke)
npm run serve               # then GET /api/... and /oslc/...

# End-to-end (128 tests across 78 spec files)
npm run test:e2e
```
