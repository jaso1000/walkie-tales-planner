"""Look up the item ids listed in a file again and replace their cached result and cover (python tools/redo.py data/redo.txt)."""
import csv, json, os, sys
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import enrich as e

ids = set(open(sys.argv[1]).read().split())
rows = [r for r in csv.DictReader(open(os.path.join(e.DATA, 'collection.csv'), encoding='utf-8-sig')) if e.item_id(r) in ids]
print(len(rows), 'to redo', flush=True)

def work(r):
    old = json.load(open(os.path.join(e.DATA, 'cache', e.item_id(r) + '.json'), encoding='utf-8'))
    it = e.look_up(r)
    same = (old.get('match') or {}).get('cover') == (it.get('match') or {}).get('cover')
    cover = os.path.join(e.DATA, 'covers', it['id'] + '.jpg')
    if not same and os.path.exists(cover): os.remove(cover)
    it['hasCover'] = e.save_cover(it)
    json.dump(it, open(os.path.join(e.DATA, 'cache', it['id'] + '.json'), 'w', encoding='utf-8'), ensure_ascii=False)
    return old, it

changed = 0
with ThreadPoolExecutor(8) as ex:
    for n, (old, it) in enumerate(ex.map(work, rows), 1):
        if (old.get('match') or {}).get('title') != (it.get('match') or {}).get('title'): changed += 1
        if n % 50 == 0: print(f'{n}/{len(rows)}, {changed} changed', flush=True)
print(f'done, {changed} changed', flush=True)
e.build_catalog()
