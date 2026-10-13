'use strict';
// Cross-phone invariants. Pure functions over snapshots (see pageSnapshot in
// player.js), so they can be run on any set of phones: two, four, six, with
// spectators, with phones sitting on the home screen.
//
// Two groups:
//   settle problems  things that are legitimately untrue for a moment after an
//                    action (a phone has not received the broadcast yet). The
//                    table polls until none are left, and fails if they persist.
//   violations       checked once on the settled snapshots. Never polled away.
//
// Every problem is { id, phone, message }. Ids are dotted (`secrecy.dom`), and
// a check can be skipped by id or by prefix (`secrecy`).

const TEAMS = ['red', 'blue'];
const CARD_COUNT = 24;
const KEY_COUNTS = { starting: 9, second: 8, neutral: 6, assassin: 1 };
const TEAM_NAME = { red: 'Orange', blue: 'Purple' };
const KEY_LABEL = { red: 'Orange agent', blue: 'Purple agent', neutral: 'Bystander', assassin: 'Assassin' };

/** Id -> what it asserts. The documentation of the invariant set. */
const INVARIANTS = {
  'settle.booted': 'the app has loaded and rendered a screen',
  'settle.busy': 'no request is still in flight (ui.busy)',
  'hygiene.offline': 'no phone shows the "Reconnecting…" banner (body.offline)',
  'hygiene.errors': 'no JS error, console error, failed request, HTTP error or /api/rooms/null/ request that the test did not declare',
  'roster.self': 'each phone in a room is in that room\'s player list',
  'roster.connected': 'every phone in the room is shown as connected on every phone',
  'roster.ghosts': 'the room has no players beyond the phones that are in it',
  'roster.spymasters': 'at most one spymaster per team',
  'agreement.*': 'all phones in a room agree on players, ready, turn, phase, clue, guessesLeft, guessesMade, remaining, winner, winReason, startingTeam, log, the 24 images in order, the revealed set, revealedBy and the teams of revealed cards (one id per field)',
  'agreement.key': 'all phones that can see the key see the same key',
  'lobby.ready': 'ready is true exactly when both teams have a spymaster and at least one guesser',
  'counts.cards': '24 cards with 24 distinct images',
  'counts.key': 'the key is 9 for the starting team, 8 for the other, 6 bystanders, 1 assassin (JSON, and tile classes on a key-seeing phone)',
  'counts.remaining': 'remaining equals the unrevealed agents of each team',
  'counts.tiles': '24 tiles in the DOM, data-card 0..23 in order',
  'counts.scorebar': 'scorebar numbers equal remaining',
  'secrecy.json': 'a phone that must not see the key has no team (or revealedBy) on any unrevealed card',
  'secrecy.dom': 'a phone that must not see the key has no .board.spy, no key class and no team in the aria-label on any unrevealed tile',
  'secrecy.zoom': 'the zoom sheet shows no key class or key tag for a card whose team this phone must not see',
  'secrecy.viewer': 'the full-screen viewer shows no key class or tag for a card whose team this phone must not see',
  'key.complete': 'a spymaster (and everyone once the game is over) has a team on all 24 cards, in JSON and on the tiles',
  'logic.phase': 'clue/guess/over each carry the right clue, guess counters, winner and win reason',
  'logic.log': 'the clue log matches the board: one guess per revealed card, same teams, clue teams alternate from the starting team, and the turn follows from it',
  'dom.screen': 'lobby screen when there is no game, game screen when there is',
  'dom.lobby': 'lobby shows the room code, the right people in each seat, own seat marked, taken spymaster seats disabled, Deal enabled exactly when ready',
  'dom.tiles': 'tile i shows card i: same image, revealed class and cover exactly when revealed, key class equal to the team in JSON',
  'dom.board': '.board has .spy for a spymaster only, .over when the game is over only, .can-guess for an active guesser only',
  'dom.turn': 'the active score and #app.turn-* follow the turn (none once over)',
  'dom.status': 'the status line shows the current clue word and number',
  'dom.zoom': 'the zoom sheet is open exactly when a card is selected and shows that card',
  'dom.menu': 'the menu sheet is open exactly when ui.showMenu, lists every player and the clue log',
  'controls.clueForm': 'the clue form is shown on the active team\'s spymaster in the clue phase and nowhere else',
  'controls.guessPanel': 'the guess panel is shown on the active team\'s guessers in the guess phase and nowhere else',
  'controls.endTurn': 'End turn is disabled until a guess has been made this turn',
  'controls.zoomGuess': 'the zoom sheet offers Guess exactly to an active guesser on an unrevealed card',
  'controls.over': 'when the game is over every phone shows Play again and Switch teams, and no clue form or guess panel',
  'monotonic.revealed': 'within one game a revealed card never becomes unrevealed',
  'monotonic.log': 'within one game the clue log only grows',
};

const other = (t) => (t === 'red' ? 'blue' : t === 'blue' ? 'red' : t);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = (v) => {
  const s = JSON.stringify(v);
  return s && s.length > 300 ? `${s.slice(0, 300)}…` : s;
};

function inRoom(s) {
  return !!(s.ui && s.ui.code && s.ui.room);
}

function meOf(s) {
  const room = s.ui && s.ui.room;
  return room ? room.players.find((p) => p.id === room.you) || null : null;
}

/** May this phone see the whole key right now? */
function seesKey(s) {
  const g = s.ui.room.game;
  const me = meOf(s);
  return !!g && ((me && me.role === 'spymaster') || g.phase === 'over');
}

function canGuess(s) {
  const g = s.ui.room.game;
  const me = meOf(s);
  return !!g && !!me && g.phase === 'guess' && me.role === 'guesser' && me.team === g.turn;
}

/** Everything every phone in a room must agree on, one comparable value per field. */
function publicView(room) {
  const g = room.game;
  const v = {
    players: room.players.map((p) => ({ id: p.id, name: p.name, team: p.team || '', role: p.role || '', connected: p.connected })),
    ready: room.ready,
    hasGame: !!g,
  };
  if (g) {
    Object.assign(v, {
      startingTeam: g.startingTeam,
      turn: g.turn,
      phase: g.phase,
      clue: g.clue || null,
      guessesLeft: g.guessesLeft,
      guessesMade: g.guessesMade,
      remaining: { red: g.remaining.red, blue: g.remaining.blue },
      winner: g.winner || '',
      winReason: g.winReason || '',
      log: g.log,
      images: g.cards.map((c) => c.image),
      revealed: g.cards.map((c) => !!c.revealed),
      revealedBy: g.cards.map((c) => c.revealedBy || ''),
      revealedTeams: g.cards.map((c) => (c.revealed ? c.team || '?' : '')),
    });
  }
  return v;
}

function groupByRoom(snaps) {
  const rooms = new Map();
  for (const s of snaps) {
    if (!inRoom(s)) continue;
    const code = s.ui.code;
    if (!rooms.has(code)) rooms.set(code, []);
    rooms.get(code).push(s);
  }
  return rooms;
}

function firstDiff(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `lengths ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) if (!same(a[i], b[i])) return `at index ${i}: ${show(a[i])} vs ${show(b[i])}`;
  }
  return `${show(a)} vs ${show(b)}`;
}

/**
 * Conditions that may be briefly false after an action. Returns problems; an
 * empty list means the phones have converged.
 */
function settleProblems(snaps) {
  const out = [];
  const add = (id, s, message) => out.push({ id, phone: s ? s.name : '(table)', message });
  for (const s of snaps) {
    if (!s.booted) { add('settle.booted', s, `app not rendered yet${s.error ? ` (${s.error})` : ''}`); continue; }
    if (s.ui.busy) add('settle.busy', s, 'a request is still in flight (ui.busy is true)');
    if (s.offline) add('hygiene.offline', s, `body.offline is set: the "Reconnecting…" banner is showing (screen ${s.screen}, code ${s.ui.code}, stream ${s.ui.sse ? `${s.ui.sse.url} readyState ${s.ui.sse.readyState}` : 'none'})`);
  }
  for (const [code, group] of groupByRoom(snaps.filter((s) => s.booted))) {
    const ref = group[0];
    const refView = publicView(ref.ui.room);
    for (const s of group.slice(1)) {
      const v = publicView(s.ui.room);
      for (const field of Object.keys({ ...refView, ...v })) {
        if (!same(refView[field], v[field])) {
          add(`agreement.${field}`, s, `room ${code}: ${s.name} and ${ref.name} disagree on ${field}: ${firstDiff(v[field], refView[field])}`);
        }
      }
    }
    const keyed = group.filter((s) => s.ui.room.game && seesKey(s));
    for (const s of keyed.slice(1)) {
      const a = s.ui.room.game.cards.map((c) => c.team || '');
      const b = keyed[0].ui.room.game.cards.map((c) => c.team || '');
      if (!same(a, b)) add('agreement.key', s, `room ${code}: ${s.name} and ${keyed[0].name} see different keys: ${firstDiff(a, b)}`);
    }
    for (const s of group) {
      const me = meOf(s);
      if (!me) { add('roster.self', s, `room ${code}: this phone (id ${s.ui.room.you}) is not in its own player list`); continue; }
      for (const viewer of group) {
        const seen = viewer.ui.room.players.find((p) => p.id === me.id);
        if (seen && !seen.connected) add('roster.connected', viewer, `room ${code}: ${viewer.name} shows ${s.name} as disconnected`);
      }
    }
  }
  return out;
}

function keyCounts(teams) {
  const n = { red: 0, blue: 0, neutral: 0, assassin: 0, other: 0 };
  for (const t of teams) { if (t in n) n[t] += 1; else n.other += 1; }
  return n;
}

function expectedKeyCounts(startingTeam) {
  return {
    [startingTeam]: KEY_COUNTS.starting,
    [other(startingTeam)]: KEY_COUNTS.second,
    neutral: KEY_COUNTS.neutral,
    assassin: KEY_COUNTS.assassin,
    other: 0,
  };
}

function checkJSON(s, add) {
  const room = s.ui.room;
  const me = meOf(s);
  const g = room.game;

  const spies = { red: 0, blue: 0 };
  const guessers = { red: 0, blue: 0 };
  for (const p of room.players) {
    if (p.role === 'spymaster' && p.team in spies) spies[p.team] += 1;
    if (p.role === 'guesser' && p.team in guessers) guessers[p.team] += 1;
  }
  for (const t of TEAMS) if (spies[t] > 1) add('roster.spymasters', `${TEAM_NAME[t]} has ${spies[t]} spymasters`);
  const ready = spies.red === 1 && spies.blue === 1 && guessers.red >= 1 && guessers.blue >= 1;
  if (room.ready !== ready) add('lobby.ready', `ready is ${room.ready} but the seats say ${ready} (spymasters ${show(spies)}, guessers ${show(guessers)})`);

  if (!g) return;
  const cards = g.cards;
  if (cards.length !== CARD_COUNT) add('counts.cards', `JSON has ${cards.length} cards, expected ${CARD_COUNT}`);
  const distinct = new Set(cards.map((c) => c.image)).size;
  if (distinct !== cards.length) add('counts.cards', `only ${distinct} distinct images among ${cards.length} cards`);

  const key = seesKey(s);
  if (!key) {
    cards.forEach((c, i) => {
      if (!c.revealed && c.team) add('secrecy.json', `card ${i} is unrevealed but its JSON carries team "${c.team}" on a ${me ? me.role || 'watching' : 'unknown'} phone`);
      if (!c.revealed && c.revealedBy) add('secrecy.json', `card ${i} is unrevealed but carries revealedBy "${c.revealedBy}"`);
    });
  } else {
    const missing = cards.map((c, i) => (c.team ? -1 : i)).filter((i) => i >= 0);
    if (missing.length) add('key.complete', `this phone should see the whole key but cards ${missing.join(', ')} have no team`);
    else {
      const got = keyCounts(cards.map((c) => c.team));
      const want = expectedKeyCounts(g.startingTeam);
      if (!same(got, { red: want.red, blue: want.blue, neutral: want.neutral, assassin: want.assassin, other: 0 })) {
        add('counts.key', `key is ${show(got)}, expected ${want[g.startingTeam]} for starting team ${g.startingTeam}, ${want[other(g.startingTeam)]} for the other, 6 neutral, 1 assassin`);
      }
      for (const t of TEAMS) {
        const left = cards.filter((c) => c.team === t && !c.revealed).length;
        if (g.remaining[t] !== left) add('counts.remaining', `remaining.${t} is ${g.remaining[t]} but ${left} ${t} agents are unrevealed in the key`);
      }
    }
  }
  // Works without the key too: revealed cards always carry their team.
  for (const t of TEAMS) {
    const total = t === g.startingTeam ? KEY_COUNTS.starting : KEY_COUNTS.second;
    const found = cards.filter((c) => c.revealed && c.team === t).length;
    if (g.remaining[t] !== total - found) add('counts.remaining', `remaining.${t} is ${g.remaining[t]} but ${found} of ${total} ${t} agents are revealed`);
  }
  cards.forEach((c, i) => {
    if (c.revealed && !c.team) add('logic.phase', `card ${i} is revealed but has no team`);
    if (c.revealed && !TEAMS.includes(c.revealedBy)) add('logic.phase', `card ${i} is revealed but revealedBy is ${show(c.revealedBy)}`);
  });

  const assassinRevealed = cards.some((c) => c.revealed && c.team === 'assassin');
  if (!TEAMS.includes(g.turn)) add('logic.phase', `turn is ${show(g.turn)}`);
  if (g.phase === 'clue') {
    if (g.clue) add('logic.phase', `clue phase but a clue is set: ${show(g.clue)}`);
    if (g.guessesLeft !== 0 || g.guessesMade !== 0) add('logic.phase', `clue phase but guessesLeft=${g.guessesLeft}, guessesMade=${g.guessesMade}`);
  } else if (g.phase === 'guess') {
    if (!g.clue) add('logic.phase', 'guess phase without a clue');
    else {
      if (g.clue.team !== g.turn) add('logic.phase', `clue belongs to ${g.clue.team} but it is ${g.turn}'s turn`);
      const n = g.clue.number;
      const want = n === -1 || n === 0 ? -1 : n + 1 - g.guessesMade;
      if (g.guessesLeft !== want) add('logic.phase', `clue number ${n} with ${g.guessesMade} guesses made should leave ${want} guesses, got ${g.guessesLeft}`);
      if (want !== -1 && want <= 0) add('logic.phase', `guess phase with no guesses left (${want})`);
    }
  } else if (g.phase === 'over') {
    if (!TEAMS.includes(g.winner)) add('logic.phase', `game over but winner is ${show(g.winner)}`);
    if (g.clue) add('logic.phase', `game over but a clue is still set: ${show(g.clue)}`);
    if (g.winReason === 'agents') {
      if (g.remaining[g.winner] !== 0) add('logic.phase', `${g.winner} won by agents but has ${g.remaining[g.winner]} left`);
      if (assassinRevealed) add('logic.phase', 'won by agents but the assassin is revealed');
    } else if (g.winReason === 'assassin') {
      const a = cards.find((c) => c.team === 'assassin');
      if (!a || !a.revealed) add('logic.phase', 'won by assassin but the assassin card is not revealed');
      else if (a.revealedBy !== other(g.winner)) add('logic.phase', `assassin revealed by ${a.revealedBy} but the winner is ${g.winner}`);
    } else add('logic.phase', `game over with winReason ${show(g.winReason)}`);
  } else add('logic.phase', `unknown phase ${show(g.phase)}`);
  if (g.phase !== 'over') {
    if (g.winner || g.winReason) add('logic.phase', `game not over but winner=${show(g.winner)} winReason=${show(g.winReason)}`);
    if (g.remaining.red <= 0 || g.remaining.blue <= 0) add('logic.phase', `game not over but remaining is ${show(g.remaining)}`);
    if (assassinRevealed) add('logic.phase', 'game not over but the assassin is revealed');
  }

  // The log against the board.
  const log = g.log || [];
  const guesses = log.flatMap((e) => e.guesses);
  const revealedTeams = cards.filter((c) => c.revealed).map((c) => c.team);
  if (!same([...guesses].sort(), [...revealedTeams].sort())) {
    add('logic.log', `the log records guesses ${show(keyCounts(guesses))} but the board has revealed ${show(keyCounts(revealedTeams))}`);
  }
  log.forEach((e, i) => {
    const want = i % 2 === 0 ? g.startingTeam : other(g.startingTeam);
    if (e.clue.team !== want) add('logic.log', `log entry ${i} is a ${e.clue.team} clue, expected ${want} (teams alternate from ${g.startingTeam})`);
    // Every guess but the last of an entry kept the turn, so it was an own agent.
    e.guesses.slice(0, -1).forEach((t, j) => {
      if (t !== e.clue.team) add('logic.log', `log entry ${i} guess ${j} is "${t}" but the ${e.clue.team} turn carried on after it`);
    });
  });
  if (g.phase === 'guess') {
    const last = log[log.length - 1];
    if (!last || !same(last.clue, g.clue)) add('logic.log', `the last log entry ${show(last && last.clue)} is not the current clue ${show(g.clue)}`);
    else if (last.guesses.length !== g.guessesMade) add('logic.log', `guessesMade is ${g.guessesMade} but the current log entry has ${last.guesses.length} guesses`);
  }
  if (g.phase === 'clue') {
    const want = log.length % 2 === 0 ? g.startingTeam : other(g.startingTeam);
    if (g.turn !== want) add('logic.log', `after ${log.length} clues from starting team ${g.startingTeam} it should be ${want}'s turn, got ${g.turn}`);
  }
}

function personLabel(p, you) {
  return `${p.name}${p.id === you ? ' (you)' : ''}`;
}

function checkLobbyDOM(s, add) {
  const room = s.ui.room;
  const me = meOf(s);
  const d = s.dom.lobby;
  if (!d) { add('dom.lobby', 'no lobby section in the DOM'); return; }
  if (d.roomCode !== room.code) add('dom.lobby', `room code shows ${show(d.roomCode)}, expected ${room.code}`);
  for (const team of TEAMS) {
    for (const role of ['spymaster', 'guesser']) {
      const k = `${team}:${role}`;
      const seat = d.seats[k];
      if (!seat) { add('dom.lobby', `seat ${k} is missing`); continue; }
      const people = room.players.filter((p) => p.team === team && p.role === role);
      const want = people.map((p) => personLabel(p, room.you));
      const got = seat.people.map((p) => p.text);
      if (!same(got, want)) add('dom.lobby', `seat ${k} shows ${show(got)}, expected ${show(want)}`);
      const mine = !!me && me.team === team && me.role === role;
      if (seat.mine !== mine) add('dom.lobby', `seat ${k} ${seat.mine ? 'is' : 'is not'} marked as mine, expected ${mine}`);
      const full = role === 'spymaster' && people.length > 0 && !mine;
      if (seat.disabled !== full) add('dom.lobby', `seat ${k} is ${seat.disabled ? 'disabled' : 'enabled'}, expected ${full ? 'disabled' : 'enabled'}`);
    }
  }
  const unseated = room.players.filter((p) => !p.team).map((p) => personLabel(p, room.you));
  if (!same(d.waiting, unseated)) add('dom.lobby', `"Not on a team yet" shows ${show(d.waiting)}, expected ${show(unseated)}`);
  if (!d.start) add('dom.lobby', 'no Deal button');
  else if (d.start.disabled !== !room.ready) add('dom.lobby', `Deal button is ${d.start.disabled ? 'disabled' : 'enabled'} but ready is ${room.ready}`);
  if (d.hasStand !== !!(me && me.team)) add('dom.lobby', `"Leave my seat" ${d.hasStand ? 'shown' : 'hidden'} but this phone is ${me && me.team ? 'seated' : 'not seated'}`);
}

const toLarge = (src) => String(src).replace(/^\/cards\//, '/cards-large/');

function checkGameDOM(s, add) {
  const room = s.ui.room;
  const g = room.game;
  const me = meOf(s);
  const d = s.dom.game;
  if (!d) { add('dom.screen', 'game in progress but no board in the DOM'); return; }
  const key = seesKey(s);
  const spy = !!me && me.role === 'spymaster';
  const over = g.phase === 'over';

  // Tiles.
  if (d.tiles.length !== CARD_COUNT) add('counts.tiles', `${d.tiles.length} tiles in the DOM, expected ${CARD_COUNT}`);
  d.tiles.forEach((t, i) => { if (t.card !== i) add('counts.tiles', `tile at position ${i} has data-card="${t.card}"`); });
  d.tiles.forEach((t) => {
    const c = g.cards[t.card];
    if (!c) return;
    if (t.img !== c.image) add('dom.tiles', `tile ${t.card} shows ${t.img}, JSON says ${c.image}`);
    if (t.revealed !== !!c.revealed) add('dom.tiles', `tile ${t.card} ${t.revealed ? 'has' : 'lacks'} .revealed but JSON revealed=${c.revealed}`);
    if (t.cover !== !!c.revealed) add('dom.tiles', `tile ${t.card} ${t.cover ? 'has' : 'lacks'} a cover but JSON revealed=${c.revealed}`);
    if (!same(t.key, c.team ? [c.team] : [])) add('dom.tiles', `tile ${t.card} has key classes ${show(t.key)} but JSON team is ${show(c.team || null)}`);
  });

  // Secrecy on the DOM, checked on its own terms rather than through the JSON.
  if (!key) {
    if (d.boardClasses.includes('spy')) add('secrecy.dom', `.board.spy on a ${me ? me.role || 'watching' : 'unknown'} phone`);
    for (const t of d.tiles) {
      if (t.revealed) continue;
      if (t.key.length) add('secrecy.dom', `unrevealed tile ${t.card} carries key class k-${t.key.join(', k-')}`);
      if (/red|blue|neutral|assassin|orange|purple|bystander/i.test((t.label || '').replace(/^Picture \d+/, ''))) add('secrecy.dom', `unrevealed tile ${t.card} names its team in aria-label ${show(t.label)}`);
    }
  } else {
    const bare = d.tiles.filter((t) => t.key.length !== 1).map((t) => t.card);
    if (bare.length) add('key.complete', `this phone should show the whole key but tiles ${bare.join(', ')} have no single key class`);
    else if (d.tiles.length === CARD_COUNT) {
      const got = keyCounts(d.tiles.map((t) => t.key[0]));
      const want = expectedKeyCounts(g.startingTeam);
      if (!same(got, { red: want.red, blue: want.blue, neutral: want.neutral, assassin: want.assassin, other: 0 })) add('counts.key', `tile key classes are ${show(got)}, expected 9 for ${g.startingTeam}, 8 for the other, 6 neutral, 1 assassin`);
    }
  }

  // Board classes.
  const has = (c) => d.boardClasses.includes(c);
  if (has('spy') !== spy) add('dom.board', `.board ${has('spy') ? 'has' : 'lacks'} .spy but this phone is ${me ? me.role || 'watching' : 'not in the room'}`);
  if (has('over') !== over) add('dom.board', `.board ${has('over') ? 'has' : 'lacks'} .over in phase ${g.phase}`);
  if (has('can-guess') !== canGuess(s)) add('dom.board', `.board ${has('can-guess') ? 'has' : 'lacks'} .can-guess but canGuess is ${canGuess(s)}`);

  // Scorebar.
  for (const t of TEAMS) {
    if (d.score[t] !== g.remaining[t]) add('counts.scorebar', `scorebar shows ${d.score[t]} ${TEAM_NAME[t]} left, remaining.${t} is ${g.remaining[t]}`);
  }
  const wantActive = over ? null : g.turn;
  if (d.active !== wantActive || d.activeCount !== (wantActive ? 1 : 0)) add('dom.turn', `active score is ${show(d.active)} (${d.activeCount} active), expected ${show(wantActive)}`);
  for (const t of TEAMS) {
    const on = s.dom.appClasses.includes(`turn-${t}`);
    if (on !== (wantActive === t)) add('dom.turn', `#app ${on ? 'has' : 'lacks'} .turn-${t} in phase ${g.phase}, turn ${g.turn}`);
  }
  if (g.phase === 'guess' && g.clue) {
    const num = g.clue.number === -1 ? '∞' : String(g.clue.number);
    if (d.clueWord !== g.clue.word || d.clueNum !== num) add('dom.status', `status shows clue ${show(d.clueWord)} ${show(d.clueNum)}, expected ${show(g.clue.word)} ${show(num)}`);
  } else if (d.clueWord != null) {
    add('dom.status', `status shows a clue ${show(d.clueWord)} in phase ${g.phase}`);
  }
  if (over && !(d.status || '').startsWith(`${TEAM_NAME[g.winner]} wins`)) add('dom.status', `status shows ${show(d.status)}, expected "${TEAM_NAME[g.winner]} wins!"`);

  // Controls.
  const activeSpy = g.phase === 'clue' && spy && me.team === g.turn;
  if (!!d.clueForm !== activeSpy) add('controls.clueForm', `clue form ${d.clueForm ? 'shown' : 'not shown'} on ${me ? `${me.team || '-'} ${me.role || 'watcher'}` : 'a stranger'} in phase ${g.phase}, turn ${g.turn}`);
  if (d.clueForm) {
    if (!same(d.clueForm.nums, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, -1])) add('controls.clueForm', `number buttons are ${show(d.clueForm.nums)}`);
    if (!same(d.clueForm.on, [s.ui.clueNumber])) add('controls.clueForm', `number buttons lit: ${show(d.clueForm.on)}, ui.clueNumber is ${s.ui.clueNumber}`);
  }
  const guesser = canGuess(s);
  if ((d.guessPanel != null) !== guesser) add('controls.guessPanel', `guess panel ${d.guessPanel != null ? 'shown' : 'not shown'} on ${me ? `${me.team || '-'} ${me.role || 'watcher'}` : 'a stranger'} in phase ${g.phase}, turn ${g.turn}`);
  if (!!d.endTurn !== guesser) add('controls.endTurn', `End turn ${d.endTurn ? 'present' : 'absent'} but this phone ${guesser ? 'is' : 'is not'} an active guesser`);
  if (d.endTurn && d.endTurn.disabled !== (g.guessesMade === 0)) add('controls.endTurn', `End turn is ${d.endTurn.disabled ? 'disabled' : 'enabled'} with ${g.guessesMade} guesses made`);
  if (d.guessPanel != null) {
    const left = g.guessesLeft === -1 ? 'Unlimited guesses' : `${g.guessesLeft} guess${g.guessesLeft === 1 ? '' : 'es'} left`;
    if (!d.guessPanel.includes(left)) add('controls.guessPanel', `guess panel says ${show(d.guessPanel)}, expected it to include "${left}"`);
  }
  if (over) {
    if (!d.over || !d.over.again || !d.over.toLobby) add('controls.over', `game over but Play again / Switch teams are missing (${show(d.over)})`);
    else {
      const why = g.winReason === 'assassin' ? `${TEAM_NAME[other(g.winner)]} found the assassin.` : `${TEAM_NAME[g.winner]} found all their pictures.`;
      if (d.over.text !== why) add('controls.over', `over panel says ${show(d.over.text)}, expected ${show(why)}`);
    }
    if (d.clueForm || d.guessPanel != null || d.endTurn) add('controls.over', 'game over but a clue form, guess panel or End turn button is still shown');
  } else if (d.over) {
    add('controls.over', `over panel shown in phase ${g.phase}`);
  }
  if (!over && !activeSpy && !guesser && !d.wait) add('controls.guessPanel', 'this phone has nothing to do but shows no waiting message');

  // Zoom sheet.
  const z = s.dom.zoom;
  if ((s.ui.selected != null) !== !!z) add('dom.zoom', `ui.selected is ${show(s.ui.selected)} but the zoom sheet is ${z ? 'open' : 'closed'}`);
  if (z && s.ui.selected != null && g.cards[s.ui.selected]) {
    const c = g.cards[s.ui.selected];
    if (z.img !== c.image && z.img !== toLarge(c.image)) add('dom.zoom', `zoom sheet shows ${z.img} for card ${s.ui.selected} (${c.image})`);
    const mayKnow = c.revealed || key;
    if (!mayKnow && (z.key.length || z.tag)) add('secrecy.zoom', `zoom sheet for unrevealed card ${s.ui.selected} shows key ${show(z.key)} / tag ${show(z.tag)}`);
    if (mayKnow) {
      const tag = `${KEY_LABEL[c.team]}${c.revealed ? ' (revealed)' : ''}`;
      if (!same(z.key, [c.team]) || z.tag !== tag) add('dom.zoom', `zoom sheet for card ${s.ui.selected} shows key ${show(z.key)} / tag ${show(z.tag)}, expected ${c.team} / "${tag}"`);
    }
    const guessable = guesser && !c.revealed;
    if ((z.guess != null) !== guessable) add('controls.zoomGuess', `zoom sheet ${z.guess != null ? 'offers' : 'does not offer'} Guess for card ${s.ui.selected} (revealed=${c.revealed}) but this phone ${guesser ? 'is' : 'is not'} an active guesser`);
    if (z.guess != null && z.guess !== s.ui.selected) add('controls.zoomGuess', `Guess button is for card ${z.guess} but card ${s.ui.selected} is open`);
  }

  // Full-screen viewer.
  const v = s.dom.viewer;
  if (v) {
    const i = g.cards.findIndex((c) => v.img === c.image || v.img === toLarge(c.image));
    if (i < 0) add('secrecy.viewer', `viewer shows ${v.img}, which is not on the board`);
    else {
      const c = g.cards[i];
      const mayKnow = c.revealed || key;
      const tagShown = !v.tagHidden && !!v.tag;
      if (!mayKnow && (v.key.length || tagShown)) add('secrecy.viewer', `viewer for unrevealed card ${i} shows key ${show(v.key)} / tag ${show(v.tag)}`);
      if (mayKnow && !same(v.key, [c.team])) add('secrecy.viewer', `viewer for card ${i} shows key ${show(v.key)}, expected ${c.team}`);
    }
  }

  // Menu sheet.
  const m = s.dom.menu;
  if (!!m !== !!s.ui.showMenu) add('dom.menu', `ui.showMenu is ${s.ui.showMenu} but the menu sheet is ${m ? 'open' : 'closed'}`);
  if (m) {
    const want = room.players.map((p) => `${personLabel(p, room.you)} ${p.role || 'watching'}`);
    if (!same(m.players.map((p) => p.text), want)) add('dom.menu', `menu lists ${show(m.players.map((p) => p.text))}, expected ${show(want)}`);
    const log = (g.log || []).slice().reverse();
    const wantLog = log.map((e) => ({ team: e.clue.team, word: e.clue.word, num: e.clue.number === -1 ? '∞' : String(e.clue.number), dots: e.guesses }));
    if (!same(m.log, wantLog)) add('dom.menu', `menu clue log is ${show(m.log)}, expected ${show(wantLog)}`);
    const watcher = (!me || !me.team) && !over;
    const wantSit = watcher ? ['red:guesser', 'blue:guesser'] : [];
    if (!same(m.sit, wantSit)) add('dom.menu', `menu join buttons are ${show(m.sit)}, expected ${show(wantSit)}`);
  }
}

/**
 * All hard checks on settled snapshots.
 *
 * ctx:
 *   history           Map kept by the caller across checks (monotonic checks)
 *   unexpectedErrors  [{ phone, kind, text }] collected and not declared
 *   skip              ids or id prefixes to leave out
 */
function violations(snaps, ctx = {}) {
  const out = [];
  const history = ctx.history || new Map();
  const booted = snaps.filter((s) => s.booted);

  for (const e of ctx.unexpectedErrors || []) {
    out.push({ id: 'hygiene.errors', phone: e.phone, message: `${e.kind}: ${e.text}` });
  }

  for (const s of booted) {
    const add = (id, message) => out.push({ id, phone: s.name, message });
    if (!inRoom(s)) {
      if (s.screen !== 'home') add('dom.screen', `not in a room but the screen is "${s.screen}"`);
      continue;
    }
    const g = s.ui.room.game;
    const wantScreen = g ? 'game' : 'lobby';
    if (s.screen !== wantScreen) add('dom.screen', `screen is "${s.screen}" but the state calls for "${wantScreen}"`);
    checkJSON(s, add);
    if (g) checkGameDOM(s, add);
    else {
      checkLobbyDOM(s, add);
      if (s.dom.zoom) add('dom.zoom', 'zoom sheet open in the lobby');
      if (s.dom.menu) add('dom.menu', 'menu sheet open in the lobby');
      if (s.dom.viewer) add('secrecy.viewer', 'full-screen viewer open in the lobby');
    }
  }

  for (const [code, group] of groupByRoom(booted)) {
    const ref = group[0];
    const room = ref.ui.room;
    const add = (id, message, s = null) => out.push({ id, phone: s ? s.name : `room ${code}`, message });

    const phoneIds = new Set(group.map((s) => s.ui.room.you));
    const ghosts = room.players.filter((p) => !phoneIds.has(p.id));
    if (ghosts.length) add('roster.ghosts', `the room lists ${room.players.length} players but only ${group.length} phones are in it; extra: ${ghosts.map((p) => `${p.name} (${p.team || '-'}/${p.role || 'watching'}, ${p.connected ? 'connected' : 'away'})`).join(', ')}`);

    const g = room.game;
    if (g) {
      const forms = group.filter((s) => s.dom.game && s.dom.game.clueForm);
      const activeSpy = group.filter((s) => { const me = meOf(s); return g.phase === 'clue' && me && me.role === 'spymaster' && me.team === g.turn; });
      if (forms.length !== activeSpy.length || forms.length > 1) {
        add('controls.clueForm', `phase ${g.phase}, turn ${g.turn}: ${forms.length} phone(s) show the clue form (${forms.map((s) => s.name).join(', ') || 'none'}), expected ${activeSpy.length} (${activeSpy.map((s) => s.name).join(', ') || 'none'})`);
      }
      const panels = group.filter((s) => s.dom.game && s.dom.game.guessPanel != null).map((s) => s.name);
      const activeGuessers = group.filter((s) => canGuess(s)).map((s) => s.name);
      if (!same(panels, activeGuessers)) add('controls.guessPanel', `phase ${g.phase}, turn ${g.turn}: guess panel on [${panels.join(', ')}], expected exactly the active guessers [${activeGuessers.join(', ')}]`);
      if (g.phase === 'over') {
        const missing = group.filter((s) => !(s.dom.game && s.dom.game.over && s.dom.game.over.again)).map((s) => s.name);
        if (missing.length) add('controls.over', `game over but no Play again on ${missing.join(', ')}`);
      }
    }

    // Monotonic within one game. A new deal has different pictures.
    const id = g ? g.cards.map((c) => c.image).join('|') : null;
    const prev = history.get(code);
    if (g && prev && prev.id === id) {
      const lost = prev.revealed.filter((i) => !g.cards[i].revealed);
      if (lost.length) add('monotonic.revealed', `cards ${lost.join(', ')} were revealed before and are not now`);
      const log = g.log || [];
      if (log.length < prev.log.length) add('monotonic.log', `the clue log shrank from ${prev.log.length} to ${log.length} entries`);
      prev.log.forEach((e, i) => {
        const now = log[i];
        if (!now) return;
        if (!same(now.clue, e.clue)) add('monotonic.log', `log entry ${i} changed from ${show(e.clue)} to ${show(now.clue)}`);
        else if (!same(now.guesses.slice(0, e.guesses.length), e.guesses)) add('monotonic.log', `log entry ${i} guesses changed from ${show(e.guesses)} to ${show(now.guesses)}`);
      });
    }
    history.set(code, g ? {
      id,
      revealed: g.cards.map((c, i) => (c.revealed ? i : -1)).filter((i) => i >= 0),
      log: JSON.parse(JSON.stringify(g.log || [])),
    } : null);
  }

  return applySkip(out, ctx.skip);
}

function applySkip(list, skip) {
  if (!skip || !skip.length) return list;
  return list.filter((v) => !skip.some((p) => v.id === p || v.id.startsWith(`${p}.`)));
}

function format(list, heading) {
  const lines = list.map((v) => `  [${v.id}] ${v.phone}: ${v.message}`);
  return `${heading}\n${lines.join('\n')}`;
}

module.exports = {
  INVARIANTS, TEAMS, CARD_COUNT, KEY_COUNTS, TEAM_NAME, KEY_LABEL,
  other, inRoom, meOf, seesKey, canGuess, publicView, groupByRoom,
  settleProblems, violations, applySkip, format,
};
