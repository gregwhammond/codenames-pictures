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
	for _, img := range testImages(24) {
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
	}
	// The red spymaster is connected, so the seat can't be taken from them.
	spyEvents, err := http.Get(base + "events?token=" + seats[0].token)
	if err != nil {
		t.Fatal(err)
	}
	defer spyEvents.Body.Close()
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
	if len(g.Cards) != CardCount {
		t.Fatalf("got %d cards", len(g.Cards))
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
	// A clue with no number, or a guess with no card, is refused rather than read as 0.
	if status, _, _ := post(t, base+"clue", map[string]any{"token": spy.token, "word": "dragon", "number": nil}); status != http.StatusConflict {
		t.Fatalf("clue with no number: got %d", status)
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
	if status, _, _ := post(t, base+"guess", map[string]any{"token": guesser.token}); status != http.StatusConflict {
		t.Fatalf("guess with no card: got %d", status)
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

	if status, _, raw := post(t, base+"start", map[string]string{"token": seats[2].token}); status != 200 {
		t.Fatalf("rematch: %s", raw)
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
	for _, img := range testImages(24) {
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

func get(t *testing.T, url string) (*http.Response, string) {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	return resp, string(body)
}

func TestManifestContentType(t *testing.T) {
	cards := fstest.MapFS{}
	for _, img := range testImages(25) {
		cards[strings.TrimPrefix(img, "/cards/")] = &fstest.MapFile{Data: []byte("x")}
	}
	web := fstest.MapFS{
		"index.html":           &fstest.MapFile{Data: []byte("<html>app</html>")},
		"manifest.webmanifest": &fstest.MapFile{Data: []byte(`{"name":"x"}`)},
	}
	s, err := NewServer(web, cards, nil)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s)
	defer ts.Close()
	resp, body := get(t, ts.URL+"/manifest.webmanifest")
	if resp.StatusCode != 200 || body != `{"name":"x"}` {
		t.Fatalf("manifest: %d %q", resp.StatusCode, body)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "application/manifest+json" {
		t.Fatalf("content-type %q", ct)
	}
}

// A folder of pictures given with -cards: only the pictures that can be dealt
// are served, whatever their names, and nothing is listed.
func TestCardsFolder(t *testing.T) {
	pic := func(s string) *fstest.MapFile { return &fstest.MapFile{Data: []byte(s)} }
	cards := fstest.MapFS{
		"odd #1?.jpg":         pic("hash"),
		"100% sure.png":       pic("percent"),
		"sub/in a folder.jpg": pic("sub"),
		"notes.txt":           pic("private notes"),
		".hidden.jpg":         pic("hidden file"),
		".private/secret.jpg": pic("hidden folder"),
		".private/config":     pic("config"),
		"sub/.cache/old.jpg":  pic("nested hidden folder"),
	}
	for _, img := range testImages(25) {
		cards[strings.TrimPrefix(img, "/cards/")] = pic("x")
	}
	large := fstest.MapFS{"0.jpg": pic("big"), "sub/in a folder.jpg": pic("bigsub")}
	web := fstest.MapFS{
		"index.html":     pic("<html>app</html>"),
		"icons/icon.png": pic("icon"),
	}
	s, err := NewServer(web, cards, large)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s)
	defer ts.Close()

	if len(s.images) != 28 {
		t.Fatalf("dealing %d pictures, want 28: %v", len(s.images), s.images)
	}
	want := map[string]string{
		"/cards/odd%20%231%3F.jpg":       "hash",
		"/cards/100%25%20sure.png":       "percent",
		"/cards/sub/in%20a%20folder.jpg": "sub",
		"/cards/0.jpg":                   "x",
	}
	dealt := map[string]bool{}
	for _, img := range s.images {
		dealt[img] = true
		if strings.Contains(img, "/.") {
			t.Fatalf("hidden picture %s would be dealt", img)
		}
	}
	for u, content := range want {
		if !dealt[u] {
			t.Fatalf("%s is not in the dealt list %v", u, s.images)
		}
		resp, body := get(t, ts.URL+u)
		if resp.StatusCode != 200 || body != content {
			t.Fatalf("%s: %d %q", u, resp.StatusCode, body)
		}
		if cc := resp.Header.Get("Cache-Control"); cc != "public, max-age=2592000" {
			t.Fatalf("%s: cache-control %q", u, cc)
		}
	}
	// The app asks for the zoom picture under the same encoded name.
	if resp, body := get(t, ts.URL+"/cards-large/sub/in%20a%20folder.jpg"); resp.StatusCode != 200 || body != "bigsub" {
		t.Fatalf("large picture in a folder: %d %q", resp.StatusCode, body)
	}
	if g := imageGroup("/cards/odd%20%231%3F.jpg"); g != "odd #1?" {
		t.Fatalf("group %q", g)
	}

	for _, p := range []string{
		"/cards/", "/cards/sub/", "/cards/sub", "/cards/notes.txt", "/cards/.hidden.jpg",
		"/cards/.private/secret.jpg", "/cards/.private/config", "/cards/.private/", "/cards/sub/.cache/old.jpg",
		"/cards/nope.jpg", "/cards-large/", "/cards-large/sub/", "/cards-large/sub", "/icons/", "/icons",
	} {
		resp, body := get(t, ts.URL+p)
		if resp.StatusCode != 404 {
			t.Fatalf("%s: got %d %q, want 404", p, resp.StatusCode, body)
		}
		if strings.Contains(body, "<a href") || strings.Contains(body, "<pre>") {
			t.Fatalf("%s lists the folder: %q", p, body)
		}
		if cc := resp.Header.Get("Cache-Control"); strings.Contains(cc, "max-age") {
			t.Fatalf("%s: a 404 should not be cached long: %q", p, cc)
		}
	}
	for p, content := range map[string]string{"/": "<html>app</html>", "/icons/icon.png": "icon", "/r/ABCD": "<html>app</html>"} {
		if resp, body := get(t, ts.URL+p); resp.StatusCode != 200 || body != content {
			t.Fatalf("%s: %d %q", p, resp.StatusCode, body)
		}
	}
}

// In -cards mode the picture URLs carry a version, so a replaced file gets a
// new URL and phones (which cache pictures by URL) fetch it again.
func TestCardsFolderVersions(t *testing.T) {
	stamp := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	cards := fstest.MapFS{}
	for _, img := range testImages(25) {
		cards[strings.TrimPrefix(img, "/cards/")] = &fstest.MapFile{Data: []byte("x"), ModTime: stamp}
	}
	cards["S014-07-b #2.jpg"] = &fstest.MapFile{Data: []byte("x"), ModTime: stamp}
	web := fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("<html>app</html>")}}

	list := func(versioned bool) map[string]string {
		t.Helper()
		s, err := newServer(web, cards, nil, versioned)
		if err != nil {
			t.Fatal(err)
		}
		byName := map[string]string{}
		for _, img := range s.images {
			name, _, _ := strings.Cut(img, "?")
			byName[name] = img
		}
		return byName
	}

	if got := list(false)["/cards/0.jpg"]; got != "/cards/0.jpg" {
		t.Fatalf("built-in pictures should keep their plain names, got %s", got)
	}
	before := list(true)
	if !strings.HasPrefix(before["/cards/0.jpg"], "/cards/0.jpg?v=") {
		t.Fatalf("no version on %s", before["/cards/0.jpg"])
	}
	if again := list(true); again["/cards/0.jpg"] != before["/cards/0.jpg"] {
		t.Fatal("version changed although the file did not")
	}
	cards["0.jpg"] = &fstest.MapFile{Data: []byte("x"), ModTime: stamp.Add(time.Second)}
	cards["1.jpg"] = &fstest.MapFile{Data: []byte("xy"), ModTime: stamp}
	after := list(true)
	for _, name := range []string{"/cards/0.jpg", "/cards/1.jpg"} {
		if after[name] == before[name] {
			t.Fatalf("%s kept the version %s after the file changed", name, after[name])
		}
	}
	if after["/cards/2.jpg"] != before["/cards/2.jpg"] {
		t.Fatal("an untouched file changed version")
	}

	// A versioned URL still loads and still groups by source picture.
	s, err := newServer(web, cards, nil, true)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s)
	defer ts.Close()
	extra := after["/cards/S014-07-b%20%232.jpg"]
	if extra == "" {
		t.Fatalf("missing encoded name in %v", after)
	}
	if resp, body := get(t, ts.URL+extra); resp.StatusCode != 200 || body != "x" {
		t.Fatalf("%s: %d %q", extra, resp.StatusCode, body)
	}
	if g := imageGroup("/cards/S014-07-b.jpg?v=0123abcd"); g != "S014-07" {
		t.Fatalf("group %q", g)
	}
}

func TestRoomCapOverHTTP(t *testing.T) {
	cards := fstest.MapFS{}
	for _, img := range testImages(25) {
		cards[strings.TrimPrefix(img, "/cards/")] = &fstest.MapFile{Data: []byte("x")}
	}
	s, err := NewServer(fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("app")}}, cards, nil)
	if err != nil {
		t.Fatal(err)
	}
	s.rooms.max = 2
	ts := httptest.NewServer(s)
	defer ts.Close()
	for i := 0; i < 2; i++ {
		if status, _, raw := post(t, ts.URL+"/api/rooms", nil); status != http.StatusCreated {
			t.Fatalf("create %d: %d %s", i, status, raw)
		}
	}
	status, _, raw := post(t, ts.URL+"/api/rooms", nil)
	var body struct{ Error string }
	_ = json.Unmarshal([]byte(raw), &body)
	if status != http.StatusServiceUnavailable || body.Error != ErrTooManyRooms.Error() {
		t.Fatalf("over the cap: %d %s", status, raw)
	}
}

// A view sent over HTTP carries the room's revision.
func TestViewsCarryRev(t *testing.T) {
	ts := testServer(t)
	_, _, raw := post(t, ts.URL+"/api/rooms", nil)
	var created struct{ Code string }
	_ = json.Unmarshal([]byte(raw), &created)
	base := ts.URL + "/api/rooms/" + created.Code + "/"
	_, first, _ := post(t, base+"join", map[string]string{"token": "a-player-token-0001", "name": "A"})
	_, second, _ := post(t, base+"sit", map[string]any{"token": "a-player-token-0001", "team": Red, "role": Guesser})
	if first.Rev == 0 || second.Rev <= first.Rev {
		t.Fatalf("rev %d then %d", first.Rev, second.Rev)
	}
}
