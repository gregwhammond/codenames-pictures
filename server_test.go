package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

func testServer(t *testing.T) *httptest.Server {
	t.Helper()
	return testServerWithLarge(t, fstest.MapFS{"0.jpg": &fstest.MapFile{Data: []byte("big")}})
}

func testServerWithLarge(t *testing.T, large fs.FS) *httptest.Server {
	t.Helper()
	cards := fstest.MapFS{}
	for _, img := range testImages(25) {
		cards[strings.TrimPrefix(img, "/cards/")] = &fstest.MapFile{Data: []byte("x")}
	}
	web := fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("<html>app</html>")}}
	s, err := NewServer(web, cards, large)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s)
	t.Cleanup(ts.Close)
	return ts
}

func post(t *testing.T, url string, body any) (int, RoomView, string) {
	t.Helper()
	b, _ := json.Marshal(body)
	resp, err := http.Post(url, "application/json", bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var raw json.RawMessage
	_ = json.NewDecoder(resp.Body).Decode(&raw)
	var v RoomView
	_ = json.Unmarshal(raw, &v)
	return resp.StatusCode, v, string(raw)
}

func TestFullGameOverHTTP(t *testing.T) {
	ts := testServer(t)

	status, _, raw := post(t, ts.URL+"/api/rooms", map[string]string{})
	var created struct{ Code string }
	_ = json.Unmarshal([]byte(raw), &created)
	if status != http.StatusCreated || len(created.Code) != 4 {
		t.Fatalf("create: %d %s", status, raw)
	}
	base := ts.URL + "/api/rooms/" + created.Code + "/"

	seats := []struct {
		token string
		team  Team
		role  Role
	}{
		{"red-spymaster-token", Red, Spymaster},
		{"red-guesser-token-", Red, Guesser},
		{"blue-spymaster-token", Blue, Spymaster},
		{"blue-guesser-token", Blue, Guesser},
	}
	for i, s := range seats {
		if status, _, raw := post(t, base+"join", map[string]string{"token": s.token, "name": "P" + string(rune('1'+i))}); status != 200 {
			t.Fatalf("join: %s", raw)
		}
		if i == 0 {
			if status, _, _ := post(t, base+"start", map[string]string{"token": s.token}); status != http.StatusConflict {
				t.Fatal("start should need full seats")
			}
		}
		if status, _, raw := post(t, base+"sit", map[string]any{"token": s.token, "team": s.team, "role": s.role}); status != 200 {
			t.Fatalf("sit: %s", raw)
		}
		if status, _, raw := post(t, base+"screen", map[string]any{"token": s.token, "tall": true}); status != 200 {
			t.Fatalf("screen: %s", raw)
		}
	}
	if status, _, _ := post(t, base+"sit", map[string]any{"token": seats[1].token, "team": Red, "role": Spymaster}); status != http.StatusConflict {
		t.Fatal("second red spymaster should be refused")
	}

	// Watch the room as the blue guesser.
	resp, err := http.Get(base + "events?token=" + seats[3].token)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	events := make(chan RoomView, 32)
	go func() {
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(make([]byte, 1<<20), 1<<20)
		for sc.Scan() {
			if line, ok := strings.CutPrefix(sc.Text(), "data: "); ok {
				var v RoomView
				_ = json.Unmarshal([]byte(line), &v)
				events <- v
			}
		}
	}()
	waitFor := func(pred func(RoomView) bool) RoomView {
		t.Helper()
		timeout := time.After(2 * time.Second)
		for {
			select {
			case v := <-events:
				if pred(v) {
					return v
				}
			case <-timeout:
				t.Fatal("timed out waiting for event")
			}
		}
	}
	waitFor(func(v RoomView) bool { return v.Ready })

	_, view, raw := post(t, base+"start", map[string]string{"token": seats[0].token})
	if view.Game == nil {
		t.Fatalf("start: %s", raw)
	}
	g := waitFor(func(v RoomView) bool { return v.Game != nil }).Game
	if len(g.Cards) != TallBoard {
		t.Fatalf("four upright phones should get a 6x4 board, got %d cards", len(g.Cards))
	}
	for _, c := range g.Cards {
		if c.Team != "" {
			t.Fatal("guesser must not see the key")
		}
	}

	// Spymaster view has the key.
	_, spyView, _ := post(t, base+"join", map[string]string{"token": seats[0].token, "name": "P1"})
	for _, c := range spyView.Game.Cards {
		if c.Team == "" {
			t.Fatal("spymaster should see the key")
		}
	}

	turn := g.Turn
	spy, guesser := seats[0], seats[1]
	if turn == Blue {
		spy, guesser = seats[2], seats[3]
	}
	if status, _, _ := post(t, base+"guess", map[string]any{"token": guesser.token, "index": 0}); status != http.StatusConflict {
		t.Fatal("guess before clue should fail")
	}
	if status, _, _ := post(t, base+"clue", map[string]any{"token": guesser.token, "word": "x", "number": 1}); status != http.StatusConflict {
		t.Fatal("guesser can't give clues")
	}
	if status, _, raw := post(t, base+"clue", map[string]any{"token": spy.token, "word": "dragon", "number": 1}); status != 200 {
		t.Fatalf("clue: %s", raw)
	}
	waitFor(func(v RoomView) bool { return v.Game.Clue != nil && v.Game.Clue.Word == "dragon" })

	idx := -1
	for i, c := range spyView.Game.Cards {
		if c.Team == Assassin {
			idx = i
		}
	}
	if status, _, raw := post(t, base+"guess", map[string]any{"token": guesser.token, "index": idx}); status != 200 {
		t.Fatalf("guess: %s", raw)
	}
	over := waitFor(func(v RoomView) bool { return v.Game.Phase == PhaseOver })
	if over.Game.Winner != turn.Other() {
		t.Fatalf("winner %s", over.Game.Winner)
	}
	for _, c := range over.Game.Cards {
		if c.Team == "" {
			t.Fatal("key should be visible once the game is over")
		}
	}

	// One player turns their phone sideways: the rematch gets the 5x5 board.
	if status, _, raw := post(t, base+"screen", map[string]any{"token": seats[2].token, "tall": false}); status != 200 {
		t.Fatalf("screen: %s", raw)
	}
	status, view, raw = post(t, base+"start", map[string]string{"token": seats[2].token})
	if status != 200 || view.Game == nil || len(view.Game.Cards) != BigBoard {
		t.Fatalf("rematch: %d %s", status, raw)
	}
}

func TestUnknownPlayerAndRoom(t *testing.T) {
	ts := testServer(t)
	if status, _, _ := post(t, ts.URL+"/api/rooms/ZZZZ/join", map[string]string{"token": "abcdefghijklmnopq", "name": "x"}); status != 404 {
		t.Fatalf("missing room: %d", status)
	}
	_, _, raw := post(t, ts.URL+"/api/rooms", nil)
	var created struct{ Code string }
	_ = json.Unmarshal([]byte(raw), &created)
	if status, _, _ := post(t, ts.URL+"/api/rooms/"+created.Code+"/start", map[string]string{"token": "nobody-at-all-here"}); status != 403 {
		t.Fatalf("unknown player: %d", status)
	}
	resp, _ := http.Get(ts.URL + "/r/" + created.Code)
	if resp.StatusCode != 200 {
		t.Fatalf("room link: %d", resp.StatusCode)
	}
}

func TestDevHarness(t *testing.T) {
	cards := fstest.MapFS{}
	for _, img := range testImages(25) {
		cards[strings.TrimPrefix(img, "/cards/")] = &fstest.MapFile{Data: []byte("x")}
	}
	web := fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<html>app</html>")},
		"dev.html":   &fstest.MapFile{Data: []byte("<html>harness</html>")},
	}
	for _, enabled := range []bool{false, true} {
		s, err := NewServer(web, cards, nil)
		if err != nil {
			t.Fatal(err)
		}
		if enabled {
			s.EnableDev()
		}
		ts := httptest.NewServer(s)
		// The raw file is never served, with or without the harness enabled.
		raw, err := http.Get(ts.URL + "/dev.html")
		if err != nil {
			t.Fatal(err)
		}
		raw.Body.Close()
		if raw.StatusCode != 404 {
			t.Fatalf("dev=%v: /dev.html gave %d, want 404", enabled, raw.StatusCode)
		}
		resp, err := http.Get(ts.URL + "/dev")
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		ts.Close()
		served := resp.StatusCode == 200 && string(body) == "<html>harness</html>"
		if served != enabled {
			t.Fatalf("dev=%v: /dev gave %d %q", enabled, resp.StatusCode, body)
		}
		if enabled {
			if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
				t.Fatalf("content-type %q", ct)
			}
			if cc := resp.Header.Get("Cache-Control"); cc != "no-cache" {
				t.Fatalf("cache-control %q", cc)
			}
		}
	}
}

func TestLargeCards(t *testing.T) {
	ts := testServer(t)
	resp, err := http.Get(ts.URL + "/cards-large/0.jpg")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || string(body) != "big" {
		t.Fatalf("large card: %d %q", resp.StatusCode, body)
	}
	if cc := resp.Header.Get("Cache-Control"); cc != "public, max-age=2592000" {
		t.Fatalf("cache-control %q", cc)
	}
	resp, _ = http.Get(ts.URL + "/cards-large/1.jpg")
	resp.Body.Close()
	if resp.StatusCode != 404 {
		t.Fatalf("missing large card: %d", resp.StatusCode)
	}
	if cc := resp.Header.Get("Cache-Control"); strings.Contains(cc, "max-age") {
		t.Fatalf("404 should not be cached long: %q", cc)
	}
}

func TestLargeCardsFolderMissing(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "nope")
	for _, large := range []fs.FS{os.DirFS(missing), nil} {
		ts := testServerWithLarge(t, large)
		for _, p := range []string{"/cards-large/0.jpg", "/cards-large/"} {
			resp, err := http.Get(ts.URL + p)
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			if resp.StatusCode != 404 {
				t.Fatalf("%s with no large folder: %d", p, resp.StatusCode)
			}
		}
		// The rest of the server still works.
		resp, _ := http.Get(ts.URL + "/cards/0.jpg")
		resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Fatalf("card: %d", resp.StatusCode)
		}
	}
}
