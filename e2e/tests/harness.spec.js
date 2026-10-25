'use strict';
// Checks on the harness itself: that the invariants really fire, that page
// problems are caught, that requests can be held, and that tables of other
// shapes (spectators, extra guessers, two phones) work.

const { test, expect } = require('../lib/table');
const inv = require('../lib/invariants');

const clone = (v) => JSON.parse(JSON.stringify(v));

test.describe('Harness self-checks', () => {
  test('every invariant family fires on a doctored snapshot and is quiet on the real one', async ({ table, bot }) => {
    await table.setupRoom();
    await bot.clue(3);
    await bot.guess('own');
    const { roles, hidden, game } = await bot.look();
    const guesser = roles[game.turn].guessers[0];
    const idleSpy = roles[inv.other(game.turn)].spymaster;
    await guesser.openCard(hidden.neutral[0]);
    const real = await table.settle();
    const G = real.findIndex((s) => s.name === guesser.name);
    const S = real.findIndex((s) => s.name === idleSpy.name);
    const h = hidden.neutral[0];
    const revealedIdx = game.cards.findIndex((c) => c.revealed);

    expect(inv.settleProblems(real), 'the real table is settled').toEqual([]);
    expect(inv.violations(real, { history: new Map() }), 'the real table violates nothing').toEqual([]);

    /** [name, mutate(snaps), expected id, expected phone index or null for a room-level finding] */
    const cases = [
      ['guesser JSON carries a team', (s) => { s[G].ui.room.game.cards[h].team = 'neutral'; }, 'secrecy.json', G],
      ['guesser tile carries a key class', (s) => { s[G].dom.game.tiles[h].key = ['neutral']; }, 'secrecy.dom', G],
      ['guesser board is a spymaster board', (s) => { s[G].dom.game.boardClasses.push('spy'); }, 'secrecy.dom', G],
      ['guesser aria-label names the team', (s) => { s[G].dom.game.tiles[h].label += ', assassin'; }, 'secrecy.dom', G],
      ['zoom sheet shows the key to a guesser', (s) => { s[G].dom.zoom.key = ['neutral']; s[G].dom.zoom.tag = 'Bystander'; }, 'secrecy.zoom', G],
      ['viewer shows the key to a guesser', (s) => { s[G].dom.viewer = { classes: ['viewer', 'k-red'], key: ['red'], tag: 'Orange agent', tagHidden: false, img: s[G].ui.room.game.cards[h].image }; }, 'secrecy.viewer', G],
      ['spymaster is missing part of the key', (s) => { delete s[S].ui.room.game.cards[h].team; }, 'key.complete', S],
      ['key has the wrong mix', (s) => { s[S].ui.room.game.cards[h].team = 'assassin'; }, 'counts.key', S],
      ['a tile is missing', (s) => { s[G].dom.game.tiles.pop(); }, 'counts.tiles', G],
      ['a card is missing from JSON', (s) => { s[G].ui.room.game.cards.pop(); }, 'counts.cards', G],
      ['scorebar disagrees with remaining', (s) => { s[G].dom.game.score.red += 1; }, 'counts.scorebar', G],
      ['remaining disagrees with the board', (s) => { for (const x of s) x.ui.room.game.remaining.blue -= 1; }, 'counts.remaining', G],
      ['clue form on a phone that may not clue', (s) => { s[G].dom.game.clueForm = { word: '', on: [1], nums: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, -1] }; }, 'controls.clueForm', G],
      ['guess panel on a spymaster', (s) => { s[S].dom.game.guessPanel = 'Tap a picture to guess. 3 guesses left'; }, 'controls.guessPanel', S],
      ['End turn disabled after a guess', (s) => { s[G].dom.game.endTurn.disabled = true; }, 'controls.endTurn', G],
      ['zoom sheet lost its Guess button', (s) => { s[G].dom.zoom.guess = null; }, 'controls.zoomGuess', G],
      ['tile shows another picture', (s) => { s[G].dom.game.tiles[h].img = '/cards/other.jpg'; }, 'dom.tiles', G],
      ['active score is the wrong team', (s) => { s[G].dom.game.active = inv.other(game.turn); }, 'dom.turn', G],
      ['status shows another clue', (s) => { s[G].dom.game.clueWord = 'wrong'; }, 'dom.status', G],
      ['a stranger is in the room', (s) => { for (const x of s) x.ui.room.players.push({ id: 'ghost', name: 'Ghost', connected: false }); }, 'roster.ghosts', null],
      ['two spymasters on a team', (s) => { for (const x of s) x.ui.room.players.find((p) => p.role === 'guesser' && p.team === game.turn).role = 'spymaster'; }, 'roster.spymasters', G],
      ['the log does not match the board', (s) => { for (const x of s) x.ui.room.game.log[0].guesses.push('neutral'); }, 'logic.log', G],
      ['guess counters do not add up', (s) => { for (const x of s) x.ui.room.game.guessesLeft = 1; }, 'logic.phase', G],
      ['an undeclared page error', () => {}, 'hygiene.errors', null, { unexpectedErrors: [{ phone: 'Ada', kind: 'pageerror', text: 'boom' }] }],
    ];
    for (const [name, mutate, id, who, ctx] of cases) {
      const snaps = clone(real);
      mutate(snaps);
      const found = inv.violations(snaps, { history: new Map(), ...(ctx || {}) });
      const hit = found.filter((v) => v.id === id && (who == null || v.phone === real[who].name));
      expect(hit.length, `doctored case "${name}" should raise ${id}${who == null ? '' : ` on ${real[who].name}`}; got ${JSON.stringify(found.map((v) => `${v.id}@${v.phone}`))}`).toBeGreaterThan(0);
      expect(hit[0].message.length).toBeGreaterThan(10);
      // Skipping by id and by prefix silences it.
      expect(inv.violations(snaps, { history: new Map(), ...(ctx || {}), skip: [id] }).filter((v) => v.id === id)).toEqual([]);
      expect(inv.violations(snaps, { history: new Map(), ...(ctx || {}), skip: [id.split('.')[0]] }).filter((v) => v.id === id)).toEqual([]);
    }

    // Monotonic checks need a history.
    const history = new Map();
    expect(inv.violations(real, { history })).toEqual([]);
    const back = clone(real);
    for (const x of back) { x.ui.room.game.cards[revealedIdx].revealed = false; x.ui.room.game.log[0].guesses = []; }
    const ids = inv.violations(back, { history }).map((v) => v.id);
    expect(ids).toContain('monotonic.revealed');
    expect(ids).toContain('monotonic.log');

    // Things that must settle rather than be asserted once.
    const settleCases = [
      ['one phone is behind on the turn', (s) => { s[G].ui.room.game.turn = inv.other(game.turn); }, 'agreement.turn'],
      ['one phone has an older board', (s) => { s[G].ui.room.game.cards[revealedIdx].revealed = false; }, 'agreement.revealed'],
      ['one phone sees another key', (s) => { const c = s[S].ui.room.game.cards; [c[0].team, c[1].team] = ['assassin', 'assassin']; }, 'agreement.key'],
      ['a phone is offline', (s) => { s[G].offline = true; }, 'hygiene.offline'],
      ['a request is in flight', (s) => { s[G].ui.busy = true; }, 'settle.busy'],
      ['a phone is shown as away', (s) => { for (const x of s) x.ui.room.players[0].connected = false; }, 'roster.connected'],
      ['a phone has not rendered', (s) => { s[G].booted = false; }, 'settle.booted'],
    ];
    for (const [name, mutate, id] of settleCases) {
      const snaps = clone(real);
      mutate(snaps);
      expect(inv.settleProblems(snaps).map((v) => v.id), `doctored case "${name}" should raise ${id}`).toContain(id);
    }

    // Every id used above is documented.
    for (const id of [...cases.map((c) => c[2]), ...settleCases.map((c) => c[2]), 'monotonic.revealed', 'monotonic.log']) {
      expect(Object.keys(inv.INVARIANTS).some((k) => k === id || (k.endsWith('.*') && id.startsWith(k.slice(0, -1)))), `${id} is listed in INVARIANTS`).toBe(true);
    }
    await guesser.closeCard();
    await table.check('at the end');
  });

  test('page problems are recorded per phone and must be declared', async ({ table }) => {
    const [ada, ben] = await table.setupRoom({ phones: 2, seats: [], start: false });
    expect(table.errors).toEqual([]);

    await ada.page.evaluate(() => fetch('/api/rooms/ZZZZ/sit', { method: 'POST', body: '{}' }).then((r) => r.text()));
    await ben.page.evaluate(() => { console.error('harness self-check console error'); });
    await ben.page.evaluate(() => { setTimeout(() => { throw new Error('harness self-check page error'); }, 0); });
    await ada.page.evaluate(() => fetch('/api/rooms/null/events?token=x').then((r) => r.text()));
    await expect.poll(() => table.errors.map((e) => `${e.phone}/${e.kind}`).sort()).toEqual(['Ada/http', 'Ada/http', 'Ada/null-room', 'Ben/console', 'Ben/pageerror']);

    expect(table.unexpectedErrors()).toHaveLength(5);
    await expect(table.check('with undeclared problems')).rejects.toThrow(/\[hygiene\.errors\] Ada: http: POST .*\/api\/rooms\/ZZZZ\/sit -> 404/);

    table.expectError({ kind: 'http', phone: ada, status: 404, url: /ZZZZ\/sit$/ });
    table.expectError({ kind: 'http', phone: 'Ada', status: 404, url: '/api/rooms/null/' });
    table.expectError({ kind: 'null-room' });
    table.expectError(/console: harness self-check console error/);
    table.expectError((e) => e.kind === 'pageerror' && e.phone === 'Ben' && /self-check page error/.test(e.text));
    table.allowError(/never happens/);
    expect(table.unexpectedErrors()).toEqual([]);
    await table.check('once every problem is declared');
  });

  test('POSTs can be held, delayed and aborted; refused and ineffective taps are reported clearly', async ({ table }) => {
    const [ada, ben] = await table.setupRoom({ phones: 2, seats: [], start: false });

    // Hold the reply: the server has seated Ada, her own phone does not know yet.
    const hold = await ada.holdPost('sit');
    await ada.sit('red', 'spymaster', { wait: false });
    await hold.waitForHeld(1);
    expect(hold.requests[0].body).toMatchObject({ team: 'red', role: 'spymaster' });
    await expect.poll(async () => (await ben.state()).players[0].role, { message: 'Ben hears about the seat from the stream' }).toBe('spymaster');
    expect((await ada.ui()).busy, "Ada's request is still in flight").toBe(true);
    await expect(table.settle('while a reply is held', { timeout: 500 })).rejects.toThrow(/\[settle\.busy\] Ada/);
    hold.release();
    await table.check('after releasing the held reply');
    expect((await ada.me()).role).toBe('spymaster');
    await hold.remove();

    // Hold the request itself: nothing reaches the server until release.
    const before = await ben.holdPost('sit', { phase: 'request' });
    await ben.sit('blue', 'guesser', { wait: false });
    await before.waitForHeld(1);
    expect((await ada.state()).players[1].team, 'the server has not seen the request').toBeUndefined();
    before.release();
    await table.check('after releasing the held request');
    expect((await ben.me()).team).toBe('blue');
    await before.remove();

    // A delayed reply arrives by itself.
    const delayed = await ben.delayPost('sit', 300, { times: 1 });
    await ben.sit('red', 'guesser');
    expect(delayed.held).toBe(1);
    await table.check('after a delayed reply');

    // An aborted request never reaches the server; the app shows a toast.
    table.expectError({ kind: 'requestfailed', phone: ben, url: /\/sit$/ });
    await ben.abortPost('sit', { times: 1 });
    const toasts = (await ben.toasts()).length;
    await ben.sit('blue', 'guesser', { wait: false });
    await ben.expectToast(/.+/, { since: toasts });
    await table.check('after an aborted request');
    expect((await ben.me()).team, 'the aborted sit changed nothing').toBe('red');

    // Preconditions and refusals come back as readable errors.
    table.preconditionTimeout = 1_000;
    await expect(ben.start()).rejects.toThrow(/Ben: start\(\): Deal button is disabled/);
    await expect(ben.sit('red', 'spymaster')).rejects.toThrow(/Ben: sit\(red, spymaster\): the seat is taken/);
    await expect(ben.guess(0)).rejects.toThrow(/Ben: openCard\(0\): no such tile/);
    // Dialogs are answered and recorded.
    ben.dialogPolicy = 'dismiss';
    await ben.leave({ wait: false });
    await expect.poll(() => ben.dialogs.length).toBe(1);
    table.preconditionTimeout = null;
    expect(ben.dialogs[0]).toMatchObject({ type: 'confirm', message: 'Leave this room?', accepted: false });
    await table.check('after dismissing the leave dialog');
    expect(await ben.screen()).toBe('lobby');
  });

  test('six phones: two guessers on a team and a spectator, through a random game and a reload', async ({ table, bot }) => {
    const phones = await table.setupRoom({
      phones: 6,
      seats: [['red', 'spymaster'], ['red', 'guesser'], ['blue', 'spymaster'], ['blue', 'guesser'], ['red', 'guesser'], null],
    });
    const watcher = phones[5];
    const roles = await table.roles();
    expect(roles.red.guessers).toHaveLength(2);
    expect(roles.watchers).toEqual([watcher]);
    await expect(watcher.page.locator('p.wait')).toHaveText('You’re watching. Open the menu to join a team.');
    await expect(watcher.key()).rejects.toThrow(/cannot see the key/);
    await table.probeSecrecy({ phones: [watcher], cards: 1 });

    // A refused tap is reported with the toast text.
    const spy = (await bot.look()).spymaster;
    await expect(spy.giveClue('two words', 1)).rejects.toThrow(/was refused with the toast "Clues are a single word\."/);
    await table.check('after the refused clue');

    // The menu on a watcher lists everyone and offers both teams.
    await watcher.openMenu();
    await table.check("with the watcher's menu open");
    await watcher.closeMenu();

    let moves = 0;
    const game = await bot.playRandomGame({
      onMove: async () => {
        moves += 1;
        if (moves === 3) await table.step('the watcher reloads', () => watcher.reload());
        if (moves === 5) await table.step('a guesser reloads', () => phones[4].reload());
      },
    });
    expect(game.phase).toBe('over');
    expect(bot.moves.length).toBeGreaterThan(1);
    await expect(watcher.page.locator('#again')).toBeVisible();
    expect(table.checks).toBeGreaterThan(10);
  });
});
