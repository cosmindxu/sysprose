# Sysprose user guide

For an engineer who has been handed the tool and has an afternoon.

It assumes you know systems engineering — blocks, interfaces, requirements,
states — and it does **not** assume you know SysML v2. Everything you have to
type is introduced here, in the order you need it.

Sysprose runs entirely in a browser tab. There is no server, no login and no
project on anyone's disk but yours. That shapes everything below, especially
[what is kept and what is not](#7-what-is-kept-and-what-is-not).

| | |
|---|---|
| **Try it** | <https://cosmindxu.github.io/sysprose/> |
| **Run it locally** | `npm install && npm run dev`, or `npm run build && npm run preview` |
| **The example used throughout** | [`examples/uav-isr.sysml`](../examples/uav-isr.sysml) |
| **Command reference** | [`CLI-REFERENCE.md`](CLI-REFERENCE.md) |
| **What a diagnostic code means** | [`DIAGNOSTIC-CODES.md`](DIAGNOSTIC-CODES.md) |

**Contents**

1. [What this is, and what it is not](#1-what-this-is-and-what-it-is-not)
2. [The first ten minutes](#2-the-first-ten-minutes)
3. [The notation you actually type](#3-the-notation-you-actually-type)
4. [The views, and what each one answers](#4-the-views-and-what-each-one-answers)
5. [Authoring, and the one dangerous button](#5-authoring-and-the-one-dangerous-button)
6. [Checking and analysing](#6-checking-and-analysing)
7. [What is kept, and what is not](#7-what-is-kept-and-what-is-not)
8. [Limits](#8-limits)
9. [Where to go next](#9-where-to-go-next)
- [Appendix A — every control, and the id a test can find it by](#appendix-a--every-control-and-the-id-a-test-can-find-it-by)
- [Appendix B — keyboard shortcuts](#appendix-b--keyboard-shortcuts)

---

## 1. What this is, and what it is not

Sysprose is a **modeling tool for one model at a time**, held in your browser.
You author a system as text or by drawing, and it gives you back 16 views
of the same model — block diagrams, an interconnection diagram, action and state
diagrams, requirement tables, a traceability matrix, a dependency-structure
matrix, a 3D massing view — plus a rule-based check, a numeric solver, an
execution engine and a scriptable API.

What it is **not**:

- **Not a repository.** There is no shared server, no check-in/check-out, no
  branching that survives closing the tab. The Versions tab is real version
  control over your working model, and it lives in memory only.
- **Not a CAD or a physics tool.** The geometry view draws boxes, spheres and
  cylinders from attributes you wrote. The solver solves the algebra you wrote.
- **Not certified.** Sysprose implements a SysML v2–style textual notation and
  an OMG-API-shaped element graph; it is a candidate implementation and nothing
  here is a claim about conformance to a standard.
- **Not multi-file.** One model, one text buffer. `import` resolves against the
  bundled standard library and within the file, not across files on disk.

What it is unusually good at, and why you might keep it: **the model is text**,
so it diffs and reviews like code; **everything is a pure function**, so the
same answer comes out of the browser, the terminal and a script; and the
feedback is machine-readable, so an agent can write a model, read the findings
and repair them.

**Source of truth:** `src/diagram/types.ts:15-31` (the view list), `README.md`
("Name and standards status"), `src/api/versioning.ts:172-187` (the Versions
tab's repository, an in-memory one).

---

## 2. The first ten minutes

**Open the app.** The first thing you see is a "Loading standard library…"
screen. That is the standard library — an 8.2 MB download of 38761 elements in 98
packages — being merged into the model before anything is interactive. It is
once per page load; see [Limits](#8-limits).

When it clears you get a small `VehicleModel` sample and a three-zone shell:

```
┌───────────────────────── Toolbar (row 1 commands · row 2 views) ─────────────────────────┐
├──────────────┬──────────────────────────────────────────────────────┬────────────────────┤
│  Explorer    │  Palette │ Breadcrumb + canvas / table / graph        │  Properties        │
│  (the tree)  │          │ (the active view)                          │  (the selection)   │
├──────────────┴──────────────────────────────────────────────────────┴────────────────────┤
│  Problems · Text · API Console · Simulation · Versions                                   │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

**Load the example.** Toolbar → **Import**, and pick
[`examples/uav-isr.sysml`](../examples/uav-isr.sysml). Import *replaces* the
whole model (one undo restores what was there). You now have a small ISR
unmanned air system: an air vehicle whose subsystems are wired through power,
data and RF ports, plus a mission action flow, a flight-mode state machine and
the requirements they have to meet.

**Six things to do with it, in order.**

1. **Find the air vehicle.** In the Explorer, expand `UAVSurveillanceSystem` and
   click `AirVehicle`. Properties (right) fills in: metaclass, documentation,
   its attributes, and a *Used by* list of everything that references it.
2. **See it wired.** Switch to the **Interconnection** view (view bar, or press
   `2`). Right-click the `AirVehicle` box → **Scope diagram to this**. The
   diagram now shows that assembly's parts and the connections between their
   ports instead of the whole model. Scope follows **containment**, so scope to
   the *definition* that owns the parts: the `uav` box beside it is a usage typed
   by `AirVehicle` (`part uav : AirVehicle;`) and owns nothing, so scoping to it
   draws one box and no edges. To undo it, right-click any node → **Show whole
   model** — there is no other indicator that a scope is active.
3. **Read the requirements.** Switch to the **Requirements** view. One row per
   requirement: an outline number, its text, and a *Satisfied By* chip pointing
   at `uav`. The **ID** column reads `(id)` on both rows, and that is correct —
   an id comes from a declared short name (`requirement def <R-UAV-001>
   EnduranceRequirement`), and this example writes `attribute id = "R-UAV-001";`
   instead, which is an ordinary attribute and does not fill the column. This
   table is editable: click a cell and type.
4. **Check it.** Toolbar → **Validate**. The Problems tab fills with the
   validation findings — for this file, none. Then → **Check**, which adds a row
   per constraint saying whether it holds. Both requirements are satisfied:
   the derived endurance beats 45 min and the mass is under 25 kg.
5. **Solve it.** Toolbar → **Solve**. The Problems tab is replaced by solved
   values and a feasibility verdict. Note *replaced* — see
   [the Problems panel](#the-problems-panel-is-one-list) below.
6. **Break something on purpose.** Open the **Text** tab, change `45.0 [min]` to
   `100.0 [min]`, and press **Apply text → model**. **Check** again: the
   endurance constraint now reads *violated*. Check says *which* constraints
   hold, never by how much; press **Solve** for that, and Problems gains a
   `violated inequality: uav.endurance >= 100.0 [min] (by … [s])` row with the
   shortfall in seconds. Undo (`Ctrl+Z`) puts the model back.

**The same file, from a terminal**, without opening a browser at all:

```console
$ npm run sysprose -- stats examples/uav-isr.sysml
examples/uav-isr.sysml: 113 element(s) — 82 node(s), 31 relationship(s), 1 root(s), max depth 4
  library elements   38761
  (the library is bound alongside the model and left out of every figure above)
  by metaclass
    FeatureTyping           25
    AttributeUsage          16
    PortUsage               15
    ...
```

**Source of truth:** `src/ui/App.tsx:130-237`, `src/ui/panels/Toolbar.tsx:411-560`,
`src/core/factory.ts:194` (the boot sample), `scripts/sysprose.ts`.

---

## 3. The notation you actually type

The Text tab is the whole model as text, and it is the fastest way in. A short
list of constructs covers almost everything.

**A container.** Everything lives in a package.

```sysml
package UAVSurveillanceSystem {
    // ...
}
```

**A block, and a use of one.** `part def` declares a kind of thing; `part`
declares one, typed by a definition. Definitions are the reusable half; usages
are the ones that end up in your architecture.

```sysml
part def BatteryPack {
    attribute capacity : ISQ::EnergyValue = 640.0 [Wh];
}

part uav : AirVehicle;          // a usage, typed by the definition
```

**Attributes, with units.** A value can carry a unit in brackets. Units are
converted, not compared: `45.0 [min]` and a value in seconds are the same
dimension and the comparison is done properly. A plain `Real` is fine when the
quantity is a ratio.

```sysml
attribute mass : ISQ::MassValue = 3.4 [kg];
attribute usableEnergyFraction : Real = 0.8;
attribute endurance : ISQ::DurationValue = battery.capacity * usableEnergyFraction / cruisePower;
```

That last line is a **derived attribute**: an expression over other attributes,
recomputed by the solver rather than stored.

**Ports and connections.** A port is a typed interaction point with a direction;
a connection wires two of them.

```sysml
port def PowerPort { attribute voltage : ISQ::ElectricPotentialValue; }

part def BatteryPack { out port powerOut : PowerPort; }
part def FlightController { in port powerIn : PowerPort; }

connection powerToComputer connect battery.powerOut to flightComputer.powerIn;
```

**Behaviour: actions.** `first … then …` chains successions; a bare `then X;`
continues the chain from the previous step. `then X;` *references* a step, it
does not declare one — every name in the chain needs its own `action X;` line.

```sysml
action def FlyMission {
    action takeoff;
    action transitToArea;
    action surveilTarget;
    first takeoff then transitToArea;
    then surveilTarget;
}
```

**Behaviour: states.**

```sysml
state def FlightModes {
    state standby;
    state manual;
    transition standby -> manual;
}
```

**Requirements.** A requirement names its subject and, optionally, a constraint
that decides it. `satisfy … by …` is the trace link from the requirement to the
thing that meets it.

```sysml
requirement def EnduranceRequirement {
    attribute id = "R-UAV-001";
    doc /* The air vehicle shall sustain at least 45 minutes of flight. */
    subject uav : AirVehicle;
    require constraint { uav.endurance >= 45.0 [min] }
}

satisfy EnduranceRequirement by uav;
```

**Documentation.** `doc /* … */` is part of the model and survives a
round-trip. `//` line notes do not — they are stripped, like whitespace.

**Everything else you will meet:** `import`, `alias … for …`, `dependency A to
B`, `allocate`, `verify`, `refine`, `trace`, `derive`, `@Metadata`, and
`constraint`/`calc` bodies. If you write something the parser does not accept,
you get an exact line, column and hint — that is what [the checker](#6-checking-and-analysing)
is for.

**Source of truth:** `src/text/langium/sysml.langium`,
[`examples/uav-isr.sysml`](../examples/uav-isr.sysml),
[`examples/vehicle.sysml`](../examples/vehicle.sysml).

---

## 4. The views, and what each one answers

Row 2 of the toolbar groups the views the way this section does. All of them
show the same model; none of them is a separate document you have to keep in
sync. Switching views never changes the model.

A graph view can be narrowed to one subtree — right-click a node → **Scope
diagram to this**. That is what makes an interconnection diagram of one assembly readable.
**There is no on-screen indicator that a scope is active**; the breadcrumb above
the canvas shows the *selection* path, not the scope.

### Diagrams

The drawn views. **Auto-layout** and **Export → Diagram SVG / PNG** work on the
graph views — General, Interconnection, Action, State, Requirement, Tree,
Parametric and Case — and are greyed out everywhere else, with the reason in the
tooltip. Sequence and Geometry are drawn by their own renderers and lay
themselves out: Sequence has no drawing palette, Geometry does.

| View | What it shows | The question it answers | Test id |
|---|---|---|---|
| General | Definitions and usages as boxes with attribute and port compartments; composition ◆, reference ◇, specialization ▷ and satisfy/allocate edges | What are the parts of this system, and how do they relate? | `tb-view-general` |
| Interconnection | Parts nested inside their parent, ports on the boundaries, connections port-to-port | What is wired to what? | `tb-view-interconnection` |
| Action | Action nodes plus initial ●, decision ◇, fork/join ≡ and done ◉ control nodes, joined by successions | What happens, in what order? | `tb-view-action` |
| State | States and transitions labelled `trigger [guard] / effect` | What modes does it have, and what moves it between them? | `tb-view-state` |
| Requirement | Requirements with their satisfy / refine / verify endpoints | Which requirements exist, and what meets them? | `tb-view-requirement` |
| Tree | Pure containment, laid out as a graph | What owns what? | `tb-view-tree` |
| Parametric | Constraint nodes and the parameters bound into them | Which equations connect which values? | `tb-view-parametric` |
| Case | Use cases and the cases that include them | What is the system for? | `tb-view-case` |
| Sequence | Lifelines and time-ordered messages, falling back to control flow when the model has no explicit flows | Who talks to whom, in what order? | `tb-view-sequence` |
| Geometry | One primitive solid per structural part, from `shape` / `position` / `size` / `color` attributes, orbitable in 3D | Roughly how big is it, and what is inside what? | `tb-view-geometry` |

### Tables

Read-only, except the Requirements table, which is the one editable grid in the
app.

| View | What it shows | The question it answers | Test id |
|---|---|---|---|
| Allocation | A matrix of elements × elements with a mark wherever an Allocation joins them (falling back to Satisfy when a model declares no allocations) | What is allocated to what? | `tb-view-allocation` |
| Grid | Every in-scope non-relationship element as a row: name, metaclass, type, multiplicity, value, redefines, doc | What is in this model, in bulk? | `tb-view-grid` |
| Requirements | Hierarchical requirement rows with outline numbers, editable id / name / text, chips for Satisfied By / Verified By / Refined By / Traced To / Derived From, and a Kind cell plus the nine management attributes (status, verdict, risk, priority, criticality, rationale, source, owner, verification) | Are my requirements covered, and by what? | `tb-view-requirements` |

The Requirements view edits the model directly: adding a chip creates the
backing relationship, and ✕ deletes it. A cell with a closed list of values is a
drop-down offering exactly what a write will accept; the rest are click-to-edit
text. **Kind** says what a row is for — a `prose` or `prompt` row stays in the
grid, labelled, and is left out of the coverage figure rather than counted as a
gap nothing can close.

### Analyze

Workbenches for models too big to read. They are the least
self-explanatory views in the app, so each gets a sentence of theory.

| View | What it shows | The question it answers | Test id |
|---|---|---|---|
| Analysis | A force-directed graph of the model with community detection (Louvain / label propagation / components), node sizing by degree or PageRank, plus a DSM heat-map mode with Louvain or Cuthill–McKee ordering | Where are the natural subsystems, and which elements are hubs? | `tb-view-analysis` |
| Planning | Atomic elements carrying a workload attribute, rolled up by a chosen association and bin-packed into capacity-bounded waves | If I had to do this in stages, what goes in which stage? | `tb-view-planning` |
| Regroup | Drag parts between proposed bundles; the preview shows which connections would become external interfaces and which delegation ports Apply would create | What if I re-drew the subsystem boundaries? | `tb-view-regroup` |

- **A cluster / community** is a set of elements more connected to each other
  than to the rest. **PageRank** sizes a node by how much of the graph flows
  through it. Both are heuristics for *where to look*, not verdicts.
- **A DSM** (dependency-structure matrix) is the model's adjacency matrix with
  rows and columns in the same order: a block on the diagonal is a subsystem,
  a mark far above it is a long-range dependency.
- **A delegation port** is the port Regroup synthesizes on a new composite when
  a connection you kept crosses the boundary you just drew.

Regroup's preview never touches the model. **Apply** does, in one undoable step.

**Source of truth:** `src/diagram/build.ts:9-22`, `src/diagram/matrix.ts`,
`grid.ts`, `sequence.ts`, `geometry3d.ts`, `graph-analysis.ts`, `planning.ts`,
`regroup.ts`, `requirements-table.ts`; `src/ui/panels/Toolbar.tsx:47-64`
(the grouping); `src/ui/store.ts:212-226` (the diagram scope).

---

## 5. Authoring, and the one dangerous button

### The loop

There is one loop, and everything else is a detail of it:

> **Edit anywhere → the model changes → the derived surfaces catch up → the Text
> tab can push a change back the other way.**

You can edit in four places, and they are equal: the Explorer tree (add child,
rename, drag to reparent, delete), the canvas (draw with the palette, drag,
right-click), the Properties panel (every field of the selection), and the
Requirements table.

The tree and Properties update instantly. The diagram, the Problems list and the
Text tab are *derived*, and they lag a burst of edits by up to 250 ms. That is
deliberate: it keeps typing responsive.

### The Text tab, in both directions

- **Model → text** happens by itself. The buffer is re-serialised after every
  edit, and the indicator under the editor reads *in sync with model*.
- **Text → model** happens only when you press **Apply text → model**. Until you
  do, the indicator reads *modified — not yet applied*.

> ### ⚠ Apply text → model replaces the entire model
>
> It parses the whole buffer and **resets the model to the result**. Three
> consequences you have to know before you press it:
>
> 1. **A syntax error does not cancel the apply.** Error recovery produces a
>    partial reading, and that partial reading becomes your model. The parse
>    errors appear in Problems and in the strip under the editor.
> 2. **One undo restores exactly what you had** — one snapshot is pushed first,
>    and that is the whole safety net. A second edit and it is gone.
> 3. **Editing the model discards unapplied text edits.** A local model edit
>    force-overwrites the buffer. If you typed into the Text tab and then
>    clicked something in the tree, your typing is gone.
>
> After an apply, the standard library is re-merged asynchronously, which is why
> Problems and the text buffer visibly refresh a second time a few hundred
> milliseconds later. When a parse error is standing, that refresh deliberately
> leaves your text alone rather than serialising the partial model over it.

### Undo

Undo is 50 snapshots deep, it covers model changes (not view changes, not the
theme), and any new edit clears the redo stack. Copy is not undoable; paste is.

**Source of truth:** `src/ui/store.ts:858-967` (the recompute cycle),
`1873-1896` (`applyText`), `2260-2298` (undo), `2395-2416` (the post-apply
refresh); `src/ui/panels/TextEditor.tsx`;
`test/e2e/text-apply-contract.spec.ts:30` (the one-undo guarantee, as a test).

---

## 6. Checking and analysing

### Four buttons that answer four different questions

| Button | What it runs | What you get |
|---|---|---|
| **Validate** | the rule engine (23 rules) over the model | naming, typing, multiplicity, containment and traceability findings |
| **Check** | the same findings, minus the rule engine's own constraint rows, plus one row per constraint in the model | satisfied / violated / could-not-evaluate, per constraint, navigable to the constraint |
| **Simulate** | one batch run of an action flow or state machine | a step-by-step trace: steps, edges fired, loop iterations, whether it completed |
| **Solve** | the numeric solver and the measures of effectiveness | solved values, violations, unknowns, and a feasibility verdict |

Two names worth separating:

- **The *Simulate* button and the *Simulation* tab are different things.** The
  button is a one-shot batch run that dumps a trace into Problems. The tab is an
  interactive stepper: pick a machine, Start, then Play / Step / Inject an event
  / scrub the trace, with the active states glowing on the state diagram.
- **`feasible` means "no *known* violation."** A relation neither engine could
  judge is reported under *unknowns* and leaves the flag true. Read the two
  together; an unjudged constraint is not a satisfied one.

### The Problems panel is one list

Validate, Check, Simulate, Solve, parse diagnostics and the FMI-import error all
write into the **same** list, and each one **replaces** the last. They do not
accumulate. Click Solve after Validate and the validation findings are gone
until you click Validate again. Every row with an element selects it when
clicked.

### The same answers from a terminal

Every question you can put to the app you can also put to a terminal. On the
unmarked rows below the subcommand runs **the same function** the control runs,
so those two figures cannot disagree. A **†** marks a row where the app answers
the same question by drawing its own projection instead — there the two figures
may legitimately differ, and the difference is spelled out under the table.

| Question | In the app | From a terminal |
|---|---|---|
| Is this file sound? | **Validate** † | `npm run check -- model.sysml` |
| How big is it, what shape? | API Console → Metrics | `npm run sysprose -- stats model.sysml` |
| What is in it? | **Grid** view | `npm run sysprose -- elements model.sysml` |
| Are the requirements covered? | **Requirements** view | `npm run sysprose -- requirements model.sysml` |
| What satisfies / allocates what? | **Allocation** view † | `npm run sysprose -- trace model.sysml --relation satisfy` |
| Which ports are wired? | **Interconnection** view † | `npm run sysprose -- connectivity model.sysml` |
| What breaks if I change this? | Properties → *Used by* † | `npm run sysprose -- where-used model.sysml --element X` |
| What did I declare and never use? | — | `npm run sysprose -- orphans model.sysml` |

† **Validate** re-runs the rule engine over the model already in the editor;
`check` parses the file first and then applies those same rules. The
**Allocation** view tabulates only the elements that take part in a link, where
`trace` tabulates every element of the row and column kinds and so also shows
what links to nothing. The **Interconnection** view *draws* the ports and
connections; it computes no connectivity report — `connectivity` exists only in
the terminal and the SDK, as do `orphans` and the depth walk behind
`where-used`. Properties → *Used by* lists everything referencing the
selection, library and re-derived copies included, where `where-used` drops the
library, walks to the `--depth` you ask for and tells you what it left out.

Three real answers on the shipped example:

```console
$ npm run sysprose -- requirements examples/uav-isr.sysml
examples/uav-isr.sysml: 2 of 2 requirement(s) satisfied (100%)
  [x] 1  EnduranceRequirement — satisfied by uav
  [x] 2  MassRequirement — satisfied by uav
  24 bundled library requirement(s) and 0 re-derived copy/copies are not counted

$ npm run sysprose -- connectivity examples/uav-isr.sysml
examples/uav-isr.sysml: 15 port(s), 9 connection(s), 14 connected, 1 unconnected
  ...
  unconnected ports
    UAVSurveillanceSystem::DataLink::antenna
  ...

$ npm run sysprose -- orphans examples/uav-isr.sysml
examples/uav-isr.sysml: 2 of 14 definition(s) unused
  UAVSurveillanceSystem::FlyMission [ActionDefinition]
  UAVSurveillanceSystem::FlightModes [StateDefinition]
  1 package(s) skipped as namespaces; 1434 library and 0 re-derived definition(s) excluded
  an unused definition is valid — this is an inventory, not a diagnostic
```

Two things those transcripts are telling you, and both are on purpose. Every
report **excludes the bundled library and the tool's own re-derived elements**,
so the numbers are about *your* file, and says how many it left out — `stats`
counts the library, `elements` the re-derived copies, the rest both. And
`orphans` is an inventory, not a verdict: the two "unused" definitions are the
mission behaviour and the flight modes, which nothing in the model references
yet — that is a fact about the model, not a defect in it.

Add `--json` to any `sysprose` **subcommand** for `{ok, file, <report>}` on
stdout. `npm run check -- model.sysml --json` is the other shape —
`{ok, files: [...]}`, plural, because `check` takes several files at once — and
it is the other exit-code contract too. For a subcommand, **0** means clean, **1** the model did not load
cleanly (you still get a report, of what parsed, with a `degraded` banner on
stderr) and **2** you asked for something impossible; `check` *judges*, so its
**1** means the file has findings — a file that parsed perfectly and broke one
validation rule exits 1. Full flag list:
[`CLI-REFERENCE.md`](CLI-REFERENCE.md).

### Scripting it

Inside the browser, the SDK is on `window.sysml` (the API Console tab is a
console over it) and diagram scoping is on `window.sysprose.diagram`. Outside
it, every one of these engines is an importable function — `checkText`,
`modelMetrics`, `requirementSatisfaction`, `whereUsed`, `analysisReport`,
`buildGrid`, `buildDSM`, `buildPlan` — with no DOM anywhere in them.

**Source of truth:** `src/ui/store.ts:1627-1753` (the four buttons),
`src/api/analytics.ts:1215-1290` (`feasible`), `src/ui/App.tsx:39-64`
(`window.sysml`), `scripts/sysprose.ts`, `scripts/sysml-check.ts`.

---

## 7. What is kept, and what is not

Nothing here leaves your browser. Nothing here is saved for you automatically.

| What | Where it goes | Survives a reload? |
|---|---|---|
| A project you pressed **Save** on | IndexedDB (`sysmlv2-modeler`), falling back to localStorage | **Yes** — reopen it with **Open ▾** |
| Anything you did **not** save | nowhere | **No** — deliberately: the app boots the sample rather than resurrecting your work |
| Versions-tab commits, branches, merges | memory | **No** |
| Regroup scenarios | localStorage (`sysmlv2-scenarios`) | Yes |
| Light/dark theme | localStorage (`theme`) | Yes |
| Panel widths, Explorer focus and filter, the library toggle, the diagram scope, the armed palette tool | memory | No |
| An exported file | your downloads folder | it is a file |

**Save takes no name and shows no confirmation.** It writes over the current
project name. **New** does not prompt either — it clears the model (one undo
brings it back).

If you want the model out of the browser, use **Export ▾**: SysML text, model
JSON, OMG-API-shaped JSON, the diagram as SVG or PNG, or an FMI 3.0 FMU /
`modelDescription.xml` for the selected block.

**Source of truth:** `src/persistence/store.ts:88-135`, `src/branding.ts:48`,
`src/ui/store.ts:497-517`, `1904-1953`, `src/ui/App.tsx:71-75`,
`test/e2e/persistence-reload.spec.ts`.

---

## 8. Limits

Stated plainly, because finding these out by surprise is worse.

- **The library is a real download** — the size is in
  [§2](#2-the-first-ten-minutes). It is fetched and merged before the app is
  interactive, and re-merged a few hundred milliseconds after every Apply,
  Import, Open and branch switch; that second merge is why Problems and the text
  buffer refresh twice.
- **Derived surfaces lag** behind a burst of edits
  ([§5](#5-authoring-and-the-one-dangerous-button)).
- **Undo is bounded and model-only.** View changes, scoping and the theme are
  not undoable.
- **The diagram scope is invisible.** Only the right-click menu tells you it is
  set, and only by offering to clear it.
- **PNG export is a white-background rasterisation** of the SVG at 2×. Dark
  theme is not honoured. SVG and PNG export, and Auto-layout, are disabled off a
  graph view — the greyed control's tooltip says why.
- **Collaboration needs a relay you start yourself** (`npm run collab`), rooms
  are open with no permissions layer, and your identity is a random per-session
  name and colour.
- **Feasibility is approximate.** The solver is penalty-driven; `feasible` means
  no known violated inequality, and unjudged relations are listed separately.
- **The geometry view is massing, not CAD** — primitive solids from attributes.
- **One file at a time.** No cross-file imports, no workspace.
- **`Ctrl+N` is not a shortcut.** New is a toolbar button only.

**Source of truth:** `src/library/std/manifest.json`, `src/ui/store.ts:165`,
`858-905`, `2428-2469`, `src/ui/panels/Toolbar.tsx:80-89`, `186-229`,
`src/api/analytics.ts:1225-1232`, `src/ui/commands.ts:111-213`.

---

## 9. Where to go next

- [`CLI-REFERENCE.md`](CLI-REFERENCE.md) — every subcommand and flag, generated
  from the command table itself.
- [`DIAGNOSTIC-CODES.md`](DIAGNOSTIC-CODES.md) — every finding code, what
  triggers it, and the repair it suggests. Branch on `code`, never on `message`.
- [`AGENT-AUTHORING-CAMPAIGN.md`](AGENT-AUTHORING-CAMPAIGN.md) — how an agent is
  meant to write and repair models here, and the defects that campaign found.
- [`02-omg-standard-reference.md`](02-omg-standard-reference.md) — the language
  and API this tool implements a subset of.
- [`FEATURE-PARITY.md`](FEATURE-PARITY.md) — what exists compared with other
  tools, with a test citation per row.
- [`../examples/`](../examples/) — the shipped models.

---

## Appendix A — every control, and the id a test can find it by

Every control carries a stable `data-testid`. The E2E suite drives the app by
these ids, and so can you (or an agent) from a browser console. They are checked
against the source by `test/unit/user-guide.test.ts`, so this table cannot
quietly go stale.

### Toolbar, row 1

| Control | What it does | Test id |
|---|---|---|
| New | Clears the model to an empty `NewModel` package. No prompt; one undo restores. The standard library stays loaded. | `tb-new` |
| Open ▾ | Lists saved projects; picking one replaces the model | `tb-open` |
| Save | Writes the model into browser storage under the current project name. No dialog, no confirmation. | `tb-save` |
| Import | Opens a `.sysml` / `.json` / `.txt` file and **replaces** the model | `tb-import` |
| Import FMI | Adds a block read from an FMI 3.0 `modelDescription.xml` (adds, does not replace) | `tb-import-fmi` |
| Export ▾ | The export menu | `tb-export` |
| Export → SysML (.sysml) | The model as textual notation | `tb-export-sysml` |
| Export → Model JSON | The native model graph | `tb-export-json` |
| Export → OMG API JSON | The OMG-API-shaped element graph | `tb-export-api-json` |
| Export → Diagram SVG | The current diagram (drawable views only) | `tb-export-svg` |
| Export → Diagram PNG | The same, rasterised on white — the scale is in [§8](#8-limits) | `tb-export-png` |
| Export → FMU (.fmu) | The selected block as an FMI 3.0 FMU | `tb-export-fmu` |
| Export → FMI description | Just the `modelDescription.xml` | `tb-export-fmi-xml` |
| Validate | Runs the rule engine into Problems | `tb-validate` |
| Check | Validation plus one row per constraint | `tb-check` |
| Simulate | One batch run of a behaviour, as a trace in Problems | `tb-simulate` |
| Solve | Numeric solve, measures of effectiveness and feasibility | `tb-solve` |
| Auto-layout | Re-runs the layout, discarding manual node positions (drawable views only) | `tb-layout` |
| Collaborate | Room name, connect/disconnect and the participant roster | `tb-collab` |
| Undo / Redo | Snapshot undo and redo; the depth is in [§5](#5-authoring-and-the-one-dangerous-button) | `tb-undo`, `tb-redo` |
| Theme | Light/dark, remembered | `tb-theme` |

### Toolbar, row 2 — the view bar

| Group | Views | Test ids |
|---|---|---|
| Diagrams | General, Interconnection, Action, State, Requirement, Tree, Parametric, Case, Sequence, Geometry | `tb-view-general`, `tb-view-interconnection`, `tb-view-action`, `tb-view-state`, `tb-view-requirement`, `tb-view-tree`, `tb-view-parametric`, `tb-view-case`, `tb-view-sequence`, `tb-view-geometry` |
| Tables | Allocation, Grid, Requirements | `tb-view-allocation`, `tb-view-grid`, `tb-view-requirements` |
| Analyze | Analysis, Planning, Regroup | `tb-view-analysis`, `tb-view-planning`, `tb-view-regroup` |

### Panels

| Control | What it does | Test id |
|---|---|---|
| Explorer tree | The containment hierarchy of the model | `explorer-tree` |
| Explorer search | Filters to matches and their ancestors; `/` focuses it, Escape clears | `explorer-search` |
| Library toggle | Shows the bundled standard library in the tree (off by default) | `explorer-library-toggle` |
| Focus a subtree | Narrows the Explorer to one element; the chip clears it | `tree-focus`, `explorer-focus`, `explorer-focus-clear` |
| Add child / rename / delete | Per-row tree editing | `tree-add`, `tree-rename`, `tree-delete` |
| Properties fields | Name, type, value, multiplicity, direction, documentation, requirement id and text | `prop-name`, `prop-type`, `prop-value`, `prop-doc` |
| Statement kind | What the selected element is for — requirement / prose / prompt — offered wherever the notation can carry the keyword, which is most declarations and not only requirements | `prop-statement-kind` |
| Requirement attributes | The nine management facets of a requirement — status, verdict, risk, priority, criticality, rationale, source, owner, verificationMethod — one control each, named `prop-rm-<facet>` after the key it writes | `prop-req-attrs` |
| Requirement facet cells | The same ten facets as columns in the Requirements table — a drop-down (`req-attr-select`) where the key has a closed list, click-to-edit text (`req-attr-input`) where it does not; disabled, with the reason on the cell, on a row whose declaration could not be parsed | `req-attr-cell` |
| Where-used list | Everything that references the selection, click to navigate | `prop-used-by` |
| Impact graph | The 1-hop reference neighbourhood, drawn | `prop-impact` |
| Breadcrumb | The containment path of the **selection** (not the diagram scope) | `breadcrumb` |
| Palette | The drawing tools of the active view; hidden on views with none | `palette` |
| Canvas | The diagram itself | `diagram-canvas` |
| Fit / zoom to selection / snap / auto-layout | The canvas mini-toolbar | `diagram-fit`, `diagram-fit-selection`, `diagram-snap`, `diagram-autolayout` |
| Scope diagram to this / Show whole model | Narrow every drawable view to one subtree, and clear it | `node-ctx-scope`, `node-ctx-scope-clear` |
| Legend | The notation families present in this view | `diagram-legend` |

### Bottom panel

| Tab | What it is | Test id |
|---|---|---|
| Problems | One shared list, overwritten by Validate / Check / Simulate / Solve / parse | `tab-problems` |
| Text | The model as editable text, with **Apply text → model** | `tab-text`, `text-editor`, `text-apply` |
| API Console | A console over the live SDK: queries, metrics, requirement satisfaction, where-used, commit | `tab-api`, `api-query`, `api-run`, `api-metrics` |
| Simulation | The interactive stepper: target, start, play, step, inject, scrub | `tab-simulation`, `sim-target`, `sim-start`, `sim-step`, `sim-inject` |
| Versions | Commits, branches and a 3-way merge over the working model — in memory only | `tab-versions`, `version-commit-btn`, `version-branch-new`, `version-merge-btn` |

---

## Appendix B — keyboard shortcuts

Plain keys are suppressed while you are typing in a field.

| Key | What it does |
|---|---|
| `1` … `6` | General, Interconnection, Action, State, Requirement, Tree |
| `/` | Focus the Explorer search box |
| `Delete` / `Backspace` | Delete the selection (ignored while a button has focus) |
| `Ctrl/⌘ + Z` | Undo |
| `Ctrl/⌘ + Shift + Z`, `Ctrl/⌘ + Y` | Redo |
| `Ctrl/⌘ + S` | Save the project |
| `Ctrl/⌘ + D` | Duplicate the selection |
| `Ctrl/⌘ + C` | Copy the selected subtrees (defers to native copy when text is selected) |
| `Ctrl/⌘ + V` | Paste under the selection |
| `Escape` | Disarm the palette tool, close a menu, cancel a rename |

There is no `Ctrl+N`; **New** is a button only.

**Source of truth:** `src/ui/commands.ts:111-213`, `src/ui/App.tsx:109-125`.
