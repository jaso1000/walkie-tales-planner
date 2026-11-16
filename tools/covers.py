"""Find a cover for items that were identified but came without a picture: searches Deezer and Apple by the matched
title and artist/author, and Open Library for books. Updates the cache and covers, then rebuilds the catalogue."""
import json, os, sys, urllib.parse
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import enrich as e

cache = os.path.join(e.DATA, 'cache')
todo = []
for f in os.listdir(cache):
    it = json.load(open(os.path.join(cache, f), encoding='utf-8'))
    if it.get('match') and not it.get('hasCover'): todo.append(it)
print(len(todo), 'identified items without a cover', flush=True)

def find(it):
    m = it['match']
    who = ' '.join((m.get('authors') or [])[:1])
    q = f"{m['title']} {who}".strip()
    searches = [lambda: e.deezer(q), lambda: e.itunes(q, 'music', 'album'), lambda: e.itunes(q, 'audiobook'), lambda: e.openlibrary(q)]
    if it['kind'] in ('book', 'tonie'): searches = searches[2:] + searches[:2]
    for s in searches:
        try: cands = [c for c in s() if c.get('cover')]
        except Exception: cands = []
        for c in cands: c['score'] = e.score(m['title'], c['title'])
        good = [c for c in cands if c['score'] >= 85]
        if good:
            m['cover'] = max(good, key=lambda c: c['score'])['cover']
            it['hasCover'] = e.save_cover(it)
            if it['hasCover']: break
    json.dump(it, open(os.path.join(cache, it['id'] + '.json'), 'w', encoding='utf-8'), ensure_ascii=False)
    return it['hasCover']

with ThreadPoolExecutor(3) as ex:
    got = sum(ex.map(find, todo))
print(f'found {got} more covers', flush=True)
e.build_catalog()
