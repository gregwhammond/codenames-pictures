'use strict';
// Edge scenarios: the awkward moments of a real game night. Slow connections,
// people leaving and coming back, two phones tapping at once, sheets left open.
//
// Every test plays the exact sequence through the real UI on real phones. Where
// a race has to be forced, one phone's request or reply is parked with
// Player.holdPost(); nothing else is faked.
//
// A scenario that shows an app bug asserts the CORRECT behaviour inside
// knownBug() (lib/known-bug.js). The test counts as an expected failure only
// when that assertion fails with the message the bug is known to produce
// (`shows` below). A broken set-up, a different failure, or the assertion
// passing all fail the run. Run with E2E_SHOW_BUGS=1 to see every known bug as
// an ordinary failure with its message, screenshots and traces. Each bug is
// written up in e2e/BUGS.md under its id.
//
// Numbers follow the plan's edge list (1-11) and the briefing's candidates 13
// and 14; 15 was found by the harness itself. There is no 12: that candidate
// is a data race in the server, which the race detector watches for on every
// run (lib/server.js).

const { test, expect, DEFAULT_SEATS } = require('../lib/table');
const { TEAM_NAME } = require('../lib/invariants');
const { knownBug, cast, recordPosts, leaveCleanly, rosterNames, seatOf, tapOutcome, toastCount } = require('../lib/edge-helpers');

const BUGS = {
  leaveRace: {
    id: 'leave-race',
    title: 'Leaving a room makes the app re-join it: the stream\'s "gone" event calls rejoin() while the leave request is still in flight, so the leaver stays in the room as an unseated ghost',
    where: 'web/app.js:157 (gone -> rejoin) and web/app.js:906-907 (await act(\'leave\'); leaveLocal())',
    shows: /sent a join request after he tapped Leave room|Ada's player list after Ben left/,
  },
  leaveRaceOffline: {
    id: 'leave-race-offline',
    title: 'When the re-join that follows a leave answers after the phone has gone home, connect() opens /api/rooms/null/events and the home screen is stuck on "Reconnecting…"',
    where: 'web/app.js:139-144 (rejoin: setRoom + connect with ui.code already null) and web/app.js:154',
    shows: /"Reconnecting…" banner|requests to \/api\/rooms\/null\//,
  },
  busyDrop: {
    id: 'busy-drop',
    title: 'act() returns without sending anything or telling the player when another request is in flight, so the tap is silently lost',
    where: 'web/app.js:101 (if (ui.busy) return)',
    shows: /the card should be revealed, or the phone should say why not|the turn should pass, or the phone should say why not/,
  },
  busyLeave: {
    id: 'busy-drop-leave',
    title: 'Leave room tapped while another request is in flight sends no leave (act() returns early) but leaveLocal() still runs, so the phone goes home while the server keeps the player in their seat',
    where: 'web/app.js:101 and web/app.js:906-907',
    shows: /leave requests sent by \w+'s phone|'s player list after \w+ left/,
  },
  clueWiped: {
    id: 'clue-wiped',
    title: 'Tapping a clue number changes the DOM without updating the region cache, so the next broadcast re-renders the clue form and empties the typed word',
    where: 'web/app.js:862-869 (number tap) and web/app.js:241-244 (region cache)',
    shows: /must not empty the field/,
  },
  spymasterGone: {
    id: 'spymaster-seat-lost',
    title: 'A spymaster who leaves mid-game cannot get the seat back (the menu offers only guesser seats), so that team can never give a clue again and the game can only be abandoned',
    where: 'room.go:224-232 (Leave frees the seat mid-game) and web/app.js:517-521 (menu offers guesser seats only)',
    shows: /menu should offer the empty spymaster seat/,
  },
  spymasterToGuesser: {
    id: 'spymaster-lock-bypass',
    title: 'A spymaster who has seen the key can leave, rejoin and sit as a guesser in the same game: the mid-game spymaster lock is tied to the player record, which Leave deletes',
    where: 'room.go:145-148 (lock checks p.Role) and room.go:224-232 (Leave drops the player)',
    shows: /must not become a guesser in it/,
  },
  zoomAcrossDeal: {
    id: 'zoom-across-deal',
    title: 'ui.selected is cleared only when the view has no game, so a zoom sheet left open over "Play again" shows the new board\'s card at the same position',
    where: 'web/app.js:220',
    shows: /ui\.selected after the new deal|zoom sheet after the new deal/,
  },
  menuAcrossLobby: {
    id: 'menu-across-lobby',
    title: 'ui.showMenu is reset only on the phone that taps "Back to lobby", so a menu left open on another phone comes back by itself on the next deal',
    where: 'web/app.js:894 (only the tapping phone resets it) and web/app.js:217-228 (setRoom never does)',
    shows: /ui\.showMenu after the new deal|menu sheet covers the new board/,
  },
  twoTabs: {
    id: 'two-tabs-leave',
    title: 'When one of a player\'s two tabs leaves the room, the other tab answers "gone" by re-joining as a new unseated player: the player has neither left nor kept their seat',
    where: 'web/app.js:157 (gone -> rejoin) and room.go:224-232',
    shows: /after Ben taps Leave room in one of his two tabs/,
  },
  enterCreates: {
    id: 'enter-creates-room',
    title: 'Enter (or the keyboard\'s Go key) in the code field submits the form with its first button, "Create a new game", so a new room is created instead of joining the typed code',
    where: 'web/app.js:321 (e.submitter?.value || \'create\') and web/app.js:281 (create is the first submit button)',
    shows: /pressed Enter; the room he is in/,
  },
  staleReply: {
    id: 'stale-reply',
    title: 'A slow reply to this phone\'s own request overwrites newer state already received from the stream: views carry no version and both paths call setRoom()',
    where: 'web/app.js:105 (act: setRoom(view)) and web/app.js:156 (stream: setRoom)',
    shows: /on Ben's phone after his own late reply arrived|did not converge[^\n]*after Ben's late reply/,
  },
  clueNumberKept: {
    id: 'clue-number-kept',
    title: 'ui.clueNumber is reset to 1 only when a game starts from the lobby, so after "Play again" the clue form opens on the number used in the last game',
    where: 'web/app.js:221 (if (!hadGame && view.game) ui.clueNumber = 1)',
    shows: /ui\.clueNumber on the new board|number lit on \w+'s clue form on the new board/,
  },
  vibrate: {
    id: 'vibrate-before-tap',
    title: 'A page loaded when it is already this phone\'s turn calls navigator.vibrate() before it has been tapped; Chromium refuses and logs a console error (the phone does not buzz)',
    where: 'web/app.js:223 (setRoom: navigator.vibrate([80, 60, 80]) with no check for a user gesture)',
    shows: /console errors on \w+'s phone when it came back on its own turn/,
  },
};

// ---------------------------------------------------------------------------

// With nothing slowed down the same thing happens almost every time against a
// local server (48 of 48 leaves measured idle, 7 of 8 under load), but "almost"
// makes a flaky test, so both tests here hold the replies to fix the order.
test.describe('1. Leaving the room races the stream\'s "gone" event', () => {
  test('1a. a player who leaves on a slow connection is out of the room', async ({ table }) => {
    const [ada, ben] = await table.setupRoom({ start: false });
    const joins = await recordPosts(ben, 'join');
    // The server handles the leave at once; its reply takes a second to arrive.
    await ben.delayPost('leave', 1000);
    await ben.leave();
    expect(ben.dialogs.map((d) => d.message)).toEqual(['Leave this room?']);

    await knownBug(table, BUGS.leaveRace, async () => {
      expect.soft(joins.requests.length, 'Ben\'s phone sent a join request after he tapped Leave room').toBe(0);
      await expect.poll(() => rosterNames(ada), { message: 'Ada\'s player list after Ben left', timeout: 4000 }).toEqual(['Ada', 'Cy', 'Dee']);
      await table.check('after Ben left the room');
    });
  });

  test('1b. a player who leaves on a slow connection ends on a working home screen', async ({ table }) => {
    const [ada, ben] = await table.setupRoom({ start: false });
    // Side effects of the bug, declared so the collectors do not report them twice.
    table.allowError({ kind: 'null-room', phone: ben }, 'leave race: stream opened for room "null"');
    table.allowError({ kind: 'http', phone: ben, url: /\/api\/rooms\/null\// }, 'leave race: 404 from /api/rooms/null/events');
    table.allowError({ kind: 'console', phone: ben, text: /rooms\/null|EventSource/ }, 'leave race: console line for the failed stream');
    table.allowError({ kind: 'requestfailed', phone: ben, url: /\/api\/rooms\/null\// }, 'leave race: failed stream request');

    // Both replies are slow: the server has handled each request, the phone has not heard yet.
    const leaveReply = await ben.holdPost('leave');
    const rejoinReply = await ben.holdPost('join');
    await ben.leave({ wait: false });
    await leaveReply.waitForHeld();
    // If the app answers the stream's "gone" by re-joining, that request is parked now.
    const rejoined = await rejoinReply.waitForHeld(1, { timeout: 3000 }).then(() => true, () => false);
    leaveReply.release();
    await expect(ben.page.locator('#app[data-screen="home"]'), 'Ben goes to the home screen once the leave is answered').toBeVisible();
    rejoinReply.release();
    if (rejoined) {
      // Give the late re-join reply the chance to do its damage before judging.
      await expect.poll(async () => table.errors.some((e) => e.kind === 'null-room') || (await ben.snapshot()).offline, { timeout: 5000 }).toBe(true).catch(() => {});
    }

    await knownBug(table, BUGS.leaveRaceOffline, async () => {
      const snap = await ben.snapshot();
      expect.soft(rejoined, 'Ben\'s phone re-joined the room it was leaving').toBe(false);
      expect.soft(table.errors.filter((e) => e.kind === 'null-room').map((e) => e.text), 'requests to /api/rooms/null/').toEqual([]);
      expect.soft(snap.offline, 'Ben\'s home screen shows the "Reconnecting…" banner (body.offline)').toBe(false);
      expect.soft(snap.ui.room, 'Ben is on the home screen but ui.room still holds a room').toBeNull();
      await expect.poll(() => rosterNames(ada), { message: 'Ada\'s player list after Ben left', timeout: 4000 }).toEqual(['Ada', 'Cy', 'Dee']);
      await table.check('after Ben left the room');
    });
  });
});

// ---------------------------------------------------------------------------

test.describe('2. Taps while another request is in flight', () => {
  test('2a. a second guess tapped while the first is still being answered is not lost', async ({ table, bot }) => {
    await table.setupRoom();
    await bot.clue(3);
    const { at, team, guesser, oppSpy } = await cast(bot);
    const [first, second] = at.hidden[team];

    const slow = await guesser.holdPost('guess');
    await guesser.guess(first, { wait: false });
    await slow.waitForHeld();
    // The stream is quicker than the reply: the phone already shows the first card revealed.
    await expect.poll(async () => (await guesser.state()).game.cards[first].revealed, { message: `${guesser.name} sees card ${first} revealed through the stream` }).toBe(true);
    expect((await guesser.ui()).busy, 'the reply to the first guess is still outstanding').toBe(true);

    await knownBug(table, BUGS.busyDrop, async () => {
      await guesser.openCard(second);
      const button = guesser.page.locator('#modal button[data-guess]');
      // An app that shows the guess cannot be made right now is behaving correctly.
      if (!(await button.count()) || await button.isDisabled()) return;
      const toasts = await toastCount(guesser);
      await guesser.tap(button);
      await expect(guesser.page.locator('.zoom'), 'the sheet closes as if the guess had been taken').toHaveCount(0);
      slow.release();
      await expect.poll(async () => (await guesser.ui()).busy).toBe(false);
      const heard = await expect.poll(async () => {
        const revealed = (await oppSpy.state()).game.cards[second].revealed;
        const told = (await toastCount(guesser)) > toasts;
        return revealed || told;
      }, { timeout: 4000 }).toBe(true).then(() => true, () => false);
      expect(heard, `${guesser.name} tapped "Guess this picture" on card ${second}: the card should be revealed, or the phone should say why not. ` +
        `Guess requests that left the phone, by card: ${JSON.stringify(slow.requests.map((r) => r.body.index))}; toasts since the tap: ${JSON.stringify((await guesser.toasts()).slice(toasts))}`).toBe(true);
      await table.check('after both guesses');
    });
  });

  test('2b. End turn tapped while a guess is still being answered is not lost', async ({ table, bot }) => {
    await table.setupRoom();
    await bot.clue(3);
    const { at, team, guesser, oppSpy } = await cast(bot);
    const [first] = at.hidden[team];

    const slow = await guesser.holdPost('guess');
    await guesser.guess(first, { wait: false });
    await slow.waitForHeld();
    await expect.poll(async () => (await guesser.state()).game.guessesMade, { message: `${guesser.name} sees the guess counted through the stream` }).toBe(1);

    await knownBug(table, BUGS.busyDrop, async () => {
      const end = guesser.page.locator('#end-turn');
      if (!(await end.count()) || await end.isDisabled()) return;
      const toasts = await toastCount(guesser);
      const ends = await recordPosts(guesser, 'end-turn');
      await guesser.tap(end);
      slow.release();
      await expect.poll(async () => (await guesser.ui()).busy).toBe(false);
      const heard = await expect.poll(async () => {
        const g = (await oppSpy.state()).game;
        const passed = g.turn !== team && g.phase === 'clue';
        const told = (await toastCount(guesser)) > toasts;
        return passed || told;
      }, { timeout: 4000 }).toBe(true).then(() => true, () => false);
      expect(heard, `${guesser.name} tapped an enabled "End turn": the turn should pass, or the phone should say why not. ` +
        `End-turn requests that left the phone: ${ends.requests.length}; toasts since the tap: ${JSON.stringify((await guesser.toasts()).slice(toasts))}`).toBe(true);
      await table.check('after End turn');
    });
  });

  test('2c. Leave room tapped while a guess is still being answered takes the player out of the room', async ({ table, bot }) => {
    await table.setupRoom();
    await bot.clue(3);
    const { at, team, guesser, oppSpy } = await cast(bot);
    const [first] = at.hidden[team];
    const everyone = await rosterNames(oppSpy);

    const slow = await guesser.holdPost('guess');
    const leaves = await recordPosts(guesser, 'leave');
    await guesser.guess(first, { wait: false });
    await slow.waitForHeld();
    await guesser.leave();
    expect(guesser.dialogs.map((d) => d.message)).toEqual(['Leave this room?']);
    slow.release();

    await knownBug(table, BUGS.busyLeave, async () => {
      expect.soft(leaves.requests.length, `leave requests sent by ${guesser.name}'s phone, which is back on the home screen`).toBe(1);
      await expect.poll(() => rosterNames(oppSpy), {
        message: `${oppSpy.name}'s player list after ${guesser.name} left`, timeout: 4000,
      }).toEqual(everyone.filter((n) => n !== guesser.name));
      await table.check(`after ${guesser.name} left`);
    });
  });
});

// ---------------------------------------------------------------------------

test.describe('3. A half-written clue and a broadcast from another phone', () => {
  test('3a. a clue typed after picking a number survives another player joining', async ({ table, bot }) => {
    await table.setupRoom();
    const eve = await table.addPhone('Eve');
    const { spy } = await cast(bot);
    const form = spy.page.locator('#clue-form');
    const word = form.locator('input[name="word"]');

    await spy.tap(form.locator('.num[data-num="3"]'));
    await expect(form.locator('.num.on')).toHaveAttribute('data-num', '3');
    await word.pressSequentially('lantern');
    await expect(word).toHaveValue('lantern');

    // Any change in the room is broadcast to every phone. Here a friend joins to watch.
    await eve.joinByLink();
    await expect.poll(async () => (await spy.state()).players.length, { message: `${spy.name} has heard that Eve joined` }).toBe(5);

    await knownBug(table, BUGS.clueWiped, async () => {
      await expect(word, `${spy.name} had typed "lantern"; Eve joining must not empty the field`).toHaveValue('lantern', { timeout: 3000 });
      await expect(form.locator('.num.on')).toHaveAttribute('data-num', '3');
      await table.check('after Eve joined while the clue was being written');
    });
  });

  test('3b. a clue typed without touching the number survives a broadcast and can be sent', async ({ table, bot }) => {
    await table.setupRoom();
    const eve = await table.addPhone('Eve');
    const { spy, team } = await cast(bot);
    const form = spy.page.locator('#clue-form');
    const word = form.locator('input[name="word"]');

    await word.pressSequentially('lantern');
    await eve.joinByLink();
    await expect.poll(async () => (await spy.state()).players.length).toBe(5);
    await expect(word, 'the typed clue is still there after Eve joined').toHaveValue('lantern');
    await expect(word, 'the field keeps focus').toBeFocused();

    await spy.tap(form.locator('button.btn.primary'));
    const { game } = await table.check('after the clue is sent');
    expect(game.clue).toEqual({ team, word: 'lantern', number: 1 });
  });
});

// ---------------------------------------------------------------------------

test.describe('4. A spymaster leaves in the middle of a game', () => {
  test('4a. the spymaster can come back and the game goes on', async ({ table, bot }) => {
    const phones = await table.setupRoom();
    const { spy, team } = await cast(bot);

    await leaveCleanly(table, spy);
    let { room, game } = await table.check(`after ${spy.name} (the ${team} spymaster) left`);
    expect(room.players.map((p) => p.name)).toEqual(phones.filter((p) => p !== spy).map((p) => p.name));
    expect(game.phase).toBe('clue');
    expect(game.turn).toBe(team);

    await spy.joinByCode();
    ({ room, game } = await table.check(`after ${spy.name} came back by typing the code`));
    expect(await seatOf(spy), 'the returning player is a spectator: Leave gave the seat up').toBe('watching');
    expect(game.phase).toBe('clue');
    expect(game.turn, `it is still ${team}'s turn to give a clue`).toBe(team);

    await knownBug(table, BUGS.spymasterGone, async () => {
      // Correct: somebody can give the clue again. Either the returning
      // spymaster has the form back, or the menu lets them retake the seat.
      if (await spy.page.locator('#clue-form').count()) return;
      await spy.openMenu();
      await expect(
        spy.page.locator(`.sheet [data-sit="${team}:spymaster"]`),
        `${TEAM_NAME[team]} has no spymaster and it is their turn to give a clue: ${spy.name}'s menu should offer the empty spymaster seat`,
      ).toBeVisible({ timeout: 3000 });
    });
  });

  test('4b. a spymaster who has seen the key cannot come back as a guesser in the same game', async ({ table, bot }) => {
    await table.setupRoom();
    const { spy, team } = await cast(bot);
    const keySeen = await spy.key();
    expect(keySeen).toHaveLength(24);
    // A fixed server would refuse the seat; that refusal is not a test problem.
    table.allowError({ kind: 'http', phone: spy, url: /\/sit$/ }, `${spy.name} is refused a guesser seat`);

    await leaveCleanly(table, spy);
    await table.check(`after ${spy.name} left`);
    await spy.joinByLink();
    await table.check(`after ${spy.name} came back`);

    await knownBug(table, BUGS.spymasterToGuesser, async () => {
      await spy.openMenu();
      const join = spy.page.locator(`.sheet [data-sit="${team}:guesser"]`);
      // Not being offered a guesser seat at all is correct too.
      if (!(await join.count())) return;
      const toasts = await toastCount(spy);
      await spy.tap(join);
      await tapOutcome(spy, toasts, (t) => {
        const p = ui.room.players.find((x) => x.id === ui.room.you); // eslint-disable-line no-undef
        return !!p && p.team === t && p.role === 'guesser';
      }, team);
      expect(await seatOf(spy), `${spy.name} saw the whole key as ${team} spymaster in this game and must not become a guesser in it`).not.toBe(`${team}/guesser`);
      await table.check(`after ${spy.name} was refused a guesser seat`);
    });
  });
});

// ---------------------------------------------------------------------------

test.describe('5. The only guesser of the team to move leaves mid-turn', () => {
  test('5. the game waits, nobody else can move for them, and it resumes when they come back', async ({ table, bot }) => {
    const phones = await table.setupRoom();
    await bot.clue(2);
    const { team, guesser } = await cast(bot);
    await bot.guess('own', { by: guesser });

    await leaveCleanly(table, guesser);
    let { snaps, game } = await table.check(`after ${guesser.name} (the only ${team} guesser) left`);
    expect(game.phase).toBe('guess');
    expect(game.turn).toBe(team);
    expect(game.guessesLeft).toBe(2);
    // Nobody at the table can guess or end the turn for them.
    for (const s of snaps.filter((x) => x.ui.room)) {
      expect(s.dom.game.guessPanel, `${s.name} has no guess panel`).toBeNull();
      expect(s.dom.game.endTurn, `${s.name} has no End turn button`).toBeNull();
      expect(s.dom.game.clueForm, `${s.name} has no clue form`).toBeNull();
    }
    // A remaining player cannot fill the seat: the menu offers seats to watchers only.
    const stayer = phones.find((p) => p !== guesser);
    await stayer.openMenu();
    await expect(stayer.page.locator('.sheet [data-sit]')).toHaveCount(0);
    await stayer.closeMenu();

    // The guesser comes back through the invite link and takes the seat again from the menu.
    await guesser.joinByLink();
    await table.check(`after ${guesser.name} came back`);
    expect(await seatOf(guesser)).toBe('watching');
    await guesser.sit(team, 'guesser');
    ({ game } = await table.check(`after ${guesser.name} sat down again`));
    expect(game.phase, 'the turn is where it was left').toBe('guess');
    expect(game.guessesLeft).toBe(2);
    expect(game.guessesMade).toBe(1);

    // And the game carries on.
    await bot.guess('own', { by: guesser });
    await bot.endTurn({ by: guesser });
  });
});

// ---------------------------------------------------------------------------

test.describe('6. A picture left open when a new board is dealt', () => {
  test('6a. a zoom sheet open at game over closes when another phone taps Play again', async ({ table, bot }) => {
    const [ada, ben] = await table.setupRoom();
    await bot.playToAssassin();
    await ben.openCard(5);
    const before = await table.check('with Ben looking at card 5 after the game');
    const oldImage = before.game.cards[5].image;

    await ada.playAgain();
    await table.settle('after Ada taps Play again');
    const now = await ben.snapshot();
    expect(now.ui.room.game.cards[5].image, 'the new board has a different picture at position 5').not.toBe(oldImage);

    await knownBug(table, BUGS.zoomAcrossDeal, async () => {
      expect.soft(now.ui.selected, 'Ben opened a picture of the old board; ui.selected after the new deal').toBeNull();
      expect.soft(now.dom.zoom, 'Ben\'s zoom sheet after the new deal (it would show a picture he never tapped)').toBeNull();
      await table.check('after Play again');
    });
  });

  test('6b. the full-screen viewer closes on Play again, and a zoom sheet closes when everyone goes to the lobby', async ({ table, bot }) => {
    const [ada, ben, cy, dee] = await table.setupRoom();
    await bot.playToAssassin();

    await dee.openViewer(3);
    await table.check('with Dee\'s viewer open after the game');
    await ada.playAgain();
    await table.settle('after Play again');
    await expect(dee.page.locator('.viewer'), 'Dee\'s viewer closes when a new board is dealt').toHaveCount(0);
    await table.check('after Play again');

    await ben.openCard(7);
    await dee.openViewer(9, { how: 'contextmenu' });
    await table.check('with Ben\'s zoom sheet and Dee\'s viewer open mid-game');
    await cy.toLobby();
    expect(cy.dialogs.map((d) => d.message)).toEqual(['End this game for everyone and go back to the lobby?']);
    await table.check('after Cy sent everyone to the lobby');
    expect((await ben.ui()).selected).toBeNull();
    await expect(ben.page.locator('.zoom')).toHaveCount(0);
    await expect(dee.page.locator('.viewer')).toHaveCount(0);

    // Nothing comes back on the next deal.
    await ada.start();
    await table.check('after the next deal');
    await expect(ben.page.locator('.zoom')).toHaveCount(0);
    await expect(dee.page.locator('.viewer')).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------

test.describe('7. A menu left open when another phone sends everyone to the lobby', () => {
  test('7. the menu does not come back by itself on the next deal', async ({ table, bot }) => {
    const [ada, ben, cy] = await table.setupRoom();
    await bot.clue(1);
    await ben.openMenu();
    await table.check('with Ben\'s menu open');

    await cy.toLobby();
    await table.check('after Cy sent everyone to the lobby');
    await expect(ben.page.locator('.sheet')).toHaveCount(0);

    await ada.start();
    await table.settle('after Ada deals again');
    expect((await ben.state()).game, 'Ben has the new game').toBeTruthy();

    await knownBug(table, BUGS.menuAcrossLobby, async () => {
      const snap = await ben.snapshot();
      expect.soft(snap.ui.showMenu, 'Ben\'s ui.showMenu after the new deal').toBe(false);
      expect.soft(snap.dom.menu, 'Ben\'s menu sheet covers the new board though he has not tapped anything').toBeNull();
      await table.check('after the new deal');
    });
  });
});

// ---------------------------------------------------------------------------

test.describe('8. Reloads and second tabs', () => {
  test('8a. every role can reload in every phase and keeps its seat and its view', async ({ table, bot }) => {
    const phones = await table.setupRoom();
    const seats = await Promise.all(phones.map(seatOf));
    expect(seats).toEqual(['red/spymaster', 'red/guesser', 'blue/spymaster', 'blue/guesser']);
    const ids = (await phones[0].state()).players.map((p) => p.id);

    const reloadAll = async (when) => {
      for (const p of phones) {
        const before = await p.state();
        await p.reload();
        const { room } = await table.check(`after ${p.name} reloads ${when}`);
        expect(await Promise.all(phones.map(seatOf)), `seats after ${p.name} reloads ${when}`).toEqual(seats);
        expect(room.players.map((x) => x.id), 'no player is added or replaced by a reload').toEqual(ids);
        // The reloaded phone sees exactly what it saw before.
        expect((await p.state()).game, `${p.name}'s view of the game after reloading ${when}`).toEqual(before.game);
      }
    };

    await reloadAll('while the first clue is awaited');
    await bot.clue(2);
    await bot.guess('own');
    await reloadAll('in the middle of a guessing turn');
    await table.probeSecrecy({ cards: 1 });

    // The game carries on from where it was.
    await bot.guess('own');
    await bot.endTurn();
    await bot.playToAssassin();
    await reloadAll('after the game is over');
    await phones[3].playAgain();
    await table.check('after the rematch deal');
    await reloadAll('on the new board');
    await bot.turn({ number: 1, guesses: ['own'] });
  });

  test('8b. a player with the game open in two tabs leaves from one of them', async ({ table }) => {
    const [ada, ben] = await table.setupRoom();
    const seat = await seatOf(ben);
    const benId = (await ben.me()).id;

    // Same browser, second tab: it has the same saved name, room and token.
    const tab = await table.addTab(ben, 'Ben-tab2');
    await tab.goto('/');
    await expect.poll(async () => (await tab.ui()).code, { message: 'the second tab goes straight back into the room' }).toBe(table.code);
    const { room } = await table.check('with Ben on two tabs');
    expect(room.players.map((p) => p.name), 'a second tab is the same player, not a fifth one').toEqual(['Ada', 'Ben', 'Cy', 'Dee']);
    expect(await seatOf(tab)).toBe(seat);

    await leaveCleanly(table, tab);
    // Wait for the first tab to react, if it is going to.
    await expect.poll(async () => {
      const me = await ben.me();
      return !me || me.id !== benId;
    }, { timeout: 3000 }).toBe(true).catch(() => {});
    // roster.connected is left out of this barrier only: now and then the server
    // also shows the re-joined Ben as away (see the note on Unsubscribe in the
    // report). The full check runs inside knownBug() below.
    await table.settle('after Ben left from his second tab', { skip: ['roster.connected'] });

    await knownBug(table, BUGS.twoTabs, async () => {
      const screen = await ben.screen();
      const listed = (await ada.state()).players.filter((p) => p.name === 'Ben');
      const now = await seatOf(ben);
      let outcome;
      if (screen === 'home' && listed.length === 0) outcome = 'Ben has left the room on both tabs';
      else if (now === seat && listed.length === 1 && listed[0].id === benId) outcome = 'Ben is still in his seat on the other tab';
      else outcome = `the other tab is on the ${screen} screen as "${now}" (was "${seat}"); Ada lists Ben as ${JSON.stringify(listed.map((p) => ({ sameIdAsBefore: p.id === benId, team: p.team || null, role: p.role || null })))}`;
      expect(outcome, 'after Ben taps Leave room in one of his two tabs').toMatch(/^Ben (has left the room on both tabs|is still in his seat on the other tab)$/);
      await table.check('after Ben left from his second tab');
    });
  });
});

// ---------------------------------------------------------------------------

test.describe('9. Joining with the keyboard', () => {
  test('9. Enter in the code field joins the room whose code was typed', async ({ table }) => {
    const [ada, ben] = await table.open(2);
    const code = await ada.createRoom();
    await table.check('after Ada created a room', { phones: [ada] });

    await ben.goto('/');
    await ben.page.locator('#name').fill('Ben');
    await ben.page.locator('#code').fill(code);
    await ben.page.locator('#code').press('Enter');
    // Either way Ben ends up in a room.
    await expect.poll(async () => { const u = await ben.ui(); return !!u.code && !u.error; }, { message: 'Ben ends up in a room' }).toBe(true);
    await expect(ben.page.locator('#app[data-screen="lobby"]')).toBeVisible();

    await knownBug(table, BUGS.enterCreates, async () => {
      expect.soft((await ben.ui()).code, `Ben typed ${code} and pressed Enter; the room he is in`).toBe(code);
      await expect.poll(() => rosterNames(ada), { message: 'Ada\'s player list', timeout: 3000 }).toEqual(['Ada', 'Ben']);
      await table.check('after Ben joined with the Enter key');
    });
  });
});

// ---------------------------------------------------------------------------

test.describe('10. A slow reply and a newer update from the stream', () => {
  test('10. a late reply to an earlier guess does not undo a teammate\'s later guess on this phone', async ({ table, bot }) => {
    // Orange has two guessers: Ben and Eve.
    const [, ben, , , eve] = await table.setupRoom({ phones: 5, seats: [...DEFAULT_SEATS, ['red', 'guesser']] });
    if ((await bot.look()).turn !== 'red') await bot.passingTurn();
    await bot.clue(3);
    const at = await bot.look();
    expect(at.turn).toBe('red');
    const [first, second] = at.hidden.red;

    // Ben guesses; the server takes it, but the reply to Ben's phone is slow.
    const slow = await ben.holdPost('guess');
    await ben.guess(first, { wait: false });
    await slow.waitForHeld();
    // Eve guesses next. Everyone, Ben included, hears about it through the stream.
    await eve.guess(second);
    await expect.poll(async () => (await ben.state()).game.cards[second].revealed, { message: `Ben's phone shows Eve's card ${second} revealed` }).toBe(true);

    // Now Ben's old reply arrives.
    slow.release();
    await expect.poll(async () => (await ben.ui()).busy).toBe(false);

    await knownBug(table, BUGS.staleReply, async () => {
      const mine = (await ben.state()).game;
      const truth = (await eve.state()).game;
      expect.soft(mine.cards[second].revealed, `card ${second}, which Eve revealed, on Ben's phone after his own late reply arrived`).toBe(true);
      expect.soft({ guessesMade: mine.guessesMade, guessesLeft: mine.guessesLeft, remaining: mine.remaining }, 'Ben\'s counters against Eve\'s').toEqual({ guessesMade: truth.guessesMade, guessesLeft: truth.guessesLeft, remaining: truth.remaining });
      await table.check('after Ben\'s late reply', { timeout: 3000 });
    });
  });
});

// ---------------------------------------------------------------------------

test.describe('11. Spectators and seat fights', () => {
  test('11a. a spectator who joins mid-game sees no key, and can join a team as a guesser', async ({ table, bot }) => {
    await table.setupRoom();
    await bot.clue(3);
    await bot.guess('own');

    const eve = await table.addPhone('Eve');
    await eve.joinByCode();
    let { snaps, game } = await table.check('after Eve joined mid-game');
    const hers = snaps.find((s) => s.name === 'Eve');
    expect(await seatOf(eve)).toBe('watching');
    expect(hers.dom.game.wait, 'a watcher is told who is playing').toBe(`${TEAM_NAME[game.turn]} is guessing…`);
    expect(hers.ui.room.game.cards.filter((c) => c.team).length, 'Eve sees a team only on the one revealed card').toBe(1);
    expect(hers.dom.game.boardClasses).not.toContain('spy');
    await table.probeSecrecy({ phones: [eve] });

    // The menu shows her the clue so far and offers guesser seats only.
    await eve.openMenu();
    ({ snaps } = await table.check('with Eve\'s menu open'));
    const menu = snaps.find((s) => s.name === 'Eve').dom.menu;
    expect(menu.sit).toEqual(['red:guesser', 'blue:guesser']);
    expect(menu.log).toHaveLength(1);
    await eve.closeMenu();

    // She reloads as a spectator: still no key.
    await eve.reload();
    await table.check('after Eve reloads as a spectator');

    // She joins the team that is guessing and makes the next guess.
    const { team } = await cast(bot);
    await eve.sit(team, 'guesser');
    ({ game } = await table.check('after Eve joined the guessing team'));
    expect(await seatOf(eve)).toBe(`${team}/guesser`);
    await table.probeSecrecy({ phones: [eve], cards: 1 });
    await bot.guess('own', { by: eve });
    await bot.endTurn({ by: eve });
  });

  test('11b. two phones go for the same spymaster seat: one gets it, the other is told', async ({ table }) => {
    const [ada, ben] = await table.setupRoom({ seats: [], start: false });
    table.expectError({ kind: 'http', phone: ben, status: 409, url: /\/sit$/ }, 'Ben is refused the spymaster seat Ada took first');

    // Ben taps first, but his request is slow to reach the server.
    const slow = await ben.holdPost('sit', { phase: 'request' });
    await ben.sit('red', 'spymaster', { wait: false });
    await slow.waitForHeld();
    await ada.sit('red', 'spymaster');
    const toasts = await toastCount(ben);
    slow.release();
    await ben.expectToast('that team already has a spymaster', { since: toasts });

    const { room } = await table.check('after both went for the Orange spymaster seat');
    expect(room.players.filter((p) => p.role === 'spymaster').map((p) => p.name)).toEqual(['Ada']);
    expect(await seatOf(ben)).toBe('watching');
    // On Ben's phone the seat is now taken and cannot be tapped.
    await expect(ben.page.locator('button.seat[data-sit="red:spymaster"]')).toBeDisabled();
    const sits = await recordPosts(ben, 'sit');
    await ben.sit('red', 'spymaster', { wait: false });
    await ben.sit('red', 'guesser');
    expect(sits.requests.map((r) => r.body.role), 'a tap on the taken seat sends nothing').toEqual(['guesser']);
    await table.check('after Ben sat as a guesser instead');
  });
});

// ---------------------------------------------------------------------------

test.describe('13. The clue number on a new board', () => {
  /** Both spymasters give a clue with a number other than 1, and the game ends on the assassin. */
  async function gameWithOtherNumbers(bot) {
    await bot.turn({ number: 3, guesses: ['neutral'] });
    const game = await bot.turn({ number: 2, guesses: ['assassin'] });
    expect(game.phase).toBe('over');
  }

  test('13a. after Play again the clue form starts on 1', async ({ table, bot }) => {
    const [ada] = await table.setupRoom();
    await gameWithOtherNumbers(bot);
    await ada.playAgain();
    await table.check('after Play again');
    const { spy } = await cast(bot);

    await knownBug(table, BUGS.clueNumberKept, async () => {
      expect.soft((await spy.ui()).clueNumber, `${spy.name}'s ui.clueNumber on the new board`).toBe(1);
      await expect(spy.page.locator('#clue-form .num.on'), `the number lit on ${spy.name}'s clue form on the new board`).toHaveAttribute('data-num', '1', { timeout: 3000 });
    });
  });

  test('13b. after Switch teams and a new deal the clue form starts on 1', async ({ table, bot }) => {
    const [ada, ben] = await table.setupRoom();
    await gameWithOtherNumbers(bot);
    await ben.toLobby();
    await table.check('after Switch teams');
    await ada.start();
    await table.check('after the new deal');
    const { spy } = await cast(bot);
    expect((await spy.ui()).clueNumber).toBe(1);
    await expect(spy.page.locator('#clue-form .num.on')).toHaveAttribute('data-num', '1');
  });
});

// ---------------------------------------------------------------------------

test.describe('14. Who can end the game for everyone', () => {
  // BY DESIGN, not counted as a bug: the lobby says "Anyone can start", the
  // menu offers "Back to lobby" to everyone in the room, and the server accepts
  // it from any player in the room (main.go:238-239, room.go:190-192,
  // web/app.js:526). A spectator can also join a team from the menu and tap
  // the assassin, so refusing this one action would protect little. This test
  // records what happens today; whether a spectator should be able to do it is
  // a product question (see e2e/BUGS.md, "Design questions").
  test('14a. a spectator who confirms "Back to lobby" sends everyone to the lobby, seats kept (by design)', async ({ table, bot }) => {
    const [ada] = await table.setupRoom();
    await bot.clue(2);
    await bot.guess('own');
    const eve = await table.addPhone('Eve');
    await eve.joinByLink();
    await table.check('after Eve joined to watch');
    expect(await seatOf(eve)).toBe('watching');

    await eve.toLobby();
    expect(eve.dialogs, 'Eve is asked before the game is ended').toEqual([{ type: 'confirm', message: 'End this game for everyone and go back to the lobby?', accepted: true }]);
    const { room } = await table.check('after Eve (a spectator) tapped "Back to lobby"');
    expect(room.game, 'the game is over for everyone').toBeFalsy();
    for (const p of table.phones) await expect(p.page.locator('#app'), `${p.name} is in the lobby`).toHaveAttribute('data-screen', 'lobby');
    expect(await Promise.all(table.phones.map(seatOf)), 'every seat is kept').toEqual(['red/spymaster', 'red/guesser', 'blue/spymaster', 'blue/guesser', 'watching']);
    expect(room.ready).toBe(true);

    // The table can deal again straight away.
    await ada.start();
    const { game } = await table.check('after Ada deals again');
    expect(game).toMatchObject({ phase: 'clue', log: [] });
  });

  test('14b. a player can send everyone back to the lobby mid-game, after confirming', async ({ table, bot }) => {
    const [, ben, , dee] = await table.setupRoom();
    await bot.clue(2);

    // Saying no to the question changes nothing.
    ben.dialogPolicy = 'dismiss';
    const posts = await recordPosts(ben, 'lobby');
    await ben.toLobby({ wait: false, via: 'menu' });
    await expect.poll(() => ben.dialogs).toEqual([{ type: 'confirm', message: 'End this game for everyone and go back to the lobby?', accepted: false }]);
    expect(posts.requests).toHaveLength(0);
    await ben.closeMenu();
    const still = await table.check('after Ben said no');
    expect(still.game.phase).toBe('guess');

    // Saying yes ends it for everyone, seats kept.
    await dee.toLobby();
    const { room } = await table.check('after Dee sent everyone to the lobby');
    expect(room.game).toBeFalsy();
    expect(room.ready).toBe(true);
    expect(await Promise.all(table.phones.map(seatOf))).toEqual(['red/spymaster', 'red/guesser', 'blue/spymaster', 'blue/guesser']);
  });
});

// ---------------------------------------------------------------------------

test.describe('15. The buzz for "your turn" on a phone that has not been tapped yet', () => {
  // A player reopens the app (or reloads) when it is already their turn. The
  // app joins the room again and calls navigator.vibrate() straight away
  // (web/app.js:223). Chromium only allows that after the page has been
  // tapped, so it refuses and logs a console error; the phone does not buzz.
  // WebKit has no navigator.vibrate, so nothing can go wrong there.
  //
  // Two things are needed to see this reliably. The guessers' phones record no
  // trace, because a traced page counts as tapped from the moment it loads.
  // And the test does not look into the page between the reload and the moment
  // the app hears it is in the room: page.evaluate counts as a tap too.
  test('15. a phone reloaded on its own turn comes back without a console error', async ({ table, bot, browserName }) => {
    const phones = [await table.addPhone('Ada'), await table.addPhone('Ben', { trace: false }), await table.addPhone('Cy'), await table.addPhone('Dee', { trace: false })];
    await table.setupRoom({ phones });
    await bot.clue(2);
    const { guesser, team } = await cast(bot);
    const canBuzz = browserName === 'chromium';
    // The fixture lets this console line through in every test (table.known.vibrate),
    // so it is asserted on here directly.
    const blockedBuzz = () => table.errors.filter((e) => e.phone === guesser.name && e.kind === 'console' && /navigator\.vibrate/.test(e.text)).map((e) => e.text);

    const join = await guesser.holdPost('join');
    await guesser.reload({ wait: false });
    await join.waitForHeld();
    expect(blockedBuzz(), 'nothing is logged before the app is back in the room').toEqual([]);
    join.release();

    await knownBug(table, BUGS.vibrate, async () => {
      // Recorded on the Node side; the page is not touched while waiting.
      if (canBuzz) await expect.poll(() => blockedBuzz().length, { timeout: 5000 }).toBeGreaterThan(0).catch(() => {});
      const logged = blockedBuzz();
      // Only now look at the page: it is back in the game, on its own turn.
      await expect.poll(async () => { const g = ((await guesser.state()) || {}).game; return g ? `${g.phase} ${g.turn}` : null; }, { message: `${guesser.name} is back in the game` }).toBe(`guess ${team}`);
      expect(logged, `console errors on ${guesser.name}'s phone when it came back on its own turn`).toEqual([]);
      await table.check(`after ${guesser.name} reloads on their own turn`);
    }, { when: canBuzz });
  });
});
