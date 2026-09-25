package main

import (
	"fmt"
	"math/rand"
	"testing"
)

func testImages(n int) []string {
	images := make([]string, n)
	for i := range images {
		images[i] = fmt.Sprintf("/cards/%d.jpg", i)
	}
	return images
}

func newTestGame(t *testing.T, seed int64) *Game {
	t.Helper()
	g, err := NewGame(testImages(40), rand.New(rand.NewSource(seed)))
	if err != nil {
		t.Fatal(err)
	}
	return g
}

// find returns the index of an unrevealed card of the given team.
func find(g *Game, team Team) int {
	for i, c := range g.Cards {
		if c.Team == team && !c.Revealed {
			return i
		}
	}
	return -1
}

func TestDealComposition(t *testing.T) {
	for seed := int64(0); seed < 50; seed++ {
		g := newTestGame(t, seed)
		counts := map[Team]int{}
		seen := map[string]bool{}
		for _, c := range g.Cards {
			counts[c.Team]++
			if seen[c.Image] {
				t.Fatalf("duplicate image %s", c.Image)
			}
			seen[c.Image] = true
		}
		if len(g.Cards) != 20 || counts[g.StartingTeam] != 8 || counts[g.StartingTeam.Other()] != 7 ||
			counts[Neutral] != 4 || counts[Assassin] != 1 {
			t.Fatalf("bad deal: %v", counts)
		}
		if g.Turn != g.StartingTeam || g.Phase != PhaseClue {
			t.Fatalf("bad start state")
		}
	}
}

func TestTooFewImages(t *testing.T) {
	if _, err := NewGame(testImages(19), rand.New(rand.NewSource(1))); err != ErrTooFewCards {
		t.Fatalf("got %v", err)
	}
}

func TestClueValidation(t *testing.T) {
	g := newTestGame(t, 1)
	team := g.Turn
	if err := g.GiveClue(team.Other(), "fish", 1); err != ErrNotYourTurn {
		t.Fatalf("other team clue: %v", err)
	}
	if err := g.GiveClue(team, "two words", 1); err != ErrBadClue {
		t.Fatalf("two words: %v", err)
	}
	if err := g.GiveClue(team, "fish", 10); err != ErrBadNumber {
		t.Fatalf("number: %v", err)
	}
	if err := g.Guess(team, 0); err != ErrWrongPhase {
		t.Fatalf("guess before clue: %v", err)
	}
	if err := g.GiveClue(team, " fish ", 2); err != nil {
		t.Fatal(err)
	}
	if g.Clue.Word != "fish" || g.GuessesLeft != 3 || g.Phase != PhaseGuess {
		t.Fatalf("clue state: %+v left=%d", g.Clue, g.GuessesLeft)
	}
}

func TestGuessLimitAndEndTurn(t *testing.T) {
	g := newTestGame(t, 2)
	team := g.Turn
	_ = g.GiveClue(team, "fish", 1)
	if err := g.EndTurn(team); err != ErrMustGuess {
		t.Fatalf("end before guessing: %v", err)
	}
	if err := g.Guess(team, find(g, team)); err != nil {
		t.Fatal(err)
	}
	if g.Turn != team || g.GuessesLeft != 1 {
		t.Fatalf("should still be guessing, left=%d", g.GuessesLeft)
	}
	_ = g.Guess(team, find(g, team)) // the bonus guess
	if g.Turn != team.Other() || g.Phase != PhaseClue {
		t.Fatalf("turn should pass after number+1 guesses")
	}

	team = g.Turn
	_ = g.GiveClue(team, "bird", 3)
	_ = g.Guess(team, find(g, team))
	if err := g.EndTurn(team); err != nil {
		t.Fatal(err)
	}
	if g.Turn != team.Other() {
		t.Fatal("end turn should pass the turn")
	}
}

func TestWrongGuessesPassTurn(t *testing.T) {
	for _, wrong := range []Team{Neutral, "other"} {
		g := newTestGame(t, 3)
		team := g.Turn
		target := wrong
		if wrong == "other" {
			target = team.Other()
		}
		_ = g.GiveClue(team, "fish", 3)
		_ = g.Guess(team, find(g, target))
		if g.Turn != team.Other() || g.Phase != PhaseClue {
			t.Fatalf("%s guess should pass the turn", wrong)
		}
	}
}

func TestAssassinLoses(t *testing.T) {
	g := newTestGame(t, 4)
	team := g.Turn
	_ = g.GiveClue(team, "fish", 1)
	_ = g.Guess(team, find(g, Assassin))
	if g.Phase != PhaseOver || g.Winner != team.Other() || g.WinReason != "assassin" {
		t.Fatalf("assassin: %+v", g)
	}
	if err := g.GiveClue(g.Turn, "x", 1); err != ErrGameOver {
		t.Fatalf("after game over: %v", err)
	}
}

func TestFindingAllAgentsWins(t *testing.T) {
	g := newTestGame(t, 5)
	team := g.Turn
	_ = g.GiveClue(team, "all", Unlimited)
	for g.Phase != PhaseOver {
		if err := g.Guess(team, find(g, team)); err != nil {
			t.Fatal(err)
		}
	}
	if g.Winner != team || g.WinReason != "agents" {
		t.Fatalf("winner %s reason %s", g.Winner, g.WinReason)
	}
	if len(g.Log) != 1 || len(g.Log[0].Guesses) != 8 {
		t.Fatalf("log: %+v", g.Log)
	}
}

func TestRevealingOpponentsLastAgentGivesThemTheWin(t *testing.T) {
	g := newTestGame(t, 6)
	team := g.Turn
	other := team.Other()
	last := find(g, other)
	for i := range g.Cards {
		if g.Cards[i].Team == other && i != last {
			g.Cards[i].Revealed = true
		}
	}
	_ = g.GiveClue(team, "oops", 1)
	_ = g.Guess(team, find(g, other))
	if g.Winner != other {
		t.Fatalf("winner %s", g.Winner)
	}
}
