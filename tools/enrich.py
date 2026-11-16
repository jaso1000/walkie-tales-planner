"""Identify every item in data/collection.csv and fetch a cover, author, length and blurb for it.

Sources (all free, no keys): Audible (audiobooks), Open Library (books), Deezer (music albums), Apple (podcasts,
albums, movies), TVmaze (TV shows) and Wikipedia (films and anything else). Each item's result is cached in
data/cache/<id>.json, so the script can be stopped and re-run; delete a cache file to look that item up again.
Writes data/catalog.json and 400 px covers in data/covers/<id>.jpg.

    python tools/enrich.py            # everything not yet looked up
    python tools/enrich.py --only ID  # one item again (ignores its cache)
"""
import csv, hashlib, html, io, json, os, re, sys, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
from rapidfuzz import fuzz
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')
UA = {'User-Agent': 'walkietales-collection-planner/0.1 (personal catalogue)'}

# ----------------------------------------------------------------------------------------------- names

SEASONS = {'Christmas': 'Christmas', 'Easter': 'Easter', 'Halloween': 'Halloween'}

def item_id(row):
    return hashlib.sha1(f"{row['Category']}|{row['Name']}|{row['From']}".encode('utf-8')).hexdigest()[:10]

def clean(name):
    """'Christmas - Ladybird Advent Stories [Y]' -> 'Ladybird Advent Stories'"""
    s = name.replace('꞉', ':').replace('_', ' ')
    s = re.sub(r'\.(mp3|m4b|m4a|zip)$', '', s, flags=re.I)
    s = re.sub(r'\(Y\)\s*zip$', '', s, flags=re.I)
    s = re.sub(r'[\(\[]\s*Y(\.\w{1,3})?\s*[\)\]]', ' ', s)
    s = re.sub(r'\((Digital|Episode Audio|TV Audio|Spotify Playlist)\)', ' ', s, flags=re.I)
    s = re.sub(r'-?\s*(Movie Audio|Episode Audio|Official Animations)\b', ' ', s, flags=re.I)
    s = re.sub(r'^(Christmas|Easter|Halloween)( Music)?\s*-\s*', '', s, flags=re.I)
    s = re.sub(r'^Music\s*-\s*', '', s, flags=re.I)
    s = re.sub(r'^#\d+\s+', '', s)
    s = re.sub(r'\b([A-Z][a-z]+(?:[A-Z][a-z]+){2,})\b', lambda m: re.sub(r'(?<=[a-z])(?=[A-Z])', ' ', m.group(1)), s)  # LaylaTheWaterLilyDragon
    s = re.sub(r'-full$', '', s)
    s = re.sub(r'-?\d{8}T\d{6}Z(-\d+)*', '', s)                         # Google Drive download stamp
    s = re.sub(r'\((read|narrated) by [^)]*\)', ' ', s, flags=re.I)
    s = re.sub(r'\s+', ' ', s).strip(' -.')
    return s

def kind_of(cat, name):
    n = name.lower()
    if cat == 'Music': return 'music'
    if cat == 'Podcasts': return 'podcast'
    if cat == 'Movies': return 'movie'
    if cat == 'TV Episodes': return 'movie' if 'movie audio' in n or re.search(r'\(\d{4}\)', name) else 'tv'
    if cat == 'Tonies': return 'tonie'
    if cat in SEASONS:
        return 'music' if re.search(r'\b(music|songs|carols|sing|party|kidz bop)\b', n) else 'book'
    return 'book'

# ----------------------------------------------------------------------------------------------- web

def get(url, tries=3):
    for t in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=25) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in (429, 503): time.sleep(8 * (t + 1)); continue
            return None
        except Exception:
            time.sleep(2 * (t + 1))
    return None

def plain(text, n=700):
    if not text: return ''
    t = html.unescape(re.sub(r'<[^>]+>', ' ', text))
    t = re.sub(r'\s+', ' ', t).strip()
    return t if len(t) <= n else t[:n].rsplit(' ', 1)[0] + '…'

def score(q, title, extra=''):
    a = fuzz.token_set_ratio(q, title)
    b = fuzz.token_sort_ratio(q, title)
    c = fuzz.token_set_ratio(q, f'{title} {extra}') if extra else 0
    return max((a + b) / 2, (c + b) / 2 if extra else 0)

# ----------------------------------------------------------------------------------------------- sources

def audible(q, region='com.au'):
    d = get(f'https://api.audible.{region}/1.0/catalog/products?' + urllib.parse.urlencode({
        'keywords': q, 'num_results': 8, 'products_sort_by': 'Relevance', 'image_sizes': '500',
        'response_groups': 'contributors,media,product_attrs,product_desc,category_ladders,series'}))
    out = []
    for p in (d or {}).get('products', []):
        authors = [a['name'] for a in p.get('authors') or []]
        series = (p.get('series') or [{}])[0]
        ladders = [[c['name'] for c in l.get('ladder', [])] for l in p.get('category_ladders') or []]
        title = p.get('title') or ''
        out.append(dict(
            score=score(q, title, ' '.join(authors + [series.get('title', '')])),
            title=title, subtitle=p.get('subtitle') or '', authors=authors,
            narrators=[n['name'] for n in p.get('narrators') or []],
            series=series.get('title', ''), seriesPos=series.get('sequence', ''),
            minutes=p.get('runtime_length_min'), year=(p.get('release_date') or '')[:4],
            blurb=plain(p.get('publisher_summary') or p.get('merchandising_summary')),
            genres=sorted({l[0] for l in ladders if l} | {l[1] for l in ladders if len(l) > 1}),
            ladders=ladders, cover=list((p.get('product_images') or {}).values())[:1],
            link=f"https://www.audible.{region}/pd/{p.get('asin')}", source='Audible'))
    return out

def openlibrary(q):
    d = get('https://openlibrary.org/search.json?' + urllib.parse.urlencode({
        'q': q, 'limit': 6, 'fields': 'key,title,subtitle,author_name,cover_i,subject,first_publish_year'}))
    out = []
    for x in (d or {}).get('docs', []):
        authors = x.get('author_name') or []
        out.append(dict(
            score=score(q, x.get('title', ''), ' '.join(authors)), title=x.get('title', ''),
            subtitle=x.get('subtitle', ''), authors=authors[:3], year=str(x.get('first_publish_year') or ''),
            genres=(x.get('subject') or [])[:8], subjects=x.get('subject') or [],
            cover=[f"https://covers.openlibrary.org/b/id/{x['cover_i']}-L.jpg"] if x.get('cover_i') else [],
            link='https://openlibrary.org' + x.get('key', ''), source='Open Library'))
    return out

def deezer(q):
    d = get('https://api.deezer.com/search/album?q=' + urllib.parse.quote(q))
    out = []
    for x in (d or {}).get('data', [])[:8]:
        artist = x.get('artist', {}).get('name', '')
        out.append(dict(score=score(q, x.get('title', ''), artist), title=x.get('title', ''), authors=[artist],
                        tracks=x.get('nb_tracks'), cover=[x.get('cover_xl')] if x.get('cover_xl') else [],
                        genres=[], link=x.get('link', ''), source='Deezer'))
    return out

def itunes(q, media, entity=None):
    p = {'term': q, 'media': media, 'limit': 8, 'country': 'AU'}
    if entity: p['entity'] = entity
    d = get('https://itunes.apple.com/search?' + urllib.parse.urlencode(p))
    time.sleep(3)  # Apple allows ~20 searches a minute
    out = []
    for x in (d or {}).get('results', []):
        title = x.get('collectionName') or x.get('trackName') or ''
        art = (x.get('artworkUrl100') or '').replace('100x100bb', '600x600bb')
        out.append(dict(score=score(q, title, x.get('artistName', '')), title=title, authors=[x.get('artistName', '')],
                        year=(x.get('releaseDate') or '')[:4], genres=[x.get('primaryGenreName', '')] if x.get('primaryGenreName') else [],
                        blurb=plain(x.get('description') or x.get('longDescription')), tracks=x.get('trackCount'),
                        cover=[art] if art else [], link=x.get('collectionViewUrl') or x.get('trackViewUrl') or '',
                        source='Apple'))
    return out

def tvmaze(q):
    d = get('https://api.tvmaze.com/search/shows?q=' + urllib.parse.quote(q))
    out = []
    for r in (d or [])[:5]:
        x = r.get('show', {})
        out.append(dict(score=score(q, x.get('name', '')), title=x.get('name', ''), year=(x.get('premiered') or '')[:4],
                        genres=x.get('genres') or [], blurb=plain(x.get('summary')),
                        cover=[(x.get('image') or {}).get('original')] if x.get('image') else [],
                        link=x.get('url', ''), source='TVmaze', network=((x.get('network') or x.get('webChannel') or {}).get('name', ''))))
    return out

def wikipedia(q, hint=''):
    s = get('https://en.wikipedia.org/w/api.php?' + urllib.parse.urlencode({
        'action': 'query', 'list': 'search', 'srsearch': f'{q} {hint}'.strip(), 'srlimit': 3, 'format': 'json'}))
    out = []
    for hit in ((s or {}).get('query') or {}).get('search', [])[:3]:
        d = get('https://en.wikipedia.org/api/rest_v1/page/summary/' + urllib.parse.quote(hit['title'].replace(' ', '_')))
        if not d: continue
        img = (d.get('originalimage') or d.get('thumbnail') or {}).get('source')
        out.append(dict(score=score(q, re.sub(r'\s*\(.*?\)$', '', d.get('title', ''))), title=d.get('title', ''),
                        subtitle=d.get('description', ''), blurb=plain(d.get('extract')), genres=[],
                        cover=[img] if img else [], link=(d.get('content_urls') or {}).get('desktop', {}).get('page', ''),
                        source='Wikipedia'))
    return out

PLANS = {
    'book':    [lambda q: audible(q), lambda q: audible(q, 'com'), openlibrary, lambda q: itunes(q, 'audiobook')],
    'tonie':   [lambda q: audible(q), lambda q: deezer(q), lambda q: tvmaze(q), openlibrary],
    'music':   [deezer, lambda q: itunes(q, 'music', 'album'), lambda q: audible(q)],
    'podcast': [lambda q: itunes(q, 'podcast'), lambda q: audible(q)],
    'tv':      [tvmaze, lambda q: wikipedia(q, 'television series'), lambda q: audible(q)],
    'movie':   [lambda q: wikipedia(q, 'film'), lambda q: itunes(q, 'movie')],
}
GOOD = 82  # stop at the first source with a match this good; otherwise keep the best seen if it is at least OK
OK = 70

def age_guess(kind, m):
    """A rough age band from the store's categories and the length. Shown in the planner as a guess."""
    if not m: return ''
    lad = ' / '.join(' > '.join(l) for l in m.get('ladders') or []).lower()
    subj = ' '.join(m.get('subjects') or []).lower()
    mins = m.get('minutes') or 0
    if 'teen' in lad or 'young adult' in subj: return 'Teen'
    if kind in ('music', 'tv', 'podcast', 'tonie'): return 'All ages'
    kids = "children's" in lad or 'juvenile' in subj or "children's" in subj or 'picture book' in subj
    if m.get('ladders') and not kids: return 'Grown-up'
    if not mins: return 'Kids' if kids else ''
    if mins <= 40: return 'Under 5'
    if mins <= 150: return '5–8'
    return '8–12'

NOISE = r'(audio ?book collection|audiobook collection|complete collection|collection|box ?set|pack|bundle|series|'         r'books? \d+\s*(-|to|–)\s*\d+|vol(ume)?\.? ?\d+( ?& ?vol(ume)?\.? ?\d+)?|season \d+|tonie|podcast|songs from|the songs|'         r'soundtrack|unabridged|short stories)'

def looks_like_name(t):
    return 2 <= len(t.split()) <= 3 and all(w[:1].isupper() for w in t.split()) and not re.search(r'\d', t)

def variants(q):
    """Shorter forms of a name for searches that need every word to match:
    'Gordon Korman - The 39 Clues - Unstoppable' -> '… Unstoppable', 'The 39 Clues Unstoppable', 'Unstoppable'."""
    out = [q]
    parts = [p.strip() for p in re.split(r'\s+-\s+|\s*:\s+', q) if p.strip()]
    def add(v):
        v = re.sub(r'\s+', ' ', re.sub(r'[()\[\]#,]', ' ', v)).strip(' -')
        if v and len(v) > 2 and v.lower() not in (x.lower() for x in out): out.append(v)
    if len(parts) > 1:
        if looks_like_name(parts[0]): add(' '.join(parts[1:]))      # drop a leading author
        if looks_like_name(parts[-1]): add(' '.join(parts[:-1]))    # drop a trailing author
        add(parts[-1]); add(parts[0])
    for v in list(out): add(re.sub(NOISE, ' ', v, flags=re.I))
    return out[:6]

def author_hit(q, c):
    """'Anh Do' names an author, not a title: any of their books stands for the collection."""
    toks = set(q.lower().split())
    return len(toks) <= 3 and any(toks <= set(a.lower().replace('.', ' ').split()) for a in c.get('authors') or [])

def look_up(row):
    iid = item_id(row)
    q = clean(row['Name'])
    kind = kind_of(row['Category'], row['Name'])
    best = None
    vs = variants(q)
    for src in PLANS[kind]:
        for v in vs:
            try:
                cands = src(v)
            except Exception:
                cands = []
            ref = q if (v != q and looks_like_name(v)) else v  # a bare name might be the author: judge against the full name
            for c in cands:
                c['score'] = score(ref, c['title'], ' '.join((c.get('authors') or []) + [c.get('series', '')])) - (0 if ref == q else 3)
                if author_hit(q, c): c['score'] = max(c['score'], 78)
            if cands:
                top = max(cands, key=lambda c: c['score'] + (3 if c.get('cover') else 0))
                if not best or top['score'] > best['score']: best = top
                if best['score'] >= GOOD and best.get('cover'): break
            if kind in ('book', 'tonie') and src is PLANS[kind][0]: time.sleep(0.25)
        if best and best['score'] >= GOOD and best.get('cover'): break
    match = best if best and best['score'] >= OK else None
    return dict(id=iid, name=row['Name'], query=q, category=row['Category'], kind=kind, folder=row['From'],
                season=SEASONS.get(row['Category'], ''), match=match, age=age_guess(kind, match),
                confidence=round(best['score']) if best else 0)

# ----------------------------------------------------------------------------------------------- covers

def save_cover(item):
    m = item.get('match') or {}
    if not m.get('cover'): return False
    path = os.path.join(DATA, 'covers', item['id'] + '.jpg')
    if os.path.exists(path): return True
    try:
        with urllib.request.urlopen(urllib.request.Request(m['cover'][0], headers=UA), timeout=30) as r:
            im = Image.open(io.BytesIO(r.read())).convert('RGB')
        if im.width < 60: return False  # Open Library's 1px "no cover" image
        im.thumbnail((400, 400), Image.LANCZOS)
        im.save(path, 'JPEG', quality=82, optimize=True)
        return True
    except Exception:
        return False

def main():
    rows = list(csv.DictReader(open(os.path.join(DATA, 'collection.csv'), encoding='utf-8-sig')))
    only = sys.argv[sys.argv.index('--only') + 1] if '--only' in sys.argv else None
    cache = os.path.join(DATA, 'cache')
    retry = '--retry' in sys.argv  # look again at items not found or not sure, keep whichever result is better
    def cached(r):
        p = os.path.join(cache, item_id(r) + '.json')
        return json.load(open(p, encoding='utf-8')) if os.path.exists(p) else None
    if retry:
        todo = [r for r in rows if (lambda c: c is not None and (not c['match'] or c['confidence'] < 80))(cached(r))]
    else:
        todo = [r for r in rows if (only and item_id(r) == only) or (not only and cached(r) is None)]
    print(f'{len(rows)} items, {len(todo)} to look up', flush=True)

    def work(r):
        it = look_up(r)
        old = cached(r) if retry else None
        if old and old['confidence'] >= it['confidence']: return old
        it['hasCover'] = save_cover(it)
        json.dump(it, open(os.path.join(cache, it['id'] + '.json'), 'w', encoding='utf-8'), ensure_ascii=False)
        return it

    done = 0
    slow = [r for r in todo if kind_of(r['Category'], r['Name']) in ('podcast', 'movie')]  # Apple: one at a time
    fast = [r for r in todo if r not in slow]
    with ThreadPoolExecutor(8) as ex:
        for it in ex.map(work, fast):
            done += 1
            if done % 25 == 0: print(f'{done}/{len(todo)}  last: {it["query"][:50]} -> {(it["match"] or {}).get("title", "?")[:50]} ({it["confidence"]})', flush=True)
    for r in slow:
        work(r); done += 1
    build_catalog(rows)

def build_catalog(rows=None):
    rows = rows or list(csv.DictReader(open(os.path.join(DATA, 'collection.csv'), encoding='utf-8-sig')))
    items = []
    for r in rows:
        p = os.path.join(DATA, 'cache', item_id(r) + '.json')
        if os.path.exists(p): items.append(json.load(open(p, encoding='utf-8')))
    sizes_path = os.path.join(DATA, 'sizes.json')  # written by tools/scan_drive.py once the drive is plugged in
    sizes = json.load(open(sizes_path, encoding='utf-8')) if os.path.exists(sizes_path) else {}
    fixes_path = os.path.join(DATA, 'category-fixes.json')  # {id: {"category": ..., "why": ...}} from a check of the drive
    fixes = json.load(open(fixes_path, encoding='utf-8')) if os.path.exists(fixes_path) else {}
    for it in items:
        s = sizes.get(it['id'])
        if s: it.update(bytes=s.get('bytes'), files=s.get('files'), minutes=s.get('minutes'), localCover=s.get('cover', False))
        fx = fixes.get(it['id'])
        if fx:  # the id stays the same so plans keep working; only where it is filed changes
            it['filedAs'] = it['category']
            it['category'] = fx['category']
            it['kind'] = fx.get('kind') or kind_of(fx['category'], it['name'])
            it['season'] = SEASONS.get(fx['category'], '')
    json.dump({'built': time.strftime('%Y-%m-%d %H:%M'), 'items': items},
              open(os.path.join(DATA, 'catalog.json'), 'w', encoding='utf-8'), ensure_ascii=False)
    found = sum(1 for i in items if i['match'])
    print(f'catalog: {len(items)} items, {found} identified, {sum(1 for i in items if i.get("hasCover"))} with covers', flush=True)

if __name__ == '__main__':
    if '--catalog' in sys.argv: build_catalog()
    else: main()
