export const meta = {
  name: 'sysmlv2-wave1',
  description: 'Build core feature modules (text, validation, api, diagram, persistence) of the browser system modeler (Sysprose)',
  phases: [
    { title: 'Core modules', detail: 'parallel: text, validation, api, diagram' },
    { title: 'Persistence', detail: 'store + import/export (depends on text)' },
    { title: 'Verify', detail: 'typecheck + run all unit tests, report' },
  ],
}

const RULES = `
PROJECT ROOT = /home/xcos/sysprose  (the build lives on the home filesystem — the vboxsf share is too slow for node_modules). ALWAYS use absolute paths under this root for Read/Write (e.g. /home/xcos/sysprose/src/...), and PREFIX every shell command with  cd /home/xcos/sysprose &&  so npm/npx/node/git run where node_modules lives.

You are implementing ONE module of a pure-browser system modeler (Sysprose) (TypeScript + Vite + React, no backend). The shared model core is DONE in src/core.

READ FIRST (use the Read tool):
- src/core/metamodel.ts  (ElementRecord, metaclass catalogues, predicates, TEXTUAL_KEYWORD, SPECIALIZATION_OPERATOR)
- src/core/model.ts      (Model: create/get/update/remove/reparent, children/roots/descendants, relationshipsFrom/To, typesOf, resolveQualifiedName, qualifiedName, toJSON/fromJSON, subscribe/transaction)
- src/core/factory.ts    (ModelFactory + buildSampleModel)
- src/core/index.ts      (the '@core' public surface)
- docs/03-architecture-and-plan.md  (§4 has the cross-module CONTRACTS you must match exactly; §5/§6 the feature scope)
- docs/02-omg-standard-reference.md (skim the sections relevant to your module)

IMPORT the core via the '@core' alias, e.g.  import { Model, ModelFactory, isRelationship } from '@core/index';
(The alias is configured in vite.config.ts and vitest.config.ts.)

HARD RULES:
1. Create/edit files ONLY under your module directory and your own test files under test/unit/. Do NOT touch package.json, tsconfig.json, vite/vitest configs, src/core, or other modules' directories.
2. Do NOT run 'npm install', 'git add', or 'git commit'.
3. Write strict-TypeScript, well-documented, dependency-light code. Match the CONTRACT type names/shapes from plan §4 EXACTLY so modules integrate.
4. Provide a public 'index.ts' barrel for your module exporting everything other modules need.
5. VERIFY before finishing: run ONLY your own tests with  npx vitest run <your-test-globs> --no-coverage  — they MUST pass. Iterate until green. Report the final pass/fail counts.

Return a concise summary: files created, key design decisions, public API exported, test results (N passed), and any integration notes for the UI/other modules.
`

phase('Core modules')

const TEXT_PROMPT = `${RULES}

=== MODULE: Textual notation  (directory: src/text) ===
Implement a hand-written lexer + recursive-descent parser + serializer for a practical subset of the SysML v2 textual notation, plus bidirectional sync helpers. Files:
- src/text/lexer.ts       — tokenizer: keywords, identifiers (incl. unrestricted '...' names), qualified names (A::B), numbers, strings, line/block comments, doc comments (/* ... */ after 'doc'), punctuation and operators ( { } ( ) [ ] : :> :>> ::> = ; , . < > * .. -> ).
- src/text/parser.ts      — parseModel(src: string): ParseResult. Build a Model using core create/factory. Support: package; part def/part; attribute def/attribute (with ':' type, '=' value, '[mult]'); item def/item; port def/port (with 'in'/'out'/'inout' direction); connection def/connection and 'connect A to B'; interface; action def/action with control nodes and 'first X then Y'/'then'/successions; state def/state with 'entry'/'do'/'exit' and 'transition' / 'A -> B' with 'accept'/trigger, '[guard]', 'do'/effect; constraint def/constraint with 'assert'; requirement def/requirement (with attribute 'id', 'subject', 'require'/'assume', doc); 'satisfy req by part'; allocation/'allocate A to B'; enum def + enum literals; view/viewpoint; comment/doc; import; specialization operators (':' FeatureTyping, ':>' Subsetting/Subclassification, ':>>' Redefinition, '::>' ReferenceSubsetting). Resolve type/name references by qualified name within scope; if unresolved, keep the textual reference in attrs (e.g. attrs.typeRef) and add a 'warning' diagnostic. Produce 'error' diagnostics with line/column on syntax errors and RECOVER (skip to next ';' or '}') so partial models still parse.
- src/text/serializer.ts  — serializeModel(model: Model): string  and  serializeElement(model, id, indent?): string. Emit valid SysML v2 text: keyword from TEXTUAL_KEYWORD, short name as '<short>', specialization operators, '{...}' bodies with indented children, attribute ':' type '=' value '[mult]', port directions, connect/transition/succession/satisfy syntax, doc comments. Output MUST be re-parseable.
- src/text/index.ts       — export { parseModel, serializeModel, serializeElement } and the ParseResult/ParseDiagnostic types (match plan §4 exactly: ParseDiagnostic{message,line,column,severity:'error'|'warning'}, ParseResult{model:Model,diagnostics:ParseDiagnostic[]}).
Tests (test/unit/text.*.test.ts): per-construct parsing; diagnostics on malformed input with recovery; and ROUND-TRIP: for buildSampleModel() and for several hand-written .sysml snippets, assert parseModel(serializeModel(m)) reproduces the same element set (by metaclass + qualifiedName + key attrs). Aim for thorough coverage (>=25 assertions).`

const VALIDATION_PROMPT = `${RULES}

=== MODULE: Validation engine  (directory: src/validation) ===
Implement a rule-based model checker. Files:
- src/validation/types.ts   — Diagnostic{ id:string; ruleId:string; severity:'error'|'warning'|'info'; message:string; elementId?:string } (match plan §4) and ValidationRule{ id; description; run(model): Diagnostic[] }.
- src/validation/rules.ts   — a registry of rules. Implement AT LEAST: (1) duplicate declaredName within the same owner/namespace; (2) empty/blank name on a named element; (3) dangling relationship endpoints (source/target id not in model); (4) unresolved type reference (attrs.typeRef present but not resolvable); (5) PortUsage missing/invalid direction; (6) malformed multiplicity string (must match /^\\d+(\\.\\.(\\d+|\\*))?$/ or '*'); (7) connection/connector with fewer than 2 endpoints; (8) requirement without a subject; (9) redefinition/subsetting target missing; (10) containment cycle / self-ownership; (11) orphan relationship not owned; (12) feature typed by a non-type element. Each rule returns precise diagnostics with elementId.
- src/validation/validate.ts — validate(model, opts?): Diagnostic[] running all (or a selected subset of) rules; sort by severity then element.
- src/validation/index.ts    — export validate, the rule registry, types.
Tests (test/unit/validation.*.test.ts): for EACH rule, a positive case (clean model → no diagnostic) and a negative case (crafted violation → expected diagnostic). Use ModelFactory to build fixtures. >=24 assertions.`

const API_PROMPT = `${RULES}

=== MODULE: API / SDK + OMG Query facade + analytics  (directory: src/api) ===
This is the data-analysis & automation API — a headline feature. Files:
- src/api/sdk.ts        — class ModelApi(model: Model): getElement(id); elementsOfType(...eClasses); byName(qname); children(id); owner(id); ancestors(id); roots(); traverse(id, relKind, dir?) returning connected elements; create/update/delete passthroughs that mutate the model; toElementJSON(id) producing OMG-style { '@id','@type', declaredName, ownedRelationship:[...], ...} ; commit(fn) batching mutations in a model transaction and returning a commit id (use a monotonic counter stored on the api instance — do NOT use Date.now/Math.random; derive from model size + an internal counter).
- src/api/query.ts      — the OMG-API-shaped Query engine. Types: PrimitiveConstraint{ property:string; operator:'='|'!='|'<'|'>'|'in'|'contains'|'exists'; value?:any }, CompositeConstraint{ kind:'and'|'or'|'not'; operands:Constraint[] }, type Constraint = PrimitiveConstraint|CompositeConstraint; Query{ constraint?:Constraint; select?:string[]; scopeOwnerId?:string; page?:{offset?:number;limit?:number} }. Implement evaluateQuery(model, query): QueryResult{ commitId:string; elements:ElementRecord[]; total:number } — property lookups resolve against eClass, declaredName, qualifiedName, and attrs.* (dot path), with pagination + optional select projection.
- src/api/analytics.ts  — pure analysis functions over a Model: countByMetaclass(model); modelMetrics(model) (counts, max containment depth, #relationships, #diagrams-able elements); requirementSatisfaction(model) (each requirement → satisfiers via Satisfy relationships → covered?/coverage ratio); traceabilityMatrix(model, fromKind, toKind, relKind) (2D matrix); whereUsed(model, id) (elements referencing id via typing/relationships); connectivityReport(model) (ports & connections, unconnected ports). Return plain JSON-serializable data.
- src/api/rest.ts       — an in-process OMG-API-shaped REST facade: class SysmlApiServer(model). Method apiFetch(method, path, body?) → { status, body } handling: GET /projects, GET /projects/:id, GET /projects/:id/elements (paginated), GET /elements/:id (OMG element JSON), POST /queries (body: Query → QueryResult), GET /analytics/metrics. Use a single in-memory project/commit. This mirrors the OMG REST contract so a future HTTP server is a thin wrapper.
- src/api/index.ts      — export ModelApi, evaluateQuery + query types, analytics fns, SysmlApiServer, QueryResult type (match plan §4).
Tests (test/unit/api.*.test.ts): SDK navigation + toElementJSON shape; query engine (each operator, composite and/or/not, select projection, pagination, scoping) on buildSampleModel/custom fixtures; analytics correctness (counts, satisfaction coverage, whereUsed, traceability); rest facade responses (status codes + body shape). >=30 assertions.`

const DIAGRAM_PROMPT = `${RULES}

=== MODULE: Diagram model + auto-layout + React Flow renderers  (directory: src/diagram) ===
Map the model to diagrams for each view kind, auto-layout with elkjs, and provide React Flow custom renderers. Files:
- src/diagram/types.ts        — ViewKind = 'general'|'interconnection'|'action'|'state'|'requirement'|'tree'; DiagramNode, DiagramEdge, DiagramGraph EXACTLY as in plan §4 (DiagramNode{ id,elementId,kind,label,data,position?,size?,parentId?,ports?:{id,side,label}[] }; DiagramEdge{ id,elementId?,source,target,kind,label? }; DiagramGraph{ nodes,edges,viewKind }).
- src/diagram/build.ts        — buildDiagram(model: Model, viewKind: ViewKind, rootId?: string): DiagramGraph. general: definitions+usages as nodes, attribute/port compartments in data, edges for composition (owned PartUsage → filled diamond 'composite'), reference, FeatureTyping ('typed-by'), Subclassification/Subsetting/Redefinition ('specialize'), Satisfy/Allocation/Dependency. interconnection: parts as nested nodes (parentId), ports as node.ports on boundaries, ConnectionUsage as edges between ports. action: ActionUsage + control nodes as nodes, Succession as edges. state: StateUsage as nodes, TransitionUsage as edges labelled 'trigger [guard] / effect'. requirement: RequirementUsage/Def nodes, Satisfy/derive/refine edges. tree: pure containment tree.
- src/diagram/layout.ts       — layoutDiagram(graph: DiagramGraph): Promise<DiagramGraph> using elkjs. IMPORTANT: import ELK from 'elkjs/lib/elk.bundled.js' (the bundled build runs in Node for tests AND in the browser). Use layered algorithm, port constraints, and nesting (children laid out within parents). Assign position {x,y} to every node and size {w,h}; route is optional.
- src/diagram/nodes.tsx       — React Flow custom node components (SysML definition/usage box with «keyword» header, name, compartments, boundary ports) and src/diagram/edges.tsx — custom edges (composition/reference/specialization/succession/transition/satisfy markers). Export nodeTypes and edgeTypes maps for React Flow. Keep them presentational and prop-driven from DiagramNode.data.
- src/diagram/index.ts        — export buildDiagram, layoutDiagram, nodeTypes, edgeTypes, all types.
Tests (test/unit/diagram.*.test.ts): buildDiagram for EACH ViewKind on buildSampleModel + custom fixtures → assert expected node/edge counts, kinds, parentId nesting, ports, and edge endpoints; layoutDiagram assigns a numeric position to every node and non-zero sizes; nested children positioned within parents. (Do not unit-test the .tsx visual components heavily — those are covered by UI/E2E.) >=20 assertions.`

const [textRes, valRes, apiRes, diagRes] = await parallel([
  () => agent(TEXT_PROMPT, { label: 'build:text', phase: 'Core modules', effort: 'high' }),
  () => agent(VALIDATION_PROMPT, { label: 'build:validation', phase: 'Core modules', effort: 'high' }),
  () => agent(API_PROMPT, { label: 'build:api', phase: 'Core modules', effort: 'high' }),
  () => agent(DIAGRAM_PROMPT, { label: 'build:diagram', phase: 'Core modules', effort: 'high' }),
])

phase('Persistence')

const PERSIST_PROMPT = `${RULES}

=== MODULE: Persistence + import/export  (directory: src/persistence) ===
The text module (src/text) is now implemented — you may import it as '@text/index' ({ parseModel, serializeModel }). Files:
- src/persistence/store.ts   — interface ProjectStore { saveProject(name, data: SerializedModel): Promise<void>; loadProject(name): Promise<SerializedModel|null>; listProjects(): Promise<string[]>; deleteProject(name): Promise<void> }. Implement InMemoryStore, LocalStorageStore (guard for window/localStorage availability), and IndexedDBStore (guard for indexedDB availability; small promise wrapper, no external deps). Provide createDefaultStore() that picks indexedDB → localStorage → memory based on availability.
- src/persistence/io.ts      — exportModel(model: Model, format: 'model-json'|'sysml'|'api-json'): string  and  importModel(text: string, format): { model: Model; diagnostics?: any[] }. 'model-json' uses Model.toJSON/fromJSON; 'sysml' uses @text serializeModel/parseModel; 'api-json' emits/reads the OMG element-graph JSON ({ elements:[{'@id','@type',ownedRelationship...}], ... }) — implement a faithful element-graph (de)serializer here (ownership as Owning/FeatureMembership relationships).
- src/persistence/file.ts    — browser helpers: downloadText(filename, content, mime?) (Blob + <a download>), openTextFile(): Promise<{name,content}> (File System Access API with <input type=file> fallback). Guard all browser APIs so the module imports cleanly under Node.
- src/persistence/index.ts   — export stores, createDefaultStore, exportModel, importModel, downloadText, openTextFile.
Tests (test/unit/persistence.*.test.ts): InMemoryStore + LocalStorageStore (jsdom provides localStorage) round-trips (save→load→equal, list, delete); exportModel/importModel round-trips for all three formats on buildSampleModel (parse(serialize) preserves element set). Skip IndexedDB + file-dialog in unit tests (covered by E2E). >=16 assertions.`

const persistRes = await agent(PERSIST_PROMPT, { label: 'build:persistence', phase: 'Persistence', effort: 'high' })

phase('Verify')

const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['typecheckPassed', 'typecheckErrors', 'testsPassed', 'testsFailed', 'failingTestFiles', 'notes'],
  properties: {
    typecheckPassed: { type: 'boolean' },
    typecheckErrors: { type: 'array', items: { type: 'string' }, description: 'Up to 40 tsc error lines (file:line: message)' },
    testsPassed: { type: 'number' },
    testsFailed: { type: 'number' },
    failingTestFiles: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}

const verify = await agent(
  `Verify the current state of the Sysprose build. Run these and report results precisely (do NOT modify any source files):
1. Typecheck:  npx tsc --noEmit -p tsconfig.json   (capture errors; report typecheckPassed + up to 40 error lines verbatim as file:line: message)
2. Unit tests: npx vitest run --no-coverage          (report total passed, total failed, and the paths of any failing test files)
Be accurate; this report drives the fix phase.`,
  { label: 'verify', phase: 'Verify', schema: VERIFY_SCHEMA, effort: 'low' },
)

return {
  text: textRes, validation: valRes, api: apiRes, diagram: diagRes, persistence: persistRes,
  verify,
}
