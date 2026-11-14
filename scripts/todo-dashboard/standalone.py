#!/usr/bin/env python3
"""Build `standalone.html`: the open-items dashboard as ONE self-contained page.

The hosted dashboard is a claude.ai artifact whose runtime (`dash`) the page
depends on. This script wraps the page's own markup, styles and scripts around a
tiny `dash` shim, embeds the four `ds_*.json` datasets inline, and loads d3 from
the jsDelivr CDN — so the page renders anywhere a browser can open a file or a
static server, no artifact runtime needed.

Run from this folder after `refresh.py`: python3 standalone.py
Writes `standalone.html` next to the datasets it embeds.
"""
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
PAGE = os.path.join(HERE, "index.html")
OUT = os.path.join(HERE, "standalone.html")
DATASETS = ("open", "timeline", "windows", "origin")
DS_FILES = {"open": "ds_open.json", "timeline": "ds_timeline.json", "windows": "ds_windows.json", "origin": "ds_origin.json"}

TOKENS = """:root {
  --color-bg: #faf9f5; --color-panel: #ffffff; --color-border-line: #e8e5dc;
  --color-fg: #1f1e1d; --color-fg-muted: #6e6a63; --cds-surface-popover: #ffffff;
  --cds-border: #e8e5dc; --cds-shadow-popover: 0 4px 16px rgba(0,0,0,.10);
  --cds-text-secondary: #6e6a63; --cds-chart-status-critical: #d92d20;
  --cds-radius: 8px; --cds-gap-lg: 24px; --cds-gap-md: 16px; --cds-gap-sm: 8px;
  --cds-pad-xs: 4px; --cds-pad-sm: 8px; --cds-pad-md: 16px; --cds-pad-lg: 24px;
  --cds-font-size-title: 28px; --cds-font-size-heading: 18px; --cds-font-size-body: 15px;
  --cds-font-size-caption: 12.5px; --cds-font-weight-medium: 500; --cds-dur-slow: .2s;
  --font-anthropic-sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-anthropic-serif: Georgia, "Times New Roman", serif;
}
html { background: var(--color-bg); color: var(--color-fg); }
body { margin: 0; padding: var(--cds-pad-lg); }
"""

DASH_SHIM = """
/* ---- standalone dash shim (replaces the artifact runtime) ---- */
const DATASETS = __DATASETS__;
const calcs = []; const draws = new Map();
const dash = {
  colors: ['#d92d20', '#2e7d32', '#1565c0', '#8e24aa', '#f57c00', '#00838f', '#5d4037', '#546e7a'],
  calc(name, spec) { calcs.push({ name, spec }); },
  data(id) { return { status: 'ok', data: DATASETS[id] }; },
  draw(name, fn) { draws.set(name, fn); },
};
"""

BOOT = """
function boot() {
  (0, eval)(PAGE_SCRIPTS);
  for (const { name, spec } of calcs) {
    try { DATASETS[name] = spec.fn(...spec.inputs.map((i) => DATASETS[i])); } catch (e) { console.warn(name, e); }
  }
  for (const [name, fn] of draws) {
    const el = document.querySelector('[data-draw="' + name + '"]');
    if (el) { try { fn(el); } catch (e) { console.warn(name, e); } }
  }
}
if (typeof d3 === 'undefined') {
  const s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js';
  s.onload = boot;
  s.onerror = () => { console.error('d3 did not load'); };
  document.head.appendChild(s);
} else {
  boot();
}
"""


def main() -> None:
    page = open(PAGE, encoding="utf-8").read()
    style = re.search(r"<style>.*?</style>", page, re.S).group(0)
    body = re.search(r'<div class="oi">.*</div>\s*(?=<script>)', page, re.S).group(0)
    scripts = re.findall(r"<script>(.*?)</script>", page, re.S)

    datasets = {}
    for key, fname in DS_FILES.items():
        with open(os.path.join(HERE, fname), encoding="utf-8") as fh:
            datasets[key] = json.load(fh)

    shim = DASH_SHIM.replace("__DATASETS__", json.dumps(datasets, separators=(",", ":")))
    page_scripts = "const PAGE_SCRIPTS = " + json.dumps("\n".join(scripts)) + ";"

    head = "\n".join(
        [
            "<!doctype html>",
            '<html lang="en">',
            "<head>",
            '<meta charset="utf-8">',
            '<meta name="viewport" content="width=device-width, initial-scale=1">',
            "<title>Sysprose open-items dashboard</title>",
            "<style>" + TOKENS + "</style>",
            style,
            "</head>",
            "<body>",
        ]
    )
    tail = ["<script>" + shim + "\n" + page_scripts + "</script>"]
    tail.append("<script>" + BOOT + "</script>")
    tail.append("</body>")
    tail.append("</html>")

    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write(head + "\n" + body + "\n" + "\n".join(tail) + "\n")
    print(f"wrote {OUT} ({os.path.getsize(OUT)} bytes, datasets: " + ", ".join(f"{k}={len(v)}" for k, v in datasets.items()) + ")")


if __name__ == "__main__":
    main()
