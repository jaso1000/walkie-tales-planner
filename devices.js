// Talks to each child's WalkieTales player (its own remote API, with its PIN) to see what's on it now, and matches
// the player's folders to items in the catalogue. PINs live only in data/players.json and never leave the server.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

module.exports = function devices(DATA, readJson, loadItems, sources) {
  const PLAYERS = path.join(DATA, 'players.json');   // { kidId: { url, pin } }
  const CACHE = path.join(DATA, 'devices.json');     // last reading of every player
  let busy = null;

  const players = () => readJson(PLAYERS, {});
  const savePlayers = p => {
    fs.writeFileSync(PLAYERS, JSON.stringify(p, null, 1));
    try { fs.chmodSync(PLAYERS, 0o600); } catch { /* not on Windows */ }
  };
  // The last reading of every player. When the catalogue has changed since, its folders are matched again here,
  // so new items show as "on the player" straight away without waking anyone's phone.
  function cache() {
    const out = readJson(CACHE, { updated: null, kids: {} });
    const built = sources.map(f => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }).join('/');
    if (out.matchedTo === built) return out;
    const items = loadItems();
    for (const r of Object.values(out.kids)) if (r.folders) r.matches = matchFolders(r.folders, items);
    out.matchedTo = built;
    try { fs.writeFileSync(CACHE, JSON.stringify(out)); } catch { /* read-only: match again next time */ }
    return out;
  }

  function get(base, pin, p, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const u = new URL(p, base);
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.get(u, { headers: { 'X-Pin': pin }, timeout, rejectUnauthorized: false }, res => {
        const parts = [];
        res.on('data', c => parts.push(c));
        res.on('end', () => {
          if (res.statusCode === 401 || res.statusCode === 403) return reject(new Error('Wrong PIN'));
          if (res.statusCode === 429) return reject(new Error('Locked out for a while after wrong PINs'));
          if (res.statusCode !== 200) return reject(new Error('Player answered ' + res.statusCode));
          try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))); } catch (e) { reject(e); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('No answer (asleep or off Wi-Fi?)')));
      req.on('error', e => reject(e.code === 'ECONNREFUSED' || e.code === 'EHOSTUNREACH' ? new Error('No answer (asleep or off Wi-Fi?)') : e));
    });
  }

  // ------------------------------------------------------------------------------------------- matching

  const norm = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[([]\s*y(\.\w{1,3})?\s*[)\]]/g, ' ').replace(/\.(mp3|m4b|m4a|zip)$/, '')
    .replace(/&/g, ' and ').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const STOP = new Set(['the', 'a', 'an', 'and', 'of', 'to', 'in', 'for', 'on', 'with', 'by', 'audiobook', 'collection', 'episode', 'audio']);
  const toks = t => new Set(norm(t).split(' ').filter(w => w && !STOP.has(w)));
  const nums = s => [...s].filter(w => /^\d+$/.test(w)).sort().join(',');
  function sim(a, b, an, bn) {
    if (!a.size || !b.size) return 0;
    let n = 0;
    for (const w of a) if (b.has(w)) n++;
    let s = n / Math.max(a.size, b.size) * 0.6 + n / Math.min(a.size, b.size) * 0.4;
    if (an !== bn) s *= an && bn ? 0.5 : 0.85; // "Frozen 2" is not "Frozen"; "Books 1-4" is not "Books 1-51"
    return s;
  }
  // the player's own idea of a folder's type, against the collection's
  const KIND = { music: ['music'], audiobook: ['book', 'tonie', 'tv', 'movie'], podcast: ['podcast'], radio: ['radio'] };

  /** Each player folder -> { id, score } of the best catalogue item, or null when nothing fits well. */
  function matchFolders(folders, items) {
    const cands = items.map(it => ({
      id: it.id, kind: it.kind,
      keys: [it.name, it.query, it.match && it.confidence >= 80 && it.match.title].filter(Boolean)
        .map(k => { const t = toks(k); return { n: norm(k), t, d: nums(t) }; }),
    }));
    // folders copied from the plan: the copy tool notes which item each one is ({ "folder name": itemId })
    const links = {}, known = new Set(items.map(it => it.id));
    for (const [k, v] of Object.entries(readJson(path.join(DATA, 'folder-links.json'), {}))) links[k.normalize('NFC')] = v;
    const out = {};
    for (const f of folders) {
      const link = links[f.name.normalize('NFC')]; // iPhones keep accented names decomposed
      if (known.has(link)) { out[f.name] = { id: link, score: 100, linked: true }; continue; }
      const fn = norm(f.name), ft = toks(f.name), fd = nums(ft), kinds = KIND[f.category];
      let best = null, bestScore = 0;
      for (const c of cands) for (const k of c.keys) {
        let s = k.n === fn ? 1 : sim(ft, k.t, fd, k.d);
        // the player's folder name inside a longer collection name ("Frozen - The Songs" in "Disney Music - Frozen The Songs")
        if (s < 0.92 && ft.size >= 2 && k.d === fd && ` ${k.n} `.includes(` ${fn} `)) s = 0.92;
        if (kinds && !kinds.includes(c.kind)) s *= 0.9;
        if ((f.live || f.category === 'radio') !== (c.kind === 'radio')) s *= 0.5; // a station is only ever a station
        if (s > bestScore) { bestScore = s; best = c.id; }
      }
      out[f.name] = bestScore >= 0.8 ? { id: best, score: Math.round(bestScore * 100) } : null;
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------- reading

  async function readOne(p, items) {
    const at = new Date().toISOString();
    try {
      const status = await get(p.url, p.pin, '/api/status');
      const lib = await get(p.url, p.pin, '/api/library', 30000);
      const folders = [];
      for (const f of lib.folders || []) {
        let bytes = 0, files = 0;
        if (!f.live) {
          try {
            const d = await get(p.url, p.pin, '/api/folder?name=' + encodeURIComponent(f.name), 30000);
            for (const x of d.files || []) { bytes += x.size || 0; files++; }
          } catch { /* one folder failing shouldn't stop the rest */ }
        }
        folders.push({ name: f.name, bytes, files, tracks: f.tracks || 0, category: f.category || '', live: !!f.live });
      }
      return {
        ok: true, checked: at, url: p.url,
        status: { version: status.version, model: status.model || '', os: status.os || '', battery: status.battery,
          charging: !!status.charging, freeBytes: status.freeBytes, name: status.name || '' },
        folders, matches: matchFolders(folders, items),
      };
    } catch (e) {
      return { ok: false, checked: at, url: p.url, error: String(e.message || e) };
    }
  }

  async function refresh(onlyKid) {
    if (busy) return busy;
    busy = (async () => {
      const cat = { items: loadItems() };
      const ps = players(), out = cache();
      const ids = Object.keys(ps).filter(k => !onlyKid || k === onlyKid);
      const results = await Promise.all(ids.map(k => readOne(ps[k], cat.items)));
      ids.forEach((k, i) => {
        const r = results[i];
        // a sleeping player keeps its last good reading; the page shows when that was
        out.kids[k] = r.ok ? r : { ...(out.kids[k] || {}), ok: false, error: r.error, failedAt: r.checked, url: r.url };
      });
      for (const k of Object.keys(out.kids)) if (!ps[k]) delete out.kids[k];
      out.updated = new Date().toISOString();
      delete out.matchedTo; // matched just now; cache() notes the catalogue next time
      fs.writeFileSync(CACHE, JSON.stringify(out));
      return out;
    })();
    try { return await busy; } finally { busy = null; }
  }

  // No background reading: the players are only contacted when the page asks (on opening it, if the last reading is
  // old, or "Check the player"), to spare their batteries.

  return {
    cache,
    refresh,
    list: () => Object.fromEntries(Object.entries(players()).map(([k, v]) => [k, { url: v.url, hasPin: !!v.pin }])),
    set(kidId, url, pin) {
      const p = players();
      if (!url) { delete p[kidId]; savePlayers(p); return; }
      if (!/^https?:\/\//.test(url)) url = 'http://' + url;
      if (!/:\d+/.test(url.replace(/^https?:\/\//, ''))) url = url.replace(/\/?$/, ':8480');
      p[kidId] = { url: url.replace(/\/+$/, ''), pin: pin || (p[kidId] && p[kidId].pin) || '' };
      savePlayers(p);
    },
  };
};
