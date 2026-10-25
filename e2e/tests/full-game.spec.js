'use strict';
// Full games on four phones, from the home screen to game over to a rematch.
// Every action is a tap on a real page, and the cross-phone invariants
// (lib/invariants.js) are asserted after each one.

const { test, expect } = require('../lib/table');
const { other, TEAM_NAME } = require('../lib/invariants');

/** Game over on every phone, then "Play again" on one of them: same seats, fresh board. */
async function rematch(table, by) {
  const before = await table.check('before the rematch');
  expect(before.game.phase, 'the game should be over before a rematch').toBe('over');
  const seats = before.room.players.map((p) => ({ id: p.id, name: p.name, team: p.team, role: p.role }));
  const oldImages = before.game.cards.map((c) => c.image);

  const phone = by || table.rng.pick(table.phones);
  await table.step(`${phone.name} taps Play again`, () => phone.playAgain());

  const { room, game } = await table.check('after the rematch deal');
  expect(room.players.map((p) => ({ id: p.id, name: p.name, team: p.team, role: p.role })), 'Play again must keep every seat').toEqual(seats);
  expect(game.phase).toBe('clue');
  expect(game.turn).toBe(game.startingTeam);
  expect(game.cards.filter((c) => c.revealed), 'a new board starts with nothing revealed').toHaveLength(0);
  expect(game.cards.map((c) => c.image), 'a new board has new pictures').not.toEqual(oldImages);
  expect(game.log).toEqual([]);
  expect(game.remaining[game.startingTeam]).toBe(9);
  expect(game.remaining[other(game.startingTeam)]).toBe(8);
  // The key of the new board must not reach the guessers, including through
  // the zoom sheet and the full-screen viewer.
  await table.probeSecrecy({ cards: 1 });
  return game;
}

test.describe('Full games', () => {
  test('1. create a room, join by invite link and by typed code, sit, deal', async ({ table, bot }) => {
    const [ada, ben, cy, dee] = await table.open(4);

    const code = await table.step('Ada creates a room', () => ada.createRoom());
    expect(code).toMatch(/^[A-HJ-NP-Z]{4}$/);
    await expect(ada.page).toHaveURL(new RegExp(`/r/${code}$`));
    await expect(ada.page.locator('.room-code')).toHaveText(code);
    await expect(ada.page.locator('#start')).toBeDisabled();

    // Ben follows the invite link: the home screen offers only "Join game CODE".
    await ben.goto(`/r/${code}`);
    const benHome = (await ben.snapshot()).dom.home;
    expect(benHome.hasCodeInput, 'an invite link needs no code field').toBe(false);
    expect(benHome.hasCreate, 'an invite link offers no "Create a new game"').toBe(false);
    expect(benHome.joinLabel).toBe(`Join game ${code}`);
    await table.step('Ben joins by invite link', () => ben.joinByLink(code));

    // Cy types the code, in lower case as people do.
    await table.step('Cy joins by typing the code', () => cy.joinByCode(code.toLowerCase()));
    await expect(cy.page).toHaveURL(new RegExp(`/r/${code}$`));

    await table.step('Dee joins by invite link', () => dee.joinByLink(code));

    let { room } = await table.check('with four phones in the lobby');
    expect(room.players.map((p) => p.name)).toEqual(['Ada', 'Ben', 'Cy', 'Dee']);
    expect(room.players.every((p) => !p.team && !p.role), 'nobody is seated yet').toBe(true);
    expect(room.ready).toBe(false);

    await table.step('Ada sits as Orange spymaster', () => ada.sit('red', 'spymaster'));
    // A taken spymaster seat is disabled for everyone else.
    await expect(ben.page.locator('button.seat[data-sit="red:spymaster"]')).toBeDisabled();
    await expect(ada.page.locator('button.seat[data-sit="red:spymaster"]')).toHaveClass(/mine/);
    await table.step('Ben sits as Orange guesser', () => ben.sit('red', 'guesser'));
    await table.step('Cy sits as Purple spymaster', () => cy.sit('blue', 'spymaster'));
    for (const p of table.phones) await expect(p.page.locator('#start'), `${p.name}: Deal stays disabled until both teams are complete`).toBeDisabled();
    await table.step('Dee sits as Purple guesser', () => dee.sit('blue', 'guesser'));
    for (const p of table.phones) await expect(p.page.locator('#start'), `${p.name}: Deal is enabled once seats are ready`).toBeEnabled();

    // Anyone can deal; a guesser does.
    await table.step('Dee deals the pictures', () => dee.start());
    let game;
    ({ room, game } = await table.check('after the deal'));
    expect(game.phase).toBe('clue');
    expect(game.turn).toBe(game.startingTeam);
    expect(game.cards).toHaveLength(24);
    expect(game.remaining[game.startingTeam]).toBe(9);
    expect(game.remaining[other(game.startingTeam)]).toBe(8);

    const roles = await table.roles();
    expect(roles.red.spymaster).toBe(ada);
    expect(roles.red.guessers).toEqual([ben]);
    expect(roles.blue.spymaster).toBe(cy);
    expect(roles.blue.guessers).toEqual([dee]);
    expect(await ada.key()).toEqual(await cy.key());
    await expect(ben.key(), 'a guesser cannot read the key').rejects.toThrow(/cannot see the key/);
    await expect(dee.key(), 'a guesser cannot read the key').rejects.toThrow(/cannot see the key/);
    await table.probeSecrecy();

    // Carry the game to its end and deal again.
    await bot.playToAssassin({ warmup: 1 });
    await rematch(table);
  });

  test('2. win by finding all agents, with a limited clue, clue 0 and clue ∞', async ({ table, bot }) => {
    const phones = await table.setupRoom();
    let { game } = await table.check('after the deal');
    const S = game.startingTeam; // 9 agents
    const O = other(S);          // 8 agents

    // Clue 2 allows three guesses; the third one uses the turn up.
    game = await bot.clue(2);
    expect(game.guessesLeft).toBe(3);
    ({ game } = await bot.guess('own'));
    expect(game).toMatchObject({ turn: S, phase: 'guess', guessesLeft: 2, guessesMade: 1 });
    ({ game } = await bot.guess('own'));
    expect(game).toMatchObject({ turn: S, phase: 'guess', guessesLeft: 1, guessesMade: 2 });
    ({ game } = await bot.guess('own'));
    expect(game, 'the third guess on a clue of 2 passes the turn').toMatchObject({ turn: O, phase: 'clue' });
    expect(game.remaining[S]).toBe(6);

    // The other team finds one and stops.
    game = await bot.turn({ number: 1, guesses: ['own'], end: true });
    expect(game).toMatchObject({ turn: S, phase: 'clue' });
    expect(game.remaining[O]).toBe(7);

    // Clue 0 means unlimited guesses.
    game = await bot.clue(0);
    expect(game.guessesLeft, 'clue 0 gives unlimited guesses').toBe(-1);
    const { roles } = await bot.look();
    for (const g of roles[S].guessers) {
      await expect(g.page.locator('.guess-panel')).toContainText('Unlimited guesses');
      await expect(g.page.locator('.status .clue-num')).toHaveText('0');
    }
    for (let i = 0; i < 3; i++) {
      ({ game } = await bot.guess('own'));
      expect(game, 'unlimited guesses never run out').toMatchObject({ turn: S, phase: 'guess', guessesLeft: -1 });
    }
    game = await bot.endTurn();
    expect(game.remaining[S]).toBe(3);

    // The other team hits a bystander.
    game = await bot.turn({ number: 1, guesses: ['neutral'] });
    expect(game).toMatchObject({ turn: S, phase: 'clue' });

    // Clue ∞, and the last three agents.
    game = await bot.clue(-1);
    expect(game.guessesLeft).toBe(-1);
    for (const p of phones) await expect(p.page.locator('.status .clue-num'), `${p.name} shows ∞`).toHaveText('∞');
    ({ game } = await bot.guess('own'));
    ({ game } = await bot.guess('own'));
    expect(game.remaining[S]).toBe(1);
    ({ game } = await bot.guess('own'));
    expect(game).toMatchObject({ phase: 'over', winner: S, winReason: 'agents' });
    expect(game.remaining[S]).toBe(0);
    expect(game.log.map((e) => [e.clue.team, e.clue.number, e.guesses.length])).toEqual([[S, 2, 3], [O, 1, 1], [S, 0, 3], [O, 1, 1], [S, -1, 3]]);
    for (const p of phones) {
      await expect(p.page.locator('.status'), `${p.name} announces the winner`).toHaveText(`${TEAM_NAME[S]} wins!`);
      await expect(p.page.locator('.over-panel p')).toHaveText(`${TEAM_NAME[S]} found all their pictures.`);
    }

    await rematch(table);
  });

  test('3. a turn ends by bystander, by opponent card, by running out of guesses and by End turn', async ({ table, bot }) => {
    await table.setupRoom();
    let { game } = await table.check('after the deal');
    const S = game.startingTeam;
    const O = other(S);

    // Bystander.
    game = await bot.clue(2);
    ({ game } = await bot.guess('neutral'));
    expect(game, 'a bystander ends the turn at once').toMatchObject({ turn: O, phase: 'clue', remaining: { [S]: 9, [O]: 8 } });

    // Opponent's card: the turn ends and the other team is one closer.
    game = await bot.clue(2);
    ({ game } = await bot.guess('opponent'));
    expect(game, "the opponent's card ends the turn").toMatchObject({ turn: S, phase: 'clue', remaining: { [S]: 8, [O]: 8 } });
    expect(game.cards.filter((c) => c.revealed && c.team === S && c.revealedBy === O), 'the card is recorded as revealed by the team that tapped it').toHaveLength(1);

    // Running out: clue 1 allows two guesses.
    game = await bot.clue(1);
    ({ game } = await bot.guess('own'));
    expect(game).toMatchObject({ turn: S, phase: 'guess', guessesLeft: 1, guessesMade: 1 });
    ({ game } = await bot.guess('own'));
    expect(game, 'the last allowed guess passes the turn').toMatchObject({ turn: O, phase: 'clue', remaining: { [S]: 6, [O]: 8 } });

    // End turn: disabled until a guess is made, then it passes the turn.
    game = await bot.clue(3);
    const { guessers } = await bot.look();
    for (const g of guessers) await expect(g.page.locator('#end-turn'), `${g.name}: End turn is disabled before any guess`).toBeDisabled();
    ({ game } = await bot.guess('own'));
    expect(game).toMatchObject({ turn: O, phase: 'guess', guessesLeft: 3, guessesMade: 1 });
    for (const g of guessers) await expect(g.page.locator('#end-turn'), `${g.name}: End turn is enabled after a guess`).toBeEnabled();
    game = await bot.endTurn();
    expect(game, 'End turn passes the turn').toMatchObject({ turn: S, phase: 'clue', remaining: { [S]: 6, [O]: 7 } });
    expect(game.log.map((e) => e.guesses)).toEqual([['neutral'], [S], [S, S], [O]]);

    game = await bot.playToAgentsWin();
    expect(game).toMatchObject({ phase: 'over', winReason: 'agents' });
    await rematch(table);
  });

  test('4. loss by assassin', async ({ table, bot }) => {
    const phones = await table.setupRoom();
    let { game } = await table.check('after the deal');
    // Two ordinary turns first, so the loser is the starting team on its second turn.
    const loser = game.startingTeam;
    game = await bot.turn({ number: 2, guesses: ['own', 'own'], end: true });
    game = await bot.turn({ number: 1, guesses: ['own'], end: true });
    expect(game).toMatchObject({ turn: loser, phase: 'clue' });

    game = await bot.clue(1);
    const { hidden, guessers } = await bot.look();
    const assassin = hidden.assassin[0];
    ({ game } = await bot.guess('assassin'));
    expect(game, 'the assassin ends the game for the team that tapped it').toMatchObject({ phase: 'over', winner: other(loser), winReason: 'assassin' });
    expect(game.cards[assassin]).toMatchObject({ revealed: true, team: 'assassin', revealedBy: loser });
    expect(game.remaining[other(loser)], 'the winner did not need to find all agents').toBeGreaterThan(0);

    for (const p of phones) {
      await expect(p.page.locator('.status'), `${p.name} announces the winner`).toHaveText(`${TEAM_NAME[other(loser)]} wins!`);
      await expect(p.page.locator('.over-panel p')).toHaveText(`${TEAM_NAME[loser]} found the assassin.`);
      await expect(p.page.locator(`button.tile[data-card="${assassin}"] .cover`), `${p.name} shows the skull`).toHaveText('☠');
      await expect(p.page.locator('button.tile[class*="k-"]'), `${p.name} sees the whole key once the game is over`).toHaveCount(24);
    }
    // Nobody can guess any more: the zoom sheet has no Guess button.
    const still = game.cards.findIndex((c) => !c.revealed);
    await guessers[0].openCard(still);
    await expect(guessers[0].page.locator('#modal button[data-guess]')).toHaveCount(0);
    await table.check('with the zoom sheet open after game over');
    await guessers[0].closeCard();

    await rematch(table);
  });

  test("5. loss by revealing the opponent's last agent", async ({ table, bot }) => {
    const phones = await table.setupRoom();
    let { game } = await table.check('after the deal');
    const winner = other(game.startingTeam);
    const loser = other(winner);

    game = await bot.playToOpponentLastAgent({ winner });
    expect(game).toMatchObject({ phase: 'over', winner, winReason: 'agents' });
    expect(game.remaining[winner]).toBe(0);
    expect(game.remaining[loser], 'the losing team still had agents to find').toBeGreaterThan(0);
    const last = game.log[game.log.length - 1];
    expect(last.clue.team, 'the final clue was the losing team\'s').toBe(loser);
    expect(last.guesses[last.guesses.length - 1], 'and their guess revealed the winner\'s last agent').toBe(winner);
    expect(game.cards.filter((c) => c.team === winner && c.revealedBy === loser).length).toBeGreaterThan(0);
    expect(game.cards.find((c) => c.team === 'assassin').revealed).toBe(false);
    for (const p of phones) {
      await expect(p.page.locator('.over-panel p'), `${p.name} explains the ending`).toHaveText(`${TEAM_NAME[winner]} found all their pictures.`);
    }

    await rematch(table);
  });

  test('6. Play again keeps seats; Switch teams returns to the lobby, roles swap, the new game leaks no key', async ({ table, bot }) => {
    const [ada, ben, cy, dee] = await table.setupRoom();
    await bot.playToAssassin();

    // Play again, tapped by a guesser: seats kept, fresh board, no key on the guessers.
    await rematch(table, dee);
    let roles = await table.roles();
    expect([roles.red.spymaster, roles.red.guessers[0], roles.blue.spymaster, roles.blue.guessers[0]]).toEqual([ada, ben, cy, dee]);

    // Play the second game out, then Switch teams.
    const second = await bot.playToAgentsWin();
    const secondImages = second.cards.map((c) => c.image);
    await table.step('Ben taps Switch teams', () => ben.toLobby());
    let { room } = await table.check('back in the lobby');
    expect(room.game, 'Switch teams ends the game for everyone').toBeUndefined();
    for (const p of table.phones) await expect(p.page.locator('#app'), `${p.name} is in the lobby`).toHaveAttribute('data-screen', 'lobby');
    expect(room.players.map((p) => [p.name, p.team, p.role]), 'the lobby remembers the seats').toEqual([
      ['Ada', 'red', 'spymaster'], ['Ben', 'red', 'guesser'], ['Cy', 'blue', 'spymaster'], ['Dee', 'blue', 'guesser'],
    ]);
    expect(room.ready).toBe(true);

    // Swap roles inside each team. The spymaster must step down first: the seat holds one.
    await table.step('Ada moves to Orange guesser', () => ada.sit('red', 'guesser'));
    await table.step('Ben moves to Orange spymaster', () => ben.sit('red', 'spymaster'));
    await table.step('Cy moves to Purple guesser', () => cy.sit('blue', 'guesser'));
    for (const p of table.phones) await expect(p.page.locator('#start'), `${p.name}: Purple has no spymaster, so no deal`).toBeDisabled();
    await table.step('Dee moves to Purple spymaster', () => dee.sit('blue', 'spymaster'));

    await table.step('Cy deals', () => cy.start());
    let game;
    ({ room, game } = await table.check('after the deal with swapped roles'));
    expect(game.cards.map((c) => c.image)).not.toEqual(secondImages);
    roles = await table.roles();
    expect([roles.red.spymaster, roles.red.guessers[0], roles.blue.spymaster, roles.blue.guessers[0]]).toEqual([ben, ada, dee, cy]);

    // The former spymasters are guessers now and must not see this key.
    for (const p of [ada, cy]) {
      const state = await p.state();
      expect(state.game.cards.filter((c) => c.team), `${p.name} was a spymaster last game and must get no team for any card`).toHaveLength(0);
      await expect(p.page.locator('.board'), `${p.name}'s board must not be a spymaster board`).not.toHaveClass(/\bspy\b/);
      await expect(p.page.locator('button.tile[class*="k-"]'), `${p.name} must see no key colours`).toHaveCount(0);
      await expect(p.key()).rejects.toThrow(/cannot see the key/);
    }
    // The former guessers are spymasters now and see all 24.
    for (const p of [ben, dee]) {
      await expect(p.page.locator('.board'), `${p.name} has a spymaster board`).toHaveClass(/\bspy\b/);
      await expect(p.page.locator('button.tile[class*="k-"]'), `${p.name} sees the whole key`).toHaveCount(24);
    }
    expect(await ben.key()).toEqual(await dee.key());
    await table.probeSecrecy({ phones: [ada, cy] });

    // And the swapped table plays: new spymasters clue, new guessers guess.
    game = await bot.turn({ number: 2, guesses: ['own', 'own'], end: true });
    game = await bot.turn({ number: 1, guesses: ['own', 'neutral'] });
    await table.probeSecrecy({ phones: [ada, cy], cards: 1 });
    game = await bot.playToAssassin();
    expect(game.phase).toBe('over');
    await rematch(table);
  });
});
