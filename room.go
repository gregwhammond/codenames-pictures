package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	mrand "math/rand"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

type Role string

const (
	Spymaster Role = "spymaster"
	Guesser   Role = "guesser"
)

const (
	maxPlayers     = 12
	maxNameLength  = 20
	roomCodeLength = 4
	// Letters that are hard to misread when spoken or typed.
	roomCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ"
	// maxRooms caps the rooms alive at once, so a loop of "create" requests
	// can't use up the server's memory. Idle rooms are swept after 6 hours.
	maxRooms = 2000
	// maxCodeTries bounds the search for a free room code.
	maxCodeTries = 64
)

var (
	ErrRoomFull      = errors.New("this room is full")
	ErrBadName       = errors.New("please enter a name")
	ErrUnknownPlayer = errors.New("join the room first")
	ErrBadSeat       = errors.New("pick red or blue, and spymaster or guesser")
	ErrSeatTaken     = errors.New("that team already has a spymaster")
	ErrGameRunning   = errors.New("a game is already in progress")
	ErrNoGame        = errors.New("the game hasn't started")
	ErrNotReady      = errors.New("each team needs a spymaster and at least one guesser")
	ErrNotSpymaster  = errors.New("only the spymaster can do that")
	ErrNotGuesser    = errors.New("only guessers can do that")
	ErrTooManyRooms  = errors.New("the server is full right now, please try again in a few minutes")
)

type Player struct {
	ID    string
	Name  string
	Team  Team // "" when not seated
	Role  Role
	token string
	conns int
}

func (p *Player) Connected() bool { return p.conns > 0 }

// Room is one table of players. All fields are guarded by mu.
type Room struct {
	Code string

	mu       sync.Mutex
	players  []*Player
	byToken  map[string]*Player
	game     *Game
	images   []string
	seed     int64
	rnd      *mrand.Rand // made from seed on the first deal: a source is ~5 KB
	lastSeen time.Time
	subs     map[chan struct{}]struct{}
	// rev counts changes, so a client can tell a stale view from a newer one.
	rev uint64
	// sawKey remembers the tokens of spymasters who left their seat (by
	// leaving the room or by being replaced while away) during the running
	// game, and which team's seat it was. They have seen the key, so they may
	// only take that seat back or watch until the game is over.
	sawKey map[string]Team
}

func newRoom(code string, images []string, seed int64) *Room {
	return &Room{
		Code:     code,
		byToken:  map[string]*Player{},
		images:   images,
		seed:     seed,
		lastSeen: time.Now(),
		subs:     map[chan struct{}]struct{}{},
		sawKey:   map[string]Team{},
	}
}

func (r *Room) gameRunning() bool { return r.game != nil && r.game.Phase != PhaseOver }

func randomID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func cleanName(name string) (string, error) {
	name = strings.Join(strings.Fields(name), " ")
	if name == "" {
		return "", ErrBadName
	}
	if utf8.RuneCountInString(name) > maxNameLength {
		name = string([]rune(name)[:maxNameLength])
	}
	return name, nil
}

// Join adds a player, or renames them if the token is already known.
func (r *Room) Join(token, name string) (*Player, error) {
	name, err := cleanName(name)
	if err != nil {
		return nil, err
	}
	if len(token) < 16 || len(token) > 128 {
		return nil, ErrUnknownPlayer
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if p, ok := r.byToken[token]; ok {
		p.Name = name
		r.changedLocked()
		return p, nil
	}
	if len(r.players) >= maxPlayers {
		return nil, ErrRoomFull
	}
	p := &Player{ID: randomID(), Name: name, token: token}
	r.players = append(r.players, p)
	r.byToken[token] = p
	r.changedLocked()
	return p, nil
}

// Do runs fn with the player for token while holding the room lock and
// broadcasts a new state to everyone if fn succeeds.
func (r *Room) Do(token string, fn func(p *Player) error) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	p, ok := r.byToken[token]
	if !ok {
		return ErrUnknownPlayer
	}
	if err := fn(p); err != nil {
		return err
	}
	r.changedLocked()
	return nil
}

// Sit moves a player to a seat; an empty team and role means standing up.
//
// A spymaster seat whose holder has no live connection (their phone died, or
// they came back as a new player from another browser) can be taken over: the
// holder is moved out of the seat.
func (r *Room) Sit(p *Player, team Team, role Role) error {
	standing := team == "" && role == ""
	if !standing && (!team.Playable() || (role != Spymaster && role != Guesser)) {
		return ErrBadSeat
	}
	if r.gameRunning() {
		// A spymaster has seen the key, so they can't move mid-game: not to
		// another seat, and not by standing up first.
		if p.Role == Spymaster && (role != Spymaster || team != p.Team) {
			return ErrGameRunning
		}
		// The same goes for one who left the seat earlier in this game: they
		// may take their own seat back, or watch.
		if keyTeam, saw := r.sawKey[p.token]; saw && !standing && (role != Spymaster || team != keyTeam) {
			return ErrGameRunning
		}
	}
	if standing {
		p.Team, p.Role = "", ""
		return nil
	}
	if role == Spymaster {
		for _, o := range r.players {
			if o == p || o.Team != team || o.Role != Spymaster {
				continue
			}
			if o.Connected() {
				return ErrSeatTaken
			}
			if r.gameRunning() {
				r.sawKey[o.token] = o.Team
			}
			o.Team, o.Role = "", ""
		}
	}
	p.Team, p.Role = team, role
	return nil
}

func (r *Room) seatsReady() bool {
	var spy, guess = map[Team]int{}, map[Team]int{}
	for _, p := range r.players {
		switch p.Role {
		case Spymaster:
			spy[p.Team]++
		case Guesser:
			guess[p.Team]++
		}
	}
	return spy[Red] == 1 && spy[Blue] == 1 && guess[Red] >= 1 && guess[Blue] >= 1
}

// Start deals a new board. It is also used for "play again".
func (r *Room) Start() error {
	if r.game != nil && r.game.Phase != PhaseOver {
		return ErrGameRunning
	}
	if !r.seatsReady() {
		return ErrNotReady
	}
	if r.rnd == nil {
		r.rnd = mrand.New(mrand.NewSource(r.seed))
	}
	g, err := NewGame(r.images, r.rnd)
	if err != nil {
		return err
	}
	r.game = g
	clear(r.sawKey)
	return nil
}

// BackToLobby ends the current game so seats can be changed.
func (r *Room) BackToLobby() {
	r.game = nil
	clear(r.sawKey)
}

func (r *Room) Clue(p *Player, word string, number int) error {
	if r.game == nil {
		return ErrNoGame
	}
	if p.Role != Spymaster {
		return ErrNotSpymaster
	}
	return r.game.GiveClue(p.Team, word, number)
}

func (r *Room) Guess(p *Player, idx int) error {
	if r.game == nil {
		return ErrNoGame
	}
	if p.Role != Guesser {
		return ErrNotGuesser
	}
	return r.game.Guess(p.Team, idx)
}

func (r *Room) EndTurn(p *Player) error {
	if r.game == nil {
		return ErrNoGame
	}
	if p.Role != Guesser {
		return ErrNotGuesser
	}
	return r.game.EndTurn(p.Team)
}

// Leave removes a player from the room. A spymaster who leaves a running game
// is remembered by token, so rejoining doesn't let them guess with the key.
func (r *Room) Leave(p *Player) {
	if r.gameRunning() && p.Role == Spymaster {
		r.sawKey[p.token] = p.Team
	}
	for i, o := range r.players {
		if o == p {
			r.players = append(r.players[:i], r.players[i+1:]...)
			break
		}
	}
	delete(r.byToken, p.token)
}

// Subscribe registers a listener that is poked whenever the room changes.
func (r *Room) Subscribe(token string) (chan struct{}, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	p, ok := r.byToken[token]
	if !ok {
		return nil, ErrUnknownPlayer
	}
	ch := make(chan struct{}, 1)
	r.subs[ch] = struct{}{}
	p.conns++
	r.changedLocked()
	return ch, nil
}

func (r *Room) Unsubscribe(token string, ch chan struct{}) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.subs, ch)
	if p, ok := r.byToken[token]; ok && p.conns > 0 {
		p.conns--
	}
	r.changedLocked()
}

func (r *Room) changedLocked() {
	r.rev++
	r.lastSeen = time.Now()
	for ch := range r.subs {
		select {
		case ch <- struct{}{}:
		default: // already has a pending poke
		}
	}
}

func (r *Room) idleSince() (time.Time, int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.lastSeen, len(r.subs)
}

// ---- Views sent to clients ----

type PlayerView struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Team      Team   `json:"team,omitempty"`
	Role      Role   `json:"role,omitempty"`
	Connected bool   `json:"connected"`
}

type CardView struct {
	Image      string `json:"image"`
	Team       Team   `json:"team,omitempty"` // hidden from guessers until revealed
	Revealed   bool   `json:"revealed"`
	RevealedBy Team   `json:"revealedBy,omitempty"`
}

type GameView struct {
	Cards        []CardView   `json:"cards"`
	StartingTeam Team         `json:"startingTeam"`
	Turn         Team         `json:"turn"`
	Phase        Phase        `json:"phase"`
	Clue         *Clue        `json:"clue,omitempty"`
	GuessesLeft  int          `json:"guessesLeft"`
	GuessesMade  int          `json:"guessesMade"`
	Remaining    map[Team]int `json:"remaining"`
	Winner       Team         `json:"winner,omitempty"`
	WinReason    string       `json:"winReason,omitempty"`
	Log          []LogEntry   `json:"log"`
}

type RoomView struct {
	Code string `json:"code"`
	// Rev grows with every change to the room; clients drop older views.
	Rev     uint64       `json:"rev"`
	You     string       `json:"you"`
	Players []PlayerView `json:"players"`
	Ready   bool         `json:"ready"`
	Game    *GameView    `json:"game,omitempty"`
}

// View renders the room as seen by the player with token.
func (r *Room) View(token string) (RoomView, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	me, ok := r.byToken[token]
	if !ok {
		return RoomView{}, false
	}
	v := RoomView{Code: r.Code, Rev: r.rev, You: me.ID, Ready: r.seatsReady()}
	for _, p := range r.players {
		v.Players = append(v.Players, PlayerView{p.ID, p.Name, p.Team, p.Role, p.Connected()})
	}
	if g := r.game; g != nil {
		seeKey := me.Role == Spymaster || g.Phase == PhaseOver
		gv := &GameView{
			StartingTeam: g.StartingTeam,
			Turn:         g.Turn,
			Phase:        g.Phase,
			GuessesLeft:  g.GuessesLeft,
			GuessesMade:  g.GuessesMade,
			Remaining:    map[Team]int{Red: g.Remaining(Red), Blue: g.Remaining(Blue)},
			Winner:       g.Winner,
			WinReason:    g.WinReason,
			Log:          make([]LogEntry, len(g.Log)),
		}
		// The view is encoded after the lock is released, so it must not
		// share memory with the game: copy the clue and the whole log.
		if g.Clue != nil {
			c := *g.Clue
			gv.Clue = &c
		}
		for i, e := range g.Log {
			gv.Log[i] = LogEntry{Clue: e.Clue, Guesses: append([]string{}, e.Guesses...)}
		}
		for _, c := range g.Cards {
			cv := CardView{Image: c.Image, Revealed: c.Revealed, RevealedBy: c.RevealedBy}
			if seeKey || c.Revealed {
				cv.Team = c.Team
			}
			gv.Cards = append(gv.Cards, cv)
		}
		v.Game = gv
	}
	return v, true
}

// ---- Registry of rooms ----

type Rooms struct {
	mu      sync.Mutex
	rooms   map[string]*Room
	images  []string
	max     int           // most rooms alive at once
	newCode func() string // proposes a room code; replaced in tests
}

func NewRooms(images []string) *Rooms {
	return &Rooms{rooms: map[string]*Room{}, images: images, max: maxRooms, newCode: randomCode}
}

func randomCode() string {
	b := make([]byte, roomCodeLength)
	_, _ = rand.Read(b)
	for i := range b {
		b[i] = roomCodeAlphabet[int(b[i])%len(roomCodeAlphabet)]
	}
	return string(b)
}

// Create opens a new room. It fails with ErrTooManyRooms when the server
// already holds the most rooms it allows, or no free code turns up in a
// bounded number of tries.
func (rs *Rooms) Create() (*Room, error) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	if len(rs.rooms) >= rs.max {
		return nil, ErrTooManyRooms
	}
	for try := 0; try < maxCodeTries; try++ {
		code := rs.newCode()
		if _, taken := rs.rooms[code]; taken {
			continue
		}
		seed := make([]byte, 8)
		_, _ = rand.Read(seed)
		var s int64
		for _, x := range seed {
			s = s<<8 | int64(x)
		}
		room := newRoom(code, rs.images, s)
		rs.rooms[code] = room
		return room, nil
	}
	return nil, ErrTooManyRooms
}

func (rs *Rooms) Get(code string) (*Room, bool) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	r, ok := rs.rooms[strings.ToUpper(code)]
	return r, ok
}

// Sweep removes rooms nobody has touched or watched for maxIdle.
func (rs *Rooms) Sweep(maxIdle time.Duration) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	for code, r := range rs.rooms {
		last, watchers := r.idleSince()
		if watchers == 0 && time.Since(last) > maxIdle {
			delete(rs.rooms, code)
		}
	}
}
