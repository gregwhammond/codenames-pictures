/* Crop Studio: review and edit crop records (art/crops/<id>.json).
   Boxes are fractions of the rotated original; all geometry here works in
   rotated-original pixels (W x H) and converts back to fractions on write. */
'use strict';

const $ = (sel, el = document) => el.querySelector(sel);
const COLORS = ['#ffd000', '#22d3ee', '#ff5ea8', '#7dff6a', '#ff8a3d', '#b18cff', '#ffffff', '#4f9dff'];
const STATUS_LABEL = { auto: 'needs review', adjusted: 'adjusted', approved: 'approved', rejected: 'rejected' };
const TODO = new Set(['auto', 'adjusted']);
const FILTERS = [
  ['all', 'All'], ['todo', 'To do'], ['auto', 'Needs review'], ['adjusted', 'Adjusted'],
  ['approved', 'Approved'], ['rejected', 'Rejected'], ['legacy', 'Legacy'], ['missing', 'Source missing'],
];
const SAVE_DELAY = 700;
const HISTORY_KEEP = 20;

// ---------- small helpers ----------

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem('studio.' + key);
    localStorage.setItem('studio.' + key, value);
  } catch (e) { /* private mode etc. */ }
  return null;
}
const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const r5 = (v) => Math.round(v * 1e5) / 1e5;
const f5 = (v) => Math.floor(v * 1e5 + 1e-9) / 1e5;
const sameBox = (a, b) => !!a && !!b && ['x', 'y', 'w', 'h'].every((k) => Math.abs(a[k] - b[k]) < 1e-6);
const candBox = (c) => (c && c.box ? c.box : c && typeof c.x === 'number' ? c : null);
// JSON with sorted keys, to compare records regardless of key order.
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',')}}`
    : JSON.stringify(v ?? null));
const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

let toastTimer = null;
function toast(msg, bad = false, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (bad ? ' bad' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------- state ----------

const S = {
  records: [],          // entries from /api/records (+ _base)
  byId: new Map(),
  filter: store('filter') || 'all',
  text: store('text') || '',
  heat: false,
  ed: null,             // the open editor (see newEditor)
  eds: new Map(),       // id -> editors left while still saving, unsaved or failed
};
if (!FILTERS.some(([k]) => k === S.filter)) S.filter = 'all';

const SERVER_KEYS = ['version', 'source_missing', 'image_size', '_base'];
function strip(entry) {
  const r = clone(entry);
  for (const k of SERVER_KEYS) delete r[k];
  return r;
}
function baseSize(entry) {
  const [w, h] = entry.image_size || entry.source_size || [1, 1];
  return (entry.rotate || 0) % 180 ? [h, w] : [w, h];
}
function sizeFor(base, rotate) {
  return (rotate || 0) % 180 ? [base[1], base[0]] : [base[0], base[1]];
}
function addEntry(entry) {
  entry._base = baseSize(entry);
  const i = S.records.findIndex((e) => e.id === entry.id);
  if (i >= 0) S.records[i] = entry; else S.records.push(entry);
  S.byId.set(entry.id, entry);
}
function entryFromSaved(record, version, old) {
  const e = clone(record);
  e.version = version;
  e.source_missing = old ? old.source_missing : false;
  e.image_size = sizeFor(old ? old._base : baseSize(record), record.rotate);
  return e;
}

const sha8 = (rec) => (rec.source_sha256 || '').slice(0, 12);
function srcUrl(rec, small = false) {
  return `/api/source/${encodeURIComponent(rec.id)}.jpg?rotate=${rec.rotate || 0}&v=${sha8(rec)}${small ? '&small=1' : ''}`;
}
function tileUrl(rec, crop) {
  let u = `/api/tile/${encodeURIComponent(rec.id)}/${encodeURIComponent(crop.tile)}.jpg?mode=${crop.mode}&rotate=${rec.rotate || 0}&v=${sha8(rec)}`;
  if (crop.mode === 'crop' && crop.box) u += '&box=' + ['x', 'y', 'w', 'h'].map((k) => crop.box[k]).join(',');
  return u;
}
function heatUrl(rec) {
  return `/api/heatmap/${encodeURIComponent(rec.id)}.png?rotate=${rec.rotate || 0}&v=${sha8(rec)}`;
}

async function loadRecords() {
  const res = await fetch('/api/records', { cache: 'no-store' });
  if (!res.ok) throw new Error(`records: HTTP ${res.status}`);
  const list = await res.json();
  S.records = [];
  S.byId = new Map();
  for (const e of list) addEntry(e);
  S.records.sort((a, b) => a.id.localeCompare(b.id));
}

// ---------- queue ----------

function textMatch(e) {
  const q = S.text.trim().toLowerCase();
  if (!q) return true;
  return e.id.toLowerCase().startsWith(q) || String(e.meta?.title || '').toLowerCase().includes(q);
}
function cropMatch(e, c) {
  switch (S.filter) {
    case 'all': return true;
    case 'todo': return TODO.has(c.status);
    case 'legacy': return c.mode === 'legacy';
    case 'missing': return !!e.source_missing;
    default: return c.status === S.filter;
  }
}
function needsWork(e) {
  return !e.source_missing && (e.crops || []).some((c) => TODO.has(c.status));
}

function countAll() {
  const n = { crops: 0, all: 0, todo: 0, auto: 0, adjusted: 0, approved: 0, rejected: 0, legacy: 0, missing: 0 };
  for (const e of S.records) {
    for (const c of e.crops || []) {
      n.all++;
      n[c.status] = (n[c.status] || 0) + 1;
      if (TODO.has(c.status)) n.todo++;
      if (c.mode === 'legacy') n.legacy++;
      if (e.source_missing) n.missing++;
    }
  }
  return n;
}

function thumbHTML(e, c) {
  if (e.source_missing) return '<div class="thumb missing">source missing</div>';
  if (c.mode === 'legacy') return `<img class="thumb" loading="lazy" alt="" src="${esc(tileUrl(e, c))}">`;
  const url = esc(srcUrl(e, true));
  if (c.mode === 'fit' || !c.box) return `<div class="thumb fit lazy" data-bg="${url}"></div>`;
  const b = c.box;
  const bs = `${100 / b.w}% ${100 / b.h}%`;
  const px = b.w < 0.99999 ? (b.x / (1 - b.w)) * 100 : 0;
  const py = b.h < 0.99999 ? (b.y / (1 - b.h)) * 100 : 0;
  return `<div class="thumb lazy" data-bg="${url}" style="--bs:${bs};--bp:${px}% ${py}%"></div>`;
}

function badgesHTML(e, c) {
  const out = [];
  if (e.source_missing) out.push('<span class="badge b-missing">source missing</span>');
  out.push(`<span class="badge b-${c.status}">${esc(STATUS_LABEL[c.status] || c.status)}</span>`);
  if (c.mode === 'legacy') out.push('<span class="badge b-legacy">legacy</span>');
  if (c.mode === 'fit') out.push('<span class="badge b-fit">fit</span>');
  return `<span class="badges">${out.join('')}</span>`;
}

let thumbObserver = null;
function renderQueue() {
  const n = countAll();
  $('#counts').innerHTML = `<b>${S.records.length}</b> pictures, <b>${n.all}</b> crops: `
    + `<b>${n.auto}</b> need review, <b>${n.adjusted}</b> adjusted, <b>${n.approved}</b> approved, `
    + `<b>${n.rejected}</b> rejected` + (n.missing ? `, <b>${n.missing}</b> with missing source` : '');
  $('#chips').innerHTML = FILTERS.map(([k, label]) =>
    `<button type="button" class="chip" role="radio" data-f="${k}" aria-checked="${S.filter === k}">${label}<span class="n">${n[k] ?? 0}</span></button>`
  ).join('');

  const groups = S.records.filter((e) => textMatch(e) && (e.crops || []).some((c) => cropMatch(e, c)));
  groups.sort((a, b) => (needsWork(b) - needsWork(a)) || (a.source_missing - b.source_missing) || a.id.localeCompare(b.id));
  let shown = 0;
  const html = groups.map((e) => {
    const tiles = (e.crops || []).map((c) => {
      const m = cropMatch(e, c);
      if (m) shown++;
      return `<button type="button" class="tile st-${esc(c.status)}${m ? '' : ' dim'}" data-id="${esc(e.id)}" data-tile="${esc(c.tile)}" title="${esc(c.tile)}: ${esc(STATUS_LABEL[c.status] || c.status)}">`
        + thumbHTML(e, c) + `<span class="tname">${esc(c.tile)}</span>` + badgesHTML(e, c) + '</button>';
    }).join('');
    return `<section class="group${e.source_missing ? ' missing' : ''}"><div class="ghead"><span class="gid">${esc(e.id)}</span>`
      + `<span class="gtitle">${esc(e.meta?.title || '')}</span></div><div class="gtiles">${tiles}</div></section>`;
  }).join('');
  $('#groups').innerHTML = html || '<p class="empty">Nothing matches these filters.</p>';
  $('#showing').textContent = `Showing ${shown} crop${shown === 1 ? '' : 's'} from ${groups.length} picture${groups.length === 1 ? '' : 's'}; unapproved first.`;
  $('#review-next').disabled = !nextTodo(null, null);

  if (thumbObserver) thumbObserver.disconnect();
  const lazy = document.querySelectorAll('.thumb.lazy');
  const load = (el) => { el.style.backgroundImage = `url("${el.dataset.bg}")`; el.classList.remove('lazy'); };
  if ('IntersectionObserver' in window) {
    thumbObserver = new IntersectionObserver((items) => {
      for (const it of items) if (it.isIntersecting) { load(it.target); thumbObserver.unobserve(it.target); }
    }, { rootMargin: '400px' });
    lazy.forEach((el) => thumbObserver.observe(el));
  } else lazy.forEach(load);
}

// Next crop needing review after (id, tile), in id order, wrapping around.
function nextTodo(id, tile) {
  const list = [];
  for (const e of S.records) {
    if (e.source_missing || !textMatch(e)) continue;
    const rec = S.ed && S.ed.id === e.id ? S.ed.rec : e;
    for (const c of rec.crops || []) list.push([e.id, c.tile, TODO.has(c.status)]);
  }
  const start = list.findIndex(([i, t]) => i === id && t === tile);
  for (let k = 1; k <= list.length; k++) {
    const [i, t, todo] = list[(start + k + list.length) % list.length];
    if (todo && !(i === id && t === tile)) return [i, t];
  }
  return null;
}

// ---------- routing ----------

function go(hash) {
  if (location.hash === hash) route(); else location.hash = hash;
}
function editHash(id, tile) {
  return `#/edit/${encodeURIComponent(id)}/${encodeURIComponent(tile)}`;
}
function goNext(fromId, fromTile) {
  const nx = nextTodo(fromId, fromTile);
  if (nx) go(editHash(nx[0], nx[1]));
  else { toast('Nothing left to review.'); go('#/'); }
}

function route() {
  const m = location.hash.match(/^#\/edit\/([^/]+)\/([^/]+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const tile = decodeURIComponent(m[2]);
    if (S.byId.has(id)) return openEditor(id, tile);
    toast(`No record ${id}`, true);
  }
  if (S.ed) { flush(S.ed); }
  $('#editor-view').hidden = true;
  $('#queue-view').hidden = false;
  document.title = 'Crop Studio';
  renderQueue();
}

// ---------- editor state ----------

function newEditor(entry) {
  return {
    id: entry.id,
    rec: strip(entry),
    saved: strip(entry),
    version: entry.version,
    base: entry._base,
    missing: !!entry.source_missing,
    active: null,
    dirty: false,
    timer: null,
    saving: null,
    retry: null,
    retryDelay: 0,
    failed: false,        // the server refused the last save (4xx); edit not stored
  };
}
// An editor that still holds work the server does not have (or may not have yet).
const pending = (ed) => !!ed && (ed.dirty || !!ed.saving || ed.failed);
const dims = (ed = S.ed) => sizeFor(ed.base, ed.rec.rotate);
const activeCrop = (ed = S.ed) => ed && ed.rec.crops.find((c) => c.tile === ed.active);
const colorOf = (ed, crop) => COLORS[ed.rec.crops.indexOf(crop) % COLORS.length];
const minSide = (W, H) => Math.max(16, 0.03 * Math.min(W, H));

function pxBox(crop, W, H) {
  const b = crop.box;
  const s = Math.min(b.w * W, b.h * H);
  return { x: b.x * W, y: b.y * H, s };
}
function setPx(crop, x, y, s) {
  const [W, H] = dims();
  s = clamp(s, Math.min(minSide(W, H), Math.min(W, H)), Math.min(W, H));
  x = clamp(x, 0, W - s);
  y = clamp(y, 0, H - s);
  const w = f5(s / W);
  const h = f5(s / H);
  crop.box = {
    x: clamp(r5(x / W), 0, f5(1 - w)),
    y: clamp(r5(y / H), 0, f5(1 - h)),
    w, h,
  };
}
function centredBox(side) {
  const [W, H] = dims();
  const s = side || Math.min(W, H);
  const c = { box: null };
  setPx(c, (W - s) / 2, (H - s) / 2, s);
  return c.box;
}

// Any box change: legacy/fit becomes a crop, status becomes adjusted.
function touch(crop) {
  if (crop.status !== 'adjusted') crop.status = 'adjusted';
}
function editable(crop, quiet = false) {
  if (!crop || crop.status === 'rejected') return null;
  if (crop.mode === 'fit') {
    if (!quiet) toast('This tile shows the whole picture. Press F to go back to a crop box.');
    return null;
  }
  if (crop.mode === 'legacy' || !crop.box) {
    crop.mode = 'crop';
    crop.box = centredBox();
    touch(crop);
  }
  return crop;
}

function changed() {
  scheduleSave(S.ed);
  renderEditor();
}

// ---------- saving ----------

function setSaveState(ed, state, msg) {
  ed.state = state;
  if (S.ed !== ed) return;
  const el = $('#save-state');
  const text = { saved: 'Saved', unsaved: 'Unsaved', saving: 'Saving…', conflict: 'Reloaded after conflict', error: 'Not saved', retrying: 'Server error, retrying', offline: 'Offline, retrying…' }[state];
  el.textContent = msg ? `${text}: ${msg}` : text;
  el.className = 'save-state s-' + state;
}

function scheduleSave(ed) {
  ed.dirty = true;
  setSaveState(ed, 'unsaved');
  clearTimeout(ed.timer);
  ed.timer = setTimeout(() => flush(ed), SAVE_DELAY);
}

// Append the previously saved box of every crop whose box or mode changed.
function withHistory(ed) {
  const rec = clone(ed.rec);
  const at = nowIso();
  for (const c of rec.crops) {
    const prev = ed.saved.crops.find((p) => p.tile === c.tile);
    if (!prev) continue;
    const moved = prev.mode !== c.mode || (ed.saved.rotate || 0) !== (rec.rotate || 0)
      || JSON.stringify(prev.box ?? null) !== JSON.stringify(c.box ?? null);
    if (moved) {
      c.history = [...(c.history || []), { box: prev.box ?? null, mode: prev.mode, rotate: ed.saved.rotate || 0, at }].slice(-HISTORY_KEEP);
    }
  }
  return rec;
}

async function flush(ed) {
  if (!ed) return;
  clearTimeout(ed.timer);
  ed.timer = null;
  while (ed.saving) await ed.saving.catch(() => {});
  if (!ed.dirty) return;
  ed.dirty = false;
  const sent = withHistory(ed);
  setSaveState(ed, 'saving');
  const p = (async () => {
    let res;
    let body;
    try {
      res = await fetch(`/api/records/${encodeURIComponent(ed.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: ed.version, record: sent }),
        keepalive: true,
      });
      body = await res.json().catch(() => ({}));
    } catch (err) {
      res = null;
    }
    // A 409 whose disk copy is exactly what we sent means an earlier attempt of
    // this very save already landed: that is a success, not a conflict.
    if (res && res.status === 409 && body.record && canon(strip(body.record)) === canon(sent)) {
      res = { status: 200 };
    }
    if (res && res.status === 200) {
      ed.failed = false;
      ed.retryDelay = 0;
      for (const c of ed.rec.crops) {
        const s = sent.crops.find((x) => x.tile === c.tile);
        if (s && s.history) c.history = s.history;
      }
      ed.version = body.version;
      ed.saved = clone(body.record);
      addEntry(entryFromSaved(body.record, body.version, S.byId.get(ed.id)));
      setSaveState(ed, ed.dirty ? 'unsaved' : 'saved');
    } else if (res && res.status === 409) {
      ed.rec = strip(body.record);
      ed.saved = strip(body.record);
      ed.version = body.version;
      ed.dirty = false;
      ed.failed = false;
      ed.retryDelay = 0;
      clearTimeout(ed.timer);
      addEntry(entryFromSaved(body.record, body.version, S.byId.get(ed.id)));
      if (!ed.rec.crops.some((c) => c.tile === ed.active)) ed.active = ed.rec.crops[0]?.tile;
      setSaveState(ed, 'conflict');
      toast(`${ed.id} was changed somewhere else. Reloaded the saved version; your last change was not saved.`, true, 6000);
      if (S.ed === ed) renderEditor();
    } else if (res && res.status >= 400 && res.status < 500) {
      // Refused: keep the edit (ed.rec) and remember it is not stored, so
      // leaving this record or the page asks first. The next edit retries.
      ed.failed = true;
      const why = res.status === 401 ? 'not authorised (reopen the link studio.py printed)' : body.error || `HTTP ${res.status}`;
      setSaveState(ed, 'error', why);
      toast(`${ed.id} not saved: ${why}`, true, 6000);
    } else {
      // Offline or a server error: keep retrying, backing off to a minute.
      ed.dirty = true;
      ed.retryDelay = Math.min(ed.retryDelay ? ed.retryDelay * 2 : 3000, 60000);
      if (res) {
        const why = body.error || `HTTP ${res.status}`;
        if (ed.retryDelay === 3000) toast(`${ed.id} not saved: ${why}. Retrying.`, true, 6000);
        setSaveState(ed, 'retrying', why);
      } else setSaveState(ed, 'offline');
      clearTimeout(ed.retry);
      ed.retry = setTimeout(() => flush(ed), ed.retryDelay);
    }
  })();
  ed.saving = p;
  try { await p; } finally { if (ed.saving === p) ed.saving = null; }
}

// ---------- editor view ----------

// Leaving an editor whose last save was refused drops that edit: ask first.
// (While a newer save is queued or in flight it is kept in S.eds instead.)
function mayLeave(ed) {
  if (!ed || !ed.failed || ed.dirty || ed.saving) return true;
  if (!window.confirm(`${ed.id}: your last change was not saved. Leave it anyway?`)) return false;
  ed.failed = false;
  return true;
}

function openEditor(id, tile) {
  const entry = S.byId.get(id);
  if (!S.ed || S.ed.id !== id) {
    const old = S.ed;
    if (old) {
      if (!mayLeave(old)) {
        history.replaceState(null, '', editHash(old.id, old.active));
        if ($('#editor-view').hidden) openEditor(old.id, old.active);
        return;
      }
      flush(old);
      // Still saving or unsaved: keep it, so reopening it continues from its
      // own state and version instead of a stale copy (which would 409).
      if (pending(old)) S.eds.set(old.id, old);
    }
    const kept = S.eds.get(id);
    S.eds.delete(id);
    S.ed = pending(kept) ? kept : newEditor(entry);
  }
  const ed = S.ed;
  const crop = ed.rec.crops.find((c) => c.tile === tile)
    || ed.rec.crops.find((c) => c.status !== 'rejected') || ed.rec.crops[0];
  ed.active = crop.tile;
  $('#queue-view').hidden = true;
  $('#editor-view').hidden = false;
  document.title = `${id} · Crop Studio`;
  setSaveState(ed, ed.state || 'saved');
  renderEditor();
  window.scrollTo(0, 0);
}

function renderEditor() {
  const ed = S.ed;
  if (!ed) return;
  const rec = ed.rec;
  const crop = activeCrop();
  $('#ed-id').textContent = rec.id;
  $('#ed-meta').textContent = [rec.meta?.title, rec.meta?.note].filter(Boolean).join(' · ');

  // image
  const img = $('#src');
  const want = ed.missing ? '' : srcUrl(rec);
  if (img.dataset.url !== want) {
    img.dataset.url = want;
    if (want) img.src = want; else img.removeAttribute('src');
  }
  const msg = $('#stage-msg');
  msg.hidden = !ed.missing;
  msg.textContent = ed.missing ? `Source file is missing: ${rec.source}` : '';
  const heat = $('#heat');
  if (S.heat && !ed.missing) {
    const hu = heatUrl(rec);
    if (heat.dataset.url !== hu) { heat.dataset.url = hu; heat.src = hu; }
    heat.hidden = false;
  } else heat.hidden = true;
  $('#b-heat').setAttribute('aria-pressed', String(S.heat));

  // tabs
  $('#tabs').innerHTML = rec.crops.map((c, i) =>
    `<button type="button" data-tile="${esc(c.tile)}" aria-current="${c.tile === ed.active}" class="${c.status === 'rejected' ? 'rejected' : ''}" title="${i < 9 ? 'Key ' + (i + 1) : ''}">`
    + `<span class="dot" style="background:${COLORS[i % COLORS.length]}"></span>${esc(c.tile)} <span class="st">${esc(c.mode === 'legacy' ? 'legacy, ' : c.mode === 'fit' ? 'fit, ' : '')}${esc(STATUS_LABEL[c.status] || c.status)}</span></button>`
  ).join('');

  renderOverlay();
  renderPreviews();

  // info + warnings
  const [W, H] = dims();
  let info = `<b>${esc(crop.tile)}</b>: ${esc(STATUS_LABEL[crop.status] || crop.status)}, `;
  if (crop.mode === 'crop' && crop.box) {
    const s = Math.round(pxBox(crop, W, H).s);
    info += `${s} px square of ${W}×${H}`;
    if (s < 400) info += ' <span class="low">(below 400 px: will look soft)</span>';
  } else if (crop.mode === 'fit') info += 'whole picture on a blurred background';
  else info += 'legacy build treatment (exact preview)';
  if (crop.auto && crop.auto.engine) info += `<br>auto: ${esc(crop.auto.engine)}${crop.auto.score != null ? ', score ' + esc(Number(crop.auto.score).toFixed(2)) : ''}`;
  if (rec.rotate) info += `<br>rotated ${rec.rotate}°`;
  $('#info').innerHTML = info;

  const warns = overlaps().map(([a, b]) => `${esc(a.tile)} and ${esc(b.tile)} overlap.`);
  const warn = $('#warn');
  warn.hidden = !warns.length;
  warn.innerHTML = warns.join('<br>');

  const note = $('#stage-note');
  let noteText = '';
  if (crop.status === 'rejected') noteText = 'This box is removed. Press "Restore box" to use it again.';
  else if (crop.mode === 'legacy') noteText = 'Legacy crop: the tile is made exactly as before (see preview). Drag on the picture or use the slider to switch to a crop box.';
  else if (crop.mode === 'fit') noteText = 'Fit: the whole picture goes on a blurred background. Press F to crop instead.';
  note.textContent = noteText;
  note.hidden = !noteText || ed.missing;

  // buttons
  const rejected = crop.status === 'rejected';
  const options = cycleOptions(crop);
  $('#b-approve').disabled = ed.missing;
  $('#b-reset').disabled = rejected || !(crop.auto && crop.auto.box);
  $('#b-another').disabled = rejected || options.length < (crop.mode === 'crop' && options.some((o) => sameBox(o, crop.box)) ? 2 : 1);
  $('#b-fit').disabled = rejected || ed.missing;
  $('#b-fit').firstChild.textContent = crop.mode === 'fit' ? 'Back to crop ' : 'Fit whole picture ';
  $('#b-rotate').disabled = ed.missing;
  $('#b-heat').disabled = ed.missing;
  $('#b-add').disabled = ed.missing || !freeTileName();
  $('#b-remove').textContent = rejected ? 'Restore box' : 'Remove box';
  $('#b-remove').disabled = ed.missing;

  const size = $('#size');
  size.disabled = rejected || crop.mode === 'fit' || ed.missing;
  if (crop.mode === 'crop' && crop.box) size.value = String(Math.round((pxBox(crop, W, H).s / Math.min(W, H)) * 200) / 2);
  else size.value = '100';
}

function overlaps() {
  const [W, H] = dims();
  const act = S.ed.rec.crops.filter((c) => c.status !== 'rejected' && c.mode === 'crop' && c.box);
  const out = [];
  for (let i = 0; i < act.length; i++) {
    for (let j = i + 1; j < act.length; j++) {
      const a = pxBox(act[i], W, H);
      const b = pxBox(act[j], W, H);
      const ix = Math.min(a.x + a.s, b.x + b.s) - Math.max(a.x, b.x);
      const iy = Math.min(a.y + a.s, b.y + b.s) - Math.max(a.y, b.y);
      if (ix > 0 && iy > 0 && ix * iy > 0.01 * Math.min(a.s, b.s) ** 2) out.push([act[i], act[j]]);
    }
  }
  return out;
}

function renderOverlay() {
  const ed = S.ed;
  const svg = $('#ov');
  const [W, H] = dims();
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  if (ed.missing) { svg.innerHTML = ''; return; }
  const k = W / (svg.getBoundingClientRect().width || W); // source px per screen px
  const act = activeCrop();
  const shown = ed.rec.crops.filter((c) => c.status !== 'rejected' && c.mode === 'crop' && c.box);
  shown.sort((a, b) => (a === act) - (b === act)); // active on top
  let holes = '';
  let boxes = '';
  const fs = 13 * k;
  for (const c of shown) {
    const { x, y, s } = pxBox(c, W, H);
    const col = colorOf(ed, c);
    const on = c === act;
    holes += `<rect x="${x}" y="${y}" width="${s}" height="${s}" fill="black"/>`;
    boxes += `<rect x="${x}" y="${y}" width="${s}" height="${s}" fill="none" stroke="${col}" stroke-width="${on ? 3 : 1.5}" vector-effect="non-scaling-stroke"${on ? '' : ' stroke-dasharray="6 4"'}/>`;
    const label = c.tile + (c.status === 'approved' ? ' \u2713' : '');
    const lw = label.length * 0.62 * fs + 10 * k;
    const lh = fs + 8 * k;
    const ly = y >= lh ? y - lh : y; // above the box when there is room
    boxes += `<rect x="${x}" y="${ly}" width="${Math.min(lw, W - x)}" height="${lh}" fill="${col}" opacity="${on ? 1 : 0.8}"/>`;
    boxes += `<text x="${x + 5 * k}" y="${ly + fs + 1.5 * k}" font-size="${fs}" fill="#111">${esc(label)}</text>`;
    if (on) {
      const hs = 12 * k;
      for (const [cx, cy] of [[x, y], [x + s, y], [x, y + s], [x + s, y + s]]) {
        boxes += `<rect x="${cx - hs / 2}" y="${cy - hs / 2}" width="${hs}" height="${hs}" fill="${col}" stroke="black" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
      }
    }
  }
  const dim = shown.length
    ? `<mask id="dim-mask"><rect width="${W}" height="${H}" fill="white"/>${holes}</mask><rect width="${W}" height="${H}" fill="rgba(0,0,0,0.58)" mask="url(#dim-mask)"/>`
    : '';
  svg.innerHTML = dim + boxes;
}

function drawPreview(canvas, img, size, crop) {
  const src = $('#src');
  const useCanvas = crop.mode === 'crop' && crop.box && src.complete && src.naturalWidth && !S.ed.missing;
  if (useCanvas) {
    const dpr = window.devicePixelRatio || 1;
    const px = Math.round(Math.min(size, canvas.clientWidth || size) * dpr) || size;
    if (canvas.width !== px) { canvas.width = px; canvas.height = px; }
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    const nw = src.naturalWidth;
    const nh = src.naturalHeight;
    const b = crop.box;
    const side = Math.min(b.w * nw, b.h * nh);
    ctx.drawImage(src, b.x * nw, b.y * nh, side, side, 0, 0, px, px);
    canvas.hidden = false;
    img.hidden = true;
  } else if (!S.ed.missing && crop.mode !== 'crop') {
    const u = tileUrl(S.ed.rec, crop);
    if (img.dataset.url !== u) { img.dataset.url = u; img.src = u; }
    img.hidden = false;
    canvas.hidden = true;
  } else {
    canvas.hidden = false;
    img.hidden = true;
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  }
}

function renderPreviews() {
  const crop = activeCrop();
  if (!crop) return;
  drawPreview($('#pv80c'), $('#pv80i'), 80, crop);
  drawPreview($('#pv400c'), $('#pv400i'), 400, crop);
  $('#pv-cap').textContent = crop.mode === 'crop' ? '400 px tile (live preview)' : '400 px tile (exact server render)';
}

// ---------- editor actions ----------

function cycleOptions(crop) {
  const opts = [];
  const add = (b) => { if (b && !opts.some((o) => sameBox(o, b))) opts.push(b); };
  add(crop.auto && crop.auto.box);
  for (const c of crop.candidates || []) add(candBox(c));
  return opts;
}

function freeTileName() {
  const used = new Set(S.ed.rec.crops.map((c) => c.tile));
  for (let i = 1; i <= 24; i++) {
    const name = `${S.ed.id}-${String.fromCharCode(97 + i)}`;
    if (!used.has(name)) return name;
  }
  return null;
}

function act(name) {
  const ed = S.ed;
  if (!ed || ed.missing) return;
  const crop = activeCrop();
  const [W, H] = dims();
  switch (name) {
    case 'approve': {
      if (crop.status === 'rejected') crop.status = 'adjusted';
      crop.status = 'approved';
      scheduleSave(ed);
      flush(ed);
      renderEditor();
      goNext(ed.id, crop.tile);
      return;
    }
    case 'skip':
      flush(ed);
      goNext(ed.id, crop.tile);
      return;
    case 'reset':
      if (!crop.auto || !crop.auto.box || crop.status === 'rejected') return;
      crop.mode = 'crop';
      crop.box = clone(crop.auto.box);
      crop.status = 'auto';
      break;
    case 'another': {
      if (crop.status === 'rejected') return;
      const opts = cycleOptions(crop);
      if (!opts.length) { toast('No other suggestions for this picture.'); return; }
      const i = crop.mode === 'crop' ? opts.findIndex((o) => sameBox(o, crop.box)) : -1;
      const n = (i + 1) % opts.length;
      if (i >= 0 && n === i) { toast('No other suggestions for this picture.'); return; }
      crop.mode = 'crop';
      crop.box = clone(opts[n]);
      touch(crop);
      toast(`Suggestion ${n + 1} of ${opts.length}`, false, 1500);
      break;
    }
    case 'fit':
      if (crop.status === 'rejected') return;
      if (crop.mode === 'fit') {
        crop.mode = 'crop';
        if (!crop.box) crop.box = centredBox();
      } else crop.mode = 'fit';
      touch(crop);
      break;
    case 'rotate':
      rotateRecord();
      break;
    case 'heat':
      S.heat = !S.heat;
      renderEditor();
      return;
    case 'add': {
      const tile = freeTileName();
      if (!tile) { toast('No more names for extra crops.', true); return; }
      const c = { tile, mode: 'crop', box: placeNewBox(W, H), status: 'adjusted', auto: null };
      ed.rec.crops.push(c);
      ed.active = tile;
      toast(`Added ${tile}`, false, 1500);
      break;
    }
    case 'remove':
      if (crop.status === 'rejected') crop.status = 'adjusted';
      else {
        crop.status = 'rejected';
        const other = ed.rec.crops.find((c) => c.status !== 'rejected');
        if (other) ed.active = other.tile;
        toast(`Removed ${crop.tile}. Its box is kept; pick it in the tabs to restore it.`, false, 3500);
      }
      break;
    default:
      return;
  }
  changed();
}

function rotBox(b) {
  if (!b || typeof b.x !== 'number') return b;
  return { x: Math.max(0, r5(1 - b.y - b.h)), y: b.x, w: b.h, h: b.w };
}
function rotateRecord() {
  const rec = S.ed.rec;
  rec.rotate = ((rec.rotate || 0) + 90) % 360;
  for (const c of rec.crops) {
    c.box = rotBox(c.box);
    if (c.auto && c.auto.box) c.auto.box = rotBox(c.auto.box);
    if (Array.isArray(c.candidates)) c.candidates = c.candidates.map((x) => (x && x.box ? { ...x, box: rotBox(x.box) } : rotBox(x)));
    if (c.status !== 'rejected') touch(c);
  }
}

function placeNewBox(W, H) {
  const s = 0.5 * Math.min(W, H);
  const others = S.ed.rec.crops.filter((c) => c.status !== 'rejected' && c.mode === 'crop' && c.box).map((c) => pxBox(c, W, H));
  let best = null;
  for (let i = 0; i <= 4; i++) {
    for (let j = 0; j <= 4; j++) {
      const x = ((W - s) * i) / 4;
      const y = ((H - s) * j) / 4;
      let ov = 0;
      for (const o of others) {
        const ix = Math.min(x + s, o.x + o.s) - Math.max(x, o.x);
        const iy = Math.min(y + s, o.y + o.s) - Math.max(y, o.y);
        if (ix > 0 && iy > 0) ov += ix * iy;
      }
      const d = Math.hypot(x + s / 2 - W / 2, y + s / 2 - H / 2);
      const score = ov * 10 + d;
      if (!best || score < best.score) best = { x, y, score };
    }
  }
  const c = { box: null };
  setPx(c, best.x, best.y, s);
  return c.box;
}

function resizeActive(factorOrSide, isSide = false, quiet = false) {
  const crop = editable(activeCrop(), quiet);
  if (!crop) return false;
  const [W, H] = dims();
  const { x, y, s } = pxBox(crop, W, H);
  const ns = isSide ? factorOrSide : s * factorOrSide;
  const cx = x + s / 2;
  const cy = y + s / 2;
  setPx(crop, cx - ns / 2, cy - ns / 2, ns);
  touch(crop);
  return true;
}

function nudge(dx, dy) {
  const crop = editable(activeCrop());
  if (!crop) return;
  const [W, H] = dims();
  const { x, y, s } = pxBox(crop, W, H);
  setPx(crop, x + dx, y + dy, s);
  touch(crop);
  changed();
}

// ---------- pointer interaction on the picture ----------

const ptrs = new Map();
let drag = null;

function toSrc(e) {
  const svg = $('#ov');
  const r = svg.getBoundingClientRect();
  const [W, H] = dims();
  return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H, k: W / r.width };
}

function hit(p, touchPtr) {
  const ed = S.ed;
  const [W, H] = dims();
  const tol = (touchPtr ? 22 : 12) * p.k;
  const act = activeCrop();
  if (act && act.status !== 'rejected' && act.mode === 'crop' && act.box) {
    const { x, y, s } = pxBox(act, W, H);
    const corners = [[x, y, 1, 1], [x + s, y, -1, 1], [x, y + s, 1, -1], [x + s, y + s, -1, -1]];
    for (const [cx, cy, ax, ay] of corners) {
      if (Math.abs(p.x - cx) <= tol && Math.abs(p.y - cy) <= tol) {
        // anchor = the opposite corner; sx/sy = direction the grabbed corner grows
        return { kind: 'resize', crop: act, ax: ax > 0 ? x + s : x, ay: ay > 0 ? y + s : y, sx: -ax, sy: -ay };
      }
    }
  }
  const inside = (c) => { const b = pxBox(c, W, H); return p.x >= b.x && p.x <= b.x + b.s && p.y >= b.y && p.y <= b.y + b.s; };
  const boxes = ed.rec.crops.filter((c) => c.status !== 'rejected' && c.mode === 'crop' && c.box);
  if (act && boxes.includes(act) && inside(act)) return { kind: 'move', crop: act };
  const hits = boxes.filter(inside).sort((a, b) => pxBox(a, W, H).s - pxBox(b, W, H).s);
  if (hits.length) return { kind: 'move', crop: hits[0] };
  return null;
}

// A press only becomes a drag once the pointer has travelled this far (CSS px),
// so taps and clicks (which often jitter by a pixel or two) never move a box,
// un-approve it, or turn a legacy crop into a crop box.
const DRAG_SLOP = { mouse: 4, pen: 6, touch: 8 };
const PINCH_SLOP = 0.04; // pinch distance must change by 4 % before it counts
const isBoxCrop = (c) => !!c && c.status !== 'rejected' && c.mode === 'crop' && !!c.box;

function pinchDist() {
  const [a, b] = [...ptrs.values()];
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function onDown(e) {
  if (!S.ed || S.ed.missing || e.button > 0) return;
  const svg = $('#ov');
  try { svg.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  const p = toSrc(e);
  ptrs.set(e.pointerId, p);
  e.preventDefault();
  if (ptrs.size === 2) {
    // A legacy crop is converted only once the pinch really changes size.
    const crop = activeCrop();
    const ok = crop && crop.status !== 'rejected' && (crop.mode === 'legacy' || isBoxCrop(crop));
    const before = !!(drag && drag.moved); // a one-finger drag that already moved a box
    drag = ok ? { kind: 'pinch', crop, d0: pinchDist(), s0: null, moved: false, before } : null;
    if (!drag && before) changed();
    return;
  }
  if (ptrs.size > 2) return;
  let h = hit(p, e.pointerType === 'touch');
  if (!h) {
    const act = activeCrop();
    if (!act || act.mode !== 'legacy' || act.status === 'rejected') return;
    // Pending: becomes a crop box only if the pointer is dragged past the slop.
    h = { kind: 'convert', crop: act };
  }
  if (h.crop.tile !== S.ed.active) { S.ed.active = h.crop.tile; renderEditor(); }
  const [W, H] = dims();
  drag = {
    ...h, p0: p, b0: h.kind === 'convert' ? null : pxBox(h.crop, W, H), moved: false,
    cx0: e.clientX, cy0: e.clientY, slop: DRAG_SLOP[e.pointerType] ?? 6,
  };
}

function onMove(e) {
  const svg = $('#ov');
  if (!S.ed) return;
  const p = toSrc(e);
  if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, p);
  if (!drag) {
    if (e.pointerType === 'mouse') {
      const h = hit(p, false);
      svg.style.cursor = !h ? 'default' : h.kind === 'move' ? 'move' : (h.sx === h.sy ? 'nwse-resize' : 'nesw-resize');
    }
    return;
  }
  if (!ptrs.has(e.pointerId)) return;
  if (!drag.moved) {
    if (drag.kind === 'pinch') {
      if (ptrs.size < 2 || Math.abs(pinchDist() / Math.max(1, drag.d0) - 1) < PINCH_SLOP) return;
    } else if (Math.hypot(e.clientX - drag.cx0, e.clientY - drag.cy0) < drag.slop) return;
    // A real drag: only now may a legacy crop become a crop box.
    const crop = editable(drag.crop, true);
    if (!crop) { drag = null; return; }
    const [W0, H0] = dims();
    if (drag.kind === 'convert') { drag.kind = 'move'; drag.b0 = pxBox(crop, W0, H0); }
    if (drag.kind === 'pinch') {
      drag.s0 = pxBox(crop, W0, H0).s;
      drag.d0 = pinchDist(); // start from here so the box does not jump by the slop
    }
    drag.moved = true;
    touch(crop);
    renderEditor();
  }
  const [W, H] = dims();
  const crop = drag.crop;
  if (drag.kind === 'pinch') {
    if (ptrs.size < 2) return;
    const s = drag.s0 * (pinchDist() / Math.max(1, drag.d0));
    const cur = pxBox(crop, W, H);
    setPx(crop, cur.x + cur.s / 2 - s / 2, cur.y + cur.s / 2 - s / 2, s);
  } else if (drag.kind === 'move') {
    setPx(crop, drag.b0.x + (p.x - drag.p0.x), drag.b0.y + (p.y - drag.p0.y), drag.b0.s);
  } else {
    const dx = (p.x - drag.ax) * drag.sx;
    const dy = (p.y - drag.ay) * drag.sy;
    const room = Math.min(drag.sx > 0 ? W - drag.ax : drag.ax, drag.sy > 0 ? H - drag.ay : drag.ay);
    const s = clamp(Math.max(dx, dy), Math.min(minSide(W, H), room), room);
    setPx(crop, drag.sx > 0 ? drag.ax : drag.ax - s, drag.sy > 0 ? drag.ay : drag.ay - s, s);
  }
  renderOverlay();
  renderPreviews();
}

function onUp(e) {
  ptrs.delete(e.pointerId);
  if (!drag) return;
  if (drag.kind === 'pinch' && ptrs.size >= 2) return;
  const moved = drag.moved || drag.before;
  drag = null;
  if (moved) changed();
}

// The wheel only resizes a crop box that already exists: it never converts a
// legacy or fit crop (a stray trackpad scroll must not un-approve anything),
// and otherwise the page scrolls as usual.
function onWheel(e) {
  if (!S.ed || S.ed.missing || drag || !isBoxCrop(activeCrop())) return;
  e.preventDefault();
  if (resizeActive(Math.exp(-e.deltaY * 0.0015), false, true)) changed();
}

// ---------- keyboard ----------

function grow(f) {
  if (resizeActive(f)) changed();
}

function onKey(e) {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' && t.type !== 'range' || t.tagName === 'TEXTAREA')) {
    if (e.key === 'Escape') t.blur();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if ($('#editor-view').hidden) {
    if (e.key === 'Enter' && t.tagName !== 'BUTTON') { e.preventDefault(); $('#review-next').click(); }
    if (e.key === '/') { e.preventDefault(); $('#text-filter').focus(); }
    return;
  }
  const ed = S.ed;
  if (!ed) return;
  const [W, H] = dims();
  const step = Math.max(1, (e.shiftKey ? 0.05 : 0.005) * Math.min(W, H));
  const k = e.key;
  if ((k === 'Enter' || k === ' ') && t.tagName === 'BUTTON') return; // let the button act
  if (t.type === 'range' && k.startsWith('Arrow')) return;
  const keys = {
    Enter: () => act('approve'), Escape: () => go('#/'),
    r: () => act('reset'), n: () => act('another'), f: () => act('fit'), s: () => act('skip'),
    t: () => act('rotate'), h: () => act('heat'), a: () => act('add'),
    ArrowLeft: () => nudge(-step, 0), ArrowRight: () => nudge(step, 0),
    ArrowUp: () => nudge(0, -step), ArrowDown: () => nudge(0, step),
    '+': () => grow(1.04), '=': () => grow(1.04), '-': () => grow(1 / 1.04), _: () => grow(1 / 1.04),
  };
  const fn = keys[k] || keys[k.toLowerCase()];
  if (fn) { e.preventDefault(); fn(); return; }
  if (/^[1-9]$/.test(k)) {
    const c = ed.rec.crops[Number(k) - 1];
    if (c) { ed.active = c.tile; renderEditor(); }
  }
}

// ---------- wiring ----------

function wire() {
  $('#chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-f]');
    if (!b) return;
    S.filter = b.dataset.f;
    store('filter', S.filter);
    renderQueue();
  });
  const tf = $('#text-filter');
  tf.value = S.text;
  let tft = null;
  tf.addEventListener('input', () => {
    clearTimeout(tft);
    tft = setTimeout(() => { S.text = tf.value; store('text', S.text); renderQueue(); }, 150);
  });
  $('#groups').addEventListener('click', (e) => {
    const b = e.target.closest('.tile');
    if (b) go(editHash(b.dataset.id, b.dataset.tile));
  });
  $('#review-next').addEventListener('click', () => {
    const nx = nextTodo(null, null);
    if (nx) go(editHash(nx[0], nx[1])); else toast('Nothing left to review.');
  });
  $('#reload').addEventListener('click', async () => {
    if (!mayLeave(S.ed)) return;
    await Promise.all([S.ed, ...S.eds.values()].filter(Boolean).map((ed) => flush(ed)));
    S.ed = null;
    S.eds.clear();
    try { await loadRecords(); toast('Reloaded.', false, 1200); } catch (err) { toast(String(err), true); }
    renderQueue();
  });

  $('#back').addEventListener('click', () => go('#/'));
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tile]');
    if (!b || !S.ed) return;
    if (e.detail) b.blur();
    S.ed.active = b.dataset.tile;
    history.replaceState(null, '', editHash(S.ed.id, S.ed.active));
    renderEditor();
  });
  const buttons = { approve: 'b-approve', skip: 'b-skip', reset: 'b-reset', another: 'b-another', fit: 'b-fit', rotate: 'b-rotate', heat: 'b-heat', add: 'b-add', remove: 'b-remove' };
  // Blur after a click so Enter keeps meaning "approve" rather than re-pressing the button.
  for (const [name, id] of Object.entries(buttons)) {
    $('#' + id).addEventListener('click', (e) => { if (e.detail) e.currentTarget.blur(); act(name); });
  }

  const size = $('#size');
  size.addEventListener('input', () => {
    const crop = editable(activeCrop());
    if (!crop) return;
    const [W, H] = dims();
    resizeActive((Number(size.value) / 100) * Math.min(W, H), true);
    scheduleSave(S.ed);
    renderOverlay();
    renderPreviews();
  });
  size.addEventListener('change', () => renderEditor());

  const ov = $('#ov');
  ov.addEventListener('pointerdown', onDown);
  ov.addEventListener('pointermove', onMove);
  ov.addEventListener('pointerup', onUp);
  ov.addEventListener('pointercancel', onUp);
  ov.addEventListener('lostpointercapture', onUp);
  ov.addEventListener('wheel', onWheel, { passive: false });
  ov.addEventListener('contextmenu', (e) => e.preventDefault());

  $('#src').addEventListener('load', () => { if (S.ed) { renderOverlay(); renderPreviews(); } });
  $('#heat').addEventListener('error', () => {
    if (!S.heat) return;
    S.heat = false;
    $('#heat').dataset.url = '';
    toast('Heat map unavailable (autocrop missing or failed).', true);
    renderEditor();
  });
  if ('ResizeObserver' in window) new ResizeObserver(() => { if (S.ed && !$('#editor-view').hidden) renderOverlay(); }).observe($('#stage'));

  document.addEventListener('keydown', onKey);
  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', () => { if (document.hidden && S.ed) flush(S.ed); });
  window.addEventListener('pagehide', () => { for (const ed of [S.ed, ...S.eds.values()]) if (ed) flush(ed); });
  window.addEventListener('beforeunload', (e) => {
    const eds = [S.ed, ...S.eds.values()].filter(pending);
    if (eds.length) { eds.forEach((ed) => flush(ed)); e.preventDefault(); e.returnValue = ''; }
  });
}

async function start() {
  wire();
  try {
    await loadRecords();
  } catch (err) {
    $('#counts').textContent = `Could not load records: ${err.message}`;
    return;
  }
  route();
}

start();
