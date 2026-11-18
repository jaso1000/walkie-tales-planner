// "Sync to player": make a child's player match the plan. Removes what's on the player but no longer planned,
// copies what's planned but missing from the drive (tidy folder and track names, the planner's cover, the type),
// adds planned radio stations, and turns on the planned favourites. Sleep Sounds and Messages are never touched.
//
// Copying needs the drive: DRIVE_DIR is the folder the exports' pathOnDrive starts from (the drive itself, "D:\"
// on Windows, or where it's mounted). Without it, removals, stations and favourites still happen and the page
// says what couldn't be copied.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const names = require('./names');
const albumTrack = require('./tags');

const AUDIO = /\.(mp3|m4a|m4b|mp4|aac|ogg|opus|flac|wav)$/i;
const MARGIN = 600e6; // room left on a player after each copy
const KEEP = ['Sleep Sounds', 'Messages'];

module.exports = function sync({ DATA, readJson, catalog, loadPlan, devices, details }) {
  const DRIVE = process.env.DRIVE_DIR || '';
  const LINKS = path.join(DATA, 'folder-links.json');
  const jobs = {}; // kidId -> the running or last job

  // ---------------------------------------------------------------------------------------- the player's API

  function call(p, method, apiPath, { json, file, timeout = 60000 } = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(apiPath, p.url);
      const headers = { 'X-Pin': p.pin };
      let data = null;
      if (json !== undefined) { data = Buffer.from(JSON.stringify(json)); headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
      if (file) headers['Content-Length'] = fs.statSync(file).size;
      const req = (u.protocol === 'https:' ? https : http).request(u, { method, headers, timeout, rejectUnauthorized: false }, res => {
        const parts = [];
        res.on('data', c => parts.push(c));
        res.on('end', () => {
          let j = {};
          try { j = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); } catch { /* not JSON */ }
          if (res.statusCode === 200) return resolve(j);
          const e = new Error(j.error || 'Player answered ' + res.statusCode); e.status = res.statusCode; reject(e);
        });
      });
      req.on('timeout', () => req.destroy(new Error('No answer (asleep or off Wi-Fi?)')));
      req.on('error', reject);
      if (file) fs.createReadStream(file).on('error', e => req.destroy(e)).pipe(req);
      else req.end(data);
    });
  }
  async function retry(fn, tries = 4) {
    for (let i = 1; ; i++) {
      try { return await fn(); } catch (e) {
        if (i >= tries || e.status === 401 || e.status === 400) throw e;
        await new Promise(r => setTimeout(r, i * 5000)); // a busy or sleepy player: give it a moment
      }
    }
  }

  // ---------------------------------------------------------------------------------------- the drive

  const natKey = s => s.toLowerCase().split(/(\d+)/).map((t, i) => i % 2 ? t.padStart(12, '0') : t).join('');
  const natCmp = (a, b) => { const x = natKey(a), y = natKey(b); return x < y ? -1 : x > y ? 1 : 0; };
  const source = it => {
    if (!DRIVE || !it.pathOnDrive) return null;
    const p = path.join(DRIVE, ...it.pathOnDrive.split('\\'));
    for (const c of [p, p + '.mp3', p + '.m4b', p + '.m4a']) if (fs.existsSync(c)) return c;
    return null;
  };

  /** The files of one item in play order, with their names on the player: [{ src, name, bytes }]. */
  function tracks(src, folder, music) {
    if (fs.statSync(src).isFile()) return [{ src, name: '001 ' + names.tidy(path.basename(src)) + path.extname(src).toLowerCase(), bytes: fs.statSync(src).size }];
    const files = [];
    (function walk(d, rel) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        if (e.isDirectory()) walk(path.join(d, e.name), rel.concat(e.name));
        else if (AUDIO.test(e.name)) files.push(rel.concat(e.name));
      }
    })(src, []);
    files.sort((a, b) => { for (let i = 0; i < Math.min(a.length, b.length); i++) { const c = natCmp(a[i], b[i]); if (c) return c; } return a.length - b.length; });
    let parts = files.map(f => f.slice());
    while (parts.length && parts.every(p => p.length > 1) && new Set(parts.map(p => p[0])).size === 1) parts = parts.map(p => p.slice(1));
    let order = files.map((_, i) => i);
    if (files.length > 2 && parts.every(p => p.length === 1)) { // one album, every song numbered in its tags: the album's order
      const tn = files.map(f => albumTrack(path.join(src, ...f)));
      if (tn.every(Boolean) && new Set(tn.map(t => t.album)).size === 1 && new Set(tn.map(t => t.track)).size === tn.length)
        order.sort((a, b) => tn[a].track - tn[b].track);
    }
    const fl = order.map(i => files[i]), pl = order.map(i => parts[i]);
    const nice = names.names(pl.map(p => p[p.length - 1].replace(/\.[^.]+$/, '')), folder, pl.map(names.labelOf), music);
    const w = Math.max(3, String(fl.length).length);
    return fl.map((f, i) => {
      const s = path.join(src, ...f);
      return { src: s, name: String(i + 1).padStart(w, '0') + ' ' + nice[i] + path.extname(s).toLowerCase(), bytes: fs.statSync(s).size };
    });
  }

  /** The folder name on the player: the one it already has on another player, a hand-picked one, or tidied. */
  function folderName(it) {
    for (const [f, id] of Object.entries(readJson(LINKS, {}))) if (id === it.id) return f;
    const o = readJson(path.join(DATA, 'folder-names.json'), {}); // { byId: {}, byName: {} }: hand-picked names
    if ((o.byId || {})[it.id]) return o.byId[it.id];
    const n = names.tidy(it.nameOnDrive);
    return ((o.byName || {})[n] || n).replace(/^Christmas - /, '');
  }

  function link(folder, id) {
    const l = readJson(LINKS, {});
    if (l[folder] === id) return;
    l[folder] = id;
    fs.writeFileSync(LINKS + '.tmp', JSON.stringify(l, null, 1));
    fs.renameSync(LINKS + '.tmp', LINKS);
  }

  // ---------------------------------------------------------------------------------------- what to do

  /** What syncing would do for one child, from the player's last reading. */
  function preview(kid) {
    const plan = loadPlan(), byId = new Map(catalog().items.map(i => [i.id, i]));
    const reading = devices.cache().kids[kid];
    if (!reading || !reading.folders) return { error: "The player hasn't been read yet. Tap Check the player first." };
    const want = new Set(Object.keys(plan.assign).filter(id => plan.assign[id].includes(kid) && byId.has(id)));
    const fav = new Set(Object.keys(plan.fav || {}).filter(id => plan.fav[id].includes(kid) && want.has(id)));
    const on = {}; // item id -> folders on the player
    for (const [f, m] of Object.entries(reading.matches || {})) if (m && m.id) (on[m.id] = on[m.id] || []).push(f);
    const sizeOf = new Map(reading.folders.map(f => [f.name, f.bytes]));
    const add = [], stations = [], remove = [];
    for (const id of want) {
      if (on[id]) continue;
      const it = details(byId.get(id));
      if (it.type === 'radio') { stations.push({ id, name: it.nameOnDrive, url: it.streamUrl }); continue; }
      const src = source(it);
      add.push({ id, name: it.title || it.nameOnDrive, folder: folderName(it), bytes: +it.bytes || 0,
        why: src ? '' : !DRIVE ? 'the drive isn’t connected to the planner' : !it.pathOnDrive ? 'not on the drive' : 'not found on the drive' });
    }
    for (const [id, fs_] of Object.entries(on)) if (!want.has(id)) for (const f of fs_) if (!KEEP.includes(f))
      remove.push({ id, folder: f, name: (byId.get(id) || {}).name || f, bytes: sizeOf.get(f) || 0 });
    const favourites = [...fav].map(id => (on[id] || [])[0] || (add.find(a => a.id === id) || {}).folder).filter(Boolean);
    const copyable = add.filter(a => !a.why);
    return {
      kid, checked: reading.checked, readOk: reading.ok, drive: !!DRIVE, freeBytes: (reading.status || {}).freeBytes || 0,
      add, stations, remove, favourites,
      addBytes: copyable.reduce((s, a) => s + a.bytes, 0), removeBytes: remove.reduce((s, r) => s + r.bytes, 0),
    };
  }

  // ---------------------------------------------------------------------------------------- doing it

  async function run(job) {
    const say = (t, kind = 'ok') => { job.log.push({ t, kind, at: new Date().toISOString() }); if (job.log.length > 400) job.log.shift(); };
    const p = devices.player(job.kid);
    try {
      if (!p || !p.url) throw new Error('No player linked for this child');
      job.step = 'Reading the player';
      const r = (await devices.refresh(job.kid)).kids[job.kid];
      if (!r || !r.ok) throw new Error('Couldn’t reach the player' + (r && r.error ? ': ' + r.error : ''));
      const w = preview(job.kid);
      if (w.error) throw new Error(w.error);
      const copy = w.add.filter(a => !a.why);
      job.total = w.remove.length + w.stations.length + copy.length + w.favourites.length;
      job.bytesTotal = w.addBytes;
      for (const a of w.add.filter(a => a.why)) say(`Can’t copy ${a.name}: ${a.why}`, 'warn');

      for (const x of w.remove) { // first, so the copies have room
        if (job.stop) break;
        job.step = 'Removing'; job.current = x.folder;
        try {
          await retry(() => call(p, 'POST', '/api/folder/delete', { json: { folder: x.folder }, timeout: 120000 }));
          say(`Removed ${x.folder}`);
        } catch (e) {
          // an older player gives up answering after 8 seconds but still finishes a big delete
          say(/null|busy/i.test(e.message) ? `Removing ${x.folder} (the player is still finishing it)` : `Couldn’t remove ${x.folder}: ${e.message}`, /null|busy/i.test(e.message) ? 'ok' : 'bad');
          if (!/null|busy/i.test(e.message)) job.errors++;
        }
        job.done++;
      }
      for (const s of w.stations) {
        if (job.stop) break;
        job.step = 'Adding radio stations'; job.current = s.name;
        try { await retry(() => call(p, 'POST', '/api/station', { json: { name: s.name, folder: s.name, url: s.url } })); say(`Added the station ${s.name}`); }
        catch (e) { say(`Couldn’t add ${s.name}: ${e.message}`, 'bad'); job.errors++; }
        job.done++;
      }
      const byId = new Map(catalog().items.map(i => [i.id, i]));
      for (const a of copy) {
        if (job.stop) break;
        job.step = 'Copying'; job.current = a.folder;
        try {
          const it = details(byId.get(a.id));
          const list = tracks(source(it), a.folder, it.type === 'music');
          let have = {};
          try { for (const f of (await call(p, 'GET', '/api/folder?name=' + encodeURIComponent(a.folder))).files || []) have[f.name.normalize('NFC')] = f.size; } catch { /* not there yet */ }
          const left = list.filter(t => have[t.name.normalize('NFC')] !== t.bytes);
          const need = left.reduce((s, t) => s + t.bytes, 0);
          const free = (await retry(() => call(p, 'GET', '/api/status'))).freeBytes || 0;
          if (need + MARGIN > free) { say(`No room for ${a.folder} (${(need / 1e9).toFixed(2)} GB, ${(free / 1e9).toFixed(2)} GB free)`, 'warn'); job.noRoom++; job.done++; continue; }
          job.bytesDone += a.bytes - need; // already there
          for (const t of left) {
            if (job.stop) break;
            job.file = t.name;
            await retry(() => call(p, 'PUT', '/api/upload?folder=' + encodeURIComponent(a.folder) + '&name=' + encodeURIComponent(t.name), { file: t.src, timeout: 300000 }));
            job.bytesDone += t.bytes;
          }
          if (job.stop) break;
          const cover = path.join(DATA, 'covers', a.id + '.jpg');
          if (fs.existsSync(cover) && have['cover.jpg'] === undefined) await retry(() => call(p, 'PUT', '/api/upload?folder=' + encodeURIComponent(a.folder) + '&name=cover.jpg', { file: cover }));
          await retry(() => call(p, 'POST', '/api/folder/category', { json: { folder: a.folder, category: it.type === 'music' ? 'music' : it.type === 'podcast' ? 'podcast' : 'audiobook' } }));
          link(a.folder, a.id);
          say(`Copied ${a.folder} (${list.length} ${list.length === 1 ? 'file' : 'files'})`);
        } catch (e) { say(`Couldn’t copy ${a.folder}: ${e.message}`, 'bad'); job.errors++; }
        job.file = ''; job.done++;
      }
      for (const f of w.favourites) {
        if (job.stop) break;
        job.step = 'Favourites'; job.current = f;
        try { await retry(() => call(p, 'POST', '/api/folder/favourite', { json: { folder: f, on: true } })); }
        catch (e) { if (!/No folder/.test(e.message)) { say(`Couldn’t make ${f} a favourite: ${e.message}`, 'bad'); job.errors++; } }
        job.done++;
      }
      if (w.favourites.length && !job.stop) say(`Favourites set (${w.favourites.length})`);
      job.step = 'Reading the player again'; job.current = '';
      try { await devices.refresh(job.kid); } catch { /* the page can check it later */ }
      job.state = job.stop ? 'stopped' : 'done';
      say(job.stop ? 'Stopped' : job.errors ? `Finished, with ${job.errors} problem${job.errors === 1 ? '' : 's'}` : 'Finished: the player matches the plan', job.errors ? 'warn' : 'ok');
    } catch (e) {
      job.state = 'failed'; say(String(e.message || e), 'bad');
    }
    job.step = ''; job.current = ''; job.file = ''; job.ended = new Date().toISOString();
  }

  return {
    preview,
    status: kid => jobs[kid] || { kid, state: 'idle' },
    start(kid) {
      if (jobs[kid] && jobs[kid].state === 'running') return jobs[kid];
      const job = jobs[kid] = { kid, state: 'running', started: new Date().toISOString(), step: 'Starting', current: '', file: '',
        done: 0, total: 0, bytesDone: 0, bytesTotal: 0, errors: 0, noRoom: 0, log: [], stop: false };
      run(job);
      return job;
    },
    stop(kid) { if (jobs[kid] && jobs[kid].state === 'running') jobs[kid].stop = true; return jobs[kid] || { state: 'idle' }; },
    drive: !!DRIVE,
  };
};
