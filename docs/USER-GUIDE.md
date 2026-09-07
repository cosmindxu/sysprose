# Sysprose user guide

For an engineer who has been handed the tool and has an afternoon.

It assumes you know systems engineering — blocks, interfaces, requirements,
states — and it does **not** assume you know SysML v2. Everything you have to
type is introduced here, in the order you need it.

Sysprose runs entirely in a browser tab. There is no server, no login and no
project on anyone's disk but yours. That shapes everything below, especially
[what is kept and what is not](#8-what-is-kept-and-what-is-not).

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
7. [Three kinds of statement](#7-three-kinds-of-statement)
8. [What is kept, and what is not](#8-what-is-kept-and-what-is-not)
9. [Limits](#9-limits)
10. [Where to go next](#10-where-to-go-next)
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
once per page load; see [Limits](#9-limits).

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
round-trip. `//` line notes do not — they are stripped, like whitespace. A
statement can also say what it is *for* — a rule, an explanation, or guidance
for an agent — with one keyword in front of its declaration:
[§7](#7-three-kinds-of-statement).

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
| **Validate** | the rule engine (25 rules) over the model | naming, typing, multiplicity, containment and traceability findings |
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
| What guidance applies to this element? | — | `npm run sysprose -- prompts model.sysml --element X` |
| What does each requirement assume and guarantee? | — | `npm run sysprose -- contracts model.sysml` |
| What must be shown, and what do the gates refuse? | — | `npm run sysprose -- obligations model.sysml` |
| Does the verdict in the file still hold? | **Requirements** view → *Evidence* column † | `npm run sysprose -- evidence-status model.sysml` |
| Write a run's verdicts into the file | — | `npm run sysprose -- evidence-attach model.sysml --from evidence.json` |
| Take them back off | — | `npm run sysprose -- evidence-detach model.sysml` |

† **Validate** re-runs the rule engine over the model already in the editor;
`check` parses the file first and then applies those same rules. The
**Allocation** view tabulates only the elements that take part in a link, where
`trace` tabulates every element of the row and column kinds and so also shows
what links to nothing. The **Interconnection** view *draws* the ports and
connections; it computes no connectivity report — `connectivity` exists only in
the terminal and the SDK, as do `orphans`, `prompts`, `contracts`, `obligations`,
`evidence-attach`, `evidence-detach` and
the depth walk behind `where-used`. The **Requirements** view's *Evidence* column
*reads* what a run left in the file — `current`, `stale` or `unrecorded`, with
the record's claim word beside it — where `evidence-status` prints every row
with its digest, its slice and its `verification/*` code; nothing in the app
writes a verdict. Properties → *Used by* lists everything referencing the
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

Two of the subcommands are about what a statement is *for* rather than what it
constrains. `requirements --kind prose` (or `prompt`, or `requirement`) narrows
the listing to statements of one kind without moving the coverage ratio, which
counts requirements alone; by default every statement is listed and the ones the
ratio leaves out say so on their own line. `prompts --element X` answers the
question an agent has instead: what guidance applies *here* — the prompts written
on that element, on what it is, on where it sits, and on where what it is sits,
nearest first, each with the words it carries. Both are worth a section of
their own: [§7](#7-three-kinds-of-statement).

Add `--json` to any `sysprose` **subcommand** for `{ok, file, <report>}` on
stdout. `npm run check -- model.sysml --json` is the other shape —
`{ok, files: [...]}`, plural, because `check` takes several files at once — and
it is the other exit-code contract too. For a subcommand, **0** means clean, **1** the model did not load
cleanly (you still get a report, of what parsed, with a `degraded` banner on
stderr) and **2** you asked for something impossible; `check` *judges*, so its
**1** means the file has findings — a file that parsed perfectly and broke one
validation rule exits 1. Full flag list:
[`CLI-REFERENCE.md`](CLI-REFERENCE.md).

### What a requirement promises, and what would have to be shown

Two subcommands read a requirement the way a proof engineer does, and both of
them ship **before** any solver exists. They report structure. Neither of them
ever says a requirement holds.

`contracts` is the inventory. For each requirement it prints the subject it is
about, what it **assumes**, what it **guarantees**, which `satisfy`, `verify`,
`derive` and `refine` statements name it, the variables its clauses read with
their units, and the arithmetic **fragment** each clause lands in — linear
(`QF_LRA`), nonlinear (`QF_NRA`) or not encodable at all. A case with an
`objective { assume … require … }` is a contract too: that is the standard's own
home for a behaviour's precondition and postcondition, and it is why Sysprose
ships no `#precondition` keyword for something the notation already expresses.

```console
$ npm run sysprose -- contracts examples/uav-isr.sysml
examples/uav-isr.sysml: 2 contract(s) on 1 subject(s); 2 guarantee(s) in QF_LRA, 0 in QF_NRA, 0 unsupported
  an inventory of what is written — this command says nothing about whether any of it holds
  UAVSurveillanceSystem::EnduranceRequirement  [RequirementDefinition]
    subject uav : AirVehicle (declared)
    require uav.endurance >= 45.0 [min]  [QF_LRA — linear real arithmetic]
    satisfy uav
    variables uav.endurance (derived)
  ...
```

`obligations` is the worklist: what would have to be **shown**, what may be
**assumed** while showing it, and which facts the model simply **states**. The
three buckets are fixed, and the one worth knowing is the last:

| What you wrote | What it becomes |
|---|---|
| `require constraint { … }` | an **obligation** — something to show |
| `assume constraint { … }` | a **premise** — something you may lean on |
| `assert constraint { … }` | an **axiom** |
| `attribute m = 18.5 [kg];` | an **axiom** — a `=` value is a binding, not a default |
| `bind a = b;` | an **axiom** |
| `constraint c { … }` — no keyword | an **obligation**, not an axiom |

That last row is deliberate. A plain constraint is what the **Analyze** button
judges, so it has to be what a solver judges as well; filing it as an axiom
would let one false constraint make the whole axiom set unsatisfiable and turn
every real violation in the run into "cannot tell".

The status column says what is **stored**, never what is true. `open` means
nothing has been shown yet; `no formal clause` means the requirement is prose
with no constraint body; `not encodable` means a gate refused the relation and
names which. `discharged` and `stale` are read back from an evidence record, so
nothing is ever discharged here today.

A `requirement massOk : MassLimit;` usage owns no clause of its own — the
`require constraint` is on the definition it applies. `contracts` says so on the
usage's row and files the clause once, on the definition; it is not counted as
prose-only, and it does not appear under `--missing`.

`obligations --missing` is the one to run first on a real requirement set. It
narrows the listing to exactly the rows this lane would **not** decide even with
every solver installed, and prints the histogram of the gates that refused them.
Expect a substantial fraction of a real programme's requirements to land there:
prose-only requirements, temporal ones, `°C` arithmetic, collection-valued
features. That is information about your model as much as about the tool, and it
arrives before anyone waits for a proof.

Both take `--element REF` — an id, a qualified name, or a name unique in the
model — to scope the report to one requirement or one package. A reference
naming bundled library content is refused: every figure in both reports is about
*your* model and excludes the library by construction.

**Source of truth:** `src/semantics/contracts.ts`, `src/semantics/obligations.ts`,
`src/api/verification.ts`, and the plan these implement,
[`04-formal-verification-plan.md`](04-formal-verification-plan.md).

### Whether it holds, and the two words that are not the same

`verify` is the one subcommand that reaches a **verdict**, and it is the one
whose exit code you should read before anything else. It has its own exit-code
contract, and it is not the other two: **0** every obligation discharged **and
there was at least one to discharge**, **1** at least one obligation
**refuted**, **2** usage, I/O, a degraded model, a model that states no
obligation at all, or **any** inconclusive.

The summary line leads with the **inconclusive** count, on purpose: it is the
figure that decides the exit code, and a line that opened with the green number
read as a pass with a footnote.

```console
$ npm run sysprose -- verify examples/uav-isr.sysml --engine literal
examples/uav-isr.sysml: 0 inconclusive, 2 discharged, 0 refuted — engine literal
  a point evaluation at the model's own values — `holds-at-values`, never `proved`
  UAVSurveillanceSystem::EnduranceRequirement  uav.endurance >= 45.0 [min]
    holds-at-values: holds at the model's values (no assumptions — the pass is unconditional at these values)
    bound: the model's own feature values, 1 of them; 0 free variables; compared as 2835.6923076923076 vs 2700 in T, coherent SI
    digest sha256:e4618d6f...
  ...
$ echo $?
0
```

That `compared as … coherent SI` clause is not decoration. `uav.endurance` is
**derived** — the model computes it — so what it *stores* is `0.7877`, the hours
its own equation produced, with no declared unit, beside a requirement written
in `[min]`. Read on its own that number looks like a refutation of the verdict
it supports. The SI pair is what the comparison was actually made on, it is in
the evidence record's `bound.si`, and every witness value in a record carries
its `role` so a computed value is never mistaken for one you could edit.

**`holds-at-values` is not `proved`, and the tool will not let the two words
blur.** The literal engine substitutes the values your file states and reads off
the answer. That is worth having — it is what the **Analyze** button already
computes, it needs nothing installed, and it is the first thing anyone wants —
but it holds at *one point* of a design space that is infinite. `proved` is
reserved for the solver showing that the negation of the obligation is
unsatisfiable, and only the SMT engine can say it.

**Three engines, and the one that is missing never goes green.**

| `--engine` | What it does |
|---|---|
| `literal` | Evaluates at your model's values. `holds-at-values` counts as discharged, **because you asked for a point evaluation by name**. |
| `smt` | The solver. `proved` is available here and nowhere else. With no solver installed, every obligation comes back `verification/tool-absent`, exit 2. |
| `auto` (default) | Resolves to `smt` when a solver backend loads, and otherwise reports `tool-absent` for everything. **It never falls back to `literal`.** |

That last line is the rule to remember: with no solver present, the same file
that is exit 0 under `--engine literal` is exit **2** under the default
`--engine auto`. "No solver, nothing to report, exit 0" would be
indistinguishable from a proof, so it does not happen.

**What `proved` stands on.** The engine asks four questions per obligation, and
each of the last three exists to stop a proof that would be void rather than
absent:

```console
$ npm run sysprose -- verify examples/uav-isr.sysml --engine smt
examples/uav-isr.sysml: 0 inconclusive, 2 discharged, 0 refuted — engine smt
  negation-unsat under a satisfiable axiom set — `proved` means exactly that, at 5000 ms per check, with every feature value bound as the model states it
  UAVSurveillanceSystem::EnduranceRequirement  uav.endurance >= 45.0 [min]
    proved: A ∧ P ∧ ¬G unsat, QF_NRA, 4 fixed / 0 free, timeout 5000 ms; assumptions satisfiable
    bound: every feature at the value the model binds it to; 4 symbol(s), 0 free; compared as 2835.69… vs 2700 in T, coherent SI; decided by z3 Z3 5.1.0.0, seed 0
  ...
$ echo $?
0
```

- **Is the model's own axiom set satisfiable?** Asked once per run. If your file
  contradicts itself, *every* negation is unsat and every obligation would print
  as proved — so instead every row is `verification/inconsistent-axioms` with
  the colliding facts named, and nothing is decided.
- **Is the negation unsatisfiable?** Unsat ⇒ the obligation holds everywhere
  your axioms and assumptions allow. Sat ⇒ a counterexample, which is checked
  before it is printed (below).
- **Can the assumptions all hold at once?** If not, the obligation was
  discharged for free: `verification/vacuous`, exit 2, never a pass.
- **Is the goal true of *every* model?** `panel.area == panel.area` is honestly
  proved and honestly useless, so it is proved **and flagged as a tautology**.

**A counterexample is re-checked before you see it.** Every witness the solver
returns is substituted back through this tool's own evaluator, and with nothing
freed it must also read as *violated* on the numeric surface — a second,
independent path. A witness that fails either gate is reported as
`inconclusive: witness not confirmed`, never as a violation. That is what
catches an encoder defect in the direction that matters, and it is why an exact
strict boundary (`mass < 18.5 [kg]` at 18.5 kg, where the two surfaces genuinely
read the tie differently) comes back undecided rather than as a refutation of a
requirement the checker passes.

**Freeing a feature is a two-sided act.** `--free F` releases a value so the
solver may vary it — but this tool derives no domain axiom from a quantity kind.
It does not know that a power is non-negative. Freeing `uav.cruisePower` under
an assumption that only caps it from above lets a solver answer with **−1 W**,
and the re-evaluation gate *confirms that arithmetic*, so it would print as a
genuine refutation of a requirement nothing is wrong with. So a freed feature
the assumptions do not confine on **both** sides is
`verification/free-variable-unbounded` — inconclusive, exit 2, never refuted.
Write the premise both ways round first:

```sysml
assume constraint { uav.cruisePower >= 100.0 [W] and uav.cruisePower <= 600.0 [W] }
```

**`--timeout MS` is a budget, not a switch.** Every check in this lane is
bounded (5000 ms by default) and there is no spelling for "no timeout":
`--timeout 0` and `--timeout forever` are refused rather than quietly replaced
by the default, because a reader who asked for a bound the tool did not honour
would read every `unknown` under a bound that was never in force. A solver that
runs out of time reports `verification/timeout`, which says nothing about
whether the requirement holds, and it is not retried with a weaker encoding.

**`--strict-vacuity` is loud and inert.** It raises a vacuous obligation from an
info line to `verification/vacuous-property`, an **error** — and changes the
exit code not at all. Vacuity is inconclusive and exits 2 with the flag and
without it. Use it when a vacuity is something you want a build log to shout
about rather than something to scroll past.

**What is inconclusive, and what a flag may forgive.**

| The row says | What happened | `--allow-inconclusive`? |
|---|---|---|
| `verification/unsupported-construct` | The relation is well formed and its **shape** is outside the fragment this lane encodes — `%`, a variable exponent, a collection, arithmetic on °C — or the requirement is prose with no constraint body | **Yes** — lowered to exit 0 |
| `verification/timeout` | The solver ran out of time — raise it with `--timeout MS` | **Yes** |
| `verification/not-evaluable` | Your values do not determine the answer, **or nobody could read the relation at all** — it names a feature that does not exist, compares kilograms against metres, does not parse, or produced a witness this tool could not confirm | No |
| `verification/vacuous-pass` | The `assume` clause is **false** here, so the requirement is discharged by something that does not hold | No |
| `verification/vacuous` | The solver found the assumptions unsatisfiable — nothing at all can satisfy them | No |
| `verification/vacuous-property` | Either vacuity, raised to an **error** because you passed `--strict-vacuity`. Same exit code | No |
| `verification/inconsistent-axioms` | Your model's own facts collide, so nothing can be proved from them | No |
| `verification/free-variable-unbounded` | A feature you freed is not confined on both sides, so a witness could come from outside the physical domain | No |
| `verification/tool-absent` | No engine ran | No |
| `verification/design-admitted` | Refuted only after `--free` released a value your model states | No |
| `verification/refuted` | False with every feature at its model value | No — exit **1** beats the flag |
| `verification/inconsistent-requirements` | No design point satisfies every requirement on one subject — `consistency` names the conflicting subset | No — exit **1** beats the flag |

**A vacuous requirement is reported as undecided, and that is a deliberate
disagreement with the specification.** Part 1 §9.2.14.2.8 gives a requirement
check as `allTrue(assumptions) implies allTrue(constraints)`, which makes a
requirement with a false assumption **true**. A requirement discharged by an
antecedent that does not hold tells you nothing, and it is the classic way a
whole requirement set passes while meaning nothing — so this tool says
`vacuous`, exits 2, and records the disagreement in
[`CONFORMANCE.md`](CONFORMANCE.md).

**`--record PATH` writes the evidence.** One record per obligation: the claim,
the engine, the tool and its version, the bound the claim holds within, the
witness (your own values), the flags that changed what was shown, and two
digests — one for the obligation's normal form, one for your model. Records
carry **no timestamp**, so two runs over an unchanged file produce byte-identical
files and a `diff` answers "did anything change?". The model digest is taken
over qualified names rather than element ids, which are fresh on every load, so
it survives a reparse and moves when you edit a literal. The shape is documented
in [`schemas/evidence-record.schema.json`](schemas/evidence-record.schema.json).

`--record` **refuses a model that did not load cleanly.** A record is durable
and diffable; one written over half a model would claim `holds-at-values` about
a file the same run calls unreadable, bound to a digest taken over only what was
salvaged. Fix the findings first, or read the verdict on stdout without
`--record`.

`--free F` releases a feature value so a solver may vary it; a refutation
obtained that way is a design your model *admits*, not a violation of it, and it
is reported as `design-admitted` and exit 2 — never exit 1. A spelling that
frees nothing is refused rather than ignored, because a name that quietly freed
nothing would print a verdict under a bound the record then claims was in force
— and there are three ways to free nothing, all three refused: a name that
matches no element, a bare name that matches **more than one** (`--free uav` on
the shipped example names three: the part usage and the `subject uav` of each
requirement — write the qualified name of the one you mean), and a name that
resolves to something no relation in the run reads. That last one is not
hypothetical: `--free UAVSurveillanceSystem::uav` names the part usage, which is
not a variable any relation reads, so it released nothing at all — and the run
printed `proved` and exited 0 under a header reading "with uav released", where
the intended `--free uav.cruisePower` is `design-admitted` and exits 2. The
refusal names what *could* be freed here, so the next attempt is a
copy-and-paste. The literal engine refuses the flag outright rather than
accepting and ignoring it.

**Source of truth:** `src/semantics/engines/literal.ts`,
`src/semantics/engines/smt.ts`, `src/api/evidence.ts`,
`src/api/verification.ts`, and the golden verdict corpus in
`test/fixtures/verification/`.

### Whether the requirements can all hold at once

`verify` asks whether each requirement holds **of the design your file
describes**. `consistency` asks the other question: could these requirements be
met by **any** design at all? The two are different, and they disagree by
construction — a file whose values break a requirement is `refuted` by the first
and has a perfectly satisfiable requirement set according to the second. That is
why they are two subcommands and not a flag.

```console
$ npm run sysprose -- consistency examples/uav-isr.sysml --with-values
examples/uav-isr.sysml: 0 inconsistent, 0 inconclusive, 1 consistent — 2 requirement(s) on 1 subject(s)
  asked at the model's own values (`--with-values`): …
  subject UAVSurveillanceSystem::AirVehicle (as `uav`) — consistent
    2 requirement(s) can hold together at the model's own values (`--with-values`): QF_LRA,
    witness …::mtow = 18.5, …::cruisePower = 650 (stored magnitudes), re-read in
    process. 0 relations refused. …
$ echo $?
0
```

**By default the numbers in your file do not get to answer.** Every feature that
carries a literal value is **released**, and only the structural axioms —
`assert constraint` bodies, `bind` equalities and the defining equations of
derived features — are kept. A requirement set is inconsistent when *nothing* can
satisfy it, and answering that with whatever `mtow` happens to be today would be
a question about one design point rather than about the requirements. The report
says which values it let go and how many. `--with-values` re-pins them and asks
the weaker question — "can these requirements hold together *at the point this
file states*" — and every verdict line names which of the two it was computed
in.

**Each requirement is read as `assume ⇒ require`, and every verdict line says
so.** That is the reading the shipped library states
(`Requirements::RequirementCheck` is `allTrue(assumptions()) implies
allTrue(constraints())`) and the one `verify` uses on the same file. It matters
most for mode- and phase-conditional requirements: `assume { mode == cruise }`
against `assume { mode == ferry }` is **not** a conflict, because no single
design point is ever required to meet both guarantees. Read as a conjunction
they would be reported as contradictory, which is a false alarm on one of the
commonest patterns in systems engineering.

The price of that reading is paid rather than hidden. A set of implications is
satisfiable by falsifying every antecedent, so each requirement that carries
assumptions is asked a second question — can it be **engaged** at a point the
whole set admits? A set that holds only because one of its requirements never
applies is **not** reported consistent: the row comes back `inconclusive` under
`verification/vacuous` with the requirement and its assumptions named, exit 2,
and no flag lowers it — the same rule `verify` applies to an obligation
discharged by an antecedent nothing can satisfy. The witness is still printed,
because the set *is* satisfiable; what is undecided is whether the requirements
mean anything at that point.

Mutually exclusive modes pass that check — each is engaged at its own point —
while two requirements under the **same** assumption whose guarantees collide
fail it. So a conditional requirement is neither exempt from scrutiny nor
falsely accused.

**An inconsistency is only ever printed with a named subset.** The engine
asserts each requirement under its own tracking literal, so an `unsat` comes back
with the labels that collided:

```console
$ npm run sysprose -- consistency conflict.sysml --minimize
conflict.sysml: 1 inconsistent, 0 inconclusive, 0 consistent — 2 requirement(s) on 1 subject(s)
  subject ConsistencyConflict::AirVehicle (as `uav`) — inconsistent
    …a minimal conflicting subset is {R-UAV-002::mtowCeiling, R-UAV-004::mtowFloor}. 0 relations refused
    verification/inconsistent-requirements
    a minimal conflicting subset, 2 member(s):
      R-UAV-002  uav.mtow <= 25.0 [kg]  [guarantee: ConsistencyConflict::MassCeiling::mtowCeiling]
      R-UAV-004  uav.mtow >= 30.0 [kg]  [guarantee: ConsistencyConflict::MassFloor::mtowFloor]
$ echo $?
1
```

**Exit 1 means the same kind of thing here as it does for `verify`:** a decided
finding about your model. `verification/inconsistent-requirements` is an
**error**, and no flag forgives one.

**"Minimal" is a word only `--minimize` can earn.** A solver's unsat core is not
minimal — it is *a* subset that collides — so the report calls it *a conflicting
subset*. `--minimize` runs a deletion loop, one solver check per member, removing
each in turn and keeping it only if the rest become satisfiable without it. Only
a loop that ran **to completion** upgrades the phrase to *a minimal conflicting
subset*; a timeout, or a core larger than `--max-core` (default 8), leaves the
weaker phrase and says the budget was why.

**"Consistent" always comes with the count of what was left out.** A relation a
gate refused — arithmetic on a °C scale, a `%`, a collection — is listed with its
reason and is *not* asserted. That cuts both ways, and the asymmetry is why the
count is printed every time: an inconsistency found without those relations is
still an inconsistency (adding an assertion can only make a set harder to
satisfy), but a set called *consistent* without them might be excluded by the
very relation that was refused. A requirement that states no relation **at all**
is counted apart, on the same line: no gate refused it, and folding the two
together would report a file of prose requirements as one whose relations this
tool turned down.

**A requirement set with nothing to check is never green.** A subject whose
requirements are all prose, or all outside the encodable fragment, comes back
`inconclusive` — an empty conjunction is satisfiable and says nothing — and a
run in which *nothing* was decided is exit 2 with `--allow-inconclusive` and
without it. With no solver installed there is nothing to fall back to at all:
satisfiability is not a question your model's own values can answer, so
`--engine literal` has no counterpart here and an absent backend is
`verification/tool-absent`, exit 2.

**`--subject REF` narrows it**, and a type answers for its subtypes: a
requirement written about a `Vehicle` is a requirement about every air vehicle,
so the air-vehicle set holds both — even when no requirement is written about
the air vehicle itself. The REF may name the part usage your file writes after
`subject` (`--subject uav`), which is narrowed through its declared type. A REF
that resolves but is the subject of nothing, and conforms to nothing that is,
is refused by name and exits 2 — not reported as a file that states no
requirements. Requirements with no subject are grouped and answered together
rather than dropped.

**What this is not.** It decides the satisfiability of *static* contracts —
numbers, and the relations between them. Whether a reactive implementation could
be built to meet a specification over time is a different question with a
different answer, and this command does not answer it. Nothing here is about
ordering, timing or behaviour.

**Source of truth:** `src/semantics/consistency.ts`, `consistencyReport` in
`src/api/verification.ts`, and the L8 cases in
`test/campaign/verification.test.ts`.

### The verdict in the file, and whether it still holds

A verdict that lives only in a terminal scrollback is a verdict nobody can
review. `evidence-attach` writes the records of a `verify` run **into the model**
as annotations on the requirements they are about, `evidence-status` says whether
they still hold, and `evidence-detach` takes them back off. All three report;
none of them judges. The judging was done once, by `verify`, and a verdict is not
re-decided by being written down.

```console
$ npm run sysprose -- verify examples/uav-isr.sysml --engine literal --record evidence.json
  …
  2 evidence record(s) written to evidence.json
$ npm run sysprose -- evidence-attach examples/uav-isr.sysml --from evidence.json --out examples/uav-isr.sysml
sysprose evidence-attach: 2 record(s) attached to 2 element(s), 0 already present, 0 skipped; 2 verdict facet(s) written
Wrote examples/uav-isr.sysml
```

**The input file is never written unless you name it.** The updated model goes
to stdout; `--out <path>` writes it, and `--out` pointing back at the file you
read is how you edit in place. Without it the command says, on stderr, that your
file was **not** changed and prints the flag that would change it. A tool that
rewrote somebody's source by default would be a tool you could not run to see
what it would do.

**What a record is, in the file.** Each one is a
`@SysproseVerification::Evidence { … }` annotation — the notation's §7.27
annotating form over the metadata definition the `SysproseVerification` package
ships. That package is **not** written into your file: `evidence-attach` adds
carriers and nothing else, so a model that carries evidence and neither declares
nor imports `SysproseVerification` has an annotation whose type resolves nowhere,
and no check in this tool objects to it. Paste the package (it is quoted in full
above) into the file, or import it, if you want the file to stand on its own. Five readable scalars come first (`claim`, `verdict`, `engine`, `tool`,
`modelGraph`) and the whole record follows as JSON in `record`. The scalars are a
**rendering**; `record` is the datum, and it is the only half this tool reads
back, because two readable copies of one number can disagree and the one that
must win is the one a consumer parses.

**The verdict facet is derived, never accepted.** Beside the carrier,
`evidence-attach` writes `metadata RequirementMetadata { attribute verdict = …; }`
— and it writes it **from the record's claim**, by one rule: `pass` for `proved`,
`fail` for `refuted`, `inconclusive` for everything else. A `--engine literal`
record claims `holds-at-values`, so it writes `inconclusive`. There is no path
through this command by which a point evaluation writes `pass`. A record file is
JSON somebody can edit, and a record states a `verdict` of its own beside its
claim; that field is **never copied through**. If the two disagree —
`"claim": "holds-at-values"` beside `"verdict": "pass"` — the whole file is
refused, naming the record and what its claim actually implies, rather than
half-trusted.

**A requirement with several obligations carries the worst of them.** One run
produces one record per clause, and the file holds one verdict facet: it is
`fail` if any live obligation is refuted, `inconclusive` if any is undecided, and
`pass` only when every one of them was proved. Re-recording one obligation
supersedes that obligation and nothing else — the pair `clause` +
`obligationDigest` is what identifies one — so a requirement whose second clause
was just discharged still reads `fail` while its first clause stands refuted, and
the answer does not change if you swap the two clauses in the source.

**Evidence accumulates.** A second run **appends** a carrier; nothing is
overwritten and no earlier verdict is deleted, so the file keeps the history of
what was claimed and when it changed. A record that is already there byte for
byte is counted as `already present` rather than written twice, which is what
makes the command safe to run again. Every verdict the run **moved** is printed
on stderr with both claims — and a `fail` replaced by a `pass` is named as what
it is.

**Two refusals, and a third.** A model that did not load cleanly is refused
outright: writing a degraded model back would replace your source with what the
tool managed to salvage. (That refusal is why `evidence-attach` and
`evidence-detach` have **no exit 1**: the reporting contract's 1 means "the
report is of what parsed", and these two never report over half a model. They
exit 0 or 2.) A record naming an element under a declaration the parser could not
read is refused with the same sentence the facet editors show, because the
serializer re-emits that declaration verbatim and anything written underneath it
is gone on the next save — at the command line you will meet the degraded refusal
first, since a faulted declaration only exists after a parse error. And a record
aimed at the bundled standard library is refused: a carrier written there is
never saved with your file. Every one of these is raised **before** the first
carrier is written, so a refused run leaves your model exactly as it found it.

**Then edit one literal.**

```console
$ npm run sysprose -- evidence-status examples/uav-isr.sysml
examples/uav-isr.sysml: 2 stale, 0 current, 0 unrecorded — model sha256:196f8a85…
  a record is shown with the claim it was made under — `holds-at-values` is never shown as `proved`
  UAVSurveillanceSystem::MassRequirement  stale
      stale — recorded at sha256:4b48f0ed…, the model is now sha256:196f8a85…; 3 element(s)
      in this requirement's slice must be re-read, and the digest is over the whole model so
      this tool cannot say which of them moved. Re-run `verify --record`.
      slice: UAVSurveillanceSystem::uav, UAVSurveillanceSystem::EnduranceRequirement, UAVSurveillanceSystem::AirVehicle
```

You do not have to run `evidence-status` to be told: `npm run check` raises
`validation/stale-evidence` as a **warning** on the ordinary path, because the
next person to open the file runs the checker, not the verifier. A stale verdict
only the verification lane could see would be a verdict that survived every edit
made by anyone who did not know the lane existed.

**What the digest can and cannot say.** It is taken over the whole user model —
every element you wrote, canonicalised so that reformatting, reordering and
reparsing leave it alone, and so that what a verification run itself wrote is
excluded (or every record would be stale the instant it was attached). So the
comparison knows **that** something moved and can never know **what**: it never
saw the earlier model, only its hash. Naming the requirement's slice is the
honest half of the answer — these are the declarations to re-read — and every
stale line says the other half out loud rather than implying an attribution it
cannot make. It catches model edits; it does not catch a **hand-edited record**,
and nothing here pretends otherwise.

**Two things this command calls out by name.** A `verdict` facet with no record
behind it is `verification/claimed-without-evidence` — **info**, not a defect: a
verdict reached by inspection is ordinary requirements management, and the row
says only that *this tool* has nothing standing behind it. A `verdict = "pass"`
over a record whose claim is not `proved` is
`verification/verdict-overstates-evidence`, and that one is an **error**: both
artefacts are the tool's own, they contradict each other, and the contradiction
is in the direction that overstates. `evidence-attach` cannot produce that
state; a file in it was written by hand.

**A claim is never upgraded on display.** A record claiming `holds-at-values` is
shown as `holds-at-values` in the terminal and in the Requirements table's
*Evidence* column, never as *proved*; a stale record is never counted as
discharged. The *Verdict* column beside it shows the facet, whose three values
cannot tell a point evaluation from a proof — which is exactly why the claim
word is on the row.

**`evidence-detach` takes the facets with the carriers.** A `verdict` left
behind by a detach is a claim with nothing behind it, which is the very state
`verification/claimed-without-evidence` exists to report — so the command that
removes the evidence removes the verdict it wrote, and leaves a facet you wrote
by hand alone.

**What another tool makes of this is not something this page will claim.** The
verdict facet is an unbound tag holding a quoted string, where the standard has
an enumeration on a different metaclass; a conforming SysML v2 reader is entitled
to treat that line as an untyped annotation and ignore it. The round trip that
matters is Sysprose → someone else's tool, and it has not been measured. Until it
has, no claim is made about it.

**Source of truth:** `src/api/evidence.ts`, the `stale-evidence` rule in
`src/validation/rules.ts`, and `test/fixtures/agent-authoring/L8-evidence-stale`.

### The keywords a file carries, including somebody else's

A `#keyword` in front of a declaration is the notation's own extension point:
SysML v2 §7.27.4 makes the short name of a `metadata def` writable as a tag, and
§7.27.1 says such a definition "simply acts as a user-defined syntactic tag on
the annotated element". Sysprose reads those tags, keeps them exactly as you
wrote them through a save, and — because a model annotated for another tool is a
model you should still be able to open here — reads a handful of other people's
spellings too.

`contracts --keywords` is the inventory. It says one of four things per keyword,
and it changes nothing:

```console
$ npm run sysprose -- contracts vocabulary.sysml --keywords
  keywords: 3 use(s) of 3 distinct keyword(s) — an inventory; nothing here changes an obligation
    sysprose vocabulary: #exceptional on P::failsafe → SysproseVerification::ExceptionalOutcome
    third-party spelling: #Exception read as `SysproseVerification::exceptional` on P::abort — not SysML v2, not a Sysprose keyword
    names nothing: #precondtion on P::launch resolves to no metadata definition in scope
  verification/foreign-keyword  ...
  verification/keyword-names-nothing  ...
```

Those two `verification/*` rows are **information** and they come from nowhere
but this command — except `verification/foreign-keyword`, which
`obligations --from-keywords` also raises, once per row a keyword filed.
`npm run check` does not judge a keyword: a misspelt one costs you nothing but
the tag you thought you had written.

**"Names nothing" is not a bug — it is the notation.** A keyword names a
`metadata def` *in scope*, so it resolves inside the package that declares the
definition, inside one that imports it, or when you write it qualified. The one
vocabulary Sysprose ships is a package you paste into your own file:

```sysml
package SysproseVerification {
    doc /* Two definitions SysML v2 does not express, carried over metadata definitions (SysML v2 7.27.1, 7.27.4). #exceptional says an outcome is a failure rather than an equally valid result. Evidence carries what a verification run showed, as an annotation on the requirement it is about. Both are Sysprose extensions, not standard vocabulary. */
    metadata def <exceptional> ExceptionalOutcome;
    metadata def Evidence;
}
```

`#exceptional` says an outcome is a **failure** rather than an equally valid
result — the one annotation in this whole lane that SysML v2 has no way to
express, which is why it is shipped rather than borrowed. It is a Sysprose
extension and this guide will not pretend otherwise. Two keywords you might
expect are deliberately absent: `#precondition` and `#postcondition`, because
`assume constraint`, `require constraint` and a case `objective { … }` already
say both, three ways and two ways respectively.

**`Evidence` in that same package is deliberately not a keyword.** It ships with
no short name, so there is nothing to write after a `#`. A keyword is a tag — it
says one thing by being present — and an evidence record has a body: a claim, an
engine, a tool version and a model digest. So it is written in §7.27's
*annotating* form, `@SysproseVerification::Evidence { attribute … = "…"; }`, by
`evidence-attach`, and a bare `#Evidence` that carried no record and claimed to
be one is a spelling this package does not allow.

**The statement kinds are the exception, and the inventory says so.** `#prose`,
`#prompt` and `#'requirement'` are read from the **spelling** — that is what lets
a tag work whether or not `SysproseStatements` is in your file — so the inventory
names them as this tool's own and never as a keyword that names nothing:

```console
    sysprose vocabulary: #prose on P::Why — read from the spelling; declare or import SysproseStatements to bind it
```

A tag this tool acted on is not a tag it failed to find.

**Somebody else's spelling.** Four third-party spellings are recognised, and
each of them prints where it came from wherever it is used:

| Written in the file | Read as | When it has any effect |
|---|---|---|
| `#Exception`, `#exception` | `SysproseVerification::exceptional` | never on its own — an inventory row |
| `#precondition` | an `assume` clause | only under `obligations --from-keywords` |
| `#postcondition` | a `require` clause | only under `obligations --from-keywords` |

That last column is the important one. Without `--from-keywords`, a file full of
another tool's vocabulary produces exactly the worklist the same file without it
produces: the keywords are read, listed and kept, and they file nothing. With
the flag, a `#precondition` on a plain constraint files a **premise** and a
`#postcondition` files something to **show** — and every such row prints
`from #precondition — a third-party spelling read as …` on its own line, so no
premise ever appears without the word that put it there. A clause role you wrote
yourself always wins: a keyword never reclassifies `require constraint`, and no
keyword can ever add an axiom.

**Source of truth:** `src/semantics/keywords.ts` (the reader, the resolver and
the alias table), `src/semantics/verification-vocabulary.ts` (the shipped
package), and `docs/CONFORMANCE.md` §7 for the assessment behind which keyword
ships.

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

## 7. Three kinds of statement

A model holds three quite different sorts of statement, and until you say which
is which, the tool has to guess from the shape you wrote them in. A
**requirement** binds: something has to satisfy it, and the coverage figure is
about it. An **explanation** written for a person binds nothing. **Guidance
written for an agent** binds nothing either — but it is addressed to a machine,
so a machine ought to be able to find it.

| Kind | What it is | What the tool does with it |
|---|---|---|
| `requirement` | a normative statement — the only kind with contractual value | counted by coverage, judged by the requirement rules |
| `prose` | an explanation for the human reader | listed and labelled, never counted, passed over by the requirement rules |
| `prompt` | guidance for an agent working on the model | the same, and collected for every element it applies to |

**The vocabulary is this project's own; the way you write it is not.** The
published SysML v2 specification has no enumeration of statement kinds. The one
requirement-related *kind* it has — `RequirementConstraintKind = assumption |
requirement` — classifies a membership inside a requirement body (`assume` /
`require`), not an element, and the shipped library classifies requirements by
subclassification instead (`FunctionalRequirementCheck`,
`PerformanceRequirementCheck`, …). Nothing there separates an explanation from a
rule, and nothing names guidance meant for a machine reader. What *is* borrowed
is the mechanism: §7.27.1 of that specification says a metadata usage exists to
add tool-specific information to a model, and that a metadata usage whose
definition has no nested features of its own "simply acts as a user-defined
syntactic tag on the annotated element"; §7.27.4 defines the user-defined
keyword — `#name` written in front of a declaration — and the standard library
ships exactly that shape for its own `<derive>` tag. So a kind here is a keyword
over a metadata definition: no notation is invented, no grammar is changed, and
a file carrying one is an ordinary file of the notation that any reader of it
can still read.

### Writing one

The keyword goes in front of the declaration:

```sysml
#prose part note {
    doc /* Written for the reader. Nothing has to satisfy it. */
}
```

Three keywords, one of them awkward: `#prose`, `#prompt` and `#'requirement'`.
The last is quoted because `requirement` is a hard keyword of the notation, and
the notation's own escape for a name that collides with a keyword is the quoted
form. `#requirement` does not parse.

Those keywords name three metadata definitions, and nothing in this tool binds a
keyword to a definition — metadata is unvalidated here — so a tag works whether
or not the definitions are in your file, and a misspelt `#prosee` is silently no
kind at all rather than an error. If you want them declared, this is the package,
and it is the text the tool itself ships:

```sysml
package SysproseStatements {
    doc /* Statement kinds are a Sysprose extension, carried as user-defined keywords over metadata definitions (SysML v2 7.27.1, 7.27.4). Writing #'requirement', #prose or #prompt in front of a declaration says what the statement is for. */
    metadata def <'requirement'> RequirementStatement;
    metadata def <prose> ProseStatement;
    metadata def <prompt> PromptStatement;
}
```

**Most statements need no keyword.** An element with no tag still has a kind
wherever its metaclass settles the question: a `requirement` reads as a
requirement, a `doc` and a `comment` read as prose, and everything else — a
part, a package, an action — has no kind at all, which is a different answer
from having the default one. You write a keyword for the cases the shape gets
wrong: the paragraph of commentary written as a requirement because that is
where it belongs in the tree, and the guidance written for an agent.

**Where a keyword cannot go.** Prefix metadata belongs to a *declaration*, so
`connect a to b;`, `perform x;`, a transition, an enumeration literal, a `doc`
and a `comment` have nowhere to put one. The tool refuses rather than accepting
a tag that would vanish on the next save: the Kind selector is absent on those
elements and the writer throws. A `doc` and a `comment` still *read* as prose —
they simply cannot be told to be anything else. The other way a kind can be
invisible is the longer metadata form: `@ProseStatement about p1;` parses and
round-trips, but it is not read as a kind, because reading it means resolving
`about` against scope and this tool does not do that yet.

In the app the kind is **Properties → Kind** (`prop-statement-kind`), offered on
every element that can carry one — not only on requirements, since guidance is
most useful on a definition or a package. The blank entry is a real state, "no
keyword is written here", and it says what the element reads as without one.

### What it changes

Naming a kind is only worth doing if something acts on it. These do — and the
last of them is the one that deliberately does not.

- **Coverage counts requirements only.** An explanation written in requirement
  shape used to enter the divisor and sit there with nothing satisfying it —
  nothing is supposed to satisfy an explanation — so a fully covered model read
  below 100% with a gap nobody could close. Tagged statements leave the divisor
  and are *counted*, beside the library and re-derived exclusions.
- **The requirement rules skip them.** `requirement-subject` asks what a
  requirement constrains, which is a fair question for a rule and a meaningless
  one for a paragraph, so it passes over prose and prompts.
  `constraint-violation` exempts only what you explicitly tagged: a plain
  `constraint c { … }` has no statement kind, and it is still checked exactly as
  it was.
- **The Requirements view keeps the row and labels it** in its Kind column,
  rather than hiding it — the one editable grid in the app is not the place a
  prose statement becomes uneditable.
- **The terminal says which rows the ratio left out**, instead of stating a
  figure the reader cannot reconcile with the rows above it.
- **An untagged requirement is unaffected.** The kind falls back to the
  metaclass, so every model written before any of this is counted and checked
  the way it always was.

Written out, all three kinds in one small model:

```sysml
package Brakes {
    part def Vehicle;
    part vehicle : Vehicle;

    requirement <R1> stoppingDistance {
        doc /* The vehicle shall stop within 40 m from 100 km/h on dry asphalt. */
        subject v : Vehicle;
    }

    #prose requirement <N1> whyFortyMetres {
        doc /* Forty metres is the figure the customer specification quotes, repeated here so a reader need not open it. */
    }

    #prompt requirement <P1> beforeChangingTheFigure {
        doc /* Before changing a braking figure, re-run the deceleration analysis and record its verdict on R1. */
    }

    satisfy stoppingDistance by vehicle;
}
```

and what the report makes of it:

```console
$ npm run sysprose -- requirements brakes.sysml
brakes.sysml: 1 of 1 requirement(s) satisfied (100%)
  [x] 1  stoppingDistance (R1) — satisfied by vehicle
  [-] 2  whyFortyMetres (N1) — prose: an explanation for the reader, not counted
  [-] 3  beforeChangingTheFigure (P1) — prompt: guidance for an agent, not counted
  24 bundled library requirement(s) and 0 re-derived copy/copies are not counted
  2 statement(s) tagged prose or prompt are not requirements and are not counted
```

Three statements, one ratio, and nothing hidden: `[-]` is a row that binds
nothing, the last line says how many rows that was, and `--kind requirement`,
`--kind prose` or `--kind prompt` narrows the listing to one of them. The filter
deliberately does **not** move the headline ratio — coverage is a fact about the
model, not about what you asked to see.

### Writing a prompt

A prompt is the kind this tool is unusually placed to have. An agent driving the
model can collect the guidance that applies to whatever it is working on, which
is only worth writing if it is worth writing **once**: guidance repeated onto
every part that needs it is guidance that rots.

So write it where it reaches. Asking what applies to an element walks two edge
families out from it — **what it is** (its types) and **where it sits** (its
owners) — transitively, and reports the prompts hanging on each scope and on that
scope's direct children:

```sysml
package Propulsion {
    #prompt part packageGuidance {
        doc /* Parts in this package follow the fuel-system conventions in DOC-114. */
    }

    part def Engine {
        #prompt part engineGuidance {
            doc /* Give an engine its fuel and exhaust ports before connecting it to anything. */
        }
    }

    part engine : Engine;
}
```

```console
$ npm run sysprose -- prompts propulsion.sysml --element engine
propulsion.sysml: Propulsion::engine — 2 prompt(s) apply
  1  type   Propulsion::Engine::engineGuidance via Propulsion::Engine
      Give an engine its fuel and exhaust ports before connecting it to anything.
  1  owner  Propulsion::packageGuidance via Propulsion
      Parts in this package follow the fuel-system conventions in DOC-114.
  nearest first; guidance reaches an element from what it is, where it sits, and where what it is sits
  0 library element(s) dropped from the walk; 0 re-derived element(s) crossed but not reported; 0 declared type(s) this walk cannot follow
```

Neither prompt is written on `engine`, and both apply to it. What to know about
that walk before you write one:

- **Nearest first**, by hop count, and at equal distance what the element *is*
  comes before where it *sits* — a type is more specific about it than an owner.
  Each prompt is reported once, at the nearest place it was found, so you can
  read down the list and stop.
- **Direct children only**, per scope. Guidance nested two levels down was
  written about the thing that owns it, and collecting whole subtrees would make
  every package-level question return the file.
- **Owners of types count too.** A part typed by a definition from another
  package is handed that package's guidance, because you used a definition from
  there. It is the same rule taken to its conclusion, and it means `owner` in
  that listing is not only your own containment chain.
- **The bundled library is dropped** at every hop and the count is printed. One
  unfiltered hop through a library type would turn the question into a walk of
  tens of thousands of elements. The tool's re-derived copies are the other way
  round: walked *through* so a walk can reach the definition behind a copy, and
  never reported.
- **A type the walk cannot follow is counted**, as the third figure on that
  line. An attribute typed by something outside `ScalarValues` — `attribute mtow
  : ISQ::MassValue` — keeps its type as text and gets no typing edge, so this
  walk cannot go down it. Zero there means nothing was hidden from you; a number
  means guidance may hang off a type this answer never reached.
- **The words come from the `doc` body** you write under the tagged element (or
  from a comment addressed to it). A prompt with a tag and no words says so on
  its own line rather than printing a blank one.

`--json` gives the same thing structurally — each prompt with its `text`,
`attachedTo`, `via` and `distance` — which is the shape an agent should read.
The question has no control in the app: Properties *writes* a kind, and nothing
there collects what applies to a selection.

Two limits worth knowing. A kind classifies an **element**, not each sentence
inside it: a `doc` body cannot be tagged separately from the requirement that
owns it. And `requirements --kind prompt` lists only prompts written in
*requirement shape* — the population of that report is what a requirements table
holds — so a `#prompt` on a part or a package is found by `prompts --element`,
not there.

**Source of truth:** `src/semantics/statement-kind.ts` (the vocabulary, the
keyword, what can carry one), `src/api/analytics.ts` (`promptsFor`, and the
`nonNormativeExcluded` figure in `requirementSatisfaction`),
`src/validation/rules.ts:551-568`, `963-984` (the two rules that ask),
`scripts/sysprose.ts` (`requirements --kind`, `prompts`),
`test/unit/semantics.statement-kind.test.ts`.

---

## 8. What is kept, and what is not

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

## 9. Limits

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

## 10. Where to go next

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
| Export → Diagram PNG | The same, rasterised on white — the scale is in [§9](#9-limits) | `tb-export-png` |
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
