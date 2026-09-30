package main

import (
	"math/rand"
	"testing"
)

// seatedRoom seats two spymasters and two guessers.
func seatedRoom(t *testing.T) (*Room, []*Player) {
	t.Helper()
	r := &Room{Code: "TEST", byToken: map[string]*Player{}, images: testImages(40), rnd: rand.New(rand.NewSource(1))}
	seats := []struct {
		team Team
		role Role
	}{{Red, Spymaster}, {Red, Guesser}, {Blue, Spymaster}, {Blue, Guesser}}
	var players []*Player
	for i, s := range seats {
		p, err := r.Join("token-number-"+string(rune('1'+i))+"-abcdefgh", "P")
		if err != nil {
			t.Fatal(err)
		}
		if err := r.Sit(p, s.team, s.role); err != nil {
			t.Fatal(err)
		}
		players = append(players, p)
	}
	return r, players
}

func TestBoardSizeFollowsScreens(t *testing.T) {
	r, players := seatedRoom(t)
	deal := func() int {
		t.Helper()
		r.game = nil
		if err := r.Start(); err != nil {
			t.Fatal(err)
		}
		return len(r.game.Cards)
	}
	if n := deal(); n != BigBoard {
		t.Fatalf("nobody tall: %d cards", n)
	}
	for _, p := range players {
		r.SetScreen(p, true)
	}
	if n := deal(); n != TallBoard {
		t.Fatalf("all tall phones: %d cards", n)
	}
	r.SetScreen(players[2], false)
	if n := deal(); n != BigBoard {
		t.Fatalf("one wide screen: %d cards", n)
	}
	// A spectator's screen doesn't count: they never see the board up close.
	r.SetScreen(players[2], true)
	watcher, _ := r.Join("watcher-token-abcdefghij", "W")
	r.SetScreen(watcher, false)
	if n := deal(); n != TallBoard {
		t.Fatalf("spectator on a wide screen: %d cards", n)
	}
}
