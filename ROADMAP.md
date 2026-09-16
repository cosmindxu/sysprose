# Roadmap

Big features that need a refined plan before work starts. Concrete next steps belong in
[`TODO.md`](TODO.md). Items that need decisions after research belong in [`RESEARCH.md`](RESEARCH.md).
User-interface work has its own roadmap in [`docs/UI-ROADMAP.md`](docs/UI-ROADMAP.md).

## Behaviour verification in the app

`reach` and `check-behaviour` are terminal- and SDK-only. The README's capability table lists them as
having no view. Their results include reachable, unreachable and dead states, deadlocks, traps,
safety patterns with witness runs, `cover`, `recovery` and the every-run line. A view could overlay
these on the state diagram and step through a witness run in the existing simulation panel.

**Needs a plan for:**

- which results belong in the diagram and which in a table;
- how a result that was withheld (inconclusive, with the reason) is shown so it never reads as a pass;
- whether the browser runs the walk itself, or reads results the terminal wrote into the file, as the
  requirement verdicts do today;
- the end-to-end tests that cover it.

## Liveness checking

This becomes a roadmap item once [`RESEARCH.md`](RESEARCH.md) R1 has its decisions (fairness carrier,
strengths, the safety re-check), and it needs a model that releases it. It is listed here because it is
the most likely next verification feature.
