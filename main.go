// Command codenames-pictures serves a realtime Codenames Pictures game.
package main

import (
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path"
	"sort"
	"strings"
	"time"
)

//go:embed web
var embedded embed.FS

var imageExtensions = map[string]bool{".jpg": true, ".jpeg": true, ".png": true, ".webp": true, ".gif": true, ".svg": true}

func main() {
	addr := flag.String("addr", "", "listen address (default :$PORT or :8080)")
	cardsDir := flag.String("cards", "", "serve card pictures from this folder instead of the built-in set")
	flag.Parse()

	if *addr == "" {
		port := os.Getenv("PORT")
		if port == "" {
			port = "8080"
		}
		*addr = ":" + port
	}

	web, _ := fs.Sub(embedded, "web")
	var cards fs.FS
	if *cardsDir != "" {
		cards = os.DirFS(*cardsDir)
	} else {
		cards, _ = fs.Sub(web, "cards")
	}

	srv, err := NewServer(web, cards)
	if err != nil {
		log.Fatal(err)
	}
	go func() {
		for range time.Tick(10 * time.Minute) {
			srv.rooms.Sweep(6 * time.Hour)
		}
	}()

	log.Printf("Codenames Pictures listening on %s with %d pictures", *addr, len(srv.images))
	log.Fatal(http.ListenAndServe(*addr, srv))
}

type Server struct {
	mux    *http.ServeMux
	rooms  *Rooms
	images []string
}

func listImages(cards fs.FS) ([]string, error) {
	var images []string
	err := fs.WalkDir(cards, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() && imageExtensions[strings.ToLower(path.Ext(p))] && !strings.HasPrefix(d.Name(), ".") {
			images = append(images, "/cards/"+p)
		}
		return nil
	})
	sort.Strings(images)
	return images, err
}

func NewServer(web, cards fs.FS) (*Server, error) {
	images, err := listImages(cards)
	if err != nil {
		return nil, err
	}
	if len(images) < CardCount {
		return nil, fmt.Errorf("need at least %d pictures, found %d", CardCount, len(images))
	}
	s := &Server{mux: http.NewServeMux(), rooms: NewRooms(images), images: images}

	s.mux.HandleFunc("POST /api/rooms", s.handleCreate)
	s.mux.HandleFunc("POST /api/rooms/{code}/{action}", s.handleAction)
	s.mux.HandleFunc("GET /api/rooms/{code}/events", s.handleEvents)
	s.mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) { fmt.Fprintln(w, "ok") })

	static := http.FileServerFS(web)
	cardServer := http.StripPrefix("/cards/", http.FileServerFS(cards))
	s.mux.Handle("GET /cards/", cacheFor(30*24*time.Hour, cardServer))
	s.mux.Handle("GET /", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Room links like /r/ABCD load the app shell.
		if strings.HasPrefix(r.URL.Path, "/r/") {
			r2 := r.Clone(r.Context())
			r2.URL.Path = "/"
			r = r2
		}
		w.Header().Set("Cache-Control", "no-cache")
		static.ServeHTTP(w, r)
	}))
	return s, nil
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.mux.ServeHTTP(w, r) }

func cacheFor(d time.Duration, h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", fmt.Sprintf("public, max-age=%d", int(d.Seconds())))
		h.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

func (s *Server) handleCreate(w http.ResponseWriter, r *http.Request) {
	room := s.rooms.Create()
	writeJSON(w, http.StatusCreated, map[string]string{"code": room.Code})
}

type actionRequest struct {
	Token  string `json:"token"`
	Name   string `json:"name"`
	Team   Team   `json:"team"`
	Role   Role   `json:"role"`
	Word   string `json:"word"`
	Number int    `json:"number"`
	Index  int    `json:"index"`
}

func (s *Server) handleAction(w http.ResponseWriter, r *http.Request) {
	room, ok := s.rooms.Get(r.PathValue("code"))
	if !ok {
		writeError(w, http.StatusNotFound, errors.New("no room with that code"))
		return
	}
	var req actionRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, errors.New("bad request"))
		return
	}

	var err error
	switch r.PathValue("action") {
	case "join":
		_, err = room.Join(req.Token, req.Name)
	case "sit":
		err = room.Do(req.Token, func(p *Player) error { return room.Sit(p, req.Team, req.Role) })
	case "start":
		err = room.Do(req.Token, func(*Player) error { return room.Start() })
	case "lobby":
		err = room.Do(req.Token, func(*Player) error { room.BackToLobby(); return nil })
	case "clue":
		err = room.Do(req.Token, func(p *Player) error { return room.Clue(p, req.Word, req.Number) })
	case "guess":
		err = room.Do(req.Token, func(p *Player) error { return room.Guess(p, req.Index) })
	case "end-turn":
		err = room.Do(req.Token, func(p *Player) error { return room.EndTurn(p) })
	case "leave":
		err = room.Do(req.Token, func(p *Player) error { room.Leave(p); return nil })
	default:
		writeError(w, http.StatusNotFound, errors.New("unknown action"))
		return
	}
	if err != nil {
		status := http.StatusConflict
		if errors.Is(err, ErrUnknownPlayer) {
			status = http.StatusForbidden
		}
		writeError(w, status, err)
		return
	}
	if v, ok := room.View(req.Token); ok {
		writeJSON(w, http.StatusOK, v)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleEvents streams the room state to one player with Server-Sent Events.
func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	room, ok := s.rooms.Get(r.PathValue("code"))
	if !ok {
		writeError(w, http.StatusNotFound, errors.New("no room with that code"))
		return
	}
	token := r.URL.Query().Get("token")
	ch, err := room.Subscribe(token)
	if err != nil {
		writeError(w, http.StatusForbidden, err)
		return
	}
	defer room.Unsubscribe(token, ch)

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, errors.New("streaming unsupported"))
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")

	send := func() bool {
		v, ok := room.View(token)
		if !ok {
			fmt.Fprint(w, "event: gone\ndata: {}\n\n")
			flusher.Flush()
			return false
		}
		b, _ := json.Marshal(v)
		fmt.Fprintf(w, "data: %s\n\n", b)
		flusher.Flush()
		return true
	}
	if !send() {
		return
	}

	heartbeat := time.NewTicker(20 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ch:
			if !send() {
				return
			}
		case <-heartbeat.C:
			fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		}
	}
}
