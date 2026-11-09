#!/usr/bin/env python3
"""Per-entry life of Sysprose's TODO.md along main's first-parent history.

Writes entries.json: one record per entry id {id, first_sha, first_when, closed_sha, closed_when, reopened,
titles[], first_title, last_title, first_body, last_body, tag, optional}, and counts.json: per commit open /
new / closed / rewritten / reopened with entry ids. An entry survives a rewrite (narrowing, residual
replacement) under a new title: the pairing is by title similarity (+ the same origin tag).
"""
import json, os, re, subprocess, difflib

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))  # the checkout this folder lives in


def sh(*a):
    return subprocess.run(a, cwd=REPO, capture_output=True, text=True, check=True).stdout


def norm(s):
    s = re.sub(r'`', '', s)
    s = re.sub(r'\s+', ' ', s).strip()
    return s.rstrip('.').strip()


def parse(text):
    out = {}
    lines = text.split('\n')
    sec = ''
    i = 0
    while i < len(lines):
        if lines[i].startswith('## '):
            sec = lines[i][3:].strip()
        m = re.match(r'^- \[( |x|X)\] \*\*(.*)$', lines[i])
        if m:
            checked = m.group(1) != ' '
            rest = m.group(2)
            j = i
            while '**' not in rest and j + 1 < len(lines) and not lines[j + 1].startswith('- ['):
                j += 1
                rest += ' ' + lines[j].strip()
            title = norm(rest.split('**', 1)[0])
            k = i + 1
            body = [lines[i]]
            while k < len(lines) and not lines[k].startswith('- [') and not lines[k].startswith('## '):
                body.append(lines[k]); k += 1
            btxt = re.sub(r'\s+', ' ', ' '.join(body)).strip()
            tags = re.findall(r'\[([^\]\[]{3,70})\]\s*$', btxt)
            if not checked:
                out[title] = dict(body=btxt, tag=tags[-1] if tags else '', section=sec)
            i = k
        else:
            i += 1
    return out


commits = [l.split('\t') for l in sh('git', 'log', '--first-parent', 'main', '--reverse', '--format=%H\t%h\t%aI\t%s', '--', 'TODO.md').strip().split('\n')]
entries = {}      # id -> record
by_title = {}     # current title -> id (open entries)
ever = {}         # any title ever seen -> id
counts = []
nid = 0
prev = {}
for idx, (H, h, when, subj) in enumerate(commits):
    cur = parse(sh('git', 'show', f'{H}:TODO.md'))
    appeared = [t for t in cur if t not in prev]
    gone = [t for t in prev if t not in cur]
    reopened = [t for t in appeared if t in ever]
    appeared = [t for t in appeared if t not in ever]
    rewrites = []
    left = list(appeared)
    for g in list(gone):
        best, bs = None, 0.0
        for a in left:
            s = difflib.SequenceMatcher(None, g.lower(), a.lower()).ratio()
            if prev[g]['tag'] and prev[g]['tag'] == cur[a]['tag']:
                s += 0.15
            if s > bs:
                best, bs = a, s
        if best is not None and bs >= 0.62:
            rewrites.append((g, best)); left.remove(best); gone.remove(g)
    ev = dict(new=[], closed=[], rewritten=[], reopened=[])
    for g, a in rewrites:
        eid = by_title.pop(g)
        by_title[a] = eid
        ever[a] = eid
        entries[eid]['titles'].append(a)
        entries[eid]['last_body'] = cur[a]['body']
        ev['rewritten'].append(eid)
    for t in left:
        nid += 1
        eid = nid
        entries[eid] = dict(id=eid, first_sha=h, first_when=when, first_idx=idx, closed_sha=None, closed_when=None, closed_idx=None,
                            reopened=0, titles=[t], first_title=t, first_body=cur[t]['body'], last_body=cur[t]['body'],
                            tag=cur[t]['tag'], section=cur[t]['section'], optional=('optional' in t.lower()))
        by_title[t] = eid; ever[t] = eid
        ev['new'].append(eid)
    for t in gone:
        eid = by_title.pop(t)
        entries[eid]['closed_sha'] = h; entries[eid]['closed_when'] = when; entries[eid]['closed_idx'] = idx
        ev['closed'].append(eid)
    for t in reopened:
        eid = ever[t]
        by_title[t] = eid
        entries[eid]['closed_sha'] = None; entries[eid]['closed_when'] = None; entries[eid]['closed_idx'] = None
        entries[eid]['reopened'] += 1
        entries[eid]['last_body'] = cur[t]['body']
        ev['reopened'].append(eid)
    for t in cur:   # keep last_body fresh
        if t in by_title:
            entries[by_title[t]]['last_body'] = cur[t]['body']
            entries[by_title[t]]['optional'] = entries[by_title[t]]['optional'] or ('optional' in t.lower())
    counts.append(dict(idx=idx, sha=h, when=when, subject=subj[:140], open=len(cur), **{k: v for k, v in ev.items()}))
    prev = cur
    assert len(by_title) == len(cur), (idx, len(by_title), len(cur))

for e in entries.values():
    e['first_body'] = e['first_body'][:1800]
    e['last_body'] = e['last_body'][:1800]
json.dump(list(entries.values()), open('entries.json', 'w'), indent=1)
json.dump(counts, open('counts.json', 'w'), indent=1)
op = sum(1 for e in entries.values() if e['closed_idx'] is None)
print('entries', len(entries), 'open', op, 'closed', len(entries) - op, 'last open', counts[-1]['open'])
# identity check against a plain line count at each commit
bad = 0
for c in counts:
    n = sum(1 for l in sh('git', 'show', f"{c['sha']}:TODO.md").split('\n') if re.match(r'^- \[ \] \*\*', l))
    if n != c['open']:
        bad += 1; print('count mismatch', c['sha'], n, c['open'])
print('plain-count mismatches:', bad)
