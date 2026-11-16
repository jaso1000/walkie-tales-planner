"""Measure every catalogue item on the portable drive: real size, number of audio files, play time, the
audio file names (to check each item is filed in the right category) and any cover art stored with it.
Writes data/sizes.json (+ data/drive-scan.json with the file names) and rebuilds data/catalog.json.
Read-only on the drive.

    python tools/scan_drive.py "E:\\Kids Audio"     # a folder holding <Category>\\<Name>, or the root
                                                     # the "From" paths in collection.csv start from
"""
import csv, io, json, os, sys, zipfile
from concurrent.futures import ThreadPoolExecutor
from PIL import Image
try:
    import mutagen  # optional: play time
except ImportError:
    mutagen = None

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import enrich

AUDIO = {'.mp3', '.m4a', '.m4b', '.mp4', '.aac', '.ogg', '.opus', '.flac', '.wav'}
IMAGES = ('.jpg', '.jpeg', '.png', '.webp')

def find_root(start, rows):
    """The folder the items live under: <root>\\<Category>\\<Name>, or <root>\\<From>\\<Name>."""
    def ok(d): return sum(os.path.exists(os.path.join(d, r['Category'], r['Name'])) for r in rows[:50]) > 25 or \
                      any(os.path.isdir(os.path.join(d, r['From'].split('\\')[0])) for r in rows[:50] if r['From'])
    if ok(start): return start
    for d in os.listdir(start):
        p = os.path.join(start, d)
        if os.path.isdir(p) and ok(p): return p
    return start

def seconds(path):
    if not mutagen: return 0
    try:
        a = mutagen.File(path)
        return a.info.length if a and a.info else 0
    except Exception:
        return 0

def measure(path):
    """bytes, audio file names, seconds, best cover image (bytes) for a folder, a single file or a zip."""
    if os.path.isfile(path):
        size = os.path.getsize(path)
        if path.lower().endswith('.zip'):
            try:
                with zipfile.ZipFile(path) as z:
                    names = z.namelist()
                    audio = [n for n in names if os.path.splitext(n)[1].lower() in AUDIO]
                    imgs = sorted((n for n in names if n.lower().endswith(IMAGES)), key=lambda n: (not os.path.basename(n).lower().startswith(('cover', 'folder')), -z.getinfo(n).file_size))
                    return size, audio, 0, z.read(imgs[0]) if imgs else None
            except Exception:
                return size, [], 0, None
        audio = os.path.splitext(path)[1].lower() in AUDIO
        return size, [os.path.basename(path)] if audio else [], seconds(path) if audio else 0, None
    size, secs, audio, imgs = 0, 0.0, [], []
    for dirpath, _, names in os.walk(path):
        for n in names:
            p = os.path.join(dirpath, n)
            try: s = os.path.getsize(p)
            except OSError: continue
            size += s
            ext = os.path.splitext(n)[1].lower()
            if ext in AUDIO:
                audio.append(os.path.relpath(p, path))
                secs += seconds(p)
            elif ext in IMAGES: imgs.append((not n.lower().startswith(('cover', 'folder')), -s, p))
    cover = open(sorted(imgs)[0][2], 'rb').read() if imgs else None
    return size, sorted(audio), secs, cover

def locate(root, row):
    name = row['Name']
    for base in (os.path.join(root, row['Category']), os.path.join(root, *row['From'].split('\\'))):
        for cand in (name, name + '.zip', name + '.mp3', name + '.m4b'):
            p = os.path.join(base, cand)
            if os.path.exists(p): return p
    return None

def main():
    if len(sys.argv) < 2: sys.exit(__doc__)
    rows = list(csv.DictReader(open(os.path.join(enrich.DATA, 'collection.csv'), encoding='utf-8-sig')))
    root = find_root(sys.argv[1], rows)
    print('items are under', root, flush=True)
    cache = os.path.join(enrich.DATA, 'cache')
    sizes, scan, missing, done = {}, {}, [], 0

    def one(row):
        iid = enrich.item_id(row)
        p = locate(root, row)
        if not p: return iid, None
        size, audio, secs, cover = measure(p)
        entry = {'bytes': size, 'files': len(audio)}
        if secs: entry['minutes'] = round(secs / 60)
        cpath = os.path.join(enrich.DATA, 'covers', iid + '.jpg')
        cp = os.path.join(cache, iid + '.json')
        item = json.load(open(cp, encoding='utf-8')) if os.path.exists(cp) else {}
        # The drive's own art wins when the online match is missing or unsure.
        if cover and (not os.path.exists(cpath) or item.get('confidence', 0) < 80):
            try:
                im = Image.open(io.BytesIO(cover)).convert('RGB')
                if im.width >= 100:
                    im.thumbnail((400, 400), Image.LANCZOS)
                    im.save(cpath, 'JPEG', quality=82, optimize=True)
                    entry['cover'] = True
                    if item: item['hasCover'] = True; json.dump(item, open(cp, 'w', encoding='utf-8'), ensure_ascii=False)
            except Exception:
                pass
        return iid, (entry, {'path': p, 'audio': audio[:60], 'count': len(audio)})

    with ThreadPoolExecutor(6) as ex:
        for row, (iid, res) in zip(rows, ex.map(one, rows)):
            done += 1
            if res is None: missing.append(row['Name'])
            else: sizes[iid], scan[iid] = res
            if done % 100 == 0: print(f'{done}/{len(rows)}', flush=True)
    json.dump(sizes, open(os.path.join(enrich.DATA, 'sizes.json'), 'w', encoding='utf-8'))
    json.dump(scan, open(os.path.join(enrich.DATA, 'drive-scan.json'), 'w', encoding='utf-8'), ensure_ascii=False)
    # where the items sit, relative to the drive itself, for the export's pathOnDrive
    folder = os.path.relpath(root, os.path.splitdrive(os.path.abspath(root))[0] + os.sep)
    json.dump({'folder': '' if folder == '.' else folder}, open(os.path.join(enrich.DATA, 'drive.json'), 'w', encoding='utf-8'))
    total = sum(s['bytes'] for s in sizes.values())
    print(f'measured {len(sizes)} items, {total / 1e9:.1f} GB in all; {len(missing)} not found on the drive')
    if missing: open(os.path.join(enrich.DATA, 'missing-on-drive.txt'), 'w', encoding='utf-8').write('\n'.join(missing))
    enrich.build_catalog(rows)

if __name__ == '__main__':
    main()
