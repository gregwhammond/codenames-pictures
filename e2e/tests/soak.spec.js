'use strict';
// Soak: many random games back to back in one room.
//
//   SOAK_GAMES=n     how many games to play (default 10)
//   SOAK_SEED=n      seed for every random choice the harness makes; when unset
//                    one is generated (or E2E_SEED is used). It is ALWAYS
//                    printed, with the command that replays it.
//   SOAK_PHONES=n    phones at the table (default 4; the 5th and 6th join as
//                    extra guessers, any more only watch)
//   SOAK_RELOAD=p    chance, after each move, that a random phone reloads
//                    (default 0.06)
//
// Every move is a tap on the phone whose move it is (lib/bot.js picks random
// legal moves), and every move is followed by the full cross-phone invariant
// check and a comparison with the rules model. Now and then a random phone
// reloads, peeks at a card in the zoom sheet, or opens the menu. Between games
// the table alternates between "Play again" (same seats) and "Switch teams"
// (back to the lobby, everyone reseated at random, deal).
//
// What a seed replays: the harness's choices (who taps, what kind of card,
// clue numbers, reloads, reseating). The server deals each board with its own
// randomness, so the pictures and the key differ from run to run.

const { test, expect } = require('../lib/table');
const { makeRng } = require('../lib/rng');
const { other, TEAM_NAME } = require('../lib/invariants');

const GAMES = Number(process.env.SOAK_GAMES || 10);
const PHONES = Number(process.env.SOAK_PHONES || 4);
const RELOAD = Number(process.env.SOAK_RELOAD ?? 0.06);
/** Chance, after each move, of a zoom-sheet peek and of a menu visit. */
const PEEK = 0.04;
const MENU = 0.03;

const seatText = (seat) => (seat ? `${TEAM_NAME[seat[0]]} ${seat[1]}` : 'watcher');

async function seatOf(phone) {
  const me = await phone.me();
  return me && me.team ? [me.team, me.role] : null;
}

/**
 * In the lobby: give every phone a new random seat, by tapping. Two phones
 * become the spymasters, each team gets at least one guesser, any phones
 * beyond four guess or watch. Returns Map(phone -> [team, role] | null).
 */
async function reseat(table, rng, note) {
  const phones = table.phones;
  const order = rng.shuffle(phones);
  const target = new Map();
  const fixed = [['red', 'spymaster'], ['blue', 'spymaster'], ['red', 'guesser'], ['blue', 'guesser']];
  order.forEach((p, i) => target.set(p, i < 4 ? fixed[i] : rng.pick([['red', 'guesser'], ['blue', 'guesser'], null])));
  note(`new seats: ${phones.map((p) => `${p.name} -> ${seatText(target.get(p))}`).join(', ')}`);

  const move = async (p, seat) => {
    const cur = await seatOf(p);
    if (String(cur) === String(seat)) return;
    await table.step(`${p.name} ${seat ? `sits as ${seatText(seat)}` : 'leaves their seat'}`, () => (seat ? p.sit(seat[0], seat[1]) : p.stand()));
  };
  // A spymaster seat holds one person, so: first everyone who is not going to
  // be a spymaster moves (that empties the seats of outgoing spymasters) …
  for (const p of order) if (!target.get(p) || target.get(p)[1] !== 'spymaster') await move(p, target.get(p));
  // … then a spymaster who is changing teams steps down to a guesser seat …
  for (const p of order) {
    const t = target.get(p);
    const cur = await seatOf(p);
    if (t && t[1] === 'spymaster' && cur && cur[1] === 'spymaster' && cur[0] !== t[0]) await move(p, [t[0], 'guesser']);
  }
  // … and then both spymaster seats are free for their new owners.
  for (const p of order) if (target.get(p) && target.get(p)[1] === 'spymaster') await move(p, target.get(p));

  for (const p of phones) expect(await seatOf(p), `${p.name} should now be ${seatText(target.get(p))}`).toEqual(target.get(p));
  return target;
}

test.describe('Soak', () => {
  test(`${GAMES} random games back to back in one room`, async ({ table, bot }, testInfo) => {
    expect(Number.isInteger(GAMES) && GAMES >= 1, `SOAK_GAMES must be a whole number of games, got "${process.env.SOAK_GAMES}"`).toBe(true);
    expect(Number.isInteger(PHONES) && PHONES >= 4 && PHONES <= 12, `SOAK_PHONES must be between 4 and 12, got "${process.env.SOAK_PHONES}"`).toBe(true);
    test.setTimeout(120_000 + GAMES * 90_000);

    // One seed drives everything random the harness does.
    const seed = process.env.SOAK_SEED ? Number(process.env.SOAK_SEED) : table.seed;
    expect(Number.isFinite(seed), `SOAK_SEED must be a number, got "${process.env.SOAK_SEED}"`).toBe(true);
    table.seed = seed;
    table.rng = makeRng(seed);
    bot.rng = table.rng;
    const rng = table.rng;
    const project = testInfo.project.name;
    const replay = `SOAK_SEED=${seed} SOAK_GAMES=${GAMES}${PHONES !== 4 ? ` SOAK_PHONES=${PHONES}` : ''} npx playwright test tests/soak.spec.js --project=${project}`;
    console.log(`[soak] ${project}: seed ${seed}, ${GAMES} game(s), ${PHONES} phones. Replay: ${replay}`);
    testInfo.annotations.push({ type: 'soak seed', description: `${seed} (replay: ${replay})` });

    const note = (text) => {
      bot.moves.push(text);
      if (process.env.E2E_BOT_LOG === '1') console.log(`[soak ${seed}] ${text}`);
    };
    const stats = { games: [], reloads: 0, peeks: 0, menus: 0, playAgain: 0, switchTeams: 0 };
    const started = Date.now();

    const seats = [['red', 'spymaster'], ['red', 'guesser'], ['blue', 'spymaster'], ['blue', 'guesser'], ['red', 'guesser'], ['blue', 'guesser']];
    await table.setupRoom({ phones: PHONES, seats });
    const setupMs = Date.now() - started;

    // Which of the two ways to start the next game comes first is random; after that they alternate.
    const first = rng.int(2);

    for (let n = 1; n <= GAMES; n++) {
      const t0 = Date.now();
      let moves = 0;
      await test.step(`game ${n} of ${GAMES}`, async () => {
        note(`--- game ${n} of ${GAMES} ---`);
        const game = await bot.playRandomGame({
          onMove: async (_bot, count) => {
            moves = count;
            const where = `(game ${n}, after move ${count}, seed ${seed})`;
            const roll = rng();
            if (roll < RELOAD) {
              const p = rng.pick(table.phones);
              note(`${p.name} reloads the page`);
              await p.reload();
              await table.check(`after ${p.name} reloads ${where}`);
              stats.reloads += 1;
            } else if (roll < RELOAD + PEEK) {
              const p = rng.pick(table.phones);
              const card = rng.int(24);
              note(`${p.name} looks at card ${card} in the zoom sheet`);
              await p.openCard(card);
              await table.check(`with ${p.name}'s zoom sheet open on card ${card} ${where}`);
              await p.closeCard();
              await table.check(`after ${p.name} closes the zoom sheet ${where}`);
              stats.peeks += 1;
            } else if (roll < RELOAD + PEEK + MENU) {
              const p = rng.pick(table.phones);
              note(`${p.name} opens and closes the menu`);
              await p.openMenu();
              await table.check(`with ${p.name}'s menu open ${where}`);
              await p.closeMenu();
              await table.check(`after ${p.name} closes the menu ${where}`);
              stats.menus += 1;
            }
          },
        });
        expect(game.phase, `game ${n} should have ended`).toBe('over');
        expect(['red', 'blue']).toContain(game.winner);
        expect(['agents', 'assassin']).toContain(game.winReason);
        stats.games.push({ n, moves, winner: game.winner, reason: game.winReason, clues: game.log.length, revealed: game.cards.filter((c) => c.revealed).length, ms: Date.now() - t0 });
        console.log(`[soak] ${project} seed ${seed}: game ${n}/${GAMES}: ${moves} moves, ${game.log.length} clues, ${TEAM_NAME[game.winner]} wins (${game.winReason}), ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      });
      if (n === GAMES) break;

      // On to the next game.
      const before = await table.check(`after game ${n} (seed ${seed})`);
      const oldImages = before.game.cards.map((c) => c.image);
      const by = rng.pick(table.phones);
      if ((n + first) % 2 === 0) {
        const oldSeats = before.room.players.map((p) => [p.id, p.team, p.role]);
        note(`${by.name} taps Play again`);
        await table.step(`${by.name} taps Play again`, () => by.playAgain());
        const { room } = await table.check(`after Play again (seed ${seed})`);
        expect(room.players.map((p) => [p.id, p.team, p.role]), 'Play again keeps every seat').toEqual(oldSeats);
        stats.playAgain += 1;
      } else {
        note(`${by.name} taps Switch teams`);
        await table.step(`${by.name} taps Switch teams`, () => by.toLobby());
        const lobby = await table.check(`in the lobby after Switch teams (seed ${seed})`);
        expect(lobby.game, 'Switch teams ends the game').toBeNull();
        await reseat(table, rng, note);
        const dealer = rng.pick(table.phones);
        note(`${dealer.name} deals`);
        await table.step(`${dealer.name} deals`, () => dealer.start());
        stats.switchTeams += 1;
      }
      const { game: next } = await table.check(`after the deal for game ${n + 1} (seed ${seed})`);
      expect(next).toMatchObject({ phase: 'clue', turn: next.startingTeam, log: [] });
      expect(next.cards.filter((c) => c.revealed), 'a new board starts face up').toHaveLength(0);
      expect(next.cards.map((c) => c.image), 'a new board has new pictures').not.toEqual(oldImages);
      expect(next.remaining).toEqual({ [next.startingTeam]: 9, [other(next.startingTeam)]: 8 });
    }

    const totalMs = Date.now() - started;
    const moves = stats.games.reduce((a, g) => a + g.moves, 0);
    const playMs = stats.games.reduce((a, g) => a + g.ms, 0);
    const summary = {
      project, seed, games: GAMES, phones: PHONES, totalSeconds: +(totalMs / 1000).toFixed(1), setupSeconds: +(setupMs / 1000).toFixed(1),
      playSeconds: +(playMs / 1000).toFixed(1), moves, checks: table.checks, reloads: stats.reloads, zoomPeeks: stats.peeks, menuVisits: stats.menus,
      playAgain: stats.playAgain, switchTeams: stats.switchTeams,
      wins: { red: stats.games.filter((g) => g.winner === 'red').length, blue: stats.games.filter((g) => g.winner === 'blue').length },
      endings: { agents: stats.games.filter((g) => g.reason === 'agents').length, assassin: stats.games.filter((g) => g.reason === 'assassin').length },
      perGame: stats.games,
    };
    await testInfo.attach('soak-summary.json', { body: JSON.stringify(summary, null, 2), contentType: 'application/json' });
    console.log(`[soak] ${project} seed ${seed}: ${GAMES} game(s) in ${summary.totalSeconds}s (setup ${summary.setupSeconds}s, play ${summary.playSeconds}s): ` +
      `${moves} moves, ${table.checks} invariant checks, ${stats.reloads} reloads, ${stats.peeks} zoom peeks, ${stats.menus} menu visits, ` +
      `${stats.playAgain} Play again, ${stats.switchTeams} Switch teams; endings: ${summary.endings.agents} by agents, ${summary.endings.assassin} by assassin`);

    expect(stats.games).toHaveLength(GAMES);
    // Every move is followed by at least one check.
    expect(table.checks).toBeGreaterThan(moves);
    if (GAMES >= 3) {
      expect(stats.playAgain, 'Play again was used between games').toBeGreaterThan(0);
      expect(stats.switchTeams, 'Switch teams was used between games').toBeGreaterThan(0);
    }
  });
});
