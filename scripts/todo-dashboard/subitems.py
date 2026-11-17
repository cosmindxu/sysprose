#!/usr/bin/env python3
"""Inside the rollups — the sub-items of the open TODO bullets.

The dashboard's open count is per TODO bullet, but since the backlog sweep the work
happens INSIDE the rollup bullets: `(a)`/`(1)` clauses, each closed or narrowed by a
merge and marked in the item's own text ("CLOSED 2026-11-17 by a5-words W4: ...",
"RULED PERMANENT ...", "narrowed ..."). This script extracts those sub-items from
TODO.md and writes:

  ds_rollups.json  — per rollup: title, section, tier (matched to ds_open.json),
                     sub-items with {key, text, status, closed_day, closed_by},
                     counts, and global totals
  rollups.html     — a self-contained detail page linked from the dashboard

Phase 1 is heuristic: it reads the closure markers the merge-time TODO rewrite writes,
and it only uses the lettered/numbered markers the rollups already use. Run it after
entries.py (its tier match reads ds_open.json); refresh.py does that.
"""
import difflib
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
TODO = os.path.join(REPO, 'TODO.md')
OUT_JSON = os.path.join(HERE, 'ds_rollups.json')
OUT_HTML = os.path.join(HERE, 'rollups.html')

MARK = re.compile(r'(?:^|[\s.;:])(?:\(([a-z])\)|\((\d{1,2})\))\s')
CLOSED = re.compile(r'CLOSED\s+(\d{4}-\d{2}-\d{2})\s+by\s+([^:;.)]+)')
RULED = re.compile(r'RULED\s+(?:PERMANENT\s+)?(\d{4}-\d{2}-\d{2})')
NARROW = re.compile(r'\bnarrow(?:ed|ing)\b', re.I)
HELD = re.compile(r'\bHELD\b|\bheld by (?:a|the) ruling\b', re.I)


def norm(s):
    return re.sub(r'\s+', ' ', s).strip()


def read_bullets():
    """[(title, section, body)] for every open bullet in TODO.md."""
    text = open(TODO, encoding='utf-8').read()
    lines = text.split('\n')
    bullets, cur, section = [], None, ''
    for line in lines:
        if line.startswith('## '):
            section = line[3:].strip()
        m = re.match(r'^- \[( |x|X)\] \*\*(.*)', line)
        if m:
            if cur:
                bullets.append(cur)
            rest = m.group(2)
            title = rest.split('**', 1)[0] if '**' in rest else norm(rest)
            cur = {'title': norm(title), 'section': section, 'body': ''}
            continue
        if cur is not None and (line.startswith('      ') or line.strip() == ''):
            cur['body'] += ' ' + line.strip()
        elif cur is not None and not line.startswith('- ['):
            pass
    if cur:
        bullets.append(cur)
    return bullets


def sub_items(body):
    """Split a bullet body on its lettered/numbered markers; classify each segment."""
    hits = list(MARK.finditer(body))
    if not hits:
        return []
    subs, seen = [], {}
    for i, h in enumerate(hits):
        end = hits[i + 1].start() if i + 1 < len(hits) else len(body)
        seg = body[h.start():end]
        key = (h.group(1) or h.group(2)).strip()
        seen[key] = seen.get(key, 0) + 1
        uid = key if seen[key] == 1 else f'{key}#{seen[key]}'
        seg = norm(seg)
        status, closed_day, closed_by = 'open', '', ''
        m = CLOSED.search(seg)
        if m:
            status, closed_day, closed_by = 'closed', m.group(1), norm(m.group(2))
        else:
            m = RULED.search(seg)
            if m:
                status, closed_day, closed_by = 'ruled', m.group(1), 'ruling'
            elif NARROW.search(seg):
                status = 'narrowed'
            elif HELD.search(seg):
                status = 'held'
        label = re.sub(r'^\([a-z0-9]+\)\s*', '', seg)[:220]
        subs.append({'key': uid, 'text': label, 'status': status,
                     'closed_day': closed_day, 'closed_by': closed_by[:60]})
    return subs


def tiers():
    """id -> (tier, title) from ds_open.json, matched by title."""
    import difflib
    open_path = os.path.join(HERE, 'ds_open.json')
    if not os.path.exists(open_path):
        return []
    try:
        rows = json.load(open(open_path))
    except Exception:
        return []
    return [(r.get('id'), (r.get('severity') or '').lower(), r.get('title') or '') for r in rows]


def match_tier(title, rows):
    best = None
    for rid, sev, t in rows:
        ratio = difflib.SequenceMatcher(None, t.lower(), title.lower()).ratio()
        if ratio > 0.72 and (best is None or ratio > best[0]):
            best = (ratio, rid, sev)
    return (best[1], best[2]) if best else (None, '')


def build():
    bullets = read_bullets()
    rows = tiers()
    rollups, totals = [], {'open': 0, 'closed': 0, 'narrowed': 0, 'ruled': 0, 'held': 0, 'subs': 0}
    for b in bullets:
        subs = sub_items(b['body'])
        if not subs:
            continue
        rid, tier = match_tier(b['title'], rows)
        c = {'open': 0, 'closed': 0, 'narrowed': 0, 'ruled': 0, 'held': 0}
        for s in subs:
            c[s['status']] += 1
            totals[s['status']] += 1
        totals['subs'] += len(subs)
        rollups.append({'id': rid, 'tier': tier, 'title': b['title'], 'section': b['section'],
                        'subs': subs, 'counts': c})
    rollups.sort(key=lambda r: (-(r['counts']['open']), r['title'].lower()))
    data = {'rollups': rollups, 'totals': totals}
    json.dump(data, open(OUT_JSON, 'w'), indent=1)
    write_html(data)
    print(f'rollups: {len(rollups)} with sub-items; {totals["subs"]} sub-items '
          f'({totals["open"]} open, {totals["closed"]} closed, {totals["narrowed"]} narrowed, '
          f'{totals["ruled"]} ruled, {totals["held"]} held)')


def write_html(data):
    t = data['totals']
    rows = []
    for r in data['rollups']:
        c = r['counts']
        n = max(1, sum(c.values()))
        done = c['closed'] + c['ruled'] + c['held']
        pct = round(100 * done / n)
        subs = ''.join(
            f'<tr class="s-{s["status"]}"><td class="k">({s["key"]})</td>'
            f'<td><span class="pill {s["status"]}">{s["status"]}</span></td>'
            f'<td class="t">{s["text"]}</td><td class="b">{s["closed_by"]}</td><td class="d">{s["closed_day"]}</td></tr>'
            for s in r['subs'])
        rows.append(
            f'<tr class="rollup" data-tier="{r["tier"]}">'
            f'<td class="n">{r["id"] if r["id"] is not None else "—"}</td>'
            f'<td><b>{r["title"]}</b><div class="muted">{r["section"]}</div></td>'
            f'<td class="n">{c["open"]}/{sum(c.values())}</td>'
            f'<td class="bar"><span style="width:{pct}%"></span></td>'
            f'<td class="n">{c["closed"]}</td><td class="n">{c["narrowed"]}</td>'
            f'<td class="n">{c["ruled"]}</td><td class="n">{c["held"]}</td></tr>'
            f'<tr class="detail" hidden><td colspan="8"><table class="subs">{subs}</table></td></tr>')
    html = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Inside the rollups — Sysprose</title>
<style>
body{{font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;margin:0;padding:24px;background:#faf9f5;color:#1f1e1d}}
h1{{font-size:26px;margin:0 0 4px}} .lead{{color:#6e6a63;margin:0 0 18px}}
.card{{background:#fff;border:1px solid #e8e5dc;border-radius:8px;padding:16px 18px;margin-bottom:16px}}
table{{border-collapse:collapse;width:100%}} th,td{{text-align:left;padding:6px 8px;border-bottom:1px solid #f0ede5;vertical-align:top}}
th{{font-size:12.5px;color:#6e6a63;font-weight:600}} td.n,th.n{{text-align:right;white-space:nowrap}}
.bar{{width:130px}} .bar span{{display:block;height:8px;border-radius:4px;background:#2e7d32}}
.muted{{color:#6e6a63;font-size:12.5px}} .rollup{{cursor:pointer}} .rollup:hover{{background:#fcfbf8}}
.pill{{display:inline-block;padding:1px 7px;border-radius:9px;font-size:11.5px;font-weight:600}}
.pill.open{{background:#fdecea;color:#b42318}} .pill.closed{{background:#e7f4e8;color:#1e6b24}}
.pill.narrowed{{background:#fff4e5;color:#a3560b}} .pill.ruled{{background:#eef2ff;color:#3538cd}} .pill.held{{background:#f2f0ff;color:#5925dc}}
.subs td{{font-size:13px}} .k{{color:#6e6a63;white-space:nowrap}}
.filters button{{margin-right:6px;border:1px solid #e8e5dc;background:#fff;border-radius:6px;padding:4px 10px;cursor:pointer}}
.filters button.on{{background:#1f1e1d;color:#fff}}
</style></head><body>
<h1>Inside the rollups</h1>
<p class="lead">{len(data['rollups'])} open rollup bullets carry {t['subs']} named sub-items:
<b>{t['open']}</b> open, <b>{t['closed']}</b> closed by a step, <b>{t['narrowed']}</b> narrowed,
<b>{t['ruled']}</b> ruled, <b>{t['held']}</b> held. Click a row for its sub-items.
<a href="standalone.html">← back to the dashboard</a></p>
<div class="card filters"><button class="on" data-f="all">All</button><button data-f="open">With open sub-items</button>
<button data-f="false">Wrong-answer tier</button><button data-f="weaker">Weaker tier</button><button data-f="polish">Polish tier</button></div>
<div class="card"><table>
<thead><tr><th class="n">No.</th><th>Rollup</th><th class="n">Open/subs</th><th>Done</th><th class="n">Closed</th><th class="n">Narrowed</th><th class="n">Ruled</th><th class="n">Held</th></tr></thead>
<tbody>{''.join(rows)}</tbody></table></div>
<script>
document.querySelectorAll('tr.rollup').forEach(function (r) {{
  r.addEventListener('click', function () {{ var d = r.nextElementSibling; if (d && d.classList.contains('detail')) d.hidden = !d.hidden; }});
}});
document.querySelectorAll('.filters button').forEach(function (b) {{
  b.addEventListener('click', function () {{
    document.querySelectorAll('.filters button').forEach(function (x) {{ x.classList.remove('on'); }}); b.classList.add('on');
    var f = b.dataset.f;
    document.querySelectorAll('tr.rollup').forEach(function (r) {{
      var ok = f === 'all' || (f === 'open' && Number(r.children[2].textContent.split('/')[0]) > 0) || (f !== 'open' && r.dataset.tier === f);
      r.style.display = ok ? '' : 'none';
      var d = r.nextElementSibling; if (d && d.classList.contains('detail')) {{ d.hidden = true; d.style.display = ok ? '' : 'none'; }}
    }});
  }});
}});
</script></body></html>"""
    open(OUT_HTML, 'w', encoding='utf-8').write(html)


if __name__ == '__main__':
    build()
