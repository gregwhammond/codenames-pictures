'use strict';
// The `table` fixture: a set of phones around one game.
//
//   const { test, expect } = require('../lib/table');
//   test('…', async ({ table }) => {
//     const [ada, ben, cy, dee] = await table.setupRoom();   // room, seats, deal: all by tapping
//     await ada.giveClue('river', 2);
//     await table.check('after the clue');                    // converge, then every invariant
//   });
//
// Each phone is its own browser context (own storage, own event stream). Every
// page records JS errors, console errors, failed requests, HTTP errors and
// requests to /api/rooms/null/. A test fails at teardown on anything recorded
// that it did not declare with table.expectError() or table.allowError().

const base = require('@playwright/test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Player, initScript } = require('./player');
const inv = require('./invariants');
const server = require('./server');
const { makeRng } = require('./rng');
const { Bot } = require('./bot');

const WATCH = process.env.WATCH === '1';
const STRICT = process.env.E2E_STRICT === '1';
const DEFAULT_NAMES = ['Ada', 'Ben', 'Cy', 'Dee', 'Eve', 'Fay', 'Gus', 'Hal', 'Ivy', 'Jo', 'Kit', 'Lu'];
/** Seat for phone i when setupRoom() is not told otherwise. */
const DEFAULT_SEATS = [['red', 'spymaster'], ['red', 'guesser'], ['blue', 'spymaster'], ['blue', 'guesser']];

const CANCELLED = /ERR_ABORTED|abort|cancel/i;

// Traces and video are recorded by the fixture, one per phone, and kept only
// when the test fails. The runner's own `trace` option is off in the config:
// with Playwright 1.56 on Node 26 its trace merge step never finishes when a
// context is still open at the end of a failed test, and the test then hangs
// until its timeout. Recording per context here avoids that code path.
const RECORD_TRACE = process.env.E2E_TRACE !== '0';
const RECORD_VIDEO = process.env.E2E_VIDEO !== '0';

function matcherFn(m) {
  if (typeof m === 'function') return m;
  if (m instanceof RegExp) return (e) => m.test(`${e.kind}: ${e.text}`);
  if (typeof m === 'string') return (e) => `${e.kind}: ${e.text}`.includes(m);
  return (e) => (
    (m.kind == null || e.kind === m.kind) &&
    (m.phone == null || e.phone === (m.phone.name || m.phone)) &&
    (m.status == null || e.status === m.status) &&
    (m.url == null || (m.url instanceof RegExp ? m.url.test(e.url || '') : (e.url || '').includes(m.url))) &&
    (m.text == null || (m.text instanceof RegExp ? m.text.test(e.text) : e.text.includes(m.text)))
  );
}

class Table {
  constructor({ browser, browserName, contextOptions, testInfo }) {
    this.browser = browser;
    this.browserName = browserName;
    this.contextOptions = contextOptions;
    this.testInfo = testInfo;
    /** Open phones, in the order they were added. */
    this.phones = [];
    /** Room code of the first room created through this table. */
    this.code = null;
    /** 'tap' (touch events, the default) or 'click' (mouse). */
    this.input = 'tap';
    /** How long a tap may take to show its effect, and phones to converge. */
    this.effectTimeout = 10_000;
    this.settleTimeout = 10_000;
    /** Shorter timeout (ms) for "is the button there?" checks inside actions; unset = Playwright's expect timeout. */
    this.preconditionTimeout = null;
    /**
     * Known-issue switches: app behaviour the harness steps around so that
     * unrelated tests can run. Each has its own test that asserts the real
     * behaviour (marked test.fail). E2E_STRICT=1 turns them all off.
     *   backdropTap  WebKit + touch: a tap on .sheet-backdrop / .zoom-backdrop
     *                produces no click, so it does not close the sheet.
     *                closeMenu() presses Escape instead. See tests/touch.spec.js.
     *   vibrate      Chromium: a page that is loaded when it is already this
     *                phone's turn calls navigator.vibrate() before it has been
     *                tapped (web/app.js:223). Chromium refuses and logs a
     *                console error. A phone whose trace is being recorded
     *                counts as tapped from the moment it loads (measured:
     *                navigator.userActivation is already active), so there
     *                this shows only when the app gets in first: a rare race.
     *                That one console line is let through while this is true.
     *                Scenario 15 in tests/edge.spec.js shows it every time, on
     *                phones opened with { trace: false }.
     */
    this.known = { backdropTap: !STRICT && browserName === 'webkit', vibrate: !STRICT && browserName === 'chromium' };
    /** Invariant ids or prefixes skipped by every check() in this test. */
    this.skip = [];
    /** Every problem recorded on any page: { phone, kind, text, url?, status?, method?, at }. */
    this.errors = [];
    /** Number of check() calls that passed. */
    this.checks = 0;
    this.seed = process.env.E2E_SEED ? Number(process.env.E2E_SEED) : crypto.randomInt(1, 2 ** 31 - 1);
    /** Seeded PRNG shared by bots: rng() in [0,1), rng.int(n), rng.pick(list), rng.shuffle(list). */
    this.rng = makeRng(this.seed);
    this._history = new Map();
    this._expected = [];
    this._allowed = [];
    // See this.known.vibrate above. Read at check time, so a test can turn it off.
    this.allowError(
      (e) => this.known.vibrate && e.kind === 'console' && /Blocked call to navigator\.vibrate because user hasn't tapped/.test(e.text),
      'Chromium: vibrate() before the first tap after a reload (table.known.vibrate)',
    );
    this._contexts = [];
    this._logStart = server.logSize();
    this._closing = false;
  }

  // ---------- phones ----------

  /**
   * Open one more phone on a blank page. `name` is what it will type on the
   * home screen. `options` are extra browser context options (for example a
   * different viewport), plus:
   *   trace: false   record no trace for this phone. A traced page looks
   *                  "already tapped" to the browser, which hides anything a
   *                  browser refuses to do before the first real tap.
   */
  async addPhone(name, { trace = true, ...options } = {}) {
    const index = this.phones.length;
    const phoneName = name || DEFAULT_NAMES[index] || `P${index + 1}`;
    const viewport = options.viewport || this.contextOptions.viewport;
    const context = await this.browser.newContext({
      ...this.contextOptions,
      reducedMotion: 'reduce', // style.css turns every animation off
      serviceWorkers: 'block',
      ...(RECORD_VIDEO && viewport ? { recordVideo: { dir: this.testInfo.outputPath('video'), size: viewport } } : {}),
      ...options,
    });
    const entry = { context, name: phoneName, slug: `${index + 1}-${phoneName.replace(/[^A-Za-z0-9]+/g, '-')}`, tracing: false, traceFile: null, pages: [] };
    this._contexts.push(entry);
    if (RECORD_TRACE && trace) {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false, title: `${this.testInfo.title} / ${phoneName}` });
      entry.tracing = true;
    }
    await context.addInitScript(initScript);
    const page = await context.newPage();
    entry.pages.push(page);
    const phone = new Player(this, { page, context, name: phoneName, index });
    this._watch(phone);
    this.phones.push(phone);
    if (WATCH) await this._placeWindow(phone).catch(() => {});
    return phone;
  }

  /** A second tab in the same browser context as `phone` (same player token). */
  async addTab(phone, name = `${phone.name} (tab 2)`) {
    const page = await phone.context.newPage();
    this._contexts.find((e) => e.context === phone.context).pages.push(page);
    const tab = new Player(this, { page, context: phone.context, name, index: this.phones.length });
    tab.sharedContext = true;
    this._watch(tab);
    this.phones.push(tab);
    return tab;
  }

  /** Open `n` phones (default four). Returns them. */
  async open(n = 4, names = []) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(await this.addPhone(names[i]));
    return out;
  }

  /** Close a phone (its tab, and its context unless shared) and drop it from the table. */
  async closePhone(phone) {
    phone.closed = true;
    await phone._releaseHolds();
    this.phones = this.phones.filter((p) => p !== phone);
    if (this.phones.some((p) => p.context === phone.context)) { await phone.page.close(); return; }
    const entry = this._contexts.find((e) => e.context === phone.context);
    if (entry && entry.tracing) {
      // Keep the trace until the test's outcome is known.
      entry.traceFile = this.testInfo.outputPath(`trace-${entry.slug}.zip`);
      await phone.context.tracing.stop({ path: entry.traceFile }).catch(() => { entry.traceFile = null; });
      entry.tracing = false;
    }
    await phone.context.close();
  }

  _record(phone, kind, text, extra = {}) {
    if (this._closing || phone.closed) return;
    this.errors.push({ phone: phone.name, kind, text: String(text), at: Date.now(), ...extra });
  }

  _watch(phone) {
    const { page } = phone;
    page.on('dialog', async (dialog) => {
      const accepted = phone.dialogPolicy !== 'dismiss';
      phone.dialogs.push({ type: dialog.type(), message: dialog.message(), accepted });
      await (accepted ? dialog.accept() : dialog.dismiss()).catch(() => {});
    });
    page.on('pageerror', (err) => this._record(phone, 'pageerror', err.stack || err.message || err));
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      // The browser's own line for a failed load; recorded as 'http' or 'requestfailed' instead.
      if (/Failed to load resource/i.test(text)) return;
      this._record(phone, 'console', text, { url: msg.location().url });
    });
    page.on('request', (req) => {
      if (req.url().includes('/api/rooms/null/')) this._record(phone, 'null-room', `${req.method()} ${req.url()}`, { url: req.url(), method: req.method() });
    });
    page.on('requestfailed', (req) => {
      const why = (req.failure() && req.failure().errorText) || 'failed';
      const type = req.resourceType();
      // A closed event stream, a picture dropped by a re-render, or anything
      // cut off by a reload the test asked for is the browser cancelling, not
      // a failure. A stream that really fails shows up as body.offline.
      if (CANCELLED.test(why) && (phone._navigating > 0 || type === 'eventsource' || type === 'image' || /\/events\?/.test(req.url()))) return;
      this._record(phone, 'requestfailed', `${req.method()} ${req.url()} (${type}): ${why}`, { url: req.url(), method: req.method() });
    });
    page.on('response', (res) => {
      if (res.status() < 400) return;
      const req = res.request();
      this._record(phone, 'http', `${req.method()} ${res.url()} -> ${res.status()}`, { url: res.url(), method: req.method(), status: res.status() });
    });
    page.on('crash', () => this._record(phone, 'pageerror', 'the page crashed'));
  }

  async _placeWindow(phone) {
    if (this.browserName !== 'chromium') return;
    const vp = phone.page.viewportSize();
    const cdp = await phone.context.newCDPSession(phone.page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    const width = vp.width + 16;
    await cdp.send('Browser.setWindowBounds', {
      windowId,
      bounds: { left: 10 + (phone.index % 6) * (width + 8), top: 40 + Math.floor(phone.index / 6) * 80, width, height: vp.height + 90 },
    });
  }

  // ---------- declared errors ----------

  /**
   * Declare a page problem this test is about. `matcher` is a RegExp or string
   * tested against "kind: text", a function (entry) => boolean, or an object
   * { kind, phone, status, url, text }. Kinds: 'pageerror', 'console',
   * 'requestfailed', 'http', 'null-room', 'race'.
   * The test FAILS at teardown if nothing matched (so a fixed bug is noticed).
   */
  expectError(matcher, description = String(matcher)) {
    this._expected.push({ fn: matcherFn(matcher), description, hits: 0 });
  }

  /** Like expectError, but it is fine if it never happens. */
  allowError(matcher, description = String(matcher)) {
    this._allowed.push({ fn: matcherFn(matcher), description, hits: 0 });
  }

  /** Recorded problems that no expectError/allowError covers. */
  unexpectedErrors() {
    for (const m of [...this._expected, ...this._allowed]) m.hits = 0;
    return this.errors.filter((e) => {
      let covered = false;
      for (const m of [...this._expected, ...this._allowed]) {
        if (m.fn(e)) { m.hits += 1; covered = true; }
      }
      return !covered;
    });
  }

  // ---------- checking ----------

  /** Snapshots of the given phones (default: all open ones), in order. */
  async snapshots(phones = this.phones) {
    // A phone that has not been pointed at the app yet has nothing to check.
    return Promise.all(phones.filter((p) => !p.closed && p.page.url() !== 'about:blank').map((p) => p.snapshot()));
  }

  /**
   * Wait until the phones agree and are idle, without running the hard
   * checks. Returns the settled snapshots. Throws, naming phone and field, if
   * they have not converged within settleTimeout.
   */
  async settle(label = '', { phones = this.phones, skip = [], timeout = this.settleTimeout } = {}) {
    const skipAll = [...this.skip, ...skip];
    let snaps = [];
    let problems = [];
    try {
      await base.expect(async () => {
        snaps = await this.snapshots(phones);
        problems = inv.applySkip(inv.settleProblems(snaps), skipAll);
        if (problems.length) throw new Error('not settled');
      }).toPass({ timeout, intervals: [20, 50, 100, 200] });
    } catch (err) {
      if (!problems.length) throw err;
      throw new Error(inv.format(problems, `Phones did not converge within ${timeout}ms${label ? ` ${label}` : ''} (seed ${this.seed}):`));
    }
    return snaps;
  }

  /**
   * The check to run after every action: wait for the phones to converge, then
   * assert every invariant on JSON and DOM (see INVARIANTS in invariants.js).
   *
   *   label    words for the failure message, e.g. 'after Ben guesses card 3'
   *   phones   check only these phones (default: every open phone)
   *   skip     invariant ids or prefixes to leave out, e.g. ['roster.ghosts']
   *
   * Returns { snaps, room, game } where room is the first in-room phone's
   * RoomView (null if no phone is in a room).
   */
  async check(label = '', { phones = this.phones, skip = [], timeout } = {}) {
    const skipAll = [...this.skip, ...skip];
    const snaps = await this.settle(label, { phones, skip, timeout });
    const bad = inv.violations(snaps, { history: this._history, unexpectedErrors: this.unexpectedErrors(), skip: skipAll });
    if (bad.length) {
      throw new Error(inv.format(bad, `Invariant${bad.length > 1 ? 's' : ''} violated${label ? ` ${label}` : ''} (seed ${this.seed}):`));
    }
    this.checks += 1;
    const ref = snaps.find((s) => inv.inRoom(s));
    const room = ref ? ref.ui.room : null;
    return { snaps, room, game: room ? room.game || null : null };
  }

  /** test.step(title, fn) followed by check(`after ${title}`). Returns fn's result. */
  async step(title, fn, checkOptions = {}) {
    return base.test.step(title, async () => {
      const result = await fn();
      await this.check(`after: ${title}`, checkOptions);
      return result;
    });
  }

  /**
   * Who sits where, read from the phones:
   * { red: { spymaster: Player|null, guessers: Player[] }, blue: {…}, watchers: Player[], out: Player[] }.
   * `out` are phones not in a room.
   */
  async roles(phones = this.phones) {
    const out = { red: { spymaster: null, guessers: [] }, blue: { spymaster: null, guessers: [] }, watchers: [], out: [] };
    const live = phones.filter((p) => !p.closed);
    const mes = await Promise.all(live.map((p) => p.me()));
    live.forEach((p, i) => {
      const me = mes[i];
      if (!me) out.out.push(p);
      else if (!me.team) out.watchers.push(p);
      else if (me.role === 'spymaster') out[me.team].spymaster = out[me.team].spymaster || p;
      else out[me.team].guessers.push(p);
    });
    return out;
  }

  /**
   * Build a table through the UI: the first phone creates a room, the rest
   * join (alternating invite link and typed code unless `join` says
   * otherwise), everyone sits, and one phone deals. Invariants are checked
   * after every step.
   *
   *   phones  how many to open (default 4), or existing Player objects
   *   names   names to type
   *   join    'link' | 'code' | array per joining phone
   *   seats   per phone: [team, role] or null to stay unseated.
   *           Default: red spymaster, red guesser, blue spymaster, blue guesser, rest unseated
   *   start   deal the pictures (default true); false leaves everyone in the lobby
   *
   * Returns the phones, in order.
   */
  async setupRoom({ phones = 4, names = [], join, seats = DEFAULT_SEATS, start = true } = {}) {
    const list = Array.isArray(phones) ? phones : await this.open(phones, names);
    const [host, ...rest] = list;
    await this.step(`${host.name} creates a room`, () => host.createRoom(), { phones: [host] });
    const code = (await host.ui()).code;
    this.code = code;
    for (let i = 0; i < rest.length; i++) {
      const how = Array.isArray(join) ? join[i] || 'link' : join || (i % 2 === 0 ? 'link' : 'code');
      const p = rest[i];
      await this.step(`${p.name} joins by ${how}`, () => (how === 'code' ? p.joinByCode(code) : p.joinByLink(code)), { phones: [host, ...rest.slice(0, i + 1)] });
    }
    for (let i = 0; i < list.length; i++) {
      const seat = seats[i];
      if (!seat) continue;
      await this.step(`${list[i].name} sits as ${seat[0]} ${seat[1]}`, () => list[i].sit(seat[0], seat[1]), { phones: list });
    }
    if (start) await this.step(`${host.name} deals`, () => host.start(), { phones: list });
    return list;
  }

  /**
   * Open the zoom sheet and the full-screen viewer on unrevealed cards on each
   * given phone (default: every phone that must not see the key) and run the
   * invariants while they are open, so secrecy.zoom and secrecy.viewer are
   * exercised. `cards` is how many cards to try per phone.
   */
  async probeSecrecy({ phones, cards = 2 } = {}) {
    const snaps = await this.snapshots();
    const targets = phones || this.phones.filter((p) => {
      const s = snaps.find((x) => x.name === p.name);
      return s && inv.inRoom(s) && s.ui.room.game && s.ui.room.game.phase !== 'over' && !inv.seesKey(s);
    });
    for (const p of targets) {
      const game = (await p.state()).game;
      const hidden = game.cards.map((c, i) => (c.revealed ? -1 : i)).filter((i) => i >= 0);
      const picks = this.rng.shuffle(hidden).slice(0, cards);
      for (const [n, i] of picks.entries()) {
        await p.openCard(i);
        await this.check(`with ${p.name}'s zoom sheet open on card ${i}`);
        await p.closeCard();
        await p.openViewer(i, { how: n % 2 === 0 ? 'hold' : 'contextmenu' });
        await this.check(`with ${p.name}'s full-screen viewer open on card ${i}`);
        await p.closeViewer();
      }
    }
    await this.check('after closing the zoom sheet and viewer');
  }

  // ---------- teardown ----------

  async _closeContexts(keep) {
    const { testInfo } = this;
    for (const entry of this._contexts) {
      const { context, slug, pages } = entry;
      if (entry.tracing) {
        entry.traceFile = keep ? testInfo.outputPath(`trace-${slug}.zip`) : null;
        await context.tracing.stop(entry.traceFile ? { path: entry.traceFile } : {}).catch(() => { entry.traceFile = null; });
        entry.tracing = false;
      }
      if (entry.traceFile && keep) testInfo.attachments.push({ name: 'trace', path: entry.traceFile, contentType: 'application/zip' });
      else if (entry.traceFile) await fs.promises.rm(entry.traceFile, { force: true }).catch(() => {});
      await context.close().catch(() => {});
      if (!RECORD_VIDEO) continue;
      for (const [i, page] of pages.entries()) {
        const video = page.video();
        if (!video) continue;
        if (keep) {
          const file = testInfo.outputPath(`video-${slug}${i ? `-tab${i + 1}` : ''}.webm`);
          await video.saveAs(file).then(() => testInfo.attachments.push({ name: `video-${slug}`, path: file, contentType: 'video/webm' }), () => {});
        }
        await video.delete().catch(() => {});
      }
    }
    if (RECORD_VIDEO) await fs.promises.rm(testInfo.outputPath('video'), { recursive: true, force: true }).catch(() => {});
  }

  async _finish() {
    const { testInfo } = this;
    const failed = testInfo.status !== testInfo.expectedStatus;
    const problems = [];

    for (const p of this.phones) await p._releaseHolds();

    // Race reports the server printed while this test ran.
    const { unknown } = server.scanRaces(server.readLogFrom(this._logStart));
    for (const r of unknown) {
      this.errors.push({ phone: '(server)', kind: 'race', text: `the server reported a DATA RACE while this test ran (other tests may have been running too):\n${r.trim()}`, at: Date.now() });
    }

    const unexpected = this.unexpectedErrors();
    if (unexpected.length) {
      problems.push(`${unexpected.length} problem(s) recorded on the phones that the test did not declare with table.expectError()/allowError():\n` +
        unexpected.map((e) => `  [${e.kind}] ${e.phone}: ${e.text}`).join('\n'));
    }
    const missing = this._expected.filter((m) => m.hits === 0);
    if (missing.length && !failed) {
      problems.push('table.expectError() declared problems that never happened (was the bug fixed? then drop the declaration):\n' +
        missing.map((m) => `  ${m.description}`).join('\n'));
    }

    if (this.errors.length) {
      await testInfo.attach('page-problems.json', { body: JSON.stringify(this.errors, null, 2), contentType: 'application/json' }).catch(() => {});
    }
    testInfo.annotations.push({ type: 'seed', description: String(this.seed) });
    if (failed || problems.length) {
      // Printed so a failing run can be replayed.
      console.log(`[e2e] "${testInfo.title}" [${testInfo.project.name}] failed with seed ${this.seed}. Replay: E2E_SEED=${this.seed} npx playwright test ${JSON.stringify(testInfo.file)} --project=${testInfo.project.name} -g ${JSON.stringify(testInfo.title)}`);
    }

    this._closing = true;
    for (const p of this.phones) p.closed = true;
    await this._closeContexts(failed || problems.length > 0);

    if (problems.length) {
      // A test marked as an expected failure (knownBug) would absorb this
      // error: it is failing already, as expected. Take the mark off so that
      // an undeclared problem always fails the test for real.
      if (testInfo.expectedStatus === 'failed') testInfo.expectedStatus = 'passed';
      throw new Error(`${problems.join('\n\n')}\n(seed ${this.seed})`);
    }
  }
}

const test = base.test.extend({
  table: async ({ browser, browserName, baseURL, viewport, userAgent, deviceScaleFactor, isMobile, hasTouch }, use, testInfo) => {
    const contextOptions = { baseURL, viewport, userAgent, deviceScaleFactor, isMobile, hasTouch };
    for (const k of Object.keys(contextOptions)) if (contextOptions[k] === undefined) delete contextOptions[k];
    const table = new Table({ browser, browserName, contextOptions, testInfo });
    await use(table);
    await table._finish();
  },

  // A Bot bound to the table. Its move list is attached to the report.
  bot: async ({ table }, use) => {
    const bot = new Bot(table);
    await use(bot);
    await bot.attachLog();
  },
});

module.exports = { test, expect: base.expect, Table, Bot, DEFAULT_NAMES, DEFAULT_SEATS };
