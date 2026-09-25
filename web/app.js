'use strict';

// ---------- Local identity ----------

const store = {
  get(key, fallback = '') {
    try { return localStorage.getItem(`cnp.${key}`) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`cnp.${key}`, value); } catch { /* private mode */ }
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
  clueNumber: 1,
  showMenu: false,
  error: '',
  busy: false,
  lastNeedsMe: false,
};

const $app = document.getElementById('app');
const $modal = document.getElementById('modal');
const $toast = document.getElementById('toast');

const TEAM_NAME = { red: 'Red', blue: 'Blue' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
  if (location.pathname !== `/r/${code}`) history.replaceState(null, '', `/r/${code}`);
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
  es.onopen = () => document.body.classList.remove('offline');
}

function leaveLocal(message) {
  if (ui.events) ui.events.close();
  Object.assign(ui, { code: null, room: null, events: null, selected: null, showMenu: false });
  store.set('room', '');
  history.replaceState(null, '', '/');
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
  const hadGame = !!ui.room?.game;
  ui.room = view;
  if (!view.game) ui.selected = null;
  if (!hadGame && view.game) ui.clueNumber = 1;
  const nowNeedsMe = needsMe();
  if (nowNeedsMe && !ui.lastNeedsMe && navigator.vibrate) navigator.vibrate([80, 60, 80]);
  ui.lastNeedsMe = nowNeedsMe;
  keepAwake();
  render();
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
}

// ---------- Home ----------

function renderHome() {
  layout('home');
  const code = roomCodeFromURL();
  const name = store.get('name');
  region($app, 'home', `
    <section class="home">
      <div class="logo" aria-hidden="true">${logoTiles()}</div>
      <h1>Codenames <span>Pictures</span></h1>
      <p class="tagline">Two teams. Twenty pictures. One-word clues.</p>
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
      <li>Split into <b>Red</b> and <b>Blue</b>. Each team has one <b>spymaster</b> and one or more <b>guessers</b>.</li>
      <li>Only spymasters see which pictures belong to which team.</li>
      <li>On your turn, your spymaster gives a <b>one-word clue</b> and a number: how many pictures it points to.</li>
      <li>Guessers tap pictures. A correct guess lets you keep going, up to one more than the number.</li>
      <li>Hit a beige bystander or the other team's picture and your turn ends. Hit the <b>black assassin</b> and you lose instantly.</li>
      <li>The first team to find all their pictures wins. The team that goes first has 8, the other has 7.</li>
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
        <div class="team team-red"><h2>Red team</h2>${slot('red', 'spymaster')}${slot('red', 'guesser')}</div>
        <div class="team team-blue"><h2>Blue team</h2>${slot('blue', 'spymaster')}${slot('blue', 'guesser')}</div>
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
  const text = `Join my Codenames Pictures game! Room code ${ui.code}`;
  if (navigator.share) {
    try { await navigator.share({ title: 'Codenames Pictures', text, url }); return; } catch { /* cancelled */ }
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
      <div class="score red ${g.turn === 'red' && g.phase !== 'over' ? 'active' : ''}"><b>${g.remaining.red}</b><span>Red left</span></div>
      <div class="status">${statusLine(g, p)}</div>
      <div class="score blue ${g.turn === 'blue' && g.phase !== 'over' ? 'active' : ''}"><b>${g.remaining.blue}</b><span>Blue left</span></div>
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
  return `<span class="team-word ${t}">${TEAM_NAME[t]}</span>`;
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
      ? `${teamLabel(g.winner === 'red' ? 'blue' : 'red')} found the assassin.`
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
          <button class="btn" data-sit="red:guesser">Join Red</button>
          <button class="btn" data-sit="blue:guesser">Join Blue</button>
        </div>` : ''}
      <h4>Clues</h4>
      ${log ? `<ul class="log">${log}</ul>` : '<p class="muted">No clues yet.</p>'}
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
    ? `<span class="key-tag k-${c.team}">${{ red: 'Red agent', blue: 'Blue agent', neutral: 'Bystander', assassin: 'Assassin' }[c.team]}${c.revealed ? ' (revealed)' : ''}</span>`
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
  }
}

// ---------- Events ----------

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, [data-close], [data-close-menu]');
  if (!t) return;

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
      history.replaceState(null, '', '/');
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
  if (e.key === 'Escape' && (ui.selected != null || ui.showMenu)) {
    ui.selected = null;
    ui.showMenu = false;
    render();
  }
});

// ---------- Boot ----------

(async function boot() {
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
      if (!urlCode) history.replaceState(null, '', '/');
      render();
    }
  } else {
    render();
  }
})();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
