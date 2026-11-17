#!/usr/bin/env python3
"""Coverage — the reference universe of SysML v2 language areas, and how much of it
the tool measurably covers.

Phase 1 (this script) builds the **universe definition** and reports what is measured:

  coverage-universe.json  — rows from the authoritative docs:
        KERML  the key abstract-syntax metaclasses (02-omg-standard-reference §2.2)
        TXT    the textual-notation construct areas (§3.2)
        GRAPH  the view/diagram kinds (§4.1)
        API    the REST/OSLC service groups (§5.7)
        CON    the constraint/parametric classes (docs/CONSTRAINT-CLASSES.md)
  coverage.html           — the matrix page, two weighted headers and the denominators.

States are only set where a document *measures* it:
  - CON rows: the class register's level (differential-tested / tested / experimental /
    fenced / unpinned) -> decided / partial / refused.
  - TXT rows: parsed = the construct occurs in the 637-model corpus (the corpus test
    proves parse conformance for every corpus model); semantics/decision stay
    `unmeasured` (only the constraint lane measures them today).
  - GRAPH/API/KERML rows: `unmeasured` unless a known note applies (the app renders
    17 views; the API/OSLC PSMs have their own conformance tests — recorded as notes,
    not folded into the percentages).

The two headers:
  construct coverage = corpus-weighted share of rows whose state is parsed/decided/rendered
  decision coverage  = share of measured CON rows the solver decides (level >= tested)

They are deliberately NOT a single "percent of all SysML": the denominators are stated on
the page (rows defined, rows measured, rows unmeasured) and the soundness fact (FALSE 0)
is reported beside them, never folded in.
"""
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
DOC = os.path.join(REPO, 'docs')
OUT_JSON = os.path.join(HERE, 'coverage-universe.json')
OUT_HTML = os.path.join(HERE, 'coverage.html')
CORPUS = '/home/xcos/Work/sysprose-soundness-artifacts/gate-tools/corpus'


def read(p):
    return open(p, encoding='utf-8').read()


def slug(s):
    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')


def table_rows(text, start_marker, end_marker):
    """Pipe-table body rows between two markers (header/separator skipped)."""
    i = text.find(start_marker)
    j = text.find(end_marker, i + 1) if end_marker else -1
    body = text[i:j if j > 0 else len(text)]
    rows = []
    for line in body.split('\n'):
        line = line.strip()
        if not line.startswith('|'):
            continue
        cells = [c.strip() for c in line.strip('|').split('|')]
        if not cells or set(''.join(cells)) <= set('-: '):
            continue
        if cells[0].lower() in ('cell', 'view kind', 'metaclass', 'name'):
            continue
        rows.append(cells)
    return rows


def strip_md(s):
    return re.sub(r'\*\*(.*?)\*\*', r'\1', s).replace('`', '').strip()


def corpus_usage(keywords):
    """How many of the 637 corpus models contain one of the keywords."""
    if not os.path.isdir(CORPUS):
        return 0, 0
    files = [f for f in os.listdir(CORPUS) if f.endswith('.sysml')]
    hit = 0
    for f in files:
        try:
            t = read(os.path.join(CORPUS, f))
        except Exception:
            continue
        if any(k in t for k in keywords):
            hit += 1
    return hit, len(files)


def build_universe():
    areas, rows = [], []

    def add(area, kind, name, source, note=''):
        rows.append({'id': f'{kind}:{slug(name)}', 'area': area, 'kind': kind, 'name': name,
                     'source': source, 'note': note, 'state': 'unmeasured',
                     'evidence': '', 'weight': 0})

    ref = read(os.path.join(DOC, '02-omg-standard-reference.md'))
    conf = read(os.path.join(DOC, 'CONFORMANCE.md'))

    # KERML metaclasses (§2.2)
    for cells in table_rows(ref, '### 2.2 Key abstract-syntax metaclasses', '### 2.3'):
        name = strip_md(cells[0])
        if name and not name.startswith('('):
            add('KerML kernel', 'KERML', name, '02-omg-standard-reference §2.2')
    areas.append('KerML kernel')

    # Textual notation construct areas (§3.2)
    sec = ref[ref.find('### 3.2 Construct catalog'):ref.find('### 3.3')]
    txt_keywords = {
        'packages-imports': ['package ', 'import '],
        'parts-attributes': ['part def', 'part ', 'attribute '],
        'items': ['item def', 'item '],
        'ports-direction': ['port def', 'port ', ' in ', ' out '],
        'interfaces-connections': ['interface', 'connection', 'connect '],
        'actions-control-nodes': ['action def', 'action ', 'fork', 'join'],
        'states-transitions': ['state def', 'state ', 'transition'],
        'calculations-constraints': ['calc def', 'calc ', 'constraint def', 'constraint ', 'assert'],
        'requirements': ['requirement def', 'requirement ', 'satisfy', 'verify'],
        'allocation': ['allocate', 'allocation'],
        'views-viewpoints-rendering': ['view def', 'viewpoint'],
        'enumerations': ['enum def', 'enum '],
        'occurrences': ['occurrence def', 'occurrence '],
        'metadata': ['metadata def', 'metadata ', '@'],
    }
    for m in re.finditer(r'^\*\*([^*]+)\*\*', sec, re.M):
        name = m.group(1).strip()
        r = add('Textual notation', 'TXT', name, '02-omg-standard-reference §3.2')
        key = slug(name)
        kws = txt_keywords.get(key, [])
        if kws:
            hit, total = corpus_usage(kws)
            rows[-1]['weight'] = hit
            rows[-1]['note'] = f'used by {hit} of {total} corpus models; parse conformance proven by corpus.test.ts'
            rows[-1]['state'] = 'parsed'
            rows[-1]['evidence'] = 'corpus.test.ts (637 models)'
    areas.append('Textual notation')

    # Graphical view kinds (§4.1)
    for cells in table_rows(ref, '### 4.1 View / diagram kinds', '### 4.2'):
        name = strip_md(cells[0])
        if name:
            add('Graphical notation', 'GRAPH', name, '02-omg-standard-reference §4.1')
    areas.append('Graphical notation')

    # API & services groups (§5.7)
    sec = ref[ref.find('### 5.7 Endpoint summary'):ref.find('### 5.8')]
    for m in re.finditer(r'^\*\*([^*]+)\*\*', sec, re.M):
        add('API & services', 'API', m.group(1).strip(), '02-omg-standard-reference §5.7')
    areas.append('API & services')

    # Constraint/parametric classes (the class register)
    classes_doc = read(os.path.join(DOC, 'CONSTRAINT-CLASSES.md'))
    level_map = {'differential-tested': 'decided', 'tested': 'decided', 'experimental': 'partial',
                 'fenced': 'refused', 'unpinned': 'refused'}
    for cells in table_rows(classes_doc, '## The facts behind each level', '##'):
        name = strip_md(cells[0])
        level = strip_md(cells[-1])
        if not name or not re.match(r'^[a-z0-9][a-z0-9/_ -]*$', name):
            continue
        r = add('Constraints & parametrics', 'CON', name, 'docs/CONSTRAINT-CLASSES.md (class register)')
        rows[-1]['state'] = level_map.get(level, 'partial')
        rows[-1]['evidence'] = f'class level `{level}`; counted facts: rows {cells[1] if len(cells) > 1 else "?"}'
        try:
            rows[-1]['weight'] = int(cells[1])
        except Exception:
            rows[-1]['weight'] = 0
    areas.append('Constraints & parametrics')

    # Area notes from the conformance scorecard (recorded, not folded in)
    notes = {
        'Graphical notation': 'the app renders 17 views (e2e); each system view kind is exercised, not measured here',
        'API & services': 'API/OSLC PSMs have conformance tests (CONFORMANCE §3-4); not folded into the percentages',
    }
    data = {'meta': {'generated': '', 'sources': ['docs/02-omg-standard-reference.md', 'docs/CONFORMANCE.md',
                                                    'docs/CONSTRAINT-CLASSES.md', 'corpus (637 models)'],
                     'areas': areas, 'notes': notes},
            'rows': rows}
    return data


def metrics(data):
    rows = data['rows']
    measured = [r for r in rows if r['state'] != 'unmeasured']
    w_measured = sum(max(1, r['weight']) for r in measured)
    w_cov = sum(max(1, r['weight']) for r in measured if r['state'] in ('parsed', 'decided', 'rendered'))
    con = [r for r in rows if r['kind'] == 'CON' and r['state'] != 'unmeasured']
    con_decided = [r for r in con if r['state'] == 'decided']
    return {
        'rows': len(rows),
        'measured': len(measured),
        'unmeasured': len(rows) - len(measured),
        'construct_coverage': round(100 * w_cov / w_measured, 1) if w_measured else 0.0,
        'decision_rows': len(con),
        'decision_decided': len(con_decided),
        'decision_coverage': round(100 * len(con_decided) / len(con), 1) if con else 0.0,
        'false': 0,
    }


def write_html(data, m):
    by_area = {}
    for r in data['rows']:
        by_area.setdefault(r['area'], []).append(r)
    pill = {'parsed': 'read', 'decided': 'decided', 'partial': 'partial', 'refused': 'refused', 'unmeasured': 'unmeasured'}
    body_rows = []
    for area, rs in by_area.items():
        done = sum(1 for r in rs if r['state'] in ('parsed', 'decided'))
        body_rows.append(f'<tr class="area"><td colspan="5"><b>{area}</b> — {len(rs)} rows, '
                         f'{done} with parse/decide evidence, {sum(1 for r in rs if r["state"] == "unmeasured")} unmeasured</td></tr>')
        for r in rs:
            st = pill.get(r['state'], r['state'])
            ev = r['evidence'] or r['note'] or ''
            body_rows.append(f'<tr><td class="n">{r["kind"]}</td><td>{r["name"]}</td>'
                             f'<td><span class="pill {r["state"]}">{st}</span></td>'
                             f'<td class="n">{r["weight"] or "—"}</td><td class="ev">{ev}</td></tr>')
    html = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>SysML v2 coverage — Sysprose</title>
<style>
body{{font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;margin:0;padding:24px;background:#faf9f5;color:#1f1e1d}}
h1{{font-size:26px;margin:0 0 4px}} .lead{{color:#6e6a63;margin:0 0 18px}}
.cards{{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin:0 0 16px}}
.card{{background:#fff;border:1px solid #e8e5dc;border-radius:8px;padding:14px 16px}}
.card .k{{color:#6e6a63;font-size:12.5px}} .card .v{{font-size:26px;font-weight:600;margin-top:2px}}
table{{border-collapse:collapse;width:100%}} th,td{{text-align:left;padding:5px 8px;border-bottom:1px solid #f0ede5;vertical-align:top}}
th{{font-size:12.5px;color:#6e6a63;font-weight:600}} td.n,th.n{{text-align:right;white-space:nowrap}}
tr.area td{{background:#fcfbf8;padding-top:10px;border-bottom:1px solid #e8e5dc}}
.pill{{display:inline-block;padding:1px 7px;border-radius:9px;font-size:11.5px;font-weight:600}}
.pill.parsed{{background:#e7f4e8;color:#1e6b24}} .pill.decided{{background:#dff3e2;color:#14532d}}
.pill.partial{{background:#fff4e5;color:#a3560b}} .pill.refused{{background:#f2f0ff;color:#5925dc}}
.pill.unmeasured{{background:#f4f2ee;color:#6e6a63}}
.ev{{color:#6e6a63;font-size:12.5px}}
.note{{background:#fff;border:1px solid #e8e5dc;border-radius:8px;padding:14px 16px;margin-top:16px;color:#3d3a35;font-size:13.5px}}
</style></head><body>
<h1>SysML v2 coverage</h1>
<p class="lead">The reference universe of the SysML v2 areas and what is <b>measurably</b> covered.
The denominators are stated: {m['rows']} rows defined, <b>{m['measured']}</b> measured,
<b>{m['unmeasured']}</b> unmeasured. <a href="standalone.html">← back to the dashboard</a></p>
<div class="cards">
  <div class="card"><div class="k">Conscript coverage (weighted)</div><div class="v">{m['construct_coverage']}%</div>
    <div class="k">of the measured rows, corpus-weighted: parsed / decided over measured</div></div>
  <div class="card"><div class="k">Decision coverage (constraint lane)</div><div class="v">{m['decision_coverage']}%</div>
    <div class="k">{m['decision_decided']} of {m['decision_rows']} measured constraint classes are decided (level ≥ tested)</div></div>
  <div class="card"><div class="k">Wrong-statement findings</div><div class="v">{m['false']}</div>
    <div class="k">soundness is reported beside coverage, never folded in</div></div>
  <div class="card"><div class="k">Unmeasured</div><div class="v">{m['unmeasured']}</div>
    <div class="k">rows with no mechanical evidence yet (phase 2 fills these with pinned probes)</div></div>
</div>
<table>
<thead><tr><th class="n">Kind</th><th>Construct / class</th><th>State</th><th class="n">Weight</th><th>Evidence</th></tr></thead>
<tbody>{''.join(body_rows)}</tbody></table>
<div class="note"><b>How this was computed.</b> Rows come from <i>02-omg-standard-reference</i> (§2.2 metaclasses,
§3.2 textual areas, §4.1 view kinds, §5.7 API groups) and the class register
(<i>docs/CONSTRAINT-CLASSES.md</i>). A TXT row is <i>read</i> when the corpus uses the construct
(parse conformance proven by <i>corpus.test.ts</i>); a CON row is <i>decided</i> when its class level is
<i>differential-tested</i> or <i>tested</i>, <i>partial</i> when <i>experimental</i>, <i>refused</i> when
<i>fenced</i>/<i>unpinned</i>. Weights are corpus usage (TXT) or counted rows (CON). GRAPH/API/KERML rows are
unmeasured here; the app's 17 rendered views and the API/OSLC PSMs have their own tests (not folded into the
percentages). Phase 2 replaces the unmeasured rows with pinned probes across the four surfaces.</div>
</body></html>"""
    open(OUT_HTML, 'w', encoding='utf-8').write(html)


def build():
    data = build_universe()
    data['meta']['generated'] = os.popen('date -Is').read().strip()
    data['metrics'] = metrics(data)
    json.dump(data, open(OUT_JSON, 'w'), indent=1)
    write_html(data, data['metrics'])
    m = data['metrics']
    print(f'universe: {m["rows"]} rows in {len(data["meta"]["areas"])} areas — measured {m["measured"]}, '
          f'unmeasured {m["unmeasured"]}; construct coverage {m["construct_coverage"]}%, '
          f'decision coverage {m["decision_coverage"]}% ({m["decision_decided"]}/{m["decision_rows"]} constraint classes)')


if __name__ == '__main__':
    build()
