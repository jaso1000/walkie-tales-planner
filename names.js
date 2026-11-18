// Tidy track names for the players. One copy of these rules lives here (the planner's "Sync to player") and one in
// the WalkieTales remote page (companion/web/index.html, "Tidy names"): keep the two the same.
// Written without look-behind, so the remote page still runs on older iPhones.
(function (root) {
  const GENERIC = new Set(['audio', 'audio files', 'audio_files', 'mp3', 'mp3s', 'files', 'tracks', 'music', 'songs']);
  const key = (s) => String(s || '').toLowerCase().replace(/’/g, "'").replace(/[^a-z0-9]/g, '');
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function strip(s, chars) {
    let a = 0, b = s.length;
    while (a < b && chars.includes(s[a])) a++;
    while (b > a && chars.includes(s[b - 1])) b--;
    return s.slice(a, b);
  }
  const EMOJI = /[\u{1F000}-\u{1FAFF}☀-➿️‍]/gu;

  // One name, on its own: download junk, codes, run-together words, characters Android won't take.
  function tidy(s, label) {
    s = String(s).replace(/\.(mp3|m4a|m4b|zip|wav)$/i, '');
    s = s.replace(EMOJI, ' ').replace(/ΓÇÖ/g, '’').replace(/ΓÇô/g, '–');
    s = s.replace(/^\s*\[[^\]]*\]\s*/, '');                                   // leading [Channel name]
    s = s.replace(/\s\d{9,}\b/g, '');                                          // barcodes
    s = s.replace(/\[\s*[\w.-]+\.(cc|com|net|org|io)\s*\]|\(spotisaver\)|#fullepisode|\(unabridged\)/gi, ' ');
    s = s.replace(/\s+[｜|]\s+.*$/, '');                                       // YouTube-style "Title | Channel"
    s = s.replace(/\s*-\s*full episodes?\b.*$/i, '');
    s = s.replace(/([A-Za-z])_(?=s\b)/g, "$1'");                               // Gershwin_s -> Gershwin's
    s = s.replace(/([!?A-Za-z0-9])_ /g, '$1 - ');                              // "Ariel_ The Endless" -> "Ariel - The Endless"
    s = s.split('_-_').join(' - ').replace(/_/g, ' ');
    s = s.replace(/[([]\s*y(\.\w+)?\s*[)\]]/gi, '');                           // (Y) [Y] (Y.us)
    s = s.replace(/\[(B0[A-Z0-9]{8}|\d{9,10}[0-9X]?)\]/gi, '');                // Audible / ISBN codes
    s = s.replace(/\((digital|deluxe|us|anz)\)/gi, '');
    s = s.replace(/\s*\(?spotify (music )?playlist( by [^)]*)?\)?/gi, '');
    s = s.replace(/-?\d{8}T\d{6}Z(-\d+)*/g, '');                               // Google Drive download stamps
    s = s.replace(/^yoto\s*[—–-]\s*/i, '').replace(/^(music|disney music)\s*-\s*/i, '');
    s = s.replace(/_1_\d+$|\s1\s\d+$/, '');
    const humps = (s.match(/[a-z][A-Z]/g) || []).length;                      // CamelCase file names
    if (!s.trim().includes(' ') && humps)
      s = s.replace(/([a-z])(?=[A-Z])|([A-Z])(?=[A-Z][a-z])|([A-Za-z])(?=\d)/g, (m, a, b, c) => (a || b || c) + ' ');
    s = s.replace(/：/g, ':').replace(/:/g, ' -').replace(/[/\\]/g, '-').replace(/？/g, '?').replace(/®/g, '');
    s = s.replace(/[?*"<>|]/g, '');                                            // not allowed in Android file names
    return strip(s.replace(/\s+/g, ' '), ' -–—.');
  }

  const NUM = /^\s*(?:disc|cd|part|track)?\s*\d{1,4}[a-z]?(?:[-.]\d{1,3})?(?:\s*[-._)]\s*|\s+)(?=\S)/i;
  function stripNum(s) {
    let m = s.match(NUM);
    if (m) s = s.slice(m[0].length);
    if (/^\d{1,3}\s*(?:[.)]|\s-)\s*\S|^(track|disc|cd)\s*\d/i.test(s)) { m = s.match(NUM); if (m) s = s.slice(m[0].length); } // "01 - 1. Is This Love", not "12 2 Bad"
    return s;
  }

  const JUNK = [
    '\\[[A-Za-z0-9 _-]{11}\\]',                                                 // YouTube video id
    'wildbrain( full episodes| movies| cartoons)? for kids',
    '\\[?\\(?full episodes?\\)?\\]?', '⭐', '(\\s+[#@][A-Za-z]\\w*)+\\s*$', '^(\\s*#[A-Za-z]\\w*)+', '\\[?please subscribe.*$',
    'kidz bop kids kidz bop \\d+', '\\bnetflix( jr)?$',
    '-\\s*APLMate\\.com', 'SpotiDownloader\\.com\\s*-', '\\bofficial (music )?video\\b', '\\bofficial animation\\b',
    '\\[?\\(?official audio\\)?\\]?', '\\[official video\\]', '\\(lyrics\\)', '\\blyric video\\b', '\\baudio only\\b',
    '\\bmusic video\\b', '\\(hd-?\\d*\\)', '-hd$', '\\bhq\\b', '\\(visualizer\\)', '\\bmovieclips\\b',
    'cartoons for kids', 'kids tv shows', 'educational songs for kids', '(christian |dance )?songs for kids!?$',
    '(&\\s*)?kids songs', 'best( \\d{4})? kid songs( \\d{4})?', '\\babc kids$',
    '\\bfun family activity with books about animals\\b', '\\bread aloud\\b(?= -|$)', '\\s-\\s*bob the builder season \\d+',
  ].map((j) => new RegExp('\\s*' + j, 'gi'));

  // A name in its folder: junk, stray track numbers, "Unofficial" blurbs, and the folder's own title said again.
  function clean(n, titles) {
    n = n.split(' ¦ ').join(' - ').replace(/¦/g, ' ');
    for (const rx of JUNK) n = n.replace(rx, ' ');
    n = n.replace(/(^|[^\w])[#@](?=[A-Za-z])/g, '$1');                         // "#dinosaur Adventures" -> "dinosaur Adventures"
    n = n.replace(/\s+\)/g, ')').replace(/\s\d{9,}\b/g, '');
    n = n.replace(/\s-\s\d{1,3}\s-\s/g, ' - ').replace(/\s-\s\d{1,3}\s-\s/g, ' - '); // "Book 4 - 01 - Opening Credits"
    let parts = n.split(/\s+-\s+/).filter((p) => !/\bunofficial\b/i.test(p));
    n = (parts.length ? parts : [n]).join(' - ');
    n = n.replace(/\s*\((diary of nate[^)]*|an unofficial[^)]*|unofficial[^)]*)\)/gi, '');
    const seen = new Set(), segs = [];
    for (const p of n.split(/\s+-\s+/)) {                                      // the same part twice
      const k = key(p);
      if (k && seen.has(k)) continue;
      seen.add(k); segs.push(p);
    }
    n = strip(segs.join(' - ').replace(/\s+/g, ' '), ' -–—.,&[(');
    for (const t of titles) {
      const words = t.split(/\s+/).length, lo = n.toLowerCase(), tl = t.toLowerCase();
      if (t.length < 5) continue;
      if (lo.startsWith(tl + ' - ') && n.length > t.length + 3 && (words >= 2 || t === titles[0])) n = n.slice(t.length + 3);
      else if (lo.endsWith(' - ' + tl) && words >= 2) n = n.slice(0, -t.length - 3);
      else if (lo.endsWith(' ' + tl) && words >= 3 && n.length > t.length + 3) n = n.slice(0, -t.length);
    }
    if (/^\s*track\s*\d+\s*$/i.test(n)) n = '';
    n = n.replace(/\(\s*\)|\[\s*\]/g, '').replace(/(\s*-\s*){2,}/g, ' - ');
    return strip(n.replace(/\s+/g, ' '), ' -–—.,&[(');
  }

  // A sub-folder's name, as the book it holds: "PAU_974116 BackToSleep" -> "Back To Sleep".
  function tidyLabel(s) {
    s = s.trim().replace(/^[A-Z]{3}[\s_]\d{5,8}\s+/, '');
    const m = s.match(/^book\s*(\d+)\s+(\S+)\s*$/i);
    if (m) s = 'Book ' + m[1] + ' - ' + tidy(m[2], true);
    s = s.trim().replace(/_$/, '');
    if (/^\d+storey/i.test(s)) return tidy(s, true);
    return tidy(stripNum(s), true) || tidy(s, true);
  }

  function titlesFor(folder) {
    const t = [folder, folder.replace(/\s*\([^)]*\)\s*$/, ''), folder.split(' - ')[0]].map((x) => x.trim()).filter(Boolean);
    return [...new Set(t)].sort((a, b) => b.length - a.length);
  }

  function commonPrefix(names) {
    if (names.length < 2) return '';
    let p = names[0];
    for (const n of names) while (!n.startsWith(p)) p = p.slice(0, -1);
    const cut = p.lastIndexOf(' - ');
    return cut >= 6 ? p.slice(0, cut + 3) : '';
  }

  function mostCommon(list) {
    const c = new Map();
    for (const x of list) if (x) c.set(x, (c.get(x) || 0) + 1);
    let best = null, n = 0;
    for (const [k, v] of c) if (v > n) { best = k; n = v; }
    return [best, n];
  }

  /**
   * Names for the files of one folder, in play order. bases: the file names without their extension; folder: the
   * folder's name on the player; labels (optional): the book each file belongs to, from the drive's sub-folders;
   * music: true for songs (two songs called the same are two recordings, not two parts).
   * Returns names without a number or extension: "Back To Sleep - Part 1", "Captain America - Chapter 1".
   */
  function names(bases, folder, labels, music) {
    const n0 = bases.length;
    const numbered = bases.filter((b) => /^\s*\d/.test(b)).length >= 0.6 * n0;
    let out = bases.map((b) => tidy(numbered ? stripNum(b) : b));
    const pre = commonPrefix(out);                                             // "Book Name - 02 - Chapter 1"
    if (pre) out = out.map((n) => stripNum(n.slice(pre.length)) || n);
    const heads = out.map((n) => n.includes(' - ') ? n.split(' - ')[0].split(',')[0].trim() : '');
    const [lead, leadN] = mostCommon(heads);                                   // the same artist in front of most songs
    if (out.length > 2 && lead && lead.length >= 3 && leadN >= 0.7 * out.length)
      out = out.map((n, i) => heads[i] === lead ? n.slice(n.indexOf(' - ') + 3) : n);
    out = out.map((n) => n.replace(/(\s*-)+\s*(\d{4}\s+)?(digital(ly)?\s+)?remaster(ed)?(\s+\d{4})?(\s+version)?\s*$/i, ''));
    const br = new Map();                                                      // a bracket on almost every song
    for (const n of out) for (const b of new Set(n.match(/\([^()]*\)/g) || [])) { const k = b.replace(/’/g, "'").toLowerCase(); br.set(k, (br.get(k) || 0) + 1); }
    for (const [b, c] of br) if (out.length > 3 && c >= 0.7 * out.length) {
      const rx = new RegExp('\\s*' + esc(b).replace(/'/g, "['’]"), 'gi');
      out = out.map((n) => n.replace(rx, '').trim() || n);
    }
    const titles = folder ? titlesFor(folder) : [];
    out = out.map((n) => clean(n, titles));
    out = out.map((n) => /\s*\(1\)$/.test(n) && !out.some((m) => m === n.replace(/\s*\(1\)$/, ' (2)') || m === n.replace(/\s*\(1\)$/, '(2)')) ? n.replace(/\s*\(1\)$/, '') : n);
    let lab = (labels || bases.map(() => '')).slice();
    if (new Set(lab).size === 1) lab = lab.map(() => '');
    const tkeys = new Set(titles.map(key));
    const groups = new Map();
    lab.forEach((l, k) => { if (!groups.has(l)) groups.set(l, []); groups.get(l).push(k); });
    for (const [l, ks] of groups) {
      const kl = key(l), cnt = new Map();
      for (const k of ks) { const kn = key(out[k]); cnt.set(kn, (cnt.get(kn) || 0) + 1); }
      const mostlySame = cnt.size <= 0.3 * ks.length, seen = new Map(), gk = ks.map((k) => key(out[k]));
      ks.forEach((k, gi) => {
        const n = out[k], kn = key(n);
        const inLabel = kn.length >= 6 && kl.includes(kn);
        const empty = !kn || kn === kl || tkeys.has(kn) || inLabel;
        const beside = !music && ((gi > 0 && gk[gi - 1] === kn) || (gi + 1 < ks.length && gk[gi + 1] === kn)); // parts of one book in a row
        if (!kn) out[k] = l && ks.length === 1 ? '' : 'Part ' + ((l ? gi : k) + 1);
        else if (cnt.get(kn) > 1 && (empty || mostlySame || beside)) {
          seen.set(kn, (seen.get(kn) || 0) + 1);
          out[k] = empty ? 'Part ' + (l ? seen.get(kn) : k + 1) : n + ' - Part ' + seen.get(kn);
        } else if (l && (kn === kl || inLabel)) out[k] = '';
      });
    }
    if (!lab.some(Boolean)) {                                                  // every track called the same
      const plain = out.filter(Boolean);
      if (n0 > 1 && ((new Set(plain).size <= 1 && plain.length === out.length && !/^Part \d+$/.test(plain[0] || '')) || plain.every((n) => /^\d+$/.test(n))))
        out = out.map((_, i) => 'Part ' + (i + 1));
    }
    return out.map((name, i) => {
      const l = lab[i];
      if (l) {                                                                 // drop what the book's name already says
        const kl = key(l), segs = name ? name.split(/\s+-\s+/) : [];
        while (segs.length > 1 && key(segs[0]) && (kl.includes(key(segs[0])) || kl.endsWith(key(segs[0])))) segs.shift();
        name = segs.join(' - ');
        if (!key(name).includes(kl)) name = name ? l + ' - ' + name : l;
      }
      name = (name || 'Part ' + (i + 1)).replace(/\b(\d+)[- ]?storey\b/gi, '$1-Storey');
      return strip(name.slice(0, 110), ' -');
    });
  }

  /** The book a file belongs to, from its path inside the item's folder (["Book 2", "audio_files", "03.m4a"]). */
  function labelOf(parts) {
    const good = parts.slice(0, -1).filter((d) => !GENERIC.has(d.toLowerCase().replace(/_/g, ' ')));
    return good.length ? tidyLabel(good[good.length - 1]) : '';
  }

  const api = { tidy, stripNum, names, labelOf, key };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.WTNames = api;
})(typeof window !== 'undefined' ? window : this);
