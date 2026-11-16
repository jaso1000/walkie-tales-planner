'use strict';
// WalkieTales collection planner — browse the collection, plan what goes on each child's player.

const TYPES = [
  ['all', 'Everything', '✨'], ['book', 'Books', '📚'], ['music', 'Music', '🎵'], ['podcast', 'Podcasts', '🎙️'],
  ['tv', 'TV', '📺'], ['movie', 'Movies', '🎬'], ['tonie', 'Tonies', '🧸'],
];
const TYPE_NAME = { book: 'Book', music: 'Music', podcast: 'Podcast', tv: 'TV', movie: 'Movie', tonie: 'Tonie' };
const TYPE_ICON = Object.fromEntries(TYPES.map(t => [t[0], t[2]]));
const TYPE_COLOR = { book: '#6C4CF1', music: '#FF6B8A', podcast: '#2EC4B6', tv: '#4F9DFF', movie: '#FF8A3D', tonie: '#E0A100' };
const AGES = ['Under 5', '5–8', '8–12', 'Teen', 'Grown-up', 'All ages', 'Kids'];
const MB_PER_MIN = 0.94;      // ~128 kbps, for a size estimate until the drive is scanned
const MB_PER_TRACK = 4.5;

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('planner.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('planner.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

let items = [], byId = new Map(), plan = { version: 0, kids: [], assign: {} }, catalogBuilt = '';
let devs = {}, devUpdated = null, playersCfg = {}, checking = false; // what's on each child's player right now
const PLAYER_MADE = new Set(['sleep sounds', 'messages', 'app update']); // folders the player makes itself
const f = Object.assign({ q: '', type: 'all', age: '', season: '', len: '', topic: '', onp: '', sort: 'az', kid: '', kidView: 'plan',
  unplanned: false, unsure: false, hasCover: false }, store.get('filters', {}));

// Friendly topics, made from the shop categories we found and a few words in the titles
const TOPICS = [
  ['animals', 'Animals & nature', /animals|nature/i, /\b(animal|dog|cat|puppy|kitten|horse|pony|bear|dino|dinosaur|farm|zoo|ocean|jungle)/i],
  ['adventure', 'Adventure', /action|adventure/i, null],
  ['fantasy', 'Fantasy & magic', /fantasy|science fiction/i, /\b(magic|dragon|wizard|unicorn|fairy|fairies|witch)/i],
  ['fairy', 'Fairy tales & myths', /fairy tales|folk|myth/i, /\b(fairy tale|fairytale|myth|legend|aesop)/i],
  ['funny', 'Funny', /comedy|humou?r/i, /\b(joke|funny|silly|laugh)/i],
  ['mystery', 'Mystery', /mystery|suspense|thriller/i, /\b(mystery|detective|spy)/i],
  ['growing', 'Growing up', /growing up/i, null],
  ['learning', 'Learning & facts', /education|science|geography|history|technology/i, /\b(learn|facts|science|history|phonics|counting|alphabet|abc)/i],
  ['faith', 'Faith', /religion|spirituality|christian/i, /\b(bible|jesus|christian|god)\b/i],
  ['bedtime', 'Bedtime', null, /\b(bedtime|sleep|goodnight|lullab|night night|dream)/i],
  ['classics', 'Classics', /classics/i, null],
  ['music', 'Songs & singing', null, /\b(songs|sing|nursery rhyme|music)/i],
  ['sport', 'Sport', /sports/i, /\b(football|soccer|cricket|tennis|sport)/i],
];
const LENGTHS = [['short', 'Under 30 min', m => m > 0 && m < 30], ['medium', '30 min to 2 h', m => m >= 30 && m <= 120], ['long', 'Over 2 h', m => m > 120]];
const ONP = [['any', 'On any player'], ['none', 'Not on any player']];
f.q = '';
let view = store.get('view', 'grid');
let shown = [], rendered = 0, selecting = false, selected = new Set(), saveTimer = 0, saving = false, dirty = false;

// ------------------------------------------------------------------------------------------- search
// Names kids' content goes by. Searching any word in a group finds the others ("spiderman" finds Spidey).
const ALIASES = [ // a group starting with '*' is an umbrella: its first name finds the rest, not the other way round
  ['spiderman', 'spidey', 'spider-man', 'peter parker', 'miles morales', 'spider verse'],
  ['*marvel', 'avengers', 'iron man', 'spidey', 'spiderman', 'spider-man', 'hulk', 'thor', 'captain america', 'black panther', 'guardians of the galaxy'],
  ['*dc', 'batman', 'superman', 'justice league', 'wonder woman'], ['batman', 'bruce wayne', 'gotham'],
  ['frozen', 'elsa', 'olaf'], ['bluey', 'bingo', 'heeler'], ['paw patrol', 'paw patrol pups'],
  ['pokemon', 'pikachu'], ['minecraft', 'creeper', 'dave the villager'],
  ['star wars', 'jedi', 'skywalker', 'mandalorian', 'yoda'], ['harry potter', 'hogwarts'],
  ['toy story', 'woody', 'buzz lightyear'], ['mickey', 'minnie', 'mickey mouse'],
  ['dinosaur', 'dinosaurs', 'dino', 'dinos', 'jurassic'], ['christmas', 'xmas', 'santa', 'festive'],
  ['princess', 'princesses'], ['unicorn', 'unicorns'], ['fairy', 'fairies', 'fairytale', 'fairytales'],
  ['bedtime', 'sleepy', 'goodnight', 'lullaby', 'lullabies'], ['bible', 'jesus', 'christian'],
  ['peppa', 'peppa pig'], ['wiggles'], ['cars', 'lightning mcqueen'], ['moana', 'maui'], ['wimpy kid', 'greg heffley'],
  ['joke', 'jokes', 'funny'], ['song', 'songs', 'singalong', 'nursery rhymes'],
];
const norm = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/&/g, ' and ').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const aliasMap = new Map();
for (const g of ALIASES) {
  const umbrella = g[0].startsWith('*'), names = g.map(w => norm(w.replace('*', '')));
  for (const w of umbrella ? names.slice(0, 1) : names) {
    const k = w.replace(/ /g, '');
    aliasMap.set(k, [...new Set([...(aliasMap.get(k) || []), ...names])]);
  }
}

function close(a, b) { // one typo allowed in longer words
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** How well an item fits one searched word: 0 = not at all. Tries the word, its aliases, spacing and one typo. */
function wordScore(it, w) {
  const forms = (aliasMap.get(w.replace(/ /g, '')) || []).filter(f => f !== w);
  let best = 0;
  // the word itself: matches the start of any word ("dino" finds "dinosaur"), or with spaces ignored ("spiderman")
  const c = w.replace(/ /g, '');
  if (it.titlePad.includes(' ' + w)) best = 3;
  else if (it.pad.includes(' ' + w) || (c.length > 3 && it.compact.includes(c))) best = 2;
  // related names: whole words only, and count a little less
  for (const f of forms) {
    if (it.titlePad.includes(' ' + f + ' ')) best = Math.max(best, 2.5);
    else if (it.pad.includes(' ' + f + ' ') || (f.includes(' ') && it.compact.includes(f.replace(/ /g, '')))) best = Math.max(best, 1.6);
  }
  if (!best && w.length >= 5) for (const t of it.words) if (t.length >= 4 && close(w, t)) { best = 1; break; }
  return best;
}

function searchScore(it, words) {
  let total = 0;
  for (const w of words) { const s = wordScore(it, w); if (!s) return 0; total += s; }
  return total;
}

// ------------------------------------------------------------------------------------------- data

function prep(it) {
  const m = it.match || {};
  it.unsure = !it.match || it.confidence < 80;
  it.title = (!it.unsure && m.title) || it.query || it.name; // unsure: the drive's own name says what it is better
  it.by = (m.authors || []).filter(Boolean).slice(0, 3).join(', ');
  it.minutes = m.minutes || 0;
  it.est = it.bytes ? it.bytes : it.minutes ? it.minutes * MB_PER_MIN * 1e6 : m.tracks ? m.tracks * MB_PER_TRACK * 1e6 : 0;
  it.exact = !!it.bytes;
  it.series = m.series || '';
  it.hay = norm([it.title, it.name, it.by, (m.narrators || []).join(' '), it.series, m.subtitle, it.category, it.season, (m.genres || []).join(' ')].join(' '));
  it.words = new Set(it.hay.split(' ').filter(Boolean));
  it.compact = it.hay.replace(/ /g, '');
  it.pad = ' ' + it.hay + ' ';
  it.titlePad = ' ' + norm(it.title + ' ' + it.series) + ' ';
  const g = (m.genres || []).join(' | '), words = [it.title, it.name, it.series].join(' ');
  it.topics = TOPICS.filter(([, , gre, wre]) => (gre && gre.test(g)) || (wre && wre.test(words))).map(t => t[0]);
  return it;
}

async function load() {
  const [cat, p] = await Promise.all([fetch('/api/catalog').then(r => r.ok ? r.json() : { items: [] }), fetch('/api/plan').then(r => r.json())]);
  items = (cat.items || []).map(prep);
  catalogBuilt = cat.built || '';
  byId = new Map(items.map(i => [i.id, i]));
  plan = p;
  if (plan.saved) saveState('Saved ✓');
  await loadDevices();
  buildFilters();
  renderKids();
  apply();
  setInterval(poll, 20000);
  // The players are only read when needed: now, if the last reading is over 10 minutes old (or there is none).
  // Readings made from another phone or computer show up here through the minute-by-minute check of the server's copy.
  if (!devUpdated || Date.now() - new Date(devUpdated) > 10 * 60 * 1000) readPlayersNow();
  setInterval(() => loadDevices().then(changed => { if (changed) { renderKids(); apply(true); } }), 60000);
}

async function readPlayersNow() {
  if (!Object.keys(playersCfg).length) return;
  checking = true; renderKidPanel();
  await loadDevices(true);
  checking = false; renderKids(); apply(true);
}

// ------------------------------------------------------------------------------------------- the players

async function loadDevices(fresh) {
  try {
    const [d, pc] = await Promise.all([
      fresh ? fetch('/api/devices/refresh' + (fresh === true ? '' : '?kid=' + fresh), { method: 'POST' }).then(r => r.json())
        : fetch('/api/devices').then(r => r.json()),
      fetch('/api/players').then(r => r.json()),
    ]);
    playersCfg = pc;
    if (d.updated === devUpdated && !fresh) return false;
    devUpdated = d.updated;
    devs = {};
    for (const it of items) if (it.fromPlayer) { it.est = it.estBefore; it.exact = !!it.bytes; delete it.fromPlayer; }
    for (const [kid, r] of Object.entries(d.kids || {})) {
      const on = new Map(), extra = [];
      let used = 0;
      for (const fo of r.folders || []) {
        used += fo.bytes;
        const m = (r.matches || {})[fo.name];
        if (m && byId.has(m.id)) {
          on.set(m.id, (on.get(m.id) || 0) + fo.bytes);
          const it = byId.get(m.id);
          if (!it.bytes && fo.bytes && !it.fromPlayer) { it.estBefore = it.est; it.est = fo.bytes; it.exact = true; it.fromPlayer = true; }
        } else extra.push({ ...fo, made: PLAYER_MADE.has(fo.name.toLowerCase()) });
      }
      devs[kid] = { ...r, on, extra, used, hasData: !!r.folders };
    }
    return true;
  } catch { return false; }
}

const ago = iso => {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(iso).toLocaleDateString();
};
/** Space for WalkieTales: live from the player (free + what WalkieTales already uses), else the number typed in. */
function kidSpace(k) {
  const d = devs[k.id];
  if (d && d.hasData && d.status && d.status.freeBytes != null) return Math.max(0, d.status.freeBytes + d.used - 1e9);
  return (k.spaceGB || 0) * 1e9;
}

async function poll() {
  if (dirty || saving || document.hidden) return;
  try {
    const p = await fetch('/api/plan').then(r => r.json());
    if (p.version !== plan.version) { plan = p; renderKids(); apply(true); }
  } catch { /* offline for a moment */ }
}

function save() {
  dirty = true;
  saveState('Saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    saving = true;
    try {
      const r = await fetch('/api/plan', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(plan) });
      const p = await r.json();
      if (r.status === 409) { // changed on another device: keep theirs, then re-apply this change on top
        const mine = plan.assign, kids = plan.kids;
        plan = p; plan.assign = mine; plan.kids = kids;
        saving = false; return save();
      }
      if (r.ok) { plan.version = p.version; plan.saved = p.saved; dirty = false; saveState('Saved ✓'); }
      else { saveState('Not saved', true); setTimeout(save, 5000); }
    } catch { saveState('Not saved — retrying', true); setTimeout(save, 5000); }
    saving = false;
  }, 400);
}

// ------------------------------------------------------------------------------------------- planning

const kidsOf = id => plan.assign[id] || [];
function setKid(id, kidId, on) {
  const cur = new Set(kidsOf(id));
  on ? cur.add(kidId) : cur.delete(kidId);
  if (cur.size) plan.assign[id] = [...cur]; else delete plan.assign[id];
}
function kidUse(kidId) {
  const d = devs[kidId] || { on: new Map(), extra: [] };
  let bytes = 0, unknown = 0, n = 0, keep = 0, add = 0, nAdd = 0; const byType = {};
  for (const [id, ks] of Object.entries(plan.assign)) {
    if (!ks.includes(kidId)) continue;
    const it = byId.get(id); if (!it) continue;
    n++;
    const b = d.on.get(id) || it.est;
    if (b) { bytes += b; byType[it.kind] = (byType[it.kind] || 0) + b; } else unknown++;
    if (d.on.has(id)) keep += b; else { add += b; nAdd++; }
  }
  let remove = 0, nRemove = 0;
  for (const [id, b] of d.on) if (!kidsOf(id).includes(kidId)) { remove += b; nRemove++; }
  const extra = d.extra.reduce((t, x) => t + x.bytes, 0);
  // after: what the player holds once the plan is copied (folders that aren't in the collection stay)
  return { bytes, unknown, n, byType, keep, add, nAdd, remove, nRemove, extra, nOn: d.on.size,
    nExtra: d.extra.filter(x => !x.made).length, after: bytes + extra };
}
const gb = b => b >= 1e9 ? (b / 1e9).toFixed(b >= 1e10 ? 0 : 1) + ' GB' : Math.round(b / 1e6) + ' MB';
const initials = n => (n || '?').trim().slice(0, 1).toUpperCase();

// ------------------------------------------------------------------------------------------- rendering

function setView(v) {
  view = v; store.set('view', v);
  $('#grid').classList.toggle('list', v === 'list');
  $('#viewGrid').classList.toggle('on', v === 'grid');
  $('#viewList').classList.toggle('on', v === 'list');
}
$('#viewGrid').addEventListener('click', () => setView('grid'));
$('#viewList').addEventListener('click', () => setView('list'));
setView(view);

function saveState(text, bad) {
  const el = $('#saveState'); el.textContent = text; el.classList.toggle('bad', !!bad);
}

function buildFilters() {
  const counts = {};
  for (const it of items) counts[it.kind] = (counts[it.kind] || 0) + 1;
  const row = (attr, val, label, n, on) => `<button class="row${on ? ' on' : ''}" data-${attr}="${esc(val)}">${label}<span class="n">${n ?? ''}</span></button>`;
  $('#sideType').innerHTML = TYPES.filter(([k]) => k === 'all' || counts[k])
    .map(([k, label]) => row('type', k, label, k === 'all' ? items.length : counts[k], f.type === k)).join('');
  const ages = AGES.filter(a => items.some(i => i.age === a));
  $('#sideAge').innerHTML = row('age', '', 'Any age', '', !f.age) +
    ages.map(a => row('age', a, a, items.filter(i => i.age === a).length, f.age === a)).join('');
  $('#sideLen').innerHTML = row('len', '', 'Any length', '', !f.len) +
    LENGTHS.map(([k, label, fn]) => row('len', k, label, items.filter(i => fn(i.minutes)).length, f.len === k)).join('');
  $('#sideTopic').innerHTML = row('topic', '', 'Any topic', '', !f.topic) +
    TOPICS.map(([k, label]) => [k, label, items.filter(i => i.topics.includes(k)).length]).filter(t => t[2])
      .map(([k, label, n]) => row('topic', k, label, n, f.topic === k)).join('');
  const onAny = id => Object.values(devs).some(d => d.on.has(id));
  $('#sideOnp').innerHTML = row('onp', '', 'Either', '', !f.onp) +
    ONP.map(([k, label]) => row('onp', k, label, items.filter(i => k === 'any' ? onAny(i.id) : !onAny(i.id)).length, f.onp === k)).join('');
  const label = (list, v) => (list.find(x => x[0] === v) || [])[1] || '';
  $('#selType').textContent = f.type === 'all' ? '' : label(TYPES, f.type);
  $('#selAge').textContent = f.age;
  $('#selLen').textContent = label(LENGTHS, f.len);
  $('#selTopic').textContent = label(TOPICS, f.topic);
  $('#selSeason').textContent = f.season;
  $('#selOnp').textContent = label(ONP, f.onp);
  $('#selOnly').textContent = [f.unplanned && 'Not planned', f.unsure && 'Unsure', f.hasCover && 'Cover'].filter(Boolean).join(', ');
  $('#hasCover').checked = f.hasCover;
  const seasons = [...new Set(items.map(i => i.season).filter(Boolean))];
  $('#seasonBox').hidden = !seasons.length;
  $('#sideSeason').innerHTML = row('season', '', 'Any time', '', !f.season) +
    seasons.map(x => row('season', x, x, items.filter(i => i.season === x).length, f.season === x)).join('');
  $('#sort').value = f.sort;
  $('#unplanned').checked = f.unplanned;
  $('#unsure').checked = f.unsure;
}

function liveDot(k) {
  const d = devs[k.id];
  if (!d || !d.hasData) return '';
  return `<span class="live ${d.ok ? 'ok' : 'old'}" title="${d.ok ? 'Read from the player ' + ago(d.checked) : 'Player not answering: ' + esc(d.error || '')}"></span>`;
}

function renderKids() {
  // sidebar rows (computers) and round avatars (phones)
  const side = [`<button class="row kidrow${!f.kid ? ' on' : ''}" data-kid=""><span class="av" style="--kc:var(--accent)">★</span>
    <span class="who"><b>Everything</b><small>${items.length.toLocaleString()} items</small></span></button>`];
  const strip = [`<button class="kid${!f.kid ? ' on' : ''}" data-kid="" style="--kc:var(--accent)"><span class="av">★</span><span class="nm">All</span></button>`];
  for (const k of plan.kids) {
    const u = kidUse(k.id), space = kidSpace(k), d = devs[k.id];
    const pct = space ? Math.min(100, u.after / space * 100) : 0;
    side.push(`<button class="row kidrow${f.kid === k.id ? ' on' : ''}" data-kid="${k.id}" style="--kc:${k.color}">
      <span class="av">${esc(initials(k.name))}${liveDot(k)}</span>
      <span class="who"><b>${esc(k.name)}</b><small>${u.n} planned${d && d.hasData ? ` · ${u.nOn} on player` : ''}</small>
      <span class="mini-bar${u.after > space && space ? ' over' : ''}"><i style="width:${pct}%"></i></span></span></button>`);
    strip.push(`<button class="kid${f.kid === k.id ? ' on' : ''}" data-kid="${k.id}" style="--kc:${k.color}">
      <span class="av">${esc(initials(k.name))}${liveDot(k)}</span><span class="nm">${esc(k.name)}</span></button>`);
  }
  $('#sideKids').innerHTML = side.join('');
  $('#kids').innerHTML = strip.join('');
  renderKidPanel();
}

function renderKidPanel() {
  const k = plan.kids.find(x => x.id === f.kid), el = $('#kidPanel');
  if (!k) { el.hidden = true; return; }
  const u = kidUse(k.id), space = kidSpace(k), d = devs[k.id], hasDev = d && d.hasData;
  const total = Math.max(space, u.after + u.remove, 1);
  const w = b => (b / total * 100).toFixed(2) + '%';
  const left = space - u.after;
  let state;
  if (!playersCfg[k.id]) state = "No player linked yet. Add its address and PIN in the menu (top right) to see what's on it.";
  else if (!hasDev) state = d && d.error ? `Couldn't reach the player: ${esc(d.error)}` : 'Reading the player…';
  else state = `${esc(d.status && d.status.model ? deviceName(d.status.model) : k.device || 'Player')} · WalkieTales ${esc((d.status && d.status.version) || '?')}`
    + (d.status && d.status.battery != null ? ` · battery ${d.status.battery}%${d.status.charging ? ' ⚡' : ''}` : '') + ' · '
    + (d.ok ? `read ${ago(d.checked)}` : `<span style="color:var(--warn)">not answering (${esc(d.error || 'asleep?')}), showing what was there ${ago(d.checked)}</span>`);
  const tabs = [['plan', 'Planned', u.n]].concat(hasDev ? [['on', 'On the player', u.nOn], ['add', 'To add', u.nAdd],
    ['remove', 'To remove', u.nRemove], ['extra', 'Not in collection', u.nExtra]] : []);
  if (!hasDev && f.kidView !== 'plan') f.kidView = 'plan';
  el.style.setProperty('--kc', k.color);
  el.innerHTML = `<div class="kp-head">
      <div class="kp-title"><span class="av">${esc(initials(k.name))}</span><div><h2>${esc(k.name)}</h2><div class="muted fine">${state}</div></div></div>
      <div class="kp-actions">${playersCfg[k.id] ? `<button class="text-btn" id="checkNow"${checking ? ' disabled' : ''}>${checking ? 'Checking…' : '↻ Check the player'}</button>` : ''}
      ${hasDev && u.nRemove ? `<button class="text-btn" id="importOn">Add what's on it to the plan</button>` : ''}</div></div>
    <div class="big-bar">
      <i style="width:${w(u.keep)};background:var(--kc)" title="Planned and on the player: ${gb(u.keep)}"></i>
      <i style="width:${w(u.add)};background:var(--kc);opacity:.45" title="Planned, still to copy: ${gb(u.add)}"></i>
      <i style="width:${w(u.extra)};background:#8a84a6" title="On the player, not in the collection: ${gb(u.extra)}"></i>
      <i class="stripe" style="width:${w(u.remove)}" title="On the player but not planned: ${gb(u.remove)}"></i></div>
    <div class="legend">
      ${hasDev ? `<span style="--c:var(--kc)">Planned, on the player ${gb(u.keep)}</span>` : ''}
      <span style="--c:color-mix(in srgb, var(--kc) 45%, transparent)">${hasDev ? 'To add' : 'Planned'} ${gb(u.add)}</span>
      ${hasDev && u.extra ? `<span style="--c:#8a84a6">Not in the collection ${gb(u.extra)}</span>` : ''}
      ${hasDev && u.remove ? `<span class="st">Not planned ${gb(u.remove)}</span>` : ''}
      <span style="--c:var(--panel-2)">${space ? (left >= 0 ? `${gb(left)} free after the plan, of ${gb(space)}` : `<b style="color:var(--bad)">${gb(-left)} too much</b> for ${gb(space)}`) : 'free space unknown'}</span>
      ${u.unknown ? `<span style="--c:transparent">${u.unknown} without a size yet</span>` : ''}</div>
    <div class="tabs">${tabs.map(([key, label, n]) => `<button class="tab${f.kidView === key ? ' on' : ''}" data-view="${key}">${label}<em>${n}</em></button>`).join('')}</div>`;
  el.hidden = false;
}

const MODELS = { 'SM-G960F': 'Galaxy S9', 'SM-G965F': 'Galaxy S9+', 'SM-G973F': 'Galaxy S10', 'SM-N9005': 'Galaxy Note 3', 'iPhone9,1': 'iPhone 7', 'iPhone9,3': 'iPhone 7' };
const deviceName = m => MODELS[m] || m;

function kidFilter(id) {
  const planned = kidsOf(id).includes(f.kid), on = !!(devs[f.kid] && devs[f.kid].on.has(id));
  const v = { plan: planned, on, add: planned && !on, remove: on && !planned }[f.kidView];
  return v === undefined ? planned : v;
}

function apply(keepScroll) {
  store.set('filters', { ...f, q: '' });
  if (f.kid && f.kidView === 'extra') return showExtra();
  const q = norm(f.q).split(' ').filter(Boolean);
  // keep two-word names together so "iron man" or "paw patrol" match as one
  for (let i = 0; i < q.length - 1; i++) if (aliasMap.has(q[i] + q[i + 1])) { q.splice(i, 2, q[i] + ' ' + q[i + 1]); }
  const scores = new Map();
  shown = items.filter(it =>
    (f.type === 'all' || it.kind === f.type) &&
    (!f.age || it.age === f.age) &&
    (!f.season || it.season === f.season) &&
    (!f.len || (LENGTHS.find(l => l[0] === f.len) || [, , () => true])[2](it.minutes)) &&
    (!f.topic || it.topics.includes(f.topic)) &&
    (!f.onp || (f.onp === 'any') === Object.values(devs).some(d => d.on.has(it.id))) &&
    (!f.hasCover || it.hasCover) &&
    (!f.kid || kidFilter(it.id)) &&
    (!f.unplanned || !kidsOf(it.id).length) &&
    (!f.unsure || it.unsure) &&
    (!q.length || (s => (s && scores.set(it.id, s), s))(searchScore(it, q))));
  const by = {
    az: (a, b) => a.title.localeCompare(b.title),
    long: (a, b) => b.minutes - a.minutes || a.title.localeCompare(b.title),
    short: (a, b) => (a.minutes || 1e9) - (b.minutes || 1e9),
    big: (a, b) => b.est - a.est,
    series: (a, b) => (a.series || '~').localeCompare(b.series || '~') || (parseFloat(a.match?.seriesPos) || 0) - (parseFloat(b.match?.seriesPos) || 0) || a.title.localeCompare(b.title),
  }[f.sort];
  shown.sort(q.length && f.sort === 'az' ? (a, b) => scores.get(b.id) - scores.get(a.id) || a.title.localeCompare(b.title) : by);
  const total = shown.reduce((s, i) => s + i.est, 0);
  $('#count').innerHTML = `<b>${shown.length.toLocaleString()}</b> ${shown.length === 1 ? 'item' : 'items'}${total ? ' · about ' + gb(total) : ''}`;
  renderActive();
  const y = window.scrollY;
  rendered = 0;
  const filtered = f.type !== 'all' || f.age || f.season || f.len || f.topic || f.onp || f.unplanned || f.unsure || f.hasCover;
  const kname = f.kid && (plan.kids.find(k => k.id === f.kid) || {}).name;
  const kidEmpty = { plan: `Nothing planned for ${kname} yet. Pick things from <b>Everything</b>${devs[f.kid] && devs[f.kid].on.size ? ', or use <b>Add what’s on it to the plan</b> above' : ''}.`,
    on: `Nothing from the collection is on ${kname}'s player.`, add: `Everything planned for ${kname} is already on the player.`,
    remove: `Everything on ${kname}'s player is planned.` }[f.kidView];
  $('#grid').innerHTML = shown.length ? '' : `<div class="empty">${f.kid && !filtered && !q.length && kidEmpty ? kidEmpty
    : `Nothing matches${filtered ? ' with these filters' : ''}.${filtered ? '<br><br><button class="btn" id="clearAll">Clear filters</button>' : ''}`}</div>`;
  more();
  if (keepScroll) { while (rendered < shown.length && document.body.scrollHeight < y + innerHeight) more(); window.scrollTo(0, y); }
}

/** Folders on the player that aren't in the collection (and the player's own Sleep Sounds and Messages). */
function showExtra() {
  const d = devs[f.kid];
  const list = ((d && d.extra) || []).slice().sort((a, b) => a.made - b.made || a.name.localeCompare(b.name));
  $('#count').innerHTML = `<b>${list.length}</b> folders on the player that aren't in the collection · ${gb(list.reduce((t, x) => t + x.bytes, 0))}`;
  renderActive();
  $('#grid').innerHTML = list.length ? list.map(x => `<div class="card extra">
      <div class="cover"><div class="ph" style="background:linear-gradient(150deg,#7b7596,#1b1530)"><div><span>${x.made ? '🌙' : '📁'}</span>${esc(x.name)}</div></div></div>
      <div class="t">${esc(x.name)}</div><div class="s">${x.made ? 'Made by the player' : `${x.files} files · ${gb(x.bytes)}`}</div>
      <div class="meta"><span>${x.made ? 'Made by the player' : esc(x.category || '')}</span><span>${gb(x.bytes)}</span></div></div>`).join('')
    : '<div class="empty">Everything on this player is in the collection.</div>';
  $('#more').textContent = '';
}

/** A short line of what's filtering the list, with one way to clear it all. */
function renderActive() {
  const bits = [];
  if (f.type !== 'all') bits.push((TYPES.find(t => t[0] === f.type) || [])[1]);
  if (f.age) bits.push(f.age);
  if (f.season) bits.push(f.season);
  if (f.len) bits.push((LENGTHS.find(l => l[0] === f.len) || [])[1]);
  if (f.topic) bits.push((TOPICS.find(t => t[0] === f.topic) || [])[1]);
  if (f.onp) bits.push((ONP.find(o => o[0] === f.onp) || [])[1]);
  if (f.hasCover) bits.push('with a cover');
  if (f.unplanned) bits.push('not planned yet');
  if (f.unsure) bits.push('unsure matches');
  $('#activeFilters').innerHTML = bits.length ? `<span class="af">${esc(bits.join(' · '))}</span><button class="text-btn" id="clearAll">Clear</button>` : '';
  $('#countLine').innerHTML = $('#count').innerHTML + ' ' + $('#activeFilters').innerHTML.replace('id="clearAll"', 'id="clearAll2"');
  $('#filtersBtn').innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18v2H3zm4 6h10v2H7zm3 6h4v2h-4z"/></svg> Filters${bits.length ? ` (${bits.length})` : ''}`;
}

function kidMarks(id) {
  return plan.kids.map(k => {
    const planned = kidsOf(id).includes(k.id), on = f.kid === k.id && !!(devs[k.id] && devs[k.id].on.has(id));
    if (!planned && !on) return '';
    const t = `${k.name}: ${planned && on ? 'planned, already on the player' : planned ? 'planned' : 'on the player, not planned'}`;
    return `<i class="${planned ? '' : 'hollow'}${on ? ' onp' : ''}" style="--kc:${k.color}" title="${esc(t)}">${esc(initials(k.name))}</i>`;
  }).join('');
}

function card(it) {
  const len = it.minutes ? (it.minutes >= 60 ? `${Math.floor(it.minutes / 60)}h ${it.minutes % 60}m` : `${it.minutes}m`) : '';
  const sub = [it.by, len].filter(Boolean).join(' · ') || it.category;
  return `<button class="card${selected.has(it.id) ? ' sel' : ''}" data-id="${it.id}">
    <div class="cover">${coverHtml(it)}
      <span class="dots">${kidMarks(it.id)}</span>
      <span class="tick">✓</span></div>
    <div class="t">${esc(it.title)}</div><div class="s">${esc(sub)}</div>
    <div class="meta"><span>${esc(it.season || TYPE_NAME[it.kind] || '')}${it.age ? ' · ' + esc(it.age) : ''}${it.est ? ' · ' + (it.exact ? '' : '≈') + gb(it.est) : ''}</span>
      <span class="dots">${kidMarks(it.id)}</span></div></button>`;
}

function coverHtml(it) {
  if (it.hasCover) return `<img loading="lazy" decoding="async" src="/covers/${it.id}.jpg" alt="">`;
  const c = TYPE_COLOR[it.kind] || '#6C4CF1';
  return `<div class="ph" style="background:linear-gradient(150deg, ${c}, #1b1530)"><div><span>${TYPE_ICON[it.kind] || '✨'}</span>${esc(it.title.slice(0, 60))}</div></div>`;
}

function more() {
  const next = shown.slice(rendered, rendered + 96);
  if (!next.length) { $('#more').textContent = shown.length ? '' : ''; return; }
  $('#grid').insertAdjacentHTML('beforeend', next.map(card).join(''));
  rendered += next.length;
  $('#more').textContent = rendered < shown.length ? 'Loading more…' : '';
}
new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) more(); }, { rootMargin: '800px' }).observe($('#more'));

function refreshCard(id) {
  const el = document.querySelector(`.card[data-id="${id}"]`);
  if (el) el.outerHTML = card(byId.get(id));
}

// ------------------------------------------------------------------------------------------- detail sheet

function openDetail(id) {
  const it = byId.get(id), m = it.match || {};
  const len = it.minutes ? (it.minutes >= 60 ? `${Math.floor(it.minutes / 60)} h ${it.minutes % 60} min` : `${it.minutes} min`) : '';
  const facts = [TYPE_NAME[it.kind], it.season, len, m.tracks ? `${m.tracks} tracks` : '', it.age ? `Age: ${it.age} (guess)` : '',
    m.year, it.est ? (it.exact ? gb(it.est) : `≈ ${gb(it.est)}`) : 'Size not known yet', ...(m.genres || []).slice(0, 3)].filter(Boolean);
  $('#detail').innerHTML = `<div class="detail">
    <div class="cover">${coverHtml(it)}</div>
    <div>
      <h1 id="dTitle">${esc(it.title)}</h1>
      ${m.subtitle ? `<div class="sub">${esc(m.subtitle)}</div>` : ''}
      ${it.by ? `<div>${it.kind === 'music' ? '' : 'By '}${esc(it.by)}</div>` : ''}
      ${m.narrators?.length ? `<div class="muted">Read by ${esc(m.narrators.slice(0, 3).join(', '))}</div>` : ''}
      ${it.series ? `<div class="muted">Series: ${esc(it.series)}${m.seriesPos ? ' #' + esc(m.seriesPos) : ''}</div>` : ''}
      <div class="facts">${facts.map(x => `<span>${esc(x)}</span>`).join('')}</div>
      ${it.unsure ? `<div class="unsure">${it.match ? `Best guess: <b>${esc(m.title)}</b> — not sure it's the right one, so the details below may be for a different book in the series` : "Couldn't find this one online"}. The name on the drive is “${esc(it.name)}”.</div>` : ''}
      <h2>Plan for</h2>
      <div class="assign">${plan.kids.map(k => `<button data-assign="${k.id}" class="${kidsOf(id).includes(k.id) ? 'on' : ''}" style="--kc:${k.color}"><span class="av">${esc(initials(k.name))}</span>${esc(k.name)}${devs[k.id] && devs[k.id].on.has(id) ? ' <small>· on player</small>' : ''}</button>`).join('')}</div>
      ${m.blurb ? `<p class="blurb">${esc(m.blurb)}</p>` : ''}
      <div class="src">On the drive: <b>${esc(it.name)}</b><br>${esc(it.folder)}${it.files ? ` · ${it.files} files` : ''}
        ${m.link ? `<br>Details from <a href="${esc(m.link)}" target="_blank" rel="noopener noreferrer">${esc(m.source)}</a>` : ''}</div>
    </div></div>`;
  $('#detail').dataset.id = id;
  $('#sheet').hidden = false;
}

// ------------------------------------------------------------------------------------------- menu: export + kids

function openMenu() {
  const n = Object.keys(plan.assign).length;
  $('#planInfo').textContent = `${n} items planned for at least one kid${plan.saved ? ' · saved ' + new Date(plan.saved).toLocaleString() : ''}.`;
  $('#catInfo').textContent = `Catalogue built ${catalogBuilt || '—'} · ${items.length} items · ${items.filter(i => i.match).length} identified · ${items.filter(i => i.hasCover).length} with covers · ${items.filter(i => i.exact).length} with real sizes.`;
  renderKidEditor();
  $('#menu').hidden = false;
}

function renderKidEditor() {
  $('#kidEditor').innerHTML = `<div class="kid-edit muted fine"><span></span><span>Name</span><span class="dev">Phone</span><span>GB free</span><span></span></div>` +
    plan.kids.map((k, i) => `<div class="kid-edit" data-i="${i}">
      <input type="color" value="${esc(k.color)}" data-k="color" aria-label="Colour">
      <input value="${esc(k.name)}" data-k="name" aria-label="Name">
      <input class="dev" value="${esc(k.device || '')}" data-k="device" aria-label="Phone">
      <input type="number" min="0" step="0.5" value="${k.spaceGB ?? ''}" data-k="spaceGB" aria-label="GB free for WalkieTales">
      <button data-del="${i}" aria-label="Remove ${esc(k.name)}" title="Remove">✕</button></div>
    <div class="kid-player" data-kid="${k.id}">
      <span class="live ${devs[k.id] && devs[k.id].ok ? 'ok' : devs[k.id] ? 'old' : ''}"></span>
      <input value="${esc((playersCfg[k.id] && playersCfg[k.id].url) || '')}" data-p="url" placeholder="Player address, e.g. 192.168.1.50" aria-label="${esc(k.name)}'s player address">
      <input type="password" value="" data-p="pin" placeholder="${playersCfg[k.id] && playersCfg[k.id].hasPin ? 'PIN saved' : 'PIN'}" autocomplete="off" aria-label="${esc(k.name)}'s player PIN">
      <button class="ghost" data-savep="${k.id}">Save</button></div>`).join('') +
    `<p class="muted fine">The player's address and PIN are in its Grown-up settings → Remote control. PINs stay on the server and are never shown here.</p>`;
}

// ------------------------------------------------------------------------------------------- events

$('#kidPanel').addEventListener('click', async e => {
  const t = e.target.closest('[data-view]');
  if (t) { f.kidView = t.dataset.view; renderKidPanel(); apply(); return; }
  if (e.target.id === 'checkNow') {
    checking = true; renderKidPanel();
    await loadDevices(f.kid);
    checking = false; renderKids(); apply(true);
    const d = devs[f.kid];
    toast(d && d.ok ? 'Read the player just now' : `Couldn't reach the player${d && d.error ? ': ' + d.error : ''}`);
  }
  if (e.target.id === 'importOn') {
    const d = devs[f.kid], k = plan.kids.find(x => x.id === f.kid);
    let n = 0;
    for (const id of d.on.keys()) if (!kidsOf(id).includes(k.id)) { setKid(id, k.id, true); n++; }
    save(); renderKids(); apply(true);
    toast(n ? `Added ${n} from ${k.name}'s player to the plan` : `Everything on ${k.name}'s player is already planned`);
  }
});
$('#kidEditor').addEventListener('click', async e => {
  const b = e.target.closest('[data-savep]'); if (!b) return;
  const row = b.closest('.kid-player');
  const url = row.querySelector('[data-p=url]').value.trim(), pin = row.querySelector('[data-p=pin]').value.trim();
  b.disabled = true; b.textContent = 'Checking…';
  await fetch('/api/players/' + b.dataset.savep, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, pin }) });
  await loadDevices(b.dataset.savep);
  renderKidEditor(); renderKids(); apply(true);
  const d = devs[b.dataset.savep];
  toast(!url ? 'Player unlinked' : d && d.ok ? 'Linked — read the player' : `Saved, but couldn't read it: ${(d && d.error) || ''}`);
});

let qTimer = 0;
$('#q').addEventListener('input', e => { clearTimeout(qTimer); qTimer = setTimeout(() => { f.q = e.target.value; apply(); }, 150); });
$('#side').addEventListener('click', e => {
  const b = e.target.closest('[data-type],[data-age],[data-season],[data-len],[data-topic],[data-onp]'); if (!b) return;
  for (const k of ['len', 'topic', 'onp']) if (k in b.dataset) f[k] = b.dataset[k];
  if ('type' in b.dataset) f.type = b.dataset.type;
  if ('age' in b.dataset) f.age = b.dataset.age;
  if ('season' in b.dataset) f.season = b.dataset.season;
  buildFilters(); apply();
});
const drawer = on => document.body.classList.toggle('drawer', on);
$('#filtersBtn').addEventListener('click', () => drawer(true));
$('#sideClose').addEventListener('click', () => drawer(false));
$('#scrim').addEventListener('click', () => drawer(false));
document.addEventListener('click', e => {
  if (e.target.id !== 'clearAll' && e.target.id !== 'clearAll2') return;
  Object.assign(f, { type: 'all', age: '', season: '', len: '', topic: '', onp: '', unplanned: false, unsure: false, hasCover: false });
  buildFilters(); apply();
});
$('#sort').addEventListener('change', e => { f.sort = e.target.value; apply(); });
$('#unplanned').addEventListener('change', e => { f.unplanned = e.target.checked; buildFilters(); apply(); });
$('#unsure').addEventListener('change', e => { f.unsure = e.target.checked; buildFilters(); apply(); });
$('#hasCover').addEventListener('change', e => { f.hasCover = e.target.checked; buildFilters(); apply(); });
const folds = store.get('folds', {});
document.querySelectorAll('.fold').forEach(d => {
  if (d.dataset.fold in folds) d.open = folds[d.dataset.fold];
  d.addEventListener('toggle', () => { folds[d.dataset.fold] = d.open; store.set('folds', folds); });
});
function pickKid(e) {
  const b = e.target.closest('[data-kid]'); if (!b) return;
  f.kid = f.kid === b.dataset.kid ? '' : b.dataset.kid;
  drawer(false);
  renderKids(); apply(); window.scrollTo({ top: 0, behavior: 'smooth' });
}
$('#kids').addEventListener('click', pickKid);
$('#sideKids').addEventListener('click', pickKid);

$('#grid').addEventListener('click', e => {
  if (e.target.id === 'clearFilters') {
    Object.assign(f, { type: 'all', age: '', season: '', kid: '', unplanned: false, unsure: false });
    buildFilters(); renderKids(); apply(); return;
  }
  const c = e.target.closest('.card'); if (!c) return;
  const id = c.dataset.id;
  if (selecting) { selected.has(id) ? selected.delete(id) : selected.add(id); c.classList.toggle('sel'); bulkInfo(); return; }
  openDetail(id);
});

$('#detail').addEventListener('click', e => {
  const b = e.target.closest('[data-assign]'); if (!b) return;
  const id = $('#detail').dataset.id, on = !b.classList.contains('on');
  setKid(id, b.dataset.assign, on);
  b.classList.toggle('on', on);
  save(); renderKids(); refreshCard(id);
  if (f.kid || f.unplanned) apply(true);
});

document.querySelectorAll('.sheet').forEach(s => s.addEventListener('click', e => {
  if (e.target === s || e.target.closest('[data-close]')) s.hidden = true;
}));
document.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelectorAll('.sheet').forEach(s => s.hidden = true); });

// select mode
$('#selectBtn').addEventListener('click', () => setSelecting(!selecting));
function setSelecting(on) {
  selecting = on; selected.clear();
  document.body.classList.toggle('selecting', on);
  document.querySelectorAll('.card.sel').forEach(c => c.classList.remove('sel'));
  $('#selectBtn').textContent = on ? 'Cancel' : 'Select';
  $('#bulk').hidden = !on;
  $('#bulkKids').innerHTML = plan.kids.map(k => `<button data-bulk="${k.id}" style="--kc:${k.color}"><span class="av">${esc(initials(k.name))}</span>${esc(k.name)}</button>`).join('');
  bulkInfo();
}
function bulkInfo() {
  const b = [...selected].reduce((s, id) => s + (byId.get(id)?.est || 0), 0);
  $('#bulkCount').textContent = `${selected.size} selected${b ? ' · ≈ ' + gb(b) : ''} — add to:`;
}
$('#bulkAll').addEventListener('click', () => {
  shown.forEach(i => selected.add(i.id));
  document.querySelectorAll('.card').forEach(c => c.classList.add('sel'));
  bulkInfo();
});
$('#bulkKids').addEventListener('click', e => {
  const b = e.target.closest('[data-bulk]'); if (!b || !selected.size) return;
  const kid = plan.kids.find(k => k.id === b.dataset.bulk);
  const allHave = [...selected].every(id => kidsOf(id).includes(kid.id));
  selected.forEach(id => setKid(id, kid.id, !allHave));
  save(); renderKids();
  toast(allHave ? `Removed ${selected.size} from ${kid.name}` : `Added ${selected.size} to ${kid.name}`);
  setSelecting(false); apply(true);
});
$('#bulkDone').addEventListener('click', () => setSelecting(false));

// menu
$('#menuBtn').addEventListener('click', openMenu);
$('#kidEditor').addEventListener('change', e => {
  const row = e.target.closest('[data-i]'); if (!row) return;
  const k = plan.kids[+row.dataset.i], key = e.target.dataset.k;
  k[key] = key === 'spaceGB' ? (e.target.value === '' ? null : parseFloat(e.target.value)) : e.target.value;
  save(); renderKids();
});
$('#kidEditor').addEventListener('click', e => {
  const b = e.target.closest('[data-del]'); if (!b) return;
  const k = plan.kids[+b.dataset.del];
  if (!confirm(`Remove ${k.name}? Their plan is removed too.`)) return;
  plan.kids.splice(+b.dataset.del, 1);
  for (const id of Object.keys(plan.assign)) setKid(id, k.id, false);
  if (f.kid === k.id) f.kid = '';
  save(); renderKids(); renderKidEditor(); apply(true);
});
$('#addKid').addEventListener('click', () => {
  const id = 'kid' + Date.now().toString(36);
  plan.kids.push({ id, name: 'New kid', device: '', color: '#6C4CF1', spaceGB: null });
  save(); renderKids(); renderKidEditor();
});

let toastTimer = 0;
function toast(t) {
  const el = $('#toast'); el.textContent = t; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
load().catch(e => { $('#grid').innerHTML = `<div class="empty">Couldn't load the catalogue: ${esc(e.message)}</div>`; });
