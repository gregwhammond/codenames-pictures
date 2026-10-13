'use strict';
// A bot that plays through the phones. It reads the key from a spymaster's
// phone, so it can aim every guess and steer a game to a chosen ending. Every
// move is made by tapping on the right phone, is followed by table.check(),
// and is compared with what the rules say should have happened.
//
// Randomness comes from table.rng (seeded; the seed is printed when a test
// fails and can be replayed with E2E_SEED).

const { other } = require('./invariants');

const WORDS = ['river', 'castle', 'winter', 'shadow', 'garden', 'thunder', 'mirror', 'voyage', 'ember', 'harvest', 'lantern', 'orbit', 'feather', 'canyon', 'riddle', 'meadow'];

/** What the rules say a game looks like after a clue. Pure. */
function afterClue(g, word, number) {
  return {
    turn: g.turn,
    phase: 'guess',
    clue: { team: g.turn, word, number },
    guessesLeft: number === -1 || number === 0 ? -1 : number + 1,
    guessesMade: 0,
    remaining: { ...g.remaining },
    winner: '',
    winReason: '',
  };
}

/** What the rules say a game looks like after the active team guesses card `i`. Pure. */
function afterGuess(g, key, i) {
  const team = g.turn;
  const card = key[i];
  const remaining = { ...g.remaining };
  if (card === 'red' || card === 'blue') remaining[card] -= 1;
  const next = { turn: team, phase: 'guess', clue: g.clue, guessesLeft: g.guessesLeft, guessesMade: g.guessesMade + 1, remaining, winner: '', winReason: '' };
  const pass = () => Object.assign(next, { turn: other(team), phase: 'clue', clue: null, guessesLeft: 0, guessesMade: 0 });
  const finish = (winner, why) => Object.assign(next, { phase: 'over', clue: null, winner, winReason: why });
  if (card === 'assassin') finish(other(team), 'assassin');
  else if (remaining.red === 0) finish('red', 'agents');
  else if (remaining.blue === 0) finish('blue', 'agents');
  else if (card !== team) pass();
  else if (next.guessesLeft !== -1) {
    next.guessesLeft -= 1;
    if (next.guessesLeft === 0) pass();
  }
  return next;
}

/** What the rules say a game looks like after End turn. Pure. */
function afterEndTurn(g) {
  return { turn: other(g.turn), phase: 'clue', clue: null, guessesLeft: 0, guessesMade: 0, remaining: { ...g.remaining }, winner: '', winReason: '' };
}

/** JSON with object keys sorted, so key order never matters in a comparison. */
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

function compare(what, want, g, seed) {
  const got = {
    turn: g.turn, phase: g.phase, clue: g.clue || null, guessesLeft: g.guessesLeft, guessesMade: g.guessesMade,
    remaining: { red: g.remaining.red, blue: g.remaining.blue }, winner: g.winner || '', winReason: g.winReason || '',
  };
  const diffs = Object.keys(want).filter((k) => canon(want[k]) !== canon(got[k]));
  // After the game ends the server keeps the last turn's counters; they are not part of the rules.
  const ignore = want.phase === 'over' ? ['guessesLeft', 'guessesMade', 'turn'] : [];
  const real = diffs.filter((k) => !ignore.includes(k));
  if (real.length) {
    throw new Error(`[rules] ${what}: the game did not move as the rules say (seed ${seed}):\n` +
      real.map((k) => `  ${k}: expected ${JSON.stringify(want[k])}, got ${JSON.stringify(got[k])}`).join('\n'));
  }
}

class Bot {
  /**
   * @param {import('./table').Table} table
   * @param {{ rng?: Function, log?: boolean }} [options] rng defaults to table.rng
   */
  constructor(table, { rng, log = false } = {}) {
    this.table = table;
    this.rng = rng || table.rng;
    this.verbose = log || process.env.E2E_BOT_LOG === '1';
    /** Every move made, as text. Attached to the report by attachLog(). */
    this.moves = [];
    this._word = 0;
  }

  _note(text) {
    this.moves.push(text);
    if (this.verbose) console.log(`[bot ${this.table.seed}] ${text}`);
  }

  /** Attach the move list to the test report (call in a finally block or afterEach). */
  async attachLog() {
    await this.table.testInfo.attach('bot-moves.txt', { body: `seed ${this.table.seed}\n${this.moves.join('\n')}\n`, contentType: 'text/plain' }).catch(() => {});
  }

  /**
   * Where the game stands and who can act:
   * { room, game, key, turn, phase, over, roles, spymaster, guessers, hidden }
   *   key        24 teams (read from a spymaster's phone, or from anyone once the game is over)
   *   spymaster  the active team's spymaster phone (or null)
   *   guessers   the active team's guesser phones
   *   hidden     { red: [i…], blue: […], neutral: […], assassin: […] } unrevealed card indexes by team
   */
  async look() {
    const roles = await this.table.roles();
    const any = [roles.red.spymaster, roles.blue.spymaster, ...roles.red.guessers, ...roles.blue.guessers, ...roles.watchers].filter(Boolean);
    if (!any.length) throw new Error('bot: no phone is in a room');
    const room = await any[0].state();
    const game = room.game;
    if (!game) throw new Error('bot: there is no game in progress');
    const keySource = game.phase === 'over' ? any[0] : roles.red.spymaster || roles.blue.spymaster;
    if (!keySource) throw new Error('bot: no spymaster phone at the table to read the key from');
    const key = await keySource.key();
    const hidden = { red: [], blue: [], neutral: [], assassin: [] };
    game.cards.forEach((c, i) => { if (!c.revealed) hidden[key[i]].push(i); });
    return {
      room, game, key, roles, hidden,
      turn: game.turn, phase: game.phase, over: game.phase === 'over',
      spymaster: roles[game.turn] ? roles[game.turn].spymaster : null,
      guessers: roles[game.turn] ? roles[game.turn].guessers : [],
    };
  }

  nextWord() {
    const w = WORDS[this._word % WORDS.length];
    this._word += 1;
    return w;
  }

  /**
   * The active spymaster gives a clue. number: 0..9, or -1 for ∞.
   * Returns the game after the clue.
   */
  async clue(number, word = this.nextWord()) {
    const at = await this.look();
    if (at.phase !== 'clue') throw new Error(`bot.clue: phase is ${at.phase}, not clue`);
    if (!at.spymaster) throw new Error(`bot.clue: ${at.turn} has no spymaster phone at the table`);
    const what = `${at.spymaster.name} (${at.turn} spymaster) gives the clue "${word}" ${number === -1 ? '∞' : number}`;
    this._note(what);
    await at.spymaster.giveClue(word, number);
    const { game } = await this.table.check(`after: ${what}`);
    compare(what, afterClue(at.game, word, number), game, this.table.seed);
    return game;
  }

  /**
   * An active guesser guesses one card.
   *   target  a card index, or a kind relative to the team whose turn it is:
   *           'own' | 'opponent' | 'neutral' | 'assassin'
   *   by      which phone taps (default: a random guesser of the active team)
   * Returns { index, team, game } with the game after the guess.
   */
  async guess(target, { by } = {}) {
    const at = await this.look();
    if (at.phase !== 'guess') throw new Error(`bot.guess: phase is ${at.phase}, not guess`);
    if (!at.guessers.length) throw new Error(`bot.guess: ${at.turn} has no guesser phone at the table`);
    let index = target;
    if (typeof target === 'string') {
      const team = { own: at.turn, opponent: other(at.turn), neutral: 'neutral', assassin: 'assassin' }[target];
      if (!team) throw new Error(`bot.guess: unknown target "${target}"`);
      if (!at.hidden[team].length) throw new Error(`bot.guess: no unrevealed ${target} (${team}) card left`);
      index = this.rng.pick(at.hidden[team]);
    }
    const phone = by || this.rng.pick(at.guessers);
    const what = `${phone.name} (${at.turn} guesser) guesses card ${index}, which is ${at.key[index]}`;
    this._note(what);
    const revealed = await phone.guess(index);
    if (revealed.team !== at.key[index]) throw new Error(`[rules] ${what}: the card was revealed as ${revealed.team} (seed ${this.table.seed})`);
    if (revealed.revealedBy !== at.turn) throw new Error(`[rules] ${what}: revealedBy is ${revealed.revealedBy}, expected ${at.turn} (seed ${this.table.seed})`);
    const { game } = await this.table.check(`after: ${what}`);
    compare(what, afterGuess(at.game, at.key, index), game, this.table.seed);
    return { index, team: at.key[index], game };
  }

  /** An active guesser taps End turn. Returns the game after it. */
  async endTurn({ by } = {}) {
    const at = await this.look();
    if (at.phase !== 'guess') throw new Error(`bot.endTurn: phase is ${at.phase}, not guess`);
    const phone = by || this.rng.pick(at.guessers);
    const what = `${phone.name} (${at.turn} guesser) ends the turn`;
    this._note(what);
    await phone.endTurn();
    const { game } = await this.table.check(`after: ${what}`);
    compare(what, afterEndTurn(at.game), game, this.table.seed);
    return game;
  }

  /**
   * One whole turn for the team to move: a clue, then the guesses, then End
   * turn if asked and still possible.
   *   number   clue number (0..9, -1 for ∞)
   *   guesses  list of targets for bot.guess()
   *   end      tap End turn afterwards if the turn is still this team's
   * Stops early if a guess passes the turn or ends the game. Returns the game.
   */
  async turn({ number = 1, guesses = ['own'], end = false, word } = {}) {
    let game = await this.clue(number, word);
    const team = game.turn;
    for (const target of guesses) {
      ({ game } = await this.guess(target));
      if (game.phase !== 'guess' || game.turn !== team) return game;
    }
    if (end && game.phase === 'guess' && game.turn === team) game = await this.endTurn();
    return game;
  }

  /**
   * A turn that changes nothing important for the team to move: it hits a
   * bystander if one is left, otherwise finds one own agent and ends the turn
   * (never its last one), otherwise gives the opponent a card.
   */
  async passingTurn() {
    const at = await this.look();
    if (at.hidden.neutral.length) return this.turn({ number: 1, guesses: ['neutral'] });
    if (at.game.remaining[at.turn] > 1) return this.turn({ number: 1, guesses: ['own'], end: true });
    return this.turn({ number: 1, guesses: ['opponent'] });
  }

  /**
   * Play until `winner` (default: the team to move) has found all its agents.
   * The winner's turns use random clue numbers including 0 and ∞; the other
   * team passes. Returns the final game.
   */
  async playToAgentsWin({ winner } = {}) {
    let at = await this.look();
    const team = winner || at.turn;
    for (let guard = 0; guard < 80 && !at.over; guard++) {
      if (at.turn !== team) {
        await this.passingTurn();
      } else {
        const left = at.game.remaining[team];
        const number = this.rng.pick([0, 1, 2, 3, -1]);
        const max = number === 0 || number === -1 ? Math.min(left, 4) : Math.min(left, number + 1);
        const count = this.rng.between(1, max);
        // End the turn only if the guesses will not use it up or win the game.
        await this.turn({ number, guesses: Array(count).fill('own'), end: true });
      }
      at = await this.look();
    }
    if (!at.over) throw new Error(`bot.playToAgentsWin: game not over after 80 turns (seed ${this.table.seed})`);
    return at.game;
  }

  /**
   * Play until `loser` (default: the team to move) hits the assassin, after
   * `warmup` ordinary turns. Returns the final game.
   */
  async playToAssassin({ loser, warmup = 0 } = {}) {
    let at = await this.look();
    const team = loser || at.turn;
    for (let i = 0; i < warmup && !at.over; i++) {
      await this.passingTurn();
      at = await this.look();
    }
    for (let guard = 0; guard < 10 && !at.over; guard++) {
      if (at.turn !== team) await this.passingTurn();
      else await this.turn({ number: this.rng.pick([1, 2, 0, -1]), guesses: ['assassin'] });
      at = await this.look();
    }
    if (!at.over) throw new Error(`bot.playToAssassin: game not over (seed ${this.table.seed})`);
    return at.game;
  }

  /**
   * Play until `winner` has one agent left and the OTHER team reveals it, so
   * `winner` wins on the opponent's guess. Default winner: the team that is
   * not to move. Returns the final game.
   */
  async playToOpponentLastAgent({ winner } = {}) {
    let at = await this.look();
    const team = winner || other(at.turn);
    for (let guard = 0; guard < 80 && !at.over; guard++) {
      const left = at.game.remaining[team];
      if (at.turn === team) {
        if (left > 1) {
          const count = this.rng.between(1, Math.min(left - 1, 4));
          await this.turn({ number: -1, guesses: Array(count).fill('own'), end: true });
        } else {
          await this.passingTurn();
        }
      } else if (left === 1) {
        await this.turn({ number: 1, guesses: ['opponent'] });
      } else {
        await this.passingTurn();
      }
      at = await this.look();
    }
    if (!at.over) throw new Error(`bot.playToOpponentLastAgent: game not over after 80 turns (seed ${this.table.seed})`);
    return at.game;
  }

  /**
   * Play random legal moves until the game ends (for soak runs).
   *   weights    chance of each kind of guess
   *   onMove     async (bot, n) => {} called after every move, e.g. to reload a phone now and then
   * Returns the final game.
   */
  async playRandomGame({ weights = { own: 0.62, neutral: 0.16, opponent: 0.16, assassin: 0.03, end: 0.03 }, onMove, maxMoves = 400 } = {}) {
    let moves = 0;
    const moved = async () => { moves += 1; if (onMove) await onMove(this, moves); };
    let at = await this.look();
    while (!at.over) {
      if (moves > maxMoves) throw new Error(`bot.playRandomGame: more than ${maxMoves} moves (seed ${this.table.seed})`);
      if (at.phase === 'clue') {
        await this.clue(this.rng.pick([0, 1, 1, 2, 2, 3, 4, 9, -1]));
      } else {
        const options = Object.entries(weights).filter(([kind]) => {
          if (kind === 'end') return at.game.guessesMade > 0;
          const team = { own: at.turn, opponent: other(at.turn), neutral: 'neutral', assassin: 'assassin' }[kind];
          return at.hidden[team].length > 0;
        });
        const total = options.reduce((n, [, w]) => n + w, 0);
        let roll = this.rng() * total;
        let kind = options[options.length - 1][0];
        for (const [k, w] of options) { roll -= w; if (roll < 0) { kind = k; break; } }
        if (kind === 'end') await this.endTurn(); else await this.guess(kind);
      }
      await moved();
      at = await this.look();
    }
    return at.game;
  }
}

module.exports = { Bot, WORDS, afterClue, afterGuess, afterEndTurn };
