package main

import (
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"
)

const (
	redSpyToken    = "red-spymaster-token"
	redGuessToken  = "red-guesser-token-"
	blueSpyToken   = "blue-spymaster-token"
	blueGuessToken = "blue-guesser-token"
)

// seatedRoom returns a room with both teams seated and everyone connected.
func seatedRoom(t *testing.T) *Room {
	t.Helper()
	r := newRoom("TEST", testImages(40), 1)
	seats := []struct {
		token string
		team  Team
		role  Role
	}{
		{redSpyToken, Red, Spymaster},
		{redGuessToken, Red, Guesser},
		{blueSpyToken, Blue, Spymaster},
		{blueGuessToken, Blue, Guesser},
	}
	for _, s := range seats {
		if _, err := r.Join(s.token, "P"); err != nil {
			t.Fatal(err)
		}
		if _, _, err := r.Subscribe(s.token); err != nil {
			t.Fatal(err)
		}
		sit(t, r, s.token, s.team, s.role, nil)
	}
	return r
}

func sit(t *testing.T, r *Room, token string, team Team, role Role, want error) {
	t.Helper()
	err := r.Do(token, func(p *Player) error { return r.Sit(p, team, role) })
	if !errors.Is(err, want) {
		t.Fatalf("sit %s as %q %q: got %v, want %v", token, team, role, err, want)
	}
}

func start(t *testing.T, r *Room) {
	t.Helper()
	if err := r.Do(redSpyToken, func(*Player) error { return r.Start() }); err != nil {
		t.Fatal(err)
	}
}

func seatOf(r *Room, token string) (Team, Role) {
	r.mu.Lock()
	defer r.mu.Unlock()
	p := r.byToken[token]
	return p.Team, p.Role
}

// The view is encoded after the room lock is released, so it must not share
// the clue log with the game. Run with -race.
func TestViewDoesNotShareTheLog(t *testing.T) {
	r := seatedRoom(t)
	start(t, r)

	stop := make(chan struct{})
	var wg sync.WaitGroup
	for _, token := range []string{redSpyToken, blueGuessToken} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				v, ok := r.View(token)
				if !ok {
					t.Error("no view")
					return
				}
				if _, err := json.Marshal(v); err != nil {
					t.Error(err)
					return
				}
			}
		}()
	}

	for i := 0; i < 300; i++ {
		err := r.Do(redSpyToken, func(*Player) error {
			g := r.game
			if g.Phase == PhaseOver {
				return r.Start()
			}
			if g.Phase == PhaseClue {
				return g.GiveClue(g.Turn, "word", 2)
			}
			return g.Guess(g.Turn, find(g, g.Turn))
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	close(stop)
	wg.Wait()

	// The copy is a real copy: changing a view leaves the game alone.
	_ = r.Do(redSpyToken, func(*Player) error {
		if r.game.Phase == PhaseOver {
			_ = r.Start()
		}
		if r.game.Phase == PhaseClue {
			return r.game.GiveClue(r.game.Turn, "word", 2)
		}
		return nil
	})
	v, _ := r.View(redSpyToken)
	v.Game.Clue.Word = "changed"
	v.Game.Log[0].Clue.Word = "changed"
	v.Game.Log[0].Guesses = append(v.Game.Log[0].Guesses, "x")
	again, _ := r.View(redSpyToken)
	if again.Game.Clue.Word != "word" || again.Game.Log[0].Clue.Word != "word" {
		t.Fatal("view shares the clue with the game")
	}
	if len(again.Game.Log[0].Guesses) != len(v.Game.Log[0].Guesses)-1 {
		t.Fatal("view shares the guesses with the game")
	}
}

func TestSpymasterCannotStandUpMidGame(t *testing.T) {
	r := seatedRoom(t)
	start(t, r)

	sit(t, r, redSpyToken, "", "", ErrGameRunning)
	sit(t, r, redSpyToken, Red, Guesser, ErrGameRunning)
	sit(t, r, redSpyToken, Blue, Guesser, ErrGameRunning)
	if team, role := seatOf(r, redSpyToken); team != Red || role != Spymaster {
		t.Fatalf("spymaster moved to %q %q", team, role)
	}
	// Staying put is fine, and guessers may still move.
	sit(t, r, redSpyToken, Red, Spymaster, nil)
	sit(t, r, redGuessToken, "", "", nil)
	sit(t, r, redGuessToken, Red, Guesser, nil)

	// Once the game is over, or back in the lobby, seats are free again.
	_ = r.Do(redSpyToken, func(*Player) error { r.game.finish(Red, "agents"); return nil })
	sit(t, r, redSpyToken, "", "", nil)
	sit(t, r, redSpyToken, Red, Spymaster, nil)
	start(t, r)
	sit(t, r, redSpyToken, "", "", ErrGameRunning)
	_ = r.Do(redSpyToken, func(*Player) error { r.BackToLobby(); return nil })
	sit(t, r, redSpyToken, "", "", nil)
}

func TestSpymasterCannotLeaveAndRejoinAsGuesser(t *testing.T) {
	r := seatedRoom(t)
	start(t, r)

	leave := func() {
		t.Helper()
		if err := r.Do(redSpyToken, func(p *Player) error { r.Leave(p); return nil }); err != nil {
			t.Fatal(err)
		}
		if _, err := r.Join(redSpyToken, "Back"); err != nil {
			t.Fatal(err)
		}
	}
	leave()
	sit(t, r, redSpyToken, Red, Guesser, ErrSawKey)
	sit(t, r, redSpyToken, Blue, Guesser, ErrSawKey)
	sit(t, r, redSpyToken, Blue, Spymaster, ErrSawKey)
	sit(t, r, redSpyToken, "", "", nil) // watching is allowed
	sit(t, r, redSpyToken, Red, Spymaster, nil)
	if team, role := seatOf(r, redSpyToken); team != Red || role != Spymaster {
		t.Fatalf("got seat %q %q", team, role)
	}

	// Leaving twice changes nothing.
	leave()
	leave()
	sit(t, r, redSpyToken, Blue, Guesser, ErrSawKey)

	// The lobby forgets who saw the key.
	_ = r.Do(redGuessToken, func(*Player) error { r.BackToLobby(); return nil })
	sit(t, r, redSpyToken, Blue, Guesser, nil)
	sit(t, r, redSpyToken, Red, Spymaster, nil)

	// So does a new deal: someone who left the last game may guess in the next.
	start(t, r)
	leave()
	_ = r.Do(redGuessToken, func(*Player) error { r.game.finish(Blue, "agents"); return nil })
	sit(t, r, blueGuessToken, Red, Spymaster, nil)
	sit(t, r, redSpyToken, Blue, Guesser, nil)
	if err := r.Do(redGuessToken, func(*Player) error { return r.Start() }); err != nil {
		t.Fatal(err)
	}
	sit(t, r, redSpyToken, Red, Guesser, nil)
}

func TestAwaySpymasterSeatCanBeTaken(t *testing.T) {
	r := seatedRoom(t)
	const newcomer = "newcomer-token-0001"
	if _, err := r.Join(newcomer, "New"); err != nil {
		t.Fatal(err)
	}

	// A connected spymaster keeps the seat.
	sit(t, r, newcomer, Red, Spymaster, ErrSeatTaken)

	// One whose phone has gone does not.
	r.mu.Lock()
	r.byToken[redSpyToken].conns = 0
	r.mu.Unlock()
	sit(t, r, newcomer, Red, Spymaster, nil)
	if team, role := seatOf(r, redSpyToken); team != "" || role != "" {
		t.Fatalf("old spymaster still seated as %q %q", team, role)
	}
	if team, role := seatOf(r, newcomer); team != Red || role != Spymaster {
		t.Fatalf("newcomer seated as %q %q", team, role)
	}
	v, _ := r.View(newcomer)
	if !v.Ready {
		t.Fatal("room should still be ready with the new spymaster")
	}
}

func TestAwaySpymasterSeatCanBeTakenMidGame(t *testing.T) {
	r := seatedRoom(t)
	start(t, r)
	const newcomer = "newcomer-token-0001"
	if _, err := r.Join(newcomer, "New"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := r.Subscribe(newcomer); err != nil {
		t.Fatal(err)
	}
	sit(t, r, newcomer, Red, Spymaster, ErrSeatTaken)

	r.mu.Lock()
	r.byToken[redSpyToken].conns = 0
	r.mu.Unlock()
	// The other team's spymaster has seen the key too and stays put.
	sit(t, r, blueSpyToken, Red, Spymaster, ErrGameRunning)
	sit(t, r, newcomer, Red, Spymaster, nil)
	v, _ := r.View(newcomer)
	for _, c := range v.Game.Cards {
		if c.Team == "" {
			t.Fatal("the new spymaster should see the key")
		}
	}

	// The spymaster who was replaced has seen the key: no guessing for them,
	// and their old seat is held by someone who is connected.
	sit(t, r, redSpyToken, Red, Guesser, ErrSawKey)
	sit(t, r, redSpyToken, Blue, Guesser, ErrSawKey)
	sit(t, r, redSpyToken, Red, Spymaster, ErrSeatTaken)
	old, _ := r.View(redSpyToken)
	for _, c := range old.Game.Cards {
		if c.Team != "" && !c.Revealed {
			t.Fatal("a watcher must not receive the key")
		}
	}
}

func TestViewRevGrows(t *testing.T) {
	r := seatedRoom(t)
	a, _ := r.View(redSpyToken)
	start(t, r)
	b, _ := r.View(redSpyToken)
	if b.Rev <= a.Rev {
		t.Fatalf("rev did not grow: %d then %d", a.Rev, b.Rev)
	}
	c, _ := r.View(blueGuessToken)
	if c.Rev != b.Rev {
		t.Fatalf("players see different revs for one state: %d and %d", b.Rev, c.Rev)
	}
	raw, _ := json.Marshal(c)
	var decoded struct {
		Rev *uint64 `json:"rev"`
	}
	if err := json.Unmarshal(raw, &decoded); err != nil || decoded.Rev == nil || *decoded.Rev != c.Rev {
		t.Fatalf("rev missing from JSON: %s", raw)
	}
}

func TestRoomCap(t *testing.T) {
	rs := NewRooms(testImages(25))
	rs.max = 3
	for i := 0; i < 3; i++ {
		if _, err := rs.Create(); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := rs.Create(); !errors.Is(err, ErrTooManyRooms) {
		t.Fatalf("over the cap: got %v", err)
	}
	// Sweeping idle rooms makes space again.
	for _, r := range rs.rooms {
		r.lastSeen = time.Now().Add(-time.Hour)
	}
	rs.Sweep(time.Minute)
	if _, err := rs.Create(); err != nil {
		t.Fatalf("after sweep: %v", err)
	}
}

// When no free code turns up, Create gives up instead of spinning with the
// registry locked.
func TestCreateGivesUpWhenCodesRunOut(t *testing.T) {
	rs := NewRooms(testImages(25))
	rs.newCode = func() string { return "AAAA" }
	if _, err := rs.Create(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := rs.Create()
		done <- err
	}()
	select {
	case err := <-done:
		if !errors.Is(err, ErrTooManyRooms) {
			t.Fatalf("got %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Create hung")
	}
	if _, ok := rs.Get("AAAA"); !ok {
		t.Fatal("registry stayed locked or lost the room")
	}
}

func TestRoomMakesItsRandomSourceOnFirstDeal(t *testing.T) {
	r := seatedRoom(t)
	if r.rnd != nil {
		t.Fatal("a new room should not hold a random source yet")
	}
	start(t, r)
	if r.rnd == nil {
		t.Fatal("no random source after dealing")
	}
}

// A stream opened before a leave belongs to the player who left: when it
// closes after the same token has joined again, the new player stays connected.
func TestStreamOutlivesLeaveAndRejoin(t *testing.T) {
	r := newRoom("TEST", testImages(40), 1)
	const tok = "same-token-for-both-joins"
	if _, err := r.Join(tok, "Ann"); err != nil {
		t.Fatal(err)
	}
	old, oldP, err := r.Subscribe(tok)
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Do(tok, func(p *Player) error { r.Leave(p); return nil }); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Join(tok, "Ann"); err != nil {
		t.Fatal(err)
	}
	if _, ok := r.ViewOf(tok, oldP); ok {
		t.Fatal("the old stream should be told it is gone, not see the new player")
	}
	_, newP, err := r.Subscribe(tok)
	if err != nil {
		t.Fatal(err)
	}
	r.Unsubscribe(oldP, old)
	if v, _ := r.View(tok); len(v.Players) != 1 || !v.Players[0].Connected {
		t.Fatalf("re-joined player shown as away: %+v", v.Players)
	}
	if newP.conns != 1 {
		t.Fatalf("conns = %d, want 1", newP.conns)
	}
}

func TestCleanName(t *testing.T) {
	for in, want := range map[string]string{
		"  Greg  ":      "Greg",
		"Ann\u200bie":   "Annie",
		"\u202eEvil":    "Evil",
		"a\u00adb":      "ab",
		"x\x01y":        "xy",
		"Mehr\u200cnaz": "Mehr\u200cnaz",
		"\U0001F3F4\U000E0067\U000E0062\U000E0073\U000E0063\U000E0074\U000E007F": "\U0001F3F4\U000E0067\U000E0062\U000E0073\U000E0063\U000E0074\U000E007F",
		"tab\tname":       "tab name",
		"👨\u200d👩\u200d👧": "👨\u200d👩\u200d👧",
	} {
		if got, err := cleanName(in); err != nil || got != want {
			t.Errorf("cleanName(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"", "   ", "\u200b", "\u2060\ufeff", "\x01\x02", "\u200d", "\u200c", "\u034f"} {
		if got, err := cleanName(in); !errors.Is(err, ErrBadName) {
			t.Errorf("cleanName(%q) = %q, %v; want ErrBadName", in, got, err)
		}
	}
}
