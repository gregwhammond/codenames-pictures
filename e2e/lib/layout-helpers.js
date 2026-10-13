'use strict';
// Layout measurement for tests/layout.spec.js.
//
// Everything is measured in the browser (getBoundingClientRect, computed
// styles, elementFromPoint) on the page the server serves, then judged here.
// Nothing in this file changes the page.
//
//   const run = new LayoutRun(table);
//   await run.capture(phone, 'clue-phase/spymaster-active', { need: ['board'] });
//   run.finish();          // throws with every problem found, after all screenshots are saved
//
// Screenshots go to e2e/screenshots/<project>/<name>.jpg (git-ignored), always
// under the same names, so a human can leaf through them after a run. The raw
// measurements of each test are saved beside them in <project>/_measurements/.

const fs = require('node:fs');
const path = require('node:path');
const server = require('./server');

const SHOT_ROOT = path.join(server.E2E_DIR, 'screenshots');

/** Rounding slack for sub-pixel layout, in CSS px. */
const EPS = 0.5;
/** Smallest tile side we accept as a touch target (CSS px). */
const MIN_TILE = 44;
/** Frame width the stylesheet draws round a spymaster's unrevealed tile. */
const FRAME_PX = 5;

/** Runs in the page. Returns rectangles and computed styles; judges nothing. */
function pageLayout() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const de = document.documentElement;
  const q = (s, r = document) => (r ? r.querySelector(s) : null);
  const qa = (s, r = document) => (r ? [...r.querySelectorAll(s)] : []);
  const R = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  };
  const name = (el) => {
    if (!el) return '(nothing)';
    let s = el.tagName.toLowerCase();
    if (el.id) s += `#${el.id}`;
    const cls = [...el.classList].join('.');
    if (cls) s += `.${cls}`;
    for (const a of ['data-card', 'data-sit', 'data-num', 'data-region', 'name', 'value']) {
      if (el.hasAttribute && el.hasAttribute(a) && !(a === 'value' && el.tagName !== 'BUTTON')) s += `[${a}="${el.getAttribute(a)}"]`;
    }
    return s;
  };
  // What a finger at the element's centre would land on: 'self', 'offscreen', or the name of the thing in the way.
  const hit = (el) => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x >= vw || y >= vh) return 'offscreen';
    const top = document.elementFromPoint(x, y);
    if (!top) return '(nothing)';
    return top === el || el.contains(top) ? 'self' : name(top);
  };
  const item = (el) => (el ? { name: name(el), rect: R(el), hit: hit(el), disabled: !!el.disabled, text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60) } : null);
  const box = (el) => (el ? { name: name(el), rect: R(el), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight } : null);

  const app = document.getElementById('app');
  const screen = app ? app.dataset.screen || null : null;
  const toast = document.getElementById('toast');
  const toastShown = !!toast && toast.classList.contains('show');
  const sheet = q('.sheet');
  const rootStyle = getComputedStyle(de);

  let state = null;
  try {
    // eslint-disable-next-line no-undef
    const room = ui.room;
    const me = room ? room.players.find((p) => p.id === room.you) || null : null;
    const g = room ? room.game || null : null;
    // eslint-disable-next-line no-undef
    state = { code: ui.code, selected: ui.selected, showMenu: ui.showMenu, team: me ? me.team || null : null, role: me ? me.role || null : null, phase: g ? g.phase : null, turn: g ? g.turn : null, clue: g && g.clue ? g.clue.word : null, cards: g ? g.cards.map((c) => ({ team: c.team || null, revealed: !!c.revealed })) : null };
  } catch (_) { /* app not loaded */ }

  // Every rendered element that sticks out of the viewport (or, inside the
  // menu sheet, out of the sheet). Vertical overflow counts only on the game
  // screen, which is one fixed 100dvh page; home and lobby scroll.
  const fixedPage = screen === 'game';
  const offenders = [];
  const bad = new Set();
  for (const el of qa('body *')) {
    if (el.closest('script, noscript, template')) continue;
    if (toast && toast.contains(el) && !toastShown) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    let out = null;
    if (sheet && sheet !== el && sheet.contains(el)) {
      const s = sheet.getBoundingClientRect();
      if (r.left < s.left - 0.5 || r.right > s.right + 0.5) out = 'the menu sheet';
    } else if (r.left < -0.5 || r.right > vw + 0.5) {
      out = 'the viewport horizontally';
    } else if (fixedPage && (r.top < -0.5 || r.bottom > vh + 0.5)) {
      out = 'the viewport vertically';
    }
    if (!out) continue;
    bad.add(el);
    // A child that merely sits inside an offending parent adds nothing.
    const p = el.parentElement;
    if (p && bad.has(p)) {
      const pr = p.getBoundingClientRect();
      if (r.left >= pr.left - 0.5 && r.right <= pr.right + 0.5 && r.top >= pr.top - 0.5 && r.bottom <= pr.bottom + 0.5) continue;
    }
    offenders.push({ name: name(el), rect: R(el), out });
  }

  // Boxes whose own content is wider than they are.
  const squeezed = [];
  for (const el of qa('.scorebar, .status, .seat, .seat-people, .lobby-head, .teams, .team, .actions, .guess-panel, .over-panel, .clue-form, .nums, .sheet, .players li, .log li, .home, #home-form, .join-row, .lobby, .lobby-actions, .waiting')) {
    if (el.scrollWidth > el.clientWidth + 1) squeezed.push({ name: name(el), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50) });
  }

  const out = {
    screen,
    path: location.pathname,
    state,
    viewport: {
      width: vw,
      height: vh,
      scrollWidth: de.scrollWidth,
      scrollHeight: de.scrollHeight,
      clientWidth: de.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      scale: window.visualViewport ? window.visualViewport.scale : 1,
      visualWidth: window.visualViewport ? window.visualViewport.width : vw,
      sideBySide: window.matchMedia('(orientation: landscape) and (max-height: 540px)').matches,
    },
    palette: {
      red: rootStyle.getPropertyValue('--red').trim(),
      blue: rootStyle.getPropertyValue('--blue').trim(),
      neutral: rootStyle.getPropertyValue('--neutral').trim(),
      assassin: rootStyle.getPropertyValue('--assassin').trim(),
    },
    toast: toastShown ? { text: toast.textContent, rect: R(toast) } : null,
    images: qa('img').map((i) => ({ src: i.getAttribute('src'), ok: i.complete && i.naturalWidth > 0 })),
    offenders,
    squeezed,
    home: null, lobby: null, game: null, sheet: null, zoom: null, viewer: null,
  };

  if (q('#home-form')) {
    out.home = {
      form: box(q('#home-form')),
      controls: qa('#home-form input, #home-form button, .how summary').map(item),
      error: item(q('#home-form p.error')),
    };
  }

  if (q('section.lobby')) {
    out.lobby = {
      roomCode: item(q('.room-code')),
      seats: qa('button.seat').map(item),
      controls: qa('.lobby button:not(.seat), .lobby summary').map(item),
      teams: qa('.team').map((t) => R(t)),
    };
  }

  const board = q('.board');
  if (board) {
    const after = (t) => {
      const cs = getComputedStyle(t, '::after');
      return {
        content: cs.content,
        display: cs.display,
        position: cs.position,
        visibility: cs.visibility,
        opacity: cs.opacity,
        borderWidth: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth],
        borderStyle: [cs.borderTopStyle, cs.borderRightStyle, cs.borderBottomStyle, cs.borderLeftStyle],
        borderColor: [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor],
        inset: [cs.top, cs.right, cs.bottom, cs.left],
        padding: cs.paddingTop,
        backgroundImage: cs.backgroundImage,
        mask: cs.maskImage || cs.webkitMaskImage || '',
        width: cs.width,
        height: cs.height,
      };
    };
    const cover = (t) => {
      const c = q('.cover', t);
      if (!c) return null;
      const cs = getComputedStyle(c);
      return { rect: R(c), backgroundColor: cs.backgroundColor, backgroundImage: cs.backgroundImage, opacity: cs.opacity, text: c.textContent };
    };
    out.game = {
      regions: { top: R(q('[data-region="top"]')), board: R(q('[data-region="board"]')), actions: R(q('[data-region="actions"]')) },
      scorebar: box(q('.scorebar')),
      scoreRed: item(q('.score.red')),
      scoreBlue: item(q('.score.blue')),
      status: box(q('.status')),
      clueWord: item(q('.status .clue-word')),
      clueNum: item(q('.status .clue-num')),
      menu: item(q('#menu')),
      board: { rect: R(board), classes: [...board.classList] },
      tiles: qa('button.tile', board).map((t) => ({
        card: Number(t.dataset.card),
        rect: R(t),
        hit: hit(t),
        revealed: t.classList.contains('revealed'),
        key: [...t.classList].filter((c) => c.startsWith('k-')).map((c) => c.slice(2)),
        opacity: getComputedStyle(t).opacity,
        after: after(t),
        cover: cover(t),
        img: R(q('img', t)),
      })),
      controls: qa('.actions button, .actions input').map(item),
      texts: qa('.actions p, .actions .guess-panel span').map(item),
      actionsBox: box(q('.actions')),
    };
  }

  if (sheet) {
    out.sheet = {
      box: box(sheet),
      backdrop: R(q('.sheet-backdrop')),
      controls: qa('button', sheet).map(item),
      rows: qa('h3, h4, li, p, .row', sheet).map((el) => ({ name: name(el), rect: R(el) })),
      overflowY: getComputedStyle(sheet).overflowY,
    };
  }

  const zoom = q('#modal .zoom');
  if (zoom) {
    const img = q('img', zoom);
    const ics = img ? getComputedStyle(img) : null;
    out.zoom = {
      rect: R(zoom),
      key: [...zoom.classList].filter((c) => c.startsWith('k-')).map((c) => c.slice(2)),
      img: img ? { rect: R(img), outlineStyle: ics.outlineStyle, outlineWidth: ics.outlineWidth, outlineColor: ics.outlineColor } : null,
      tag: item(q('.key-tag', zoom)),
      tagBackground: q('.key-tag', zoom) ? getComputedStyle(q('.key-tag', zoom)).backgroundColor : null,
      controls: qa('button', zoom).map(item),
      backdrop: R(q('#modal .zoom-backdrop')),
    };
  }

  const viewer = q('#viewer .viewer');
  if (viewer) {
    out.viewer = {
      rect: R(viewer),
      stage: R(q('.viewer-stage', viewer)),
      img: R(q('.viewer-img', viewer)),
      close: item(q('.viewer-close', viewer)),
      tag: q('.viewer-tag', viewer) && !q('.viewer-tag', viewer).hidden ? item(q('.viewer-tag', viewer)) : null,
    };
  }
  return out;
}

// ---------- judging ----------

const px = (n) => `${Math.round(n * 100) / 100}`;
const fmt = (r) => (r ? `[x ${px(r.left)}..${px(r.right)}, y ${px(r.top)}..${px(r.bottom)}]` : '(no box)');
const inside = (r, o, eps = EPS) => r.left >= o.left - eps && r.right <= o.right + eps && r.top >= o.top - eps && r.bottom <= o.bottom + eps;
const overlap = (a, b, eps = EPS) => a.left < b.right - eps && a.right > b.left + eps && a.top < b.bottom - eps && a.bottom > b.top + eps;
const grow = (r, n) => ({ left: r.left - n, top: r.top - n, right: r.right + n, bottom: r.bottom + n });

/** '#f07c1e' -> 'rgb(240, 124, 30)', the form computed styles use. */
function hexToRgb(hex) {
  let h = String(hex).trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) return String(hex).trim();
  const n = parseInt(h, 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

/** Is a ::after pseudo-element generated at all? `content` is `""` (two quote characters) when it is. */
const drawn = (after) => !['none', 'normal', '', '-moz-alt-content'].includes(after.content) && after.display !== 'none';

/**
 * Every layout rule broken by one measurement, as text.
 *   expected.width/height  the viewport the project asked for
 *   need                   things that must be present: 'home' | 'lobby' | 'board' | 'zoom' | 'sheet' | 'viewer' | 'clue'
 */
function layoutProblems(m, { expected, need = [] } = {}) {
  const out = [];
  const add = (id, text) => out.push(`[${id}] ${text}`);
  // Judge against the phone's real screen. When content is too wide, Chromium's
  // phone emulation zooms out and reports a larger window; things that are
  // "inside" that enlarged window are still off the phone's screen at 1:1.
  const vp = { left: 0, top: 0, right: expected ? expected.width : m.viewport.width, bottom: expected ? expected.height : m.viewport.height };
  const overlay = !!(m.sheet || m.zoom || m.viewer);

  for (const n of need) {
    const have = n === 'board' ? !!m.game : n === 'clue' ? !!(m.game && m.game.clueWord) : !!m[n];
    if (!have) add('present', `expected ${n} on screen "${m.screen}" but it is not there`);
  }

  // ----- the page itself -----
  if (expected) {
    if (m.viewport.width !== expected.width || m.viewport.height !== expected.height) {
      add('viewport.size', `window is ${m.viewport.width}x${m.viewport.height}, the phone is ${expected.width}x${expected.height} (the browser zoomed out to fit content that is too wide)`);
    }
  }
  if (Math.abs(m.viewport.scale - 1) > 0.001) add('viewport.size', `visual viewport scale is ${m.viewport.scale}, expected 1`);
  if (m.viewport.scrollWidth > m.viewport.width) add('page.hscroll', `the page scrolls sideways: document is ${m.viewport.scrollWidth}px wide in a ${m.viewport.width}px window`);
  if (m.viewport.bodyScrollWidth > m.viewport.width) add('page.hscroll', `<body> content is ${m.viewport.bodyScrollWidth}px wide in a ${m.viewport.width}px window`);
  if (m.viewport.scrollX !== 0) add('page.hscroll', `the page is scrolled sideways by ${m.viewport.scrollX}px`);
  if (m.screen === 'game' && m.viewport.scrollHeight > m.viewport.height) add('page.vscroll', `the game screen scrolls: document is ${m.viewport.scrollHeight}px tall in a ${m.viewport.height}px window`);
  for (const o of m.offenders.slice(0, 8)) add('page.overflow', `${o.name} ${fmt(o.rect)} sticks out of ${o.out} (window ${m.viewport.width}x${m.viewport.height})`);
  if (m.offenders.length > 8) add('page.overflow', `…and ${m.offenders.length - 8} more elements`);
  for (const s of m.squeezed) add('box.overflow', `${s.name} holds content ${s.scrollWidth}px wide in a ${s.clientWidth}px box ("${s.text}")`);
  const broken = m.images.filter((i) => !i.ok);
  if (broken.length) add('images', `${broken.length} picture(s) did not load: ${broken.slice(0, 3).map((i) => i.src).join(', ')}`);

  // ----- home -----
  if (m.home) {
    for (const c of m.home.controls) {
      if (c.rect.left < -EPS || c.rect.right > vp.right + EPS) add('home.controls', `${c.name} ${fmt(c.rect)} is not inside the ${vp.right}px wide window`);
      if (!/^summary/.test(c.name) && c.rect.height < 36 - EPS) add('home.controls', `${c.name} is only ${px(c.rect.height)}px tall`);
    }
  }

  // ----- lobby -----
  if (m.lobby) {
    if (m.lobby.seats.length !== 4) add('lobby.seats', `${m.lobby.seats.length} seats, expected 4`);
    for (const c of [...m.lobby.seats, ...m.lobby.controls, m.lobby.roomCode].filter(Boolean)) {
      if (c.rect.left < -EPS || c.rect.right > vp.right + EPS) add('lobby.controls', `${c.name} ${fmt(c.rect)} is not inside the ${vp.right}px wide window`);
    }
    for (let i = 0; i < m.lobby.seats.length; i++) {
      for (let j = i + 1; j < m.lobby.seats.length; j++) {
        if (overlap(m.lobby.seats[i].rect, m.lobby.seats[j].rect)) add('lobby.seats', `${m.lobby.seats[i].name} overlaps ${m.lobby.seats[j].name}`);
      }
    }
    if (m.lobby.teams.length === 2 && Math.abs(m.lobby.teams[0].width - m.lobby.teams[1].width) > 1) {
      add('lobby.teams', `team columns are ${px(m.lobby.teams[0].width)}px and ${px(m.lobby.teams[1].width)}px wide, expected equal`);
    }
  }

  // ----- game -----
  const g = m.game;
  if (g) {
    const { top, board, actions } = g.regions;
    const side = m.viewport.sideBySide;

    // Regions.
    for (const [n, r] of Object.entries(g.regions)) {
      if (!r) add('game.regions', `region "${n}" is missing`);
      else if (!inside(r, vp)) add('game.regions', `region "${n}" ${fmt(r)} is not inside the viewport`);
    }
    if (top && board && overlap(top, board)) add('game.regions', `the score bar ${fmt(top)} overlaps the board region ${fmt(board)}`);
    if (actions && board && overlap(actions, board)) add('game.regions', `the action bar ${fmt(actions)} overlaps the board region ${fmt(board)}`);
    if (top && actions && overlap(top, actions)) add('game.regions', `the score bar ${fmt(top)} overlaps the action bar ${fmt(actions)}`);

    // Tiles: 24, in a 4 by 6 grid, square, one size.
    const tiles = g.tiles;
    if (tiles.length !== 24) add('tiles.count', `${tiles.length} tiles, expected 24`);
    if (tiles.some((t, i) => t.card !== i)) add('tiles.count', `tiles are out of order: ${tiles.map((t) => t.card).join(',')}`);
    if (tiles.length === 24) {
      const tops = [];
      const lefts = [];
      for (const t of tiles) {
        if (!tops.some((v) => Math.abs(v - t.rect.top) <= EPS)) tops.push(t.rect.top);
        if (!lefts.some((v) => Math.abs(v - t.rect.left) <= EPS)) lefts.push(t.rect.left);
      }
      if (tops.length !== 6 || lefts.length !== 4) add('tiles.grid', `tiles form ${lefts.length} columns and ${tops.length} rows, expected 4 columns and 6 rows`);
      tops.sort((a, b) => a - b);
      lefts.sort((a, b) => a - b);
      tiles.forEach((t, i) => {
        const row = Math.floor(i / 4);
        const col = i % 4;
        if (tops.length === 6 && lefts.length === 4 && (Math.abs(t.rect.top - tops[row]) > EPS || Math.abs(t.rect.left - lefts[col]) > EPS)) {
          add('tiles.grid', `tile ${i} is at ${fmt(t.rect)}, not in row ${row + 1}, column ${col + 1}`);
        }
      });
      for (let i = 0; i < tiles.length; i++) {
        for (let j = i + 1; j < tiles.length; j++) {
          if (overlap(tiles[i].rect, tiles[j].rect)) add('tiles.grid', `tile ${i} overlaps tile ${j}`);
        }
      }
    }
    const widths = tiles.map((t) => t.rect.width);
    const minW = Math.min(...widths);
    const maxW = Math.max(...widths);
    if (maxW - minW > EPS) add('tiles.size', `tiles are not one size: widths from ${px(minW)} to ${px(maxW)}px`);
    for (const t of tiles) {
      if (Math.abs(t.rect.width - t.rect.height) > EPS) add('tiles.square', `tile ${t.card} is ${px(t.rect.width)} x ${px(t.rect.height)}px, not square`);
      if (t.rect.width < MIN_TILE) add('tiles.size', `tile ${t.card} is ${px(t.rect.width)}px wide, under the ${MIN_TILE}px touch-target minimum`);
      if (board && !inside(t.rect, board)) add('tiles.board', `tile ${t.card} ${fmt(t.rect)} is outside the board region ${fmt(board)}`);
      if (!inside(t.rect, g.board.rect)) add('tiles.board', `tile ${t.card} ${fmt(t.rect)} is outside .board ${fmt(g.board.rect)}`);
      if (!inside(t.rect, vp)) add('tiles.viewport', `tile ${t.card} ${fmt(t.rect)} is not inside the viewport`);
      if (actions) {
        if (overlap(t.rect, actions)) add('tiles.actions', `tile ${t.card} ${fmt(t.rect)} overlaps the action bar ${fmt(actions)}`);
        if (!side && t.rect.bottom > actions.top + EPS) add('tiles.actions', `tile ${t.card} ends at y ${px(t.rect.bottom)}, below the top of the action bar (y ${px(actions.top)})`);
        if (side && t.rect.right > actions.left + EPS) add('tiles.actions', `tile ${t.card} ends at x ${px(t.rect.right)}, past the left edge of the action column (x ${px(actions.left)})`);
      }
      if (top) {
        if (overlap(t.rect, top)) add('tiles.scorebar', `tile ${t.card} ${fmt(t.rect)} overlaps the score bar ${fmt(top)}`);
        if (!side && t.rect.top < top.bottom - EPS) add('tiles.scorebar', `tile ${t.card} starts at y ${px(t.rect.top)}, above the bottom of the score bar (y ${px(top.bottom)})`);
      }
      if (!overlay && t.hit !== 'self') add('tiles.tappable', `a tap on the middle of tile ${t.card} would land on ${t.hit}`);
      if (t.img && (Math.abs(t.img.width - t.rect.width) > EPS || Math.abs(t.img.height - t.rect.height) > EPS)) add('tiles.picture', `tile ${t.card}'s picture is ${px(t.img.width)} x ${px(t.img.height)}px in a ${px(t.rect.width)}px tile`);
    }

    // Action bar.
    for (const c of g.controls) {
      if (!inside(c.rect, vp)) add('actions.viewport', `${c.name} ("${c.text}") ${fmt(c.rect)} is not inside the viewport`);
      if (top && overlap(c.rect, top)) add('actions.overlap', `${c.name} ${fmt(c.rect)} overlaps the score bar ${fmt(top)}`);
      if (tiles.some((t) => overlap(c.rect, t.rect))) add('actions.overlap', `${c.name} ${fmt(c.rect)} overlaps a tile`);
      if (!overlay && c.hit !== 'self') add('actions.tappable', `a tap on the middle of ${c.name} ("${c.text}") would land on ${c.hit}`);
      if (c.rect.height < 34 - EPS || c.rect.width < 24 - EPS) add('actions.size', `${c.name} ("${c.text}") is ${px(c.rect.width)} x ${px(c.rect.height)}px`);
    }
    for (let i = 0; i < g.controls.length; i++) {
      for (let j = i + 1; j < g.controls.length; j++) {
        if (overlap(g.controls[i].rect, g.controls[j].rect)) add('actions.overlap', `${g.controls[i].name} overlaps ${g.controls[j].name}`);
      }
    }
    for (const t of g.texts) {
      if (!inside(t.rect, vp)) add('actions.viewport', `the text "${t.text}" ${fmt(t.rect)} is not inside the viewport`);
      if (top && overlap(t.rect, top)) add('actions.overlap', `the text "${t.text}" overlaps the score bar`);
    }
    if (!g.controls.length && !g.texts.length) add('actions.viewport', 'the action bar is empty');

    // Score bar and the ☰ button.
    const bar = [['Orange score', g.scoreRed], ['Purple score', g.scoreBlue], ['#menu', g.menu]];
    for (const [n, it] of bar) {
      if (!it) { add('scorebar', `${n} is missing`); continue; }
      if (!inside(it.rect, vp)) add(n === '#menu' ? 'menu.viewport' : 'scorebar', `${n} ${fmt(it.rect)} is not inside the ${vp.right}x${vp.bottom} viewport${m.state && m.state.clue ? ` with the clue "${m.state.clue}" showing` : ''}`);
    }
    if (g.menu) {
      if (g.menu.rect.width < 36 - EPS || g.menu.rect.height < 36 - EPS) add('menu.size', `#menu is ${px(g.menu.rect.width)} x ${px(g.menu.rect.height)}px`);
      if (!overlay && g.menu.hit !== 'self') add('menu.tappable', `a tap on the middle of #menu would land on ${g.menu.hit}`);
    }
    for (let i = 0; i < bar.length; i++) {
      for (let j = i + 1; j < bar.length; j++) {
        // .score.active is scaled up by 6%; allow for it.
        if (bar[i][1] && bar[j][1] && overlap(bar[i][1].rect, bar[j][1].rect, 3)) add('scorebar', `${bar[i][0]} overlaps ${bar[j][0]}`);
      }
    }
    for (const [n, it] of [['the clue word', g.clueWord], ['the clue number', g.clueNum]]) {
      if (!it) continue;
      if (!inside(it.rect, vp)) add('clue.viewport', `${n} "${it.text}" ${fmt(it.rect)} is not inside the viewport`);
      for (const [bn, b] of bar) if (b && overlap(it.rect, b.rect, 3)) add('clue.overlap', `${n} "${it.text}" ${fmt(it.rect)} overlaps ${bn} ${fmt(b.rect)}`);
      if (tiles.some((t) => overlap(it.rect, t.rect))) add('clue.overlap', `${n} "${it.text}" ${fmt(it.rect)} overlaps a tile`);
    }

    // The key: drawn for whoever may see it, absent for everyone else. What
    // the phone may see comes from the app's own state; what is drawn comes
    // from computed styles.
    if (m.state && m.state.cards && tiles.length === m.state.cards.length) {
      const seesKey = m.state.role === 'spymaster' || m.state.phase === 'over';
      const want = Object.fromEntries(Object.entries(m.palette).map(([k, v]) => [k, hexToRgb(v)]));
      tiles.forEach((t, i) => {
        const card = m.state.cards[i];
        const a = t.after;
        if (card.revealed) {
          if (drawn(a)) add('key.frame', `revealed tile ${i} still has a key frame`);
          if (!t.cover) { add('key.cover', `revealed tile ${i} has no cover`); return; }
          if (Math.abs(t.cover.rect.width - t.rect.width) > EPS || Math.abs(t.cover.rect.height - t.rect.height) > EPS) add('key.cover', `the cover of tile ${i} is ${px(t.cover.rect.width)} x ${px(t.cover.rect.height)}px, the tile is ${px(t.rect.width)}px`);
          if (Number(t.cover.opacity) < 0.5) add('key.cover', `the cover of tile ${i} has opacity ${t.cover.opacity}`);
          if (card.team === 'assassin') {
            if (!/conic-gradient/.test(t.cover.backgroundImage)) add('key.cover', `the assassin cover on tile ${i} is not checkered (background-image: ${t.cover.backgroundImage})`);
          } else if (t.cover.backgroundColor !== want[card.team]) {
            add('key.cover', `the cover of tile ${i} (${card.team}) is ${t.cover.backgroundColor}, expected ${want[card.team]}`);
          }
          return;
        }
        if (!seesKey) {
          if (drawn(a) || a.borderWidth.some((w) => parseFloat(w) > 0)) add('key.absent', `unrevealed tile ${i} has a frame drawn on a phone that must not see the key (::after content ${a.content}, border ${a.borderWidth.join(' ')} ${a.borderColor[0]})`);
          if (t.key.length) add('key.absent', `unrevealed tile ${i} carries the key class k-${t.key.join(',k-')} on a phone that must not see the key`);
          return;
        }
        // A key-seeing phone: the frame must really be painted.
        if (!card.team) { add('key.frame', `tile ${i}: the app state has no team for this card on a phone that should see the key`); return; }
        if (!drawn(a)) { add('key.frame', `tile ${i} (${card.team}): no frame is drawn (::after content is ${a.content || '(empty)'}, display ${a.display})`); return; }
        if (a.position !== 'absolute' || a.visibility !== 'visible' || Number(a.opacity) === 0) add('key.frame', `tile ${i} (${card.team}): the frame is not visible (position ${a.position}, visibility ${a.visibility}, opacity ${a.opacity})`);
        if (a.inset.some((v) => parseFloat(v) !== 0)) add('key.frame', `tile ${i} (${card.team}): the frame does not hug the tile (inset ${a.inset.join(' ')})`);
        if (card.team === 'assassin') {
          if (!/conic-gradient/.test(a.backgroundImage)) add('key.frame', `tile ${i} (assassin): the frame is not checkered (background-image: ${a.backgroundImage})`);
          if (parseFloat(a.padding) !== FRAME_PX) add('key.frame', `tile ${i} (assassin): the ring is ${a.padding} wide, expected ${FRAME_PX}px`);
          if (!a.mask || a.mask === 'none') add('key.frame', `tile ${i} (assassin): the checkerboard is not cut to a ring (mask-image: ${a.mask || 'none'}), so it would cover the whole picture`);
        } else {
          if (a.borderWidth.some((w) => parseFloat(w) !== FRAME_PX)) add('key.frame', `tile ${i} (${card.team}): frame widths are ${a.borderWidth.join(' ')}, expected ${FRAME_PX}px all round`);
          if (a.borderStyle.some((s) => s !== 'solid')) add('key.frame', `tile ${i} (${card.team}): frame style is ${a.borderStyle.join(' ')}, expected solid`);
          if (a.borderColor.some((c) => c !== want[card.team])) add('key.frame', `tile ${i} (${card.team}): frame colour is ${a.borderColor[0]}, expected ${want[card.team]}`);
        }
        const w = parseFloat(a.width);
        if (Number.isFinite(w) && w <= 0) add('key.frame', `tile ${i} (${card.team}): the frame box is ${a.width} wide`);
      });
      const distinct = new Set(Object.values(want));
      if (distinct.size !== 4) add('key.frame', `the four key colours are not distinct: ${JSON.stringify(want)}`);
    }
  }

  // ----- menu sheet -----
  if (m.sheet) {
    const s = m.sheet.box;
    if (!inside(s.rect, vp)) add('sheet.viewport', `the menu sheet ${fmt(s.rect)} is not inside the viewport`);
    if (s.scrollWidth > s.clientWidth + 1) add('sheet.hscroll', `the menu sheet scrolls sideways: content ${s.scrollWidth}px in ${s.clientWidth}px`);
    if (s.scrollHeight > s.clientHeight + 1 && !/auto|scroll/.test(m.sheet.overflowY)) add('sheet.vscroll', `the menu sheet content is ${s.scrollHeight}px tall in ${s.clientHeight}px and cannot scroll`);
    if (s.rect.left < 24) add('sheet.backdrop', `the menu sheet leaves only ${px(s.rect.left)}px of backdrop to tap beside it`);
    for (const c of m.sheet.controls) {
      if (c.rect.left < s.rect.left - EPS || c.rect.right > s.rect.right + EPS) add('sheet.controls', `${c.name} ("${c.text}") ${fmt(c.rect)} is not inside the sheet ${fmt(s.rect)}`);
      // Visible ones must be tappable; ones below the fold are reached by scrolling the sheet.
      if (inside(c.rect, vp) && c.hit !== 'self' && !m.viewer && !m.zoom) add('sheet.tappable', `a tap on the middle of ${c.name} ("${c.text}") would land on ${c.hit}`);
    }
    for (const r of m.sheet.rows) {
      if (r.rect.left < s.rect.left - EPS || r.rect.right > s.rect.right + EPS) add('sheet.controls', `${r.name} ${fmt(r.rect)} is not inside the sheet ${fmt(s.rect)}`);
    }
  }

  // ----- zoom sheet -----
  if (m.zoom) {
    const z = m.zoom;
    if (!inside(z.rect, vp)) add('zoom.viewport', `the zoom sheet ${fmt(z.rect)} is not inside the ${vp.right}x${vp.bottom} viewport`);
    if (!z.img) add('zoom.picture', 'the zoom sheet has no picture');
    else {
      if (Math.abs(z.img.rect.width - z.img.rect.height) > EPS) add('zoom.picture', `the zoomed picture is ${px(z.img.rect.width)} x ${px(z.img.rect.height)}px, not square`);
      if (z.img.rect.width < 150) add('zoom.picture', `the zoomed picture is only ${px(z.img.rect.width)}px wide`);
      // The key frame is an outline, drawn outside the picture's box.
      const o = z.key.length ? parseFloat(z.img.outlineWidth) || 0 : 0;
      if (!inside(grow(z.img.rect, o), vp)) add('zoom.viewport', `the zoomed picture ${fmt(z.img.rect)}${o ? ` plus its ${o}px key outline` : ''} is not inside the viewport`);
      if (z.key.length && (z.img.outlineStyle === 'none' || !o)) add('zoom.key', `the zoom sheet has key class k-${z.key[0]} but no outline is drawn (${z.img.outlineStyle} ${z.img.outlineWidth})`);
      if (!z.key.length && z.img.outlineStyle !== 'none' && parseFloat(z.img.outlineWidth) > 0) add('zoom.key', `the zoom sheet has no key class but draws an outline (${z.img.outlineStyle} ${z.img.outlineWidth} ${z.img.outlineColor})`);
    }
    if (z.tag && !inside(z.tag.rect, vp)) add('zoom.viewport', `the key tag "${z.tag.text}" ${fmt(z.tag.rect)} is not inside the viewport`);
    if (!z.controls.length) add('zoom.controls', 'the zoom sheet has no buttons');
    for (const c of z.controls) {
      if (!inside(c.rect, vp)) add('zoom.viewport', `the "${c.text}" button ${fmt(c.rect)} is not inside the ${vp.right}x${vp.bottom} viewport`);
      if (!m.viewer && c.hit !== 'self') add('zoom.tappable', `a tap on the middle of "${c.text}" would land on ${c.hit}`);
      if (z.img && overlap(c.rect, z.img.rect)) add('zoom.controls', `the "${c.text}" button overlaps the picture`);
    }
    if (z.tag && z.img && overlap(z.tag.rect, z.img.rect)) add('zoom.controls', `the key tag overlaps the picture`);
    if (z.backdrop && (z.backdrop.left > EPS || z.backdrop.top > EPS || z.backdrop.right < vp.right - EPS || z.backdrop.bottom < vp.bottom - EPS)) add('zoom.backdrop', `the backdrop ${fmt(z.backdrop)} does not cover the viewport`);
  }

  // ----- full-screen viewer -----
  if (m.viewer) {
    const v = m.viewer;
    if (v.rect.left > EPS || v.rect.top > EPS || v.rect.right < vp.right - EPS || v.rect.bottom < vp.bottom - EPS) add('viewer.viewport', `the viewer ${fmt(v.rect)} does not cover the viewport`);
    if (!v.img || !inside(v.img, vp)) add('viewer.viewport', `the viewer picture ${fmt(v.img)} is not inside the viewport`);
    if (v.img && Math.min(v.img.width, v.img.height) < 150) add('viewer.picture', `the viewer picture is only ${px(v.img.width)} x ${px(v.img.height)}px`);
    if (!v.close || !inside(v.close.rect, vp)) add('viewer.viewport', `the viewer's close button ${fmt(v.close && v.close.rect)} is not inside the viewport`);
    else if (v.close.hit !== 'self') add('viewer.tappable', `a tap on the viewer's close button would land on ${v.close.hit}`);
    if (v.close && v.img && overlap(v.close.rect, v.img)) add('viewer.controls', 'the close button overlaps the picture');
    if (v.tag && !inside(v.tag.rect, vp)) add('viewer.viewport', `the viewer's key tag ${fmt(v.tag.rect)} is not inside the viewport`);
    if (v.tag && v.img && overlap(v.tag.rect, v.img)) add('viewer.controls', 'the key tag overlaps the picture');
  }

  return out;
}

// ---------- running ----------

class LayoutRun {
  /** @param {import('./table').Table} table */
  constructor(table) {
    this.table = table;
    this.testInfo = table.testInfo;
    this.project = this.testInfo.project.name;
    this.expected = this.testInfo.project.use.viewport;
    this.dir = path.join(SHOT_ROOT, this.project);
    /** { shot, phone, problems: string[] } per capture. */
    this.captures = [];
    this.measurements = {};
  }

  /**
   * Measure `phone`'s page, save a screenshot as screenshots/<project>/<shot>.jpg,
   * and note every layout rule it breaks. Does not throw on a broken rule;
   * finish() does, so that every screen of a test is photographed first.
   *   need       what must be on screen: 'home' | 'lobby' | 'board' | 'clue' | 'zoom' | 'sheet' | 'viewer'
   *   fullPage   photograph the whole scrolling page (default: for home and lobby)
   */
  async capture(phone, shot, { need = [], fullPage } = {}) {
    const page = phone.page;
    // Pictures must have loaded, or the screenshot is of placeholders.
    await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: this.table.effectTimeout })
      .catch(() => { /* reported below as [images] */ });
    // A tapped tile or button shrinks while it is pressed (`.tile:active`,
    // `.btn:active` in style.css) and the browser keeps that state for a moment
    // after a touch tap. Measure the resting layout.
    const released = await page.waitForFunction(() => !document.querySelector('.tile:active, .btn:active, .seat:active, .num:active'), null, { timeout: this.table.effectTimeout })
      .then(() => true, () => false);
    const m = await page.evaluate(pageLayout);
    // JPEG at the phone's pixel density: sharp enough to judge a 5px frame, and
    // about a tenth of the size of the PNG (a full run takes some 600 pictures).
    const file = path.join(this.dir, `${shot}.jpg`);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await page.screenshot({ path: file, type: 'jpeg', quality: 80, fullPage: fullPage ?? (m.screen !== 'game') });
    const problems = layoutProblems(m, { expected: this.expected, need });
    if (!released) problems.push('[press] a tile or button is still in its pressed (:active) state long after the tap');
    this.captures.push({ shot, phone: phone.name, file, problems });
    this.measurements[shot] = m;
    return { m, problems, file };
  }

  /** Every problem found so far, as lines of text. */
  problems() {
    return this.captures.flatMap((c) => c.problems.map((p) => `${c.shot} (${c.phone}): ${p}`));
  }

  /**
   * Save the numbers behind the pictures: attached to the report, and written
   * next to the screenshots (Playwright drops the attachments of passing tests
   * from the output folder). Does nothing the second time.
   */
  async save() {
    if (this._saved) return;
    this._saved = true;
    const json = JSON.stringify(this.measurements, null, 1);
    await this.testInfo.attach('layout-measurements.json', { body: json, contentType: 'application/json' }).catch(() => {});
    const slug = this.testInfo.title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
    const file = path.join(this.dir, '_measurements', `${slug}.json`);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, json);
  }

  /** Save the measurements and fail the test if any capture broke a rule. */
  async finish() {
    await this.save();
    const list = this.problems();
    if (!list.length) return;
    const vp = this.expected;
    throw new Error(
      `Layout rules broken on ${this.project} (${vp.width}x${vp.height}), ${list.length} problem(s) on ${this.captures.filter((c) => c.problems.length).length} of ${this.captures.length} screens:\n` +
      list.map((l) => `  ${l}`).join('\n') +
      `\nScreenshots: ${this.dir}`,
    );
  }
}

/** File-name label for a phone's seat: 'spymaster-active', 'guesser-waiting', 'watcher', … */
async function seatLabel(phone) {
  const room = await phone.state();
  const me = room ? room.players.find((p) => p.id === room.you) : null;
  if (!me || !me.team) return 'watcher';
  const g = room.game;
  if (!g || g.phase === 'over') return `${me.role}-${me.team === 'red' ? 'orange' : 'purple'}`;
  return `${me.role}-${me.team === g.turn ? 'active' : 'waiting'}`;
}

module.exports = { LayoutRun, pageLayout, layoutProblems, seatLabel, hexToRgb, SHOT_ROOT, EPS, MIN_TILE, FRAME_PX };
