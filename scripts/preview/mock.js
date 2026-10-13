// Goat Pic preview: a stand-in for the Go server so the real app (web/app.js
// and web/style.css) runs as a single static page with a made-up game. It
// answers the app's /api/rooms calls and its EventSource from an in-page
// copy of the rules in game.go, and adds a small panel to switch between the
// spymaster's and a guesser's view. Built into one page by
// scripts/build_preview.py; nothing here ships with the game.
'use strict';
(() => {
  const CODE = 'DEMO';
  const YOU = 'p-you';
  const COUNT = 24, FIRST = 9, SECOND = 8, BYSTANDERS = 6, UNLIMITED = -1;
  const other = (t) => (t === 'red' ? 'blue' : 'red');

  // Card pictures arrive as data: URIs; short blob: URLs keep re-renders cheap.
  const images = (window.PREVIEW_IMAGES || []).map((d) => {
    const [head, b64] = d.split(',');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: head.slice(5, head.indexOf(';')) }));
  });

  const shuffle = (a) => {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  // ---- Seats: you plus three pretend players ----
  const seat = { team: 'red', role: 'spymaster', follow: true };
  const BOTS = ['Ann', 'Bob', 'Cat'];

  function players(g) {
    const team = seat.follow && g && g.phase !== 'over' ? g.turn : seat.team;
    const seats = [['red', 'spymaster'], ['red', 'guesser'], ['blue', 'spymaster'], ['blue', 'guesser']]
      .filter(([t, r]) => !(t === team && r === seat.role));
    return [
      { id: YOU, name: 'Me', team, role: seat.role, connected: true },
      ...seats.map(([t, r], i) => ({ id: `p-${i}`, name: BOTS[i], team: t, role: r, connected: true })),
    ];
  }

  // ---- Rules: a copy of game.go ----
  let game = null;

  function newGame() {
    const start = Math.random() < 0.5 ? 'red' : 'blue';
    const teams = shuffle([
      ...Array(FIRST).fill(start), ...Array(SECOND).fill(other(start)),
      ...Array(BYSTANDERS).fill('neutral'), 'assassin',
    ]);
    const pics = shuffle(images.slice()).slice(0, COUNT);
    return {
      cards: teams.map((team, i) => ({ image: pics[i % pics.length], team, revealed: false, revealedBy: '' })),
      startingTeam: start, turn: start, phase: 'clue', clue: null,
      guessesLeft: 0, guessesMade: 0, winner: '', winReason: '', log: [],
    };
  }
  const remaining = (g, t) => g.cards.filter((c) => c.team === t && !c.revealed).length;
  function passTurn(g) { Object.assign(g, { turn: other(g.turn), phase: 'clue', clue: null, guessesLeft: 0, guessesMade: 0 }); }
  function finish(g, winner, reason) { Object.assign(g, { winner, winReason: reason, phase: 'over', clue: null }); }

  function giveClue(g, team, word, number) {
    if (g.phase === 'over') throw new Error('the game is over');
    if (team !== g.turn) throw new Error("it is not your team's turn");
    if (g.phase !== 'clue') throw new Error("that can't be done right now");
    word = String(word || '').trim();
    if (!word || /\s/.test(word) || [...word].length > 40) throw new Error('a clue must be a single word');
    if (number !== UNLIMITED && !(number >= 0 && number <= 9)) throw new Error('the clue number must be 0 to 9, or unlimited');
    g.clue = { team, word, number };
    g.phase = 'guess';
    g.guessesMade = 0;
    g.guessesLeft = number === UNLIMITED || number === 0 ? UNLIMITED : number + 1;
    g.log.push({ clue: { ...g.clue }, guesses: [] });
  }

  function guess(g, team, idx) {
    if (g.phase === 'over') throw new Error('the game is over');
    if (team !== g.turn) throw new Error("it is not your team's turn");
    if (g.phase !== 'guess') throw new Error("that can't be done right now");
    const card = g.cards[idx];
    if (!card) throw new Error('no such card');
    if (card.revealed) throw new Error('that picture is already revealed');
    card.revealed = true;
    card.revealedBy = team;
    g.guessesMade++;
    if (g.log.length) g.log[g.log.length - 1].guesses.push(card.team);
    if (card.team === 'assassin') finish(g, other(team), 'assassin');
    else if (remaining(g, 'red') === 0) finish(g, 'red', 'agents');
    else if (remaining(g, 'blue') === 0) finish(g, 'blue', 'agents');
    else if (card.team !== team) passTurn(g);
    else if (g.guessesLeft !== UNLIMITED && --g.guessesLeft === 0) passTurn(g);
  }

  function endTurn(g, team) {
    if (g.phase === 'over') throw new Error('the game is over');
    if (team !== g.turn) throw new Error("it is not your team's turn");
    if (g.phase !== 'guess') throw new Error("that can't be done right now");
    passTurn(g);
  }

  // A game already under way: two clues given, a few pictures revealed,
  // and the starting team about to give its next clue.
  function sampleGame() {
    const g = newGame();
    const pick = (team) => g.cards.findIndex((c) => c.team === team && !c.revealed);
    const a = g.turn, b = other(a);
    giveClue(g, a, 'monster', 2);
    guess(g, a, pick(a));
    guess(g, a, pick(a));
    endTurn(g, a);
    giveClue(g, b, 'night', 2);
    guess(g, b, pick(b));
    guess(g, b, pick('neutral'));
    return g;
  }

  // ---- What the server would send ----
  function view() {
    const g = game;
    const v = { code: CODE, you: YOU, players: players(g), ready: true };
    if (g) {
      const seeKey = seat.role === 'spymaster' || g.phase === 'over';
      v.game = {
        cards: g.cards.map((c) => ({
          image: c.image, revealed: c.revealed,
          ...(c.revealedBy ? { revealedBy: c.revealedBy } : {}),
          ...(seeKey || c.revealed ? { team: c.team } : {}),
        })),
        startingTeam: g.startingTeam, turn: g.turn, phase: g.phase,
        ...(g.clue ? { clue: { ...g.clue } } : {}),
        guessesLeft: g.guessesLeft, guessesMade: g.guessesMade,
        remaining: { red: remaining(g, 'red'), blue: remaining(g, 'blue') },
        ...(g.winner ? { winner: g.winner, winReason: g.winReason } : {}),
        log: g.log.map((e) => ({ clue: { ...e.clue }, guesses: e.guesses.slice() })),
      };
    }
    return JSON.parse(JSON.stringify(v));
  }

  const streams = new Set();
  function broadcast() {
    const data = JSON.stringify(view());
    setTimeout(() => streams.forEach((s) => s.onmessage && s.onmessage({ data })), 0);
    renderPanel();
    scheduleBot();
  }

  // The pretend players take their turns, so whichever seat you pick the
  // game keeps moving: their spymaster gives a clue when it is not yours to
  // give, and their guessers guess when it is not yours to guess.
  const CLUES = ['night', 'beast', 'gold', 'fire', 'wings', 'king', 'sea', 'saint', 'horns', 'feast'];
  let botTimer = null;
  function scheduleBot() {
    clearTimeout(botTimer);
    const g = game;
    if (!g || g.phase === 'over') return;
    const me = myTeam() === g.turn ? seat.role : null;
    if (g.phase === 'clue' && me === 'spymaster') return;
    if (g.phase === 'guess' && me === 'guesser') return;
    botTimer = setTimeout(botMove, 1500);
  }
  function botMove() {
    const g = game;
    if (!g || g.phase === 'over') return;
    const t = g.turn;
    if (g.phase === 'clue') {
      giveClue(g, t, CLUES[Math.floor(Math.random() * CLUES.length)], Math.min(2, remaining(g, t)));
    } else if (g.guessesMade >= (g.clue.number === 0 || g.clue.number === UNLIMITED ? 2 : g.clue.number)) {
      endTurn(g, t);
    } else {
      const hidden = g.cards.map((c, i) => i).filter((i) => !g.cards[i].revealed);
      const ours = hidden.filter((i) => g.cards[i].team === t);
      const pool = Math.random() < 0.75 && ours.length ? ours : hidden.filter((i) => g.cards[i].team !== 'assassin');
      guess(g, t, pool[Math.floor(Math.random() * pool.length)]);
    }
    broadcast();
  }

  function myTeam() { return players(game)[0].team; }

  function handle(action, body) {
    switch (action) {
      case '': return { code: CODE };
      case 'join': return view();
      case 'sit': seat.team = body.team; seat.role = body.role; seat.follow = false; break;
      case 'start': game = newGame(); break;
      case 'lobby': game = null; break;
      case 'clue':
        if (seat.role !== 'spymaster') throw new Error('only the spymaster can do that');
        giveClue(game, myTeam(), body.word, body.number);
        break;
      case 'guess':
        if (seat.role !== 'guesser') throw new Error('only guessers can do that');
        guess(game, myTeam(), body.index);
        break;
      case 'end-turn':
        if (seat.role !== 'guesser') throw new Error('only guessers can do that');
        endTurn(game, myTeam());
        break;
      case 'leave': return {};
      default: throw new Error('unknown action');
    }
    broadcast();
    return view();
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, opts = {}) => {
    const m = String(url).match(/^\/api\/rooms(?:\/[A-Za-z]{4}\/([a-z-]+))?$/);
    if (!m) return realFetch(url, opts);
    let body = {};
    try { body = JSON.parse(opts.body || '{}'); } catch { /* empty */ }
    try {
      const out = handle(m[1] || '', body);
      return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
  };

  class PreviewEvents {
    constructor() {
      this.readyState = 1;
      this.onmessage = null; this.onerror = null; this.onopen = null;
      streams.add(this);
      setTimeout(() => { this.onopen && this.onopen(); this.onmessage && this.onmessage({ data: JSON.stringify(view()) }); }, 0);
    }
    addEventListener() {}
    close() { this.readyState = 2; streams.delete(this); }
  }
  PreviewEvents.CONNECTING = 0; PreviewEvents.OPEN = 1; PreviewEvents.CLOSED = 2;
  window.EventSource = PreviewEvents;

  // The page has no /r/CODE route to come back to, so keep the URL as is.
  const realReplace = history.replaceState.bind(history);
  history.replaceState = (s, t) => realReplace(s, t);
  // No service worker: there is no /sw.js to install.
  try { Object.defineProperty(navigator, 'serviceWorker', { value: { register: () => Promise.resolve() } }); } catch { /* fine */ }

  // ---- Preview panel ----
  // A bar across the top, above the app, so it never covers the game.
  const panel = document.createElement('div');
  panel.id = 'preview-panel';
  panel.innerHTML = `<style>
    body { padding-top: 40px; }
    #app { min-height: calc(100dvh - 40px) !important; }
    #app[data-screen="game"] { height: calc(100dvh - 40px) !important; }
    html, body { height: auto; }
    .viewer { top: calc(40px + env(safe-area-inset-top, 0px)) !important; }
    #preview-panel { position: fixed; top: env(safe-area-inset-top, 0px); left: 0; right: 0; height: 40px; z-index: 50;
      display: flex; gap: 4px; align-items: center; justify-content: center; padding: 0 6px;
      background: #2e3449; border-bottom: 1px solid #3d4560; font: 600 12px system-ui, sans-serif; }
    #preview-panel b { color: #a7adc2; font-weight: 600; margin-right: 2px; }
    #preview-panel button { appearance: none; border: 0; border-radius: 999px; padding: 7px 10px; background: transparent;
      color: #f3f1ea; font: inherit; cursor: pointer; white-space: nowrap; }
    #preview-panel button.on { background: #f3f1ea; color: #000; }
  </style>
  <b>Preview</b><button data-p="spymaster">Spymaster</button><button data-p="guesser">Guesser</button>
  <button data-p="team" title="Your team">Team</button><button data-p="new">New game</button>`;
  function renderPanel() {
    panel.querySelector('[data-p="spymaster"]').classList.toggle('on', seat.role === 'spymaster');
    panel.querySelector('[data-p="guesser"]').classList.toggle('on', seat.role === 'guesser');
    panel.querySelector('[data-p="team"]').textContent =
      seat.follow ? 'Team: turn' : seat.team === 'red' ? 'Team: ●' : 'Team: ■';
  }
  panel.addEventListener('click', (e) => {
    const p = e.target.closest('button')?.dataset.p;
    if (!p) return;
    e.stopPropagation();
    if (p === 'spymaster' || p === 'guesser') seat.role = p;
    else if (p === 'team') {
      // turn → ● → ■ → turn
      if (seat.follow) { seat.follow = false; seat.team = 'red'; }
      else if (seat.team === 'red') seat.team = 'blue';
      else seat.follow = true;
    } else if (p === 'new') game = newGame();
    broadcast();
  });

  game = sampleGame();
  document.addEventListener('DOMContentLoaded', () => {
    document.body.appendChild(panel);
    renderPanel();
  });
  // Once the app has booted, walk straight into the game.
  window.addEventListener('load', () => {
    if (typeof joinRoom === 'function') joinRoom(CODE, 'Me');
  });
})();
