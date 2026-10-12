'use strict';

// ---------- Local identity ----------

// Dev harness: "?dev=N" runs this frame as player N with its own storage, so
// four copies of the app can share one browser. Read once; the URL keeps it.
const DEV = ((new URLSearchParams(location.search).get('dev') || '').match(/^[1-9]$/) || [null])[0];
const STORE_PREFIX = DEV ? `cnp.dev${DEV}.` : 'cnp.';

const store = {
  get(key, fallback = '') {
    try { return localStorage.getItem(`${STORE_PREFIX}${key}`) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`${STORE_PREFIX}${key}`, value); } catch { /* private mode */ }
  },
};

function makeToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

let token = store.get('token');
if (!token) {
  token = makeToken();
  store.set('token', token);
}

// ---------- State ----------

const ui = {
  code: null,        // room code we're in
  room: null,        // latest RoomView from the server
  events: null,      // EventSource
  selected: null,    // card index open in the zoom sheet
  clueNumber: null, // number picked for the clue being written; none until the spymaster taps one
  showMenu: false,
  error: '',
  busy: false,
  lastNeedsMe: false,
};

const $app = document.getElementById('app');
const $modal = document.getElementById('modal');
const $viewer = document.getElementById('viewer');
const $toast = document.getElementById('toast');

const TEAM_NAME = { red: 'Circle', blue: 'Square' };
const TEAM_ICON = { red: '●', blue: '■' };
// What a picture is, shown on its tag when zoomed: an icon for each kind
// (the words stay for screen readers). Bystanders get a goat silhouette.
const GOAT_ICON = '<svg class="goat-icon" viewBox="0 0 32 28" aria-hidden="true"><path d="M8.2 5.2C7.6 2.4 9.6.4 12.6 1c-1.8.6-2.7 2.2-2.4 4.4zM7.4 4.6c1.6-.6 3.4 0 4 1.6l1.8 5.2-3.6.8-1-2.6c-1 .6-2.6 1-4.2.8-1.2-.2-1.6-1.2-.8-2zM10.6 6l3.8-.2-3 1.8zM5 10l1.6.2L5.4 13zM9.6 10.6c2.4-.6 10.4-1 16-.2 2 .4 2.8 2 2.6 4.2-.2 2.4-1.6 3.6-3.8 3.8l-11.8.2c-2-.2-3.2-1.6-3.4-3.6zM26.8 11c.8-1.4 2-2.2 3.2-2.2-.6 1-1.2 2-1.8 3.4zM10.6 17h2l.4 9.4h-1.8zM13.8 17.4h2l-.2 9h-1.8zM22.2 17.4h2l-.2 9h-1.8zM25 16.6h2l.4 9.8h-1.8z"/></svg>';
const KEY_ICON = { red: '●', blue: '■', neutral: GOAT_ICON, assassin: '☠ Dead goat' };
const KEY_NAME = { red: 'Circle agent', blue: 'Square agent', neutral: 'Bystander', assassin: 'Dead goat' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Zoom-size pictures live at /cards-large/ under the same file name.
const largeURL = (src) => String(src).replace(/^\/cards\//, '/cards-large/');
const largeFailed = new Set();
window.addEventListener('online', () => largeFailed.clear());

// Show the tile (already cached) straight away, then swap in the large
// picture once it has loaded. If it is missing, keep the tile.
function upgradeImage(img, tileSrc) {
  const big = largeURL(tileSrc);
  if (!img || big === tileSrc || largeFailed.has(big)) return;
  const pre = new Image();
  pre.decoding = 'async';
  pre.onload = () => { if (img.isConnected && img.getAttribute('src') === tileSrc) img.src = big; };
  // Remember only failures that look permanent (a 404 while online). A
  // dropped connection must not keep the picture at tile size all session.
  pre.onerror = () => {
    if (navigator.onLine !== false && !document.body.classList.contains('offline')) largeFailed.add(big);
  };
  pre.src = big;
}

function roomCodeFromURL() {
  const m = location.pathname.match(/^\/r\/([A-Za-z]{4})\/?$/);
  return m ? m[1].toUpperCase() : null;
}

function inviteURL(code) {
  return `${location.origin}/r/${code}`;
}

// ---------- Server calls ----------

async function api(path, body = {}) {
  const res = await fetch(`/api/rooms${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Something went wrong');
    err.status = res.status;
    throw err;
  }
  return data;
}

async function act(action, body) {
  if (ui.busy) return;
  ui.busy = true;
  try {
    const view = await api(`/${ui.code}/${action}`, body);
    if (view && view.code) setRoom(view);
  } catch (err) {
    if (err.status === 403) await rejoin();
    else toast(err.message);
  } finally {
    ui.busy = false;
  }
}

function toast(message) {
  $toast.textContent = message;
  $toast.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $toast.classList.remove('show'), 3000);
}

// ---------- Room lifecycle ----------

async function createRoom(name) {
  const { code } = await api('', {});
  await joinRoom(code, name);
}

async function joinRoom(code, name) {
  code = code.toUpperCase();
  store.set('name', name);
  const view = await api(`/${code}/join`, { name });
  ui.code = code;
  store.set('room', code);
  if (location.pathname !== `/r/${code}`) history.replaceState(null, '', `/r/${code}${location.search}`);
  setRoom(view);
  connect();
}

async function rejoin() {
  if (!ui.code) return;
  try {
    const view = await api(`/${ui.code}/join`, { name: store.get('name') || 'Player' });
    setRoom(view);
    connect();
  } catch (err) {
    if (err.status === 404) {
      leaveLocal('That game has ended. Start a new one!');
    }
  }
}

function connect() {
  if (ui.events) ui.events.close();
  const es = new EventSource(`/api/rooms/${ui.code}/events?token=${token}`);
  ui.events = es;
  es.onmessage = (e) => setRoom(JSON.parse(e.data));
  es.addEventListener('gone', () => { es.close(); rejoin(); });
  es.onerror = () => {
    document.body.classList.add('offline');
    // The browser retries by itself unless the server refused us outright.
    if (es.readyState === EventSource.CLOSED) setTimeout(() => ui.events === es && rejoin(), 1500);
  };
  es.onopen = () => {
    // Back in touch with the server: let failed large pictures try again.
    if (document.body.classList.contains('offline')) largeFailed.clear();
    document.body.classList.remove('offline');
  };
}

function leaveLocal(message) {
  if (ui.events) ui.events.close();
  Object.assign(ui, { code: null, room: null, events: null, selected: null, showMenu: false });
  closeViewer();
  store.set('room', '');
  history.replaceState(null, '', `/${location.search}`);
  render();
  if (message) toast(message);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && ui.code && (!ui.events || ui.events.readyState === EventSource.CLOSED)) {
    rejoin();
  }
  if (document.visibilityState === 'visible') keepAwake();
});

let wakeLock = null;
async function keepAwake() {
  const playing = ui.room?.game && ui.room.game.phase !== 'over';
  try {
    if (playing && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!playing && wakeLock) {
      await wakeLock.release();
    }
  } catch { /* not allowed right now */ }
}

// ---------- Derived state ----------

function me() {
  return ui.room?.players.find((p) => p.id === ui.room.you) ?? null;
}

function needsMe() {
  const g = ui.room?.game;
  const p = me();
  if (!g || !p || g.phase === 'over' || p.team !== g.turn) return false;
  return (g.phase === 'clue' && p.role === 'spymaster') || (g.phase === 'guess' && p.role === 'guesser');
}

function canGuess() {
  return needsMe() && me().role === 'guesser';
}

function setRoom(view) {
  const prev = ui.room?.game;
  ui.room = view;
  if (!view.game) ui.selected = null;
  // Start every new clue with no number picked.
  const g = view.game;
  if (g?.phase === 'clue' && (prev?.phase !== 'clue' || prev.turn !== g.turn)) ui.clueNumber = null;
  const nowNeedsMe = needsMe();
  if (nowNeedsMe && !ui.lastNeedsMe && navigator.vibrate) navigator.vibrate([80, 60, 80]);
  ui.lastNeedsMe = nowNeedsMe;
  keepAwake();
  render();
  if (DEV) postDevState();
}

// ---------- Rendering helpers ----------

// Only touch the DOM for a region when its markup actually changed, so inputs
// keep focus and pictures don't flash on every update.
function region(parent, key, html) {
  let el = parent.querySelector(`:scope > [data-region="${key}"]`);
  if (!el) {
    el = document.createElement('div');
    el.dataset.region = key;
    parent.appendChild(el);
  }
  if (el._html !== html) {
    el.innerHTML = html;
    el._html = html;
  }
  return el;
}

function layout(screen) {
  if ($app.dataset.screen !== screen) {
    $app.innerHTML = '';
    $app.dataset.screen = screen;
  }
}

function render() {
  if (!ui.code || !ui.room) renderHome();
  else if (!ui.room.game) renderLobby();
  else renderGame();
  renderModal();
  syncViewer();
}

// ---------- Home ----------

function renderHome() {
  layout('home');
  const code = roomCodeFromURL();
  const name = store.get('name');
  region($app, 'home', `
    <section class="home">
      <div class="logo" aria-hidden="true">${logoTiles()}</div>
      <h1>Goat <span>Pic</span></h1>
      <p class="tagline">Two teams. Twenty-four pictures. One-word clues.</p>
      <form id="home-form" class="card-panel" autocomplete="off">
        <label for="name">Your name</label>
        <input id="name" name="name" maxlength="20" value="${esc(name)}" placeholder="e.g. Greg" required>
        ${code ? `
          <button class="btn primary" name="go" value="join">Join game ${esc(code)}</button>
          <button class="btn link" type="button" id="forget-code">Start a different game</button>
        ` : `
          <button class="btn primary" name="go" value="create">Create a new game</button>
          <div class="or"><span>or join a friend</span></div>
          <div class="join-row">
            <input id="code" name="code" maxlength="4" placeholder="CODE" autocapitalize="characters" spellcheck="false" aria-label="Room code">
            <button class="btn" name="go" value="join">Join</button>
          </div>
        `}
        <p class="error">${esc(ui.error)}</p>
      </form>
      <details class="how card-panel">
        <summary>How to play</summary>
        ${howToPlay()}
      </details>
    </section>
  `);
}

function logoTiles() {
  return ['red', 'blue', 'neutral', 'blue', 'red', 'assassin', 'red', 'neutral', 'blue']
    .map((t) => `<i class="t-${t}"></i>`).join('');
}

function howToPlay() {
  return `
    <ol>
      <li>Split into <b>Circle</b> and <b>Square</b>. Each team has one <b>spymaster</b> and one or more <b>guessers</b>.</li>
      <li>Only spymasters see which pictures belong to which team.</li>
      <li>On your turn, your spymaster gives a <b>one-word clue</b> and a number: how many pictures it points to.</li>
      <li>Guessers tap pictures. A correct guess lets you keep going, up to one more than the number.</li>
      <li>Tap a picture to see it bigger. <b>Press and hold</b> (or right-click) to open it full screen and pinch to zoom into the details.</li>
      <li>Hit a white bystander or the other team's picture and your turn ends. Hit the <b>dead goat</b> and you lose instantly.</li>
      <li>The first team to find all their pictures wins. The team that goes first has 9, the other has 8.</li>
    </ol>`;
}

$app.addEventListener('submit', async (e) => {
  if (e.target.id === 'home-form') {
    e.preventDefault();
    const form = e.target;
    const name = form.name.value.trim();
    const go = e.submitter?.value || 'create';
    if (!name) return;
    const code = roomCodeFromURL() || form.code?.value.trim().toUpperCase();
    ui.error = '';
    try {
      if (go === 'join') {
        if (!code || code.length !== 4) throw new Error('Enter the 4-letter room code.');
        await joinRoom(code, name);
      } else {
        await createRoom(name);
      }
    } catch (err) {
      ui.error = err.status === 404 ? 'No game with that code. Check it and try again.' : err.message;
      renderHome();
    }
  }
  if (e.target.id === 'clue-form') {
    e.preventDefault();
    const word = e.target.word.value.trim();
    if (!word) return;
    if (/\s/.test(word)) { toast('Clues are a single word.'); return; }
    if (ui.clueNumber == null) { toast('Pick a number for your clue.'); return; }
    await act('clue', { word, number: ui.clueNumber });
  }
});

// ---------- Lobby ----------

function renderLobby() {
  layout('lobby');
  const room = ui.room;
  const p = me();
  const seat = (team, role) => room.players.filter((x) => x.team === team && x.role === role);
  const person = (x) => `<span class="person ${x.connected ? '' : 'away'} ${x.id === room.you ? 'you' : ''}">${esc(x.name)}${x.id === room.you ? ' (you)' : ''}</span>`;
  const slot = (team, role) => {
    const people = seat(team, role);
    const mine = p?.team === team && p?.role === role;
    const full = role === 'spymaster' && people.length > 0 && !mine;
    return `
      <button class="seat ${mine ? 'mine' : ''}" data-sit="${team}:${role}" ${full ? 'disabled' : ''}>
        <span class="seat-role">${role === 'spymaster' ? 'Spymaster' : 'Guessers'}</span>
        <span class="seat-people">${people.map(person).join('') || '<span class="empty">Tap to sit here</span>'}</span>
      </button>`;
  };
  const unseated = room.players.filter((x) => !x.team);

  region($app, 'lobby', `
    <section class="lobby">
      <header class="lobby-head">
        <div>
          <div class="muted">Room code</div>
          <div class="room-code">${esc(room.code)}</div>
        </div>
        <button class="btn" id="share">Invite friends</button>
      </header>
      <div class="teams">
        <div class="team team-red"><h2>● Circle team</h2>${slot('red', 'spymaster')}${slot('red', 'guesser')}</div>
        <div class="team team-blue"><h2>■ Square team</h2>${slot('blue', 'spymaster')}${slot('blue', 'guesser')}</div>
      </div>
      ${unseated.length ? `<p class="muted waiting">Not on a team yet: ${unseated.map(person).join(', ')}</p>` : ''}
      <div class="lobby-actions">
        <button class="btn primary big" id="start" ${room.ready ? '' : 'disabled'}>Deal the pictures</button>
        <p class="muted center">${room.ready ? 'Everyone ready? Anyone can start.' : 'Each team needs a spymaster and at least one guesser.'}</p>
        <div class="row">
          ${p?.team ? '<button class="btn link" data-sit=":">Leave my seat</button>' : ''}
          <button class="btn link" id="leave">Leave room</button>
        </div>
      </div>
      <details class="how card-panel"><summary>How to play</summary>${howToPlay()}</details>
    </section>
  `);
}

async function share() {
  const url = inviteURL(ui.code);
  const text = `Join my Goat Pic game! Room code ${ui.code}`;
  if (navigator.share) {
    try { await navigator.share({ title: 'Goat Pic', text, url }); return; } catch { /* cancelled */ }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('Invite link copied');
  } catch {
    toast(url);
  }
}

// ---------- Game ----------

function renderGame() {
  layout('game');
  const room = ui.room;
  const g = room.game;
  const p = me();
  const spy = p?.role === 'spymaster';

  $app.classList.toggle('turn-red', g.turn === 'red' && g.phase !== 'over');
  $app.classList.toggle('turn-blue', g.turn === 'blue' && g.phase !== 'over');

  region($app, 'top', `
    <header class="scorebar">
      <div class="score red ${g.turn === 'red' && g.phase !== 'over' ? 'active' : ''}"><i>●</i><b>${g.remaining.red}</b><span>Circle<br>left</span></div>
      <div class="status">${statusLine(g, p)}</div>
      <div class="score blue ${g.turn === 'blue' && g.phase !== 'over' ? 'active' : ''}"><i>■</i><b>${g.remaining.blue}</b><span>Square<br>left</span></div>
      <button class="menu-btn" id="menu" aria-label="Menu">☰</button>
    </header>
  `);

  region($app, 'board', `
    <div class="board ${spy ? 'spy' : ''} ${g.phase === 'over' ? 'over' : ''} ${canGuess() ? 'can-guess' : ''}">
      ${g.cards.map((c, i) => `
        <button class="tile ${c.team ? `k-${c.team}` : ''} ${c.revealed ? 'revealed' : ''}" data-card="${i}" aria-label="Picture ${i + 1}${c.revealed ? `, ${c.team}` : ''}">
          <img src="${esc(c.image)}" alt="" loading="eager" decoding="async" draggable="false">
          ${c.revealed ? `<span class="cover">${c.team === 'assassin' ? '☠' : ''}</span>` : ''}
        </button>`).join('')}
    </div>
  `);

  region($app, 'actions', `<footer class="actions">${actionsPanel(g, p)}</footer>`);
  region($app, 'menu', ui.showMenu ? menuSheet(room, g) : '');
}

function teamLabel(t) {
  return `<span class="team-word ${t}">${TEAM_ICON[t]} ${TEAM_NAME[t]}</span>`;
}

function clueText(c) {
  const n = c.number === -1 ? '∞' : c.number;
  return `<span class="clue-word">${esc(c.word)}</span> <span class="clue-num">${n}</span>`;
}

function statusLine(g, p) {
  if (g.phase === 'over') {
    return `${teamLabel(g.winner)} wins!`;
  }
  if (g.phase === 'clue') {
    if (p?.team === g.turn && p.role === 'spymaster') return 'Your turn to give a clue';
    return `${teamLabel(g.turn)} spymaster is thinking…`;
  }
  return clueText(g.clue);
}

function actionsPanel(g, p) {
  if (g.phase === 'over') {
    const why = g.winReason === 'assassin'
      ? `${teamLabel(g.winner === 'red' ? 'blue' : 'red')} found the dead goat.`
      : `${teamLabel(g.winner)} found all their pictures.`;
    return `
      <div class="over-panel">
        <p>${why}</p>
        <div class="row">
          <button class="btn primary" id="again">Play again</button>
          <button class="btn" id="to-lobby">Switch teams</button>
        </div>
      </div>`;
  }
  const mine = p?.team === g.turn;
  if (g.phase === 'clue' && mine && p.role === 'spymaster') {
    const nums = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, -1];
    return `
      <form id="clue-form" class="clue-form" autocomplete="off">
        <input name="word" maxlength="40" placeholder="One-word clue" autocapitalize="off" spellcheck="false" enterkeyhint="send" aria-label="Clue word">
        <div class="nums" role="radiogroup" aria-label="Number of pictures">
          ${nums.map((n) => `<button type="button" class="num ${ui.clueNumber === n ? 'on' : ''}" data-num="${n}" role="radio" aria-checked="${ui.clueNumber === n}">${n === -1 ? '∞' : n}</button>`).join('')}
        </div>
        <button class="btn primary">Give clue</button>
      </form>`;
  }
  if (g.phase === 'guess' && mine && p.role === 'guesser') {
    const left = g.guessesLeft === -1 ? 'Unlimited guesses' : `${g.guessesLeft} guess${g.guessesLeft === 1 ? '' : 'es'} left`;
    return `
      <div class="guess-panel">
        <span>Tap a picture to guess. <b>${left}</b></span>
        <button class="btn" id="end-turn" ${g.guessesMade ? '' : 'disabled'}>End turn</button>
      </div>`;
  }
  if (g.phase === 'guess') {
    const who = p?.team === g.turn ? 'Your teammates are' : `${teamLabel(g.turn)} is`;
    return `<p class="wait">${who} guessing…</p>`;
  }
  if (p?.role === 'guesser' && mine) return '<p class="wait">Waiting for your spymaster’s clue…</p>';
  if (!p?.team) return '<p class="wait">You’re watching. Open the menu to join a team.</p>';
  return `<p class="wait">Waiting for ${teamLabel(g.turn)}’s clue…</p>`;
}

function menuSheet(room, g) {
  const log = (g.log || []).slice().reverse().map((e) => `
    <li>${teamLabel(e.clue.team)} ${clueText(e.clue)}
      <span class="dots">${e.guesses.map((t) => `<i class="t-${t}"></i>`).join('')}</span></li>`).join('');
  const p = me();
  return `
    <div class="sheet-backdrop" data-close-menu></div>
    <aside class="sheet" role="dialog" aria-label="Game menu">
      <h3>Room ${esc(room.code)}</h3>
      <ul class="players">
        ${room.players.map((x) => `<li class="${x.connected ? '' : 'away'}"><i class="t-${x.team || 'none'}"></i>${esc(x.name)}${x.id === room.you ? ' (you)' : ''} <span class="muted">${x.role || 'watching'}</span></li>`).join('')}
      </ul>
      ${!p?.team && g.phase !== 'over' ? `
        <div class="row">
          <button class="btn" data-sit="red:guesser">Join Circle</button>
          <button class="btn" data-sit="blue:guesser">Join Square</button>
        </div>` : ''}
      <h4>Clues</h4>
      ${log ? `<ul class="log">${log}</ul>` : '<p class="muted">No clues yet.</p>'}
      <button class="btn" id="browse">Browse pictures</button>
      <div class="row">
        <button class="btn" id="share">Invite</button>
        <button class="btn" id="to-lobby">Back to lobby</button>
      </div>
      <button class="btn link" id="leave">Leave room</button>
    </aside>`;
}

// ---------- Zoom sheet ----------

function renderModal() {
  const g = ui.room?.game;
  if (ui.selected == null || !g) {
    if ($modal._html) { $modal.innerHTML = ''; $modal._html = ''; }
    return;
  }
  const c = g.cards[ui.selected];
  const guessable = canGuess() && !c.revealed;
  const tag = c.team && (c.revealed || me()?.role === 'spymaster' || g.phase === 'over')
    ? `<span class="key-tag k-${c.team}" aria-label="${KEY_NAME[c.team]}${c.revealed ? ' (revealed)' : ''}">${KEY_ICON[c.team]}${c.revealed ? ' (revealed)' : ''}</span>`
    : '';
  const html = `
    <div class="zoom-backdrop" data-close></div>
    <div class="zoom ${c.team ? `k-${c.team}` : ''}" role="dialog" aria-label="Picture">
      <img src="${esc(c.image)}" alt="">
      ${tag}
      <div class="row">
        ${guessable ? `<button class="btn primary big" data-guess="${ui.selected}">Guess this picture</button>` : ''}
        <button class="btn" data-close>Close</button>
      </div>
    </div>`;
  if ($modal._html !== html) {
    $modal.innerHTML = html;
    $modal._html = html;
    upgradeImage($modal.querySelector('.zoom img'), c.image);
  }
}

// ---------- Full-screen picture viewer (press and hold) ----------
// Lives in its own #viewer element outside the board, so server updates that
// re-render the board don't disturb it. Opened from the menu's "Browse
// pictures" it is a carousel: swipe left and right (or the arrows) to step
// through every picture on the board. Browsing never makes a guess.

const HOLD_MS = 450;
const MOVE_SLOP = 10;
const MAX_SCALE = 6;
const SWIPE_MIN = 60;
const view = { index: null, image: null, phase: null, carousel: false, scale: 1, x: 0, y: 0 };

function openViewer(index, { carousel = false, from = 0 } = {}) {
  const g = ui.room?.game;
  const c = g?.cards[index];
  if (!c) return;
  if (view.index === index && view.image === c.image && view.carousel === carousel) return;
  const n = g.cards.length;
  Object.assign(view, { index, image: c.image, phase: g.phase, carousel, scale: 1, x: 0, y: 0 });
  $viewer.innerHTML = `
    <div class="viewer ${carousel ? 'carousel' : ''}" role="dialog" aria-modal="true" aria-label="Picture ${index + 1}${carousel ? ` of ${n}` : ''}, full screen">
      <div class="viewer-stage"><div class="viewer-pic ${from > 0 ? 'from-right' : from < 0 ? 'from-left' : ''}"><img class="viewer-img" src="${esc(c.image)}" alt="" draggable="false"></div></div>
      <span class="viewer-tag"></span>
      ${carousel ? `
        <span class="viewer-count">${index + 1} / ${n}</span>
        <button class="viewer-step prev" data-step="-1" aria-label="Previous picture">‹</button>
        <button class="viewer-step next" data-step="1" aria-label="Next picture">›</button>` : ''}
      <button class="viewer-close" data-close-viewer aria-label="Close">✕</button>
    </div>`;
  const img = $viewer.querySelector('.viewer-img');
  upgradeImage(img, c.image);
  // Gestures move the picture together with its key mark drawn on top.
  bindViewerGestures($viewer.querySelector('.viewer-stage'), $viewer.querySelector('.viewer-pic'));
  $viewer.querySelector('.viewer-close').focus({ preventScroll: true });
  syncViewer();
  if (carousel) {
    // Fetch the neighbours' large pictures so the next swipe is sharp at once.
    for (const d of [1, -1]) {
      const big = largeURL(g.cards[(index + d + n) % n].image);
      if (!largeFailed.has(big)) new Image().src = big;
    }
  }
}

// Carousel: move by d pictures, wrapping round at either end.
function stepViewer(d) {
  const n = ui.room?.game?.cards.length;
  if (view.index == null || !view.carousel || !n) return;
  // Keep keyboard focus on the arrow just used, so Enter keeps stepping.
  const onStep = document.activeElement?.dataset?.step;
  openViewer((view.index + d + n) % n, { carousel: true, from: d });
  if (onStep != null) $viewer.querySelector(`[data-step="${onStep}"]`)?.focus({ preventScroll: true });
}

function closeViewer() {
  if (view.index == null) return;
  view.index = null;
  view.image = null;
  view.carousel = false;
  $viewer.innerHTML = '';
}

// Keep the open viewer in step with the game: update the key colour, and
// close it when the game ends, a new board is dealt or we leave.
function syncViewer() {
  if (view.index == null) return;
  const g = ui.room?.game;
  const c = g?.cards[view.index];
  if (!ui.code || !c || c.image !== view.image || (g.phase === 'over' && view.phase !== 'over')) {
    closeViewer();
    return;
  }
  const box = $viewer.querySelector('.viewer');
  box.className = `viewer ${view.carousel ? 'carousel' : ''} ${c.team ? `k-${c.team}` : ''} ${c.revealed ? 'revealed' : ''}`;
  const tag = $viewer.querySelector('.viewer-tag');
  const revealed = c.revealed ? ' (revealed)' : '';
  const label = c.team ? `${KEY_ICON[c.team]}${revealed}` : '';
  tag.innerHTML = label;
  if (c.team) tag.setAttribute('aria-label', `${KEY_NAME[c.team]}${revealed}`);
  tag.hidden = !label;
}

function bindViewerGestures(stage, img) {
  const pointers = new Map();
  let start = null;      // single-finger gesture start
  let pinch = null;      // two-finger gesture start
  let lastTap = null;    // for double tap
  let tapTimer = null;

  // The transform origin: the image's own untransformed centre in viewport
  // coordinates. The stage's padding is uneven (top bar vs bottom tag and
  // safe areas), so the stage's centre is not the image's.
  const center = () => {
    const p = img.offsetParent ? img.offsetParent.getBoundingClientRect() : { left: 0, top: 0 };
    return {
      x: p.left + img.offsetLeft + img.offsetWidth / 2,
      y: p.top + img.offsetTop + img.offsetHeight / 2,
    };
  };
  // Keep the zoomed image covering the stage: an edge may reach the stage's
  // edge but not come inside it. Measured from the image's real centre.
  const clampAxis = (v, size, lo, hi, c) => {
    if (size <= hi - lo) return 0;
    const min = hi - c - size / 2; // right/bottom edge at the stage's far edge
    const max = lo - c + size / 2; // left/top edge at the stage's near edge
    return Math.min(max, Math.max(min, v));
  };
  const clamp = () => {
    const r = stage.getBoundingClientRect();
    const c = center();
    view.x = clampAxis(view.x, img.offsetWidth * view.scale, r.left, r.right, c.x);
    view.y = clampAxis(view.y, img.offsetHeight * view.scale, r.top, r.bottom, c.y);
  };
  const apply = (animate) => {
    img.style.transition = animate ? 'transform .2s ease' : 'none';
    img.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  };
  // Zoom to scale s keeping the screen point (px, py) where it is.
  const zoomAt = (s, px, py, from = view) => {
    s = Math.min(MAX_SCALE, Math.max(1, s));
    const c = center();
    const ox = px - c.x;
    const oy = py - c.y;
    view.x = ox - (ox - from.x) * (s / from.scale);
    view.y = oy - (oy - from.y) * (s / from.scale);
    view.scale = s;
    if (s === 1) { view.x = 0; view.y = 0; }
  };
  const pair = () => {
    const [a, b] = [...pointers.values()];
    return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };
  const beginSingle = (p) => {
    start = { x: p.x, y: p.y, t: Date.now(), vx: view.x, vy: view.y, moved: false, axis: null };
  };

  stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    stage.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      beginSingle(pointers.get(e.pointerId));
    } else if (pointers.size === 2) {
      const p = pair();
      pinch = { d: p.d, x: p.x, y: p.y, scale: view.scale, vx: view.x, vy: view.y };
      if (start) start.moved = true;
      clearTimeout(tapTimer);
    }
  });

  stage.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size >= 2 && pinch) {
      const p = pair();
      const s = Math.min(MAX_SCALE, Math.max(1, pinch.scale * (p.d / pinch.d)));
      const c = center();
      const ox = pinch.x - c.x;
      const oy = pinch.y - c.y;
      view.scale = s;
      view.x = ox - (ox - pinch.vx) * (s / pinch.scale) + (p.x - pinch.x);
      view.y = oy - (oy - pinch.vy) * (s / pinch.scale) + (p.y - pinch.y);
      apply(false);
      return;
    }
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!start.moved && Math.hypot(dx, dy) > MOVE_SLOP) {
      start.moved = true;
      // In the carousel a sideways drag at normal size flips pictures.
      start.axis = view.carousel && view.scale <= 1 && Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    }
    if (!start.moved) return;
    if (start.axis === 'x') {
      img.style.transition = 'none';
      img.style.transform = `translateX(${dx}px)`;
    } else if (view.scale > 1) {
      view.x = start.vx + dx;
      view.y = start.vy + dy;
      clamp();
      apply(false);
    } else if (dy > 0) {
      // Swipe down to dismiss.
      img.style.transition = 'none';
      img.style.transform = `translateY(${dy}px) scale(${1 - Math.min(dy, 400) / 2000})`;
      stage.parentElement.style.setProperty('--dim', String(Math.max(0.3, 1 - dy / 500)));
    }
  });

  const end = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (pointers.size === 1) {
      // Pinch finished with one finger still down: carry on panning from here.
      pinch = null;
      if (view.scale <= 1.02) { view.scale = 1; view.x = 0; view.y = 0; }
      clamp();
      apply(true);
      beginSingle([...pointers.values()][0]);
      start.moved = true;
      return;
    }
    if (pointers.size > 0) return;
    const s = start;
    start = null;
    pinch = null;
    if (!s || e.type === 'pointercancel') {
      stage.parentElement.style.removeProperty('--dim');
      clamp();
      apply(true);
      return;
    }
    const dy = e.clientY - s.y;
    const quick = Date.now() - s.t;
    if (s.moved && s.axis === 'x') {
      const dx = e.clientX - s.x;
      if (Math.abs(dx) > SWIPE_MIN || (Math.abs(dx) > 20 && Math.abs(dx) / quick > 0.5)) {
        stepViewer(dx < 0 ? 1 : -1);
        return;
      }
      apply(true);
      return;
    }
    if (s.moved) {
      if (view.scale <= 1 && dy > 0) {
        if (dy > 110 || (dy > 40 && dy / quick > 0.6)) { closeViewer(); return; }
        stage.parentElement.style.removeProperty('--dim');
        view.x = 0; view.y = 0;
      }
      clamp();
      apply(true);
      return;
    }
    // A tap: double tap zooms in or out, a single tap (unzoomed) closes.
    const now = Date.now();
    if (lastTap && now - lastTap.t < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
      clearTimeout(tapTimer);
      lastTap = null;
      if (view.scale > 1) { view.scale = 1; view.x = 0; view.y = 0; } else zoomAt(2.5, e.clientX, e.clientY);
      clamp();
      apply(true);
      return;
    }
    lastTap = { t: now, x: e.clientX, y: e.clientY };
    // A stray tap shouldn't end a browse: the carousel closes with ✕ or a swipe down.
    if (view.scale === 1 && !view.carousel) {
      clearTimeout(tapTimer);
      tapTimer = setTimeout(() => { if (lastTap?.t === now) closeViewer(); }, 300);
    }
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);

  // Mouse wheel / trackpad pinch on desktop.
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt(view.scale * Math.exp(-e.deltaY / 300), e.clientX, e.clientY);
    clamp();
    apply(false);
  }, { passive: false });
}

// Press and hold on a board picture opens the viewer. The finger may wander a
// little; moving further means the player is scrolling, so the hold is off.
const hold = { timer: null, id: null, x: 0, y: 0, fired: false };

function cancelHold() {
  clearTimeout(hold.timer);
  hold.timer = null;
  hold.id = null;
}

// Any new press starts afresh (a long press doesn't always end in a click).
document.addEventListener('pointerdown', () => { hold.fired = false; }, true);
$app.addEventListener('pointerdown', (e) => {
  const tile = e.target.closest('.tile[data-card]');
  if (!tile || (e.pointerType === 'mouse' && e.button !== 0) || !e.isPrimary) { cancelHold(); return; }
  cancelHold();
  Object.assign(hold, { id: e.pointerId, x: e.clientX, y: e.clientY });
  hold.timer = setTimeout(() => {
    hold.timer = null;
    hold.fired = true;
    navigator.vibrate?.(15);
    openViewer(Number(tile.dataset.card));
  }, HOLD_MS);
});
// Listen on the document: the board may be re-rendered mid-press.
document.addEventListener('pointermove', (e) => {
  if (e.pointerId === hold.id && hold.timer && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > MOVE_SLOP) cancelHold();
});
for (const type of ['pointerup', 'pointercancel']) {
  document.addEventListener(type, (e) => { if (e.pointerId === hold.id) cancelHold(); });
}
// The click that ends a hold must not also open the sheet.
document.addEventListener('click', (e) => {
  if (hold.fired) {
    hold.fired = false;
    e.preventDefault();
    e.stopPropagation();
  }
}, true);
// Right-click on desktop; also stops the long-press menu on phones.
$app.addEventListener('contextmenu', (e) => {
  const tile = e.target.closest('.tile[data-card]');
  if (!tile) return;
  e.preventDefault();
  cancelHold();
  if (view.index == null) {
    hold.fired = true; // swallow a click that may follow on touch screens
    openViewer(Number(tile.dataset.card));
  }
});

// ---------- Events ----------

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, [data-close], [data-close-menu]');
  if (!t) return;

  if (t.dataset.closeViewer != null) {
    closeViewer();
    return;
  }
  if (t.dataset.step != null) {
    stepViewer(Number(t.dataset.step));
    return;
  }
  if (t.dataset.card != null) {
    ui.selected = Number(t.dataset.card);
    renderModal();
    return;
  }
  if (t.dataset.close != null) {
    ui.selected = null;
    renderModal();
    return;
  }
  if (t.dataset.closeMenu != null) {
    ui.showMenu = false;
    render();
    return;
  }
  if (t.dataset.guess != null) {
    const index = Number(t.dataset.guess);
    ui.selected = null;
    renderModal();
    await act('guess', { index });
    return;
  }
  if (t.dataset.num != null) {
    ui.clueNumber = Number(t.dataset.num);
    t.parentElement.querySelectorAll('.num').forEach((b) => {
      const on = Number(b.dataset.num) === ui.clueNumber;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on);
    });
    return;
  }
  if (t.dataset.sit != null) {
    const [team, role] = t.dataset.sit.split(':');
    const p = me();
    if (p?.team === team && p?.role === role) return;
    ui.showMenu = false;
    await act('sit', { team, role });
    return;
  }

  switch (t.id) {
    case 'forget-code':
      history.replaceState(null, '', `/${location.search}`);
      renderHome();
      break;
    case 'share':
      share();
      break;
    case 'start':
    case 'again':
      await act('start');
      break;
    case 'to-lobby':
      if (ui.room.game.phase !== 'over' && !confirm('End this game for everyone and go back to the lobby?')) return;
      ui.showMenu = false;
      await act('lobby');
      break;
    case 'end-turn':
      await act('end-turn');
      break;
    case 'browse':
      ui.showMenu = false;
      render();
      openViewer(0, { carousel: true });
      break;
    case 'menu':
      ui.showMenu = !ui.showMenu;
      render();
      break;
    case 'leave':
      if (!confirm('Leave this room?')) return;
      await act('leave');
      leaveLocal();
      break;
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && view.index != null) {
    closeViewer();
    return;
  }
  if (view.carousel && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault();
    stepViewer(e.key === 'ArrowLeft' ? -1 : 1);
    return;
  }
  if (e.key === 'Escape' && (ui.selected != null || ui.showMenu)) {
    ui.selected = null;
    ui.showMenu = false;
    render();
  }
});

// ---------- Boot ----------

const booted = (async function boot() {
  const urlCode = roomCodeFromURL();
  const saved = store.get('room');
  const name = store.get('name');
  const code = urlCode || saved;
  // Coming back to a room we were already in: reconnect straight away.
  if (code && name && (!urlCode || urlCode === saved)) {
    try {
      await joinRoom(code, name);
    } catch {
      store.set('room', '');
      if (!urlCode) history.replaceState(null, '', `/${location.search}`);
      render();
    }
  } else {
    render();
  }
})();

// A dev frame skips the service worker: four frames sharing one shell cache
// would fight over it, and the harness wants a fresh app every reload.
if ('serviceWorker' in navigator && !DEV) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

// ---------- Dev harness ----------
// The harness page (/dev) drives each frame from the parent window: seat a
// named player, start the game, and read back where the frame is.

function postDevState() {
  // A dev frame opened as a top-level page has no parent: posting to ourselves
  // would re-enter the listener below and loop forever.
  if (window.parent === window) return;
  const p = me();
  try {
    window.parent.postMessage({
      type: 'dev-state',
      dev: DEV,
      code: ui.code,
      you: ui.room && ui.room.you,
      seat: p ? { name: p.name, team: p.team, role: p.role } : null,
      phase: ui.room && ui.room.game ? ui.room.game.phase : null,
    }, location.origin);
  } catch { /* no parent */ }
}

if (DEV) {
  window.addEventListener('message', async (e) => {
    if (window.parent === window) return;
    if (e.origin !== location.origin || e.source !== window.parent) return;
    const msg = e.data;
    if (!msg || typeof msg !== 'object') return;
    if (!['dev-seat', 'dev-start', 'dev-redeal'].includes(msg.type)) return;
    try {
      await booted;
      if (msg.type === 'dev-seat') {
        if (!ui.code) await joinRoom(roomCodeFromURL(), msg.name);
        await act('sit', { team: msg.team, role: msg.role });
      } else if (msg.type === 'dev-start') {
        await act('start');
      } else if (msg.type === 'dev-redeal') {
        // Start refuses while a game is running, so pass through the lobby.
        if (ui.room && ui.room.game) await act('lobby');
        await act('start');
      }
    } catch (err) {
      toast(err.message);
    }
    postDevState();
  });
}
