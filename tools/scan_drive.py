"""Measure every catalogue item on the portable drive: real size, number of audio files, and any cover art stored
with it. Writes data/sizes.json and rebuilds data/catalog.json. Read-only on the drive.

    python tools/scan_drive.py E:\\            # the folder the "From" paths in collection.csv start from
"""
import csv, io, json, os, sys, zipfile
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import enrich

AUDIO = {'.mp3', '.m4a', '.m4b', '.aac', '.ogg', '.opus', '.flac', '.wav'}
IMAGES = ('.jpg', '.jpeg', '.png', '.webp')

def find_root(start, rows):
    """The folder the 'From' paths start from: the drive root, or one level down."""
    tops = {r['From'].split('\\')[0] for r in rows if r['From']}
    def ok(d): return any(os.path.isdir(os.path.join(d, t)) for t in tops)
    if ok(start): return start
    for d in os.listdir(start):
        p = os.path.join(start, d)
        if os.path.isdir(p) and ok(p): return p
    return start

def measure(path):
    """bytes, audio file count, best cover image (bytes) for a folder, a single file or a zip."""
    if os.path.isfile(path):
        size = os.path.getsize(path)
        if path.lower().endswith('.zip'):
            try:
                with zipfile.ZipFile(path) as z:
                    names = z.namelist()
                    audio = [n for n in names if os.path.splitext(n)[1].lower() in AUDIO]
                    imgs = sorted((n for n in names if n.lower().endswith(IMAGES)), key=lambda n: (not os.path.basename(n).lower().startswith(('cover', 'folder')), -z.getinfo(n).file_size))
                    return size, len(audio), z.read(imgs[0]) if imgs else None
            except Exception:
                return size, 0, None
        return size, 1 if os.path.splitext(path)[1].lower() in AUDIO else 0, None
    size = files = 0
    imgs = []
    for dirpath, _, names in os.walk(path):
        for n in names:
            p = os.path.join(dirpath, n)
            try: s = os.path.getsize(p)
            except OSError: continue
            size += s
            ext = os.path.splitext(n)[1].lower()
            if ext in AUDIO: files += 1
            elif ext in IMAGES: imgs.append((not n.lower().startswith(('cover', 'folder')), -s, p))
    cover = open(sorted(imgs)[0][2], 'rb').read() if imgs else None
    return size, files, cover

def locate(root, row):
    base = os.path.join(root, *row['From'].split('\\'))
    name = row['Name']
    for cand in (name, name + '.zip', name + '.mp3', name + '.m4b'):
        p = os.path.join(base, cand)
        if os.path.exists(p): return p
    return None

def main():
    if len(sys.argv) < 2: sys.exit(__doc__)
    rows = list(csv.DictReader(open(os.path.join(enrich.DATA, 'collection.csv'), encoding='utf-8-sig')))
    root = find_root(sys.argv[1], rows)
    sizes, missing = {}, []
    cache = os.path.join(enrich.DATA, 'cache')
    for i, row in enumerate(rows, 1):
        iid = enrich.item_id(row)
        p = locate(root, row)
        if not p: missing.append(row['Name']); continue
        size, files, cover = measure(p)
        entry = {'bytes': size, 'files': files}
        cpath = os.path.join(enrich.DATA, 'covers', iid + '.jpg')
        item = json.load(open(os.path.join(cache, iid + '.json'), encoding='utf-8')) if os.path.exists(os.path.join(cache, iid + '.json')) else {}
        # The drive's own art wins when the online match is missing or unsure.
        if cover and (not os.path.exists(cpath) or item.get('confidence', 0) < 80):
            try:
                im = Image.open(io.BytesIO(cover)).convert('RGB')
                if im.width >= 100:
                    im.thumbnail((400, 400), Image.LANCZOS)
                    im.save(cpath, 'JPEG', quality=82, optimize=True)
                    entry['cover'] = True
                    if item: item['hasCover'] = True; json.dump(item, open(os.path.join(cache, iid + '.json'), 'w', encoding='utf-8'), ensure_ascii=False)
            except Exception:
                pass
        sizes[iid] = entry
        if i % 100 == 0: print(f'{i}/{len(rows)}', flush=True)
    json.dump(sizes, open(os.path.join(enrich.DATA, 'sizes.json'), 'w', encoding='utf-8'))
    total = sum(s['bytes'] for s in sizes.values())
    print(f'measured {len(sizes)} items, {total / 1e9:.1f} GB in all; {len(missing)} not found on the drive')
    if missing: open(os.path.join(enrich.DATA, 'missing-on-drive.txt'), 'w', encoding='utf-8').write('\n'.join(missing))
    enrich.build_catalog(rows)

if __name__ == '__main__':
    main()
