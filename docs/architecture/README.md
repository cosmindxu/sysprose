# Sysprose — Architecture Documentation

This subfolder documents the **as-built** architecture of Sysprose
(`src/`, ~88 TS/TSX files, ~38 k LOC) and records the results of a
**multi-agent adversarial review**. It is intended to be read alongside the
original design intent in [`../03-architecture-and-plan.md`](../03-architecture-and-plan.md).

> ⚠️ Scope note. The codebase has grown well beyond the original plan. Five
> modules that the plan explicitly listed as **out of scope** (`collab/`,
> `server/`, `library/` full-loader, `semantics/`, Sequence/Geometry/Matrix/Grid
> diagram views, OSLC) **now ship in `src/`**. The diagrams below depict the
> *actual* structure; the gap is quantified in
> [`04-dependency-graph.md`](./04-dependency-graph.md) and
> [`08-adversarial-review.md`](./08-adversarial-review.md).

## How to read this set (C4 + flows + review)

| Doc | View | What it answers |
|-----|------|-----------------|
| [`01-system-context.md`](./01-system-context.md) | **C4 L1 — System Context** | Who uses it, what it talks to, deployment shape |
| [`02-container-view.md`](./02-container-view.md) | **C4 L2 — Containers** | The deployable units (browser SPA, REST API, collab relay) |
| [`03-component-view.md`](./03-component-view.md) | **C4 L3 — Components** | The 12 source modules under `src/` and their public surfaces |
| [`04-dependency-graph.md`](./04-dependency-graph.md) | **Module dependency graph** | Documented layering vs **actual** imports; scope drift catalog |
| [`05-data-flow.md`](./05-data-flow.md) | **Data flow + model shape** | How a `.sysml` text becomes a rendered diagram, and back |
| [`06-sequence-diagrams.md`](./06-sequence-diagrams.md) | **Key sequences** | Text-edit, model-mutation, collab-apply, REST-query |
| [`07-deployment-view.md`](./07-deployment-view.md) | **Deployment topology** | Static host, Docker, GitHub Pages, collab relay |
| [`08-adversarial-review.md`](./08-adversarial-review.md) | **Adversarial review** | Severity-rated findings from 5 independent reviewer lenses |

All diagrams are **Mermaid** (rendered natively by GitHub, GitLab, VS Code, and
most Markdown viewers).

## Adversarial review — headline numbers

The review was performed by **5 independent agents**, each with a different
adversarial lens (Architecture, Correctness/Semantics, Security/Robustness,
Performance/Scalability, Test-quality/Maintainability). Findings were
de-duplicated and severity-rated; full evidence in
[`08-adversarial-review.md`](./08-adversarial-review.md).

| Severity | Count | Representative themes |
|----------|------:|----------------------|
| **Critical** | **11** | unauthenticated collab relay; main-thread ELK layout on every keystroke; round-trip losses (`:=`, body expressions, several metaclasses); id-collision fallback; ~2.1 k LOC of dead parsers; no `src/ui` unit tests; scope drift |
| **High** | **22** | unbounded ReDoS via `matches` operator; per-mutation full-validate+serialize; 50× full-model undo clones; missing validation rules; stale name-resolution caches; `ajv` declared devDep but imported in prod |
| **Medium** | **20** | no security headers/CSP; Docker-as-root; weak OSLC/RDF tests; documentation drift; type-unsafe casts at trust boundaries |
| **Low** | **14** | modifier emission order; `.gitignore` gap; flaky timing assertion; etc. |

**Bright spots** (verified, not just claimed): no `eval`/`Function`/`vm`
anywhere; hand-written lexer is linear-time (no ReDoS); tree-walking expression
evaluator is sandbox-free but injection-free; React UI has zero
`dangerouslySetInnerHTML`/`innerHTML`/`document.write`; no prototype-pollution
sinks; RDF/XML serializers escape correctly; structuredClone-on-load prevents
reference aliasing; no committed secrets; dependency-tree has *no directly
exploitable production-runtime advisory*.

## Method

1. Each agent received the same project context but an independent adversarial
   lens, and was instructed to cite `file:line` evidence for every finding and
   to distinguish **PROVEN** from **SUSPECTED**.
2. Agents were forbidden from modifying source (read-only review). The only
   files created by this exercise live under this `docs/architecture/` folder.
3. Verbatim tool output (`tsc --noEmit`, `vitest run`, `npm audit`, `madge`) was
   captured where the sandbox permitted; a few long-running commands were
   substituted with the last cached artifact (noted inline).

## Status & ownership

This set reflects the tree as of **2026-07-07**. It is a point-in-time snapshot;
the codebase is active. When the underlying issues are addressed, the
corresponding entries in `08-adversarial-review.md` should be struck through
with a fix-commit reference rather than silently deleted, so the audit trail is
preserved.
