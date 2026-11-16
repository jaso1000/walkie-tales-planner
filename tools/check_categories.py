"""Flag items that look filed in the wrong category, using the drive scan (file names, count, play time),
the name and what the online look-up found. Prints a review list; decisions go in data/category-fixes.json.

    python tools/check_categories.py [--all CATEGORY]
"""
import csv, json, os, re, statistics, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import enrich

D = enrich.DATA
SEASON_WORDS = {
    'Christmas': r'\b(christmas|xmas|santa|advent|nativity|reindeer|rudolph|grinch|snowman|jingle|noel|elf on the shelf|nutcracker|carols?)\b',
    'Easter': r'\b(easter|egg hunt|peter cottontail)\b',
    'Halloween': r'\b(halloween|spooky|pumpkin|trick or treat|haunted|ghosts?|monster mash|witch(es)?)\b',
}
MUSIC_WORDS = r'\b(songs?|music|soundtrack|album|nursery rhymes|lullab\w*|karaoke|kidz bop|sing[- ]?along|singalong|hits|playlist|carols|dance party|greatest)\b'
POD_WORDS = r'\bpodcast\b'
EP_RE = re.compile(r'(s\d{1,2}\s*e\d{1,3}|\bepisode\b|\bep\.?\s*\d|series \d+)', re.I)
CHAP_RE = re.compile(r'(chapter|\bch\.?\s*\d|part \d|\bdisc\b|\bcd\s*\d|prologue|epilogue|introduction|opening credits)', re.I)
SRC_KIND = {'Audible': 'book', 'Open Library': 'book', 'Deezer': 'music', 'TVmaze': 'tv'}

def main():
    rows = list(csv.DictReader(open(os.path.join(D, 'collection.csv'), encoding='utf-8-sig')))
    cat = {i['id']: i for i in json.load(open(os.path.join(D, 'catalog.json'), encoding='utf-8'))['items']}
    scan = json.load(open(os.path.join(D, 'drive-scan.json'), encoding='utf-8'))
    sizes = json.load(open(os.path.join(D, 'sizes.json'), encoding='utf-8'))
    only = sys.argv[sys.argv.index('--all') + 1] if '--all' in sys.argv else None
    out = []
    for r in rows:
        iid = enrich.item_id(r)
        it, sc, sz = cat.get(iid, {}), scan.get(iid, {}), sizes.get(iid, {})
        c, n = r['Category'], r['Name']
        files, mins = sz.get('files', 0), sz.get('minutes', 0)
        avg = mins / files if files else 0
        names = [os.path.basename(a) for a in sc.get('audio', [])]
        blob = ' | '.join(names)
        m = it.get('match') or {}
        why, guess = [], None
        low = n.lower()
        eps = sum(1 for x in names if EP_RE.search(x))
        chaps = sum(1 for x in names if CHAP_RE.search(x))
        musicish = files >= 6 and 1.2 <= avg <= 5.5 and chaps < files / 3
        bookish = chaps >= max(2, files / 3) or (files and avg >= 9) or (files == 1 and mins >= 25)
        if c == 'Audiobooks':
            if re.search(MUSIC_WORDS, low): why.append('name says music'); guess = 'Music'
            elif musicish and m.get('source') == 'Deezer': why.append('song-length tracks + found as album'); guess = 'Music'
            elif musicish and not m: why.append(f'{files} song-length tracks, not found as a book')
            if re.search(POD_WORDS, low): why.append('name says podcast'); guess = 'Podcasts'
            if eps >= max(3, files / 2) and not chaps: why.append('episode files'); guess = guess or 'TV Episodes'
        elif c == 'Music':
            if bookish and not re.search(MUSIC_WORDS, low): why.append('chapter-like/long tracks')
            if m.get('source') == 'Audible' and it.get('confidence', 0) >= 85 and not re.search(MUSIC_WORDS, low): why.append('found as audiobook')
            if why and (bookish or m.get('source') == 'Audible'): guess = 'Audiobooks'
            if eps >= 3: why.append('episode files')
        elif c == 'TV Episodes':
            if musicish and not eps: why.append('song-length tracks, no episodes')
            if chaps >= 3: why.append('chapters'); guess = 'Audiobooks'
            if re.search(POD_WORDS, low): why.append('name says podcast'); guess = 'Podcasts'
        elif c == 'Podcasts':
            if chaps >= 3: why.append('chapters'); guess = 'Audiobooks'
            if musicish and not eps: why.append('song-length tracks')
        elif c == 'Movies':
            if files > 3: why.append(f'{files} files')
        elif c in ('Unknown Category', 'Tonies'):
            why.append('review')
        # seasons
        for s, rx in SEASON_WORDS.items():
            if c != s and re.search(rx, low) and c != 'Movies':
                why.append(f'name says {s}'); guess = s
        if c in SEASON_WORDS and not re.search(SEASON_WORDS[c], low + ' ' + ' '.join((m.get('title', ''), blob)).lower()):
            why.append(f'no {c} words')
        if files == 0: why.append('NO AUDIO')
        if why or only == c:
            out.append((c, iid, n, files, mins, round(avg, 1), m.get('source', '-'), it.get('confidence', 0),
                        (m.get('title') or '')[:40], guess, '; '.join(why), names[:4]))
    for o in sorted(out, key=lambda o: (o[0], o[2])):
        c, iid, n, files, mins, avg, src, conf, mt, guess, why, sample = o
        print(f'{c[:5]} {iid} {n[:60]!r} f={files} m={mins} avg={avg} [{src} {conf}: {mt}] -> {guess} ({why}) {sample}')
    print(len(out), 'flagged', file=sys.stderr)

if __name__ == '__main__':
    main()
