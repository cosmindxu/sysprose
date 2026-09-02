export const meta = {
  name: 'sysmlv2-wave3-test',
  description: 'Integration + E2E testing of Sysprose and generation of the feature-coverage test report',
  phases: [
    { title: 'Integration tests', detail: 'cross-module pipelines (parse/validate/query/serialize/persist/diagram)' },
    { title: 'E2E tests', detail: 'Playwright drives the real app: every user-tool interaction + screenshots' },
    { title: 'Test report', detail: 'aggregate unit+integration+E2E into docs/TEST-REPORT.md feature matrix' },
  ],
}

const COMMON = `
PROJECT ROOT = /home/xcos/sysprose  (the build lives on the home filesystem — the vboxsf share is too slow for node_modules). ALWAYS use absolute paths under this root for Read/Write (e.g. /home/xcos/sysprose/test/...), and PREFIX every shell command with  cd /home/xcos/sysprose &&  so npm/npx/node/git run where node_modules lives.

You are testing a pure-browser system modeler (Sysprose) (TypeScript + Vite + React). All modules and the UI are implemented. Module barrels: @core, @text, @validation, @api, @diagram, @persistence; UI in src/ui (App, useAppStore, panels with data-testid attributes). Read docs/03-architecture-and-plan.md §5/§7 for the feature scope and the data-testid convention is documented in the UI panels.
RULES: create files only under test/ (and playwright.config.ts at root for the E2E agent). Do NOT modify src/ or package.json except as explicitly allowed. Do NOT run npm install. Report precise pass/fail counts and artifact paths.
`

phase('Integration tests')

const INT1_PROMPT = `${COMMON}

=== TASK: Cross-module pipeline integration tests (test/integration/pipeline.*.test.ts) ===
Write Vitest integration tests that exercise multiple modules together (import the real barrels):
1. Text↔Model↔Text round-trip on examples/vehicle.sysml (read the file content via Node fs in the test): parseModel → assert key elements (Vehicle part def, ports, connection, action successions, state transitions, requirement+satisfy) → serializeModel → parseModel again → element set stable.
2. Parse → validate: a clean parse yields no errors; inject violations (duplicate name, bad multiplicity, missing port direction, dangling ref) and assert validate() reports them.
3. Parse → API query/analytics: build the model from the example, run evaluateQuery for several constraints (by metaclass, by name, composite and/or, attr path), assert results; run analytics (countByMetaclass, requirementSatisfaction, whereUsed, modelMetrics) and assert numbers.
4. Model → diagram: buildDiagram for each ViewKind on the parsed model, layoutDiagram, assert nodes/edges and that every node has a numeric position.
Aim for >=25 assertions. Verify: npx vitest run test/integration --no-coverage  (green).`

const INT2_PROMPT = `${COMMON}

=== TASK: Persistence + API-server integration tests (test/integration/persist-api.*.test.ts) ===
1. Persistence round-trips: createDefaultStore()/InMemoryStore + LocalStorageStore (jsdom) save→load equality; exportModel/importModel for 'model-json','sysml','api-json' on buildSampleModel and on the parsed examples/vehicle.sysml — element sets preserved; api-json output validates as OMG element-graph (every element has @id/@type, relationships reified).
2. SysmlApiServer (OMG REST facade): apiFetch GET /projects, GET /projects/:id/elements (pagination), GET /elements/:id (OMG JSON shape), POST /queries (Query → QueryResult), GET /analytics/metrics — assert status codes and body shapes; confirm the same Query yields the same elements as evaluateQuery directly.
3. SDK automation scenario: programmatically create a small model via ModelApi.commit(...), query it, serialize to .sysml, re-import, and assert equivalence (demonstrates the automation API end-to-end).
Aim for >=20 assertions. Verify: npx vitest run test/integration --no-coverage (green).`

const [int1, int2] = await parallel([
  () => agent(INT1_PROMPT, { label: 'test:pipeline', phase: 'Integration tests', effort: 'high' }),
  () => agent(INT2_PROMPT, { label: 'test:persist-api', phase: 'Integration tests', effort: 'high' }),
])

phase('E2E tests')

const E2E_PROMPT = `${COMMON}

=== TASK: Playwright E2E covering ALL user–tool interactions ===
You MAY create: playwright.config.ts (root), test/e2e/*.spec.ts, and a tiny test/e2e/fixtures helper. You MAY run: npx playwright install chromium (downloads to ~/.cache, allowed). If chromium fails to launch due to missing system libs, fall back to channel:'chrome' (a system Chrome is available) — set this in playwright.config.ts use{}.
Setup:
- playwright.config.ts: testDir 'test/e2e', headless true, screenshot 'on', trace 'on-first-retry', baseURL 'http://localhost:4173', and webServer { command: 'npm run build && npm run preview', url: 'http://localhost:4173', timeout: 180000, reuseExistingServer: true }. Use a single worker (vboxsf) and outputDir 'test-results/e2e'. Configure an HTML+JSON reporter writing to playwright-report/ and test-results/e2e-results.json.
- Screenshots: in each test, capture page.screenshot to test-results/screenshots/<scenario>.png at key steps.
Write spec files (use the data-testid convention from the UI) covering EVERY user interaction. Each 'test(...)' is one scenario; group logically:
1. app-loads.spec: app loads with the sample project; explorer shows the tree; a diagram renders in 'diagram-canvas'; no uncaught console errors.
2. explorer-crud.spec: create a Package, create a PartDefinition under it (tree-add + metaclass pick), rename via tree-rename, select it, delete via tree-delete; assert tree updates.
3. properties.spec: select an element, edit prop-name, change a port's prop-direction, set prop-value/prop-multiplicity; assert the change reflects in the explorer/diagram.
4. diagram-create-connect.spec: switch tb-view-interconnection; use a palette-tool to add a part/port; draw a connection on the canvas (onConnect) between two ports; assert an edge appears. Then tb-view-general and tb-view-action and tb-view-state and tb-view-requirement render without error (switch each, screenshot).
5. text-sync.spec: open tab-text; assert text-editor shows serialized SysML for the model; edit the text (add a part), click text-apply; assert the new element appears in the explorer. Then change the model via explorer and assert text regenerates.
6. validation.spec: introduce an invalid state (e.g. remove a port direction via properties or add a duplicate name), click tb-validate, open tab-problems, assert a problem-row appears and clicking it selects the element.
7. import-export.spec: click tb-export-sysml (intercept the download, assert non-empty SysML); click tb-export-json (assert JSON parses with elements). For import, programmatically set an <input type=file> or use the store via page.evaluate(window.sysml ...) if the file dialog can't be driven headlessly — at minimum assert exports work.
8. api-console.spec: open tab-api; type a JSON Query into api-query (e.g. {"constraint":{"property":"@type","operator":"=","value":"PartDefinition"}}), click api-run, assert api-results shows rows; click api-metrics and api-satisfaction and assert results render; verify window.sysml is the live SDK via page.evaluate (e.g. window.sysml.elementsOfType('PartDefinition').length > 0).
9. undo-redo.spec: make a change, tb-undo restores, tb-redo reapplies.
Make selectors resilient (getByTestId). Keep each test independent (reload + reset between tests).
RUN them: npx playwright test  (after install). Iterate until they pass (or document any environment-only failures precisely). Report: number of specs, tests passed/failed, the screenshots produced (paths), and the results JSON path.`

const e2e = await agent(E2E_PROMPT, { label: 'test:e2e', phase: 'E2E tests', effort: 'high' })

phase('Test report')

const REPORT_PROMPT = `${COMMON}

=== TASK: Generate docs/TEST-REPORT.md (the feature-coverage test report) ===
Aggregate ALL test evidence into a thorough, professional report at docs/TEST-REPORT.md. Gather data by:
- Running the full unit+integration suite for fresh numbers:  npx vitest run --reporter=json --outputFile=test-results/unit-results.json  (also capture the human summary).
- Reading test-results/e2e-results.json and the screenshots under test-results/screenshots/ and playwright-report/.
- Reading docs/03-architecture-and-plan.md §5 (feature scope) and §7 (test strategy).
The report MUST contain:
1. Executive summary: total tests, pass/fail, environment (browser-only PoC), date placeholder 'GENERATED'.
2. FEATURE COVERAGE MATRIX — a table with a row for EVERY feature and EVERY user–tool interaction in plan §5 (authoring: project new/open/save/import/export, explorer CRUD + reparent, palette creation, properties editing, each diagram view, textual editor + bidirectional sync, validation, undo/redo; API: SDK navigation, query engine + each operator, analytics each kind, REST facade, automation). Columns: Feature/Interaction | Covered by (unit/integration/e2e test name) | Result (PASS/FAIL/PARTIAL) | Notes.
3. Per-module unit test summary (counts).
4. Integration test summary.
5. E2E scenario summary with the screenshot path per scenario (reference test-results/screenshots/*.png).
6. Known gaps / environment limitations.
7. Traceability: map back to the OMG standard constructs and the SOTA feature parity (MagicDraw/SysON) claims.
Be accurate — derive PASS/FAIL from the actual result files; do not claim a feature is covered if no test exercises it (mark gaps honestly). Return a 5-bullet summary of the report contents and the headline pass/fail totals.`

const report = await agent(REPORT_PROMPT, { label: 'test:report', phase: 'Test report', effort: 'high' })

return { int1, int2, e2e, report }
