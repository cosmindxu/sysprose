# Roadmap

Big features that need a refined plan before work starts. Concrete next steps belong in
[`TODO.md`](TODO.md). Items that need decisions after research belong in [`RESEARCH.md`](RESEARCH.md).
User-interface work has its own roadmap in [`docs/UI-ROADMAP.md`](docs/UI-ROADMAP.md).

## Per-instance readings in the check and the literal engine

The numeric surface and SMT read a value per instance: a definition's derived value evaluated in a
usage's own context, a value that reaches a feature through a binding, and a `default` that gives way
to a binding in one usage but not in another. The check (`checkConstraints`, the Problems view) and the
literal verify engine read one value per feature. Where the instance value differs they abstain —
`unknown` on the check, `inconclusive` on the literal engine — so they never contradict the other
surfaces, but they leave those requirements undecided, and an SMT refutation over such a value cannot be
confirmed by the literal re-read. A default that gives way in one usage is also left unread in its
siblings, which is cautious but weaker than it needs to be.

**Needs a plan for:**

- instance-path contexts in `evaluate-model.ts` and the literal engine (a shared usage such as `Q::p` is
  read once per enclosing instance, not once per feature);
- per-usage `default` resolution, so a sibling that leaves the bound value unset still reads the default;
- the cost on large instance trees (the solver's per-instance reading already pays it);
- differential tests that pin the four surfaces to one verdict on every binding/default case of the
  soundness pass (probes h2, k3, c2–c4, d1b, w2).

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

## Google Drive "Open with" (phase 2 of the Drive feature)

Today a file a classmate shared opens through a `?drive=` link, the panel's paste field or Google's
Picker, and under the `drive.file` scope it has to be chosen once in the Picker before the app may
read it. Drive's own **Open with → Sysprose** would skip that step and open the file from Drive's
web interface directly.

**Needs a plan for:**

- the Google Workspace Marketplace listing it requires (the Drive UI integration, the `drive.install`
  scope, an app icon and therefore Google's brand check, and the store-listing review);
- the open URL Drive calls with its `state` parameter, and how it reaches the same open path as a
  `?drive=` link;
- whether the model site's deployment is the one listed, given that the consent screen's homepage and
  privacy page live there;
- what can be tested without real Google, and what stays a manual check.

## Liveness checking

This becomes a roadmap item once [`RESEARCH.md`](RESEARCH.md) R1 has its decisions (fairness carrier,
strengths, the safety re-check), and it needs a model that releases it. It is listed here because it is
the most likely next verification feature.
