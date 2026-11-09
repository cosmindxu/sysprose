#!/usr/bin/env python3
"""Hourly refresh of the open-items dashboard data (artifact Xdzb4EGRkHQWKecoeNGg3r).

usage: refresh.py            -> re-extract from the git history of TODO.md on main; prints one JSON line:
                                {"status": "NOCHANGE"|"CHANGED", "changed": [datasets whose file changed], ...}
       refresh.py --force    -> do not stop at an unchanged TODO.md head
       refresh.py --commit timeline=<blob url> windows=<url> ...  -> record uploaded blob urls and file hashes in state.json
The coordinator (Claude) uploads the changed ds_*.json files as artifact assets, updates the dataset documents,
deletes the old blobs, then calls --commit."""
import json, os, subprocess, sys, hashlib
os.chdir(os.path.dirname(os.path.abspath(__file__)))
ST = 'state.json'
state = json.load(open(ST)) if os.path.exists(ST) else {}
FILES = {'timeline': 'ds_timeline.json', 'windows': 'ds_windows.json', 'origin': 'ds_origin.json', 'open': 'ds_open.json'}
sha = lambda p: hashlib.sha256(open(p, 'rb').read()).hexdigest()
if len(sys.argv) > 1 and sys.argv[1] == '--commit':
    for kv in sys.argv[2:]:
        k, url = kv.split('=', 1)
        state.setdefault('blobs', {})[k] = url
        state.setdefault('hashes', {})[k] = sha(FILES[k])
    state['head'] = state.get('pending_head', state.get('head'))
    json.dump(state, open(ST, 'w'), indent=1); print('committed', list(state['blobs'].items())); sys.exit(0)
head = subprocess.run(['git', '-C', os.path.abspath('../..'), 'log', '-1', '--format=%h', '--first-parent', 'main', '--', 'TODO.md'], capture_output=True, text=True).stdout.strip()
if head == state.get('head') and '--force' not in sys.argv:
    print(json.dumps({'status': 'NOCHANGE', 'head': head})); sys.exit(0)
def run(*a):
    r = subprocess.run(['python3', *a], capture_output=True, text=True)
    if r.returncode: print(r.stdout[-1500:], r.stderr[-1500:]); sys.exit('failed: ' + ' '.join(a))
    return r.stdout
run('entries.py'); out = run('series2.py'); run('datasets.py')
changed = [k for k, f in FILES.items() if sha(f) != state.get('hashes', {}).get(k)]
F = json.load(open('entries_final.json')); T = json.load(open('timeline.json'))
unl = [e['id'] for e in F if e.get('provisional')]
state['pending_head'] = head; json.dump(state, open(ST, 'w'), indent=1)
print(json.dumps({'status': 'CHANGED' if changed else 'NOCHANGE-DATA', 'head': head, 'changed': changed, 'provisional_ids': unl,
                  'open': T[-1]['open'], 'open_by': T[-1]['open_by'], 'merges': len(T), 'last_merge': T[-1]['subject'][:80], 'blobs': state.get('blobs', {})}))
