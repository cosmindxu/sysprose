# Sysprose user guide

For an engineer who has been handed the tool and has an afternoon.

It assumes you know systems engineering — blocks, interfaces, requirements,
states — and it does **not** assume you know SysML v2. Everything you have to
type is introduced here, in the order you need it.

Sysprose runs entirely in a browser tab. There is no server and no project on
anyone's disk but yours — and no login, unless you choose to keep your model in
your own Google Drive on a site that offers it
([§8.1](#81-google-drive-optional)). That shapes everything below, especially
[what is kept and what is not](#8-what-is-kept-and-what-is-not).

| | |
|---|---|
| **Try it** | <https://cosmindxu.github.io/sysprose/> |
| **Run it locally** | `npm install && npm run dev`, or `npm run build && npm run preview`. Both servers make the page cross-origin isolated, so the palette's solver checks run in it; `SYSPROSE_NO_ISOLATION=1` turns that off (§8.1) |
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
   - [8.1 Google Drive (optional)](#81-google-drive-optional)
9. [Limits](#9-limits)
10. [Where to go next](#10-where-to-go-next)
- [Appendix A — every control, and the id a test can find it by](#appendix-a--every-control-and-the-id-a-test-can-find-it-by)
- [Appendix B — keyboard shortcuts](#appendix-b--keyboard-shortcuts)

---

## 1. What this is, and what it is not

Sysprose is a **modeling tool for one model at a time**, held in your browser.
You author a system as text or by drawing, and it gives you back 17 views
of the same model — block diagrams, an interconnection diagram, action and state
diagrams, requirement tables, a contract inventory, a traceability matrix, a
dependency-structure matrix, a 3D massing view — plus a rule-based check, a
numeric solver, an execution engine, a verification lane you drive from a
terminal and a scriptable API.

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

**Source of truth:** `src/diagram/types.ts:17-34` (the view list), `README.md`
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

On a site that offers Google Drive, a **Drive ▾** button sits beside
**Collaborate**: **Drive ▾ → Sign in to Google…**, then **Save to Drive as…**,
keeps this model as a `.sysml` file in your own Drive, where any device you
sign in on can open it again. How that works, and what it does and does not
send, is [§8.1](#81-google-drive-optional).

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
   draws one box and no edges. While a scope is set, the chip **Diagrams:
   AirVehicle** at the start of the breadcrumb says so; its **×** (or right-click
   any node → **Show whole model**) shows the whole model again.
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

**Source of truth:** `src/ui/App.tsx:163-285`, `src/ui/panels/Toolbar.tsx:524-660`,
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

**`examples/views-tour.sysml` populates every view in this section**, one
labelled block per view, so you can open it and switch through the toolbar to
see what each one draws and what text produced it. Measured on that file:
general 30 nodes / 26 edges, tree 47, interconnection 8, requirement 8 / 3,
case 5 / 3, parametric 5, action 2 / 1, state 2 / 2, sequence 2 lifelines and
1 message, grid 47 rows, requirements 2 rows.

The two questions that file answers which nothing else here does: a **sequence**
view is derived from `flow from a to b` (falling back to `succession` control
edges), and an **allocation** view needs `allocate x to y` — a `satisfy` will
not populate it.

A graph view can be narrowed to one subtree — right-click a node → **Scope
diagram to this**, or **⊞** on its row in the Explorer (the way to scope to a
package, which most views draw no box for). That is what makes an
interconnection diagram of one assembly readable, and a layered model readable
one layer at a time. While a scope is set, a chip at the start of the breadcrumb
says so — **Diagrams: SA** — and its **×** shows the whole model again. A
different view or scope opens fitted to the canvas.

The bottom panel (Problems, Checks, Text, …) folds down to its tabs with the
**▾** at the end of its tab strip, giving the diagram the room; clicking any tab
opens it again.

### Diagrams

The drawn views. **Auto-layout** and **Export → Diagram SVG / PNG** work on the
graph views — General, Interconnection, Action, State, Requirement, Tree,
Parametric and Case — and are greyed out everywhere else, with the reason in the
tooltip. Sequence and Geometry are drawn by their own renderers and lay
themselves out: Sequence has no drawing palette, Geometry does.

Every view has a **palette**, though: the views that draw nothing still carry the
Edit and Checks sections, which is where the allocation matrix gets `trace`, the
contracts table gets `refine` and `fault-tree`, and the analysis views get
`stats` and `where-used`. A check marked `not here` is one this page cannot run — z3 needs a cross-origin-isolated page, which the hosted site is not and the
local `npm run dev` and `npm run preview` pages are — and its row carries the command that runs it in a terminal
instead of a verdict nobody measured.

| View | What it shows | The question it answers | Test id |
|---|---|---|---|
| General | Definitions and usages as boxes with attribute and port compartments; composition ◆, reference ◇, specialization ▷ and satisfy/allocate edges | What are the parts of this system, and how do they relate? | `tb-view-general` |
| Interconnection | Parts nested inside their parent, ports on the boundaries, connections port-to-port | What is wired to what? | `tb-view-interconnection` |
| Action | Action nodes plus initial ●, decision ◇, fork/join ≡ and done ◉ control nodes, joined by successions; a `flow` between two actions' parameters is drawn between the actions, labelled with what it carries | What happens, in what order, and what passes between the steps? | `tb-view-action` |
| State | States and transitions labelled `trigger [guard] / effect` | What modes does it have, and what moves it between them? | `tb-view-state` |
| Requirement | Requirements with their satisfy / refine / verify endpoints | Which requirements exist, and what meets them? | `tb-view-requirement` |
| Tree | Pure containment, one branch at a time: a box that owns more shows **+N**; click it to open that branch (the Explorer opens with it), **−** to close it | What owns what? | `tb-view-tree` |
| Parametric | Constraint nodes, each showing its expression in a monospace compartment (an unnamed one is headed by the expression alone), and the parameters bound into them. An attribute that states no value beside an asserted equation, `assert constraint { x == … }`, takes the value the equation fixes — Problems reads *Constraint satisfied: defines x = …*, with the unit when the equation derives a dimensioned quantity — so an estimate can be arithmetic over the model's own values rather than a literal, values other asserted equations fix included — the chain is derived link by link with its units. Where a name stands alone in several asserted equations, the first that gives it a value is its definition — those of the `x == …` form are tried first, then the rest, each in the order written — so one that would read a value back into its own derivation, or whose input nothing fixes, is passed over, and while the equations agree the order they are written in does not matter. Where two give it different values (`x == 50.0` beside `x == 60.0`, or beside `x == a * 2.0` with `a = 30.0`), or values this tool cannot compare, no surface that judges a relation reads x — the check, the literal engine and the numeric surface: every relation over it is *could not be evaluated*, the SMT engine's axioms are inconsistent where the model states both, and Problems reports the pair once (see *Two asserted equations that disagree*). A loop of equations is refused, naming every link, and so is a chain nested more than 64 definitions deep: a definition that deep, tried before one that gives a value, is the name's answer, refused, rather than passed over. A constraint beside it reads that quantity: a dimensioned derivation is compared against a unit literal (`x >= 45 [min]`), never as a bare number, while a dimensionless one — like a kinded literal, `limit : ISQ::MassValue = 25.0` — reads a bare literal in the feature's declared unit, for `==` and `!=` exactly as for `<=` and `>=`. Only an asserted equation defines: the same equation as a `require constraint`, a plain `constraint` or a requirement's `require`/`assume` is a check of a value given elsewhere, and with none given it cannot be evaluated (*x has no value anywhere, no asserted equation, and nothing specialises it*); an equation the unit-aware evaluator refuses (two dimensions, an offset scale) defines nothing, and says why — through a chain too, naming the link it refused | Which equations connect which values? | `tb-view-parametric` |
| Case | Use cases and the cases that include them | What is the system for? | `tb-view-case` |
| Sequence | Lifelines and time-ordered messages, falling back to control flow when the model has no explicit flows | Who talks to whom, in what order? | `tb-view-sequence` |
| Geometry | One primitive solid per structural part, from `shape` / `position` / `size` / `color` attributes, orbitable in 3D | Roughly how big is it, and what is inside what? | `tb-view-geometry` |

#### How the diagrams are laid out

Every graph view reads **left to right**: owner before part, first step before
last, the initial state before the ones it leads to, the root of a tree before
its leaves (a box that many dependency lines end on may lead its piece instead,
below). The layout keeps to the readability criteria of the UML-layout
literature (Sun & Wong, IWPC 2005, after Purchase): no box overlaps another, no
connector runs through a box it does not connect, connectors run horizontally
and vertically and cross as little as the graph allows, and labels sit where
the layout made room for them — never on a box, a line or another label.

- **Many pieces become rows, not a strip.** A view's disconnected pieces are
  laid out one by one and packed row by row to about the screen's proportions:
  the largest piece top-left, then single boxes grouped by kind.
- **A layered model reads layer by layer.** When the boxes of a General view
  all lie in two or more packages that sit directly in one package — the
  model's single top-level package, or the package the view is scoped to (Kinds,
  Common, OA, SA, LA, PA, EPBS, say) — those packages become columns in that
  order, and the boxes of each connected piece that reaches across them get a
  header over each column naming its package. The header is a band the layout
  keeps above the boxes, so as laid out it lies over none. Its label grows as
  you zoom out, but only as far as its band holds, and a package name wider
  than its column is shrunk to fit, then ends in an ellipsis. On a tall piece
  the band is off screen above once you pan down a column, and a few pixels
  high when the whole model is fitted, so a **frozen strip** along the canvas's
  top, just under its toolbar, repeats the headers of the pieces that run
  beneath it, when their band is above the strip or under 22 px high on screen:
  in screen space, at one size (12 px) at every zoom, over the column's x-range
  clipped to the canvas, with the package's name centred on what shows. The
  boxes scroll beneath the strip, and a click goes through it. A header stays
  in the strip while its piece runs beneath it and leaves upward with the
  piece's bottom edge, so the headers of the piece below arrive as the first's
  go. A header whose band is on screen below the strip and 22 px or taller is
  left to its band, and a column under 28 px wide on screen has no strip label.
  **Fit** frames the headers with the boxes and starts the drawing at the
  strip's top edge, so at a whole-model Fit the strip names the top row's
  headers when their band is under 22 px high, with the first row of boxes just
  below the strip and none under it, and otherwise that band reads at the
  strip's place. The headers of pieces lower on screen stay in their own
  bands: on a very tall model these are a pixel or two high at Fit, and you
  read them by zooming or panning to the piece. A box moved by hand stays
  where it was dropped, even after a re-layout has moved the headers, so it can
  sit in a header's band or under the strip, and then the header or strip
  covers it: move it, or choose **Auto-layout**, which forgets hand moves. The
  headers are drawn into the SVG and PNG exports (the band as laid out, not the
  strip). A piece inside one package has no header, and neither does a view
  of a single layer package. A file with several top-level packages, or one
  wrapper package around the layers, has no columns in its whole-model view:
  scope the view to the package that holds the layers.
- **A box that many dependency lines end on leads its piece.** In a General
  view with no layer columns (a view scoped to one package, or the whole model
  of a file with several top-level packages), a box that three or more
  `«allocate»`, `«satisfy»`, `«trace»` or other dependency lines end on — a part
  that a dozen activities are allocated to, a requirement many things satisfy —
  is drawn at the left, and those lines fan out of it to the boxes they come
  from, their arrowheads pointing back at it, instead of each running the width
  of the diagram to a box at the far right. Where a piece has two or more such
  boxes (two members, each with an activity per step, whose fans would
  interleave and cross), the layout also tries letting only the one with the
  most lines lead (the first, on a tie), the others staying at the right where
  their lines end. The layout draws the piece each way and keeps one
  of the hub-led drawings only if it has at least three crossings fewer than the
  usual one and reads better overall, so a view that already reads well keeps
  every line running left to right, as does a whole-model view with its layer
  columns. Adding or removing a few lines can tip a piece from one drawing to
  another, and a hub then moves from one side to the other. Pieces of more than
  200 boxes are not tried from their hubs.
- **A label that would say the same thing on every line is left off.** When
  every dependency in a view is of one kind — the Requirement view's
  `«satisfy»`, for instance — the keyword is dropped and lines that leave one
  box share a trunk; a view that mixes kinds keeps its keywords.
- **Large models:** scope the view to a package (the diagram shows one layer at
  a time) — a whole model's General view is an overview, not a page. Layout
  runs in a background worker, so a large diagram never freezes the page.

**Arranging by hand.** Drag a box and it stays where you drop it, through model
edits and view switches; its connectors step around to meet it. Text edits keep
it too. An apply of text (**Apply text → model**, or the apply that **Save**,
`Ctrl/⌘ + S` and **Export ▾ → SysML** make of typed text) builds every element
anew from the text, and each moved box goes to the element with the same
qualified name (`Package::Part`). A box lays out afresh when you renamed its
element, moved it to another owner, or gave another element the same name.
**Auto-layout** (toolbar, or the canvas mini-toolbar) forgets the boxes you
moved in the current diagram and lays it out afresh. Moves are kept per view
and scope. **Save** keeps them with the project in this browser, beside the
model, and **Open ▾** puts each box back where you left it. **New**,
**Import** and **Reload from Drive** start from a fresh layout, and their Undo
brings the boxes back with the model. A file opened from Google Drive
(**Browse Drive…**, **Recent**, a `?drive=` link) or from a `?model=` link
starts from a fresh layout too, but Undo starts over there
([§8.1](#81-google-drive-optional)): an arrangement never saved with **Save**
is asked about first, as unsaved work, because it is gone for good once the file
opens. The boxes are not part of the
model's text: the Text view, the SysML and JSON exports and a Google Drive file
never hold them. Moving a box is not an edit: it spends no Undo step. But the
model does read unsaved for it, against the boxes **Save**, **Open ▾** or
**New** left, so the question that guards a command which replaces the model
([§8](#8-what-is-kept-and-what-is-not)) is asked for an arrangement too; moved
back to where it was saved, it reads saved again. Press **Save** to keep an
arrangement.

### Tables

Read-only, except the Requirements table, which is the one editable grid in the
app.

| View | What it shows | The question it answers | Test id |
|---|---|---|---|
| Allocation | A matrix of elements × elements with a mark wherever an Allocation joins them (falling back to Satisfy when a model declares no allocations) | What is allocated to what? | `tb-view-allocation` |
| Grid | Every in-scope non-relationship element as a row: name, metaclass, type, multiplicity, value, redefines, doc; a `default` value reads `default 1.2` and a bound one `1.2`; `elements` prints `default 1.2` and `= 1.2`, and its `--json` `value` is the cell | What is in this model, in bulk? | `tb-view-grid` |
| Requirements | Hierarchical requirement rows with outline numbers, editable id / name / text, chips for Satisfied By / Verified By / Refined By / Traced To / Derived From, and a Kind cell plus the nine management attributes (status, verdict, risk, priority, criticality, rationale, source, owner, verification) | Are my requirements covered, and by what? | `tb-view-requirements` |
| Contracts | One row per requirement or case objective: the subject and how it got there, every `assume` and every `require` clause as written, the relations a gate refused with the reason, and the fragment the row sits in — with the census under it | What does each requirement assume and guarantee, and about whom? | `tb-view-contracts` |

The **Contracts** view is read-only and reaches no verdict: it shows what a
requirement *states*, never whether it holds. It has no solver of its own (the
palette's Checks run z3 only on a cross-origin-isolated page, which GitHub Pages
cannot give), so under the table it prints the exact command that does decide. A clause a unit or
typing gate refused is shown with its reason rather than dropped, because a
view that showed the clauses and hid the refusals would let you believe a
requirement was fully encoded when half its body had been turned away.
A clause a requirement inherits from a general type is shown too, body and all,
in the **Assumes** or **Guarantees** cell after the ones it wrote, each marked
`(inherited from <the element that holds it>)` — the terminal's `contracts`
marks it `(inherited)` the same way. It is a disclosure and not a filing: the
clause is still filed once, on the element whose body holds it, so the census
under the table counts it there and nowhere else.

The Requirements view edits the model directly: adding a chip creates the
backing relationship, and ✕ deletes it. **+** on a chip cell opens a search box:
typing narrows the list of candidates and links nothing; a click (or Enter on
the highlighted one) makes the link, and Escape closes it. A cell with a closed list of values is a
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
`regroup.ts`, `requirements-table.ts`, `contracts-table.ts`; `src/ui/panels/Toolbar.tsx:54-80`
(the grouping); `src/ui/store.ts:326-339` (`diagramRootId`, the diagram
scope), `1565-1739` (`carryPins`, `pinsOf`: boxes moved by hand, and how a
saved project keeps them), `2795-2812` (`pinNodePositions`: the move itself), `2390-2449`
(`applyParsed`, the body of `applyText`: an apply of text carries them over by qualified name),
`4540-4582` (`openText`: a file opened as text starts afresh).

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

**Drawing on the canvas.** Pick a tool in the palette and a strip at the top of
the canvas says what the next click does: for a box, *click empty canvas to
place it under the selection, or a box to place it inside*; for a line, *click
the source box, then the target* — once the source is picked it is outlined and
the strip asks for the target. **Esc** puts the tool down at any point. The
General view's palette draws every dependency the views show — **Specialize**,
**Typed by**, **Satisfy**, **Allocate**, **Trace** — so a line whose other end
has left a view (a satisfier whose requirement was deleted, say) can still be
drawn where both ends are. A typing, specialization or subsetting line belongs
to the box it starts from; any other line to the source's owner.

**Typing a part in Properties.** The **Type** field shows what the selection is
typed by. Type the name of a definition and press Enter (or leave the field):
the name is looked up the way the text would look it up, and the typing is
bound, replacing the old one — the diagram draws the new `: Type` and any
typing line at once. A name that resolves to nothing is kept as text, as the
notation would keep it, and an empty field removes the typing. One undo takes
it back.

**Wiring ports.** In the Interconnection view a part shows its ports on its
edges — the ones it declares, and the ones it has through its type
(`part memberA : SwarmMember` shows SwarmMember's ports). Pick **Connection** or
**Interface** in the palette and click a port handle on one part, then one on
the other: the line ends on the PORTS, written as feature chains —
`interface connect memberA.meshOut to memberB.meshIn;` — exactly what the text
form parses to. Name it and give it its interface definition in Properties
(Name, Type). Clicking two boxes instead of two ports still connects the parts.

**Tags and a requirement's subject.** **Tags** in Properties holds the `#Tag`
keywords written on the element (`#Hazard #Accepted`); Enter writes them, and
the Keywords list under it says what each one resolves to. A statement kind
(`#prose`, `#prompt`) stays with the Kind control. On a requirement, **Subject**
takes `name : Type` (`holder : SwarmMember`) and writes `subject holder :
SwarmMember;`; an empty field removes it, and a type that names nothing is not
written.

**The standard library in the Explorer.** With the Explorer's library toggle
on, the library's packages are rows like any other, but the text never holds
them — not the Text view, not **Export ▾ → SysML**, not a Google Drive file. So
an element added under a library element (its **+**, or a palette tool with one
selected), dragged onto one, or pasted onto one (`Ctrl/⌘ + V`), goes to the top
level of your model instead, and the strip under the toolbar says so. One Undo
takes it back, as any edit, and the note with it. So does a line drawn from a
library box (the relationship goes to the top level of your model). The other
way round, a library element stays in the library: dragged onto an element of
yours it does not move, and the strip says so; and the **Type** field on a
library usage does not type it (the typed text stays in the box, no typing is made), and the strip says so. Replacing the model — New,
Open, Import, a file opened from Drive — takes the note down too: it names an
element of the model that is gone. For the same reason the **Documentation** box
in Properties is read-only on a library element: it shows the library's own
documentation, and a doc typed there would be in no file.

The tree and Properties update instantly. The diagram, the Problems list and the
Text tab are *derived*, and they lag a burst of edits by up to 250 ms. That is
deliberate: it keeps typing responsive. On a large model, where working them out
takes a while itself, the lag grows with it — up to four times the last
recompute — so the keyboard is never kept waiting. And on such a model that work
is not one stretch of the page: a task that has run 40 ms lets the page draw and
the work goes on in the next one (validation a rule at a time, then the text, then
the results and the diagram), and the text and the results, which cannot be
divided, each start a task of their own once the one before has run 10 ms. On the drone-swarm model, after the
session's first edit and at a moderate load, no task of it is over 200 ms where
one task was 200 to 400, the text and the last step being the longest
(*Performance*, `docs/UI-ROADMAP.md`, P4). An edit while it runs ends it and the
wait starts again, but the cap above still holds: the recompute due at the end of
a burst's cap is one task, which an edit cannot end. Until it ends the edit is
still waiting, as in its quiet period: the prompt on closing the tab asks while
it runs.

Beside the tree, what lists the elements you declare — the diagram, the tables
and matrices, the palette's checks — takes them in the order the Text tab writes
them. One you add, drag or paste, here or through the SDK, or that a
collaborator adds, is taken where its declaration goes in the text, as after
Save and reopen, not after everything else: a state machine made in a package
above another machine's is walked before it, and `reach` and `check-behaviour`
list their rows in the order a terminal prints them for the file Save writes. A
doc, an attribute or any other member added to a typed element goes before its
typing, as the text writes it, and the typing keeps its place among the others.
A project you open, a model JSON or element graph you import, a branch you
switch to and a room you join are taken in the text's order too, whatever order
the copy they came from listed the elements in. In a collaboration room every
peer holds each element's members in the order the peer who made the edit
holds them — after an edit that adds several at once, such as a paste, after
Apply, Import, Undo and Redo, and after a drag, a drag of one of the standard
library's elements within the library included — and so does a peer that joins
later; two members that two peers add to one element at the same moment come
in one order on every peer. A member that one peer moves into an element
another peer deletes at the same moment goes to the top level, on every peer.
A typing, specialisation or redefinition keeps its place among the others,
wherever the text writes it: one made in the app — the Type field, a line drawn
with the palette — is taken after those the model had, and one of an element
whose declaration a drag puts elsewhere in the text, or that a project you
open, a model JSON you import or a branch you switch to stored in another
order, stays where it was. So a check that goes by them, such as `where-used`
over a definition, can list its usages in another order than a terminal does,
and, in a room, than another peer does.

### The Text tab, in both directions

- **Model → text** happens by itself. The buffer is re-serialised after every
  edit — at once when you click into the editor with nothing typed there, so
  what you type starts from the model as it stands — and the indicator under
  the editor reads *in sync with model*. An edit
  made through the SDK on `window.sysml` ([§6](#scripting-it)) is re-serialised
  too — except over text typed here and not yet applied: an SDK edit, like a
  collaborator's, never replaces that. The text stays, reading *modified — not
  yet applied*; applying it — or saving it, or exporting it with **Export ▾ →
  SysML**, outside a collaboration room — puts it over the SDK's edit, which
  one Undo brings back.
- **A field's change over typed text.** A change applied from a field — a
  Properties box, the Documentation box included, a rename, a Requirements
  table cell — while the Text view holds text typed there and not applied
  applies that text first, as **Apply text → model** does, and then goes in
  over it: the Text view shows both, and two Undo steps take them back, the
  change first. The elements keep their ids, so Properties stays on the
  element, and the project keeps its name; a running simulation stops, as at
  any apply. When that text gives the element documentation, the
  Documentation box then shows that one, and its keystroke is not written
  over it. A box or a cell left as it was is no change, and applies nothing. Where the text cannot go first,
  it stays, reading *modified — not yet applied*, as over an SDK edit: when
  it has a syntax error, in a collaboration room, when the element the
  field changes is not in it under the same qualified name and kind, or
  when the model has changed since you began typing it. A **Save** or an
  **Export ▾ → SysML** that later applies that text puts it over the change,
  and, in the cases [§8](#8-what-is-kept-and-what-is-not) lists, says so.
- **Text → model** happens when you press **Apply text → model** — or **Save**
  / `Ctrl/⌘ + S` or **Export ▾ → SysML**, which apply it first unless it has a
  syntax error or a collaboration room is connected
  ([§8](#8-what-is-kept-and-what-is-not)).
  Until then the indicator reads *modified — not yet applied* — unless you
  type the text back as it was (delete what you typed) before the model
  changes: nothing typed stands then, and it reads *in sync with model* again.
- **Parse findings** sit in a strip under the editor. Errors are shown in full;
  warnings alone fold to one line — *▸ 12 parse warnings — also listed under
  Problems* — which a click opens, so a model with a few warnings still leaves
  the text most of the panel.

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
>    created, deleted, duplicated, pasted, connected, re-parented, regrouped
>    or imported something — in the diagram, the tree or a table — or pressed
>    Undo or Redo, your typing is gone. (A change applied from a field does not
>    overwrite it, nor does an edit made through `window.sysml`; see above.)
>
> After an apply, the standard library is re-merged asynchronously, which is why
> Problems and the text buffer visibly refresh a second time a few hundred
> milliseconds later. When a parse error is standing, that refresh deliberately
> leaves your text alone rather than serialising the partial model over it — as
> it leaves alone text you typed after the apply, while the library merged.

### Undo

Undo is 50 snapshots deep, it covers model changes (not view changes, not the
theme), and any new edit clears the redo stack. One view change rides along:
undoing New, Open, Import or an apply of text also puts back the boxes moved by
hand on the model it restores (*Arranging by hand*,
[§4](#4-the-views-and-what-each-one-answers)). Copy is not undoable; paste is.

**Source of truth:** `src/ui/store.ts:1781-1917` (`RECOMPUTE_DEBOUNCE_MS`,
`flushRecompute`: the recompute cycle), `2155-2297` (`recomputeSteps`, `flushRecomputeImpl`:
the steps of a recompute), `2077-2128` (`watchModel`, `beginEdit`, `settleEdit`: an edit's
redefinitions settled in its one undo step, a removal followed), `2306-2491` (`afterMutation`, `afterSdkEdit`: an edit, and an SDK
edit, each listing the model in the order its text gives it; `typedTextFirst`, `applyParsed`: a
field's change over typed text), `911-968` (`inLibrary`, `userOwner`,
`sdkIntoLibrary`: nothing added to the standard library), `3090-3121`
(`createElement`: a new element), `3413-3481` (`reparent`, `reparentMany`: a
move), `5250-5311` (`libraryNote`: the note that says so), `3923-3936`
(`applyText`), `4383-4437` (`undo`, `redo`), `5339-5397`
(`refreshAfterLibraryLoad`: the post-apply refresh);
`src/core/model.ts` (`adoptSerialOrder`: the order the text gives),
`src/collab/model-doc.ts` (`bindModelToDoc`: a room, and a peer that joins it);
`src/ui/panels/TextEditor.tsx`, `src/ui/panels/Properties.tsx` (the
Documentation box); `test/e2e/text-apply-contract.spec.ts:30` (the one-undo
guarantee, as a test).

---

## 6. Checking and analysing

### Four buttons that answer four different questions

| Button | What it runs | What you get |
|---|---|---|
| **Validate** | the rule engine (27 rules) over the model | naming, typing, multiplicity, containment and traceability findings |
| **Check** | the same findings, minus the rule engine's own constraint rows, plus one row per constraint in the model | satisfied / violated / could-not-evaluate, per constraint, navigable to the constraint |
| **Simulate** | one batch run of an action flow or state machine | a step-by-step trace: steps, edges fired, loop iterations, whether it completed |
| **Solve** | the numeric solver and the measures of effectiveness | solved values, the features the equations leave free, violations, unknowns, and a feasibility verdict |

Two names worth separating:

- **The *Simulate* button and the *Simulation* tab are different things.** The
  button is a one-shot batch run that dumps a trace into Problems. The tab is an
  interactive stepper: pick a machine, Start, then Play / Step / Inject an event
  / scrub the trace, with the active states glowing on the state diagram.
- **`feasible` means "no *known* violation."** A relation neither engine could
  judge is reported under *unknowns* and leaves the flag true. Read the two
  together; an unjudged constraint is not a satisfied one.
- **A design freedom is reported as one, never as a value.** When the
  equations leave a feature free — `mass == dry + fuel` and `fuel == mass *
  0.2` with no value for `dry` — Solve lists it as a `free:` row instead of a
  `value:` row, and every relation over it is *unjudged*: the point the solver
  happened to stop at is one choice among many, so `mass >= 130.0` is neither
  met nor missed there. A feature that reads a free one is free with it,
  however slight the dependence (a range in kilometres moved by an offset in
  millimetres). An equation the solve itself imposed holds along the
  freedom and stays satisfied; a plain (not `assert`) constraint the solve took
  as a design equation to fix such a value is marked *imposed by the solve*,
  because it holds by construction, not as a check the design passes. A value
  the model's own facts fix — a `bind` to a determined value, an `assert` over
  an instance (`assert constraint { p.x == 3.0 }`) — is no freedom, and a
  plain constraint over it is judged, never imposed — and so is a feature
  whose stated value expression those facts determine (`y = x * 2.0` over an
  asserted `x`): `y == 7.0` beside it is violated, never the value y is
  solved to, wherever the check is written: the model's own equations are
  solved first, and a check fixes only what they leave. The test is local: each
  of two separate roots (`x * x == 4.0`) reads as determined, not free.
  **No design equation turns on the order of the text, bar four cases of where the solve
  starts or of the digits a value is given to (the end of this passage).** Two plain
  equalities that agree (`a { x == 3.0 }`, `b { x == 3.0 }` over a valueless
  `x`) are both *imposed by the solve*. Two that disagree (`t50 { p.L == 50.0 }` and `t60 { p.L == 60.0 }`)
  fix no value: the one taken would be the one written first, so neither is
  taken, and every relation over that value is *unjudged* (*… only plain
  constraints that disagree (t50 and t60): which of them holds would turn on the
  one the solve took first as its design equation, so none does …*); Solve
  lists no value for it. So does an equation that may have more than one root beside a
  plain constraint: a curved one (`x * x == 4.0`, `x ^ 2.0 == 4.0`, `x % 3.0 == 2.0`; the
  shape is an over-approximation, so an odd power such as `x ^ 3.0 == 8.0`, which has one real root,
  and a double root such as `x * x == 0.0` are read the same), a
  stated value (`attribute s = x * x`) or an assert (`s == x * x`) as much as a
  plain one, or a product of two unknowns that the other equations still link
  (`x * y == 4.0` beside `x == y`). `a { x * x == 4.0 }` beside `b { x == -2.0 }`,
  and beside `b { x == 2.0 }`, where one root agrees; `c0 { s == 4.0 }` beside
  `c1 { x == -2.0 }` over that stated `s`, which agree at −2; `c0 { x * x ==
  4.0 }`, `c1 { y == x + 1.0 }` and `c2 { y <= 0.0 }`, where the root (2, 3)
  breaks c2 and (−2, −1) meets all three: the root the solve takes, and so
  whether the others hold, would turn on which equation it took first or on the
  root itself, so none is read, whether or not a plain constraint was left
  unused (*… only plain constraints, one of them that may have more than one root (a and
  b) …*, or, with the model's own equation among them, *… and the equations over
  it may leave more than one root (`s = x * x`) …*). The features the equations link
  are one, those the solve left free among them. What the other equations fix
  one at a time has the one root and is read as before: `z == x * x` over `x ==
  3.0`, and `mass == density * volume` over the two it multiplies; and `z == x *
  y` beside `z == 9.0` leaves x and y free along the curve, not two roots. So does
  an equation one to one in the feature it fixes, which has at most one root, with the feature on one side of
  the equation only, a quotient or an exponential
  (`v == d / t` beside `d == 100.0` and `v == 20.0` is t = 5; `x / y == 3.0`
  beside `y == 2.0` and `x == 6.0` agrees with both, and all three are *imposed
  by the solve* in any order, as is the density form `m / v == d`; and `6.0 - 3.0 / (x + 1.0) == 3.0`,
  root 0 beside the pole −1, is imposed at 0 whether `x == 0.0` is written before it or after it, as is
  `1.0 / x == 100.0` (root 0.01) and `10.0 ^ (2.0 * x + 8.0) == 1.0` (root −4)): a quotient
  by a value another equation fixes has the one root. Where the solve's own start finds none, the root is
  searched for along the line, at 0 and ±2^k, for a sign change between neighbours, closed on to the last digit (a
  pole it closes on is no root). **The limit of that search: a root that lies in the same gap as its pole,
  between two of those points, is not found** — `1.0 / (x - 5.0) == 2.0` (root 5.5, pole 5, between 4 and 8)
  and `3.0 / (x + 1.5) == 10.0` (root −1.2, pole −1.5, between −2 and −1) read *unknown* alone, in every
  order, never a value (a plain constraint that states the value, `x == 5.5`, supplies it, and the equation is
  then *imposed* beside it in either order). A residual under the gate is a root's only where the equation is
  steep enough there, to first order. A flat one (`1.0 / x == 0.000001`, slope 1e-12) is under the gate 227
  from its root 1e6, which is found, so `x >= 999999.0` beside it is satisfied; one that tends to its asymptote
  where it has no root (`2.0 ^ x == 0.0`, `6.0 / (x + 1.0) == 0.0`, `5.0 == 1.5 ^ (5.0 * x - 10.0) + 3.0 +
  2.0`) reads *unknown* with what stands beside it, in every order, and `solveFeasible` has no witness for it, when it
  stands alone, beside an inequality, beside a pin, or beside an equation that fixes the other side. **The limit of that
  fence: an equation with no root reached through a further equation is not told from one with a root.** `y == 1.0 /
  x`, `z == y * 2.0`, `z == 0.0` (no `x` or `y` meets all three; each equation alone is within 1e-8 of a root) can still read
  *imposed by the solve* (T if the first is asserted), and `solveFeasible` can answer feasible with a witness at a huge
  `x` (about 2e11), as can `y == 2.0 ^ x` beside `y == 0.0000000001` and `x <= -34.0`, and `z == x / y`,
  `z == 0.0`, `x == 1.0` (at `y` about −4e38): the evidence that there is no root is in the equations together, and
  each is read alone. Two stated values that differ by more than 1e-8 of their size but by less than the gate
  (`x == 1.0000001` beside `x == 1.0`) are read as disagreeing, not as equal. A
  pin within the gate of a flat equation but off its root (`x == 999773.0` beside `1.0 / x == 0.000001`) is
  not read as agreeing with it. `solveFeasible` gives no witness at which a divisor the search moved is within
  tolerance of 0 (`x / y == 3.0` beside `y == 0.0` and `x == 0.0`: 0/0 satisfies nothing), nor one where an
  equation divides by exactly 0 (`y == 0.0` beside it, `x` free). One that disagrees with the
  values the others fix (`x == 7.0` beside them) is withheld with them. Such a
  quotient or exponential set equal to a side that varies with the same feature
  can cross it more than once, so the equation is read as a whole and as if it had more than one
  root, like `x * x == 4.0`: `x == 6.0 / (x + 1.0)` is met at 2 and −3, `6.0 / y ==
  5.0 - y` at 2 and 3, `2.0 ^ y == y + 1.0` at 0 and 1 (and `0.5 ^ x == x`, which is
  met once, is read the same). Beside `c1 { x == -3.0 }`
  it reads no value, and an inequality over a lone one (`k { x <= 0.0 }`) is
  unjudged, in either order of the text; the size of the component does not change that (a chain of seventy equations beside
  `z == x0 * x0` over `x0 == 3.0` reads as a short one). A loop
  of definitions is read the same way: the asserts `x == y * y + 1.0` and `y ==
  3.0 - x`, or the two as stated values (`x = y * y + 1.0`, `y = 3.0 - x`), have
  the roots (2, 1) and (5, −2), and the definitions bind x and y at the one the
  solve found, so a plain constraint over them (`e { x == 5.0 }`, `k { x <= 2.5 }`),
  or over a feature another equation or a plain constraint takes from them
  (`z - x == 1.0`, `w == x + 1.0`), is *unjudged* (*… and the equations over it
  may leave more than one root (a) …*); a loop with the one root (`x == 2.0 * y +
  1.0` beside `y == 3.0 - x`) and a chain of definitions off a stated value
  (`z == x * x` over `x == 3.0`) are read as before. A lone curved
  plain constraint is still *imposed*, at the root the solver found; an
  inequality, or any relation the solve gathers no equation from, over its value
  is *unjudged* (*… and the equations over it may leave more than one root (a) …*),
  since the other root may break it; `solveFeasible` searches such a root as a
  freedom, so `x * x == 4.0` beside `x <= 0.0` is undecided, not infeasible. Where
  its first search finds no witness it searches again from where the plain
  equations that are not curved put the value, so `x * x == 4.0` beside `x ==
  -2.0` is feasible with x = −2 in either order of the text; where that finds
  none either, the answer stays undecided. What still turns on the order of the
  text is where the solve starts, and the cases known read an abstention in one
  order where the other reads a value, never a different verdict: a divisor that
  is zero at its starting guess (`c0 { x / y == 3.0 }` and `c2 { w / y == x }`
  beside `c1 { x >= 0.0 }`, over a `y` nothing fixes) leaves the solve not
  converged when `c2` is written first, so all three read *unknown*, where the
  other order imposes `c0` and `c2`; and two asserted equations that share one of
  their roots (`a0 { x == 6.0 / (x + 1.0) }` beside `a1 { x == -3.0 }`, in a
  usage) read a constraint over their value *unknown* in one order and decided
  in the other; and a steep one-to-one equation (a quotient whose root is close to
  its pole) judged at a value that another equation gives to fewer digits than its
  slope needs, in two ways: a pin written to ten digits (`x == 0.000003000000001`
  beside `2.0 / (7.0 * x) - 95238.0952 == 0.0`, whose root is 3.0000000012e-06)
  reads both *imposed* with the equation written first, and *unknown* with the pin
  first, where the equation's residual at the pin is over its gate; and a value
  taken through an affine link, which the solve gets to about 1e-10 (`q1 { y ==
  1.0014000000014 }`, then `l1 { y == 2.0 * x + 1.0 }`, then `e0 { -3333.33333 ==
  7.0 / (-3.0 * x) }`) reads *unknown* in that order, and *imposed* in the other five
  orders of the three. A feature with no value that an `assert`
  constrains in a form the solve does not read — an inequality, a conjunction
  (`L == 50.0 and L >= 0.0`), a disjunction, or a body that does not parse
  (`M == max(L, 20.0)`, which the model reports; it constrains the names it
  writes outside its strings and `[unit]` literals, so the `m` of `M ** 2.0 ==
  4.0 [m]` is a metre, not the feature `m`) — is no design freedom for a
  check: no plain constraint is solved for it — `t1 { p.L == 1.0 }` does not fix
  p's L at 1 beside an assert that makes it 50 — and a relation over it is
  *unjudged* (*… has no value, and an assert constrains it in a form the
  numeric solve does not read (ca, a conjunction) …*). The model's own
  equations still solve it, and the freedom is read off them alone: a stated `e
  = x * 2.0` leaves x a freedom, and so does an asserted `M == L * 2.0` beside
  `tM { p.M == 100.0 }`, which fixes neither M nor L. A constraint of a
  definition read in a usage is judged at the values the model states; with any of them `fixed` by an API caller,
  `solveFeasible` leaves it unjudged (`decided: false`), and so does the
  numeric check (`unknown`). Every other relation is read at the fixed point,
  every feature the point moves at the value it has there — `y != 18.0` over
  `y = x * 2.0` holds with `x` fixed to 1. A value the caller fixes is the
  decimal it is, read exactly as a value the model states, and so are the
  literals the point keeps: `x <= 0.99999999999` is violated with `x` fixed to
  1, never held within the solve's tolerance, which reads only the values the
  solve produced (`y`, there). A name the point gives no value — a Boolean
  `ok = x > 5.0` over the fixed `x` — would read the model's own, so a
  relation over it is *unjudged* at that point, and `solveFeasible` leaves it
  unjudged too.
- **A point the solver stopped at without converging is no solution.** When
  the solve ends off one of the equations it solved — a Newton step that
  diverged, an instance's value it could not read — the values it produced
  there are neither listed as values nor as freedoms, and every relation over
  them is *unjudged* with the reason *the solve did not converge*: never
  violated at a point the model does not sit at. `solveFeasible` does not hold
  them there either: it searches them as freedoms, and a violation over them
  is unresolved, never decided. A model with a binding past a cap (below) reads
  so too: the values that binding holds are not read, the solve counts them
  undetermined and reports *did not converge*, and the rows over them name the
  cap.

**A target on a measure with no value of its own is read where the values
are.** A brief often states its targets once, on abstract measures that carry
no value (`package Common { attribute m : Real; require constraint t { m >= 0.9
} }`), and each layer gives its own estimate as a feature that subsets or
redefines the measure (`LA::m :> Common::m = 0.78`, `PA::m :> Common::m`
fixed by an asserted equation). `t` itself stays *could not be evaluated*, because the
layers may disagree and no one value belongs to `Common` — but its message now
says why (`m has no value here; evaluated per specialisation: LA::m, PA::m`, or
`… nothing specialises it`), and the target is judged once per layer through
that layer's estimate, by the same unit rules as any other check. Check lists
each reading as its own row under the target, and Validate and `npm run check`
report it as `validation/target-by-specialisation` at the estimate: a
**warning** when it misses (`LA::m = 0.78 misses Common::t (m >= 0.9)`),
**info** when it meets the target or cannot be read — two estimates of one
measure in the same layer, or a layer that specialises only some of the
measures a target names, are named rather than guessed between. A name the
context reaches through a reference (`pb`'s `r2.load` over `ref part r1 = p50`) is
named for the context's instance (`pb::r2.load = 50 misses P::c`), not for the
feature the last link ends at. A miss is its
own code, not a `constraint-violation`, because an estimate that misses is a
result to record, not a contradiction in the model.

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
| What did I declare and never use? | Palette → Checks → **Unconnected definitions** → **Run** (`palette-check-run`) | `npm run sysprose -- orphans model.sysml` |
| What guidance applies to this element? | — | `npm run sysprose -- prompts model.sysml --element X` |
| What does each requirement assume and guarantee? | **Contracts** view † | `npm run sysprose -- contracts model.sysml` |
| What must be shown, and what do the gates refuse? | Palette → Checks → **Obligations** → **Run** (`palette-check-run`) | `npm run sysprose -- obligations model.sysml` |
| How do I write a clause the tool will accept? | — | `npm run sysprose -- property-draft model.sysml --element R` |
| Would this clause pass the gates, and what does it say? | — | `npm run sysprose -- property-check model.sysml --element R --clause '…'` |
| Does the verdict in the file still hold? | **Requirements** view → *Evidence* column † | `npm run sysprose -- evidence-status model.sysml` |
| Write a run's verdicts into the file | — | `npm run sysprose -- evidence-attach model.sysml --from evidence.json` |
| Take them back off | — | `npm run sysprose -- evidence-detach model.sysml` |
| Which contract failures break the top requirement? | Palette → Checks → **Fault tree**: runs in the page on a local server and reads `not here` with this command (`palette-check-copy`) on the hosted site | `npm run sysprose -- fault-tree model.sysml --max-order 2` |
| Which states can a machine reach, and where did the simulator hide a choice? | Palette → Checks → **Reachability** → **Run** (`palette-check-run`) | `npm run sysprose -- reach model.sysml` |
| Does this behaviour pattern hold on every reachable configuration? | Palette → Checks → **Behaviour properties** → **Run** (`palette-check-run`) | `npm run sysprose -- check-behaviour model.sysml --element M` |

† **Validate** re-runs the rule engine over the model already in the editor;
`check` parses the file first and then applies those same rules. The
**Allocation** view tabulates only the elements that take part in a link, where
`trace` tabulates every element of the row and column kinds and so also shows
what links to nothing. The **Interconnection** view *draws* the ports and
connections; it computes no connectivity report — the palette's *Ports wired*
check does, and `connectivity` prints it. `prompts`, `property-draft`, `property-check`, `evidence-attach`, `evidence-detach` and
the depth walk behind `where-used`. The **Contracts** view projects the rows and
the census `contractReport` returns, where `contracts` also prints the keyword
inventory, the exclusion counts and every refusal reason, and can be scoped to
one element with `--element`. The **Requirements** view's *Evidence* column
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
`derive` and `refine` statements name it, the variables the clauses it **wrote**
read with their units, and the arithmetic **fragment** each clause lands in — linear
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
| `attribute m default = 18.5 [kg];` | an **axiom** of the definition's own feature, which a redefinition may override |
| `bind a = b;` | an **axiom** |
| `constraint c { … }` — no keyword | an **obligation**, not an axiom |

That last row is deliberate. A plain constraint is what the **Analyze** button
judges, so it has to be what a solver judges as well; filing it as an axiom
would let one false constraint make the whole axiom set unsatisfiable and turn
every real violation in the run into "cannot tell".

**A negated assert is refused.** The published grammar's `assert not constraint c { load > 10.0 }`
states that the body does *not* hold. This tool reads no negation of a clause, and every other reading
is wrong: as the plain assert it states the opposite (`c` checked as a fact, true while the body holds, so
a model that contradicts itself passes; its body an axiom), and dropped from a proof it restricts it
would let a refutation stand that the negation rules out. So the clause is refused with a finding of
its own, `mapper/negated-assert-unread` (an error, on the clause; `require not` and `assume not`, which
are no published form, are refused the same way). The load degrades like any load with an error: the
reporting commands exit 1 with the degraded banner, `verify`, `consistency`, `bounds`, `refine` and
`fault-tree` exit 2, `npm run check` exits 1, the app's checks stand down (`checks/degraded`), no surface
files a row for the clause, and the save writes it back as it was read. State the negation in the body
instead, `assert constraint c { not (load > 10.0) }`, an ordinary assert that this tool reads.

**A redefinition is the feature in its context, and `=` binds.** In `part p : P
{ attribute :>> m = 20.0 [kg]; }` every surface reads `p.m` as p's own feature —
named or not, renamed (`heavy redefines m`), however deep the chain that
reaches it. Whether it may have a value of its own depends on how P wrote `m`:

- `attribute m default = 18.5 [kg];` — overridable: `p.m` is 20 kg.
- `attribute m = 18.5 [kg];` — a binding every P holds, so p states two values
  for one feature. That is a **contradiction**: the check reports it as a
  violation at the redefinition (`validation/constraint-violation`), no surface
  reads either value for `p.m`, and the solver lane finds the axioms
  inconsistent. Write `default` where a
  usage is meant to override.

A `:>>` with a simple name redefines the **most specific** feature its owner
inherits under that name, as the copy a binding makes of the name does (below).
In `part s : Q2 { attribute :>> M; }`, where `part def Q2 :> Q` writes `attribute
:>> M default = 2.0;` over Q's `M default = 1.0`, s's M redefines Q2's, and
every surface reads `s.M` as 2 — through a general type that adds nothing, a
named (`attribute M :>> M;`) or keyword (`attribute redefines M;`) redefinition,
a nested `part :>> p { attribute :>> load; }` and a binding to s's M alike. A
redefinition under another name (`part def R :> Q { attribute M2 redefines M
default = 2.0; }`) is what an R has for M, as `t.M` reads t's M2 in `part t : R`:
`attribute :>> M = 5.0;` in a `part v : R` redefines M2, takes its name (`v.M2`
is that 5), and Save writes it as it was written, `:>> M`. A qualified name (`:>> Q::M`) redefines
what it names. Where two general types each redefine the name and neither the
other, the redefinition keeps the feature the name finds, and the diamond below
says what is read there; a type below both that redefines the name itself
(`part def Q6 :> Q2, Q3 { attribute :>> M = 5.0; }`) resolves it, and a usage
typed by Q6 redefines that M — `s.M` in `part s : Q6 { attribute :>> M; }`,
and the copy a binding makes of the name, read the 5 that `t.M` reads in `part t
: Q6;`.

The redefinition keeps the feature the name finds too where the most specific
one would make two features of the usage one, or give two the same name:

- a general type's `attribute X :>> M, N` would take both the `:>> M` and the
  `:>> N` of `part s : Q2`, and the model then gives X, one feature, two values.
  A usage that redefines either (`:>> M = 1.0` beside `:>> N = 2.0`, or `:>> M =
  4.0` alone), or both in one feature (`:>> M, N = 6.0`), reads neither name:
  every row over `s.M` or `s.N` is *could not be evaluated*, in a sentence that
  names X, on every surface; so is a row over a feature that redefines the line
  under another name (`attribute Y :>> X;` in a type below Q2, or in the usage),
  `s.Y` as well as `s.N`. A usage that redefines X itself (`:>> X = 5.0`)
  states one value for the one feature and reads every name of it, and one that
  redefines neither (`part t : Q2;`) reads X's value as written. A line that
  states no value over two features that state different ones (`attribute X :>>
  M, N;` over M's `default = 1.0` and N's `= 2.0`, two different defaults, or
  `= 1.0` and `= 2.0`) has no one value to read, whichever order the targets are
  written in, whether or not a usage redefines anything of it: every row over
  `s.M`, `s.N` or `s.X` is *could not be evaluated* too. Two that agree are read.
  The fence holds every name on the way to what a row reads: the nested features
  of a line of parts (`part X :>> M, N;` with `s.X.x`, `s.M.x`, `s.N.x`), and a
  feature derived from the line's names (`attribute Z = X + 1.0;` in Q2, read as
  `s.Z`, or in a type below Q2 that redefines one of them), are *could not be
  evaluated* too. A usage that states one feature twice is read the same way
  (`:>> x = 5.0; :>> x = 6.0;`, an `attribute x = 5.0;` beside an `attribute :>>
  x = 6.0;`, a `:>> x;` beside a `:>> x default = 3.0;`, two redefinitions of
  one part with different content nested below, or `5.0 [kg]` beside `5000.0
  [g]`): the model states both, and no row over `x`, `s.y` for a `y :>> x`, or
  what reads them is read there, written in either order. Two that say the same
  thing in the same unit are read. For values that differ the SMT engine still
  reports its inconsistent axioms;
- in `part v : R { attribute :>> M = 5.0; attribute M2 = 9.0; }` the first would
  be named M2 beside the second;
- in `part v : R, S`, where S writes `attribute M2 redefines K`, a `:>> M` and a
  `:>> K` would both be v's M2, and so would a `:>> M` beside an `M2` S writes
  of its own. `v.M2` is a name two features bear there, and no surface reads it.

A redefinition is saved by a name, and the feature a name lands on depends on what
the usage inherits and on the features beside it. So every edit in the app that
changes either leaves each `:>>` where the saved file puts it, in the same Undo
step as the edit, and the page reads what the file it saves reads: the Type field,
a line drawn or deleted, a feature renamed, dragged in the Explorer, added, pasted
or deleted, with the Delete key, the ✕ button or `window.sysml` alike (an edit through
`window.sysml` is settled the same, and has no Undo step of its own; so is a call on
`window.sysml.model` itself, where it ends (not the binding of references an open or a library merge does), and a change committed through the REST API once
its changes are in, so the commit's model reads what the file it saves reads; a peer's edit in a
room is settled by its sender, whose moves arrive as edits: see the cases below that are not
followed). `t`'s `:>> M` in `part t : Q2`, retyped to Q, is Q's M, which
Save writes `:>> M` and the next open lands on; deleting Q2's `:>> M` leaves it on
the feature that name finds now. A feature renamed to the name a `:>> M` is known
by (`attribute M2 = 9.0;` beside the `:>> M` that took R's M2) moves that `:>> M`
back to Q's M, as the file keeps them apart. A feature renamed away from it, or a
type retyped so that the name would land elsewhere, leaves the redefinition on the
feature it had, and Save writes that feature by its path (`:>> P::Q::M`), which the
next open takes as written; the same names written by hand, without that history,
land on the more specific feature. A redefinition whose feature has no name left
to write (the one it redefined was deleted) goes with it: Save writes the feature
without it.

The implicit copy a binding in a usage makes of an inherited feature (`part r : Q2 {
bind p.load = L; }` makes r an `L`) is not written to the file: the next open makes it
anew, on the feature `L` finds in r then. It is settled with the `:>>`s, in the same
step: retyped to Q, r's copy of `L` leaves Q2's `:>> L = 50.0` for Q's `L`, and a
retype back puts it on Q2's, so `r.p.load` reads the value the saved file reads. Where nothing r's
types hold bears the name `L` any more (`r` retyped to a type without it, or the feature `L` deleted
or renamed), the next open makes no copy and reads `bind p.load = L;` with `L` unresolved: the page
parts the copy from the feature it redefined (a stale copy, which redefines nothing), and the binding
that ends in it binds nothing, so `r.p.load` is what the file reads and nothing is proved through the
copy; a retype back, or the feature named back, puts the copy on a feature again. The copy is moved where
it stands, not made again: the binding stays on it. Save writes the copy under the name the binding was written
with, not the name of the feature the copy redefines: `bind Zb = M;` in `part u0 : D4, D3`,
where D1 writes `attribute N2 redefines M` and D2 has an `N2` of its own, stays `bind Zb = M;`
(it would have been `bind Zb = N2;`, which the next open reads as D2's `N2`). A name the
edit has since renamed away from that feature, or that a feature of r or a type now shadows
(the next open would read it as that feature), goes back to the copy's own. Renaming the feature a copy redefines
renames the copy with it (the next open names the copy by that feature), so a constraint written with the old name
reads what the file reads. Where another feature of the owner already bears the new name, the next open merges the
binding into that feature: the page parts the copy (a stale copy), and the row that reads through it abstains
where the file decides.

The Name and Short name boxes of the Properties panel apply on Enter or on leaving the box,
not per key (Escape puts the name back, and so does an emptied box: a name is not cleared there), so a name typed key by key is one edit and one Undo
step: a prefix another feature of the owner bears (typing `M2x` passes through `M2`) no
longer moves a `:>> M` to the base feature on the way.

A name that two of the owner's types answer differently (`b` in a nested `:>> b` of a usage typed `P2`
that redefines a feature typed `P3`, where P3 writes `attribute b :>> a` beside the `b` it inherits from
P) is read by the order the types are listed in, which a page edited by hand and the file it saves do not
share: Save writes that redefinition by its path (`:>> G::P3::b`), which the next open reads as written. A
redefinition that a `window.sysml` call (or a feature moved) points at a feature in a nested unnamed part,
whose path goes through the part's effective name, is dropped by the settle: the text has no way to name
it, and the saved file has none. One thing stays outside this: a rename that gives two features of one
owner one name, the declared one or the one an unnamed `:>> M` is known by (the Problems panel reports
`validation/duplicate-name` for the first): the saved file finds the first of them, which may not be the
feature the page's `:>>` is on, and a `window.sysml` call that points a redefinition at a feature its owner
does not inherit and a name does not reach can leave the page apart from the file. A rename made by
`updateElement` in steps (the SDK, not the box) is an edit for every call.

Five more cases are not followed, and in each the page can read what the saved file does not:

- A stale copy (above) is still a feature of its owner on the page, with no value: a constraint
  that names it (`r0.L` after `L` is renamed away) is read by the numeric lane as free (`imposed`),
  where the file reads the name as unresolved. No verdict is drawn through it; and the numeric lane
  may abstain on a constraint where the file decides it (deleting `Q::L` under a definition-level
  `bind p.load = L`, `r0.p.load == 12.0`). The Problems panel raises nothing for it: the file, opened
  again, reports `ref/unresolved-reference` and an unbound connector end.
- A feature renamed onto a name another feature of the same owner bears (`D2`'s `:>> N` renamed to
  `Z1` in a definition whose usage has a `Z1`) makes the file merge the usage's binding into that
  feature, and the page, which parts the copy, abstains on the rows the file decides; a literal row
  over the merged feature, which the file calls contradictory (`bind Zb = Z1` joins two values), the
  page can still read.
- A peer's edit in a collaboration room is not settled by the receiver, which relies on the
  sender's settle arriving as edits (not exercised with two live clients).
- A `window.sysml` call that points a redefinition at a feature its owner does not inherit (a
  retarget to an unrelated feature, or a feature moved into the usage that redefines it) can
  leave the page's redefinition apart from the file's: the saved text names it by a path the next
  open resolves otherwise.
- A cycle of redefinitions (`a :>> b`, `b :>> a`, already an invalid model): deleting one
  member leaves the other redefining itself, which the saved text reads as an unresolved name.

A feature redefines only what its owner **inherits**. In one definition, `attribute
mass default = 1.2; attribute :>> mass = 0.8;` is not a legal redefinition: the second
`mass` names the first, which the same owner declares. The check reports it as a warning,
`validation/redefinition-own-sibling`, at the redefinition. The model states the
feature twice, so every row read through it is *could not be evaluated* on every surface
(`unread-binding`, in a sentence that names the redefinition) until it is fixed. Put the value where `mass` is
declared (`attribute mass = 0.8;`), or redefine it in a specialisation or a usage
typed by the owner (`part b : Battery { attribute :>> mass = 0.8; }`).

The two values are compared as values, not as spelled: `1000.0 [g]` restates
`1.0 [kg]`, `10.0-k` restates `10.0 - k`, and `2.0 * 0.5` restates `1.0` — none
of them contradicts anything. A pair only an evaluation could compare
(`:>> m = 50.0` over `m = 2.0 * k`, where p may change `k`) is reported
`unknown` at the redefinition, `p.m` is read by no surface, and the solver lane,
which carries both values in SI, decides whether they meet. A feature that
hides P's `m` by its name alone (`attribute m = 20.0 [kg];` with no `:>>`)
overrides it all the same, and so does the same check. Two values a context
inherits under one name from two general types (`part def C :> A, B` over A's
and B's `:>> m`) are read by no surface there, nor through a binding one of
them is joined to (a `part :>> p : P2` whose P2 writes `:>> extra = 9.5`, under
Q's `bind p.extra = X`, reads neither 9.5 nor X's default), nor through the copy
a binding makes of the name in a usage of C (`part q : Q23 { bind p.load = L; }`
over `Q23 :> Q2, Q3`, whose L are 50 and 60: q's L, and q's p's load, read
neither, and the solve takes neither as a freedom) — in a usage typed by both
(`part q : Q2, Q3 { bind p.load = L; }`) too, and through a redefinition that
states no value (`attribute :>> L;`) as through the copy; two literal bindings
that differ are a contradiction reported at C, or at the usage that is itself
the diamond. One `=` and one `default` (Q2's `L = 50.0`, Q3's `L default =
60.0`) are no contradiction, and are read nowhere either. Nor are two values that
agree (Q2's and Q3's `L = 50.0`) read through such a copy or valueless
redefinition: it redefines neither, so the `default` the binding joins gives way
to them, and q's L and q's p's load are *could not be evaluated*; without the
copy (`part t : Q2, Q3;`) t's L is 50.

**A binding overrides a `default` as a redefinition does.** `bind p.m = M` in
`part def Q`, over P's `attribute m default = 18.5 [kg]`, makes p's m Q's M in
every Q — wherever M has a value of its own: written with `=`, or set in a
context (`part q : Q { attribute :>> M = 20.0 [kg]; }`). A value an asserted
equation gives M (M declared without one) is not carried into the default,
which stands against it as against any assertion: the binding then joins two
values (below). Every surface reads `q.p.m` as 20 kg, and no surface
reads the 18.5 kg: the numeric surface and the solver lane at the path `q.p.m`,
the check and the literal engine in q's p, the instance the binding carries q's
M into, in a sentence that names the binding the value came through (`q.p.m =
20 in …::q::p, its M …::q::M through …::q's bind`). The same holds for a
`default` on a feature the binding names directly (`bind m = M`), for one a
context writes on the bound end (`part q : Q { part :>> p { attribute :>> m
default = 30.0 [kg]; } }` against Q's `M = 20.0 [kg]`), and along a chain of
bindings: `bind B = A; bind C = B;` reads C as A, and R's `bind q.M = N` over
Q's `bind p.m = M` reads `r.q.p.m` as r's N. A redefinition that renames the
bound usage (`part q : Q { part pp :>> p; }`) is the slot the binding fills:
q's pp's m is q's M. A package's binding on a definition's feature (`bind
P::m = M` beside `part def P`) holds in every instance of P — `part p2 : P`,
Q's `part p : P` and each q's — and over a redefinition's own `default` there
(`part p3 : P { attribute :>> m default = 30.0 [kg]; }` reads M too). Where
one instance's m gets a value outside that binding — its own `:>> m = 25.0
[kg]`, or another binding (Q's `bind p.m = N`) — that value is M's and every
instance's, which the check and the literal engine do not read: no `default`
the binding joins stands, and they name what fixes it (*could not be
evaluated*). An asserted equation on one instance's slot (`p2.m == 25.0 [kg]`)
gives it no value: it is checked against what the binding carries there — M's
value, or, where M has none, P's `default`, which the binding carries into M
and which stands against the assert (below) — so every P's m is 18.5 kg, and
the assert is reported violated. One that joins two features of
a definition (`bind P::m = P::cap`) joins them in each instance at that
instance's values: the check and the literal engine do not read it, the
numeric surface solves it, and the solver lane proves what holds there but
abstains on a refutation the check cannot confirm. An instance of P written
in another package is not read through the binding by the check and the
literal engine (*could not be evaluated*). Bindings are read in every context
they hold in, each end the feature at its path there, and a `default` gives
way where the bindings joined to it reach a value of its own — in that
context. Whether it gives way is decided for each instance: a LITERAL default
still stands in an instance whose own component states no value and whose
every default is a literal agreeing exactly (where `q1 : Q` sets an M that Q
leaves valueless, a `q2 : Q` that leaves it unset reads P's 18.5 kg; a default
that reads a name, or two defaults that differ, stand nowhere). A binding to a
feature nothing gives a value (`attribute w; bind w = p.m;`) carries the
default into it instead: `w` is 18.5 kg. Two defaults bound to each other with
no value beside them stand where they state one constant value — numbers,
booleans or expressions that read no name, compared exactly (`1000.0 [g]` and
`1.0 [kg]` are one) — and give way otherwise, where they differ and where one
reads a name, however alike the text (`bind a1.v = a2.v` over A's `v default =
2.0 * K` joins two values where a2 sets K). The model states neither, and no
surface calls it a contradiction. A definition's constraint over a value read
through a binding is read anew in every usage a binding above joins to another
value, once per instance, as a constraint over a redefined value is. One read in
a usage (P's `load <= 10.0` in `Q::p`) whose value a binding of Q joins to
another in a context of Q (q's L) is read for Q's own p — the usage's own
instance, named `P::c in Q::p (Q's own)` on the verify lane — and again for each
other instance, q's p included, whose load the binding carries q's L into. So is
one where a binding written in or around one instance reaches into it and no
binding of Q tells the instances apart (`part q2 : Q { attribute E = 20.0; bind
p.extra = E; }`, or the package's `bind q2.p.extra = E`: q2's p is read in its
own element, at q2's extra of 20) — at a path the relation reads, or one a value
it reads reads: `bind p.s.extra = E` makes Q's p such a usage for `s.extra <=
10.0`, not for `t.extra <= 10.0`, though both are S's `extra`. The
rows are read apart, each at the value of the instance it names, so an instance
that breaks the relation is reported against that instance — at the line that
makes it differ: the member of its own stating the value the binding carries in
(q's `attribute :>> L = 50.0`; where two values reach the instance, the one that
breaks the relation — the one that makes it hold when it alone is put back to the value
the relation's own context gives it; where none does, or a value carries a unit, the first value a binding carried), else the element the instance is read in, else
its innermost own usage (`part q : Q`) or definition (`part def Q2 :> Q`), never the usage the instances share — and the check rolls
two or more of them up into one finding for each usage (past twenty usages of one
relation, into one finding for the relation, counting every instance and naming
its first five usages, with at most five violated instances after it; and past
twenty contexts a binding carries a value into, one finding per verdict and cause).
The roll-up counts the instances that hold, those it is violated in (the first
five named, then an ellipsis), those it could not be read in — with the cause of
each kind, up to three, and the first instance of each (*defaults differ:
R::q1::p*) — and those it did not read, with the cap (*not read in 2,001 (more
than 16,384 instance readings in this model)*, counts printed with thousands separators); a group of more instances than the
tool reads is one info finding that counts them all unread (where a binding holds
in more than 4,096 contexts, *not read in at least* the instances found, and the `instances`
payload then carries `atLeast: true`). A violated instance
names the value that breaks the relation (the one above: `extra = 20` where
`load = 2` alone would have held it; else the first value a binding carried), and, where a binding
carries it in, the value the binding carries and the binding
(``load = 50 — q1.L = 50 through R17::Q's `bind p.load = L` ``). Instances whose
violation that one value from one line they share breaks (put back to the relation's own
value, it holds) are one finding: `part def R { part q : Q {
attribute :>> L = 50.0; } }` read by R's own q and by each `part r1 : R` points at that
line once, named for what it redefines (`elementName` is `L`), and lists the others
(*; the same line breaks it in r1::q::p, r2::q::p*); one the line does not mend (the
relation fails on a default too), or a sixth distinct set of values read in a group,
keeps its own finding. A path with a
segment holding ` in ` or `@` is quoted (`R::'q in 1'::p`; in a context row's sentence too, `'X in Y'::'est@1' = 0.78 misses Common::t …`; the `instance` and
`instances.listed` fields keep the names as written). A relation written in the usage itself
and read for one instance besides the usage's own (`part q1 : Q` and no other)
has no roll-up, and a violation there is that instance's finding alone — one the
check could not read there, an info finding of its own. Solve lists an
instance as a row of its own (`violated inequality: load <= 10.0 in
R::q1::p`); past five rows of one relation, the violated ones fold into one
row, and so do the unjudged ones that give one reason or abstain for one cause
(defaults that differ, no value, a cap) — the first five instances, the count,
and the first one's sentence, which names that instance. In a terminal,
`verify` text folds the same way: past five rows of one relation and one claim
it prints five and one line counting the rest (`… and 3 more rows of R::c:
refuted in 8`; the rows of one relation and one claim print together), and the footer's findings fold by relation and code, counted
against the relation (`… and 3 more verification/refuted on R::c`; a requirement's
unnamed clause is counted against the requirement, `… on H::LoadReq`), not against
the instance of its first row; `--json` keeps every row. An
instance whose own element — the most specific one that denotes it — reads a
name of the relation, or a name that name's value reads, through another feature
is read in that element, at the instance's own
values: a redefinition with a value of its own on its path (`part q2 : Q { part
:>> p { attribute :>> extra = 20.0; } }` reads q2's extra of 20), a specialised
type (`part :>> p : P2`, for Q2's p and for every Q2 that redefines nothing of
it), a binding written there, a reference to another part (`ref part :>> r =
ra`). That row is the element's own reading too: q2's `part :>> p` has no row of
its own beside it, and each instance is one row under its name. One that
redefines the relation itself is *could not be evaluated* in that row on every
surface, and counted *not read* in the roll-up (in a group of one, an info
finding of its own); so is one where a reference the
relation is read through stands for another feature than where its value is
written (`ref part :>> r = s` written in Q's p is Q's `s`, and q2's p reads
q2's own `s`), or for one a binding reaches into; one whose path inherits a
name twice, neither feature redefining the other (`part def Q3 :> Q2, Q4` over
Q2's `part :>> p : P2` and Q4's `part :>> p : P4`, or `part q3 : Q2, Q4`: q3's
p is P2's and P4's at once, and no one element stands for it). An asserted
equation of the instance's own element over a `default` changes nothing the row
reads: the default stands against it (below), so q2's `part :>> p { assert
constraint { extra == 20.0 } }` over P's `extra default = 0.0` reads q2's p's
extra at 0, as every P does, and the assert is reported violated. An instance
row that reads a value an `assert` of an instance around it constrains, the
package's included, is *could not be evaluated*, read in its own element (`part
q2 : Q { part :>> p { … } assert constraint { p.load >= 0.5 } }`) or through
the usage (`part q1 : Q { assert constraint { p.x >= 5.0 } }`, or the
package's `assert constraint { q1.p.x >= 5.0 }`, for q1's p's x), whatever
the assert and whatever the value — a `default` or one written with `=`. So is one that reads such a
value through a value derived from it (P's `s = load + x` in `s <= 10.0`), in
units or not, and so is a check or literal row of a relation outside the
instance's rows that reads it there (a package constraint over `q1.p.x` or
`q1.p.s`); the numeric surface reads x's `default` past an inequality, which
leaves it standing. A relation read through a part a
binding joins to another (`bind p.r = s`, the relation reading `r.x`) is read
per instance nowhere, the usage's own row included: that row is *could not be
evaluated*, as it was before any instance was read. A relation written in such
a usage (`part p : P { constraint c2 { load <= 10.0 } }` in Q) is read the same
way; an `assert` there stays an axiom, read for the usage's own instance. A
part, port, item or structured attribute (one whose type has features of its
own: `attribute q : V` over `attribute def V { attribute x … }`; a type that
specialises a library scalar or quantity value is a scalar whatever features
it adds, `attribute def RatedMass :> ISQ::MassValue { attribute margin … }`) a
binding equates with another (`bind pp = top.a`, `bind q = top.pos`) is read
as that other where it says nothing of its own — no feature, value or binding
below it, one such binding, no type the other lacks, and a feature of the
element the binding is written in or of a package: `pp.load` is top's a's load
on every surface, `q.x` is top's pos's x, and in each instance of that element
the instance's own (W's `bind pp = top.a` read as `s.w.pp`, for `part s : Sys`
whose w is a W, is s's w's top's a). A reference, a subject's value or a
`satisfy` that lands on such a part reads on through it to the other (`ref
part r : T0 = pp`: r's load is top's a's; a package's `satisfy R by pp` is
read at top's a), and so does a reference to a reference. A `satisfy` is
read in the element it is written in, at the satisfier its path names there:
one that element inherits is that element's own (`satisfy R by p1` in `part sys
: W` is sys's p1, whose load sys's K gives through W's `bind p1.load = K`), and
so is one it redefines (beside w's `part :>> p1 { … }`, or the package's
`satisfy R by w.p1`). A `satisfy` whose path does not resolve where it is
written (`satisfy R by w.p1;` in a package nested in the one that declares w, or
in a part's body) is read at the feature the path names in its definition (W's
p1), never at w's: where an instance reads that feature otherwise (w's `part
:>> p1 { … }`), its rows and R's rows for the satisfier are *could not be
evaluated*, naming w, and the requirement is not read through it. One written in a definition, or in a usage another
specialises, is read once, at that element's own values, never in each of its
instances: one whose satisfier is a reference with a value or one an instance
redefines (`ref part r : T0;` under w's `ref part :>> r = p50`), such a part
or a subject, or is reached through one, is *could not be evaluated*, since an
instance can make that feature another (W's `satisfy R by r` over `ref part r
: T0 = pp`, where w's top's a breaks R); so is a requirement usage written
there whose subject's value names it through one (`requirement rr : R { subject
s = r; }` in W). And where an instance of that element reads what R requires
of the satisfier otherwise (W's `satisfy R by p1`, or W's `requirement q : R {
subject s = p1; }`, beside w's `part :>> p1 { attribute :>> load = 50.0; }`),
whether R reads it through the subject (`s.load`) or through a feature of its
own (`attribute m = s.load`, or one a binding gives it), each row of it is
*could not be evaluated* too, naming that instance; so is a relation read
through that subject from outside (`w.q.s.load`) wherever an instance reads
anything below p1 otherwise, whatever R reads, and `bounds` claims no bound of
a measure read so — a limit of this tool. An instance that changes nothing the
satisfier reads (`part w0 : W;`) reads it as written. Where neither is so plain
(`part pp : T0 { attribute :>> load default = 3.0; }`, a port bound to two
inner ports), a row that may read a value the binding carries is *could not be
evaluated*, in a sentence that names the binding: one that reads through
either end or a usage above one, or
through a feature a binding, a value or an `assert` ties to one; one an
instance reads through such a feature where its definition does not (W's
`pp.load` over `pp = top.a`, read in `w : W { part :>> top = t50; }`); and one
read for an instance at or below one. Every other row of the model reads as
before. `verify` files such a row `verification/not-evaluable` under the
reason `unread-binding`, a limit of this tool rather than a defect in the
relation, at exit 2, which `--allow-inconclusive` does not lower; `bounds`
claims no bound of a measure such a binding may carry. One valued with
another (`part pp : T0 = top.a`, `attribute q : V = top.pos`) equates the two
the same way: where it says nothing else of its own and its value is a path
below where it is written, it is read as that other, as a plain end of a
binding is; otherwise (`part pp : T0 = top.a { attribute :>> load = 50.0;
}`, `part :>> p = other` under an `assert` that reads through p, a part or an
attribute of a structured type valued with any other expression, a call
included) such rows are *could not be evaluated*, in a sentence that names
the value — and, where it says something of its own or has a type the other
lacks, so are those that read what the value names (top's a, which has pp's
50), as a binding's other end. A reference valued so is read as what
it names, in each instance at that instance's own: W's `ref part pp : T0 =
top.a`, read in w, is w's top's a. A relation W writes is read anew in an
instance that rebinds a reference on what it reads, or renames a part on its
path — directly, or through a value or a binding of W's it reads, however long
the chain of values — at what that instance's own reaches: w's `ref part :>> top
= t50` makes W's `pp.load`, `top.a.load`, an `attribute m = pp.load` and an
`attribute m; bind m = pp.load;` t50's a's load there (50, where t50's binding
gives it its L), and w's `part top2 redefines top { … }` makes `pp.load` w's
top2's a's. A value read in w that names the
renamed part by the name W gives it (`m = pp.load` over `pp = top.a`) is
*could not be evaluated* there — a limit of this tool. A reference a usage
nested in W writes is read in each instance of W a path reaches it through
(W's `part sub { ref part r : T0 = x; }`, read as `w.sub.r`, is w's sub's x);
one valued with a feature around that usage (`ref part r : T0 = p1`, W's p1)
is read at W's own values only, so where an instance of W reads that feature
otherwise (w's `part :>> p1 { … }`), every row read through it — or through a
value, a binding or an asserted equation that reads through it, as `sub.m` over
`attribute m = r.load` or `x == r.load` — is *could not be evaluated*, naming
that instance, but for the rows
of a group that reads each instance, which re-resolve the reference itself
there as above (Q's `part p : P { ref part :>> r = s; }` beside Q's `bind
p.load = L`). A reference redefinition that states no value (`ref part :>>
r;` in w, over W's `ref part r : T0 = x`) is read as a fresh instance of its
type, never as what `x` names, so every row read through it is *could not be
evaluated* too — a limit of this tool; so is the copy a binding's end written in
w makes of W's valued reference (w's `bind m = pp.load` over W's `ref part pp :
T0 = top.a`), and every row read through it (`w.m`). Through either kind, `bounds` claims no
bound of a measure (`w.sub.m`, `w.r.load`). One redefined over a reference written
with `=` (`ref part :>> r1 = p2` in w, over W's `ref part r1 = p1`) states a
second value, and a row read through it is *could not be evaluated*. A usage
that subsets a feature an instance reads otherwise is read alike: beside w's
`part :>> p1 { attribute :>> load = 50.0; }`, every w's p2 of W's `part p2 :>
p1;` is one of w's p1s, but this tool reads p2 through W's own p1, never as
one of w's, so each row read through p2 — W's own `constraint c { p2.load <=
5.0 }`, the package's `w.p2.load`, a `satisfy R by p2` W writes or a package's
`satisfy R by w.p2` (a subject's value `= w.p2` too), and what a value, a
binding, an asserted equation (`x == p2.load`) or a further subsetting reads
through it — is *could not be evaluated*, in a sentence that names p2, the
element whose own p1 it is read through and w, and `bounds` claims no bound of
a measure read so — a limit of this tool. So is a relation of p2's type read
in p2: with `part p2 : T1 :> p1;`, T1's `constraint tc { load <= 5.0 }` read in
W's p2 is a row of its own, *could not be evaluated*, beside T1's own row; one
nested in T1 (`part sub { attribute v = load; constraint tc { v <= 5.0 } }`)
has no element that stands for w's p2's sub, so its row, which stands for every
T1's sub, is *could not be evaluated*. The subsetted p1 is read alike from the
other side: where an instance reads p2 otherwise (w's `part :>> p2 { attribute
:>> load = 50.0; }`), w's p2 is its only p1 when both are `[1]`, but this tool
reads p1 at W's own values, so each row read through p1 — W's own `constraint c
{ p1.load <= 5.0 }`, the package's `w.p1.load` — is *could not be evaluated*,
in a sentence that names p1, the subsetter nearest to it that is read otherwise
(or is read with one) and w; a calculation's body or a derived value that names p1
(`calc m1 { 10.0 - p1.load }`) is read through it too. So does every usage of the same
subsetting component (the usages that subset one another, however many links apart,
whichever way round), for every instance of what they are features of — the usage
the instance redefines itself (w's own p1 beside W's `part p2 :> p1;`), one that
redefines the root (a `v : W { part :>> p1 { ... } }` beside w), or a second
specialisation that redefines it, included: a p1 further up a chain (p3 :> p2 :> p1,
w's `part :>> p3 { ... }`), the other super of a usage with two supers (`part u3 :>
u1, u2;` beside w's `part :>> u2 { ... }` makes w's u1 the valued one too, and so
does a value in the definition alone: `part u3 : T0 { attribute :>> load = 3.0; }` and
`part u4 :> u1, u3;` make u1's load 3 in a `part w : W` that redefines nothing), and the
usages above a subsetter that says something of its own, wherever it is declared: in w
(`part q :> p2 { attribute :>> load = 50.0; }`, or a chain `q :> p1`, `r :> q` of
which r says it), in W itself (`part def W { part p1; part q :> p1 { attribute :>>
load = 50.0; } }`), in a specialisation of W, in a package (`part x :> w.p1 { ... }`),
or in a usage of w, naming its usage through a path (`part q :> sub.p1 { ... }`).
A subsetter says something of its own by what it declares below it, by a value of
its own (`attribute y :> x = 50.0;`) or through its type (`part q : Q50 :> p1;` over a
`Q50` that redefines `load`). The rows read through p2 itself abstain
with them where p2 subsets one of these, though p2 is the usage that holds the
value: this tool does not tell the two readings apart; a usage that subsets none of
them is read as written. It does not read the
multiplicity, so a `p1` other members fill abstains too. Where no instance reads
p1 otherwise and no usage of its component says anything of its own, it reads as
written. Which of several usages a sentence names (the nearest, then the lowest
qualified name) does not turn on the order the text is written in.
An end of a connection the model connects to features (`connection cn : C connect
w.p1 to t;`) is the feature it connects, which may state what the end's type does not
(w's `part :>> p1 { attribute :>> load = 50.0; }`): `cn.a.load` is *could not be
evaluated*, in a sentence that names the connection and the end, whatever the
connected feature states.
A
value the partner of a binding derives (Q's `L = 2.0 * K`) is read for the bound
feature only where every instance it stands for reads the partner alike — not
for q's p, whose K q sets. A relation of Q read in a usage or a specialisation
that redefines such an input (Q's `c { load <= 5.0 }` over `bind load = L`,
read in `q2 : Q { attribute :>> K = 25.0; }`) is read at that context's own
instance, on every surface: q2's load is 50. Where another member the binding
joins states a value of its own there (`load = 1.0` beside it), q2's load would
be 1 and 50, and that reading is *could not be evaluated*. A context that
asserts the input instead (`q2 : Q { assert constraint { K == 25.0 } }`, or a
package's `assert constraint { q2.K == 25.0 }`, over K's `default = 0.5`) sets
nothing: no assertion replaces a `default` (below), so q2 reads Q's 0.5, as Q
does, `c` holds, and the assert is reported violated. One that redefines
the bound feature under a name of its own (`attribute ld :>> load`) has its row,
*could not be evaluated* (below). A usage that redefines a part
on the path and changes another input of a value Q reads through it is read
there too, though Q reads that value in its own p already (Q's `c { p.m2 >= 0.0
}` over P's `m2 = 10.0 - load - extra` and Q's `bind p.load = L`, in `q2 : Q {
part :>> p { attribute :>> extra = 50.0; } }`: q2's m2 is −41, violated); one
that changes no input (`part :>> p { attribute tag = 1.0; }`) reads Q's. An
asserted equation below the context over a `default` the relation reads is no
such input: Q's `c { p.L <= 6.0 }` in `q : Q { part :>> p { attribute :>> M =
7.0; } }` under P's `L == M` and `L default = 2.0` reads Q's 2 (the equation is
reported violated in q's p), and so do a relation over `p.extra` in `q2 : Q {
part :>> p { assert constraint { extra == 20.0 } } }` and W's `c { pp.x <= 10.0
}` over `bind pp = q.p` in `w : W { part :>> q { assert constraint { p.x ==
50.0 } } }`, each beside its assert reported violated. A binding written in a
usage's body to a feature of the definition around it (`part q : Q { bind
p.load = L; }` in R, over R's L) is read in the instance of that definition
around each reading, on every surface: r's q reads r's L (50 where `r : R` sets
K), and r0's q r0's. No value is read through a binding for any one instance
where it holds in more than 4,096 contexts or more than 32 usages deep, nor
through a binding joined to such a one, end to end or through a feature an end
redefines (a package's `bind Y = top.a.….a.load` beside the `bind a.load = L` 33
usages down that gives that load its value: Y's `default` gives way, and the
check reads no value for Y), nor through one whose end has no instance in a
context it holds in (R's nested Q used outside any R); a binding read through an instance
of a definition that owns a capped end is capped, whichever of the two is written
first. A binding joins such a
one through a feature an end redefines only where that feature is itself another
binding's end: U's `bind a.load = M` on its own `part a : T0` is not joined to
T1's capped binding by the T0 `load` both redefine. A value held so, which no
binding carries from a stated value, is no design freedom to the numeric surface
either: a relation reading it is *could not be evaluated* there too, never
solved as a design equation (`s.a.load == 9.0` for a shallow `part s : T1`
beside the capped chain), and the feasibility search does not move it. A model
with such a capped binding reports *did not converge* in the Solve header — the
check keeps its fail-closed reading, and the rows over a value the binding
holds name the cap (*a binding of this model is read deeper than 32 usages*).
A context that reads a definition's relation otherwise only because a value
the binding carries is its own there (`q2 : Q { attribute :>> K = 25.0; }`) is
listed and read at its own instance, as above — an asserted equation over a
`default` changes no such value (above) — and so is one that renames the bound
end (`attribute ld :>> load`: its row is filed, and is *could not be evaluated*
— *q2 redefines the bound `load` under a name of its own (`ld :>> load`), and
this tool does not read what a binding gives a feature so renamed*). Such a context, and one whose own
value a binding of the definition carries into what the relation reads (`q : Q {
attribute :>> L = 50.0; }` over Q's `bind p.load = L`, for Q's `constraint c {
p.m2 >= 0.0 }`), is that instance's reading: a
`validation/constraint-by-instance` finding at the member of the context stating
the carried value (q's `:>> L`) or renaming the bound end (q2's `ld :>> load`),
else at the context itself, never a target's
`validation/target-by-specialisation` verdict. A definition's relation over a
feature that states no value, and reads that feature itself, is read in the
instance whose binding gives it one:
P's `assert constraint a2 { load <= 10.0 }` over P's `attribute load`, in Q's
`part p : P` under Q's `bind p.load = L` and `L = 50.0`, is read in Q's p at the
50 the binding carries — the row `part p : P { attribute :>> load = 50.0; }`
gives — and is violated there (*p::load = 50 misses P::a2 (load <= 10.0)*, at
Q's `L = 50.0`): a model that contradicts itself. The check and the numeric
surface report it and keep deciding the relations beside it; the literal engine
marks a relation over a value the violated assert reaches (Q's `L`, tied to p's
load by the binding) inconclusive, naming the assert, and the SMT engine holds
the assert in that instance as an axiom, so its axioms are inconsistent. Where
Q's instances give the binding different values (`L default = 50.0`, `q2 : Q {
attribute :>> L = 5.0; }`) each reads its own, in a row of its own. P's own
row, which has no value to read, is *could not be evaluated*. A plain `constraint
a2` of P is read in the same instance and is refuted on every surface. So is a
relation that reads `load` only through a value derived from it (`attribute m2 :
ScalarValues::Real = 10.0 - load` under `assert constraint c { m2 >= 0.0 }`, up to four
values deep): Q's p is read at the `load` the binding gives it, and violated (*p::m2 = -40
misses P::c*), as where the instance redefines `load` itself (`part p : P { attribute :>>
load = 50.0; }`). And so is a feature Q's `L` gives with no value at all, not even a
`default`, where only an instance gives it one (`part q : Q { attribute :>> L = 50.0; }`):
neither an `assert` nor a plain `constraint` of P is read in Q's own p, which has no value
(*could not be evaluated*), but each is read, and violated, in q's p, and a q2 whose `L`
is 5 holds. The check and the numeric surface keep deciding the relations beside the
violation (`kL { q.L >= 0.0 }`) at the values they read; the literal engine marks one
inconclusive where the violated assert reaches it, and the SMT engine, which files that
assert in q's p as an axiom, reports its axioms inconsistent (a plain `constraint` of P
files no axiom, so kL reads 50 on every surface). The contexts a relation is filed at do not
turn on the order the text is written in: a renamed redefinition (`part p2 :>> p` in
`q2 : Q`) written before `part def Q` leaves Q's p, and every other instance, filed as
they are when Q comes first. A binding that gives the instance
no value this tool reads (two defaults that differ) lists no such row: whatever
reads that value is *could not be evaluated*. The binding
need not be written in the definition around the instance: one written in an
enclosing instance (`part s2 : S { bind q.g = K; }` over S's `part q : G`, or
`bind s2.q.g = K;` in the package) makes s2's q and its g copies of S's, and a
copy holds every assert its types and the instances around it hold. G's `assert
constraint ca { g <= 10.0 }` is read in s2's q at the K of 50 the binding
carries, over a `g default = 1.0` that gives way to it, and is violated there; the
worklist files it as an axiom of that instance, so the SMT engine reads every
row of the file *inconsistent axioms* (it had proved `s2.q.g == 50.0` and `K ==
50.0`), and the literal engine places the contradiction at s2's q and its K —
and decides the relation over s1's g — where it read the assert in an instance
the worklist filed no row of, and judged no relation at all. The same holds for a
binding written at the top over the copy of a usage a specialising definition
types (`bind r.q.p.load = r.q.L`, over Q's `L == 2.0 * K` at Q2's `K = 25.0`:
the L of 50 against p's load of 1, which the check reports on the binding), for
one a usage of the enclosing definition writes (R's `part q : Q { bind p.load =
L; }`, read in `part r : R { attribute :>> K = 25.0; }` and in a definition that
specialises R), and for a binding a general definition writes over the
redefinition of its usage (Q's `bind p.load = L` with `L = 1.0`, over Q3's `part
:>> p : P2` whose assert gives p's load 50): the SMT engine decided or proved a
relation beside each, and now reports the axioms inconsistent. Such bindings are
read as deep as 32 of them below one another (definitions that hold each other go
on without end); a row that reads what a binding beyond that joins is *could not
be evaluated*, in a sentence that names the depth, and a proof is not claimed
over it. A per-instance
reading that fails inside the tool makes the row it was read for
*could not be evaluated*, in a sentence naming the failure (`… the per-instance
reading failed (RangeError); reported, not dropped`; a group's roll-up counts it
*not read*), and every other row and finding stands — on the verify lane too, where the goal row is refused in
that sentence and closed as a failure of the tool, not a defect in the relation. A failure while the tool lists the instances one usage reads a
relation in is that usage's one row, *could not be evaluated* in the same
sentence; one while it lists the asserted equations over a `default` it does not
read, or the satisfactions, subjects, references and subsetting usages an instance reads otherwise,
leaves every row *could not be evaluated* (*… could not be listed: the reading
failed (RangeError); reported, not dropped*), since which rows they reach is
then unknown — and every other rule's findings stand. A value a binding carries is read in the unit
the feature it fills declares — the copy `bind p.load = L` makes of P's `load`
included — and compared as the quantity it is: q1's `L = 20.0 [kg]` is 20 kg
against P's `cap = 10000.0 [g]` (violated, on every surface), q2's `L = 5000.0
[g]` is 5 kg (`load = 5` in the row's sentence), and a bare literal beside it
is read in `load`'s unit (`load <= 10.0` holds for q2). A value of another
dimension carried into it (a length into a mass) is compared by no surface.
Into a feature that declares neither a unit nor a kind, a quantity is read as
written only where that is its number in coherent SI: q's `L = 2.0 * K` over `K
= 25000.0 [g]` is 50000 as written and 50 kg, and a bare number beside it
(`q.p.load <= 1000.0`) is compared by neither the check nor the literal engine,
in a sentence saying the feature declares no unit to read it in; a quantity
beside it (`<= 60.0 [kg]`) is compared in units, and the numeric surface and the
solver lane read SI.
Against a value written with `=`, a binding is a **contradiction**, as a
redefinition is: `bind p.m = M` where P writes `m = 18.5 [kg]` and q's M is 20
kg is reported violated at the binding (in a context that specialises the
binding's owner, at that context) by the check and the numeric surface,
`solveFeasible` decides the model infeasible, and the solver lane finds the
axioms inconsistent. Neither value is read where the binding joins them: a
relation reading `q.p.m` or `q.M` is *could not be evaluated* on the check, the
literal engine and the numeric surface; the check and the literal engine say
why in a sentence that names the binding and the two features it joins, and
the numeric surface reports that the feature has no value in scope. A relation
written in P itself is still judged on P's own row at 18.5 kg by the check and
the literal engine, even where q's p is the only P. The two are compared as
written, as a redefinition's value is against the one it redefines: a pair
written the same (`1000.0 [g]` and `1.0 [kg]`) is one value, and is read. A
pair only an evaluation could compare (a value expression that reads a name:
q's p's `load = 30.0` against Q's `L = 2.0 * K`) is evaluated, both values where
the binding's valued members are read, exactly (no rounded number decides it):
where the two meet (`load = 50.0` there, with K 25) they are one value, and it is
read; where they differ (30 against 50) neither is read, as above; and where the
evaluation decides neither (an input with no value, a bare number against a
quantity), neither is read either, in a sentence that names the two values and
says that whether they meet takes an evaluation this tool does not make. The
numeric surface reads neither value of such a pair anywhere, and reports that
the feature has no value in scope. The binding is reported violated where the
check finds the two differ: such a pair is judged on the binding's own row at
its two values as written, each read where it is stated, and every other value
as the check reads it. A binding to a feature of
the instance around the usage it is written in (R's `L` in `part q : Q { bind
p.load = L; }`) is read in the element that holds both ends — R, at `q.p.load ==
L` — so r2's own `:>> load = 3.0` in its q's p against r2's L of 50 is reported
on that row, read in r2 and quoted where it is written (*`bind p.load = L` in
R::q, read in r2 through R as `q.p.load == L`, …*), and the solver lane holds
r2's q's p to the binding (its axioms are inconsistent).
Only a binding whose own two ends state the differing values is reported: a
binding beside it in the same chain (`bind K = L` with both 30, next to `bind L
= M` with M 50) is not. An instance the binding does not join (`part p0 : P`
outside any Q) still reads P's 18.5 kg on the check and the literal engine; the
numeric surface, which reads P's `m` once for every instance, reads it nowhere.
For a package's binding on a definition's feature (`bind P::m = M`, M written
with `=`) against an instance's own `:>> m = 25.0 [kg]`, only that instance's
own value goes unread: M, a package's feature and so one instance, and another
instance's `m`, which the binding makes M, are still read on the check and the
literal engine, though not on the numeric surface, which reads P's `m` once for
every instance; and no binding finding reports the pair. The solver lane holds
that instance to the binding as well, units or none, so its axioms are
inconsistent, and the SMT engine says so beside the other surfaces' *could not be
evaluated*.

**A `default` stands against every assertion.** `attribute L default = 2.0;`
beside `assert constraint qa { L == 5.0 }` is L = 2 on every surface, as `attribute
L = 2.0;` is (as the maintainer decided on 2026-10-22, after the standard's
text: a default gives way to another value given for it, and an assertion that
does not hold is an inconsistency for tooling to flag).
The assert is reported violated, and `L <= 3.0` is read at 2 by the check and
the numeric surface, as beside `L = 2.0`. The model contradicts itself there,
so `verify` decides no relation over it, and exits 2. The SMT engine finds its
axioms inconsistent, and a contradiction among the facts it encodes makes
**every** SMT row of the file `verification/inconsistent-axioms` — a relation in
another package, over values nothing ties to the contradiction, included. One
through a relation a gate refuses (`L % 4.0 == 3.0`) is reported only on the
rows whose proof context holds that relation, and a relation in another package
is proved as usual. The literal engine marks `L <= 3.0` inconclusive under the
same code and names the assert (*not judged at the model's values: the model
contradicts itself there — the asserted `L == 5.0` (…::qa) is false at them,
and this relation reads `L`, which that contradiction reaches …*), where it once
called the pass unconditional and exited 0. "Reaches" is wide, and errs toward
deciding nothing: a value the assert reads, one derived from it or bound to it,
one an assumption of the relation reads (the sentence then names the
assumption), one a single relation sums with it (`b` beside `total = a + b`,
under an assert over `a`), an instance's own value of a feature it reaches (with
the binding that carries that value there, whether or not another relation reads
that instance: Q3's p's `load` reaches Q's `bind p.load = L` and q3's L), and the same feature in another
instance this tool reads as one value with it (q1's `assert constraint { p.x ==
50.0 }` over P's `x default = 2.0` reaches P's own x and q2's p's too, as it
does for the SMT engine); the row names the assert, which `check` reports
violated. An assert the check reports violated anywhere is taken as violated
in every instance `verify` reads it in, except where the check reads it true
there. Two kinds of violated assert this tool cannot place reach every relation
of the file: one that reads no feature (`1.0 == 2.0`), and one the check
reports violated in an instance for which `verify`'s worklist files no row of
it (the row names the instance and says so). A relation over values the contradiction does not reach — another
package's, or an instance whose own value meets the assert — is judged at them
as before. A binding that joins two different values is the same kind of
contradiction, since a binding holds in every instance as an assertion does:
`bind p.load = L` over p's load `default = 3.0`, which no assertion replaces, and
Q's `assert constraint { L == 1.0 }`. The check reports it on the binding's own
row (above) and keeps deciding the values beside it, and the literal engine
marks a relation over a value the binding joins inconclusive under the same code,
naming the binding (*the model contradicts itself there — AMD::Q's `bind p.load
= L` joins two values that differ, and this relation reads `q0.p.m2`, which that
contradiction reaches: the binding joins it …*), with the reach of an assert's:
the values the binding joins, what is derived from them or tied to them by other
bindings and asserts, and the same feature in another instance this tool reads as
one value with it. A binding the check reports violated only in an instance that
redefines what it joins (*… joins two values that differ in M2a::q*) counts as
violated in every instance, as an assert does. One the worklist files no row of
that reads a feature reaches every relation of the file, and the row says so.
A relation over values the contradiction does not reach (an instance whose own value
meets the binding) is judged at them as before. Where the assert is an
equation that names the default's feature alone on one side, its other side
reading neither it nor another `default` — the shape that once defined it — the
sentence also says why the default stood and how to write the value it meant to
give (*Constraint violated: L == 5.0 — Q::L's `default = 2.0` is not changed by
an assertion: write the analysis as the value (`:>> L = …`) to replace it*, for
an assert written in a usage or a specialisation of Q; for one written where L
is declared, or below it (a part nested in Q, or a package's assert over the
package's L), *(`= …` in place of `default = 2.0` where HL::Q declares L)*,
since an element may not redefine its own feature; for a dotted name, the
redefinitions down the path from the deepest feature the element declares
itself: *(`part :>> p { attribute :>> x = …; }` in R::q1)* over Q's p,
*(`attribute :>> mass = …;` in M4::Pack::b)* over Pack's own `part b`). An
instance row says it too, read as that instance reads its names (Q's `assert { p.load == L }`
over `part q : Q { attribute :>> L = 50.0; }`: *… q::L = 50 misses Q::tie (p.load == L) — P::load's
`default = 1.0` is not changed by an assertion … (`part :>> p { attribute :>> load = …; }` in
H2E::q)*), and so does an assert in the package over a feature with no value that a binding
carries a `default` into (`assert { q.p.x == 3.0 }` over `bind p.x = L` and q's `L default =
4.0`: *… q::L's `default = 4.0` is carried into q.p.x by a binding and is not changed by an
assertion: write the analysis as the value of q::L to replace it*). An
inequality (`mass <= limit` over `limit default = 1.0`),
or an equation that only reads a default on its other side (`mass == 0.2 *
cells` over `cells default = 4.0`), is a requirement checked against the
default, and its sentence says nothing more. The default stands whatever the
assertion: an equation, an inequality (`L >= 5.0`), a conjunction (`L == 50.0
and L >= 0.0` reads as the two asserts `L == 50.0` and `L >= 0.0` do), an equation spelt
as two inequalities (`L >= 50.0 and L <= 50.0` reads as `L == 50.0`), two that
disagree (`L == 50.0` and `L == 60.0`, both violated, in either order), or one
that sets two defaults equal (`L == K`, checked against both); and wherever it is
written — in the feature's owner, in a type its owner specialises (Q's `assert
constraint { L == 5.0 }` over `part q : Q { attribute :>> L default = 9.0; }`:
q's L is 9, and the assert is reported violated in q), in an instance around it
(`part q1 : Q { assert constraint { p.x == 50.0 } }`: q1's p's x is P's 2), in
the package, through a reference (Q's `r.x == 50.0` over q's `ref part :>> r =
p1` is checked against p1's 2), or past a part a part-valued binding makes
another stand for (`bind pp = q.p`: `pp.x` reads q's p's 2). A `default` gives
way only to another value given for it: a redefinition (`:>> L = 50.0`, or
`:>> L default = 50.0`) or a binding to a value (above). An estimate an analysis
is to replace is written as that analysis, in the variant or the usage
(`attribute :>> mass = cellCount * cellMass;`), or the feature is declared
without a value and an asserted equation defines it (below). Nor does a binding
carry an asserted value into a `default`: `attribute L; bind L = L0; assert
constraint { L == 50.0 }` over L0's `default = 1.0` reads as it does with `L0 =
1.0` written with `=` — L0 is read at its 1 on every surface, never at the
assert's 50, and L, which the equation defines and the binding joins to that 1,
has two values and is *could not be evaluated* on the check and the literal
engine (*… joins it to P::L0's `default = 1.0`, a value no assertion replaces (as
one written with `=`) that differs from the one the equation gives it there …*);
the binding's own row reports the pair. A feature with no value that the
bindings join to both (M in `bind L = M; bind M = L0;`) has the same two values,
and no surface reads it (*M is not read in …: a binding joins it to …::L, which
…'s asserted `L == 50.0` defines, and to …::L0's `default = 1.0` …*). So through
a package's binding on a definition's feature: an asserted equation that fixes one instance's slot
(`p2.load == 5.0` under `bind P::load = M`, M's `default = 9.0`), or an end
only an assert defines that a binding joins to the slot (`bind p2.load = L`
beside `L == 5.0`), leaves M's default standing in every instance of P, as `M =
9.0` does — every P's load is 9, the first assert is reported violated, and
the second's L, joined to p2's load and so to M, has two values and is not read
(the binding's own row reports the pair). A `default` that a binding to a value
written with `=` makes give way (a default gives way to a binding in its context
— W's `bind q.p.load = M` at W's q's p, beside Q's `bind p.load = L`; a
package's `bind P::load = M` in every P) reads what that binding gives it there.
Where an asserted end of the same component states a value there too (Q's `L ==
3.0`, joined to W's q's p's load), a relation over the default there is *could
not be evaluated*, even where the two values agree, as here: this tool does not
compare them there, a known gap; the assert itself is checked against M's 3 and
holds. Where no such binding reaches (Q's own p), the default stands, as against
any assertion, and Q's binding is reported; so it does where such a binding
reaches only another context — a specialisation or another instance that sets
the bound feature with `=` (`part def Q5 :> Q { attribute :>> L = 7.0; }`, `part
q5 : Q { attribute :>> L = 7.0; }`): Q's own `part q : Q` reads P's default on
the check and the literal engine, never the asserted `L == 50.0` read through
Q's binding, and the solver lane finds q's values contradict themselves, as
beside `load = 1.0`. A `default` a binding makes give way is no feature without
a value either: where that binding gives it none (two defaults that differ), no
asserted equation gives it one, on any surface — the SMT engine carries no axiom
over it, nor over a feature with no value whose bindings carry the equation's
value to such defaults through a package's binding on a definition's feature
(`bind p2.load = L` beside `L == 5.0`, under `bind P::load = M` with M's
`default = 9.0` and p4's `:>> load default = 7.0`: p2's load is read at L's 5 on
the check, and p3's, which only M would carry it to, is read on no surface — the same
where the equation and the binding are written in a definition W and the slot is w's
p2 (the equation may sit in a definition that encloses W and name the feature by a dotted
path, or in a supertype or a subtype of W), and where the assert fixes the slot itself with no binding at it (`p2.load == 5.0`,
under the same two defaults that differ): p3's load and M are read on no surface, the
numeric surface included; that surface alone still reads the slot itself at the assert's 5). An
assert typed by a constraint definition (`assert constraint e : Eq { in a = L; }` over `constraint
def Eq { in a; a == 50.0 }`) is read by no surface, and files no row of its own.
Where the definition's body holds an equation — alone, or in a conjunction (`a
== 50.0 and a >= 0.0`) — what it may define is read nowhere: every feature a
name in it reads — each value it gives a parameter, bare or dotted (`in a =
p.load`), and each feature it binds one to (`bind a = L;`), resolved where the
assert is written, in a definition, a usage or a package — or in a constraint
usage the assert specialises (`assert constraint ea :> e0;` over `constraint e0 :
Eq { in a = p.load; }`) — and each name the body, or a value the definition gives
a parameter, reads: one that is no parameter, and one read through a parameter as
what the parameter is given (`x.load` over `in x = p`, or `bind x = p`, is p's
load; where the rest of the name is nothing of p's, every feature below p) — with
what that feature redefines and what redefines it. This is a limit of the
tool, not a rule — no assertion replaces a `default`, but this tool does not
read the definition's equation to check it: a `default` among them is not read,
by feature, in every instance (an assert written in `part q : Q` leaves Q's own
rows *could not be evaluated* too), one with no value is no design freedom to
the numeric surface, which solves no relation over it as a design equation, and
a relation over either is *could not be evaluated* (*L is not read: its
`default = 1.0` is named by `assert constraint e : Eq` in Q, whose equation this
tool does not read*). A value written
with `=` is read as written. Where it holds none (an inequality), the default stands, as
beside an untyped inequality. An equation that
names a feature by its path, `assert constraint { p.x == 3.0 }` over `part p :
P` whose P declares `x` with no value, gives p's x that value, and P's `y = x *
2.0` is 6 in p; not where a binding gives p's x a value (the assert is checked
against it) or two such asserts give it two (it is read as no value). Nor is an
element's own equation over a feature it declares without one read where a
binding joins that feature to a value written with `=`, or to a `default`, that
the equation does not give it: p's `assert constraint { x == 3.0 }` under q's
`bind p.x = L` and `L = 4.0` (or `L default = 4.0`) states two values for q's p's x (a contradiction) — as does P's own
`x == 3.0` read in q's p, or one written in q1's `part :>> p { … }` under Q's
binding — and every relation over q's p's x, the assert's own row included, is
*could not be evaluated* on the check and the literal engine, in a sentence
naming the equation and the value; the binding's own row reports the pair. The
numeric surface still reads one of the two for `q.p.x` itself (the binding's 4
where p's own assert writes 3, P's 3 where P writes it), and neither for P's
own relations in q's p, beside the solver lane's inconsistent axioms; q's L, the
other end, is still read at its 4 (a known gap). The two are compared exactly,
and evaluated where only an evaluation compares them: `x == y * 2.0` with y 1.5
against `L = 3.0` is one value, 3, and is read; where the evaluation decides
neither, x is not read either, in a sentence saying that whether the two meet
takes an evaluation this tool does not make. An equation written over the path
where the binding holds — in the package, in a definition that specialises the
binding's owner, or in an instance of it (the package's `assert constraint {
q.p.x == 3.0 }` over q's `bind p.x = L`) — is checked against what the binding
carries there, L's value written with `=` or its `default`: 4, and the assert is
reported violated. One written in the binding's type over an instance that
writes the binding (Q's `p.x == 50.0` over `part q1 : Q { bind p.x = K; }`, or
in q1's `part :>> p`, the package's `bind q1.p.x = K`, a definition's around
q1) is read for q1, at the value the binding carries: K's 9, written with `=`
or as its `default`, which stands (above), is not 50, so the assert is violated
in q1 (*p::x = 9 misses Q::tie (p.x == 50.0)*) and the model contradicts
itself. The check and the numeric surface report it and read `q1.p.x` and `K`
at 9; the literal engine and the SMT engine decide neither (inconsistent
axioms), and `verify` exits 2. Q's own row, where p's x has no value and the
assert defines it, holds. Where the binding gives q1's p's x no value this tool
reads (`K default = 9.0` and `J default = 8.0`, both joined), the assert is not
read in q1: every reading of the pair — J, K, q1's p's x, the assert's own rows
— is *could not be evaluated*, in a sentence naming the assert and the binding
(*… is not read where `bind p.x = K` in R::q1 joins p.x to a `default`, which no
assertion replaces: the assert holds in that instance too, and this tool does
not read it there, so the model may contradict itself unreported …*), and
`verify` exits 2.

**Two asserted equations that disagree.** A feature declared without a value
that two asserted equations define with two different values — `assert
constraint c50 { L == 50.0 }` beside `assert constraint c60 { L == 60.0 }` in
P; one in P and one in `part p : P { … }`, whether p redefines L, declares it
anew without `:>>`, or neither; two in two types a definition specialises, or in
two that each redefine L; P's beside one written around the instance (`assert
constraint { p.L == 60.0 }` in the package, or in a definition whose part p is);
or one in an element nested in the one that declares L whose `L` resolves to
that one (in a part's body, a nested package, or a definition in the package); or
one on each of two features of an element that a `bind` of it joins (`bind L = K`
beside `L == 50.0` and `K == 60.0` in P, through a chain `bind L = M; bind M = K`
too, which may run across a specialisation — `bind K = L` in P and `bind N = K` in
P2, joining P2's N to P's L through P2's own K, which redefines P's — whether or not the
middle of the chain states anything; either equation may be written in a usage
of P or in a type that specialises it) — a binding says the two ends are one
value, so the equations define one feature twice, and the sentence names the
binding or bindings that join them (*each define `L` (joined to `K` by `bind L =
K`) in …::P*) —
is a model that contradicts itself, whichever is written first, and no surface
that judges a relation reads it. Every relation over L, or over a value tied to
it (derived from it, bound to it, or read beside it by an asserted relation —
but not a value written with `=` or as a `default`, which is read whatever its
asserts), is *could not be evaluated* on the check and the literal engine, and
unknown on the numeric surface — the equations' own rows included, in every
instance of the feature, P's own L and every P's — in a sentence naming each
equation (*L is not read: the asserted `L == 50.0` (…::P::c50) and `L == 60.0`
(…::P::c60) each define `L` in …::P, which states no value, and give it two
different values — the model contradicts itself there, whichever is written
first …*; the numeric surface says it on the equations' own rows too, where the
solve, meeting two equations that disagree, did not converge, and a row it could
not judge for another reason keeps its own sentence), and `verify` exits 2 on either
engine, its rows printing no value for L (nor an SI pair). No export reads one
either, whichever equation is written first: the FMI `start` of such an L, or
of a value tied to it, is the type's default (`0`, `false` for a Boolean, the
empty string for a String) as for a feature with no value, a placeholder FMI
requires and no value of the model (the variable's `description` says so:
*start is the type default, not a model value …*); a `local` has none; a co-simulation holds
no input at it, so the outputs over it read NaN; and Solve lists a measure of
effectiveness that is one as *(unknown)*. A value written as a number, a
Boolean or a String keeps its start. A parameter or input the model gives no
value this tool reads (none, or one it cannot evaluate, such as `A + 1.0` over a
valueless `A`) has the same placeholder start (its `description` says *start is
the type default, not a model value: the model states none this tool reads*), and a
co-simulation holds no input at it either: a block's output over a valueless
input reads NaN until the master or the caller sets that input, never the
output of an invented 0. As wide as the rest of this abstention,
this is by feature: P's own `load` falls to the default too where P's equation
is consistent and a `part p : P` elsewhere writes the second. A relation over a
name a defining side reads, or one tied to it (`a` of `L == a * 2.0` with `a =
30.0`, a package's `g` of `W == m * g`, the K that `bind a = K` joins to a), is
read by the check and the numeric surface at the value the model states, and
the literal engine marks it inconclusive under `verification/inconsistent-axioms`,
naming both equations (*… the asserted `L == a * 2.0` (…::P::e1) and `L == 50.0`
(…::P::e2) each define `L` in …::P and give it two values that differ, and this
relation reads `p.a`, which that contradiction reaches …*), as the SMT engine
finds its axioms inconsistent.
`check` reports the pair once, a `validation/constraint-violation` warning at
the element where the equations meet (P; p, for one in P and one in p; the
definition that specialises the two types; the package, or the definition, for
one around the instance or nested in it), which the numeric surface files as
well; `solveFeasible` decides the model infeasible, the pair its violation, as
for a binding to two values; the SMT engine finds its axioms inconsistent and
names both equations in its core. It once took the first written, the local
one, or the outer one, as the definition and reported the other violated, so
swapping the two lines flipped `p.L == 50.0` between holds (exit 0 under
`--engine literal`) and refuted (exit 1), and one in P beside one in p read both
true with `check` silent. The two are compared exactly: each side that defines
the feature is read as a number over `+ - * /` and `[unit]` literals, or a
Boolean, the names it reads read where it is read — a value written (a usage's
`:>> a = 30.0` in that usage), or what the asserted equations of a name with
none give, while they agree. So `L == a * 2.0` with `a = 30.0` beside `L ==
50.0` is the warning, `L == 50.0 [kg]` and `50000.0 [g] == L` agree, and define
it, as two equal ones always did, and so do `x == y * 2.0` beside `x == 6.0`
with `y == 3.0`; `f == true` beside `f == false` is the warning. Two this tool
cannot compare exactly — unless they are the same expression: a number with a
unit beside one without, a side in another form (`L == 2.0 ^ 3`, `L == 10 %
3`), and a side over a name this tool does not read exactly (one a binding
joins, one read around the element, one defined where it is not read) — are
*could not be evaluated* the same way, and the check reads each side with its
own evaluator, where it is read. Two that differ there, beyond the tie rule,
are the warning, its sentence giving each reading: `L == 50.0` beside `L ==
60.0 [kg]`, the bare 50 read in L's declared kind (*… which differ at the
model's values (`50.0` is 50 [kg], `60.0 [kg]` is 60 [kg]) …*); `L == a * 2.0`
over `bind a = K` with `K = 30.0`, beside `L == 50.0`; `W == m * g` over the
package's `g = 9.81`, beside `W == 20.0`. Two it reads alike or within the tie
rule (`L == 50.0` beside `L == 50.0 [kg]`, which may be one value; `L == 2.0 ^
3` beside `L == 8.0`), a side it reads no value of, and a side over a value
another such pair leaves undecided leave the pair's own row an info that says
why. A side that gives no value — it
reads a name nothing gives one, as a design equation `L == m * g` over a free
`m` does, or reads the feature back, as an alias's `b == a` read as a's
definition beside `a == 2.0` does — is left aside: every evaluator tries the
other first, in any order, and the model reads as before. A value
written with `=` (`L = 1.0`) is read whatever its asserts, which are checked
against it, in any order; so is one an asserted relation reads beside L (`M =
20.0` in `L >= 0.0 [kg] or M >= 0.0`), and an assert over it alone (`M <=
10.0`) is still the warning. Two asserted equations on the two
ends of a binding that reaches one end through a part (`bind p.L = M`, `L == 50.0`
in p's type and `M == 60.0` in the element) are one feature's two values too: the
binding makes q's p's L and q's M one quantity, and they read as the pair above,
so every row over either is *could not be evaluated*. The pair is read where the
binding meets it, which leaves p's type's L undecided in every use of that type
(a `part p2 : P` beside it too): a price of reading it so. `K == L`, a bare name on
each side beside such an L, ties K to it like `K == L + 0.0` or `bind K = L`, so K's
FMI `start`, its measure of effectiveness and a check over it read neither value,
in either order of the equations. Limits of this tool: the SMT engine holds one symbol for a feature across the usages of
one definition, so two usages that each assert one end of a binding the
definition writes (`bind L = K` in P, `part a : P { assert constraint ea { L ==
50.0 } }`, `part b : P { assert constraint eb { K == 60.0 } }`) read *inconsistent
axioms* on its rows though neither instance contradicts itself — the literal
engine decides those rows, and the numeric surface does not judge them (*the
solve did not converge*).


A value P derives from what p changes (`attribute e = m * 2.0;`, `e = 10.0 -
part1.m`, a calculation's body, an asserted equation, a value read through
another part's redefinition) is **p's own value**: P's expression evaluated
over p's names, on every surface — `p.e` is 40 kg where P's own `e` is 37 kg.
A redefinition that states nothing (`attribute :>> e;`, or the copy a `bind w
= p.e` makes) reads it the same way, in p. P's constraints and asserts hold in
`p` too: each is read again in every context that changes what it reads, as
rows named `P::c in R::p`, beside P's own verdict, on every surface — the
numeric surface and `solveFeasible` included.

Every instance has its own values. Two parts of one type, `g1 : G` and `g2 :
G`, are two values of G's `g`: the verification lane reads them by symbols of
their own (`R::g1::g`, `R::g2::g` — and `R::q1::p::x` for an instance reached
through two usages), the solver solves each by itself, and nothing one of them
states fixes the other — `g1.g == g2.g` is not proved of two values nothing
relates. What G states holds of each instance: its value expressions, its
asserts and its bindings are filed again for every instance a relation reads,
as rows named `G::c in R::g1` — and so is what the types of every instance
ENCLOSING it state: `s.q.load`, over `part s : Sys` whose Sys binds `p.load =
q.load`, holds Sys's binding as well as P's asserts. A usage whose own
redefinition a relation reads is held to the bindings of its types, and of
the instances around it, too: `p4.load` over p4's `:>> load = 7.0 [kg]` beside
the package's `bind P::load = L` (L 50 kg), or `r2.q.p.load` over r2's q's p's
`:>> load = 3.0` beside R's q's `bind p.load = L` (r2's L 50) — the model then
states two values, which the SMT engine reports as inconsistent axioms, where the
other surfaces read neither. A value the same in every
instance — a literal, or arithmetic over literals the instance changes nothing
of — keeps the feature's own name. A verify row prints a path read through
an instance at that instance's value (`bindings`, and the evidence record's
`witness`): `q.m2` is −40 where Q's own `m2` is 9; a value a binding carries into the instance
prints in the unit the feature it fills declares (5000 g into a kg feature is `5 [SI::kg]`), and no value
stands where the reading finds none there (an expression with a unit literal) or where the row abstains. A requirement's subject
that nothing binds, read in the requirement itself, is the generic instance
of its type (the requirement is about any one); reached through a usage
(`r1.s`, `sys.ra.s`, a nested requirement's `r2.t`) it is that usage's own,
and a subject that says something of its own (`subject s : P { assert
constraint … }`) is an instance of its own. `--free` and `bounds --measure`
take an instance's symbol, or its dotted path.

A name the element it is written in does not declare is read as KerML resolves
it there: through the namespaces that own that element, nearest first. `part def
A { attribute x = K; }` in `package Lex { attribute K = 7.0; … }` reads Lex's K,
on every surface — also beside one feature nested below the element reading it
that is the only one of that name (A's `part p : P` with P's own `K`). A bare
name is read as such a nested feature only where KerML resolves it to nothing
where it is written; one it resolves — to an owner's member, or through an import
or an alias, read or not — never is. Only an attribute is read through the
owners, and only by its bare name: a qualified `Lex::K` or a dotted name is
not. A body is read as it is written, wherever it is read: A's `x = K`, read for
`part def H { attribute K = 70.0; part a : A; }`'s a, reads no K where A sees
none, nor where an import or an alias answers the name first (`import
Consts::*;`, `alias K for Consts::K;` — such a name is not read). Where something
that specialises the element reading it declares a K of its own (`part q : Q {
part :>> p { attribute L = 50.0; } }` beside Q's p `:>> load = L`), the body
keeps KerML's reading in the element (Q's p reads Q's L), and the specialiser,
which one reading cannot give the name both meanings, reads it nowhere: a row
through q's p's load is *could not be evaluated*, in a sentence naming the
body and both features. A
package's attribute is one value wherever it is read, a `default` too. An
attribute of an enclosing definition or usage is read where it is declared only
where it is one value in every instance of that owner: nothing that specialises
the owner declares the name anew, no binding joins it, and what its value reads
is such a value too (R's `y = 3.0` read by its nested `part def Q { attribute z
= y + K; }`). A `default` an `assert` names is such a value, as one written
with `=`, and the assert is checked against it (above): `part def Battery {
attribute mass default = 1.2; part cells { assert constraint { mass == 0.8 } }
}` reports the assert violated, and so does P's `L == 50.0` over the package's
`L default = 1.0`. Elsewhere a row that reads it
is *could not be evaluated*, in a sentence naming the element that changes it —
Q's p `:>> load = L` beside `part q : Q { attribute :>> L = 50.0; }` reads
neither Q's 1 nor q's 50, for Q's own p or for q's. An asserted equation over a
`default` reads such a name on its other side as any relation does, and is
checked against the default, which it does not replace: `part p : P { assert
constraint { x == L } }` beside the package's `L = 50.0` is reported violated
against P's x, and so is Q's `assert constraint { p.x == L }`.

A requirement is read where its subject is bound. `satisfy R by p` and
`requirement r : R { subject s = p; }` read R's clauses at p — `s.m` is p's
`m` — as rows named `R::c in R::p` (or `in R::r`), each goal under its own
assumptions, beside R's own reading at the subject's type, wherever p reads
them otherwise: a value of its own, or an instance that holds more than R's
subject does — an assert or value of p's own, a narrower type, an instance
enclosing it (`satisfy R by q1.p` is q1's p), a relation of the model that
reads it. A satisfier that holds exactly what the subject holds reads R as the
subject does, and adds no row. `refine` reads a component's contract at the
part that satisfies it.

The status column says what is **stored**, never what is true. `open` means
nothing has been shown yet; `no formal clause` means the requirement states no
`require` or `assume` clause — prose, as a rule; `not encodable` means a gate
refused the relation and names which. An `assert constraint` written in a
requirement, or in the definition it is typed by (`requirement def R { subject
s : P; assert constraint ca { s.L == 50.0 } }`), is no clause of it: it is a
fact of the model, an axiom row the check judges — reported violated where it
is false, against `s.L`'s default too — and the SMT engine asserts. A usage
typed by a definition whose only body is such an assert (`requirement r : R {
subject s = x; }`) is `no formal clause`, and its sentence names the assert
rather than calling the requirement prose (*the requirement states no `require`
or `assume` clause, so there is nothing to encode — its asserted `s.L == 50.0`
(…::R::ca) is a fact of the model …*). The definition itself, and a requirement
whose own body is only such an assert, file no requirement row at all: the
assert is an axiom and nothing more, and `contracts` lists each of them as *no
formal clause: prose only*. A relation over the value the assert contradicts is
decided by neither engine of `verify` (see *A `default` stands against every
assertion*, above). `discharged` and `stale` are read back from an evidence record, so
nothing is ever discharged here today.

A `requirement massOk : MassLimit;` usage owns no clause of its own — the
`require constraint` is on the definition it applies. `contracts` says so on the
usage's row and files the clause once, on the definition; it is not counted as
prose-only, and it does not appear under `--missing`.

A requirement that specialises another and writes a clause **as well** is the
other half of that shape, and it is the one where a reader can be shown less
than applies. `requirement def StrictMassLimit :> MassLimit { require constraint
{ v.topSpeed <= 60 [m/s] } }` promises what it wrote *and* what `MassLimit`
wrote, so the row lists both and marks the second:

```console
$ npm run sysprose -- contracts spec-inherit.sysml
  ...
  SpecInherit::StrictMassLimit  [RequirementDefinition]
    subject v : Vehicle (inherited)
    require v.topSpeed <= 60 [m/s]  [QF_LRA — linear real arithmetic]
    2 guarantee(s): 1 declared, 1 inherited from SpecInherit::MassLimit
    require v.mass <= 1500 [kg]  [QF_LRA — linear real arithmetic] (inherited)
    no satisfy, verify, derive or refine statement names it
    variables declared v.topSpeed (parameter)
  ...
```

The `(inherited)` is the same word the `subject` line has always carried, and it
is a **disclosure, not a filing**: the inherited clause is still filed once, on
the element whose body holds it, so the worklist, the obligation digests and the
evidence keys are exactly what they were. The element **named** on the count
line is the one that wrote the clauses of that role — down a chain of three, an
inherited `assume` and an inherited `require` come from two different places and
each line says its own. `variables` reads `variables declared` on such a row for
the same reason: that list is the encoder's input and it holds what this
requirement wrote, not what the clause above it reads.

Only a clause some contract in the same report **files** is disclosed. A general
type the report left out — a `#prose` statement, or a case clause written
outside an `objective` — has no row of its own, so its body is shown on nobody
else's either. A case that specialises another **does** disclose the parent's
`objective` clauses, because that is where a case's clauses are filed.

`contracts --json` carries the census beside the inventory — `clauseInheritance`
counts the contracts that inherit a clause, split by whether the author wrote
`:>` (`Subclassification`) or `:` (`FeatureTyping`), plus how many distinct
inherited clauses are anonymous and how many named ones a nearer **clause**
masks. Every example this repository ships, and every model in its test corpus,
reads zero on all four.

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

### Writing a clause the tool will accept

Between the prose and the proof there is a step nothing above helps with: a
requirement that says *"shall sustain at least 45 minutes"* has to become a
relation a solver can read. Two subcommands stand there, and both of them ship
**before** the clause reaches `verify`.

`property-draft --element R` hands you what you need to write one. The three
FRETish fields that are mandatory (`component`, `shall`, `response`) filled in
from the model; the three that are not (`scope`, `condition`, `timing`) printed
as commented guidance with the reason each is unencodable; a **data dictionary**
of every legal name in the subject's scope with its type, unit, dimension, value
and whether it can stand in an arithmetic comparison; every `#prompt` that
reaches the requirement or its subject, verbatim; a skeleton whose six fields are
comments and whose last line carries `<bound>` for you to replace; and example
clause shapes built from the dictionary, each of which passes the gates below as
written.

```console
$ npm run sysprose -- property-draft examples/uav-isr.sysml --element MassRequirement
examples/uav-isr.sysml: UAVSurveillanceSystem::MassRequirement — the encodable skeleton
  subject   uav : AirVehicle (declared)
  ...
  data dictionary — 19 legal name(s), always written through the subject
    uav.cruisePower                       ISQ::PowerValue  [W]  dim L²·M·T⁻³  claim literal  = 650.0
    uav.endurance                         ISQ::DurationValue  (no unit of its own)  dim T  claim consistent  = battery.capacity * usableEnergyFraction / cruisePower
    uav.mtow                              ISQ::MassValue  [kg]  dim M  claim literal  = 18.5
    ...
  meaning is not checked; read the back-translation.
```

Every name in that dictionary is written **through the subject** — `uav.mtow`,
never a bare `mtow`. That is not decoration: the shipped example has two features
called `mass`, a bare name resolves to whichever the scope walk reached first,
and you would have no way to see which one you got.

`property-check --element R --clause TEXT` then judges the clause you wrote, at
**gate 0 and four gates after it**, and refuses at the first one that says no:

| Gate | What it asks | Refusal |
|---|---|---|
| **0** | Is the clause in the encodable fragment? | a `scope` other than `global`, a `condition`, or a `timing` other than `always` is temporal — `verification/temporal-field-unencodable` |
| **1** | Does it parse? | `verification/unsupported-expression` |
| **2** | Does every name resolve in the subject's scope? | `verification/unresolved-name-in-property`, with the nearest names it could find |
| **3** | Do the dimensions agree? | `verification/dimension-clash-in-property` |
| **4** | Is it non-trivial *on its own*? | `verification/trivial-property` — or `verification/nontriviality-unchecked` when there is no solver |

Gate 0 **refuses**; it does not accept with a gap. A clause carrying a temporal
field is one nothing downstream can decide, and "accepted, but the temporal part
was ignored" would put an undecidable clause in your file with a tick beside it.
The fields are written ahead of the body and separated from it by `;`, in either
spelling — `scope: after; uav.mtow <= 25.0 [kg]` or `scope = after; …`. The first
is what `property-draft`'s skeleton emits, so handing that skeleton back with its
`// ` markers removed reaches gate 0 rather than being refused as arithmetic.

```console
$ npm run sysprose -- property-check examples/uav-isr.sysml \
    --element EnduranceRequirement --clause 'endurance >= 45 [min]'
examples/uav-isr.sysml: UAVSurveillanceSystem::EnduranceRequirement — refused at gate 2
  ...
  refused at gate 2: `endurance` does not resolve in the scope of `uav` — did you mean `uav.endurance`? ...
```

An accepted clause comes back with a **back-translation** into structured
English and the **insertion range** — the line and column inside the requirement
body where the clause goes, with the line already indented:

```console
$ npm run sysprose -- property-check examples/uav-isr.sysml \
    --element MassRequirement --clause 'uav.mtow <= 25.0 [kg]'
examples/uav-isr.sysml: UAVSurveillanceSystem::MassRequirement — accepted
  ...
  back-translation
    uav shall satisfy: uav.mtow is at most 25.0 kg
  where it goes
    line 138, column 1
            require constraint { uav.mtow <= 25.0 [kg] }
  meaning is not checked; read the back-translation.
```

The range is zero-width and the indentation is copied from the body, so applying
it is a splice and nothing is overwritten. Three shapes are worth knowing about.
A requirement written entirely on **one line** has no body line to insert before,
so the range points just inside its closing brace and the indent is a single
space. A requirement usage with **no body at all**
(`requirement massReq : MassReq;`) has nowhere inside it for a clause to live, so
there is no range and the report says which of those it is rather than guessing.
And on a **case**, the range points inside `objective { … }` — that is where a
case's clauses are read from, and a clause outside it would parse and bind
nothing.

Three things to take from that, and the last one matters most:

- **Neither subcommand judges the model**, so both obey the reporting exit
  contract: a refused clause is an answer about a string you passed, not a
  finding about your file, and it exits **0** with the verdict in the report
  (and in `--json`, under `outcome`, `refusedAt` and `code`). **2** is a usage
  error — a missing `--clause`, a `REF` that names no requirement.
- **Gate 4 is *syntactic* non-triviality.** The clause and its negation are
  checked satisfiable with **no axioms asserted at all**, so
  `uav.mtow <= 25.0 [kg]` is accepted over a model that pins `mtow = 18.5 [kg]`.
  It is true of the design as written and the gate does not care: what it refuses
  is a clause that is valid or unsatisfiable *on its own*. `verify`'s tautology
  check and the vacuity report are what decide the other question, and the limit
  is printed on every report.
- **The tool never says the clause means what the prose meant.** Every report
  ends with *"meaning is not checked; read the back-translation."* — which is
  what the back-translation is printed for. Reading it is the one step nothing
  here can do for you.

Nothing is written back: `property-check` tells you where the clause goes and you
(or your agent) put it there, then `npm run check` and the ordinary repair loop
apply. `examples/contract-authoring-prompts.sysml` is a shipped model that writes
the four authoring rules as `#prompt` statements at package level, so
`property-draft` hands them to whoever works on any requirement in it.

**Source of truth:** `src/api/property.ts`, `examples/contract-authoring-prompts.sysml`,
`test/unit/property.test.ts`, and §3.3 of
[`04-formal-verification-plan.md`](04-formal-verification-plan.md).

### Whether it holds, and the two words that are not the same

`verify` is the one subcommand that reaches a **verdict**, and it is the one
whose exit code you should read before anything else. It has its own exit-code
contract, and it is not the other two: **0** every obligation discharged **and
there was at least one to discharge**, **1** at least one obligation
**refuted**, **2** usage, I/O, a degraded model, a model that states no
obligation at all, or **any** inconclusive. On a degraded model the text report
still prints its verdict lines, so it opens with a `degraded` line: they were
read over what parsed, and none of them is a verdict on the model.

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
its `role` so a computed value is never mistaken for one you could edit. Where
the unit-aware reading made no comparison, there is no pair: a bare number beside a
quantity (`load <= 10.0` over a `load` written `5000.0 [g]`) is read in the
feature's declared unit, as 5000 g against 10 g, and the verdict says only
that it is false there — a pair printed for it would have read 5 kg against 10
kg.

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

**Every claim this lane can make, and what each one costs you.** A *claim* is
the word in the evidence record; a *verdict* is the three-valued facet written
back into the file, and only two claims are allowed to move it (`proved` ⇒
`pass`, `refuted` ⇒ `fail`). The exit code is the run's, not the row's: the
strongest row wins, in the order refuted → design-admitted → undecided.

| Claim | Which engine can reach it | The exact condition | The run's exit code |
|---|---|---|---|
| `proved` | `smt` only, and it is the only claim `smt` counts as a discharge | `A ∧ P ∧ ¬G` is **unsat** — over an axiom set itself checked satisfiable, with the assumptions satisfiable, inside the timeout, with no freed feature left unbounded | **0** when every row is discharged |
| `holds-at-values` | `literal` only, and `literal` can reach nothing stronger | The relation evaluates true with every feature at the value your model binds it to — one point of an infinite space, and one no contradiction of the model's reaches through a value the relation reads: no `assert` the model holds false there, nor two asserted equations `check` reports giving one feature two values | **0** under `--engine literal`, because you asked for a point evaluation by name; it is **not** a discharge under `smt` or `auto` |
| `refuted` | both | `literal`: false at your values, where no such contradiction reaches a value the relation reads. `smt`: `A ∧ P ∧ ¬G` **sat**, with the witness re-confirmed through this tool's own evaluator before you see it | **1** — and `--allow-inconclusive` does not reach it |
| `design-admitted` | `smt` | A refutation reached only **after** `--free` released a value your model states, so it is a design your model admits rather than a violation of it | **2**, never 1 |
| `vacuous` | both | `literal`: the `assume` clause is false at your values (`verification/vacuous-pass`). `smt`: `A ∧ P` is unsat, so nothing at all satisfies the premises (`verification/vacuous`) | **2**, with `--strict-vacuity` and without it — the flag changes the code and the severity and nothing else |
| `inconclusive` | both | Everything else, each row carrying the `verification/*` code that says which — timeout, unsupported construct, unbounded free variable, inconsistent axioms (on the literal engine: a relation over a value an `assert` false at your values, a `bind` the check reports violated, or two asserted equations that give one feature two values, contradicts), unconfirmed witness, absent tool | **2**, unless the code is `verification/timeout` or `verification/unsupported-construct` **and** you passed `--allow-inconclusive`, which lowers those two and only those two |
| `holds-structurally`, `holds-within-bound` | none in this build | Declared in the evidence vocabulary and in `schemas/evidence-record.schema.json`, reserved for a structural argument and for a bounded walk. **No engine here writes either**, so a record carrying one did not come from this build | — |

Two readings that table is defending. `holds-at-values` discharging a run is
not a proof being rebranded: it is the reader naming a point evaluation on the
command line and getting exactly that, which is why the same file is exit 2 the
moment the engine is `auto`. And an empty run is exit **2**, not 0 — a model
that states no obligation has not been shown anything, and a build that went
green because every requirement was deleted is the failure this lane exists to
prevent.

**What `proved` stands on.** The engine asks four questions per obligation, and
each of the last three exists to stop a proof that would be void rather than
absent:

```console
$ npm run sysprose -- verify examples/uav-isr.sysml --engine smt
examples/uav-isr.sysml: 0 inconclusive, 2 discharged, 0 refuted — engine smt
  negation-unsat under a satisfiable axiom set — `proved` means exactly that, at 5000 ms per check, with every feature value bound as the model states it
  UAVSurveillanceSystem::EnduranceRequirement  uav.endurance >= 45.0 [min]
    proved: A ∧ P ∧ ¬G unsat, QF_NRA, 4 fixed / 0 free, timeout 5000 ms; assumptions satisfiable
    bound: every feature at the value the model binds it to; 4 symbol(s), 0 free; compared as 2835.69… vs 2700 in T, coherent SI; decided by z3 5.3.1, seed 0
  ...
$ echo $?
0
```

- **Is the model's own axiom set satisfiable?** Asked once per run. If your file
  contradicts itself, *every* negation is unsat and every obligation would print
  as proved — so instead every row is `verification/inconsistent-axioms` with
  the colliding facts named, and nothing is decided. Every row of the *file*:
  the axiom set is one, so a contradiction in one package makes a relation in
  another, which reads nothing the contradiction touches, `inconsistent-axioms`
  too. A contradiction through a relation a gate refuses (`%`) leaves the axiom
  set this step encodes satisfiable, and is reported only on the rows whose
  proof context holds that relation. `--engine literal` narrows it to the
  relations over a value the contradiction reaches (above).
- **Is the negation unsatisfiable?** Unsat ⇒ the obligation holds everywhere
  your axioms and assumptions allow. Sat ⇒ a counterexample, which is checked
  before it is printed (below).
- **Can the assumptions all hold at once?** If not, the obligation was
  discharged for free: `verification/vacuous`, exit 2, never a pass.
- **Is the goal true of *every* model?** `panel.area == panel.area` is honestly
  proved and honestly useless, so it is proved **and flagged as a tautology**.

**A counterexample is re-checked before you see it.** Every witness the solver
returns is substituted back through this tool's own evaluator — over the exact
rationals the solver answered with — and with nothing freed it must also read
as *violated* on the numeric surface — a second, independent path. A witness
that fails either gate is reported as `inconclusive: witness not confirmed`,
never as a violation. That is what catches an encoder defect in the direction
that matters.

**Numbers are the decimals you wrote, on every surface.** `0.1 + 0.2 == 0.3`
holds and `0.1 + 0.2 > 0.3` does not — on the Problems panel, the numeric
surface, `verify --engine literal` and `--engine smt`, `consistency`, `bounds`
and `refine` alike. A strict bound is violated at its boundary (`mass < 18.5
[kg]` at 18.5 kg is refuted, exit 1, by both engines), and `1.0 +
0.00000000000000001 > 1.0` is true, although binary64 rounds that sum to
`1.0`. The point evaluators compute in binary64, but they decide every
comparison by exact arithmetic over the decimals written — unit factors
included — wherever it can be computed. Where it cannot (an operand computed
by a fractional power), two sides within a relative 1e-9 of each other are
*undecided*: `not-evaluable`, never forgiven, and never either verdict. Two
readings are binary64 by definition: a numeral written with more than 15
significant digits is the double it parses to, and a unit factor that is no
decimal (the hartley and the nat, whose factors are logarithms) is the double
the registry holds. A value only a numeric solve produced is read at the
solve's own tolerance: within it `==`, `<=` and `>=` hold, and a strict
ordering or a `!=` is undecided — the solve does not know which side of the
bound its value lies on.

**Nonlinear and implicit values abstain, by design.** A constraint whose value
is nonlinear (`x * x == -1.0`) or implicit (fixed only by an inequality, or by a
product of unknowns) reads `?` on every surface; the solver's own binary64 value
is never read in its place, because every verdict above rests on the decimals
you wrote. This is the standing rule, not a gap waiting for a nonlinear solve.

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

**`--why` names the axioms the solver's own answer stood on — and says what
that is not.** When z3 answers `unsat` it can hand back an *unsat core*: the
subset of the labelled assertions that is enough, on its own, for the
contradiction. `verify --engine smt --why` prints that set under each `proved`
row, member by member, with the kind each one was asserted under:

```console
$ npm run sysprose -- verify examples/uav-isr.sysml --engine smt --why
  UAVSurveillanceSystem::EnduranceRequirement  uav.endurance >= 45.0 [min]
    proved: A ∧ P ∧ ¬G unsat, QF_NRA, 4 fixed / 0 free, timeout 5000 ms; assumptions satisfiable
    why: the core names 4 of this model’s 12 axiom(s), 1 side condition(s) and the goal — 6 label(s) in all
      axiom UAVSurveillanceSystem::AirVehicle::cruisePower
      axiom UAVSurveillanceSystem::AirVehicle::endurance
      axiom UAVSurveillanceSystem::AirVehicle::usableEnergyFraction
      axiom UAVSurveillanceSystem::BatteryPack::capacity
      goal UAVSurveillanceSystem::EnduranceRequirement::«ConstraintUsage»
      side UAVSurveillanceSystem::AirVehicle::endurance — a non-zero divisor or base the ENCODING asserts, not a fact the model states
    the set z3 returned is sufficient, not minimal: an axiom listed here may not have been needed, and an axiom NOT listed may still carry the claim
```

**Read that last line before you read the list.** A core is *a* sufficient
reason, picked by the solver — not the set of facts your requirement depends on.
Give a model three ways to settle one requirement and it will name one of them:
with `mtow = 18.5 [kg]` capped at both 20 and 22, the core for `mtow <= 25.0
[kg]` names the **22** — the weakest of the three — and never mentions the value
your file actually binds. Deleting an axiom that is not in the core can therefore
break the proof, and that is why this tool will not print "the axioms this proof
depends on" over a core, and why `minimal` is a word only `consistency
--minimize` earns: that one runs a deletion loop, and this runs none.

The `side` member is worth knowing about. Where a relation divides by something
your model can vary, the encoding asserts the divisor is non-zero — an
assumption *it* added, not a fact you wrote — and labels it with the name of the
row it guards. So the same qualified name can appear twice in one core, once as
an axiom and once as a side condition, and both are real.

`--why` decides nothing: the claim, the code and the exit status are identical
with the flag and without it, and nothing it prints reaches the evidence record.
Only a `proved` row's core is published here — a point evaluation asks no solver
anything — and a run that reached no proof says so rather than printing nothing.
Two other cores are printed by this tool and neither is one of these: the one
under `verification/inconsistent-axioms` is about the whole file's axiom set, and
the one under `verification/vacuous` is about that obligation's premises. Both
appear inside the sentence that reports them, because they answer other
questions.

With `--json`, each obligation carries the core itself — on every run, with the
flag and without it, since the flag gates the display and not the field — plus an
axiom census: `modelAxioms` (every axiom row this run gathered, whether the
encoder took it or refused it), `footprintAxioms` (the rows this obligation's
read-closure kept, refused ones included, so a kept row can assert nothing),
`scriptAxioms` (what those rows actually asserted, side conditions included) and
`coreAxioms`. Read `coreAxioms` against `footprintAxioms`: that is the pair that
says how far the solver's answer narrowed the read-closure the encoder already
applies. The two other numbers do not bracket each other — `scriptAxioms` is 5
against a footprint of 4 on the endurance obligation above, where an axiom
divides by a variable and the encoding asserts the divisor as well, and it is 1
against a footprint of 2 on a model whose read-closure kept an axiom the encoder
refused. And nothing in the payload repeats the sufficiency sentence: a consumer
that renders these members carries it itself.

**What is inconclusive, and what a flag may forgive.**

| The row says | What happened | `--allow-inconclusive`? |
|---|---|---|
| `verification/unsupported-construct` | The relation is well formed and its **shape** is outside the fragment this lane encodes — `%`, a variable exponent, a collection, arithmetic on °C — or the requirement states no `require` or `assume` clause (prose, or only an `assert`, which the row names as a fact of the model) | **Yes** — lowered to exit 0 |
| `verification/timeout` | The solver ran out of time — raise it with `--timeout MS` | **Yes** |
| `verification/not-evaluable` | Your values do not determine the answer, **or nobody could read the relation at all** — it names a feature that does not exist, compares kilograms against metres, does not parse, or produced a witness this tool could not confirm — or it reads a value that a binding, a value or an asserted equation carries and this tool does not read through (`unread-binding`: a limit of this tool, the relation is well formed), or it reads a value this tool does not read where the model states it (`unread-definition`: a limit of this tool too, closed in that sentence — a per-instance reading it cannot enumerate, a definition written in another context, a body whose names its own parameters shadow (its sentence says the body is over a parameter of its own, which may state no value), a parameterised calculation, more instance rows than a run reads; a reading that failed inside the tool says so) | No |
| `verification/vacuous-pass` | The `assume` clause is **false** here, so the requirement is discharged by something that does not hold | No |
| `verification/vacuous` | The solver found the assumptions unsatisfiable — nothing at all can satisfy them | No |
| `verification/vacuous-property` | Either vacuity, raised to an **error** because you passed `--strict-vacuity`. Same exit code | No |
| `verification/inconsistent-axioms` | Your model's own facts collide, so nothing can be proved from them — on every SMT row of the file (only on the rows whose context holds the colliding relation, where a gate refuses it); on the literal engine, on a relation over a value an `assert` false at your values, or a `bind` the check reports violated, contradicts, the assert or the binding named | No |
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
witness (your own values), the flags that changed what was shown (an `smt` record's
`flags.solver` carries z3's full build string, commit included, which the
verdict lines shorten to `z3 5.3.1`), and two
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
satisfy), but a set satisfiable without them might be excluded by the very
relation that was refused — so a set that **reaches** one (its own clause, or a
refused fact sharing a feature with it) is `inconclusive`, not consistent:
`verification/unsupported-construct`, which `--allow-inconclusive` may forgive,
where every such relation is the set's own and outside the fragment (as
`verify` files it) and, under `--with-values`, none is false at the values (a
violation `verify` refutes), and `verification/not-evaluable` otherwise. A requirement that states no relation **at all**
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

### Whether the parts add up to the whole

`verify` and `consistency` are about requirements. `refine` is about an
**architecture**: given a contract on a system and a contract on each of its
parts, do the parts — together with the equalities your model actually states —
entail the whole? It is Cimatti's Theorem 1, and the two obligations it checks
are the ones that theorem names.

```console
$ npm run sysprose -- refine examples/uav-power-budget.sysml --via composition
examples/uav-power-budget.sysml: 0 not refined, 0 vacuous, 0 inconclusive, 1 refined — 1 decomposition(s) over 5 contract(s)
  obligations are Cimatti's Theorem 1 in normal form (`nf(C) = ¬A ∨ G`), preceded by the satisfiability precondition step (0): …
  γ, the connection assertion: 2 bind equalities, 1 item flow(s); 1 connection(s) NOT encoded — a connection is not an equality; bind the attributes if they are one quantity
  UAVPowerBudget::PowerBudget on `UAVPowerBudget::PowerSystem` — refined
    refines: 4 obligation(s) proved over 4 sub-contract(s), 2 bind equalities and 1 item flow(s); 1 connection(s) not encoded as equalities. 0 relations refused. …
      obligation (3)  proved
      obligation (4) UAVPowerBudget::ComputerDraw  proved
      …
$ echo $?
0
```

**A decomposition is read off `satisfy`, not guessed.** A contract belongs to a
part because your file says `satisfy R by sys.part;`. A contract whose part
*encloses* the parts other contracts are satisfied by is a **system** contract,
and those others are its **components** — with the nearest such enclosing part
winning, so a three-level tree decomposes level by level rather than flattening.
A file that states no such pair states no decomposition, and the run says so and
exits 2 rather than reporting that everything is fine.

*Encloses* means containment **and the part's own type**, because that is how a
SysML v2 file writes a tree. `satisfy CellCharge by Pack::cell` names a usage
whose owner is the part *definition* `Pack`, and no contract is satisfied by
`Pack` itself; `part pack : Pack` is what says where `cell` lives. Reading only
containment would drop those leaf contracts from every decomposition — silently,
with the run still exiting 0 over the level above them.
`test/fixtures/verification/models/refinement-three-level.sysml` pins both
levels.

**The two obligations, in normal form.** With `nf(C) = ¬A ∨ G`:

- **(3)** `⋀ nf(C′) ∧ γ ⊨ nf(C)` — the components, plus the connections, entail
  the system contract.
- **(4)** for each component *U*: `A ∧ ⋀_{S′≠U} nf(C′) ∧ γ ⊨ A_U` — every
  component assumption is discharged by its siblings and the wiring.

**Normal form is not a flourish.** With bare guarantees the check is *unsound*
under mutual support: take two components where each assumes exactly what the
other guarantees, against a system contract that promises the same thing. The
bare obligation `G₁ ∧ G₂ ⊨ G` is `p ∧ p ⊨ p` and passes — yet an implementation
in which `p` is false satisfies both component contracts and breaks the system
guarantee. In normal form each `nf(Cᵢ)` is `¬p ∨ p`, which is `⊤`, so the
obligation becomes `⊤ ⊨ p` and is **refuted**, with a witness. That is the case
`test/fixtures/verification/models/refinement-mutual-support.sysml` pins.

**Step (0) runs before every obligation.** `check(A ∧ ⋀ nf(C′) ∧ γ)`. Two sibling
contracts of `⟨true, x > 10⟩` and `⟨true, x < 5⟩` over one bind class make the
antecedent of obligation (3) unsatisfiable, so (3) holds *vacuously* — and
without step (0) the tool would print "obligation (3) proved" over an
architecture whose components cannot coexist and whose system guarantee is
absurd. It comes back `verification/contract-set-vacuous`, **never** `refined`,
exit 2, and no flag lowers it.

**γ is what your model states, and what this tool already computes with.** The
connection assertion is built from **`bind` / `BindingConnector` equalities** and
from the **item flows** value propagation already carries (`target = source`).
Those are exactly the edges `checkConstraints`, the app and every existing report
honour, so a proof here cannot rest on an equality the rest of the tool does not
believe — and an item flow that *does* carry a voltage is not left out, which is
how a downstream assumption ends up "not discharged" for no reason.

**A bare `connection` is not an equality.** It joins two features and states
nothing about their values, so it is listed under `notEncoded` with the hint
*bind the attributes if they are one quantity*, and it is counted on every
verdict line — counted per decomposition, so a group reports the wiring *it*
carries rather than the file's total. `--connections-as-equalities` opts into
the OCRA reading in which it *is* an equality, and it opts into that for
`connect` and nothing else: an `allocate` is a traceability mapping and an
interface joins ports through connections of its own, so both stay listed under
the flag, each with a hint naming what it is. When you use it, that fact is
printed on every verdict line, because it changes what the verdict claims.
Counter-evidence, recorded rather
than buried: the one published SysML v2 → OCRA translation maps `connect` and
`bind` alike, so the default here is a **stricter** reading than that path takes,
not a consensus.

```console
$ npm run sysprose -- refine rig.sysml
rig.sysml: 1 not refined, 0 vacuous, 0 inconclusive, 0 refined — 1 decomposition(s) over 3 contract(s)
  γ, the connection assertion: 0 bind equalities, 0 item flow(s); 1 connection(s) NOT encoded — …
      obligation (4) RefinementBareConnection::LoadDraw  refuted [verification/unconnected-assumption]
      witness: …::Load::supplyVoltage = 0, … (stored magnitudes)
$ echo $?
1
```

**Exit 1 means the same kind of thing here as everywhere else in this lane:** a
decided finding about your model. A refuted obligation is
`verification/refinement-failed`, or `verification/unconnected-assumption` when
the quantity the assumption is about is reached by no connection at all — the
second is a *wiring* problem and the first is a design one, which is why they are
two codes. Both are errors and no flag forgives one.

**`refine` publishes its own exit-code contract, not `verify`'s.** The two look
alike at 1 — both mean a decided negative about the model — but `verify`'s
paragraph is written in terms of *values*: "with every feature at its model
value", "a relation not evaluable at the model's values", "a refutation obtained
under `--free`". A refinement obligation reads no value and there is no `--free`
here, so quoting that paragraph under `refine` would publish three promises it
cannot keep. `refine --help` and the [command reference](CLI-REFERENCE.md) print
the contract this command actually implements: **0** every decomposition shown to
refine, **1** an obligation refuted with a confirmed counterexample, **2**
anything undecided — including a vacuity and a clause a gate refused.

**A clause the tool could not encode does not quietly shrink the question.** It
is listed with the gate that refused it, and where it sat decides what happens.
On the **system** contract any refused clause stands the whole decomposition down
as `verification/refinement-undecided`: `nf(C)` with a conjunct missing is a
weaker goal, and a weaker goal is easier to entail. On a **component** the two
halves of `nf(C′) = ¬A ∨ G` go opposite ways — a refused `require` conjunct only
weakens that component's normal form, which a proof survives, while a refused
`assume` conjunct *strengthens* it, and with every `assume` gone it collapses to
a bare `G`, the axiom "this component promises its guarantee unconditionally"
that your file never stated. So such a component is left out of the premise set
and its own obligation (4) is undecided. Neither direction is ever reported as a
refinement.

**Nothing here is about ordering or time.** This is the propositional and
numeric shape of contract refinement, not OCRA's temporal one, and every verdict
line says so. The tool never says "the architecture satisfies its requirements",
never says `refined` while an obligation is undecided, and never says `refined`
when the antecedent of (3) or (4) is unsatisfiable.

**A refinement obligation does not read the values in your file.** It is a claim
about *every* implementation the contracts admit, so `examples/uav-power-budget.sysml`
refines whether its design point draws 607 W or 6 W. That is the difference
between `refine` and `verify`, and it is why `--free` has no meaning here.

**`--via` names the family of edges, and there are three of them.**
`composition` is the question above. `derive` and `refine` ask the same question
of a *requirement* somebody wrote down from another requirement, and `all` runs
every family in one pass with each row naming the one it came from.

**A derivation is checked with the orientation your file actually stores.** The
two spellings store their ends the opposite way round, and this is the one place
where guessing would not fail loudly — it would check the mirror obligations and
report "refines" for a chain written the other way up:

- `derive requirement D from R;` puts **R on the source end**, so `R` is the
  parent and `D` is written down from it.
- `refine requirement X by Y;` puts **Y on the source end**, uniform with
  `satisfy`, so `X` is the parent and `Y` is the one doing the refining.

**The two obligations, over that orientation.** With `nf(C) = ¬A ∨ G` as before:

- `A_R ⊨ ⋀ A_D` — the derived set **assumes no more** than its parent. A child
  that assumes more applies in fewer situations than the parent's guarantee is
  claimed in, so discharging the children would leave that gap unproved.
- `A_R ∧ ⋀ nf(C_D) ⊨ G_R` — the children, in normal form, **entail what the
  parent promised**. Two children that each carry part of a budget conjoin to
  imply the whole of it; one of them alone does not.

```console
$ npm run sysprose -- refine derived.sysml --via derive
derived.sysml: 1 not refined, 0 vacuous, 0 inconclusive, 0 refined — 1 derivation chain(s) over 2 contract(s)
  a derivation chain is checked with the orientation the mapper stores: `derive requirement D from R` makes R the parent, …
  DerivationStrongerAssumption::MassBudget via derive — not-refined
    verification/derivation-not-refinement
      assumes no more: DerivationStrongerAssumption::BodyMass  refuted [verification/derivation-not-refinement]
      witness: DerivationStrongerAssumption::Vehicle::speed = 11 (stored magnitudes)
$ echo $?
1
```

A derivation group **names no part**, and the report says so rather than
borrowing one: a `derive` edge joins two requirements and states nothing about
who satisfies either of them — so a `--via derive` run prints no γ census
either, with or without a solver. Its failures file
`verification/derivation-not-refinement` rather than
`verification/refinement-failed`, because the fix is an edit to a requirement and
not to an architecture.

**An edge whose other end is not a requirement forms no chain, and is counted.**
`derive requirement Child from rig;` names a *part*, so there is no obligation
over two contracts to check. The run says how many such edges it found rather
than reporting "this model states no `derive` chain at all" about a file that
plainly writes one.

**A refused clause on a derived requirement is read by which half it came from.**
A dropped conjunct of its **guarantee** makes `nf(C_D)` weaker, and a weaker
premise is implied by the real one — so the child stays in the premise set and a
proof under it is still a proof. A dropped conjunct of its **`assume`**
strengthens `nf(C_D)` into an axiom the file does not state, so that child is
kept out, files its own undecided row, and the composition row over what is left
is never published as a **refutation**: the very clause that was dropped may
exclude the design point it found.

**Source of truth:** `src/semantics/refinement.ts`, `refinementReport` in
`src/api/verification.ts`, and the L8 cases in
`test/campaign/verification.test.ts`.

### The tightest value the model admits

`verify` asks whether a requirement holds; `bounds` asks a different question
with no verdict in it — *how far can this quantity actually go, given what my
model says?* It is z3's optimiser (νZ) over the model's **axioms**.

**Which clauses are axioms, and which are not.** The axiom set is exactly what
`obligations` files as `axiom`: **feature values**, **`bind` equalities** and
**`assert constraint` bodies**. A `require` clause is *not* one of them — a
requirement is what is being checked, not a fact about the design — and neither
is an `assume`, which is the guard a requirement applies under. That is why the
answer below is *unbounded above* on a file that plainly states a 25 kg limit:

```console
$ npm run sysprose -- bounds uav.sysml --measure uav.mtow --free all
uav.sysml: 0 not established, 1 decided — `BoundsUav::AirVehicle::mtow` over 2 assertion(s)
  the axiom set: feature values, `bind` equalities and `assert constraint` bodies; `require` and `assume` clauses excluded, because a requirement is what is being checked, not a fact
  max  unbounded
    max `BoundsUav::AirVehicle::mtow`: unbounded above — over 2 assertion(s) — …
$ echo $?
0
```

The exclusion is repeated on **every** verdict line rather than once in a
header, because a reader who scrolls to a row has been handed a claim they have
to be able to check. `--with-requirements` folds those bodies in — each as the
implication `assume ⇒ require` the shipped library says a requirement *is* — and
says so on the line:

```console
$ npm run sysprose -- bounds uav.sysml --measure uav.mtow --free all --with-requirements
  max `BoundsUav::AirVehicle::mtow` = 25 (coherent SI; the feature declares no unit) exactly (linear optimum, optimality established by z3's νZ) … PLUS the `require` bodies … (`--with-requirements`)
$ echo $?
0
```

The parenthesis is not noise. **The bound is reported in the magnitude the model
STORES, with the unit the feature declares beside it** — `payload` is `6 [kg]
(6 in coherent SI)` — and `mtow` declares no unit literal at all (its value is
the expression `emptyMass + payload`), so what it stores is coherent SI already
and the line says which of the two a reader is holding. A quantity whose unit
you want named on the row is one the file should declare a unit for.

**`--free` decides what may move.** With nothing released every value the file
states is an axiom, so the bound *is* the value in the file. Release a feature
and the bound ranges over it; `--free all` releases every value the file
**states** and keeps every equation that says how a quantity is **computed** —
the same rule `consistency` releases under, so the two commands cannot answer
over different design spaces.

**Exact, or honest about not being exact.** Four answers, and they are not the
same sentence:

| Answer | What it means |
|---|---|
| `optimum` | νZ established its optimality and a design attains it — the witness is printed |
| `supremum` / `infimum` | exact, and **never attained** (`x < 5` has no maximum) |
| `unbounded` | z3 proved there is no finite bound in that direction — over a **linear** script, the only shape νZ is complete for |
| `bound-without-optimality` | a bound z3 reached over a **nonlinear** script, which νZ does not certify — finite or `oo` alike |

The last one is `verification/optimality-not-established`, and it exits **2**. It
is deliberately not one of the two codes `--allow-inconclusive` lowers — and
`bounds` does not offer that flag at all — because presenting a non-optimal
bound as the optimum is the one sentence this command may never write.

**A refused axiom is a missing axiom, and the row says so instead of a number.**
A relation a gate could not encode was not asserted, and dropping one **widens**
the design space — so the bound over what is left is looser than the model's,
never tighter. When such a refusal shares a symbol with what the objective can
reach, the row is `verification/not-evaluable` at exit **2** rather than a
bound: a file whose only ceiling on a quantity is a relation the encoder refused
would otherwise read *unbounded above*. A refusal in an unrelated corner of the
file cannot move the answer and is listed rather than acted on — the same reach
test `verify` applies before it publishes a refutation.

**A measure a binding this tool does not read may carry is no bound either.**
The axioms state no equality for a binding or a value that equates two parts
where both say something of their own (`bind pp = top.a` beside pp's own `load
default = 3.0`), so a bound over them would be the measure's own value alone —
pp's 3, where the model makes pp's load top's a's 50. Such a measure, and one
read through either end — `top.a.load` too, which `--measure` resolves to T0's
own `load` where no relation reads top's a's — is `verification/not-evaluable`
at exit **2**, in a sentence that names the binding, before any solver runs. A measure read
through one it does read — a plain end, a part valued with another (`part pp
: T0 = top.a`), a reference in a definition read in an instance — is bounded
at what it stands for. Nor is a measure bounded where an instance's own binding
joins the path to a `default` and its type's asserted equation over that path is
not read there (Q's `p.x == 50.0` over q1's `bind p.x = K` and `K default =
9.0`, for `--measure q1.p.x`): the default stands, the assert holds in that
instance too, and this tool does not read it there, so the model may contradict
itself unreported — `verification/not-evaluable` at exit **2**, in a sentence
that names the assert.

**The point z3 stopped at is re-read before the number is published.** Every
design point this lane prints goes back through the tool's own evaluator first
(§5's witness gate), and `bounds` is the surface with the least redundancy
behind it — its answer *is* a number the encoder produced. A point this tool
cannot reproduce is `verification/not-evaluable`, never a bound.

**`bounds` publishes its own exit-code contract, and it has no 1.** Every other
judging subcommand spends its 1 on a decided negative about the model. A bound
is not one: **0** is every bound decided, **2** is anything undecided, and there
is no 1 to misread.

**Two optimisers, named so they are never read as one.** `bounds` reports a
bound z3 **proved**; the `optimize` function in `src/semantics/solver.ts` is a
coordinate descent with a golden-section line search that returns a point it
**found** and proves nothing. The report says which is which, and the L8 corpus
pins the direction of the difference: the heuristic never beats the proved bound.

**Source of truth:** `src/semantics/bounds.ts`, `boundsReport` in
`src/api/verification.ts`, and the L8 cases in
`test/campaign/verification.test.ts`.

### Which contract failures break the top requirement

`refine` asks whether the parts add up to the whole. `fault-tree` asks the same
question from the other side: **which combinations of contract failures would
break it?** A basic event is "sub-contract *i* not honoured", and a set of them
is a **cut set** when the refinement obligation fails with those guarantees
withdrawn. It is the same obligation (3) `refine --via composition` proves, over
the same normal form and the same γ — asked again with parts of the premise set
taken away.

**A decomposition that refines can still have a single point of failure.** That
is the whole reason this is a separate command, and the shipped power-budget
example is the demonstration: `refine` exits **0** on it, and

```console
$ npm run sysprose -- fault-tree examples/uav-power-budget.sysml
examples/uav-power-budget.sysml: 1 with a single point of failure, 1 with cut sets, 0 with none up to the bound, 0 vacuous, 0 not enumerated — 1 tree(s) over 5 contract(s)
  a basic event is "sub-contract not honoured", and a set of them is a CUT SET when obligation (3) — the same one `refine --via composition` proves — fails with those guarantees withdrawn
  UAVPowerBudget::PowerBudget on `UAVPowerBudget::PowerSystem` — cut-sets
    4 basic event(s); 4 minimal cut set(s) up to order 2: {BatterySupply}, {ComputerDraw}, {PropulsionDraw}, {RadioDraw}. there is a single point of failure … 6 check(s), all decided …
    order bound 2, from the default
      order 1  {BatterySupply}
        witness: …BatteryPack::availablePower = 0, …
$ echo $?
1
```

Four single points of failure in a decomposition whose obligations are all
proved. Each load's draw is bounded by **its own** guarantee and by nothing
else, so withdrawing any one of them frees a term of the sum the pack has to
cover. Redundancy is what changes that answer, and it shows up as an order-2
cut set: with two supplies bound to one bus, neither is a cut set alone and the
**pair** is — `{PrimaryOutput, BackupOutput}` in
`test/fixtures/verification/models/fault-tree-redundant.sysml`.

**Minimal, bounded, and counted.** Sets are enumerated by increasing order and
every superset of a cut set is pruned rather than checked — withdrawing more
guarantees cannot restore an obligation that already failed — so the list is
minimal. The enumeration costs the sum of C(n,k) solver checks and the report
prints the count. And the bound travels with the answer: **"no cut set up to
order 2 — higher orders not explored"** is the whole sentence, never the first
half of it.

**"Minimal" is withheld when a smaller set went undecided.** Pruning removes the
supersets of sets *shown* to be cut sets; it cannot remove the supersets of one
the solver did not answer about, because that smaller set may itself be the cut
set. Those supersets are still checked and still listed — each is a real cut
set, confirmed against a counterexample — but the row says *minimality not
established* and the head sentence drops the word. **And any undecided check
makes the run exit 2**, whatever else it found: the enumeration is incomplete,
and an undecided order-1 check is exactly the state a "no single point of
failure" sentence may never be written over. There is no `--allow-inconclusive`
here to lower it.

**`--max-order N`, and the same number written in the model.** The order bound
is the one part of this analysis that is an *assumption* — how many independent
failures you consider credible at once — rather than something the contracts
state. A carrier puts it where a reviewer sees it, and the flag overrides one:

```sysml
requirement def MissionPower {
    @SysproseVerification::FaultHypothesis { attribute maxOrder = 2; }
    subject sys : Avionics;
    require constraint { sys.bus.voltage >= 20.0 [V] }
}
```

Both spellings of the cell are read — `{ maxOrder = 2; }` and `{ attribute
maxOrder = 2; }`. A cell this tool cannot read as a whole number is never
guessed at, because inventing a bound would put a number nobody wrote onto every
absence the command prints; instead the run says the carrier is there and was
not read, and enumerates to the default.

The report says which of the four the number came from — `--max-order`, the
carrier, an unreadable carrier, or the default.

**A vacuous contract set is reported as vacuous, never as "no cut set".** If the
sub-contracts, the connections and the top requirement's assumption cannot hold
together, obligation (3) can never *fail*, so no fault set could ever be a cut
set. Enumerating over that would print this command's most reassuring sentence
about its least trustworthy model, so step (0) runs first and the row reads
`inconclusive: contract set vacuous` at exit **2**. Nothing lowers it.

**Nothing is claimed about a check that was not decided.** "No single point of
failure" is a statement about every order-1 check having been *decided*; a check
that timed out is not a component shown to be harmless. One undecided order-1
check and the report says so instead — and there is no `--allow-inconclusive`
here to forgive it.

**The two safety lanes stay apart.** A state machine passed as `--element` is
**measured, not enumerated**: the command counts what a behavioural fault tree
would need — failure-mode flags to inject and `#exceptional` states to aim at —
prints the two numbers, and exits 2 under the row that names *a state machine
whose failure modes this command found none of*:

```console
$ npm run sysprose -- fault-tree examples/uav-isr.sysml --element FlightModes
examples/uav-isr.sysml: `UAVSurveillanceSystem::FlightModes` is a state machine whose failure modes this command found none of: 0 failure-mode flag(s), 0 `#exceptional` state(s) — the behavioural lane has no fault variable to inject here
  nothing was enumerated and no absence is claimed: this command injects failures into the CONTRACTS a `satisfy` attaches to the parts of a system, and a state machine carries none — its failure modes would be flags its guards read, which no lane in this build injects, so this run is exit 2
  this is contract-level fault-tree analysis over the refinement obligations, not a behavioural safety analysis: it says which contract failures break the top requirement, and nothing about ordering, time, rates or probabilities
  model sha256:…
$ echo $?
2
```

An empty cut-set list over a machine would read as a behaviour with no failure
mode, which is the loudest false statement this command could make — so no list
is printed, and no absence is claimed. Under `--json` the payload also carries a
census over the whole file, `faultTree.behaviouralLane`
(`machines`, `machinesWithExceptionalStates`, `machinesWithFailureModeFlags`,
`hazardsUnreachableFromTheContractLane`): the measurement a behavioural fault
tree is held behind, and it reads **0** on every shipped example and every
verification fixture. A failure-mode flag is an attribute tagged with a
`FailureMode` metadata definition; the shipped vocabulary does not declare one
yet, so only a model that declares its own is counted — and a machine that
carries one is answered with the other tail of the same row, *whose failure
modes this command found and does not inject*: still exit 2, still no list. The
command measures exactly the machines `reach` walks: name a state *inside* a
machine (`--element FlightModes::standby`) and it is refused with the machine
named — *name the machine* — rather than measured over the state's own
descendants; name a `state def` whose states are joined only by successions
and it is refused as owning no transition, the same answer `reach` gives over
it, rather than counted as a machine the census did not. And every report says
what it is: **contract-level fault-tree analysis over the refinement
obligations** — nothing about ordering, time, rates or probabilities, and not a
behavioural safety analysis.

**Source of truth:** `src/semantics/fault-tree.ts`, `faultTreeReport` in
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

**A reading in a context or an instance is one of those obligations.** `satisfy
LoadReq by p1;` makes `verify` read `LoadReq` in `p1` as well as on its own row,
and `verify --record` writes that reading as a `sysprose-evidence/2` record naming
the requirement and the reading (`"instance": { "requirement": "H::LoadReq",
"reading": "H::p1" }`). The facet is the worst over the readings too, and so is the
verdict of a verification case that verifies the requirement: a requirement
refuted in one part makes the case `fail` in `verify`'s report, with or without
`--case` (which records the readings with the own row), and is written `fail` by
the record and by the case, on every attach. A requirement usage typed by the
definition (`requirement massR : LoadReq; satisfy massR by p1;`) owns none of the
definition's clauses, so the clause is read once, on `LoadReq`'s own row, and read
again at each satisfier; the reading at `p1` is written for the requirement the
`satisfy` names, `massR` (`"requirement": "H::massR"`, and the record's
`obligation.requirement` reads `H::massR in H::p1`), and `verify massR by VC`
judges it. The case over the definition keeps it too: `verify LoadReq by VC` is
still judged over the reading `satisfy massR by p1` refutes in `LoadReq`'s clause,
and `evidence-attach` writes that case's verdict the same way. The definition's
own `verdict` facet is the worst over its carriers and over the readings moved
onto the usages typed by it, so it stays `fail`, an attach of the same record again
reports no verdict change, and `evidence-status` and `evidence-detach` read it the
same way. A case that verifies both `LoadReq` and `massR` counts that reading
once. `verify`'s own report still prints the row as `H::LoadReq in H::p1`, and a
`satisfy LoadReq by p1` that names the definition (or a requirement definition that
specializes it) keeps the record on `LoadReq`; only a requirement usage takes it. A record from an
older build names a reading only as `<requirement> in <reading>`. `evidence-attach`
refuses the whole `--from` file, with exit 2 and nothing written, when a
`sysprose-evidence/2` record has an empty `instance.reading` or
`instance.requirement` (the schema requires at least one character). A record that
passes the schema is held to the same checks in both versions before anything is
written: the requirement must be a requirement of this model, the model must read
it in that reading, and (for a `sysprose-evidence/2` record) the facet and
`obligation.requirement` must say the same thing; a record that fails one is
skipped with the half that does not match named. A record written by an earlier
build for such a usage, `LoadReq in p1` in either version, is skipped, and the
reason names the usage that carries the reading now (the model files `LoadReq` in
`p1` on `H::massR`); running `verify --record` again writes it there.

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

**An SMT proof is not re-run for an edit it could not have read.** A record
written by `--engine smt` carries what its proof stood on: the axiom rows the
clause's read-closure reaches (its *footprint*), a digest over the whole axiom
set the consistency check ran over, a digest over the requirement's own
premises, and a digest over the clause itself — each of them over the relation
AND the scale it is read at, so relabelling a feature from `[Wh]` to `[J]` is an
edit the scope sees even though the expression tree is unchanged. `npm run
check` compares those rather than the whole model, so an edit that moves none of
them raises nothing. Measured on
`examples/uav-isr.sysml`: of nineteen single edits, eight — a declaration with
no value, a doc line, a state, an action, a part definition, a string facet, a
renamed connection, a prose requirement — move the whole-model digest and
nothing either proof reads, and the two records stay put. The other eleven are
reported, and the sentence says which part moved:

```console
budget.sysml:125:5: warning validation/stale-evidence  Evidence on UAVPowerBudget::ComputerDraw
was recorded over sha256:95da2919…; this model is sha256:aa014dc3…. The claim `proved` no longer
stands: stale — this proof's premises changed, so the satisfiable-assumptions check that
separated `proved` from `vacuous` was not the one that ran. Re-read this requirement's slice —
UAVPowerBudget::PowerSystem::flightComputer, UAVPowerBudget::PowerSystem::propulsion,
UAVPowerBudget::FlightController — then re-run `verify --record` and `evidence-attach`. The
comparison is scoped to what this proof stood on, so an edit elsewhere in the file is not
reported here.
```

**The parts are different ways a proof dies, and most of them do not look like
an edit to the proof.** An axiom in the footprint changing what it says is the
obvious one. A NEW axiom entering the footprint is the second — the proof never
mentioned it, and it is now part of the context the negation is unsatisfiable
under (or is not). The third is the axiom SET: `proved` means *the negation is
unsatisfiable under a satisfiable axiom set*, and that second conjunct is a
property of the whole file — one added `assert` can contradict another one and
void every proof in the model, including proofs whose footprint never touches
either. The fourth is the premises: the check that separates `proved` from
`vacuous` is a check on them, and it is in none of the first three — on
`examples/uav-power-budget.sysml`, raising one `assume constraint {
fc.supplyVoltage >= 20.0 [V] }` to `>= 200.0 [V]` moves no axiom, no footprint
member and no symbol, and takes the obligation from `proved` to `vacuous`. The
fifth is the clause itself: the first four are all about a proof's CONTEXT, and
tightening `uav.mtow <= 25.0 [kg]` to `<= 24.0 [kg]` moves none of them.

**Only three of them can change the answer, and the report says which.** The
axiom-set digest is taken over every axiom row in the file, and the footprint is
a subset of those same rows digested the same way — so a footprint digest cannot
move without the axiom-set digest moving too, and a member cannot enter or leave
the read-closure unless an axiom, a premise or the clause already moved. What
the footprint parts buy is the SENTENCE: they are how a finding can name the
axiom you have to re-read rather than telling you something in the file changed.
The narrowing itself comes from the edits that touch no axiom at all — eight of
the nineteen on `examples/uav-isr.sysml`.

**What is NOT recorded, and why.** The solver's unsat core — the axioms z3 named
as a sufficient reason, which `verify --why` prints — is not written into a
record. Its membership was measured to move with how warm the solver's context
is: the same model, one seed, six labels from a fresh process and five from a
worker that had already run many checks. A record is promised byte-identical
across two runs over an unchanged file, and a digest over a set chosen that way
could not honour it. The footprint is the encoder's own relevance walk over the
MODEL, is a function of the model alone, and is what the core is a subset of.

**A record with no scope keeps the whole-model comparison**, and says so in the
same words it always did: `--engine literal` writes no scope (a point evaluation
has no axiom set and no non-vacuity step to speak of), and neither does a record
written by a build older than this field.

**`evidence-status` answers the other question, on purpose.** It reports whether
a record was taken over THIS model — a fact about the file, which any edit moves
— while the checker reports whether the edit could have reached the proof. A
file where `evidence-status` says `stale` and `npm run check` says nothing is a
file where something moved and no proof in it could have read what moved.
`npm run check -- <file> --json` publishes the reading per record, inside the
report: `{scoped, matched, wholeModelMoved, footprintContentMoved,
footprintMembershipMoved, axiomSetMoved, premisesMoved, obligationMoved}` and
the sentence. `matched` is `false` where a record carries a scope but this model
states no obligation to recompute it against — the clause was deleted, or two
anonymous clauses share one qualified name — in which case the comparison falls
back to the whole model and the sentence says so. A scope that did not move reads *current within this proof's
scope*, never the bare word: the claim is scoped and the words are part of it.
Bare `current` appears only on a record that carries no scope, where it means
what it has always meant — the model still hashes to what the record names.

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

### Which states a machine can reach, and the choice a simulation hides

`reach` walks a state machine's configuration graph. It uses the same step
relation the simulator uses — the one `runStateMachine` runs — with one
difference that is the whole point: where the simulator fires the FIRST enabled
transition, this walks **every** enabled one. That is how it can say something a
simulation cannot.

```console
$ npm run sysprose -- reach examples/uav-isr.sysml
examples/uav-isr.sysml: 1 state machine(s), 1 walked to exhaustion; 4 configuration(s) explored
  a bounded walk of what the interpreter would do — every figure below holds under the bounds printed beside it
  UAVSurveillanceSystem::FlightModes [StateDefinition]
    4 configuration(s) explored, depth 3 — exhaustive under {maxConfigs 10000, maxDepth 200, maxCompletion 64, alphabet no named trigger, store seeded from declared literal values — a guard over an attribute with no declared value is undecided and takes no edge}
    4 of 4 state(s) reachable; 5 of 5 transition(s) fired, 0 dead
    livelock     {manual, autonomous} — the chase goes round 2 configuration(s) on trigger-less transitions and the run ends where the budget stops it (no trigger is named); entered in 1 step(s) from standby
    choice       UAVSurveillanceSystem::FlightModes::autonomous: 2 enabled as completion transitions (no trigger); the simulator takes autonomous -> manual, never autonomous -> failsafe
  semantic profile (the reading every figure above holds under):
    ...
  verification/completion-livelock  `UAVSurveillanceSystem::FlightModes`: completion livelock — the interpreter's chase goes round {manual, autonomous} without coming to rest: …
  verification/nondeterministic-choice  `…::autonomous`: 2 transitions are enabled at once …
```

**The finding on this machine is not the count.** `FlightModes` declares four
states and five transitions and every one of the five is trigger-less, so the
machine runs on completion alone — and `autonomous` has two of them enabled at
once. Declaration order decides which one a simulation takes, so `failsafe` is
never entered in simulation while the model plainly admits it. That is
`verification/nondeterministic-choice`, and it is the row worth reading. Note
what the line does NOT contain: a trigger name. The machine names none, and a
report that printed one would have invented it.

**What the count line counts.** `N of M transition(s) fired` counts the
transitions a step of some explored run takes; `dead` counts the ones enabled at
no configuration a run reaches. The two need not add up to `M`: a transition
that is enabled where no run takes it is neither. That is one an inner
transition beats wherever it is enabled (priority: innermost substate first), or
a trigger-less one due only where the 64-step chase budget stops a chase. On a
machine that takes one event and then a chain of 69 trigger-less steps, the
chase after the event takes 64 of them and stops at the 65th state of the chain,
whose step out is enabled and never taken: `reach` prints `65 of 70
transition(s) fired, 4 dead, 1 enabled and never fired` — the event and the 64
steps fired, the four steps after the one never taken dead, and that one
neither. The line names the gap only where there is one, and a `never fired`
row under the `dead` rows names each transition in it (`t65 (c65 -> c66) —
enabled where a run reaches, and taken by no run: …`); the row has no code,
since a step the budget or the priority rule keeps a run from taking is the
interpreter doing what the profile says, not a defect. Both are withheld with
the `dead` rows, over a walk that did not finish. `--json` carries the same
count as `transitions.fired`, and the transitions in the gap as
`transitions.enabledNeverFired`.

**Every figure carries the reading it holds under.** The semantic profile
printed under each machine names seven things every published formalisation of
state machines disagrees about — run-to-completion (chasing is bounded at 64
steps), priority (innermost substate first), exits (a step exits to the least
common ancestor of its source and its target, and every transition is external:
the next paragraph), history (shallow, by parent map), regions (the interpreter
concatenates them; a parallel machine is not explored here at all), deferred
events (none — there is no event pool), and time (discrete `after(n)`; the walk
offers each `after(n)` label as an event rather than advancing a clock). A
verdict about a machine is a verdict under a reading of those seven, and one
that does not say which reading is one you cannot check. `exits` is the newest:
it was added on 2026-10-21, after the step's reading changed and moved verdicts
that none of the other six showed, so a `reach` or `check-behaviour` report
saved before then prints six.

**A step out of a composite leaves it.** A transition exits to the least common
ancestor of its source and its target: the source and every active state below
it are exited, then each state above the source that does not also hold the
target, innermost first with their exit actions; the transition's effect runs;
then the states that hold the target and did not stay active are entered,
outermost first, then the target and its initial substate. So `first b then
Idle` written inside `state C0 { … }` exits `b` and then `C0`: at `Idle`, `C0`'s
own transitions are not offered and a `state C0` atom does not hold. A step to
an ancestor exits it and enters it again at its initial substate. A step from a
composite into one of its own substates exits the composite too and enters it
again: `C0` to `C0::b` runs the exit actions of `C0`'s active substate and of
`C0`, then `C0`'s entry actions, then `b`'s. A step into a nested state from
outside enters its composite first; so does a step into a node written inside a
state, such as `then S::work` into `state S { action work; }`, which enters `S`
and then `work`. Every transition is external: a
self-transition exits its state and enters it again, and a composite restarts at
its initial substate. A composite marked as a history state is the exception to
both restarts: entered again, it resumes the child it was just left from. The
Simulation tab steps the same way on every machine the walk takes. A step whose
target sits in no chain of the machine's states — into the machine's own root,
or into a node written under an action — has no such ancestor, and the machine
is refused: `verification/behaviour-unsupported-construct` with the construct
`step-outside-states`, naming the transition. The simulator does not take such
a step either: neither UML nor the semantic profile says what it exits and
enters, so a run that comes to one stops where it stands, takes no step after
it whatever it is driven with, and is not complete. The Simulation tab says so
on a **Stopped** line (`sim-refused`) — *`` `Demo::Loop::again` leads from
`Demo::Loop::busy` into `Demo::Loop`, the machine itself ``*, then why — and the
Simulate button's trace ends its header line with the same sentence after
`Stopped:`. The line keeps the words it was written with when the model is
edited afterwards, and **Play** stops there, since no clock advance moves a
stopped run on. Two runs are worded apart. A composite state that the Simulate
button runs on its own (select it first) and that steps into itself stops the
same way: in the machine that holds it, that step exits the composite and
enters it again, but alone the composite has nothing above it to exit to, and
the sentence names that machine rather than calling the composite the machine
itself. That holds only where a machine holds the composite, as `reach` counts
machines: a state or `state def` above it that owns a transition, with no other
`state def` between the two. Where no machine holds it, as in
`state S { state C { … } }` or with a lone `state def` around it, the composite
is the machine itself, and the sentence is the plain one above, the one `reach`
prints for the same step. On a parallel machine, which only the API makes, each
region runs on its own over the whole script, so the step stops only its own
region, the other regions run on, and the sentence says so. The simulator used
to take it the old way, standing at the machine itself or at the node under the
action, or restarting under the source's composite. A step across a machine's
boundary, below, stops a run the same way. Until 2026-10-21 a step
exited only down to its source's level and entered the target on top, so a
composite stayed active after a step out of it, each round trip stacked one more
state, and a property could be refuted on a composite the run had left.

**A bound stops the walk, and then the absence claims stop with it.** Two
sentences this command will only say after seeing the whole graph: "this state
is unreachable" and "this transition is dead". Both are claims of ABSENCE, and a
walk that was cut off cannot make one. So when `--max-configs` is spent, both
lists come back **empty** — suppressed, not shortened — with
`verification/bound-exhausted` saying so:

```console
$ npm run sysprose -- reach examples/uav-isr.sysml --max-configs 2
…
    partial under {maxConfigs 2, …} — the configuration bound was reached; the unreachable and dead lists are lower bounds and are NOT reported as findings
```

**The depth bound counts events, not steps.** `maxDepth 200` bounds the events
a run takes from the opening. The trigger-less steps of the chase after each
event are not counted: the 64-step chase budget bounds those already. So four
trigger-less cycles stacked one behind another, each left on an event, are
walked to the end, though the fourth event's target is 260 steps out. The
`depth` printed beside the configurations still counts every step, so it can be
larger than the `maxDepth` printed in the bounds (`depth 260` beside `maxDepth
200` there). Until 2026-10-21 the bound counted steps, and that machine stopped
at depth 200 with every list withheld. No flag raises the depth bound.

A `check-behaviour` search can also come back short with no bound hit at all:
the walk finished, but never offered a trigger the machine names, so a run that
takes it was not searched. That is `verification/trigger-not-offered`, not
`bound-exhausted`: the row names the triggers, exits 2, and says that no flag
decides it, so `--max-configs` is not advised. The walk offers the whole alphabet
wherever it can decide that the interpreter takes its next event, so a row under
this code is a gap in the engine and not in the model.

**The 64-step chase budget is not a bound: the walk follows it.** The
interpreter fires trigger-less transitions for at most 64 steps after each
event, and then takes the next event wherever the chase stopped — so on a
machine whose trigger-less transitions form a cycle (`a ⇄ b`, with
`a accept e then c`), every run spends the budget and `e` still takes it to `c`.
The walk does the same: where a chase reaches the budget with a trigger-less
transition still due, it offers the machine's events right there, exactly as
the simulator takes the next one. So `c` above is reachable and `a -> c` is not
dead, and on a chain of trigger-less transitions longer than 64 the states past
the 64th are unreachable — no run gets there — under the `maxCompletion 64` the
line prints. A transition still due where a chase stops is enabled there, so it
is not dead and that state is not a `no way out`; but a set this walk could call
inescapable is not claimed over such a machine, and the trap line says why.

A machine that names **no** trigger is walked as it states itself even when its
trigger-less transitions cycle, like `FlightModes` above: a chase stopped there
is followed by nothing, so the walk reaches the same states either way. What
the budget does decide there is where a run *ends* — every run is the one chase
from the opening, stopped after 64 steps wherever it is — so the two answers
that are about where runs end are checked against those stopping points:
`check-behaviour`'s `recoverable` (below) and the `every run? guaranteed` line.
Each is withheld where the run the budget stops would read differently. A
`check-behaviour` search ends each run where the budget stops it, as the
simulator does, so a count round such a cycle is decided: `bounded-existence`
of `b` at most 40 times round `a ⇄ b`, which the run enters 32 times in its 64
steps, is a `pass`, and at most 31 times a `fail` on the run itself. Until
2026-10-21 the search refused the 65th step as a chase past the budget and
printed `inconclusive`. A trigger-less transition that carries a dwell (an
`attrs.after` set through the API) is the exception: a clock advance fires it
where the chase stopped and the chase goes on, so the search still refuses that
step there.

**A cycle the chase never leaves is a finding of its own.** On `FlightModes` the
simulator's chase goes `standby -> manual -> autonomous -> manual -> …` for its
whole 64-step budget on every run — `autonomous -> manual` is declared first, so
the chase never takes `autonomous -> failsafe` — and the machine never comes to
rest. `reach` reports that as `verification/completion-livelock`, a warning,
once per cycle of states: the `livelock` line above names the states the chase
goes round, in order, and the shortest way in, and the finding says where
declaration order decides (`autonomous` here, the choice row below it). It is
decided over configurations and over the transition the interpreter fires at
each one, not over states: a loop whose guard or whose store takes the chase out
of it on its own is not reported, and a cycle that only another branch of a
choice could leave is. Cycles that go round the same states under different
values of the store are one row, and the row says how many it stands for. The
way in is the simulator's own run wherever the walk holds one — here
`standby -> manual`, the step `simulate` takes. Where only the walk's way in
reaches the cycle, through a branch the simulator never takes, the line ends
`on a run of the walk, not of the simulator` and the finding names the state
where the two part: run `simulate` and it may never get there. On a machine
that names a trigger only an event moves such a run on; `FlightModes` names
none, so the run ends where the budget stops it, and the line says that
instead. A trigger on one transition of the cycle, or a guard that is false
where the machine should wait, is the fix. A guard on a trigger-less way out of
the cycle that the walk could not evaluate withholds the row — a `withheld` line
says so in its place — and `check-behaviour` files the same warning beside its
verdicts on the machine it checks, without changing a verdict or the exit code.
A withheld one it files as `verification/completion-livelock-withheld`, an info
finding in the words of the `withheld` line, which says only that a cycle was
seen and not decided. On `--json`
every machine row carries `livelocks` and `livelocksWithheld` (empty on a
machine with none, the second with the `clause` that withheld each), and
`totals.livelocks` counts the published rows. A row names its `states`, the
`transitions` the chase fires, the `choices` where declaration order keeps it on
the cycle, its way in (`entry`, `steps`), whose run that way in is (`entryBy`:
`simulator`, or `walk` with `branchAt` the state where it parts from the
simulator) and how many store or history variants it stands for (`cycles`).

The other direction is deliberately loose, in one place: the walk offers each
`after(n)` label as a named event rather than advancing a clock, so a state
behind a dwell is treated as reachable. An over-approximation like that can only
shrink an absence claim, never invent one. It is loose there and nowhere else —
the walk branches on the declaration-order tie-break, taking every transition
enabled at the innermost active level where a simulation takes the first, and it
does not cross the priority rule. A transition an inner state always beats fires
in no run at all, so a configuration reached through one is a configuration no
run enters, and `verification/deadlock` and
`verification/nondeterministic-choice` reported there would be invented rather
than found.

**A guard it could not evaluate is not a guard that is false.** A bound is not
the only thing that stops an absence claim. Ten lines that parse clean, with no
diagnostics of their own:

```sysml
part def Ctrl {
    attribute mode : Integer;          // no value, anywhere
    state def Modes {
        state idle;
        state hazard;
        transition idle if mode == 3 then hazard;
    }
}
```

The model does not say `mode != 3`; it says *nothing* about `mode`, so
`mode == 3` evaluates to nothing at all. A walk cannot fire that transition — it
has to pick something, and it picks not firing — but "the walk did not fire it"
is not "no run ever could". So `reach` withholds the two walk-wise absence lists
for that machine (unreachable and dead), prints `undetermined under {…}` where
it would otherwise print `exhaustive`, and raises
`verification/guard-undetermined` naming the guard and the names nothing valued.
A no-way-out row is withheld per CONFIGURATION rather than per machine: it goes
only where the undecided guard is an edge out of the configuration the row is
about (read over its whole active stack), and each row that goes leaves a
`withheld` line in its place, so a short list is never read as a clean one. A
sink elsewhere in the same machine that no guard was consulted about keeps its
row and its finding. Here `idle`'s only way out is the undecided guard, so its
row is the one withheld:

```console
    1 configuration(s) explored, depth 0 — undetermined under {maxConfigs 10000, …} — 1 guard(s) the walk could not evaluate; the unreachable and dead lists are WITHHELD and are NOT reported as findings, as is the no-way-out row for 1 configuration(s) whose only ways out are guards this walk could not decide
    undecided    idle -> hazard — guard `mode == 3`: no value for mode
    withheld     GuardProbe::Ctrl::Modes::idle — no enabled way out was found and none is reported: a guard the walk consulted decided nothing, so an edge the model states is absent from the relation
    the unreachable and dead lists are WITHHELD, and the no-way-out rows marked `withheld` above: a guard this walk could not evaluate is not a guard that is false
  verification/guard-undetermined  the guard `mode == 3` on transition `idle -> hazard` could not be evaluated — no value is in scope for `mode`. …
```

Write `attribute mode : Integer = 3;` (or `= 4`) and the walk decides it — and
with `= 4` you get the unreachable state and the dead transition back, because
then the guard really is false.

A hidden-choice row is an *existential* claim — two transitions were enabled at
once in a configuration the walk reached — so a bound never withholds one. A
withheld edge is more delicate, and the narrow statement is the true one:
removing a candidate **beside** a choice can only shrink it, but removing one
**inside** it moves which level of the active stack the choice is read at, and
that can invent a row. So a choice is withheld exactly where an undetermined
guard sits strictly inside it, and reported everywhere else.

`check-behaviour` shares the gate: a property no bad prefix violated over a
graph missing an edge nothing decided is `inconclusive` (exit 2), never `pass`
and never `vacuous`, and its row is the same `verification/guard-undetermined`.

**A set of configurations nothing leaves.** Everything above is about where a
run can get to. `reach` also asks the other half of the question — which
configurations, once entered, no run ever leaves — and reports each such set as
`verification/unrecoverable-mode`. A set nothing leaves is a bottom
strongly-connected component of the walk's successor relation, and three kinds
of them are exempted rather than reported: an ending (final states and `done`
nodes are where the machine is meant to stop), a single configuration with no
successor at all (that is already `verification/deadlock`, and one fact gets
one row), and the component holding the opening configuration — which is the
machine's own reachable core, not somewhere it can be trapped *from*. That last
exemption is why `FlightModes` above prints nothing here: its four states form
one component and `standby` is in it. A machine that is trapped looks like this:

```console
$ npm run sysprose -- reach test/fixtures/verification/models/trap-probe.sysml
test/fixtures/verification/models/trap-probe.sysml: 1 state machine(s), 1 walked to exhaustion; 5 configuration(s) explored
  a bounded walk of what the interpreter would do — every figure below holds under the bounds printed beside it
  TrapProbe::Probe::Modes [StateDefinition]
    5 configuration(s) explored, depth 4 — exhaustive under {maxConfigs 10000, maxDepth 200, maxCompletion 64, alphabet no named trigger, store seeded from declared literal values — a guard over an attribute with no declared value is undecided and takes no edge}
    5 of 5 state(s) reachable; 6 of 6 transition(s) fired, 0 dead
    trap         {failsafe, failsafeHold} — 2 configuration(s) nothing leaves; entered in 3 step(s) from standby
    livelock     {alpha, beta} — the chase goes round 2 configuration(s) on trigger-less transitions and the run ends where the budget stops it (no trigger is named); entered in 1 step(s) from standby
    livelock     {failsafe, failsafeHold} — the chase goes round 2 configuration(s) on trigger-less transitions and the run ends where the budget stops it (no trigger is named); entered in 3 step(s) from standby, on a run of the walk, not of the simulator
    choice       TrapProbe::Probe::Modes::beta: 2 enabled as completion transitions (no trigger); the simulator takes beta -> alpha, never beta -> failsafe
  semantic profile (the reading every figure above holds under):
    ...
  verification/unrecoverable-mode  trap — 2 configuration(s) form a set nothing leaves: {failsafe, failsafeHold}. Entered in 3 step(s) from `standby`. every claim above is about this MACHINE's semantics — …
  verification/completion-livelock  `TrapProbe::Probe::Modes`: completion livelock — the interpreter's chase goes round {alpha, beta} without coming to rest: …
  verification/completion-livelock  `TrapProbe::Probe::Modes`: completion livelock — the interpreter's chase goes round {failsafe, failsafeHold} without coming to rest: …
  verification/nondeterministic-choice  `TrapProbe::Probe::Modes::beta`: 2 transitions are enabled at once …
```

Read the row for what it says and for what it does not. `{failsafe, failsafeHold}`
names the states of every configuration in the set — the union of their active
stacks, so a composite state is named as itself and never only by the leaf inside
it — and `entered in 3 step(s) from standby` is the shortest way in. It does NOT
say the machine cannot recover: escaping the set might need a trigger the real
environment never offers, and this tool has no carrier for what an environment
supplies. It does not say `livelock` — that the chase goes round
`{failsafe, failsafeHold}` without coming to rest is the separate
`verification/completion-livelock` row beside it, a claim about the chase rather
than about the set, whose line ends `on a run of the walk, not of the simulator`
for the reason the next sentence gives — and it does not say the machine is free of
anything. And the sentence beside the finding is there because `beta` is a
choice point: the walk explored both branches, `simulate` takes `beta -> alpha`
every time, and a reader who tries to reproduce the trap with the simulator may
never see it.

**This is the first row `reach` publishes under the stricter gate, and it is
emptied — never shortened — whenever the walk is not exact.** The unreachable and
dead lists are claims that can only *shrink* as edges are added, so a walk that
offers more edges than the machine grants cannot invent one. *No trap* runs the
other way: it gets *easier* to say as edges are added, and a missing edge invents
a trap. So the trap list is published only where the walk finished inside every
bound, met no construct this engine refuses, offers no `after(n)` dwell, names no
trigger, consulted no guard it could not evaluate, and did not follow the
interpreter through a chase its budget stops with a trigger-less transition
still due — there a run rests where the budget leaves it, which is not an edge
of the machine. On the latch machine
(`transition locked accept unlatch then nominal;`) the walk supplies `unlatch`
wherever it can decide that the interpreter takes its next event, so whether
`locked` is inescapable is a question about the environment, and the report
says so in place of the list:

```console
    inconclusive: this machine names triggers this walk offers wherever it can decide that the interpreter takes its next event, so an escape it found may be one the environment never supplies and no absence of an escape is claimed; the environment offered every trigger this machine names wherever the walk could decide that the interpreter takes its next event (no completion transition due, or the chase budget spent), …
```

The same refusal, with its own sentence, prints for a dwell transition, for a
guard the walk could not evaluate, and for a chase the budget stops (`inconclusive:
the interpreter’s chase budget stops a run of this machine …`); a bound or an
unsupported construct prints
nothing extra, because the lines above already say every list is short. On
`--json` the machine row carries `trapCensus` — how many components the walk had,
how many nothing leaves, how many were exempted as endings, deadlocks or the
core, and which clause refused the answer if one did — and, where the gate held
and no trap was found, a sentence that names what was exempted rather than a
bare all-clear. That sentence is never a text row.

**Both spellings of an edge are one edge.** Between two states the notation
offers `transition idle then active;` and `first active then done;`, and a
machine may mix them in one body:

```sysml
state def Modes {
    state idle;
    state active;
    state done;
    transition idle then active;
    first active then done;
}
```

The walk follows both. It did not always: the step relation held
`TransitionUsage` alone, so the succession was in no configuration and in no
census, and the report called itself `exhaustive` while printing `1 of 1
transition(s) fired`, `done` unreachable and `active` a state with no way out —
two absence claims about an edge nothing had followed. A succession between two
states carries neither trigger nor payload, so it is read as what it is: a
completion transition. What stays outside is an edge with a PAYLOAD — a
`SuccessionFlow`, or a succession carrying an item, which this tool already
reads as the same thing — because the walk models no payload; it refuses the
machine rather than walking a graph it knows is short of an edge.

**Every edge under a machine is walked, or refused by name.** That is a census,
published on `--json` under `census`, and it is the durable half of the fix
above. Four readers found four different ways the relation the walk retains
differed from the machine somebody wrote, so the question is now asked the other
way round: each edge-bearing element under the machine lands in exactly one
bucket — `walked` (in the relation, leaving a node some configuration's stack
can hold), `opening` (read by the machine's opening and never fired), `refused`
(an unsupported construct names it), `off-stack` (neither end is a node the walk
can stand on — a `do` action's own flow is under the machine and is not an edge
of it), `not-a-step` (the element sequences nothing: `state idle : Base;` is a
typing between two elements, `connect a to b;` a connection, and no run ever
carries the control token along either) — and anything left over is
`unaccounted`, which is a test failure *and* a refusal:
`verification/behaviour-unsupported-construct` with the construct
`edge-not-walked`, no absence list, and no `exhaustive`. The row names the edge
and says why the relation does not hold it, so a spelling that sequences
behaviour and that this engine cannot walk can no longer shrink a claim in
silence.

Which nodes a configuration's stack can hold is *computed*, not guessed from a
metaclass: the machine's states, plus everything the relation can land the walk
on from one. So the edges leaving a `decide` node between two states are walked
and counted, and an edge leaving the machine ROOT — which the walk never stands
on, because it opens at the root's initial substate — is neither counted nor
reported dead.

One thing the fix deliberately did not move: a state definition that owns **no**
`TransitionUsage` at all is still not one of this tool's machines, and `reach`
says so — *this file declares no element that owns a transition, so there is no
configuration graph to walk*. That is an answer about what was looked for, not
an absence claim about a graph: nothing is called unreachable and nothing is
called exhaustive.

A `state def` written **inside** another state machine is a machine of its own,
not a region of the one it sits in: `reach` walks the nested definition
separately, so its states decide themselves. They are neither reported
`unreachable` nor counted in the outer machine's totals, and the outer walk stops
at the nested definition's boundary. A simulator run of the outer machine takes
its states at the same boundary, so it starts where the walk opens: at the outer
machine's own initial substate (where its own `initial` node leads, else its
first declared state), also when the nested definition is written before it. The
Simulation tab offers the outer machine's own events only, not the nested
definition's, and lists a nested definition as a machine where no machine holds
it: a `state def` whose only content is a nested definition is no machine, so the
tab runs the nested one; a nested definition inside a machine is not listed
beside it. A nested `state def` that owns no `TransitionUsage` is walked by
nothing, and each of its states then reads `not walked` in the app rather than
being called unreachable under a machine that does not contain it.

A transition that **crosses** that boundary — written in the outer machine and
leading into one of the nested definition's states or to the definition itself,
written in the nested definition and leading out of it, or written in one
top-level machine and leading into another's state — has no meaning either walk
defines, because each machine steps only by its own transitions. Walked anyway,
the outer machine entered the inner state and found no way out of it, while the
nested definition's walk followed its edge out to a state the outer walk had
just called unreachable. So `reach` and `check-behaviour` alike refuse **both**
machines the transition joins — the one it is written in, and the one whose
state it names from outside: `verification/behaviour-unsupported-construct` with
the construct `machine-boundary`, naming the transition — no absence list, no
`exhaustive`, and every property about either machine `inconclusive`. Keep each
transition inside the machine whose states it joins, or write the nested
definition as a composite state (`state Inner { … }`) to make its states part of
the outer machine. A specialisation or a typed usage that adds a transition over
the states it inherits (`state def Derived :> Base { transition … }`, `exhibit
state m : Modes { transition … }`) crosses the same way, and both machines are
refused with the inheritance named: no walk here puts the two together, so write
the machine you mean out whole, its states and every transition it steps by, in
one definition. The simulator reads neither machine as the pair either: it steps
only by the transitions written in a machine's own region and reads no inherited
state, so a run of the base never takes the added step and a run of the
specialisation has no state at all. A step across the boundary is stopped there
too: a run that comes to one stops where it stands without taking it, takes no
step after it, and is not complete, and the **Stopped** line (`sim-refused`) says
the step's far end lies outside the machine's region, as for a step into the
machine's own root (above). The same holds for a composite the Simulate button
runs on its own that steps out of itself to a state of the machine that holds it.
It used to enter the far state and stay there.

`check-behaviour --element Outer` checks `Outer` itself, also when a `state def`
written inside it makes it hold a second machine: a reference that is a machine
names that machine. What `Outer` is checked against stops where its walk does: a
property carried by the nested definition, or by one of its states, belongs to
that definition and is counted and checked there only — and where that
definition owns no transition, so is no machine and is walked by nothing, the
property is counted on `Outer` and reported there as `inconclusive`, `… — not
checked`, `verification/behaviour-unsupported-construct`, naming the definition:
checked by nothing, and said so rather than dropped — and a property of
`Outer`'s that names one of the nested definition's states or
transitions is refused as `verification/unknown-atom`, as one naming another
machine's state is. A reference that only contains machines (the package, say) is still refused
with the machines it holds (and with any definition that is no machine and
carries a property, below), and a state is refused with the machine it belongs
to — for a state of the nested definition, that definition, not the outer
machine whose text holds it. In the app, the pick row such a refusal lists in
the Checks tab (the machine's qualified name and its property count) selects
that machine, and the next Run checks it.

A `state def` that owns no transition and is written inside **no** machine is
no machine and sits in none, so no machine reports what it carries. When it
carries a property, name it — `check-behaviour --element P::Lone` — and every
property about it is `inconclusive`, `… — not checked`,
`verification/behaviour-unsupported-construct`, exit 2, naming the definition:
each carrier on it or inside it, and a `--pattern` given against it, which is
never walked. A machine written inside it (a nested definition or a composite
state that owns a transition) keeps its own carriers and is checked only by its
own name, so this run says nothing of it, a failure there included; each row
names it, and `--element P::Lone::Deep` checks it. Such a definition counts
beside the machines a reference holds, as one more thing a property can be
about: `--element P`, for a package holding it beside one machine, is refused
with both listed (*"`P` holds 1 state machine and 1 `state def` that is no
machine and carries a property"*, then the definition's line, *"owns no
transition and sits in no machine: named, its property is reported as not
checked"*), where it used to check the machine and pass the definition's
properties over, exiting 0 when the machine's own held; a package holding it and
no machine names it. A state written in it is refused with the definition named
(*"`P::Lone::b` holds no state machine — it is inside `P::Lone`, a `state def`
that owns no transition and is written inside no machine, so no walk stands on
its states; named itself, its property is reported as not checked"*). Where
such definitions nest, it is the outermost that carries a property that counts
and that a state inside them names, since naming it reports the carriers of
every definition inside it. A state inside a machine written in it names that
machine instead (*"… — it is inside `P::Lone::Mach`, which is one"*), a state of
a definition that owns no transition inside the machine among them: the machine
reports that definition's carriers, as not checked, and the outer definition
only its own. A definition like this that carries no property
resolves as before: refused as holding no state machine when none is written
inside it, and otherwise the one machine inside it is checked or the several
are listed; a state written in it is refused with the definition named, *"…, and
it carries no property"*, and the machines written inside it named. `reach
--element` on such a state names the same definition (or the machine that holds
the state) in the same words, without what only `check-behaviour` says of the
properties. Using such a definition as a state's type (`state m2 : Modes` inside
a machine) does not place it in that machine: no run of the machine enters the
definition's states, so it stays a definition no machine holds, and its
properties are still reported as not checked. In the app,
select the definition and run **Behaviour properties** for the same rows, with
a pick row for each machine written inside it. The pick rows with nothing
selected list what carries a property — the machines that do, then such
definitions (*"`P::Lone` — 1 property in the file, on a `state def` that is no
machine: selected, it is reported as not checked"*) — and every machine only
when nothing in the file carries one; the rows of a refused package list such a
definition beside its machines; a state written in one that carries a property
lists that definition, a state inside a machine written in it lists that
machine, and a state written in one that carries nothing lists the machines
written inside it, where it holds any.

**What it may never say.** Not "verified", not "deadlock-free", not "proved".
`verification/deadlock` names a state with no enabled way out that is neither
marked final nor a `done` node — a reading of one machine under one alphabet,
never a statement that the system deadlocks. A machine that ends at `done` has
ended, and is not reported. And `reach` reports rather than judges: a state nothing reaches
is a fact about a machine, not a violated requirement, so it exits 0 with its
findings in the report (`--json` publishes them under `reach`). A file that
declares no machine at all exits 0 too and says so — nothing was misused and
nothing failed to load. Exit 2 is for the command line: a `--max-configs` that
is not a bound, or an `--element` that names something holding no machine.

**In the app, the marks.** Run **Reachability** on the State view and each state
that answers a question carries one badge, in this precedence: `unreachable`
(the published unreachable list), `not decided` (an unreached state of a machine
whose lists were withheld — the SUPPRESSED or not-explored line says why), `not
walked` (a state under no machine the walk covered), `withheld` (the leaf of a
withheld no-way-out row), `no way out` (a published deadlock), `trap` (a member
of a published trap), and `choice` (a published choice). A status panel in the
canvas's top-left corner (`behaviour-marks`) says which, and the legend gains a
Marks section (`legend-marks`) listing the words present. Every mark names a row
in the Checks tab except `not decided` and `not walked`. A completion livelock is
a Checks-tab row and a `livelock` line of the report, and puts no badge on the
states it names.

**In the app, the edge marks.** A dead transition and a guard the walk could not
decide are marked on the transition itself, not only as a Checks-tab row: the
edge is drawn with a coloured, dashed stroke and a `dead` or `undecided` badge
beside its label. They follow the same rule as the state marks — painted only
while a current reach result is stored, on the State view, with the marks not
hidden and no witness open — and the legend lists the edge words present
(`legend-edge-marks`). A dead transition is one the walk proved never fires; an
undecided guard is one it could not evaluate, so the edge may in truth be taken
and this page is not claiming either way.

**In the app, the witness.** A `fail` or `covered` row turns its witness steps
in the Checks tab into buttons (`checks-witness-step`, with **Prev** / **Next**
/ **Close**). A click paints the walk's run on the State view — the step's leaf,
its stack, and the leaves already passed — and hides the reachability marks and
the simulation glow until it is closed. The walk obeys run-to-completion and
the chase budget, so every witness it found is one a run admits and every one is
drawn; none stays plain text. Running the check again closes an open witness as
the run begins, since the Checks tab hides the result, and with it the stepper,
while the run lasts; Cancel keeps the earlier result, not the witness.

**Source of truth:** `src/semantics/mc/config.ts` (the step relation the
interpreter and the walk share), `src/semantics/mc/explore.ts` and
`src/semantics/mc/profile.ts`.

### Whether a safety property holds on every configuration, and whether a situation can be reached

`reach` reports on a machine. `check-behaviour` **judges a claim you made about
one**: a *property pattern* — a shape with holes in it — filled with *atoms*
that name things the walk can observe. It walks the same configuration graph
`reach` walks, looking for a **bad prefix**: a finite run that breaks the
property. Finding one is a `fail`, printed as that run. Finding none over a
graph the walk saw *whole* is a `pass`. One pattern, `cover`, asks the opposite
question — *can some run get here?* — and the same search answers it the other
way round: a run found is `covered`, printed as that run; none found over a
graph seen whole is `not covered`. Everything else is said out loud.

```console
$ npm run sysprose -- check-behaviour examples/uav-isr.sysml --element FlightModes \
    --pattern 'pattern=absence, scope=globally, p=state failsafe'
examples/uav-isr.sysml: UAVSurveillanceSystem::FlightModes — 1 property: 0 pass, 1 fail, 0 vacuous, 0 inconclusive, 0 covered, 0 not covered
  a pass is a claim about every configuration this walk reached, under the bounds printed beside it, and about nothing outside them; a covered is a claim that ONE run this walk saw reaches the situation named, and not covered that none it saw whole does: pass, fail, vacuous, inconclusive, covered, not covered are the six words this command reaches
  liveness (`existence`, `response`) is NOT decided here: a bad-prefix search finds no bad prefix for either, so both report inconclusive
  FAIL         `state failsafe` never holds, over the whole run
    from --pattern
    fail — witness trace of 3 step(s) …
    verification/refuted
    every run? potential — some run avoids it: the cycle manual → autonomous → manual never enters `failsafe` — every claim above is about this MACHINE's semantics — the walk explores both branches of a nondeterministic choice; the simulator takes the first declared one, so a run this verdict quantifies over may be a run `simulate` never produces
    3 product state(s) explored — exhaustive under {maxConfigs 10000, maxDepth 200, maxCompletion 64, alphabet no named trigger, store seeded from declared literal values — a guard over an attribute with no declared value is undecided and takes no edge} …
    witness — a run this semantics admits:
       0  start → UAVSurveillanceSystem::FlightModes::standby
       1  completion standby -> manual → UAVSurveillanceSystem::FlightModes::manual
       2  completion manual -> autonomous → UAVSurveillanceSystem::FlightModes::autonomous
       3  completion autonomous -> failsafe → UAVSurveillanceSystem::FlightModes::failsafe  [holds p]
  semantic profile (the reading every verdict above holds under):
    ...
```

**This is `reach`'s finding from the other side.** `reach` says two completion
transitions are enabled at `autonomous` and the simulator takes the first, so
`failsafe` is never entered *in simulation*. Here that same fact refutes a
property: the model admits a run that reaches `failsafe`, and the witness is
that run, step by step. A tool that only simulated would have told you the
opposite.

**And the `every run?` line says whether that witness is one run or every run.**
`potential` means some run avoids the violation, and the line names it — here
the cycle `manual → autonomous → manual`, which never enters `failsafe`. On a
machine that names no trigger every run is one chase, so the cycle or the
stopping point named is one such a run reaches inside the 64-step budget
without the violation, and where none is, the line names the run the budget
stops (``the run the chase budget stops in `p64` never enters `v` ``).
`guaranteed` means every maximal run of the machine reaches it. Both are read
off the same graph the witness was, and both are withheld as `not decided`, with
the reason, whenever that graph is not the machine's: a walk that stopped at a
bound, a machine that names a trigger the walk offers wherever it can decide
that the interpreter takes its next event, a dwell the walk takes without
advancing a clock, a guard
over something the walk could not read, a chase the walk follows the
interpreter's budget through — and, where the machine names no trigger, a
`guaranteed` that a run the budget stops before it violates would contradict
(`not decided: the interpreter’s chase budget stops a run of this machine …`) —
and three refusals of the property
itself, a stateful pattern or
scope, a `fires`/`trigger` atom, an expression that needs the store. The tail
of the line is there because this machine has a choice point: the walk explored
both branches at `autonomous`, and the run the sentence names is one the
simulator's declaration-order tie-break never takes. In `--json` the same answer
is the row's `modality` field — `value`, `sentence`, `failedClause`, `avoiding`
— and it changes no count and no exit code.

**But if reaching `failsafe` is what you WANTED, that `fail` is the wrong
colour.** `absence` is red on the design that can get there and green on the
one that cannot — the intent "can this design ever reach the situation I care
about?" was, until `cover`, only expressible upside down. `cover` is the same
search read the right way round:

```console
$ npm run sysprose -- check-behaviour model.sysml --element Modes \
    --pattern 'pattern=cover, scope=globally, p=state failsafe'
model.sysml: CoverProbe::Reachable::Modes — 1 property: 0 pass, 0 fail, 0 vacuous, 0 inconclusive, 1 covered, 0 not covered
  …
  COVERED      `state failsafe` holds on some run, over the whole run
    from --pattern
    covered — witness trace of 2 step(s), a run this semantics admits: `state failsafe` holds on some run, over the whole run — the environment offered every trigger this machine names wherever the walk could decide that the interpreter takes its next event (no completion transition due, or the chase budget spent), so a witness that consumes `abort` is a claim about that environment and not about one that withholds it
    2 product state(s) explored — exhaustive under {maxConfigs 10000, maxDepth 200, maxCompletion 64, alphabet abort, store seeded from declared literal values — a guard over an attribute with no declared value is undecided and takes no edge} — the count beside it is the product states seen up to the witness, not the size of the product space
    witness — a run this semantics admits:
       0  start → CoverProbe::Reachable::Modes::idle
       1  completion idle -> armed → CoverProbe::Reachable::Modes::armed
       2  on `abort` armed -> failsafe on `abort` → CoverProbe::Reachable::Modes::failsafe  [holds p]
```

Exit 0, a witness, and the environment sentence beside it: the walk offers
every trigger the machine names wherever it can decide that the interpreter
takes its next event — at a configuration where no completion transition is
due, or where the 64-step chase budget is spent with one still due — so a run
that consumed `abort` is a claim about *that* environment and not about one that
never sends it. Where a completion transition is due and the budget is not
spent, the interpreter chases it before it takes any event, and so does the
walk: no trigger is offered there. Nor where nothing is due but a trigger-less
transition whose guard the walk could not evaluate: the interpreter reads that
guard as false and takes its next event, while the walk cannot tell which it
does and offers no trigger at all — it holds fewer runs there, not more, and
`verification/guard-undetermined` withholds every absence on that machine. On
the sealed twin — the same machine with the `abort` edge removed — the
row reads `NOT-COVERED`, `not covered under {…} — over 2 configuration(s)`, an
**info** line `verification/not-covered`, and **exit 2**: a decided absence, a
missing behaviour, and not a violated requirement. Nothing was refuted, so the
1 is not spent — unless you say the behaviour is required:

```console
$ npm run sysprose -- check-behaviour model.sysml --element Modes \
    --pattern 'pattern=cover, scope=globally, p=state failsafe' --cover-required
…
  NOT-COVERED  `state failsafe` holds on some run, over the whole run
  …
  --cover-required: every not-covered row above is also an error below and spends the 1; the claim word is the same with the flag and without it
  error verification/cover-required  …
  info verification/not-covered  …
```

Exit 1 now — and the row still says `NOT-COVERED`, never `FAIL`, and the
`verification/not-covered` line is still there under the added error. The flag
moves the exit code and nothing else. Two more things the row tells you rather
than leaving you to infer: `--max-configs` can hide a witness and can never
invent one, so a `covered` found under a bound still stands (the bounds line
says `partial under {…}`) while a `not covered` needs the whole graph, exactly
as a `pass` does — below the bound the sealed twin is `inconclusive: bound
exhausted — the not-covered claim is not made`. And a witness that crossed an
`after(n)` dwell is a run the walk admits and the interpreter may never take,
because this walk advances no clock; the row keeps the claim and re-words the
warrant — `covered — witness trace of 1 step(s), a run this WALK admits: step 1
fires `after(10)` (idle -> B on `after(10)`), a dwell this engine offers as a
named event without advancing a clock, so the interpreter may never take this
trace` — so the bare
"a run this semantics admits" is never printed over a trace the semantics does
not admit. On a machine where the walk explored a choice the simulator never
takes, every `covered` also carries the simulator sentence: the claim is about
the machine's semantics, and `simulate` may never produce the run.

**And one question neither `absence` nor `cover` can ask: from every configuration
the machine can be in, can it get back?** `absence` says whether a run ever
enters `failsafe`; `cover` says whether some run does; neither says whether the
design can *return* from wherever it ends up. That is a branching-time question
— `AG EF p`, *from every reachable configuration, some continuation reaches
`p`* — and a bad-prefix search cannot answer it in either direction: no finite
run breaks it, so the search would find nothing and print this command's
strongest verdict for free. `recovery` is answered by a different algorithm on
the same walk: the configurations that hold the state you name are collected,
and the walk's own successor relation is followed *backwards* from them. Every
configuration the backward pass reaches can get there; every one it does not is
named.

```console
$ npm run sysprose -- check-behaviour test/fixtures/verification/models/trap-probe.sysml \
    --element TrapProbe::Probe::Modes --pattern 'pattern=recovery, scope=globally, p=state standby'
test/fixtures/verification/models/trap-probe.sysml: TrapProbe::Probe::Modes — 1 property: 0 pass, 1 fail, 0 vacuous, 0 inconclusive, 0 covered, 0 not covered
  …
  FAIL         `state standby` is reachable from every reachable configuration, over the whole run
    from --pattern
    not recoverable: 4 configuration(s) cannot reach `state standby`: {alpha, beta, failsafe, failsafeHold}; the nearest is entered in 1 step(s) from `standby`. Of these, 2 form a set nothing leaves — `reach` reports them as `verification/unrecoverable-mode`.
    verification/refuted
    5 configuration(s) explored — exhaustive under {maxConfigs 10000, maxDepth 200, maxCompletion 64, alphabet no named trigger, store seeded from declared literal values — a guard over an attribute with no declared value is undecided and takes no edge}
  semantic profile (the reading every verdict above holds under):
    ...
  error verification/refuted  `TrapProbe::Probe::Modes`: `state standby` is reachable from every reachable configuration, over the whole run — not recoverable: 4 configuration(s) cannot reach `state standby`: …
  warning verification/completion-livelock  `TrapProbe::Probe::Modes`: completion livelock — the interpreter's chase goes round {alpha, beta} without coming to rest: …
  warning verification/completion-livelock  `TrapProbe::Probe::Modes`: completion livelock — the interpreter's chase goes round {failsafe, failsafeHold} without coming to rest: …
```

Read the two numbers for the two questions they answer. **Four** configurations
cannot get back to `standby` — nothing in this machine returns there, so every
configuration but the opening is on the list — and the row names them by the
state each rests in and says how soon the first is entered. **Two** of those four
are the set `reach` reports as a trap: `{failsafe, failsafeHold}` is the part
nothing leaves at all, while `alpha` and `beta` cycle between themselves with a
way out that leads only deeper. The trap row and this row are the same machine
seen from two sides, and neither number is ever printed under the other's
question. The two warnings after the error are not about this property: they are
the machine's completion livelocks, filed after every property's finding in
`reach`'s words, and they move no count — the exit code stays 1. Note what the row is *not*: it is a `fail` — an assertion you wrote
that the design does not meet, `verification/refuted`, exit 1 — but there is
no witness trace under it, because a set is not a run; the count beside the
bounds line is the machine's own configurations, not product states, because
no product search ran. On the flagship machine the same property is withheld —
`inconclusive`, exit 2 — although every configuration of `FlightModes` reaches
`standby` along the transitions it states: none of them names a trigger, so a
run is the one chase from `standby`, and the 64-step budget stops it in
`standby` or in `autonomous`, from where the run gets back to nothing. On
`examples/views-tour.sysml`, whose `standby ⇄ flying` every run is stopped in
`standby`, the row reads `PASS` with *recoverable: `state standby` is reachable
from every reachable configuration*, exit 0.

**What the row refuses, and why it refuses both directions.** `recoverable` is
a claim that gets *easier* to make as edges are added, so it is withheld — never
qualified — wherever the walk's relation is not the machine's: a bound the walk
hit, a named trigger the walk offers wherever it can decide that the
interpreter takes its next event, with no carrier for whether an environment
would send it (the latch
fixture: `locked → nominal`
exists only because the walk supplies `unlatch`, and the draft of this feature
printed `recoverable` about it), an `after(n)` dwell the walk takes without
advancing a clock, a run the interpreter's chase budget stops away from `p` —
the walk follows the budget there, or, on a machine that names no trigger,
the relation follows the chase past where the run ends (the flagship above).
That last refusal is filed under its own code, `verification/recovery-budget-withheld`
(exit 2): the walk finished and no construct is outside the fragment, so it is
neither a bound nor an unsupported construct, and no flag decides it — raising
`--max-configs` is no advice for it.
`not recoverable` gets easier as edges are *removed*, which is
the opposite direction — and a guard over something the walk could not decide
removes exactly one: on the trapguard fixture the escape `degradedA if resetOk
then nominal` is absent from the relation because nothing valued `resetOk`, and
a row that gated only the positive half would print *not recoverable: 2
configuration(s) cannot reach `state nominal`* at exit 1 about a design that
states the way back. So one gate holds both halves, the row is `inconclusive`
naming the clause, and nothing is shortened. Two more refusals are about the
property rather than the walk: `p` must be a `state` or a `node` atom — a
`trigger` or `fires` atom holds on a step and not at a configuration, and an
expression reads a store this walk does not retain, so none of the three gives
a target set to reverse from, and reading one anyway would earn a refutation
from a tool limitation — and the scope must be `globally`. And the two atom
kinds are read exactly as `absence` reads them: `state X` is *X on the active
stack*, `node X` is *X the active leaf*, so on a composite state `recovery p =
state degraded` holds from everywhere while `recovery p = node degraded` is a
refutation with an empty target set — the same split `absence` shows on the
same file, and the pattern never says `vacuous` for it: a state nothing reaches
is a decided *no*, not an unopened antecedent.

**The catalogue, and the half of it this engine will not decide.**

| Pattern | Class | Reads | Decided here? |
|---|---|---|---|
| `absence` | safety | P never holds | yes |
| `universality` | safety | P holds at every configuration | yes |
| `bounded-existence` | safety | P *occurs* at most `n` times | yes |
| `precedence` | safety | S holds before P ever does | yes |
| `cover` | **guarantee** | P holds on some run | yes — `covered` with a witness, or `not covered` (exit 2; exit 1 under `--cover-required`) |
| `recovery` | **branching** | P is reachable from every reachable configuration | yes — `recoverable`, or `not recoverable` naming the configurations that cannot (exit 1); withheld unless the walk's relation is the machine's, and `recoverable` withheld where the chase budget stops a run away from P; `state`/`node` atoms and `globally` only |
| `existence` | **liveness** | P holds at some point | **no** |
| `response` | **liveness** | every P is followed by an S | **no** |

A safety property is broken by a finite run, so a search for one either finds it
or, having seen the whole graph, has not. A **guarantee** — `cover` is
Manna–Pnueli's `◇β` — is *confirmed* by a finite run, so the same search either
finds one and prints it, or, having seen the whole graph, has not; it is the one
pattern whose negative answer is a behaviour the design does not admit rather
than a requirement it violates, which is why it has two words of its own and why
`not covered` exits 2 by default. A **branching-time** property — `recovery` is
`AG EF p` — is not a property of any run, so the search decides nothing about
it; it is answered by reverse reachability over the same walk, in both
directions, and only over a walk whose relation is the machine's. A **liveness** property is broken only
by an infinite run that never delivers what it promised, and a bad-prefix search
finds no bad prefix for one on *any* graph. Reporting "nothing found, so it
holds" would print this command's strongest verdict for exactly the two
properties it cannot decide, so both come back `inconclusive: liveness not
checked in-process` — until a lasso search lands and a fairness assumption is
named.

`bounded-existence` counts **occurrences**, not configurations. `state Outer`
holds at every observation from the moment the machine enters `Outer` until it
leaves — `state X` reads the whole active stack — so a composite entered once and
never left has *occurred once*, however many steps happen inside it. That is
Dwyer's reading (his at-most-`n` formula counts maximal intervals), and counting
configurations instead would refute "at most once" about a machine that enters
the state exactly once.

**The five scopes**, each naming *where* the property has to hold: `globally`,
`before R`, `after Q`, `between Q and R`, `after Q until R`. The last two differ
on one run and it matters: `between` speaks only about segments that actually
close, so a `Q` never followed by an `R` says nothing at all (vacuous), while
`after … until` is a weak until and the same run is a violation. Both are written
over `Q & !R`, so an observation where the opening **and** closing atoms hold
together opens no segment at all: there is nothing between a `Q` and an `R` that
are the same observation. On a hierarchical machine that is not a corner case —
a composite state and the substate its entry cascades into hold together at
every observation.

**The five atoms**: `state X` (X is on the active stack), `node N` (N is the
active leaf, which is how you name a `done` node), `trigger t` (the event
offered on this step), `fires T` (a named transition fired), or an **expression**
— read by the same parser your guards are read with, over the same store.

**A property lives in the model, as §7.27 metadata.** `--pattern` is for trying
one out; the carrier is how a claim stays with the machine it is about, and it
is checked *beside* whatever you type, never instead of it:

```sysml
state def FlightModes {
    @SysproseVerification::PropertyPattern {
        attribute pattern = "absence";
        attribute scope = "globally";
        attribute p = "state failsafe";
    }
    state standby;
    …
}
```

One attribute per field, so the phrase-to-atom trace survives a save: a reader
can see which pattern, over which scope, filled by which atom, without
re-parsing a sentence.
A carrier is read from the element it is written in: `about` is not read, so a
`PropertyPattern`, `Evidence`, `FaultHypothesis`, `VerificationMethod` or
`RequirementMetadata` (or an `about` annotation with a `kind` naming a method)
written with `about`, including inside its own target, is refused
(`mapper/carrier-about-unread`) and the checks abstain. Write it inside its target.

**What it refuses to say, and how each refusal reads.**

| You get | When | Exit |
|---|---|---|
| **pass** | no bad prefix, over a graph the walk saw **whole**, on a safety pattern | 0 |
| **fail** | a bad prefix, printed as the run that produced it — still a fail under a bound, because a witness is a real run. The `every run?` line beneath it says whether that run is one of many (`potential`, naming a run that avoids the violation) or all of them (`guaranteed`), or `not decided` with the reason; the line moves no count and no exit code | 1 |
| **covered** | a `cover` witnessed by a run, printed step by step — still covered under a bound, for the same reason; re-worded to *a run this WALK admits* where the run crossed a dwell or an undecided guard | 0 |
| **not covered** | a `cover` no explored run witnessed, over a graph the walk saw **whole**: a decided absence and a missing behaviour, not a violated requirement (`verification/not-covered`, info) | **2** — or 1 under `--cover-required`, which adds `verification/cover-required` and changes no word |
| **vacuous** | the property's antecedent never holds, over a graph the walk saw **whole**: a scope no run opens, or a `precedence` whose P never happens | **2** |
| **inconclusive** | a bound hit — including one that stopped the walk before the antecedent, which is *not* a vacuity — a guard the walk could not evaluate, a construct the explorer refuses (parallel regions, history), a liveness pattern, a property that could not be read, an atom that names nothing, or a witness the interpreter does not take (`verification/witness-not-replayed`, below) | **2** |

**A bound can hide a violation and can never invent one**, which is why those
rows are not symmetric — and why `covered` sits with `fail` on the witness side
of the line and `not covered` with `pass` on the whole-graph side. `--max-configs N` that stops the walk turns a would-be
pass into `inconclusive`; a violation found *inside* the same bound is still a
violation. A vacuity is on the `pass` side of that line: "no run opens the scope"
is a claim of *absence*, and a walk that stopped at a bound has not established
one — so a partial walk that never reached the antecedent is `inconclusive`, not
`vacuous`, and `--strict-vacuity` files nothing against the model for it.

**Every witness is replayed through the interpreter before a row stands on
it.** A `fail` or `covered` row prints a run, and that run is driven through
`runStateMachine` — the simulator itself — with the witness's events before the
row is published: the interpreter must fire the witness's transitions in its
order and enter the states it enters. The one choice the replay makes the
witness's way is the declaration-order tie-break, where the walk explores both
branches and the simulator takes the first declared one (the simulator
sentence beside such a row says so, also where an undecided guard withheld the
choice's own row); run-to-completion, the 64-step chase
budget and the priority rule are the interpreter's own. A row whose witness
does not replay is `inconclusive` under `verification/witness-not-replayed`,
exit 2, with the step where the two parted — a defect in this engine, not in
your model, and a row no flag lowers.

**A property nobody could read is never dropped.** A `pattern` outside the
catalogue, a `scope` outside its five, a missing field — and a *carrier attribute
that is not a property field at all*, which is the one a typo reaches: `scope` is
the only field with a default, so a carrier written `scpoe = "after"` read
without it would silently become a different property and be decided as if
somebody had written it. Every one of them is `verification/malformed-property`
⇒ exit 2. So is a `--pattern` whose value expanded to nothing, for the same
reason: dropping it would report on the carriers alone and look like a clean
sweep.

**An atom that names nothing is never read as `false`.** `absence of state
failsafe` would otherwise PASS the moment somebody misspelt `failsafe` — the
loudest way this whole lane could print a green verdict that means nothing. A
name the machine does not have is `verification/unknown-atom`, the row lists what
the machine *does* offer, and the run exits 2.

**Vacuity is surfaced and no flag launders it.** A property whose antecedent
never holds is true of your machine for a reason that has nothing to do with your
machine. It is `vacuous` ⇒ exit 2, with `--strict-vacuity` and without it; the
flag raises the row from a line to `verification/vacuous-property`, an **error**,
and changes nothing else — including the exit code.

**Source of truth:** `src/semantics/mc/patterns.ts` (the catalogue, the monitor
and the bad-prefix search), `src/semantics/mc/atoms.ts` (the five atom
spellings), and `src/semantics/mc/explore.ts` for the walk they both stand on.

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
    doc /* Four definitions SysML v2 does not express, carried over metadata definitions (SysML v2 7.27.1, 7.27.4). #exceptional says an outcome is a failure rather than an equally valid result. Evidence carries what a verification run showed, as an annotation on the requirement it is about. PropertyPattern carries a behavioural property — a pattern, a scope and the atoms that fill them — as an annotation on the machine it is about. FaultHypothesis carries the order bound a cut-set enumeration is run to, which is an assumption about how many failures are credible at once rather than something the contracts state. All four are Sysprose extensions, not standard vocabulary. */
    metadata def <exceptional> ExceptionalOutcome;
    metadata def Evidence;
    metadata def PropertyPattern;
    metadata def FaultHypothesis;
}
```

`#exceptional` says an outcome is a **failure** rather than an equally valid
result — the one annotation in this whole lane that SysML v2 has no way to
express, which is why it is shipped rather than borrowed. It is a Sysprose
extension and this guide will not pretend otherwise. Two keywords you might
expect are deliberately absent: `#precondition` and `#postcondition`, because
`assume constraint`, `require constraint` and a case `objective { … }` already
say both, three ways and two ways respectively.

**A tag is Sysprose's by its package, not by its name.** If another vocabulary
declares its own `metadata def <exceptional> ExceptionalOutcome` (say in a
package `VendorHints`) and your `#exceptional` resolves to that one, it is
*their* tag: `contracts --keywords` lists it as `other vocabulary` (here
`#exceptional on P::Theirs → VendorHints::ExceptionalOutcome`), and
`fault-tree` does not label a top event with `(#exceptional)` or count a state
as an `#exceptional` hazard for it. Write `#SysproseVerification::exceptional`,
or import that package, to mean ours (a pasted copy of the package must sit at
the top level of the file; a copy nested in your own package is your
vocabulary, not ours).

**`Evidence` in that same package is deliberately not a keyword.** It ships with
no short name, so there is nothing to write after a `#`. A keyword is a tag — it
says one thing by being present — and an evidence record has a body: a claim, an
engine, a tool version and a model digest. So it is written in §7.27's
*annotating* form, `@SysproseVerification::Evidence { attribute … = "…"; }`, by
`evidence-attach`, and a bare `#Evidence` that carried no record and claimed to
be one is a spelling this package does not allow.

**`PropertyPattern` is not a keyword either, and for the same reason.** A
behavioural property has a body — a pattern name, a scope, and the atoms that
fill them — so it is written in the annotating form too,
`@SysproseVerification::PropertyPattern { attribute pattern = "absence"; … }`,
one attribute per field. `check-behaviour` reads it; nothing writes it, because
a property is a claim you make about your machine and not one this tool invents
for you.

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

An edit made through `window.sysml` — `create`, `update`, `delete`,
`reparent`, a `commit(fn)` batch — is an edit like any other: the Explorer and
Properties follow at once, and Problems, the diagram and the Text view with
the next refresh. The model then reads unsaved: **New**, **Open ▾** and
**Import** ask before dropping it, and an attached Google Drive file shows
*unsaved changes*. The one exception is text typed in the Text view and not
applied, which an SDK edit never replaces
([§5](#the-text-tab-in-both-directions)). An SDK edit is not an Undo step of
its own. Nor does it put an element of yours inside the standard library: a
`create` or a `reparent` with an owner there puts the element at the top level
of the model, as the Explorer does ([§5](#the-loop)), and the strip says so.
Each call that adds or moves an element lists the model in the order its text
gives it ([§5](#the-loop)): a pass over the whole model, about 15 ms on the
drone-swarm model with its library, more on a busy machine. A script that
makes many edits makes them in one `commit(fn)`, which lists the model once
for the elements it adds; each `reparent` lists it at its own call, inside a
`commit(fn)` too.

**Source of truth:** `src/ui/store.ts:3606-3788` (`runValidation`,
`solveParametric`: the four buttons), `2299-2491` (`afterSdkEdit`: an SDK edit),
`src/api/analytics.ts:2409-2416` (`feasible`), `src/ui/App.tsx:46-94`
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
invisible is the longer metadata form: `@ProseStatement about p1;` (or, with the
keyword, `metadata ProseStatement about p1;`) parses and round-trips, the keyword
form printed as the `@` form, but it is not read as a kind, because reading it
means resolving `about` against scope and this tool does not do that yet. The
named form (`metadata n : ProseStatement about p1;`) and a visibility word
(`public @ProseStatement about p1;`) parse and round-trip too: the named form
is saved back as `metadata n : ProseStatement about p1;` and the visibility word
is kept. None of these forms is read as a kind.

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
`src/validation/rules.ts:562-579`, `996-1021` (the two rules that ask),
`scripts/sysprose.ts` (`requirements --kind`, `prompts`),
`test/unit/semantics.statement-kind.test.ts`.

---

## 8. What is kept, and what is not

Nothing here leaves your browser unless you sign in to Google Drive
([§8.1](#81-google-drive-optional)) — then exactly the file you save goes to
your own Google Drive, and nothing else. Nothing here is saved for you
automatically.

| What | Where it goes | Survives a reload? |
|---|---|---|
| A project you pressed **Save** on | IndexedDB (`sysmlv2-modeler`), falling back to localStorage | **Yes** — reopen it with **Open ▾** |
| Boxes you moved by hand on a diagram | with that project, beside the model — never in its text, a SysML or JSON export, or a Drive file | **Yes**, with the project — **Open ▾** puts them back |
| A file you saved to Drive | your Google Drive (`drive.file` scope: only files made or chosen with this app) | **Yes** — Drive ▾ → Recent, Browse Drive…, or its link |
| Anything you did **not** save | nowhere | **No** — deliberately: the app boots the sample rather than resurrecting your work (closing or reloading the tab asks first) |
| Versions-tab commits, branches, merges | memory | **No** |
| Regroup scenarios | localStorage (`sysmlv2-scenarios`) | Yes |
| Light/dark theme | localStorage (`theme`) | Yes |
| Panel widths, Explorer focus and filter, the library toggle, the diagram scope, the armed palette tool | memory | No |
| An exported file | your downloads folder | it is a file |

**Save takes no name and shows no confirmation.** It writes over the current
project name — and, with a Google Drive file attached that has unsaved changes,
saves to that file too (which may first ask the strip's rewrite question, or
meet a conflict). Save — the button, or `Ctrl/⌘ + S` from anywhere in the app,
a field included ([Appendix B](#appendix-b--keyboard-shortcuts)) — stores the
model, so text typed in the Text view and not yet applied is applied first, as
**Apply text → model** does, and the save holds what is on screen, still under
the current project name. That name does not follow the model's first package
through Undo and Redo: a package renamed in the app, or an Undo of an apply,
leaves it as it was, so a Save after them writes the project that is open and
no other. A step that carries a name (an apply, New, Open, Import, or a switch
of branch, which a merge ends in) gives one back when it is undone or redone: on
an Undo the name the project had before it, on a Redo the name it held when
the step was undone, even when a Save as has named the project otherwise in
between. Two kinds of typed text are kept back instead: the
model is saved as it stands, the Text view still reads *modified — not yet
applied*, and, when no Google Drive file is attached, the strip under the
toolbar says so.

- **A text with a syntax error.** The parser's best guess at it is not what
  you see. The strip says *Saved in this browser without the text typed in the
  Text view: it has a syntax error at line N. Fix it, then save again.* — the
  line of the first error, which neither Problems nor the strip under the
  editor lists for a text not applied. An attached Drive file gets the text as
  typed ([§8.1](#81-google-drive-optional)).
- **Any typed text, in a collaboration room.** Applying it replaces the room's
  model for everyone in it, and an edit a peer made after you began typing is
  not in your text: one Save would erase it. **Apply text → model** still does
  that when you choose to; Save does not, and the strip says *Saved in this
  browser without the text typed in the Text view: in a collaboration room,
  Save does not replace the room's model with it.*

The next save that holds the text takes the note down; **×** hides it.

A third note is about text that *was* applied. When a field's change (a
Properties box, a rename, a Requirements table cell) went into the model while
your typed text stood — it stays, as above, when the element is not in the text
or the model changed since you began typing — Save applies the text over the
change, and where the two differ the text wins. With no Google Drive file
attached, the strip says *Saved in this
browser with the text typed in the Text view applied over changes made in the
app since you began typing: where the two differ, the text won. Undo brings
those changes back.* once, and the save is made; the next save that holds the
model takes the note down. A save to an attached Google Drive file, and the
**Save and continue** of the question below, apply the text over the change and
say nothing of it. An SDK edit or a peer's edit made since the typing is not a
field's change: Save applies the text over it as before and says nothing.

**Replacing a model with unsaved work asks first.** **New**, **Open ▾**,
**Import**, switching to a branch in the Versions tab and a merge there that
resolves (it loads the merged model) each put another model in place of this
one; joining a collaboration room lets the room's model change or replace it.
When the model has work no save holds, the strip under the toolbar asks first
— *`<project>` has unsaved changes* — with **Save and continue** (the project
saved in this browser, text typed in the Text view applied first, then the
command), **Discard and continue** (after New, Open ▾, Import or a branch
switch, one Undo still brings the model back; before a room join it reads
**Join without saving**) and **Keep editing**. Unsaved means that the Text
view's text — typed and not yet applied, or not — differs from the text the
model had when it was last saved, in this browser, to Google Drive or as a
commit in the Versions tab, or opened: a project from **Open ▾**, a `?model=`
link, a Drive file, the branch the Versions tab loaded. **New** counts as
saved, and so does the model the app starts with, so a first visit that
touched nothing is never asked; Undo back to the saved model reads saved
again. An import is not a save. Boxes moved by hand count too: they differ
from the ones the last **Save**, **Open ▾** or **New** left (a commit in the Versions tab, a branch switch or a save to Google Drive does not hold them, and leaves them unsaved); an apply of text renews every element, so after one the boxes read as moved until the next **Save** (Undo of the apply reads saved). A merge that meets conflicts (**manual**) loads nothing, and
asks nothing. **Save and continue** is disabled while text
typed in the Text view has a syntax error — this browser keeps models, not
text: fix it, or discard it. A command given while the browser is still
storing a **Save** waits for it; if the browser refuses the save (its storage
full, or blocked for the site), the command waits, and the question says so.
With a Google Drive file attached, the question is about that file's unsaved
changes instead ([§8.1](#81-google-drive-optional)). Closing or reloading the
tab asks too, with the browser's own question whether to leave the page, while
the model has work no save holds — the same text and boxes as above, an edit
the Text view has not caught up with yet, and an attached Drive file's unsaved
changes as well — and asks nothing once **Save** has kept them (a Drive file
does not hold the boxes: with one attached, a box moved by hand still makes the
tab ask). A commit, a branch switch or a merge in the Versions tab does not stop
the tab asking, nor does New or Open ▾ over them: those are kept in memory and go
with the tab, so only **Save** does. Press **Save** before you leave.

If you want the model out of the browser, use **Export ▾**: SysML text, model
JSON, OMG-API-shaped JSON, the diagram as SVG or PNG, or an FMI 3.0 FMU /
`modelDescription.xml` for the selected block. The SysML text is the model's
text — what the Text view shows when it reads *in sync with model*: your
packages, without the standard library the app merges in, so **Import** opens
it as the same model and the CLI reads it as it is. Text typed in the Text view
and not yet applied is applied first, as **Save** applies it, so the file holds
what is on screen: the export then changes the model, and spends one Undo step,
as **Apply text → model** does. Save's two exceptions hold: a text with a
syntax error, and any typed text in a collaboration room, are kept back — the
file holds the model as it stands, the Text view still reads *modified — not
yet applied*, and the strip under the toolbar says *Exported without the text
typed in the Text view*, naming the line of the first syntax error, or the
room. An export that applies the text over a field's change says so too, as Save
does (*Exported with the text typed in the Text view applied over changes made
in the app since you began typing … Undo brings those changes back.*). The next export that holds the text takes that note down. A save in
this browser does not — the file still lacks the text — nor does an export
take down a save's note; but a newer note of either kind replaces the older
one, and a save to an attached Google Drive file takes either down. The two
JSON exports write the model as it stands, without text not yet applied, and
carry the merged library too, as a saved project does.

**Source of truth:** `src/persistence/store.ts:88-135`, `src/branding.ts:48`,
`src/ui/store.ts:829-847` (`persistScenarios`: the Regroup scenarios kept in
this browser), `3940-4037` (`newProject`, `listProjects`: New, Save, Open and
what they mark saved), `4285-4354` (`commitVersion`, `switchBranch`: a commit,
and a branch head loaded), `5161-5171` (`mergeLoads`: a merge that loads),
`5173-5311` (`applyTypedTextToSave`, `sayWhatWasKept`: typed text applied before
a save or an export, or kept back and said so), `src/ui/commands.ts:39-106`
(Save, and Export ▾ →
SysML), `src/ui/store.drive.ts:423-467` (what reads unsaved), `504-531` (`leaveUnsaved`,
`leaveBeforeUnload`: the tab's question), `1399-1466` (the question), `src/api/versioning.ts:481-494`,
`src/ui/panels/DriveStrip.tsx`, `src/ui/App.tsx:181-191` (the page's listener),
`src/ui/store.ts:5151-5159` (`askBeforeLeaving`),
`src/persistence/io.ts:45-86`, `test/e2e/persistence-reload.spec.ts`,
`test/e2e/import-export.spec.ts`, `test/e2e/toolbar-lifecycle.spec.ts`.

### 8.1 Google Drive (optional)

**Where it is.** Only on a site whose operator has set it up — a `drive.json`
next to the app names their Google client (the README's *Deploy* section says
how). There, **Drive ▾** sits on the first toolbar row, beside **Collaborate**.
A build that nobody configured ships the feature off: no button, and nothing in
this section applies. To try Drive against your own `npm run dev` or `npm run preview`, start the server with `SYSPROSE_NO_ISOLATION=1`: they send the headers that make the page cross-origin isolated (so the palette's solver checks can run in it), and the same headers break Google's sign-in popup and its Picker; the solver checks then read `not here`, as on the hosted site.

**Nothing goes to Google until you ask.** The app contacts Google only after
you open **Drive ▾**, press `Ctrl/⌘ + Shift + S`, or follow a link to a Drive
file — each of those loads Google's sign-in script, and signing in is a click
of its own after that.

**Signing in.** **Drive ▾ → Sign in to Google…** (it reads *Loading Google
sign-in…* for the moment the script takes). Google shows its account chooser —
pick the school or the personal account you mean — then asks you to let the
app use the Drive files you make or choose with it, and no others: the
`drive.file` permission. The panel then reads *Signed in as* your address. A
school account may meet Google's **Access blocked** page instead — a Google
Workspace for Education account designated under 18 does, until the school
allows the app, and so does any account missing from the test-user list while
the site's Google project is still in testing. Closing that page leaves
*Sign-in was cancelled or blocked*, with **Privacy & data ↗** beside it: that
page names the app's client ID, which is what your administrator needs (Admin
console → Security → Access and data control → API controls → Manage
third-party app access, add the app by its client ID; *Limited* access is
enough).

**Saving.** **Save to Drive as…** asks for a name — the project's, with `.sysml`
added — and writes a new file in the root of My Drive; the model is now
*attached* to it, and the strip under the toolbar says *saved to your Google
Drive at* the time. After an edit the strip reads *unsaved changes*, and **Save
to Drive** — the strip's button, the panel's, or `Ctrl/⌘ + Shift + S`, from
anywhere in the app, a field included — writes it. With a file attached, the
toolbar's **Save** and `Ctrl/⌘ + S` write its unsaved changes to it as well,
beside the copy they keep in this browser; if the browser refuses that copy
(its storage full, or blocked for the site), the strip says so. What goes to
Drive is the Text view's text:
your packages, in this app's layout, and none of the standard library — nor
the boxes you moved by hand on a diagram, which only the copy in this browser
keeps. Text you
typed and did not apply is applied first, because saving it means making it the
model — except for the copy in this browser when that text has a syntax error:
the parser's best guess at broken text is not what you see, so the browser keeps
the model as it stood, while Drive gets your text as typed. Nothing goes to
Drive by itself — there is no autosave — and closing or reloading the tab while
a Drive file has unsaved changes raises the browser's own question whether to
leave the page (as it does for work no save holds without a Drive file,
[§8](#8-what-is-kept-and-what-is-not)). Every row the strip can show, and every Drive control with its
test id, is in [Appendix A](#google-drive-panel-and-strip).

**Opening.** Signed in, the panel's **Recent** lists the files this app saved or
opened for your account, newest first; one click opens one. **Browse Drive…**
opens Google's file picker on your files and on those shared with you (on a
site that configured the picker). The field under it takes a Drive share link —
its `resourcekey`, which older link-shared files need, is kept and sent with
every request for that file — a link to this app, or a bare file id. Opening
replaces the model, and Undo starts over from the file; if the model has work
no save holds ([§8](#8-what-is-kept-and-what-is-not)), the strip asks first
(**Open anyway**, **Keep editing**). A model JSON file opens but is not
attached: **Save to Drive as…** writes it as a `.sysml` file. With unsaved
Drive changes, these commands ask first — New, Open, Import, switching to a
branch or a merge that resolves in the Versions tab, joining a collaboration
room, a Drive open, **Close Drive file** and **Sign out** — offering **Save to
Drive and continue**, **Discard and continue** and **Keep editing**; each of
them lets go of the file (a merge that meets conflicts loads nothing, keeps
the file, and asks nothing). While a file is attached, only its unsaved
changes are asked about — what Drive holds is not lost, whatever this browser
holds. Without one, or with one gone from Drive (changes unsaved to it or
not), the commands that replace the model ask the question in
[§8](#8-what-is-kept-and-what-is-not); **Close Drive file** and **Sign out**
keep the model, and ask nothing more. While you are connected to a room, its
peers change the model too, so no Drive file opens or attaches there: a Drive
open and **Save to Drive as…** say *Leave the collaboration room* first, and a
file attached while the room's relay was out of reach lets go when it connects.

**Links and sharing.** **Copy link to this file** copies a link to this app
ending in `?drive=` and the file's id (and its `resourcekey`, when it has one).
Opening it shows a gate — *This link
opens a file from Google Drive* — with **Sign in and open** and **Skip**. To
share the model: **Open in Google Drive ↗ → Share** (Editor to let them save
back, Viewer otherwise), then send the link **Copy link to this file** gives
you. The first time, Drive will not let the app open a file somebody shared
with you until you have chosen it once yourself in Google's picker: the gate
says so and offers **Browse Drive…** on that one file — or, on a site without
the picker, says the file cannot be opened there. Choosing it there grants
it, and from then on the link opens directly. Pasting the file's Drive share
link into the field beside it grants nothing — only the picker does — but the
link carries the `resourcekey` some older link-shared files need. With view
access only, the strip reads *you have view access*, and **Save to Drive as…**
keeps your own copy.

**When two people save one file.** Just before a save, the app asks Drive
whether the file's content changed since it last read or wrote it (by Drive's
checksum of the content, so a rename or a new share does not count). If it did,
nothing is written and the strip turns amber — *changed in Drive since you
opened it*, with who and when — and offers **Save as copy**, **Overwrite** and
**Reload from Drive** (one Undo step takes you back to your version). Drive
keeps the previous version for about 30 days (up to 100 versions): **Open in
Google Drive ↗**, then *Manage versions*; mark one *Keep forever* to keep it
longer.

**A file written by hand.** The app writes files in its own layout: `//`
comments go, while `doc` and `comment` bodies stay. The first time you save a
file that was written by hand or by another tool, the strip asks once: **Save
anyway**, **Save as copy** (the original stays as it is), or **Cancel**. Files
the app wrote itself never ask. A file with a syntax error opens with its parse
errors in Problems and keeps them through a save; what goes to Drive then is
your text as typed.

**Offline.** The Drive commands that need Google — signing in, Save to Drive
as…, Recent and its Refresh, Browse Drive…, opening a pasted link — are
disabled, their tooltip reading *Offline* (if Google's sign-in script could not
be fetched, the sign-in button reads *Google sign-in did not load* instead). If
the attached file has unsaved changes, Save to Drive is disabled the same way,
`Ctrl/⌘ + Shift + S` saves nothing and says you appear to be offline, and the
strip says the changes stay in this tab: its **Save** keeps them in this
browser — text typed in the Text view applied first — and Save to Drive works
again once you are back online. With no Drive file attached, the key opens the
Save to Drive as… form, whose save button is disabled offline as well. A
`?drive=` link opened offline says it needs Google Drive, and offers **Skip**.

**The hour-long sign-in.** A Google sign-in in the browser lasts about an hour,
and there is nothing to renew it with silently. In its last two minutes, a
strip showing unsaved changes adds *sign-in expires soon*, and after the hour
*sign-in expired*; the next Drive command — the next **Save to Drive**, say —
then opens a brief Google window — no account chooser — and carries on. If the
browser blocks that window, the strip says so: allow pop-ups for the site and
give the command again. If that window comes back signed in as another Google
account — it can, once yours is no longer signed in to Google in this browser —
the command does nothing: the strip says so, the Drive file is closed, the
Recent list cleared, and the panel names the account now signed in. Google can
also refuse a sign-in partway through a command — one revoked from another
device, say. The app then opens the same brief window to renew it, and if that
window is blocked or closed, the strip says *Your Google sign-in expired*, and
**Sign in and continue** finishes what was interrupted.

**Signing out.** **Drive ▾ → Sign out** asks Google to revoke the app's access,
then forgets the session, the Recent list and the attached file; the model stays
on screen. If your sign-in had expired, it first asks Google for a fresh one in a
brief window, because revoking needs one (should that window come back as
another account, it is that account's access that is revoked, and the strip
says so). When Google does not accept the
request, the app says so and points to Google Account › Security › Third-party
access, where you can remove the app yourself. After a sign-out, the next
sign-in shows Google's permission screen again, and a file a classmate shared
may need choosing once more.

**What stays where.** The sign-in lives in this page's memory only — the app
never puts it in the browser's storage or in a URL — and is gone at sign-out,
when it expires, or when the tab closes; Google's own picker receives it when
you choose **Browse Drive…**. Your files travel between this browser and
Google's servers. Whoever runs the site sees nothing of them: there is no
server of theirs in between, only the host that serves the app's own files. A
`?drive=` link is an address like any other, though: opening one sends the
file id in it — and its `resourcekey`, when it has one — to that host, and a
file shared with *anyone with the link* is as open as that sharing makes it.

**The CLI on a Drive file.** With a file attached, the **Copy command** of the
palette's checks names that file — as it is when its name is plain letters,
digits, `_`, `.` and `-`. Any other name could be read as a command by some
terminal (cmd.exe and PowerShell do not quote the way bash does), so the
command names a stand-in instead — `Swarm (copy).sysml` becomes
`Swarm__copy_.sysml` — and the note under the check says to save the file
under that name. To have it in a terminal, download it —
**Open in Google Drive ↗ → Download**, which works everywhere — or use Google
Drive for desktop, which keeps My Drive in a folder on Windows and macOS (there
is no Linux client). The file holds exactly the Text view's text, so the CLI
reads what you saw: `npm run sysprose -- stats Swarm.sysml`.
**Export ▾ → SysML** writes the model's text too, changes not yet saved to
Drive included; text typed in the Text view and not yet applied is applied
first, as Save does — one Undo step — unless it has a syntax error or a
collaboration room is connected ([§8](#8-what-is-kept-and-what-is-not)). It
names the file after the project, so save it under the name the command uses.

**Source of truth:** `src/ui/store.drive.ts:551-635` (every sentence the
feature says), `1212-1226` (the content check), `src/persistence/drive/`,
`src/ui/panels/DriveMenu.tsx`, `src/ui/panels/DriveStrip.tsx`,
`test/e2e/drive.spec.ts` (against faked Google services).

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
- **PNG export is a white-background rasterisation** of the SVG at 2×. Dark
  theme is not honoured. SVG and PNG export, and Auto-layout, are disabled off a
  graph view — the greyed control's tooltip says why.
- **Collaboration needs a relay you start yourself** (`npm run collab`), rooms
  are open with no permissions layer, and your identity is a random per-session
  name and colour. The relay takes at most 64 MiB in one message, and closes
  only the connection that sends a larger one: a peer's first message holds the
  whole model with its standard library, about 10.8 MB for the drone-swarm
  example, so a room over a model several times that size still fits, and a
  model past the cap cannot be shared. The standard library travels in the
  room's document, so every peer's first message carries it again. Two peers
  who each drag one of two elements into the other at the same moment leave the
  room's document holding each under the other; every peer, and a page that
  joins, then reads the one with the lower id at the top level and the other
  under it, and the document is corrected to say so.
- **Google Drive, where a site offers it**
  ([§8.1](#81-google-drive-optional)): a sign-in lasts about an hour, and
  renewing it opens a window the browser must allow — so allow pop-ups for the
  site. One upload is at most 5 MB of text. Nothing is saved to Drive without
  you: there is no autosave. A tab holds one Drive file at a time. A file
  somebody shared with you opens here only after you have chosen it once in
  Google's picker, so a site without the picker cannot open it. The check for
  somebody else's save runs just before the upload, so two saves landing within
  the same second or two can still overwrite each other — Drive's version
  history keeps the other. **Browse Drive…** lists files by type — plain text,
  unknown binary (which a `.sysml` file often is to Drive) and JSON — and a
  file Drive typed otherwise does not appear in it. The `resourcekey` an older
  link-shared file needs is sent as a request header, and whether Google
  accepts that header from a browser page has so far been tried only against a
  stand-in for Google; if it does not, such a file will have to be opened
  through **Browse Drive…**. While connected to a collaboration room, no
  Drive file is opened or attached.
- **Feasibility is approximate.** The solver is penalty-driven; `feasible` means
  no known violated inequality, and unjudged relations are listed separately.
- **The geometry view is massing, not CAD** — primitive solids from attributes.
- **One file at a time.** No cross-file imports, no workspace.
- **`Ctrl+N` is not a shortcut.** New is a toolbar button only.

**The verification lane's own register.** These are not defects to be fixed
later; they are the boundary of what this tool is allowed to say, and each one
is a sentence it will refuse to print rather than a corner it will cut.

| The limit | What you do not get, and what happens instead |
|---|---|
| **No solver on the hosted site** | z3 WASM needs `SharedArrayBuffer`, which needs COOP/COEP headers GitHub Pages cannot set. On `npm run dev` and `npm run preview` the palette's solver checks run z3 in the page, with no evidence record. The Contracts view and the Requirements table's Evidence column *read*; they never decide, and each prints the command that does. |
| **A missing solver is red, not green** | `--engine auto` and `--engine smt` with no solver report `verification/tool-absent` on every obligation and exit **2**. `--allow-inconclusive` reaches `verification/timeout` and `verification/unsupported-construct` only — never tool-absence, never a design admitted, never a vacuity, never a refutation. |
| **`proved` is a solver's word, not a kernel's** | z3 is trusted as a solver. Nothing here is checked in a proof kernel, and the phrase "kernel-checked" is reserved for an imported result whose axiom set was parsed. |
| **Not two independent engines** | Measured on this machine: `z3` 5.0.0 is on `PATH` and `cvc5` is not, so a cross-check runs the z3 binary against the z3 WASM build (`z3-solver` 5.3.1, engine 5.3.1.0). That catches an export defect; it is not two engines agreeing. `--cross-check cvc5` reports `inconclusive: cvc5 not installed` with the command to run, and a disagreement is always inconclusive with both verdicts named — the tool never picks a winner. |
| **No liveness, and no reactive-synthesis question either** | `existence` and `response` come back inconclusive until a lasso search lands and a fairness assumption is named. `consistency` decides whether static contracts can hold at once, which is a different question from whether a reactive component could be built to meet them — a question this tool does not ask and whose word it never prints. Two words are reserved outright, and a guard in the test suite keeps both out of the source and the documents. |
| **No domain axioms from a quantity kind** | Typing a feature `ISQ::PowerValue` tells this tool nothing about its sign. A freed feature bounded on one side only is `verification/free-variable-unbounded`, never a refutation — otherwise `cruisePower = -1 W` reads as a counterexample and the arithmetic check confirms it. |
| **A narrow encodable fragment** | Only single-valued scalar features with ScalarValues typing are encoded. Multiplicity > 1, chains through unresolved typings, strings, enums, `null`, `%` and variable exponents are `verification/unsupported-construct` — inconclusive, with the construct named. Ordering on °C is encoded in kelvin; arithmetic on °C is refused, exactly as the numeric surface refuses it. |
| **A bounded behaviour walk** | The in-process engine decides the finite abstraction it exhaustively explored, and says so: a `pass` needs the whole configuration graph, a `fail` does not. There is no event pool and no deferred events, completion chasing stops at 64, and `after(n)` is a discrete clock, not dense time. |
| **A guard nothing values is not a guard that is false** | `transition idle if mode == 3 then hazard;` over an `attribute mode : Integer;` with no value is a question this tool does not decide. `reach` withholds that machine's unreachable and dead lists — and, per configuration, the no-way-out row of any configuration that guard is an edge out of, printing a `withheld` line in its place — prints `undetermined under {…}` instead of `exhaustive`, and raises `verification/guard-undetermined` naming the guard and the names nothing valued — give the feature a value (`= 3`) and the walk decides it. `check-behaviour` shares the gate and reports `inconclusive` (exit 2) rather than `pass` or `vacuous`. A hidden-choice row stays where the withheld guard is beside it — two transitions enabled at once is an existential claim, and removing a candidate next to them can only shrink it — and is withheld where the withheld guard is strictly inside it, because that moves which level the choice is read at. |
| **An edge kind the walk does not follow refuses the machine** | Between two states, `transition a then b;` and `first a then b;` are one edge and both are walked; an edge carrying a PAYLOAD (a `SuccessionFlow`, or a succession with an item) is one this relation models nothing of, and is not. Every edge-bearing element under a machine is accounted for by a census (`--json`, under `census`) as walked, read by the opening, refused, with neither end a node the walk can stand on, or as no step at all (a typing, a subsetting, a `connect` — facts about the states rather than steps between them) — and anything left over refuses the machine (`edge-not-walked`) rather than shrinking its unreachable, dead and no-way-out lists. A state definition owning no `TransitionUsage` at all is still not one of this tool's machines, and `reach` says so instead of walking it. |
| **A vacuous requirement is not a pass** | And that is a declared disagreement with the specification, recorded in [`CONFORMANCE.md`](CONFORMANCE.md) §8 with the clause number beside it. |
| **The verdict facet is this tool's tag** | `verdict = "pass"` is an unbound string on a metadata usage, not the specification's enumeration on its own metaclass. Another tool is entitled to ignore it, and what a foreign *textual* parser makes of the bytes is untested; the API/JSON round trip is the one that has been probed. |

**Source of truth:** `src/library/std/manifest.json`, `src/ui/store.ts:237`
(`UNDO_LIMIT`: undo is bounded), `1781-1811` (`RECOMPUTE_DEBOUNCE_MS`: the
derived surfaces lag), `5486-5609` (`mergeLibrary`, `loadStandardLibraryAsync`:
the library merge), `src/ui/panels/Toolbar.tsx:90-105`, `273-313`,
`src/api/analytics.ts:2409-2416` (`feasible`), `src/ui/commands.ts:200-312`.

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
| New | Clears the model to an empty `NewModel` package. With work no save holds, the strip under the toolbar asks first ([§8](#8-what-is-kept-and-what-is-not)) — about an attached Google Drive file's unsaved changes instead, when one is attached ([§8.1](#81-google-drive-optional)). One undo restores. The standard library stays loaded. | `tb-new` |
| Open ▾ | Lists saved projects; picking one replaces the model; with work no save holds — or unsaved changes to an attached Drive file — the strip asks first | `tb-open` |
| Save | Writes the model into browser storage under the current project name. No dialog. Text typed in the Text view and not applied is applied first; over a syntax error, or in a collaboration room, the model is saved as it stands — and, with no Drive file attached, the strip under the toolbar says so. With a Google Drive file attached that has unsaved changes it saves to that file too, as **Drive ▾ → Save to Drive** does — which may ask the strip's rewrite question or show a conflict | `tb-save` |
| Import | Opens a `.sysml` / `.json` / `.txt` file and **replaces** the model; with work no save holds — or unsaved changes to an attached Drive file — the strip asks first, once the file is chosen. The imported model is not saved | `tb-import` |
| The question before a model is replaced | With no Google Drive file attached, on every deployment: before New, Open ▾, Import, a branch switch or a merge that resolves (Versions tab) or joining a room replaces a model with work no save holds, the strip under the toolbar reads *`<project>` has unsaved changes* (`data-status="guard"`, announced as an alert) — **Save and continue** saves the project in this browser, text typed in the Text view applied first (disabled while that text has a syntax error), then goes on; **Discard and continue** (**Join without saving**, before a room join); **Keep editing**. When the browser refuses the save, the command waits and the row says so | `guard-save`, `guard-discard`, `guard-keep` |
| Import FMI | Adds a block read from an FMI 3.0 `modelDescription.xml` (adds, does not replace) | `tb-import-fmi` |
| Export ▾ | The export menu | `tb-export` |
| Export → SysML (.sysml) | The model as textual notation, text typed in the Text view applied first | `tb-export-sysml` |
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
| More ▾ | The commands that do not fit the window at this width — Import FMI, Import, Auto-layout, Solve, Simulate and New give way in that order; Open, Save, Export, Validate, Check, Drive, Collaborate, Undo, Redo and Theme never do | `tb-more` |
| Drive ▾ | Google Drive (optional), present only when the deployment configures it. Opening it loads Google's sign-in script. The dot is grey signed out, green signed in, amber when something waits for you (unsaved changes, a conflict, a question), red after an error | `tb-drive` |
| Drive → Sign in to Google… | Google's account chooser, then Drive's permission for the files you make or choose with this app. Disabled, reading *Loading Google sign-in…*, until Google's script has loaded | `tb-drive-signin` |
| Drive → Browse Drive… | Google's file picker — your files and those shared with you; the file you choose replaces the model and Undo starts over. Present when the deployment has a picker key | `tb-drive-browse` |
| Drive → Save to Drive | Writes the model's text — what the Text view shows — to the attached Drive file; `Ctrl/⌘ + Shift + S` does the same, from a field too. Disabled when there is nothing to save, with the reason in its tooltip — and the key then sends nothing either | `tb-drive-save` |
| Drive → Save to Drive as… | Writes the model to a new `.sysml` file in the root of My Drive, and attaches it | `tb-drive-save-as` |
| Drive → Sign out | Asks Google to revoke this app's access, and forgets the session, the Recent list and the attached file | `tb-drive-signout` |
| Collaborate | Room name, connect/disconnect and the participant roster. Joining a room asks first when the model has work no save holds, or unsaved changes to an attached Drive file | `tb-collab` |
| Undo / Redo | Snapshot undo and redo; the depth is in [§5](#5-authoring-and-the-one-dangerous-button) | `tb-undo`, `tb-redo` |
| Theme | Light/dark, remembered | `tb-theme` |

### Toolbar, row 2 — the view bar

| Group | Views | Test ids |
|---|---|---|
| Diagrams | General, Interconnection, Action, State, Requirement, Tree, Parametric, Case, Sequence, Geometry | `tb-view-general`, `tb-view-interconnection`, `tb-view-action`, `tb-view-state`, `tb-view-requirement`, `tb-view-tree`, `tb-view-parametric`, `tb-view-case`, `tb-view-sequence`, `tb-view-geometry` |
| Tables | Allocation, Grid, Requirements, Contracts | `tb-view-allocation`, `tb-view-grid`, `tb-view-requirements`, `tb-view-contracts` |
| Analyze | Analysis, Planning, Regroup | `tb-view-analysis`, `tb-view-planning`, `tb-view-regroup` |

### Google Drive panel and strip

Present only on a deployment that configures Google Drive. The panel opens from
**Drive ▾**; the strip is the line under the toolbar, there only while it has
something to say; the gate is the loading screen a `?drive=` link holds. (The
strip's question about work no save holds, with no Drive file attached, is on
every deployment: it is in the toolbar table above. So are two of its notes —
that a save in this browser, or **Export ▾ → SysML**, kept typed text back, and
that an element went to the top level of your model rather than into the
standard library: see the *Strip · error or note* row.)

| Control | What it does | Test id |
|---|---|---|
| Drive panel | Who is signed in — *Not signed in*, *Signed in as …* — and the commands below | `drive-panel`, `drive-account` |
| Recent | The files this app saved or opened for this account, newest first, each with its time; one click opens it in place of the model. **Refresh** reads the list again; with none yet, it says so (and, on a site with the picker, that **Browse Drive…** finds files shared with you) | `drive-recent-item`, `drive-recent-refresh`, `drive-recent-empty` |
| Paste a Drive link or file id | Opens a Drive share link (its `resourcekey` kept), a `?drive=` link to this app, or a bare file id | `drive-open-id`, `drive-open-id-go` |
| Copy link to this file | Copies the link that reopens the attached file in this app (`?drive=<id>`, with `&resourcekey=` when the file has one, also in its `data-link`); when the browser refuses the clipboard, the strip shows the link to copy by hand | `drive-copy-link` |
| Open in Google Drive ↗ | Drive's own page for the attached file: sharing, Manage versions, Download | `drive-open-in-drive` |
| Close Drive file | Lets go of the attached file; the model stays | `drive-close` |
| Privacy & data ↗ | The deployment's privacy page | `drive-privacy` |
| Drive strip | Where the model stands with Drive, one row at a time, named by `data-status`: `clean`, `dirty` (with *sign-in expires soon* in the sign-in's last two minutes, and *sign-in expired* after the hour — the next Save to Drive opens the brief Google window), `saving`, `opening` (*Opening* and the file's name, once known), `saveas`, `rewrite`, `guard`, `conflict`, `readonly`, `gone`, `offline`, `expired`, `error`, `closed`, `info` — and `link-unsupported` when a `?drive=` link reaches a deployment without Drive. A guard, a conflict and an error are announced as alerts | `drive-strip` |
| Strip · saved | *`<name>` · saved to your Google Drive at hh:mm*, with Drive's page for the file and its link | `drive-strip-open-in-drive`, `drive-strip-copy` |
| Strip · link to copy by hand | When the browser refuses the clipboard — for the strip's **Copy link** or the panel's — the link, read-only and selected, beside whatever row the strip shows; it goes once you click elsewhere | `drive-link-text` |
| Strip · unsaved changes | **Save to Drive**, as `Ctrl/⌘ + Shift + S` does | `drive-strip-save` |
| Strip · Save to Drive as… | The file name, prefilled (`.sysml` added when missing), then **Save**: a new file in the root of My Drive, attached. Signed out, the button reads **Sign in and save** — disabled, reading *Loading Google sign-in…*, until Google's script has loaded | `drive-saveas-name`, `drive-saveas-confirm`, `drive-saveas-cancel` |
| Strip · rewrite question | The first save of a file written by hand or by another tool: **Save anyway** (in this app's layout, `//` comments dropped), **Save as copy**, **Cancel** | `drive-strip-rewrite-ok`, `drive-strip-rewrite-copy`, `drive-strip-rewrite-cancel` |
| Strip · guard | Before New, Open, Import, a branch switch or a merge that resolves, joining a room, Close Drive file, Sign out or a Drive open replaces a model with unsaved Drive changes, or lets go of its file: **Save to Drive and continue**, **Discard and continue**, **Keep editing**. Before a Drive open replaces work no save holds: **Open anyway**, **Keep editing** | `drive-guard-save`, `drive-guard-discard`, `drive-guard-keep`, `drive-guard-open-anyway` |
| Strip · conflict | The file changed in Drive since you opened it: **Save as copy**, **Overwrite** (Drive keeps the other version for about 30 days, under Manage versions), **Reload from Drive** (one Undo step back to yours) | `drive-strip-copy-save`, `drive-strip-overwrite`, `drive-strip-reload` |
| Strip · view access, or gone | **Save to Drive as…** writes your own copy | `drive-strip-save-as` |
| Strip · offline | **Save** keeps the unsaved changes in this browser — text typed in the Text view applied first, unless it has a syntax error, when the strip says the typed text was kept back, on a line of its own under the offline row (**×** hides it); a browser that refuses the copy is said so | `drive-strip-save-local` |
| Strip · sign-in expired | **Sign in and continue** finishes what Google's refusal of the sign-in interrupted | `drive-strip-signin` |
| Strip · error or note | **Try again** where trying again can help; **Privacy & data ↗** beside every error; **×** hides the message. The note that a save in this browser, or **Export ▾ → SysML**, kept typed text back, and the note that an element went to the top level of your model rather than into the standard library (`info`), show on every deployment, Google Drive or not. The library note never covers another message: it waits until that one is hidden; Undo takes it down. An export's kept-back note waits behind an error or a *closed* message and goes up when it is hidden. With Drive on and a file attached (or a sign-in to renew), these notes stand on a line of their own under the file's row (*saved*, *unsaved changes*, *offline*, *view access*, *gone*, *sign-in expired*), never in place of it | `drive-strip-retry`, `drive-strip-privacy`, `drive-strip-dismiss`, `drive-strip-note` |
| `?drive=` link gate | **Sign in and open** — disabled, reading *Loading Google sign-in…*, until Google's script has loaded — or **Skip** to the sample model. When Drive refuses a file not yet granted to this app: **Browse Drive…** (Google's picker, on that one file — choosing it there grants it; nothing else does; on a site without the picker, the gate says the file cannot be opened there), the file's Drive link pasted (which grants nothing, but carries the `resourcekey` some older link-shared files need), and which account is signed in (shared with another of yours? Skip, Sign out under Drive ▾, open the link again). Any other failure: **Try again**, and **Privacy & data ↗** — where a sign-in Google blocked for a school account is explained | `drive-link-gate`, `drive-link-signin`, `drive-link-skip`, `drive-link-denied`, `drive-link-browse`, `drive-link-id`, `drive-link-id-go`, `drive-link-retry`, `drive-link-privacy` |

### Panels

| Control | What it does | Test id |
|---|---|---|
| Explorer tree | The containment hierarchy of the model | `explorer-tree` |
| Explorer search | Filters to matches and their ancestors; `/` focuses it, Escape clears | `explorer-search` |
| Library toggle | Shows the bundled standard library in the tree, below your own packages (off by default). An element added under a library row, dragged onto one, or pasted onto one, goes to the top level of your model instead, and the strip says so ([§5](#the-loop)) | `explorer-library-toggle` |
| Focus a subtree | Narrows the Explorer to one element; the chip clears it | `tree-focus`, `explorer-focus`, `explorer-focus-clear` |
| Scope the diagrams | ⊞ on a row draws only that element's subtree in every graph view; the breadcrumb's **Diagrams:** chip and its × clear it | `tree-scope`, `scope-chip`, `scope-clear` |
| Add child / rename / delete | Per-row tree editing | `tree-add`, `tree-rename`, `tree-delete` |
| Properties fields | Name, type, value, multiplicity, direction, documentation (read-only on an element of the standard library), requirement id and text | `prop-name`, `prop-type`, `prop-value`, `prop-doc` |
| Tags | The `#Tag` keywords written on the element, applied on Enter or on leaving the field; a statement kind stays with the Kind control | `prop-tags` |
| Subject | A requirement's subject as `name : Type`, applied on Enter; empty removes it | `prop-subject` |
| Statement kind | What the selected element is for — requirement / prose / prompt — offered wherever the notation can carry the keyword, which is most declarations and not only requirements | `prop-statement-kind` |
| Requirement attributes | The nine management facets of a requirement — status, verdict, risk, priority, criticality, rationale, source, owner, verificationMethod — one control each, named `prop-rm-<facet>` after the key it writes | `prop-req-attrs` |
| Requirement facet cells | The same ten facets as columns in the Requirements table — a drop-down (`req-attr-select`) where the key has a closed list, click-to-edit text (`req-attr-input`) where it does not; disabled, with the reason on the cell, on a row whose declaration could not be parsed | `req-attr-cell` |
| Where-used list | Everything that references the selection, click to navigate | `prop-used-by` |
| Impact graph | The 1-hop reference neighbourhood, drawn | `prop-impact` |
| Breadcrumb | The containment path of the **selection** (not the diagram scope) | `breadcrumb` |
| Explorer and Properties, put away | Each side column can be put away (**‹** on the Explorer, **›** on Properties) to a slim rail at the window's edge, which brings it back on a click. From the keyboard, **Enter** on the control leaves the focus on the one that replaces it, so a following `Backspace` deletes nothing | `explorer-collapse`, `explorer-expand`, `properties-collapse`, `properties-expand` |
| Palette | Three sections for the active view — **Tools** (what to draw, including an explicit Select), **Edit** (what to do to the selection), **Checks** (what to verify). Every view has one: a table view draws nothing, so it has Edit and Checks only. The column can be put away (**‹**): it shrinks to a slim strip at the canvas's left edge, with a **›** and a label that names what it hides — *Palette: Tools, Edit, Checks* (the first word in capitals), or *Palette: Edit, Checks* on a table view — and a click anywhere on the strip brings the column back where you left it. From the keyboard, **Enter** on either control leaves the focus on the one that replaces it, and the strip shows a focus ring. Putting the column away also disarms an armed tool, so the next canvas click places nothing the screen no longer names. On a window too short for the whole label, the label ends in an ellipsis (**…**) and the strip's accessible name still reads whole | `palette`, `palette-tools`, `palette-select`, `palette-edit`, `palette-checks`, `palette-collapse`, `palette-expand`, `palette-collapsed-label` |
| Palette · Edit | Rename (opens the explorer's inline rename), Duplicate, Delete — each disabled with the reason when nothing is selected. Reparenting stays a drag onto the new owner | `palette-rename`, `palette-duplicate`, `palette-delete` |
| Palette · Checks | One row per verification command that fits this view: the question it answers, **Run** (runs it here, against the model on screen), **Copy command** (the same check for a terminal), and a verdict — `not run`, `checking the load…` and `running…` while a check runs in the background, `holds`, `findings`, `undecided`, `stale` after an edit (and, for a check that reads the selection, once the selection moves off what it read: the command beside it then names something else), or `not here` for a check that needs the z3 solver where the page is not cross-origin isolated (the hosted site; see below for the local servers) or z3 did not start. `verify`, `consistency`, `refine`, `bounds` and `fault-tree` need z3. On `npm run dev` and `npm run preview`, which send the cross-origin-isolation headers (COOP `same-origin`, COEP `require-corp`; `SYSPROSE_NO_ISOLATION=1` turns them off, as Google Drive's sign-in needs), they run in the page through the same code as the terminal's: the row reads `running…` with a **Cancel** button (which drops the answer; z3 ends at its own time budget), and the verdict is `holds` when the command would exit 0, `findings` for exit 1 and `undecided` for exit 2 — a model with nothing to check is `undecided`, never `holds`, and so is a model that does not load cleanly (judged over the load as `reach` and `check-behaviour` are, below, with `checks/degraded` as the first row); a z3 that cannot start reads `not here` with the reason, and a z3 that dies mid-session ends that Run as `findings` with a `checks/internal-error` row naming the death, and the next Run starts a fresh z3 (not yet exercised in a real browser). An edit made while a solver check runs shows its result `stale`. `bounds` needs a selected element, as its `--measure` does. In the page they keep no evidence record (`verify --record` is the terminal's). The Checks tab lists the first 100 findings of a solver check, and the summary counts the rest. `reach` and `check-behaviour` walk a state machine's configurations, which can take a good part of a second on a machine with many configurations, so they run in the background: the Checks tab comes forward at the click and lists the check as under way (`checking the load…` while the model's text is parsed, then `running…`), the row reads the same with a **Cancel** button beside Run, the page stays usable meanwhile (an answer that arrives while you are in another tab leaves you there), and the answer lands in the Checks tab (marked `stale`, like any result, if the model was edited while it ran). Cancel keeps the result the check had before, and the keyboard focus moves to Run. The first Run in a while — after the page opens, or after a minute unused — takes longer, as the background worker starts and loads the standard library: a fraction of a second, or about a second and a half where the run checks the load (below), since the worker then builds the text parser too. Both are judged over whether the model loads as a terminal would load the file: the text Save writes and, where it differs, the text Export ▾ SysML writes, each parsed and validated with the standard library. A text no parse has measured is parsed in the background worker first — the text an edit leaves, and also, on the first Run after a model is opened, the text Export ▾ SysML writes, which is seldom the file's own text byte for byte, and so is parsed even when nothing has been edited — the row and the Checks tab read `checking the load…` meanwhile (a few seconds the first time on a model the size of the drone swarm, a few tenths of a second there once the worker is running), then `running…` — and the counts are kept, so a check run again over a model not changed since has its load at once. The click itself parses nothing and holds the page for no more than a moment, on a model the size of the drone swarm too: Run pressed straight after an edit, before the Text view and Problems have caught up with it, reads `checking the load…` at once, and the page catches up after that (a few tenths of a second on the drone swarm, as after any edit there). The walk is of the model as it was when the run started — at the click, or, for Run pressed straight after an edit, once the page has caught up with that edit a moment later: an edit made after that shows the result `stale`. A model that does not load cleanly is never `holds`: the check reads `undecided` (or `findings`, beside what it found), and its first row, `checks/degraded`, says why — the syntax errors and validation errors it counted, a model that cannot be written as text, a value written back as it came that the grammar cannot read (reported without the text being parsed, and said so), or a text that parses cleanly but to another model than the one on screen — a field written back as typed that closes its owner, adds a declaration or turns the rest of its line into a comment — for which the row claims no exit code, since a terminal loads that file and checks the other model. A load the worker could not check — it could not be started, failed, stopped, or said nothing for a minute — is taken as not checked, which counts the same way: the check is `undecided` and its row says the load could not be checked, and the page parses nothing, so it is not held for it. A model with no state machine starts no walk: once its load is known, the row says there is nothing to walk. A page with no worker parses the texts itself (and says the load could not be checked only where no standard library has loaded there either), and one whose worker fails, holds another standard library than the page's (a library element renamed in Properties makes it another), or says nothing for a minute during the walk has the check run where it stands; both hold the page while they last. A worker that could not load the standard library at all (offline, the data not cached) is not started again until the page is reloaded: later runs go straight to the page, and a load still to measure is taken as not checked. A check reads the selection where its terminal command does: `where-used` and `check-behaviour` name it as `--element`, `bounds` as `--measure`, and `contracts`, `obligations` and `reach` cover the selected element and what it contains, as their optional `--element` does (`reach` only where that element holds a state machine, as the terminal refuses one that holds none) — `contracts` and `obligations` give the figure beside the whole model's (*1 of 5 contract(s)*), all three end the summary *scoped to* its name, and **Copy command** names it too. With nothing selected, a bundled library element (which the terminal refuses as a scope), or an element that can hold no contract — a comment, an import, a relationship, such as the header comment the app selects on opening a file that starts with one (for `reach`, also an element that holds no state machine, such as a state inside a machine) — these three cover the whole model, their command names no element, and the summary ends *covers the whole model:* and why — the reason at the click: selecting a different comment, import or library element afterwards leaves the result current, since it covers the same elements, and the reason keeps what it said. The command names the file the model is in: the attached Drive file's name, a model opened through `?model=` by its link's file name (`views-tour.sysml`) until the project has another name — New, Open or Import, or an apply of a text that renames the model's first package, give it one — else the project's name. A file or element name that some terminal could read as a command — a Drive file named `R&D (copy).sysml`, say — never goes into the command: a stand-in of plain characters does (`R_D__copy_.sysml`), or `<qualified name>` for an element (also when a check needs one and nothing is selected), and a note under the row says what each stands for | `palette-check`, `palette-check-run`, `palette-check-cancel`, `palette-check-copy`, `palette-check-verdict`, `palette-check-note` |
| Canvas | The diagram itself | `diagram-canvas` |
| Column header | The package's name over one column of a layered General view — a band above the boxes of a connected piece that spans several packages; a click goes through it to the canvas | `column-header` |
| Column strip | The frozen strip along the canvas's top, under its toolbar: `column-strip` holds one `column-strip-cell` for the header of each piece that runs beneath it whose band is above the strip or under 22 px high on screen, for a column at least 28 px wide on screen; in screen space at 12 px, clipped to the canvas; a click goes through it | `column-strip`, `column-strip-cell` |
| Fit / zoom to selection / snap / auto-layout | The canvas mini-toolbar | `diagram-fit`, `diagram-fit-selection`, `diagram-snap`, `diagram-autolayout` |
| Scope diagram to this / Show whole model | Narrow every drawable view to one subtree, and clear it | `node-ctx-scope`, `node-ctx-scope-clear` |
| Legend | The notation families present in this view, docked bottom-left beside the zoom controls. While reachability marks are painted, a Marks section lists each mark word present (`legend-marks`) — even when the view has no edge kind | `diagram-legend`, `legend-toggle`, `legend-marks` |
| Reachability marks | The status panel in the canvas's top-left corner, in the State view after a **Reachability** run (`data-state`: `current`, `hidden` or `stale`). One line with the marks on the diagram and the withheld counts, a **details** toggle (`behaviour-marks-details`) for what each mark means, and **Hide marks** / **Show marks** (`behaviour-marks-hide`). While a witness is open it reads `witness` instead | `behaviour-marks`, `behaviour-marks-details`, `behaviour-marks-hide` |
| Overview map | The minimap. On a canvas narrower than 1100 px it is a toggle — **▸ Map** — so it cannot cover the legend or the diagram | `minimap-toggle` |
| Tool hint | While a palette tool is armed, what the next click does, and that Esc cancels | `canvas-tool-hint` |

### Bottom panel

The **▾** at the end of the tab strip folds the panel down to its tabs
(`bottom-collapse`); **▴**, or any tab, opens it again.

| Tab | What it is | Test id |
|---|---|---|
| Problems | One shared list, overwritten by Validate / Check / Simulate / Solve / parse | `tab-problems` |
| Checks | What each palette check last said: verdict, summary, and each finding with its code — click a finding to select the element it names. A check scoped to the selection says so in its summary (*scoped to* its name, or *covers the whole model:* and why). A check running in the background is listed at once — as `checking the load…` while its model's text is parsed, then as `running…` — in place of what it said before, which comes back if the run is cancelled. A result from before the last edit is marked stale rather than shown as current. A reach or check-behaviour result also carries the terminal's own report under `checks-report`, the same lines the command prints, each one a `checks-report-line` with `data-kind`, `data-code` and `data-withholds`; reach groups them per `checks-report-machine` (`data-machine`, `data-status`), and check-behaviour per `checks-report-property` (`data-claim`). Every witness the run found is steppable on the diagram: each step is a `checks-witness-step` button, with **Prev** / **Next** / **Close** (`checks-witness-prev`, `checks-witness-next`, `checks-witness-close`) | `tab-checks`, `checks-result`, `checks-row`, `checks-row-select`, `checks-clear`, `checks-report`, `checks-witness-step`, `checks-witness-prev`, `checks-witness-next`, `checks-witness-close` |
| Text | The model as editable text, with **Apply text → model**; parse warnings fold to one line | `tab-text`, `text-editor`, `text-apply`, `text-editor-diags-toggle` |
| API Console | A console over the live SDK: queries, metrics, requirement satisfaction, where-used, commit | `tab-api`, `api-query`, `api-run`, `api-metrics` |
| Simulation | The interactive stepper: target, start, play, step, inject, scrub; a run stopped at a step it does not take says which | `tab-simulation`, `sim-target`, `sim-start`, `sim-step`, `sim-inject`, `sim-refused` |
| Versions | Commits, branches and a 3-way merge over the working model — in memory only. Switching to a branch, or a merge that resolves (it loads its result), asks first when the model has work no save holds — a commit holds it, as a save does — or unsaved changes to an attached Drive file; a merge that meets conflicts loads nothing and asks nothing | `tab-versions`, `version-commit-btn`, `version-branch-new`, `version-merge-btn` |

---

## Appendix B — keyboard shortcuts

Plain keys are suppressed while you are typing in a field. So are the `Ctrl/⌘`
ones — except `Ctrl/⌘ + S` and, where the deployment has Google Drive,
`Ctrl/⌘ + Shift + S`, which save from anywhere in the app, a field included: a
Properties box, the Explorer search, the Text view's editor. The browser's own
*Save page* dialog does not open. A box that
applies what you type on `Enter` or on leaving it — Properties' Subject, Tags,
Type and requirement attributes, a rename, a Requirements table cell — is
applied first, as leaving it would, so the save holds what is on screen; the
cursor stays where it was, except in a rename or a table cell, which close as
`Enter` closes them. The focus then goes to the toolbar's **Save** button, as
after a click on it, so the keys you press next do not delete anything:
`Backspace` and `Delete` are ignored while a button has focus, where they would
remove the selection — often the element you just renamed. The Requirements
table's reference picker, which leaving cancels, stays open with what you typed
in it, and nothing is linked. Plain `Enter` does the same without the save: in
an Explorer rename, the canvas context menu's rename box or a Requirements table
cell it closes the box and leaves the focus on **Save**, so a `Backspace` after
it deletes nothing. `Escape` closes the same boxes without writing what was
typed, and the focus goes to **Save** as well (the context menu's rename box
hands it back to its own *Rename* item). The same holds in the Requirements
table's reference picker — `Enter` on a candidate, a click on one, or `Escape`
closes it and leaves the focus on **Save** — and in the Regroup view's bundle
name and port name boxes. Every other key in a field stays the field's own.

`Ctrl/⌘ + S` also first applies what you typed in the Text view, as
**Apply text → model** does, so the save holds the text on screen — unless the
text has a syntax error, or a collaboration room is connected: then the
browser keeps the model as it stood and the editor still reads *modified — not
yet applied*; with no Drive file attached the strip under the toolbar says so,
and an attached Drive file gets a faulted text as typed. A change applied from
a field — the box the key is typed in, too — applies that text first and goes
in over it, so the save holds both ([§5](#the-text-tab-in-both-directions)).
Where the text could not go first it stands, and the save applies it as above:
over the field's change, which one Undo brings back.

| Key | What it does |
|---|---|
| `1` … `6` | General, Interconnection, Action, State, Requirement, Tree |
| `/` | Focus the Explorer search box |
| `Delete` / `Backspace` | Delete the selection (ignored while a button has focus) |
| `Ctrl/⌘ + Z` | Undo |
| `Ctrl/⌘ + Shift + Z`, `Ctrl/⌘ + Y` | Redo |
| `Ctrl/⌘ + S` | Save the project in this browser, from a field too (what you typed there applied first), text typed in the Text view applied first (not over a syntax error, nor in a collaboration room) — and, when the attached Google Drive file has unsaved changes, to that file too |
| `Ctrl/⌘ + Shift + S` | Save to Drive, when the deployment has Google Drive (nothing is sent while the Drive file has no unsaved changes); with no Drive file attached it opens *Save to Drive as…* |
| `Ctrl/⌘ + D` | Duplicate the selection |
| `Ctrl/⌘ + C` | Copy the selected subtrees (defers to native copy when text is selected) |
| `Ctrl/⌘ + V` | Paste under the selection |
| `Escape` | Disarm the palette tool, close a menu, cancel a rename |

There is no `Ctrl+N`; **New** is a button only.

**Source of truth:** `src/ui/commands.ts:39-106`, `200-435`, `src/ui/App.tsx:143-148`,
`src/ui/panels/RequirementsTable.tsx:575-651` (the reference picker).
