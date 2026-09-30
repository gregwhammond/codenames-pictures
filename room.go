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
	rnd      *mrand.Rand
	lastSeen time.Time
	subs     map[chan struct{}]struct{}
}

func newRoom(code string, images []string, seed int64) *Room {
	return &Room{
		Code:     code,
		byToken:  map[string]*Player{},
		images:   images,
		rnd:      mrand.New(mrand.NewSource(seed)),
		lastSeen: time.Now(),
		subs:     map[chan struct{}]struct{}{},
	}
}

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

func (r *Room) Sit(p *Player, team Team, role Role) error {
	if team == "" && role == "" { // stand up
		p.Team, p.Role = "", ""
		return nil
	}
	if !team.Playable() || (role != Spymaster && role != Guesser) {
		return ErrBadSeat
	}
	if r.game != nil && r.game.Phase != PhaseOver && p.Role == Spymaster && (role != Spymaster || team != p.Team) {
		// A spymaster has seen the key, so they can't move mid-game.
		return ErrGameRunning
	}
	if role == Spymaster {
		for _, o := range r.players {
			if o != p && o.Team == team && o.Role == Spymaster {
				return ErrSeatTaken
			}
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
	g, err := NewGame(r.images, r.rnd)
	if err != nil {
		return err
	}
	r.game = g
	return nil
}

// BackToLobby ends the current game so seats can be changed.
func (r *Room) BackToLobby() {
	r.game = nil
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

func (r *Room) Leave(p *Player) {
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
	Code    string       `json:"code"`
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
	v := RoomView{Code: r.Code, You: me.ID, Ready: r.seatsReady()}
	for _, p := range r.players {
		v.Players = append(v.Players, PlayerView{p.ID, p.Name, p.Team, p.Role, p.Connected()})
	}
	if g := r.game; g != nil {
		seeKey := me.Role == Spymaster || g.Phase == PhaseOver
		gv := &GameView{
			StartingTeam: g.StartingTeam,
			Turn:         g.Turn,
			Phase:        g.Phase,
			Clue:         g.Clue,
			GuessesLeft:  g.GuessesLeft,
			GuessesMade:  g.GuessesMade,
			Remaining:    map[Team]int{Red: g.Remaining(Red), Blue: g.Remaining(Blue)},
			Winner:       g.Winner,
			WinReason:    g.WinReason,
			Log:          g.Log,
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
	mu     sync.Mutex
	rooms  map[string]*Room
	images []string
}

func NewRooms(images []string) *Rooms {
	return &Rooms{rooms: map[string]*Room{}, images: images}
}

func (rs *Rooms) Create() *Room {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	for {
		b := make([]byte, roomCodeLength)
		_, _ = rand.Read(b)
		for i := range b {
			b[i] = roomCodeAlphabet[int(b[i])%len(roomCodeAlphabet)]
		}
		code := string(b)
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
		return room
	}
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
