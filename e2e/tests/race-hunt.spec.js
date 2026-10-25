'use strict';
// Race hunt (opt-in): twelve phones, seven guessers of one team tapping
// "Guess this picture" at the same moment, several times over.
//
//   npm run race-hunt
//   (= E2E_RACE_HUNT=1 E2E_STRICT_RACES=1 playwright test tests/race-hunt.spec.js --project=android-chromium)
//
// The ordinary suite makes one move at a time, so the server never handles two
// requests at once and the race detector has nothing to see. This spec gives
// it something: each burst makes the server handle seven guesses while it is
// sending twelve event streams. It is how the clue-log data race (see
// KNOWN_RACES in lib/server.js and e2e/BUGS.md) shows up through the real UI,
// and how to check that a fix for it holds.
//
// It is left out of the default run (playwright.config.js, testIgnore) because
// what it provokes is a matter of timing, not a fixed outcome:
//   - with E2E_STRICT_RACES=1 the test fails if the server reports any data
//     race while it runs; without it a known race only prints a banner;
//   - after a burst some phones may be left behind by their own late reply
//     (known bug "stale-reply"). That is counted and printed, then cleared by
//     reloading, and does not fail the test.

const { test, expect } = require('../lib/table');
const server = require('../lib/server');

/** How many bursts to make (RACE_HUNT_BURSTS). A new board is dealt when Orange runs low on agents. */
const BURSTS = Number(process.env.RACE_HUNT_BURSTS || 3);

test.describe('Race hunt', () => {
  test('seven guessers of one team tap Guess at the same moment', async ({ table, bot }, testInfo) => {
    test.setTimeout(120_000 + BURSTS * 60_000);
    // Ada and Ben are the spymasters, Cy guesses for Purple, the other nine for Orange.
    const seats = [['red', 'spymaster'], ['blue', 'spymaster'], ['blue', 'guesser'], ...Array(9).fill(['red', 'guesser'])];
    const phones = await table.setupRoom({ phones: 12, seats });
    const logStart = server.logSize();
    const stats = { bursts: 0, guesses: 0, leftBehind: 0 };

    for (let n = 1; n <= BURSTS; n++) {
      let at = await bot.look();
      if (!at.over && at.turn !== 'red') { await bot.passingTurn(); at = await bot.look(); }
      if (at.over || at.hidden.red.length < 4) {
        // Not enough Orange agents left for a burst: deal a new board, same seats.
        await table.step('back to the lobby and deal again', async () => { await phones[2].toLobby(); await table.check('in the lobby'); await phones[0].start(); });
        at = await bot.look();
        if (at.turn !== 'red') { await bot.passingTurn(); at = await bot.look(); }
      }
      await bot.clue(-1);
      // Never the last Orange agent: the game should go on after the burst.
      const cards = at.hidden.red.slice(0, Math.min(7, at.hidden.red.length - 1));
      const guessers = phones.slice(3, 3 + cards.length);
      for (const [i, p] of guessers.entries()) await p.openCard(cards[i]);
      await test.step(`burst ${n}: ${cards.length} guessers tap Guess at once`, async () => {
        await Promise.all(guessers.map((p) => p.tap(p.page.locator('#modal button[data-guess]'))));
        // The server took every guess: a spymaster, who only listens, has them all.
        await expect.poll(async () => (await phones[0].state()).game.cards.filter((c, i) => cards.includes(i) && c.revealed).length, {
          message: 'every simultaneous guess is revealed on a spymaster\'s phone', timeout: 15_000,
        }).toBe(cards.length);
      });
      stats.bursts += 1;
      stats.guesses += cards.length;

      const behind = await table.settle(`after burst ${n}`, { timeout: 3000 }).then(() => [], (e) => [...new Set([...e.message.matchAll(/\] (\w+): room/g)].map((m) => m[1]))]);
      if (behind.length) {
        stats.leftBehind += behind.length;
        console.log(`[race-hunt] burst ${n}: left behind by their own late reply (known bug stale-reply): ${behind.join(', ')}`);
        for (const p of phones.filter((x) => behind.includes(x.name))) await p.reload();
      }
      await table.check(`after burst ${n}, once every phone has the latest state`);
      if ((await bot.look()).phase === 'guess') await bot.endTurn();
    }

    const races = server.scanRaces(server.readLogFrom(logStart));
    const line = `${stats.bursts} burst(s), ${stats.guesses} simultaneous guesses, ${stats.leftBehind} phone(s) left behind by a late reply; ` +
      `DATA RACE reports while this test ran: ${races.reports.length} (${races.known.length} known, ${races.unknown.length} not known or strict)`;
    console.log(`[race-hunt] ${testInfo.project.name}: ${line}`);
    testInfo.annotations.push({ type: 'race hunt', description: line });
    expect(stats.bursts, 'at least one burst was made').toBeGreaterThan(0);
    // Unknown races (every race, under E2E_STRICT_RACES=1) fail this test in the
    // fixture's teardown and fail the run in lib/global-teardown.js.
  });
});
