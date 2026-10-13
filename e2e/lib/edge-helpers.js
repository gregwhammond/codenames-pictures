'use strict';
// Helpers for tests/edge.spec.js.

const { expect } = require('./table');
const { other } = require('./invariants');
// knownBug() marks a test that demonstrates an app bug; see lib/known-bug.js.
const { knownBug, SHOW } = require('./known-bug');

/**
 * Who is who for the team to move:
 * { at, team, opp, spy, guesser, guessers, oppSpy, oppGuesser }.
 * The starting team is random, so tests name phones through this.
 */
async function cast(bot) {
  const at = await bot.look();
  const team = at.turn;
  const opp = other(team);
  return {
    at,
    team,
    opp,
    spy: at.roles[team].spymaster,
    guessers: at.roles[team].guessers,
    guesser: at.roles[team].guessers[0] || null,
    oppSpy: at.roles[opp].spymaster,
    oppGuesser: at.roles[opp].guessers[0] || null,
  };
}

/** Record this phone's POSTs to an action without delaying them. Returns the PostHold (see .requests). */
async function recordPosts(phone, action) {
  const hold = await phone.holdPost(action);
  hold.release();
  return hold;
}

/**
 * "Leave room" with the leave race (edge scenario 1) taken out of play.
 *
 * When a player leaves, the server also tells that phone's event stream it is
 * gone, and the app answers that by re-joining the room (web/app.js:157), so
 * the leaver stays in the room as a ghost. Scenarios that are about what
 * happens AFTER a player has left need the player to be really gone, so the
 * re-join request is made to fail here, as it would on a phone that lost its
 * connection at that moment. Scenario 1 tests the race itself.
 */
async function leaveCleanly(table, phone) {
  table.allowError({ kind: 'requestfailed', phone, url: /\/join$/ }, `${phone.name}: the re-join that follows a leave is blocked by leaveCleanly()`);
  const block = await phone.abortPost('join');
  await phone.leave();
  await expect.poll(async () => (await phone.ui()).code, { message: `${phone.name}: still in a room after leaving` }).toBeNull();
  await block.remove();
  return block;
}

/** Names in the player list as `phone` has it. */
async function rosterNames(phone) {
  const room = await phone.state();
  return room ? room.players.map((p) => p.name) : null;
}

/** "team/role" of this phone's own seat, "watching" when unseated, "out" when not in a room. */
async function seatOf(phone) {
  const me = await phone.me();
  if (!me) return 'out';
  return me.team ? `${me.team}/${me.role}` : 'watching';
}

/**
 * After a tap made with { wait: false }: wait until the phone has no request
 * in flight and either `pred(arg)` holds in the page or a toast has appeared.
 * Unlike Player's own waiting this does not throw: it returns
 * { ok, toast, timedOut } so the test can assert on what happened.
 */
async function tapOutcome(phone, toastsBefore, pred, arg, { timeout = 4000 } = {}) {
  try {
    const handle = await phone.page.waitForFunction(({ src, arg: a, n }) => {
      if (ui.busy) return false; // eslint-disable-line no-undef
      let ok = false;
      try { ok = !!(0, eval)(src)(a); } catch (_) { ok = false; } // eslint-disable-line no-eval
      const e = window.__e2e;
      const toast = e && e.toasts.length > n ? e.toasts[e.toasts.length - 1].text : null;
      return ok || toast != null ? { ok, toast } : false;
    }, { src: `(${pred.toString()})`, arg, n: toastsBefore }, { timeout });
    return { ...(await handle.jsonValue()), timedOut: false };
  } catch (err) {
    if (!/Timeout/i.test(String(err.message))) throw err;
    return { ok: false, toast: null, timedOut: true };
  }
}

/** Number of toasts this phone has shown since its page loaded. */
async function toastCount(phone) {
  return (await phone.toasts()).length;
}

module.exports = { knownBug, cast, recordPosts, leaveCleanly, rosterNames, seatOf, tapOutcome, toastCount, SHOW };
