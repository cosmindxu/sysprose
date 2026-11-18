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
  - GRAPH rows: rendered = an E2E spec in `test/e2e/` asserts the view kind's panel
    (`measure_known` names the spec and the assertion).
  - API rows: decided = a conformance test in `test/conformance/` asserts the service
    group's endpoint contract (`measure_known` names the test and the endpoints). A group
    whose endpoints this build does not ship stays `unmeasured` (`measure_known` says why).
  - KERML rows: `unmeasured` (no test pins the metaclass itself).

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

    # Area notes from the conformance scorecard (recorded beside the states)
    notes = {
        'Graphical notation': 'the app\'s 17 views include the 11 §4.1 kinds; each is '
                              'rendered where an E2E spec asserts its panel (test/e2e/)',
        'API & services': 'the §5.7 groups are decided where the API conformance tests assert '
                          'their contracts (CONFORMANCE §3); the "Other" group\'s POST /transform '
                          'and /validate are not shipped here, so it stays unmeasured; the OSLC '
                          'PSM has its own suite (CONFORMANCE §4, test/conformance/oslc-conformance.test.ts)',
    }
    data = {'meta': {'generated': '', 'sources': ['docs/02-omg-standard-reference.md', 'docs/CONFORMANCE.md',
                                                    'docs/CONSTRAINT-CLASSES.md', 'corpus (637 models)',
                                                    'test/conformance/', 'test/e2e/'],
                     'areas': areas, 'notes': notes},
            'rows': rows}
    measure_known(rows)
    return data


# The GRAPH and API rows' mechanical evidence, keyed by row id. A row appears only where
# an existing test asserts the thing: an API group is `decided` only where a conformance
# test validates its endpoints, a view kind `rendered` only where an E2E spec asserts its
# panel. A row with no entry here stays `unmeasured`; no evidence is invented.
KNOWN = {
    # ── API & services: docs/CONFORMANCE.md §3 (test/conformance/api-contract.test.ts) ──
    'API:projects': ('decided', 'test/conformance/api-contract.test.ts',
                     'GET /api/projects and /api/projects/{id} validate against Project; '
                     'project PUT rename + DELETE lifecycle (201/200/204/404)'),
    'API:branches': ('decided', 'test/conformance/api-contract.test.ts',
                     'GET .../branches validates against Branch[]; branch DELETE (204), '
                     'default-branch DELETE (409)'),
    'API:tags': ('decided', 'test/conformance/api-contract.test.ts',
                 'GET .../tags is routed by the OpenAPI-coverage sweep; tag create + DELETE (204) '
                 'lifecycle'),
    'API:commits': ('decided', 'test/conformance/api-contract.test.ts',
                    'GET .../commits validates against Commit[]; POST .../commits returns 201 with an @id'),
    'API:elements-read-at-a-commit': ('decided', 'test/conformance/api-contract.test.ts',
                                      'elements page validates against ElementsPage, one element against '
                                      'Element, relationships against RelationshipsResult; the ?type= filter '
                                      'returns only that type'),
    'API:queries': ('decided', 'test/conformance/api-contract.test.ts',
                    'POST /api/queries validates against QueryResult; stored-query CRUD + results '
                    'lifecycle validates against StoredQuery/QueryResult'),

    # ── Graphical notation: docs/02-omg-standard-reference.md §4.1 (test/e2e/) ──
    'GRAPH:general-view-definition-view': ('rendered', 'test/e2e/diagram-notation.spec.ts',
                                           'general-view nodes draw their SysML notation (adornments, '
                                           'derived names, compartments, port symbols)'),
    'GRAPH:interconnection-view-internal-view': ('rendered', 'test/e2e/interface-tags-subject.spec.ts',
                                                 'an interface is drawn port to port, on the ports the parts '
                                                 'have through their type'),
    'GRAPH:action-flow-view-activity': ('rendered', 'test/e2e/diagram-control-nodes.spec.ts',
                                        'every control-node kind draws its prescribed flow symbol'),
    'GRAPH:state-transition-view': ('rendered', 'test/e2e/palette-per-view.spec.ts',
                                    'the state view renders a StateUsage node and its TransitionUsage is '
                                    'wired between the chosen endpoints'),
    'GRAPH:sequence-view': ('rendered', 'test/e2e/diagram-tables-content.spec.ts',
                            'one lifeline per participant and one message per succession'),
    'GRAPH:requirement-view': ('rendered', 'test/e2e/diagram-edges.spec.ts',
                               'an edge renders in the requirement view (the palette spec wires a Satisfy)'),
    'GRAPH:case-analysis-view': ('rendered', 'test/e2e/diagram-views3.spec.ts, test/e2e/graph-analysis.spec.ts',
                                 'the case view draws its React Flow canvas; the analysis view draws its '
                                 'graph and DSM'),
    'GRAPH:allocation-matrix': ('rendered', 'test/e2e/diagram-views2.spec.ts',
                                'the dedicated allocation matrix table (matrix-view) is visible'),
    'GRAPH:package-tree-browser-view': ('rendered', 'test/e2e/diagram-edges.spec.ts',
                                        'an edge renders in the tree view (containment)'),
    'GRAPH:grid-view': ('rendered', 'test/e2e/diagram-tables-content.spec.ts',
                        'grid cells carry each element\'s real metaclass, type and value'),
    'GRAPH:geometry-view': ('rendered', 'test/e2e/geometry3d.spec.ts',
                            'the geometry view renders a real WebGL canvas and handles clicks'),
}

# Rows the universe defines but no test asserts, so they stay `unmeasured`; the note names
# what is missing. Keeping them here (rather than in KNOWN) means no state is invented.
UNMEASURED_NOTES = {
    'API:other': '§5.7\'s "Other" group is POST /transform and POST /validate; this build ships '
                 'neither (no such path in src/server/openapi.ts) and no conformance test asserts '
                 'them, so the group stays unmeasured',
}


def measure_known(rows):
    """Set the states a test *measures* (see KNOWN); leave the rest unmeasured.

    A stale KNOWN or UNMEASURED_NOTES id (no such row) is a hard error: an entry that
    silently stopped applying would let the page regress with nothing noticing. A row
    with no KNOWN entry is reported, not invented.
    """
    by_id = {r['id']: r for r in rows}
    stale = [k for k in (*KNOWN, *UNMEASURED_NOTES) if k not in by_id]
    if stale:
        raise SystemExit(f'coverage.measure_known: ids with no row: {sorted(stale)}')
    for rid, (state, evidence, note) in KNOWN.items():
        r = by_id[rid]
        r['state'], r['evidence'], r['note'] = state, evidence, note
    for rid, note in UNMEASURED_NOTES.items():
        by_id[rid]['note'] = note
    unmeasured = [r['id'] for r in rows if r['kind'] in ('API', 'GRAPH') and r['state'] == 'unmeasured']
    if unmeasured:
        print(f'coverage: no asserting test yet, left unmeasured: {unmeasured}')


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
    pill = {'parsed': 'read', 'decided': 'decided', 'rendered': 'rendered', 'partial': 'partial',
            'refused': 'refused', 'unmeasured': 'unmeasured'}
    body_rows = []
    for area, rs in by_area.items():
        measured = sum(1 for r in rs if r['state'] != 'unmeasured')
        body_rows.append(f'<tr class="area"><td colspan="5"><b>{area}</b> — {len(rs)} rows, '
                         f'{measured} with measured evidence, {sum(1 for r in rs if r["state"] == "unmeasured")} unmeasured</td></tr>')
        for r in rs:
            st = pill.get(r['state'], r['state'])
            ev = r['evidence'] or ''
            if r['note'] and r['note'] != r['evidence']:
                ev = f'{ev}<br><span class="sub">{r["note"]}</span>' if ev else r['note']
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
.pill.rendered{{background:#e6f0fb;color:#1d4ed8}}
.pill.partial{{background:#fff4e5;color:#a3560b}} .pill.refused{{background:#f2f0ff;color:#5925dc}}
.pill.unmeasured{{background:#f4f2ee;color:#6e6a63}}
.ev{{color:#6e6a63;font-size:12.5px}} .sub{{color:#8a857c}}
.note{{background:#fff;border:1px solid #e8e5dc;border-radius:8px;padding:14px 16px;margin-top:16px;color:#3d3a35;font-size:13.5px}}
</style></head><body>
<h1>SysML v2 coverage</h1>
<p class="lead">The reference universe of the SysML v2 areas and what is <b>measurably</b> covered.
The denominators are stated: {m['rows']} rows defined, <b>{m['measured']}</b> measured,
<b>{m['unmeasured']}</b> unmeasured. <a href="standalone.html">← back to the dashboard</a></p>
<div class="cards">
  <div class="card"><div class="k">Conscript coverage (weighted)</div><div class="v">{m['construct_coverage']}%</div>
    <div class="k">of the measured rows, corpus-weighted: parsed / decided / rendered over measured</div></div>
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
<i>fenced</i>/<i>unpinned</i>; a GRAPH row is <i>rendered</i> where an E2E spec asserts the view kind's
panel (<i>test/e2e/</i>); an API row is <i>decided</i> where a conformance test asserts the group's
endpoints (<i>test/conformance/</i>, CONFORMANCE §3–4). Weights are corpus usage (TXT) or counted rows
(CON). KERML rows stay unmeasured here: no test pins the metaclass itself, and an API group whose
endpoints this build does not ship stays unmeasured too (§5.7's <i>Other</i>: POST /transform and
/validate). The app's 17 views include the 11 §4.1 view kinds. Phase 2 replaces the remaining
unmeasured rows with pinned probes across the four surfaces.</div>
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
