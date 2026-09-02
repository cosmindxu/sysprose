# State of the Art: Browser-Based SysML v2 Modeling

## Introduction

This document surveys the landscape relevant to building a **purely browser-based, client-side SysML v2 modeler**. The timing is deliberate: on **21 July 2025 the OMG approved the final adoption** of three linked specifications — **SysML v2.0**, **KerML v1.0**, and the **Systems Modeling API and Services v1.0** ([omg.org press release](https://www.omg.org/news/releases/pr2025/07-21-25.htm); [omg.org/sysml/sysmlv2](https://www.omg.org/sysml/sysmlv2/)) — turning a decade of standardization into a stable target that every tool vendor is now building against. The API & Services spec is the most consequential part for tooling, because it defines a **standard REST/HTTP interface** for model access, persistence, querying, validation, and interoperability.

The survey is organized around the building blocks a new modeler must either reuse or replace:

1. **Existing web-based SysML v2 tools** — Eclipse SysON as the reference open-source browser modeler.
2. **The canonical reference implementation** — the OMG Systems-Modeling pilot codebases (textual parser, Jupyter kernel, REST API server, normative libraries).
3. **TypeScript/Langium tooling** — SysIDE/Syside and the Langium framework that make in-browser SysML v2 language tooling feasible.
4. **Commercial tools & roadmaps** — Dassault, PTC, IBM, Sparx, Capella/Eclipse, and the broader vendor ecosystem.
5. **Browser diagramming & layout frameworks** — GLSP, Sprotty, maxGraph, JointJS, React Flow, diagram-js, ELK/elkjs, Yjs.
6. **In-browser persistence & serialization** — IndexedDB/Dexie, OPFS, File System Access API, and the SysML v2 JSON / textual interchange formats.

A **comparison table** of the existing tools and a closing **Gaps & opportunities** subsection conclude the document.

A recurring theme across the entire landscape: most vendors are shipping **SysML v2 alongside v1** (not as a replacement), authoring is **still mostly desktop**, and everyone is converging on the **standard REST API** as the integration backbone. A pure-browser, no-backend modeler is therefore a genuinely open niche.

---

## 1. Eclipse SysON

**Eclipse SysON** is an open-source, fully web-based MBSE (Model-Based Systems Engineering) modeling tool for authoring **OMG SysML v2** models, led primarily by **Obeo** with **CEA** driving SysML v2 standard compliance. It runs entirely in the browser and is built as a ground-up implementation of the KerML and SysML v2 metamodels on top of the Sirius Web platform ([mbse-syson.org](https://mbse-syson.org/), [doc.mbse-syson.org – What is SysON](https://doc.mbse-syson.org/syson/main/user-manual/what-is.html), [Obeo blog – Introducing Methodology Support](https://blog.obeosoft.com/introducing-methodology-support-for-sysmlv2-with-syson)).

### Tech stack
SysON is built on **Eclipse Sirius Web**, Obeo's open-source low-code platform for defining custom web modeling editors, and inherits its full stack ([eclipse.dev/sirius/sirius-web](https://eclipse.dev/sirius/sirius-web.html), [Obeo blog – Sirius Web & SysON](https://blog.obeosoft.com/sirius-web-syson-building-next-generation-modeling-tools-for-complex-engineering)):

- **Backend:** Java 21 + Spring Boot, built with Apache Maven. Models are represented with **EMF (Eclipse Modeling Framework / Ecore)**. Since ~v2025.10, the backend is split into hierarchical modules — `syson-sysml-metamodel-services` (atomic, Spring-free model ops), `syson-model-services`, and representation-specific services (`syson-diagram-services`, `-table-services`, `-tree-services`, `-form-services`, `-representation-services`) ([SysON Developer guide](https://doc.mbse-syson.org/syson/main/developer-guide/index.html)).
- **Frontend:** React (Node.js 22.x / npm), with diagram rendering via **Sprotty** (Sirius Web's diagram layer; the Sprotty/GLSP-style SVG rendering stack) and automatic layout via the **Eclipse Layout Kernel (ELK)**. The monorepo uses Turbo for frontend builds ([Developer guide](https://doc.mbse-syson.org/syson/main/developer-guide/index.html), [GitHub – eclipse-syson/syson](https://github.com/eclipse-syson/syson)). Note: Sirius Web's diagramming is based on Sprotty rather than the heavier GLSP server protocol; "GLSP" is sometimes used loosely but the actual rendering is Sprotty-based.
- **Persistence/DB:** **PostgreSQL** (v15 in the test Docker image). Deployed via Docker / docker-compose ([Developer guide](https://doc.mbse-syson.org/syson/main/developer-guide/index.html), [GitHub repo](https://github.com/eclipse-syson/syson)).
- **API:** **GraphQL** is the primary client-server API (inherited from Sirius Web), complemented by REST endpoints for some operations such as upload/download ([Revolutionizing Graphical Modeling with Sirius Web](https://newsroom.eclipse.org/eclipse-newsletter/2023/october/revolutionizing-graphical-modeling-eclipse-sirius-web), [Developer guide](https://doc.mbse-syson.org/syson/main/developer-guide/index.html)). Sirius Web exposes its representations/model trees through a GraphQL schema, which SysON consumes.

### Supported SysML v2 diagram kinds & views
SysON provides graphical, form-based, and tabular editors. The graphical views are ([SysON Docs – SysML v2 overview](https://doc.mbse-syson.org/syson/main/user-manual/features/sysmlv2-overview.html), [Interconnection view](https://doc.mbse-syson.org/syson/main/user-manual/features/interconnection-view.html), [Obeo blog – SysON 2025.6](https://blog.obeosoft.com/syson-2025-6)):

- **General View** — the primary general-purpose diagram for defining the high-level system structure and most element/relationship kinds (definitions and usages).
- **Interconnection View** — shows encapsulated structural content of Usage elements: Parts, Properties, Connectors, Ports, Interfaces, and flow connections.
- **Action Flow View** — behavioral view focused on Action Definitions/Usages, including control nodes (Fork, Join, Merge), introduced in 2024.3.
- **State Transition View** — behavioral view focused on State Definitions/Usages and Transitions, available on Package elements.
- **Form-based editors and Tables** — property forms and tabular editors for each concept.
- Recent releases (2025.6) added initial **ViewUsage / ViewDefinition** support (modular, reusable, standard-library-typed views with `expose`/`render` directives kept in sync with diagram contents) ([SysON 2025.6](https://blog.obeosoft.com/syson-2025-6)).

### Textual editing support
SysON supports the **SysML v2 textual notation** as an interchange format rather than as a full live textual IDE ([SysML v2 textual format docs](https://doc.mbse-syson.org/syson/v2025.4.0/user-manual/features/import-export-textual.html), [import-export-textual.adoc on GitHub](https://github.com/eclipse-syson/syson/blob/main/doc/content/modules/user-manual/pages/features/import-export-textual.adoc)):

- **Import** `.sysml`/`.kerml` files via the Explorer upload, or paste textual content into existing elements via the "New objects from text" context menu. A `SysMLElementSerializer` (ANTLR-based parsing) converts between the metamodel and text.
- **Export** documents (with a `.sysml` suffix) back to textual SysML v2 via a download menu.
- **Caveat:** all dependencies of an imported file must be imported first (recursively); "most important SysML v2 concepts can be translated" but some concepts are still under development, so round-trip parity is incomplete. There is no full free-form textual code editor pane — editing is primarily graphical/form-based with text used for import/export.

### Persistence
Models are stored server-side in **PostgreSQL** through Sirius Web's persistence layer, using **EMF/Ecore** as the in-memory metamodel representation. Because the metamodel is EMF-based, models can be exported/imported as **XMI**, and additionally as **SysML v2 textual** files and as **ZIP** packages that preserve diagram layout ([projects.eclipse.org/projects/modeling.syson](https://projects.eclipse.org/projects/modeling.syson), [Developer guide](https://doc.mbse-syson.org/syson/main/developer-guide/index.html), [SysON 2025.6](https://blog.obeosoft.com/syson-2025-6)).

### License
**Eclipse Public License 2.0 (EPL-2.0)**; the repository also references **LGPL-3.0** for certain dependency/component licensing (dual-license noting on GitHub) ([projects.eclipse.org](https://projects.eclipse.org/projects/modeling.syson), [GitHub repo](https://github.com/eclipse-syson/syson)).

### Maturity & version
- **Eclipse Foundation phase: Incubating** (active, ongoing development) ([projects.eclipse.org/projects/modeling.syson](https://projects.eclipse.org/projects/modeling.syson)).
- **Date-based, roughly bimonthly release cadence.** Releases run from 2023/2024 through 2026; the latest GitHub release at time of research is **v2026.5.0 (May 21, 2026)** ([GitHub releases](https://github.com/eclipse-syson/syson)).
- Governance: **Obeo** focuses on product/UX, **CEA** leads OMG/SysML v2 compliance; it is positioned as the SysML v2 editing core for **Papyrus** and for co-design with **Eclipse Capella** ([Obeo blog](https://blog.obeosoft.com/introducing-methodology-support-for-sysmlv2-with-syson), [projects.eclipse.org](https://projects.eclipse.org/projects/modeling.syson)).

### Notable limitations
- **Incomplete SysML v2 coverage:** the implementation historically emphasized structural aspects first; behavioral views (Action Flow, State Transition) and ViewUsage/ViewDefinition support are newer and still maturing ([SysON 2025.6](https://blog.obeosoft.com/syson-2025-6), [Obeo blog – Introducing Methodology](https://blog.obeosoft.com/introducing-methodology-support-for-sysmlv2-with-syson)).
- **Textual round-trip is partial** — not all SysML v2 concepts can yet be imported/exported, and imports require all dependencies to be loaded first ([textual format docs](https://doc.mbse-syson.org/syson/v2025.4.0/user-manual/features/import-export-textual.html)).
- **Scaling limits** are explicitly documented (performance/capacity boundaries on large models) ([What is SysON](https://doc.mbse-syson.org/syson/main/user-manual/what-is.html)).
- **No standardized graphical interchange yet** — ViewUsage rendering is "initial," pending OMG decisions on a standardized SysML v2 graphical interchange format ([SysON 2025.6](https://blog.obeosoft.com/syson-2025-6)).
- As a server-based web app it requires a backend deployment (Spring Boot + PostgreSQL), not a standalone desktop/offline tool.

---

## 2. SysML v2 Pilot Implementation & Reference API

The **SysML v2 Pilot Implementation** and the **SysML v2 API & Services** pilot are the official prototyping/reference codebases maintained by the OMG **Systems-Modeling** GitHub organization. They are the de-facto canonical reference against which the SysML v2 standard was developed and against which tool vendors validate their own implementations. Together with the companion **SysML-v2-Release** repository (the recommended starting point) and the **SysML-v2-API-Cookbook**, they constitute the executable reference for the language and its services.

### What they are (reference implementation)

- **SysML-v2-Pilot-Implementation** — "Pilot implementation of the SysML v2 textual notation and visualization." It is a prototyping environment for the language itself: the textual concrete syntax (KerML + SysML), the parser/type-checker/name-resolver, and visualization. It was built in lock-step with the specification by the SysML v2 Submission Team (SST) and is the working reference for language semantics. Repo: https://github.com/Systems-Modeling/SysML-v2-Pilot-Implementation
- **SysML-v2-API-Services** — "Proof-of-concept pilot implementation for the Systems Modeling API and Services." It is the reference REST/HTTP server that realizes the OMG *Systems Modeling API and Services* standard, giving programmatic repository-style access (projects, commits, branches, elements, queries) to models. Repo: https://github.com/Systems-Modeling/SysML-v2-API-Services
- **SysML-v2-Release** — "The latest incremental release of SysML v2. Start here." Bundles the specification PDFs (KerML 1.0, SysML 2.0 Parts 1–2, Systems Modeling API & Services 1.0), training material, example models, normative model libraries (textual, KPAR, XMI), Eclipse plugin installers, and the Jupyter kernel. As of mid-2025 the three specifications were **formally adopted by OMG** (following the June 2023 Beta), with editorial updates for ISO submission. Repo: https://github.com/Systems-Modeling/SysML-v2-Release
- **SysML-v2-API-Cookbook** — "Recipes for using the SysML v2 API." A set of Jupyter notebooks (100% notebook codebase) demonstrating real API workflows. Repo: https://github.com/Systems-Modeling/SysML-v2-API-Cookbook

Their status as the canonical reference is reinforced by the fact that other tools (e.g., Eclipse SysON, vendor MBSE tools) target compatibility with the *same* REST API the SST deploys, and the Cookbook/Release repos are cited as the authoritative usage and model-library source. See https://www.omg.org/sysml/sysmlv2/ and the Systems Modeling API spec PDF https://www.omg.org/spec/SystemsModelingAPI/1.0/Beta1/PDF

### The Java / Xtext basis

The Pilot Implementation is a **Java** codebase built on **Eclipse Modeling Tools** with **Xtext** providing the grammar, parser, scoping/name-resolution, and editor for the SysML/KerML textual notation. Key facts (from the repo README, https://github.com/Systems-Modeling/SysML-v2-Pilot-Implementation/blob/master/README.adoc):

- **Eclipse 2025-12 (4.38)** is the target IDE/platform; multi-project builds are coordinated with **Maven**.
- **Java 21** is required as the runtime/VM.
- The `sysml.library` and `kerml` projects supply the **standard (normative) model library** used for cross-reference resolution — these are the foundational element/feature libraries (e.g., Base, ScalarValues, Quantities, SI units, geometry, analysis, etc.) referenced by user models.
- Optional **PlantUML + GraphViz** integration provides diagram visualization from the textual model.
- Runtime editing is done inside an Eclipse Application instance launched from the workspace.

### Jupyter / textual notebook workflow

A first-class way to author SysML v2 is the **Jupyter kernel**, which "executes models via the new SysML textual language" and is "built on top of jupyter-jvm-basekernel." Details from https://github.com/Systems-Modeling/SysML-v2-Pilot-Implementation/blob/master/org.omg.sysml.jupyter.kernel/README.adoc:

- Requires **Java 21+** and a Jupyter-compatible front end; the deployment has been **updated to JupyterLab 4.x** (older JupyterLab/Classic Notebook are no longer supported — see https://github.com/Systems-Modeling/SysML-v2-Pilot-Implementation/blob/master/org.omg.sysml.jupyter.jupyterlab/package.json).
- Install via **`installKernel.sh` / `installKernel.bat`** (after a Maven build of the parent project), or via a pre-built release using **`install.py`** (e.g., `--sys-prefix`).
- Notebook cells contain SysML text (e.g., `package test {}`) that is parsed/checked incrementally; results and diagrams render inline.
- **Magic commands** include **`%viz`** (render a model element as a Graphviz/PlantUML diagram) and **`%publish`** (push the model to a configured API & Services endpoint).
- Configurable via environment variables: **`ISYSML_LIBRARY_PATH`** (model library location), **`ISYSML_API_BASE_PATH`** (publish target), **`ISYSML_GRAPHVIZ_PATH`** (Graphviz binary); VM/heap options live in `kernel.json`. Overview also covered at https://mbse4u.com/2021/12/12/the-sysml-v2-lab/

This "textual notebook" workflow — write SysML text, execute, visualize, publish to the API — is the recommended low-friction way to learn and demo the language without the full Eclipse setup.

### The REST API server (API & Services)

The reference server in **SysML-v2-API-Services** implements the REST/HTTP Platform-Specific Model (PSM) of the OMG Systems Modeling API. From https://github.com/Systems-Modeling/SysML-v2-API-Services:

- **Tech stack:** **Play Framework** web app written in **Scala**, built with **sbt**; compiled/run on **JDK 11**; backed by **PostgreSQL** (deployable via Docker).
- **Run locally** with `sbt run`; the server listens on **HTTP port 9000**, exposing the same REST API that the SST hosts on its public servers.
- **API definition:** the REST/HTTP PSM is specified in **OpenAPI (OAS) 3.1** and ships with the specification; interactive **Swagger** docs are served at `localhost:9000/docs/`. Clients can be Swagger UI, Postman, or generated SDKs.
- Companion clients exist, e.g., the **SysML-v2-API-Java-Client** (https://github.com/Systems-Modeling/SysML-v2-API-Java-Client), and Python is used throughout the Cookbook.
- The API exposes a Git-like model repository: **projects, commits, branches, tags, elements (CRUD), owned/nested element navigation, and queries** — illustrated by the six Cookbook notebooks (Requirement/Structure/Behavior decomposition, a Spacecraft example, project management with commits/branches/tags, element CRUD, owned elements, and queries). See https://github.com/Systems-Modeling/SysML-v2-API-Cookbook

The standardized API is what lets independent tools interoperate on the same model server; third parties have even built MCP servers and alternative front ends on top of it (e.g., https://roth-soft.de/blog/2025-09-18-building-mcp-server-sysml-v2-api.html, and SysON's API cookbook at https://doc.mbse-syson.org/syson/v2025.2.0/developer-guide/api-cookbook.html).

### The standard (normative) model library

Distributed both inside the Pilot Implementation (`sysml.library`, `kerml`) and as release artifacts in SysML-v2-Release (textual `.sysml`, **KPAR** packages, and **XMI**). These libraries provide the foundational semantic vocabulary every model imports (base classifications, scalar/collection values, quantities and **ISQ/SI units**, geometry, control, analysis, metadata, etc.) and are required for name/cross-reference resolution in both the editor and the kernel.

### Licenses

- **Pilot Implementation:** licensed under the **Eclipse Public License 2.0 (EPL-2.0)**, with a secondary GPL option — the README states "licensed under the Eclipse Public License. See the files LICENSE and LICENSE-GPL," and the SPDX header is `EPL-2.0` (https://github.com/Systems-Modeling/SysML-v2-Pilot-Implementation/blob/master/README.adoc).
- **API & Services:** **EPL-2.0** (Eclipse Public License).
- **Release / Cookbook / model libraries:** distributed by the Systems-Modeling org under the same OMG/SST open licensing (EPL-based); the Cookbook repo's explicit license text was not surfaced in the fetched content, so confirm the `LICENSE` file directly if license terms are load-bearing for your use.

> Note: a few specifics were drawn from cached GitHub README renders; version numbers (Eclipse 2025-12, JDK 21 for the pilot vs. JDK 11 for the API server) and the EPL/GPL dual-licensing should be re-verified against the live `LICENSE` and `README.adoc` files before relying on them contractually.

**Sources:** [Pilot Implementation repo](https://github.com/Systems-Modeling/SysML-v2-Pilot-Implementation) · [Pilot README](https://github.com/Systems-Modeling/SysML-v2-Pilot-Implementation/blob/master/README.adoc) · [Jupyter kernel README](https://github.com/Systems-Modeling/SysML-v2-Pilot-Implementation/blob/master/org.omg.sysml.jupyter.kernel/README.adoc) · [JupyterLab package.json](https://github.com/Systems-Modeling/SysML-v2-Pilot-Implementation/blob/master/org.omg.sysml.jupyter.jupyterlab/package.json) · [API & Services repo](https://github.com/Systems-Modeling/SysML-v2-API-Services) · [API Cookbook repo](https://github.com/Systems-Modeling/SysML-v2-API-Cookbook) · [API Java Client](https://github.com/Systems-Modeling/SysML-v2-API-Java-Client) · [SysML-v2-Release](https://github.com/Systems-Modeling/SysML-v2-Release) · [OMG SysML v2](https://www.omg.org/sysml/sysmlv2/) · [Systems Modeling API spec PDF](https://www.omg.org/spec/SystemsModelingAPI/1.0/Beta1/PDF) · [MBSE4U: The SysML v2 Lab](https://mbse4u.com/2021/12/12/the-sysml-v2-lab/)

---

## 3. TypeScript/Langium tooling (SysIDE, Langium)

### SysIDE / Syside (Sensmetry)

**SysIDE** (pronounced "seaside") is an open-source SysML v2 textual editing and analysis system developed and maintained by **Sensmetry**, a company focused on safety- and mission-critical automated systems. Its core deliverable is a parser and a **language server** for the **SysML v2 and KerML 2024-12 release** specifications, surfaced primarily as a **VS Code extension** ([GitHub: sensmetry/sysml-2ls](https://github.com/sensmetry/sysml-2ls), [Sensmetry Syside page](https://sensmetry.com/syside/)).

**Built in TypeScript on Langium.** SysIDE's codebase is ~98% TypeScript and is built on **Langium** (a TypeScript language-engineering/LSP framework — see below) for the SysML v2/KerML grammar, AST generation, and Language Server Protocol implementation. Development workflow uses the Langium grammar generator (e.g. `pnpm run grammar:watch` regenerates parser artifacts from the grammar declaration) ([SysIDE overview PDF, Sensmetry](https://sensmetry.com/wp-content/uploads/2024/11/SysIDE-SysML-v2-textual-editing-and-analysis-system.pdf)). The approach and applications are documented in a peer-reviewed paper, "SysIDE: SysML v2 textual editing and analysis system: overview and applications," *CEAS Space Journal* (Springer, 2025) ([Springer Link](https://link.springer.com/article/10.1007/s12567-025-00595-x)), indicating a reasonable level of maturity and external validation.

**Language-server capabilities.** The server provides a fairly complete LSP feature set: semantic highlighting, autocompletion, code navigation (go-to-definition), formatting, real-time syntax **and semantic** validation, reference search (find references), code folding, document symbols/outline, element renaming, and hover documentation ([README, sysml-2ls](https://github.com/sensmetry/sysml-2ls/blob/main/README.md)).

**Runs in-browser.** Because it is pure TypeScript on Langium, SysIDE can run not only in desktop VS Code but also in **VS Code for the Web** (browser-based), as well as be embedded into other applications and automated workflows ([sysml-2ls repo](https://github.com/sensmetry/sysml-2ls)). This browser capability is inherited directly from Langium's web-worker architecture.

**License.** The extension **source code** is **dual-licensed under the Eclipse Public License v2.0 (EPL-2.0) and GPLv2 with the GNU Classpath Exception** ([LICENSE file](https://raw.githubusercontent.com/sensmetry/sysml-2ls/main/LICENSE)). The bundled SysML v2 **standard library** (from the OMG SysML-v2-Release) is separately licensed under **LGPL v3.0** ([README](https://github.com/sensmetry/sysml-2ls/blob/main/README.md)).

**Maturity / status — important caveat.** The original repo `sensmetry/sysml-2ls` is now branded **"SysIDE Editor Legacy" and is deprecated**: the README states it "has been deprecated and is no longer being maintained." Last release was **v0.9.1 (Oct 2, 2025)** and the repository was **archived ~Oct 13, 2025**. The deprecated Marketplace/Open VSX listings confirm this ([Open VSX legacy](https://open-vsx.org/extension/sensmetry/sysml-2ls), [VS Marketplace legacy](https://marketplace.visualstudio.com/items?itemName=sensmetry.sysml-2ls)). The pre-1.0 version numbers signal it never reached a formally "stable" release under the legacy name.

**The current Syside suite (successor).** Sensmetry has rebranded/relaunched the line as **Syside** ([sensmetry.com/syside](https://sensmetry.com/syside/)):
- **Syside Editor** — free, open-source VS Code extension (on both [VS Marketplace](https://marketplace.visualstudio.com/items?itemName=sensmetry.syside-editor) and [Open VSX](https://open-vsx.org/extension/sensmetry/syside-editor)); foundational features: syntax highlighting, autocompletion, formatting, document outlines, hover. This is the recommended replacement for the legacy SysIDE Editor.
- **Syside Modeler** — commercial/premium professional environment: textual SysML v2 editing, real-time validation, automatic diagram generation (multiple formats), spreadsheet-style table/matrix views, a **headless CLI** for pipeline automation, Windows/macOS/Linux support, and ReqIF integration ([VS Marketplace: Syside Modeler](https://marketplace.visualstudio.com/items?itemName=sensmetry.syside-modeler)).
- **Syside Automator** — commercial Python automation layer (programmatic model access, report generation, CI/CD, ReqIF connectivity to Codebeamer/IBM DOORS).
- **Sysand** — open-source SysML v2 **package manager** and package index (dependency management, version locking, publishing via CLI) ([Sensmetry: Introducing Sysand](https://sensmetry.com/introducing-sysand-the-package-manager-for-the-sysml-v2-ecosystem/)).

Note: the public Syside marketing page does not itself restate the Langium/TypeScript implementation detail, but the lineage from the open-source `sysml-2ls` core (TypeScript + Langium) is well documented.

### Langium itself (browser-capable DSL/LSP framework)

**Langium** is an open-source **language-engineering / DSL framework written in TypeScript** with **first-class Language Server Protocol support**. It is an **Eclipse Foundation project (Eclipse Langium)**, originally created by **TypeFox**, and is explicitly positioned as the **spiritual successor to Eclipse Xtext** ([langium.org](https://langium.org/), [GitHub: eclipse-langium/langium](https://github.com/eclipse-langium/langium), [TypeFox blog](https://www.typefox.io/blog/langium-the-new-language-engineering-tool/)).

**License & maturity.** Langium is **MIT-licensed** and mature — currently at **v4.x (v4.2.2 at time of writing)**, having reached its 1.0 milestone back in 2023 ([GitHub](https://github.com/eclipse-langium/langium), [TypeFox: Langium 1.0](https://www.typefox.io/blog/langium-1.0-a-mature-language-toolkit/)). The permissive MIT license makes it markedly easier to build on/redistribute than EPL- or LGPL-encumbered components.

**Capabilities.** From an EBNF-like grammar declaration, Langium generates a **typed TypeScript AST**, performs **cross-reference resolution via configurable scoping**, supports **custom validations/diagnostics**, and handles incremental workspace/document management. Out-of-the-box LSP features include code completion, diagnostics, find-references, formatting, hover, document symbols, and rename — i.e., exactly the feature surface SysIDE exposes ([Langium Features](https://langium.org/docs/features/)).

**Browser suitability (key strength for in-browser modeling).** Langium is "built exclusively on web technologies" and runs equally in **Node.js and the browser**. In-browser, the **language server runs in a Web Worker** (so it does not block page load or UI), paired with the **Monaco editor** (the editor that powers VS Code) via `monaco-editor-wrapper`/`monaco-languageclient`, plus a **custom/virtual file-system service** to replace Node FS. A fully client-side setup (no backend) is possible using an "empty" single-document file system, giving a dedicated per-user language server, no network latency, and offline operation ([TypeFox: Langium in the web browser](https://www.typefox.io/blog/langium-web-browser/)). This architecture is precisely what enables SysML v2 tools like SysIDE/Syside to offer in-browser editing, and makes Langium a strong foundation for any browser-deployable SysML v2/KerML DSL tooling.

**Sources:**
- [GitHub: sensmetry/sysml-2ls](https://github.com/sensmetry/sysml-2ls) · [README](https://github.com/sensmetry/sysml-2ls/blob/main/README.md) · [LICENSE](https://raw.githubusercontent.com/sensmetry/sysml-2ls/main/LICENSE)
- [Sensmetry Syside](https://sensmetry.com/syside/) · [SysIDE overview PDF](https://sensmetry.com/wp-content/uploads/2024/11/SysIDE-SysML-v2-textual-editing-and-analysis-system.pdf) · [Introducing Sysand](https://sensmetry.com/introducing-sysand-the-package-manager-for-the-sysml-v2-ecosystem/)
- [CEAS Space Journal paper (Springer)](https://link.springer.com/article/10.1007/s12567-025-00595-x)
- [Syside Editor (VS Marketplace)](https://marketplace.visualstudio.com/items?itemName=sensmetry.syside-editor) · [Syside Modeler (VS Marketplace)](https://marketplace.visualstudio.com/items?itemName=sensmetry.syside-modeler) · [Open VSX (legacy)](https://open-vsx.org/extension/sensmetry/sysml-2ls)
- [langium.org](https://langium.org/) · [Langium Features](https://langium.org/docs/features/) · [GitHub: eclipse-langium/langium](https://github.com/eclipse-langium/langium) · [TypeFox: Langium in the web browser](https://www.typefox.io/blog/langium-web-browser/) · [TypeFox: Langium 1.0](https://www.typefox.io/blog/langium-1.0-a-mature-language-toolkit/)

---

## 4. Commercial tools & SysML v2 roadmaps

### Standards context (why 2025–2026 is the inflection point)
On **21 July 2025 the OMG approved the final adoption** of three linked specifications that anchor every vendor roadmap below: **SysML v2.0**, **KerML v1.0**, and the **Systems Modeling API and Services v1.0** ([omg.org press release](https://www.omg.org/news/releases/pr2025/07-21-25.htm); [omg.org/sysml/sysmlv2](https://www.omg.org/sysml/sysmlv2/)). The API & Services spec is the most consequential part for tooling: it defines a **standard REST/HTTP interface** for model access, persistence, querying, validation and tool interoperability, so that, in Intercax's words, "any tool providing Systems Modeling API and Services 1.0 standard can be seamlessly integrated with other enterprise applications" ([OMG release](https://www.omg.org/news/releases/pr2025/07-21-25.htm)). The reference implementation (pilot textual parser, Jupyter kernel and REST server) lives on GitHub at [github.com/Systems-Modeling/SysML-v2-Release](https://github.com/systems-modeling/sysml-v2-release). The DoD CTO office issued a SysML v2 technical highlight in Jan 2025 stressing the standardized API for the digital-engineering ecosystem ([cto.mil PDF](https://www.cto.mil/wp-content/uploads/2025/02/SysML-Info-Sheet-Jan2025.pdf)).

A recurring theme: most vendors are shipping **SysML v2 alongside v1** (not as a replacement) and are building around the **standard REST API** as the integration backbone.

### Dassault Systèmes — No Magic Cameo / CATIA Magic
- **Status:** SysML v2 went GA in the **2026x release** of the CATIA Magic / No Magic (Cameo) portfolio, supporting **v1 and v2 simultaneously** in the same environment; 2026x Refresh1 shipped for all CATIA Magic / No Magic products (rollout late 2025 into 2026) ([nomagic docs – 2026x SysML v2 solution](https://docs.nomagic.com/SYSML2P/2026x/catia-magic-cameo-sysml-v2-solution-272740940.html); [GoEngineer](https://www.goengineer.com/blog/advantages-of-sysml-v2-now-available-in-no-magic-cameo-and-catia-magic-2026)).
- **Licensing/commercial:** Only the **Enterprise-tier** configurations get v2 — Cameo Enterprise Architecture and Cameo Systems Modeler (Enterprise Edition) on the No Magic side, and Magic System of Systems Architect and Magic Cyber-Systems Engineer on the CATIA Magic side. **Cameo Systems Modeler Architect Edition and MagicDraw + SysML plug-in do NOT gain v2.** Dassault raised list prices on the qualifying configs by ~19.5–20% effective **1 Jan 2026** ([GoEngineer](https://www.goengineer.com/blog/advantages-of-sysml-v2-now-available-in-no-magic-cameo-and-catia-magic-2026)). An **Early Experience Program** and a free **CATIA Magic/Cameo SysML v2 Community Edition** are offered ([3ds Community Edition](https://discover.3ds.com/free-catia-sysmlv2-community-edition)).
- **Web/browser:** Introduces **MagicLab**, "a new browser-based environment for viewing SysML v2 models" — read-only diagrams/tables/elements served from **Teamwork Cloud** with no local install; updates appear live when the model changes via the tool or REST API. Existing **Cameo Collaborator for Teamwork Cloud** (Edge/Chrome/Firefox/Safari) remains the web review surface, and Teamwork Cloud/Magic Collaboration Studio can deploy on-prem or in the cloud ([nomagic docs](https://docs.nomagic.com/SYSML2P/2026x/catia-magic-cameo-sysml-v2-solution-272740940.html); [3ds Cameo Collaborator](https://www.3ds.com/products/catia/no-magic/cameo-collaborator-teamwork-cloud)). The authoring tool itself remains a desktop client.
- **API/automation:** Ships the **Standard SysML v2 REST API** through Teamwork Cloud — engineers can "create, edit, query, retrieve, and evaluate models directly from scripts or applications," explicitly targeting **CI/CD / DevOps pipeline** integration. Also provides **two-way textual↔graphical synchronization** and v1→v2 migration via transformation specifications ([nomagic docs](https://docs.nomagic.com/SYSML2P/2026x/catia-magic-cameo-sysml-v2-solution-272740940.html)).

### PTC — PTC Modeler (formerly Windchill / Integrity Modeler)
- **Status:** PTC is delivering SysML 2.0 **incrementally** across releases 10.0 → 10.1 → **10.2 (Summer 2025)**, timed to the OMG July 2025 adoption. Modeler 10.2 adds **State, Analysis, and Verification** modeling on top of earlier structural/behavioral coverage ([PTC Modeler 10.2 what's-new](https://support.ptc.com/help/modeler/r10.2/en/Modeler/rtsme/whats_new_10_2_0_0.html); [PTC blog – Modeler 10.2](https://www.ptc.com/en/blogs/alm/introducing-ptc-modeler-10-2); [PTC community](https://community.ptc.com/systems-software-engineering-15/ptc-support-for-mbse-model-based-systems-engineering-and-sysml-2-0-166527)).
- **API/automation & data management:** Distinctive for storing SysML 2.0 models in a **managed SQL Server database** rather than files, and for **importing SysML v2 textual notation (.sysml files)** that auto-generate the equivalent model elements — a migration path from fragmented text files to a governed model. Integrates with **Windchill PLM** and the engineering digital thread via **OSLC** ([PTC blog](https://www.ptc.com/en/blogs/alm/introducing-windchill-modeler-10-whats-new-and-noteworthy); [PTC Modeler product page](https://www.ptc.com/en/products/ptc-modeler)).
- **Web/browser:** Authoring is the Windows desktop client; PTC's web/collaboration story runs through Windchill and OSLC rather than a browser-based SysML v2 editor (no browser authoring announced as of these releases).

### IBM — Rhapsody (Rhapsody Systems Engineering)
- **Status:** IBM's SysML v2 vehicle is the **new, separate product "Rhapsody Systems Engineering (SE)"**, distinct from classic Rhapsody Developer/Architect. **v1.5 was announced 14 October 2025**, explicitly to "simplify the adoption of SysML v2," with two stated goals: lowering the v2 learning curve and enabling **multi-user collaboration on large-scale projects** ([IBM v1.5 announcement](https://www.ibm.com/new/announcements/ibm-introduces-rhapsody-systems-engineering-v1-5-simplifying-the-adoption-of-sysml-v2-for-complex-product-development); [IBM Rhapsody SE product page](https://www.ibm.com/products/rhapsody-systems-engineering); [IBM docs 1.5 overview](https://www.ibm.com/docs/en/systems-engineering/1.5.0?topic=overview)).
- **Usability/automation:** Drag-and-drop and similar gestures **auto-generate the underlying SysML v2 model** (ports, action parameters, use-case parameters, etc.) so users build spec-compliant models without deep v2 expertise; dedicated graphic editors, configurable browsers, and completeness/correctness checks ([IBM announcement](https://www.ibm.com/new/announcements/ibm-introduces-rhapsody-systems-engineering-v1-5-simplifying-the-adoption-of-sysml-v2-for-complex-product-development); [SodiusWillert overview](https://www.sodiuswillert.com/en/blog/the-evolution-of-systems-engineering-sysml-v2-and-ibm-rhapsody-se)).
- **Web/browser:** Siemens describes IBM Rhapsody SE as "a **web-based platform** designed to support SysML v2" ([Siemens blog](https://blogs.sw.siemens.com/teamcenter/siemens-partners-with-ibm-sysml/)) — a notable contrast with desktop-only classic Rhapsody.
- **Ecosystem:** **Siemens–IBM partnership (announced 20 Mar 2025)** pairs Rhapsody SE with **Teamcenter MBSE** over the open SysML v2 standard and its API & Services, integrating systems models with PLM ([Siemens blog](https://blogs.sw.siemens.com/teamcenter/siemens-partners-with-ibm-sysml/)).

### Capella — and the Eclipse open-source v2 stack (SysON / Papyrus)
- **Capella itself** is built on the **Arcadia** method, not native SysML, so it does **not** become a SysML v2 authoring tool. Instead, SysML v2 reaches the Eclipse/Capella world through two open-source projects, with Capella interoperating via model exchange ([Capella forum – SysON status](https://forum.mbse-capella.org/t/status-of-eclipse-syson-project/6699); [SysON↔Capella integration docs](https://doc.mbse-syson.org/syson/main/user-manual/integration/capella.html)).
- **Eclipse SysON** — the leading **open-source, web/browser-based** SysML v2 modeler, developed since Dec 2023 by **Obeo and CEA List**, hosted at the Eclipse Foundation, built on **Sirius Web**, on an **8-week release cycle** (e.g. tag **v2025.8.0**). Provides graphical (General View, Interconnection View), form-based and tabular editors plus **textual import/export** in standard v2 notation and **native v2 model libraries**; it is "not yet intended for production use" and its roadmap calls out **providing a REST API** aligned with the OMG spec and **Capella model exchange** ([mbse-syson.org](https://mbse-syson.org/); [GitHub eclipse-syson/syson](https://github.com/eclipse-syson/syson); [Eclipse project page](https://projects.eclipse.org/projects/modeling.syson)). SysON is also the **core of the SysML v2 editing feature in Eclipse Papyrus**, enabling co-design alongside Capella ([Capella forum](https://forum.mbse-capella.org/t/status-of-eclipse-syson-project/6699)). It was featured in the **Vendor Roadmaps session at INCOSE IW 2025** (Seville, Feb 2025) and underpins ESA's EasyMOD space-industry prototype ([INCOSE – Eclipse SysON](https://www.incose.org/resource/eclipse-syson/)).

### Other vendors / betas
- **Sparx Systems Enterprise Architect** — delivering SysML v2 through **"Trechoro,"** a dedicated, **UML-free environment built directly on KerML**, introduced at the Sparx Global Summit 2025. Supports **import of SysML v2 textual notation**, all SysML v2 library elements, and **clean v2 textual export** free of EA/UML tags (preview/early-access stage in 2025) ([Sparx newsletter 2025-08](https://sparxsystems.com/press/newsletter/2025-08.html); [sparxsystems.com/mbse/sysml2](https://sparxsystems.com/mbse/sysml2/)).
- **Vitech GENESYS (now part of the broader portfolio)** — Vitech sat on the OMG SysML v2 Submission Team and Finalization Task Forces; the **next-generation GENESYS will incorporate SysML v2** (roadmap, not yet shipped) ([Sparx/listly aggregation](https://list.ly/list/6xE3-sysml-v2-tools)).
- **MathWorks** (System Composer/Simulink) and **SodiusWillert** are positioning around **interoperability via the standard v2 API** rather than as primary authoring tools, per their OMG statements ([OMG release](https://www.omg.org/news/releases/pr2025/07-21-25.htm)); SodiusWillert publishes Rhapsody SE migration guidance ([SodiusWillert](https://www.sodiuswillert.com/en/blog/the-evolution-of-systems-engineering-sysml-v2-and-ibm-rhapsody-se)). **Intercax** (Syndeia) emphasizes multi-tool integration on the v2 API & Services standard ([OMG release](https://www.omg.org/news/releases/pr2025/07-21-25.htm)).

### Cross-cutting takeaways
- **Authoring is still mostly desktop**; the clear web/browser movers are **IBM Rhapsody SE** (web-based platform), **Eclipse SysON/Papyrus** (open-source, browser-native), and Dassault's **MagicLab** (browser viewer over Teamwork Cloud). PTC and Sparx remain desktop-authoring with server/PLM back-ends.
- **The standard SysML v2 REST API & Services spec is the common automation layer** — Dassault exposes it via Teamwork Cloud for CI/CD scripting; SysON targets it on its roadmap; multiple vendors (Intercax, MathWorks, SodiusWillert) are building interoperability on it.
- **Dual v1/v2 coexistence and textual (.sysml) import** are near-universal adoption on-ramps across Dassault, PTC, Sparx and SysON.

*Note: two primary pages (the IBM v1.5 announcement and the PTC Modeler 10.2 what's-new) returned HTTP 403 to automated fetch; their facts above are corroborated from the IBM/PTC search excerpts and secondary sources cited inline, but exact wording on those two could not be re-verified verbatim.*

---

## 5. Browser diagramming & layout frameworks

This section evaluates each candidate against the constraints of a **purely client-side** SysML v2 modeler (no required server backend), with attention to five dimensions: license, browser-only feasibility, auto-layout, custom node/edge rendering, and fit for SysML notation. Two of these are not diagramming frameworks but complementary layers: **ELK/elkjs** (auto-layout) and **Yjs** (collaboration), covered last.

### Quick comparison

| Framework | License | Pure client-side? | Built-in auto-layout | SysML-notation fit |
|---|---|---|---|---|
| Eclipse GLSP | EPL-2.0 | Yes, since GLSP 2 "browser mode" | Via ELK (server or in-browser) | Strong (model-driven, ports/compartments) |
| Sprotty | EPL-2.0 | Yes (rendering/interaction only) | Via elkjs (sprotty-elk) | Good rendering layer; editing not included |
| Sirius Web / SysON | EPL-2.0 | **No** — needs Spring/Postgres backend | Via ELK | Excellent (SysON is a SysML v2 tool) but not client-only |
| maxGraph | Apache-2.0 | Yes (zero-dependency) | Hierarchical/tree/organic + orthogonal routing | Flexible low-level; build notation yourself |
| JointJS (core) | MPL-2.0 (core); JointJS+ commercial | Yes | dagre/DirectedGraph in core; tree/stack/force in JointJS+ | Good; advanced features behind paywall |
| React Flow / @xyflow | MIT | Yes (React only) | None built-in (pair with elkjs/dagre) | Good for nodes/edges; ports/compartments are custom work |
| Excalidraw | MIT | Yes | None (free-form) | Poor for formal notation; sketching only |
| diagram-js (bpmn-io) | MIT (diagram-js); bpmn-js under bpmn.io watermark license | Yes | None built-in | Good editing toolkit; build custom notation |
| ELK / elkjs | EPL-2.0 | Yes (GWT/J2CL, Web Worker) | This *is* the layout engine | N/A (pairs with a renderer) |
| Yjs | MIT | Yes | N/A | N/A (collaboration layer) |

### Eclipse GLSP (Graphical Language Server Platform)
- **License:** EPL-2.0 (Eclipse Foundation project) — commercially friendly. ([projects.eclipse.org/projects/ecd.glsp](https://projects.eclipse.org/projects/ecd.glsp), [github.com/eclipse-glsp/glsp](https://github.com/eclipse-glsp/glsp))
- **Browser-only feasibility:** Historically a client/server architecture (TypeScript or Java GLSP server + glsp-client). **GLSP 2 (Jan 2024) added a "browser mode"**: "GLSP servers can now actually operate only in the browser directly without any need for a dedicated GLSP backend," enabling deployment as a static web page or in VS Code web/github.dev. This makes a purely client-side SysML modeler feasible while keeping GLSP's model-driven editing engine. ([eclipsesource.com — GLSP 2](https://eclipsesource.com/blogs/2024/01/31/eclipse-glsp-2-elevating-web-based-diagram-editors/), [eclipse.dev/glsp](https://eclipse.dev/glsp/))
- **Auto-layout:** Integrates ELK for server-side (or, in browser mode, in-browser) automatic layout; the client renders via Sprotty under the hood. ([eclipse.dev/glsp/documentation](https://eclipse.dev/glsp/documentation/))
- **Custom node/edge rendering:** Built on Sprotty's SVG/TypeScript view layer; you define a graphical model (GModel) and custom views, with first-class support for ports, compartments, nested nodes, and routing — the building blocks of SysML.
- **SysML fit:** Strongest "structured-modeling" option of the group. Its LSP-for-diagrams pattern (server owns the semantic model, enforces editing rules) maps well onto SysML v2's rich constraints and KerML/SysML metamodel. Heaviest learning curve and largest framework footprint of the candidates.

### Sprotty
- **License:** EPL-2.0. ([projects.eclipse.org/projects/ecd.sprotty](https://projects.eclipse.org/projects/ecd.sprotty), [github.com/eclipse-sprotty/sprotty](https://github.com/eclipse-sprotty/sprotty))
- **Browser-only feasibility:** Excellent. "Well suited for client-side diagramming, involving no server-side work whatsoever"; reached 1.0 ("entering maturity") in 2023. TypeScript client, SVG rendering, CSS styling, unidirectional event cycle with a virtual DOM. ([sprotty.org](https://sprotty.org/), [typefox.io blog](https://www.typefox.io/blog/sprotty-a-web-based-diagramming-framework/), [devclass.com](https://devclass.com/2023/10/31/sprotty-project-releases-version-1-0-web-based-visualization-tool-now-entering-maturity/))
- **Auto-layout:** No native algorithm, but a dedicated `sprotty-elk` binding wraps elkjs for layered/force layouts in the browser.
- **Custom node/edge rendering:** Core strength — fully custom SVG views per model element, good for compartment shapes, ports, and edge decorations.
- **SysML fit:** Sprotty is a *rendering + interaction* framework, **not** a complete editor — there's no built-in semantic model or command stack, so you build (or layer GLSP/Langium on top of) the editing logic yourself. It is the de-facto rendering layer beneath GLSP and many MBSE tools, so it's a sound foundation if you want maximal control and minimal licensing friction.

### Sirius Web (and Eclipse SysON)
- **License:** EPL-2.0, hosted at the Eclipse Foundation. ([github.com/eclipse-sirius/sirius-web](https://github.com/eclipse-sirius/sirius-web), [eclipse.dev/sirius/sirius-web.html](https://eclipse.dev/sirius/sirius-web.html))
- **Browser-only feasibility:** **Does not meet the "purely client-side" constraint.** Sirius Web is a low-code platform whose runtime is a server stack — Spring, React, **PostgreSQL**, and GraphQL — with the browser only hosting the React front end. ([newsroom.eclipse.org](https://newsroom.eclipse.org/eclipse-newsletter/2023/october/revolutionizing-graphical-modeling-eclipse-sirius-web), [blog.obeosoft.com](https://blog.obeosoft.com/sirius-web-syson-building-next-generation-modeling-tools-for-complex-engineering))
- **Auto-layout:** Uses ELK for diagram layout.
- **Custom node/edge rendering:** Notation is defined declaratively (views/representations) rather than by writing SVG; rich but opinionated.
- **SysML fit:** The reference point for the whole category — **Eclipse SysON is a fully web-based SysML v2 modeler built directly on Sirius Web** (graphical, form-based, and tabular editors; SysML v2 textual import/export for standard interchange), presented at INCOSE IW 2025. If a mandatory backend is acceptable, SysON is the most "batteries-included" SysML v2 answer; if the modeler must run with no server, Sirius Web is the wrong tool and you'd instead study SysON for its notation/UX. ([mbse-syson.org](https://mbse-syson.org/), [projects.eclipse.org/projects/modeling.syson](https://projects.eclipse.org/projects/modeling.syson))

### maxGraph (mxGraph successor)
- **License:** Apache-2.0. ([github.com/maxGraph/maxGraph](https://github.com/maxGraph/maxGraph), [maxgraph.github.io](https://maxgraph.github.io/maxGraph/docs/intro/))
- **Browser-only feasibility:** Excellent — "fully client side," native TypeScript, **zero dependencies**, tree-shakable, framework-agnostic (React/Vue/Angular/vanilla). It is the maintained successor to mxGraph (the engine behind draw.io), which was archived in 2020; XML import/export stays mxGraph-compatible. ([maxgraph.github.io](https://maxgraph.github.io/maxGraph/))
- **Auto-layout:** Built-in hierarchical, tree, circle, organic, and swimlane layouts, plus orthogonal/Manhattan/elbow edge-routing.
- **Custom node/edge rendering:** Highly customizable vertex/edge styles and custom shapes (SVG-based); supports nested/group cells and ports.
- **SysML fit:** A flexible, low-level toolkit — you implement SysML notation, compartments, and constraints yourself, but you get a mature, dependency-free, permissively licensed engine with a long pedigree in production diagram editors. Good choice if you want full control without GLSP/Sprotty's Eclipse-stack weight.

### JointJS
- **License:** Core **JointJS** is open source under **MPL-2.0**; **JointJS+** is a separate commercial extension (paid, yearly updates/support). ([jointjs.com/license](https://www.jointjs.com/license), [github.com/clientIO/joint](https://github.com/clientIO/joint), [jointjs.com/jointjs-plus](https://www.jointjs.com/jointjs-plus))
- **Browser-only feasibility:** Fully client-side JS/TypeScript library.
- **Auto-layout:** Core ships a DirectedGraph layout (dagre-based); **Stack, Tree, and Force-Directed layouts are part of the commercial JointJS+**, as are BPMN/VSM/table shapes. Plan around the paywall if you need advanced layout. ([jointjs.com/features](https://www.jointjs.com/features))
- **Custom node/edge rendering:** Strong — elements declared via SVG/HTML markup, custom ports, link routers/connectors, and link tools.
- **SysML fit:** Capable general-purpose modeling library used for many DSLs; you build SysML notation on the open-source core, but the most ergonomic editor features (advanced layouts, ready shapes, inspector UI) live in the paid tier, which affects cost and licensing for an open SysML tool.

### React Flow / @xyflow
- **License:** MIT (xyflow maintains both React Flow and Svelte Flow; an optional **Pro** subscription covers advanced examples/support, not a different core license). ([github.com/xyflow/xyflow](https://github.com/xyflow/xyflow), [reactflow.dev](https://reactflow.dev/))
- **Browser-only feasibility:** Excellent for a React app — entirely client-side; v12 is explicitly positioned for collaborative apps. **React-only** (no vanilla/Vue/Angular path other than Svelte Flow).
- **Auto-layout:** **None built-in** — the docs recommend integrating elkjs or dagre yourself. ([reactflow.dev/learn/layouting](https://reactflow.dev/learn/layouting/layouting))
- **Custom node/edge rendering:** Nodes and edges are plain React components — very ergonomic for custom SysML shapes, handles (ports), and edge labels.
- **SysML fit:** Great DX for a node-based editor, but it's a generic node/edge canvas: SysML's nesting/containment (parts within blocks), compartments, ports, and constraint enforcement are all custom work, and you must add layout (elkjs) and any semantic model yourself. Good fit if your stack is React and you want a light, MIT-licensed base.

### Excalidraw (@excalidraw/excalidraw)
- **License:** MIT. ([github.com/excalidraw/excalidraw](https://github.com/excalidraw/excalidraw), [npmjs.com/package/@excalidraw/excalidraw](https://www.npmjs.com/package/@excalidraw/excalidraw))
- **Browser-only feasibility:** Yes — embeddable React component (you supply react/react-dom).
- **Auto-layout:** None; it's a free-form, hand-drawn whiteboard, not a graph engine.
- **Custom node/edge rendering:** Hand-drawn aesthetic; no structured node/edge model or ports.
- **SysML fit:** **Poor for a formal SysML v2 modeler** — there is no underlying semantic graph, no auto-layout, and the sketchy style works against precise notation. Useful only for informal sketching/whiteboarding alongside a real modeler, not as the modeling engine itself.

### bpmn-io / diagram-js
- **License:** **diagram-js (the toolkit) is MIT.** Note that **bpmn-js** (the BPMN layer built on it) is under the **bpmn.io license**, which is MIT-style but **requires keeping a visible, non-removable bpmn.io watermark/attribution** in rendered diagrams. For a SysML tool you would build on diagram-js (MIT) and **not** inherit the bpmn-js watermark requirement. ([github.com/bpmn-io/diagram-js](https://github.com/bpmn-io/diagram-js), [diagram-js LICENSE](https://github.com/bpmn-io/diagram-js/blob/develop/LICENSE), [bpmn.io/license](http://bpmn.io/license))
- **Browser-only feasibility:** Yes — ES-module SVG toolkit, fully client-side.
- **Auto-layout:** No general graph auto-layout built in (bpmn-js does only minimal layout); pair with elkjs.
- **Custom node/edge rendering:** Solid editing foundation — palette, context pads, modeling rules, command stack/undo, custom renderers, and a rules system for valid connections. ([bpmn.io/toolkit/bpmn-js](https://bpmn.io/toolkit/bpmn-js/))
- **SysML fit:** diagram-js is an attractive, MIT-licensed *editor* toolkit (more editing infrastructure than React Flow, lighter than GLSP). You'd implement SysML shapes, rules, and a model layer on top, but you inherit a proven palette/modeling/command stack. Watch the licensing boundary: stay on diagram-js, not bpmn-js, to avoid the watermark clause.

### ELK / elkjs (auto-layout engine — complements the above)
- **License:** EPL-2.0. ([github.com/kieler/elkjs](https://github.com/kieler/elkjs), [elkjs LICENSE](https://github.com/kieler/elkjs/blob/master/LICENSE.md), [eclipse.dev/elk](https://eclipse.dev/elk/))
- **Browser-only feasibility:** Yes — elkjs is transpiled from the Java ELK via GWT/J2CL; ships a bundled `elk.bundled.js` for a `<script>` tag and runs well inside a Web Worker for non-blocking layout. ([github.com/eclipse-elk/elk](https://github.com/eclipse-elk/elk))
- **Capabilities:** Flagship layered (Sugiyama-style) algorithm plus force, mrtree, radial, rectpacking, etc. Crucially for SysML, it supports **ports** (fixed attachment points on node borders) and **hierarchical/nested nodes** — exactly what block/IBD diagrams need. ([arxiv.org/abs/2311.00533](https://arxiv.org/abs/2311.00533))
- **Role:** Not a renderer — "it computes positions for the elements of a diagram." Use it behind Sprotty (sprotty-elk), React Flow, maxGraph, or diagram-js. This is the de-facto auto-layout choice for browser MBSE tooling.

### Yjs (collaboration layer — complements the above)
- **License:** MIT. ([github.com/yjs/yjs](https://github.com/yjs/yjs), [yjs.dev](https://yjs.dev/), [docs.yjs.dev](https://docs.yjs.dev/))
- **Browser-only feasibility:** Yes — high-performance CRDT, network-agnostic (P2P or via a sync provider), supports offline editing, version snapshots, and undo/redo.
- **Collaboration features:** Shared data types (Map/Array/Text) merge without conflicts; a separate **Awareness CRDT** handles presence and shared cursors (ephemeral state). React Flow v12 and others document Yjs-based multiplayer patterns.
- **Role for SysML:** The recommended way to add real-time multi-user editing to *any* of the above renderers — model your SysML graph in Yjs shared types and bind it to the chosen diagramming framework's model. Note that some sync transports (WebSocket/HTTP providers like durable-streams) imply a relay server even though Yjs itself is client-side and P2P-capable.

### Bottom-line guidance for a client-side SysML v2 modeler
- **Most complete / model-driven, now client-side-capable:** Eclipse GLSP 2 (browser mode) + ELK, EPL-2.0 throughout — closest architecturally to a rigorous SysML v2 editor, at the cost of framework weight.
- **Maximal control, minimal stack:** Sprotty + elkjs (both EPL-2.0), or maxGraph (Apache-2.0, zero-dependency) — you implement notation but keep things light and permissive.
- **React-native DX:** React Flow (MIT) + elkjs + Yjs (MIT) — fastest to prototype, but containment/ports/semantics are your responsibility.
- **Reference for notation/UX (not client-only):** Eclipse SysON on Sirius Web is the existing browser SysML v2 tool, but it mandates a server backend, so it's a study target rather than a drop-in for a no-backend build.
- **Avoid as the core engine:** Excalidraw (free-form, no model); and if you touch bpmn-io, build on MIT diagram-js, not watermark-bound bpmn-js.

---

## 6. In-browser persistence & serialization

This section surveys the client-only storage and serialization options relevant to a browser-resident SysML v2 modeling app: where to keep the model (IndexedDB/Dexie, File System Access API, OPFS), how to serialize it (JSON / JSON-LD), and how to interoperate with the two SysML v2 exchange formats (the textual notation and the standard API "metamodel" JSON). All facts below are drawn from the cited sources; a few uncertain points are flagged.

### Storage engines

#### IndexedDB via Dexie.js
Dexie is a thin, promise-based wrapper over IndexedDB that exposes a higher-level, query-friendly API and, importantly, "works around bugs in the IndexedDB implementations, giving a more stable user experience" while handling database open/upgrade/indexing automatically ([github.com/dexie/Dexie.js](https://github.com/dexie/Dexie.js/), [dexie.org](https://dexie.org/)). IndexedDB itself stores structured objects (no JSON-stringify-everything), supports indexed queries, and is asynchronous and transactional, with quotas far larger than `localStorage` — typically at least ~1 GB on desktop and, on Chrome, up to ~80% of free disk; Firefox uses a dynamic per-origin quota; older Safari was historically much tighter (~50 MB per origin in some versions) ([Dexie/StorageManager docs](https://dexie.org/docs/StorageManager), [pkgpulse comparison](https://www.pkgpulse.com/guides/dexie-vs-localforage-vs-idb-indexeddb-browser-storage-2026)).

Critical caveat: **IndexedDB is "best-effort" by default and can be evicted by the browser under storage pressure without warning.** To protect a user's model you must request durable storage through the StorageManager API:
- `navigator.storage.persist()` → `Promise<boolean>` requests persistent mode (Chrome grants it silently based on engagement/PWA-install signals; Firefox shows a permission prompt).
- `navigator.storage.persisted()` checks current status.
- `navigator.storage.estimate()` returns `{quota, usage}` (and a `usageDetails` breakdown) so the UI can warn before a large import.
Persistent storage is not evicted to make room for other origins; exceeding quota instead throws a `QuotaExceededError` `DOMException`. HTTPS is required ([dexie.org/docs/StorageManager](https://dexie.org/docs/StorageManager), [MDN StorageManager](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager)). For an offline-first modeler, pairing Dexie with `persist()` + `estimate()` is the recommended baseline.

Dexie is broadly supported (it runs anywhere IndexedDB does, i.e., all modern browsers) and is the default storage layer for higher-level sync engines such as RxDB ([rxdb.info/rx-storage-dexie](https://rxdb.info/rx-storage-dexie.html)).

#### File System Access API (true local files)
`showOpenFilePicker()`, `showSaveFilePicker()`, and `showDirectoryPicker()` let the app read/write actual user files and folders on disk, and the returned `FileSystemFileHandle`/`FileSystemDirectoryHandle` can be **persisted in IndexedDB and re-opened later** (after a permission re-grant), which is ideal for a "open my `.sysml` project file and keep editing it" workflow ([Chrome capabilities docs](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access), [MDN File System API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API)).

The major limitation is reach: the disk-picker methods ship only in **Chromium browsers — Chrome 86+, Edge 86+, Opera 72+ (desktop only)**. **Firefox and Safari do not implement them in any version, and there is no support on any mobile browser**; Mozilla explicitly flagged the local-disk pickers as "harmful" in its standards position, and Apple has not committed to shipping them. caniuse currently puts global support at roughly **31.5%** ([caniuse](https://caniuse.com/native-filesystem-api), [TestMu support tables](https://www.testmuai.com/learning-hub/file-system-access-api-browser-support/), [MDN](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API)). Treat it as a **progressive enhancement**: feature-detect `window.showSaveFilePicker` and fall back to a classic `<a download>` / Blob export (and `<input type=file>` import) on Firefox/Safari/mobile. A community ponyfill exists ([use-strict/file-system-access](https://github.com/use-strict/file-system-access)).

#### OPFS (Origin Private File System)
OPFS is a separate, origin-scoped, **user-invisible** filesystem reached through `navigator.storage.getDirectory()` (returning a `FileSystemDirectoryHandle`). Unlike the File System Access API it needs **no permission prompts and no Safe-Browsing/mark-of-the-web checks**, and it does **in-place writes** rather than the temp-file copy pattern, which makes it markedly faster ([web.dev/origin-private-file-system](https://web.dev/articles/origin-private-file-system), [MDN OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)). Its headline feature is `FileSystemFileHandle.createSyncAccessHandle()`, which exposes **synchronous** `read()`/`write()`/`truncate()`/`flush()` — but **only inside a Web Worker** (the sync handle is not exposed on the main thread, by design, to avoid blocking the UI). The main thread can still use OPFS via the async `createWritable()` API.

Performance is the main reason to choose it: a cited benchmark wrote a 100 MB `ArrayBuffer` in ~**90 ms with `createSyncAccessHandle`** versus ~**850 ms for the equivalent IndexedDB write** ([web.dev](https://web.dev/articles/origin-private-file-system)). **Browser support is now universal across modern engines** (since early 2023): Chrome 86+, Edge 86+, **Firefox 111+, and Safari 15.2+** — notably broader than the File System Access pickers ([renderlog](https://renderlog.in/blog/origin-private-file-system-opfs/), [apurvkhare](http://apurvkhare.com/articles/frontend/web-storage/opfs/)). OPFS is subject to the same quota/eviction rules as other origin storage (use `persist()` to harden it; `estimate()` reports an OPFS slice under `usageDetails.fileSystem`). A common production pattern is running **SQLite compiled to Wasm on top of OPFS** for a real queryable DB in the browser ([Chrome blog: SQLite Wasm + OPFS](https://developer.chrome.com/blog/sqlite-wasm-in-the-browser-backed-by-the-origin-private-file-system)).

| Option | Reach | Strengths | Watch-outs |
|---|---|---|---|
| **IndexedDB + Dexie** | All modern browsers | Queryable, transactional, mature, reactive-sync ecosystems | Best-effort eviction unless `persist()`; verbose without a wrapper |
| **OPFS** | Chrome/Edge 86+, FF 111+, Safari 15.2+ | Fastest writes; sync worker I/O; backs SQLite-Wasm | Sync handle worker-only; invisible to user; still quota-evictable |
| **File System Access API** | Chromium desktop only (~31.5% global) | Real user files; re-openable handles | No Firefox/Safari/mobile; must build a Blob fallback |

### Serialization formats

#### JSON vs JSON-LD
A JSON-LD document is always valid JSON, so any JSON parser handles it; the difference is the optional `@context`, `@id`, and `@type` keywords that map fields to RDF/IRIs. This gives a "smooth upgrade path from JSON to JSON-LD" — consumers that don't care about Linked Data can simply include-but-ignore `@context` ([json-ld.org](https://json-ld.org/), [W3C JSON-LD 1.1](https://www.w3.org/TR/json-ld11/), [Wikipedia](https://en.wikipedia.org/wiki/JSON-LD)). Use JSON-LD when you need semantic interoperability, cross-document linking, or RDF/knowledge-graph mapping; plain JSON is sufficient when the data stays inside your app and needs no external semantic interpretation. This matters here because **the SysML v2 standard API serializes objects as either JSON or JSON-LD** (below), so designing your in-browser model objects to be JSON-LD-friendly (stable `@id`/`@type`) eases round-tripping.

#### SysML v2 standard API ("metamodel") JSON
The OMG **Systems Modeling API and Services** specification (Part 3 of SysML v2) defines a Platform-Independent Model plus REST/HTTP and OSLC platform-specific models; the API "contains full discoverable JSONSchema of the SysML v2 metamodel and uses JSON or JSON-LD to serialize objects," with paging and storable queries for retrieving partial object graphs ([OMG SysML v2](https://www.omg.org/sysml/sysmlv2/), [OMG spec Part 3 PDF](https://www.omg.org/spec/SystemsModelingAPI/1.0/Beta1/PDF), [SysON API docs](https://doc.mbse-syson.org/syson/v2024.11.0/user-manual/integration/api.html)). The reference pilot ([Systems-Modeling/SysML-v2-API-Services](https://github.com/Systems-Modeling/SysML-v2-API-Services)) is a Java/Play/sbt service over PostgreSQL exposing a Swagger-documented REST API; usage patterns live in the [API Cookbook](https://github.com/Systems-Modeling/SysML-v2-API-Cookbook).

Concrete payload shape (load-bearing for round-tripping): each model **Element** is a flat JSON object keyed by metamodel properties, e.g.
```json
{
  "@id": "b2426313-e795-47e8-a2b2-7e29adb12a56",
  "@type": "Package",
  "declaredName": "Package1",
  "elementId": "b2426313-e795-47e8-a2b2-7e29adb12a56"
}
```
`@type` is the metaclass (`Package`, `PartDefinition`, `OwningMembership`, …); `@id` and `elementId` carry the same UUID (the spec has not finalized whether they must always be identical — treat that as a minor open point). Relationships are themselves elements; containment is expressed via `ownedRelationship`/`owningRelationship` references rather than nested objects, so a model is a **flat graph of UUID-referenced nodes**, not a tree. The data model layers **Project → Commit → Element**: a `Commit` has `@id`, `created`, `owningProject`, `previousCommits`, and a `change` array of **`DataVersion`** objects, each with an optional `identity` (which element it targets) and `payload` (the new element data); **omitting the payload denotes deletion** ([SysON API cookbook](https://doc.mbse-syson.org/syson/v2026.5.0/developer-guide/api/api-cookbook.html), [element owned-elements recipe](https://doc.mbse-syson.org/syson/v2025.2.0/developer-guide/element_owned_elements_recipe.html)).

Practical implication for a client-only app: storing your model as this flat `@id`/`@type` element-graph (one object per element, relationships as first-class elements) is the cleanest way to guarantee lossless round-tripping with conformant SysML v2 tools and servers — you can persist exactly the API JSON in Dexie/OPFS and later POST it as commit changes. JSON-LD output is available if/when you want RDF interoperability.

#### SysML v2 textual notation (.sysml / .kerml) import/export
The textual notation is the human-readable concrete syntax built on **KerML**, with a formal **BNF grammar** published in the release repo and a reference **Xtext** editor in the Pilot Implementation that parses `.kerml`/`.sysml` files ([SysML-v2-Release BNF](https://github.com/Systems-Modeling/SysML-v2-Release/blob/master/bnf/KerML-textual-bnf.kebnf), [Pilot Implementation](https://github.com/Systems-Modeling/SysML-v2-Pilot-Implementation), [DeepWiki overview](https://deepwiki.com/Systems-Modeling/SysML-v2-Release/2.2-sysml-v2-textual-notation)). It is positioned as a **tool-neutral exchange format**, and several tools support round-tripping (Sparx Trechoro claims clean export "free from Enterprise Architect-specific tags," and SysON supports both import and export) ([Sparx](https://sparxsystems.com/mbse/sysml2/), [SysON FAQ](https://doc.mbse-syson.org/syson/main/user-manual/faq/faq.html)).

Round-trip caveats to design around:
- **Dependency completeness:** SysON warns that "before importing a file, you need to make sure that all the dependencies of this file are also imported, recursively. Otherwise some relationships won't be resolved." A self-contained export (resolving `import`s) is safer for interchange ([SysON textual import/export](https://doc.mbse-syson.org/syson/v2025.4.0/user-manual/features/import-export-textual.html)).
- **Not yet full-parity:** "Most important SysML v2 concepts can be translated… some concepts are still under development," so textual import/export is **lossy/incomplete in current tooling** — the API JSON serialization is the more faithful interchange channel, with the textual notation best treated as a human-facing import/export convenience.

For a browser app, a pure-JS parser/printer for the textual notation is the gap: the reference parser is Xtext/Java, so client-only textual round-tripping likely requires either a hand-written/PEG grammar from the published BNF, a Wasm-compiled parser, or restricting textual support to export-only with API-JSON as the canonical store. (Flagging this as an architectural risk rather than a solved path — I found no maintained pure-browser JS SysML v2 textual parser in these sources. Note, however, that **SysIDE/Syside's Langium-based parser is pure TypeScript and browser-capable** — see Section 3 — which is the most promising route to closing this gap.)

### Synthesis for a client-only modeler
- **Canonical model store:** keep the model as the standard SysML v2 **API element-graph JSON** (`@id`/`@type`/flat relationships) to guarantee tool interoperability and future server sync.
- **Primary persistence:** **Dexie/IndexedDB** for the live, queryable model + undo history, hardened with `navigator.storage.persist()` and monitored via `estimate()`. Use **OPFS** (with a worker + `createSyncAccessHandle`, optionally SQLite-Wasm) if/when large models or write throughput become a bottleneck — it is now supported in all four major engines.
- **User file I/O:** feature-detect the **File System Access API** for first-class "open/save `.sysml` to disk" on Chromium, with a Blob-download / file-input fallback for Firefox, Safari, and mobile.
- **Interchange:** API-JSON (optionally JSON-LD) as the lossless path; textual `.sysml` import/export as a best-effort, dependency-complete, human-facing convenience given current tooling gaps.

Sources: [dexie.org/docs/StorageManager](https://dexie.org/docs/StorageManager), [github.com/dexie/Dexie.js](https://github.com/dexie/Dexie.js/), [pkgpulse](https://www.pkgpulse.com/guides/dexie-vs-localforage-vs-idb-indexeddb-browser-storage-2026), [web.dev OPFS](https://web.dev/articles/origin-private-file-system), [MDN OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system), [Chrome SQLite-Wasm+OPFS](https://developer.chrome.com/blog/sqlite-wasm-in-the-browser-backed-by-the-origin-private-file-system), [Chrome File System Access](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access), [caniuse File System Access](https://caniuse.com/native-filesystem-api), [TestMu](https://www.testmuai.com/learning-hub/file-system-access-api-browser-support/), [json-ld.org](https://json-ld.org/), [W3C JSON-LD 1.1](https://www.w3.org/TR/json-ld11/), [OMG SysML v2](https://www.omg.org/sysml/sysmlv2/), [OMG Systems Modeling API Part 3](https://www.omg.org/spec/SystemsModelingAPI/1.0/Beta1/PDF), [SysML-v2-API-Services](https://github.com/Systems-Modeling/SysML-v2-API-Services), [SysML-v2-API-Cookbook](https://github.com/Systems-Modeling/SysML-v2-API-Cookbook), [SysON API cookbook](https://doc.mbse-syson.org/syson/v2026.5.0/developer-guide/api/api-cookbook.html), [SysON textual import/export](https://doc.mbse-syson.org/syson/v2025.4.0/user-manual/features/import-export-textual.html), [SysML-v2-Release BNF](https://github.com/Systems-Modeling/SysML-v2-Release/blob/master/bnf/KerML-textual-bnf.kebnf), [SysML-v2-Pilot-Implementation](https://github.com/Systems-Modeling/SysML-v2-Pilot-Implementation).

---

## 7. Comparison of existing SysML v2 tools

The table consolidates the tools surveyed above, focused on the dimensions that matter for positioning a new pure-browser modeler. "Browser-only?" asks whether the tool can run entirely client-side with **no required server backend** — the defining constraint for this project.

| Tool | Type/Deployment | Open/Closed | Tech stack | SysML v2 support | API/Automation | Browser-only? |
|---|---|---|---|---|---|---|
| **Eclipse SysON** | Web app (server-backed); Docker/Spring + Postgres | Open (EPL-2.0 / LGPL-3.0) | Java 21, Spring Boot, EMF/Ecore; React + Sprotty + ELK; PostgreSQL; GraphQL | Graphical (General, Interconnection, Action Flow, State Transition), forms, tables; textual import/export (partial); initial ViewUsage | GraphQL (primary) + some REST; standard SysML v2 REST API on roadmap | **No** — requires Spring + PostgreSQL backend |
| **OMG Pilot Implementation** | Desktop IDE + Jupyter kernel | Open (EPL-2.0 + GPL option) | Java 21, Eclipse, Xtext; PlantUML/GraphViz viz; JupyterLab 4.x kernel | Reference/canonical: full textual KerML+SysML parser, type-checker, normative libraries | Companion REST server (see below); `%publish` magic to API | **No** — desktop Eclipse / local Jupyter |
| **OMG API & Services (reference server)** | REST server | Open (EPL-2.0) | Scala, Play Framework, sbt, JDK 11; PostgreSQL; OpenAPI 3.1 / Swagger | Serves the standard SysML v2 metamodel (JSON / JSON-LD); Project→Commit→Element repository | **The** standard REST/HTTP API (CRUD, commits, branches, queries) | **No** — server process (port 9000) + Postgres |
| **SysIDE / Syside (Sensmetry)** | VS Code extension (desktop + VS Code for Web); CLI; Python automation | Mixed: Editor open (EPL-2.0 + GPLv2-CE), Modeler/Automator commercial | TypeScript on **Langium**; Monaco; Web Worker LSP | Textual SysML v2 + KerML (2024-12); semantic validation, diagram gen (Modeler), tables/matrices, ReqIF | Headless CLI (Modeler); Python Automator; Sysand package manager | **Partial/Yes** — Langium core runs in-browser (VS Code for Web); full Modeler is desktop/commercial |
| **Dassault — Cameo / CATIA Magic** | Desktop authoring + Teamwork Cloud server; MagicLab browser viewer | Closed (commercial; free Community Edition) | Proprietary desktop client; Teamwork Cloud server | v1 + v2 coexist (Enterprise tiers only, 2026x); textual↔graphical sync; v1→v2 migration | Standard SysML v2 REST API via Teamwork Cloud (CI/CD) | **No** for authoring — MagicLab/Collaborator are read-only browser viewers |
| **PTC Modeler** | Desktop authoring + managed DB; Windchill/OSLC | Closed (commercial) | Windows desktop client; SQL Server backing store | Incremental (10.0→10.2): structure, behavior, State, Analysis, Verification; `.sysml` text import | OSLC; Windchill PLM digital thread | **No** — desktop client |
| **IBM Rhapsody Systems Engineering** | Described as web-based platform; multi-user | Closed (commercial) | Not publicly detailed; "web-based platform" per Siemens | New v2 product (v1.5, Oct 2025); drag-drop auto-generates spec-compliant v2 model | Standard v2 API & Services; Teamcenter MBSE (Siemens partnership) | **Partial** — positioned as web-based, but enterprise-server-backed (not no-backend) |
| **Sparx Enterprise Architect ("Trechoro")** | Desktop authoring | Closed (commercial) | UML-free environment built directly on KerML | Preview/early-access (2025); v2 library elements; textual import + clean export | Textual `.sysml` import/export | **No** — desktop client |
| **Vitech GENESYS** | Desktop (roadmap) | Closed (commercial) | Not yet shipped for v2 | Roadmap — next-gen GENESYS to incorporate SysML v2 | Vendor on OMG SST/FTF | **No** — desktop (planned) |

**Pattern:** every *authoring* tool today is either desktop-based or requires an enterprise server (Spring/Postgres for SysON, Teamwork Cloud for Dassault, Play/Postgres for the reference API). The only genuinely client-side-capable building block among shipping SysML v2 tools is **SysIDE/Syside's Langium core**, and even that is a *textual* language server rather than a graphical modeler. **No shipping tool is a pure-browser, no-backend, graphical-plus-textual SysML v2 authoring environment** — which is precisely the gap below.

---

## Gaps & opportunities

Synthesizing the six sections, a new **pure-browser, no-required-backend** SysML v2 modeler can occupy a position that none of the surveyed tools currently fill. What it should do differently:

1. **Be genuinely backend-optional — the headline differentiator.** Eclipse SysON (the closest open web modeler) mandates Spring Boot + PostgreSQL; Dassault's browser surface (MagicLab/Collaborator) is read-only over Teamwork Cloud; the reference API is a Scala/Play/Postgres server. A modeler that runs entirely from static hosting (or fully offline as a PWA), storing models in **IndexedDB/Dexie hardened with `navigator.storage.persist()`**, with **OPFS** for large-model throughput, would be the first **authoring** tool deployable with zero server. The server becomes optional — for sync and team sharing — not a prerequisite to draw a single block.

2. **Adopt the standard SysML v2 API element-graph JSON as the native in-memory and on-disk model.** Rather than inventing a proprietary format (or coupling to EMF/Ecore as SysON does), store the model as the flat `@id`/`@type` element graph the OMG API & Services spec already defines, with relationships as first-class elements and Project→Commit→Element/`DataVersion` change semantics. This guarantees **lossless round-tripping** and lets the same payloads be `POST`ed to any conformant API server later — interoperability is designed in from the first commit, not retrofitted.

3. **Unify graphical and textual editing as true peers, with live two-way sync.** SysON treats text as lossy import/export, not a live IDE; SysIDE/Syside is a strong *textual* IDE but not a graphical modeler; commercial tools bolt one onto the other. A browser tool can host a **Langium-based SysML v2/KerML language server in a Web Worker** (Monaco editor, client-side, the SysIDE/Syside lineage) **side-by-side** with a diagram canvas bound to the same element graph — giving simultaneous, synchronized text and diagram views with no server round-trip. This also directly closes the "no maintained pure-browser JS textual parser" gap flagged in Section 6, since Langium is exactly that parser.

4. **Choose a permissive, client-side-capable rendering stack and own the notation.** The diagramming survey points to a pragmatic split: **ELK/elkjs (Web Worker auto-layout) is non-negotiable** because it natively supports ports and hierarchical/nested nodes — exactly block/IBD/interconnection geometry. Pair it with a client-side renderer chosen for control and license: **Sprotty or GLSP 2 browser-mode** (EPL-2.0, model-driven, the architecture SysON itself renders with) for maximal rigor, or **maxGraph (Apache-2.0, zero-dependency)** / **React Flow (MIT)** for a lighter, more permissive stack. Avoid Sirius Web (server-bound) and bpmn-js (watermark). Since no framework ships SysML notation, owning the compartment/port/containment rendering is unavoidable work — and an opportunity to get the notation right.

5. **Make collaboration and offline first-class via CRDTs, not a database.** Yjs (MIT) over the shared element graph gives conflict-free multi-user editing, presence/awareness cursors, offline editing, and undo/redo **without a stateful application server** — only an optional lightweight relay for transport. This inverts the commercial model (IBM/Dassault require enterprise servers for multi-user) and fits the backend-optional thesis: collaboration becomes a peer-to-peer or thin-relay capability layered on the same local-first model.

6. **Compete on adoption ergonomics, not feature-count parity.** The realistic gaps in *every* tool are the on-ramps: SysON's behavioral/ViewUsage coverage is still maturing and it doesn't scale to large models; textual round-trip is lossy everywhere; the desktop incumbents are expensive (Dassault's ~20% 2026 price rise, Enterprise-tier-only v2) and heavyweight. A focused browser tool should target **instant zero-install trial** (open a URL, start modeling), **standards-faithful interchange** (API-JSON canonical, textual as convenience), and **the normative model libraries bundled client-side** for correct cross-reference resolution offline. It need not match Cameo feature-for-feature to win the "try SysML v2 in thirty seconds, in any browser, with nothing to install and nothing to pay" use case — a niche the entire current market leaves open.

**In one sentence:** the opportunity is a *local-first, standards-native* SysML v2 modeler — Langium-in-a-worker for text, elkjs + a permissive renderer for diagrams, the OMG API element-graph as the model, Dexie/OPFS for persistence, and Yjs for optional collaboration — delivering in-browser graphical **and** textual authoring with **no mandatory backend**, which is exactly the combination no surveyed tool provides today.
