"""Covers for items that still have none, taken from the artwork built into their audio files on the drive (ID3
pictures in MP3s, cover art in M4A/M4B/MP4, pictures in FLAC/Ogg). Needs the drive plugged in and a drive scan
(data/drive-scan.json, from scan_drive.py). Read-only on the drive. Rebuilds the catalogue at the end.

    python tools/embedded_covers.py
"""
import base64, io, json, os, sys, zipfile
from concurrent.futures import ThreadPoolExecutor
from PIL import Image
import mutagen
from mutagen.id3 import ID3
from mutagen.mp4 import MP4
from mutagen.flac import FLAC, Picture

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import enrich

def art_from_file(path_or_bytes, name):
    """The biggest picture inside one audio file, as bytes (or None)."""
    try:
        f = mutagen.File(io.BytesIO(path_or_bytes) if isinstance(path_or_bytes, bytes) else path_or_bytes)
    except Exception:
        return None
    if f is None or not f.tags: return None
    pics = []
    try:
        if isinstance(f.tags, ID3) or hasattr(f.tags, 'getall'):
            pics += [p.data for p in f.tags.getall('APIC')]
        if isinstance(f, MP4):
            pics += [bytes(c) for c in f.tags.get('covr', [])]
        if isinstance(f, FLAC):
            pics += [p.data for p in f.pictures]
        for b64 in (f.tags.get('metadata_block_picture', []) if hasattr(f.tags, 'get') else []):
            pics.append(Picture(base64.b64decode(b64)).data)
    except Exception:
        pass
    return max(pics, key=len) if pics else None

def find(entry):
    """Look through the first few audio files of an item for artwork."""
    p = entry['path']
    if p.lower().endswith('.zip'):
        try:
            with zipfile.ZipFile(p) as z:
                for n in entry['audio'][:6]:
                    a = art_from_file(z.read(n), n)
                    if a: return a
        except Exception:
            return None
        return None
    files = [p] if os.path.isfile(p) else [os.path.join(p, a) for a in entry['audio'][:6]]
    for fp in files:
        a = art_from_file(fp, fp)
        if a: return a
    return None

def main():
    cat = json.load(open(os.path.join(enrich.DATA, 'catalog.json'), encoding='utf-8'))['items']
    scan = json.load(open(os.path.join(enrich.DATA, 'drive-scan.json'), encoding='utf-8'))
    todo = [i for i in cat if not i.get('hasCover') and i['id'] in scan and scan[i['id']].get('audio')]
    print(len(todo), 'items without a cover to look inside', flush=True)
    found = 0

    def one(it):
        art = find(scan[it['id']])
        if not art: return None
        try:
            im = Image.open(io.BytesIO(art)).convert('RGB')
        except Exception:
            return None
        if im.width < 100: return None
        im.thumbnail((400, 400), Image.LANCZOS)
        im.save(os.path.join(enrich.DATA, 'covers', it['id'] + '.jpg'), 'JPEG', quality=82, optimize=True)
        cp = os.path.join(enrich.DATA, 'cache', it['id'] + '.json')
        if os.path.exists(cp):
            c = json.load(open(cp, encoding='utf-8')); c['hasCover'] = True
            json.dump(c, open(cp, 'w', encoding='utf-8'), ensure_ascii=False)
        return it['id']

    with ThreadPoolExecutor(6) as ex:
        got = [x for x in ex.map(one, todo) if x]
    # remember drive-art covers in sizes.json too, so a later drive scan keeps them
    sp = os.path.join(enrich.DATA, 'sizes.json'); sizes = json.load(open(sp, encoding='utf-8'))
    for iid in got:
        if iid in sizes: sizes[iid]['cover'] = True
    json.dump(sizes, open(sp, 'w', encoding='utf-8'))
    print(f'found artwork inside the files for {len(got)} of {len(todo)}', flush=True)
    enrich.build_catalog()

if __name__ == '__main__':
    main()
