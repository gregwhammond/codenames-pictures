package main

import (
	"errors"
	"math/rand"
	"strings"
	"unicode/utf8"
)

// Codenames Pictures uses a 5x4 grid: the starting team has 8 agents, the
// other team 7, plus 4 bystanders and 1 assassin.
const (
	CardCount       = 20
	StartingAgents  = 8
	SecondAgents    = 7
	BystanderCount  = 4
	Unlimited       = -1 // clue number meaning "any number of guesses"
	maxClueWordSize = 40
)

type Team string

const (
	Red      Team = "red"
	Blue     Team = "blue"
	Neutral  Team = "neutral"
	Assassin Team = "assassin"
)

func (t Team) Other() Team {
	switch t {
	case Red:
		return Blue
	case Blue:
		return Red
	}
	return t
}

func (t Team) Playable() bool { return t == Red || t == Blue }

type Phase string

const (
	PhaseClue  Phase = "clue"  // waiting for the current spymaster's clue
	PhaseGuess Phase = "guess" // current team's guessers are guessing
	PhaseOver  Phase = "over"
)

type Card struct {
	Image    string
	Team     Team
	Revealed bool
	// RevealedBy is the team whose guess revealed the card.
	RevealedBy Team
}

type Clue struct {
	Team   Team   `json:"team"`
	Word   string `json:"word"`
	Number int    `json:"number"`
}

// LogEntry records one clue and the guesses made for it.
type LogEntry struct {
	Clue    Clue     `json:"clue"`
	Guesses []string `json:"guesses"` // team of each guessed card, in order
}

type Game struct {
	Cards        []Card
	StartingTeam Team
	Turn         Team
	Phase        Phase
	Clue         *Clue
	GuessesLeft  int // Unlimited, or guesses remaining this turn
	GuessesMade  int // guesses made this turn
	Winner       Team
	WinReason    string // "agents" or "assassin"
	Log          []LogEntry
}

var (
	ErrGameOver    = errors.New("the game is over")
	ErrNotYourTurn = errors.New("it is not your team's turn")
	ErrWrongPhase  = errors.New("that can't be done right now")
	ErrBadCard     = errors.New("no such card")
	ErrRevealed    = errors.New("that picture is already revealed")
	ErrBadClue     = errors.New("a clue must be a single word")
	ErrBadNumber   = errors.New("the clue number must be 0 to 9, or unlimited")
	ErrMustGuess   = errors.New("make at least one guess before ending the turn")
	ErrTooFewCards = errors.New("not enough pictures to deal a board")
)

// NewGame deals a board from the given image pool.
func NewGame(images []string, rnd *rand.Rand) (*Game, error) {
	if len(images) < CardCount {
		return nil, ErrTooFewCards
	}
	start := Red
	if rnd.Intn(2) == 1 {
		start = Blue
	}

	teams := make([]Team, 0, CardCount)
	for i := 0; i < StartingAgents; i++ {
		teams = append(teams, start)
	}
	for i := 0; i < SecondAgents; i++ {
		teams = append(teams, start.Other())
	}
	for i := 0; i < BystanderCount; i++ {
		teams = append(teams, Neutral)
	}
	teams = append(teams, Assassin)
	rnd.Shuffle(len(teams), func(i, j int) { teams[i], teams[j] = teams[j], teams[i] })

	picks := rnd.Perm(len(images))[:CardCount]
	cards := make([]Card, CardCount)
	for i, p := range picks {
		cards[i] = Card{Image: images[p], Team: teams[i]}
	}

	return &Game{
		Cards:        cards,
		StartingTeam: start,
		Turn:         start,
		Phase:        PhaseClue,
		Log:          []LogEntry{},
	}, nil
}

// Remaining counts the unrevealed agents of a team.
func (g *Game) Remaining(t Team) int {
	n := 0
	for _, c := range g.Cards {
		if c.Team == t && !c.Revealed {
			n++
		}
	}
	return n
}

// GiveClue is played by the current team's spymaster.
func (g *Game) GiveClue(team Team, word string, number int) error {
	if g.Phase == PhaseOver {
		return ErrGameOver
	}
	if team != g.Turn {
		return ErrNotYourTurn
	}
	if g.Phase != PhaseClue {
		return ErrWrongPhase
	}
	word = strings.TrimSpace(word)
	if word == "" || strings.ContainsAny(word, " \t\n") || utf8.RuneCountInString(word) > maxClueWordSize {
		return ErrBadClue
	}
	if number != Unlimited && (number < 0 || number > 9) {
		return ErrBadNumber
	}

	g.Clue = &Clue{Team: team, Word: word, Number: number}
	g.Phase = PhaseGuess
	g.GuessesMade = 0
	if number == Unlimited || number == 0 {
		g.GuessesLeft = Unlimited
	} else {
		g.GuessesLeft = number + 1
	}
	g.Log = append(g.Log, LogEntry{Clue: *g.Clue, Guesses: []string{}})
	return nil
}

// Guess reveals a card on behalf of the current team.
func (g *Game) Guess(team Team, idx int) error {
	if g.Phase == PhaseOver {
		return ErrGameOver
	}
	if team != g.Turn {
		return ErrNotYourTurn
	}
	if g.Phase != PhaseGuess {
		return ErrWrongPhase
	}
	if idx < 0 || idx >= len(g.Cards) {
		return ErrBadCard
	}
	card := &g.Cards[idx]
	if card.Revealed {
		return ErrRevealed
	}

	card.Revealed = true
	card.RevealedBy = team
	g.GuessesMade++
	if n := len(g.Log); n > 0 {
		g.Log[n-1].Guesses = append(g.Log[n-1].Guesses, string(card.Team))
	}

	switch {
	case card.Team == Assassin:
		g.finish(team.Other(), "assassin")
	case g.Remaining(Red) == 0:
		g.finish(Red, "agents")
	case g.Remaining(Blue) == 0:
		g.finish(Blue, "agents")
	case card.Team != team:
		g.passTurn()
	default:
		if g.GuessesLeft != Unlimited {
			g.GuessesLeft--
			if g.GuessesLeft == 0 {
				g.passTurn()
			}
		}
	}
	return nil
}

// EndTurn lets the guessing team stop after at least one guess.
func (g *Game) EndTurn(team Team) error {
	if g.Phase == PhaseOver {
		return ErrGameOver
	}
	if team != g.Turn {
		return ErrNotYourTurn
	}
	if g.Phase != PhaseGuess {
		return ErrWrongPhase
	}
	if g.GuessesMade == 0 {
		return ErrMustGuess
	}
	g.passTurn()
	return nil
}

func (g *Game) passTurn() {
	g.Turn = g.Turn.Other()
	g.Phase = PhaseClue
	g.Clue = nil
	g.GuessesLeft = 0
	g.GuessesMade = 0
}

func (g *Game) finish(winner Team, reason string) {
	g.Winner = winner
	g.WinReason = reason
	g.Phase = PhaseOver
	g.Clue = nil
}
