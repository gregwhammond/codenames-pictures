'use strict';
// Self-test: does the suite notice when a phone is told something wrong?
//
// harness.spec.js doctors snapshots in memory. This file goes one step
// further: it lets the real app run on real phones and tampers with what one
// phone hears from the server (page.route on that phone's own POST reply; the
// app's files and the server are untouched). The app then renders the lie, and
// the cross-phone check has to catch it from the page alone.
//
// A phone's own reply is the easiest thing to tamper with, and the app applies
// it like any other state. The reply is held until the true state has arrived
// by the event stream, so the lie is the last thing the phone hears.

const { test, expect } = require('../lib/table');
const { cast } = require('../lib/edge-helpers');

/**
 * Tamper with `phone`'s next reply to POST <action>.
 *   until(arg)  runs in the page; the reply is held until it returns true
 *   mutate      changes the reply's RoomView in place, or returns
 *               { status, json } to replace the reply altogether
 * Resolves once the tampered reply has been handed to the page.
 */
async function lieOnce(phone, action, { until, arg, mutate }) {
  let delivered;
  let failed;
  const done = new Promise((resolve, reject) => { delivered = resolve; failed = reject; });
  await phone.page.route(new RegExp(`/api/rooms/[^/]+/${action}$`), async (route) => {
    try {
      const response = await route.fetch();
      const view = await response.json();
      if (until) await phone.page.waitForFunction(until, arg, { timeout: 10_000 });
      const replaced = mutate(view);
      if (replaced) await route.fulfill({ status: replaced.status, contentType: 'application/json', body: JSON.stringify(replaced.json) });
      else await route.fulfill({ response, json: view });
      delivered(view);
    } catch (err) {
      failed(err);
    }
  }, { times: 1 });
  return done;
}

/** The phone has finished with its request and rendered whatever it was told. */
async function idle(phone) {
  await expect.poll(async () => (await phone.ui()).busy, { message: `${phone.name} is still waiting for its reply` }).toBe(false);
}

/** In the page: has the true reveal of card `i` arrived by the stream? */
const sawReveal = (i) => !!(ui.room && ui.room.game && ui.room.game.cards[i].revealed); // eslint-disable-line no-undef

test.describe('Self-test: a phone that is told something wrong is caught', () => {
  test('a key leaked to a guesser is caught in the JSON, on the tile, in the zoom sheet and in the viewer', async ({ table, bot }) => {
    await table.setupRoom();
    await bot.clue(3);
    const { at, team, guesser } = await cast(bot);
    const [mine] = at.hidden[team];
    const secret = at.hidden.assassin[0];

    // The server's reply to the guesser's own guess is changed on the way: one
    // unrevealed card now carries its team, as if the server had leaked it.
    const told = lieOnce(guesser, 'guess', { until: sawReveal, arg: mine, mutate: (view) => { view.game.cards[secret].team = 'assassin'; } });
    await guesser.guess(mine, { wait: false });
    await told;
    await idle(guesser);

    const leak = await table.check('with a leaked key on the board').then(() => null, (e) => e);
    expect(leak, 'table.check() must fail when a guesser is sent the team of an unrevealed card').not.toBeNull();
    expect(leak.message).toContain(`[secrecy.json] ${guesser.name}: card ${secret} is unrevealed but its JSON carries team "assassin"`);
    expect(leak.message).toContain(`[secrecy.dom] ${guesser.name}: unrevealed tile ${secret} carries key class k-assassin`);
    expect(leak.message, 'only the phone that was lied to is blamed').not.toMatch(new RegExp(`\\[secrecy\\.[a-z]+\\] (?!${guesser.name}:)`));

    await guesser.openCard(secret);
    await expect(table.check('with the zoom sheet open on the leaked card')).rejects.toThrow(new RegExp(`\\[secrecy\\.zoom\\] ${guesser.name}: zoom sheet for unrevealed card ${secret} shows key \\["assassin"\\]`));
    await guesser.closeCard();
    await guesser.openViewer(secret);
    await expect(table.check('with the viewer open on the leaked card')).rejects.toThrow(new RegExp(`\\[secrecy\\.viewer\\] ${guesser.name}: viewer for unrevealed card ${secret} shows key \\["assassin"\\]`));
    await guesser.closeViewer();

    // With the true state back (a reload asks the server again) the same check passes.
    await guesser.reload();
    await table.check('after the lied-to phone reloads');
  });

  test('a reveal that one phone never hears about is caught as a disagreement', async ({ table, bot }) => {
    await table.setupRoom();
    await bot.clue(3);
    const { at, team, guesser } = await cast(bot);
    const [mine] = at.hidden[team];

    // The reply puts the guessed card back face down, as if the reveal had been lost.
    const told = lieOnce(guesser, 'guess', {
      until: sawReveal,
      arg: mine,
      mutate: (view) => {
        const c = view.game.cards[mine];
        c.revealed = false;
        delete c.team;
        delete c.revealedBy;
      },
    });
    await guesser.guess(mine, { wait: false });
    await told;
    await idle(guesser);

    const err = await table.check('with a dropped reveal', { timeout: 1500 }).then(() => null, (e) => e);
    expect(err, 'table.check() must fail when one phone is missing a reveal').not.toBeNull();
    expect(err.message).toMatch(/Phones did not converge within 1500ms/);
    expect(err.message).toMatch(new RegExp(`\\[agreement\\.revealed\\] .*disagree on revealed: at index ${mine}`));
    expect(err.message).toMatch(/\[agreement\.revealedTeams\]/);

    await guesser.reload();
    await table.check('after the lied-to phone reloads');
  });

  test('wrong counters, a wrong turn and a stranger in the player list are caught', async ({ table, bot }) => {
    await table.setupRoom();
    await bot.clue(3);
    const { at, team, guesser } = await cast(bot);
    const own = at.hidden[team];

    const lies = [
      ['one guess too many left', (view) => { view.game.guessesLeft += 1; }, /\[agreement\.guessesLeft\]/],
      ['the turn passed to the other team', (view) => { view.game.turn = view.game.turn === 'red' ? 'blue' : 'red'; }, /\[agreement\.turn\]/],
      ['a player nobody else has', (view) => { view.players.push({ id: 'feedfacefeedface', name: 'Mallory', connected: true }); }, /\[agreement\.players\]/],
    ];
    for (const [i, [name, mutate, id]] of lies.entries()) {
      const told = lieOnce(guesser, 'guess', { until: sawReveal, arg: own[i], mutate });
      await guesser.guess(own[i], { wait: false });
      await told;
      await idle(guesser);
      const err = await table.check(`after the lie "${name}"`, { timeout: 1500 }).then(() => null, (e) => e);
      expect(err, `table.check() must fail after the lie "${name}"`).not.toBeNull();
      expect(err.message, `the lie "${name}"`).toMatch(id);
      expect(err.message, 'the phone that was lied to is the one named').toContain(`${guesser.name} and `);
      if (i < lies.length - 1) {
        await guesser.reload();
        await table.check(`after the lied-to phone reloads (${name})`);
      }
    }
    // Three guesses on a clue of 3 leave one; the reload puts the truth back.
    await guesser.reload();
    const { game } = await table.check('after the last reload');
    expect(game).toMatchObject({ turn: team, phase: 'guess', guessesLeft: 1, guessesMade: 3 });
  });

  test('a server error on one phone fails the check and the test, unless it is declared', async ({ table, bot }) => {
    await table.setupRoom();
    await bot.clue(2);
    const { at, team, guesser } = await cast(bot);
    const [mine] = at.hidden[team];

    const told = lieOnce(guesser, 'guess', { until: sawReveal, arg: mine, mutate: () => ({ status: 500, json: { error: 'tampered: internal error' } }) });
    const toasts = (await guesser.toasts()).length;
    await guesser.guess(mine, { wait: false });
    await told;
    await guesser.expectToast('tampered: internal error', { since: toasts });

    await expect(table.check('after a 500 that nobody declared')).rejects.toThrow(new RegExp(`\\[hygiene\\.errors\\] ${guesser.name}: http: POST .*/guess -> 500`));
    // Left undeclared, the same record would fail this test at teardown.
    expect(table.unexpectedErrors().map((e) => `${e.phone}/${e.kind}/${e.status}`)).toEqual([`${guesser.name}/http/500`]);
    table.expectError({ kind: 'http', phone: guesser, status: 500, url: /\/guess$/ }, 'the tampered 500');
    await table.check('once the 500 is declared');
  });

  test('a tap that the server never answers is reported as having no effect', async ({ table, bot }) => {
    await table.setupRoom();
    await bot.clue(2);
    const { at, team, guesser } = await cast(bot);
    const [mine] = at.hidden[team];

    // The guess never leaves the phone and the app is told nothing: it shows no
    // toast either, because the request simply never finishes.
    const never = await guesser.holdPost('guess', { phase: 'request' });
    table.effectTimeout = 1500;
    await expect(guesser.guess(mine)).rejects.toThrow(new RegExp(`${guesser.name}: guess\\(${mine}\\) had no effect: no state change and no toast within 1500ms`));
    await expect(table.settle('while the guess is stuck', { timeout: 500 })).rejects.toThrow(new RegExp(`\\[settle\\.busy\\] ${guesser.name}`));
    table.effectTimeout = 10_000;
    never.release();
    await never.remove();
    const { game } = await table.check('after the stuck guess is let through');
    expect(game.cards[mine].revealed).toBe(true);
  });
});
