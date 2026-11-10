#!/usr/bin/env python3
"""Builds the dashboard's data files from timeline.json / entries_final.json (+ origin.json when present)."""
import json, os, collections

T = json.load(open('timeline.json'))
F = {e['id']: e for e in json.load(open('entries_final.json'))}
ORIG = {}
if os.path.exists('origin.json'):
    ORIG = {x['id']: x for x in json.load(open('origin.json'))['final']}
    if os.path.exists('origin_extra.json'):
        for k, v in json.load(open('origin_extra.json')).items(): ORIG[int(k)] = dict(v, id=int(k))

# 1. timeline: one row per merge that changed TODO.md
rows = []
for r in T:
    rows.append(dict(
        idx=r['idx'], day=r['day'], sha=r['sha'], what=r['subject'][:90],
        open=r['open'], open_false=r['open_by']['FALSE'], open_weaker=r['open_by']['WEAKER'],
        open_polish=r['open_by']['POLISH'], open_held=r['open_by']['HELD'],
        found=r['new'], closed=r['closed'], narrowed=r['narrowed'],
        found_false=r['new_by']['FALSE'], closed_false=r['closed_by']['FALSE'],
        cum_found=r['cum_new'], cum_closed=r['cum_closed']))
json.dump(rows, open('ds_timeline.json', 'w'))

# 2. windows
W = [('w0', 'Before the review', 0, 11), ('w1', 'Review and wave 1 (Oct 14-20)', 12, 25),
     ('w2', 'Backlog sweep (Oct 21)', 26, 28), ('w3', 'Wave 2 (Oct 21-24)', 29, 45), ('w4', 'Wave 3 (Oct 26-29)', 46, 51), ('w5', 'Fence first (from Oct 29)', 52, len(T) - 1)]
wins = []
for wid, name, lo, hi in W:
    sl = T[lo:hi + 1]
    start = T[lo - 1]['open'] if lo else 0
    found = sum(r['new'] for r in sl); closed = sum(r['closed'] for r in sl)
    ff = sum(r['new_by']['FALSE'] for r in sl); cf = sum(r['closed_by']['FALSE'] for r in sl)
    fw = sum(r['new_by']['WEAKER'] for r in sl); cw = sum(r['closed_by']['WEAKER'] for r in sl)
    wins.append(dict(window=wid, name=name, from_day=sl[0]['day'], to_day=sl[-1]['day'], merges=len(sl),
                     open_start=start, open_end=sl[-1]['open'], found=found, closed=closed,
                     narrowed=sum(r['narrowed'] for r in sl),
                     found_false=ff, closed_false=cf, found_weaker=fw, closed_weaker=cw,
                     found_other=found - ff - fw, closed_other=closed - cf - cw,
                     per_closed=round(found / closed, 2) if closed else None,
                     per_closed_false=round(ff / cf, 2) if cf else None,
                     false_open_start=T[lo - 1]['open_by']['FALSE'] if lo else 0, false_open_end=sl[-1]['open_by']['FALSE']))
json.dump(wins, open('ds_windows.json', 'w'))

# 3. origin of the wrong-answer / weaker entries counted as found (not narrowings), by window
if ORIG:
    # entries counted as found at their first_idx: first_idx>=12, in the corrected 'new' lists
    new_ids = collections.defaultdict(list)
    SKIPPED = set()
    narrowed_new = {n for (c, n) in [(46, 59), (48, 60), (51, 83), (91, 110), (90, 111), (72, 122), (60, 134), (63, 133), (65, 133), (75, 135),
                    (81, 136), (87, 136), (129, 136), (23, 139), (37, 148), (111, 167), (138, 174), (22, 172), (139, 173),
                    (155, 176), (133, 180), (134, 181), (126, 182), (122, 191), (158, 192), (117, 195), (188, 196),
                    (149, 206), (150, 207), (216, 260)] + [tuple(x) for x in json.load(open('corrections_extra.json'))['pairs']]}
    out = []
    for wid, name, lo, hi in W[1:]:
        c = collections.Counter()
        for i, o in ORIG.items():
            e = F[i]
            if i in narrowed_new: continue
            if lo <= e['first_idx'] <= hi:
                c[(e['cls_first'], o['origin'])] += 1
        for e in F.values():
            if e['id'] in ORIG or e['id'] in narrowed_new or e['id'] in SKIPPED: continue
            if lo <= e['first_idx'] <= hi and e['cls_first'] in ('FALSE', 'WEAKER') and e['id'] > 0:
                c[(e['cls_first'], 'PENDING')] += 1
        for (cls, org), n in sorted(c.items()):
            out.append(dict(window=wid, name=name, severity=cls, origin=org, n=n))
    json.dump(out, open('ds_origin.json', 'w'))
    print('origin rows', len(out))

# 4. the open entries
CLS = json.load(open('classes.json')) if os.path.exists('classes.json') else {}
VW = json.load(open('views.json')) if os.path.exists('views.json') else {}
op = []
for i, e in sorted(F.items()):
    if e['closed_idx'] is None:
        o = ORIG.get(i, {})
        op.append(dict(id=i, title=e['title'], severity=e['cls_last'], filed=e['first'], optional=bool(e['optional']),
                       origin=o.get('origin', ''), found_by=o.get('found_by', ''), tag=e['tag'][:50], provisional=bool(e.get('provisional')), cls=CLS.get(str(i), 'N'), view=VW.get(str(i), {}).get('v', 'NP'), view2=VW.get(str(i), {}).get('v2', '') or ''))
json.dump(op, open('ds_open.json', 'w'))
print('timeline', len(rows), 'windows', len(wins), 'open entries', len(op))
for w in wins:
    print(w['name'], '| merges', w['merges'], '| open', w['open_start'], '->', w['open_end'], '| found', w['found'], 'closed', w['closed'], 'narrowed', w['narrowed'], '| per closed', w['per_closed'], '| FALSE found', w['found_false'], 'closed', w['closed_false'], 'open', w['false_open_start'], '->', w['false_open_end'])
