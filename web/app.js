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
const f = Object.assign({ q: '', type: 'all', age: '', season: '', sort: 'az', kid: '', unplanned: false, unsure: false }, store.get('filters', {}));
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
  return it;
}

async function load() {
  const [cat, p] = await Promise.all([fetch('/api/catalog').then(r => r.ok ? r.json() : { items: [] }), fetch('/api/plan').then(r => r.json())]);
  items = (cat.items || []).map(prep);
  catalogBuilt = cat.built || '';
  byId = new Map(items.map(i => [i.id, i]));
  plan = p;
  if (plan.saved) saveState('Saved ✓');
  buildFilters();
  renderKids();
  apply();
  setInterval(poll, 20000);
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
  let bytes = 0, unknown = 0, n = 0; const byType = {};
  for (const [id, ks] of Object.entries(plan.assign)) {
    if (!ks.includes(kidId)) continue;
    const it = byId.get(id); if (!it) continue;
    n++;
    if (it.est) { bytes += it.est; byType[it.kind] = (byType[it.kind] || 0) + it.est; } else unknown++;
  }
  return { bytes, unknown, n, byType };
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
  $('#types').innerHTML = TYPES.filter(([k]) => k === 'all' || counts[k]).map(([k, label, ico]) =>
    `<button class="chip${f.type === k ? ' on' : ''}" data-type="${k}">${ico} ${label}<em>${k === 'all' ? items.length : counts[k]}</em></button>`).join('');
  const ages = AGES.filter(a => items.some(i => i.age === a));
  $('#age').innerHTML = '<option value="">Any age</option>' + ages.map(a => `<option${f.age === a ? ' selected' : ''}>${a}</option>`).join('');
  const seasons = [...new Set(items.map(i => i.season).filter(Boolean))];
  $('#season').innerHTML = '<option value="">Any time of year</option>' + seasons.map(s => `<option${f.season === s ? ' selected' : ''}>${s}</option>`).join('');
  $('#sort').value = f.sort;
  $('#unplanned').checked = f.unplanned;
  $('#unsure').checked = f.unsure;
}

function renderKids() {
  const strip = [`<button class="kid${!f.kid ? ' on' : ''}" data-kid="" style="--kc:var(--accent)"><span class="av">★</span><span><b>Everything</b><small>${items.length} items</small></span></button>`];
  for (const k of plan.kids) {
    const u = kidUse(k.id), space = (k.spaceGB || 0) * 1e9, pct = space ? Math.min(100, u.bytes / space * 100) : 0;
    strip.push(`<button class="kid${f.kid === k.id ? ' on' : ''}" data-kid="${k.id}" style="--kc:${k.color}">
      <span class="av">${esc(initials(k.name))}</span>
      <span><b>${esc(k.name)}</b><small>${u.n} planned · ${gb(u.bytes)}${space ? ' of ' + gb(space) : ''}</small>
      <span class="bar${u.bytes > space && space ? ' over' : ''}"><i style="width:${pct}%"></i></span></span></button>`);
  }
  $('#kids').innerHTML = strip.join('');
  renderKidPanel();
}

function renderKidPanel() {
  const k = plan.kids.find(x => x.id === f.kid), el = $('#kidPanel');
  if (!k) { el.hidden = true; return; }
  const u = kidUse(k.id), space = (k.spaceGB || 0) * 1e9;
  const segs = Object.entries(u.byType).sort((a, b) => b[1] - a[1]);
  const left = space - u.bytes;
  el.style.setProperty('--kc', k.color);
  el.innerHTML = `<h2>${esc(k.name)}'s player</h2>
    <div class="muted">${esc(k.device || '')}${k.storageGB ? ` · ${k.storageGB} GB phone` : ''}${space ? ` · about ${gb(space)} free for WalkieTales` : ''}</div>
    <div class="big-bar">${segs.map(([t, b]) => `<i style="width:${space ? b / Math.max(space, u.bytes) * 100 : 0}%;background:${TYPE_COLOR[t]}"></i>`).join('')}</div>
    <div class="legend">${segs.map(([t, b]) => `<span style="--c:${TYPE_COLOR[t]}">${TYPE_NAME[t]} ${gb(b)}</span>`).join('')}
      <span style="--c:var(--panel-2)">${left >= 0 ? gb(left) + ' left' : '<b style="color:var(--bad)">' + gb(-left) + ' too much</b>'}</span></div>
    <div class="muted fine" style="margin-top:6px">${u.n} planned${u.unknown ? ` · ${u.unknown} without a size yet (shown once the drive is scanned)` : ''}${items.some(i => i.exact) ? '' : ' · sizes are estimates from the length until the drive is scanned'}</div>`;
  el.hidden = false;
}

function apply(keepScroll) {
  store.set('filters', { ...f, q: '' });
  const q = norm(f.q).split(' ').filter(Boolean);
  // keep two-word names together so "iron man" or "paw patrol" match as one
  for (let i = 0; i < q.length - 1; i++) if (aliasMap.has(q[i] + q[i + 1])) { q.splice(i, 2, q[i] + ' ' + q[i + 1]); }
  const scores = new Map();
  shown = items.filter(it =>
    (f.type === 'all' || it.kind === f.type) &&
    (!f.age || it.age === f.age) &&
    (!f.season || it.season === f.season) &&
    (!f.kid || kidsOf(it.id).includes(f.kid)) &&
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
  $('#count').textContent = `${shown.length} shown${total ? ' · about ' + gb(total) : ''}`;
  const y = window.scrollY;
  rendered = 0;
  const filtered = f.type !== 'all' || f.age || f.season || f.unplanned || f.unsure || f.kid;
  $('#grid').innerHTML = shown.length ? '' : `<div class="empty">Nothing matches${filtered ? ' with these filters' : ''}.${filtered ? '<br><br><button class="btn" id="clearFilters">Clear filters</button>' : ''}</div>`;
  more();
  if (keepScroll) { while (rendered < shown.length && document.body.scrollHeight < y + innerHeight) more(); window.scrollTo(0, y); }
}

function card(it) {
  const ks = kidsOf(it.id).map(id => plan.kids.find(k => k.id === id)).filter(Boolean);
  const len = it.minutes ? (it.minutes >= 60 ? `${Math.floor(it.minutes / 60)}h ${it.minutes % 60}m` : `${it.minutes}m`) : '';
  const sub = [it.by, len].filter(Boolean).join(' · ') || it.category;
  return `<button class="card${selected.has(it.id) ? ' sel' : ''}" data-id="${it.id}">
    <div class="cover">${coverHtml(it)}<span class="badge">${TYPE_ICON[it.kind] || ''} ${it.season || TYPE_NAME[it.kind] || ''}</span>
      <span class="dots">${ks.map(k => `<i style="--kc:${k.color}" title="${esc(k.name)}">${esc(initials(k.name))}</i>`).join('')}</span>
      <span class="tick">✓</span></div>
    <div class="t">${esc(it.title)}</div><div class="s">${esc(sub)}</div>
    <div class="meta"><span>${TYPE_ICON[it.kind] || ''} ${esc(it.season || TYPE_NAME[it.kind] || '')}${it.age ? ' · ' + esc(it.age) : ''}${it.est ? ' · ' + (it.exact ? '' : '≈') + gb(it.est) : ''}</span>
      <span class="dots">${ks.map(k => `<i style="--kc:${k.color}" title="${esc(k.name)}">${esc(initials(k.name))}</i>`).join('')}</span></div></button>`;
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
      <div class="assign">${plan.kids.map(k => `<button data-assign="${k.id}" class="${kidsOf(id).includes(k.id) ? 'on' : ''}" style="--kc:${k.color}"><span class="av">${esc(initials(k.name))}</span>${esc(k.name)}</button>`).join('')}</div>
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
      <button data-del="${i}" aria-label="Remove ${esc(k.name)}" title="Remove">✕</button></div>`).join('');
}

// ------------------------------------------------------------------------------------------- events

let qTimer = 0;
$('#q').addEventListener('input', e => { clearTimeout(qTimer); qTimer = setTimeout(() => { f.q = e.target.value; apply(); }, 150); });
$('#types').addEventListener('click', e => { const b = e.target.closest('[data-type]'); if (!b) return; f.type = b.dataset.type; buildFilters(); apply(); });
$('#age').addEventListener('change', e => { f.age = e.target.value; apply(); });
$('#season').addEventListener('change', e => { f.season = e.target.value; apply(); });
$('#sort').addEventListener('change', e => { f.sort = e.target.value; apply(); });
$('#unplanned').addEventListener('change', e => { f.unplanned = e.target.checked; apply(); });
$('#unsure').addEventListener('change', e => { f.unsure = e.target.checked; apply(); });
$('#kids').addEventListener('click', e => {
  const b = e.target.closest('[data-kid]'); if (!b) return;
  f.kid = f.kid === b.dataset.kid ? '' : b.dataset.kid;
  renderKids(); apply(); window.scrollTo({ top: 0, behavior: 'smooth' });
});

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
