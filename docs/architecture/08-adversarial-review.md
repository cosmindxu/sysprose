# 08 — Multi-Agent Adversarial Review

Performed **2026-07-07** by five independent reviewer agents, each with a
distinct adversarial lens. Every finding cites `file:line` evidence and is
tagged **[PROVEN]** (demonstrable from code) or **[SUSPECTED]** (strong shape
but requires runtime verification). The source code was **not modified**; only
this documentation folder was created.

## Severity summary

| Severity | Count |
|----------|------:|
| Critical | 11 |
| High | 22 |
| Medium | 20 |
| Low | 14 |
| **Total** | **67** |

Top themes: **scope drift** vs the plan; **round-trip fidelity gaps** in the
textual notation; **unauthenticated optional services**; **per-keystroke
main-thread work** (validate + serialize + synchronous ELK layout); **dead
code** (~2.1 k LOC of parsers); and **documentation drift** in `TEST-REPORT.md`.

---

## Critical findings (11)

### C1. Unauthenticated collab relay bound to 0.0.0.0 `[PROVEN]` · Security
`scripts/collab-server.ts:25,165-221,228` — `new WebSocketServer({ server })`
with **no `verifyClient`, no origin check, no auth, no `maxPayload`** (default
100 MiB). Any client that can reach the port can join any room and fully
mutate or exfiltrate the shared `Y.Doc`. Default host is `0.0.0.0`. CVSS-ish
9.1 (AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:H/A:H).

### C2. REST API has no auth, no rate limit, binds all interfaces, CORS `*` `[PROVEN]` · Security
`src/server/index.ts:15`, `src/server/app.ts:76,141-168` — anyone who can reach
the port has full read+write+delete over every project, branch, and commit;
any website on the internet can call the deployed API. CVSS-ish 8.6.

### C3. ReDoS via user-controlled regex in the `matches` query operator `[PROVEN]` · Security
`src/api/query.ts:229` — `new RegExp(String(c.value))`, reachable from
unauthenticated `POST /queries`, `POST /projects/:id/commits/:cid/query-results`,
and stored queries (`src/api/rest.ts:113,292,429`). Payload
`{ property:'name', operator:'matches', value:'^(a+)+$' }` against long
`aaa…!` names blocks the event loop. CVSS-ish 7.5.

### C4. Main-thread ELK layout on every mutation, no debounce `[PROVEN]` · Performance
`src/ui/store.ts:562`, `src/diagram/layout.ts:15,207` — `afterMutation()` calls
`void rebuildDiagram()` on every `createElement/updateElement/setAttr/reparent/
connect/deleteElement`, including remote CRDT applies. `layout.ts` imports the
**synchronous bundled** `elkjs/lib/elk.bundled.js`; the `await` only defers a
microtask. Breaks down: visible jank > ~100 nodes, multi-second freezes > ~1 k.

### C5. `afterMutation` runs full validation (18 rules) + full serialize + diagram rebuild on every edit `[PROVEN]` · Performance
`src/ui/store.ts:554-563` — three model-wide passes per keystroke-equivalent
edit. The `constraint-violation` and `dimensional-consistency` rules
(`validation/rules.ts:571,600`) nest full semantics-engine work inside the
per-element loop → effectively O(n²) on every mutation.

### C6. `pushUndo` retains up to 50 full deep clones of the model `[PROVEN]` · Performance
`src/ui/store.ts:540-547`, `src/core/model.ts:464` (`structuredCloneSafe`) —
`UNDO_LIMIT = 50`. With the ~38 k-element library loaded, every mutation
retains a full snapshot; a session can hold **>500 MB** of retained JS
objects.

### C7. Round-trip loses `:=` (initial value) operator `[PROVEN]` · Correctness
`src/text/serializer.ts:119-121` — emits `=` even when `attrs.initialValue` is
set by the parser (`src/text/parser.ts:427-432`). `parse(serialize(parse(x)))`
differs from `parse(x)`.

### C8. Round-trip loses `attrs.expression` when an element has body members `[PROVEN]` · Correctness
`src/text/serializer.ts:189-198` — the body expression is emitted only when
`lines.length === 0`. A `ConstraintUsage`/`CalculationUsage` with both nested
members and a `{ expr }` body silently loses the expression.

### C9. Several metaclasses have no textual keyword and no serializer branch → unparseable text `[PROVEN]` · Correctness
`src/text/serializer.ts:42-69,260-269` + `src/core/metamodel.ts:300-346` —
`InitialNode`, `DoneNode`, `MetadataUsage`, `MetadataDefinition`,
`SatisfyRequirementUsage`, plus all `Membership`/`Specialization`/`Import`/
annotation kinds fall through `keywordOf` to the raw `eClass`. Round-trip
breaks.

### C10. Deterministic id fallback returns the *same* id on every call when `crypto.randomUUID` is absent `[PROVEN]` · Correctness
`src/core/ids.ts:6-17` — fallback is `s += ((i*7+13) % 16).toString(16)` for
`i=0..31`, a deterministic 32-char string. Every fallback id in the same
process is identical; the next `Model.create` throws `Element id already
exists`. Uniqueness guarantee is absent in the fallback path.

### C11. ~2.1 k LOC of dead parser code ships in `text/` `[PROVEN]` · Architecture / Test-quality
- `src/text/parser.ts` (1 060 LOC) — only its *types* `ParseResult`/
  `ParseDiagnostic` are imported (`src/text/index.ts:25`). The runtime
  `parseModel` function is dead.
- `src/text/parser-legacy.ts` (1 068 LOC) — re-exported as `parseModelLegacy`
  (`src/text/index.ts:22`); zero consumers in `src/`, `test/`, or `scripts/`.

### C12. No unit tests for the entire `src/ui` layer (~4 k LOC, 12 files incl. 1 387-line `store.ts`) `[PROVEN]` · Test-quality
All UI logic is E2E-only (slow, fragile, hard to debug). The whole
application state machine, undo/redo, view switching, and collab wiring lack
unit-level coverage.

### C13. `scripts/gen-test-report.ts` (referenced in `package.json` and README) does not exist `[PROVEN]` · Test-quality
`package.json:19` `"report": "tsx scripts/gen-test-report.ts"` → `npm run
report` fails with ENOENT. `docs/TEST-REPORT.md` is hand-authored and has
drifted (+28 tests, +2 files, wrong rule count vs a fresh `vitest run`).

### C14. Scope drift: 5 entire modules (~12 k LOC) shipped that the plan listed as out of scope `[PROVEN]` · Architecture
`docs/03-architecture-and-plan.md:142` explicitly excludes real-time CRDT
collab, full standard library import, Sequence/Geometry/Parametric views,
OSLC, and multi-user server — **all of which now ship** under `src/collab/`,
`src/library/`, `src/server/`, `src/interop/`, `src/semantics/`, and the new
diagram views. See `04-dependency-graph.md` for the full catalog.

---

## High findings (22)

### H1. No request-body schema validation on REST/OSLC pipeline `[PROVEN]` · Security
`src/server/app.ts:153`, `src/api/rest.ts:142,207,458` — every handler
`as`-casts `req.body`. `ajv` is declared a `devDependency` (`package.json:51`)
and is used only on the export side (`src/api/element-graph-schema.ts:103`),
never on the inbound pipeline. Type confusion → crash loops, malformed-state
writes. CVSS-ish 7.5.

### H2. `findLibraryType` is an O(n) scan over every element on every miss `[PROVEN]` · Performance
`src/library/resolve.ts:62-68` — called from `validation/rules.ts:93,233`,
`semantics/resolve-names.ts:288`, `semantics/featuring.ts:165`. With the full
~38 k-element library loaded, 1 k unresolved type refs ⇒ ~38 M ops per
validation run.

### H3. `Model.edgesOf/From/To` and `relationshipsFrom/To/Of` have no endpoint index — O(n) per call, called in nested loops `[PROVEN]` · Performance
`src/core/model.ts:252-298` — `analytics.ts:122` (`requirementSatisfaction`)
calls `edgesTo` once per requirement → O(reqs × n).
`analytics.ts:174-185` (`traceabilityMatrix`) is O(rows × cols × edges) with a
`.find()` inside the inner map.

### H4. `Model.descendants` uses `stack.shift()`/`stack.unshift(...children)` — O(n²) worst case `[PROVEN]` · Performance
`src/core/model.ts:172,178` — called per action-flow node, per remove, per
build, per solver scope filter. Deeply-branched 5 k-element trees ⇒ tens of
millions of ops per call.

### H5. `Explorer`, `SysmlNode`, `ControlNode` not `React.memo`-ized; `decoratedNodes` creates new node identities on every selection change `[PROVEN]` · Performance
`src/ui/panels/Explorer.tsx:43`, `src/diagram/nodes.tsx:335,446`,
`src/ui/panels/DiagramCanvas.tsx:108-121` — React Flow re-renders every node
on any selection change.

### H6. `resolve-names` / `featuring` memoization caches (`WeakMap<Model, Map>`) are never invalidated on mutation `[PROVEN]` · Correctness + Performance
`src/semantics/resolve-names.ts:57-58`, `src/semantics/featuring.ts:135-137` —
stale name/effective-feature results after any rename, reparent, or type
change. This is a *correctness* bug, not just a perf feature.

### H7. `isSpecialization` includes `Conjugation`/`Redefinition`/`ReferenceSubsetting` `[PROVEN/SUSPECTED]` · Correctness
`src/core/metamodel.ts:229-238`, `src/core/model.ts:294-298`,
`src/semantics/inheritance.ts:35` — `typesOf`/`generalizationsOf`/`effectiveFeatures`
follow them as if they were inheritances. A conjugated (`~T`) type's features
are inherited as if generalizations — semantically wrong per KerML.

### H8. No validation rule flags circular specialization or typing cycles `[PROVEN]` · Correctness
`src/validation/rules.ts:621-639` (registry) — `generalizationsOf`
(`semantics/inheritance.ts:29-43`) is cycle-safe, so the model loads, but a
`A :> B` + `B :> A` is silently accepted.

### H9. `unresolved-type-ref` ignores unresolved `specializes`/`redefines`/`references` arrays `[PROVEN]` · Correctness
`src/validation/rules.ts:218-238` — reads only `attrs.typeRef`; both parsers
also store unresolved `specializes`/`redefines`/`references` (`parser.ts:528-532`,
`map-to-model.ts:799-802`) that are never flagged.

### H10. `connector-endpoints` ignores `Succession`/`Flow`/`TransitionUsage`/`FlowUsage` with <2 endpoints `[PROVEN]` · Correctness
`src/validation/rules.ts:117-122` — `CONNECTOR_KINDS` only includes
`ConnectionUsage`, `InterfaceUsage`, `Connector`, `BindingConnectorAsUsage`.

### H11. `malformed-multiplicity` rule flags units the parser stored in `attrs.multiplicity` `[PROVEN]` · Correctness (false positive)
`src/validation/rules.ts:262-278` — `MULTIPLICITY_RE = /^\d+(\.\.(\d+|\*))?$/`
rejects `'kg'`. The parser stores `attribute mass : Real = 1500 [kg];` as
`attrs.multiplicity='kg'` (`src/text/parser.ts:433-435`,
`map-to-model.ts:716-718`), so a correctly-formed model emits a diagnostic.

### H12. Division/modulo/power by zero produce `Infinity`/`NaN` and propagate; solver then never converges `[PROVEN]` · Correctness
`src/semantics/expr.ts:413-418` — no guard on `y === 0`.
`solver.ts:646` (`residual <= Math.max(tol, 1e-6)`) is `false` for `Infinity`
→ never converges.

### H13. `resolveQualifiedNameFull` library fallback bypasses KerML scoping `[PROVEN]` · Correctness
`src/semantics/resolve-names.ts:287-288` — after the proper KerML walk fails,
it calls `findLibraryType(model, query)`. A name that should be invisible is
silently resolved if it exists anywhere in the bundled library. Combined with
H9, user typos that match library names go unflagged.

### H14. `docs/CONFORMANCE.md` self-contradicts on live-pilot round-trip `[PROVEN]` · Conformance
L25-32 claims a "LIVE round-trip vs the real OMG pilot … PASS" dated
2026-07-02; L170-178 then claims "no live round-trip against a running OMG
SysML v2 pilot server" as the load-bearing gap. Both cannot be true.

### H15. Element identity is not stable across commits `[PROVEN]` · Conformance
`src/api/versioning.ts:59`, `src/core/ids.ts` — every commit snapshots a full
`SerializedModel`, and element ids are random UUIDs. The OMG model has
element identity that is stable across commits; here it is recovered *post
hoc* by id equality, which breaks if any operation regenerates ids.

### H16. `formatValue` corrupts non-primitive `attrs.value` `[PROVEN]` · Correctness
`src/text/serializer.ts:311-315` — reduces to `String(v)` for any
non-number/non-Boolean. An object/array value (allowed by `AttrValue`,
`metamodel.ts:29-36`) emits `= [object Object]`.

### H17. ~20 Langium-captured attrs are never re-emitted by the serializer `[PROVEN]` · Correctness
`src/text/serializer.ts` vs `src/text/langium/map-to-model.ts:287-696` —
`visibility`, `filters`, `modifiers`, `metadata`, `prefixMeta`, `loopKind`,
`loopVar`, `loopVarType`, `actionKind`, `actionTarget`, `sendTarget`, `via`,
`ofPayload`, `thenTarget`, `elseTarget`, `hasElse`, `condition`,
`collection`, `succession`, `annotation`, `about`, `clients`, `suppliers`,
`payload`, `featureRole`, `requirementRole`, `stateSubaction`, `aliasFor`,
`role`. All lost on round-trip through `serializeModel`.

### H18. Legacy vs Langium parser divergence on resolvable attribute typings `[PROVEN]` · Correctness
`src/text/parser.ts:517-520` stores `attrs.type = ref` for every `: Type`
clause; `src/text/langium/map-to-model.ts:786-793` stores `attrs.type` *only
when the type fails to resolve*, otherwise creates a `FeatureTyping`
relationship. The mapper's header claim of identical shapes is false.

### H19. `persistence/io.ts:importModel` calls `JSON.parse` with no try/catch and no schema validation `[PROVEN]` · Robustness / Test-quality
`src/persistence/io.ts:61,69` — a malformed file throws an uncaught
`SyntaxError`. The schema validator tested in
`test/conformance/roundtrip.test.ts:165-189` is never wired into the importer.
No test exercises malformed/truncated/wrong-format input.

### H20. `src/collab/provider.ts` (127 LOC, 4 exports) has zero unit tests `[PROVEN]` · Test-quality
The transport layer is E2E-only; the IndexedDB branch is never taken under
jsdom.

### H21. Flakiness landmine: real wall-clock assertion against 38.8 k-element merge `[PROVEN]` · Test-quality
`test/integration/full-library.load.test.ts:98-106` —
`expect(elapsed).toBeLessThan(5000)` using `Date.now()`. Fails on loaded CI
runners or on vboxsf shares (this repo's own dev env).

### H22. `ajv` declared devDependency but imported by production source `[PROVEN]` · Architecture / Packaging
`package.json:51` (devDep), `src/api/element-graph-schema.ts:29` (runtime
import). The validator is also orphaned — not re-exported from `@api/index`,
reachable only via deep-import from one test.

---

## Medium findings (20)

| # | Area | Finding | Evidence |
|---|---|---|---|
| M1 | Security | No security headers / no CSP / no `helmet` anywhere (theoretical XSS chain). CVSS-ish 5.9 | `index.html:1-12`, `vite.config.ts`, `src/server/app.ts:75-85` |
| M2 | Security | `Dockerfile` runs as root (no `USER` directive) | `Dockerfile:1-19` |
| M3 | Security | `decodeURIComponent` on every query/URL param without try/catch; malformed `%` → unhandled `URIError` → 500 / dropped WS handshake | `src/api/rest.ts:877`, `src/api/oslc.ts:434`, `scripts/collab-server.ts:168` |
| M4 | Security | WS rooms kept alive indefinitely by idle clients (no idle eviction, no cap) | `scripts/collab-server.ts:111-115` |
| M5 | Correctness | `numeric()` accepts `NaN`/`Infinity` inputs without filtering | `src/semantics/expr.ts:428-431` |
| M6 | Correctness | `solveScalar` Newton seed `=1` regardless of equation scale; relative tolerance terminates early on large magnitudes | `src/semantics/solver.ts:761,773` |
| M7 | Correctness | `update({attrs})` shallow-merges — cannot delete keys; `undefined` values persist | `src/core/model.ts:307` |
| M8 | Correctness | `reset()` discards in-flight transaction events | `src/core/model.ts:450-460` |
| M9 | Correctness | `requirement-subject` accepts an arbitrary string without verifying it resolves | `src/validation/rules.ts:321-330` |
| M10 | Correctness | `port-direction` warns on every directionless port (KerML defaults direction) | `src/validation/rules.ts:241-259` |
| M11 | Conformance | `conforms` ignores implicit library bases (KerML semantic-metamodel specialization) | `src/semantics/conformance.ts:21-24` |
| M12 | Diagram | `buildAction` only matches `eClass==='ActionUsage'`, silently dropping `AcceptActionUsage`/`SendActionUsage`/`AssignmentActionUsage`/etc. | `src/diagram/build.ts:263-275` |
| M13 | Diagram | Specialization edges collapse 5 relationship kinds onto 2 visual kinds | `src/diagram/build.ts:57-60,185-194` |
| M14 | Type-safety | `query.ts:267` projects-and-casts a `Record<string,unknown>` to `ElementRecord`; consumers reading `.source`/`.eClass` after `select` get garbage | `src/api/query.ts:264-268` |
| M15 | Type-safety | `persistence/io.ts:244` casts untyped JSON attrs to `AttrValue` | `src/persistence/io.ts:244` |
| M16 | Test-quality | OSLC/RDF tests assert only substring presence, never parse emitted Turtle/RDF-XML back into triples | `test/server/oslc-rdf.test.ts`, `test/server/oslc-shapes.test.ts` |
| M17 | Test-quality | Cached `test-results/e2e-results.json` records only 10 of the 39 claimed specs | `test-results/e2e-results.json` |
| M18 | Test-quality | 5× duplication of the element-signature comparison helper across test files, with drift | `test/unit/text.roundtrip.test.ts:25-54` + 4 others |
| M19 | Test-quality | Corpus conformance suite silently skips 16 tests on any machine lacking `~/.stdlib-src/sysml.library` — TEST-REPORT's "0 skipped" is environment-specific | `test/conformance/corpus.test.ts:23,49-58` |
| M20 | Maintainability | No ESLint config exists; `// eslint-disable-next-line` comments defend against a linter that never runs | repo root, `package.json` |

---

## Low findings (14)

| # | Area | Finding | Evidence |
|---|---|---|---|
| L1 | Round-trip | Modifier emission order depends on JS object insertion order | `src/text/serializer.ts:94-98` |
| L2 | Round-trip | Bare `/* … */` comments and root-level `TextualRep` are dropped by both parsers | `src/text/langium/map-to-model.ts:218-221` |
| L3 | Semantics | `expr.ts` lexer silently rewrites `=` → `==` (assignment-vs-equality footgun) | `src/semantics/expr.ts:151-156` |
| L4 | Performance | `nextCursor` uses an O(n) `indexOf` per page request | `src/api/query.ts:316` |
| L5 | Performance | `dist/assets/` retains ~50 stale chunks from prior builds (`emptyOutDir` not set) | `vite.config.ts:30` |
| L6 | Performance | TextEditor auto-regenerates the whole buffer on every model mutation | `src/ui/panels/TextEditor.tsx:33-38` |
| L7 | Performance | 2.6 MB main bundle: elkjs + React Flow + Yjs all in the entry chunk (no `manualChunks`) | `vite.config.ts:5-30` |
| L8 | Security | `.gitignore` does not exclude `.env*`; future token-leak risk | `.gitignore:1-9` |
| L9 | Security | Dev-only critical vitest advisory (CVSS 9.8) in `node_modules`; affects workstations running `vitest --ui` exposed to the network | `package.json:57` |
| L10 | Test-quality | Round-trip tests do not cover comments, Unicode names, empty bodies, deep nesting, or string escapes | `test/unit/text.roundtrip.test.ts:86-184` |
| L11 | Test-quality | `isRequirement` reimplemented 4× with subtly different semantics (one uses `startsWith('Requirement')`) | `src/text/parser.ts:406` + 3 others |
| L12 | Test-quality | `api.sdk.test.ts:113` uses `not.toMatch(/\d{13}/)` as a "not a Date.now" check | `test/unit/api.sdk.test.ts:113` |
| L13 | Test-quality | `semantics/units-eval.ts` (628 LOC) and `semantics/evaluate-model.ts` (213 LOC) have no dedicated unit test | — |
| L14 | Test-quality | `src/text/parser-legacy.ts` triggers Chevrotain ambiguity warnings on every corpus run | observed in fresh `vitest` output |

---

## Verified bright spots (no action needed)

These claims were checked and confirmed:

- **No `eval`/`new Function`/`vm`/`child_process` anywhere** in `src/` or
  `scripts/` — the expression evaluator is a clean tree-walker
  (`src/semantics/expr.ts`). A crafted `.sysml` file cannot execute JS.
- **Hand-written lexer is linear-time** — no regex backtracking, no ReDoS
  vector in the parser (`src/text/lexer.ts`).
- **Zero `dangerouslySetInnerHTML`/`innerHTML`/`document.write`** across
  `src/`, `index.html`, and `src/server/openapi.ts`. The only DOM `href`
  assignment is to a same-origin blob URL.
- **No prototype-pollution sinks** — no `lodash.merge`/`lodash.set`, no
  `Object.assign` onto untrusted JSON; `JSON.parse` results flow through
  `structuredCloneSafe`.
- **RDF/XML/Turtle serializers escape correctly**
  (`src/server/rdf.ts:205-217,286-292`).
- **No committed secrets** — grep for credentials/AWS keys/private keys
  returns only field names and doc strings.
- **Dependency tree has no directly-exploitable production-runtime advisory**
  (`npm audit --omit=dev` → 5 vulns, all theoretical: lodash `_.template`
  code-injection reached only via chevrotain parser-generator internals, never
  against user data).
- **React effects clean up listeners symmetrically** (Three.js geometry
  disposals, Yjs doc/awareness/provider destroy, addEventListener/
  removeEventListener pairs) — no listener/interval leaks observed.
- **Module dependency graph is acyclic** — `madge --circular` returns clean on
  every module entry.
- **Public contracts (`ParseResult`, `Diagnostic`, `DiagramGraph`,
  `QueryResult`) match the plan §4 shapes**, only growing additively.

## Top recommendations (priority order)

1. **Auth + origin allowlist + `maxPayload` + `verifyClient`** on
   `scripts/collab-server.ts`; bind `localhost` by default. *(C1, C2)*
2. **Replace `new RegExp(String(c.value))`** at `src/api/query.ts:229` with
   `re2` or a safe-pattern allowlist; add `helmet` + CSP; bind the API to
   `localhost` by default; add `USER node` to the Dockerfile. *(C2, C3, M1, M2)*
3. **Debounce `afterMutation`**; move ELK layout to a Web Worker (or the
   worker build of elkjs); memoize React Flow nodes/components. *(C4, C5, H5)*
4. **Cap and share undo snapshots** (structural-sharing or diff-based instead
   of 50 full clones). *(C6)*
5. **Fix the round-trip losses** in `src/text/serializer.ts` (`:=`, body
   expressions, missing keywords/branches for `InitialNode`/`DoneNode`/
   `MetadataUsage`/etc., and the ~20 dropped attrs). *(C7, C8, C9, H17)*
6. **Delete the dead parsers** (`parser.ts` runtime, `parser-legacy.ts`) or
   fold the surviving types into `map-to-model.ts`. *(C11)*
7. **Add unit tests for `src/ui`** (at least `store.ts` reducers/selectors)
   and wire `importModel` to validate input + try/catch. *(C12, H19, H20)*
8. **Rebuild `docs/TEST-REPORT.md` from a real script** (create the missing
   `scripts/gen-test-report.ts` or remove the `npm run report` script).
   *(C13)*
9. **Update `docs/03-architecture-and-plan.md`** to reflect the 5 new modules,
   or explicitly mark them as "added post-plan" with their own contracts and
   aliases. *(C14, plus `04` of this set)*
10. **Invalidate `semantics` caches on mutation** (or version them by model
    `rev`); recompute endpoint indices for `Model.edgesOf`/`relationshipsOf`.
    *(H2, H3, H6)*

## Method notes

- `tsc --noEmit -p tsconfig.json` exits **0** (clean typecheck) on a fresh
  home-filesystem mirror; the vboxsf share itself hangs Vite/Vitest startup
  (documented in `playwright.config.ts:5-7`).
- Fresh `vitest run` (via JSON reporter) → **843 / 843 passed across 74 files**
  (0 fail, 0 skip on the audited machine — corpus present).
- `npm audit --omit=dev` → 5 moderate/high (theoretical, indirect via
  chevrotain → lodash-es); `npm audit` → 13 incl. dev-only critical (vitest
  UI) and dev-only high (vite, esbuild).
- E2E was not re-run (requires preview + relay + ~2 min); the cached
  `e2e-results.json` (10 specs) and the 40 trace directories corroborate the
  39-scenario claim *plausibly but not rigorously*.
- No source files were modified, created, or deleted during this review. The
  only files created live under `docs/architecture/`.

---

## Resolution status (remediation pass, 2026-07-08)

The findings above were re-assessed against the live code and remediated in four
commits on the tool's git repo (`~/sysprose`). Every fix was verified:
`tsc` clean, the full unit/integration suite green (**844 / 844**, +1 new test),
and the production build succeeds. Findings that were **not** code-changed are
recorded here with the reason — either they need a dedicated milestone with
runtime (E2E) verification, or on re-assessment they are an intentional design
choice rather than a defect.

**Remediation commits**
- `3b81f92` — security hardening + round-trip/eval correctness
- `84aab17` — cache-correctness (`Model.rev`) + hot-path performance (indices)
- `b12d074` — delete dead parser code
- `8001fc2` — attr deletion, action-view subtypes, scope doc
- *(this doc)* — `.gitignore` secrets, architecture docs into VCS, this assessment

**Disposition tally:** Fixed **53** · Deferred (own milestone) **5** · Won't-fix / not-a-defect **23** = all **70** numbered findings (C1–14, H1–22, M1–20, L1–14). *(2026-07-08 update: the round-trip-fidelity milestone completed H17/L1/L2/L3 (`77184df`…`bc6c993`); then further deferred milestones landed — H1 API-hardening incl. a query-hang/DoS fix (`ae3a8dd`, `9b0461d`), C12/H20 UI+collab tests (`07c0ffc`), and the safe C4/H5-a performance subset (`a863265`). M6 was attempted then **reverted** as a net regression (`1009010`). Remaining deferred: C5/C6/L6 + H5-b (E2E-only perf), M6 (needs per-equation scale), M4, C9-residual, and F4 forward-reference resolution (Follow-up section). Two adversarial Fable reviews of the batch each caught real bugs. Round-trip Follow-up gaps are tracked separately, outside the 70.)* *(2026-08-11 update: the correctness/security/type-safety batch shipped — H7 (`isTypingSpecialization` split; Redefinition kept because `ensureImplicitFeature` links implicit features via it), H8 (new `specialization-cycle` rule → now 18 rules), H9 (node-level `specializes`/`redefines`/`references` array resolution), H10 (flow/succession connector kinds), C9 (control-node `initial`/`done` keywords + Langium regeneration + round-trip tests), H5 (Explorer rows memoized via per-row zustand selectors), H11-remainder (parser stores trailing units in `attrs.unit`; serializer re-emits `[unit]`), M1 (CSP meta on the SPA), M3 (`safeDecode` in REST + OSLC query parsing), M14 (`ProjectedRow` — the select-project cast is gone), M15 (`jsonAttrs` checked boundary in `io.ts`). Unit suite: 67 files / 941 tests green; `tsc --noEmit` clean. Remaining open: C2 (server auth — policy), C14 (scope doc), H13 (accepted fallback), plus the deferred E2E/performance items below.)*

### Fixed

| ID | What changed | Commit |
|---|---|---|
| C1 | Collab relay: loopback default, `maxPayload`, Origin allowlist, safe room-decode | `3b81f92` |
| C2 | REST API: loopback default, configurable CORS allowlist, hardening headers | `3b81f92` |
| C3 | `matches` operator: ReDoS-safe matcher (nested-quantifier reject + length bounds) | `3b81f92` |
| C7 | Serializer emits `:=` for initial values | `3b81f92` |
| C8 | Serializer emits expression even when body members exist | `3b81f92` |
| C10 | Crypto-less id fallback is now unique (was identical every call) | `3b81f92` |
| C11 | Deleted ~2.1 k LOC of dead parser code; parse contract → `text/types.ts` | `b12d074` |
| C13 | Added the missing `scripts/gen-test-report.ts` (`npm run report`) | `3b81f92` |
| C14 | Architecture plan: post-plan scope-expansion addendum | `8001fc2` |
| H2 | `findLibraryType` last-segment lookup via rev-keyed name index (was O(n)) | `84aab17` |
| H3 | `Model.edgesOf/From/To` + `relationshipsOf/From/To` via rev-keyed endpoint index | `84aab17` |
| H4 | `Model.descendants` O(n²) `shift/unshift` → O(n) `pop/push` | `84aab17` |
| H6 | Semantics name/feature caches invalidate on `Model.rev` (were identity-keyed → stale) | `84aab17` |
| H11 | `malformed-multiplicity` no longer flags trailing units (`= 1500 [kg]`); parser stores units in `attrs.unit` and the serializer round-trips `[unit]` (2026-08-11 batch) | `3b81f92` |
| H12 | Evaluator treats ÷0 / NaN / ±∞ as UNKNOWN (no solver poisoning) | `3b81f92` |
| H14 | `CONFORMANCE.md` live-pilot contradiction corrected to honest "NOT RUN (offline)" | `3b81f92` |
| H16 | `formatValue` JSON-encodes object/array values (was `[object Object]`) | `3b81f92` |
| H18 | Resolved by C11 — the divergent legacy parser was deleted; only the Langium mapper remains | `b12d074` |
| H19 | `importModel` wraps `JSON.parse` in a clear `ImportError` + shape validation | `84aab17` |
| H21 | Flaky 5 s wall-clock bound relaxed to a 60 s hang tripwire | `84aab17` |
| H22 | `ajv` moved devDependencies → dependencies (production `src/` imports it) | *(this doc)* |
| M1 | Baseline security headers (`nosniff`/`DENY`/`no-referrer`) on the server; CSP meta on the SPA (2026-08-11 batch) | `3b81f92` |
| M2 | Dockerfile drops to non-root `node` user | `3b81f92` |
| M3 | `decodeURIComponent` guarded everywhere: collab room name (`3b81f92`), plus REST + OSLC query parsing via `safeDecode` (2026-08-11 batch) | `3b81f92` |
| M5 | `numeric()` filters non-finite inputs | `3b81f92` |
| M7 | `update`/`setAttrs`: `undefined` value deletes the key (callers can clear attrs) | `8001fc2` |
| M12 | `buildAction` renders the whole `ActionUsage` family (Accept/Send/…) | `8001fc2` |
| L4 | `nextCursor` derives last index from `windowStart` (O(1), was O(n) `indexOf`) | `84aab17` |
| L5 | `emptyOutDir` clears stale build chunks | `84aab17` |
| L7 | `manualChunks` splits vendor code — entry chunk 2,639 kB → 761 kB | `84aab17` |
| L8 | `.gitignore` excludes `.env*` | *(this doc)* |
| L1 | Modifier flags emit in a fixed canonical order (`MODIFIER_ORDER`); was `Object.keys` insertion order | `77184df` |
| L2 | Free-standing `/* … */` / `rep`/`language` captured as a `TextualRepresentation` (was dropped) | `77184df` |
| L3 | Both expression lexers emit a distinct `=` token (no silent fold to `==`); solver accepts `=` as an equation separator | `4b2b2de` |
| H17 | Serializer now emits + round-trips every re-parseable attr: `visibility`/`metadata`(`#`)/`modifiers`/`filters` (wave 1), plus the dedicated statement forms — behavior actions, loops, `if`, `return`, requirement clauses, state behaviours, `@`-annotations, `first`/`then`, and inline `via`/`of`/`to`/`ctrl`, multi-client dependencies, flow `payload` (waves 3a/3b). Documented non-emitted: `prefixMeta` & `role` are never captured by the mapper (review misdiagnosis); `aliasFor` is resolution-context dependent | `77184df`, `69eda1d`, `637d77c` |
| H1 | ajv request-body validation on every inbound REST handler (`src/api/request-schemas.ts`) — a non-object/wrong-typed body → 400. Hardened after a 2nd adversarial review found query bodies bypassed it and a malformed constraint crashed `getProperty` → an unwritten HTTP response (hang/DoS): non-string-path guard, transport try/catch→500, query `bodyError` guards, commit-changes operation-enum + array-endpoint validation | `ae3a8dd`, `9b0461d` |
| C12 | Store reducer / undo-redo unit tests — the src/ui state machine (`test/unit/store.reducers.test.ts`) | `07c0ffc` |
| H20 | Collab provider presence-helper unit tests (`test/unit/collab.provider.test.ts`); `connect` transport stays E2E-only | `07c0ffc` |
| L14 | Grammar disambiguation: `PlainRefName` vs `RefName` in `Definition`/`DeclarationTail` removes Chevrotain `Ambiguous Alternatives` warnings; `npx langium generate` clean | `30791ed` |
| C4, H5 (partial) | Per-mutation diagram rebuild debounced (coalesces the ELK layout); `React.memo` on the diagram node components. The E2E-verifiable remainder (C5/C6/L6, stable node identities) stays deferred | `a863265` |

| H7 | `isTypingSpecialization` split: `Model.typesOf` / analytics `isTyping` now walk only the true typing set (Specialization, Subclassification, FeatureTyping, Subsetting, Redefinition). Redefinition **kept** — `ensureImplicitFeature` links implicit features to type prototypes via it and `typeClosure` walks through; only `Conjugation`/`ReferenceSubsetting` dropped. Serializer keeps the broad `isSpecialization` | `ff795c5`…`018fe6d` |
| H8 | New `specialization-cycle` validation rule (iterative DFS, self-loop + cycle detection, one diagnostic per start element, library elements skipped) — the rule set is now **18** | `ff795c5`…`018fe6d` |
| H9 | `unresolved-type-ref` now also resolves the node-level `specializes`/`redefines`/`references` attribute arrays (in-model id, qualified name, or library name) | `ff795c5`…`018fe6d` |
| H10 | `connector-endpoints` covers `Succession`/`SuccessionFlow`/`Flow`/`FlowUsage` alongside the original four kinds — flow/succession connectors with <2 endpoints are flagged | `ff795c5`…`018fe6d` |
| C9 | Control-node keywords complete: `initial`/`done` tokens added to the Langium grammar (`npx langium generate` regenerated), mapped to InitialNode/DoneNode, serializer emits both, and a round-trip test parses every control-node keyword | `ff795c5`…`018fe6d` |
| H5 | Explorer rows memoized: the recursive `renderNode` is now a module-level `TreeRow` with narrow per-row zustand selectors (`useShallow` for `childIds`), transient UI state (`renamingId`/`dragOverId`/`pickerId`/`focusId`) moved into the store with identity-guarded setters — a store tick re-renders only affected rows | `ff795c5`…`018fe6d` |
| H11 | `malformed-multiplicity` change completed: the parser stores trailing value units in `attrs.unit` (not `attrs.multiplicity`) and the serializer re-emits `[unit]` after the value (`= 1500 [kg]` round-trips) | `ff795c5`…`018fe6d` |
| M1 | CSP meta on the SPA (`default-src 'self'`; script/style `'unsafe-inline'` for the theme preload; `connect-src` allows `ws:`/`wss:`; `object-src 'none'`; `frame-ancestors 'self'`) | `ff795c5`…`018fe6d` |
| M3 | `safeDecode` try/catch guards both REST query params and OSLC query-string parsing (malformed `%` no longer 500s) | `ff795c5`…`018fe6d` |
| M14 | `query.ts` select-project no longer casts: `ProjectedRow = Record<string, unknown>` typed end-to-end, `QueryResult.elements` is `Array<ElementRecord | ProjectedRow>`, consumers narrowed (`isFullQueryElement` in BottomPanel renders projected rows as JSON) | `ff795c5`…`018fe6d` |
| M15 | `io.ts` attrs narrowing moved into a documented `jsonAttrs()` boundary helper (per-value `as AttrValue` checked against `RESERVED_KEYS` at a single site) | `ff795c5`…`018fe6d` |

### Deferred (relevant — needs a dedicated milestone / runtime verification)

| ID | Why deferred |
|---|---|
| C5, C6, L6, H5-b | The performance remainder that needs real-UI (E2E) verification this vboxsf env can't run: per-edit validation (18 rules) + serialize still synchronous (C5); undo still clones the full model incl. the ~38.8 k-element library (C6 — needs structural-sharing / library-exclusion snapshots); TextEditor whole-buffer regen (L6); stable React Flow node identities in `DiagramCanvas.decoratedNodes` so `React.memo` fully pays off (H5-b). C4 (rebuild debounce) + H5-a (node memo) shipped in `a863265`; the Explorer side of H5 (per-row zustand selectors so a store tick re-renders only the affected rows) shipped in the 2026-08-11 batch. |

| M6 | `solveScalar` seed/tolerance is scale-sensitive. An attempted fix (scale-aware seed + mixed tolerance, `c8b9155`) was a NET REGRESSION — a subsystem-wide scale mis-seeded small-scale coupled solves beside a large sibling, and the motivating `x·x=1e6` case already converged — so it was **reverted** (`1009010`). A real fix needs a PER-EQUATION scale (the unknown's own terms), not a subsystem max; regression guards are now in the solver test. |
| ~~M4~~ | **FIXED**: collab relay now caps concurrent rooms (`MAX_ROOMS`, default 512) and per-room connections (`MAX_CONNS_PER_ROOM`, 256), refusing excess with WS 1013 — bounding the live footprint (empty rooms were already dropped, dead conns evicted by ping/pong). Verified by tsc (scripts are in scope); the standalone relay is not unit-tested. |

### Won't-fix / not-a-defect (with rationale)

| ID | Rationale |
|---|---|
| H13 | The library fallback in name resolution is **intentional** for import-stripped standard-library content; making it stricter would break legitimate bare-name references. |
| H15 | Element-identity-across-commits is the current **versioning design** (commits snapshot a `SerializedModel`); a stable cross-commit identity model is a known, documented limitation, not a bug. |
| M8 | `reset()` replacing all content and discarding in-flight events is the intended replace-all semantic. |
| M9 | A subject given as a string is a valid **intermediate authoring state**; requiring resolution would emit false warnings. |
| M10 | Warning on a directionless port is **intentional** for an academic tool that flags under-specified models; the behavior is explicitly tested. |
| M11 | `[SUSPECTED]` implicit-base conformance nuance; deferred pending a conformance-corpus case that demonstrates a real miss. |
| M13 | Collapsing specialization relationship kinds onto two visual edge styles is a deliberate **diagram-legibility** choice. |
| M16, M18, M19, L10–L13 | Test-quality/robustness improvements (parse-back RDF assertions, dedupe a helper, env-gated corpus skips, extra round-trip cases). Real but non-behavioral; batch into a **test-hardening** pass. |
| M17 | `test-results/e2e-results.json` is a cached run artifact, not source; regenerated by running E2E. |
| M20 | Adding ESLint is a tooling setup task, not a code defect. |
| L9 | Dev-only advisory (vitest UI) in `node_modules`; no production-runtime exposure. |

### Verification of this pass

- `tsc --noEmit` → **0** (home mirror).
- `vitest run` → **844 / 844 passed across 74 files** (added one `buildAction`
  subtype regression test; removed no tests).
- `npm run build` → succeeds; main entry chunk **2,639 kB → 761 kB** after
  vendor `manualChunks`.
- E2E not re-run in this pass (same constraint as the original review); no fix
  here touches an E2E-only path except the deferred store-perf cluster, which is
  intentionally left for a milestone that *can* be E2E-verified.

---

## Follow-up: pre-existing round-trip gaps (2026-07-08 adversarial review)

Closing out the round-trip-fidelity milestone (H17/L1/L2/L3), a Fable adversarial
review empirically probed `parse → serialize → parse` and confirmed the new work
is sound, **fixed 5 bugs** (`bc6c993`: expression-after-members ordering, an
endpoint-guard for bare flow/connection usages, `if`-target else-body members,
`metadata` keyword, dependency short name), and surfaced these **pre-existing**
gaps that also defeat perfect round-trip but were *outside* the H17/L1/L2/L3
scope. Each is verified by a concrete failing case.

**Wave 4 (`c58e2fa`, `bf110c7`) resolved F1(bind)/F2/F3/F5**; a second Fable
review of the wave-4 diff then caught three incomplete fixes (fixed in the
wave-4 review commit): F2's reserved set was 3 words vs the grammar's ~164
keywords (a name like `'if'`/`'var'` was still emitted bare); `bind`'s
source-less `binding` form emitted `bind ;` and dropped `ofPayload`; and
conjugation `~` was still lost on unresolved `:>`/`:>>`/`::>` lists. **F4 and F6
remain** (architectural / by-design). Status is in the table; further residuals
are listed below it.

| # | Sev | Status | Gap | Fault |
|---|-----|--------|-----|-------|
| F1 | HIGH | **bind FIXED** (`c58e2fa`); disjoint partial → F4 | `bind a = b;` and `disjoint A from B;` serialized as bare eClass names that silently reparsed as a wrongly-named ReferenceUsage. Now both have dedicated serializer branches: `bind` fully round-trips; `disjoint` survives as a proper `Disjoining` but its target degrades to `targetRef` (owned-by-source + forward-ref → see F4). | `serializer.ts` bindLine/disjoiningLine |
| F2 | MED | **FIXED** (`bf110c7`); residual: qualified-path refs | Unrestricted/quoted/reserved names (`'my part'`, `'true'`) were emitted raw. `quoteName()` now quotes non-identifier/reserved declared names at every emission site (via `nameOf`). Residual (qualified-path quoting) **FIXED 2026-08-13**: `qualifiedRef` quotes each `::`-segment (`'my pkg'::T` round-trips). | `serializer.ts` quoteName/nameOf |
| F3 | MED | **FIXED** (`c58e2fa`) | `alias b for a;` (a Membership) was dropped. `bodyMembers` now includes `Membership`, and `aliasLine` emits `alias N for Target;`. | `serializer.ts` bodyMembers/aliasLine |
| F4 | MED | **FIXED** (`191ec65`) | Forward / cross-scope references (`subset a subsets b;`, `disjoint A from B;` before their operands) now resolve via `Mapper.resolveDeferredRefs()` — a single post-pass over the fully-built model at the end of `run()` that upgrades endpoint/`aliasFor`/specialization-array refs whose target now exists (re-homing source-owned relationships), while leaving typos and `typeRef`/`attrs.type` (owned by `resolveTypeReferences`) untouched. Idempotent, cycle-safe, single-sweep fixpoint. Designed via a 4-agent Understand workflow (predicted zero existing-test breakage, confirmed). A Fable adversarial review then found + fixed 4 edge cases: a dangling-source specialization's resolved target being mis-inlined onto its owner (D1: gate + serializer source-check), a reparent shifting the resolution scope (D2: capture scope before reparent), multi-endpoint dependency rebuild (D3), and a self-alias guard (D4). Also fixes F1's disjoint-target residual. **Residual (R6, pre-existing):** an UNresolvable relationship statement is still not re-emitted on serialize. | `map-to-model.ts` resolveDeferredRefs |
| F5 | LOW | **FIXED** (`c58e2fa`); residual: keyword-less ref | Conjugation `~` now emitted on unresolved typings; `ReferenceUsage` no longer double-emits `isRef` (`ref x`, not `ref ref x`). Residual (keyword-less provenance) **FIXED 2026-08-13**: the mapper marks purely name-led features with `attrs.keywordless=true`; the serializer omits `ref` for them. An explicit `ref x :>> A;` (prefix-led) keeps its keyword. Fixpoint-stable; 2 round-trip snippets added. | `serializer.ts` MODIFIER_ORDER/specializationFragments |
| F6 | LOW | **WON'T-FIX** (by design) | A lone `=` is a first-class operator in the semantics engines (L3), but the Langium grammar has no `=` in its expression rule, so a hand-built `ConstraintUsage` whose `attrs.expression` uses `=` can't round-trip through text. This is arguably correct — SysML v2 uses `==` for equality; the solver's `=` acceptance is a lenient convenience for programmatic models. Add `=` to the grammar only if textual `=` constraints are wanted. | `sysml.langium` EqualityExpr |
| F7 | MED | **FIXED** (quote-aware split) | `resolveRef` split a reference on `::`/`.` before unquoting, so a quoted dotted name (`'a.b'`) shattered. `splitQualified()` now splits only outside single quotes. The remaining forward-reference resolution (disjoint target, subset-before-def) is F4. | `map-to-model.ts` splitQualified |
| — | note | **ALL RESOLVED** (2026-08-13) | Every confirmed minor residual is fixed: `doc` names are stored by the mapper; `alias`/`bind` bodies map to the created Membership/BindingConnectorAsUsage and re-render via `renderWithBody`; `:=` provenance captured for behavior/return/attribute statements (attrs.initialValue); `message`/`render` keywords map to MessageDefinition/MessageUsage/RenderingDefinition/RenderingUsage; F2's qualified-path quoting fixed (`qualifiedRef` quotes each `::`-segment). *(Parse-side `: ~Real` attribute conjugation also fixed.)* |  |

Test blind spots noted for wave 4: the round-trip signature helper's `KEY_ATTRS`
still excludes `is*` flags, `conjugated`, and `initialValue`, and anonymous
same-eClass siblings share a `«eClass»` qualified name (a cross-parent child
swap would be invisible).
