#!/usr/bin/env python3
"""Coverage — the reference universe of SysML v2 language areas, and how much of it
the tool measurably covers.

Phase 1 (this script) builds the **universe definition** and reports what is measured:

  coverage-universe.json  — rows from the normative clause inventory:
        KERML  the key abstract-syntax metaclasses (KerML 8.3)
        TXT    the textual-notation construct clauses (SysML v2 Part 1 §7)
        GRAPH  the standard view definitions and their graphical clauses (§8.2.3, §9.2.20)
        API    the REST service groups and their clauses (API and Services §7.2, §8.1.3)
        CON    the constraint/parametric classes (docs/CONSTRAINT-CLASSES.md)
  coverage.html           — the matrix page, two weighted headers and the denominators.

The clause inventory lives in `coverage-universe-source.json` (the adopted
2026 SysML v2 / KerML / API documents). Its `rows` are the matrix rows — the ids
the dashboard has always used, kept as the stable aliases so re-keying the
universe does not move the matrix — and its `clauses` name the normative clause
behind each row: a stable id, the clause number and the construct text. A row
with no normative clause is listed under `unclaused` with the reason; no clause
is invented. This replaced the earlier scraping of the illustrative tables in
`docs/02-omg-standard-reference.md` (§2.2 yielded 22 of the 26 metaclass rows).

States are only set where a document *measures* it:
  - CON rows: the class register's level (differential-tested / tested / experimental /
    fenced / unpinned) -> decided / partial / refused.
  - TXT rows: read / partial from a pinned probe under `scripts/todo-dashboard/probes/`,
    run on the four decision surfaces (`checkConstraints`, `checkConstraintsNumeric`,
    `verifyModel --engine literal` and `--engine smt`; `probes/run.ts` is the reporter).
    `read` = the construct reaches a row a surface decides and the evidence quotes the row
    and its sentence; `partial` = only some shapes reach a row, or the construct parses
    and is rendered/traced but no decision row reads it. The corpus weight is still the
    usage count, and corpus.test.ts still proves parse conformance; that is no longer the
    read claim (`measure_txt` holds every TXT row to a probe, and each probe to a file).
  - GRAPH rows: rendered = an E2E spec in `test/e2e/` asserts the view kind's panel
    (`measure_known` names the spec and the assertion).
  - API rows: decided = a conformance test in `test/conformance/` asserts the service
    group's endpoint contract (`measure_known` names the test and the endpoints). A group
    whose endpoints this build does not ship stays `unmeasured` (`measure_known` says why).
  - KERML rows: `unmeasured` (no test pins the metaclass itself).

The two headers:
  construct coverage = corpus-weighted share of rows whose state is read/parsed/decided/rendered
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
SOURCE = os.path.join(HERE, 'coverage-universe-source.json')
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


def load_source():
    """Read and validate the normative clause inventory.

    `rows` are the matrix rows, keyed by the id the dashboard has always used
    (the stable alias). `clauses` attach normative clause ids to those rows.
    Every row needs at least one clause or an `unclaused` note; every referenced
    row must exist. A stale or duplicated entry is a hard error, so the universe
    cannot silently lose a clause or acquire an invented one.
    """
    src = json.load(open(SOURCE, encoding='utf-8'))
    by_id, order = {}, []
    for r in src.get('rows', []):
        if r['id'] in by_id:
            raise SystemExit(f'coverage.load_source: duplicate row id {r["id"]}')
        by_id[r['id']] = r
        order.append(r['id'])
    clauses_by_row, seen = {}, set()
    for c in src.get('clauses', []):
        if c['row'] not in by_id:
            raise SystemExit(f'coverage.load_source: clause {c["id"]} names no row: {c["row"]}')
        if c['id'] in seen:
            raise SystemExit(f'coverage.load_source: duplicate clause id {c["id"]}')
        seen.add(c['id'])
        clauses_by_row.setdefault(c['row'], []).append(c)
    unclaused = {}
    for u in src.get('unclaused', []):
        if u['row'] not in by_id:
            raise SystemExit(f'coverage.load_source: unclaused entry names no row: {u["row"]}')
        unclaused[u['row']] = u['note']
    return src, by_id, order, clauses_by_row, unclaused


def append_note(row, extra):
    """Keep a source note (an `unclaused` reason) beside the mechanical one."""
    base = row['note'].rstrip(' ;.')
    row['note'] = f'{base}; {extra}' if base else extra


def build_universe():
    src, by_id, order, clauses_by_row, unclaused = load_source()
    rows = []

    def add(row_id, area, kind, name, source, note=''):
        rows.append({'id': row_id, 'area': area, 'kind': kind, 'name': name,
                     'source': source, 'note': note, 'state': 'unmeasured',
                     'evidence': '', 'weight': 0, 'clause_ids': [], 'clauses': []})

    for row_id in order:
        spec = by_id[row_id]
        clauses = clauses_by_row.get(row_id, [])
        if not clauses and row_id not in unclaused:
            raise SystemExit(f'coverage: row {row_id} has no clause and no unclaused note')
        add(row_id, spec['area'], spec['kind'], spec['name'],
            '; '.join(c['clause'] for c in clauses), unclaused.get(row_id, ''))
        rows[-1]['clause_ids'] = [c['id'] for c in clauses]
        rows[-1]['clauses'] = [{'id': c['id'], 'clause': c['clause'], 'construct': c['construct']}
                               for c in clauses]
        if spec['kind'] == 'TXT':
            hit, total = corpus_usage(spec.get('keywords', []))
            rows[-1]['weight'] = hit
            append_note(rows[-1], f'used by {hit} of {total} corpus models; '
                                   f'parse conformance proven by corpus.test.ts')

    areas = list(src.get('areas', []))
    for area in areas:
        if area == 'Constraints & parametrics':
            continue
        if not any(r['area'] == area and r['clause_ids'] for r in rows):
            raise SystemExit(f'coverage: area {area!r} has no clause-numbered row')

    # Constraint/parametric classes (the class register — not a clause list)
    classes_doc = read(os.path.join(DOC, 'CONSTRAINT-CLASSES.md'))
    level_map = {'differential-tested': 'decided', 'tested': 'decided', 'experimental': 'partial',
                 'fenced': 'refused', 'unpinned': 'refused'}
    for cells in table_rows(classes_doc, '## The facts behind each level', '##'):
        name = strip_md(cells[0])
        level = strip_md(cells[-1])
        if not name or not re.match(r'^[a-z0-9][a-z0-9/_ -]*$', name):
            continue
        add(f'CON:{slug(name)}', 'Constraints & parametrics', 'CON', name,
            'docs/CONSTRAINT-CLASSES.md (class register)')
        rows[-1]['state'] = level_map.get(level, 'partial')
        rows[-1]['evidence'] = f'class level `{level}`; counted facts: rows {cells[1] if len(cells) > 1 else "?"}'
        try:
            rows[-1]['weight'] = int(cells[1])
        except Exception:
            rows[-1]['weight'] = 0
    if 'Constraints & parametrics' not in areas:
        areas.append('Constraints & parametrics')

    # Area notes from the conformance scorecard (recorded beside the states)
    notes = {
        'KerML kernel': 'the 26 metaclass rows are the KerML 8.3 abstract-syntax metaclasses this tool '
                        'stands on; where SysML v2 Part 1 §7 defines the same construct, its textual clause '
                        'is attached beside the KerML clause (and one row, ItemFlow, cites KerML Flow, not a '
                        'SysML abstract-syntax clause). The four annotation primitives the earlier 02 §2.2 '
                        'extraction dropped are rows here (8.3.2.3.3–8.3.2.3.6). No test pins a metaclass '
                        'itself, so the rows stay unmeasured (CU-4 is their probe)',
        'Textual notation': 'each TXT row is read or partial from a pinned probe under '
                            'scripts/todo-dashboard/probes/ (reported by probes/run.ts over the four '
                            'decision surfaces); a construct that files no row, or only a structural read, '
                            'says so and is partial, never read',
        'Graphical notation': 'the 11 view rows are the app\'s views; each is rendered where an E2E '
                              'spec asserts its panel (test/e2e/), and its clause is the SysML v2 Part 1 '
                              'Standard View Definition (9.2.20) and graphical clause (8.2.3) it renders',
        'API & services': 'the service groups are decided where the API conformance tests assert '
                          'their contracts (CONFORMANCE §3); the "Other" group\'s POST /transform '
                          'and /validate are not shipped here and have no clause in the API and Services '
                          'specification, so it stays unmeasured; the OSLC PSM has its own suite '
                          '(CONFORMANCE §4, test/conformance/oslc-conformance.test.ts)',
    }
    data = {'meta': {'generated': '', 'sources': ['scripts/todo-dashboard/coverage-universe-source.json',
                                                    'docs/CONSTRAINT-CLASSES.md', 'corpus (637 models)',
                                                    'test/conformance/', 'test/e2e/', 'scripts/todo-dashboard/probes/'],
                     'standards': src.get('standards', []),
                     'areas': areas, 'notes': notes},
            'rows': rows}
    measure_txt(rows)
    measure_known(rows)
    return data


# The TXT rows' probe evidence, keyed by row id. Each entry names the pinned
# model under `scripts/todo-dashboard/probes/` and the row(s) the four surfaces
# (`probes/run.ts`) read over it. `read` is only for a construct that reaches a
# row a surface decides; a construct that files no row, or whose only reads are
# structural (a direction, a connector, an annotation, a transition graph), is
# `partial` and the sentence says what is missing. The path is checked to exist,
# so a renamed probe fails the build rather than leaving stale evidence. Eight of
# these probes reconstruct shapes recorded when CU-2 was drafted (the header of
# each says so; the two that needed a read added say so); the other six are
# constructed here. A `partial` whose sentence begins "the construct itself reaches
# no row" means the surfaces read nothing of the construct, not that some shapes are decided.
TXT_PROBES = {
    'TXT:packages-imports': ('read', 'scripts/todo-dashboard/probes/packages-imports.sysml',
                             '`Use::SizeLimit::«ConstraintUsage»` reads `a.w.size <= a.limit`, '
                             'satisfied on the check, numeric, literal and SMT surfaces; `Widget` resolves '
                             'only through `import Base::*`, so the import is on the read path'),
    'TXT:parts-attributes': ('read', 'scripts/todo-dashboard/probes/parts-attributes.sysml',
                             '`ProbePartsAttributes::MassCeiling::«ConstraintUsage»` reads '
                             '`v.mass <= 2000.0` through a part-typed usage, satisfied on all four surfaces'),
    'TXT:items': ('read', 'scripts/todo-dashboard/probes/items.sysml',
                  '`ProbeItems::FuelCeiling::«ConstraintUsage»` reads `v.fuel.mass <= 5.0` over an item '
                  'usage, satisfied on all four surfaces'),
    'TXT:ports-direction': ('partial', 'scripts/todo-dashboard/probes/ports-direction.sysml',
                            'a port usage is a feature, and `ProbePorts::FlowCeiling::«ConstraintUsage»` '
                            'reads its member value (`e.fuelOut.flowRate <= 15.0`, satisfied on all four '
                            'surfaces), but the `out` direction is structural and no surface reads it'),
    'TXT:interfaces-connections': ('partial', 'scripts/todo-dashboard/probes/interfaces-connections.sysml',
                                   'the source port\'s member value reaches a row (`a.source.tx.rate <= '
                                   '10.0`, satisfied on all four surfaces); the `connection` itself files no '
                                   'row — a bare connect is an equality only under '
                                   '`--connections-as-equalities`'),
    'TXT:actions-control-nodes': ('partial', 'scripts/todo-dashboard/probes/actions-control-nodes.sysml',
                                  "the action definition's attribute reaches a row (`x.rate <= x.limit`, "
                                  'satisfied on all four surfaces); `first`/`then` control nodes file no row '
                                  '— the model-checking lane owns them'),
    'TXT:states-transitions': ('partial', 'scripts/todo-dashboard/probes/states-transitions.sysml',
                               "a state definition's attribute reaches a row (`v.modes.load <= v.limit`, "
                               'satisfied on all four surfaces); the transition graph files no row — the '
                               'model-checking lane owns it'),
    'TXT:calculations-constraints': ('partial', 'scripts/todo-dashboard/probes/calculations-constraints.sysml',
                                     'the asserted constraint usage is read over its parameter bound to the '
                                     'design: the check reads `vehicle.mass <= 2000` and reports `Constraint '
                                     'satisfied (MassOk : MassCeiling, with v = vehicle)`, and the numeric '
                                     'surface agrees; the literal and SMT surfaces file no obligation for it, '
                                     'and no `calc` definition or usage is probed'),
    'TXT:requirements': ('read', 'scripts/todo-dashboard/probes/requirements.sysml',
                         '`ProbeRequirements::massCeiling::«ConstraintUsage»` reads `v.mass <= 2000.0` '
                         'through the requirement subject, satisfied on all four surfaces'),
    'TXT:allocation': ('partial', 'scripts/todo-dashboard/probes/allocation.sysml',
                       'the construct itself reaches no row: `allocate Supply::volts to Load::volts` files no '
                       "row on any surface; the neighbouring `LoadVolts` is decided at the load's own value "
                       '(`l.volts >= 20.0`, `3 vs 20`)'),
    'TXT:views-viewpoints-rendering': ('partial', 'scripts/todo-dashboard/probes/views.sysml',
                                       'the construct itself reaches no row: `view` and `viewpoint` parse '
                                       '(9 elements) and file no decision row on any surface; the GRAPH rows '
                                       'carry the rendering evidence'),
    'TXT:enumerations': ('partial', 'scripts/todo-dashboard/probes/enumerations.sysml',
                         'the construct itself reaches no row, every surface refuses it: `Mode::on` — the check reports "Could not evaluate: the body names '
                         '`Mode::on`, which this lane reads only where the feature states an `=` literal", '
                         'and the literal and SMT engines abstain with the unresolved-name sentence'),
    'TXT:occurrences': ('partial', 'scripts/todo-dashboard/probes/occurrences.sysml',
                        '`Occurrences::DurationLimit::«ConstraintUsage»` reads `t.duration <= t.limit` '
                        'over an occurrence usage, satisfied on all four surfaces; an attribute read only — '
                        'lifetime, time slices and snapshots are not read'),
    'TXT:metadata': ('partial', 'scripts/todo-dashboard/probes/metadata.sysml',
                     'the construct itself reaches no row: the part\'s own `s.mass <= s.limit` is read, but the '
                     '`@Safety` metadata usage is an annotation no decision surface reads'),
}


def measure_txt(rows):
    """Apply the TXT probes; every TXT row must carry one, and every probe must exist.

    This is the read claim's mechanical half: a missing probe, a stale row id or a
    probe file that was renamed is a hard error, and a TXT row with no entry can never
    keep the old parse-only `parsed` state by default. The corpus `note` (usage count
    and corpus.test.ts parse evidence) is kept beside the probe sentence.
    """
    by_id = {r['id']: r for r in rows}
    txt = [r['id'] for r in rows if r['kind'] == 'TXT']
    stale = [k for k in TXT_PROBES if k not in by_id]
    if stale:
        raise SystemExit(f'coverage.measure_txt: ids with no row: {sorted(stale)}')
    missing = [rid for rid in txt if rid not in TXT_PROBES]
    if missing:
        raise SystemExit(f'coverage.measure_txt: TXT rows with no probe: {sorted(missing)}')
    for rid, (state, probe, sentence) in TXT_PROBES.items():
        if not os.path.exists(os.path.join(REPO, probe)):
            raise SystemExit(f'coverage.measure_txt: probe file missing: {probe}')
        r = by_id[rid]
        r['state'] = state
        r['evidence'] = f'{state} (probe {probe}): {sentence}'


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

    # ── Graphical notation: SysML v2 Part 1 §9.2.20/§8.2.3 standard views (test/e2e/) ──
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
    'API:other': 'this build ships neither endpoint (no such path in src/server/openapi.ts) and no '
                 'conformance test asserts them, so the group stays unmeasured',
    'API:external-relationships': 'the ExternalRelationshipService endpoints are not shipped in '
                                  'src/server/openapi.ts and no conformance test asserts them, so the '
                                  'service stays unmeasured',
    'API:project-usage': 'the ProjectUsageService endpoints are not shipped in src/server/openapi.ts '
                         'and no conformance test asserts them, so the service stays unmeasured',
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
        append_note(by_id[rid], note)
    unmeasured = [r['id'] for r in rows if r['kind'] in ('API', 'GRAPH') and r['state'] == 'unmeasured']
    if unmeasured:
        print(f'coverage: no asserting test yet, left unmeasured: {unmeasured}')


def metrics(data):
    rows = data['rows']
    measured = [r for r in rows if r['state'] != 'unmeasured']
    w_measured = sum(max(1, r['weight']) for r in measured)
    w_cov = sum(max(1, r['weight']) for r in measured if r['state'] in ('read', 'parsed', 'decided', 'rendered'))
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
    pill = {'read': 'read', 'parsed': 'parsed', 'decided': 'decided', 'rendered': 'rendered', 'partial': 'partial',
            'refused': 'refused', 'unmeasured': 'unmeasured'}
    body_rows = []
    for area, rs in by_area.items():
        measured = sum(1 for r in rs if r['state'] != 'unmeasured')
        body_rows.append(f'<tr class="area"><td colspan="6"><b>{area}</b> — {len(rs)} rows, '
                         f'{measured} with measured evidence, {sum(1 for r in rs if r["state"] == "unmeasured")} unmeasured</td></tr>')
        for r in rs:
            st = pill.get(r['state'], r['state'])
            ev = r['evidence'] or ''
            if r['note'] and r['note'] != r['evidence']:
                ev = f'{ev}<br><span class="sub">{r["note"]}</span>' if ev else r['note']
            if r['clauses']:
                cl = '<br>'.join(f'<span class="cid">{c["id"]}</span> '
                                 f'<span class="cno">{c["clause"]}</span>' for c in r['clauses'])
            elif r['kind'] == 'CON':
                cl = '<span class="cno">class register</span>'
            else:
                cl = '<span class="cno">no normative clause</span>'
            body_rows.append(f'<tr><td class="n">{r["kind"]}</td><td>{r["name"]}</td><td class="cl">{cl}</td>'
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
.pill.read{{background:#e7f4e8;color:#1e6b24}} .pill.parsed{{background:#eef6ee;color:#3d6b41}} .pill.decided{{background:#dff3e2;color:#14532d}}
.pill.rendered{{background:#e6f0fb;color:#1d4ed8}}
.pill.partial{{background:#fff4e5;color:#a3560b}} .pill.refused{{background:#f2f0ff;color:#5925dc}}
.pill.unmeasured{{background:#f4f2ee;color:#6e6a63}}
.ev{{color:#6e6a63;font-size:12.5px}} .sub{{color:#8a857c}}
.cid{{font-weight:600;color:#3d3a35}} .cno{{color:#6e6a63;font-size:12.5px}}
.note{{background:#fff;border:1px solid #e8e5dc;border-radius:8px;padding:14px 16px;margin-top:16px;color:#3d3a35;font-size:13.5px}}
</style></head><body>
<h1>SysML v2 coverage</h1>
<p class="lead">The reference universe of the SysML v2 areas and what is <b>measurably</b> covered.
The denominators are stated: {m['rows']} rows defined, <b>{m['measured']}</b> measured,
<b>{m['unmeasured']}</b> unmeasured. <a href="standalone.html">← back to the dashboard</a></p>
<div class="cards">
  <div class="card"><div class="k">Construct coverage (weighted)</div><div class="v">{m['construct_coverage']}%</div>
    <div class="k">of the measured rows, corpus-weighted: read / parsed / decided / rendered over measured</div></div>
  <div class="card"><div class="k">Decision coverage (constraint lane)</div><div class="v">{m['decision_coverage']}%</div>
    <div class="k">{m['decision_decided']} of {m['decision_rows']} measured constraint classes are decided (level ≥ tested)</div></div>
  <div class="card"><div class="k">Wrong-statement findings</div><div class="v">{m['false']}</div>
    <div class="k">soundness is reported beside coverage, never folded in</div></div>
  <div class="card"><div class="k">Unmeasured</div><div class="v">{m['unmeasured']}</div>
    <div class="k">rows with no mechanical evidence yet (pinned probes fill them as they land)</div></div>
</div>
<table>
<thead><tr><th class="n">Kind</th><th>Construct / class</th><th>Clause</th><th>State</th><th class="n">Weight</th><th>Evidence</th></tr></thead>
<tbody>{''.join(body_rows)}</tbody></table>
<div class="note"><b>How this was computed.</b> Rows come from
<i>scripts/todo-dashboard/coverage-universe-source.json</i>, the normative clause inventory: KerML 8.3
metaclasses, SysML v2 Part 1 §7 textual construct clauses, §8.2.3 / §9.2.20 standard view definitions,
and the Systems Modeling API and Services §7.2 / §8.1.3 service clauses; the class register
(<i>docs/CONSTRAINT-CLASSES.md</i>) supplies the CON rows. Each clause-bearing row cites its clause id and
number in the <i>Clause</i> column; the CON rows name the class register, and an unclaused row says so. The
row ids are the aliases the matrix has always used, so re-keying the universe to the clauses did not move a
row's state. A row with no clause in the adopted documents (the <i>Other</i>
API group's POST /transform and /validate; no rendering clause for the Grid and Geometry views) says so
and is never given an invented clause. A TXT row is <i>read</i> where a pinned probe
(<i>scripts/todo-dashboard/probes/</i>, run by <i>probes/run.ts</i> over the four decision surfaces) reaches a
row and quotes its sentence — the corpus usage count and <i>corpus.test.ts</i>'s parse evidence are kept beside
it, not substituted for it; a construct that files no row or only a structural read is <i>partial</i>, and a <i>partial</i> row is measured but is not in the construct-coverage numerator, so a row that was only parsed before drops out of it. A CON
row is <i>decided</i> when its class level is
<i>differential-tested</i> or <i>tested</i>, <i>partial</i> when <i>experimental</i>, <i>refused</i> when
<i>fenced</i>/<i>unpinned</i>; a GRAPH row is <i>rendered</i> where an E2E spec asserts the view kind's
panel (<i>test/e2e/</i>); an API row is <i>decided</i> where a conformance test asserts the group's
endpoints (<i>test/conformance/</i>, CONFORMANCE §3–4). Weights are corpus usage (TXT) or counted rows
(CON). KERML rows stay unmeasured here: no test pins the metaclass itself, and an API group whose
endpoints this build does not ship stays unmeasured too (the <i>Other</i> group: POST /transform and
/validate). The app's 17 views include the 11 standard view rows here; the four annotation primitives the
earlier 02 §2.2 extraction dropped now have rows of their own. Pinned probes fill the remaining unmeasured
rows as they land.</div>
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
