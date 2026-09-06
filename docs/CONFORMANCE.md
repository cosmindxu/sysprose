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
| Full automated suite | **2533 passed / 0 failed / 0 skipped** across **137 files** + **128 E2E** across **78 spec files** = **2661 green** (measured 2026-09-06) |
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

> **Honest caveat.** The live round-trip is now exercised (above) and passed, but
> it is a **representative** exchange (one `Package` written; a bounded 300-element
> read), not a full-model bidirectional migration — pushing arbitrary models needs
> containment expressed as reified `OwningMembership` payloads, which this minimal
> proof did not exercise. Also, the pilot does not support project deletion
> (`DELETE /projects/:id` → 500), so one clearly-named `sysprose-interop-test-*`
> project remains on that public demo server. Point `SYSMLV2_PILOT_URL` at any
> conformant pilot to reproduce.

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

### 8.3 What the engines may and may not claim

`--engine literal` evaluates the model's own feature values through the same
`checkConstraints` surface the app's **Analyze** button uses. Its claim word is
`holds-at-values` and it can never reach `proved`, which is reserved for
UNSAT-of-negation under a satisfiable axiom set. `--engine auto` resolves to the
SMT engine or reports `verification/tool-absent` for every obligation, exit 2;
it never falls back to a point evaluation. **No SMT ENGINE ships in this build**,
so every `auto` and `smt` run today is exit 2 — which is the honest answer, and
is exercised on every run of the L8 corpus with `SYSPROSE_NO_Z3=1`. The solver
BACKEND now ships (§8.4): `z3-solver` is an optional dependency and
`loadZ3()` returns it, but nothing drives it yet, and a backend with no engine
behind it decides nothing. `verification/tool-absent` says which of the two is
missing.

Evidence records bind a claim to a canonical model digest taken over **qualified
names, never element ids** (ids are fresh UUIDs on every load), to the tool
version, and to the flags that changed what was shown. They carry no timestamp,
so they are byte-stable across runs. Their shape is
[`schemas/evidence-record.schema.json`](schemas/evidence-record.schema.json),
and every record the corpus produces is validated against it.

**Untested, and stated as such:** what another tool makes of a Sysprose evidence
record or verdict facet. The write path is tested only inside Sysprose. The
interop probe that would answer it is a later commit of the plan; until it runs,
no claim is made about what an external reader does with either.

### 8.4 The SMT seam: a solver backend, an encoder, and no engine yet

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

**What ships and what does not.** The seam is tested; there is no engine over it.
Nothing in this build hands an obligation to z3, so no verdict in this build was
produced by a solver, and none says `proved`.

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
suites are ~5 s of it, so that overrun is not theirs to fix, and the budget is
re-registered at commit 5 with the same command on the same machine.

---

## Mapping to OMG conformance statements — and the honest gaps

| OMG conformance area | Addressed by | Honest gap |
|---|---|---|
| **Textual notation parsing** | Langium grammar; **100 % corpus parse**; full textual round-trip stability | Parse + full round-trip are closed; the residual is deep formal-semantics corners, not grammar coverage. |
| **Model interchange** | element-graph `api-json` validates against the OMG JSON Schema; XMI library ingest (38.8k elements); **self round-trip over HTTP** via `PilotApiClient` | No XMI *export*; interchange identity is the element-set multiset, not byte-for-byte; no live OMG pilot-server round-trip exercised offline (see §6). |
| **API PSM (REST + Query)** | 10 live endpoints validated against OpenAPI 3.1; versioning/Query engine; **concurrent-writer commit serialization** (`test/server/concurrency*`); **interop client** round-trips over HTTP (§6) | OpenAPI surface is representative (25 paths), not every endpoint/param. |
| **Annotation vocabulary (§7.27 keywords)** | Prefix keywords are read, resolved against the `MetadataDefinition`s in scope and preserved verbatim through a save (`src/semantics/keywords.ts`); Sysprose's own `#exceptional` ships as text a user pastes, over the mechanism §7.27.1/§7.27.4 defines | **The vocabulary is Sysprose's, not the specification's**, and the tool says so on every line that prints one. A third-party spelling is read only through a declared alias table, contributes to no worklist unless `obligations --from-keywords` asks it to, and is never reported as standard; `hasKeyword` — what a later engine asks — answers only from real resolution, so an alias hit is never mistaken for the shipped keyword. `#observable` is designed and deliberately unshipped. |
| **OSLC PSM** | OSLC Core catalog/provider/query + Turtle/RDF-XML/JSON-LD + **`oslc:ResourceShape` full-shape resources** (`test/server/oslc-shapes`) | A representative subset of the OSLC SysML PSM (no delegated dialogs). |
| **Requirements — contracts and obligations** | `contracts` / `obligations` read `RequirementDefinition` / `RequirementUsage` clause roles and case `objective`s into an assumption/guarantee inventory and a proof worklist (`src/semantics/contracts.ts`, `src/semantics/obligations.ts`) | **These commands report structure only.** They evaluate nothing and decide nothing: no solver stands behind them, and neither prints a word about whether a requirement holds. A requirement USAGE is not read through its definition's clauses (the definition carries its own contract, and the usage's row names it rather than being counted as bodiless); an attribute declared in a `port def` is one element however many ports reach it, so the variables a clause reads are reported per PATH and their `in`/`out` direction is taken from the port the path names; `discharged` and `stale` are declared in the status vocabulary and never produced, because both are read back from an evidence record that does not ship yet. |
| **Requirements — verdicts (`verify`)** | `verifyModel` judges each obligation with a named engine and writes an evidence record bound to a canonical model digest (`src/api/verification.ts`, `src/semantics/engines/literal.ts`, `src/api/evidence.ts`); §8 above states the exit contract, the deviation and the two unbound slots | **One declared deviation** (a requirement with a false assumption is `vacuous`, not true — §8.1) and **one slot deliberately unbound** (`VerificationCase::verdict` — §8.2). The only engine that ships evaluates at the model's own values, so its claim is `holds-at-values` and never `proved`; the z3 backend and the encoder ship (§8.4) and no engine drives them, so `--engine auto` and `--engine smt` are exit 2 with `verification/tool-absent`. What an external tool makes of a record or a verdict facet is untested. |

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

# Full unit + integration + conformance suite (2533 pass / 0 skip, 137 files)
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
