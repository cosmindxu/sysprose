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
| Full automated suite | **3074 passed / 0 failed / 0 skipped** across **146 files** + **128 E2E** across **78 spec files** = **3202 green** (measured 2026-09-10) |
| Command-line surface | **22 subcommands** in one spec table, over **6 shipped example models**, each of which is verified on every push — both figures measured off the tree by `test/unit/docs-counts.test.ts`, never quoted |
| OMG element-graph JSON Schema validity of our `api-json` exports | **PASS** (all standard models, import→export stable) |
| Reference XMI standard libraries ingested | **38,761 elements** across **98 packages** (from 109,673 source elements) |
| Real `.kerml` / `.sysml` corpus parse rate | **100 %** (94 / 94 files, 0 parse errors) |
| OMG REST endpoints validated against the OpenAPI 3.1 schema | **10 / 10** live endpoints (server: 25 paths / 29 operations / 18 schemas) |
| OSLC Core structural conformance | **8 / 8** structural checks + **11** full-shape checks (catalog / provider / query / resource / `oslc:ResourceShape` + Turtle / RDF-XML / JSON-LD) |
| Interop — self round-trip over HTTP (`test/interop`) | **PASS** — `PilotApiClient` push→pull preserves the **13-element** pilot model (element set + endpoints + query), and the verdict-bearing fixture's carrier, both `verdict` cells and its record string character for character |
| Interop — **LIVE round-trip vs. the real OMG pilot** (`SYSMLV2_PILOT_URL`) | **RUN, and mixed** — read of 300 live elements and a `Package` write round-trip **PASS** (2026-07-02); the verdict-bearing write of 2026-09-09 is **refused as written** (four defects of our own dialect) and, once those are repaired in the probe, **accepted with the structure intact and every tool-local value dropped** — the evidence's contents do not survive. §6.1 has the measurement, and names the one row it could not take. |

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
| **textual round-trip** — `parseModel(serializeModel(m))` reproduces the element set | **PASS** (3/3) | Full-fidelity: the serializer emits every specialization relationship (`: Type`, `:>`, `:>>`, `::>`) and the mapper reconstructs the `FeatureTyping` element on parse, so the ISQ+SI library model round-trips textually too (the former declared subset boundary is closed). **Requirement-clause bodies now survive it**, and the writer emits the `constraint` keyword the published grammar needs to read a clause as a DECLARATION rather than a reference — see the corpus byte diff below. |

Four additional schema-guard tests assert the element-graph schema **rejects**
malformed documents (missing `elements`, missing `@id`, missing `@type`) and
**accepts** a minimal well-formed graph.

**Corpus byte diff of the writer (measured 2026-09-06, across the
requirement-clause commit `b16a457` and over the corpus as it stood there).**
`serializeModel` was run over 236 files — `examples/`, the **140** `.sysml`
files the fixture corpus held at that commit, and the 94 files of
`~/.stdlib-src/sysml.library` — before and after the requirement-clause fix.
The corpus has since grown (141 fixture files, 237 in all, after the
`requirement-subject` commit added one); the figures below are the ones that
experiment measured and are not re-derived by any later commit. Output moves on **29** of them (2 examples, 11 fixtures,
16 standard-library files), **+2,817 bytes** in total: 46 clause lines gain the
`constraint` keyword, 3 regain a `private`, and **9** of the 29 also gain
clause-body content that was previously deleted on every save — doc notes and
nested members on `TradeStudies`, `CausationConnections`, `SpatialItems`,
`MeasurementReferences`, `DerivationConnections`, `Cases`, `Items`,
`Requirements` and `VerificationCases` (a tenth, `Views.sysml`, regains a
multiplicity rather than a body). The other 207 files are byte-identical.

The keyword is written only where the clause DECLARES: the published grammar's
first `RequirementConstraintUsage` alternative is an owned reference subsetting,
so `require sat;` names an existing constraint and must not become
`require constraint sat;`. Checked over the wider OMG release-model corpus as
well (`~/.stdlib-src/sysml/src`, 251 files, 50 of which move): across all 487
files, **no** reference-form clause line is rewritten into a declaration.
Reproduce by serializing the same 487 files across `b16a457` — the corpus at
that commit, not today's — and the round-trip and campaign suites cover the
result.

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

### 6.1 The verdict-bearing write probe — what another tool did with our evidence (2026-09-09)

A `Package` surviving the wire says nothing about the two things the
verification lane writes, and both of them are **tool-local tags the
specification does not define**: a `metadata RequirementMetadata { attribute
verdict = "…"; }` cell and an `@SysproseVerification::Evidence { … }` carrier
holding the record (§8.2, §8.3). A conforming reader is entitled to ignore
either. Whether a real one does is a fact about somebody else's server, so
`scripts/pilot-write-roundtrip.ts` now pushes a **verdict-bearing model** —
`scripts/lib/verdict-fixture.ts`, 19 elements, written by the real `verify` +
`attachEvidence` path, one carrier, two `verdict` cells and a 1466-character
record string — instead of a bare `Package`. It was run against the same public
pilot on **2026-09-09**, and this is what it measured.

| Stage | What was pushed | Result |
|---|---|---|
| 1 — as this tool writes it | the 19 elements of `ModelApi.toModelJSON()`, unmodified | **REFUSED** — `POST …/commits` → **500**. |
| 2 — three shape defects of **our** dialect repaired | the same 19 elements with the metaclass name `Satisfy` corrected to `SatisfyRequirementUsage`, `RequirementDefinition.text` sent as a list where the specification has `text : String[0..*]`, and the boolean `MetadataUsage.annotation` dropped where the specification has `annotation : Annotation[0..*]` | **STILL REFUSED** — `POST …/commits` → **500**. Stage 2 differs from stage 3 in exactly one property, so this is what isolates the fourth defect: `MetadataUsage.type`, which we send as a string and which the specification *derives*. |
| 3 — `MetadataUsage.type` dropped as well | the same 19 elements, `type` gone | **ACCEPTED, and the values did not come back.** 19 pushed, 19 pulled. Structure preserved, re-derived by the script on every run: **19/19 ids**, **19/19 metaclasses**, **14/14 `declaredName`s**, **18/18 containment (`owner`) edges**, and the one `text` body returned as sent once it was a list (the pilot *adds* an empty `text: []` to one further element — an addition of its own, not a loss of ours). Every **tool-local property was dropped** — `value` (the cell that holds each verdict string and the whole record), `requirementRole`, `declares`, `expression` — so the facet returned as a **named, empty shell**: **2 verdict cells sent / 0 back, 1466 record characters sent / 0 back, 4 record summary cells sent / 0 back**. |

**One row this probe cannot measure, and does not pretend to.** The *carrier
count* is not comparable at stage 3. `MetadataUsage.type` is the only property on
the wire that says an `@SysproseVerification::Evidence` carrier is one — it is
what `verdictBearingSignature` reads to find carriers at all — so the very repair
that got the commit accepted is the repair that makes a carrier unidentifiable,
and a perfect lossless echo would have returned 0 carriers too. The script prints
that row as `N/A … NOT MEASURABLE` rather than scoring it, and the repair is held
back to its own stage for exactly this reason. What IS measured is the thing that
matters more: the carrier's *contents* — the claim word, the engine, the model
digest and the whole 1466-character record — were dropped.

**Read that as it is.** The pilot did not misread a Sysprose verdict, upgrade a
claim or return a verdict nobody computed; it kept the model and discarded the
annotation, which is exactly what a reader is entitled to do with a tag it does
not know. **So the interoperability of the evidence record is now measured, and
the measurement is negative**: today, the *values* a Sysprose verdict is made of
do not survive a round trip through that server's API, and no claim is made that
they survive any other. The four dialect defects are ours and are **not fixed
here** — they are recorded so the next commit that touches `toElementJSON` has
the failing shapes in hand. The offline control runs on every push
(`test/interop/self-roundtrip.test.ts`, "round-trips a verdict facet and an
evidence carrier"): the same fixture through the same client against our own
server keeps the carrier, both verdict cells and the record character for character. That is a
control on the fixture and on our own wire, not a second opinion about the
pilot's — the carrier row above is unmeasurable on the pilot for a reason that is
ours, and the offline test cannot supply the number the live run could not take.

> **Honest caveat.** The live round-trip is exercised (above), and it is a
> **representative** exchange — 19 elements written, a bounded 300-element read —
> not a full-model bidirectional migration. It answers the **API/JSON path only**;
> what a foreign *textual* parser makes of the `.sysml` bytes is a different
> question and is untested. Also, the pilot does not support project deletion
> (`DELETE /projects/:id` → 500), so the clearly-named `sysprose-interop-test-*`
> projects each run creates — one per stage, three per run — remain on that
> public demo server. Point `SYSMLV2_PILOT_URL` at any conformant pilot to
> reproduce; the script re-derives every figure in the table above, structure
> rows included, so a re-run either reproduces it or contradicts it.

---

## 7. User-defined keywords — the mechanism, and the one vocabulary Sysprose ships

SysML v2 §7.27.1 says a metadata definition with no nested features "simply acts
as a user-defined syntactic tag on the annotated element", and §7.27.4 makes the
(short) name of such a definition writable as a `#keyword` in front of a
declaration. That mechanism is what Sysprose borrows. The vocabulary carried over
it is **not** part of the specification, and nothing in this tool describes it as
if it were.

A practitioner's four-keyword vocabulary was assessed against the published
specification. Two of the four are things the notation already expresses, one
names a real gap that is deliberately **not** shipped, and one is adopted:

| Facet | Keyword proposed | Does SysML v2 express it? | The construct the specification supplies | Decision |
|---|---|---|---|---|
| **Before** | `#precondition` | **Yes, three ways** | `assume constraint` in a requirement body (`RequirementConstraintKind = assumption`, Part 1 §8.2.2.21.1); `objective { assume constraint { … } }` on any case, typed by `Cases::Case::obj : RequirementCheck[1]`; `guard` on a transition (`TransitionPerformances::TransitionPerformance::guard`) | **Rejected.** Read the standard construct; a keyword would be redundant syntax. |
| **After** | `#postcondition` | **Yes** | `require constraint`; `objective { require constraint { … } }`, whose subject *defaults* to the case result per the shipped `Systems Library/Cases.sysml` (`subject subj default Case::result;`) and is *bound* to the case subject per `VerificationCases.sysml` | **Rejected**, for the same reason. |
| **Valence** | `#Exception` | **No** | `exception*` occurs nowhere in Part 1. `VerificationCases::VerdictKind::fail` is a case *result*, not a model-authored classification of an outcome, and `RiskMetadata::Risk` is probability and impact. §7.27.4's own example is `#situation occurrence def Failure;` — the specification *demonstrates* a user-defined failure marker | **Adopted** as `#exceptional`, over the shipped `metadata def <exceptional> ExceptionalOutcome;` in `SysproseVerification` (`src/semantics/verification-vocabulary.ts`). A Sysprose extension, not standard vocabulary. |
| **Visibility** | `#Observable` | **No** | "observable" occurs twice in Part 1, both inside one narrative use-case sentence — a sentence, not a construct. `out` direction and `flow` say what crosses an interface, not which step is published; `VerificationMethodKind` sits on the case | **Held, not shipped.** A `metadata def` written into a user's file is a compatibility commitment; this one would discharge no obligation. |

**What is read, and what that reading may do.** `contracts --keywords` inventories
every keyword in a file with what it resolves to — resolution is KerML full name
resolution against the `MetadataDefinition`s in scope, with the bundled library as
the namespace of last resort, which is why the library's own `#moe` resolves. A
keyword naming nothing in scope is reported (`verification/keyword-names-nothing`,
info); a third-party spelling this tool recognises is reported with its provenance
(`verification/foreign-keyword`, info) and never described as standard.
`verification/foreign-keyword` also comes from `obligations --from-keywords`, one
row per obligation a keyword actually filed; `verification/keyword-names-nothing`
comes from `contracts --keywords` alone, since a keyword naming nothing files
nothing. Neither comes from anywhere else: `npm run check` does not judge a
keyword.

**What a keyword may move, and what it may never touch.** A third-party
`#precondition` / `#postcondition` files a premise or something to show only
under `obligations --from-keywords`, and only on a **plain `constraint`**. It
never overrules a clause role the author wrote, it can never add an axiom, and —
the direction that matters as much — it can never take one away: a keyword on a
`calc` leaves the calculation's defining equality (`total == a + b`) exactly
where it was, because a vocabulary that could silently drop a definition out of
the proof context would leave every obligation over that calculation standing on
a free variable.

**Measured, and pinned by `test/unit/semantics.keywords.test.ts`:** `#exceptional`,
`#Exception`, `#precondition`, `#postcondition`, `#Observable`, a qualified
`#SysproseVerification::exceptional` and a misspelt `#precondtion` all parse with
zero diagnostics on six host declarations, are stored exactly as written, and
round-trip. The round trip is idempotent **from the second save** rather than
byte-identical from arbitrary input. A keyword colliding with a hard keyword of
the notation must be quoted — `#derive part def A;` does not parse, `#'derive'`
does.

---

## 8. `verify` — one declared deviation, and two slots this tool does not bind

`npm run sysprose -- verify` reaches a verdict. Three things about it belong in
a conformance record rather than in a release note.

### 8.1 The declared deviation: a requirement with a false assumption

Part 1 §9.2.14.2.8 gives the result of a `RequirementCheck` as
`allTrue(assumptions) implies allTrue(constraints)` — the shipped
`Systems Library/Requirements.sysml` spells it with the call parentheses — so a
requirement whose assumption is **false** is **true** under the specification's
own semantics.

**Sysprose reports it as `vacuous` ⇒ inconclusive ⇒ exit 2 instead.** A
requirement discharged by an antecedent that does not hold tells an engineer
nothing, and it is the classic way a requirement set passes while meaning
nothing. This is a **deviation, not an interpretation**, it is the only one in
the verification lane, and no flag launders it: `--allow-inconclusive` is scoped
to `verification/timeout` and `verification/unsupported-construct` and does not
reach `verification/vacuous-pass`. The case is pinned in
`test/fixtures/verification/vacuous-assumption/` and its `--allow-inconclusive`
twin.

### 8.2 The verdict slot the standard defines, and this tool does not bind

The standard's own verdict slot is
`VerificationCases::VerificationCase::verdict : VerdictKind {redefines result}`.
**Sysprose does not bind it.** What it writes instead — from a later commit of
the verification plan — is a `metadata RequirementMetadata { attribute verdict =
"…"; }` facet, which is a **tool-local, unbound tag holding a quoted string**:
`RequirementMetadata` has **0 occurrences** in Part 1, which has only
`DerivedRequirementMetadata` and `OriginalRequirementMetadata`, and
`src/semantics/requirements.ts` says in its own header that the identifier
resolves to nothing. A conforming reader is entitled to ignore that line
entirely, and nothing obliges it to interpret the string. The value list mirrors
the library's `VerdictKind` literals; it is not a `VerdictKind` reference.

That facet is written for **two claims only** — `proved` ⇒ `pass`, `refuted` ⇒
`fail` — and everything else, `holds-at-values` included, writes `inconclusive`.

### 8.2b The one standard slot this lane writes, and the gate in front of it

`@VerificationCases::VerificationMethod { attribute kind = analyze; }` on a
verification case **is** standard, and it is the only standard element this lane
writes. `evidence-attach` puts it on a case that stated no method, so the file
records which method the computed verdict was reached under instead of leaving a
reader to assume one; a case that already states a method is left exactly as
written.

**The gate that annotation exists for.** `VerificationMethod` carries
`kind : VerificationMethodKind [1..*]`, so a case may legitimately say
`kind = (analyze, test)`. Sysprose performs **analysis and nothing else**. A case
whose list contains `analyze`, or which states no method at all, is judged on the
analyze part and reports every other kind as not performed. A case with no
`analyze` in its list is **not judged at all**:
`verification/method-not-performed`, inconclusive, **exit 2** — never exit 1,
because an unjudged case is not a refutation — and `--allow-inconclusive` does
not reach it, because §2 scopes that flag to `verification/timeout` and
`verification/unsupported-construct`. A `kind` spelling this tool does not
recognise is reported by name and treated as **not** `analyze`. The shipped
`examples/uav-isr-verification.sysml` carries all three shapes and is exit 2 with
every obligation in it discharged, and a job on every push
(`.github/workflows/verify-examples.yml`, `method-gate`) asserts that exit code
with and without `--allow-inconclusive`, against the control of the same file
narrowed to its `analyze` case, which is exit 0.

**Every spelling of the method is read, because the arm that judges is the arm a
case falls into when none is found.** The definition may be named in
`declaredName` (`metadata VerificationMethod { … }`), in `attrs.type` (the
annotating form), in `attrs.typeRef`, or on a `FeatureTyping` child
(`metadata vm : VerificationCases::VerificationMethod { … }`); the `kind` cell
may be named or may redefine (`attribute :>> kind`); and the method may be
declared once on a `verification def` and inherited by its usages. All of those
are read, through the generalization chain, and so is a `kind` cell that names a
`VerificationMethodKind` under a definition name this tool cannot resolve.

**The facet is rolled up per REQUIREMENT.** A case verdict is a summary over the
set of requirements a case verifies; a `verdict` facet is a sentence about one of
them. Each requirement's facet is computed from that requirement's own obligation
rows, and a requirement this run produced no row for is written nothing at all
and is named in the report's `skipped` list.

**And the case verdict is not the file's verdict.** A case's `verdict` is the
library `PassIf` reading over the engine that was asked for; the `facet` that may
be written into the file is `pass` only where every obligation was `proved`. So a
green `--engine literal` run over a passing case writes `inconclusive`, and the
report prints the difference on its own line.

### 8.3 What the engines may and may not claim

`--engine literal` evaluates the model's own feature values through the same
`checkConstraints` surface the app's **Analyze** button uses. Its claim word is
`holds-at-values` and it can never reach `proved`. `--engine auto` resolves to
the SMT engine or reports `verification/tool-absent` for every obligation, exit
2; it never falls back to a point evaluation, and `--allow-inconclusive` never
lowers that row. The absence is exercised on every run of the L8 corpus and on
every push in CI (`.github/workflows/verify-examples.yml`) with
`SYSPROSE_NO_Z3=1`, because it is only reachable when something is missing and
is therefore the single most likely path in this lane to rot into a silent
green.

**`--engine smt` ships and may say `proved` — and that word means exactly one
thing.** Per obligation *O* with premises *P* under axioms *A*, the engine runs
`check(A)` once per run, then `check(A ∧ P ∧ ¬O)`, `check(A ∧ P)` and
`check(¬O)`. `proved` requires: the negation UNSAT, the axiom set SATISFIABLE
(an unsatisfiable one makes every negation unsat, so every obligation in such a
run is `verification/inconsistent-axioms` with the core named — never a proof),
the premises SATISFIABLE (otherwise `verification/vacuous`), and every feature
released by `--free` confined on BOTH sides (otherwise
`verification/free-variable-unbounded`, which is blocking and never a
refutation). A goal that is unsat when negated with no context at all is still
`proved` and is FLAGGED as a tautology, because `x == x` is not evidence about a
design. Every `sat` witness is substituted back through the tool's own
evaluator before it is printed, and with nothing freed it must also read as
`violated` on the numeric surface; a witness that fails either gate is
`inconclusive: witness not confirmed`, never a violation. A counterexample found
under `--free` is `design-admitted` — exit 2, never exit 1 — because a `=` value
is a binding the model states.

**What the two engines agreeing does and does not establish.** With `--free
none` the SMT engine answers the question `checkConstraints` answers, and
`test/integration/verification.differential.test.ts` asserts they agree on every
encodable relation of both examples, all 82 campaign fixtures and the L8 corpus
models: `proved` ⇔ `satisfied`, `refuted` ⇔ `violated`, and `unknown` ⇔
`inconclusive: not evaluable`. But that gate compares **two consumers of one
gatherer** — a relation neither surface gathers is absent from both and the gate
is green. So the **relation census** in the same file accounts for every
constraint-bearing user element as encoded or refused-with-reason and asserts
the counts equal the element census; a relation that leaves the pipeline without
a word said about it fails there. Neither mechanism is a claim that the gatherer
reads every construct the standard defines.

**`consistency` answers a different question, and may say `consistent` only
with the count of what it left out.** `verify` asks whether each requirement
holds of the design the file describes; `consistency` asks whether the
requirements on a subject could be met by any design at all, and the two
disagree by construction on a file whose values break a requirement. By default
every feature carrying a literal value is RELEASED and only the structural
axioms are asserted — `assert constraint` bodies, `bind` equalities, the
defining equations of derived features — because a requirement set is
inconsistent when nothing satisfies it, and answering that with the values that
happen to be in the file is a question about one design point;
`--with-values` re-pins them and asks the weaker question, and every verdict
line names the mode. Each requirement is asserted as `A ⇒ G`, one
implication per guarantee under that requirement's assumptions — the reading
`Requirements::RequirementCheck` states and the one `verify` uses on the same
file, named on every verdict line. Read as `A ∧ G` instead, two requirements
guarded by mutually exclusive `assume` clauses (a mode- or phase-conditional
pair) would be reported as contradictory, which they are not: no single design
point is ever required to meet both. A set of implications is satisfiable by
making every antecedent false, so each requirement that carries assumptions is
also asked whether it can be ENGAGED at a point the whole set admits. A set that
holds only because a requirement in it never applies is reported `inconclusive`
under `verification/vacuous` — exit 2, forgiven by no flag — which is §2's rule
that vacuity is inconclusive always, applied one level up; the witness is still
published, because the set is satisfiable and only its meaning is in doubt.
Mutually exclusive modes pass that check and two requirements under the same
assumption with colliding guarantees do not, which is the discrimination the
implication reading buys. An `assume` clause a gate refused stands the
whole requirement down rather than being dropped from the antecedent, since
`G` alone is the stronger claim and the model does not make it. On `unsat` the tool reports the conflicting subset z3's
core produced, named by requirement and by the qualified name and element id of
each relation, under `verification/inconsistent-requirements` — an error, exit
1, forgiven by nothing. That subset is called **a conflicting subset**: only
`--minimize`, having run its deletion loop to completion, may call it minimal.
On `sat` the design point is substituted back through the tool's own evaluator
before it is printed. A relation a gate refused is listed and not asserted,
which is sound in one direction only — an inconsistency found without it stands,
a set called consistent without it may not — so the refused count is printed
beside every verdict. A subject whose requirements state no relation this lane
encodes is `inconclusive`, never consistent, and a run in which nothing at all
was decided is exit 2 with `--allow-inconclusive` and without it. There is no
point-evaluation counterpart for this question, so an absent backend decides
nothing and exits 2.

**What `consistency` is not.** It decides the satisfiability of static
contracts. Whether a reactive implementation can be built to meet a
specification over time is a different question, is a declared non-goal of the
verification plan (§6), and no surface of this tool claims it.

Evidence records bind a claim to a canonical model digest taken over **qualified
names, never element ids** (ids are fresh UUIDs on every load), to the tool
version, and to the flags that changed what was shown. They carry no timestamp,
so they are byte-stable across runs. Their shape is
[`schemas/evidence-record.schema.json`](schemas/evidence-record.schema.json),
and every record the corpus produces is validated against it.

**A record can now be written into the model**, as a
`@SysproseVerification::Evidence { … }` annotation on the requirement it is
about — §7.27's annotating form over a metadata definition, which is the
notation's own extension point and not invented syntax. Three properties of that
write path are asserted rather than asserted about. The model digest **excludes
what a verification run itself wrote** — the `Evidence` carrier, everything under
it, and the `verdict` cell beside it — so a freshly attached record is `current`
while an edit to any part of the author's own model — a literal, a `status`
facet, a new part — still moves it. That exclusion is drawn by **shape, not by
provenance**: every `verdict` cell on a requirement's facet carrier is out of the
hash, including one a person typed on a requirement that never carried evidence,
because nothing in the file marks which of the two wrote it. The consequence is
stated rather than hidden — a hand-raised verdict is caught by
`verification/verdict-overstates-evidence`, which compares the facet against the
record's claim, and not by the digest. Every other facet a requirement carries —
`status`, `risk`, `owner`, `rationale` — stays in the hash. The `verdict` facet
is **derived** from the record's claim on every path, and is never copied from
the `verdict` field a record states: a `--engine literal` record, whose claim is
`holds-at-values`, writes `inconclusive` however its own JSON is spelled, and
`evidence-attach` refuses a `--from` file whose stated verdict does not follow
from its claim rather than half-trusting it. `pass` is written for `proved`
alone. A requirement that states several obligations carries **the worst of
them**, so one clause's `pass` can never overwrite another clause's `fail` and
the verdict does not depend on the order the clauses were written in. And
evidence **accumulates**: a second run appends, a `fail` is never overwritten by
a `pass`, and every verdict a run moved is printed with both claims.

**A verdict that outlived its model is a warning on the ordinary path.**
`validation/stale-evidence` fires from `npm run check`, not only from the
verification lane, because the next person to open the file runs the checker. It
names the requirement's slice — the declarations to re-read — and states on every
finding that a whole-model digest cannot say WHICH element moved. Two further
states are reported by name and never silently: a `verdict` facet with no record
behind it (`verification/claimed-without-evidence`, info — a verdict reached by
inspection is ordinary requirements management) and a `verdict = "pass"` over a
claim that is not `proved` (`verification/verdict-overstates-evidence`, error).

**Measured, and it is a negative result:** what another tool makes of a Sysprose
evidence record or verdict facet. The verdict facet is an unbound tag holding a
quoted string where the standard has an enumeration on a different metaclass — a
conforming SysML v2 reader is entitled to ignore that line, and the one that was
asked did. §6.1 records the probe: pushed to the public OMG pilot on 2026-09-09,
the model came back with its 19 ids, 19 metaclasses, 14 names and 18 containment
edges intact and **every tool-local value dropped** — both `verdict` cells and
all 1466 characters of the record. Nothing was misread and no verdict was
invented; the evidence's contents simply did not travel. (Whether the carrier
ELEMENT survived is the one row that probe cannot take, and §6.1 says why.)
Inside Sysprose the write path holds — the same fixture through the same client
against our own server keeps all of it — so the boundary is the reader, not the
writer. The digest also catches model edits, **not a hand-edited record**.

### 8.3a `--why` — an unsat core is a sufficient reason, and it is shown rather than recorded

`verify … --engine smt --why` names the members of the unsat core the solver
returned for each `proved` row: the axioms, the goal, and the side conditions the
encoding added, each with the kind it was asserted under. Three things about it
belong here rather than in a release note.

**It is not the set of assumptions the claim depends on, and the tool never says
it is.** A core is *a* sufficient reason, chosen by the solver. Measured on
`test/fixtures/verification/models/three-reasons.sysml`, where `mtow` is bound at
18.5 kg and capped at 20 and at 22: the core for `mtow <= 25.0 [kg]` names
`mtowCapB` — the **weakest** of the three sufficient facts — and does not name
the model's own value at all, and swapping the two caps' declaration order does
not move the pick. So an axiom listed may not have been needed and an axiom
**not** listed may still carry the claim; that sentence prints beside every core
the command names, and the words *depends on* appear on no `--why` line.

**A side condition is kept, and it shares its name with an axiom.** The encoding
asserts a non-zero divisor where a relation divides by a variable, labelled with
the qualified name of the row it guards. On `examples/uav-isr.sysml` the
endurance proof's core carries both `axiom:…AirVehicle::endurance` and
`side:…AirVehicle::endurance`, so a display filtered to axioms — or one
deduplicating by qualified name — would drop a real dependency of that proof.

**It is displayed and counted, never recorded.** No evidence record carries a
core and `schemas/evidence-record.schema.json` is unchanged, because the
membership of a core is the solver's choice and not a property of the model.
**What was measured, stated as the observation it is:** on
`examples/uav-isr.sysml`, one file and one seed, the endurance proof's core is
six labels in a fresh process, and five — the same four axioms and the goal,
without the side condition — when the same obligation is judged inside a test
worker running the whole verdict corpus of
`test/campaign/verification.test.ts`. What differs between those two runs is not
established: a probe that repeats the same call, and one that judges every model
in that corpus first, both return the six in one process. The observation is
what this section rests on; the mechanism behind it is not offered. Both cores
are sufficient, neither is wrong, and a record quoting either would break the
promise that two runs over an unchanged file write byte-identical evidence. That
is also why **this commit's three `proved` fixture goldens did not move**,
against its own plan entry, which asked for their `detail` to be re-recorded with
the core in it: the plan's ordering decision is that a core is displayed and not
recorded, and `detail` is copied verbatim into every evidence record, so writing
one there would have recorded it through the back door and made the golden a
golden over solver state. What `--json` does carry, per
obligation, is the axiom census `{modelAxioms, footprintAxioms, scriptAxioms,
coreAxioms}` — how far the answer narrowed, which is a question about a model and
is worth asking of one before any feature is built on it. Measured today: no
narrowing at all on `examples/uav-isr.sysml` (4 core axioms of a 4-axiom
footprint), and 24 footprint axioms to 9 core axioms over the six obligations of
`examples/uav-power-budget.sysml`. The census is four numbers rather than the
three the plan named, because a published numerator with no denominator cannot
be read, and because `scriptAxioms` and `footprintAxioms` do not bracket each
other in either direction: a kept row that divides by a variable asserts twice,
and a kept row the encoder refused asserts nothing. `coreAxioms` is read against
`footprintAxioms`.

**And the member list itself is in the `--json` payload on every run**, with the
flag and without it — the flag gates the text display, not the field. The
sufficiency sentence is printed under every core on the text path; in the payload
it exists only as the field's description in
`docs/schemas/verify-report.schema.json`, so a consumer that renders these
members carries that sentence itself.

The flag decides nothing. The claim word, the code and the exit status of a run
are the same with it and without it — and a run that reached no proof says so in
a sentence about proofs, because two other cores in this lane print on rows of
their own: the one under `verification/inconsistent-axioms` is about the whole
file's axiom set and the one under `verification/vacuous` is about one
obligation's premises.

### 8.3b `property-check` — what the five gates establish, and what they do not

`property-draft` and `property-check` stand **before** the engines: they judge a
clause an agent proposes, never the model, and neither of them writes anything.
Both obey the reporting exit contract for that reason — a refused clause is an
answer about a string the caller passed and exits **0**, with the verdict in the
report — because §2 reserves the judging contract's exit 1 for an obligation
refuted at the model's own values and nothing else.

Gate 0 refuses a clause whose `scope` is not `global`, whose `timing` is not
`always`, or that writes a `condition` at all: those three FRETish fields state
something about *time*, and no in-process engine in phases 0–3 of this plan
decides a temporal claim. It is a **refusal**, not an acceptance with a gap.
Gates 1–3 are the tool's own gates — `parseRelationBody`, resolution in the
subject's scope, then `evaluateConstraintQuantityDetailed` and `readRelation` —
so a clause this command accepts is one the SMT encoder can read; a private
re-implementation of any of them would let `property-check` accept what `verify`
then refuses.

**Gate 4 is SYNTACTIC non-triviality, and this is the limit.** The clause and its
negation are checked satisfiable under z3 **with no axioms asserted at all**, so
a clause the model's own feature values already satisfy passes it:
`uav.mtow <= 25.0 [kg]` is accepted over a model that pins `mtow = 18.5 [kg]`.
What the gate refuses is a clause that is valid or unsatisfiable *on its own*
(`x <= x`). `verify`'s tautology check and the vacuity report are what decide the
other question. The limit is printed on every report rather than left to be
inferred, and it is one of the two limits in the §6 register that this command
carries.

**Nothing here reads prose, and no report ever says a clause is the
formalisation a requirement asked for.** Every report — text and JSON, accepted
or refused — carries the same fixed line: *"meaning is not checked; read the
back-translation."* The back-translation into structured English is the only
defence the tool offers against a clause that parses and means the wrong thing,
and reading it is the author's job. `scripts/agent-repair-bench.ts --suite
verification` measures how much of the gate surface a model clears from the draft
alone; it deliberately does not score meaning.

### 8.3c `refine` — whose obligations these are, and what γ is allowed to assert

`refine --via composition` decides Cimatti's Theorem 1, **in normal form**, over
a decomposition the model states with `satisfy`. With `nf(C) = ¬A ∨ G` the two
obligations are **(3)** `⋀ nf(C′) ∧ γ ⊨ nf(C)` and **(4)**, for each component
*U*, `A ∧ ⋀_{S′≠U} nf(C′) ∧ γ ⊨ A_U`; both are preceded by a satisfiability
precondition, **step (0)** `check(A ∧ ⋀ nf(C′) ∧ γ)`.

**Normal form is a soundness requirement, not a presentation choice.** With bare
guarantees the static check admits mutual support: A₁ = G₂ = p and A₂ = G₁ = p
against a system contract ⟨true, p⟩ makes `G₁ ∧ G₂ ⊨ G` provable while an
implementation with `p` false satisfies both component contracts and breaks the
system guarantee. `cofer-2012`'s soundness argument for the bare form rests on a
temporal order a static check does not have; this tool does not borrow it, and
the case is pinned as a known-answer model.

**Step (0) is what stops a contradiction proving an architecture.** Sub-contracts
⟨true, x > 10⟩ and ⟨true, x < 5⟩ over one bind class make the antecedent of (3)
unsatisfiable, so (3) holds vacuously; the run reports
`verification/contract-set-vacuous`, exit 2, and never `refined`. Vacuity is one
claim word and one exit code across this whole lane (§2), and no flag lowers it.

**γ is `bind` ∪ the item flows, and that is a deliberate reading with recorded
counter-evidence.** The connection assertion is built from the
`bind`/`BindingConnector` equalities and from the directional item flows
`propagateValues` already carries, encoded as `target = source` — the same edges
`checkConstraints`, the app and every other report honour, so a proof here cannot
rest on an equality the rest of the tool does not believe. A bare `connection` is
**refused**: it is listed under `notEncoded` with the hint *bind the attributes if
they are one quantity*, and the count travels with every verdict.
`--connections-as-equalities` opts into the OCRA reading and prints the fact on
every verdict line. **`cristoforetti-2026` §4.1 — the one published SysML v2 →
OCRA path — translates `connect` and `bind` alike**, and Cimatti's γ is by
definition the connection-and-delegation assertion, so the default here is a
*stricter* reading than the published path takes rather than a consensus. It is
recorded as a choice, not as a fact about the standard.

**What it never claims.** Nothing about ordering or time: this is the
propositional and numeric shape of contract refinement, not OCRA's temporal one,
and every verdict line says so. No report says "the architecture satisfies its
requirements"; none says `refined` while an obligation is undecided; none says
`refined` when the antecedent of (3) or (4) is unsatisfiable.

**A refused clause, and which half of the contract it came from.** Any refused
clause on a **system** contract stands its whole decomposition down as
`verification/refinement-undecided`, because dropping a conjunct of `nf(C)` would
weaken the goal being proved. On a **component** contract the two halves of
`nf(C′) = ¬A ∨ G` move in opposite directions, and the tool treats them so: a
refused `require` conjunct only weakens that component's normal form, which a
proof survives, while a refused `assume` conjunct *strengthens* it — dropping
`a₂` turns `¬a₁ ∨ ¬a₂ ∨ G` into `¬a₁ ∨ G`, and with every `assume` refused the
normal form collapses to a bare `G`, which is the axiom "this component promises
its guarantee unconditionally" that the file never stated. So a component with a
refused `assume` is kept **out of the premise set** — the only sound premise for
a normal form with an unknown conjunct of `A` is `⊤` — and its own obligation (4)
is `verification/refinement-undecided`, which stands the group down. Both facts
are reported either way. `test/fixtures/verification/models/refinement-refused-clause.sysml`
pins both directions.

**What the delegation half costs, stated rather than hidden.** A constraint body
reaches a nested quantity through the *type* of each part, while a connector
endpoint written as `a.p` resolves to a usage-scoped implicit copy that keeps
`connect a.p to b.p` from collapsing into a self-edge. The two spellings denote
different elements, so an equality over the second joins nothing the contracts
talk about, and a decomposition wired that way reports its assumptions as
undischarged rather than proving them. `examples/uav-power-budget.sysml` names the
definitions' features in its bindings for exactly that reason, and says so in its
own doc comment. Closing the gap would need a delegation term in γ that the plan
does not specify; until it does, the failure direction is the conservative one.

### 8.3d `fault-tree` — what a cut set is a claim about, and the four it never makes

`fault-tree` injects contract failures into the decomposition §8.3c judges. A
basic event is **"sub-contract *i* not honoured"**, and a set *F* is a **cut
set** exactly when obligation (3) — `⋀ nf(C′) ∧ γ ⊨ nf(C)`, the same obligation,
the same normal form, the same γ — **fails** with the normal forms in *F* out of
the premise set. That is `stewart-2021`'s fault injection into an AGREE contract
and `bozzano-2014`'s basic event, and the enumeration goes through one seam into
the refinement module rather than transcribing the normal form a second time: a
fault tree over a second reading of `nf(C) = ¬A ∨ G` would enumerate cut sets of
an architecture the other command never judged.

**Cut sets are minimal, bounded and counted.** Sets are enumerated by increasing
order up to `--max-order` (default 2); every superset of a cut set is pruned
rather than checked, because withdrawing more guarantees cannot restore an
obligation that already failed; and the number of solver checks is printed.
Pruning removes the supersets of sets *shown* to be cut sets, never those of a
set the solver did not answer about — such a superset is still a cut set, but
its minimality was never established, and the row says so rather than calling it
minimal. A `@SysproseVerification::FaultHypothesis { maxOrder = 2; }` carrier
pins the bound **in the model** — `rauzy-2019`'s point that the safety model and
the design model stay separate and are synchronised by something written down —
and the flag overrides it, with the report naming which of the four the number
came from. Both cell spellings are read, with and without the `attribute`
keyword; a cell that cannot be read is reported as such rather than passed off
as the default.

**The four sentences it never writes.** *No cut set* over a **vacuous** contract
set: obligation (3) cannot fail from an unsatisfiable antecedent, so step (0)
runs first and a contradiction is `verification/contract-set-vacuous` at exit 2
(§8.3c's rule, one lane along). *No single point of failure* when any order-1
check was **undecided**: the field is `null` rather than `false` there, and there
is no `--allow-inconclusive` on this command to forgive one. **Any** undecided
check spends the 2, including one that sits inside a tree whose enumeration also
found cut sets — that tree is not an undecided *tree*, so the undecided *checks*
are counted in their own figure and tested before the `return 0`. An **absence
without its bound**: "no cut set up to order 2 — higher orders not explored" is
the whole sentence, and §6's register lists it beside "no violation within k".
And an **empty cut-set list over a state machine**: a `StateUsage` passed as
`--element` is refused by name, with a pointer to `check-behaviour` emitted only
when that row exists in the build.

**What it is, said on every report.** Contract-level fault-tree analysis over
the refinement obligations — **not** a behavioural safety analysis, and nothing
about ordering, time, rates or probabilities. The model states no failure rates
and this tool derives none: a cut set here is a structural statement about which
contract failures suffice, and an order-2 cut set is what redundancy looks like
from the failure side rather than a finding against the design.

### 8.4 The SMT seam: the solver backend and the encoder the engine stands on

`z3-solver` ^5.2.0 is an **optional** dependency. `src/semantics/smt/z3-bridge.ts`
loads it through a dynamic import behind a variable specifier and answers either
a backend or `{ absent, reason }` — it never throws because a package is
missing, and `SYSPROSE_NO_Z3=1` forces the absent path so that a machine which
HAS z3 can still exercise it. Every check is bounded (5000 ms by default, no
spelling for "unbounded"), the `random_seed` is fixed at 0, and z3's version is
captured rather than assumed. A script z3 REFUSES — a malformed term, or a
`set-logic` its assertions do not fit — is reported as `error`, never folded
into the `unknown` that `--allow-inconclusive` may forgive.

`src/semantics/smt/encode.ts` turns a body the unit gates already passed into an
SMT-LIB2 script. Four properties of that encoding belong in a conformance record
because they decide what a later verdict means:

- **One variable per feature, declared in its STORAGE unit, read as
  `factor·x + offset`** from the gates' own `ScaleMap`. When the gates granted
  no scaling — `range = 5.0 [km]` compared against a bare `10.0` is read in
  kilometres on every surface of this tool — the read is the bare symbol.
  Scaling there would report `5000 <= 10` for a constraint that holds.
- **Numerals are exact rationals.** Every numeral in a BODY is the binary64
  this tool holds, converted exactly through its significand: `18.5` is
  `(/ 37.0 2.0)` and `0.1` is `3602879701896397 / 2⁵⁵`, not the tenth that was
  typed. Nothing is rounded on the way into a solver, and nothing is re-parsed
  from a decimal — so the number z3 reasons about is the number
  `checkConstraints` evaluates. The author's own `attrs.valueText` IS the right
  reading for a feature's declared value, and `valueTextNumeral()` is the
  affordance for it; it is deliberately not applied to body literals, because an
  axiom and a goal that disagreed about a boundary number would decide the
  boundary case by which side of the proof the number arrived on. The engine
  that builds feature-value axioms is a later commit and is its only caller.
- **Symbols and assertion labels are qualified names, never element ids** (ids
  are fresh UUIDs per load). Two loads of one file produce byte-identical
  scripts. A consequence stated rather than hidden: two distinct PATHS that
  resolve to one feature — `u.powerIn.voltage` and `u.powerOut.voltage`, one
  attribute owned by a `port def` — share one symbol, which is how every other
  surface of this tool reads them too.
- **The fragment is checked by z3, not asserted by us — and the report's word
  and the script's logic are different questions.** The script carries a
  `set-logic` line (`QF_LRA` / `QF_NRA`, and their mixed integer/real forms
  `QF_LIRA` / `QF_NIRA` when an `Int`-sorted feature is declared) computed from
  the SYNTAX of the terms it emits, because that is what z3 checks it against: a
  product or a quotient of two declared features is a nonlinear SCRIPT whether
  or not an axiom pins one of them, and a `QF_LRA` header over it is refused
  outright — reported as `error`, i.e. as a defect in our own output, never as
  an inconclusive row a flag could forgive. The REPORT's `qf-lra` / `qf-nra`
  vocabulary stays free-relative, as the plan words it: freeing a divisor
  promotes `qf-lra` to `qf-nra` and the encoding names the variable that did it.
  `%`, a variable or fractional exponent, a string, `null`, a division by the
  literal zero, a degenerate unit scale, and a sort clash are each refused with
  the same branchable `reason` vocabulary the rest of the lane uses.

**What ships over it.** The SMT engine (`src/semantics/engines/smt.ts`) drives
this seam as of commit 5 of the verification plan; §8.3 above states what it may
and may not claim. The seam's own rules are unchanged by that, and they are what
keep an engine defect from reading as a verdict.

**Not in the browser, and the build enforces it.** z3 WASM needs
`SharedArrayBuffer`, i.e. COOP/COEP headers a static host cannot set, so the
package is excluded from the bundle (`optimizeDeps.exclude` and
`rollupOptions.external` in `vite.config.ts`) and nothing in `src/` imports it
statically. `external` alone would point the wrong way for an import — it leaves
a bare `z3-solver` specifier in the emitted chunk, which builds green and breaks
the published page at load time — so a `refuse-bundled-z3` build plugin fails
the build when any emitted chunk names the package in an import or a require.
The app's affordance is the terminal command, not a smaller solver.

**Measured on this machine, not remembered** (Node 22, z3 5.1.0 via `z3-solver`
5.2.0): `init()` **~105 ms**, three checks (unsat, negation-unsat, sat with a
witness) **~137 ms** — the plan carried one combined figure of 343 ms and could
not say which half it was. The two SMT suites were run under vitest's default
worker pool and under a single fork: **66 passed both ways, 5.4 s against 7.1 s
wall clock**, and they add ~5 s to `npm test`. z3 WASM is worker-safe here, so
the suites are NOT pinned to one worker. The cost the plan asked to be known
rather than assumed is contention, and it is visible: inside the FULL suite (137
files across the default worker pool) the same two figures measure **311 ms and
358 ms**, with no change to any verdict. A related figure, measured because a
later commit's call counts depend on it: **one z3 context is reused across
checks and only the solver is fresh**, because a context per check leaks ~9 MB
of WASM heap that nothing gives back — 400 checks cost 2 GB before the fix and
~140 MB after, and a suite case runs 200 checks against a stated bound. `npm
test` itself is **296 s** on this machine, past the plan's 241 s budget; the SMT
suites are ~5 s of it, so that overrun is not theirs to fix.

**Re-registered at commit 5, same command, same machine** (§6 asks for the wall
clock before and after, not for a promise). Measured with `/usr/bin/time npx
vitest run`: **287 s** over 137 files with the engine present and none of its
suites written, and **351 s** over 138 files with all of them — a **+64 s**
delta, on a run that also went from 2 533 tests to 2 581. The engine's own cost
is the differential gate and the relation census, which load 103 models and run
BOTH engines over each (**~18 s** measured on their own), plus the sixteen SMT
cases the L8 corpus gained and four single-field mutation cases. The last 18 s
of the delta arrived with the adversarial review, which added four L8 cases on
the gate-refused seam and widened the flag-scope sweep from the encodable rows
to every censused one. The budget the
plan set was 241 s and this build does not meet it: the overrun predates the
engine — 296 s was already registered at commit 4 — and it is recorded rather
than rounded away.

**Re-registered again at commit 6**, same command, same machine: **374 s** over
the same 138 files, a **+23 s** delta on a run that went from 2 581 tests to
2 595. Almost all of it is the process boundary rather than the solver: the four
new L7 cases each spawn `tsx` and bind the standard library (~6 s apiece), while
the eight new L8 consistency cases run in process and cost **~2.4 s** between
them. The budget is still 241 s and this build still does not meet it, for the
same reason and by the same accounting.

**Where the budget actually went, and the one file that was spending it.** By
the end of the lane the gate's wall clock was not the solver and not the
engine: it was `test/campaign/cli.sysprose.test.ts`, which spawned `npx tsx
scripts/sysprose.ts` **240 times** — a node, a tsx transform of the
whole import graph and a bind of the 38 761-element library apiece — and ran
**787 s of a 790 s run**. Every other file in the suite finished in parallel
underneath it, so the gate cost what that one file cost, and every commit after
it paid the bill again. The cases now ask what they are asserting: the ones
about the PROGRAM (exit status, `-` on stdin, a payload past the pipe buffer, an
unknown flag or subcommand, an unreadable or unwritable file, every `--help`, an
invocation through a symlinked path, the one nonlinear optimisation whose memory
is unbounded, and one end-to-end run per exit contract) still spawn — **82
spawns, down from 240** — and the ones
about the TEXT call the same `main` in this process, which `scripts/sysprose.ts`
now exports and runs only when it was run as a script. A bridge case spanning
all 22 subcommands runs the same argv both ways and requires the same bytes and
the same code, so the equality the split rests on is checked rather than
assumed.

**Both spawn figures are counts of processes actually started**, not of the
places in the source that say to start one: `spawnSync` was wrapped in that file
and the calls logged, once over the file as it stood at `c929278` and once over
the file as it stands now. The distinction is not pedantry — several call sites
sit inside loops. The figure this section published before, 223, was a count of
`run([` lines in the source, and the run it described started 240
processes.

The wall clock was taken the same way at both ends, one file at a time
(`npx vitest run test/campaign/cli.sysprose.test.ts`), each started with
`ps -eo pid,args | grep "[v]itest"` showing nothing on the machine but the run
about to begin: **772.77 s over 96 cases before, 268.50 s over 99 cases after**
— the same assertions over the same models, at a little over a third of the wall
clock. Neither figure is delicate. The before run had another worktree's suite
join it partway through, and the same file measured 776.44 s on a machine that
was running four of them for its whole length: half a percent apart, because
what this file spends is serial process startup rather than CPU, and startup
does not contend.

**A first cut of this split was faster and unsound, and the number it produced is
recorded here so nobody chases it again.** Moving EVERY case in-process reached
322.96 s at the gate — and produced five `Aborted(Runtime error: The application
has corrupted its heap memory area (address zero)!)` unhandled errors from
`z3-solver`'s WASM module over 70 in-process solver calls. z3 carries
process-global state and does not survive being driven many times inside one
worker; the subprocess boundary had been supplying that isolation for free, and
converting the calls removed it silently. vitest's own warning for that condition
is the point — an unhandled error of this kind "might cause false positive
tests", so the failure mode is a GREEN run, not a red one. A solver-bearing
subcommand therefore spawns, for the same reason `-` does: not because the
assertion is about the process, but because the invocation needs one. Under
`SYSPROSE_NO_Z3` no solver loads, so those cases stay in-process.

At the gate the change reads as **760.83 s → 548.74 s** for `npx vitest run`
(145 files, 3 000 tests, 0 failed, 0 solver aborts), both measured on an idle
machine with `ps` showing no other vitest process. This one file is still the
longest pole. Measured on the tree that ships this: 48 call sites spawn because
what they assert is the process contract, 70 more are routed to a spawn at
invocation because their subcommand can load the solver, and 113 run in-process.
Neither spawning set is available to trade — one is the contract, the other is
the isolation.

### 8.5 `check-behaviour` — what a safety verdict is a verdict about

**Nothing here is a claim about the specification's execution semantics.** The
engine is a walk of the configuration graph the *interpreter in this repository*
defines, and every verdict it prints carries the six-field semantic profile that
says what that interpreter does — run-to-completion bounded at 64 chase steps,
innermost-substate priority, shallow history by parent map, regions concatenated
rather than interleaved, **no event pool at all**, and a discrete `after(n)`
clock the walk over-approximates by offering each label as an event. `andre-2023`
§2.6's point is that every published formalisation of state-machine semantics
differs on exactly those six, so a verdict that did not name its reading would be
one nobody could reproduce or contest. PSSM is not implemented and no conformance
with it is claimed.

**Which properties it decides, and which it refuses.** Four patterns —
`absence`, `universality`, `bounded-existence`, `precedence` — are safety
properties, and a bad-prefix search over a finite graph decides them. Two —
`existence`, `response` — are liveness, and a bad-prefix search finds no bad
prefix for either on any graph; both report `inconclusive: liveness not checked
in-process` until a lasso search lands and a fairness assumption is named. A
`pass` is emitted only when the walk saw the graph **whole**: the four conditions
§3.8 states, computed from `exploreMachine`'s walk, **and** the fifth this tool
added afterwards — every guard the walk consulted decided something. A bound hit,
a parallel or history machine, a guard the walk could not evaluate, an unreadable
property or an atom that names nothing is `inconclusive` ⇒ exit 2. A **fail**
does not need exhaustion, and the asymmetry is deliberate: a bound can hide a
violation and can never invent one.

**Those five conditions have exactly one definition, and the claims this lane
makes are a list a test can walk.** `publishabilityOf` in
`src/semantics/mc/publishable.ts` is the conjunction both `reach` and
`check-behaviour` read — the same four conjuncts off the same walk, plus the
product-search conjunct only the second of them has, which is a field a
walk-only claim does not carry rather than a `false` it would print "bound
exhausted" from. Beside it sits `walkIsExact`, a second and stricter predicate
for a different kind of claim and one nothing in the tool reads yet: an absence
list gets **smaller** as edges are added, so a walk that offers more edges than
the machine grants cannot invent one, while *"nothing here is inescapable"* gets
**easier** to state as edges are added and the same over-approximation falsifies
it. Two registers, `ABSENCE_CLAIMS` and `WITNESS_CLAIMS`, record which of the two
each claim reads, which way it moves as edges are added, and what is published
instead when its condition fails; `test/unit/semantics.mc.publishable.test.ts`
asserts the wiring by reflection, so a claim added without a condition is a
failing test rather than a review comment. Nothing about the standard is claimed
by any of this: it is a record of what THIS tool's walk may and may not say.

**The declared deviation of §8.1 extends to this command, in the same words.** A
property whose antecedent never holds is `vacuous` ⇒ inconclusive ⇒ exit 2, not
true — the two antecedents this engine detects are a scope no explored run opens
and a `precedence` whose P never occurs. Sub-formula-replacement vacuity is not
done. `--strict-vacuity` raises the row to `verification/vacuous-property`, an
error, and changes no exit code. The verdict vocabulary is four words — `pass`,
`fail`, `vacuous`, `inconclusive` — and this command never says `proved`, never
says `verified` and never says `deadlock-free`.

**The property carrier is Sysprose's, not the specification's.**
`@SysproseVerification::PropertyPattern { attribute pattern = …; }` is §7.27
annotating metadata over a `metadata def` this tool ships as text, exactly as the
evidence carrier is (§7). A conforming external reader may ignore it entirely,
and nothing is claimed about what another tool makes of it.

### 8.6 The vocabulary this lane reads, and the vocabulary it writes

Scattered across §7 and §8 this is already true; gathered in one place it is
checkable. The rule the two tables encode: **the lane reads the notation's own
constructs and writes almost nothing back**, and the little it writes is one
standard annotation plus tags that are visibly this tool's.

**Read — the specification's own constructs, taken at their own meaning.**

| Construct | What the lane does with it |
|---|---|
| `RequirementDefinition` / `RequirementUsage`, and their `subject`, `assume`, `require`, `objective` clauses | The contract: `assume` is the premise, `require` the promise, `subject` who both are about. Nothing is inferred that the clauses do not say. |
| `objective` on a `CaseDefinition`/`UseCaseDefinition`/`VerificationCaseDefinition` and their usages | A contract on a behaviour, with the subject **defaulted** to `Case::result` per the shipped `Systems Library/Cases.sysml` and **bound** to the case subject per `VerificationCases.sysml` |
| `Satisfy`, `Derive`, `Refine`, `Verify` | Who claims to discharge what, and in which direction — `Derive` is read source = original, target = derived |
| `ConstraintUsage` bodies, feature values, `ISQ` typing and unit literals | The relations that are encoded, scaled to coherent SI; a construct outside the encodable fragment is `verification/unsupported-construct`, named (§8.3) |
| `VerificationCases::VerificationMethod` and `VerificationMethodKind` | The gate of §8.2b: a case without `analyze` in its list is not judged at all |
| `VerificationCases::VerdictKind` literals | **Mirrored as strings** in the values the `verdict` facet may take. It is not a `VerdictKind` reference and does not pretend to be (§8.2). |
| Any `#keyword` over a `metadata def`, ours or a third party's | Inventoried with what it resolves to, and never acted on by accident (§7) |
| `@SysproseVerification::FaultHypothesis { maxOrder = N; }` | **Read, never authored** — a tag of this tool's own that a reviewer writes, carrying an ASSUMPTION and never a result: how many independent contract failures are credible at once. The bound it states overrides the built-in one, and a carrier this tool cannot read is reported as provenance rather than passed off as a default (§8.3d) |

**Written — one standard annotation, and three tags that are this tool's.**

| Written | Whose vocabulary | Where it is justified |
|---|---|---|
| `@VerificationCases::VerificationMethod { attribute kind = analyze; }` on a case that stated no method | **The specification's**, and the only standard element this lane writes | §8.2b |
| `metadata RequirementMetadata { attribute verdict = "…"; }` | **Tool-local.** `RequirementMetadata` has 0 occurrences in Part 1; the identifier resolves to nothing, and the value is an unbound quoted string | §8.2 |
| `@SysproseVerification::Evidence { … }` | **Tool-local**, §7.27 annotating metadata over a `metadata def` this tool ships as text | §8.3, and the interop measurement in §6.1 |
| `@SysproseVerification::PropertyPattern { … }`, `metadata def <exceptional> ExceptionalOutcome` | **Tool-local**, the same mechanism, and named as an extension everywhere they appear | §7, §8.5 |

**What a carrier BODY may say, and the one spelling it may not.** A vocabulary is
a `metadata def` *and* the cells its annotation body carries, and the second half
is as hard to withdraw as the first, so the shapes are recorded here and pinned in
`test/unit/semantics.keywords.test.ts` rather than left to be discovered by
whoever writes the next carrier. A set is **one cell holding a `;`-delimited
list**, and the delimiter with the spacing around it comes back from a save
byte-identical. **Both spellings of a cell are read**: the ordinary §7.27
annotation body `{ maxOrder = 2; }`, which the parser stores as a keyword-less
`ReferenceUsage`, and `{ attribute maxOrder = 2; }`. A carrier this tool sees and
cannot read is reported as **provenance** — the run says a carrier is present and
was not read — instead of being attributed to a default, because the bound is the
same number either way and the sentence about where it came from is not. The
spelling that is **not** available is the repeated same-named cell:
`validation/duplicate-name` files an error on each sibling, so a file spelled that
way cannot appear in any model that passes `npm run check` — and a command handed
one prints the errors above its report and exits non-zero, reporting on what
parsed rather than reading the repeated cells as a set.

Everything else the lane produces — verdict lines, SMT-LIB, Othello, SMV, Lean
skeletons, evidence JSON — leaves the model alone and lands in the terminal or
in a file. No command in this lane edits a requirement's text, a constraint or a
value.

---

## Mapping to OMG conformance statements — and the honest gaps

| OMG conformance area | Addressed by | Honest gap |
|---|---|---|
| **Textual notation parsing** | Langium grammar; **100 % corpus parse**; full textual round-trip stability | Parse + full round-trip are closed; the residual is deep formal-semantics corners, not grammar coverage. |
| **Model interchange** | element-graph `api-json` validates against the OMG JSON Schema; XMI library ingest (38.8k elements); **self round-trip over HTTP** via `PilotApiClient` | No XMI *export*; interchange identity is the element-set multiset, not byte-for-byte; no live OMG pilot-server round-trip exercised offline (see §6). |
| **API PSM (REST + Query)** | 10 live endpoints validated against OpenAPI 3.1; versioning/Query engine; **concurrent-writer commit serialization** (`test/server/concurrency*`); **interop client** round-trips over HTTP (§6) | OpenAPI surface is representative (25 paths), not every endpoint/param. |
| **Annotation vocabulary (§7.27 keywords)** | Prefix keywords are read, resolved against the `MetadataDefinition`s in scope and preserved verbatim through a save (`src/semantics/keywords.ts`); Sysprose's own `#exceptional` ships as text a user pastes, over the mechanism §7.27.1/§7.27.4 defines | **The vocabulary is Sysprose's, not the specification's**, and the tool says so on every line that prints one. A third-party spelling is read only through a declared alias table, contributes to no worklist unless `obligations --from-keywords` asks it to, and is never reported as standard; `hasKeyword` — what a later engine asks — answers only from real resolution, so an alias hit is never mistaken for the shipped keyword. `#observable` is designed and deliberately unshipped. |
| **OSLC PSM** | OSLC Core catalog/provider/query + Turtle/RDF-XML/JSON-LD + **`oslc:ResourceShape` full-shape resources** (`test/server/oslc-shapes`) | A representative subset of the OSLC SysML PSM (no delegated dialogs). |
| **Requirements — contracts and obligations** | `contracts` / `obligations` read `RequirementDefinition` / `RequirementUsage` clause roles and case `objective`s into an assumption/guarantee inventory and a proof worklist (`src/semantics/contracts.ts`, `src/semantics/obligations.ts`) | **These commands report structure only.** They evaluate nothing and decide nothing: no solver stands behind them, and neither prints a word about whether a requirement holds. A clause an element INHERITS is disclosed and never filed. On a row whose element also wrote a clause of its own, the inherited one is listed marked `(inherited)`, under a count that says how many of the clauses shown the element itself wrote and which element wrote each of the others; on a row whose element wrote none — `requirement massOk : MassLimit;`, the ordinary way to apply a requirement — the row names the definition the clauses are filed on instead, exactly as it always did. Either way it enters no worklist, moves no obligation digest and reaches no evidence key: the clause is filed once, on the element whose body holds it, so a requirement USAGE is still not read through its definition's clauses (the definition carries its own contract, and the usage's row names it rather than being counted as bodiless). Only a clause some contract in the same run FILES is disclosed — a general type the run left out, a `#prose` statement or a clause written outside a case's `objective`, is disclosed nowhere. The `variables` and `fragment` a row carries are its declared clauses' and are labelled `declared` wherever an inherited clause is shown beside them; an attribute declared in a `port def` is one element however many ports reach it, so the variables a clause reads are reported per PATH and their `in`/`out` direction is taken from the port the path names; `discharged` and `stale` are declared in the status vocabulary and never produced, because both are read back from an evidence record that does not ship yet. |
| **Requirements — verdicts (`verify`)** | `verifyModel` judges each obligation with a named engine — a point evaluation (`src/semantics/engines/literal.ts`) or negation-UNSAT in z3 (`src/semantics/engines/smt.ts`) — and writes an evidence record bound to a canonical model digest (`src/api/verification.ts`, `src/api/evidence.ts`); §8 above states the exit contract, the deviation and the two unbound slots | **One declared deviation** (a requirement with a false assumption is `vacuous`, not true — §8.1) and **one slot deliberately unbound** (`VerificationCase::verdict` — §8.2). `proved` is reachable only under `--engine smt`, only as UNSAT-of-negation over a satisfiable axiom set with satisfiable premises and a two-sided domain, and only for the quantifier-free arithmetic fragment the unit gates pass — anything else is inconclusive with a code, and a missing solver is exit 2 rather than a fallback. The two engines are held to one answer by a differential gate over the whole fixture corpus, and every constraint-bearing element is accounted for by a relation census; neither says the gatherer reads every construct the standard defines. What an external tool makes of a record or a verdict facet is untested. |
| **Safety — cut sets from contract-failure injection (`fault-tree`)** | Minimal cut sets over the refinement obligations of §8.3c, enumerated by increasing order with supersets pruned and the check count reported (`src/semantics/fault-tree.ts`); §8.3d above states what a cut set claims and the four sentences the command never writes | **Contract-level FTA, never a behavioural safety analysis**, and every report says so. No failure rates, no probabilities and no importance measures: the model states none and none is derived. Every absence carries the order it was checked to; a vacuous contract set is reported as vacuous and never as "no cut set"; an undecided order-1 check forbids the no-single-point claim; a state machine is refused rather than answered with an empty list. The order bound is an assumption about how many failures are credible at once, carried in a Sysprose metadata definition, and what an external reader makes of that carrier is untested. |
| **Behaviour — bounded safety verdicts (`reach`, `check-behaviour`)** | An explicit walk of a state machine's configuration graph, exploring every enabled transition where the simulator takes the first (`src/semantics/mc/`), with safety patterns decided by bad-prefix search over it; §8.5 above states the profile, the split and the exit contract | **This is a reading of THIS tool's interpreter, not of the specification's execution semantics**, and every verdict prints the six-field profile it holds under. PSSM is not implemented and no conformance with it is claimed. Liveness is not decided in-process; a parallel or history machine is refused rather than walked; a bound hit empties the unreachable and dead lists and can never produce a pass — it does NOT empty the deadlock rows, which are about a configuration the walk already dequeued and offered every input at, and which a bound cannot make wrong; and a guard the walk consulted and could not evaluate withholds all three of `reach`'s absence claims outright (`verification/guard-undetermined`) rather than reading “did not evaluate” as “is false”, and makes `check-behaviour` report `inconclusive` rather than `pass` or `vacuous`. Every edge-bearing element under a machine is accounted for by a census as walked, read by the opening, refused, with neither end a node the walk can stand on, or as no step at all (a typing, a subsetting, a `connect` — facts about the states rather than steps between them) — and an edge that sequences behaviour and that the relation does not hold (one carrying a payload today, an unforeseen spelling tomorrow) refuses the machine rather than shrinking its absence lists; both spellings of a state-to-state edge, `transition` and `first … then …`, are walked. The property carrier is a Sysprose metadata definition, and what an external reader makes of it is untested. |

**The load-bearing gap.** The interop client round-trips **fully** against our own
spec-shaped server (§6), and against the live OMG pilot it round-trips a read and
a `Package` write but **not what this tool annotates a model with**: the
verdict-bearing probe of §6.1 is refused as written and, repaired, comes back
with every tool-local value dropped. So the gap is no longer "untested" — it is
**measured, and negative for the evidence record**. Re-run it with
`SYSMLV2_PILOT_URL` set and `npx tsx scripts/pilot-write-roundtrip.ts`. We
validate against the published
**specifications and schemas** (clean-room) and our own spec-shaped server, not a
running OMG reference implementation. Each pillar is a faithful, load-bearing
subset per `docs/TEST-REPORT.md` §8; the honest residual is the deepest
**formal-semantics** corners, not breadth. Nothing here is a conformance claim:
Sysprose has never been conformance-tested by the OMG or anyone else.

---

## How to reproduce

```bash
cd sysprose

# Full unit + integration + conformance suite (3074 pass / 0 skip, 146 files)
npm test                    # === npx vitest run

# Just the conformance scorecard suite (71 pass, 4 files)
npx vitest run test/conformance --no-coverage

# Interop self round-trip over HTTP (8 pass, 1 file)
npx vitest run test/interop --no-coverage

# Real .kerml/.sysml corpus parse rate (100 %)
npx tsx scripts/grammar-coverage.ts

# Self round-trip against our own OMG server (push→pull, 13 elements EQUIVALENT)
npm run interop             # or: npx tsx scripts/pilot-roundtrip.ts

# Live-pilot round-trip (requires a reachable OMG SysML v2 pilot server)
SYSMLV2_PILOT_URL=https://pilot.example/api SYSMLV2_PILOT_TOKEN=… npm run interop

# Live-pilot WRITE probe — what a foreign reader does with a verdict (§6.1)
npx tsx scripts/pilot-write-roundtrip.ts

# Networked API / OSLC server (manual smoke)
npm run serve               # then GET /api/... and /oslc/...

# End-to-end (128 tests across 78 spec files)
npm run test:e2e
```
