export const meta = {
  name: 'sysmlv2-wave2-ui',
  description: 'Build the React UI that integrates all modules into a working browser system modeler (Sysprose)',
  phases: [
    { title: 'App shell', detail: 'store, commands, layout, App, CSS, panel contracts' },
    { title: 'Panels', detail: 'parallel: explorer+properties, diagram canvas+palette, text editor+toolbar+API console' },
    { title: 'Build verify', detail: 'vite build must succeed' },
  ],
}

const RULES = `
PROJECT ROOT = /home/xcos/sysprose  (the build lives on the home filesystem — the vboxsf share is too slow for node_modules). ALWAYS use absolute paths under this root for Read/Write (e.g. /home/xcos/sysprose/src/...), and PREFIX every shell command with  cd /home/xcos/sysprose &&  so npm/npx/node/git run where node_modules lives.

You are building the React UI of a pure-browser system modeler (Sysprose). ALL feature modules are implemented — READ their public barrels before coding and use their REAL exported APIs:
- @core/index        (Model, ModelFactory, ElementRecord, metaclass catalogues, predicates)
- @text/index        (parseModel, serializeModel, serializeElement, ParseResult)
- @validation/index  (validate, Diagnostic)
- @api/index         (ModelApi, evaluateQuery, query types, analytics, SysmlApiServer, QueryResult)
- @diagram/index     (buildDiagram, layoutDiagram, nodeTypes, edgeTypes, ViewKind, DiagramGraph)
- @persistence/index (createDefaultStore, exportModel, importModel, downloadText, openTextFile)
Also read docs/03-architecture-and-plan.md (§5 feature scope, §6 API) and src/ui/store.ts (the app store, once it exists).

Stack: React 18 + zustand + @xyflow/react (React Flow). Import React Flow styles via 'import "@xyflow/react/dist/style.css"'. Plain CSS (no UI kit).

HARD RULES:
1. Create/edit files ONLY under src/ui (and only the files assigned to you). Do NOT modify other modules, package.json, or configs.
2. Do NOT run npm install / git commit.
3. Strict TypeScript. Functional React components + hooks. Keep components prop-driven and readable.
4. Expose the SDK on window for automation: set (window as any).sysml = api in the app bootstrap (App-shell agent does this).
5. STABLE TEST IDS (required for E2E): add data-testid to every interactive control using this convention EXACTLY:
   - Toolbar buttons: tb-new, tb-open, tb-save, tb-import, tb-export-sysml, tb-export-json, tb-validate, tb-layout, tb-undo, tb-redo, and view switch buttons tb-view-general | tb-view-interconnection | tb-view-action | tb-view-state | tb-view-requirement | tb-view-tree
   - Explorer: container 'explorer'; each tree row 'tree-node' (also data-elementid=<id>); add-child control 'tree-add'; rename input 'tree-rename'; delete control 'tree-delete'
   - Properties: container 'properties'; fields prop-name, prop-shortName, prop-direction, prop-type, prop-value, prop-multiplicity, prop-reqId, prop-text, prop-doc (only those relevant to the selection)
   - Palette: container 'palette'; each tool 'palette-tool' (also data-kind=<eClass-or-edgeKind>)
   - Diagram: canvas container 'diagram-canvas'
   - Bottom panel: tabs tab-problems, tab-text, tab-api; problems list 'problem-row'; text editor 'text-editor', apply button 'text-apply'; API console input 'api-query', run button 'api-run', results 'api-results', plus analytics buttons api-metrics, api-satisfaction, api-whereused
Return a concise summary: files created, the store/props API you used or defined, the data-testids you added, and any issues.
`

phase('App shell')

const SHELL_PROMPT = `${RULES}

=== TASK: App shell, store, commands, layout (you go FIRST; panels depend on your store) ===
Create:
- src/ui/store.ts — a zustand store 'useAppStore' that is the single UI state + command surface. State: model: Model; api: ModelApi; server: SysmlApiServer; selectionId: string|null; expandedIds: Set<string>; activeView: ViewKind; diagram: DiagramGraph|null; diagnostics: Diagnostic[]; textBuffer: string; textDirty: boolean; projectName: string; queryResult: QueryResult|null. Commands (all keep model+diagram+text+diagnostics consistent and push undo snapshots where they mutate): select(id); toggleExpand(id); setActiveView(v) (rebuilds+lays out the diagram); rebuildDiagram(): Promise<void> (buildDiagram + layoutDiagram for activeView around selection/root); createElement(eClass, ownerId?, name?): string; updateElement(id, patch); setAttr(id,k,v); deleteElement(id); reparent(id, ownerId); connect(sourceId,targetId,kind); runValidation(); setTextBuffer(s) (marks dirty); applyText() (parseModel → replace model via model.reset, surface diagnostics); regenerateText() (serializeModel → textBuffer); newProject(); saveProject(name?); loadProject(name); listProjects(); importModel(text, fmt); exportModel(fmt) (returns string; also downloadText); runQuery(q); undo(); redo(). Implement undo/redo with a stack of model.toJSON() snapshots (cap ~50). After any model mutation, re-run validation (cheap) and mark text dirty.
- src/ui/commands.ts — optional helper command palette definitions (id, label, run) reusing the store, for a toolbar/keyboard.
- src/ui/layout.css (or src/ui/styles.css) — a clean professional IDE-style layout: left explorer (~260px), center canvas (flex), right properties (~300px), bottom panel (diagnostics/text/API tabs ~220px), top toolbar (~44px). Light theme, sensible typography.
- src/ui/App.tsx — compose the layout. Import the panel components by path even though other agents create them:
    import { Explorer } from './panels/Explorer'; import { Properties } from './panels/Properties';
    import { DiagramCanvas } from './panels/DiagramCanvas'; import { Palette } from './panels/Palette';
    import { Toolbar } from './panels/Toolbar'; import { BottomPanel } from './panels/BottomPanel';
  Render Toolbar (top), Explorer (left), DiagramCanvas+Palette (center), Properties (right), BottomPanel (bottom). On mount: load a sample project (use buildSampleModel from @core or parse examples/vehicle.sysml content embedded as a string), set window.sysml = store.getState().api, and do initial rebuildDiagram()+runValidation().
- src/main.tsx — ReactDOM.createRoot rendering <App/>.
- src/ui/index.ts — export App and useAppStore.
Define and DOCUMENT (JSDoc at top of store.ts) the exact store selector API the panels will use, so the panel agents can rely on it. Make sure App.tsx compiles even before panels exist by keeping the imports (panels will be created in the next phase).`

const shell = await agent(SHELL_PROMPT, { label: 'ui:shell', phase: 'App shell', effort: 'high' })

phase('Panels')

const EXPLORER_PROMPT = `${RULES}

=== TASK: Explorer tree + Properties panel ===
The store exists at src/ui/store.ts — READ it and use useAppStore. Create:
- src/ui/panels/Explorer.tsx — a containment tree of the model (roots → children) with: expand/collapse, metaclass icons/badges («keyword»), click-to-select (store.select), context menu or inline buttons to create child elements (store.createElement with a small metaclass picker), rename (inline edit → store.updateElement), delete (store.deleteElement), and drag-to-reparent (store.reparent). Highlight selectionId. Subscribe to the store so it re-renders on model changes.
- src/ui/panels/Properties.tsx — an editable properties form for the selected element: declaredName, declaredShortName, eClass (read-only or metaclass-constrained), and metaclass-specific attrs (direction for ports as a dropdown in/out/inout; type as a name reference; value; multiplicity; reqId/text for requirements; trigger/guard/effect for transitions; documentation). Edits call store.updateElement/setAttr. Show the element's qualifiedName and its relationships (types, specializations, connections) read-only.
Make both robust to no-selection. Keep styling consistent with src/ui/styles.css classes.`

const CANVAS_PROMPT = `${RULES}

=== TASK: Diagram canvas + Palette ===
The store exists at src/ui/store.ts — READ it. Create:
- src/ui/panels/DiagramCanvas.tsx — render store.diagram with @xyflow/react <ReactFlow>: map DiagramNode→RF node (type=node.kind family, position, data, parentId for nesting, ports) and DiagramEdge→RF edge (type by kind), using nodeTypes/edgeTypes from @diagram/index. Wire: node click → store.select(node.elementId); node drag end → persist position back into store.diagram (local layout tweak); a "Auto-layout" affordance calling store.rebuildDiagram(); view switching reads store.activeView. Include Background, Controls, MiniMap. When the user draws a connection between two ports/nodes (onConnect), call store.connect(source,target,kind) choosing a sensible relationship kind for the active view (ConnectionUsage for interconnection, Succession for action, TransitionUsage for state, Satisfy for requirement, composition/specialization for general — or prompt a small kind picker).
- src/ui/panels/Palette.tsx — a floating palette of element/edge tools appropriate to store.activeView (e.g. general: PartDefinition, PartUsage, AttributeUsage, PortUsage, specialization; interconnection: PartUsage, PortUsage, ConnectionUsage; action: ActionUsage, control nodes, Succession; state: StateUsage, TransitionUsage; requirement: RequirementUsage, Satisfy). Clicking a node tool then clicking the canvas (or a target element) creates the element via store.createElement under a sensible owner; edge tools set a pending-connect mode used by DiagramCanvas.onConnect.
Keep it usable: tooltips, active-tool highlighting.`

const EDITOR_PROMPT = `${RULES}

=== TASK: Text editor + Toolbar + Bottom panel (diagnostics + API console) ===
The store exists at src/ui/store.ts — READ it. Create:
- src/ui/panels/TextEditor.tsx — a SysML v2 textual notation editor bound to store.textBuffer: a <textarea> (monospaced, line numbers gutter, basic keyword highlighting via a lightweight overlay is a nice-to-have but optional) with an "Apply text → model" button (store.applyText) and auto-"Regenerate from model" when the model changes and text isn't dirty (store.regenerateText). Show parse diagnostics inline or in a strip.
- src/ui/panels/Toolbar.tsx — top toolbar: New, Open (loadProject + a project picker), Save (saveProject), Import (.sysml/json via openTextFile → store.importModel), Export (.sysml/model-json/api-json via store.exportModel + downloadText), Validate (store.runValidation), Auto-layout (store.rebuildDiagram), View switch (segmented control over ViewKind), Undo/Redo.
- src/ui/panels/BottomPanel.tsx — tabbed bottom area: (1) Problems: list store.diagnostics with severity icon, message, and click-to-select elementId; (2) Text: embeds <TextEditor/>; (3) API Console: a textarea to enter a JSON Query (or a few canned queries) → store.runQuery → render store.queryResult as a table, plus buttons that call analytics (metrics, requirement satisfaction, where-used on selection) and show results as JSON/table, plus a hint that window.sysml is the live SDK. This panel showcases the data-analysis/automation API.
Keep all three consistent with the store API and styles.css.`

const panels = await parallel([
  () => agent(EXPLORER_PROMPT, { label: 'ui:explorer+properties', phase: 'Panels', effort: 'high' }),
  () => agent(CANVAS_PROMPT, { label: 'ui:canvas+palette', phase: 'Panels', effort: 'high' }),
  () => agent(EDITOR_PROMPT, { label: 'ui:editor+toolbar+console', phase: 'Panels', effort: 'high' }),
])

phase('Build verify')

const BUILD_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['buildPassed', 'typecheckErrors', 'notes'],
  properties: {
    buildPassed: { type: 'boolean' },
    typecheckErrors: { type: 'array', items: { type: 'string' }, description: 'up to 50 error lines verbatim' },
    notes: { type: 'string' },
  },
}

const build = await agent(
  `Verify the UI build (do NOT modify source unless a trivial import path is wrong — if so, fix minimally and note it). Run:  npx tsc --noEmit -p tsconfig.json   then   npm run build  (vite build). Report buildPassed (true only if vite build succeeds) and up to 50 verbatim error lines. Note any missing exports/contract mismatches between the UI and the feature modules.`,
  { label: 'ui:build-verify', phase: 'Build verify', schema: BUILD_SCHEMA, effort: 'low' },
)

return { shell, panels, build }
