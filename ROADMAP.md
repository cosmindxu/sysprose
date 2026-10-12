# Roadmap

Big features that need a refined plan before work starts. Concrete next steps belong in
[`TODO.md`](TODO.md). Items that need decisions after research belong in [`RESEARCH.md`](RESEARCH.md).
User-interface work has its own roadmap in [`docs/UI-ROADMAP.md`](docs/UI-ROADMAP.md).

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
