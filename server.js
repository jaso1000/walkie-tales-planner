// WalkieTales collection planner: browse the content collection and plan what goes on each child's player.
// No dependencies. Data lives in DATA_DIR (default ./data): catalog.json + covers/ (made by tools/enrich.py),
// plan.json (the kids and what's planned for each, saved from the page) and kids.json (the starting kids list).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '8475', 10);
const DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const WEB = path.join(__dirname, 'web');
const PLAN = path.join(DATA, 'plan.json');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json' };

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function loadPlan() {
  const plan = readJson(PLAN, null);
  if (plan) return plan;
  return { version: 0, kids: readJson(path.join(DATA, 'kids.json'), []), assign: {} };
}

function savePlan(plan) {
  const tmp = PLAN + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(plan, null, 1));
  fs.renameSync(tmp, PLAN);
  // a dated copy once a day, in case a plan is ever lost by mistake
  const day = new Date().toISOString().slice(0, 10);
  const backup = path.join(DATA, 'backups', `plan-${day}.json`);
  if (!fs.existsSync(backup)) { fs.mkdirSync(path.dirname(backup), { recursive: true }); fs.copyFileSync(PLAN, backup); }
}

function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function sendFile(res, file, cache) {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'Not found' });
    send(res, 200, buf, TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      { 'Cache-Control': cache || 'no-cache' });
  });
}

function body(req, limit = 5e6) {
  return new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on('data', c => { n += c.length; if (n > limit) { reject(new Error('Too big')); req.destroy(); } else parts.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Everything known about one item, flat, for the exports: what's on the drive, what it was identified as, and how sure.
// The folder on the drive that holds the <Category>\<Name> folders (written by tools/scan_drive.py)
const driveFolder = () => readJson(path.join(DATA, 'drive.json'), {}).folder || '';

function details(it) {
  const m = it.match || {};
  return {
    id: it.id, nameOnDrive: it.name, pathOnDrive: [driveFolder(), it.filedAs || it.category, it.name].filter(Boolean).join('\\'), sharedFolder: it.folder,
    category: it.category, filedOnDriveAs: it.filedAs || it.category, type: it.kind, season: it.season || '',
    title: m.title || it.query || it.name, subtitle: m.subtitle || '', authors: (m.authors || []).join('; '),
    narrators: (m.narrators || []).join('; '), series: m.series || '', seriesNumber: m.seriesPos || '',
    minutes: it.minutes || m.minutes || '', tracks: m.tracks || '', year: m.year || '', genres: (m.genres || []).join('; '),
    ageGuess: it.age || '', bytes: it.bytes || '', files: it.files || '',
    identifiedBy: m.source || '', confidence: it.confidence || 0, sure: !!(it.match && it.confidence >= 80),
    link: m.link || '', coverUrl: (m.cover || [])[0] || '', coverFile: it.hasCover ? `covers/${it.id}.jpg` : '',
    searchedFor: it.query || '', description: m.blurb || '',
  };
}

function planned() {
  const plan = loadPlan();
  const cat = readJson(path.join(DATA, 'catalog.json'), { items: [] });
  const byId = new Map(cat.items.map(i => [i.id, i]));
  return { plan, cat, byId };
}

function exportCsv() {
  const { plan, byId } = planned();
  const rows = [];
  for (const kid of plan.kids) {
    for (const [id, kids] of Object.entries(plan.assign)) {
      if (!kids.includes(kid.id)) continue;
      const it = byId.get(id); if (!it) continue;
      rows.push({ kid: kid.name, kidId: kid.id, device: kid.device || '', ...details(it) });
    }
  }
  const cols = rows.length ? Object.keys(rows[0]) : ['kid', 'kidId', 'device', ...Object.keys(details({ match: null }))];
  return '﻿' + [cols, ...rows.map(r => cols.map(c => r[c]))].map(r => r.map(csvCell).join(',')).join('\r\n');
}

// The plan plus every detail of each planned item, so syncing the players later can reuse (and correct) it.
function exportJson() {
  const { plan, cat, byId } = planned();
  const items = {};
  for (const id of Object.keys(plan.assign)) { const it = byId.get(id); if (it) items[id] = { ...details(it), plannedFor: plan.assign[id] }; }
  return {
    exported: new Date().toISOString(), catalogBuilt: cat.built || '', planVersion: plan.version,
    kids: plan.kids.map(k => ({ ...k, items: Object.keys(plan.assign).filter(id => plan.assign[id].includes(k.id)) })),
    items,
  };
}

const devices = require('./devices')(DATA, readJson);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  try {
    if (p === '/api/catalog') return sendFile(res, path.join(DATA, 'catalog.json'));
    if (p === '/api/plan' && req.method === 'GET') return send(res, 200, loadPlan());
    // what's on each player now (cached; POST reads them again), and each kid's player address (never the PIN)
    if (p === '/api/devices' && req.method === 'GET') return send(res, 200, devices.cache());
    if (p === '/api/devices/refresh' && req.method === 'POST') return send(res, 200, await devices.refresh(url.searchParams.get('kid') || ''));
    if (p === '/api/players' && req.method === 'GET') return send(res, 200, devices.list());
    const pl = p.match(/^\/api\/players\/([\w-]{1,40})$/);
    if (pl && req.method === 'PUT') {
      const b = await body(req);
      devices.set(pl[1], String(b.url || '').trim(), String(b.pin || '').trim());
      return send(res, 200, devices.list());
    }
    if (p === '/api/plan' && req.method === 'PUT') {
      const next = await body(req);
      const cur = loadPlan();
      if (typeof next.version !== 'number' || next.version !== cur.version) return send(res, 409, cur); // someone else saved first
      if (!Array.isArray(next.kids) || typeof next.assign !== 'object') return send(res, 400, { error: 'Bad plan' });
      const plan = { version: cur.version + 1, saved: new Date().toISOString(), kids: next.kids, assign: next.assign };
      savePlan(plan);
      return send(res, 200, plan);
    }
    if (p === '/api/plan.json') return send(res, 200, JSON.stringify(exportJson(), null, 1), 'application/json; charset=utf-8',
      { 'Content-Disposition': 'attachment; filename="walkietales-plan.json"' });
    if (p === '/api/plan.csv') return send(res, 200, exportCsv(), 'text/csv; charset=utf-8',
      { 'Content-Disposition': 'attachment; filename="walkietales-plan.csv"' });
    const cover = p.match(/^\/covers\/([0-9a-f]{10})\.jpg$/);
    if (cover) return sendFile(res, path.join(DATA, 'covers', cover[1] + '.jpg'), 'public, max-age=604800');
    const file = path.join(WEB, p === '/' ? 'index.html' : p);
    if (!file.startsWith(WEB)) return send(res, 403, { error: 'No' });
    return sendFile(res, file);
  } catch (e) {
    return send(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, () => console.log(`Collection planner on http://0.0.0.0:${PORT} (data in ${DATA})`));
