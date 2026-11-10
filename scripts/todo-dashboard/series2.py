#!/usr/bin/env python3
"""Corrected progress series for Sysprose's TODO.md: applies the extraction audit (wf_73df45f2) to
entries.json / counts.json and joins the severity classes (classified.json).
Writes timeline.json (one row per merge that changed TODO.md), entries_final.json, summary.json."""
import json, collections, re

E = {e['id']: e for e in json.load(open('entries.json'))}
C = json.load(open('counts.json'))
K = {x['id']: x for x in json.load(open('classified.json'))['final']}
import os
EXTRA = json.load(open('labels_extra.json')) if os.path.exists('labels_extra.json') else {}
OVER = json.load(open('label_overrides.json')) if os.path.exists('label_overrides.json') else {}
CORR = json.load(open('corrections_extra.json')) if os.path.exists('corrections_extra.json') else {'pairs': []}
PROVISIONAL = set()


def rule_label(e):
    """a keyword rule for an entry no pass has classified yet (provisional)."""
    t = (e['first_title'] + ' ' + e['first_body']).lower()
    if re.search(r'false verdict|known_false|known-false|false witness|false pass|wrong answer|loses |overwrit|silently|hangs|livelock|crash|differs from (its|the) saved|page and (the )?file|reads t where f|reads f where t', t):
        c = 'FALSE'
    elif re.search(r'awaits (user )?decision|hold:|parked|waits on', t):
        c = 'HELD'
    elif re.search(r'abstain|sound[, ]+(but )?(only )?weaker|unknown where|inconclusive|loud', t) and 'optional' not in e['first_title'].lower():
        c = 'WEAKER'
    else:
        c = 'POLISH'
    return c


for _i, _e in E.items():
    if _i in K:
        continue
    if str(_i) in EXTRA:
        x = EXTRA[str(_i)]
        K[_i] = dict(id=_i, cls_first=x['cls_first'], cls_last=x['cls_last'], how=x.get('source', 'llm'))
    else:
        K[_i] = dict(id=_i, cls_first=rule_label(_e), cls_last=rule_label(_e), how='rule')
        PROVISIONAL.add(_i)
for _i, _o in OVER.items():
    if int(_i) in K:
        K[int(_i)] = dict(K[int(_i)], **{k: v for k, v in _o.items() if k.startswith('cls_')})

# --- audit corrections --------------------------------------------------------------------------
# stale re-adds by two branch merges (not reopenings): present idx 7..11, removed by the cleanup at idx 12
STALE = {7: [8, 1, 2, 11, 18, 19, 20, 21], 8: [6, 7, 9]}
# (closed id, new id) pairs that are the same entry narrowed / replaced by its residual
PAIRS = [(46, 59), (48, 60), (51, 83), (91, 110), (90, 111), (72, 122), (60, 134), (63, 133), (65, 133), (75, 135),
         (81, 136), (87, 136), (129, 136), (23, 139), (37, 148), (111, 167), (138, 174), (22, 172), (139, 173),
         (155, 176), (133, 180), (134, 181), (126, 182), (122, 191), (158, 192), (117, 195), (188, 196),
         (149, 206), (150, 207), (216, 260)]
# rewrites the matcher paired but that are two different problems: the old one closes, the other is new
SPLIT = {145: 30, 177: 47}   # entry id -> idx of the commit

PAIRS = PAIRS + [tuple(x) for x in CORR['pairs']]
# a narrowing's new entry inherits the class of the entry it narrows when no pass labelled it
for _c, _n in CORR['pairs']:
    if _n in PROVISIONAL:
        K[_n] = dict(K[_n], cls_first=K[_c]['cls_last'], cls_last=K[_c]['cls_last'], how='inherit'); PROVISIONAL.discard(_n)
stale_ids = {i for v in STALE.values() for i in v}
rew_first = {}
for c in C:
    for i in c['rewritten']:
        rew_first.setdefault(i, c['idx'])

# entries after splitting 145 / 177
nid = max(E) + 1
split_new = {}
for old, idx in SPLIT.items():
    n = dict(E[old]); n['id'] = nid; n['first_idx'] = idx; n['first_title'] = E[old]['titles'][-1]; n['split_from'] = old
    n['titles'] = [E[old]['titles'][-1]]
    E[nid] = n; K[nid] = dict(K[old]); split_new[old] = nid; nid += 1
    # the old entry closes at idx with the class of its text at filing
    E[old]['closed_idx'] = idx; E[old]['closed_when'] = C[idx]['when']
    K[old] = dict(K[old], cls_last=K[old]['cls_first'])


LAST_IDX = C[-1]['idx']


def cls_at(i, idx):
    k = K[i]
    r = rew_first.get(i)
    if str(i) in OVER and idx >= LAST_IDX:
        return k['cls_last']   # independently verified (label_overrides.json): the current class, from the latest merge on
    return k['cls_last'] if (r is not None and idx >= r) else k['cls_first']


CLS = ['FALSE', 'WEAKER', 'POLISH', 'HELD']
open_ids = set()
rows = []
cum_new = cum_closed = 0
prev_open = 0
for c in C:
    idx = c['idx']
    remap = lambda i: split_new[i] if (i in SPLIT and idx > SPLIT[i]) else i
    new = list(c['new']); closed = [remap(i) for i in c['closed']]; reop = list(c['reopened'])
    # split corrections
    for old, at in SPLIT.items():
        if at == idx:
            new.append(split_new[old]); closed.append(old)
    # stale resurrections: not new, not reopened; the later cleanup is not a closure
    if idx in STALE:
        reop = [i for i in reop if i not in STALE[idx]]
    if idx == 12:
        closed = [i for i in closed if i not in stale_ids or i == 6]
    # narrowings
    reshaped_new = []; reshaped_closed = []
    for (cl, nw) in PAIRS:
        if cl in closed and nw in new:
            pass
    pairs_here = [(cl, nw) for (cl, nw) in PAIRS if cl in closed and nw in new]
    for cl, nw in pairs_here:
        if cl not in reshaped_closed: reshaped_closed.append(cl)
        if nw not in reshaped_new: reshaped_new.append(nw)
    new_adj = [i for i in new if i not in reshaped_new]
    closed_adj = [i for i in closed if i not in reshaped_closed]
    # id-set simulation (entries whose title returned after a stale re-add are skipped)
    for i in c['new'] + [x for x in reop]:
        open_ids.add(i)
    for old, at in SPLIT.items():
        if at == idx:
            open_ids.add(split_new[old]); open_ids.discard(old) if False else None
    for i in c['closed']:
        open_ids.discard(remap(i))
    for old, at in SPLIT.items():
        if at == idx:
            open_ids.discard(old); open_ids.add(split_new[old])
    # stale re-adds: present at idx 7..11 in the raw data -> remove from the corrected open set
    raw_ids = set(open_ids)
    present_stale = set()
    if 7 <= idx <= 11:
        present_stale = {i for i in [8, 1, 2, 11, 18, 19, 20, 21] if idx >= 7} | ({6, 7, 9} if idx >= 8 else set())
    adj_ids = {i for i in raw_ids if i not in present_stale or (i == 6)}
    adj_ids -= ({7, 9} if 8 <= idx <= 11 else set()) if False else set()
    # entry 6 stays (it is open legitimately); 7 and 9 only appear through the stale re-add
    adj_ids = {i for i in raw_ids if i not in present_stale or i == 6}
    byc = {k: sum(1 for i in adj_ids if cls_at(i, idx) == k) for k in CLS}
    newc = {k: sum(1 for i in new_adj if K[i]['cls_first'] == k) for k in CLS}
    clc = {k: sum(1 for i in closed_adj if cls_at(i, idx) == k) for k in CLS}
    cum_new += len(new_adj); cum_closed += len(closed_adj)
    rows.append(dict(idx=idx, sha=c['sha'], when=c['when'], day=c['when'][:10], subject=c['subject'],
                     open_raw=c['open'], open=len(adj_ids), open_by=byc,
                     new=len(new_adj), closed=len(closed_adj), narrowed=len(pairs_here), new_by=newc, closed_by=clc,
                     cum_new=cum_new, cum_closed=cum_closed))
    prev_open = len(adj_ids)

json.dump(rows, open('timeline.json', 'w'), indent=1)
final = []
for i, e in sorted(E.items()):
    final.append(dict(id=i, title=e['titles'][-1][:140], first_title=e['first_title'][:140], first=e['first_when'][:10] if 'first_when' in e else '',
                      first_idx=e['first_idx'], closed=(e['closed_when'] or '')[:10], closed_idx=e['closed_idx'], tag=e['tag'],
                      cls_first=K[i]['cls_first'], cls_last=K[i]['cls_last'], optional=e['optional'], split_from=e.get('split_from'), provisional=(i in PROVISIONAL)))
json.dump(final, open('entries_final.json', 'w'), indent=1)

# --- checks -------------------------------------------------------------------------------------------
print('commit rows', len(rows), 'provisional labels', len(PROVISIONAL), sorted(PROVISIONAL))
print('last open (corrected)', rows[-1]['open'], 'raw', rows[-1]['open_raw'], 'by class', rows[-1]['open_by'])
print('cum new', rows[-1]['cum_new'], 'cum closed', rows[-1]['cum_closed'], 'narrowed pairs', sum(r['narrowed'] for r in rows))
# identity: open_t = open_{t-1} + new - closed - consolidation; report the residual so it is visible
prev = 0
for r in rows:
    d = r['open'] - prev - r['new'] + r['closed']
    if d: print('  idx', r['idx'], r['sha'], 'residual (consolidations / stale)', d)
    prev = r['open']
for lo, hi, name in ((0, 12, 'before the review'), (12, 27, 'Oct 14-21'), (27, 51, 'Oct 21-29'), (12, 51, 'since the review')):
    sl = rows[lo:hi]
    n = sum(r['new'] for r in sl); cl = sum(r['closed'] for r in sl); nr = sum(r['narrowed'] for r in sl)
    nf = sum(r['new_by']['FALSE'] for r in sl); cf = sum(r['closed_by']['FALSE'] for r in sl)
    print(f"{name:20s} new {n:3d} closed {cl:3d} narrowed {nr:2d} | FALSE new {nf:3d} closed {cf:3d} | open {rows[lo-1]['open'] if lo else 0} -> {sl[-1]['open']}")
print('open by class now', rows[-1]['open_by'])
for r in rows[::5] + [rows[-1]]:
    print(r['idx'], r['day'], r['open'], r['open_by'])
