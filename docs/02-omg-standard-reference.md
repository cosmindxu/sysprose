# OMG SysML v2 Standard Family — Engineering Reference

> **Purpose.** A working reference for developers implementing a **browser-based SysML v2 modeler**. It collects, in one place, what the OMG normative specifications actually say (and where to find them), the structure of the KerML kernel, the user-facing textual and graphical notations, and — most importantly for our automation / data-analysis requirement — the **REST API & Services** resource and query model.
>
> **Provenance note.** Facts below are grounded in the OMG press materials, the OMG specification pages, and the `Systems-Modeling` GitHub reference codebases (see [Sources](#sources)). Where a specific detail comes from a Beta artifact (the final-adoption PDFs were still being editorially finalized for ISO submission at the time of writing) or from a reference implementation rather than the normative text, it is flagged inline with **[verify against final spec]**. Treat metaclass-exact and endpoint-exact details as authoritative only after checking the version you target.

---

## Table of Contents

1. [Standard Family Overview](#1-standard-family-overview)
   - 1.1 [The three linked specifications](#11-the-three-linked-specifications)
   - 1.2 [Document & version status (2025 adoption)](#12-document--version-status-2025-adoption)
   - 1.3 [Where to obtain the normative specs and reference code](#13-where-to-obtain-the-normative-specs-and-reference-code)
   - 1.4 [The 4-layer language architecture](#14-the-4-layer-language-architecture)
2. [The KerML Kernel](#2-the-kerml-kernel)
   - 2.1 [Root / Core / Kernel layers](#21-root--core--kernel-layers)
   - 2.2 [Key abstract-syntax metaclasses](#22-key-abstract-syntax-metaclasses)
   - 2.3 [Semantics: classification, featuring, type intersection](#23-semantics-classification-featuring-type-intersection)
   - 2.4 [How SysML v2 Definition/Usage specialize KerML Classifier/Feature](#24-how-sysml-v2-definitionusage-specialize-kerml-classifierfeature)
3. [SysML v2 Textual Notation](#3-sysml-v2-textual-notation)
   - 3.1 [Specialization operators, multiplicity, feature values](#31-specialization-operators-multiplicity-feature-values)
   - 3.2 [Construct catalog with example syntax](#32-construct-catalog-with-example-syntax)
   - 3.3 [One cohesive multi-construct snippet](#33-one-cohesive-multi-construct-snippet)
4. [SysML v2 Graphical Notation](#4-sysml-v2-graphical-notation)
   - 4.1 [View / diagram kinds](#41-view--diagram-kinds)
   - 4.2 [Node symbols](#42-node-symbols)
   - 4.3 [Edge symbols](#43-edge-symbols)
   - 4.4 [Mapping to SysML v1 / MagicDraw diagram equivalents](#44-mapping-to-sysml-v1--magicdraw-diagram-equivalents)
5. [SysML v2 API & Services (REST)](#5-sysml-v2-api--services-rest)
   - 5.1 [Architecture: PIM, PSMs, OpenAPI, OSLC](#51-architecture-pim-psms-openapi-oslc)
   - 5.2 [Resource model](#52-resource-model)
   - 5.3 [Version semantics: Project → Commit → Element](#53-version-semantics-project--commit--element)
   - 5.4 [The exchanged Element JSON shape](#54-the-exchanged-element-json-shape)
   - 5.5 [The Query language for analysis](#55-the-query-language-for-analysis)
   - 5.6 [Pagination](#56-pagination)
   - 5.7 [Endpoint summary](#57-endpoint-summary)
   - 5.8 [Implications for a browser-only modeler](#58-implications-for-a-browser-only-modeler)
6. [Sources](#sources)

---

## 1. Standard Family Overview

SysML v2 is not a single document. It is a **family of three interlocking OMG specifications** plus a stack of normative model libraries. Understanding the boundaries between them is the first thing an implementer must get right, because the abstract syntax, the user notations, and the wire/API format live in different specs and evolve on (mostly) shared but distinct version lines.

### 1.1 The three linked specifications

| Spec | Short name | What it defines | Role for a modeler |
|------|-----------|-----------------|--------------------|
| **Kernel Modeling Language** | KerML | The semantic and syntactic *foundation* — a general-purpose metamodel of types, features, classification and featuring, plus its own textual notation and a model-theoretic semantics. | The metamodel "engine under the hood." Your in-memory model graph ultimately bottoms out in KerML metaclasses. |
| **Systems Modeling Language v2** | SysML v2 | The systems-engineering language *layered on KerML*: the Definition/Usage pattern, parts/ports/connections/actions/states/requirements/etc., and the user-facing textual **and** graphical notations. | The language your users author. Drives your editor, palette, validation, and diagram rendering. |
| **Systems Modeling API and Services** | SysML v2 API (a.k.a. "API & Services") | A standard service interface for storing, versioning, querying, validating and exchanging SysML v2 / KerML models — defined as a Platform-Independent Model (PIM) with REST/HTTP and OSLC bindings. | The interoperability + automation backbone. Even a no-backend tool benefits from speaking this format for import/export and for talking to model repositories. |

OMG describes KerML v1.0 explicitly as providing **"the semantic and syntactic foundation for SysML v2,"** and the API & Services spec as the piece **"that enables SysML v2 models to interoperate with other models and tools"** ([OMG press release, 2025-07-21](https://www.omg.org/news/releases/pr2025/07-21-25.htm)).

The dependency direction is strict and one-way:

```
            ┌─────────────────────────────────────────────┐
            │   Systems Modeling API & Services v1.0       │  ← serializes / serves
            │   (REST/HTTP PSM + OSLC PSM over a PIM)       │     the metamodel below
            └─────────────────────────────────────────────┘
                              ▲ exchanges instances of
            ┌─────────────────────────────────────────────┐
            │   SysML v2.0  (systems modeling language)    │  ← extends / specializes
            │   Definition & Usage, domain libraries       │
            └─────────────────────────────────────────────┘
                              ▲ specializes metaclasses of
            ┌─────────────────────────────────────────────┐
            │   KerML v1.0  (kernel metamodel + semantics) │  ← the root metamodel
            └─────────────────────────────────────────────┘
```

### 1.2 Document & version status (2025 adoption)

- **Final adoption.** On **21 July 2025**, the OMG announced approval of the **final adoption** of **SysML v2.0**, **KerML v1.0**, and the **Systems Modeling API and Services v1.0** ([OMG press release](https://www.omg.org/news/releases/pr2025/07-21-25.htm); [globenewswire mirror](https://www.globenewswire.com/news-release/2025/07/21/3118925/0/en/OBJECT-MANAGEMENT-GROUP-APPROVES-FINAL-ADOPTION-OF-THE-SYSML-V2-SPECIFICATION.html)). The `SysML-v2-Release` README records the formal adoption as effective **30 June 2025**, with editorial updates ongoing for ISO submission ([SysML-v2-Release](https://github.com/Systems-Modeling/SysML-v2-Release)). Read the July 21 date as the public announcement and the June 30 date as the technical finalization milestone.
- **Prior Beta.** Beta versions of all three were adopted on **30 June 2023**; the publicly downloadable PDFs went through multiple Beta revisions (e.g. **KerML 1.0 Beta2**, **SysML 2.0 Beta**, **Systems Modeling API & Services 1.0 Beta1**) before final adoption ([OMG SysML v2 page](https://www.omg.org/sysml/sysmlv2/)).
- **Seven-year effort.** OMG characterizes the result as the cumulative work of many members over ~7 years, delivering improved *precision, expressiveness, consistency, usability, interoperability, and extensibility* over SysML v1, and — crucially for tooling — **formal semantics**, a **textual syntax** alongside the graphical one, and a **standard API** ([OMG press release](https://www.omg.org/news/releases/pr2025/07-21-25.htm)).

> **[verify against final spec]** Exact published version strings, document numbers (e.g. `formal/25-xx-xx`), and the SysML spec's two-part structure (Part 1: Language Specification; Part 2: SysML v1→v2 Transformation) should be re-confirmed on the OMG spec catalog for the precise revision you build against, since the final-adoption PDFs were still being editorially processed when this reference was compiled.

### 1.3 Where to obtain the normative specs and reference code

**OMG (normative documents):**

- SysML v2 landing page / catalog entry: <https://www.omg.org/sysml/sysmlv2/>
- KerML spec catalog: `https://www.omg.org/spec/KerML/` (v1.0; Beta PDFs under `…/KerML/1.0/Beta2/PDF`)
- SysML v2 spec catalog: `https://www.omg.org/spec/SysML/` (v2.0; Part 1 Language Specification, Part 2 Transformation)
- Systems Modeling API & Services catalog: `https://www.omg.org/spec/SystemsModelingAPI/` (v1.0; Beta1 PDF at `…/SystemsModelingAPI/1.0/Beta1/PDF`)
- OMG news / spec index: <https://www.omg.org/sysml/news-articles.htm>

**`Systems-Modeling` GitHub organization (reference implementation, libraries, examples):** <https://github.com/Systems-Modeling>

| Repository | Contents | URL |
|------------|----------|-----|
| **SysML-v2-Release** | **Start here.** Bundles the three spec PDFs (KerML 1.0, SysML 2.0 Parts 1–2, API & Services 1.0), textual/graphical-notation training decks, the **normative KerML & SysML model libraries** in three forms (textual `*.sysml`/`*.kerml`, `.kpar` "KerML Project Archive", and Ecore **XMI** with/without derived properties), Eclipse plugin installers, the Jupyter kernel, and example models. | <https://github.com/Systems-Modeling/SysML-v2-Release> |
| **SysML-v2-Pilot-Implementation** | Reference pilot of the **textual notation, parser/type-checker/name-resolver, and visualization**; built lock-step with the language spec. | <https://github.com/Systems-Modeling/SysML-v2-Pilot-Implementation> |
| **SysML-v2-API-Services** | Reference **REST/HTTP server** for the API & Services spec (Play framework + sbt, Java 11, PostgreSQL; Swagger UI at `/docs/`). 90+ tagged releases. | <https://github.com/Systems-Modeling/SysML-v2-API-Services> |
| **SysML-v2-API-Cookbook** | Jupyter-notebook "recipes" demonstrating real API workflows (projects, commits, elements, queries). | <https://github.com/Systems-Modeling/SysML-v2-API-Cookbook> |
| **SysML-v2-API-Java-Client / -Python-Client** | Generated client SDKs; their `api/openapi.yaml` and `docs/*.md` are a convenient, exact source for endpoint paths and request/response schemas. | <https://github.com/Systems-Modeling/SysML-v2-API-Python-Client> |

**OSLC binding (companion, OASIS):** the OSLC PSM of the API is mirrored as an OASIS OSLC Open Project specification — *OSLC Systems Modeling Language Version 2.0* — at <https://docs.oasis-open-projects.org/oslc-op/sysml/v2.0/psd01/sysml-spec.html>.

### 1.4 The 4-layer language architecture

Both KerML and SysML v2 are specified along the same **four conceptual layers**. Treat these as the columns of the standard; nearly every chapter of the specs slots into one of them.

1. **Abstract syntax (metamodel).** A MOF/Ecore metamodel of metaclasses (`Element`, `Type`, `Feature`, `Specialization`, …) with structural constraints. This is the canonical model graph — the thing your tool actually edits and serializes. It is notation-independent and serialization-independent. The XMI in `SysML-v2-Release` is this layer made concrete.
2. **Concrete syntax(es).** Two of them: the **textual notation** (a keyword grammar) and the **graphical notation** (diagram symbols). Both are *renderings* of the same abstract syntax; neither adds meaning. A robust modeler keeps the abstract syntax as the source of truth and treats text + diagrams as projections (this is exactly how the pilot tools and Eclipse SysON are organized).
3. **Semantics.** A **model-theoretic / declarative semantics** that interprets abstract-syntax models against a semantic domain of "things" and their classification. KerML grounds this formally and exposes it through a **semantic (base) model library**; SysML inherits it. This is what makes constraints, expressions, and analysis well-defined rather than merely conventional.
4. **Model libraries.** Normative, ship-with-the-language model content expressed *in the language itself*: KerML libraries (`Base`, `Links`, `Occurrences`, `Objects`, `Performances`, `Transfers`, `KerML semantic libraries`, …) and SysML domain + quantity/unit libraries (`Parts`, `Items`, `Actions`, `States`, `Requirements`, `Quantities`, `ISQ`, `SI`, `ScalarValues`, …). Every real model imports from these, so an implementation must bundle and resolve them. **[verify against final spec]** for the exact library package names in your target revision.

---

## 2. The KerML Kernel

KerML ("Kernel Modeling Language") is a general-purpose modeling language in its own right, but in practice it exists to be *the metamodel SysML v2 is built from*. Its design goal is a small, formally-grounded set of primitives — **types, features, and specialization** — rich enough that every SysML concept is a thin specialization of a KerML concept. ([DeepWiki: KerML](https://deepwiki.com/Systems-Modeling/SysML-v2-Release/2.1-kernel-modeling-language-(kerml)); [Medium: "KerML — The Engine Under the Hood"](https://medium.com/@md.waez/sysml-v2-lesson-2-kerml-the-engine-under-the-hood-b5292403a1b8))

### 2.1 Root / Core / Kernel layers

KerML's abstract syntax is itself stratified into three layers of increasing capability (a fourth "Systems" layer is where SysML attaches):

- **Root layer.** The pure *organizational* primitives, with **no engineering semantics**: how elements exist, are named, are contained, and are cross-referenced. Metaclasses: `Element`, `Relationship`, `Namespace`, `Membership` (and `OwningMembership`), `Import` (`MembershipImport`, `NamespaceImport`), plus annotation primitives (`Annotation`, `Comment`, `Documentation`, `TextualRepresentation`). This layer answers "what is in the model and what is named what," not "what does it mean."
- **Core layer.** The *classification engine*: the taxonomy of **`Type` → `Classifier` / `Feature`** and the relationships that order them — **`Specialization`** and its specializations **`Subclassification`** (between classifiers), **`FeatureTyping`**, **`Subsetting`**, **`Redefinition`** (between features), plus **`Conjugation`**, **`Disjoining`**, **`FeatureChaining`**, **`Featuring`**/`TypeFeaturing`, **`FeatureMembership`**, and **`Multiplicity`**. This is where classification and featuring semantics are introduced.
- **Kernel layer.** The *reusable modeling constructs* built on Core: classes & datatypes & structures (`Class`, `DataType`, `Structure`), associations & connectors (`Association`, `Connector`), behaviors/steps/functions (`Behavior`, `Step`, `Function`), **expressions** (`Expression` and its many subtypes), interactions and flows (`Interaction`, `ItemFlow`, `Succession`), predicates/invariants (`Predicate`, `BooleanExpression`, `Invariant`), packages, metadata (`Metaclass`, `MetadataFeature`), feature values, and multiplicities-in-use. ([DeepWiki: KerML](https://deepwiki.com/Systems-Modeling/SysML-v2-Release/2.1-kernel-modeling-language-(kerml)) summarizes the Kernel layer as providing "classes, data types, structure, associations, connectors, behaviors, interactions, functions, expressions, feature values, multiplicities, metadata, and packages.")

> Mental model: **Root = containment & naming. Core = classification & featuring. Kernel = the engineering vocabulary.** SysML = the Systems layer specializing the Kernel.

### 2.2 Key abstract-syntax metaclasses

The metaclasses an implementer touches constantly, grouped by layer. (Relationships in KerML are themselves **first-class `Element`s** — a point that matters enormously for the API's JSON shape; see §5.4.)

**Root (organization):**

| Metaclass | What it is |
|-----------|-----------|
| `Element` | The root of everything. *Every* modeling construct is an `Element`; carries identity (`elementId`), optional `name`/`shortName`, ownership. |
| `Relationship` | An `Element` that relates other elements (has `source` / `target` ends). Because it is an Element, relationships can themselves be named, owned, and annotated. |
| `Namespace` | An `Element` that *contains* members via memberships and exposes them by name; supports name resolution and imports. |
| `Membership` / `OwningMembership` | The reified link "Namespace ∋ memberElement." `OwningMembership` additionally implies *ownership* (composite containment). Memberships carry visibility (`public`/`private`/`protected`). |
| `FeatureMembership` | An `OwningMembership` specialized for features — "this Type owns this Feature." |
| `Import` (`MembershipImport`, `NamespaceImport`) | Brings names from another namespace into scope (`public`/`private`, recursive `::**`). |

**Core (classification):**

| Metaclass | What it is |
|-----------|-----------|
| `Type` | Anything that *classifies*. Abstract supertype of `Classifier` and `Feature`. Owns features, specializations, multiplicity. |
| `Classifier` | A `Type` that classifies **things** (entities) directly — categories like "Vehicle." |
| `Feature` | A `Type` that classifies things **in the context of another type** — a role/property/step. Has a *domain* (its featuring type) and *codomain* (its `type`). Features form ordered, multiplicity-bounded value sets. |
| `Specialization` | General supertype relationship: instances of the special type are a subset of the general type's instances. |
| `Subclassification` | `Specialization` between `Classifier`s (textual `:>`). |
| `FeatureTyping` | Relates a `Feature` to the `Type` that types it (textual `:`). |
| `Subsetting` | `Specialization` between `Feature`s: the values of one feature are a subset of another's (textual `:>`). |
| `Redefinition` | A `Subsetting` that **replaces/overrides** an inherited feature — same value set, new name/type/multiplicity (textual `:>>`). |
| `Conjugation` | Produces a "conjugated" type with input/output directions reversed — the basis of port conjugation (`~Port`). |
| `Multiplicity` (`MultiplicityRange`) | Lower/upper bound on a feature's value count (textual `[lo..hi]`, `[n]`, `[*]`). |

**Kernel (vocabulary) — most relevant subset:**

| Metaclass | What it is |
|-----------|-----------|
| `Class`, `Structure`, `DataType` | Kinds of `Classifier`: identity-bearing objects, composite structures, and pure data values respectively. |
| `Association`, `Connector` | Typed relationships between features (the basis of SysML connections/interfaces). |
| `Behavior`, `Step`, `Function` | Behavior classifiers, their usages (steps), and value-returning behaviors. |
| `Expression` (+ subtypes) | Computable features: `LiteralExpression`, `OperatorExpression`, `InvocationExpression`, `FeatureReferenceExpression`, `BooleanExpression`, `Invariant`, … — the basis of calc/constraint bodies. |
| `Succession`, `ItemFlow` | Ordering (control) and transfer (object flow) between steps/features. |
| `Package`, `Metaclass`, `MetadataFeature` | Model organization and user-defined metadata. |

### 2.3 Semantics: classification, featuring, type intersection

KerML's semantics are **set-theoretic / model-theoretic** rather than operational. A model is interpreted against a universe of **"things,"** and types denote *sets / sequences* of those things:

- **Classification.** A `Classifier` denotes the **set of things it classifies**. "`x` is an instance of `T`" means `x ∈ ⟦T⟧`. A `Specialization`/`Subclassification` `S :> G` asserts `⟦S⟧ ⊆ ⟦G⟧` — the special type's instances are a subset of the general's. This subset interpretation is the single mechanism behind all inheritance.
- **Featuring.** A `Feature` denotes not a flat set of things but a set of **sequences (tuples)** — pairs of "(the thing that has the feature, the thing that is the value)." A feature has a **featuring type** (its *domain*, the context type it characterizes) and a **type** (its *codomain*, what its values are). The `Featuring`/`TypeFeaturing` relationship records "feature `f` characterizes type `T`." Multiplicity then bounds how many values each domain element may have. Subsetting/redefinition between features are again subset assertions on these tuple sets. This "everything is a feature of something" stance is why SysML parts, attributes, ports, actions, and states are *all* uniformly Features.
- **Type intersection.** A type that specializes **multiple** general types is interpreted as the **intersection** of their instance sets: `T :> A, B` ⇒ `⟦T⟧ ⊆ ⟦A⟧ ∩ ⟦B⟧`. Multiple subsetting/typing composes the same way. This gives KerML a clean account of multiple classification and of "an element that is simultaneously an A and a B," which SysML leans on for variant/specialization modeling. (Conjugation and disjoining provide the complementary "reversed-direction" and "provably-disjoint" relations.)

KerML packages a **semantic base library** of model elements (e.g. `Base::Anything`, `Links`, `Occurrences`, `Performances`, `Transfers`) that operationalize these semantics inside the language, so that conformance can be checked model-to-model. A deeper academic treatment is *"An Analysis of the Semantic Foundation of KerML and SysML v2"* ([NEMO/UFES PDF](https://nemo.inf.ufes.br/wp-content/papercite-data/pdf/an_analysis_of_the_semantic_foundation_of_kerml_and_sysml_v2_2024.pdf)).

### 2.4 How SysML v2 Definition/Usage specialize KerML Classifier/Feature

SysML v2's signature pattern — **Definition vs. Usage** — is a direct restatement of KerML's **Classifier vs. Feature** distinction, dressed up with systems-engineering keywords:

- A SysML **`Definition`** (e.g. `PartDefinition`, `ItemDefinition`, `AttributeDefinition`, `PortDefinition`, `ActionDefinition`, `StateDefinition`, `ConnectionDefinition`, `InterfaceDefinition`, `ConstraintDefinition`, `RequirementDefinition`, `ViewDefinition`, …) is a **`Classifier`** — a reusable category/blueprint.
- A SysML **`Usage`** (e.g. `PartUsage`, `AttributeUsage`, `PortUsage`, `ActionUsage`, `StateUsage`, `ConnectionUsage`, `RequirementUsage`, …) is a **`Feature`** — a typed, multiplicity-bounded occurrence of a definition *within a context*.

So `part def Vehicle { … }` is a `PartDefinition` (a `Classifier`/`Structure`/occurrence), and `part v : Vehicle;` is a `PartUsage` (a `Feature` typed by `Vehicle` via `FeatureTyping`). Nesting a usage inside a definition is an `OwningMembership`/`FeatureMembership`; `:>`/`:>>` between usages are `Subsetting`/`Redefinition`. Behaviorally, `ActionDefinition` specializes KerML `Behavior` and `ActionUsage` specializes `Step`; `AttributeDefinition` specializes `DataType`; `ConnectionDefinition` specializes `Association`/`Structure`; `ConstraintDefinition` specializes `Predicate`/`BooleanExpression`. The SysML domain libraries supply the actual base classifiers (`Parts::Part`, `Items::Item`, `Actions::Action`, `States::StateAction`, `Requirements::RequirementCheck`, …) that every user definition implicitly subclassifies. ([SysML v2 Basics, Friedenthal](https://www.omgwiki.org/MBSE/lib/exe/fetch.php?media=mbse%3Asysml_v2_transition%3Asysml_v2_basics-incose_iw-sfriedenthal-2024-01-28.pdf))

**Implementation takeaway:** model the Definition/Usage duality once, generically, over a KerML `Classifier`/`Feature` core, and let each SysML keyword be metadata + a default base-library supertype. This mirrors how the pilot implementation and SysON structure their metamodels and is the cheapest path to broad coverage.

---

## 3. SysML v2 Textual Notation

The textual notation is the **primary authoring + interchange syntax** of SysML v2 (a genuine novelty versus v1, which had no normative textual form). It is a keyword grammar that maps deterministically onto the abstract syntax, so for a modeler it doubles as a serialization format and as a copy-paste interchange medium. Files use `.sysml` (and `.kerml` for raw KerML). Sources for this section: the [Sensmetry cheat sheet](https://sensmetry.com/sysml-cheatsheet/), [DeepWiki: SysML v2 Textual Notation](https://deepwiki.com/Systems-Modeling/SysML-v2-Release/2.2-sysml-v2-textual-notation), and [Friedenthal's SysML v2 Basics](https://www.omgwiki.org/MBSE/lib/exe/fetch.php?media=mbse%3Asysml_v2_transition%3Asysml_v2_basics-incose_iw-sfriedenthal-2024-01-28.pdf).

### 3.1 Specialization operators, multiplicity, feature values

These few operators carry most of the language's semantics; learn them first.

| Token | Name | Abstract syntax | Meaning |
|-------|------|-----------------|---------|
| `:` | **typing** | `FeatureTyping` | "is typed by" — gives a usage its definition. `bike : Vehicle`. |
| `:>` | **subsetting** (between usages) / **subclassification** (between definitions, also written with `specializes`) | `Subsetting` / `Subclassification` | "is a subset of" / "specializes." `part rearWheel :> wheels;`, `part def SportsCar :> Vehicle;`. |
| `:>>` | **redefinition** (the "sergeant" / chevrons) | `Redefinition` | overrides an inherited feature — rename / retype / re-multiply / re-default. `:>> wheels = 4;`. |
| `::>` | **reference subsetting** | `ReferenceSubsetting` (a Subsetting variant) | binds a *reference* usage to subset another feature (referential, not compositional). |
| `[lo..hi]`, `[n]`, `[*]` | **multiplicity** | `MultiplicityRange` | value-count bounds. `wheel : Wheel [4];`, `sensors : Sensor [1..*];`. |
| `=` | **feature value** | `FeatureValue` (bind) | default/bound value. `attribute mass = 1500 [kg];`. `:=` denotes an *initial* (re-evaluable) value. |
| `~` | **conjugation** | `Conjugation` | reverses port direction. `port p : ~PowerPort;`. |

Other pervasive tokens: `::` namespace qualification (`ISQ::mass`), `.` feature-chain access (`vehicle.engine.mass`), `@` metadata application, `#` metadata-tag shorthand, `//` and `/* */` comments, `doc /* … */` documentation. Visibility keywords `public` / `private` / `protected` precede memberships and imports.

> **Disambiguation:** `:>` is reused for both *subsetting* (usage↔usage) and *subclassification* (definition↔definition); which one it is depends on whether the related elements are Features or Classifiers — the parser decides from context. Definitions may also use the spelled-out keyword `specializes`; usages may use `subsets` / `redefines` / `references` as keyword equivalents of `:>` / `:>>` / `::>`.

### 3.2 Construct catalog with example syntax

Each construct follows the Definition (`<kind> def Name { … }`) → Usage (`<kind> name : Name;`) rhythm.

**Packages & imports**
```sysml
package VehicleModel {
    private import ISQ::*;            // bring quantities into scope
    public  import VehicleParts;     // re-export to importers
}
```

**Parts & attributes**
```sysml
part def Vehicle {
    attribute mass : MassValue;      // attribute usage typed by a value type
    part engine : Engine [1];        // nested part usage, multiplicity 1
}
attribute def MassValue :> ScalarValues::Real;   // attribute definition (a DataType)
part vehicle : Vehicle;                          // part usage at package level
```

**Items** (things that flow / are conserved)
```sysml
item def Fuel { attribute fuelMass :> ISQ::mass; }
item fuel : Fuel;
```

**Ports & direction**
```sysml
port def FuelPort {
    out fuelOut : Fuel;              // directed features: out / in / inout
    in  signal  : Boolean;
}
part fuelTank { port supply : FuelPort; }
part engine   { port intake : ~FuelPort; }   // conjugated: directions reversed
```

**Interfaces & connections**
```sysml
interface def FuelInterface {
    end supplyPort : FuelPort;
    end intakePort : ~FuelPort;
}
connection def FuelLine { end : FuelPort; end : ~FuelPort; }
// usage-level wiring:
connect fuelTank.supply to engine.intake;                 // simple connect
interface fuelIfc : FuelInterface connect fuelTank.supply to engine.intake;
```

**Actions & control nodes**
```sysml
action def Drive {
    in  throttle : Real;
    out speed    : SpeedValue;

    action accelerate { in cmd : Real; out v : SpeedValue; }
    action brake;

    first start;                       // start node
    then fork forkNode;                // fork: parallel outgoing
        then accelerate;
        then monitor;
    join joinNode;                     // join: synchronize
    merge mergeNode;                   // merge: combine alternatives
    decide d;                          // decision: guarded outgoing
        if speed > 120 then brake;
    succession a then b;               // explicit control succession
    flow accelerate.v to monitor.in;   // object flow (item flow)
}
```

**States & transitions**
```sysml
state def VehicleStates {
    entry; do; exit;                   // state behaviors
    state off;
    state running {
        entry action warmup;
    }
    transition off_to_running
        first off
        accept startSignal             // trigger
        if batteryOk                   // guard
        do action ignite               // effect
        then running;
}
```

**Calculations & constraints**
```sysml
calc def Average { in values : Real[*]; return : Real = sum(values) / size(values); }

constraint def MassBudget {
    in actual : MassValue;
    in limit  : MassValue;
    actual <= limit                    // boolean expression body
}
part vehicle2 : Vehicle {
    assert constraint massOk : MassBudget { in actual = mass; in limit = 1800 [kg]; }
}
```

**Requirements** (with subject / require / assume) **& satisfy**
```sysml
requirement def MassRequirement {
    subject vehicle : Vehicle;                 // the thing under requirement
    attribute massLimit : MassValue = 1800 [kg];
    assume constraint { vehicle.fuel > 0 }     // assumption
    require constraint { vehicle.mass <= massLimit }  // required constraint
}
part myVehicle : Vehicle;
satisfy MassRequirement by myVehicle;          // satisfy assertion
```

**Allocation** (cross-cutting mapping, e.g. function→component)
```sysml
allocation def FnToComp { end : Drive; end : Vehicle; }
allocate driveBehavior to vehicle;             // allocation usage
```

**Views, viewpoints, rendering**
```sysml
viewpoint stakeholderConcern { require constraint { /* concern */ } }
view def SafetyView {
    satisfy stakeholderConcern;
    expose VehicleModel::**;                    // model elements to show
    render asTreeDiagram;                        // rendering directive
}
```

**Enumerations**
```sysml
enum def Gear { enum park; enum drive; enum reverse; }
attribute selectedGear : Gear = Gear::park;
```

**Occurrences** (space-time individuals; the base of parts/actions/states)
```sysml
occurrence def Lifecycle;
occurrence vehicleLife : Lifecycle;
```

**Metadata**
```sysml
metadata def Status { attribute approved : Boolean; }
@Status { approved = true; }                    // applied to the following element
part criticalPart : Vehicle;
```

### 3.3 One cohesive multi-construct snippet

A single, self-consistent model exercising packages, definitions, usages, ports, connections, actions, states, constraints, requirements, allocation, and the operators:

```sysml
package VehicleExample {
    private import ScalarValues::*;
    private import ISQ::*;

    // ---- Value & item types -------------------------------------------------
    attribute def MassValue  :> ISQ::mass;
    attribute def SpeedValue :> ISQ::speed;
    item def Fuel { attribute fuelMass :> ISQ::mass; }

    // ---- Ports --------------------------------------------------------------
    port def FuelPort { out fuelOut : Fuel; in  level : Real; }

    // ---- Structural definitions --------------------------------------------
    part def Engine {
        attribute power : Real;
        port intake : ~FuelPort;            // conjugated port
        action ignite;
    }

    part def Vehicle {
        attribute mass : MassValue;
        attribute maxSpeed : SpeedValue;

        part engine : Engine [1];
        part fuelTank {
            attribute capacity : MassValue = 60 [kg];
            port supply : FuelPort;
        }

        // composite wiring between owned parts
        connect fuelTank.supply to engine.intake;
    }

    // Specialization (subclassification) + redefinition of an inherited feature
    part def SportsCar :> Vehicle {
        attribute :>> maxSpeed = 300 [km/h];    // redefine inherited attribute
        part engine :>> engine : TurboEngine;   // redefine inherited part
    }
    part def TurboEngine :> Engine { attribute :>> power = 400; }

    // ---- Behavior: action with control nodes & object flow ------------------
    action def DriveCycle {
        in  throttle : Real;
        out speed    : SpeedValue;

        first start;
        then fork f;
            then action accelerate { out v : SpeedValue; }
            then action monitorFuel;
        join j;
        decide d;
            if accelerate.v > maxSpeedLimit then action limitSpeed;
        flow accelerate.v to speed;
    }
    attribute maxSpeedLimit : SpeedValue = 250 [km/h];

    // ---- Behavior: state machine -------------------------------------------
    state def VehicleStates {
        state parked;
        state driving { entry action engageDrive; }
        transition parked
            accept ignitionOn if fuelAvailable do action crank then driving;
    }

    // ---- Analysis: constraint + requirement + satisfy + allocate -----------
    constraint def MassBudget { in m : MassValue; in lim : MassValue; m <= lim }

    requirement def MassReq {
        subject v : Vehicle;
        attribute limit : MassValue = 1800 [kg];
        assume  constraint { v.fuelTank.capacity > 0 [kg] }
        require constraint massOk : MassBudget { in m = v.mass; in lim = limit; }
    }

    part myCar : SportsCar;
    satisfy MassReq by myCar;

    allocation def BehaviorToStructure { end : DriveCycle; end : Vehicle; }
    allocate DriveCycle to myCar;

    // ---- View --------------------------------------------------------------
    view def OverviewView { expose VehicleExample::**; render asTreeDiagram; }
}
```

---

## 4. SysML v2 Graphical Notation

The graphical notation is a **second concrete syntax** over the same abstract syntax — i.e., a diagram is a *view onto* model elements, never an independent artifact. This is a deliberate break from SysML v1, where diagrams were the primary unit. In v2 you `expose` model elements into a view and the renderer lays them out; the model owns the truth. Sources: [SysON overview](https://doc.mbse-syson.org/syson/main/user-manual/features/sysmlv2-overview.html), [Friedenthal/SST overview & demo](https://www.incose.org/docs/default-source/working-groups/mbse-initiative/sysml-2-documents/sysml_v2_overview_demo.pdf), [Rajamani, "Key Differences v1 vs v2"](https://dinesh-kumar-rajamani.medium.com/key-differences-between-sysml-v1-and-sysml-v2-b035d4e3faad).

> **[verify against final spec]** The SysML v2 spec (Part 1) defines the normative diagram/notation set and exact symbol shapes; the names below combine the spec's view kinds with the SysON reference tool's view catalog, which is the most concrete public implementation. Confirm symbol minutiae against Part 1's "Graphical Notation" chapter for your target revision.

### 4.1 View / diagram kinds

| View kind | Shows | Loose SysML v1 analogue |
|-----------|-------|--------------------------|
| **General view / Definition view** | High-level structure: definitions and usages, their specializations and features, free mix of element kinds. The default "canvas." | Block Definition Diagram (BDD) |
| **Interconnection view / Internal view** | The encapsulated internals of a usage: nested parts, their ports, and the connections/interfaces/flows wiring them. | Internal Block Diagram (IBD) |
| **Action Flow view (Activity)** | Behavioral flow: actions as steps, control nodes (fork/join/merge/decision), successions, and object/item flows. | Activity Diagram |
| **State Transition view** | States and transitions with trigger/guard/effect; entry/do/exit behaviors. | State Machine Diagram |
| **Sequence view** | Lifelines and time-ordered message/event occurrences between them. | Sequence Diagram |
| **Requirement view** | Requirement definitions/usages, `subject`/`require`/`assume`, and `satisfy`/`derive`/`refine` relations. | Requirement Diagram |
| **Case / Analysis view** | Analysis, verification, and use cases (`analysis case`, `verification case`, `use case`) with their subjects, objectives, and results. | Parametric / Use-Case Diagrams (combined) |
| **Allocation (matrix)** | Cross-cutting `allocate` mappings, typically rendered as a matrix/table (e.g. function→component). | Allocation tables / matrices |
| **Package / tree (Browser) view** | The ownership/membership hierarchy from an exposed root — a containment tree. | Package Diagram / Model Browser |
| **Grid view** | Exposed elements + relationships arranged in a rectangular grid/table. | (Tabular views / generic tables) |
| **Geometry view** | 2D/3D spatial visualization of exposed spatial items. | (No direct v1 equivalent) |

### 4.2 Node symbols

- **Boxes for definitions and usages.** Elements render as rectangles. The **keyword in guillemets** at the top distinguishes kind and Definition-vs-Usage, e.g. `«part def»`, `«part»`, `«attribute»`, `«port def»`, `«action»`, `«state»`, `«requirement»`, `«connection def»`, `«interface»`, `«view»`. A name compartment follows (`name : Type [mult]`).
- **Compartments.** A box subdivides into labeled compartments listing owned features by category — e.g. `attributes`, `parts`, `ports`, `actions`, `states`, `references`, `constraints`, `requirements`. Compartments are the diagrammatic image of owned memberships.
- **Ports as boundary squares.** Ports appear as small **squares on the box boundary**; direction (`in`/`out`/`inout`) and conjugation (`~`) are indicated by the port symbol/label. Proxy/full port distinctions and flow directions are shown at the port.
- **Usage vs. definition styling.** Usages reference their definition via the `: Type` label; definitions are the standalone classifiers. Multiplicity `[n]` annotates usages.
- **Control nodes** (Action Flow view): fork/join as **bars**, decision/merge as **diamonds**, initial/`first` as a filled dot, `done`/final as a bordered dot — analogous to UML/SysML v1 activity nodes.
- **States** (State Transition view): rounded rectangles with optional entry/do/exit compartments; initial pseudostate as a filled dot.
- **Lifelines** (Sequence view): box header atop a vertical dashed lifeline with activation bars.

### 4.3 Edge symbols

| Relationship | Symbol |
|--------------|--------|
| **Composition** (owned/composite part) | line with a **filled diamond** at the owner end |
| **Reference** (referential feature) | line with an **open (hollow) diamond** at the owner end |
| **Connection / connector** | plain solid line between port/feature ends (the `connect`/connection usage) |
| **Succession** (control flow) | solid **arrow** between steps/states |
| **Item / object flow** | arrow (often with a flow/transfer adornment) carrying items between features |
| **Specialization / subclassification** | solid line with a **hollow (open) triangle** arrowhead pointing to the general type |
| **Subsetting / redefinition** | specialization-style line variants (redefinition typically annotated `:>>` / "redefines") |
| **Dependency** | **dashed** line with open arrowhead |
| **Satisfy / allocate / derive / refine** | dashed dependency-style lines with the relevant **«keyword»** label (`«satisfy»`, `«allocate»`, …) |

### 4.4 Mapping to SysML v1 / MagicDraw diagram equivalents

For teams migrating from MagicDraw / Cameo / SysML v1, the mental mapping is:

- **BDD → General/Definition view.** Blocks become `part def`/`item def`/`attribute def`; "block compartments" become feature compartments.
- **IBD → Interconnection/Internal view.** Parts-with-ports-and-connectors map almost 1:1; v2 ports-on-boundary and connection lines are the direct analogues.
- **Activity Diagram → Action Flow view.** Actions, control nodes, and pins map to actions, control nodes, and directed (`in`/`out`) parameters; object flows → item flows.
- **State Machine → State Transition view.** States and transitions map directly; trigger/guard/effect become `accept`/`if`/`do`.
- **Sequence Diagram → Sequence view.** Lifelines and messages map directly.
- **Requirement Diagram → Requirement view.** v1 requirement boxes + «satisfy»/«derive»/«verify» become requirement definitions/usages + `satisfy`/`derive`/`refine`. v2 adds `subject`/`require`/`assume` first-class.
- **Parametric Diagram → constraints/calc in General or Case views.** v1 constraint blocks + binding connectors become `constraint def`/`calc def` with `assert`/bound parameters.
- **Allocation tables → Allocation matrix view.**

A key behavioral difference for tool builders: in v1 the diagram could *own* elements; in v2 every diagram is a non-owning **projection** (`expose` + `render`), so a v2 tool must keep diagram layout/styling in a *separate* concern from the model (the spec does not yet standardize a graphical-interchange format — confirm current status before designing persistence).

---

## 5. SysML v2 API & Services (REST)

**This is the most important section for our automation / data-analysis requirement.** The API & Services spec turns "a model" into a **versioned, queryable repository resource** with a standard HTTP contract. Even a no-backend, browser-only modeler benefits from (a) speaking this JSON element shape natively so import/export and repository sync are trivial, and (b) supporting the standard **Query** language so analysis logic is portable to any conformant server. Sources: [API & Services repo](https://github.com/Systems-Modeling/SysML-v2-API-Services), [Part 3 PSM PDF](https://www.omg.org/spec/SystemsModelingAPI/1.0/Beta1/PDF), the generated [Python client docs](https://github.com/Systems-Modeling/SysML-v2-API-Python-Client/blob/master/docs/QueryApi.md) and [Java client `openapi.yaml`](https://raw.githubusercontent.com/Systems-Modeling/SysML-v2-API-Java-Client/master/api/openapi.yaml), and the [API Cookbook](https://github.com/Systems-Modeling/SysML-v2-API-Cookbook).

### 5.1 Architecture: PIM, PSMs, OpenAPI, OSLC

The spec is layered like the language itself:

- A **Platform-Independent Model (PIM)** defines the services abstractly (project/version management, element CRUD, query, etc.).
- Two **Platform-Specific Models (PSMs)** bind the PIM:
  - **REST/HTTP PSM** — an HTTP API described by an **OpenAPI 3.1** document, serializing resources as **JSON / JSON-LD**, with a fully discoverable JSON-Schema of the SysML v2 metamodel, plus **paging** and **storable queries**. This is the PSM you target.
  - **OSLC PSM** — a binding as **OSLC** (Open Services for Lifecycle Collaboration) linked-data services, for ALM/PLM-style tool integration (mirrored as an [OASIS OSLC SysML v2.0 spec](https://docs.oasis-open-projects.org/oslc-op/sysml/v2.0/psd01/sysml-spec.html)).

The reference REST server (`SysML-v2-API-Services`) is a Play/sbt/Java app over PostgreSQL exposing Swagger UI at `/docs/`; the SST also hosts public demo servers that conformant clients can hit directly.

### 5.2 Resource model

The REST resources, in two tiers:

**Repository / version-control tier** (mutable repository structure):

| Resource | Identity | Notes |
|----------|----------|-------|
| **Project** | UUID | Top-level container; owns branches, tags, commits. Has a default branch. |
| **Branch** | UUID | A *named, movable pointer* to a commit (the head of a line of development). |
| **Tag** | UUID | A *named, immutable pointer* to a specific commit (a labeled snapshot). |
| **Commit** | UUID | An **immutable** set of element changes relative to one or more previous commits — the unit of versioned content. |

**Model-content tier** (read at a commit, written via a commit):

| Resource | Identity | Notes |
|----------|----------|-------|
| **Element** | UUID (`@id` / `identifier`) | Any KerML/SysML metamodel instance (a `PartUsage`, `AttributeDefinition`, etc.). The atomic unit of model content. |
| **Relationship** | UUID | A *kind of Element* (KerML relationships are Elements) — queried via the relationships endpoint with directional filtering. |
| **Query** | UUID | A **storable** search definition (scope + select + constraint tree) that can be saved and re-executed. |
| **Diff** | — | Difference between two commits. **[verify against final spec]** — a comparison capability exists conceptually; some published client `openapi.yaml` snapshots do **not** expose a dedicated `Diff` path, while other server builds do. Confirm against the exact server/version you integrate. |

This is intentionally **Git-like**: *projects contain commits; commits are immutable; branches and tags are the only mutable things and they merely point at commits.*

### 5.3 Version semantics: Project → Commit → Element

The core navigation pattern your client revolves around:

```
Project ──has──▶ Branch (movable head) ──points to──▶ Commit (immutable)
   │                                                     │
   ├──has──▶ Tag (fixed label) ──points to──────────────┘
   │                                                     │
   └──has──▶ Commit ──contains/changes──▶ Element (read AT a commit)
```

- **Elements are read *at a commit*.** You never fetch "the element"; you fetch the element *as of* `commitId`: `GET /projects/{projectId}/commits/{commitId}/elements/{elementId}`. This gives reproducible, time-travelable reads.
- **Commits are immutable; writes create new commits.** To change the model you `POST` a **commit** containing change records (create/update/delete). Each change references elements and relationships; the server produces a new immutable commit and (typically) advances a branch head.
- **Branches and tags resolve to commits.** Resolve a branch/tag to its `commitId`, then read elements at that commit. Branch heads move on new commits; tags do not.
- **Roots.** `GET …/commits/{commitId}/roots` returns the top-level (un-owned) elements at that commit — your entry point for walking the ownership tree.

### 5.4 The exchanged Element JSON shape

The wire format is **JSON / JSON-LD** keyed on the metamodel. The defining characteristics:

- **`@id`** — the element's UUID (also surfaced as `identifier`).
- **`@type`** — the metaclass name (e.g. `"PartUsage"`, `"AttributeDefinition"`, `"OwningMembership"`, `"FeatureTyping"`). This single field tells your renderer/parser what the element *is*.
- **Relationships are first-class, reified Elements.** Because KerML relationships *are* Elements, containment and specialization are not nested objects but **separate elements referenced by id**. An element exposes arrays like **`ownedRelationship`** (and, derived, `ownedElement`, `ownedMember`, `owningRelationship`, …) whose entries are `{"@id": "…"}` references to relationship elements (e.g. an `OwningMembership` whose `memberElement` points to the contained element). To reconstruct the tree you resolve these reified links — you do **not** get a single deeply-nested JSON blob.
- **Open/extensible shape.** Beyond `@id`/`@type`/`identifier`, schemas use `additionalProperties` so metaclass-specific fields (`name`, `shortName`, `multiplicity`, `direction`, `value`, …) ride along. The OpenAPI document carries a discoverable JSON-Schema of the entire metamodel so clients can validate and introspect.

Illustrative shape (abbreviated):
```json
{
  "@id": "5e1f…-uuid",
  "@type": "PartUsage",
  "identifier": "5e1f…-uuid",
  "declaredName": "engine",
  "ownedRelationship": [
    { "@id": "a3c2…-uuid" }        // e.g. a FeatureTyping → Engine, resolved separately
  ],
  "owningRelationship": { "@id": "77b0…-uuid" }   // the OwningMembership that contains this
}
```

**Implementation takeaway:** build your in-memory store as a **flat map of `@id → element`** plus an index over `ownedRelationship`/`owningRelationship`, and reconstruct ownership and typing by **dereferencing relationship elements**. This matches the API exactly and makes round-tripping to the standard JSON trivial.

### 5.5 The Query language for analysis

This is the part to invest in for data-analysis features. A **Query** is a structured (not SQL/text) object that the server evaluates **against the elements of a project at a commit**, returning matching elements (optionally projected). Its shape (from the reference OpenAPI):

```jsonc
{
  "@type": "Query",
  "scope":  [ /* DataIdentity refs — which commit/elements to evaluate against */ ],
  "select": [ "name", "@type", "..." ],          // projection: which fields to return
  "where":  { /* a Constraint tree (see below) */ }
}
```

- **`scope`** narrows what the query runs over (e.g. a particular commit / element subtree). The **commit** to evaluate against is supplied when executing (a `commitId` parameter), giving reproducible, version-pinned analysis.
- **`select`** is a **projection**: an array of property names to return instead of whole elements — ideal for tabular/data-analysis output.
- **`where`** is a **constraint tree** built from two node kinds:

  **`PrimitiveConstraint`** — a leaf test on one property:
  ```jsonc
  { "@type": "PrimitiveConstraint",
    "property": "name",
    "operator": "=",          // one of "=", ">", "<"  (+ inversion via "inverse")
    "value":    "Vehicle",
    "inverse":  false }
  ```

  **`CompositeConstraint`** — a boolean combination of child constraints:
  ```jsonc
  { "@type": "CompositeConstraint",
    "operator": "and",        // "and" | "or"  (negation via PrimitiveConstraint.inverse)
    "constraint": [ /* nested PrimitiveConstraint / CompositeConstraint nodes */ ] }
  ```

  These compose recursively into arbitrary boolean trees — e.g. *"(`@type` = `PartUsage`) AND ((`name` = `engine`) OR (`name` = `motor`))."* ([reference `openapi.yaml`](https://raw.githubusercontent.com/Systems-Modeling/SysML-v2-API-Java-Client/master/api/openapi.yaml))

- **Stored vs. ad-hoc execution.** A query may be **saved** (`POST /projects/{projectId}/queries` → gets a `queryId`) and later **executed** by id (`GET /projects/{projectId}/queries/{queryId}/results`), or run **inline** without saving (`POST /projects/{projectId}/query-results`, or `GET /projects/{projectId}/query-results` for clients that put the query in parameters). Results are a `list[Element]` (or projected rows) at the chosen commit. ([Python client QueryApi](https://github.com/Systems-Modeling/SysML-v2-API-Python-Client/blob/master/docs/QueryApi.md))

> **[verify against final spec]** Operator enumerations (`=`,`>`,`<`; `and`,`or`) and field names (`property`, `value`, `inverse`, `scope`, `select`) above are taken from the reference client OpenAPI; richer operators or property-path support may appear in the final normative PSM. Validate against the OpenAPI document served by your target endpoint (it is self-describing).

### 5.6 Pagination

Collection endpoints (`/projects`, `/commits`, `/elements`, query results, …) are **paged**. The REST PSM uses cursor/offset-style paging with page-size parameters and conveys next/prev page links via **HTTP `Link` headers** (RFC 5988 style) alongside the JSON array body. Clients must follow links / pass the page parameters to retrieve large element sets rather than assuming a single response. **[verify against final spec]** for exact parameter names (`page[after]` / `page[size]` vs. `pageAfter`/`pageSize`) and header conventions in your server build.

### 5.7 Endpoint summary

Canonical paths from the reference OpenAPI (all JSON; `{…}` are UUIDs):

**Projects**
- `GET /projects` · `POST /projects`
- `GET /projects/{projectId}` · `PUT /projects/{projectId}` · `DELETE /projects/{projectId}`

**Branches**
- `GET /projects/{projectId}/branches` · `POST /projects/{projectId}/branches`
- `GET /projects/{projectId}/branches/{branchId}` · `DELETE /projects/{projectId}/branches/{branchId}`

**Tags**
- `GET /projects/{projectId}/tags` · `POST /projects/{projectId}/tags`
- `GET /projects/{projectId}/tags/{tagId}` · `DELETE /projects/{projectId}/tags/{tagId}`

**Commits** (write path for model content)
- `GET /projects/{projectId}/commits` · `POST /projects/{projectId}/commits`
- `GET /projects/{projectId}/commits/{commitId}`
- Commit request bodies include `ElementCommitRequest`, `RelationshipCommitRequest`, `ProjectUsageCommitRequest` (create/update/delete change records).

**Elements (read at a commit)**
- `GET /projects/{projectId}/commits/{commitId}/elements`
- `GET /projects/{projectId}/commits/{commitId}/elements/{elementId}`
- `GET /projects/{projectId}/commits/{commitId}/roots`
- `GET /projects/{projectId}/commits/{commitId}/elements/{relatedElementId}/relationships` (directional relationship lookup)

**Queries**
- `GET /projects/{projectId}/queries` · `POST /projects/{projectId}/queries`
- `GET /projects/{projectId}/queries/{queryId}` · `DELETE /projects/{projectId}/queries/{queryId}`
- `GET /projects/{projectId}/queries/{queryId}/results` (run saved)
- `GET /projects/{projectId}/query-results` · `POST /projects/{projectId}/query-results` (run inline)

**Other** (reference server): `POST /transform`, `POST /validate` exist on some builds; the self-served OpenAPI/Swagger at `/docs/` is the authoritative endpoint list for a given deployment.

### 5.8 Implications for a browser-only modeler

- **Adopt the JSON element shape as your native model format.** A flat `@id → element` store with reified `ownedRelationship` links makes import/export to any conformant API a no-op and matches the metamodel exactly (§5.4).
- **Implement the Query constraint tree in-browser.** Because the query model is plain JSON (PrimitiveConstraint/CompositeConstraint + select + scope), you can evaluate it client-side over your local store *and* forward it unchanged to a remote server — one analysis language for both offline and connected modes (§5.5).
- **Model versions Git-style locally.** Mirror the Project→Branch/Tag→Commit→Element semantics in IndexedDB/OPFS so local history and (later) server sync use the same mental model (§5.3).
- **Bundle the normative libraries.** Name resolution of `ISQ::mass`, `ScalarValues::Real`, `Parts::Part`, etc. requires the KerML/SysML model libraries from `SysML-v2-Release` to be present and importable (§1.3, §1.4).
- **Treat the served OpenAPI as ground truth.** It is self-describing (full metamodel JSON-Schema); generate/validate against the actual endpoint rather than hard-coding field names.

---

## Sources

**OMG / normative**
- OMG press release, final adoption (2025-07-21): <https://www.omg.org/news/releases/pr2025/07-21-25.htm>
- GlobeNewswire mirror of the release: <https://www.globenewswire.com/news-release/2025/07/21/3118925/0/en/OBJECT-MANAGEMENT-GROUP-APPROVES-FINAL-ADOPTION-OF-THE-SYSML-V2-SPECIFICATION.html>
- OMG SysML v2 page: <https://www.omg.org/sysml/sysmlv2/>
- OMG SysML news & articles: <https://www.omg.org/sysml/news-articles.htm>
- KerML spec catalog: <https://www.omg.org/spec/KerML/>
- SysML v2 spec catalog: <https://www.omg.org/spec/SysML/>
- Systems Modeling API & Services spec catalog: <https://www.omg.org/spec/SystemsModelingAPI/>
- API & Services Part 3 (REST/HTTP PSM) Beta1 PDF: <https://www.omg.org/spec/SystemsModelingAPI/1.0/Beta1/PDF>
- OASIS OSLC SysML v2.0 (OSLC PSM): <https://docs.oasis-open-projects.org/oslc-op/sysml/v2.0/psd01/sysml-spec.html>

**Reference implementation & libraries (`Systems-Modeling` org)**
- SysML-v2-Release: <https://github.com/Systems-Modeling/SysML-v2-Release>
- SysML-v2-Pilot-Implementation: <https://github.com/Systems-Modeling/SysML-v2-Pilot-Implementation>
- SysML-v2-API-Services: <https://github.com/Systems-Modeling/SysML-v2-API-Services>
- SysML-v2-API-Cookbook: <https://github.com/Systems-Modeling/SysML-v2-API-Cookbook>
- SysML-v2-API-Python-Client (QueryApi docs): <https://github.com/Systems-Modeling/SysML-v2-API-Python-Client/blob/master/docs/QueryApi.md>
- SysML-v2-API-Java-Client OpenAPI (`openapi.yaml`): <https://raw.githubusercontent.com/Systems-Modeling/SysML-v2-API-Java-Client/master/api/openapi.yaml>

**Explanatory / community (used to corroborate, not normative)**
- DeepWiki — KerML: <https://deepwiki.com/Systems-Modeling/SysML-v2-Release/2.1-kernel-modeling-language-(kerml)>
- DeepWiki — SysML v2 Textual Notation: <https://deepwiki.com/Systems-Modeling/SysML-v2-Release/2.2-sysml-v2-textual-notation>
- DeepWiki — Systems Modeling API & Services: <https://deepwiki.com/Systems-Modeling/SysML-v2-Release/4-systems-modeling-api-and-services>
- Sensmetry — SysML v2 textual notation cheat sheet: <https://sensmetry.com/sysml-cheatsheet/>
- Friedenthal — SysML v2 Basics (INCOSE IW 2024): <https://www.omgwiki.org/MBSE/lib/exe/fetch.php?media=mbse%3Asysml_v2_transition%3Asysml_v2_basics-incose_iw-sfriedenthal-2024-01-28.pdf>
- Friedenthal / SST — SysML v2 Overview & Demo: <https://www.incose.org/docs/default-source/working-groups/mbse-initiative/sysml-2-documents/sysml_v2_overview_demo.pdf>
- SysON — SysML v2 graphical overview: <https://doc.mbse-syson.org/syson/main/user-manual/features/sysmlv2-overview.html>
- Rajamani — Key differences SysML v1 vs v2: <https://dinesh-kumar-rajamani.medium.com/key-differences-between-sysml-v1-and-sysml-v2-b035d4e3faad>
- Waez — "KerML: The Engine Under the Hood": <https://medium.com/@md.waez/sysml-v2-lesson-2-kerml-the-engine-under-the-hood-b5292403a1b8>
- "An Analysis of the Semantic Foundation of KerML and SysML v2" (NEMO/UFES): <https://nemo.inf.ufes.br/wp-content/papercite-data/pdf/an_analysis_of_the_semantic_foundation_of_kerml_and_sysml_v2_2024.pdf>

---

*Compiled 2026-06-30. Items marked **[verify against final spec]** depend on the precise (final-adoption vs. Beta) revision you target; re-check them against the OMG-published PDFs and the self-describing OpenAPI document of your chosen API endpoint.*
