'use strict';
// One phone. Every action is a real tap or keystroke on the page the server
// serves; nothing here calls the HTTP API directly. State is read from the
// app's own `ui` object, which is a top-level const of a classic script and so
// visible to page.evaluate.

const { expect } = require('@playwright/test');

/** Installed in every page before the app runs. Observes; changes nothing. */
function initScript() {
  const e2e = (window.__e2e = { toasts: [] });
  const start = () => {
    const el = document.getElementById('toast');
    if (!el) return;
    // toast() sets textContent every time, so each call is one childList change.
    new MutationObserver(() => {
      e2e.toasts.push({ text: el.textContent, at: Date.now() });
    }).observe(el, { childList: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}

/**
 * Runs in the page. One call returns the app state and the DOM facts the
 * invariants need, read in the same task so the two are consistent.
 */
function pageSnapshot() {
  const q = (s, root = document) => (root ? root.querySelector(s) : null);
  const qa = (s, root = document) => (root ? [...root.querySelectorAll(s)] : []);
  const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
  const classes = (el) => (el ? [...el.classList] : []);
  const app = document.getElementById('app');

  let uiState = null;
  try {
    // eslint-disable-next-line no-undef
    const u = ui;
    uiState = {
      code: u.code,
      room: u.room,
      selected: u.selected,
      busy: u.busy,
      showMenu: u.showMenu,
      clueNumber: u.clueNumber,
      error: u.error,
      sse: u.events ? { readyState: u.events.readyState, url: u.events.url } : null,
    };
  } catch (_) { /* app script not loaded yet */ }

  const toastEl = document.getElementById('toast');
  const toasts = (window.__e2e && window.__e2e.toasts) || [];
  const dom = {
    appClasses: classes(app),
    home: null, lobby: null, game: null, zoom: null, viewer: null, menu: null,
  };

  const form = q('#home-form');
  if (form) {
    dom.home = {
      error: text(q('p.error', form)),
      name: q('#name', form) ? q('#name', form).value : null,
      hasCodeInput: !!q('#code', form),
      hasCreate: !!q('button[name="go"][value="create"]', form),
      joinLabel: text(q('button[name="go"][value="join"]', form)),
    };
  }

  const lobby = q('section.lobby');
  if (lobby) {
    const seats = {};
    for (const b of qa('button.seat', lobby)) {
      seats[b.dataset.sit] = {
        mine: b.classList.contains('mine'),
        disabled: b.disabled,
        people: qa('.person', b).map((p) => ({ text: text(p), you: p.classList.contains('you'), away: p.classList.contains('away') })),
      };
    }
    dom.lobby = {
      roomCode: text(q('.room-code', lobby)),
      seats,
      start: q('#start', lobby) ? { disabled: q('#start', lobby).disabled } : null,
      hasStand: !!q('[data-sit=":"]', lobby),
      hasLeave: !!q('#leave', lobby),
      hasShare: !!q('#share', lobby),
      waiting: qa('.waiting .person', lobby).map((p) => text(p)),
    };
  }

  const board = q('.board');
  if (board || q('.scorebar')) {
    const num = (el) => (el ? Number(text(el)) : null);
    const active = q('.scorebar .score.active');
    const cf = q('#clue-form');
    const end = q('#end-turn');
    const menuBtn = q('#menu');
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    dom.game = {
      score: { red: num(q('.scorebar .score.red b')), blue: num(q('.scorebar .score.blue b')) },
      active: active ? (active.classList.contains('red') ? 'red' : 'blue') : null,
      activeCount: qa('.scorebar .score.active').length,
      status: text(q('.scorebar .status')),
      clueWord: q('.scorebar .status .clue-word') ? q('.scorebar .status .clue-word').textContent : null,
      clueNum: text(q('.scorebar .status .clue-num')),
      menuButton: rect(menuBtn),
      boardClasses: classes(board),
      tiles: qa('button.tile', board).map((t) => ({
        card: Number(t.dataset.card),
        classes: classes(t),
        revealed: t.classList.contains('revealed'),
        key: classes(t).filter((c) => c.startsWith('k-')).map((c) => c.slice(2)),
        img: q('img', t) ? q('img', t).getAttribute('src') : null,
        cover: !!q('.cover', t),
        label: t.getAttribute('aria-label'),
      })),
      clueForm: cf ? {
        word: q('input[name="word"]', cf).value,
        on: qa('.num.on', cf).map((b) => Number(b.dataset.num)),
        nums: qa('.num', cf).map((b) => Number(b.dataset.num)),
      } : null,
      guessPanel: q('.guess-panel') ? text(q('.guess-panel span')) : null,
      endTurn: end ? { disabled: end.disabled } : null,
      wait: text(q('.actions p.wait')),
      over: q('.over-panel') ? { text: text(q('.over-panel p')), again: !!q('.over-panel #again'), toLobby: !!q('.over-panel #to-lobby') } : null,
    };
  }

  const sheet = q('.sheet');
  if (sheet) {
    dom.menu = {
      title: text(q('h3', sheet)),
      players: qa('ul.players li', sheet).map((li) => ({ text: text(li), away: li.classList.contains('away'), team: (classes(q('i', li))[0] || '').replace(/^t-/, '') })),
      log: qa('ul.log li', sheet).map((li) => ({
        team: q('.team-word', li) ? (q('.team-word', li).classList.contains('red') ? 'red' : 'blue') : null,
        word: q('.clue-word', li) ? q('.clue-word', li).textContent : null,
        num: text(q('.clue-num', li)),
        dots: qa('.dots i', li).map((i) => (classes(i)[0] || '').replace(/^t-/, '')),
      })),
      sit: qa('[data-sit]', sheet).map((b) => b.dataset.sit),
      hasToLobby: !!q('#to-lobby', sheet),
      hasLeave: !!q('#leave', sheet),
      hasBackdrop: !!q('.sheet-backdrop'),
    };
  }

  const zoom = q('#modal .zoom');
  if (zoom) {
    const g = q('#modal button[data-guess]');
    dom.zoom = {
      classes: classes(zoom),
      key: classes(zoom).filter((c) => c.startsWith('k-')).map((c) => c.slice(2)),
      tag: text(q('.key-tag', zoom)),
      tagClasses: classes(q('.key-tag', zoom)),
      guess: g ? Number(g.dataset.guess) : null,
      img: q('img', zoom) ? q('img', zoom).getAttribute('src') : null,
    };
  }

  const viewer = q('#viewer .viewer');
  if (viewer) {
    const tag = q('.viewer-tag', viewer);
    dom.viewer = {
      classes: classes(viewer),
      key: classes(viewer).filter((c) => c.startsWith('k-')).map((c) => c.slice(2)),
      tag: tag ? tag.textContent : null,
      tagHidden: tag ? tag.hidden : true,
      img: q('.viewer-img', viewer) ? q('.viewer-img', viewer).getAttribute('src') : null,
    };
  }

  const de = document.documentElement;
  return {
    booted: !!uiState && !!app && !!app.dataset.screen,
    screen: app ? app.dataset.screen || null : null,
    path: location.pathname,
    ui: uiState,
    offline: document.body.classList.contains('offline'),
    toast: toastEl ? { show: toastEl.classList.contains('show'), text: toastEl.textContent } : null,
    toasts: toasts.map((t) => t.text),
    viewport: { width: window.innerWidth, height: window.innerHeight, scrollWidth: de.scrollWidth, scrollHeight: de.scrollHeight },
    dom,
  };
}

const TEAM_NAME = { red: 'Orange', blue: 'Purple' };

class PostHold {
  constructor(phone, label, phase) {
    this.phone = phone;
    this.label = label;
    this.phase = phase;
    /** Requests that matched, in order: { url, method, body, at }. */
    this.requests = [];
    /** How many matched requests are parked at the hold point right now or were. */
    this.held = 0;
    this.released = false;
    this.aborted = false;
    this._waiters = [];
    this._gate = new Promise((resolve) => { this._open = resolve; });
  }

  _bump() {
    this.held += 1;
    this._waiters = this._waiters.filter((w) => {
      if (this.held >= w.n) { w.resolve(); return false; }
      return true;
    });
  }

  /**
   * Resolves once `n` matching requests are parked. In 'response' phase that
   * means the server has already processed them and only the reply is held.
   */
  waitForHeld(n = 1, { timeout = 10_000 } = {}) {
    if (this.held >= n) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const w = { n, resolve: () => { clearTimeout(timer); resolve(); } };
      const timer = setTimeout(() => {
        this._waiters = this._waiters.filter((x) => x !== w);
        reject(new Error(`${this.phone.name}: waited ${timeout}ms for ${n} held POST(s) matching ${this.label}, saw ${this.held}`));
      }, timeout);
      this._waiters.push(w);
    });
  }

  /** Let held requests (and any later ones) through. */
  release() {
    this.released = true;
    this._open();
  }

  /** Fail held requests (and any later ones) with a network error. */
  abort() {
    this.aborted = true;
    this.released = true;
    this._open();
  }

  /** Stop intercepting. Releases anything still held. */
  async remove() {
    this.release();
    await this.phone.page.unroute(this._matcher, this._handler).catch(() => {});
  }
}

class Player {
  /**
   * @param {import('./table').Table} table
   * @param {{ page: import('@playwright/test').Page, context: import('@playwright/test').BrowserContext, name: string, index: number }} init
   */
  constructor(table, { page, context, name, index }) {
    this.table = table;
    this.page = page;
    this.context = context;
    this.name = name;
    this.index = index;
    /** Every confirm()/alert() the page raised: { type, message, accepted }. */
    this.dialogs = [];
    /** 'accept' or 'dismiss' for the next dialogs. */
    this.dialogPolicy = 'accept';
    this.closed = false;
    this._navigating = 0;
    this._holds = [];
  }

  toString() { return this.name; }

  // ---------- low level ----------

  /** A real touch tap (or a mouse click when the table was opened with input: 'click'). */
  async tap(target, options = {}) {
    const locator = typeof target === 'string' ? this.page.locator(target) : target;
    if (this.table.input === 'click') await locator.click(options);
    else await locator.tap(options);
  }

  /** Options for precondition checks ("is the button there?"); table.preconditionTimeout shortens them. */
  _pre() {
    return this.table.preconditionTimeout ? { timeout: this.table.preconditionTimeout } : {};
  }

  /** The app's latest RoomView (`ui.room`), or null when not in a room. */
  async state() {
    return this.page.evaluate(() => (typeof ui === 'undefined' ? null : ui.room)); // eslint-disable-line no-undef
  }

  /** Raw `ui` fields: { code, selected, busy, showMenu, clueNumber, error }. */
  async ui() {
    return this.page.evaluate(() => (typeof ui === 'undefined' ? null : { // eslint-disable-line no-undef
      code: ui.code, selected: ui.selected, busy: ui.busy, showMenu: ui.showMenu, clueNumber: ui.clueNumber, error: ui.error, // eslint-disable-line no-undef
    }));
  }

  /** Full snapshot (state + DOM facts) used by the invariants. */
  async snapshot() {
    let snap;
    try {
      snap = await this.page.evaluate(pageSnapshot);
    } catch (err) {
      // Mid-navigation: report "not booted" and let the caller poll again.
      if (this.closed) throw err;
      snap = { booted: false, screen: null, path: null, ui: null, offline: false, toast: null, toasts: [], viewport: null, dom: {}, error: String(err.message || err) };
    }
    snap.name = this.name;
    snap.index = this.index;
    return snap;
  }

  /** This phone's own entry in the player list: { id, name, team?, role?, connected } or null. */
  async me() {
    const room = await this.state();
    return room ? room.players.find((p) => p.id === room.you) || null : null;
  }

  /** 'home' | 'lobby' | 'game' | null. */
  async screen() {
    return this.page.evaluate(() => document.getElementById('app')?.dataset.screen || null);
  }

  /**
   * The key: 24 team names ('red'|'blue'|'neutral'|'assassin') as this phone
   * sees them. Throws unless this phone can see all of them (a spymaster, or
   * anyone once the game is over).
   */
  async key() {
    const room = await this.state();
    if (!room || !room.game) throw new Error(`${this.name}: key() needs a game in progress`);
    const key = room.game.cards.map((c) => c.team || null);
    const missing = key.filter((t) => !t).length;
    if (missing) throw new Error(`${this.name}: key() called on a phone that cannot see the key (${missing} of ${key.length} cards have no team)`);
    return key;
  }

  /** Text of every toast shown on this phone since the page loaded. */
  async toasts() {
    return this.page.evaluate(() => (window.__e2e ? window.__e2e.toasts.map((t) => t.text) : []));
  }

  async _toastCount() {
    return this.page.evaluate(() => (window.__e2e ? window.__e2e.toasts.length : 0));
  }

  /** Waits for a toast matching `text` (string or RegExp) that appears after this call starts, or after `since` toasts. */
  async expectToast(text, { since, timeout } = {}) {
    const from = since ?? 0;
    const matches = (t) => (text instanceof RegExp ? text.test(t) : t.includes(text));
    await expect.poll(async () => (await this.toasts()).slice(from).some(matches), {
      message: `${this.name}: expected a toast matching ${text}`,
      timeout: timeout ?? this.table.effectTimeout,
    }).toBe(true);
  }

  async _where() {
    const s = await this.snapshot().catch(() => null);
    if (!s || !s.ui) return '(page not ready)';
    const room = s.ui.room;
    const me = room ? room.players.find((p) => p.id === room.you) : null;
    const g = room && room.game;
    return `[${this.name}: screen=${s.screen} code=${s.ui.code} seat=${me ? `${me.team || '-'}/${me.role || '-'}` : 'none'}` +
      (g ? ` phase=${g.phase} turn=${g.turn} left=${g.guessesLeft} made=${g.guessesMade}` : '') +
      ` busy=${s.ui.busy} offline=${s.offline} toast=${s.toast && s.toast.show ? JSON.stringify(s.toast.text) : 'none'}]`;
  }

  /**
   * After a tap: wait until `pred(arg)` holds in the page (and no request is
   * in flight). Fails if a toast appears instead, or if nothing happens.
   * `pred` runs in the page and may use `ui`.
   */
  async _effect(what, toastsBefore, pred, arg) {
    const timeout = this.table.effectTimeout;
    let res;
    try {
      const handle = await this.page.waitForFunction(({ src, arg: a, n }) => {
        let ok = false;
        // Indirect eval: global scope, where the app's `ui` const lives.
        try { ok = !!(0, eval)(src)(a) && !ui.busy; } catch (_) { ok = false; } // eslint-disable-line no-undef, no-eval
        if (ok) return { ok: true };
        const e = window.__e2e;
        if (e && e.toasts.length > n) return { toast: e.toasts[e.toasts.length - 1].text };
        return false;
      }, { src: `(${pred.toString()})`, arg, n: toastsBefore }, { timeout });
      res = await handle.jsonValue();
    } catch (err) {
      if (!/Timeout/i.test(String(err.message))) throw err;
      throw new Error(`${this.name}: ${what} had no effect: no state change and no toast within ${timeout}ms. ${await this._where()}`);
    }
    if (res.toast != null) throw new Error(`${this.name}: ${what} was refused with the toast ${JSON.stringify(res.toast)}. ${await this._where()}`);
  }

  async _booted(code) {
    await this.page.waitForFunction((c) => {
      const app = document.getElementById('app');
      if (typeof ui === 'undefined' || !app || !app.dataset.screen) return false; // eslint-disable-line no-undef
      return c ? ui.code === c && !!ui.room : true; // eslint-disable-line no-undef
    }, code || null, { timeout: this.table.effectTimeout });
  }

  // ---------- getting in ----------

  /** Navigate to a path on the server under test and wait for the app to render. */
  async goto(path = '/') {
    this._navigating += 1;
    try {
      await this.page.goto(path);
      await this._booted();
    } finally {
      this._navigating -= 1;
    }
  }

  async _submitHome(button, what, code) {
    const page = this.page;
    await expect(page.locator('#app[data-screen="home"]'), `${this.name}: ${what} needs the home screen`).toBeVisible(this._pre());
    await page.locator('#name').fill(this.name);
    if (code != null && button.includes('join') && await page.locator('#code').count()) {
      await page.locator('#code').fill(code);
    }
    // The handler reads e.submitter.value, so the button itself must be tapped.
    await this.tap(page.locator(button));
  }

  async _inRoom(what, code) {
    try {
      await this.page.waitForFunction((c) => {
        const app = document.getElementById('app');
        if (typeof ui === 'undefined') return false; // eslint-disable-line no-undef
        const err = document.querySelector('#home-form p.error');
        if (err && err.textContent.trim()) return { error: err.textContent.trim() };
        return !!ui.room && !!ui.code && (!c || ui.code === c) && app.dataset.screen !== 'home' && !ui.busy; // eslint-disable-line no-undef
      }, code || null, { timeout: this.table.effectTimeout }).then(async (h) => {
        const v = await h.jsonValue();
        if (v && v.error) throw new Error(`${this.name}: ${what} failed with the home screen error ${JSON.stringify(v.error)}`);
      });
    } catch (err) {
      if (!/Timeout/i.test(String(err.message))) throw err;
      throw new Error(`${this.name}: ${what} did not reach the room within ${this.table.effectTimeout}ms. ${await this._where()}`);
    }
    return (await this.ui()).code;
  }

  /**
   * Home screen -> "Create a new game". Returns the 4-letter room code.
   * `wait: false` taps and returns without waiting for the lobby.
   */
  async createRoom({ wait = true } = {}) {
    await this.goto('/');
    await this._submitHome('#home-form button[name="go"][value="create"]', 'createRoom()');
    if (!wait) return null;
    const code = await this._inRoom('createRoom()');
    this.table.code = this.table.code || code;
    return code;
  }

  /** Open the invite link /r/CODE, type the name, tap "Join game CODE". */
  async joinByLink(code = this.table.code, { wait = true } = {}) {
    await this.goto(`/r/${code}`);
    await this._submitHome('#home-form button[name="go"][value="join"]', `joinByLink(${code})`);
    if (!wait) return null;
    return this._inRoom(`joinByLink(${code})`, code.toUpperCase());
  }

  /** Open /, type the name and the code, tap "Join". */
  async joinByCode(code = this.table.code, { wait = true } = {}) {
    await this.goto('/');
    await this._submitHome('#home-form button[name="go"][value="join"]', `joinByCode(${code})`, code);
    if (!wait) return null;
    return this._inRoom(`joinByCode(${code})`, code.toUpperCase());
  }

  /** Text of the home form's error line ('' when there is none). */
  async homeError() {
    return (await this.page.locator('#home-form p.error').textContent()).trim();
  }

  // ---------- lobby ----------

  /**
   * Take a seat: team 'red'|'blue', role 'spymaster'|'guesser'. In the lobby
   * this taps the seat; during a game it opens the menu and taps "Join
   * Orange/Purple" (guesser seats only, and only for watchers). Does nothing
   * if this phone already sits there.
   */
  async sit(team, role, { wait = true } = {}) {
    const me = await this.me();
    if (wait && me && me.team === team && me.role === role) return;
    const what = `sit(${team}, ${role})`;
    const n = await this._toastCount();
    if ((await this.screen()) === 'game') {
      await this.openMenu();
      const btn = this.page.locator(`.sheet [data-sit="${team}:${role}"]`);
      await expect(btn, `${this.name}: ${what}: the menu has no "Join ${TEAM_NAME[team]}" button`).toBeVisible(this._pre());
      await this.tap(btn);
    } else {
      const seat = this.page.locator(`button.seat[data-sit="${team}:${role}"]`);
      await expect(seat, `${this.name}: ${what}: no such seat in the lobby`).toBeVisible(this._pre());
      if (wait) await expect(seat, `${this.name}: ${what}: the seat is taken (button disabled)`).toBeEnabled(this._pre());
      await this.tap(seat, wait ? {} : { force: true });
    }
    if (!wait) return;
    await this._effect(what, n, ({ team: t, role: r }) => {
      const p = ui.room && ui.room.players.find((x) => x.id === ui.room.you); // eslint-disable-line no-undef
      return !!p && p.team === t && p.role === r;
    }, { team, role });
  }

  /** Lobby: "Leave my seat". */
  async stand({ wait = true } = {}) {
    const n = await this._toastCount();
    const btn = this.page.locator('button[data-sit=":"]');
    await expect(btn, `${this.name}: stand(): no "Leave my seat" button (not seated, or not in the lobby)`).toBeVisible(this._pre());
    await this.tap(btn);
    if (!wait) return;
    await this._effect('stand()', n, () => {
      const p = ui.room && ui.room.players.find((x) => x.id === ui.room.you); // eslint-disable-line no-undef
      return !!p && !p.team && !p.role;
    });
  }

  /** Lobby: "Deal the pictures". */
  async start({ wait = true } = {}) {
    const n = await this._toastCount();
    const btn = this.page.locator('#start');
    await expect(btn, `${this.name}: start(): no Deal button (not in the lobby)`).toBeVisible(this._pre());
    if (wait) await expect(btn, `${this.name}: start(): Deal button is disabled (seats not ready)`).toBeEnabled(this._pre());
    await this.tap(btn, wait ? {} : { force: true });
    if (!wait) return;
    await this._effect('start()', n, () => !!(ui.room && ui.room.game && ui.room.game.phase === 'clue')); // eslint-disable-line no-undef
  }

  // ---------- playing ----------

  /**
   * Spymaster: pick the number, type the word, tap "Give clue".
   * `number` is 0..9, or -1 / Infinity / '∞' for unlimited.
   */
  async giveClue(word, number, { wait = true } = {}) {
    const num = number === Infinity || number === '∞' ? -1 : Number(number);
    const what = `giveClue(${JSON.stringify(word)}, ${num === -1 ? '∞' : num})`;
    const page = this.page;
    const form = page.locator('#clue-form');
    await expect(form, `${this.name}: ${what}: no clue form on this phone (not the active spymaster?)`).toBeVisible(this._pre());
    await this.tap(form.locator(`.num[data-num="${num}"]`));
    await expect(form.locator('.num.on'), `${this.name}: ${what}: number button did not light up`).toHaveAttribute('data-num', String(num));
    const input = form.locator('input[name="word"]');
    await input.fill(word);
    // Guard against the form being re-rendered under us (it loses the word).
    await expect(input, `${this.name}: ${what}: the typed clue was wiped before it could be sent`).toHaveValue(word);
    const n = await this._toastCount();
    await this.tap(form.locator('button.btn.primary'));
    if (!wait) return;
    await this._effect(what, n, ({ w, k }) => {
      const g = ui.room && ui.room.game; // eslint-disable-line no-undef
      return !!g && g.phase === 'guess' && !!g.clue && g.clue.word === w && g.clue.number === k;
    }, { w: word.trim(), k: num });
  }

  /** Tap tile `i` to open its zoom sheet. */
  async openCard(i) {
    const tile = this.page.locator(`button.tile[data-card="${i}"]`);
    await expect(tile, `${this.name}: openCard(${i}): no such tile`).toBeVisible(this._pre());
    await this.tap(tile);
    await expect(this.page.locator('.zoom'), `${this.name}: openCard(${i}): tapping the tile did not open the zoom sheet`).toBeVisible(this._pre());
    await expect.poll(async () => (await this.ui()).selected, { message: `${this.name}: openCard(${i}): wrong card selected` }).toBe(i);
  }

  /**
   * Close the zoom sheet. how: 'button' (its Close button, the default) or
   * 'backdrop' (a tap on the dimmed area outside the sheet).
   */
  async closeCard({ how = 'button' } = {}) {
    if (how === 'backdrop') await this.tap(this.page.locator('#modal .zoom-backdrop[data-close]'), { position: { x: 5, y: 5 } });
    else await this.tap(this.page.locator('#modal button[data-close]'));
    await expect(this.page.locator('.zoom'), `${this.name}: closeCard(): the zoom sheet is still open after a tap on its ${how}`).toHaveCount(0);
  }

  /**
   * Guesser: tap tile `i`, then "Guess this picture". Waits for the card to be
   * revealed on this phone. Returns { team, revealedBy } of the revealed card.
   */
  async guess(i, { wait = true } = {}) {
    const what = `guess(${i})`;
    await this.openCard(i);
    const btn = this.page.locator('#modal button[data-guess]');
    if (wait) {
      await expect(btn, `${this.name}: ${what}: the zoom sheet has no Guess button (not an active guesser, or the card is already revealed). ${await this._where()}`).toBeVisible(this._pre());
    }
    const n = await this._toastCount();
    await this.tap(btn);
    if (!wait) return null;
    await this._effect(what, n, (idx) => !!(ui.room && ui.room.game && ui.room.game.cards[idx].revealed), i); // eslint-disable-line no-undef
    const card = (await this.state()).game.cards[i];
    return { team: card.team, revealedBy: card.revealedBy };
  }

  /** Guesser: tap "End turn". Waits for the turn to pass. */
  async endTurn({ wait = true } = {}) {
    const btn = this.page.locator('#end-turn');
    await expect(btn, `${this.name}: endTurn(): no End turn button on this phone`).toBeVisible(this._pre());
    if (wait) await expect(btn, `${this.name}: endTurn(): End turn is disabled (no guess made yet)`).toBeEnabled(this._pre());
    const before = (await this.state()).game.turn;
    const n = await this._toastCount();
    await this.tap(btn, wait ? {} : { force: true });
    if (!wait) return;
    await this._effect('endTurn()', n, (t) => {
      const g = ui.room && ui.room.game; // eslint-disable-line no-undef
      return !!g && g.phase === 'clue' && g.turn !== t;
    }, before);
  }

  /** Open the full-screen viewer on tile `i` by press-and-hold ('hold') or right-click ('contextmenu'). */
  async openViewer(i, { how = 'hold' } = {}) {
    const tile = this.page.locator(`button.tile[data-card="${i}"]`);
    await expect(tile, `${this.name}: openViewer(${i}): no such tile`).toBeVisible(this._pre());
    const viewer = this.page.locator('.viewer');
    if (how === 'contextmenu') {
      await tile.click({ button: 'right' });
      await expect(viewer, `${this.name}: openViewer(${i}): right-click did not open the viewer`).toBeVisible(this._pre());
      return;
    }
    await tile.scrollIntoViewIfNeeded();
    const box = await tile.boundingBox();
    await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await this.page.mouse.down();
    try {
      // The app opens the viewer after a 450ms hold; wait for it, not for time.
      await expect(viewer, `${this.name}: openViewer(${i}): press-and-hold did not open the viewer`).toBeVisible(this._pre());
    } finally {
      await this.page.mouse.up();
    }
  }

  /** Close the full-screen viewer with a tap on its ✕ button. */
  async closeViewer() {
    await this.tap(this.page.locator('button.viewer-close'));
    await expect(this.page.locator('.viewer'), `${this.name}: closeViewer(): viewer still open`).toHaveCount(0);
  }

  // ---------- menu, endings, leaving ----------

  /** Game screen: open the ☰ menu sheet (no-op if already open). */
  async openMenu() {
    const sheet = this.page.locator('.sheet');
    if (await sheet.count()) return;
    await this.tap(this.page.locator('#menu'));
    await expect(sheet, `${this.name}: openMenu(): the menu sheet did not open`).toBeVisible(this._pre());
  }

  /**
   * Close the menu sheet (no-op if closed).
   *   how 'backdrop'  tap the dimmed area beside the sheet, as a player would
   *   how 'escape'    press Escape
   * Default: 'backdrop', except where table.known.backdropTap is set (WebKit
   * with touch input, where that tap does nothing: see tests/touch.spec.js),
   * in which case Escape is used so other tests can carry on.
   */
  async closeMenu({ how } = {}) {
    const sheet = this.page.locator('.sheet');
    if (!(await sheet.count())) return;
    const way = how || (this.table.known.backdropTap ? 'escape' : 'backdrop');
    if (way === 'escape') {
      await this.page.keyboard.press('Escape');
    } else {
      // The sheet covers the backdrop's centre; tap its top-left corner.
      await this.tap(this.page.locator('.sheet-backdrop[data-close-menu]'), { position: { x: 5, y: 5 } });
    }
    await expect(sheet, `${this.name}: closeMenu(): the menu sheet is still open after ${way === 'escape' ? 'Escape' : 'a tap on the backdrop'}`).toHaveCount(0);
  }

  /** Game over: "Play again". Waits for a freshly dealt board. */
  async playAgain({ wait = true } = {}) {
    const btn = this.page.locator('.over-panel #again');
    await expect(btn, `${this.name}: playAgain(): no Play again button (game not over?)`).toBeVisible(this._pre());
    const before = (await this.state()).game.cards.map((c) => c.image).join('|');
    const n = await this._toastCount();
    await this.tap(btn);
    if (!wait) return;
    await this._effect('playAgain()', n, (old) => {
      const g = ui.room && ui.room.game; // eslint-disable-line no-undef
      return !!g && g.phase === 'clue' && g.cards.map((c) => c.image).join('|') !== old;
    }, before);
  }

  /**
   * Send everyone back to the lobby. After a game it taps "Switch teams";
   * mid-game it opens the menu and taps "Back to lobby" (the confirm() is
   * answered by dialogPolicy). `via: 'menu'` forces the menu route.
   */
  async toLobby({ wait = true, via } = {}) {
    const n = await this._toastCount();
    const overBtn = this.page.locator('.over-panel #to-lobby');
    if (via !== 'menu' && await overBtn.count()) {
      await this.tap(overBtn);
    } else {
      await this.openMenu();
      await this.tap(this.page.locator('.sheet #to-lobby'));
    }
    if (!wait) return;
    await this._effect('toLobby()', n, () => !!ui.room && !ui.room.game && document.getElementById('app').dataset.screen === 'lobby'); // eslint-disable-line no-undef
  }

  /**
   * "Leave room" from the lobby or from the game menu (confirm() answered by
   * dialogPolicy). Waits for the home screen.
   */
  async leave({ wait = true } = {}) {
    if ((await this.screen()) === 'game') {
      await this.openMenu();
      await this.tap(this.page.locator('.sheet #leave'));
    } else {
      const btn = this.page.locator('#leave');
      await expect(btn, `${this.name}: leave(): no Leave room button`).toBeVisible(this._pre());
      await this.tap(btn);
    }
    if (!wait) return;
    await expect(this.page.locator('#app[data-screen="home"]'), `${this.name}: leave(): did not return to the home screen`).toBeVisible(this._pre());
  }

  /**
   * Reload the page and wait for the app to come back (in its room, if it was
   * in one). `wait: false` returns as soon as the page has loaded, without
   * looking into it.
   */
  async reload({ wait = true } = {}) {
    const before = wait ? await this.ui() : null;
    this._navigating += 1;
    try {
      await this.page.reload();
      if (wait) await this._booted(before && before.code);
    } finally {
      this._navigating -= 1;
    }
  }

  // ---------- network shaping ----------

  _postMatcher(action) {
    if (action instanceof RegExp) return action;
    if (action === 'create') return /\/api\/rooms$/;
    if (action === '*' || action == null) return /\/api\/rooms(\/[^/]+\/[^/]+)?$/;
    return new RegExp(`/api/rooms/[^/]+/${action}$`);
  }

  /**
   * Park this phone's POSTs to an app action ('join', 'sit', 'start', 'lobby',
   * 'clue', 'guess', 'end-turn', 'leave', 'create', '*' or a RegExp on the URL).
   *
   *   phase 'response' (default): the server handles the request at once and
   *     only the reply is held back from the page.
   *   phase 'request': the request is held before it reaches the server.
   *   times: intercept only the first N matching requests.
   *   delayMs: release automatically after this long (see delayPost).
   *
   * Returns a PostHold: { requests, held, waitForHeld(n), release(), abort(), remove() }.
   * Anything still held is released when the test ends.
   */
  async holdPost(action, { phase = 'response', times = Infinity, delayMs = null } = {}) {
    const matcher = this._postMatcher(action);
    const hold = new PostHold(this, String(action), phase);
    let seen = 0;
    const handler = async (route) => {
      const req = route.request();
      if (req.method() !== 'POST' || seen >= times) { await route.fallback(); return; }
      seen += 1;
      hold.requests.push({ url: req.url(), method: req.method(), body: req.postDataJSON?.() ?? null, at: Date.now() });
      try {
        let response = null;
        if (phase === 'response') response = await route.fetch();
        hold._bump();
        if (delayMs != null) {
          // Deliberate delay inside a route handler: this is the race window.
          await Promise.race([hold._gate, new Promise((r) => setTimeout(r, delayMs))]);
        } else {
          await hold._gate;
        }
        if (hold.aborted) await route.abort('failed');
        else if (response) await route.fulfill({ response });
        else await route.continue();
      } catch (err) {
        // The page or context went away while the request was parked.
        if (!this.closed && !/closed|disposed|Route is already handled/i.test(String(err.message))) throw err;
      }
    };
    hold._matcher = matcher;
    hold._handler = handler;
    await this.page.route(matcher, handler);
    this._holds.push(hold);
    return hold;
  }

  /** Delay the reply (or, with phase: 'request', the request) of matching POSTs by `ms`. Returns the PostHold. */
  async delayPost(action, ms, { phase = 'response', times = Infinity } = {}) {
    return this.holdPost(action, { phase, times, delayMs: ms });
  }

  /** Make matching POSTs fail with a network error before they reach the server. Returns the PostHold. */
  async abortPost(action, { times = Infinity } = {}) {
    const hold = await this.holdPost(action, { phase: 'request', times });
    hold.abort();
    return hold;
  }

  async _releaseHolds() {
    for (const h of this._holds) h.release();
  }
}

module.exports = { Player, PostHold, pageSnapshot, initScript, TEAM_NAME };
