'use strict';
// Layout at phone sizes, upright and sideways. Runs on every project in
// playwright.config.js: 360x780, 390x844, 430x932 (both engines) and three
// landscape sizes (780x360, 844x390, 932x430).
//
// Each test walks real phones to a screen by tapping, then for every phone
// measures the page in the browser (lib/layout-helpers.js) and saves a
// screenshot to e2e/screenshots/<project>/<screen>/<seat>.jpg for a human to
// look through. The rules checked on every capture:
//   - the window is the size the phone asked for and the page does not scroll
//     sideways; nothing rendered sticks out of the viewport
//   - game screen: exactly 24 tiles in 4 columns by 6 rows, square, one size,
//     inside the board region, clear of the score bar and the action bar, and
//     tappable; every action control inside the viewport and tappable; #menu
//     inside the viewport and tappable
//   - the key frames are really painted (computed ::after style) on a phone
//     that may see the key, and absent on one that may not
//   - the zoom sheet, the menu sheet and the full-screen viewer are inside the
//     viewport with their buttons tappable
// A test collects every broken rule on every phone before failing, so one run
// shows the whole picture.

const { test, expect } = require('../lib/table');
const { LayoutRun, seatLabel, pageLayout, layoutProblems } = require('../lib/layout-helpers');
const { knownBug } = require('../lib/known-bug');

// Five phones: both spymasters, a guesser on each team, and one watcher.
const PHONES = 5;
/** A 14-letter clue, the length the plan asks for. */
const CLUE_14 = 'understandable';
const CLUE_14_B = 'counterbalance';
/** The longest clue the form and the server accept (40 letters). */
const CLUE_40 = 'pneumonoultramicroscopicsilicovolcanocon';
const CLUES = [[8, 'umbrella'], [10, 'lighthouse'], [12, 'thunderstorm'], [14, CLUE_14], [40, CLUE_40]];
/** The longest name the form and the server accept (20 letters), with nowhere to break. */
const LONG_NAMES = [1, 2, 3, 4, 5].map((i) => `Wolfeschlegelsteinh${i}`);

// KNOWN BUG 1: a long clue widens the score bar and pushes #menu (and, when
// longer still, the Purple score) off the right edge of the screen, on every
// phone at the table, for as long as that clue is showing. The page gains a
// sideways scroll; Chromium's phone emulation zooms the whole page out instead.
//   web/style.css:180  .scorebar { grid-template-columns: 64px 1fr 64px 40px }
//                      The 1fr track is minmax(auto, 1fr): it cannot shrink
//                      below the min-content width of what is in it.
//   web/style.css:201  .clue-word { display: inline-block } with no max-width,
//                      wrapping or ellipsis, so the whole word is that minimum.
//   web/style.css:422  landscape: the score bar lives in a column of
//                      minmax(240px, 34%), which leaves the clue about 80px
//                      (:431 .scorebar { grid-template-columns: 56px 1fr 56px 36px }).
//   web/app.js:446     clueText() renders the word; web/app.js:481 allows 40
//                      letters (so does game.go:20 maxClueWordSize).
// Measured: the letter counts below overflow on each project; every shorter
// one tested (6, 8, 10, 12, 14) fits. The words are in CLUES.
const CLUE_BUG = {
  id: 'long-clue-overflow',
  title: 'A long clue pushes #menu off the right edge of the screen: the score bar\'s 1fr track cannot shrink below the unbreakable .clue-word',
  where: 'web/style.css:180 and :201; landscape column :422 and :431; web/app.js:446 and :481',
  // The rule that names the bug: #menu is not inside the phone's screen.
  shows: /\[menu\.viewport\] #menu .* is not inside the \d+x\d+ viewport with the clue "/,
};
/** Every other rule a too-wide score bar is known to break along with it. Anything else is a new problem. */
const CLUE_BUG_RULES = [
  'menu.viewport', 'menu.tappable', 'scorebar', 'clue.viewport', // what is pushed off the right edge
  'box.overflow',                 // the score bar holds more than its width
  'page.hscroll', 'page.overflow', // WebKit: the page scrolls sideways
  'viewport.size',                // Chromium: the page is zoomed out instead
];
const KNOWN_CLUE_OVERFLOW = {
  'android-chromium': [12, 14, 40],          // 360x780
  'iphone-webkit': [40],                     // 390x844
  'large-chromium': [40],                    // 430x932
  'large-webkit': [40],                      // 430x932
  'landscape-chromium': [8, 10, 12, 14, 40], // 780x360
  'landscape-webkit': [10, 12, 14, 40],      // 844x390
  'landscape-large-webkit': [12, 14, 40],    // 932x430
};
const clueOverflows = (project, letters) => (KNOWN_CLUE_OVERFLOW[project] || []).includes(letters);

// KNOWN BUG 2: in the lobby a long name with nowhere to break widens its team
// column, and the page becomes 451px wide whatever the phone: on any screen
// narrower than that the Purple team's seats run off the right edge.
//   web/style.css:136  .teams { grid-template-columns: 1fr 1fr } (1fr cannot
//                      shrink below the name's width)
//   web/style.css:158  .seat-people / .person: no wrapping or ellipsis
//   web/app.js:353     person() renders the name; web/app.js:276 allows 20
//                      letters (so does room.go:23 maxNameLength).
// Landscape phones are wider than 451px, so there it fits.
const LONG_NAME_BUG = {
  id: 'long-name-lobby-overflow',
  title: 'A 20-letter name makes the lobby 451px wide, so the Purple team\'s seats run off the right edge of any narrower screen: the .teams 1fr columns cannot shrink below an unbreakable name',
  where: 'web/style.css:136 and :158; web/app.js:353 and :276',
  // The rule that names the bug: a Purple seat is not inside the window.
  shows: /\[lobby\.controls\] button\.seat\[data-sit="blue:(spymaster|guesser)"\] .* is not inside the \d+px wide window/,
};
const LONG_NAME_BUG_RULES = ['lobby.controls', 'box.overflow', 'page.hscroll', 'page.overflow', 'viewport.size'];
const LOBBY_WIDTH_WITH_LONG_NAMES = 451;
const LONG_NAME_OVERFLOW = (viewport) => viewport.width < LOBBY_WIDTH_WITH_LONG_NAMES;

/**
 * End a test on a screen with a known layout bug. Rules outside `rules` are
 * not explained by the bug and fail the test for real; the rest is handed to
 * knownBug(), which wants to see the rule that names the bug.
 */
async function finishWithKnownBug(run, table, bug, rules, when) {
  await run.save();
  if (when) {
    const stray = run.problems().filter((p) => !rules.includes((p.match(/\[([a-z.]+)\]/) || [])[1]));
    expect(stray, `layout rules broken that the known bug "${bug.id}" does not explain`).toEqual([]);
  }
  await knownBug(table, bug, () => run.finish(), { when });
}

/** One capture per phone, named after its seat. */
async function captureAll(run, table, folder, options) {
  for (const p of table.phones) await run.capture(p, `${folder}/${await seatLabel(p)}`, options);
}

test.describe('Layout', () => {
  test('home screen: create or join, invite link, error line, how to play', async ({ table }) => {
    const run = new LayoutRun(table);
    const [ada] = await table.open(1);

    await ada.goto('/');
    await run.capture(ada, 'home/create-or-join', { need: ['home'] });

    await ada.tap(ada.page.locator('.how summary'));
    await expect(ada.page.locator('.how ol')).toBeVisible();
    await run.capture(ada, 'home/how-to-play-open', { need: ['home'] });

    // A code nobody has: the error line appears under the form.
    table.expectError({ kind: 'http', status: 404, url: /\/api\/rooms\/QQQQ\/join$/ }, 'joining a room that does not exist answers 404');
    await ada.joinByCode('QQQQ', { wait: false });
    await expect.poll(() => ada.homeError(), { message: 'the home form should explain that the code is unknown' }).toMatch(/No game with that code/);
    await run.capture(ada, 'home/join-error', { need: ['home'] });

    await ada.goto('/r/ABCD');
    await run.capture(ada, 'home/invite-link', { need: ['home'] });
    await table.check('on the home screen');
    await run.finish();
  });

  test('lobby: nobody seated, then every seat taken and one watcher', async ({ table }) => {
    const run = new LayoutRun(table);
    const phones = await table.setupRoom({ phones: PHONES, seats: [], start: false });
    await run.capture(phones[0], 'lobby/nobody-seated', { need: ['lobby'] });

    const seats = [['red', 'spymaster'], ['red', 'guesser'], ['blue', 'spymaster'], ['blue', 'guesser']];
    for (const [i, [team, role]] of seats.entries()) await phones[i].sit(team, role);
    await table.check('with every seat taken');
    for (const p of phones) await run.capture(p, `lobby/seated-${await seatLabel(p)}`, { need: ['lobby'] });
    await run.finish();
  });

  test('lobby with the longest names the form accepts (20 letters): both teams stay on screen', async ({ table }, testInfo) => {
    const run = new LayoutRun(table);
    const phones = await table.setupRoom({ phones: PHONES, names: LONG_NAMES, start: false });
    for (const [p, name] of [[phones[0], 'orange-spymaster'], [phones[3], 'purple-guesser'], [phones[4], 'watcher']]) {
      await run.capture(p, `long-names/lobby-${name}`, { need: ['lobby'] });
    }
    await finishWithKnownBug(run, table, LONG_NAME_BUG, LONG_NAME_BUG_RULES, LONG_NAME_OVERFLOW(testInfo.project.use.viewport));
  });

  test('menu sheet with the longest names the form accepts (20 letters)', async ({ table }) => {
    const run = new LayoutRun(table);
    const phones = await table.setupRoom({ phones: PHONES, names: LONG_NAMES });
    for (const [p, name] of [[phones[0], 'spymaster'], [phones[4], 'watcher']]) {
      await p.openMenu();
      await table.check(`with ${p.name}'s menu open`);
      await run.capture(p, `long-names/menu-${name}`, { need: ['board', 'sheet'] });
      await p.closeMenu();
    }
    await run.finish();
  });

  test('game, clue phase: every seat', async ({ table }) => {
    const run = new LayoutRun(table);
    await table.setupRoom({ phones: PHONES });
    await captureAll(run, table, 'clue-phase', { need: ['board'] });
    await run.finish();
  });

  test('game, guess phase with a short clue: every seat, before and after a reveal', async ({ table, bot }) => {
    const run = new LayoutRun(table);
    await table.setupRoom({ phones: PHONES });
    await bot.clue(2, 'castle');
    await captureAll(run, table, 'guess-phase', { need: ['board', 'clue'] });
    // One of each kind of card face down, so every cover is on show. The
    // bystander ends the turn; the next team's guess is their own agent.
    await bot.guess('own');
    await captureAll(run, table, 'guess-phase-after-reveal', { need: ['board', 'clue'] });
    await bot.guess('neutral');
    await bot.clue(1, 'river');
    await bot.guess('own');
    await captureAll(run, table, 'guess-phase-three-revealed', { need: ['board'] });
    await run.finish();
  });

  // The same screen with longer and longer clues. 14 letters is the length the
  // plan asks for; 40 is the most the form (maxlength) and the server accept.
  for (const [letters, word] of CLUES) {
    test(`game, guess phase with a ${letters}-letter clue: the score bar and #menu stay on screen`, async ({ table, bot }, testInfo) => {
      expect(word).toHaveLength(letters);
      const run = new LayoutRun(table);
      await table.setupRoom({ phones: PHONES });
      await bot.clue(2, word);
      for (const p of table.phones) await expect(p.page.locator('.status .clue-word'), `${p.name} shows the clue`).toHaveText(word);
      await captureAll(run, table, `clue-${letters}-letters`, { need: ['board', 'clue'] });
      await finishWithKnownBug(run, table, CLUE_BUG, CLUE_BUG_RULES, clueOverflows(testInfo.project.name, letters));
    });
  }

  test('zoom sheet: every kind of card on a spymaster, a guessable card, a watcher, a revealed card', async ({ table, bot }) => {
    const run = new LayoutRun(table);
    await table.setupRoom({ phones: PHONES });
    let at = await bot.look();

    // The spymaster's sheet carries the key outline and tag; one card of each kind.
    for (const kind of ['red', 'blue', 'neutral', 'assassin']) {
      const card = at.hidden[kind][0];
      await at.spymaster.openCard(card);
      await table.check(`with the spymaster's zoom sheet open on a ${kind} card`);
      const { m } = await run.capture(at.spymaster, `zoom/spymaster-${kind}`, { need: ['board', 'zoom'] });
      expect(m.zoom.key, 'the spymaster sheet shows the key of the card').toEqual([kind]);
      await at.spymaster.closeCard();
    }

    await bot.clue(2, 'castle');
    at = await bot.look();
    const active = at.guessers[0];
    const card = at.hidden[at.turn][0];
    await active.openCard(card);
    await table.check('with the active guesser\'s zoom sheet open');
    const guessable = await run.capture(active, 'zoom/guesser-active-can-guess', { need: ['board', 'zoom'] });
    expect(guessable.m.zoom.controls.map((c) => c.text), 'the active guesser gets Guess and Close').toEqual(['Guess this picture', 'Close']);
    await active.closeCard();

    const waiting = at.roles[at.turn === 'red' ? 'blue' : 'red'].guessers[0];
    for (const [p, name] of [[waiting, 'guesser-waiting'], [at.roles.watchers[0], 'watcher']]) {
      await p.openCard(card);
      await table.check(`with ${p.name}'s zoom sheet open`);
      const shot = await run.capture(p, `zoom/${name}`, { need: ['board', 'zoom'] });
      expect(shot.m.zoom.controls.map((c) => c.text), `${p.name} can only close the sheet`).toEqual(['Close']);
      expect(shot.m.zoom.key, `${p.name} must not see a key on the sheet`).toEqual([]);
      await p.closeCard();
    }

    // A revealed card shows its tag to everyone.
    const { index } = await bot.guess('own');
    await active.openCard(index);
    await table.check('with a revealed card open');
    const revealed = await run.capture(active, 'zoom/revealed-card', { need: ['board', 'zoom'] });
    expect(revealed.m.zoom.tag && revealed.m.zoom.tag.text).toMatch(/\(revealed\)$/);
    await active.closeCard();
    await run.finish();
  });

  test('menu sheet: every seat, with two 14-letter clues in the log', async ({ table, bot }) => {
    const run = new LayoutRun(table);
    await table.setupRoom({ phones: PHONES });
    await bot.turn({ number: 2, word: CLUE_14, guesses: ['own', 'neutral'] });
    await bot.turn({ number: 3, word: CLUE_14_B, guesses: ['own', 'own', 'opponent'] });
    await bot.clue(1, 'river');
    for (const p of table.phones) {
      await p.openMenu();
      await table.check(`with ${p.name}'s menu open`);
      const { m } = await run.capture(p, `menu/${await seatLabel(p)}`, { need: ['board', 'sheet'] });
      expect(m.sheet.controls.map((c) => c.text), `${p.name}'s menu offers Invite, Back to lobby and Leave room`).toEqual(expect.arrayContaining(['Invite', 'Back to lobby', 'Leave room']));
      await p.closeMenu();
    }
    await table.check('after closing every menu');
    await run.finish();
  });

  test('game over: every seat, the zoom sheet and the menu', async ({ table, bot }) => {
    const run = new LayoutRun(table);
    await table.setupRoom({ phones: PHONES });
    await bot.turn({ number: 2, guesses: ['own', 'own'], end: true });
    const game = await bot.playToAssassin();
    expect(game.phase).toBe('over');
    await captureAll(run, table, 'game-over', { need: ['board'] });

    const roles = await table.roles();
    const guesser = roles.red.guessers[0];
    const hidden = game.cards.findIndex((c) => !c.revealed);
    await guesser.openCard(hidden);
    await table.check('with the zoom sheet open after game over');
    await run.capture(guesser, 'game-over/zoom-unrevealed-card', { need: ['board', 'zoom'] });
    await guesser.closeCard();

    const watcher = roles.watchers[0];
    await watcher.openMenu();
    await table.check('with the menu open after game over');
    await run.capture(watcher, 'game-over/menu-watcher', { need: ['board', 'sheet'] });
    await watcher.closeMenu();
    await run.finish();
  });

  test('full-screen viewer: a spymaster and a guesser', async ({ table, bot }) => {
    const run = new LayoutRun(table);
    await table.setupRoom({ phones: PHONES });
    const at = await bot.look();
    const guesser = at.roles[at.turn].guessers[0];
    for (const [p, name, how] of [[at.spymaster, 'spymaster', 'contextmenu'], [guesser, 'guesser', 'hold']]) {
      await p.openViewer(at.hidden.red[0], { how });
      await table.check(`with ${p.name}'s viewer open`);
      await run.capture(p, `viewer/${name}`, { need: ['board', 'viewer'] });
      await p.closeViewer();
    }
    await table.check('after closing the viewers');
    await run.finish();
  });

  // The rules above are only worth something if they can fail. This test
  // breaks the layout on purpose, two ways, and requires the matching rule to
  // fire each time: by doctoring a real measurement, and by injecting CSS into
  // the live page (the test's own page; the app's files are not touched) and
  // measuring again in the browser.
  test('self-check: the layout rules notice a broken layout', async ({ table, bot }, testInfo) => {
    await table.setupRoom();
    const at = await bot.look();
    const spy = at.spymaster;
    const guesser = at.guessers[0];
    const expected = testInfo.project.use.viewport;
    const measure = (p) => p.page.evaluate(pageLayout);
    const idsOf = (m) => [...new Set(layoutProblems(m, { expected }).map((t) => t.match(/^\[([^\]]+)\]/)[1]))];

    const clean = await measure(spy);
    const cleanGuesser = await measure(guesser);
    expect(layoutProblems(clean, { expected }), 'the untouched spymaster screen breaks no rule').toEqual([]);
    expect(layoutProblems(cleanGuesser, { expected }), 'the untouched guesser screen breaks no rule').toEqual([]);
    expect(clean.game.controls.length, 'the active spymaster has a clue form to measure').toBeGreaterThan(3);
    const plain = clean.state.cards.findIndex((c) => c.team !== 'assassin');

    const shift = (r, dx, dy) => { r.left += dx; r.right += dx; r.top += dy; r.bottom += dy; };
    const doctored = [
      ['tiles.count', (m) => { m.game.tiles.pop(); }],
      ['tiles.grid', (m) => { shift(m.game.tiles[5].rect, 30, 0); }],
      ['tiles.square', (m) => { m.game.tiles[3].rect.height += 4; m.game.tiles[3].rect.bottom += 4; }],
      ['tiles.size', (m) => { for (const t of m.game.tiles) { t.rect.right = t.rect.left + 30; t.rect.bottom = t.rect.top + 30; t.rect.width = 30; t.rect.height = 30; } }],
      ['tiles.actions', (m) => { m.game.regions.actions = { ...m.game.tiles[23].rect }; }],
      ['tiles.board', (m) => { m.game.regions.board.right = m.game.tiles[3].rect.right - 5; }],
      ['tiles.viewport', (m) => { shift(m.game.tiles[3].rect, expected.width, 0); }],
      ['tiles.tappable', (m) => { m.game.tiles[0].hit = 'div#toast.show'; }],
      ['actions.viewport', (m) => { shift(m.game.controls[0].rect, 0, expected.height); }],
      ['actions.tappable', (m) => { m.game.controls[0].hit = 'offscreen'; }],
      ['menu.viewport', (m) => { shift(m.game.menu.rect, 100, 0); }],
      ['menu.tappable', (m) => { m.game.menu.hit = 'div.score.blue'; }],
      ['page.hscroll', (m) => { m.viewport.scrollWidth += 20; }],
      ['page.vscroll', (m) => { m.viewport.scrollHeight += 20; }],
      ['viewport.size', (m) => { m.viewport.width += 20; }],
      ['images', (m) => { m.images[0].ok = false; }],
      ['key.frame', (m) => { m.game.tiles[plain].after.content = 'none'; }],
      ['key.frame', (m) => { m.game.tiles[plain].after.borderColor = Array(4).fill('rgb(1, 2, 3)'); }],
      ['key.frame', (m) => { m.game.tiles[plain].after.borderWidth = Array(4).fill('0px'); }],
    ];
    for (const [id, mutate] of doctored) {
      const m = structuredClone(clean);
      mutate(m);
      expect(idsOf(m), `a doctored measurement should raise [${id}]`).toContain(id);
    }
    const leaked = structuredClone(cleanGuesser);
    leaked.game.tiles[plain].after = structuredClone(clean.game.tiles[plain].after);
    expect(idsOf(leaked), 'a frame drawn on a guesser\'s tile should raise [key.absent]').toContain('key.absent');

    // Now for real: change the rendering and measure in the browser.
    const withCss = async (phone, css, ids) => {
      const style = await phone.page.addStyleTag({ content: css });
      const got = idsOf(await measure(phone));
      await style.evaluate((el) => el.remove());
      for (const id of ids) expect(got, `with "${css}" injected on ${phone.name} the browser measurement should raise [${id}]`).toContain(id);
    };
    await withCss(spy, '.board.spy .tile::after { display: none !important; }', ['key.frame']);
    await withCss(spy, '.board.spy .tile::after { border-color: lime !important; }', ['key.frame']);
    await withCss(guesser, '.tile::after { content: ""; position: absolute; inset: 0; border: 5px solid red; }', ['key.absent']);
    await withCss(guesser, '.tile { aspect-ratio: 2 / 1 !important; }', ['tiles.square']);
    await withCss(guesser, '.board { width: 130cqw !important; }', ['tiles.board']);
    await withCss(guesser, '.board { grid-template-columns: repeat(6, 1fr) !important; }', ['tiles.grid']);
    await withCss(spy, '.scorebar { min-width: 700px; }', ['menu.viewport']);
    await withCss(spy, '.actions { transform: translateY(90px); }', ['actions.viewport']);
    await guesser.openCard(0);
    // (Polled: the tapped tile stays in its shrunken :active state for a moment.)
    await expect.poll(async () => idsOf(await measure(guesser)), { message: 'the open zoom sheet breaks no rule' }).toEqual([]);
    await withCss(guesser, '.zoom { top: 100% !important; }', ['zoom.viewport']);
    await guesser.closeCard();

    // With the injected styles gone the page measures clean again.
    await expect.poll(async () => layoutProblems(await measure(spy), { expected }), { message: 'the spymaster screen is clean again' }).toEqual([]);
    await expect.poll(async () => layoutProblems(await measure(guesser), { expected }), { message: 'the guesser screen is clean again' }).toEqual([]);
    await table.check('after the self-check');
  });
});
